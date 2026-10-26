// Admin panel (admin.html): hospital staff rename rooms, fix room numbers and keywords, and set the notice line.
// Changes are saved through POST /api/admin (password = ADMIN_PASSWORD on the server) and every visitor's page
// picks them up the next time it opens. Only what differs from site.json is stored.
import './compat'; // first: polyfills for older phones
import { EDIT_FIELDS, type Edits, type PlaceEdit } from './data/edits';
import { SITE_IDS } from './data/loadSites';
import type { Place, Site } from './data/types';
import { t, type Lang } from './i18n';
import { $, esc } from './ui/dom';
import { cldOn, stepPhoto, uploadSpotPhoto } from './cld';

const SITE = SITE_IDS[0]; // ponytail: one site today; add a site picker when a second building ships
let lang: Lang = localStorage.getItem('raasta-lang') === 'hi' ? 'hi' : 'en';
let pw = sessionStorage.getItem('raasta-admin') || '';
let site: Site;
let edits: Edits = { places: {} };
let photoEd: Record<string, string> = {}; // place id → Cloudinary public id of the staff photo
const tr = (k: string, ...a: unknown[]) => t(lang, k, ...a);

const orig = (p: Place, f: (typeof EDIT_FIELDS)[number]) => (f === 'code' ? (p.code ?? p.id) : f === 'kw' ? (p.kw ?? '') : p[f]);
const origNotice = () => (site.notice ?? { en: '', hi: '' }) as { en: string; hi: string };

/** What a visitor will see on arrival: the staff photo with faces blurred and the arrival line painted on. */
const preview = (id: string) => stepPhoto('cld:' + id, { arrow: '↓', label: 'आप पहुँच गए · You have arrived' }, 480);
const photoCell = (p: Place) =>
  `<td class="ph">${photoEd[p.id] ? `<a href="${esc(preview(photoEd[p.id]))}" target="_blank" rel="noopener"><img src="${esc(preview(photoEd[p.id]))}" alt="" loading="lazy"></a>` : ''}
    <label class="phbtn" title="Photo">📷<input type="file" accept="image/*" capture="environment" data-photo="${esc(p.id)}" hidden></label></td>`;

/** Never throws: status 0 = no network. */
async function post(body: Record<string, unknown>): Promise<{ status: number; data: Record<string, unknown> }> {
  try {
    const r = await fetch('/api/admin', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-key': pw },
      body: JSON.stringify({ siteId: SITE, ...body }),
    });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  } catch {
    return { status: 0, data: {} };
  }
}

function chrome() {
  document.documentElement.lang = lang;
  $('#title').textContent = tr('admTitle');
  $('#openApp').textContent = tr('admOpen');
  $('#lang').textContent = lang === 'en' ? 'हिंदी' : 'English';
}

function login(msg = '') {
  $('#main').innerHTML = `<form class="card login" id="login">
    <h2>${esc(tr('admLoginT'))}</h2><p class="mut">${esc(tr('admLoginD'))}</p>
    <input type="password" id="pw" autocomplete="current-password" placeholder="${esc(tr('admPw'))}" required>
    <p class="err">${esc(msg)}</p><button class="primary" type="submit">${esc(tr('admLogin'))}</button></form>`;
  $<HTMLFormElement>('#login').onsubmit = async (e) => {
    e.preventDefault();
    pw = $<HTMLInputElement>('#pw').value;
    const r = await post({});
    if (r.status === 200) {
      sessionStorage.setItem('raasta-admin', pw);
      edits = r.data as unknown as Edits;
      return editor();
    }
    login(tr(r.data.error === 'admin_off' ? 'admOff' : r.status === 403 ? 'admBadPw' : 'admFail'));
  };
}

function editor() {
  photoEd = Object.fromEntries(Object.entries(edits.places).flatMap(([id, pe]) => (pe.photo ? [[id, pe.photo]] : [])));
  const fl = Object.fromEntries(site.floors.map((f) => [f.id, lang === 'hi' ? f.hi : f.en]));
  const n = edits.notice === null ? { en: '', hi: '' } : (edits.notice ?? origNotice());
  const cell = (p: Place, f: (typeof EDIT_FIELDS)[number]) => {
    const v = edits.places[p.id]?.[f] ?? orig(p, f);
    return `<td class="${f}"><input data-id="${esc(p.id)}" data-f="${f}" value="${esc(v)}"${v !== orig(p, f) ? ' class="chg"' : ''}></td>`;
  };
  $('#main').innerHTML = `<section class="card"><h2>${esc(tr('admNotice'))}</h2><p class="mut">${esc(tr('admNoticeD'))}</p>
    <div class="grid2"><textarea id="nEn" rows="2" placeholder="English">${esc(n.en)}</textarea>
    <textarea id="nHi" rows="2" placeholder="हिंदी">${esc(n.hi)}</textarea></div></section>
    <section class="card"><h2>${esc(tr('admPlaces'))}</h2><p class="mut">${esc(tr('admPlacesD'))}</p>
    <div class="row" style="margin-bottom:10px"><input id="q" type="search" placeholder="${esc(tr('admSearch'))}" style="max-width:320px">
    <span style="flex:1"></span><span id="msg"></span><button class="primary" id="save" type="button">${esc(tr('admSave'))}</button></div>
    <div class="tbl"><table><thead><tr><th>${esc(tr('admFloor'))}</th><th>${esc(tr('admCode'))}</th><th>Name (English)</th><th>नाम (हिंदी)</th>
    <th>${esc(tr('admShort'))} (EN)</th><th>${esc(tr('admShort'))} (HI)</th><th>${esc(tr('admKw'))}</th>${cldOn ? '<th>📷 Photo</th>' : ''}</tr></thead>
    <tbody>${site.places.map((p) => `<tr data-q="${esc([p.id, p.code, p.en, p.hi, p.kw].join(' ').toLowerCase())}"><td class="fl">${esc(fl[p.floor])}</td>${['code', 'en', 'hi', 'enS', 'hiS', 'kw'].map((f) => cell(p, f as (typeof EDIT_FIELDS)[number])).join('')}${cldOn ? photoCell(p) : ''}</tr>`).join('')}</tbody></table></div></section>`;

  // Staff walk the building once with a phone: each photo goes straight to Cloudinary, which blurs faces and
  // paints the arrows for visitors. Saved with the other edits.
  $('#main').onchange = async (e) => {
    const el = e.target as HTMLInputElement;
    const id = el.dataset.photo,
      f = el.files?.[0];
    if (!id || !f) return;
    const td = el.closest('td')!;
    td.classList.add('busy');
    $('#msg').className = '';
    $('#msg').textContent = tr('admPhotoUp');
    try {
      photoEd[id] = await uploadSpotPhoto(f, SITE, id);
      td.outerHTML = photoCell(site.places.find((x) => x.id === id)!);
      $('#msg').textContent = tr('admPhotoDone');
    } catch (err) {
      console.error('[admin] photo upload failed', err);
      td.classList.remove('busy');
      $('#msg').className = 'err';
      $('#msg').textContent = (err as Error).message;
    }
  };

  $('#main').oninput = (e) => {
    const el = e.target as HTMLInputElement;
    if (el.type === 'file') return;
    if (el.id === 'q') {
      const q = el.value.trim().toLowerCase();
      for (const row of document.querySelectorAll<HTMLElement>('tbody tr')) row.hidden = !!q && !row.dataset.q!.includes(q);
      return;
    }
    const p = el.dataset.id && site.places.find((x) => x.id === el.dataset.id);
    if (p) el.classList.toggle('chg', el.value.trim() !== orig(p, el.dataset.f as (typeof EDIT_FIELDS)[number]));
    $('#msg').textContent = '';
  };
  $('#save').onclick = save;
}

/** What the form says now, as edits (only what differs from site.json). */
function collect(): Edits {
  const places: Record<string, PlaceEdit> = {};
  for (const el of document.querySelectorAll<HTMLInputElement>('tbody input')) {
    const p = site.places.find((x) => x.id === el.dataset.id)!,
      f = el.dataset.f as (typeof EDIT_FIELDS)[number],
      v = el.value.trim();
    if (v && v !== orig(p, f)) (places[p.id] ??= {})[f] = v; // empty = back to the original
  }
  for (const [id, ph] of Object.entries(photoEd)) (places[id] ??= {}).photo = ph;
  const en = $<HTMLTextAreaElement>('#nEn').value.trim(),
    hi = $<HTMLTextAreaElement>('#nHi').value.trim(),
    o = origNotice();
  const next: Edits = { places };
  if (!en && !hi) next.notice = o.en || o.hi ? null : undefined;
  else if (en !== o.en || hi !== o.hi) next.notice = { en, hi };
  return next;
}

async function save() {
  const next = collect();
  const msg = $('#msg');
  const r = await post({ edits: next });
  if (r.status === 403) {
    sessionStorage.removeItem('raasta-admin');
    return login(tr('admBadPw'));
  }
  if (r.status !== 200) {
    msg.className = 'err';
    msg.textContent = tr('admFail');
    return;
  }
  edits = r.data as unknown as Edits;
  msg.className = 'ok';
  msg.textContent = tr('admSaved', Object.keys(edits.places).length);
}

$('#lang').onclick = () => {
  lang = lang === 'en' ? 'hi' : 'en';
  localStorage.setItem('raasta-lang', lang);
  chrome();
  if (document.querySelector('#save')) {
    edits = collect(); // keep unsaved changes across the re-render
    editor();
  } else login();
};

(async () => {
  chrome();
  site = (await (await fetch(`/sites/${SITE}/site.json`)).json()) as Site;
  if (!pw) return login();
  const r = await post({});
  if (r.status !== 200) return login();
  edits = r.data as unknown as Edits;
  editor();
})();
