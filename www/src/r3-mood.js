/* FRONTLINIE – src/r3-mood.js  (Thema/Wetter/Tageszeit, G.R3W + G.Mood)
 *
 * Kartenstimmungen – rein optisch, LIEST nur Sim-Zustand (keine Spielwirkung, nichts im Sim-Zustand; Pause hält alles an):
 *   Thema   'temperate' | 'winter'            → R.mood.theme: r3-terrain baut Winter-Bodenschichten/Kiefern/Eisrand (T_WINTER), SH.uSnow = 1
 *                                               (Schneehauben über fowify/moodify in render3d.js), SH.uIce = 1, Atemwolken, kälteres Licht, tiefere Sonne.
 *   Tageszeit 'day' | 'dusk' | 'night'         → Licht (Sonne/Himmel/Richtung), Toon-Tönung (uInkL/uInkS/uInkW), Palette des Abschlusses,
 *                                               SH.uMoodCol (unbeleuchtetes: Wasser, Vorland, Rauch), SH.uNight (Fensterlicht), R.glowK (Feuer/Blitze kräftiger),
 *                                               additive Lichtflecken: Scheinwerferkegel (Fahrzeuge), Laternen (Karten-Deko), Positionslichter (Gebäude).
 *   Wetter  'none' | 'rain' | 'snow' | 'sand'  → EINE Wetter-Schicht (1 Draw-Call: bis 1600 Teilchen-Quads + 1 Bildschirm-Schleier, alles im Vertex-Shader
 *                                               bewegt – keine Uploads je Bild), Stärke an-/abschwellend aus Karten-Seed + Spielzeit (S.tick),
 *                                               Regen: SH.uWet (nasser, dunklerer Boden), SH.uRain (Tropfenringe im Wasser).
 * Quelle der Stimmung: G.MAPS.mood(mapId) (maps.js, Kartenfelder theme/time/weather). Option „Wetter: An/Aus“: G.Mood (localStorage 'frontlinie.weather').
 * Budgets: Teilchen je Stufe (WBUDGET), Sparmodus minimal und ohne Schleier. Keine Render-Targets, keine Allokation je Bild.
 * Schnittstelle (vom Kern render3d.js aufgerufen): link(), init(), setMap(m) (vor dem Geländebau), reset() (danach), look() (nach applyLook),
 *   fill(S, alpha, dt) (vor den Flushes), update(S, alpha, dt, cam) (vor dem Rendern), iconBegin()/iconEnd(), state().
 * Für neue Modelle: nichts zu tun – Schnee/Nachtlicht kommen aus dem Material (siehe render3d.js „Thema/Wetter/Tageszeit: gemeinsame Material-Erweiterung“).
 */
(function () {
  'use strict';
  var G = window.G = window.G || {};
  // ------------------------------------------------------------------ Option „Wetter“ (auch für render2d/ui, ohne WebGL)
  var WKEY = 'frontlinie.weather', wOn = true;
  try { wOn = localStorage.getItem(WKEY) !== '0'; } catch (e) { /* egal */ }
  G.Mood = {
    weatherOn: function () { return wOn; },
    setWeather: function (on) { wOn = !!on; try { localStorage.setItem(WKEY, wOn ? '1' : '0'); } catch (e) { /* egal */ } },
    /** Stärke 0..1 des Wetters zur Spielzeit t (s) – deterministisch aus Seed (an- und abschwellend, Perioden ~1–3 min). */
    intensity: function (seed, t, kind) {
      var n = vn1(t / 95 + seed * 0.013) * 0.7 + vn1(t / 31 + seed * 0.029 + 7.1) * 0.3;
      var k = clamp((n - 0.28) / 0.5, 0, 1);
      if (kind === 'snow') k = 0.25 + 0.75 * k; else if (kind === 'sand') k = 0.35 + 0.65 * k; else k = 0.1 + 0.9 * k;
      return mix(0.7, k, smooth(t / 45));   // Partiebeginn: deutlich sichtbar, danach frei
    },
    seedOf: function (S) { var id = String(S.map.id || ''), h = 2166136261; for (var i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619); return ((h ^ (S.settings.seed | 0)) >>> 0) % 100000; }
  };
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function mix(a, b, t) { return a + (b - a) * t; }
  function smooth(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
  function h1(i) { var h = Math.imul(i | 0, 374761393) ^ 0x5bd1e995; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
  function vn1(x) { var i = Math.floor(x), f = x - i; f = f * f * (3 - 2 * f); return mix(h1(i), h1(i + 1), f); }

  var R = G.R3, THREE = R && R.THREE;
  if (!R || !THREE) return;
  var M3 = null, T3 = null, F3 = null, D = G.DATA, TILE = D.TILE;

  // ------------------------------------------------------------------ Stimmungs-Tabellen
  // Licht: Farbe (mit Anteil k zur Grundfarbe gemischt), Intensitätsfaktor; ink: Toon-Stufen-Faktor, Licht-/Schattentönung; moodCol: Tönung unbeleuchteter Flächen.
  var TIME = {
    day: { sun: null, sunK: 1, hemi: null, hemiK: 1, dir: null, haze: null, mood: [1, 1, 1], lv: 1, iexp: 1, inkW: [1, 1, 1], inkS: [1, 1, 1], paper: 1, night: 0, glow: 1, lights: 0, exp: 1, expStd: 1 },
    dusk: { sun: ['#ff9a5a', 0.8], sunK: 0.82, hemi: ['#7f7fb2', 0.6], hemiK: 0.78, dir: [-0.86, 0.3, -0.4], haze: '#b98a78', mood: [0.98, 0.8, 0.72], lv: 0.95, iexp: 0.9,
      inkW: [1.22, 0.94, 0.72], inkS: [0.84, 0.8, 1.04], paper: 0.6, night: 0.35, glow: 1.3, lights: 0.55, exp: 1.04, expStd: 0.95 },
    night: { sun: ['#9cb4ff', 0.92], sunK: 0.36, hemi: ['#3d5290', 0.88], hemiK: 0.55, dir: [0.42, 0.6, -0.66], haze: '#121a2c', mood: [0.4, 0.48, 0.68], lv: 0.55, iexp: 0.36,
      inkW: [0.66, 0.84, 1.34], inkS: [0.58, 0.72, 1.3], paper: 0, night: 1, glow: 1.9, lights: 1, exp: 1.22, expStd: 0.62 }
  };
  var THEME = {
    temperate: { sun: null, hemi: null, dirK: 1, inkW: [1, 1, 1], inkS: [1, 1, 1], paper: 1, snow: 0, ice: 0 },
    // Winter: kühleres Licht, tiefere Sonne (längere, bläuliche Schatten), Schatten-Tönung blau, kein warmes Papier über dem Schnee
    winter: { sun: ['#eef2ff', 0.55], hemi: ['#b8cdf2', 0.5], dirK: 0.7, inkW: [0.97, 1.0, 1.04], inkS: [0.8, 0.88, 1.16], paper: 0.25, snow: 1, ice: 1 }
  };
  var WBUDGET = { ink: 1400, modern: 1400, lite: 800, pixel: 900, sharp: 900, low: 260 };
  var WEATHER = {   // kind (Shader), Teilchenfarbe, Deckkraft, Schleierfarbe + -stärke, Licht-Dämpfung bei voller Stärke
    snow: { kind: 0, col: [0.93, 0.95, 1.0], a: 0.9, ov: [0.84, 0.88, 0.95], ovA: 0.07, dim: 0.14 },
    rain: { kind: 1, col: [0.78, 0.85, 0.94], a: 0.5, ov: [0.46, 0.52, 0.6], ovA: 0.1, dim: 0.3 },
    sand: { kind: 2, col: [0.7, 0.54, 0.34], a: 0.42, ov: [0.72, 0.56, 0.36], ovA: 0.34, dim: 0.22 }
  };

  var forced = null, mood = { theme: 'temperate', time: 'day', weather: 'none' }, mapRef = null, seed = 0;
  var base = null, applied = null, wInt = 0, wetS = 0, wx = 0, wz = 0, wMesh = null, wMat = null, lights = null, lampList = [], tmpC = null;
  function link() { M3 = G.R3M; T3 = G.R3T; F3 = G.R3F; }
  function init() { tmpC = new THREE.Color(); buildWeather(); }

  /** Stimmung der Karte bestimmen (vor dem Geländebau, damit r3-terrain das Thema kennt). */
  function setMap(m) {
    mapRef = m;
    mood = G.MAPS && G.MAPS.mood ? G.MAPS.mood(m.id) : { theme: 'temperate', time: 'day', weather: 'none' };
    if (forced) mood = Object.assign({}, mood, forced);   // Test: G.R3W._force({...}) + G.Render.reset()
    R.mood = mood;
    seed = G.Sim && G.Sim.S ? G.Mood.seedOf(G.Sim.S) : 0;
  }
  function reset() {
    lampList.length = 0;
    try {
      var w = T3.world && T3.world(), fine = !!(w && w.cfg && w.cfg.hiPoly), pl = T3.decoPlan(mapRef, fine);
      for (var i = 0; i < pl.items.length; i++) { var it = pl.items[i]; if (it.k !== 'lamp') continue; var a = it.ai * Math.PI / 2; lampList.push(it.x + Math.cos(a) * 0.15, it.y + Math.sin(a) * 0.15); }
    } catch (e) { /* egal */ }
    ensureLights();
    apply();
  }

  // ------------------------------------------------------------------ Licht & Palette
  /** Nach applyLook (Kern): Grundwerte merken, dann die Stimmung darüberlegen. */
  function look() {
    var sun = R.sun, hemi = R.hemi, SH = R.SH, rr = R.renderer;
    if (!sun || !SH || !rr) return;
    base = { sunC: sun.color.clone(), sunI: sun.intensity, hemiC: hemi.color.clone(), hemiG: hemi.groundColor.clone(), hemiI: hemi.intensity, exp: rr.toneMappingExposure,
      inkL: SH.uInkL.value.clone(), inkS: SH.uInkS.value.clone(), inkW: SH.uInkW.value.clone(), inkB: SH.uInkB.value.clone(), haze: SH.uHazeCol.value.clone(), gW: SH.uWarm.value.clone(), gL: SH.uLift.value.clone(), pipe: null };
    var P = R.pipe;
    if (P && P.fin && P.fin.uniforms.uExp) {   // Abschluss-Durchgang (INK: makeInkPipe, Modern: makePipe) – Belichtung/Wärme/Anhebung, INK zusätzlich Papier
      var PU = P.fin.uniforms;
      base.pipe = { paper: PU.uPaper ? PU.uPaper.value.w : 0, warm: PU.uWarm.value.clone(), exp: PU.uExp.value, lift: PU.uLift.value.clone(), fin: P.fin };
    }
    apply();
  }
  function mixCol(c, spec) { if (spec) c.lerp(tmpC.set(spec[0]), spec[1]); }
  function apply() {
    if (!base) return;
    var sun = R.sun, hemi = R.hemi, SH = R.SH, rr = R.renderer, Tm = TIME[mood.time] || TIME.day, Th = THEME[mood.theme] || THEME.temperate;
    sun.color.copy(base.sunC); hemi.color.copy(base.hemiC); hemi.groundColor.copy(base.hemiG);
    mixCol(sun.color, Th.sun); mixCol(hemi.color, Th.hemi); mixCol(sun.color, Tm.sun); mixCol(hemi.color, Tm.hemi);
    if (mood.time === 'night') hemi.groundColor.multiplyScalar(0.5);
    sun.intensity = base.sunI * Tm.sunK; hemi.intensity = base.hemiI * Tm.hemiK;
    // Helligkeit: INK über die Belichtung des Abschlusses (ACES würde dunklere Toon-Stufen sonst wieder anheben) bzw. ohne Abschluss über die
    // Renderer-Belichtung; Modern/klassisch: Licht ist physikalisch gedimmt → Belichtung leicht angehoben (Tm.exp)
    var ek = R.ink ? Tm.iexp : (R.std ? Tm.expStd : Tm.exp);   // Modern: ACES hebt gedimmtes Licht stark an → Belichtung senken; klassisch (Lambert): leicht anheben
    rr.toneMappingExposure = base.exp * ek;
    if (base.pipe && base.pipe.fin === (R.pipe && R.pipe.fin) && base.pipe.fin.uniforms.uExp) base.pipe.fin.uniforms.uExp.value = base.pipe.exp * ek;
    R.moodExp = ek;   // Lichtflecken/Fensterlicht gleichen die Belichtung aus
    // Sonnenrichtung: Tageszeit setzt sie, Winter senkt sie (y kleiner → längere Schatten)
    var d = Tm.dir || (R.Q && R.Q.std ? [-0.62, 0.68, -0.4] : [-0.55, 1, -0.38]);   // Grundrichtung wie im Kern (MODERN_LOOK.sunDir / PIXEL_SUN)
    var dk = mood.time === 'day' ? Th.dirK : 1;   // Winter senkt nur die Tagessonne (Dämmerung ist schon flach)
    R.sunDir = (Tm.dir || dk !== 1) ? [d[0], d[1] * dk, d[2]] : null;
    // INK: Toon-Stufen (Helligkeit) + Tönung; Schwellen mit dem Licht mitskalieren (sonst fiele nachts alles in die Schraffur-Stufe)
    var d0 = R.Q && R.Q.std ? [-0.62, 0.68, -0.4] : [-0.55, 1, -0.38], sd = R.sunDir || d0;
    var ny0 = d0[1] / Math.hypot(d0[0], d0[1], d0[2]), ny1 = sd[1] / Math.hypot(sd[0], sd[1], sd[2]);   // Sonnenhöhe → Licht auf flachem Boden
    var lum = function (c) { return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; };   // Lichtfarbe verschiebt die Helligkeit (Mond blau → dunkler)
    // Bestrahlung eines flachen Bodens (Sonne · Höhe + Himmel) jetzt / Grundzustand → Toon-Schwellen gleich mitskalieren: gleiche Stufenverteilung
    var E0 = base.sunI * lum(base.sunC) * ny0 + base.hemiI * lum(base.hemiC), E1 = sun.intensity * lum(sun.color) * ny1 + hemi.intensity * lum(hemi.color);
    var lk = E1 / Math.max(1e-3, E0);
    SH.uInkB.value.copy(base.inkB).multiplyScalar(lk);
    SH.uInkL.value.copy(base.inkL).multiplyScalar(Tm.lv);
    SH.uInkW.value.set(base.inkW.x * Tm.inkW[0] * Th.inkW[0], base.inkW.y * Tm.inkW[1] * Th.inkW[1], base.inkW.z * Tm.inkW[2] * Th.inkW[2]);
    SH.uInkS.value.set(base.inkS.x * Tm.inkS[0] * Th.inkS[0], base.inkS.y * Tm.inkS[1] * Th.inkS[1], base.inkS.z * Tm.inkS[2] * Th.inkS[2]);
    SH.uHazeCol.value.copy(base.haze); if (Tm.haze) SH.uHazeCol.value.set(Tm.haze);
    if (base.pipe && base.pipe.fin === (R.pipe && R.pipe.fin)) {
      var U = base.pipe.fin.uniforms;
      if (U.uPaper) U.uPaper.value.w = base.pipe.paper * Tm.paper * Th.paper;
      U.uLift.value.copy(base.pipe.lift); if (mood.time === 'night') U.uLift.value.set(0.008, 0.012, 0.03);   // Nacht: Schwärzen leicht blau angehoben
      U.uWarm.value.copy(base.pipe.warm); if (mood.time === 'night') U.uWarm.value.set(0.86, 0.96, 1.18); else if (mood.theme === 'winter' && mood.time === 'day') U.uWarm.value.set(1.0, 1.0, 1.02);
    }
    // ohne Abschluss-Durchgang (Gezeichnet einfach / Modern Lite mit Farbkorrektur im Material): gleiche Nachttönung über uWarm/uLift
    SH.uWarm.value.copy(base.gW); SH.uLift.value.copy(base.gL);
    if (mood.time === 'night' && SH.uGrade.value.x > 0.5) { SH.uWarm.value.set(0.86, 0.96, 1.18); SH.uLift.value.set(0.008, 0.012, 0.03); }
    SH.uMoodCol.value.fromArray(Tm.mood);
    SH.uNight.value = Tm.night / Math.max(0.3, ek); SH.uSnow.value = Th.snow; SH.uIce.value = Th.ice;
    R.glowK = Tm.glow;
    if (F3 && F3.moodTint) F3.moodTint(Tm.mood[0] * 0.85 + 0.15, Tm.mood[1] * 0.85 + 0.15, Tm.mood[2] * 0.85 + 0.15, Tm.glow);
    applied = { sunI: sun.intensity, hemiI: hemi.intensity, inkL: SH.uInkL.value.clone() };
  }
  /** Symbole (Seitenleiste) immer im Grundzustand rendern. */
  var icoSave = null;
  function iconBegin() {
    var SH = R.SH; if (!SH || !base) return;
    icoSave = [SH.uSnow.value, SH.uNight.value, SH.uInkL.value.clone(), SH.uInkS.value.clone(), SH.uInkW.value.clone(), SH.uInkB.value.clone()];
    SH.uSnow.value = 0; SH.uNight.value = 0; SH.uInkL.value.copy(base.inkL); SH.uInkS.value.copy(base.inkS); SH.uInkW.value.copy(base.inkW); SH.uInkB.value.copy(base.inkB);
  }
  function iconEnd() {
    var SH = R.SH; if (!SH || !icoSave) return;
    SH.uSnow.value = icoSave[0]; SH.uNight.value = icoSave[1]; SH.uInkL.value.copy(icoSave[2]); SH.uInkS.value.copy(icoSave[3]); SH.uInkW.value.copy(icoSave[4]); SH.uInkB.value.copy(icoSave[5]);
    icoSave = null;
  }

  // ------------------------------------------------------------------ Wetter-Schicht (1 Mesh, 1 Draw-Call)
  var WN = 1600;
  function buildWeather() {
    var nv = (WN + 1) * 4, pos = new Float32Array(nv * 3), sd = new Float32Array(nv * 4), idx = new Uint16Array((WN + 1) * 6), i, k;
    var CR = [-1, -1, 1, -1, 1, 1, -1, 1];
    for (i = 0; i <= WN; i++) {
      var ov = i === 0 ? 1 : 0, a = h1(i * 4 + 1), b = h1(i * 4 + 2), c = h1(i * 4 + 3), rank = (i - 1) / WN;
      for (k = 0; k < 4; k++) {
        var v = i * 4 + k;
        pos[v * 3] = CR[k * 2]; pos[v * 3 + 1] = CR[k * 2 + 1]; pos[v * 3 + 2] = ov;
        sd[v * 4] = a; sd[v * 4 + 1] = b; sd[v * 4 + 2] = c; sd[v * 4 + 3] = rank;
      }
      var o = i * 6, q = i * 4; idx[o] = q; idx[o + 1] = q + 1; idx[o + 2] = q + 2; idx[o + 3] = q; idx[o + 4] = q + 2; idx[o + 5] = q + 3;
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('aSeed', new THREE.BufferAttribute(sd, 4)); geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    wMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, depthTest: false,
      uniforms: { uT: { value: 0 }, uInt: { value: 0 }, uKind: { value: 0 }, uWind: { value: new THREE.Vector2(0.3, 0.1) }, uCen: { value: new THREE.Vector3() },
        uBox: { value: 20 }, uTop: { value: 5 }, uPx: { value: new THREE.Vector2(0.002, 0.003) }, uCss: { value: 1 }, uCol: { value: new THREE.Vector4(1, 1, 1, 1) },
        uOv: { value: new THREE.Vector4(0, 0, 0, 0) }, uMoodCol: R.SH.uMoodCol, uFow: R.SH.uFow, uFowScale: R.SH.uFowScale, uFowOn: R.SH.uFowOn },
      vertexShader: [
        'attribute vec4 aSeed; uniform float uT; uniform float uInt; uniform float uKind; uniform vec2 uWind; uniform vec3 uCen; uniform float uBox; uniform float uTop;',
        'uniform vec2 uPx; uniform float uCss; uniform vec4 uOv;',
        'varying vec2 vUv; varying float vA; varying float vK; varying vec2 vWp;',
        'void main(){',
        '  vec2 cn = position.xy; vUv = cn; vWp = vec2(-1.0);',
        '  if (position.z > 0.5) { vK = 3.0; vA = uOv.w; gl_Position = uOv.w > 0.001 ? vec4(cn, 0.0, 1.0) : vec4(3.0, 3.0, 3.0, 1.0); return; }',
        '  vK = uKind; vA = 1.0;',
        '  if (aSeed.w > uInt) { gl_Position = vec4(3.0, 3.0, 3.0, 1.0); return; }',
        '  vec3 vel = uKind < 0.5 ? vec3(uWind.x * 0.9, -0.85 - aSeed.z * 0.5, uWind.y * 0.9) : (uKind < 1.5 ? vec3(uWind.x * 2.6, -10.0, uWind.y * 2.6) : vec3(uWind.x * 7.5, -0.25, uWind.y * 7.5));',
        '  vec3 p = vec3(aSeed.x * 64.0, aSeed.z * uTop, aSeed.y * 64.0) + vel * (uT + aSeed.x * 17.0);',
        '  p.y = mod(p.y, uTop) + 0.05;',
        '  if (uKind < 0.5) { p.x += sin(uT * 1.3 + aSeed.x * 40.0) * 0.18; p.z += cos(uT * 1.1 + aSeed.y * 37.0) * 0.18; }',
        '  vec2 lo = uCen.xz - vec2(uBox); p.xz = lo + mod(p.xz - lo, vec2(2.0 * uBox));',
        '  vec4 c0 = projectionMatrix * viewMatrix * vec4(p, 1.0); vWp = p.xz;',
        '  float near = 0.75 + 0.5 * (p.y / uTop);',
        '  if (uKind < 0.5) {',
        '    float sz = (1.5 + 2.4 * fract(aSeed.x * 13.7)) * uCss * near;',
        '    gl_Position = vec4(c0.xy + cn * sz * uPx, 0.0, 1.0);',
        '  } else {',
        '    vec4 c1 = projectionMatrix * viewMatrix * vec4(p - vel * (uKind < 1.5 ? 0.04 : 0.09), 1.0);',
        '    vec2 d = (c0.xy - c1.xy) / uPx; float L = length(d); vec2 dn = L > 0.001 ? d / L : vec2(0.0, 1.0);',
        '    L = min(L, (uKind < 1.5 ? 34.0 : 26.0) * uCss); vec2 nn = vec2(-dn.y, dn.x);',
        '    float wd = (uKind < 1.5 ? 1.5 : 2.2 + 2.4 * fract(aSeed.y * 7.3)) * uCss;',
        '    gl_Position = vec4(c0.xy - dn * L * uPx * (0.5 - 0.5 * cn.y) + nn * cn.x * wd * uPx, 0.0, 1.0);',
        '    vA = uKind < 1.5 ? 1.0 : 0.6 + 0.4 * fract(aSeed.z * 5.1);',
        '  }',
        '}'].join('\n'),
      fragmentShader: [
        'uniform vec4 uCol; uniform vec4 uOv; uniform vec3 uMoodCol; uniform float uT; uniform vec2 uWind; uniform sampler2D uFow; uniform vec2 uFowScale; uniform float uFowOn;',
        'varying vec2 vUv; varying float vA; varying float vK; varying vec2 vWp;',
        'float wh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }',
        'float wn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(wh(i), wh(i + vec2(1.0, 0.0)), f.x), mix(wh(i + vec2(0.0, 1.0)), wh(i + vec2(1.0, 1.0)), f.x), f.y); }',
        'void main(){',
        '  vec3 c; float a;',
        '  if (vK > 2.5) {',   // Bildschirm-Schleier (treibend, wolkig)
        '    vec2 q = vUv * vec2(3.0, 1.8) - uWind * uT * 0.05;',
        '    float n = wn(q) * 0.6 + wn(q * 2.7 + 3.1) * 0.4;',
        '    c = uOv.rgb; a = uOv.w * (0.55 + 0.9 * n);',
        '  } else if (vK < 0.5) {',
        '    float r = dot(vUv, vUv); if (r > 1.0) discard;',
        '    c = uCol.rgb; a = uCol.w * (1.0 - smoothstep(0.35, 1.0, r)) * vA;',
        '  } else {',
        '    c = uCol.rgb; a = uCol.w * (1.0 - vUv.x * vUv.x) * (0.35 + 0.65 * (vUv.y * 0.5 + 0.5)) * vA;',
        '  }',
        '  if (vK < 2.5) a *= mix(1.0, 0.08 + 0.92 * texture2D(uFow, vWp * uFowScale).r, uFowOn);',   // Nebel des Krieges: Teilchen über Unerkundetem kaum sichtbar
        '  gl_FragColor = vec4(c * uMoodCol, a);',
        '  #include <tonemapping_fragment>',
        '  #include <colorspace_fragment>',
        '}'].join('\n')
    });
    wMesh = new THREE.Mesh(geo, wMat);
    wMesh.frustumCulled = false; wMesh.renderOrder = 9; wMesh.visible = false;
    R.scene.add(wMesh);
  }
  function budget() {
    var Q = R.Q || {}, q = R.quality;
    if (q === 'low' || Q.mode === 'low') return WBUDGET.low;
    if (Q.lite) return WBUDGET.lite;
    return WBUDGET[q] || 900;
  }

  /** je Bild vor dem Rendern: Wetter-Stärke/Wind aus Spielzeit, Uniforms, Nässe, Licht-Dämpfung. */
  function update(S, alpha, dt, cam) {
    if (!wMesh || !base) return;
    var W = WEATHER[mood.weather], on = !!W && wOn, SH = R.SH;
    var t = (S.tick + (G.view && G.view.paused ? 0 : (alpha || 0))) / D.TICK_HZ;
    var tgt = on ? G.Mood.intensity(seed, t, mood.weather) : 0;
    wInt = tgt;
    if (W) {   // Wind dreht langsam, Stärke schwankt (deterministisch)
      var ang = seed * 0.0123 + Math.sin(t / 170 + seed) * 0.7, ws = 0.45 + 0.55 * vn1(t / 60 + seed * 0.07);
      wx = Math.cos(ang) * ws; wz = Math.sin(ang) * ws;
    }
    // Nässe folgt dem Regen träge (trocknet langsam), Tropfenringe direkt; bei Pause steht alles (dt = 0)
    var wetT = (on && mood.weather === 'rain') ? wInt : 0;
    wetS += (wetT - wetS) * Math.min(1, dt * 0.25);
    if (dt === 0 && wetS === 0 && wetT > 0) wetS = wetT;
    if (!wOn) wetS = 0;   // „Wetter: Aus“ wirkt sofort
    SH.uWet.value = wetS; SH.uRain.value = (on && mood.weather === 'rain') ? wInt * 0.8 : 0;
    // Bedeckt: Sonne gedämpft (Toon: Stufen etwas dunkler)
    if (applied) {
      var dim = on ? W.dim * wInt : 0;
      R.sun.intensity = applied.sunI * (1 - dim); R.hemi.intensity = applied.hemiI * (1 + dim * 0.25);
      SH.uInkL.value.copy(applied.inkL).multiplyScalar(1 - dim * 0.35);
    }
    var nb = on ? budget() : 0;
    wMesh.visible = on && nb > 0 && wInt > 0.01;
    if (!wMesh.visible) return;
    var U = wMat.uniforms, V = R.V;
    wMesh.geometry.setDrawRange(0, (nb + 1) * 6);
    U.uT.value = t; U.uInt.value = wInt * nb / WN; U.uKind.value = W.kind; U.uWind.value.set(wx, wz);
    U.uCen.value.set(cam.cx, 0, cam.cz);
    U.uBox.value = Math.sqrt(cam.halfW * cam.halfW + Math.pow(cam.halfH / Math.sin(V.PITCH), 2)) + 3;
    U.uTop.value = 5;
    var rr = R.renderer, sz = rr.getDrawingBufferSize ? null : null, bw = rr.domElement.width, bh = rr.domElement.height;
    void sz;
    U.uPx.value.set(2 / Math.max(1, bw), 2 / Math.max(1, bh));
    U.uCss.value = Math.max(0.5, bh / Math.max(1, V.vh));
    U.uCol.value.set(W.col[0], W.col[1], W.col[2], W.a);
    var lowQ = R.quality === 'low' || (R.Q && R.Q.mode === 'low');
    U.uOv.value.set(W.ov[0], W.ov[1], W.ov[2], lowQ ? 0 : W.ovA * wInt);
    if (R.mark) R.mark('sprites');
  }

  // ------------------------------------------------------------------ Lichter (nachts/Dämmerung): 1 instanzierter, additiver Batch
  function ensureLights() {
    if (lights && lights.mesh.parent) { return; }
    var g = new THREE.PlaneGeometry(1, 1); g.rotateX(-Math.PI / 2);
    var mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
      uniforms: { uFow: R.SH.uFow, uFowScale: R.SH.uFowScale, uFowOn: R.SH.uFowOn },
      vertexShader: [
        'varying vec2 vUv; varying vec3 vC; varying float vCone; varying vec2 vW;',
        'void main(){',
        '  vUv = position.xz; vC = vec3(1.0);',
        '#ifdef USE_INSTANCING_COLOR',
        '  vC = instanceColor;',
        '#endif',
        '  float ax = length(instanceMatrix[0].xyz), az = length(instanceMatrix[2].xyz); vCone = ax > az * 1.4 ? 1.0 : 0.0;',
        '  vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0); vW = w.xz;',
        '  gl_Position = projectionMatrix * viewMatrix * w; }'].join('\n'),
      fragmentShader: [
        'uniform sampler2D uFow; uniform vec2 uFowScale; uniform float uFowOn;',
        'varying vec2 vUv; varying vec3 vC; varying float vCone; varying vec2 vW;',
        'void main(){',
        '  float i;',
        '  if (vCone > 0.5) { float u = vUv.x + 0.5, w = 0.1 + 0.36 * u; i = pow(1.0 - u, 1.15) * (1.0 - smoothstep(w * 0.55, w, abs(vUv.y))) * smoothstep(0.0, 0.1, u); }',
        '  else { float r = length(vUv) * 2.0; i = clamp(1.0 - r, 0.0, 1.0); i *= i; }',
        '  i *= mix(1.0, texture2D(uFow, vW * uFowScale).r, uFowOn);',
        '  gl_FragColor = vec4(vC * i, i); }'].join('\n')
    });
    lights = new M3.Batch(g, mat, 256, false);   // feste Startkapazität (PowerVR: keine Neuanlage im Spiel)
    lights.mesh.renderOrder = 2; lights.mesh.castShadow = false; lights.mesh.receiveShadow = false;
    R.scene.add(lights.mesh);
  }
  var POS_LIGHT = { hq: 1, power: 1, radar: 1, factory: 1, techcenter: 1, airfield: 1, orbital: 1, silo: 1, refinery: 1, shipyard: 1 };
  function fill(S, alpha, dt) {
    var Tm = TIME[mood.time] || TIME.day, i, e;
    // Atemwolken (Winter): Infanterie im Bild stößt alle ~1,8 s einen kleinen Hauch aus (zustandslos: Phasenübergang im aktuellen Bild)
    if (mood.theme === 'winter' && dt > 0 && F3) {
      var ents0 = S.ents, pid0 = R.V.pid, fo0 = S.settings.fogOff, n0 = 0;
      for (i = 0; i < ents0.length && n0 < 24; i++) {
        e = ents0[i];
        if (e.dead || e.inside || e.kind !== 'unit' || !isInfT(e.type)) continue;
        var ph = R.t / 1.8 + h1(e.id * 7 + 3);
        if (ph - Math.floor(ph) >= dt / 1.8) continue;
        var bx = (e.px + (e.x - e.px) * alpha) / TILE, bz = (e.py + (e.y - e.py) * alpha) / TILE;
        if (!R.inView(bx, bz) || (e.owner !== pid0 && !fo0 && !G.Sim.isVisible(pid0, e))) continue;
        var dr = e.dir || 0, fx = Math.cos(dr), fz = Math.sin(dr);
        F3.emit(1, bx + fx * 0.07, T3.groundAt(bx, bz) + 0.26, bz + fz * 0.07, fx * 0.12 + wx * 0.1, 0.05, fz * 0.12 + wz * 0.1, 1.1, 0.04, 0.15, 0.95, 0.97, 1, 0.45, 0.95, 0.97, 1, 0, -0.01, 1.4);
        n0++;
      }
    }
    if (!lights) return;
    var k = Tm.lights / Math.max(0.3, R.moodExp || 1);
    if (k <= 0) { lights.flush(); return; }
    var V = R.V, pid = V.pid, fogOff = S.settings.fogOff, ents = S.ents, P = S.players[pid], W = S.map.w;
    // Laternen der Karten-Deko (nur erkundete/sichtbare Kacheln)
    for (i = 0; i < lampList.length; i += 2) {
      var lx = lampList[i], lz = lampList[i + 1];
      if (!R.inView(lx, lz)) continue;
      var ti = (lz | 0) * W + (lx | 0);
      if (!fogOff && !P.exp[ti]) continue;
      lights.put(lx, T3.heightAt(lx, lz) + 0.03, lz, 0, 2.4, 1, 2.4, 0.5 * k, 0.36 * k, 0.17 * k);
    }
    var rs = M3.rs, VEH = vehCache;
    for (i = 0; i < ents.length; i++) {
      e = ents[i];
      if (e.dead || e.inside) continue;
      if (e.kind === 'unit') {
        var v = VEH[e.type]; if (v === undefined) { var ud = D.UNITS[e.type]; v = VEH[e.type] = ud && ud.cat === 'vehicle' ? 1 : 0; }
        if (!v || e.mc === 2) continue;
        var ux = (e.px + (e.x - e.px) * alpha) / TILE, uz = (e.py + (e.y - e.py) * alpha) / TILE;
        if (!R.inView(ux, uz) || (e.owner !== pid && !fogOff && !G.Sim.isVisible(pid, e))) continue;
        var st = rs && rs.get(e.id), dir = st && st.dir != null ? st.dir : (e.dir || 0), r = (e.r || 10) / TILE, L = 2.3 + r;
        var cx = ux + Math.cos(dir) * (r * 0.7 + L * 0.5), cz = uz + Math.sin(dir) * (r * 0.7 + L * 0.5);
        lights.put(cx, T3.groundAt(cx, cz) + 0.03, cz, dir, L, 1, 1.15 + r, 0.62 * k, 0.55 * k, 0.4 * k);
      } else if (e.kind === 'building' && POS_LIGHT[e.type] && e.owner >= 0 && !e.ruin) {
        if (e.owner !== pid && !fogOff && !G.Sim.isVisible(pid, e)) continue;
        var bx2 = e.x / TILE, bz2 = e.y / TILE; if (!R.inView(bx2, bz2)) continue;
        var bl = (R.t * 0.6 + h1(e.id)) % 1, on = bl < 0.14 ? 1 : 0.18, hh = (M3.BH[e.type] || 1) + 0.06;
        var ox = bx2 + e.w * 0.36, oz = bz2 - e.h * 0.36;
        lights.put(ox, hh, oz, 0, 0.55, 1, 0.55, 1.0 * on * k, 0.16 * on * k, 0.1 * on * k);
        lights.put(bx2, 0.04, bz2 + e.h * 0.5 + 0.3, 0, 2.2, 1, 2.2, 0.32 * k, 0.24 * k, 0.12 * k);   // Lichtschein vor dem Eingang
      }
    }
    lights.flush();
  }
  var vehCache = {}, infCache = {};
  function isInfT(t) { var v = infCache[t]; if (v === undefined) { var u = D.UNITS[t]; v = infCache[t] = !!(u && u.cat === 'infantry'); } return v; }

  function state() { return { theme: mood.theme, time: mood.time, weather: mood.weather, on: wOn, int: +wInt.toFixed(3), wet: +wetS.toFixed(3), visible: !!(wMesh && wMesh.visible) }; }
  G.R3W = { link: link, init: init, setMap: setMap, reset: reset, look: look, update: update, fill: fill, iconBegin: iconBegin, iconEnd: iconEnd, state: state,
    _force: function (o) { forced = o || null; },
    _mood: function (m) { if (m) { Object.assign(mood, m); R.mood = mood; apply(); } return mood; }, TIME: TIME, THEME: THEME, WEATHER: WEATHER };
})();
