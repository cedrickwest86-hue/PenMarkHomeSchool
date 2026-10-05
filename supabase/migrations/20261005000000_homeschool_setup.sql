-- Homeschool Tracker: database setup
-- Applied automatically by the Supabase GitHub integration (Deploy to production), or paste into SQL Editor → Run. Safe to run again.

create extension if not exists pgcrypto with schema extensions;

-- A family (one homeschool) and who belongs to it
create table if not exists public.families (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Our homeschool',
  created_by uuid not null default auth.uid(),
  student_code_hash text unique,
  teacher_code_hash text unique,
  created_at timestamptz not null default now()
);

create table if not exists public.members (
  family_id uuid not null references public.families(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('teacher', 'student')),
  created_at timestamptz not null default now(),
  primary key (family_id, user_id)
);
create unique index if not exists members_one_family_per_account on public.members(user_id);

-- The tracker's saved data. "version" lets two devices save at once without losing changes.
create table if not exists public.kv (
  family_id uuid not null references public.families(id) on delete cascade,
  key text not null,
  value text not null,
  version bigint not null default 1,
  updated_at timestamptz not null default now(),
  primary key (family_id, key)
);

-- Only signed-in people (checked further by the rules below) can touch these tables
revoke all on public.families, public.members, public.kv from anon;
grant select, insert, update, delete on public.families, public.members, public.kv to authenticated;

alter table public.families enable row level security;
alter table public.members enable row level security;
alter table public.kv enable row level security;

-- Helpers (run with elevated rights so policies can check membership without recursion)
create or replace function public.my_role(fid uuid) returns text
language sql stable security definer set search_path = public as $$
  select role from public.members where family_id = fid and user_id = auth.uid()
$$;

create or replace function public.my_membership() returns table(family_id uuid, role text, family_name text)
language sql stable security definer set search_path = public as $$
  select m.family_id, m.role, f.name from public.members m join public.families f on f.id = m.family_id
  where m.user_id = auth.uid() limit 1
$$;

create or replace function public.am_teacher() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where user_id = auth.uid() and role = 'teacher')
$$;

-- Who can see and change what
drop policy if exists "family members read family" on public.families;
create policy "family members read family" on public.families for select to authenticated using (public.my_role(id) is not null);

drop policy if exists "family members read members" on public.members;
create policy "family members read members" on public.members for select to authenticated using (public.my_role(family_id) is not null);

drop policy if exists "kv read" on public.kv;
drop policy if exists "kv insert" on public.kv;
drop policy if exists "kv update" on public.kv;
drop policy if exists "kv delete" on public.kv;
create policy "kv read" on public.kv for select to authenticated using (public.my_role(family_id) is not null);
create policy "kv insert" on public.kv for insert to authenticated with check (public.my_role(family_id) is not null);
create policy "kv update" on public.kv for update to authenticated using (public.my_role(family_id) is not null) with check (public.my_role(family_id) is not null);
create policy "kv delete" on public.kv for delete to authenticated using (public.my_role(family_id) = 'teacher');

-- Save only if nobody else saved since we last read; otherwise hand back their version to merge
create or replace function public.kv_put(p_family uuid, p_key text, p_value text, p_expected bigint)
returns table(ok boolean, new_version bigint, current_value text)
language plpgsql security invoker set search_path = public as $$
declare v bigint;
begin
  if p_expected = 0 then
    insert into public.kv as k (family_id, key, value) values (p_family, p_key, p_value)
    on conflict (family_id, key) do nothing
    returning k.version into v;
  else
    update public.kv as k set value = p_value, version = k.version + 1, updated_at = now()
    where k.family_id = p_family and k.key = p_key and k.version = p_expected
    returning k.version into v;
  end if;
  if v is not null then
    return query select true, v, null::text;
  else
    return query select false, k.version, k.value from public.kv k where k.family_id = p_family and k.key = p_key;
  end if;
end $$;

-- Teacher creates the family (email accounts only, not student tablets)
create or replace function public.create_family(p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare fid uuid;
begin
  if auth.uid() is null or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception 'Sign in with your email to create a family';
  end if;
  if exists (select 1 from public.members where user_id = auth.uid()) then
    raise exception 'This account already belongs to a family';
  end if;
  insert into public.families (name, created_by) values (coalesce(nullif(trim(p_name), ''), 'Our homeschool'), auth.uid()) returning id into fid;
  insert into public.members (family_id, user_id, role) values (fid, auth.uid(), 'teacher');
  return fid;
end $$;

-- Teacher makes a code for a student tablet or a second teacher. Making a new one retires the old one.
create or replace function public.new_join_code(p_kind text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare fid uuid; raw text := ''; alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; i int;
begin
  select family_id into fid from public.members where user_id = auth.uid() and role = 'teacher';
  if fid is null then raise exception 'Only a teacher can make codes'; end if;
  for i in 1..10 loop
    raw := raw || substr(alphabet, 1 + (get_byte(gen_random_bytes(1), 0) % 32), 1);
  end loop;
  if p_kind = 'teacher' then
    update public.families set teacher_code_hash = encode(digest(raw, 'sha256'), 'hex') where id = fid;
  else
    update public.families set student_code_hash = encode(digest(raw, 'sha256'), 'hex') where id = fid;
  end if;
  return substr(raw, 1, 5) || '-' || substr(raw, 6, 5);
end $$;

-- A student tablet or second teacher joins with a code
create or replace function public.join_with_code(p_code text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare h text; fid uuid; r text;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  h := encode(digest(upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')), 'sha256'), 'hex');
  select id, 'student' into fid, r from public.families where student_code_hash = h;
  if fid is null then select id, 'teacher' into fid, r from public.families where teacher_code_hash = h; end if;
  if fid is null then raise exception 'That code didn''t match. Check it and try again.'; end if;
  if r = 'teacher' and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception 'Sign in with your own email to join as a teacher';
  end if;
  if exists (select 1 from public.members where user_id = auth.uid()) then
    raise exception 'This device or account is already connected to a family';
  end if;
  insert into public.members (family_id, user_id, role) values (fid, auth.uid(), r);
  return r;
end $$;

-- Teacher disconnects every student tablet (they'll need a new code)
create or replace function public.remove_student_devices() returns integer
language plpgsql security definer set search_path = public as $$
declare fid uuid; n integer;
begin
  select family_id into fid from public.members where user_id = auth.uid() and role = 'teacher';
  if fid is null then raise exception 'Only a teacher can do this'; end if;
  delete from public.members where family_id = fid and role = 'student';
  get diagnostics n = row_count;
  update public.families set student_code_hash = null where id = fid;
  return n;
end $$;

revoke execute on function public.my_role(uuid), public.my_membership(), public.am_teacher(),
  public.kv_put(uuid, text, text, bigint), public.create_family(text), public.new_join_code(text),
  public.join_with_code(text), public.remove_student_devices() from public, anon;
grant execute on function public.my_role(uuid), public.my_membership(), public.am_teacher(),
  public.kv_put(uuid, text, text, bigint), public.create_family(text), public.new_join_code(text),
  public.join_with_code(text), public.remove_student_devices() to authenticated;

-- Photos and files. Path: <family id>/files/... (work photos) or <family id>/keys/... (answer keys, teachers only)
insert into storage.buckets (id, name, public) values ('family-files', 'family-files', false) on conflict (id) do nothing;

create or replace function public.file_role(obj_name text) returns text
language plpgsql stable security definer set search_path = public as $$
declare parts text[] := storage.foldername(obj_name);
begin
  if coalesce(array_length(parts, 1), 0) < 2 or parts[1] !~ '^[0-9a-f-]{36}$' then return null; end if;
  return public.my_role(parts[1]::uuid);
end $$;
grant execute on function public.file_role(text) to authenticated;

drop policy if exists "family files read" on storage.objects;
drop policy if exists "family files add" on storage.objects;
drop policy if exists "family files change" on storage.objects;
drop policy if exists "family files remove" on storage.objects;
create policy "family files read" on storage.objects for select to authenticated using (
  bucket_id = 'family-files' and (
    ((storage.foldername(name))[2] = 'files' and public.file_role(name) is not null)
    or ((storage.foldername(name))[2] = 'keys' and public.file_role(name) = 'teacher')));
create policy "family files add" on storage.objects for insert to authenticated with check (
  bucket_id = 'family-files' and (
    ((storage.foldername(name))[2] = 'files' and public.file_role(name) is not null)
    or ((storage.foldername(name))[2] = 'keys' and public.file_role(name) = 'teacher')));
create policy "family files change" on storage.objects for update to authenticated using (
  bucket_id = 'family-files' and (
    ((storage.foldername(name))[2] = 'files' and public.file_role(name) is not null)
    or ((storage.foldername(name))[2] = 'keys' and public.file_role(name) = 'teacher')));
create policy "family files remove" on storage.objects for delete to authenticated using (
  bucket_id = 'family-files' and public.file_role(name) = 'teacher');
