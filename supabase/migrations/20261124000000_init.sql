-- SmartSign: skema awal (Supabase / Postgres 15+)
-- Prinsip:
--  * Semua akses data lewat server Next.js (koneksi DATABASE_URL). PostgREST/anon tidak punya akses (RLS deny-all).
--  * Setiap tabel milik tenant punya workspace_id; server selalu memfilter berdasarkan workspace dari sesi.
--  * audit_log dan signature_events append-only dengan rantai hash SHA-256 yang dihitung di database.

create extension if not exists pgcrypto with schema extensions;
create extension if not exists citext with schema extensions;

-- ---------------------------------------------------------------- util
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

-- ---------------------------------------------------------------- identitas & tenant
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  nama text not null default '' check (char_length(nama) <= 80),
  platform_role text not null default 'user' check (platform_role in ('user', 'superadmin')),
  status text not null default 'aktif' check (status in ('aktif', 'nonaktif')),
  last_workspace_id uuid,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index profiles_email_idx on public.profiles (lower(email));
create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();

-- profil dibuat otomatis saat akun Supabase Auth dibuat
create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, nama)
  values (new.id, lower(new.email), left(coalesce(nullif(trim(new.raw_user_meta_data->>'nama'), ''), split_part(new.email, '@', 1)), 80))
  on conflict (id) do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

create or replace function public.handle_user_email_change() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.email is distinct from old.email then update public.profiles set email = lower(new.email) where id = new.id; end if;
  return new;
end $$;
create trigger on_auth_user_email after update of email on auth.users for each row execute function public.handle_user_email_change();

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  nama text not null check (char_length(nama) between 2 and 80),
  owner_id uuid references public.profiles(id) on delete set null,
  plan text not null default 'free' check (plan in ('free', 'pro', 'org')),
  status text not null default 'aktif' check (status in ('aktif', 'ditangguhkan', 'dihapus')),
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger workspaces_touch before update on public.workspaces for each row execute function public.touch_updated_at();

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('admin', 'editor', 'viewer', 'auditor')),
  status text not null default 'aktif' check (status in ('aktif', 'nonaktif', 'dihapus')),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, user_id)
);
create index memberships_user_idx on public.memberships (user_id);
create trigger memberships_touch before update on public.memberships for each row execute function public.touch_updated_at();

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email text not null,
  role text not null check (role in ('admin', 'editor', 'viewer', 'auditor')),
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  status text not null default 'aktif' check (status in ('aktif', 'dipakai', 'dicabut', 'kedaluwarsa')),
  created_by uuid,
  created_at timestamptz not null default now()
);
create index invitations_ws_idx on public.invitations (workspace_id, status);

create table public.recovery_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  code_hash text not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index recovery_codes_user_idx on public.recovery_codes (user_id);

-- re-autentikasi untuk aksi sensitif, per sesi Supabase Auth
create table public.reauth (
  session_id uuid primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  at timestamptz not null default now()
);

-- pengaturan platform (satu baris), dikelola superadmin
create table public.platform_settings (
  id smallint primary key default 1 check (id = 1),
  settings jsonb not null default '{}'::jsonb,
  updated_by uuid,
  updated_at timestamptz not null default now()
);
insert into public.platform_settings (id) values (1) on conflict do nothing;

-- ---------------------------------------------------------------- rate limit (fixed window, atomik)
create table public.rate_limits (
  key text primary key,
  window_start timestamptz not null,
  count integer not null
);
create or replace function public.rate_hit(p_key text, p_window_seconds integer, p_increment integer default 1)
returns integer language plpgsql as $$
declare c integer;
begin
  insert into public.rate_limits as r (key, window_start, count) values (p_key, now(), p_increment)
  on conflict (key) do update set
    count = case when r.window_start < now() - make_interval(secs => p_window_seconds) then p_increment else r.count + p_increment end,
    window_start = case when r.window_start < now() - make_interval(secs => p_window_seconds) then now() else r.window_start end
  returning count into c;
  return c;
end $$;
create or replace function public.rate_peek(p_key text, p_window_seconds integer) returns integer language sql stable as $$
  select coalesce((select count from public.rate_limits where key = p_key and window_start >= now() - make_interval(secs => p_window_seconds)), 0)
$$;

-- ---------------------------------------------------------------- shortlink
create table public.links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  slug text not null check (slug ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,49}$'),
  title text not null check (char_length(title) between 2 and 120),
  destination text not null check (char_length(destination) <= 2000 and destination ~* '^https?://'),
  status text not null default 'aktif' check (status in ('aktif', 'nonaktif', 'arsip', 'diblokir', 'dihapus')),
  expires_at timestamptz,
  active_from timestamptz,
  password_hash text,
  max_clicks integer check (max_clicks is null or max_clicks > 0),
  click_count bigint not null default 0,
  campaign text not null default '',
  tags text not null default '',
  notes text not null default '',
  interstitial text not null default 'auto' check (interstitial in ('auto', 'always')),
  risk_score integer not null default 0,
  risk_flags jsonb not null default '[]'::jsonb,
  owner_id uuid references public.profiles(id) on delete set null,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- slug unik secara global dan TIDAK PERNAH dipakai ulang (QR lama tidak bisa dibajak)
create unique index links_slug_idx on public.links (lower(slug));
create index links_ws_idx on public.links (workspace_id, status, created_at desc);
create trigger links_touch before update on public.links for each row execute function public.touch_updated_at();

create table public.link_versions (
  id bigint generated always as identity primary key,
  link_id uuid not null references public.links(id) on delete cascade,
  workspace_id uuid not null,
  field text not null,
  old_value text not null default '',
  new_value text not null default '',
  source text not null default 'ui',
  created_by uuid,
  created_at timestamptz not null default now()
);
create index link_versions_link_idx on public.link_versions (link_id, created_at desc);

create table public.click_events (
  id bigint generated always as identity primary key,
  link_id uuid not null references public.links(id) on delete cascade,
  workspace_id uuid not null,
  at timestamptz not null default now(),
  day date not null default (now() at time zone 'Asia/Jakarta')::date,
  source text not null default 'langsung',
  device text not null default '',
  os text not null default '',
  browser text not null default '',
  referrer text not null default '',
  country text not null default '',
  visitor_hash text not null default '',
  result text not null default 'redirect'
);
create index click_events_ws_idx on public.click_events (workspace_id, at desc);
create index click_events_link_idx on public.click_events (link_id, at desc);

create table public.code_assets (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null references public.links(id) on delete cascade,
  workspace_id uuid not null,
  format text not null check (format in ('qr', 'code128')),
  design jsonb not null default '{}'::jsonb,
  version integer not null,
  status text not null default 'aktif' check (status in ('aktif', 'dihapus')),
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (link_id, format, version)
);

create table public.abuse_reports (
  id uuid primary key default gen_random_uuid(),
  link_id uuid references public.links(id) on delete set null,
  workspace_id uuid,
  slug text not null,
  reason text not null check (reason in ('phishing', 'malware', 'spam', 'penipuan', 'lainnya')),
  detail text not null default '',
  status text not null default 'baru' check (status in ('baru', 'ditindak', 'ditolak')),
  handled_by uuid,
  handled_at timestamptz,
  created_at timestamptz not null default now()
);
create index abuse_reports_ws_idx on public.abuse_reports (workspace_id, status, created_at desc);

create table public.blocklist (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid, -- null = global (dikelola superadmin)
  domain text not null check (domain ~ '^[a-z0-9.-]{3,200}$'),
  reason text not null default '',
  status text not null default 'aktif' check (status in ('aktif', 'dihapus')),
  created_by uuid,
  created_at timestamptz not null default now()
);
create index blocklist_ws_idx on public.blocklist (workspace_id, status);

-- ---------------------------------------------------------------- tanda tangan elektronik
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  code text not null unique,
  title text not null check (char_length(title) between 2 and 150),
  message text not null default '',
  file_path text not null,
  file_name text not null default '',
  size_bytes integer not null default 0,
  page_count integer not null default 1,
  page_sizes jsonb not null default '[]'::jsonb,
  original_hash text not null,
  final_path text,
  final_hash text,
  cert_path text,
  cert_hash text,
  status text not null default 'draft' check (status in ('draft', 'sent', 'viewed', 'partially_signed', 'completed', 'declined', 'expired', 'voided', 'dihapus')),
  signing_order text not null default 'sequential' check (signing_order in ('sequential', 'parallel')),
  expires_at timestamptz,
  sent_at timestamptz,
  completed_at timestamptz,
  void_reason text not null default '',
  owner_id uuid references public.profiles(id) on delete set null,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index documents_ws_idx on public.documents (workspace_id, status, created_at desc);
create index documents_hash_idx on public.documents (original_hash);
create index documents_final_hash_idx on public.documents (final_hash);
create trigger documents_touch before update on public.documents for each row execute function public.touch_updated_at();

create table public.signers (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  workspace_id uuid not null,
  sign_order integer not null default 1,
  nama text not null check (char_length(nama) between 2 and 80),
  email text not null,
  auth_method text not null default 'otp' check (auth_method in ('otp', 'otp_code')),
  access_code_hash text,
  token_hash text unique,
  token_expires_at timestamptz,
  otp_hash text,
  otp_expires_at timestamptz,
  otp_attempts integer not null default 0,
  session_hash text,
  session_expires_at timestamptz,
  status text not null default 'pending' check (status in ('pending', 'sent', 'viewed', 'signed', 'declined', 'voided')),
  fields jsonb not null default '[]'::jsonb,
  sent_at timestamptz,
  viewed_at timestamptz,
  signed_at timestamptz,
  declined_at timestamptz,
  decline_reason text not null default '',
  signature_path text,
  signature_hash text,
  signature_type text,
  field_values jsonb not null default '{}'::jsonb,
  user_agent text not null default '',
  ip_hash text not null default '',
  reminders integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index signers_doc_idx on public.signers (document_id, sign_order);
create trigger signers_touch before update on public.signers for each row execute function public.touch_updated_at();

create table public.signature_events (
  id bigint generated always as identity primary key,
  document_id uuid not null references public.documents(id) on delete cascade,
  signer_id uuid,
  event_type text not null,
  at timestamptz not null default clock_timestamp(),
  actor text not null default '',
  evidence jsonb not null default '{}'::jsonb,
  prev_hash text not null default '',
  hash text not null default ''
);
create index signature_events_doc_idx on public.signature_events (document_id, id);

create table public.verification_records (
  id bigint generated always as identity primary key,
  workspace_id uuid,
  user_id uuid,
  object_type text not null,
  object_id uuid,
  input text not null default '',
  result text not null check (result in ('valid', 'invalid', 'expired', 'unable', 'review')),
  reason_code text not null default '',
  detail jsonb not null default '{}'::jsonb,
  checked_at timestamptz not null default now()
);
create index verification_records_ws_idx on public.verification_records (workspace_id, checked_at desc);

-- ---------------------------------------------------------------- audit & keamanan
create table public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default clock_timestamp(),
  workspace_id uuid,
  user_id uuid,
  user_email text not null default '',
  action text not null,
  entity text not null default '',
  entity_id text not null default '',
  before jsonb,
  after jsonb,
  source text not null default 'ui',
  ip_hash text not null default '',
  prev_hash text not null default '',
  hash text not null default ''
);
create index audit_log_ws_idx on public.audit_log (workspace_id, id desc);

create table public.security_events (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  event_type text not null,
  severity text not null default 'info' check (severity in ('info', 'rendah', 'sedang', 'tinggi')),
  user_id uuid,
  workspace_id uuid,
  subject text not null default '',
  metadata jsonb not null default '{}'::jsonb
);
create index security_events_ws_idx on public.security_events (workspace_id, at desc);
create index security_events_user_idx on public.security_events (user_id, at desc);

-- ---------------------------------------------------------------- rantai hash (append-only)
create or replace function public.audit_chain_payload(r public.audit_log) returns text language sql immutable as $$
  select concat_ws('|', r.prev_hash, to_char(r.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), coalesce(r.workspace_id::text, ''),
    coalesce(r.user_id::text, ''), r.user_email, r.action, r.entity, r.entity_id, coalesce(r.before::text, ''), coalesce(r.after::text, ''), r.source)
$$;
create or replace function public.audit_chain_before_insert() returns trigger language plpgsql as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('audit:' || coalesce(new.workspace_id::text, '-'), 0));
  select hash into new.prev_hash from public.audit_log where workspace_id is not distinct from new.workspace_id order by id desc limit 1;
  new.prev_hash := coalesce(new.prev_hash, '');
  new.at := clock_timestamp();
  new.hash := encode(extensions.digest(public.audit_chain_payload(new), 'sha256'), 'hex');
  return new;
end $$;
create trigger audit_log_chain before insert on public.audit_log for each row execute function public.audit_chain_before_insert();

create or replace function public.sig_chain_payload(r public.signature_events) returns text language sql immutable as $$
  select concat_ws('|', r.prev_hash, r.document_id::text, coalesce(r.signer_id::text, ''), r.event_type,
    to_char(r.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), r.actor, r.evidence::text)
$$;
create or replace function public.sig_chain_before_insert() returns trigger language plpgsql as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('sig:' || new.document_id::text, 0));
  select hash into new.prev_hash from public.signature_events where document_id = new.document_id order by id desc limit 1;
  new.prev_hash := coalesce(new.prev_hash, '');
  new.at := clock_timestamp();
  new.hash := encode(extensions.digest(public.sig_chain_payload(new), 'sha256'), 'hex');
  return new;
end $$;
create trigger signature_events_chain before insert on public.signature_events for each row execute function public.sig_chain_before_insert();

-- larang UPDATE, dan DELETE kecuali purge retensi resmi (app.allow_purge = on dalam transaksi)
create or replace function public.forbid_mutation() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and current_setting('app.allow_purge', true) = 'on' then return old; end if;
  raise exception 'Tabel % bersifat append-only', tg_table_name using errcode = '42501';
end $$;
create trigger audit_log_immutable before update or delete on public.audit_log for each row execute function public.forbid_mutation();
create trigger signature_events_immutable before update or delete on public.signature_events for each row execute function public.forbid_mutation();

-- verifikasi rantai: mengembalikan baris pertama yang rusak (jika ada)
create or replace function public.verify_audit_chain(p_workspace uuid)
returns table (ok boolean, checked bigint, broken_id bigint) language plpgsql stable as $$
declare r public.audit_log; prev text := null; n bigint := 0;
begin
  for r in select * from public.audit_log where workspace_id is not distinct from p_workspace order by id loop
    n := n + 1;
    if (prev is not null and r.prev_hash <> prev)
       or r.hash <> encode(extensions.digest(public.audit_chain_payload(r), 'sha256'), 'hex') then
      return query select false, n, r.id; return;
    end if;
    prev := r.hash;
  end loop;
  return query select true, n, null::bigint;
end $$;

create or replace function public.verify_sig_chain(p_document uuid)
returns table (ok boolean, checked bigint, broken_id bigint) language plpgsql stable as $$
declare r public.signature_events; prev text := ''; n bigint := 0;
begin
  for r in select * from public.signature_events where document_id = p_document order by id loop
    n := n + 1;
    if r.prev_hash <> prev or r.hash <> encode(extensions.digest(public.sig_chain_payload(r), 'sha256'), 'hex') then
      return query select false, n, r.id; return;
    end if;
    prev := r.hash;
  end loop;
  return query select true, n, null::bigint;
end $$;

-- ---------------------------------------------------------------- sesi Supabase Auth (daftar & cabut)
create or replace function public.list_user_sessions(p_user uuid)
returns table (id uuid, created_at timestamptz, updated_at timestamptz, user_agent text, aal text, not_after timestamptz)
language sql stable security definer set search_path = '' as $$
  select s.id, s.created_at, coalesce(s.refreshed_at::timestamptz, s.updated_at, s.created_at), coalesce(s.user_agent, ''), coalesce(s.aal::text, ''), s.not_after
  from auth.sessions s where s.user_id = p_user order by coalesce(s.refreshed_at::timestamptz, s.updated_at, s.created_at) desc
$$;
create or replace function public.revoke_user_sessions(p_user uuid, p_session uuid default null, p_keep uuid default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  delete from auth.sessions s where s.user_id = p_user
    and (p_session is null or s.id = p_session) and (p_keep is null or s.id <> p_keep);
  get diagnostics n = row_count;
  return n;
end $$;
create or replace function public.mfa_enabled_users(p_users uuid[])
returns setof uuid language sql stable security definer set search_path = '' as $$
  select distinct f.user_id from auth.mfa_factors f where f.status = 'verified' and f.user_id = any(p_users)
$$;
revoke all on function public.mfa_enabled_users(uuid[]) from public, anon, authenticated;
revoke all on function public.list_user_sessions(uuid) from public, anon, authenticated;
revoke all on function public.revoke_user_sessions(uuid, uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- retensi
create or replace function public.purge_retention(p_click_days integer, p_security_days integer, p_audit_days integer)
returns jsonb language plpgsql as $$
declare a int; b int; c int; d int;
begin
  delete from public.click_events where at < now() - make_interval(days => p_click_days); get diagnostics a = row_count;
  delete from public.security_events where at < now() - make_interval(days => p_security_days); get diagnostics b = row_count;
  delete from public.rate_limits where window_start < now() - interval '2 days'; get diagnostics c = row_count;
  d := 0;
  if p_audit_days > 0 then
    perform set_config('app.allow_purge', 'on', true);
    delete from public.audit_log where at < now() - make_interval(days => p_audit_days); get diagnostics d = row_count;
    perform set_config('app.allow_purge', 'off', true);
  end if;
  return jsonb_build_object('clicks', a, 'security', b, 'rate', c, 'audit', d);
end $$;

-- ---------------------------------------------------------------- RLS: tolak semua akses PostgREST
do $$
declare t text;
begin
  foreach t in array array['profiles','workspaces','memberships','invitations','recovery_codes','reauth','rate_limits','links','link_versions',
    'click_events','code_assets','abuse_reports','blocklist','platform_settings','documents','signers','signature_events','verification_records','audit_log','security_events']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
-- Server terhubung sebagai pemilik tabel (postgres), sehingga RLS tanpa FORCE tidak menghalanginya,
-- sementara anon/authenticated (kunci publik) tidak bisa membaca atau menulis apa pun.
revoke execute on function public.rate_hit(text, integer, integer) from public, anon, authenticated;
revoke execute on function public.rate_peek(text, integer) from public, anon, authenticated;
revoke execute on function public.verify_audit_chain(uuid) from public, anon, authenticated;
revoke execute on function public.verify_sig_chain(uuid) from public, anon, authenticated;
revoke execute on function public.purge_retention(integer, integer, integer) from public, anon, authenticated;

-- ---------------------------------------------------------------- storage: bucket privat
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documents', 'documents', false, 10485760, array['application/pdf', 'image/png'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
