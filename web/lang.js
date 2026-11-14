// Bahasa Indonesia for the page's own words (the co-ops it is for are Indonesian villages). The headings, the hero, the
// sections' explanations and the navigation switch; what the page reads from the chain stays as the chain says it.
// The choice is remembered in this browser only; the page opens in English unless the visitor chose Indonesian.
// ponytail: a selector → text table, not an i18n library (it also holds cert.html's and coops.html's fixed text; a
// selector that matches nothing on a page is skipped). What is written from the chain (app.js, wallet.js, cert.html,
// coops.html) calls t(en, id) and is written again, from the data already read, on the "koperasi:lang" event.
const ID = [
  ['nav[aria-label="Sections"] a[href="#members"]', "Anggota"],
  ['nav[aria-label="Sections"] a[href="#bylaws"]', "Anggaran dasar"],
  ['nav[aria-label="Sections"] a[href="#work"]', "Kerja"],
  ['nav[aria-label="Sections"] a[href="#audit"]', "Audit"],
  ['nav[aria-label="Sections"] a[href="#shares"]', "SHU"],
  ['nav[aria-label="Sections"] a[href="#trust"]', "Tugas"],
  ['nav[aria-label="Sections"] a[href="#commons"]', "Bersama"],
  ['nav[aria-label="Sections"] a[href="#live"]', "Langsung"],
  [".top-actions a.quiet:not(#run-demo):not(#docs-link)", "Kode sumber"],
  ["#docs-link", "Panduan"],
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
  ["#ck-tee > b", "AI berjalan tersegel di dalam TEE"],
  ["#ck-tee > p", "NEAR AI Cloud membuktikan servernya mesin Intel TDX asli, terikat pada angka acak yang hanya diketahui browser Anda."],
  ["#ck-attacks > b", "Serangan ditolak on-chain"],
  ["#card-tee > b", "Agen berjalan di TEE (Shade Agent)"],
  ["#card-proposal > b", "Agen mengusulkan, anggota memutuskan"],
  ["#card-credit > b", "Biro kredit milik koperasi-koperasi"],
  ["#card-errors > b", "Agen keliru, anggota mengoreksinya"],
  ["#brief > .sub", 'Setiap baris dibaca dari testnet NEAR saat halaman ini dimuat. Untuk pemeriksaan langkah demi langkah, lihat <a href="https://github.com/PugarHuda/koperasi/blob/main/JUDGE.md">JUDGE.md</a>.'],
  // a span the check's verdict replaces, so once the attacks are read this matches nothing (same for #live-state)
  ["#ck-attacks .ck-out > .wait", "Membaca transaksi serangan…"],
  ["#versus caption", 'Bedanya dengan cara lain memiliki agen AI <span class="muted">(sumber di docs/DETAILS.md)</span>'],
  ["#versus thead tr", '<th scope="col"></th><th scope="col">Agen yang diluncurkan lewat token<br><span class="muted">mis. Virtuals, ai16z</span></th><th scope="col">Kerangka kerja agen<br><span class="muted">mis. Olas, tutorial NEAR Shade</span></th><th scope="col">Koperasi</th>'],
  ["#versus tbody", `<tr><th scope="row">Siapa yang memutuskan apa yang dikerjakan agen</th><td>Pengembang; pemegang token memilih menurut jumlah tokennya, itu pun kalau ada</td><td>Operatornya</td><td><strong>Anggota, masing-masing satu suara; prompt, model, dan harga dikunci dengan hash</strong></td></tr>
            <tr><th scope="row">Bukti apa yang berjalan</th><td>Klaim di situs web</td><td>Atestasi TEE yang diperiksa operator</td><td><strong>Diverifikasi ulang oleh agen dalam satu jam sebelum setiap pekerjaan, dan oleh Anda, di halaman ini, dengan nonce Anda sendiri</strong></td></tr>
            <tr><th scope="row">Ke mana uangnya</th><td>Ke pemegang token, hanya lewat harga token</td><td>Ke operator; imbalan staking</td><td><strong>Ke kas DAO; setiap anggota menagih bagiannya menurut aturan</strong></td></tr>
            <tr><th scope="row">Reputasi</th><td>Tidak ada; jumlah token menggantikannya</td><td>Tidak termasuk</td><td><strong>Diraih tugas demi tugas, tidak bisa dipindahtangankan, dan dibawa ke koperasi saudara yang diakui anggota (paspor)</strong></td></tr>
            <tr><th scope="row">Saat pembeli menyengketakan hasil kerja</th><td>Tidak ada jalan keluar</td><td>Operator yang memutuskan</td><td><strong>Juri dari anggota yang bereputasi baik, diundi menurut bobot reputasi (pilihan anggota), mendengar kedua pihak; banding ke seluruh anggota</strong></td></tr>
            <tr><th scope="row">Manusia di tengah</th><td>Dipercaya</td><td>Dipercaya</td><td><strong>Menyetor jaminan, diaudit on-chain, jaminannya bisa dipotong lewat pemungutan suara atau oleh siapa pun begitu pendapatan terlambat 7 hari</strong></td></tr>`],
  ["#live > .sub", "Setiap perubahan yang dibuat kontrak adalah event NEP-297 standar. Daftar ini membacanya dari NEAR saat anggota bertindak: indexer NearBlocks menemukan transaksinya, RPC memberikan event-nya, dan setiap event dicocokkan dengan skema kontrak sebelum ditampilkan."],
  ["#live-state > .wait", "Membaca transaksi terbaru…"],
  ["#members .split .sub", "Keanggotaan adalah peran <code>member</code> di Sputnik DAO koperasi; kontrak membacanya langsung dari DAO. Simpanan adalah NEAR yang dipertaruhkan setiap anggota untuk inferensi agen; poin kontribusi adalah apa yang mereka bangun untuknya, dibagi dua di setiap pembagian SHU agar kerja terbaru paling dihitung."],
  ["#members .pick > span", "Pilih anggota"],
  ["#work .cta-row .btn:not(.ghost)", 'Jalankan demo <span aria-hidden="true">→</span>'],
  ["#contract-link", 'Baca kontraknya <span aria-hidden="true">→</span>'], // app.js sets only its href
  ["#records thead tr", '<th scope="col">Kontributor</th><th scope="col" class="num">Selesai</th><th scope="col">Dipercaya</th><th scope="col">Asal setiap poin</th>'],
  ["#commons-sub", "Anggota menjanjikan jasa kepada koperasi (voucher komitmen, seperti pool Sarafu di Kenya); siapa pun yang menagih janji itu menyatakan apakah janjinya ditepati. Sengketa pembeli dibawa ke pengadilan koperasi: tiga anggota yang bereputasi baik, diundi menurut bobot reputasi (pilihan anggota, #150); dua di antaranya harus membenarkan sengketa itu agar pembeli mendapat pengembalian dana. Janji yang ditepati dan yang diingkari, tugas juri, dan pemotongan jaminan membentuk kedudukan setiap anggota, dan hanya anggota yang bereputasi baik yang duduk sebagai juri."],
  ["#join .cli > summary", "Lebih suka baris perintah?"],
  ["#join > a.btn", 'Dirikan koperasi Anda sendiri <span aria-hidden="true">→</span>'],
  // cert.html (a member's work record)
  ["#cert-sub", "Setiap baris di bawah dibaca dari kontrak dan DAO koperasi di NEAR, saat ini, di browser Anda. Tidak ada yang diketik oleh anggota maupun oleh kami: tugas adalah usulan DAO yang sudah dibayar, janji dikonfirmasi oleh anggota yang menagihnya, putusan juri adalah catatan kontrak sendiri. Bagikan tautan ini sebagai bukti kerja (mengikuti Hypercerts: siapa mengerjakan apa, bisa dilacak)."],
  ["#cert-acct", "Akun"],
  ["#cert-form button", "Tampilkan"],
  ["#cert-sum-t caption", "Ringkasan"],
  ["#cert-work caption", 'Kerja berbayar <span class="muted">(setiap baris menyebut tugas atau usulan DAO yang membayarnya)</span>'],
  ["#cert-work thead tr", '<th scope="col">Sumber</th><th scope="col">Apa</th><th scope="col" class="num">Dibayar</th>'],
  ["#cert-pledges caption", 'Janji kepada koperasi <span class="muted">(dikonfirmasi oleh siapa pun yang menagihnya)</span>'],
  ["#cert-pledges thead tr", '<th scope="col">Janji</th><th scope="col">Ditagih oleh</th><th scope="col">Ditepati?</th>'],
  ["#cert-juries caption", "Tugas juri di pengadilan koperasi"],
  ["#cert-juries thead tr", '<th scope="col">Perkara</th><th scope="col">Putusan</th><th scope="col">Hasil</th>'],
  ["#cert-back", "Kembali ke koperasi"],
  // coops.html (every co-op on this code, and their federation)
  ["#coops-title", "Koperasi dengan kode ini"],
  ["#coops-sub", "Setiap baris adalah koperasi tersendiri (dengan Sputnik DAO, kontrak, dan akun agennya sendiri), dibaca dari testnet NEAR saat ini, di browser Anda. Menjalankan npm run deploy mendirikan satu lagi. Hanya koperasi unggulan yang ditampilkan di halaman utama; sisanya koperasi uji milik pembuatnya, ditampilkan apa adanya."],
  ["#coops caption", 'Koperasi <span class="muted">(koperasi yang kontraknya masih punya kunci full-access bisa diubah kodenya tanpa pemungutan suara)</span>'],
  ["#coops thead tr", '<th scope="col">Koperasi</th><th scope="col" class="num">Anggota</th><th scope="col" class="num">Pekerjaan</th><th scope="col" class="num">Pembagian SHU</th><th scope="col">Anggaran dasar</th><th scope="col">Mengakui</th><th scope="col">Kode diubah oleh</th>'],
  ["#network h2", "Federasi koperasi"],
  ["#network .sub", "Koperasi sekunder, sebagaimana diizinkan hukum perkoperasian Indonesia (UU 25/1992 pasal 15–16): Sputnik DAO tanpa modifikasi yang anggotanya hanya DAO koperasi, satu koperasi satu suara. Sebuah koperasi memilih di sana hanya jika anggotanya sendiri menyetujui usulan yang memberikan suara itu. Koperasi yang saling mengakui menghitung catatan kerja satu sama lain (paspor)."],
  ["#resolutions caption", 'Resolusi <span class="muted">(setiap suara diberikan lewat usulan DAO koperasi anggota itu sendiri)</span>'],
  ["#resolutions thead tr", '<th scope="col">#</th><th scope="col">Resolusi</th><th scope="col">Suara</th><th scope="col">Status</th>'],
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
