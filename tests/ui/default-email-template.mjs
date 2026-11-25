// Uji: tautan dari template email BAWAAN Supabase (token di fragmen URL) tetap berfungsi untuk verifikasi & reset password.
if (!process.env.SB_SECRET) { console.error('Set SB_SECRET (secret key dari supabase status)'); process.exit(1); }
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createClient } = require('@supabase/supabase-js');
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const admin = createClient('http://127.0.0.1:54321', process.env.SB_SECRET /* secret key dari `supabase status` */, { auth: { persistSession: false } });
const email = 'tpl' + Date.now() + '@contoh.test';
const s = await admin.auth.admin.generateLink({ type: 'signup', email, password: 'Lembayung-Senja-2026', options: { redirectTo: 'http://localhost:3000/auth/confirm' } }); if (s.error) { console.log(s.error); process.exit(1); }
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const p = await b.newPage(); const errs = []; p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
await p.goto(s.data.properties.action_link); await p.waitForURL(/notice=/, { timeout: 10000 }).catch(() => {});
console.log('signup ->', p.url());
const r = await admin.auth.admin.generateLink({ type: 'recovery', email, options: { redirectTo: 'http://localhost:3000/auth/confirm' } });
await p.goto(r.data.properties.action_link); await p.waitForURL(/\/reset|notice=/, { timeout: 10000 }).catch(() => {});
console.log('recovery ->', p.url());
const res = await p.evaluate(async () => (await fetch('/api/rpc', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'smartsign' }, body: JSON.stringify({ action: 'auth.reset', payload: { password: 'Kenari-Biru-2027x' } }) })).json());
console.log('reset ->', JSON.stringify(res).slice(0, 150));
console.log('errors', errs);
await b.close();
