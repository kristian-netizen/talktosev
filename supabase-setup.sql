-- Talk To Sev / Apply form — Supabase schema
-- Run this once in the Supabase SQL editor (Project > SQL Editor > New query).
-- After running: enable email auth in Authentication > Providers, and confirm
-- the magic-link redirect URL includes https://talktosev.com/apply/admin

-- ============================================================================
-- 1. Leads table
-- ============================================================================
create table if not exists public.leads (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),

  -- Q1: What stops you from hitting record?
  record_blocker  text not null check (record_blocker in (
                    'sound_awkward',
                    'dont_know_what_to_say',
                    'hate_how_i_look',
                    'freeze_up'
                  )),

  -- Q2: 6-month vision
  six_month_vision text not null check (six_month_vision in (
                    'grow_business',
                    'build_brand',
                    'sell_course',
                    'face_of_industry'
                  )),

  -- Q3: Video history
  video_history   text not null check (video_history in (
                    'post_regularly',
                    'gave_up',
                    'never'
                  )),

  -- Q4: Revenue bracket (the qualifier)
  revenue_bracket text not null check (revenue_bracket in ('over_20k', 'under_20k')),

  -- Q5: Name
  first_name      text not null,
  last_name       text not null,

  -- Q6: Instagram
  instagram_handle text not null,

  -- Q7: Business detail (optional, no asterisk on slide)
  business_detail text,

  -- Q8: Email
  email           text not null,

  -- Q9: Phone
  phone           text not null,
  phone_country   text default 'AU',

  -- Q10: How they found Sev
  how_found       text not null check (how_found in ('ig_content', 'friend', 'ad', 'other')),
  how_found_other text,

  -- Derived: qualified for $2,500 1:1 mentoring offer
  qualified       boolean generated always as (revenue_bracket = 'over_20k') stored,

  -- Submission metadata
  user_agent      text,
  referrer        text,

  -- CRM fields (Sev edits these from the admin view)
  contacted       boolean not null default false,
  contacted_at    timestamptz,
  notes           text
);

create index if not exists leads_created_at_idx on public.leads (created_at desc);
create index if not exists leads_qualified_idx  on public.leads (qualified, created_at desc);
create index if not exists leads_email_idx      on public.leads (email);

-- ============================================================================
-- 2. Row-Level Security
-- ============================================================================
alter table public.leads enable row level security;

-- The API function uses the service_role key, which bypasses RLS, so no insert
-- policy for anon is needed. The admin page uses authenticated user JWT — only
-- sev@sevspics.com can read or update.

drop policy if exists "sev_read"   on public.leads;
drop policy if exists "sev_update" on public.leads;

create policy "sev_read"
  on public.leads for select
  to authenticated
  using ( (auth.jwt() ->> 'email') = 'sev@sevspics.com' );

create policy "sev_update"
  on public.leads for update
  to authenticated
  using  ( (auth.jwt() ->> 'email') = 'sev@sevspics.com' )
  with check ( (auth.jwt() ->> 'email') = 'sev@sevspics.com' );

-- ============================================================================
-- 3. Aggregate view for admin dashboard analytics
-- ============================================================================
create or replace view public.lead_stats as
select
  count(*)                                                       as total_leads,
  count(*) filter (where qualified)                              as qualified_leads,
  count(*) filter (where not qualified)                          as nurture_leads,
  count(*) filter (where created_at > now() - interval '7 days') as last_7_days,
  count(*) filter (where created_at > now() - interval '30 days') as last_30_days,

  -- Most common blocker (Q1)
  (select record_blocker  from public.leads group by record_blocker  order by count(*) desc limit 1) as top_blocker,
  -- Most common 6-month vision (Q2)
  (select six_month_vision from public.leads group by six_month_vision order by count(*) desc limit 1) as top_vision,
  -- Most common video history (Q3)
  (select video_history   from public.leads group by video_history   order by count(*) desc limit 1) as top_history,
  -- Most common acquisition channel (Q10)
  (select how_found       from public.leads group by how_found       order by count(*) desc limit 1) as top_channel
from public.leads;

grant select on public.lead_stats to authenticated;
