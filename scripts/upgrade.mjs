// node scripts/upgrade.mjs [deployment file] [--publisher <account>]   upgrade the contract code by a members' vote
// node scripts/upgrade.mjs [deployment file] --lock                    one time: install code that has `upgrade`, then
//                                                                     delete the contract account's full-access keys
//
// By vote: wasm is far too large for a proposal (function-call args cost ~48 Mgas a byte), so a member publishes
// contract/target/near/koperasi.wasm as a NEAR global contract, addressed by its sha256 (immutable; costs ~10x normal
// storage, burned). The members then vote a FunctionCall `upgrade({code_hash})` and the contract switches itself to
// that code. Either way the script checks that members, receipts and by-laws survive.
import fs from "node:fs";
import path from "node:path";
import { ROOT, DEPLOYMENT, RPC, account, decide, fnCall, hasKey, sha256, view } from "./lib.mjs";

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i < 0 ? null : args.splice(i, 2)[1]; };
const publisher = flag("--publisher");
const lock = args.includes("--lock");
const fileArg = args.find((a) => !a.startsWith("--"));
const dep = JSON.parse(fs.readFileSync(fileArg ? path.resolve(fileArg) : DEPLOYMENT, "utf8"));
const wasm = fs.readFileSync(path.join(ROOT, "contract/target/near/koperasi.wasm"));
const codeHash = bs58(sha256(wasm));
const before = await view(dep.contract, "get_info");
const rpc = async (params) => {
  const r = await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { finality: "final", ...params } }) })).json();
  if (r.error || r.result?.error) throw new Error(JSON.stringify(r.error ?? r.result.error).slice(0, 200));
  return r.result;
};
const fullAccess = async () => (await rpc({ request_type: "view_access_key_list", account_id: dep.contract })).keys
  .filter((k) => k.access_key.permission === "FullAccess");
const running = async () => {
  const a = await rpc({ request_type: "view_account", account_id: dep.contract });
  return a.global_contract_hash ?? a.code_hash;
};

if (lock) {
  const keys = await fullAccess();
  if (!keys.length) throw new Error(`${dep.contract} has no full-access key left: upgrade by vote instead`);
  const c = account(dep.contract);
  if ((await running()) !== codeHash) await c.deployContract(new Uint8Array(wasm));
  for (const k of keys) await c.deleteKey(k.public_key);
  console.log(`${dep.contract}: code ${codeHash}, deleted ${keys.length} full-access key(s); from now on only a vote upgrades it`);
} else {
  const published = await rpc({ request_type: "view_global_contract_code", code_hash: codeHash }).then(() => true, () => false);
  if (!published) {
    if (!publisher) throw new Error(`publish the code first: --publisher <account with ~${Math.ceil(wasm.length / 1e5 + 1)} NEAR, key in .keys/>`);
    await account(publisher).deployGlobalContract(new Uint8Array(wasm), "codeHash");
    console.log(`${publisher} published global contract ${codeHash} (${wasm.length} bytes)`);
  }
  const policy = await view(dep.dao, "get_policy");
  const voters = (policy.roles.find((r) => r.name === "member")?.kind?.Group ?? []).filter(hasKey).map(account);
  if (!voters.length) throw new Error("no member keys in .keys/ to propose and vote");
  const { id } = await decide(voters[0], voters, dep.dao, `Upgrade the Koperasi contract to code ${codeHash} (sha256 ${sha256(wasm)})`,
    fnCall(dep.contract, "upgrade", { code_hash: codeHash }, { tgas: 100 }));
  console.log(`proposal #${id} approved: ${dep.contract}.upgrade(${codeHash})`);
}

const now = await running();
if (now !== codeHash) throw new Error(`${dep.contract} runs ${now}, not ${codeHash}`);
const after = await view(dep.contract, "get_info");
for (const k of ["members", "receipts", "periods"]) {
  if (before[k] !== after[k]) throw new Error(`state changed across the upgrade: ${k} ${before[k]} → ${after[k]}`);
}
if (after.config.hash !== before.config.hash) throw new Error("config changed across the upgrade");
// an RPC can lag a block or two behind the key deletion: wait until the count settles
let left = (await fullAccess()).length;
for (let i = 0; lock && left && i < 10; i++) { await new Promise((ok) => setTimeout(ok, 1500)); left = (await fullAccess()).length; }
console.log(`${dep.contract} runs ${codeHash}; ${after.members} members, ${after.receipts} receipts, by-laws v${after.config.version} intact; full-access keys: ${left}`);

function bs58(hex) {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt(`0x${hex}`);
  let out = "";
  while (n > 0n) { out = A[Number(n % 58n)] + out; n /= 58n; }
  return out;
}
