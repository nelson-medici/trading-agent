# Runbook 07 · Drawdown Breach

## Niveles
| Nivel | Trigger | Auto-acción |
|-------|---------|-------------|
| Diario 5% | DD día >5% | Pausa entradas 24h |
| Semanal 8% | DD semana >8% | Modo conservador |
| Total 12% | DD desde HWM >12% | Kill switch |

## Si llegaste al 12%
Algo está mal. No es ruido normal.

### Causas frecuentes
1. Cambio estructural de mercado
2. Bug en sizing (arriesgando más de lo configurado)
3. Correlaciones no detectadas
4. Stops mal calibrados

### Pasos
1. Ir a runbook 05
2. **Postmortem antes de reset**
3. Verificar correlaciones reales de posiciones perdedoras
4. Verificar sizing real vs configurado
5. Considerar 2 semanas más de paper antes de real

### Cuándo bajar target
Si bug pre-existente o régimen cambió:
- Reducir capital a la mitad
- Volver a paper
- Bajar DD limits temporal a 8% total
