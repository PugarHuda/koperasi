// Bahasa Indonesia for the page's own words (the co-ops it is for are Indonesian villages). The headings, the hero, the
// sections' explanations and the navigation switch; what the page reads from the chain stays as the chain says it.
// The choice is remembered in this browser only; the page opens in English unless the visitor chose Indonesian.
// ponytail: a selector → text table, not an i18n library. Dynamic panels (wallet.js) call t(en, id) and re-render on
// the "koperasi:lang" event.
const ID = [
  ['nav[aria-label="Sections"] a[href="#members"]', "Anggota"],
  ['nav[aria-label="Sections"] a[href="#bylaws"]', "Anggaran dasar"],
  ['nav[aria-label="Sections"] a[href="#work"]', "Kerja"],
  ['nav[aria-label="Sections"] a[href="#audit"]', "Audit"],
  ['nav[aria-label="Sections"] a[href="#shares"]', "SHU"],
  ['nav[aria-label="Sections"] a[href="#trust"]', "Tugas"],
  ['nav[aria-label="Sections"] a[href="#commons"]', "Bersama"],
  ['nav[aria-label="Sections"] a[href="#live"]', "Langsung"],
  [".top-actions a.quiet:not(#run-demo)", "Kode sumber"],
  ["#run-demo", "Jalankan demo"],
  ["#try-link", "Coba dalam 60 detik →"],
  ["#open-app", '<span class="long">Buka</span><span>aplikasi anggota</span>'],
  ["#hero-title .line", "<b>Agen AI</b> satu anggota, satu suara"],
  [".hero .lede", "Desa-desa di Indonesia sudah seabad menjalankan <em>koperasi</em>: anggota memiliki usahanya, masing-masing satu suara, dan membagi hasilnya. Koperasi memberi agen AI aturan yang sama di NEAR."],
  [".hero-cta .btn:not(.ghost)", "Periksa sendiri"],
  [".hero-cta .btn.ghost", "Lihat kerja agen"],
  ["#panel-q", "Siapa yang mengendalikan agen AI ini?"],
  [".psteps > li:nth-child(1) > b", "Anggota memilih"],
  [".psteps > li:nth-child(2) > b", "Perintahnya dikunci"],
  [".psteps > li:nth-child(3) > b", "Agen patuh"],
  ["#p-lock", '<span aria-hidden="true" class="lock-ico"></span>Mengubahnya perlu pemungutan suara baru'],
  [".demo-note", "Koperasi demo di testnet NEAR: anggotanya akun demo, dan pekerjaan sejauh ini datang dari pasar demo."],
  ["#status > div:nth-child(1) dt", "Agen"],
  ["#status > div:nth-child(2) dt", "Anggaran dasar berlaku"],
  ["#status > div:nth-child(3) dt", "Pekerjaan on-chain"],
  ["#status > div:nth-child(4) dt", "Audit"],
  ["#brief-title", 'Brief Social Money, <span class="dim">dibuktikan langsung.</span>'],
  ["#br-own > b", "Kepemilikan bersama"],
  ["#br-budget > b", "Anggaran bersama"],
  ["#br-rewards > b", "Imbalan terprogram"],
  ["#br-rep > b", "Akses berdasarkan reputasi"],
  ["#br-sputnik > b", "Dibangun di atas Sputnik DAO"],
  ["#checks-title", 'Jangan percaya kami. <span class="dim">Browser Anda yang memeriksa.</span>'],
  ["#checks-why", "Agen yang diluncurkan lewat token memberi pemegangnya harga, bukan suara, dan meminta Anda percaya pada lencana \"TEE\" mereka. Di sini setiap klaim diperiksa dari halaman ini, terhadap NEAR dan Intel, tanpa server kami di tengahnya."],
  ["#ck-bylaws > b", "Ia hanya menjalankan yang dipilih anggota"],
  ["#ck-code > b", "Tak seorang pun mengubah aturan sendirian"],
  ["#ck-money > b", "Setiap pembayaran dihitung"],
  ["#loop-title", 'Cara koperasi<br /><span class="dim">menjalankan agennya</span>'],
  ["#live-title", 'Yang baru saja dilakukan koperasi, <span class="dim">on-chain</span>'],
  ["#members h2", 'Setiap anggota<br />memegang <span class="dim">satu suara.</span>'],
  ["#bylaws h2", 'Anggota<br />memegang <span class="dim">pikiran agen.</span>'],
  ["#bylaws .sub", "Prompt, model, harga, dan batas belanja agen adalah anggaran dasarnya. Versi baru perlu pemungutan suara anggota. Agen mencocokkan hash ini dengan konfigurasinya sebelum setiap pekerjaan, dan kontrak menolak tanda terima dengan anggaran dasar lain."],
  ["#work h2", 'Satu agen.<br /><span class="dim">Banyak pemilik.</span>'],
  ["#work .sub", "Agen mengambil pekerjaan berbayar di NEAR AI Agent Market, menjalankan inferensinya secara privat di NEAR AI Cloud, dan meninggalkan satu tanda terima on-chain per pekerjaan: harga, biaya inferensi, dan anggaran dasar yang dijalankannya."],
  ["#audit h2", 'Setiap pembayaran<br /><span class="dim">dihitung.</span>'],
  ["#audit .sub", "Agent Market membayar satu akun manusia, yaitu pengurus (steward). Pengurus wajib meneruskan setiap pembayaran ke koperasi, dengan jaminan yang dipertaruhkan. Siapa pun bisa memeriksa dua angka di kanan."],
  ["#shares h2", 'Sisa hasil usaha,<br />dibagi <span class="dim">menurut aturan.</span>'],
  ["#trust h2", 'Kepercayaan diraih,<br /><span class="dim">tugas demi tugas.</span>'],
  ["#commons h2", 'Kewajiban<br /><span class="dim">antaranggota.</span>'],
  [".rail .tag", null], // the rails' labels: by position below
];
const RAILS = ["Langsung", "Anggota", "Anggaran dasar", "Kerja", "Audit", "SHU", "Tugas & kepercayaan", "Bersama"];

const saved = new Map();
let current = "en";
/** The page's language now: "en" or "id". */
export const lang = () => current;
/** The English or the Indonesian text, by the page's language. */
export const t = (en, id) => (current === "id" ? id : en);
function apply(to) {
  for (const [sel, text] of ID) {
    const els = document.querySelectorAll(sel);
    els.forEach((el, i) => {
      if (!saved.has(el)) saved.set(el, el.innerHTML);
      const id = text ?? (sel === ".rail .tag" ? RAILS[i] : null);
      if (id !== null && id !== undefined) el.innerHTML = to === "id" ? id : saved.get(el);
    });
  }
  document.documentElement.lang = to;
  const changed = current !== to;
  current = to;
  btn.textContent = to === "id" ? "English" : "Bahasa Indonesia";
  btn.setAttribute("aria-label", to === "id" ? "Switch the page to English" : "Tampilkan halaman dalam Bahasa Indonesia");
  try { localStorage.setItem("kop-lang", to); } catch { /* private window: the choice is not kept */ }
  if (changed) window.dispatchEvent(new CustomEvent("koperasi:lang"));
}
const btn = document.createElement("button");
btn.type = "button";
btn.className = "lang-btn";
btn.addEventListener("click", () => apply(current === "id" ? "en" : "id"));
document.querySelector(".top-actions")?.prepend(btn);
let start = "en";
try { start = localStorage.getItem("kop-lang") ?? "en"; } catch { /* none kept */ } // English by default (a global project); Indonesian only when chosen
apply(start === "id" ? "id" : "en");
