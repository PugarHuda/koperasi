// GET /api/inbox?who=<account>   what needs a member, as an RSS feed, read from the chain on each request
//
// The same list as the panel's "Needs you" (web/wallet.js): DAO proposals they have not voted on, court cases where they
// are a juror and have not ruled, pledges they called in and must confirm, dues falling due within a week or late; and
// (0.3.3) USDC waiting to be claimed, a loan due within a week or late, a loan a sister co-op says is late there, and
// by-laws the agent itself put to the members. An
// RSS feed reaches a member outside the page with no account and no secret kept by the co-op: any feed reader, or a
// feed-to-email or feed-to-Telegram service the member chooses, delivers it. Public data only (it is all on-chain).
import { JsonRpcProvider } from "near-api-js";
import dep from "../deployment.testnet.json" with { type: "json" };

const provider = new JsonRpcProvider({ url: "https://rpc.testnet.fastnear.com" });
/** @returns {Promise<any>} */
const view = (contractId, method, args = {}) => provider.callFunction({ contractId, method, args, blockQuery: { finality: "final" } });
const DAY_MS = 86_400_000;
const ms = (ns) => Number(BigInt(ns) / 1_000_000n);
const xml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);
const PAGE = "https://koperasi-kohl.vercel.app";

/** The items, from what the chain says (exported for the unit test). */
export function inboxItems(who, { proposals = [], cases = [], claims = [], dues = null, member = false, claimable = "0", loan = null, lateElsewhere = [], contract = dep.contract }, now = Date.now()) {
  const items = [];
  if (member) for (const p of proposals) {
    if (p.status !== "InProgress" || p.votes?.[who]) continue;
    const byAgent = p.proposer === contract && /^By-laws v\d+, proposed by the co-op's agent/.test(p.description);
    items.push({ id: `p${p.id}`, title: byAgent ? `The agent proposes new by-laws: vote on #${p.id}` : `Vote on DAO proposal #${p.id}`,
      text: String(p.description).replace(/\s+/g, " ").slice(0, byAgent ? 500 : 200) });
  }
  if (BigInt(claimable || 0) > 0n) items.push({ id: `claim${claimable}`, title: `${Number(claimable) / 1e6} USDC of profit shares wait for you`, text: "Claim them from the wallet panel (claim_share)." });
  if (loan && loan.status !== "Repaid") {
    const owed = (Number(BigInt(loan.principal) + BigInt(loan.interest)) / 1e24).toFixed(3);
    if (loan.status === "Late") items.push({ id: "loan-late", title: "Your loan is late", text: `Repay ${owed} NEAR: until then you and your guarantors are out of good standing, and the sister co-ops are told.` });
    else if (ms(loan.due) - now < 7 * DAY_MS) items.push({ id: `loan${loan.due}`, title: "Your loan falls due", text: `Repay ${owed} NEAR by ${new Date(ms(loan.due)).toUTCString()}.` });
  }
  for (const coop of lateElsewhere ?? []) items.push({ id: `late-${coop}`, title: `${coop} says a loan of yours there is late`, text: "Until it is repaid there, your credit here is 0 and you cannot borrow." });
  for (const c of cases) {
    if (c.status === "Open" && c.jurors.includes(who) && !c.votes.some(([j]) => j === who)) {
      items.push({ id: `c${c.id}`, title: `You are a juror on court case #${c.id}`, text: `Rule by ${new Date(ms(c.opened) + 3 * DAY_MS).toUTCString()}: job ${c.job_id}, refund asked ${Number(c.amount) / 1e6} USDC.` });
    }
  }
  for (const c of claims) {
    if (c.holder === who && c.status === "Open") items.push({ id: `k${c.id}`, title: `Say whether pledge #${c.pledge} was kept`, text: "You called it in; the issuer's standing waits on your answer." });
  }
  if (dues) {
    const [until, ok] = dues;
    if (!ok) items.push({ id: "dues-late", title: "Your dues are late", text: "More than 7 days behind: you are out of good standing until you pay." });
    else if (ms(until) - now < 7 * DAY_MS) items.push({ id: `dues${until}`, title: "Your dues fall due", text: `Due ${new Date(ms(until)).toUTCString()}.` });
  }
  return items;
}

export function rss(who, items, now = Date.now()) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>Koperasi: what needs ${xml(who)}</title>
<link>${PAGE}/?as=${encodeURIComponent(who)}</link>
<description>Read from NEAR testnet (${xml(dep.contract)}) at ${new Date(now).toUTCString()}</description>
${items.map((i) => `<item><title>${xml(i.title)}</title><description>${xml(i.text)}</description><link>${PAGE}/#commons</link><guid isPermaLink="false">${xml(`${who}:${i.id}`)}</guid></item>`).join("\n")}
</channel></rss>
`;
}

export async function GET(request) {
  const who = new URL(request.url).searchParams.get("who") ?? "";
  if (!/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(who) || who.length < 2 || who.length > 64) {
    return new Response("who: a NEAR account id", { status: 400 });
  }
  try {
    const last = Number(await view(dep.dao, "get_last_proposal_id"));
    const [proposals, cases, claims, dues, member, claimable, loan, lateElsewhere] = await Promise.all([
      view(dep.dao, "get_proposals", { from_index: Math.max(0, last - 50), limit: 50 }),
      view(dep.contract, "get_cases", { from: 0, limit: 200 }),
      view(dep.contract, "get_pledge_claims", { from: 0, limit: 200 }),
      view(dep.contract, "get_dues_status", { account_id: who }).catch(() => null),
      view(dep.contract, "get_member", { account_id: who }),
      view(dep.contract, "get_claimable", { account_id: who }).catch(() => "0"),
      view(dep.contract, "get_loan", { account_id: who }).catch(() => null),
      view(dep.contract, "get_late_elsewhere", { account_id: who }).catch(() => []), // contract 0.3.3
    ]);
    const items = inboxItems(who, { proposals, cases, claims, dues, member: Boolean(member), claimable, loan, lateElsewhere });
    return new Response(rss(who, items), { headers: { "content-type": "application/rss+xml; charset=utf-8", "cache-control": "public, max-age=300" } });
  } catch (e) {
    return new Response(`could not read NEAR now: ${String(e?.message ?? e).slice(0, 120)}`, { status: 502 });
  }
}
