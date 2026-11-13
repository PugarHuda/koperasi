// EIP-1559 transactions (type 2) for the co-op's Ethereum address (NEAR Chain Signatures), shared by the page and
// scripts/chainsig.mjs: RLP by hand, keccak-256 from the vendored @noble/hashes, no Ethereum library. Pure functions.
import { keccak_256 } from "./vendor/noble-sha3-2.2.0.mjs";

export const SEPOLIA = { chainId: 11155111n, rpcs: ["https://ethereum-sepolia-rpc.publicnode.com", "https://sepolia.drpc.org"], explorer: "https://sepolia.etherscan.io/tx/" };
/** secp256k1's group order: s above half of it is flipped to the low half (EIP-2). */
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

export const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h) => Uint8Array.from((h.replace(/^0x/, "").match(/../g) ?? []).map((x) => parseInt(x, 16)));
const concat = (...xs) => {
  const out = new Uint8Array(xs.reduce((n, x) => n + x.length, 0));
  let i = 0;
  for (const x of xs) { out.set(x, i); i += x.length; }
  return out;
};
const bytesOf = (v) => {
  if (typeof v === "bigint") { const h = v === 0n ? "" : v.toString(16); return fromHex(h.length % 2 ? `0${h}` : h); }
  return v instanceof Uint8Array ? v : fromHex(v);
};

/** RLP of a byte string, a 0x hex string, a bigint, or a (nested) list of them. */
export function rlp(x) {
  const len = (n, base) => {
    if (n < 56) return Uint8Array.of(base + n);
    const b = bytesOf(BigInt(n));
    return concat(Uint8Array.of(base + 55 + b.length), b);
  };
  if (Array.isArray(x)) { const body = concat(...x.map(rlp)); return concat(len(body.length, 0xc0), body); }
  const b = bytesOf(x);
  return b.length === 1 && b[0] < 0x80 ? b : concat(len(b.length, 0x80), b);
}

const fields = (t) => [t.chainId, t.nonce, t.maxPriorityFeePerGas, t.maxFeePerGas, t.gas, t.to, t.value, "0x", []];
/** The hash the key signs: keccak256(0x02 || rlp(fields)). */
export const txHash = (t) => keccak_256(concat(Uint8Array.of(2), rlp(fields(t))));

/** The signed raw transaction from the MPC response {big_r: {affine_point}, s: {scalar}, recovery_id}; low s (EIP-2). */
export function rawTx(t, sig) {
  let s = BigInt(`0x${sig.s.scalar}`), y = BigInt(sig.recovery_id);
  if (s > N / 2n) { s = N - s; y ^= 1n; }
  const r = BigInt(`0x${sig.big_r.affine_point.slice(2)}`);
  return `0x02${toHex(rlp([...fields(t), y, r, s]))}`;
}
/** The Ethereum transaction hash of a raw transaction. */
export const rawHash = (raw) => `0x${toHex(keccak_256(fromHex(raw)))}`;

/**
 * A transfer's fields as text, for the proposal the members vote on: anyone can rebuild the hash from them.
 * @param {{ chainId: bigint, nonce: bigint, maxPriorityFeePerGas: bigint, maxFeePerGas: bigint, gas: bigint, to: string, value: bigint }} t
 */
export const txText = (t) => JSON.stringify(Object.fromEntries(Object.entries(t).map(([k, v]) => [k, String(v)])));
/** Every `tx {…}` in a description, in order (a batch of payments signed in one vote); only Sepolia transactions. */
export function txsFromText(description) {
  const re = /tx (\{"chainId":"11155111","nonce":"\d+","maxPriorityFeePerGas":"\d+","maxFeePerGas":"\d+","gas":"\d+","to":"0x[0-9a-f]{40}","value":"\d+"\})/g;
  return [...String(description).matchAll(re)].map((m) => txFromText(`tx ${m[1]}`));
}

/** The fields back from a proposal's description (`tx {…}`), or null; only a Sepolia transaction (chain id 11155111). */
export function txFromText(description) {
  const m = /tx (\{"chainId":"11155111","nonce":"\d+","maxPriorityFeePerGas":"\d+","maxFeePerGas":"\d+","gas":"\d+","to":"0x[0-9a-f]{40}","value":"\d+"\})/.exec(String(description));
  if (!m) return null;
  const j = JSON.parse(m[1]);
  return { chainId: BigInt(j.chainId), nonce: BigInt(j.nonce), maxPriorityFeePerGas: BigInt(j.maxPriorityFeePerGas),
    maxFeePerGas: BigInt(j.maxFeePerGas), gas: BigInt(j.gas), to: j.to, value: BigInt(j.value) };
}

/** The most a payment may offer for gas, in wei: the fees `transfer` sets (5 gwei max, 1 gwei tip) and 100 000 gas. */
export const MAX_FEE_WEI = 5_000_000_000n * 100_000n;
/** A transaction the page shows as a plain payment: Sepolia, no fee above what `transfer` sets. */
export const plainPayment = (t) => t.chainId === SEPOLIA.chainId && t.maxPriorityFeePerGas <= t.maxFeePerGas
  && t.maxFeePerGas <= 5_000_000_000n && t.gas * t.maxFeePerGas <= MAX_FEE_WEI;

/** A JSON-RPC call to Sepolia, on each RPC in turn. */
export async function eth(method, params) {
  let last;
  for (const url of SEPOLIA.rpcs) {
    try {
      const j = await (await fetch(url, { method: "POST", signal: AbortSignal.timeout(20_000), headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
      if (j.error) throw Object.assign(new Error(`${method}: ${j.error.message}`), { final: true });
      return j.result;
    } catch (e) {
      if (e.final) throw e;
      last = e;
    }
  }
  throw last;
}

/** A payment of `wei` from `from` to `to`, ready to sign: nonce and gas from Sepolia (gas +20%: a new account costs more). */
export async function transfer(from, to, wei) {
  const gas = (BigInt(await eth("eth_estimateGas", [{ from, to, value: `0x${wei.toString(16)}` }])) * 12n) / 10n;
  return { chainId: SEPOLIA.chainId, nonce: BigInt(await eth("eth_getTransactionCount", [from, "latest"])),
    maxPriorityFeePerGas: 1_000_000_000n, maxFeePerGas: 5_000_000_000n, gas, to: to.toLowerCase(), value: wei };
}
