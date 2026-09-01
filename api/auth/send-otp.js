import admin from "firebase-admin";
import "../../lib/firebase.js"; // memastikan admin.initializeApp() sudah jalan
import { issueOtp } from "../../lib/otp.js";

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
    const email = decoded.email;

    if (!email) {
      return res.status(400).json({ error: "Akun tidak memiliki email" });
    }

    const result = await issueOtp(uid, email, decoded.auth_time);

    if (!result.ok) {
      if (result.error === "cooldown") {
        return res.status(429).json({
          error: "Tunggu sebelum meminta kode baru",
          nextResendAt: result.nextResendAt,
        });
      }
      if (result.error === "too_many_requests") {
        return res.status(429).json({ error: "Terlalu banyak permintaan kode, coba lagi nanti" });
      }
      if (result.error === "email_failed") {
        return res.status(502).json({
          error: "Gagal mengirim email verifikasi, coba lagi setelah cooldown",
          nextResendAt: result.nextResendAt,
        });
      }
      return res.status(500).json({ error: "Gagal membuat kode verifikasi" });
    }

    return res.status(200).json({
      success: true,
      emailMasked: result.emailMasked,
      nextResendAt: result.nextResendAt,
      expiresAt: result.expiresAt,
    });
  } catch (err) {
    console.error("send-otp error:", err);
    return res.status(500).json({ error: "Terjadi kesalahan pada server" });
  }
}
