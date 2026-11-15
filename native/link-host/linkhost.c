// souldew's link host: every console of a link session in ONE process – N linked Game Boy Advance, Game Boy / Game Boy
// Color (later DS) – stepped deterministically, the engine behind trades and battles between players
// (docs/MULTIPLAYER.md). Every peer runs ALL seats from the same ROMs (each partner's ROM rebuilt locally and checked by
// SHA-1 – no ROM ever crosses the network), the same battery saves and the same start time, and only the buttons
// travel. Same program + same inputs on the same frames = the same games everywhere. The system itself (and its link:
// serial cable, SIO, local wireless) is a backend (linkbackend.h); this file is the session around it.
//
//   linkhost --rom <seat0> [--rom <seat1> …] [--sram <file>|-]… [--state <file>|-]… [--local k] [--net --delay D]
//            [--rtc <unix ms>] [--ram ADDR:LEN]… [--record <file>] [--script <file>] [--bench FRAMES [--out dir]]
//
// Messages are { u32 type, u32 length, payload } (little-endian) both ways, as native/retro-host/retrohost.c.
//   host → souldew   2 VIDEO  u16 width, u16 height, u32 format (2 = RGB565), pixels – the viewed seat (VIEW)
//                    3 AUDIO  the local seat's sound of the frame: interleaved stereo s16 at the loaded event's sampleRate
//                    5 STATE  all seats: u32 n, n × { u32 len, state } (answer to SAVE)
//                    6 LOG    text
//                    7 EVENT  json: loaded | stats | stepped | hash {frame, hash} | wait {seats, frame, ms} | saved |
//                             stateLoaded | error | ended
//                    8 RAM    the local seat's --ram regions that changed (retrohost's format: live tracking works)
//                    9 SRAM   the local seat's battery save once the game saved (retrohost's format)
//                   11 MEM    u32 seat, u32 addr, bytes (answer to READ)
//                   12 LINPUT u32 seat, u32 first frame, u32 inputs[] (linkbackend.h link_input) – the local seat's
//                             buttons, for the peers
//                   14 SEATSRAM u32 seat, bytes (every seat's battery save, on FLUSH)
//   souldew → host   1 INPUT  u32 joypad bits (RETRO_DEVICE_ID_JOYPAD_*), s16 lx, ly, rx, ry, s16 px, py, u8 pressed (the
//                             fast player's 17 bytes: the pointer over the whole picture is the DS touch screen) – the
//                             local seat; exactly 8 bytes { bits, seat } in local mode: that seat (tests)
//                    2 SPEED  f32   3 SAVE   4 LOAD (STATE's format)   6 QUIT   10 FLUSH   12 RESYNC
//                   13 STEP   u32 n (local mode: as fast as possible; net mode: at the pace set)
//                   20 VIEW   u32 seat (which console's picture comes out; sends it right away)
//                   21 RINPUT u32 seat, u32 first frame, u32 inputs[] – a peer's buttons (net mode); repeats and
//                             frames that come early (an unordered channel) are fine
//                   22 READ   u32 seat, u32 addr, u32 len      23 POKE u32 seat, u32 addr, bytes (tests)
//                   24 UNTIL  u32 frame: run until the session reaches this frame, then pause (every peer the same)
//                   25 NEED   u32 seat, u32 from: send that seat's buttons from frame `from` on as LINPUT (a peer missed
//                             some; any peer may answer for any seat – every host keeps every seat's buttons)
// --load <file>: start from a whole-session state (STATE's format, see save_all) – rejoining a running session.
//
// Local mode (no --net): every seat's buttons come from INPUT. Net mode: the local seat's buttons for frame f are taken
// at frame f − D and sent as LINPUT; frame f runs only when every seat's buttons for it are known (input-delay
// lockstep, no rollback). A hash of every console goes out every 120 frames: souldew compares the peers' hashes and
// stops a session that fell out of step.
#include "linkbackend.h"

#include <errno.h>
#include <math.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#ifdef _WIN32 // (MinGW-w64 with POSIX threads: pthread, clock_gettime and nanosleep come from winpthreads)
#include <fcntl.h>
#include <io.h>
#endif

#define RING 4096 // frames of buttons kept per seat
#define HASH_EVERY 120

// in order of preference: the first whose probe takes every seat's game runs the session (--backend NAME: that one)
static const struct link_backend *backends[] = {&link_backend_sameboy, &link_backend_mgba, &link_backend_melonds};
static const struct link_backend *B;

// ---- output --------------------------------------------------------------------------------------------------------
static pthread_mutex_t out_lock = PTHREAD_MUTEX_INITIALIZER;
static int protocol = 1;

static void write_all(const void *p, size_t n) {
  const uint8_t *b = p;
  while (n) {
    ssize_t w = write(1, b, n);
    if (w < 0) {
      if (errno == EINTR) continue;
      _exit(0); // souldew went away
    }
    b += w;
    n -= (size_t)w;
  }
}
static void send_msg2(uint32_t type, const void *a, uint32_t na, const void *b, uint32_t nb) {
  if (!protocol) return;
  uint32_t h[2] = {type, na + nb};
  pthread_mutex_lock(&out_lock);
  write_all(h, 8);
  if (na) write_all(a, na);
  if (nb) write_all(b, nb);
  pthread_mutex_unlock(&out_lock);
}
static void send_msg(uint32_t type, const void *p, uint32_t n) { send_msg2(type, p, n, NULL, 0); }
static void send_event(const char *fmt, ...) {
  char buf[1024];
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  if (n > 0) send_msg(7, buf, (uint32_t)(n < (int)sizeof buf ? n : (int)sizeof buf - 1));
}
void link_log(const char *fmt, ...) {
  char buf[1024];
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  if (n <= 0) return;
  if (n >= (int)sizeof buf) n = sizeof buf - 1;
  fprintf(stderr, "linkhost: %s\n", buf);
  send_msg(6, buf, (uint32_t)n);
}
static void die(const char *fmt, ...) {
  char buf[512];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  fprintf(stderr, "linkhost: %s\n", buf);
  for (char *c = buf; *c; c++) if (*c == '"' || *c == '\\' || (unsigned char)*c < 0x20) *c = ' ';
  send_event("{\"event\":\"error\",\"message\":\"%s\"}", buf);
  _exit(1);
}
static double now_s(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (double)t.tv_sec + t.tv_nsec / 1e9;
}
static void sleep_s(double s) {
  if (s <= 0) return;
  struct timespec t = {(time_t)s, (long)((s - (double)(time_t)s) * 1e9)};
  nanosleep(&t, NULL);
}
void *link_read_file(const char *path, size_t *n) {
  FILE *f = fopen(path, "rb");
  if (!f) return NULL;
  fseek(f, 0, SEEK_END);
  long len = ftell(f);
  fseek(f, 0, SEEK_SET);
  void *b = len > 0 ? malloc((size_t)len) : NULL;
  if (b && fread(b, 1, (size_t)len, f) != (size_t)len) { free(b); b = NULL; }
  fclose(f);
  *n = b ? (size_t)len : 0;
  return b;
}
uint64_t link_fnv(uint64_t h, const void *p, size_t n) {
  const uint8_t *b = p;
  for (size_t i = 0; i < n; i++) h = (h ^ b[i]) * 1099511628211ull;
  return h;
}
#define FNV0 1469598103934665603ull

// ---- the session ---------------------------------------------------------------------------------------------------
static int nseats, local_seat, net_mode, delay_frames = 4;
static struct seat {
  link_input in[RING]; // buttons per frame
  uint8_t early[RING]; // a peer's buttons that came ahead of a gap: kept until the gap fills
  uint32_t have;       // buttons known for frames < have
  link_input held;     // local mode / the local seat: the buttons held now (touch included)
  link_input touch_last; // where the last touch was (with LINK_TOUCH)
  int touch_latch;     // a quick tap still counts as held for this many frames
  uint64_t sram_sent, sram_seen;
} seats[LINK_MAX_SEATS];
static uint32_t frame; // the session's frame: every console started this many frames
// tests: --record writes every frame's buttons (u32 frame, u32 inputs[seats]); --script plays such a file back (net
// mode: the local seat's buttons, local mode: every seat's)
static FILE *record_f;
static link_input *script;
static uint32_t script_frames;
static link_input script_input(uint32_t f, int seat) { return f < script_frames ? script[(size_t)f * nseats + seat] : 0; }

/** RETRO_DEVICE_ID_JOYPAD_* bits → link_input. */
static link_input retro_to_input(uint32_t r) {
  static const link_input map[12] = {LINK_KEY_B, LINK_KEY_Y, LINK_KEY_SELECT, LINK_KEY_START, LINK_KEY_UP, LINK_KEY_DOWN, LINK_KEY_LEFT, LINK_KEY_RIGHT,
                                     LINK_KEY_A, LINK_KEY_X, LINK_KEY_L, LINK_KEY_R};
  link_input k = 0;
  for (int i = 0; i < 12; i++) if (r >> i & 1) k |= map[i];
  return k;
}

/**
 * The touch bits (link_input: bit 12, x in 16–23, y in 24–31) from the fast player's pointer (INPUT bytes 12–16: s16 px,
 * py over the whole picture, −0x7fff…0x7fff, u8 pressed). The DS picture is the top screen above the touch screen
 * (256 × 384): only the lower half touches. Returns 0 when the pointer isn't on the touch screen.
 */
static int screen_h = 384; // the picture the pointer is relative to (from the backend once it runs)
static link_input touch_from_pointer(const uint8_t *p) {
  int16_t px, py;
  memcpy(&px, p + 12, 2), memcpy(&py, p + 14, 2);
  if (!p[16] || screen_h < 384) return 0;
  const int x = (int)((px + 0x7fff) * (int64_t)256 / 0xffff), y = (int)((py + 0x7fff) * (int64_t)screen_h / 0xffff) - (screen_h - 192);
  if (y < 0) return 0; // the top screen
  return LINK_TOUCH | (link_input)(x < 0 ? 0 : x > 255 ? 255 : x) << 16 | (link_input)(y > 191 ? 191 : y) << 24;
}
/**
 * A seat's buttons for the next frame (cmd_lock held). A tap shorter than TOUCH_MIN_FRAMES still lasts that long – the
 * games poll the touch screen slowly (as retrohost does it). Called once per frame of that seat.
 */
#define TOUCH_MIN_FRAMES 4
static link_input sample_input(struct seat *st) {
  link_input k = st->held;
  if (!(k & LINK_TOUCH) && st->touch_latch > 0) k |= st->touch_last;
  if (st->touch_latch > 0) st->touch_latch--;
  return k;
}

// ---- sound: the local seat's, as retrohost's AUDIO (interleaved stereo s16 at the loaded event's sampleRate) --------
static int16_t audio_buf[4096 * 2];
/** After a frame: the local seat's sound out (`play`: at normal speed – fast-forward and tests drop it); the other seats'
 *  is drained so nothing piles up. */
static void pump_audio(int play) {
  if (!B->audio) return;
  for (int s = 0; s < nseats; s++) {
    size_t n;
    while ((n = B->audio(s, audio_buf, 4096)) > 0) {
      if (play && s == local_seat && protocol) send_msg(3, audio_buf, (uint32_t)(n * 4));
      if (n < 4096) break;
    }
  }
}

static void run_frame(void) {
  for (int s = 0; s < nseats; s++) B->set_input(s, seats[s].in[frame % RING]);
  if (record_f) {
    fwrite(&frame, 4, 1, record_f);
    for (int s = 0; s < nseats; s++) fwrite(&seats[s].in[frame % RING], 4, 1, record_f);
    fflush(record_f);
  }
  B->run_frame();
  frame++;
}

// ---- commands ------------------------------------------------------------------------------------------------------
static int ram_full = 1;
static pthread_mutex_t cmd_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t cmd_cond = PTHREAD_COND_INITIALIZER;
static float speed = 1.0f;
static uint32_t step_left, until_frame; // STEP: frames still to run; UNTIL: pause at this session frame
static int view_seat, want_quit, want_save, want_flush, want_view;
static uint8_t *load_data;
static size_t load_len;
#define MAX_PENDING 1024
static struct pending { uint32_t type, len; uint8_t *p; } pending[MAX_PENDING]; // RINPUT / READ / POKE, in order
static int pending_n;

static int read_full(void *p, size_t n) {
  uint8_t *b = p;
  while (n) {
    ssize_t r = read(0, b, n);
    if (r == 0) return 0;
    if (r < 0) {
      if (errno == EINTR) continue;
      return 0;
    }
    b += r;
    n -= (size_t)r;
  }
  return 1;
}

static void *reader(void *arg) {
  (void)arg;
  for (;;) {
    uint32_t h[2];
    if (!read_full(h, 8) || h[1] > 64u * 1024 * 1024) break;
    uint8_t *p = h[1] ? malloc(h[1]) : NULL;
    if (h[1] && (!p || !read_full(p, h[1]))) { free(p); break; }
    pthread_mutex_lock(&cmd_lock);
    switch (h[0]) {
    case 1:
      if (h[1] >= 4) {
        uint32_t bits, seat = (uint32_t)local_seat;
        memcpy(&bits, p, 4);
        if (h[1] == 8 && !net_mode) memcpy(&seat, p + 4, 4);
        if (seat < (uint32_t)nseats) {
          struct seat *st = &seats[seat];
          const link_input t = h[1] >= 17 ? touch_from_pointer(p) : 0; // (the fast player's pointer: the DS touch screen)
          if (t && !(st->held & LINK_TOUCH)) st->touch_latch = TOUCH_MIN_FRAMES;
          if (t) st->touch_last = t;
          st->held = retro_to_input(bits) | t | (h[1] == 8 ? bits & 0xFFFF1000u : 0); // (tests: link_input touch bits as they are)
        }
      }
      break;
    case 2:
      if (h[1] >= 4) {
        float v;
        memcpy(&v, p, 4);
        speed = isfinite(v) ? (v <= 0 ? 0 : v > 1000 ? 1000 : v) : 1000;
      }
      break;
    case 3: want_save = 1; break;
    case 4: free(load_data); load_data = p; load_len = h[1]; p = NULL; break;
    case 6: want_quit = 1; break;
    case 10: want_flush = 1; break;
    case 12: ram_full = 1; break;
    case 13:
      if (h[1] >= 4) {
        uint32_t n;
        memcpy(&n, p, 4);
        step_left = n > 1000000 ? 1000000 : n;
        speed = step_left ? (net_mode && speed > 0 ? speed : 1000.0f) : 0.0f; // (net: at the pace set)
      }
      break;
    case 20:
      if (h[1] >= 4) { uint32_t v; memcpy(&v, p, 4); view_seat = v < (uint32_t)nseats ? (int)v : view_seat; want_view = 1; }
      break;
    case 24:
      if (h[1] >= 4) { memcpy(&until_frame, p, 4); if (speed <= 0) speed = 1000.0f; }
      break;
    case 21: case 22: case 23: case 25:
      if (pending_n < MAX_PENDING) pending[pending_n++] = (struct pending){h[0], h[1], p}, p = NULL;
      break;
    }
    pthread_cond_signal(&cmd_cond);
    pthread_mutex_unlock(&cmd_lock);
    free(p);
  }
  pthread_mutex_lock(&cmd_lock);
  want_quit = 1;
  pthread_cond_signal(&cmd_cond);
  pthread_mutex_unlock(&cmd_lock);
  return NULL;
}

/** A peer's buttons (RINPUT): frames known already are skipped, frames ahead of a gap wait for it. */
static void take_remote(const uint8_t *p, uint32_t len) {
  if (len < 8) return;
  uint32_t seat, first;
  memcpy(&seat, p, 4);
  memcpy(&first, p + 4, 4);
  if (seat >= (uint32_t)nseats || (int)seat == local_seat) return;
  struct seat *st = &seats[seat];
  const uint32_t n = (len - 8) / 4;
  for (uint32_t i = 0; i < n; i++) {
    const uint32_t f = first + i;
    if (f < st->have) continue;       // known already (a resend)
    if (f >= frame + RING - 1) break; // too far ahead
    memcpy(&st->in[f % RING], p + 8 + i * 4, 4);
    st->early[f % RING] = 1;
  }
  while (st->early[st->have % RING]) st->early[st->have % RING] = 0, st->have++;
}

static void do_read(const uint8_t *p, uint32_t len) {
  if (len < 12) return;
  uint32_t seat, addr, n;
  memcpy(&seat, p, 4), memcpy(&addr, p + 4, 4), memcpy(&n, p + 8, 4);
  if (seat >= (uint32_t)nseats || n > 1 << 20) return;
  uint8_t *out = malloc(8 + n);
  if (!out) return;
  memcpy(out, &seat, 4), memcpy(out + 4, &addr, 4);
  for (uint32_t i = 0; i < n; i++) out[8 + i] = B->read8((int)seat, addr + i);
  send_msg(11, out, 8 + n);
  free(out);
}
static void do_poke(const uint8_t *p, uint32_t len) {
  if (len < 9) return;
  uint32_t seat, addr;
  memcpy(&seat, p, 4), memcpy(&addr, p + 4, 4);
  if (seat >= (uint32_t)nseats) return;
  for (uint32_t i = 0; i < len - 8; i++) B->write8((int)seat, addr + i, p[8 + i]);
}

// ---- picture / RAM / saves out ------------------------------------------------------------------------------------
static uint8_t *frame_msg;
static size_t frame_cap;
/** The seat's picture as RGB565 (format 2, as retrohost sends mGBA's): half the bytes of 32-bit pixels on the stream. */
static void send_frame(int seat) {
  const uint32_t *px;
  unsigned w, h, stride;
  B->video(seat, &px, &w, &h, &stride);
  const size_t need = 8 + (size_t)w * h * 2;
  if (need > frame_cap) {
    uint8_t *b = realloc(frame_msg, need);
    if (!b) return;
    frame_msg = b, frame_cap = need;
  }
  uint16_t ww = (uint16_t)w, hh = (uint16_t)h;
  uint32_t f = 2;
  memcpy(frame_msg, &ww, 2), memcpy(frame_msg + 2, &hh, 2), memcpy(frame_msg + 4, &f, 4);
  uint16_t *o = (uint16_t *)(frame_msg + 8);
  for (unsigned y = 0; y < h; y++)
    for (unsigned x = 0; x < w; x++) { // 0x00BBGGRR → RRRRRGGGGGGBBBBB
      const uint32_t c = px[(size_t)y * stride + x];
      *o++ = (uint16_t)(((c & 0xf8) << 8) | ((c >> 5) & 0x7e0) | ((c >> 19) & 0x1f));
    }
  send_msg(2, frame_msg, (uint32_t)need);
}

#define MAX_RAM 4
#define BLOCK 1024
static struct { uint32_t addr, len; uint8_t *shadow; } ram[MAX_RAM];
static int ram_n;
static uint8_t *ram_msg;
/** What changed in the local seat's --ram regions since the last time (all of it after RESYNC), as retrohost does. */
static void send_ram(void) {
  size_t cap = 4;
  for (int i = 0; i < ram_n; i++) cap += ram[i].len + 8 * (ram[i].len / BLOCK + 1);
  uint8_t *m = realloc(ram_msg, cap);
  if (!m) return;
  ram_msg = m;
  uint8_t *p = m + 4;
  uint32_t count = 0;
  for (int i = 0; i < ram_n; i++) {
    uint8_t *src = B->mem(local_seat, ram[i].addr, ram[i].len);
    if (!src) continue;
    if (!ram[i].shadow) ram[i].shadow = calloc(1, ram[i].len);
    uint32_t at = 0;
    while (at < ram[i].len) {
      uint32_t n = ram[i].len - at < BLOCK ? ram[i].len - at : BLOCK;
      if (!ram_full && !memcmp(src + at, ram[i].shadow + at, n)) { at += n; continue; }
      const uint32_t start = at;
      while (at < ram[i].len) {
        n = ram[i].len - at < BLOCK ? ram[i].len - at : BLOCK;
        if (!ram_full && !memcmp(src + at, ram[i].shadow + at, n)) break;
        memcpy(ram[i].shadow + at, src + at, n);
        at += n;
      }
      const uint32_t addr = ram[i].addr + start, len = at - start;
      memcpy(p, &addr, 4), memcpy(p + 4, &len, 4), memcpy(p + 8, ram[i].shadow + start, len);
      p += 8 + len;
      count++;
    }
  }
  ram_full = 0;
  if (!count) return;
  memcpy(m, &count, 4);
  send_msg(8, m, (uint32_t)(p - m));
}

/** The local seat's battery save once it changed and settled (the game writes it in steps), as retrohost does. */
static void check_sram(int force) {
  struct seat *st = &seats[local_seat];
  void *p = NULL;
  size_t n = B->sram(local_seat, &p);
  if (!p || !n) { free(p); return; }
  const uint64_t h = link_fnv(FNV0, p, n);
  const int settled = h == st->sram_seen;
  st->sram_seen = h;
  if (h != st->sram_sent && (force || settled)) {
    st->sram_sent = h;
    void *full = NULL;
    const size_t fn = B->battery ? B->battery(local_seat, &full) : 0;
    if (full && fn) send_msg(9, full, (uint32_t)fn);
    else send_msg(9, p, (uint32_t)n);
    free(full);
    send_event("{\"event\":\"saved\",\"seat\":%d,\"size\":%zu}", local_seat, n);
  }
  free(p);
}
static void send_all_sram(void) {
  for (int s = 0; s < nseats; s++) {
    void *p = NULL;
    size_t n = B->battery ? B->battery(s, &p) : 0;
    if (!p || !n) free(p), p = NULL, n = B->sram(s, &p);
    const uint32_t seat = (uint32_t)s;
    send_msg2(14, &seat, 4, p, (uint32_t)n);
    free(p);
  }
}

// A whole-session state (STATE / LOAD, --load): u32 n, n × { u32 len, state }, then u32 'LSES', u32 frame – every
// console and the session frame it was taken at (rejoin: the peers that stayed send it to the one coming back). An empty
// STATE means "not now" (the DS backend can't write a console down while it waits mid-frame for a wireless packet).
#define SESSION_MAGIC 0x5345534cu
static void save_all(void) {
  size_t total = 4 + 8, sizes[LINK_MAX_SEATS];
  for (int s = 0; s < nseats; s++) {
    sizes[s] = B->state_size(s);
    if (!sizes[s]) { send_msg(5, NULL, 0); return; }
    total += 4 + sizes[s];
  }
  uint8_t *b = malloc(total), *p = b + 4;
  if (!b) { send_msg(5, NULL, 0); return; }
  const uint32_t n = (uint32_t)nseats;
  memcpy(b, &n, 4);
  for (int s = 0; s < nseats; s++) {
    const uint32_t len = (uint32_t)sizes[s];
    memcpy(p, &len, 4);
    if (B->state_size(s) != sizes[s] || !B->save_state(s, p + 4)) { free(b); send_msg(5, NULL, 0); return; }
    p += 4 + len;
  }
  const uint32_t tail[2] = {SESSION_MAGIC, frame};
  memcpy(p, tail, 8);
  send_msg(5, b, (uint32_t)total);
  free(b);
}
/** Loads a whole-session state; returns 0 (nothing loaded) when it doesn't fit these seats. Sets the session frame. */
static int load_all(const uint8_t *b, size_t len) {
  uint32_t n;
  if (len < 4) return 0;
  memcpy(&n, b, 4);
  if (n != (uint32_t)nseats) return 0;
  size_t at = 4;
  for (int s = 0; s < nseats; s++) { // (all sizes checked before anything is loaded)
    uint32_t l;
    if (at + 4 > len) return 0;
    memcpy(&l, b + at, 4);
    if (!l || at + 4 + l > len) return 0;
    at += 4 + l;
  }
  uint32_t tail[2] = {0, 0};
  if (at + 8 <= len) memcpy(tail, b + at, 8);
  at = 4;
  for (int s = 0; s < nseats; s++) {
    uint32_t l;
    memcpy(&l, b + at, 4);
    if (!B->load_state(s, b + at + 4, l)) return 0;
    at += 4 + l;
  }
  if (tail[0] == SESSION_MAGIC) { // the session goes on from that frame: nobody's buttons are known past it yet
    frame = tail[1];
    for (int s = 0; s < nseats; s++) {
      seats[s].have = frame;
      memset(seats[s].early, 0, sizeof seats[s].early);
    }
  }
  return 1;
}

/** A peer asks for a seat's buttons from frame `from` on (it missed some – NEED): what this host knows, as LINPUT. */
static void do_need(const uint8_t *p, uint32_t len) {
  if (len < 8) return;
  uint32_t seat, from;
  memcpy(&seat, p, 4), memcpy(&from, p + 4, 4);
  if (seat >= (uint32_t)nseats) return;
  struct seat *st = &seats[seat];
  const uint32_t lo = st->have > RING - 2 ? st->have - (RING - 2) : 0;
  if (from < lo) from = lo; // (older than the ring: gone)
  if (from >= st->have) return;
  uint32_t n = st->have - from;
  if (n > 1024) n = 1024;
  uint32_t *m = malloc(8 + 4 * (size_t)n);
  if (!m) return;
  m[0] = seat, m[1] = from;
  for (uint32_t i = 0; i < n; i++) m[2 + i] = st->in[(from + i) % RING];
  send_msg(12, m, 8 + 4 * n);
  free(m);
}

// ---- main ----------------------------------------------------------------------------------------------------------
int main(int argc, char **argv) {
#ifdef _WIN32
  _setmode(_fileno(stdin), _O_BINARY); // the protocol is binary
  _setmode(_fileno(stdout), _O_BINARY);
#endif
  const char *roms[LINK_MAX_SEATS] = {0}, *srams[LINK_MAX_SEATS] = {0}, *states[LINK_MAX_SEATS] = {0};
  const char *script_path = NULL, *out_dir = NULL, *backend_name = NULL, *load_path = NULL;
  int nr = 0, ns = 0, nst = 0, bench = 0;
  double bench_speed = 0;
  int64_t rtc_ms = 0;
  for (int i = 1; i < argc; i++) {
    const char *k = argv[i], *v = i + 1 < argc ? argv[i + 1] : NULL;
    if (!strcmp(k, "--net")) { net_mode = 1; continue; }
    if (!v) break;
    i++;
    if (!strcmp(k, "--rom") && nr < LINK_MAX_SEATS) roms[nr++] = v;
    else if (!strcmp(k, "--sram") && ns < LINK_MAX_SEATS) srams[ns++] = v;
    else if (!strcmp(k, "--state") && nst < LINK_MAX_SEATS) states[nst++] = v;
    else if (!strcmp(k, "--local")) local_seat = atoi(v);
    else if (!strcmp(k, "--delay")) delay_frames = atoi(v);
    else if (!strcmp(k, "--rtc")) rtc_ms = strtoll(v, NULL, 10);
    else if (!strcmp(k, "--bench")) bench = atoi(v);
    else if (!strcmp(k, "--speed")) bench_speed = atof(v);
    else if (!strcmp(k, "--record")) record_f = fopen(v, "wb");
    else if (!strcmp(k, "--script")) script_path = v;
    else if (!strcmp(k, "--out")) out_dir = v;
    else if (!strcmp(k, "--backend")) backend_name = v;
    else if (!strcmp(k, "--load")) load_path = v;
    else if (!strcmp(k, "--ram") && ram_n < MAX_RAM) {
      char *end = NULL;
      const unsigned long a = strtoul(v, &end, 0), n = end && *end == ':' ? strtoul(end + 1, NULL, 0) : 0;
      if (n > 0 && n <= 16u * 1024 * 1024) ram[ram_n].addr = (uint32_t)a, ram[ram_n].len = (uint32_t)n, ram_n++;
    }
  }
  nseats = nr;
  if (nseats < 1 || local_seat < 0 || local_seat >= nseats || delay_frames < 1 || delay_frames > 120) {
    fprintf(stderr, "usage: linkhost --rom <seat0> [--rom <seat1>…] [--sram f|-]… [--state f|-]… [--local k] [--net --delay D] [--rtc ms] [--ram a:n]… [--record f] [--script f] [--bench frames [--out dir]] [--backend sameboy|mgba|melonds] [--load state]\n");
    return 2;
  }
  if (bench) protocol = 0;
  if (!rtc_ms) rtc_ms = (int64_t)time(NULL) * 1000;
  if (script_path) {
    size_t n = 0;
    uint8_t *b = link_read_file(script_path, &n);
    const size_t rec = 4 + 4 * (size_t)nseats;
    if (!b || n < rec) die("--script: not a recording of %d seats", nseats);
    script_frames = (uint32_t)(n / rec);
    script = calloc((size_t)script_frames * nseats, sizeof *script);
    for (uint32_t f = 0; f < script_frames; f++) memcpy(script + (size_t)f * nseats, b + f * rec + 4, 4 * (size_t)nseats);
    free(b);
  }

  for (size_t i = 0; i < sizeof backends / sizeof *backends && !B; i++) {
    if (backend_name && strcmp(backend_name, backends[i]->name)) continue;
    int all = 1;
    for (int s = 0; s < nseats; s++) all &= backends[i]->probe(roms[s]);
    if (all) B = backends[i];
  }
  if (!B) die("no link backend runs these games");
  struct link_seat_config cfg[LINK_MAX_SEATS];
  void *save_bytes[LINK_MAX_SEATS] = {0};
  for (int s = 0; s < nseats; s++) {
    size_t sl = 0;
    save_bytes[s] = s < ns && strcmp(srams[s], "-") ? link_read_file(srams[s], &sl) : NULL;
    cfg[s] = (struct link_seat_config){roms[s], save_bytes[s], sl, s < nst && strcmp(states[s], "-") ? states[s] : NULL};
  }
  if (!B->open(nseats, cfg, rtc_ms)) die("the games didn't start");
  for (int s = 0; s < nseats; s++) {
    free(save_bytes[s]);
    void *p = NULL;
    const size_t n = B->sram(s, &p);
    seats[s].sram_sent = seats[s].sram_seen = p ? link_fnv(FNV0, p, n) : 0;
    free(p);
    seats[s].have = net_mode ? (uint32_t)delay_frames : 0; // the first frames: nothing pressed, known to everybody
  }
  if (load_path) { // a whole-session state (rejoin): every console, and the frame the session goes on from
    size_t n = 0;
    uint8_t *b = link_read_file(load_path, &n);
    if (!b || !load_all(b, n)) die("--load: not a session state of these games");
    free(b);
    if (!net_mode) for (int s = 0; s < nseats; s++) seats[s].have = 0;
  }
  view_seat = local_seat;
  const double fps = B->fps();
  {
    const uint32_t *px;
    unsigned w, h, stride;
    B->video(local_seat, &px, &w, &h, &stride);
    screen_h = (int)h;
  }

  if (bench) {
    double t0 = now_s(), next = t0, worst = 0;
    for (int i = 0; i < bench; i++) {
      const double a = now_s();
      if (script) for (int s = 0; s < nseats; s++) seats[s].in[frame % RING] = script_input(frame, s);
      run_frame();
      pump_audio(0);
      const double d = now_s() - a;
      if (d > worst) worst = d;
      if (bench_speed > 0) { next += 1.0 / (fps * bench_speed); sleep_s(next - now_s()); }
    }
    const double dt = now_s() - t0;
    fprintf(stderr, "bench: %s %s, %d seats, %d frames in %.2f s = %.1f fps (%.2fx), %.3f ms/frame avg, %.3f ms worst, hash %016llx\n", B->name, B->system(), nseats, bench, dt,
            bench / dt, bench / dt / fps, dt * 1000 / bench, worst * 1000, (unsigned long long)B->hash(FNV0));
    if (out_dir) for (int s = 0; s < nseats; s++) { // every seat's battery save as the session left it
      void *p = NULL;
      const size_t n = B->sram(s, &p);
      char path[1024];
      snprintf(path, sizeof path, "%s/seat%d.sav", out_dir, s);
      FILE *f = fopen(path, "wb");
      if (f && p) fwrite(p, 1, n, f);
      if (f) fclose(f);
      free(p);
    }
    _exit(0);
  }

  {
    const uint32_t *px;
    unsigned w, h, stride;
    B->video(0, &px, &w, &h, &stride);
    // (the regions as retrohost names them: the fast player mirrors the local seat's RAM for live tracking)
    char regions[256] = "";
    size_t o = 0;
    for (int i = 0; i < ram_n && o < sizeof regions - 48; i++)
      o += (size_t)snprintf(regions + o, sizeof regions - o, "%s{\"addr\":%u,\"len\":%u,\"ok\":%s}", i ? "," : "", ram[i].addr, ram[i].len, B->mem(local_seat, ram[i].addr, ram[i].len) ? "true" : "false");
    send_event("{\"event\":\"loaded\",\"core\":\"souldew link (%s)\",\"system\":\"%s\",\"seats\":%d,\"local\":%d,\"net\":%s,\"delay\":%d,\"width\":%u,\"height\":%u,\"fps\":%.4f,\"sampleRate\":%.1f,\"frame\":%u,\"ram\":[%s]}",
               B->name, B->system(), nseats, local_seat, net_mode ? "true" : "false", delay_frames, w, h, fps, B->sample_rate ? B->sample_rate() : 0.0, frame, regions);
  }
  pthread_t th;
  pthread_create(&th, NULL, reader, NULL);
  double next = now_s(), last_frame = 0, last_ram = 0, last_sram = now_s(), stat_t = now_s(), wait_since = 0;
  uint32_t stat_frames = 0;
  static struct pending pend[MAX_PENDING];
  for (;;) {
    pthread_mutex_lock(&cmd_lock);
    const float spd = speed;
    const int quit = want_quit, save = want_save, flush = want_flush, view_now = want_view, view = view_seat;
    uint8_t *ld = load_data;
    const size_t ll = load_len;
    want_save = want_flush = want_view = 0;
    load_data = NULL;
    const int np = pending_n;
    memcpy(pend, pending, sizeof *pend * (size_t)np);
    pending_n = 0;
    pthread_mutex_unlock(&cmd_lock);
    if (quit) break;
    if (view_now) send_frame(view); // (the picture right away, paused or not)
    for (int i = 0; i < np; i++) {
      if (pend[i].type == 21) take_remote(pend[i].p, pend[i].len);
      else if (pend[i].type == 22) do_read(pend[i].p, pend[i].len);
      else if (pend[i].type == 23) do_poke(pend[i].p, pend[i].len);
      else if (pend[i].type == 25) do_need(pend[i].p, pend[i].len);
      free(pend[i].p);
    }
    if (ld) {
      const int ok = load_all(ld, ll);
      free(ld);
      send_event("{\"event\":\"stateLoaded\",\"ok\":%s}", ok ? "true" : "false");
    }
    if (save) save_all();
    if (flush) check_sram(1), send_all_sram();
    double t = now_s();
    if (spd <= 0.0f) {
      if (t - last_ram >= 0.1) last_ram = t, send_ram();
      if (t - last_sram >= 0.5) last_sram = t, check_sram(0);
      pthread_mutex_lock(&cmd_lock);
      if (!want_quit && !pending_n && speed <= 0) {
        struct timespec ts;
        clock_gettime(CLOCK_REALTIME, &ts);
        ts.tv_nsec += 10 * 1000000;
        if (ts.tv_nsec >= 1000000000) ts.tv_sec++, ts.tv_nsec -= 1000000000;
        pthread_cond_timedwait(&cmd_cond, &cmd_lock, &ts);
      }
      pthread_mutex_unlock(&cmd_lock);
      next = now_s();
      continue;
    }
    if (net_mode) {
      struct seat *me = &seats[local_seat];
      while (me->have <= frame + (uint32_t)delay_frames) { // the local buttons, D frames ahead, out to the peers
        const uint32_t f = me->have;
        pthread_mutex_lock(&cmd_lock);
        const link_input k = script ? script_input(f, local_seat) : sample_input(me);
        pthread_mutex_unlock(&cmd_lock);
        me->in[f % RING] = k;
        me->have = f + 1;
        uint32_t m[3] = {(uint32_t)local_seat, f, k};
        send_msg(12, m, sizeof m);
      }
      int missing = 0;
      for (int s = 0; s < nseats; s++) if (seats[s].have <= frame) missing |= 1 << s;
      if (missing) { // a peer's buttons are late: wait (the game stands still – the same for everybody)
        if (!wait_since) wait_since = t;
        if (t - wait_since > 0.25) {
          send_event("{\"event\":\"wait\",\"seats\":%d,\"frame\":%u,\"ms\":%.0f}", missing, frame, (t - wait_since) * 1000);
          wait_since = t - 0.0001;
        }
        pthread_mutex_lock(&cmd_lock);
        if (!want_quit && !pending_n) {
          struct timespec ts;
          clock_gettime(CLOCK_REALTIME, &ts);
          ts.tv_nsec += 2 * 1000000;
          if (ts.tv_nsec >= 1000000000) ts.tv_sec++, ts.tv_nsec -= 1000000000;
          pthread_cond_timedwait(&cmd_cond, &cmd_lock, &ts);
        }
        pthread_mutex_unlock(&cmd_lock);
        next = now_s();
        continue;
      }
      wait_since = 0;
    } else {
      pthread_mutex_lock(&cmd_lock);
      for (int s = 0; s < nseats; s++) seats[s].in[frame % RING] = script ? script_input(frame, s) : sample_input(&seats[s]);
      pthread_mutex_unlock(&cmd_lock);
    }
    run_frame();
    stat_frames++;
    if (frame % HASH_EVERY == 0) send_event("{\"event\":\"hash\",\"frame\":%u,\"hash\":\"%016llx\"}", frame, (unsigned long long)B->hash(FNV0));
    pthread_mutex_lock(&cmd_lock);
    const int stepped = (step_left && --step_left == 0) || (until_frame && frame >= until_frame);
    if (until_frame && frame >= until_frame) until_frame = 0;
    if (stepped) speed = 0.0f;
    pthread_mutex_unlock(&cmd_lock);
    t = now_s();
    const int turbo = spd > 1.01f;
    pump_audio(!turbo);
    if (stepped || !turbo || t - last_frame >= 1.0 / 62) last_frame = t, send_frame(view);
    if (stepped) {
      send_ram();
      last_ram = t;
      send_event("{\"event\":\"stepped\",\"frame\":%u}", frame);
    }
    if (t - last_ram >= 0.1) last_ram = t, send_ram();
    if (t - last_sram >= 0.25) last_sram = t, check_sram(0);
    if (t - stat_t >= 0.5) {
      send_event("{\"event\":\"stats\",\"fps\":%.1f,\"speed\":%.3f,\"frame\":%u}", stat_frames / (t - stat_t), stat_frames / (t - stat_t) / fps, frame);
      stat_t = t;
      stat_frames = 0;
    }
    if (spd >= 100.0f) { next = t; continue; }
    next += 1.0 / (fps * spd);
    if (next < t - 0.1) next = t;
    double w = next - t;
    if (w > 0.1) w = 0.1, next = t + 0.1;
    sleep_s(w);
  }
  check_sram(1);
  send_event("{\"event\":\"ended\",\"frame\":%u}", frame);
  _exit(0);
}
