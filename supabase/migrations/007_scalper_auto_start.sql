-- 007 · Auto-inicio de sesiones de scalper cuando el detector ve una oportunidad
alter table scalper_sessions add column if not exists auto boolean not null default false;

update config
   set value = value || '{"auto_start": {"enabled": true, "duration_min": 30, "capital_usd": 25, "max_trades": 5, "max_sessions_24h": 4, "min_gap_min": 30, "loss_limit_24h_usd": 1.0}}'::jsonb
 where key = 'scalper.config' and not (value ? 'auto_start');
