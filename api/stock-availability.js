import admin from "firebase-admin";
import "../lib/firebase.js"; // memastikan admin.initializeApp() sudah jalan

/**
 * Endpoint READ-ONLY, publik (tidak butuh Authorization header) — sengaja
 * dibuat karena Firestore Rules PanaviBunga membatasi baca collection
 * "stock" hanya untuk Admin (collection itu berisi kredensial akun:
 * email/password/loginUrl). Endpoint ini memakai Admin SDK di server untuk
 * menghitung stok tersedia per productId+packageName, lalu HANYA
 * mengembalikan angka agregat — field kredensial asli tidak pernah ikut
 * terkirim ke browser.
 *
 * Ini BUKAN payment/merchant backend — tidak menyentuh order, tidak
 * membuat/mengubah status pembayaran apa pun. Tetap berada di dalam
 * project Vercel PanaviBunga Store yang sama (bukan backend terpisah),
 * sesuai permintaan "OTP server-side tetap satu project Store" yang
 * berlaku juga untuk endpoint pembantu non-payment seperti ini.
 */
export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const db = admin.firestore();
    const snap = await db.collection("stock").get();

    const counts = {};
    snap.forEach((docSnap) => {
      const d = docSnap.data();
      const key = `${d.productId || ""}::${d.packageName || ""}`;
      if (!counts[key]) counts[key] = { total: 0, available: 0 };
      counts[key].total += 1;
      if (!d.sold) counts[key].available += 1;
    });

    const data = Object.entries(counts).map(([key, c]) => {
      const [productId, packageName] = key.split("::");
      return {
        productId,
        packageName: packageName || null,
        availableCount: c.available,
        totalCount: c.total,
      };
    });

    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error("stock-availability error:", err);
    return res.status(500).json({ success: false, data: [] });
  }
}
