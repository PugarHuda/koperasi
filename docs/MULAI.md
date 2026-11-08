# Koperasi: mulai di sini

**Agen AI yang dimiliki dan diatur oleh anggotanya di NEAR. Satu anggota, satu suara.**

Terjemahan bahasa Indonesia dari bagian awal [README](../README.md). Kalau ada perbedaan, yang berlaku adalah README
(bahasa Inggris) dan, di atas segalanya, data on-chain.

## Cek dalam 2 menit (tanpa wallet, tanpa kunci)

| Lakukan | Yang terlihat |
|---|---|
| Buka **https://koperasi-kohl.vercel.app** | Di bawah judul, *Don't trust us*: file anggaran dasar (by-laws) di-hash dan cocok dengan yang divoting anggota, kontrak tidak punya full-access key dan menjalankan kode yang disetujui lewat voting, serta audit. Klik *Verify z-ai/glm-5.3-flash with your own nonce* untuk memeriksa atestasi Intel TDX + GPU model itu dengan nonce buatan browser Anda sendiri |
| Gulir ke **06 Tasks & trust** | Tiga tingkat yang divoting anggota: tanpa voting sampai 0,1 NEAR untuk kontributor yang sudah dipercaya, paling banyak 0,2 NEAR per hari per pemberi tugas; satu anggota lain sampai 0,5 NEAR; di atas itu bounty DAO. Setiap tugas dibayar dari kas DAO lewat proposal Transfer yang tautannya ada di tabel |
| `npm install && npm run verify` | Setiap klaim README dibaca dari testnet, hanya baca: anggaran dasar = hasil voting, kode = hasil voting, 0 full-access key, kunci agen hanya bisa `record_receipt`, anggota = role DAO, role `tasks` kontrak hanya boleh mengajukan dan menyetujui transfer, setiap poin catatan kerja menunjuk ke pembayaran yang nyata. Diakhiri dengan `every claim checks out` |

## Cara kerjanya, singkat

- **Simpanan tidak pernah dibelanjakan.** Anggota men-stake NEAR; imbal hasil staking membayar inferensi agen. Pokoknya
  tetap milik anggota.
- **Anggota memegang "pikiran" agen.** Prompt, model, alat, harga, dan batas belanja agen adalah anggaran dasarnya. Semua
  itu hanya bisa berubah lewat voting di Sputnik DAO, dan agen maupun kontrak menolak bekerja dengan konfigurasi lain
  (sha256 on-chain).
- **Tugas dibayar dengan kepercayaan yang diperoleh.** Uang tetap di kas DAO. Kontrak memegang role DAO `tasks` yang hanya
  bisa mengajukan dan menyetujui proposal transfer, sesuai aturan yang divoting anggota. Kepercayaan dihitung dari
  pemberi tugas yang *berbeda*, jadi dua teman tidak bisa saling membuat "terpercaya". Anggota yang menyelesaikan tugas
  mendapat poin kontribusi, yang ikut menentukan bagian keuntungannya.
- **Uangnya diaudit.** Audit publik membandingkan pendapatan agen dengan yang benar-benar masuk ke kas koperasi;
  anggota bisa memotong jaminan (bond) steward lewat voting.

## Jujur soal batasannya

Belum ada pekerjaan nyata dari Agent Market: keempat kuitansi di showcase berasal dari `npm run demo`. Kas DAO belum
berisi USDC. Akun demo anggota dipegang oleh pembuat proyek. Rinciannya ada di bagian *Trust assumptions* di README.
