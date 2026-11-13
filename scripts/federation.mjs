// node scripts/federation.mjs   a secondary co-op: co-ops as members, one co-op one vote, each voting by its own members
//
// Indonesian co-op law lets primary co-ops form a secondary co-op (koperasi sekunder, Law 25/1992 art. 15–16) whose
// members are co-ops, not people. Here: an unmodified Sputnik DAO whose role `member` holds the showcase co-op's DAO and
// the sister co-op's DAO, nobody else. A resolution of the federation passes only when both co-ops vote for it, and a
// co-op votes only when its own members approved a proposal that casts that vote (a FunctionCall from its DAO to the
// federation's `act_proposal`). So a person can reach the federation only through their co-op's vote.
//
// The first resolution: the member co-ops recognise each other's work records (the passport, contract 0.2.8), which
// each already did by its own vote (#83 in the showcase, #8 in the sister). The record is saved in the deployment files;
// `npm run verify` reads the federation's policy, the resolution and each co-op's vote behind it.
import fs from "node:fs";
import path from "node:path";
import { DEPLOYMENT, NEAR, ROOT, SPUTNIK_FACTORY, account, createDao, decide, faucetAccount, fnCall, propose, view } from "./lib.mjs";

const dep = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));
const sis = JSON.parse(fs.readFileSync(path.join(ROOT, "deployment.testnet.local.json"), "utf8"));
const CO_OPS = [
  { dao: dep.dao, voters: ["kop-alice-mw4i3w8f.testnet", "kop-bob-mw4i3w8f.testnet", dep.steward] },
  { dao: sis.dao, voters: ["kop-bob-mw80aczw.testnet", "kop-steward-mw80aczw.testnet"] },
];

// FED=<dao> resumes with a federation already created (a run cut short by an RPC's rate limit)
let fed = process.env.FED ?? dep.federation?.dao;
if (!fed) {
  const tag = Date.now().toString(36);
  const founder = await faucetAccount(`kop-fed-founder-${tag}.testnet`); // pays for the DAO's storage, then has no role
  fed = await createDao(founder, `kop-federation-${tag}`, "A secondary co-op: its members are co-ops, one co-op one vote, each voting by its own members' decision",
    CO_OPS.map((c) => c.dao), null, 6n * NEAR);
  console.log(`federation DAO ${fed} (members: ${CO_OPS.map((c) => c.dao).join(", ")})`);
}

const resolution = "Resolution 1: the member co-ops recognise each other's work records (the passport): good standing and finished work earned in one count as a trust source in the other";
const proposer = account(CO_OPS[0].voters[0]); // anyone may file a proposal (with the bond); only the co-ops vote
const filed = (await view(fed, "get_proposals", { from_index: 0, limit: 20 })).find((p) => p.description === resolution);
const id = filed ? filed.id : await propose(proposer, fed, resolution, "Vote");
console.log(`federation proposal #${id}: ${resolution}`);
const kind = (await view(fed, "get_proposal", { id })).kind;
const votes = [];
for (const c of CO_OPS) {
  if ((await view(fed, "get_proposal", { id })).votes[c.dao]) { votes.push({ dao: c.dao, proposal: null }); continue; } // voted on an earlier run
  const r = await decide(account(c.voters[0]), c.voters.map(account), c.dao,
    `Vote for our co-op in the federation ${fed}: approve its proposal #${id} ("${resolution}")`,
    fnCall(fed, "act_proposal", { id, action: "VoteApprove", proposal: kind }, { tgas: 150 }));
  console.log(`${c.dao}: its members approved #${r.id}, which cast the co-op's vote`);
  votes.push({ dao: c.dao, proposal: r.id });
}
const p = await view(fed, "get_proposal", { id });
console.log(`federation #${id}: ${p.status}; votes ${JSON.stringify(p.votes)}`);
if (p.status !== "Approved") throw new Error("the federation's resolution did not pass");
const federation = { dao: fed, factory: SPUTNIK_FACTORY, members: CO_OPS.map((c) => c.dao), resolution: { id, text: resolution, votes } };
for (const f of [DEPLOYMENT, path.join(ROOT, "web/deployment.json")]) {
  const d = JSON.parse(fs.readFileSync(f, "utf8"));
  fs.writeFileSync(f, JSON.stringify({ ...d, federation }, null, 2) + "\n");
}
