/** Konstanta aplikasi dan konfigurasi dari environment variable. */
export const APP = {
  NAME: 'SmartSign',
  TAGLINE: 'Smartlink, QR & Tanda Tangan Elektronik',
  VERSION: '2.1.0',
  TZ: 'Asia/Jakarta',
  REAUTH_WINDOW_SEC: 300,
  LOGIN_MAX_FAIL: 5,
  LOGIN_LOCK_SEC: 900,
  PASSWORD_MIN: 10,
  MAX_PDF_BYTES: 10 * 1024 * 1024,
  MAX_SIGNATURE_BYTES: 300 * 1024,
  OTP_TTL_SEC: 600,
  OTP_MAX_ATTEMPTS: 5,
  SIGNER_SESSION_SEC: 1800,
  TOKEN_INVITE_SEC: 7 * 86400,
  PAGE_SIZE_MAX: 100,
  EXPORT_MAX_ROWS: 5000,
  CONSENT_VERSION: 'v1-2026-11',
  CONSENT_TEXT:
    'Saya telah membaca dan memahami seluruh isi dokumen ini. Dengan menekan tombol "Tanda Tangani", saya menyatakan setuju secara sadar dan tanpa paksaan ' +
    'untuk menandatangani dokumen ini secara elektronik, dan saya memahami bahwa tanda tangan ini adalah Tanda Tangan Elektronik tidak tersertifikasi ' +
    '(bukan dari Penyelenggara Sertifikasi Elektronik/PSrE) yang dibuktikan dengan autentikasi email, kode OTP, waktu tindakan, dan sidik jari (hash SHA-256) dokumen.',
  ASSURANCE_LABEL: 'Tanda Tangan Elektronik tidak tersertifikasi (TTE sederhana) dengan autentikasi OTP email'
} as const;

export const ROLES: Record<string, string> = { admin: 'Admin', editor: 'Editor', viewer: 'Pembaca', auditor: 'Auditor' };
export const ALL_ROLES = Object.keys(ROLES);

export type PlanId = 'free' | 'pro' | 'lifetime';
export const PLAN_LIMITS: Record<string, { label: string; links: number; docsPerMonth: number; members: number; esign: boolean }> = {
  free: { label: 'Gratis', links: 100, docsPerMonth: 0, members: 3, esign: false },
  pro: { label: 'Pro 3 Bulan', links: 5000, docsPerMonth: 200, members: 20, esign: true },
  lifetime: { label: 'Lifetime', links: 10000, docsPerMonth: 300, members: 20, esign: true }
};
/** Paket yang dapat dibeli. Harga dalam rupiah (integer). */
export const PLAN_PRICES: Record<'pro' | 'lifetime', { amount: number; days: number | null; label: string }> = {
  pro: { amount: 50000, days: 90, label: 'Pro 3 Bulan' },
  lifetime: { amount: 100000, days: null, label: 'Lifetime' }
};
/** Ruang kerja sistem untuk shortlink yang dibuat tanpa login. */
export const PUBLIC_WS_ID = '00000000-0000-0000-0000-000000000001';

export const DEFAULT_WS_SETTINGS = {
  requireMfaAdmin: true,
  interstitialMode: 'risky' as 'risky' | 'always',
  analyticsMode: 'full' as 'full' | 'minimal' | 'off',
  defaultLinkDays: 0,
  signLinkDays: 14,
  allowedDomains: '',
  brandColor: '#1d4ed8'
};
export type WsSettings = typeof DEFAULT_WS_SETTINGS;

export const DEFAULT_PLATFORM = {
  allowRegistration: true,
  globalBlocklist: '',
  retentionClickDays: 400,
  retentionSecurityDays: 365,
  retentionAuditDays: 0 // 0 = audit disimpan selamanya
};
export type PlatformSettings = typeof DEFAULT_PLATFORM;

function env(name: string, fallback = ''): string {
  const v = process.env[name];
  return v == null || v === '' ? fallback : v;
}

export const ENV = {
  get appUrl() { return env('APP_URL', 'http://localhost:3000').replace(/\/+$/, ''); },
  get shortDomain() { return env('SHORT_DOMAIN').replace(/\/+$/, ''); },
  get databaseUrl() { return env('DATABASE_URL'); },
  get supabaseUrl() { return env('NEXT_PUBLIC_SUPABASE_URL', env('SUPABASE_URL')).replace(/\/+$/, ''); },
  get supabasePublicKey() { return env('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', env('NEXT_PUBLIC_SUPABASE_ANON_KEY')); },
  get supabaseSecretKey() { return env('SUPABASE_SECRET_KEY', env('SUPABASE_SERVICE_ROLE_KEY')); },
  get appSecret() { return env('APP_SECRET'); },
  get smtpUrl() { return env('SMTP_URL'); },
  get mailFrom() { return env('MAIL_FROM', 'SmartSign <no-reply@localhost>'); },
  get safeBrowsingKey() { return env('SAFE_BROWSING_KEY'); },
  get cronSecret() { return env('CRON_SECRET'); },
  get mayarApiKey() { return env('MAYAR_API_KEY'); },
  /** https://api.mayar.id/hl/v1 (produksi) atau https://api.mayar.io/hl/v1 (sandbox) */
  get mayarApiBase() { return env('MAYAR_API_BASE', 'https://api.mayar.id/hl/v1').replace(/\/+$/, ''); },
  get mayarWebhookToken() { return env('MAYAR_WEBHOOK_TOKEN'); },
  get superadminEmails() { return env('SUPERADMIN_EMAILS').toLowerCase().split(/[\s,]+/).filter(Boolean); },
  get isProd() { return process.env.NODE_ENV === 'production'; }
};

/** Basis URL pendek: domain pendek khusus bila ada, selain itu domain aplikasi. */
export function shortBase(): string { return (ENV.shortDomain || ENV.appUrl) + '/'; }
export function shortUrlOf(slug: string): string { return shortBase() + slug; }
export function verifyUrlOf(code: string): string { return ENV.appUrl + '/verify?code=' + encodeURIComponent(code); }
