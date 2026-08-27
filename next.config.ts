import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdf-parse/mammoth do Node-specific things that don't play well with
  // being bundled by Next's server compiler - run them as plain Node
  // dependencies instead. jsdom is deliberately NOT here: excluding it from
  // bundling means Node's own require() loads it directly at runtime, and
  // jsdom's dependency chain (html-encoding-sniffer -> @exodus/bytes) ships
  // an ES-only module that raw require() can't load (ERR_REQUIRE_ESM) -
  // Next's bundler handles that interop correctly, raw Node require() does
  // not.
  serverExternalPackages: ["pdf-parse", "mammoth"],
};

export default nextConfig;
