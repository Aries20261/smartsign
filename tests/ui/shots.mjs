// Render UI nyata di Chrome headless (desktop 1366 px dan ponsel 360 px) + tangkap error konsol/CSP.
// Prasyarat sama dengan tests/e2e/run.mjs. Jalankan: node tests/ui/shots.mjs <folder-output>
import { createRequire } from 'node:module';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = process.env.BASE || 'http://localhost:3000';
const MAILPIT = process.env.MAILPIT || 'http://127.0.0.1:54324';
const OUT = process.argv[2] || 'shots';
mkdirSync(OUT, { recursive: true });
const RUN = randomBytes(3).toString('hex');
const PW = 'Lembayung-Senja-2026';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const jar = new Map();
async function rpc(action, payload = {}) {
  const res = await fetch(BASE + '/api/rpc', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, 'x-requested-with': 'smartsign', cookie: [...jar].map(([k, v]) => k + '=' + v).join('; ') }, body: JSON.stringify({ action, payload }) });
  for (const c of res.headers.getSetCookie()) { const kv = c.split(';')[0]; const i = kv.indexOf('='); const v = kv.slice(i + 1); if (v) jar.set(kv.slice(0, i), v); else jar.delete(kv.slice(0, i)); }
  const r = await res.json(); if (!r.ok) throw new Error(action + ': ' + r.message + JSON.stringify(r.fields || '')); return r.data;
}
async function mail(to, re) {
  for (let i = 0; i < 40; i++) {
    const r = await (await fetch(MAILPIT + '/api/v1/search?query=' + encodeURIComponent('to:' + to))).json();
    const m = (r.messages || []).find((x) => re.test(x.Subject));
    if (m) { const full = await (await fetch(MAILPIT + '/api/v1/message/' + m.ID)).json(); return { subject: m.Subject, text: full.Text + full.HTML }; }
    await sleep(250);
  }
  throw new Error('email tidak datang: ' + to);
}
function b32(s) { const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = ''; for (const ch of s.replace(/=+$/, '').toUpperCase()) bits += a.indexOf(ch).toString(2).padStart(5, '0'); const o = []; for (let i = 0; i + 8 <= bits.length; i += 8) o.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(o); }
function totp(sec) { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000))); const h = createHmac('sha1', b32(sec)).update(b).digest(); const o = h[h.length - 1] & 15; return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0'); }

// --- siapkan akun + data contoh lewat API ---
const email = 'demo.' + RUN + '@contoh.test';
await rpc('auth.register', { email, nama: 'Rina Pratama', password: PW });
const conf = await mail(email, /./);
const href = conf.text.match(/https?:\/\/[^\s"'<>]+\/auth\/confirm\?[^\s"'<>]+/)[0].replace(/&amp;/g, '&');
await fetch(href, { redirect: 'manual' });
await rpc('auth.login', { email, password: PW });
const mf = await rpc('auth.mfaStart', {});
await rpc('auth.mfaConfirm', { code: totp(mf.secret) });
const links = [['https://www.tokopedia.com/promo/akhir-tahun', 'Promo Akhir Tahun', 'promo-akhir-' + RUN], ['https://docs.google.com/forms/d/e/abc/viewform', 'Formulir Pendaftaran', 'daftar-' + RUN], ['https://example.com/katalog-2026.pdf', 'Katalog 2026', '']];
for (const [d, t, s] of links) await rpc('link.create', { destination: d, title: t, slug: s, utm: { source: 'instagram', medium: 'social', campaign: 'desember' } });
const pwLink = (await rpc('link.create', { destination: 'https://example.org/laporan-internal', title: 'Laporan Internal', password: 'kunci-1234' })).link;
const list = await rpc('link.list', {});
const uas = ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1', 'Mozilla/5.0 (Windows NT 10.0; Win64) Chrome/130.0', 'Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile', 'Mozilla/5.0 (Macintosh) Safari/605.1'];
for (let i = 0; i < 24; i++) { const l = list.rows[i % list.rows.length]; await fetch(BASE + '/' + l.slug + (i % 3 ? '' : '?q=1'), { redirect: 'manual', headers: { 'user-agent': uas[i % 4], referer: i % 2 ? 'https://instagram.com/' : '' } }); }
const pdf = await PDFDocument.create(); const f = await pdf.embedFont(StandardFonts.Helvetica);
for (let i = 0; i < 2; i++) { const p = pdf.addPage([595, 842]); p.drawText('PERJANJIAN KERJA SAMA', { x: 180, y: 780, size: 16, font: f }); for (let k = 0; k < 18; k++) p.drawText('Pasal ' + (k + 1) + '. Para pihak sepakat untuk melaksanakan ketentuan dengan itikad baik.', { x: 60, y: 730 - k * 24, size: 10, font: f }); }
const bytes = Buffer.from(await pdf.save());
const up = await rpc('doc.uploadUrl', { fileName: 'perjanjian.pdf', size: bytes.length });
await fetch(up.url, { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: bytes });
const doc = (await rpc('doc.upload', { path: up.path, fileName: 'perjanjian.pdf', title: 'Perjanjian Kerja Sama Vendor', pageCount: 2, clientHash: createHash('sha256').update(bytes).digest('hex') })).doc;
const signerEmail = 'budi.' + RUN + '@contoh.test';
await rpc('doc.setup', { id: doc.id, title: 'Perjanjian Kerja Sama Vendor', signingOrder: 'sequential', expiresInDays: 14, signers: [{ nama: 'Budi Santoso', email: signerEmail, fields: [{ id: 'sig1', type: 'signature', page: 2, x: 0.55, y: 0.78, w: 0.3, h: 0.08 }, { id: 'n1', type: 'name', page: 2, x: 0.55, y: 0.87, w: 0.3, h: 0.03 }] }] });
await rpc('doc.send', { id: doc.id });
const inv = await mail(signerEmail, /Permintaan tanda tangan/);
const signPath = inv.text.match(/\/sign\/[A-Za-z0-9_-]{20,}/)[0];

// --- browser ---
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const issues = [];
const cookies = [...jar].map(([name, value]) => ({ name, value, url: BASE }));
async function shoot(name, path, { width = 1366, height = 860, auth = true, wait = 1200, act } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, locale: 'id-ID', timezoneId: 'Asia/Jakarta' });
  if (auth) await ctx.addCookies(cookies);
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() !== 'error') return; const t = m.text();
    // 401 dari pemeriksaan sesi (auth.me) di halaman login dan 404 di halaman 'tidak ditemukan' memang diharapkan
    if ((!auth && /status of 401/.test(t)) || (name.includes('tidak-ditemukan') && /status of 404/.test(t))) return; issues.push(name + ': ' + t); });
  page.on('pageerror', (e) => issues.push(name + ' (pageerror): ' + e.message));
  await page.goto(BASE + path, { waitUntil: 'networkidle' });
  await sleep(wait);
  if (act) await act(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 1) issues.push(name + ': meluber horizontal ' + overflow + 'px');
  await page.screenshot({ path: OUT + '/' + name + '.png', fullPage: false });
  await ctx.close();
}
const shots = [
  ['01-login', '/', { auth: false }], ['02-dashboard', '/#/dashboard'], ['03-links', '/#/links'], ['04-analitik', '/#/analytics', { wait: 2000 }],
  ['05-qr', '/#/qr', { wait: 1800 }], ['06-dokumen', '/#/docs/' + doc.id, { wait: 2500 }], ['07-tim', '/#/team'], ['08-audit', '/#/audit'], ['09-keamanan', '/#/security'],
  ['10-tanda-tangan', signPath, { auth: false, wait: 1500 }], ['11-verifikasi', '/verify?code=' + doc.code, { auth: false, wait: 1800 }], ['12-scanner', '/#/scanner'],
  ['13-perantara-password', '/go/' + pwLink.slug, { auth: false }], ['14-tidak-ditemukan', '/go/tidakada' + RUN, { auth: false }]
];
for (const [n, p, o] of shots) await shoot(n, p, o);
for (const [n, p, o] of [['m01-login', '/', { auth: false }], ['m02-dashboard', '/#/dashboard'], ['m03-links', '/#/links'], ['m06-dokumen', '/#/docs/' + doc.id, { wait: 2500 }], ['m10-tanda-tangan', signPath, { auth: false, wait: 1500 }], ['m11-verifikasi', '/verify?code=' + doc.code, { auth: false, wait: 1800 }]])
  await shoot(n, p, { ...(o || {}), width: 360, height: 780 });
await browser.close();
writeFileSync(OUT + '/console.txt', issues.join('\n') || 'Tidak ada error konsol / CSP / overflow.');
console.log(issues.length ? 'MASALAH:\n' + issues.join('\n') : 'OK: tanpa error konsol, CSP, atau overflow');
