# Multiplayer: trades, battles and a shared world

Status: **every generation from Gen 1 to Gen 4 links in the app – without restarting anybody's game** (15 November 2026, branches `feat/multiplayer` and `feat/mp-seamless`; §1, §4a). This document is the plan for souldew 3.0: players of a run (and friends they invite) trade Pokémon and battle each other **the authentic in-game way** (Cable Club, Colosseum, Union Room), and see each other walking around in their own games.

There are no public lobbies. Multiplayer happens between the players of a run, over the peer channel the run already has.

Contents:
1. [What works today](#1-what-works-today)
2. [Architecture](#2-architecture)
3. [The link host and its backends](#3-the-link-host-and-its-backends)
4. [Session lifecycle](#4-session-lifecycle)
5. [Netcode: input delay, hashes, reconnect](#5-netcode)
6. [Transport: peer channel, TURN](#6-transport)
7. [Saves, ROMs and the tracker](#7-saves-roms-and-the-tracker)
8. [Per generation: what works, what's missing, effort](#8-per-generation)
9. [Shared World: partners walking in your game](#9-shared-world)
10. [SoulLink rules and UX](#10-soullink-rules-and-ux)
11. [Licences and legal](#11-licences-and-legal)
12. [Measurements](#12-measurements)
13. [Plan and effort](#13-plan-and-effort)
14. [Decisions for the owner](#14-decisions-for-the-owner)

---

## 1. What works today

Status on 15 November 2026 (branch `feat/multiplayer`, after merging the GB/GBC and DS spikes). Measured on an M-series Mac with retail ROMs copied into a scratch folder; ROMs and saves are not in the repo.

**The app, end to end** (`scripts/link-e2e.mjs`: two to four souldew servers with scratch data folders, one run created on the first and joined on the others, every page in Electron, muted). The real flow runs: the board's invite, join, every seat's game found by SHA-1 (or picked), saves over the run's peer channel, `go`, both play views on the link session, buttons over the mesh, hashes, write-back, log. Only the buttons come from a recording of the same trade or battle (each host plays its own seat's column, `SLS_LINK_TEST_SCRIPT`, test-only), so the outcome is known: **every check below compares each player's run save after the session with the save the recording produced, byte for byte.**

| Gen | Game(s) | Trade | Battle | Notes (all with sound reaching the page) |
|---|---|---|---|---|
| 1 | Red ↔ Red (SameBoy) | ✅ saves as recorded, logged | ✅ Colosseum, saves as recorded | a gap healed by NEED/resend in the trade run |
| 2 | Crystal ↔ Silver (SameBoy) | ✅ saves as recorded | ✅ Colosseum in the same session, saves as recorded | different games in one run: each picked the other's copy by SHA-1; this run found that a battle in a "trade" session counted deaths and failed the run – fixed: nothing a link session shows is applied to the run |
| 3 | Emerald ↔ Sapphire (mGBA) | ✅ saves as recorded, logged | ✅ Colosseum single battle (Emerald wins; the battle record is in both saves) | different games: "Pick your copy" (a wrong file refused by SHA-1) |
| 3 | 4 players on 4 computers: Emerald, Sapphire, Emerald, Sapphire | | ✅ Multi Battle (2 vs 2), all four saves as recorded | "Link all of us (4)"; 4 hosts × 4 GBAs in lockstep over the mesh |
| 4 | Platinum ↔ Platinum (melonDS) | ✅ Union Room trade, saves as recorded | ✅ Union Room 2-vs-2 battle, saves as recorded | sign: "Union Room" |
| 4 | 4 players on 4 computers, Platinum ×4 | ✅ Union Room: all four see each other, seats 1 and 4 trade while 2 and 3 stand by – all four saves as recorded | | 4 hosts × 4 DS consoles on one loaded Mac: ~40 fps (the hosts ran as fast as they could); gaps healed by resends |

| Robustness | Result |
|---|---|
| Rejoin (GBA) | Emerald ↔ Sapphire: B's page reloaded at frame ~7,060 (in the Trade Center); A waited ("waiting for Tim … they can rejoin"); B's page offered "Rejoin" and came back from A's state ~130 frames later; **the trade still finished with both saves as recorded** (run twice, the second time with the state carrying every seat's known buttons). |
| Rejoin (DS) | Platinum in the Union Room: refused as designed – the consoles are always mid-exchange there, so no state can be taken ("the others' games are in the middle of a wireless exchange"); the link then ends for both (fixed after this run: A kept waiting). |
| Desync | B's host started with another clock (Emerald reads it): mismatch at frame 120 on both, **both run saves back to the pre-session save**, the session's last save kept as `….link-<date>.sav` on both (first run found a double restore when both sides saw it at once – fixed). |
| Sound | The local seat's sound reaches the page in every run (`audioIn > 0`). |
| Location sign | "Trade Center", "Colosseum", "Cable Club", "Union Room" instead of "Pokémon League" / "Ferry" / nothing. |
| Direct / relayed | The bar shows "direct · 1 ms" (both on one Mac); TURN servers come from the Worker (checked against the real key). |

**Seamless – from the running games, no restart** (§4a; `link-e2e.mjs --seamless`, branch `feat/mp-seamless`). Each player is in the middle of their game in the fast player – a state of a recorded session's moment F, loaded while paused (`--state1/2`); with `--prestep 4` it is F−4 and four frames run in the fast player, so the picture is the game's – then invite/accept on the board, the session runs the recording's tail from F, both leave. Checked every time: the session started from **both running games** (`seamless`, the first picture after "Linking…" is the link session's), the **same player page** before and after (a mark in it survives – no reload, no new canvas), equal hashes all along, each game **goes on alone** afterwards (the fast player's core again, frames advancing, the same page), and the run saves against the recording:

| Gen | Game(s), moment F | Result | "Linking…" (snapshot → first linked picture) | Back alone (leave → first solo picture) |
|---|---|---|---|---|
| 1 | Red ↔ Red trade, F = 1500: both at the Cable Club receptionist, mid-text ("Please appl…") | ✅ saves as recorded, logged; the text goes on in the session | 106 ms | 90–94 ms |
| 1 | the same with `--prestep 4` | ✅ trade done, logged; the save differs from the recording in the play-time frame counter (1/60 s) only – the 4 frames ran in the fast player, without the link host's 61 ppm clock offset of seat 1 | 350 ms¹ | 72 ms |
| 3 | Emerald ↔ Sapphire trade, F = 1707 (prestep 4): both standing in the Pokémon Center 2F | ✅ saves as recorded, logged; afterwards the trade menu goes on alone (the recording ends there) | 433–462 ms¹ | 97–128 ms |
| 3 | Emerald ↔ Sapphire Colosseum battle, F = 1700 (prestep 4): both talking to the attendants ("Which Battle Mode…") | ✅ saves as recorded (Emerald wins, battle record in both saves); afterwards both in the Pokémon Center 2F after saving, playing on | 445–449 ms¹ | 123–127 ms |
| 4 | Platinum ↔ Platinum Union Room trade, F = 3000 (prestep 4, the fast player's JIT ran those frames): both at the attendant's "save the game?" | ✅ saves as recorded (no log entry – the known Gen 4 gap, §13); afterwards in the Union Room alone | 1.2–3.2 s (1.29 s¹) | 0.67–0.89 s |
| 3 | Emerald ↔ Sapphire, out of step (B's host on another clock) | ✅ (B's host given another state for A's seat – test-only, `--desync-state`; a game in the middle of a trade may never read its clock, so the old clock trick doesn't trigger here): mismatch at frame 120, both run saves back to before, backups kept, **each game back at the moment it was linked from**, going on alone, same page | 198 ms | |
| 3 | Emerald ↔ Sapphire, B's peer link cut at frame 3,000 (in the Cable Club), both leave | ✅ both hosts stood still (each waits for the other's buttons), both left: **each goes on alone from its own console as it was** (in the Cable Club – the game then shows its link error, as with a pulled cable), same page | | 109–111 ms |

¹ measured before the round trips were moved in front of the snapshot (they used to overlap with it – and a DS state on the channel made the round trip look like 570 ms, delay 25); since then the game stands still only for the snapshot, the transfer and the start (Gen 1: 106 ms).

**The link host alone** (headless, `--script`/`--bench`): every recording replays to byte-identical saves (Red trade and battle, Crystal/Silver trade+battle 41,838 frames, Emerald/Sapphire trade, battle and 4-player multi battle, Platinum trade, battle and 4-console Union Room). Whole-session states load into a fresh host and go on identically (GBA at frames 3,000–11,111, GBC at 15,001 and 30,003, DS at 12,001 in the Union Room): the basis of rejoin. Network lockstep (`scripts/link-net-test.mjs`) as before: 0 mismatches.

| Platform | Link host |
|---|---|
| macOS arm64 | built and tested (`test/linkhost.test.mjs`, all e2e runs) |
| Windows x64 | cross-compiled and linked with MinGW here (only Windows DLLs); not run on Windows yet |
| Linux x64 | `native.yml` builds it (RGBDS from source); in an Ubuntu 22.04 container mGBA and SameBoy built, the melonDS step stopped on a full disk on the build machine – the CI run is the check |

Still open for 3.0: see §13.

## 2. Architecture

The design is hybrid. Players play apart, asynchronously, as they always do. **A link session is deterministic lockstep for the few minutes of a trade or battle.** This is the one good idea to take from linkcable.app. Its GBA-PK memory hooks are not used: they need per-ROM address tables, break on randomizers and are CC BY-NC.

```
 page (Preact, play view)                local server (Node)                 link host (C, native)
 ┌───────────────────────────┐   HTTP   ┌──────────────────────────┐ stdio ┌──────────────────────────────┐
 │ board: "Trade with Tim"   │─────────▶│ /api/link/start          │──────▶│ linkhost --rom seat0 seat1   │
 │ link session (web/lib/    │◀─stream──│ verifies every seat's ROM│◀──────│   --sram … --local k --net   │
 │   linksession.mjs)        │   cmd    │ (SHA-1), saves in/out    │       │ backend: mGBA (GBA), SameBoy │
 │ fast player shows seat k  │─────────▶│ NativeSessions (same     │       │   later melonDS (DS)         │
 └─────────────┬─────────────┘          │ stream/cmd as retrohost) │       │ all seats, one thread,       │
               │ Trystero action 'link' └──────────────────────────┘       │ input-delay lockstep, hashes │
               ▼  (WebRTC data channel, TURN fallback, encrypted)          └──────────────────────────────┘
        partner's page ⇄ partner's server ⇄ partner's link host (runs the same seats)
```

- **Every peer runs every seat.** The partner's ROM is rebuilt locally from base ROM + patch + seed (`server/lib/build.mjs` builds all slots by default and records each SHA-1). The partner's battery save travels over the run's encrypted channel. After that, only buttons travel.
- **The host's picture is the local seat.** Its RAM mirror is the local seat too, so live tracking and the board keep working during the session, and the traded-in Pokémon appears like any other.
- **The link host speaks retrohost's protocol.** It uses the same VIDEO, RAM, SRAM and EVENT messages, with a few more for linking. That means the fast player page (`web/lib/nativeplayer.mjs`) can show a link session almost unchanged, and the server reuses `NativeSessions`.

## 3. The link host and its backends

`native/link-host/` is built by `npm run native` (`scripts/build-native.mjs`, part `link`). The output is `tools/native/<platform>/linkhost`.

| File | Role |
|---|---|
| `linkhost.c` | The **session**, shared by every system: protocol, frame pacing, input-delay lockstep, RAM hashes, battery saves, live-tracking RAM, session save states, record/replay for tests. |
| `linkbackend.h` | The **backend interface** each system implements. |
| `backend_mgba.c` | GBA SIO (link cable: multiplayer and normal modes, 2–4 GBAs) on libmgba; GB/GBC as a fallback (`--backend mgba`). |
| `backend_sameboy.c` | GB/GBC serial link cable (2 consoles) on SameBoy (MIT): Gen 1/2 Cable Club, the first choice for GB/GBC. |
| *(every backend)* | `export_state` and `link_seat_config.state`: a seat starts from the player's running game and hands the console back in the fast player's state format (§4a). |
| `backend_melonds.cpp` | DS local wireless between up to 4 melonDS instances (melonDS's core library, interpreter only) with a deterministic MP layer: Gen 4/5 Union Room. Details: [MULTIPLAYER-DS.md](MULTIPLAYER-DS.md). |
| *(later)* 3DS | Azahar rooms, or two instances. Research. |

### Backends

A backend runs **all seats in this process**, joined by the system's link, and must be deterministic: the same ROMs, saves, start time and per-frame inputs give bit-identical consoles on every peer. That means no threads racing the emulation, no wall clock and no uninitialised memory.

```c
struct link_backend {
  const char *name;                                   // "mgba"
  const char *(*system)(void);                        // "gba" | "gb" | "nds" … (after open)
  bool (*probe)(const char *rom);                     // can it run this game?
  bool (*open)(int n, const struct link_seat_config *seats, int64_t rtc_ms); // rom, save bytes, (test) state per seat
  void (*set_input)(int seat, link_input in);         // inputs for the next frame
  void (*run_frame)(void);                            // every console starts exactly one more frame
  void (*video)(int seat, const uint32_t **px, unsigned *w, unsigned *h, unsigned *stride);
  double (*fps)(void);
  size_t (*sram)(int seat, void **out);               // battery save copy
  uint64_t (*hash)(uint64_t h);                       // what must be equal on every peer (RAM, registers, clocks)
  uint8_t *(*mem)(int seat, uint32_t addr, uint32_t len);   // live reader
  uint8_t (*read8)(int seat, uint32_t addr); void (*write8)(int seat, uint32_t addr, uint8_t v);
  size_t (*state_size)(int seat); bool (*save_state)(int seat, void *out); bool (*load_state)(int seat, const void *in);
};
```

**Input format.** There is one `link_input` (u32) per seat and frame, on every system and on the wire:
- bits 0–9: A, B, Select, Start, Right, Left, Up, Down, R, L (the GBA KEYINPUT order; GB uses bits 0–7)
- bits 10–11: DS X and Y
- bit 12: touch pressed
- bits 16–23: touch x; bits 24–31: touch y

The page keeps sending retrohost's INPUT message (libretro joypad bits plus pointer). The session converts it.

**How the mGBA backend stays deterministic in one thread.**
- mGBA's master branch rewrote the GBA lockstep driver. Its `sleep`/`wake` callbacks are flags (the Qt frontend pauses threads with them).
- The scheduler steps every awake console event by event (`runLoop`) until each has started one more frame. Consoles the driver put to sleep wait. A console that has finished its frame runs on while a slower one needs it.
- The order is fixed, so the result is the same on every peer.
- GB serial uses mGBA's older lockstep (signal/wait/cycle budgets), driven the way mGBA's `MultiplayerController` drives it, with flags instead of thread pauses.
- Cartridge clocks use `RTC_FAKE_EPOCH`: one shared start time, then emulated time only.
- libmgba is pinned to a commit. Every peer must run the same build; the session's version check (§4) enforces this.

**How the SameBoy backend (GB/GBC) works.**
- **The cable.** SameBoy's bit-level serial interface, as its own two-Game-Boy mode wires it. When a console driving the clock (SC bit 0, internal) starts a bit, `bit_start` keeps the bit it shifts out. When the bit ends, `bit_end` returns the partner's outgoing bit (`GB_serial_get_data_bit`) as the master's incoming bit and shifts the master's bit into the partner (`GB_serial_set_data_bit`). The partner's SB/SC and serial interrupt then behave as on an externally clocked Game Boy. Either side can be master; Pokémon decides at run time. Bit timing is the hardware's (8 kHz internal clock; CGB fast clock included).
- **One thread, interleaved.** The console that is behind in emulated time runs the next instruction (`GB_run`), ties to seat 0. The two are never more than one instruction apart. A session frame is a fixed slice of emulated time (70,224 clocks), not "until VBlank": a console with the LCD off can't hold the session up, and both take their buttons at the same emulated moment on every peer. The picture is the last finished frame (copied on VBlank).
- **Clock drift on purpose.** Seat 1's clock runs 1/16384 (≈ 61 ppm) fast, within real crystals' spread. Two emulated consoles at exactly the same speed stay phase-locked. When both players talked to Gen 1's receptionist on the same frame, both sent "I'll drive the clock" at the same instant on every retry and the link never came up. With the drift it connects. It is deterministic and invisible to the games.
- **No wall clock.** The core's `time()` is redirected at build time to the session's start time plus emulated seconds: a header included before each core file (`sbl_time.h`: `<time.h>`, then `#define time(t) sbl_time(t)`). `-Dtime=sbl_time` would have renamed MinGW's inline `time()` in `<time.h>` itself and left the wall clock in place on Windows. The MBC3 clock (Gold/Silver/Crystal) runs on emulated cycles (`GB_RTC_MODE_ACCURATE`). Power-on RAM comes from a fixed seed per seat. Sound is on for every seat alike (48 kHz; the rate only shapes the output), only the local seat's is played.
- **Saves and the cartridge clock.** souldew keeps a clock cartridge's save as the battery RAM plus the 48-byte VBA-M clock footer (5 + 5 × u32 registers, u64 Unix second) – the format mGBA, VBA-M and SameBoy use. The fast player (retrohost on Gambatte) now writes and reads that footer through `RETRO_MEMORY_RTC` (Gambatte's 8-byte base time), so the in-game clock survives closing the game, and the link host takes it in and gives it back the same way (`battery()` in the backend interface). A save without a footer (older runs) gets a clock at day 0 at the session start; otherwise SameBoy would flag a reset clock and Crystal would ask for the time.
- **Model.** Every seat is a Game Boy Color (CGB-E) with SameBoy's own CGB boot ROM (MIT, assembled from source with RGBDS and embedded). DMG games get the CGB boot ROM palettes, as on hardware.
- **Memory for the live reader.** `0xC000–0xDFFF` is WRAM bank 0 + bank 1 (where the Gen 1/2 party lives, like `[0xc000, 0x2000]` in `server/lib/native.mjs`). `0xA000` is the cartridge RAM's current bank, plus VRAM and HRAM.
- **Pinned.** SameBoy v1.0.5. Every peer must run the same build.

**Protocol.** The full list is in the header of `linkhost.c`. On top of retrohost's messages:

| Message | Payload | Meaning |
|---|---|---|
| host → `12 LINPUT` | `u32 seat, u32 first, u32 inputs[]` | The local seat's inputs, to send to the peers. |
| host → `14 SEATSRAM` | `u32 seat, bytes` | Every seat's battery save (on FLUSH). |
| EVENT `hash` | `{frame, hash}` | Every 120 frames. |
| EVENT `wait` | `{seats, frame, ms}` | Stalled for a peer. |
| → host `21 RINPUT` | `u32 seat, u32 first, u32 inputs[]` | A peer's inputs. Repeats and out-of-order frames are fine. |
| → host `20 VIEW` | `u32 seat` | Show another seat (tests, spectating). |
| → host `24 UNTIL` | `u32 frame` | Pause at an absolute frame, the same on every peer. |
| → host `22 READ` / `23 POKE` | — | Tests only (the server never forwards POKE). |
| → host `25 NEED` | `u32 seat, u32 from` | A peer missed a seat's buttons: this host sends what it knows (LINPUT). Any peer may answer for any seat. |
| → host `3 SAVE` → `5 STATE` | — | A whole-session state for a partner who rejoins: every console, then `'LSES'` and the frame. Empty = "not now" (DS: a console waits mid-frame for a packet). |
| `--load <state>` | — | Start from such a state (rejoin). mGBA's states include the lockstep driver's own state and the battery save; melonDS's include the wireless layer's queues. |
| `--state <file>` per seat | — | Start that seat from the player's running game (the fast player's save state, §4a) instead of booting it from its battery save. |
| → host `26 SEATSTATE` → `15 SEATSTATE` | `u32 settle` → `u32 seat, bytes` | The local seat's console in the fast player's format, after the session's end (§4a); a DS console that can't be written down yet runs on alone up to `settle` frames. Empty = not possible. |
| `--export <dir>` (with `--bench`) | — | Every seat's console in that format → `seat<k>.state` (tests: a "mid-game" moment from a recording). |
| host → `3 AUDIO` | stereo s16 | The local seat's sound at the loaded event's `sampleRate` (only at normal speed). |
| → host `1 INPUT` | 17 bytes | Buttons plus the pointer: over the DS's lower screen it becomes the touch bits (a tap lasts at least 4 frames). |

**Builds.** `scripts/build-native.mjs` builds the one `linkhost` with all three backends on macOS, Linux and Windows (MinGW-w64, static: only Windows' own DLLs). libmgba is built with `LIBMGBA_ONLY` (no epoxy needed on Windows) and without LTO (slim LTO objects in a MinGW archive have no symbol index). melonDS's core without JIT, OpenGL and GDB stub. RGBDS is needed at build time for SameBoy's boot ROM; `native.yml` builds it from its tag (v1.0.4). The Windows `linkhost.exe` is cross-compiled and linked here; it has not been run on Windows yet.

## 4. Session lifecycle

1. **Invite.** On the board, Marius clicks "Trade with Tim" (or "Battle"). His page sends `link-invite {id, kind, system, seats:[{slot, romSha1, saveSha1}], hostVersion, backend, rtc}` over the run's channel. Tim's page shows "Marius wants to trade – Join / Not now". It's an explicit opt-in; the run's rule (§10) must allow it.
2. **Check.** Each peer checks that it can produce **every seat's ROM**: its own from the run folder, the partner's from `manifest.outputs[slot]` with SHA-1 = `romSha1`, rebuilt if missing. It also checks the same link host version and backend.
   - If any check fails, the peer answers `link-refuse {reason}`. Examples: "Tim's game isn't built here – build it (2 min)" or "update souldew".
3. **Save.** Both players save in game. Gen 3 asks for it at the Cable Club counter anyway, but the session boots from the battery save, so the current one counts. souldew flushes the battery save (FLUSH → SRAM).
   - Each peer sends its save: `link-save {slot, sha1, bytes (deflate, base64, chunks ≤ 12 KB)}`. Each peer verifies the SHA-1.
4. **Start.** The initiator picks `rtc` (its clock, ms) and the input delay from the measured RTT (§5), then sends `link-go {delay, rtc}`.
   - Each server starts `linkhost --rom <seat0> --rom <seat1> --sram … --local k --net --delay D --rtc R --ram …` and replaces the single-player session.
   - The page shows the local seat in the fast player.
5. **Play.** Both games boot from their saves (title screen, then Continue) – or, since §4a, a game that was running goes on from its state, no boot. The players walk to the Pokémon Center 2F and use the Cable Club as on real hardware. Inputs and hashes flow (§5). The tracker reads the local seat live.
6. **End.** Either player clicks "Leave", or the game is back in the overworld and the players walk out (souldew suggests leaving once both have saved). `link-bye {frame}` is sent and both hosts stop at the same frame (UNTIL).
   - Each server takes its **own seat's** battery save (SRAM / SEATSRAM) and writes it into the run (§7). The partner's save copy is discarded.
   - Single-player play resumes from the new save – since §4a without a restart: each player's console goes on alone from where the session left it.

What if a player quits mid-trade? Gen 3 saves before a trade and again after it. A session cut in between leaves both players with their pre-trade save, which is the cartridge behaviour: nobody loses or duplicates a Pokémon.

### 4a. Seamless: linking a running game, no restart

Since November 2026 (branch `feat/mp-seamless`) a link session no longer reboots anybody's game. You're playing, you click Trade/Battle (or accept an invite), your game stands still for a moment ("Linking…" over the picture), and it goes on **where it was – now linked**; when the link ends it goes on alone from exactly where the session left it. Steps 3, 5 and 6 above change like this:

1. **Snapshot** (`web/lib/linksession.mjs` `_maybeSnap` → `_sendSave`, once every player has every seat's game – a partner who still has to pick or build one doesn't keep the others' games standing – and after the inviter measured the round trips: it says `snapnow`, because a few MB on the channel would make every ping look slow; the first DS run measured 570 ms instead of 1 and picked an input delay of 25 frames). When this player's game of the run runs in the fast player (`ownGame()`), the page pauses it and takes its save state (`__emu.linkSnapshot()`: SPEED 0, then SAVE – the host takes commands between frames, so the state is at a frame boundary, and it is what the picture shows). It goes to every partner as `snap {slot, sha1, i, n, data}` (deflate-raw, base64, 12 KB parts, the run's encrypted channel); the battery save follows as before, its `save` message naming the snap (`state: sha1`). A player whose game isn't running (on the board, in the browser emulator) sends no snap: that seat boots from its battery save as before – mixed sessions are fine.
2. **Start from states.** `go` waits until every seat's save and snap are at the inviter **and** every partner said `got` (they're at every partner too – an inviter that started its host early only stood and waited, and its busy page slowed the rest of its own snap to the others: DS 4 s instead of 1.2 s). Every server gets the same snaps (`/api/link/start` `seats[i].state`, deflated, SHA-1-checked after inflating) and starts `linkhost … --rom <seat> --sram <save> --state <snap>` per seat: each backend boots the seat with its battery save, then loads the state (`link_seat_config.state`). Every peer loads the same bytes into the same build, so the consoles are identical – the hash checks (§5) compare them from frame 120 on, as before.
3. **The same picture.** The page's player (`playernative.html`) is never replaced: `__emu.attachLink(id)` switches its stream from the fast player to the link host; the canvas keeps the last picture until the session's first one arrives, the RAM mirror keeps its contents (the live reader never sees an empty party), the sound continues (a new rate restarts the audio context). The play view keeps its session (`target.link` is set on the running one) – pause, speed, save states and cheats are blocked during the link as before.
4. **Back alone** (`__emu.resumeSolo()`, from `_end`). Once the session is over: FLUSH (the session's last battery save of this seat, SEATSRAM), then `SEATSTATE` – the link host writes this seat's console in the fast player's format (`export_state`). The page starts the fast player again with that state and save (`/api/native/start` `state` → `retrohost --state`, loaded before the first frame) and switches the stream back. The battery save goes into the run as every save does (`emu-saved`). A partner who dropped out doesn't matter: each one goes on from their own console as it is. A DS console that waits mid-frame for a wireless packet can't be written down; then the link host runs on alone (nothing pressed – the session is over) up to 300 frames until it can.
5. **Out of step** (a desync): the run's save goes back to the pre-session one as before (`/api/link/restore`, backup kept), and the game goes back to **the snapshot it was linked from** – the player continues from where they were before the link, nothing of the session counts.
6. **Edge cases.** An invite can be accepted anywhere – in a menu, mid-dialogue, in a battle: the state is taken there and the session starts there; the players walk to the Cable Club / Union Room themselves (they're simply linked now). Gen 1–3 need the link only inside the club rooms; leaving the link while inside one is like pulling the cable (the game shows its link error, Gen 3 needs a soft reset) – leave after walking out, as the bar suggests. A session started from the board (no game running here) boots from the save as before, and goes on alone afterwards too (the link player page carries the game for that).

**Formats – one emulator version on both sides.** A state only loads into the emulator (and version) that wrote it, so the fast player's cores are now built from the link host's sources:

| System | Fast player (libretro) | Link host | State |
|---|---|---|---|
| GBA | mGBA at the link host's commit `d58ea8a` (was the 0.10.5 release) | libmgba `d58ea8a` | mGBA's `mCoreSaveStateNamed` (the libretro core's own); into the link host with the battery save and clock extras, back out with the battery save, without the clock (the fast player's cartridge clock follows the computer's again). 0.10.5 can't load states of this version ("too new") – hence the same commit. Older 0.10.5 save states still load in it. |
| GB / GBC | **SameBoy v1.0.5** (was Gambatte) | SameBoy v1.0.5 | `GB_save_state_to_buffer` both ways. Gambatte's states can't become SameBoy's (different internals; a converter through SameBoy's BESS format could only go one way). |
| DS | melonDS DS v1.4.0 (JIT) | melonDS `16f127d` (the commit melonDS DS v1.4.0 builds, interpreter) | melonDS's own `DoSavestate` (the link host adds its wireless layer's part for rejoin; the fast player gets melonDS's part only). JIT or not doesn't change the format. |

All three were checked headless both ways and frame-exact: a recorded session's seats exported at frame F (`linkhost --bench F --export dir`), loaded into the fast player, saved back by it while paused, then loaded into a fresh link host with the recording's tail – the battery saves at the end are byte-identical to the original session's (Emerald/Sapphire trade and battle, Red trade and battle, Platinum Union Room trade; the tail's hash equals the uninterrupted run's).

**Decision: SameBoy for the fast player's Game Boy (MIT).** The cleanest of the three options:
- *The link host as the Game Boy player all the time* would have meant re-building everything the fast player does (fast-forward sound, cheats, save-state slots, RESET, a save given late) in the link host – and Gambatte's save states would be gone just the same.
- *Converting* Gambatte ↔ SameBoy states isn't sound (PPU/APU/timer internals differ; only Gambatte → SameBoy through BESS would be thinkable, never back).
- *SameBoy's libretro core* is the link host's emulator at the same version, more accurate than Gambatte, and MIT (no GPL-2-only part in the bundle any more). Impacts, all handled: every game runs on a **Game Boy Color (CGB-E)** as in the link host – Red/Blue/Yellow get the Game Boy Color's palettes (as on a real GBC), Gold/Silver/Crystal look the same; the GBC boot ROM is SameBoy's fast one (no logo animation – a boot ROM is no part of a state, so the link host's full one doesn't matter); live tracking reads WRAM banks 0+1 as before (the system RAM, `0xC000` + 8 KB, the same layout the link host has); cheats are RAM writes and don't care; battery saves are the same bytes; **the cartridge clock** – retrohost converts SameBoy's RTC section (registers, latched registers, the Unix second it last caught up to) to and from the 48-byte VBA-M footer souldew keeps (`test/native.test.mjs`: a save whose clock read 3 days 4:05 ten minutes ago reads 3 days 4:15) – SameBoy runs the clock on the computer's time (`sameboy_rtc: sync to system clock`), the link host on emulated time from the state's clock, and the fast player catches up after the session; its sound at 48 kHz (retrohost now answers `GET_TARGET_SAMPLE_RATE` – SameBoy would make 2 MHz otherwise). **Lost:** save states made with the older Gambatte fast player (`gambatte-native`) aren't offered for GB runs any more (another core's, like the browser emulator's); battery saves and the clock carry over.

**Determinism from live states.** Everything that must be equal on every peer is in the states or agreed: RAM, CPU, timers, RNG state (all in the console state), the battery save (in the state for all three systems: mGBA's extdata, SameBoy's MBC RAM, melonDS's cartridge), the cartridge/console clock (GBA: the agreed `rtc` with mGBA's fake epoch, as before – Emerald's clock moves to the inviter's, a few ms off; GB: the RTC registers in the state, then emulated time; DS: the RTC in the state, then emulated time), the core options (the link host's own, the same on every peer), and the frame alignment (every seat's state is at its own frame end; the session counts its frames from 0 from there). The link hosts' own extras (the GBA lockstep driver, SameBoy's cable bit, the DS wireless queues) start fresh – no link is up at a snapshot (nobody is in a Cable Club exchange or a wireless exchange before the session runs).

## 5. Netcode

**Input-delay lockstep, no rollback (for now).**
- The local input for frame *f* is taken at frame *f − D* and sent right away.
- Frame *f* runs only when every seat's input for *f* is known.
- Delay: `D = clamp(ceil(RTT/2 · 1.25 / 16.7 ms) + 3, 4, 60)`. That is 4 frames on a LAN and 6 at 80 ms (~100 ms felt latency). Menus, trades and turn-based battles tolerate this well.
- At the measured rate (§12), a session at 80 ms RTT can run 2.5× faster than real time, so 1× never stalls.

**Pacing.** Each host paces itself at 59.73 fps and waits when inputs are missing. Both start from the same frame (inputs for frames < D are "nothing pressed" for everyone). A host that falls behind never makes the other run faster: the other one simply waits.

**Desync detection.**
- Every 120 frames (2 s) each host emits `hash`: an FNV-1a over every seat's work RAM, CPU registers and timing. The page sends it as `link-hash`.
- On a mismatch: stop both hosts at once, show "The games fell out of step – the session ended, nothing was saved", and keep the pre-session saves.
- On the same build this never happened in testing. A mismatch means different builds, a bug, or a tampered client.

**Recovery and reconnect (built):**
- **Gaps.** A host that waits for a seat emits `wait {seats, frame}`; the page asks every partner `need {s, f}`, and each partner's host answers from its ring of 4096 frames (`NEED` → `LINPUT` → `in`). Any peer can answer for any seat. Seen in the e2e as one natural gap healed without anybody noticing.
- **Rejoin.** A page that went away while its session ran (reload, crash, app restart) finds the session in `localStorage` (30 min) and offers "Rejoin". The partner with the lowest seat among those still in asks its host for the whole-session state (`SAVE`; the hosts all stand still at the first frame the missing seat's buttons are missing), deflates it and sends it in parts; the rejoiner's server starts its host with `--load`. The state carries every seat's battery save, the GBA lockstep driver's state and the DS wireless queues, so it works in the middle of a Cable Club or Union Room visit. A DS console that waits mid-frame for a wireless packet can't be written down: then the others answer `state-busy` and the link ends ("only outside a wireless exchange").
- **Desync.** Equal hashes are compared every 120 frames. A difference ends the session for everybody, and **both players' run saves go back to what they were before the session** (`/api/link/restore`; the session's last save stays next to it as `….link-<date>.sav`), so nobody keeps a Pokémon the other didn't lose. The bar explains it.

**Four players (runs have up to 4).** The session and the network layer are built for N ≤ 4 seats.
- **Who is in a session.** Any subset of the run's players. A trade is 2 seats: any 2 of the 4 can start one while the others keep playing, since each player's own game runs on their own computer and isn't part of the session. Multi battles (Emerald, FR/LG) and Record Mixing take 3–4 seats. Several sessions in one run at the same time are fine: P1+P2 trade while P3+P4 battle, each with its own `sid` and its own link host per computer.
- **Topology: a full mesh for inputs, no clock master.**
  - Every peer sends its own seat's inputs to every other seat of the session over the run's WebRTC mesh (Trystero already is a full mesh).
  - Every host waits for whatever inputs it lacks, so there is no master, and no host whose departure stops the clock for the others in a special way.
  - A star with the inviter as relay would add one hop of latency for the non-host pairs and make the inviter's upstream the bottleneck; with ≤ 4 peers the mesh is ≤ 3 connections per peer at ~3 KB/s each.
  - The inviter is only the **coordinator** of the start: it collects the accepts, measures the RTTs, picks `delay` and `rtc`, and says go. After that it has no special role.
- **Delay from the slowest link.** The inviter pings every partner; with more than 2 seats, every peer also reports its worst RTT to the others in `accept`. `D` uses the maximum, because every host waits for the slowest seat.
- **Hashes.** Each host's hash covers all seats. Every peer broadcasts its own and compares all of them; any difference ends the session for everybody.
- **Reconnect.** Missing frames are re-requested from the seat that owns them. A peer that can't come back within the timeout ends the session for all; the cartridge-like behaviour keeps everyone's last in-game save.
- **Link backend.** The mGBA backend links up to 4 GBAs (mGBA's lockstep SIO driver supports 4); GB serial joins 2. Tested so far: 4 linked GBAs run at 1.4 ms per frame (§12). A 3/4-seat net test is in §12.
- **Shared World** shows up to 3 partners (§9); each gets its own sprite and name tag.

**Rollback (phase 5).** Native save states are cheap (a GBA state is ~0.4 MB in memory), so GGPO-style prediction and re-simulation is affordable. It would remove the felt delay in battles. It is not needed for trades.

## 6. Transport

- **Channel.** The run's existing Trystero room (WebRTC full mesh, signalling over Nostr) gets a new action `link`: ordered, reliable, and encrypted by Trystero/DTLS plus the run secret.
  - Messages: `link-invite / accept / refuse / save / go / input / hash / need / bye`.
  - Inputs are batched: one message per frame when the data channel is direct, four frames per message when relayed.
  - When WebRTC is down, the MQTT fallback carries everything except inputs. A session needs a data channel (direct or TURN). Without one the UI says "No direct connection – link sessions need one (TURN off)".
- **TURN (built).** Strict NATs (mobile hotspots, some ISPs) need a relay.
  - The Worker (`souldew-discord`, feature `link`, `src/features/link.js`) serves `GET /link/ice[?run=<hex>]`: it calls Cloudflare Realtime TURN `…/turn/keys/<TURN_KEY_ID>/credentials/generate-ice-servers` with the `TURN_KEY_API_TOKEN` secret and answers `{ iceServers, ttl: 7200, turn: true }` (port-53 URLs dropped). 20 requests per IP per hour (the live feature's D1 counter); STUN only (`turn: false`) when the secrets are missing or Cloudflare fails. Checked against the real TURN key.
  - The app's server proxies it (`GET /api/link/ice`, `server/lib/linkice.mjs`, cached for 80 % of the credentials' life); the page hands the entries to Trystero as `turnConfig` (added to its default STUN servers), so the direct path is still tried first.
  - The link bar shows the route from the connection's selected ICE pair: "direct · 12 ms" or "relayed (TURN) · 80 ms" (`SyncLink.linkRoute`).
  - Costs: inputs are ~3 KB/s per peer, so a 10-minute session is ~2 MB. The free tier (1,000 GB/month, TURN and SFU combined) covers ~500,000 sessions per month. Partner video over TURN is the real cost; keep it to stills when relayed, as today.
- **Fallback when even TURN fails:** a Durable Object WebSocket relay per session. The payload stays encrypted with the run key, so the relay sees nothing. Build it only if field data asks for it.

## 7. Saves, ROMs and the tracker

- **ROMs never cross the network.** Every seat's ROM must exist locally.
  - Randomized or patched runs: `build.mjs` builds every slot (default "both of us/all of us") and records `outputs[slot].sha1`. A missing partner ROM is rebuilt with one click (same base ROM, patch and seed). The SHA-1 must equal the partner's.
  - Plain runs where both play the **same** game: the player's own copy is used for both seats if the SHA-1s match.
  - Plain runs with **different** games (Emerald ↔ FireRed, HeartGold ↔ SoulSilver pair runs): each peer needs the other's game file. Decided: the player picks it from their own library, souldew checks it by SHA-1.
  - **How a seat's file is found** (`server/lib/linkroms.mjs`, every peer for every seat, only by SHA-1): the run's build for that slot → any other build of the run with that SHA-1 (both play the same file) → a file picked earlier (remembered per SHA-1 in `link-roms.json` in the run folder) → a library ROM with the partner's CRC32 (plain runs announce it with the SHA-1), confirmed by hashing; a zipped one is unpacked into the run folder. Each player announces only their own game's SHA-1 (and CRC for plain runs).
  - When a seat's file isn't found, the bar says so before the link starts: **"Pick your copy of it"** (a library game; a file that isn't in the library can be added from there – it is then found by its checksum) or, for randomized/patched runs joined before every player's game was built, **"Build Tim's game"** (`/api/link/build`: that slot from the run's base ROM, patch, settings and seed).
- **Saves.** The partner's save travels deflated and encrypted (128 KB GBA flash → ~20–40 KB) and is SHA-1-checked. It is used only inside the session and deleted at the end.
- **Write-back.**
  - The session's local-seat SRAM messages go through the **existing** fast-player path (`NativeSessions.onMessage` / the page's `emu-saved` → the run's save file).
  - A trade writes into the run's save exactly as playing does. HeartGold/SoulSilver watchers and the gen-4 graveyard writer see it as a normal save.
- **Tracker.**
  - Live tracking reads the local seat's RAM, so a traded-in Pokémon appears in the team at once.
  - The tracker marks it: the OT ID differs from the player's (Gen 3: `otid` in the party struct, `pid ^ otid` key).
  - The log gets "Traded Poochyena ↔ Wurmple with Tim" (session events plus a before/after party diff).
  - SoulLink rule checks run as usual. For example, if trades are allowed but the traded Pokémon counts as "received", the pair link moves with it, or stays, depending on the rule (§10).

## 8. Per generation

| Gen | Games | Link | Engine | Trades | Battles | Status / effort |
|---|---|---|---|---|---|---|
| 1 | R/B/Y (+hacks) | GB serial | SameBoy (link host) | Cable Club trade ✅ app | Colosseum ✅ app | Gen 1 has no exit from the Trade Center/Colosseum: the game saved, the session ends by "Leave link" (on hardware: switching off). |
| 2 | G/S/C, Polished Crystal, Crystal Legacy | GB serial | SameBoy (link host) | Trade Center ✅ app | Colosseum ✅ app | The cartridge clock travels in the save (VBA-M footer) both ways; the fast player keeps it now too. The Cable Club needs `EVENT_GAVE_MYSTERY_EGG_TO_ELM`; a trade needs a second non-egg Pokémon. Time Capsule (Gen 1 ↔ 2): both seats are CGBs in one backend – not tried yet (~1 d). |
| 3 | R/S/E, FR/LG, hacks (Unbound, Radical Red …) | GBA SIO link cable | mGBA (link host) | Cable Club ✅ app | Colosseum single ✅ app; Multi Battle (4 players) ✅ app | FR/LG: not tried (no ROM in the test set) – their Cable Club works by cable, the location sign doesn't know their link rooms yet. The Union Room needs the wireless adapter: skipped (decision). Hacks: anything with the vanilla link code should work; check per hack. |
| 4 | D/P/Pt, HG/SS | DS local wireless | melonDS's core ×N in one process, deterministic MP layer (MULTIPLAYER-DS.md) | Union Room ✅ app (Platinum) | Union Room battle ✅ app | D/P and HG/SS not tried in the app (Pearl boots); the sign knows Platinum's Union Room only. Rejoin only between wireless exchanges. Interpreter only: 4 consoles ≈ 1.6× real time on an M1 – slow PCs may struggle with 4 players. |
| 5 | B/W, B2/W2 (+Blaze Black/Volt White) | DS local wireless (+ C-Gear IR) | as Gen 4 | Union Room, C-Gear | Union Room, C-Gear | Same backend; Black and White 2 boot, their Union Rooms weren't reached yet (~2–3 d with recordings). Whether the C-Gear's IR features work in melonDS is unknown. |
| 6–7 | X/Y, ORAS, S/M, US/UM | 3DS local wireless | Azahar rooms (libretro core has no room client) or 2 instances | Player Search System | PSS battles | Research. Azahar's network room needs a room server (souldew's Hetzner box) and a core patch. **Later.** |

**Battles everywhere** use the same session as trades. The game's link battle runs on both consoles, so there is no extra work in the host. souldew adds:
- a "Battle" invite;
- optional battle rules (level cap = the run's cap, no items);
- a result entry in the log ("Marius won 3–1").
- For SoulLink, battle losses never count as deaths unless the run says so (§10).

## 9. Shared World

Goal: partners walk visibly in your game, on the same map, and you can walk up to them and press A to trade or battle.

GBA-PK's approach injects NPC objects into game RAM per ROM revision, which breaks on randomizers and is CC BY-NC. souldew's version is an **overlay drawn by souldew** over the emulator picture, fed by RAM reads it already does.

1. **Read** each player's map id, tile x/y, facing, movement state and avatar (gender, bike/surf), using the per-game live-tracking tables (`shared/data/addresses.json` and the trackers).
   - Gen 3: SaveBlock1 `pos` (+0x00) and `location` (+0x04) are already used.
   - New per-game fields: `gObjectEvents[player]` (facing, movement direction, running/bike flags; Emerald `0x02037350`, FR/LG `0x02036E38`, Sapphire `0x030048A0`, from the pret symbol files) and the camera offset (`gTotalCameraPixelOffsetX/Y`: Emerald `0x03005DEC`, FR/LG `0x0300506C`, Sapphire `0x0300489C`), or derive the camera from the local player, who is always centred.
   - Gen 1/2: `wXCoord/wYCoord/wMapGroup/wMapNumber`, `wPlayerDirection`, and `wSpriteStateData` for walking animation.
   - Gen 4/5: the field-system player struct, with x/z in tiles.
   - Randomizers keep maps, so the same addresses hold. A game without known addresses shows no overlay (the board keeps "Tim is on Route 104" as today).
2. **Exchange** at 10–15 Hz over the run's channel: `{map, x, y, facing, moving, avatar, t}`, ~20 bytes. Interpolate to 60 fps on the receiver and snap on a map change.
3. **Render** on a canvas over the native player and the 3DS canvas.
   - Screen position = (partner tile − local tile) × 16 px + the screen centre, plus the local sub-tile scroll from the movement state.
   - Clip to the game area. Hide the overlay when the partner is on another map, when the local game is in a battle or menu (the `inBattle` flag and gMain callback checks the trackers already have), and during map transitions.
   - Sprites are the game's own player sprite sheets, **extracted from the local ROM at runtime** (Gen 3: `gObjectEventGraphicsInfoPointers` → the player graphics, decompressed and palettised). No Nintendo assets ship. Randomized ROMs keep player sprites.
   - The draw order puts the overlay above the map. Exact occlusion behind trees or roofs would need the map's metatile layer flags; phase 2 at best.
4. **Interact:** when the local player faces a tile with a partner on it and presses A (or the souldew button over the partner), souldew opens "Trade / Battle / Wave".
   - Trade or Battle starts the link session (§4).
   - Wave shows an emote bubble over both avatars. It is the cheap social layer, like linkcable's emotes.
5. **Feasibility and effort:**
   - Gen 3 (E, FR/LG, R/S): **1.5–2 wk** (sprite extraction 3 d, overlay and interpolation 3 d, RAM fields and tests 3 d).
   - Gen 1/2: 1 wk (simpler sprites; metatile scroll is per pixel).
   - Gen 4/5: 2–3 wk (3D field camera with a perspective projection; Gen 5 has a tilted camera, so derive the projection from the field camera struct).
   - 3DS: research.
   - Spike: not started in this phase. Gen 3 is first, because its tables are the most complete.

## 10. SoulLink rules and UX

- **Run rules** (built, Rules tab, every player sees them – `doc` rules): "Trades between us (link)" on/off (default on), "Battles between us (link)" on/off (default on) and, under it, "Losing a link battle counts as deaths" (default **off**: while a link battle runs, the live team isn't applied to the run at all – no deaths, no wipe). Invites are hidden when a rule is off.
- **Tracker after a trade:** the traded Pokémon moves to the receiver's team. Its pair link follows the rule: "the pair stays linked across owners" (default), or "a traded Pokémon becomes unpaired". The log gets an entry, and the board shows a small ⇄ badge on traded mons.
- **UX flow:**
  - The board's partner card has **"Trade" and "Battle"**; with 3–4 players, the own card has **"Link all of us (n)"** (Gen 3 multi battles, the DS Union Room).
  - The invitee sees the bar: "Tim wants to trade Pokémon with you! – Join / Not now".
  - Preparing: "checking the games, swapping saves …", the route ("direct · 12 ms" / "relayed (TURN)"); if a partner's game isn't here: "Pick your copy of it" / "Build Tim's game".
  - Running: "Linked with Tim · delay 4 frames · direct · Meet in the Pokémon Center, upstairs at the counter" (DS: "the Union Room counter"), "Leave link"; while a partner is missing: "waiting for Tim … (if their game dropped out, they can rejoin)".
  - The play view hides pause, reset, speed and save states during a link (the partners' copies of every console must stay the same).
  - After leaving, normal play resumes from the new save, and the log shows the trade.
  - All texts are in EN/DE/FR/ES/IT. Wording to avoid: the word "faint".
- **Partner windows** (3.0): the existing partner video stays and becomes movable (separate task).

## 11. Licences and legal

| Component | Licence | Use |
|---|---|---|
| souldew | GPL-3.0-or-later | — |
| mGBA / libmgba | MPL-2.0 | Compatible with GPL-3 (MPL §3.3 "Larger Work"); keep the MPL notice (`LICENSE-mgba-MPL-2.0.txt` ships next to the host) and offer the source, as for the libretro core. |
| melonDS | GPL-3 | Compatible. |
| SameBoy | Expat | Compatible. |
| Gambatte | GPL-2.0-only | Confirmed: its sources say "version 2" with no "or later", so it can't be linked into the GPL-3 link host. The link host uses SameBoy instead – and since the seamless link (§4a) the fast player too (SameBoy's libretro core): Gambatte isn't shipped any more (only EmulatorJS's browser build still has it). |
| TGB Dual | GPL-2.0-or-later | Compatible, but older and less accurate than SameBoy. Not used. |
| GBA-PK | CC BY-NC 4.0 | **Not used, not ported.** |
| pret decompilations | — | Used only as references for RAM layouts and scripts (as the trackers already do). |

- **Never transferred:** ROMs, BIOS, firmware. The DS backend uses melonDS's built-in BIOS/firmware replacements, as the fast player does.
- **Saves** contain only the players' own data, sent encrypted to their own partner.
- **No Nintendo servers.** WFC replacements would be third-party and opt-in.
- **Naming:** no Nintendo/Pokémon trademarks in the feature name (e.g. "Link play").

## 12. Measurements

M-series Mac, darwin-arm64, Release build:

| Run | Result |
|---|---|
| 1 GBA, free-running | 2,855 fps (0.35 ms/frame) |
| 2 GBA, linked (Emerald + Sapphire) | 1,428 fps (0.70 ms/frame, worst 1.7 ms); 0.68 ms during the trade |
| 4 GBA, linked | 726 fps (1.38 ms/frame) |
| 2 GB (Red ×2) | 4,303 fps (0.23 ms) |
| 2 GBC (Crystal + Silver) | 2,892 fps (0.35 ms) |
| 2 GB, SameBoy (Red ×2, recorded trade) | ~600–720 fps; 1.4–1.65 ms CPU per frame (M1, under load) |
| 2 GBC, SameBoy (Crystal + Silver, recorded session) | ~500 fps; ~1.9 ms CPU per frame |
| 1 GBC, SameBoy (reference) | ~1,000 fps; ~0.95 ms |
| Recorded trade session replayed headless | 12,638 frames in 8.5 s, saves byte-identical to the live session |
| 2 peers, RTT 80 ± 15 ms, D = 6, max speed | 143.6 fps, 105/105 hashes equal, saves equal (peers and local session) |
| 2 peers, RTT 40 ± 10 ms, D = 5 | 234 fps, 25/25 hashes equal |
| Bandwidth (unbatched, u32 inputs + framing) | 1.4–2.8 KB/s per peer |
| Seamless: a running game's state (the snap) | GBA (mGBA) 528,448 B → 21–32 KB deflated; GB/GBC (SameBoy) 252,682 B (the libretro core pads its ~116 KB state to its maximum) → 28 KB; DS (melonDS) 19,744,141 B → 1.7 MB deflated (2.3 MB as base64 on the channel, ~190 parts) |
| Seamless: snapshot (pause, SAVE, deflate, SHA-1) | GBA 18–54 ms, GB 46–64 ms, DS ~200 ms |
| Seamless: "Linking…" – the picture stands still from the snapshot to the first linked picture (two players on one Mac) | GB 106 ms, GBA 168–207 ms, DS 1.2–3.2 s – almost all of it the 2.3 MB of the two DS states on the data channel (0.4–2.6 s per direction between runs, base64 in 12 KB JSON parts) |
| Seamless: back alone – leave to the first solo picture (FLUSH, SEATSTATE, the fast player started with the state) | GB 72–94 ms, GBA 97–222 ms, DS 0.67–0.89 s |

## 13. Plan and effort

Done in this round: one link host with all three backends (macOS built and tested, Windows cross-compiled, Linux in CI), touch, sound, the cartridge clock, rejoin by state transfer, resend, TURN (Worker + app), direct/relayed, desync safety, the partner's game by SHA-1 (pick / build), DS in the app, 3–4 player invites, the location sign, rules, tests (`test/link.test.mjs`, `test/linkhost.test.mjs`, `test/native.test.mjs` clock test) and the e2e harness for 2–4 players.

What is left for 3.0, with effort:

| Item | Effort |
|---|---|
| Run the Windows `linkhost.exe` on a real Windows PC (and a Windows ↔ Mac session: x64 ↔ arm64 determinism) | 1 d |
| First green `native.yml` run (Linux + Windows link host; the RGBDS step is new) | ½ d |
| Release packaging: `linkhost` + its licences in the app bundles (`npm run dist` checks it now), signing/notarising one more binary on macOS | ½–1 d |
| A real two-computer test over the internet, once with TURN forced (relayed) | ½ d |
| Trade log entry for Gen 2 and Gen 4 (the e2e saw the trade in the saves but no log entry – the live party's keys) and a battle result entry ("Marius won") | 1 d |
| FR/LG, D/P, HG/SS, B/W, B2/W2: a recorded trade + battle each through the e2e; their link rooms on the sign | 3–4 d |
| Gen 1 ↔ 2 Time Capsule | 1 d |
| DS rejoin during a wireless exchange (the state can't be taken while a console waits mid-frame): retry until the exchange pauses, or make the wait state serialisable | 2–3 d |
| UX polish from real players: the need/pick bar, what happens to an invite while the partner is in a menu (seamless: the link simply starts there) | 1–2 d |
| Seamless DS start: 1.2–3.2 s on one Mac, more over the internet/TURN – the 1.7 MB deflated state is sent as base64 in JSON parts; binary chunks on the data channel, and only what differs from a reference the receiver can build itself (the same game booted from the same save), would cut it to a fraction | 1–2 d |
| Seamless with 3–4 players (the same path, not run yet) and a DS session started while both are already inside the Union Room alone (the fast player's firmware MAC is the same for every player – the games may need to leave and re-enter the room so their wireless reads the link host's per-seat MAC) | 1 d |
| Shared World (§9), rollback, spectating | after 3.0 |

## 14. Decisions for the owner

Decided (November 2026): TURN approved (Cloudflare Realtime key "souldew-link" on the Worker); different games in one run: the player picks the partner's file from their library, checked by SHA-1; no third-party WFC servers; rule defaults: trades allowed, link-battle losses don't count; up to 4 players; the GBA wireless adapter is skipped for now.

Decided in this round (seamless link, §4a): the fast player's Game Boy core is **SameBoy** (the link host's emulator and version, MIT) instead of Gambatte – Gambatte's save states can't go into a link session; the GBA core is built from the **link host's mGBA commit** instead of the 0.10.5 release. Cost: save states made with the older Gambatte fast player aren't offered for GB runs any more (battery saves and the cartridge clock carry over); Game Boy games show the Game Boy Color's palettes, as on a GBC.

Open: none for this round. Worth deciding before release: whether runs created before 3.0 should get "Build every player's game" offered once (randomized GB/GBA runs joined earlier have only the joiner's own game), and whether DS JIT may be offered for sessions where every peer is the same architecture (faster for 4 players; needs the JIT build and a session option).
