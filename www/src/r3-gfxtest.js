/* FRONTLINIE – r3-gfxtest.js (v0.8)  G.GfxTest: „Grafik-Test“ + G.GfxDiag: Diagnose-Anzeige
 *
 * Grafik-Test: schaltet die Grafik-Funktionen (G.Gfx3D.FLAGS, Reihenfolge = Testreihenfolge) EINZELN nacheinander zu. Je Schritt ~15 s
 * Testpartie mit automatischem Kameraschwenk/Zoom und kleiner Schlacht direkt vor der Kamera (Fahrzeuge fahren → Spuren, Schüsse,
 * Explosionen, Rauch). Der Fortschritt steht im Grafikprofil (localStorage 'frontlinie.gfxprofile', je GPU, Feld test) und wird VOR dem
 * Zuschalten gespeichert: stürzt die Grafik ab (Kontextverlust) oder reißt sie die App mit, gilt die Funktion als schlecht – auch erst
 * beim nächsten Start (render3d.js sessionStart). Ist WebGL danach gesperrt („blocked“), erscheint der Hinweis, die App ganz zu
 * schließen und neu zu öffnen; der Test lässt sich dann fortsetzen. Am Ende: Ergebnis-Code (Buchstaben der stabilen Funktionen),
 * bester stabiler Satz wird übernommen. Der eigene Spielstand wird vorher gesichert und danach wiederhergestellt.
 * Diagnose: 5× schnell auf die Uhr oben tippen (oder „Grafik-Info“ im Grafik-Menü) → GPU, Flags, Bildzeit, Puffer, Neuanlagen.
 */
var G = (typeof G !== 'undefined') ? G : {};
(function () {
  'use strict';
  if (typeof document === 'undefined') return;
  var STEP_S = 15, SAVE = 'frontlinie.save.v1', BAK = 'frontlinie.save.gfxbak';
  var STD_ONLY = 'UVLBGKRND';
  var running = false, phase = '', stepT = 0, okT = 0, lastT = 0, waveT = 0, timer = 0, center = null, banner = null, box = null, blockedShown = false;
  function X() { return G.Gfx3D; }
  function prof() { return X() ? X().profile() : null; }
  function put(p) { if (X()) X().putProfile(p); }
  function steps() { return X().FLAGS.map(function (f) { return f[1]; }); }
  function nm(l) { return X().name(l); }
  function el(tag, css, html) { var e = document.createElement(tag); if (css) e.style.cssText = css; if (html != null) e.innerHTML = html; return e; }
  var BOX = 'position:fixed;left:50%;transform:translateX(-50%);z-index:60;background:linear-gradient(180deg,rgba(24,32,42,.98),rgba(15,21,28,.98));border:1px solid rgba(147,197,253,.55);border-radius:18px;box-shadow:inset 0 1px 0 rgba(255,255,255,.06),0 24px 60px rgba(0,0,0,.6),0 2px 8px rgba(0,0,0,.5);color:#f4f7fb;font:500 17px/1.45 system-ui,sans-serif;padding:14px 16px;';
  var BTN = 'display:inline-block;min-height:48px;min-width:120px;margin:10px 6px 0 0;padding:8px 16px;font:700 17px system-ui,sans-serif;border-radius:10px;border:1px solid #93c5fd;background:linear-gradient(180deg,#2563eb,#1d4ed8);color:#fff;box-shadow:inset 0 1px 0 rgba(255,255,255,.15),0 1px 2px rgba(0,0,0,.45);';

  // ------------------------------------------------------------------ Spielstand sichern / wiederherstellen
  function backupSave() {
    try {
      if (localStorage.getItem(BAK) != null) return;
      if (G.view && G.view.running && G.Main && G.Main.autosave) G.Main.autosave();
      var s = localStorage.getItem(SAVE);
      localStorage.setItem(BAK, s == null ? '' : s);
    } catch (e) { /* egal */ }
  }
  function restoreSave(keep) {
    try {
      var s = localStorage.getItem(BAK);
      if (s == null) return;
      if (s) localStorage.setItem(SAVE, s); else localStorage.removeItem(SAVE);
      if (!keep) localStorage.removeItem(BAK); // keep: Sicherung bleibt bis Testende (v0.7-Merge: robuster bei Neustart mitten im Test)
    } catch (e) { /* egal */ }
  }

  // ------------------------------------------------------------------ Testpartie + Schlacht vor der Kamera
  function startMatch() {
    var map = (G.MAPS.list.filter(function (m) { return m.id === 'seenplatte'; })[0] || G.MAPS.list[0]).id;
    G.Main.start({ faction: 'coalition', mapId: map, diff: 'easy', fogOff: true, peace: 15, speed: 'normal', seed: 4242 });
    var S = G.Sim.S, m = S.map, T = G.DATA.TERRAIN, best = null, bd = 1e9;
    // Landkachel nahe Wasser, möglichst mittig (damit Wasser, Ufer, Gras und Kampf gleichzeitig im Bild sind)
    for (var y = 6; y < m.h - 6; y++) for (var x = 6; x < m.w - 6; x++) {
      if (T[m.terrain[y * m.w + x]].id !== 'grass') continue;
      var near = false;
      for (var k = 0; k < 16 && !near; k++) { var a = k / 16 * 6.283, tx = Math.round(x + Math.cos(a) * 5), ty = Math.round(y + Math.sin(a) * 5); if (tx >= 0 && ty >= 0 && tx < m.w && ty < m.h && T[m.terrain[ty * m.w + tx]].id === 'water') near = true; }
      var d = Math.abs(x - m.w / 2) + Math.abs(y - m.h / 2) + (near ? 0 : 30);
      if (d < bd) { bd = d; best = { x: x, y: y }; }
    }
    center = best || { x: m.w / 2, y: m.h / 2 };
    waveT = 0;
  }
  function spawnWave() {
    var S = G.Sim.S, n = 0, i;
    for (i = 0; i < S.ents.length; i++) { var e = S.ents[i]; if (!e.dead && e.kind === 'unit' && Math.abs(e.x / 32 - center.x) < 9 && Math.abs(e.y / 32 - center.y) < 9) n++; }
    if (n > 14) return;
    var T = [['tank', 0, -3], ['tank', 1, -1], ['rifle', 0, 1], ['rocket', 1, 2], ['scout', 0, 3]];
    for (i = 0; i < T.length; i++) for (var o = 0; o < 2; o++) {
      var sx = center.x + (o ? 4 : -4), sy = center.y + T[i][2] * 0.8;
      var u = G.Sim._debugSpawn(o, T[i][0], sx * 32 + 16, sy * 32 + 16);
      if (u && G.Sim._orderMove) G.Sim._orderMove(u, (center.x + (o ? -5 : 5)) * 32, (center.y + T[i][2]) * 32);
    }
  }
  function camera(t) {
    var V = G.view;
    V.cam.zoom = 1.05 + 0.25 * Math.sin(t * 0.7);
    V.centerOn((center.x + 0.5 + Math.sin(t * 0.45) * 2.5) * 32, (center.y + 0.5 + Math.cos(t * 0.33) * 1.5) * 32);
  }

  // ------------------------------------------------------------------ Ablauf
  function active() { return running; }
  function start() {
    if (!X() || !G.Render.gfx) { if (G.UI) G.UI.toast('Grafik-Test geht nur mit 3D-Grafik', true); return; }
    backupSave();
    var p = prof() || {};
    p.test = { step: 0, ok: '', bad: '', skip: '', pending: null, t0: Date.now() };
    put(p);
    begin();
  }
  function begin() {
    hideBox(); blockedShown = false;
    ['startScreen', 'pauseScreen', 'endScreen', 'helpScreen'].forEach(function (id) { var e = document.getElementById(id); if (e) e.classList.remove('show'); });
    running = true;
    var p = prof(); if (p && p.test) { p.test.resume = false; p.test.retry = null; put(p); }
    startMatch();
    showBanner();
    lastT = performance.now();
    if (!timer) timer = setInterval(tick, 200);
    nextStep();
  }
  function nextStep() {
    var p = prof(), t = p && p.test, S = steps();
    if (!t) { stop(); return; }
    while (t.step < S.length) {
      var L = S[t.step];
      var skip = (t.ok.indexOf('M') < 0 && STD_ONLY.indexOf(L) >= 0) || (L === 'D' && t.ok.indexOf('N') < 0);
      if (!skip) break;
      t.skip += L; t.step++;
    }
    if (t.step >= S.length) { put(p); finish(); return; }
    t.pending = S[t.step];      // ZUERST speichern, DANN zuschalten – ein Absturz ist so beim nächsten Start erkennbar
    put(p);
    X().refresh();
    phase = 'run'; stepT = 0; waveT = 99; okT = 0;
    showBanner();
  }
  function tick() {
    if (!running) return;
    var now = performance.now(), dt = Math.min(0.5, (now - lastT) / 1000); lastT = now;
    if (document.hidden) return;
    if (G.view && G.view.paused && G.Main) G.Main.setPaused(false);
    var ok = X().glOK();
    if (phase === 'recover') {
      okT = ok ? okT + dt : 0;
      stepT += dt;
      if (okT > 2) { hideBox(); blockedShown = false; nextStep(); return; }
      if (!ok && stepT > 6 && !blockedShown) showBlocked();
      showBanner();
      return;
    }
    if (phase !== 'run' || !ok) return;
    stepT += dt; waveT += dt;
    if (waveT > 6) { waveT = 0; try { spawnWave(); } catch (e) { console.warn(e); } }
    camera(stepT);
    if (stepT >= STEP_S) {
      var p = prof(), t = p && p.test;
      if (!t) { stop(); return; }
      t.ok += t.pending || ''; t.pending = null; t.step++;
      put(p);
      nextStep();
      return;
    }
    showBanner();
  }
  /** Vom Renderer im Kontextverlust-Ereignis (synchron) gerufen: aktuelle Funktion = schlecht, weiter mit dem stabilen Satz. */
  function onCrash() {
    var p = prof(), t = p && p.test;
    if (!t) return;
    if (t.pending) { t.bad += t.pending; t.lastBad = t.pending; t.pending = null; t.step++; }
    put(p);
    phase = 'recover'; stepT = 0; okT = 0;
  }
  function finish() {
    var p = prof() || {}, t = p.test || { ok: '', bad: '', skip: '' };
    p.flags = t.ok; p.src = 'test'; p.lastTest = { ok: t.ok, bad: t.bad, skip: t.skip, t: Date.now() };
    p.crashes = []; p.allOff = 0;
    delete p.test;
    put(p);
    stop();
    X().refresh();
    showResult(t);
  }
  function stop() {
    running = false; phase = '';
    if (timer) { clearInterval(timer); timer = 0; }
    if (banner) { banner.remove(); banner = null; }
    restoreSave();
    if (G.view) { G.view.running = false; G.view.paused = false; }
    if (G.UI && G.UI.showStart) G.UI.showStart();
  }
  function abort() {
    var p = prof();
    if (p && p.test) { delete p.test; put(p); }
    stop(); hideBox();
    X().refresh();
    if (G.UI) G.UI.toast('Grafik-Test abgebrochen – vorherige Einstellung bleibt');
  }

  // ------------------------------------------------------------------ Anzeigen (Schrift ≥ 16 px)
  function showBanner() {
    if (!running) return;
    if (!banner) {
      banner = el('div', BOX + 'top:56px;width:min(92vw,420px);padding:10px 14px;text-align:center;border-color:rgba(251,191,36,.62);border-radius:14px;');
      banner.id = 'gfxTestBanner';
      document.body.appendChild(banner);
    }
    var p = prof(), t = (p && p.test) || {}, S = steps(), L = t.pending, n = Math.min(S.length, (t.step || 0) + 1);
    var txt = phase === 'recover' ? 'Grafik-Test: Absturz bei „' + nm(t.lastBad || '?') + '“ – Grafik startet neu …'
      : 'Grafik-Test ' + n + '/' + S.length + ': ' + (L ? nm(L) + ' (' + L + ')' : '') + ' · ' + Math.max(0, Math.ceil(STEP_S - stepT)) + ' s';
    banner.innerHTML = '<div style="font-size:17px">' + txt + '</div><div style="font-size:16px;color:#cbd5e1">Stabil: ' + X().pretty(t.ok) + (t.bad ? ' · Aus: ' + X().pretty(t.bad) : '') +
      '</div><button id="gfxTestAbort" style="' + BTN + 'min-height:44px;background:rgba(127,29,29,.75);border-color:rgba(248,113,113,.66);color:#fee2e2">Abbrechen</button>';
    banner.querySelector('#gfxTestAbort').onclick = abort;
  }
  function hideBox() { if (box) { box.remove(); box = null; } }
  function showBox(html, buttons) {
    hideBox();
    box = el('div', BOX + 'top:18%;width:min(92vw,440px);', html);
    box.id = 'gfxTestBox';
    (buttons || []).forEach(function (b) { var bt = el('button', BTN + (b.css || ''), b.label); bt.id = b.id; bt.onclick = b.fn; box.appendChild(bt); });
    document.body.appendChild(box);
  }
  function showBlocked() {
    blockedShown = true;
    showBox('<b style="font-size:19px">3D-Grafik vorübergehend gesperrt</b><p style="margin:8px 0 0">Android hat die Grafik nach dem Absturz gesperrt. ' +
      'Bitte die <b>Claude-App ganz schließen</b> (auch aus der Übersicht der offenen Apps wischen) und neu öffnen. ' +
      'Danach dieses Spiel wieder öffnen – der Grafik-Test geht dort weiter.</p>', [{ id: 'gfxBlkAbort', label: 'Test abbrechen', fn: abort, css: 'background:#334155;border-color:#94a3b8' }]);
  }
  function legend(code) {
    return code.split('').map(function (l) { return '<div style="font-size:16px"><b>' + l + '</b> = ' + nm(l) + '</div>'; }).join('');
  }
  function showResult(t) {
    showBox('<b style="font-size:19px">Grafik-Test fertig</b>' +
      '<div id="gfxTestCode" style="font:800 26px/1.3 ui-monospace,monospace;margin:8px 0;letter-spacing:1px;word-break:break-all">' + X().pretty(t.ok) + '</div>' +
      '<p style="margin:0 0 6px">Jeder Buchstabe ist eine Grafik-Funktion, die stabil lief – genau diese sind jetzt eingeschaltet.</p>' +
      (t.bad ? '<p style="margin:0 0 6px;color:#fca5a5">Abgeschaltet (Absturz): ' + t.bad.split('').map(function (l) { return l + ' ' + nm(l); }).join(', ') + '</p>' : '<p style="margin:0 0 6px;color:#86efac">Keine Abstürze.</p>') +
      legend(t.ok), [{ id: 'gfxResOk', label: 'OK', fn: hideBox }]);
  }
  /** Beim Start: unterbrochener Test (z. B. nach Absturz + App-Neustart) → fortsetzen oder abbrechen. */
  function checkResume() {
    if (running || !X()) return;
    var p = prof(), t = p && p.test;
    if (!t) {
      // Renderer noch nicht da (gesperrt)? → irgendein Profil mit offenem Test → Hinweis
      try { var all = JSON.parse(localStorage.getItem(X().KEY) || '{}'); for (var k in (all.gpus || {})) if (all.gpus[k].test && !X().glOK()) { showBlocked(); return; } } catch (e) { /* egal */ }
      return;
    }
    // eigener Spielstand sofort zurück (sonst böte „Partie fortsetzen“ die Testpartie an); beim Weitertesten wird er erneut gesichert
    try { if (localStorage.getItem(BAK) != null) { restoreSave(true); if (G.UI && G.UI.showStart && !(G.view && G.view.running)) G.UI.showStart(); } } catch (e) { /* egal */ }
    var S = steps();
    var msg = t.lastBad && t.pending == null ? '„' + nm(t.lastBad) + '“ hat die Grafik abstürzen lassen und bleibt aus.' : (t.retry ? 'Der Test wurde unterbrochen; der Schritt „' + nm(t.retry) + '“ wird wiederholt.' : 'Der Test wurde unterbrochen.');
    showBox('<b style="font-size:19px">Grafik-Test fortsetzen?</b><p style="margin:8px 0 0">' + msg + '</p><p style="margin:6px 0 0">Schritt ' + Math.min(S.length, (t.step || 0) + 1) + ' von ' + S.length +
      ' · stabil bisher: ' + X().pretty(t.ok) + '</p>', [{ id: 'gfxResume', label: 'Weiter testen', fn: function () { if (!X().glOK()) { showBlocked(); return; } begin(); } },
      { id: 'gfxResumeAbort', label: 'Abbrechen', fn: abort, css: 'background:#334155;border-color:#94a3b8' }]);
  }

  // ------------------------------------------------------------------ Diagnose-Anzeige
  var diag = null, diagT = 0, taps = [];
  function diagToggle() {
    if (diag) { diag.remove(); diag = null; clearInterval(diagT); return; }
    diag = el('div', 'position:fixed;left:6px;bottom:6px;z-index:59;max-width:94vw;background:rgba(0,0,0,.86);border:2px solid #60a5fa;border-radius:8px;color:#f4f7fb;font:500 16px/1.35 ui-monospace,monospace;padding:6px 8px;pointer-events:auto;');
    diag.id = 'gfxDiag';
    diag.onclick = diagToggle;
    document.body.appendChild(diag);
    var upd = function () {
      if (!diag || !X()) return;
      var g = X().gpu(), s = X().stats(), inf = G.Render.info ? G.Render.info() : {}, p = X().profile() || {};
      diag.innerHTML = 'GPU: ' + (g.name || '?').slice(0, 60) + (g.safe ? ' (Schonprofil)' : '') +
        '<br>Flags: ' + X().pretty(X().code()) + ' · benutzt: ' + X().pretty(X().active()) +
        '<br>Bild: ' + (s.avgMs || 0).toFixed(1) + ' ms · Puffer ' + s.buf[0] + '×' + s.buf[1] + ' · ' + (inf.calls || 0) + ' Aufrufe · ' + Math.round((inf.triangles || 0) / 1000) + 'k Dreiecke' +
        '<br>Neu: Größe ' + s.setSize + ' · Tex ' + s.createTexture + ' · Puffer ' + s.createBuffer + ' · FB ' + s.createFramebuffer + ' · Batch ' + s.newBatch +
        '<br>Abstürze: ' + ((p.crashes || []).length) + (p.crashes && p.crashes.length ? ' (zuletzt aus: ' + (p.crashes[p.crashes.length - 1].off || '–') + ')' : '') + ' · Quelle: ' + (p.src || 'Standard') + (G.Render.is2D ? ' · 2D aktiv' : '');
    };
    upd(); diagT = setInterval(upd, 500);
  }
  function bindClock() {
    var c = document.getElementById('clock');
    if (!c || c.__gfxDiag) return;
    c.__gfxDiag = true;
    c.style.cursor = 'pointer'; c.style.pointerEvents = 'auto';
    c.addEventListener('pointerdown', function () {
      var now = Date.now(); taps = taps.filter(function (t) { return now - t < 4000; }); taps.push(now);
      if (taps.length >= 5) { taps = []; diagToggle(); }
    });
  }

  G.GfxTest = { start: start, abort: abort, active: active, onCrash: onCrash, checkResume: checkResume, _finish: finish, _state: function () { var p = prof(); return { running: running, phase: phase, stepT: stepT, test: p && p.test, last: p && p.lastTest, flags: p && p.flags }; }, _stepS: function (s) { STEP_S = s; } };
  G.GfxDiag = { toggle: diagToggle, shown: function () { return !!diag; } };
  function boot() { bindClock(); setTimeout(checkResume, 1200); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else setTimeout(boot, 0);
})();
