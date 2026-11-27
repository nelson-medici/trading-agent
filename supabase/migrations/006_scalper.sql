-- ============================================================
-- 006 · Scalper manual + detector de oportunidades
-- ============================================================

-- Sesiones de scalping. El portal inserta una fila en 'requested';
-- el engine la toma, la pasa a 'active' y la cierra con un motivo.
create table if not exists scalper_sessions (
  id uuid primary key default uuid_generate_v4(),
  symbol text not null,
  strategy text not null default 'scalper_momentum_1m',
  duration_min integer not null default 30,
  max_capital_usd numeric not null default 25,
  max_trades integer not null default 5,
  status text not null default 'requested',  -- requested | active | completed | stopped | rejected
  stop_reason text,          -- time_expired | max_trades | loss_limit | consecutive_losses |
                             -- profit_lock | regime_deteriorated | flash_crash | kill_switch |
                             -- manual | engine_offline | <motivo de rechazo>
  stop_detail text,
  stop_requested boolean not null default false,  -- lo setea el portal ("Detener ahora")
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  ends_at timestamptz,
  ended_at timestamptz,
  capital_usd numeric,                 -- capital efectivo (puede ser < max si no hay cash)
  trades_count integer not null default 0,
  wins integer not null default 0,
  losses integer not null default 0,
  consecutive_losses integer not null default 0,
  realized_pnl_usd numeric not null default 0,
  peak_pnl_usd numeric not null default 0,
  last_score numeric,
  low_score_streak integer not null default 0,
  last_note text,                      -- por qué no entró / qué está esperando
  last_tick_at timestamptz,
  cooldown_until timestamptz,
  params jsonb not null default '{}'::jsonb
);
create index if not exists idx_scalper_sessions_status on scalper_sessions(status);
create index if not exists idx_scalper_sessions_requested on scalper_sessions(requested_at desc);

-- Trades del scalper (abiertos y cerrados). Al cerrar también se copia a `trades`.
create table if not exists scalper_trades (
  id uuid primary key default uuid_generate_v4(),
  session_id uuid not null references scalper_sessions(id) on delete cascade,
  symbol text not null,
  status text not null default 'open',   -- open | closed
  size_units numeric not null,
  entry_price numeric not null,
  initial_stop numeric not null,
  stop_price numeric not null,
  target_price numeric not null,
  high_water numeric not null,
  last_price numeric,
  breakeven_moved boolean not null default false,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  exit_price numeric,
  exit_reason text,                      -- stop | breakeven_stop | trailing_stop | target | time_stop | session_end
  pnl_usd numeric,
  pnl_pct numeric,
  commission_usd numeric,
  entry_reason text
);
create index if not exists idx_scalper_trades_session on scalper_trades(session_id, opened_at desc);

-- Radar: último scalp-score por símbolo (upsert)
create table if not exists scalper_scan (
  symbol text primary key,
  score numeric not null,
  components jsonb not null default '{}'::jsonb,
  price numeric,
  note text,
  updated_at timestamptz not null default now()
);

-- Oportunidades notificadas (historial + cooldown)
create table if not exists scalper_opportunities (
  id uuid primary key default uuid_generate_v4(),
  symbol text not null,
  score numeric not null,
  components jsonb not null default '{}'::jsonb,
  price numeric,
  detected_at timestamptz not null default now()
);
create index if not exists idx_scalper_opps_symbol on scalper_opportunities(symbol, detected_at desc);

-- RLS
alter table scalper_sessions enable row level security;
alter table scalper_trades enable row level security;
alter table scalper_scan enable row level security;
alter table scalper_opportunities enable row level security;

drop policy if exists "authenticated read all" on scalper_sessions;
create policy "authenticated read all" on scalper_sessions for select to authenticated using (true);
drop policy if exists "authenticated insert" on scalper_sessions;
create policy "authenticated insert" on scalper_sessions for insert to authenticated with check (status = 'requested');
drop policy if exists "authenticated update" on scalper_sessions;
create policy "authenticated update" on scalper_sessions for update to authenticated using (true) with check (true);

drop policy if exists "authenticated read all" on scalper_trades;
create policy "authenticated read all" on scalper_trades for select to authenticated using (true);
drop policy if exists "authenticated read all" on scalper_scan;
create policy "authenticated read all" on scalper_scan for select to authenticated using (true);
drop policy if exists "authenticated read all" on scalper_opportunities;
create policy "authenticated read all" on scalper_opportunities for select to authenticated using (true);

grant select, insert, update on scalper_sessions to authenticated;
grant select on scalper_trades, scalper_scan, scalper_opportunities to authenticated;
grant all on scalper_sessions, scalper_trades, scalper_scan, scalper_opportunities to service_role;

-- Una sola sesión viva (requested/active) a la vez
create unique index if not exists uq_scalper_one_live
  on scalper_sessions ((true)) where status in ('requested', 'active');

-- Config por defecto (editable desde /config)
insert into config (key, value, category, description) values ('scalper.config', '{
  "detector_enabled": true,
  "watchlist": ["BTC/USDT","ETH/USDT","SOL/USDT","BNB/USDT","AVAX/USDT","LINK/USDT","DOT/USDT","ARB/USDT"],
  "alert_threshold": 75,
  "alert_cooldown_min": 60,
  "capital_pool": "tactical",
  "breakout_lookback": 15,
  "volume_mult": 1.5,
  "max_spread_pct": 0.0005,
  "risk_atr_mult": 1.5,
  "min_risk_pct": 0.003,
  "max_risk_pct": 0.006,
  "target_rr": 2.0,
  "commission_per_side_pct": 0.001,
  "time_stop_min": 10,
  "cooldown_after_loss_min": 3,
  "max_consecutive_losses": 2,
  "max_session_loss_pct": 0.02,
  "profit_lock_trigger_pct": 0.015,
  "profit_lock_giveback": 0.5,
  "min_regime_score": 40,
  "regime_streak_to_stop": 3,
  "flash_crash_pct": 0.015
}'::jsonb, 'scalper', 'Scalper manual: detector de oportunidades, reglas de entrada, gestión del trade y cortes de sesión')
on conflict (key) do nothing;
