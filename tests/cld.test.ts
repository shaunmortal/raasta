import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyEdits, cleanEdits } from '../src/data/edits';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const withCloud = async () => {
  vi.stubEnv('VITE_CLOUDINARY_CLOUD', 'testcloud');
  return import('../src/cld');
};

describe('Cloudinary step photos', () => {
  it('maps site photos and staff photos to public ids', async () => {
    const { photoId } = await withCloud();
    expect(photoId('/sites/cb/photos/cb-plaza.jpg')).toBe('raasta/cb/cb-plaza');
    expect(photoId('cld:raasta/hospital/staff-g-07-abc')).toBe('raasta/hospital/staff-g-07-abc');
    expect(photoId('https://example.com/x.jpg')).toBeNull();
  });

  it('blurs faces, paints the arrow and a bilingual line, and escapes text', async () => {
    const { stepPhoto } = await withCloud();
    const u = stepPhoto('/sites/cb/photos/cb-plaza.jpg', { arrow: '←', label: 'बाएँ मुड़ें, Turn left' });
    expect(u).toMatch(/^https:\/\/res\.cloudinary\.com\/testcloud\/image\/upload\/e_blur_faces:800\/e_improve\//);
    expect(u).toContain('l_text:Arial_120_bold:%E2%86%90');
    expect(u).toContain('%252C%20Turn%20left'); // a comma in text would otherwise end the parameter
    expect(u.endsWith('/f_auto,q_auto/raasta/cb/cb-plaza')).toBe(true);
  });

  it('falls back to the local photo when Cloudinary is not configured', async () => {
    vi.stubEnv('VITE_CLOUDINARY_CLOUD', '');
    const { stepPhoto } = await import('../src/cld');
    expect(stepPhoto('/sites/cb/photos/cb-plaza.jpg', { arrow: '→' })).toBe('/sites/cb/photos/cb-plaza.jpg');
  });
});

describe('staff photos in admin edits', () => {
  const site = { places: [{ id: 'G-07' }, { id: 'G-09' }], notice: undefined, photos: { X: 'photos/x.jpg' } } as never;

  it('keeps only photos from our own Cloudinary folder', () => {
    const e = cleanEdits(site, { places: { 'G-07': { photo: 'raasta/hospital/staff-g-07-x' }, 'G-09': { photo: '../evil' } } });
    expect(e.places['G-07']).toEqual({ photo: 'raasta/hospital/staff-g-07-x' });
    expect(e.places['G-09']).toBeUndefined();
  });

  it('turns staff photos into cld: entries and keeps place fields clean', () => {
    const out = applyEdits(site, { places: { 'G-07': { en: 'Medicine OPD', photo: 'raasta/hospital/staff-g-07-x' } } }) as never as {
      places: Record<string, unknown>[];
      photos: Record<string, string>;
    };
    expect(out.photos).toEqual({ X: 'photos/x.jpg', 'G-07': 'cld:raasta/hospital/staff-g-07-x' });
    expect(out.places[0]).toEqual({ id: 'G-07', en: 'Medicine OPD' });
  });
});
