// Electron main for test/skin-proof.test.mjs: starts the app's own server (scratch data folder, a dev pack), opens the
// real app in a hidden window and, on every main view, compares classic with every skin from the pack: element boxes,
// visible text and generated (::before / ::after) text must be identical – a skin may change the look only.
// Prints one JSON line: { ok, views, skins, boxes, diffs: [...] }.
import { app, BrowserWindow } from 'electron';
import { writeFileSync } from 'node:fs';

const out = process.argv[process.argv.length - 1];
app.commandLine.appendSwitch('mute-audio');
app.disableHardwareAcceleration();

const VIEWS = ['library', 'soullink', 'nuzlocke', 'link', 'stream', 'trophies', 'settings?s=general', 'settings?s=play', 'settings?s=controls', 'settings?s=about', 'guide'];
// collected in the page: every element of the shell and the view, its box (to 1/4 px) and its generated text
const COLLECT = `(() => {
  const r = (v) => Math.round(v * 4) / 4;
  const els = [...document.querySelectorAll('body *')].filter((e) => !e.closest('canvas, .cos-art-host, script, style'));
  const boxes = els.map((e) => { const b = e.getBoundingClientRect(); return [r(b.x), r(b.y), r(b.width), r(b.height)].join(','); });
  // generated TEXT: an ornament with content: '' adds no text, so none / normal / "" are all "no text"
  const gen = (v) => (v === 'none' || v === 'normal' || v === '""' ? '' : v);
  const pseudo = els.map((e) => [gen(getComputedStyle(e, '::before').content), gen(getComputedStyle(e, '::after').content)].join('|'));
  const fonts = els.map((e) => getComputedStyle(e).fontFamily);
  const own = els.map((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.data.trim()));
  const tags = els.map((e) => e.tagName + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\\s+/).slice(0, 2).join('.') : ''));
  return { boxes, pseudo, tags, fonts, own, text: document.body.innerText, hidden: els.filter((e) => e.checkVisibility && !e.checkVisibility() && e.innerText?.trim()).length };
})()`;

app.whenReady().then(async () => {
  const result = { ok: false, views: 0, skins: 0, boxes: 0, glyphRuns: [], diffs: [] };
  try {
    const { startServer } = await import('../../server/app.mjs');
    const { url } = await startServer({ port: 0, background: false });
    const win = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { backgroundThrottling: false } });
    const js = (code) => win.webContents.executeJavaScript(code, true);
    await win.loadURL(url);
    const until = async (code, ms = 20000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (await js(code).catch(() => false)) return true; await new Promise((r) => setTimeout(r, 150)); }
      throw new Error(`timed out: ${code}`);
    };
    await until("!!document.querySelector('.nav')");
    await until("import('/lib/cosmetics/index.mjs').then((m) => m.packState().entitled)");
    // still frames only: no animation or transition may land between two captures
    await js(`(() => { const s = document.createElement('style'); s.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}'; document.head.appendChild(s); })()`);
    const skins = await js("import('/lib/cosmetics/index.mjs').then((m) => m.listSkins().filter((s) => s.id !== 'classic' && s.available).map((s) => s.id))");
    result.skins = skins.length;
    for (const view of VIEWS) {
      await js(`location.hash = '#/${view}'`);
      await new Promise((r) => setTimeout(r, 700));
      const frame = "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))";
      await js(`import('/lib/cosmetics/index.mjs').then((m) => m.applySkin(null))`);
      await js(frame);
      const base = await js(COLLECT);
      result.views++;
      for (const id of skins) {
        // applied, not previewed: a preview shows Settings' preview bar (with the skin's name) – that is UI, not the skin
        await js(`import('/lib/cosmetics/index.mjs').then((m) => m.applySkin(${JSON.stringify(id)}))`);
        await js("document.fonts.ready");
        await js(frame);
        const got = await js(COLLECT);
        result.boxes += got.boxes.length;
        const diff = (what, a, b) => result.diffs.push({ view, skin: id, what, a: String(a).slice(0, 200), b: String(b).slice(0, 200) });
        if (await js("document.documentElement.dataset.skin") !== id) diff('not applied', id, '');
        if (got.boxes.length !== base.boxes.length) diff('element count', base.boxes.length, got.boxes.length);
        else {
          for (let i = 0; i < base.boxes.length; i++) {
            if (base.boxes[i] === got.boxes[i]) continue;
            // a glyph run (themes README › proof): a text element set in the skin's display face may be NARROWER, at the
            // same place and height – it moves nothing else (every other box is compared as usual)
            const [ax, ay, aw, ah] = base.boxes[i].split(',').map(Number);
            const [bx, by, bw, bh] = got.boxes[i].split(',').map(Number);
            if (got.own[i] && got.fonts[i] !== base.fonts[i] && ax === bx && ay === by && ah === bh && bw <= aw) {
              result.glyphRuns.push(`${id} · ${view} · ${base.tags[i]}`);
              continue;
            }
            diff(`box ${base.tags[i]}`, base.boxes[i], got.boxes[i]);
            if (result.diffs.length > 60) break;
          }
          for (let i = 0; i < base.pseudo.length; i++) if (base.pseudo[i] !== got.pseudo[i]) diff(`generated text ${base.tags[i]}`, base.pseudo[i], got.pseudo[i]);
        }
        if (got.text !== base.text) diff('text', base.text.length, got.text.length);
        if (got.hidden !== base.hidden) diff('hidden text', base.hidden, got.hidden);
      }
      await js(`import('/lib/cosmetics/index.mjs').then((m) => m.applySkin(null))`);
    }
    result.ok = result.diffs.length === 0 && result.views === VIEWS.length && result.skins > 0;
  } catch (e) {
    result.error = String(e?.stack || e);
  }
  writeFileSync(out, JSON.stringify(result));
  app.exit(0);
});
