-- Sentiment signals: contrato fijo de I/O para la capa de sentimiento.
-- Cualquier fuente (manual, LLM, modelo propio) escribe aquí con el mismo formato.
-- El engine lee de aquí sin importar quién generó la señal.

create table if not exists sentiment_signals (
  id uuid primary key default uuid_generate_v4(),

  -- Qué activo afecta (null = mercado general)
  symbol text,

  -- Score normalizado: -1.0 (extremo bearish) a +1.0 (extremo bullish)
  score numeric not null check (score >= -1 and score <= 1),

  -- Impacto estimado en el precio
  impact text not null default 'low' check (impact in ('critical', 'high', 'moderate', 'low')),

  -- Modificador: cuánto ajustar el score contextual (en puntos, -100 a +100)
  modifier int not null default 0 check (modifier >= -100 and modifier <= 100),

  -- Fuente: quién generó esta señal
  source text not null default 'manual'
    check (source in ('manual', 'conversation', 'script', 'llm_api', 'custom_model', 'feed')),

  -- Evento/razón en texto libre
  event text not null,

  -- Detalles adicionales (JSON libre para metadata de la fuente)
  metadata jsonb default '{}',

  -- Vigencia
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),

  -- Estado
  status text not null default 'active' check (status in ('active', 'expired', 'dismissed')),

  -- Quién lo creó (user, system, llm, etc.)
  created_by text default 'manual'
);

create index if not exists idx_sentiment_status on sentiment_signals(status);
create index if not exists idx_sentiment_symbol on sentiment_signals(symbol);
create index if not exists idx_sentiment_expires on sentiment_signals(expires_at);

alter table sentiment_signals enable row level security;
create policy "auth_read_sentiment" on sentiment_signals for select to authenticated using (true);
create policy "auth_write_sentiment" on sentiment_signals for insert to authenticated with check (true);
create policy "auth_update_sentiment" on sentiment_signals for update to authenticated using (true);
create policy "service_all_sentiment" on sentiment_signals for all to service_role using (true);

grant all on sentiment_signals to authenticated;
grant all on sentiment_signals to service_role;
