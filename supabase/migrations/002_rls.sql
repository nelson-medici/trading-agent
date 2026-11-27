-- Trading Agent · Row Level Security
-- 002_rls.sql
-- Configura acceso: usuarios autenticados pueden leer casi todo,
-- el service_role (usado por el engine) tiene acceso completo.

-- Habilitar RLS en todas las tablas
alter table config enable row level security;
alter table config_audit enable row level security;
alter table ohlcv enable row level security;
alter table news enable row level security;
alter table features enable row level security;
alter table scores enable row level security;
alter table decisions enable row level security;
alter table orders enable row level security;
alter table positions enable row level security;
alter table trades enable row level security;
alter table equity_snapshots enable row level security;
alter table capital_events enable row level security;
alter table alerts enable row level security;
alter table heartbeats enable row level security;
alter table kill_switch enable row level security;

-- ============================================================
-- POLICY: usuarios autenticados leen todo
-- ============================================================
-- Este proyecto es single-user (personal). Cualquier usuario autenticado
-- es "el dueño" del sistema. Si en el futuro es multi-user,
-- se agrega un user_id a cada tabla.

create policy "authenticated read all"
  on config for select to authenticated using (true);
create policy "authenticated read all"
  on config_audit for select to authenticated using (true);
create policy "authenticated read all"
  on ohlcv for select to authenticated using (true);
create policy "authenticated read all"
  on news for select to authenticated using (true);
create policy "authenticated read all"
  on features for select to authenticated using (true);
create policy "authenticated read all"
  on scores for select to authenticated using (true);
create policy "authenticated read all"
  on decisions for select to authenticated using (true);
create policy "authenticated read all"
  on orders for select to authenticated using (true);
create policy "authenticated read all"
  on positions for select to authenticated using (true);
create policy "authenticated read all"
  on trades for select to authenticated using (true);
create policy "authenticated read all"
  on equity_snapshots for select to authenticated using (true);
create policy "authenticated read all"
  on capital_events for select to authenticated using (true);
create policy "authenticated read all"
  on alerts for select to authenticated using (true);
create policy "authenticated read all"
  on heartbeats for select to authenticated using (true);
create policy "authenticated read all"
  on kill_switch for select to authenticated using (true);

-- ============================================================
-- POLICY: usuarios autenticados pueden modificar config y controles
-- ============================================================

create policy "authenticated update config"
  on config for update to authenticated using (true) with check (true);

create policy "authenticated insert capital events"
  on capital_events for insert to authenticated with check (true);

create policy "authenticated update alerts (ack)"
  on alerts for update to authenticated using (true) with check (true);

create policy "authenticated update kill switch"
  on kill_switch for update to authenticated using (true) with check (true);

create policy "authenticated confirm decisions"
  on decisions for update to authenticated using (true) with check (true);

-- Nota: el service_role (usado por el engine) hace bypass de RLS por defecto.
-- Por eso el engine puede escribir en todas las tablas sin necesidad de policies específicas.
