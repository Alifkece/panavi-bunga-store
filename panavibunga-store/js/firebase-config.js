// ===== FIREBASE CONFIG & INIT (PanaviBunga Store) =====
// Catatan: apiKey Firebase di bawah ini MEMANG publik by design (bukan secret).
// Web apps Firebase selalu mengirim config ini ke browser klien.
// Yang menjaga keamanan data adalah Firestore Security Rules (diatur di Firebase Console),
// bukan menyembunyikan config ini. Jangan taruh secret/API key lain (mis. SMTP_PASS) di sini.
//
// Project ini SENGAJA terpisah total dari Firebase project Aliftzy Store lama —
// project ID, auth domain, dan semua kredensial di bawah adalah milik
// "panavibunga-store", bukan hasil copy dari project lama.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAWW7qGBLd8J19Fx6juROxt5DRKweaEB8",
  authDomain: "panavibunga-store.firebaseapp.com",
  projectId: "panavibunga-store",
  storageBucket: "panavibunga-store.firebasestorage.app",
  messagingSenderId: "144096763144",
  appId: "1:144096763144:web:6808d3de4a36660e88a0bd",
  measurementId: "G-722GX6JQ28"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const googleProvider = new GoogleAuthProvider();

export { app, auth, db, googleProvider };
