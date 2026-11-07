// Reads one Koperasi straight from NEAR (no backend) and renders members, by-laws, work, audit and profit shares.
// hero scroll progress 0..1 drives the layers fanning out (CSS reads --p)
const hero = document.querySelector(".hero");
if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
  let queued = false;
  addEventListener("scroll", () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      hero.style.setProperty("--p", Math.min(1, scrollY / hero.offsetHeight).toFixed(3));
      queued = false;
    });
  }, { passive: true });
}

import { dep, testnet, RAW, explorer, view, query, $, esc, usdc, nearAmt } from "./near.js";

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
  const recent = [...receipts].reverse().slice(0, 12);
  const proofs = await Promise.all(recent.map((r) => view(dep.contract, "get_proof", { job_id: r.job_id }).catch(() => null)));

  $("links").innerHTML = [
    `<a href="${explorer(dep.contract)}">Contract on NEAR</a>`,
    `<a href="${explorer(dep.dao)}">The co-op's DAO</a>`,
    `<a href="https://github.com/PugarHuda/koperasi">Source and demo</a>`,
  ].join("");
  $("contract-link").href = explorer(dep.contract);
  $("pb-id").textContent = dep.contract;
  $("net").textContent = `Reading ${dep.network}: ${dep.contract}`;
  $("chip").innerHTML = `${members.length} members<br>${receipts.length} jobs on-chain`;

  // join: the three calls a newcomer makes, with this co-op's real accounts and deposit
  const net = testnet ? "testnet" : "mainnet";
  $("join-deposit").textContent = `${nearAmt(info.join_deposit)} NEAR, refunded when the DAO removes you.`;
  $("join-cmd").textContent = `near call ${dep.contract} join '{}' --deposit ${nearAmt(info.join_deposit)} --accountId YOU.${net} --networkId ${net}`;
  $("sync-cmd").textContent = `near call ${dep.contract} sync_member '{"account_id":"YOU.${net}"}' --accountId YOU.${net} --gas 60000000000000 --networkId ${net}`;
  $("dao-link").href = explorer(dep.dao);
  document.querySelectorAll(".copy").forEach((b) => b.addEventListener("click", async () => {
    await navigator.clipboard.writeText($(b.dataset.copy).textContent);
    b.textContent = "Copied";
    setTimeout(() => { b.textContent = "Copy"; }, 1600);
  }));

  // hero panel: who controls this agent, in three plain steps, all read live
  const nick = (a) => a === info.steward ? "steward" : a.replace(/\.(testnet|near)$/, "").replace(/^kop-/, "").replace(/-[a-z0-9]{8}$/, "");
  const v = info.config.version;
  let approvedBy = null, proposalId = null;
  try {
    const last = await view(dep.dao, "get_last_proposal_id");
    const props = await view(dep.dao, "get_proposals", { from_index: Math.max(0, last - 100), limit: 100 });
    const match = props.reverse().find((p) => p.kind?.FunctionCall?.actions?.some((x) => x.method_name === "set_config"
      && JSON.parse(atob(x.args)).hash === info.config.hash));
    if (match) {
      proposalId = match.id;
      approvedBy = new Set(Object.entries(match.votes).filter(([, x]) => x === "Approve").map(([k]) => k));
    }
  } catch (e) { console.warn("could not read the DAO's proposals", e); }
  $("p-voters").innerHTML = members.slice(0, 6).map(([a]) => {
    const yes = !approvedBy || approvedBy.has(a);
    return `<li class="${yes ? "yes" : "no"}" title="${esc(a)}"><span class="mark" aria-hidden="true">${yes ? "✓" : "–"}</span>${esc(nick(a))}<em>${yes ? "voted yes" : "didn't vote"}</em></li>`;
  }).join("") + (members.length > 6 ? `<li class="no">+${members.length - 6} more</li>` : "");
  const yesCount = approvedBy ? members.filter(([a]) => approvedBy.has(a)).length : members.length;
  $("p-tally").innerHTML = proposalId != null
    ? `<a href="${explorer(dep.dao)}">Proposal #${proposalId}</a> passed with ${yesCount} yes ${yesCount === 1 ? "vote" : "votes"}: by-laws v${v}.`
    : `By-laws v${v} were approved by a member vote.`;
  $("p-lock").href = explorer(dep.dao);
  const termsBox = $("p-terms");
  termsBox.innerHTML = `<div><dt>Rule book</dt><dd>by-laws v${v}</dd></div><div><dt>Fingerprint</dt><dd>${short(info.config.hash)}</dd></div>`;
  fetch(`${RAW}${info.config.uri}`).then((r) => r.arrayBuffer()).then(async (raw) => {
    const hex = [...new Uint8Array(await crypto.subtle.digest("SHA-256", raw))].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (hex !== info.config.hash) return; // only show terms from the exact file the members approved
    const text = new TextDecoder().decode(raw);
    const get = (re) => esc(text.match(re)?.[1]?.trim() ?? "");
    termsBox.innerHTML += `<div><dt>Charges per job</dt><dd>${get(/^\s+price_usdc:\s*([\d.]+)/m)} USDC</dd></div>`
      + `<div><dt>AI spend cap</dt><dd>$${get(/max_inference_per_job_usd:\s*([\d.]+)/)} a job, $${get(/max_inference_per_day_usd:\s*([\d.]+)/)} a day</dd></div>`
      + `<div class="wide"><dt>Model</dt><dd>${get(/^model:\s*"?([^"\n]+)/m)}</dd></div>`;
    // the latest proof that this model runs in genuine TEEs (agent/tee.mjs; re-checked by CI)
    const model = text.match(/^model:\s*"?([^"\n]+)/m)?.[1]?.trim();
    if (!model) return;
    const file = `tee-${model.replace(/[^a-z0-9.-]/gi, "_")}.json`;
    const ev = await fetch(`${RAW}evidence/${file}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const tee = $("p-tee");
    if (!ev) { tee.textContent = `No TEE check published yet for ${model}.`; return; }
    const m = ev.models?.[0] ?? {};
    const when = new Date(ev.at).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
    tee.innerHTML = ev.ok
      ? `<span class="state on">TEE verified</span> ${esc(when)} UTC: Intel TDX ${esc(m.tdx_status ?? "")}, NVIDIA GPU ${m.gpu?.verdict === true ? "pass" : "unknown"}, bound to a fresh nonce. The agent re-checks before every job and refuses unverified models. <a href="https://github.com/PugarHuda/koperasi/blob/main/evidence/${esc(file)}">Evidence</a>`
      : `<span class="state off">TEE not verified</span> ${esc(when)} UTC: ${esc(ev.reason ?? "a check failed")}. The agent will not send jobs to this model.`;
  }).catch(() => {});
  const paidJobs = receipts.filter((x) => x.status === "Paid").length;
  $("p-agent").innerHTML = info.paused
    ? `<span class="state off">Paused</span> The members voted to stop it.`
    : `<span class="state on">Allowed to work</span> It follows by-laws v${v} and nothing else. Hand it any other version and it stops working, and the contract rejects its receipts. ${paidJobs} paid jobs so far.`;

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

  const pool = await view(dep.contract, "get_staking_pool").catch(() => null);
  $("pool-line").innerHTML = pool
    ? `Savings are read on-chain from each member's stake in <a href="${explorer(pool)}">${esc(pool)}</a>, the pool the members chose. Anyone can call <code>sync_savings</code> to refresh them.`
    : "Savings are set by a members' vote (set_savings).";
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

  // by-laws: anyone can hash the published file in their own browser and compare it with the contract
  const current = versions.find((v) => v.version === info.config.version) ?? info.config;
  const box = $("verify");
  box.innerHTML = `<button type="button" class="btn">Verify by-laws v${current.version} in your browser</button>
    <p class="hint">Downloads <code>${esc(current.uri)}</code> from the public repo, hashes it here, and compares it with the hash the members voted on.</p>`;
  box.querySelector("button").onclick = async () => {
    box.innerHTML = `<p class="hint">Hashing ${esc(current.uri)}…</p>`;
    try {
      const raw = await (await fetch(`${RAW}${current.uri}`, { cache: "no-store" })).arrayBuffer();
      const hex = [...new Uint8Array(await crypto.subtle.digest("SHA-256", raw))].map((b) => b.toString(16).padStart(2, "0")).join("");
      const text = new TextDecoder().decode(raw);
      const pick = (re) => esc(text.match(re)?.[1]?.trim() ?? "not set");
      const ok = hex === current.hash;
      box.innerHTML = `
        <p class="match ${ok ? "ok" : "bad"}">${ok ? "Match. The file is exactly what the members approved." : "Mismatch. The published file is not what the members approved."}</p>
        <dl class="hashes"><dt>Your browser</dt><dd>${hex}</dd><dt>On-chain, v${current.version}</dt><dd>${esc(current.hash)}</dd></dl>
        <dl class="terms">
          <div><dt>Model</dt><dd>${pick(/^model:\s*"?([^"\n]+)/m)}</dd></div>
          <div><dt>Bid per job</dt><dd>${pick(/^\s+price_usdc:\s*([\d.]+)/m)} USDC</dd></div>
          <div><dt>Inference cap per job</dt><dd>$${pick(/max_inference_per_job_usd:\s*([\d.]+)/)}</dd></div>
          <div><dt>Inference cap per day</dt><dd>$${pick(/max_inference_per_day_usd:\s*([\d.]+)/)}</dd></div>
          <div class="wide"><dt>Takes jobs tagged</dt><dd>${pick(/tags_any:\s*\[([^\]]*)\]/)}</dd></div>
        </dl>
        <details><summary>Read the whole file</summary><pre>${esc(text)}</pre></details>`;
    } catch (e) {
      box.innerHTML = `<p class="match bad">Could not download ${esc(current.uri)}: ${esc(e.message)}. Reload and try again.</p>`;
    }
  };

  const proofCell = (p) => {
    if (!p) return `<span class="muted">none</span>`;
    try {
      const x = JSON.parse(p);
      return `<span class="badge Paid" title="${esc(p)}">TEE-signed</span> <span class="muted">${esc(String(x.tee_signer ?? "").slice(0, 10))}…</span>`;
    } catch { return `<span class="muted">${esc(p.slice(0, 16))}</span>`; }
  };
  rows($("receipts").tBodies[0], recent.map((r, i) => `<tr>
      <td>${esc(r.job_id.slice(0, 8))}… <span class="muted">${date(r.ts)}</span></td>
      <td class="num" data-label="Price">${usdc(r.price)}</td>
      <td class="num" data-label="Inference">$${(Number(r.inference_cost) / 1e6).toFixed(4)}</td>
      <td data-label="By-laws">v${r.config_version} <span class="muted">${short(r.config_hash)}</span></td>
      <td data-label="Proof">${proofCell(proofs[i])}</td>
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

  $("audit-note").hidden = owed === 0n;
  // the treasury, read from the token contract itself rather than from Koperasi's own counter
  view(dep.usdc, "ft_balance_of", { account_id: dep.dao }).then((bal) => {
    $("treasury").innerHTML = `The DAO treasury holds <strong>${usdc(bal)} USDC</strong> right now, read from <a href="${explorer(dep.usdc)}">${esc(dep.usdc)}</a>. Spending it takes a vote.`;
  }).catch(() => {});

  // who can change the contract's code: the code it runs, the vote that chose it, and any key that could skip the vote
  Promise.all([
    query({ request_type: "view_account", account_id: dep.contract }),
    query({ request_type: "view_access_key_list", account_id: dep.contract }),
    view(dep.dao, "get_last_proposal_id").then((last) => view(dep.dao, "get_proposals", { from_index: Math.max(0, last - 100), limit: 100 })),
  ]).then(([acct, keys, props]) => {
    const code = acct.global_contract_hash ?? acct.code_hash;
    const full = keys.keys.filter((k) => k.access_key.permission === "FullAccess").length;
    const vote = [...props].reverse().find((p) => p.status === "Approved" && p.kind?.FunctionCall?.actions?.some((x) =>
      x.method_name === "upgrade" && (() => { try { return JSON.parse(atob(x.args)).code_hash === code; } catch { return false; } })()));
    const by = vote ? `approved in <a href="${explorer(dep.dao)}">proposal #${vote.id}</a>` : "not traced to a vote";
    $("codegov").innerHTML = `<h3>Who can change the contract's code?</h3>
      <p>It runs ${acct.global_contract_hash ? "the global contract" : "code"} <code>${esc(code.slice(0, 12))}…</code>, ${by}.
      A new version is published as an immutable NEAR global contract and the members vote <code>upgrade({code_hash})</code>.</p>
      <p class="match ${full ? "bad" : "ok"}">${full
        ? `The contract account still has ${full} full-access key${full > 1 ? "s" : ""}: whoever holds it could change the code without a vote. Removing it is the next step (<code>scripts/upgrade.mjs --lock</code>).`
        : "The contract account has no full-access key. Only a members' vote can change its code."}</p>`;
  }).catch((e) => { $("codegov").innerHTML = `<p class="hint">Could not read the contract account: ${esc(e.message)}</p>`; });

  // live status under the hero
  const paid = receipts.filter((x) => x.status === "Paid").length;
  $("status").innerHTML = [
    ["Agent", info.paused ? "Paused by vote" : "Allowed to work", info.paused ? "warn" : "ok"],
    ["Running by-laws", `v${info.config.version} <small>${short(info.config.hash)}</small>`, ""],
    ["Jobs on-chain", `${receipts.length} <small>${paid} paid</small>`, ""],
    ["Audit", owed > 0n ? `Red <small>${usdc(owed)} USDC missing</small>` : "Green <small>all passed on</small>", owed > 0n ? "warn" : "ok"],
  ].map(([k, v, c]) => `<div><dt>${k}</dt><dd class="${c}">${v}</dd></div>`).join("");

  const r = info.share_rule;
  $("share-rule").textContent = `The members vote each profit share. ${r.reserve_bps / 100}% stays in the DAO as the co-op's reserve; the rest is split by savings and by contribution, and each member claims their own.`;
  $("plans").innerHTML = `
    <div class="plan"><h3>Co-op<br>reserve</h3><p class="for">Stays in the DAO treasury</p><span class="pct">${r.reserve_bps / 100}%</span>
      <ul><li>Back to the Sputnik DAO</li><li>Spent only by a vote</li><li>Readable by anyone on-chain</li></ul></div>
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
  $("p-voters").innerHTML = `<li class="no">Could not reach NEAR right now. Reload in a moment.</li>`;
}
