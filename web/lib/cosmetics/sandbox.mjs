// Where code from a souldew+ pack runs: a dedicated module worker in the renderer, never the page itself and never the
// Node / main process. The app's CSP stays exactly as it is – script-src 'self' (a blob: module can't be imported by the
// page), worker-src 'self' blob: (a blob: worker may start). The worker's own imports are the app's PUBLIC engine
// modules, same-origin; the pack's module text (already decrypted, its signature and hash verified by pack/format.mjs)
// becomes the worker's source with its '@cosmetics/…' specifiers pointed at those modules.
//
// What the worker can't do: touch the DOM, the page's state, localStorage or the account tokens. It draws into
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

export function startWorker(opts) {
  const url = URL.createObjectURL(new Blob([workerSource(opts)], { type: 'text/javascript' }));
  const w = new Worker(url, { type: 'module', name: opts.name || 'souldew-cosmetics' });
  // the worker has fetched its source by the time it reports anything; the URL isn't needed after that
  const revoke = () => URL.revokeObjectURL(url);
  w.addEventListener('message', revoke, { once: true });
  w.addEventListener('error', revoke, { once: true });
  return w;
}
