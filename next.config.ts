import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // @cursor/sdk loads Node built-ins and optional native chunks. Bundling it
  // into the server function breaks cloud-agent calls on Vercel.
  serverExternalPackages: ["@cursor/sdk"],
  // The support chat route reads content/faq.md from disk at request time.
  outputFileTracingIncludes: {
    "/api/chat": ["./content/faq.md"],
  },
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
