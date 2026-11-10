// node scripts/chainsig.mjs            the DAO's Ethereum address (NEAR Chain Signatures), and the signed statement if any
// node scripts/chainsig.mjs --sign     members vote that the DAO signs the statement below; the signature is saved
//
// The co-op holds an Ethereum address with no private key anywhere: NEAR's MPC network (v1.signer-prod.testnet) derives
// it from the DAO's account and a path, and signs for it only when the DAO itself calls `sign`, which a Sputnik DAO does
// only by a members' vote. The statement is an EIP-191 message, so any Ethereum tool can recover the signer.
// ponytail: a message, not a Sepolia transaction: a transaction needs Sepolia ETH for gas; the same vote signs either.
import fs from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { baseDecode } from "near-api-js";
import { DEPLOYMENT, NETWORK, account, propose, txUrl, view, vote } from "./lib.mjs";

export const SIGNER = NETWORK === "mainnet" ? "v1.signer" : "v1.signer-prod.testnet";
export const PATH = "ethereum-1";
const dep = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));

const hex = (b) => Buffer.from(b).toString("hex");
const addressOf = (xy) => "0x" + hex(keccak_256(xy)).slice(24);
export const statement = (dao, address) =>
  `Koperasi co-op ${dao} holds ${address} through NEAR Chain Signatures (path ${PATH}); it signs only by a members' vote.`;
const eip191 = (msg) => keccak_256(Buffer.from(`\x19Ethereum Signed Message:\n${Buffer.byteLength(msg)}${msg}`));

export async function daoAddress(dao) {
  const pk = await view(SIGNER, "derived_public_key", { path: PATH, predecessor: dao, domain_id: 0 });
  return addressOf(baseDecode(pk.split(":")[1]));
}

/** The address that signed `msg` (EIP-191), from the MPC response {big_r: {affine_point}, s: {scalar}, recovery_id}. */
export function signerOf(msg, sig) {
  const rs = Buffer.from(sig.big_r.affine_point.slice(2) + sig.s.scalar, "hex");
  const pub = secp256k1.recoverPublicKey(Uint8Array.from([sig.recovery_id, ...rs]), eip191(msg), { prehash: false });
  return addressOf(secp256k1.Point.fromBytes(pub).toBytes(false).subarray(1));
}

const address = import.meta.main ? await daoAddress(dep.dao) : null; // imported by verify.mjs for the helpers only
const msg = statement(dep.dao, address);
if (import.meta.main) console.log(`DAO ${dep.dao}\nEthereum address ${address} (MPC ${SIGNER}, path ${PATH})`);

if (import.meta.main && process.argv.includes("--sign")) {
  const args = { request: { payload_v2: { Ecdsa: hex(eip191(msg)) }, path: PATH, domain_id: 0 } };
  const kind = { FunctionCall: { receiver_id: SIGNER, actions: [{
    method_name: "sign", args: Buffer.from(JSON.stringify(args)).toString("base64"), deposit: "1", gas: String(100n * 10n ** 12n) }] } };
  const members = ["kop-alice-mw4i3w8f.testnet", "kop-bob-mw4i3w8f.testnet", "kop-steward-mw4i2iwk.testnet", "vouched-mwa7jwhw.kop-publisher-mw5tkpfo.testnet"];
  const id = await propose(account(members[0]), dep.dao, `Sign with the co-op's Ethereum address (NEAR Chain Signatures): "${msg}"`, kind);
  console.log("proposal", id);
  let sig, tx;
  for (const m of members) {
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
  const recovered = signerOf(msg, sig);
  if (recovered !== address) throw new Error(`the signature recovers ${recovered}, not ${address}`);
  dep.chainSignatures = { signer: SIGNER, path: PATH, address, message: msg, proposal: id, tx, signature: sig };
  fs.writeFileSync(DEPLOYMENT, JSON.stringify(dep, null, 2) + "\n");
  console.log(`signed by vote #${id}; recovers ${recovered}: the co-op's address. Saved in ${DEPLOYMENT}`);
} else if (import.meta.main && dep.chainSignatures) {
  const c = dep.chainSignatures;
  console.log(`statement signed by vote #${c.proposal} (${txUrl(c.tx)}): recovers ${signerOf(c.message, c.signature)}`);
}
