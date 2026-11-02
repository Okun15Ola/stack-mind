-- Opada: flag stalls whose diagnosis was blocked.
-- Run manually in the Supabase SQL editor. Not applied by the app.
--
-- When every model refuses, or the PII gate refuses the model input, the
-- stall is left undiagnosed. These columns make that visible: a blocked stall
-- is distinguishable from one nobody has tried yet. They never change
-- `status`, so a blocked stall is never marked resolved or skipped.
--
-- diagnosis_blocked holds the kind of block and model ids / field paths only,
-- never customer data, e.g.
--   'model_refused: claude-haiku-5-5 (cyber); claude-sonnet-5-5 (cyber)'
--   'pii_gate: identifier at input.checkout.steps[1].message'
-- It is cleared when a diagnosis is saved.

begin;

alter table public.stalls
  add column diagnosis_blocked    text,
  add column diagnosis_blocked_at timestamptz,
  add constraint stalls_diagnosis_blocked_check check (
    (diagnosis_blocked is null) = (diagnosis_blocked_at is null)
    and (diagnosis_blocked is null or length(diagnosis_blocked) <= 500)
  );

create index stalls_diagnosis_blocked_idx
  on public.stalls (diagnosis_blocked_at desc)
  where diagnosis_blocked is not null;

commit;
