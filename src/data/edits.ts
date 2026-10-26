import type { Site } from './types';

/**
 * Changes hospital staff make in the admin panel (admin.html): new room names, room numbers, keywords and the
 * notice line. Kept apart from site.json (which is generated) and laid over it when a site loads.
 */
export const EDIT_FIELDS = ['en', 'hi', 'enS', 'hiS', 'code', 'kw'] as const;
/** `photo`: the Cloudinary public id of a photo staff took of this spot (see src/cld.ts). */
export type PlaceEdit = Partial<Record<(typeof EDIT_FIELDS)[number], string>> & { photo?: string };
/** Only photos in our own Cloudinary folder are accepted. */
const PHOTO_ID = /^raasta\/[\w-]+(?:\/[\w-]+)*$/;
export interface Edits {
  /** Replaces site.json's notice; null hides it. */
  notice?: { en: string; hi: string } | null;
  places: Record<string, PlaceEdit>;
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Keep only known place ids and fields, non-empty strings, capped lengths. Anything else is dropped. */
export function cleanEdits(site: Pick<Site, 'places'>, raw: unknown): Edits {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const ids = new Set(site.places.map((p) => p.id));
  const places: Record<string, PlaceEdit> = {};
  const rp = r.places && typeof r.places === 'object' ? (r.places as Record<string, unknown>) : {};
  for (const [id, e] of Object.entries(rp)) {
    if (!ids.has(id) || !e || typeof e !== 'object') continue;
    const pe: PlaceEdit = {};
    for (const f of EDIT_FIELDS) {
      const v = str((e as Record<string, unknown>)[f], f === 'kw' ? 400 : 80);
      if (v) pe[f] = v;
    }
    const ph = str((e as Record<string, unknown>).photo, 160);
    if (PHOTO_ID.test(ph)) pe.photo = ph;
    if (Object.keys(pe).length) places[id] = pe;
  }
  const out: Edits = { places };
  const n = r.notice as Record<string, unknown> | null | undefined;
  if (n === null) out.notice = null;
  else if (n && typeof n === 'object') {
    const en = str(n.en, 300),
      hi = str(n.hi, 300);
    if (en || hi) out.notice = { en: en || hi, hi: hi || en };
  }
  return out;
}

/** site.json with the staff edits on top. Pure. Staff photos become `cld:<public id>` entries in `photos`. */
export function applyEdits<T extends Pick<Site, 'places' | 'notice'> & Partial<Pick<Site, 'photos'>>>(raw: T, e?: Edits): T {
  if (!e) return raw;
  const staffPhotos = Object.entries(e.places).flatMap(([id, pe]) => (pe.photo ? [[id, 'cld:' + pe.photo]] : []));
  return {
    ...raw,
    places: raw.places.map((p) => {
      if (!e.places[p.id]) return p;
      const { photo: _photo, ...text } = e.places[p.id];
      return { ...p, ...text };
    }),
    ...(staffPhotos.length ? { photos: { ...raw.photos, ...Object.fromEntries(staffPhotos) } } : {}),
    ...(e.notice === undefined ? {} : { notice: e.notice ?? undefined }),
  };
}
