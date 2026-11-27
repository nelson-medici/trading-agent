-- Trading Agent · Schema inicial
-- 001_schema.sql
-- Este archivo se corre una sola vez en el SQL Editor de Supabase.

-- Extensiones
create extension if not exists "uuid-ossp";
create extension if not exists pgcrypto;

-- ============================================================
-- CATÁLOGO / CONFIGURACIÓN
-- ============================================================

-- Config vive en la DB. El engine la lee al arrancar y en cada refresh.
create table if not exists config (
  id uuid primary key default uuid_generate_v4(),
  key text unique not null,
  value jsonb not null,
  category text not null,
  description text,
  updated_at timestamptz default now(),
  updated_by uuid references auth.users(id)
);

create index if not exists idx_config_category on config(category);

-- Log de cambios de config para auditoría
create table if not exists config_audit (
  id uuid primary key default uuid_generate_v4(),
  config_key text not null,
  old_value jsonb,
  new_value jsonb,
  changed_by uuid references auth.users(id),
  changed_at timestamptz default now()
);

-- ============================================================
-- DATOS DE MERCADO
-- ============================================================

create table if not exists ohlcv (
  symbol text not null,
  timeframe text not null,           -- '1h', '4h', '1d'
  ts timestamptz not null,
  open numeric not null,
  high numeric not null,
  low numeric not null,
  close numeric not null,
  volume numeric not null,
  primary key (symbol, timeframe, ts)
);

create index if not exists idx_ohlcv_symbol_ts on ohlcv(symbol, ts desc);

-- Noticias procesadas por LLM
create table if not exists news (
  id uuid primary key default uuid_generate_v4(),
  symbol text,                       -- puede ser null si es macro
  source text not null,
  url text unique,
  published_at timestamptz not null,
  title text,
  raw_text text,
  sentiment numeric,                 -- -1..1
  materiality numeric,               -- 0..1
  horizon text,                      -- 'intraday'|'days'|'weeks'|'months'
  themes text[],
  is_rumor boolean,
  summary text,
  processed_at timestamptz default now()
);

create index if not exists idx_news_symbol_published on news(symbol, published_at desc);

-- ============================================================
-- FEATURES Y SCORING
-- ============================================================

create table if not exists features (
  symbol text not null,
  ts timestamptz not null,
  -- Técnicas
  rsi numeric,
  macd numeric,
  macd_signal numeric,
  macd_hist numeric,
  sma_20 numeric,
  sma_50 numeric,
  sma_200 numeric,
  atr numeric,
  adx numeric,
  volume_ratio numeric,              -- vs SMA20 del volumen
  price_above_sma200 boolean,
  distance_to_support_pct numeric,
  distance_to_resistance_pct numeric,
  -- Régimen
  regime text,                       -- 'risk_on'|'risk_off'|'neutral'
  volatility_regime text,            -- 'low'|'medium'|'high'
  btc_dominance numeric,
  fear_greed numeric,
  -- Sentimiento agregado
  sentiment_score numeric,           -- promedio ponderado 7d
  news_count_7d int,
  -- Liquidez
  bid_ask_spread_pct numeric,
  volume_24h_usd numeric,
  -- Eventos
  has_event_in_48h boolean,
  primary key (symbol, ts)
);

create index if not exists idx_features_ts on features(ts desc);

-- ============================================================
-- SCORING Y DECISIONES
-- ============================================================

create table if not exists scores (
  id uuid primary key default uuid_generate_v4(),
  symbol text not null,
  ts timestamptz not null,
  score_total numeric not null,
  score_technical numeric,
  score_fundamental numeric,
  score_sentiment numeric,
  score_risk numeric,
  score_timing numeric,
  state text not null,                -- 'IGNORE'|'WATCHLIST'|'CANDIDATE'|'ENTERED'|'EXIT'
  passes_high_confidence boolean,
  confidence_checks jsonb,            -- detalle de las 9 condiciones
  indicators_aligned int,
  created_at timestamptz default now()
);

create index if not exists idx_scores_symbol_ts on scores(symbol, ts desc);
create index if not exists idx_scores_state on scores(state);

-- Decisiones tomadas por el sistema
create table if not exists decisions (
  id uuid primary key default uuid_generate_v4(),
  symbol text not null,
  action text not null,               -- 'BUY'|'SELL'|'HOLD'|'WATCH'|'AVOID'
  score numeric,
  score_id uuid references scores(id),
  justification text,
  risks text[],
  stop_price numeric,
  target_price numeric,
  size_units numeric,
  notional_usd numeric,
  entry_price numeric,
  status text default 'pending',      -- 'pending'|'approved'|'rejected'|'executed'|'canceled'
  rejected_reason text,
  requires_confirmation boolean default false,
  confirmed_by uuid references auth.users(id),
  confirmed_at timestamptz,
  created_at timestamptz default now(),
  executed_at timestamptz
);

create index if not exists idx_decisions_status on decisions(status);
create index if not exists idx_decisions_created on decisions(created_at desc);

-- ============================================================
-- ÓRDENES Y POSICIONES
-- ============================================================

create table if not exists orders (
  id uuid primary key default uuid_generate_v4(),
  decision_id uuid references decisions(id),
  broker_order_id text,               -- id del lado del broker
  symbol text not null,
  side text not null,                 -- 'BUY'|'SELL'
  size_units numeric not null,
  limit_price numeric,
  stop_price numeric,
  target_price numeric,
  state text not null,                -- 'DRAFTED'|'SUBMITTED'|'PARTIAL'|'FILLED'|'REJECTED'|'CANCELED'|'FAILED'
  filled_units numeric default 0,
  avg_fill_price numeric,
  commission_paid numeric,
  error_message text,
  created_at timestamptz default now(),
  submitted_at timestamptz,
  filled_at timestamptz
);

create index if not exists idx_orders_state on orders(state);
create index if not exists idx_orders_symbol on orders(symbol);

-- Snapshot de posiciones abiertas (denormalizado para el portal)
create table if not exists positions (
  id uuid primary key default uuid_generate_v4(),
  symbol text unique not null,
  side text not null default 'LONG',
  size_units numeric not null,
  entry_price numeric not null,
  current_price numeric,
  stop_price numeric not null,
  target_price numeric not null,
  unrealized_pnl_usd numeric,
  unrealized_pnl_pct numeric,
  allocation_pct numeric,
  score_at_entry numeric,
  current_score numeric,
  opened_at timestamptz default now(),
  last_updated timestamptz default now()
);

-- Historial de posiciones cerradas
create table if not exists trades (
  id uuid primary key default uuid_generate_v4(),
  symbol text not null,
  side text not null,
  size_units numeric not null,
  entry_price numeric not null,
  exit_price numeric not null,
  entry_at timestamptz not null,
  exit_at timestamptz not null,
  pnl_usd numeric not null,
  pnl_pct numeric not null,
  commission_usd numeric,
  exit_reason text,                   -- 'stop'|'target'|'score_broken'|'rotation'|'manual'
  hold_hours numeric,
  score_at_entry numeric,
  score_at_exit numeric
);

create index if not exists idx_trades_exit_at on trades(exit_at desc);

-- ============================================================
-- EQUITY Y CAPITAL
-- ============================================================

create table if not exists equity_snapshots (
  id uuid primary key default uuid_generate_v4(),
  ts timestamptz not null,
  total_equity_usd numeric not null,
  cash_usd numeric not null,
  positions_value_usd numeric not null,
  unrealized_pnl_usd numeric,
  daily_pnl_usd numeric,
  daily_pnl_pct numeric,
  drawdown_from_hwm_pct numeric,
  high_water_mark numeric
);

create index if not exists idx_equity_ts on equity_snapshots(ts desc);

-- Aportes y retiros de capital (top-ups desde el portal)
create table if not exists capital_events (
  id uuid primary key default uuid_generate_v4(),
  event_type text not null,           -- 'deposit'|'withdrawal'
  amount_usd numeric not null,
  balance_after_usd numeric not null,
  notes text,
  performed_by uuid references auth.users(id),
  performed_at timestamptz default now()
);

-- ============================================================
-- MONITOREO Y ALERTAS
-- ============================================================

create table if not exists alerts (
  id uuid primary key default uuid_generate_v4(),
  level text not null,                -- 'info'|'warn'|'critical'
  category text not null,             -- 'system'|'trade'|'risk'|'connectivity'
  title text not null,
  message text,
  metadata jsonb,
  acknowledged boolean default false,
  acknowledged_by uuid references auth.users(id),
  acknowledged_at timestamptz,
  created_at timestamptz default now()
);

create index if not exists idx_alerts_created on alerts(created_at desc);
create index if not exists idx_alerts_ack on alerts(acknowledged, created_at desc);

create table if not exists heartbeats (
  id uuid primary key default uuid_generate_v4(),
  service text not null,              -- 'engine'|'scheduler'|'reconciler'
  status text not null,               -- 'healthy'|'degraded'|'down'
  metrics jsonb,
  reported_at timestamptz default now()
);

create index if not exists idx_heartbeats_service_reported on heartbeats(service, reported_at desc);

-- Kill switch state
create table if not exists kill_switch (
  id int primary key default 1,       -- singleton
  active boolean default false,
  activated_at timestamptz,
  activated_reason text,
  activated_by uuid references auth.users(id),
  deactivated_at timestamptz,
  deactivated_by uuid references auth.users(id),
  constraint singleton_check check (id = 1)
);

-- Insertar row inicial
insert into kill_switch (id, active) values (1, false)
on conflict (id) do nothing;

-- ============================================================
-- SEED CONFIG DEFAULTS
-- ============================================================

insert into config (key, value, category, description) values
  ('strategy.weights',
   '{"technical": 0.40, "fundamental": 0.20, "sentiment": 0.15, "risk": 0.15, "timing": 0.10}'::jsonb,
   'strategy',
   'Pesos del scoring; deben sumar 1.0'),
  ('strategy.thresholds',
   '{"ignore_below": 60, "watchlist": 60, "candidate": 75, "aggressive": 85}'::jsonb,
   'strategy',
   'Umbrales de score para cada estado'),
  ('strategy.confidence',
   '{"required_signals": 3, "sustained_periods": 2}'::jsonb,
   'strategy',
   'Validación de alta convicción'),
  ('risk.limits',
   '{"max_risk_per_trade_pct": 0.01, "max_position_pct": 0.20, "max_position_btc_eth_pct": 0.30, "max_class_exposure_pct": 0.60, "max_open_positions": 2, "min_position_size_usd": 15}'::jsonb,
   'risk',
   'Límites de exposición y sizing'),
  ('risk.drawdown',
   '{"daily_pause_pct": 0.05, "weekly_conservative_pct": 0.08, "total_kill_pct": 0.12}'::jsonb,
   'risk',
   'Circuit breakers de drawdown'),
  ('risk.stops',
   '{"atr_stop_multiplier": 2.0, "atr_target_multiplier": 4.0, "min_profit_to_commission_ratio": 3.0}'::jsonb,
   'risk',
   'Cálculo de stops y targets'),
  ('execution.broker',
   '{"broker": "paper", "commission_per_side_pct": 0.001, "slippage_pct": 0.0005, "order_type": "limit", "limit_offset_bps": 5, "fill_timeout_seconds": 60, "max_retries": 3}'::jsonb,
   'execution',
   'Configuración del broker'),
  ('execution.confirmation',
   '{"mode": false, "timeout_minutes": 10}'::jsonb,
   'execution',
   'Modo de confirmación humana'),
  ('universe.crypto',
   '["BTC/USDT", "ETH/USDT"]'::jsonb,
   'universe',
   'Activos habilitados para operar'),
  ('universe.excluded_keywords',
   '["meme", "shib", "doge", "pepe", "inu", "moon"]'::jsonb,
   'universe',
   'Palabras que excluyen automáticamente'),
  ('llm.sentiment',
   '{"provider": "anthropic", "model": "claude-haiku-4-5", "max_tokens": 512, "temperature": 0.0, "cache_enabled": true}'::jsonb,
   'llm',
   'Modelo para análisis de sentimiento'),
  ('llm.narrative',
   '{"provider": "anthropic", "model": "claude-sonnet-4-6", "max_tokens": 1024, "temperature": 0.2, "cache_enabled": false}'::jsonb,
   'llm',
   'Modelo para reportes y narrativas'),
  ('llm.fallback_chain',
   '["claude-haiku-4-5", "groq-llama-3.3-70b"]'::jsonb,
   'llm',
   'Cadena de fallback si el primario falla'),
  ('system.env',
   '{"env": "dev", "log_level": "INFO", "timezone": "UTC"}'::jsonb,
   'system',
   'Entorno del sistema')
on conflict (key) do nothing;
