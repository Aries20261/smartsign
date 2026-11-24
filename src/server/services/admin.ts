import { db } from '../db';
import { APP, ENV, PLAN_LIMITS, ROLES, ALL_ROLES, shortBase } from '../config';
import { AppError, vErr } from '../errors';
import { audit, securityEvent } from '../audit';
import { rateLimit } from '../ratelimit';
import { sendMail } from '../mail';
import { invalidatePlatformMemo, me, platformSettings, requireReauth, requireSession, type Ctx } from '../session';
import { addSecIso, bool, int, isEmail, maskEmail, normEmail, paginate, randomToken, sha256Hex, str } from '../util';
import { invalidateLinkCache, linkStats } from './links';
import { expireDocuments, OPEN_STATUSES } from './docs';

/* ---------- Dasbor ---------- */
export async function dashboard(_p: any, u: Ctx) {
  const sql = db();
  const ws = u.workspaceId;
  const [[k], stats, waiting, recent, [ob], [rate]] = await Promise.all([
    sql`select
      (select count(*) from links where workspace_id = ${ws} and status <> 'dihapus')::int as total_links,
      (select count(*) from links where workspace_id = ${ws} and status = 'aktif' and (expires_at is null or expires_at > now())
         and (active_from is null or active_from <= now()) and (max_clicks is null or click_count < max_clicks))::int as active_links,
      (select count(*) from documents where workspace_id = ${ws} and status in ('sent', 'viewed', 'partially_signed'))::int as waiting_docs,
      (select count(*) from documents where workspace_id = ${ws} and status = 'completed' and completed_at >= now() - interval '30 days')::int as completed30,
      (select count(*) from verification_records where workspace_id = ${ws} and checked_at >= now() - interval '30 days')::int as ver30,
      (select count(*) from verification_records where workspace_id = ${ws} and checked_at >= now() - interval '30 days' and result = 'valid')::int as ver_valid30`,
    linkStats({ days: 14 }, u),
    sql`select id, title, status, expires_at, (select count(*) from signers s where s.document_id = d.id and s.status = 'signed')::int as signed,
          (select count(*) from signers s where s.document_id = d.id and s.status <> 'voided')::int as total
        from documents d where workspace_id = ${ws} and status in ('sent', 'viewed', 'partially_signed') order by created_at desc limit 5`,
    sql`select at, action, user_email, entity from audit_log where workspace_id = ${ws} order by id desc limit 8`,
    sql`select exists(select 1 from code_assets where workspace_id = ${ws}) as qr, exists(select 1 from documents where workspace_id = ${ws}) as doc,
          (select count(*) from memberships where workspace_id = ${ws} and status = 'aktif')::int as members`,
    sql`select count(*)::int as closed, count(*) filter (where status = 'completed')::int as done,
          percentile_cont(0.5) within group (order by extract(epoch from completed_at - sent_at) / 3600) filter (where status = 'completed') as median_h
        from documents where workspace_id = ${ws} and sent_at >= now() - interval '90 days' and status in ('completed', 'declined', 'expired', 'voided')`
  ]);
  const plan = PLAN_LIMITS[u.plan] || PLAN_LIMITS.free;
  const label: Record<string, string> = { sent: 'Terkirim', viewed: 'Dilihat', partially_signed: 'Sebagian ditandatangani' };
  return {
    kpi: { activeLinks: k.activeLinks, totalLinks: k.totalLinks, clicks14: stats.total, qr14: stats.totalQr, unique14: stats.unique, waitingDocs: k.waitingDocs,
      completed30: k.completed30, verifications30: k.ver30, verificationValid30: k.verValid30,
      completionRate: rate.closed ? Math.round((rate.done / rate.closed) * 100) : null,
      medianHoursToSign: rate.medianH == null ? null : Math.round(Number(rate.medianH) * 10) / 10 },
    series: stats.series, topLinks: stats.topLinks.slice(0, 5),
    waiting: waiting.map((d) => ({ id: d.id, title: d.title, status: d.status, statusLabel: label[d.status] || d.status, progress: { signed: d.signed, total: d.total }, expiresAt: d.expiresAt })),
    recent: recent.map((a) => ({ waktu: a.at, action: a.action, userEmail: a.userEmail, entity: a.entity })),
    onboarding: { mfa: u.mfaEnabled, link: k.totalLinks > 0, qr: ob.qr, doc: ob.doc, member: ob.members > 1 },
    plan: { key: u.plan, label: plan.label, links: plan.links, linksUsed: k.totalLinks }
  };
}

/* ---------- Anggota ---------- */
export async function listMembers(_p: any, u: Ctx) {
  const sql = db();
  const mems = await sql`select m.id, m.user_id, m.role, m.status, p.nama, p.email, p.last_login_at,
      m.user_id in (select * from mfa_enabled_users(array(select user_id from memberships where workspace_id = ${u.workspaceId}))) as mfa
    from memberships m join profiles p on p.id = m.user_id where m.workspace_id = ${u.workspaceId} and m.status <> 'dihapus' order by m.created_at`;
  const inv = await sql`select id, email, role, expires_at, created_at from invitations where workspace_id = ${u.workspaceId} and status = 'aktif' and expires_at > now() order by created_at desc`;
  return {
    members: mems.map((m) => ({ membershipId: m.id, userId: m.userId, nama: m.nama, email: m.email, role: m.role, roleLabel: ROLES[m.role] || m.role, status: m.status,
      mfaEnabled: m.mfa, lastLoginAt: m.lastLoginAt || '', self: m.userId === u.userId })),
    invites: inv.map((t) => ({ id: t.id, email: t.email, role: t.role, roleLabel: ROLES[t.role] || t.role, expiresAt: t.expiresAt, createdAt: t.createdAt })),
    roles: ROLES
  };
}
export async function inviteMember(p: any, u: Ctx) {
  const email = normEmail(p.email);
  if (!isEmail(email)) throw vErr('email', 'Format email tidak valid.');
  if (!ALL_ROLES.includes(p.role)) throw vErr('role', 'Peran tidak dikenal.');
  const plan = PLAN_LIMITS[u.plan] || PLAN_LIMITS.free;
  const sql = db();
  const [c] = await sql`select count(*)::int as n from memberships where workspace_id = ${u.workspaceId} and status = 'aktif'`;
  if (c.n >= plan.members) throw new AppError('FORBIDDEN', 'Batas anggota paket ' + plan.label + ' (' + plan.members + ') tercapai.');
  const [ex] = await sql`select 1 from memberships m join profiles p on p.id = m.user_id where m.workspace_id = ${u.workspaceId} and p.email = ${email} and m.status = 'aktif'`;
  if (ex) throw new AppError('CONFLICT', 'Pengguna ini sudah menjadi anggota.', { email: 'Sudah menjadi anggota.' });
  await rateLimit('invite:' + u.workspaceId, 30, 86400, 'Batas undangan harian tercapai.');
  const token = randomToken();
  await sql.begin(async (t) => {
    await t`update invitations set status = 'dicabut' where workspace_id = ${u.workspaceId} and email = ${email} and status = 'aktif'`;
    await t`insert into invitations ${t({ workspaceId: u.workspaceId, email, role: p.role, tokenHash: sha256Hex(token), expiresAt: addSecIso(APP.TOKEN_INVITE_SEC), createdBy: u.userId } as never)}`;
    await audit(u, 'member.invite', 'Membership', '', null, { email: maskEmail(email), role: p.role }, 'ui', t);
  });
  await sendMail(email, 'Undangan bergabung ke ' + u.workspaceName, 'Anda diundang bergabung',
    [u.nama + ' mengundang Anda bergabung ke ruang kerja "' + u.workspaceName + '" sebagai ' + (ROLES[p.role] || p.role) + '.', 'Undangan berlaku 7 hari.'],
    ENV.appUrl + '/invite/' + token, 'Terima Undangan');
  return { ok: true };
}
export async function revokeInvite(p: any, u: Ctx) {
  const [t] = await db()`update invitations set status = 'dicabut' where id = ${str(p.id, 40)} and workspace_id = ${u.workspaceId} and status = 'aktif' returning id, email`;
  if (!t) throw new AppError('NOT_FOUND', 'Undangan tidak ditemukan.');
  await audit(u, 'member.inviteRevoked', 'Invitation', t.id, null, { email: maskEmail(t.email) });
  return { ok: true };
}
async function getWsMembership(id: unknown, u: Ctx) {
  const mid = str(id, 40);
  if (!/^[0-9a-f-]{36}$/.test(mid)) throw new AppError('NOT_FOUND', 'Anggota tidak ditemukan.');
  const [m] = await db()`select * from memberships where id = ${mid} and workspace_id = ${u.workspaceId} and status <> 'dihapus'`;
  if (!m) throw new AppError('NOT_FOUND', 'Anggota tidak ditemukan.');
  if (m.userId === u.userId) throw new AppError('FORBIDDEN', 'Anda tidak dapat mengubah peran/status akun Anda sendiri.');
  return m;
}
async function assertNotLastAdmin(m: any, u: Ctx) {
  if (m.role !== 'admin') return;
  const [c] = await db()`select count(*)::int as n from memberships where workspace_id = ${u.workspaceId} and role = 'admin' and status = 'aktif'`;
  if (c.n <= 1) throw new AppError('CONFLICT', 'Ruang kerja harus memiliki minimal satu admin aktif.');
}
export async function setMemberRole(p: any, u: Ctx) {
  await requireReauth(u);
  const m = await getWsMembership(p.membershipId, u);
  if (!ALL_ROLES.includes(p.role)) throw vErr('role', 'Peran tidak dikenal.');
  if (p.role !== 'admin') await assertNotLastAdmin(m, u);
  await db()`update memberships set role = ${p.role} where id = ${m.id}`;
  // peran dibaca ulang dari database pada setiap permintaan, sehingga perubahan langsung berlaku
  await audit(u, 'member.role', 'Membership', m.id, { role: m.role }, { role: p.role });
  return { ok: true };
}
export async function setMemberStatus(p: any, u: Ctx) {
  await requireReauth(u);
  const m = await getWsMembership(p.membershipId, u);
  const status = ['aktif', 'nonaktif', 'dihapus'].includes(p.status) ? p.status : null;
  if (!status) throw vErr('status', 'Status tidak dikenal.');
  if (status !== 'aktif') await assertNotLastAdmin(m, u);
  await db()`update memberships set status = ${status} where id = ${m.id}`;
  await audit(u, status === 'dihapus' ? 'member.remove' : 'member.status', 'Membership', m.id, { status: m.status }, { status });
  return { ok: true };
}
export async function revokeMemberSessions(p: any, u: Ctx) {
  const m = await getWsMembership(p.membershipId, u);
  const [r] = await db()`select revoke_user_sessions(${m.userId}, null, null) as n`;
  await audit(u, 'member.revokeSessions', 'Membership', m.id, null, { jumlah: r.n });
  await securityEvent('sesi_dicabut_admin', 'sedang', { userId: m.userId, workspaceId: u.workspaceId }, 'oleh ' + maskEmail(u.email));
  return { revoked: r.n };
}

/* ---------- Pengaturan ruang kerja ---------- */
export async function getSettings(_p: any, u: Ctx) {
  const plan = PLAN_LIMITS[u.plan] || PLAN_LIMITS.free;
  const sql = db();
  const [usage] = await sql`select
    (select count(*) from links where workspace_id = ${u.workspaceId} and status <> 'dihapus')::int as links,
    (select count(*) from documents where workspace_id = ${u.workspaceId} and created_at >= date_trunc('month', now() at time zone 'Asia/Jakarta') at time zone 'Asia/Jakarta')::int as docs,
    (select count(*) from memberships where workspace_id = ${u.workspaceId} and status = 'aktif')::int as members`;
  const sa = u.platformRole === 'superadmin';
  const bl = await sql`select id, domain, reason, workspace_id, created_at from blocklist where status = 'aktif' and (workspace_id = ${u.workspaceId} ${sa ? sql`or workspace_id is null` : sql``}) order by created_at desc`;
  return {
    workspace: { id: u.workspaceId, nama: u.workspaceName, plan: u.plan, planLabel: plan.label }, settings: u.settings,
    usage: { links: usage.links, linksMax: plan.links, docsMonth: usage.docs, docsMax: plan.docsPerMonth, members: usage.members, membersMax: plan.members },
    blocklist: bl.map((b) => ({ id: b.id, domain: b.domain, reason: b.reason, global: !b.workspaceId, createdAt: b.createdAt })),
    shortBase: shortBase()
  };
}
export async function saveSettings(p: any, u: Ctx) {
  await requireReauth(u);
  const s = p.settings || {};
  const next = {
    requireMfaAdmin: bool(s.requireMfaAdmin),
    interstitialMode: s.interstitialMode === 'always' ? 'always' : 'risky',
    analyticsMode: ['full', 'minimal', 'off'].includes(s.analyticsMode) ? s.analyticsMode : 'full',
    defaultLinkDays: int(s.defaultLinkDays, 0, 0, 3650),
    signLinkDays: int(s.signLinkDays, 14, 1, 90),
    allowedDomains: str(s.allowedDomains, 1000).toLowerCase().split(/[\s,]+/).filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)).join(', '),
    brandColor: /^#[0-9a-f]{6}$/i.test(s.brandColor) ? s.brandColor : u.settings.brandColor
  };
  const nama = str(p.nama, 80);
  if (nama.length < 2) throw vErr('nama', 'Nama ruang kerja minimal 2 karakter.');
  await db()`update workspaces set nama = ${nama}, settings = ${next as never} where id = ${u.workspaceId}`;
  const slugs = await db()`select slug from links where workspace_id = ${u.workspaceId}`;
  slugs.forEach((l) => invalidateLinkCache(l.slug));
  await audit(u, 'workspace.settings', 'Workspace', u.workspaceId, { nama: u.workspaceName, settings: u.settings }, { nama, settings: next });
  const fresh = await requireSession(u.sb, u);
  return { ...(await getSettings(p, fresh)), me: me(fresh) };
}
export async function addBlock(p: any, u: Ctx) {
  const domain = str(p.domain, 200).toLowerCase().replace(/^https?:\/\//, '').split(/[/?#]/)[0];
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw vErr('domain', 'Masukkan nama domain, mis. contoh-phishing.com');
  const global = bool(p.global) && u.platformRole === 'superadmin';
  const [b] = await db()`insert into blocklist ${db()({ workspaceId: global ? null : u.workspaceId, domain, reason: str(p.reason, 200), createdBy: u.userId } as never)} returning id`;
  await audit(u, 'blocklist.add', 'Blocklist', b.id, null, { domain, global });
  return { ok: true };
}
export async function removeBlock(p: any, u: Ctx) {
  const sa = u.platformRole === 'superadmin';
  const id = str(p.id, 40);
  const [b] = await db()`update blocklist set status = 'dihapus' where id = ${id} and status = 'aktif' and (workspace_id = ${u.workspaceId} ${sa ? db()`or workspace_id is null` : db()``}) returning id, domain`;
  if (!b) throw new AppError('NOT_FOUND', 'Entri tidak ditemukan.');
  await audit(u, 'blocklist.remove', 'Blocklist', b.id, { domain: b.domain }, null);
  return { ok: true };
}

/* ---------- Audit & keamanan ---------- */
function auditWhere(p: any, u: Ctx) {
  const sql = db();
  const q = str(p.q, 100).toLowerCase(), from = str(p.from, 10), to = str(p.to, 10), action = str(p.action, 60);
  const all = u.platformRole === 'superadmin' && bool(p.allWorkspaces);
  return sql`${all ? sql`true` : sql`workspace_id = ${u.workspaceId}`}
    ${action ? sql`and action like ${action.replace(/[%_\\]/g, '\\$&') + '%'}` : sql``}
    ${/^\d{4}-\d{2}-\d{2}$/.test(from) ? sql`and at >= ${from + 'T00:00:00+07:00'}` : sql``}
    ${/^\d{4}-\d{2}-\d{2}$/.test(to) ? sql`and at < (${to + 'T00:00:00+07:00'}::timestamptz + interval '1 day')` : sql``}
    ${q ? sql`and lower(user_email || ' ' || action || ' ' || entity || ' ' || entity_id) like ${'%' + q.replace(/[%_\\]/g, '\\$&') + '%'}` : sql``}`;
}
export async function listAudit(p: any, u: Ctx) {
  const { page, pageSize, offset } = paginate(p);
  const w = auditWhere(p, u);
  const [c] = await db()`select count(*)::int as n from audit_log where ${w}`;
  const rows = await db()`select id, at, user_email, action, entity, entity_id, before, after, source, hash from audit_log where ${w} order by id desc limit ${pageSize} offset ${offset}`;
  return { rows: rows.map((a) => ({ id: a.id, waktu: a.at, userEmail: a.userEmail, action: a.action, entity: a.entity, entityId: a.entityId, before: a.before, after: a.after, source: a.source, hash: a.hash })), total: c.n, page, pageSize };
}
export async function exportAudit(p: any, u: Ctx) {
  await requireReauth(u);
  const rows = await db()`select at, user_email, action, entity, entity_id, source, before, after, hash from audit_log where ${auditWhere(p, u)} order by id desc limit ${APP.EXPORT_MAX_ROWS}`;
  await audit(u, 'audit.export', 'AuditLog', '', null, { jumlah: rows.length });
  return { header: ['Waktu', 'Pengguna', 'Aksi', 'Entitas', 'ID Entitas', 'Sumber', 'Sebelum', 'Sesudah', 'Hash'],
    rows: rows.map((a) => [a.at, a.userEmail, a.action, a.entity, a.entityId, a.source, a.before, a.after, a.hash]) };
}
export async function verifyAuditChain(_p: any, u: Ctx) {
  const [r] = await db()`select * from verify_audit_chain(${u.workspaceId})`;
  if (!r.ok) {
    await securityEvent('rantai_audit_rusak', 'tinggi', u, 'audit_log', { catatan: r.brokenId });
    return { ok: false, checked: Number(r.checked), brokenAt: r.brokenId, message: 'Rantai audit terputus pada catatan #' + r.brokenId + ': ada catatan yang diubah atau dihapus.' };
  }
  await audit(u, 'audit.verifyChain', 'AuditLog', '', null, { ok: true, jumlah: Number(r.checked) });
  return { ok: true, checked: Number(r.checked), message: 'Rantai audit utuh. ' + Number(r.checked) + ' catatan diperiksa.' };
}
export async function listSecurityEvents(p: any, u: Ctx) {
  const { page, pageSize, offset } = paginate(p);
  const sql = db();
  const w = bool(p.mine) ? sql`user_id = ${u.userId}` : u.platformRole === 'superadmin' && bool(p.allWorkspaces) ? sql`true` : sql`workspace_id = ${u.workspaceId}`;
  const [c] = await sql`select count(*)::int as n from security_events where ${w}`;
  const rows = await sql`select id, at, event_type, severity, subject, metadata from security_events where ${w} order by id desc limit ${pageSize} offset ${offset}`;
  return { rows: rows.map((e) => ({ id: e.id, waktu: e.at, eventType: e.eventType, severity: e.severity, subject: e.subject, metadata: e.metadata })), total: c.n, page, pageSize };
}

/* ---------- Laporan penyalahgunaan ---------- */
export async function listAbuse(p: any, u: Ctx) {
  const { page, pageSize, offset } = paginate(p);
  const sql = db();
  const w = u.platformRole === 'superadmin' ? sql`true` : sql`r.workspace_id = ${u.workspaceId}`;
  const [c] = await sql`select count(*)::int as n from abuse_reports r where ${w}`;
  const rows = await sql`select r.*, l.status as link_status, l.destination from abuse_reports r left join links l on l.id = r.link_id where ${w} order by r.created_at desc limit ${pageSize} offset ${offset}`;
  return { rows: rows.map((r) => ({ id: r.id, slug: r.slug, reason: r.reason, detail: r.detail, status: r.status, createdAt: r.createdAt, linkStatus: r.linkStatus || '-', destination: r.destination || '' })), total: c.n, page, pageSize };
}
export async function handleAbuse(p: any, u: Ctx) {
  const sa = u.platformRole === 'superadmin';
  const [r] = await db()`select * from abuse_reports where id = ${str(p.id, 40)} ${sa ? db()`` : db()`and workspace_id = ${u.workspaceId}`}`;
  if (!r) throw new AppError('NOT_FOUND', 'Laporan tidak ditemukan.');
  const action = str(p.action, 20);
  const [l] = r.linkId ? await db()`select id, slug, status from links where id = ${r.linkId}` : [null];
  if (action === 'block' || action === 'unblock') {
    if (!sa) throw new AppError('FORBIDDEN', 'Hanya superadmin yang dapat memblokir atau membuka blokir tautan.');
    if (l) await db()`update links set status = ${action === 'block' ? 'diblokir' : 'nonaktif'} where id = ${l.id}`;
  } else if (action === 'deactivate') {
    if (l && l.status === 'aktif') await db()`update links set status = 'nonaktif' where id = ${l.id}`;
  } else if (action !== 'dismiss') throw vErr('action', 'Tindakan tidak dikenal.');
  if (l) invalidateLinkCache(l.slug);
  await db()`update abuse_reports set status = ${action === 'dismiss' ? 'ditolak' : 'ditindak'}, handled_by = ${u.userId}, handled_at = now() where id = ${r.id}`;
  await audit({ ...u, workspaceId: r.workspaceId || u.workspaceId }, 'abuse.' + action, 'AbuseReport', r.id, { status: r.status }, { status: action, linkId: r.linkId });
  return { ok: true };
}

/* ---------- Platform (superadmin) ---------- */
export async function getPlatform(_p: any, _u: Ctx) {
  const s = await platformSettings(true);
  const ws = await db()`select w.id, w.nama, w.plan, w.status, w.created_at,
      (select count(*) from memberships m where m.workspace_id = w.id and m.status = 'aktif')::int as members,
      (select count(*) from links l where l.workspace_id = w.id and l.status <> 'dihapus')::int as links
    from workspaces w where w.status <> 'dihapus' order by w.created_at desc limit 500`;
  return { ...s, shortDomain: ENV.shortDomain, safeBrowsing: !!ENV.safeBrowsingKey, smtp: !!ENV.smtpUrl,
    workspaces: ws.map((w) => ({ id: w.id, nama: w.nama, plan: w.plan, status: w.status, createdAt: w.createdAt, members: w.members, links: w.links })) };
}
export async function savePlatform(p: any, u: Ctx) {
  await requireReauth(u);
  const next = {
    allowRegistration: bool(p.allowRegistration),
    globalBlocklist: str(p.globalBlocklist, 4000).toLowerCase().split(/[\s,]+/).filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)).join(', '),
    retentionClickDays: int(p.retentionClickDays, 400, 30, 3650),
    retentionSecurityDays: int(p.retentionSecurityDays, 365, 30, 3650),
    retentionAuditDays: int(p.retentionAuditDays, 0, 0, 3650)
  };
  await db()`update platform_settings set settings = ${next as never}, updated_by = ${u.userId} where id = 1`;
  invalidatePlatformMemo();
  await audit(u, 'platform.settings', 'Platform', '', null, next);
  return getPlatform(p, u);
}
export async function setWorkspacePlan(p: any, u: Ctx) {
  await requireReauth(u);
  const id = str(p.workspaceId, 40);
  const [ws] = await db()`select id, plan, status from workspaces where id = ${id}`;
  if (!ws) throw new AppError('NOT_FOUND', 'Ruang kerja tidak ditemukan.');
  const patch: Record<string, string> = {};
  if (p.plan) { if (!PLAN_LIMITS[p.plan]) throw vErr('plan', 'Paket tidak dikenal.'); patch.plan = p.plan; }
  if (p.status) { if (!['aktif', 'ditangguhkan'].includes(p.status)) throw vErr('status', 'Status tidak dikenal.'); patch.status = p.status; }
  if (Object.keys(patch).length) await db()`update workspaces set ${db()(patch as never)} where id = ${id}`;
  const slugs = await db()`select slug from links where workspace_id = ${id}`;
  slugs.forEach((l) => invalidateLinkCache(l.slug));
  await audit({ ...u, workspaceId: id }, 'platform.workspace', 'Workspace', id, { plan: ws.plan, status: ws.status }, patch);
  return getPlatform(p, u);
}

/* ---------- Tugas terjadwal (Vercel Cron) ---------- */
export async function runDailyJob() {
  const s = await platformSettings(true);
  const expired = await expireDocuments();
  await db()`update invitations set status = 'kedaluwarsa' where status = 'aktif' and expires_at < now()`;
  await db()`delete from reauth where at < now() - interval '1 day'`;
  const [purge] = await db()`select purge_retention(${s.retentionClickDays}, ${s.retentionSecurityDays}, ${s.retentionAuditDays}) as r`;
  return { expiredDocs: expired, purged: purge.r };
}

export { OPEN_STATUSES };
