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
//   host → souldew   2 VIDEO  u16 width, u16 height, u32 format (0 = BGRA bytes), pixels – the viewed seat (VIEW)
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
//   souldew → host   1 INPUT  u32 joypad bits (RETRO_DEVICE_ID_JOYPAD_*) … (the fast player's 17 bytes) – the local
//                             seat; exactly 8 bytes { bits, seat } in local mode: that seat (tests)
//                    2 SPEED  f32   3 SAVE   4 LOAD (STATE's format)   6 QUIT   10 FLUSH   12 RESYNC
//                   13 STEP   u32 n (local mode: as fast as possible; net mode: at the pace set)
//                   20 VIEW   u32 seat (which console's picture comes out; sends it right away)
//                   21 RINPUT u32 seat, u32 first frame, u32 inputs[] – a peer's buttons (net mode); repeats and
//                             frames that come early (an unordered channel) are fine
//                   22 READ   u32 seat, u32 addr, u32 len      23 POKE u32 seat, u32 addr, bytes (tests)
//                   24 UNTIL  u32 frame: run until the session reaches this frame, then pause (every peer the same)
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

#define RING 4096 // frames of buttons kept per seat
#define HASH_EVERY 120

static const struct link_backend *backends[] = {&link_backend_mgba};
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
  link_input held;     // local mode / the local seat: the buttons held now
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
        if (seat < (uint32_t)nseats) seats[seat].held = retro_to_input(bits);
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
    case 21: case 22: case 23:
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
static void send_frame(int seat) {
  const uint32_t *px;
  unsigned w, h, stride;
  B->video(seat, &px, &w, &h, &stride);
  const size_t need = 8 + (size_t)w * h * 4;
  if (need > frame_cap) {
    uint8_t *b = realloc(frame_msg, need);
    if (!b) return;
    frame_msg = b, frame_cap = need;
  }
  uint16_t ww = (uint16_t)w, hh = (uint16_t)h;
  uint32_t f = 0;
  memcpy(frame_msg, &ww, 2), memcpy(frame_msg + 2, &hh, 2), memcpy(frame_msg + 4, &f, 4);
  uint8_t *o = frame_msg + 8;
  for (unsigned y = 0; y < h; y++)
    for (unsigned x = 0; x < w; x++, o += 4) { // 0x00BBGGRR → B, G, R, X bytes
      const uint32_t c = px[(size_t)y * stride + x];
      o[0] = (uint8_t)(c >> 16), o[1] = (uint8_t)(c >> 8), o[2] = (uint8_t)c, o[3] = 0xff;
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
    send_msg(9, p, (uint32_t)n);
    send_event("{\"event\":\"saved\",\"seat\":%d,\"size\":%zu}", local_seat, n);
  }
  free(p);
}
static void send_all_sram(void) {
  for (int s = 0; s < nseats; s++) {
    void *p = NULL;
    const size_t n = B->sram(s, &p);
    const uint32_t seat = (uint32_t)s;
    send_msg2(14, &seat, 4, p, (uint32_t)n);
    free(p);
  }
}

static void save_all(void) {
  size_t total = 4;
  for (int s = 0; s < nseats; s++) total += 4 + B->state_size(s);
  uint8_t *b = malloc(total), *p = b + 4;
  if (!b) { send_msg(5, NULL, 0); return; }
  const uint32_t n = (uint32_t)nseats;
  memcpy(b, &n, 4);
  for (int s = 0; s < nseats; s++) {
    const uint32_t len = (uint32_t)B->state_size(s);
    memcpy(p, &len, 4);
    B->save_state(s, p + 4);
    p += 4 + len;
  }
  send_msg(5, b, (uint32_t)total);
  free(b);
}
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
    if (l != B->state_size(s) || at + 4 + l > len) return 0;
    at += 4 + l;
  }
  at = 4;
  for (int s = 0; s < nseats; s++) {
    uint32_t l;
    memcpy(&l, b + at, 4);
    B->load_state(s, b + at + 4);
    at += 4 + l;
  }
  return 1;
}

// ---- main ----------------------------------------------------------------------------------------------------------
int main(int argc, char **argv) {
  const char *roms[LINK_MAX_SEATS] = {0}, *srams[LINK_MAX_SEATS] = {0}, *states[LINK_MAX_SEATS] = {0};
  const char *script_path = NULL, *out_dir = NULL;
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
    else if (!strcmp(k, "--ram") && ram_n < MAX_RAM) {
      char *end = NULL;
      const unsigned long a = strtoul(v, &end, 0), n = end && *end == ':' ? strtoul(end + 1, NULL, 0) : 0;
      if (n > 0 && n <= 16u * 1024 * 1024) ram[ram_n].addr = (uint32_t)a, ram[ram_n].len = (uint32_t)n, ram_n++;
    }
  }
  nseats = nr;
  if (nseats < 1 || local_seat < 0 || local_seat >= nseats || delay_frames < 1 || delay_frames > 120) {
    fprintf(stderr, "usage: linkhost --rom <seat0> [--rom <seat1>…] [--sram f|-]… [--state f|-]… [--local k] [--net --delay D] [--rtc ms] [--ram a:n]… [--record f] [--script f] [--bench frames [--out dir]]\n");
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
  view_seat = local_seat;
  const double fps = B->fps();

  if (bench) {
    double t0 = now_s(), next = t0, worst = 0;
    for (int i = 0; i < bench; i++) {
      const double a = now_s();
      if (script) for (int s = 0; s < nseats; s++) seats[s].in[frame % RING] = script_input(frame, s);
      run_frame();
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
    send_event("{\"event\":\"loaded\",\"core\":\"souldew link (%s)\",\"system\":\"%s\",\"seats\":%d,\"local\":%d,\"net\":%s,\"delay\":%d,\"width\":%u,\"height\":%u,\"fps\":%.4f}",
               B->name, B->system(), nseats, local_seat, net_mode ? "true" : "false", delay_frames, w, h, fps);
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
    link_input held[LINK_MAX_SEATS];
    for (int s = 0; s < nseats; s++) held[s] = seats[s].held;
    pthread_mutex_unlock(&cmd_lock);
    if (quit) break;
    if (view_now) send_frame(view); // (the picture right away, paused or not)
    for (int i = 0; i < np; i++) {
      if (pend[i].type == 21) take_remote(pend[i].p, pend[i].len);
      else if (pend[i].type == 22) do_read(pend[i].p, pend[i].len);
      else if (pend[i].type == 23) do_poke(pend[i].p, pend[i].len);
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
        const link_input k = script ? script_input(f, local_seat) : held[local_seat];
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
      for (int s = 0; s < nseats; s++) seats[s].in[frame % RING] = script ? script_input(frame, s) : held[s];
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
