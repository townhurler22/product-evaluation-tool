import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PGlite (WASM) is loaded only by the local `pglite:memory` dev database; keep it out of the bundle.
  serverExternalPackages: ["@electric-sql/pglite"],
  // SEC-12: share pages leak nothing through Referer, are never indexed and never cached.
  async headers() {
    const shareHeaders = [
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "X-Robots-Tag", value: "noindex, nofollow" },
      { key: "Cache-Control", value: "no-store" },
    ];
    return [
      { source: "/b/:path*", headers: shareHeaders },
      { source: "/f/:path*", headers: shareHeaders }, // public forum (FH-1201)
    ];
  },
};

export default nextConfig;
