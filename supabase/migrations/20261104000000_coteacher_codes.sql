-- Co-teachers can join with just a code, and create their own email login later.
-- Paste into Supabase → SQL Editor → Run. Safe to run again.
--
-- What changes:
--   • Co-teacher codes now work once and expire after 7 days. (Old reusable co-teacher codes stop working.)
--   • A co-teacher can enter a code without an account. Until they create a login, they're "this device only":
--     full lessons, grading, and calendar, but no AI tools and no making or removing codes or people.
--   • Teachers can see everyone with teacher access and remove a co-teacher.

-- Single-use co-teacher invitations
create table if not exists public.teacher_invites (
  code_hash text primary key,
  family_id uuid not null references public.families(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  used_at timestamptz,
  used_by uuid references auth.users(id) on delete set null
);
alter table public.teacher_invites enable row level security;  -- only reachable through the functions below
revoke all on public.teacher_invites from anon, authenticated;

-- The old reusable co-teacher code is retired
update public.families set teacher_code_hash = null where teacher_code_hash is not null;

-- Signed in with a code only, no email yet
create or replace function public.is_device_only() returns boolean
language sql stable set search_path = public as $$
  select coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)
$$;

-- The family of a teacher who has their own login; otherwise a clear error
create or replace function public.require_full_teacher() returns uuid
language plpgsql stable security definer set search_path = public as $$
declare fid uuid;
begin
  select family_id into fid from public.members where user_id = auth.uid() and role = 'teacher' and student_id is null;
  if fid is null then raise exception 'Only a teacher can do this'; end if;
  if public.is_device_only() then
    raise exception 'Create your login first (Setup → Your login). Then you can do this.';
  end if;
  return fid;
end $$;

-- Codes: tablet codes as before; co-teacher codes are now single-use invitations
create or replace function public.new_join_code(p_kind text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare fid uuid; raw text := ''; alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; i int;
begin
  fid := public.require_full_teacher();
  for i in 1..10 loop
    raw := raw || substr(alphabet, 1 + (get_byte(gen_random_bytes(1), 0) % 32), 1);
  end loop;
  if p_kind = 'teacher' then
    delete from public.teacher_invites where family_id = fid and (used_at is not null or expires_at < now());
    insert into public.teacher_invites (code_hash, family_id, created_by) values (encode(digest(raw, 'sha256'), 'hex'), fid, auth.uid());
  else
    update public.families set student_code_hash = encode(digest(raw, 'sha256'), 'hex') where id = fid;
  end if;
  return substr(raw, 1, 5) || '-' || substr(raw, 6, 5);
end $$;

create or replace function public.join_with_code(p_code text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare h text; fid uuid; r text; sid text; inv record;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  h := encode(digest(upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')), 'sha256'), 'hex');
  select family_id, student_id, 'student' into fid, sid, r from public.student_codes where code_hash = h;
  if fid is null then select id, 'student' into fid, r from public.families where student_code_hash = h; end if;
  if fid is null then
    select * into inv from public.teacher_invites where code_hash = h for update;
    if found then
      if inv.used_at is not null or inv.expires_at < now() then
        raise exception 'That co-teacher code was already used or has expired. Ask the teacher for a new one.';
      end if;
      fid := inv.family_id; r := 'teacher';
    end if;
  end if;
  if fid is null then raise exception 'That code didn''t match. Check it and try again.'; end if;
  if exists (select 1 from public.members where user_id = auth.uid()) then
    raise exception 'This device or account is already connected to a family';
  end if;
  insert into public.members (family_id, user_id, role, student_id) values (fid, auth.uid(), r, sid);
  if r = 'teacher' then
    update public.teacher_invites set used_at = now(), used_by = auth.uid() where code_hash = h;
  end if;
  return r;
end $$;

-- Device codes and disconnects need a teacher with their own login
create or replace function public.new_student_code(p_student text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare fid uuid; raw text := ''; alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; i int; d jsonb;
begin
  fid := public.require_full_teacher();
  select value::jsonb into d from public.kv where family_id = fid and key = 'hs-tracker:data';
  if not exists (select 1 from jsonb_array_elements(coalesce(d->'students', '[]'::jsonb)) s where s->>'id' = p_student) then
    raise exception 'That student wasn''t found. Add them in Setup first.';
  end if;
  for i in 1..10 loop
    raw := raw || substr(alphabet, 1 + (get_byte(gen_random_bytes(1), 0) % 32), 1);
  end loop;
  delete from public.student_codes where family_id = fid and student_id = p_student;
  insert into public.student_codes (code_hash, family_id, student_id) values (encode(digest(raw, 'sha256'), 'hex'), fid, p_student);
  return substr(raw, 1, 5) || '-' || substr(raw, 6, 5);
end $$;

create or replace function public.remove_child_devices(p_student text) returns integer
language plpgsql security definer set search_path = public as $$
declare fid uuid; n integer;
begin
  fid := public.require_full_teacher();
  delete from public.members where family_id = fid and student_id = p_student;
  get diagnostics n = row_count;
  delete from public.student_codes where family_id = fid and student_id = p_student;
  return n;
end $$;

create or replace function public.remove_student_devices() returns integer
language plpgsql security definer set search_path = public as $$
declare fid uuid; n integer;
begin
  fid := public.require_full_teacher();
  delete from public.members where family_id = fid and role = 'student';
  get diagnostics n = row_count;
  update public.families set student_code_hash = null where id = fid;
  delete from public.student_codes where family_id = fid;
  return n;
end $$;

-- AI tools only for teachers with their own login (and only once you've switched AI on for the family)
create or replace function public.can_use_ai() returns boolean
language sql stable security definer set search_path = public as $$
  select not public.is_device_only() and exists (
    select 1 from public.members m join public.families f on f.id = m.family_id
    where m.user_id = auth.uid() and m.role = 'teacher' and m.student_id is null and f.ai_enabled
  )
$$;

-- Everyone with teacher access to my family
create or replace function public.family_teachers()
returns table(user_id uuid, email text, device_only boolean, joined timestamptz, is_me boolean, is_owner boolean)
language sql stable security definer set search_path = public, auth as $$
  with fam as (select family_id from public.members where user_id = auth.uid() and role = 'teacher' and student_id is null)
  select m.user_id, u.email::text, coalesce(u.is_anonymous, false), m.created_at, m.user_id = auth.uid(), f.created_by = m.user_id
  from public.members m
  join fam on fam.family_id = m.family_id
  join public.families f on f.id = m.family_id
  join auth.users u on u.id = m.user_id
  where m.role = 'teacher' and m.student_id is null
  order by m.created_at
$$;

-- Co-teacher codes that haven't been used yet
create or replace function public.open_teacher_invites() returns table(created_at timestamptz, expires_at timestamptz)
language sql stable security definer set search_path = public as $$
  select i.created_at, i.expires_at from public.teacher_invites i
  join public.members m on m.family_id = i.family_id and m.user_id = auth.uid() and m.role = 'teacher' and m.student_id is null
  where i.used_at is null and i.expires_at > now()
  order by i.created_at
$$;

create or replace function public.cancel_teacher_invites() returns integer
language plpgsql security definer set search_path = public as $$
declare fid uuid; n integer;
begin
  fid := public.require_full_teacher();
  delete from public.teacher_invites where family_id = fid and used_at is null;
  get diagnostics n = row_count;
  return n;
end $$;

-- Remove a co-teacher. The family's original teacher can't be removed, and you can't remove yourself here.
create or replace function public.remove_teacher(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare fid uuid; owner uuid;
begin
  fid := public.require_full_teacher();
  if p_user = auth.uid() then raise exception 'You can''t remove yourself.'; end if;
  select created_by into owner from public.families where id = fid;
  if p_user = owner then raise exception 'The teacher who started this homeschool can''t be removed.'; end if;
  delete from public.members where family_id = fid and user_id = p_user and role = 'teacher';
  if not found then raise exception 'That teacher wasn''t found.'; end if;
end $$;

revoke execute on function public.is_device_only(), public.require_full_teacher(), public.new_join_code(text), public.join_with_code(text),
  public.new_student_code(text), public.remove_child_devices(text), public.remove_student_devices(), public.can_use_ai(),
  public.family_teachers(), public.open_teacher_invites(), public.cancel_teacher_invites(), public.remove_teacher(uuid) from public, anon;
grant execute on function public.is_device_only(), public.new_join_code(text), public.join_with_code(text),
  public.new_student_code(text), public.remove_child_devices(text), public.remove_student_devices(), public.can_use_ai(),
  public.family_teachers(), public.open_teacher_invites(), public.cancel_teacher_invites(), public.remove_teacher(uuid) to authenticated;
