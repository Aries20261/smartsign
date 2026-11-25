import { APP, ENV, PLAN_LIMITS, PLAN_PRICES } from '../config';
import { db, type Q } from '../db';
import { AppError, vErr } from '../errors';
import { audit, securityEvent } from '../audit';
import { rateLimit } from '../ratelimit';
import { effectivePlan, type Ctx } from '../session';
import { addSecIso, isEmail, maskEmail, str } from '../util';

/* ================= Paket & pembayaran (Mayar.id) =================
 * Alur: billing.checkout membuat tagihan di Mayar → pengguna membayar di halaman Mayar →
 * Mayar mengarahkan kembali ke aplikasi (billing.check) dan/atau mengirim webhook.
 * Status lunas SELALU diverifikasi ulang ke API Mayar (GET /payment/{id}); isi webhook tidak dipercaya.
 */

type MayarPayment = { id: string; status: string; amount: number; transactionId?: string; raw: unknown };

async function mayar(path: string, init?: RequestInit): Promise<any> {
  if (!ENV.mayarApiKey) throw new AppError('SERVER_ERROR', 'Pembayaran belum dikonfigurasi. Hubungi admin.');
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(ENV.mayarApiBase + path, {
      ...init, signal: ctl.signal,
      headers: { authorization: 'Bearer ' + ENV.mayarApiKey, 'content-type': 'application/json', accept: 'application/json', ...(init?.headers || {}) }
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || (body.statusCode && Number(body.statusCode) >= 400)) {
      console.error(JSON.stringify({ at: 'mayar', path: path.replace(/[0-9a-f-]{36}/g, ':id'), status: res.status, msg: body?.messages || body?.message }));
      throw new AppError('BUSY', 'Layanan pembayaran sedang bermasalah. Coba lagi beberapa saat.');
    }
    return body;
  } catch (e: any) {
    if (e instanceof AppError) throw e;
    throw new AppError('BUSY', 'Tidak dapat menghubungi layanan pembayaran. Coba lagi beberapa saat.');
  } finally { clearTimeout(t); }
}

async function mayarCreate(input: { name: string; email: string; mobile: string; amount: number; description: string; redirectUrl: string; expiredAt: string }) {
  const body = await mayar('/payment/create', {
    method: 'POST',
    body: JSON.stringify({ name: input.name, email: input.email, amount: input.amount, mobile: input.mobile, redirectUrl: input.redirectUrl,
      redirectURL: input.redirectUrl, description: input.description, expiredAt: input.expiredAt })
  });
  const d = body.data || {};
  if (!d.id || !d.link) throw new AppError('BUSY', 'Respons layanan pembayaran tidak lengkap. Coba lagi.');
  return { id: String(d.id), link: String(d.link), transactionId: String(d.transactionId || d.transaction_id || '') };
}
async function mayarGet(id: string): Promise<MayarPayment> {
  const body = await mayar('/payment/' + encodeURIComponent(id), { method: 'GET' });
  const d = body.data || {};
  return { id: String(d.id || id), status: String(d.status || '').toLowerCase(), amount: Number(d.amount || 0), transactionId: d.transactionId, raw: d };
}
const PAID = ['paid', 'success', 'settled', 'settlement', 'completed'];
const DEAD = ['expired', 'closed', 'cancelled', 'canceled', 'failed'];

function planInfo(ws: any) {
  const plan = effectivePlan(ws.plan, ws.planExpiresAt);
  return { plan, planLabel: PLAN_LIMITS[plan].label, planExpiresAt: plan === 'pro' ? ws.planExpiresAt : null,
    esignEnabled: ws.esignOverride == null ? PLAN_LIMITS[plan].esign : !!ws.esignOverride, limits: PLAN_LIMITS[plan] };
}
export function publicPlans() {
  return {
    currency: 'IDR',
    plans: [
      { id: 'free', label: PLAN_LIMITS.free.label, price: 0, period: 'Selamanya', features: ['Shortlink & QR (hingga ' + PLAN_LIMITS.free.links + ' tautan)', 'Analitik klik dasar', 'Pemindai QR & verifikasi dokumen', 'Hingga ' + PLAN_LIMITS.free.members + ' anggota tim'], esign: false },
      { id: 'pro', label: PLAN_PRICES.pro.label, price: PLAN_PRICES.pro.amount, period: '3 bulan', features: ['Semua fitur Gratis', 'Tanda tangan digital untuk klien (' + PLAN_LIMITS.pro.docsPerMonth + ' dokumen/bulan)', 'Hingga ' + PLAN_LIMITS.pro.links.toLocaleString('id-ID') + ' shortlink', 'Hingga ' + PLAN_LIMITS.pro.members + ' anggota tim'], esign: true },
      { id: 'lifetime', label: PLAN_PRICES.lifetime.label, price: PLAN_PRICES.lifetime.amount, period: 'Sekali bayar', features: ['Semua fitur Pro, tanpa batas waktu', 'Tanda tangan digital (' + PLAN_LIMITS.lifetime.docsPerMonth + ' dokumen/bulan)', 'Hingga ' + PLAN_LIMITS.lifetime.links.toLocaleString('id-ID') + ' shortlink', 'Pembaruan fitur gratis'], esign: true, best: true }
    ],
    paymentReady: !!ENV.mayarApiKey
  };
}

export async function billingGet(_p: any, u: Ctx) {
  const [ws] = await db()`select plan, plan_expires_at, esign_override from workspaces where id = ${u.workspaceId}`;
  const pays = await db()`select id, plan, amount, status, pay_url, expires_at, paid_at, period_end, created_at from payments where workspace_id = ${u.workspaceId} order by created_at desc limit 50`;
  return {
    ...publicPlans(), current: planInfo(ws), canBuy: u.role === 'admin',
    payments: pays.map((x) => ({ id: x.id, plan: x.plan, planLabel: PLAN_PRICES[x.plan as 'pro']?.label || x.plan, amount: x.amount, status: x.status,
      payUrl: x.status === 'pending' && x.expiresAt && Date.parse(x.expiresAt) > Date.now() ? x.payUrl : '', paidAt: x.paidAt, periodEnd: x.periodEnd, createdAt: x.createdAt }))
  };
}

export async function billingCheckout(p: any, u: Ctx) {
  const plan = p.plan === 'lifetime' ? 'lifetime' : p.plan === 'pro' ? 'pro' : '';
  if (!plan) throw vErr('plan', 'Pilih paket Pro 3 Bulan atau Lifetime.');
  const mobile = str(p.mobile, 20).replace(/[\s-]/g, '');
  if (!/^(\+62|62|0)8\d{7,12}$/.test(mobile)) throw vErr('mobile', 'Nomor HP tidak valid. Contoh: 081234567890.');
  const [ws] = await db()`select plan, plan_expires_at, esign_override from workspaces where id = ${u.workspaceId}`;
  if (effectivePlan(ws.plan, ws.planExpiresAt) === 'lifetime') throw new AppError('CONFLICT', 'Ruang kerja ini sudah memakai paket Lifetime.');
  await rateLimit('pay:' + u.workspaceId, 10, 3600, 'Terlalu banyak permintaan pembayaran. Coba lagi dalam 1 jam.');
  // pakai ulang tagihan yang masih berlaku untuk paket yang sama (hindari tagihan ganda)
  const [open] = await db()`select id, pay_url from payments where workspace_id = ${u.workspaceId} and plan = ${plan} and status = 'pending' and expires_at > now() + interval '10 minutes' order by created_at desc limit 1`;
  if (open?.payUrl) return { id: open.id, payUrl: open.payUrl, reused: true };
  const price = PLAN_PRICES[plan];
  const expiresAt = addSecIso(24 * 3600);
  const [row] = await db()`insert into payments ${db()({ workspaceId: u.workspaceId, userId: u.userId, plan, amount: price.amount, expiresAt } as never)} returning id`;
  try {
    const m = await mayarCreate({
      name: str(u.nama, 80) || u.email.split('@')[0], email: u.email, mobile, amount: price.amount,
      description: APP.NAME + ' ' + price.label + ' - ' + str(u.workspaceName, 60) + ' (#' + row.id.slice(0, 8) + ')',
      redirectUrl: ENV.appUrl + '/?pay=' + row.id + '#/billing', expiredAt: expiresAt
    });
    await db()`update payments set provider_id = ${m.id}, provider_tx = ${m.transactionId || null}, pay_url = ${m.link} where id = ${row.id}`;
    await audit(u, 'billing.checkout', 'Payment', row.id, null, { paket: plan, jumlah: price.amount });
    return { id: row.id, payUrl: m.link };
  } catch (e) {
    await db()`update payments set status = 'failed' where id = ${row.id}`;
    throw e;
  }
}

/** Mengaktifkan paket setelah pembayaran terverifikasi. Idempoten (aman dipanggil berkali-kali). */
async function activate(paymentId: string, verified: MayarPayment, source: string, q: Q = db()) {
  return q.begin(async (t) => {
    const [pay] = await t`select * from payments where id = ${paymentId} for update`;
    if (!pay || pay.status === 'paid') return false;
    if (verified.amount && verified.amount < pay.amount) {
      await securityEvent('pembayaran_jumlah_tidak_cocok', 'tinggi', { workspaceId: pay.workspaceId }, paymentId, { diharapkan: pay.amount, diterima: verified.amount });
      return false;
    }
    const [ws] = await t`select id, plan, plan_expires_at from workspaces where id = ${pay.workspaceId} for update`;
    const cur = effectivePlan(ws.plan, ws.planExpiresAt);
    let plan = ws.plan, expires: string | null = ws.planExpiresAt, start = new Date().toISOString(), end: string | null = null;
    if (pay.plan === 'lifetime') { plan = 'lifetime'; expires = null; }
    else if (cur !== 'lifetime') {
      const base = cur === 'pro' && ws.planExpiresAt ? Math.max(Date.parse(ws.planExpiresAt), Date.now()) : Date.now();
      start = new Date(base).toISOString();
      end = new Date(base + (PLAN_PRICES.pro.days as number) * 86400000).toISOString();
      plan = 'pro'; expires = end;
    }
    await t`update workspaces set plan = ${plan}, plan_expires_at = ${expires} where id = ${ws.id}`;
    await t`update payments set status = 'paid', paid_at = now(), period_start = ${start}, period_end = ${end}, provider_tx = coalesce(provider_tx, ${verified.transactionId || null}),
      raw = ${t.json(verified.raw as never)} where id = ${paymentId}`;
    await audit({ userId: pay.userId, workspaceId: ws.id, email: 'mayar' }, 'billing.paid', 'Payment', paymentId, { paket: cur }, { paket: plan, berlakuSampai: expires || 'selamanya', sumber: source }, 'sistem', t);
    return true;
  });
}

/** Memeriksa status satu tagihan ke Mayar lalu mengaktifkan paket bila lunas. */
async function syncPayment(pay: any, source: string) {
  if (!pay.providerId || pay.status !== 'pending') return pay.status;
  const v = await mayarGet(pay.providerId);
  if (PAID.includes(v.status)) { await activate(pay.id, v, source); return 'paid'; }
  if (DEAD.includes(v.status) || (pay.expiresAt && Date.parse(pay.expiresAt) < Date.now() - 3600000)) {
    await db()`update payments set status = 'expired' where id = ${pay.id} and status = 'pending'`;
    return 'expired';
  }
  return 'pending';
}

export async function billingCheck(p: any, u: Ctx) {
  const [pay] = await db()`select * from payments where id = ${str(p.id, 40)} and workspace_id = ${u.workspaceId}`;
  if (!pay) throw new AppError('NOT_FOUND', 'Tagihan tidak ditemukan.');
  await rateLimit('paychk:' + pay.id, 30, 600, 'Terlalu sering memeriksa. Tunggu sebentar.');
  const status = await syncPayment(pay, 'cek_manual');
  return { status, message: status === 'paid' ? 'Pembayaran diterima. Paket Anda sudah aktif.' : status === 'expired' ? 'Tagihan sudah kedaluwarsa. Silakan buat tagihan baru.' : 'Pembayaran belum kami terima. Jika sudah membayar, tunggu 1–2 menit lalu periksa lagi.' };
}

/**
 * Webhook Mayar (event payment.received). Payload hanya dipakai untuk MENCARI tagihan yang mungkin terkait;
 * aktivasi tetap berdasarkan hasil GET ke API Mayar, sehingga webhook palsu tidak bisa mengaktifkan paket.
 */
export async function handleMayarWebhook(body: any) {
  const d = body?.data || {};
  const ids = [d.id, d.paymentLinkId, d.productId, d.transactionId, d.transaction_id, d.paymentId].filter((x) => typeof x === 'string' && x).slice(0, 6);
  const email = typeof d.customerEmail === 'string' && isEmail(d.customerEmail.toLowerCase()) ? d.customerEmail.toLowerCase() : '';
  const sql = db();
  const rows = await sql`select p.* from payments p left join profiles pr on pr.id = p.user_id
    where p.status = 'pending' and p.created_at > now() - interval '3 days'
      and (p.provider_id = any(${ids}) or p.provider_tx = any(${ids}) ${email ? sql`or lower(pr.email) = ${email}` : sql``})
    order by p.created_at desc limit 5`;
  const out: string[] = [];
  for (const r of rows) out.push(await syncPayment(r, 'webhook').catch(() => 'error'));
  if (!rows.length) console.warn(JSON.stringify({ at: 'mayar.webhook', msg: 'tidak ada tagihan cocok', event: body?.event || body?.['event.received'] || '', email: email ? maskEmail(email) : '' }));
  return { matched: rows.length, results: out };
}

/** Cron: periksa tagihan tertunda (cadangan bila webhook tidak sampai) dan tandai yang kedaluwarsa. */
export async function reconcilePayments() {
  if (!ENV.mayarApiKey) return { checked: 0 };
  const rows = await db()`select * from payments where status = 'pending' and provider_id is not null and created_at > now() - interval '3 days' order by created_at limit 50`;
  let paid = 0;
  for (const r of rows) if ((await syncPayment(r, 'cron').catch(() => 'error')) === 'paid') paid++;
  await db()`update payments set status = 'expired' where status = 'pending' and expires_at < now() - interval '1 day'`;
  return { checked: rows.length, paid };
}

/* ---------- superadmin ---------- */
export async function listPayments(p: any) {
  const status = ['pending', 'paid', 'expired', 'failed'].includes(p.status) ? p.status : '';
  const rows = await db()`select p.id, p.plan, p.amount, p.status, p.paid_at, p.period_end, p.created_at, w.nama as ws_nama, pr.email
    from payments p join workspaces w on w.id = p.workspace_id left join profiles pr on pr.id = p.user_id
    ${status ? db()`where p.status = ${status}` : db()``} order by p.created_at desc limit 200`;
  const [sum] = await db()`select coalesce(sum(amount) filter (where status = 'paid'), 0)::int as total, count(*) filter (where status = 'paid')::int as n from payments`;
  return { rows: rows.map((r) => ({ id: r.id, plan: r.plan, amount: r.amount, status: r.status, paidAt: r.paidAt, periodEnd: r.periodEnd, createdAt: r.createdAt, workspace: r.wsNama, email: r.email || '' })), totalPaid: sum.total, countPaid: sum.n };
}
