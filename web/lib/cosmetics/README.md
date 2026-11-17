# web/lib/cosmetics – souldew+ cosmetics

Skins, profile banners, nameplates, avatar frames and launch animations. **The engines and runtimes in this folder are app code (open source). The premium content isn't.** Premium content means skin stylesheets and their assets, banner recipes, nameplate windows, frame recipes and launch animations. It arrives as a signed, per-account encrypted pack, and is only ever decrypted in memory, in the renderer.

Import from `index.mjs` (plain functions) and `components.mjs` (Preact). Treat the names below as a stable interface: the profile / friends UI and the account client depend on them.

## Public interface (`index.mjs`)

### Skins

| Name | What it does |
|---|---|
| `applySkin(id \| null)` | Commits the player's skin. `null` or `'classic'` is the look the app ships with. Returns `false` while the skin isn't owned yet: the wish is remembered and applied once the pack is loaded and owns it. Persisting the choice is the caller's job (`save({ skin })`, config key `skin`). |
| `previewSkin(id)` / `endPreview()` | Tries a skin on the whole app without saving it, then puts the committed one back. Settings calls `endPreview()` when it unmounts. `previewSkin` returns `false` when that skin's stylesheet isn't in memory. |
| `listSkins()` | `[{ id, name, hint, group: 'editions' \| 'dark' \| 'light', plus, launch, sw, owned, available }]`. `launch` is the launch animation that comes with the skin, or `null`. |
| `skinState()` / `onSkinChange(fn)` | `{ committed, pending, previewing, visible }`. |

### Banners, nameplates, frames

| Name | What it does |
|---|---|
| `mountBanner(el, id, { intro = true, reducedMotion, focusY, animate })` | Fills `el` (the profile strip) and returns `{ destroy(), replay(), mounted, stats }`. |
| `mountNameplate(el, id, { reducedMotion, hoverTarget, animate, plateBg })` | Draws the banner's nameplate window behind a list row. It stays still until the row is hovered, and it fades into the row's own background colour, which it re-reads when the skin changes. |
| `mountFrame(el, id, size, { intro = true, reducedMotion, animate, hoverTarget })` | `el` is the avatar box and `size` its css size. The frame is one absolutely positioned canvas inserted right after the `<img>`, so it takes no space. Overhang: 15 % per side (at most 16 px) at 56 px and up, 2 native pixels for 20–55 px, and no frame below 20 px. Small frames animate while their row (`.cos-nameplate` / `[data-cos-row]`) is hovered. |
| `setReducedMotion(true \| false \| null)` | Overrides `prefers-reduced-motion` for all of the above. `null` follows the OS again. |

### Launch animations

| Name | What it does |
|---|---|
| `playLaunch(gameBox, id, { onDone, firstFrame, system, dsLayout, ctrLayout \| layout, reduced })` | Plays a souldew+ animation over the game box and returns `{ ready(), skip(), destroy(), done, stats }`, or `null` when `id` isn't available. `'cartridge'` is the free default: it stays the app's `views/cartinsert.mjs` and always gets `null` here. `firstFrame` may be a Promise or `true`. A click or any key skips the animation. It can never outlast 20 s + its own length. |
| `launchAvailable(id)` | Tells whether `id` can be played now. |
| `previewLaunch(box, id, opts)` | Plays the animation once over our neutral placeholder picture (used by Settings › Play). |
| `layoutKey(system, dsLayout, ctrLayout)` | Maps the play view's system and layout to the animation's pixel grid. |

### Catalog and pack

| Name | What it does |
|---|---|
| `catalog()` | `{ banners, frames, nameplates, skins, launch, collections }`. Each item is `{ id, name, collection, collectionName, rarity, pairsWith, plus, owned, available, sw, … }`. `owned` means usable now; `available` means the content is in memory (owned, or from a preview pack). This catalog is public data: names and swatches only, no art or recipes. |
| `packState()` | `{ entitled, preview, until, packVersion, loading, error }`. `error` is one of `null`, `'offline'`, `'expired'`, `'signature'`, `'decrypt'`, `'hash'` or `'download'`. |
| `refreshPack()` / `forgetPack()` | Loads or re-checks the pack, or forgets it right away (sign-out). The app calls `refreshPack()` at boot, and it re-checks every 6 h and at `until`. |
| `onChange(fn)` | Notifies when content or entitlement changes. |
| `setPackAccessProvider(fn)` / `getPackAccess(opts)` | The account client's hook (see below). |
| `setPlusHandler(fn)` / `openPlus(info)` | Where "Get souldew+" and "Keep … with souldew+" lead. The default opens the Buy Me a Coffee page. |

### Components (`components.mjs`)

| Component | What it renders |
|---|---|
| `<Banner id size="profile \| friend \| card \| fill" shade intro reducedMotion />` | Sizes are 160 px, 92 px, 54 px, or the parent's height. Use `shade` for the fade under the name: it is mixed from the skin's own `--shell`. This fixes the design's fixed `#1b1a1fcc` gradient, which muddied banners on light skins. Without content (locked, or the pack not loaded) the banner shows its palette as a quiet strip. |
| `<Frame id size>{img, presence dot…}</Frame>` | An avatar box with the frame drawn round it. Children after the `<img>` paint above the frame. `useFrame(ref, id, size, opts)` does the same for your own markup. |
| `<Nameplate id>{row content}</Nameplate>` | A row with the nameplate behind it. |
| `<CosmeticPicker kind="banners \| frames \| nameplates" value onPick none reducedMotion />` | A grid grouped by collection, with Free first and the collection that matches the current skin next. Cards show live previews (mounted only once on screen, animated on hover or while selected), rarity, a "Matches your theme" or "Twin of …" hint, and a quiet souldew+ mark on locked items. `onPick(id, item)` fires for locked items too: check `item.owned` and offer `openPlus()`. |
| `<PlusMark />`, `useCosmetics()`, `useVisibleSkin()` | Small helpers. |

Every component destroys its runtime on unmount, so no timer, observer or worker is left behind. Every one pauses off-screen and in hidden tabs, and follows reduced motion.

## The account client's part: `setPackAccessProvider(fn)`

`fn({ purpose: 'pack' | 'preview' })` resolves to one of:

| Value | Meaning |
|---|---|
| `{ url, key, manifestSig, until, packVersion }` | The account owns souldew+. `url` is the short-lived signed download URL (https on `*.souldew.app`). `key` is the account's pack key (32 bytes, base64). `manifestSig` is the signature the service vouches for (base64). |
| `{ …, preview: true }` | Optional, for purpose `'preview'`: a preview pack. Everything can be tried, nothing can be kept. |
| `{ …, offline: true }` | The service is unreachable. The account client returns the last access it kept in safeStorage, so the cached pack keeps working for the 7-day grace period. |
| `null` | Signed out, or no souldew+. The cache is wiped. |
| throw | Counts as offline (without a key, the cache is kept but can't be read). |

Without a provider, the default reads the dev pack from `/api/plus/dev/access`, which only exists when the server runs with `SLS_PLUS_DEV_PACK`.

## Pack format (`pack/format.mjs`)

**archive** (built and signed once, the same for every account):

```
"SDPA" | u32 len | manifest JSON | u32 64 | Ed25519 sig | files…
manifest = { format: 'souldew-plus-pack@1', packVersion, created, files: [{ path, size, sha256 }] }
```

**envelope** (what one account downloads):

```
"SDPK" | u8 1 | u16 len | header JSON { alg: 'A256GCM', iv, wm, issued, packVersion } | AES-256-GCM(archive)
```

The header, including the per-account watermark `wm`, is the GCM additional data, so it can't be edited or swapped.

**Files:** `contents.json`, `banners.json` (recipes as data, nameplate windows included), `skins/<id>.css` (with `url('pack:fonts/…')` / `pack:assets/…`), `fonts/*.woff2`, `assets/*.svg`, `frames.mjs` and `launch.mjs` (the two parts that must stay code: per-pixel recipe functions and animation `setup`/`draw`).

**Verification order:**
1. GCM tag.
2. Framing.
3. The archive's signature must equal the account service's `manifestSig`.
4. Ed25519 against a pinned key (`pack/keys.mjs`: a production placeholder that fails closed; the dev key is trusted only through the dev provider).
5. Manifest shape.
6. Every file's size and SHA-256, with no unlisted bytes.

Only then is anything used.

## Where code from a pack runs (`sandbox.mjs`)

`frames.mjs` and `launch.mjs` run in a dedicated **module worker** created from a blob. The app's CSP is unchanged: `script-src 'self'` still blocks importing a blob into the page, and `worker-src 'self' blob:` already allows the worker. The worker's imports are rewritten (`'@cosmetics/…'`) to the app's own same-origin engine modules. Inside the worker there is no DOM, no page state, no localStorage and no tokens. It draws into OffscreenCanvases and answers messages. Nothing from a pack ever runs in the Node / main process: the local server only stores, serves and wipes the encrypted envelope (`server/lib/pluspack.mjs`).

Skin CSS is injected as a `<style>` (allowed by `style-src 'unsafe-inline'`). Fonts and art become `data:` URLs (allowed by `font-src` / `img-src data:`). Banner recipes are plain data, run by the public engine on the main thread.

## Free vs. pack

**Free (in the app):**
- the classic skin;
- banners LCD Grid and Plain Dusk (`content/banners-free.mjs`);
- frames Plain and Pencil (`content/frames-free.mjs`);
- the Cartridge launch animation;
- the public catalog (`content/catalog.mjs`: names, collections, rarities, swatches, pairings).

**Pack:**
- 20 skins (with their fonts and the Clearshell board art);
- 133 banners (125 at launch plus 8 monthly drops) with their nameplate windows;
- 71 frames;
- 13 launch animations.

## Dev pack

```
node scripts/plus-dev-pack.mjs --design <design/plus> --out <dir outside the repo>   # test pack + access.json + dev key
node scripts/plus-dev-pack.mjs --design <design/plus> --catalog                       # regenerate content/*.mjs
SLS_PLUS_DEV_PACK=<dir> node server/index.mjs
localStorage['sl-plus-dev-preview'] = '1'      # try the non-member flow (preview pack, "Keep … with souldew+")
```

Production packs are built and signed by the accounts repo's pack builder, which uses the same `pack/format.mjs` functions.

## Tests

| File | What it covers |
|---|---|
| `test/cosmetics-pack.test.mjs` | Signatures, encryption, hashes, manifest shape. |
| `test/cosmetics-cache.test.mjs` | The server cache (SSRF allow-list, grace, wipe) and the client lifecycle (member, signed out, expired, offline grace, bad signature, damaged download, preview). |
| `test/cosmetics-skins.test.mjs` | Apply, preview and revert; pending wishes; losing the membership; `data:` asset inlining. |
| `test/cosmetics-launch.test.mjs` | Timing: early, late and missing first frame, skip, reduced motion; the worker host. |
| `test/cosmetics-runtime.test.mjs` | Draw, pause off-screen, reduced motion, worker wiring, destroy without leaks. |
| `test/skin-proof.test.mjs` | Every skin on 11 real app views in Electron, comparing element boxes, text and generated text with classic. Needs a pack: set `SLS_PLUS_PROOF_PACK`, or have the design folder next to the checkout. |
