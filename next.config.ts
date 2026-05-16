import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static export: required for Capacitor to package this as an iPhone app
  // This means the app runs entirely in the browser — no server needed
  output: "export",

  // Disable image optimization (not compatible with static export)
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
