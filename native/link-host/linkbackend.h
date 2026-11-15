// The link host's backend interface: one implementation per system family, the session around it (linkhost.c –
// protocol, input-delay lockstep, hashes, saves, RAM for live tracking) is shared. See docs/MULTIPLAYER.md › "Backends".
//
// A backend runs ALL seats of a link session in this process, joined by the system's link (GB/GBC serial cable,
// GBA SIO, DS local wireless, …), and must be deterministic: the same ROMs, saves, start time and per-frame inputs give
// bit-identical consoles on every peer. No threads that race the emulation, no wall clock, no uninitialised memory.
//
// Backends today: backend_sameboy.c (Game Boy / Game Boy Color serial link, on SameBoy – the first choice for GB/GBC),
// backend_mgba.c (Game Boy Advance SIO, and GB/GBC as a fallback, on libmgba), backend_melonds.cpp (Nintendo DS local
// wireless between N melonDS instances with a deterministic MP layer). 3DS later.
#ifndef LINKBACKEND_H
#define LINKBACKEND_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

#define LINK_MAX_SEATS 4

/**
 * One seat's input for one frame, the same 32 bits on every system and on the wire:
 *   bits 0–9   A, B, Select, Start, Right, Left, Up, Down, R, L   (the GBA's KEYINPUT order; GB uses bits 0–7)
 *   bits 10–11 X, Y (DS)
 *   bit  12    touch pressed (DS)    bits 16–23 touch x (0–255)    bits 24–31 touch y (0–191)
 */
typedef uint32_t link_input;
#define LINK_KEY_A (1u << 0)
#define LINK_KEY_B (1u << 1)
#define LINK_KEY_SELECT (1u << 2)
#define LINK_KEY_START (1u << 3)
#define LINK_KEY_RIGHT (1u << 4)
#define LINK_KEY_LEFT (1u << 5)
#define LINK_KEY_UP (1u << 6)
#define LINK_KEY_DOWN (1u << 7)
#define LINK_KEY_R (1u << 8)
#define LINK_KEY_L (1u << 9)
#define LINK_KEY_X (1u << 10)
#define LINK_KEY_Y (1u << 11)
#define LINK_TOUCH (1u << 12)

struct link_seat_config {
  const char *rom;         // path of this seat's game (the partner's rebuilt locally, checked by SHA-1 by souldew)
  const uint8_t *save;     // battery save bytes or NULL (a new cartridge)
  size_t save_len;
  const char *state;       // the player's running game as the fast player's core saved it (export_state's format), or NULL
  const char *model;       // Game Boy family: "dmg" (the original Game Boy) or "cgb" (Game Boy Color, the default); NULL
};

struct link_backend {
  const char *name; // "mgba"
  /** After open: "gba" | "gb" | "nds" … */
  const char *(*system)(void);
  /** Can this backend run `rom`? (by file contents / header) */
  bool (*probe)(const char *rom);
  /**
   * Start `n` seats joined by the link. `rtc_ms`: the shared start time of every cartridge / console clock (Unix ms) –
   * the clocks then advance with emulated time only. Returns false (and logs why) when it can't.
   */
  bool (*open)(int n, const struct link_seat_config *seats, int64_t rtc_ms);
  /** The inputs of every seat for the next frame. */
  void (*set_input)(int seat, link_input in);
  /** Run one session frame: every console starts exactly one more frame (consoles may run ahead inside it). */
  void (*run_frame)(void);
  /** The seat's current picture as 0x00BBGGRR pixels, `*w` × `*h`, row length `*stride` pixels. */
  void (*video)(int seat, const uint32_t **px, unsigned *w, unsigned *h, unsigned *stride);
  /** The frame rate of the system (frames per second). */
  double (*fps)(void);
  /** The seat's battery save (malloc'd copy, caller frees); returns its size. */
  size_t (*sram)(int seat, void **out);
  /** A hash of everything that must be equal on every peer (RAM, CPU registers, clocks) of every seat. */
  uint64_t (*hash)(uint64_t h);
  /** Bus access for the live reader, cheats in tests and READ / POKE. */
  uint8_t *(*mem)(int seat, uint32_t addr, uint32_t len);
  uint8_t (*read8)(int seat, uint32_t addr);
  void (*write8)(int seat, uint32_t addr, uint8_t v);
  /** Whole-session save states (every seat and the link between them): rejoin / desync recovery. */
  size_t (*state_size)(int seat);
  bool (*save_state)(int seat, void *out);
  bool (*load_state)(int seat, const void *in, size_t len);
  /**
   * Sound: the output rate (stereo frames per second; 0 = silent) and the seat's sound since the last call – up to
   * `max` interleaved stereo s16 frames into `out`, returns how many. Every seat makes its sound the same way on every
   * peer (it must not change what the consoles compute); souldew plays only the local seat's.
   */
  double (*sample_rate)(void);
  size_t (*audio)(int seat, int16_t *out, size_t max);
  /**
   * Optional: the battery save as souldew keeps it on disk, when that is more than `sram` (a Game Boy clock cartridge:
   * the save memory + the 48-byte clock footer). `sram` stays what tells whether the game saved.
   */
  size_t (*battery)(int seat, void **out);
  /**
   * The seat's console as the fast player's core (native/retro-host on the libretro core of the same emulator, the same
   * version) saves and loads it – a link session starts from the players' running games (link_seat_config.state) and
   * hands each player's console back the same way when it ends (docs/MULTIPLAYER.md › "Seamless"). malloc'd, caller
   * frees; 0 = not now (a DS console waiting mid-frame for a wireless packet).
   */
  size_t (*export_state)(int seat, void **out);
};

extern const struct link_backend link_backend_mgba;
extern const struct link_backend link_backend_sameboy;
extern const struct link_backend link_backend_melonds;

/** Shared helpers from linkhost.c */
void link_log(const char *fmt, ...);
void *link_read_file(const char *path, size_t *n);
/** fopen for UTF-8 paths (Windows: _wfopen) – every file the backends open themselves goes through it. */
FILE *link_fopen(const char *path, const char *mode);
uint64_t link_fnv(uint64_t h, const void *p, size_t n);

#endif
