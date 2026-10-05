-- Beta controls: AI tools are off for each new family until you switch them on.
-- This keeps people who sign up from using your Anthropic key without your OK.
-- To turn AI on for a family: Supabase → Table Editor → families → set ai_enabled to true.

alter table public.families add column if not exists ai_enabled boolean not null default false;

create or replace function public.can_use_ai() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.members m join public.families f on f.id = m.family_id
    where m.user_id = auth.uid() and m.role = 'teacher' and f.ai_enabled
  )
$$;

revoke execute on function public.can_use_ai() from public, anon;
grant execute on function public.can_use_ai() to authenticated;
