-- Opada: behaviour-trail events (issue #12, approved contract).
-- Run manually in the Supabase SQL editor. Not applied by the app.
--
-- Events arrive at POST /api/v1/behaviour-events from a merchant's emitter.
-- They hold no PII by construction: refs are random, every property is an
-- integer, an ISO code or an enum (validated before insert). `source` is set
-- by Opada from the credential, never from the request body.
--
-- Retention: 30 days from received_at. purge_behaviour_events() deletes older
-- rows; the cron poll route calls it on every run. A diagnosis never stores
-- raw events, so purging doesn't change past diagnoses.

begin;

create table public.behaviour_events (
  id            bigint generated always as identity primary key,
  merchant_id   text        not null,
  emitter_id    text        not null,
  event_id      text        not null,
  type          text        not null,
  occurred_at   timestamptz not null,
  received_at   timestamptz not null default now(),
  buyer_ref     text        not null,
  session_ref   text,
  device        text,
  properties    jsonb       not null default '{}'::jsonb,
  source        text        not null,

  -- Idempotency: a resent event is stored once.
  constraint behaviour_events_event_key unique (merchant_id, event_id),
  constraint behaviour_events_type_check check (
    type in ('checkout_started', 'info_viewed', 'question_asked', 'payment_started', 'payment_closed', 'checkout_left')
  ),
  constraint behaviour_events_source_check check (source in ('server', 'client')),
  constraint behaviour_events_device_check check (device is null or device in ('mobile', 'tablet', 'desktop')),
  constraint behaviour_events_buyer_ref_check check (buyer_ref ~ '^[A-Za-z0-9_-]{22,64}$'),
  constraint behaviour_events_session_ref_check check (session_ref is null or session_ref ~ '^[A-Za-z0-9_-]{22,64}$'),
  constraint behaviour_events_properties_check check (jsonb_typeof(properties) = 'object')
);

create index behaviour_events_buyer_idx   on public.behaviour_events (buyer_ref, occurred_at);
create index behaviour_events_session_idx on public.behaviour_events (session_ref, occurred_at) where session_ref is not null;
create index behaviour_events_received_idx on public.behaviour_events (received_at);

alter table public.behaviour_events enable row level security;
alter table public.behaviour_events force row level security;
revoke all on table public.behaviour_events from anon, authenticated;

create function public.purge_behaviour_events()
returns integer
language sql
set search_path = ''
as $$
  with gone as (
    delete from public.behaviour_events where received_at < now() - interval '30 days' returning 1
  )
  select count(*)::integer from gone;
$$;

revoke all on function public.purge_behaviour_events() from public, anon, authenticated;

commit;

-- ---------------------------------------------------------------------------
-- emitter_keys: who may send behaviour events (issue #12, corrected).
-- Ed25519 PUBLIC keys only. Opada never holds a credential that can sign.
-- Up to two active public keys per emitter, for rotation without downtime.
-- Rows are added by Okunola, from the SQL printed by `npm run emitter-key`.
-- ---------------------------------------------------------------------------

begin;

create table public.emitter_keys (
  key_id        text primary key,
  merchant_id   text        not null,
  emitter_name  text        not null,
  environment   text        not null,
  public_key_1  text        not null,
  public_key_2  text,
  created_at    timestamptz not null default now(),
  revoked_at    timestamptz,

  constraint emitter_keys_key_id_check check (key_id ~ '^oek_(test|live)_[A-Za-z0-9]{16,64}$'),
  constraint emitter_keys_environment_check check (environment in ('test', 'live')),
  constraint emitter_keys_env_matches_id_check check (key_id like 'oek_' || environment || '_%'),
  -- Raw 32-byte Ed25519 public keys, base64url (43 characters).
  constraint emitter_keys_public_key_1_check check (public_key_1 ~ '^[A-Za-z0-9_-]{43}$'),
  constraint emitter_keys_public_key_2_check check (public_key_2 is null or public_key_2 ~ '^[A-Za-z0-9_-]{43}$')
);

alter table public.emitter_keys enable row level security;
alter table public.emitter_keys force row level security;
revoke all on table public.emitter_keys from anon, authenticated;

commit;
