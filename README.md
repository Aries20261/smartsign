# SmartSign

Shortlink, QR/barcode, dan tanda tangan elektronik dalam satu aplikasi.
Dibangun dengan **Next.js 16 (App Router) + Supabase (Postgres, Auth, Storage)** dan siap di-deploy ke **Vercel**.

> Tanda tangan di SmartSign adalah **Tanda Tangan Elektronik tidak tersertifikasi** (TTE sederhana, autentikasi OTP email).
> Ini bukan sertifikat elektronik dari PSrE. Untuk dokumen yang secara hukum wajib memakai TTE tersertifikasi, gunakan PSrE berinduk Kominfo.

## Fitur utama

| Modul | Isi |
|---|---|
| Akun | Registrasi + verifikasi email, login, MFA TOTP + 10 kode pemulihan, daftar & cabut sesi, ganti password, konfirmasi ulang (reauth) untuk aksi sensitif |
| Ruang kerja | Multi-workspace, peran Admin/Editor/Viewer/Auditor, undangan email, kebijakan wajib MFA untuk admin, paket & kuota |
| Shortlink | Slug kustom/acak, UTM, password, jadwal aktif, kedaluwarsa, batas klik atomik, halaman perantara untuk link berisiko, impor massal, riwayat versi, blocklist domain, Google Safe Browsing (opsional) |
| QR & barcode | QR dengan warna/logo/ECL, Code128, versi desain tersimpan, sumber kunjungan `qr` dipisah dari `langsung` |
| Analitik | Klik per hari, QR vs langsung, perangkat, OS, browser, referrer, negara, kampanye, ekspor CSV. Tanpa IP mentah (hanya HMAC harian) |
| E-signature | Unggah PDF (langsung ke Storage via signed URL), penanda tangan berurutan/paralel, field tanda tangan/nama/tanggal/teks, OTP email + kode akses opsional, persetujuan eksplisit, cek hash dokumen sebelum tanda tangan, tolak dengan alasan, pengingat, pembatalan |
| Bukti | PDF final + sertifikat penyelesaian dibuat otomatis di server, QR verifikasi, rantai hash per dokumen, email selesai dengan lampiran sertifikat |
| Verifikasi | Halaman publik `/verify` dengan kode atau berkas PDF (hash dihitung di browser), membedakan berkas final/sertifikat/asli/diubah |
| Scanner | Kamera/unggah gambar/manual, mengenali shortlink & dokumen milik sendiri, laporan PDF |
| Shortlink publik | Siapa pun bisa memendekkan tautan di beranda tanpa login (dibatasi 10/jam & 30/hari per IP, cek keamanan tetap berjalan). Setelah login/daftar di browser yang sama, tautan otomatis pindah ke akun dan slugnya bisa diganti. Slug lama tidak bisa dipakai orang lain |
| Paket & pembayaran | Gratis, Pro 3 bulan (Rp50.000), Lifetime (Rp100.000). Pembayaran lewat Mayar.id (QRIS, transfer, e-wallet). Status selalu diverifikasi ulang ke API Mayar, idempoten, dicek ulang tiap hari oleh cron |
| E-signature berbayar | Mengirim dokumen ke klien untuk ditandatangani hanya untuk paket Pro/Lifetime (atau dibuka manual oleh superadmin). Klien penanda tangan tidak perlu akun maupun membayar |
| TTD Realtime | Pengguna berbayar mengisi nama pejabat, jabatan, dan tujuan, lalu mendapat link `/ttd?token=…` (default berlaku 8 jam, bisa 1 jam sampai 3 hari, PIN opsional, sekali pakai). Penanda tangan menggambar tanda tangan tanpa akun. Hasilnya langsung muncul di menu TTD Realtime (diperbarui otomatis) dan bisa diunduh sebagai PNG tanda tangan, barcode TTD, atau spesimen (tanda tangan + barcode). Barcode mengarah ke halaman verifikasi publik `/ttd/v/<kode>` |
| Panel superadmin | Kelola pengguna (nonaktifkan, jadikan superadmin), reset password (kirim tautan atau password sementara yang wajib diganti), reset MFA, ubah paket/masa aktif/akses e-sign, daftar pembayaran |
| Audit & keamanan | Log audit append-only berantai hash (trigger DB), verifikasi rantai, log keamanan, laporan penyalahgunaan publik, retensi data via cron |

## Arsitektur singkat

```
Browser (SPA vanilla JS, tanpa skrip inline, CSP ketat)
   │  POST /api/rpc  {action, payload}   ← satu gerbang: CSRF, rate limit, sesi, RBAC
   ▼
Next.js route handlers (Node runtime, Vercel)
   ├─ /[slug]          302 langsung ke tujuan (atau /go/[slug] bila perlu password/peringatan)
   ├─ /go/[slug]       halaman perantara
   ├─ /sign/[token]    halaman penanda tangan
   ├─ /verify          verifikasi publik
   ├─ /auth/confirm    tautan email Supabase
   └─ /api/cron/daily  pekerjaan harian (Vercel Cron)
   ▼
Supabase: Postgres (RLS deny-all untuk anon/authenticated, server memakai DATABASE_URL)
          Auth (cookie httpOnly, TOTP MFA)  ·  Storage bucket privat `documents`
```

Semua data hanya diakses lewat server. Kunci publik Supabase tidak bisa membaca tabel apa pun (diuji).

## Menjalankan secara lokal

Prasyarat: Node 20+, Docker, [Supabase CLI](https://supabase.com/docs/guides/cli).

```bash
npm install
supabase start            # Postgres, Auth, Storage, Mailpit (email uji di http://127.0.0.1:54324)
cp .env.example .env.local
# isi .env.local dengan nilai dari `supabase status` (lihat contoh di bawah)
npm run dev               # http://localhost:3000
```

Contoh `.env.local` untuk stack lokal:

```
APP_URL=http://localhost:3000
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<publishable key dari supabase status>
SUPABASE_SECRET_KEY=<secret key dari supabase status>
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
APP_SECRET=<openssl rand -hex 32>
SUPERADMIN_EMAILS=emailanda@domain.id
SMTP_URL=smtp://127.0.0.1:54325
CRON_SECRET=<acak>
```

## Deploy ke Supabase + Vercel

### 1. Supabase
1. Buat proyek baru di [supabase.com](https://supabase.com) (region yang sama dengan `regions` di `vercel.json` (saat ini Sydney `ap-southeast-2` ↔ Vercel `syd1`; ganti ke `sin1` bila proyek Supabase di Singapore)).
2. Terapkan skema database, pilih salah satu:
   - `supabase link --project-ref <ref>` lalu `supabase db push`, atau
   - buka **SQL Editor**, jalankan **berurutan** isi `supabase/migrations/20261124000000_init.sql`, lalu `supabase/migrations/20261125000000_billing.sql`, lalu `supabase/migrations/20261126000000_quick_sign.sql` (masing-masing **Run**). Keduanya aman dijalankan ulang.
3. **Authentication → Sign In / Providers → Email**: aktifkan *Confirm email*. Minimal password 10.
4. **Authentication → Multi-Factor**: aktifkan **TOTP** (enroll + verify).
5. **Authentication → URL Configuration**:
   - Site URL: `https://<domain-anda>`
   - Redirect URLs: `https://<domain-anda>/**`
6. **Authentication → Email Templates**: salin isi `supabase/templates/confirmation.html`, `recovery.html`, `email_change.html` ke template *Confirm signup*, *Reset password*, *Change email*.
   Tautan di template memakai `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=...` (diverifikasi di server, lebih tahan terhadap pemindai tautan email).
   Langkah ini **opsional**: template bawaan Supabase (`{{ .ConfirmationURL }}`) juga didukung, asalkan Site URL sudah benar.
   Di mode Preview, klik **Source** untuk mengedit isi template.
7. **Authentication → SMTP Settings**: pasang SMTP sendiri (mis. Resend, Brevo, Mailgun). SMTP bawaan Supabase dibatasi beberapa email per jam.
8. Catat dari **Project Settings → API**: Project URL, publishable key, secret key.
   Lalu dari **Connect → Transaction pooler**: connection string port **6543**.

### 2. Vercel
1. **Add New → Project → Import** repo GitHub ini. Framework terdeteksi otomatis sebagai Next.js.
2. Isi **Environment Variables** sesuai `.env.example`:

| Variabel | Wajib | Keterangan |
|---|---|---|
| `APP_URL` | ya | `https://<domain-anda>` tanpa `/` di akhir |
| `NEXT_PUBLIC_SUPABASE_URL` | ya | Project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | ya | publishable (atau anon) key |
| `SUPABASE_SECRET_KEY` | ya | secret (atau service_role) key. **Jangan pernah dibagikan** |
| `DATABASE_URL` | ya | Transaction pooler, port 6543 |
| `APP_SECRET` | ya | acak ≥ 32 karakter (`openssl rand -hex 32`) |
| `SUPERADMIN_EMAILS` | ya | email admin platform, dipisah koma |
| `SMTP_URL`, `MAIL_FROM` | ya | untuk OTP tanda tangan & undangan |
| `CRON_SECRET` | disarankan | Vercel otomatis mengirimkannya ke cron |
| `SHORT_DOMAIN` | opsional | domain pendek, mis. `https://s.domain.id` |
| `SAFE_BROWSING_KEY` | opsional | Google Safe Browsing API |
| `MAYAR_API_KEY` | untuk pembayaran | API key dari dashboard Mayar → Integration → API Key |
| `MAYAR_API_BASE` | opsional | default `https://api.mayar.id/hl/v1`; sandbox: `https://api.mayar.io/hl/v1` |
| `MAYAR_WEBHOOK_TOKEN` | untuk pembayaran | acak ≥ 24 karakter, dipakai di URL webhook |

3. **Deploy**. `vercel.json` mengatur region fungsi (`syd1`) dan cron harian pukul 01.00 WIB (`/api/cron/daily`).
4. Buka `https://<domain-anda>/api/health` untuk memastikan database, Auth, dan Storage tersambung (semua harus `OK`).
5. Daftar akun memakai email yang ada di `SUPERADMIN_EMAILS`, verifikasi email, lalu aktifkan MFA saat diminta.

### 3. Pembayaran Mayar.id
1. Isi `MAYAR_API_KEY` dan `MAYAR_WEBHOOK_TOKEN` di Vercel, lalu redeploy.
2. Di dashboard Mayar → **Integration → Webhook**, daftarkan
   `https://<domain-anda>/api/webhooks/mayar?token=<MAYAR_WEBHOOK_TOKEN>` (event pembayaran diterima).
3. Webhook hanya pemicu: aplikasi selalu memeriksa ulang status tagihan ke API Mayar sebelum mengaktifkan paket, jadi webhook palsu tidak berpengaruh. Bila webhook terlewat, tombol **Periksa status** di halaman Paket & Tagihan dan cron harian akan menyelesaikannya.
4. Uji dulu dengan sandbox (`MAYAR_API_BASE=https://api.mayar.io/hl/v1` + API key sandbox).
5. Superadmin bisa mengubah paket manual di **Platform → Ruang kerja & paket** (mis. pembayaran di luar Mayar).

### 4. Domain pendek (opsional)
Tambahkan domain kedua (mis. `s.domain.id`) di **Vercel → Settings → Domains** pada proyek yang sama, lalu isi `SHORT_DOMAIN`. Link `https://s.domain.id/<slug>` akan langsung diarahkan.

## Pengujian

```bash
supabase start && npm run build && npm start   # terminal 1
npm test                                       # terminal 2: 42 skenario end-to-end
npm run test:ui                                # screenshot desktop + 360 px, cek error konsol/CSP/overflow
npm run typecheck
```

Hasil terakhir (24 Nov 2026, stack Supabase lokal): lihat [`docs/hasil-uji-e2e.txt`](docs/hasil-uji-e2e.txt) dan [`docs/screenshots`](docs/screenshots).

| Pemeriksaan | Status | Alat |
|---|---|---|
| TypeScript strict | PASS | `tsc --noEmit` |
| Build produksi | PASS | `next build` |
| End-to-end (auth, MFA, shortlink, tanda tangan, verifikasi, RBAC, IDOR, audit, rate limit, cron) | PASS 42/42 | `npm test` |
| Render UI desktop & 360 px, error konsol, CSP, overflow | PASS (20 halaman, 0 masalah) | Playwright + Chrome |
| Dependensi | PASS, 0 kerentanan | `npm audit` |
| Deploy ke Supabase cloud + Vercel | NOT TESTED | perlu akun Anda |
| Pengiriman email produksi (SMTP) | NOT TESTED | diuji dengan Mailpit lokal |

## Batasan yang perlu diketahui
- Bukan TTE tersertifikasi PSrE (lihat catatan di atas).
- Cache redirect per instance 15 detik: perubahan tujuan link bisa butuh hingga 15 detik untuk berlaku di semua instance.
- Rate limit disimpan di Postgres (tanpa Redis). Cukup untuk ribuan permintaan per menit; untuk trafik sangat tinggi pertimbangkan Upstash Redis.
- Paket Vercel Hobby hanya mengizinkan cron harian dan durasi fungsi terbatas; pembuatan PDF final untuk dokumen besar (>50 halaman) disarankan memakai paket Pro.
- Ukuran PDF maksimal 10 MB.

## Struktur
```
src/app/            route handler (halaman, redirect, API)
src/server/         logika server: auth, sesi, RBAC, audit, rate limit, PDF, storage
src/server/services links.ts, docs.ts, scan.ts, admin.ts, auth.ts
public/js/          klien SPA (vanilla JS)
public/css/app.css  gaya
supabase/           migrasi SQL, config lokal, template email
tests/              e2e (HTTP) dan UI (Playwright)
```
