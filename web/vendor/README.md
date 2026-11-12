# Vendored browser modules

Served from this site instead of a CDN (security finding S19): a dynamic `import()` cannot carry a subresource
integrity hash, so a compromised CDN could have run code on the page. Git pins these bytes now.

| File | Source | sha256 |
|---|---|---|
| `near-connect-0.12.0.mjs` | https://esm.sh/@hot-labs/near-connect@0.12.0/es2022/near-connect.bundle.mjs | `6000b1a5d9c381a9712b335cb84eafdc4d0995fe3c1135a19167224f58ed7b8c` |
| `dcap-qvl-0.7.1.mjs` | https://esm.sh/@phala/dcap-qvl@0.7.1/es2022/dcap-qvl.bundle.mjs | `4752339ffc0bc5324d8fe72aacd00d34f7f49ffc9d0701a0dec0b3fa7949de75` |
| `noble-sha3-2.2.0.mjs` | `keccak_256` of `@noble/hashes` 2.2.0 (this repo's own dependency), bundled with `npx esbuild` from `export { keccak_256 } from "@noble/hashes/sha3.js"` (`--bundle --format=esm --minify --target=es2022`) | `2fdeaebb7add363269e29e7b93962a82468a9a33d57bc8518749181936b61342` |

Both are self-contained (no imports). To update: download the new bundle from the same path with the new version,
check its diff, and change the import in `web/wallet.js` or `web/tee.js`.

Limit: NEAR Connect still loads each wallet's own code at runtime, in a sandboxed iframe, from the wallet's manifest.
