// @vitest-environment jsdom
// Older phones (Chrome / WebView ~61–100, iOS 11–15): the app must open and navigation must start without the newer
// APIs those browsers lack. Everything is imported first; the modern globals are removed only inside the tests.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { act } from '../src/actions';
import { installPolyfills, onResize, timeoutSignal, uuid } from '../src/compat';
import { initViewport } from '../src/map2d/viewport';
import { buildFloors } from '../src/map2d/draw';
import { enterSite, graphs, recompute, state } from '../src/state';
import { renderAll } from '../src/ui/render';
import { loadGraph } from './helpers';

type Obj = Record<string, unknown>;
const G = globalThis as unknown as Obj;
const saved: { obj: Obj; key: string; own: boolean; val: unknown }[] = [];
/** Hide a global ("ResizeObserver") or a member ("crypto.randomUUID") until the test ends. */
function without(...names: string[]) {
  for (const n of names) {
    const [obj, key] = n.includes('.') ? [G[n.split('.')[0]] as Obj, n.split('.')[1]] : [G, n];
    saved.push({ obj, key, own: Object.prototype.hasOwnProperty.call(obj, key), val: obj[key] });
    obj[key] = undefined; // shadows prototype methods too (crypto.randomUUID lives on Crypto.prototype)
  }
}
afterEach(() => {
  for (const s of saved.splice(0))
    if (s.own) s.obj[s.key] = s.val;
    else delete s.obj[s.key];
});

beforeAll(() => {
  const html = readFileSync(join(__dirname, '..', 'app', 'index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('<script type="module"'));
  if (!graphs.length) graphs.push(loadGraph('hospital'));
  // jsdom has no ResizeObserver (like Chrome < 64 / iOS < 13.4): the map must set itself up without it.
  delete G.ResizeObserver;
  window.matchMedia ??= (() => ({ matches: false, addEventListener() {} })) as never;
  Element.prototype.scrollIntoView ??= () => {};
  initViewport();
});

describe('older phones', () => {
  it('polyfills fill only what is missing', async () => {
    const g = {
      Object: {},
      Array: { prototype: {} },
      Promise: { all: Promise.all.bind(Promise), resolve: Promise.resolve.bind(Promise) },
    } as never;
    installPolyfills(g);
    const { Object: O, Array: A, Promise: P } = g as { Object: typeof Object; Array: typeof Array; Promise: typeof Promise };
    expect(O.fromEntries([['a', 1]])).toEqual({ a: 1 });
    expect(A.prototype.at.call([1, 2, 3], -1)).toBe(3);
    expect(typeof (g as { createImageBitmap?: unknown }).createImageBitmap).toBe('function');
    await expect(P.allSettled([Promise.resolve(1), Promise.reject(new Error('x'))])).resolves.toMatchObject([
      { status: 'fulfilled' },
      { status: 'rejected' },
    ]);
    const fe = Object.fromEntries;
    installPolyfills(); // a modern browser keeps its own
    expect(Object.fromEntries).toBe(fe);
  });

  it('timeoutSignal and uuid work without AbortSignal.timeout, AbortController and crypto.randomUUID', () => {
    without('AbortSignal.timeout', 'crypto.randomUUID');
    expect(timeoutSignal(100)).toBeInstanceOf(AbortSignal);
    expect(uuid()).toMatch(/^[a-z0-9]{12,}$/);
    without('AbortController');
    expect(timeoutSignal(100)).toBeUndefined();
  });

  it('without ResizeObserver the map listens to window resize instead', () => {
    expect(typeof ResizeObserver).toBe('undefined');
    let called = 0;
    onResize(document.body, () => called++);
    window.dispatchEvent(new Event('resize'));
    expect(called).toBe(1);
    expect(() => initViewport()).not.toThrow();
  });

  it('the page opens: the "opening…" line is replaced by the home screen', () => {
    expect(document.querySelector('#boot')).not.toBeNull();
    enterSite('hospital', 'GF-GATE3');
    buildFloors(document.querySelector('#floors') as unknown as SVGGElement);
    recompute();
    renderAll();
    expect(document.querySelector('#boot')).toBeNull();
    expect(document.querySelector('#body')!.textContent!.length).toBeGreaterThan(100);
  });

  it('"Start navigation" works without crypto.randomUUID and AbortSignal.timeout (Chrome < 103, iOS < 16)', () => {
    without('AbortSignal.timeout', 'crypto.randomUUID');
    enterSite('hospital', 'GF-GATE3');
    state.dest = 'G-20';
    recompute();
    renderAll();
    act({ dataset: { act: 'navstart' } });
    expect(state.nav).toBe(true);
    expect(document.querySelector('.nv-instr')).not.toBeNull();
    act({ dataset: { act: 'navend' } });
  });
});
