-- Calendar subscription links (iPhone/iPad Calendar, Google Calendar, Outlook).
-- Each link has a long random code. It shares only what a calendar needs: names, lesson titles,
-- dates, and events. Never grades, notes, answer keys, photos, or anything else.

create table if not exists public.calendar_feeds (
  token text primary key,
  family_id uuid not null references public.families(id) on delete cascade,
  student_id text,                                   -- null = the whole family (for the teacher)
  created_at timestamptz not null default now()
);
create unique index if not exists calendar_feeds_one_per_scope on public.calendar_feeds (family_id, coalesce(student_id, ''));
alter table public.calendar_feeds enable row level security;  -- no direct access; only the functions below
revoke all on public.calendar_feeds from anon, authenticated;

-- Teacher makes (or remakes) a link. Remaking retires the old link.
create or replace function public.create_calendar_feed(p_student text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare fid uuid; tok text;
begin
  select family_id into fid from public.members where user_id = auth.uid() and role = 'teacher';
  if fid is null then raise exception 'Only a teacher can make calendar links'; end if;
  delete from public.calendar_feeds where family_id = fid and coalesce(student_id, '') = coalesce(nullif(p_student, ''), '');
  tok := encode(gen_random_bytes(24), 'hex');
  insert into public.calendar_feeds (token, family_id, student_id) values (tok, fid, nullif(p_student, ''));
  return tok;
end $$;

create or replace function public.list_calendar_feeds() returns table(student_id text, token text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select c.student_id, c.token, c.created_at
  from public.calendar_feeds c join public.members m on m.family_id = c.family_id
  where m.user_id = auth.uid() and m.role = 'teacher'
$$;

create or replace function public.revoke_calendar_feed(p_student text) returns void
language plpgsql security definer set search_path = public as $$
declare fid uuid;
begin
  select family_id into fid from public.members where user_id = auth.uid() and role = 'teacher';
  if fid is null then raise exception 'Only a teacher can turn off calendar links'; end if;
  delete from public.calendar_feeds where family_id = fid and coalesce(student_id, '') = coalesce(nullif(p_student, ''), '');
end $$;

-- What a calendar app receives (called by the Cloudflare worker with the link's code).
-- Unfinished work from a week ago through about four months ahead, plus calendar events.
create or replace function public.calendar_feed(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare f record; d jsonb; sid text; fam text;
begin
  select * into f from public.calendar_feeds where token = p_token;
  if not found then return null; end if;
  sid := f.student_id;
  select name into fam from public.families where id = f.family_id;
  select value::jsonb into d from public.kv where family_id = f.family_id and key = 'hs-tracker:data';
  d := coalesce(d, '{}'::jsonb);
  return jsonb_build_object(
    'family', fam,
    'studentId', sid,
    'students', coalesce((
      select jsonb_agg(jsonb_build_object('id', s->>'id', 'name', s->>'name'))
      from jsonb_array_elements(coalesce(d->'students', '[]'::jsonb)) s
      where sid is null or s->>'id' = sid), '[]'::jsonb),
    'assignments', coalesce((
      select jsonb_agg(jsonb_build_object('id', a->>'id', 'studentId', a->>'studentId', 'subject', a->>'subject',
        'lesson', a->'lesson', 'type', a->>'type', 'title', a->>'title', 'due', a->>'due', 'dueBy', a->>'dueBy', 'status', a->>'status'))
      from jsonb_array_elements(coalesce(d->'assignments', '[]'::jsonb)) a
      where (sid is null or a->>'studentId' = sid)
        and coalesce(a->>'status', 'todo') <> 'done'
        and greatest(a->>'due', coalesce(a->>'dueBy', '')) >= to_char(current_date - 7, 'YYYY-MM-DD')
        and a->>'due' <= to_char(current_date + 120, 'YYYY-MM-DD')), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object('id', e->>'id', 'title', e->>'title', 'kind', e->>'kind', 'date', e->>'date',
        'endDate', e->>'endDate', 'time', e->>'time', 'repeatWeekly', e->'repeatWeekly', 'until', e->>'until',
        'minutes', e->'minutes', 'noLessons', e->'noLessons', 'studentIds', e->'studentIds'))
      from jsonb_array_elements(coalesce(d->'events', '[]'::jsonb)) e
      where sid is null
        or jsonb_typeof(e->'studentIds') is distinct from 'array'
        or jsonb_array_length(e->'studentIds') = 0
        or (e->'studentIds') ? sid), '[]'::jsonb)
  );
end $$;

revoke execute on function public.create_calendar_feed(text), public.list_calendar_feeds(), public.revoke_calendar_feed(text) from public, anon;
grant execute on function public.create_calendar_feed(text), public.list_calendar_feeds(), public.revoke_calendar_feed(text) to authenticated;
revoke execute on function public.calendar_feed(text) from public;
grant execute on function public.calendar_feed(text) to anon, authenticated;
