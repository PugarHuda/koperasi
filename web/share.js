// The contract's profit-share split (Koperasi::distribute in contract/src/lib.rs), in the browser, so members see what
// each of them would receive before they vote. Same integer maths: savings weighed in milli-NEAR, floor division,
// rounding and unused pools stay in the DAO as reserve. Checked against the contract's own test in tests/unit.
const BPS = 10_000n;
const SAVINGS_UNIT = 10n ** 21n;

/**
 * @param {bigint} amount USDC units (6 decimals) the DAO would send
 * @param {{ reserve_bps: number, savings_bps: number, points_bps: number }} rule
 * @param {Array<[string, { savings: string, points: number }]>} members as get_members returns them
 * @returns {{ shares: Array<{ account: string, share: bigint }>, reserve: bigint }}
 */
export function splitShare(amount, rule, members) {
  const savingsPool = (amount * BigInt(rule.savings_bps)) / BPS;
  const pointsPool = (amount * BigInt(rule.points_bps)) / BPS;
  const weight = members.map(([, m]) => BigInt(m.savings) / SAVINGS_UNIT);
  const totalSavings = weight.reduce((a, b) => a + b, 0n);
  const totalPoints = members.reduce((a, [, m]) => a + BigInt(m.points), 0n);
  let paid = 0n;
  const shares = members.map(([account, m], i) => {
    let share = 0n;
    if (totalSavings > 0n) share += (savingsPool * weight[i]) / totalSavings;
    if (totalPoints > 0n) share += (pointsPool * BigInt(m.points)) / totalPoints;
    paid += share;
    return { account, share };
  });
  return { shares, reserve: amount - paid };
}

/** "12.5" → 12500000n (USDC has 6 decimals); null for anything that is not a positive amount with ≤ 6 decimals. */
export const usdcUnits = (text) => {
  const t = String(text).trim();
  if (!/^\d{1,12}(\.\d{1,6})?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  const units = BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
  return units > 0n ? units : null;
};

/** 1333333n → "1.333333", 4000000n → "4.00": exact USDC (6 decimals), at least 2 shown. */
export const usdcExact = (units) => {
  const u = BigInt(units);
  const frac = (u % 1_000_000n).toString().padStart(6, "0").replace(/0{1,4}$/, "");
  return `${u / 1_000_000n}.${frac}`;
};

/** "0.05" → yoctoNEAR; null for anything that is not a positive amount with ≤ 6 decimals. */
export const nearUnits = (text) => {
  const t = String(text).trim();
  if (!/^\d{1,9}(\.\d{1,6})?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  const units = BigInt(whole) * 10n ** 24n + BigInt(frac.padEnd(24, "0"));
  return units > 0n ? units : null;
};

/**
 * Different sources that trust a contributor (`sources` in contract/src/tasks.rs): each task's poster, and the DAO for
 * every voted bounty. Two members posting only to each other's friend add one source each.
 * @param {string[]} refs "task:<id>" | "dao-proposal:<id>" @param {{ id: number, poster: string }[]} tasks
 */
export const trustSources = (refs, tasks) =>
  new Set(refs.map((r) => (r.startsWith("task:") ? tasks.find((t) => t.id === Number(r.slice(5)))?.poster ?? r : "dao"))).size;

/**
 * How a delivered task gets paid (Koperasi::accept_task in contract/src/tasks.rs): "trust" pays when the poster accepts
 * (if the poster is still within their daily limit, which only the contract knows), "member" waits for one other member.
 * @param {string} amount yoctoNEAR @param {{ auto_max: string, trusted_after: number }} rule @param {number} sources
 */
export const payPath = (amount, rule, sources) => (BigInt(amount) <= BigInt(rule.auto_max) && sources >= rule.trusted_after ? "trust" : "member");
