// GET  /api/admin?site=<id> → {notice?, places} the staff edits (public: the app lays them over site.json on load)
// POST /api/admin {siteId, edits?} with header x-admin-key: <ADMIN_PASSWORD> → saves the edits (admin.html).
//      Without `edits` it only checks the password. Off (403) when ADMIN_PASSWORD is unset.
import { createHash, timingSafeEqual } from 'node:crypto';
import { edits, fail, graphs, json, rateLimited, readJson, setEdits } from './_lib.js';

const hash = (s: string) => createHash('sha256').update(s).digest();
const allowed = (req: Request) => {
  const pw = process.env.ADMIN_PASSWORD;
  return !!pw && timingSafeEqual(hash(pw), hash(req.headers.get('x-admin-key') || ''));
};

export function GET(req: Request): Response {
  const id = new URL(req.url).searchParams.get('site') || '';
  if (!graphs[id]) return fail('bad_request');
  return json(edits[id] ?? { places: {} });
}

export async function POST(req: Request): Promise<Response> {
  if (rateLimited(req, 10, 60_000, 'admin')) return fail('rate_limited');
  if (!process.env.ADMIN_PASSWORD) return json({ error: 'admin_off' }, 403);
  if (!allowed(req)) return json({ error: 'forbidden' }, 403);
  const b = await readJson(req);
  const id = b?.siteId;
  if (!b || typeof id !== 'string' || !graphs[id]) return fail('bad_request');
  if (!('edits' in b)) return json(edits[id] ?? { places: {} });
  return json(setEdits(id, b.edits));
}
