-- ============================================================
-- Vistas de efectividad para análisis de señales y operaciones
-- ============================================================

-- Resumen global (últimos 30 días)
create or replace view v_effectiveness_summary as
select
  count(*) as total_trades,
  count(*) filter (where pnl_usd > 0) as wins,
  count(*) filter (where pnl_usd <= 0) as losses,
  case when count(*) > 0 then
    round(count(*) filter (where pnl_usd > 0)::numeric / count(*) * 100, 1)
  else 0 end as win_rate_pct,
  round(coalesce(sum(pnl_usd), 0)::numeric, 4) as total_pnl,
  round(coalesce(avg(pnl_usd), 0)::numeric, 4) as avg_pnl,
  round(coalesce(avg(pnl_usd) filter (where pnl_usd > 0), 0)::numeric, 4) as avg_win,
  round(coalesce(avg(pnl_usd) filter (where pnl_usd < 0), 0)::numeric, 4) as avg_loss,
  -- Reward:Risk ratio (avg win / avg loss)
  case when abs(coalesce(avg(pnl_usd) filter (where pnl_usd < 0), 0)) > 0 then
    round((coalesce(avg(pnl_usd) filter (where pnl_usd > 0), 0) /
      abs(coalesce(avg(pnl_usd) filter (where pnl_usd < 0), 0)))::numeric, 2)
  else null end as reward_risk_ratio,
  -- Profit factor (gross wins / gross losses)
  case when abs(coalesce(sum(pnl_usd) filter (where pnl_usd < 0), 0)) > 0 then
    round((coalesce(sum(pnl_usd) filter (where pnl_usd > 0), 0) /
      abs(coalesce(sum(pnl_usd) filter (where pnl_usd < 0), 0)))::numeric, 2)
  else null end as profit_factor,
  -- Expected value per trade = win_rate * avg_win + loss_rate * avg_loss
  round((
    case when count(*) > 0 then
      (count(*) filter (where pnl_usd > 0)::numeric / count(*)) *
        coalesce(avg(pnl_usd) filter (where pnl_usd > 0), 0) +
      (1 - count(*) filter (where pnl_usd > 0)::numeric / count(*)) *
        coalesce(avg(pnl_usd) filter (where pnl_usd < 0), 0)
    else 0 end
  )::numeric, 4) as expected_value,
  round(coalesce(avg(hold_hours), 0)::numeric, 2) as avg_hold_h,
  -- Racha máxima de pérdidas consecutivas
  (select coalesce(max(streak), 0) from (
    select count(*) as streak
    from (
      select pnl_usd,
        sum(case when pnl_usd > 0 then 1 else 0 end) over (order by exit_at) as grp
      from trades where exit_at > now() - interval '30 days'
    ) sub
    where pnl_usd <= 0
    group by grp
  ) streaks) as max_loss_streak
from trades
where exit_at > now() - interval '30 days';

grant select on v_effectiveness_summary to authenticated;

-- Por exit_reason (últimos 30 días)
create or replace view v_effectiveness_by_exit_reason as
select
  exit_reason,
  count(*) as trades,
  count(*) filter (where pnl_usd > 0) as wins,
  count(*) filter (where pnl_usd <= 0) as losses,
  case when count(*) > 0 then
    round(count(*) filter (where pnl_usd > 0)::numeric / count(*) * 100, 1)
  else 0 end as win_rate_pct,
  round(coalesce(sum(pnl_usd), 0)::numeric, 4) as total_pnl,
  round(coalesce(avg(pnl_usd), 0)::numeric, 4) as avg_pnl,
  round(coalesce(avg(hold_hours), 0)::numeric, 2) as avg_hold_h
from trades
where exit_at > now() - interval '30 days'
group by exit_reason
order by trades desc;

grant select on v_effectiveness_by_exit_reason to authenticated;

-- Por pool (últimos 30 días)
create or replace view v_effectiveness_by_pool as
select
  coalesce(pool, 'unknown') as pool,
  count(*) as trades,
  count(*) filter (where pnl_usd > 0) as wins,
  count(*) filter (where pnl_usd <= 0) as losses,
  case when count(*) > 0 then
    round(count(*) filter (where pnl_usd > 0)::numeric / count(*) * 100, 1)
  else 0 end as win_rate_pct,
  round(coalesce(sum(pnl_usd), 0)::numeric, 4) as total_pnl,
  round(coalesce(avg(pnl_usd), 0)::numeric, 4) as avg_pnl,
  case when abs(coalesce(sum(pnl_usd) filter (where pnl_usd < 0), 0)) > 0 then
    round((coalesce(sum(pnl_usd) filter (where pnl_usd > 0), 0) /
      abs(coalesce(sum(pnl_usd) filter (where pnl_usd < 0), 0)))::numeric, 2)
  else null end as profit_factor,
  round(coalesce(avg(hold_hours), 0)::numeric, 2) as avg_hold_h
from trades
where exit_at > now() - interval '30 days'
group by pool
order by trades desc;

grant select on v_effectiveness_by_pool to authenticated;

-- Por strategy (últimos 30 días)
create or replace view v_effectiveness_by_strategy as
select
  coalesce(strategy_name, 'unknown') as strategy,
  count(*) as trades,
  count(*) filter (where pnl_usd > 0) as wins,
  count(*) filter (where pnl_usd <= 0) as losses,
  case when count(*) > 0 then
    round(count(*) filter (where pnl_usd > 0)::numeric / count(*) * 100, 1)
  else 0 end as win_rate_pct,
  round(coalesce(sum(pnl_usd), 0)::numeric, 4) as total_pnl,
  round(coalesce(avg(pnl_usd), 0)::numeric, 4) as avg_pnl,
  case when abs(coalesce(sum(pnl_usd) filter (where pnl_usd < 0), 0)) > 0 then
    round((coalesce(sum(pnl_usd) filter (where pnl_usd > 0), 0) /
      abs(coalesce(sum(pnl_usd) filter (where pnl_usd < 0), 0)))::numeric, 2)
  else null end as profit_factor
from trades
where exit_at > now() - interval '30 days'
group by strategy_name
order by trades desc;

grant select on v_effectiveness_by_strategy to authenticated;

-- Por símbolo (últimos 30 días)
create or replace view v_effectiveness_by_symbol as
select
  symbol,
  coalesce(pool, 'unknown') as pool,
  count(*) as trades,
  count(*) filter (where pnl_usd > 0) as wins,
  count(*) filter (where pnl_usd <= 0) as losses,
  case when count(*) > 0 then
    round(count(*) filter (where pnl_usd > 0)::numeric / count(*) * 100, 1)
  else 0 end as win_rate_pct,
  round(coalesce(sum(pnl_usd), 0)::numeric, 4) as total_pnl,
  round(coalesce(avg(pnl_usd), 0)::numeric, 4) as avg_pnl,
  round(coalesce(avg(score_at_entry), 0)::numeric, 1) as avg_score_entry
from trades
where exit_at > now() - interval '30 days'
group by symbol, pool
order by trades desc;

grant select on v_effectiveness_by_symbol to authenticated;
