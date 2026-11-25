-- SmartSign 2.1: paket berbayar (Mayar.id), shortlink publik tanpa login, kelola akses & reset password.
-- Aman dijalankan ulang (idempotent). Jalankan di Supabase SQL Editor setelah 20261124000000_init.sql.

-- ---------------------------------------------------------------- paket ruang kerja
alter table public.workspaces drop constraint if exists workspaces_plan_check;
update public.workspaces set plan = 'lifetime' where plan = 'org';
alter table public.workspaces add constraint workspaces_plan_check check (plan in ('free', 'pro', 'lifetime'));
alter table public.workspaces add column if not exists plan_expires_at timestamptz;
-- null = ikuti paket; true = admin memberi akses e-signature; false = admin mencabut akses
alter table public.workspaces add column if not exists esign_override boolean;

-- ---------------------------------------------------------------- akun
alter table public.profiles add column if not exists must_change_password boolean not null default false;

-- ---------------------------------------------------------------- pembayaran
create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete set null,
  plan text not null check (plan in ('pro', 'lifetime')),
  amount integer not null check (amount > 0),
  status text not null default 'pending' check (status in ('pending', 'paid', 'expired', 'failed', 'cancelled')),
  provider text not null default 'mayar',
  provider_id text,
  provider_tx text,
  pay_url text,
  expires_at timestamptz,
  paid_at timestamptz,
  period_start timestamptz,
  period_end timestamptz,
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists payments_ws_idx on public.payments (workspace_id, created_at desc);
create unique index if not exists payments_provider_idx on public.payments (provider, provider_id) where provider_id is not null;
drop trigger if exists payments_touch on public.payments;
create trigger payments_touch before update on public.payments for each row execute function public.touch_updated_at();
alter table public.payments enable row level security;
revoke all on public.payments from anon, authenticated;

-- ---------------------------------------------------------------- slug yang pernah dipakai tidak boleh dipakai ulang
create table if not exists public.retired_slugs (
  slug text primary key,
  link_id uuid,
  retired_at timestamptz not null default now()
);
alter table public.retired_slugs enable row level security;
revoke all on public.retired_slugs from anon, authenticated;

-- ---------------------------------------------------------------- shortlink publik (tanpa login)
-- Semua tautan anonim disimpan di ruang kerja sistem ini; pembuatnya dapat mengklaimnya setelah login.
alter table public.links add column if not exists claim_hash text;
create index if not exists links_claim_idx on public.links (claim_hash) where claim_hash is not null;
insert into public.workspaces (id, nama, plan, status, settings)
values ('00000000-0000-0000-0000-000000000001', 'Shortlink Publik', 'free', 'aktif', '{"interstitialMode":"risky","analyticsMode":"minimal"}'::jsonb)
on conflict (id) do nothing;

-- ---------------------------------------------------------------- sesi yang dicabut langsung tidak berlaku
-- JWT tetap sah secara kriptografis sampai kedaluwarsa; server memeriksa sesi masih ada agar pencabutan langsung efektif.
create or replace function public.session_active(p_user uuid, p_session uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from auth.sessions s where s.id = p_session and s.user_id = p_user and (s.not_after is null or s.not_after > now()))
$$;
revoke all on function public.session_active(uuid, uuid) from public, anon, authenticated;
