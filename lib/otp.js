import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import nodemailer from "nodemailer";
import { db } from "./firebase.js";

/**
 * ===== OTP 2-STEP VERIFICATION (server-side only) =====
 *
 * ⚠️ REVISI PENTING (audit round 2):
 * Versi awal memakai Firebase custom claim `otpVerified:true` yang
 * ditempel PERMANEN ke akun user. Itu BUG: begitu true, klaim itu tetap
 * ada di token pada login berikutnya juga (logout -> login lagi tetap
 * "verified") -> OTP jadi bisa dilewati. Custom claims sudah TIDAK
 * dipakai lagi sama sekali di file ini.
 *
 * Sekarang status "sudah verifikasi" diikat ke SESI LOGIN yang sedang
 * aktif, bukan ke akun secara permanen, memakai `auth_time` dari
 * Firebase ID token. `auth_time` adalah klaim bawaan Firebase yang
 * DIPERBARUI OTOMATIS oleh Firebase Auth setiap kali user benar-benar
 * melakukan sign-in baru (signInWithPopup, signInWithEmailAndPassword,
 * createUserWithEmailAndPassword) — tapi TIDAK berubah hanya karena
 * token di-refresh/reload di sesi yang sama. Client tidak bisa memalsukan
 * nilai ini karena auth_time ada di dalam ID token yang ditandatangani
 * Firebase dan diverifikasi ulang di backend lewat
 * admin.auth().verifyIdToken().
 *
 * Jadi:
 * - Berhasil verifikasi OTP -> backend simpan verifiedAuthTime = auth_time
 *   sesi LOGIN INI di Firestore (otpSessions/{uid}).
 * - Setiap kali frontend mau tahu "apakah sesi ini sudah verified", backend
 *   membandingkan verifiedAuthTime yang tersimpan dengan auth_time token
 *   yang sedang dipakai SEKARANG (lihat checkSession()).
 * - Logout lalu login lagi -> Firebase menerbitkan auth_time BARU ->
 *   otomatis tidak sama dengan verifiedAuthTime lama -> OTP wajib lagi.
 * - Refresh halaman di sesi yang sama (belum logout) -> auth_time tetap
 *   sama -> kalau sudah pernah verified, tidak perlu OTP ulang; kalau
 *   belum, tetap wajib OTP (tidak ada bypass).
 *
 * Semua operasi kritikal (issueOtp, verifyOtp) dibungkus Firestore
 * transaction supaya request yang datang BERSAMAAN (concurrent resend,
 * concurrent verify) tidak bisa dobel-pakai OTP atau melewati
 * cooldown/rate-limit/attempts limit (race condition read-check-write).
 *
 * Koleksi baru: "otpSessions", 1 dokumen per uid Firebase. HANYA diakses
 * dari sini (Admin SDK/backend) — tidak pernah dari client Firestore SDK,
 * jadi tidak perlu rule client baru (default-deny existing sudah cukup).
 */

const OTP_COLLECTION = "otpSessions";
const OTP_TTL_MS = 5 * 60 * 1000;        // 5 menit
const RESEND_COOLDOWN_MS = 60 * 1000;    // 60 detik
const MAX_ATTEMPTS = 5;                  // percobaan kode salah maksimal per OTP aktif
const MAX_SENDS_PER_WINDOW = 6;          // anti-spam resend
const SEND_WINDOW_MS = 15 * 60 * 1000;   // window 15 menit

function generateOtp() {
  // 6 digit, cryptographically secure (bukan Math.random()).
  const n = crypto.randomInt(0, 1000000);
  return n.toString().padStart(6, "0");
}

function hashOtp(otp, salt) {
  // Bukan disimpan plaintext. scrypt built-in Node, tidak butuh dependency baru.
  return crypto.scryptSync(otp, salt, 64).toString("hex");
}

function maskEmail(email) {
  const [user, domain] = String(email).split("@");
  if (!user || !domain) return email;
  const visible = user.slice(0, 1);
  return `${visible}${"*".repeat(Math.max(user.length - 1, 3))}@${domain}`;
}

function otpRef(uid) {
  return db.collection(OTP_COLLECTION).doc(uid);
}

/**
 * Membuat & mengirim OTP baru untuk uid, dengan cooldown + rate-limit
 * yang dicek-dan-ditulis secara ATOMIK lewat Firestore transaction
 * (mencegah dua request resend paralel sama-sama lolos cooldown).
 *
 * `authTime` = klaim auth_time dari ID token yang sedang dipakai saat
 * request ini dibuat; disimpan di dokumen supaya verifyOtp() nanti bisa
 * memastikan kode ini memang diterbitkan untuk SESI LOGIN yang sama
 * dengan yang sedang mencoba verifikasi.
 *
 * Mengembalikan { ok, error, nextResendAt, emailMasked, expiresAt }.
 */
export async function issueOtp(uid, email, authTime) {
  const ref = otpRef(uid);
  const now = Date.now();
  const otp = generateOtp();
  const salt = crypto.randomBytes(16).toString("hex");
  const otpHash = hashOtp(otp, salt);

  let txResult;
  try {
    txResult = await db.runTransaction(async (t) => {
      const snap = await t.get(ref);
      const data = snap.exists ? snap.data() : null;

      if (data && data.lastSentAt && now - data.lastSentAt < RESEND_COOLDOWN_MS) {
        return {
          ok: false,
          error: "cooldown",
          nextResendAt: data.lastSentAt + RESEND_COOLDOWN_MS,
        };
      }

      // Reset counter kirim kalau window 15 menit sudah lewat.
      const windowStillValid = data && data.sendWindowStart && now - data.sendWindowStart < SEND_WINDOW_MS;
      const sendCount = windowStillValid ? (data.sendCount || 0) + 1 : 1;
      const sendWindowStart = windowStillValid ? data.sendWindowStart : now;

      if (sendCount > MAX_SENDS_PER_WINDOW) {
        return { ok: false, error: "too_many_requests" };
      }

      // verifiedAuthTime SENGAJA dipertahankan (bukan direset) — itu
      // menandai sesi login MANA yang terakhir kali lolos verifikasi,
      // terpisah dari status "challenge OTP yang sedang aktif sekarang".
      t.set(
        ref,
        {
          uid,
          emailMasked: maskEmail(email),
          otpHash,
          otpSalt: salt,
          authTime: authTime || null,
          expiresAt: now + OTP_TTL_MS,
          attempts: 0,
          maxAttempts: MAX_ATTEMPTS,
          challengeConsumed: false,
          consumedAt: null,
          lastSentAt: now,
          sendCount,
          sendWindowStart,
          verifiedAuthTime: data ? data.verifiedAuthTime || null : null,
        },
        { merge: false }
      );

      return { ok: true, nextResendAt: now + RESEND_COOLDOWN_MS, expiresAt: now + OTP_TTL_MS };
    });
  } catch (err) {
    console.error("issueOtp transaction error:", err);
    return { ok: false, error: "server_error" };
  }

  if (!txResult.ok) return txResult;

  const emailResult = await sendOtpEmail(email, otp);
  if (!emailResult.ok) {
    // Email gagal terkirim TAPI dokumen & cooldown sudah tersimpan (transaksi
    // di atas sudah commit) — ini disengaja: user tetap kena cooldown 60 detik
    // sebelum retry (anti-spam), tapi TIDAK terkunci permanen karena begitu
    // cooldown habis tombol "Kirim ulang kode" otomatis aktif lagi.
    return { ok: false, error: "email_failed", nextResendAt: txResult.nextResendAt };
  }

  return {
    ok: true,
    nextResendAt: txResult.nextResendAt,
    emailMasked: maskEmail(email),
    expiresAt: txResult.expiresAt,
  };
}

/**
 * Verifikasi kode OTP yang diinput user. Seluruh cek + tulis (attempts,
 * expired, single-use, match) dibungkus SATU Firestore transaction supaya
 * dua request verify yang datang bersamaan (mis. double klik / retry
 * jaringan) tidak bisa dua-duanya dianggap berhasil untuk kode yang sama.
 *
 * `authTime` = auth_time dari ID token yang sedang mencoba verifikasi.
 * Kalau tidak cocok dengan authTime yang tersimpan saat OTP ini
 * diterbitkan, berarti user sudah logout+login lagi di antara saat OTP
 * dikirim dan saat verifikasi dicoba — kode lama tidak boleh dipakai
 * untuk mengesahkan sesi login yang baru.
 *
 * Mengembalikan { ok, error, attemptsLeft }.
 */
export async function verifyOtp(uid, inputCode, authTime) {
  const ref = otpRef(uid);
  const now = Date.now();

  try {
    return await db.runTransaction(async (t) => {
      const snap = await t.get(ref);
      if (!snap.exists) return { ok: false, error: "not_found" };
      const data = snap.data();

      if (data.challengeConsumed) return { ok: false, error: "already_used" };
      if (now > data.expiresAt) return { ok: false, error: "expired" };
      if ((data.attempts || 0) >= (data.maxAttempts || MAX_ATTEMPTS)) {
        return { ok: false, error: "too_many_attempts" };
      }
      if (authTime && data.authTime && data.authTime !== authTime) {
        return { ok: false, error: "session_mismatch" };
      }

      const candidateHash = hashOtp(String(inputCode || "").trim(), data.otpSalt);

      // Perbandingan aman terhadap timing attack.
      const a = Buffer.from(candidateHash, "hex");
      const b = Buffer.from(data.otpHash, "hex");
      const isMatch = a.length === b.length && crypto.timingSafeEqual(a, b);

      if (!isMatch) {
        const attempts = (data.attempts || 0) + 1;
        t.update(ref, { attempts });
        return {
          ok: false,
          error: "invalid_code",
          attemptsLeft: Math.max((data.maxAttempts || MAX_ATTEMPTS) - attempts, 0),
        };
      }

      // Sukses -> kode ini langsung invalid (single use), dan sesi login
      // (authTime) ini ditandai terverifikasi.
      t.update(ref, {
        challengeConsumed: true,
        consumedAt: now,
        otpHash: null,
        otpSalt: null,
        verifiedAuthTime: authTime || null,
      });

      return { ok: true };
    });
  } catch (err) {
    console.error("verifyOtp transaction error:", err);
    return { ok: false, error: "server_error" };
  }
}

/**
 * Dipakai tiap kali frontend memuat/refresh halaman untuk menentukan
 * apakah SESI LOGIN YANG SEDANG AKTIF (diidentifikasi lewat authTime dari
 * ID token saat ini) sudah lolos OTP. Backend adalah satu-satunya sumber
 * kebenaran di sini — frontend tidak pernah dipercaya untuk menyatakan
 * dirinya sendiri "sudah verified".
 */
export async function checkSession(uid, authTime) {
  if (!authTime) return false;
  const snap = await otpRef(uid).get();
  if (!snap.exists) return false;
  const data = snap.data();
  return !!(data.verifiedAuthTime && data.verifiedAuthTime === authTime);
}

// ===== Asset GIF OTP (disediakan oleh pemilik toko, TIDAK dibuat di sini) =====
// File wajib ada di assets/otp-animation.gif (16:9) — asset visual ini SAMA
// PERSIS dengan yang dipakai Aliftzy Store (hanya nama file yang diubah agar
// tidak membawa branding lama; isi/byte GIF-nya tidak diubah/diganti sama
// sekali). Dibaca sebagai lampiran inline (Content-ID) supaya tampil di
// Gmail tanpa bergantung pada hosting eksternal.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OTP_GIF_PATH = path.join(__dirname, "..", "assets", "otp-animation.gif");
const OTP_GIF_CID = "panavibunga-otp-gif";

function loadOtpGifAttachment() {
  try {
    return {
      filename: "otp-animation.gif",
      content: fs.readFileSync(OTP_GIF_PATH),
      cid: OTP_GIF_CID,
      contentType: "image/gif",
    };
  } catch (err) {
    console.error(
      "Tidak dapat membaca assets/otp-animation.gif (pastikan file sudah ditambahkan ke repo):",
      err.message
    );
    return null;
  }
}

// URL halaman OTP existing di website, dipakai HANYA sebagai tujuan tombol
// "SALIN KODE" di email (link biasa, bukan JavaScript). TIDAK pernah membawa
// nilai OTP di query string — lihat catatan keamanan di buildOtpEmailHtml().
const SITE_URL =
  process.env.SITE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");

// REVISI: ikon di email diganti dari SVG data URI (base64) menjadi EMOJI
// biasa. Gmail webmail kerap memblokir/strip <img src="data:image/svg+xml...">
// karena kebijakan keamanannya terhadap data URI di HTML email, sehingga
// 4 ikon lama berisiko tampil sebagai broken-image icon. Emoji adalah teks
// biasa (bukan gambar) sehingga selalu tampil di semua klien Gmail tanpa
// risiko broken-image. Tidak ada SVG data URI baru yang ditambahkan.
const ICON_GREETING = "👋";
const ICON_CLOCK = "⏱️";
const ICON_LOCK = "🔒";
const ICON_COPY = "📋";

async function sendOtpEmail(email, otp) {
  // Gmail SMTP lewat App Password — kredensial dibaca dari environment
  // variable Vercel, TIDAK PERNAH di-hardcode di source code.
  const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
  const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
  const SMTP_USER = process.env.SMTP_USER;
  const SMTP_PASS = process.env.SMTP_PASS;

  if (!SMTP_USER || !SMTP_PASS) {
    console.error("SMTP_USER atau SMTP_PASS belum diset di environment variable Vercel");
    return { ok: false };
  }

  try {
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });

    const gifAttachment = loadOtpGifAttachment();

    await transporter.sendMail({
      from: `"PanaviBunga Store" <${SMTP_USER}>`,
      to: email,
      subject: "Kode Verifikasi PanaviBunga Store",
      html: buildOtpEmailHtml(otp),
      attachments: gifAttachment ? [gifAttachment] : [],
    });

    return { ok: true };
  } catch (err) {
    console.error("Gmail SMTP error:", err);
    return { ok: false };
  }
}

function buildOtpEmailHtml(otp) {
  // REVISI: OTP di email TIDAK LAGI diberi spasi ("471 797") — sekarang
  // ditampilkan persis apa adanya, 6 digit tanpa spasi ("471797"). Ini
  // murni perubahan presentation di HTML email; nilai `otp` yang dikirim
  // ke fungsi ini tetap OTP asli yang sama yang dipakai untuk hashing di
  // issueOtp() — tidak ada logic OTP/backend yang disentuh di sini.
  //
  // CATATAN KEAMANAN (tombol "SALIN KODE"): link ini HANYA mengarah ke
  // halaman website (SITE_URL) TANPA membawa nilai OTP apa pun di URL
  // (tidak ada ?otp=...). Arsitektur existing (lihat komentar di atas file
  // ini) sengaja TIDAK PERNAH mengirim OTP plaintext ke frontend — hanya
  // hash yang dicek di backend. Karena itu link ini murni navigasi ke
  // halaman OTP, bukan mekanisme auto-fill kode.
  const otpPageUrl = SITE_URL || "#";

  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>Kode Verifikasi PanaviBunga Store</title>
</head>
<body style="margin:0;padding:0;background:#05080e;font-family:'DM Sans',Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#05080e;padding:32px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width:420px;background:#0d1420;border:1px solid #16e5ff33;border-radius:20px;overflow:hidden;">

          <!-- Header -->
          <tr>
            <td style="padding:32px 32px 4px;text-align:center;">
              <div style="font-family:Arial,sans-serif;font-weight:900;font-size:19px;letter-spacing:2px;color:#16e5ff;">PANAVIBUNGA STORE</div>
              <div style="margin-top:6px;font-size:10.5px;letter-spacing:3px;color:#7d8a9c;">SECURITY VERIFICATION</div>
            </td>
          </tr>

          <!-- GIF OTP (assets/otp-animation.gif, dilampirkan sebagai inline CID attachment, 16:9 asli tanpa crop/stretch) -->
          <tr>
            <td style="padding:20px 20px 0;">
              <div style="border-radius:14px;overflow:hidden;background:#0a121c;border:1px solid #16e5ff26;">
                <img src="cid:${OTP_GIF_CID}" width="100%" alt="PanaviBunga Store" style="display:block;width:100%;height:auto;border:0;background:#0a121c;">
              </div>
            </td>
          </tr>

          <!-- Greeting -->
          <tr>
            <td style="padding:22px 32px 0;color:#e8edf5;font-size:15px;line-height:1.65;">
              <span style="margin-right:6px;">${ICON_GREETING}</span>Halo,<br><br>
              Kami menerima permintaan masuk ke akun <strong>PanaviBunga Store</strong> Anda.
              Untuk memastikan bahwa yang mencoba masuk benar-benar pemilik akun, masukkan kode verifikasi berikut.
            </td>
          </tr>

          <!-- OTP code + copy button -->
          <tr>
            <td style="padding:26px 32px 4px;text-align:center;">
              <div style="font-size:10.5px;letter-spacing:3px;color:#7d8a9c;margin-bottom:12px;">KODE VERIFIKASI ANDA</div>
              <div style="display:inline-block;padding:16px 30px;background:#0a121c;border:1px solid #16e5ff55;border-radius:12px;font-family:'Courier New',monospace;font-size:32px;font-weight:700;letter-spacing:6px;color:#16e5ff;">${otp}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:14px 32px 4px;text-align:center;">
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;">
                <tr>
                  <td style="border-radius:10px;background:#16e5ff14;border:1px solid #16e5ff40;">
                    <a href="${otpPageUrl}" target="_blank" style="display:block;padding:11px 26px;font-family:Arial,sans-serif;font-size:12.5px;font-weight:700;letter-spacing:1.5px;color:#16e5ff;text-decoration:none;">
                      <span style="margin-right:6px;">${ICON_COPY}</span>SALIN KODE
                    </a>
                  </td>
                </tr>
              </table>
              <div style="margin-top:10px;font-size:11.5px;color:#7d8a9c;">Tekan &amp; tahan kode di atas untuk menyalin, atau tekan tombol untuk membuka halaman verifikasi.</div>
            </td>
          </tr>
          <tr>
            <td style="padding:12px 32px 0;text-align:center;font-size:12px;color:#8a96a8;">
              <span style="margin-right:5px;">${ICON_CLOCK}</span>Kode ini hanya berlaku selama 5 menit.
            </td>
          </tr>

          <!-- Security notice -->
          <tr>
            <td style="padding:22px 32px 26px;color:#aab4c2;font-size:12.5px;line-height:1.75;">
              <div style="height:1px;background:#ffffff14;margin-bottom:18px;"></div>
              Jika Anda tidak merasa melakukan percobaan login ini, abaikan email ini dan jangan berikan kode ini kepada siapa pun.
              Tim PanaviBunga Store tidak akan pernah meminta kode OTP Anda melalui chat, WhatsApp, Telegram, maupun media lainnya.
              <br><br>
              <span style="margin-right:5px;">${ICON_LOCK}</span>Kode hanya dapat digunakan satu kali dan otomatis tidak berlaku setelah 5 menit.
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:16px 32px 28px;border-top:1px solid #ffffff12;text-align:center;color:#5b6576;font-size:11px;">
              © 2026 PanaviBunga Store — Secure Authentication System
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
