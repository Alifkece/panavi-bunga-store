import admin from "firebase-admin";
import "../../lib/firebase.js"; // memastikan admin.initializeApp() sudah jalan
import { verifyOtp } from "../../lib/otp.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!idToken) {
      return res.status(401).json({ error: "Token tidak ditemukan" });
    }

    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch (e) {
      return res.status(401).json({ error: "Token tidak valid" });
    }

    const uid = decoded.uid;

    let body = "";
    await new Promise((resolve) => {
      req.on("data", (chunk) => (body += chunk));
      req.on("end", resolve);
    });
    const parsed = JSON.parse(body || "{}");
    const code = String(parsed.code || "").trim();

    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: "Kode harus 6 digit angka" });
    }

    // REVISI (audit round 2): verifikasi TIDAK LAGI menempelkan custom
    // claim permanen ke akun (mis. otpVerified:true di Firebase Auth user
    // record) — itu bug: klaim itu akan tetap ada di token pada login
    // berikutnya, membuat OTP bisa dilewati setelah logout+login lagi.
    // Sekarang verifyOtp() hanya menandai SESI LOGIN INI (diidentifikasi
    // lewat decoded.auth_time) sebagai verified di Firestore. Sesi login
    // baru (auth_time baru, mis. setelah logout) otomatis tidak dianggap
    // verified — lihat lib/otp.js checkSession() dan api/auth/check-session.js.
    const result = await verifyOtp(uid, code, decoded.auth_time);

    if (!result.ok) {
      const map = {
        not_found: "Sesi verifikasi tidak ditemukan, minta kode baru",
        already_used: "Kode sudah digunakan, minta kode baru",
        expired: "Kode sudah kedaluwarsa, minta kode baru",
        too_many_attempts: "Terlalu banyak percobaan salah, minta kode baru",
        invalid_code: "Kode verifikasi salah",
        session_mismatch: "Sesi login berubah, minta kode baru",
        server_error: "Terjadi kesalahan pada server, coba lagi",
      };
      return res.status(400).json({
        error: map[result.error] || "Verifikasi gagal",
        code: result.error,
        attemptsLeft: result.attemptsLeft,
      });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("verify-otp error:", err);
    return res.status(500).json({ error: "Terjadi kesalahan pada server" });
  }
}
