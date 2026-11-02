/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  // Inline the build-time commit SHA into the bundle so /api/version reports the
  // SHA the SERVED artifact was built from — independent of any runtime appsetting.
  // This is what defeats the warm-old-instance false-green deploy (fleet WO #143):
  // a stale process serves its own (old) baked SHA, so verify-live-deploy fails red.
  env: {
    GIT_SHA: process.env.GIT_SHA,
  },
  experimental: {
    typedRoutes: true,
  },
};

export default nextConfig;
