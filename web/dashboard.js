// The member dashboard: one view per sidebar item (#/overview, #/membership…). Each view reads the chain the first time
// it is opened (near.js keeps a read 30 s, so views share them); a block whose reads fail is hidden. The wallet panel is
// wallet.js itself, rendered into #joinapp; the proposals view votes through its vote(). Every word of the dashboard's
// own is in English and Bahasa Indonesia (t(en, id)); what the chain says (descriptions, reasons, ids) stays as it is.
import { dep, view, all, query, txStatus, explorer, txUrl, RAW, $, esc, usdc, nearAmt } from "./near.js";
import { t } from "./lang.js";
import { byLawsPath } from "./share.js";
// the wallet panel (and its wallet connector) loads beside the views, so a slow wallet module never holds them back
const wallet = import("./wallet.js");

const C = dep.contract;
const D = dep.dao;
const date = (ns) => new Date(Number(BigInt(ns) / 1_000_000n)).toLocaleDateString(t("en-GB", "id-ID"), { day: "numeric", month: "short", year: "numeric" });
const short = (h) => `${String(h).slice(0, 10)}…`;
const oneLine = (s, n) => String(s).replace(/\s+/g, " ").slice(0, n);
const table = (head, rows) => (rows.length
  ? `<div class="scroll" tabindex="0" role="region" aria-label="${esc(head[0])} ${t("table", "tabel")}"><table class="grid"><thead><tr>${head.map((h) => `<th scope="col">${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`
  : `<p class="muted">${t("Nothing yet.", "Belum ada.")}</p>`);
// the chain's status words, in Indonesian when the page is
const STATUS = { Paid: "Dibayar", Submitted: "Diserahkan", Disputed: "Disengketakan", Refunded: "Dikembalikan", Approved: "Disetujui", Rejected: "Ditolak",
  InProgress: "Berjalan", Expired: "Kedaluwarsa", Removed: "Dihapus", Failed: "Gagal", Moved: "Dipindah", Upheld: "Dikabulkan", Dismissed: "Ditolak",
  Open: "Terbuka", Accepted: "Diterima", Honored: "Ditepati", Broken: "Diingkari", Repaid: "Lunas", Late: "Terlambat", Active: "Berjalan", Approve: "setuju", Reject: "tolak", Remove: "hapus" };
const word = (s) => t(String(s), STATUS[s] ?? String(s));
const plural = (n, en, id) => `${n} ${t(n === 1 ? en : `${en}s`, id)}`;

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
  el.querySelector(".out").innerHTML = `<p class="muted">${t("Reading NEAR…", "Membaca NEAR…")}</p>`;
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
      ...recs.map((r) => ({ ts: r.ts, html: `${t("Job", "Pekerjaan")} <code>${esc(short(r.job_id))}</code>: ${usdc(r.price)} USDC ${t("under by-laws", "dengan anggaran dasar")} v${esc(r.config_version)}, <span class="badge ${esc(r.status)}">${esc(word(r.status))}</span>` })),
      ...props.map((p) => ({ ts: p.submission_time, html: `${t("DAO proposal", "Usulan DAO")} #${esc(p.id)} ${t("by", "oleh")} ${esc(p.proposer)}: ${esc(oneLine(p.description, 110))} <span class="muted">(${esc(word(p.status))})</span>` })),
    ].sort((a, b) => (BigInt(b.ts) > BigInt(a.ts) ? 1 : -1));
    return `<ul class="feed">${items.map((i) => `<li><time>${date(i.ts)}</time><span>${i.html}</span></li>`).join("")}</ul>`;
  });
  try {
    const [info, audit, last, treasury] = await retried(() => Promise.all([view(C, "get_info"), view(C, "get_audit"), view(D, "get_last_proposal_id"),
      view(dep.usdc, "ft_balance_of", { account_id: D })]));
    const owed = BigInt(audit.owed);
    $("net").innerHTML = `${t("Read now from NEAR", "Dibaca sekarang dari NEAR")} ${esc(dep.network)}: <a href="${explorer(C)}">${esc(C)}</a> ${t("and its DAO", "dan DAO-nya")} <a href="${explorer(D)}">${esc(D)}</a>.`;
    $("kpis").innerHTML = [
      [t("Members", "Anggota"), Number(info.members), t("one vote each", "masing-masing satu suara")],
      [t("DAO proposals", "Usulan DAO"), Number(last), t("every decision on record", "setiap keputusan tercatat")],
      [t("Treasury", "Kas"), `${usdc(treasury)} <small>USDC</small>`, t("spent only by a vote", "dibelanjakan hanya lewat pemungutan suara")],
      ["Audit", owed > 0n ? t("Red", "Merah") : t("Green", "Hijau"), owed > 0n ? t(`${usdc(owed)} USDC not passed on`, `${usdc(owed)} USDC belum diteruskan`) : t("every payment passed on", "setiap pembayaran diteruskan"), owed > 0n ? "warn" : "ok"],
      [t("Jobs", "Pekerjaan"), Number(info.receipts), t("receipts on-chain", "tanda terima on-chain")],
      [t("Agent", "Agen"), info.paused ? t("Paused", "Dihentikan") : t("Working", "Bekerja"), `${t("by-laws", "anggaran dasar")} v${esc(info.config.version)}`, info.paused ? "warn" : "ok"],
      [t("Profit shares", "Pembagian SHU"), Number(info.periods), t("voted, split by rule", "diputuskan, dibagi menurut aturan")],
    ].map(([k, v, s, c = ""]) => `<div class="${c}"><dt>${k}</dt><dd>${v}</dd><small>${s}</small></div>`).join("");
  } catch (e) {
    $("net").textContent = t(`Could not read NEAR right now (${e.message.slice(0, 80)}). Reload in a moment.`, `NEAR tidak bisa dibaca sekarang (${e.message.slice(0, 80)}). Muat ulang sebentar lagi.`);
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
      if (p.votes?.[me]) return `<em>${t("you voted", "Anda memilih")} ${esc(word(p.votes[me]).toLowerCase())}</em>`;
      if (opaque(p)) return `<a class="small-link" href="${explorer(D)}">${t("Inspect in the DAO to vote", "Periksa di DAO untuk memilih")}</a>`;
      return `<span class="vote-btns"><button type="button" class="btn small" data-v="VoteApprove" data-id="${p.id}">${t("Approve", "Setuju")}</button>
        <button type="button" class="btn ghost small" data-v="VoteReject" data-id="${p.id}">${t("Reject", "Tolak")}</button></span>`;
    };
    list.innerHTML = (open.length ? open.map((p) => `<li><span><strong>#${esc(p.id)}</strong> <span class="claim">${t("by", "oleh")} ${esc(p.proposer)}; ${yes(p)} ${t("of", "dari")} ${needed} ${t("approvals needed", "persetujuan yang diperlukan")}</span>
        <pre class="does">${esc(safeDescribe(p))}</pre>${p.description ? `<span class="claim">${t("Proposer says", "Kata pengusul")}: “${esc(String(p.description).slice(0, 200))}”</span>` : ""}</span>${action(p)}</li>`).join("")
      : `<li>${t("Nothing to vote on right now.", "Belum ada yang perlu dipilih.")}</li>`)
      + `<li class="sub-h"><b>${t("Recently decided", "Baru diputuskan")}</b></li>`
      + decided.map((p) => `<li><span><strong>#${esc(p.id)}</strong> ${esc(oneLine(p.description, 140))}</span><span class="badge">${esc(word(p.status))}</span></li>`).join("");
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
    list.innerHTML = `<li>${t("Could not read the DAO's proposals right now", "Usulan DAO tidak bisa dibaca sekarang")} (${esc(e.message.slice(0, 80))}). ${t("Reload in a moment.", "Muat ulang sebentar lagi.")}</li>`;
  }
}

async function agent() {
  pane("a-bylaws", async () => {
    const { c, hex, text } = await byLaws();
    const get = (re) => esc(text?.match(re)?.[1]?.trim() ?? "?");
    return `<dl class="terms dark">
        <div><dt>${t("Version", "Versi")}</dt><dd>${t("by-laws", "anggaran dasar")} v${esc(c.version)}</dd></div>
        <div><dt>${t("Since", "Sejak")}</dt><dd>${date(c.activated_at)}${c.contributor ? `, ${t("proposed by", "diusulkan oleh")} ${esc(c.contributor)}` : ""}</dd></div>
        <div class="wide"><dt>${t("Hash the members voted", "Hash yang dipilih anggota")}</dt><dd><code>${esc(c.hash)}</code></dd></div>
        ${hex === c.hash ? `<div><dt>${t("Price per job", "Harga per pekerjaan")}</dt><dd>${get(/^\s+price_usdc:\s*([\d.]+)/m)} USDC</dd></div>
        <div><dt>${t("AI spend cap", "Batas belanja AI")}</dt><dd>$${get(/max_inference_per_job_usd:\s*([\d.]+)/)} ${t("a job", "per pekerjaan")}, $${get(/max_inference_per_day_usd:\s*([\d.]+)/)} ${t("a day", "per hari")}</dd></div>
        <div class="wide"><dt>Model</dt><dd>${get(/^model:\s*"?([^"\n]+)/m)}</dd></div>` : ""}</dl>
      <p class="small">${hex === null ? t("The by-laws file could not be downloaded to check it here.", "Berkas anggaran dasar tidak bisa diunduh untuk diperiksa di sini.")
        : hex === c.hash ? t(`Your browser hashed <a href="${esc(RAW + c.uri)}">${esc(c.uri)}</a>: it is exactly the file the members approved.`,
          `Browser Anda menghitung hash <a href="${esc(RAW + c.uri)}">${esc(c.uri)}</a>: persis berkas yang disetujui anggota.`)
          : t(`<strong>The published file does not match</strong> the approved hash (it hashes to ${esc(short(hex))}).`,
            `<strong>Berkas yang diterbitkan tidak cocok</strong> dengan hash yang disetujui (hash-nya ${esc(short(hex))}).`)}</p>`;
  });
  const tee = dep.tee;
  if (tee) {
    pane("a-tee", async () => {
      const [att, [owner], [teeOnly, held], recAgent] = await Promise.all([view(tee.registry, "get_agent", { account_id: tee.worker }),
        view(tee.registry, "get_contract_info"), view(C, "get_agent_tee", { account_id: tee.worker }), view(C, "get_receipt_agent", { job_id: tee.receipt })]);
      if (!att || !held) throw new Error("not attested");
      const holds = BigInt(att.valid_until) > BigInt(Date.now()) * 1_000_000n;
      const by = esc(tee.cvm?.provider ?? "Phala Cloud");
      const reg = `<a href="${explorer(tee.registry)}">${esc(tee.registry)}</a>`;
      const own = owner === D ? t("the co-op's DAO", "DAO koperasi") : `<code>${esc(owner)}</code>`;
      return `<p>${t("Worker", "Pekerja")} <a href="${explorer(tee.worker)}"><code>${esc(short(tee.worker))}</code></a>: ${t(`its key was made inside an Intel TDX VM
        (${by}), its quote checked on-chain by ${reg}, owned by ${own}.`, `kuncinya dibuat di dalam VM Intel TDX (${by}), quote-nya diperiksa on-chain oleh ${reg},
        dimiliki oleh ${own}.`)}</p>
        <dl class="terms dark">
          <div><dt>${t("Code (compose hash)", "Kode (compose hash)")}</dt><dd><code>${esc(short(att.compose_hash))}</code></dd></div>
          <div><dt>${t("Machine (PPID)", "Mesin (PPID)")}</dt><dd><code>${esc(short(att.ppid))}</code></dd></div>
          <div><dt>${t("Attestation", "Atestasi")}</dt><dd>${holds ? t("holds until", "berlaku sampai") : t("ran out on", "berakhir pada")} ${date(att.valid_until)}</dd></div>
          <div><dt>${t("Admitted", "Diterima")}</dt><dd>${teeOnly ? t("TEE-only, ", "hanya TEE, ") : ""}${t("DAO proposals", "usulan DAO")} #${esc(tee.approve)} ${t("and", "dan")} #${esc(tee.admit)}</dd></div>
        </dl>
        ${recAgent === tee.worker ? `<p class="small">${t(`It recorded receipt <code>${esc(short(tee.receipt))}</code> from inside the TEE, after the by-laws gate in the OutLayer enclave`,
          `Ia mencatat tanda terima <code>${esc(short(tee.receipt))}</code> dari dalam TEE, setelah gerbang anggaran dasar di enclave OutLayer`)}
          (<a href="${txUrl(tee.gate)}">tx</a>).</p>` : ""}
        <p class="small muted">${t("The VM was stopped after its job to save cost; the attestation and the receipt stay on-chain.",
          "VM dihentikan setelah tugasnya untuk menghemat biaya; atestasi dan tanda terimanya tetap on-chain.")}</p>`;
    });
  } else $("a-tee").hidden = true;
  pane("a-props", async () => {
    const list = await view(C, "get_agent_proposals");
    const files = await Promise.all(list.map((p) => evaluation(Number(p.version))));
    return table([t("By-laws", "Anggaran dasar"), t("DAO proposal", "Usulan DAO"), t("Its reasoning", "Alasannya")], list.map((p, i) => [p, files[i]]).reverse().map(([p, f]) => `<tr>
      <td>v${esc(p.version)}</td><td data-label="${t("DAO proposal", "Usulan DAO")}"><a href="${explorer(D)}">#${esc(p.proposal)}</a></td>
      <td data-label="${t("Its reasoning", "Alasannya")}">${esc(String(p.reason).slice(0, 220))}${f?.evaluation ? `<span class="claim">${t("Its evaluation", "Penilaiannya")} (${esc(f.model ?? "")}): “${esc(String(f.evaluation).slice(0, 220))}”</span>` : ""}</td></tr>`));
  });
  pane("a-risk", async () => {
    const [m, risk] = await Promise.all([view(C, "get_agent_member"), view(C, "get_risk_fund")]);
    if (!m) throw new Error("older contract");
    return `<dl class="kpis small-kpis">
      <div><dt>${t("Its share", "Bagiannya")}</dt><dd>${m.share_bps / 100}%</dd><small>${t("of every profit share", "dari setiap pembagian SHU")}</small></div>
      <div class="${m.standing_bps < 10000 ? "warn" : "ok"}"><dt>${t("Standing", "Kedudukan")}</dt><dd>${m.standing_bps / 100}%</dd><small>${esc(m.strikes)} ${t("upheld case(s)", "perkara dikabulkan")}${m.suspended ? t(", suspended", ", diskors") : ""}</small></div>
      <div><dt>${t("Risk fund", "Dana risiko")}</dt><dd>${risk ? usdc(risk[0]) : "0.00"} <small>USDC</small></dd><small>${risk ? t(`saves ${risk[1] / 100}% of its earnings`, `menabung ${risk[1] / 100}% dari pendapatannya`) : ""}</small></div>
      <div><dt>${t("From its shares", "Dari bagiannya")}</dt><dd>${usdc(m.shu_total)} <small>USDC</small></dd><small>${t("so far", "sejauh ini")}</small></div></dl>
      <p class="small">${t("The risk fund refunds the agent's mistakes at once, when the co-op court upholds a buyer's case.",
        "Dana risiko langsung mengganti kesalahan agen, saat pengadilan koperasi mengabulkan perkara pembeli.")}</p>`;
  });
  pane("a-receipts", async () => {
    const info = await view(C, "get_info");
    const recs = await view(C, "get_receipts", { from: Math.max(0, info.receipts - 15), limit: 15 });
    return `${table([t("Job", "Pekerjaan"), t("Price", "Harga"), t("Inference", "Inferensi"), t("By-laws", "Anggaran dasar"), "Status"], [...recs].reverse().map((r) => `<tr>
      <td>${esc(short(r.job_id))} <span class="muted">${date(r.ts)}</span></td>
      <td class="num" data-label="${t("Price", "Harga")}">${usdc(r.price)}</td><td class="num" data-label="${t("Inference", "Inferensi")}">$${(Number(r.inference_cost) / 1e6).toFixed(4)}</td>
      <td data-label="${t("By-laws", "Anggaran dasar")}">v${esc(r.config_version)}</td><td data-label="Status"><span class="badge ${esc(r.status)}">${esc(word(r.status))}</span></td></tr>`))}
      <p class="small">${t(`The latest 15 of ${esc(info.receipts)}. Which jobs a TEE-verified model did: <a href="/#work">the landing page</a>.`,
        `15 terbaru dari ${esc(info.receipts)}. Pekerjaan mana yang dikerjakan model terverifikasi TEE: <a href="/#work">halaman utama</a>.`)}
      ${t("How it did, as a member", "Bagaimana kinerjanya, sebagai anggota")}: <a href="#/report">${t("its report card", "rapornya")}</a>.</p>`;
  });
}

// ---------- the agent's report card: the agent judged as a member, from the chain and the files it is checked against ----------
const evals = new Map();
/** web/agent-proposals/v<N>.json: the agent's own run that wrote by-laws vN (its evaluation of the last ones), or null. */
const evaluation = (v) => {
  if (!evals.has(v)) evals.set(v, fetch(`agent-proposals/v${v}.json`).then((r) => (r.ok ? r.json() : null), () => null));
  return evals.get(v);
};
let agentRecord = null;
/** Its by-laws proposals, each with the DAO's decision and what the members did after (re-passed, or undone). */
const agentProposals = () => (agentRecord ??= (async () => {
  const list = await view(C, "get_agent_proposals");
  const last = Number(await view(D, "get_last_proposal_id"));
  const from = Math.min(...list.map((p) => Number(p.proposal)), last);
  const props = await view(D, "get_proposals", { from_index: from, limit: Math.max(1, last - from) });
  const byId = new Map(props.map((p) => [Number(p.id), p]));
  const versions = list.map((p) => Number(p.version));
  // its run after the last one it proposed: it may have chosen to propose nothing
  const next = versions.length ? Math.max(...versions) + 1 : 1;
  const [files, nextFile] = await Promise.all([Promise.all(versions.map(evaluation)), evaluation(next)]);
  const rows = list.map((p, i) => {
    const id = Number(p.proposal);
    // what the members did with it, read from the DAO proposals they passed after it
    const repassed = props.find((q) => q.status === "Approved" && new RegExp(`agent proposed in #${id}\\b`).test(q.description));
    const undone = props.find((q) => {
      const m = String(q.description).match(/^By-laws v(\d+): restore v(\d+)/);
      return q.status === "Approved" && Number(q.id) > id && m && Number(m[2]) < versions[i] && versions[i] < Number(m[1]);
    });
    return { p, dao: byId.get(id), file: files[i], repassed, undone, undoneTo: undone && Number(String(undone.description).match(/^By-laws v(\d+)/)[1]) };
  });
  return { rows, declined: nextFile && nextFile.proposed === false ? nextFile : null };
})().catch((e) => { agentRecord = null; throw e; }));

const verdict = (html) => `<p class="rc-verdict">${html}</p>`;
async function report() {
  const tb = dep.taskbond ?? [];
  pane("r-jobs", async () => {
    const recs = await all(C, "get_receipts");
    const kinds = [
      ["taskbond", (id) => id.startsWith("taskbond-"), t("Judged and paid by an outside market, Taskbond", "Dinilai dan dibayar pasar luar, Taskbond")],
      ["court", (id) => id.startsWith("demo-court-"), t("Demo jobs made for court cases", "Pekerjaan demo untuk perkara pengadilan")],
      ["stand-in", () => true, t("The builders' stand-in market (demo jobs)", "Pasar pengganti buatan pengembang (pekerjaan demo)")],
    ];
    const groups = kinds.map(([k, , label]) => ({ k, label, recs: [] }));
    for (const r of recs) groups[kinds.findIndex(([, test]) => test(r.job_id))].recs.push(r);
    const statuses = (rs) => Object.entries(rs.reduce((n, r) => ({ ...n, [r.status]: (n[r.status] ?? 0) + 1 }), {}))
      .map(([s, n]) => `${n} ${esc(word(s).toLowerCase())}`).join(", ");
    const [outside, court, standin] = groups.map((g) => g.recs.length);
    return verdict(t(`Work: ${recs.length} jobs on-chain. Only ${outside} came from an outside market that judged them; ${court} were made for court cases, ${standin} came from the builders' own stand-in market.`,
      `Kerja: ${recs.length} pekerjaan on-chain. Hanya ${outside} datang dari pasar luar yang menilainya; ${court} dibuat untuk perkara pengadilan, ${standin} dari pasar pengganti buatan pengembang.`))
      + table([t("Kind", "Jenis"), t("Jobs", "Pekerjaan"), t("Receipts on-chain", "Tanda terima on-chain")], groups.map((g) => `<tr><td>${g.label}</td>
        <td class="num" data-label="${t("Jobs", "Pekerjaan")}">${g.recs.length}</td><td data-label="${t("Receipts on-chain", "Tanda terima on-chain")}">${statuses(g.recs) || "–"}</td></tr>`))
      + `<p class="small">${t("A Taskbond receipt stays “submitted” on this contract: Taskbond pays through its own escrow (below).",
        "Tanda terima Taskbond tetap “diserahkan” di kontrak ini: Taskbond membayar lewat escrow-nya sendiri (di bawah).")}</p>`;
  });
  if (tb.length) {
    pane("r-taskbond", async () => {
      const scores = tb.map((x) => Number(x.score));
      const paid = tb.filter((x) => x.status === "Paid").length;
      const same = scores.every((s) => s === scores[0]);
      const score = same ? `${scores[0]}/100` : `${(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(0)}/100 ${t("on average", "rata-rata")}`;
      return verdict(t(`Outside judge: Taskbond scored ${same ? "each of" : ""} its ${tb.length} jobs ${score}; ${paid} of ${tb.length} accepted and paid.`,
        `Penilai luar: Taskbond memberi ${same ? "setiap" : ""} ${tb.length} pekerjaannya nilai ${score}; ${paid} dari ${tb.length} diterima dan dibayar.`))
        + table([t("Job", "Pekerjaan"), t("Buyer", "Pembeli"), t("Score", "Nilai"), t("Review", "Ulasan")], tb.map((x) => `<tr>
          <td><a href="${explorer(x.escrow)}">Taskbond #${esc(x.job)}</a> <span class="muted">${esc(x.receipt)}</span></td>
          <td data-label="${t("Buyer", "Pembeli")}">${esc(x.poster)}</td><td class="num" data-label="${t("Score", "Nilai")}"><strong>${esc(x.score)}/100</strong></td>
          <td data-label="${t("Review", "Ulasan")}">${esc(word(x.review))}, ${esc(word(x.status).toLowerCase())}${x.passed_on ? ` (<a href="${txUrl(x.passed_on)}">${t("passed on", "diteruskan")}</a>)` : ""}<span class="claim">“${esc(String(x.reason).replace(/^\[[^\]]*\]\s*\d+\/100\s*·\s*/, ""))}”</span></td></tr>`));
    });
  } else $("r-taskbond").hidden = true;
  pane("r-court", async () => {
    const [recs, cases, st, m] = await Promise.all([all(C, "get_receipts"), all(C, "get_cases"), view(C, "get_agent_standing"), view(C, "get_agent_member")]);
    const jobs = new Set(recs.map((r) => r.job_id));
    const against = cases.filter((c) => jobs.has(c.job_id));
    const n = (s) => against.filter((c) => c.status === s).length;
    const strikes = st.strikes.length;
    const effect = st.suspended ? t("it is suspended", "ia diskors")
      : m.standing_bps === 10000 ? t("its share is whole", "bagiannya utuh")
        : m.standing_bps === 5000 ? t("its share is halved", "bagiannya dipotong separuh") : t(`its share is scaled to ${m.standing_bps / 100}%`, `bagiannya diskalakan ke ${m.standing_bps / 100}%`);
    return verdict(t(`Court: ${n("Upheld")} of ${against.length} cases upheld; ${plural(strikes, "live strike", "teguran aktif")} → ${effect}.`,
      `Pengadilan: ${n("Upheld")} dari ${against.length} perkara dikabulkan; ${strikes} teguran aktif → ${effect}.`))
      + `<p>${t(`${n("Dismissed")} dismissed, ${n("Open")} open. A strike counts for 90 days; three suspend the agent.`,
        `${n("Dismissed")} ditolak, ${n("Open")} masih berjalan. Teguran berlaku 90 hari; tiga teguran menskors agen.`)}
        ${st.strikes.map(([c, ts]) => t(`Live strike: case #${esc(c)}, ${date(ts)}.`, `Teguran aktif: perkara #${esc(c)}, ${date(ts)}.`)).join(" ")}
        ${st.reinstated_at ? t(`It was suspended once and the members reinstated it on ${date(st.reinstated_at)}.`, `Ia pernah diskors dan anggota memulihkannya pada ${date(st.reinstated_at)}.`) : ""}</p>
      <p class="small">${t("Every case, with its jurors", "Setiap perkara, dengan jurinya")}: <a href="#/commons">${t("Commons", "Bersama")}</a>.</p>`;
  });
  pane("r-money", async () => {
    const [m, risk] = await Promise.all([view(C, "get_agent_member"), view(C, "get_risk_fund")]);
    if (!m) throw new Error("older contract");
    const [fund, saves] = risk ?? ["0", 0];
    return verdict(t(`Money: it saves ${saves / 100}% of its earnings for refunds (the risk fund holds ${usdc(fund)} USDC) and has received ${usdc(m.shu_total)} USDC of profit shares.`,
      `Uang: ia menabung ${saves / 100}% dari pendapatannya untuk ganti rugi (dana risiko berisi ${usdc(fund)} USDC) dan telah menerima ${usdc(m.shu_total)} USDC dari SHU.`))
      + `<p>${t(`As a member it is due ${m.share_bps / 100}% of every profit share, scaled to ${m.standing_bps / 100}% by its court record: ${(m.share_bps * m.standing_bps) / 1e6}% now.`,
        `Sebagai anggota ia berhak atas ${m.share_bps / 100}% dari setiap pembagian SHU, diskalakan ke ${m.standing_bps / 100}% oleh catatan pengadilannya: ${(m.share_bps * m.standing_bps) / 1e6}% sekarang.`)}</p>`;
  });
  pane("r-props", async () => {
    const { rows, declined } = await agentProposals();
    const passed = rows.filter((r) => r.dao?.status === "Approved").length;
    const undone = rows.filter((r) => r.undone);
    const fate = (r) => {
      if (r.undone) return t(`approved (#${esc(r.p.proposal)}), then <strong>undone by the members' v${r.undoneTo} (#${esc(r.undone.id)})</strong>`,
        `disetujui (#${esc(r.p.proposal)}), lalu <strong>dibatalkan oleh v${r.undoneTo} dari anggota (#${esc(r.undone.id)})</strong>`);
      if (r.repassed) return t(`${esc(word(r.dao?.status ?? "?").toLowerCase())} (#${esc(r.p.proposal)}), but its call failed; <strong>the members passed the same file as #${esc(r.repassed.id)}</strong>`,
        `${esc(word(r.dao?.status ?? "?").toLowerCase())} (#${esc(r.p.proposal)}), tetapi panggilannya gagal; <strong>anggota meloloskan berkas yang sama sebagai #${esc(r.repassed.id)}</strong>`);
      return `${esc(word(r.dao?.status ?? "?"))} (#${esc(r.p.proposal)})`;
    };
    const again = rows.filter((r) => r.repassed).length;
    return verdict(t(`By-laws: it proposed ${rows.length} versions; ${passed} approved by the members${again ? ` (${again} re-passed by the members after its own call failed)` : ""}; ${undone.length} later undone by the members${undone.map((r) => ` (v${esc(r.p.version)} → v${r.undoneTo}, #${esc(r.undone.id)})`).join("")}.`,
      `Anggaran dasar: ia mengusulkan ${rows.length} versi; ${passed} disetujui anggota${again ? ` (${again} diloloskan ulang oleh anggota setelah panggilannya sendiri gagal)` : ""}; ${undone.length} kemudian dibatalkan anggota${undone.map((r) => ` (v${esc(r.p.version)} → v${r.undoneTo}, #${esc(r.undone.id)})`).join("")}.`))
      + table([t("By-laws", "Anggaran dasar"), t("What came of it", "Hasilnya"), t("Its reasoning", "Alasannya")], [
        ...(declined ? [`<tr><td>v${esc(declined.version)}?</td><td data-label="${t("What came of it", "Hasilnya")}">${t("it proposed nothing", "ia tidak mengusulkan apa pun")}</td>
          <td data-label="${t("Its reasoning", "Alasannya")}">“${esc(String(declined.evaluation).slice(0, 220))}”</td></tr>`] : []),
        ...[...rows].reverse().map((r) => `<tr><td>v${esc(r.p.version)}</td><td data-label="${t("What came of it", "Hasilnya")}">${fate(r)}</td>
          <td data-label="${t("Its reasoning", "Alasannya")}">${esc(String(r.p.reason).slice(0, 200))}${r.file?.evaluation ? `<span class="claim">${t("Its evaluation of the last ones", "Penilaiannya atas versi sebelumnya")}: “${esc(String(r.file.evaluation).slice(0, 200))}”</span>` : ""}${
            r.undone ? `<span class="claim">${t("The members", "Anggota")}: “${esc(oneLine(r.undone.description, 220))}”</span>` : ""}</td></tr>`)]);
  });
  pane("r-fixes", async () => {
    const { rows } = await agentProposals();
    const review = dep.agentReview;
    const [bad, good] = review ? await Promise.all([view(D, "get_proposal", { id: review.rejected.proposal }), view(D, "get_proposal", { id: review.proposal })]) : [null, null];
    const items = rows.filter((r) => r.undone).map((r) => `<li><b>v${esc(r.p.version)} (#${esc(r.p.proposal)}) → v${r.undoneTo} (#${esc(r.undone.id)})</b><span>${t(
      "The members undid its by-laws", "Anggota membatalkan anggaran dasarnya")}: “${esc(oneLine(r.undone.description, 260))}”</span></li>`);
    if (review) {
      items.push(`<li><b>${t(`Its ${esc(review.year)} review: #${esc(bad.id)} ${esc(word(bad.status).toLowerCase())}, #${esc(good.id)} ${esc(word(good.status).toLowerCase())}`,
        `Laporan tahunan ${esc(review.year)}: #${esc(bad.id)} ${esc(word(bad.status).toLowerCase())}, #${esc(good.id)} ${esc(word(good.status).toLowerCase())}`)}</b>
        <span>${t("The first draft was turned down because", "Draf pertama ditolak karena")} ${esc(review.rejected.why)} (<a href="${esc(review.rejected.report)}">${t("the rejected draft", "draf yang ditolak")}</a>).
        ${t("The corrected one was accepted", "Versi perbaikannya diterima")} (<a href="${esc(review.report)}">${t("the accepted review", "laporan yang diterima")}</a>)${review.note ? `: ${esc(review.note)}` : ""}.</span></li>`);
    }
    if (!items.length) return verdict(t("Mistakes: none the members had to correct.", "Kesalahan: tidak ada yang perlu dikoreksi anggota."));
    const ok = review && bad.status === "Rejected" && good.status === "Approved";
    return verdict(t(`Mistakes: ${items.length} caught and corrected by the members${ok ? `, its annual review accepted on the second draft (#${esc(good.id)})` : ""}.`,
      `Kesalahan: ${items.length} ditemukan dan dikoreksi anggota${ok ? `, laporan tahunannya diterima pada draf kedua (#${esc(good.id)})` : ""}.`))
      + `<ul class="tiers">${items.join("")}</ul>`;
  });
  const tee = dep.tee;
  if (tee) {
    pane("r-tee", async () => {
      const [[teeOnly, held], recAgent, approve, admit] = await Promise.all([view(C, "get_agent_tee", { account_id: tee.worker }), view(C, "get_receipt_agent", { job_id: tee.receipt }),
        view(D, "get_proposal", { id: tee.approve }), view(D, "get_proposal", { id: tee.admit })]);
      const ok = held && approve.status === "Approved" && admit.status === "Approved";
      return verdict(ok ? t(`Shade Agent: a second worker, its key made in Intel TDX, admitted by the members (#${esc(tee.approve)}, #${esc(tee.admit)})${recAgent === tee.worker ? ", recorded a receipt from inside the TEE" : ""}.`,
        `Shade Agent: pekerja kedua, kuncinya dibuat di Intel TDX, diterima anggota (#${esc(tee.approve)}, #${esc(tee.admit)})${recAgent === tee.worker ? ", mencatat tanda terima dari dalam TEE" : ""}.`)
        : t("Shade Agent: not admitted on this contract now.", "Shade Agent: tidak diterima di kontrak ini sekarang."))
        + `<p class="small">${teeOnly ? t("Admitted TEE-only. ", "Diterima hanya-TEE. ") : ""}${t("It is a separate worker, not the agent's own key", "Ia pekerja terpisah, bukan kunci agen sendiri")}${tee.note ? ` (${esc(tee.note)})` : ""}.
          <a href="#/agent">${t("Its attestation", "Atestasinya")}</a>.</p>`;
    });
  } else $("r-tee").hidden = true;
}

async function money() {
  pane("m-treasury", async () => {
    const [info, audit, bal] = await Promise.all([view(C, "get_info"), view(C, "get_audit"), view(dep.usdc, "ft_balance_of", { account_id: D })]);
    const owed = BigInt(audit.owed);
    const r = info.share_rule;
    return `<dl class="kpis small-kpis">
      <div><dt>${t("Treasury", "Kas")}</dt><dd>${usdc(bal)} <small>USDC</small></dd><small>${t("in the DAO, spent only by a vote", "di DAO, dibelanjakan hanya lewat pemungutan suara")}</small></div>
      <div><dt>${t("Owed to the co-op", "Hak koperasi")}</dt><dd>${usdc(audit.expected)}</dd><small>${t("paid jobs after the market's 5%", "pekerjaan dibayar setelah 5% pasar")}</small></div>
      <div><dt>${t("Passed on", "Diteruskan")}</dt><dd>${usdc(audit.deposited)}</dd><small>${t("by the steward", "oleh pengurus")}</small></div>
      <div class="${owed > 0n ? "warn" : "ok"}"><dt>Audit</dt><dd>${owed > 0n ? t("Red", "Merah") : t("Green", "Hijau")}</dd><small>${owed > 0n ? t(`${usdc(owed)} USDC missing`, `${usdc(owed)} USDC hilang`) : t("all passed on", "semua diteruskan")}</small></div></dl>
      <p class="small">${t(`Steward bond at stake: ${nearAmt(info.steward_bond)} NEAR. Profit shares keep ${r.reserve_bps / 100}% as reserve and split the rest
      ${r.savings_bps / 100}% by savings, ${r.points_bps / 100}% by contribution points.`, `Jaminan pengurus yang dipertaruhkan: ${nearAmt(info.steward_bond)} NEAR. Pembagian SHU menyisihkan ${r.reserve_bps / 100}% sebagai cadangan dan membagi sisanya
      ${r.savings_bps / 100}% menurut simpanan, ${r.points_bps / 100}% menurut poin kontribusi.`)}${owed > 0n ? t(" This demo co-op keeps the audit red on purpose.", " Koperasi demo ini sengaja membiarkan audit merah.") : ""}</p>`;
  });
  pane("m-periods", async () => {
    const periods = await view(C, "get_periods");
    return table([t("Share", "SHU"), t("Date", "Tanggal"), t("Shared, USDC", "Dibagi, USDC"), t("Reserve, USDC", "Cadangan, USDC"), t("Members", "Anggota")], [...periods].reverse().map((p) => `<tr><td>${t("Share", "SHU")} ${esc(p.id)}</td>
      <td data-label="${t("Date", "Tanggal")}">${date(p.ts)}</td><td class="num" data-label="${t("Shared", "Dibagi")}">${usdc(BigInt(p.amount) - BigInt(p.reserve))}</td>
      <td class="num" data-label="${t("Reserve", "Cadangan")}">${usdc(p.reserve)}</td><td class="num" data-label="${t("Members", "Anggota")}">${esc(p.members)}</td></tr>`));
  });
  pane("m-rep", async () => {
    const [w, bps] = await Promise.all([view(C, "get_reputation_weights"), view(C, "get_reputation_share").catch(() => 0)]);
    const total = w.reduce((s, [, x]) => s + Number(x), 0) || 1;
    return `<p class="small">${bps ? t(`${bps / 100}% of every profit share`, `${bps / 100}% dari setiap pembagian SHU`) : t("A part of each profit share", "Sebagian dari setiap pembagian SHU")} ${t(`is split among members in good standing by their work since the last
      one (tasks finished, pledges kept, juries served), plus half their last weight.`, `dibagi di antara anggota berstatus baik menurut kerja mereka sejak pembagian terakhir
      (tugas selesai, janji ditepati, tugas juri), ditambah separuh bobot terakhir mereka.`)}</p>
      ${table([t("Member", "Anggota"), t("Weight", "Bobot"), t("Part", "Bagian")], w.map(([a, x]) => `<tr><td><a href="cert.html?who=${encodeURIComponent(a)}">${esc(a)}</a></td>
        <td class="num" data-label="${t("Weight", "Bobot")}">${esc(x)}</td><td class="num" data-label="${t("Part", "Bagian")}">${((100 * Number(x)) / total).toFixed(1)}%</td></tr>`))}`;
  });
  pane("m-loans", async () => {
    const [loan, fed] = await Promise.all([view(C, "get_loan_rule"), view(C, "get_federation").catch(() => null)]);
    if (!loan) return `<p class="small">${t("The members have not voted a loan rule.", "Anggota belum memutuskan aturan pinjaman.")}</p>`;
    const [r, fund] = loan;
    const cap = fed?.[1];
    return `<p>${t(`A member in good standing with a guarantor borrows up to <strong>${nearAmt(r.max_loan)} NEAR</strong> for ${esc(r.term_days)} days at
      ${r.rate_bps / 100}% flat; the fund can lend <strong>${nearAmt(fund)} NEAR</strong> now.`, `Anggota berstatus baik dengan penjamin (tanggung renteng) meminjam hingga <strong>${nearAmt(r.max_loan)} NEAR</strong> selama ${esc(r.term_days)} hari dengan bunga
      ${r.rate_bps / 100}% flat; dana bisa meminjamkan <strong>${nearAmt(fund)} NEAR</strong> sekarang.`)}${cap ? t(` The federation caps loans at ${cap.max_rate_bps / 100}% for ${esc(cap.max_term_days)} days; the contract refuses a rule above it.`,
      ` Federasi membatasi pinjaman pada ${cap.max_rate_bps / 100}% untuk ${esc(cap.max_term_days)} hari; kontrak menolak aturan di atasnya.`) : ""}</p>
      <p class="small">${t("A late loan costs the borrower and their guarantors good standing. Borrow under", "Pinjaman yang terlambat membuat peminjam dan penjaminnya kehilangan status baik. Pinjam di")} <a href="#/membership">${t("My membership", "Keanggotaan saya")}</a>.</p>`;
  });
}

async function commons() {
  pane("c-cases", async () => {
    const cases = await all(C, "get_cases");
    const OUT = { Open: t("jury out", "juri bersidang"), Upheld: t("upheld: refunded", "dikabulkan: dikembalikan"), Dismissed: t("not upheld", "tidak dikabulkan") };
    return table([t("Case", "Perkara"), t("Refund", "Ganti rugi"), t("Jurors", "Juri"), t("Outcome", "Putusan")], [...cases].reverse().map((c) => `<tr><td><strong>#${esc(c.id)}</strong> ${t("job", "pekerjaan")} ${esc(c.job_id)}<span class="claim">“${esc(c.reason)}”, ${t("brought by", "diajukan oleh")} ${esc(c.claimant)}</span></td>
      <td class="num" data-label="${t("Refund", "Ganti rugi")}">${usdc(c.amount)} USDC</td>
      <td data-label="${t("Jurors", "Juri")}">${c.jurors.map((j) => { const v = c.votes.find(([x]) => x === j); return `${esc(j)}: ${v ? (v[1] ? t("uphold", "kabulkan") : t("reject", "tolak")) : "–"}`; }).join("<br>")}</td>
      <td data-label="${t("Outcome", "Putusan")}">${OUT[c.status] ?? esc(c.status)}${c.refund_proposal !== null ? `; ${t("DAO proposal", "usulan DAO")} #${esc(c.refund_proposal)}` : ""}</td></tr>`));
  });
  pane("c-pledges", async () => {
    const [pledges, claims] = await Promise.all([all(C, "get_pledges"), all(C, "get_pledge_claims")]);
    const n = (id, st) => claims.filter((c) => c.pledge === id && c.status === st).length;
    return table([t("Pledge", "Janji"), t("By", "Oleh"), t("Called in", "Ditagih"), t("Kept / broken", "Ditepati / diingkari")], [...pledges].reverse().map((p) => `<tr><td><strong>#${esc(p.id)}</strong> ${esc(p.what)}</td>
      <td data-label="${t("By", "Oleh")}"><a href="cert.html?who=${encodeURIComponent(p.issuer)}">${esc(p.issuer)}</a></td>
      <td class="num" data-label="${t("Called in", "Ditagih")}">${esc(p.called)} ${t("of", "dari")} ${esc(p.units)}</td><td data-label="${t("Kept / broken", "Ditepati / diingkari")}">${n(p.id, "Honored")} / ${n(p.id, "Broken")}</td></tr>`));
  });
  pane("c-standing", async () => {
    const members = await view(C, "get_members", { from: 0, limit: 200 });
    const standing = await Promise.all(members.map(([a]) => view(C, "get_standing", { account_id: a })));
    return `<ul class="tiers">${members.map(([a], i) => {
      const [x, good] = standing[i];
      return `<li><b><a href="cert.html?who=${encodeURIComponent(a)}">${esc(a)}</a>: ${good ? t("good standing", "status baik") : t("not in good standing", "status tidak baik")}</b>
        <span>${t(`${esc(x.pledges_honored)} pledge(s) kept, ${esc(x.pledges_broken)} broken; ${esc(x.juries_served)} jury ruling(s), ${esc(x.juries_missed)} missed`,
          `${esc(x.pledges_honored)} janji ditepati, ${esc(x.pledges_broken)} diingkari; ${esc(x.juries_served)} putusan juri, ${esc(x.juries_missed)} terlewat`)}${
          x.slashed ? t(`; slashed ${esc(x.slashed)} time(s)`, `; didenda ${esc(x.slashed)} kali`) : ""}</span></li>`;
    }).join("")}</ul>`;
  });
}

async function federation() {
  pane("f-fed", async () => {
    const [fed, sisters] = await Promise.all([view(C, "get_federation"), view(C, "get_sister_coops")]);
    if (!fed) return `<p class="small">${t("This co-op is not in a federation yet.", "Koperasi ini belum bergabung dalam federasi.")}</p>`;
    const [fedDao, ceil] = fed;
    const res = [dep.federation?.resolution, ...(dep.federation?.resolutions ?? [])].filter(Boolean);
    return `<p>${t(`The federation <a href="${explorer(fedDao)}">${esc(fedDao)}</a> is a Sputnik DAO whose only members are co-ops' DAOs, one co-op one vote.`,
      `Federasi <a href="${explorer(fedDao)}">${esc(fedDao)}</a> adalah Sputnik DAO yang anggotanya hanya DAO koperasi, satu koperasi satu suara.`)}
      ${ceil ? t(`Its ceiling, binding in this contract: loans at most <strong>${ceil.max_rate_bps / 100}%</strong> for ${esc(ceil.max_term_days)} days.`,
        `Batas atasnya, mengikat di kontrak ini: pinjaman paling tinggi <strong>${ceil.max_rate_bps / 100}%</strong> untuk ${esc(ceil.max_term_days)} hari.`) : t("No loan ceiling set yet.", "Belum ada batas atas pinjaman.")}</p>
      <p>${t("Sister co-ops (their work records count here)", "Koperasi saudara (catatan kerja mereka dihitung di sini)")}: ${sisters.length ? sisters.map((s) => `<a href="${explorer(s)}">${esc(s)}</a>`).join(", ") : t("none", "tidak ada")}.</p>
      ${res.length ? `<ul class="tiers">${res.map((r) => `<li><b>#${esc(r.id)}</b><span>${esc(r.text)}</span></li>`).join("")}</ul>` : ""}
      <p class="small"><a href="/coops.html">${t("Every co-op on this code, and the federation's resolutions with each co-op's vote", "Setiap koperasi dengan kode ini, dan resolusi federasi beserta suara tiap koperasi")}</a>.</p>`;
  });
  pane("f-trades", async () => {
    const trades = dep.federation?.trades ?? [];
    if (!trades.length) throw new Error("none");
    return `${table([t("Job", "Pekerjaan"), t("Done by", "Dikerjakan oleh"), t("Referred by", "Dirujuk oleh"), t("Share back", "Bagian kembali")], trades.map((x) => `<tr><td><code>${esc(short(x.job))}</code> <a href="${txUrl(x.paid)}">${t("paid", "dibayar")}</a></td>
      <td data-label="${t("Done by", "Dikerjakan oleh")}">${esc(x.coop)}</td><td data-label="${t("Referred by", "Dirujuk oleh")}">${esc(x.referred_by)}</td>
      <td class="num" data-label="${t("Share back", "Bagian kembali")}">${usdc(x.share)} ${t("of", "dari")} ${usdc(x.net)} <a href="${txUrl(x.deposited)}">${t("deposited", "disetor")}</a></td></tr>`))}
      <p class="small">${t(`A sister co-op's agent did the job; the referring co-op's share went back by resolution #${esc(trades[0].resolution)}.`,
        `Agen koperasi saudara mengerjakannya; bagian koperasi perujuk dikembalikan lewat resolusi #${esc(trades[0].resolution)}.`)}</p>`;
  });
}

async function verify() {
  const mark = (id, ok, html) => {
    const li = $(id);
    li.classList.remove("pass", "fail");
    if (ok !== null) li.classList.add(ok ? "pass" : "fail");
    li.querySelector(".out").innerHTML = html;
  };
  const chainErr = (e) => `${t("Could not read the chain", "Chain tidak bisa dibaca")} (${esc(e.message.slice(0, 80))}).`;
  byLaws().then(({ c, hex }) => mark("k-bylaws", hex === null ? null : hex === c.hash, hex === null ? t("Could not download the by-laws file.", "Berkas anggaran dasar tidak bisa diunduh.")
    : hex === c.hash ? t(`Your browser hashed <code>${esc(c.uri)}</code>: <code>${esc(short(hex))}</code>, the hash the members voted for v${esc(c.version)}. The contract refuses receipts under any other.`,
      `Browser Anda menghitung hash <code>${esc(c.uri)}</code>: <code>${esc(short(hex))}</code>, hash yang dipilih anggota untuk v${esc(c.version)}. Kontrak menolak tanda terima dengan hash lain.`)
      : t(`The published file hashes to <code>${esc(short(hex))}</code>, not the approved <code>${esc(short(c.hash))}</code>.`,
        `Hash berkas yang diterbitkan <code>${esc(short(hex))}</code>, bukan <code>${esc(short(c.hash))}</code> yang disetujui.`)),
  (e) => mark("k-bylaws", null, chainErr(e)));
  Promise.all([query({ request_type: "view_account", account_id: C }), query({ request_type: "view_access_key_list", account_id: C })]).then(([acct, keys]) => {
    const full = keys.keys.filter((k) => k.access_key.permission === "FullAccess").length;
    const code = acct.global_contract_hash ?? acct.code_hash;
    mark("k-code", full === 0, full === 0
      ? t(`The contract account holds <strong>no full-access key</strong>: only a members' vote can change its code (<code>${esc(short(code))}</code>). <a href="/#codegov">The vote that chose it</a>.`,
        `Akun kontrak <strong>tidak memegang kunci akses penuh</strong>: hanya pemungutan suara anggota yang bisa mengubah kodenya (<code>${esc(short(code))}</code>). <a href="/#codegov">Pemungutan suara yang memilihnya</a>.`)
      : t(`The contract account still has ${full} full-access key(s): someone could change the code without a vote.`,
        `Akun kontrak masih punya ${full} kunci akses penuh: seseorang bisa mengubah kode tanpa pemungutan suara.`));
  }, (e) => mark("k-code", null, chainErr(e)));
  const red = dep.redteam ?? [];
  if (!red.length) { $("k-attacks").hidden = true; return; }
  mark("k-attacks", null, `${t(`${red.length} attacks were sent to this co-op as real transactions.`, `${red.length} serangan dikirim ke koperasi ini sebagai transaksi sungguhan.`)} <button type="button" class="btn small" id="k-run">${t("Read them back from NEAR", "Baca kembali dari NEAR")}</button>`);
  // each must have failed on-chain with the refusal it was saved with (the same check as the landing page's)
  $("k-run").onclick = async () => {
    mark("k-attacks", null, t(`Reading ${red.length} transactions…`, `Membaca ${red.length} transaksi…`));
    const res = await Promise.all(red.map((r) => txStatus(r.tx, r.by).then((x) => {
      const failure = JSON.stringify(x?.status?.Failure ?? x?.receipts_outcome?.map((o) => o.outcome.status.Failure).find(Boolean) ?? null);
      return failure !== "null" && failure.includes(JSON.stringify(r.error.slice(0, 60)).slice(1, -1));
    }, () => null)));
    const refused = res.filter((x) => x === true).length;
    const unread = res.filter((x) => x === null).length;
    mark("k-attacks", unread ? null : refused === red.length, `${t(`${refused} of ${red.length} attacks failed on-chain with the contract's or the DAO's own refusal`,
      `${refused} dari ${red.length} serangan gagal on-chain dengan penolakan kontrak atau DAO sendiri`)}${unread ? t(` (${unread} not readable right now)`, ` (${unread} tidak terbaca sekarang)`) : ""}.
      <ul class="attacks">${red.map((r, i) => `<li>${res[i] === true ? t("refused", "ditolak") : res[i] === null ? t("not read", "tidak terbaca") : t("<strong>NOT REFUSED</strong>", "<strong>TIDAK DITOLAK</strong>")}: ${esc(r.what)} <a href="${txUrl(r.tx)}">tx</a></li>`).join("")}</ul>`);
  };
}

// ---------- My history: what this member did, read from the chain (the signed-in account, or ?as= on localhost) ----------
let me = "";
function history() {
  if (!me) { $("m-history").hidden = true; return; }
  const who = me;
  const near3 = (y) => (Number(BigInt(y)) / 1e24).toLocaleString("en", { maximumFractionDigits: 3 }); // a loan's interest is often below 0.01
  pane("m-history", async () => {
    const last = Number(await view(D, "get_last_proposal_id"));
    const from = Math.max(0, last - 100);
    const [props, member, claimable, pledges, pclaims, cases, dues, loan, credit] = await Promise.all([
      view(D, "get_proposals", { from_index: from, limit: 100 }), view(C, "get_member", { account_id: who }),
      view(C, "get_claimable", { account_id: who }).catch(() => "0"), all(C, "get_pledges"), all(C, "get_pledge_claims"), all(C, "get_cases"),
      ...["get_dues_status", "get_loan", "get_credit"].map((m) => view(C, m, { account_id: who }).catch(() => null))]);
    const votes = props.filter((p) => p.votes?.[who]);
    const count = (v) => votes.filter((p) => p.votes[who] === v).length;
    const mine = pledges.filter((p) => p.issuer === who);
    const onMine = pclaims.filter((c) => mine.some((p) => p.id === c.pledge));
    const called = pclaims.filter((c) => c.holder === who);
    const sued = cases.filter((c) => c.claimant === who);
    const juror = cases.filter((c) => c.jurors.includes(who));
    const ruling = (c) => { const v = c.votes.find(([j]) => j === who); return v ? (v[1] ? t("you ruled uphold", "Anda memutus kabulkan") : t("you ruled reject", "Anda memutus tolak")) : c.status === "Open" ? t("your ruling is due", "putusan Anda ditunggu") : t("you did not rule", "Anda tidak memutus"); };
    const n = (list, st) => list.filter((c) => c.status === st).length;
    const rows = [
      [t("DAO votes", "Suara di DAO"), votes.length
        ? t(`${votes.length} of the last ${props.length} proposals: ${count("Approve")} approve, ${count("Reject")} reject${count("Remove") ? `, ${count("Remove")} remove` : ""}`,
          `${votes.length} dari ${props.length} usulan terakhir: ${count("Approve")} setuju, ${count("Reject")} tolak${count("Remove") ? `, ${count("Remove")} hapus` : ""}`)
        : t(`none in the last ${props.length} proposals`, `tidak ada di ${props.length} usulan terakhir`)],
      [t("Profit share (SHU)", "SHU"), BigInt(claimable ?? 0) > 0n ? t(`${usdc(claimable)} USDC waits to be claimed`, `${usdc(claimable)} USDC menunggu diambil`) : t("nothing waiting to be claimed", "tidak ada yang menunggu diambil")],
      [t("Pledges made", "Janji dibuat"), mine.length ? t(`${mine.length} (${mine.map((p) => `#${esc(p.id)}`).join(", ")}): called in ${onMine.length} times, ${n(onMine, "Honored")} kept, ${n(onMine, "Broken")} broken, ${n(onMine, "Open")} open`,
        `${mine.length} (${mine.map((p) => `#${esc(p.id)}`).join(", ")}): ditagih ${onMine.length} kali, ${n(onMine, "Honored")} ditepati, ${n(onMine, "Broken")} diingkari, ${n(onMine, "Open")} terbuka`) : t("none", "tidak ada")],
      [t("Pledges called in", "Janji ditagih"), called.length ? t(`${called.length}: ${n(called, "Honored")} kept, ${n(called, "Broken")} broken, ${n(called, "Open")} for you to confirm`,
        `${called.length}: ${n(called, "Honored")} ditepati, ${n(called, "Broken")} diingkari, ${n(called, "Open")} menunggu konfirmasi Anda`) : t("none", "tidak ada")],
      [t("Court, as claimant", "Pengadilan, sebagai penggugat"), sued.length ? sued.map((c) => `#${esc(c.id)} ${esc(word(c.status).toLowerCase())}`).join(", ") : t("none", "tidak ada")],
      [t("Court, as juror", "Pengadilan, sebagai juri"), juror.length ? juror.map((c) => `#${esc(c.id)} (${ruling(c)})`).join(", ") : t("none", "tidak ada")],
      [t("Dues (simpanan wajib)", "Simpanan wajib"), dues ? (dues[1] ? t(`paid until ${date(dues[0])}`, `lunas sampai ${date(dues[0])}`) : t(`late: paid until ${date(dues[0])}`, `terlambat: lunas sampai ${date(dues[0])}`)) : t("no dues voted", "belum ada simpanan wajib")],
      [t("Loan", "Pinjaman"), loan ? `${near3(loan.principal)} NEAR + ${near3(loan.interest)} ${t("interest", "bunga")}, ${esc(word(loan.status).toLowerCase())}${loan.status === "Repaid" ? "" : `, ${t("due", "jatuh tempo")} ${date(loan.due)}`} (${t("DAO proposal", "usulan DAO")} #${esc(loan.proposal)})` : t("none", "tidak ada")],
      [t("Credit", "Kredit"), credit ? t(`score ${esc(credit[0])} of 10: you can borrow up to ${nearAmt(credit[1])} NEAR`, `skor ${esc(credit[0])} dari 10: Anda bisa meminjam hingga ${nearAmt(credit[1])} NEAR`) : "–"],
    ];
    // the timeline: votes, pledges, claims and cases, newest first
    const events = [
      ...votes.map((p) => ({ ts: p.submission_time, html: `${t("You voted", "Anda memilih")} <strong>${esc(word(p.votes[who]).toLowerCase())}</strong> ${t("on", "pada")} #${esc(p.id)}: ${esc(oneLine(p.description, 90))} <span class="muted">(${esc(word(p.status))})</span>` })),
      ...mine.map((p) => ({ ts: p.ts, html: `${t("You pledged", "Anda berjanji")} #${esc(p.id)}: ${esc(p.what)}` })),
      ...called.map((c) => ({ ts: c.ts, html: `${t("You called in pledge", "Anda menagih janji")} #${esc(c.pledge)} <span class="muted">(${esc(word(c.status))})</span>` })),
      ...sued.map((c) => ({ ts: c.opened, html: `${t("You brought case", "Anda mengajukan perkara")} #${esc(c.id)} <span class="muted">(${esc(word(c.status))})</span>` })),
      ...juror.map((c) => ({ ts: c.opened, html: `${t("Juror on case", "Juri pada perkara")} #${esc(c.id)}: ${ruling(c)}` })),
    ].sort((a, b) => (BigInt(b.ts) > BigInt(a.ts) ? 1 : -1));
    return `<p class="small">${t(`For <strong>${esc(who)}</strong>${member ? "" : ", not a member of this co-op"}, read from NEAR.`, `Untuk <strong>${esc(who)}</strong>${member ? "" : ", bukan anggota koperasi ini"}, dibaca dari NEAR.`)}</p>
      ${table([t("What", "Apa"), t("Where you stand", "Posisi Anda")], rows.map(([k, v]) => `<tr><th scope="row">${k}</th><td data-label="${k}">${v}</td></tr>`))}
      ${events.length ? `<details class="timeline"><summary>${t(`Every step (${events.length})`, `Setiap langkah (${events.length})`)}</summary>
        <ul class="feed">${events.map((e) => `<li><time>${date(e.ts)}</time><span>${e.html}</span></li>`).join("")}</ul></details>` : ""}`;
  });
}

// ---------- Notify me: while the dashboard is open, a browser notification when something new needs the member ----------
// The items are the wallet panel's own "Needs you" (wallet.js inboxItems); what was told is remembered under the same
// key as the panel's, so the two never tell the same thing twice. The permission is asked only on the button.
const NOTIFY = "kop-notify";
let timer = 0;
let notifyMsg = "";
const canNotify = () => typeof Notification !== "undefined";
const store = (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private window: not kept */ } };
const stored = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
async function poll() {
  const who = me;
  if (!who) return;
  try {
    const { inboxItems } = await wallet;
    const last = Number(await view(D, "get_last_proposal_id"));
    const [member, proposals, cases, pclaims, duesStatus] = await Promise.all([view(C, "get_member", { account_id: who }),
      view(D, "get_proposals", { from_index: Math.max(0, last - 50), limit: 50 }), all(C, "get_cases").catch(() => []), all(C, "get_pledge_claims").catch(() => []),
      view(C, "get_dues_status", { account_id: who }).catch(() => null)]);
    if (who !== me) return;
    const items = inboxItems({ proposals: member ? proposals : [], cases, pclaims, duesStatus });
    let seen = [];
    try { seen = JSON.parse(stored(`kop-seen:${who}`) ?? "[]"); } catch { /* none kept */ }
    const fresh = items.filter((i) => !seen.includes(i.key));
    if (fresh.length && canNotify() && Notification.permission === "granted") {
      try { new Notification(t("Koperasi: something needs you", "Koperasi: ada yang menunggu Anda"), { body: fresh.map((i) => i.text).join("\n").slice(0, 300) }); } catch { /* not allowed here */ }
    }
    store(`kop-seen:${who}`, JSON.stringify(items.map((i) => i.key)));
    notifyMsg = t(`Checked ${new Date().toLocaleTimeString("en-GB")}: ${items.length} item(s) need you.`, `Diperiksa ${new Date().toLocaleTimeString("id-ID")}: ${items.length} hal menunggu Anda.`);
  } catch (e) {
    notifyMsg = t("Could not read NEAR this time; trying again in a minute.", "NEAR tidak terbaca kali ini; dicoba lagi semenit lagi.");
    console.warn("notify", e);
  }
  notifyLine();
}
const startPolling = () => { if (!timer) { timer = setInterval(poll, 60_000); poll(); } };
const stopPolling = () => { clearInterval(timer); timer = 0; };
function notifyLine() {
  const el = $("notify");
  if (!me) { el.hidden = true; return; }
  el.hidden = false;
  const on = !!timer;
  el.innerHTML = `<button type="button" class="btn ghost small" id="notify-btn" aria-pressed="${on}">${on ? t("Notifications on: turn off", "Notifikasi aktif: matikan") : t("Notify me", "Beri tahu saya")}</button>
    <span class="small">${esc(notifyMsg || t("A browser notification, while this dashboard is open, when a vote, a jury, a pledge or dues need you.",
      "Notifikasi browser, selama dasbor ini terbuka, saat ada pemungutan suara, tugas juri, janji, atau simpanan wajib yang menunggu Anda."))}
    ${t("Outside the page", "Di luar halaman")}:</span> <a class="small-link" href="/api/inbox?who=${encodeURIComponent(me)}">${t("your RSS feed", "feed RSS Anda")}</a>`;
  $("notify-btn").onclick = async () => {
    if (timer) { stopPolling(); store(NOTIFY, null); notifyMsg = ""; notifyLine(); return; }
    if (!canNotify()) { notifyMsg = t("This browser has no notifications; use the RSS feed.", "Browser ini tidak punya notifikasi; pakai feed RSS."); notifyLine(); return; }
    const p = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
    if (p !== "granted") { notifyMsg = t("Notifications are blocked for this site in the browser's settings.", "Notifikasi diblokir untuk situs ini di pengaturan browser."); notifyLine(); return; }
    store(NOTIFY, "1");
    notifyMsg = t("On: checking every minute while this dashboard is open.", "Aktif: diperiksa setiap menit selama dasbor ini terbuka.");
    startPolling();
    notifyLine();
  };
}

const VIEWS = { overview, membership: history, proposals, agent, report, money, commons, federation, verify };
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

// the dashboard's fixed words in Bahasa Indonesia: data-id (text) or data-idh (with markup, written in this file's HTML)
function chrome() {
  document.querySelectorAll("[data-id], [data-idh]").forEach((el) => {
    const html = el.hasAttribute("data-idh");
    el.dataset.en ??= html ? el.innerHTML : el.textContent;
    if (html) el.innerHTML = t(el.dataset.en, el.dataset.idh);
    else el.textContent = t(el.dataset.en, el.dataset.id);
  });
  $("menu-btn").textContent = t("Menu", "Menu");
}

const whoLine = () => {
  $("who").innerHTML = me ? `${t("Signed in as", "Masuk sebagai")} <strong>${esc(me)}</strong>` : `${t("Not signed in", "Belum masuk")}: <a href="#/membership">${t("connect a wallet", "hubungkan dompet")}</a>`;
};
// who is signed in, from the wallet panel; while a vote from the proposals view runs, its progress shows there too
window.addEventListener("koperasi:wallet", (e) => {
  const { note } = e.detail;
  const changed = e.detail.me !== me;
  me = e.detail.me;
  whoLine();
  $("join-steps").hidden = !!me;
  const out = $("vote-note");
  if (voting && note) { out.hidden = false; out.innerHTML = note; } // built by wallet.js from escaped values
  if (!voting && current === "proposals" && loaded.has("proposals")) proposals();
  if (changed) {
    stopPolling();
    notifyMsg = "";
    if (me && stored(NOTIFY) === "1" && canNotify() && Notification.permission === "granted") startPolling();
    notifyLine();
    if (current === "membership") history(); else loaded.delete("membership");
  }
});
window.addEventListener("koperasi:lang", () => {
  chrome();
  if (me) { whoLine(); notifyMsg = ""; notifyLine(); }
  loaded.clear();
  route(false);
});
window.addEventListener("hashchange", () => route(true));
chrome();
route(false);
