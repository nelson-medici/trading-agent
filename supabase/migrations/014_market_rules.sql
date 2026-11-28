create table market_rules (
  id text primary key,
  description text not null,
  conditions jsonb not null default '{}',
  action text not null,
  action_params jsonb not null default '{}',
  evidence jsonb not null default '{}',
  sample_size int not null default 0,
  win_rate_with numeric,
  win_rate_without numeric,
  confidence text not null default 'hypothesis',
  applies_to text[] default '{}',
  vertical text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  last_validated timestamptz,
  validated_count int not null default 0,
  notes text
);

create table control_flags (
  name text primary key,
  active boolean not null default true,
  reason text not null,
  action text not null,
  source_rule text references market_rules(id),
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

alter table market_rules enable row level security;
alter table control_flags enable row level security;
create policy "authenticated read market_rules" on market_rules for select to authenticated using (true);
create policy "authenticated read control_flags" on control_flags for select to authenticated using (true);
