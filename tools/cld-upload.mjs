// Upload every site photo (public/sites/<site>/photos/*.jpg) to Cloudinary once, as raasta/<site>/<name>,
// so the app can blur faces and paint arrows on them (src/cld.ts). Re-running skips photos already there.
// Usage: VITE_CLOUDINARY_CLOUD=<cloud> VITE_CLOUDINARY_PRESET=raasta node tools/cld-upload.mjs
import { openAsBlob } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

const cloud = process.env.VITE_CLOUDINARY_CLOUD;
const preset = process.env.VITE_CLOUDINARY_PRESET || 'raasta';
if (!cloud) {
  console.error('Set VITE_CLOUDINARY_CLOUD (and an UNSIGNED preset in VITE_CLOUDINARY_PRESET, default "raasta").');
  process.exit(1);
}

const root = path.join(import.meta.dirname, '..', 'public', 'sites');
let ok = 0,
  failed = 0;
for (const site of await readdir(root)) {
  const dir = path.join(root, site, 'photos');
  const files = await readdir(dir).catch(() => []);
  await Promise.all(
    files
      .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
      .map(async (f) => {
        const fd = new FormData();
        fd.append('file', await openAsBlob(path.join(dir, f)), f);
        fd.append('upload_preset', preset);
        fd.append('public_id', `raasta/${site}/${f.replace(/\.\w+$/, '')}`);
        fd.append('tags', `raasta,raasta-${site}`);
        const r = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/image/upload`, { method: 'POST', body: fd });
        const b = await r.json().catch(() => ({}));
        if (r.ok) ok++;
        else {
          failed++;
          console.error(`✗ ${site}/${f}: ${b.error?.message || r.status}`);
        }
      }),
  );
}
console.log(`uploaded ${ok}, failed ${failed}`);
process.exit(failed ? 1 : 0);
