# Portal

Frontend Next.js del Trading Agent.

## Dev

```bash
npm install
cp .env.example .env.local
# Editar .env.local con credenciales de Supabase
npm run dev
```

Abre http://localhost:3000

## Deploy a Vercel

1. Push del repo a GitHub
2. Vercel: importar el repo, root directory `portal`
3. Env vars: mismas que .env.local
4. Deploy

## Estructura

- `app/` - App router de Next.js 14
- `components/` - React components reutilizables
- `lib/` - Utils (supabase client, etc)
- `styles/` - Global CSS

## Vistas

- `/` - Overview (equity, posiciones, salud del sistema)
- `/portfolio` - Portafolio detallado
- `/decisions` - Decisiones y scoring
- `/config` - Configuración editable en vivo
- `/control` - Kill switch, fases, logs
