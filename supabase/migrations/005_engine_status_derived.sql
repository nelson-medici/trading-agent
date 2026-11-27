-- ============================================================
-- Fix: engine_status derivado de la frescura del heartbeat
-- ============================================================
-- Antes: tomaba el campo `status` del último registro, que queda
-- congelado en 'healthy' cuando el engine se apaga.
-- Ahora: deriva healthy/stale/down de now() - reported_at.

create or replace view v_dashboard_summary as
with capital_by_pool as (
  select pool,
    coalesce(sum(case when event_type='deposit' then amount_usd
                      when event_type='withdrawal' then -amount_usd else 0 end), 0) as invested
  from capital_events group by pool
),
latest_equity_by_pool as (
  select distinct on (pool) pool, total_equity_usd, high_water_mark, drawdown_from_hwm_pct
  from equity_snapshots order by pool, ts desc
),
positions_by_pool as (
  select pool, count(*) as n from positions group by pool
),
totals as (
  select sum(le.total_equity_usd) as total_equity,
         sum(c.invested) as total_invested
  from latest_equity_by_pool le full join capital_by_pool c using(pool)
),
engine_hb as (
  select reported_at,
         extract(epoch from (now() - reported_at)) as seconds_since
  from heartbeats where service='engine'
  order by reported_at desc limit 1
)
select
  total_equity as current_equity,
  (select max(high_water_mark) from latest_equity_by_pool) as hwm,
  (select max(drawdown_from_hwm_pct) from latest_equity_by_pool) as current_dd,
  total_invested,
  total_equity - total_invested as total_gain,
  case when total_invested > 0 then (total_equity - total_invested)/total_invested else 0 end as total_gain_pct,
  coalesce((select n from positions_by_pool where pool='core'), 0) as core_positions,
  coalesce((select total_equity_usd from latest_equity_by_pool where pool='core'), 0) as core_equity,
  coalesce((select invested from capital_by_pool where pool='core'), 0) as core_invested,
  coalesce((select n from positions_by_pool where pool='tactical'), 0) as tactical_positions,
  coalesce((select total_equity_usd from latest_equity_by_pool where pool='tactical'), 0) as tactical_equity,
  coalesce((select invested from capital_by_pool where pool='tactical'), 0) as tactical_invested,
  (select count(*) from positions) as open_positions,
  (select count(*) from scores where state='CANDIDATE' and ts > now() - interval '2 hours') as candidates,
  (select count(*) from scores where state='WATCHLIST' and ts > now() - interval '2 hours') as watchlist_count,
  (select active from kill_switch where id=1) as kill_active,
  (select count(*) from alerts where not acknowledged and level in ('warn','critical')) as unacked_alerts,
  -- ENGINE STATUS derivado de la frescura del último heartbeat
  case
    when (select reported_at from engine_hb) is null then 'unknown'
    when (select seconds_since from engine_hb) < 120 then 'healthy'   -- < 2 min
    when (select seconds_since from engine_hb) < 300 then 'stale'     -- 2-5 min
    else 'down'                                                       -- > 5 min
  end as engine_status,
  (select reported_at from engine_hb) as engine_last_heartbeat,
  (select seconds_since::int from engine_hb) as engine_seconds_since_heartbeat
from totals t;
