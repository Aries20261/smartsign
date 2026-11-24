import type { Ctx, ReqInfo } from './session';
import * as A from './services/auth';
import * as L from './services/links';
import * as D from './services/docs';
import * as S from './services/scan';
import * as M from './services/admin';

type Fn = (p: any, u: Ctx, info: ReqInfo) => Promise<unknown>;
type PubFn = (p: any, u: null, info: ReqInfo) => Promise<unknown>;
/**
 * roles: null = publik; '*' = semua pengguna login; daftar = peran ruang kerja ('superadmin' = peran platform).
 * mfaSetupOk: boleh dipanggil saat admin belum mengaktifkan MFA wajib.
 */
export type Route = { roles: null; fn: PubFn; limit?: number } | { roles: '*' | string[]; fn: Fn; mfaSetupOk?: boolean };

const ALL = '*' as const;
const EDIT = ['admin', 'editor'];
const READ = ['admin', 'editor', 'viewer', 'auditor'];
const ADMIN = ['admin'];
const AUDIT = ['admin', 'auditor'];

export const ROUTES: Record<string, Route> = {
  // Publik: autentikasi
  'auth.login': { roles: null, fn: (p) => A.login(p), limit: 30 },
  'auth.mfa': { roles: null, fn: (p) => A.loginMfa(p), limit: 30 },
  'auth.register': { roles: null, fn: (p) => A.register(p), limit: 10 },
  'auth.resendVerify': { roles: null, fn: (p) => A.resendVerify(p), limit: 10 },
  'auth.forgot': { roles: null, fn: (p) => A.forgotPassword(p), limit: 10 },
  'auth.reset': { roles: null, fn: (p) => A.resetPassword(p), limit: 10 },
  'invite.peek': { roles: null, fn: (p) => A.invitePeek(p) },
  'invite.acceptNew': { roles: null, fn: (p) => A.inviteAcceptNew(p), limit: 10 },
  // Publik: shortlink & verifikasi
  'public.open': { roles: null, fn: (p, _u, i) => L.openLinkPublic(p, { ua: i.ua, referrer: String(p.ref || ''), country: i.country, ipHash: i.ipHash }) },
  'public.report': { roles: null, fn: (p, _u, i) => L.reportAbuse(p, i.ipHash), limit: 10 },
  'public.verifyDoc': { roles: null, fn: (p, _u, i) => D.verifyDocByCode(p, null, i.ipHash) },
  'public.verifyHash': { roles: null, fn: (p, _u, i) => D.verifyDocHash(p, null, i.ipHash) },
  // Penanda tangan (token undangan + OTP)
  'sign.open': { roles: null, fn: (p) => D.signOpen(p) },
  'sign.sendOtp': { roles: null, fn: (p) => D.signSendOtp(p), limit: 20 },
  'sign.verifyOtp': { roles: null, fn: (p) => D.signVerifyOtp(p), limit: 30 },
  'sign.load': { roles: null, fn: (p) => D.signLoad(p) },
  'sign.submit': { roles: null, fn: (p, _u, i) => D.signSubmit(p, i), limit: 20 },
  'sign.decline': { roles: null, fn: (p) => D.signDecline(p), limit: 20 },
  'sign.cert': { roles: null, fn: (p) => D.signDownloadCert(p) },
  // Akun sendiri
  'auth.me': { roles: ALL, fn: A.getMe, mfaSetupOk: true },
  'auth.logout': { roles: ALL, fn: A.logout, mfaSetupOk: true },
  'auth.reauth': { roles: ALL, fn: A.reauth, mfaSetupOk: true },
  'auth.sessions': { roles: ALL, fn: A.listSessions, mfaSetupOk: true },
  'auth.revokeSession': { roles: ALL, fn: A.revokeSession, mfaSetupOk: true },
  'auth.revokeOthers': { roles: ALL, fn: A.revokeOthers, mfaSetupOk: true },
  'auth.switchWorkspace': { roles: ALL, fn: A.switchWorkspace, mfaSetupOk: true },
  'auth.changePassword': { roles: ALL, fn: A.changePassword, mfaSetupOk: true },
  'auth.profile': { roles: ALL, fn: A.updateProfile, mfaSetupOk: true },
  'auth.mfaStart': { roles: ALL, fn: A.mfaStart, mfaSetupOk: true },
  'auth.mfaConfirm': { roles: ALL, fn: A.mfaConfirm, mfaSetupOk: true },
  'auth.mfaDisable': { roles: ALL, fn: A.mfaDisable },
  'auth.mfaRegen': { roles: ALL, fn: A.mfaRegen },
  'invite.accept': { roles: ALL, fn: A.inviteAccept, mfaSetupOk: true },
  'security.mine': { roles: ALL, fn: A.securityMine, mfaSetupOk: true },
  'dashboard.get': { roles: ALL, fn: M.dashboard },
  // Shortlink & kode
  'link.list': { roles: READ, fn: L.listLinks },
  'link.get': { roles: READ, fn: L.getLink },
  'link.checkSlug': { roles: EDIT, fn: (p) => L.checkSlug(p) },
  'link.create': { roles: EDIT, fn: L.createLink },
  'link.bulkCreate': { roles: EDIT, fn: L.bulkCreateLinks },
  'link.update': { roles: EDIT, fn: L.updateLink },
  'link.status': { roles: EDIT, fn: L.setLinkStatus },
  'link.stats': { roles: READ, fn: L.linkStats },
  'link.export': { roles: ['admin', 'editor', 'auditor'], fn: L.exportLinks },
  'link.exportClicks': { roles: ['admin', 'editor', 'auditor'], fn: L.exportClicks },
  'code.save': { roles: EDIT, fn: L.saveCodeAsset },
  // Dokumen
  'doc.list': { roles: READ, fn: D.listDocs },
  'doc.get': { roles: READ, fn: D.getDoc },
  'doc.uploadUrl': { roles: EDIT, fn: D.uploadUrl },
  'doc.upload': { roles: EDIT, fn: D.uploadDoc },
  'doc.setup': { roles: EDIT, fn: D.saveDocSetup },
  'doc.pdf': { roles: EDIT, fn: D.docPdf },
  'doc.send': { roles: EDIT, fn: D.sendDoc },
  'doc.remind': { roles: EDIT, fn: D.remindSigner },
  'doc.void': { roles: EDIT, fn: D.voidDoc },
  'doc.delete': { roles: EDIT, fn: D.deleteDoc },
  'doc.finalize': { roles: EDIT, fn: D.finalizeDoc },
  'doc.download': { roles: ['admin', 'editor', 'auditor'], fn: D.downloadDoc },
  // Scanner
  'scan.check': { roles: ALL, fn: S.scanCheck },
  'scan.verifyHash': { roles: ALL, fn: (p, u) => D.verifyDocHash(p, u) },
  'scan.history': { roles: ALL, fn: S.scanHistory },
  'scan.report': { roles: ALL, fn: S.scanReport },
  // Tim & pengaturan
  'team.list': { roles: ADMIN, fn: M.listMembers },
  'team.invite': { roles: ADMIN, fn: M.inviteMember },
  'team.revokeInvite': { roles: ADMIN, fn: M.revokeInvite },
  'team.role': { roles: ADMIN, fn: M.setMemberRole },
  'team.status': { roles: ADMIN, fn: M.setMemberStatus },
  'team.revokeSessions': { roles: ADMIN, fn: M.revokeMemberSessions },
  'settings.get': { roles: ADMIN, fn: M.getSettings },
  'settings.save': { roles: ADMIN, fn: M.saveSettings },
  'block.add': { roles: ADMIN, fn: M.addBlock },
  'block.remove': { roles: ADMIN, fn: M.removeBlock },
  // Audit
  'audit.list': { roles: AUDIT, fn: M.listAudit },
  'audit.export': { roles: AUDIT, fn: M.exportAudit },
  'audit.verify': { roles: AUDIT, fn: M.verifyAuditChain },
  'security.list': { roles: AUDIT, fn: M.listSecurityEvents },
  // Penyalahgunaan & platform
  'abuse.list': { roles: ['admin', 'superadmin'], fn: M.listAbuse },
  'abuse.handle': { roles: ['admin', 'superadmin'], fn: M.handleAbuse },
  'platform.get': { roles: ['superadmin'], fn: M.getPlatform },
  'platform.save': { roles: ['superadmin'], fn: M.savePlatform },
  'platform.workspace': { roles: ['superadmin'], fn: M.setWorkspacePlan }
};
