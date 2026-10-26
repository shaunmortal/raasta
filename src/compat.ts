// Keeps the app opening on older phones (Chrome / Android WebView / Safari from about 2017 on). Vite lowers the
// syntax (build.target in vite.config.ts) but adds no polyfills, so the few newer APIs we use are shimmed or wrapped
// here. main.ts and admin.ts import this module first.

type AnyGlobal = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Add the missing pieces to `g` (the window by default). Safe to call twice. */
export function installPolyfills(g: AnyGlobal = typeof window !== 'undefined' ? window : globalThis) {
  if (!g.globalThis) g.globalThis = g;
  if (!g.Object.fromEntries)
    g.Object.fromEntries = (it: Iterable<[PropertyKey, unknown]>) => {
      const o: Record<PropertyKey, unknown> = {};
      for (const [k, v] of it) o[k as string] = v;
      return o;
    };
  if (!g.Array.prototype.at)
    g.Array.prototype.at = function (this: unknown[], i: number) {
      const n = Math.trunc(i) || 0;
      return this[n < 0 ? this.length + n : n];
    };
  if (!g.createImageBitmap)
    g.createImageBitmap = (blob: Blob) =>
      new Promise((ok, no) => {
        const i = new Image(); // Safari < 15: an <img> works for drawImage, width and height
        i.onload = () => {
          URL.revokeObjectURL(i.src);
          ok(i);
        };
        i.onerror = no;
        i.src = URL.createObjectURL(blob);
      });
  if (!g.Promise.allSettled)
    g.Promise.allSettled = (ps: Iterable<unknown>) =>
      g.Promise.all(
        Array.from(ps, (p) =>
          g.Promise.resolve(p).then(
            (value: unknown) => ({ status: 'fulfilled', value }),
            (reason: unknown) => ({ status: 'rejected', reason }),
          ),
        ),
      );
}
installPolyfills();
if (typeof window !== 'undefined') (window as { __raasta?: number }).__raasta = 1; // tells index.html the app's JS is running

/** fetch() signal that aborts after `ms`; undefined on browsers without AbortController (fetch then just waits). */
export function timeoutSignal(ms: number): AbortSignal | undefined {
  try {
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) return AbortSignal.timeout(ms);
    const c = new AbortController();
    setTimeout(() => c.abort(), ms);
    return c.signal;
  } catch {
    return undefined;
  }
}

/** Random id for a trip; crypto.randomUUID needs Chrome 92 / iOS 15.4 and https. */
export const uuid = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2, 12);

/** Run `fn` when `el` changes size (ResizeObserver: Chrome 64 / iOS 13.4); older browsers get window resize events. */
export function onResize(el: Element, fn: () => void) {
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(fn).observe(el);
  else window.addEventListener('resize', fn);
}

/** Start on the flat map (3D stays one tap away) when three.js cannot run (no WebGL2: old GPUs, iOS < 15) or the phone is
 * weak: Chrome reports 2 GB for 2–3 GB phones, so the core count tells the 2 GB ones apart. */
export function lowEnd() {
  const n = navigator as { deviceMemory?: number; hardwareConcurrency?: number };
  if ((n.deviceMemory ?? 4) <= 2 && (n.hardwareConcurrency || 8) <= 4) return true;
  try {
    return !document.createElement('canvas').getContext('webgl2');
  } catch {
    return true;
  }
}
