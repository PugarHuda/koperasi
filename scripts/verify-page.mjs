// The entry of web/verify.mjs (`npm run build:verify`): `npm run verify` as one file, for anyone without a checkout.
//   curl -sO https://koperasi-kohl.vercel.app/verify.mjs && node verify.mjs      (Node 20 or later)
// It reads the deployment, the by-laws file and the gate program from the live page (KOP_PAGE) and every claim from
// NEAR, Ethereum, Base and Arbitrum testnets, exactly as `npm run verify` does from a checkout. CI rebuilds it and fails
// if the file the page serves differs from what this source builds.
process.env.KOP_PAGE ??= "https://koperasi-kohl.vercel.app";
await import("./verify.mjs");
