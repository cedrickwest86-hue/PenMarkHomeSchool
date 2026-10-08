-- Lesson plan Preparation and Procedure text is for teachers only.
-- A child's own device never receives it (the shared family tablet's screens don't show it either).
create or replace function public.child_view(d jsonb, sid text) returns jsonb
language sql immutable set search_path = public as $$
  select jsonb_build_object(
    'students', coalesce((select jsonb_agg(s) from jsonb_array_elements(coalesce(d->'students', '[]')) s where s->>'id' = sid), '[]'),
    'assignments', coalesce((select jsonb_agg(
        (a - 'keyAttachments' - 'aiReview' - 'tips' - 'prep' - 'procedure')
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

revoke execute on function public.child_view(jsonb, text) from public, anon, authenticated;
