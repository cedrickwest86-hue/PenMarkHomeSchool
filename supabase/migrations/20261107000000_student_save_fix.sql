-- Kids' devices: saving (checking off and turning in work) no longer fails when the family's data
-- has an empty or unexpected value somewhere (for example a list that is blank instead of empty).
-- Paste into Supabase → SQL Editor → Run. Safe to run again.

-- Treat anything that isn't a list as an empty list, and anything that isn't an object as an empty object
create or replace function public.js_arr(x jsonb) returns jsonb language sql immutable as $$
  select case when jsonb_typeof(x) = 'array' then x else '[]'::jsonb end $$;
create or replace function public.js_obj(x jsonb) returns jsonb language sql immutable as $$
  select case when jsonb_typeof(x) = 'object' then x else '{}'::jsonb end $$;

create or replace function public.child_view(d jsonb, sid text) returns jsonb
language sql immutable set search_path = public as $$
  select jsonb_build_object(
    'students', coalesce((select jsonb_agg(s) from jsonb_array_elements(js_arr(d->'students')) s where s->>'id' = sid), '[]'),
    'assignments', coalesce((select jsonb_agg(
        (a - 'keyAttachments' - 'aiReview' - 'tips' - 'prep' - 'procedure')
        || case when coalesce(a->>'status', '') = 'done' then '{}'::jsonb else jsonb_build_object('score', null) end)
      from jsonb_array_elements(js_arr(d->'assignments')) a where jsonb_typeof(a) = 'object' and a->>'studentId' = sid), '[]'),
    'events', coalesce((select jsonb_agg(e) from jsonb_array_elements(js_arr(d->'events')) e
      where jsonb_typeof(e) = 'object' and (jsonb_typeof(e->'studentIds') is distinct from 'array' or jsonb_array_length(e->'studentIds') = 0 or (e->'studentIds') ? sid)), '[]'),
    'readingLog', coalesce((select jsonb_agg(b) from jsonb_array_elements(js_arr(d->'readingLog')) b where jsonb_typeof(b) = 'object' and b->>'studentId' = sid), '[]'),
    'attendance', jsonb_build_object(sid, js_arr(js_obj(d->'attendance')->sid)),
    'redemptions', coalesce((select jsonb_agg(r) from jsonb_array_elements(js_arr(d->'redemptions')) r where jsonb_typeof(r) = 'object' and r->>'studentId' = sid), '[]'),
    'rewards', js_arr(d->'rewards'),
    'timers', coalesce((select jsonb_object_agg(t.key, t.value) from jsonb_each(js_obj(d->'timers')) t
      where exists (select 1 from jsonb_array_elements(js_arr(d->'assignments')) a where jsonb_typeof(a) = 'object' and a->>'id' = t.key and a->>'studentId' = sid)), '{}'),
    'settings', js_obj(d->'settings') - 'pin',
    'checklist', '{}'::jsonb, 'transcripts', '{}'::jsonb)
$$;
revoke execute on function public.child_view(jsonb, text) from public, anon, authenticated;

create or replace function public.student_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare m record; d jsonb; sid text; mine jsonb; a jsonb; c jsonb; out_a jsonb := '[]'; ids text[]; t jsonb := '{}';
begin
  select * into m from public.members where user_id = auth.uid() and student_id is not null;
  if not found then raise exception 'This device isn''t connected to a student'; end if;
  sid := m.student_id;
  if exists (select 1 from pg_proc where proname = 'family_access') then  -- only after the billing update
    if public.family_access(m.family_id) <> 'full' then raise exception 'READ_ONLY: School is read-only right now.'; end if;
  end if;
  select value::jsonb into d from public.kv where family_id = m.family_id and key = 'hs-tracker:data' for update;
  if d is null then raise exception 'Nothing to save yet'; end if;
  p := js_obj(p);
  -- This child's changes, by assignment id (entries without an id are ignored)
  mine := coalesce((select jsonb_object_agg(x->>'id', x) from jsonb_array_elements(js_arr(p->'assignments')) x
                    where jsonb_typeof(x) = 'object' and coalesce(x->>'id', '') <> ''), '{}');
  for a in select * from jsonb_array_elements(js_arr(d->'assignments')) loop
    c := case when jsonb_typeof(a) = 'object' then mine->(a->>'id') else null end;
    if c is not null and a->>'studentId' = sid then
      if coalesce(a->>'status', 'todo') <> 'done' and c->>'status' in ('todo', 'submitted') then
        a := a || jsonb_build_object('status', c->>'status', 'finishedOn', c->'finishedOn');
      end if;
      if jsonb_typeof(c->'attachments') = 'array' then
        -- Keep files already on this assignment; accept new ones only if no other assignment uses them
        a := a || jsonb_build_object('attachments', (
          select coalesce(jsonb_agg(x), '[]') from jsonb_array_elements(c->'attachments') x
          where jsonb_typeof(x) = 'object' and x->>'key' like 'hs-file:%' and (
            exists (select 1 from jsonb_array_elements(js_arr(a->'attachments')) o where o->>'key' = x->>'key')
            or not exists (
              select 1 from jsonb_array_elements(js_arr(d->'assignments')) oa
              cross join lateral jsonb_array_elements(js_arr(case when jsonb_typeof(oa) = 'object' then oa->'attachments' end)) other_file
              where oa->>'id' is distinct from a->>'id' and other_file->>'key' = x->>'key'))));
      end if;
      if jsonb_typeof(c->'minutes') = 'number' then a := a || jsonb_build_object('minutes', least(greatest((c->>'minutes')::numeric, 0), 6000)); end if;
      if jsonb_typeof(c->'practiceLog') = 'array' then a := a || jsonb_build_object('practiceLog', c->'practiceLog'); end if;
    end if;
    out_a := out_a || jsonb_build_array(a);
  end loop;
  d := jsonb_set(d, '{assignments}', out_a);
  -- Their books replace only their own entries
  d := jsonb_set(d, '{readingLog}',
    coalesce((select jsonb_agg(b) from jsonb_array_elements(js_arr(d->'readingLog')) b where jsonb_typeof(b) <> 'object' or b->>'studentId' is distinct from sid), '[]')
    || coalesce((select jsonb_agg(b || jsonb_build_object('studentId', sid)) from jsonb_array_elements(js_arr(p->'readingLog')) b where jsonb_typeof(b) = 'object'), '[]'));
  -- Timers: only for their own assignments
  select array_agg(x->>'id') into ids from jsonb_array_elements(out_a) x where jsonb_typeof(x) = 'object' and x->>'studentId' = sid;
  t := coalesce((select jsonb_object_agg(k.key, k.value) from jsonb_each(js_obj(d->'timers')) k where not (k.key = any(coalesce(ids, '{}')))), '{}')
    || coalesce((select jsonb_object_agg(k.key, k.value) from jsonb_each(js_obj(p->'timers')) k where k.key = any(coalesce(ids, '{}'))), '{}');
  d := jsonb_set(d, '{timers}', t);
  update public.kv set value = d::text, version = version + 1, updated_at = now() where family_id = m.family_id and key = 'hs-tracker:data';
  return public.child_view(d, sid);
end $$;
revoke execute on function public.student_save(jsonb) from public, anon;
grant execute on function public.student_save(jsonb) to authenticated;

-- The view for a child's device uses the same safe version
create or replace function public.student_view() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare m record; d jsonb;
begin
  select * into m from public.members where user_id = auth.uid() and student_id is not null;
  if not found then return null; end if;
  if exists (select 1 from pg_proc where proname = 'family_access') then
    if public.family_access(m.family_id) = 'locked' then raise exception 'LOCKED: School is paused. Ask your teacher.'; end if;
  end if;
  select value::jsonb into d from public.kv where family_id = m.family_id and key = 'hs-tracker:data';
  return public.child_view(coalesce(d, '{}'), m.student_id);
end $$;
revoke execute on function public.student_view() from public, anon;
grant execute on function public.student_view() to authenticated;
