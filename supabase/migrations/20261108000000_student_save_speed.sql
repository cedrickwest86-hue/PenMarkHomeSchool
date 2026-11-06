-- Kids' devices: checking off and turning in work is now fast for large families.
-- The previous version rebuilt the whole assignment list one item at a time, which took longer than
-- Supabase's 8-second limit once a family had a few thousand assignments, so saves were canceled
-- and the tablet showed "Offline". Paste into Supabase → SQL Editor → Run. Safe to run again.

create or replace function public.js_arr(x jsonb) returns jsonb language sql immutable as $$
  select case when jsonb_typeof(x) = 'array' then x else '[]'::jsonb end $$;
create or replace function public.js_obj(x jsonb) returns jsonb language sql immutable as $$
  select case when jsonb_typeof(x) = 'object' then x else '{}'::jsonb end $$;

-- Apply one child's change (c) to one assignment (a). used = { file key: assignment id that already has it }
create or replace function public.student_patch(a jsonb, c jsonb, sid text, used jsonb) returns jsonb
language plpgsql immutable set search_path = public as $$
begin
  if c is null or jsonb_typeof(a) <> 'object' or a->>'studentId' is distinct from sid then return a; end if;
  if coalesce(a->>'status', 'todo') <> 'done' and c->>'status' in ('todo', 'submitted') then
    a := a || jsonb_build_object('status', c->>'status', 'finishedOn', c->'finishedOn');
  end if;
  if jsonb_typeof(c->'attachments') = 'array' then
    -- Keep files already on this assignment; accept new ones only if no other assignment uses them
    a := a || jsonb_build_object('attachments', (
      select coalesce(jsonb_agg(x), '[]') from jsonb_array_elements(c->'attachments') x
      where jsonb_typeof(x) = 'object' and x->>'key' like 'hs-file:%'
        and (exists (select 1 from jsonb_array_elements(js_arr(a->'attachments')) o where o->>'key' = x->>'key')
             or used->>(x->>'key') is null or used->>(x->>'key') = a->>'id')));
  end if;
  if jsonb_typeof(c->'minutes') = 'number' then a := a || jsonb_build_object('minutes', least(greatest((c->>'minutes')::numeric, 0), 6000)); end if;
  if jsonb_typeof(c->'practiceLog') = 'array' then a := a || jsonb_build_object('practiceLog', c->'practiceLog'); end if;
  return a;
end $$;
revoke execute on function public.student_patch(jsonb, jsonb, text, jsonb) from public, anon, authenticated;

create or replace function public.student_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare m record; d jsonb; sid text; mine jsonb; sent_keys text[]; used jsonb; out_a jsonb; ids text[]; t jsonb;
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
  -- Which assignment already holds each file the child sent (looked up once, not per assignment)
  select array_agg(distinct f->>'key') into sent_keys
    from jsonb_each(mine) e cross join lateral jsonb_array_elements(js_arr(e.value->'attachments')) f where jsonb_typeof(f) = 'object';
  used := '{}';
  if sent_keys is not null then
    used := coalesce((select jsonb_object_agg(f->>'key', a->>'id')
      from jsonb_array_elements(js_arr(d->'assignments')) a
      cross join lateral jsonb_array_elements(js_arr(case when jsonb_typeof(a) = 'object' then a->'attachments' end)) f
      where f->>'key' = any(sent_keys)), '{}');
  end if;

  -- One pass over the assignments, keeping their order
  select coalesce(jsonb_agg(public.student_patch(a, case when jsonb_typeof(a) = 'object' then mine->(a->>'id') end, sid, used) order by n), '[]')
    into out_a from jsonb_array_elements(js_arr(d->'assignments')) with ordinality as x(a, n);
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
