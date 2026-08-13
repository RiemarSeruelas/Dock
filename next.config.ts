import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep Turbopack anchored to this project when a parent folder also has a lockfile.
  turbopack: {
    root: process.cwd(),
  },
  async rewrites() {
    return [{
      source: "/api/:path*",
      destination: `${process.env.API_INTERNAL_URL || "http://localhost:3001"}/api/:path*`,
    }];
  },
};

export default nextConfig;
