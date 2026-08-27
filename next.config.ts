import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdf-parse/mammoth do Node-specific things that don't play well with
  // being bundled by Next's server compiler - run them as plain Node
  // dependencies instead.
  serverExternalPackages: ["pdf-parse", "mammoth"],
};

export default nextConfig;
