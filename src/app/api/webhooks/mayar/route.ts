import { ENV } from '@/server/config';
import { handleMayarWebhook } from '@/server/services/billing';
import { safeEqual } from '@/server/util';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Webhook Mayar.id. Daftarkan di dashboard Mayar → Integration → Webhook:
 *   https://<APP_URL>/api/webhooks/mayar?token=<MAYAR_WEBHOOK_TOKEN>
 * Isi payload tidak dipercaya: status lunas diverifikasi ulang ke API Mayar sebelum paket diaktifkan.
 */
export async function POST(req: Request) {
  const want = ENV.mayarWebhookToken;
  const got = new URL(req.url).searchParams.get('token') || '';
  if (want && !safeEqual(got, want)) return new Response('Unauthorized', { status: 401 });
  if (Number(req.headers.get('content-length') || 0) > 100_000) return new Response('Too large', { status: 413 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return Response.json({ ok: false }, { status: 400 });
  try {
    const r = await handleMayarWebhook(body);
    return Response.json({ ok: true, ...r });
  } catch (e: any) {
    console.error(JSON.stringify({ at: 'mayar.webhook', msg: String(e?.message || e) }));
    return Response.json({ ok: false }, { status: 500 }); // Mayar dapat mencoba ulang
  }
}
export function GET() { return Response.json({ ok: true, info: 'Endpoint webhook Mayar aktif. Gunakan metode POST.' }); }
