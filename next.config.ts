import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // These do Node-specific things (dynamic requires, native-ish parsing) that
  // don't play well with being bundled by Next's server compiler - run them
  // as plain Node dependencies instead.
  serverExternalPackages: ["pdf-parse", "mammoth", "jsdom"],
};

export default nextConfig;
