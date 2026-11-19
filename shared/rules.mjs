// A run's rule defaults – SoulLink and solo Nuzlocke – shared by the app (web/lib/run.mjs) and the open stream API
// (shared/streamapi.mjs), which shows a run's rules with the defaults filled in.

export const DEFAULT_RULES = {
  typeClause: 'global',
  dupes: 'player',
  // a missed encounter (fled, knocked out) with a known species counts for the dupes clause like a catch – off: only
  // catches count (runs from before it have no `missedDupes`)
  missedDupes: false,
  shinyClause: true,
  gifts: 'area', // 'area' (a gift is that area's encounter) | 'free' | 'banned' – older docs say giftsCount: true/false
  giftsCount: true,
  levelCaps: true,
  failKillsPair: true,
  autoAssign: true,
  autoDeath: true,
  sounds: true,
  cheats: false, // the play screen's cheats (Rare Candies, Max Repels) – off until the run allows them; every use goes to the log
  // the battle helper's type matchups (move effectiveness, what hits you, weaknesses) in the play view. The host
  // sets it when creating the run; runs from before it have no `typeHelp` and keep the help (true).
  typeHelp: true,
  // lives (shared/lives.mjs): 0 = off, else how many – every death costs one; `livesPool` 'shared' | 'player'
  lives: 0,
  livesPool: 'shared',
  // "Nothing counts before your first Poké Balls" (web/lib/run.mjs beforeBalls): until a player has a Poké Ball in the
  // bag (or caught a Pokémon), their Pokémon don't die, a whiteout doesn't end the run and no encounter is spent – the
  // standard Nuzlocke rules start once you can catch. Off here, so runs from before keep counting from the start; a new
  // run takes NEW_RUN_RULES.
  startAtBalls: false,
  // trades and battles between the players in a link session (docs/MULTIPLAYER.md): allowed unless the host switched
  // them off ('on' | 'off'); `linkBattleDeaths`: a link battle's knocked-out Pokémon count as deaths (off: just for fun)
  linkTrades: 'on',
  linkBattles: 'on',
  linkBattleDeaths: false,
  // a link battle may be for in-game money (docs/MULTIPLAYER.md › "Battle results and wagers"): 'on' | 'off', and the
  // most a wager may be (₽, 0: no limit – nobody can put in more than their game holds anyway)
  linkWagers: 'on',
  linkWagerCap: 0,
  // raids (docs/MULTIPLAYER.md › "Raid"): the players fight the same trainer together, one shared HP pool – allowed
  // unless the host switched them off ('on' | 'off'); `raidDeaths`: a raid is a real battle, so Pokémon that go down
  // in it count (off: they're taken as standing until healed)
  raids: 'on',
  raidDeaths: true,
  // items given from one player's bag to another's (docs/MULTIPLAYER.md › 9 "Playing together", web/lib/together.mjs):
  // allowed unless the host switched it off ('on' | 'off') – a strict Nuzlocke may want every player on their own
  itemGifts: 'on',
  // (the Discord webhook is not a rule: it stays on this computer – GET/PUT /api/runs/:id/discord)
};

/** What a new run starts with where it differs from DEFAULT_RULES (which older runs fall back to). */
export const NEW_RUN_RULES = { startAtBalls: true };

// Solo Nuzlocke rules. A preset only sets the rule toggles; tool settings (autoAssign, sounds) stay as they are.
const CLASSIC = {
  autoDeath: true, // faint = dead
  blackout: 'party', // 'party' (a whiteout ends the run) | 'box' (only when nothing alive is left anywhere) | 'off'
  deathless: false, // the first death ends the run
  dupes: 'line', // 'off' | 'species' | 'line' (dead ones count too)
  shinyClause: true,
  gifts: 'area',
  statics: 'area', // 'area' | 'free' | 'banned'
  nicknames: false,
  levelCaps: false, // false | 'warn' | 'strict'
  noBattleItems: false,
  setMode: false,
  centerLimit: 0, // Pokémon Center visits per badge, 0 = no limit (counted by hand)
  typeClause: 'off', // 'off' | 'party'
};
export const RULE_PRESETS = {
  classic: CLASSIC,
  hardcore: { ...CLASSIC, levelCaps: 'strict', noBattleItems: true, setMode: true },
};
export const NUZLOCKE_RULES = { ...CLASSIC, autoAssign: true, sounds: true };

/** The run's rules: the stored `rules` over the defaults of its mode ('soullink' | 'nuzlocke'). */
export function rulesWithDefaults(stored, mode) {
  const s = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  const r = { ...(mode === 'nuzlocke' ? { ...DEFAULT_RULES, ...NUZLOCKE_RULES } : DEFAULT_RULES), ...s };
  // `giftsCount` (true/false) came first; `gifts` is the same rule with a third option
  if (s.gifts === undefined && s.giftsCount !== undefined) r.gifts = s.giftsCount ? 'area' : 'free';
  r.giftsCount = r.gifts !== 'free';
  // the host's signature of a SoulLink's rules (shared/hostrules.mjs) is no rule
  delete r.rev;
  delete r.sig;
  return r;
}
