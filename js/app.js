import { auth, db } from "./firebase-config.js";
import { createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged, updateProfile, GoogleAuthProvider, signInWithPopup } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { collection, doc, getDoc, getDocs, setDoc, serverTimestamp, query, where, orderBy, limit } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

let currentUser = null;
let products = [];
let songs = [];
let storeProfile = { avatarUrl: "" };
let pendingImgDataUrl = "";
let pendingProductImgDataUrl = "";
let currentOrderLink = "";
let currentOrderPayment = null; // { amount, username, whatsapp } - untuk order QRIS statis
let currentOrderWhatsapp = ''; // nomor WA yang sedang diketik/dipakai user di modal order aktif
let currentOrderProduct = null;
let currentOrderPackages = [];
let currentSelectedPackageIndex = 0;
let currentTrackIdx = 0;
let audioPlayer = null;
let isPlaying = false;
let stockItems = [];
let stockFilter = 'all';
let myOrders = [];
let stockPollTimer = null;
let currentHomeTab = 0;

// ===== 2-STEP LOGIN (Email OTP) STATE =====
// Google login TIDAK langsung membuka website — lihat onAuthStateChanged +
// runOtpGate() di bawah. currentUser hanya dianggap "benar-benar login"
// setelah backend (/api/auth/check-session) menyatakan sesi login ini
// verified. TIDAK memakai Firebase custom claim (sengaja dihapus — lihat
// catatan di runOtpGate) supaya status verifikasi tidak pernah "menempel"
// permanen ke akun dan terbawa ke sesi login berikutnya.
const googleProvider = new GoogleAuthProvider();
let otpVerified = false;
let otpGateUid = null;
let otpCooldownInterval = null;
let otpNextResendAt = 0;
let otpBusy = false;

// BUG FIX (audit round 3): "Berhasil masuk" tidak lagi ditampilkan langsung
// setelah signInWithEmailAndPassword/signInWithPopup/createUserWithEmailAndPassword
// berhasil — itu hanya berarti Firebase Auth berhasil, BUKAN berarti alur
// login sudah selesai (masih ada OTP gate di belakangnya). Sekarang
// handleLogin/handleGoogleLogin/handleRegister/handleVerifyOtp hanya
// menaikkan flag ini; notifikasi "Berhasil masuk" baru benar-benar
// ditampilkan oleh runOtpGate() TEPAT setelah halaman utama (Store) resmi
// ditampilkan (verified === true), supaya urutan selalu: Firebase Auth ->
// OTP Check -> OTP Verification (jika perlu) -> Session Confirmation ->
// Navigation ke Store -> baru Success Notification.
let pendingAuthSuccessNotif = false;

// BUG FIX (audit round 3): race condition onAuthStateChanged. Setiap kali
// callback ini terpanggil (login, logout, login lagi secara cepat), sebuah
// "generasi" baru dibuat. runOtpGate() yang berjalan untuk generasi LAMA
// mengecek ulang authGeneration di setiap titik setelah `await` — kalau
// sudah tidak sama lagi (artinya ada auth event lebih baru yang terjadi di
// tengah proses), sisa proses generasi lama dihentikan (tidak mengubah UI,
// tidak melakukan redirect). Ini mencegah hasil check-session/verify dari
// sesi login yang sudah ditinggalkan (mis. setelah user keburu logout lalu
// login ulang dengan akun lain) tiba-tiba mengubah tampilan sesi yang aktif
// sekarang.
let authGeneration = 0;

// BUG FIX (audit round 3): request timeout. Semua request ke endpoint OTP
// (/api/auth/check-session, /api/auth/send-otp, /api/auth/verify-otp) kini
// dibatasi waktu tunggunya lewat AbortController supaya tidak pernah terjadi
// infinite loading kalau server/koneksi macet. Timeout DIPERLAKUKAN SEBAGAI
// GAGAL (fail closed) — tidak pernah dianggap sebagai "OTP verified".
const AUTH_FETCH_TIMEOUT_MS = 15000;
function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTH_FETCH_TIMEOUT_MS);
  return fetch(url, Object.assign({}, options || {}, { signal: controller.signal })).finally(() =>
    clearTimeout(timer)
  );
}
function isTimeoutError(e) {
  return !!(e && e.name === 'AbortError');
}

// Expose globals — HANYA fungsi untuk Store/User. Tidak ada satupun
// fungsi/CRUD Admin yang di-expose ke window pada repository ini.
window.showPage = showPage;
window.switchAuthTab = switchAuthTab;
window.handleLogin = handleLogin;
window.handleRegister = handleRegister;
window.handleLogout = handleLogout;
window.handleGoogleLogin = handleGoogleLogin;
window.handleVerifyOtp = handleVerifyOtp;
window.handleResendOtp = handleResendOtp;
window.toggleUserMenu = toggleUserMenu;
window.filterProducts = filterProducts;
window.closeModal = closeModal;
window.orderProduct = orderProduct;
window.orderMembership = orderMembership;
window.goOrder = goOrder;
window.togglePlay = togglePlay;
window.prevTrack = prevTrack;
window.nextTrack = nextTrack;
window.setVolume = setVolume;
window.seekAudio = seekAudio;
window.toggleTrackMenu = toggleTrackMenu;
window.switchHomeTab = switchHomeTab;
window.loadMyOrders = loadMyOrders;
window.selectPackage = selectPackage;

onAuthStateChanged(auth, async user => {
  // Generasi baru untuk SETIAP firing onAuthStateChanged (login, logout,
  // ganti akun) — dipakai runOtpGate() untuk membatalkan sisa proses kalau
  // ada event auth lain yang menyusul sebelum proses ini selesai.
  const myGeneration = ++authGeneration;
  currentUser = user;
  if (user) {
    // Firebase auth berhasil BUKAN berarti login selesai — tanya ke backend
    // dulu apakah SESI LOGIN INI sudah lolos OTP. Kalau belum, jangan buka
    // halaman utama sama sekali.
    await runOtpGate(user, myGeneration);
  } else {
    otpVerified = false;
    otpGateUid = null;
    pendingAuthSuccessNotif = false;
    stopOtpCountdown();
    if (stockPollTimer) { clearInterval(stockPollTimer); stockPollTimer = null; }
    updateNavUI();
    // Guest: langsung tampilkan toko, tidak dipaksa ke halaman login dulu.
    // Order/checkout tetap minta login sendiri lewat guard di orderProduct/goOrder.
    showPage('home');
    loadPublicData();
  }
});

// Memutuskan apakah user yang baru saja lolos Firebase Authentication
// sudah boleh masuk ke website, atau harus menyelesaikan OTP dulu.
//
// REVISI PENTING (audit round 2): versi sebelumnya membaca custom claim
// `otpVerified` dari ID token. Itu BUG — custom claim menempel permanen ke
// akun Firebase Auth, jadi begitu sekali di-set true, sesi login BERIKUTNYA
// (setelah logout lalu login lagi) juga ikut kebaca true dan otomatis
// melewati OTP. Custom claims sudah tidak dipakai sama sekali untuk status
// verifikasi. Sekarang setiap kali fungsi ini jalan, ia bertanya ke backend
// lewat /api/auth/check-session, yang membandingkan auth_time sesi login
// SEKARANG dengan verifiedAuthTime yang tersimpan di Firestore (lihat
// lib/otp.js). auth_time otomatis berganti tiap kali user benar-benar
// sign-in ulang, jadi logout+login baru SELALU wajib OTP lagi, sementara
// refresh di sesi yang sama tidak perlu OTP berkali-kali kalau memang
// sudah pernah verified. Backend adalah satu-satunya sumber kebenaran;
// frontend tidak pernah menganggap dirinya sendiri "sudah verified".
async function runOtpGate(user, generation) {
  // Kalau pemanggil tidak memberikan nomor generasi (dipanggil manual dari
  // handleVerifyOtp, bukan dari listener onAuthStateChanged), pakai
  // generasi aktif saat ini supaya guard di bawah tetap konsisten.
  if (generation === undefined) generation = authGeneration;

  try {
    const idToken = await user.getIdToken();
    // Ada auth event lebih baru yang terjadi selagi menunggu token di atas
    // (mis. user sudah logout/ganti akun) — hentikan, biarkan generasi baru
    // yang menentukan tampilan.
    if (generation !== authGeneration) return;

    // PanaviBunga Store: OTP WAJIB untuk SEMUA sesi login baru, termasuk
    // sesi hasil baru saja mendaftar (register) maupun login lewat Google.
    // Tidak ada jalur "grant tanpa OTP" di sini — setiap sesi baru selalu
    // melewati check-session di bawah, dan kalau belum verified, akan
    // diarahkan ke halaman OTP.

    const res = await fetchWithTimeout('/api/auth/check-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + idToken },
    });
    if (generation !== authGeneration) return;
    const data = await res.json().catch(() => ({}));
    const verified = !!(res.ok && data.verified === true);

    if (verified) {
      otpVerified = true;
      otpGateUid = null;
      stopOtpCountdown();
      sessionStorage.removeItem('otpRequested_' + user.uid);
      sessionStorage.removeItem('otpNextResendAt_' + user.uid);
      updateNavUI();
      showPage('home');
      loadPublicData();
      // Seluruh alur (Firebase Auth -> OTP Check -> OTP Verification kalau
      // perlu -> Session Confirmation) baru benar-benar selesai di titik
      // ini — Store sudah tampil. Baru sekarang notifikasi sukses boleh
      // muncul, dan hanya kalau memang dipicu oleh aksi login/register/
      // verifikasi OTP (bukan oleh refresh/restore sesi biasa).
      if (pendingAuthSuccessNotif) {
        pendingAuthSuccessNotif = false;
        showNotif('Berhasil masuk', 'success');
      }
      return;
    }

    otpVerified = false;
    updateNavUI();
    showOtpPage(user);

    // Auto-kirim OTP hanya sekali per uid per sesi tab ini — supaya refresh
    // halaman saat OTP belum selesai TIDAK memicu pengiriman email baru
    // terus-menerus, dan TIDAK memberi akses tanpa OTP (test refresh).
    const alreadyRequestedKey = 'otpRequested_' + user.uid;
    if (!sessionStorage.getItem(alreadyRequestedKey)) {
      sessionStorage.setItem(alreadyRequestedKey, '1');
      await requestOtp(user, { silent: true, generation });
    } else {
      // Halaman di-refresh saat OTP belum selesai — jangan kirim email baru,
      // tapi lanjutkan countdown resend dari state yang tersimpan (bukan
      // dari variabel JS yang sudah reset karena reload).
      if (generation !== authGeneration) return;
      const storedNextResend = Number(sessionStorage.getItem('otpNextResendAt_' + user.uid) || 0);
      if (storedNextResend > Date.now()) {
        otpNextResendAt = storedNextResend;
        startOtpCountdown(otpNextResendAt);
      } else {
        otpNextResendAt = storedNextResend;
        const resendBtn = document.getElementById('otp-resend-btn');
        if (resendBtn) { resendBtn.style.display = 'inline'; resendBtn.disabled = false; }
      }
    }
  } catch (e) {
    console.error('runOtpGate error:', e);
    if (generation !== authGeneration) return;
    // Gagal-aman: kalau cek sesi ke backend error/timeout, tetap anggap
    // belum verified dan tampilkan layar OTP — jangan pernah default ke
    // "boleh masuk".
    otpVerified = false;
    if (isTimeoutError(e)) {
      showNotif('Koneksi ke server timeout. Coba lagi.', 'error');
    }
    showOtpPage(user);
  }
}

async function loadPublicData() {
  await loadProducts();
  await loadSongs();
  await loadStoreProfile();
  await loadAnnouncements();
  await loadStockPublic();
  renderProducts(products);
  renderTrackDropdown();
  updateBellDot();
  showBellIcon(true);
  resizeHomeSlider();
  // Show announcement popup after login
  const active = announcements.filter(a => a.active !== false);
  if (active.length) {
    setTimeout(() => openAnnPopup(), 600);
  }
}

async function loadProducts() {
  try {
    const snap = await getDocs(collection(db, "products"));
    products = [];
    snap.forEach(d => products.push({ id: d.id, ...d.data() }));
  } catch(e) {
    if (!products.length) products = getDefaultProducts();
  }
}

async function loadSongs() {
  try {
    const snap = await getDocs(collection(db, "songs"));
    songs = [];
    snap.forEach(d => songs.push({ id: d.id, ...d.data() }));
    if (!songs.length) songs = getDefaultSongs();
  } catch(e) {
    if (!songs.length) songs = getDefaultSongs();
  }
}

async function loadStoreProfile() {
  try {
    const d = await getDoc(doc(db, "settings", "store"));
    if (d.exists()) storeProfile = d.data();
    applyStoreProfile();
  } catch(e) {}
}

function applyStoreProfile() {
  const avatarImg   = document.getElementById('avatar-img');
  const placeholder = document.getElementById('avatar-placeholder');
  const videoEl     = document.querySelector('#-wrap video');
  const url         = storeProfile.avatarUrl || '';
  const isVideo     = url && (url.endsWith('.mp4') || url.endsWith('.webm') || url.includes('video'));

  if (url) {
    if (isVideo) {
      // Pakai video element yang sudah ada, ganti source-nya
      if (videoEl) {
        const src = videoEl.querySelector('source');
        if (src) src.src = url;
        videoEl.load();
        videoEl.style.display = 'block';
        videoEl.style.zIndex = '2';
      }
      avatarImg.style.display = 'none';
    } else {
      // Gambar biasa (jpg/png/gif/webp)
      avatarImg.src = url;
      avatarImg.style.display = 'block';
      avatarImg.style.zIndex = '2';
      if (videoEl) videoEl.style.display = 'none';
    }
    if (placeholder) placeholder.style.display = 'none';
  } else {
    // Default — tampilkan video bawaan
    avatarImg.style.display = 'none';
    if (placeholder) placeholder.style.display = 'none';
    if (videoEl) { videoEl.style.display = 'block'; videoEl.style.zIndex = '1'; }
  }
}

function getDefaultProducts() {
  return [
    { id:'1', name:'Spotify Premium', category:'musik', price:15000, desc:'Nikmati musik tanpa iklan, download lagu favorit dan kualitas audio terbaik.', badge:'POPULER', img:'', link:'https://wa.me/' },
    { id:'2', name:'Netflix', category:'streaming', price:25000, desc:'Tonton film dan serial pilihan dari seluruh dunia dengan kualitas HD hingga 4K.', badge:'', img:'', link:'https://wa.me/' },
    { id:'3', name:'ChatGPT Plus', category:'produktivitas', price:20000, desc:'Akses GPT-4 tanpa batas, lebih cepat dan canggih untuk produktivitas harian.', badge:'', img:'', link:'https://wa.me/' },
    { id:'4', name:'Canva Pro', category:'kreatif', price:12000, desc:'Desain grafis tanpa batas dengan ribuan template premium dan fitur eksklusif.', badge:'', img:'', link:'https://wa.me/' },
    { id:'5', name:'YouTube Premium', category:'streaming', price:13000, desc:'Tonton tanpa iklan, unduh video, dan nikmati YouTube Music secara gratis.', badge:'', img:'', link:'https://wa.me/' },
    { id:'6', name:'Duolingo Plus', category:'edukasi', price:10000, desc:'Belajar bahasa baru tanpa iklan dengan akses ke semua konten premium.', badge:'', img:'', link:'https://wa.me/' },
    { id:'7', name:'Disney+', category:'streaming', price:18000, desc:'Marvel, Star Wars, Pixar, National Geographic — semua dalam satu platform.', badge:'', img:'', link:'https://wa.me/' },
    { id:'8', name:'Apple Music', category:'musik', price:14000, desc:'Lebih dari 100 juta lagu dengan kualitas audio lossless dan Spatial Audio.', badge:'', img:'', link:'https://wa.me/' },
    { id:'9', name:'Prime Video', category:'streaming', price:16000, desc:'Film dan serial Amazon Original berkualitas tinggi dari seluruh dunia.', badge:'', img:'', link:'https://wa.me/' },
    { id:'10', name:'Picsart Gold', category:'kreatif', price:11000, desc:'Edit foto dan video dengan fitur AI terdepan dan ribuan stiker premium.', badge:'', img:'', link:'https://wa.me/' },
    { id:'11', name:'Alight Motion', category:'kreatif', price:12000, desc:'Aplikasi motion graphic dan video editing terbaik untuk kreator konten.', badge:'', img:'', link:'https://wa.me/' },
    { id:'12', name:'VIU', category:'streaming', price:10000, desc:'Drama Korea, Jepang, dan konten Asia terlengkap dengan subtitle Indonesia.', badge:'', img:'', link:'https://wa.me/' },
  ];
}

function getDefaultSongs() {
  return [
    { id:'s1', title:'The fate of ophelia', artist:'Taylor Swift', url:'https://smail.my.id/cloud/9PsdBNHy1' },
    { id:'s2', title:'One of the girls', artist:'The Weeknd', url:'https://smail.my.id/cloud/ZaYsHomt1' },
    { id:'s3', title:'Starboy', artist:'The Weeknd', url:'https://cdn.yupra.my.id/yp/qfburybd.mp3' },
    { id:'s4', title:'Saturn', artist:'sza', url:'https://cdn.yupra.my.id/yp/adw31owk.mp3' },
    { id:'s5', title:'What it is', artist:'Doechii', url:'https://cdn.yupra.my.id/yp/zd5pti9o.mp3' },
    { id:'s6', title:'Daddy s home', artist:'Users', url:'https://cdn.yupra.my.id/yp/ord6bhz7.mp3' },
    { id:'s7', title:'Unforgettable', artist:'PNB ROCK', url:'https://cdn.yupra.my.id/yp/t5rfbaeh.mp3' },
    { id:'s8', title:'Timeless', artist:'The Weeknd', url:'https://cdn.yupra.my.id/yp/cks7evku.mp3' },
  ];
}

// ===== NAVIGATION =====
function showPage(page, sub) {
  document.getElementById('page-home').style.display = 'none';
  document.getElementById('page-auth').style.display = 'none';
  const otpPageEl = document.getElementById('page-otp');
  if (otpPageEl) otpPageEl.style.display = 'none';

  if (page === 'home') {
    // Toko bisa dijelajahi tanpa login. Kalau user sudah login tapi
    // sesinya belum lolos OTP, tetap wajib selesaikan OTP dulu.
    if (currentUser && !otpVerified) { showPage('otp'); return; }
    document.getElementById('page-home').style.display = 'block';
    updateSettingsPanel();
    resizeHomeSlider();
  }
  if (page === 'auth') {
    document.getElementById('page-auth').style.display = 'flex';
    switchAuthTab(sub || 'login');
  }
  if (page === 'otp' && otpPageEl) {
    otpPageEl.style.display = 'flex';
  }
  document.getElementById('user-menu').style.display = 'none';
}

function updateSettingsPanel() {
  const uname = document.getElementById('settings-username');
  const uemail = document.getElementById('settings-email');
  if (uname && currentUser) {
    uname.textContent = currentUser.displayName || 'Pengguna';
    uemail.textContent = currentUser.email || '';
  }
}

function updateNavUI() {
  const authEl = document.getElementById('nav-auth');
  const userEl = document.getElementById('nav-user');
  const avatarEl = document.getElementById('nav-avatar');
  if (currentUser) {
    authEl.classList.add('hidden');
    userEl.classList.remove('hidden');
    avatarEl.textContent = (currentUser.displayName || currentUser.email || 'U')[0].toUpperCase();
  } else {
    authEl.classList.remove('hidden');
    userEl.classList.add('hidden');
  }
}

function toggleUserMenu() {
  const m = document.getElementById('user-menu');
  m.style.display = m.style.display === 'none' ? 'block' : 'none';
}

document.addEventListener('click', e => {
  if (!e.target.closest('#nav-user')) document.getElementById('user-menu').style.display = 'none';
});

// ===== AUTH =====
function switchAuthTab(tab) {
  document.getElementById('auth-view-login').style.display = tab === 'login' ? 'block' : 'none';
  document.getElementById('auth-view-register').style.display = tab === 'register' ? 'block' : 'none';
}

async function handleLogin() {
  const email = document.getElementById('login-email').value.trim();
  const pass = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  errEl.style.display = 'none';
  const btn = document.getElementById('btn-login');
  btn.innerHTML = '<div class="spinner"></div>';
  btn.disabled = true;
  try {
    await signInWithEmailAndPassword(auth, email, pass);
    // BUG FIX (audit round 3): jangan tampilkan "Berhasil masuk" di sini.
    // signIn berhasil hanya berarti Firebase Auth lolos — onAuthStateChanged
    // -> runOtpGate() masih akan menjalankan OTP gate setelah ini. Notifikasi
    // baru ditampilkan oleh runOtpGate() setelah Store benar-benar terbuka.
    pendingAuthSuccessNotif = true;
  } catch(e) {
    // [DEBUG SEMENTARA] tampilkan kode error asli dari Firebase supaya
    // gampang didiagnosis dari HP tanpa buka console. Hapus baris
    // "(" + (e.code || e.message) + ")" di bawah ini kalau sudah selesai debug.
    errEl.textContent = getAuthError(e.code) + ' (' + (e.code || e.message) + ')';
    errEl.style.display = 'block';
    console.error('Login error:', e);
  }
  btn.innerHTML = '<span>Masuk</span>';
  btn.disabled = false;
}

async function handleRegister() {
  const name = document.getElementById('reg-name').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const pass = document.getElementById('reg-password').value;
  const errEl = document.getElementById('reg-error');
  const succEl = document.getElementById('reg-success');
  errEl.style.display = 'none'; succEl.style.display = 'none';
  if (!name) { errEl.textContent = 'Nama tidak boleh kosong.'; errEl.style.display = 'block'; return; }
  const btn = document.getElementById('btn-register');
  btn.innerHTML = '<div class="spinner"></div>';
  btn.disabled = true;
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, pass);
    await updateProfile(cred.user, { displayName: name });
    succEl.textContent = 'Akun berhasil dibuat! Verifikasi OTP diperlukan sebelum masuk toko...';
    succEl.style.display = 'block';
    // "Berhasil masuk" ditampilkan nanti oleh runOtpGate() setelah OTP
    // register ini diverifikasi dan Store benar-benar terbuka.
    pendingAuthSuccessNotif = true;
    // onAuthStateChanged -> runOtpGate() akan otomatis mengarahkan ke
    // halaman OTP — PanaviBunga Store mewajibkan OTP untuk SETIAP sesi
    // login baru, termasuk sesi hasil baru saja mendaftar.
  } catch(e) {
    // [DEBUG SEMENTARA] tampilkan kode error asli dari Firebase supaya
    // gampang didiagnosis dari HP tanpa buka console. Hapus baris
    // "(" + (e.code || e.message) + ")" di bawah ini kalau sudah selesai debug.
    errEl.textContent = getAuthError(e.code) + ' (' + (e.code || e.message) + ')';
    errEl.style.display = 'block';
    console.error('Register error:', e);
  }
  btn.innerHTML = '<span>Buat Akun</span>';
  btn.disabled = false;
}

async function handleLogout() {
  // Simpan uid dulu SEBELUM signOut, supaya sessionStorage flag milik sesi
  // login yang baru saja berakhir ikut dibersihkan. Ini murni untuk UX
  // (supaya auto-send OTP jalan lagi kalau akun yang sama login ulang di
  // tab yang sama) — bukan mekanisme keamanan. Keamanan sesungguhnya tetap
  // dari backend: auth_time sesi baru tidak akan pernah cocok dengan
  // verifiedAuthTime sesi lama, apapun isi sessionStorage di browser.
  const signingOutUid = currentUser ? currentUser.uid : null;
  pendingAuthSuccessNotif = false; // batalkan notif "Berhasil masuk" tertunda milik sesi yang baru saja diakhiri
  await signOut(auth);
  if (signingOutUid) {
    sessionStorage.removeItem('otpRequested_' + signingOutUid);
    sessionStorage.removeItem('otpNextResendAt_' + signingOutUid);
    sessionStorage.removeItem('otpEmailMasked_' + signingOutUid);
  }
  showNotif('Berhasil keluar', 'success');
}

function getAuthError(code) {
  const map = {
    'auth/user-not-found': 'Email tidak terdaftar.',
    'auth/wrong-password': 'Kata sandi salah.',
    'auth/email-already-in-use': 'Email sudah digunakan.',
    'auth/weak-password': 'Kata sandi minimal 6 karakter.',
    'auth/invalid-email': 'Format email tidak valid.',
    'auth/invalid-credential': 'Email atau kata sandi salah.',
    'auth/network-request-failed': 'Koneksi gagal. Cek internet.',
  };
  return map[code] || 'Terjadi kesalahan. Coba lagi.';
}

async function handleGoogleLogin() {
  const btn = document.getElementById('btn-google-login');
  const errEl = document.getElementById('login-error');
  if (errEl) errEl.style.display = 'none';
  if (btn) { btn.disabled = true; btn.style.opacity = '0.7'; }
  try {
    await signInWithPopup(auth, googleProvider);
    // Sisanya (cek OTP, buka halaman OTP, dst) ditangani otomatis oleh
    // onAuthStateChanged -> runOtpGate(), supaya tidak ada listener auth
    // yang duplikat. "Berhasil masuk" ditampilkan nanti oleh runOtpGate()
    // setelah OTP (kalau perlu) selesai dan Store benar-benar terbuka —
    // Google login TIDAK BOLEH bypass OTP maupun notifikasi ini.
    pendingAuthSuccessNotif = true;
  } catch (e) {
    // User membatalkan popup Google -> jangan crash, jangan tampilkan
    // sebagai error keras, cukup diam-diam kembalikan tombol ke semula.
    if (e && (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request')) {
      // no-op
    } else if (errEl) {
      errEl.textContent = getAuthError(e && e.code);
      errEl.style.display = 'block';
    }
  }
  if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
}

// ===== OTP VERIFICATION (2-STEP LOGIN) =====

function showOtpPage(user) {
  otpGateUid = user.uid;
  const emailEl = document.getElementById('otp-email-masked');
  const maskedFromCache = sessionStorage.getItem('otpEmailMasked_' + user.uid);
  if (emailEl) emailEl.textContent = maskedFromCache || maskEmailClient(user.email || '');
  const codeInput = document.getElementById('otp-code');
  if (codeInput) codeInput.value = '';
  const errEl = document.getElementById('otp-error');
  if (errEl) errEl.style.display = 'none';
  // UI 6 slot OTP (js/otp-slots.js) — reset tampilan slot & fokus ke slot
  // pertama. Defensif: kalau file itu tak termuat, tidak berpengaruh.
  if (typeof window.otpSlotsReset === 'function') window.otpSlotsReset();
  showPage('otp');
}

function maskEmailClient(email) {
  const [user, domain] = String(email).split('@');
  if (!user || !domain) return email;
  return user.slice(0, 1) + '*'.repeat(Math.max(user.length - 1, 3)) + '@' + domain;
}

async function requestOtp(user, opts) {
  opts = opts || {};
  if (otpBusy) return; // BUG 8: cegah double click memicu dua request OTP sekaligus
  otpBusy = true;
  const resendBtn = document.getElementById('otp-resend-btn');
  const errEl = document.getElementById('otp-error');
  if (errEl) errEl.style.display = 'none';
  if (resendBtn) resendBtn.disabled = true;

  try {
    const idToken = await user.getIdToken();
    // Kalau ada auth event lebih baru (logout/ganti akun) selagi menunggu
    // token, jangan sentuh UI OTP yang sudah bukan milik sesi ini lagi.
    if (opts.generation !== undefined && opts.generation !== authGeneration) return;

    const res = await fetchWithTimeout('/api/auth/send-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + idToken },
    });
    if (opts.generation !== undefined && opts.generation !== authGeneration) return;
    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data.success) {
      if (data.nextResendAt) {
        otpNextResendAt = data.nextResendAt;
        sessionStorage.setItem('otpNextResendAt_' + user.uid, String(otpNextResendAt));
        startOtpCountdown(otpNextResendAt);
      }
      // Error selalu ditampilkan (termasuk saat auto-send silent) supaya
      // user tidak "terjebak" tanpa penjelasan kalau email gagal terkirim.
      // Yang di-skip untuk silent hanya notifikasi toast "berhasil".
      if (errEl) {
        errEl.textContent = data.error || 'Gagal mengirim kode verifikasi.';
        errEl.style.display = 'block';
      }
      return;
    }

    if (data.emailMasked) {
      sessionStorage.setItem('otpEmailMasked_' + user.uid, data.emailMasked);
      const emailEl = document.getElementById('otp-email-masked');
      if (emailEl) emailEl.textContent = data.emailMasked;
    }
    otpNextResendAt = data.nextResendAt || (Date.now() + 60000);
    sessionStorage.setItem('otpNextResendAt_' + user.uid, String(otpNextResendAt));
    startOtpCountdown(otpNextResendAt);
    if (!opts.silent) showNotif('Kode verifikasi dikirim ke email Anda', 'success');
  } catch (e) {
    if (opts.generation !== undefined && opts.generation !== authGeneration) return;
    if (errEl) {
      errEl.textContent = isTimeoutError(e)
        ? 'Koneksi ke server timeout. Coba lagi.'
        : 'Gagal mengirim kode verifikasi. Cek koneksi Anda.';
      errEl.style.display = 'block';
    }
  } finally {
    otpBusy = false;
    if (resendBtn && Date.now() >= otpNextResendAt) resendBtn.disabled = false;
  }
}

async function handleVerifyOtp() {
  if (!currentUser) return;
  const codeInput = document.getElementById('otp-code');
  const errEl = document.getElementById('otp-error');
  const btn = document.getElementById('btn-otp-verify');
  const code = codeInput ? codeInput.value.trim() : '';
  if (errEl) errEl.style.display = 'none';

  if (!/^\d{6}$/.test(code)) {
    if (errEl) { errEl.textContent = 'Masukkan 6 digit kode yang valid.'; errEl.style.display = 'block'; }
    if (typeof window.otpSlotsError === 'function') window.otpSlotsError();
    return;
  }

  if (btn) { btn.innerHTML = '<div class="spinner"></div>'; btn.disabled = true; }
  // UI 6 slot OTP: kunci slot + animasi orbit verifying. Murni tampilan,
  // tidak mempengaruhi request/response di bawah ini.
  if (typeof window.otpSlotsSetVerifying === 'function') window.otpSlotsSetVerifying(true);
  const verifyGeneration = authGeneration;
  try {
    const idToken = await currentUser.getIdToken();
    const res = await fetchWithTimeout('/api/auth/verify-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + idToken },
      body: JSON.stringify({ code }),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data.success) {
      if (errEl) { errEl.textContent = data.error || 'Kode verifikasi salah.'; errEl.style.display = 'block'; }
      if (codeInput) codeInput.value = '';
      if (typeof window.otpSlotsError === 'function') window.otpSlotsError();
    } else {
      sessionStorage.removeItem('otpRequested_' + currentUser.uid);
      sessionStorage.removeItem('otpEmailMasked_' + currentUser.uid);
      sessionStorage.removeItem('otpNextResendAt_' + currentUser.uid);
      stopOtpCountdown();
      // BUG FIX (audit round 3): jangan tampilkan "Berhasil masuk" di sini.
      // Backend sudah mengonfirmasi kode benar, tapi urutan yang diminta
      // adalah OTP Verification -> Session Confirmation -> Navigation ke
      // Store -> baru Success Notification. Set flag saja; runOtpGate() di
      // bawah yang akan menampilkannya TEPAT setelah Store benar-benar
      // terbuka (lewat check-session, backend tetap sumber kebenaran).
      pendingAuthSuccessNotif = true;
      // Animasi sukses singkat (kalau UI slot tersedia) SEBELUM pindah
      // halaman, supaya transisi tidak terasa kasar/tiba-tiba. Sepenuhnya
      // tampilan — tidak menunda atau mengubah verifikasi itu sendiri,
      // yang sudah selesai di atas.
      if (typeof window.otpSlotsSuccess === 'function') {
        try { await window.otpSlotsSuccess(); } catch (e) { /* abaikan, jangan blokir redirect */ }
      }
      // Kalau ada auth event lain yang menyusul selagi animasi sukses di
      // atas berjalan (mis. user sempat logout), jangan paksa redirect ke
      // Store dengan sesi yang sudah tidak aktif lagi.
      if (verifyGeneration !== authGeneration) return;
      // Backend sudah menandai sesi login ini verified (verifiedAuthTime),
      // panggil ulang runOtpGate untuk konfirmasi lewat check-session lalu
      // baru buka halaman utama.
      await runOtpGate(currentUser, verifyGeneration);
    }
  } catch (e) {
    pendingAuthSuccessNotif = false;
    if (errEl) {
      errEl.textContent = isTimeoutError(e)
        ? 'Koneksi ke server timeout. Coba lagi.'
        : 'Gagal memverifikasi kode. Cek koneksi Anda.';
      errEl.style.display = 'block';
    }
    if (typeof window.otpSlotsError === 'function') window.otpSlotsError();
  }
  if (btn) { btn.innerHTML = '<span>Verifikasi</span>'; btn.disabled = false; }
  if (typeof window.otpSlotsSetVerifying === 'function') window.otpSlotsSetVerifying(false);
}

async function handleResendOtp() {
  if (!currentUser || Date.now() < otpNextResendAt) return;
  await requestOtp(currentUser, { silent: false });
}

function startOtpCountdown(nextResendAt) {
  stopOtpCountdown();
  const label = document.getElementById('otp-resend-label');
  const resendBtn = document.getElementById('otp-resend-btn');
  if (resendBtn) resendBtn.style.display = 'none';

  function tick() {
    const secsLeft = Math.max(0, Math.ceil((nextResendAt - Date.now()) / 1000));
    if (secsLeft <= 0) {
      stopOtpCountdown();
      if (label) label.style.display = 'none';
      if (resendBtn) { resendBtn.style.display = 'inline'; resendBtn.disabled = false; }
      return;
    }
    if (label) {
      label.style.display = 'block';
      label.textContent = 'Kirim ulang kode dalam ' + secsLeft + ' detik';
    }
  }

  tick();
  otpCooldownInterval = setInterval(tick, 1000);
}

function stopOtpCountdown() {
  if (otpCooldownInterval) { clearInterval(otpCooldownInterval); otpCooldownInterval = null; }
}

// ===== PRODUCTS =====
// Dipakai bersama oleh renderProducts() (badge/tombol) dan orderProduct()
// (guard sebelum modal checkout dibuka), supaya aturan "stok kosong" selalu
// konsisten di manapun dicek.
// CATATAN AUDIT STOK: `stockItems` TIDAK LAGI berisi dokumen stock mentah
// (yang punya field kredensial seperti email/password) — sekarang berisi
// hasil agregat AMAN { productId, packageName, availableCount, totalCount }
// dari endpoint backend /stock-availability (lihat loadStockPublic() di
// bawah). Firestore Rules production memang membatasi collection "stock"
// hanya bisa dibaca Admin, jadi membaca collection itu langsung dari
// browser tidak akan pernah berhasil untuk user biasa - dan tetap berisiko
// membocorkan kredensial kalau rule itu suatu saat dilonggarkan. Bentuk
// return getProductStock()/getPackageStock() di bawah TIDAK diubah supaya
// seluruh pemanggil (renderProducts, orderProduct, renderOrderModalBody,
// dst) tidak perlu direvisi.
function getProductStock(productId) {
  const entries = stockItems.filter(s => s.productId === productId);
  const availableCount = entries.reduce((sum, e) => sum + (e.availableCount || 0), 0);
  const totalCount = entries.reduce((sum, e) => sum + (e.totalCount || 0), 0);
  return {
    availableCount,
    totalCount,
    hasStock: availableCount > 0,
    hasStockData: totalCount > 0
  };
}

// Sama seperti getProductStock() di atas (dipakai untuk badge "x/y tersedia"
// di kartu produk — total gabungan semua paket, tampilan TIDAK diubah),
// tapi ini mengecek stok SATU paket spesifik (productId + packageName).
// Dipakai saat buyer sudah memilih paket, supaya paket yang stoknya kosong
// tidak dianggap tersedia hanya karena paket lain dari produk yang sama
// masih ada stok.
function getPackageStock(productId, packageName) {
  const entry = stockItems.find(s => s.productId === productId && s.packageName === packageName);
  const availableCount = entry ? (entry.availableCount || 0) : 0;
  const totalCount = entry ? (entry.totalCount || 0) : 0;
  return {
    availableCount,
    totalCount,
    hasStock: availableCount > 0,
    hasStockData: totalCount > 0
  };
}

function renderProducts(list) {
  const grid = document.getElementById('product-grid');
  if (!list.length) {
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:48px 16px;color:var(--text2);font-size:14px;">Tidak ada produk ditemukan.</div>';
    return;
  }
  grid.innerHTML = list.map(p => {
    const { availableCount, totalCount, hasStock, hasStockData } = getProductStock(p.id);

    const stockBadgeHtml = hasStockData
      ? `<div class="stock-badge ${hasStock ? 'stock-badge-available' : 'stock-badge-empty'}">
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>
          ${hasStock ? `${availableCount}/${totalCount} tersedia` : 'STOCK HABIS'}
        </div>`
      : '';

    const buyBtn = hasStockData && !hasStock
      ? `<button class="btn-order-disabled" disabled>Habis</button>`
      : `<button class="btn-order" onclick="event.stopPropagation();orderProduct('${p.id}')">Pesan</button>`;

    return `
    <div class="product-card" onclick="orderProduct('${p.id}')">
      <div style="position:relative;">
        ${p.img
          ? `<img src="${p.img}" class="product-thumb" alt="${p.name}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="product-thumb-placeholder" style="display:none;"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--text3)" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></div>`
          : `<div class="product-thumb-placeholder"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--text3)" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></div>`
        }
        ${p.badge ? `<div class="product-badge">${p.badge}</div>` : ''}
      </div>
      <div class="product-body">
        <div class="product-name">${p.name}</div>
        <div class="product-desc">${p.desc || ''}</div>
        ${stockBadgeHtml}
        <div class="product-footer">
          <div class="product-price">Rp${Number(p.price||0).toLocaleString('id-ID')}<span>/bulan</span></div>
          ${buyBtn}
        </div>
      </div>
    </div>
  `;
  }).join('');
  applyRevealToCards();
}

function filterProducts(cat, btn) {
  document.querySelectorAll('.cat-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  stockFilter = cat;
  renderProducts(cat === 'all' ? products : products.filter(p => p.category === cat));
}

function orderProduct(id) {
  const p = products.find(x => x.id === id);
  if (!p) return;
  if (!currentUser) { showNotif('Silakan masuk terlebih dahulu', 'error'); showPage('auth', 'login'); return; }

  // Cegah modal checkout terbuka untuk produk yang stoknya kosong, bukan
  // cuma mengandalkan tombol "Habis" yang disabled — klik pada kartu produk
  // sebelumnya masih bisa membuka modal walau tombolnya sudah disabled.
  const { hasStock, hasStockData } = getProductStock(p.id);
  if (hasStockData && !hasStock) {
    showNotif('STOCK SEDANG KOSONG. Hubungi admin untuk melakukan restock.', 'error');
    return;
  }

  console.log("SELECTED PRODUCT", p);

  document.getElementById('modal-order-title').textContent = p.name;
  currentOrderProduct = p;
  // Jika produk punya banyak paket, pakai itu. Kalau tidak, fallback ke 1 paket dari harga utama (perilaku lama tetap jalan).
  currentOrderPackages = (Array.isArray(p.packages) && p.packages.length > 0)
    ? p.packages
    : [{ name: p.name, price: Number(p.price || 0) }];
  currentSelectedPackageIndex = 0;
  currentOrderLink = p.link || '#';

  renderOrderModalBody();
  openModal('modal-order');
}

// ===== NOMOR WHATSAPP WAJIB SEBELUM QR DIBUAT =====
// Field ini dipakai untuk kedua template modal order (multi-paket & single
// paket) - dipisah jadi fungsi sendiri supaya tidak duplikasi markup.
// Memakai class .field / .field label / .field input yang SUDAH ADA di
// css/style.css (dipakai form registrasi) supaya tidak perlu menambah CSS
// baru sama sekali.
function renderOrderWhatsappFieldHtml() {
  return `
    <div class="field" id="order-wa-field" style="margin-bottom:14px;">
      <label for="order-wa-input">Nomor WhatsApp</label>
      <input type="tel" id="order-wa-input" inputmode="numeric" placeholder="08xxxxxxxxxx" autocomplete="tel" value="${escHtml(currentOrderWhatsapp || '')}">
      <div id="order-wa-error" style="font-size:11.5px;color:var(--danger,#e15b5b);display:none;"></div>
    </div>
  `;
}

// Validasi + normalisasi nomor WhatsApp di sisi client. Tidak ada backend
// terpisah yang memvalidasi ulang di sini — order dibuat langsung ke
// Firestore (lihat createOrderAndShowQris()), jadi validasi ini adalah
// satu-satunya lapisan format sebelum data tersimpan.
function normalizeWhatsappInput(raw) {
  if (!raw) return null;
  let val = String(raw).trim().replace(/[\s\-()]/g, '');
  if (!/^(\+?62|0)8[0-9]{7,12}$/.test(val)) return null;
  if (val.startsWith('0')) val = '62' + val.slice(1);
  else if (val.startsWith('+62')) val = val.slice(1);
  return val;
}

function renderOrderModalBody() {
  const p = currentOrderProduct;
  const pkgs = currentOrderPackages;
  const selected = pkgs[currentSelectedPackageIndex];
  const hasMultiPkg = pkgs.length > 1;

  // Fallback berantai: harga paket terpilih → harga produk utama → 0
  const resolvedAmount = Number(selected.price) || Number(p.price) || 0;
  currentOrderPayment = {
    amount: resolvedAmount,
    username: (currentUser && (currentUser.displayName || currentUser.email)) || 'guest'
  };

  // Stok paket yang SEDANG dipilih (bukan gabungan semua paket) — dipakai
  // untuk menonaktifkan tombol bayar kalau paket ini kosong, sekalipun
  // paket lain dari produk yang sama masih tersedia.
  const selectedStock = getPackageStock(p.id, selected.name);
  const selectedOutOfStock = selectedStock.hasStockData && !selectedStock.hasStock;

  const bodyHtml = hasMultiPkg ? `
    <div style="font-size:12px;color:var(--text2);margin-bottom:10px;">Pilih paket untuk <strong style="color:var(--text);">${escHtml(p.name)}</strong>:</div>
    <div style="display:flex;flex-direction:column;gap:9px;margin-bottom:16px;">
      ${pkgs.map((pkg, i) => {
        const isActive = i === currentSelectedPackageIndex;
        const pkgStock = getPackageStock(p.id, pkg.name);
        const pkgOutOfStock = pkgStock.hasStockData && !pkgStock.hasStock;
        return `<div onclick="${pkgOutOfStock ? '' : `selectPackage(${i})`}" style="cursor:${pkgOutOfStock ? 'not-allowed' : 'pointer'};opacity:${pkgOutOfStock ? '0.5' : '1'};border:1.5px solid ${isActive ? 'var(--accent)' : 'var(--border)'};background:${isActive ? 'rgba(79,140,255,0.1)' : 'var(--surface2)'};border-radius:12px;padding:12px 14px;display:flex;justify-content:space-between;align-items:center;">
          <div style="display:flex;align-items:center;gap:9px;">
            <div style="width:16px;height:16px;border-radius:50%;border:2px solid ${isActive ? 'var(--accent)' : 'var(--border)'};background:${isActive ? 'var(--accent)' : 'transparent'};flex-shrink:0;display:flex;align-items:center;justify-content:center;">${isActive ? '<div style="width:6px;height:6px;border-radius:50%;background:#fff;"></div>' : ''}</div>
            <span style="font-size:13.5px;color:var(--text);font-weight:${isActive ? '700' : '500'};">${escHtml(pkg.name)}</span>
            ${pkgOutOfStock ? `<span style="font-size:10.5px;font-weight:700;color:var(--danger,#e15b5b);">HABIS</span>` : ''}
          </div>
          <span style="font-size:14px;color:${isActive ? 'var(--accent)' : 'var(--text2)'};font-weight:700;font-family:'Syne',sans-serif;">Rp${Number(pkg.price||0).toLocaleString('id-ID')}</span>
        </div>`;
      }).join('')}
    </div>
    <div style="background:var(--surface2);border-radius:10px;padding:10px 14px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:center;">
      <span style="font-size:12.5px;color:var(--text2);">Total bayar</span>
      <span style="font-size:18px;font-weight:800;color:var(--accent);font-family:'Syne',sans-serif;">Rp${resolvedAmount.toLocaleString('id-ID')}<span style="font-size:11px;font-weight:400;font-family:'DM Sans';color:var(--text2);margin-left:3px;">/bulan</span></span>
    </div>
    ${selectedOutOfStock ? `<div style="margin-bottom:10px;"><div style="font-size:12.5px;font-weight:700;color:var(--danger,#e15b5b);">STOCK SEDANG KOSONG</div><div style="font-size:11.5px;color:var(--text2);margin-top:2px;">Hubungi admin untuk melakukan restock.</div></div>` : ''}
    ${renderOrderWhatsappFieldHtml()}
    <div id="order-qris-wrap"></div>
  ` : `
    <div style="margin-bottom:10px;">Anda akan memesan:</div>
    <div style="background:var(--surface2);border-radius:10px;padding:12px 14px;margin-bottom:14px;">
      <div style="font-size:15px;font-weight:600;color:var(--text);font-family:'Syne',sans-serif;">${escHtml(p.name)}</div>
      <div style="font-size:12.5px;color:var(--text2);margin-top:3px;">${escHtml(p.desc || '')}</div>
      <div style="font-size:18px;font-weight:800;color:var(--accent);font-family:'Syne',sans-serif;margin-top:8px;">Rp${resolvedAmount.toLocaleString('id-ID')}<span style="font-size:11px;font-weight:400;font-family:'DM Sans';color:var(--text2);margin-left:3px;">/bulan</span></div>
    </div>
    ${selectedOutOfStock ? `<div style="margin-bottom:10px;"><div style="font-size:12.5px;font-weight:700;color:var(--danger,#e15b5b);">STOCK SEDANG KOSONG</div><div style="font-size:11.5px;color:var(--text2);margin-top:2px;">Hubungi admin untuk melakukan restock.</div></div>` : ''}
    ${renderOrderWhatsappFieldHtml()}
    <div id="order-qris-wrap"></div>
    Klik tombol di bawah untuk membayar via QRIS.
  `;

  document.getElementById('modal-order-body').innerHTML = bodyHtml;

  const btn = document.getElementById('btn-order-go');
  btn.style.display = '';
  if (selectedOutOfStock) {
    btn.disabled = true;
    btn.innerHTML = 'Stock Kosong';
  } else {
    btn.disabled = false;
    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> Bayar Sekarang';
  }
  document.getElementById('btn-order-cancel').style.display = 'none';
}

function selectPackage(i) {
  // Simpan dulu apa yang sudah diketik user di kolom WhatsApp SEBELUM
  // modal di-render ulang untuk paket baru — supaya nomor yang sudah
  // diketik tidak hilang cuma karena user ganti pilihan paket.
  const waInput = document.getElementById('order-wa-input');
  if (waInput) currentOrderWhatsapp = waInput.value;
  currentSelectedPackageIndex = i;
  renderOrderModalBody();
}

// =====================================================================
// PEMBAYARAN QRIS STATIS (PanaviBunga Store)
// Tidak ada generate/gambar QR secara dinamis (Canvas dsb) — gambar QRIS
// di bawah ini adalah FILE ASLI milik pemilik toko yang ditempatkan
// langsung di assets/. Ganti file di assets/qris.png dengan QRIS asli Anda;
// tidak perlu mengubah kode ini.
// =====================================================================
const QRIS_IMAGE_PATH = 'assets/qris.png';

// TODO(pemilik toko): ganti dengan nomor WhatsApp PanaviBunga Store yang
// menerima bukti pembayaran (format internasional tanpa "+", contoh:
// "6281234567890"). Dipakai juga untuk tombol paket Reseller/Owner di
// orderMembership().
const OWNER_WHATSAPP_NUMBER = '62xxxxxxxxxx';

function buildWhatsappProofMessage(order) {
  const lines = [
    'Halo, saya sudah melakukan pembayaran.',
    '',
    `Order ID: ${order.id || '-'}`,
    `Produk: ${order.productName || '-'}`,
    `Paket: ${order.packageName || '-'}`,
    `Total: Rp${Number(order.price || 0).toLocaleString('id-ID')}`,
    '',
    'Saya mengirimkan bukti pembayaran di chat ini.',
  ];
  return lines.join('\n');
}

function openWhatsappProof(order) {
  const msg = buildWhatsappProofMessage(order);
  const url = `https://wa.me/${OWNER_WHATSAPP_NUMBER}?text=${encodeURIComponent(msg)}`;
  window.open(url, '_blank');
}
window.openWhatsappProof = openWhatsappProof;

function downloadQris() {
  const a = document.createElement('a');
  a.href = QRIS_IMAGE_PATH;
  a.download = 'QRIS-PanaviBunga-Store.png';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
window.downloadQris = downloadQris;

function renderStaticQrisPayment(order) {
  const wrap = document.getElementById('order-qris-wrap');
  if (!wrap) return;
  wrap.innerHTML = `
    <div class="payment-card-block">
      <div class="payment-card-scan-hint">Scan QRIS untuk membayar</div>
      <div class="payment-card-wrap">
        <img src="${QRIS_IMAGE_PATH}" alt="QRIS PanaviBunga Store" style="display:block;width:100%;height:auto;border-radius:14px;">
      </div>
      <div class="payment-info">
        <div class="payment-info-row">
          <span class="payment-info-label">Total bayar</span>
          <span class="payment-info-amount">Rp${Number(order.price || 0).toLocaleString('id-ID')}</span>
        </div>
      </div>
      <div class="payment-txid">ID Transaksi: ${escHtml(order.id || '-')}</div>
      <div style="font-size:12px;color:var(--text2);margin-top:6px;line-height:1.6;">
        Setelah membayar, klik tombol di bawah untuk mengirim bukti pembayaran lewat WhatsApp.
        Pesanan Anda berstatus <strong>Menunggu Verifikasi</strong> sampai admin memeriksa bukti pembayaran secara manual.
      </div>
      <button type="button" class="btn btn-primary btn-sm" style="margin-top:10px;width:100%;" onclick='openWhatsappProof(${JSON.stringify(order).replace(/'/g, "&#39;")})'>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        Kirim Bukti Transaksi
      </button>
      <button type="button" class="btn btn-ghost btn-sm payment-download-btn" onclick="downloadQris()" style="margin-top:8px;width:100%;">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Download QRIS
      </button>
      <div id="order-status-msg" style="font-size:13px;margin-top:10px;font-weight:700;color:var(--text2);">Menunggu Verifikasi Admin</div>
    </div>
  `;
}

function orderMembership(type) {
  currentOrderPayment = null;
  currentOrderProduct = null;
  currentOrderPackages = [];
  if (!currentUser) { showNotif('Silakan masuk terlebih dahulu', 'error'); showPage('auth', 'login'); return; }
  const data = {
    reseller: { title:'Daftar Reseller', price:'Rp10.000', desc:'Paket Reseller PANAVIBUNGA STORE — dapatkan stok app premium, bahan jualan, dan dukungan penuh.', link:`https://wa.me/${OWNER_WHATSAPP_NUMBER}` },
    owner: { title:'Daftar Owner', price:'Rp20.000', desc:'Paket Owner PANAVIBUNGA STORE — buka reseller sendiri, akses semua bahan dan group eksklusif.', link:`https://wa.me/${OWNER_WHATSAPP_NUMBER}` },
  }[type];
  document.getElementById('modal-order-title').textContent = data.title;
  document.getElementById('modal-order-body').innerHTML = `
    <div style="background:var(--surface2);border-radius:10px;padding:12px 14px;margin-bottom:12px;">
      <div style="font-size:20px;font-weight:800;color:${type==='owner'?'var(--gold)':'var(--accent)'};font-family:'Syne',sans-serif;">${data.price}<span style="font-size:12px;font-weight:400;font-family:'DM Sans';color:var(--text2);margin-left:3px;">/ sekali</span></div>
    </div>
    ${data.desc}<br><br>Klik tombol untuk menghubungi admin.
  `;
  currentOrderLink = data.link;
  const btn = document.getElementById('btn-order-go');
  btn.style.display = '';
  btn.disabled = false;
  btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> Hubungi Sekarang';
  document.getElementById('btn-order-cancel').style.display = 'none';
  openModal('modal-order');
}

function goOrder() {
  console.log("ORDER STATE", {
    currentOrderProduct,
    currentOrderPackages,
    currentOrderPayment
  });

  // Jika ini order produk (punya data pembayaran), buat order PENDING di
  // Firestore lalu tampilkan QRIS statis — TIDAK ada payment gateway,
  // TIDAK ada QR yang digambar/dibuat secara dinamis.
  if (currentOrderPayment && currentOrderPayment.amount > 0) {
    // ==== NOMOR WHATSAPP WAJIB SEBELUM ORDER DIBUAT ====
    const waInput = document.getElementById('order-wa-input');
    const waErrorEl = document.getElementById('order-wa-error');
    const normalizedWa = normalizeWhatsappInput(waInput ? waInput.value : '');

    if (!normalizedWa) {
      if (waErrorEl) {
        waErrorEl.textContent = 'Nomor WhatsApp wajib diisi dengan format yang benar (contoh: 08xxxxxxxxxx).';
        waErrorEl.style.display = 'block';
      }
      if (waInput) waInput.focus();
      showNotif('Nomor WhatsApp wajib diisi dengan benar', 'error');
      return;
    }
    if (waErrorEl) waErrorEl.style.display = 'none';

    currentOrderWhatsapp = normalizedWa;
    currentOrderPayment.whatsapp = normalizedWa;
    createOrderAndShowQris();
    return;
  }
  // Selain itu (membership dll), perilaku lama: buka link WhatsApp
  if (currentOrderLink && currentOrderLink !== '#') window.open(currentOrderLink, '_blank');
}

// Bersihkan nilai amount jadi angka murni: hapus "Rp", titik, koma, spasi.
function sanitizeAmount(val) {
  if (val === null || val === undefined) return NaN;
  if (typeof val === 'number') return val;
  const cleaned = String(val).replace(/[^0-9]/g, '');
  return cleaned ? Number(cleaned) : NaN;
}

// ===== BUAT ORDER (PENDING) + TAMPILKAN QRIS STATIS =====
// Tidak ada backend payment/merchant di sini — order langsung ditulis ke
// Firestore dari client (diizinkan oleh firestore.rules HANYA untuk user
// login, dengan status wajib "PENDING"), lalu QRIS statis (assets/qris.png,
// gambar asli milik pemilik toko) ditampilkan. Status TIDAK PERNAH otomatis
// berubah jadi PAID di sini — hanya admin yang bisa mengubahnya setelah
// memeriksa bukti pembayaran secara manual.
async function createOrderAndShowQris() {
  const btn = document.getElementById('btn-order-go');
  const cancelBtn = document.getElementById('btn-order-cancel');
  const wrap = document.getElementById('order-qris-wrap');
  const originalBtnHtml = btn.innerHTML;
  const paymentToSend = currentOrderPayment;

  const selectedPackage = currentOrderPackages[currentSelectedPackageIndex];
  const cleanAmount = sanitizeAmount(paymentToSend.amount);
  const cleanUsername = paymentToSend.username || '';

  if (!cleanAmount || isNaN(cleanAmount) || cleanAmount <= 0) {
    showNotif('Harga produk/paket ini tidak valid (bukan angka). Cek data produk di admin.', 'error');
    return;
  }

  // Cek ulang stok di sisi client sesaat sebelum membuat order (UX cepat).
  // Otoritas sebenarnya tetap Firestore Rules + pengecekan manual admin
  // saat memproses order — dicek per PAKET (productId + packageName).
  if (currentOrderProduct && selectedPackage) {
    const { hasStock, hasStockData } = getPackageStock(currentOrderProduct.id, selectedPackage.name);
    if (hasStockData && !hasStock) {
      showNotif('STOCK SEDANG KOSONG. Hubungi admin untuk melakukan restock.', 'error');
      return;
    }
  }

  const waInputEl = document.getElementById('order-wa-input');
  if (waInputEl) waInputEl.disabled = true;

  btn.disabled = true;
  btn.innerHTML = 'Memproses...';

  try {
    const orderRef = doc(collection(db, 'orders'));
    const orderData = {
      userId: currentUser ? currentUser.uid : null,
      username: cleanUsername || (currentUser ? currentUser.displayName : null) || null,
      productId: currentOrderProduct ? currentOrderProduct.id : null,
      productName: currentOrderProduct ? currentOrderProduct.name : null,
      packageName: selectedPackage ? selectedPackage.name : null,
      price: cleanAmount,
      whatsapp: paymentToSend.whatsapp || currentOrderWhatsapp || null,
      status: 'PENDING',
      payment: null,
      createdAt: serverTimestamp(),
      paidAt: null,
      deliveredEmail: null,
      deliveredPassword: null,
      deliveredLoginUrl: null,
      deliveredNote: null,
    };
    await setDoc(orderRef, orderData);

    renderStaticQrisPayment({ id: orderRef.id, ...orderData });

    btn.style.display = 'none';
    cancelBtn.style.display = '';
    cancelBtn.textContent = 'Tutup';
    const waFieldEl = document.getElementById('order-wa-field');
    if (waFieldEl) waFieldEl.style.display = 'none';
    currentOrderPayment = null; // cegah generate ulang ganda selagi QR masih tampil

    // Muat ulang "Pesanan Saya" di background supaya order baru langsung
    // muncul di sana begitu user membuka halamannya.
    loadMyOrders().catch(() => {});
  } catch (err) {
    console.error('createOrderAndShowQris error:', err);
    showNotif('Gagal membuat order, coba lagi', 'error');
    btn.disabled = false;
    btn.innerHTML = originalBtnHtml;
    if (waInputEl) waInputEl.disabled = false;
  }
}

// ===== MUSIC PLAYER — EQUALIZER FIXED =====
function renderTrackDropdown() {
  const dd = document.getElementById('track-dropdown');
  dd.innerHTML = songs.map((s, i) => `
    <div class="track-item ${i === currentTrackIdx ? 'active' : ''}" onclick="selectTrack(${i})">
      <div class="track-num">${i + 1}</div>
      <div class="track-name">${s.title || 'Unknown'}</div>
    </div>
  `).join('');
}

window.selectTrack = function(idx) {
  currentTrackIdx = idx;
  loadTrack();
  if (audioPlayer) {
    audioPlayer.play()
      .then(() => { isPlaying = true; updatePlayUI(); })
      .catch(() => {});
  }
  document.getElementById('track-dropdown').classList.remove('open');
  renderTrackDropdown();
};

function loadTrack() {
  const s = songs[currentTrackIdx];
  if (!s) return;
  document.getElementById('music-title').textContent = s.title || 'Unknown';
  document.getElementById('music-artist').textContent = s.artist || '—';
  if (!audioPlayer) {
    audioPlayer = new Audio();
    audioPlayer.volume = 0.7;
    audioPlayer.addEventListener('timeupdate', updateProgress);
    audioPlayer.addEventListener('loadedmetadata', () => {
      document.getElementById('time-total').textContent = formatTime(audioPlayer.duration);
    });
    audioPlayer.addEventListener('ended', nextTrack);
  }
  audioPlayer.src = s.url;
  audioPlayer.load();
}

function togglePlay() {
  if (!songs.length) { showNotif('Tidak ada lagu', 'error'); return; }
  if (!audioPlayer || !audioPlayer.src) loadTrack();
  if (isPlaying) {
    audioPlayer.pause();
    isPlaying = false;
  } else {
    audioPlayer.play()
      .then(() => { isPlaying = true; updatePlayUI(); })
      .catch(() => showNotif('Gagal memutar. Cek URL lagu.', 'error'));
    return; // updatePlayUI dipanggil di .then()
  }
  updatePlayUI();
}

function updatePlayUI() {
  document.getElementById('play-icon').style.display = isPlaying ? 'none' : 'block';
  document.getElementById('pause-icon').style.display = isPlaying ? 'block' : 'none';

  // Equalizer — toggle class "playing" untuk aktifkan animasi CSS
  const eq = document.getElementById('equalizer');
  if (isPlaying) {
    eq.classList.add('playing');
  } else {
    eq.classList.remove('playing');
  }
}

function prevTrack() {
  currentTrackIdx = (currentTrackIdx - 1 + songs.length) % songs.length;
  loadTrack();
  if (isPlaying) audioPlayer.play().catch(() => {});
  renderTrackDropdown();
}

function nextTrack() {
  currentTrackIdx = (currentTrackIdx + 1) % songs.length;
  loadTrack();
  if (isPlaying) audioPlayer.play().catch(() => {});
  renderTrackDropdown();
}

function setVolume(v) { if (audioPlayer) audioPlayer.volume = v; }

function updateProgress() {
  if (!audioPlayer || !audioPlayer.duration) return;
  const pct = (audioPlayer.currentTime / audioPlayer.duration) * 100;
  document.getElementById('progress-fill').style.width = pct + '%';
  document.getElementById('time-current').textContent = formatTime(audioPlayer.currentTime);
}

function seekAudio(e) {
  if (!audioPlayer || !audioPlayer.duration) return;
  const wrap = document.getElementById('progress-wrap');
  const rect = wrap.getBoundingClientRect();
  const pct = (e.clientX - rect.left) / rect.width;
  audioPlayer.currentTime = pct * audioPlayer.duration;
}

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}

function toggleTrackMenu(e) {
  e.stopPropagation();
  document.getElementById('track-dropdown').classList.toggle('open');
}

document.addEventListener('click', e => {
  if (!e.target.closest('.music-track-select')) {
    document.getElementById('track-dropdown').classList.remove('open');
  }
});

// ===== MODAL =====
function openModal(id) { const el = document.getElementById(id); if (el) el.classList.add('open'); }
window.openModal = openModal;
function closeModal(id) {
  document.getElementById(id).classList.remove('open');
  if (id === 'modal-order') resetOrderModalState();
}

function resetOrderModalState() {
  currentOrderPayment = null;
  currentOrderProduct = null;
  currentOrderPackages = [];
  currentSelectedPackageIndex = 0;
  currentOrderLink = '';
  const wrap = document.getElementById('order-qris-wrap');
  if (wrap) wrap.innerHTML = '';
  const btn = document.getElementById('btn-order-go');
  if (btn) {
    btn.style.display = '';
    btn.disabled = false;
    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> Hubungi Sekarang';
  }
  const cancelBtn = document.getElementById('btn-order-cancel');
  if (cancelBtn) { cancelBtn.style.display = 'none'; cancelBtn.textContent = 'Batalkan Pembelian'; }
}

document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.classList.remove('open');
  });
});

// ===== NOTIF =====
let notifTimer;
function showNotif(msg, type='success') {
  const el = document.getElementById('notif');
  document.getElementById('notif-text').textContent = msg;
  el.className = 'notif notif-' + type + ' show';
  clearTimeout(notifTimer);
  notifTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

// ===== SCROLL REVEAL OBSERVER =====
function initScrollReveal() {
  const els = document.querySelectorAll('.reveal, .reveal-left, .reveal-right');
  if (!els.length) return;
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        e.target.classList.add('visible');
        observer.unobserve(e.target);
      }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
  els.forEach(el => observer.observe(el));
  setTimeout(() => els.forEach(el => el.classList.add('visible')), 900);
}

// Apply reveal to product cards dynamically
function applyRevealToCards() {
  document.querySelectorAll('.product-card').forEach((card, i) => {
    card.classList.add('reveal');
    card.style.transitionDelay = (i % 4 * 0.07) + 's';
    card.classList.remove('visible');
  });
  setTimeout(initScrollReveal, 50);
}

// ===== BACKGROUND PARTICLES =====
function initParticles() {
  const container = document.getElementById('bg-particles');
  if (!container) return;
  const colors = ['rgba(79,140,255,0.4)', 'rgba(120,80,255,0.35)', 'rgba(255,79,140,0.25)', 'rgba(79,200,255,0.3)'];
  for (let i = 0; i < 18; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    const size = Math.random() * 4 + 2;
    p.style.cssText = [
      'width:' + size + 'px',
      'height:' + size + 'px',
      'left:' + Math.random() * 100 + '%',
      'background:' + colors[Math.floor(Math.random() * colors.length)],
      'animation-duration:' + (Math.random() * 14 + 10) + 's',
      'animation-delay:' + (Math.random() * 10) + 's',
    ].join(';');
    container.appendChild(p);
  }
}

// Init on page load
document.addEventListener('DOMContentLoaded', () => {
  initScrollReveal();
});

window.applyRevealToCards = applyRevealToCards;

window.showNotif = showNotif;

// ===== ANNOUNCEMENTS SYSTEM =====
let announcements = [];

async function loadAnnouncements() {
  try {
    const snap = await getDocs(collection(db, "announcements"));
    announcements = [];
    snap.forEach(d => announcements.push({ id: d.id, ...d.data() }));
    announcements.sort((a,b) => (b.createdAt||0) - (a.createdAt||0));
  } catch(e) {
    announcements = [];
  }
}

function getAnnIcon(type) {
  const icons = {
    info:    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#7ab0ff" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
    warning: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
    success: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`,
    danger:  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
  };
  return icons[type] || icons.info;
}

function getAnnLabel(type) {
  return { info:'Info', warning:'Peringatan', success:'Update', danger:'Penting' }[type] || 'Info';
}

function openAnnPopup() {
  const active = announcements.filter(a => a.active !== false);
  const popup = document.getElementById('ann-overlay');
  const list = document.getElementById('ann-list');

  if (!active.length) {
    list.innerHTML = `<div class="ann-empty">
      <div class="ann-empty-icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text3)" stroke-width="1.5"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
      </div>
      Tidak ada notifikasi saat ini
    </div>`;
  } else {
    list.innerHTML = active.map(a => `
      <div class="ann-item">
        <div class="ann-item-icon ann-item-icon-${a.type||'info'}">${getAnnIcon(a.type||'info')}</div>
        <div class="ann-item-body">
          <div class="ann-item-title">${escHtml(a.title||'')}</div>
          <div class="ann-item-msg">${escHtml(a.msg||'').replace(/\n/g,'<br>')}</div>
          <div class="ann-item-time">${formatAnnDate(a.createdAt)}</div>
        </div>
      </div>
    `).join('');
  }

  // Update header icon/badge based on highest priority type
  const priority = ['danger','warning','success','info'];
  const topType = priority.find(t => active.some(a => a.type === t)) || 'info';
  document.getElementById('ann-main-icon').className = 'ann-icon ann-icon-' + topType;
  document.getElementById('ann-main-icon').innerHTML = getAnnIconLarge(topType);
  document.getElementById('ann-main-badge').className = 'ann-badge ann-badge-' + topType;
  document.getElementById('ann-main-badge').innerHTML = getBadgeInner(topType);
  document.getElementById('ann-main-title').textContent = active.length ? (active[0].title || 'Pemberitahuan') : 'Tidak Ada Notifikasi';
  document.getElementById('ann-main-meta').textContent = `${active.length} pemberitahuan aktif · PANAVIBUNGA STORE`;

  popup.classList.add('open');
}

function getAnnIconLarge(type) {
  const icons = {
    info:    `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#7ab0ff" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
    warning: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
    success: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="16 8 10 14 8 12"/></svg>`,
    danger:  `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`,
  };
  return icons[type] || icons.info;
}

function getBadgeInner(type) {
  const svgBell = `<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`;
  return svgBell + ' ' + getAnnLabel(type);
}

function closeAnnPopup() {
  document.getElementById('ann-overlay').classList.remove('open');
}

// Close on overlay click
document.getElementById('ann-overlay').addEventListener('click', function(e) {
  if (e.target === this) closeAnnPopup();
});

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatAnnDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString('id-ID', { day:'numeric', month:'long', year:'numeric', hour:'2-digit', minute:'2-digit' });
}

function updateBellDot() {
  const active = announcements.filter(a => a.active !== false);
  const dot = document.getElementById('nav-bell-dot');
  if (dot) dot.classList.toggle('show', active.length > 0);
}

function showBellIcon(show) {
  const bell = document.getElementById('nav-bell');
  if (bell) bell.classList.toggle('hidden', !show);
}

window.openAnnPopup = openAnnPopup;
window.closeAnnPopup = closeAnnPopup;

// ===== HOME DASHBOARD TABS (SWIPE) =====
function switchHomeTab(idx) {
  currentHomeTab = idx;
  const slider = document.getElementById('home-sections-slider');
  if (slider) slider.style.transform = `translateX(-${idx * 25}%)`;
  document.querySelectorAll('.home-nav-tab').forEach((t,i) => t.classList.toggle('active', i === idx));
  resizeHomeSlider();
  // Load orders on demand
  if (idx === 1) loadMyOrders();
}

// Keeps the visible height of the swipe carousel matched to the ACTIVE panel only,
// instead of every panel sharing the height of the tallest one (which caused
// Pesanan Saya / Reseller / Settings to look empty or not scroll to their real end).
function resizeHomeSlider() {
  const wrap = document.getElementById('home-sections-wrap');
  const panels = document.querySelectorAll('.home-section-panel');
  const active = panels[currentHomeTab];
  if (!wrap || !active) return;
  wrap.style.height = active.offsetHeight + 'px';
}
window.resizeHomeSlider = resizeHomeSlider;

let _homeSliderResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(_homeSliderResizeTimer);
  _homeSliderResizeTimer = setTimeout(resizeHomeSlider, 150);
});

// Touch swipe support for home sections
(function() {
  let startX = 0, startY = 0, isDragging = false;
  document.addEventListener('touchstart', e => {
    const wrap = document.getElementById('home-sections-wrap');
    if (!wrap || !wrap.contains(e.target)) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    isDragging = true;
  }, { passive: true });
  document.addEventListener('touchend', e => {
    if (!isDragging) return;
    isDragging = false;
    const wrap = document.getElementById('home-sections-wrap');
    if (!wrap) return;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    if (Math.abs(dx) < Math.abs(dy) * 1.5 || Math.abs(dx) < 40) return;
    if (dx < 0 && currentHomeTab < 3) switchHomeTab(currentHomeTab + 1);
    if (dx > 0 && currentHomeTab > 0) switchHomeTab(currentHomeTab - 1);
  }, { passive: true });
})();

// ===== MY ORDERS =====
async function loadMyOrders() {
  if (!currentUser) return;
  const container = document.getElementById('my-orders-list');
  if (!container) return;
  container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text2);font-size:13px;"><div class="spinner" style="margin:0 auto 10px;"></div>Memuat pesanan...</div>';
  try {
    const q = query(collection(db, "orders"), where("userId", "==", currentUser.uid), orderBy("createdAt", "desc"), limit(20));
    const snap = await getDocs(q);
    myOrders = [];
    snap.forEach(d => myOrders.push({ id: d.id, ...d.data() }));
    renderMyOrders();
  } catch(e) {
    container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text2);font-size:13px;">Gagal memuat pesanan. Coba lagi.</div>';
    resizeHomeSlider();
  }
}

function renderMyOrders() {
  const container = document.getElementById('my-orders-list');
  if (!container) return;
  if (!myOrders.length) {
    container.innerHTML = `<div class="orders-empty">
      <div class="orders-empty-icon">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--text3)" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      </div>
      <div>Belum ada pesanan</div>
      <div style="font-size:12px;margin-top:6px;">Pesanan akan muncul setelah pembayaran dikonfirmasi</div>
    </div>`;
    resizeHomeSlider();
    return;
  }
  container.innerHTML = myOrders.map(o => {
    const hasDelivery = o.deliveredEmail || o.deliveredPassword;
    return `<div class="order-card">
      <div class="order-card-header">
        <div>
          <div class="order-card-name">${escHtml(o.productName || 'Produk')}${o.packageName ? ` <span style="font-weight:400;color:var(--text2);">(${escHtml(o.packageName)})</span>` : ''}</div>
          <div class="order-card-date">${o.createdAt ? formatAnnDate(o.createdAt) : '-'}</div>
        </div>
        <span class="order-status-chip ${hasDelivery ? 'order-status-delivered' : 'order-status-pending'}">
          ${hasDelivery ? 'Terkirim' : 'Menunggu'}
        </span>
      </div>
      <div style="font-size:12.5px;color:var(--text2);">Rp${Number(o.price||0).toLocaleString('id-ID')} / bulan</div>
      ${hasDelivery ? `<div class="order-delivered-box">
        <div style="font-family:'Syne',sans-serif;font-size:11px;font-weight:700;color:var(--success);letter-spacing:0.1em;margin-bottom:8px;">✓ AKUN DIKIRIM</div>
        ${o.deliveredEmail ? `<div class="order-delivered-row"><span class="order-delivered-label">Email</span><span class="order-delivered-val">${escHtml(o.deliveredEmail)}</span></div>` : ''}
        ${o.deliveredPassword ? `<div class="order-delivered-row"><span class="order-delivered-label">Password</span><span class="order-delivered-val">${escHtml(o.deliveredPassword)}</span></div>` : ''}
        ${o.deliveredLoginUrl ? `<div class="order-delivered-row"><span class="order-delivered-label">Login URL</span><a href="${escHtml(o.deliveredLoginUrl)}" target="_blank" rel="noopener" class="order-delivered-val" style="color:var(--accent);">${escHtml(o.deliveredLoginUrl)}</a></div>` : ''}
        ${o.deliveredNote ? `<div class="order-delivered-row"><span class="order-delivered-label">Catatan</span><span class="order-delivered-val">${escHtml(o.deliveredNote)}</span></div>` : ''}
      </div>` : ''}
    </div>`;
  }).join('');
  resizeHomeSlider();
}

// ===== STOCK SYSTEM =====

// Load stock untuk display publik (hanya jumlah tersedia).
//
// Collection Firestore "stock" berisi field kredensial (email/password akun)
// dan Firestore Rules PanaviBunga membatasi baca collection ini hanya untuk
// Admin — jadi angka tersedia/total per productId+packageName diambil lewat
// endpoint serverless SENDIRI di project ini (/api/stock-availability, lihat
// api/stock-availability.js), yang HANYA mengirim balik angka agregat, tidak
// pernah field dokumen stock asli.
//
// Tetap di-poll berkala (bukan realtime listener) selama halaman terbuka
// supaya badge stok & guard "stok habis" di checkout mengikuti perubahan
// terbaru (mis. setelah buyer lain berhasil checkout).
const STOCK_POLL_INTERVAL_MS = 15000;

async function fetchStockAvailability() {
  try {
    const res = await fetch('/api/stock-availability');
    const result = await res.json();
    stockItems = (result && result.success && Array.isArray(result.data)) ? result.data : [];
  } catch (e) {
    stockItems = [];
  }
  if (products.length) renderProducts(
    stockFilter === 'all' ? products : products.filter(p => p.category === stockFilter)
  );
}

async function loadStockPublic() {
  if (stockPollTimer) { clearInterval(stockPollTimer); stockPollTimer = null; }
  await fetchStockAvailability();
  stockPollTimer = setInterval(fetchStockAvailability, STOCK_POLL_INTERVAL_MS);
}
