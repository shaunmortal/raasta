// Step counter from the phone's accelerometer: the step-by-step view moves on as the visitor walks, and stays put
// while they stand still. No positioning; it only counts footsteps against each step's length.
import type { Graph, Step } from '../data/types';

// ponytail: threshold peak detector with a rhythm check. The constants are calibration knobs; tune on real phones.
export const STEP_M = 0.7; // metres per footstep
// Tuned on a real Android phone held in front (60 Hz): standing still stays under 0.15, a slow walk peaks 0.2 to 0.8.
const HI = 0.2; // m/s² above the phone's own resting reading
const LO = 0.05;
const MIN_GAP = 300; // ms; two such fast peaks in a row are shaking (one alone is a footstep bouncing)
const MAX_GAP = 2200; // ms; a very slow walk shows a footstep every 1 to 2 s
const SLOW_GAP = 1100; // ms; a longer gap in rhythm means a soft footstep in between went unseen: count 2
const START = 2; // steps in rhythm before counting starts (then all of them count)
const MAX_PEAK = 6; // m/s² above rest (smoothed); harder jolts are shaking, not walking
const MAX_SPIN = 200; // deg/s; a phone held while walking turns slower than one being shaken

/**
 * Feed |acceleration incl. gravity| (m/s²), a timestamp (ms) and how fast the phone is turning (deg/s, 0 if
 * unknown). Returns how many footsteps to count now: 0 most of the time, START when walking is first confirmed,
 * then 1 per step. Shaking (too fast, too hard, phone spinning) or a long pause resets the rhythm.
 */
export function stepDetector() {
  let up = false,
    last = -Infinity,
    avg = 9.8,
    rest = 9.8, // slow average: gravity as this phone reads it (sensors differ by a few tenths)
    peak = 0,
    rise = 0,
    prev = -1,
    fast = 0,
    streak = 0;
  return (m: number, t: number, spin = 0): number => {
    // Smoothing by time, not by sample: phones send 20 to 100 readings a second.
    const dt = prev < 0 ? 0.05 : Math.min(0.2, Math.max(0, (t - prev) / 1000));
    prev = t;
    avg += (m - avg) * (1 - Math.exp(-dt / 0.12)); // ~0.1 s: removes hand jitter, keeps each footstep
    rest += (m - rest) * (1 - Math.exp(-dt / 3)); // ~3 s: the resting reading, slower than any walk
    const d = avg - rest;
    if (spin > MAX_SPIN) {
      streak = 0;
      return 0;
    }
    if (!up) {
      if (d > HI) {
        up = true;
        peak = d;
        rise = t;
      }
      return 0;
    }
    peak = Math.max(peak, d);
    if (d >= LO) return 0;
    // The footstep is over: judge it now that its full size is known.
    up = false;
    const gap = rise - last;
    last = rise;
    if (gap < MIN_GAP) {
      if (++fast >= 2) streak = 0;
      return 0;
    }
    fast = 0;
    if (peak > MAX_PEAK) {
      streak = 0;
      return 0;
    }
    streak = gap <= MAX_GAP ? streak + 1 : 1;
    return streak < START ? 0 : streak === START ? START : gap > SLOW_GAP ? 2 : 1;
  };
}

/** Metres to walk before a step is done; null = the visitor taps Next (a lift ride can't be felt as footsteps). */
export function stepMetres(st: Step): number | null {
  if (st.kind === 'walk') return st.len;
  if (st.kind === 'start') return 3;
  if (st.kind === 'stairs') return 10 * st.n;
  return null;
}

/** The point `walked` metres along a step's stretch of the route (8 map units = 1 m), on that step's floor. */
export function herePoint(g: Graph, path: string[], st: Step, walked: number): { x: number; y: number; floor: string } {
  let left = walked * 8;
  for (let k = st.i0; k < st.i1; k++) {
    const a = g.nodes[path[k]],
      b = g.nodes[path[k + 1]];
    if (a.floor !== b.floor) return a; // lift / stairs: stay at the approach until Next
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    if (left <= l) {
      const f = l ? left / l : 0;
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, floor: a.floor };
    }
    left -= l;
  }
  return g.nodes[path[st.i1]];
}

/** Map direction of a walk step in degrees clockwise from map-up (y points down the screen); null for other steps. */
export function stepDeg(st: Step): number | null {
  return st.kind === 'walk' ? (Math.atan2(st.h[0], -st.h[1]) * 180) / Math.PI : null;
}
const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

/**
 * Is a footstep going the route's way? The phone's heading has its own zero (no compass north needed): the
 * first footsteps on a walk step teach the phone-to-map offset, later ones must stay within TOL of the step's
 * direction. Walking in circles or the wrong way is then mostly not counted.
 */
// ponytail: TOL and the drift factor are knobs; a magnetic compass would add north but misreads near hospital machines.
export function headingGate(TOL = 60) {
  let offset: number | null = null;
  const diff = (phone: number, map: number) => wrap(phone - map - offset!);
  return {
    fits: (phone: number | null, map: number | null) => phone == null || map == null || offset == null || Math.abs(diff(phone, map)) <= TOL,
    /** How far the phone points clockwise of the route (degrees, + = turned right of it); 0 when unknown. */
    off: (phone: number | null, map: number | null) => (phone == null || map == null || offset == null ? 0 : diff(phone, map)),
    seen(phone: number | null, map: number | null) {
      if (phone == null || map == null) return;
      if (offset == null) offset = wrap(phone - map);
      else offset = wrap(offset + diff(phone, map) * 0.05); // follow slow gyro drift
    },
    reset() {
      offset = null;
    },
  };
}

/** A turn may move on to the next step only near the end of this one (pedometers undercount, so not at the very end):
 * a side corridor taken early is a wrong turn, not the next step. */
export const nearEnd = (walked: number, need: number) => need - walked <= Math.max(10, need * 0.4);
