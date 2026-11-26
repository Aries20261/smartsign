-- SmartSign: TTD Realtime (permintaan tanda tangan via tautan berbatas waktu, tanpa PDF).
-- Aman dijalankan ulang.

create table if not exists public.sign_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  created_by uuid references public.profiles(id) on delete set null,
  code text not null unique,
  token_hash text not null unique,
  token_enc text not null,
  signer_name text not null,
  signer_title text not null,
  purpose text not null,
  pin_hash text,
  status text not null default 'pending' check (status in ('pending', 'signed', 'cancelled')),
  valid_hours int not null default 8,
  expires_at timestamptz not null,
  opened_at timestamptz,
  signed_at timestamptz,
  signature_path text,
  signature_hash text,
  signature_type text,
  record_hash text,
  signer_ip_hash text,
  signer_device text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists sign_requests_ws_idx on public.sign_requests (workspace_id, created_at desc);
drop trigger if exists sign_requests_touch on public.sign_requests;
create trigger sign_requests_touch before update on public.sign_requests for each row execute function public.touch_updated_at();
alter table public.sign_requests enable row level security;
revoke all on public.sign_requests from anon, authenticated;
