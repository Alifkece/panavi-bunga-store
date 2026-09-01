import admin from "firebase-admin";
import "../../lib/firebase.js"; // memastikan admin.initializeApp() sudah jalan
import { checkSession } from "../../lib/otp.js";

/**
 * Dipanggil frontend setiap onAuthStateChanged (termasuk saat refresh)
 * untuk bertanya ke backend: "apakah sesi login yang sedang aktif ini
 * sudah lolos OTP?" Backend menjawab dengan membandingkan auth_time dari
 * ID token yang sedang dipakai terhadap verifiedAuthTime yang tersimpan
 * di Firestore (lihat lib/otp.js checkSession()).
 *
 * Frontend TIDAK PERNAH menyimpan/mempercayai status "verified" dari
 * dirinya sendiri (bukan di localStorage/sessionStorage sebagai sumber
 * kebenaran) — endpoint ini yang jadi satu-satunya sumber kebenaran.
 */
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

    const verified = await checkSession(decoded.uid, decoded.auth_time);
    return res.status(200).json({ verified });
  } catch (err) {
    console.error("check-session error:", err);
    // Gagal-aman: kalau terjadi error server, anggap BELUM verified
    // supaya tidak pernah membuka akses tanpa OTP.
    return res.status(200).json({ verified: false });
  }
}
