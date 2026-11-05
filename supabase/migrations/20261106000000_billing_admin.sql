-- Plans and billing, read-only and locked accounts, AI usage limits, the admin portal, support messages,
-- error reports, and activity details for calendar feeds.
-- Paste into Supabase → SQL Editor → Run. Safe to run again.
--
-- How access works:
--   trial (14 days, no card) → full access, including AI
--   Essentials / Plus (paid)  → full access (AI only on Plus)
--   card fails ("past due")   → full access while Stripe retries
--   canceled                  → full access until the end of the time they paid for, then
--                               10 days READ-ONLY (download records, print reports), then LOCKED.
--                               Data is kept 12 more months, then deleted. Re-subscribing restores everything.
--   trial ends without a plan → 10 days read-only, then locked, same 12 months.
--   comp                      → free accounts you choose (your family, beta testers)

-- ---------- family plan columns ----------
do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'families' and column_name = 'status') then
    alter table public.families
      add column status text not null default 'trialing',
      add column plan text not null default 'trial',
      add column trial_ends_at timestamptz default now() + interval '14 days';
    -- Families that already exist (you and your beta testers) become free "comp" accounts.
    -- Plus if you had switched AI on for them, Essentials otherwise.
    update public.families set status = 'comp', trial_ends_at = null,
      plan = case when coalesce(ai_enabled, false) then 'plus' else 'essentials' end;
  end if;
end $$;

alter table public.families
  add column if not exists current_period_end timestamptz,
  add column if not exists cancel_at timestamptz,
  add column if not exists grace_until timestamptz,
  add column if not exists delete_after timestamptz,
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text,
  add column if not exists price_cents integer,
  add column if not exists billing_interval text,
  add column if not exists ai_blocked boolean not null default false,
  add column if not exists ai_cap_cents integer,
  add column if not exists last_seen timestamptz,
  add column if not exists trial_warned_at timestamptz,
  add column if not exists delete_warned_at timestamptz;

alter table public.families drop constraint if exists families_status_check;
alter table public.families add constraint families_status_check check (status in ('trialing', 'active', 'past_due', 'canceled', 'comp'));
alter table public.families drop constraint if exists families_plan_check;
alter table public.families add constraint families_plan_check check (plan in ('trial', 'essentials', 'plus'));
create unique index if not exists families_stripe_customer on public.families(stripe_customer_id) where stripe_customer_id is not null;

-- Families can't change their own plan columns; only these functions (and you, in the Table Editor) can.
revoke update on public.families from authenticated;
revoke insert, delete on public.families from authenticated;

-- ---------- access level ----------
create or replace function public.family_access(fid uuid) returns text
language sql stable security definer set search_path = public as $$
  select case
    when f.id is null then 'locked'
    when f.status in ('comp', 'active', 'past_due') then 'full'
    when f.status = 'trialing' and coalesce(f.trial_ends_at, now() + interval '1 day') > now() then 'full'
    when f.status = 'trialing' and f.trial_ends_at + interval '10 days' > now() then 'readonly'
    when f.status = 'canceled' and coalesce(f.grace_until, now()) > now() then 'readonly'
    else 'locked' end
  from (select 1) one left join public.families f on f.id = fid
$$;

-- When a family's data will be deleted if they don't come back
create or replace function public.family_delete_after(f public.families) returns timestamptz
language sql stable set search_path = public as $$
  select case
    when f.status = 'canceled' then coalesce(f.delete_after, coalesce(f.grace_until, now()) + interval '12 months')
    when f.status = 'trialing' and f.trial_ends_at is not null then f.trial_ends_at + interval '10 days' + interval '12 months'
    else null end
$$;

-- AI: Plus plans and trials, within a monthly limit, never on a device-only login or a blocked family
create table if not exists public.ai_usage (
  id bigserial primary key,
  family_id uuid not null references public.families(id) on delete cascade,
  user_id uuid,
  at timestamptz not null default now(),
  model text,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cost_cents numeric(10, 4) not null default 0
);
create index if not exists ai_usage_family_month on public.ai_usage(family_id, at);
alter table public.ai_usage enable row level security;
revoke all on public.ai_usage from anon, authenticated;

create or replace function public.ai_cap(f public.families) returns integer
language sql stable set search_path = public as $$
  -- Monthly AI limit in cents. Plus: $6 (about 150 lesson-plan pages). Trial: $1.50. Change per family with ai_cap_cents.
  select coalesce(f.ai_cap_cents, case when f.status = 'trialing' then 150 else 600 end)
$$;

create or replace function public.ai_used_cents(fid uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(cost_cents), 0) from public.ai_usage where family_id = fid and at >= date_trunc('month', now())
$$;

-- What the AI worker asks before each request
create or replace function public.ai_gate() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare m record; f public.families;
begin
  select * into m from public.members where user_id = auth.uid() and role = 'teacher' and student_id is null;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_teacher'); end if;
  if public.is_device_only() then return jsonb_build_object('ok', false, 'reason', 'device_only'); end if;
  select * into f from public.families where id = m.family_id;
  if public.family_access(f.id) <> 'full' then return jsonb_build_object('ok', false, 'reason', 'ended'); end if;
  if f.ai_blocked then return jsonb_build_object('ok', false, 'reason', 'blocked'); end if;
  if not (f.plan = 'plus' or f.status = 'trialing') then return jsonb_build_object('ok', false, 'reason', 'plan'); end if;
  if public.ai_used_cents(f.id) >= public.ai_cap(f) then return jsonb_build_object('ok', false, 'reason', 'limit'); end if;
  return jsonb_build_object('ok', true, 'family_id', f.id);
end $$;

create or replace function public.can_use_ai() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((public.ai_gate() ->> 'ok')::boolean, false)
$$;

-- ---------- everything the app needs to know about the account ----------
create table if not exists public.admins (user_id uuid primary key references auth.users(id) on delete cascade);
alter table public.admins enable row level security;
revoke all on public.admins from anon, authenticated;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid()) and not public.is_device_only()
$$;

create or replace function public.my_account() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare m record; f public.families;
begin
  select * into m from public.members where user_id = auth.uid();
  if not found then return jsonb_build_object('is_admin', public.is_admin()); end if;
  select * into f from public.families where id = m.family_id;
  return jsonb_build_object(
    'access', public.family_access(f.id),
    'status', f.status, 'plan', f.plan,
    'trial_ends_at', f.trial_ends_at, 'current_period_end', f.current_period_end, 'cancel_at', f.cancel_at,
    'grace_until', case when f.status = 'trialing' then f.trial_ends_at + interval '10 days' else f.grace_until end,
    'delete_after', public.family_delete_after(f),
    'interval', f.billing_interval, 'price_cents', f.price_cents,
    'has_billing', f.stripe_customer_id is not null,
    'is_owner', f.created_by = auth.uid(),
    'is_admin', public.is_admin(),
    'ai_ok', case when m.role = 'teacher' then coalesce((public.ai_gate() ->> 'ok')::boolean, false) else false end,
    'ai_reason', case when m.role = 'teacher' then public.ai_gate() ->> 'reason' else null end,
    'ai_used_cents', case when m.role = 'teacher' then round(public.ai_used_cents(f.id)) else null end,
    'ai_cap_cents', case when m.role = 'teacher' then public.ai_cap(f) else null end);
end $$;

-- Teachers' visits, for the admin portal's "last active" column
create or replace function public.touch_seen() returns void
language sql security definer set search_path = public as $$
  update public.families set last_seen = now()
  where id = (select family_id from public.members where user_id = auth.uid() and role = 'teacher')
    and (last_seen is null or last_seen < now() - interval '10 minutes')
$$;

-- ---------- enforce read-only and locked ----------
drop policy if exists "kv read" on public.kv;
drop policy if exists "kv insert" on public.kv;
drop policy if exists "kv update" on public.kv;
create policy "kv read" on public.kv for select to authenticated
  using (public.my_role(family_id) is not null and public.my_scope(family_id) is null and public.family_access(family_id) <> 'locked');
create policy "kv insert" on public.kv for insert to authenticated
  with check (public.my_role(family_id) is not null and public.my_scope(family_id) is null and public.family_access(family_id) = 'full');
create policy "kv update" on public.kv for update to authenticated
  using (public.my_role(family_id) is not null and public.my_scope(family_id) is null and public.family_access(family_id) = 'full')
  with check (public.my_role(family_id) is not null and public.my_scope(family_id) is null and public.family_access(family_id) = 'full');

create or replace function public.kv_put(p_family uuid, p_key text, p_value text, p_expected bigint)
returns table(ok boolean, new_version bigint, current_value text)
language plpgsql security invoker set search_path = public as $$
declare v bigint;
begin
  if public.family_access(p_family) <> 'full' then
    raise exception 'READ_ONLY: This account is read-only. Choose a plan to keep making changes.';
  end if;
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

-- Child devices: nothing when locked, no saving unless full
create or replace function public.student_view() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare m record; d jsonb;
begin
  select * into m from public.members where user_id = auth.uid() and student_id is not null;
  if not found then return null; end if;
  if public.family_access(m.family_id) = 'locked' then raise exception 'LOCKED: School is paused. Ask your teacher.'; end if;
  select value::jsonb into d from public.kv where family_id = m.family_id and key = 'hs-tracker:data';
  return public.child_view(coalesce(d, '{}'), m.student_id);
end $$;

do $$
declare body text;
begin
  -- Add a "full access" check to the start of student_save without retyping the whole function
  select pg_get_functiondef('public.student_save(jsonb)'::regprocedure) into body;
  if body not like '%READ_ONLY%' then
    body := replace(body, 'sid := m.student_id;',
      'sid := m.student_id;' || chr(10) || '  if public.family_access(m.family_id) <> ''full'' then raise exception ''READ_ONLY: School is read-only right now.''; end if;');
    execute body;
  end if;
end $$;

-- Files: readable unless locked; adding, replacing, or removing needs full access
create or replace function public.file_access(obj_name text) returns text
language plpgsql stable security definer set search_path = public as $$
declare parts text[] := storage.foldername(obj_name);
begin
  if coalesce(array_length(parts, 1), 0) < 2 or parts[1] !~ '^[0-9a-f-]{36}$' then return 'locked'; end if;
  return public.family_access(parts[1]::uuid);
end $$;
grant execute on function public.file_access(text) to authenticated;

drop policy if exists "family files read" on storage.objects;
drop policy if exists "family files add" on storage.objects;
drop policy if exists "family files change" on storage.objects;
drop policy if exists "family files remove" on storage.objects;
create policy "family files read" on storage.objects for select to authenticated using (
  bucket_id = 'family-files' and public.file_access(name) <> 'locked' and (
    ((storage.foldername(name))[2] = 'files' and public.file_role(name) in ('teacher', 'student'))
    or ((storage.foldername(name))[2] = 'keys' and public.file_role(name) = 'teacher')));
create policy "family files add" on storage.objects for insert to authenticated with check (
  bucket_id = 'family-files' and public.file_access(name) = 'full' and (
    ((storage.foldername(name))[2] = 'files' and public.file_role(name) is not null)
    or ((storage.foldername(name))[2] = 'keys' and public.file_role(name) = 'teacher')));
create policy "family files change" on storage.objects for update to authenticated using (
  bucket_id = 'family-files' and public.file_access(name) = 'full' and (
    ((storage.foldername(name))[2] = 'files' and public.file_role(name) in ('teacher', 'student'))
    or ((storage.foldername(name))[2] = 'keys' and public.file_role(name) = 'teacher')));
create policy "family files remove" on storage.objects for delete to authenticated using (
  bucket_id = 'family-files' and public.file_access(name) = 'full' and public.file_role(name) = 'teacher');

-- Calendar feeds stop when locked, and now carry activity details (weekdays, place, reminder)
create or replace function public.calendar_feed(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare f record; d jsonb; sid text; fam text;
begin
  select * into f from public.calendar_feeds where token = p_token;
  if not found then return null; end if;
  if public.family_access(f.family_id) = 'locked' then return null; end if;
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
        'minutes', e->'minutes', 'noLessons', e->'noLessons', 'studentIds', e->'studentIds',
        'days', e->'days', 'place', e->>'place', 'remind', e->>'remind', 'notes', e->>'notes'))
      from jsonb_array_elements(coalesce(d->'events', '[]'::jsonb)) e
      where sid is null
        or jsonb_typeof(e->'studentIds') is distinct from 'array'
        or jsonb_array_length(e->'studentIds') = 0
        or (e->'studentIds') ? sid), '[]'::jsonb)
  );
end $$;

-- ---------- support messages and error reports ----------
create table if not exists public.support_messages (
  id bigserial primary key,
  at timestamptz not null default now(),
  family_id uuid references public.families(id) on delete set null,
  user_id uuid,
  email text,
  topic text,
  body text not null,
  status text not null default 'new' check (status in ('new', 'answered', 'closed')),
  admin_note text
);
alter table public.support_messages enable row level security;
revoke all on public.support_messages from anon, authenticated;

create or replace function public.send_support_message(p_topic text, p_body text) returns bigint
language plpgsql security definer set search_path = public, auth as $$
declare fid uuid; em text; new_id bigint;
begin
  if auth.uid() is null or public.is_device_only() then raise exception 'Create your login first, then send your message.'; end if;
  select family_id into fid from public.members where user_id = auth.uid() and role = 'teacher';
  if fid is null then raise exception 'Only a teacher can send messages.'; end if;
  if (select count(*) from public.support_messages where user_id = auth.uid() and at > now() - interval '1 day') >= 10 then
    raise exception 'You''ve sent several messages today. We''ll reply soon.';
  end if;
  if length(trim(coalesce(p_body, ''))) < 3 then raise exception 'Please write a message.'; end if;
  select email into em from auth.users where id = auth.uid();
  insert into public.support_messages (family_id, user_id, email, topic, body)
  values (fid, auth.uid(), em, left(coalesce(p_topic, 'Question'), 60), left(p_body, 5000)) returning id into new_id;
  return new_id;
end $$;

create table if not exists public.client_errors (
  id bigserial primary key,
  at timestamptz not null default now(),
  user_id uuid,
  family_id uuid,
  message text,
  stack text,
  url text,
  agent text
);
create index if not exists client_errors_at on public.client_errors(at);
alter table public.client_errors enable row level security;
revoke all on public.client_errors from anon, authenticated;

create or replace function public.log_client_error(p_message text, p_stack text, p_url text, p_agent text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return; end if;
  if (select count(*) from public.client_errors where user_id = auth.uid() and at > now() - interval '1 day') >= 30 then return; end if;
  insert into public.client_errors (user_id, family_id, message, stack, url, agent)
  values (auth.uid(), (select family_id from public.members where user_id = auth.uid()),
          left(p_message, 500), left(p_stack, 4000), left(p_url, 300), left(p_agent, 300));
end $$;

-- ---------- admin portal ----------
create or replace function public.admin_overview() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  select jsonb_build_object(
    'families', (select count(*) from public.families),
    'by_status', (select coalesce(jsonb_object_agg(status, n), '{}') from (select status, count(*) n from public.families group by status) x),
    'by_plan', (select coalesce(jsonb_object_agg(plan, n), '{}') from (select plan, count(*) n from public.families where status in ('active', 'past_due') group by plan) x),
    'trials_active', (select count(*) from public.families where status = 'trialing' and trial_ends_at > now()),
    'trials_ending_3d', (select count(*) from public.families where status = 'trialing' and trial_ends_at between now() and now() + interval '3 days'),
    'new_30d', (select count(*) from public.families where created_at > now() - interval '30 days'),
    'active_7d', (select count(*) from public.families where last_seen > now() - interval '7 days'),
    'students', (select coalesce(sum(jsonb_array_length(coalesce(value::jsonb->'students', '[]'))), 0) from public.kv where key = 'hs-tracker:data'),
    'mrr_cents', (select coalesce(sum(case when billing_interval = 'year' then price_cents / 12.0 else price_cents end), 0)::int
                  from public.families where status in ('active', 'past_due') and cancel_at is null),
    'ai_cost_month_cents', (select round(coalesce(sum(cost_cents), 0)) from public.ai_usage where at >= date_trunc('month', now())),
    'ai_cost_30d_by_day', (select coalesce(jsonb_agg(jsonb_build_object('day', d, 'cents', round(c)) order by d), '[]')
                           from (select date_trunc('day', at)::date d, sum(cost_cents) c from public.ai_usage where at > now() - interval '30 days' group by 1) x),
    'messages_new', (select count(*) from public.support_messages where status = 'new'),
    'errors_7d', (select count(*) from public.client_errors where at > now() - interval '7 days'),
    'deleting_30d', (select count(*) from public.families f where public.family_delete_after(f) < now() + interval '30 days')
  ) into r;
  return r;
end $$;

create or replace function public.admin_families(p_search text default '')
returns table(id uuid, name text, owner_email text, plan text, status text, access text, trial_ends_at timestamptz,
  current_period_end timestamptz, cancel_at timestamptz, grace_until timestamptz, delete_after timestamptz,
  students integer, teachers integer, devices integer, last_seen timestamptz, created_at timestamptz,
  ai_cents integer, ai_cap_cents integer, ai_blocked boolean, price_cents integer, billing_interval text)
language plpgsql stable security definer set search_path = public, auth as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  return query
  select f.id, f.name, u.email::text, f.plan, f.status, public.family_access(f.id), f.trial_ends_at,
    f.current_period_end, f.cancel_at, f.grace_until, public.family_delete_after(f),
    (select coalesce(jsonb_array_length(coalesce(k.value::jsonb->'students', '[]')), 0) from public.kv k where k.family_id = f.id and k.key = 'hs-tracker:data')::int,
    (select count(*) from public.members m where m.family_id = f.id and m.role = 'teacher')::int,
    (select count(*) from public.members m where m.family_id = f.id and m.role = 'student')::int,
    f.last_seen, f.created_at,
    round(public.ai_used_cents(f.id))::int, public.ai_cap(f), f.ai_blocked, f.price_cents, f.billing_interval
  from public.families f left join auth.users u on u.id = f.created_by
  where coalesce(p_search, '') = '' or f.name ilike '%' || p_search || '%' or u.email ilike '%' || p_search || '%'
  order by f.created_at desc
  limit 500;
end $$;

-- Comp a family, extend a trial, change the AI limit, or block AI
create or replace function public.admin_update_family(p_family uuid, p_status text default null, p_plan text default null,
  p_extend_trial_days integer default null, p_ai_blocked boolean default null, p_ai_cap_cents integer default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  update public.families set
    status = coalesce(p_status, status),
    plan = coalesce(p_plan, plan),
    trial_ends_at = case when p_extend_trial_days is not null then greatest(coalesce(trial_ends_at, now()), now()) + make_interval(days => p_extend_trial_days) else trial_ends_at end,
    grace_until = case when coalesce(p_status, status) in ('comp', 'active') then null else grace_until end,
    delete_after = case when coalesce(p_status, status) in ('comp', 'active') then null else delete_after end,
    ai_blocked = coalesce(p_ai_blocked, ai_blocked),
    ai_cap_cents = case when p_ai_cap_cents is null then ai_cap_cents when p_ai_cap_cents < 0 then null else p_ai_cap_cents end
  where id = p_family;
  if p_extend_trial_days is not null then update public.families set status = 'trialing' where id = p_family and status = 'canceled' and stripe_subscription_id is null; end if;
end $$;

create or replace function public.admin_errors(p_limit integer default 100)
returns table(id bigint, at timestamptz, family_name text, email text, message text, stack text, url text, agent text)
language plpgsql stable security definer set search_path = public, auth as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  return query select e.id, e.at, f.name, u.email::text, e.message, e.stack, e.url, e.agent
    from public.client_errors e left join public.families f on f.id = e.family_id left join auth.users u on u.id = e.user_id
    order by e.at desc limit least(p_limit, 500);
end $$;

create or replace function public.admin_messages(p_status text default null)
returns table(id bigint, at timestamptz, family_name text, email text, topic text, body text, status text, admin_note text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  return query select s.id, s.at, f.name, s.email, s.topic, s.body, s.status, s.admin_note
    from public.support_messages s left join public.families f on f.id = s.family_id
    where p_status is null or s.status = p_status
    order by (s.status = 'new') desc, s.at desc limit 300;
end $$;

create or replace function public.admin_set_message(p_id bigint, p_status text, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  update public.support_messages set status = p_status, admin_note = coalesce(p_note, admin_note) where id = p_id;
end $$;

-- ---------- billing (called only by the Cloudflare worker with the service key) ----------
create or replace function public.billing_me() returns jsonb
language plpgsql stable security definer set search_path = public, auth as $$
declare m record; f public.families; em text;
begin
  select * into m from public.members where user_id = auth.uid() and role = 'teacher' and student_id is null;
  if not found or public.is_device_only() then return null; end if;
  select * into f from public.families where id = m.family_id;
  select email into em from auth.users where id = auth.uid();
  return jsonb_build_object('family_id', f.id, 'family_name', f.name, 'email', em, 'is_owner', f.created_by = auth.uid(),
    'customer', f.stripe_customer_id, 'subscription', f.stripe_subscription_id, 'status', f.status, 'trial_ends_at', f.trial_ends_at);
end $$;

create or replace function public.billing_set_customer(p_family uuid, p_customer text) returns void
language sql security definer set search_path = public as $$
  update public.families set stripe_customer_id = p_customer where id = p_family
$$;

-- Apply a Stripe subscription change. p_stripe_status is Stripe's own status.
create or replace function public.billing_apply(p_family uuid, p_customer text, p_subscription text, p_stripe_status text,
  p_plan text, p_period_end timestamptz, p_cancel_at timestamptz, p_price_cents integer, p_interval text) returns text
language plpgsql security definer set search_path = public as $$
declare fid uuid := p_family; cur public.families;
begin
  if fid is null then select id into fid from public.families where stripe_customer_id = p_customer; end if;
  if fid is null then return 'no family'; end if;
  select * into cur from public.families where id = fid;
  if cur.status = 'comp' then
    update public.families set stripe_customer_id = coalesce(stripe_customer_id, p_customer) where id = fid;
    return 'comp: left as is';
  end if;
  -- Ignore events about an older subscription once a newer one is on file
  if cur.stripe_subscription_id is not null and cur.stripe_subscription_id <> p_subscription
     and p_stripe_status in ('canceled', 'incomplete_expired') and cur.status in ('active', 'past_due') then
    return 'old subscription ignored';
  end if;
  if p_stripe_status in ('active', 'trialing') then
    update public.families set status = 'active', plan = coalesce(p_plan, plan), stripe_customer_id = p_customer,
      stripe_subscription_id = p_subscription, current_period_end = p_period_end, cancel_at = p_cancel_at,
      price_cents = p_price_cents, billing_interval = p_interval, grace_until = null, delete_after = null,
      delete_warned_at = null where id = fid;
  elsif p_stripe_status in ('past_due', 'unpaid') then
    update public.families set status = 'past_due', plan = coalesce(p_plan, plan), stripe_subscription_id = p_subscription,
      current_period_end = p_period_end, cancel_at = p_cancel_at where id = fid;
  elsif p_stripe_status in ('canceled', 'incomplete_expired') then
    if cur.status <> 'canceled' then
      update public.families set status = 'canceled', cancel_at = null,
        grace_until = now() + interval '10 days', delete_after = now() + interval '10 days' + interval '12 months',
        delete_warned_at = null where id = fid;
    end if;
  else
    return 'ignored ' || p_stripe_status;
  end if;
  return 'ok';
end $$;

create or replace function public.billing_log_ai(p_family uuid, p_user uuid, p_model text, p_in integer, p_out integer, p_cents numeric) returns void
language sql security definer set search_path = public as $$
  insert into public.ai_usage (family_id, user_id, model, input_tokens, output_tokens, cost_cents)
  values (p_family, p_user, p_model, greatest(p_in, 0), greatest(p_out, 0), greatest(p_cents, 0))
$$;

-- Daily job: who gets a reminder email, and whose data is past the 12 months
create or replace function public.billing_daily() returns jsonb
language plpgsql security definer set search_path = public, auth as $$
begin
  return jsonb_build_object(
    'trial_ending', coalesce((select jsonb_agg(jsonb_build_object('family_id', f.id, 'email', u.email, 'name', f.name, 'ends', f.trial_ends_at))
      from public.families f join auth.users u on u.id = f.created_by
      where f.status = 'trialing' and f.trial_warned_at is null and f.trial_ends_at between now() and now() + interval '3 days'), '[]'),
    'delete_soon', coalesce((select jsonb_agg(jsonb_build_object('family_id', f.id, 'email', u.email, 'name', f.name, 'deletes', public.family_delete_after(f)))
      from public.families f join auth.users u on u.id = f.created_by
      where f.status in ('canceled', 'trialing') and f.delete_warned_at is null
        and public.family_delete_after(f) between now() and now() + interval '30 days'), '[]'),
    'delete_now', coalesce((select jsonb_agg(f.id) from public.families f
      where f.status in ('canceled', 'trialing') and public.family_delete_after(f) < now()), '[]'));
end $$;

create or replace function public.billing_mark(p_family uuid, p_what text) returns void
language sql security definer set search_path = public as $$
  update public.families set
    trial_warned_at = case when p_what = 'trial' then now() else trial_warned_at end,
    delete_warned_at = case when p_what = 'delete' then now() else delete_warned_at end
  where id = p_family
$$;

-- Permanently delete a family whose 12 months have passed (the worker removes their files first)
create or replace function public.billing_purge(p_family uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare f public.families;
begin
  select * into f from public.families where id = p_family;
  if not found or f.status not in ('canceled', 'trialing') or public.family_delete_after(f) >= now() then return false; end if;
  delete from public.families where id = p_family;  -- members, data, codes, and calendar links go with it
  return true;
end $$;

-- ---------- permissions ----------
revoke execute on function public.family_access(uuid), public.family_delete_after(public.families), public.ai_cap(public.families),
  public.ai_used_cents(uuid), public.ai_gate(), public.can_use_ai(), public.is_admin(), public.my_account(), public.touch_seen(),
  public.send_support_message(text, text), public.log_client_error(text, text, text, text),
  public.admin_overview(), public.admin_families(text), public.admin_update_family(uuid, text, text, integer, boolean, integer),
  public.admin_errors(integer), public.admin_messages(text), public.admin_set_message(bigint, text, text),
  public.billing_me(), public.billing_set_customer(uuid, text),
  public.billing_apply(uuid, text, text, text, text, timestamptz, timestamptz, integer, text),
  public.billing_log_ai(uuid, uuid, text, integer, integer, numeric), public.billing_daily(), public.billing_mark(uuid, text),
  public.billing_purge(uuid) from public, anon;
grant execute on function public.family_access(uuid), public.ai_gate(), public.can_use_ai(), public.is_admin(), public.my_account(),
  public.touch_seen(), public.send_support_message(text, text), public.log_client_error(text, text, text, text),
  public.admin_overview(), public.admin_families(text), public.admin_update_family(uuid, text, text, integer, boolean, integer),
  public.admin_errors(integer), public.admin_messages(text), public.admin_set_message(bigint, text, text),
  public.billing_me() to authenticated;
revoke execute on function public.billing_set_customer(uuid, text),
  public.billing_apply(uuid, text, text, text, text, timestamptz, timestamptz, integer, text),
  public.billing_log_ai(uuid, uuid, text, integer, integer, numeric), public.billing_daily(), public.billing_mark(uuid, text),
  public.billing_purge(uuid) from authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.billing_set_customer(uuid, text),
      public.billing_apply(uuid, text, text, text, text, timestamptz, timestamptz, integer, text),
      public.billing_log_ai(uuid, uuid, text, integer, integer, numeric), public.billing_daily(), public.billing_mark(uuid, text),
      public.billing_purge(uuid) to service_role';
  end if;
end $$;
