import { spaPage } from '@/server/web/html';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(req: Request) { return spaPage('app', '', new URL(req.url).searchParams.get('notice') || ''); }
