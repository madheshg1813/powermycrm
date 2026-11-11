/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The browser only ever talks to this origin; API calls are proxied so the refresh cookie stays first-party.
  async rewrites() {
    const api = process.env.API_URL ?? 'http://localhost:4000';
    return [{ source: '/api/:path*', destination: `${api}/api/:path*` }];
  },
};

export default nextConfig;
