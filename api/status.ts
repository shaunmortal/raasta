// GET /api/status → {ai, live, demo}. Lets the page hide Gemma-only features when no key is configured,
// and tells it the live walker counter is reachable (the page falls back to offline estimates otherwise).
import { hasKey, json, warm } from './_lib.js';

export async function GET(): Promise<Response> {
  const ai = await hasKey();
  if (ai) warm();
  return json({ ai, live: true, demo: process.env.RAASTA_DEMO === '1' });
}
