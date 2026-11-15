/* FRONTLINIE – main.js
 * Start, Spielschleife (requestAnimationFrame, Sim mit festem 20-Hz-Tick + Interpolation), Autosave.
 *
 * G.view – Client-Zustand (NICHT Teil der Simulation, wird von Render/Input/UI geteilt):
 *   pid            Spieler-Index des Menschen (0)
 *   cam {x,y,zoom} Weltpixel (Bodenpunkt) der linken oberen Bildschirmecke, Zoom 0.5..2
 *   PITCH, K, ppx(), ppy()  3D: Kameraneigung und Maßstab (Bildschirm-px je Weltpixel), panBy(dx,dy), anchor(w,sx,sy)
 *   vw, vh         Größe des Karten-Canvas in CSS-Pixeln
 *   sel            Array ausgewählter Entitäts-IDs (eigene Einheiten ODER ein Gebäude)
 *   groups         [[ids],[ids],[ids]] Gruppen 1–3
 *   placing        null | { type, tx, ty, ok, reason, set (Touch: Vorschau gesetzt) }
 *   arty           null | { id (Artilleriestellung bzw. Superwaffen-Gebäude), x, y (Ziel, Weltpixel), set, ok, reason }  Zielwahl für Artillerie-/Superwaffenschlag;
 *                  v0.4 Superwaffe zusätzlich sw ('orbital'|'missile') und radius (Kacheln)
 *   hold           null | { x, y, t0 }  Langdruck-Anzeige (Touch, vor dem Ziehen eines Auswahlrahmens)
 *   box            null | { x0,y0,x1,y1 } Auswahlrahmen in Bildschirm-px
 *   amArmed        Angriff-Bewegen scharf (nächster Befehl = attackMove)
 *   addMode        Touch „+“: Tippen fügt zur Auswahl hinzu
 *   boxMode        Touch „Rahmen“: nächstes Ziehen = Auswahlrahmen
 *   paused, running, speed ('slow'|'normal'|'fast'), alpha (Interpolation 0..1)
 *   markers        [{x,y,kind:'move'|'attack'|'rally',t0}] Befehlsrückmeldung (Zeit in ms)
 *   hover          {x,y} Weltposition des Mauszeigers oder null
 *   tab            aktiver Seitenleisten-Tab ('building'|'infantry'|'vehicle')
 * Hilfen: G.view.toWorld(sx,sy) → {x,y}; G.view.toScreen(wx,wy) → {x,y}; G.view.centerOn(wx,wy);
 *         G.view.clampCam(); G.view.mySel() → lebende ausgewählte Entitäten
 * v0.7 Diagonale Kamera (SPEC_v07 §3): YAW (W11: −π/4 'diag' = DIAG, Karte links oben → rechts unten | 0 'straight'), camMode, cy/sy = cos/sin(YAW), setCamMode(m) (Mitte bleibt),
 *         center()/setCenter(x,y) (Bodenpunkt der Bildmitte = cam + (vw/2/ppx, vh/2/ppy)), affine() → {a,b,c,d,e,f} (Welt→Bildschirm für setTransform),
 *         screenRectToWorldPoly(x0,y0,x1,y1) → 4 Weltpunkte, viewPoly() → sichtbarer Bodenausschnitt, viewBounds(pad) → Hüllrechteck {x0,y0,x1,y1}.
 *         Bildschirm = Mitte + Rot(YAW)·(Welt − C)·(ppx, ppy) mit Rot = [[cy, −sy], [sy, cy]]. W11: lightDir(base) dreht Lichtrichtungen mit der Kamera.
 * v0.7 Friedenszeit: start(opts.peace Minuten) → G.Sim.create({ peace: Sekunden }) und S.settings.peace (Sekunden).
 * Ton: G.Audio.init() beim Start, unlock() beim ersten pointerdown/keydown, update(dt) jedes Frame (UI ruft onMenu/onGameStart/onGameEnd).
 * G.Main: start(opts), resume(), quitToMenu(), setPaused(b), togglePause(), autosave()
 */
var G = (typeof G !== 'undefined') ? G : {};
(function () {
  // Unerwartete Fehler sichtbar machen (hilft bei der Fehlersuche auf dem Handy)
  var lastErr = 0;
  window.addEventListener('error', function (e) {
    var t = Date.now(); if (t - lastErr < 3000) return; lastErr = t;
    try { if (G.UI && G.UI.toast) G.UI.toast('Fehler: ' + (e.message || e), true); } catch (x) { /* egal */ }
  });

  'use strict';
  var TILE = G.DATA.TILE, STEP = 1 / G.DATA.TICK_HZ;

  var V = G.view = {
    pid: 0, cam: { x: 0, y: 0, zoom: 1 }, vw: 300, vh: 300, sel: [], groups: [[], [], []],
    placing: null, arty: null, hold: null, box: null, amArmed: false, addMode: false, boxMode: false, repairMode: false,   // v0.9.2 Reparatur: repairMode = Reparatur-Modus (HUD-Knopf / Taste R)
    paused: false, running: false, speed: 'normal', alpha: 0, markers: [], hover: null, tab: 'building',
    // 3D: Gekippte orthografische Kamera (Neigung PITCH), v0.7 zusätzlich um die Hochachse gedreht (YAW). Bildschirm ↔ Boden (Ebene y=0)
    //     bleibt exakt affin: (u, v) = Rot(YAW)·(Welt − C), Bildschirm = Mitte + (u·ppx(), v·ppy()), ppy() = ppx()·sin(PITCH).
    //     Rot(θ) = [[cos θ, −sin θ], [sin θ, cos θ]]. W11: 'diag' = −π/4 (Red-Alert-2-Blick): Welt +x zeigt nach rechts OBEN, Welt +y nach
    //     rechts UNTEN – die Karte läuft von links oben nach rechts unten (v0.7–W10: +π/4, Karte von rechts oben nach links unten).
    //     Die Kamera blickt damit von Süd-WEST (+y, −x); Gebäude sind in r3-models.js an x gespiegelt, damit ihre Fronten zur Kamera zeigen.
    //     C = Bodenpunkt in der Bildschirmmitte = (cam.x + vw/2/ppx, cam.y + vh/2/ppy). cam.x/cam.y behalten so bei YAW = 0 exakt die alte
    //     Bedeutung „Bodenpunkt der linken oberen Bildschirmecke“ (Spielstände kompatibel); bei YAW ≠ 0 sind sie nur noch eine Kodierung von C.
    //     Entspricht einem Raycast auf die Bodenebene (render3d.js nutzt dieselben Werte für die Kamera).
    PITCH: 55 * Math.PI / 180, K: 1.25,
    YAW: -Math.PI / 4, camMode: 'diag', cy: Math.cos(-Math.PI / 4), sy: Math.sin(-Math.PI / 4), DIAG: -Math.PI / 4,
    ppx: function () { return V.cam.zoom * V.K; },
    ppy: function () { return V.cam.zoom * V.K * Math.sin(V.PITCH); },
    /** v0.7: Weltpunkt in der Bildschirmmitte. */
    center: function () { return { x: V.cam.x + V.vw / 2 / V.ppx(), y: V.cam.y + V.vh / 2 / V.ppy() }; },
    setCenter: function (cx, cy) { V.cam.x = cx - V.vw / 2 / V.ppx(); V.cam.y = cy - V.vh / 2 / V.ppy(); },
    toWorld: function (sx, sy) {
      var px = V.ppx(), py = V.ppy(), u = (sx - V.vw / 2) / px, v = (sy - V.vh / 2) / py;
      return { x: V.cam.x + V.vw / 2 / px + V.cy * u + V.sy * v, y: V.cam.y + V.vh / 2 / py - V.sy * u + V.cy * v };
    },
    toScreen: function (wx, wy) {
      var px = V.ppx(), py = V.ppy(), dx = wx - V.cam.x - V.vw / 2 / px, dy = wy - V.cam.y - V.vh / 2 / py;
      return { x: V.vw / 2 + (V.cy * dx - V.sy * dy) * px, y: V.vh / 2 + (V.sy * dx + V.cy * dy) * py };
    },
    /** v0.7: Abbildung Welt → Bildschirm als Matrix für ctx.setTransform(a, b, c, d, e, f): sx = a·wx + c·wy + e, sy = b·wx + d·wy + f. */
    affine: function () {
      var px = V.ppx(), py = V.ppy(), C = V.center(), a = px * V.cy, c = -px * V.sy, b = py * V.sy, d = py * V.cy;
      return { a: a, b: b, c: c, d: d, e: V.vw / 2 - a * C.x - c * C.y, f: V.vh / 2 - b * C.x - d * C.y };
    },
    /** v0.7: Bildschirmrechteck → 4 Weltpunkte (Bodenebene) in der Reihenfolge (x0,y0) (x1,y0) (x1,y1) (x0,y1). */
    screenRectToWorldPoly: function (x0, y0, x1, y1) { return [V.toWorld(x0, y0), V.toWorld(x1, y0), V.toWorld(x1, y1), V.toWorld(x0, y1)]; },
    /** v0.7: sichtbarer Bodenausschnitt (Viereck, Weltpixel). */
    viewPoly: function () { return V.screenRectToWorldPoly(0, 0, V.vw, V.vh); },
    /** v0.7: achsenparalleles Welt-Rechteck um den sichtbaren Ausschnitt (+ pad Bildschirm-px rundum) – für grobe Sichtprüfungen. */
    viewBounds: function (pad) {
      var p = V.screenRectToWorldPoly(-(pad || 0), -(pad || 0), V.vw + (pad || 0), V.vh + (pad || 0)), r = { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 };
      for (var i = 0; i < 4; i++) { r.x0 = Math.min(r.x0, p[i].x); r.x1 = Math.max(r.x1, p[i].x); r.y0 = Math.min(r.y0, p[i].y); r.y1 = Math.max(r.y1, p[i].y); }
      return r;
    },
    centerOn: function (wx, wy) { V.setCenter(wx, wy); V.clampCam(); },
    // 3D: Kamera um Bildschirm-Delta verschieben (Ziehen) bzw. Weltpunkt w an Bildschirmpunkt (sx,sy) heften (Zoom/Pinch)
    panBy: function (dx, dy) {
      var u = dx / V.ppx(), v = dy / V.ppy();
      V.cam.x -= V.cy * u + V.sy * v; V.cam.y -= -V.sy * u + V.cy * v; V.clampCam();
    },
    anchor: function (w, sx, sy) {
      var u = (sx - V.vw / 2) / V.ppx(), v = (sy - V.vh / 2) / V.ppy();
      V.setCenter(w.x - (V.cy * u + V.sy * v), w.y - (-V.sy * u + V.cy * v)); V.clampCam();
    },
    /** v0.7: Kameramodus 'diag' (YAW = DIAG = −π/4 seit W11) | 'straight' (YAW = 0); Bildmitte bleibt auf demselben Weltpunkt. Gespeichert in localStorage 'frontlinie.cam'
     *  (ein gespeichertes 'diag' aus v0.7–W10 ergibt damit die neue Diagonale). */
    setCamMode: function (m, noSave) {
      m = m === 'straight' ? 'straight' : 'diag';
      var C = V.center();
      V.camMode = m; V.YAW = m === 'diag' ? V.DIAG : 0; V.cy = Math.cos(V.YAW); V.sy = Math.sin(V.YAW);
      if (Math.abs(V.sy) < 1e-12) V.sy = 0;
      V.setCenter(C.x, C.y); V.clampCam();
      if (!noSave) { try { localStorage.setItem('frontlinie.cam', m); } catch (e) { /* egal */ } }
      return m;
    },
    /** Bildmitte so begrenzen, dass die Karte im Bild bleibt. Gerade: wie bisher (höchstens 20 % des Bildes über den Rand).
     *  Diagonal: die Karte erscheint als Raute – die Mitte darf bis auf ~0,55 halbe Bildbreite/-höhe an den Rand, damit jede Ecke sichtbar wird. */
    clampCam: function () {
      var S = G.Sim.S; if (!S) return;
      if (!isFinite(V.cam.zoom)) V.cam.zoom = 1;
      if (!isFinite(V.cam.x)) V.cam.x = 0;
      if (!isFinite(V.cam.y)) V.cam.y = 0;
      var ww = S.map.w * TILE, wh = S.map.h * TILE, hu = V.vw / 2 / V.ppx(), hv = V.vh / 2 / V.ppy(); // halber sichtbarer Bodenausschnitt (Bildschirmachsen)
      var ac = Math.abs(V.cy), as = Math.abs(V.sy);
      var hx = ac * hu + as * hv, hy = as * hu + ac * hv;                 // halbe Ausdehnung in Weltachsen (Hüllrechteck)
      var lx = 0.6 * hx, ly = 0.6 * hy;
      if (as > 1e-6) { var lim = 0.55 * Math.min(hu, hv); lx = Math.min(lx, lim); ly = Math.min(ly, lim); }
      var C = V.center();
      C.x = (2 * lx >= ww) ? ww / 2 : Math.max(lx, Math.min(ww - lx, C.x));
      C.y = (2 * ly >= wh) ? wh / 2 : Math.max(ly, Math.min(wh - ly, C.y));
      V.setCenter(C.x, C.y);
    },
    /** W11: Lichtrichtung [x, y, z] (Weltachsen, zur Sonne) aus einem Wert, der für die alte Diagonale (YAW = π/4) abgestimmt war:
     *  in der Diagonale um (π/4 − YAW) mitgedreht → das Licht kommt relativ zur Kamera aus derselben Richtung wie bisher (Schatten fallen
     *  am Bildschirm gleich). Gerade Kamera (YAW = 0): unverändert. out optional (Array, wird befüllt). */
    lightDir: function (base, out) {
      var x = base[0], z = base[2], o = out || [0, 0, 0];
      if (Math.abs(V.YAW) > 1e-9) { var a = Math.PI / 4 - V.YAW, c = Math.cos(a), s = Math.sin(a); o[0] = c * x - s * z; o[2] = s * x + c * z; } else { o[0] = x; o[2] = z; }
      o[1] = base[1]; return o;
    },
    mySel: function () {
      var r = [], keep = [];
      for (var i = 0; i < V.sel.length; i++) {
        var e = G.Sim.get(V.sel[i]);
        if (e && !e.dead) { r.push(e); keep.push(e.id); }
      }
      if (keep.length !== V.sel.length) V.sel = keep;
      return r;
    }
  };

  try { var cm0 = localStorage.getItem('frontlinie.cam'); V.setCamMode(cm0 === 'straight' ? 'straight' : 'diag', true); } catch (e) { /* egal */ }

  var acc = 0, last = 0, saveTimer = 0;
  /** G.Audio-Aufruf, tolerant gegen fehlende Funktion/Fehler (Ton darf das Spiel nie stören). */
  function audio(fn, a) { try { if (G.Audio && G.Audio[fn]) G.Audio[fn](a); } catch (e) { /* Ton optional */ } }

  function start(opts) {
    var seed = (opts.seed != null ? opts.seed : (Date.now() ^ 0x5bd1e995)) >>> 0;
    // v1.0: Gegner-Fraktion gewählt (opts.aiFaction) oder Zufall unter den beiden anderen Fraktionen; ohne Angabe wie bisher die andere der beiden alten
    var F = G.DATA.FACTIONS, ids = G.DATA.FACTION_IDS || ['coalition', 'syndicate'], other;
    if (opts.aiFaction && F[opts.aiFaction]) other = opts.aiFaction;
    else if (opts.aiFaction === 'random') { var rest = ids.filter(function (f) { return f !== opts.faction; }); other = rest[(seed >>> 3) % rest.length]; }
    else other = opts.faction === 'coalition' ? 'syndicate' : 'coalition';
    // v0.7 Friedenszeit: opts.peace in Minuten (0/5/10/15, Standard 5) → an G.Sim.create als Sekunden (opts.peace), S.settings.peace in Sekunden
    var pm = opts.peace == null || opts.peace === '' ? 5 : +opts.peace; if (!(pm >= 0)) pm = 5;
    G.Sim.create({ mapId: opts.mapId, seed: seed, fogOff: opts.fogOff, speed: opts.speed, peace: pm * 60,
      players: [{ faction: opts.faction, ai: null }, { faction: other, ai: opts.diff || 'medium' }] });
    G.Sim.S.settings.diff = opts.diff || 'medium';
    if (G.Sim.S.settings.peace == null) G.Sim.S.settings.peace = pm * 60;
    begin();
    var hq = G.Sim.S.map.starts[V.pid];
    V.cam.zoom = defaultZoom();
    V.centerOn((hq.tx + 1.5) * TILE, (hq.ty + 2.5) * TILE);
    G.Save.save(saveExtra());
  }
  function resume() {
    var extra = G.Save.load();
    if (!extra) return false;
    begin();
    if (extra.cam) { V.cam.x = extra.cam.x; V.cam.y = extra.cam.y; V.cam.zoom = extra.cam.zoom || 1; V.clampCam(); }
    if (extra.groups) V.groups = extra.groups;
    return true;
  }
  function begin() {
    V.speed = G.Sim.S.settings.speed || 'normal';
    V.sel = []; V.groups = [[], [], []]; V.placing = null; V.arty = null; V.hold = null; V.box = null; V.amArmed = false; V.addMode = false; V.boxMode = false; V.repairMode = false;
    V.markers.length = 0; V.paused = false; V.running = true; acc = 0; saveTimer = 0;
    G.Render.reset();
    G.UI.onGameStart();
  }
  function defaultZoom() { return Math.min(V.vw, V.vh) < 500 ? 0.9 : 1.15; }
  function saveExtra() { return { cam: { x: V.cam.x, y: V.cam.y, zoom: V.cam.zoom }, groups: V.groups }; }
  function autosave() { if (V.running && G.Sim.S && !G.Sim.S.over) G.Save.save(saveExtra()); }
  function quitToMenu() { autosave(); V.running = false; V.paused = false; G.UI.showStart(); }
  function setPaused(b) { V.paused = !!b; G.UI.onPause(V.paused); }
  function togglePause() { setPaused(!V.paused); }

  function frame(tms) {
    requestAnimationFrame(frame);
    var dt = last ? Math.min(0.25, (tms - last) / 1000) : 0;
    last = tms;
    var S = G.Sim.S;
    if (V.running && S) {
      if (!V.paused && !S.over) {
        acc += dt * (G.DATA.SPEEDS[V.speed] || 1);
        var n = 0;
        while (acc >= STEP && n < 6) { G.Sim.step(); acc -= STEP; n++; }
        if (n >= 6) acc = 0;
        saveTimer += dt;
        if (saveTimer > 30) { saveTimer = 0; autosave(); }
        if (S.over) { G.Save.clear(); G.UI.showEnd(); }
      }
      V.alpha = V.paused ? 1 : Math.min(1, acc / STEP);
      G.Input.update(dt);
    }
    G.Render.draw(V.alpha);
    G.UI.update(dt);
    audio('update', dt);
  }

  function boot() {
    G.Render.init(document.getElementById('cv'), document.getElementById('mini'));
    G.Input.init();
    G.UI.init();
    audio('init');
    // Browser verlangen eine Geste, bevor Ton erlaubt ist: erster Tipp/Tastendruck irgendwo entsperrt G.Audio
    var unlocked = false;
    function unlock() {
      if (unlocked) return; unlocked = true;
      window.removeEventListener('pointerdown', unlock, true); window.removeEventListener('keydown', unlock, true);
      audio('unlock');
    }
    window.addEventListener('pointerdown', unlock, true); window.addEventListener('keydown', unlock, true);
    document.addEventListener('visibilitychange', function () { if (document.hidden) { autosave(); if (V.running) setPaused(true); } });
    window.addEventListener('pagehide', autosave);
    G.UI.showStart();
    requestAnimationFrame(frame);
  }

  G.Main = { jumpTo: function (x, y) { V.centerOn(x, y); }, start: start, resume: resume, quitToMenu: quitToMenu, setPaused: setPaused, togglePause: togglePause, autosave: autosave };
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  }
})();
