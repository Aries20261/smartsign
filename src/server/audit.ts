import { db, type Q } from './db';
import { str } from './util';

export type Actor = { userId?: string | null; email?: string; workspaceId?: string | null; ipHash?: string } | null;

const SENSITIVE = /password|token|secret|hash|otp|code_?hash|accessCode/i;
function scrub(v: unknown, depth = 0): unknown {
  if (v == null || depth > 4) return v ?? null;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => scrub(x, depth + 1));
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (/^(passwordHash|tokenHash|otpHash|sessionHash|accessCodeHash)$/.test(k)) { out[k] = x ? '[disamarkan]' : ''; continue; }
      if (SENSITIVE.test(k) && typeof x === 'string' && x.length > 0 && !/Hash$|hash$/.test(k)) { out[k] = '[disamarkan]'; continue; }
      out[k] = scrub(x, depth + 1);
    }
    return out;
  }
  if (typeof v === 'string') return v.slice(0, 2000);
  return v;
}

/** Catatan audit append-only; hash berantai dihitung oleh trigger database per ruang kerja. */
export async function audit(u: Actor, action: string, entity: string, entityId: string | null, before: unknown, after: unknown, source = 'ui', q: Q = db()) {
  await q`insert into audit_log ${q({
    workspaceId: u?.workspaceId || null, userId: u?.userId || null, userEmail: str(u?.email, 160), action, entity,
    entityId: str(entityId, 80), before: before == null ? null : (scrub(before) as never), after: after == null ? null : (scrub(after) as never),
    source, ipHash: u?.ipHash || ''
  } as never)}`;
}

export async function securityEvent(type: string, severity: 'info' | 'rendah' | 'sedang' | 'tinggi', u: Actor, subject: string, metadata?: unknown, q: Q = db()) {
  await q`insert into security_events ${q({
    eventType: type, severity, userId: u?.userId || null, workspaceId: u?.workspaceId || null, subject: str(subject, 160),
    metadata: (metadata || {}) as never
  } as never)}`;
}
