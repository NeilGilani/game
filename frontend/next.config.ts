import type { NextConfig } from 'next';
const config: NextConfig = {
  // A cold laptop inference request can exceed the proxy's 30-second default.
  experimental: { proxyTimeout: 300_000 },
  async rewrites() {
    return [{ source: '/kernel/:path*', destination: `${process.env.SYNAPSE_API_URL || 'http://127.0.0.1:8000'}/:path*` }];
  },
};
export default config;
