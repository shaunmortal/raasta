// All user actions (data-act handlers) and the document-level event wiring.
import { AiFail, ask, locate, readSlip, sendFeedback } from './ai/client';
import { demoCrowd, endTrip, fetchLive, startTrip } from './ai/live';
import { parseTrip } from './ai/localMatch';
import { nearestOf } from './engine/route';
import { stepSecs } from './engine/steps';
import { STEP_M, headingGate, nearEnd, stepDeg, stepDetector, stepMetres } from './engine/pedometer';
import { fitFloor, fitRoute, fitStep, zoomCenter, hooks } from './map2d/viewport';
import { buildFloors } from './map2d/draw';
import { renderMap, routeFloors } from './map2d/route2d';
import { G, enterSite, graphById, graphs, okRoute, recompute, state } from './state';
import { $, isPhone, toast } from './ui/dom';
import { dirListHTML } from './ui/directory';
import { closeSugg, renderAiMsg, renderHead, renderSugg } from './ui/head';
import { placeLabel, spotLabel, stepText, tr } from './ui/bound';
import { renderAll, renderBody } from './ui/render';
import { renderChrome } from './ui/shell';
import { nextVoice, noHindiVoice, speak, stopSpeaking, type Bilingual } from './voice/speak';
import { t, type Lang } from './i18n';
import * as T from './engine/text';
import { classifyIssue, type Issue } from './engine/issue';
import type { Core, Place, Step } from './data/types';

/** Load the 3D view on demand; on failure (e.g. offline chunk) stay on the 2D map. */
export async function toggle3D(on: boolean, real = false) {
  if (!on && !hooks.is3D()) return;
  const msg = $('#v3msg');
  if (on) {
    msg.textContent = tr('loading3d');
    msg.hidden = false;
  }
  try {
    (await import('./map3d/view')).set3D(on, real);
  } catch {
    toast(tr('no3d'));
  } finally {
    msg.hidden = true;
  }
  renderChrome(hooks.is3D());
}

interface RecogResult {
  isFinal: boolean;
  0: { transcript: string };
}
type Recog = {
  lang: string;
  interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<RecogResult> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
};
let recog: Recog | null = null;

/**
 * Mic input (Web Speech API). Always listens in hi-IN: it understands Hindi, Hinglish and Indian English, and
 * Gemma / the offline search read both Devanagari and Latin text. Words appear in the box while speaking.
 */
function listen(onText: (text: string) => void = (text) => askGemma(text, true)) {
  const w = window as unknown as { SpeechRecognition?: new () => Recog; webkitSpeechRecognition?: new () => Recog };
  const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
  if (!Ctor) return toast(tr('micNo'));
  if (recog) return recog.stop(); // second tap = stop listening
  const r = new Ctor();
  r.lang = 'hi-IN';
  r.interimResults = true;
  const btn = () => document.querySelector('#micBtn');
  const inp = () => $<HTMLInputElement>('#q');
  let finalText = '',
    failed = false;
  r.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      if (res.isFinal) finalText += res[0].transcript;
      else interim += res[0].transcript;
    }
    if (inp()) inp()!.value = (finalText + interim).trim();
  };
  r.onerror = (e) => {
    failed = true;
    // not-allowed: permission denied, or the page is on plain http (phones need https for the mic)
    const key =
      e.error === 'not-allowed' || e.error === 'service-not-allowed'
        ? 'micDenied'
        : e.error === 'audio-capture'
          ? 'micNone'
          : e.error === 'network'
            ? 'micNet'
            : 'micErr';
    toast(tr(key));
  };
  r.onend = () => {
    recog = null;
    btn()?.classList.remove('on');
    const text = finalText.trim();
    if (text) {
      state.query = text;
      onText(text);
    } else if (!failed) toast(tr('micErr'));
  };
  try {
    r.start();
  } catch {
    toast(tr('micDenied'));
    return;
  }
  recog = r;
  btn()?.classList.add('on');
  toast(tr('listening'));
}

const stepBoth = (st: Step): Bilingual => bi((l) => T.stepText(G(), okRoute()!, st, l));

const scrollTo = (sel: string) => $(sel).scrollIntoView({ behavior: 'smooth', block: 'start' });
const redraw = () => {
  renderChrome(hooks.is3D());
  renderHead();
  renderBody();
  renderMap();
};

export function goTo(id: string) {
  const g = G();
  if (id === 'WC') id = nearestOf(g, state.start, g.wc, { stepFree: state.stepFree, liftDown: state.liftDown });
  if (!g.places[id]) return;
  if (state.ai.status === 'thinking') {
    stopAi();
    state.ai = { status: 'idle' };
  }
  Object.assign(state, { dest: id, nav: false, stepIdx: 0, view: 'home', routeIdx: null, blocked: { groups: [], edges: [] } });
  recompute();
  state.floor = g.nodes[state.start].floor;
  closeSugg();
  redraw();
  fitRoute();
  if (isPhone()) scrollTo('#mapwrap');
  refreshLive();
}

export function setStart(id: string) {
  if (!G().startable.includes(id)) return;
  Object.assign(state, { start: id, floor: G().nodes[id].floor, view: 'home', nav: false, photo: { status: 'idle' }, routeIdx: null });
  recompute();
  renderAll(hooks.is3D());
  fitRoute();
  toast(tr('startSet', spotLabel(id)));
}

export function switchSite(id: string, startId?: string | null) {
  stopSpeaking();
  stopAi();
  endTrip();
  enterSite(id, startId);
  state.blocked = { groups: [], edges: [] };
  state.live = null;
  refreshLive();
  buildFloors($('#floors'));
  recompute();
  renderAll(hooks.is3D());
  fitRoute();
}

/** The same message in both languages, so switching language (or reading it aloud) never loses it. */
const bi = (f: (l: Lang) => string): Bilingual => ({ en: f('en'), hi: f('hi') });
const biKey = (key: string, ...a: unknown[]) => bi((l) => t(l, key, ...a));
const biPlace = (key: string, id: string) => bi((l) => t(l, key, T.placeLabel(G().places[id], l)));

/** Show a reply under the ask box; read it aloud too when the question was spoken into the mic. */
function reply(src: 'gemma' | 'search' | 'note', msg: Bilingual, aloud: boolean) {
  state.ai = { status: 'done', src, ...msg };
  renderAiMsg();
  if (aloud) speak(msg);
}

/** Free-text search without AI: take the best local match. */
function localPick(q: string, afterError = false, aloud = false) {
  const g = G(),
    trip = parseTrip(g, q, g.nodes[state.start].floor);
  if (!trip.start && !trip.dest) return reply('note', biKey('noMatch'), aloud);
  applyTrip(trip.start ?? null, trip.dest ?? null);
  const msg = trip.dest
    ? trip.start
      ? bi((l) => t(l, 'tripSet', T.spotLabel(g, trip.start!, l), T.placeLabel(g.places[state.dest!], l)))
      : biPlace('destSet', state.dest!)
    : bi((l) => t(l, 'hereAsk', T.spotLabel(g, trip.start!, l)));
  reply('search', afterError ? biKey('gemmaErr') : msg, aloud);
}

/** Set "you are here" and/or the destination from one sentence; with only a start, keep any destination already chosen. */
function applyTrip(start: string | null, dest: string | null) {
  const g = G();
  if (start && g.startable.includes(start)) Object.assign(state, { start, floor: g.nodes[start].floor, routeIdx: null });
  if (dest) {
    goTo(dest === 'WC' || g.places[dest]?.code === 'WC' ? 'WC' : dest);
    return;
  }
  Object.assign(state, { view: 'home', nav: false });
  recompute();
  renderAll(hooks.is3D());
  fitRoute();
}

let aiCtl: AbortController | null = null;
const stopAi = () => {
  aiCtl?.abort();
  aiCtl = null;
};

/** Ask Gemma 4 (local, via Ollama) to understand free text; on any failure use the offline search instead. */
async function askGemma(q: string, aloud = false) {
  q = q.trim();
  if (!q) return;
  if (!state.aiOn) return localPick(q, false, aloud);
  stopAi();
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null, // Chrome 64–65, iOS 11 have none
    site = state.site;
  aiCtl = ctl;
  state.ai = { status: 'thinking' };
  closeSugg();
  renderAiMsg();
  try {
    const o = await ask(site, q, state.start, state.lang, ctl?.signal);
    if (aiCtl !== ctl || state.site !== site) return;
    aiCtl = null;
    const g = G(),
      said = o.reply_en && o.reply_hi ? { en: o.reply_en, hi: o.reply_hi } : null,
      start = o.start_id && g.startable.includes(o.start_id) ? o.start_id : null,
      dest = o.destination_id && g.places[o.destination_id] ? o.destination_id : null;
    if (!start && !dest) return reply('gemma', said ?? biKey('noMatch'), aloud);
    applyTrip(start, dest);
    reply('gemma', said ?? (dest ? biPlace('destSet', dest) : bi((l) => t(l, 'hereAsk', T.spotLabel(g, start!, l)))), aloud);
  } catch (e) {
    if (aiCtl !== ctl) return;
    aiCtl = null;
    const code = e instanceof AiFail ? e.code : 'upstream';
    if (code === 'cancelled') {
      state.ai = { status: 'idle' };
      renderAiMsg();
      return;
    }
    if (code === 'no_key') state.aiOn = false;
    if (code === 'rate_limited') return reply('note', biKey('rateLim'), aloud);
    localPick(q, true, aloud);
  }
}

/** "Where am I" by voice: any place named ("main 203 mein hoon", "OT ke bahar") becomes "you are here". */
async function whereByVoice(text: string) {
  const g = G(),
    trip = parseTrip(g, text, g.nodes[state.start].floor),
    local = trip.start ?? trip.dest;
  const confirm = (id: string) => {
    setStart(id);
    reply(
      'search',
      bi((l) => t(l, 'hereAsk', T.spotLabel(g, id, l))),
      true,
    );
  };
  if (local && g.startable.includes(local)) return confirm(local);
  if (!state.aiOn) return reply('note', biKey('noMatch'), true);
  try {
    const o = await ask(state.site, text, state.start, state.lang);
    const id = [o.start_id, o.destination_id].find((x) => x && g.startable.includes(x));
    if (id) return confirm(id);
  } catch {
    /* fall through */
  }
  reply('note', biKey('noMatch'), true);
}

/** OPD slip / prescription photo → Gemma reads the department or room → route there. */
async function slipToRoute(file: File) {
  const site = state.site;
  stopAi();
  state.ai = { status: 'thinking' };
  closeSugg();
  renderAiMsg();
  try {
    const o = await readSlip(site, file);
    if (state.site !== site) return;
    const g = G();
    if (!o.destination_id || !g.places[o.destination_id]) return reply('note', biKey('slipNone'), false);
    goTo(o.destination_id);
    reply('gemma', o.reply_en && o.reply_hi ? { en: o.reply_en, hi: o.reply_hi } : biPlace('destSet', o.destination_id), false);
  } catch (e) {
    const code = e instanceof AiFail ? e.code : 'upstream';
    if (code === 'no_key') state.aiOn = false;
    reply('note', biKey(code === 'rate_limited' ? 'rateLim' : 'slipNone'), false);
  }
}

/** "Where am I" from a photo of a nearby sign (Gemma 4 vision). */
async function locateByPhoto(file: File) {
  const site = state.site;
  state.photo = { status: 'reading' };
  renderBody();
  try {
    const o = await locate(site, file);
    if (state.site !== site) return;
    const g = G(),
      id = o.node_id && g.startable.includes(o.node_id) ? o.node_id : null;
    if (id) {
      Object.assign(state, { start: id, floor: g.nodes[id].floor });
      recompute();
      state.photo = { status: 'found', text: tr('photoFound', spotLabel(id), o.text_read) };
    } else state.photo = { status: 'none', text: tr('photoNone') };
  } catch (e) {
    const code = e instanceof AiFail ? e.code : 'upstream';
    if (code === 'no_key') state.aiOn = false;
    state.photo = { status: 'none', text: code === 'rate_limited' ? tr('rateLim') : tr('photoNone') };
  }
  renderHead();
  renderBody();
  renderMap();
  fitRoute();
}

/**
 * A problem reported mid-walk: mark the lift / corridor / stairs as unusable and route again from where the visitor
 * is now (the start of the current step), without leaving step-by-step mode. Works offline.
 */
function navIssue(kind: Issue, aloud: boolean) {
  const r = okRoute();
  if (!r || !state.nav) return;
  const g = G(),
    path = r.path,
    st = r.steps[state.stepIdx];
  if (kind === 'block' && st.kind === 'lift') kind = 'lift'; // "blocked" while at the lift means the lift
  const hereIdx = st.kind === 'lift' || st.kind === 'stairs' ? st.v0 : st.i0;
  const here = path[hereIdx];
  let liftName: Bilingual | null = null;
  if (kind === 'lift') {
    const ls = r.steps.slice(state.stepIdx).find((s) => s.kind === 'lift');
    if (!ls) return say(biKey('issueNoLift'), aloud);
    const core = g.nodes[path[ls.v0]].ref as Core;
    if (!state.blocked.groups.includes(core.group)) state.blocked.groups.push(core.group);
    liftName = bi((l) => T.coreName(g, core, l));
  } else if (kind === 'stairs') {
    state.stepFree = true;
  } else {
    // Block the stretch ahead of the visitor (both directions).
    const a = path[hereIdx],
      b = path[hereIdx + 1];
    if (b && g.nodes[a].floor === g.nodes[b].floor) state.blocked.edges.push(`${a}|${b}`, `${b}|${a}`);
  }
  const nr = rerouteFrom(here);
  if (!nr) return say(biKey('issueNone'), aloud);
  const m = T.fmtM(nr.walk);
  const msg =
    kind === 'lift'
      ? bi((l) => t(l, 'issueLiftOk', liftName![l], m))
      : kind === 'stairs'
        ? biKey('issueStairsOk', m)
        : biKey('issueBlockOk', m);
  state.navNote = msg;
  focusStep();
  renderChrome(hooks.is3D());
  say(msg, aloud);
}

/** Route on from `here` to the same destination, staying in navigation. Null (start unchanged) if there is no way. */
function rerouteFrom(here: string) {
  const g = G(),
    before = state.start;
  Object.assign(state, { start: here, floor: g.nodes[here].floor, routeIdx: null });
  recompute();
  const nr = okRoute();
  if (!nr) {
    state.start = before;
    recompute();
    return null;
  }
  state.stepIdx = 0;
  startTrip(state.site, nr.path, nr.secs);
  return nr;
}

/** Mid-walk "main 205 ke paas hoon": move "you are here" there and route on from it. False if no spot was understood. */
async function navWhere(text: string): Promise<boolean> {
  const g = G();
  let id = parseTrip(g, text, state.floor).start;
  if (!id && state.aiOn) {
    try {
      id = (await ask(state.site, text, state.start, state.lang)).start_id ?? undefined;
    } catch {
      /* offline answer below */
    }
  }
  if (!state.nav || !id || !g.startable.includes(id)) return false;
  if (id === state.dest) {
    navEnd(true);
    return true;
  }
  // Mid-walk the visitor is in the corridor by that room, not inside it: no "Step out of 205" first step.
  const via = g.nodes[id].kind === 'place' ? (g.nodes[id].ref as Place).via : undefined;
  const nr = rerouteFrom(via && g.nodes[via] ? via : id);
  if (!nr) {
    say(biKey('issueNone'), true);
    return true;
  }
  const msg = bi((l) => t(l, 'navHereOk', T.spotLabel(g, id, l), T.fmtM(nr.walk)));
  state.navNote = msg;
  focusStep();
  renderChrome(hooks.is3D());
  say(msg, true);
  return true;
}

/** Toast + (when the visitor spoke) read aloud, used on the step-by-step screen where the reply box is hidden. */
function say(msg: Bilingual, aloud: boolean) {
  toast(state.lang === 'hi' ? msg.hi : msg.en);
  if (aloud) speak(msg);
}

/** Demo walk (stage, nobody walks): each step moves on after a quarter of its walking time, at least 5 s. */
let autoTimer = 0;
function scheduleAuto() {
  clearTimeout(autoTimer);
  const r = okRoute();
  state.autoDur = 0;
  if (!state.nav || !state.demo || !r || state.stepIdx >= r.steps.length - 1) return;
  const i = state.stepIdx;
  state.autoAt = Date.now();
  state.autoDur = Math.max(5, stepSecs(r.steps[i]) / 4);
  const need = stepMetres(r.steps[i]) ?? 0;
  const tick = () => {
    if (!state.nav || !state.demo || state.stepIdx !== i) return;
    const k = (Date.now() - state.autoAt) / 1000 / state.autoDur;
    if (k >= 1) {
      state.stepIdx++;
      focusStep();
      return;
    }
    state.walked = need * k; // the dot walks the step in step with the timer
    moveHere();
    autoTimer = window.setTimeout(tick, 250);
  };
  autoTimer = window.setTimeout(tick, 250);
}

/** Real walk: footsteps from the phone's motion sensor move the steps on; standing still moves nothing. */
const detect = stepDetector();
let motionOn = false;
function onMotion(e: DeviceMotionEvent) {
  // Some Android phones fill only `acceleration` (no gravity); the step counter's slow baseline copes with either.
  const g = e.accelerationIncludingGravity,
    a = g?.x != null ? g : e.acceleration;
  if (!a || a.x == null || a.y == null || a.z == null) return;
  if (state.sensor !== 'yes') {
    state.sensor = 'yes';
    if (state.nav) renderBody();
  }
  const rr = e.rotationRate,
    spin = rr ? Math.hypot(rr.alpha ?? 0, rr.beta ?? 0, rr.gamma ?? 0) : 0;
  if (motionLog) logMotion(e.timeStamp, Math.hypot(a.x, a.y, a.z), spin);
  const n = detect(Math.hypot(a.x, a.y, a.z), e.timeStamp, spin);
  if (!n || !state.nav || state.demo) return;
  const r = okRoute();
  if (!r || state.stepIdx >= r.steps.length - 1) return;
  let st = r.steps[state.stepIdx];
  const deg = stepDeg(st);
  if (!gate.fits(heading, deg)) {
    // Walking back along the route: the dot goes back too (into earlier steps if need be).
    if (deg != null && gate.fits(heading, deg + 180)) return walkBack(n * STEP_M);
    // Otherwise: either the visitor already turned into the next stretch, or they are off course.
    const nx = r.steps[state.stepIdx + 1];
    if (
      !stepDeg(nx) ||
      !gate.fits(heading, stepDeg(nx)) ||
      state.stepIdx + 1 >= r.steps.length - 1 ||
      !nearEnd(state.walked, stepMetres(st)!)
    )
      return offCourse(gate.off(heading, deg));
    state.stepIdx++;
    focusStep();
    st = nx;
  }
  gate.seen(heading, stepDeg(st));
  offN = 0;
  const need = stepMetres(st);
  if (need == null) return;
  state.walked += n * STEP_M;
  if (state.walked >= need) {
    state.stepIdx++;
    focusStep();
  } else showWalked(need);
}
/** Phone heading in degrees clockwise, from the gyro-based orientation (own zero, not compass north). */
let heading: number | null = null;
const gate = headingGate();
function onOrient(e: DeviceOrientationEvent) {
  if (e.alpha != null) heading = 360 - e.alpha;
}
/** Move "you are here" back `m` metres along the route, stepping into earlier walk steps; never before the start. */
function walkBack(m: number) {
  const r = okRoute()!;
  state.walked -= m;
  while (state.walked < 0 && state.stepIdx > 0) {
    const prev = stepMetres(r.steps[state.stepIdx - 1]);
    if (prev == null) break; // not back through a lift or stairs
    const left = state.walked;
    state.stepIdx--;
    focusStep(true);
    state.walked = prev + left;
  }
  state.walked = Math.max(0, state.walked);
  showWalked(stepMetres(r.steps[state.stepIdx]) ?? 1);
  const w = document.querySelector('#nvWalked');
  if (w) w.textContent = tr('walkBack', Math.floor(state.walked), Math.round(stepMetres(r.steps[state.stepIdx]) ?? 0));
  if (++offN >= 2) warn('back');
}
/** Footsteps in a row that went the wrong way; one alone is usually the middle of a turn. */
let offN = 0,
  warnedAt = 0;
/** Say it out loud (even with step voice off: the visitor may not be looking), at most every 8 s. */
function warn(side: string) {
  if (Date.now() - warnedAt < 8000) return;
  warnedAt = Date.now();
  speak(biKey('walkWrong', side));
}
/** `d` = degrees the phone points right of the route: tell the visitor which way to turn (more than 100° off = turn around). */
function offCourse(d: number) {
  if (++offN < 2) return;
  const side = Math.abs(d) > 100 ? 'back' : d > 0 ? 'left' : d < 0 ? 'right' : '';
  const w = document.querySelector('#nvWalked');
  if (w) w.textContent = tr('walkOff', side);
  warn(side);
}
// Calibration on a dev server: open the page with ?motionlog, start navigation, stand 10 s, then walk 20 s.
// The 30 s of readings go to .data/ on the laptop (see vite.config.ts) for tuning the step counter.
// What to do in each 5 s of the recording (shown on screen). Turning right then left tells which way is right.
const MOTION_PLAN = ['khade rahiye', 'seedha chaliye', 'RIGHT mudiye, chaliye', 'chalte rahiye', 'LEFT mudiye, chaliye', 'chalte rahiye'];
let motionLog: number[][] | null = import.meta.env.DEV && location.search.includes('motionlog') ? [] : null;
function logMotion(t: number, m: number, spin: number) {
  if (!motionLog || !state.nav) return;
  motionLog.push([Math.round(t), +m.toFixed(3), Math.round(spin), heading == null ? -1 : Math.round(heading)]);
  const sec = Math.floor((t - motionLog[0][0]) / 1000);
  if (sec < 30) {
    if (motionLog.length === 1 || sec !== Math.floor((motionLog.at(-2)![0] - motionLog[0][0]) / 1000))
      toast(`Recording ${sec + 1}/30 s: ${MOTION_PLAN[Math.min(5, Math.floor(sec / 5))]}`);
    return;
  }
  const body = JSON.stringify(motionLog);
  motionLog = null; // once per page load
  fetch('/__motionlog', { method: 'POST', body }).then(
    () => toast('Recording ho gayi, thanks!'),
    () => toast('Could not send the recording'),
  );
}

/** Slide "you are here" along the route: the 3D ball alone, or a 2D redraw (cheap) when the 3D view is off. */
function moveHere() {
  if (hooks.is3D()) hooks.moveHere3D();
  else renderMap();
}

/** Update only the progress bits, not the whole panel (that would redraw the 3D step view on every footstep). */
function showWalked(need: number) {
  moveHere();
  document.querySelector<HTMLElement>('.nv-prog .walk')?.style.setProperty('--p', `${Math.min(100, (state.walked / need) * 100)}%`);
  const w = document.querySelector('#nvWalked');
  if (w) w.textContent = tr('walkM', Math.floor(state.walked), Math.round(need));
}
/** Must run inside the tap that starts navigation: iPhones ask for motion permission only from a user gesture. */
function startMotion() {
  gate.reset(); // a new trip learns the phone's heading again
  if (motionOn) return;
  const DO = (window as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } }).DeviceOrientationEvent;
  if (DO) {
    const on = () => window.addEventListener('deviceorientation', onOrient);
    if (DO.requestPermission)
      DO.requestPermission().then(
        (p) => p === 'granted' && on(),
        () => {},
      );
    else on();
  }
  const DM = (window as { DeviceMotionEvent?: { requestPermission?: () => Promise<string> } }).DeviceMotionEvent;
  if (!DM) {
    state.sensor = 'no';
    return;
  }
  const listen = () => {
    window.addEventListener('devicemotion', onMotion);
    motionOn = true;
    // Laptops have the API but never send readings; Chrome also stays silent when the site's motion sensors are blocked.
    setTimeout(async () => {
      if (state.sensor === 'yes') return;
      let blocked = false;
      try {
        blocked = (await navigator.permissions.query({ name: 'accelerometer' as PermissionName })).state === 'denied';
      } catch {
        /* not Chrome: can't tell */
      }
      if ((state.sensor as string) === 'yes') return; // a reading may have come in meanwhile
      state.sensor = blocked ? 'blocked' : 'no';
      if (state.nav) renderBody();
    }, 3000);
  };
  if (!DM.requestPermission) return listen();
  DM.requestPermission()
    .then((p) => (p === 'granted' ? listen() : ((state.sensor = 'no'), state.nav && renderBody())))
    .catch(() => {
      state.sensor = 'no';
    });
}

/** Show the current step. `quiet`: don't read it aloud (stepping back while walking the wrong way). */
function focusStep(quiet = false) {
  const r = okRoute()!,
    st = r.steps[state.stepIdx];
  state.floor = st.floor;
  state.walked = 0;
  scheduleAuto();
  renderBody();
  renderMap();
  fitStep(st);
  $('#body').scrollTop = 0;
  if (state.voice && !quiet) speak(stepBoth(st));
}
/** Fetch live walker counts; if they changed the suggestion, show the new options (never mid-walk). */
async function refreshLive() {
  const site = state.site,
    live = state.offlineDemo ? null : await fetchLive(site);
  if (state.site !== site) return;
  state.live = live;
  if (state.dest && !state.nav) {
    recompute();
    renderBody();
    renderMap();
  }
}

function navStart(i = 0) {
  const r = okRoute();
  if (!r || !r.steps.length) return;
  if (!state.nav) {
    startTrip(state.site, r.path, r.secs); // count this phone on its route (no-op offline)
    state.navNote = null;
  }
  Object.assign(state, { nav: true, stepIdx: i });
  startMotion();
  renderChrome(hooks.is3D());
  focusStep();
  if (isPhone()) scrollTo('#mapwrap');
}
function navEnd(arrived: boolean) {
  clearTimeout(autoTimer);
  endTrip();
  state.navNote = null;
  state.nav = false;
  stopSpeaking();
  // Ask for feedback once per phone, after the first trip that ends with "I have arrived"; never again after that.
  if (arrived && !seen(FB_ASKED)) {
    state.view = 'fb';
    state.fbSent = false;
  }
  redraw();
  fitRoute();
  if (arrived) toast(tr('arrived'));
}

const FB_ASKED = 'raasta-fb-asked';
/** Reads and sets a one-time flag; without storage (private mode) it says "seen" so we never nag. */
function seen(key: string) {
  try {
    if (localStorage.getItem(key)) return true;
    localStorage.setItem(key, '1');
    return false;
  } catch {
    return true;
  }
}

function fbSend() {
  const rating = Number(document.querySelector<HTMLInputElement>('input[name="fbr"]:checked')?.value || 0);
  const msg = $('#fbMsg'),
    btn = $<HTMLButtonElement>('[data-act="fbSend"]');
  if (!rating) {
    msg.textContent = tr('fbPick');
    return;
  }
  btn.disabled = true;
  msg.textContent = tr('fbSending');
  const text = $<HTMLTextAreaElement>('#fbText').value;
  sendFeedback({ siteId: state.site, rating, text, dest: state.dest, lang: state.lang })
    .then(() => {
      state.fbSent = true;
      try {
        localStorage.setItem(FB_ASKED, '1');
      } catch {
        /* storage blocked */
      }
      if (state.view === 'fb') renderBody();
    })
    .catch(() => {
      // ponytail: no offline outbox; the visitor can press Send again once online.
      btn.disabled = false;
      msg.textContent = tr('fbFail');
    });
}

export function act(el: { dataset: DOMStringMap; classList?: DOMTokenList; setAttribute?: (k: string, v: string) => void }) {
  const d = el.dataset;
  switch (d.act) {
    case 'view': {
      const S = G().site,
        emg = (S.help as { emg?: string } | undefined)?.emg;
      if (d.v === 'emg') {
        if (emg) goTo(emg);
        return;
      }
      state.view = d.v as typeof state.view;
      if (state.nav) {
        state.nav = false;
        stopSpeaking();
      }
      redraw();
      if (isPhone() && state.view !== 'home') scrollTo('#body');
      break;
    }
    case 'site':
      if (d.s !== state.site) switchSite(d.s!);
      break;
    case 'link': {
      switchSite(d.s!, d.n);
      const S = G().site;
      if (S.parent && S.defaults.dest && S.defaults.dest !== state.start) goTo(S.defaults.dest);
      break;
    }
    case 'dest':
      goTo(d.id!);
      break;
    case 'start':
      setStart(d.id!);
      break;
    case 'ask':
      askGemma($<HTMLInputElement>('#q')?.value ?? '');
      break;
    case 'stopai':
      stopAi();
      state.ai = { status: 'idle' };
      renderAiMsg();
      break;
    case 'slip':
      $<HTMLInputElement>('#slipIn').click();
      break;
    case 'photo':
      $<HTMLInputElement>('#photoIn').click();
      break;
    case 'closeai':
      state.ai = { status: 'idle' };
      renderAiMsg();
      break;
    case 'clear':
      Object.assign(state, { dest: null, route: null, ai: { status: 'idle' } });
      renderHead();
      renderBody();
      renderMap();
      fitFloor();
      break;
    case 'floor':
      state.floor = d.f!;
      if (state.view === 'floors') renderBody();
      renderMap();
      (routeFloors().has(state.floor) ? fitRoute : fitFloor)();
      if (isPhone() && el.classList?.contains('fcard')) scrollTo('#mapwrap');
      break;
    case 'zin':
      zoomCenter(0.75);
      break;
    case 'zout':
      zoomCenter(1.33);
      break;
    case 'zfit':
      fitFloor();
      break;
    case 'lang':
      state.lang = state.lang === 'hi' ? 'en' : 'hi';
      try {
        localStorage.setItem('raasta-lang', state.lang);
      } catch {
        /* storage blocked */
      }
      if (state.photo.status !== 'reading') state.photo = { status: 'idle' };
      buildFloors($('#floors'));
      renderAll(hooks.is3D());
      break;
    case 'navstart':
      navStart(0);
      break;
    case 'fbSend':
      fbSend();
      break;
    case 'fbAgain':
      state.fbSent = false;
      renderBody();
      break;
    case 'navend':
      navEnd(false);
      break;
    case 'step':
      navStart(+d.i!);
      break;
    case 'next': {
      const r = okRoute()!;
      if (state.stepIdx < r.steps.length - 1) {
        state.stepIdx++;
        focusStep();
      } else navEnd(true);
      break;
    }
    case 'demo':
      state.demo = !state.demo;
      if (state.nav) focusStep();
      break;
    case 'prev':
      if (state.stepIdx > 0) {
        state.stepIdx--;
        focusStep();
      }
      break;
    case 'nextVoice': {
      const name = nextVoice();
      toast(name ? tr('voiceNow', name) : tr('voiceOnly'));
      if (state.nav) speak(stepBoth(okRoute()!.steps[state.stepIdx]));
      renderBody();
      break;
    }
    case 'voice':
      state.voice = !state.voice;
      el.setAttribute?.('aria-pressed', String(state.voice));
      if (state.voice) {
        speak(stepBoth(okRoute()!.steps[state.stepIdx]));
        if (noHindiVoice()) toast(tr('noHindiVoice'));
      } else stopSpeaking();
      break;
    case 'cat':
      state.cat = d.c!;
      renderBody();
      break;
    case 'vmode': {
      const m = d.m as '2d' | '3d' | 'real';
      try {
        localStorage.setItem('raasta-view', m);
      } catch {
        /* storage blocked */
      }
      toggle3D(m !== '2d', m === 'real');
      break;
    }
    case 'demoCrowd': {
      const p = state.plan;
      if (p) demoCrowd(state.site, p.routes[0].path).then(refreshLive);
      break;
    }
    case 'pickRoute':
      state.routeIdx = +d.i!;
      recompute();
      renderBody();
      renderMap();
      fitRoute();
      break;
    case 'mic':
      listen();
      break;
    case 'navIssue':
      navIssue(d.k as Issue, false);
      break;
    case 'navMic':
      listen(async (text) => {
        const k = classifyIssue(text);
        if (k) return navIssue(k, true);
        if (!(await navWhere(text))) say(biKey('issueUnknown'), true);
      });
      break;
    case 'micWhere':
      listen(whereByVoice);
      break;
  }
}

/** Spot from the URL: "#<id>" (QR cards) or, when the page opens, "?at=<id>" (survives apps that drop the hash). */
const readHash = (initial = false) => {
  try {
    return decodeURIComponent((location.hash || '').slice(1)) || (initial && new URLSearchParams(location.search).get('at')) || '';
  } catch {
    return '';
  }
};

/** `#<siteId>` opens a site; `#<nodeId>` sets "you are here"; `#<nodeId>/<placeId>` (a shared route) sets both. Returns true if the hash named something. */
export function applyHash(initial: boolean) {
  const [h, dest] = readHash(initial).split('/');
  if (!h) return false;
  if (dest) {
    const owner = graphs.find((g) => g.startable.includes(h));
    if (!owner) return false;
    if (initial) {
      enterSite(owner.site.id, h); // boot renders after this
      if (owner.places[dest]) state.dest = dest;
    } else {
      if (owner.site.id !== state.site) switchSite(owner.site.id, h);
      applyTrip(h, dest);
    }
    return true;
  }
  const bySite = graphById(h);
  const owner = bySite ?? graphs.find((g) => g.startable.includes(h));
  if (!owner) return false;
  if (initial) enterSite(owner.site.id, bySite ? null : h);
  else if (owner.site.id !== state.site) switchSite(owner.site.id, bySite ? null : h);
  else if (!bySite) setStart(h);
  return true;
}

export function wireEvents() {
  hooks.onAct = (el) => act(el);
  hooks.onRoom = (id) => goTo(id);
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('#map')) return;
    const el = target.closest<HTMLElement>('[data-act]');
    if (el && !(el as HTMLButtonElement).disabled) {
      act(el);
      return;
    }
    if (!target.closest('.ask')) closeSugg();
  });
  document.addEventListener('keydown', (e) => {
    const el = e.target as HTMLElement;
    if ((e.key === 'Enter' || e.key === ' ') && el.classList?.contains('bdg')) {
      e.preventDefault();
      act(el as unknown as HTMLElement);
      return;
    }
    if (e.key === 'Escape') closeSugg();
    if (state.nav && !/INPUT|TEXTAREA/.test(el.tagName || '')) {
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        act({ dataset: { act: 'next' } });
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        act({ dataset: { act: 'prev' } });
      }
    }
  });
  document.addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.id === 'q') renderSugg();
    if (t.id === 'dq') {
      state.dirQ = t.value;
      const l = $('#dirList');
      if (l) l.innerHTML = dirListHTML();
    }
  });
  document.addEventListener('focusin', (e) => {
    if ((e.target as HTMLElement).id === 'q') renderSugg();
  });
  document.addEventListener('submit', (e) => {
    if ((e.target as HTMLElement).id !== 'askForm') return;
    e.preventDefault();
    const inp = $<HTMLInputElement>('#q'),
      q = inp.value.trim();
    if (!q) return;
    state.query = inp.value;
    closeSugg();
    askGemma(q);
  });
  document.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.id === 'tg-sf') {
      state.stepFree = t.checked;
      recompute();
      renderBody();
      renderMap();
      fitRoute();
    }
    if (t.id === 'tg-lift') {
      state.liftDown = t.checked;
      recompute();
      renderBody();
      renderMap();
      fitRoute();
    }
    if (t.id === 'tg-crowd' || t.id === 'tg-hour') {
      if (t.id === 'tg-crowd') state.avoidCrowd = t.checked;
      else state.hourPick = (t as unknown as HTMLSelectElement).value === '' ? null : Number((t as unknown as HTMLSelectElement).value);
      state.routeIdx = null;
      recompute();
      renderBody();
      renderMap();
      fitRoute();
    }
    if (t.id === 'slipIn') {
      const f = t.files?.[0];
      t.value = '';
      if (f) slipToRoute(f);
    }
    if (t.id === 'tg-offline') {
      state.offlineDemo = t.checked;
      state.aiOn = state.aiAvail && !t.checked;
      state.ai = { status: 'idle' };
      toast(tr(t.checked ? 'offlineOn' : 'offlineOff'));
      refreshLive();
      renderAll(hooks.is3D());
    }
    if (t.id === 'photoIn') {
      const f = t.files?.[0];
      t.value = '';
      if (f) locateByPhoto(f);
    }
  });
  // Keep live counts fresh while choosing a route; stop counting this phone when the page is closed.
  setInterval(() => {
    if (state.dest && !state.nav && document.visibilityState === 'visible') refreshLive();
  }, 20_000);
  window.addEventListener('pagehide', () => endTrip());
  refreshLive();
  window.addEventListener('hashchange', () => {
    applyHash(false);
  });
}
