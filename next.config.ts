import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Prisma's engine files are not traceable by the default bundler analysis.
  // Leaving the client external keeps `next build` from inlining it.
  serverExternalPackages: ["@prisma/client"],
  devIndicators: false,

  // Emits .next/standalone: server.js plus only the node_modules the traced
  // graph actually reaches. The container copies that instead of installing
  // dependencies again, which is what keeps the runtime image small and its
  // contents a consequence of the build rather than of a second npm install.
  output: "standalone",
};

export default nextConfig;