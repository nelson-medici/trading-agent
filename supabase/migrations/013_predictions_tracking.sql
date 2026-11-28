-- Prediction tracking: register what the system predicted, evaluate what actually happened
create table predictions (
  id uuid primary key default uuid_generate_v4(),
  symbol text not null,
  pool text,
  source text not null,              -- 'scoring', 'pattern_trigger', 'auto_analyzer', 'scalper'
  source_id text,
  predicted_at timestamptz not null default now(),
  bias text not null,                -- 'bullish', 'bearish', 'neutral'
  confidence numeric,
  price_at_prediction numeric not null,
  expected_target numeric,
  expected_stop numeric,
  expected_move_pct numeric,
  eval_window_hours numeric not null default 4,
  eval_at timestamptz,
  status text not null default 'pending',
  price_at_eval numeric,
  actual_move_pct numeric,
  high_after numeric,
  low_after numeric,
  hit_target boolean,
  hit_stop boolean,
  target_hit_at timestamptz,
  stop_hit_at timestamptz,
  context jsonb not null default '{}',
  notes text,
  created_at timestamptz not null default now()
);

create index idx_predictions_symbol on predictions(symbol);
create index idx_predictions_status on predictions(status);
create index idx_predictions_predicted_at on predictions(predicted_at desc);
create index idx_predictions_source on predictions(source);

alter table predictions enable row level security;
create policy "authenticated read predictions" on predictions for select to authenticated using (true);
create policy "authenticated delete predictions" on predictions for delete to authenticated using (true);
grant delete on predictions to authenticated;
