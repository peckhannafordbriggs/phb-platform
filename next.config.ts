import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Prisma's engine files are not traceable by the default bundler analysis.
  // Leaving the client external keeps `next build` from inlining it.
  // pdfjs-dist (the Freeze Protection schedule import) is the same: it loads
  // its worker module by path, and bundling it breaks that.
  serverExternalPackages: ["@prisma/client", "pdfjs-dist"],
  devIndicators: false,

  // Emits .next/standalone: server.js plus only the node_modules the traced
  // graph actually reaches. The container copies that instead of installing
  // dependencies again, which is what keeps the runtime image small and its
  // contents a consequence of the build rather than of a second npm install.
  output: "standalone",

  // The blank Freeze Protection verification form is read from disk by its
  // route (served behind the module grant, so not from public/). Nothing
  // imports a PDF, so the tracer would leave it out of the standalone build.
  outputFileTracingIncludes: {
    "/api/modules/freeze-protection/import/form": ["./lib/modules/freeze-protection/import/assets/fp-verification-form.pdf"],
  },
};

export default nextConfig;