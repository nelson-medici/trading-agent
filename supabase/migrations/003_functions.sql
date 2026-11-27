-- Trading Agent · Funciones y triggers
-- 003_functions.sql

-- ============================================================
-- Trigger: auditar cambios de config
-- ============================================================
create or replace function fn_audit_config_change()
returns trigger as $$
begin
  insert into config_audit (config_key, old_value, new_value, changed_by)
  values (
    new.key,
    old.value,
    new.value,
    auth.uid()
  );
  new.updated_at = now();
  new.updated_by = auth.uid();
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists trg_config_audit on config;
create trigger trg_config_audit
  before update on config
  for each row execute function fn_audit_config_change();

-- ============================================================
-- Función: obtener config actual como jsonb
-- ============================================================
create or replace function get_config(config_key text)
returns jsonb as $$
declare
  v_value jsonb;
begin
  select value into v_value from config where key = config_key;
  return v_value;
end;
$$ language plpgsql stable security definer;

-- ============================================================
-- Trigger: actualizar timestamp de positions
-- ============================================================
create or replace function fn_update_position_timestamp()
returns trigger as $$
begin
  new.last_updated = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_positions_timestamp on positions;
create trigger trg_positions_timestamp
  before update on positions
  for each row execute function fn_update_position_timestamp();

-- ============================================================
-- Función: current equity con posiciones valuadas a mercado
-- ============================================================
create or replace function get_current_equity()
returns numeric as $$
declare
  v_last_snapshot numeric;
begin
  select total_equity_usd into v_last_snapshot
  from equity_snapshots
  order by ts desc
  limit 1;

  return coalesce(v_last_snapshot, 0);
end;
$$ language plpgsql stable security definer;

-- ============================================================
-- Función: high water mark (para drawdown)
-- ============================================================
create or replace function get_high_water_mark()
returns numeric as $$
declare
  v_hwm numeric;
begin
  select max(total_equity_usd) into v_hwm from equity_snapshots;
  return coalesce(v_hwm, 0);
end;
$$ language plpgsql stable security definer;

-- ============================================================
-- Vista: dashboard summary
-- ============================================================
create or replace view v_dashboard_summary as
select
  (select total_equity_usd from equity_snapshots order by ts desc limit 1) as current_equity,
  (select high_water_mark from equity_snapshots order by ts desc limit 1) as hwm,
  (select drawdown_from_hwm_pct from equity_snapshots order by ts desc limit 1) as current_dd,
  (select count(*) from positions) as open_positions,
  (select count(*) from scores where state = 'CANDIDATE' and ts > now() - interval '2 hours') as candidates,
  (select count(*) from scores where state = 'WATCHLIST' and ts > now() - interval '2 hours') as watchlist_count,
  (select active from kill_switch where id = 1) as kill_active,
  (select count(*) from alerts where not acknowledged and level in ('warn', 'critical')) as unacked_alerts,
  (select status from heartbeats where service = 'engine' order by reported_at desc limit 1) as engine_status,
  (select reported_at from heartbeats where service = 'engine' order by reported_at desc limit 1) as engine_last_heartbeat;

grant select on v_dashboard_summary to authenticated;

-- ============================================================
-- Vista: performance metrics últimos N días
-- ============================================================
create or replace view v_performance_30d as
with recent_trades as (
  select * from trades where exit_at > now() - interval '30 days'
)
select
  count(*) as total_trades,
  count(*) filter (where pnl_usd > 0) as winning_trades,
  count(*) filter (where pnl_usd < 0) as losing_trades,
  case when count(*) > 0 then
    count(*) filter (where pnl_usd > 0)::numeric / count(*)
    else 0 end as win_rate,
  coalesce(sum(pnl_usd), 0) as total_pnl_usd,
  coalesce(avg(pnl_usd) filter (where pnl_usd > 0), 0) as avg_win_usd,
  coalesce(avg(pnl_usd) filter (where pnl_usd < 0), 0) as avg_loss_usd,
  case when abs(coalesce(sum(pnl_usd) filter (where pnl_usd < 0), 0)) > 0 then
    coalesce(sum(pnl_usd) filter (where pnl_usd > 0), 0) /
    abs(coalesce(sum(pnl_usd) filter (where pnl_usd < 0), 0))
    else 0 end as profit_factor,
  coalesce(avg(hold_hours), 0) as avg_hold_hours
from recent_trades;

grant select on v_performance_30d to authenticated;

-- ============================================================
-- Función: acknowledge alerts en batch
-- ============================================================
create or replace function ack_alerts(alert_ids uuid[])
returns int as $$
declare
  v_count int;
begin
  update alerts
  set acknowledged = true,
      acknowledged_by = auth.uid(),
      acknowledged_at = now()
  where id = any(alert_ids) and not acknowledged;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$ language plpgsql security definer;

grant execute on function ack_alerts to authenticated;
