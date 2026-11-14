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

import { dep, testnet, RAW, explorer, txUrl, txStatus, view, all, query, $, esc, usdc, nearAmt } from "./near.js";
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

// a deep link (#audit…) lands before the chain data fills the sections above it, which then push it away: keep the
// hash's section in place while the page grows, for 8 s, until the reader scrolls, clicks or types. Following another
// in-page link (hashchange, which comes after its click) holds the new section for 8 s from then.
let holdUntil = 0, moved = false;
const hold = () => { holdUntil = Date.now() + 8000; };
new ResizeObserver(() => {
  const target = Date.now() < holdUntil && location.hash.length > 1 && document.getElementById(location.hash.slice(1));
  if (target) target.scrollIntoView({ block: "start" });
}).observe(document.body);
["wheel", "touchstart", "keydown", "click"].forEach((ev) => addEventListener(ev, () => { holdUntil = 0; moved = true; }, { passive: true }));
addEventListener("hashchange", hold);

try {
  const [info, members, versions, receipts, rekon, periods] = await retried(() => Promise.all([
    view(dep.contract, "get_info"),
    view(dep.contract, "get_members", { from: 0, limit: 200 }), // ponytail: the passbook shows 200 (one claimable read each); page it past that
    view(dep.contract, "get_config_history", { from: 0, limit: 100 }),
    view(dep.contract, "get_receipts", { from: 0, limit: 500 }),
    view(dep.contract, "get_audit"),
    view(dep.contract, "get_periods"),
  ]));
  // The hero's vote is asked for first: near.js sends at most 4 reads at a time, in order, so the 50 proofs and the
  // members' claimable shares queue behind it and are filled in when they arrive.
  const configVoteP = view(dep.dao, "get_last_proposal_id")
    .then((last) => view(dep.dao, "get_proposals", { from_index: Math.max(0, last - 100), limit: 100 }))
    .then((props) => configVote(props, dep.contract, info.config.hash))
    .catch((e) => { console.warn("could not read the DAO's proposals", e); return null; });
  // the same (shared, usually already answered) read: resumes after the callback above has queued get_proposals
  await view(dep.dao, "get_last_proposal_id").catch(() => {});
  const claimableP = retried(() => Promise.all(members.map(([a]) => view(dep.contract, "get_claimable", { account_id: a }))));
  claimableP.catch(() => {}); // awaited below; this only stops an early failure being reported as unhandled
  // a receipt with an inference proof was done by a TEE-verified model; one without came from `npm run demo`, where a
  // local stand-in plays Agent Market (it has no testnet) and no model runs. The page says which is which.
  const checked = [...receipts].reverse().slice(0, 50);
  const recent = checked.slice(0, 12);
  // undefined: not read (RPC busy), shown as such; null: the chain says this job has no proof
  const proofsP = Promise.all(checked.map((r) => view(dep.contract, "get_proof", { job_id: r.job_id }).catch((e) => (e.final ? null : undefined))));

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
  const owed = BigInt(rekon.owed);
  // live status under the hero; the TEE-proof count is filled in once the proofs are read
  const paid = receipts.filter((x) => x.status === "Paid").length;
  const status = (proofNote) => {
    $("status").innerHTML = [
      ["Agent", info.paused ? "Paused by vote" : "Allowed to work", info.paused ? "warn" : "ok"],
      ["Running by-laws", `v${info.config.version} <small>${short(info.config.hash)}</small>`, ""],
      ["Jobs on-chain", `${receipts.length} <small>${paid} paid, ${proofNote}</small>`, ""],
      ["Audit", owed > 0n ? `Red <small>${usdc(owed)} USDC missing</small>` : "Green <small>all passed on</small>", owed > 0n ? "warn" : "ok"],
    ].map(([k, v, c]) => `<div><dt>${k}</dt><dd class="${c}">${v}</dd></div>`).join("");
  };
  status("TEE proofs not read yet");

  let approvedBy = null, proposalId = null;
  const match = await configVoteP;
  if (match) {
    proposalId = match.id;
    approvedBy = new Set(Object.entries(match.votes).filter(([, x]) => x === "Approve").map(([k]) => k));
  }
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

  // passbook: the co-op's life as ledger lines, newest first
  const lines = [
    ...versions.map((v) => ({ ts: v.activated_at, text: `By-laws v${v.version} approved`, amt: "" })),
    ...receipts.filter((r) => r.status === "Paid").map((r) => ({ ts: r.ts, text: `Job paid, by-laws v${r.config_version}`, amt: `+${usdc(r.price)}` })),
    ...periods.map((p) => ({ ts: p.ts, text: `Profit share ${p.id} to ${p.members} members`, amt: `-${usdc(BigInt(p.amount) - BigInt(p.reserve))}`, out: true })),
  ].sort((a, b) => (BigInt(b.ts) > BigInt(a.ts) ? 1 : -1)).slice(0, 9);
  rows($("passbook").tBodies[0], lines.map((l) =>
    `<tr><td>${date(l.ts)}</td><td>${esc(l.text)}</td><td class="num${l.out ? " out" : ""}">${l.amt}</td></tr>`).join(""));

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
  const claimable = await claimableP;
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
    let x;
    try { x = JSON.parse(p); } catch { return `<span class="muted">${esc(p.slice(0, 16))}</span>`; }
    // the by-laws gate ran on-chain in an Intel TDX enclave (OutLayer) before the job started
    const gate = x.gate?.tx ? ` <a class="badge Paid" href="${txUrl(String(x.gate.tx))}" title="By-laws checked inside an Intel TDX enclave (OutLayer) before this job">TDX gate</a>` : "";
    if (!x.model) return `<span class="muted" title="Recorded by npm run demo against a local stand-in for Agent Market; no model ran">Demo market, no model</span>${gate}`;
    // a demo- job came from a stand-in buyer, but a real model in a verified TEE did it and signed the answer
    return `<span class="badge Paid" title="${esc(p)}">TEE-signed</span> <span class="muted">${job.startsWith("demo-") ? "demo buyer, real model" : esc(String(x.tee_signer ?? "").slice(0, 10)) + "…"}</span>${gate}`;
  };
  // everything that cites the proofs is filled in once they are read; the sections below do not wait for them
  proofsP.then((proofs) => {
    const unread = proofs.some((p) => p === undefined);
    // a proof is JSON: `model`… when a TEE-verified model did the job, `gate` when the by-laws were checked in an enclave first
    const parsed = proofs.map((p) => { try { return p ? JSON.parse(p) : null; } catch { return null; } });
    const teeJobs = checked.filter((r, i) => parsed[i]?.model);
    status(unread ? "TEE proofs not read yet" : `${teeJobs.length} with TEE proof`);
    const teeMarket = teeJobs.filter((r) => !/^(demo|taskbond)-/.test(r.job_id)).length;
    const demoTee = teeJobs.filter((r) => r.job_id.startsWith("demo-"));
    // jobs won on a third-party testnet market (scripts/taskbond.mjs): another team's escrow, guard and reviewer
    const won = (dep.taskbond ?? []).filter((t) => t.status === "Paid" && t.winner === t.agent_id);
    const third = won.length ? ` On <a href="https://taskbond-iota.vercel.app/jobs/${esc(won.at(-1).job)}">Taskbond</a>, another team's testnet market, it won ${won.length === 1 ? "a job" : `${won.length} jobs`} its reviewer AI scored ${won.map((t) => esc(t.score)).join(", ")}/100, paid by that market's escrow.` : "";
    $("p-agent").innerHTML = info.paused
      ? `<span class="state off">Paused</span> The members voted to stop it.`
      : `<span class="state on">Allowed to work</span> It follows by-laws v${v} and nothing else. Hand it any other version and it stops working, and the contract rejects its receipts. ${teeMarket
        ? `${teeMarket} Agent Market ${teeMarket === 1 ? "job" : "jobs"} done by a TEE-verified model.`
        : `No Agent Market job yet.${third}${demoTee.length ? ` ${demoTee.length === 1 ? "One job" : `${demoTee.length} jobs`} from a demo buyer ${demoTee.length === 1 ? "was" : "were"} done by a TEE-verified model, with the proof on-chain;` : ""} the other paid receipts come from the testnet demo, where a local stand-in plays Agent Market and no model runs.`}`;
    rows($("receipts").tBodies[0], recent.map((r, i) => `<tr>
        <td>${esc(r.job_id.slice(0, 8))}… <span class="muted">${date(r.ts)}</span></td>
        <td class="num" data-label="Price">${usdc(r.price)}</td>
        <td class="num" data-label="Inference">$${(Number(r.inference_cost) / 1e6).toFixed(4)}</td>
        <td data-label="By-laws">v${r.config_version} <span class="muted">${short(r.config_hash)}</span></td>
        <td data-label="Proof">${proofCell(proofs[i], r.job_id)}</td>
        <td data-label="Status"><span class="badge ${r.status}">${r.status}</span></td></tr>`).join(""));
  }).catch((e) => console.error(e));

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
    // scripts/scenarios.mjs ran twice, so tasks #16–#22 repeat #9–#15 (each a real task in its own state): say so
    const firstWith = new Map();
    for (const t of tasks) if (!firstWith.has(t.description)) firstWith.set(t.description, t.id);
    rows($("tasks").tBodies[0], tasks.map((t, i) => [t, i]).reverse().map(([t, i]) => `<tr id="task-${t.id}">
      <td><strong>#${t.id}</strong> ${esc(t.description)}${firstWith.get(t.description) !== t.id ? ` <span class="tag-repeat">repeat of #${esc(firstWith.get(t.description))}</span>` : ""}<span class="claim">posted by ${esc(t.poster)}${t.deliverable ? `; delivered: ${work(t.deliverable)}` : ""}</span></td>
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
    Promise.all(members.map(([a]) => view(dep.contract, "get_standing", { account_id: a })))]).then(async ([pledges, claims, cases, [days, ends], standing]) => {
    // contract 0.2.7: a dismissed case may go on appeal to every member, who vote the refund as a DAO proposal
    const appeals = await Promise.all(cases.map((c) => (c.status === "Dismissed" ? view(dep.contract, "get_appeal", { id: c.id }).catch(() => null) : null)));
    // contract 0.2.8: what the claimant and the steward filed while the case was open
    const evidence = await Promise.all(cases.map((c) => view(dep.contract, "get_evidence", { id: c.id }).catch(() => [])));
    // a sha256 in a piece of evidence is checked against the case's receipt: the hash of what the agent delivered
    const delivered = new Map((await all(dep.contract, "get_receipts").catch(() => [])).map((r) => [r.job_id, r.deliverable_hash]));
    const against = (c, what) => {
      const hashes = String(what).match(/\b[0-9a-f]{64}\b/g) ?? [];
      if (!hashes.length) return "";
      return hashes.includes(delivered.get(c.job_id)) ? " <strong>(the hash matches the delivered work on the receipt)</strong>"
        : " <strong>(no hash here matches the receipt's delivered work)</strong>";
    };
    const APPEAL = { Open: "on appeal: the members vote", Upheld: "appealed: the members overturned it, refunded", Dismissed: "appealed: the members kept the ruling" };
    const kept = (id, st) => claims.filter((c) => c.pledge === id && c.status === st).length;
    rows($("pledges").tBodies[0], [...pledges].reverse().map((p) => `<tr><td><strong>#${p.id}</strong> ${esc(p.what)}</td>
      <td data-label="By"><a href="cert.html?who=${encodeURIComponent(p.issuer)}">${esc(p.issuer)}</a></td>
      <td class="num" data-label="Called in">${p.called} of ${p.units}</td><td data-label="Kept / broken">${kept(p.id, "Honored")} / ${kept(p.id, "Broken")}</td></tr>`).join(""));
    const OUT = { Open: "jury out", Upheld: "upheld: refunded", Dismissed: "not upheld" };
    rows($("cases").tBodies[0], [...cases].map((c, i) => [c, appeals[i], evidence[i]]).reverse().map(([c, a, ev]) => `<tr><td><strong>#${c.id}</strong> job ${esc(c.job_id)}<span class="claim">“${esc(c.reason)}”, brought by ${esc(c.claimant)} for ${esc(c.refund_to)}</span>${
      ev.map(([by, what]) => `<span class="claim">evidence from ${by === c.claimant ? "the claimant" : "the steward"}: ${esc(what)}${against(c, what)}</span>`).join("")}</td>
      <td class="num" data-label="Refund">${usdc(c.amount)} USDC</td>
      <td data-label="Jurors">${c.jurors.map((j) => { const v = c.votes.find(([x]) => x === j); return `${esc(j)}: ${v ? (v[1] ? "uphold" : "reject") : "–"}`; }).join("<br>")}</td>
      <td data-label="Outcome">${OUT[c.status] ?? esc(c.status)}${c.refund_proposal !== null ? `; <a href="${explorer(dep.dao)}">DAO proposal #${esc(c.refund_proposal)}</a>` : ""}${
        a ? `; ${APPEAL[a.status] ?? esc(a.status)}${a.proposal !== null ? ` (<a href="${explorer(dep.dao)}">DAO proposal #${esc(a.proposal)}</a>)` : ""}` : ""}</td></tr>`).join(""));
    $("standing").innerHTML = members.map(([a], i) => {
      const [x, good] = standing[i];
      return `<li><b><a href="cert.html?who=${encodeURIComponent(a)}">${esc(a)}</a>: ${good ? "good standing" : "not in good standing"}</b>
        <span>${x.pledges_honored} pledge(s) kept, ${x.pledges_broken} broken; ${x.juries_served} jury ruling(s), ${x.juries_missed} missed${x.slashed ? `; slashed ${x.slashed} time(s)` : ""}</span></li>`;
    }).join("");
    if (info.steward && ends) $("audit-term").innerHTML = `The steward serves ${days} days by the members' vote, until <strong>${date(ends)}</strong>; then anyone can end the term and the role waits for a new vote.`;
  }).catch(() => {
    // a failed read is not an empty record: say so (rows("") would print "Nothing yet.")
    for (const id of ["pledges", "cases"]) {
      $(id).tBodies[0].innerHTML = `<tr><td colspan="4" class="muted">Could not read this from NEAR right now (a busy public RPC). Reload to try again.</td></tr>`;
    }
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

  if (!moved) hold(); // the first deep link, held from when the data arrives (the stick is set up above the try)
} catch (e) {
  console.error(e);
  for (const id of ["ck-bylaws", "ck-code", "ck-money"]) verdict(id, null, "Could not reach NEAR right now. Reload in a moment.");
  rows($("passbook").tBodies[0], `<tr><td colspan="3">Could not read ${esc(dep.contract)} on ${esc(dep.network)}. Check your connection and reload.</td></tr>`);
  $("p-voters").innerHTML = `<li class="no">Could not reach NEAR right now. Reload in a moment.</li>`;
  const no = "not read: NEAR could not be reached; reload in a moment";
  for (const id of ["codegov", "trust-rule", "pb-id", "p-agent"]) if ($(id)) $(id).textContent = no;
  document.querySelectorAll("#status dd, #counts dd, #counts strong").forEach((el) => { if (el.textContent.trim() === "…") el.textContent = "–"; });
  const tee = $("ck-tee-run");
  if (tee?.disabled) tee.textContent = "Needs the by-laws from NEAR: reload in a moment";
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

// attacks sent to the live co-op as real transactions (scripts/redteam.mjs): each is read back here and must have failed
// on-chain with the refusal it was saved with, so the list cannot claim a refusal the chain does not show
if (dep.redteam?.length) {
  Promise.all(dep.redteam.map((r) => txStatus(r.tx, r.by).then((t) => {
    const failure = JSON.stringify(t?.status?.Failure ?? t?.receipts_outcome?.map((o) => o.outcome.status.Failure).find(Boolean) ?? null);
    return failure !== "null" && failure.includes(JSON.stringify(r.error.slice(0, 60)).slice(1, -1));
  }, () => null))).then((res) => {
    const refused = res.filter((x) => x === true).length;
    const unread = res.filter((x) => x === null).length;
    verdict("ck-attacks", unread ? null : refused === res.length, `${refused} of ${res.length} attacks on this co-op failed on-chain with the contract's or the DAO's own refusal${unread ? ` (${unread} not readable right now)` : ""}.
      <details><summary>What was tried</summary><ul class="attacks">${dep.redteam.map((r, i) => `<li>${res[i] === true ? "refused" : res[i] === null ? "not read" : "<strong>NOT REFUSED</strong>"}: ${esc(r.what)}
        <span class="claim">“${esc(r.error.slice(0, 90))}” <a href="${txUrl(r.tx)}">tx</a></span></li>`).join("")}</ul></details>`);
  });
} else {
  $("ck-attacks").hidden = true;
}

// the annual members' meeting (scripts/rat.mjs): the report the agent wrote in a TEE from the chain's facts, approved by vote
const lastRat = dep.rat?.at(-1);
if (lastRat) {
  $("rat").hidden = false;
  $("rat").innerHTML = `<b>Annual members' meeting ${esc(lastRat.year)}.</b> The co-op's agent wrote the <a href="${esc(lastRat.report)}">accountability report</a>
    inside a TEE from <a href="${esc(lastRat.facts)}">the facts read from the chain</a>; the members approved exactly those bytes by
    <a href="${explorer(dep.dao)}">DAO vote #${esc(lastRat.proposal)}</a> (sha256 ${esc(lastRat.report_sha256.slice(0, 12))}…).`;
}

// contract 0.2.9: the agent as a defendant, the mandatory dues, and this year's agenda
Promise.all([view(dep.contract, "get_agent_standing"), view(dep.contract, "get_dues"), view(dep.contract, "get_agenda", { year: new Date().getUTCFullYear() }),
  view(dep.contract, "get_share_funds").catch(() => []), view(dep.contract, "get_loan_rule").catch(() => null),
  // 0.3.2 and 0.3.3 (older contracts: nothing shown)
  view(dep.contract, "get_agent_member").catch(() => null), view(dep.contract, "get_risk_fund").catch(() => null),
  view(dep.contract, "get_reputation_share").catch(() => 0)])
  .then(([agent, dues, agenda, funds, loans, member, risk, repBps]) => {
    const parts = [`<b>The agent answers to the court.</b> ${agent.strikes.length
      ? `${agent.strikes.length} case(s) upheld against its jobs in 90 days (${agent.strikes.map(([id]) => `#${esc(id)}`).join(", ")}): its daily inference budget is divided by ${2 ** agent.strikes.length}`
      : "No case upheld against its jobs in 90 days"}${agent.suspended ? "; <strong>suspended</strong> until the members reinstate it" : "; at 3 the contract suspends it"}.`];
    if (dues && BigInt(dues.amount) > 0n) parts.push(`<b>Mandatory dues:</b> ${nearAmt(dues.amount)} NEAR every ${esc(dues.every_days)} days into the treasury, voted by the members; 7 days behind and a member loses good standing.`);
    // contract 0.3.0: funds from the surplus, and the savings-and-loan fund
    if (funds.length) parts.push(`<b>Funds from every profit share:</b> ${funds.map((f) => `${esc(f.name)} ${f.bps / 100}% to <a href="${explorer(f.to)}">${esc(f.to)}</a>`).join("; ")}, out of the reserve.`);
    if (loans) parts.push(`<b>Savings and loans:</b> a member in good standing with a guarantor borrows up to ${nearAmt(loans[0].max_loan)} NEAR for ${esc(loans[0].term_days)} days at ${loans[0].rate_bps / 100}% flat; the fund can lend ${nearAmt(loans[1])} NEAR now. A late loan costs the borrower and their guarantors good standing.`);
    if (member && (member.share_bps || risk)) parts.push(`<b>The agent is a member too.</b> It gets ${member.share_bps / 100}% of every profit share, scaled by its standing (now ${member.standing_bps / 100}%: halved for each upheld case), into the risk fund that refunds its mistakes at once: ${risk ? `${usdc(risk[0])} USDC there now, it saves ${risk[1] / 100}% of its earnings` : ""}; ${usdc(member.shu_total)} USDC from its shares so far.`);
    if (repBps) parts.push(`<b>Reputation dividend:</b> ${repBps / 100}% of every profit share is split among members in good standing by their work since the last one (finished tasks, pledges kept, juries served), plus half their last weight.`);
    // the agent's proposals and the federation's ceiling have their own cards below (#card-proposal, #card-credit)
    if (agenda.length) parts.push(`<b>This year's agenda:</b> ${agenda.map(([by, item]) => `“${esc(item)}” (${esc(by.split(".")[0])})`).join("; ")}.`);
    $("duties").hidden = false;
    $("duties").innerHTML = parts.join("<br>");
  }, () => {});


// Newest, read from the chain: one card each. A card whose reads fail stays hidden.
const card = (id, html) => { $(id).querySelector(".card-out").innerHTML = html; $(id).hidden = false; };
const day = (ns) => new Date(Number(BigInt(ns) / 1_000_000n)).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const GITHUB = "https://github.com/PugarHuda/koperasi/blob/main/";

// the Shade Agent: a worker whose key was made in a Phala TDX VM, attested by the registry the DAO owns
const tee = dep.tee;
if (tee) {
  Promise.all([view(tee.registry, "get_agent", { account_id: tee.worker }), view(tee.registry, "get_contract_info"),
    view(dep.contract, "get_agent_tee", { account_id: tee.worker }), view(dep.contract, "get_receipt_agent", { job_id: tee.receipt })])
    .then(([att, [owner], [teeOnly, held], recAgent]) => {
      if (!att || !held) throw new Error("not attested");
      const holds = BigInt(att.valid_until) > BigInt(Date.now()) * 1_000_000n;
      card("card-tee", `<p>Worker <a href="${explorer(tee.worker)}"><code>${esc(short(tee.worker))}</code></a>: its key was made inside an Intel TDX VM
        (${esc(tee.cvm?.provider ?? "Phala Cloud")}). Its quote was checked on-chain by <a href="${explorer(tee.registry)}">${esc(tee.registry)}</a>,
        owned by ${owner === dep.dao ? "the co-op's DAO" : `<code>${esc(owner)}</code>`}.</p>
        <ul><li>Code (compose hash) <code>${esc(short(att.compose_hash))}</code>, <a href="${GITHUB}${esc(tee.compose)}">${esc(tee.compose)}</a></li>
        <li>Machine (PPID) <code>${esc(short(att.ppid))}</code></li>
        <li>Attestation ${holds ? "holds until" : "ran out on"} ${esc(day(att.valid_until))}</li></ul>
        <p>The members approved this code and machine by <a href="${explorer(dep.dao)}">DAO proposal #${esc(tee.approve)}</a> and admitted the worker
        ${teeOnly ? "TEE-only" : ""} by #${esc(tee.admit)}: its receipts count only while the attestation holds.
        ${recAgent === tee.worker ? `It recorded receipt <code>${esc(short(tee.receipt))}</code> from inside the TEE, after the by-laws gate in the OutLayer enclave
        (<a href="${txUrl(tee.gate)}">tx ${esc(short(tee.gate))}</a>).` : ""}</p>
        <p class="muted">The VM was stopped after its job to save cost; the attestation and the receipt stay on-chain.</p>`);
    }, () => {});
}

// the agent's own by-laws proposal: what it read, what it judged, what it changed, and how the members voted
const loadJson = (path) => fetch(path).then((r) => (r.ok ? r.json() : null), () => null);
view(dep.contract, "get_agent_proposals").then(async (list) => {
  if (!list.length) return;
  // newest proposal whose files the agent published (web/agent-proposals/v<N>.json)
  let p = null, file = null;
  for (const q of [...list].reverse()) if ((file = await loadJson(`agent-proposals/v${Number(q.version)}.json`))) { p = q; break; }
  if (!p || !file) return;
  const [facts, dao, cfg] = await Promise.all([loadJson(`agent-proposals/v${Number(p.version)}.facts.json`), view(dep.dao, "get_proposal", { id: Number(p.proposal) }),
    view(dep.contract, "get_config")]);
  // the facts file lists the by-laws in force, partly flattened (bid.price_usdc is read as price_usdc)
  const old = (key) => key.split(".").reduce((o, k) => o?.[k], facts?.by_laws) ?? facts?.by_laws?.[key.split(".").at(-1)];
  const val = (x) => esc(Array.isArray(x) ? x.join(", ") : x);
  const diff = Object.entries(file.changes ?? {}).map(([k, v]) =>
    `<li><code>${esc(k)}</code>: ${old(k) === undefined ? "" : `${val(old(k))} → `}<strong>${val(v)}</strong></li>`).join("");
  card("card-proposal", `<p>The agent read its own record in a TEE (${esc(file.model ?? "the voted model")}) and proposed by-laws v${esc(p.version)}:</p>
    ${file.evaluation ? `<blockquote>“${esc(file.evaluation)}”</blockquote>` : ""}
    ${diff ? `<ul>${diff}</ul>` : ""}
    <p><a href="${explorer(dep.dao)}">DAO proposal #${esc(p.proposal)}</a>: ${esc(dao.status)}.
    ${file.factsSha ? `The facts it read: <a href="agent-proposals/v${Number(p.version)}.facts.json">sha256 ${esc(file.factsSha.slice(0, 12))}…</a>.` : ""}</p>
    ${cfg.version > p.version ? `<p class="note">Since then the members voted by-laws v${esc(cfg.version)}${cfg.contributor && cfg.contributor !== dep.agent ? `, proposed by ${esc(cfg.contributor)}` : ""}: that is what the agent runs now.${p.version === 9 && cfg.version === 10 ? " v9 had cut the price from an average that counted a Taskbond job, paid in testnet NEAR, as a 0 USDC sale; v10 restored v8." : ""}</p>` : ""}
    ${list.length > 1 ? `<p class="muted">${list.length - 1} earlier proposal(s) by the agent, each put to a members' vote.</p>` : ""}`);
}).catch(() => {});

// the agent's mistakes and the members' corrections: by-laws v9 (the agent's, from a wrong average) undone by v10 (a
// member's), and the agent's annual review, rejected once and accepted corrected. Versions and votes read from the chain.
const BAD_V = 9, FIX_V = 10, BAD_P = 139, FIX_P = 140; // ponytail: the one known case; read from the agent's proposals if there is a second
const review = dep.agentReview;
Promise.all([view(dep.contract, "get_config_history", { from: 0, limit: 100 }),
  ...[BAD_P, FIX_P, ...(review ? [review.rejected.proposal, review.proposal] : [])].map((id) => view(dep.dao, "get_proposal", { id }))])
  .then(([versions, badP, fixP, rejP, okP]) => {
    const bad = versions.find((x) => x.version === BAD_V), fix = versions.find((x) => x.version === FIX_V);
    if (!bad || !fix) return;
    const vote = (id, p) => `<a href="${explorer(dep.dao)}">DAO proposal #${esc(id)}</a>: ${esc(p.status)}`;
    card("card-errors", `<p>On ${esc(day(bad.activated_at))} the agent proposed by-laws v${BAD_V} (by <code>${esc(bad.contributor ?? "")}</code>) and the members passed it
      (${vote(BAD_P, badP)}). It was wrong: the agent cut its price from an average that counted a Taskbond job, paid in testnet NEAR, as a 0 USDC sale.</p>
      <p>On ${esc(day(fix.activated_at))} a member, <code>${esc(fix.contributor ?? "")}</code>, proposed v${FIX_V} to restore v8, and the members passed it
      (${vote(FIX_P, fixP)}).</p>
      ${review ? `<p>The agent also writes its own annual review for the members' meeting. Its first draft was turned down (${vote(review.rejected.proposal, rejP)}):
      ${esc(review.rejected.why)}. <a href="${esc(review.rejected.report)}">The rejected draft</a>.
      A corrected one was accepted (${vote(review.proposal, okP)}): <a href="${esc(review.report)}">the review</a>, from <a href="${esc(review.facts)}">the facts read from the chain</a>.</p>
      ${review.note ? `<p class="muted">Accepted ${esc(review.note.replace(/^accepted /, ""))}.</p>` : ""}` : ""}`);
  }, () => {});

// the credit bureau: a federation of co-ops sets the loan ceiling; a stamp from a sister co-op counts as credit here
const CAROL = "kop-carol-mw80aczw.testnet";
Promise.all([view(dep.contract, "get_federation"), view(dep.contract, "get_sister_coops"), view(dep.contract, "get_loan_rule"),
  view(dep.contract, "get_credit", { account_id: CAROL }), view(dep.contract, "get_passport", { account_id: CAROL })])
  .then(([[fedDao, ceil], sisters, rule, [score], passport]) => {
    if (!ceil) return;
    const refused = dep.v033?.federation?.refused;
    const stamp = passport?.[0];
    card("card-credit", `<p>The federation <a href="${explorer(fedDao)}">${esc(fedDao.split(".")[0])}</a>, voted by both co-ops, caps loans at
      <strong>${ceil.max_rate_bps / 100}%</strong> for ${esc(ceil.max_term_days)} days, in the contract's code.
      ${refused ? `The members here voted ${refused.rate_bps / 100}% loans (<a href="${explorer(dep.dao)}">DAO proposal #${esc(refused.proposals[0])}</a>);
      the contract refused it, and the loan rule is still ${rule ? `${rule[0].rate_bps / 100}%` : "unchanged"}.` : ""}</p>
      <p>${sisters.length} sister co-op(s) share credit. <a href="cert.html?who=${CAROL}">${esc(CAROL)}</a> has credit score <strong>${esc(score)}</strong> here
      ${stamp ? `from a stamp by <code>${esc(stamp.coop)}</code> (${esc(stamp.done)} jobs finished there)` : ""}.</p>
      <p class="muted">A loan called late here is told to the sister co-ops: the borrower's credit is 0 at all of them until it is repaid.</p>`);
  }, () => {});
