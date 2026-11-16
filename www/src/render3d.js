/* FRONTLINIE – render3d.js  (3D-Renderer mit Three.js r187, ersetzt render.js; alt: render2d.js nur als Referenz)
 * G.Render: WebGL-Darstellung. LIEST NUR Zustand, verändert nie die Simulation.
 *
 * Öffentliche Schnittstelle (gleich wie render.js, plus Erweiterungen):
 *   init(canvas, miniCanvas)   einmalig. canvas (#cv) wird zur 2D-Überlagerung (Lebensbalken, Rahmen, Sammelpunkt);
 *                              die 3D-Szene zeichnet in ein eigenes Canvas (#gl), das darunter eingefügt wird.
 *   reset()                    nach Spielstart/Laden: Gelände, Wasser, Bäume, Erz, Nebel-Textur, Minimap neu
 *   draw(alpha)                pro Frame; alpha = Interpolationsfaktor zwischen px/py und x/y
 *   drawIcon(ctx, type, color, w, h)  Seitenleisten-Symbol (einmal als kleine 3D-Aufnahme gerendert, gecacht)
 *   miniToWorld(mx, my)        Minimap-CSS-Koordinaten → Weltpixel
 *   resize()                   Größen anpassen (setzt G.view.vw/vh), wird in draw() geprüft
 *   pickAt(sx, sy, slackPx)    Entität unter Bildschirmpunkt (Einheiten per Projektion, Gebäude per Strahl/Quader) oder null
 *   setQuality(q) / getQuality()   'ink' | 'modern' | 'pixel' | 'sharp' | 'low'  (localStorage 'frontlinie.gfx')
 *   QUALITIES                  [[id, Name], …] für das Menü
 *   2D-Fallback               useFallback(): ersetzt G.Render durch G.Render2D (render2d.js), wenn WebGL fehlt/gesperrt ist oder "2D (sicher)" gewählt wird
 *                              (localStorage 'frontlinie.gfx' = '2d' nur bei ausdrücklicher Wahl; dann startet das Spiel ohne WebGL-Zugriff)
 *   info()                     { calls, triangles, points, lines, ms, quality, buf } – Leistungsdaten des letzten Frames
 *
 * Kamera: orthografisch, um G.view.PITCH (55°) geneigt und (v0.7) um G.view.YAW um die Hochachse gedreht ('diag' = −π/4 seit W11, 'straight' = 0).
 *   W11: Sonne/Umgebung/Wasserglanz über G.view.lightDir() → Licht relativ zur Kamera wie bei der alten Diagonale.
 *   Bildschirm ↔ Boden (y=0) bleibt exakt affin, G.view.toWorld/toScreen (main.js) entsprechen einem Raycast auf die Bodenebene.
 *   v0.7 Kontext für Module: R.YAW, R.CYAW/R.SYAW (cos/sin), R.VDIR (THREE.Vector3, Blickrichtung Kamera → Szene, normiert),
 *   R.FWD = [fx, fz] (Bildschirm-oben als Bodenrichtung), R.RIGHT = [rx, rz] (Bildschirm-rechts als Bodenrichtung). Welt: 1 Kachel = 1 Einheit,
 *   Sim-x → Three-x, Sim-y → Three-z. Spielbares Gelände liegt (fast) auf y=0; Fels ist als Grat erhöht, Wasser abgesenkt.
 * Instanzierung: pro (Typ, Besitzer, Teil) ein InstancedMesh (Wanne/Turm/Rohr getrennt, Teamfarbe in Vertexfarben
 *   eingebacken); Wracks und erinnerte Gebäude nutzen dieselben Meshes mit dunkler/grauer Instanzfarbe.
 *   Statisches (Bäume, Felsbrocken, Erz, Brücken) ist instanziert bzw. zusammengeführt. Keine Allokation pro Frame.
 * Nebel des Krieges: kleine DataTexture (Kartengröße, linear gefiltert) – per onBeforeCompile in alle Lambert-Materialien.
 * Grafik-Anhebung „Android“ (Markierungen A1–A3 hier, B1/C1 in r3-terrain.js) – alles ohne zusätzlichen Durchgang/Render-Target:
 *   A1 Bildschärfe: FXAA-Abschluss mit weniger Subpixel-Weichzeichnung + begrenztem Nachschärfen im selben Durchgang (MODERN_LOOK.sharp).
 *   A2 Lichtstimmung: wärmere Sonne, kühleres/stärkeres Himmelslicht, Schatten 0.84, AO 0.65, Kontrast/Vignette, weniger Bildrand-Dunst;
 *      klassische Stufen: etwas mehr Richtungskontrast.
 *   A3 Kartenrand: SH.uEdge dunkelt die äußerste Kachelreihe ab (in fowify + Wasser), davor liegt das Vorland aus r3-terrain.js (buildApron).
 * INK – Grafikstil „Gezeichnet“ (QUAL.ink, Standard; R.ink): Toon-Stufen + weltfeste Schraffur in allen beleuchteten Materialien (inkify über fowify),
 *   Aquarell-Boden (T_INK) und gezeichnetes Wasser (W_INK) in r3-terrain.js, Abschluss makeInkPipe (Tuschekonturen aus der Tiefe + Palette, EIN
 *   Durchgang statt AO/Bloom/FXAA). Ohne Nachbearbeitung → INK_LITE (gleiche Material-Stufen, Palette über uGrade). Einmalige Umstellung
 *   'modern'/leer → 'ink' über den Merker 'frontlinie.gfxink'. Werte zentral in INK_LOOK (Test: G.Render._ink + _inkApply()).
 */
var G = (typeof G !== 'undefined') ? G : {};
(function () {
  'use strict';
  var D = G.DATA, TILE = D.TILE, THREE = (typeof window !== 'undefined') ? window.THREE : null;
  var V = null;
  // v0.6: gemeinsamer interner Kontext aller 3D-Module (siehe docs/RENDER_MODULES.md). Wird von render3d.js (Kern) befüllt,
  // r3-models.js (G.R3M), r3-terrain.js (G.R3T) und r3-fx.js (G.R3F) lesen daraus. Kern lädt ZUERST.
  var R = G.R3 = G.R3 || {};
  var T3 = null, M3 = null, F3 = null, S3 = null; // Modul-Objekte, in init() verbunden
  // Aliase auf Modell-Tabellen/-Funktionen (aus G.R3M, in init() gesetzt)
  var MAT = null, NEUT = null, GARR = null, BH = null, SCALE = null, INF = null, model = null, unitModelOf = null, neutralShown = null, facOfColor = null, isBld = null, groundAt = null;

  // ------------------------------------------------------------------ Qualität
  // v0.6: std = MeshStandardMaterial + Umgebungslicht (PMREM), post = Nachbearbeitung (AO, Bloom, AA), soft = weiche Schatten.
  var QKEY = 'frontlinie.gfx';
  // INK: „Gezeichnet“ (Standard seit INK1) = Modern-Materialien mit Toon-Stufen + Schraffur (fowify), eigener Abschluss-Durchgang mit
  // Tuschekonturen aus der Tiefe (makeInkPipe) statt AO/Bloom/FXAA; ohne Nachbearbeitung (Schonprofil/Flag post aus) → INK_LITE.
  var QUAL = {
    ink: { name: 'Gezeichnet', aa: false, shadows: true, shadowSize: 2048, mode: 'modern', particles: 1400, std: true, post: true, soft: false, ink: true },
    modern: { name: 'Modern', aa: false, shadows: true, shadowSize: 2048, mode: 'modern', particles: 1400, std: true, post: true, soft: true },
    pixel: { name: 'Pixel-Look', aa: false, shadows: true, shadowSize: 1024, mode: 'pixel', particles: 1400 },
    sharp: { name: 'Scharf', aa: true, shadows: true, shadowSize: 2048, mode: 'sharp', particles: 1400 },
    low: { name: 'Sparmodus', aa: false, shadows: false, shadowSize: 0, mode: 'low', particles: 500 }
  };
  // v0.6: „Modern Lite“ – automatisch statt Modern auf PowerVR/Schonmodus: Standard-Materialien + Umgebungslicht + kleine weiche
  // Schatten, KEINE Nachbearbeitung (kein AO/Bloom, keine großen Render-Targets); Leuchten über additive Sprites.
  var MODERN_LITE = { name: 'Modern Lite', aa: false, shadows: true, shadowSize: 1024, mode: 'modern', particles: 1000, std: true, post: false, soft: true, lite: true };
  // INK: „Gezeichnet (einfach)“ – Toon-Stufen, Schraffur, Palette im Material (uGrade), stilisiertes Wasser/Boden; KEIN Zusatz-Durchgang
  var INK_LITE = Object.assign({}, MODERN_LITE, { name: 'Gezeichnet (einfach)', ink: true });
  var quality = 'ink';
  var stored2d = false; // 2D-Fallback: gespeicherte Wahl "2D (sicher)" → beim Start gar kein WebGL anfassen
  // INK: einmalige Umstellung bestehender Installationen – gespeichertes 'modern' (bisheriger Standard) oder nichts → 'ink'; Merker
  // 'frontlinie.gfxink' verhindert jede Wiederholung, danach gilt allein die Wahl des Spielers. Andere Wahlen (Pixel, 2D, …) bleiben.
  var IKEY = 'frontlinie.gfxink';
  try {
    var qs = localStorage.getItem(QKEY);
    if (!localStorage.getItem(IKEY)) {
      if (!qs || qs === 'modern') { quality = 'ink'; if (qs) { qs = 'ink'; localStorage.setItem(QKEY, 'ink'); } }
      localStorage.setItem(IKEY, '1');
    }
    if (qs && QUAL[qs]) quality = qs; if (qs === '2d' || qs === 'sprite') stored2d = true;
  } catch (e) { /* egal */ }
  // Sprite-Modus: ohne gespeicherte Wahl auf PowerVR-GPUs (WebGL-Abstürze) gleich 'sprite' – Erkennung über den gemerkten Renderer-Namen
  // eines früheren Starts oder einen winzigen Wegwerf-Kontext (sofort wieder freigegeben); danach wird WebGL nicht mehr angefasst.
  try {
    if (!qs) {
      var gpuS = localStorage.getItem('frontlinie.gpu');
      if (gpuS == null) {
        gpuS = '';
        var pc = document.createElement('canvas'); pc.width = pc.height = 1;
        var pg = pc.getContext('webgl', { failIfMajorPerformanceCaveat: false, powerPreference: 'low-power' });
        if (pg) { var pd = pg.getExtension('WEBGL_debug_renderer_info'); gpuS = String(pd ? pg.getParameter(pd.UNMASKED_RENDERER_WEBGL) : pg.getParameter(pg.RENDERER)); var pl = pg.getExtension('WEBGL_lose_context'); if (pl) pl.loseContext(); }
        localStorage.setItem('frontlinie.gpu', gpuS);
      }
      if (/PowerVR|Imagination|IMG /i.test(gpuS)) { stored2d = true; localStorage.setItem(QKEY, 'sprite'); }
    }
  } catch (e) { /* egal */ }
  var Q = QUAL[quality];
  var forceLite = false; // v0.6: Test-/Debug-Schalter (G.Render._setLite) – Modern als Lite erzwingen, ohne Schonmodus

  // ------------------------------------------------------------------ v0.8: Grafik-Funktionen (Feature-Flags), Profil, Selbstheilung
  // Alle riskanten Funktionen zentral in R.F (true = an). Jedes Modul prüft seine Flags und hat einen billigeren Weg (docs/RENDER_MODULES.md).
  // Reihenfolge = Reihenfolge im Grafik-Test (risikoarm/wertvoll zuerst). Buchstabe = Ergebnis-Code.
  var FLAGS = [
    ['std', 'M', 'Modern-Materialien'], ['env', 'U', 'Umgebungslicht'], ['liteLook', 'F', 'Schatten-Ersatz & Farbe'], ['hiPoly', 'V', 'Detail-Modelle'], ['wind', 'L', 'Laub im Wind'],
    ['shadows', 'S', 'Schatten'], ['terrainArray', 'B', 'Boden-Shader'], ['waterShader', 'W', 'Wasser-Shader'], ['hiRes', 'H', 'Hohe Auflösung'],
    ['icons3d', 'I', '3D-Symbole'], ['grass', 'G', 'Gras'], ['tracks', 'K', 'Kettenspuren'], ['sprites', 'R', 'Rauch & Feuer'],
    ['post', 'N', 'Nachbearbeitung (AO/Bloom)'], ['dynRes', 'D', 'Dynamische Auflösung']
  ];
  var FKEY = {}, FLET = {}, FNAME = {};
  FLAGS.forEach(function (f) { FKEY[f[1]] = f[0]; FLET[f[0]] = f[1]; FNAME[f[0]] = f[2]; });
  // Selbstheilung: je Absturz wird die NÄCHSTE noch aktive Funktion dieser Leiter abgeschaltet (Verdacht + Bildwirkung: zuerst Dinge,
  // die ohne Eingabe nach wenigen Sekunden anlaufen und wenig kosten; zuletzt Umgebungslicht und Modern-Materialien).
  // W11-look: liteLook (F) nach icons3d (neu, billig, sofort benutzt), hiRes (H) bleibt vor hiPoly/env/std.
  var LADDER = ['dynRes', 'tracks', 'sprites', 'grass', 'post', 'icons3d', 'liteLook', 'waterShader', 'terrainArray', 'shadows', 'wind', 'hiRes', 'hiPoly', 'env', 'std'];
  // Funktionen, deren tatsächliche Nutzung gemessen wird (R.mark) – nur benutzte gelten als Verdächtige; die übrigen wirken ab Aufbau
  var TRACKED = { dynRes: 1, tracks: 1, sprites: 1, grass: 1, post: 1, icons3d: 1, waterShader: 1, liteLook: 1 };
  var FULL_CODE = 'MUFVLSBWHIGKRND';   // W11-look: + F (wirkt nur ohne Schattenkarte/Nachbearbeitung)
  var LITE_CODE = 'MUSBWIGKR';        // altes „Modern Lite“ (Test-Schalter _setLite)
  var POWERVR_CODE = 'MUFH';          // PowerVR-Startprofil: Standard-Materialien + gebackener Boden + kleines Umgebungslicht; W11-look: + F (Boden-Schatten-Ersatz,
                                      // Farbabstimmung im Material) + H (Puffer DPR ≤ 2 statt 1,5 – mit fixedBuf nur einmal beim Start angelegt)
  function fromCode(code) { var f = {}; FLAGS.forEach(function (x) { f[x[0]] = code.indexOf(x[1]) >= 0; }); return f; }
  function toCode(f) { var s = ''; FLAGS.forEach(function (x) { if (f[x[0]]) s += x[1]; }); return s; }
  var F = fromCode(FULL_CODE);        // aktive Flags (R.F)
  var flagOverride = null;            // Test-Hilfe / Grafik-Test: Code für diese Sitzung
  var PKEY = 'frontlinie.gfxprofile';
  function loadAll() { try { var o = JSON.parse(localStorage.getItem(PKEY) || '{}'); return (o && typeof o === 'object') ? o : {}; } catch (e) { return {}; } }
  function saveAll(o) { try { localStorage.setItem(PKEY, JSON.stringify(o)); } catch (e) { /* egal */ } }
  function gpuKey() { return String(gpuName || '?').slice(0, 160); }
  function getProf() { var a = loadAll(); return (a.gpus && a.gpus[gpuKey()]) || null; }
  function putProf(p) { var a = loadAll(); a.v = 1; a.gpus = a.gpus || {}; if (p) a.gpus[gpuKey()] = p; else delete a.gpus[gpuKey()]; saveAll(a); }
  /** Lauf-Merker (Absturz-Erkennung beim nächsten Start): alive = Seite lief sichtbar, play = Partie wurde gezeichnet, act = benutzte Funktionen. */
  var run = null;
  function saveRun() { if (!run) return; var a = loadAll(); a.run = run; saveAll(a); }
  var activeSince = {};
  /** Module melden die tatsächliche Nutzung einer Funktion (einmal je Aufbau, schreibt den Lauf-Merker nur bei Änderung). */
  function mark(key) {
    if (activeSince[key]) return;
    activeSince[key] = 1;
    if (run) { run.act = toCode(activeSince); saveRun(); }
  }
  function activeCode() {
    var a = {};
    for (var k in F) if (F[k] && (activeSince[k] || !TRACKED[k])) a[k] = true;
    return toCode(a);
  }
  /** Leiter: eine Funktion abschalten (die erste aktive + benutzte in LADDER), Absturz mit Funktionssatz protokollieren. */
  function ladderStep(why, act) {
    var p = getProf() || {}, cur = fromCode(p.flags != null ? profFlags(p) : toCode(F)), off = null, i, a = act != null ? act : activeCode();
    p.w11 = 1;
    for (i = 0; i < LADDER.length && !off; i++) if (cur[LADDER[i]] && (a.indexOf(FLET[LADDER[i]]) >= 0 || !TRACKED[LADDER[i]])) off = LADDER[i];
    for (i = 0; i < LADDER.length && !off; i++) if (cur[LADDER[i]]) off = LADDER[i];
    p.crashes = (p.crashes || []).slice(-9);
    p.crashes.push({ t: Date.now(), set: toCode(cur), act: a, off: off ? FLET[off] : '', why: why });
    if (off) { cur[off] = false; p.flags = toCode(cur); p.src = 'ladder'; }
    else p.allOff = (p.allOff || 0) + 1;
    putProf(p);
    console.warn('Grafik-Absturz (' + why + '): Satz ' + (p.crashes[p.crashes.length - 1].set || '–') + ', benutzt ' + (a || '–') + ' → aus: ' + (off ? FLET[off] + ' ' + FNAME[off] : 'nichts mehr (' + p.allOff + '×)'));
    return { off: off, to2d: !off && p.allOff >= 2 };
  }
  /** W11-look: gespeicherte Selbstheilungs-Profile aus der Zeit des alten PowerVR-Starts 'MU' (nur M/U, ohne Merker w11) bekommen die neuen
   *  Start-Funktionen F + H dazu – die Leiter konnte sie nie abgeschaltet haben. Grafik-Test-Ergebnisse bleiben unverändert. */
  function profFlags(p) {
    var f = String(p.flags);
    if (safeGPU && !p.w11 && p.src === 'ladder' && /^[MU]*$/.test(f)) f += 'FH';
    return f;
  }
  /** Flags für die aktuelle GPU bestimmen: Grundprofil (voll / PowerVR / Lite-Test) → gespeichertes Profil → Grafik-Test → Sitzungs-Override. */
  function computeFlags() {
    var code = safeGPU ? POWERVR_CODE : (forceLite ? LITE_CODE : FULL_CODE);
    var p = getProf();
    if (p && p.flags != null) code = profFlags(p);
    if (p && p.test && p.test.ok != null) code = p.test.ok + (p.test.pending || '');
    if (flagOverride != null) code = flagOverride;
    var f = fromCode(code);
    if (forceLite) { f.post = false; f.dynRes = false; }
    if (!f.std) { f.env = f.terrainArray = f.grass = f.tracks = f.sprites = f.post = f.dynRes = f.hiPoly = false; } // ohne Standard-Materialien bedeutungslos
    if (!f.post) f.dynRes = false;                                     // dynamische Auflösung gibt es nur mit Nachbearbeitung
    f.fixedBuf = !!safeGPU;                                            // PowerVR: feste Puffer, Teil-Uploads, keine Neuanlage im Spiel
    return f;
  }
  /** Wirksame Qualitäts-Einstellung aus Wahl (quality) + Flags. */
  function pickQ() {
    var q = QUAL[quality];
    if (q.std && !F.std) q = Object.assign({}, QUAL.pixel, { name: q.ink ? 'Gezeichnet (klassisch)' : 'Modern (einfach)' });   // klassisch (Lambert) – sicherste 3D-Stufe
    else if (q.std && !F.post) q = q.ink ? INK_LITE : MODERN_LITE;   // INK: Schonprofil → Toon ohne Zusatz-Durchgang
    if (!F.shadows && q.shadows) q = Object.assign({}, q, { shadows: false, shadowSize: 0 });
    if (safeGPU && q.aa) q = Object.assign({}, q, { aa: false });
    return q;
  }

  // ------------------------------------------------------------------ Grundobjekte
  var cv, octx, mini, mctx, mapEl, glCv = null, renderer = null, scene, camera, sun, hemi, dynRoot = null;
  var gpuName = '', safeGPU = false, forceSafe = false, lastSizeT = 0, pendingSize = false, glFail = '', glRetryT = 0, glRetries = 0, glLost = false, glLostT = 0, glOK = false, dpr = 1, bufW = 1, bufH = 1, sizeKey = '';
  var lastT = 0, frameMs = 0, miniFrame = 0, fogTick = -1, oreTick = -1, mapRef = null, overlayDirty = true;
  var world = null; // Gelände-Welt (gehört r3-terrain.js; hier nur Verweis, null = nicht gebaut)
  var fog = null;   // Nebel-Textur + Minimap-Nebel (Kern)
  var COS = 0, SIN = 0, CAM_DIST = 40;
  var CY = 1, SY = 0, VDIR = null; // v0.7: cos/sin(YAW), Blickrichtung

  // gemeinsame Uniforms für Nebel/Dunst (von allen gepatchten Materialien referenziert)
  var SH = null;
  var tmpV = null, tmpV2 = null, tmpM = null, ray = null, box3 = null, ndc = null;

  function hash(x, y, s) {
    var h = (x * 374761393 + y * 668265263 + (s || 0) * 2147483647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerpAng(a, b, k) {
    var d = b - a;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return a + d * k;
  }
  function smooth(t) { t = t < 0 ? 0 : (t > 1 ? 1 : t); return t * t * (3 - 2 * t); }
  function rnd() { return Math.random(); }

  /** Nebel des Krieges + Dunst in ein Material einbauen (Lambert, Basic, Standard – alle mit <opaque_fragment>).
   *  v0.6: Cache-Schlüssel enthält den Materialtyp; vorhandenes onBeforeCompile (z. B. Oberflächen-Attribute in r3-models) wird verkettet. */
  function fowify(mat) {
    var prev = mat.onBeforeCompile, prevKey = mat.customProgramCacheKey;
    var hasPrev = prev && prev !== THREE.Material.prototype.onBeforeCompile;
    // INK: Zeichenstil beim Anlegen festgelegt (Stufenwechsel ink ↔ andere baut die Materialien neu); nur beleuchtete Materialien
    var ink = !!R.ink && (mat.type === 'MeshStandardMaterial' || mat.type === 'MeshLambertMaterial');
    mat.onBeforeCompile = function (sh, rr) {
      if (hasPrev) prev.call(mat, sh, rr);
      if (ink) inkify(sh);
      sh.uniforms.uFow = SH.uFow; sh.uniforms.uFowScale = SH.uFowScale; sh.uniforms.uFowOn = SH.uFowOn;
      sh.uniforms.uHazeCol = SH.uHazeCol; sh.uniforms.uHaze = SH.uHaze;
      sh.uniforms.uEdge = SH.uEdge; sh.uniforms.uGrade = SH.uGrade; sh.uniforms.uWarm = SH.uWarm; sh.uniforms.uLift = SH.uLift; sh.uniforms.uRes = SH.uRes;   // W11-look
      sh.vertexShader = 'varying vec3 vFowW;\n' + sh.vertexShader.replace('#include <project_vertex>',
        '#include <project_vertex>\n  vec4 fwp = vec4(transformed, 1.0);\n#ifdef USE_INSTANCING\n  fwp = instanceMatrix * fwp;\n#endif\n' +
        '  fwp = modelMatrix * fwp;\n  vFowW = vec3(fwp.xz, -mvPosition.z);');
      sh.fragmentShader = 'uniform sampler2D uFow; uniform vec2 uFowScale; uniform float uFowOn; uniform vec3 uHazeCol; uniform vec3 uHaze; uniform vec2 uEdge; varying vec3 vFowW;\n' +
        'uniform vec4 uGrade; uniform vec3 uWarm; uniform vec3 uLift; uniform vec2 uRes;\n' +   // W11-look: Farbabstimmung (nur ohne Nachbearbeitung aktiv)
        sh.fragmentShader.replace('#include <tonemapping_fragment>',
          '#include <tonemapping_fragment>\n  if (uGrade.x > 0.5) { vec3 gc = gl_FragColor.rgb; float gl = dot(gc, vec3(0.2126, 0.7152, 0.0722)); gc = mix(vec3(gl), gc, uGrade.y);' +
          ' gc = clamp((gc - 0.5) * uGrade.z + 0.5, 0.0, 1.0); vec2 vq = gl_FragCoord.xy * uRes - 0.5; gc *= 1.0 - uGrade.w * dot(vq, vq) * 2.0; gl_FragColor.rgb = gc; }')
        .replace('#include <opaque_fragment>',
          '  vec2 fowUV = vFowW.xy * uFowScale; float fowV = mix(1.0, texture2D(uFow, fowUV).r, uFowOn);\n' +
          '  vec2 edQ = min(fowUV, 1.0 - fowUV) / uFowScale; fowV *= clamp(min(edQ.x, edQ.y) * uEdge.x + uEdge.y, 0.0, 1.0);\n' +   // A3: Kartenrand läuft weich ins Dunkle aus
          '  float hz = clamp((vFowW.z - uHaze.x) / (uHaze.y - uHaze.x), 0.0, 1.0) * uHaze.z * uFowOn;\n' +
          '  outgoingLight = mix(outgoingLight, uHazeCol, hz) * fowV;\n  if (uGrade.x > 0.5) outgoingLight = outgoingLight * uWarm + uLift;\n#include <opaque_fragment>');
    };
    mat.customProgramCacheKey = function () { return 'fow3' + mat.type + (ink ? 'I' : '') + (hasPrev && prevKey ? prevKey.call(mat) : ''); };
    return mat;
  }

  /** INK (Zeichenstil, im Material – auch ohne Nachbearbeitung):
   *  1. Toon-Stufen: Lichtfaktor = Helligkeit(Licht ohne Eigenleuchten) / Helligkeit(Grundfarbe) → 3 Tonstufen (Schatten / Halbton / Licht)
   *     mit schmal geglätteten Übergängen (fwidth → kein Treppen-Flimmern). Schattenstufe kühl, Lichtstufe warm getönt.
   *  2. Schraffur in der Schattenstufe: Linienschar s = dot(Weltpunkt, uInkN) mit uInkN ⟂ Blickrichtung → auf JEDER Fläche gleich schräge
   *     Bildschirmlinien, die an der Welt hängen (wandern beim Scrollen exakt mit dem Boden mit, kein Kriechen); zu dicht (Fernzoom) → ausgeblendet.
   *  3. Metall/Glanz gedämpft (gezeichnet = matt), Rauheit hoch.
   *  Kosten: ~25 ALU je Pixel, keine Textur, kein Durchgang. Uniforms in SH (uInkB Schwellen, uInkL Stufen, uInkS/uInkW Tönung, uInkH Schraffur). */
  function inkify(sh) {
    sh.uniforms.uInkB = SH.uInkB; sh.uniforms.uInkL = SH.uInkL; sh.uniforms.uInkS = SH.uInkS; sh.uniforms.uInkW = SH.uInkW;
    sh.uniforms.uInkH = SH.uInkH; sh.uniforms.uInkN = SH.uInkN;
    sh.vertexShader = 'varying vec3 vInkP;\n' + sh.vertexShader.replace('#include <project_vertex>',
      '#include <project_vertex>\n  { vec4 ip = vec4(transformed, 1.0);\n#ifdef USE_INSTANCING\n  ip = instanceMatrix * ip;\n#endif\n  vInkP = (modelMatrix * ip).xyz; }');
    var fs = sh.fragmentShader;
    if (fs.indexOf('#include <lights_physical_fragment>') >= 0)
      fs = fs.replace('#include <lights_physical_fragment>', '  metalnessFactor *= 0.35; roughnessFactor = mix(roughnessFactor, 1.0, 0.55);\n#include <lights_physical_fragment>');
    sh.fragmentShader = 'uniform vec2 uInkB; uniform vec3 uInkL; uniform vec3 uInkS; uniform vec3 uInkW; uniform vec4 uInkH; uniform vec3 uInkN; varying vec3 vInkP;\n' +
      fs.replace('#include <opaque_fragment>', [
        '  {',
        '    vec3 iLit = max(outgoingLight - totalEmissiveRadiance, vec3(0.0));',
        '    const vec3 iW = vec3(0.2126, 0.7152, 0.0722);',
        '    float iLf = dot(iLit, iW) / max(dot(diffuseColor.rgb, iW), 0.006);',
        '    float iAa = fwidth(iLf) * 0.6 + 0.015;',
        '    float iB1 = smoothstep(uInkB.x - iAa, uInkB.x + iAa, iLf), iB2 = smoothstep(uInkB.y - iAa, uInkB.y + iAa, iLf);',
        '    float iLv = mix(uInkL.x, mix(uInkL.y, uInkL.z, iB2), iB1);',
        '    vec3 iT = mix(uInkS, vec3(1.0), iB1) * mix(vec3(1.0), uInkW, iB2);',
        '    float iS = dot(vInkP, uInkN) * uInkH.y, iFw = fwidth(iS);',
        '    float iTri = abs(fract(iS) - 0.5) * 2.0;',                                                  // 0 auf der Linie … 1 dazwischen
        '    float iLn = 1.0 - smoothstep(uInkH.z - iFw, uInkH.z + iFw, iTri);',
        '    float iHk = (1.0 - iB1) * uInkH.x * (1.0 - smoothstep(0.18, 0.36, iFw));',
        '    outgoingLight = diffuseColor.rgb * iLv * iT * (1.0 - iHk * iLn) + totalEmissiveRadiance;',
        '    if (uInkH.w > 0.5) outgoingLight = vec3(iLf * 0.5, iLv * 0.5, 0.0);',   // Test: Lichtfaktor (rot) / Stufe (grün)
        '  }',
        '#include <opaque_fragment>'].join('\n'));
  }

  /** v0.6: Kachel-Sichtbarkeit (Sim-Pixel) für den lokalen Spieler. */
  function visibleAt(x, y) {
    var S = G.Sim.S;
    if (S.settings.fogOff) return true;
    var tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
    if (tx < 0 || ty < 0 || tx >= S.map.w || ty >= S.map.h) return false;
    return S.players[V.pid].vis[ty * S.map.w + tx] === 1;
  }
  // grober Sichtbereich in Kacheln (je Frame in fillFrame gesetzt) für Effekt-Budgets
  var vb = { x0: 0, z0: 0, x1: 0, z1: 0 };
  function inView(xx, zz) { return xx > vb.x0 - 2 && xx < vb.x1 + 2 && zz > vb.z0 - 2 && zz < vb.z1 + 3; } // v0.7: vb = Hüllrechteck des gedrehten Ausschnitts

  // Kontext befüllen (Funktionen sofort, Objekte in init()/syncCtx())
  R.THREE = THREE; R.D = D; R.TILE = TILE;
  R.hash = hash; R.clamp = clamp; R.lerpAng = lerpAng; R.smooth = smooth; R.rnd = rnd;
  R.fowify = fowify; R.visibleAt = visibleAt; R.inView = inView; R.project = function (x, y, z, out) { return project(x, y, z, out); };
  R.t = 0; R.dt = 0; R.F = F; R.mark = mark;
  /** Qualitäts-Flags in den Kontext spiegeln (nach jeder Änderung von Q / safeGPU / Renderer). */
  function syncCtx() {
    R.V = V; R.scene = scene; R.camera = camera; R.renderer = renderer; R.dynRoot = dynRoot; R.SH = SH; R.sun = sun; R.hemi = hemi;
    R.Q = Q; R.quality = quality; R.safeGPU = safeGPU; R.COS = COS; R.SIN = SIN;
    syncYaw();
    R.std = !!Q.std; R.post = !!(Q.std && Q.post); R.lite = !!(Q.std && !Q.post);
    R.ink = !!(Q.std && Q.ink);   // INK: Materialien/Gelände/Wasser im Zeichenstil (beim Anlegen gelesen → Wechsel baut Materialien neu)
    R.octx = octx;
    R.F = F; R.mark = mark;   // v0.8: Feature-Flags + Nutzungsmeldung
  }

  /** v0.7: Drehung (G.view.YAW) in den Kontext spiegeln – jedes Frame (Umschalten wirkt sofort). */
  var lastYaw = null, tmpL = [0, 0, 0];
  function syncYaw() {
    if (!V) return;
    CY = V.cy; SY = V.sy;
    R.YAW = V.YAW; R.CYAW = CY; R.SYAW = SY;
    R.FWD = R.FWD || [0, -1]; R.FWD[0] = -SY; R.FWD[1] = -CY;          // Bildschirm oben → Boden
    R.RIGHT = R.RIGHT || [1, 0]; R.RIGHT[0] = CY; R.RIGHT[1] = -SY;     // Bildschirm rechts → Boden
    if (THREE) { if (!VDIR) VDIR = new THREE.Vector3(); VDIR.set(-SY * COS, -SIN, -CY * COS).normalize(); R.VDIR = VDIR; }
    // Modern-Wasser (r3-terrain) rechnet Fresnel/Glanz mit der Richtung zur Kamera und zur Sonne → nachführen (W11: jedes Frame –
    // nach einem Welt-Neubau trägt das neue Wassermaterial sonst wieder die Startwerte der geraden Kamera)
    try {
      var wm = world && world.water;
      if (wm && wm.uniforms) {
        if (wm.uniforms.uView) wm.uniforms.uView.value.set(SY * COS, SIN, CY * COS);
        if (wm.uniforms.uSun) { var ld = V.lightDir(MODERN_LOOK.sunDir, tmpL); wm.uniforms.uSun.value.set(ld[0], ld[1], ld[2]).normalize(); }
      }
    } catch (e) { /* egal */ }
    if (lastYaw !== V.YAW) {
      var first = lastYaw === null;
      lastYaw = V.YAW;
      // W11: Umgebungslicht (Sonnenfleck im prozeduralen Himmel) dreht mit der Kamera mit
      if (!first && renderer && Q && Q.std && F.env && envRT) { try { buildEnv(); scene.environment = envRT ? envRT.texture : null; R.env = envRT ? envRT.texture : null; } catch (e) { /* egal */ } }
    }
  }

  // ------------------------------------------------------------------ v0.6: Modern – Licht, Umgebung, Nachbearbeitung, dynamische Auflösung
  // Stimmung (zentral einstellbar): Sonne warm, Himmel kühl, Umgebung (PMREM aus prozeduralem Himmel) für weiches Umgebungslicht + Reflexe.
  var MODERN_LOOK = {
    tone: null, exposure: 1.0,                    // tone wird in applyLook gesetzt (THREE erst dann sicher da)
    // A2 (Lichtstimmung): Sonne wärmer + etwas kräftiger, Himmelslicht kühler und stärker → warme Lichtseiten, bläuliche Schatten
    // (vorher sun '#ffdcae' 3.6, Schatten 0.92, hemiSky '#bcd4ff' 0.32, envI 0.55)
    sun: '#ffd9a8', sunI: 3.8, hemiSky: '#a6c6ff', hemiGround: '#5a5038', hemiI: 0.6, envI: 0.5,
    hemiNoEnv: 1.15, hemiSkyNoEnv: '#c4d6f2',     // v0.8: Ersatz, wenn das Umgebungslicht (Flag env) aus ist
    sunDir: [-0.62, 0.68, -0.4],                  // tiefer als Pixel-Look → längere, weiche Schatten. W11: Wert gilt für die alte Diagonale (YAW = π/4);
                                                  // benutzt wird G.view.lightDir(sunDir) → dreht mit der Kamera (gleiche Lichtseite am Bildschirm)
    shadowRadius: 2.6, shadowIntensity: 0.84,
    bloom: { strength: 0.5, radius: 0.4, threshold: 2.6, mips: 3 },   // v10: 1.08 → 2.6 – helle Flächen (Mauern, Beton, Dächer: Sonne ≈ 1.1–2.4 HDR) glühten wie Neon; nur echte Leuchtteile/FX (> 2.6 HDR) blühen
    ao: { radius: 1.3, thickness: 1.6, distanceExponent: 1.3, scale: 2.4, samples: 8, intensity: 0.65 },   // A2: 1.0 → 0.65 – die Verdeckung legte sich als breiter grauer Hof um Bäume/Gebäude und machte Wald schwarz
    grade: { sat: 1.0, contrast: 1.1, lift: [0.004, 0.007, 0.018], warm: [1.04, 0.985, 0.95], vignette: 0.22 },   // A2: Kontrast 1.07 → 1.1, Vignette 0.16 → 0.22
    sharp: { base: 0.4, perScale: 1.2 },          // A1: Nachschärfen im FXAA-Durchgang; + perScale · (1 − dynamische Skalierung)
    // W11-look: ohne Nachbearbeitung (PowerVR „M-U“) mit Flag liteLook: Farbabstimmung im Material (grade oben) + Lichtfaktoren als Ersatz
    // für die fehlende Umgebungsverdeckung (AO dunkelt im Modern-Bild Flächen im Mittel ab) – abgestimmt mit tests/look-w11.js
    lite: { sunK: 1.0, hemiK: 0.9, envK: 0.9, exposure: 0.93, con: 1.1, sat: 1.0 }
  };
  // INK: Stimmung „Gezeichnet“ – klare Sonne (scharfe, flächige Schlagschatten), kein Umgebungs-PMREM (billiger; Himmelslicht reicht für Toon),
  // Toon-Schwellen/-Stufen (Lichtfaktor ≈ (Sonne·NdotL·Schatten + Himmel)/π), Schraffur, Tusche-Konturen und Palette im Abschluss-Durchgang.
  var INK_LOOK = {
    sun: '#fff0d8', sunI: 3.6, hemiSky: '#c9d6ee', hemiGround: '#6a604a', hemiI: 1.25, shadowRadius: 1.2, shadowIntensity: 0.9,
    bands: [0.55, 0.92], levels: [0.5, 0.8, 1.04], shade: [0.86, 0.9, 1.1], warm: [1.05, 1.0, 0.92],
    hatch: { k: 0.38, density: 2.4, width: 0.3 },
    line: { css: 1.8, alpha: 1.0, col: [0.1, 0.085, 0.075] },     // Konturbreite (CSS-px, Halbmesser der Abtastung), Deckkraft, Tuschefarbe (sRGB)
    exposure: 1.1, sat: 0.8, satKeep: 1.08, contrast: 1.04, lift: [0.012, 0.012, 0.016], warmG: [1.03, 1.0, 0.95], vignette: 0.14,
    paper: [0.97, 0.94, 0.86], paperK: 0.05, grain: 0.035,
    lite: { con: 1.06, sat: 0.84, exposure: 1.12 }                    // ohne Abschluss-Durchgang (INK_LITE): Palette über uGrade im Material
  };
  var EDGE_DIM = [0.6, 0.46];             // A3: Helligkeit am Kartenrand 0.46 → voll nach 0.9 Kacheln (gleiche Werte im Rand-Vorland, r3-terrain.js)
  var pipe = null;                        // Nachbearbeitungs-Kette (nur Modern, nicht Lite)
  var dyn = { scale: 1, slowT: 0, fastT: 0, lock: false, avg: 16 };   // dynamische Render-Skalierung
  var envRT = null;

  /** Licht/Tonwert/Schattenweichheit/Umgebung je Qualität setzen; Nachbearbeitung (neu) aufbauen. Nach jedem createRenderer(). */
  function applyLook() {
    if (!renderer) return;
    MODERN_LOOK.tone = THREE.ACESFilmicToneMapping;
    if (Q.std) {
      sun.color.set(MODERN_LOOK.sun); sun.intensity = MODERN_LOOK.sunI;
      hemi.color.set(MODERN_LOOK.hemiSky); hemi.groundColor.set(MODERN_LOOK.hemiGround); hemi.intensity = MODERN_LOOK.hemiI;
      sun.shadow.radius = Q.lite ? 2.2 : MODERN_LOOK.shadowRadius;
      sun.shadow.intensity = MODERN_LOOK.shadowIntensity;
      sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
      renderer.toneMapping = pipeWanted() ? THREE.NoToneMapping : MODERN_LOOK.tone;   // mit Nachbearbeitung: Tonwert im Abschluss-Shader
      renderer.toneMappingExposure = MODERN_LOOK.exposure;
      if (F.env && !Q.ink) buildEnv(); else if (envRT) { envRT.dispose(); envRT = null; }   // INK: ohne PMREM
      scene.environment = envRT ? envRT.texture : null;
      scene.environmentIntensity = MODERN_LOOK.envI;
      // v0.8: ohne Umgebungslicht (Flag env aus) übernimmt das Himmelslicht dessen Anteil (sonst wirken Metall/Lack schwarz)
      if (!envRT) { hemi.intensity = MODERN_LOOK.hemiNoEnv; hemi.color.set(MODERN_LOOK.hemiSkyNoEnv); }
      scene.background = new THREE.Color('#0b0f14');
      if (Q.ink) inkLook();
      liteGrade();
    } else {
      // A2: auch die klassischen Stufen (Pixel/Scharf/Spar) bekommen etwas mehr Richtungskontrast – Sonne wärmer/kräftiger, Himmelslicht kühler/schwächer
      // (vorher Sonne '#fff3dc' 2.6, Himmel '#dbe8ff' 1.35); kostet nichts
      sun.color.set('#ffe8c6'); sun.intensity = 2.95;
      hemi.color.set('#cddfff'); hemi.groundColor.set('#5b5a3c'); hemi.intensity = 1.18;
      sun.shadow.radius = 1; sun.shadow.intensity = 1; sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.02;
      scene.environment = null;
      if (envRT) { envRT.dispose(); envRT = null; }
    }
    R.env = envRT ? envRT.texture : null;
    disposePipe();
    if (pipeWanted()) { try { pipe = Q.ink ? makeInkPipe() : makePipe(); } catch (e) { console.warn('Nachbearbeitung nicht verfügbar: ' + e); pipe = null; renderer.toneMapping = MODERN_LOOK.tone; } }
    R.post = !!pipe; R.pipe = pipe;
    if (!Q.std || pipe) SH.uGrade.value.x = 0;
  }
  /** INK: Licht/Toon-Werte setzen (nach den Modern-Werten, überschreibt sie). Umgebungs-PMREM aus (Toon braucht keine Reflexe). */
  function inkLook() {
    var L = INK_LOOK, U = SH;
    sun.color.set(L.sun); sun.intensity = L.sunI;
    hemi.color.set(L.hemiSky); hemi.groundColor.set(L.hemiGround); hemi.intensity = L.hemiI;
    sun.shadow.radius = L.shadowRadius; sun.shadow.intensity = L.shadowIntensity;
    if (envRT) { envRT.dispose(); envRT = null; }
    scene.environment = null;
    renderer.toneMappingExposure = L.exposure;
    U.uInkB.value.fromArray(L.bands); U.uInkL.value.fromArray(L.levels); U.uInkS.value.fromArray(L.shade); U.uInkW.value.fromArray(L.warm);
    U.uInkH.value.set(L.hatch.k, L.hatch.density, L.hatch.width, L.dbgLf ? 1 : 0);
  }
  /** W11-look: Modern ohne Nachbearbeitung + Flag liteLook → Abschluss-Farbkorrektur in den Materialien (SH.uGrade), Lichtfaktoren MODERN_LOOK.lite. */
  function liteGrade() {
    var on = !!(Q.std && !pipeWanted() && F.liteLook), L = MODERN_LOOK, k = L.lite;
    if (Q.ink) {   // INK_LITE: gedeckte Palette über die Material-Farbkorrektur (immer an – billig, kein Durchgang)
      var I = INK_LOOK;
      on = !pipeWanted();
      SH.uGrade.value.set(on ? 1 : 0, I.lite.sat, I.lite.con, I.vignette);
      SH.uWarm.value.fromArray(I.warmG); SH.uLift.value.fromArray(I.lift);
      if (on) renderer.toneMappingExposure = I.lite.exposure;
      return;
    }
    SH.uGrade.value.set(on ? 1 : 0, k.sat, k.con, L.grade.vignette);
    SH.uWarm.value.fromArray(L.grade.warm); SH.uLift.value.fromArray(L.grade.lift);
    if (!on) return;
    sun.intensity *= k.sunK; hemi.intensity *= k.hemiK; scene.environmentIntensity *= k.envK; renderer.toneMappingExposure = k.exposure;
  }
  function pipeWanted() { return !!(Q.std && Q.post && F.post && (Q.ink || (THREE.GTAOPass && THREE.UnrealBloomPass))); }   // INK: nur eigener Abschluss-Durchgang // v0.8: Flag post (PowerVR: aus, außer der Grafik-Test hat es freigegeben)
  function disposePipe() { if (pipe) { try { pipe.dispose(); } catch (e) { /* egal */ } pipe = null; } R.post = false; R.pipe = null; }

  /** Prozeduraler Himmel (Verlauf + Sonnenfleck + Bodenreflex) → PMREM. Klein gehalten (Lite: 32er Würfel). */
  function buildEnv() {
    if (envRT) { envRT.dispose(); envRT = null; }
    try {
      var es = new THREE.Scene();
      var sky = new THREE.Mesh(new THREE.SphereGeometry(10, 24, 12), new THREE.ShaderMaterial({
        side: THREE.BackSide, depthWrite: false,
        uniforms: { uSun: { value: new THREE.Vector3().fromArray(V ? V.lightDir(MODERN_LOOK.sunDir) : MODERN_LOOK.sunDir).normalize() } },
        vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: [
          'uniform vec3 uSun; varying vec3 vD;',
          'void main(){',
          '  float y = vD.y;',
          '  vec3 zen = vec3(0.30, 0.48, 0.82), hor = vec3(0.86, 0.84, 0.78), gnd = vec3(0.26, 0.24, 0.18);',
          '  vec3 c = y > 0.0 ? mix(hor, zen, pow(y, 0.6)) : mix(hor * 0.75, gnd, pow(-y, 0.5));',
          '  float s = max(0.0, dot(vD, uSun));',
          '  c += vec3(1.0, 0.82, 0.6) * (pow(s, 64.0) * 6.0 + pow(s, 6.0) * 0.35);',   // Sonne + Hof
          '  c += vec3(0.9, 0.95, 1.0) * smoothstep(0.35, 0.0, abs(y)) * 0.12;',       // heller Horizontstreifen
          '  gl_FragColor = vec4(c, 1.0);',
          '}'].join('\n')
      }));
      es.add(sky);
      var pm = new THREE.PMREMGenerator(renderer);
      envRT = pm.fromScene(es, 0.02, 0.1, 50, { size: Q.lite ? 32 : 64 });
      pm.dispose(); sky.geometry.dispose(); sky.material.dispose();
    } catch (e) { console.warn('Umgebungslicht nicht verfügbar: ' + e); envRT = null; }
  }

  /** Nachbearbeitung: Szene (HDR, HalfFloat + Tiefentextur) → Bloom (halbe Aufl., 3 Mips, nur Werte > Schwelle) →
   *  GTAO (halbe Aufl., Normalen aus Tiefe, 8 Abtastungen + Entrauschen) → Abschluss (AO, Farbkorrektur, ACES, sRGB) → FXAA + Nachschärfen (A1, ein Durchgang). */
  function makePipe() {
    var L = MODERN_LOOK, w = Math.max(2, bufW), h = Math.max(2, bufH);
    var dt = new THREE.DepthTexture(w, h); dt.type = THREE.UnsignedIntType;
    var rtScene = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthTexture: dt, depthBuffer: true, stencilBuffer: false });
    var rtLdr = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, depthBuffer: false });
    rtLdr.texture.minFilter = rtLdr.texture.magFilter = THREE.LinearFilter;
    var bloom = new THREE.UnrealBloomPass(new THREE.Vector2(w, h), L.bloom.strength, L.bloom.radius, L.bloom.threshold);
    bloom.nMips = L.bloom.mips;                                         // nur 3 Mip-Stufen rechnen (4./5. bleiben schwarz)
    bloom.compositeMaterial.uniforms.bloomFactors.value = [1.0, 0.85, 0.6, 0, 0];
    var ao = new THREE.GTAOPass(scene, camera, Math.max(2, w >> 1), Math.max(2, h >> 1), { depthTexture: dt });
    ao.output = THREE.GTAOPass.OUTPUT.Off;                              // nur AO-Textur berechnen; Mischen im Abschluss-Shader
    ao.updateGtaoMaterial({ radius: L.ao.radius, thickness: L.ao.thickness, distanceExponent: L.ao.distanceExponent, scale: L.ao.scale, samples: L.ao.samples, distanceFallOff: 1 });
    ao.updatePdMaterial({ samples: 8, rings: 2, radius: 6, lumaPhi: 10, depthPhi: 2, normalPhi: 3 });
    var fin = new THREE.ShaderMaterial({
      depthTest: false, depthWrite: false,
      uniforms: { tScene: { value: rtScene.texture }, tAO: { value: ao.gtaoMap }, uAO: { value: L.ao.intensity }, uExp: { value: L.exposure },
        uSat: { value: L.grade.sat }, uCon: { value: L.grade.contrast }, uLift: { value: new THREE.Vector3().fromArray(L.grade.lift) },
        uWarm: { value: new THREE.Vector3().fromArray(L.grade.warm) }, uVig: { value: L.grade.vignette }, uDbg: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: [
        'uniform sampler2D tScene; uniform sampler2D tAO; uniform float uAO; uniform float uExp; uniform float uSat; uniform float uCon; uniform vec3 uLift; uniform vec3 uWarm; uniform float uVig; uniform float uDbg;',
        'varying vec2 vUv;',
        'vec3 RRTAndODTFit(vec3 v){ vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }',
        'vec3 aces(vec3 c){',   // wie three.js ACESFilmicToneMapping
        '  const mat3 I = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));',
        '  const mat3 O = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));',
        '  c *= uExp / 0.6; c = I * c; c = RRTAndODTFit(c); c = O * c; return clamp(c, 0.0, 1.0); }',
        'vec3 toSRGB(vec3 c){ return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }',
        'void main(){',
        '  vec3 c = texture2D(tScene, vUv).rgb;',
        '  float ao = texture2D(tAO, vUv).r;',
        '  c *= mix(1.0, ao, uAO);',
        '  c = c * uWarm + uLift;',
        '  c = aces(c);',
        '  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));',
        '  c = mix(vec3(l), c, uSat);',
        '  c = clamp((c - 0.5) * uCon + 0.5, 0.0, 1.0);',
        '  vec2 q = vUv - 0.5; c *= 1.0 - uVig * dot(q, q) * 2.0;',
        '  if (uDbg > 0.5) c = vec3(ao);',
        '  gl_FragColor = vec4(toSRGB(c), 1.0);',
        '}'].join('\n')
    });
    var fq = new THREE.FullScreenQuad(fin);
    // A1 (Bildschärfe): die mitgelieferte FXAA-Fassung glättet mit vollem Subpixel-Anteil und sehr niedriger Schwelle auch Texturkorn → weiches Bild.
    // Hier (nur in unserer Kopie des Shader-Texts): Subpixel-Anteil 1.0 → 0.4, Schwellen höher (mehr Pixel verlassen den Shader früh = billiger),
    // dazu im SELBEN Durchgang ein begrenztes Nachschärfen (4 Nachbarn, auf deren Min/Max geklemmt → kein Überschwingen an Kanten).
    // uSharp wächst, wenn die dynamische Auflösung herunterregelt (Hochskalieren macht weich). Schlägt die Ersetzung fehl, bleibt der Originaltext.
    var fxFS = THREE.FXAAShader.fragmentShader, fxU = THREE.UniformsUtils.clone(THREE.FXAAShader.uniforms);
    fxU.uSharp = { value: L.sharp.base };
    var fxMain = 'gl_FragColor = ApplyFXAA( tDiffuse, resolution.xy, vUv );';
    if (fxFS.indexOf(fxMain) >= 0 && fxFS.indexOf('_SubpixelBlending = 1.0') >= 0) {
      fxFS = 'uniform float uSharp;\n' + fxFS.replace('_SubpixelBlending = 1.0', '_SubpixelBlending = 0.4')
        .replace('_ContrastThreshold = 0.0312', '_ContrastThreshold = 0.05').replace('_RelativeThreshold = 0.063', '_RelativeThreshold = 0.1')
        .replace(fxMain, [
          'vec4 c = ApplyFXAA( tDiffuse, resolution.xy, vUv );',
          '  vec3 n1 = texture( tDiffuse, vUv + vec2( 0.0, resolution.y ) ).rgb, n2 = texture( tDiffuse, vUv - vec2( 0.0, resolution.y ) ).rgb;',
          '  vec3 n3 = texture( tDiffuse, vUv + vec2( resolution.x, 0.0 ) ).rgb, n4 = texture( tDiffuse, vUv - vec2( resolution.x, 0.0 ) ).rgb;',
          '  vec3 mn = min( c.rgb, min( min( n1, n2 ), min( n3, n4 ) ) ), mx = max( c.rgb, max( max( n1, n2 ), max( n3, n4 ) ) );',
          '  c.rgb = clamp( c.rgb + ( c.rgb - ( n1 + n2 + n3 + n4 ) * 0.25 ) * uSharp, mn, mx );',
          '  gl_FragColor = c;'].join('\n'));
    }
    var fx = new THREE.ShaderMaterial({ uniforms: fxU, vertexShader: THREE.FXAAShader.vertexShader, fragmentShader: fxFS, depthTest: false, depthWrite: false });
    fx.uniforms.tDiffuse.value = rtLdr.texture; fx.uniforms.resolution.value.set(1 / w, 1 / h);
    var aq = new THREE.FullScreenQuad(fx);
    var P = {
      w: w, h: h, ms: 0,
      setSize: function (W, H) {
        W = Math.max(2, W); H = Math.max(2, H);
        if (W === P.w && H === P.h) return;
        P.w = W; P.h = H;
        rtScene.setSize(W, H); rtLdr.setSize(W, H); bloom.setSize(W, H); ao.setSize(Math.max(2, W >> 1), Math.max(2, H >> 1));
        fx.uniforms.resolution.value.set(1 / W, 1 / H);
      },
      render: function (dtS) {
        renderer.setRenderTarget(rtScene);
        renderer.render(scene, camera);
        P.calls = renderer.info.render.calls; P.tris = renderer.info.render.triangles;
        bloom.render(renderer, null, rtScene, dtS || 0, false);         // addiert Glühen in rtScene
        ao.render(renderer, null, rtScene, dtS || 0, false);
        renderer.setRenderTarget(rtLdr); fq.render(renderer);
        fx.uniforms.uSharp.value = L.sharp.base + (1 - dyn.scale) * L.sharp.perScale;
        renderer.setRenderTarget(null); aq.render(renderer);
      },
      info: function () { return { w: P.w, h: P.h, ao: true, bloom: true, aa: 'fxaa' }; },
      dispose: function () { rtScene.dispose(); rtLdr.dispose(); dt.dispose(); bloom.dispose(); ao.dispose(); fin.dispose(); fx.dispose(); fq.dispose(); aq.dispose(); },
      bloom: bloom, ao: ao, fin: fin
    };
    return P;
  }

  /** INK: Nachbearbeitung „Gezeichnet“ – EIN Zusatz-Durchgang statt Bloom + GTAO + Abschluss + FXAA (Modern: ~9 Durchgänge, 3 Ziele):
   *  Szene (HDR, HalfFloat + Tiefentextur, wie Modern) → Abschluss direkt auf den Bildschirm:
   *   – Tuschekonturen aus der Tiefe: 5 Abtastungen (Mitte + 4 Nachbarn im Abstand r), Laplace der linearen Tiefe (Ortho-Kamera →
   *     Tiefe linear in Welt-Einheiten), normiert auf r · Pixelgröße in der Welt → dimensionslos (Steigungsknick). Positiv = konvexe Kante /
   *     Silhouette auf der VORDEREN Seite (Linie liegt am Objekt, nicht im Boden), negativ = Innenknick (Mauerfuß) schwächer.
   *     r in CSS-Pixeln fest → gleiche Strichstärke bei dynamischer Auflösung / jedem DPR. Strichstärke + Deckkraft schwanken mit einem
   *     WELTFESTEN Rauschen (Punkt aus Tiefe rekonstruiert) → „Pinselstrich“, der beim Scrollen/Zoomen an der Welt hängt (kein Kriechen).
   *     Kanten glätten die Silhouetten zugleich (ersetzt FXAA).
   *   – Palette: ACES, gedeckte Sättigung (kräftige Farben – Teamfarben – bleiben), warmes Papier in den Lichtern, feine Papierkörnung (fest
   *     am Bildschirm wie Papier unter dem Bild), leichte Vignette, sRGB. */
  function makeInkPipe() {
    var L = INK_LOOK, IL = L.line, w = Math.max(2, bufW), h = Math.max(2, bufH);
    var dt = new THREE.DepthTexture(w, h); dt.type = THREE.UnsignedIntType;
    var rtScene = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthTexture: dt, depthBuffer: true, stencilBuffer: false });
    var fin = new THREE.ShaderMaterial({
      depthTest: false, depthWrite: false,
      uniforms: { tScene: { value: rtScene.texture }, tDepth: { value: dt }, uTex: { value: new THREE.Vector2(1 / w, 1 / h) },
        uRange: { value: 100 }, uPx: { value: 0.02 }, uR: { value: 2 }, uInk: { value: new THREE.Vector4().fromArray(IL.col.concat([IL.alpha])) },
        uCam: { value: new THREE.Vector3() }, uRt: { value: new THREE.Vector3() }, uUp: { value: new THREE.Vector3() }, uFw: { value: new THREE.Vector3() },
        uExp: { value: L.exposure }, uSat: { value: new THREE.Vector2(L.sat, L.satKeep) }, uCon: { value: L.contrast }, uLift: { value: new THREE.Vector3().fromArray(L.lift) },
        uWarm: { value: new THREE.Vector3().fromArray(L.warmG) }, uVig: { value: L.vignette }, uPaper: { value: new THREE.Vector4().fromArray(L.paper.concat([L.paperK])) },
        uGrain: { value: L.grain }, uDbg: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: [
        'uniform sampler2D tScene; uniform sampler2D tDepth; uniform vec2 uTex; uniform float uRange; uniform float uPx; uniform float uR; uniform vec4 uInk;',
        'uniform vec3 uCam; uniform vec3 uRt; uniform vec3 uUp; uniform vec3 uFw;',
        'uniform float uExp; uniform vec2 uSat; uniform float uCon; uniform vec3 uLift; uniform vec3 uWarm; uniform float uVig; uniform vec4 uPaper; uniform float uGrain; uniform float uDbg;',
        'varying vec2 vUv;',
        'vec3 RRTAndODTFit(vec3 v){ vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }',
        'vec3 aces(vec3 c){',
        '  const mat3 I = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));',
        '  const mat3 O = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));',
        '  c *= uExp / 0.6; c = I * c; c = RRTAndODTFit(c); c = O * c; return clamp(c, 0.0, 1.0); }',
        'vec3 toSRGB(vec3 c){ return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }',
        'float hsh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }',
        'float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);',
        '  return mix(mix(hsh(i), hsh(i + vec2(1.0, 0.0)), f.x), mix(hsh(i + vec2(0.0, 1.0)), hsh(i + vec2(1.0, 1.0)), f.x), f.y); }',
        'float dep(vec2 uv){ return texture2D(tDepth, uv).r * uRange; }',
        'void main(){',
        '  vec3 c = texture2D(tScene, vUv).rgb;',
        '  float d0 = dep(vUv);',
        // Weltpunkt (Ortho): Kamera + Bildschirmachsen + Tiefe → weltfestes Rauschen für die Strichstärke
        '  vec2 nd = vUv * 2.0 - 1.0; vec3 P = uCam + uRt * nd.x + uUp * nd.y + uFw * d0;',
        '  float n1 = vn(P.xz * 1.7 + P.y * 2.3), n2 = vn(P.xz * 0.45 - P.y + 11.0);',
        '  float r = uR * (0.7 + 0.6 * n1);',
        '  vec2 o = uTex * r;',
        '  float dl = dep(vUv - vec2(o.x, 0.0)), dr = dep(vUv + vec2(o.x, 0.0)), du = dep(vUv + vec2(0.0, o.y)), dd = dep(vUv - vec2(0.0, o.y));',
        '  float k = 1.0 / (uPx * r);',
        '  float lx = (dl + dr - 2.0 * d0) * k, ly = (du + dd - 2.0 * d0) * k;',
        '  float cvx = max(lx, ly), ccv = max(-lx, -ly);',
        '  float e = max(smoothstep(0.3, 0.8, cvx), smoothstep(0.9, 2.0, ccv) * 0.75);',
        '  e *= uInk.w * (0.78 + 0.22 * n2) * step(d0, uRange * 0.999);',
        // Palette
        '  c = c * uWarm + uLift;',
        '  c = aces(c);',
        '  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));',
        '  float mxc = max(c.r, max(c.g, c.b)), sat = (mxc - min(c.r, min(c.g, c.b))) / max(mxc, 1e-3);',
        '  c = mix(vec3(l), c, mix(uSat.x, uSat.y, smoothstep(0.5, 0.85, sat)));',      // gedeckt – kräftige Farben (Teams, Erz) bleiben
        '  c = clamp((c - 0.5) * uCon + 0.5, 0.0, 1.0);',
        '  c = mix(c, uPaper.rgb, uPaper.w * smoothstep(0.35, 1.0, l));',               // Lichter laufen ins warme Papier
        '  c = mix(c, min(c, uInk.rgb * (0.6 + 0.4 * c)), e);',                         // Tusche (leicht farbig; nie heller als darunter → nichts leuchtet aus dem Nebel)
        '  vec2 q = vUv - 0.5; c *= 1.0 - uVig * dot(q, q) * 2.0;',
        '  float g = hsh(floor(gl_FragCoord.xy * 0.5)) + hsh(floor(gl_FragCoord.xy * 0.5) + 7.7) - 1.0;',
        '  c *= 1.0 + g * uGrain;',
        '  if (uDbg > 0.5) c = vec3(1.0 - e);',
        '  gl_FragColor = vec4(toSRGB(clamp(c, 0.0, 1.0)), 1.0);',
        '}'].join('\n')
    });
    var fq = new THREE.FullScreenQuad(fin), U = fin.uniforms;
    var P = {
      w: w, h: h, ms: 0, ink: true,
      setSize: function (W, H) {
        W = Math.max(2, W); H = Math.max(2, H);
        if (W === P.w && H === P.h) return;
        P.w = W; P.h = H; rtScene.setSize(W, H); U.uTex.value.set(1 / W, 1 / H);
      },
      render: function () {
        renderer.setRenderTarget(rtScene);
        renderer.render(scene, camera);
        P.calls = renderer.info.render.calls; P.tris = renderer.info.render.triangles;
        // Kamera-Daten für Tiefe → Welt (Ortho): Range, Pixelgröße, Achsen
        var cm = camera, e = cm.matrixWorld.elements, hw = (cm.right - cm.left) / 2, hh = (cm.top - cm.bottom) / 2;
        U.uRange.value = cm.far - cm.near; U.uPx.value = 2 * hh / P.h;
        U.uRt.value.set(e[0], e[1], e[2]).multiplyScalar(hw); U.uUp.value.set(e[4], e[5], e[6]).multiplyScalar(hh);
        U.uFw.value.set(-e[8], -e[9], -e[10]);
        U.uCam.value.set(e[12], e[13], e[14]).addScaledVector(U.uFw.value, cm.near);
        var css = V && V.vh ? P.h / V.vh : 1;            // Pufferpixel je CSS-Pixel (DPR × dynamische Skalierung)
        U.uR.value = Math.max(1, IL.css * css);
        renderer.setRenderTarget(null); fq.render(renderer);
      },
      info: function () { return { w: P.w, h: P.h, ao: false, bloom: false, aa: 'ink', ink: true }; },
      dispose: function () { rtScene.dispose(); dt.dispose(); fin.dispose(); fq.dispose(); },
      fin: fin
    };
    return P;
  }

  /** Dynamische Auflösung (nur Modern): Bildzeit > 22 ms für 2 s → Skalierung −0.1 (min. 0.6); < 14 ms für 4 s → +0.1. */
  function dynRes(ms, dt) {
    if (dyn.lock || !dt || Q.lite || !F.dynRes) return;
    var iv = Math.max(ms, dt * 1000);
    dyn.avg += (iv - dyn.avg) * 0.1;
    if (dyn.avg > 22) { dyn.slowT += dt; dyn.fastT = 0; } else if (dyn.avg < 14) { dyn.fastT += dt; dyn.slowT = 0; } else { dyn.slowT = 0; dyn.fastT = 0; }
    var ns = dyn.scale;
    if (dyn.slowT > 2 && dyn.scale > 0.6) { ns = Math.max(0.6, dyn.scale - 0.1); dyn.slowT = 0; }
    else if (dyn.fastT > 4 && dyn.scale < 1) { ns = Math.min(1, dyn.scale + 0.1); dyn.fastT = 0; }
    if (ns !== dyn.scale) { dyn.scale = Math.round(ns * 10) / 10; sizeKey = ''; mark('dynRes'); } // v0.8: Größe erst am Anfang des nächsten draw() setzen – setSize nach dem Rendern leerte den Puffer (schwarzes Bild)
  }

  // ------------------------------------------------------------------ Initialisierung
  function init(canvas, miniCanvas) {
    V = G.view;
    cv = canvas; mini = miniCanvas; mapEl = cv.parentNode;
    if (stored2d && G.Render2D) { useFallback(false); return; } // 2D-Fallback: gespeicherte Wahl, WebGL wird nicht angefasst
    octx = cv.getContext('2d');
    mctx = mini.getContext('2d');
    if (!THREE) { console.warn('THREE fehlt'); resize(); return; }
    COS = Math.cos(V.PITCH); SIN = Math.sin(V.PITCH);
    tmpV = new THREE.Vector3(); tmpV2 = new THREE.Vector3(); tmpM = new THREE.Matrix4();
    ray = new THREE.Raycaster(); box3 = new THREE.Box3(); ndc = new THREE.Vector2();
    SH = {
      uFow: { value: null }, uFowScale: { value: new THREE.Vector2(1, 1) }, uFowOn: { value: 1 },
      uHazeCol: { value: new THREE.Color('#9db4cc') }, uHaze: { value: new THREE.Vector3(0, 1, 0.3) },
      // A3 (Kartenrand): Abdunklung der äußersten Kachelreihe = clamp(Randabstand · x + y); (0, 1) = aus (Symbol-Aufnahmen)
      uEdge: { value: new THREE.Vector2(EDGE_DIM[0], EDGE_DIM[1]) },
      // W11-look: Farbabstimmung ohne Nachbearbeitung (Flag liteLook): x an, y Sättigung, z Kontrast, w Vignette; Wärme/Anhebung wie der Abschluss-Shader
      uGrade: { value: new THREE.Vector4(0, 1, 1, 0) }, uWarm: { value: new THREE.Vector3(1, 1, 1) }, uLift: { value: new THREE.Vector3(0, 0, 0) }, uRes: { value: new THREE.Vector2(1, 1) },
      // INK: Toon-Stufen + Schraffur (Werte aus INK_LOOK in applyLook; uInkN je Bild aus der Kamera)
      uInkB: { value: new THREE.Vector2(0.3, 0.7) }, uInkL: { value: new THREE.Vector3(0.4, 0.75, 1) }, uInkS: { value: new THREE.Vector3(1, 1, 1) },
      uInkW: { value: new THREE.Vector3(1, 1, 1) }, uInkH: { value: new THREE.Vector4(0, 3, 0.3, 0) }, uInkN: { value: new THREE.Vector3(1, 0, 0) }
    };
    // 1×1-Platzhalter für den Nebel
    var ph = new THREE.DataTexture(new Uint8Array([255]), 1, 1, THREE.RedFormat, THREE.UnsignedByteType); ph.needsUpdate = true;
    SH.uFow.value = ph;
    T3 = G.R3T; M3 = G.R3M; F3 = G.R3F; S3 = G.R3S || null;   // W11-look: S3 = Schatten-Ersatz (r3-shadow.js, optional)
    MAT = M3.MAT; NEUT = M3.NEUT; GARR = M3.GARR; BH = M3.BH; SCALE = M3.SCALE; INF = M3.INF; model = M3.model; unitModelOf = M3.unitModelOf;
    neutralShown = M3.neutralShown; facOfColor = M3.facOfColor; isBld = M3.isBld; groundAt = T3.groundAt;
    scene = new THREE.Scene();
    scene.background = new THREE.Color('#0b0f14');
    camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 1, 140);
    hemi = new THREE.HemisphereLight('#dbe8ff', '#5b5a3c', 1.35);
    scene.add(hemi);
    sun = new THREE.DirectionalLight('#fff3dc', 2.6);
    sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.02;
    scene.add(sun); scene.add(sun.target);
    dynRoot = new THREE.Group(); scene.add(dynRoot);
    syncCtx();
    M3.link(); T3.link(); F3.link(); if (S3) S3.link();
    M3.makeMaterials();
    F3.init();
    T3.init();
    createRenderer();
    resize();
  }

  var glCreates = 0;
  function createRenderer() {
    glCreates++;
    var oldR = renderer, oldCv = glCv;
    renderer = null;
    glCv = document.createElement('canvas');
    if (oldR) { try { oldR.dispose(); oldR.forceContextLoss(); } catch (e) { /* egal */ } }
    if (oldCv && oldCv.parentNode) oldCv.parentNode.removeChild(oldCv);
    glCv.id = 'gl';
    glCv.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;display:block;pointer-events:none;' +
      (Q.mode === 'pixel' ? 'image-rendering:pixelated;image-rendering:crisp-edges;' : '');
    mapEl.insertBefore(glCv, cv);
    var why = '';
    glCv.addEventListener('webglcontextcreationerror', function (e) { why = e.statusMessage || ''; }, false);
    var OPTS = [
      { antialias: Q.aa, alpha: false, stencil: false, powerPreference: 'high-performance' },
      { antialias: false, alpha: false, stencil: false, powerPreference: 'default' },
      { antialias: false, alpha: false, stencil: false, depth: true, powerPreference: 'low-power', precision: 'mediump' }
    ];
    try {
      for (var oi = 0; oi < OPTS.length && !renderer; oi++) {
        try { OPTS[oi].canvas = glCv; renderer = new THREE.WebGLRenderer(OPTS[oi]); }
        catch (e1) {
          renderer = null; if (oi === OPTS.length - 1) throw e1;
          var nc = document.createElement('canvas'); nc.id = 'gl'; nc.style.cssText = glCv.style.cssText;
          glCv.parentNode.replaceChild(nc, glCv); glCv = nc;
          glCv.addEventListener('webglcontextcreationerror', function (e) { why = e.statusMessage || ''; }, false);
        }
      }
      glOK = true;
    } catch (e) {
      glOK = false; renderer = null;
      glFail = 'Der Browser stellt gerade keine 3D-Grafik bereit' + (why ? ' (' + why + ')' : '') + '.';
      console.warn('WebGL nicht verfügbar: ' + e);
      if (/blocked|disabled|policy|not supported|unsupported/i.test(why + ' ' + e)) wantFallback = true; // 2D-Fallback: vom Browser gesperrt/abgeschaltet → sofort 2D
      return;
    }
    // Kontextverlust (Handy: Speicherdruck, App-Wechsel) abfangen und Renderer neu aufbauen
    glLost = false;
    // Nur Ereignisse der AKTUELLEN Zeichenfläche zählen – das Verwerfen des alten Renderers
    // (forceContextLoss) löst ebenfalls 'webglcontextlost' aus und darf keinen Neustart anstoßen.
    var myCv = glCv;
    glCv.addEventListener('webglcontextlost', function (e) { e.preventDefault(); if (myCv !== glCv) return; glLost = true; glLostT = performance.now(); onLost(); }, false);
    glCv.addEventListener('webglcontextrestored', function () { if (myCv !== glCv) return; glLost = false; recoverGL(); }, false);
    // Grafikchip erkennen: PowerVR (z. B. Pixel 10 / Tensor G5) hat bekannte WebGL-Treiberprobleme → Schonmodus
    try {
      var g0 = renderer.getContext(), dbg = g0.getExtension('WEBGL_debug_renderer_info');
      gpuName = String(dbg ? g0.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : g0.getParameter(g0.RENDERER));
      try { localStorage.setItem('frontlinie.gpu', gpuName); } catch (e2) { /* egal */ } // Sprite-Modus: für die PowerVR-Vorgabe beim nächsten Start
      var psr = g0.getParameter(g0.ALIASED_POINT_SIZE_RANGE);
      if (psr && psr[1]) F3.setMaxPoint(Math.min(48, psr[1]));
    } catch (e) { gpuName = '?'; }
    if (fakeGPU) gpuName = fakeGPU;   // v0.8: Test-Hilfe (G.Render._fakeGPU / window.FRONTLINIE_FAKE_GPU)
    safeGPU = /PowerVR|Imagination|IMG /i.test(gpuName) || forceSafe;
    // v0.8: Flags je GPU (PowerVR: Startprofil „M-U“, sonst alles an) + gespeichertes Profil/Selbstheilung → wirksame Qualität
    if (!sessionChecked) sessionStart();
    F = computeFlags();
    Q = pickQ();
    activeSince = {};
    devAtCreate = Math.min(window.devicePixelRatio || 1, 3);
    renderer.setPixelRatio(1);
    if (F.fixedBuf) instrumentGL(renderer.getContext());
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = Q.std ? MODERN_LOOK.tone : THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = Q.std ? MODERN_LOOK.exposure : 1.05;
    renderer.shadowMap.enabled = !!Q.shadows;
    renderer.shadowMap.type = THREE.PCFShadowMap; // r187: PCF = 5 Vogel-Abtastungen; Weichheit über shadow.radius (Modern)
    renderer.info.autoReset = true;
    sun.castShadow = !!Q.shadows;
    if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    if (Q.shadows) sun.shadow.mapSize.set(Q.shadowSize, Q.shadowSize);
    syncCtx();
    applyLook();
    sizeKey = '';
  }

  /** Nach Kontextverlust: neuen Renderer + Welt aufbauen (alle GPU-Ressourcen neu hochladen). */
  // v0.8: Selbstheilung statt Pauschal-Schonmodus. Je echtem Absturz (Kontextverlust bei sichtbarer Seite) wird GENAU EINE Funktion
  // abgeschaltet (Leiter LADDER) und gespeichert; 2D nur, wenn schon alles aus ist und es trotzdem 2× abstürzt.
  var recoverTimes = [], lostCounted = false, lostOff = null, lostTo2d = false, visT = 0, recFrames = 0;
  function testActive() { return !!(G.GfxTest && G.GfxTest.active && G.GfxTest.active()); }
  function onLost() {
    lostCounted = false; lostOff = null; lostTo2d = false;
    var bg = (typeof document !== 'undefined' && document.hidden) || performance.now() - visT < 2500;
    if (bg) { console.warn('Kontextverlust im Hintergrund – kein Grafikfehler, nur Neuaufbau'); return; }
    lostCounted = true;
    if (run) { run.lost = 1; run.rec = 0; saveRun(); }
    if (testActive()) { try { G.GfxTest.onCrash(activeCode()); } catch (e) { console.warn(e); } return; } // Grafik-Test entscheidet selbst
    var r = ladderStep('verloren', activeCode());
    lostOff = r.off; lostTo2d = r.to2d;
  }
  function recoverGL() {
    var now = performance.now();
    recoverTimes = recoverTimes.filter(function (t) { return now - t < 60000; });
    recoverTimes.push(now);
    if (lostTo2d && G.Render2D && !testActive()) {   // alles aus und trotzdem wiederholt abgestürzt → 2D (gespeichert, „Grafik zurücksetzen“ hebt es auf)
      glOK = false; glFail = 'Die Grafik ist auch ganz einfach mehrfach abgestürzt.'; useFallback(true, true); return;
    }
    try {
      var wasStd = R.std, wasInk = R.ink;
      createRenderer();
      if (!glOK) return;   // gesperrt/fehlgeschlagen → drawNoGL (Hinweis: App ganz schließen) + Neuversuche
      if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
      F3.setMax(Q.particles);
      resize();
      if (wasStd !== R.std || wasInk !== R.ink) { M3.makeMaterials(); iconCache = {}; }
      if (pipe && !R.post) disposePipe();
      if (G.Sim.S) reset();
      recFrames = 0;
      var msg = lostOff ? 'Grafik neu gestartet – „' + FNAME[lostOff] + '“ abgeschaltet' : 'Grafik wurde neu gestartet';
      if (G.UI && G.UI.toast && !testActive()) G.UI.toast(msg);
    } catch (e) { console.warn('Grafik-Neustart fehlgeschlagen: ' + e); }
  }
  /** Einmal je Seitenstart (beim ersten erfolgreichen Renderer): voriger Lauf unsauber beendet (sichtbar, gespielt, nicht schon als
   *  Kontextverlust gezählt) → Absturz, der die Seite/App mitgerissen hat → eine Leiterstufe (bzw. im Grafik-Test: Schritt = schlecht). */
  var sessionChecked = false;
  function sessionStart() {
    sessionChecked = true;
    F = computeFlags();   // Grundsatz dieser GPU (für die Leiter beim Neustart)
    var a = loadAll(), lr = a.run, key = gpuKey();
    var unclean = !!(lr && lr.gpu === key && lr.alive && !lr.hidden && !(lr.lost && !lr.rec));
    var p = getProf();
    if (p && p.test) {
      if (p.test.pending) {
        if ((unclean && lr.play) || (lr && lr.lost && !lr.rec)) { p.test.bad = (p.test.bad || '') + p.test.pending; p.test.lastBad = p.test.pending; }
        else p.test.retry = p.test.pending;     // sauber beendet (App geschlossen) → Schritt wiederholen
        p.test.pending = null; p.test.step = (p.test.step || 0) + (p.test.retry ? 0 : 1);
      }
      p.test.resume = true; putProf(p);
    } else if (unclean && lr.play) ladderStep('Neustart', lr.act || '');
    run = { gpu: key, t0: Date.now(), alive: true, hidden: false, play: 0, act: '', lost: 0, rec: 0 };
    saveRun();
    if (typeof document !== 'undefined' && !visBound) {
      visBound = true;
      document.addEventListener('visibilitychange', function () {
        visT = performance.now();
        if (!run) return;
        run.hidden = !!document.hidden; run.alive = !document.hidden; saveRun();
      });
      window.addEventListener('pagehide', function () { if (run) { run.alive = false; run.hidden = true; saveRun(); } });
      window.addEventListener('pageshow', function () { if (run) { run.alive = true; run.hidden = false; saveRun(); } });
    }
  }
  var visBound = false, fakeGPU = (typeof window !== 'undefined' && window.FRONTLINIE_FAKE_GPU) || '', devAtCreate = 1;
  // v0.8: Zähler für GPU-Neuanlagen (PowerVR-Profil bzw. Test): zeigt, ob während des Spiels Puffer/Texturen neu angelegt werden
  var glCount = { setSize: 0, createTexture: 0, texImage: 0, createBuffer: 0, bufferData: 0, createFramebuffer: 0, createRenderbuffer: 0, renderbufferStorage: 0, newBatch: 0 };
  function instrumentGL(gl) {
    if (!gl || gl.__frCount) return;
    gl.__frCount = true;
    var wrap = function (name, key) {
      var orig = gl[name]; if (typeof orig !== 'function') return;
      gl[name] = function () { glCount[key]++; return orig.apply(gl, arguments); };
    };
    wrap('createTexture', 'createTexture'); wrap('texImage2D', 'texImage'); wrap('texImage3D', 'texImage'); wrap('texStorage2D', 'texImage'); wrap('texStorage3D', 'texImage');
    wrap('createBuffer', 'createBuffer'); wrap('bufferData', 'bufferData'); wrap('createFramebuffer', 'createFramebuffer');
    wrap('createRenderbuffer', 'createRenderbuffer'); wrap('renderbufferStorage', 'renderbufferStorage'); wrap('renderbufferStorageMultisample', 'renderbufferStorage');
  }
  R.glCount = glCount;

  // 2D-Fallback: WebGL ist weg/gesperrt oder vom Spieler abgewählt → G.Render2D übernimmt (gleiche Schnittstelle).
  var wantFallback = false, usingFallback = false, FALLBACK_AFTER_RETRIES = 5; // nach so vielen erfolglosen Neuversuchen (je 3 s) automatisch 2D
  function useFallback(explicit, auto, q2) {
    if (usingFallback || !G.Render2D) return;
    usingFallback = true; wantFallback = false;
    try { if (renderer) { renderer.dispose(); renderer.forceContextLoss(); } } catch (e) { /* egal */ }
    renderer = null; glOK = false;
    try { var gl0 = document.getElementById('gl'); if (gl0 && gl0.parentNode) gl0.parentNode.removeChild(gl0); if (glCv && glCv.parentNode) glCv.parentNode.removeChild(glCv); } catch (e) { /* egal */ }
    glCv = null;
    if (explicit) { try { localStorage.setItem(QKEY, q2 || '2d'); } catch (e) { /* egal */ } } // Sprite-Modus: 'sprite' oder '2d'
    G.Render = G.Render2D;
    G.Render2D.init(cv, mini);
    if (G.Sim && G.Sim.S && G.view && G.view.running) G.Render2D.reset();
    if (auto && G.UI && G.UI.toast) G.UI.toast('3D nicht verfügbar – 2D-Grafik aktiv');
  }

  function setQuality(q) {
    if (q === '2d' || q === 'sprite') { useFallback(true, false, q); return; } // 2D-Fallback / Sprite-Modus: Wahl im Menü
    if (!QUAL[q]) return;
    quality = q; Q = QUAL[q];
    try { localStorage.setItem(QKEY, q); } catch (e) { /* egal */ }
    if (!THREE || !mapEl) return;
    var wasStd = R.std, wasInk = R.ink;
    createRenderer();
    F3.setMax(Q.particles);
    resize();
    if (wasStd !== R.std || wasInk !== R.ink) { M3.makeMaterials(); if (G.Sim.S && world) reset(); iconCache = {}; } // v0.6: Materialklasse gewechselt → neu aufbauen (INK: auch Zeichenstil an/aus)
  }

  function resize() {
    var r = cv.getBoundingClientRect();
    var dev = window.devicePixelRatio || 1;
    dpr = Math.min(2, dev);
    var w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); overlayDirty = true;
    }
    if (V.vw !== w || V.vh !== h) { V.vw = w; V.vh = h; V.clampCam(); }
    var mr = mini.getBoundingClientRect();
    var mw = Math.round(mr.width * dpr), mh = Math.round(mr.height * dpr);
    if (mini.width !== mw || mini.height !== mh) { mini.width = mw; mini.height = mh; }
    if (!renderer) return;
    dev = Math.min(dev, 3); // Schutz: manche Android-WebViews melden beim Pinch-Zoom riesige Pixelverhältnisse
    if (F.fixedBuf) dev = devAtCreate; // v0.8 PowerVR: Pixelverhältnis beim Anlegen einfrieren – Pinch-Zoom der WebView löst keine Neuanlage aus
    var key = w + 'x' + h + '@' + dev.toFixed(2) + quality + (Q.lite ? 'L' : '') + dyn.scale.toFixed(2) + (F.hiRes ? 'H' : '') + Q.mode;
    if (key === sizeKey) { pendKey = ''; return; }
    var tnow = performance.now();
    if (F.fixedBuf && sizeKey) {
      // v0.8 PowerVR: nur bei echter Größenänderung, nachlaufend entprellt (Größe muss 500 ms stabil sein) → höchstens eine Neuanlage je Drehen/Falten
      if (key !== pendKey) { pendKey = key; pendKeyT = tnow; pendingSize = true; return; }
      if (tnow - pendKeyT < 500) { pendingSize = true; return; }
    } else if (sizeKey && tnow - lastSizeT < 300) { pendingSize = true; return; } // Größenänderungen höchstens alle 300 ms übernehmen
    lastSizeT = tnow; pendingSize = false; pendKey = '';
    sizeKey = key;
    if (Q.mode === 'pixel') {
      // ganzzahliger Teiler ≈ 1/3 der Gerätepixel, mindestens ~280 px Höhe → scharf hochskalierte Pixel
      var div = Math.min(3, Math.max(1, Math.floor(h * dev / 280)));
      bufW = Math.max(1, Math.ceil(w * dev / div)); bufH = Math.max(1, Math.ceil(h * dev / div));
    } else if (Q.mode === 'sharp') {
      bufW = Math.round(w * Math.min(2, dev)); bufH = Math.round(h * Math.min(2, dev));
    } else if (Q.mode === 'modern') {
      // v0.6: Modern = volle Auflösung (max. DPR 2) × dynamischer Skalierung (0.6–1); Lite: DPR ≤ 1.5, fest
      // v0.8: Flag hiRes (H) erlaubt DPR 2 auch ohne Nachbearbeitung; ohne H: DPR ≤ 1.5, ≤ 1.6 MPix
      var kd = (F.hiRes ? Math.min(2, dev) : Math.min(1.5, dev)) * (pipe ? dyn.scale : 1);
      bufW = Math.max(1, Math.round(w * kd)); bufH = Math.max(1, Math.round(h * kd));
    } else {
      var k = Math.min(1, dev) * 0.7;
      bufW = Math.max(1, Math.round(w * k)); bufH = Math.max(1, Math.round(h * k));
    }
    // harte Obergrenze für den Zeichenpuffer (Speicher auf Handys)
    var maxSide = 2048, maxPix = F.hiRes ? 2.2e6 : 1.6e6;
    try { var gl = renderer.getContext(); maxSide = Math.min(maxSide, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) || maxSide); } catch (e) { /* egal */ }
    var sc = Math.min(1, maxSide / bufW, maxSide / bufH, Math.sqrt(maxPix / (bufW * bufH)));
    if (sc < 1) { bufW = Math.max(1, Math.floor(bufW * sc)); bufH = Math.max(1, Math.floor(bufH * sc)); }
    renderer.setSize(bufW, bufH, false); glCount.setSize++;
    if (SH) SH.uRes.value.set(1 / bufW, 1 / bufH);   // W11-look: Vignette der Material-Farbkorrektur
    if (pipe) pipe.setSize(bufW, bufH);
  }
  var pendKey = '', pendKeyT = 0;


  // ------------------------------------------------------------------ Nebel
  function buildFogTex(m) {
    if (fog && fog.tex) fog.tex.dispose();
    fog = { data: new Uint8Array(m.w * m.h) };
    fog.tex = new THREE.DataTexture(fog.data, m.w, m.h, THREE.RedFormat, THREE.UnsignedByteType);
    fog.tex.magFilter = THREE.LinearFilter; fog.tex.minFilter = THREE.LinearFilter;
    fog.tex.needsUpdate = true;
    SH.uFow.value = fog.tex;
    SH.uFowScale.value.set(1 / m.w, 1 / m.h);
    fog.cv = document.createElement('canvas'); fog.cv.width = m.w; fog.cv.height = m.h;
    fog.ctx = fog.cv.getContext('2d');
    fog.img = fog.ctx.createImageData(m.w, m.h);
    fogTick = -1;
  }
  function updateFog() {
    var S = G.Sim.S, P = S.players[V.pid], n = S.map.w * S.map.h, off = S.settings.fogOff, fd = fog.data, im = fog.img.data;
    for (var i = 0; i < n; i++) {
      var v = off ? 255 : (P.vis[i] ? 255 : (P.exp[i] ? 112 : 0));
      fd[i] = v;
      im[i * 4 + 3] = off ? 0 : (P.vis[i] ? 0 : (P.exp[i] ? 130 : 255));
    }
    fog.tex.needsUpdate = true;
    fog.ctx.putImageData(fog.img, 0, 0);
    fogTick = S.tick;
  }

  /** Lade-Ring um ein Superwaffen-Gebäude (wie Artillerie): Teilring in Besitzerfarbe, bei 1 pulsierend. */
  function chargeRing(e, bx, bz, rr, col, ch) {
    var a0 = -Math.PI / 2, rc = rr;
    project(bx, 0.06, bz, ovP);
    var kx = TILE * V.ppx(), ky = TILE * V.ppy();   // v0.7: Bodenkreis → Ellipse mit Bildschirmachsen (unabhängig von YAW)
    octx.lineCap = 'butt';
    if (ch < 1) {
      octx.strokeStyle = 'rgba(0,0,0,0.65)'; octx.lineWidth = 8; groundArc(ovP.x, ovP.y, rc * kx, rc * ky, 0, 6.2832);
      octx.strokeStyle = 'rgba(255,255,255,0.18)'; octx.lineWidth = 4; groundArc(ovP.x, ovP.y, rc * kx, rc * ky, 0, 6.2832);
      octx.strokeStyle = col; octx.lineWidth = 4; groundArc(ovP.x, ovP.y, rc * kx, rc * ky, a0, a0 + 6.2832 * ch);
    } else {
      var pl = 0.55 + 0.45 * Math.sin(performance.now() / 150);
      octx.strokeStyle = 'rgba(0,0,0,0.75)'; octx.lineWidth = 11; groundArc(ovP.x, ovP.y, rc * kx, rc * ky, 0, 6.2832);
      octx.globalAlpha = pl; octx.strokeStyle = '#ffffff'; octx.lineWidth = 8; groundArc(ovP.x, ovP.y, rc * kx, rc * ky, 0, 6.2832);
      octx.globalAlpha = 1; octx.strokeStyle = col; octx.lineWidth = 4; groundArc(ovP.x, ovP.y, rc * kx, rc * ky, 0, 6.2832);
    }
  }
  function swChargeOverlay(S, pid, fogOff) {
    var ents = S.ents, i, e;
    for (i = 0; i < ents.length; i++) {
      e = ents[i];
      if (e.dead || e.kind !== 'building' || (e.type !== 'orbital' && e.type !== 'silo')) continue;
      if (e.owner !== pid && !fogOff && !G.Sim.isVisible(pid, e)) continue;
      var bx = e.x / TILE, bz = e.y / TILE;
      project(bx, 0.06, bz, ovP);
      if (ovP.x < -150 || ovP.y < -150 || ovP.x > V.vw + 150 || ovP.y > V.vh + 150) continue;
      chargeRing(e, bx, bz, Math.max(e.w, e.h) / 2 + 0.6, S.players[e.owner].color, e.charge || 0);
    }
  }

  // ------------------------------------------------------------------ Kamera & Licht
  function updateCamera() {
    syncYaw();
    var ppx = V.ppx(), ppy = V.ppy();
    var halfW = V.vw / 2 / ppx / TILE, halfH = V.vh / 2 / ppx / TILE;
    var cx = (V.cam.x + V.vw / 2 / ppx) / TILE, cz = (V.cam.y + V.vh / 2 / ppy) / TILE;
    if (Q.mode === 'pixel' && bufW > 1) { // auf das Pixelraster einrasten → kein Flimmern beim Schieben (v0.7: im gedrehten Bildschirmraum)
      var u = 2 * halfW / bufW, uu = CY * cx - SY * cz, vv = SY * cx + CY * cz;
      uu = Math.round(uu / u) * u; vv = Math.round(vv / (u / SIN)) * (u / SIN);
      cx = CY * uu + SY * vv; cz = -SY * uu + CY * vv;
    }
    var sk = F3.shakeOffset(); cx += sk.x; cz += sk.z;
    camera.left = -halfW; camera.right = halfW; camera.top = halfH; camera.bottom = -halfH;
    camera.near = 1; camera.far = CAM_DIST * 2 + 20;
    // Kamera steht „hinter“ der Bildmitte entgegen der Bildschirm-oben-Richtung (−FWD) und blickt um PITCH geneigt darauf
    camera.position.set(cx + SY * COS * CAM_DIST, SIN * CAM_DIST, cz + CY * COS * CAM_DIST);
    camera.up.set(0, 1, 0);
    camera.lookAt(cx, 0, cz);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    // Dunst: Tiefe des oberen Bildrands = weit
    var dTop = CAM_DIST + halfH / SIN * COS, dMid = CAM_DIST;
    SH.uHaze.value.set(dMid - 2, dTop + 4, 0.15);
    // INK: Schraffur-Ebenen ⟂ Blickrichtung → Linien „/“ am Bildschirm (rechts − oben), weltfest
    SH.uInkN.value.set(CY + SY * SIN, -COS, -SY + CY * SIN).normalize();   // A2: Dunst zum oberen Bildrand 0.28 → 0.15 (wusch die obere Bildhälfte grau aus)
    F3.setPointScale(bufH / (2 * halfH));
    return { cx: cx, cz: cz, halfW: halfW, halfH: halfH };
  }
  var LDIR = null, PIXEL_SUN = [-0.55, 1, -0.38];
  function updateSun(c) {
    if (!LDIR) LDIR = new THREE.Vector3();
    LDIR.fromArray(V.lightDir(Q.std ? MODERN_LOOK.sunDir : PIXEL_SUN, tmpL)).normalize();   // W11: dreht mit der Kamera
    var ext = Math.max(c.halfW, c.halfH / SIN) + 3;
    sun.target.position.set(c.cx, 0, c.cz);
    sun.position.set(c.cx + LDIR.x * 30, LDIR.y * 30, c.cz + LDIR.z * 30);
    sun.target.updateMatrixWorld(); sun.updateMatrixWorld();
    if (!Q.shadows) return;
    var sc = sun.shadow.camera;
    // Ausschnitt in Lichtraum einpassen
    sc.position.copy(sun.position); sc.lookAt(sun.target.position); sc.updateMatrixWorld();
    var inv = tmpM.copy(sc.matrixWorld).invert();
    var minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9, hz = c.halfH / SIN + 1.5, hx = c.halfW + 1.5;
    for (var k = 0; k < 8; k++) {
      // v0.7: Ecken des sichtbaren Bodenausschnitts entlang der gedrehten Bildschirmachsen (rechts = (CY, −SY), unten = (SY, CY))
      var ou = k & 1 ? hx : -hx, ov = k & 2 ? hz : -hz;
      tmpV.set(c.cx + CY * ou + SY * ov, k & 4 ? 2 : 0, c.cz - SY * ou + CY * ov).applyMatrix4(inv);
      if (tmpV.x < minX) minX = tmpV.x; if (tmpV.x > maxX) maxX = tmpV.x; if (tmpV.y < minY) minY = tmpV.y; if (tmpV.y > maxY) maxY = tmpV.y;
    }
    var tx = (maxX - minX) / Q.shadowSize, ty = (maxY - minY) / Q.shadowSize;
    sc.left = Math.floor(minX / tx) * tx; sc.right = Math.ceil(maxX / tx) * tx; sc.bottom = Math.floor(minY / ty) * ty; sc.top = Math.ceil(maxY / ty) * ty;
    sc.near = 1; sc.far = 60; sc.updateProjectionMatrix();
    void ext;
  }

  // ------------------------------------------------------------------ Hauptzeichnen
  function reset() {
    if (!glOK) { mapRef = G.Sim.S.map; return; }
    var m = G.Sim.S.map;
    mapRef = m;
    world = T3.build(m);          // Gelände, Wasser, Bäume/Felsen/Erz, Brücken, Decals
    lastYaw = null;               // v0.7: neues Wasser-Material → Blickrichtung neu setzen
    buildFogTex(m);
    buildMiniBase(m);
    ensureAux();
    M3.reset();
    F3.reset();
    if (S3) S3.reset();
    fogTick = -1; oreTick = -1;
  }

  function draw(alpha) {
    var now = performance.now(), dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 0;
    lastT = now;
    if (wantFallback && testActive()) wantFallback = false;   // v0.8: im Grafik-Test nie auf 2D wechseln (Hinweis „App neu öffnen“ statt dessen)
    if (wantFallback && G.Render2D) { useFallback(false, true); G.Render.draw(alpha); return; } // 2D-Fallback: gesperrt
    resize();
    var S = G.Sim.S;
    if (!glOK) {
      // bis zu 5 automatische Neuversuche im Abstand von 3 s
      var tn = performance.now();
      if (THREE && mapEl && glRetries < 5 && tn - glRetryT > 3000) { glRetryT = tn; glRetries++; retryGL(); }
      if (testActive()) wantFallback = false;
      if (!glOK && wantFallback && G.Render2D) { useFallback(false, true); G.Render.draw(alpha); return; } // 2D-Fallback: Fehler nennt "blocked"
      if (!glOK && !testActive() && (glRetries >= FALLBACK_AFTER_RETRIES || !THREE) && tn - glRetryT > 3000 && G.Render2D) { useFallback(false, true); G.Render.draw(alpha); return; } // 2D-Fallback: Neuversuche erschöpft
      if (!glOK) { drawNoGL(); return; }
    }
    if (glLost) { if (performance.now() - glLostT > 1500) { glLost = false; recoverGL(); } return; }
    if (pendingSize && performance.now() - lastSizeT >= 300) resize();
    if (!S || !V.running) {
      if (overlayDirty) { octx.setTransform(1, 0, 0, 1, 0, 0); octx.clearRect(0, 0, cv.width, cv.height); overlayDirty = false; }
      renderer.setClearColor('#0b0f14'); renderer.clear();
      return;
    }
    var t0 = performance.now(), ivl = dt;
    if (mapRef !== S.map || !world) reset();
    if (fogTick < 0 || S.tick - fogTick >= 3 || S.tick < fogTick) updateFog();
    if (oreTick < 0 || S.tick - oreTick >= 10 || S.tick < oreTick) { T3.updateOre(false); oreTick = S.tick; }
    if (V.paused) dt = 0;
    R.dt = dt;
    F3.consumeEvents(S);
    F3.shakeUpdate();
    var c = updateCamera();
    updateSun(c);
    fillFrame(S, alpha, dt);
    F3.update(dt);                 // Effektzeit R.t, Partikel, Leuchtspuren, Strahlen, Lichtblitz
    T3.update(dt);                 // Decals, Wasserzeit, Erz-Glühen
    SH.uFowOn.value = S.settings.fogOff ? 0 : 1;
    if (iconQ.length) iconStep();      // v0.8: höchstens ein aufgeschobenes Symbol je Bild, VOR dem Szenenbild (kein Zusatz-Durchgang)
    if (pipe) { pipe.render(dt); mark('post'); } else renderer.render(scene, camera);
    drawOverlay(alpha);
    if (++miniFrame % 4 === 0) drawMinimap();
    frameMs = performance.now() - t0;
    fms += (Math.max(frameMs, ivl * 1000) - fms) * 0.05;
    if (pipe && F.dynRes) dynRes(frameMs, ivl);
    if (run) {   // Lauf-Merker: Partie gezeichnet / nach Absturz wieder stabil
      if (!run.play) { run.play = 1; saveRun(); }
      if (run.lost && !run.rec && ++recFrames > 60) { run.rec = 1; saveRun(); }
    }
  }
  var fms = 16;

  // ------------------------------------------------------------------ Szene füllen (Reihenfolge der Module)
  var selRing = null, selSquare = null, markRing = null;
  function ensureAux() {
    if (selRing) return;
    var Batch = M3.Batch, MAT = M3.MAT;
    var rg = new THREE.RingGeometry(0.82, 1, 28); rg.rotateX(-Math.PI / 2);
    selRing = new Batch(rg, MAT.ring, 32, false); selRing.mesh.renderOrder = 2; dynRoot.add(selRing.mesh);
    var sq = new THREE.RingGeometry(0.9, 1, 4, 1, Math.PI / 4); sq.rotateX(-Math.PI / 2);
    selSquare = new Batch(sq, MAT.ring, 4, false); selSquare.mesh.renderOrder = 2; dynRoot.add(selSquare.mesh);
    var mg = new THREE.RingGeometry(0.7, 1, 24); mg.rotateX(-Math.PI / 2);
    markRing = new Batch(mg, MAT.marker, 8, false); markRing.mesh.renderOrder = 3; dynRoot.add(markRing.mesh);
    R.selRing = selRing; R.selSquare = selSquare;
  }
  function fillFrame(S, alpha, dt) {
    var i, pid = V.pid;
    // Sichtbereich (grob, in Kacheln) für Effekt-Budget
    var bb = V.viewBounds ? V.viewBounds(100) : null;   // v0.7: Hüllrechteck des (gedrehten) Ausschnitts
    if (bb) { vb.x0 = bb.x0 / TILE; vb.z0 = bb.y0 / TILE; vb.x1 = bb.x1 / TILE; vb.z1 = bb.y1 / TILE; }
    else { var c0 = V.toWorld(-60, -60), c1 = V.toWorld(V.vw + 60, V.vh + 140); vb.x0 = c0.x / TILE; vb.z0 = c0.y / TILE; vb.x1 = c1.x / TILE; vb.z1 = c1.y / TILE; }
    var sel = V.mySel(), selSet = {};
    for (i = 0; i < sel.length; i++) selSet[sel[i].id] = 1;
    M3.fill(S, alpha, dt, selSet);       // Mauern, Gebäude (+ erinnerte), Einheiten, Bauhof-Aufbau, Wracks, Platzierungsvorschau
    F3.fill(S, alpha, dt);               // Projektile, Artillerie, Bodenringe, Superwaffen
    // --- Befehlsmarker
    var tnow = performance.now();
    for (i = V.markers.length - 1; i >= 0; i--) {
      var mk = V.markers[i], mf = (tnow - mk.t0) / 600;
      if (mf >= 1) { V.markers.splice(i, 1); continue; }
      var mx = mk.x / TILE, mz = mk.y / TILE, ms = 0.55 * (1 - mf) + 0.15, mc = 1 - mf;
      if (mk.kind === 'attack') markRing.put(mx, groundAt(mx, mz) + 0.05, mz, 0, ms, 1, ms, 1 * mc, 0.25 * mc, 0.2 * mc);
      else markRing.put(mx, groundAt(mx, mz) + 0.05, mz, 0, ms, 1, ms, 0.3 * mc, 1 * mc, 0.45 * mc);
    }
    T3.fill(S, dt, S.settings.fogOff, S.players[pid]);   // Funkeln auf Erz
    if (S3) S3.fill(S, alpha);           // W11-look: Boden-Schatten-Ersatz (nur ohne Schattenkarte, Flag liteLook)
    M3.flush(); F3.flush(); if (S3) S3.flush();
    selRing.flush(); selSquare.flush(); markRing.flush();
  }

  function retryGL() {
    try {
      createRenderer();
      if (!glOK) return;
      glFail = ''; glRetries = 0;
      resize();
      if (G.Sim.S) reset();
    } catch (e) { glOK = false; }
  }
  /** Manueller Neustart der Grafik (Knopf in der Meldung / im Menü). */
  function restartGL() { glRetries = 0; recoverTimes = []; glRetryT = 0; glOK = false; }
  function drawNoGL() {
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.fillStyle = '#0b0f14'; octx.fillRect(0, 0, cv.width, cv.height);
    octx.fillStyle = '#f4f7fb'; octx.font = '600 ' + Math.round(18 * dpr) + 'px system-ui, sans-serif'; octx.textAlign = 'center';
    var fs = Math.round(18 * dpr), lh = fs * 1.5, cx = cv.width / 2, cy = cv.height / 2;
    octx.fillText('3D-Grafik (WebGL) nicht verfügbar', cx, cy - lh * 1.5);
    octx.font = '400 ' + Math.round(16 * dpr) + 'px system-ui, sans-serif';
    octx.fillText((glFail || '') + ' [' + bufW + '×' + bufH + ', DPR ' + (window.devicePixelRatio || 1).toFixed(2) + ', ' + quality + ']', cx, cy - lh * 0.5);
    octx.fillText(glRetries < 5 ? 'Neuer Versuch läuft …' : 'Tippe hier für einen neuen Versuch.', cx, cy + lh * 0.5);
    octx.fillText('Hilft das nicht: Claude-App ganz schließen und neu öffnen.', cx, cy + lh * 1.5);
  }

  // ------------------------------------------------------------------ 2D-Überlagerung (scharf)
  function project(x, y, z, out) {
    tmpV2.set(x, y, z).project(camera);
    out.x = (tmpV2.x + 1) / 2 * V.vw; out.y = (1 - tmpV2.y) / 2 * V.vh;
    return out;
  }
  var pp = { x: 0, y: 0 }, pq = { x: 0, y: 0 };
  function hpBar(cx, cy, w, frac) {
    var h = 5, x = Math.round(cx - w / 2), y = Math.round(cy);
    octx.fillStyle = 'rgba(0,0,0,0.85)'; octx.fillRect(x - 1, y - 1, w + 2, h + 2);
    octx.fillStyle = frac > 0.6 ? '#22c55e' : (frac > 0.3 ? '#facc15' : '#ef4444');
    octx.fillRect(x, y, Math.max(1, Math.round(w * frac)), h);
  }
  /** Erfahrung: Rangabzeichen (1–3 Winkel). Mit Lebensbalken links daneben, sonst dezent über der Einheit; fl (0..1) = Aufblitzen nach Aufstieg. */
  function rankBadge(cx, cy, w, rank, bar, fl) {
    var s = 1.25 + 0.5 * fl, x = bar ? Math.round(cx - w / 2) - 8 : cx, y = bar ? cy + 2.5 : cy - 4, i,
        col = rank >= 3 ? '#ffd23f' : (rank === 2 ? '#fbbf24' : '#e5e7eb');
    if (fl > 0) { octx.beginPath(); octx.arc(x, y, 7 + 7 * fl, 0, 6.2832); octx.fillStyle = 'rgba(255,255,255,' + (0.55 * fl).toFixed(2) + ')'; octx.fill(); }
    octx.save(); octx.globalAlpha = bar || fl > 0 ? 1 : 0.8; octx.lineCap = 'round'; octx.lineJoin = 'round';
    for (var pass = 0; pass < 2; pass++) {
      octx.lineWidth = pass ? 2 : 4.2; octx.strokeStyle = pass ? col : 'rgba(0,0,0,0.85)';
      for (i = 0; i < rank; i++) {
        var yy = y + (i - (rank - 1) / 2) * 3.6 * s;
        octx.beginPath(); octx.moveTo(x - 4.5 * s, yy + 2 * s); octx.lineTo(x, yy - 1.6 * s); octx.lineTo(x + 4.5 * s, yy + 2 * s); octx.stroke();
      }
    }
    octx.restore();
  }
  var ovP = { x: 0, y: 0 }, ovQ = { x: 0, y: 0 };
  function groundArc(cx, cy, rx, ry, a0, a1) { octx.beginPath(); octx.ellipse(cx, cy, rx, ry, 0, a0, a1); octx.stroke(); }
  /** Eroberungsring (capT in capBy-Farbe), Artillerie-Ladering, Besatzungs-Pips (gar.length / cap) als scharfe 2D-Überlagerung. */
  function neutralOverlay(e, S, pid, fogOff) {
    var bx = e.x / TILE, bz = e.y / TILE, vis = fogOff || e.owner === pid || G.Sim.isVisible(pid, e), bd = NEUT[e.type];
    project(bx, 0.06, bz, ovP);
    if (ovP.x < -150 || ovP.y < -150 || ovP.x > V.vw + 150 || ovP.y > V.vh + 150) return;
    var rr = Math.max(e.w || bd.w, e.h || bd.h) / 2 + 0.35, a0 = -Math.PI / 2, i;
    var kx = TILE * V.ppx(), ky = TILE * V.ppy();   // v0.7: Bodenkreis → Ellipse mit Bildschirmachsen (unabhängig von YAW)
    if (vis && e.capT > 0 && e.capT < 1 && e.capBy >= 0 && S.players[e.capBy]) {
      octx.lineCap = 'butt';
      octx.strokeStyle = 'rgba(0,0,0,0.7)'; octx.lineWidth = 11; groundArc(ovP.x, ovP.y, rr * kx, rr * ky, 0, 6.2832);
      octx.strokeStyle = 'rgba(255,255,255,0.25)'; octx.lineWidth = 7; groundArc(ovP.x, ovP.y, rr * kx, rr * ky, 0, 6.2832);
      octx.strokeStyle = S.players[e.capBy].color; octx.lineWidth = 7; groundArc(ovP.x, ovP.y, rr * kx, rr * ky, a0, a0 + 6.2832 * e.capT);
    }
    if (e.type === 'artillery' && e.owner >= 0 && vis && S.players[e.owner]) {
      var ch = e.charge || 0, rc = rr + 0.25, col = S.players[e.owner].color;
      octx.lineCap = 'butt';
      if (ch < 1) {
        octx.strokeStyle = 'rgba(0,0,0,0.65)'; octx.lineWidth = 8; groundArc(ovP.x, ovP.y, rc * kx, rc * ky, 0, 6.2832);
        octx.strokeStyle = 'rgba(255,255,255,0.18)'; octx.lineWidth = 4; groundArc(ovP.x, ovP.y, rc * kx, rc * ky, 0, 6.2832);
        octx.strokeStyle = col; octx.lineWidth = 4; groundArc(ovP.x, ovP.y, rc * kx, rc * ky, a0, a0 + 6.2832 * ch);
      } else {
        var pl = 0.6 + 0.4 * Math.sin(performance.now() / 160);
        octx.strokeStyle = 'rgba(0,0,0,0.7)'; octx.lineWidth = 9; groundArc(ovP.x, ovP.y, rc * kx, rc * ky, 0, 6.2832);
        octx.globalAlpha = pl; octx.strokeStyle = '#ffffff'; octx.lineWidth = 6; groundArc(ovP.x, ovP.y, rc * kx, rc * ky, 0, 6.2832);
        octx.strokeStyle = col; octx.lineWidth = 3; groundArc(ovP.x, ovP.y, rc * kx, rc * ky, 0, 6.2832); octx.globalAlpha = 1;
      }
    }
    if (GARR[e.type]) {
      var cap = e.cap || (e.type === 'house' ? 3 : (e.type === 'block' ? 5 : 4)), n = e.gar ? e.gar.length : 0, owned = e.owner >= 0 && S.players[e.owner];
      if (owned && !vis) return;
      project(bx, (BH[e.type] || 1) + 0.55, bz, ovP);
      var rp = clamp(4.5 + V.cam.zoom * 2.5, 6, 9) * (owned ? 1 : 0.7), sp = rp * 2 + 5, x0 = ovP.x - (cap - 1) * sp / 2;
      for (i = 0; i < cap; i++) {
        var px = x0 + i * sp, filled = i < n && owned;
        if (!owned && !(V.cam.zoom >= 0.8)) break;
        octx.beginPath(); octx.arc(px, ovP.y, owned ? rp + 2 : rp + 1, 0, 6.2832); octx.fillStyle = owned ? 'rgba(0,0,0,0.85)' : 'rgba(0,0,0,0.4)'; octx.fill();
        octx.beginPath(); octx.arc(px, ovP.y, rp, 0, 6.2832);
        if (filled) { octx.fillStyle = S.players[e.owner].color; octx.fill(); octx.lineWidth = 2; octx.strokeStyle = '#ffffff'; octx.stroke(); }
        else { octx.fillStyle = owned ? 'rgba(20,24,30,0.9)' : 'rgba(20,24,30,0.15)'; octx.fill(); octx.lineWidth = owned ? 2 : 1.5; octx.strokeStyle = owned ? S.players[e.owner].color : 'rgba(255,255,255,0.75)'; octx.stroke(); }
      }
    }
  }
  /** Besatzungs-Pips eines gebauten Bunkers (pbunker): gefüllt = Insasse in Spielerfarbe. */
  function bunkerPips(e, S) {
    var cap = e.cap || 4, n = e.gar ? e.gar.length : 0, col = S.players[e.owner].color, i;
    project(e.x / TILE, (BH[e.type] || 0.62) + 0.6, e.y / TILE, ovP);
    if (ovP.x < -60 || ovP.y < -60 || ovP.x > V.vw + 60 || ovP.y > V.vh + 60) return;
    var rp = clamp(4.5 + V.cam.zoom * 2.5, 6, 9), sp = rp * 2 + 5, x0 = ovP.x - (cap - 1) * sp / 2;
    for (i = 0; i < cap; i++) {
      var px = x0 + i * sp;
      octx.beginPath(); octx.arc(px, ovP.y, rp + 2, 0, 6.2832); octx.fillStyle = 'rgba(0,0,0,0.85)'; octx.fill();
      octx.beginPath(); octx.arc(px, ovP.y, rp, 0, 6.2832);
      if (i < n) { octx.fillStyle = col; octx.fill(); octx.lineWidth = 2; octx.strokeStyle = '#ffffff'; octx.stroke(); }
      else { octx.fillStyle = 'rgba(20,24,30,0.9)'; octx.fill(); octx.lineWidth = 2; octx.strokeStyle = col; octx.stroke(); }
    }
  }
  /** v0.7: Besatzungs-Pips eines Schützenpanzers (e.gar / e.cap, Standard 5) knapp über dem Lebensbalken. */
  function apcPips(e, S, alpha) {
    var cap = e.cap || 5, n = e.gar.length, col = S.players[e.owner].color, i;
    var ux = (e.px + (e.x - e.px) * alpha) / TILE, uz = (e.py + (e.y - e.py) * alpha) / TILE, M = unitModelOf(e), s = SCALE[e.type] || 1;
    project(ux, groundAt(ux, uz) + M.h * s + 0.12 + airH(e), uz, ovP);
    if (ovP.x < -60 || ovP.y < -60 || ovP.x > V.vw + 60 || ovP.y > V.vh + 60) return;
    var rp = clamp(3 + V.cam.zoom * 1.6, 4, 6), sp = rp * 2 + 3, x0 = ovP.x - (cap - 1) * sp / 2, y = ovP.y - 18;
    for (i = 0; i < cap; i++) {
      var px = x0 + i * sp;
      octx.beginPath(); octx.arc(px, y, rp + 1.5, 0, 6.2832); octx.fillStyle = 'rgba(0,0,0,0.85)'; octx.fill();
      octx.beginPath(); octx.arc(px, y, rp, 0, 6.2832);
      if (i < n) { octx.fillStyle = col; octx.fill(); octx.lineWidth = 1.5; octx.strokeStyle = '#ffffff'; octx.stroke(); }
      else { octx.fillStyle = 'rgba(20,24,30,0.9)'; octx.fill(); octx.lineWidth = 1.5; octx.strokeStyle = col; octx.stroke(); }
    }
  }
  function drawOverlay(alpha) {
    var S = G.Sim.S, pid = V.pid, fogOff = S.settings.fogOff, ents = S.ents, i, e;
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    octx.clearRect(0, 0, V.vw, V.vh);
    var z = V.cam.zoom, sel = V.mySel(), selSet = {};
    for (i = 0; i < sel.length; i++) selSet[sel[i].id] = 1;
    // Sammelpunkt
    if (sel.length === 1 && sel[0].kind === 'building' && sel[0].rx >= 0) {
      var b = sel[0];
      project(b.x / TILE, 0.1, b.y / TILE, pp); project(b.rx / TILE, groundAt(b.rx / TILE, b.ry / TILE), b.ry / TILE, pq);
      octx.strokeStyle = 'rgba(255,255,255,0.8)'; octx.lineWidth = 2; octx.setLineDash([6, 6]);
      octx.beginPath(); octx.moveTo(pp.x, pp.y); octx.lineTo(pq.x, pq.y); octx.stroke(); octx.setLineDash([]);
      octx.fillStyle = '#111'; octx.fillRect(pq.x - 2, pq.y - 24, 4, 25);
      octx.fillStyle = '#fbbf24'; octx.beginPath(); octx.moveTo(pq.x + 2, pq.y - 24); octx.lineTo(pq.x + 18, pq.y - 18); octx.lineTo(pq.x + 2, pq.y - 12); octx.fill();
    }
    // Neutrale Gebäude: Eroberungsring, Artillerie-Ladering, Besatzungs-Pips
    for (i = 0; i < ents.length; i++) {
      e = ents[i];
      if (e.dead || e.kind !== 'building' || !NEUT[e.type] || e.ruin) continue;
      if (neutralShown(e, S.players[pid], fogOff)) neutralOverlay(e, S, pid, fogOff);
    }
    for (i = 0; i < ents.length; i++) {      // Gebaute Bunker: Besatzungs-Pips
      e = ents[i];
      if (e.dead || e.kind !== 'building' || e.type !== 'pbunker' || !e.gar) continue;
      if (e.owner === pid || fogOff || G.Sim.isVisible(pid, e)) bunkerPips(e, S);
    }
    swChargeOverlay(S, pid, fogOff);
    // v0.7: Schützenpanzer – Passagier-Pips über eigenen Transportern (gewählt oder besetzt)
    for (i = 0; i < ents.length; i++) {
      e = ents[i];
      if (e.dead || e.inside || e.kind !== 'unit' || e.owner !== pid || !e.gar || !(e.cap > 0 || e.type === 'apc')) continue;
      if (!e.gar.length && !selSet[e.id]) continue;
      apcPips(e, S, alpha);
    }
    // Lebensbalken: ausgewählte oder beschädigte
    for (i = 0; i < ents.length; i++) {
      e = ents[i];
      var noBar = e.hp >= e.maxHp && !selSet[e.id];   // Erfahrung: Rangabzeichen auch ohne Lebensbalken
      if (e.dead || e.inside || e.ruin || !(e.maxHp > 0) || (noBar && !(e.rk > 0))) continue;
      if (e.owner !== pid && !fogOff && !G.Sim.isVisible(pid, e)) continue;
      if (e.kind === 'unit') {
        var ux = (e.px + (e.x - e.px) * alpha) / TILE, uz = (e.py + (e.y - e.py) * alpha) / TILE;
        var M = unitModelOf(e), s = SCALE[e.type] || 1;
        project(ux, groundAt(ux, uz) + M.h * s + 0.12 + airH(e), uz, pp);
        if (pp.x < -40 || pp.y < -20 || pp.x > V.vw + 40 || pp.y > V.vh + 20) continue;
        var bw0 = Math.round(clamp(e.r * 2 * V.ppx() * 0.95, 20, 44));
        if (!noBar) hpBar(pp.x, pp.y - 6, bw0, e.hp / e.maxHp);
        if (e.rk > 0) rankBadge(pp.x, pp.y - 6, bw0, e.rk, !noBar, Math.max(0, 1 - (S.tick - (e.rankT || -999)) / G.DATA.EXP.flashT));
      } else {
        var bx = e.x / TILE, bz = e.y / TILE;
        // Oberkante des Gebäudes in Bildschirm-oben-Richtung (v0.7: FWD statt fest Norden)
        var hr = Math.max(0, (Math.abs(R.FWD[0]) * e.w + Math.abs(R.FWD[1]) * e.h) / 2 - 0.3);
        project(bx + R.FWD[0] * hr, (BH[e.type] || 1) + 0.15, bz + R.FWD[1] * hr, pp);
        if (pp.x < -100 || pp.y < -20 || pp.x > V.vw + 100 || pp.y > V.vh + 20) continue;
        hpBar(pp.x, pp.y - 8, Math.round(e.w * TILE * V.ppx() * 0.75), e.hp / e.maxHp);
      }
    }
    void z;
    F3.overlay(S, alpha);
    if (V.box) {
      octx.strokeStyle = '#4ade80'; octx.lineWidth = 2; octx.setLineDash([6, 4]);
      var bx0 = Math.min(V.box.x0, V.box.x1), by0 = Math.min(V.box.y0, V.box.y1), bw = Math.abs(V.box.x1 - V.box.x0), bh = Math.abs(V.box.y1 - V.box.y0);
      octx.strokeRect(bx0, by0, bw, bh); octx.setLineDash([]);
      octx.fillStyle = 'rgba(74,222,128,0.12)'; octx.fillRect(bx0, by0, bw, bh);
    }
    if (V.amArmed) { octx.strokeStyle = '#f87171'; octx.lineWidth = 4; octx.strokeRect(2, 2, V.vw - 4, V.vh - 4); }
  }

  // ------------------------------------------------------------------ Picking
  /** Entität unter Bildschirmpunkt (CSS-px des Karten-Canvas): Einheiten per Projektion, Gebäude per Strahl gegen Quader. */
  /** v0.8: Flughöhe (Kacheln) eines Luftfahrzeugs, sonst 0. */
  function airH(e) { return e.mc === 2 ? (e.alt || 0) * D.AIR_H : 0; }
  function pickAt(sx, sy, slack) {
    var S = G.Sim.S;
    if (!S || !glOK || !world) return null;
    updateCamera();
    var pid = V.pid, fogOff = S.settings.fogOff, best = null, bestD = 1e9, i, e;
    for (i = 0; i < S.ents.length; i++) {
      e = S.ents[i];
      if (e.dead || e.kind !== 'unit' || e.inside) continue;
      if (e.owner !== pid && !fogOff && !G.Sim.isVisible(pid, e)) continue;
      var ux = e.x / TILE, uz = e.y / TILE, M = unitModelOf(e), s = SCALE[e.type] || 1;
      project(ux, groundAt(ux, uz) + M.h * s * 0.45 + airH(e), uz, pp);   // v0.8: Luftfahrzeuge in Flughöhe
      var rad = Math.max(e.r * V.ppx(), INF[e.type] ? 9 : 12);
      var d = Math.hypot(pp.x - sx, pp.y - sy) - rad;
      if (d <= (slack || 6) && d < bestD) { best = e; bestD = d; }
    }
    if (best) return best;
    ndc.set(sx / V.vw * 2 - 1, 1 - sy / V.vh * 2);
    ray.setFromCamera(ndc, camera);
    var bestT = 1e9;
    for (i = 0; i < S.ents.length; i++) {
      e = S.ents[i];
      if (e.dead || e.kind !== 'building') continue;
      if (NEUT[e.type]) { if (e.ruin || !neutralShown(e, S.players[pid], fogOff)) continue; }
      else if (e.owner !== pid && !fogOff && !G.Sim.isVisible(pid, e)) continue;
      box3.min.set(e.tx, 0, e.ty); box3.max.set(e.tx + e.w, (BH[e.type] || 1) * 0.85, e.ty + e.h);
      var hit = ray.ray.intersectBox(box3, tmpV);
      if (hit) { var t = hit.distanceTo(ray.ray.origin); if (t < bestT) { bestT = t; best = e; } }
    }
    return best;
  }

  // ------------------------------------------------------------------ Minimap
  var TCOLM = { grass: [70, 112, 50], sand: [180, 158, 106], rock: [110, 106, 100], water: [36, 90, 140], trees: [36, 72, 32], road: [96, 94, 88], bridge: [130, 96, 60] };
  var miniBase = null;
  function buildMiniBase(m) {
    var c = document.createElement('canvas'); c.width = m.w * 2; c.height = m.h * 2;
    var g = c.getContext('2d'), img = g.createImageData(c.width, c.height);
    for (var y = 0; y < c.height; y++) for (var x = 0; x < c.width; x++) {
      var tx = x >> 1, ty = y >> 1, col = TCOLM[D.TERRAIN[m.terrain[ty * m.w + tx]].id], v = (hash(x, y, 9) - 0.5) * 14, o = (y * c.width + x) * 4;
      img.data[o] = col[0] + v; img.data[o + 1] = col[1] + v; img.data[o + 2] = col[2] + v; img.data[o + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    miniBase = c;
  }
  var mOutC = {};
  /** v1.0: Randfarbe der Minimap-Punkte – heller Rand für dunkle Farben (relative Helligkeit < 0,12), sonst dunkler. */
  function miniOutline(col) {
    var r = mOutC[col]; if (r) return r;
    var c = String(col).replace('#', ''), v = [0, 2, 4].map(function (k) { var x = parseInt(c.substr(k, 2), 16) / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
    var L = 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
    return (mOutC[col] = L < 0.12 ? '#e0e7ff' : '#0b0f14');
  }
  function drawMinimap() {
    var S = G.Sim.S, m = S.map, W = mini.width, H = mini.height;
    var sx = W / m.w, sy = H / m.h, i;
    mctx.setTransform(1, 0, 0, 1, 0, 0);
    mctx.imageSmoothingEnabled = true;
    mctx.drawImage(miniBase, 0, 0, W, H);
    mctx.fillStyle = '#f2c14e';
    for (i = 0; i < world.oreIdx.length; i++) {
      var ti = world.oreIdx[i];
      if (m.ore[ti] > 0) mctx.fillRect((ti % m.w) * sx + sx * 0.15, Math.floor(ti / m.w) * sy + sy * 0.15, sx * 0.7, sy * 0.7);
    }
    var pid = V.pid, fogOff = S.settings.fogOff, P = S.players[pid];
    if (!fogOff) for (var id in P.mem) {
      var mm = P.mem[id]; if (NEUT[mm.type]) continue; mctx.fillStyle = '#111'; mctx.fillRect(mm.tx * sx - 1, mm.ty * sy - 1, mm.w * sx + 2, mm.h * sy + 2);
      mctx.fillStyle = S.players[mm.owner].color; mctx.fillRect(mm.tx * sx, mm.ty * sy, mm.w * sx, mm.h * sy);
    }
    var ds = Math.max(3, 2.2 * dpr);
    for (i = 0; i < S.ents.length; i++) {
      var e = S.ents[i];
      if (e.dead || e.inside) continue;
      if (e.kind === 'building' && NEUT[e.type]) { // neutrale Gebäude: beige, im Besitz in Teamfarbe; Spezialgebäude mit hellem Kern
        if (!neutralShown(e, P, fogOff)) continue;
        var nowner = e.owner >= 0 ? S.players[e.owner] : null, nvis = fogOff || e.owner === pid || G.Sim.isVisible(pid, e);
        if (e.ruin) { mctx.fillStyle = '#2b2824'; mctx.fillRect(e.tx * sx, e.ty * sy, e.w * sx, e.h * sy); continue; }
        mctx.fillStyle = '#0b0f14'; mctx.fillRect(e.tx * sx - 1.5, e.ty * sy - 1.5, e.w * sx + 3, e.h * sy + 3);
        mctx.fillStyle = nowner && nvis ? nowner.color : '#d9d2bd'; mctx.fillRect(e.tx * sx, e.ty * sy, e.w * sx, e.h * sy);
        if (!GARR[e.type]) { mctx.fillStyle = '#0b0f14'; mctx.fillRect(e.tx * sx + e.w * sx * 0.3, e.ty * sy + e.h * sy * 0.3, e.w * sx * 0.4, e.h * sy * 0.4); }
        continue;
      }
      if (e.owner !== pid && !fogOff && !G.Sim.isVisible(pid, e)) continue;
      var col = S.players[e.owner].color, mol = miniOutline(col);   // v1.0: dunkle Teamfarben (Kollektiv) mit hellem Rand – auf Wasser/dunklem Boden lesbar
      if (e.kind === 'building') {
        mctx.fillStyle = mol; mctx.fillRect(e.tx * sx - 1, e.ty * sy - 1, e.w * sx + 2, e.h * sy + 2);
        mctx.fillStyle = col; mctx.fillRect(e.tx * sx, e.ty * sy, e.w * sx, e.h * sy);
      } else {
        var ux = e.x / TILE * sx, uy = e.y / TILE * sy;
        mctx.fillStyle = mol; mctx.fillRect(ux - ds / 2 - 1, uy - ds / 2 - 1, ds + 2, ds + 2);
        mctx.fillStyle = col; mctx.fillRect(ux - ds / 2, uy - ds / 2, ds, ds);
      }
    }
    if (!fogOff) { mctx.imageSmoothingEnabled = true; mctx.drawImage(fog.cv, 0, 0, W, H); }
    // Radar: gegnerische Einheiten auch im Nebel als pulsierende Blips (nach dem Nebel gezeichnet)
    if (P.radar && !fogOff) {
      var rpul = 0.5 + 0.5 * Math.sin(performance.now() / 260), rs2 = ds + 1 + rpul;
      for (i = 0; i < S.ents.length; i++) {
        var re = S.ents[i];
        if (re.dead || re.inside || re.kind !== 'unit' || re.owner === pid || G.Sim.isVisible(pid, re)) continue;
        var rux = re.x / TILE * sx, ruy = re.y / TILE * sy;
        mctx.fillStyle = '#ffffff'; mctx.fillRect(rux - rs2 / 2 - 1, ruy - rs2 / 2 - 1, rs2 + 2, rs2 + 2);
        mctx.fillStyle = S.players[re.owner].color; mctx.fillRect(rux - rs2 / 2, ruy - rs2 / 2, rs2, rs2);
      }
    }
    // Kamera-Ausschnitt: projizierte Bildecken auf dem Boden
    var a = V.toWorld(0, 0), b = V.toWorld(V.vw, 0), c = V.toWorld(V.vw, V.vh), d = V.toWorld(0, V.vh);
    mctx.strokeStyle = '#ffffff'; mctx.lineWidth = Math.max(1.5, dpr * 1.2);
    mctx.beginPath();
    mctx.moveTo(a.x / TILE * sx, a.y / TILE * sy); mctx.lineTo(b.x / TILE * sx, b.y / TILE * sy);
    mctx.lineTo(c.x / TILE * sx, c.y / TILE * sy); mctx.lineTo(d.x / TILE * sx, d.y / TILE * sy); mctx.closePath();
    mctx.stroke();
  }
  function miniToWorld(mx, my) {
    var S = G.Sim.S, r = mini.getBoundingClientRect();
    return { x: mx / r.width * S.map.w * TILE, y: my / r.height * S.map.h * TILE };
  }

  // ------------------------------------------------------------------ Symbole (Seitenleiste)
  var iconCache = {}, iconR = null, iconScene = null, iconCam = null;
  /** Zeichnet ein Symbol für type in ein Rechteck 0,0,w,h (3D-Aufnahme des Modells, gecacht). */
  function drawIcon(c, type, color, w, h) {
    // v0.8: Flag icons3d aus → 2D-Symbole (render2d, reine Canvas-Zeichnung, kein WebGL-Auslesen)
    if (!F.icons3d && G.Render2D && G.Render2D.drawIcon) { G.Render2D.drawIcon(c, type, color, w, h); return; }
    var key = type + '|' + color + '|' + w + 'x' + h + (R.std ? '|s' : ''), img = iconCache[key];
    if (!img && F.fixedBuf) {
      // v0.8 PowerVR: Symbol aufschieben – erst 2D-Platzhalter, das 3D-Bild entsteht im nächsten draw() vor dem Szenenbild
      // (kein zweiter Szenendurchgang, nicht mehrere Auslesungen in einem Bild); danach wird jedes angemeldete Ziel neu bemalt.
      var qd = null;
      for (var qi = 0; qi < iconQ.length; qi++) if (iconQ[qi].key === key) { qd = iconQ[qi]; break; }
      if (!qd) iconQ.push(qd = { key: key, type: type, color: color, w: w, h: h, t: [] });
      if (qd.t.indexOf(c) < 0) qd.t.push(c);
      if (G.Render2D && G.Render2D.drawIcon) G.Render2D.drawIcon(c, type, color, w, h);
      return;
    }
    if (!img) img = iconCache[key] = renderIcon(type, color, w, h);
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, w, h);
    if (img) c.drawImage(img, 0, 0, w, h);
    c.restore();
  }
  // Zweiten WebGL-Kontext nicht dauerhaft halten – auf Handys kann er den Hauptkontext verdrängen
  var iconFreeT = 0;
  function scheduleIconFree() {
    clearTimeout(iconFreeT);
    iconFreeT = setTimeout(function () {
      if (!iconR) return;
      try { iconR.dispose(); iconR.forceContextLoss(); } catch (e) { /* egal */ }
      iconR = null; iconScene = null; iconCam = null;
    }, 400);
  }
  var iconQ = [];
  function iconStep() {
    var q = iconQ.shift();
    if (!q || iconCache[q.key]) return;
    var img = iconCache[q.key] = renderIcon(q.type, q.color, q.w, q.h, true);
    if (!img) return;
    for (var i = 0; i < q.t.length; i++) {
      var c = q.t[i];
      if (!c.canvas || !c.canvas.isConnected) continue;
      c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, q.w, q.h); c.drawImage(img, 0, 0, q.w, q.h); c.restore();
    }
  }
  function renderIcon(type, color, w, h, deferred) {
    if (!THREE || !SH) return null;
    var SS = 2, cw = w * SS, ch = h * SS;
    try {
      // Kein zweiter WebGL-Kontext mehr (manche Android-WebViews vertragen nur einen):
      // Symbol wird mit dem Haupt-Renderer in eine Ecke des Zeichenpuffers gerendert und sofort abgegriffen.
      if (!renderer || !glOK || glLost) return null;
      var sc0 = Math.min(1, bufW / cw, bufH / ch);
      cw = Math.max(8, Math.floor(cw * sc0)); ch = Math.max(8, Math.floor(ch * sc0));
      if (!iconScene) {
        iconScene = new THREE.Scene();
        iconScene.add(new THREE.HemisphereLight('#e6efff', '#4a4a3a', 1.6));
        var dl = new THREE.DirectionalLight('#fff3dc', 2.6); dl.position.set(-2, 4, 3); iconScene.add(dl);
        iconCam = new THREE.PerspectiveCamera(26, w / h, 0.1, 50);
      }
      var M = model(type, facOfColor(color), color), grp = new THREE.Group(), tintMat = null;
      for (var k in M.parts) {
        if (k === 'cargo' || (M.iconOnly && k !== M.iconOnly)) continue;
        var mesh = new THREE.Mesh(M.parts[k], (k === 'trim' || k === 'lamp') ? (tintMat || (tintMat = M3.material('tint', { color: color }))) : MAT.std);
        if (k === 'radar') mesh.position.set(M.radarAt[0], M.radarAt[1], M.radarAt[2]);
        if ((k === 'turret' || k === 'barrel' || k === 'barrel2' || k === 'tglow') && M.pivot) mesh.position.set(M.pivot[0], 0, M.pivot[1]);
        if (M.at && M.at[k]) mesh.position.set(M.at[k][0], M.at[k][1], M.at[k][2]);
        if ((M.neutral || M.how) && k === 'barrel') mesh.rotation.z = M.rest;
        if (M.dread && (k === 'barrel' || k === 'mslA' || k === 'mslB')) { mesh.position.set(M.pivot[0] + M.trun[0], M.trun[1], M.pivot[1]); mesh.rotation.z = 0.4; }   // v0.9 Schlachtschiff: Schienen halb erhoben
        grp.add(mesh);
      }
      if (M.xp) for (var xi = 0; xi < M.xp.length; xi++) {
        var xe = M.xp[xi], xm = new THREE.Mesh(M.xparts[xe.p], xe.p === 'cell' ? (tintMat || (tintMat = M3.material('tint', { color: color }))) : MAT.std);
        xm.position.set(xe.x, xe.y, xe.z); if (xe.k === 'dish') xm.rotation.z = -0.5; grp.add(xm);
      }
      if (M.iconAdd) M.iconAdd(grp, MAT.std);
      // W11: Gebäude sind an x gespiegelt (Fronten nach Süd + WEST) → um 90° weiter gedreht: links die Westseite, rechts die Südseite
      // wie in der Spielkamera; Kamera und Licht des Symbols bleiben gleich
      grp.rotation.y = isBld(type) ? (type === 'wall' ? -0.5 : -0.5 + Math.PI / 2) : 0.65;
      iconScene.environment = R.std ? R.env : null;
      iconScene.add(grp);
      var bb = new THREE.Box3().setFromObject(grp), size = bb.getSize(new THREE.Vector3()), ctr = bb.getCenter(new THREE.Vector3());
      var rad = size.length() / 2;
      var dist = rad / Math.sin(THREE.MathUtils.degToRad(13)) * (isBld(type) ? 0.74 : 0.6);
      iconCam.aspect = w / h; iconCam.updateProjectionMatrix();
      iconCam.position.set(ctr.x + dist * 0.42, ctr.y + dist * 0.62, ctr.z + dist * 0.66);
      iconCam.lookAt(ctr);
      var fo = SH.uFowOn.value; SH.uFowOn.value = 0; SH.uEdge.value.set(0, 1);
      var KEY = 0xff00ff, oldCol = new THREE.Color(), oldA = renderer.getClearAlpha(), oldExp = renderer.toneMappingExposure;
      renderer.getClearColor(oldCol);
      var oldBg = iconScene.background; iconScene.background = new THREE.Color(KEY);
      renderer.setRenderTarget(null);
      renderer.setViewport(0, 0, cw, ch); renderer.setScissor(0, 0, cw, ch); renderer.setScissorTest(true);
      var oldTM = renderer.toneMapping; if (Q.std) renderer.toneMapping = MODERN_LOOK.tone;
      renderer.toneMappingExposure = Q.std ? 1.05 : 1.15;
      var oldSh = renderer.shadowMap.enabled; renderer.shadowMap.enabled = false;
      renderer.render(iconScene, iconCam);
      SH.uFowOn.value = fo; SH.uEdge.value.set(EDGE_DIM[0], EDGE_DIM[1]);
      iconScene.remove(grp);
      if (tintMat) tintMat.dispose();
      var out = document.createElement('canvas'); out.width = w; out.height = h;
      var og = out.getContext('2d'); og.imageSmoothingQuality = 'high';
      og.drawImage(glCv, 0, bufH - ch, cw, ch, 0, 0, w, h);
      // Puffer wiederherstellen und die Szene sofort neu zeichnen (sonst blitzt das Symbol in der Ecke auf)
      renderer.shadowMap.enabled = oldSh; renderer.toneMappingExposure = oldExp; renderer.toneMapping = oldTM;
      renderer.setScissorTest(false); renderer.setViewport(0, 0, bufW, bufH);
      renderer.setClearColor(oldCol, oldA); iconScene.background = oldBg;
      if (world && camera && !deferred) { try { if (pipe) pipe.render(0); else renderer.render(scene, camera); } catch (e) { /* egal */ } }
      mark('icons3d');
      // Schlüsselfarbe (Magenta) transparent machen, Ränder weich auslaufen lassen
      var id = og.getImageData(0, 0, w, h), px = id.data;
      for (var q = 0; q < px.length; q += 4) {
        var r0 = px[q], g0 = px[q + 1], b0 = px[q + 2];
        var mag = Math.min(r0, b0) - g0; // wie „magentahaltig“ ist das Pixel?
        if (mag > 150) px[q + 3] = 0;
        else if (mag > 60) { var a = 1 - (mag - 60) / 90; px[q + 3] = Math.round(255 * a); px[q] = Math.min(255, r0 - (mag - 60) * 0.6); px[q + 2] = Math.min(255, b0 - (mag - 60) * 0.6); }
      }
      og.putImageData(id, 0, 0);
      return out;
    } catch (e) {
      console.warn('Symbol nicht gerendert: ' + e);
      return null;
    }
  }

  function info() {
    var r = renderer ? renderer.info.render : { calls: 0, triangles: 0, points: 0, lines: 0 };
    if (pipe) r = { calls: pipe.calls + (pipe.ink ? 1 : 9), triangles: pipe.tris, points: r.points, lines: r.lines };   // + Nachbearbeitungs-Durchgänge
    return { calls: r.calls, triangles: r.triangles, points: r.points, lines: r.lines, ms: frameMs, quality: quality, buf: [bufW, bufH],
      particles: F3 ? F3.particleCount() : 0, lite: !!Q.lite, scale: dyn.scale, pipe: pipe ? pipe.info() : null, flags: toCode(F), safe: safeGPU };
  }

  // ------------------------------------------------------------------ v0.8: Flags in der Sitzung wechseln (ohne neuen WebGL-Kontext)
  /** Flags neu bestimmen (Profil/Grafik-Test/Override) und anwenden: Schatten, Umgebung, Nachbearbeitung, Puffer, Materialklasse, Welt.
   *  Legt KEINEN neuen Renderer an (jeder neue Kontext erhöht auf Handys das Risiko der „blocked“-Sperre). */
  function refreshFlags() {
    if (!renderer || !glOK || glLost) { F = computeFlags(); R.F = F; return false; }
    var oldStd = R.std, oldInk = R.ink;
    F = computeFlags(); Q = pickQ(); F3.setMax(Q.particles);
    renderer.shadowMap.enabled = !!Q.shadows; sun.castShadow = !!Q.shadows;
    if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    if (Q.shadows) sun.shadow.mapSize.set(Q.shadowSize, Q.shadowSize);
    if (glCv) glCv.style.imageRendering = Q.mode === 'pixel' ? 'pixelated' : '';
    if (!F.dynRes) dyn.scale = 1;
    syncCtx(); applyLook();
    if (oldStd !== R.std || oldInk !== R.ink) M3.makeMaterials();
    iconCache = {}; iconQ.length = 0;
    scene.traverse(function (o) { var m = o.material; if (!m) return; (Array.isArray(m) ? m : [m]).forEach(function (x) { x.needsUpdate = true; }); });
    sizeKey = ''; resize();
    activeSince = {}; if (run) { run.act = ''; saveRun(); }
    if (G.Sim.S && world) reset();
    if (G.UI && G.UI.onGfxChange) { try { G.UI.onGfxChange(); } catch (e) { /* egal */ } }
    return true;
  }
  /** „Grafik zurücksetzen“: Profil (alle GPUs), Selbstheilungs-Stufen, Grafik-Test und eine gespeicherte 2D/Spar-Wahl löschen → Modern. */
  function resetGfx() {
    try { localStorage.removeItem(PKEY); localStorage.setItem(QKEY, 'ink'); } catch (e) { /* egal */ }   // INK: Standard ist „Gezeichnet“
    flagOverride = null; run = null; sessionChecked = false;
    if (usingFallback || !THREE || !mapEl) { try { location.reload(); } catch (e) { /* egal */ } return; }
    sessionStart();
    setQuality('ink');
  }
  var GFX = G.Gfx3D = {
    FLAGS: FLAGS, LADDER: LADDER, FULL: FULL_CODE, POWERVR: POWERVR_CODE, KEY: PKEY,
    letter: function (k) { return FLET[k]; }, key: function (l) { return FKEY[l]; }, name: function (k) { return FNAME[k] || FNAME[FKEY[k]]; },
    code: function () { return toCode(F); }, flags: function () { return Object.assign({}, F); }, active: activeCode,
    pretty: function (code) { return (code || '').split('').join('-') || '–'; },
    gpu: function () { return { name: gpuName, safe: safeGPU, key: gpuKey() }; },
    profile: getProf, putProfile: putProf, refresh: refreshFlags, reset: resetGfx, ladderStep: ladderStep,
    stats: function () {
      var mem = renderer ? renderer.info.memory : { geometries: 0, textures: 0 };
      return Object.assign({ geometries: mem.geometries, textures: mem.textures, programs: renderer && renderer.info.programs ? renderer.info.programs.length : 0,
        buf: [bufW, bufH], ms: frameMs, avgMs: fms, glOK: glOK, lost: glLost, fallback: usingFallback, fail: glFail, quality: quality, mode: Q.mode, lite: !!Q.lite,
        shadowSize: Q.shadows ? Q.shadowSize : 0, env: !!envRT, pipe: !!pipe, run: run }, glCount);
    },
    glOK: function () { return glOK && !glLost; }, failText: function () { return glFail; }, isFallback: function () { return usingFallback; },
    _override: function (code) { flagOverride = code == null ? null : String(code); return refreshFlags(); }
  };
  void GFX;

  G.Render = {
    _fakeGPU: function (name) { fakeGPU = name || ''; sessionChecked = false; setQuality(quality); if (G.Sim.S && world) reset(); }, // v0.8: Test – GPU-Namen vortäuschen (z. B. 'PowerVR DXT-48-1536')
    _setFlags: function (code) { return G.Gfx3D._override(code); },   // v0.8: Test – Flags für diese Sitzung (Code wie 'MUS'; null = Profil)
    gfx: function () { return G.Gfx3D; },
    _glCreates: function () { return glCreates; }, gpu: function () { return { name: gpuName, safe: safeGPU }; }, _setSafe: function () { forceSafe = true; setQuality(quality); if (G.Sim.S) reset(); }, restartGL: restartGL, glOK: function () { return glOK; }, init: init, reset: reset, draw: draw, drawIcon: drawIcon, miniToWorld: miniToWorld, resize: resize,
    pickAt: pickAt, setQuality: setQuality, getQuality: function () { return quality; }, info: info,
    QUALITIES: [['ink', QUAL.ink.name], ['modern', QUAL.modern.name], ['pixel', QUAL.pixel.name], ['sharp', QUAL.sharp.name], ['low', QUAL.low.name]], // INK: Gezeichnet zuerst (Standard)
    setShake: function (on) { F3.setShake(on); }, getShake: function () { return F3.getShake() && !safeGPU; },
    _heightAt: function (x, z) { return T3.groundAt(x, z); }, _fxTime: function () { return R.t; },
    _debugPost: function (k) { if (pipe) pipe.fin.uniforms.uDbg.value = k || 0; }, // v0.6: 1 = AO-Puffer anzeigen
    _look: MODERN_LOOK, _ink: INK_LOOK, _inkApply: function () { if (renderer) { applyLook(); sizeKey = ''; resize(); } },   // INK: Test – Werte live abstimmen
    _setLite: function (on) { forceLite = on !== false; setQuality(quality); if (G.Sim.S && world) reset(); }, // v0.6: Test – Modern Lite erzwingen
    _setScale: function (k) { dyn.scale = clamp(k, 0.6, 1); dyn.lock = true; sizeKey = ''; resize(); }      // v0.6: Test – Render-Skalierung festsetzen
  };
})();
