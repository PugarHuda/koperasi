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

import { dep, testnet, RAW, explorer, txUrl, view, all, query, $, esc, usdc, nearAmt } from "./near.js";
import { verifyInBrowser } from "./tee.js";
import { byLawsPath, configVote, trustSources } from "./share.js";
const byLawsUrl = (uri) => (byLawsPath(uri) ? `${RAW}${uri}` : "about:blank#refused");

// "Don't trust us": each check writes its verdict into its card
const verdict = (id, ok, html) => {
  const li = $(id);
  li.classList.remove("pass", "fail");
  if (ok !== null) li.classList.add(ok ? "pass" : "fail");
  li.querySelector(".ck-out").innerHTML = html;
};

const date = (ns) => new Date(Number(BigInt(ns) / 1_000_000n)).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
const short = (h) => `${h.slice(0, 10)}…`;
const rows = (tbody, html) => { tbody.innerHTML = html || `<tr><td colspan="9" class="muted">Nothing yet.</td></tr>`; };

// read with the rest, not after it: the board sits above the join panel, and filling it late would move the panel
// under the reader's pointer
// with the DAO proposal that paid each task (task payouts are Transfer proposals filed by the contract's `tasks` role)
// one read shared by the brief and the board; a failed read is forgotten, so whoever asks next reads again
let board = null;
const trustBoard = () => (board ??= Promise.all([view(dep.contract, "get_board"), all(dep.contract, "get_tasks"), view(dep.contract, "get_contributors")])
  .then(async ([b, tasks, recs]) => [b, tasks, recs, await Promise.all(tasks.map((t) =>
    (t.status === "Paid" || t.status === "Paying" ? view(dep.contract, "get_payout_proposal", { id: t.id }) : null)))])
  .catch((e) => { board = null; throw e; }));
trustBoard().catch(() => {}); // started now, handled where it is rendered

// the track's brief, each line read from the chain; the counts above it are the co-op's activity so far.
// Public RPCs rate-limit in bursts: on a failure it tries again (3 times, 5 s apart) instead of staying empty.
const brief = (tries = 3) => Promise.all([
  view(dep.dao, "get_last_proposal_id"), view(dep.dao, "get_policy"), view(dep.contract, "get_info"), trustBoard(),
  all(dep.contract, "get_cases"), all(dep.contract, "get_pledges"), all(dep.contract, "get_pledge_claims"),
  view(dep.usdc, "ft_balance_of", { account_id: dep.dao }),
]).then(([proposals, policy, info, [board, tasks], cases, pledges, claims, treasury]) => {
  const role = (n) => policy.roles.find((r) => r.name === n);
  const members = role("member")?.kind?.Group ?? [];
  const paid = tasks.filter((t) => t.status === "Paid");
  const onTrust = paid.filter((t) => !t.approved_by).length;
  const kept = claims.filter((c) => c.status === "Honored").length;
  const [num, den] = policy.default_vote_policy.threshold;
  const needed = Math.min(members.length, Math.floor((members.length * num) / den) + 1);
  const rule = board.rule;
  // the hero's one live line: what is on-chain now, and where the co-op has paid
  const chains = ["NEAR", ...(dep.chainSignatures?.transfer?.sent ? ["Ethereum"] : []),
    ...((dep.intents?.payouts ?? []).some((p) => p.chain === "base" && p.status === "SUCCESS") ? ["Base"] : [])];
  $("proofline").innerHTML = `Right now on NEAR testnet: ${members.length} members, ${proposals} DAO votes, ${paid.length} tasks paid, and payouts that landed on ${chains.length > 1 ? `${chains.slice(0, -1).join(", ")} and ${chains.at(-1)}` : chains[0]}.`;
  $("counts").innerHTML = [
    ["Members", members.length, "one vote each"],
    ["DAO proposals", proposals, "every decision on record"],
    ["Tasks", tasks.length, `${paid.length} paid, ${onTrust} on earned trust`],
    ["Profit shares", info.periods, "voted, split by rule"],
    ["Court cases", cases.length, `${cases.filter((c) => c.status === "Upheld").length} upheld`],
    ["Pledges", pledges.length, `${kept} kept, ${claims.filter((c) => c.status === "Broken").length} broken`],
  ].map(([k, v, s]) => `<div><dt>${k}</dt><dd>${v} <small>${s}</small></dd></div>`).join("");
  const line = (id, ok, html) => { $(id).classList.add(ok ? "pass" : "fail"); $(id).querySelector(".ck-out").innerHTML = html; };
  line("br-own", members.length > 1 && policy.default_vote_policy.weight_kind === "RoleWeight",
    `${members.length} members hold the DAO's role <code>member</code>, one vote each: a decision needs ${needed} of ${members.length}. <a href="#members">Members</a>`);
  // "only a vote spends it", checked: no role but the members' may do more than file proposals, except the contract's
  // role `tasks`, which may file and approve transfers only (within the budget the members voted)
  const onlyVotes = policy.roles.every((r) => r.name === "member" || r.permissions.every((p) => p.endsWith(":AddProposal")
    || (r.name === "tasks" && p.startsWith("transfer:"))));
  line("br-budget", onlyVotes && board.budget !== undefined,
    `The DAO treasury holds ${usdc(treasury)} USDC; only a vote spends it. The members let the contract pay ${nearAmt(board.budget)} NEAR more for tasks. <a href="#trust">Tasks</a>`);
  line("br-rewards", info.periods > 0,
    `${info.periods} profit shares, each voted and split by the contract (${info.share_rule.savings_bps / 100}% by savings, ${info.share_rule.points_bps / 100}% by contribution points); ${paid.length} tasks paid. <a href="#shares">Profit shares</a>`);
  line("br-rep", !!rule,
    rule ? `Up to ${nearAmt(rule.auto_max)} NEAR is paid with no vote only to a contributor trusted by ${rule.trusted_after}+ other member${rule.trusted_after === 1 ? "" : "s"}${board.veto_minutes ? `, after a ${board.veto_minutes}-minute veto window` : ""}; jurors are drawn only from members in good standing. <a href="#trust">Earned trust</a>`
      : "The members have not voted a trust rule yet.");
  const tasksRole = role("tasks");
  line("br-sputnik", !!tasksRole && tasksRole.permissions.every((p) => p.startsWith("transfer:")),
    `Every payout is a Sputnik Transfer proposal. The contract files them in its own role <code>tasks</code>, which can only ${tasksRole ? tasksRole.permissions.map((p) => `<code>${esc(p)}</code>`).join(" and ") : "(missing)"}. Proposal templates for <a href="https://github.com/PugarHuda/koperasi/tree/main/trezu">Trezu</a>. <a href="#trust">Tasks</a>`);
}).catch((e) => {
  $("proofline").textContent = "The co-op lives on NEAR testnet; every claim below is checked in your browser.";
  for (const id of ["br-own", "br-budget", "br-rewards", "br-rep", "br-sputnik"]) $(id).querySelector(".ck-out").textContent = `Could not read the chain right now (${e.message})${tries > 1 ? "; trying again in 5 s." : "."}`;
  if (tries > 1) setTimeout(() => brief(tries - 1), 5000);
});
brief();

/** Public RPCs rate-limit in bursts: the page's first reads are tried 3 times, 4 s apart, before it says it failed. */
async function retried(read, tries = 3) {
  for (let k = 1; ; k++) {
    try { return await read(); } catch (e) {
      if (k >= tries || e.final) throw e; // the chain's own answer does not change on a second try
      await new Promise((ok) => setTimeout(ok, 4000));
    }
  }
}

try {
  const [info, members, versions, receipts, rekon, periods] = await retried(() => Promise.all([
    view(dep.contract, "get_info"),
    view(dep.contract, "get_members", { from: 0, limit: 200 }), // ponytail: the passbook shows 200 (one claimable read each); page it past that
    view(dep.contract, "get_config_history", { from: 0, limit: 100 }),
    view(dep.contract, "get_receipts", { from: 0, limit: 500 }),
    view(dep.contract, "get_audit"),
    view(dep.contract, "get_periods"),
  ]));
  const claimable = await retried(() => Promise.all(members.map(([a]) => view(dep.contract, "get_claimable", { account_id: a }))));
  // a receipt with an inference proof was done by a TEE-verified model; one without came from `npm run demo`, where a
  // local stand-in plays Agent Market (it has no testnet) and no model runs. The page says which is which.
  const checked = [...receipts].reverse().slice(0, 50);
  // undefined: not read (RPC busy), shown as such; null: the chain says this job has no proof
  const proofs = await Promise.all(checked.map((r) => view(dep.contract, "get_proof", { job_id: r.job_id }).catch((e) => (e.final ? null : undefined))));
  const unread = proofs.some((p) => p === undefined);
  const recent = checked.slice(0, 12);
  const proven = checked.filter((r, i) => proofs[i]).length;

  $("links").innerHTML = [
    `<a href="${explorer(dep.contract)}">Contract on NEAR</a>`,
    `<a href="${explorer(dep.dao)}">The co-op's DAO</a>`,
    `<a href="https://github.com/PugarHuda/koperasi">Source and demo</a>`,
    `<a href="/coops.html">Every co-op on this code</a>`,
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
    const match = configVote(props, dep.contract, info.config.hash);
    if (match) {
      proposalId = match.id;
      approvedBy = new Set(Object.entries(match.votes).filter(([, x]) => x === "Approve").map(([k]) => k));
    }
  } catch (e) { console.warn("could not read the DAO's proposals", e); }
  $("p-voters").innerHTML = members.slice(0, 6).map(([a]) => {
    const yes = approvedBy?.has(a);
    return `<li class="${yes ? "yes" : "no"}" title="${esc(a)}"><span class="mark" aria-hidden="true">${yes ? "✓" : "–"}</span>${esc(nick(a))}<em>${yes ? "voted yes" : approvedBy ? "didn't vote" : "vote not found"}</em></li>`;
  }).join("") + (members.length > 6 ? `<li class="no">+${members.length - 6} more</li>` : "");
  const yesCount = approvedBy ? members.filter(([a]) => approvedBy.has(a)).length : 0;
  $("p-tally").innerHTML = proposalId !== null
    ? `<a href="${explorer(dep.dao)}">Proposal #${proposalId}</a> passed with ${yesCount} yes ${yesCount === 1 ? "vote" : "votes"}: by-laws v${v}.`
    : `By-laws v${v} were approved by a member vote.`;
  $("p-lock").href = explorer(dep.dao);
  const termsBox = $("p-terms");
  termsBox.innerHTML = `<div><dt>Rule book</dt><dd>by-laws v${v}</dd></div><div><dt>Fingerprint</dt><dd>${short(info.config.hash)}</dd></div>`;
  fetch(byLawsUrl(info.config.uri)).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`)))).then(async (raw) => {
    const hex = [...new Uint8Array(await crypto.subtle.digest("SHA-256", raw))].map((b) => b.toString(16).padStart(2, "0")).join("");
    verdict("ck-bylaws", hex === info.config.hash, hex === info.config.hash
      ? `Your browser hashed <code>${esc(info.config.uri)}</code>: <code>${short(hex)}</code>, the hash the members voted for v${v}. The contract refuses receipts under any other.${dep.outlayer ? ` An Intel TDX enclave checked the same on-chain, through OutLayer (<a href="${txUrl(dep.outlayer.tx)}">the transaction</a>).` : ""}`
      : `The published file hashes to <code>${short(hex)}</code>, not the approved <code>${short(info.config.hash)}</code>.`);
    if (hex !== info.config.hash) return; // only show terms from the exact file the members approved
    const text = new TextDecoder().decode(raw);
    const get = (re) => esc(text.match(re)?.[1]?.trim() ?? "");
    termsBox.innerHTML += `<div><dt>Charges per job</dt><dd>${get(/^\s+price_usdc:\s*([\d.]+)/m)} USDC</dd></div>`
      + `<div><dt>AI spend cap</dt><dd>$${get(/max_inference_per_job_usd:\s*([\d.]+)/)} a job, $${get(/max_inference_per_day_usd:\s*([\d.]+)/)} a day</dd></div>`
      + `<div class="wide"><dt>Model</dt><dd>${get(/^model:\s*"?([^"\n]+)/m)}</dd></div>`;
    // the latest proof that this model runs in genuine TEEs (agent/tee.mjs; re-checked by CI)
    const model = text.match(/^model:\s*"?([^"\n]+)/m)?.[1]?.trim();
    if (!model) return;
    armTeeCheck(model);
    const file = `tee-${model.replace(/[^a-z0-9.-]/gi, "_")}.json`;
    const ev = await fetch(`${RAW}evidence/${file}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const tee = $("p-tee");
    if (!ev) { tee.textContent = `No TEE check published yet for ${model}.`; return; }
    const m = ev.models?.[0] ?? {};
    const when = new Date(ev.at).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
    tee.innerHTML = ev.ok
      ? `<span class="state on">TEE verified</span> ${esc(when)} UTC: Intel TDX ${esc(m.tdx_status ?? "")}, NVIDIA GPU ${m.gpu?.verdict === true ? "pass" : "unknown"}, bound to a fresh nonce. The agent re-checks before every job and refuses unverified models. <a href="/evidence/${esc(file)}">Evidence</a>`
      : `<span class="state off">TEE not verified</span> ${esc(when)} UTC: ${esc(ev.reason ?? "a check failed")}. The agent will not send jobs to this model.`;
  }).catch((e) => verdict("ck-bylaws", false, `Could not download the by-laws file (${esc(e.message)}). Reload to try again.`));
  const paidJobs = receipts.filter((x) => x.status === "Paid").length;
  const teeJobs = checked.filter((r, i) => proofs[i]);
  const teeMarket = teeJobs.filter((r) => !r.job_id.startsWith("demo-")).length;
  $("p-agent").innerHTML = info.paused
    ? `<span class="state off">Paused</span> The members voted to stop it.`
    : `<span class="state on">Allowed to work</span> It follows by-laws v${v} and nothing else. Hand it any other version and it stops working, and the contract rejects its receipts. ${teeMarket
      ? `${teeMarket} Agent Market ${teeMarket === 1 ? "job" : "jobs"} done by a TEE-verified model.`
      : `No Agent Market job yet.${teeJobs.length ? ` ${teeJobs.length === 1 ? "One job" : `${teeJobs.length} jobs`} from a demo buyer ${teeJobs.length === 1 ? "was" : "were"} done by a TEE-verified model, with the proof on-chain;` : ""} the ${paidJobs} paid receipts come from the testnet demo, where a local stand-in plays Agent Market and no model runs.`}`;

  // passbook: the co-op's life as ledger lines, newest first
  const lines = [
    ...versions.map((v) => ({ ts: v.activated_at, text: `By-laws v${v.version} approved`, amt: "" })),
    ...receipts.filter((r) => r.status === "Paid").map((r) => ({ ts: r.ts, text: `Job paid, by-laws v${r.config_version}`, amt: `+${usdc(r.price)}` })),
    ...periods.map((p) => ({ ts: p.ts, text: `Profit share ${p.id} to ${p.members} members`, amt: `-${usdc(BigInt(p.amount) - BigInt(p.reserve))}`, out: true })),
  ].sort((a, b) => (BigInt(b.ts) > BigInt(a.ts) ? 1 : -1)).slice(0, 9);
  rows($("passbook").tBodies[0], lines.map((l) =>
    `<tr><td>${date(l.ts)}</td><td>${esc(l.text)}</td><td class="num${l.out ? " out" : ""}">${l.amt}</td></tr>`).join(""));

  const owed = BigInt(rekon.owed);
  verdict("ck-money", owed === 0n, owed === 0n
    ? `Every paid job (${usdc(rekon.expected)} USDC after the market's 5%) reached the co-op's DAO. The steward's bond stays at stake.`
    : `<strong>${usdc(owed)} USDC</strong> of paid jobs has not reached the co-op. Members can vote to slash the steward's bond. (This demo co-op keeps it red on purpose.)`);
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
      const res = await fetch(byLawsUrl(current.uri), { cache: "no-store" });
      // a missing file is "could not download", never a mismatch: only the file itself is judged
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.arrayBuffer();
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
          ${/members_at_least:\s*\d+/.test(text) ? `<div class="wide"><dt>The steward hands over at</dt><dd>${pick(/members_at_least:\s*(\d+)/)} members
            (now ${info.members}) or ${pick(/paid_jobs_at_least:\s*(\d+)/)} paid jobs (now ${receipts.filter((r) => r.status === "Paid").length}), both read from the chain</dd></div>` : ""}
        </dl>
        <details><summary>Read the whole file</summary><pre>${esc(text)}</pre></details>`;
    } catch (e) {
      box.innerHTML = `<p class="match bad">Could not download ${esc(current.uri)}: ${esc(e.message)}. Reload and try again.</p>`;
    }
  };

  const proofCell = (p, job) => {
    if (p === undefined) return `<span class="muted">Proof not read (NEAR RPC busy): reload to check</span>`;
    if (!p) return `<span class="muted" title="Recorded by npm run demo against a local stand-in for Agent Market; no model ran">Demo market, no model</span>`;
    try {
      const x = JSON.parse(p);
      // a demo- job came from a stand-in buyer, but a real model in a verified TEE did it and signed the answer
      return `<span class="badge Paid" title="${esc(p)}">TEE-signed</span> <span class="muted">${job.startsWith("demo-") ? "demo buyer, real model" : esc(String(x.tee_signer ?? "").slice(0, 10)) + "…"}</span>`;
    } catch { return `<span class="muted">${esc(p.slice(0, 16))}</span>`; }
  };
  rows($("receipts").tBodies[0], recent.map((r, i) => `<tr>
      <td>${esc(r.job_id.slice(0, 8))}… <span class="muted">${date(r.ts)}</span></td>
      <td class="num" data-label="Price">${usdc(r.price)}</td>
      <td class="num" data-label="Inference">$${(Number(r.inference_cost) / 1e6).toFixed(4)}</td>
      <td data-label="By-laws">v${r.config_version} <span class="muted">${short(r.config_hash)}</span></td>
      <td data-label="Proof">${proofCell(proofs[i], r.job_id)}</td>
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

  // NEP-330: the contract names the commit and the pinned build image it came from, so anyone can rebuild the same code
  const sourceCard = (src) => {
    const b = src?.build_info;
    const rev = b?.source_code_snapshot?.match(/[?&]rev=([0-9a-f]{40})$/)?.[1];
    if (!b || !rev || typeof src.link !== "string" || !/^https:\/\/github\.com\//.test(src.link)) {
      return `<p class="hint">The contract does not publish a reproducible build yet (NEP-330).</p>`;
    }
    return `<div class="src-card" id="src-card"><h4>Rebuild it yourself (NEP-330)</h4>
      <p>The contract says it was built from commit <a href="${esc(src.link)}"><code>${esc(rev.slice(0, 7))}</code></a>
        (v${esc(src.version)}) in <code>${esc(b.build_environment.split("@")[0])}</code>, pinned by its image digest.</p>
      <pre class="does">git checkout ${esc(rev.slice(0, 7))} &amp;&amp; cd ${esc(b.contract_path || ".")}
cargo near build reproducible-wasm
# sha256 must be ${esc(dep.codeSha256)}</pre></div>`;
  };

  // who can change the contract's code: the code it runs, the vote that chose it, and any key that could skip the vote
  Promise.all([
    query({ request_type: "view_account", account_id: dep.contract }),
    query({ request_type: "view_access_key_list", account_id: dep.contract }),
    view(dep.dao, "get_last_proposal_id").then((last) => view(dep.dao, "get_proposals", { from_index: Math.max(0, last - 100), limit: 100 })),
    view(dep.contract, "contract_source_metadata").catch(() => null),
  ]).then(([acct, keys, props, src]) => {
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
        : "The contract account has no full-access key. Only a members' vote can change its code."}</p>${sourceCard(src)}`;
    verdict("ck-code", full === 0 && !!vote, full === 0
      ? `The contract account holds <strong>no full-access key</strong>, not even the builder's. Its code is ${vote ? `the version members approved in proposal #${vote.id}` : "not traced to a vote"}; changing it takes another vote.`
      : `The contract account still has ${full} full-access key${full > 1 ? "s" : ""}: someone could change the code without a vote.`);
  }).catch((e) => {
    $("codegov").innerHTML = `<p class="hint">Could not read the contract account: ${esc(e.message)}</p>`;
    verdict("ck-code", null, `Could not read the contract account right now (${esc(e.message)}).`);
  });

  // live status under the hero
  const paid = receipts.filter((x) => x.status === "Paid").length;
  $("status").innerHTML = [
    ["Agent", info.paused ? "Paused by vote" : "Allowed to work", info.paused ? "warn" : "ok"],
    ["Running by-laws", `v${info.config.version} <small>${short(info.config.hash)}</small>`, ""],
    ["Jobs on-chain", `${receipts.length} <small>${paid} paid, ${unread ? "TEE proofs not read yet" : `${proven} with TEE proof`}</small>`, ""],
    ["Audit", owed > 0n ? `Red <small>${usdc(owed)} USDC missing</small>` : "Green <small>all passed on</small>", owed > 0n ? "warn" : "ok"],
  ].map(([k, v, c]) => `<div><dt>${k}</dt><dd class="${c}">${v}</dd></div>`).join("");

  const r = info.share_rule;
  $("share-rule").textContent = `The members vote each profit share. ${r.reserve_bps / 100}% stays in the DAO as the co-op's reserve; the rest is split by savings and by contribution, and each member claims their own.`;
  $("plans").innerHTML = `
    <div class="plan"><h3>Co-op<br>reserve</h3><p class="for">Stays in the DAO treasury</p><span class="pct">${r.reserve_bps / 100}%</span>
      <ul><li>Back to the Sputnik DAO</li><li>Spent only by a vote</li><li>Readable by anyone on-chain</li></ul></div>
    <div class="plan members"><h3>Members'<br>share</h3><p class="for">Claimed by each member</p><span class="pct">${(r.savings_bps + r.points_bps) / 100}%</span>
      <ul><li>${r.savings_bps / 100}% by savings staked</li><li>${r.points_bps / 100}% by contribution points</li><li>No money lost to rounding</li></ul></div>`;
  // tasks the co-op pays for: Sputnik bounties, paid from the treasury after a vote
  view(dep.dao, "get_last_bounty_id").then(async (n) => {
    const list = n ? await view(dep.dao, "get_bounties", { from_index: 0, limit: n }) : [];
    const taken = await Promise.all(list.map((b) => view(dep.dao, "get_bounty_number_of_claims", { id: b.id }).catch(() => 0)));
    rows($("bounties").tBodies[0], list.map((b, i) => `<tr><td>${esc(b.description)}</td>
      <td class="num" data-label="Pays">${!b.token ? `${nearAmt(b.amount)} NEAR` : b.token === dep.usdc ? `${usdc(b.amount)} USDC` : `${esc(b.amount)} of ${esc(b.token)} (not the co-op's USDC)`}</td>
      <td class="num" data-label="Left">${b.times}</td><td class="num" data-label="Taken">${taken[i]}</td></tr>`).join(""));
  }).catch(() => rows($("bounties").tBodies[0], ""));
  // tasks with earned trust: the members' rule, every task, and each contributor's record with its sources
  trustBoard().then(([b, tasks, recs, payouts]) => {
    const rule = b.rule;
    $("trust-rule").innerHTML = rule
      ? `The money stays in the DAO treasury: each payout is a Transfer proposal the contract files and approves with its own DAO role <code>tasks</code>, which can do nothing else. The members let it pay <strong>${nearAmt(b.budget)} NEAR</strong> more. A member who finishes a task earns contribution points toward the profit share, in proportion to its pay: ${rule.points} for a task at the one-member limit (${nearAmt(rule.one_vote_max)} NEAR), fewer for a smaller one. A contributor who is not a member gets the pay, not the points.`
      : "The members have not voted a trust rule yet, so no task can be posted.";
    $("tiers").innerHTML = rule ? [
      ["Paid on acceptance", `up to ${nearAmt(rule.auto_max)} NEAR, for a contributor trusted by ${rule.trusted_after}+ different member${rule.trusted_after === 1 ? "" : "s"} (or a voted bounty). Each poster pays at most ${nearAmt(rule.poster_daily_auto)} NEAR a day this way. No vote.`],
      ...(b.veto_minutes ? [["Veto window", `a payout on trust waits ${b.veto_minutes} minutes first. Any member but the contributor can veto it, and then one other member must approve. After that, anyone releases it.`]] : []),
      ["One member approves", `up to ${nearAmt(rule.one_vote_max)} NEAR, or anyone without that record yet. Never the poster or the contributor.`],
      ["All members vote", `above ${nearAmt(rule.one_vote_max)} NEAR: a Sputnik DAO bounty, paid from the treasury, counted on the record.`],
    ].map(([h, p]) => `<li><b>${h}</b><span>${p}</span></li>`).join("") : "";
    const STATUS = { Open: "Open", Claimed: "Taken", Submitted: "Delivered, waiting for the poster", NeedsApproval: "Waiting for one member",
      Held: "Accepted on trust, held for a member's veto", Paying: "Paying", Paid: "Paid", Cancelled: "Cancelled" };
    const work = (d) => (/^https:\/\/\S+$/.test(d) ? `<a href="${esc(d)}" rel="noopener">${esc(d)}</a>` : esc(d));
    rows($("tasks").tBodies[0], tasks.map((t, i) => [t, i]).reverse().map(([t, i]) => `<tr id="task-${t.id}">
      <td><strong>#${t.id}</strong> ${esc(t.description)}<span class="claim">posted by ${esc(t.poster)}${t.deliverable ? `; delivered: ${work(t.deliverable)}` : ""}</span></td>
      <td class="num" data-label="Pays">${nearAmt(t.amount)} NEAR</td>
      <td data-label="Status">${STATUS[t.status] ?? esc(t.status)}</td>
      <td data-label="Contributor">${t.contributor ? `<a href="${explorer(t.contributor)}">${esc(t.contributor)}</a>` : "–"}</td>
      <td data-label="Paid how">${t.status !== "Paid" ? "–" : t.approved_by ? `approved by ${esc(t.approved_by)}` : "on earned trust, no vote"}${
        payouts[i] === null || payouts[i] === undefined ? "" : `; <a href="${explorer(dep.dao)}">DAO proposal #${esc(payouts[i])}</a>`}</td></tr>`).join(""));
    const src = (r) => {
      const [kind, id] = r.split(":");
      return kind === "task" ? `<a href="#task-${esc(id)}">task #${esc(id)}</a>` : `<a href="${explorer(dep.dao)}">DAO proposal #${esc(id)}</a>`;
    };
    rows($("records").tBodies[0], recs.map(([who, r]) => `<tr><td><a href="${explorer(who)}">${esc(who)}</a></td>
      <td class="num" data-label="Finished">${r.done}</td>
      <td data-label="Trusted">${rule && trustSources(r.refs, tasks) >= rule.trusted_after ? `yes, up to ${nearAmt(rule.auto_max)} NEAR` : "not yet"}</td>
      <td data-label="Sources">${r.refs.map(src).join(", ")}</td></tr>`).join(""));
  }).catch(() => {
    $("trust-rule").textContent = "Could not read the task board right now. Reload in a moment.";
    rows($("tasks").tBodies[0], "");
    rows($("records").tBodies[0], "");
  });
  // what members owe each other (contract 0.2.4), the steward's term, and the treasury's Ethereum address
  Promise.all([all(dep.contract, "get_pledges"), all(dep.contract, "get_pledge_claims"), all(dep.contract, "get_cases"), view(dep.contract, "get_steward_term"),
    Promise.all(members.map(([a]) => view(dep.contract, "get_standing", { account_id: a })))]).then(([pledges, claims, cases, [days, ends], standing]) => {
    const kept = (id, st) => claims.filter((c) => c.pledge === id && c.status === st).length;
    rows($("pledges").tBodies[0], [...pledges].reverse().map((p) => `<tr><td><strong>#${p.id}</strong> ${esc(p.what)}</td>
      <td data-label="By"><a href="cert.html?who=${encodeURIComponent(p.issuer)}">${esc(p.issuer)}</a></td>
      <td class="num" data-label="Called in">${p.called} of ${p.units}</td><td data-label="Kept / broken">${kept(p.id, "Honored")} / ${kept(p.id, "Broken")}</td></tr>`).join(""));
    const OUT = { Open: "jury out", Upheld: "upheld: refunded", Dismissed: "not upheld" };
    rows($("cases").tBodies[0], [...cases].reverse().map((c) => `<tr><td><strong>#${c.id}</strong> job ${esc(c.job_id)}<span class="claim">“${esc(c.reason)}”, brought by ${esc(c.claimant)} for ${esc(c.refund_to)}</span></td>
      <td class="num" data-label="Refund">${usdc(c.amount)} USDC</td>
      <td data-label="Jurors">${c.jurors.map((j) => { const v = c.votes.find(([x]) => x === j); return `${esc(j)}: ${v ? (v[1] ? "uphold" : "reject") : "–"}`; }).join("<br>")}</td>
      <td data-label="Outcome">${OUT[c.status] ?? esc(c.status)}${c.refund_proposal !== null ? `; <a href="${explorer(dep.dao)}">DAO proposal #${esc(c.refund_proposal)}</a>` : ""}</td></tr>`).join(""));
    $("standing").innerHTML = members.map(([a], i) => {
      const [x, good] = standing[i];
      return `<li><b><a href="cert.html?who=${encodeURIComponent(a)}">${esc(a)}</a>: ${good ? "good standing" : "not in good standing"}</b>
        <span>${x.pledges_honored} pledge(s) kept, ${x.pledges_broken} broken; ${x.juries_served} jury ruling(s), ${x.juries_missed} missed${x.slashed ? `; slashed ${x.slashed} time(s)` : ""}</span></li>`;
    }).join("");
    if (info.steward && ends) $("audit-term").innerHTML = `The steward serves ${days} days by the members' vote, until <strong>${date(ends)}</strong>; then anyone can end the term and the role waits for a new vote.`;
  }).catch(() => {
    rows($("pledges").tBodies[0], "");
    rows($("cases").tBodies[0], "");
  });
  if (dep.chainSignatures) {
    const c = dep.chainSignatures;
    $("multichain").innerHTML = `The co-op also holds an Ethereum address, <a href="https://sepolia.etherscan.io/address/${esc(c.address)}"><code>${esc(c.address)}</code></a>, with no private key anywhere:
      NEAR's MPC network (<a href="${explorer(c.signer)}">${esc(c.signer)}</a>) signs for it only when the DAO asks, by a members' vote.
      Proof: the statement signed by <a href="${txUrl(c.tx)}">vote #${esc(c.proposal)}</a> recovers to this address (<code>npm run chainsig</code>).${c.transfer ? `
      And it pays on Ethereum by vote: <a href="${txUrl(c.transfer.tx)}">vote #${esc(c.transfer.proposal)}</a> had it sign a transfer of ${esc(c.transfer.eth)} Sepolia ETH to ${esc(c.transfer.to.slice(0, 10))}…${c.transfer.toNote ? `, ${esc(c.transfer.toNote)}` : ""} (<a href="https://sepolia.etherscan.io/tx/${esc(c.transfer.hash)}">the Ethereum transaction</a>${c.transfer.sent ? "" : ", sent once the address holds Sepolia ETH for gas"}).` : ""}${dep.intents ? `
      The same address owns the agent's NEAR Intents wallet (<code>${esc(dep.intents.agent_id)}</code>, on Tidepool's testnet mirror of the Intents Agent API): the DAO created it by <a href="${txUrl(dep.intents.created.tx)}">vote #${esc(dep.intents.created.proposal)}</a>${dep.intents.grant ? ` and let the agent act by <a href="${txUrl(dep.intents.grant.tx)}">vote #${esc(dep.intents.grant.proposal)}</a>` : ""}. Its policy pays only members, at most 5 USDC a payment and $10 a day, each payout held 10 minutes like the veto window; changing it takes another vote.${(dep.intents.payouts ?? []).filter((p) => p.status === "SUCCESS").map((p) => ` It paid ${esc(p.amount)} USDC to ${esc(p.to)} ${p.chain === "base" && p.destination_tx ? `on Base Sepolia (<a href="https://sepolia.basescan.org/tx/${esc(p.destination_tx)}">the transaction</a>)` : p.tx ? `on NEAR (<a href="${txUrl(p.tx)}">the transaction</a>)` : ""}.`).join("")}` : ""}`;
  }
  rows($("periods").tBodies[0], [...periods].reverse().map((p) => `<tr>
      <td>Share ${p.id}</td><td data-label="Date">${date(p.ts)}</td>
      <td class="num" data-label="Shared">${usdc(BigInt(p.amount) - BigInt(p.reserve))}</td>
      <td class="num" data-label="Reserve">${usdc(p.reserve)}</td>
      <td class="num" data-label="Members">${p.members}</td></tr>`).join(""));

  // a deep link (#audit…) lands before the chain data fills the sections above it, which then push it away: keep it in
  // place while the page grows, until the reader scrolls, clicks or follows another link, or 8 s pass
  const target = location.hash.length > 1 && document.getElementById(location.hash.slice(1));
  if (target) {
    // the hash is checked too: hashchange arrives a task after the browser has scrolled to the new section
    const stick = new ResizeObserver(() => location.hash === `#${target.id}` && target.scrollIntoView({ block: "start" }));
    const stop = () => stick.disconnect();
    stick.observe(document.body);
    ["wheel", "touchstart", "keydown", "click", "hashchange"].forEach((ev) => addEventListener(ev, stop, { once: true, passive: true }));
    setTimeout(stop, 8000);
  }
} catch (e) {
  console.error(e);
  for (const id of ["ck-bylaws", "ck-code", "ck-money"]) verdict(id, null, "Could not reach NEAR right now. Reload in a moment.");
  rows($("passbook").tBodies[0], `<tr><td colspan="3">Could not read ${esc(dep.contract)} on ${esc(dep.network)}. Check your connection and reload.</td></tr>`);
  $("p-voters").innerHTML = `<li class="no">Could not reach NEAR right now. Reload in a moment.</li>`;
}

// The visitor verifies the TEE themselves: fresh nonce, Intel's collateral, checked in this browser
function armTeeCheck(model) {
  const btn = $("ck-tee-run");
  const out = $("ck-tee-out");
  btn.textContent = `Verify ${model} with your own nonce`;
  btn.disabled = false;
  btn.onclick = async () => {
    btn.disabled = true;
    verdict("ck-tee", null, "");
    const step = (t) => { out.innerHTML = `<p class="hint">${esc(t)}</p>`; };
    const r = await verifyInBrowser(model, step);
    btn.disabled = false;
    btn.textContent = "Verify again with a new nonce";
    if (r.reason) {
      verdict("ck-tee", false, `<p>Not verified: ${esc(r.reason)}.</p>`);
      return;
    }
    const yes = (b) => (b ? "yes" : "NO");
    const row = (name, x) => `<tr><th scope="row">${name}</th><td>${esc(x.tdx ?? "-")}</td><td>${yes(x.nonce)}</td><td>${yes(x.address)}</td>`
      + `<td>${yes(x.compose)}</td><td>${x.gpuNonce === null || x.gpuNonce === undefined ? "n/a" : yes(x.gpuNonce)}</td></tr>`;
    verdict("ck-tee", r.ok, `<p><strong>${r.ok ? "Verified" : "Not verified"}</strong> in ${(r.ms / 1000).toFixed(1)} s with your nonce <code>${r.nonce.slice(0, 16)}…</code>.</p>
      <div class="ck-scroll" tabindex="0" role="region" aria-label="TEE checks per server"><table class="ck-table"><thead><tr><th scope="col">Server</th><th scope="col">Intel TDX</th><th scope="col">Your nonce</th>
        <th scope="col">Signing key</th><th scope="col">Attested code</th><th scope="col">GPU nonce</th></tr></thead>
      <tbody>${row("Gateway", r.gateway)}${r.models.map((m, i) => row(`Model ${i + 1}`, m)).join("")}</tbody></table></div>
      <p class="hint">NVIDIA's own verdict on the GPUs needs NVIDIA's service, which browsers cannot call: the agent checks it before every job and CI daily (above).</p>`);
  };
}
