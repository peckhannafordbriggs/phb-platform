import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Prisma's engine files are not traceable by the default bundler analysis.
  // Leaving the client external keeps `next build` from inlining it.
  serverExternalPackages: ["@prisma/client"],
  devIndicators: false,
};

export default nextConfig;