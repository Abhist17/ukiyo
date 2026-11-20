import type { NextConfig } from "next";

// Static export: the site is plain files, so it can be hosted anywhere (GitHub Pages sets NEXT_PUBLIC_BASE_PATH).
const config: NextConfig = {
  output: "export",
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || "",
  images: { unoptimized: true },
};

export default config;
