// The member dashboard: one view per sidebar item (#/overview, #/membership…). Each view reads the chain the first time
// it is opened (near.js keeps a read 30 s, so views share them); a block whose reads fail is hidden. The wallet panel is
// wallet.js itself, rendered into #joinapp; the proposals view votes through its vote().
import { dep, view, all, query, txStatus, explorer, txUrl, RAW, $, esc, usdc, nearAmt } from "./near.js";
import { t } from "./lang.js";
import { byLawsPath } from "./share.js";
// the wallet panel (and its wallet connector) loads beside the views, so a slow wallet module never holds them back
const wallet = import("./wallet.js");

const C = dep.contract;
const D = dep.dao;
const date = (ns) => new Date(Number(BigInt(ns) / 1_000_000n)).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const short = (h) => `${String(h).slice(0, 10)}…`;
const table = (head, rows) => (rows.length
  ? `<div class="scroll" tabindex="0" role="region" aria-label="${esc(head[0])} table"><table class="grid"><thead><tr>${head.map((h) => `<th scope="col">${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`
  : `<p class="muted">Nothing yet.</p>`);

/** Public RPCs rate-limit in bursts: a read is tried twice, 3 s apart, unless the chain itself said no. */
async function retried(read) {
  try { return await read(); } catch (e) {
    if (e.final) throw e;
    await new Promise((ok) => setTimeout(ok, 3000));
    return read();
  }
}
/** Fill a block (a .pane with an .out) from its reads; on failure the block is hidden. */
function pane(id, read) {
  const el = $(id);
  el.hidden = false;
  el.querySelector(".out").innerHTML = `<p class="muted">Reading NEAR…</p>`;
  return retried(read).then((html) => { el.querySelector(".out").innerHTML = html; }, (e) => { console.warn(id, e); el.hidden = true; });
}

// the by-laws in force, hashed here: read by the agent view and the verify view
let bylaws = null;
const byLaws = () => (bylaws ??= (async () => {
  const info = await view(C, "get_info");
  const c = info.config;
  if (!byLawsPath(c.uri)) return { c, info, hex: null };
  const raw = await fetch(`${RAW}${c.uri}`, { cache: "no-store" }).then((r) => (r.ok ? r.arrayBuffer() : null), () => null);
  if (!raw) return { c, info, hex: null };
  const hex = [...new Uint8Array(await crypto.subtle.digest("SHA-256", raw))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { c, info, hex, text: new TextDecoder().decode(raw) };
})().catch((e) => { bylaws = null; throw e; }));

async function overview() {
  pane("recent", async () => {
    const [info, last] = await Promise.all([view(C, "get_info"), view(D, "get_last_proposal_id")]);
    const [recs, props] = await Promise.all([view(C, "get_receipts", { from: Math.max(0, info.receipts - 5), limit: 5 }),
      view(D, "get_proposals", { from_index: Math.max(0, last - 5), limit: 5 })]);
    const items = [
      ...recs.map((r) => ({ ts: r.ts, html: `Job <code>${esc(short(r.job_id))}</code>: ${usdc(r.price)} USDC under by-laws v${esc(r.config_version)}, <span class="badge ${esc(r.status)}">${esc(r.status)}</span>` })),
      ...props.map((p) => ({ ts: p.submission_time, html: `DAO proposal #${esc(p.id)} by ${esc(p.proposer)}: ${esc(String(p.description).replace(/\s+/g, " ").slice(0, 110))} <span class="muted">(${esc(p.status)})</span>` })),
    ].sort((a, b) => (BigInt(b.ts) > BigInt(a.ts) ? 1 : -1));
    return `<ul class="feed">${items.map((i) => `<li><time>${date(i.ts)}</time><span>${i.html}</span></li>`).join("")}</ul>`;
  });
  try {
    const [info, audit, last, treasury] = await retried(() => Promise.all([view(C, "get_info"), view(C, "get_audit"), view(D, "get_last_proposal_id"),
      view(dep.usdc, "ft_balance_of", { account_id: D })]));
    const owed = BigInt(audit.owed);
    $("net").innerHTML = `Read now from NEAR ${esc(dep.network)}: <a href="${explorer(C)}">${esc(C)}</a> and its DAO <a href="${explorer(D)}">${esc(D)}</a>.`;
    $("kpis").innerHTML = [
      ["Members", Number(info.members), "one vote each"],
      ["DAO proposals", Number(last), "every decision on record"],
      ["Treasury", `${usdc(treasury)} <small>USDC</small>`, "spent only by a vote"],
      ["Audit", owed > 0n ? "Red" : "Green", owed > 0n ? `${usdc(owed)} USDC not passed on` : "every payment passed on", owed > 0n ? "warn" : "ok"],
      ["Jobs", Number(info.receipts), "receipts on-chain"],
      ["Agent", info.paused ? "Paused" : "Working", `by-laws v${esc(info.config.version)}`, info.paused ? "warn" : "ok"],
      ["Profit shares", Number(info.periods), "voted, split by rule"],
    ].map(([k, v, s, c = ""]) => `<div class="${c}"><dt>${k}</dt><dd>${v}</dd><small>${s}</small></div>`).join("");
  } catch (e) {
    $("net").textContent = `Could not read NEAR right now (${e.message.slice(0, 80)}). Reload in a moment.`;
  }
}

// the proposals view: open proposals described from their kind, with vote buttons for a member who has not voted
let voting = false;
async function proposals() {
  const list = $("props");
  try {
    const [last, policy] = await retried(() => Promise.all([view(D, "get_last_proposal_id"), view(D, "get_policy")]));
    const props = await retried(() => view(D, "get_proposals", { from_index: Math.max(0, last - 50), limit: 50 }));
    const group = policy.roles.find((r) => r.name === "member")?.kind?.Group ?? [];
    const [num, den] = policy.default_vote_policy?.threshold ?? [1, 2];
    const needed = Math.floor((group.length * num) / den) + 1;
    const { account, opaque, safeDescribe, vote } = await wallet;
    const me = account();
    const open = props.filter((p) => p.status === "InProgress").reverse();
    const decided = props.filter((p) => p.status !== "InProgress").reverse().slice(0, 8);
    const yes = (p) => Object.values(p.votes ?? {}).filter((v) => v === "Approve").length;
    const action = (p) => {
      if (!me) return `<span class="small">${t("Sign in under My membership to vote", "Masuk di Keanggotaan saya untuk memilih")}</span>`;
      if (!group.includes(me)) return "";
      if (p.votes?.[me]) return `<em>${t("you voted", "Anda memilih")} ${esc(String(p.votes[me]).toLowerCase())}</em>`;
      if (opaque(p)) return `<a class="small-link" href="${explorer(D)}">${t("Inspect in the DAO to vote", "Periksa di DAO untuk memilih")}</a>`;
      return `<span class="vote-btns"><button type="button" class="btn small" data-v="VoteApprove" data-id="${p.id}">${t("Approve", "Setuju")}</button>
        <button type="button" class="btn ghost small" data-v="VoteReject" data-id="${p.id}">${t("Reject", "Tolak")}</button></span>`;
    };
    list.innerHTML = (open.length ? open.map((p) => `<li><span><strong>#${esc(p.id)}</strong> <span class="claim">${t("by", "oleh")} ${esc(p.proposer)}; ${yes(p)} ${t("of", "dari")} ${needed} ${t("approvals needed", "persetujuan yang diperlukan")}</span>
        <pre class="does">${esc(safeDescribe(p))}</pre>${p.description ? `<span class="claim">${t("Proposer says", "Kata pengusul")}: “${esc(String(p.description).slice(0, 200))}”</span>` : ""}</span>${action(p)}</li>`).join("")
      : `<li>${t("Nothing to vote on right now.", "Belum ada yang perlu dipilih.")}</li>`)
      + `<li class="sub-h"><b>${t("Recently decided", "Baru diputuskan")}</b></li>`
      + decided.map((p) => `<li><span><strong>#${esc(p.id)}</strong> ${esc(String(p.description).replace(/\s+/g, " ").slice(0, 140))}</span><span class="badge">${esc(p.status)}</span></li>`).join("");
    list.querySelectorAll("[data-v]").forEach((b) => {
      b.onclick = async () => {
        list.querySelectorAll("button").forEach((x) => { x.disabled = true; });
        voting = true;
        await vote(Number(b.dataset.id), b.dataset.v);
        voting = false;
        proposals();
      };
    });
  } catch (e) {
    list.innerHTML = `<li>Could not read the DAO's proposals right now (${esc(e.message.slice(0, 80))}). Reload in a moment.</li>`;
  }
}

async function agent() {
  pane("a-bylaws", async () => {
    const { c, hex, text } = await byLaws();
    const get = (re) => esc(text?.match(re)?.[1]?.trim() ?? "?");
    return `<dl class="terms dark">
        <div><dt>Version</dt><dd>by-laws v${esc(c.version)}</dd></div>
        <div><dt>Since</dt><dd>${date(c.activated_at)}${c.contributor ? `, proposed by ${esc(c.contributor)}` : ""}</dd></div>
        <div class="wide"><dt>Hash the members voted</dt><dd><code>${esc(c.hash)}</code></dd></div>
        ${hex === c.hash ? `<div><dt>Price per job</dt><dd>${get(/^\s+price_usdc:\s*([\d.]+)/m)} USDC</dd></div>
        <div><dt>AI spend cap</dt><dd>$${get(/max_inference_per_job_usd:\s*([\d.]+)/)} a job, $${get(/max_inference_per_day_usd:\s*([\d.]+)/)} a day</dd></div>
        <div class="wide"><dt>Model</dt><dd>${get(/^model:\s*"?([^"\n]+)/m)}</dd></div>` : ""}</dl>
      <p class="small">${hex === null ? "The by-laws file could not be downloaded to check it here."
        : hex === c.hash ? `Your browser hashed <a href="${esc(RAW + c.uri)}">${esc(c.uri)}</a>: it is exactly the file the members approved.`
          : `<strong>The published file does not match</strong> the approved hash (it hashes to ${esc(short(hex))}).`}</p>`;
  });
  const tee = dep.tee;
  if (tee) {
    pane("a-tee", async () => {
      const [att, [owner], [teeOnly, held], recAgent] = await Promise.all([view(tee.registry, "get_agent", { account_id: tee.worker }),
        view(tee.registry, "get_contract_info"), view(C, "get_agent_tee", { account_id: tee.worker }), view(C, "get_receipt_agent", { job_id: tee.receipt })]);
      if (!att || !held) throw new Error("not attested");
      const holds = BigInt(att.valid_until) > BigInt(Date.now()) * 1_000_000n;
      return `<p>Worker <a href="${explorer(tee.worker)}"><code>${esc(short(tee.worker))}</code></a>: its key was made inside an Intel TDX VM
        (${esc(tee.cvm?.provider ?? "Phala Cloud")}), its quote checked on-chain by <a href="${explorer(tee.registry)}">${esc(tee.registry)}</a>,
        owned by ${owner === D ? "the co-op's DAO" : `<code>${esc(owner)}</code>`}.</p>
        <dl class="terms dark">
          <div><dt>Code (compose hash)</dt><dd><code>${esc(short(att.compose_hash))}</code></dd></div>
          <div><dt>Machine (PPID)</dt><dd><code>${esc(short(att.ppid))}</code></dd></div>
          <div><dt>Attestation</dt><dd>${holds ? "holds until" : "ran out on"} ${date(att.valid_until)}</dd></div>
          <div><dt>Admitted</dt><dd>${teeOnly ? "TEE-only, " : ""}DAO proposals #${esc(tee.approve)} and #${esc(tee.admit)}</dd></div>
        </dl>
        ${recAgent === tee.worker ? `<p class="small">It recorded receipt <code>${esc(short(tee.receipt))}</code> from inside the TEE, after the by-laws gate in the OutLayer enclave
          (<a href="${txUrl(tee.gate)}">tx</a>).</p>` : ""}
        <p class="small muted">The VM was stopped after its job to save cost; the attestation and the receipt stay on-chain.</p>`;
    });
  } else $("a-tee").hidden = true;
  pane("a-props", async () => {
    const list = await view(C, "get_agent_proposals");
    const files = await Promise.all(list.map((p) => fetch(`agent-proposals/v${Number(p.version)}.json`).then((r) => (r.ok ? r.json() : null), () => null)));
    return table(["By-laws", "DAO proposal", "Its reasoning"], list.map((p, i) => [p, files[i]]).reverse().map(([p, f]) => `<tr>
      <td>v${esc(p.version)}</td><td data-label="DAO proposal"><a href="${explorer(D)}">#${esc(p.proposal)}</a></td>
      <td data-label="Its reasoning">${esc(String(p.reason).slice(0, 220))}${f?.evaluation ? `<span class="claim">Its evaluation (${esc(f.model ?? "")}): “${esc(String(f.evaluation).slice(0, 220))}”</span>` : ""}</td></tr>`));
  });
  pane("a-risk", async () => {
    const [m, risk] = await Promise.all([view(C, "get_agent_member"), view(C, "get_risk_fund")]);
    if (!m) throw new Error("older contract");
    return `<dl class="kpis small-kpis">
      <div><dt>Its share</dt><dd>${m.share_bps / 100}%</dd><small>of every profit share</small></div>
      <div class="${m.standing_bps < 10000 ? "warn" : "ok"}"><dt>Standing</dt><dd>${m.standing_bps / 100}%</dd><small>${esc(m.strikes)} upheld case(s)${m.suspended ? ", suspended" : ""}</small></div>
      <div><dt>Risk fund</dt><dd>${risk ? usdc(risk[0]) : "0.00"} <small>USDC</small></dd><small>${risk ? `saves ${risk[1] / 100}% of its earnings` : ""}</small></div>
      <div><dt>From its shares</dt><dd>${usdc(m.shu_total)} <small>USDC</small></dd><small>so far</small></div></dl>
      <p class="small">The risk fund refunds the agent's mistakes at once, when the co-op court upholds a buyer's case.</p>`;
  });
  pane("a-receipts", async () => {
    const info = await view(C, "get_info");
    const recs = await view(C, "get_receipts", { from: Math.max(0, info.receipts - 15), limit: 15 });
    return `${table(["Job", "Price", "Inference", "By-laws", "Status"], [...recs].reverse().map((r) => `<tr>
      <td>${esc(short(r.job_id))} <span class="muted">${date(r.ts)}</span></td>
      <td class="num" data-label="Price">${usdc(r.price)}</td><td class="num" data-label="Inference">$${(Number(r.inference_cost) / 1e6).toFixed(4)}</td>
      <td data-label="By-laws">v${esc(r.config_version)}</td><td data-label="Status"><span class="badge ${esc(r.status)}">${esc(r.status)}</span></td></tr>`))}
      <p class="small">The latest 15 of ${esc(info.receipts)}. Which jobs a TEE-verified model did: <a href="/#work">the landing page</a>.</p>`;
  });
}

async function money() {
  pane("m-treasury", async () => {
    const [info, audit, bal] = await Promise.all([view(C, "get_info"), view(C, "get_audit"), view(dep.usdc, "ft_balance_of", { account_id: D })]);
    const owed = BigInt(audit.owed);
    return `<dl class="kpis small-kpis">
      <div><dt>Treasury</dt><dd>${usdc(bal)} <small>USDC</small></dd><small>in the DAO, spent only by a vote</small></div>
      <div><dt>Owed to the co-op</dt><dd>${usdc(audit.expected)}</dd><small>paid jobs after the market's 5%</small></div>
      <div><dt>Passed on</dt><dd>${usdc(audit.deposited)}</dd><small>by the steward</small></div>
      <div class="${owed > 0n ? "warn" : "ok"}"><dt>Audit</dt><dd>${owed > 0n ? "Red" : "Green"}</dd><small>${owed > 0n ? `${usdc(owed)} USDC missing` : "all passed on"}</small></div></dl>
      <p class="small">Steward bond at stake: ${nearAmt(info.steward_bond)} NEAR. Profit shares keep ${info.share_rule.reserve_bps / 100}% as reserve and split the rest
      ${info.share_rule.savings_bps / 100}% by savings, ${info.share_rule.points_bps / 100}% by contribution points.${owed > 0n ? " This demo co-op keeps the audit red on purpose." : ""}</p>`;
  });
  pane("m-periods", async () => {
    const periods = await view(C, "get_periods");
    return table(["Share", "Date", "Shared, USDC", "Reserve, USDC", "Members"], [...periods].reverse().map((p) => `<tr><td>Share ${esc(p.id)}</td>
      <td data-label="Date">${date(p.ts)}</td><td class="num" data-label="Shared">${usdc(BigInt(p.amount) - BigInt(p.reserve))}</td>
      <td class="num" data-label="Reserve">${usdc(p.reserve)}</td><td class="num" data-label="Members">${esc(p.members)}</td></tr>`));
  });
  pane("m-rep", async () => {
    const [w, bps] = await Promise.all([view(C, "get_reputation_weights"), view(C, "get_reputation_share").catch(() => 0)]);
    const total = w.reduce((s, [, x]) => s + Number(x), 0) || 1;
    return `<p class="small">${bps ? `${bps / 100}% of every profit share` : "A part of each profit share"} is split among members in good standing by their work since the last
      one (tasks finished, pledges kept, juries served), plus half their last weight.</p>
      ${table(["Member", "Weight", "Part"], w.map(([a, x]) => `<tr><td><a href="cert.html?who=${encodeURIComponent(a)}">${esc(a)}</a></td>
        <td class="num" data-label="Weight">${esc(x)}</td><td class="num" data-label="Part">${((100 * Number(x)) / total).toFixed(1)}%</td></tr>`))}`;
  });
  pane("m-loans", async () => {
    const [loan, fed] = await Promise.all([view(C, "get_loan_rule"), view(C, "get_federation").catch(() => null)]);
    if (!loan) return `<p class="small">The members have not voted a loan rule.</p>`;
    const [r, fund] = loan;
    return `<p>A member in good standing with a guarantor borrows up to <strong>${nearAmt(r.max_loan)} NEAR</strong> for ${esc(r.term_days)} days at
      ${r.rate_bps / 100}% flat; the fund can lend <strong>${nearAmt(fund)} NEAR</strong> now.${fed?.[1] ? ` The federation caps loans at ${fed[1].max_rate_bps / 100}% for ${esc(fed[1].max_term_days)} days; the contract refuses a rule above it.` : ""}</p>
      <p class="small">A late loan costs the borrower and their guarantors good standing. Borrow under <a href="#/membership">My membership</a>.</p>`;
  });
}

async function commons() {
  pane("c-cases", async () => {
    const cases = await all(C, "get_cases");
    const OUT = { Open: "jury out", Upheld: "upheld: refunded", Dismissed: "not upheld" };
    return table(["Case", "Refund", "Jurors", "Outcome"], [...cases].reverse().map((c) => `<tr><td><strong>#${esc(c.id)}</strong> job ${esc(c.job_id)}<span class="claim">“${esc(c.reason)}”, brought by ${esc(c.claimant)}</span></td>
      <td class="num" data-label="Refund">${usdc(c.amount)} USDC</td>
      <td data-label="Jurors">${c.jurors.map((j) => { const v = c.votes.find(([x]) => x === j); return `${esc(j)}: ${v ? (v[1] ? "uphold" : "reject") : "–"}`; }).join("<br>")}</td>
      <td data-label="Outcome">${OUT[c.status] ?? esc(c.status)}${c.refund_proposal !== null ? `; DAO proposal #${esc(c.refund_proposal)}` : ""}</td></tr>`));
  });
  pane("c-pledges", async () => {
    const [pledges, claims] = await Promise.all([all(C, "get_pledges"), all(C, "get_pledge_claims")]);
    const n = (id, st) => claims.filter((c) => c.pledge === id && c.status === st).length;
    return table(["Pledge", "By", "Called in", "Kept / broken"], [...pledges].reverse().map((p) => `<tr><td><strong>#${esc(p.id)}</strong> ${esc(p.what)}</td>
      <td data-label="By"><a href="cert.html?who=${encodeURIComponent(p.issuer)}">${esc(p.issuer)}</a></td>
      <td class="num" data-label="Called in">${esc(p.called)} of ${esc(p.units)}</td><td data-label="Kept / broken">${n(p.id, "Honored")} / ${n(p.id, "Broken")}</td></tr>`));
  });
  pane("c-standing", async () => {
    const members = await view(C, "get_members", { from: 0, limit: 200 });
    const standing = await Promise.all(members.map(([a]) => view(C, "get_standing", { account_id: a })));
    return `<ul class="tiers">${members.map(([a], i) => {
      const [x, good] = standing[i];
      return `<li><b><a href="cert.html?who=${encodeURIComponent(a)}">${esc(a)}</a>: ${good ? "good standing" : "not in good standing"}</b>
        <span>${esc(x.pledges_honored)} pledge(s) kept, ${esc(x.pledges_broken)} broken; ${esc(x.juries_served)} jury ruling(s), ${esc(x.juries_missed)} missed${x.slashed ? `; slashed ${esc(x.slashed)} time(s)` : ""}</span></li>`;
    }).join("")}</ul>`;
  });
}

async function federation() {
  pane("f-fed", async () => {
    const [fed, sisters] = await Promise.all([view(C, "get_federation"), view(C, "get_sister_coops")]);
    if (!fed) return `<p class="small">This co-op is not in a federation yet.</p>`;
    const [fedDao, ceil] = fed;
    const res = [dep.federation?.resolution, ...(dep.federation?.resolutions ?? [])].filter(Boolean);
    return `<p>The federation <a href="${explorer(fedDao)}">${esc(fedDao)}</a> is a Sputnik DAO whose only members are co-ops' DAOs, one co-op one vote.
      ${ceil ? `Its ceiling, binding in this contract: loans at most <strong>${ceil.max_rate_bps / 100}%</strong> for ${esc(ceil.max_term_days)} days.` : "No loan ceiling set yet."}</p>
      <p>Sister co-ops (their work records count here): ${sisters.length ? sisters.map((s) => `<a href="${explorer(s)}">${esc(s)}</a>`).join(", ") : "none"}.</p>
      ${res.length ? `<ul class="tiers">${res.map((r) => `<li><b>#${esc(r.id)}</b><span>${esc(r.text)}</span></li>`).join("")}</ul>` : ""}
      <p class="small"><a href="/coops.html">Every co-op on this code, and the federation's resolutions with each co-op's vote</a>.</p>`;
  });
  pane("f-trades", async () => {
    const trades = dep.federation?.trades ?? [];
    if (!trades.length) throw new Error("none");
    return `${table(["Job", "Done by", "Referred by", "Share back"], trades.map((x) => `<tr><td><code>${esc(short(x.job))}</code> <a href="${txUrl(x.paid)}">paid</a></td>
      <td data-label="Done by">${esc(x.coop)}</td><td data-label="Referred by">${esc(x.referred_by)}</td>
      <td class="num" data-label="Share back">${usdc(x.share)} of ${usdc(x.net)} <a href="${txUrl(x.deposited)}">deposited</a></td></tr>`))}
      <p class="small">A sister co-op's agent did the job; the referring co-op's share went back by resolution #${esc(trades[0].resolution)}.</p>`;
  });
}

async function verify() {
  const mark = (id, ok, html) => {
    const li = $(id);
    li.classList.remove("pass", "fail");
    if (ok !== null) li.classList.add(ok ? "pass" : "fail");
    li.querySelector(".out").innerHTML = html;
  };
  byLaws().then(({ c, hex }) => mark("k-bylaws", hex === null ? null : hex === c.hash, hex === null ? "Could not download the by-laws file."
    : hex === c.hash ? `Your browser hashed <code>${esc(c.uri)}</code>: <code>${esc(short(hex))}</code>, the hash the members voted for v${esc(c.version)}. The contract refuses receipts under any other.`
      : `The published file hashes to <code>${esc(short(hex))}</code>, not the approved <code>${esc(short(c.hash))}</code>.`),
  (e) => mark("k-bylaws", null, `Could not read the chain (${esc(e.message.slice(0, 80))}).`));
  Promise.all([query({ request_type: "view_account", account_id: C }), query({ request_type: "view_access_key_list", account_id: C })]).then(([acct, keys]) => {
    const full = keys.keys.filter((k) => k.access_key.permission === "FullAccess").length;
    const code = acct.global_contract_hash ?? acct.code_hash;
    mark("k-code", full === 0, full === 0
      ? `The contract account holds <strong>no full-access key</strong>: only a members' vote can change its code (<code>${esc(short(code))}</code>). <a href="/#codegov">The vote that chose it</a>.`
      : `The contract account still has ${full} full-access key(s): someone could change the code without a vote.`);
  }, (e) => mark("k-code", null, `Could not read the contract account (${esc(e.message.slice(0, 80))}).`));
  const red = dep.redteam ?? [];
  if (!red.length) { $("k-attacks").hidden = true; return; }
  mark("k-attacks", null, `${red.length} attacks were sent to this co-op as real transactions. <button type="button" class="btn small" id="k-run">Read them back from NEAR</button>`);
  // each must have failed on-chain with the refusal it was saved with (the same check as the landing page's)
  $("k-run").onclick = async () => {
    mark("k-attacks", null, `Reading ${red.length} transactions…`);
    const res = await Promise.all(red.map((r) => txStatus(r.tx, r.by).then((x) => {
      const failure = JSON.stringify(x?.status?.Failure ?? x?.receipts_outcome?.map((o) => o.outcome.status.Failure).find(Boolean) ?? null);
      return failure !== "null" && failure.includes(JSON.stringify(r.error.slice(0, 60)).slice(1, -1));
    }, () => null)));
    const refused = res.filter((x) => x === true).length;
    const unread = res.filter((x) => x === null).length;
    mark("k-attacks", unread ? null : refused === red.length, `${refused} of ${red.length} attacks failed on-chain with the contract's or the DAO's own refusal${unread ? ` (${unread} not readable right now)` : ""}.
      <ul class="attacks">${red.map((r, i) => `<li>${res[i] === true ? "refused" : res[i] === null ? "not read" : "<strong>NOT REFUSED</strong>"}: ${esc(r.what)} <a href="${txUrl(r.tx)}">tx</a></li>`).join("")}</ul>`);
  };
}

const VIEWS = { overview, membership: () => {}, proposals, agent, money, commons, federation, verify };
const loaded = new Set();
let current = "";
function route(focus) {
  const name = location.hash.match(/^#\/(\w+)/)?.[1];
  current = name && Object.hasOwn(VIEWS, name) ? name : "overview";
  for (const v of Object.keys(VIEWS)) $(`v-${v}`).hidden = v !== current;
  document.querySelectorAll("#side-nav a").forEach((a) => {
    if (a.getAttribute("href") === `#/${current}`) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  menu(false);
  if (!loaded.has(current)) { loaded.add(current); VIEWS[current](); }
  if (focus) $(`h-${current}`).focus();
}

// the sidebar folds into a menu on narrow screens
const side = document.querySelector(".side");
const menu = (open) => { side.classList.toggle("open", open); $("menu-btn").setAttribute("aria-expanded", String(open)); };
$("menu-btn").onclick = () => menu(!side.classList.contains("open"));

// the dashboard's own words in Bahasa Indonesia (data-id); what the chain says stays as it says it
function chrome() {
  document.querySelectorAll("[data-id]").forEach((el) => {
    el.dataset.en ??= el.textContent;
    el.textContent = t(el.dataset.en, el.dataset.id);
  });
  $("menu-btn").textContent = t("Menu", "Menu");
}

// who is signed in, from the wallet panel; while a vote from the proposals view runs, its progress shows there too
window.addEventListener("koperasi:wallet", (e) => {
  const { me, note } = e.detail;
  $("who").innerHTML = me ? `${t("Signed in as", "Masuk sebagai")} <strong>${esc(me)}</strong>` : `${t("Not signed in", "Belum masuk")}: <a href="#/membership">${t("connect a wallet", "hubungkan dompet")}</a>`;
  $("join-steps").hidden = !!me;
  const out = $("vote-note");
  if (voting && note) { out.hidden = false; out.innerHTML = note; } // built by wallet.js from escaped values
  if (!voting && current === "proposals" && loaded.has("proposals")) proposals();
});
window.addEventListener("koperasi:lang", () => {
  chrome();
  loaded.clear();
  route(false);
});
window.addEventListener("hashchange", () => route(true));
chrome();
route(false);
