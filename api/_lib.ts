// Shared server code for the api/ functions (files starting with "_" are not deployed as endpoints).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import { z } from 'zod';
import { parseSite } from '../src/data/loadSites.js';
import { applyEdits, cleanEdits, type Edits } from '../src/data/edits.js';
import { buildGraph } from '../src/engine/graph.js';
import type { Graph, Site } from '../src/data/types';
import hospital from '../public/sites/hospital/site.json' with { type: 'json' };

// Static imports so the serverless bundle carries the site data with it.
const RAW: Record<string, Site> = { hospital: hospital as unknown as Site };

// Staff edits from the admin panel, laid over site.json.
// ponytail: a JSON file next to the app (fine for a laptop or a hospital's own server); on Vercel the disk is
// read-only, so edits live in memory until the instance restarts. Move to Vercel Blob / Redis for a real cloud deploy.
const EDITS_FILE = () => process.env.RAASTA_EDITS_FILE || '.data/edits.json';
export const edits: Record<string, Edits> = (() => {
  try {
    return JSON.parse(readFileSync(EDITS_FILE(), 'utf8'));
  } catch {
    return {};
  }
})();
const build = (id: string) => buildGraph(parseSite(applyEdits(RAW[id], edits[id] && cleanEdits(RAW[id], edits[id]))));

export const graphs: Record<string, Graph> = Object.fromEntries(Object.keys(RAW).map((id) => [id, build(id)]));

/** Save a site's staff edits; the routes and Gemma's place list use them from the next request on. */
export function setEdits(id: string, raw: unknown): Edits {
  const e = cleanEdits(RAW[id], raw);
  edits[id] = e;
  graphs[id] = build(id);
  prefixCache.delete(id);
  try {
    mkdirSync(dirname(EDITS_FILE()), { recursive: true });
    writeFileSync(EDITS_FILE(), JSON.stringify(edits, null, 2));
  } catch {
    /* read-only disk (Vercel): memory only */
  }
  return e;
}

// Gemma 4 (QAT build: the default e2b tag does not fit in 8 GB RAM) runs on this machine through Ollama (https://ollama.com): no API key, no internet once the model is pulled.
export const MODEL = () => process.env.GEMMA_MODEL || 'gemma4:e2b-it-qat';
/** What the UI / docs should call the model. */
export const MODEL_LABEL = () =>
  (process.env.GEMINI_API_KEY ? `${GEMINI_MODEL()} (Gemini API)` : `${MODEL()} (Ollama)`) +
  (process.env.ANTHROPIC_API_KEY ? ` + ${CLAUDE_MODEL()} backup` : '');
const OLLAMA_URL = () => (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
/** Is Ollama reachable right now? (2 s probe; false on a cloud host without Ollama, so the page hides the AI buttons.) */
export async function hasKey() {
  if (process.env.GEMINI_API_KEY || process.env.ANTHROPIC_API_KEY) return true;
  try {
    const r = await fetch(`${OLLAMA_URL()}/api/tags`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

export interface ChatBody {
  model: string;
  stream: false;
  think: false;
  format: unknown;
  options: { temperature: number; num_ctx: number; num_predict?: number };
  keep_alive: string;
  messages: { role: 'user'; content: string; images?: string[] }[];
}
async function ollamaChat(body: ChatBody, signal: AbortSignal): Promise<string> {
  const r = await fetch(`${OLLAMA_URL()}/api/chat`, { method: 'POST', body: JSON.stringify(body), signal });
  if (!r.ok) throw new Error(`ollama ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = (await r.json()) as {
    message?: { content?: string };
    prompt_eval_count?: number;
    prompt_eval_duration?: number;
    eval_count?: number;
    eval_duration?: number;
  };
  const s = (ns = 0) => (ns / 1e9).toFixed(1) + 's';
  console.log(`[gemma] prompt ${d.prompt_eval_count} tok ${s(d.prompt_eval_duration)} · reply ${d.eval_count} tok ${s(d.eval_duration)}`);
  return d.message?.content ?? '';
}
// Same model through Google's Gemini API (set GEMINI_API_KEY): for a cloud host where there is no Ollama.
// https://ai.google.dev/gemma/docs/core/gemma_on_gemini_api
const GEMINI_MODEL = () => process.env.GEMINI_MODEL || 'gemma-4-26b-a4b-it';
async function geminiChat(body: ChatBody, signal: AbortSignal): Promise<string> {
  const m = body.messages[0];
  const parts: Record<string, unknown>[] = [
    { text: `${m.content}\n\nAnswer with JSON only, no prose, matching this JSON schema:\n${JSON.stringify(body.format)}` },
  ];
  for (const img of m.images ?? []) parts.push({ inlineData: { mimeType: 'image/jpeg', data: img } });
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL()}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY || '' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: body.options.temperature, maxOutputTokens: 2048 },
    }),
    signal,
  });
  // Google's side returns the odd 500/503; one retry covers it.
  if (r.status >= 500 && !signal.aborted && !(body as { _retried?: boolean })._retried)
    return geminiChat({ ...body, _retried: true } as ChatBody, signal);
  if (!r.ok) throw new Error(`gemini ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = (await r.json()) as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[] };
  // Gemma 4 on the Gemini API thinks first (parts flagged `thought`); the answer is the rest.
  const text =
    d.candidates?.[0]?.content?.parts
      ?.filter((p) => !p.thought)
      .map((p) => p.text ?? '')
      .join('') ?? '';
  console.log(`[gemma/gemini] ${GEMINI_MODEL()} replied ${text.length} chars`);
  // Gemma likes to wrap JSON in ```json fences.
  return text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
}
// Backup: Claude through the Anthropic API (set ANTHROPIC_API_KEY). Answers when Gemma is slow or fails.
const CLAUDE_MODEL = () => process.env.CLAUDE_MODEL || 'claude-haiku-5-5';
const CLAUDE_VISION_MODEL = () => process.env.CLAUDE_VISION_MODEL || CLAUDE_MODEL();
const imageType = (b64: string): Anthropic.Beta.BetaBase64ImageSource['media_type'] =>
  b64.startsWith('iVBOR') ? 'image/png' : b64.startsWith('UklGR') ? 'image/webp' : 'image/jpeg';
/** Claude's structured outputs need a type on every property; drop the loose ones (e.g. Gemma's optional `confidence`). */
function claudeSchema(f: unknown): { type: 'object' } {
  const s = f as { type: 'object'; properties?: Record<string, Record<string, unknown>>; required?: string[] };
  const properties = Object.fromEntries(Object.entries(s.properties ?? {}).filter(([, v]) => v.type || v.anyOf || v.enum));
  return { ...s, properties, required: (s.required ?? []).filter((k) => k in properties) } as { type: 'object' };
}
let anthropic: Anthropic | undefined;
async function claudeChat(body: ChatBody, signal: AbortSignal): Promise<string> {
  anthropic ??= new Anthropic({ maxRetries: 0 });
  const m = body.messages[0];
  const model = m.images?.length ? CLAUDE_VISION_MODEL() : CLAUDE_MODEL();
  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    ...(m.images ?? []).map((data) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: imageType(data), data } })),
    { type: 'text', text: m.content },
  ];
  const r = await anthropic.beta.messages.create(
    {
      model,
      max_tokens: 4096,
      // Low effort: a short JSON answer, and the visitor is waiting.
      output_config: { effort: 'low', format: jsonSchemaOutputFormat(claudeSchema(body.format)) },
      messages: [{ role: 'user', content }],
      // Server-side fallback if a safety classifier declines (not offered on Haiku).
      ...(model.startsWith('claude-haiku') ? {} : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }),
    },
    { signal },
  );
  if (r.stop_reason === 'refusal') throw new Error('claude refused');
  const text = r.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  console.log(`[claude] ${r.model} replied ${text.length} chars`);
  return text;
}

/** How long Gemma gets before Claude takes over (only when ANTHROPIC_API_KEY is set). */
const GEMMA_WAIT = () => Number(process.env.GEMMA_WAIT_MS) || 5000;
async function defaultChat(body: ChatBody, signal: AbortSignal): Promise<string> {
  const backup = !!process.env.ANTHROPIC_API_KEY;
  // The 5 s cut applies to the cloud Gemma only; local Ollama may need longer to load the model the first time.
  const primary = process.env.GEMINI_API_KEY
    ? geminiChat(body, backup ? AbortSignal.any([signal, AbortSignal.timeout(GEMMA_WAIT())]) : signal)
    : ollamaChat(body, signal);
  if (!backup) return primary;
  try {
    return await primary;
  } catch (err) {
    if (signal.aborted) throw err;
    console.log('[ai] Gemma slow or failed, asking Claude:', err instanceof Error ? err.message : err);
    return claudeChat(body, signal);
  }
}

/** Overridable in tests. */
export const ai = {
  chat: defaultChat,
  set: (fn: typeof ollamaChat | null) => {
    ai.chat = fn ?? defaultChat;
  },
};

/** One prompt (+ optional raw base64 image) → JSON matching `schema`, or null if Gemma's answer does not fit it. */
export async function gemma<T extends z.ZodType>(
  schema: T,
  prompt: string,
  opts: { image?: string; timeout: number; signal: AbortSignal },
): Promise<z.infer<T> | null> {
  const text = await ai.chat(
    {
      model: MODEL(),
      stream: false,
      think: false,
      format: z.toJSONSchema(schema),
      // The place list + rules are ~4.1k tokens; the context must hold all of it or Ollama truncates and the prompt cache never hits.
      options: { temperature: 0, num_ctx: 6144 },
      // Stay loaded between visitors (Ollama's default is 5 min).
      keep_alive: process.env.OLLAMA_KEEP_ALIVE || '20m',
      messages: [{ role: 'user', content: prompt, ...(opts.image ? { images: [opts.image] } : {}) }],
    },
    AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeout)]),
  );
  try {
    const r = schema.safeParse(JSON.parse(text));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** Accept "101" and also "101 Blood Bank" / "101 | Blood Bank" from a small model; null if nothing valid. */
export function idOf(raw: string | null | undefined, ok: (id: string) => boolean): string | null {
  if (!raw) return null;
  if (ok(raw)) return raw;
  const t = raw.trim().split(/[\s|:,]/)[0];
  return t && ok(t) ? t : null;
}

export type ErrCode = 'bad_request' | 'no_key' | 'rate_limited' | 'too_large' | 'timeout' | 'refused' | 'upstream';
const STATUS: Record<ErrCode, number> = {
  bad_request: 400,
  no_key: 503,
  rate_limited: 429,
  too_large: 413,
  timeout: 504,
  refused: 422,
  upstream: 502,
};

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
export const fail = (code: ErrCode) => json({ error: code }, STATUS[code]);

/** Map Ollama / network errors to our small set of codes. */
export function failFrom(err: unknown) {
  if (err instanceof Error && err.name === 'TimeoutError') return fail('timeout');
  // Ollama not running: same as "no AI" so the page falls back to the offline search.
  if (err instanceof TypeError && err.message === 'fetch failed') return fail('no_key');
  console.error('[raasta api]', err instanceof Error ? err.message : err);
  return fail('upstream');
}

// ponytail: in-memory per-instance limiter; move to a shared store (e.g. Upstash) if abuse shows up across instances.
const hits = new Map<string, number[]>();
export function rateLimited(req: Request, max = 20, windowMs = 60_000, bucket = 'ai') {
  const ip = bucket + '|' + (req.headers.get('x-forwarded-for') || 'local').split(',')[0].trim();
  const now = Date.now(),
    list = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(ip, list);
  return list.length > max;
}

export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = await req.json();
    return b && typeof b === 'object' && !Array.isArray(b) ? b : null;
  } catch {
    return null;
  }
}

// ---------- prompts (ported from the prototype's buildAskPrompt / buildPhotoPrompt) ----------

const spotEn = (g: Graph, id: string) => {
  const n = g.nodes[id],
    r = n.ref as { en?: string } | undefined;
  if (n.kind === 'lift' || n.kind === 'stairs') return r?.en || (n.kind === 'lift' ? 'Lift lobby' : 'Stairs');
  return r?.en ?? id;
};

/**
 * Everything that does not change between visitors (place list, spots, rules) comes FIRST and the visitor's
 * words LAST: Ollama reuses the KV cache of an identical prompt prefix, so after `warm()` each request only
 * has to read the ~60 new tokens at the end instead of the ~5k-token place list (10 s+ on a laptop).
 */
const prefixCache = new Map<string, string>();
export function askPrefix(g: Graph) {
  let pre = prefixCache.get(g.site.id);
  if (pre) return pre;
  const S = g.site,
    FL = g.floors;
  // English names only: Devanagari costs 2-3x the tokens and Gemma maps Hindi/Hinglish to these names itself.
  const list = S.places.map((p) => `${p.id} | ${p.en} | ${FL[p.floor].en}`).join('\n');
  // Every place above is also a spot; list only what is not already there (gates, lifts, stairs) to keep the prompt short.
  const spots = g.startable
    .filter((id) => g.nodes[id].kind !== 'place')
    .map((id) => `${id} | ${spotEn(g, id)} | ${FL[g.nodes[id].floor].en}`)
    .join('\n');
  const wcs = g.wc.length
    ? `\n- For toilets, pick the one closest to the visitor, preferring their current floor: ${g.wc.join(', ')}.`
    : '';
  pre = `You are the wayfinding assistant on an indoor navigation page for "${S.name.en}".

Places a visitor can be taken to (id | name | floor):
${list}

Other spots where a visitor can be standing, besides the places above (id | name | floor):
${spots}

Rules:
${S.aiRules || ''}${wcs}
- People talk naturally and in mixed Hindi/English, with spelling mistakes, in Devanagari or Latin letters. They may
  talk about someone else ("papa ICU mein hain, unse milna hai" → the ICU or its waiting area) or give a reason
  ("report leni hai" → report collection). Understand the intent, not just the words.
- If they say where they are now (a room number, a place, "outside / near X", "registration ke paas"), set start_id to
  that spot's id; otherwise start_id is null.
- If they only say where they are and not where to go, destination_id is null and the reply confirms where they are
  and asks where they would like to go.
- If nothing fits, destination_id is null.
- destination_id and start_id are ids copied exactly from the lists above (for example "101"), never names.
- Examples: "mausa ko blood chahiye" → destination_id = the Blood Bank's id, start_id = null.
  "main 301 mein hoon, mujhe x-ray karwana hai" → start_id = "301", destination_id = the X-Ray's id.
  "registration ke paas khada hoon" → start_id = Registration's id, destination_id = null.

`;
  prefixCache.set(S.id, pre);
  return pre;
}

export function buildAskPrompt(g: Graph, q: string, start: string) {
  const sn = g.nodes[start];
  return `${askPrefix(g)}The visitor is currently at: ${start} (${spotEn(g, start)}, ${g.floors[sn.floor].en}).

The visitor typed this request (it may be Hindi, Hinglish or English):
"""${q.slice(0, 300)}"""`;
}

/** Pre-fill Ollama's KV cache with the static prefix so the first real question is fast. Fire-and-forget. */
let warmed = false;
export function warm() {
  if (warmed) return;
  warmed = true;
  for (const g of Object.values(graphs))
    ai.chat(
      {
        model: MODEL(),
        stream: false,
        think: false,
        format: 'json',
        options: { temperature: 0, num_ctx: 6144, num_predict: 1 },
        keep_alive: process.env.OLLAMA_KEEP_ALIVE || '20m',
        messages: [{ role: 'user', content: askPrefix(g) }],
      },
      AbortSignal.timeout(300_000),
    ).catch(() => {});
}

/** "Blood Bank is on the First Floor. The route is on your screen." in both languages, from the site data (never wrong about the floor). */
export function sayDest(g: Graph, id: string) {
  const p = g.site.places.find((x) => x.id === id);
  if (!p) return { reply_en: '', reply_hi: '' };
  const f = g.floors[p.floor];
  return {
    reply_en: `${p.en} is on the ${f.en}. The route is on your screen.`,
    reply_hi: `${p.hi} ${f.hi} पर है। रास्ता स्क्रीन पर है।`,
  };
}

function signText(g: Graph, id: string) {
  const n = g.nodes[id],
    FL = g.floors;
  if (n.kind === 'lift' || n.kind === 'stairs') {
    const c = n.ref as { en?: string; hi?: string };
    return `${c.en || (n.kind === 'lift' ? 'Lift' : 'Stairs')} · ${FL[n.floor].en}`;
  }
  const p = n.ref as { num?: boolean; id: string; en: string; hi: string };
  return `${p.num ? p.id + ' ' : ''}${p.en}`;
}

export function buildPhotoPrompt(g: Graph) {
  const spots = g.startable.map((id) => `${id} | ${signText(g, id)} | ${g.floors[g.nodes[id].floor].en}`).join('\n');
  return `This photo was taken by a visitor inside "${g.site.name.en}". It should show a sign, board or door near where they are standing.

Read any room number, room or department name, or floor name on it (Hindi or English; Hindi text names the same places as the English list below). Then match it to exactly one spot in this list (id | sign text | floor):
${spots}

Match on room numbers, names and floor names, not on how the corridor looks. If the photo has no readable sign, or the sign matches nothing in the list, use null for node_id.
text_read: the main text you can read on the sign.`;
}
