-- Pattern Triggers: patrones en observación con auto-ejecución
create table if not exists pattern_triggers (
  id uuid primary key default uuid_generate_v4(),
  symbol text not null,
  timeframe text not null default '1h',
  pattern_name text not null,
  bias text not null,
  confirmation_rule text not null,
  trigger_type text not null,
  trigger_price numeric,
  trigger_rsi numeric,
  require_volume boolean default true,
  action text not null default 'BUY',
  pool text not null default 'tactical',
  max_capital_usd numeric default 25,
  stop_atr_mult numeric default 2.0,
  target_atr_mult numeric default 4.0,
  status text not null default 'watching',
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  triggered_at timestamptz,
  trigger_detail text,
  decision_id uuid,
  analysis_snapshot jsonb,
  created_by text default 'manual'
);

create index if not exists idx_pattern_triggers_status on pattern_triggers(status);
create index if not exists idx_pattern_triggers_symbol on pattern_triggers(symbol);

alter table pattern_triggers enable row level security;
create policy "auth_read_pattern_triggers" on pattern_triggers for select to authenticated using (true);
create policy "auth_write_pattern_triggers" on pattern_triggers for insert to authenticated with check (true);
create policy "auth_update_pattern_triggers" on pattern_triggers for update to authenticated using (true);
create policy "service_all_pattern_triggers" on pattern_triggers for all to service_role using (true);

grant all on pattern_triggers to authenticated;
grant all on pattern_triggers to service_role;
