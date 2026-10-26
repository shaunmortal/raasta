import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.RAASTA_EDITS_FILE = join(mkdtempSync(join(tmpdir(), 'raasta-')), 'edits.json');
const { GET, POST } = await import('../api/admin');
const { askPrefix, graphs } = await import('../api/_lib');

let ipN = 0;
const post = (body: unknown, key?: string) =>
  POST(
    new Request('http://x/api/admin', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'x-forwarded-for': `10.8.0.${++ipN}`, ...(key === undefined ? {} : { 'x-admin-key': key }) },
    }),
  );

describe('admin api', () => {
  it('is off without ADMIN_PASSWORD and refuses a wrong password', async () => {
    delete process.env.ADMIN_PASSWORD;
    expect((await post({ siteId: 'hospital' }, 'x')).status).toBe(403);
    process.env.ADMIN_PASSWORD = 'staff123';
    expect((await post({ siteId: 'hospital' }, 'wrong')).status).toBe(403);
    expect((await post({ siteId: 'hospital' })).status).toBe(403);
    expect((await post({ siteId: 'hospital' }, 'staff123')).status).toBe(200);
  });

  it('saves a rename that routes, search and Gemma all see; drops unknown ids and fields', async () => {
    process.env.ADMIN_PASSWORD = 'staff123';
    const r = await post(
      {
        siteId: 'hospital',
        edits: {
          places: { 'GF-PHARM': { en: 'Medicine Store', kw: 'dawai', via: 'X' }, NOPE: { en: 'x' } },
          notice: { en: 'Lift B closed today', hi: '' },
        },
      },
      'staff123',
    );
    expect(r.status).toBe(200);
    const saved = await r.json();
    expect(saved.places).toEqual({ 'GF-PHARM': { en: 'Medicine Store', kw: 'dawai' } });
    expect(saved.notice).toEqual({ en: 'Lift B closed today', hi: 'Lift B closed today' });
    const p = graphs.hospital.site.places.find((x) => x.id === 'GF-PHARM')!;
    expect(p.en).toBe('Medicine Store');
    expect(p.via).not.toBe('X');
    expect(askPrefix(graphs.hospital)).toContain('GF-PHARM | Medicine Store');
    expect(await GET(new Request('http://x/api/admin?site=hospital')).json()).toEqual(saved);
  });

  it('empty edits put site.json back', async () => {
    process.env.ADMIN_PASSWORD = 'staff123';
    await post({ siteId: 'hospital', edits: { places: {} } }, 'staff123');
    expect(graphs.hospital.site.places.find((x) => x.id === 'GF-PHARM')!.en).toBe('Pharmacy');
    expect(GET(new Request('http://x/api/admin?site=nope')).status).toBe(400);
  });
});
