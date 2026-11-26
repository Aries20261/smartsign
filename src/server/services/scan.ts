import { db } from '../db';
import { APP, ENV } from '../config';
import { AppError, vErr } from '../errors';
import { audit } from '../audit';
import { rateLimit } from '../ratelimit';
import type { Ctx } from '../session';
import { buildVerificationReport } from '../pdf';
import { maskEmail, paginate, str } from '../util';
import { analyzeUrl, hostOf, publicLinkView } from './links';
import { recordVerification, verifyDocByCode } from './docs';
import { isQsignPayload, qsignVerify } from './qsign';

const LINK_STATE: Record<string, { result: string; msg: string }> = {
  ok: { result: 'valid', msg: 'Shortlink aktif dan terdaftar di sistem.' },
  inactive: { result: 'invalid', msg: 'Shortlink dinonaktifkan atau diarsipkan oleh pemiliknya.' },
  blocked: { result: 'invalid', msg: 'Shortlink diblokir karena laporan penyalahgunaan.' },
  expired: { result: 'expired', msg: 'Shortlink sudah kedaluwarsa.' },
  scheduled: { result: 'review', msg: 'Shortlink belum aktif (terjadwal).' },
  limit: { result: 'expired', msg: 'Batas jumlah klik shortlink sudah tercapai.' },
  notfound: { result: 'invalid', msg: 'Shortlink tidak ditemukan di sistem.' }
};

/** Mengenali URL milik aplikasi ini: /<slug>, /verify?code=, /sign/<token>, atau domain pendek. */
export function ownUrlParts(raw: string): { slug?: string; verify?: string; sign?: boolean } | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  const hosts = [hostOf(ENV.appUrl), hostOf(ENV.shortDomain)].filter(Boolean);
  if (!hosts.includes(u.hostname.toLowerCase())) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts[0] === 'sign') return { sign: true };
  if (parts[0] === 'verify') return { verify: u.searchParams.get('code') || '' };
  if (parts[0] === 'go' && parts[1]) return { slug: decodeURIComponent(parts[1]) };
  if (parts.length === 1) return { slug: decodeURIComponent(parts[0]) };
  return null;
}

export async function scanCheck(p: any, u: Ctx) {
  const content = String(p.content == null ? '' : p.content).trim().slice(0, 2000);
  if (!content) throw vErr('content', 'Tidak ada isi kode untuk diperiksa.');
  await rateLimit('scan:' + u.userId, 120, 3600);
  const source = ['camera', 'upload', 'manual'].includes(p.source) ? p.source : 'manual';
  const legacyTtd = /^https?:\/\//i.test(content) && hostOf(content) === hostOf(ENV.appUrl) ? /\/ttd\/v\/(TTD-[A-Z0-9]{6,20})$/i.exec(new URL(content).pathname) : null;
  if (isQsignPayload(content) || legacyTtd) {
    // Barcode TTD Realtime: hanya bisa divalidasi oleh server SmartSign (HMAC); legacyTtd = barcode lama berisi URL verifikasi
    let ttd: any = null;
    try { ttd = await qsignVerify(legacyTtd ? { code: legacyTtd[1] } : { payload: content }); } catch { ttd = null; }
    const out: any = !ttd
      ? { kind: 'ttd', result: 'invalid', reasonCode: 'ttd_forged', message: 'Barcode TTD tidak dikenali, sudah diubah, atau sudah dihapus pemiliknya.', details: {} }
      : ttd.valid
        ? { kind: 'ttd', result: 'valid', reasonCode: 'ttd_valid', message: 'Tanda tangan elektronik asli dan tercatat di ' + APP.NAME + '.', ttd, details: {} }
        : { kind: 'ttd', result: ttd.status === 'expired' ? 'expired' : 'invalid', reasonCode: 'ttd_' + ttd.status, message: 'Barcode asli, tetapi belum ditandatangani (' + ttd.statusLabel + ').', ttd, details: {} };
    out.source = source;
    out.recordId = await recordVerification(u, 'ttd', null, ttd?.code || 'SSTTD1', out.result, out.reasonCode, { code: ttd?.code || null });
    return out;
  }
  const own = /^https?:\/\//i.test(content) ? ownUrlParts(content) : null;
  let out: any;
  if (own?.sign) {
    out = { kind: 'sign', result: 'review', reasonCode: 'signing_link', message: 'Ini adalah tautan pribadi penandatanganan. Jangan dibagikan; hanya penerima undangan yang boleh membukanya.', details: {} };
  } else if (own && own.verify !== undefined) {
    return { kind: 'document', source, ...(await verifyDocByCode({ code: own.verify }, u)) };
  } else if (own?.slug) {
    const view = await publicLinkView(own.slug);
    const m = LINK_STATE[view.state] || LINK_STATE.notfound;
    const [l] = await db()`select id, workspace_id, destination from links where lower(slug) = ${own.slug.toLowerCase()} and status <> 'dihapus'`;
    const mine = !!l && l.workspaceId === u.workspaceId;
    out = { kind: 'shortlink', result: m.result, reasonCode: 'link_' + view.state, message: m.msg,
      details: { slug: view.slug, domain: (view as any).domain, risky: (view as any).risky, flags: (view as any).flags, hasPassword: (view as any).hasPassword,
        destination: mine && view.state === 'ok' ? l.destination : '', ownWorkspace: mine, linkId: mine ? l.id : '' } };
    if (m.result === 'valid' && (view as any).risky) { out.result = 'review'; out.message = 'Shortlink aktif, tetapi tujuan dinilai berisiko. Periksa domain sebelum membuka.'; }
  } else if (/^https?:\/\//i.test(content)) {
    const a = await analyzeUrl(content, u.workspaceId, {});
    if (!a.ok) out = { kind: 'url', result: a.blocked ? 'invalid' : 'review', reasonCode: a.blocked ? 'url_blocked' : 'url_rejected', message: a.error, details: { domain: hostOf(content) } };
    else out = { kind: 'url', result: a.risky ? 'review' : 'unable', reasonCode: a.risky ? 'url_risky' : 'url_external',
      message: a.risky ? 'Tautan eksternal dengan indikasi risiko. Jangan masukkan data pribadi di situs tujuan.' : 'Tautan eksternal (bukan dari sistem ini). Keasliannya tidak dapat diverifikasi; periksa domain sebelum membuka.',
      details: { domain: a.host, url: a.url, flags: a.flags, score: a.score, safeBrowsingChecked: a.safeBrowsingChecked } };
  } else if (/^SS-[0-9A-F]{4}(-[0-9A-F]{4}){3}$/i.test(content)) {
    return { kind: 'document', source, ...(await verifyDocByCode({ code: content }, u)) };
  } else if (/^[a-z][a-z0-9+.-]{1,20}:/i.test(content)) {
    out = { kind: 'scheme', result: 'invalid', reasonCode: 'scheme_blocked', message: 'Kode berisi skema "' + content.split(':')[0] + ':" yang tidak diizinkan dibuka dari aplikasi ini.', details: { text: content.slice(0, 300) } };
  } else {
    out = { kind: 'text', result: 'unable', reasonCode: 'plain_text', message: 'Kode berisi teks biasa (bukan tautan). Isi ditampilkan sebagai teks dan tidak dijalankan.', details: { text: content.slice(0, 1000), format: str(p.format, 30) } };
  }
  out.source = source;
  out.recordId = await recordVerification(u, out.kind, null, content, out.result, out.reasonCode, out.details);
  return out;
}
export async function scanHistory(p: any, u: Ctx) {
  const { page, pageSize, offset } = paginate(p);
  const sql = db();
  const own = u.role === 'viewer' || u.role === 'editor';
  const where = sql`workspace_id = ${u.workspaceId} ${own ? sql`and user_id = ${u.userId}` : sql``} ${p.result ? sql`and result = ${str(p.result, 20)}` : sql``}`;
  const [c] = await sql`select count(*)::int as n from verification_records where ${where}`;
  const rows = await sql`select id, object_type, input, result, reason_code, checked_at, user_id from verification_records where ${where} order by id desc limit ${pageSize} offset ${offset}`;
  return { rows: rows.map((r) => ({ id: r.id, objectType: r.objectType, input: r.input, result: r.result, reasonCode: r.reasonCode, checkedAt: r.checkedAt, publik: !r.userId })), total: c.n, page, pageSize };
}
export async function scanReport(p: any, u: Ctx) {
  const id = Number(p.id);
  if (!Number.isInteger(id)) throw new AppError('NOT_FOUND', 'Catatan verifikasi tidak ditemukan.');
  const [r] = await db()`select * from verification_records where id = ${id} and workspace_id = ${u.workspaceId}`;
  if (!r) throw new AppError('NOT_FOUND', 'Catatan verifikasi tidak ditemukan.');
  const pdf = await buildVerificationReport({ id: String(r.id), checkedAt: r.checkedAt, objectType: r.objectType, input: r.input, result: r.result, reasonCode: r.reasonCode, detail: r.detail }, u.nama + ' (' + maskEmail(u.email) + ')');
  await audit(u, 'scan.report', 'VerificationRecord', String(r.id), null, null);
  return { fileName: 'Laporan verifikasi ' + r.id + '.pdf', mime: 'application/pdf', base64: Buffer.from(pdf).toString('base64') };
}
