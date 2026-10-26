// POST /api/ask {siteId, query, startId, lang} → {destination_id, start_id, reply_en, reply_hi}
import { z } from 'zod';
import { buildAskPrompt, fail, failFrom, gemma, graphs, idOf, json, rateLimited, readJson, sayDest } from './_lib.js';

const Answer = z.object({
  destination_id: z.string().nullable(),
  start_id: z.string().nullable(),
  confidence: z.unknown().optional(),
});

export async function POST(req: Request): Promise<Response> {
  if (rateLimited(req)) return fail('rate_limited');
  const b = await readJson(req);
  const g = b && typeof b.siteId === 'string' ? graphs[b.siteId] : undefined;
  const query = b && typeof b.query === 'string' ? b.query.trim() : '';
  const start = b && typeof b.startId === 'string' && g?.startable.includes(b.startId) ? b.startId : g?.site.defaults.start;
  if (!g || !query || !start) return fail('bad_request');

  try {
    const o = await gemma(Answer, buildAskPrompt(g, query, start), { timeout: 60_000, signal: req.signal });
    if (!o) return fail('upstream');
    // Never trust ids from the model: keep only ones that exist in this site.
    const dest = idOf(o.destination_id, (id) => !!g.places[id]);
    // The sentence comes from the data, not the model: a 2B model gets the floor wrong; the page has templates for the other cases.
    return json({
      destination_id: dest,
      start_id: idOf(o.start_id, (id) => g.startable.includes(id)),
      ...(dest ? sayDest(g, dest) : { reply_en: '', reply_hi: '' }),
    });
  } catch (err) {
    return failFrom(err);
  }
}
