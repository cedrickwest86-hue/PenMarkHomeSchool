-- Per-child device codes.
-- A device connected with a child's own code only ever receives that child's information:
-- the database filters it, so siblings' work, grades, and photos never reach that device.
-- (The older "shared family tablet" code still works and shows every child.)

alter table public.members add column if not exists student_id text;

create table if not exists public.student_codes (
  code_hash text primary key,
  family_id uuid not null references public.families(id) on delete cascade,
  student_id text not null,
  created_at timestamptz not null default now()
);
create unique index if not exists student_codes_one_per_child on public.student_codes (family_id, student_id);
alter table public.student_codes enable row level security;  -- only reachable through the functions below
revoke all on public.student_codes from anon, authenticated;

-- Which child this account is limited to (null = the whole family)
create or replace function public.my_scope(fid uuid) returns text
language sql stable security definer set search_path = public as $$
  select student_id from public.members where family_id = fid and user_id = auth.uid()
$$;

-- Return type changes, so replace the function
drop function if exists public.my_membership();
create function public.my_membership() returns table(family_id uuid, role text, family_name text, student_id text)
language sql stable security definer set search_path = public as $$
  select m.family_id, m.role, f.name, m.student_id from public.members m join public.families f on f.id = m.family_id
  where m.user_id = auth.uid() limit 1
$$;

-- Child-only devices can't read or write the family's full data directly
drop policy if exists "kv read" on public.kv;
drop policy if exists "kv insert" on public.kv;
drop policy if exists "kv update" on public.kv;
create policy "kv read" on public.kv for select to authenticated
  using (public.my_role(family_id) is not null and public.my_scope(family_id) is null);
create policy "kv insert" on public.kv for insert to authenticated
  with check (public.my_role(family_id) is not null and public.my_scope(family_id) is null);
create policy "kv update" on public.kv for update to authenticated
  using (public.my_role(family_id) is not null and public.my_scope(family_id) is null)
  with check (public.my_role(family_id) is not null and public.my_scope(family_id) is null);

-- Teacher makes (or remakes) a child's code. Remaking retires the old code; devices already connected stay connected.
create or replace function public.new_student_code(p_student text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare fid uuid; raw text := ''; alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; i int; d jsonb;
begin
  select family_id into fid from public.members where user_id = auth.uid() and role = 'teacher';
  if fid is null then raise exception 'Only a teacher can make codes'; end if;
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

-- Which children have a code and how many devices each has connected
create or replace function public.student_devices() returns table(student_id text, has_code boolean, devices integer)
language sql stable security definer set search_path = public as $$
  with fam as (select family_id from public.members where user_id = auth.uid() and role = 'teacher'),
  ids as (
    select c.student_id from public.student_codes c join fam on fam.family_id = c.family_id
    union select m.student_id from public.members m join fam on fam.family_id = m.family_id where m.student_id is not null)
  select ids.student_id,
    exists (select 1 from public.student_codes c join fam on fam.family_id = c.family_id where c.student_id = ids.student_id),
    (select count(*)::int from public.members m join fam on fam.family_id = m.family_id where m.student_id = ids.student_id)
  from ids
$$;

-- Disconnect one child's devices and retire their code
create or replace function public.remove_child_devices(p_student text) returns integer
language plpgsql security definer set search_path = public as $$
declare fid uuid; n integer;
begin
  select family_id into fid from public.members where user_id = auth.uid() and role = 'teacher';
  if fid is null then raise exception 'Only a teacher can do this'; end if;
  delete from public.members where family_id = fid and student_id = p_student;
  get diagnostics n = row_count;
  delete from public.student_codes where family_id = fid and student_id = p_student;
  return n;
end $$;

-- Joining now also accepts a child's own code
create or replace function public.join_with_code(p_code text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare h text; fid uuid; r text; sid text;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  h := encode(digest(upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')), 'sha256'), 'hex');
  select family_id, student_id, 'student' into fid, sid, r from public.student_codes where code_hash = h;
  if fid is null then select id, 'student' into fid, r from public.families where student_code_hash = h; end if;
  if fid is null then select id, 'teacher' into fid, r from public.families where teacher_code_hash = h; end if;
  if fid is null then raise exception 'That code didn''t match. Check it and try again.'; end if;
  if r = 'teacher' and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception 'Sign in with your own email to join as a teacher';
  end if;
  if exists (select 1 from public.members where user_id = auth.uid()) then
    raise exception 'This device or account is already connected to a family';
  end if;
  insert into public.members (family_id, user_id, role, student_id) values (fid, auth.uid(), r, sid);
  return r;
end $$;

-- What a child-only device is allowed to see: their own work, events, books, and stars. No grades until checked,
-- no answer keys, no teacher notes from the AI, no PIN, no other children.
create or replace function public.child_view(d jsonb, sid text) returns jsonb
language sql immutable set search_path = public as $$
  select jsonb_build_object(
    'students', coalesce((select jsonb_agg(s) from jsonb_array_elements(coalesce(d->'students', '[]')) s where s->>'id' = sid), '[]'),
    'assignments', coalesce((select jsonb_agg(
        (a - 'keyAttachments' - 'aiReview' - 'tips')
        || case when coalesce(a->>'status', '') = 'done' then '{}'::jsonb else jsonb_build_object('score', null) end)
      from jsonb_array_elements(coalesce(d->'assignments', '[]')) a where a->>'studentId' = sid), '[]'),
    'events', coalesce((select jsonb_agg(e) from jsonb_array_elements(coalesce(d->'events', '[]')) e
      where jsonb_typeof(e->'studentIds') is distinct from 'array' or jsonb_array_length(e->'studentIds') = 0 or (e->'studentIds') ? sid), '[]'),
    'readingLog', coalesce((select jsonb_agg(b) from jsonb_array_elements(coalesce(d->'readingLog', '[]')) b where b->>'studentId' = sid), '[]'),
    'attendance', jsonb_build_object(sid, coalesce(d->'attendance'->sid, '[]')),
    'redemptions', coalesce((select jsonb_agg(r) from jsonb_array_elements(coalesce(d->'redemptions', '[]')) r where r->>'studentId' = sid), '[]'),
    'rewards', coalesce(d->'rewards', '[]'),
    'timers', coalesce((select jsonb_object_agg(t.key, t.value) from jsonb_each(coalesce(d->'timers', '{}')) t
      where exists (select 1 from jsonb_array_elements(coalesce(d->'assignments', '[]')) a where a->>'id' = t.key and a->>'studentId' = sid)), '{}'),
    'settings', coalesce(d->'settings', '{}') - 'pin',
    'checklist', '{}'::jsonb, 'transcripts', '{}'::jsonb)
$$;

create or replace function public.student_view() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare m record; d jsonb;
begin
  select * into m from public.members where user_id = auth.uid() and student_id is not null;
  if not found then return null; end if;
  select value::jsonb into d from public.kv where family_id = m.family_id and key = 'hs-tracker:data';
  return public.child_view(coalesce(d, '{}'), m.student_id);
end $$;

-- A child-only device saves its changes here. Only what a child can do is accepted:
-- turning work in (or taking it back), attaching photos, timer minutes, practice scores, and their own book list.
create or replace function public.student_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare m record; d jsonb; sid text; mine jsonb; a jsonb; c jsonb; out_a jsonb := '[]'; ids text[]; t jsonb := '{}';
begin
  select * into m from public.members where user_id = auth.uid() and student_id is not null;
  if not found then raise exception 'This device isn''t connected to a student'; end if;
  sid := m.student_id;
  select value::jsonb into d from public.kv where family_id = m.family_id and key = 'hs-tracker:data' for update;
  if d is null then raise exception 'Nothing to save yet'; end if;
  mine := coalesce((select jsonb_object_agg(x->>'id', x) from jsonb_array_elements(coalesce(p->'assignments', '[]')) x), '{}');
  for a in select * from jsonb_array_elements(coalesce(d->'assignments', '[]')) loop
    c := mine->(a->>'id');
    if a->>'studentId' = sid and c is not null then
      if coalesce(a->>'status', 'todo') <> 'done' and c->>'status' in ('todo', 'submitted') then
        a := a || jsonb_build_object('status', c->>'status', 'finishedOn', c->'finishedOn');
      end if;
      if jsonb_typeof(c->'attachments') = 'array' then
        -- Keep files already on this assignment; accept new ones only if no other assignment uses them
        a := a || jsonb_build_object('attachments', (select coalesce(jsonb_agg(x), '[]') from jsonb_array_elements(c->'attachments') x
          where x->>'key' like 'hs-file:%' and (
            exists (select 1 from jsonb_array_elements(coalesce(a->'attachments', '[]')) o where o->>'key' = x->>'key')
            or not exists (select 1 from jsonb_array_elements(coalesce(d->'assignments', '[]')) oa, jsonb_array_elements(coalesce(oa->'attachments', '[]')) of
                           where oa->>'id' <> a->>'id' and of->>'key' = x->>'key'))));
      end if;
      if jsonb_typeof(c->'minutes') = 'number' then a := a || jsonb_build_object('minutes', least(greatest((c->>'minutes')::numeric, 0), 6000)); end if;
      if jsonb_typeof(c->'practiceLog') = 'array' then a := a || jsonb_build_object('practiceLog', c->'practiceLog'); end if;
    end if;
    out_a := out_a || jsonb_build_array(a);
  end loop;
  d := jsonb_set(d, '{assignments}', out_a);
  -- Their books replace only their own entries
  d := jsonb_set(d, '{readingLog}',
    coalesce((select jsonb_agg(b) from jsonb_array_elements(coalesce(d->'readingLog', '[]')) b where b->>'studentId' is distinct from sid), '[]')
    || coalesce((select jsonb_agg(b || jsonb_build_object('studentId', sid)) from jsonb_array_elements(coalesce(p->'readingLog', '[]')) b), '[]'));
  -- Timers: only for their own assignments
  select array_agg(x->>'id') into ids from jsonb_array_elements(out_a) x where x->>'studentId' = sid;
  t := coalesce((select jsonb_object_agg(k.key, k.value) from jsonb_each(coalesce(d->'timers', '{}')) k where not (k.key = any(coalesce(ids, '{}')))), '{}')
    || coalesce((select jsonb_object_agg(k.key, k.value) from jsonb_each(coalesce(p->'timers', '{}')) k where k.key = any(coalesce(ids, '{}'))), '{}');
  d := jsonb_set(d, '{timers}', t);
  update public.kv set value = d::text, version = version + 1, updated_at = now() where family_id = m.family_id and key = 'hs-tracker:data';
  return public.child_view(d, sid);
end $$;

-- Photos: a child-only device can upload its own work photos, but can only open files on its own assignments
create or replace function public.file_role(obj_name text) returns text
language plpgsql stable security definer set search_path = public as $$
declare parts text[] := storage.foldername(obj_name); fid uuid; r text; sid text; fname text; d jsonb;
begin
  if coalesce(array_length(parts, 1), 0) < 2 or parts[1] !~ '^[0-9a-f-]{36}$' then return null; end if;
  fid := parts[1]::uuid;
  select role, student_id into r, sid from public.members where family_id = fid and user_id = auth.uid();
  if r is null or sid is null then return r; end if;
  fname := regexp_replace(storage.filename(obj_name), '\.json$', '');
  select value::jsonb into d from public.kv where family_id = fid and key = 'hs-tracker:data';
  if exists (select 1 from jsonb_array_elements(coalesce(d->'assignments', '[]')) a, jsonb_array_elements(coalesce(a->'attachments', '[]')) f
             where a->>'studentId' = sid and regexp_replace(f->>'key', '[^A-Za-z0-9_-]', '_', 'g') = fname) then
    return r;
  end if;
  return 'child-upload';  -- may add a new photo, but not read others
end $$;

drop policy if exists "family files change" on storage.objects;
create policy "family files change" on storage.objects for update to authenticated using (
  bucket_id = 'family-files' and (
    ((storage.foldername(name))[2] = 'files' and public.file_role(name) in ('teacher', 'student'))
    or ((storage.foldername(name))[2] = 'keys' and public.file_role(name) = 'teacher')));
drop policy if exists "family files read" on storage.objects;
create policy "family files read" on storage.objects for select to authenticated using (
  bucket_id = 'family-files' and (
    ((storage.foldername(name))[2] = 'files' and public.file_role(name) in ('teacher', 'student'))
    or ((storage.foldername(name))[2] = 'keys' and public.file_role(name) = 'teacher')));

revoke execute on function public.my_scope(uuid), public.my_membership(), public.new_student_code(text), public.student_devices(),
  public.remove_child_devices(text), public.join_with_code(text), public.student_view(), public.student_save(jsonb), public.child_view(jsonb, text) from public, anon;
grant execute on function public.my_scope(uuid), public.my_membership(), public.new_student_code(text), public.student_devices(),
  public.remove_child_devices(text), public.join_with_code(text), public.student_view(), public.student_save(jsonb) to authenticated;

-- "Disconnect all" also retires every child's own code
create or replace function public.remove_student_devices() returns integer
language plpgsql security definer set search_path = public as $$
declare fid uuid; n integer;
begin
  select family_id into fid from public.members where user_id = auth.uid() and role = 'teacher';
  if fid is null then raise exception 'Only a teacher can do this'; end if;
  delete from public.members where family_id = fid and role = 'student';
  get diagnostics n = row_count;
  update public.families set student_code_hash = null where id = fid;
  delete from public.student_codes where family_id = fid;
  return n;
end $$;
