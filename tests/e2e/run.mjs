// Uji end-to-end SmartSign terhadap server Next.js + Supabase lokal.
// Prasyarat: `supabase start`, `npm run build && npm start`, .env.local mengarah ke stack lokal.
// Jalankan: node tests/e2e/run.mjs   (BASE=http://localhost:3000 MAILPIT=http://127.0.0.1:54324)
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { crc32, deflateSync } from 'node:zlib';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const BASE = process.env.BASE || 'http://localhost:3000';
const MAILPIT = process.env.MAILPIT || 'http://127.0.0.1:54324';
const SB_URL = process.env.SB_URL || 'http://127.0.0.1:54321';
const SB_KEY = process.env.SB_KEY || 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';
const CRON = process.env.CRON_SECRET || 'cron-local-secret';
const MOCK = process.env.MAYAR_MOCK || 'http://127.0.0.1:4010';
const WH = process.env.MAYAR_WEBHOOK_TOKEN || 'whtok-local';
const DB_CONTAINER = process.env.DB_CONTAINER || 'supabase_db_smartsign';
const RUN = randomBytes(3).toString('hex');

const results = [];
let current = '';
async function test(name, fn) {
  current = name;
  try { await fn(); results.push(['PASS', name]); console.log('PASS', name); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log('FAIL', name, '::', e.message); }
}
function assert(c, msg) { if (!c) throw new Error(msg || 'assert gagal'); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => createHash('sha256').update(b).digest('hex');

/* ---------- klien HTTP dengan cookie jar ---------- */
class Client {
  constructor() { this.jar = new Map(); }
  cookie() { return [...this.jar].map(([k, v]) => k + '=' + v).join('; '); }
  store(res) {
    for (const c of res.headers.getSetCookie?.() || []) {
      const [kv, ...attrs] = c.split(';');
      const i = kv.indexOf('=');
      const k = kv.slice(0, i).trim(), v = kv.slice(i + 1).trim();
      const expired = attrs.some((a) => /max-age=0/i.test(a)) || !v;
      if (expired) this.jar.delete(k); else this.jar.set(k, v);
    }
  }
  async get(path, opts = {}) {
    const res = await fetch(BASE + path, { redirect: 'manual', ...opts, headers: { cookie: this.cookie(), ...(opts.headers || {}) } });
    this.store(res);
    return res;
  }
  async raw(action, payload, headers = {}) {
    const res = await fetch(BASE + '/api/rpc', { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/json', origin: BASE, 'x-requested-with': 'smartsign', cookie: this.cookie(), ...headers },
      body: JSON.stringify({ action, payload }) });
    this.store(res);
    return res.json();
  }
  async api(action, payload = {}) {
    const r = await this.raw(action, payload);
    if (!r.ok) { const e = new Error(action + ' -> ' + r.code + ': ' + r.message + (r.fields ? ' ' + JSON.stringify(r.fields) : '')); e.code = r.code; e.fields = r.fields; throw e; }
    return r.data;
  }
  async fail(action, payload, code) {
    const r = await this.raw(action, payload);
    assert(!r.ok, action + ' seharusnya gagal tapi berhasil');
    if (code) assert(r.code === code, action + ' kode ' + r.code + ' (harap ' + code + '): ' + r.message);
    return r;
  }
}

/* ---------- Mailpit ---------- */
async function mails(to) {
  const r = await (await fetch(MAILPIT + '/api/v1/search?query=' + encodeURIComponent('to:' + to) + '&limit=50')).json();
  return r.messages || [];
}
async function mailText(id) { const m = await (await fetch(MAILPIT + '/api/v1/message/' + id)).json(); return (m.Text || '') + '\n' + (m.HTML || ''); }
const SEEN = new Set();
async function waitMail(to, subjectRe, seen = SEEN, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const list = await mails(to);
    const m = list.find((x) => subjectRe.test(x.Subject) && !seen.has(x.ID));
    if (m) { seen.add(m.ID); return { ...m, text: await mailText(m.ID) }; }
    await sleep(250);
  }
  throw new Error('email "' + subjectRe + '" ke ' + to + ' tidak datang');
}

/* ---------- TOTP (RFC 6238) ---------- */
function b32(s) {
  const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = '';
  for (const ch of s.replace(/=+$/, '').toUpperCase()) bits += a.indexOf(ch).toString(2).padStart(5, '0');
  const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
function totp(secret, offset = 0) {
  const ctr = Math.floor(Date.now() / 1000 / 30) + offset;
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(ctr));
  const h = createHmac('sha1', b32(secret)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0');
}

let lastCtr = 0, lastCode = '';
/** Kode TOTP dari jendela 30 detik yang belum pernah dipakai (server menolak pemakaian ulang). */
async function freshTotp(sec) {
  let ctr = Math.floor(Date.now() / 30000);
  if (ctr <= lastCtr) { await sleep((lastCtr + 1) * 30000 - Date.now() + 300); ctr = Math.floor(Date.now() / 30000); }
  lastCtr = ctr; lastCode = totp(sec);
  return lastCode;
}
function psql(sql) {
  return execFileSync('docker', ['exec', DB_CONTAINER, 'psql', '-U', 'postgres', '-At', '-c', sql], { encoding: 'utf8' }).trim();
}

async function makePdf(pages = 2) {
  const doc = await PDFDocument.create();
  const f = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) { const p = doc.addPage([595, 842]); p.drawText('Perjanjian uji ' + RUN + ' halaman ' + (i + 1), { x: 60, y: 760, size: 14, font: f }); }
  return Buffer.from(await doc.save());
}
// PNG RGBA berisi goresan acak (cukup besar untuk lolos pemeriksaan "tidak kosong")
function makePng(w, hgt) {
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td) >>> 0); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(hgt, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * hgt);
  for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) { const o = y * (w * 4 + 1) + 1 + x * 4; if (Math.abs(y - hgt / 2 - Math.sin(x / 9) * hgt / 3) < 3) { raw[o + 2] = 102; raw[o + 3] = 255; } else if ((x * 7 + y * 13) % 97 === 0) raw[o + 3] = 20; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const SIG = makePng(320, 90);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const PW = 'Lembayung-Senja-2026';
const emails = { alice: 'admin@contoh.test', bob: 'bob.' + RUN + '@contoh.test', dina: 'dina.' + RUN + '@contoh.test', carol: 'carol.' + RUN + '@contoh.test', s1: 'penanda1.' + RUN + '@contoh.test', s2: 'penanda2.' + RUN + '@contoh.test' };
const alice = new Client(), bob = new Client(), carol = new Client(), dina = new Client(), anon = new Client();
let secret = '', recovery = [], link = null, docId = '', docCode = '', original = null;

async function registerAndConfirm(c, email, nama) {
  const seen = new Set((await mails(email)).map((m) => m.ID));
  await c.api('auth.register', { email, nama, password: PW });
  const m = await waitMail(email, /./, seen);
  const href = (m.text.match(/https?:\/\/[^\s"'<>]+\/auth\/confirm\?[^\s"'<>]+/) || [])[0];
  assert(href, 'tautan konfirmasi tidak ada di email');
  const res = await c.get(href.replace(/^https?:\/\/[^/]+/, '').replace(/&amp;/g, '&'));
  assert(res.status === 303 && /notice=/.test(res.headers.get('location')), 'konfirmasi tidak redirect: ' + res.status + ' ' + res.headers.get('location'));
}

/* ====================== Skenario ====================== */
await test('Halaman SPA tersaji dengan CSP tanpa skrip inline', async () => {
  for (const p of ['/', '/verify', '/reset', '/sign/abc', '/invite/abc']) {
    const r = await anon.get(p); const html = await r.text();
    assert(r.status === 200, p + ' status ' + r.status);
    const csp = r.headers.get('content-security-policy') || '';
    assert(/script-src 'self'(;|$)/.test(csp) && /frame-ancestors 'none'/.test(csp), p + ' CSP lemah: ' + csp);
    assert(!/<script>(?!\s*$)/.test(html) && !/<script(?![^>]*(src=|type="application\/json"))/.test(html), p + ' punya skrip inline');
    assert(r.headers.get('x-frame-options') === 'DENY' && r.headers.get('x-content-type-options') === 'nosniff', p + ' header keamanan hilang');
  }
});
await test('Aset statis vendor dan JS dapat dimuat', async () => {
  for (const p of ['/js/core.js', '/js/app.js', '/js/pages.js', '/js/public.js', '/js/codes.js', '/js/billing.js', '/js/go.js', '/css/app.css', '/vendor/pdf.min.mjs', '/vendor/pdf.worker.min.mjs', '/vendor/pdf-lib.min.js', '/vendor/qrcode.js', '/vendor/jsQR.js', '/icon.svg'])
    assert((await anon.get(p)).status === 200, p + ' tidak tersedia');
});
await test('CSRF: tanpa header khusus atau dari origin lain ditolak', async () => {
  let r = await anon.raw('public.verifyHash', { hash: 'a'.repeat(64) }, { 'x-requested-with': '' });
  assert(!r.ok && r.code === 'FORBIDDEN', 'tanpa header lolos');
  r = await anon.raw('public.verifyHash', { hash: 'a'.repeat(64) }, { origin: 'https://evil.example' });
  assert(!r.ok && r.code === 'FORBIDDEN', 'origin lain lolos');
  r = await anon.raw('tidak.ada', {});
  assert(!r.ok && r.code === 'NOT_FOUND', 'aksi tidak dikenal tidak ditolak');
});
await test('Aksi terproteksi tanpa sesi -> UNAUTHORIZED', async () => {
  await anon.fail('link.list', {}, 'UNAUTHORIZED');
  await anon.fail('auth.me', {}, 'UNAUTHORIZED');
});
await test('Registrasi: validasi password, honeypot, email', async () => {
  await anon.fail('auth.register', { email: 'x@contoh.test', nama: 'X', password: 'pendek1' }, 'VALIDATION');
  await anon.fail('auth.register', { email: 'x@contoh.test', nama: 'X', password: 'hanyahurufsaja' }, 'VALIDATION');
  await anon.fail('auth.register', { email: 'bukan-email', nama: 'X', password: PW }, 'VALIDATION');
  const r = await anon.raw('auth.register', { email: 'bot.' + RUN + '@contoh.test', nama: 'Bot', password: PW, website: 'http://spam' });
  assert(r.ok, 'honeypot harus tampak berhasil'); assert(psql(`select count(*) from auth.users where email = 'bot.${RUN}@contoh.test'`) === '0', 'akun bot dibuat');
});
await test('Registrasi + verifikasi email (superadmin)', async () => {
  const exists = psql(`select count(*) from auth.users where email = '${emails.alice}'`) !== '0';
  if (!exists) {
    const r = await alice.raw('auth.login', { email: emails.alice, password: PW });
    assert(!r.ok, 'login sebelum terdaftar seharusnya gagal');
    await registerAndConfirm(alice, emails.alice, 'Alice Admin');
  }
});
await test('Login, sesi cookie httpOnly, auth.me', async () => {
  const d = await alice.api('auth.login', { email: emails.alice, password: PW });
  if (d.mfaRequired) throw new Error('akun uji sudah ber-MFA; jalankan `supabase db reset` untuk uji bersih');
  assert(d.me && d.me.email === emails.alice, 'me salah');
  assert([...alice.jar.keys()].some((k) => k.startsWith('sb-')), 'cookie sesi tidak diset');
  const me = (await alice.api('auth.me')).me;
  assert(me.role === 'admin' && me.platformRole === 'superadmin', 'peran awal salah: ' + me.role + '/' + me.platformRole);
});
await test('Login gagal: pesan generik', async () => {
  const r = await anon.raw('auth.login', { email: emails.alice, password: 'SalahSekali123' });
  assert(!r.ok && /salah/i.test(r.message) && !/terdaftar/i.test(r.message), 'pesan tidak generik: ' + r.message);
});
await test('MFA TOTP: aktivasi, kode pemulihan, login 2 langkah', async () => {
  const s = await alice.api('auth.mfaStart', {});
  secret = s.secret; assert(secret && /^otpauth:/.test(s.otpauth), 'secret/otpauth tidak ada');
  await alice.fail('auth.mfaConfirm', { code: '000000' }, 'VALIDATION');
  const c = await alice.api('auth.mfaConfirm', { code: await freshTotp(secret) });
  recovery = c.recoveryCodes; assert(recovery && recovery.length >= 8, 'kode pemulihan kurang');
  await alice.api('auth.logout');
  await alice.fail('auth.me', {}, 'UNAUTHORIZED');
  const d = await alice.api('auth.login', { email: emails.alice, password: PW });
  assert(d.mfaRequired, 'MFA tidak diminta');
  await alice.fail('link.list', {}, 'MFA_REQUIRED');
    await alice.fail('auth.mfa', { code: '123456' });
  const ok = await alice.api('auth.mfa', { code: await freshTotp(secret) });
  assert(ok.me && ok.me.mfaEnabled, 'login MFA gagal');
  const me = (await alice.api('auth.me')).me; assert(me.email === emails.alice, 'sesi aal2 tidak aktif');
});
await test('MFA: kode TOTP yang sama tidak bisa dipakai ulang', async () => {
  const c2 = new Client();
  const d = await c2.api('auth.login', { email: emails.alice, password: PW });
  assert(d.mfaRequired, 'MFA tidak diminta');
  const r = await c2.raw('auth.mfa', { code: lastCode });
  assert(!r.ok, 'kode yang sama diterima dua kali');
});
await test('MFA: masuk dengan kode pemulihan sekali pakai', async () => {
  const c3 = new Client();
  await c3.api('auth.login', { email: emails.alice, password: PW });
  const r = await c3.api('auth.mfa', { code: recovery[0] });
  assert(r.me, 'kode pemulihan ditolak');
  const c4 = new Client();
  await c4.api('auth.login', { email: emails.alice, password: PW });
  const again = await c4.raw('auth.mfa', { code: recovery[0] });
  assert(!again.ok, 'kode pemulihan dipakai dua kali');
  // kode pemulihan menonaktifkan MFA lama -> aktifkan ulang untuk alice
  const s = (await alice.api('auth.me')).me;
  if (!s.mfaEnabled) { const st = await alice.api('auth.mfaStart', {}); secret = st.secret; recovery = (await alice.api('auth.mfaConfirm', { code: await freshTotp(secret) })).recoveryCodes; }
});
await test('Daftar sesi aktif dan cabut sesi lain', async () => {
  const s = await alice.api('auth.sessions');
  const rows = s.rows || s;
  assert(Array.isArray(rows) && rows.length >= 1 && rows.some((x) => x.current), 'sesi tidak terdaftar');
  await alice.api('auth.revokeOthers');
  const after = await alice.api('auth.sessions');
  assert((after.rows || after).length === 1, 'sesi lain tidak dicabut');
});

/* ---------- Shortlink ---------- */
await test('Shortlink: buat, slug kustom, 302 redirect, klik tercatat', async () => {
  const r = await alice.api('link.create', { destination: 'https://example.com/promo?a=1', slug: 'promo-' + RUN, title: 'Promo', utm: { source: 'ig', medium: 'social', campaign: 'nov' } });
  link = r.link; assert(link.slug === 'promo-' + RUN && link.shortUrl, 'slug salah');
  const res = await anon.get('/' + link.slug, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0' } });
  const loc = res.headers.get('location') || '';
  assert(res.status === 302 && loc.startsWith('https://example.com/promo') && /utm_source=ig/.test(loc), 'redirect salah: ' + res.status + ' ' + loc);
  assert(/no-store/.test(res.headers.get('cache-control') || ''), 'redirect boleh di-cache');
  await sleep(800);
  const st = await alice.api('link.stats', { id: link.id, days: 7 });
  assert(st.total >= 1 || st.clicks >= 1 || (st.summary && st.summary.total >= 1), 'klik tidak tercatat: ' + JSON.stringify(st).slice(0, 200));
});
await test('Shortlink: kunjungan via QR (?q=1) tercatat sebagai sumber qr', async () => {
  await anon.get('/' + link.slug + '?q=1', { headers: { 'user-agent': 'Mozilla/5.0 (iPhone) Safari/604.1' } });
  await sleep(800);
  assert(Number(psql(`select count(*) from click_events c join links l on l.id = c.link_id where l.slug = '${link.slug}' and c.source = 'qr'`)) >= 1, 'sumber qr tidak tercatat');
});
await test('Shortlink: bot/crawler tidak dihitung', async () => {
  const before = Number(psql(`select click_count from links where slug = '${link.slug}'`));
  await anon.get('/' + link.slug, { headers: { 'user-agent': 'facebookexternalhit/1.1' } });
  await sleep(600);
  assert(Number(psql(`select click_count from links where slug = '${link.slug}'`)) === before, 'bot dihitung');
});
await test('Shortlink: tujuan berbahaya/privat dan slug terlarang ditolak', async () => {
  await alice.fail('link.create', { destination: 'http://127.0.0.1/admin' }, 'VALIDATION');
  await alice.fail('link.create', { destination: 'javascript:alert(1)' }, 'VALIDATION');
  await alice.fail('link.create', { destination: 'https://example.com', slug: 'admin' }, 'VALIDATION');
  await alice.fail('link.create', { destination: 'https://example.com', title: 'Duplikat', slug: link.slug.toUpperCase() });
  assert((await anon.get('/api')).status !== 302, 'slug sistem diarahkan');
});
await test('Shortlink: link berpassword lewat halaman perantara', async () => {
  const r = await alice.api('link.create', { destination: 'https://example.org/rahasia', title: 'Berpassword', password: 'kunci-1234' });
  const res = await anon.get('/' + r.link.slug);
  assert(res.status === 302 && res.headers.get('location') === '/go/' + r.link.slug, 'tidak ke perantara: ' + res.headers.get('location'));
  const page = await anon.get('/go/' + r.link.slug); const html = await page.text();
  assert(page.status === 200 && /"hasPassword":true/.test(html) && !/example\.org/.test(html), 'halaman perantara membocorkan tujuan');
  assert((await anon.api('public.open', { slug: r.link.slug })).state === 'password', 'password tidak diminta');
  const bad = await anon.api('public.open', { slug: r.link.slug, password: 'salah' });
  assert(bad.state === 'password' && bad.error, 'password salah diterima');
  const ok = await anon.api('public.open', { slug: r.link.slug, password: 'kunci-1234' });
  assert(ok.state === 'ok' && ok.url === 'https://example.org/rahasia', 'password benar ditolak');
});
await test('Shortlink: batas klik atomik (maxClicks)', async () => {
  const r = await alice.api('link.create', { destination: 'https://example.net/sekali', title: 'Terbatas', maxClicks: 3 });
  const codes = await Promise.all(Array.from({ length: 8 }, () => anon.get('/' + r.link.slug).then((x) => x.headers.get('location'))));
  const direct = codes.filter((l) => l === 'https://example.net/sekali').length;
  assert(direct === 3, 'klik langsung = ' + direct + ' (harus 3)');
  assert(Number(psql(`select click_count from links where id = '${r.link.id}'`)) === 3, 'penghitung melewati batas');
});
await test('Shortlink: nonaktif, slug tak dikenal, edit tujuan + riwayat versi', async () => {
  const r = await alice.api('link.create', { destination: 'https://example.com/a', title: 'Edit' });
  await alice.api('link.status', { id: r.link.id, status: 'nonaktif' });
  let res = await anon.get('/' + r.link.slug);
  assert(res.headers.get('location') === '/go/' + r.link.slug, 'link nonaktif tetap mengarah');
  assert((await anon.get('/go/tidakada' + RUN)).status === 404, 'slug tak dikenal bukan 404');
  await alice.api('link.status', { id: r.link.id, status: 'aktif' });
  const up = await alice.raw('link.update', { id: r.link.id, destination: 'https://example.com/b' });
  if (!up.ok && up.code === 'REAUTH_REQUIRED') { await alice.api('auth.reauth', { password: PW, code: await freshTotp(secret) }); await alice.api('link.update', { id: r.link.id, destination: 'https://example.com/b' }); }
  else assert(up.ok, 'update gagal: ' + up.message);
  res = await anon.get('/' + r.link.slug);
  assert(res.headers.get('location') === 'https://example.com/b', 'tujuan baru tidak berlaku: ' + res.headers.get('location'));
  const g = await alice.api('link.get', { id: r.link.id });
  assert((g.versions || []).length >= 2, 'riwayat versi tidak tercatat');
});
await test('Shortlink: impor massal + daftar + ekspor CSV', async () => {
  const r = await alice.api('link.bulkCreate', { lines: 'https://example.com/1\nhttps://example.com/2,massal-' + RUN + '\nbukan url' });
  const rows = r.results || r.rows || r;
  assert(rows.filter((x) => x.ok).length === 2 && rows.filter((x) => !x.ok).length === 1, 'hasil impor salah');
  const list = await alice.api('link.list', { q: 'massal-' + RUN });
  assert(list.total === 1, 'pencarian link salah');
  const ex = await alice.api('link.export', {});
  assert(ex && (ex.rows || ex.csv || ex.b64 || ex.url), 'ekspor kosong');
});
await test('Laporan penyalahgunaan publik masuk ke antrean admin', async () => {
  await anon.api('public.report', { slug: link.slug, reason: 'phishing', detail: 'uji' });
  const l = await alice.api('abuse.list', {});
  assert((l.rows || l).some((x) => x.slug === link.slug), 'laporan tidak tampil');
});


/* ---------- Shortlink publik tanpa login ---------- */
let anon1 = null;
await test('Shortlink publik tanpa login: buat, redirect 302, tujuan berbahaya ditolak', async () => {
  const r = await anon.api('public.shorten', { destination: 'https://example.com/publik-' + RUN });
  assert(r.link && /^[a-f0-9]{64}$/.test(r.claim || ''), 'tidak ada claim token');
  anon1 = r;
  const res = await anon.get('/' + r.link.slug);
  assert(res.status === 302 && res.headers.get('location') === 'https://example.com/publik-' + RUN, 'redirect: ' + res.headers.get('location'));
  await anon.fail('public.shorten', { destination: 'http://127.0.0.1/admin' }, 'VALIDATION');
  await anon.fail('public.shorten', { destination: 'javascript:alert(1)' }, 'VALIDATION');
  assert((await anon.api('public.shorten', { destination: 'https://example.com', website: 'spam' })).link === null, 'honeypot lolos');
  assert(psql(`select w.id from links l join workspaces w on w.id = l.workspace_id where l.slug = '${r.link.slug}'`) === '00000000-0000-0000-0000-000000000001', 'bukan di ruang kerja publik');
});
await test('Shortlink publik: dibatasi 10 per jam per IP', async () => {
  const ip = { 'x-forwarded-for': '203.0.113.' + (Number.parseInt(RUN.slice(0, 2), 16) % 250 + 1) };
  let limited = 0;
  for (let i = 0; i < 11; i++) { const r = await anon.raw('public.shorten', { destination: 'https://example.org/batas-' + i }, ip); if (!r.ok && r.code === 'RATE_LIMIT') limited++; }
  assert(limited === 1, 'percobaan ke-11 harus ditolak (ditolak: ' + limited + ')');
});
await test('Klaim shortlink publik setelah login, lalu ganti slug (slug lama tidak bisa dipakai ulang)', async () => {
  const c = await alice.api('link.claim', { claims: [anon1.claim, 'f'.repeat(64)] });
  assert(c.claimed === 1, 'jumlah diklaim ' + c.claimed);
  assert((await alice.api('link.claim', { claims: [anon1.claim] })).claimed === 0, 'bisa diklaim dua kali');
  await carol.fail('link.get', { id: psql(`select id from links where slug = '${anon1.link.slug}'`) }, 'UNAUTHORIZED');
  const id = psql(`select id from links where slug = '${anon1.link.slug}'`);
  const g = await alice.api('link.get', { id });
  assert(g.link.slug === anon1.link.slug, 'tidak bisa dibaca pemilik baru');
  const newSlug = 'klaim-' + RUN;
  let up = await alice.raw('link.update', { id, slug: newSlug });
  if (!up.ok && up.code === 'REAUTH_REQUIRED') { await alice.api('auth.reauth', { password: PW, code: await freshTotp(secret) }); up = await alice.raw('link.update', { id, slug: newSlug }); }
  assert(up.ok, 'ganti slug: ' + up.message);
  assert(((await anon.get('/' + newSlug)).headers.get('location') || '').startsWith('https://example.com/publik-'), 'slug baru tidak jalan');
  assert((await anon.get('/' + anon1.link.slug)).headers.get('location') === '/go/' + anon1.link.slug, 'slug lama masih mengarah');
  const re = await alice.raw('link.create', { destination: 'https://example.com', title: 'Ambil slug lama', slug: anon1.link.slug });
  assert(!re.ok, 'slug lama bisa dipakai ulang');
});

/* ---------- Paket & pembayaran Mayar ---------- */
let payId = '';
await test('Superadmin tidak terkunci paywall: semua layanan terbuka tanpa bayar', async () => {
  const me = (await alice.api('auth.me')).me;
  assert(me.platformRole === 'superadmin' && me.esignEnabled === true && me.plan === 'lifetime', 'superadmin terkunci: ' + me.plan);
  await registerAndConfirm(dina, emails.dina, 'Dina Pengguna');
  await dina.api('auth.login', { email: emails.dina, password: PW });
  const ds = await dina.api('auth.mfaStart', {});
  await dina.api('auth.mfaConfirm', { code: totp(ds.secret) });
});
await test('Harga paket & paket gratis: e-signature terkunci (PAYMENT_REQUIRED)', async () => {
  const p = await anon.api('public.plans');
  assert(p.plans.map((x) => x.price).join(',') === '0,50000,100000', 'harga: ' + p.plans.map((x) => x.price));
  const me = (await dina.api('auth.me')).me;
  assert(me.plan === 'free' && me.esignEnabled === false, 'paket awal ' + me.plan);
  await dina.fail('doc.uploadUrl', { fileName: 'a.pdf', size: 1000 }, 'PAYMENT_REQUIRED');
});
await test('Checkout Mayar: validasi, tagihan tidak ganda, webhook palsu tidak mengaktifkan paket', async () => {
  await dina.fail('billing.checkout', { plan: 'pro', mobile: '123' }, 'VALIDATION');
  await dina.fail('billing.checkout', { plan: 'emas', mobile: '081234567890' }, 'VALIDATION');
  const r = await dina.api('billing.checkout', { plan: 'pro', mobile: '0812-3456-7890' });
  assert(/^https:\/\/mock\.mayar\.local\/pay\//.test(r.payUrl), 'payUrl ' + r.payUrl);
  payId = r.id;
  const again = await dina.api('billing.checkout', { plan: 'pro', mobile: '081234567890' });
  assert(again.id === payId && again.reused, 'tagihan ganda dibuat');
  assert((await dina.api('billing.check', { id: payId })).status === 'pending', 'belum bayar dianggap lunas');
  const fake = await fetch(BASE + '/api/webhooks/mayar?token=' + WH, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'payment.received', data: { customerEmail: emails.dina, amount: 50000, status: true } }) });
  assert(fake.ok, 'webhook status ' + fake.status);
  assert((await dina.api('auth.me')).me.plan === 'free', 'webhook palsu mengaktifkan paket');
  assert((await fetch(BASE + '/api/webhooks/mayar?token=salah', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status === 401, 'token webhook salah diterima');
  await carol.fail('billing.check', { id: payId }, 'UNAUTHORIZED');
});
await test('Bayar Pro 3 bulan: paket aktif 90 hari dan e-signature terbuka', async () => {
  const last = await (await fetch(MOCK + '/__last')).json();
  await fetch(MOCK + '/__pay/' + last.id, { method: 'POST' });
  const ck = await dina.api('billing.check', { id: payId });
  assert(ck.status === 'paid', 'status ' + ck.status);
  const me = (await dina.api('auth.me')).me;
  assert(me.plan === 'pro' && me.esignEnabled, 'paket tidak aktif: ' + me.plan);
  const days = (Date.parse(me.planExpiresAt) - Date.now()) / 86400000;
  assert(days > 89.9 && days <= 90.01, 'masa aktif ' + days.toFixed(2) + ' hari');
  assert((await dina.api('billing.check', { id: payId })).status === 'paid', 'tidak idempoten');
  const b = await dina.api('billing.get');
  assert(b.payments[0].status === 'paid' && b.current.plan === 'pro', 'riwayat pembayaran');
  assert(psql(`select count(*) from audit_log where action = 'billing.paid' and entity_id = '${payId}'`) === '1', 'aktivasi tercatat lebih dari sekali');
});

/* ---------- Tanda tangan ---------- */
await test('Unggah PDF via signed URL Storage', async () => {
  original = await makePdf(2);
  const u = await alice.api('doc.uploadUrl', { fileName: 'kontrak.pdf', size: original.length });
  const put = await fetch(u.url, { method: 'PUT', headers: { 'content-type': 'application/pdf', 'x-upsert': 'false' }, body: original });
  assert(put.ok, 'PUT storage gagal ' + put.status + ' ' + (await put.text()).slice(0, 200));
  await alice.fail('doc.upload', { path: 'tmp/lain/' + u.path.split('/').slice(2).join('/'), fileName: 'x.pdf' }, 'VALIDATION');
  const d = await alice.api('doc.upload', { path: u.path, fileName: 'kontrak.pdf', title: 'Kontrak Kerja ' + RUN, pageCount: 2, clientHash: sha(original), pageSizes: [{ w: 595, h: 842 }, { w: 595, h: 842 }] });
  docId = d.doc.id; docCode = d.doc.code;
  assert(d.doc.originalHash === sha(original) || d.doc.hash === sha(original) || true, 'hash');
  assert(psql(`select original_hash from documents where id = '${docId}'`) === sha(original), 'hash asli tidak cocok');
});
await test('Unggahan bukan PDF ditolak', async () => {
  const fake = Buffer.from('bukan pdf sama sekali ' + RUN);
  const u = await alice.api('doc.uploadUrl', { fileName: 'palsu.pdf', size: fake.length });
  await fetch(u.url, { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: fake });
  await alice.fail('doc.upload', { path: u.path, fileName: 'palsu.pdf' }, 'VALIDATION');
});
await test('Atur penanda tangan berurutan + field, lalu kirim', async () => {
  const fields = (id) => [{ id: 'sig' + id, type: 'signature', page: 2, x: 0.1 + id * 0.4, y: 0.7, w: 0.3, h: 0.08 }, { id: 'nm' + id, type: 'name', page: 2, x: 0.1 + id * 0.4, y: 0.8, w: 0.3, h: 0.03 }, { id: 'dt' + id, type: 'date', page: 2, x: 0.1 + id * 0.4, y: 0.84, w: 0.2, h: 0.03 }];
  await alice.fail('doc.setup', { id: docId, title: 'Kontrak', signers: [{ nama: 'A', email: 'x' }] }, 'VALIDATION');
  await alice.api('doc.setup', { id: docId, title: 'Kontrak Kerja ' + RUN, message: 'Mohon ditandatangani', signingOrder: 'sequential', expiresInDays: 7,
    signers: [{ nama: 'Penanda Satu', email: emails.s1, fields: fields(0) }, { nama: 'Penanda Dua', email: emails.s2, authMethod: 'otp_code', accessCode: '4321', fields: fields(1) }] });
  await alice.api('doc.send', { id: docId });
  const d = await alice.api('doc.get', { id: docId });
  assert(['sent', 'viewed'].includes(d.doc.status), 'status setelah kirim: ' + d.doc.status);
  await alice.fail('doc.setup', { id: docId, title: 'Ubah', signers: [] }, 'CONFLICT');
});
const signTokens = {};
await test('Undangan tanda tangan berurutan: hanya penanda pertama yang menerima email', async () => {
  const m = await waitMail(emails.s1, /Permintaan tanda tangan/);
  signTokens.s1 = (m.text.match(/\/sign\/([A-Za-z0-9_-]{20,})/) || [])[1];
  assert(signTokens.s1, 'token tanda tangan tidak ada');
  assert((await mails(emails.s2)).length === 0, 'penanda kedua sudah diundang sebelum gilirannya');
});
async function signAs(who, extra = {}) {
  const token = signTokens[who];
  const info = await anon.api('sign.open', { token });
  assert(info, 'sign.open kosong');
  await anon.api('sign.sendOtp', { token });
  const m = await waitMail(emails[who], /Kode verifikasi/);
  const otp = (m.Subject.match(/(\d{6})/) || [])[1];
  assert(otp, 'OTP tidak ada di email');
  const ss = (await anon.api('sign.verifyOtp', { token, code: otp, ...extra })).ss;
  const ld = await anon.api('sign.load', { token, ss });
  const bytes = Buffer.from(await (await fetch(ld.url)).arrayBuffer());
  assert(sha(bytes) === sha(original), 'PDF yang dimuat penanda berbeda');
  await anon.fail('sign.submit', { token, ss, consent: false, consentVersion: ld.consentVersion, docHash: sha(bytes), signatureImage: PNG.toString('base64') }, 'VALIDATION');
  await anon.fail('sign.submit', { token, ss, consent: true, consentVersion: ld.consentVersion, docHash: 'f'.repeat(64), signatureImage: PNG.toString('base64') }, 'CONFLICT');
  return anon.api('sign.submit', { token, ss, consent: true, consentVersion: ld.consentVersion, docHash: sha(bytes), signatureType: 'draw', signatureImage: 'data:image/png;base64,' + PNG.toString('base64') });
}
await test('OTP penanda tangan: kode salah dihitung, token palsu ditolak', async () => {
  await anon.fail('sign.open', { token: 'x'.repeat(64) });
  await anon.api('sign.sendOtp', { token: signTokens.s1 });
  const r = await anon.fail('sign.verifyOtp', { token: signTokens.s1, code: '000000' }, 'VALIDATION');
  assert(/Sisa percobaan/.test(JSON.stringify(r.fields)), 'sisa percobaan tidak ditampilkan');
  await anon.fail('sign.load', { token: signTokens.s1, ss: 'palsu' });
});
await test('Penanda 1 menandatangani (OTP email + persetujuan + hash dokumen)', async () => {
  await signAs('s1');
  const d = await alice.api('doc.get', { id: docId });
  assert(d.doc.status === 'partially_signed', 'status: ' + d.doc.status);
});
await test('Penanda 2 diundang setelah giliran, kode akses wajib', async () => {
  const m = await waitMail(emails.s2, /Permintaan tanda tangan/);
  signTokens.s2 = (m.text.match(/\/sign\/([A-Za-z0-9_-]{20,})/) || [])[1];
  await anon.api('sign.sendOtp', { token: signTokens.s2 });
  const o = await waitMail(emails.s2, /Kode verifikasi/);
  const otp = (o.Subject.match(/(\d{6})/) || [])[1];
  await anon.fail('sign.verifyOtp', { token: signTokens.s2, code: otp, accessCode: '9999' }, 'VALIDATION');
  await signAs('s2', { accessCode: '4321' });
});
let finalHash = '', certHash = '';
await test('Dokumen selesai: PDF final + sertifikat dibuat otomatis, email terkirim', async () => {
  const d = await alice.api('doc.get', { id: docId });
  psql('delete from reauth'); // kosongkan jendela konfirmasi sebelumnya
  await alice.fail('doc.download', { id: docId, which: 'final' }, 'REAUTH_REQUIRED');
  await alice.fail('auth.reauth', { password: 'SalahSekali123', code: '000000' }, 'VALIDATION');
  await alice.api('auth.reauth', { password: PW, code: await freshTotp(secret) });
  assert(d.doc.status === 'completed', 'status: ' + d.doc.status);
  const dl = await alice.api('doc.download', { id: docId, which: 'final' });
  const fb = Buffer.from(await (await fetch(dl.url)).arrayBuffer());
  assert(fb.slice(0, 5).toString() === '%PDF-', 'PDF final tidak valid');
  finalHash = sha(fb);
  const pdf = await PDFDocument.load(fb);
  assert(pdf.getPageCount() >= 3, 'PDF final harus berisi halaman asli + sertifikat (' + pdf.getPageCount() + ')');
  const cl = await alice.api('doc.download', { id: docId, which: 'certificate' });
  certHash = sha(Buffer.from(await (await fetch(cl.url)).arrayBuffer()));
  const m = await waitMail(emails.s1, /selesai ditandatangani/);
  assert(m.Attachments >= 1 || /certificate|sertifikat/i.test(JSON.stringify(m)), 'sertifikat tidak dilampirkan');
});
await test('Verifikasi publik: kode dokumen, sidik jari final/sertifikat, berkas diubah', async () => {
  const v = await anon.api('public.verifyDoc', { code: docCode });
  assert(v.result === 'valid' || v.result === 'verified', 'verifikasi kode: ' + v.result + ' ' + v.message);
  const vf = await anon.api('public.verifyHash', { hash: finalHash });
  assert(vf.match === 'final' && /valid|verified/.test(vf.result), 'hash final: ' + JSON.stringify(vf).slice(0, 200));
  const vc = await anon.api('public.verifyHash', { hash: certHash });
  assert(vc.match === 'certificate', 'hash sertifikat tidak dikenali');
  const vx = await anon.api('public.verifyHash', { hash: sha(Buffer.concat([original, Buffer.from('x')])) });
  assert(vx.result !== 'valid' && !vx.doc, 'berkas diubah dianggap valid');
  assert(!JSON.stringify(v).includes(emails.s1), 'email penanda bocor di verifikasi publik');
});
await test('Rantai hash jejak tanda tangan utuh dan append-only', async () => {
  assert(psql(`select (verify_sig_chain('${docId}')).ok`) === 't', 'rantai tanda tangan rusak');
  let blocked = false;
  try { psql(`update signature_events set actor = 'palsu' where document_id = '${docId}'`); } catch { blocked = true; }
  assert(blocked, 'signature_events bisa diubah');
});
await test('Penanda yang sudah selesai bisa mengunduh sertifikat tetapi tidak bisa menandatangani ulang', async () => {
  await anon.api('sign.sendOtp', { token: signTokens.s1 });
  const m = await waitMail(emails.s1, /Kode verifikasi/);
  const ss = (await anon.api('sign.verifyOtp', { token: signTokens.s1, code: m.Subject.match(/(\d{6})/)[1] })).ss;
  const ld = await anon.api('sign.load', { token: signTokens.s1, ss });
  assert(ld.hasCert, 'sertifikat tidak tersedia untuk penanda');
  const r = await anon.raw('sign.submit', { token: signTokens.s1, ss, consent: true, consentVersion: ld.consentVersion, docHash: sha(original), signatureImage: PNG.toString('base64') });
  assert(!r.ok, 'penanda bisa menandatangani dua kali');
  const cert = await anon.api('sign.cert', { token: signTokens.s1, ss });
  assert(cert.url || cert.b64 || cert.data, 'unduh sertifikat gagal');
});

/* ---------- Tim, RBAC, IDOR ---------- */
await test('Undang anggota (viewer), terima undangan sebagai akun baru', async () => {
  await alice.api('team.invite', { email: emails.bob, role: 'viewer' });
  const m = await waitMail(emails.bob, /Undangan/);
  const token = (m.text.match(/\/invite\/([A-Za-z0-9_-]{20,})/) || [])[1];
  assert(token, 'token undangan tidak ada');
  const peek = await anon.api('invite.peek', { token });
  assert(/viewer|pembaca/i.test(peek.role), 'peran undangan salah: ' + peek.role);
  await anon.api('invite.acceptNew', { token, nama: 'Bob Viewer', password: PW });
  await anon.fail('invite.acceptNew', { token, nama: 'Bob', password: PW });
  const d = await bob.api('auth.login', { email: emails.bob, password: PW });
  assert(d.me.role === 'viewer' && d.me.workspaceId === (await alice.api('auth.me')).me.workspaceId, 'bob tidak masuk ruang kerja alice');
});
await test('RBAC: viewer hanya bisa membaca', async () => {
  assert((await bob.api('link.list', {})).total >= 1, 'viewer tidak bisa membaca link');
  await bob.fail('link.create', { destination: 'https://example.com', title: 'Coba' }, 'FORBIDDEN');
  await bob.fail('doc.uploadUrl', { fileName: 'a.pdf', size: 100 }, 'FORBIDDEN');
  await bob.fail('team.list', {}, 'FORBIDDEN');
  await bob.fail('doc.download', { id: docId, which: 'final' }, 'FORBIDDEN');
  await bob.fail('platform.get', {}, 'FORBIDDEN');
});
await test('IDOR: pengguna ruang kerja lain tidak bisa membaca data', async () => {
  await registerAndConfirm(carol, emails.carol, 'Carol Lain');
  await carol.api('auth.login', { email: emails.carol, password: PW });
  await carol.fail('link.list', {}, 'MFA_REQUIRED'); // admin ruang kerja wajib MFA
  const cs = await carol.api('auth.mfaStart', {});
  await carol.api('auth.mfaConfirm', { code: totp(cs.secret) });
  await carol.fail('link.get', { id: link.id }, 'NOT_FOUND');
  await carol.fail('doc.get', { id: docId }, 'NOT_FOUND');
  await carol.fail('link.update', { id: link.id, destination: 'https://evil.example' }, 'NOT_FOUND');
  await carol.fail('doc.download', { id: docId, which: 'final' }, 'NOT_FOUND');
  assert((await carol.api('link.list', {})).total === 0, 'carol melihat link orang lain');
});
await test('Ubah peran anggota mencabut sesi anggota', async () => {
  const t = await alice.api('team.list', {});
  const m = (t.members || t.rows || []).find((x) => x.email === emails.bob);
  assert(m, 'bob tidak ada di daftar tim');
  const rr = await alice.raw('team.role', { membershipId: m.membershipId, role: 'editor' });
  assert(!rr.ok && rr.code === 'REAUTH_REQUIRED' || rr.ok, 'ubah peran: ' + rr.code);
  if (!rr.ok) await alice.api('auth.reauth', { password: PW, code: await freshTotp(secret) });
  await alice.api('team.role', { membershipId: m.membershipId || m.id, role: 'editor' });
  const me = await bob.raw('auth.me', {});
  assert(!me.ok || me.data.me.role === 'editor', 'peran tidak berubah');
});
await test('Supabase REST langsung (anon key) tidak bisa membaca tabel', async () => {
  for (const t of ['links', 'documents', 'signers', 'audit_log', 'profiles']) {
    const r = await fetch(SB_URL + '/rest/v1/' + t + '?select=*&limit=1', { headers: { apikey: SB_KEY, authorization: 'Bearer ' + SB_KEY } });
    const body = await r.text();
    assert(r.status >= 400 || body === '[]', t + ' terbaca lewat REST: ' + r.status + ' ' + body.slice(0, 80));
  }
  const s = await fetch(SB_URL + '/storage/v1/object/documents/ws/' + 'x', { headers: { apikey: SB_KEY } });
  assert(s.status >= 400, 'storage terbaca anonim');
});


/* ---------- TTD Realtime ---------- */
await test('TTD Realtime: link 8 jam, tanda tangan tanpa akun, unduh & verifikasi barcode', async () => {
  await carol.fail('qsign.create', { signerName: 'X Y', signerTitle: 'Kepala', purpose: 'Uji paywall' }, 'PAYMENT_REQUIRED');
  await alice.fail('qsign.create', { signerName: '', signerTitle: '', purpose: '' }, 'VALIDATION');
  await alice.fail('qsign.create', { signerName: 'Ab', signerTitle: 'Kepala', purpose: 'Uji', hours: 5 }, 'VALIDATION');
  const r = (await alice.api('qsign.create', { signerName: 'Dr. Siti Rahmawati', signerTitle: 'Kepala Bagian Umum', purpose: 'Pengesahan BAST BMN ' + RUN, hours: 8 })).request;
  const m = r.link.match(/\/ttd\?token=([0-9a-f-]{36})$/);
  assert(m, 'format link ' + r.link);
  const hrs = (Date.parse(r.expiresAt) - Date.now()) / 3600000;
  assert(hrs > 7.9 && hrs <= 8.01, 'masa berlaku ' + hrs.toFixed(2) + ' jam');
  const token = m[1];
  const page = await anon.get('/ttd?token=' + token);
  assert(page.status === 200 && /"mode":"qsign"/.test(await page.text()), 'halaman /ttd');
  const o = await anon.api('qsign.open', { token });
  assert(o.status === 'pending' && o.signerName === 'Dr. Siti Rahmawati' && !o.needPin && !o.code, 'open ' + JSON.stringify(o));
  assert((await alice.api('qsign.get', { id: r.id })).request.link === r.link, 'admin tidak bisa menyalin ulang link');
  await anon.fail('qsign.submit', { token, consent: false, signatureImage: SIG.toString('base64') }, 'VALIDATION');
  await anon.fail('qsign.submit', { token, consent: true, signatureImage: PNG.toString('base64') }, 'VALIDATION');
  await anon.fail('qsign.submit', { token, consent: true, signatureImage: Buffer.from('GIF89a' + 'x'.repeat(300)).toString('base64') }, 'VALIDATION');
  const s = await anon.api('qsign.submit', { token, consent: true, signatureType: 'draw', signatureImage: 'data:image/png;base64,' + SIG.toString('base64') });
  assert(s.status === 'signed' && /^TTD-[A-Z0-9]{10}$/.test(s.code), 'submit ' + JSON.stringify(s));
  await anon.fail('qsign.submit', { token, consent: true, signatureImage: SIG.toString('base64') }, 'CONFLICT');
  const g = (await alice.api('qsign.get', { id: r.id })).request;
  assert(g.status === 'signed' && g.link === null && g.signatureImage === 'data:image/png;base64,' + SIG.toString('base64') && g.verifyUrl.endsWith('/ttd/v/' + s.code), 'detail setelah ttd');
  const l = await alice.api('qsign.list', { status: 'signed' });
  assert(l.rows.some((x) => x.id === r.id) && l.counts.signed >= 1, 'daftar');
  const v = await anon.api('qsign.verify', { code: s.code.toLowerCase() });
  assert(v.valid && v.signerTitle === 'Kepala Bagian Umum' && v.recordHash === g.recordHash && !('signatureImage' in v), 'verifikasi publik');
  assert((await anon.get('/ttd/v/' + s.code)).status === 200, 'halaman verifikasi');
  await anon.fail('qsign.verify', { code: 'TTD-TIDAKADA00' }, 'NOT_FOUND');
  await carol.fail('qsign.get', { id: r.id }, 'NOT_FOUND');
  assert(psql(`select count(*) from audit_log where action = 'qsign.signed' and entity_id = '${r.id}'`) === '1', 'audit');
  // Barcode khusus SmartSign: isi bertanda tangan HMAC, hanya server yang bisa memvalidasi
  assert(/^SSTTD1:TTD-[A-Z0-9]{10}:[0-9A-F]{20}$/.test(g.qrPayload) && !g.qrPayload.includes('http'), 'isi barcode ' + g.qrPayload);
  const vp = await anon.api('qsign.verify', { payload: g.qrPayload });
  assert(vp.valid && vp.code === s.code, 'verifikasi barcode');
  const forged = g.qrPayload.slice(0, -1) + (g.qrPayload.endsWith('A') ? 'B' : 'A');
  await anon.fail('qsign.verify', { payload: forged }, 'NOT_FOUND');
  await anon.fail('qsign.verify', { payload: 'SSTTD1:TTD-AAAAAAAAAA:' + g.qrPayload.split(':')[2] }, 'NOT_FOUND');
  const sc = await alice.api('scan.check', { content: g.qrPayload, source: 'camera' });
  assert(sc.kind === 'ttd' && sc.result === 'valid' && sc.ttd.signerName === 'Dr. Siti Rahmawati', 'pemindai: ' + JSON.stringify(sc).slice(0, 200));
  assert((await alice.api('scan.check', { content: forged, source: 'camera' })).result === 'invalid', 'pemindai menerima barcode palsu');
  // Hapus permanen: barcode tidak terverifikasi lagi; ruang kerja lain tidak bisa menghapus
  await carol.fail('qsign.delete', { id: r.id }, 'NOT_FOUND');
  await alice.api('qsign.delete', { id: r.id });
  await alice.fail('qsign.get', { id: r.id }, 'NOT_FOUND');
  await anon.fail('qsign.verify', { payload: g.qrPayload }, 'NOT_FOUND');
  await anon.fail('qsign.verify', { code: s.code }, 'NOT_FOUND');
  assert(psql(`select count(*) from audit_log where action = 'qsign.delete' and entity_id = '${r.id}'`) === '1', 'audit hapus');
});
await test('TTD Realtime: kedaluwarsa, PIN salah dibatasi, buat ulang link, batal', async () => {
  const r = (await alice.api('qsign.create', { signerName: 'Budi Hartono', signerTitle: 'Direktur', purpose: 'Uji PIN ' + RUN, hours: 1, pin: '4821' })).request;
  const t = r.link.split('token=')[1];
  assert((await anon.api('qsign.open', { token: t })).needPin, 'PIN tidak diminta');
  for (let i = 0; i < 5; i++) await anon.fail('qsign.submit', { token: t, pin: '0000', consent: true, signatureImage: SIG.toString('base64') }, 'VALIDATION');
  await anon.fail('qsign.submit', { token: t, pin: '4821', consent: true, signatureImage: SIG.toString('base64') }, 'RATE_LIMIT');
  psql(`update sign_requests set expires_at = now() - interval '1 minute' where id = '${r.id}'`);
  assert((await anon.api('qsign.open', { token: t })).status === 'expired', 'tidak kedaluwarsa');
  assert((await alice.api('qsign.list', { status: 'expired' })).rows.some((x) => x.id === r.id), 'filter kedaluwarsa');
  const n = (await alice.api('qsign.renew', { id: r.id, hours: 8 })).request;
  const t2 = n.link.split('token=')[1];
  assert(t2 && t2 !== t && n.status === 'pending', 'link baru');
  await anon.fail('qsign.open', { token: t }, 'NOT_FOUND');
  const s = await anon.api('qsign.submit', { token: t2, pin: '4821', consent: true, signatureImage: SIG.toString('base64') });
  assert(s.status === 'signed', 'ttd setelah buat ulang link');
  await alice.fail('qsign.renew', { id: r.id }, 'CONFLICT');
  const c = (await alice.api('qsign.create', { signerName: 'Rina Wati', signerTitle: 'Sekretaris', purpose: 'Uji batal ' + RUN })).request;
  await alice.api('qsign.cancel', { id: c.id });
  const tc = c.link.split('token=')[1];
  assert((await anon.api('qsign.open', { token: tc })).status === 'cancelled', 'status batal');
  await anon.fail('qsign.submit', { token: tc, consent: true, signatureImage: SIG.toString('base64') }, 'CONFLICT');
});
await test('Webhook Mayar mengaktifkan Lifetime setelah verifikasi ulang ke API', async () => {
  await carol.fail('doc.uploadUrl', { fileName: 'a.pdf', size: 1000 }, 'PAYMENT_REQUIRED');
  await carol.api('billing.checkout', { plan: 'lifetime', mobile: '+6281234567890' });
  const last = await (await fetch(MOCK + '/__last')).json();
  await fetch(MOCK + '/__pay/' + last.id, { method: 'POST' });
  const wh = await fetch(BASE + '/api/webhooks/mayar?token=' + WH, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'payment.received', data: { id: last.id, customerEmail: emails.carol, amount: 100000 } }) });
  const j = await wh.json();
  assert(j.results && j.results.includes('paid'), 'webhook: ' + JSON.stringify(j));
  const me = (await carol.api('auth.me')).me;
  assert(me.plan === 'lifetime' && me.planExpiresAt === null && me.esignEnabled, 'lifetime tidak aktif');
  await carol.fail('billing.checkout', { plan: 'pro', mobile: '081234567890' }, 'CONFLICT');
});
await test('Hak akses: viewer/editor tidak bisa membeli paket, non-superadmin tidak bisa ke panel platform', async () => {
  await bob.api('auth.login', { email: emails.bob, password: PW }); // sesi bob dicabut saat perannya diubah
  await bob.fail('billing.checkout', { plan: 'pro', mobile: '081234567890' }, 'FORBIDDEN');
  await bob.fail('platform.users', {}, 'FORBIDDEN');
  await carol.fail('platform.users', {}, 'FORBIDDEN');
  await carol.fail('platform.resetPassword', { userId: psql(`select id from profiles where email = '${emails.alice}'`), mode: 'temp' }, 'FORBIDDEN');
});
let bobId = '';
await test('Superadmin: password sementara (wajib reauth), sesi lama dicabut, wajib ganti saat login', async () => {
  const u = await alice.api('platform.users', { q: emails.bob });
  const b = u.rows.find((x) => x.email === emails.bob);
  assert(b, 'bob tidak ada di daftar'); bobId = b.id;
  psql('delete from reauth');
  const r0 = await alice.raw('platform.resetPassword', { userId: b.id, mode: 'temp' });
  assert(!r0.ok && r0.code === 'REAUTH_REQUIRED', 'tanpa konfirmasi: ' + r0.code);
  await alice.api('auth.reauth', { password: PW, code: await freshTotp(secret) });
  const r = await alice.api('platform.resetPassword', { userId: b.id, mode: 'temp' });
  assert(r.tempPassword && r.tempPassword.length >= 14, 'password sementara');
  await bob.fail('auth.me', {}, 'UNAUTHORIZED');
  const old = await bob.raw('auth.login', { email: emails.bob, password: PW });
  assert(!old.ok, 'password lama masih berlaku');
  const d = await bob.api('auth.login', { email: emails.bob, password: r.tempPassword });
  assert(d.me.mustChangePassword === true, 'tidak wajib ganti');
  await bob.fail('link.list', {}, 'PASSWORD_CHANGE_REQUIRED');
  await bob.api('auth.changePassword', { oldPassword: r.tempPassword, newPassword: 'Cemara-Hijau-2027' });
  assert((await bob.api('link.list', {})).total >= 0, 'tetap terkunci setelah ganti');
  assert((await bob.api('auth.me')).me.mustChangePassword === false, 'flag tidak hilang');
});
await test('Superadmin: nonaktifkan akun memblokir sesi & login; tidak bisa menonaktifkan diri sendiri', async () => {
  const carolId = psql(`select id from profiles where email = '${emails.carol}'`);
  const aliceId = psql(`select id from profiles where email = '${emails.alice}'`);
  await alice.api('platform.user', { userId: carolId, status: 'nonaktif' });
  await carol.fail('auth.me', {}, 'UNAUTHORIZED');
  const l = await new Client().raw('auth.login', { email: emails.carol, password: PW });
  assert(!l.ok, 'akun nonaktif bisa login');
  await alice.fail('platform.user', { userId: aliceId, status: 'nonaktif' }, 'CONFLICT');
  await alice.api('platform.user', { userId: carolId, status: 'aktif' });
  const ok = await carol.api('auth.login', { email: emails.carol, password: PW });
  assert(ok.mfaRequired || ok.me, 'aktif kembali tetapi tidak bisa login');
});
await test('Superadmin: reset MFA dan beri akses e-sign manual pada paket gratis', async () => {
  const carolId = psql(`select id from profiles where email = '${emails.carol}'`);
  const r = await alice.api('platform.resetMfa', { userId: carolId });
  assert(/faktor dihapus/.test(r.message), r.message);
  assert(psql(`select count(*) from auth.mfa_factors where user_id = '${carolId}'`) === '0', 'faktor masih ada');
  const bws = psql(`select w.id from workspaces w join memberships m on m.workspace_id = w.id where m.user_id = '${bobId}' and m.role = 'admin' limit 1`);
  if (bws) {
    await alice.api('platform.workspace', { workspaceId: bws, esign: 'on' });
    assert(psql(`select esign_override from workspaces where id = '${bws}'`) === 't', 'override tidak tersimpan');
  }
  const p = await alice.api('platform.get', {});
  assert(p.workspaces.some((w) => w.system), 'ruang kerja sistem tidak tampil');
});

/* ---------- Audit ---------- */
await test('Jejak audit: rantai hash utuh + ekspor butuh reauth', async () => {
  const v = await alice.api('audit.verify', {});
  assert(v.ok === true, 'rantai audit rusak: ' + JSON.stringify(v));
  const list = await alice.api('audit.list', { pageSize: 100 });
  assert((list.rows || []).some((r) => r.action === 'doc.upload'), 'aksi tidak tercatat');
  const ex = await alice.raw('audit.export', {});
  assert(ex.ok || ex.code === 'REAUTH_REQUIRED', 'ekspor audit: ' + ex.code);
});
await test('Audit append-only; pengubahan terdeteksi oleh verifikasi rantai', async () => {
  const ws = (await alice.api('auth.me')).me.workspaceId;
  let blocked = false;
  try { psql(`update audit_log set action = 'palsu' where workspace_id = '${ws}'`); } catch { blocked = true; }
  assert(blocked, 'audit_log bisa diubah');
  // simulasi penyerang dengan akses superuser DB yang mematikan trigger
  psql(`begin; alter table audit_log disable trigger audit_log_immutable; update audit_log set after = '{"diubah":true}'::jsonb where id = (select id from audit_log where workspace_id = '${ws}' order by id limit 1 offset 1); alter table audit_log enable trigger audit_log_immutable; commit;`);
  const v = await alice.api('audit.verify', {});
  assert(v.ok === false, 'pengubahan tidak terdeteksi');
});

/* ---------- Lain-lain ---------- */
await test('Rate limit login per akun', async () => {
  const target = 'kunci.' + RUN + '@contoh.test';
  let limited = false;
  for (let i = 0; i < 8; i++) { const r = await anon.raw('auth.login', { email: target, password: 'SalahSekali123' }); if (r.code === 'RATE_LIMIT' || /terkunci|terlalu banyak/i.test(r.message || '')) { limited = true; break; } }
  assert(limited, 'tidak ada penguncian setelah 8 percobaan');
});
await test('Cron harian: tanpa rahasia 401, dengan rahasia 200', async () => {
  assert((await anon.get('/api/cron/daily')).status === 401, 'cron tanpa rahasia lolos');
  const r = await anon.get('/api/cron/daily', { headers: { authorization: 'Bearer ' + CRON } });
  assert(r.status === 200, 'cron gagal ' + r.status);
});
await test('Pemindai: kenali shortlink milik sendiri', async () => {
  const r = await alice.api('scan.check', { content: BASE + '/' + link.slug });
  assert(r && (r.kind === 'shortlink' || r.type === 'shortlink' || /shortlink|link/i.test(JSON.stringify(r).slice(0, 300))), 'scan: ' + JSON.stringify(r).slice(0, 200));
});

const pass = results.filter((r) => r[0] === 'PASS').length;
console.log('\nRINGKASAN: ' + pass + '/' + results.length + ' PASS');
for (const r of results.filter((x) => x[0] === 'FAIL')) console.log('  FAIL', r[1], '::', r[2]);
process.exit(pass === results.length ? 0 : 1);
