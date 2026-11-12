// node scripts/chainsig.mjs                  the DAO's Ethereum address (NEAR Chain Signatures), and what it signed so far
// node scripts/chainsig.mjs --sign           members vote that the DAO signs the statement below; the signature is saved
// node scripts/chainsig.mjs --tx <to> <ETH>  members vote that the DAO signs a Sepolia transfer from its address; the
//                                            signed transaction is saved (no "to": bob's own Chain Signatures address)
// node scripts/chainsig.mjs --broadcast      send the saved transaction to Sepolia (anyone may: the vote already signed it;
//                                            the DAO's address needs Sepolia ETH for the transfer and its gas)
//
// The co-op holds an Ethereum address with no private key anywhere: NEAR's MPC network (v1.signer-prod.testnet) derives
// it from the DAO's account and a path, and signs for it only when the DAO itself calls `sign`, which a Sputnik DAO does
// only by a members' vote. The statement is an EIP-191 message, so any Ethereum tool can recover the signer.
import fs from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { baseDecode } from "near-api-js";
import { DEPLOYMENT, NETWORK, account, propose, txUrl, view, vote } from "./lib.mjs";

export const SIGNER = NETWORK === "mainnet" ? "v1.signer" : "v1.signer-prod.testnet";
export const PATH = "ethereum-1";
export const SEPOLIA = { chainId: 11155111n, rpc: "https://ethereum-sepolia-rpc.publicnode.com", explorer: "https://sepolia.etherscan.io/tx/" };
const dep = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));

const hex = (b) => Buffer.from(b).toString("hex");
const addressOf = (xy) => "0x" + hex(keccak_256(xy)).slice(24);
export const statement = (dao, address) =>
  `Koperasi co-op ${dao} holds ${address} through NEAR Chain Signatures (path ${PATH}); it signs only by a members' vote.`;
export const eip191 = (msg) => keccak_256(Buffer.from(`\x19Ethereum Signed Message:\n${Buffer.byteLength(msg)}${msg}`));

export async function daoAddress(dao, path = PATH) {
  const pk = await view(SIGNER, "derived_public_key", { path, predecessor: dao, domain_id: 0 });
  return addressOf(baseDecode(pk.split(":")[1]));
}

/** The address that signed a 32-byte hash, from the MPC response {big_r: {affine_point}, s: {scalar}, recovery_id}. */
export const recover = (hash, sig) => {
  const rs = Buffer.from(sig.big_r.affine_point.slice(2) + sig.s.scalar, "hex");
  const pub = secp256k1.recoverPublicKey(Uint8Array.from([sig.recovery_id, ...rs]), hash, { prehash: false });
  return addressOf(secp256k1.Point.fromBytes(pub).toBytes(false).subarray(1));
};
/** The address that signed `msg` (EIP-191). */
export const signerOf = (msg, sig) => recover(eip191(msg), sig);

// ---------- EIP-1559 transactions (type 2), RLP by hand: a few lines, no Ethereum library ----------
const bytesOf = (v) => {
  if (typeof v === "bigint") { const h = v === 0n ? "" : v.toString(16); return Buffer.from(h.length % 2 ? `0${h}` : h, "hex"); }
  return Buffer.from(v.replace(/^0x/, ""), "hex");
};
export function rlp(x) {
  const len = (n, base) => {
    if (n < 56) return Buffer.from([base + n]);
    const b = bytesOf(BigInt(n));
    return Buffer.concat([Buffer.from([base + 55 + b.length]), b]);
  };
  if (Array.isArray(x)) { const body = Buffer.concat(x.map(rlp)); return Buffer.concat([len(body.length, 0xc0), body]); }
  const b = Buffer.isBuffer(x) ? x : bytesOf(x);
  return b.length === 1 && b[0] < 0x80 ? b : Buffer.concat([len(b.length, 0x80), b]);
}
const fields = (t) => [t.chainId, t.nonce, t.maxPriorityFeePerGas, t.maxFeePerGas, t.gas, t.to, t.value, "0x", []];
/** The hash the key signs: keccak256(0x02 || rlp(fields)). */
export const txHash = (t) => keccak_256(Buffer.concat([Buffer.from([2]), rlp(fields(t))]));
const N = secp256k1.Point.CURVE().n;
/** The signed raw transaction; s is normalized to the low half (EIP-2), flipping the parity with it. */
export function rawTx(t, sig) {
  let s = BigInt(`0x${sig.s.scalar}`), y = BigInt(sig.recovery_id);
  if (s > N / 2n) { s = N - s; y ^= 1n; }
  const r = BigInt(`0x${sig.big_r.affine_point.slice(2)}`);
  return `0x02${hex(rlp([...fields(t), y, r, s]))}`;
}
const eth = async (method, params) => {
  const j = await (await fetch(SEPOLIA.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
};

/** Members vote that the DAO asks the MPC network to sign `hash`; returns the proposal, the vote's tx and the signature. */
export async function signByVote(hash, description) {
  const args = { request: { payload_v2: { Ecdsa: hex(hash) }, path: PATH, domain_id: 0 } };
  const kind = { FunctionCall: { receiver_id: SIGNER, actions: [{
    method_name: "sign", args: Buffer.from(JSON.stringify(args)).toString("base64"), deposit: "1", gas: String(100n * 10n ** 12n) }] } };
  const members = ["kop-alice-mw4i3w8f.testnet", "kop-bob-mw4i3w8f.testnet", "kop-steward-mw4i2iwk.testnet", "vouched-mwa7jwhw.kop-publisher-mw5tkpfo.testnet"];
  const id = await propose(account(members[0]), dep.dao, description, kind);
  console.log("proposal", id);
  let sig, tx;
  for (const m of members) {
    await new Promise((ok) => setTimeout(ok, 2000)); // the next RPC may not have the proposal yet
    if ((await view(dep.dao, "get_proposal", { id })).status !== "InProgress") break;
    const r = await vote(account(m), dep.dao, id);
    console.log(m, "approved", r?.transaction ? txUrl(r.transaction.hash) : "");
    if (!r?.transaction) continue;
    tx = r.transaction.hash;
    // the MPC network answers the DAO's call within the vote's transaction (yield/resume)
    const full = await (await fetch("https://rpc.testnet.fastnear.com", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "EXPERIMENTAL_tx_status", params: { tx_hash: tx, sender_account_id: m, wait_until: "FINAL" } }) })).json().then((j) => j.result);
    for (const o of full?.receipts_outcome ?? []) {
      const v = o.outcome.status?.SuccessValue;
      if (o.outcome.executor_id === SIGNER && v) {
        const j = JSON.parse(Buffer.from(v, "base64").toString());
        if (j.big_r) sig = j;
      }
    }
  }
  if (!sig) throw new Error(`no signature found in ${tx}: read it on the explorer`);
  return { id, tx, sig };
}

const main = import.meta.main;
const address = main ? await daoAddress(dep.dao) : null; // imported by verify.mjs for the helpers only
const save = () => fs.writeFileSync(DEPLOYMENT, JSON.stringify(dep, null, 2) + "\n");
if (main) console.log(`DAO ${dep.dao}\nEthereum address ${address} (MPC ${SIGNER}, path ${PATH})`);

if (main && process.argv.includes("--sign")) {
  const msg = statement(dep.dao, address);
  const { id, tx, sig } = await signByVote(eip191(msg), `Sign with the co-op's Ethereum address (NEAR Chain Signatures): "${msg}"`);
  const recovered = signerOf(msg, sig);
  if (recovered !== address) throw new Error(`the signature recovers ${recovered}, not ${address}`);
  dep.chainSignatures = { ...dep.chainSignatures, signer: SIGNER, path: PATH, address, message: msg, proposal: id, tx, signature: sig };
  save();
  console.log(`signed by vote #${id}; recovers ${recovered}: the co-op's address. Saved in ${DEPLOYMENT}`);
} else if (main && process.argv.includes("--tx")) {
  const i = process.argv.indexOf("--tx");
  const to = process.argv[i + 1]?.startsWith("0x") ? process.argv[i + 1].toLowerCase() : await daoAddress("kop-bob-mw4i3w8f.testnet");
  const amount = Number(process.argv[i + 1]?.startsWith("0x") ? process.argv[i + 2] : process.argv[i + 1]) || 0.001;
  if (!/^0x[0-9a-f]{40}$/.test(to)) throw new Error(`not an Ethereum address: ${to}`);
  // fees with room: the vote signs now, the transfer may be broadcast later; unused fee is not charged (EIP-1559)
  const t = { chainId: SEPOLIA.chainId, nonce: BigInt(await eth("eth_getTransactionCount", [address, "latest"])),
    maxPriorityFeePerGas: 2_000_000_000n, maxFeePerGas: 30_000_000_000n, gas: 21_000n, to, value: BigInt(Math.round(amount * 1e6)) * 10n ** 12n };
  const what = `Pay ${amount} Sepolia ETH from the co-op's Ethereum address ${address} to ${to}${to === await daoAddress("kop-bob-mw4i3w8f.testnet") ? " (bob's own Chain Signatures address)" : ""}: sign the EIP-1559 transaction (nonce ${t.nonce}, NEAR Chain Signatures)`;
  const { id, tx, sig } = await signByVote(txHash(t), what);
  const recovered = recover(txHash(t), sig);
  if (recovered !== address) throw new Error(`the signature recovers ${recovered}, not ${address}`);
  const raw = rawTx(t, sig);
  dep.chainSignatures = { ...dep.chainSignatures, transfer: { network: "sepolia", from: address, to, ...(to === await daoAddress("kop-bob-mw4i3w8f.testnet") ? { toNote: "bob's own Chain Signatures address" } : {}), eth: amount, nonce: Number(t.nonce),
    maxPriorityFeePerGas: String(t.maxPriorityFeePerGas), maxFeePerGas: String(t.maxFeePerGas), gas: String(t.gas), proposal: id, tx, signature: sig, raw, hash: `0x${hex(keccak_256(Buffer.from(raw.slice(2), "hex")))}` } };
  save();
  console.log(`signed by vote #${id}: ${what}\nethereum tx ${dep.chainSignatures.transfer.hash} (broadcast with --broadcast once ${address} holds Sepolia ETH)`);
} else if (main && process.argv.includes("--broadcast")) {
  const x = dep.chainSignatures?.transfer;
  if (!x) throw new Error("no signed transfer: run --tx first");
  const need = BigInt(Math.round(x.eth * 1e6)) * 10n ** 12n + 21_000n * 30_000_000_000n;
  const has = BigInt(await eth("eth_getBalance", [address, "latest"]));
  if (has < need) throw new Error(`${address} holds ${Number(has) / 1e18} Sepolia ETH; the transfer and its gas need up to ${Number(need) / 1e18}`);
  const hash = await eth("eth_sendRawTransaction", [x.raw]);
  console.log(`sent: ${SEPOLIA.explorer}${hash}`);
  x.sent = true;
  save();
} else if (main && dep.chainSignatures) {
  const c = dep.chainSignatures;
  console.log(`statement signed by vote #${c.proposal} (${txUrl(c.tx)}): recovers ${signerOf(c.message, c.signature)}`);
  if (c.transfer) console.log(`transfer of ${c.transfer.eth} Sepolia ETH to ${c.transfer.to} signed by vote #${c.transfer.proposal}: ${SEPOLIA.explorer}${c.transfer.hash}${c.transfer.sent ? "" : " (not broadcast yet)"}`);
}
