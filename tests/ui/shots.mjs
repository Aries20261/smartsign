// Render UI nyata di Chrome headless (desktop 1366 px dan ponsel 360 px) + tangkap error konsol/CSP.
// Prasyarat sama dengan tests/e2e/run.mjs. Jalankan: node tests/ui/shots.mjs <folder-output>
import { createRequire } from 'node:module';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
const require = createRequire(import.meta.url);
import postgres from 'postgres';
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
// Demo: paket Lifetime + superadmin langsung lewat DB lokal (agar halaman e-sign & panel platform bisa dipotret)
if (process.env.DATABASE_URL) {
  const sql = postgres(process.env.DATABASE_URL, { max: 1 });
  await sql`update profiles set platform_role = 'superadmin' where email = ${email}`;
  await sql`update workspaces set plan = 'lifetime', plan_expires_at = null where owner_id = (select id from profiles where email = ${email})`;
  await sql.end();
} else throw new Error('Set DATABASE_URL (lokal) untuk menjalankan tes tampilan');
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

// TTD Realtime: satu menunggu, satu ditandatangani lewat browser (lihat aksi di bawah)
const qsPending = (await rpc('qsign.create', { signerName: 'Prof. Dr. Ahmad Fauzi, M.Si.', signerTitle: 'Direktur Jenderal Pendidikan Tinggi', purpose: 'Pengesahan Berita Acara Serah Terima BMN No. 12/BAST/2026', hours: 8 })).request;
const qsSign = (await rpc('qsign.create', { signerName: 'Dr. Siti Rahmawati, M.Pd.', signerTitle: 'Kepala Bagian Umum', purpose: 'Persetujuan perjalanan dinas ke Surabaya, 2 sampai 4 Desember 2026', hours: 8 })).request;

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
const drawAndSubmit = async (pg) => {
  const box = await pg.locator('canvas.sig-pad').boundingBox();
  await pg.mouse.move(box.x + 30, box.y + 120); await pg.mouse.down();
  for (let i = 0; i <= 40; i++) await pg.mouse.move(box.x + 30 + i * 8, box.y + 100 - Math.sin(i / 3) * 40 + (i % 7) * 2, { steps: 2 });
  await pg.mouse.up();
  await pg.mouse.move(box.x + 120, box.y + 60); await pg.mouse.down(); await pg.mouse.move(box.x + 200, box.y + 140, { steps: 8 }); await pg.mouse.up();
  await sleep(200);
  await pg.screenshot({ path: OUT + '/21-ttd-penanda-isi.png' });
  await pg.check('#f-consent');
  await pg.click('button:has-text("Kirim tanda tangan")');
  await pg.waitForSelector('text=Tanda tangan Anda sudah diterima', { timeout: 8000 });
};
const qsTok = (r) => r.link.slice(r.link.indexOf('/ttd?'));
const shots = [
  ['19-ttd-daftar', '/#/ttd'], ['20-ttd-link', '/#/ttd/' + qsPending.id, { wait: 1800 }],
  ['21-ttd-penanda', qsTok(qsSign), { auth: false, act: drawAndSubmit }],
  ['00-beranda', '/', { auth: false }], ['00b-harga', '/', { auth: false, act: async (pg) => { await pg.evaluate(() => document.querySelector('#harga').scrollIntoView()); await sleep(300); } }],
  ['01-login', '/', { auth: false, act: async (pg) => { await pg.click('header button:has-text("Masuk")'); await sleep(400); } }], ['15-paket', '/#/billing'], ['16-platform-pengguna', '/#/platform'], ['17-platform-workspace', '/#/platform/workspaces'], ['18-platform-pembayaran', '/#/platform/payments'], ['02-dashboard', '/#/dashboard'], ['03-links', '/#/links'], ['04-analitik', '/#/analytics', { wait: 2000 }],
  ['05-qr', '/#/qr', { wait: 1800 }], ['06-dokumen', '/#/docs/' + doc.id, { wait: 2500 }], ['07-tim', '/#/team'], ['08-audit', '/#/audit'], ['09-keamanan', '/#/security'],
  ['10-tanda-tangan', signPath, { auth: false, wait: 1500 }], ['11-verifikasi', '/verify?code=' + doc.code, { auth: false, wait: 1800 }], ['12-scanner', '/#/scanner'],
  ['13-perantara-password', '/go/' + pwLink.slug, { auth: false }], ['14-tidak-ditemukan', '/go/tidakada' + RUN, { auth: false }]
];
for (const [n, p, o] of shots) await shoot(n, p, o);
const qsDone = (await rpc('qsign.get', { id: qsSign.id })).request;
if (qsDone.status !== 'signed') issues.push('TTD Realtime: tanda tangan lewat browser tidak tersimpan (' + qsDone.status + ')');
for (const [n, p, o] of [['22-ttd-hasil', '/#/ttd/' + qsSign.id, { wait: 2500 }], ['23-ttd-verifikasi', '/ttd/v/' + qsDone.code, { auth: false, wait: 1500 }], ['24-ttd-daftar-selesai', '/#/ttd']]) await shoot(n, p, o);
// unduhan spesimen/barcode harus menghasilkan PNG
{
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 }, acceptDownloads: true }); await ctx.addCookies(cookies);
  const pg = await ctx.newPage(); await pg.goto(BASE + '/#/ttd/' + qsSign.id, { waitUntil: 'networkidle' }); await sleep(1500);
  for (const label of ['Unduh spesimen PNG', 'Unduh barcode PNG', 'Unduh tanda tangan PNG']) {
    const [dl] = await Promise.all([pg.waitForEvent('download', { timeout: 8000 }), pg.click('button:has-text("' + label + '")')]);
    const path = OUT + '/' + dl.suggestedFilename(); await dl.saveAs(path);
    const head = (await import('node:fs')).readFileSync(path).subarray(0, 4).toString('hex');
    if (head !== '89504e47') issues.push('unduhan ' + label + ' bukan PNG');
    if (label === 'Unduh barcode PNG') globalThis.barcodePath = path;
  }
  // Barcode hasil unduhan harus terbaca oleh pemindai SmartSign (dalam aplikasi dan halaman publik)
  await pg.goto(BASE + '/#/scanner', { waitUntil: 'networkidle' }); await sleep(800);
  await pg.click('[role=tab]:has-text("Unggah")');
  await pg.setInputFiles('#scan-img', globalThis.barcodePath);
  try { await pg.waitForSelector('.result-card.valid', { timeout: 10000 }); await pg.screenshot({ path: OUT + '/25-scanner-barcode-ttd.png' }); }
  catch { issues.push('Scanner aplikasi tidak memvalidasi barcode TTD'); await pg.screenshot({ path: OUT + '/25-scanner-barcode-ttd-GAGAL.png' }); }
  await ctx.close();
  const pctx = await browser.newContext({ viewport: { width: 1366, height: 860 } });
  const pp = await pctx.newPage(); await pp.goto(BASE + '/ttd/v', { waitUntil: 'networkidle' }); await sleep(600);
  await pp.setInputFiles('#qv-file', globalThis.barcodePath);
  try { await pp.waitForSelector('text=Tanda tangan elektronik asli dan tercatat', { timeout: 10000 }); await pp.screenshot({ path: OUT + '/26-verifikasi-publik-pindai.png' }); }
  catch { issues.push('Halaman verifikasi publik tidak membaca barcode TTD'); await pp.screenshot({ path: OUT + '/26-GAGAL.png' }); }
  await pctx.close();
}
for (const [n, p, o] of [['m19-ttd-daftar', '/#/ttd'], ['m22-ttd-hasil', '/#/ttd/' + qsSign.id, { wait: 2500 }], ['m21-ttd-penanda', qsTok(qsPending), { auth: false }], ['m23-ttd-verifikasi', '/ttd/v/' + qsDone.code, { auth: false, wait: 1500 }], ['m00-beranda', '/', { auth: false }], ['m01-login', '/', { auth: false, act: async (pg) => { await pg.click('header button:has-text("Masuk")'); await sleep(400); } }], ['m15-paket', '/#/billing'], ['m16-platform', '/#/platform'], ['m02-dashboard', '/#/dashboard'], ['m03-links', '/#/links'], ['m06-dokumen', '/#/docs/' + doc.id, { wait: 2500 }], ['m10-tanda-tangan', signPath, { auth: false, wait: 1500 }], ['m11-verifikasi', '/verify?code=' + doc.code, { auth: false, wait: 1800 }]])
  await shoot(n, p, { ...(o || {}), width: 360, height: 780 });
await browser.close();
writeFileSync(OUT + '/console.txt', issues.join('\n') || 'Tidak ada error konsol / CSP / overflow.');
console.log(issues.length ? 'MASALAH:\n' + issues.join('\n') : 'OK: tanpa error konsol, CSP, atau overflow');
