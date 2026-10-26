// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { act } from '../src/actions';
import { initViewport } from '../src/map2d/viewport';
import { buildFloors } from '../src/map2d/draw';
import { G, enterSite, graphs, recompute, state } from '../src/state';
import { renderAll } from '../src/ui/render';
import { loadGraph } from './helpers';

beforeAll(() => {
  const html = readFileSync(join(__dirname, '..', 'app', 'index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('<script type="module"'));
  ['hospital'].forEach((id) => graphs.push(loadGraph(id)));
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
  window.matchMedia ??= (() => ({ matches: false, addEventListener() {} })) as never;
  Element.prototype.scrollIntoView ??= () => {};
  initViewport();
});

const $ = (s: string) => document.querySelector(s)!;

describe.each(['hospital'])('%s renders', (id) => {
  it('home, route, nav and every view in both languages', () => {
    for (const lang of ['en', 'hi'] as const) {
      state.lang = lang;
      enterSite(id);
      buildFloors($('#floors'));
      recompute();
      renderAll();
      expect($('#floors').querySelectorAll('.room').length).toBeGreaterThan(0);
      expect($('#body').innerHTML).toContain('data-act="navstart"');
      act({ dataset: { act: 'navstart' } });
      const steps = state.route && state.route.status === 'ok' ? state.route.steps.length : 0;
      for (let i = 0; i < steps; i++) act({ dataset: { act: 'next' } });
      expect(state.nav).toBe(false);
      // Feedback is asked only after the first arrival on this phone, never on later trips.
      expect(state.view).toBe(lang === 'en' ? 'fb' : 'home');
      for (const v of ['dir', 'floors', 'where', 'help', 'fb']) {
        act({ dataset: { act: 'view', v } });
        expect($('#body').innerHTML.length).toBeGreaterThan(50);
      }
      expect(document.body.innerHTML).not.toMatch(/undefined|\[object/);
    }
  });
});

describe('navigation mic', () => {
  it('"main 205 ke paas hoon" mid-walk moves you-are-here to 205 and keeps navigating', async () => {
    state.lang = 'en';
    enterSite('hospital', '301');
    state.dest = 'G-07';
    recompute();
    renderAll();
    act({ dataset: { act: 'navstart' } });
    expect(state.nav).toBe(true);
    (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = class {
      onresult?: (e: unknown) => void;
      onend?: () => void;
      start() {
        queueMicrotask(() => {
          this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: 'main 205 ke paas hoon' }], { isFinal: true })] });
          this.onend?.();
        });
      }
      stop() {}
    };
    act({ dataset: { act: 'navMic' } });
    await new Promise((r) => setTimeout(r, 0));
    expect(state.start).toBe(G().site.places.find((p) => p.id === '205')!.via); // the corridor outside 205
    expect(state.nav).toBe(true);
    expect(state.stepIdx).toBe(0);
    expect(state.navNote?.en).toContain('New route from here');
    expect(document.querySelector('.nv-instr')!.textContent).not.toContain('Step out of');
  });
});

describe('moving on without Next', () => {
  const start = () => {
    enterSite('hospital', '301');
    state.dest = 'G-07';
    recompute();
    renderAll();
    act({ dataset: { act: 'navstart' } });
  };

  it('footsteps from the motion sensor move the steps on; standing still does not', () => {
    (window as unknown as { DeviceMotionEvent: unknown }).DeviceMotionEvent = class {};
    let t = 0;
    const motion = (m: number) => {
      const e = new Event('devicemotion') as Event & { accelerationIncludingGravity: unknown };
      Object.defineProperty(e, 'timeStamp', { value: (t += 50) });
      e.accelerationIncludingGravity = { x: 0, y: 0, z: m };
      window.dispatchEvent(e);
    };
    start();
    for (let k = 0; k < 200; k++) motion(9.8 + (k % 2 ? 0.2 : -0.2)); // standing: small jitter
    expect(state.sensor).toBe('yes');
    expect(state.stepIdx).toBe(0);
    // walking: ~2 footsteps a second, each a peak of ~13 m/s²
    for (let k = 0; k < 400 && state.stepIdx === 0; k++) motion(k % 10 < 3 ? 13 : 9);
    expect(state.stepIdx).toBe(1);
    act({ dataset: { act: 'navend' } });
  });

  it('a phone that sends only acceleration (no gravity) still counts footsteps', () => {
    start();
    state.sensor = 'unknown';
    let t = 1e6;
    for (let k = 0; k < 400 && state.stepIdx === 0; k++) {
      const e = new Event('devicemotion') as Event & { acceleration: unknown; accelerationIncludingGravity: unknown };
      Object.defineProperty(e, 'timeStamp', { value: (t += 50) });
      e.accelerationIncludingGravity = null;
      e.acceleration = { x: 0, y: 0, z: k < 100 ? 0.1 * (k % 2) : k % 10 < 3 ? 3 : 0 };
      window.dispatchEvent(e);
    }
    expect(state.sensor).toBe('yes');
    expect(state.stepIdx).toBe(1);
    act({ dataset: { act: 'navend' } });
  });

  it('walking back moves the dot back; walking on resumes from there', () => {
    (window as unknown as { DeviceMotionEvent: unknown }).DeviceMotionEvent = class {};
    let t = 0;
    const orient = (alpha: number) => {
      const e = new Event('deviceorientation') as Event & { alpha: number };
      e.alpha = alpha;
      window.dispatchEvent(e);
    };
    const step = () => {
      for (let k = 0; k < 10; k++) {
        const e = new Event('devicemotion') as Event & { accelerationIncludingGravity: unknown };
        Object.defineProperty(e, 'timeStamp', { value: (t += 50) });
        e.accelerationIncludingGravity = { x: 0, y: 0, z: k < 3 ? 13 : 9 };
        window.dispatchEvent(e);
      }
    };
    enterSite('hospital', 'GF-GATE3');
    state.dest = 'G-20';
    recompute();
    renderAll();
    act({ dataset: { act: 'navstart' } });
    orient(200);
    while (state.stepIdx === 0) step(); // leave the start step
    for (let k = 0; k < 4; k++) step(); // learn the heading on the first walk
    const before = state.walked,
      idx = state.stepIdx;
    orient(20); // turned round: the dot walks back with the visitor
    for (let k = 0; k < 3; k++) step();
    expect(state.stepIdx).toBe(idx);
    expect(state.walked).toBeLessThan(before);
    const back = state.walked;
    orient(200); // forward again, from where they really are
    for (let k = 0; k < 2; k++) step();
    expect(state.walked).toBeGreaterThan(back);
    expect(state.walked).toBeLessThan(before + 0.01);
    act({ dataset: { act: 'navend' } });
  });

  it('demo walk plays the route by a timer', async () => {
    const { vi } = await import('vitest');
    vi.useFakeTimers();
    try {
      start();
      act({ dataset: { act: 'demo' } });
      expect(state.stepIdx).toBe(0);
      vi.advanceTimersByTime(state.autoDur * 1000 + 10);
      expect(state.stepIdx).toBe(1);
      expect($('.nv-prog .fill')).toBeTruthy();
      act({ dataset: { act: 'demo' } });
      vi.advanceTimersByTime(600_000);
      expect(state.stepIdx).toBe(1);
      act({ dataset: { act: 'navend' } });
    } finally {
      vi.useRealTimers();
    }
  });
});
