import { spaPage } from '@/server/web/html';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Halaman penanda tangan TTD Realtime: /ttd?token=<uuid> */
export function GET(req: Request) { return spaPage('qsign', new URL(req.url).searchParams.get('token') || ''); }
