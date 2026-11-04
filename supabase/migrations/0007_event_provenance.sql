-- Opada: event provenance and the evidence a diagnosis rested on (issue #12,
-- decisions of 3 November 2026).
-- Run manually in the Supabase SQL editor. Not applied by the app.
--
-- 1. behaviour_events.source: three values, by who OBSERVED the event:
--      server_observed  the merchant's server saw it during its own work
--      server_relayed   the browser reported it; the merchant forwarded it
--      client           a browser sent it with a publishable key
--    Any row stored under the old 'server' value becomes 'server_relayed',
--    the safe default: the old contract couldn't tell the two apart.
-- 2. diagnoses.trail_sources: per-source counts of the joined events, and
--    diagnoses.first_hand_evidence: first-hand evidence FOR the diagnosed
--    reason (src/lib/first-hand.ts). Both computed by code at diagnosis time.
--    The Mandate's Ask-once gate reads first_hand_evidence.

begin;

alter table public.behaviour_events drop constraint behaviour_events_source_check;
update public.behaviour_events set source = 'server_relayed' where source = 'server';
alter table public.behaviour_events add constraint behaviour_events_source_check
  check (source in ('server_observed', 'server_relayed', 'client'));

alter table public.diagnoses
  add column trail_sources jsonb not null default '{"server_observed": 0, "server_relayed": 0, "client": 0}'::jsonb,
  add column first_hand_evidence text[] not null default '{}',
  add constraint diagnoses_trail_sources_check check (
    jsonb_typeof(trail_sources) = 'object'
    and (trail_sources ?& array['server_observed', 'server_relayed', 'client'])
  ),
  -- Only first-hand types may appear. Browser-originated evidence
  -- (server_relayed, client, the provider-relayed checkout log) never may.
  add constraint diagnoses_first_hand_evidence_check check (
    first_hand_evidence <@ array['paystack:gateway_response', 'server_observed:question_asked']::text[]
  );

commit;
