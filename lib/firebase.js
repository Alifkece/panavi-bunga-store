import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";

if (!admin.apps.length) {

  const key = process.env.FIREBASE_KEY;

  if (!key) {
    throw new Error("FIREBASE_KEY belum ada di Vercel");
  }

  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(key)
    )
  });

}

// BUG FIX (deployment): admin.firestore() tanpa argumen selalu mencari
// database bernama "(default)". Database Firestore project ini ternyata
// dibuat dengan ID "panavibunga-store" (bukan "(default)"), sehingga semua
// request Admin SDK gagal dengan gRPC "5 NOT_FOUND". getFirestore(app, id)
// dari modular API "firebase-admin/firestore" adalah cara resmi yang
// didukung firebase-admin v11.9+ untuk menunjuk ke database bernama custom
// — memperbaikinya tanpa perlu membuat database baru atau mengubah apa pun
// di Firebase Console.
export const db = getFirestore(admin.app(), "panavibunga-store");
