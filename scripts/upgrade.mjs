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
import { baseEncode } from "near-api-js";
import { ROOT, DEPLOYMENT, account, rawQuery, decide, fnCall, hasKey, publicKeyOf, sha256, view } from "./lib.mjs";

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i < 0 ? null : args.splice(i, 2)[1]; };
const publisher = flag("--publisher");
const lock = args.includes("--lock");
const fileArg = args.find((a) => !a.startsWith("--"));
const dep = JSON.parse(fs.readFileSync(fileArg ? path.resolve(fileArg) : DEPLOYMENT, "utf8"));
const wasm = fs.readFileSync(path.join(ROOT, "contract/target/near/koperasi.wasm"));
const codeHash = baseEncode(Buffer.from(sha256(wasm), "hex")); // base58 keeps leading zero bytes as '1'
const before = await view(dep.contract, "get_info");
const rpc = rawQuery;
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
  // the keys go only once the new code is proven to read the old state; this script's own key goes last
  const check = await view(dep.contract, "get_info");
  for (const k of ["members", "receipts", "periods"]) {
    if (before[k] !== check[k]) throw new Error(`new code reads ${k} ${check[k]}, was ${before[k]}: keys kept, fix the code first`);
  }
  const mine = publicKeyOf(dep.contract);
  for (const k of [...keys.filter((x) => x.public_key !== mine), ...keys.filter((x) => x.public_key === mine)]) {
    await c.deleteKey(k.public_key);
  }
  console.log(`${dep.contract}: code ${codeHash}, deleted ${keys.length} full-access key(s); from now on only a vote upgrades it`);
} else {
  const published = await rpc({ request_type: "view_global_contract_code", code_hash: codeHash }).then(() => true, () => false);
  if (!published) {
    if (!publisher) throw new Error(`publish the code first: --publisher <account with ~${Math.ceil(wasm.length / 1e4) + 1} NEAR (0.0001 NEAR a byte), key in .keys/>`);
    await account(publisher).deployGlobalContract(new Uint8Array(wasm), "codeHash");
    console.log(`${publisher} published global contract ${codeHash} (${wasm.length} bytes)`);
  }
  // global code reaches every shard a few blocks after it is published; a vote executed before that does nothing
  for (let i = 0; ; i++) {
    if (await rpc({ request_type: "view_global_contract_code", code_hash: codeHash }).then(() => true, () => false)) break;
    if (i === 30) throw new Error(`global contract ${codeHash} is not readable yet; run again in a minute`);
    await new Promise((ok) => setTimeout(ok, 2000));
  }
  const policy = await view(dep.dao, "get_policy");
  const voters = (policy.roles.find((r) => r.name === "member")?.kind?.Group ?? []).filter(hasKey).map(account);
  if (!voters.length) throw new Error("no member keys in .keys/ to propose and vote");
  const { id } = await decide(voters[0], voters, dep.dao, `Upgrade the Koperasi contract to code ${codeHash} (sha256 ${sha256(wasm)})`,
    fnCall(dep.contract, "upgrade", { code_hash: codeHash }, { tgas: 100 }));
  console.log(`proposal #${id} approved: ${dep.contract}.upgrade(${codeHash})`);
}

// the upgrade lands a block after the vote, and an RPC can lag behind that: wait for it before checking
let now = await running();
for (let i = 0; now !== codeHash && i < 10; i++) { await new Promise((ok) => setTimeout(ok, 1500)); now = await running(); }
if (now !== codeHash) throw new Error(`${dep.contract} runs ${now}, not ${codeHash}`);
const after = await view(dep.contract, "get_info");
for (const k of ["members", "receipts", "periods"]) {
  if (before[k] !== after[k]) throw new Error(`state changed across the upgrade: ${k} ${before[k]} → ${after[k]}`);
}
if (after.config.hash !== before.config.hash) throw new Error("config changed across the upgrade");
// an RPC can lag a block or two behind the key deletion: wait until the count settles
let left = (await fullAccess()).length;
for (let i = 0; lock && left && i < 10; i++) { await new Promise((ok) => setTimeout(ok, 1500)); left = (await fullAccess()).length; }
// new co-ops (scripts/deploy.mjs without a local build) start from the code these members voted
// the page reads its own copy (web/deployment.json): its rebuild card shows this sha256
if (!fileArg) for (const f of [DEPLOYMENT, path.join(ROOT, "web/deployment.json")]) fs.writeFileSync(f, `${JSON.stringify({ ...dep, codeSha256: sha256(wasm) }, null, 2)}
`);
console.log(`${dep.contract} runs ${codeHash}; ${after.members} members, ${after.receipts} receipts, by-laws v${after.config.version} intact; full-access keys: ${left}`);
