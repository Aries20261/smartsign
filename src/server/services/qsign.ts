/**
 * TTD Realtime: pengguna berbayar membuat permintaan tanda tangan (nama pejabat, jabatan, tujuan),
 * lalu membagikan tautan berbatas waktu (default 8 jam). Penanda tangan menggambar tanda tangannya
 * tanpa perlu akun. Hasilnya tersimpan di ruang kerja dan bisa diunduh sebagai gambar tanda tangan
 * + barcode (QR) verifikasi publik.
 */
import crypto from 'node:crypto';
import { db } from '../db';
import { APP, ENV } from '../config';
import { AppError, vErr } from '../errors';
import { audit } from '../audit';
import { rateBump, rateCount, rateLimit, rateReset } from '../ratelimit';
import { sendMail } from '../mail';
import type { Ctx, ReqInfo } from '../session';
import { getFile, putFile, removeFiles } from '../storage';
import { hashSecret, hmacHex, int, paginate, parseUa, randomSlug, sha256Hex, str, verifySecret } from '../util';
import { assertEsign } from './docs';

export const QSIGN_HOURS = [1, 2, 4, 8, 12, 24, 48, 72];
const PIN_MAX_FAIL = 5;
const LABEL: Record<string, string> = { pending: 'Menunggu tanda tangan', signed: 'Sudah ditandatangani', expired: 'Kedaluwarsa', cancelled: 'Dibatalkan' };

/* ---------- token: disimpan sebagai hash (untuk mencari) + terenkripsi (agar admin bisa menyalin ulang tautan) ---------- */
const key = () => crypto.createHash('sha256').update('qsign:' + (ENV.appSecret || 'smartsign')).digest();
function enc(token: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([c.update(token, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url');
}
function dec(v: string): string {
  try {
    const b = Buffer.from(v, 'base64url');
    const d = crypto.createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch { return ''; }
}
const tokenHash = (t: string) => sha256Hex('qsign:' + t);
export const qsignLink = (token: string) => ENV.appUrl + '/ttd?token=' + encodeURIComponent(token);
export const qsignVerifyUrl = (code: string) => ENV.appUrl + '/ttd/v/' + encodeURIComponent(code);

/**
 * Isi barcode TTD: bukan URL, melainkan kode + tanda tangan HMAC dengan APP_SECRET.
 * Pemindai biasa hanya melihat teks tak bermakna; hanya pemindai SmartSign (server) yang bisa memvalidasi.
 */
const QR_PREFIX = 'SSTTD1:';
export function qsignQrPayload(code: string): string { return QR_PREFIX + code + ':' + hmacHex(ENV.appSecret || 'smartsign', 'qsign-qr:' + code).slice(0, 20).toUpperCase(); }
export function isQsignPayload(text: string): boolean { return String(text || '').trim().toUpperCase().startsWith(QR_PREFIX); }
/** Kembalikan kode bila barcode asli; null bila palsu/rusak. */
export function parseQsignPayload(text: string): string | null {
  const m = /^SSTTD1:(TTD-[A-Z0-9]{6,20}):([0-9A-F]{20})$/.exec(String(text || '').trim().toUpperCase());
  if (!m) return null;
  return qsignQrPayload(m[1]) === m[0] ? m[1] : null;
}

const effStatus = (r: any) => (r.status === 'pending' && new Date(r.expiresAt).getTime() <= Date.now() ? 'expired' : r.status);

function view(r: any, withLink: boolean) {
  const status = effStatus(r);
  return {
    id: r.id, code: r.code, signerName: r.signerName, signerTitle: r.signerTitle, purpose: r.purpose,
    status, statusLabel: LABEL[status] || status, hasPin: !!r.pinHash, validHours: r.validHours,
    expiresAt: r.expiresAt, openedAt: r.openedAt, signedAt: r.signedAt, createdAt: r.createdAt,
    createdBy: r.createdByName || null, signatureType: r.signatureType, recordHash: r.recordHash, signerDevice: r.signerDevice,
    link: withLink && status === 'pending' ? qsignLink(dec(r.tokenEnc)) : null,
    verifyUrl: status === 'signed' ? qsignVerifyUrl(r.code) : null,
    qrPayload: status === 'signed' ? qsignQrPayload(r.code) : null
  };
}

function readFields(p: any) {
  const signerName = str(p.signerName, 120), signerTitle = str(p.signerTitle, 160), purpose = str(p.purpose, 500);
  const fields: Record<string, string> = {};
  if (signerName.length < 2) fields.signerName = 'Isi nama pejabat/penanda tangan.';
  if (signerTitle.length < 2) fields.signerTitle = 'Isi jabatan.';
  if (purpose.length < 3) fields.purpose = 'Isi tujuan tanda tangan.';
  const hours = int(p.hours, 8, 1, 72);
  if (!QSIGN_HOURS.includes(hours)) fields.hours = 'Pilih batas waktu yang tersedia.';
  const pin = str(p.pin, 12);
  if (pin && !/^\d{4,8}$/.test(pin)) fields.pin = 'PIN harus 4 sampai 8 angka.';
  if (Object.keys(fields).length) throw new AppError('VALIDATION', 'Periksa kembali isian Anda.', fields);
  return { signerName, signerTitle, purpose, hours, pin };
}

/* ---------- pengguna login ---------- */
export async function qsignCreate(p: any, u: Ctx) {
  assertEsign(u);
  const f = readFields(p);
  await rateLimit('qsign:create:' + u.workspaceId, 120, 3600, 'Terlalu banyak permintaan tanda tangan dibuat. Coba lagi nanti.');
  const token = crypto.randomUUID();
  const code = 'TTD-' + randomSlug(10).toUpperCase();
  const sql = db();
  const [r] = await sql`insert into sign_requests ${sql({
    workspaceId: u.workspaceId, createdBy: u.userId, code, tokenHash: tokenHash(token), tokenEnc: enc(token),
    signerName: f.signerName, signerTitle: f.signerTitle, purpose: f.purpose, pinHash: f.pin ? hashSecret(f.pin) : null,
    validHours: f.hours, expiresAt: new Date(Date.now() + f.hours * 3600_000).toISOString()
  } as never)} returning *`;
  await audit(u, 'qsign.create', 'sign_request', r.id, null, { code, signerName: f.signerName, signerTitle: f.signerTitle, hours: f.hours, pin: !!f.pin });
  return { request: view({ ...r, createdByName: u.nama }, true) };
}

export async function qsignList(p: any, u: Ctx) {
  const { page, pageSize, offset } = paginate(p);
  const st = ['pending', 'signed', 'expired', 'cancelled'].includes(p.status) ? String(p.status) : '';
  const q = str(p.q, 80).toLowerCase();
  const sql = db();
  const cond = sql`r.workspace_id = ${u.workspaceId}
    ${st === 'pending' ? sql`and r.status = 'pending' and r.expires_at > now()` : st === 'expired' ? sql`and r.status = 'pending' and r.expires_at <= now()` : st ? sql`and r.status = ${st}` : sql``}
    ${q ? sql`and (lower(r.signer_name) like ${'%' + q + '%'} or lower(r.signer_title) like ${'%' + q + '%'} or lower(r.purpose) like ${'%' + q + '%'} or lower(r.code) like ${'%' + q + '%'})` : sql``}`;
  const rows = await sql`select r.*, pr.nama as created_by_name from sign_requests r left join profiles pr on pr.id = r.created_by
    where ${cond} order by r.created_at desc limit ${pageSize} offset ${offset}`;
  const [{ n }] = await sql`select count(*)::int as n from sign_requests r where ${cond}`;
  const [c] = await sql`select count(*) filter (where status = 'pending' and expires_at > now())::int as pending,
    count(*) filter (where status = 'signed')::int as signed from sign_requests where workspace_id = ${u.workspaceId}`;
  return { rows: rows.map((r) => view(r, true)), total: n, page, pageSize, pages: Math.max(1, Math.ceil(n / pageSize)), counts: c, now: new Date().toISOString() };
}

async function own(id: unknown, u: Ctx) {
  const sid = str(id, 40);
  if (!/^[0-9a-f-]{36}$/i.test(sid)) throw new AppError('NOT_FOUND', 'Permintaan tanda tangan tidak ditemukan.');
  const [r] = await db()`select r.*, pr.nama as created_by_name from sign_requests r left join profiles pr on pr.id = r.created_by
    where r.id = ${sid} and r.workspace_id = ${u.workspaceId}`;
  if (!r) throw new AppError('NOT_FOUND', 'Permintaan tanda tangan tidak ditemukan.');
  return r;
}

export async function qsignGet(p: any, u: Ctx) {
  const r = await own(p.id, u);
  const out: any = view(r, true);
  if (r.status === 'signed' && r.signaturePath) {
    const img = await getFile(r.signaturePath);
    out.signatureImage = 'data:image/png;base64,' + Buffer.from(img).toString('base64');
  }
  out.workspaceName = u.workspaceName;
  return { request: out };
}

export async function qsignCancel(p: any, u: Ctx) {
  const r = await own(p.id, u);
  if (r.status !== 'pending') throw new AppError('CONFLICT', 'Hanya permintaan yang belum ditandatangani yang bisa dibatalkan.');
  await db()`update sign_requests set status = 'cancelled' where id = ${r.id} and status = 'pending'`;
  await audit(u, 'qsign.cancel', 'sign_request', r.id, { status: effStatus(r) }, { status: 'cancelled' });
  return { ok: true };
}

/** Hapus permanen (termasuk gambar tanda tangan). Barcode yang sudah dicetak tidak lagi terverifikasi. */
export async function qsignDelete(p: any, u: Ctx) {
  const r = await own(p.id, u);
  if (r.signaturePath) await removeFiles([r.signaturePath]).catch(() => { /* berkas mungkin sudah tidak ada */ });
  await db()`delete from sign_requests where id = ${r.id} and workspace_id = ${u.workspaceId}`;
  await audit(u, 'qsign.delete', 'sign_request', r.id, { code: r.code, signerName: r.signerName, signerTitle: r.signerTitle, status: effStatus(r) }, null);
  return { ok: true };
}

/** Buat tautan baru (tautan lama langsung tidak berlaku) dengan batas waktu baru. */
export async function qsignRenew(p: any, u: Ctx) {
  assertEsign(u);
  const r = await own(p.id, u);
  if (r.status === 'signed') throw new AppError('CONFLICT', 'Permintaan ini sudah ditandatangani.');
  const hours = int(p.hours, r.validHours || 8, 1, 72);
  if (!QSIGN_HOURS.includes(hours)) throw vErr('hours', 'Pilih batas waktu yang tersedia.');
  const token = crypto.randomUUID();
  const [n] = await db()`update sign_requests set status = 'pending', token_hash = ${tokenHash(token)}, token_enc = ${enc(token)}, valid_hours = ${hours},
    expires_at = ${new Date(Date.now() + hours * 3600_000).toISOString()}, opened_at = null where id = ${r.id} and status <> 'signed' returning *`;
  if (!n) throw new AppError('CONFLICT', 'Permintaan ini sudah ditandatangani.');
  await rateReset('qsign:pin:' + r.id); // link baru = kesempatan PIN baru
  await audit(u, 'qsign.renew', 'sign_request', r.id, { status: effStatus(r), expiresAt: r.expiresAt }, { status: 'pending', expiresAt: n.expiresAt, hours });
  return { request: view({ ...n, createdByName: r.createdByName }, true) };
}

/* ---------- publik: penanda tangan ---------- */
async function byToken(p: any) {
  const t = str(p.token, 80);
  if (!/^[0-9a-f-]{36}$/i.test(t)) throw new AppError('NOT_FOUND', 'Tautan tanda tangan tidak valid.');
  const [r] = await db()`select r.*, w.nama as workspace_name, w.status as ws_status, pr.nama as created_by_name from sign_requests r
    join workspaces w on w.id = r.workspace_id left join profiles pr on pr.id = r.created_by where r.token_hash = ${tokenHash(t)}`;
  if (!r || r.wsStatus !== 'aktif') throw new AppError('NOT_FOUND', 'Tautan tanda tangan tidak valid atau sudah diganti.');
  return r;
}
function publicView(r: any) {
  const status = effStatus(r);
  return {
    signerName: r.signerName, signerTitle: r.signerTitle, purpose: r.purpose, requester: r.createdByName || '', organization: r.workspaceName,
    status, statusLabel: LABEL[status], expiresAt: r.expiresAt, signedAt: r.signedAt, needPin: !!r.pinHash && status === 'pending',
    code: status === 'signed' ? r.code : null, verifyUrl: status === 'signed' ? qsignVerifyUrl(r.code) : null, consentText: consentText(r)
  };
}
const consentText = (r: any) => 'Saya, ' + r.signerName + ' (' + r.signerTitle + '), menyatakan bahwa tanda tangan ini saya buat sendiri dengan sadar untuk keperluan: ' + r.purpose + '.';

export async function qsignOpen(p: any) {
  const r = await byToken(p);
  if (effStatus(r) === 'pending' && !r.openedAt) await db()`update sign_requests set opened_at = now() where id = ${r.id} and opened_at is null`;
  return publicView(r);
}

export async function qsignSubmit(p: any, info: ReqInfo) {
  const r = await byToken(p);
  const status = effStatus(r);
  if (status === 'signed') throw new AppError('CONFLICT', 'Tanda tangan untuk tautan ini sudah diterima sebelumnya.');
  if (status === 'expired') throw new AppError('CONFLICT', 'Tautan ini sudah kedaluwarsa. Minta tautan baru kepada pengirim.');
  if (status !== 'pending') throw new AppError('CONFLICT', 'Permintaan tanda tangan ini sudah dibatalkan pengirim.');
  if (r.pinHash) {
    const fk = 'qsign:pin:' + r.id;
    if ((await rateCount(fk, 3600)) >= PIN_MAX_FAIL) throw new AppError('RATE_LIMIT', 'Terlalu banyak percobaan PIN salah. Minta tautan baru kepada pengirim.');
    if (!verifySecret(str(p.pin, 12), r.pinHash)) { await rateBump(fk, 3600); throw vErr('pin', 'PIN salah.'); }
  }
  if (p.consent !== true) throw vErr('consent', 'Centang pernyataan persetujuan untuk melanjutkan.');
  const b64 = String(p.signatureImage || '').replace(/^data:image\/png;base64,/, '');
  if (!b64 || !/^[A-Za-z0-9+/=]+$/.test(b64)) throw vErr('signature', 'Gambar tanda tangan tidak terbaca.');
  const img = Buffer.from(b64, 'base64');
  if (img.length > APP.MAX_SIGNATURE_BYTES) throw vErr('signature', 'Gambar tanda tangan terlalu besar.');
  if (img.length < 200 || !(img[0] === 137 && img[1] === 80 && img[2] === 78 && img[3] === 71)) throw vErr('signature', 'Gambar tanda tangan harus PNG dan tidak boleh kosong.');
  const sigHash = sha256Hex(img);
  const sigType = ['draw', 'type', 'upload'].includes(p.signatureType) ? p.signatureType : 'draw';
  const signedAt = new Date().toISOString();
  const recordHash = sha256Hex(JSON.stringify({ code: r.code, signerName: r.signerName, signerTitle: r.signerTitle, purpose: r.purpose, signedAt, signatureSha256: sigHash }));
  const ua = parseUa(info.ua);
  const path = 'ws/' + r.workspaceId + '/ttd/' + r.id + '.png';
  await putFile(path, img, 'image/png');
  const [done] = await db()`update sign_requests set status = 'signed', signed_at = ${signedAt}, signature_path = ${path}, signature_hash = ${sigHash},
    signature_type = ${sigType}, record_hash = ${recordHash}, signer_ip_hash = ${info.ipHash || null}, signer_device = ${[ua.browser, ua.os, ua.device].filter(Boolean).join(' / ') || null}
    where id = ${r.id} and status = 'pending' and expires_at > now() returning *`;
  if (!done) throw new AppError('CONFLICT', 'Tautan ini sudah tidak berlaku. Muat ulang halaman.');
  await audit({ userId: null, email: r.signerName, workspaceId: r.workspaceId, ipHash: info.ipHash }, 'qsign.signed', 'sign_request', r.id, null,
    { code: r.code, signatureSha256: sigHash, recordSha256: recordHash, signatureType: sigType }, 'publik');
  // Notifikasi ke pembuat permintaan (gagal kirim email tidak membatalkan tanda tangan)
  try {
    const [c] = await db()`select email, nama from profiles where id = ${r.createdBy}`;
    if (c?.email) await sendMail(c.email, 'Tanda tangan diterima: ' + r.signerName, 'Tanda tangan sudah masuk', [
      r.signerName + ' (' + r.signerTitle + ') telah menandatangani permintaan Anda untuk: ' + r.purpose + '.',
      'Kode verifikasi: ' + r.code + '. Gambar tanda tangan dan barcode TTD bisa diunduh di menu TTD Realtime.'
    ], ENV.appUrl + '/#/ttd/' + r.id, 'Lihat & unduh');
  } catch (e) { console.warn(JSON.stringify({ qsignMail: String((e as Error)?.message || e) })); }
  return { ...publicView(done ? { ...r, ...done } : r) };
}

/** Verifikasi publik dari barcode: hanya data identitas & bukti hash, tanpa gambar tanda tangan. */
export async function qsignVerify(p: any) {
  let code = str(p.code, 40).toUpperCase();
  if (p.payload != null || isQsignPayload(code)) {
    const c = parseQsignPayload(str(p.payload ?? p.code, 120));
    if (!c) throw new AppError('NOT_FOUND', 'Barcode tidak dikenali atau sudah diubah. Ini bukan barcode TTD asli dari ' + APP.NAME + '.');
    code = c;
  }
  if (!/^TTD-[A-Z0-9]{6,20}$/.test(code)) throw new AppError('NOT_FOUND', 'Kode tanda tangan tidak ditemukan.');
  const [r] = await db()`select r.*, w.nama as workspace_name from sign_requests r join workspaces w on w.id = r.workspace_id where r.code = ${code}`;
  if (!r) throw new AppError('NOT_FOUND', 'Kode tanda tangan tidak ditemukan atau sudah dihapus pemiliknya.');
  const status = effStatus(r);
  if (status !== 'signed') return { code, valid: false, status, statusLabel: LABEL[status] };
  return {
    code, valid: true, status, statusLabel: LABEL[status], signerName: r.signerName, signerTitle: r.signerTitle, purpose: r.purpose,
    organization: r.workspaceName, signedAt: r.signedAt, recordHash: r.recordHash, signatureHash: r.signatureHash
  };
}
