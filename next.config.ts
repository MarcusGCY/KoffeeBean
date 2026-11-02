import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // @cursor/sdk loads Node built-ins and optional native chunks. Bundling it
  // into the server function breaks cloud-agent calls on Vercel.
  serverExternalPackages: [
    "@cursor/sdk",
    "@grok/agent-sdk",
    // Loaded from disk by the support agent. Bundling them drops files the
    // runtime require()s. Next accepts `next/headers` here as well.
    "@auth0/nextjs-auth0",
    "@octokit/rest",
    "tsx",
    "next/headers",
  ],
  // The support process loads these files from disk at request time.
  // The nested SDK looks up its ripgrep and tree-sitter binaries beside itself;
  // the file tracer does not follow that optional package on its own.
  outputFileTracingIncludes: {
    "/api/chat": [
      "./support-agent/**/*",
      "./scripts/support-serve.mjs",
      "./content/faq.md",
      "./src/lib/**",
      "./src/data/**",
      "./tsconfig.json",
      "./node_modules/tsx/**/*",
      "./node_modules/esbuild/**/*",
      "./node_modules/@esbuild/**/*",
      "./node_modules/@grok/agent-sdk/node_modules/@cursor/sdk-linux-x64/**/*",
      "./node_modules/@cursor/sdk-linux-x64/**/*",
    ],
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
