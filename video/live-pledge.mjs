// Scene 12, a real testnet transaction while the screen records: bob calls in the second unit of alice's pledge #0,
// then says it was kept. Prints one line per step (the video shows them as a terminal).
import fs from "node:fs";
import { DEPLOYMENT, account, callRaw, txUrl, view } from "../scripts/lib.mjs";

const dep = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));
const bob = account("kop-bob-mw4i3w8f.testnet");
const value = (out) => JSON.parse(Buffer.from(out.status.SuccessValue, "base64").toString());
console.log("$ node scripts/commons.mjs: bob calls in alice's pledge #0");
const r = await callRaw(bob, dep.contract, "redeem_pledge", { id: 0 }, { deposit: 10n ** 22n, tgas: 30 }); // 0.01 NEAR: the claim pays for its storage
const claim = value(r);
console.log(`redeem_pledge → claim #${claim}  ${txUrl(r.transaction.hash)}`);
const s = await callRaw(bob, dep.contract, "settle_pledge", { claim, honored: true }, { tgas: 30 });
console.log(`settle_pledge kept  ${txUrl(s.transaction.hash)}`);
const [st] = await view(dep.contract, "get_standing", { account_id: "kop-alice-mw4i3w8f.testnet" });
console.log(`alice: ${st.pledges_honored} pledges kept, ${st.pledges_broken} broken`);
