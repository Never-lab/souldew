// The souldew+ page's data (web/views/plus.mjs): who is looking (signed out, free, a Supporter, a souldew+ member, a
// Patron), the three tiers with the owner's prices, and the handful of items the page shows – the strongest of each
// kind, never the whole catalog. Pure, so test/pluspage.test.mjs checks it without a page.
//
// The prices are what the owner set on Buy Me a Coffee (PLUS_SPEC.md: tier 1 Supporter, tier 2 souldew+ 5 €, tier 3
// Patron 10 €). Which BMC level gives which tier is the accounts service's config – the app never decides a tier from
// these numbers, it only shows them.

/** API.md §8.0: plus and patron are souldew+; supporter is the badge only. */
export const TIERS = [
  { id: 'supporter', price: 3 },
  { id: 'plus', price: 5, main: true },
  { id: 'patron', price: 10 },
];

/** The page's picks: a few of the strongest per kind (owner: "much less choice shown – curate"). */
export const CURATED = {
  skins: ['dusk', 'moss', 'midnight-ink', 'sakura', 'soft-light'],
  banners: ['night-train', 'aurora-fjord', 'cherry-orchard'],
  frames: ['brass-ring', 'cathedral-glass', 'sakura-bough', 'snow-globe'],
  nameplates: ['night-train', 'cherry-orchard'],
  launch: ['low-tide', 'lantern-row', 'star-chart'],
};

/** What the viewer wears on the hero card when they have no souldew+ look of their own yet. */
export const HERO_LOOK = { banner: 'night-train', frame: 'brass-ring', nameplate: 'night-train' };

/**
 * Who is looking – the page has one version per state:
 *   'signedOut'                        the hero names nobody, a neutral placeholder wears the look
 *   'free'                             signed in, no membership
 *   'supporter'                        tier 1: thanked, souldew+ still offered (the looks are tier 2)
 *   'member' | 'patron'                souldew+: the thank-you version, everything marked "Yours"
 * `acct`: the account store (lib/account.mjs useAccount()).
 */
export function plusState(acct) {
  const me = acct?.session?.signedIn ? acct.me : null;
  if (!me) return { kind: 'signedOut', tier: 'none', name: '', until: null };
  const tier = me.entitlement?.tier || 'none';
  const kind = tier === 'patron' ? 'patron' : tier === 'plus' ? 'member' : tier === 'supporter' ? 'supporter' : 'free';
  return { kind, tier, name: me.name || '', until: me.entitlement?.until ?? null };
}

/** souldew+ (all the looks) for this state? */
export const hasPlusLooks = (state) => state.kind === 'member' || state.kind === 'patron';
/** A member of any tier – they are thanked (the rail says "thank you" too). */
export const isMember = (state) => state.kind === 'supporter' || hasPlusLooks(state);

/**
 * The hero card's look: a member's own banner / frame / nameplate where they picked one, the page's pick everywhere
 * else (so everyone sees what souldew+ looks like on them).
 */
export function heroLook(me, state) {
  const own = hasPlusLooks(state) && me ? me : {};
  return { banner: own.banner || HERO_LOOK.banner, frame: own.frame || HERO_LOOK.frame, nameplate: own.nameplate || HERO_LOOK.nameplate };
}

/** A tier card's button for this state: 'current' (disabled), 'switch' (members: change it on BMC) or 'join'. */
export function tierAction(state, tierId) {
  if (state.tier === tierId) return 'current';
  return isMember(state) ? 'switch' : 'join';
}

/** The curated items that exist in this catalog (lib/cosmetics catalog()), in the page's order. */
export function curatedFrom(cat) {
  const pick = (list, ids) => ids.map((id) => (list || []).find((x) => x.id === id)).filter((x) => x && !x.drop);
  return {
    skins: pick(cat?.skins, CURATED.skins),
    banners: pick(cat?.banners, CURATED.banners),
    frames: pick(cat?.frames, CURATED.frames),
    nameplates: pick(cat?.nameplates || cat?.banners, CURATED.nameplates),
    launch: pick(cat?.launch, CURATED.launch),
  };
}

/** How many souldew+ items of each kind there are in all (monthly drops count once they're out). */
export function plusCounts(cat) {
  const n = (list) => (list || []).filter((x) => x.plus && !x.drop).length;
  return { skins: n(cat?.skins), banners: n(cat?.banners), frames: n(cat?.frames), launch: n(cat?.launch) };
}
