// Where code from a souldew+ pack runs: a module worker inside a SANDBOXED iframe (sandbox="allow-scripts", no
// allow-same-origin) – never the page itself and never the Node / main process. The iframe (/cosmetics-sandbox.html,
// served with its own CSP: connect-src 'none', no images, no styles) has an opaque origin: whatever runs there is
// cross-origin to the app, so it can't call the local API (the server refuses Origin: null and the app window's
// HttpOnly, SameSite=Strict secret is never sent from there), can't read the page, its storage or the account, and has
// no network at all. The worker's imports are the app's PUBLIC engine modules (served with CORS for exactly this); the
// pack's module text (already decrypted, its signature and hash verified by pack/format.mjs) becomes the worker's
// source with its '@cosmetics/…' specifiers pointed at those modules.
//
// The page talks to the worker through a MessageChannel the iframe relays (sandbox-frame.js): it draws into
// OffscreenCanvases it is handed and answers messages – that's all.

const SPEC = "'@cosmetics/";

/** absolute same-origin URL of a module in web/lib/cosmetics */
export const engineUrl = (path) => new URL(`/lib/cosmetics/${path}`, location.origin).href;

/**
 * hostModule: the public host ('frames/worker-host.mjs'); freeModule: a public content module (default export, an array)
 * or null; packText + packExport: the verified pack module and the array it exports (RECIPES / ANIMS) or null.
 */
export function workerSource({ hostModule, freeModule = null, packText = null, packExport = null }) {
  const lines = [];
  if (packText) lines.push(packText.replaceAll(SPEC, `'${engineUrl('')}`));
  lines.push(`import { host as __souldewHost } from '${engineUrl(hostModule)}';`);
  if (freeModule) lines.push(`import __souldewFree from '${engineUrl(freeModule)}';`);
  lines.push(`__souldewHost([...${freeModule ? '__souldewFree' : '[]'}, ...${packText && packExport ? packExport : '[]'}]);`);
  return lines.join('\n');
}

export const SANDBOX_PAGE = '/cosmetics-sandbox.html';

/**
 * A worker for pack code, Worker-shaped for the runtimes (postMessage with transfers, onmessage / onerror,
 * addEventListener, terminate): the source runs in a module worker the sandboxed iframe starts. Messages sent before
 * the iframe is up are queued.
 */
class SandboxedWorker {
  constructor(source, name) {
    this.onmessage = null;
    this.onerror = null;
    this.listeners = { message: new Set(), error: new Set() };
    this.queue = [];
    this.ready = false;
    this.dead = false;
    const ch = new MessageChannel();
    this.port = ch.port1;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d && d.op === '__souldew_error') this.emit('error', { message: String(d.message || 'worker error') });
      else this.emit('message', { data: d });
    };
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.title = 'souldew+';
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden;pointer-events:none';
    this.onReady = (e) => {
      if (e.source !== frame.contentWindow || e.data?.op !== 'souldew-sandbox-ready' || this.ready || this.dead) return;
      removeEventListener('message', this.onReady);
      // the iframe's origin is opaque ('null'), so '*' is the only target – the message goes to this iframe's window only
      frame.contentWindow.postMessage({ op: 'souldew-sandbox', source, name }, '*', [ch.port2]);
      this.ready = true;
      for (const [m, t] of this.queue.splice(0)) this.port.postMessage(m, t);
    };
    addEventListener('message', this.onReady);
    frame.src = SANDBOX_PAGE;
    (document.body || document.documentElement).appendChild(frame);
    this.frame = frame;
  }

  emit(type, ev) {
    const fn = type === 'message' ? this.onmessage : this.onerror;
    try {
      fn?.(ev);
      for (const l of this.listeners[type]) l(ev);
    } catch (e) {
      console.error('souldew sandbox listener failed', e);
    }
  }

  postMessage(m, transfer = []) {
    if (this.dead) return;
    if (this.ready) this.port.postMessage(m, transfer);
    else this.queue.push([m, transfer]);
  }

  addEventListener(type, fn) {
    this.listeners[type]?.add(fn);
  }

  removeEventListener(type, fn) {
    this.listeners[type]?.delete(fn);
  }

  terminate() {
    if (this.dead) return;
    this.dead = true;
    removeEventListener('message', this.onReady);
    this.queue.length = 0;
    try {
      this.port.postMessage({ op: '__souldew_terminate' });
    } catch {
      // closed already
    }
    this.port.close();
    this.frame.remove(); // removing the iframe ends its worker as well
  }
}

let factory = (source, name) => new SandboxedWorker(source, name);
/** Tests without a browser replace how the worker is made (the default is always the sandboxed iframe). */
export function setWorkerFactory(fn) {
  factory = typeof fn === 'function' ? fn : (source, name) => new SandboxedWorker(source, name);
}

export function startWorker(opts) {
  return factory(workerSource(opts), opts.name || 'souldew-cosmetics');
}
