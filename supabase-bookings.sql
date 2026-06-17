-- Talk To Sev / Run Claude With Me bookings — Supabase schema
-- Run this once in the Supabase SQL editor.

-- ============================================================================
-- 1. Bookings table
-- ============================================================================
create table if not exists public.bookings (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),

  -- When the session is scheduled (AWST / Australia/Perth)
  session_date      date not null,                -- e.g. '2026-05-21'
  session_slot      time not null,                -- e.g. '09:30:00' (24h, AWST)
  session_end       time not null,                -- e.g. '10:30:00' (session_slot + 60 min)

  -- Client details
  client_name       text not null,
  client_email      text not null,
  client_mobile     text not null,

  -- Lifecycle
  status            text not null default 'pending'
                       check (status in ('pending', 'confirmed', 'expired', 'cancelled')),
  expires_at        timestamptz not null,         -- 15 minutes after created_at for pending rows

  -- Payment + calendar IDs (filled in by webhook after payment succeeds)
  stripe_session_id     text,
  stripe_payment_intent text,
  amount_paid_cents     integer,
  amount_currency       text,
  calendar_event_id     text,
  calendar_event_link   text,
  meet_link             text,

  -- Bookkeeping
  confirmed_at      timestamptz,
  notes             text
);

create index if not exists bookings_date_slot_idx       on public.bookings (session_date, session_slot);
create index if not exists bookings_status_expires_idx  on public.bookings (status, expires_at);
create index if not exists bookings_email_idx           on public.bookings (client_email);
create unique index if not exists bookings_stripe_session_unique
  on public.bookings (stripe_session_id)
  where stripe_session_id is not null;

-- ============================================================================
-- 2. Row-Level Security
-- ============================================================================
alter table public.bookings enable row level security;

-- API uses service_role key (bypasses RLS). Only sev@sevspics.com can read.
drop policy if exists "sev_read_bookings"   on public.bookings;
drop policy if exists "sev_update_bookings" on public.bookings;

create policy "sev_read_bookings"
  on public.bookings for select
  to authenticated
  using ( (auth.jwt() ->> 'email') = 'sev@sevspics.com' );

create policy "sev_update_bookings"
  on public.bookings for update
  to authenticated
  using  ( (auth.jwt() ->> 'email') = 'sev@sevspics.com' )
  with check ( (auth.jwt() ->> 'email') = 'sev@sevspics.com' );

-- ============================================================================
-- 3. View: active holds (pending bookings not yet expired)
--    Used by /api/availability to subtract held slots from offered availability.
-- ============================================================================
create or replace view public.active_holds as
select
  id, session_date, session_slot, session_end, client_email, expires_at
from public.bookings
where status = 'pending'
  and expires_at > now();
