/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    // Inyecta el SHA del commit en build time para poder detectar si el deploy
    // llegó a la pestaña del browser. Vercel setea VERCEL_GIT_COMMIT_SHA en cada build.
    NEXT_PUBLIC_COMMIT_SHA: (process.env.VERCEL_GIT_COMMIT_SHA || "dev").slice(0, 7),
    NEXT_PUBLIC_BUILD_TIME: new Date().toISOString(),
  },
};
export default nextConfig;
