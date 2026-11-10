// node scripts/vouch.mjs <member> <newcomer>
// A member signs "I vouch for <newcomer>" (NEP-413, with the member's key in .keys/: no transaction, no gas) and gets the
// invite link that carries the signature. For members whose wallet cannot sign messages. The page checks the signature
// and that the key is one of the member's full-access keys.
import crypto from "node:crypto";
import fs from "node:fs";
import { signMessage } from "near-api-js/nep413";
import { DEPLOYMENT, account } from "./lib.mjs";
import { checkVouch, vouchText } from "../web/share.js";

const [member, newcomer] = process.argv.slice(2);
if (!member || !newcomer) throw new Error("usage: node scripts/vouch.mjs <member> <newcomer>");
const dep = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));
const nonce = crypto.randomBytes(32);
const s = await signMessage({ signerAccount: account(member), payload: { message: vouchText(member, newcomer, dep.dao), recipient: dep.dao, nonce } });
const v = { pk: s.publicKey.toString(), sig: Buffer.from(s.signature).toString("base64"), nonce: nonce.toString("base64") };
if (!(await checkVouch({ by: member, member: newcomer, dao: dep.dao, ...v }))) throw new Error("the signature does not verify");
console.log(JSON.stringify(v));
console.log(`https://koperasi-kohl.vercel.app/?${new URLSearchParams({ invite: member, for: newcomer, pk: v.pk, sig: v.sig, n: v.nonce })}#joinapp`);
