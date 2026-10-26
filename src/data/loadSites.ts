import type { Site } from './types';
import { validateSite } from './validate.js';
import { applyEdits, cleanEdits } from './edits.js';
import { timeoutSignal } from '../compat.js';

/** Fill in defaults the JSON leaves out. Pure: returns a new site, never mutates the input. */
export function normalizeSite(raw: Site): Site {
  const f0 = raw.floors[0].id;
  return {
    ...raw,
    points: raw.points.map((p) => ({ ...p, floor: p.floor ?? f0 })),
    cores: raw.cores.map((c) => ({ ...c, floor: c.floor ?? f0 })),
    places: raw.places.map((p) => ({
      ...p,
      floor: p.floor ?? f0,
      code: p.code ?? p.id,
      num: p.num ?? /^(\d|[A-Z]-\d)/.test(p.id), // room numbers print as "302 Ward", others by name only
    })),
  };
}

export function parseSite(raw: unknown): Site {
  const site = normalizeSite(raw as Site);
  const errs = validateSite(site);
  if (errs.length) throw new Error(`Invalid site "${site.id}":\n- ${errs.join('\n- ')}`);
  return site;
}

export const SITE_IDS = ['hospital'];

/** Staff edits from the admin panel; none when offline or the server is slow (the app never waits long for them). */
async function fetchEdits(id: string): Promise<unknown> {
  try {
    const r = await fetch(`/api/admin?site=${id}`, { signal: timeoutSignal(2000) });
    return r.ok ? await r.json() : undefined;
  } catch {
    return undefined;
  }
}

/** Fetch every site from `<base>/sites/<id>/site.json` plus its staff edits. Photo/plan paths are resolved to full URLs. */
export async function loadSites(base = import.meta.env.BASE_URL, ids = SITE_IDS): Promise<Site[]> {
  return Promise.all(
    ids.map(async (id) => {
      const dir = `${base}sites/${id}/`;
      const [res, edits] = await Promise.all([fetch(dir + 'site.json'), fetchEdits(id)]);
      if (!res.ok) throw new Error(`Could not load site ${id} (${res.status})`);
      const raw = (await res.json()) as Site;
      const site = parseSite(edits ? applyEdits(raw, cleanEdits(raw, edits)) : raw);
      const photos = Object.fromEntries(Object.entries(site.photos ?? {}).map(([k, v]) => [k, v.startsWith('cld:') ? v : dir + v]));
      const planImg = site.planImg && Object.fromEntries(Object.entries(site.planImg).map(([k, v]) => [k, { ...v, src: dir + v.src }]));
      return { ...site, photos, planImg };
    }),
  );
}
