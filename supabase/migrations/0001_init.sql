-- Unstall: initial schema.
-- Run manually in the Supabase SQL editor. Not applied by the app.
--
-- Access model: RLS is enabled on every table with NO policies, and all table
-- privileges are revoked from anon and authenticated. Only the server-side
-- secret (service_role) key, which bypasses RLS, can read or write.

begin;

-- ---------------------------------------------------------------------------
-- stalls: one row per stalled Paystack payment, as received from the webhook.
-- ---------------------------------------------------------------------------
create table public.stalls (
  id                  uuid primary key default gen_random_uuid(),
  paystack_reference  text not null,
  event_type          text not null,
  amount              bigint,                  -- in currency subunits (kobo, pesewas, cents)
  currency            text,
  customer_identifier text,                    -- customer email, falling back to customer_code
  gateway_response    text,
  error_code          text,
  stalled_at          timestamptz not null,
  payload             jsonb not null,
  status              text not null default 'new',
  received_at         timestamptz not null default now(),

  constraint stalls_paystack_reference_key unique (paystack_reference),
  constraint stalls_status_check check (
    status in ('new', 'diagnosing', 'diagnosed', 'acting', 'recovered', 'unrecoverable', 'ignored')
  ),
  constraint stalls_amount_check check (amount is null or amount >= 0)
);

create index stalls_status_idx on public.stalls (status);
create index stalls_stalled_at_idx on public.stalls (stalled_at desc);

-- ---------------------------------------------------------------------------
-- diagnoses: exactly one per stall.
-- ---------------------------------------------------------------------------
create table public.diagnoses (
  id          uuid primary key default gen_random_uuid(),
  stall_id    uuid not null references public.stalls (id) on delete cascade,
  reason      text not null,
  confidence  numeric(4, 3) not null,
  rationale   text not null,
  model       text not null,
  created_at  timestamptz not null default now(),

  constraint diagnoses_stall_id_key unique (stall_id),
  -- Lets actions enforce that its diagnosis belongs to its stall.
  constraint diagnoses_id_stall_id_key unique (id, stall_id),
  constraint diagnoses_reason_check check (
    reason in ('NO_FUNDS_NOW', 'CARD_FAILING', 'PROVIDER_DOWN', 'NO_TRUST', 'UNANSWERED_QUESTION', 'FORGOT')
  ),
  constraint diagnoses_confidence_check check (confidence >= 0 and confidence <= 1)
);

-- ---------------------------------------------------------------------------
-- actions: one row per remedy attempted (or that would be attempted) for a stall.
-- ---------------------------------------------------------------------------
create table public.actions (
  id            uuid primary key default gen_random_uuid(),
  stall_id      uuid not null references public.stalls (id) on delete cascade,
  diagnosis_id  uuid not null,
  remedy_type   text not null,
  payload       jsonb not null,               -- exactly what would be sent
  mode          text not null default 'dry_run',
  status        text not null default 'pending',
  scheduled_at  timestamptz,
  executed_at   timestamptz,
  result        jsonb,
  created_at    timestamptz not null default now(),

  constraint actions_diagnosis_fk
    foreign key (diagnosis_id, stall_id)
    references public.diagnoses (id, stall_id)
    on delete cascade,
  constraint actions_mode_check check (mode in ('dry_run', 'live')),
  constraint actions_status_check check (
    status in ('pending', 'scheduled', 'executing', 'succeeded', 'failed', 'cancelled', 'skipped')
  ),
  constraint actions_executed_check check (
    executed_at is null or status in ('succeeded', 'failed', 'skipped')
  )
);

create index actions_stall_id_idx on public.actions (stall_id);
create index actions_due_idx on public.actions (scheduled_at) where status = 'scheduled';

-- ---------------------------------------------------------------------------
-- Lock down: RLS on, no policies, no grants to client-facing roles.
-- ---------------------------------------------------------------------------
alter table public.stalls    enable row level security;
alter table public.diagnoses enable row level security;
alter table public.actions   enable row level security;

alter table public.stalls    force row level security;
alter table public.diagnoses force row level security;
alter table public.actions   force row level security;

revoke all on table public.stalls    from anon, authenticated;
revoke all on table public.diagnoses from anon, authenticated;
revoke all on table public.actions   from anon, authenticated;

commit;
