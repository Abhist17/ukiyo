// Stand-in for optional packages that a wallet SDK imports only on paths Ukiyo never runs (Coinbase's x402 payment
// helpers, reached through wagmi's connector bundle). Resolving them to an empty module keeps the static build working.
module.exports = {};
