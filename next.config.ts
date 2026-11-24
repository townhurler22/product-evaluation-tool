import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // SEC-12: share pages leak nothing through Referer, are never indexed and never cached.
  async headers() {
    return [{
      source: "/b/:path*",
      headers: [
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "X-Robots-Tag", value: "noindex, nofollow" },
        { key: "Cache-Control", value: "no-store" },
      ],
    }];
  },
};

export default nextConfig;
