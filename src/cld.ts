// Every real photo in Raasta is delivered by Cloudinary: faces blurred (patients and visitors in a corridor are
// nobody's business), light fixed, cropped and compressed for the phone, and the step's arrow plus a Hindi +
// English instruction painted onto the photo itself. One URL per step; Cloudinary makes and caches it.
// Without VITE_CLOUDINARY_CLOUD the app falls back to the plain local photos.

const CLOUD = import.meta.env.VITE_CLOUDINARY_CLOUD as string | undefined;
export const PRESET = (import.meta.env.VITE_CLOUDINARY_PRESET as string | undefined) || 'raasta';
export const cldOn = !!CLOUD;
const BASE = `https://res.cloudinary.com/${CLOUD}/image/upload`;

/** Free text inside a transformation: `,` and `/` are syntax, so they are double-escaped. */
export const txt = (s: string) => encodeURIComponent(s).replace(/%2C/g, '%252C').replace(/%2F/g, '%252F');

/**
 * "/sites/cb/photos/cb-plaza.jpg" → "raasta/cb/cb-plaza" (the id tools/cld-upload.mjs gives it);
 * "cld:raasta/hospital/staff-g-07-…" (a photo staff took in the admin panel) → its id.
 */
export function photoId(src: string): string | null {
  if (src.startsWith('cld:')) return src.slice(4);
  const m = /sites\/([a-z0-9-]+)\/photos\/([\w-]+)\.\w+$/.exec(src);
  return m ? `raasta/${m[1]}/${m[2]}` : null;
}

/** Staff photo straight from the phone to Cloudinary (unsigned preset). Resolves to its public id. */
export async function uploadSpotPhoto(file: File, site: string, placeId: string): Promise<string> {
  if (!CLOUD) throw new Error('Cloudinary is not set up (VITE_CLOUDINARY_CLOUD).');
  const fd = new FormData();
  fd.append('file', file);
  fd.append('upload_preset', PRESET);
  // Unsigned uploads cannot overwrite, so every new photo of a spot gets its own id.
  fd.append('public_id', `raasta/${site}/staff-${placeId.toLowerCase().replace(/[^\w-]/g, '-')}-${Date.now().toString(36)}`);
  fd.append('tags', `raasta,raasta-${site},staff-photo`);
  const r = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD}/image/upload`, { method: 'POST', body: fd });
  const b = await r.json().catch(() => null);
  if (!r.ok || !b?.public_id) throw new Error(b?.error?.message || `Upload failed (${r.status})`);
  return b.public_id as string;
}

export interface Paint {
  arrow?: string; // one glyph: ← → ↑ ↓ ↕
  label?: string; // short, bilingual
}

const PRIVACY = 'e_blur_faces:800/e_improve';

/** A step photo with its arrow and instruction drawn on, 16:9, sized for the phone. */
export function stepPhoto(src: string, paint: Paint = {}, w = 960): string {
  const id = photoId(src);
  if (!CLOUD || !id) return src;
  const k = w / 960;
  const px = (n: number) => Math.round(n * k);
  const parts = [PRIVACY, `c_fill,g_auto,w_${w},h_${px(540)}`];
  if (paint.arrow)
    parts.push(
      `l_text:Arial_${px(120)}_bold:${txt(paint.arrow)},co_white,b_rgb:2563eb,bo_${px(22)}px_solid_rgb:2563eb/r_${px(28)}/fl_layer_apply,g_center,y_${px(-40)}`,
    );
  if (paint.label)
    parts.push(
      `l_text:Hind_${px(40)}_bold:${txt(paint.label)},co_white,b_rgb:0f172a,bo_${px(16)}px_solid_rgb:0f172a,w_${px(880)},c_fit/fl_layer_apply,g_south,y_${px(26)}`,
    );
  parts.push('f_auto,q_auto');
  return `${BASE}/${parts.join('/')}/${id}`;
}

/** A place photo (destination card): privacy blur and light fix, no paint. */
export function placePhoto(src: string, w = 720): string {
  const id = photoId(src);
  return CLOUD && id ? `${BASE}/${PRIVACY}/c_fill,g_auto,w_${w},h_${Math.round((w * 9) / 16)}/f_auto,q_auto/${id}` : src;
}
