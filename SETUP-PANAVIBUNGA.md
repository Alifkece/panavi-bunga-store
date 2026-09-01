# PanaviBunga Store — Setup

Project baru, terpisah total dari Aliftzy Store. Ikuti checklist ini sebelum deploy.

## 1. Ganti asset QRIS (WAJIB)

`assets/qris.png` saat ini adalah **placeholder** (bukan QRIS asli). Ganti file
ini dengan gambar QRIS statis milik Anda sendiri sebelum go-live — nama file
harus tetap `qris.png`, atau ubah `QRIS_IMAGE_PATH` di `js/app.js` kalau Anda
memakai nama lain.

## 2. Isi nomor WhatsApp

Buka `js/app.js`, cari:

```js
const OWNER_WHATSAPP_NUMBER = '62xxxxxxxxxx';
```

Ganti dengan nomor WhatsApp PanaviBunga Store (format internasional tanpa
`+`, contoh: `6281234567890`). Dipakai untuk tombol "Kirim Bukti Transaksi"
dan link paket Reseller/Owner.

## 3. Firebase Console (project `panavibunga-store`)

- [ ] Aktifkan **Authentication** → provider Email/Password dan Google.
- [ ] Deploy `firestore.rules` (di root repo ini) ke project `panavibunga-store`
      — sudah diisi dengan admin email `panavi@my.id`, tinggal deploy.
- [ ] **Daftarkan akun `panavi@my.id`** lewat halaman Register di Store (atau
      Firebase Console → Authentication → Add user). Rules hanya mengenali
      email dari akun yang SUDAH ADA — tidak membuatkan akunnya otomatis.
- [ ] Buat Firestore collections kosong: `products`, `orders`, `stock`,
      `settings`, `songs` (opsional), `announcements` (opsional) — atau
      biarkan terbentuk otomatis saat Admin pertama kali menambah data.
- [ ] Aktifkan **Storage** kalau Admin akan upload gambar produk.

### Cara mendapatkan `FIREBASE_KEY` (Service Account)

1. Buka [Firebase Console](https://console.firebase.google.com) → pilih
   project **panavibunga-store**.
2. Klik ikon gerigi (⚙️) di sidebar kiri atas → **Project settings**.
3. Buka tab **Service accounts**.
4. Klik tombol **Generate new private key** → konfirmasi.
5. Sebuah file `.json` otomatis terdownload ke komputer Anda (isinya
   kredensial rahasia — JANGAN dibagikan/di-commit ke Git).
6. Buka file itu dengan text editor, **copy SELURUH isinya apa adanya**
   (satu blok JSON utuh, dari `{` sampai `}`).
7. Paste isi itu sebagai VALUE dari env var `FIREBASE_KEY` di Vercel (lihat
   langkah 4 di bawah) — tidak perlu diformat ulang, Vercel menerima string
   panjang termasuk yang mengandung baris baru.

## 4. Vercel Environment Variables

Buka project Vercel PanaviBunga Store → **Settings → Environment Variables**,
tambahkan (untuk Production, dan Preview kalau perlu):

| Key | Isi |
|---|---|
| `FIREBASE_KEY` | Isi JSON service account dari langkah 3 di atas |
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `465` |
| `SMTP_USER` | `ranialif16@gmail.com` |
| `SMTP_PASS` | Gmail App Password 16 digit (bukan password akun Gmail biasa) |
| `SITE_URL` | URL production Vercel Anda (opsional, dipakai tombol "SALIN KODE" di email OTP) |

**Jangan pernah** commit nilai-nilai ini ke Git. File ini (`SETUP-PANAVIBUNGA.md`)
sengaja TIDAK menyertakan nilai App Password/service account yang sebenarnya
— isi manual langsung di dashboard Vercel.

## 5. Seed produk awal

12 produk seed sudah ada langsung di kode (`getDefaultProducts()` di
`js/app.js`) sebagai fallback kalau Firestore `products` masih kosong. Untuk
produk permanen, tambahkan lewat PanaviBunga Admin setelah Admin online.

## 6. Deploy — tanpa install manual

Tidak perlu menjalankan `npm install` sendiri. Ada 2 cara deploy, keduanya
otomatis menginstall dependency (`firebase-admin`, `nodemailer`) saat build:

**A. Lewat Vercel Dashboard (paling mudah):**
1. Push/upload folder ini ke repository GitHub baru (terpisah dari repo
   Aliftzy Store).
2. Di [vercel.com](https://vercel.com) → **Add New → Project** → import
   repo tersebut.
3. Framework preset: biarkan **Other** (situs ini statis + serverless
   functions, tidak butuh build command khusus).
4. Isi Environment Variables (langkah 4) SEBELUM klik Deploy.
5. Klik **Deploy** — Vercel otomatis install dependency & menjalankan
   semuanya, tidak ada langkah manual tambahan di sisi Anda.

**B. Lewat Vercel CLI:**
```
vercel --prod
```
(Vercel CLI juga otomatis install dependency di server build-nya — Anda
tidak perlu `npm install` di komputer sendiri sama sekali.)

Deploy sebagai project **baru** di Vercel (nama disarankan: `panavibunga-store`),
JANGAN deploy ke project Vercel Aliftzy yang lama.

## Yang sudah diubah dari Aliftzy Store (ringkas)

- Firebase project baru (`panavibunga-store`), config terisi di `js/firebase-config.js`.
- OTP wajib untuk SEMUA sesi login baru (termasuk baru saja register & login Google) — tidak ada bypass.
- OTP tetap server-side (Vercel Functions di `api/auth/`), email lewat Gmail SMTP (`SMTP_*` env vars).
- Payment gateway lama (Casaku) dan backend `aliftzy-backend.vercel.app` dihapus total.
- Checkout sekarang: buat order `PENDING` langsung ke Firestore → tampilkan QRIS statis → tombol "Kirim Bukti Transaksi" ke WhatsApp. Tidak ada QR yang digambar/dibuat secara dinamis, tidak ada auto-konfirmasi pembayaran.
- Endpoint baru `/api/stock-availability` (read-only, agregat) menggantikan pemanggilan backend lama untuk menampilkan stok ke publik.
- UI/UX/layout/animasi/responsive dipertahankan sama seperti Aliftzy Store — hanya branding & backend yang berubah.
