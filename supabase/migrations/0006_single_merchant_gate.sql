-- Opada: hard gate. One merchant only, until stalls carry a merchant id.
-- Run manually in the Supabase SQL editor. Not applied by the app.
--
-- The behaviour-trail join doesn't filter by merchant yet, because stalls
-- have no merchant_id: today there is one Paystack account, so one merchant.
-- That must not depend on anyone remembering. A second merchant's emitter key
-- is refused here, so a second merchant connecting fails at registration
-- instead of silently crossing trails. The app also refuses to join while
-- more than one merchant exists (src/lib/behaviour/merchants.ts).
--
-- The gate lifts itself only when public.stalls gains a merchant_id column,
-- which is the migration that must come with merchant filtering in the join.

begin;

-- Fails this migration if the gate is already breached.
do $$
begin
  if (select count(distinct merchant_id) from public.emitter_keys) > 1 then
    raise exception 'more than one merchant already has emitter keys; stalls carry no merchant id, so the trail join would cross merchants';
  end if;
end;
$$;

create function public.opada_merchant_count()
returns integer
language sql
stable
set search_path = ''
as $$
  select count(distinct merchant_id)::integer from public.emitter_keys;
$$;

create function public.guard_single_merchant()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'stalls' and column_name = 'merchant_id'
  ) then
    return new;
  end if;
  if exists (select 1 from public.emitter_keys k where k.merchant_id <> new.merchant_id) then
    raise exception 'refusing emitter key for merchant %: Opada supports one merchant until stalls carry a merchant id and the trail join filters by it', new.merchant_id;
  end if;
  return new;
end;
$$;

create trigger emitter_keys_single_merchant
  before insert or update of merchant_id on public.emitter_keys
  for each row execute function public.guard_single_merchant();

revoke all on function public.opada_merchant_count()   from public, anon, authenticated;
revoke all on function public.guard_single_merchant()  from public, anon, authenticated;

commit;
