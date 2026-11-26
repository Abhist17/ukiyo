import type { NextConfig } from "next";

// Optional packages a wallet SDK imports only on code paths the app never runs (see src/lib/optional-stub.cjs).
const STUB = "./src/lib/optional-stub.cjs";

// Static export: the site is plain files, so it can be hosted anywhere (GitHub Pages sets NEXT_PUBLIC_BASE_PATH).
const config: NextConfig = {
  output: "export",
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || "",
  images: { unoptimized: true },
  trailingSlash: true,
  turbopack: {
    resolveAlias: {
    "@x402/core/client": STUB,
    "@x402/core/schemas": STUB,
    "@x402/core/server": STUB,
    "@x402/evm": STUB,
    "@x402/evm/auth-capture/client": STUB,
    "@x402/evm/batch-settlement/client": STUB,
    "@x402/evm/exact/client": STUB,
    "@x402/evm/exact/server": STUB,
    "@x402/evm/exact/v1/client": STUB,
    "@x402/evm/upto/client": STUB,
    "@x402/evm/upto/server": STUB,
    "@x402/express": STUB,
    "@x402/extensions/bazaar": STUB,
    "@x402/extensions/builder-code": STUB,
    "@x402/fetch": STUB,
    "@x402/svm/exact/client": STUB,
    "@x402/svm/exact/server": STUB,
    "@x402/svm/exact/v1/client": STUB,
    "@x402/svm/upto/client": STUB,
    "@x402/svm/upto/server": STUB,
    },
  },
};

export default config;
