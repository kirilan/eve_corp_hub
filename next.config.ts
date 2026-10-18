import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dev server only trusts localhost by default; developing from another machine means browsing
  // to the dev box by name, which must also be APP_URL (the EVE SSO callback host).
  allowedDevOrigins: process.env.APP_URL ? [new URL(process.env.APP_URL).hostname] : [],
  cacheComponents: true,
  partialPrefetching: true,
  // The income tracker started out as the ratting tracker.
  redirects: async () => [{ source: "/ratting", destination: "/income", permanent: true }],
  images: {
    // CCP's image server already resizes; portraits and logos are served unoptimized from there.
    remotePatterns: [new URL("https://images.evetech.net/**")],
  },
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
