-- ============================================================
-- Garantiza columnas usadas por la vista /history
-- (pool y strategy_name se agregaron en vivo; la migración fija el contrato)
-- ============================================================

alter table trades
  add column if not exists pool text default 'core',
  add column if not exists strategy_name text;

create index if not exists idx_trades_pool on trades(pool);
create index if not exists idx_trades_strategy on trades(strategy_name);
create index if not exists idx_trades_exit_reason on trades(exit_reason);
