// =====================================================================
// OTP SLOTS UI — PanaviBunga Store
// =====================================================================
// File TAMBAHAN (additive) yang HANYA menangani interaksi visual 6 kotak
// digit OTP pada #page-otp:
//   - auto-focus slot pertama, auto-advance ke slot berikutnya
//   - backspace pada slot kosong -> kembali ke slot sebelumnya
//   - paste 6 digit (atau autofill iOS/Android yang menaruh semua digit
//     ke satu slot) -> otomatis disebar ke seluruh slot
//   - animasi orbit/error/verifying/success
//
// File ini TIDAK memanggil Firebase, TIDAK memanggil endpoint OTP apa
// pun, dan TIDAK mengetahui apa-apa soal auth/session. Ia hanya membaca
// & menulis DOM, lalu menyinkronkan gabungan 6 digit ke input tersembunyi
// #otp-code — elemen yang SAMA yang selama ini dibaca oleh
// handleVerifyOtp() di js/app.js. Dengan begitu logic verifikasi/kirim
// OTP di app.js tidak perlu (dan tidak) diubah cara bacanya.
//
// js/app.js memanggil beberapa fungsi opsional di sini lewat pengecekan
// `typeof window.fn === 'function'`, jadi kalau file ini gagal dimuat,
// alur OTP lama (tanpa animasi) tetap berjalan seperti biasa.
// =====================================================================
(function () {
  'use strict';

  var slots = [];
  var hiddenInput = null;
  var wrap = null;
  var stage = null;
  var hub = null;
  var errorResetTimer = null;
  var animGen = 0; // dinaikkan tiap reset supaya loop rAF lama berhenti sendiri

  function byId(id) { return document.getElementById(id); }
  function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function init() {
    wrap = byId('otp-slots');
    if (!wrap) return; // halaman OTP versi lama / markup tidak ditemukan
    slots = Array.prototype.slice.call(wrap.querySelectorAll('.otp-slot'));
    if (!slots.length) return;

    hiddenInput = byId('otp-code');
    stage = byId('otp-stage');
    hub = byId('otp-hub');

    slots.forEach(function (input, idx) {
      input.addEventListener('input', function (e) { onSlotInput(input, idx, e); });
      input.addEventListener('keydown', function (e) { onSlotKeydown(input, idx, e); });
      input.addEventListener('paste', function (e) { onSlotPaste(input, idx, e); });
      input.addEventListener('focus', function () {
        input.select();
        wrap.classList.remove('is-error');
      });
    });

    syncHidden();
  }

  function onlyDigits(str) { return (str || '').replace(/\D/g, ''); }

  function syncHidden() {
    var code = slots.map(function (s) { return onlyDigits(s.value).slice(0, 1); }).join('');
    if (hiddenInput) hiddenInput.value = code;
  }

  function popAnim(input) {
    input.classList.remove('otp-pop');
    void input.offsetWidth; // reflow supaya animasi bisa retrigger
    input.classList.add('otp-pop');
  }

  function onSlotInput(input, idx) {
    var digits = onlyDigits(input.value);

    // Autofill (iOS QuickType / Android) kadang menaruh SELURUH kode ke
    // satu slot walau maxlength="1" — deteksi lalu sebar ke slot lain,
    // sama seperti perilaku paste.
    //
    // REVISI: beberapa keyboard/WebView Android melakukan paste lewat
    // event 'input' (bukan event 'paste' dengan clipboardData), sehingga
    // sebelumnya kode tersebar mulai dari slot yang sedang fokus (idx)
    // -> kalau user paste sambil fokus di kotak ke-3, hasilnya jadi
    // "[ ][ ][4][7][1][7]" yang membingungkan. Sekarang disamakan dengan
    // perilaku paste: kode 6 digit yang lengkap SELALU disebar mulai dari
    // slot pertama, apa pun slot yang sedang fokus saat itu terjadi.
    if (digits.length > 1) {
      distribute(digits, 0);
      return;
    }

    input.value = digits;
    input.classList.toggle('is-filled', !!digits);
    if (digits) {
      popAnim(input);
      var next = slots[idx + 1];
      if (next) next.focus();
      else input.blur();
    }
    syncHidden();
  }

  function onSlotKeydown(input, idx, e) {
    if (e.key === 'Backspace') {
      if (input.value) return; // biarkan default menghapus isi slot ini
      var prev = slots[idx - 1];
      if (prev) {
        e.preventDefault();
        prev.value = '';
        prev.classList.remove('is-filled');
        prev.focus();
        syncHidden();
      }
      return;
    }
    if (e.key === 'ArrowLeft') {
      var p = slots[idx - 1];
      if (p) { e.preventDefault(); p.focus(); }
      return;
    }
    if (e.key === 'ArrowRight') {
      var n = slots[idx + 1];
      if (n) { e.preventDefault(); n.focus(); }
      return;
    }
    if (e.key === 'Enter') {
      var btn = byId('btn-otp-verify');
      if (btn && !btn.disabled) { e.preventDefault(); btn.click(); }
      return;
    }
    // Cegah karakter selain digit, biarkan tombol kontrol (Tab, Delete, dst) lewat.
    if (e.key.length === 1 && !/[0-9]/.test(e.key)) {
      e.preventDefault();
    }
  }

  function onSlotPaste(input, idx, e) {
    var clip = e.clipboardData || window.clipboardData;
    var text = clip ? clip.getData('text') : '';
    var digits = onlyDigits(text);
    if (!digits) return;
    e.preventDefault();
    distribute(digits, 0); // paste selalu mengisi dari slot pertama
  }

  function distribute(digits, startIdx) {
    var maxLen = slots.length - startIdx;
    digits = digits.slice(0, maxLen);
    var i = startIdx;
    for (var d = 0; d < digits.length; d++, i++) {
      slots[i].value = digits[d];
      slots[i].classList.add('is-filled');
      popAnim(slots[i]);
    }
    syncHidden();
    var lastFilledIdx = startIdx + digits.length - 1;
    var focusTarget = slots[lastFilledIdx + 1] || slots[lastFilledIdx];
    if (focusTarget) focusTarget.focus();
  }

  // ---- Hook opsional yang dipanggil dari js/app.js (defensif) ----

  // ---- Orbit sukses: kotak OTP itu sendiri yang mengorbit -------------
  // Dipanggil hanya setelah backend menyatakan kode BENAR (lihat
  // handleVerifyOtp di js/app.js). Alurnya:
  //   1) FORM   — tiap slot bergerak dari posisi grid saat ini menuju
  //               formasi lingkaran (FLIP-style: posisi awal diukur
  //               dulu lewat getBoundingClientRect, jadi transisinya
  //               smooth, bukan teleport).
  //   2) SPIN   — keenam slot berputar bersama mengelilingi #otp-hub
  //               tepat satu putaran penuh (360°), lalu berhenti persis
  //               di formasi yang sama (tidak ada snap/jump).
  //   3) SETTLE — glow sukses per-slot + hub berubah jadi centang.
  // Hanya `translate()` yang dipakai pada tiap slot (posisi dihitung
  // ulang tiap frame dari sudut+radius) — bukan `rotate()` pada elemen
  // slot itu sendiri — sehingga angka di dalamnya otomatis tetap
  // upright/terbaca sepanjang animasi (setara efek counter-rotation).
  function computeOrbitMetrics() {
    var stageRect = stage.getBoundingClientRect();
    var slotRect = slots[0].getBoundingClientRect();
    var slotSize = Math.max(slotRect.width, slotRect.height, 38);
    var available = Math.min(stageRect.width, 232); // batas atas ukuran orbit
    var size = Math.max(150, available); // stage jadi persegi seukuran ini
    var radius = Math.max(36, size / 2 - slotSize / 2 - 10);
    return { size: size, radius: radius };
  }

  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
  function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

  function runOrbitSuccessSequence(resolve) {
    var myGen = animGen;
    var stageRect = stage.getBoundingClientRect();
    var centerX = stageRect.left + stageRect.width / 2;
    var centerY = stageRect.top + stageRect.height / 2;

    // 1. Ukur posisi tiap slot SEKARANG (masih dalam grid biasa) relatif
    //    ke titik tengah stage — ini titik awal animasi FLIP.
    var startOffsets = slots.map(function (s) {
      var r = s.getBoundingClientRect();
      return { x: (r.left + r.width / 2) - centerX, y: (r.top + r.height / 2) - centerY };
    });

    // 2. Kunci tinggi stage ke nilai px saat ini supaya transisi tinggi
    //    berikutnya (ke ukuran orbit) punya titik awal yang jelas.
    stage.style.height = stageRect.height + 'px';
    void stage.offsetHeight; // reflow

    wrap.classList.add('is-orbit-mode');
    var metrics = computeOrbitMetrics();
    var targetAngles = slots.map(function (_, idx) { return (idx * 60 - 90) * Math.PI / 180; });

    slots.forEach(function (s, idx) {
      s.style.transform = 'translate(-50%,-50%) translate(' + startOffsets[idx].x + 'px,' + startOffsets[idx].y + 'px)';
    });

    stage.classList.add('is-orbiting');
    requestAnimationFrame(function () {
      if (myGen !== animGen) return;
      stage.style.height = metrics.size + 'px';
    });

    if (prefersReducedMotion()) {
      // Langsung ke formasi akhir + sukses, tanpa animasi bertahap.
      slots.forEach(function (s, idx) {
        var x = Math.cos(targetAngles[idx]) * metrics.radius;
        var y = Math.sin(targetAngles[idx]) * metrics.radius;
        s.style.transform = 'translate(-50%,-50%) translate(' + x + 'px,' + y + 'px)';
      });
      settleSuccess(myGen, resolve);
      return;
    }

    var FORM_MS = 550;
    var formStart = null;
    function formStep(now) {
      if (myGen !== animGen) return;
      if (formStart === null) formStart = now;
      var t = Math.min(1, (now - formStart) / FORM_MS);
      var e = easeOutCubic(t);
      slots.forEach(function (s, idx) {
        var tx = startOffsets[idx].x * (1 - e) + Math.cos(targetAngles[idx]) * metrics.radius * e;
        var ty = startOffsets[idx].y * (1 - e) + Math.sin(targetAngles[idx]) * metrics.radius * e;
        s.style.transform = 'translate(-50%,-50%) translate(' + tx + 'px,' + ty + 'px)';
      });
      if (t < 1) {
        requestAnimationFrame(formStep);
      } else {
        startSpinPhase(myGen, metrics, targetAngles, resolve);
      }
    }
    requestAnimationFrame(formStep);
  }

  function startSpinPhase(myGen, metrics, targetAngles, resolve) {
    var SPIN_MS = 900;
    var spinStart = null;
    function spinStep(now) {
      if (myGen !== animGen) return;
      if (spinStart === null) spinStart = now;
      var t = Math.min(1, (now - spinStart) / SPIN_MS);
      var e = easeInOutCubic(t);
      var spinAngle = e * Math.PI * 2; // tepat 1 putaran penuh -> settle tanpa snap
      slots.forEach(function (s, idx) {
        var a = targetAngles[idx] + spinAngle;
        var x = Math.cos(a) * metrics.radius;
        var y = Math.sin(a) * metrics.radius;
        s.style.transform = 'translate(-50%,-50%) translate(' + x + 'px,' + y + 'px)';
      });
      if (t < 1) {
        requestAnimationFrame(spinStep);
      } else {
        settleSuccess(myGen, resolve);
      }
    }
    requestAnimationFrame(spinStep);
  }

  function settleSuccess(myGen, resolve) {
    if (myGen !== animGen) return;
    if (stage) stage.classList.add('is-success');
    slots.forEach(function (s) { s.classList.add('is-orbit-success'); });
    setTimeout(function () {
      if (myGen !== animGen) return;
      resolve();
    }, 380);
  }

  window.otpSlotsReset = function () {
    if (!slots.length) return;
    animGen++; // batalkan loop rAF orbit yang mungkin masih berjalan
    clearTimeout(errorResetTimer);
    slots.forEach(function (s) {
      s.value = '';
      s.disabled = false;
      s.classList.remove('is-filled', 'otp-pop', 'is-orbit-success');
      s.style.transform = '';
    });
    if (wrap) wrap.classList.remove('is-error', 'is-verifying', 'is-orbit-mode');
    if (stage) {
      stage.classList.remove('is-orbiting', 'is-success');
      stage.style.height = '';
    }
    syncHidden();
    slots[0].focus();
  };

  window.otpSlotsSetVerifying = function (isVerifying) {
    if (!slots.length) return;
    slots.forEach(function (s) { s.disabled = !!isVerifying; });
    if (wrap) wrap.classList.toggle('is-verifying', !!isVerifying);
  };

  window.otpSlotsError = function () {
    if (!wrap || !slots.length) return;
    clearTimeout(errorResetTimer);
    wrap.classList.remove('is-error');
    void wrap.offsetWidth;
    wrap.classList.add('is-error');
    errorResetTimer = setTimeout(function () {
      wrap.classList.remove('is-error');
      slots.forEach(function (s) { s.value = ''; s.classList.remove('is-filled'); });
      syncHidden();
      slots[0].focus();
    }, 420);
  };

  window.otpSlotsSuccess = function () {
    return new Promise(function (resolve) {
      if (!stage || !slots.length) { resolve(); return; }
      runOrbitSuccessSequence(resolve);
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
