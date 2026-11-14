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
import { t } from "./lang.js";
// what is written from the chain's data is written again, from the same data, when the visitor switches language
const live = (fn) => { fn(); addEventListener("koperasi:lang", () => fn()); };
const byLawsUrl = (uri) => (byLawsPath(uri) ? `${RAW}${uri}` : "about:blank#refused");

// "Don't trust us": each check writes its verdict into its card
const verdict = (id, ok, html) => {
  const li = $(id);
  li.classList.remove("pass", "fail");
  if (ok !== null) li.classList.add(ok ? "pass" : "fail");
  li.querySelector(".ck-out").innerHTML = html;
};

const date = (ns) => new Date(Number(BigInt(ns) / 1_000_000n)).toLocaleDateString(t("en-GB", "id-ID"), { day: "2-digit", month: "short" });
const short = (h) => `${h.slice(0, 10)}…`;
const rows = (tbody, html) => { tbody.innerHTML = html || `<tr><td colspan="9" class="muted">${t("Nothing yet.", "Belum ada.")}</td></tr>`; };

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
]).then(([proposals, policy, info, [board, tasks], cases, pledges, claims, treasury]) => live(() => {
  const role = (n) => policy.roles.find((r) => r.name === n);
  const members = role("member")?.kind?.Group ?? [];
  const paid = tasks.filter((x) => x.status === "Paid");
  const onTrust = paid.filter((x) => !x.approved_by).length;
  const kept = claims.filter((c) => c.status === "Honored").length;
  const broken = claims.filter((c) => c.status === "Broken").length;
  const upheld = cases.filter((c) => c.status === "Upheld").length;
  const [num, den] = policy.default_vote_policy.threshold;
  const needed = Math.min(members.length, Math.floor((members.length * num) / den) + 1);
  const rule = board.rule;
  // the hero's one live line: what is on-chain now, and where the co-op has paid
  const chains = ["NEAR", ...(dep.chainSignatures?.transfer?.sent ? ["Ethereum"] : []),
    ...((dep.intents?.payouts ?? []).some((p) => p.chain === "base" && p.status === "SUCCESS") ? ["Base"] : [])];
  const where = chains.length > 1 ? `${chains.slice(0, -1).join(", ")} ${t("and", "dan")} ${chains.at(-1)}` : chains[0];
  $("proofline").innerHTML = t(`Right now on NEAR testnet: ${members.length} members, ${proposals} DAO votes, ${paid.length} tasks paid, and payouts that landed on ${where}.`,
    `Saat ini di testnet NEAR: ${members.length} anggota, ${proposals} pemungutan suara DAO, ${paid.length} tugas dibayar, dan pembayaran yang sampai di ${where}.`);
  $("counts").innerHTML = [
    [t("Members", "Anggota"), members.length, t("one vote each", "masing-masing satu suara")],
    [t("DAO proposals", "Usulan DAO"), proposals, t("every decision on record", "setiap keputusan tercatat")],
    [t("Tasks", "Tugas"), tasks.length, t(`${paid.length} paid, ${onTrust} on earned trust`, `${paid.length} dibayar, ${onTrust} atas kepercayaan`)],
    [t("Profit shares", "Pembagian SHU"), info.periods, t("voted, split by rule", "diputuskan lewat suara, dibagi menurut aturan")],
    [t("Court cases", "Perkara"), cases.length, t(`${upheld} upheld`, `${upheld} dikabulkan`)],
    [t("Pledges", "Janji"), pledges.length, t(`${kept} kept, ${broken} broken`, `${kept} ditepati, ${broken} diingkari`)],
  ].map(([k, v, s]) => `<div><dt>${k}</dt><dd>${v} <small>${s}</small></dd></div>`).join("");
  const line = (id, ok, html) => { $(id).classList.add(ok ? "pass" : "fail"); $(id).querySelector(".ck-out").innerHTML = html; };
  line("br-own", members.length > 1 && policy.default_vote_policy.weight_kind === "RoleWeight", t(
    `${members.length} members hold the DAO's role <code>member</code>, one vote each: a decision needs ${needed} of ${members.length}. <a href="#members">Members</a>`,
    `${members.length} anggota memegang peran DAO <code>member</code>, masing-masing satu suara: keputusan perlu ${needed} dari ${members.length}. <a href="#members">Anggota</a>`));
  // "only a vote spends it", checked: no role but the members' may do more than file proposals, except the contract's
  // role `tasks`, which may file and approve transfers only (within the budget the members voted)
  const onlyVotes = policy.roles.every((r) => r.name === "member" || r.permissions.every((p) => p.endsWith(":AddProposal")
    || (r.name === "tasks" && p.startsWith("transfer:"))));
  line("br-budget", onlyVotes && board.budget !== undefined, t(
    `The DAO treasury holds ${usdc(treasury)} USDC; only a vote spends it. The members let the contract pay ${nearAmt(board.budget)} NEAR more for tasks. <a href="#trust">Tasks</a>`,
    `Kas DAO berisi ${usdc(treasury)} USDC; hanya pemungutan suara yang bisa membelanjakannya. Anggota mengizinkan kontrak membayar ${nearAmt(board.budget)} NEAR lagi untuk tugas. <a href="#trust">Tugas</a>`));
  const sb = info.share_rule.savings_bps / 100, pb = info.share_rule.points_bps / 100;
  line("br-rewards", info.periods > 0, t(
    `${info.periods} profit shares, each voted and split by the contract (${sb}% by savings, ${pb}% by contribution points); ${paid.length} tasks paid. <a href="#shares">Profit shares</a>`,
    `${info.periods} kali pembagian SHU, masing-masing diputuskan lewat suara dan dibagi oleh kontrak (${sb}% menurut simpanan, ${pb}% menurut poin kontribusi); ${paid.length} tugas dibayar. <a href="#shares">SHU</a>`));
  line("br-rep", !!rule, !rule ? t("The members have not voted a trust rule yet.", "Anggota belum memutuskan aturan kepercayaan.") : t(
    `Up to ${nearAmt(rule.auto_max)} NEAR is paid with no vote only to a contributor trusted by ${rule.trusted_after}+ other member${rule.trusted_after === 1 ? "" : "s"}${board.veto_minutes ? `, after a ${board.veto_minutes}-minute veto window` : ""}; jurors are drawn only from members in good standing. <a href="#trust">Earned trust</a>`,
    `Hingga ${nearAmt(rule.auto_max)} NEAR dibayar tanpa pemungutan suara hanya kepada kontributor yang dipercaya ${rule.trusted_after}+ anggota lain${board.veto_minutes ? `, setelah masa veto ${board.veto_minutes} menit` : ""}; juri hanya diundi dari anggota berstatus baik. <a href="#trust">Kepercayaan</a>`));
  const tasksRole = role("tasks");
  const perms = tasksRole ? tasksRole.permissions.map((p) => `<code>${esc(p)}</code>`).join(t(" and ", " dan ")) : t("(missing)", "(tidak ada)");
  line("br-sputnik", !!tasksRole && tasksRole.permissions.every((p) => p.startsWith("transfer:")), t(
    `Every payout is a Sputnik Transfer proposal. The contract files them in its own role <code>tasks</code>, which can only ${perms}. Proposal templates for <a href="https://github.com/PugarHuda/koperasi/tree/main/trezu">Trezu</a>. <a href="#trust">Tasks</a>`,
    `Setiap pembayaran adalah usulan Transfer Sputnik. Kontrak mengajukannya lewat perannya sendiri, <code>tasks</code>, yang hanya bisa ${perms}. Templat usulan untuk <a href="https://github.com/PugarHuda/koperasi/tree/main/trezu">Trezu</a>. <a href="#trust">Tugas</a>`));
})).catch((e) => {
  $("proofline").textContent = t("The co-op lives on NEAR testnet; every claim below is checked in your browser.", "Koperasi ini berjalan di testnet NEAR; setiap klaim di bawah diperiksa di browser Anda.");
  for (const id of ["br-own", "br-budget", "br-rewards", "br-rep", "br-sputnik"]) $(id).querySelector(".ck-out").textContent = t(`Could not read the chain right now (${e.message})${tries > 1 ? "; trying again in 5 s." : "."}`, `Belum bisa membaca chain (${e.message})${tries > 1 ? "; mencoba lagi dalam 5 detik." : "."}`);
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

// The visitor verifies the TEE themselves: fresh nonce, Intel's collateral, checked in this browser.
// The button and the result are drawn from this state, again on the language switch (tee.js's progress lines stay English).
// Declared here, above the reads that call armTeeCheck while this module is still waiting on them.
const teeState = { model: null, busy: false, result: null, failed: false };
const drawTee = () => {
  const btn = $("ck-tee-run");
  const { model, busy, result: r } = teeState;
  if (!busy) {
    btn.textContent = !model ? (teeState.failed ? t("Needs the by-laws from NEAR: reload in a moment", "Perlu anggaran dasar dari NEAR: muat ulang sebentar lagi")
      : t("Waiting for the by-laws (they name the model)…", "Menunggu anggaran dasar (yang menyebut modelnya)…"))
      : r ? t("Verify again with a new nonce", "Periksa lagi dengan nonce baru") : t(`Verify ${model} with your own nonce`, `Periksa ${model} dengan nonce Anda sendiri`);
  }
  if (!r || busy) return;
  if (r.reason) {
    verdict("ck-tee", false, `<p>${t("Not verified", "Tidak terverifikasi")}: ${esc(r.reason)}.</p>`);
    return;
  }
  const yes = (b) => (b ? t("yes", "ya") : t("NO", "TIDAK"));
  const row = (name, x) => `<tr><th scope="row">${name}</th><td>${esc(x.tdx ?? "-")}</td><td>${yes(x.nonce)}</td><td>${yes(x.address)}</td>`
    + `<td>${yes(x.compose)}</td><td>${x.gpuNonce === null || x.gpuNonce === undefined ? "n/a" : yes(x.gpuNonce)}</td></tr>`;
  const secs = (r.ms / 1000).toFixed(1), nonce = `<code>${r.nonce.slice(0, 16)}…</code>`;
  verdict("ck-tee", r.ok, `<p>${t(`<strong>${r.ok ? "Verified" : "Not verified"}</strong> in ${secs} s with your nonce ${nonce}.`,
    `<strong>${r.ok ? "Terverifikasi" : "Tidak terverifikasi"}</strong> dalam ${secs} detik dengan nonce Anda ${nonce}.`)}</p>
    <div class="ck-scroll" tabindex="0" role="region" aria-label="${t("TEE checks per server", "Pemeriksaan TEE per server")}"><table class="ck-table"><thead><tr><th scope="col">Server</th><th scope="col">Intel TDX</th><th scope="col">${t("Your nonce", "Nonce Anda")}</th>
      <th scope="col">${t("Signing key", "Kunci penanda tangan")}</th><th scope="col">${t("Attested code", "Kode teratestasi")}</th><th scope="col">${t("GPU nonce", "Nonce GPU")}</th></tr></thead>
    <tbody>${row("Gateway", r.gateway)}${r.models.map((m, i) => row(`Model ${i + 1}`, m)).join("")}</tbody></table></div>
    <p class="hint">${t("NVIDIA's own verdict on the GPUs needs NVIDIA's service, which browsers cannot call: the agent checks it before every job and CI daily (above).",
      "Putusan NVIDIA sendiri atas GPU-nya memerlukan layanan NVIDIA, yang tidak bisa dipanggil browser: agen memeriksanya sebelum setiap pekerjaan dan CI setiap hari (di atas).")}</p>`);
};
live(drawTee);

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

  live(() => {
    $("links").innerHTML = [
      `<a href="${explorer(dep.contract)}">${t("Contract on NEAR", "Kontrak di NEAR")}</a>`,
      `<a href="${explorer(dep.dao)}">${t("The co-op's DAO", "DAO koperasi")}</a>`,
      `<a href="https://github.com/PugarHuda/koperasi">${t("Source and demo", "Kode sumber dan demo")}</a>`,
      `<a href="/coops.html">${t("Every co-op on this code", "Semua koperasi dengan kode ini")}</a>`,
    ].join("");
    $("net").textContent = t(`Reading ${dep.network}: ${dep.contract}`, `Membaca ${dep.network}: ${dep.contract}`);
    $("chip").innerHTML = t(`${members.length} members<br>${receipts.length} jobs on-chain`, `${members.length} anggota<br>${receipts.length} pekerjaan on-chain`);
    $("join-deposit").textContent = t(`${nearAmt(info.join_deposit)} NEAR, refunded when the DAO removes you.`, `${nearAmt(info.join_deposit)} NEAR, dikembalikan saat DAO mengeluarkan Anda.`);
  });
  $("contract-link").href = explorer(dep.contract);
  $("pb-id").textContent = dep.contract;

  // join: the three calls a newcomer makes, with this co-op's real accounts and deposit
  const net = testnet ? "testnet" : "mainnet";
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
  let teeCount; // undefined until the proofs are read
  const status = () => {
    $("status").innerHTML = [
      [t("Agent", "Agen"), info.paused ? t("Paused by vote", "Dihentikan lewat suara") : t("Allowed to work", "Boleh bekerja"), info.paused ? "warn" : "ok"],
      [t("Running by-laws", "Anggaran dasar berlaku"), `v${info.config.version} <small>${short(info.config.hash)}</small>`, ""],
      [t("Jobs on-chain", "Pekerjaan on-chain"), `${receipts.length} <small>${t(`${paid} paid`, `${paid} dibayar`)}, ${teeCount === undefined
        ? t("TEE proofs not read yet", "bukti TEE belum terbaca") : t(`${teeCount} with TEE proof`, `${teeCount} dengan bukti TEE`)}</small>`, ""],
      [t("Audit", "Audit"), owed > 0n ? t(`Red <small>${usdc(owed)} USDC missing</small>`, `Merah <small>${usdc(owed)} USDC belum disetor</small>`)
        : t("Green <small>all passed on</small>", "Hijau <small>semua sudah disetor</small>"), owed > 0n ? "warn" : "ok"],
    ].map(([k, v, c]) => `<div><dt>${k}</dt><dd class="${c}">${v}</dd></div>`).join("");
  };
  live(status);

  let approvedBy = null, proposalId = null;
  const match = await configVoteP;
  if (match) {
    proposalId = match.id;
    approvedBy = new Set(Object.entries(match.votes).filter(([, x]) => x === "Approve").map(([k]) => k));
  }
  const yesCount = approvedBy ? members.filter(([a]) => approvedBy.has(a)).length : 0;
  live(() => {
    $("p-voters").innerHTML = members.slice(0, 6).map(([a]) => {
      const yes = approvedBy?.has(a);
      return `<li class="${yes ? "yes" : "no"}" title="${esc(a)}"><span class="mark" aria-hidden="true">${yes ? "✓" : "–"}</span>${esc(nick(a))}<em>${yes
        ? t("voted yes", "setuju") : approvedBy ? t("didn't vote", "tidak memilih") : t("vote not found", "suara tidak ditemukan")}</em></li>`;
    }).join("") + (members.length > 6 ? `<li class="no">+${members.length - 6} ${t("more", "lainnya")}</li>` : "");
    $("p-tally").innerHTML = proposalId !== null
      ? t(`<a href="${explorer(dep.dao)}">Proposal #${proposalId}</a> passed with ${yesCount} yes ${yesCount === 1 ? "vote" : "votes"}: by-laws v${v}.`,
        `<a href="${explorer(dep.dao)}">Usulan #${proposalId}</a> lolos dengan ${yesCount} suara setuju: anggaran dasar v${v}.`)
      : t(`By-laws v${v} were approved by a member vote.`, `Anggaran dasar v${v} disetujui lewat pemungutan suara anggota.`);
  });
  $("p-lock").href = explorer(dep.dao);
  const termsBox = $("p-terms");
  let terms = null; // read from the approved by-laws file, once it is hashed
  const drawTerms = () => {
    termsBox.innerHTML =`<div><dt>${t("Rule book", "Buku aturan")}</dt><dd>${t("by-laws", "anggaran dasar")} v${v}</dd></div><div><dt>${t("Fingerprint", "Sidik jari")}</dt><dd>${short(info.config.hash)}</dd></div>`
      + (!terms ? "" : `<div><dt>${t("Charges per job", "Tarif per pekerjaan")}</dt><dd>${terms.price} USDC</dd></div>`
      + `<div><dt>${t("AI spend cap", "Batas belanja AI")}</dt><dd>${t(`$${terms.perJob} a job, $${terms.perDay} a day`, `$${terms.perJob} per pekerjaan, $${terms.perDay} per hari`)}</dd></div>`
      + `<div class="wide"><dt>${t("Model", "Model")}</dt><dd>${terms.model}</dd></div>`);
  };
  live(drawTerms);
  fetch(byLawsUrl(info.config.uri)).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`)))).then(async (raw) => {
    const hex = [...new Uint8Array(await crypto.subtle.digest("SHA-256", raw))].map((b) => b.toString(16).padStart(2, "0")).join("");
    live(() => verdict("ck-bylaws", hex === info.config.hash, hex === info.config.hash
      ? t(`Your browser hashed <code>${esc(info.config.uri)}</code>: <code>${short(hex)}</code>, the hash the members voted for v${v}. The contract refuses receipts under any other.${dep.outlayer ? ` An Intel TDX enclave checked the same on-chain, through OutLayer (<a href="${txUrl(dep.outlayer.tx)}">the transaction</a>).` : ""}`,
        `Browser Anda meng-hash <code>${esc(info.config.uri)}</code>: <code>${short(hex)}</code>, hash yang dipilih anggota untuk v${v}. Kontrak menolak tanda terima dengan hash lain.${dep.outlayer ? ` Sebuah enclave Intel TDX memeriksa hal yang sama on-chain, lewat OutLayer (<a href="${txUrl(dep.outlayer.tx)}">transaksinya</a>).` : ""}`)
      : t(`The published file hashes to <code>${short(hex)}</code>, not the approved <code>${short(info.config.hash)}</code>.`,
        `Hash berkas yang diterbitkan adalah <code>${short(hex)}</code>, bukan <code>${short(info.config.hash)}</code> yang disetujui.`)));
    if (hex !== info.config.hash) return; // only show terms from the exact file the members approved
    const text = new TextDecoder().decode(raw);
    const get = (re) => esc(text.match(re)?.[1]?.trim() ?? "");
    terms = { price: get(/^\s+price_usdc:\s*([\d.]+)/m), perJob: get(/max_inference_per_job_usd:\s*([\d.]+)/),
      perDay: get(/max_inference_per_day_usd:\s*([\d.]+)/), model: get(/^model:\s*"?([^"\n]+)/m) };
    drawTerms();
    // the latest proof that this model runs in genuine TEEs (agent/tee.mjs; re-checked by CI)
    const model = text.match(/^model:\s*"?([^"\n]+)/m)?.[1]?.trim();
    if (!model) return;
    armTeeCheck(model);
    const file = `tee-${model.replace(/[^a-z0-9.-]/gi, "_")}.json`;
    const ev = await fetch(`${RAW}evidence/${file}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const tee = $("p-tee");
    live(() => {
      if (!ev) { tee.textContent = t(`No TEE check published yet for ${model}.`, `Belum ada pemeriksaan TEE yang diterbitkan untuk ${model}.`); return; }
      const m = ev.models?.[0] ?? {};
      const when = new Date(ev.at).toLocaleString(t("en-GB", "id-ID"), { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
      tee.innerHTML = ev.ok
        ? t(`<span class="state on">TEE verified</span> ${esc(when)} UTC: Intel TDX ${esc(m.tdx_status ?? "")}, NVIDIA GPU ${m.gpu?.verdict === true ? "pass" : "unknown"}, bound to a fresh nonce. The agent re-checks before every job and refuses unverified models. <a href="/evidence/${esc(file)}">Evidence</a>`,
          `<span class="state on">TEE terverifikasi</span> ${esc(when)} UTC: Intel TDX ${esc(m.tdx_status ?? "")}, GPU NVIDIA ${m.gpu?.verdict === true ? "lolos" : "tidak diketahui"}, terikat pada nonce baru. Agen memeriksa ulang sebelum setiap pekerjaan dan menolak model yang tidak terverifikasi. <a href="/evidence/${esc(file)}">Bukti</a>`)
        : t(`<span class="state off">TEE not verified</span> ${esc(when)} UTC: ${esc(ev.reason ?? "a check failed")}. The agent will not send jobs to this model.`,
          `<span class="state off">TEE tidak terverifikasi</span> ${esc(when)} UTC: ${esc(ev.reason ?? "ada pemeriksaan yang gagal")}. Agen tidak akan mengirim pekerjaan ke model ini.`);
    });
  }).catch((e) => verdict("ck-bylaws", false, t(`Could not download the by-laws file (${esc(e.message)}). Reload to try again.`, `Gagal mengunduh berkas anggaran dasar (${esc(e.message)}). Muat ulang untuk mencoba lagi.`)));

  // passbook: the co-op's life as ledger lines, newest first
  live(() => {
    const lines = [
      ...versions.map((x) => ({ ts: x.activated_at, text: t(`By-laws v${x.version} approved`, `Anggaran dasar v${x.version} disetujui`), amt: "" })),
      ...receipts.filter((r) => r.status === "Paid").map((r) => ({ ts: r.ts, text: t(`Job paid, by-laws v${r.config_version}`, `Pekerjaan dibayar, anggaran dasar v${r.config_version}`), amt: `+${usdc(r.price)}` })),
      ...periods.map((p) => ({ ts: p.ts, text: t(`Profit share ${p.id} to ${p.members} members`, `SHU ${p.id} untuk ${p.members} anggota`), amt: `-${usdc(BigInt(p.amount) - BigInt(p.reserve))}`, out: true })),
    ].sort((a, b) => (BigInt(b.ts) > BigInt(a.ts) ? 1 : -1)).slice(0, 9);
    rows($("passbook").tBodies[0], lines.map((l) =>
      `<tr><td>${date(l.ts)}</td><td>${esc(l.text)}</td><td class="num${l.out ? " out" : ""}">${l.amt}</td></tr>`).join(""));

    verdict("ck-money", owed === 0n, owed === 0n
      ? t(`Every paid job (${usdc(rekon.expected)} USDC after the market's 5%) reached the co-op's DAO. The steward's bond stays at stake.`,
        `Setiap pekerjaan yang dibayar (${usdc(rekon.expected)} USDC setelah potongan pasar 5%) sudah sampai di DAO koperasi. Jaminan pengurus tetap dipertaruhkan.`)
      : t(`<strong>${usdc(owed)} USDC</strong> of paid jobs has not reached the co-op. Members can vote to slash the steward's bond. (This demo co-op keeps it red on purpose.)`,
        `<strong>${usdc(owed)} USDC</strong> dari pekerjaan yang dibayar belum sampai di koperasi. Anggota bisa memilih untuk memotong jaminan pengurus. (Koperasi demo ini sengaja dibiarkan merah.)`));
    const stamp = $("stamp");
    stamp.hidden = false;
    if (owed > 0n) {
      stamp.classList.add("red");
      stamp.innerHTML = t(`Not passed on<br>${usdc(owed)} USDC`, `Belum disetor<br>${usdc(owed)} USDC`);
    } else {
      stamp.innerHTML = t(`Approved by vote<br>by-laws v${info.config.version}`, `Disetujui lewat suara<br>anggaran dasar v${info.config.version}`);
    }
  });

  // members: pick one, see savings, points and share against the largest member
  const top = (f) => Math.max(1, ...members.map((m, i) => Number(f(m, i))));
  const claimable = await claimableP;
  const tops = [top(([, m]) => m.savings), top(([, m]) => m.points), top((_, i) => claimable[i])];
  const pick = $("member-pick");
  const meter = (label, val, raw, max) => `<div class="meter"><div class="label"><span>${label}</span><span class="val">${val}</span></div>
      <div class="track"><div class="fill" data-w="${(100 * Number(raw)) / max}"></div></div></div>`;
  const showMember = () => {
    const i = Number(pick.value);
    if (!members[i]) return;
    const m = members[i][1];
    $("meters").innerHTML = meter(t("Savings staked, NEAR", "Simpanan di-stake, NEAR"), nearAmt(m.savings), m.savings, tops[0])
      + meter(t("Contribution points", "Poin kontribusi"), m.points, m.points, tops[1])
      + meter(t("Share to claim, USDC", "SHU yang bisa diklaim, USDC"), usdc(claimable[i]), claimable[i], tops[2]);
    requestAnimationFrame(() => requestAnimationFrame(() =>
      document.querySelectorAll("#meters .fill").forEach((f) => { f.style.width = `${f.dataset.w}%`; })));
  };
  pick.onchange = showMember;
  live(() => {
    const sel = pick.value;
    pick.innerHTML = members.map(([a], i) => `<option value="${i}">${esc(a)}${a === info.steward ? ` (${t("steward", "pengurus")})` : ""}</option>`).join("");
    if (sel) pick.value = sel;
    showMember();
  });

  const pool = await view(dep.contract, "get_staking_pool").catch(() => null);
  live(() => {
    $("pool-line").innerHTML = pool
      ? t(`Savings are read on-chain from each member's stake in <a href="${explorer(pool)}">${esc(pool)}</a>, the pool the members chose. Anyone can call <code>sync_savings</code> to refresh them.`,
        `Simpanan dibaca on-chain dari stake setiap anggota di <a href="${explorer(pool)}">${esc(pool)}</a>, pool yang dipilih anggota. Siapa pun bisa memanggil <code>sync_savings</code> untuk memperbaruinya.`)
      : t("Savings are set by a members' vote (set_savings).", "Simpanan ditetapkan lewat pemungutan suara anggota (set_savings).");
    rows($("member-table").tBodies[0], members.map(([a, m], i) => `<tr>
        <td>${esc(a)}${a === info.steward ? ` <span class="muted">(${t("steward", "pengurus")})</span>` : ""}</td>
        <td class="num" data-label="${t("Savings staked", "Simpanan di-stake")}">${nearAmt(m.savings)}</td>
        <td class="num" data-label="${t("Contribution points", "Poin kontribusi")}">${m.points}</td>
        <td class="num" data-label="${t("Share to claim", "SHU yang bisa diklaim")}">${usdc(claimable[i])}</td></tr>`).join(""));

    $("versions").innerHTML = [...versions].reverse().map((x) => `
      <li class="${x.version === info.config.version ? "current" : ""}">
        <span class="v">v${x.version}</span>
        <div>
          <div class="meta">${date(x.activated_at)}${x.contributor ? t(`, proposed by ${esc(x.contributor)}`, `, diusulkan oleh ${esc(x.contributor)}`) : t(", founding by-laws", ", anggaran dasar pendirian")}${x.version === info.config.version ? t(". The agent runs this one.", ". Inilah yang dijalankan agen.") : ""}</div>
          <div class="hash">sha256 ${esc(x.hash)}</div>
          <div class="meta">${esc(x.uri)}</div>
        </div>
      </li>`).join("");
  });

  // by-laws: anyone can hash the published file in their own browser and compare it with the contract
  const current = versions.find((x) => x.version === info.config.version) ?? info.config;
  const box = $("verify");
  let checkedFile = null; // { hex, text } once hashed, or { error }; drawn again on the language switch
  const drawVerify = () => {
    if (checkedFile === "busy") return;
    if (!checkedFile) {
      box.innerHTML = `<button type="button" class="btn">${t(`Verify by-laws v${current.version} in your browser`, `Periksa anggaran dasar v${current.version} di browser Anda`)}</button>
        <p class="hint">${t(`Downloads <code>${esc(current.uri)}</code> from the public repo, hashes it here, and compares it with the hash the members voted on.`,
          `Mengunduh <code>${esc(current.uri)}</code> dari repo publik, meng-hash-nya di sini, dan membandingkannya dengan hash yang dipilih anggota.`)}</p>`;
      box.querySelector("button").onclick = runVerify;
      return;
    }
    if (checkedFile.error) {
      box.innerHTML = `<p class="match bad">${t(`Could not download ${esc(current.uri)}: ${esc(checkedFile.error)}. Reload and try again.`,
        `Gagal mengunduh ${esc(current.uri)}: ${esc(checkedFile.error)}. Muat ulang dan coba lagi.`)}</p>`;
      return;
    }
    const { hex, text } = checkedFile;
    const pickVal = (re) => esc(text.match(re)?.[1]?.trim() ?? t("not set", "tidak diatur"));
    const ok = hex === current.hash;
    box.innerHTML = `
      <p class="match ${ok ? "ok" : "bad"}">${ok ? t("Match. The file is exactly what the members approved.", "Cocok. Berkas ini persis yang disetujui anggota.")
        : t("Mismatch. The published file is not what the members approved.", "Tidak cocok. Berkas yang diterbitkan bukan yang disetujui anggota.")}</p>
      <dl class="hashes"><dt>${t("Your browser", "Browser Anda")}</dt><dd>${hex}</dd><dt>${t(`On-chain, v${current.version}`, `On-chain, v${current.version}`)}</dt><dd>${esc(current.hash)}</dd></dl>
      <dl class="terms">
        <div><dt>${t("Model", "Model")}</dt><dd>${pickVal(/^model:\s*"?([^"\n]+)/m)}</dd></div>
        <div><dt>${t("Bid per job", "Tawaran per pekerjaan")}</dt><dd>${pickVal(/^\s+price_usdc:\s*([\d.]+)/m)} USDC</dd></div>
        <div><dt>${t("Inference cap per job", "Batas inferensi per pekerjaan")}</dt><dd>$${pickVal(/max_inference_per_job_usd:\s*([\d.]+)/)}</dd></div>
        <div><dt>${t("Inference cap per day", "Batas inferensi per hari")}</dt><dd>$${pickVal(/max_inference_per_day_usd:\s*([\d.]+)/)}</dd></div>
        <div class="wide"><dt>${t("Takes jobs tagged", "Menerima pekerjaan bertag")}</dt><dd>${pickVal(/tags_any:\s*\[([^\]]*)\]/)}</dd></div>
        ${/members_at_least:\s*\d+/.test(text) ? `<div class="wide"><dt>${t("The steward hands over at", "Pengurus menyerahkan peran pada")}</dt><dd>${t(
          `${pickVal(/members_at_least:\s*(\d+)/)} members (now ${info.members}) or ${pickVal(/paid_jobs_at_least:\s*(\d+)/)} paid jobs (now ${paid}), both read from the chain`,
          `${pickVal(/members_at_least:\s*(\d+)/)} anggota (kini ${info.members}) atau ${pickVal(/paid_jobs_at_least:\s*(\d+)/)} pekerjaan dibayar (kini ${paid}), keduanya dibaca dari chain`)}</dd></div>` : ""}
      </dl>
      <details><summary>${t("Read the whole file", "Baca seluruh berkas")}</summary><pre>${esc(text)}</pre></details>`;
  };
  const runVerify = async () => {
    checkedFile = "busy";
    box.innerHTML = `<p class="hint">${t("Hashing", "Meng-hash")} ${esc(current.uri)}…</p>`;
    try {
      const res = await fetch(byLawsUrl(current.uri), { cache: "no-store" });
      // a missing file is "could not download", never a mismatch: only the file itself is judged
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.arrayBuffer();
      const hex = [...new Uint8Array(await crypto.subtle.digest("SHA-256", raw))].map((b) => b.toString(16).padStart(2, "0")).join("");
      checkedFile = { hex, text: new TextDecoder().decode(raw) };
    } catch (e) {
      checkedFile = { error: e.message };
    }
    drawVerify();
  };
  live(drawVerify);

  const demoTitle = () => t("Recorded by npm run demo against a local stand-in for Agent Market; no model ran", "Dicatat oleh npm run demo terhadap pengganti lokal Agent Market; tidak ada model yang berjalan");
  const demoCell = () => `<span class="muted" title="${demoTitle()}">${t("Demo market, no model", "Pasar demo, tanpa model")}</span>`;
  const proofCell = (p, job) => {
    if (p === undefined) return `<span class="muted">${t("Proof not read (NEAR RPC busy): reload to check", "Bukti belum terbaca (RPC NEAR sibuk): muat ulang untuk memeriksa")}</span>`;
    if (!p) return demoCell();
    let x;
    try { x = JSON.parse(p); } catch { return `<span class="muted">${esc(p.slice(0, 16))}</span>`; }
    // the by-laws gate ran on-chain in an Intel TDX enclave (OutLayer) before the job started
    const gate = x.gate?.tx ? ` <a class="badge Paid" href="${txUrl(String(x.gate.tx))}" title="${t("By-laws checked inside an Intel TDX enclave (OutLayer) before this job", "Anggaran dasar diperiksa di dalam enclave Intel TDX (OutLayer) sebelum pekerjaan ini")}">TDX gate</a>` : "";
    if (!x.model) return `${demoCell()}${gate}`;
    // a demo- job came from a stand-in buyer, but a real model in a verified TEE did it and signed the answer
    return `<span class="badge Paid" title="${esc(p)}">${t("TEE-signed", "Ditandatangani TEE")}</span> <span class="muted">${job.startsWith("demo-") ? t("demo buyer, real model", "pembeli demo, model sungguhan") : esc(String(x.tee_signer ?? "").slice(0, 10)) + "…"}</span>${gate}`;
  };
  // everything that cites the proofs is filled in once they are read; the sections below do not wait for them
  proofsP.then((proofs) => {
    const unread = proofs.some((p) => p === undefined);
    // a proof is JSON: `model`… when a TEE-verified model did the job, `gate` when the by-laws were checked in an enclave first
    const parsed = proofs.map((p) => { try { return p ? JSON.parse(p) : null; } catch { return null; } });
    const teeJobs = checked.filter((r, i) => parsed[i]?.model);
    teeCount = unread ? undefined : teeJobs.length;
    status();
    const teeMarket = teeJobs.filter((r) => !/^(demo|taskbond)-/.test(r.job_id)).length;
    const demoTee = teeJobs.filter((r) => r.job_id.startsWith("demo-"));
    // jobs won on a third-party testnet market (scripts/taskbond.mjs): another team's escrow, guard and reviewer
    const won = (dep.taskbond ?? []).filter((x) => x.status === "Paid" && x.winner === x.agent_id);
    live(() => {
      const scores = won.map((x) => esc(x.score)).join(", ");
      const tb = won.length ? `<a href="https://taskbond-iota.vercel.app/jobs/${esc(won.at(-1).job)}">Taskbond</a>` : "";
      const third = !won.length ? "" : t(` On ${tb}, another team's testnet market, it won ${won.length === 1 ? "a job" : `${won.length} jobs`} its reviewer AI scored ${scores}/100, paid by that market's escrow.`,
        ` Di ${tb}, pasar testnet milik tim lain, agen ini memenangkan ${won.length === 1 ? "satu pekerjaan" : `${won.length} pekerjaan`} yang dinilai ${scores}/100 oleh AI peninjaunya, dibayar dari escrow pasar itu.`);
      const n = demoTee.length;
      $("p-agent").innerHTML = info.paused
        ? t(`<span class="state off">Paused</span> The members voted to stop it.`, `<span class="state off">Dihentikan</span> Anggota memilih untuk menghentikannya.`)
        : t(`<span class="state on">Allowed to work</span> It follows by-laws v${v} and nothing else. Hand it any other version and it stops working, and the contract rejects its receipts. ${teeMarket
          ? `${teeMarket} Agent Market ${teeMarket === 1 ? "job" : "jobs"} done by a TEE-verified model.`
          : `No Agent Market job yet.${third}${n ? ` ${n === 1 ? "One job" : `${n} jobs`} from a demo buyer ${n === 1 ? "was" : "were"} done by a TEE-verified model, with the proof on-chain;` : ""} the other paid receipts come from the testnet demo, where a local stand-in plays Agent Market and no model runs.`}`,
        `<span class="state on">Boleh bekerja</span> Agen hanya mengikuti anggaran dasar v${v}. Berikan versi lain dan ia berhenti bekerja, dan kontrak menolak tanda terimanya. ${teeMarket
          ? `${teeMarket} pekerjaan Agent Market dikerjakan oleh model yang terverifikasi TEE.`
          : `Belum ada pekerjaan dari Agent Market.${third}${n ? ` ${n === 1 ? "Satu pekerjaan" : `${n} pekerjaan`} dari pembeli demo dikerjakan oleh model yang terverifikasi TEE, dengan buktinya on-chain;` : ""} tanda terima berbayar lainnya berasal dari demo testnet, di mana pengganti lokal memerankan Agent Market dan tidak ada model yang berjalan.`}`);
      rows($("receipts").tBodies[0], recent.map((r, i) => `<tr>
          <td>${esc(r.job_id.slice(0, 8))}… <span class="muted">${date(r.ts)}</span></td>
          <td class="num" data-label="${t("Price", "Harga")}">${usdc(r.price)}</td>
          <td class="num" data-label="${t("Inference", "Inferensi")}">$${(Number(r.inference_cost) / 1e6).toFixed(4)}</td>
          <td data-label="${t("By-laws", "Anggaran dasar")}">v${r.config_version} <span class="muted">${short(r.config_hash)}</span></td>
          <td data-label="Proof">${proofCell(proofs[i], r.job_id)}</td>
          <td data-label="Status"><span class="badge ${r.status}">${r.status}</span></td></tr>`).join(""));
    });
  }).catch((e) => console.error(e));

  // audit: owed vs deposited, two bars on one scale
  const scale = Math.max(Number(rekon.expected), Number(rekon.deposited), 1);
  const pct = (u) => Math.max(1, (100 * Number(u)) / scale);
  const bond = nearAmt(info.steward_bond);
  $("verdict").className = `verdict ${owed > 0n ? "owed" : "ok"}`;
  live(() => {
    $("rekon").innerHTML = `
      <div class="axis" aria-hidden="true"><span>${usdc(scale)}</span><span>${usdc(scale / 2)}</span><span>0</span></div>
      <div class="bar"><span class="n">${usdc(rekon.expected)}</span><div class="col" style="height:${pct(rekon.expected)}%"></div></div>
      <div class="bar${owed > 0n ? " missing" : ""}"><span class="n">${usdc(rekon.deposited)}</span><div class="col" style="height:${pct(rekon.deposited)}%"></div></div>
      <span class="cap" style="grid-column:2">${t("Owed to the co-op, USDC", "Hak koperasi, USDC")}</span>
      <span class="cap" style="grid-column:3">${t("Deposited by the steward", "Disetor oleh pengurus")}${owed > 0n ? t(`: ${usdc(owed)} missing`, `: kurang ${usdc(owed)}`) : ""}</span>`;
    $("verdict").innerHTML = owed > 0n
      ? t(`<span class="seal">RED</span><p>The steward has not passed on ${usdc(owed)} USDC. ${BigInt(info.steward_bond) > 0n
        ? `Any member can propose slashing the steward's bond (${bond} NEAR).`
        : "The members already slashed the steward's bond; they can appoint a new steward by vote."}</p>`,
      `<span class="seal">MERAH</span><p>Pengurus belum menyetor ${usdc(owed)} USDC. ${BigInt(info.steward_bond) > 0n
        ? `Anggota mana pun bisa mengusulkan pemotongan jaminan pengurus (${bond} NEAR).`
        : "Anggota sudah memotong jaminan pengurus; mereka bisa mengangkat pengurus baru lewat pemungutan suara."}</p>`)
      : t(`<span class="seal">GREEN</span><p>Every paid job has reached the co-op. Steward bond at stake: ${bond} NEAR.</p>`,
        `<span class="seal">HIJAU</span><p>Setiap pekerjaan yang dibayar sudah sampai di koperasi. Jaminan pengurus yang dipertaruhkan: ${bond} NEAR.</p>`);
  });

  $("audit-note").hidden = owed === 0n;
  // the treasury, read from the token contract itself rather than from Koperasi's own counter
  view(dep.usdc, "ft_balance_of", { account_id: dep.dao }).then((bal) => live(() => {
    $("treasury").innerHTML = t(`The DAO treasury holds <strong>${usdc(bal)} USDC</strong> right now, read from <a href="${explorer(dep.usdc)}">${esc(dep.usdc)}</a>. Spending it takes a vote.`,
      `Kas DAO saat ini berisi <strong>${usdc(bal)} USDC</strong>, dibaca dari <a href="${explorer(dep.usdc)}">${esc(dep.usdc)}</a>. Membelanjakannya perlu pemungutan suara.`);
  })).catch(() => {});

  // NEP-330: the contract names the commit and the pinned build image it came from, so anyone can rebuild the same code
  const sourceCard = (src) => {
    const b = src?.build_info;
    const rev = b?.source_code_snapshot?.match(/[?&]rev=([0-9a-f]{40})$/)?.[1];
    if (!b || !rev || typeof src.link !== "string" || !/^https:\/\/github\.com\//.test(src.link)) {
      return `<p class="hint">${t("The contract does not publish a reproducible build yet (NEP-330).", "Kontrak belum menerbitkan build yang bisa direproduksi (NEP-330).")}</p>`;
    }
    const commit = `<a href="${esc(src.link)}"><code>${esc(rev.slice(0, 7))}</code></a>`, env = `<code>${esc(b.build_environment.split("@")[0])}</code>`;
    return `<div class="src-card" id="src-card"><h4>${t("Rebuild it yourself (NEP-330)", "Bangun ulang sendiri (NEP-330)")}</h4>
      <p>${t(`The contract says it was built from commit ${commit} (v${esc(src.version)}) in ${env}, pinned by its image digest.`,
        `Kontrak menyatakan ia dibangun dari commit ${commit} (v${esc(src.version)}) di ${env}, dikunci dengan digest image-nya.`)}</p>
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
  ]).then(([acct, keys, props, src]) => live(() => {
    const code = acct.global_contract_hash ?? acct.code_hash;
    const full = keys.keys.filter((k) => k.access_key.permission === "FullAccess").length;
    const vote = [...props].reverse().find((p) => p.status === "Approved" && p.kind?.FunctionCall?.actions?.some((x) =>
      x.method_name === "upgrade" && (() => { try { return JSON.parse(atob(x.args)).code_hash === code; } catch { return false; } })()));
    const by = vote ? t(`approved in <a href="${explorer(dep.dao)}">proposal #${vote.id}</a>`, `disetujui dalam <a href="${explorer(dep.dao)}">usulan #${vote.id}</a>`)
      : t("not traced to a vote", "tidak terlacak ke pemungutan suara");
    const what = acct.global_contract_hash ? t("the global contract", "kontrak global") : t("code", "kode");
    const keysEn = `${full} full-access key${full > 1 ? "s" : ""}`, keysId = `${full} kunci full-access`;
    $("codegov").innerHTML = `<h3>${t("Who can change the contract's code?", "Siapa yang bisa mengubah kode kontrak?")}</h3>
      <p>${t(`It runs ${what} <code>${esc(code.slice(0, 12))}…</code>, ${by}.
      A new version is published as an immutable NEAR global contract and the members vote <code>upgrade({code_hash})</code>.`,
      `Kontrak menjalankan ${what} <code>${esc(code.slice(0, 12))}…</code>, ${by}.
      Versi baru diterbitkan sebagai kontrak global NEAR yang tidak bisa diubah, lalu anggota memilih <code>upgrade({code_hash})</code>.`)}</p>
      <p class="match ${full ? "bad" : "ok"}">${full
        ? t(`The contract account still has ${keysEn}: whoever holds it could change the code without a vote. Removing it is the next step (<code>scripts/upgrade.mjs --lock</code>).`,
          `Akun kontrak masih punya ${keysId}: pemegangnya bisa mengubah kode tanpa pemungutan suara. Menghapusnya adalah langkah berikutnya (<code>scripts/upgrade.mjs --lock</code>).`)
        : t("The contract account has no full-access key. Only a members' vote can change its code.", "Akun kontrak tidak punya kunci full-access. Hanya pemungutan suara anggota yang bisa mengubah kodenya.")}</p>${sourceCard(src)}`;
    verdict("ck-code", full === 0 && !!vote, full === 0
      ? t(`The contract account holds <strong>no full-access key</strong>, not even the builder's. Its code is ${vote ? `the version members approved in proposal #${vote.id}` : "not traced to a vote"}; changing it takes another vote.`,
        `Akun kontrak <strong>tidak punya kunci full-access</strong>, bahkan milik pembuatnya pun tidak. Kodenya ${vote ? `adalah versi yang disetujui anggota dalam usulan #${vote.id}` : "tidak terlacak ke pemungutan suara"}; mengubahnya perlu pemungutan suara lagi.`)
      : t(`The contract account still has ${keysEn}: someone could change the code without a vote.`, `Akun kontrak masih punya ${keysId}: seseorang bisa mengubah kode tanpa pemungutan suara.`));
  })).catch((e) => {
    $("codegov").innerHTML = `<p class="hint">${t("Could not read the contract account", "Gagal membaca akun kontrak")}: ${esc(e.message)}</p>`;
    verdict("ck-code", null, t(`Could not read the contract account right now (${esc(e.message)}).`, `Belum bisa membaca akun kontrak (${esc(e.message)}).`));
  });

  const r = info.share_rule;
  live(() => {
    $("share-rule").textContent = t(`The members vote each profit share. ${r.reserve_bps / 100}% stays in the DAO as the co-op's reserve; the rest is split by savings and by contribution, and each member claims their own.`,
      `Anggota memutuskan setiap pembagian SHU lewat pemungutan suara. ${r.reserve_bps / 100}% tetap di DAO sebagai dana cadangan koperasi; sisanya dibagi menurut simpanan dan kontribusi, dan setiap anggota mengklaim bagiannya sendiri.`);
    $("plans").innerHTML = `
      <div class="plan"><h3>${t("Co-op<br>reserve", "Dana<br>cadangan")}</h3><p class="for">${t("Stays in the DAO treasury", "Tetap di kas DAO")}</p><span class="pct">${r.reserve_bps / 100}%</span>
        <ul><li>${t("Back to the Sputnik DAO", "Kembali ke Sputnik DAO")}</li><li>${t("Spent only by a vote", "Hanya dibelanjakan lewat pemungutan suara")}</li><li>${t("Readable by anyone on-chain", "Bisa dibaca siapa pun on-chain")}</li></ul></div>
      <div class="plan members"><h3>${t("Members'<br>share", "Bagian<br>anggota")}</h3><p class="for">${t("Claimed by each member", "Diklaim oleh setiap anggota")}</p><span class="pct">${(r.savings_bps + r.points_bps) / 100}%</span>
        <ul><li>${t(`${r.savings_bps / 100}% by savings staked`, `${r.savings_bps / 100}% menurut simpanan`)}</li><li>${t(`${r.points_bps / 100}% by contribution points`, `${r.points_bps / 100}% menurut poin kontribusi`)}</li><li>${t("No money lost to rounding", "Tidak ada uang hilang karena pembulatan")}</li></ul></div>`;
  });
  // tasks the co-op pays for: Sputnik bounties, paid from the treasury after a vote
  view(dep.dao, "get_last_bounty_id").then(async (n) => {
    const list = n ? await view(dep.dao, "get_bounties", { from_index: 0, limit: n }) : [];
    const taken = await Promise.all(list.map((b) => view(dep.dao, "get_bounty_number_of_claims", { id: b.id }).catch(() => 0)));
    live(() => rows($("bounties").tBodies[0], list.map((b, i) => `<tr><td>${esc(b.description)}</td>
      <td class="num" data-label="${t("Pays", "Bayaran")}">${!b.token ? `${nearAmt(b.amount)} NEAR` : b.token === dep.usdc ? `${usdc(b.amount)} USDC`
        : t(`${esc(b.amount)} of ${esc(b.token)} (not the co-op's USDC)`, `${esc(b.amount)} ${esc(b.token)} (bukan USDC koperasi)`)}</td>
      <td class="num" data-label="${t("Left", "Sisa")}">${b.times}</td><td class="num" data-label="${t("Taken", "Diambil")}">${taken[i]}</td></tr>`).join("")));
  }).catch(() => rows($("bounties").tBodies[0], ""));
  // tasks with earned trust: the members' rule, every task, and each contributor's record with its sources
  trustBoard().then(([b, tasks, recs, payouts]) => live(() => {
    const rule = b.rule;
    $("trust-rule").innerHTML = !rule ? t("The members have not voted a trust rule yet, so no task can be posted.", "Anggota belum memutuskan aturan kepercayaan, jadi belum ada tugas yang bisa dipasang.")
      : t(`The money stays in the DAO treasury: each payout is a Transfer proposal the contract files and approves with its own DAO role <code>tasks</code>, which can do nothing else. The members let it pay <strong>${nearAmt(b.budget)} NEAR</strong> more. A member who finishes a task earns contribution points toward the profit share, in proportion to its pay: ${rule.points} for a task at the one-member limit (${nearAmt(rule.one_vote_max)} NEAR), fewer for a smaller one. A contributor who is not a member gets the pay, not the points.`,
        `Uangnya tetap di kas DAO: setiap pembayaran adalah usulan Transfer yang diajukan dan disetujui kontrak lewat perannya sendiri di DAO, <code>tasks</code>, yang tidak bisa melakukan hal lain. Anggota mengizinkannya membayar <strong>${nearAmt(b.budget)} NEAR</strong> lagi. Anggota yang menyelesaikan tugas mendapat poin kontribusi untuk pembagian SHU, sebanding dengan bayarannya: ${rule.points} untuk tugas pada batas satu anggota (${nearAmt(rule.one_vote_max)} NEAR), lebih sedikit untuk tugas yang lebih kecil. Kontributor yang bukan anggota mendapat bayarannya, bukan poinnya.`);
    $("tiers").innerHTML = rule ? [
      [t("Paid on acceptance", "Dibayar saat diterima"), t(`up to ${nearAmt(rule.auto_max)} NEAR, for a contributor trusted by ${rule.trusted_after}+ different member${rule.trusted_after === 1 ? "" : "s"} (or a voted bounty). Each poster pays at most ${nearAmt(rule.poster_daily_auto)} NEAR a day this way. No vote.`,
        `hingga ${nearAmt(rule.auto_max)} NEAR, untuk kontributor yang dipercaya ${rule.trusted_after}+ anggota berbeda (atau bounty yang sudah dipilih). Setiap pemasang tugas membayar paling banyak ${nearAmt(rule.poster_daily_auto)} NEAR sehari dengan cara ini. Tanpa pemungutan suara.`)],
      ...(b.veto_minutes ? [[t("Veto window", "Masa veto"), t(`a payout on trust waits ${b.veto_minutes} minutes first. Any member but the contributor can veto it, and then one other member must approve. After that, anyone releases it.`,
        `pembayaran atas kepercayaan menunggu ${b.veto_minutes} menit dulu. Anggota mana pun selain kontributor bisa memvetonya, lalu satu anggota lain harus menyetujuinya. Setelah itu, siapa pun bisa mencairkannya.`)]] : []),
      [t("One member approves", "Satu anggota menyetujui"), t(`up to ${nearAmt(rule.one_vote_max)} NEAR, or anyone without that record yet. Never the poster or the contributor.`,
        `hingga ${nearAmt(rule.one_vote_max)} NEAR, atau siapa pun yang belum punya catatan itu. Tidak pernah pemasang tugas atau kontributornya.`)],
      [t("All members vote", "Semua anggota memilih"), t(`above ${nearAmt(rule.one_vote_max)} NEAR: a Sputnik DAO bounty, paid from the treasury, counted on the record.`,
        `di atas ${nearAmt(rule.one_vote_max)} NEAR: bounty Sputnik DAO, dibayar dari kas, dihitung dalam catatan.`)],
    ].map(([h, p]) => `<li><b>${h}</b><span>${p}</span></li>`).join("") : "";
    const STATUS = t({ Open: "Open", Claimed: "Taken", Submitted: "Delivered, waiting for the poster", NeedsApproval: "Waiting for one member",
      Held: "Accepted on trust, held for a member's veto", Paying: "Paying", Paid: "Paid", Cancelled: "Cancelled" },
    { Open: "Terbuka", Claimed: "Diambil", Submitted: "Diserahkan, menunggu pemasang", NeedsApproval: "Menunggu satu anggota",
      Held: "Diterima atas kepercayaan, ditahan untuk veto anggota", Paying: "Sedang dibayar", Paid: "Dibayar", Cancelled: "Dibatalkan" });
    const work = (d) => (/^https:\/\/\S+$/.test(d) ? `<a href="${esc(d)}" rel="noopener">${esc(d)}</a>` : esc(d));
    // scripts/scenarios.mjs ran twice, so tasks #16–#22 repeat #9–#15 (each a real task in its own state): say so
    const firstWith = new Map();
    for (const x of tasks) if (!firstWith.has(x.description)) firstWith.set(x.description, x.id);
    rows($("tasks").tBodies[0], tasks.map((x, i) => [x, i]).reverse().map(([x, i]) => `<tr id="task-${x.id}">
      <td><strong>#${x.id}</strong> ${esc(x.description)}${firstWith.get(x.description) !== x.id ? ` <span class="tag-repeat">${t("repeat of", "ulangan dari")} #${esc(firstWith.get(x.description))}</span>` : ""}<span class="claim">${t("posted by", "dipasang oleh")} ${esc(x.poster)}${x.deliverable ? `; ${t("delivered", "diserahkan")}: ${work(x.deliverable)}` : ""}</span></td>
      <td class="num" data-label="${t("Pays", "Bayaran")}">${nearAmt(x.amount)} NEAR</td>
      <td data-label="Status">${STATUS[x.status] ?? esc(x.status)}</td>
      <td data-label="${t("Contributor", "Kontributor")}">${x.contributor ? `<a href="${explorer(x.contributor)}">${esc(x.contributor)}</a>` : "–"}</td>
      <td data-label="${t("Paid how", "Cara dibayar")}">${x.status !== "Paid" ? "–" : x.approved_by ? `${t("approved by", "disetujui oleh")} ${esc(x.approved_by)}` : t("on earned trust, no vote", "atas kepercayaan, tanpa pemungutan suara")}${
        payouts[i] === null || payouts[i] === undefined ? "" : `; <a href="${explorer(dep.dao)}">${t("DAO proposal", "Usulan DAO")} #${esc(payouts[i])}</a>`}</td></tr>`).join(""));
    const src = (ref) => {
      const [kind, id] = ref.split(":");
      return kind === "task" ? `<a href="#task-${esc(id)}">${t("task", "tugas")} #${esc(id)}</a>` : `<a href="${explorer(dep.dao)}">${t("DAO proposal", "Usulan DAO")} #${esc(id)}</a>`;
    };
    rows($("records").tBodies[0], recs.map(([who, rec]) => `<tr><td><a href="${explorer(who)}">${esc(who)}</a></td>
      <td class="num" data-label="${t("Finished", "Selesai")}">${rec.done}</td>
      <td data-label="${t("Trusted", "Dipercaya")}">${rule && trustSources(rec.refs, tasks) >= rule.trusted_after ? t(`yes, up to ${nearAmt(rule.auto_max)} NEAR`, `ya, hingga ${nearAmt(rule.auto_max)} NEAR`) : t("not yet", "belum")}</td>
      <td data-label="${t("Sources", "Sumber")}">${rec.refs.map(src).join(", ")}</td></tr>`).join(""));
  })).catch(() => {
    $("trust-rule").textContent = t("Could not read the task board right now. Reload in a moment.", "Belum bisa membaca papan tugas. Muat ulang sebentar lagi.");
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
    const kept = (id, st) => claims.filter((c) => c.pledge === id && c.status === st).length;
    live(() => {
      const against = (c, what) => {
        const hashes = String(what).match(/\b[0-9a-f]{64}\b/g) ?? [];
        if (!hashes.length) return "";
        return hashes.includes(delivered.get(c.job_id)) ? t(" <strong>(the hash matches the delivered work on the receipt)</strong>", " <strong>(hash ini cocok dengan hasil kerja di tanda terima)</strong>")
          : t(" <strong>(no hash here matches the receipt's delivered work)</strong>", " <strong>(tidak ada hash di sini yang cocok dengan hasil kerja di tanda terima)</strong>");
      };
      const APPEAL = t({ Open: "on appeal: the members vote", Upheld: "appealed: the members overturned it, refunded", Dismissed: "appealed: the members kept the ruling" },
        { Open: "banding: anggota memilih", Upheld: "dibanding: anggota membatalkan putusan, dana dikembalikan", Dismissed: "dibanding: anggota mempertahankan putusan" });
      const proposal = (id) => `<a href="${explorer(dep.dao)}">${t("DAO proposal", "Usulan DAO")} #${esc(id)}</a>`;
      rows($("pledges").tBodies[0], [...pledges].reverse().map((p) => `<tr><td><strong>#${p.id}</strong> ${esc(p.what)}</td>
        <td data-label="${t("By", "Oleh")}"><a href="cert.html?who=${encodeURIComponent(p.issuer)}">${esc(p.issuer)}</a></td>
        <td class="num" data-label="${t("Called in", "Ditagih")}">${p.called} ${t("of", "dari")} ${p.units}</td><td data-label="${t("Kept / broken", "Ditepati / diingkari")}">${kept(p.id, "Honored")} / ${kept(p.id, "Broken")}</td></tr>`).join(""));
      const OUT = t({ Open: "jury out", Upheld: "upheld: refunded", Dismissed: "not upheld" }, { Open: "juri bersidang", Upheld: "dikabulkan: dana dikembalikan", Dismissed: "tidak dikabulkan" });
      rows($("cases").tBodies[0], [...cases].map((c, i) => [c, appeals[i], evidence[i]]).reverse().map(([c, a, ev]) => `<tr><td><strong>#${c.id}</strong> ${t("job", "pekerjaan")} ${esc(c.job_id)}<span class="claim">“${esc(c.reason)}”, ${t(`brought by ${esc(c.claimant)} for ${esc(c.refund_to)}`, `diajukan oleh ${esc(c.claimant)} untuk ${esc(c.refund_to)}`)}</span>${
        ev.map(([by, what]) => `<span class="claim">${by === c.claimant ? t("evidence from the claimant", "bukti dari penggugat") : t("evidence from the steward", "bukti dari pengurus")}: ${esc(what)}${against(c, what)}</span>`).join("")}</td>
        <td class="num" data-label="${t("Refund", "Pengembalian")}">${usdc(c.amount)} USDC</td>
        <td data-label="${t("Jurors", "Juri")}">${c.jurors.map((j) => { const vo = c.votes.find(([x]) => x === j); return `${esc(j)}: ${vo ? (vo[1] ? t("uphold", "kabulkan") : t("reject", "tolak")) : "–"}`; }).join("<br>")}</td>
        <td data-label="${t("Outcome", "Hasil")}">${OUT[c.status] ?? esc(c.status)}${c.refund_proposal !== null ? `; ${proposal(c.refund_proposal)}` : ""}${
          a ? `; ${APPEAL[a.status] ?? esc(a.status)}${a.proposal !== null ? ` (${proposal(a.proposal)})` : ""}` : ""}</td></tr>`).join(""));
      $("standing").innerHTML = members.map(([a], i) => {
        const [x, good] = standing[i];
        return `<li><b><a href="cert.html?who=${encodeURIComponent(a)}">${esc(a)}</a>: ${good ? t("good standing", "status baik") : t("not in good standing", "tidak berstatus baik")}</b>
          <span>${t(`${x.pledges_honored} pledge(s) kept, ${x.pledges_broken} broken; ${x.juries_served} jury ruling(s), ${x.juries_missed} missed${x.slashed ? `; slashed ${x.slashed} time(s)` : ""}`,
            `${x.pledges_honored} janji ditepati, ${x.pledges_broken} diingkari; ${x.juries_served} putusan juri, ${x.juries_missed} terlewat${x.slashed ? `; dipotong ${x.slashed} kali` : ""}`)}</span></li>`;
      }).join("");
      if (info.steward && ends) $("audit-term").innerHTML = t(`The steward serves ${days} days by the members' vote, until <strong>${date(ends)}</strong>; then anyone can end the term and the role waits for a new vote.`,
        `Pengurus menjabat ${days} hari berdasarkan pemungutan suara anggota, sampai <strong>${date(ends)}</strong>; setelah itu siapa pun bisa mengakhiri masa jabatannya dan peran itu menunggu pemungutan suara baru.`);
    });
  }).catch(() => {
    // a failed read is not an empty record: say so (rows("") would print "Nothing yet.")
    for (const id of ["pledges", "cases"]) {
      $(id).tBodies[0].innerHTML = `<tr><td colspan="4" class="muted">${t("Could not read this from NEAR right now (a busy public RPC). Reload to try again.", "Belum bisa membaca ini dari NEAR (RPC publik sedang sibuk). Muat ulang untuk mencoba lagi.")}</td></tr>`;
    }
  });
  if (dep.chainSignatures) live(() => {
    const c = dep.chainSignatures;
    const vote = (tx, id) => `<a href="${txUrl(tx)}">${t("vote", "suara")} #${esc(id)}</a>`;
    const tr = c.transfer, it = dep.intents;
    const paidOut = (it?.payouts ?? []).filter((p) => p.status === "SUCCESS").map((p) => {
      const where = p.chain === "base" && p.destination_tx ? t(`on Base Sepolia (<a href="https://sepolia.basescan.org/tx/${esc(p.destination_tx)}">the transaction</a>)`, `di Base Sepolia (<a href="https://sepolia.basescan.org/tx/${esc(p.destination_tx)}">transaksinya</a>)`)
        : p.tx ? t(`on NEAR (<a href="${txUrl(p.tx)}">the transaction</a>)`, `di NEAR (<a href="${txUrl(p.tx)}">transaksinya</a>)`) : "";
      return t(` It paid ${esc(p.amount)} USDC to ${esc(p.to)} ${where}.`, ` Dompet ini membayar ${esc(p.amount)} USDC ke ${esc(p.to)} ${where}.`);
    }).join("");
    const addr = `<a href="https://sepolia.etherscan.io/address/${esc(c.address)}"><code>${esc(c.address)}</code></a>`, signer = `<a href="${explorer(c.signer)}">${esc(c.signer)}</a>`;
    const ethTx = tr ? `<a href="https://sepolia.etherscan.io/tx/${esc(tr.hash)}">${t("the Ethereum transaction", "transaksi Ethereum-nya")}</a>` : "";
    $("multichain").innerHTML = t(`The co-op also holds an Ethereum address, ${addr}, with no private key anywhere:
      NEAR's MPC network (${signer}) signs for it only when the DAO asks, by a members' vote.
      Proof: the statement signed by ${vote(c.tx, c.proposal)} recovers to this address (<code>npm run chainsig</code>).${tr ? `
      And it pays on Ethereum by vote: ${vote(tr.tx, tr.proposal)} had it sign a transfer of ${esc(tr.eth)} Sepolia ETH to ${esc(tr.to.slice(0, 10))}…${tr.toNote ? `, ${esc(tr.toNote)}` : ""} (${ethTx}${tr.sent ? "" : ", sent once the address holds Sepolia ETH for gas"}).` : ""}${it ? `
      The same address owns the agent's NEAR Intents wallet (<code>${esc(it.agent_id)}</code>, on Tidepool's testnet mirror of the Intents Agent API): the DAO created it by ${vote(it.created.tx, it.created.proposal)}${it.grant ? ` and let the agent act by ${vote(it.grant.tx, it.grant.proposal)}` : ""}. Its policy pays only members, at most 5 USDC a payment and $10 a day, each payout held 10 minutes like the veto window; changing it takes another vote.${paidOut}` : ""}`,
    `Koperasi juga memegang alamat Ethereum, ${addr}, tanpa kunci privat di mana pun:
      jaringan MPC NEAR (${signer}) menandatangani untuknya hanya saat DAO meminta, lewat pemungutan suara anggota.
      Buktinya: pernyataan yang ditandatangani lewat ${vote(c.tx, c.proposal)} terpulihkan ke alamat ini (<code>npm run chainsig</code>).${tr ? `
      Dan alamat ini membayar di Ethereum lewat pemungutan suara: ${vote(tr.tx, tr.proposal)} memintanya menandatangani transfer ${esc(tr.eth)} ETH Sepolia ke ${esc(tr.to.slice(0, 10))}…${tr.toNote ? `, ${esc(tr.toNote)}` : ""} (${ethTx}${tr.sent ? "" : ", dikirim setelah alamat ini punya ETH Sepolia untuk gas"}).` : ""}${it ? `
      Alamat yang sama memiliki dompet NEAR Intents milik agen (<code>${esc(it.agent_id)}</code>, di cermin testnet Tidepool untuk Intents Agent API): DAO membuatnya lewat ${vote(it.created.tx, it.created.proposal)}${it.grant ? ` dan mengizinkan agen bertindak lewat ${vote(it.grant.tx, it.grant.proposal)}` : ""}. Kebijakannya hanya membayar anggota, paling banyak 5 USDC per pembayaran dan $10 sehari, setiap pembayaran ditahan 10 menit seperti masa veto; mengubahnya perlu pemungutan suara lagi.${paidOut}` : ""}`);
  });
  live(() => rows($("periods").tBodies[0], [...periods].reverse().map((p) => `<tr>
      <td>${t("Share", "SHU")} ${p.id}</td><td data-label="${t("Date", "Tanggal")}">${date(p.ts)}</td>
      <td class="num" data-label="${t("Shared", "Dibagi")}">${usdc(BigInt(p.amount) - BigInt(p.reserve))}</td>
      <td class="num" data-label="${t("Reserve", "Cadangan")}">${usdc(p.reserve)}</td>
      <td class="num" data-label="${t("Members", "Anggota")}">${p.members}</td></tr>`).join("")));

  if (!moved) hold(); // the first deep link, held from when the data arrives (the stick is set up above the try)
} catch (e) {
  console.error(e);
  const unreachable = t("Could not reach NEAR right now. Reload in a moment.", "Belum bisa terhubung ke NEAR. Muat ulang sebentar lagi.");
  for (const id of ["ck-bylaws", "ck-code", "ck-money"]) verdict(id, null, unreachable);
  rows($("passbook").tBodies[0], `<tr><td colspan="3">${t(`Could not read ${esc(dep.contract)} on ${esc(dep.network)}. Check your connection and reload.`, `Gagal membaca ${esc(dep.contract)} di ${esc(dep.network)}. Periksa koneksi Anda dan muat ulang.`)}</td></tr>`);
  $("p-voters").innerHTML = `<li class="no">${unreachable}</li>`;
  const no = t("not read: NEAR could not be reached; reload in a moment", "belum terbaca: NEAR tidak bisa dihubungi; muat ulang sebentar lagi");
  for (const id of ["codegov", "trust-rule", "pb-id", "p-agent"]) if ($(id)) $(id).textContent = no;
  document.querySelectorAll("#status dd, #counts dd, #counts strong").forEach((el) => { if (el.textContent.trim() === "…") el.textContent = "–"; });
  if (!teeState.model) { teeState.failed = true; drawTee(); }
}

function armTeeCheck(model) {
  const btn = $("ck-tee-run");
  const out = $("ck-tee-out");
  teeState.model = model;
  btn.disabled = false;
  drawTee();
  btn.onclick = async () => {
    btn.disabled = true;
    teeState.busy = true;
    verdict("ck-tee", null, "");
    const step = (s) => { out.innerHTML = `<p class="hint">${esc(s)}</p>`; };
    teeState.result = await verifyInBrowser(model, step);
    teeState.busy = false;
    btn.disabled = false;
    drawTee();
  };
}

// attacks sent to the live co-op as real transactions (scripts/redteam.mjs): each is read back here and must have failed
// on-chain with the refusal it was saved with, so the list cannot claim a refusal the chain does not show
if (dep.redteam?.length) {
  Promise.all(dep.redteam.map((r) => txStatus(r.tx, r.by).then((t) => {
    const failure = JSON.stringify(t?.status?.Failure ?? t?.receipts_outcome?.map((o) => o.outcome.status.Failure).find(Boolean) ?? null);
    return failure !== "null" && failure.includes(JSON.stringify(r.error.slice(0, 60)).slice(1, -1));
  }, () => null))).then((res) => live(() => {
    const refused = res.filter((x) => x === true).length;
    const unread = res.filter((x) => x === null).length;
    // what each attack was (r.what) is the record's own words, kept as written
    verdict("ck-attacks", unread ? null : refused === res.length, `${t(`${refused} of ${res.length} attacks on this co-op failed on-chain with the contract's or the DAO's own refusal${unread ? ` (${unread} not readable right now)` : ""}.`,
      `${refused} dari ${res.length} serangan ke koperasi ini gagal on-chain karena ditolak oleh kontrak atau DAO itu sendiri${unread ? ` (${unread} belum bisa dibaca)` : ""}.`)}
      <details><summary>${t("What was tried", "Apa saja yang dicoba")}</summary><ul class="attacks">${dep.redteam.map((r, i) => `<li>${res[i] === true ? t("refused", "ditolak") : res[i] === null ? t("not read", "belum terbaca") : t("<strong>NOT REFUSED</strong>", "<strong>TIDAK DITOLAK</strong>")}: ${esc(r.what)}
        <span class="claim">“${esc(r.error.slice(0, 90))}” <a href="${txUrl(r.tx)}">tx</a></span></li>`).join("")}</ul></details>`);
  }));
} else {
  $("ck-attacks").hidden = true;
}

// the annual members' meeting (scripts/rat.mjs): the report the agent wrote in a TEE from the chain's facts, approved by vote
const lastRat = dep.rat?.at(-1);
if (lastRat) live(() => {
  $("rat").hidden = false;
  const report = (s) => `<a href="${esc(lastRat.report)}">${s}</a>`, facts = (s) => `<a href="${esc(lastRat.facts)}">${s}</a>`;
  const vote = `<a href="${explorer(dep.dao)}">${t("DAO vote", "pemungutan suara DAO")} #${esc(lastRat.proposal)}</a>`, sha = `sha256 ${esc(lastRat.report_sha256.slice(0, 12))}…`;
  $("rat").innerHTML = t(`<b>Annual members' meeting ${esc(lastRat.year)}.</b> The co-op's agent wrote the ${report("accountability report")}
    inside a TEE from ${facts("the facts read from the chain")}; the members approved exactly those bytes by ${vote} (${sha}).`,
  `<b>Rapat anggota tahunan ${esc(lastRat.year)}.</b> Agen koperasi menulis ${report("laporan pertanggungjawaban")}
    di dalam TEE dari ${facts("fakta yang dibaca dari chain")}; anggota menyetujui persis isi itu lewat ${vote} (${sha}).`);
});

// contract 0.2.9: the agent as a defendant, the mandatory dues, and this year's agenda
Promise.all([view(dep.contract, "get_agent_standing"), view(dep.contract, "get_dues"), view(dep.contract, "get_agenda", { year: new Date().getUTCFullYear() }),
  view(dep.contract, "get_share_funds").catch(() => []), view(dep.contract, "get_loan_rule").catch(() => null),
  // 0.3.2 and 0.3.3 (older contracts: nothing shown)
  view(dep.contract, "get_agent_member").catch(() => null), view(dep.contract, "get_risk_fund").catch(() => null),
  view(dep.contract, "get_reputation_share").catch(() => 0)])
  .then(([agent, dues, agenda, funds, loans, member, risk, repBps]) => live(() => {
    const n = agent.strikes.length;
    const parts = [t(`<b>The agent answers to the court.</b> ${n
      ? `${n} case(s) upheld against its jobs in 90 days (${agent.strikes.map(([id]) => `#${esc(id)}`).join(", ")}): its daily inference budget is divided by ${2 ** n}`
      : agent.reinstated_at ? `No case counts against it now: the members reinstated it on ${new Date(Number(agent.reinstated_at) / 1e6).toISOString().slice(0, 10)}, and cases upheld before that no longer count` : "No case upheld against its jobs in 90 days"}${agent.suspended ? "; <strong>suspended</strong> until the members reinstate it" : "; at 3 the contract suspends it"}.`,
    `<b>Agen tunduk pada pengadilan.</b> ${n
      ? `${n} perkara dikabulkan atas pekerjaannya dalam 90 hari (${agent.strikes.map(([id]) => `#${esc(id)}`).join(", ")}): anggaran inferensi hariannya dibagi ${2 ** n}`
      : agent.reinstated_at ? `Tidak ada perkara yang berlaku sekarang: anggota memulihkannya pada ${new Date(Number(agent.reinstated_at) / 1e6).toISOString().slice(0, 10)}, dan perkara sebelum itu tidak lagi dihitung` : "Tidak ada perkara yang dikabulkan atas pekerjaannya dalam 90 hari"}${agent.suspended ? "; <strong>diskors</strong> sampai anggota memulihkannya" : "; pada perkara ke-3 kontrak menskorsnya"}.`)];
    if (dues && BigInt(dues.amount) > 0n) parts.push(t(`<b>Mandatory dues:</b> ${nearAmt(dues.amount)} NEAR every ${esc(dues.every_days)} days into the treasury, voted by the members; 7 days behind and a member loses good standing.`,
      `<b>Simpanan wajib:</b> ${nearAmt(dues.amount)} NEAR setiap ${esc(dues.every_days)} hari ke kas, diputuskan oleh anggota; terlambat 7 hari dan anggota kehilangan status baik.`));
    // contract 0.3.0: funds from the surplus, and the savings-and-loan fund
    if (funds.length) parts.push(t(`<b>Funds from every profit share:</b> ${funds.map((f) => `${esc(f.name)} ${f.bps / 100}% to <a href="${explorer(f.to)}">${esc(f.to)}</a>`).join("; ")}, out of the reserve.`,
      `<b>Dana dari setiap pembagian SHU:</b> ${funds.map((f) => `${esc(f.name)} ${f.bps / 100}% ke <a href="${explorer(f.to)}">${esc(f.to)}</a>`).join("; ")}, diambil dari dana cadangan.`));
    if (loans) parts.push(t(`<b>Savings and loans:</b> a member in good standing with a guarantor borrows up to ${nearAmt(loans[0].max_loan)} NEAR for ${esc(loans[0].term_days)} days at ${loans[0].rate_bps / 100}% flat; the fund can lend ${nearAmt(loans[1])} NEAR now. A late loan costs the borrower and their guarantors good standing.`,
      `<b>Simpan pinjam:</b> anggota berstatus baik dengan penjamin bisa meminjam hingga ${nearAmt(loans[0].max_loan)} NEAR selama ${esc(loans[0].term_days)} hari dengan bunga flat ${loans[0].rate_bps / 100}%; dana bisa meminjamkan ${nearAmt(loans[1])} NEAR sekarang. Pinjaman yang terlambat membuat peminjam dan penjaminnya kehilangan status baik.`));
    if (member && (member.share_bps || risk)) parts.push(t(`<b>The agent is a member too.</b> It gets ${member.share_bps / 100}% of every profit share, scaled by its standing (now ${member.standing_bps / 100}%: halved for each upheld case), into the risk fund that refunds its mistakes at once: ${risk ? `${usdc(risk[0])} USDC there now, it saves ${risk[1] / 100}% of its earnings` : ""}; ${usdc(member.shu_total)} USDC from its shares so far.`,
      `<b>Agen juga anggota.</b> Ia mendapat ${member.share_bps / 100}% dari setiap pembagian SHU, disesuaikan dengan statusnya (kini ${member.standing_bps / 100}%: separuh untuk setiap perkara yang dikabulkan), masuk ke dana risiko yang langsung mengganti kesalahannya: ${risk ? `kini ${usdc(risk[0])} USDC di sana, ia menyisihkan ${risk[1] / 100}% dari pendapatannya` : ""}; ${usdc(member.shu_total)} USDC dari bagian SHU-nya sejauh ini.`));
    if (repBps) parts.push(t(`<b>Reputation dividend:</b> ${repBps / 100}% of every profit share is split among members in good standing by their work since the last one (finished tasks, pledges kept, juries served), plus half their last weight.`,
      `<b>Dividen reputasi:</b> ${repBps / 100}% dari setiap pembagian SHU dibagi di antara anggota berstatus baik menurut kerja mereka sejak pembagian sebelumnya (tugas selesai, janji ditepati, tugas juri), ditambah separuh bobot terakhir mereka.`));
    // the agent's proposals and the federation's ceiling have their own cards below (#card-proposal, #card-credit)
    if (agenda.length) parts.push(`<b>${t("This year's agenda:", "Agenda tahun ini:")}</b> ${agenda.map(([by, item]) => `“${esc(item)}” (${esc(by.split(".")[0])})`).join("; ")}.`);
    $("duties").hidden = false;
    $("duties").innerHTML = parts.join("<br>");
  }), () => {});


// Newest, read from the chain: one card each. A card whose reads fail stays hidden.
const card = (id, html) => { $(id).querySelector(".card-out").innerHTML = html; $(id).hidden = false; };
const day = (ns) => new Date(Number(BigInt(ns) / 1_000_000n)).toLocaleDateString(t("en-GB", "id-ID"), { day: "numeric", month: "short", year: "numeric" });
const GITHUB = "https://github.com/PugarHuda/koperasi/blob/main/";

// the Shade Agent: a worker whose key was made in a Phala TDX VM, attested by the registry the DAO owns
const tee = dep.tee;
if (tee) {
  Promise.all([view(tee.registry, "get_agent", { account_id: tee.worker }), view(tee.registry, "get_contract_info"),
    view(dep.contract, "get_agent_tee", { account_id: tee.worker }), view(dep.contract, "get_receipt_agent", { job_id: tee.receipt })])
    .then(([att, [owner], [teeOnly, held], recAgent]) => {
      if (!att || !held) throw new Error("not attested");
      const holds = BigInt(att.valid_until) > BigInt(Date.now()) * 1_000_000n;
      live(() => {
        const worker = `<a href="${explorer(tee.worker)}"><code>${esc(short(tee.worker))}</code></a>`, provider = esc(tee.cvm?.provider ?? "Phala Cloud");
        const registry = `<a href="${explorer(tee.registry)}">${esc(tee.registry)}</a>`, ownerName = owner === dep.dao ? t("the co-op's DAO", "DAO koperasi") : `<code>${esc(owner)}</code>`;
        const approve = `<a href="${explorer(dep.dao)}">${t("DAO proposal", "usulan DAO")} #${esc(tee.approve)}</a>`, until = esc(day(att.valid_until));
        const gate = `(<a href="${txUrl(tee.gate)}">tx ${esc(short(tee.gate))}</a>)`, receipt = `<code>${esc(short(tee.receipt))}</code>`;
        const compose = `<code>${esc(short(att.compose_hash))}</code>, <a href="${GITHUB}${esc(tee.compose)}">${esc(tee.compose)}</a>`, ppid = `<code>${esc(short(att.ppid))}</code>`;
        card("card-tee", t(`<p>Worker ${worker}: its key was made inside an Intel TDX VM (${provider}). Its quote was checked on-chain by ${registry}, owned by ${ownerName}.</p>
          <ul><li>Code (compose hash) ${compose}</li>
          <li>Machine (PPID) ${ppid}</li>
          <li>Attestation ${holds ? "holds until" : "ran out on"} ${until}</li></ul>
          <p>The members approved this code and machine by ${approve} and admitted the worker
          ${teeOnly ? "TEE-only" : ""} by #${esc(tee.admit)}: its receipts count only while the attestation holds.
          ${recAgent === tee.worker ? `It recorded receipt ${receipt} from inside the TEE, after the by-laws gate in the OutLayer enclave ${gate}.` : ""}</p>
          <p class="muted">The VM was stopped after its job to save cost; the attestation and the receipt stay on-chain.</p>`,
        `<p>Worker ${worker}: kuncinya dibuat di dalam VM Intel TDX (${provider}). Quote-nya diperiksa on-chain oleh ${registry}, milik ${ownerName}.</p>
          <ul><li>Kode (compose hash) ${compose}</li>
          <li>Mesin (PPID) ${ppid}</li>
          <li>Atestasi ${holds ? "berlaku sampai" : "habis pada"} ${until}</li></ul>
          <p>Anggota menyetujui kode dan mesin ini lewat ${approve} dan menerima worker ini
          ${teeOnly ? "(hanya TEE)" : ""} lewat #${esc(tee.admit)}: tanda terimanya hanya dihitung selama atestasinya berlaku.
          ${recAgent === tee.worker ? `Worker ini mencatat tanda terima ${receipt} dari dalam TEE, setelah pemeriksaan anggaran dasar di enclave OutLayer ${gate}.` : ""}</p>
          <p class="muted">VM-nya dihentikan setelah pekerjaannya untuk menghemat biaya; atestasi dan tanda terimanya tetap on-chain.</p>`));
      });
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
  // the agent's evaluation (its own words, on-chain record) stays as written
  live(() => card("card-proposal", `<p>${t(`The agent read its own record in a TEE (${esc(file.model ?? "the voted model")}) and proposed by-laws v${esc(p.version)}:`,
    `Agen membaca catatannya sendiri di dalam TEE (${esc(file.model ?? "model yang dipilih")}) dan mengusulkan anggaran dasar v${esc(p.version)}:`)}</p>
    ${file.evaluation ? `<blockquote>“${esc(file.evaluation)}”</blockquote>` : ""}
    ${diff ? `<ul>${diff}</ul>` : ""}
    <p><a href="${explorer(dep.dao)}">${t("DAO proposal", "Usulan DAO")} #${esc(p.proposal)}</a>: ${esc(dao.status)}.
    ${file.factsSha ? `${t("The facts it read", "Fakta yang dibacanya")}: <a href="agent-proposals/v${Number(p.version)}.facts.json">sha256 ${esc(file.factsSha.slice(0, 12))}…</a>.` : ""}</p>
    ${cfg.version > p.version ? `<p class="note">${t(`Since then the members voted by-laws v${esc(cfg.version)}${cfg.contributor && cfg.contributor !== dep.agent ? `, proposed by ${esc(cfg.contributor)}` : ""}: that is what the agent runs now.${p.version === 9 && cfg.version === 10 ? " v9 had cut the price from an average that counted a Taskbond job, paid in testnet NEAR, as a 0 USDC sale; v10 restored v8." : ""}`,
      `Sejak itu anggota memilih anggaran dasar v${esc(cfg.version)}${cfg.contributor && cfg.contributor !== dep.agent ? `, diusulkan oleh ${esc(cfg.contributor)}` : ""}: itulah yang kini dijalankan agen.${p.version === 9 && cfg.version === 10 ? " v9 memotong harga berdasarkan rata-rata yang menghitung satu pekerjaan Taskbond, dibayar dengan NEAR testnet, sebagai penjualan 0 USDC; v10 mengembalikan v8." : ""}`)}</p>` : ""}
    ${list.length > 1 ? `<p class="muted">${t(`${list.length - 1} earlier proposal(s) by the agent, each put to a members' vote.`, `${list.length - 1} usulan agen sebelumnya, masing-masing diputuskan lewat pemungutan suara anggota.`)}</p>` : ""}`));
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
    live(() => {
      const vote = (id, p) => `<a href="${explorer(dep.dao)}">${t("DAO proposal", "Usulan DAO")} #${esc(id)}</a>: ${esc(p.status)}`;
      const badBy = `<code>${esc(bad.contributor ?? "")}</code>`, fixBy = `<code>${esc(fix.contributor ?? "")}</code>`;
      // review.rejected.why and review.note are the recorded reasons, kept as written
      card("card-errors", t(`<p>On ${esc(day(bad.activated_at))} the agent proposed by-laws v${BAD_V} (by ${badBy}) and the members passed it
        (${vote(BAD_P, badP)}). It was wrong: the agent cut its price from an average that counted a Taskbond job, paid in testnet NEAR, as a 0 USDC sale.</p>
        <p>On ${esc(day(fix.activated_at))} a member, ${fixBy}, proposed v${FIX_V} to restore v8, and the members passed it
        (${vote(FIX_P, fixP)}).</p>
        ${review ? `<p>The agent also writes its own annual review for the members' meeting. Its first draft was turned down (${vote(review.rejected.proposal, rejP)}):
        ${esc(review.rejected.why)}. <a href="${esc(review.rejected.report)}">The rejected draft</a>.
        A corrected one was accepted (${vote(review.proposal, okP)}): <a href="${esc(review.report)}">the review</a>, from <a href="${esc(review.facts)}">the facts read from the chain</a>.</p>
        ${review.note ? `<p class="muted">Accepted ${esc(review.note.replace(/^accepted /, ""))}.</p>` : ""}` : ""}`,
      `<p>Pada ${esc(day(bad.activated_at))} agen mengusulkan anggaran dasar v${BAD_V} (oleh ${badBy}) dan anggota meloloskannya
        (${vote(BAD_P, badP)}). Usulan itu keliru: agen memotong harganya berdasarkan rata-rata yang menghitung satu pekerjaan Taskbond, dibayar dengan NEAR testnet, sebagai penjualan 0 USDC.</p>
        <p>Pada ${esc(day(fix.activated_at))} seorang anggota, ${fixBy}, mengusulkan v${FIX_V} untuk mengembalikan v8, dan anggota meloloskannya
        (${vote(FIX_P, fixP)}).</p>
        ${review ? `<p>Agen juga menulis tinjauan tahunannya sendiri untuk rapat anggota. Draf pertamanya ditolak (${vote(review.rejected.proposal, rejP)}):
        ${esc(review.rejected.why)}. <a href="${esc(review.rejected.report)}">Draf yang ditolak</a>.
        Versi yang diperbaiki diterima (${vote(review.proposal, okP)}): <a href="${esc(review.report)}">tinjauannya</a>, dari <a href="${esc(review.facts)}">fakta yang dibaca dari chain</a>.</p>
        ${review.note ? `<p class="muted">Diterima ${esc(review.note.replace(/^accepted /, ""))}.</p>` : ""}` : ""}`));
    });
  }, () => {});

// the credit bureau: a federation of co-ops sets the loan ceiling; a stamp from a sister co-op counts as credit here
const CAROL = "kop-carol-mw80aczw.testnet";
Promise.all([view(dep.contract, "get_federation"), view(dep.contract, "get_sister_coops"), view(dep.contract, "get_loan_rule"),
  view(dep.contract, "get_credit", { account_id: CAROL }), view(dep.contract, "get_passport", { account_id: CAROL })])
  .then(([[fedDao, ceil], sisters, rule, [score], passport]) => {
    if (!ceil) return;
    const refused = dep.v033?.federation?.refused;
    const stamp = passport?.[0];
    live(() => {
      const fed = `<a href="${explorer(fedDao)}">${esc(fedDao.split(".")[0])}</a>`, cap = `<strong>${ceil.max_rate_bps / 100}%</strong>`;
      const prop = refused ? `<a href="${explorer(dep.dao)}">${t("DAO proposal", "usulan DAO")} #${esc(refused.proposals[0])}</a>` : "";
      const carol = `<a href="cert.html?who=${CAROL}">${esc(CAROL)}</a>`, sc = `<strong>${esc(score)}</strong>`, by = stamp ? `<code>${esc(stamp.coop)}</code>` : "";
      card("card-credit", t(`<p>The federation ${fed}, voted by both co-ops, caps loans at ${cap} for ${esc(ceil.max_term_days)} days, in the contract's code.
        ${refused ? `The members here voted ${refused.rate_bps / 100}% loans (${prop});
        the contract refused it, and the loan rule is still ${rule ? `${rule[0].rate_bps / 100}%` : "unchanged"}.` : ""}</p>
        <p>${sisters.length} sister co-op(s) share credit. ${carol} has credit score ${sc} here
        ${stamp ? `from a stamp by ${by} (${esc(stamp.done)} jobs finished there)` : ""}.</p>
        <p class="muted">A loan called late here is told to the sister co-ops: the borrower's credit is 0 at all of them until it is repaid.</p>`,
      `<p>Federasi ${fed}, yang dipilih oleh kedua koperasi, membatasi bunga pinjaman paling tinggi ${cap} untuk ${esc(ceil.max_term_days)} hari, di dalam kode kontrak.
        ${refused ? `Anggota di sini memilih pinjaman ${refused.rate_bps / 100}% (${prop});
        kontrak menolaknya, dan aturan pinjaman tetap ${rule ? `${rule[0].rate_bps / 100}%` : "tidak berubah"}.` : ""}</p>
        <p>${sisters.length} koperasi saudara berbagi data kredit. ${carol} punya skor kredit ${sc} di sini
        ${stamp ? `dari cap oleh ${by} (${esc(stamp.done)} pekerjaan selesai di sana)` : ""}.</p>
        <p class="muted">Pinjaman yang dinyatakan terlambat di sini diberitahukan ke koperasi saudara: kredit peminjam menjadi 0 di semuanya sampai dilunasi.</p>`));
    });
  }, () => {});
