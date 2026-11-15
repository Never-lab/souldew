# Multiplayer: trades, battles and a shared world

Status: **phase 0 and the first slice** (November 2026, branch `feat/multiplayer`). This document is the plan for souldew 3.0: players of a run (and friends they invite) trade Pokémon and battle each other **the authentic in-game way** (Cable Club, Colosseum, Union Room), and see each other walking around in their own games.

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

Everything below was measured on an M-series Mac (darwin-arm64) with retail ROMs copied into a scratch folder. The ROMs and saves are not in the repo.

| | Result |
|---|---|
| **GBA link host** (`native/link-host`, libmgba) | Two linked GBAs in one process, one thread, deterministic. **Emerald ↔ Sapphire Cable Club trade completed between two different saves and written to both battery saves**, then traded back. Screenshots: `gba-01…05`. |
| Determinism | The recorded interactive session (12,638 frames, two consoles, title screen → Cable Club → trade → save) replays headless to **byte-identical battery saves** in 8.5 s. The same holds after rebuilding the host with other compile flags. |
| **Network lockstep** (`scripts/link-net-test.mjs`) | Two link hosts, one per player, each running both consoles, exchanging only their own buttons through a relay with **80 ms RTT ± 15 ms jitter**. Input delay 6 frames. Over all 12,638 frames: **105 of 105 RAM hashes equal, the battery saves equal between peers and equal to the local session's**. At most ~150 fps at that RTT (2.5× real time), so there are no stalls at 1×. Traffic is ~1.4–2.8 KB/s per peer. |
| CPU | 2 GBAs: **0.68 ms per frame** (4 % of one core at 60 fps). 4 GBAs: 1.4 ms. 2 GB/GBC on SameBoy: **1.4–1.9 ms CPU per frame** (Apple M1: 8–11 % of one core at 60 fps); on mGBA's GB core 0.23–0.40 ms. |
| **GB/GBC link host** (`backend_sameboy.c`, SameBoy) | Two linked Game Boy Colors in one process, deterministic. With two different saves each: **Red ↔ Red: Cable Club trade (Bulbasaur ↔ Charmander) and Colosseum battle completed; Crystal ↔ Silver: Trade Center trade (Cyndaquil ↔ Totodile) and Colosseum battle completed** (both directions of a 2-on-2 battle to "YOU WIN / YOU LOSE"). Trades are in both battery saves. |
| GB/GBC determinism | Recorded sessions (Red trade 6,589 frames, Red battle 7,091, Crystal/Silver trade + battle 41,838) replay headless twice to the same hash and **byte-identical saves, equal to the interactive session's**. Net lockstep (80 ms RTT ± 10 ms, delay 6): Red trade 54/54 and Crystal/Silver 348/348 hashes equal, saves equal between peers and to the local session, no waits, ~1.8 KB/s per peer. |
| DS | Research only, see §8 (the DS spike moved to its own agent). |

| **In the app, two profiles** (`scripts/link-e2e.mjs`) | Two souldew servers with scratch data folders on this Mac, one Emerald run created on A and joined on B, both pages in Electron. A clicks "Trade" (invite over the run's peer channel), B joins. Both servers check every seat's ROM by SHA-1, the saves cross the channel (deflated, SHA-1-checked), both play views switch to the link session, and each page drives its own seat (title → Continue → Cable Club → Trade Center). **Both hosts ran at real speed (0.99–1.02×), 202 of 202 hash comparisons equal, ~12,000 inputs each way, no stall.** The local seat's battery saves (the game's link save) landed in each player's run save, and live tracking showed both teams and "Oldale Town" during the session. |
| **Trade in the app** | Same e2e, completed: **Wurmple ↔ Poochyena traded between the two profiles**, both battery saves written back into the runs by the normal save path, and the run log on both computers says "traded Wurmple for Poochyena with Tim" (`logLinkTrade`, from the live team before and after). |
| **3 and 4 peers** | `link-net-test.mjs --random`: 3 peers × 3 linked GBAs and 4 peers × 4 linked GBAs, mesh at 60 ± 10 ms, delay 6, real time: 59.7 fps, 30/30 hashes equal, no waits, saves equal on every peer (~1.4–2.2 KB/s per peer). The games only ran title/intro with random buttons: a real 4-player Multi Battle still needs four saves standing in a link room. |
| Gotcha | 32-bit pictures from the link host halved the speed in the app (the page couldn't take 9 MB/s per window). The host now sends RGB565 like retrohost. |

Not yet in the app: audio from a link session (the host is silent), resend on input gaps, rejoin, TURN, Windows; "You are here" shows a wrong place name inside the link rooms (the Trade Center's map id); runs joined before this branch have only the joiner's own game built (a "build the partner's game" button is missing). See §13.

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
| *(planned)* `backend_melonds.cpp` | DS local wireless: 2 melonDS instances with a deterministic MP layer. |
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
- **No wall clock.** The core's `time()` is redirected at build time (`-Dtime=sbl_time`) to the session's start time plus emulated seconds. The MBC3 clock (Gold/Silver/Crystal) runs on emulated cycles (`GB_RTC_MODE_ACCURATE`). Power-on RAM comes from a fixed seed per seat. Audio is off (`sample_rate 0`).
- **Saves.** In and out as the plain battery RAM, Gambatte's `.srm` layout, which is what souldew's runs hold. A clock cartridge's save without a clock footer gets a clock that starts at day 0 at the session time. Otherwise SameBoy would flag a reset clock and Crystal would ask for the time. A footer (VBA-M/SameBoy layout) is used as it is. **To do:** carry the fast player's Gambatte RTC (`RETRO_MEMORY_RTC`) into the session and back, so the in-game clock doesn't jump.
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

**Not yet:**
- Loading a whole-session save state into a *fresh* host deadlocks. The GBA lockstep driver's own serialisation needs to be restored in the right order across seats. This is needed for rejoin (§5).
- Windows build: the host uses POSIX `write`/`clock_gettime`, so it needs `compat.h` like retrohost. About 1 day.
- Linux has not been tried.

## 4. Session lifecycle

1. **Invite.** On the board, Marius clicks "Trade with Tim" (or "Battle"). His page sends `link-invite {id, kind, system, seats:[{slot, romSha1, saveSha1}], hostVersion, backend, rtc}` over the run's channel. Tim's page shows "Marius wants to trade – Join / Not now". It's an explicit opt-in; the run's rule (§10) must allow it.
2. **Check.** Each peer checks that it can produce **every seat's ROM**: its own from the run folder, the partner's from `manifest.outputs[slot]` with SHA-1 = `romSha1`, rebuilt if missing. It also checks the same link host version and backend.
   - If any check fails, the peer answers `link-refuse {reason}`. Examples: "Tim's game isn't built here – build it (2 min)" or "update souldew".
3. **Save.** Both players save in game. Gen 3 asks for it at the Cable Club counter anyway, but the session boots from the battery save, so the current one counts. souldew flushes the battery save (FLUSH → SRAM).
   - Each peer sends its save: `link-save {slot, sha1, bytes (deflate, base64, chunks ≤ 12 KB)}`. Each peer verifies the SHA-1.
4. **Start.** The initiator picks `rtc` (its clock, ms) and the input delay from the measured RTT (§5), then sends `link-go {delay, rtc}`.
   - Each server starts `linkhost --rom <seat0> --rom <seat1> --sram … --local k --net --delay D --rtc R --ram …` and replaces the single-player session.
   - The page shows the local seat in the fast player.
5. **Play.** Both games boot from their saves (title screen, then Continue). The players walk to the Pokémon Center 2F and use the Cable Club as on real hardware. Inputs and hashes flow (§5). The tracker reads the local seat live.
6. **End.** Either player clicks "Leave", or the game is back in the overworld and the players walk out (souldew suggests leaving once both have saved). `link-bye {frame}` is sent and both hosts stop at the same frame (UNTIL).
   - Each server takes its **own seat's** battery save (SRAM / SEATSRAM) and writes it into the run (§7). The partner's save copy is discarded.
   - Single-player play resumes from the new save.

What if a player quits mid-trade? Gen 3 saves before a trade and again after it. A session cut in between leaves both players with their pre-trade save, which is the cartridge behaviour: nobody loses or duplicates a Pokémon.

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

**Recovery and reconnect (phase 2):**
- **Short drop** (< 30 s): inputs keep queueing and the host shows "waiting for Tim…" (`wait` events). When the channel is back, the missing frames are resent (`link-need {seat, from}` → `link-input` replay from the sender's ring of 4096 frames). Nothing else is needed.
- **Long drop or rejoin:** a peer that is still in the session sends a whole-session save state (deflate, ~0.4 MB per GBA seat) at frame *f*. The rejoiner loads it and both continue from *f*. This needs the lockstep-driver state fix (§3).
- **Hash mismatch recovery** (instead of ending): the same state transfer from the initiator. Offer it only once state transfer has proven reliable.

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
- **TURN.** Strict NATs (mobile hotspots, some ISPs) need a relay. The plan, as design only (no keys or products have been created):
  - The Cloudflare Worker (`souldew-discord`, served at `https://api.souldew.app`) gets a feature `link` with `GET /link/ice?run=<hash>`. The Worker routes features under `/<name>/`; a bare `/ice` would be one extra line in `src/index.js`.
  - The Worker calls Cloudflare Realtime TURN `POST https://rtc.live.cloudflare.com/v1/turn/keys/<KEY_ID>/credentials/generate-ice-servers` with `{ttl: 3600}` and the API token as a Worker secret. It returns `iceServers` (STUN plus `turn:`/`turns:` on 3478/5349/443) to the app.
  - Abuse limits: per-IP rate limit (D1 or a Durable Object counter, ~20 per hour), short TTL, `run` hash for logging only, no accounts.
  - souldew passes them to Trystero as `rtcConfig.iceServers` and still tries direct first. The UI shows "direct" or "relayed".
  - Costs: inputs are ~3 KB/s per peer, so a 10-minute session is ~2 MB. The free tier (1,000 GB/month, TURN and SFU combined) covers ~500,000 sessions per month. Partner video over TURN is the real cost; keep it to stills when relayed, as today.
- **Fallback when even TURN fails:** a Durable Object WebSocket relay per session. The payload stays encrypted with the run key, so the relay sees nothing. Build it only if field data asks for it.

## 7. Saves, ROMs and the tracker

- **ROMs never cross the network.** Every seat's ROM must exist locally.
  - Randomized or patched runs: `build.mjs` builds every slot (default "both of us/all of us") and records `outputs[slot].sha1`. A missing partner ROM is rebuilt with one click (same base ROM, patch and seed). The SHA-1 must equal the partner's.
  - Plain runs where both play the **same** game: the player's own copy is used for both seats if the SHA-1s match.
  - Plain runs with **different** games (Emerald ↔ FireRed, HeartGold ↔ SoulSilver pair runs): each peer needs the other's game file, which it may not have. The UI asks "Do you have FireRed? Pick the file" and checks the SHA-1. Without it, no session (decision §14). There is no workaround that doesn't ship ROMs; split-console linking (each peer runs only its own console and the link bytes travel) would be ~1/3 speed at 50 ms RTT and isn't deterministic across peers.
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
| 1 | R/B/Y (+hacks) | GB serial | SameBoy (link host) | Cable Club trade | Colosseum | **Trade and battle work** in the host (Red ↔ Red, deterministic, net-tested). Remaining: the app flow (same as Gen 3), RTC n/a. Gen 1 has no exit from the Trade Center/Colosseum: the game saved after the trade, and the session ends by resetting, as on hardware. |
| 2 | G/S/C, Polished Crystal, Crystal Legacy | GB serial | SameBoy (link host) | Trade Center | Colosseum | **Trade and battle work** (Crystal ↔ Silver). The Cable Club needs `EVENT_GAVE_MYSTERY_EGG_TO_ELM`, which real players have, and a trade needs a second non-egg Pokémon. RTC: emulated MBC3 clock from the session start; carrying Gambatte's RTC across is a to-do. Time Capsule (Gen 1 ↔ 2) runs in the same backend (both seats are CGBs), not tried yet. |
| 3 | R/S/E, FR/LG, hacks (Unbound, Radical Red …) | GBA SIO link cable | mGBA (link host) | **Done** (E ↔ S, saved) | Colosseum single/double, multi (4 seats) | Battles use the same link code path as trades; a test is pending. FR/LG: the 2F Direct Corner should fall back to the cable without an adapter, as Emerald's did in the spike (to verify). The **Union Room** (FR/LG/E) needs the **wireless adapter (RFU)**, which mGBA doesn't emulate: skip it, the cable rooms cover trades and battles. Record Mixing and Berry Crush work by cable. Hacks: anything that keeps the vanilla link code should work; some big hacks changed or removed link features (check per hack in the ROM matrix). **1–2 wk to ship** (UI, channel, rules). |
| 4 | D/P/Pt, HG/SS | DS local wireless | melonDS ×2 in one process + deterministic MP layer | Union Room, Pal Pad, Colosseum, GTS (online) | Colosseum, Union Room | The melonDS DS libretro core implements libretro netpacket (since 1.2.0), but its MP layer **busy-waits up to 25 ms per packet on a CPU clock**: not deterministic, and LAN-only in practice. Lockstep needs melonDS linked directly (not the libretro singleton), two `NDS` instances (melonDS 1.0+ supports them), JIT **off**, threaded renderer off, and an MP layer that hands packets over by emulated timestamp. **3–4 wk prototype, 8–12 wk robust** (spike agent). Quick alternative: WFC replacement (Kaeru WFC / Pokémon Classic Network) via melonDS network mode `indirect`, with **GTS and Wi-Fi Club trades/battles over the internet in days**, but third-party servers and no SoulLink control. |
| 5 | B/W, B2/W2 (+Blaze Black/Volt White) | DS local wireless (+ C-Gear IR) | as Gen 4 | Union Room, C-Gear | Union Room, C-Gear | As Gen 4. Whether the C-Gear's IR features work in melonDS is unknown (check). Same effort after Gen 4. |
| 6–7 | X/Y, ORAS, S/M, US/UM | 3DS local wireless | Azahar rooms (libretro core has no room client) or 2 instances | Player Search System | PSS battles | Research. Azahar's network room needs a room server (souldew's Hetzner box) and a core patch. **Later.** |

**Battles everywhere** use the same session as trades. The game's link battle runs on both consoles, so there is no extra work in the host. souldew adds:
- a "Battle" invite;
- optional battle rules (level cap = the run's cap, no items);
- a result entry in the log ("Marius won 3–1").
- For SoulLink, battle losses never count as deaths unless the run says so (§10).

## 9. Shared World

Goal: partners walk visibly in your game, on the same map, and you can walk up to them and press A to trade or battle.

GBA-PK's approach injects NPC objects into game RAM per ROM revision, which breaks on randomizers and is CC BY-NC. souldew's version is an **overlay drawn by souldew** over the emulator picture, fed by RAM reads. Nothing is written into the game.

**Status (branch `feat/shared-world`): Gen 3 works in the app** – Emerald and Sapphire tested end to end with two and three scratch profiles (`scripts/world-e2e.mjs`), FireRed/LeafGreen and Ruby share the code path with addresses from the pret symbol files (no FR/LG ROM was at hand to try).

| Game | Status |
|---|---|
| Emerald (US/EU) | **Works**: partners drawn and animated, names, depth against your own player, A → menu, Wave both sides, Trade/Battle into the link flow |
| Ruby / Sapphire (US rev 0–2, Ruby DE) | **Works** (Sapphire US tested) |
| FireRed / LeafGreen (US rev 0–1) | Addresses from `pokefirered*.sym`/`pokeleafgreen*.sym`, same code – untested in the app |
| Other languages, hacks with moved RAM (FR/LG DE/FR/IT/ES, Sapphire DE, CFRU/Unbound …) | No overlay (no verified RAM addresses); the board keeps saying where the partner is. Randomized ROMs work (maps, RAM and sprite tables unchanged). An unknown *revision* of a known game learns its overworld callback and searches the ROM for the sprite tables |
| Gen 1/2, Gen 4/5, 3DS | Not yet – see the feasibility notes below |

### How it works

```
 player page (iframe)                          play view                         partner's play view
 ┌──────────────────────────────────────┐  ┌───────────────────────────┐       ┌──────────────────────┐
 │ nativeplayer: WATCH → a few RAM bytes │  │ lib/sharedworld.mjs        │ world │ … → their overlay     │
 │   with every picture (camera, keys)   │  │  ≤15 msgs/s while moving,  │──────▶│                      │
 │ lib/worldoverlay.mjs                  │──│  1/s still, relay 1/2 s    │◀──────│                      │
 │   reads camera + player, draws        │  │  Trade/Battle → linksession│ (sync │                      │
 │   partners (sprites from the ROM),    │◀─│  partners' states in       │ .mjs) │                      │
 │   names, waves, the A menu            │  └───────────────────────────┘       └──────────────────────┘
 └──────────────────────────────────────┘
```

1. **Read** (`shared/world.mjs`, tables in `shared/data/addresses.json` › `world`, from the pret symbol files per revision):
   - the camera: `SaveBlock1.pos` (the camera's tile; Emerald/FR/LG through `gSaveBlock1Ptr`, R/S fixed) plus `gFieldCamera.x/y` (the sub-tile offset: `CameraMove()` counts the new tile when a step begins, the offset runs 1…15 toward it) → world pixels;
   - the player: `gPlayerAvatar` (object event id, flags: running), `gObjectEvents[id]` (facing, graphics id → avatar kind and gender via the game's `sPlayerAvatarGfxIds`), the map from `SaveBlock1.location`;
   - drawable: `gMain.callback2 == CB2_Overworld`, not `gMain.inBattle`, not `sLockFieldControls` (menus, messages, scripts), `gPaletteFade` (the overlay fades with the screen);
   - your own sprite: `gSprites[gPlayerAvatar.spriteId]` (its OAM position, animation command and flip) – so a partner behind you is drawn behind you.
   - **Per picture**: the native host got a `WATCH` command (`native/retro-host/retrohost.c`, cmd 14): the page names ≤16 ranges (≤512 bytes) and the host sends them (`WATCHED`, message 15) right before each picture. The overlay draws for exactly the picture on screen – no wobble against the map while walking. An older host ignores the command: the overlay then reads the 10 Hz RAM mirror (works, a little less exact while walking). The browser player reads its emulator's memory directly every animation frame.
2. **Exchange** over the run's peer channel, a Trystero action of its own (`world`, `web/lib/sync.mjs`): `[v, seq, t, family, map, x, y, flags]` (~40 bytes of JSON; flags = facing, kind, gender, running, hidden). Up to 15 a second while something changes, a heartbeat once a second while standing still, a "hidden" message when you leave the overworld (battle, menu screens). Partners without a direct link get one message every 2 s over the encrypted MQTT relay. Measured: ~45 bytes per message, so ≤ 0.7 KB/s per partner at the 15-a-second maximum while walking, ~45 B/s standing still.
3. **Interpolate** (`Track`): the picture runs ~1.5 message gaps behind the newest state (60–600 ms, adaptive), linear in between; past the newest it extrapolates ≤150 ms and never past the tile it was heading for; a map change or a jump of more than 3 tiles snaps.
4. **Render** (`web/lib/worldoverlay.mjs`): a 240×160 canvas exactly over the picture, scaled by the same CSS size with `image-rendering: pixelated` (nearest neighbour, like the game). Sprites come from **this computer's ROM** at run time (`shared/worldsprites.mjs`: `gObjectEventGraphicsInfoPointers` → graphics info → 4bpp frames, palette by tag from `sObjectEventSpritePalettes`, the game's own animation tables; tables searched for when not at the known address). Animation follows the distance walked (walk, run, Mach/Acro bike, surf). Depth: partners behind your feet line are drawn first, then your own sprite again (its exact current frame from the ROM) where it covers them, then partners in front. Name tags are crisp HTML in the player's colour; the wave bubble is pixel art (original, no game graphics). Partners show only on the same map of the same game family (Ruby ↔ Sapphire, FireRed ↔ LeafGreen; Emerald ↔ Ruby are not mixed – their map numbering differs).
5. **Interact**: standing still, facing a partner's tile, A (from the game's own `gMain.heldKeys`, or the fast player's input) → after 110 ms, if the game didn't answer the button itself (a sign, a person: field controls locked), souldew's menu opens over the game and the game pauses: **Trade / Battle / Wave / Cancel** (arrows, Enter/Space and Escape, the mapped A/B keys in the fast player, a controller, the mouse; clicking a name tag opens it too). Trade/Battle call `LinkSessions.invite(kind, [slot])` (the existing invite → Join/Not now flow) and dispatch `sl-world-action` for other integrations; they're disabled with the reason when the run's rules, the link state or a missing direct connection don't allow them. Wave shows the bubble over your avatar on every screen that sees you.
6. **UX**: one quiet switch in the play view's side column, "Show partners in my game" (per run, this computer only, default on; shows "· 1 here" while someone is on your map). It only appears when this game is supported. Off hides the overlay; your own position still goes out so the partners can see you. Never in link sessions, solo runs or games without tables.

### Limits (Gen 3)

- The overlay is always above the map: partners aren't hidden behind trees, roofs or tall grass (would need the metatile layer flags), and they walk through NPCs and walls on your screen if they stand there in their game (their own game decides where they can walk).
- Partners on a neighbouring connected map aren't shown until you're on the same map (the connection offsets aren't applied yet).
- Surfing partners are drawn without the surf blob (a field-effect sprite with its own palette table – a follow-up); ledge jumps slide instead of hop.
- Partners vanish while a menu, a message or a script holds your player (they would be drawn over the text box), with a short fade.
- Pair runs with different games (Emerald ↔ FireRed) never share a map, by design.
- No FR/LG ROM was available here: its addresses come from the symbol files and the same struct layouts; verify with `scripts/world-e2e.mjs` before shipping.

### Feasibility for the other generations

- **Gen 1/2 (≈ 4–6 days):** everything is in WRAM, so the 10 Hz mirror and `WATCH` both reach it. Gen 1: `wCurMap` 0xD35E, `wYCoord`/`wXCoord` 0xD361/2 (16 px steps), `wWalkCounter` 0xCFC5 (8 → 0, 2 px per frame) with `wPlayerMovingDirection` 0xD528 for the sub-step, facing `wSpritePlayerStateData1FacingDirection` 0xC109, bike/surf `wWalkBikeSurfState` 0xD700; the player sits at a fixed spot (sprite at 64, 60). Gen 2 (Crystal): `wMapGroup`/`wMapNumber` 0xDCB5/6, `wYCoord`/`wXCoord` 0xDCB7/8, `wPlayerStruct` 0xD4D6 (facing, step offsets), `wPlayerGender` 0xD472, `wPlayerState` 0xD95D (bike/surf). Sprites: 2bpp 16×16 sheets (`RedSprite` 05:4180, Crystal's Chris/Kris sprites) – trivial to decode. The hard part is the colour: Gen 1 on a Color console is coloured by the boot ROM's palette for the title, Gen 2 by its OBJ palettes in ROM (`PAL_NPC_*`) – both reproducible, but to be checked against what Gambatte shows. `hSCX`/`hSCY` are in HRAM, outside the mirror; not needed with the walk counter.
- **Gen 4 (Platinum/HGSS, ≈ 2–3 wk):** the field is 3D with a perspective camera at a fixed pitch (Platinum, HGSS tilt differs per map). Position: the player's map object (x/z in tiles + fixed-point sub-tile) under the field system; the camera struct gives target, distance and angle, from which a projection to the top screen can be derived – an overlay is feasible but needs the projection per map type and won't match exactly where the camera eases. Sprites: the player's overworld textures are in the ROM's NARC (`data/mmodel`), BTX0 textures, decodable. Depth against 3D buildings is not possible from outside.
- **Gen 5 (B/W, B2/W2):** like Gen 4 with a freely tilting camera on many maps: hard; best kept to the board's "Tim is on Route 4".
- **3DS:** research only.

### Effort for the rest

| Item | Effort |
|---|---|
| FR/LG verification with a real ROM (and the e2e) | ½ day |
| Surf blob, ledge hop, partners on connected maps | 2–3 days |
| Occlusion behind roofs/trees (metatile layer flags from the map data) | 3–4 days |
| More languages (verify RAM per language with pret or community tables) | ½ day per language |
| Gen 1/2 | 4–6 days |
| Gen 4 | 2–3 weeks |

## 10. SoulLink rules and UX

- **Run rule** (new, in the rules editor; the default is the run creator's choice at creation):
  - "Trades between partners: off / allowed / only paired Pokémon".
  - "Link battles: off / allowed (losses don't count) / losses count as deaths".
  - The rule lives in `manifest.rules`, so both players see it. Invites are disabled when it is off.
- **Tracker after a trade:** the traded Pokémon moves to the receiver's team. Its pair link follows the rule: "the pair stays linked across owners" (default), or "a traded Pokémon becomes unpaired". The log gets an entry, and the board shows a small ⇄ badge on traded mons.
- **UX flow:**
  - The board's partner card gets **"Trade" and "Battle"** buttons when both are online in the run and the rule allows it.
  - The invitee sees a toast with "Join" / "Not now".
  - Both get a short checklist modal: "✓ Tim's game is here", "✓ saves exchanged", "✓ direct connection (42 ms)", then "Go to the Pokémon Center 2F – the Cable Club is upstairs".
  - The fast player switches to the link session (a "Linked with Tim · 42 ms · delay 5" pill and "Leave link").
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
| Gambatte | GPL-2.0-only | Confirmed: its sources say "version 2" with no "or later", so it can't be linked into the GPL-3 link host. The link host uses SameBoy instead. (The fast player loads it as a separate libretro core.) |
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

## 13. Plan and effort

| Phase | Content | Effort | Status |
|---|---|---|---|
| 0 | Research, link host, GBA spike, net test, this doc | — | **done** |
| 1 | **GBA slice in the app:** server `/api/link/*` on `NativeSessions`; page link session over Trystero `link`; invite/accept, save exchange, ROM SHA-1 check, start/stop; hash compare; write-back; tracker trade entry; run rule; EN/DE/FR/ES/IT texts; e2e with two scratch profiles | 1–1.5 wk | **mostly done** (open: the rule switch in the rules editor, audio, polishing the bar/modal) |
| 1b | Gen 3 battles (Colosseum single/double; multi with 4 seats), battle log entry | 2–3 d | |
| 2 | Robustness: resend on gaps, rejoin by state transfer (lockstep state fix), TURN via the Worker, "direct/relayed" UI, Windows build | 1–1.5 wk | |
| 3 | GB/GBC (Gen 1/2) trades and battles, Time Capsule | Host side done (SameBoy backend); app flow as Gen 3, RTC hand-over, Time Capsule test: ~3 days | spike agent |
| 4 | DS (Gen 4/5): melonDS 2-instance backend, deterministic MP layer; or WFC opt-in first | 3–4 wk prototype | spike agent |
| 5 | Shared World overlay, Gen 3 first, then 1/2, then 4/5 | 1.5–2 wk (Gen 3) | **Gen 3 done** (`feat/shared-world`, §9); Gen 1/2 next |
| 6 | Rollback, spectating, partner windows | open | |

**Ship order for 3.0:** Gen 3 trades and battles, then Gen 1/2 (cheap on the same host), then Shared World Gen 3, then Gen 4/5.

## 14. Decisions for the owner

1. **TURN key and costs.** Create a Cloudflare Realtime TURN key and put it on the Worker as a secret (`TURN_KEY_ID`, `TURN_API_TOKEN`)? Inputs are almost free (§6); the free tier is 1,000 GB/month. Without TURN, pairs behind strict NATs can't link (a commonly quoted rough figure is 10–20 % of connections; not measured for souldew).
2. **First generation.** Gen 3 is proven and recommended. Gen 1/2 next, on the same host and cheap.
3. **Different games in one run** (Emerald ↔ FireRed, pair runs). Require each player to point souldew at the partner's game file (SHA-1-checked)? Or allow linking only when every seat's ROM is reproducible locally?
4. **DS path.** Ship WFC-replacement trades (Kaeru/PCN) as an opt-in stop-gap while the deterministic melonDS backend is built? It means third-party servers and players' saves going online.
5. **Defaults of the run rule:** trades allowed? Do link-battle losses count as deaths? (Suggestion: trades "allowed", battles "losses don't count".)
6. **Wireless adapter (Union Room, FR/LG/E).** Skip it (cable rooms cover trades and battles), or invest ~2 wk to emulate the RFU in the link host?
