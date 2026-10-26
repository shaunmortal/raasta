import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stepDetector } from '../src/engine/pedometer';

/** Samples every `dt` ms: a peak of `hi` for 150 ms once per `period` ms, `lo` otherwise. */
function count(period: number, hi: number, lo: number, ms: number, spin = 0, dt = 50) {
  const d = stepDetector();
  let n = 0;
  for (let t = 0; t < ms; t += dt) n += d(t % period < 150 ? hi : lo, t, spin);
  return n;
}

describe('step counter', () => {
  it('counts a normal walk (2 steps/s)', () => expect(count(500, 13, 9, 10_000)).toBeGreaterThanOrEqual(18));
  it('counts a slow walk (1 step/s, soft steps)', () => expect(count(1000, 11.2, 9.4, 10_000)).toBeGreaterThanOrEqual(8));
  it('counts a very slow, soft walk on a 60 Hz phone', () => expect(count(1200, 10.5, 9.7, 12_000, 0, 16)).toBeGreaterThanOrEqual(8));
  it('ignores standing still on a 60 Hz phone', () => expect(count(90, 9.95, 9.65, 10_000, 0, 16)).toBe(0));
  it('ignores standing still', () => expect(count(100, 10, 9.6, 10_000)).toBe(0));
  it('ignores fast shaking', () => expect(count(250, 16, 6, 10_000)).toBe(0));
  it('ignores hard jolts', () => expect(count(500, 30, 2, 10_000)).toBe(0));
  it('ignores a spinning phone', () => expect(count(500, 13, 9, 10_000, 400)).toBe(0));
});

// Android phone held in front, 60 Hz, [ms, |a| m/s², spin deg/s]: stand still, then a very slow walk from 10 s.
// `still` is the stretch where the phone was truly at rest (in the second one it was still settling after the tap).
describe.each([
  ['motion-slow-walk.json', 0, 16],
  ['motion-slow-walk-2.json', 4, 18],
])('step counter on a real recording: %s', (file, stillFrom, minWalk) => {
  const rec: number[][] = JSON.parse(readFileSync(join(__dirname, 'fixtures', file), 'utf8'));
  const d = stepDetector(),
    t0 = rec[0][0];
  let stand = 0,
    walk = 0;
  for (const [t, m, spin] of rec) {
    const n = d(m, t, spin),
      s = (t - t0) / 1000;
    if (s >= stillFrom && s < 10) stand += n;
    else if (s >= 10) walk += n;
  }
  it('counts nothing while standing', () => expect(stand).toBe(0));
  it('counts the slow walk', () => expect(walk).toBeGreaterThanOrEqual(minWalk));
});

describe('you are here while walking', () => {
  it('moves along the current step by the metres walked, and stops at its end', async () => {
    const { loadGraph } = await import('./helpers');
    const { dijkstra, routeFromPath } = await import('../src/engine/route');
    const { herePoint } = await import('../src/engine/pedometer');
    const g = loadGraph('hospital');
    const r = routeFromPath(g, dijkstra(g, 'GF-GATE3', 'G-20')!);
    const st = r.steps.find((s) => s.kind === 'walk' && s.len > 20)!;
    const a = herePoint(g, r.path, st, 0),
      b = herePoint(g, r.path, st, 10),
      end = herePoint(g, r.path, st, 1000);
    expect(Math.hypot(b.x - a.x, b.y - a.y) / 8).toBeCloseTo(10, 0);
    expect(end).toMatchObject({ x: g.nodes[r.path[st.i1]].x, y: g.nodes[r.path[st.i1]].y });
  });
});

describe('direction check', () => {
  it('learns the phone-to-map turn, then rejects the wrong way', async () => {
    const { headingGate } = await import('../src/engine/pedometer');
    const g = headingGate();
    expect(g.fits(100, 0)).toBe(true); // nothing learnt yet
    g.seen(100, 0);
    expect(g.fits(130, 0)).toBe(true);
    expect(g.fits(280, 0)).toBe(false); // walking back
    expect(g.fits(190, 90)).toBe(true); // after a right turn on the map, the phone turned right too
    expect(g.fits(10, 90)).toBe(false);
  });
  it('counts few footsteps of someone walking in circles', async () => {
    const { headingGate } = await import('../src/engine/pedometer');
    const g = headingGate();
    g.seen(0, 0);
    let counted = 0;
    for (let k = 1; k <= 48; k++) {
      const h = (k * 30) % 360; // a full circle every 12 footsteps
      if (g.fits(h, 0)) {
        counted++;
        g.seen(h, 0);
      }
    }
    expect(counted).toBeLessThanOrEqual(20);
  });
});

// Same phone, [ms, |a|, spin, heading]: stand 5 s, walk straight, turn RIGHT at ~11 s, then LEFT (a wide one) at ~22 s.
describe('direction on a real recording with turns', () => {
  it('reads a right turn as right and a left turn as left', async () => {
    const { headingGate } = await import('../src/engine/pedometer');
    const rec: number[][] = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'motion-turns.json'), 'utf8'));
    const at = (s: number) => rec.find((r) => r[0] - rec[0][0] >= s * 1000)![3];
    const g = headingGate();
    g.seen(at(8), 0); // walking straight along a route going map-up
    expect(g.off(at(15), 0)).toBeGreaterThan(45); // turned right of the route
    expect(g.off(at(26), 0)).toBeLessThan(-45); // turned left of it
  });
  it('a turn only moves on near the end of a long straight', async () => {
    const { nearEnd } = await import('../src/engine/pedometer');
    expect(nearEnd(1.4, 105)).toBe(false); // a side corridor 1 m in is a wrong turn
    expect(nearEnd(70, 105)).toBe(true); // pedometer undercounted a bit: still fine
    expect(nearEnd(0, 8)).toBe(true);
  });
});
