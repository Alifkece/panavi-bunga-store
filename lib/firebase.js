import admin from "firebase-admin";

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

export const db = admin.firestore();
