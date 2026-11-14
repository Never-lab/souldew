// souldew's link host: N linked Game Boy Advance (or Game Boy / Game Boy Color) consoles in ONE process, joined by
// mGBA's lockstep link-cable driver and stepped by a single deterministic scheduler – the engine behind trades and
// battles between players (docs/MULTIPLAYER.md). Every peer of a link session runs ALL consoles from the same ROMs
// (each partner's ROM rebuilt locally and checked by SHA-1 – no ROM ever crosses the network) and the same battery
// saves, and only the buttons travel. Same program + same inputs on the same frames = the same games everywhere.
//
//   linkhost --rom <seat0> [--rom <seat1> …] [--sram <file>|-]… [--state <file>|-]… [--local k] [--net --delay D]
//            [--rtc <unix ms>] [--ram ADDR:LEN]… [--bench FRAMES] [--speed X]
//
// Messages are { u32 type, u32 length, payload } (little-endian) both ways, as native/retro-host/retrohost.c.
//   host → souldew   2 VIDEO  u16 width, u16 height, u32 format (0 = BGRA bytes), pixels – the viewed seat (VIEW)
//                    5 STATE  all seats: u32 n, n × { u32 len, mGBA state } (answer to SAVE)
//                    6 LOG    text
//                    7 EVENT  json: loaded | stats | stepped | hash {frame, hash} | wait {seats} | error | ended
//                    8 RAM    the local seat's --ram regions that changed (retrohost's format: live tracking works)
//                    9 SRAM   the local seat's battery save, when the game saved (retrohost's format)
//                   11 MEM    u32 seat, u32 addr, bytes (answer to READ)
//                   12 LINPUT u32 seat, u32 first frame, u16 keys[] – the local seat's buttons, to send to the peers
//                   14 SEATSRAM u32 seat, bytes (every seat's battery save, on FLUSH)
//   souldew → host   1 INPUT  u32 joypad bits (RETRO_DEVICE_ID_JOYPAD_*) [, u32 seat – local mode only]
//                    2 SPEED  f32   3 SAVE   4 LOAD (STATE's format)   6 QUIT   10 FLUSH   13 STEP u32 n
//                   20 VIEW   u32 seat (which console's picture comes out)
//                   21 RINPUT u32 seat, u32 first frame, u16 keys[] – a peer's buttons (--net)
//                   22 READ   u32 seat, u32 addr, u32 len      23 POKE u32 seat, u32 addr, bytes (tests)
//                   24 UNTIL  u32 frame: run until the session reaches this frame, then pause (every peer the same)
//
// Local mode (no --net): every seat's buttons come from INPUT (seat given), the session runs as fast as SPEED says.
// Net mode: the local seat's buttons for frame f are taken at frame f − D and sent as LINPUT; frame f runs only when
// every seat's buttons for it are known (input-delay lockstep, no rollback). A hash of every console's RAM goes out
// every 120 frames: souldew compares the peers' hashes and stops a session that fell out of step.
#include <mgba/flags.h>
#include <mgba/core/core.h>
#include <mgba/core/config.h>
#include <mgba/core/interface.h>
#include <mgba/core/lockstep.h>
#include <mgba/core/log.h>
#include <mgba/core/serialize.h>
#include <mgba/gba/interface.h>
#include <mgba/internal/gba/gba.h>
#include <mgba/internal/gba/sio/lockstep.h>
#include <mgba/internal/gb/gb.h>
#include <mgba/internal/gb/sio/lockstep.h>
#include <mgba-util/vfs.h>

#include <errno.h>
#include <math.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define MAX_SEATS 4
#define RING 4096 // frames of buttons kept per seat
#define HASH_EVERY 120

// ---- output --------------------------------------------------------------------------------------------------------
static pthread_mutex_t out_lock = PTHREAD_MUTEX_INITIALIZER;
static int protocol = 1;

static void write_all(const void *p, size_t n) {
  const uint8_t *b = p;
  while (n) {
    ssize_t w = write(1, b, n);
    if (w < 0) {
      if (errno == EINTR) continue;
      _exit(0);
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
static void logf_(const char *fmt, ...) {
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

// ---- seats -----------------------------------------------------------------------------------------------------------
static int nseats, local_seat, net_mode, delay_frames = 4;
static enum mPlatform platform;
static struct seat {
  struct mCore *core;
  uint32_t *video;
  unsigned w, h;
  int asleep;          // the lockstep driver put this console to sleep: it waits for the others
  int32_t posted;      // GB lockstep: cycles the primary allowed this one to run
  uint32_t wait_mask;  // GB lockstep (primary): which secondaries it waits for
  uint16_t keys[RING]; // buttons per frame
  uint32_t have;       // buttons known for frames < have
  uint8_t early[RING]; // a peer's buttons that came ahead of a gap (an unordered channel): kept until the gap fills
  uint32_t held;       // local mode: the buttons held now
  uint64_t sram_sent, sram_seen;
} seats[MAX_SEATS];
static uint32_t frame; // the session's frame: every console started this many frames
// tests: --record writes every frame's buttons (u32 frame, u16 keys[seats]); --script plays such a file back (net mode:
// the local seat's buttons, local mode: every seat's)
static FILE *record_f;
static uint16_t *script;
static uint32_t script_frames;
static int script_seats;
static uint16_t script_keys(uint32_t f, int seat) { return f < script_frames && seat < script_seats ? script[(size_t)f * script_seats + seat] : 0; }

// GBA: the coordinator and one driver per console, sleep/wake set a flag the scheduler honours
static struct GBASIOLockstepCoordinator gba_coord;
static struct GBASIOLockstepDriver gba_drv[MAX_SEATS];
static struct seat_user { struct mLockstepUser d; int seat; } users[MAX_SEATS];
static void user_sleep(struct mLockstepUser *u) { seats[((struct seat_user *)u)->seat].asleep = 1; }
static void user_wake(struct mLockstepUser *u) { seats[((struct seat_user *)u)->seat].asleep = 0; }
static int user_requested_id(struct mLockstepUser *u) { return ((struct seat_user *)u)->seat; }

// GB: the older mLockstep with signal/wait/cycle budgets (as mGBA's own MultiplayerController drives it, with flags in
// place of thread pauses)
static struct GBSIOLockstep gb_lock;
static struct GBSIOLockstepNode gb_node[MAX_SEATS];
static bool gb_signal(struct mLockstep *l, unsigned mask) {
  (void)l;
  struct seat *p = &seats[0];
  p->wait_mask &= ~mask;
  if (!p->wait_mask && p->asleep) { p->asleep = 0; return true; }
  return false;
}
static bool gb_wait(struct mLockstep *l, unsigned mask) {
  (void)l;
  struct seat *p = &seats[0];
  p->wait_mask |= mask;
  if (!p->asleep) { p->asleep = 1; return true; }
  return false;
}
static void gb_add_cycles(struct mLockstep *l, int id, int32_t cycles) {
  (void)l;
  if (cycles < 0) die("lockstep: negative cycles");
  if (!id) {
    struct seat *p = &seats[1];
    p->posted += cycles;
    if (p->asleep) gb_node[1].nextEvent += p->posted;
    p->asleep = 0;
  } else seats[id].posted += cycles;
}
static int32_t gb_use_cycles(struct mLockstep *l, int id, int32_t cycles) {
  (void)l;
  struct seat *p = &seats[id];
  p->posted -= cycles;
  if (p->posted <= 0) p->asleep = 1;
  return p->posted;
}
static int32_t gb_unused_cycles(struct mLockstep *l, int id) { (void)l; return seats[id].posted; }
static void gb_unload(struct mLockstep *l, int id) {
  (void)l;
  if (id) {
    seats[id].posted = 0;
    seats[0].wait_mask &= ~(1u << id);
    if (!seats[0].wait_mask) seats[0].asleep = 0;
  } else {
    for (int i = 1; i < nseats; i++) {
      seats[i].posted += gb_lock.players[0]->eventDiff;
      if (seats[i].asleep) gb_node[i].nextEvent += seats[i].posted;
      seats[i].asleep = 0;
    }
  }
}

/** RETRO_DEVICE_ID_JOYPAD_* bits → the console's key bits. */
static uint16_t retro_to_keys(uint32_t r) {
  static const int map[12] = {1, -1, 2, 3, 6, 7, 5, 4, 0, -1, 9, 8}; // B Y SEL START UP DOWN LEFT RIGHT A X L R
  uint16_t k = 0;
  for (int i = 0; i < 12; i++)
    if ((r >> i & 1) && map[i] >= 0) k |= (uint16_t)(1u << map[i]);
  if (platform == mPLATFORM_GB) k &= 0xff;
  return k;
}

static void *read_file(const char *path, size_t *n) {
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

static uint64_t fnv(uint64_t h, const void *p, size_t n) {
  const uint8_t *b = p;
  for (size_t i = 0; i < n; i++) h = (h ^ b[i]) * 1099511628211ull;
  return h;
}

/** A pointer into the console's memory for bus address `addr` (`len` bytes inside one block), or NULL. */
static uint8_t *mem_at(struct mCore *core, uint32_t addr, uint32_t len) {
  const struct mCoreMemoryBlock *blocks;
  size_t n = core->listMemoryBlocks(core, &blocks);
  for (size_t i = 0; i < n; i++) {
    const struct mCoreMemoryBlock *b = &blocks[i];
    if (addr < b->start || (uint64_t)addr + len > (uint64_t)b->start + b->size) continue;
    size_t size = 0;
    uint8_t *p = core->getMemoryBlock(core, b->id, &size);
    if (p && (uint64_t)(addr - b->start) + len <= size) return p + (addr - b->start);
  }
  return NULL;
}

/** Every console's work RAM and clock in one number: equal on every peer while the session is in step. */
static uint64_t session_hash(void) {
  uint64_t h = 1469598103934665603ull;
  for (int s = 0; s < nseats; s++) {
    struct mCore *c = seats[s].core;
    if (platform == mPLATFORM_GBA) {
      struct GBA *gba = c->board;
      h = fnv(h, gba->memory.wram, GBA_SIZE_EWRAM);
      h = fnv(h, gba->memory.iwram, GBA_SIZE_IWRAM);
      h = fnv(h, gba->cpu->gprs, sizeof gba->cpu->gprs);
    } else {
      struct GB *gb = c->board;
      h = fnv(h, gb->memory.wram, GB_SIZE_WORKING_RAM);
      h = fnv(h, gb->memory.hram, GB_SIZE_HRAM);
    }
    int32_t t = mTimingCurrentTime(c->timing);
    h = fnv(h, &t, sizeof t);
  }
  return h;
}

// ---- the scheduler -----------------------------------------------------------------------------------------------
/**
 * One session frame: every console runs until it has started `frame + 1` frames. A console the lockstep driver put
 * to sleep waits; the others run (event by event, `runLoop`) until it is woken. Consoles that finished the frame may
 * run on into the next while a slower one still needs them – all of it in a fixed order, so it is the same on every
 * peer.
 */
static void run_frame(void) {
  for (int s = 0; s < nseats; s++) seats[s].core->setKeys(seats[s].core, seats[s].keys[frame % RING]);
  const uint32_t target = frame + 1;
  uint32_t start[MAX_SEATS];
  for (int s = 0; s < nseats; s++) start[s] = seats[s].core->frameCounter(seats[s].core);
  for (long guard = 0;; guard++) {
    int behind = 0, ran = 0;
    for (int s = 0; s < nseats; s++) {
      struct mCore *c = seats[s].core;
      if (c->frameCounter(c) - start[s] >= 1) continue;
      behind = 1;
      if (seats[s].asleep) continue;
      c->runLoop(c);
      ran = 1;
    }
    if (!behind) break;
    if (!ran) { // the ones still behind sleep: whoever is awake runs on (it is what they wait for)
      for (int s = 0; s < nseats; s++) {
        if (seats[s].asleep) continue;
        seats[s].core->runLoop(seats[s].core);
        ran = 1;
      }
      if (!ran) die("link: every console waits for another (deadlock at frame %u)", frame);
    }
    if (guard > 50000000) die("link: frame %u never ended", frame);
  }
  (void)target;
  frame++;
}

// ---- commands ------------------------------------------------------------------------------------------------------
static int ram_full;
static pthread_mutex_t cmd_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t cmd_cond = PTHREAD_COND_INITIALIZER;
static float speed = 1.0f;
static uint32_t step_left, until_frame; // STEP: frames still to run; UNTIL: pause at this session frame
static int view_seat, want_quit, want_save, want_flush, want_view;
static uint8_t *load_data;
static size_t load_len;
#define MAX_PENDING 256
static struct pending { uint32_t type, len; uint8_t *p; } pending[MAX_PENDING]; // READ / POKE / RINPUT, in order
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
        if (seat < (uint32_t)nseats) seats[seat].held = retro_to_keys(bits);
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
    case 24:
      if (h[1] >= 4) { memcpy(&until_frame, p, 4); if (speed <= 0) speed = 1000.0f; }
      break;
    case 20:
      if (h[1] >= 4) { uint32_t v; memcpy(&v, p, 4); view_seat = v < (uint32_t)nseats ? (int)v : view_seat; want_view = 1; }
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

/** A peer's buttons (RINPUT), in order; frames already known are checked: a different value means a broken peer. */
static void take_remote(const uint8_t *p, uint32_t len) {
  if (len < 8) return;
  uint32_t seat, first;
  memcpy(&seat, p, 4);
  memcpy(&first, p + 4, 4);
  if (seat >= (uint32_t)nseats || (int)seat == local_seat) return;
  struct seat *st = &seats[seat];
  uint32_t n = (len - 8) / 2;
  for (uint32_t i = 0; i < n; i++) {
    uint32_t f = first + i;
    uint16_t k;
    memcpy(&k, p + 8 + i * 2, 2);
    if (f < st->have) continue;            // known already (a resend)
    if (f >= frame + RING - 1) break;      // too far ahead
    st->keys[f % RING] = k;
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
  for (uint32_t i = 0; i < n; i++) out[8 + i] = (uint8_t)seats[seat].core->busRead8(seats[seat].core, addr + i);
  send_msg(11, out, 8 + n);
  free(out);
}

static void do_poke(const uint8_t *p, uint32_t len) {
  if (len < 9) return;
  uint32_t seat, addr;
  memcpy(&seat, p, 4), memcpy(&addr, p + 4, 4);
  if (seat >= (uint32_t)nseats) return;
  for (uint32_t i = 0; i < len - 8; i++) seats[seat].core->busWrite8(seats[seat].core, addr + i, p[8 + i]);
}

// ---- video / RAM / saves out ----------------------------------------------------------------------------------------
static uint8_t *frame_msg;
static void send_frame(int seat) {
  struct seat *st = &seats[seat];
  const size_t n = (size_t)st->w * st->h;
  if (!frame_msg) frame_msg = malloc(8 + 256 * 256 * 4);
  uint16_t w = (uint16_t)st->w, h = (uint16_t)st->h;
  uint32_t f = 0;
  memcpy(frame_msg, &w, 2), memcpy(frame_msg + 2, &h, 2), memcpy(frame_msg + 4, &f, 4);
  uint8_t *o = frame_msg + 8;
  for (size_t i = 0; i < n; i++) { // mGBA's 0x00BBGGRR → B, G, R, X bytes
    const uint32_t c = st->video[i];
    o[i * 4] = (uint8_t)(c >> 16), o[i * 4 + 1] = (uint8_t)(c >> 8), o[i * 4 + 2] = (uint8_t)c, o[i * 4 + 3] = 0xff;
  }
  send_msg(2, frame_msg, (uint32_t)(8 + n * 4));
}

#define MAX_RAM 4
#define BLOCK 1024
static struct { uint32_t addr, len; uint8_t *shadow; } ram[MAX_RAM];
static int ram_n;
static uint8_t *ram_msg;
static void send_ram(void) {
  struct mCore *c = seats[local_seat].core;
  size_t cap = 4;
  for (int i = 0; i < ram_n; i++) cap += ram[i].len + 8 * (ram[i].len / BLOCK + 1);
  uint8_t *m = realloc(ram_msg, cap);
  if (!m) return;
  ram_msg = m;
  uint8_t *p = m + 4;
  uint32_t count = 0;
  for (int i = 0; i < ram_n; i++) {
    uint8_t *src = mem_at(c, ram[i].addr, ram[i].len);
    if (!src) continue;
    if (!ram[i].shadow) ram[i].shadow = calloc(1, ram[i].len);
    uint32_t at = 0;
    while (at < ram[i].len) {
      uint32_t n = ram[i].len - at < BLOCK ? ram[i].len - at : BLOCK;
      if (!ram_full && !memcmp(src + at, ram[i].shadow + at, n)) { at += n; continue; }
      uint32_t start = at;
      while (at < ram[i].len) {
        n = ram[i].len - at < BLOCK ? ram[i].len - at : BLOCK;
        if (!ram_full && !memcmp(src + at, ram[i].shadow + at, n)) break;
        memcpy(ram[i].shadow + at, src + at, n);
        at += n;
      }
      uint32_t addr = ram[i].addr + start, len = at - start;
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
  size_t n = st->core->savedataClone(st->core, &p);
  if (!p || !n) { free(p); return; }
  uint64_t h = fnv(1469598103934665603ull, p, n);
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
    size_t n = seats[s].core->savedataClone(seats[s].core, &p);
    uint32_t seat = (uint32_t)s;
    send_msg2(14, &seat, 4, p, (uint32_t)n);
    free(p);
  }
}

static void save_all(void) {
  size_t total = 4;
  for (int s = 0; s < nseats; s++) total += 4 + seats[s].core->stateSize(seats[s].core);
  uint8_t *b = malloc(total), *p = b + 4;
  if (!b) { send_msg(5, NULL, 0); return; }
  uint32_t n = (uint32_t)nseats;
  memcpy(b, &n, 4);
  for (int s = 0; s < nseats; s++) {
    uint32_t len = (uint32_t)seats[s].core->stateSize(seats[s].core);
    memcpy(p, &len, 4);
    seats[s].core->saveState(seats[s].core, p + 4);
    p += 4 + len;
  }
  send_msg(5, b, (uint32_t)total);
  free(b);
}
static int load_all(const uint8_t *b, size_t len) {
  if (len < 4) return 0;
  uint32_t n;
  memcpy(&n, b, 4);
  if (n != (uint32_t)nseats) return 0;
  size_t at = 4;
  for (int s = 0; s < nseats; s++) {
    uint32_t l;
    if (at + 4 > len) return 0;
    memcpy(&l, b + at, 4);
    if (l != seats[s].core->stateSize(seats[s].core) || at + 4 + l > len) return 0;
    at += 4 + l;
  }
  at = 4;
  for (int s = 0; s < nseats; s++) {
    uint32_t l;
    memcpy(&l, b + at, 4);
    seats[s].core->loadState(seats[s].core, b + at + 4);
    at += 4 + l;
  }
  return 1;
}

// mGBA's own log: only what went badly wrong (it logs every DMA otherwise)
static void core_log(struct mLogger *l, int category, enum mLogLevel level, const char *fmt, va_list ap) {
  (void)l, (void)category;
  if (!(level & (mLOG_FATAL | mLOG_ERROR))) return;
  char buf[512];
  vsnprintf(buf, sizeof buf, fmt, ap);
  logf_("[mGBA] %s", buf);
}
static struct mLogger logger = {core_log, NULL};

// ---- main ----------------------------------------------------------------------------------------------------------
int main(int argc, char **argv) {
  const char *roms[MAX_SEATS] = {0}, *srams[MAX_SEATS] = {0}, *states[MAX_SEATS] = {0};
  int nr = 0, ns = 0, nst = 0, bench = 0;
  double bench_speed = 0;
  int64_t rtc_ms = 0;
  const char *script_path = NULL, *out_dir = NULL;
  for (int i = 1; i < argc; i++) {
    const char *k = argv[i], *v = i + 1 < argc ? argv[i + 1] : NULL;
    if (!strcmp(k, "--net")) { net_mode = 1; continue; }
    if (!v) break;
    i++;
    if (!strcmp(k, "--rom") && nr < MAX_SEATS) roms[nr++] = v;
    else if (!strcmp(k, "--sram") && ns < MAX_SEATS) srams[ns++] = v;
    else if (!strcmp(k, "--state") && nst < MAX_SEATS) states[nst++] = v;
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
      unsigned long a = strtoul(v, &end, 0), n = end && *end == ':' ? strtoul(end + 1, NULL, 0) : 0;
      if (n > 0 && n <= 16u * 1024 * 1024) ram[ram_n].addr = (uint32_t)a, ram[ram_n].len = (uint32_t)n, ram_n++;
    }
  }
  nseats = nr;
  ram_full = 1;
  if (script_path) { // a recording of this many seats: frames of { u32 frame, u16 keys[seats] }
    size_t n = 0;
    uint8_t *b = read_file(script_path, &n);
    const size_t rec = 4 + 2 * (size_t)(nseats ? nseats : 1);
    if (!b || n < rec) die("--script: not a recording");
    script_seats = nseats;
    script_frames = (uint32_t)(n / rec);
    script = calloc((size_t)script_frames * script_seats, 2);
    for (uint32_t f = 0; f < script_frames; f++) memcpy(script + (size_t)f * script_seats, b + f * rec + 4, (size_t)script_seats * 2);
    free(b);
  }
  if (nseats < 1 || local_seat < 0 || local_seat >= nseats || delay_frames < 1 || delay_frames > 120) {
    fprintf(stderr, "usage: linkhost --rom <seat0> [--rom <seat1>…] [--sram f|-]… [--state f|-]… [--local k] [--net --delay D] [--rtc ms] [--ram a:n]… [--bench frames]\n");
    return 2;
  }
  if (bench) protocol = 0;
  mLogSetDefaultLogger(&logger);
  if (!rtc_ms) rtc_ms = (int64_t)time(NULL) * 1000;

  for (int s = 0; s < nseats; s++) {
    struct seat *st = &seats[s];
    st->core = mCoreFind(roms[s]);
    if (!st->core) die("seat %d: not a Game Boy / Game Boy Advance game: %s", s, roms[s]);
    if (!s) platform = st->core->platform(st->core);
    else if (st->core->platform(st->core) != platform) die("seat %d: another system than seat 0", s);
    if (!st->core->init(st->core)) die("seat %d: the core didn't start", s);
    mCoreInitConfig(st->core, NULL);
    struct mCoreOptions opts = {.useBios = false, .skipBios = true, .volume = 0, .mute = true};
    mCoreConfigLoadDefaults(&st->core->config, &opts);
    mCoreConfigSetDefaultValue(&st->core->config, "idleOptimization", "remove");
    mCoreLoadConfig(st->core);
    st->core->baseVideoSize(st->core, &st->w, &st->h);
    st->video = calloc((size_t)st->w * st->h, sizeof *st->video);
    st->core->setVideoBuffer(st->core, (void *)st->video, st->w);
    if (!mCoreLoadFile(st->core, roms[s])) die("seat %d: the game didn't load", s);
    // the battery save: in memory, never written to a file here – souldew gets it through SRAM / SEATSRAM
    size_t sl = 0;
    void *sd = s < ns && strcmp(srams[s], "-") ? read_file(srams[s], &sl) : NULL;
    struct VFile *vf = VFileMemChunk(sd, sl);
    free(sd);
    st->core->loadSave(st->core, vf);
    // the cartridge clock: one shared start time, then emulated time only (a real clock would differ between peers)
    st->core->rtc.override = RTC_FAKE_EPOCH;
    st->core->rtc.value = rtc_ms;
    st->core->reset(st->core);
    if (s < nst && strcmp(states[s], "-")) {
      struct VFile *sf = VFileOpen(states[s], O_RDONLY);
      if (!sf || !mCoreLoadStateNamed(st->core, sf, SAVESTATE_SAVEDATA | SAVESTATE_RTC)) die("seat %d: state not loadable", s);
      sf->close(sf);
      st->core->rtc.override = RTC_FAKE_EPOCH; // (a state may carry its own clock setting)
      st->core->rtc.value = rtc_ms;
    }
    void *p = NULL;
    size_t n = st->core->savedataClone(st->core, &p);
    st->sram_sent = st->sram_seen = p ? fnv(1469598103934665603ull, p, n) : 0;
    free(p);
  }

  if (nseats > 1) { // the link cable
    if (platform == mPLATFORM_GBA) {
      GBASIOLockstepCoordinatorInit(&gba_coord);
      for (int s = 0; s < nseats; s++) {
        users[s] = (struct seat_user){{user_sleep, user_wake, user_requested_id, NULL}, s};
        GBASIOLockstepDriverCreate(&gba_drv[s], &users[s].d);
        GBASIOLockstepCoordinatorAttach(&gba_coord, &gba_drv[s]);
        seats[s].core->setPeripheral(seats[s].core, mPERIPH_GBA_LINK_PORT, &gba_drv[s].d);
      }
    } else {
      if (nseats > 2) die("a Game Boy link cable joins two consoles");
      GBSIOLockstepInit(&gb_lock);
      gb_lock.d.signal = gb_signal;
      gb_lock.d.wait = gb_wait;
      gb_lock.d.addCycles = gb_add_cycles;
      gb_lock.d.useCycles = gb_use_cycles;
      gb_lock.d.unusedCycles = gb_unused_cycles;
      gb_lock.d.unload = gb_unload;
      for (int s = 0; s < nseats; s++) {
        GBSIOLockstepNodeCreate(&gb_node[s]);
        GBSIOLockstepAttachNode(&gb_lock, &gb_node[s]);
        GBSIOSetDriver(&((struct GB *)seats[s].core->board)->sio, &gb_node[s].d);
      }
    }
  }
  // the first frames' buttons: nothing pressed, known for everybody (the input delay)
  for (int s = 0; s < nseats; s++) seats[s].have = net_mode ? (uint32_t)delay_frames : 0;
  view_seat = local_seat;

  const double fps = (double)seats[0].core->frequency(seats[0].core) / seats[0].core->frameCycles(seats[0].core);
  if (bench) {
    double t0 = now_s(), next = t0, worst = 0;
    for (int i = 0; i < bench; i++) {
      double a = now_s();
      if (script) for (int s = 0; s < nseats; s++) seats[s].keys[frame % RING] = script_keys(frame, s);
      run_frame();
      double d = now_s() - a;
      if (d > worst) worst = d;
      if (bench_speed > 0) { next += 1.0 / (fps * bench_speed); sleep_s(next - now_s()); }
    }
    double dt = now_s() - t0;
    fprintf(stderr, "bench: %d seats, %d frames in %.2f s = %.1f fps (%.2fx), %.3f ms/frame avg, %.3f ms worst, hash %016llx\n", nseats, bench, dt, bench / dt,
            bench / dt / fps, dt * 1000 / bench, worst * 1000, (unsigned long long)session_hash());
    if (out_dir) for (int s = 0; s < nseats; s++) { // every seat's battery save as the session left it
      void *p = NULL;
      size_t n = seats[s].core->savedataClone(seats[s].core, &p);
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
    char sys[8];
    snprintf(sys, sizeof sys, "%s", platform == mPLATFORM_GBA ? "gba" : "gb");
    send_event("{\"event\":\"loaded\",\"core\":\"mGBA link\",\"system\":\"%s\",\"seats\":%d,\"local\":%d,\"net\":%s,\"delay\":%d,\"width\":%u,\"height\":%u,\"fps\":%.4f}",
               sys, nseats, local_seat, net_mode ? "true" : "false", delay_frames, seats[0].w, seats[0].h, fps);
  }
  pthread_t th;
  pthread_create(&th, NULL, reader, NULL);
  double next = now_s(), last_frame = 0, last_ram = 0, last_sram = now_s(), stat_t = now_s(), wait_since = 0;
  uint32_t stat_frames = 0;
  for (;;) {
    pthread_mutex_lock(&cmd_lock);
    float spd = speed;
    int quit = want_quit, save = want_save, flush = want_flush;
    uint8_t *ld = load_data;
    size_t ll = load_len;
    want_save = want_flush = 0;
    load_data = NULL;
    struct pending pend[MAX_PENDING];
    int np = pending_n;
    memcpy(pend, pending, sizeof *pend * (size_t)np);
    pending_n = 0;
    uint32_t held[MAX_SEATS];
    for (int s = 0; s < nseats; s++) held[s] = seats[s].held;
    int view = view_seat, view_now = want_view;
    want_view = 0;
    pthread_mutex_unlock(&cmd_lock);
    if (view_now) send_frame(view); // (the picture right away, paused or not)
    if (quit) break;
    for (int i = 0; i < np; i++) {
      if (pend[i].type == 21) take_remote(pend[i].p, pend[i].len);
      else if (pend[i].type == 22) do_read(pend[i].p, pend[i].len);
      else if (pend[i].type == 23) do_poke(pend[i].p, pend[i].len);
      free(pend[i].p);
    }
    if (ld) {
      int ok = load_all(ld, ll);
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
    // the buttons of this frame
    if (net_mode) {
      struct seat *me = &seats[local_seat];
      while (me->have <= frame + (uint32_t)delay_frames) { // the local buttons, D frames ahead, out to the peers
        uint32_t f = me->have;
        uint16_t k = script ? script_keys(f, local_seat) : (uint16_t)held[local_seat];
        me->keys[f % RING] = k;
        me->have = f + 1;
        uint8_t m[10];
        uint32_t seat = (uint32_t)local_seat;
        memcpy(m, &seat, 4), memcpy(m + 4, &f, 4), memcpy(m + 8, &k, 2);
        send_msg(12, m, 10);
      }
      int missing = 0;
      for (int s = 0; s < nseats; s++) if (seats[s].have <= frame) missing |= 1 << s;
      if (missing) { // a peer's buttons are late: wait (the game stands still – the same for everybody)
        if (!wait_since) wait_since = t;
        if (t - wait_since > 0.25) {
          send_event("{\"event\":\"wait\",\"seats\":%d,\"frame\":%u,\"ms\":%.0f}", missing, frame, (t - wait_since) * 1000);
          wait_since = t - 0.0001; // (again in a quarter second)
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
      for (int s = 0; s < nseats; s++) seats[s].keys[frame % RING] = script ? script_keys(frame, s) : (uint16_t)held[s];
    }
    if (record_f) {
      fwrite(&frame, 4, 1, record_f);
      for (int s = 0; s < nseats; s++) fwrite(&seats[s].keys[frame % RING], 2, 1, record_f);
      fflush(record_f);
    }
    run_frame();
    stat_frames++;
    if (frame % HASH_EVERY == 0) send_event("{\"event\":\"hash\",\"frame\":%u,\"hash\":\"%016llx\"}", frame, (unsigned long long)session_hash());
    pthread_mutex_lock(&cmd_lock);
    int stepped = (step_left && --step_left == 0) || (until_frame && frame >= until_frame);
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
