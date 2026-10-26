// POST /api/slip {siteId, image: "data:image/jpeg;base64,..."} → {destination_id, reply_en, reply_hi, text_read}
// Reads an OPD slip / prescription photo and finds the department or room it sends the patient to.
// The slip has personal details on it: the prompt tells Gemma not to repeat them, nothing is stored, and only
// a place id from this building is returned.
import { z } from 'zod';
import { fail, failFrom, gemma, graphs, idOf, json, rateLimited, readJson, sayDest } from './_lib.js';

const Answer = z.object({
  destination_id: z.string().nullable(),
  text_read: z.string(),
});
const MEDIA = ['image/jpeg', 'image/png', 'image/webp'] as const;
const MAX_B64 = 4_000_000;

export async function POST(req: Request): Promise<Response> {
  if (rateLimited(req, 8)) return fail('rate_limited');
  const b = await readJson(req);
  const g = b && typeof b.siteId === 'string' ? graphs[b.siteId] : undefined;
  const m = b && typeof b.image === 'string' ? /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)$/.exec(b.image) : null;
  if (!g || !m || !MEDIA.includes(m[1] as never)) return fail('bad_request');
  if (m[2].length > MAX_B64) return fail('too_large');

  const list = g.site.places
    .filter((p) => !p.gate)
    .map((p) => `${p.id} | ${p.en} | ${g.floors[p.floor].en}`)
    .join('\n');
  const prompt = `This is a photo of a hospital slip from "${g.site.name.en}": an OPD slip ("parchi"), a registration card, a prescription or a test request. It may be in Hindi or English, printed or handwritten.

Find where it sends the patient: the department, OPD, room number, test or counter. Match it to exactly one place in this list (id | name | floor; Hindi words on the slip name the same places):
${list}

Rules:
- If the slip names a department, pick that department's OPD. If it names a room number that is in the list, use it.
- If it lists several places (for example an OPD and then tests), pick the first place the patient should go now.
- If nothing on the slip matches a place, destination_id is null.
- Do NOT copy any personal details (patient name, age, sex, phone, address, ID or registration numbers) into any field.
- text_read: only the department / room / test words you used, nothing personal.`;

  try {
    const o = await gemma(Answer, prompt, { image: m[2], timeout: 90_000, signal: req.signal });
    if (!o) return fail('upstream');
    const dest = idOf(o.destination_id, (id) => !!g.places[id] && !g.places[id].gate);
    return json({
      destination_id: dest,
      ...(dest ? sayDest(g, dest) : { reply_en: '', reply_hi: '' }),
      text_read: o.text_read.slice(0, 120),
    });
  } catch (err) {
    return failFrom(err);
  }
}
