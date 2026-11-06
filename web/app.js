// Reads one Koperasi straight from NEAR (no backend) and renders members, by-laws, work, audit and profit shares.
const dep = await (await fetch("deployment.json")).json();
const testnet = dep.network !== "mainnet";
const RPCS = testnet
  ? ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org", "https://rpc.testnet.near.org"]
  : ["https://free.rpc.fastnear.com", "https://near.drpc.org", "https://rpc.mainnet.near.org"];
const explorer = (id) => `https://${testnet ? "testnet." : ""}nearblocks.io/address/${id}`;

async function view(contract, method, args = {}) {
  const body = JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "query",
    params: { request_type: "call_function", finality: "optimistic", account_id: contract, method_name: method, args_base64: btoa(JSON.stringify(args)) },
  });
  let last;
  for (const url of RPCS) {
    try {
      const r = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body })).json();
      if (r.error || r.result?.error) throw new Error(JSON.stringify(r.error ?? r.result.error));
      return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result.result)));
    } catch (e) { last = e; }
  }
  throw last;
}

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const usdc = (u) => (Number(u) / 1e6).toFixed(2);
const nearAmt = (y) => (Number(BigInt(y) / 10n ** 21n) / 1000).toLocaleString("en", { maximumFractionDigits: 2 });
const date = (ns) => new Date(Number(BigInt(ns) / 1_000_000n)).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
const short = (h) => `${h.slice(0, 10)}…`;
const rows = (tbody, html) => { tbody.innerHTML = html || `<tr><td colspan="9" class="muted">Nothing yet.</td></tr>`; };
const tag = (name, attrs) => `<${name} ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(" ")}/>`;

try {
  const [info, members, versions, receipts, rekon, periods] = await Promise.all([
    view(dep.contract, "get_info"),
    view(dep.contract, "get_members", { from: 0, limit: 200 }),
    view(dep.contract, "get_config_history", { from: 0, limit: 100 }),
    view(dep.contract, "get_receipts", { from: 0, limit: 500 }),
    view(dep.contract, "get_audit"),
    view(dep.contract, "get_periods"),
  ]);
  const claimable = await Promise.all(members.map(([a]) => view(dep.contract, "get_claimable", { account_id: a })));

  $("links").innerHTML = [
    `<a href="${explorer(dep.contract)}">Contract on NEAR</a>`,
    `<a href="${explorer(dep.dao)}">The co-op's DAO</a>`,
    `<a href="https://github.com/PugarHuda/koperasi">Source and demo</a>`,
  ].join("");
  $("contract-link").href = explorer(dep.contract);
  $("pb-id").textContent = dep.contract;
  $("net").textContent = `Reading ${dep.network}: ${dep.contract}`;
  $("chip").innerHTML = `${members.length} members<br>${receipts.length} jobs on-chain`;

  // hero: one node per member, wired into the agent's mind
  const core = { x: 720, y: 330 };
  const shown = members.slice(0, 12);
  $("nodes").innerHTML = shown.map((_, i) => {
    const a = Math.PI * (1.08 + (0.84 * i) / Math.max(1, shown.length - 1));
    const x = core.x + Math.cos(a) * 520, y = core.y + Math.sin(a) * 260 + 40;
    return tag("line", { x1: core.x, y1: core.y, x2: x, y2: y }) + tag("circle", { class: i % 2 ? "ring" : "dot", cx: x, cy: y, r: i % 2 ? 11 : 6 });
  }).join("") + tag("circle", { class: "core", cx: core.x, cy: core.y, r: 9 });

  // passbook: the co-op's life as ledger lines, newest first
  const lines = [
    ...versions.map((v) => ({ ts: v.activated_at, text: `By-laws v${v.version} approved`, amt: "" })),
    ...receipts.filter((r) => r.status === "Paid").map((r) => ({ ts: r.ts, text: `Job paid, by-laws v${r.config_version}`, amt: `+${usdc(r.price)}` })),
    ...periods.map((p) => ({ ts: p.ts, text: `Profit share ${p.id} to ${p.members} members`, amt: `-${usdc(BigInt(p.amount) - BigInt(p.reserve))}`, out: true })),
  ].sort((a, b) => (BigInt(b.ts) > BigInt(a.ts) ? 1 : -1)).slice(0, 9);
  rows($("passbook").tBodies[0], lines.map((l) =>
    `<tr><td>${date(l.ts)}</td><td>${esc(l.text)}</td><td class="num${l.out ? " out" : ""}">${l.amt}</td></tr>`).join(""));

  const owed = BigInt(rekon.owed);
  const stamp = $("stamp");
  stamp.hidden = false;
  if (owed > 0n) {
    stamp.classList.add("red");
    stamp.innerHTML = `Not passed on<br>${usdc(owed)} USDC`;
  } else {
    stamp.innerHTML = `Approved by vote<br>by-laws v${info.config.version}`;
  }

  // members: pick one, see savings, points and share against the largest member
  const top = (f) => Math.max(1, ...members.map((m, i) => Number(f(m, i))));
  const tops = [top(([, m]) => m.savings), top(([, m]) => m.points), top((_, i) => claimable[i])];
  const pick = $("member-pick");
  pick.innerHTML = members.map(([a], i) => `<option value="${i}">${esc(a)}${a === info.steward ? " (steward)" : ""}</option>`).join("");
  const meter = (label, val, raw, max) => `<div class="meter"><div class="label"><span>${label}</span><span class="val">${val}</span></div>
      <div class="track"><div class="fill" data-w="${(100 * Number(raw)) / max}"></div></div></div>`;
  const showMember = () => {
    const i = Number(pick.value);
    if (!members[i]) return;
    const m = members[i][1];
    $("meters").innerHTML = meter("Savings staked, NEAR", nearAmt(m.savings), m.savings, tops[0])
      + meter("Contribution points", m.points, m.points, tops[1])
      + meter("Share to claim, USDC", usdc(claimable[i]), claimable[i], tops[2]);
    requestAnimationFrame(() => requestAnimationFrame(() =>
      document.querySelectorAll("#meters .fill").forEach((f) => { f.style.width = `${f.dataset.w}%`; })));
  };
  pick.onchange = showMember;
  showMember();

  rows($("member-table").tBodies[0], members.map(([a, m], i) => `<tr>
      <td>${esc(a)}${a === info.steward ? ` <span class="muted">(steward)</span>` : ""}</td>
      <td class="num" data-label="Savings staked">${nearAmt(m.savings)}</td>
      <td class="num" data-label="Contribution points">${m.points}</td>
      <td class="num" data-label="Share to claim">${usdc(claimable[i])}</td></tr>`).join(""));

  $("versions").innerHTML = [...versions].reverse().map((v) => `
    <li class="${v.version === info.config.version ? "current" : ""}">
      <span class="v">v${v.version}</span>
      <div>
        <div class="meta">${date(v.activated_at)}${v.contributor ? `, proposed by ${esc(v.contributor)}` : ", founding by-laws"}${v.version === info.config.version ? ". The agent runs this one." : ""}</div>
        <div class="hash">sha256 ${esc(v.hash)}</div>
        <div class="meta">${esc(v.uri)}</div>
      </div>
    </li>`).join("");

  rows($("receipts").tBodies[0], [...receipts].reverse().slice(0, 12).map((r) => `<tr>
      <td>${esc(r.job_id.slice(0, 8))}… <span class="muted">${date(r.ts)}</span></td>
      <td class="num" data-label="Price">${usdc(r.price)}</td>
      <td class="num" data-label="Inference">$${(Number(r.inference_cost) / 1e6).toFixed(4)}</td>
      <td data-label="By-laws">v${r.config_version} <span class="muted">${short(r.config_hash)}</span></td>
      <td data-label="Status"><span class="badge ${r.status}">${r.status}</span></td></tr>`).join(""));

  // audit: owed vs deposited, two bars on one scale
  const scale = Math.max(Number(rekon.expected), Number(rekon.deposited), 1);
  const pct = (u) => Math.max(1, (100 * Number(u)) / scale);
  $("rekon").innerHTML = `
    <div class="axis" aria-hidden="true"><span>${usdc(scale)}</span><span>${usdc(scale / 2)}</span><span>0</span></div>
    <div class="bar"><span class="n">${usdc(rekon.expected)}</span><div class="col" style="height:${pct(rekon.expected)}%"></div></div>
    <div class="bar${owed > 0n ? " missing" : ""}"><span class="n">${usdc(rekon.deposited)}</span><div class="col" style="height:${pct(rekon.deposited)}%"></div></div>
    <span class="cap" style="grid-column:2">Owed to the co-op, USDC</span>
    <span class="cap" style="grid-column:3">Deposited by the steward${owed > 0n ? `: ${usdc(owed)} missing` : ""}</span>`;
  const bond = nearAmt(info.steward_bond);
  $("verdict").className = `verdict ${owed > 0n ? "owed" : "ok"}`;
  $("verdict").innerHTML = owed > 0n
    ? `<span class="seal">RED</span><p>The steward has not passed on ${usdc(owed)} USDC. ${BigInt(info.steward_bond) > 0n
      ? `Any member can propose slashing the steward's bond (${bond} NEAR).`
      : "The members already slashed the steward's bond; they can appoint a new steward by vote."}</p>`
    : `<span class="seal">GREEN</span><p>Every paid job has reached the co-op. Steward bond at stake: ${bond} NEAR.</p>`;

  const r = info.share_rule;
  $("share-rule").textContent = `The members vote each profit share. ${r.reserve_bps / 100}% stays in the DAO as the co-op's reserve; the rest is split by savings and by contribution, and each member claims their own.`;
  $("plans").innerHTML = `
    <div class="plan"><h3>Co-op<br>reserve</h3><p class="for">Stays in the DAO treasury</p><span class="pct">${r.reserve_bps / 100}%</span>
      <ul><li>Back to the Sputnik DAO</li><li>Spent only by a vote</li><li>Visible in Trezu</li></ul></div>
    <div class="plan members"><h3>Members'<br>share</h3><p class="for">Claimed by each member</p><span class="pct">${(r.savings_bps + r.points_bps) / 100}%</span>
      <ul><li>${r.savings_bps / 100}% by savings staked</li><li>${r.points_bps / 100}% by contribution points</li><li>No money lost to rounding</li></ul></div>`;
  rows($("periods").tBodies[0], [...periods].reverse().map((p) => `<tr>
      <td>Share ${p.id}</td><td data-label="Date">${date(p.ts)}</td>
      <td class="num" data-label="Shared">${usdc(BigInt(p.amount) - BigInt(p.reserve))}</td>
      <td class="num" data-label="Reserve">${usdc(p.reserve)}</td>
      <td class="num" data-label="Members">${p.members}</td></tr>`).join(""));
} catch (e) {
  console.error(e);
  rows($("passbook").tBodies[0], `<tr><td colspan="3">Could not read ${esc(dep.contract)} on ${esc(dep.network)}. Check your connection and reload.</td></tr>`);
}
