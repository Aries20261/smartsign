import nodemailer, { type Transporter } from 'nodemailer';
import { APP, ENV } from './config';

let transport: Transporter | null = null;
function transporter(): Transporter | null {
  if (transport) return transport;
  if (!ENV.smtpUrl) return null;
  transport = nodemailer.createTransport(ENV.smtpUrl);
  return transport;
}
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

export type Attachment = { filename: string; content: Buffer; contentType?: string };

/**
 * Email transaksional (undangan tanda tangan, OTP, notifikasi). Email autentikasi (verifikasi/reset)
 * dikirim oleh Supabase Auth dengan templat di supabase/templates.
 */
export async function sendMail(to: string, subject: string, heading: string, paragraphs: string[], ctaUrl?: string, ctaLabel?: string, attachments?: Attachment[]) {
  const html =
    '<!doctype html><html lang="id"><body style="margin:0;background:#f4f6fb;font-family:Arial,Helvetica,sans-serif;color:#111827">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px">' +
    '<table role="presentation" width="100%" style="max-width:560px;background:#fff;border-radius:12px;border:1px solid #e5e7eb"><tr><td style="padding:24px 28px">' +
    '<p style="font-size:18px;font-weight:bold;margin:0 0 16px">' + esc(APP.NAME) + '</p>' +
    '<h1 style="font-size:20px;margin:0 0 12px">' + esc(heading) + '</h1>' +
    paragraphs.filter(Boolean).map((p) => '<p style="font-size:15px;line-height:1.6;margin:0 0 12px">' + esc(p) + '</p>').join('') +
    (ctaUrl ? '<p style="margin:20px 0"><a href="' + esc(ctaUrl) + '" style="display:inline-block;background:#1d4ed8;color:#fff;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:8px">' + esc(ctaLabel || 'Buka') + '</a></p>' +
      '<p style="font-size:12px;color:#6b7280;word-break:break-all">Atau salin tautan ini: ' + esc(ctaUrl) + '</p>' : '') +
    '<p style="font-size:12px;color:#6b7280;line-height:1.5;margin:16px 0 0">' + esc(APP.NAME) + ' tidak pernah meminta password, PIN, atau kode OTP Anda lewat telepon atau chat.</p>' +
    '</td></tr></table></td></tr></table></body></html>';
  const text = [heading, '', ...paragraphs.filter(Boolean), '', ctaUrl ? (ctaLabel || 'Buka') + ': ' + ctaUrl : ''].join('\n');
  const t = transporter();
  if (!t) {
    if (ENV.isProd) throw new Error('SMTP_URL belum diatur');
    console.info(JSON.stringify({ mail: 'dev-log', to, subject }));
    return;
  }
  await t.sendMail({ from: ENV.mailFrom, to, subject: '[' + APP.NAME + '] ' + subject, html, text, attachments });
}
