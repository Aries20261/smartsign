import { db, type Q } from '../db';
import { APP, ENV, PLAN_LIMITS, verifyUrlOf } from '../config';
import { AppError, vErr } from '../errors';
import { audit, securityEvent } from '../audit';
import { rateLimit } from '../ratelimit';
import { sendMail } from '../mail';
import { requireReauth, type Ctx, type ReqInfo } from '../session';
import { getFile, moveFile, putFile, removeFiles, signedUploadUrl, signedUrl } from '../storage';
import { buildCertificate, buildFinalPdf } from '../pdf';
import { addSecIso, fmtIdDate, int, isEmail, isPast, maskEmail, normEmail, paginate, parseUa, randomDigits, randomHex, randomToken, safeEqual, sha256Hex, str, todayWib } from '../util';

const STATUS_LABEL: Record<string, string> = { draft: 'Draf', sent: 'Terkirim', viewed: 'Dilihat', partially_signed: 'Sebagian ditandatangani',
  completed: 'Selesai', declined: 'Ditolak', expired: 'Kedaluwarsa', voided: 'Dibatalkan', dihapus: 'Dihapus' };
const FIELD_TYPES = ['signature', 'initial', 'name', 'date', 'text'];
export const OPEN_STATUSES = ['sent', 'viewed', 'partially_signed'];
const label = (s: string) => STATUS_LABEL[s] || s;
const authLabel = (m: string) => (m === 'otp_code' ? 'OTP email + kode akses' : 'OTP email');
const docBase = (d: any) => 'ws/' + d.workspaceId + '/doc/' + d.id + '/';

/** Validasi PDF: tanda byte, ukuran, enkripsi, dan konten aktif. Bukan antivirus. */
export function validatePdfBytes(bytes: Uint8Array, field: string) {
  if (!bytes.length) throw vErr(field, 'Berkas kosong.');
  if (bytes.length > APP.MAX_PDF_BYTES) throw vErr(field, 'Ukuran maksimal ' + Math.round(APP.MAX_PDF_BYTES / 1048576) + ' MB.');
  if (Buffer.from(bytes.subarray(0, 5)).toString('latin1') !== '%PDF-') throw vErr(field, 'Berkas bukan PDF yang valid.');
  const text = Buffer.from(bytes).toString('latin1');
  if (/\/Encrypt\b/.test(text)) throw vErr(field, 'PDF terenkripsi/berpassword tidak didukung. Simpan ulang tanpa password.');
  const active = /\/(JavaScript|JS|Launch|EmbeddedFiles?|RichMedia|XFA|SubmitForm|ImportData|GoToR)\b/.exec(text);
  if (active) throw vErr(field, 'PDF memuat konten aktif (' + active[1] + ') yang tidak diizinkan demi keamanan.');
  return { pages: (text.match(/\/Type\s*\/Page(?!s)\b/g) || []).length };
}

/* ---------- Rantai bukti (hash dihitung trigger database) ---------- */
export async function sigEvent(docId: string, signerId: string | null, type: string, actor: string, evidence?: unknown, q: Q = db()) {
  await q`insert into signature_events ${q({ documentId: docId, signerId, eventType: type, actor: str(actor, 160), evidence: (evidence || {}) as never } as never)}`;
}
export async function verifyChain(docId: string, q: Q = db()) {
  const [r] = await q`select * from verify_sig_chain(${docId})`;
  const [h] = await q`select hash from signature_events where document_id = ${docId} order by id desc limit 1`;
  return { ok: r.ok as boolean, count: Number(r.checked), brokenAt: r.brokenId, head: h?.hash || '' };
}

/* ---------- Helper akses ---------- */
async function getWsDoc(id: unknown, u: Ctx, q: Q = db(), lock = false) {
  const did = str(id, 40);
  if (!/^[0-9a-f-]{36}$/.test(did)) throw new AppError('NOT_FOUND', 'Dokumen tidak ditemukan.');
  const [d] = lock
    ? await q`select * from documents where id = ${did} and workspace_id = ${u.workspaceId} and status <> 'dihapus' for update`
    : await q`select * from documents where id = ${did} and workspace_id = ${u.workspaceId} and status <> 'dihapus'`;
  if (!d) throw new AppError('NOT_FOUND', 'Dokumen tidak ditemukan.');
  return d;
}
const canManage = (d: any, u: Ctx) => u.role === 'admin' || (u.role === 'editor' && d.ownerId === u.userId);
function assertManage(d: any, u: Ctx) { if (!canManage(d, u)) throw new AppError('FORBIDDEN', 'Hanya pengirim dokumen atau admin yang dapat melakukan tindakan ini.'); }
async function signersOf(docId: string, q: Q = db()) {
  return q`select * from signers where document_id = ${docId} and status <> 'voided' order by sign_order, created_at`;
}
async function docView(d: any, u?: Ctx, q: Q = db()) {
  const signers = await signersOf(d.id, q);
  return {
    id: d.id, code: d.code, title: d.title, message: d.message, fileName: d.fileName, sizeBytes: d.sizeBytes, pageCount: d.pageCount, pageSizes: d.pageSizes,
    originalHash: d.originalHash, finalHash: d.finalHash, certHash: d.certHash, hasFinal: !!d.finalPath, hasCert: !!d.certPath,
    status: d.status, statusLabel: label(d.status), signingOrder: d.signingOrder, expiresAt: d.expiresAt, sentAt: d.sentAt,
    completedAt: d.completedAt, voidReason: d.voidReason, ownerId: d.ownerId, createdAt: d.createdAt, verifyUrl: verifyUrlOf(d.code),
    canManage: u ? canManage(d, u) : false,
    signers: signers.map((s) => ({ id: s.id, order: s.signOrder, nama: s.nama, email: s.email, authMethod: s.authMethod, status: s.status, fields: s.fields,
      sentAt: s.sentAt, viewedAt: s.viewedAt, signedAt: s.signedAt, declinedAt: s.declinedAt, declineReason: s.declineReason, reminders: s.reminders })),
    progress: { signed: signers.filter((s) => s.status === 'signed').length, total: signers.length }
  };
}

/* ---------- Unggah (langsung dari browser ke Storage lewat URL bertanda tangan) ---------- */
async function assertQuota(u: Ctx) {
  const plan = PLAN_LIMITS[u.plan] || PLAN_LIMITS.free;
  const [c] = await db()`select count(*)::int as n from documents where workspace_id = ${u.workspaceId} and created_at >= date_trunc('month', now() at time zone 'Asia/Jakarta') at time zone 'Asia/Jakarta'`;
  if (c.n >= plan.docsPerMonth) throw new AppError('FORBIDDEN', 'Kuota dokumen bulan ini (' + plan.docsPerMonth + ') pada paket ' + plan.label + ' sudah habis.');
}
export async function uploadUrl(p: any, u: Ctx) {
  await assertQuota(u);
  const name = str(p.fileName, 150);
  if (!/\.pdf$/i.test(name)) throw vErr('file', 'Hanya berkas .pdf yang diizinkan.');
  const size = int(p.size, 0, 0, 1e9);
  if (!size || size > APP.MAX_PDF_BYTES) throw vErr('file', 'Ukuran maksimal ' + Math.round(APP.MAX_PDF_BYTES / 1048576) + ' MB.');
  await rateLimit('upl:' + u.userId, 30, 3600, 'Terlalu banyak unggahan. Coba lagi nanti.');
  const path = 'tmp/' + u.workspaceId + '/' + u.userId + '/' + randomHex(16) + '.pdf';
  const s = await signedUploadUrl(path);
  return { path, url: s.url, token: s.token };
}
export async function uploadDoc(p: any, u: Ctx) {
  await assertQuota(u);
  const path = str(p.path, 200);
  if (!path.startsWith('tmp/' + u.workspaceId + '/' + u.userId + '/') || !/^[\w/.-]+\.pdf$/.test(path) || path.includes('..')) throw vErr('file', 'Unggahan tidak dikenal. Ulangi unggah berkas.');
  const name = str(p.fileName, 150).replace(/[\\/:*?"<>|]/g, '_') || 'dokumen.pdf';
  let bytes: Uint8Array;
  try { bytes = await getFile(path); } catch { throw vErr('file', 'Berkas belum terunggah. Ulangi unggah berkas.'); }
  let info;
  try { info = validatePdfBytes(bytes, 'file'); } catch (e) { await removeFiles([path]); throw e; }
  const hash = sha256Hex(bytes);
  if (p.clientHash && String(p.clientHash).toLowerCase() !== hash) { await removeFiles([path]); throw vErr('file', 'Berkas rusak saat diunggah (hash tidak cocok). Coba unggah ulang.'); }
  const code = 'SS-' + randomHex(8).toUpperCase().replace(/(.{4})(?=.)/g, '$1-');
  const title = str(p.title, 150) || name.replace(/\.pdf$/i, '');
  if (title.length < 2) throw vErr('title', 'Judul minimal 2 karakter.');
  const pageSizes = Array.isArray(p.pageSizes) ? p.pageSizes.slice(0, 2000).map((x: any) => ({ w: Number(x.w) || 595, h: Number(x.h) || 842, r: int(x.r, 0, 0, 270) })) : [];
  const [d] = await db()`insert into documents ${db()({ workspaceId: u.workspaceId, code, title, fileName: name, filePath: path, sizeBytes: bytes.length,
    pageCount: int(p.pageCount, info.pages || 1, 1, 2000), pageSizes: pageSizes as never, originalHash: hash, ownerId: u.userId, createdBy: u.userId, updatedBy: u.userId,
    expiresAt: addSecIso((u.settings.signLinkDays || 14) * 86400) } as never)} returning *`;
  const finalPath = docBase(d) + 'original.pdf';
  await moveFile(path, finalPath);
  await db()`update documents set file_path = ${finalPath} where id = ${d.id}`;
  d.filePath = finalPath;
  await sigEvent(d.id, null, 'uploaded', u.email, { fileName: name, sizeBytes: bytes.length, sha256: hash });
  await audit(u, 'doc.upload', 'Document', d.id, null, { title, fileName: name, sha256: hash });
  return { doc: await docView(d, u) };
}

/* ---------- Penanda tangan & field ---------- */
function validateFields(fields: unknown, pageCount: number, idx: number) {
  if (!Array.isArray(fields)) return [];
  if (fields.length > 30) throw vErr('signers', 'Penanda tangan ke-' + (idx + 1) + ': maksimal 30 field.');
  const num = (v: unknown) => Math.max(0, Math.min(1, Number(v) || 0));
  return fields.map((f: any) => {
    const type = FIELD_TYPES.includes(f.type) ? f.type : 'signature';
    const w = Math.max(0.03, num(f.w)), h = Math.max(0.015, num(f.h));
    return { id: /^[A-Za-z0-9_-]{1,20}$/.test(f.id) ? f.id : randomHex(4), type, page: int(f.page, 1, 1, pageCount || 2000),
      x: Math.min(num(f.x), 1 - w), y: Math.min(num(f.y), 1 - h), w, h, label: str(f.label, 40), required: f.required !== false };
  });
}
export async function saveDocSetup(p: any, u: Ctx) {
  const title = str(p.title, 150);
  if (title.length < 2) throw vErr('title', 'Judul minimal 2 karakter.');
  const list = Array.isArray(p.signers) ? p.signers : [];
  if (list.length > 10) throw vErr('signers', 'Maksimal 10 penanda tangan.');
  const order = p.signingOrder === 'parallel' ? 'parallel' : 'sequential';
  const days = int(p.expiresInDays, 14, 1, 90);
  return db().begin(async (t) => {
    const d = await getWsDoc(p.id, u, t, true);
    assertManage(d, u);
    if (d.status !== 'draft') throw new AppError('CONFLICT', 'Dokumen yang sudah dikirim tidak dapat diubah. Batalkan lalu buat ulang bila perlu.');
    const existing = await signersOf(d.id, t);
    const seen = new Set<string>();
    const clean = list.map((s: any, i: number) => {
      const email = normEmail(s.email), nama = str(s.nama, 80);
      if (nama.length < 2) throw vErr('signers', 'Nama penanda tangan ke-' + (i + 1) + ' wajib diisi.');
      if (!isEmail(email)) throw vErr('signers', 'Email penanda tangan ke-' + (i + 1) + ' tidak valid.');
      if (seen.has(email)) throw vErr('signers', 'Email ' + email + ' tercantum lebih dari sekali.');
      seen.add(email);
      const authMethod = s.authMethod === 'otp_code' ? 'otp_code' : 'otp';
      const prev = existing.find((e) => e.id === str(s.id, 40));
      let accessCodeHash: string | null = null;
      if (authMethod === 'otp_code') {
        const code = str(s.accessCode, 20);
        if (code) {
          if (code.length < 4) throw vErr('signers', 'Kode akses penanda tangan ke-' + (i + 1) + ' minimal 4 karakter.');
          accessCodeHash = sha256Hex(d.id + ':' + code);
        } else if (prev?.accessCodeHash) accessCodeHash = prev.accessCodeHash;
        else throw vErr('signers', 'Kode akses penanda tangan ke-' + (i + 1) + ' wajib diisi.');
      }
      return { prev, data: { nama, email, authMethod, accessCodeHash, signOrder: order === 'parallel' ? 1 : i + 1, fields: validateFields(s.fields, d.pageCount, i) } };
    });
    const keep = new Set<string>();
    for (const c of clean) {
      if (c.prev) { await t`update signers set ${t({ ...c.data, fields: c.data.fields as never } as never)} where id = ${c.prev.id}`; keep.add(c.prev.id); }
      else { const [n] = await t`insert into signers ${t({ documentId: d.id, workspaceId: u.workspaceId, ...c.data, fields: c.data.fields as never } as never)} returning id`; keep.add(n.id); }
    }
    for (const e of existing) if (!keep.has(e.id)) await t`update signers set status = 'voided' where id = ${e.id}`;
    const [a] = await t`update documents set title = ${title}, message = ${str(p.message, 1000)}, signing_order = ${order},
      expires_at = ${addSecIso(days * 86400)}, updated_by = ${u.userId} where id = ${d.id} returning *`;
    await audit(u, 'doc.setup', 'Document', d.id, { title: d.title }, { title, signingOrder: order, penandaTangan: clean.map((c: any) => maskEmail(c.data.email)) }, 'ui', t);
    return { doc: await docView(a, u, t) };
  });
}
/** URL berumur pendek untuk menampilkan PDF asli di editor (draf) atau pratinjau. */
export async function docPdf(p: any, u: Ctx) {
  const d = await getWsDoc(p.id, u);
  if (d.status !== 'draft') { await requireReauth(u); await audit(u, 'doc.view', 'Document', d.id, null, null); }
  return { url: await signedUrl(d.filePath, 300), originalHash: d.originalHash };
}

/* ---------- Pengiriman & undangan ---------- */
async function inviteSigner(d: any, s: any, actorName: string, isReminder: boolean) {
  const token = randomToken();
  await db()`update signers set token_hash = ${sha256Hex(token)}, token_expires_at = ${d.expiresAt}, status = ${s.status === 'pending' ? 'sent' : s.status},
    sent_at = coalesce(sent_at, now()), reminders = reminders + ${isReminder ? 1 : 0}, session_hash = null where id = ${s.id}`;
  const [owner] = await db()`select nama from profiles where id = ${d.ownerId}`;
  await sendMail(s.email, (isReminder ? 'Pengingat: ' : '') + 'Permintaan tanda tangan: ' + d.title, 'Permintaan tanda tangan dokumen', [
    'Halo ' + s.nama + ',',
    (owner?.nama || 'Seseorang') + ' meminta Anda meninjau dan menandatangani dokumen "' + d.title + '".',
    d.message ? 'Pesan: ' + d.message : '',
    'Anda akan diminta memasukkan kode OTP yang dikirim ke email ini' + (s.authMethod === 'otp_code' ? ' serta kode akses dari pengirim' : '') + '. Tautan berlaku sampai ' + fmtIdDate(d.expiresAt) + '.',
    'Jenis tanda tangan: ' + APP.ASSURANCE_LABEL + '.'
  ], ENV.appUrl + '/sign/' + token, 'Tinjau & Tanda Tangani');
  await sigEvent(d.id, s.id, isReminder ? 'reminder_sent' : 'invited', actorName, { to: maskEmail(s.email), authMethod: s.authMethod });
}
export async function sendDoc(p: any, u: Ctx) {
  const d = await db().begin(async (t) => {
    const d0 = await getWsDoc(p.id, u, t, true);
    assertManage(d0, u);
    if (d0.status !== 'draft') throw new AppError('CONFLICT', 'Dokumen sudah dikirim.');
    const signers = await signersOf(d0.id, t);
    if (!signers.length) throw vErr('signers', 'Tambahkan minimal satu penanda tangan.');
    for (const s of signers) if (!(s.fields || []).some((f: any) => f.type === 'signature' || f.type === 'initial')) throw vErr('fields', 'Penanda tangan "' + s.nama + '" belum memiliki area tanda tangan.');
    if (isPast(d0.expiresAt)) throw vErr('expiresInDays', 'Masa berlaku dokumen sudah lewat. Simpan ulang pengaturan.');
    const [a] = await t`update documents set status = 'sent', sent_at = now(), updated_by = ${u.userId} where id = ${d0.id} returning *`;
    await audit(u, 'doc.send', 'Document', d0.id, { status: 'draft' }, { status: 'sent' }, 'ui', t);
    return a;
  });
  const signers = await signersOf(d.id);
  const first = d.signingOrder === 'parallel' ? signers : signers.filter((s) => s.signOrder === signers[0].signOrder);
  await sigEvent(d.id, null, 'sent', u.email, { signingOrder: d.signingOrder, signers: signers.length, sha256: d.originalHash });
  for (const s of first) await inviteSigner(d, s, u.email, false);
  return { doc: await docView(d, u) };
}
export async function remindSigner(p: any, u: Ctx) {
  const d = await getWsDoc(p.id, u);
  assertManage(d, u);
  if (!OPEN_STATUSES.includes(d.status)) throw new AppError('CONFLICT', 'Dokumen tidak sedang menunggu tanda tangan.');
  const s = (await signersOf(d.id)).find((x) => x.id === str(p.signerId, 40));
  if (!s || !['sent', 'viewed'].includes(s.status)) throw new AppError('CONFLICT', 'Penanda tangan ini tidak sedang menunggu.');
  await rateLimit('remind:' + s.id, 3, 86400, 'Pengingat untuk penanda tangan ini sudah dikirim 3 kali hari ini.');
  await inviteSigner(d, s, u.email, true); // token lama otomatis tidak berlaku (diganti)
  await audit(u, 'doc.remind', 'Signer', s.id, null, { email: maskEmail(s.email) });
  return { ok: true };
}
export async function voidDoc(p: any, u: Ctx) {
  const reason = str(p.reason, 300);
  if (reason.length < 3) throw vErr('reason', 'Alasan pembatalan wajib diisi.');
  const pre = await getWsDoc(p.id, u);
  assertManage(pre, u);
  await requireReauth(u);
  const { d, notify } = await db().begin(async (t) => {
    const d0 = await getWsDoc(p.id, u, t, true);
    if (!['draft', ...OPEN_STATUSES].includes(d0.status)) throw new AppError('CONFLICT', 'Dokumen dengan status ' + label(d0.status) + ' tidak dapat dibatalkan.');
    const signers = await signersOf(d0.id, t);
    await t`update signers set token_hash = null, token_expires_at = null, session_hash = null where document_id = ${d0.id}`;
    const [a] = await t`update documents set status = 'voided', void_reason = ${reason}, updated_by = ${u.userId} where id = ${d0.id} returning *`;
    await audit(u, 'doc.void', 'Document', d0.id, { status: d0.status }, { status: 'voided', reason }, 'ui', t);
    return { d: a, notify: signers.filter((s) => ['sent', 'viewed'].includes(s.status)) };
  });
  await sigEvent(d.id, null, 'voided', u.email, { reason });
  for (const s of notify) await sendMail(s.email, 'Permintaan tanda tangan dibatalkan: ' + d.title, 'Permintaan dibatalkan',
    ['Pengirim telah membatalkan permintaan tanda tangan untuk dokumen "' + d.title + '".', 'Alasan: ' + reason, 'Tautan sebelumnya tidak berlaku lagi.']).catch((e) => console.warn('mail void', e.message));
  return { doc: await docView(d, u) };
}
export async function deleteDoc(p: any, u: Ctx) {
  const d = await getWsDoc(p.id, u);
  assertManage(d, u);
  if (!['draft', 'voided', 'declined', 'expired'].includes(d.status)) throw new AppError('CONFLICT', 'Dokumen yang sedang berjalan atau selesai tidak dapat dihapus. Bukti disimpan sesuai kebijakan retensi.');
  await db()`update documents set status = 'dihapus', updated_by = ${u.userId} where id = ${d.id}`;
  if (d.status === 'draft') await removeFiles([d.filePath]);
  await audit(u, 'doc.delete', 'Document', d.id, { status: d.status }, { status: 'dihapus' });
  return { ok: true };
}
export async function listDocs(p: any, u: Ctx) {
  const q = str(p.q, 100).toLowerCase(), status = str(p.status, 20);
  const { page, pageSize, offset } = paginate(p);
  const sql = db();
  const like = '%' + q.replace(/[%_\\]/g, '\\$&') + '%';
  const where = sql`d.workspace_id = ${u.workspaceId} and d.status <> 'dihapus'
    ${status === 'waiting' ? sql`and d.status in ('sent', 'viewed', 'partially_signed')` : status ? sql`and d.status = ${status}` : sql``}
    ${q ? sql`and (lower(d.title || ' ' || d.code || ' ' || d.file_name) like ${like} or exists (select 1 from signers s where s.document_id = d.id and lower(s.nama || ' ' || s.email) like ${like}))` : sql``}`;
  const [c] = await sql`select count(*)::int as n from documents d where ${where}`;
  const rows = await sql`select d.* from documents d where ${where} order by d.created_at desc limit ${pageSize} offset ${offset}`;
  const out: any[] = [];
  for (const d of rows) { const v: any = await docView(d, u); delete v.message; out.push(v); }
  return { rows: out, total: c.n, page, pageSize };
}
export async function getDoc(p: any, u: Ctx) {
  const d = await getWsDoc(p.id, u);
  const events = await db()`select id, event_type, at, actor, signer_id, evidence, hash from signature_events where document_id = ${d.id} order by id`;
  return { doc: await docView(d, u), chain: await verifyChain(d.id),
    events: events.map((e) => ({ id: e.id, type: e.eventType, waktu: e.at, actor: e.actor, signerId: e.signerId, evidence: e.evidence, hash: e.hash })) };
}
export async function downloadDoc(p: any, u: Ctx) {
  const d = await getWsDoc(p.id, u);
  const which = ['original', 'final', 'certificate'].includes(p.which) ? p.which : 'original';
  if (which !== 'certificate') await requireReauth(u);
  const path = which === 'original' ? d.filePath : which === 'final' ? d.finalPath : d.certPath;
  if (!path) throw new AppError('NOT_FOUND', 'Berkas belum tersedia.');
  await audit(u, 'doc.download', 'Document', d.id, null, { berkas: which });
  const base = d.title.replace(/[^\w\- ]+/g, '').slice(0, 60) || 'dokumen';
  const fileName = base + (which === 'original' ? '' : which === 'final' ? ' - ditandatangani' : ' - sertifikat') + '.pdf';
  return { fileName, url: await signedUrl(path, 60, fileName) };
}
/** Membuat ulang sertifikat & PDF final bila sebelumnya gagal (mis. gangguan storage). */
export async function finalizeDoc(p: any, u: Ctx) {
  const d = await getWsDoc(p.id, u);
  assertManage(d, u);
  if (d.status !== 'completed') throw new AppError('CONFLICT', 'Dokumen belum selesai ditandatangani semua pihak.');
  if (d.finalPath && d.certPath) throw new AppError('CONFLICT', 'PDF final sudah dibuat.');
  await generateOutputs(d.id);
  await audit(u, 'doc.finalize', 'Document', d.id, null, null);
  const [a] = await db()`select * from documents where id = ${d.id}`;
  return { doc: await docView(a, u) };
}

/* ---------- Alur penanda tangan (publik, berbasis token) ---------- */
async function signerByToken(token: unknown) {
  const t = String(token || '');
  const bad = new AppError('UNAUTHORIZED', 'Tautan tanda tangan tidak valid, sudah diganti, atau kedaluwarsa.');
  if (!/^[a-f0-9]{64}$/.test(t)) throw bad;
  const [s] = await db()`select * from signers where token_hash = ${sha256Hex(t)} and status <> 'voided'`;
  if (!s) throw bad;
  const [d] = await db()`select * from documents where id = ${s.documentId} and status <> 'dihapus'`;
  if (!d) throw bad;
  return { s, d };
}
function assertSignable(c: { s: any; d: any }) {
  const { d, s } = c;
  if (d.status === 'voided') throw new AppError('CONFLICT', 'Permintaan tanda tangan ini telah dibatalkan oleh pengirim.');
  if (d.status === 'declined') throw new AppError('CONFLICT', 'Dokumen ini telah ditolak oleh salah satu penanda tangan.');
  if (d.status === 'expired' || isPast(d.expiresAt) || isPast(s.tokenExpiresAt)) throw new AppError('CONFLICT', 'Masa berlaku permintaan tanda tangan sudah habis.');
  if (s.status === 'signed') throw new AppError('CONFLICT', 'Anda sudah menandatangani dokumen ini.');
  if (s.status === 'declined') throw new AppError('CONFLICT', 'Anda telah menolak dokumen ini.');
}
const signableOrDone = (c: { s: any; d: any }) => { if (c.s.status !== 'signed') assertSignable(c); };

export async function signOpen(p: any) {
  const c = await signerByToken(p.token);
  const [owner] = await db()`select nama from profiles where id = ${c.d.ownerId}`;
  return {
    doc: { title: c.d.title, code: c.d.code, status: c.d.status, statusLabel: label(c.d.status), expiresAt: c.d.expiresAt, pageCount: c.d.pageCount,
      message: c.d.message, completed: c.d.status === 'completed', verifyUrl: verifyUrlOf(c.d.code) },
    sender: owner?.nama || '-', signer: { nama: c.s.nama, email: maskEmail(c.s.email), status: c.s.status, authMethod: c.s.authMethod, signedAt: c.s.signedAt },
    assurance: APP.ASSURANCE_LABEL
  };
}
export async function signSendOtp(p: any) {
  const c = await signerByToken(p.token);
  signableOrDone(c);
  await rateLimit('sotp:' + c.s.id, 3, 600, 'Kode sudah dikirim. Tunggu beberapa menit sebelum meminta lagi.');
  await rateLimit('sotpd:' + c.s.id, 10, 86400, 'Batas permintaan kode hari ini tercapai.');
  const code = randomDigits(6);
  await db()`update signers set otp_hash = ${sha256Hex(c.s.id + ':' + code)}, otp_expires_at = ${addSecIso(APP.OTP_TTL_SEC)}, otp_attempts = 0 where id = ${c.s.id}`;
  await sendMail(c.s.email, 'Kode verifikasi: ' + code, 'Kode verifikasi penandatanganan',
    ['Kode OTP Anda untuk dokumen "' + c.d.title + '":', code, 'Kode berlaku 10 menit. Jangan berikan kode ini kepada siapa pun, termasuk pihak yang mengaku dari ' + APP.NAME + '.']);
  await sigEvent(c.d.id, c.s.id, 'otp_sent', maskEmail(c.s.email), { channel: 'email' });
  return { sentTo: maskEmail(c.s.email), ttlSec: APP.OTP_TTL_SEC };
}
export async function signVerifyOtp(p: any) {
  const c = await signerByToken(p.token);
  signableOrDone(c);
  if (!c.s.otpHash || isPast(c.s.otpExpiresAt)) throw new AppError('VALIDATION', 'Kode sudah kedaluwarsa. Minta kode baru.', { code: 'Kode kedaluwarsa.' });
  const code = str(p.code, 10);
  const ok = /^\d{6}$/.test(code) && safeEqual(sha256Hex(c.s.id + ':' + code), c.s.otpHash);
  if (!ok) {
    const [r] = await db()`update signers set otp_attempts = otp_attempts + 1 where id = ${c.s.id} returning otp_attempts`;
    if (r.otpAttempts >= APP.OTP_MAX_ATTEMPTS) {
      await db()`update signers set otp_hash = null where id = ${c.s.id}`;
      await sigEvent(c.d.id, c.s.id, 'otp_locked', maskEmail(c.s.email), { attempts: r.otpAttempts });
      await securityEvent('otp_penanda_tangan_gagal', 'sedang', { workspaceId: c.d.workspaceId }, maskEmail(c.s.email));
    }
    throw new AppError('VALIDATION', 'Kode salah.', { code: 'Kode OTP salah. Sisa percobaan: ' + Math.max(0, APP.OTP_MAX_ATTEMPTS - r.otpAttempts) });
  }
  if (c.s.authMethod === 'otp_code' && !safeEqual(sha256Hex(c.d.id + ':' + str(p.accessCode, 20)), c.s.accessCodeHash || '')) {
    await db()`update signers set otp_attempts = otp_attempts + 1 where id = ${c.s.id}`;
    throw new AppError('VALIDATION', 'Kode akses salah.', { accessCode: 'Kode akses dari pengirim salah.' });
  }
  const ss = randomToken();
  await db()`update signers set otp_hash = null, otp_attempts = 0, session_hash = ${sha256Hex(ss)}, session_expires_at = ${addSecIso(APP.SIGNER_SESSION_SEC)} where id = ${c.s.id}`;
  await sigEvent(c.d.id, c.s.id, 'authenticated', maskEmail(c.s.email), { method: c.s.authMethod === 'otp_code' ? 'email_otp+access_code' : 'email_otp' });
  return { ss };
}
async function signerSession(p: any) {
  const c = await signerByToken(p.token);
  if (!c.s.sessionHash || isPast(c.s.sessionExpiresAt) || !safeEqual(sha256Hex(String(p.ss || '')), c.s.sessionHash))
    throw new AppError('UNAUTHORIZED', 'Sesi verifikasi berakhir. Masukkan kode OTP baru.');
  return c;
}
export async function signLoad(p: any) {
  const c = await signerSession(p);
  if (c.s.status !== 'signed') assertSignable(c);
  if (c.s.status === 'sent') {
    await db()`update signers set status = 'viewed', viewed_at = now() where id = ${c.s.id} and status = 'sent'`;
    await db()`update documents set status = 'viewed' where id = ${c.d.id} and status = 'sent'`;
    await sigEvent(c.d.id, c.s.id, 'viewed', maskEmail(c.s.email), { sha256: c.d.originalHash });
  }
  return { url: await signedUrl(c.d.filePath, 600), originalHash: c.d.originalHash, fields: c.s.fields, signerName: c.s.nama,
    consentText: APP.CONSENT_TEXT, consentVersion: APP.CONSENT_VERSION, signed: c.s.status === 'signed', completed: c.d.status === 'completed', hasCert: !!c.d.certPath };
}
export async function signSubmit(p: any, info: ReqInfo) {
  const c = await signerSession(p);
  assertSignable(c);
  const { d, s } = c;
  if (p.consent !== true || p.consentVersion !== APP.CONSENT_VERSION) throw vErr('consent', 'Centang pernyataan persetujuan untuk melanjutkan.');
  if (String(p.docHash || '').toLowerCase() !== d.originalHash) throw new AppError('CONFLICT', 'Dokumen yang Anda tinjau berbeda dengan dokumen asli. Muat ulang halaman.');
  const b64 = String(p.signatureImage || '').replace(/^data:image\/png;base64,/, '');
  if (!b64 || !/^[A-Za-z0-9+/=]+$/.test(b64)) throw vErr('signature', 'Gambar tanda tangan tidak terbaca.');
  const img = Buffer.from(b64, 'base64');
  if (img.length > APP.MAX_SIGNATURE_BYTES) throw vErr('signature', 'Gambar tanda tangan terlalu besar.');
  if (!(img[0] === 137 && img[1] === 80 && img[2] === 78 && img[3] === 71)) throw vErr('signature', 'Gambar tanda tangan harus PNG.');
  const values: Record<string, string> = {};
  for (const f of s.fields || []) {
    if (f.type === 'text') {
      const v = str((p.fieldValues || {})[f.id], 200);
      if (f.required && !v) throw vErr('field_' + f.id, 'Isian "' + (f.label || 'teks') + '" wajib diisi.');
      values[f.id] = v;
    } else if (f.type === 'name') values[f.id] = s.nama;
    else if (f.type === 'date') { const t = todayWib(); values[f.id] = t.slice(8, 10) + '/' + t.slice(5, 7) + '/' + t.slice(0, 4); }
  }
  const sigPath = docBase(d) + 'sig-' + s.id + '-' + randomHex(6) + '.png';
  await putFile(sigPath, img, 'image/png');
  const sigHash = sha256Hex(img);
  const ua = str(p.ua || info.ua, 300);
  const sigType = ['draw', 'type', 'upload'].includes(p.signatureType) ? p.signatureType : 'draw';
  const result = await db().begin(async (t) => {
    const [dl] = await t`select * from documents where id = ${d.id} for update`;
    const [sl] = await t`select * from signers where id = ${s.id} for update`;
    assertSignable({ d: dl, s: sl });
    await t`update signers set status = 'signed', signed_at = now(), signature_path = ${sigPath}, signature_hash = ${sigHash}, signature_type = ${sigType},
      field_values = ${values as never}, user_agent = ${ua}, ip_hash = ${info.ipHash}, session_hash = null, token_expires_at = now() + interval '30 days' where id = ${s.id}`;
    const i = parseUa(ua);
    await sigEvent(d.id, s.id, 'signed', s.nama + ' <' + maskEmail(s.email) + '>', {
      authMethod: s.authMethod === 'otp_code' ? 'email_otp+access_code' : 'email_otp', documentSha256: d.originalHash, signatureSha256: sigHash,
      consentVersion: APP.CONSENT_VERSION, consentSha256: sha256Hex(APP.CONSENT_TEXT), signatureType: sigType, device: i.browser + '/' + i.os + '/' + i.device,
      ipHash: info.ipHash }, t);
    const all = await signersOf(d.id, t);
    const remaining = all.filter((x) => x.status !== 'signed');
    if (!remaining.length) {
      await t`update documents set status = 'completed', completed_at = now() where id = ${d.id}`;
      return { completed: true, next: [] as any[] };
    }
    await t`update documents set status = 'partially_signed' where id = ${d.id}`;
    if (dl.signingOrder !== 'sequential') return { completed: false, next: [] };
    const nextOrder = Math.min(...remaining.map((x) => x.signOrder));
    return { completed: false, next: remaining.filter((x) => x.signOrder === nextOrder && x.status === 'pending') };
  });
  if (result.completed) { await completeDoc(d.id); return { completed: true }; }
  const [fresh] = await db()`select * from documents where id = ${d.id}`;
  for (const x of result.next) await inviteSigner(fresh, x, 'system', false);
  return { completed: false };
}
export async function signDecline(p: any) {
  const c = await signerSession(p);
  assertSignable(c);
  const reason = str(p.reason, 300);
  if (reason.length < 3) throw vErr('reason', 'Mohon tuliskan alasan penolakan.');
  await db().begin(async (t) => {
    await t`update signers set status = 'declined', declined_at = now(), decline_reason = ${reason}, session_hash = null where id = ${c.s.id}`;
    await t`update documents set status = 'declined' where id = ${c.d.id}`;
    await t`update signers set token_hash = null, token_expires_at = null where document_id = ${c.d.id} and id <> ${c.s.id} and status <> 'signed'`;
    await sigEvent(c.d.id, c.s.id, 'declined', c.s.nama + ' <' + maskEmail(c.s.email) + '>', { reason }, t);
  });
  const [owner] = await db()`select email from profiles where id = ${c.d.ownerId}`;
  if (owner) await sendMail(owner.email, 'Dokumen ditolak: ' + c.d.title, 'Dokumen ditolak', [c.s.nama + ' menolak menandatangani "' + c.d.title + '".', 'Alasan: ' + reason], ENV.appUrl, 'Buka ' + APP.NAME).catch(() => {});
  return { ok: true };
}
export async function signDownloadCert(p: any) {
  const c = await signerSession(p).catch(async () => {
    // setelah menandatangani, sesi penanda tangan ditutup; izinkan unduh sertifikat dengan token undangan + OTP ulang
    throw new AppError('UNAUTHORIZED', 'Sesi verifikasi berakhir. Masukkan kode OTP baru untuk mengunduh sertifikat.');
  });
  if (!c.d.certPath) throw new AppError('NOT_FOUND', 'Sertifikat belum tersedia.');
  await sigEvent(c.d.id, c.s.id, 'certificate_downloaded', maskEmail(c.s.email));
  const fileName = 'Sertifikat ' + c.d.code + '.pdf';
  return { fileName, url: await signedUrl(c.d.certPath, 60, fileName) };
}

/* ---------- Penyelesaian: sertifikat + PDF final (dibuat di server) ---------- */
async function generateOutputs(docId: string) {
  const [d] = await db()`select * from documents where id = ${docId}`;
  const signers = await signersOf(docId);
  const pngs = await Promise.all(signers.map((s) => (s.signaturePath ? getFile(s.signaturePath).catch(() => null) : Promise.resolve(null))));
  const events = await db()`select at, event_type, actor, hash from signature_events where document_id = ${docId} order by id`;
  const chain = await verifyChain(docId);
  const cd = { title: d.title, code: d.code, fileName: d.fileName, pageCount: d.pageCount, originalHash: d.originalHash, sentAt: d.sentAt, completedAt: d.completedAt, verifyUrl: verifyUrlOf(d.code) };
  let certHash = d.certHash, certPath = d.certPath;
  let certBytes: Uint8Array | null = null;
  if (!certPath) {
    certBytes = await buildCertificate(cd, signers.map((s, i) => ({ nama: s.nama, email: maskEmail(s.email), signedAt: s.signedAt, authMethod: s.authMethod, signatureHash: s.signatureHash || '', png: pngs[i] })),
      events.map((e) => ({ at: e.at, type: e.eventType, actor: e.actor, hash: e.hash })), chain);
    certHash = sha256Hex(certBytes);
    certPath = docBase(d) + 'certificate-' + randomHex(4) + '.pdf';
    await putFile(certPath, certBytes, 'application/pdf');
    await db()`update documents set cert_path = ${certPath}, cert_hash = ${certHash} where id = ${docId}`;
  }
  if (!d.finalPath) {
    const original = await getFile(d.filePath);
    const finalBytes = await buildFinalPdf(original, { ...cd, certHash }, signers.map((s, i) => ({ nama: s.nama, email: maskEmail(s.email), signedAt: s.signedAt,
      authMethod: s.authMethod, fields: s.fields || [], fieldValues: s.fieldValues || {}, png: pngs[i] })));
    const finalHash = sha256Hex(finalBytes);
    const finalPath = docBase(d) + 'final-' + randomHex(4) + '.pdf';
    await putFile(finalPath, finalBytes, 'application/pdf');
    await db()`update documents set final_path = ${finalPath}, final_hash = ${finalHash} where id = ${docId}`;
    await sigEvent(docId, null, 'completed', 'system', { originalSha256: d.originalHash, certificateSha256: certHash, finalSha256: finalHash, chainHead: chain.head });
  }
  return { certBytes, certHash };
}
async function completeDoc(docId: string) {
  const [d] = await db()`select * from documents where id = ${docId}`;
  let cert: Uint8Array | null = null;
  try { cert = (await generateOutputs(docId)).certBytes; }
  catch (e: any) {
    console.error(JSON.stringify({ complete: 'outputs_failed', doc: docId, msg: e.message }));
    await sigEvent(docId, null, 'completed', 'system', { originalSha256: d.originalHash, certificate: 'gagal dibuat; pengirim dapat membuat ulang dari detail dokumen' });
  }
  await audit({ userId: null, email: 'system', workspaceId: d.workspaceId }, 'doc.completed', 'Document', docId, null, { status: 'completed' }, 'system');
  const signers = await signersOf(docId);
  const [owner] = await db()`select email from profiles where id = ${d.ownerId}`;
  const to = [...new Set([...signers.map((s) => s.email), owner?.email].filter(Boolean) as string[])];
  for (const email of to) {
    await sendMail(email, 'Dokumen selesai ditandatangani: ' + d.title, 'Semua pihak telah menandatangani',
      ['Dokumen "' + d.title + '" telah ditandatangani oleh semua pihak.', 'Kode verifikasi: ' + d.code,
        cert ? 'Sertifikat penyelesaian terlampir. Keaslian dapat diperiksa kapan saja melalui tautan verifikasi.' : 'Keaslian dapat diperiksa kapan saja melalui tautan verifikasi.'],
      verifyUrlOf(d.code), 'Verifikasi Dokumen', cert ? [{ filename: 'Sertifikat ' + d.code + '.pdf', content: Buffer.from(cert), contentType: 'application/pdf' }] : undefined)
      .catch((e) => console.warn('mail complete', e.message));
  }
}

/* ---------- Verifikasi dokumen ---------- */
export const VERIFY_MSG: Record<string, string> = {
  valid: 'Dokumen valid: seluruh penanda tangan telah menandatangani dan rantai bukti utuh.',
  valid_original: 'Berkas cocok dengan dokumen ASLI sebelum ditandatangani (bukan berkas final bertanda tangan).',
  chain_broken: 'Rantai bukti tidak utuh. Dokumen perlu pemeriksaan manual oleh admin.',
  in_progress: 'Proses tanda tangan belum selesai.',
  voided: 'Dokumen dibatalkan oleh pengirim sehingga tidak berlaku.',
  declined: 'Dokumen ditolak oleh penanda tangan sehingga tidak berlaku.',
  expired: 'Masa berlaku permintaan tanda tangan telah habis sebelum selesai.',
  not_found: 'Kode verifikasi tidak dikenal. Dokumen tidak dapat diverifikasi.',
  hash_mismatch: 'Isi berkas BERBEDA dari dokumen yang tercatat. Berkas mungkin telah diubah.',
  hash_unknown: 'Sidik jari berkas tidak ditemukan di sistem. Berkas tidak dapat diverifikasi.'
};
async function verdict(d: any) {
  if (!d) return { result: 'unable', reasonCode: 'not_found', chain: null as any };
  const chain = await verifyChain(d.id);
  if (d.status === 'completed') return chain.ok ? { result: 'valid', reasonCode: 'valid', chain } : { result: 'review', reasonCode: 'chain_broken', chain };
  if (d.status === 'voided') return { result: 'invalid', reasonCode: 'voided', chain };
  if (d.status === 'declined') return { result: 'invalid', reasonCode: 'declined', chain };
  if (d.status === 'expired' || (OPEN_STATUSES.includes(d.status) && isPast(d.expiresAt))) return { result: 'expired', reasonCode: 'expired', chain };
  return { result: 'review', reasonCode: 'in_progress', chain };
}
async function publicSummary(d: any) {
  if (!d) return null;
  const signers = await signersOf(d.id);
  return { title: d.title, code: d.code, status: d.status, statusLabel: label(d.status), originalHash: d.originalHash, finalHash: d.finalHash, certHash: d.certHash,
    sentAt: d.sentAt, completedAt: d.completedAt, assurance: APP.ASSURANCE_LABEL,
    signers: signers.map((s) => ({ nama: s.nama, email: maskEmail(s.email), status: s.status, signedAt: s.signedAt, auth: authLabel(s.authMethod) })) };
}
export async function recordVerification(u: { workspaceId?: string; userId?: string } | null, type: string, objectId: string | null, input: string, result: string, reasonCode: string, detail?: unknown, workspaceOverride?: string | null) {
  const [r] = await db()`insert into verification_records ${db()({ workspaceId: workspaceOverride ?? (u?.workspaceId || null), userId: u?.userId || null, objectType: type,
    objectId: objectId || null, input: str(input, 300), result, reasonCode, detail: (detail || {}) as never } as never)} returning id`;
  return r.id as number;
}
async function docByCode(code: unknown) {
  const c = str(code, 40).toUpperCase();
  if (!/^SS-[0-9A-F]{4}(-[0-9A-F]{4}){3}$/.test(c)) return null;
  const [d] = await db()`select * from documents where code = ${c} and status <> 'dihapus'`;
  return d || null;
}
export async function verifyDocByCode(p: any, u: Ctx | null, ipHash = '') {
  await rateLimit('pv:' + (u?.userId || ipHash || 'anon'), 120, 3600, 'Terlalu banyak pemeriksaan. Coba lagi nanti.');
  const d = await docByCode(p.code);
  const v = await verdict(d);
  const out: any = { result: v.result, reasonCode: v.reasonCode, message: VERIFY_MSG[v.reasonCode], chainOk: v.chain ? v.chain.ok : null, doc: await publicSummary(d) };
  out.recordId = await recordVerification(u, 'document', d?.id || null, str(p.code, 40), out.result, out.reasonCode, { code: str(p.code, 40) }, u ? undefined : d?.workspaceId || null);
  return out;
}
export async function verifyDocHash(p: any, u: Ctx | null, ipHash = '') {
  await rateLimit('pv:' + (u?.userId || ipHash || 'anon'), 120, 3600, 'Terlalu banyak pemeriksaan. Coba lagi nanti.');
  const hash = str(p.hash, 80).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) throw vErr('hash', 'Sidik jari SHA-256 tidak valid.');
  const matchOf = (doc: any) => (doc.finalHash === hash ? 'final' : doc.certHash === hash ? 'certificate' : doc.originalHash === hash ? 'original' : '');
  let d: any = p.code ? await docByCode(p.code) : null;
  if (!p.code) [d] = await db()`select * from documents where status <> 'dihapus' and (final_hash = ${hash} or cert_hash = ${hash} or original_hash = ${hash}) order by completed_at desc nulls last limit 1`;
  const match = d ? matchOf(d) : '';
  let result: string, reason: string;
  if (!d) { result = 'unable'; reason = p.code ? 'not_found' : 'hash_unknown'; }
  else if (!match) { result = 'invalid'; reason = 'hash_mismatch'; }
  else {
    const v = await verdict(d);
    result = v.result; reason = v.reasonCode;
    if (v.result === 'valid' && match === 'original') reason = 'valid_original';
  }
  const out: any = { result, reasonCode: reason, message: VERIFY_MSG[reason], match, doc: d && match ? await publicSummary(d) : d ? { code: d.code, title: d.title } : null };
  out.recordId = await recordVerification(u, 'file', d?.id || null, hash, result, reason, { match }, u ? undefined : d?.workspaceId || null);
  return out;
}

/** Tugas terjadwal: tandai dokumen kedaluwarsa. */
export async function expireDocuments() {
  const rows = await db()`update documents set status = 'expired' where status in ('sent', 'viewed', 'partially_signed') and expires_at < now() returning id`;
  for (const r of rows) {
    await db()`update signers set token_hash = null, session_hash = null where document_id = ${r.id} and status <> 'signed'`;
    await sigEvent(r.id, null, 'expired', 'system', {});
  }
  return rows.length;
}
