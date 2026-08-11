import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep Turbopack anchored to this project when a parent folder also has a lockfile.
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
