import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PGlite (WASM) is loaded only by the local `pglite:memory` dev database; keep it out of the bundle.
  serverExternalPackages: ["@electric-sql/pglite"],
};

export default nextConfig;
