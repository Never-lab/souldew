// What the server, the pages and the link host agree on for link sessions (docs/MULTIPLAYER.md): the systems, the seats,
// and the link host's message numbers (native/link-host/linkhost.c – its header is the reference; these must match).

/** Systems the link host plays: GB/GBC (SameBoy), GBA (mGBA), DS (melonDS). */
export const LINK_SYSTEMS = ['gba', 'gb', 'gbc', 'nds'];
export const MAX_LINK_SEATS = 4;
/** Two systems' games can link (Game Boy and Game Boy Color games share the cable). */
export const sameLinkSystem = (a, b) => a === b || (['gb', 'gbc'].includes(a) && ['gb', 'gbc'].includes(b));

/** souldew → link host. (LOAD, POKE, STEP: tests only – a page may never send them, server/lib/native.mjs; READ: a few
 *  bytes, for the link battle's result.) */
export const LINK_CMD = { INPUT: 1, SPEED: 2, SAVE: 3, LOAD: 4, QUIT: 6, FLUSH: 10, RESYNC: 12, STEP: 13, VIEW: 20, RINPUT: 21, READ: 22, POKE: 23, UNTIL: 24, NEED: 25, SEATSTATE: 26 };
/** link host → souldew (retrohost's messages plus the link's own). */
export const LINK_MSG = { VIDEO: 2, AUDIO: 3, STATE: 5, LOG: 6, EVENT: 7, RAM: 8, SRAM: 9, MEM: 11, LINPUT: 12, SEATSRAM: 14, SEATSTATE: 15 };

/** The input delay (frames) for a round trip of `rttMs` – the slowest link's (docs/MULTIPLAYER.md › "Netcode"): half the
 *  round trip with 25 % to spare, plus 3 frames; 4 on a LAN, at most 60. */
export const linkDelay = (rttMs) => Math.min(60, Math.max(4, Math.ceil(((rttMs / 2) * 1.25) / (1000 / 59.7275)) + 3));
