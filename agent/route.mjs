// Work passed between the federation's co-ops, decided by the agent itself (federation resolution 3).
//
// A job this agent would not take at its own price (its budget is below the price the members voted) may suit a sister
// co-op: one this co-op's members recognise, whose voted by-laws (read from its contract, the file's sha256 checked)
// take jobs with these tags at a price within the budget. The agent then does not bid; it passes the job on, naming
// this co-op as the one that brought it, so the sister's receipt names it and the federation's 30% share follows.
// On testnet the hand-over goes to the sister's market endpoint (KOP_FEDERATION_INBOX, the stand-in for a shared
// federation board); the decision is the agent's, from the chain.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { ROOT, sha256, view } from "../scripts/lib.mjs";

/** The cheapest sister co-op whose voted by-laws take this job within its budget, or null. */
export async function sisterFor(dep, job) {
  const sisters = await view(dep.contract, "get_sister_coops").catch(() => []);
  const tags = (job.tags ?? []).map((t) => String(t).toLowerCase());
  const budget = Number(job.budgetAmount);
  let best = null;
  for (const coop of sisters) {
    const cfg = await view(coop, "get_config").catch(() => null);
    if (!cfg) continue;
    const file = path.join(ROOT, cfg.uri);
    if (!fs.existsSync(file) || sha256(fs.readFileSync(file)) !== cfg.hash) continue; // only the by-laws its members voted
    const bylaws = YAML.parse(fs.readFileSync(file, "utf8"));
    const takes = tags.some((t) => bylaws.job_filter.tags_any.includes(t));
    const price = Number(bylaws.bid.price_usdc);
    if (takes && budget >= bylaws.job_filter.min_price_usdc && budget >= price && (!best || price < best.price)) {
      best = { coop, price, version: cfg.version };
    }
  }
  return best;
}

/** Pass the job on to the sister's board, naming this co-op. */
export async function passOn(dep, job, to, log) {
  const inbox = process.env.KOP_FEDERATION_INBOX;
  if (!inbox) {
    log(`would pass "${job.title}" to ${to.coop} (its by-laws v${to.version} take it at ${to.price} USDC), but no federation board is set`);
    return false;
  }
  const res = await fetch(inbox, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ title: job.title, description: job.description, tags: job.tags, budgetAmount: job.budgetAmount, referredBy: dep.contract }) });
  if (!res.ok) throw new Error(`the federation board answered ${res.status}`);
  log(`passed "${job.title}" (budget ${job.budgetAmount} USDC, below our price) to ${to.coop}, whose by-laws v${to.version} take it at ${to.price} USDC`);
  return true;
}
