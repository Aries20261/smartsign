import { spaPage } from '@/server/web/html';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Pemindai/verifikasi publik barcode TTD tanpa kode di URL: /ttd/v */
export function GET() { return spaPage('qverify', ''); }
