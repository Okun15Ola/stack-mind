-- Opada: INSUFFICIENT_EVIDENCE outcome, evidence gaps, and the metric view.
-- Run manually in the Supabase SQL editor. Not applied by the app.
--
-- INSUFFICIENT_EVIDENCE is returned by the model instead of a guess when the
-- facts can't separate the candidate reasons. It is not a reason: the Mandate
-- maps it to no action. The gateway rules never return it.
--
-- evidence_gaps lists the sections of the model input that were unavailable,
-- computed by code (never written by the model): 'behaviour_trail',
-- 'checkout_log', 'card_details'. Empty for rule diagnoses. For an
-- INSUFFICIENT_EVIDENCE diagnosis it is what would have been needed.

begin;

alter table public.diagnoses drop constraint diagnoses_reason_check;
alter table public.diagnoses add constraint diagnoses_reason_check check (
  reason in ('NO_FUNDS_NOW', 'CARD_FAILING', 'PROVIDER_DOWN', 'NO_TRUST', 'UNANSWERED_QUESTION', 'FORGOT',
             'INSUFFICIENT_EVIDENCE')
);

alter table public.diagnoses
  add column evidence_gaps text[] not null default '{}',
  add constraint diagnoses_evidence_gaps_check check (
    evidence_gaps <@ array['behaviour_trail', 'checkout_log', 'card_details']::text[]
  ),
  -- Rules never return INSUFFICIENT_EVIDENCE.
  add constraint diagnoses_rules_never_insufficient_check check (
    not (reason = 'INSUFFICIENT_EVIDENCE' and model like 'rules:%')
  );

-- INSUFFICIENT_EVIDENCE maps to no action. Enforced here as well as in the
-- Mandate, so no code path can create an action from a diagnosis that says
-- the cause could not be determined.
create function public.guard_action_needs_a_reason()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.diagnoses d
    where d.id = new.diagnosis_id and d.reason = 'INSUFFICIENT_EVIDENCE'
  ) then
    raise exception 'diagnosis % is INSUFFICIENT_EVIDENCE; no action may be taken on it', new.diagnosis_id;
  end if;
  return new;
end;
$$;

create trigger actions_require_a_reason
  before insert on public.actions
  for each row execute function public.guard_action_needs_a_reason();

revoke all on function public.guard_action_needs_a_reason() from public, anon, authenticated;

-- The metric: share of model-path diagnoses that couldn't be determined, split
-- by whether the behaviour trail was available. It should fall once the trail
-- ships. Rule diagnoses are excluded: they never go to the model.
create view public.diagnosis_insufficient_evidence_rate
with (security_invoker = true) as
select
  not ('behaviour_trail' = any (evidence_gaps))                 as behaviour_trail_available,
  count(*)                                                      as model_diagnoses,
  count(*) filter (where reason = 'INSUFFICIENT_EVIDENCE')      as insufficient_evidence,
  round(
    count(*) filter (where reason = 'INSUFFICIENT_EVIDENCE')::numeric / nullif(count(*), 0), 3
  )                                                             as insufficient_share
from public.diagnoses
where model not like 'rules:%'
group by 1;

revoke all on public.diagnosis_insufficient_evidence_rate from anon, authenticated;

commit;
