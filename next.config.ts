import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  // @cursor/sdk loads Node built-ins and optional native chunks. Bundling it
  // into the server function breaks cloud-agent calls on Vercel.
  // next/headers stays external so the Auth0 session cookie is read from disk.
  serverExternalPackages: ["@cursor/sdk", "@auth0/nextjs-auth0", "@octokit/rest", "next/headers"],
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
