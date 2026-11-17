// Where the souldew account's tokens live (the session itself: ./session.mjs).
//
// Only ever encrypted by the operating system: the desktop app hands the local server Electron's safeStorage (macOS
// Keychain, Windows DPAPI, the Secret Service / KWallet on Linux) as `secure`. The tokens are written as one encrypted
// blob (account.bin in the data folder, mode 0600) – never as text, never into config.json, a run folder, the page,
// diagnostics or a log line. Without a usable keychain (the browser build of `npm start`, a Linux desktop without a
// keyring – Electron then only offers its "basic_text" fallback, which is plain text in disguise) the store refuses to
// write anything: the session stays in memory until the app closes, and the page says so (Settings › Account).
import { readFileSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { DATA_DIR, DEV, APP_ROOT } from '../paths.mjs';
import { writeFileAtomic } from '../fsutil.mjs';

/** The encrypted blob (in development the ignored runs/ folder, like config.json). */
export const accountFile = () => join(DEV ? join(APP_ROOT, 'runs') : DATA_DIR, 'account.bin');

/**
 * secure: { available(): boolean, encrypt(string): Buffer, decrypt(Buffer): string } or null.
 * Returns { persistent, load(), save(obj), clear() }. load() → the saved object or null (nothing saved, or a blob this
 * keychain can't open – another user, a reinstalled OS: that is "signed out", never an error).
 */
export function createTokenStore(secure, { file = accountFile() } = {}) {
  let memory = null;
  const persistent = () => {
    try {
      return !!secure && secure.available() === true;
    } catch {
      return false;
    }
  };
  return {
    persistent,
    load() {
      if (!persistent()) return memory;
      try {
        const obj = JSON.parse(secure.decrypt(readFileSync(file)));
        return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
      } catch {
        return null;
      }
    },
    save(obj) {
      if (!persistent()) {
        memory = obj;
        return false;
      }
      mkdirSync(dirname(file), { recursive: true });
      writeFileAtomic(file, secure.encrypt(JSON.stringify(obj)));
      try {
        chmodSync(file, 0o600);
      } catch {
        // a file system without modes (Windows: the profile folder is private anyway)
      }
      memory = null;
      return true;
    },
    clear() {
      memory = null;
      rmSync(file, { force: true });
    },
  };
}
