-- Unstall: poller support and the re-verify gate.
-- Run manually in the Supabase SQL editor after 0001_init.sql.

begin;

-- ---------------------------------------------------------------------------
-- stalls: which ingest path caught it, and who called it abandoned.
-- ---------------------------------------------------------------------------

-- Existing rows all came from the webhook. Default only for the backfill, then
-- dropped so every insert must state its source.
alter table public.stalls
  add column source text not null default 'webhook',
  add constraint stalls_source_check check (source in ('webhook', 'poll'));
alter table public.stalls alter column source drop default;

-- Transaction status as Paystack reported it at ingest (failed, abandoned, ongoing, ...).
alter table public.stalls add column paystack_status text;

-- 'paystack': Paystack's own status was 'abandoned'.
-- 'unstall':  Paystack still showed it in progress; we called it abandoned by age.
-- null:       not an abandonment (e.g. an explicit failure).
alter table public.stalls
  add column abandoned_by text,
  add constraint stalls_abandoned_by_check check (
    abandoned_by is null
    or (abandoned_by = 'paystack' and paystack_status = 'abandoned')
    or (abandoned_by = 'unstall' and paystack_status is distinct from 'abandoned')
  );

update public.stalls set paystack_status = payload #>> '{data,status}' where paystack_status is null;

comment on column public.stalls.gateway_response is
  'Paystack gateway_response, verbatim. Paystack has no error code field; this is the primary diagnosis signal.';
comment on column public.stalls.source is 'Ingest path that first captured this stall.';
comment on column public.stalls.abandoned_by is 'Who classified it as abandoned: paystack (status) or unstall (age threshold).';

create index stalls_source_idx on public.stalls (source);

-- ---------------------------------------------------------------------------
-- stalls: re-verification against Paystack.
--
-- 'resolved' means the customer paid without us (same reference, or another
-- reference for the same amount since the stall). 'recovered' remains for
-- payments we brought back.
-- ---------------------------------------------------------------------------
alter table public.stalls drop constraint stalls_status_check;
alter table public.stalls add constraint stalls_status_check check (
  status in ('new', 'diagnosing', 'diagnosed', 'acting', 'recovered', 'resolved', 'unrecoverable', 'ignored')
);

alter table public.stalls
  add column verified_at        timestamptz,  -- last successful re-check with Paystack
  add column verified_status    text,         -- Paystack status of this reference at that check
  add column resolved_at        timestamptz,
  add column resolved_reference text,         -- the successful reference (this one or another)
  add constraint stalls_resolved_check check (
    (status = 'resolved') = (resolved_at is not null and resolved_reference is not null)
  );

comment on column public.stalls.verified_at is
  'Diagnoses and action execution are refused unless this is within the last 10 minutes.';

-- ---------------------------------------------------------------------------
-- Hard rule: no diagnosis or action on a stall that is resolved or has not been
-- re-verified with Paystack in the last 10 minutes. Enforced here so no code
-- path can skip it.
-- ---------------------------------------------------------------------------
create function public.assert_stall_actionable(p_stall_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  s_status      text;
  s_verified_at timestamptz;
begin
  select status, verified_at into s_status, s_verified_at
  from public.stalls
  where id = p_stall_id
  for share;

  if not found then
    raise exception 'stall % does not exist', p_stall_id;
  end if;
  if s_status = 'resolved' then
    raise exception 'stall % is resolved (customer paid); refusing', p_stall_id;
  end if;
  if s_verified_at is null or s_verified_at < now() - interval '10 minutes' then
    raise exception 'stall % not re-verified with Paystack in the last 10 minutes; refusing', p_stall_id;
  end if;
end;
$$;

create function public.guard_diagnosis_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform public.assert_stall_actionable(new.stall_id);
  return new;
end;
$$;

create trigger diagnoses_require_verified_stall
  before insert on public.diagnoses
  for each row execute function public.guard_diagnosis_insert();

-- Actions: checked on creation, and again on the move to 'executing', since a
-- scheduled action may run long after it was created. Outcomes can only be
-- recorded from 'executing', so nothing can jump straight to succeeded.
create function public.guard_action_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status not in ('pending', 'scheduled') then
      raise exception 'actions must be created as pending or scheduled, got %', new.status;
    end if;
    perform public.assert_stall_actionable(new.stall_id);
  elsif new.status is distinct from old.status then
    if new.status = 'executing' then
      perform public.assert_stall_actionable(new.stall_id);
    elsif new.status in ('succeeded', 'failed') and old.status <> 'executing' then
      raise exception 'action % can only reach % from executing (was %)', new.id, new.status, old.status;
    end if;
  end if;
  return new;
end;
$$;

create trigger actions_require_verified_stall
  before insert or update on public.actions
  for each row execute function public.guard_action_write();

-- When a stall resolves, anything not yet running is cancelled.
create function public.cancel_actions_on_resolve()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.actions
  set status = 'cancelled'
  where stall_id = new.id
    and status in ('pending', 'scheduled');
  return null;
end;
$$;

create trigger stalls_cancel_actions_on_resolve
  after update of status on public.stalls
  for each row
  when (new.status = 'resolved' and old.status is distinct from 'resolved')
  execute function public.cancel_actions_on_resolve();

revoke all on function public.assert_stall_actionable(uuid) from public, anon, authenticated;
revoke all on function public.guard_diagnosis_insert()      from public, anon, authenticated;
revoke all on function public.guard_action_write()          from public, anon, authenticated;
revoke all on function public.cancel_actions_on_resolve()   from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- poller_state: durable cursor and lease lock, one row per poller.
-- ---------------------------------------------------------------------------
create table public.poller_state (
  id              text primary key,
  cursor          timestamptz,       -- upper bound (initiation time) of the last successful window
  last_run_at     timestamptz,
  last_success_at timestamptz,
  last_error      text,
  locked_until    timestamptz,
  lock_holder     uuid
);

insert into public.poller_state (id) values ('paystack_transactions');

alter table public.poller_state enable row level security;
alter table public.poller_state force row level security;
revoke all on table public.poller_state from anon, authenticated;

-- Explicit grants for the server key, in case new tables are not auto-exposed.
grant select, insert, update, delete on table
  public.stalls, public.diagnoses, public.actions, public.poller_state
  to service_role;

commit;
