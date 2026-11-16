/* FRONTLINIE – render2d.js  (2D-Canvas-Ausweichrenderer, "2D (sicher)")
 * G.Render2D: gleiche Schnittstelle wie render3d.js (G.Render). Wird von render3d.js automatisch eingesetzt (useFallback),
 * wenn WebGL nicht verfügbar / vom Browser gesperrt ist (z. B. PowerVR-Treiber: "Web page caused context loss and was blocked"),
 * oder wenn der Spieler im Menü "2D (sicher)" wählt. LIEST NUR Zustand, verändert nie die Simulation.
 *
 * Kamera: exakt dieselbe Abbildung wie in 3D. Jeden Frame (und in pickAt) wird die affine Bodenabbildung aus G.view.toScreen
 *   an drei Referenzpunkten abgelesen: Bildschirm = O + U·wx + V·wy. Vertrag (SPEC_v07 §3): Welt um G.view.YAW drehen, danach
 *   die gekippte Abbildung diag(ppx, ppy). Daraus: kx = |Zeile 1| = ppx, ky = |Zeile 2| = ppy, YAWA = Drehwinkel. Eine Weltkreis
 *   wird dadurch immer zur achsparallelen Ellipse (kx·r, ky·r); Fahrzeuge werden mit Winkel dir+YAWA gezeichnet.
 *   YAW = 0 → exakt das bisherige Verhalten (Gelände mit Bildkopie, Gebäude als Quader über der Grundfläche).
 *   YAW ≠ 0 → Gelände per Canvas-Transform gedreht, bäume/Felsen als aufrechte Sprites, Gebäude als aufrechter Quader über
 *   der gedrehten Grundfläche (Raute), Mauern aus gedrehten Pfeilern/Stegen. Aufrechtes bleibt aufrecht (nur Fußpunkt dreht).
 *   Der Boden wird einmal in einen Offscreen-Canvas (Weltkoordinaten, TS px je Kachel) gemalt und pro Frame nur transformiert.
 *
 * Schnittstelle: init, reset, draw, drawIcon, miniToWorld, resize, pickAt, setQuality/getQuality/QUALITIES, info, glOK, restartGL, _view (Test),
 *   gpu, _glCreates, _setSafe, _heightAt, _fxTime
 */
var G = (typeof G !== 'undefined') ? G : {};
(function () {
  'use strict';
  var D = G.DATA, TILE = D.TILE, V = null;
  var cv, ctx, mini, mctx, dpr = 1;
  var DPR_MPIX = 7e6, GROUND_MPIX = 12e6, BIG_MPIX = 8e6; // W11-look: Obergrenzen Zeichenfläche / Sprite-Boden (siehe resize, groundTS)
  var world = null, mapRef = null, fogTick = -1, miniFrame = 0, lastSeq = 0, lastT = 0, fxTime = 0, frameMs = 0;
  var kx = 1, ky = 1, cx0 = 0, cy0 = 0, HK = 0.574, zoomK = 1; // Kameraabbildung des aktuellen Frames, HK = cos(PITCH)
  // Affine Bodenabbildung des aktuellen Frames: X = MOX + MUA·wx + MVA·wy, Y = MOY + MUB·wx + MVB·wy (aus G.view.toScreen)
  var MOX = 0, MOY = 0, MUA = 1, MUB = 0, MVA = 0, MVB = 1, YAWA = 0, ROT = false, DX = 0, DY = 0;
  var tmpX = 0, tmpY = 0;
  var QKEY = 'frontlinie.gfx';

  var NEUT = {
    house: { w: 2, h: 2 }, block: { w: 3, h: 2 }, bunker: { w: 2, h: 2 }, oilrig: { w: 2, h: 2 },
    radar: { w: 2, h: 2 }, hospital: { w: 3, h: 2 }, workshop: { w: 3, h: 2 }, artillery: { w: 2, h: 2 }
  };
  var GARR = { house: 1, block: 1, bunker: 1, pbunker: 1 };
  // Gebäudehöhen in Kacheln (Bildschirmhöhe = h · TILE · ppx · cos(PITCH))
  var BHT = { hq: 1.1, power: 1.0, refinery: 0.9, barracks: 0.85, factory: 1.1, turret: 0.45, mg: 0.35,
    house: 1.0, block: 1.35, bunker: 0.5, oilrig: 0.5, radar: 0.85, hospital: 0.75, workshop: 0.95, artillery: 0.4,
    techcenter: 1.2, orbital: 1.0, silo: 0.7,
    wall: 0.6, pbunker: 0.8, laser: 1.3, tesla: 1.4, // v0.5
    airfield: 0.5, shipyard: 0.7, flak: 0.45,       // v0.8
    psitower: 1.5, psidome: 0.9 };                   // v1.0 Kollektiv (PLATZHALTER v1.0)
  var V8U = { transheli: 1, gunship: 1, bomber: 1, gunboat: 1, destroyer: 1, lander: 1 };   // v0.8 Luft-/Seeeinheiten (Sprites; Vektorformen in der geraden Kamera)
  var F_FLAK = 14, F_TRAIL = 15, rampT = {}, wreck8 = [];   // v0.8: Flak-Sprengwolke; Bugklappe offen seit (fxTime) je Landungsboot; Absturz/Untergang
  function isInf(t) { return t === 'rifle' || t === 'rocket' || t === 'engineer' || t === 'sniper' || t === 'flamer' || t === 'medic' || t === 'psiadept' || t === 'brute'; }
  var INFK = { rifle: 0, rocket: 1, engineer: 2, sniper: 3, flamer: 4, medic: 5 }; // drawInfantry: Gestalt
  var UH = { gatling: 12, magnet: 14, psitank: 18, harvester: 14, tank: 14, howitzer: 14, colossus: 20, mcv: 18, apc: 13, lasertank: 15, flamer: 0, mlrs: 17, shocktank: 18 }; // Aufbauhöhe in px (Welt) für Balken/Rauch
  var SW_R = { orbital: 3, missile: 4, psi: 3.5 };   // v1.0 psi            // Schlagradius in Kacheln (SPEC_v04 §3)
  var FAC = 'coalition', curTick = 0, curAlpha = 0;  // Fraktion des gerade gezeichneten Gebäudes/Einheit; Tick+Interpolation des Frames
  var swList = [], swBlasts = [], barrelOf = {}, deployFx = {}, bolts = [];
  var BEIGE = '#d9d2bd';

  function hash(x, y, s) {
    var h = (x * 374761393 + y * 668265263 + (s || 0) * 2147483647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  // ------------------------------------------------------------------ Farben
  var shadeCache = {};
  function shade(c, f) { // f<1 dunkler, f>1 heller
    var key = c + f, r = shadeCache[key];
    if (r) return r;
    var n = parseInt(c.slice(1), 16), R = n >> 16, Gc = (n >> 8) & 255, B = n & 255;
    if (f <= 1) { R *= f; Gc *= f; B *= f; } else { var t = f - 1; R += (255 - R) * t; Gc += (255 - Gc) * t; B += (255 - B) * t; }
    return (shadeCache[key] = 'rgb(' + (R | 0) + ',' + (Gc | 0) + ',' + (B | 0) + ')');
  }
  /** wie hexMix, aber Ergebnis als '#rrggbb' (damit shade() es weiter abdunkeln/aufhellen kann) */
  var mixCache = {};
  function mixHex(a, b, t) {
    var key = a + b + t, r = mixCache[key]; if (r) return r;
    var n = parseInt(a.slice(1), 16), m = parseInt(b.slice(1), 16), R = Math.round((n >> 16) * (1 - t) + (m >> 16) * t), Gc = Math.round(((n >> 8) & 255) * (1 - t) + ((m >> 8) & 255) * t), B = Math.round((n & 255) * (1 - t) + (m & 255) * t);
    return (mixCache[key] = '#' + ((1 << 24) | (R << 16) | (Gc << 8) | B).toString(16).slice(1));
  }
  function hexMix(a, b, t) {
    var key = a + b + t, r = shadeCache[key]; if (r) return r;
    var n = parseInt(a.slice(1), 16), m = parseInt(b.slice(1), 16);
    var R = (n >> 16) * (1 - t) + (m >> 16) * t, Gc = ((n >> 8) & 255) * (1 - t) + ((m >> 8) & 255) * t, B = (n & 255) * (1 - t) + (m & 255) * t;
    return (shadeCache[key] = 'rgb(' + (R | 0) + ',' + (Gc | 0) + ',' + (B | 0) + ')');
  }

  // ------------------------------------------------------------------ Init / Größe
  function init(canvas, miniCanvas) {
    V = G.view;
    cv = canvas; mini = miniCanvas;
    ctx = cv.getContext('2d');
    mctx = mini.getContext('2d');
    HK = Math.cos(V.PITCH);
    try { MODE = localStorage.getItem(QKEY) === 'sprite' ? 'sprite' : '2d'; } catch (e) { MODE = '2d'; } // Sprite-Modus: gespeicherte Wahl
    spLoad();
    resize();
  }
  function resize() {
    var r = cv.getBoundingClientRect();
    var w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    // W11-look: volle Geräteauflösung (vorher fest ≤ 2 → auf DPR 2,6 wurde das ganze Bild vom Browser um 1,3× weich hochgezogen);
    // Obergrenze 3 und ≤ 7 MPix Zeichenfläche (Pixel 10 Pro Fold innen 884×1000 @ 2,625 ≈ 6,1 MPix).
    dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1, Math.sqrt(DPR_MPIX / (w * h))));
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    if (V.vw !== w || V.vh !== h) { V.vw = w; V.vh = h; V.clampCam(); }
    var mr = mini.getBoundingClientRect();
    var mw = Math.round(mr.width * dpr), mh = Math.round(mr.height * dpr);
    if (mini.width !== mw || mini.height !== mh) { mini.width = mw; mini.height = mh; }
  }

  // ------------------------------------------------------------------ Gelände (einmal vorgerendert)
  var TCOL = {
    grass: [76, 122, 54], sand: [190, 166, 108], rock: [112, 110, 106], water: [38, 92, 150],
    trees: [68, 112, 50], road: [92, 90, 86], bridge: [34, 84, 138]
  };
  var TCOLM = { grass: [70, 112, 50], sand: [180, 158, 106], rock: [110, 106, 100], water: [36, 90, 140], trees: [36, 72, 32], road: [96, 94, 88], bridge: [130, 96, 60] };
  // Thema/Wetter/Tageszeit: Winter-Boden (2D + Sprite-Boden + Minimap), Tönung für Dämmerung/Nacht (G.MAPS.mood). Sprites der Bäume/Gebäude bleiben.
  var TCOL_W = { grass: [204, 212, 224], sand: [182, 194, 210], rock: [98, 100, 106], water: [38, 72, 108], trees: [50, 78, 70], road: [116, 118, 126], bridge: [38, 72, 108] };
  var TCOLM_W = { grass: [208, 216, 226], sand: [184, 194, 208], rock: [104, 106, 112], water: [44, 76, 110], trees: [58, 86, 80], road: [124, 126, 132], bridge: [120, 92, 64] };
  var GRD_W = { sat: 1.0, r: 0.95, g: 0.97, b: 1.0 };
  var MOOD_TINT = { dusk: 'rgba(120,52,40,0.16)', night: 'rgba(6,14,40,0.52)' };
  function moodOf(m) { return (G.MAPS && G.MAPS.mood && m) ? G.MAPS.mood(m.id) : { theme: 'temperate', time: 'day', weather: 'none' }; }
  var STRETCH = 1; // senkrechte Streckung für "aufrechte" Formen im Boden-Canvas (1/sin(PITCH))

  // ------------------------------------------------------------------ Sprite-Modus: Boden im Modern-Stil (prozedural, einmal je Karte)
  // Nachbau der Modern-Bodenschichten (r3-terrain genLayers: Gras, Trockengras, Erde, Sand, Fels, Asphalt, Erzboden) als kleine kachelbare
  // Texturen, weich überblendet (verrauschte Ränder + Höhen-Überblendung), Straßen mit dunklem Rand, Hangschattierung aus einem
  // groben Höhenfeld (Felsen hoch, Wasser tief), Wasser mit Tiefe, nassem Ufer und Schaumlinie. Kein WebGL.
  var GL_S = 64, glCache = null; // W11-look: 128 bei feinem Boden (world.TS > 40), damit die Schichten nicht grob hochgezogen werden
  var GRD0 = { sat: 1.05, r: 0.95, g: 0.92, b: 0.72 }; // Abschlussfarbe des Sprite-Bodens (per Vergleich mit Modern abgestimmt)
  function pnoise(f, oct, seed) { // periodisches fBm-Wertrauschen GL_S×GL_S in [0,1]
    var S = GL_S, out = new Float32Array(S * S), amp = 1, tot = 0, o, i, j;
    for (o = 0; o < oct; o++, f *= 2, amp *= 0.5) {
      tot += amp;
      for (j = 0; j < S; j++) for (i = 0; i < S; i++) {
        var u = i / S * f, v = j / S * f, iu = Math.floor(u), iv = Math.floor(v), fu = u - iu, fv = v - iv;
        fu = fu * fu * (3 - 2 * fu); fv = fv * fv * (3 - 2 * fv);
        var a = hash(iu % f, iv % f, seed + o), b = hash((iu + 1) % f, iv % f, seed + o), c = hash(iu % f, (iv + 1) % f, seed + o), d = hash((iu + 1) % f, (iv + 1) % f, seed + o);
        out[j * S + i] += amp * (a + (b - a) * fu + (c - a) * fv + (a - b - c + d) * fu * fv);
      }
    }
    for (i = 0; i < out.length; i++) out[i] /= tot;
    return out;
  }
  function sst(a, b, x) { var t = (x - a) / (b - a); t = t < 0 ? 0 : (t > 1 ? 1 : t); return t * t * (3 - 2 * t); }
  function mixf(a, b, t) { return a + (b - a) * t; }
  /** 7 Schichten (RGB + Höhe) wie die Modern-Bodentexturen (Paletten aus r3-terrain.genLayers) */
  function groundLayers(wt) {
    if (glCache && glCache.wt === !!wt) return glCache;   // Thema Winter: eigener Satz
    var S = GL_S, N = S * S, A1 = pnoise(2, 4, 3), A2 = pnoise(8, 3, 11), A3 = pnoise(16, 2, 17), B1 = pnoise(2, 4, 23), B2 = pnoise(4, 4, 29), B3 = pnoise(16, 2, 37);
    var L = [], k, l;
    for (l = 0; l < 7; l++) {
      var c = new Uint8ClampedArray(N * 3), hh = new Float32Array(N);
      for (k = 0; k < N; k++) {
        var n1 = A1[k], n2 = A2[k], n3 = A3[k], m1 = B1[k], m2 = B2[k], m3 = B3[k], v2 = ((k / S) | 0) / S, sp = hash(k, l, 40), r, g, b, h, t;
        if (l === 0) { t = clamp(0.2 + 0.55 * n1 + 1.1 * (n2 - 0.5) + 0.7 * (n3 - 0.5), 0, 1); r = mixf(44, 112, t); g = mixf(92, 164, t); b = mixf(32, 62, t); var y = sst(0.6, 0.85, n2) * 0.4; r += 34 * y; g += 10 * y; if (sp > 0.965) { r += 18; g += 20; } h = clamp(0.4 + 0.9 * (n2 - 0.5) + 0.55 * (n3 - 0.5), 0, 1); }
        else if (l === 1) { t = clamp(0.25 + 0.5 * m1 + 0.7 * (m2 - 0.5) + 0.4 * (n3 - 0.5), 0, 1); r = mixf(128, 204, t); g = mixf(108, 176, t); b = mixf(52, 100, t); var dk = sst(0.62, 0.8, n2) * 0.28; r *= 1 - dk; g *= 1 - dk; b *= 1 - dk; h = clamp(0.4 + 0.8 * (m2 - 0.5) + 0.6 * (n3 - 0.5), 0, 1); }
        else if (l === 2) { t = clamp(0.3 + 0.5 * n1 + 0.5 * (m2 - 0.5), 0, 1); r = mixf(98, 152, t); g = mixf(72, 116, t); b = mixf(48, 80, t); var pb = sst(0.7, 0.76, m3); r = mixf(r, 168, pb * 0.55); g = mixf(g, 156, pb * 0.55); b = mixf(b, 142, pb * 0.55); h = clamp(0.4 + 0.5 * (n2 - 0.5) + 0.5 * (n3 - 0.5) + pb * 0.3, 0, 1); }
        else if (l === 3) { var rip = Math.sin((v2 * 6 + (n1 - 0.5) * 5 + (m2 - 0.5) * 1.5) * TAU) * 0.5 + 0.5; t = clamp(0.35 + 0.35 * n1 + 0.25 * (n3 - 0.5) + 0.18 * (rip - 0.5), 0, 1); r = mixf(204, 238, t); g = mixf(180, 216, t); b = mixf(126, 160, t); if (sp > 0.97) { r -= 28; g -= 30; b -= 28; } h = clamp(0.5 + 0.28 * (rip - 0.5) + 0.2 * (n3 - 0.5), 0, 1); }
        else if (l === 4) { var ra = 1 - Math.abs(2 * n1 - 1), rb = 1 - Math.abs(2 * m2 - 1), st = Math.sin((v2 * 5 + n1 * 3 + (n2 - 0.5)) * TAU) * 0.5 + 0.5; t = clamp(0.25 + 0.4 * ra + 0.175 * st + 0.3 * (n3 - 0.5), 0, 1); r = mixf(84, 154, t); g = mixf(80, 144, t); b = mixf(74, 130, t); var crk = sst(0.9, 0.985, rb); r *= 1 - 0.45 * crk; g *= 1 - 0.45 * crk; b *= 1 - 0.45 * crk; h = clamp(0.25 + 0.5 * ra * ra + 0.2 * st - crk * 0.3, 0, 1); }
        else if (l === 5) { var ck2 = sst(0.955, 0.992, 1 - Math.abs(2 * m2 - 1)); t = clamp(0.5 + 0.5 * (n1 - 0.5) + 0.5 * (n3 - 0.5), 0, 1); r = mixf(62, 86, t); g = mixf(64, 88, t); b = mixf(66, 90, t); var oil = sst(0.62, 0.74, m1) * 0.22; r *= 1 - oil - ck2 * 0.45; g *= 1 - oil - ck2 * 0.45; b *= 1 - oil - ck2 * 0.45; if (sp > 0.93) { r += 14; g += 14; b += 14; } h = 0.5; }
        else { t = clamp(0.3 + 0.5 * n1 + 0.5 * (n2 - 0.5), 0, 1); r = mixf(58, 112, t); g = mixf(42, 78, t); b = mixf(32, 52, t); var sk = Math.min(1, sst(0.82, 0.9, m3) + sst(0.86, 0.93, n3) * 0.8); r = mixf(r, 250, sk * 0.85); g = mixf(g, 198, sk * 0.85); b = mixf(b, 74, sk * 0.85); h = clamp(0.4 + 0.45 * (n2 - 0.5) + sk * 0.35, 0, 1); }
        if (wt) {   // Thema Winter (wie r3-terrain winterLayer, vereinfacht)
          if (l === 0) { r = mixf(188, 224, t); g = mixf(198, 231, t); b = mixf(216, 242, t); } else if (l === 1) { r = mixf(176, 204, t); g = mixf(184, 211, t); b = mixf(198, 224, t); }
          else if (l === 2) { r = mixf(84, 120, t); g = mixf(80, 112, t); b = mixf(78, 106, t); } else if (l === 3) { r = mixf(170, 204, t); g = mixf(184, 214, t); b = mixf(200, 228, t); }
          else if (l === 4) { r *= 0.86; g *= 0.9; b *= 0.98; } else if (l === 5) { r *= 0.82; g *= 0.84; b *= 0.9; } else { r *= 0.9; g *= 0.92; b *= 1.02; }
        }
        c[k * 3] = r; c[k * 3 + 1] = g; c[k * 3 + 2] = b; hh[k] = h;
      }
      L.push({ c: c, h: hh });
    }
    glCache = { L: L, warp: pnoise(4, 3, 61), warp2: pnoise(4, 3, 67), wt: !!wt };
    return glCache;
  }
  function blurGrid(a, w, h, rad) { // Kastenfilter (zweimal) auf einem Kachelraster
    var o = new Float32Array(a.length), t = new Float32Array(a.length), x, y, k, s, n;
    for (var pass = 0; pass < 2; pass++) {
      var src = pass ? o : a;
      for (y = 0; y < h; y++) for (x = 0; x < w; x++) { s = 0; n = 0; for (k = -rad; k <= rad; k++) { var xx = clamp(x + k, 0, w - 1); s += src[y * w + xx]; n++; } t[y * w + x] = s / n; }
      for (y = 0; y < h; y++) for (x = 0; x < w; x++) { s = 0; n = 0; for (k = -rad; k <= rad; k++) { var yy = clamp(y + k, 0, h - 1); s += t[yy * w + x]; n++; } o[y * w + x] = s / n; }
    }
    return o;
  }
  // W11-look: Welt-fbm wie r3-terrain (lat/vnoise/mkWorldFbm, Periode 128) – reines JS, hier kopiert, damit render2d ohne r3-terrain/THREE läuft.
  var WLAT = {};
  function wlat(seed) {
    var a = WLAT[seed];
    if (!a) { a = new Float32Array(128 * 128); var s = (seed * 9301 + 49297) | 0; for (var i = 0; i < a.length; i++) { s = (Math.imul(s, 1103515245) + 12345) | 0; a[i] = ((s >>> 8) & 0xffff) / 65535; } WLAT[seed] = a; }
    return a;
  }
  function wvn(L, x, y) {
    var xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    var x0 = xi & 127, x1 = (x0 + 1) & 127, y0 = (yi & 127) * 128, y1 = (((yi & 127) + 1) & 127) * 128;
    var a = L[y0 + x0], b = L[y0 + x1], c = L[y1 + x0], d = L[y1 + x1];
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }
  function wfbm(freq, oct, seed, x, z) { var s = 0, g = 1, n = 0, f = freq; for (var k = 0; k < oct; k++) { s += g * wvn(wlat(seed + k * 11), x * f, z * f); n += g; g *= 0.5; f *= 2; } return s / n; }
  function wfDry(x, z) { return wfbm(0.1, 3, 71, x, z); }
  function wfDirt(x, z) { return wfbm(0.3, 3, 73, x, z); }
  /** Boden im Modern-Stil in g (Größe m.w·TS × m.h·TS) malen */
  function modernGround(g, m, TS, tt) {
    var WTm = moodOf(m).theme === 'winter', GRD = WTm ? GRD_W : GRD0;   // Thema Winter
    var t0 = performance.now(), GL = groundLayers(WTm), Ls = GL.L, S = GL_S, W = m.w, H = m.h, x, y, l, i;
    var NL = 7, wg = [], road = new Float32Array(W * H), wat = new Float32Array(W * H), hgt = new Float32Array(W * H);
    for (l = 0; l < NL; l++) wg.push(new Float32Array(W * H));
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      var id = tt(x, y), q = y * W + x, ore = m.oreMax && m.oreMax[q] > 0 || m.ore[q] > 0;
      if (id === 'grass') { // Gras mit Flecken aus Trockengras und Erde – W11-look: dasselbe Welt-Rauschen + dieselben Schwellen wie die Modern-Splat-Karte (r3-terrain buildFields) → Flecken an denselben Stellen
        var dry = sst(0.5, 0.7, wfDry(x + 0.5, y + 0.5)) * 0.92, dirt = sst(0.64, 0.8, wfDirt(x + 0.5, y + 0.5)) * 0.8;
        wg[1][q] = dry * (1 - dirt); wg[2][q] = dirt; wg[0][q] = Math.max(0, 1 - wg[1][q] - dirt);
      }
      else if (id === 'sand') wg[3][q] = 1;
      else if (id === 'rock') { wg[4][q] = 0.45; wg[2][q] = 0.55; hgt[q] = 1; }
      else if (id === 'trees') { wg[0][q] = 0.6; wg[2][q] = 0.4; hgt[q] = 0.12; }
      else if (id === 'road') { road[q] = 1; wg[2][q] = 0.6; wg[0][q] = 0.4; }
      else { wg[2][q] = 0.7; wg[3][q] = 0.3; wat[q] = 1; hgt[q] = -0.6; } // Wasser, Brücke
      if (ore) { for (l = 0; l < NL; l++) wg[l][q] *= 0.2; wg[6][q] = 0.8; }
    }
    var hb = blurGrid(hgt, W, H, 1), deep = blurGrid(wat, W, H, 2), shadeG = new Float32Array(W * H);
    // W11: Sonne (-0.62, 0.68, -0.4) für die alte Diagonale → mit der Kamera mitgedreht (G.view.lightDir), wie Modern
    var LD = G.view && G.view.lightDir ? G.view.lightDir([-0.62, 0.68, -0.4]) : [-0.62, 0.68, -0.4];
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) { // Hangschattierung: Normale aus dem Höhenfeld gegen die Sonne
      var hx = (hb[y * W + Math.min(W - 1, x + 1)] - hb[y * W + Math.max(0, x - 1)]) * 0.5, hz = (hb[Math.min(H - 1, y + 1) * W + x] - hb[Math.max(0, y - 1) * W + x]) * 0.5;
      shadeG[y * W + x] = clamp((LD[1] - (LD[0] * hx + LD[2] * hz) * 1.6) / LD[1], 0.55, 1.35);
    }
    var cw = W * TS, chh = H * TS, img = g.createImageData(cw, chh), d = img.data, rep = S / (TS * 1.55);
    var warp = GL.warp, warp2 = GL.warp2, mask = new Uint16Array(W * H);
    for (i = 0; i < W * H; i++) { var mk = 0; for (l = 0; l < NL; l++) if (wg[l][i] > 0.001) mk |= 1 << l; if (road[i] > 0) mk |= 128; if (wat[i] > 0) mk |= 256; mask[i] = mk; }
    var LC = Ls.map(function (q) { return q.c; }), LH = Ls.map(function (q) { return q.h; }), AC = LC[5];
    var p = 0, u0, v0, iu, iv, fu, fv, x0, x1, y0, y1, o00, o10, o01, o11, w00, w10, w01, w11;
    for (var py = 0; py < chh; py++) {
      var v = (py + 0.5) / TS;
      // unverzerrte Zeile (Straße, Schattierung, Tiefe)
      v0 = v - 0.5; iv = Math.floor(v0); var fvu = v0 - iv, yu0 = iv < 0 ? 0 : (iv >= H ? H - 1 : iv), yu1 = iv + 1 >= H ? H - 1 : (iv + 1 < 0 ? 0 : iv + 1);
      for (var px = 0; px < cw; px++, p += 4) {
        var u = (px + 0.5) / TS;
        var wi = (((v * 0.55 * S / 4) | 0) & (S - 1)) * S + (((u * 0.55 * S / 4) | 0) & (S - 1));
        var wu = u + (warp[wi] - 0.5) * 0.9 - 0.5, wv = v + (warp2[wi] - 0.5) * 0.9 - 0.5;
        iu = Math.floor(wu); iv = Math.floor(wv); fu = wu - iu; fv = wv - iv;
        x0 = iu < 0 ? 0 : (iu >= W ? W - 1 : iu); x1 = iu + 1 < 0 ? 0 : (iu + 1 >= W ? W - 1 : iu + 1); y0 = iv < 0 ? 0 : (iv >= H ? H - 1 : iv); y1 = iv + 1 < 0 ? 0 : (iv + 1 >= H ? H - 1 : iv + 1);
        o00 = y0 * W + x0; o10 = y0 * W + x1; o01 = y1 * W + x0; o11 = y1 * W + x1;
        w00 = (1 - fu) * (1 - fv); w10 = fu * (1 - fv); w01 = (1 - fu) * fv; w11 = fu * fv;
        var cm = mask[o00] | mask[o10] | mask[o01] | mask[o11];
        var ti = (((v * TS * rep) | 0) & (S - 1)) * S + (((u * TS * rep) | 0) & (S - 1)), ti3 = ti * 3, tot = 0, cr = 0, cg = 0, cb = 0;
        for (l = 0; l < NL; l++) {
          if (!(cm & (1 << l))) continue;
          var a = wg[l], w0 = a[o00] * w00 + a[o10] * w10 + a[o01] * w01 + a[o11] * w11;
          if (w0 < 0.02) continue;
          var ww = w0 + (LH[l][ti] - 0.5) * 0.45 * w0; if (ww <= 0) continue;
          ww *= ww * ww; tot += ww;
          var tc = LC[l]; cr += tc[ti3] * ww; cg += tc[ti3 + 1] * ww; cb += tc[ti3 + 2] * ww;
        }
        if (tot > 0) { cr /= tot; cg /= tot; cb /= tot; } else { cr = 70; cg = 110; cb = 50; }
        var wt = cm & 256 ? wat[o00] * w00 + wat[o10] * w10 + wat[o01] * w01 + wat[o11] * w11 : 0;
        // unverzerrt: Straße, Hang, Tiefe
        u0 = u - 0.5; iu = Math.floor(u0); fu = u0 - iu;
        x0 = iu < 0 ? 0 : (iu >= W ? W - 1 : iu); x1 = iu + 1 >= W ? W - 1 : (iu + 1 < 0 ? 0 : iu + 1);
        o00 = yu0 * W + x0; o10 = yu0 * W + x1; o01 = yu1 * W + x0; o11 = yu1 * W + x1;
        w00 = (1 - fu) * (1 - fvu); w10 = fu * (1 - fvu); w01 = (1 - fu) * fvu; w11 = fu * fvu;
        if ((mask[o00] | mask[o10] | mask[o01] | mask[o11]) & 128) {
          var rd = road[o00] * w00 + road[o10] * w10 + road[o01] * w01 + road[o11] * w11 + (warp[wi] - 0.5) * 0.12;
          if (rd > 0.05) {
            var ra = sst(0.42, 0.62, rd), re = sst(0.18, 0.45, rd) * (1 - ra);
            cr = mixf(cr * (1 - 0.35 * re), AC[ti3], ra); cg = mixf(cg * (1 - 0.38 * re), AC[ti3 + 1], ra); cb = mixf(cb * (1 - 0.42 * re), AC[ti3 + 2], ra);
          }
        }
        var sh = shadeG[o00] * w00 + shadeG[o10] * w10 + shadeG[o01] * w01 + shadeG[o11] * w11;
        var lum = cr * 0.3 + cg * 0.55 + cb * 0.15; // Farbkorrektur an Modern angeglichen (v10: weniger helle/kühle Wiese, wärmerer Ton, feines Korn wie die Modern-Detailtextur)
        var gr = 1 + (hash(px, py, 211) - 0.5) * 0.10;
        cr = (lum + (cr - lum) * GRD.sat) * sh * GRD.r * gr; cg = (lum + (cg - lum) * GRD.sat) * sh * GRD.g * gr; cb = (lum + (cb - lum) * GRD.sat) * sh * GRD.b * gr;
        if (wt > 0.15) {
          var wet = sst(0.15, 0.5, wt); cr *= 1 - 0.3 * wet; cg *= 1 - 0.27 * wet; cb *= 1 - 0.22 * wet;
          var wa = sst(0.47, 0.56, wt);
          if (wa > 0) {
            var dp = clamp((deep[o00] * w00 + deep[o10] * w10 + deep[o01] * w01 + deep[o11] * w11) * 1.3 - 0.2, 0, 1), nz = (warp[ti] - 0.5) * 14;
            var hl = hash(px, py, 157) > 0.995 - 0.02 * warp2[ti] * warp2[ti] ? 0.4 + 0.3 * warp[ti] : 0; // Glanzpunkte (Sonne auf Wellen) – v0.9 seltener/schwächer
            cr = mixf(cr, mixf(106, 44, dp) + nz + hl * 110, wa); cg = mixf(cg, mixf(160, 98, dp) + nz + hl * 100, wa); cb = mixf(cb, mixf(178, 150, dp) + nz + hl * 80, wa);   // v0.9: tieferes Blau wie das Modern-Wasser (vorher 122/166/182 → 70/112/146)
            var fo = Math.max(0, 1 - Math.abs(wt - 0.585) / 0.05) * (0.55 + 0.45 * warp2[ti]);
            if (fo > 0) { cr = mixf(cr, 236, fo * 0.55); cg = mixf(cg, 242, fo * 0.55); cb = mixf(cb, 246, fo * 0.55); }
          }
        }
        d[p] = cr; d[p + 1] = cg; d[p + 2] = cb; d[p + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    world.groundMs = performance.now() - t0;
  }

  /** W11-look: Bodenbild-Auflösung (px je Kachel). 2D-Modus wie bisher 32. Sprite-Modus: ≈ ½ der Geräte-Pixel je Kachel bei Zoom 1
   *  (40 CSS-px · dpr), 32…56, Seitenlänge ≤ 4096 und ≤ 12 MPix (einmal je Karte erzeugt; DPR 2,6 → 52 px statt 32 → ~2× statt ~3,3× hochgezogen). */
  function groundTS(m) {
    // v0.9 große Turnierkarten (> 6000 Kacheln): Bodenbild höchstens BIG_MPIX (Speicher/Zeit auf Handys) → automatisch weniger px je Kachel (gerade Zahl)
    var mx = Math.max(m.w, m.h), area = m.w * m.h, cap = area > 6000 ? BIG_MPIX : GROUND_MPIX, capTS = area > 6000 ? Math.floor(Math.sqrt(cap / area) / 2) * 2 : Math.floor(Math.sqrt(cap / area));
    var base = Math.min(32, Math.floor(4096 / mx), capTS);
    if (MODE !== 'sprite') return base;
    var want = Math.round(V.K * TILE * dpr * 0.5 / 4) * 4;
    return Math.max(base, Math.min(56, want, Math.floor(4096 / mx), capTS));
  }
  function buildWorld() {
    var S = G.Sim.S, m = S.map;
    mapRef = m;
    setView();
    STRETCH = 1 / Math.sin(V.PITCH);
    world = { TS: groundTS(m), oreIdx: [], nst: {} };
    var TS = world.TS;
    var tc = document.createElement('canvas'); tc.width = m.w * TS; tc.height = m.h * TS;
    var g = tc.getContext('2d');
    var ids = D.TERRAIN.map(function (t) { return t.id; });
    function tt(x, y) { return (x < 0 || y < 0 || x >= m.w || y >= m.h) ? '' : ids[m.terrain[y * m.w + x]]; }
    function landish(t) { return t && t !== 'water'; }
    var x, y, i, q, col, id, v, px, py;
    var hq = TS / 2;
    world.bruns = G.Bridges ? G.Bridges.plan(m) : null;   // v0.9: diagonale Brückenzüge (ein gerader Steg statt Kacheltreppe)
    var bdiag = world.bruns ? world.bruns.diag : null;
    var WT2 = moodOf(m).theme === 'winter', TCX = WT2 ? TCOL_W : TCOL, TCMX = WT2 ? TCOLM_W : TCOLM;   // Thema Winter
    if (MODE === 'sprite') { var gls = TS > 40 ? 128 : 64; if (gls !== GL_S) { GL_S = gls; glCache = null; } modernGround(g, m, TS, tt); } // Sprite-Modus: Boden im Modern-Stil
    else {
    // 1) Grundfarben mit Viertelkachel-Rauschen
    for (y = 0; y < m.h; y++) for (x = 0; x < m.w; x++) {
      id = tt(x, y); col = TCX[id];
      if (id === 'trees') col = TCX.trees; if (id === 'bridge') col = TCX.water;
      for (q = 0; q < 4; q++) {
        v = (hash(x, y, 1 + q) - 0.5) * (id === 'water' ? 10 : 15);
        g.fillStyle = 'rgb(' + (col[0] + v | 0) + ',' + (col[1] + v | 0) + ',' + (col[2] + v | 0) + ')';
        g.fillRect(x * TS + (q & 1) * hq, y * TS + (q >> 1) * hq, hq + 0.6, hq + 0.6);
      }
    }
    // 2) Details je Kachel
    var s = TS / 32;
    for (y = 0; y < m.h; y++) for (x = 0; x < m.w; x++) {
      id = tt(x, y); px = x * TS; py = y * TS;
      if (id === 'grass') {
        for (i = 0; i < 6; i++) {
          g.fillStyle = hash(x, y, 30 + i) > 0.5 ? 'rgba(255,255,255,0.10)' : (WT2 ? 'rgba(60,80,120,0.10)' : 'rgba(10,30,0,0.14)');
          g.fillRect(px + hash(x, y, 10 + i) * (TS - 3), py + hash(x, y, 20 + i) * (TS - 4), 2 * s + 1, 3 * s + 1);
        }
        if (!WT2 && hash(x, y, 77) > 0.93) { g.fillStyle = '#f5e27a'; g.fillRect(px + hash(x, y, 78) * (TS - 3), py + hash(x, y, 79) * (TS - 3), 2, 2); }
      } else if (id === 'sand') {
        for (i = 0; i < 7; i++) {
          g.fillStyle = hash(x, y, 30 + i) > 0.5 ? 'rgba(255,255,230,0.20)' : 'rgba(110,80,30,0.16)';
          g.fillRect(px + hash(x, y, 10 + i) * (TS - 2), py + hash(x, y, 20 + i) * (TS - 2), 2, 2);
        }
      } else if (id === 'road') {
        var rl = tt(x - 1, y) === 'road' || tt(x - 1, y) === 'bridge', rr = tt(x + 1, y) === 'road' || tt(x + 1, y) === 'bridge';
        var ru = tt(x, y - 1) === 'road' || tt(x, y - 1) === 'bridge', rd = tt(x, y + 1) === 'road' || tt(x, y + 1) === 'bridge';
        g.fillStyle = 'rgba(255,255,255,0.20)'; // helle Randlinien dort, wo keine Straße anschließt
        if (!ru) g.fillRect(px, py, TS, 2); if (!rd) g.fillRect(px, py + TS - 2, TS, 2);
        if (!rl) g.fillRect(px, py, 2, TS); if (!rr) g.fillRect(px + TS - 2, py, 2, TS);
        g.fillStyle = 'rgba(250,230,140,0.55)';
        if ((rl || rr) && !(ru && rd)) g.fillRect(px + 2, py + TS / 2 - 1, TS * 0.45, 2);
        else if (ru || rd) g.fillRect(px + TS / 2 - 1, py + 2, 2, TS * 0.45);
      } else if (id === 'water' || id === 'bridge') {
        var deep = tt(x - 1, y) === 'water' && tt(x + 1, y) === 'water' && tt(x, y - 1) === 'water' && tt(x, y + 1) === 'water';
        if (deep) { g.fillStyle = 'rgba(0,20,60,0.18)'; g.fillRect(px, py, TS, TS); }
        g.strokeStyle = 'rgba(255,255,255,0.15)'; g.lineWidth = 1.5;
        for (i = 0; i < 2; i++) {
          var wy = py + (8 + i * 14 + hash(x, y, 3 + i) * 4) * s, wx = px + hash(x, y, 5 + i) * 8 * s;
          g.beginPath(); g.moveTo(wx + 2, wy); g.quadraticCurveTo(wx + 10 * s, wy - 3, wx + 18 * s, wy); g.stroke();
        }
        g.fillStyle = 'rgba(235,245,255,0.5)'; // Uferschaum
        if (landish(tt(x, y - 1))) g.fillRect(px, py, TS, 3);
        if (landish(tt(x, y + 1))) g.fillRect(px, py + TS - 3, TS, 3);
        if (landish(tt(x - 1, y))) g.fillRect(px, py, 3, TS);
        if (landish(tt(x + 1, y))) g.fillRect(px + TS - 3, py, 3, TS);
        if (id === 'bridge' && !(bdiag && bdiag[y * m.w + x])) {
          var hz = /bridge|road/.test(tt(x - 1, y)) || /bridge|road/.test(tt(x + 1, y)) || landish(tt(x - 1, y)) && tt(x - 1, y) !== 'water' || landish(tt(x + 1, y)) && tt(x + 1, y) !== 'water';
          if (tt(x, y - 1) === 'water' || tt(x, y + 1) === 'water') hz = true; else if (tt(x - 1, y) === 'water' || tt(x + 1, y) === 'water') hz = false;
          g.fillStyle = '#9a6e3e'; g.fillRect(px, py, TS, TS);
          g.fillStyle = '#7a5530';
          for (i = 0; i < 8; i++) { if (hz) g.fillRect(px + i * TS / 8 + TS / 16 - 1, py, 2, TS); else g.fillRect(px, py + i * TS / 8 + TS / 16 - 1, TS, 2); }
          g.fillStyle = '#4a3018';
          if (hz) { g.fillRect(px, py, TS, 3); g.fillRect(px, py + TS - 3, TS, 3); } else { g.fillRect(px, py, 3, TS); g.fillRect(px + TS - 3, py, 3, TS); }
        }
      } else if (id === 'rock') {
        g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(px, py, TS, TS);
      }
    }
    }
    if (world.bruns && world.bruns.runs.length) paintBridgeRuns(g, world.bruns.runs, TS);
    // 3) Aufrechte Dinge in Zeilenreihenfolge (Felsen, Bäume) – spätere Zeilen übermalen frühere.
    //    YAW = 0: direkt ins Bodenbild. YAW ≠ 0: nicht ins (gedrehte) Bodenbild, sondern als aufrechte Sprites (spriteFor).
    world.upr = []; world.spr = {}; world.withUpright = !ROT;
    for (y = 0; y < m.h; y++) for (x = 0; x < m.w; x++) {
      id = tt(x, y);
      if (id !== 'rock' && id !== 'trees') continue;
      world.upr.push(y * m.w + x);
      if (!ROT) paintUpright(g, id, x, y, x * TS, y * TS, TS);
    }
    world.terrain = tc;
    world.tch = null;
    if (tc.width > 2048 || tc.height > 2048) { world.tch = chunkGround(tc, m, TS); tc.width = tc.height = 1; } // W11-look: feiner Sprite-Boden in Stücken (s. chunkGround), Gesamtbild freigeben
    // Erz-Kacheln merken (Erz selbst wird dynamisch gezeichnet)
    for (i = 0; i < m.ore.length; i++) if (m.ore[i] > 0 || (m.oreMax && m.oreMax[i] > 0)) world.oreIdx.push(i);
    // Minimap-Basis (2 px je Kachel)
    var mb = document.createElement('canvas'); mb.width = m.w * 2; mb.height = m.h * 2;
    var mg = mb.getContext('2d'), img = mg.createImageData(mb.width, mb.height);
    for (y = 0; y < mb.height; y++) for (x = 0; x < mb.width; x++) {
      var mc = TCMX[D.TERRAIN[m.terrain[(y >> 1) * m.w + (x >> 1)]].id], vv = (hash(x, y, 9) - 0.5) * 14, o = (y * mb.width + x) * 4;
      img.data[o] = mc[0] + vv; img.data[o + 1] = mc[1] + vv; img.data[o + 2] = mc[2] + vv; img.data[o + 3] = 255;
    }
    mg.putImageData(img, 0, 0);
    world.miniBase = mb;
    world.fogCv = document.createElement('canvas'); world.fogCv.width = m.w; world.fogCv.height = m.h;
    world.fogCtx = world.fogCv.getContext('2d');
    world.fogImg = world.fogCtx.createImageData(m.w, m.h);
    fogTick = -1;
  }

  /** v0.9: diagonale Brückenzüge (G.Bridges) als gerader Steg ins Bodenbild: Schatten auf dem Wasser, Bohlen quer, dunkle Randbalken.
   *  Sprite-Modus (diagonale Kamera) zeichnet darüber den angehobenen Steg mit Geländer (spBridgeRun). */
  function paintBridgeRuns(g, runs, TS) {
    var LD = G.view && G.view.lightDir ? G.view.lightDir([-0.62, 0.68, -0.4]) : [-0.62, 0.68, -0.4], sl = Math.hypot(LD[0], LD[2]) || 1, s = TS / 32;
    for (var i = 0; i < runs.length; i++) {
      var r = runs[i], L = r.L * TS, W = r.W * TS, a = Math.atan2(r.uy, r.ux), k, n;
      g.save(); g.translate(r.cx * TS - LD[0] / sl * 0.22 * TS, r.cy * TS - LD[2] / sl * 0.22 * TS); g.rotate(a);
      g.fillStyle = 'rgba(0,12,30,0.32)'; g.fillRect(-L / 2, -W / 2, L, W);   // Schatten
      g.restore();
      g.save(); g.translate(r.cx * TS, r.cy * TS); g.rotate(a);
      g.fillStyle = '#9a6e3e'; g.fillRect(-L / 2, -W / 2, L, W);
      g.fillStyle = '#7a5530'; n = Math.floor(r.L / 0.2);
      for (k = 0; k <= n; k++) g.fillRect(-L / 2 + k * 0.2 * TS - s, -W / 2, 2 * s, W);
      g.fillStyle = 'rgba(255,235,200,0.10)'; for (k = 0; k < n; k += 2) g.fillRect(-L / 2 + k * 0.2 * TS + s, -W / 2, 0.2 * TS - 2 * s, W);
      g.fillStyle = '#4a3018'; g.fillRect(-L / 2, -W / 2, L, 3 * s); g.fillRect(-L / 2, W / 2 - 3 * s, L, 3 * s);
      g.restore();
    }
  }
  /** Fels / Baumgruppe einer Kachel an Bodenposition (px,py) mit TS px je Kachel */
  function paintUpright(g, id, x, y, px, py, TS) {
    var s = TS / 32, i;
    if (id === 'rock') {
      var rh = (10 + hash(x, y, 3) * 8) * s, off = hash(x, y, 4) * 5 * s;
      g.fillStyle = 'rgba(0,0,0,0.30)'; g.beginPath(); g.ellipse(px + TS * 0.55, py + TS * 0.82, TS * 0.52, TS * 0.22, 0, 0, 6.2832); g.fill();
      g.fillStyle = '#5c5a57'; // Vorderwand
      g.beginPath(); g.moveTo(px + 1, py + TS - 1); g.lineTo(px + 2 + off, py + TS - rh - 4 * s); g.lineTo(px + TS - 2, py + TS - rh); g.lineTo(px + TS - 1, py + TS - 1); g.closePath(); g.fill();
      g.fillStyle = '#9c9a94'; // Oberseite
      g.beginPath(); g.moveTo(px + 2 + off, py + TS - rh - 4 * s); g.lineTo(px + TS * 0.35, py + 3 * s); g.lineTo(px + TS * 0.8, py + 5 * s + hash(x, y, 5) * 4); g.lineTo(px + TS - 2, py + TS - rh); g.closePath(); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.22)'; // Lichtkante links
      g.beginPath(); g.moveTo(px + TS * 0.35, py + 3 * s); g.lineTo(px + 2 + off, py + TS - rh - 4 * s); g.lineTo(px + 6 + off, py + TS - rh - 4 * s); g.lineTo(px + TS * 0.4, py + 8 * s); g.closePath(); g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 1; g.beginPath(); g.moveTo(px + 2 + off, py + TS - rh - 4 * s); g.lineTo(px + TS - 2, py + TS - rh); g.stroke();
    } else if (id === 'trees') {
      for (i = 0; i < 3; i++) {
        var tx = px + (0.22 + hash(x, y, 40 + i) * 0.56) * TS, ty = py + (0.42 + hash(x, y, 50 + i) * 0.5) * TS, tr = (7 + hash(x, y, 60 + i) * 3) * s;
        g.fillStyle = 'rgba(0,0,0,0.30)'; g.beginPath(); g.ellipse(tx + tr * 0.5, ty + 1, tr * 1.05, tr * 0.5, 0, 0, 6.2832); g.fill();
        g.fillStyle = '#4a3320'; g.fillRect(tx - 1.2 * s, ty - 7 * s, 2.4 * s, 7 * s);
        g.fillStyle = '#1e4a1c'; g.beginPath(); g.ellipse(tx, ty - 10 * s, tr, tr * 1.15, 0, 0, 6.2832); g.fill();
        g.fillStyle = '#2f6b2a'; g.beginPath(); g.ellipse(tx - tr * 0.2, ty - 11.5 * s, tr * 0.72, tr * 0.8, 0, 0, 6.2832); g.fill();
        g.fillStyle = '#4c9140'; g.beginPath(); g.ellipse(tx - tr * 0.35, ty - 13 * s, tr * 0.35, tr * 0.38, 0, 0, 6.2832); g.fill();
      }
    }
  }
  /** Sprite (aufrechtes Bild) einer Fels-/Baumkachel; Kachelmitte bei (SPM + TS/2, SPT + TS/2) */
  var SPM = 0, SPT = 0;
  function spriteFor(ti) {
    var sp = world.spr[ti];
    if (sp) return sp;
    var m = mapRef, TS = world.TS, x = ti % m.w, y = (ti / m.w) | 0, id = D.TERRAIN[m.terrain[ti]].id;
    SPM = Math.round(TS * 0.2); SPT = Math.round(TS * 0.45);
    sp = document.createElement('canvas'); sp.width = TS + 2 * SPM; sp.height = TS + SPT + SPM;
    paintUpright(sp.getContext('2d'), id, x, y, SPM, SPT, TS);
    world.spr[ti] = sp;
    return sp;
  }

  function reset() {
    var S = G.Sim.S;
    if (!S || !V) return;
    buildWorld();
    fxN = 0; decals.length = 0; artyFx.length = 0; swList.length = 0; swBlasts.length = 0; barrelOf = {}; deployFx = {}; bolts.length = 0;
    wreck8.length = 0; rampT = {}; last8 = {};   // v0.8
    lastSeq = S.evSeq;
  }

  function updateFog() {
    var S = G.Sim.S, P = S.players[V.pid], n = S.map.w * S.map.h, off = S.settings.fogOff, im = world.fogImg.data;
    for (var i = 0; i < n; i++) {
      im[i * 4] = 8; im[i * 4 + 1] = 12; im[i * 4 + 2] = 20;
      im[i * 4 + 3] = off ? 0 : (P.vis[i] ? 0 : (P.exp[i] ? 120 : 250));
    }
    world.fogCtx.putImageData(world.fogImg, 0, 0);
    fogTick = S.tick;
  }

  /** W11-look: großes Bodenbild (> 2048 px) in Stücke à GCH Kacheln (+ GPAD px Rand aus den Nachbarn) zerlegen. Ein einzelnes
   *  3000–4000-px-Canvas als Quelle machte jedes Bild teuer (Software-Canvas: 0,5 → 19 ms; GPU: eine riesige Textur); so verweist ein
   *  Frame nur auf die sichtbaren Stücke (≤ 1024 px). Der Rand überdeckt die Kantenglättung an den Stoßkanten (keine Haarlinien). */
  var GCH = 16, GPAD = 2;
  function chunkGround(tc, m, TS) {
    var cols = Math.ceil(m.w / GCH), rows = Math.ceil(m.h / GCH), list = [], cx, cy;
    for (cy = 0; cy < rows; cy++) for (cx = 0; cx < cols; cx++) {
      var tw = Math.min(GCH, m.w - cx * GCH), th = Math.min(GCH, m.h - cy * GCH), c = document.createElement('canvas');
      c.width = tw * TS + 2 * GPAD; c.height = th * TS + 2 * GPAD;
      var g = c.getContext('2d'), sx = cx * GCH * TS - GPAD, sy = cy * GCH * TS - GPAD;
      // Rand: an der Kartenkante Randpixel strecken, sonst aus dem Nachbarstück
      g.drawImage(tc, Math.max(0, sx), Math.max(0, sy), Math.min(tc.width, sx + c.width) - Math.max(0, sx), Math.min(tc.height, sy + c.height) - Math.max(0, sy),
        Math.max(0, -sx), Math.max(0, -sy), Math.min(tc.width, sx + c.width) - Math.max(0, sx), Math.min(tc.height, sy + c.height) - Math.max(0, sy));
      list.push(c);
    }
    return { cols: cols, rows: rows, list: list, TS: TS };
  }
  function blitChunks(ch, tx0, ty0, tx1, ty1) {
    var TS = ch.TS, e = 1, cx, cy; // e: Überlappung in Bodenpixeln
    for (cy = Math.floor(ty0 / GCH); cy <= Math.floor((ty1 - 1) / GCH); cy++) for (cx = Math.floor(tx0 / GCH); cx <= Math.floor((tx1 - 1) / GCH); cx++) {
      var c = ch.list[cy * ch.cols + cx]; if (!c) continue;
      var a0 = Math.max(tx0, cx * GCH), b0 = Math.max(ty0, cy * GCH), a1 = Math.min(tx1, (cx + 1) * GCH), b1 = Math.min(ty1, (cy + 1) * GCH);
      if (a1 <= a0 || b1 <= b0) continue;
      var sx = GPAD + (a0 - cx * GCH) * TS - e, sy = GPAD + (b0 - cy * GCH) * TS - e, sw = (a1 - a0) * TS + 2 * e, sh = (b1 - b0) * TS + 2 * e;
      var wx = a0 * TILE - e * TILE / TS, wy = b0 * TILE - e * TILE / TS, ww = sw * TILE / TS, wh = sh * TILE / TS;
      if (ROT) ctx.drawImage(c, sx, sy, sw, sh, wx, wy, ww, wh);
      else ctx.drawImage(c, sx, sy, sw, sh, (wx - cx0) * kx, (wy - cy0) * ky, ww * kx, wh * ky);
    }
  }
  /** Kartenbild (ppt Bildpunkte je Kachel) sichtbarer Ausschnitt → Bildschirm */
  function blitMap(img, ppt, smooth) {
    var m = G.Sim.S.map, wx0, wy0, wx1, wy1;
    if (!ROT) { wx0 = cx0; wy0 = cy0; wx1 = cx0 + V.vw / kx; wy1 = cy0 + V.vh / ky; }
    else { // sichtbarer Bildschirm → Weltrechteck (Hülle der vier Ecken)
      toW(0, 0); wx0 = wx1 = tmpX; wy0 = wy1 = tmpY;
      for (var q = 1; q < 4; q++) { toW(q & 1 ? V.vw : 0, q & 2 ? V.vh : 0); wx0 = Math.min(wx0, tmpX); wx1 = Math.max(wx1, tmpX); wy0 = Math.min(wy0, tmpY); wy1 = Math.max(wy1, tmpY); }
    }
    var tx0 = Math.max(0, Math.floor(wx0 / TILE)), ty0 = Math.max(0, Math.floor(wy0 / TILE));
    var tx1 = Math.min(m.w, Math.ceil(wx1 / TILE)), ty1 = Math.min(m.h, Math.ceil(wy1 / TILE));
    if (tx1 <= tx0 || ty1 <= ty0) return;
    ctx.imageSmoothingEnabled = smooth;
    if (img === world.terrain && world.tch) { // W11-look: Boden in Stücken
      if (ROT) ctx.setTransform(dpr * MUA, dpr * MUB, dpr * MVA, dpr * MVB, dpr * MOX, dpr * MOY);
      blitChunks(world.tch, tx0, ty0, tx1, ty1);
      if (ROT) resetT();
      return;
    }
    if (!ROT) {
      ctx.drawImage(img, tx0 * ppt, ty0 * ppt, (tx1 - tx0) * ppt, (ty1 - ty0) * ppt,
        (tx0 * TILE - cx0) * kx, (ty0 * TILE - cy0) * ky, (tx1 - tx0) * TILE * kx + 0.6, (ty1 - ty0) * TILE * ky + 0.6);
    } else { // Bodenbild im Weltraster, per Transform gedreht/gekippt
      ctx.setTransform(dpr * MUA, dpr * MUB, dpr * MVA, dpr * MVB, dpr * MOX, dpr * MOY);
      ctx.drawImage(img, tx0 * ppt, ty0 * ppt, (tx1 - tx0) * ppt, (ty1 - ty0) * ppt, tx0 * TILE, ty0 * TILE, (tx1 - tx0) * TILE, (ty1 - ty0) * TILE);
      resetT();
    }
  }
  var uprList = [];
  /** YAW ≠ 0: Bäume/Felsen als aufrechte Sprites, von hinten nach vorn (Bildschirm-y) */
  function drawUpright() {
    var m = G.Sim.S.map, TS = world.TS, n = 0, i, ti, VW = V.vw, VH = V.vh, lst = world.upr, it;
    SPM = Math.round(TS * 0.2); SPT = Math.round(TS * 0.45);
    for (i = 0; i < lst.length; i++) {
      ti = lst[i]; var cxw = ((ti % m.w) + 0.5) * TILE, cyw = (((ti / m.w) | 0) + 0.5) * TILE, X = PX(cxw, cyw), Y = PY(cxw, cyw);
      if (X < -TILE * kx || X > VW + TILE * kx || Y < -TILE * ky * 1.2 || Y > VH + TILE * ky * 2) continue;
      it = uprList[n]; if (!it) it = uprList[n] = {};
      it.ti = ti; it.X = X; it.Y = Y; n++;
    }
    uprList.length = n;
    uprList.sort(function (a, b) { return a.Y - b.Y; });
    ctx.imageSmoothingEnabled = true;
    var sw = TILE * kx / TS * 1.12, sh = TILE * ky / TS * 1.12;
    for (i = 0; i < n; i++) {
      it = uprList[i]; var sp = spriteFor(it.ti);
      ctx.drawImage(sp, it.X - (SPM + TS / 2) * sw, it.Y - (SPT + TS / 2) * sh, sp.width * sw, sp.height * sh);
    }
  }

  // ------------------------------------------------------------------ Hilfen
  function visibleAt(x, y) {
    var S = G.Sim.S;
    if (S.settings.fogOff) return true;
    var tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
    if (tx < 0 || ty < 0 || tx >= S.map.w || ty >= S.map.h) return false;
    return S.players[V.pid].vis[ty * S.map.w + tx] === 1;
  }
  /** Neutrales Gebäude erkundet (oder Nebel aus)? Sonst gar nicht zeichnen/anklicken. */
  function neutralShown(e, P, fogOff) {
    if (fogOff) return true;
    var w = G.Sim.S.map.w, ex = P.exp;
    for (var yy = e.ty; yy < e.ty + e.h; yy++) for (var xx = e.tx; xx < e.tx + e.w; xx++) if (ex[yy * w + xx]) return true;
    return false;
  }
  function bHeight(type) { return (BHT[type] || 0.8) * TILE * kx * HK; } // Bildschirm-px
  /** Abbildung des Frames aus G.view.toScreen ablesen (drei Referenzpunkte → exakt wie main.js, egal wie YAW umgesetzt ist) */
  function setView() {
    var o = V.toScreen(0, 0), a = V.toScreen(1024, 0), b = V.toScreen(0, 1024);
    MOX = o.x; MOY = o.y; MUA = (a.x - o.x) / 1024; MUB = (a.y - o.y) / 1024; MVA = (b.x - o.x) / 1024; MVB = (b.y - o.y) / 1024;
    kx = Math.hypot(MUA, MVA) || 1; ky = Math.hypot(MUB, MVB) || 1;
    ROT = Math.abs(MVA) > 1e-3 * kx || Math.abs(MUB) > 1e-3 * ky;
    YAWA = ROT ? Math.atan2(MUB / ky, MUA / kx) : 0;
    cx0 = V.cam.x; cy0 = V.cam.y;
    if (!ROT) { cx0 = -MOX / MUA; cy0 = -MOY / MVB; } // YAW 0: Kamera-Ecke (= cam.x/cam.y)
    zoomK = V.cam.zoom;
  }
  function PX(wx, wy) { return MOX + MUA * wx + MVA * wy; }
  function PY(wx, wy) { return MOY + MUB * wx + MVB * wy; }
  function sx(wx) { return (wx - cx0) * kx; } // nur noch für YAW = 0 (Randfälle)
  function sy(wy) { return (wy - cy0) * ky; }
  /** Weltrichtung a → Bildschirmvektor (DX, DY) (nicht normiert; Länge ~kx..ky) */
  function sdir(a) { var c = Math.cos(a), s = Math.sin(a); DX = MUA * c + MVA * s; DY = MUB * c + MVB * s; }
  /** Bildschirmpunkt → Welt (inverse der Abbildung) */
  function toW(X, Y) { var dt = MUA * MVB - MVA * MUB, xx = X - MOX, yy = Y - MOY; tmpX = (xx * MVB - MVA * yy) / dt; tmpY = (MUA * yy - MUB * xx) / dt; }
  /** Grundfläche (Weltrechteck x0,y0,w,h in Welt-px, Rand m) als Pfad auf den Bildschirm */
  function footPath(x0, y0, w, h, m) {
    ctx.beginPath();
    ctx.moveTo(PX(x0 - m, y0 - m), PY(x0 - m, y0 - m)); ctx.lineTo(PX(x0 + w + m, y0 - m), PY(x0 + w + m, y0 - m));
    ctx.lineTo(PX(x0 + w + m, y0 + h + m), PY(x0 + w + m, y0 + h + m)); ctx.lineTo(PX(x0 - m, y0 + h + m), PY(x0 - m, y0 + h + m)); ctx.closePath();
  }
  /** Bildschirmgeometrie eines Gebäudes: Mitte der Grundfläche (GCX,GCY), Oberseitengröße GW×GH (Quader steht aufrecht) */
  var GCX = 0, GCY = 0, GW = 0, GH = 0;
  function bgeom(e) {
    var cxw = (e.tx + e.w / 2) * TILE, cyw = (e.ty + e.h / 2) * TILE, k = ROT ? 0.9 : 1;
    GCX = PX(cxw, cyw); GCY = PY(cxw, cyw); GW = e.w * TILE * kx * k; GH = e.h * TILE * ky * k;
  }
  /** Tiefenschlüssel (Bildschirm-y der Vorderkante des Quaders) */
  function bKey(e) { bgeom(e); return GCY + GH / 2; }
  /** Kurzform: Bildschirmposition eines Weltpunkts in (tmpX,tmpY) */
  function scr(wx, wy) { tmpX = PX(wx, wy); tmpY = PY(wx, wy); }

  // ------------------------------------------------------------------ Effekte
  var FX_MAX = 300, fxList = [], fxN = 0, decals = [], artyFx = [];
  var F_TRACER = 1, F_FLASH = 2, F_BOOM = 3, F_SMOKE = 4, F_RING = 5, F_BEAM = 6, F_GLOW = 7, F_DUST = 8, F_PSIB = 16;   // v1.0 F_PSIB: farbiger Strahl (Psi/Magnet/Diskus)
  var F_SNIPE = 9, F_FLAME = 10, F_HEAL = 11, F_FIRE = 12, F_LSMOKE = 13; // v0.7: Scharfschuss, Flammenstrahl, Heilung, Feuerball, Startrauch
  function addFx(t, x, y, z, x2, y2, z2, life, size, col) {
    var f;
    if (fxN < FX_MAX) { f = fxList[fxN]; if (!f) f = fxList[fxN] = {}; fxN++; } else f = fxList[(Math.random() * FX_MAX) | 0];
    f.t = t; f.x = x; f.y = y; f.z = z; f.x2 = x2; f.y2 = y2; f.z2 = z2; f.age = 0; f.life = life; f.size = size; f.col = col;
  }
  function addDecal(x, y, r, life, kind, e) {
    if (decals.length > 80) decals.shift();
    decals.push({ x: x, y: y, r: r, t0: fxTime, life: life, kind: kind || 0, e: e });
  }
  function muzzle(src, barrel) { // Mündung in Weltpixeln + Höhe in Pixeln (Welt)
    var a = src.tdir || 0, L = src.kind === 'building' ? 14 : (src.r || 6) + 6;
    var z = src.kind === 'building' ? (BHT[src.type] || 0.5) * TILE * 0.7 : (isInf(src.type) ? 9 : 12), ox = 0, oy = 0;
    if (src.type === 'laser') { L = 17; z = BHT.laser * TILE * 0.86; } else if (src.type === 'tesla') { L = 0; z = BHT.tesla * TILE * 0.93; }
    else if (src.type === 'howitzer') { L = 36; z = 20; } else if (src.type === 'hunter') L = 30;
    else if (src.type === 'sniper') { L = (src.r || 6) + 15; z = 10; } else if (src.type === 'flamer') { L = (src.r || 6) + 9; z = 9; }
    else if (src.type === 'apc') { L = 12; z = 12; } else if (src.type === 'lasertank') { L = 26; z = 13; }
    else if (src.type === 'shocktank') { L = 0; z = 26; }
    else if (src.type === 'mlrs') { // Raketengestell: 6 Rohre (2 Reihen × 3), Salvenindex (barrel-Parameter) wählt das Rohr
      var sv = barrel == null ? 0 : barrel, lat = ((sv % 3) - 1) * 5.5, da = src.dir == null ? a : src.dir;
      a = da; L = 12; z = 20 + (sv < 3 ? 0 : 3);
      ox = -Math.sin(a) * lat; oy = Math.cos(a) * lat;
    }
    else if (src.type === 'colossus') { L = 30; z = 15; var sd = barrel ? 5 : -5; ox = -Math.sin(a) * sd; oy = Math.cos(a) * sd; }
    else if (src.type === 'dreadnought') {   // v0.9: Werfer bei pivot (0.44 Kacheln vor der Mitte), Schienenende erhoben, Rakete je Salvenindex links/rechts
      var dd9 = src.dir || 0, lt9 = (barrel || 0) % 2 ? -2.2 : 2.2; L = 8; z = 23;
      ox = Math.cos(dd9) * 14 - Math.sin(a) * lt9; oy = Math.sin(dd9) * 14 + Math.cos(a) * lt9;
    }
    if (src.mc === 2) { L = 10; z = (src.alt || 0) * D.AIR_H * TILE; a = src.dir || a; }   // v0.8 Luftfahrzeuge: aus Flughöhe
    return { x: src.x + Math.cos(a) * L + ox, y: src.y + Math.sin(a) * L + oy, z: z };
  }
  function consumeEvents() {
    var S = G.Sim.S, ev = S.events;
    for (var i = 0; i < ev.length; i++) {
      var e = ev[i];
      if (e.seq <= lastSeq) continue;
      if ((e.t === 'mc' || e.t === 'clone' || e.t === 'recycle' || e.t === 'drain') && visibleAt(e.x, e.y)) {   // v1.0 (PLATZHALTER v1.0)
        addFx(F_RING, e.x, e.y, 0, 0, 0, 0, e.t === 'mc' ? 0.8 : 0.5, e.t === 'mc' ? 34 : 22, e.t === 'recycle' ? 'rgba(125,211,252,' : 'rgba(165,180,252,');
        continue;
      }
      if (e.t === 'shot') {
        if (!visibleAt(e.x, e.y) && !visibleAt(e.tx, e.ty)) continue;
        var src = G.Sim.get(e.src), mz = src && !src.dead ? muzzle(src, e.barrel != null ? e.barrel : e.salvo) : { x: e.x, y: e.y, z: 8 };
        if (e.barrel != null) barrelOf[e.src] = e.barrel;
        if (e.w === 'psi' || e.w === 'magnet' || e.w === 'disc') {   // v1.0 Kollektiv-Strahlen (PLATZHALTER v1.0)
          var kc = e.w === 'psi' ? 'rgba(165,180,252,' : (e.w === 'magnet' ? 'rgba(186,198,214,' : 'rgba(125,211,252,');
          addFx(F_PSIB, mz.x, mz.y, mz.z, e.tx, e.ty, 6, e.w === 'psi' ? 0.45 : 0.2, 1, kc);
          addFx(F_GLOW, e.tx, e.ty, 6, 0, 0, 0, 0.3, 8, kc);
        } else if (e.w === 'laser') { // Strahl 0,15 s + Glühen am Ziel
          addFx(F_BEAM, mz.x, mz.y, mz.z, e.tx, e.ty, 6, 0.15, 1);
          addFx(F_GLOW, mz.x, mz.y, mz.z, 0, 0, 0, 0.2, 9, 'rgba(255,90,70,');
          addFx(F_GLOW, e.tx, e.ty, 6, 0, 0, 0, 0.3, 17, 'rgba(255,110,80,'); addDecal(e.tx, e.ty, 4, 14, 0);
        } else if (e.w === 'lightning') { // verzweigter Blitz entlang der Kette, 0,2 s
          var bp = [{ x: mz.x, y: mz.y, z: mz.z }, { x: e.tx, y: e.ty, z: 6 }], ch = e.chain;
          if (ch) for (var ci = 0; ci < ch.length && ci < 4; ci++) {
            var lp = bp[bp.length - 1];
            if (Math.abs(ch[ci].x - lp.x) + Math.abs(ch[ci].y - lp.y) < 4) continue; // Kette enthält ggf. das Primärziel
            bp.push({ x: ch[ci].x, y: ch[ci].y, z: 6 });
          }
          if (bolts.length >= 16) bolts.shift();
          bolts.push({ pts: bp, age: 0, life: 0.2, seed: (e.seq || 0) % 997 });
          addFx(F_GLOW, mz.x, mz.y, mz.z, 0, 0, 0, 0.25, 11, 'rgba(150,170,255,');
          for (var gi = 1; gi < bp.length; gi++) addFx(F_GLOW, bp[gi].x, bp[gi].y, 6, 0, 0, 0, 0.3, gi === 1 ? 17 : 12, 'rgba(160,180,255,');
        } else if (e.w === 'flak' || (e.air && e.w === 'bullet')) {   // v0.8: Leuchtspur in die Flughöhe (Sprengwolke beim Treffer)
          var at8 = e.tid ? G.Sim.get(e.tid) : null, az = (at8 && at8.mc === 2 ? at8.alt || 0 : 1) * D.AIR_H * TILE;
          addFx(F_TRACER, mz.x, mz.y, mz.z, mz.x + (e.tx - mz.x) * 0.6, mz.y + (e.ty - mz.y) * 0.6, mz.z + (az - mz.z) * 0.6, 0.12, 1);
          addFx(F_FLASH, mz.x, mz.y, mz.z, 0, 0, 0, 0.08, e.w === 'flak' ? 7 : 5);
        } else if (e.w === 'bullet') {
          addFx(F_TRACER, mz.x, mz.y, mz.z, e.tx, e.ty, 3, 0.09, 1);
          addFx(F_FLASH, mz.x, mz.y, mz.z, 0, 0, 0, 0.07, 5);
        } else if (e.w === 'sniper') { // dünne, schnelle Leuchtspur + kleiner Mündungsblitz
          addFx(F_SNIPE, mz.x, mz.y, mz.z, e.tx, e.ty, 6, 0.16, 1);
          addFx(F_FLASH, mz.x, mz.y, mz.z, 0, 0, 0, 0.08, 6);
          addFx(F_DUST, e.tx, e.ty, 3, 0, 0, 0, 0.35, 5, 'rgba(190,175,150,'); addFx(F_FLASH, e.tx, e.ty, 5, 0, 0, 0, 0.1, 5); // v0.7-deco: Treffer-Puff (Sofortwaffe ohne hit-Ereignis)
        } else if (e.w === 'flame') { // flackernder Feuerkegel, Dauer ≈ Feuerrate
          addFx(F_FLAME, mz.x, mz.y, mz.z, e.tx, e.ty, 5, 0.5, 1); addDecal(e.tx, e.ty, 8, 30, 0); // Brandfleck am Ziel
          addFx(F_GLOW, mz.x, mz.y, mz.z, 0, 0, 0, 0.25, 8, 'rgba(255,170,60,');
        } else if (e.missile) {   // v0.9 Schlachtschiff: Startflamme, Abgas nach hinten über das Deck, aufsteigende Rauchsäule, Gischt an der Bordwand
          var ma9 = Math.atan2(e.ty - mz.y, e.tx - mz.x), bx9 = -Math.cos(ma9), by9 = -Math.sin(ma9);
          addFx(F_FLASH, mz.x, mz.y, mz.z, 0, 0, 0, 0.16, 17);
          addFx(F_GLOW, mz.x, mz.y, mz.z, 0, 0, 0, 0.32, 13, 'rgba(255,160,60,');
          for (var q9 = 0; q9 < 6; q9++) addFx(F_LSMOKE, mz.x + bx9 * (3 + q9 * 4) + (Math.random() - 0.5) * 5, mz.y + by9 * (3 + q9 * 4) + (Math.random() - 0.5) * 5, Math.max(4, mz.z - q9 * 3), 0, 0, 0, 1.3 + q9 * 0.15, 7 + q9 * 1.4);
          for (q9 = 0; q9 < 3; q9++) addFx(F_LSMOKE, mz.x, mz.y, mz.z + 5 + q9 * 7, 0, 0, 0, 1.7 + q9 * 0.2, 9 + q9 * 2);
          if (src) addFx(F_DUST, src.x + bx9 * 8 + Math.cos(ma9 + 1.57) * 10, src.y + by9 * 8 + Math.sin(ma9 + 1.57) * 10, 2, 0, 0, 0, 0.9, 14, 'rgba(225,238,245,');
        } else if (e.w === 'rocket' && (e.salvo != null || (src && src.type === 'mlrs'))) { // Salvenrakete: Rohrfeuer + Startrauch
          addFx(F_FLASH, mz.x, mz.y, mz.z, 0, 0, 0, 0.12, 10);
          addFx(F_GLOW, mz.x, mz.y, mz.z, 0, 0, 0, 0.22, 9, 'rgba(255,150,50,');
          addFx(F_LSMOKE, mz.x, mz.y, mz.z, 0, 0, 0, 1.1, 8);
          addFx(F_LSMOKE, mz.x - Math.cos(src ? (src.dir || 0) : 0) * 6, mz.y - Math.sin(src ? (src.dir || 0) : 0) * 6, mz.z - 2, 0, 0, 0, 0.8, 6);
        } else addFx(F_FLASH, mz.x, mz.y, mz.z, 0, 0, 0, 0.1, e.w === 'cannon' ? (src && src.type === 'colossus' ? 15 : 11) : 8);
        if (e.w === 'cannon') addFx(F_SMOKE, mz.x, mz.y, mz.z, 0, 0, 0, src && src.type === 'howitzer' ? 1.0 : 0.6, src && src.type === 'howitzer' ? 10 : 7);
      } else if (e.t === 'hit') {
        if (!visibleAt(e.x, e.y)) continue;
        if (e.w === 'bomb') {   // v0.8: Bombeneinschlag (Teppich) bzw. Wasserfontäne
          if (waterAt(e.x, e.y)) { addFx(F_DUST, e.x, e.y, 2, 0, 0, 0, 1.1, 22, 'rgba(225,238,245,'); addFx(F_RING, e.x, e.y, 0, 0, 0, 0, 0.8, 34, 'rgba(225,238,245,'); continue; }
          addFx(F_BOOM, e.x, e.y, 4, 0, 0, 0, 0.75, 30); addFx(F_SMOKE, e.x, e.y, 14, 0, 0, 0, 1.6, 18); addFx(F_DUST, e.x, e.y, 2, 0, 0, 0, 1.0, 20, 'rgba(170,155,125,');
          addFx(F_RING, e.x, e.y, 0, 0, 0, 0, 0.5, 40, 'rgba(255,220,160,'); addDecal(e.x, e.y, 16, 45, 0); continue;
        }
        if (e.w === 'missile') {   // v0.9 Schlachtschiff-Rakete: großer Einschlag (Blitz, zwei Feuerbälle, Brand, Rauchpilz, Druckwelle, Krater) bzw. hohe Fontäne
          var sp9 = e.splash || 1.3 * TILE;
          if (waterAt(e.x, e.y)) { addFx(F_DUST, e.x, e.y, 4, 0, 0, 0, 1.4, 26, 'rgba(230,240,248,'); addFx(F_DUST, e.x, e.y, 18, 0, 0, 0, 1.1, 16, 'rgba(240,246,250,'); addFx(F_RING, e.x, e.y, 0, 0, 0, 0, 0.9, sp9 * 1.4, 'rgba(225,238,245,'); continue; }
          addFx(F_FLASH, e.x, e.y, 10, 0, 0, 0, 0.18, 30);
          addFx(F_BOOM, e.x, e.y, 6, 0, 0, 0, 0.9, 38); addFx(F_BOOM, e.x + (Math.random() - 0.5) * 14, e.y + (Math.random() - 0.5) * 14, 16, 0, 0, 0, 0.75, 24);
          addFx(F_FIRE, e.x, e.y, 3, 0, 0, 0, 1.8, 16);
          for (var h9 = 0; h9 < 4; h9++) addFx(F_SMOKE, e.x + (Math.random() - 0.5) * 12, e.y + (Math.random() - 0.5) * 12, 16 + h9 * 9, 0, 0, 0, 2.0 + h9 * 0.25, 16 + h9 * 3);
          addFx(F_DUST, e.x, e.y, 2, 0, 0, 0, 1.3, sp9 * 0.6, 'rgba(170,155,125,');
          addFx(F_RING, e.x, e.y, 0, 0, 0, 0, 0.55, sp9 * 1.7, 'rgba(255,220,160,');
          addDecal(e.x, e.y, sp9 * 0.5, 60, 0); continue;
        }
        if (e.w === 'flak' || e.w === 'rocket' || e.w === 'bullet') {   // v0.8: Treffer in der Luft → Sprengwolke in Flughöhe
          var ha = airNear(e.x, e.y, e.w === 'flak' ? 40 : 22);
          if (ha || e.w === 'flak') { addFx(F_FLAK, e.x + (Math.random() - 0.5) * 8, e.y, (ha ? ha.alt || 0 : 1) * D.AIR_H * TILE + 4, 0, 0, 0, 1.1, e.w === 'rocket' ? 13 : 10); continue; }
        }
        if (e.w === 'laser' || e.w === 'lightning') { addDecal(e.x, e.y, 5, 16, 0); continue; } // Energiewaffen: Glühen kommt vom Schuss
        if (e.w === 'sniper') { addFx(F_DUST, e.x, e.y, 3, 0, 0, 0, 0.35, 5, 'rgba(190,175,150,'); addFx(F_FLASH, e.x, e.y, 5, 0, 0, 0, 0.1, 5); continue; }
        if (e.w === 'flame') { addFx(F_FIRE, e.x, e.y, 3, 0, 0, 0, 0.7, 13); addDecal(e.x, e.y, 9, 40, 0); continue; }
        addFx(F_BOOM, e.x, e.y, 2, 0, 0, 0, 0.4, e.w === 'cannon' ? 15 : 10);
        addDecal(e.x, e.y, e.w === 'cannon' ? 9 : 6, 22, 0);
      } else if (e.t === 'die') {
        if (e.inside || !visibleAt(e.x, e.y)) continue;   // v0.8: Insassen eines Transporters ohne eigenen Effekt
        var Pd = S.players[e.owner];
        if (Pd && e.kind === 'unit' && (V8U[e.type] || e.type === 'dreadnought')) { delete dsv[e.id]; die8(e, Pd); continue; }
        if (e.kind === 'building') {
          var k = Math.max(e.w || 1, e.h || 1);
          for (var b = 0; b < 3; b++) addFx(F_BOOM, e.x + (Math.random() - 0.5) * (e.w || 1) * TILE * 0.6, e.y + (Math.random() - 0.5) * (e.h || 1) * TILE * 0.6, 8 + b * 6, 0, 0, 0, 0.8 + b * 0.15, 18 + 8 * k);
          addDecal(e.x, e.y, k * TILE * 0.7, 40, 0);
        } else if (isInf(e.type)) {
          addFx(F_BOOM, e.x, e.y, 4, 0, 0, 0, 0.35, 8); addDecal(e.x, e.y, 5, 12, 0);
        } else {
          addFx(F_BOOM, e.x, e.y, 6, 0, 0, 0, 0.7, 24);
          addFx(F_SMOKE, e.x, e.y, 10, 0, 0, 0, 1.4, 14);
          if (Pd) addDecal(e.x, e.y, 14, 10, 1, { type: e.type, dir: e.dir || 0, tdir: e.tdir || 0 });
        }
      } else if (e.t === 'enter' || e.t === 'exit') {
        var gb = G.Sim.get(e.id);
        if (gb && !gb.dead && (S.settings.fogOff || G.Sim.isVisible(V.pid, gb))) addFx(F_RING, gb.x, gb.y + gb.h * TILE * 0.4, 0, 0, 0, 0, 0.4, 14, 'rgba(235,225,200,');
      } else if (e.t === 'capture') {
        var cb = G.Sim.get(e.id), cp = S.players[e.owner];
        if (cb && !cb.dead && cp && (S.settings.fogOff || G.Sim.isVisible(V.pid, cb))) addFx(F_RING, cb.x, cb.y, 0, 0, 0, 0, 1.0, Math.max(cb.w, cb.h) * TILE * 0.9, cp.color);
      } else if (e.t === 'ruin') {
        var rb = G.Sim.get(e.id);
        if (rb && (S.settings.fogOff || G.Sim.isVisible(V.pid, rb))) {
          for (var rq = 0; rq < 4; rq++) addFx(F_BOOM, rb.x + (Math.random() - 0.5) * rb.w * TILE * 0.7, rb.y + (Math.random() - 0.5) * rb.h * TILE * 0.7, 10 + rq * 5, 0, 0, 0, 0.7, 20);
          addDecal(rb.x, rb.y, Math.max(rb.w, rb.h) * TILE * 0.7, 60, 0);
        }
      } else if (e.t === 'arty') {
        var ab = G.Sim.get(e.id);
        if (ab) {
          var pl = S.players[ab.owner], own = ab.owner === V.pid;
          artyFx.push({ x: e.x, y: e.y, t0: fxTime, dur: (D.ARTY && D.ARTY.delay) || 2, color: pl ? pl.color : '#ffffff', show: own || visibleAt(e.x, e.y) });
          if (ab) addFx(F_FLASH, ab.x, ab.y, 14, 0, 0, 0, 0.2, 14);
        }
      } else if (e.t === 'artyHit') {
        if (visibleAt(e.x, e.y)) { addFx(F_BOOM, e.x, e.y, 3, 0, 0, 0, 0.8, 34); addFx(F_RING, e.x, e.y, 0, 0, 0, 0, 0.6, 30, 'rgba(220,200,160,'); addDecal(e.x, e.y, 18, 50, 0); }
      } else if (e.t === 'swLaunch') {
        if (e.t2 > S.tick - 2) swList.push({ kind: e.kind, owner: e.owner, x: e.x, y: e.y, t0: e.tick, t2: e.t2, sx: e.sx != null ? e.sx : e.x, sy: e.sy != null ? e.sy : e.y });
        if (swList.length > 6) swList.shift();
        if (e.kind === 'missile') addFx(F_FLASH, e.sx, e.sy, 16, 0, 0, 0, 0.3, 26);
      } else if (e.t === 'swHit' && e.kind === 'psi') {   // v1.0 PLATZHALTER v1.0: Psi-Welle = Ringe statt Explosion
        for (var pwi = swList.length - 1; pwi >= 0; pwi--) if (swList[pwi].kind === 'psi') swList.splice(pwi, 1);
        for (var pr = 0; pr < 3; pr++) addFx(F_RING, e.x, e.y, 0, 0, 0, 0, 0.7 + pr * 0.25, (e.r || 3.5 * TILE) * 2.1, 'rgba(165,180,252,');
      } else if (e.t === 'swHit') {
        for (var wi = swList.length - 1; wi >= 0; wi--) if (swList[wi].kind === e.kind && Math.abs(swList[wi].x - e.x) < 2 && Math.abs(swList[wi].y - e.y) < 2) swList.splice(wi, 1);
        swBlasts.push({ kind: e.kind, x: e.x, y: e.y, r: e.r || SW_R[e.kind] * TILE, t0: fxTime });
        if (swBlasts.length > 4) swBlasts.shift();
        addDecal(e.x, e.y, (e.r || SW_R[e.kind] * TILE) * 0.55, 120, 2);
      } else if (e.t === 'swReady' || e.t === 'swBuilt') {
        var sb = G.Sim.get(e.id);
        if (sb && !sb.dead) addFx(F_RING, sb.x, sb.y, 0, 0, 0, 0, e.t === 'swReady' ? 1.0 : 0.7, Math.max(sb.w, sb.h) * TILE * 1.1, e.t === 'swReady' ? 'rgba(255,255,255,' : 'rgba(225,205,160,');
      } else if (e.t === 'deploy') {
        var db = G.Sim.get(e.id);
        if (!db || db.dead || db.kind !== 'building') { // id = Einheit? dann jüngstes HQ des Besitzers suchen
          db = null;
          for (var di = S.ents.length - 1; di >= 0; di--) { var de = S.ents[di]; if (de.kind === 'building' && de.type === 'hq' && de.owner === e.owner && !de.dead && S.tick - (de.placedT == null ? -100 : de.placedT) < 10) { db = de; break; } }
        }
        if (db && (S.settings.fogOff || db.owner === V.pid || G.Sim.isVisible(V.pid, db))) {
          deployFx[db.id] = { t0: fxTime, cx: db.x, cy: db.y, dir: e.dir || 0 };
          addFx(F_RING, db.x, db.y, 0, 0, 0, 0, 1.2, 3.2 * TILE, 'rgba(225,205,160,');
          for (var dk = 0; dk < 4; dk++) addFx(F_DUST, db.x + (dk & 1 ? 1 : -1) * 1.3 * TILE, db.y + (dk & 2 ? 1 : -1) * 1.3 * TILE, 2, 0, 0, 0, 1.3 + dk * 0.1, 13, 'rgba(170,155,125,');
        }
      } else if (e.t === 'wall') {
        var wids = e.ids || [];
        for (var wk = 0; wk < wids.length && wk < 14; wk++) {
          var wb = G.Sim.get(wids[wk]);
          if (wb && !wb.dead && (S.settings.fogOff || wb.owner === V.pid || G.Sim.isVisible(V.pid, wb))) addFx(F_DUST, wb.x, wb.y, 2, 0, 0, 0, 0.7, 7, 'rgba(185,175,150,');
        }
      } else if (e.t === 'heal') { // v0.7 Sanitäter: grünes Plus pulsiert auf dem Ziel
        var hm = G.Sim.get(e.id), ht = G.Sim.get(e.tid);
        if (ht && !ht.dead && (S.settings.fogOff || ht.owner === V.pid || G.Sim.isVisible(V.pid, ht))) {
          addFx(F_HEAL, ht.x, ht.y, 0, hm ? hm.x : ht.x, hm ? hm.y : ht.y, 0, 0.95, 1);
        }
      } else if (e.t === 'takeoff' || e.t === 'land' || e.t === 'beach') {   // v0.8: Abwind (Staub/Gischt) bzw. Bugklappe
        evt8(e, S);
      } else if (e.t === 'load' || e.t === 'unload') { // v0.7 Schützenpanzer: Ring am Fahrzeug
        var ap = G.Sim.get(e.id);
        if (ap && ap.mc >= 2) { evt8(e, S); continue; }
        if (ap && !ap.dead && (S.settings.fogOff || ap.owner === V.pid || G.Sim.isVisible(V.pid, ap))) {
          var bka = (ap.dir || 0) + Math.PI, nd = e.t === 'load' ? 2 : 4; // v0.7-deco: Staubpuffs am Heck (statt nur Ring)
          for (var dq = 0; dq < nd; dq++) addFx(F_DUST, ap.x + Math.cos(bka) * 12 + (hash(dq, e.seq | 0, 3) - 0.5) * 12, ap.y + Math.sin(bka) * 12 + (hash(dq, e.seq | 0, 4) - 0.5) * 12, 2, 0, 0, 0, 0.6 + dq * 0.08, e.t === 'load' ? 6 : 8, 'rgba(185,172,145,');
          if (e.t === 'unload') addFx(F_RING, ap.x, ap.y, 0, 0, 0, 0, 0.45, 20, 'rgba(235,225,200,');
        }
      } else if (e.t === 'place' || e.t === 'sell') {
        var bd = D.BUILDINGS[e.type];
        addFx(F_RING, e.x, e.y, 0, 0, 0, 0, 0.6, bd ? Math.max(bd.w, bd.h) * TILE * 0.8 : 30, 'rgba(225,205,160,');
      }
    }
    if (ev.length) lastSeq = Math.max(lastSeq, ev[ev.length - 1].seq);
  }
  function groundEllipse(x, y, rw, rh) { ctx.beginPath(); ctx.ellipse(x, y, Math.max(0.5, rw), Math.max(0.5, rh), 0, 0, 6.2832); }
  function drawDecals() {
    for (var i = decals.length - 1; i >= 0; i--) {
      var d = decals[i], a = (fxTime - d.t0) / d.life;
      if (a >= 1) { decals.splice(i, 1); continue; }
      var X = PX(d.x, d.y), Y = PY(d.x, d.y);
      if (X < -60 || Y < -60 || X > V.vw + 60 || Y > V.vh + 60) continue;
      if (d.kind === 2) { // Brandfleck großer Einschläge
        var fa = Math.min(1, (1 - a) * 3), rr = d.r;
        ctx.fillStyle = 'rgba(14,11,8,' + (0.34 * fa).toFixed(2) + ')'; groundEllipse(X, Y, rr * 1.35 * kx, rr * 1.35 * ky); ctx.fill();
        ctx.fillStyle = 'rgba(8,6,4,' + (0.5 * fa).toFixed(2) + ')'; groundEllipse(X, Y, rr * 0.9 * kx, rr * 0.9 * ky); ctx.fill();
        ctx.strokeStyle = 'rgba(8,6,4,' + (0.4 * fa).toFixed(2) + ')'; ctx.lineWidth = 2; ctx.beginPath();
        for (var sp = 0; sp < 9; sp++) { var an = sp * 0.698 + hash(sp, 3, 9), ln = rr * (1.2 + hash(sp, 4, 9) * 0.6); ctx.moveTo(X + Math.cos(an) * rr * 0.8 * kx, Y + Math.sin(an) * rr * 0.8 * ky); ctx.lineTo(X + Math.cos(an) * ln * kx, Y + Math.sin(an) * ln * ky); }
        ctx.stroke(); continue;
      }
      if (d.kind === 1 && d.e) { ctx.globalAlpha = Math.min(1, (1 - a) * 2); if (!(spOn() && spVehicle(d.e.type, facOf(d.e.owner), X, Y, d.e.dir || 0, d.e.tdir || 0, { wreck: true }))) drawVehicle(d.e.type, X, Y, d.e.dir, d.e.tdir, '#333', false, 0, 0, true); ctx.globalAlpha = 1; }
      else { ctx.fillStyle = 'rgba(15,12,8,' + (0.45 * (1 - a)).toFixed(2) + ')'; groundEllipse(X, Y, d.r * kx, d.r * ky); ctx.fill(); }
    }
  }
  function drawFx(dt) {
    var i, f, fr, X, Y, Z;
    for (i = 0; i < fxN; i++) {
      f = fxList[i]; f.age += dt;
      if (f.age >= f.life) { var l = fxList[fxN - 1]; fxList[fxN - 1] = f; fxList[i] = l; fxN--; i--; continue; }
      fr = f.age / f.life; Z = f.z * kx * HK;
      X = PX(f.x, f.y); Y = PY(f.x, f.y) - Z;
      if ((X < -80 || Y < -80 || X > V.vw + 80 || Y > V.vh + 120) && f.t !== F_SNIPE && f.t !== F_FLAME) continue;
      if (f.t === F_TRACER) {
        ctx.strokeStyle = 'rgba(255,238,150,' + (1 - fr).toFixed(2) + ')'; ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(X, Y); ctx.lineTo(PX(f.x2, f.y2), PY(f.x2, f.y2) - f.z2 * kx * HK); ctx.stroke();
      } else if (f.t === F_SNIPE) { drawSnipe(f, X, Y, fr);
      } else if (f.t === F_FLAME) { drawFlame(f, X, Y, fr);
      } else if (f.t === F_HEAL) { drawHeal(f, fr);
      } else if (f.t === F_FIRE) {
        var fr3 = f.size * kx * (0.4 + fr * 0.6), fl2 = 0.7 + 0.3 * Math.sin(f.age * 50 + f.x);
        ctx.fillStyle = 'rgba(255,120,30,' + (0.55 * (1 - fr) * fl2).toFixed(2) + ')'; ctx.beginPath(); ctx.ellipse(X, Y - fr3 * 0.5, fr3 * 0.8, fr3 * 1.1, 0, 0, 6.2832); ctx.fill();
        ctx.fillStyle = 'rgba(255,220,110,' + (0.8 * (1 - fr) * fl2).toFixed(2) + ')'; ctx.beginPath(); ctx.ellipse(X, Y - fr3 * 0.45, fr3 * 0.42, fr3 * 0.65, 0, 0, 6.2832); ctx.fill();
      } else if (f.t === F_LSMOKE) {
        var lr = f.size * kx * (0.6 + fr * 1.5);
        ctx.fillStyle = 'rgba(205,200,190,' + (0.55 * (1 - fr) * (1 - fr)).toFixed(2) + ')'; ctx.beginPath(); ctx.arc(X + fr * 5, Y - fr * 16, lr, 0, 6.2832); ctx.fill();
      } else if (f.t === F_FLASH) {
        ctx.fillStyle = 'rgba(255,225,130,' + (1 - fr).toFixed(2) + ')';
        ctx.beginPath(); ctx.arc(X, Y, f.size * kx * 0.6 * (1 - fr * 0.4), 0, 6.2832); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,' + (0.9 * (1 - fr)).toFixed(2) + ')';
        ctx.beginPath(); ctx.arc(X, Y, f.size * kx * 0.28, 0, 6.2832); ctx.fill();
      } else if (f.t === F_BOOM) {
        var r = f.size * kx * (0.35 + fr * 0.75);
        ctx.fillStyle = 'rgba(60,55,50,' + (0.45 * (1 - fr)).toFixed(2) + ')';
        ctx.beginPath(); ctx.arc(X + 2, Y - r * 0.5 - fr * 10, r * 0.8, 0, 6.2832); ctx.fill();
        ctx.fillStyle = 'rgba(255,' + (170 - fr * 120 | 0) + ',50,' + (0.9 * (1 - fr)).toFixed(2) + ')';
        ctx.beginPath(); ctx.arc(X, Y - r * 0.2, r, 0, 6.2832); ctx.fill();
        ctx.fillStyle = 'rgba(255,240,170,' + (0.85 * (1 - fr)).toFixed(2) + ')';
        ctx.beginPath(); ctx.arc(X, Y - r * 0.2, r * 0.5 * (1 - fr), 0, 6.2832); ctx.fill();
      } else if (f.t === F_FLAK) {   // v0.8: Flak-Sprengwolke (Blitz, dann schwarze Wolke)
        var fr8 = f.size * kx * (0.45 + Math.sqrt(fr) * 0.75);
        if (fr < 0.18) { ctx.fillStyle = 'rgba(255,215,140,' + (1 - fr / 0.18).toFixed(2) + ')'; ctx.beginPath(); ctx.arc(X, Y, fr8 * 0.8, 0, 6.2832); ctx.fill(); }
        ctx.fillStyle = 'rgba(28,28,30,' + (0.75 * (1 - fr)).toFixed(2) + ')';
        ctx.beginPath(); ctx.arc(X, Y - fr * 6, fr8, 0, 6.2832); ctx.arc(X + fr8 * 0.7, Y - fr * 6 + fr8 * 0.2, fr8 * 0.7, 0, 6.2832); ctx.arc(X - fr8 * 0.6, Y - fr * 6 + fr8 * 0.25, fr8 * 0.65, 0, 6.2832); ctx.fill();
      } else if (f.t === F_TRAIL) {   // v0.9: bleibende Rauchspur der Schlachtschiff-Rakete (wächst, sinkt leicht, verblasst)
        ctx.fillStyle = 'rgba(226,224,218,' + (0.5 * (1 - fr) * (1 - fr)).toFixed(2) + ')';
        ctx.beginPath(); ctx.arc(X, Y + fr * 4, f.size * kx * (0.6 + fr * 1.7), 0, 6.2832); ctx.fill();
      } else if (f.t === F_SMOKE) {
        ctx.fillStyle = 'rgba(80,78,74,' + (0.5 * (1 - fr)).toFixed(2) + ')';
        ctx.beginPath(); ctx.arc(X, Y - fr * 22, f.size * kx * (0.4 + fr * 0.7), 0, 6.2832); ctx.fill();
      } else if (f.t === F_BEAM) {
        var X2 = PX(f.x2, f.y2), Y2 = PY(f.x2, f.y2) - f.z2 * kx * HK, ba = 1 - fr * fr;
        ctx.lineCap = 'round';
        ctx.strokeStyle = 'rgba(255,40,40,' + (0.28 * ba).toFixed(2) + ')'; ctx.lineWidth = 11 * clamp(zoomK, 0.8, 1.4); ctx.beginPath(); ctx.moveTo(X, Y); ctx.lineTo(X2, Y2); ctx.stroke();
        ctx.strokeStyle = 'rgba(255,90,70,' + (0.75 * ba).toFixed(2) + ')'; ctx.lineWidth = 5 * clamp(zoomK, 0.8, 1.4); ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,245,' + ba.toFixed(2) + ')'; ctx.lineWidth = 2 * clamp(zoomK, 0.8, 1.4); ctx.stroke();
        ctx.lineCap = 'butt';
      } else if (f.t === F_PSIB) {   // v1.0 (PLATZHALTER v1.0): welliger farbiger Strahl
        var PX2 = PX(f.x2, f.y2), PY2 = PY(f.x2, f.y2) - f.z2 * kx * HK, pa = 1 - fr;
        ctx.strokeStyle = f.col + (0.3 * pa).toFixed(2) + ')'; ctx.lineWidth = 10 * clamp(zoomK, 0.8, 1.4); ctx.beginPath(); ctx.moveTo(X, Y); ctx.lineTo(PX2, PY2); ctx.stroke();
        ctx.strokeStyle = f.col + (0.9 * pa).toFixed(2) + ')'; ctx.lineWidth = 3 * clamp(zoomK, 0.8, 1.4); ctx.setLineDash([5, 4]); ctx.lineDashOffset = -fxTime * 60; ctx.stroke(); ctx.setLineDash([]); ctx.lineDashOffset = 0;
      } else if (f.t === F_GLOW) {
        var gr = f.size * kx * (0.5 + 0.5 * fr), ga = 1 - fr;
        ctx.fillStyle = f.col + (0.35 * ga).toFixed(2) + ')'; ctx.beginPath(); ctx.arc(X, Y, gr * 1.5, 0, 6.2832); ctx.fill();
        ctx.fillStyle = f.col + (0.8 * ga).toFixed(2) + ')'; ctx.beginPath(); ctx.arc(X, Y, gr * 0.9, 0, 6.2832); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,' + (0.95 * ga).toFixed(2) + ')'; ctx.beginPath(); ctx.arc(X, Y, gr * 0.42, 0, 6.2832); ctx.fill();
      } else if (f.t === F_DUST) {
        var dr2 = f.size * kx * (0.5 + fr * 1.1);
        ctx.fillStyle = f.col + (0.5 * (1 - fr)).toFixed(2) + ')'; groundEllipse(X, Y - fr * 6, dr2, dr2 * 0.6); ctx.fill();
      } else if (f.t === F_RING) {
        ctx.strokeStyle = f.col.charAt(0) === '#' ? f.col : f.col + (0.8 * (1 - fr)).toFixed(2) + ')';
        ctx.globalAlpha = f.col.charAt(0) === '#' ? 1 - fr : 1; ctx.lineWidth = 3;
        groundEllipse(X, Y, f.size * (0.3 + 0.7 * fr) * kx, f.size * (0.3 + 0.7 * fr) * ky); ctx.stroke(); ctx.globalAlpha = 1;
      }
    }
  }
  /** v0.7 Scharfschuss: dünne, sehr schnelle Leuchtspur (Kopf fliegt in ~45 ms, Schweif folgt) + schwacher Nachglanz */
  function drawSnipe(f, X, Y, fr) {
    var X2 = PX(f.x2, f.y2), Y2 = PY(f.x2, f.y2) - f.z2 * kx * HK, h = Math.min(1, f.age / 0.045), tl = clamp((f.age - 0.02) / 0.1, 0, 1);
    var hx = X + (X2 - X) * h, hy = Y + (Y2 - Y) * h, tx = X + (X2 - X) * tl, ty = Y + (Y2 - Y) * tl, zk = clamp(zoomK, 0.8, 1.4);
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(170,205,255,' + (0.18 * (1 - fr)).toFixed(2) + ')'; ctx.lineWidth = 1 * zk; ctx.beginPath(); ctx.moveTo(X, Y); ctx.lineTo(X2, Y2); ctx.stroke();
    if (tl < 1) {
      ctx.strokeStyle = 'rgba(160,200,255,0.45)'; ctx.lineWidth = 3.2 * zk; ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(hx, hy); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.97)'; ctx.lineWidth = 1.1 * zk; ctx.stroke();
    }
    ctx.lineCap = 'butt';
  }
  /** v0.7 Flammenwerfer: flackernder Kegel aus Feuerteilchen von der Düse zum Ziel (Teilchen wandern, Form wechselt ~28×/s).
   *  Je Farbschicht ein einziger Pfad (4 Füllungen statt ~80) – spart Zeichenzeit. */
  var flX = new Float32Array(28), flY = new Float32Array(28), flR = new Float32Array(28), flQ = new Float32Array(28);
  function drawFlame(f, X, Y, fr) {
    var dxw = f.x2 - f.x, dyw = f.y2 - f.y, len = Math.hypot(dxw, dyw) || 1, ux = dxw / len, uy = dyw / len, px = -uy, py = ux, sd = Math.floor(f.age * 28);
    var env = Math.min(1, f.age / 0.06) * (fr > 0.7 ? 1 - (fr - 0.7) / 0.3 : 1), N = 26, i, zk = kx / 1.25;
    for (i = 0; i < N; i++) {
      var q = 1 - (1 - ((i + 0.5) / N + f.age * 2.2) % 1), j = hash(sd, i, 91) - 0.5, wob = hash(sd, i, 92) - 0.5, sp = len * 0.22 * q;
      var wx = f.x + dxw * q * 0.98 + px * j * 2 * sp + ux * wob * 5, wy = f.y + dyw * q * 0.98 + py * j * 2 * sp + uy * wob * 5;
      var zz = (f.z + (f.z2 - f.z) * q + q * 9 + Math.abs(j) * 8) * kx * HK;
      flX[i] = PX(wx, wy); flY[i] = PY(wx, wy) - zz; flR[i] = (1.8 + 6.2 * Math.sqrt(q)) * zk * (0.75 + 0.5 * hash(sd, i, 93)); flQ[i] = q;
    }
    ctx.fillStyle = 'rgba(55,40,32,' + (0.2 * env).toFixed(2) + ')'; ctx.beginPath(); // Rauch am Strahlende
    for (i = 0; i < N; i++) if (flQ[i] > 0.62) { ctx.moveTo(flX[i] + flR[i] * 0.9, flY[i] - 2); ctx.arc(flX[i], flY[i] - 2, flR[i] * 0.9, 0, 6.2832); }
    ctx.fill();
    ctx.fillStyle = 'rgba(230,60,20,' + (0.5 * env).toFixed(2) + ')'; ctx.beginPath();
    for (i = 0; i < N; i++) { ctx.moveTo(flX[i] + flR[i], flY[i]); ctx.arc(flX[i], flY[i], flR[i], 0, 6.2832); }
    ctx.fill();
    ctx.fillStyle = 'rgba(255,150,30,' + (0.78 * env).toFixed(2) + ')'; ctx.beginPath();
    for (i = 0; i < N; i++) { ctx.moveTo(flX[i] + flR[i] * 0.66, flY[i]); ctx.arc(flX[i], flY[i], flR[i] * 0.66, 0, 6.2832); }
    ctx.fill();
    ctx.fillStyle = 'rgba(255,235,150,' + (0.9 * env).toFixed(2) + ')'; ctx.beginPath();
    for (i = 0; i < N; i++) if (flQ[i] < 0.7) { ctx.moveTo(flX[i] + flR[i] * 0.34, flY[i]); ctx.arc(flX[i], flY[i], flR[i] * 0.34, 0, 6.2832); }
    ctx.fill();
    ctx.fillStyle = 'rgba(255,245,200,' + (0.9 * env).toFixed(2) + ')'; ctx.beginPath(); ctx.arc(X, Y, (2.4 + 1.8 * hash(sd, 7, 94)) * zk, 0, 6.2832); ctx.fill();
    if (fr < 0.6) { // Brandglut am Ziel
      var tx = PX(f.x2, f.y2), ty = PY(f.x2, f.y2);
      ctx.fillStyle = 'rgba(255,110,30,' + (0.25 * env).toFixed(2) + ')'; groundEllipse(tx, ty, 10 * kx, 10 * ky); ctx.fill();
    }
  }
  /** v0.7 Sanitäter: Verbindungsfaden, Bodenring und aufsteigendes grünes Plus (zwei Pulse) auf dem Ziel */
  function drawHeal(f, fr) {
    var tx = PX(f.x, f.y), ty = PY(f.x, f.y), mx = PX(f.x2, f.y2), my = PY(f.x2, f.y2), zk = clamp(zoomK, 0.8, 1.5), k;
    if (Math.abs(mx - tx) + Math.abs(my - ty) > 2 && fr < 0.55) {
      ctx.strokeStyle = 'rgba(110,235,160,' + (0.7 * (1 - fr / 0.55)).toFixed(2) + ')'; ctx.lineWidth = 1.6; ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.moveTo(mx, my - 10 * kx * HK); ctx.lineTo(tx, ty - 10 * kx * HK); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.strokeStyle = 'rgba(90,240,150,' + (0.8 * (1 - fr)).toFixed(2) + ')'; ctx.lineWidth = 2.2;
    groundEllipse(tx, ty, (6 + 13 * fr) * kx, (6 + 13 * fr) * ky); ctx.stroke();
    for (k = 0; k < 2; k++) {
      var q = clamp((fr - k * 0.3) / 0.7, 0, 1); if (q <= 0 || q >= 1) continue;
      var a = Math.sin(q * Math.PI), cy = ty - (12 + 20 * q) * zk, s = (k ? 6.2 : 8.5) * zk, th = 3.4 * zk;
      ctx.fillStyle = 'rgba(8,40,22,' + (0.55 * a).toFixed(2) + ')'; ctx.fillRect(tx - s - 1.5, cy - th / 2 - 1.5, 2 * s + 3, th + 3); ctx.fillRect(tx - th / 2 - 1.5, cy - s - 1.5, th + 3, 2 * s + 3);
      ctx.fillStyle = 'rgba(70,235,130,' + a.toFixed(2) + ')'; ctx.fillRect(tx - s, cy - th / 2, 2 * s, th); ctx.fillRect(tx - th / 2, cy - s, th, 2 * s);
      ctx.fillStyle = 'rgba(220,255,230,' + (0.8 * a).toFixed(2) + ')'; ctx.fillRect(tx - s, cy - th / 2, 2 * s, 1); ctx.fillRect(tx - th / 2, cy - s, 1, 2 * s);
    }
    for (k = 0; k < 4; k++) { // Glitzerpunkte
      var gq = clamp((fr - k * 0.08) / 0.8, 0, 1); if (gq <= 0 || gq >= 1) continue;
      ctx.fillStyle = 'rgba(150,255,190,' + (0.8 * (1 - gq)).toFixed(2) + ')';
      ctx.beginPath(); ctx.arc(tx + (hash(k, 3, 8) - 0.5) * 22 * zk, ty - (6 + 22 * gq) * zk, 1.8 * zk, 0, 6.2832); ctx.fill();
    }
  }
  /** Blitze (Blitzturm): zackige, verzweigte Linie je Kettenglied; Form flackert alle ~22 ms neu, Dauer 0,2 s */
  function drawBolts(dt) {
    var zk = clamp(zoomK, 0.8, 1.4);
    for (var bi = bolts.length - 1; bi >= 0; bi--) {
      var bo = bolts[bi]; bo.age += dt;
      if (bo.age >= bo.life) { bolts.splice(bi, 1); continue; }
      var fr = bo.age / bo.life, sd = bo.seed * 13 + Math.floor(bo.age * 45), fl = 0.6 + 0.4 * hash(sd, 5, 1), al = (1 - fr * fr) * fl;
      var polys = [], br = [], i, k, main;
      for (i = 0; i + 1 < bo.pts.length; i++) {
        var A = bo.pts[i], B = bo.pts[i + 1], ax = PX(A.x, A.y), ay = PY(A.x, A.y) - A.z * kx * HK, bx = PX(B.x, B.y), by = PY(B.x, B.y) - B.z * kx * HK;
        var dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len, n = Math.max(3, Math.round(len / 13)), amp = Math.min(10, 3 + len * 0.1) * zk;
        main = [ax, ay]; polys.push(main);
        for (k = 1; k < n; k++) {
          var t = k / n, j = (hash(sd, i * 31 + k, 2) - 0.5) * 2 * amp, qx = ax + dx * t + nx * j, qy = ay + dy * t + ny * j;
          main.push(qx, qy);
          if (hash(sd, i * 31 + k, 3) > 0.62) { // Abzweig
            var ang = (hash(sd, i * 31 + k, 4) - 0.5) * 2.2, ca = Math.cos(ang), sa = Math.sin(ang), bl = (16 + hash(sd, i * 31 + k, 6) * 26) * zk;
            var ddx = (dx * ca - dy * sa) / len, ddy = (dx * sa + dy * ca) / len, m1x = qx + ddx * bl * 0.5 + nx * (hash(sd, k, 7) - 0.5) * 8, m1y = qy + ddy * bl * 0.5 + ny * (hash(sd, k, 7) - 0.5) * 8;
            br.push(qx, qy, m1x, m1y, qx + ddx * bl, qy + ddy * bl);
          }
        }
        main.push(bx, by);
      }
      // Hauptlinie in drei Strichen
      for (var pass = 0; pass < 3; pass++) {
        ctx.beginPath();
        for (i = 0; i < polys.length; i++) {
          main = polys[i]; ctx.moveTo(main[0], main[1]);
          for (k = 2; k < main.length; k += 2) ctx.lineTo(main[k], main[k + 1]);
        }
        ctx.lineJoin = 'round';
        if (pass === 0) { ctx.strokeStyle = 'rgba(120,110,255,' + (0.30 * al).toFixed(2) + ')'; ctx.lineWidth = 9 * zk; }
        else if (pass === 1) { ctx.strokeStyle = 'rgba(170,190,255,' + (0.9 * al).toFixed(2) + ')'; ctx.lineWidth = 3.4 * zk; }
        else { ctx.strokeStyle = 'rgba(255,255,255,' + al.toFixed(2) + ')'; ctx.lineWidth = 1.4 * zk; }
        ctx.stroke();
      }
      if (br.length) {
        ctx.beginPath();
        for (i = 0; i < br.length; i += 6) { ctx.moveTo(br[i], br[i + 1]); ctx.lineTo(br[i + 2], br[i + 3]); ctx.lineTo(br[i + 4], br[i + 5]); }
        ctx.strokeStyle = 'rgba(170,190,255,' + (0.75 * al).toFixed(2) + ')'; ctx.lineWidth = 2 * zk; ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,' + (0.8 * al).toFixed(2) + ')'; ctx.lineWidth = 0.9 * zk; ctx.stroke();
      }
      ctx.lineJoin = 'miter';
    }
  }
  function drawArtyFx() {
    for (var i = artyFx.length - 1; i >= 0; i--) {
      var a = artyFx[i], t = fxTime - a.t0;
      if (t > a.dur + 0.4) { artyFx.splice(i, 1); continue; }
      if (!a.show) continue;
      var X = PX(a.x, a.y), Y = PY(a.x, a.y), fr = Math.min(1, t / a.dur), pu = 0.6 + 0.4 * Math.sin(fxTime * 16), R = 2 * TILE;
      ctx.lineWidth = 3; ctx.strokeStyle = a.color; ctx.globalAlpha = pu;
      groundEllipse(X, Y, R * kx, R * ky); ctx.stroke();
      groundEllipse(X, Y, R * kx * (1 - fr * 0.85), R * ky * (1 - fr * 0.85)); ctx.stroke(); ctx.globalAlpha = 1;
      if (t < a.dur) for (var s = 0; s < 6; s++) { // Granaten im Anflug
        var ox = (hash(s, 1, 5) - 0.5) * R * 1.5, oy = (hash(s, 2, 5) - 0.5) * R * 1.5, h = (1 - fr) * (1 - fr) * 260 + 4;
        var gxs = X + MUA * ox + MVA * oy, gys = Y + MUB * ox + MVB * oy;
        ctx.strokeStyle = 'rgba(40,40,40,.8)'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(gxs, gys - h); ctx.lineTo(gxs, gys - h - 9); ctx.stroke();
        ctx.fillStyle = '#e0c060'; ctx.fillRect(gxs - 1.5, gys - h - 1, 3, 3);
      }
    }
  }

  // ------------------------------------------------------------------ Einheiten
  var OUT = 'rgba(8,10,14,0.85)';
  /** Fahrzeug an Bildschirmposition (X,Y = Bodenpunkt). Schichten von unten nach oben erzeugen die Körperhöhe. */
  function setT(rot, X, Y, lift) {
    var c = Math.cos(rot + YAWA), s = Math.sin(rot + YAWA);
    ctx.setTransform(dpr * kx * c, dpr * ky * s, -dpr * kx * s, dpr * ky * c, dpr * X, dpr * (Y - lift));
  }
  function resetT() { ctx.setTransform(dpr, 0, 0, dpr, 0, 0); }
  var VDIM = { harvester: [32, 24, 9], tank: [28, 21, 8], hunter: [30, 18, 6.5], colossus: [37, 30, 11], howitzer: [30, 21, 7], mcv: [42, 28, 12],
    apc: [32, 19, 7], lasertank: [35, 23, 8], mlrs: [40, 22, 9], shocktank: [36, 28, 10] };
  var NEWV = { apc: 1, lasertank: 1, mlrs: 1, shocktank: 1 }; // v0.7: eigene Zeichnung in drawNewVehicle
  var UE = null; // gerade gezeichnete Einheit (für Zustände wie Nachladen, Passagiere); null bei Wracks
  function drawVehicle(type, X, Y, dir, tdir, color, moving, recoil, cargo, wreck, bar) {
    if (NEWV[type]) { drawNewVehicle(type, X, Y, dir, tdir, color, moving, recoil, wreck); return; }
    var dm = VDIM[type] || [23, 16, 6], L = dm[0], Wd = dm[1], hh = dm[2];
    var lift = hh * kx * HK, i, c = wreck ? '#262422' : color, big = type === 'colossus';
    // Schatten (Boden)
    resetT(); ctx.fillStyle = 'rgba(0,0,0,0.32)'; groundEllipse(X + 2, Y + 2, L * 0.6 * kx, Wd * 0.55 * ky); ctx.fill();
    var track = type !== 'scout' && type !== 'raider';
    if (!track && !wreck) { // Räder
      setT(dir, X, Y, 0); ctx.fillStyle = '#0e1114';
      ctx.fillRect(-L / 2 + 1, -Wd / 2 - 2, 7, 4); ctx.fillRect(L / 2 - 8, -Wd / 2 - 2, 7, 4); ctx.fillRect(-L / 2 + 1, Wd / 2 - 2, 7, 4); ctx.fillRect(L / 2 - 8, Wd / 2 - 2, 7, 4);
    }
    // Rumpfschichten
    for (i = 0; i < 3; i++) {
      setT(dir, X, Y, lift * i / 2);
      if (i < 2) { ctx.fillStyle = track ? '#1c2128' : shade(c, 0.45); ctx.fillRect(-L / 2, -Wd / 2, L, Wd); }
      else {
        ctx.fillStyle = track ? '#2a3038' : shade(c, 0.8); ctx.fillRect(-L / 2, -Wd / 2, L, Wd); // Oberfläche / Ketten
        if (track) {
          ctx.fillStyle = '#4b5563'; var ph = moving ? (fxTime * 14) % 6 : 0;
          for (var k = -L / 2 + ph; k < L / 2 - 1; k += 6) { ctx.fillRect(k, -Wd / 2, 2, big ? 7 : 5); ctx.fillRect(k, Wd / 2 - (big ? 7 : 5), 2, big ? 7 : 5); }
          var ins = big ? 7 : 5;
          ctx.fillStyle = c; ctx.fillRect(-L / 2 + 2, -Wd / 2 + ins, L - 4, Wd - ins * 2);
          ctx.fillStyle = 'rgba(255,255,255,0.16)'; ctx.fillRect(-L / 2 + 2, -Wd / 2 + ins, L - 4, 3);
          if (type === 'hunter' && !wreck) { // Keilbug + Motorraster
            ctx.fillStyle = shade(c, 1.2); ctx.beginPath(); ctx.moveTo(L / 2 - 2, -Wd / 2 + 5); ctx.lineTo(L / 2 - 9, -Wd / 2 + 5); ctx.lineTo(L / 2 - 9, Wd / 2 - 5); ctx.lineTo(L / 2 - 2, Wd / 2 - 5); ctx.lineTo(L / 2 + 2, 0); ctx.closePath(); ctx.fill();
            ctx.fillStyle = '#10151b'; ctx.fillRect(-L / 2 + 3, -3, 6, 6);
          } else if (type === 'howitzer' && !wreck) { // Rückstoß-Spaten
            ctx.fillStyle = '#10151b'; ctx.fillRect(-L / 2 - 3, -Wd / 2 + 4, 4, Wd - 8);
            ctx.fillStyle = shade(c, 0.7); ctx.fillRect(L / 2 - 8, -Wd / 2 + 5, 6, Wd - 10);
          } else if (big && !wreck) { // Panzerplatten + Auspuff
            ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(-L / 2 + 8, -Wd / 2 + 7); ctx.lineTo(-L / 2 + 8, Wd / 2 - 7); ctx.moveTo(L / 2 - 8, -Wd / 2 + 7); ctx.lineTo(L / 2 - 8, Wd / 2 - 7); ctx.stroke();
            ctx.fillStyle = '#10151b'; ctx.fillRect(-L / 2 - 1, -Wd / 2 + 9, 3, 4); ctx.fillRect(-L / 2 - 1, Wd / 2 - 13, 3, 4);
          }
        } else {
          ctx.fillStyle = c; ctx.fillRect(-L / 2, -Wd / 2 + 1, L, Wd - 2);
          if (!wreck) { ctx.fillStyle = 'rgba(255,255,255,0.16)'; ctx.fillRect(-L / 2, -Wd / 2 + 1, L, 3); ctx.fillStyle = '#1f2937'; ctx.fillRect(-3, -Wd / 2 + 3, 8, Wd - 6); }
        }
        ctx.strokeStyle = OUT; ctx.lineWidth = 1.2; ctx.strokeRect(-L / 2, -Wd / 2, L, Wd);
      }
    }
    var hwz = false;
    if (type === 'harvester' && !wreck) {
      var fill = clamp((cargo || 0) / 700, 0, 1);
      ctx.fillStyle = '#44403c'; ctx.fillRect(-L / 2 + 4, -Wd / 2 + 5, 17, Wd - 10);
      ctx.fillStyle = '#e8c547'; ctx.fillRect(-L / 2 + 4, -Wd / 2 + 5 + (Wd - 10) * (1 - fill), 17, (Wd - 10) * fill);
      ctx.strokeStyle = OUT; ctx.lineWidth = 1; ctx.strokeRect(-L / 2 + 4, -Wd / 2 + 5, 17, Wd - 10);
      ctx.fillStyle = shade(c, 1.15); ctx.fillRect(L / 2 - 11, -Wd / 2 + 6, 8, Wd - 12); // Kabine
      ctx.fillStyle = '#9ec5e0'; ctx.fillRect(L / 2 - 5, -Wd / 2 + 7, 2, Wd - 14);
    } else if (type === 'mcv' && !wreck) { // Mobiler Bauhof: Fahrerhaus vorn, zusammengeklapptes Gebäudepaket, Kran liegt auf dem Rücken
      setT(dir, X, Y, lift);
      ctx.fillStyle = shade(c, 1.12); ctx.fillRect(L / 2 - 12, -Wd / 2 + 4, 10, Wd - 8); // Kabine
      ctx.fillStyle = '#9ec5e0'; ctx.fillRect(L / 2 - 4, -Wd / 2 + 6, 2.4, Wd - 12);
      ctx.fillStyle = 'rgba(255,255,255,0.2)'; ctx.fillRect(L / 2 - 12, -Wd / 2 + 4, 10, 2);
      ctx.strokeStyle = OUT; ctx.lineWidth = 1; ctx.strokeRect(L / 2 - 12, -Wd / 2 + 4, 10, Wd - 8);
      setT(dir, X, Y, lift + 4 * kx * HK); // Paket
      ctx.fillStyle = '#6f7684'; ctx.fillRect(-L / 2 + 3, -Wd / 2 + 4, L - 18, Wd - 8);
      ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(-L / 2 + 3, Wd / 2 - 8, L - 18, 4);
      ctx.fillStyle = '#facc15'; // Warnstreifen
      for (var hz = -L / 2 + 5; hz < L / 2 - 20; hz += 8) { ctx.beginPath(); ctx.moveTo(hz, -Wd / 2 + 4); ctx.lineTo(hz + 4, -Wd / 2 + 4); ctx.lineTo(hz + 1, -Wd / 2 + 8); ctx.lineTo(hz - 3, -Wd / 2 + 8); ctx.closePath(); ctx.fill(); }
      ctx.fillStyle = color; ctx.fillRect(-L / 2 + 3, -2, L - 18, 4); // Teamband
      ctx.strokeStyle = OUT; ctx.lineWidth = 1.2; ctx.strokeRect(-L / 2 + 3, -Wd / 2 + 4, L - 18, Wd - 8);
      ctx.strokeStyle = '#2b323b'; ctx.lineWidth = 3; ctx.lineCap = 'round'; // Kran: Gelenk hinten, Ausleger nach vorn, Haken
      ctx.beginPath(); ctx.moveTo(-L / 2 + 6, Wd / 2 - 8); ctx.lineTo(L / 2 - 17, Wd / 2 - 8); ctx.stroke();
      ctx.strokeStyle = '#d97706'; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(-L / 2 + 6, Wd / 2 - 8); ctx.lineTo(L / 2 - 17, Wd / 2 - 8); ctx.stroke(); ctx.lineCap = 'butt';
      ctx.fillStyle = '#2b323b'; ctx.beginPath(); ctx.arc(-L / 2 + 6, Wd / 2 - 8, 3, 0, 6.2832); ctx.fill();
    } else if (type !== 'harvester' && !wreck) { // Turm + Rohr
      setT(tdir, X, Y, lift + 1);
      var rc = recoil ? -3 : 0;
      ctx.fillStyle = '#10151b';
      if (type === 'tank') { ctx.fillRect(3 + rc, -2.5, 19, 5); ctx.fillStyle = shade(color, 1.12); ctx.beginPath(); ctx.arc(0, 0, 8.5, 0, 6.2832); ctx.fill(); ctx.strokeStyle = OUT; ctx.lineWidth = 1.2; ctx.stroke(); ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.arc(2, 0, 4, 0, 6.2832); ctx.fill(); }
      else if (type === 'hunter') { // niedrige Kasematte, langes flaches Rohr mit Mündungsbremse
        ctx.fillRect(4 + rc, -1.8, 24, 3.6); ctx.fillRect(25 + rc, -2.8, 5, 5.6);
        ctx.fillStyle = shade(color, 1.1); ctx.beginPath(); ctx.moveTo(-9, -6.5); ctx.lineTo(5, -5.5); ctx.lineTo(10, -2.6); ctx.lineTo(10, 2.6); ctx.lineTo(5, 5.5); ctx.lineTo(-9, 6.5); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = OUT; ctx.lineWidth = 1.2; ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.2)'; ctx.fillRect(-8, -5.6, 12, 2); ctx.fillStyle = '#9ec5e0'; ctx.fillRect(2, -4, 2.5, 2.4);
      } else if (type === 'colossus') { // breiter Turm, zwei Rohre abwechselnd
        var r0 = (recoil && bar !== 1) ? -4 : 0, r1 = (recoil && bar !== 0) ? -4 : 0;
        ctx.fillRect(5 + r0, -8.2, 24, 4.6); ctx.fillRect(5 + r1, 3.6, 24, 4.6);
        ctx.fillStyle = '#2b323b'; ctx.fillRect(26 + r0, -9, 4, 6.2); ctx.fillRect(26 + r1, 2.8, 4, 6.2);
        ctx.fillStyle = shade(color, 1.1); ctx.beginPath(); ctx.moveTo(-12, -11); ctx.lineTo(8, -12.5); ctx.lineTo(13, -7); ctx.lineTo(13, 7); ctx.lineTo(8, 12.5); ctx.lineTo(-12, 11); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = OUT; ctx.lineWidth = 1.4; ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(-11, -10, 18, 2.4);
        ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.arc(-2, 0, 4.2, 0, 6.2832); ctx.fill(); ctx.strokeStyle = OUT; ctx.lineWidth = 1; ctx.stroke();
      } else if (type === 'howitzer') { // Drehkranz + Schutzschild (Rohr folgt im Bildschirmraum)
        ctx.fillStyle = shade(color, 0.8); ctx.beginPath(); ctx.arc(-1, 0, 7.5, 0, 6.2832); ctx.fill(); ctx.strokeStyle = OUT; ctx.lineWidth = 1.2; ctx.stroke();
        ctx.fillStyle = shade(color, 1.12); ctx.fillRect(1, -7.5, 5, 15); ctx.strokeRect(1, -7.5, 5, 15);
        ctx.fillStyle = 'rgba(255,255,255,0.2)'; ctx.fillRect(1, -7.5, 5, 2);
        hwz = true;
      }
      else { ctx.fillRect(1 + rc, -1.5, 14, 3); ctx.fillStyle = '#2b323b'; ctx.beginPath(); ctx.arc(0, 0, 4.5, 0, 6.2832); ctx.fill(); ctx.strokeStyle = OUT; ctx.lineWidth = 1; ctx.stroke(); }
    }
    resetT();
    if (hwz) { // Haubitzenrohr: lang, nach oben gestellt (Stand: steil, Fahrt: flach)
      sdir(tdir);
      var el = moving ? 0.1 : 0.5, px0 = X, py0 = Y - lift - 2, ca = DX, sa = DY, rb = recoil ? 5 : 0;
      var bx0 = px0 - ca * 5, by0 = py0 - sa * 5 + el * 5 * kx * 0.5;
      var bl = 34 - rb, bx1 = px0 + ca * bl, by1 = py0 + sa * bl - el * bl * kx * 0.62;
      ctx.lineCap = 'round'; ctx.strokeStyle = 'rgba(0,0,0,0.28)'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(bx0, by0 + lift * 0.7); ctx.lineTo(bx1, by1 + lift * 0.7 + el * 6); ctx.stroke();
      ctx.strokeStyle = '#10151b'; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(bx0, by0); ctx.lineTo(bx1, by1); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(bx0, by0 - 1.5); ctx.lineTo(bx1, by1 - 1.5); ctx.stroke();
      ctx.strokeStyle = '#2b323b'; ctx.lineWidth = 7; ctx.beginPath(); ctx.moveTo(bx1 - ca * 5, by1 - sa * 5 + el * 3); ctx.lineTo(bx1, by1); ctx.stroke(); // Mündungsbremse
      ctx.strokeStyle = shade(color, 1.1); ctx.lineWidth = 6.5; ctx.beginPath(); ctx.moveTo(bx0, by0); ctx.lineTo(bx0 + (bx1 - bx0) * 0.2, by0 + (by1 - by0) * 0.2); ctx.stroke(); // Wiege
      ctx.lineCap = 'butt';
    }
  }
  function drawInfantry(e, X, Y, color, kind) { // kind: 0 Schütze, 1 Raketentrupp, 2 Ingenieur, 3 Scharfschütze, 4 Flammenwerfer, 5 Sanitäter
    if (kind > 2) { drawInfantryNew(e, X, Y, color, kind); return; }
    var R = clamp(e.r * kx * 0.8, 5, 14), a = e.tdir || 0, rocket = kind === 1, eng = kind === 2;
    ctx.fillStyle = 'rgba(0,0,0,0.32)'; groundEllipse(X + 1, Y + 1, R * 0.9, R * 0.45); ctx.fill();
    // Waffe
    sdir(a);
    var dx = DX, dy = DY, dl = Math.hypot(dx, dy) || 1, wl = R * 1.7, wy = Y - R * 1.15;
    if (eng) { // Werkzeugkoffer an der Seite + Schraubenschlüssel über der Schulter
      var cxp = X + R * 1.15, cyp = Y - R * 0.55;
      ctx.strokeStyle = '#6b7280'; ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(X - R * 0.5, Y - R * 1.5); ctx.lineTo(X - R * 1.5, Y - R * 2.6); ctx.stroke(); ctx.lineCap = 'butt';
      ctx.fillStyle = '#d97706'; ctx.fillRect(cxp - R * 0.55, cyp - R * 0.4, R * 1.3, R * 0.95);
      ctx.fillStyle = '#facc15'; ctx.fillRect(cxp - R * 0.55, cyp - R * 0.05, R * 1.3, R * 0.2);
      ctx.strokeStyle = OUT; ctx.lineWidth = 1.1; ctx.strokeRect(cxp - R * 0.55, cyp - R * 0.4, R * 1.3, R * 0.95);
      ctx.strokeStyle = '#1f2937'; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(cxp - R * 0.25, cyp - R * 0.4); ctx.lineTo(cxp - R * 0.25, cyp - R * 0.7); ctx.lineTo(cxp + R * 0.45, cyp - R * 0.7); ctx.lineTo(cxp + R * 0.45, cyp - R * 0.4); ctx.stroke();
    } else {
      ctx.strokeStyle = rocket ? '#8b94a0' : '#11151a'; ctx.lineWidth = rocket ? 4 : 2.6; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(X, wy); ctx.lineTo(X + dx / dl * wl, wy + dy / dl * wl * 0.8); ctx.stroke(); ctx.lineCap = 'butt';
      if (rocket) { ctx.fillStyle = '#ef4444'; ctx.beginPath(); ctx.arc(X + dx / dl * wl, wy + dy / dl * wl * 0.8, 2.2, 0, 6.2832); ctx.fill(); }
    }
    // Körper + Kopf
    ctx.fillStyle = color; ctx.beginPath(); ctx.ellipse(X, Y - R * 0.95, R * 0.78, R * 0.95, 0, 0, 6.2832); ctx.fill();
    ctx.strokeStyle = OUT; ctx.lineWidth = 1.3; ctx.stroke();
    if (eng) { ctx.fillStyle = '#f59e0b'; ctx.fillRect(X - R * 0.7, Y - R * 1.15, R * 1.4, R * 0.28); } // Warnweste-Streifen
    ctx.fillStyle = 'rgba(255,255,255,0.22)'; ctx.beginPath(); ctx.ellipse(X - R * 0.25, Y - R * 1.2, R * 0.3, R * 0.45, 0, 0, 6.2832); ctx.fill();
    ctx.fillStyle = '#e7c9a0'; ctx.beginPath(); ctx.arc(X, Y - R * 2.1, R * 0.5, 0, 6.2832); ctx.fill(); ctx.strokeStyle = OUT; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = eng ? '#facc15' : shade(color, 0.7); ctx.beginPath(); ctx.arc(X, Y - R * 2.2, R * (eng ? 0.58 : 0.5), Math.PI, 0); ctx.fill(); // Helm
    if (eng) { ctx.strokeStyle = OUT; ctx.lineWidth = 0.9; ctx.stroke(); ctx.fillStyle = '#facc15'; ctx.fillRect(X - R * 0.72, Y - R * 2.22, R * 1.44, R * 0.16); }
  }
  // ------------------------------------------------------------------ v0.7: neue Fahrzeuge
  function cross(cx, cy, s, col, th) { ctx.fillStyle = col; ctx.fillRect(cx - s, cy - th / 2, 2 * s, th); ctx.fillRect(cx - th / 2, cy - s, th, 2 * s); }
  /** Koalition: glatt, hellgrau/blau; Syndikat: klobig, oliv/rot. Hülle aus Schichten (Lift) + Details je Typ. */
  function drawNewVehicle(type, X, Y, dir, tdir, color, moving, recoil, wreck) {
    var dm = VDIM[type], L = dm[0], Wd = dm[1], hh = dm[2], lift = hh * kx * HK, i, k, x, e = UE;
    var hc = wreck ? '#262422' : (type === 'apc' || type === 'lasertank' ? mixHex(color, '#d7dce3', 0.58) : mixHex(color, '#59603a', 0.66));
    var tick = curTick, rc = recoil ? -3 : 0, zk = clamp(zoomK, 0.8, 1.4);
    resetT(); ctx.fillStyle = 'rgba(0,0,0,0.32)'; groundEllipse(X + 2, Y + 2, L * 0.6 * kx, Wd * 0.55 * ky); ctx.fill();
    if (type === 'apc') {
      if (!wreck) { setT(dir, X, Y, 0); ctx.fillStyle = '#0e1114'; for (k = 0; k < 4; k++) { x = -L / 2 + 5 + k * (L - 12) / 3; ctx.fillRect(x - 3.2, -Wd / 2 - 2, 6.4, 4.2); ctx.fillRect(x - 3.2, Wd / 2 - 2.2, 6.4, 4.2); } }
      for (i = 0; i < 3; i++) {
        setT(dir, X, Y, lift * i / 2);
        ctx.fillStyle = i < 2 ? shade(hc, 0.5) : hc; ctx.beginPath();
        ctx.moveTo(-L / 2, -Wd / 2 + 1); ctx.lineTo(L / 2 - 10, -Wd / 2); ctx.lineTo(L / 2, -Wd / 2 + 5); ctx.lineTo(L / 2, Wd / 2 - 5); ctx.lineTo(L / 2 - 10, Wd / 2); ctx.lineTo(-L / 2, Wd / 2 - 1); ctx.closePath(); ctx.fill();
        if (i === 2) {
          ctx.strokeStyle = OUT; ctx.lineWidth = 1.2; ctx.stroke();
          if (!wreck) {
            ctx.fillStyle = shade(hc, 1.1); ctx.beginPath(); ctx.moveTo(L / 2 - 10, -Wd / 2 + 1); ctx.lineTo(L / 2 - 1, -Wd / 2 + 5.5); ctx.lineTo(L / 2 - 1, Wd / 2 - 5.5); ctx.lineTo(L / 2 - 10, Wd / 2 - 1); ctx.closePath(); ctx.fill(); // schräge Front
            ctx.fillStyle = 'rgba(255,255,255,0.22)'; ctx.fillRect(-L / 2 + 1, -Wd / 2 + 1.5, L - 11, 2);
            ctx.fillStyle = color; ctx.fillRect(-L / 2 + 3, -Wd / 2 + 4.2, L * 0.5, 1.8); ctx.fillRect(-L / 2 + 3, Wd / 2 - 6, L * 0.5, 1.8); // Teamstreifen
            ctx.fillStyle = 'rgba(30,50,90,0.45)'; ctx.fillRect(-L / 2 + 6, -3, 12, 6); // Dachluken für Passagiere
            ctx.strokeStyle = OUT; ctx.lineWidth = 0.9; ctx.strokeRect(-L / 2 + 6, -3, 12, 6); ctx.beginPath(); ctx.moveTo(-L / 2 + 12, -3); ctx.lineTo(-L / 2 + 12, 3); ctx.stroke();
            ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(-L / 2, -Wd / 2 + 2, 1.6, Wd - 4); // Heckrampe
          }
        }
      }
      if (!wreck) { // Turm: flacher Kopf mit MG
        setT(tdir, X, Y, lift + 1); ctx.fillStyle = '#10151b'; ctx.fillRect(3 + rc, -1.3, 14, 2.6); ctx.fillRect(15 + rc, -2, 3, 4);
        ctx.fillStyle = shade(hc, 1.08); ctx.beginPath(); ctx.ellipse(1, 0, 7.5, 6, 0, 0, 6.2832); ctx.fill(); ctx.strokeStyle = OUT; ctx.lineWidth = 1.1; ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillRect(-4, -4.2, 8, 1.8); ctx.fillStyle = '#5b8fd0'; ctx.fillRect(3.5, -3.2, 2.4, 2.4);
      }
    } else if (type === 'lasertank') {
      for (i = 0; i < 3; i++) {
        setT(dir, X, Y, lift * i / 2);
        if (i < 2) { ctx.fillStyle = '#1c2128'; ctx.fillRect(-L / 2, -Wd / 2, L, Wd); continue; }
        ctx.fillStyle = '#2a3038'; ctx.fillRect(-L / 2, -Wd / 2, L, Wd);
        ctx.fillStyle = shade(hc, 0.8); ctx.fillRect(-L / 2 + 1, -Wd / 2 + 0.5, L - 2, 5); ctx.fillRect(-L / 2 + 1, Wd / 2 - 5.5, L - 2, 5); // Seitenschürzen
        ctx.fillStyle = hc; ctx.beginPath(); // Keilrumpf
        ctx.moveTo(-L / 2 + 2, -Wd / 2 + 5); ctx.lineTo(L / 2 - 5, -Wd / 2 + 5); ctx.lineTo(L / 2 + 1, -3.5); ctx.lineTo(L / 2 + 1, 3.5); ctx.lineTo(L / 2 - 5, Wd / 2 - 5); ctx.lineTo(-L / 2 + 2, Wd / 2 - 5); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = OUT; ctx.lineWidth = 1.2; ctx.stroke(); ctx.strokeRect(-L / 2, -Wd / 2, L, Wd);
        if (!wreck) {
          ctx.fillStyle = 'rgba(255,255,255,0.22)'; ctx.fillRect(-L / 2 + 2, -Wd / 2 + 5.5, L - 8, 2);
          ctx.fillStyle = color; ctx.fillRect(-L / 2 + 3, -Wd / 2 + 1.5, L - 8, 1.8); ctx.fillRect(-L / 2 + 3, Wd / 2 - 3.3, L - 8, 1.8);
          var gl = 0.55 + 0.35 * Math.sin(fxTime * 4 + (e ? e.id : 0)); ctx.fillStyle = 'rgba(120,205,255,' + gl.toFixed(2) + ')'; ctx.fillRect(L / 2 - 9, -Wd / 2 + 1.5, 6, 1.8); ctx.fillRect(L / 2 - 9, Wd / 2 - 3.3, 6, 1.8);
          ctx.fillStyle = '#10151b'; ctx.fillRect(-L / 2 - 1, -4, 3, 8);
        }
      }
      if (!wreck) { // Turm: Keilkopf mit Kühlrippen und langem Strahlrohr, Linse glüht
        setT(tdir, X, Y, lift + 1);
        ctx.fillStyle = '#2b323b'; ctx.fillRect(9 + rc, -1.8, 18, 3.6); ctx.fillStyle = 'rgba(140,215,255,0.85)'; ctx.fillRect(10 + rc, -0.6, 15, 1.2);
        ctx.fillStyle = shade(hc, 1.06); ctx.beginPath(); ctx.moveTo(-10, -7); ctx.lineTo(4, -8.2); ctx.lineTo(11, -3.4); ctx.lineTo(11, 3.4); ctx.lineTo(4, 8.2); ctx.lineTo(-10, 7); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = OUT; ctx.lineWidth = 1.2; ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.fillRect(-9, -6, 13, 1.8);
        ctx.fillStyle = 'rgba(20,30,45,0.55)'; for (k = 0; k < 3; k++) ctx.fillRect(-8.5 + k * 2.6, -4.6, 1.2, 9.2); // Kühlrippen
        var lp = recoil ? 1 : 0.35 + 0.25 * Math.sin(fxTime * 6);
        ctx.fillStyle = 'rgba(255,60,50,' + (0.3 + 0.4 * lp).toFixed(2) + ')'; ctx.beginPath(); ctx.arc(28 + rc, 0, 3.8 + 2 * lp, 0, 6.2832); ctx.fill();
        ctx.fillStyle = recoil ? '#ffffff' : '#ff7a68'; ctx.beginPath(); ctx.arc(28 + rc, 0, 2.2, 0, 6.2832); ctx.fill();
      }
    } else if (type === 'mlrs') {
      var xs = [-L / 2 + 6, -L / 2 + 14, L / 2 - 9];
      if (!wreck) { setT(dir, X, Y, 0); ctx.fillStyle = '#0e1114'; for (k = 0; k < 3; k++) { ctx.fillRect(xs[k] - 3.8, -Wd / 2 - 2.2, 7.6, 4.6); ctx.fillRect(xs[k] - 3.8, Wd / 2 - 2.4, 7.6, 4.6); } }
      for (i = 0; i < 3; i++) { // Fahrgestell mit Ladepritsche
        setT(dir, X, Y, lift * i / 2);
        ctx.fillStyle = i < 2 ? shade(hc, 0.42) : shade(hc, 0.82); ctx.fillRect(-L / 2, -Wd / 2 + 1, L - 12, Wd - 2);
        if (i < 2) { ctx.fillStyle = shade(hc, 0.5); ctx.fillRect(L / 2 - 13, -Wd / 2 + 1, 13, Wd - 2); }
        if (i === 2) { ctx.strokeStyle = OUT; ctx.lineWidth = 1.2; ctx.strokeRect(-L / 2, -Wd / 2 + 1, L - 12, Wd - 2); }
      }
      if (!wreck) {
        // Fahrerhaus (höher als die Pritsche)
        for (i = 0; i < 3; i++) {
          setT(dir, X, Y, lift * (0.5 + i * 0.3));
          ctx.fillStyle = i < 2 ? shade(hc, 0.6) : shade(hc, 1.12); ctx.fillRect(L / 2 - 14, -Wd / 2 + 1.5, 14, Wd - 3);
          if (i === 2) {
            ctx.strokeStyle = OUT; ctx.lineWidth = 1.2; ctx.strokeRect(L / 2 - 14, -Wd / 2 + 1.5, 14, Wd - 3);
            ctx.fillStyle = '#8fb3c8'; ctx.fillRect(L / 2 - 4, -Wd / 2 + 3.5, 2.8, Wd - 7); ctx.fillStyle = 'rgba(255,255,255,0.2)'; ctx.fillRect(L / 2 - 14, -Wd / 2 + 1.5, 14, 2);
            ctx.fillStyle = color; ctx.fillRect(L / 2 - 12, -1, 7, 2); ctx.fillStyle = '#10151b'; ctx.fillRect(L / 2 - 1, -Wd / 2 + 2, 1.8, Wd - 4);
          }
        }
        // Raketengestell: 2 Reihen × 3 Rohre, stehend hochgestellt auf Stützen
        var up = moving ? 0 : 5 * kx * HK, since = e && e.fireT != null ? tick - e.fireT : 9999, ln = since > 130 ? 6 : clamp(Math.floor((since - 14) / 18), 0, 6), Lt = L - 22;
        if (!moving) { setT(dir, X, Y, 0); ctx.fillStyle = '#1b1f18'; ctx.fillRect(-L / 2 + 3, -Wd / 2 - 3.2, 6, 3.2); ctx.fillRect(-L / 2 + 3, Wd / 2, 6, 3.2); } // Stützen
        setT(dir, X, Y, lift + 2 * kx * HK + up * 0.5); ctx.fillStyle = '#23281c'; ctx.fillRect(-L / 2 + 2, -Wd / 2 + 3, Lt + 4, Wd - 6);
        ctx.strokeStyle = OUT; ctx.lineWidth = 1; ctx.strokeRect(-L / 2 + 2, -Wd / 2 + 3, Lt + 4, Wd - 6);
        for (var row = 0; row < 2; row++) {
          setT(dir, X, Y, lift + (3 + row * 4.2) * kx * HK + up);
          for (k = 0; k < 3; k++) {
            var ly = (k - 1) * 6.4, ti2 = row * 3 + k;
            ctx.fillStyle = row ? '#4a5238' : '#3a4130'; ctx.fillRect(-L / 2 + 3, ly - 2.7, Lt, 5.4);
            ctx.fillStyle = 'rgba(255,255,255,0.14)'; ctx.fillRect(-L / 2 + 3, ly - 2.7, Lt, 1.2);
            ctx.strokeStyle = OUT; ctx.lineWidth = 0.9; ctx.strokeRect(-L / 2 + 3, ly - 2.7, Lt, 5.4);
            ctx.fillStyle = '#0b0d0a'; ctx.beginPath(); ctx.ellipse(-L / 2 + 3 + Lt, ly, 1.7, 2.5, 0, 0, 6.2832); ctx.fill();
            if (ti2 < ln) { ctx.fillStyle = '#ef4444'; ctx.beginPath(); ctx.arc(-L / 2 + 3 + Lt - 1.2, ly, 1.7, 0, 6.2832); ctx.fill(); }
          }
        }
        setT(dir, X, Y, lift + 11 * kx * HK + up); ctx.fillStyle = color; ctx.fillRect(-L / 2 + 4, -1, Lt - 3, 2); // Teamband auf den Rohren
      }
    } else { // shocktank
      for (i = 0; i < 3; i++) {
        setT(dir, X, Y, lift * i / 2);
        if (i < 2) { ctx.fillStyle = '#1c2128'; ctx.fillRect(-L / 2, -Wd / 2, L, Wd); continue; }
        ctx.fillStyle = '#2a3038'; ctx.fillRect(-L / 2, -Wd / 2, L, Wd);
        if (!wreck) {
          ctx.fillStyle = '#4b5563'; var ph = moving ? (fxTime * 14) % 6 : 0;
          for (var kk = -L / 2 + ph; kk < L / 2 - 1; kk += 6) { ctx.fillRect(kk, -Wd / 2, 2, 7); ctx.fillRect(kk, Wd / 2 - 7, 2, 7); }
        }
        ctx.fillStyle = hc; ctx.fillRect(-L / 2 + 2, -Wd / 2 + 7, L - 4, Wd - 14);
        if (!wreck) {
          ctx.fillStyle = 'rgba(255,255,255,0.14)'; ctx.fillRect(-L / 2 + 2, -Wd / 2 + 7, L - 4, 3);
          ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(-L / 2 + 9, -Wd / 2 + 8); ctx.lineTo(-L / 2 + 9, Wd / 2 - 8); ctx.moveTo(L / 2 - 9, -Wd / 2 + 8); ctx.lineTo(L / 2 - 9, Wd / 2 - 8); ctx.stroke();
          ctx.fillStyle = color; ctx.fillRect(L / 2 - 8, -Wd / 2 + 8, 5, Wd - 16); // rotes Frontband
          ctx.fillStyle = '#10151b'; ctx.fillRect(-L / 2 - 1.5, -Wd / 2 + 10, 3.5, 4); ctx.fillRect(-L / 2 - 1.5, Wd / 2 - 14, 3.5, 4);
        }
        ctx.strokeStyle = OUT; ctx.lineWidth = 1.3; ctx.strokeRect(-L / 2, -Wd / 2, L, Wd);
      }
      if (!wreck) { // Turm mit Elektroden + aufrechte Teslaspule
        setT(tdir, X, Y, lift + 1);
        ctx.fillStyle = '#2b323b'; ctx.fillRect(9 + rc, -5, 12, 2); ctx.fillRect(9 + rc, 3, 12, 2);
        ctx.fillStyle = '#c9d4ff'; ctx.beginPath(); ctx.arc(21 + rc, -4, 2, 0, 6.2832); ctx.arc(21 + rc, 4, 2, 0, 6.2832); ctx.fill();
        if (recoil) { ctx.strokeStyle = 'rgba(210,225,255,0.95)'; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(21, -4); ctx.lineTo(23, -1.5); ctx.lineTo(19.5, 0.5); ctx.lineTo(23, 2); ctx.lineTo(21, 4); ctx.stroke(); }
        ctx.fillStyle = shade(hc, 1.12); ctx.beginPath(); ctx.moveTo(-12, -6); ctx.lineTo(-6, -12); ctx.lineTo(6, -12); ctx.lineTo(12, -6); ctx.lineTo(12, 6); ctx.lineTo(6, 12); ctx.lineTo(-6, 12); ctx.lineTo(-12, 6); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = OUT; ctx.lineWidth = 1.4; ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(-10, -10, 16, 2.2); ctx.fillStyle = color; ctx.fillRect(-11, 5, 12, 2);
        ctx.fillStyle = '#20252c'; ctx.beginPath(); ctx.arc(-1, 0, 5.4, 0, 6.2832); ctx.fill();
        resetT();
        var cxs = X, cys = Y - lift - 3 * kx * HK, ch = 17 * zk, fire = recoil ? 1 : 0, pu = 0.5 + 0.5 * Math.sin(fxTime * 7 + (e ? e.id : 0));
        ctx.fillStyle = '#5b3f31'; ctx.beginPath(); ctx.moveTo(cxs - 6 * zk, cys); ctx.lineTo(cxs - 2.4 * zk, cys - ch); ctx.lineTo(cxs + 2.4 * zk, cys - ch); ctx.lineTo(cxs + 6 * zk, cys); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = OUT; ctx.lineWidth = 1; ctx.stroke();
        ctx.strokeStyle = '#d58f58'; ctx.lineWidth = 2 * zk; for (k = 0; k < 4; k++) { var ry = cys - ch * (0.14 + k * 0.24), rr = (6 - 3.4 * k / 3) * zk; ctx.beginPath(); ctx.ellipse(cxs, ry, rr, rr * 0.4, 0, 0, Math.PI); ctx.stroke(); }
        ctx.fillStyle = 'rgba(150,170,255,' + (0.28 + 0.15 * pu + 0.35 * fire).toFixed(2) + ')'; ctx.beginPath(); ctx.arc(cxs, cys - ch - 3 * zk, (6 + 2.5 * fire) * zk, 0, 6.2832); ctx.fill();
        ctx.fillStyle = '#b8c4ff'; ctx.beginPath(); ctx.arc(cxs, cys - ch - 3 * zk, 3.1 * zk, 0, 6.2832); ctx.fill(); ctx.strokeStyle = OUT; ctx.lineWidth = 0.9; ctx.stroke();
        var sd = (Math.floor(fxTime * 14) + (e ? e.id * 7 : 0)) | 0;
        if (hash(sd, 3, 5) > 0.35 || fire) {
          var an = hash(sd, 4, 5) * 6.2832, ln2 = (9 + hash(sd, 5, 5) * 8) * zk, sx0 = cxs, sy0 = cys - ch - 3 * zk;
          ctx.lineJoin = 'round'; ctx.beginPath(); sparkPath(sx0, sy0, sx0 + Math.cos(an) * ln2, sy0 + Math.sin(an) * ln2 * 0.8, sd, 3 * zk, 4);
          ctx.strokeStyle = 'rgba(140,150,255,0.6)'; ctx.lineWidth = 3 * zk; ctx.stroke(); ctx.strokeStyle = 'rgba(240,244,255,0.95)'; ctx.lineWidth = 1; ctx.stroke(); ctx.lineJoin = 'miter';
        }
      }
    }
    resetT();
  }
  /** v0.7 Infanterie: 3 Scharfschütze (Koalition, schlank, langes Gewehr), 4 Flammenwerfer (Syndikat, klobig, Tank), 5 Sanitäter (weiß, Kreuz) */
  function drawInfantryNew(e, X, Y, color, kind) {
    var R = clamp(e.r * kx * 0.8, 5, 14), a = e.tdir || 0, syn = FAC === 'syndicate', zk = clamp(zoomK, 0.8, 1.4);
    sdir(a);
    var dl = Math.hypot(DX, DY) || 1, ux = DX / dl, uy = DY / dl, wy = Y - R * 1.15, i;
    var bodyC = kind === 3 ? mixHex(color, '#cfd6de', 0.5) : (kind === 4 ? mixHex(color, '#4d5230', 0.42) : mixHex(color, '#f4f6f8', 0.62));
    var bw = kind === 4 ? R * 0.98 : (kind === 3 ? R * 0.66 : R * 0.8), bh = kind === 4 ? R * 1.02 : R * 0.95;
    ctx.fillStyle = 'rgba(0,0,0,0.32)'; groundEllipse(X + 1, Y + 1, R * (kind === 4 ? 1.05 : 0.9), R * 0.45); ctx.fill();
    if (kind === 4) { // Brennstofftank auf dem Rücken (hinter dem Körper)
      var tx = X - (ux >= 0 ? 1 : -1) * R * 0.85, ty = Y - R * 1.3;
      ctx.fillStyle = '#9b241c'; ctx.beginPath(); ctx.ellipse(tx, ty, R * 0.5, R * 0.95, 0, 0, 6.2832); ctx.fill(); ctx.strokeStyle = OUT; ctx.lineWidth = 1.2; ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.beginPath(); ctx.ellipse(tx - R * 0.18, ty - R * 0.2, R * 0.14, R * 0.5, 0, 0, 6.2832); ctx.fill();
      ctx.fillStyle = '#2b323b'; ctx.fillRect(tx - R * 0.5, ty - R * 0.25, R, R * 0.2);
    }
    // Waffe / Gerät
    if (kind === 3) { // langes Gewehr mit Zielfernrohr
      var wl = R * 3.1;
      ctx.lineCap = 'round'; ctx.strokeStyle = '#0d1014'; ctx.lineWidth = 2.1 * zk; ctx.beginPath(); ctx.moveTo(X - ux * R * 0.5, wy - uy * R * 0.4); ctx.lineTo(X + ux * wl, wy + uy * wl * 0.8); ctx.stroke();
      ctx.strokeStyle = '#6b7380'; ctx.lineWidth = 1 * zk; ctx.stroke();
      ctx.fillStyle = '#1b2026'; ctx.fillRect(X + ux * R * 1.1 - 2.3, wy + uy * R * 0.9 - 3.3, 4.6, 2.4);
      ctx.fillStyle = '#9ec5e0'; ctx.fillRect(X + ux * R * 1.7 - 1, wy + uy * R * 1.3 - 3.2, 2, 2);
      ctx.lineCap = 'butt';
    } else if (kind === 4) { // Düse mit Zündflamme + Schlauch zum Tank
      var nl = R * 1.9, nx = X + ux * nl, ny = wy + uy * nl * 0.8;
      ctx.strokeStyle = '#161a20'; ctx.lineWidth = 1.7; ctx.beginPath(); ctx.moveTo(X - (ux >= 0 ? 1 : -1) * R * 0.6, Y - R * 1.0); ctx.quadraticCurveTo(X - ux * R * 0.2, Y - R * 0.1, X + ux * R * 0.7, wy + uy * R * 0.5); ctx.stroke();
      ctx.lineCap = 'round'; ctx.strokeStyle = '#2b323b'; ctx.lineWidth = 4.4; ctx.beginPath(); ctx.moveTo(X, wy); ctx.lineTo(nx, ny); ctx.stroke();
      ctx.strokeStyle = '#8b94a0'; ctx.lineWidth = 1.4; ctx.stroke(); ctx.lineCap = 'butt';
      ctx.fillStyle = '#0f1318'; ctx.beginPath(); ctx.arc(nx, ny, 3, 0, 6.2832); ctx.fill();
      var pf = 0.7 + 0.3 * Math.sin(fxTime * 22 + e.id);
      ctx.fillStyle = 'rgba(255,150,40,' + (0.85 * pf).toFixed(2) + ')'; ctx.beginPath(); ctx.ellipse(nx + ux * 2, ny + uy * 2 - 3.4, 2.2 * pf, 3.8 * pf, 0, 0, 6.2832); ctx.fill();
      ctx.fillStyle = 'rgba(255,240,170,0.95)'; ctx.beginPath(); ctx.ellipse(nx + ux * 2, ny + uy * 2 - 2.6, 1, 1.9 * pf, 0, 0, 6.2832); ctx.fill();
    } else { // Sanitätstasche an der Hüfte
      var cxp = X + R * 1.1, cyp = Y - R * 0.55;
      ctx.fillStyle = '#f1f5f9'; ctx.fillRect(cxp - R * 0.55, cyp - R * 0.45, R * 1.2, R * 0.95); ctx.strokeStyle = OUT; ctx.lineWidth = 1.1; ctx.strokeRect(cxp - R * 0.55, cyp - R * 0.45, R * 1.2, R * 0.95);
      cross(cxp + R * 0.05, cyp + R * 0.02, R * 0.3, '#16a34a', R * 0.2);
    }
    // Körper
    ctx.fillStyle = bodyC; ctx.beginPath(); ctx.ellipse(X, Y - R * 0.95, bw, bh, 0, 0, 6.2832); ctx.fill(); ctx.strokeStyle = OUT; ctx.lineWidth = 1.3; ctx.stroke();
    if (kind === 3) { ctx.fillStyle = color; ctx.fillRect(X - bw, Y - R * 1.2, bw * 2, R * 0.2); ctx.fillStyle = 'rgba(140,160,120,0.55)'; for (i = 0; i < 3; i++) { ctx.beginPath(); ctx.arc(X - bw * 0.5 + i * bw * 0.5, Y - R * 0.5, R * 0.18, 0, 6.2832); ctx.fill(); } }
    if (kind === 4) { ctx.fillStyle = '#20231a'; ctx.beginPath(); ctx.arc(X - bw * 0.85, Y - R * 1.75, R * 0.38, 0, 6.2832); ctx.arc(X + bw * 0.85, Y - R * 1.75, R * 0.38, 0, 6.2832); ctx.fill(); ctx.fillStyle = color; ctx.fillRect(X - bw, Y - R * 0.9, bw * 2, R * 0.22); } // Schulterpanzer + Gürtel in Teamfarbe
    if (kind === 5) { cross(X, Y - R * 0.95, R * 0.3, '#16a34a', R * 0.2); ctx.fillStyle = color; ctx.fillRect(X - bw, Y - R * 0.6, bw * 2, R * 0.16); }
    ctx.fillStyle = 'rgba(255,255,255,0.22)'; ctx.beginPath(); ctx.ellipse(X - R * 0.25, Y - R * 1.2, R * 0.3, R * 0.45, 0, 0, 6.2832); ctx.fill();
    // Kopf
    if (kind === 4) { // Atemschutz-Maske
      ctx.fillStyle = '#3a3d32'; ctx.beginPath(); ctx.arc(X, Y - R * 2.1, R * 0.56, 0, 6.2832); ctx.fill(); ctx.strokeStyle = OUT; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = '#d8cf9a'; ctx.beginPath(); ctx.arc(X - R * 0.22, Y - R * 2.12, R * 0.15, 0, 6.2832); ctx.arc(X + R * 0.22, Y - R * 2.12, R * 0.15, 0, 6.2832); ctx.fill();
      ctx.fillStyle = shade(bodyC, 0.55); ctx.beginPath(); ctx.arc(X, Y - R * 2.2, R * 0.6, Math.PI, 0); ctx.fill();
    } else {
      ctx.fillStyle = '#e7c9a0'; ctx.beginPath(); ctx.arc(X, Y - R * 2.1, R * 0.5, 0, 6.2832); ctx.fill(); ctx.strokeStyle = OUT; ctx.lineWidth = 1; ctx.stroke();
      if (kind === 3) { // Kapuze / Tarnhaube + blaues Band
        ctx.fillStyle = '#aeb6c0'; ctx.beginPath(); ctx.arc(X, Y - R * 2.2, R * 0.62, Math.PI * 0.95, Math.PI * 2.05); ctx.fill(); ctx.strokeStyle = OUT; ctx.lineWidth = 0.9; ctx.stroke();
        ctx.fillStyle = color; ctx.fillRect(X - R * 0.55, Y - R * 2.2, R * 1.1, R * 0.16);
      } else { // weißer Helm mit grünem Kreuz
        ctx.fillStyle = '#f1f5f9'; ctx.beginPath(); ctx.arc(X, Y - R * 2.2, R * 0.58, Math.PI, 0); ctx.fill(); ctx.strokeStyle = OUT; ctx.lineWidth = 0.9; ctx.stroke();
        cross(X, Y - R * 2.5, R * 0.2, '#16a34a', R * 0.14);
      }
    }
  }
  /** v0.8: Flughöhe in Bildschirm-px (gleiche Weltabbildung wie 3D: D.AIR_H Kacheln bei alt 1). */
  function airScreen(e) { return (e.alt || 0) * D.AIR_H * TILE * kx * HK; }
  function unitLiftPx(e) { if (e.mc === 2) return airScreen(e) + 10; if (e.mc === 3) return 10 * kx * HK + 4; return isInf(e.type) ? clamp(e.r * kx * 0.8, 5, 14) * 2.6 : (UH[e.type] != null ? UH[e.type] : 11) * kx * HK + 4; }

  // ------------------------------------------------------------------ Gebäude
  var BX = 0, BY = 0, BW = 0, BH = 0, BG = 0; // Oberseite (Bildschirm) + Höhe in px
  function rrect(x, y, w, h, col) { ctx.fillStyle = col; ctx.fillRect(x, y, w, h); }
  function boxBase(topCol, frontCol) {
    ctx.fillStyle = 'rgba(0,0,0,0.26)'; ctx.fillRect(BX + BG * 0.5, BY + BG + BG * 0.18, BW, BH);
    ctx.fillStyle = frontCol; ctx.fillRect(BX, BY + BH, BW, BG);
    ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.fillRect(BX, BY + BH + BG - 3, BW, 3);
    ctx.fillStyle = topCol; ctx.fillRect(BX, BY, BW, BH);
    ctx.fillStyle = 'rgba(255,255,255,0.20)'; ctx.fillRect(BX, BY, BW, 2); ctx.fillRect(BX, BY, 2, BH);
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(BX, BY + BH, BW, 2);
    ctx.strokeStyle = 'rgba(8,10,14,0.7)'; ctx.lineWidth = 1.5; ctx.strokeRect(BX + 0.75, BY + 0.75, BW - 1.5, BH + BG - 1.5);
  }
  function windows(nx, rows, col, y0, hgt) {
    var ww = BW / (nx * 2 + 1), wh = Math.min(hgt / (rows * 2 + 0.6), 9);
    for (var r = 0; r < rows; r++) for (var i = 0; i < nx; i++) rrect(BX + ww * (1 + i * 2), y0 + hgt * (0.16 + r * 0.38), ww, wh, col);
  }
  function flag(px, py, col, ph) { // Fahne: Mast bei (px,py) (Fußpunkt)
    var s = clamp(zoomK, 0.8, 1.4), H = 26 * s, w1 = Math.sin(fxTime * 3.2 + ph) * 2.2 * s;
    ctx.strokeStyle = '#161a20'; ctx.lineWidth = 2.2; ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px, py - H); ctx.stroke();
    ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(px + 1, py - H); ctx.lineTo(px + 15 * s, py - H + 3 * s + w1); ctx.lineTo(px + 12 * s, py - H + 8 * s + w1 * 0.5); ctx.lineTo(px + 15 * s, py - H + 12 * s + w1); ctx.lineTo(px + 1, py - H + 14 * s); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = OUT; ctx.lineWidth = 1; ctx.stroke();
  }
  function smokeCol(x, y, n) {
    for (var i = 0; i < n; i++) {
      var t = ((fxTime * 0.7 + i / n) % 1);
      ctx.fillStyle = 'rgba(55,52,50,' + (0.55 * (1 - t)).toFixed(2) + ')';
      ctx.beginPath(); ctx.arc(x + Math.sin(t * 5 + i) * 3, y - t * 34, 3 + t * 8, 0, 6.2832); ctx.fill();
    }
  }
  function bolt(x, y, s, col) {
    ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(x + 2 * s, y - 8 * s); ctx.lineTo(x - 4 * s, y + 1 * s); ctx.lineTo(x, y + 1 * s); ctx.lineTo(x - 2 * s, y + 8 * s); ctx.lineTo(x + 5 * s, y - 2 * s); ctx.lineTo(x + 1 * s, y - 2 * s); ctx.closePath(); ctx.fill();
  }
  function cylinder(x, yBase, r, hgt, col, topCol) {
    ctx.fillStyle = col; ctx.fillRect(x - r, yBase - hgt, r * 2, hgt);
    ctx.beginPath(); ctx.ellipse(x, yBase, r, r * 0.45, 0, 0, Math.PI); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(x - r, yBase - hgt, r * 0.5, hgt);
    ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.fillRect(x + r * 0.45, yBase - hgt, r * 0.55, hgt);
    ctx.fillStyle = topCol; ctx.beginPath(); ctx.ellipse(x, yBase - hgt, r, r * 0.45, 0, 0, 6.2832); ctx.fill();
    ctx.strokeStyle = OUT; ctx.lineWidth = 1; ctx.stroke();
  }

  // ================================================================== v1.0 Kollektiv – PLATZHALTER v1.0 (2D/Sprite-Modus: immer Vektorformen)
  // Alle Kollektiv-Einheiten (e.fac === 'kollektiv', auch gedankenkontrollierte) und Kollektiv-Gebäude (Besitzer-Fraktion) als einfache
  // dunkelblaue Formen mit hellem Psi-Glühen. Wird vom Grafik-Agenten durch echte Formen/Sprites ersetzt (SPEC_v10 §8).
  var K10U = { psiadept: 1, brute: 1, gatling: 1, magnet: 1, psitank: 1 };            // nur Kollektiv
  var K10B = { psitower: 1, psidome: 1 };
  var K10KEEP = { wall: 1 };                                                          // Kollektiv-Gebäude mit gemeinsamer Darstellung
  var K10_BODY = '#232a6b', K10_BODY2 = '#323c96', K10_GLOW = 'rgba(165,180,252,';  // PLATZHALTER v1.0
  function k10Fac(e) { var p = G.Sim.S.players[e.owner]; return e.fac || (p ? p.faction : 'coalition'); }
  /** Polygon in Einheitenkoordinaten (vorn = +x, Welt-px) um (wx, wy) mit Richtung a, Höhe z (Welt-px). */
  function k10Poly(wx, wy, a, z, pts, fill, stroke) {
    var c = Math.cos(a), s = Math.sin(a), lz = z * kx * HK;
    ctx.beginPath();
    for (var i = 0; i < pts.length; i += 2) {
      var px = wx + c * pts[i] - s * pts[i + 1], py = wy + s * pts[i] + c * pts[i + 1], X = PX(px, py), Y = PY(px, py) - lz;
      if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y);
    }
    ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
    ctx.strokeStyle = stroke || 'rgba(6,8,20,0.85)'; ctx.lineWidth = 1.4; ctx.stroke();
  }
  function k10Line(wx, wy, a, z, x0, y0, x1, y1, col, lw) {
    var c = Math.cos(a), s = Math.sin(a), lz = z * kx * HK;
    var ax = wx + c * x0 - s * y0, ay = wy + s * x0 + c * y0, bx = wx + c * x1 - s * y1, by = wy + s * x1 + c * y1;
    ctx.strokeStyle = col; ctx.lineWidth = lw * clamp(zoomK, 0.7, 1.5); ctx.beginPath(); ctx.moveTo(PX(ax, ay), PY(ax, ay) - lz); ctx.lineTo(PX(bx, by), PY(bx, by) - lz); ctx.stroke();
  }
  function k10Dot(wx, wy, z, r, col) { var X = PX(wx, wy), Y = PY(wx, wy) - z * kx * HK; ctx.fillStyle = col; ctx.beginPath(); ctx.arc(X, Y, r * kx, 0, 6.2832); ctx.fill(); }
  function drawK10Unit(e, X, Y, color, wx, wy, tick) {   // PLATZHALTER v1.0
    var t = e.type, a = e.dir || 0, ta = e.tdir || a, pulse = 0.5 + 0.5 * Math.sin(fxTime * 4 + e.id), z0 = 0, R = e.r || 8;
    var air = e.mc === 2, held = e.magT > tick;
    if (air) z0 = (e.alt || 0) * D.AIR_H * TILE;
    if (held) z0 += 6 + 3 * Math.sin(fxTime * 9);                                   // vom Magnet angehoben
    if (e.pc === 4 || air) z0 += 3 + 1.5 * Math.sin(fxTime * 3 + e.id);              // Schweben
    ctx.fillStyle = 'rgba(0,0,0,0.3)'; groundEllipse(PX(wx, wy), PY(wx, wy), R * kx * 1.05, R * ky * 0.75); ctx.fill();   // Schatten
    if (e.pc === 4 || air) { ctx.fillStyle = K10_GLOW + (0.25 + 0.2 * pulse).toFixed(2) + ')'; groundEllipse(PX(wx, wy), PY(wx, wy), R * kx * 0.8, R * ky * 0.55); ctx.fill(); }
    if (isInf(t)) {
      var big = t === 'brute' ? 1.45 : 1, hz = z0 + 7 * big;
      k10Poly(wx, wy, a, z0, [5 * big, 0, 0, 4 * big, -5 * big, 0, 0, -4 * big], K10_BODY, null);
      k10Dot(wx, wy, hz, 4.2 * big, K10_BODY2); k10Dot(wx, wy, hz + 1, 2.6 * big, color);
      if (t === 'psiadept') { ctx.strokeStyle = K10_GLOW + (0.5 + 0.4 * pulse).toFixed(2) + ')'; ctx.lineWidth = 2; groundEllipse(PX(wx, wy), PY(wx, wy) - (hz + 5) * kx * HK, 6 * kx, 3 * ky); ctx.stroke(); }
      else if (t === 'brute') { k10Line(wx, wy, a, z0 + 6, 2, 5, 8, 6, '#c7d2fe', 3); k10Line(wx, wy, a, z0 + 6, 2, -5, 8, -6, '#c7d2fe', 3); }
      else if (e.ord !== 'idle' || tick - e.fireT < 25) k10Line(wx, wy, ta, z0 + 7, 2, 2, 10, 2, '#0b1030', 2.2);   // Waffe
      return;
    }
    var L = R * 1.1, W = R * 0.8;
    if (air) {   // Diskus / Transportgleiter: Untertasse bzw. längliche Gondel
      if (t === 'gunship') { k10Poly(wx, wy, a, z0, [L, 0, L * 0.7, W, 0, W * 1.2, -L * 0.7, W, -L, 0, -L * 0.7, -W, 0, -W * 1.2, L * 0.7, -W], K10_BODY2, null); k10Dot(wx, wy, z0 + 3, R * 0.45, color); k10Dot(wx, wy, z0 + 4, R * 0.22, K10_GLOW + '0.95)'); }
      else { k10Poly(wx, wy, a, z0, [L * 1.2, 0, L * 0.5, W * 0.7, -L, W * 0.6, -L, -W * 0.6, L * 0.5, -W * 0.7], K10_BODY2, null); k10Line(wx, wy, a, z0 + 2, -L * 0.6, 0, L * 0.6, 0, color, 3); }
      return;
    }
    if (e.mc === 3) {   // Tauchboot / Raketen-Tauchboot / Schwebefähre
      var Ls = t === 'destroyer' ? L * 1.5 : L * 1.2;
      k10Poly(wx, wy, a, 1, [Ls, 0, Ls * 0.6, W * 0.6, -Ls, W * 0.5, -Ls, -W * 0.5, Ls * 0.6, -W * 0.6], t === 'lander' ? K10_BODY2 : K10_BODY, null);
      if (t !== 'lander') k10Poly(wx, wy, a, 6, [3, 0, 0, 3, -5, 2, -5, -2, 0, -3], color, null);
      else k10Line(wx, wy, a, 3, -Ls * 0.7, 0, Ls * 0.7, 0, color, 4);
      return;
    }
    // Bodenfahrzeuge: sechseckige Wanne, Turm/Waffe nach Typ
    var hull = t === 'psitank' ? 1.25 : (t === 'harvester' || t === 'mcv' ? 1.15 : 1);
    var Lh = L * hull, Wh = W * hull;
    k10Poly(wx, wy, a, z0, [Lh, 0, Lh * 0.55, Wh, -Lh * 0.8, Wh, -Lh, 0, -Lh * 0.8, -Wh, Lh * 0.55, -Wh], K10_BODY, null);
    k10Poly(wx, wy, a, z0 + 3, [Lh * 0.5, 0, Lh * 0.2, Wh * 0.6, -Lh * 0.6, Wh * 0.5, -Lh * 0.6, -Wh * 0.5, Lh * 0.2, -Wh * 0.6], color, null);
    if (t === 'tank') { k10Dot(wx, wy, z0 + 7, R * 0.42, K10_BODY2); k10Line(wx, wy, ta, z0 + 7, 0, 0, R * 1.5, 0, '#0b1030', 4); }
    else if (t === 'gatling') { k10Dot(wx, wy, z0 + 7, R * 0.38, K10_BODY2); for (var gb = -1; gb <= 1; gb++) k10Line(wx, wy, ta, z0 + 7, 0, gb * 2.2, R * 1.3, gb * 2.2, '#0b1030', 2); }
    else if (t === 'magnet') { k10Line(wx, wy, ta, z0 + 9, -2, -5, R * 1.2, -5, '#94a3b8', 3); k10Line(wx, wy, ta, z0 + 9, -2, 5, R * 1.2, 5, '#94a3b8', 3); k10Line(wx, wy, ta, z0 + 9, -2, -5, -2, 5, '#94a3b8', 3); }
    else if (t === 'psitank') { k10Dot(wx, wy, z0 + 10, R * 0.5, K10_BODY2); k10Dot(wx, wy, z0 + 13, R * 0.32, K10_GLOW + (0.6 + 0.35 * pulse).toFixed(2) + ')'); }
    else if (t === 'harvester') { k10Poly(wx, wy, a, z0 + 6, [-1, 0, -4, Wh * 0.7, -Lh * 0.8, Wh * 0.6, -Lh * 0.8, -Wh * 0.6, -4, -Wh * 0.7], K10_BODY2, null); if (e.cargo > 0) k10Dot(wx, wy, z0 + 9, 3, '#7dd3fc'); }
    else if (t === 'mcv') { k10Poly(wx, wy, a, z0 + 8, [Lh * 0.4, 0, 0, Wh * 0.7, -Lh * 0.7, Wh * 0.7, -Lh * 0.7, -Wh * 0.7, 0, -Wh * 0.7], K10_BODY2, null); }
  }
  /** Kollektiv-Gebäude: dunkelblauer Quader mit Kuppel; Psi-Turm Spitze + pulsierender Ring, Psi-Verstärker große Kuppel mit Ladering. */
  function drawK10Building(b, color, S, o) {   // PLATZHALTER v1.0
    var type = b.type, hgt = bHeight(type) * (o.grow == null ? 1 : 0.3 + 0.7 * o.grow), pulse = 0.5 + 0.5 * Math.sin(fxTime * 3 + b.id);
    bgeom(b);
    BG = hgt; BW = GW; BH = GH; BX = GCX - GW / 2; BY = GCY - GH / 2 - hgt;
    if (o.alpha != null) ctx.globalAlpha = o.alpha;
    if (ROT) { footPath(b.tx * TILE, b.ty * TILE, b.w * TILE, b.h * TILE, 0); ctx.fillStyle = o.dim ? 'rgba(40,40,44,0.5)' : 'rgba(30,34,70,0.55)'; ctx.fill(); ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 1.4; ctx.stroke(); }
    var top = o.dim ? '#3a3d4c' : hexMix(K10_BODY2, color, 0.25), front = o.dim ? '#2a2c38' : K10_BODY;
    boxBase(top, front);
    rrect(BX, BY + BH, BW, 5, o.dim ? '#555' : color);
    var cx = BX + BW / 2, cy = BY + BH / 2, r = Math.min(BW, BH) * 0.3, tm = zoomK, glow = o.dim ? 'rgba(150,150,160,' : K10_GLOW;
    if (type === 'psitower' || type === 'turret' || type === 'mg' || type === 'flak') {
      var sh = (type === 'psitower' ? 34 : 14) * tm;
      ctx.strokeStyle = '#c7d2fe'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx, cy - sh); ctx.stroke();
      if (type === 'psitower') { ctx.strokeStyle = glow + (0.5 + 0.45 * pulse).toFixed(2) + ')'; ctx.lineWidth = 3; ctx.beginPath(); ctx.ellipse(cx, cy - sh * (0.55 + 0.25 * pulse), r * 0.9, r * 0.4, 0, 0, 6.2832); ctx.stroke(); }
      else { sdir(b.tdir || 0); var dl = Math.hypot(DX, DY) || 1; ctx.strokeStyle = '#0b1030'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(cx, cy - sh); ctx.lineTo(cx + DX / dl * 14 * tm, cy - sh + DY / dl * 14 * tm); ctx.stroke(); }
      ctx.fillStyle = glow + '0.95)'; ctx.beginPath(); ctx.arc(cx, cy - sh, 4 * tm, 0, 6.2832); ctx.fill();
    } else if (type === 'psidome') {
      var ch = b.charge || 0;
      ctx.fillStyle = K10_BODY2; ctx.beginPath(); ctx.ellipse(cx, cy, BW * 0.36, BH * 0.4, 0, Math.PI, 0); ctx.fill();
      ctx.fillStyle = glow + (0.35 + 0.5 * ch * pulse).toFixed(2) + ')'; ctx.beginPath(); ctx.ellipse(cx, cy - BH * 0.1, BW * 0.26, BH * 0.28, 0, 0, 6.2832); ctx.fill();
      ctx.strokeStyle = '#e0e7ff'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(cx, cy - BH * 0.1, Math.min(BW, BH) * 0.3, -Math.PI / 2, -Math.PI / 2 + ch * 6.2832); ctx.stroke();
    } else {
      ctx.fillStyle = K10_BODY2; ctx.beginPath(); ctx.ellipse(cx, cy, r, r * 0.6, 0, 0, 6.2832); ctx.fill(); ctx.strokeStyle = 'rgba(6,8,20,0.8)'; ctx.lineWidth = 1.2; ctx.stroke();
      ctx.fillStyle = glow + (0.45 + 0.35 * pulse).toFixed(2) + ')'; ctx.beginPath(); ctx.ellipse(cx, cy - 2, r * 0.5, r * 0.32, 0, 0, 6.2832); ctx.fill();
      if (type === 'barracks') for (var ci = 0; ci < 3; ci++) cylinder(BX + BW * (0.2 + ci * 0.3), BY + BH * 0.95, 4 * tm, 10 * tm, K10_BODY2, '#a5b4fc');   // Klonröhren
      else if (type === 'power') { cylinder(BX + BW * 0.22, BY + BH * 0.85, 5 * tm, 16 * tm, K10_BODY2, '#c7d2fe'); cylinder(BX + BW * 0.78, BY + BH * 0.85, 5 * tm, 16 * tm, K10_BODY2, '#c7d2fe'); }
      else if (type === 'factory' || type === 'airfield' || type === 'shipyard') rrect(BX + BW * 0.25, BY + BH + BG * 0.35, BW * 0.5, BG * 0.65, '#0d1130');
      else if (type === 'hq' || type === 'techcenter') { ctx.strokeStyle = '#c7d2fe'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(BX + BW - 8, BY + 8); ctx.lineTo(BX + BW - 8, BY - 18 * tm); ctx.stroke(); k10DotS(BX + BW - 8, BY - 18 * tm, 3, glow + '0.95)'); }
    }
    if (o.hp != null && o.hp < 0.55) smokeCol(cx, BY + BH * 0.3, 2);
    ctx.globalAlpha = 1;
  }
  function k10DotS(X, Y, r, col) { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(X, Y, r, 0, 6.2832); ctx.fill(); }
  function k10UseB(e, fac) { return fac === 'kollektiv' && !K10KEEP[e.type] && !NEUT[e.type]; }
  /** Gedankenkontrolle sichtbar machen: Verbindung Kontrolleur → Einheit (gestrichelt, pulsierend) + Ring um die kontrollierte Einheit;
   *  Magnet: Ring um gehaltene Fahrzeuge. Nur Sichtbares (Nebel). */
  function drawMcLinks(S, pid, fogOff, alpha, tick) {   // PLATZHALTER v1.0 (Darstellung), Daten: e.mcBy / e.magT
    var ents = S.ents, pulse = 0.55 + 0.45 * Math.sin(fxTime * 5);
    for (var i = 0; i < ents.length; i++) {
      var e = ents[i];
      if (e.dead || e.kind !== 'unit' || e.inside || !(e.mcBy || e.magT > tick)) continue;
      if (!fogOff && e.owner !== pid && !G.Sim.isVisible(pid, e)) continue;
      var ux = e.px + (e.x - e.px) * alpha, uy = e.py + (e.y - e.py) * alpha, X = PX(ux, uy), Y = PY(ux, uy) - unitLiftPx(e) * 0.5;
      if (X < -60 || X > V.vw + 60 || Y < -60 || Y > V.vh + 60) { if (!e.mcBy) continue; }
      if (e.magT > tick) { ctx.strokeStyle = 'rgba(148,163,184,' + (0.6 + 0.3 * pulse).toFixed(2) + ')'; ctx.lineWidth = 2; groundEllipse(X, Y, e.r * kx * 1.5, e.r * ky * 1.0); ctx.stroke(); }
      if (!e.mcBy) continue;
      var c = G.Sim.get(e.mcBy);
      ctx.strokeStyle = 'rgba(199,210,254,' + (0.55 + 0.4 * pulse).toFixed(2) + ')'; ctx.lineWidth = 2.5;
      groundEllipse(X, Y + unitLiftPx(e) * 0.5, e.r * kx * 1.6, e.r * ky * 1.1); ctx.stroke();
      if (!c || c.dead || (!fogOff && c.owner !== pid && !G.Sim.isVisible(pid, c))) continue;
      var cxw = c.kind === 'unit' ? c.px + (c.x - c.px) * alpha : c.x, cyw = c.kind === 'unit' ? c.py + (c.y - c.py) * alpha : c.y;
      var CX = PX(cxw, cyw), CY = PY(cxw, cyw) - (c.kind === 'unit' ? unitLiftPx(c) * 0.7 : bHeight(c.type) * 0.9);
      ctx.setLineDash([7, 5]); ctx.lineDashOffset = -fxTime * 30;
      ctx.strokeStyle = 'rgba(129,140,248,' + (0.5 + 0.4 * pulse).toFixed(2) + ')'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(CX, CY); ctx.lineTo(X, Y); ctx.stroke();
      ctx.setLineDash([]); ctx.lineDashOffset = 0;
    }
  }

  /** Zeichnet ein Gebäude: b = {type, tx, ty, w, h, tdir, ...}; opts: color (Teamfarbe), alpha, grow (0..1), dim. */
  // ------------------------------------------------------------------ v0.8: Luft-/Seeeinheiten, Flugfeld/Werft/Flak
  // Sprite-Modus (diagonal): spV8 – Luftfahrzeug-Sprite in Flughöhe + Silhouetten-Schatten am Boden + Rotor-Unschärfe (Kreise aus rec.rotors),
  // Schiff-Sprite (16 Richtungen, Turm 32) auf der Wasserlinie + Bugwelle/Kielwasser (wake2), Landungsboot mit offener Bugklappe (rec.hullO).
  // Gerade Kamera / ohne Sprite: Vektorformen (drawV8Unit, v8Building). Absturz/Untergang: wreck8 (beide Wege).
  var last8 = {};   // letzter Darstellungszustand je Luft-/Seeeinheit (für Absturz: Höhe, Richtung, Geschwindigkeit) – Objekte werden wiederverwendet
  function track8(e) { var o = last8[e.id] || (last8[e.id] = { alt: 0, dir: 0, vx: 0, vy: 0 }); o.alt = e.alt || 0; o.dir = e.dir || 0; o.vx = (e.x - e.px) * 20; o.vy = (e.y - e.py) * 20; }
  function waterAt(wx, wy) { var m = G.Sim.S.map, tx = Math.floor(wx / TILE), ty = Math.floor(wy / TILE); if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h) return false; var T = D.TERRAIN[m.terrain[ty * m.w + tx]]; return !!T && T.id === 'water'; }
  function airNear(px, py, rad) {
    var E = G.Sim.S.ents, i, e, dx, dy, best = null, bd = rad * rad;
    for (i = 0; i < E.length; i++) { e = E[i]; if (e.kind !== 'unit' || e.dead || e.mc !== 2 || !(e.alt > 0.5)) continue; dx = e.x - px; dy = e.y - py; if (dx * dx + dy * dy < bd) { bd = dx * dx + dy * dy; best = e; } }
    return best;
  }
  /** takeoff/land: Abwind-Staub bzw. Gischt; beach/load/unload am Landungsboot: Bugklappe öffnen + Gischt/Staub am Bug. */
  function evt8(e, S) {
    var u = G.Sim.get(e.id), q;
    if (!u || u.dead || !(S.settings.fogOff || u.owner === V.pid || G.Sim.isVisible(V.pid, u))) return;
    if (u.mc === 3) {
      rampT[u.id] = fxTime;
      var d = u.dir || 0, bx = u.x + Math.cos(d) * 18, by = u.y + Math.sin(d) * 18;
      addFx(F_DUST, bx, by, 2, 0, 0, 0, 0.8, 10, 'rgba(225,238,245,');
      if (e.t !== 'load') addFx(F_DUST, bx + Math.cos(d) * 12, by + Math.sin(d) * 12, 2, 0, 0, 0, 0.9, 9, 'rgba(185,172,145,');
      return;
    }
    if (u.mc !== 2 || (e.t === 'load' && Math.random() < 0.6)) return;
    var col = waterAt(u.x, u.y) ? 'rgba(225,238,245,' : 'rgba(185,172,145,';
    for (q = 0; q < 4; q++) addFx(F_DUST, u.x + Math.cos(q * 1.5708 + 0.4) * 14, u.y + Math.sin(q * 1.5708 + 0.4) * 14, 2, 0, 0, 0, 0.8, 10, col);
    addFx(F_RING, u.x, u.y, 0, 0, 0, 0, 0.6, 30, col);
  }
  /** Tod: Luftfahrzeug in der Luft → Sprengwolke + Absturz (fällt mit Schwung, dreht), am Boden → Explosion; Schiff → Explosion + Untergang. */
  function die8(e, Pd) {
    var u = D.UNITS[e.type], st = last8[e.id], al = st ? st.alt : 0;
    delete last8[e.id];
    if (u.cat === 'air' && al < 0.08) { addFx(F_BOOM, e.x, e.y, 6, 0, 0, 0, 0.7, 24); addFx(F_SMOKE, e.x, e.y, 10, 0, 0, 0, 1.4, 14); addDecal(e.x, e.y, 14, 10, 0); return; }
    if (u.cat === 'air') {
      var z = al * D.AIR_H * TILE;
      addFx(F_FLAK, e.x, e.y, z + 4, 0, 0, 0, 1.3, 16); addFx(F_BOOM, e.x, e.y, z, 0, 0, 0, 0.5, 20);
      wreck8.push({ k: 0, type: e.type, fac: Pd.faction, x: e.x, y: e.y, z: z, vz: 25, vx: st ? st.vx * 0.85 : 0, vy: st ? st.vy * 0.85 : 0, dir: st ? st.dir : 0, spin: u.bomber ? 0.15 : (Math.random() < 0.5 ? -1 : 1) * (2.5 + Math.random() * 2), t0: fxTime, sm: 0 });
    } else {
      addFx(F_BOOM, e.x, e.y, 8, 0, 0, 0, 0.75, 26); addFx(F_DUST, e.x, e.y, 2, 0, 0, 0, 1.2, 22, 'rgba(225,238,245,'); addFx(F_SMOKE, e.x, e.y, 12, 0, 0, 0, 1.6, 16);
      var gu = G.Sim.get(e.id);
      wreck8.push({ k: 1, type: e.type, fac: Pd.faction, x: e.x, y: e.y, dir: st ? st.dir : (gu ? gu.dir || 0 : 0), tdir: gu ? gu.tdir || 0 : 0, t0: fxTime, life: 4.5, sm: 0 });
    }
    if (wreck8.length > 16) wreck8.shift();
  }
  function drawWreck8(dt, SPM) {
    for (var i = wreck8.length - 1; i >= 0; i--) {
      var w = wreck8[i], a = fxTime - w.t0, X, Y, rec = SPM ? spRecU(w.type, w.fac) : null, k = rec ? kx * TILE / rec.p : 1, fr;
      if (w.k === 0) {   // Absturz
        w.vz -= 260 * dt; w.z += w.vz * dt; w.x += w.vx * dt; w.y += w.vy * dt; w.dir += w.spin * dt;
        if (w.z <= 0 || a > 4) {
          if (waterAt(w.x, w.y)) { addFx(F_DUST, w.x, w.y, 2, 0, 0, 0, 1.1, 20, 'rgba(225,238,245,'); addFx(F_RING, w.x, w.y, 0, 0, 0, 0, 0.8, 30, 'rgba(225,238,245,'); }
          else { addFx(F_BOOM, w.x, w.y, 4, 0, 0, 0, 0.8, 28); addFx(F_SMOKE, w.x, w.y, 12, 0, 0, 0, 1.8, 18); addFx(F_FIRE, w.x, w.y, 3, 0, 0, 0, 2.5, 12); addDecal(w.x, w.y, 15, 30, 0); }
          wreck8.splice(i, 1); continue;
        }
        X = PX(w.x, w.y); Y = PY(w.x, w.y) - w.z * kx * HK;
        if ((w.sm += dt) > 0.05) { w.sm = 0; addFx(F_SMOKE, w.x, w.y, w.z + 4, 0, 0, 0, 1.2, 9); }
        if (rec && rec.hull) spDraw(spVar(rec.hull[spIdx(w.dir, rec.hull.length)], 'wreck'), X, Y, k);
        else { ctx.fillStyle = '#26282b'; ctx.beginPath(); ctx.ellipse(X, Y, 12 * zoomK, 6 * zoomK, 0, 0, 6.2832); ctx.fill(); }
        ctx.fillStyle = 'rgba(255,150,40,' + (0.6 + 0.4 * Math.sin(fxTime * 30)).toFixed(2) + ')'; ctx.beginPath(); ctx.arc(X, Y - 3 * zoomK, 4 * zoomK, 0, 6.2832); ctx.fill();
      } else {           // Untergang: dunkler werdender, versinkender Rumpf, Blasen, Rauch
        fr = a / w.life;
        if (fr >= 1) { wreck8.splice(i, 1); continue; }
        X = PX(w.x, w.y); Y = PY(w.x, w.y);
        ctx.globalAlpha = Math.max(0, 1 - fr * 1.1);
        if (rec && rec.hull) spDraw(spVar(rec.hull[spIdx(w.dir, rec.hull.length)], 'wreck'), X, Y + fr * 7 * zoomK, k);
        else { var wl9 = w.type === 'dreadnought' ? 2 : 1; ctx.fillStyle = '#2a2d31'; ctx.beginPath(); ctx.ellipse(X, Y + fr * 5, 16 * wl9 * zoomK, 7 * wl9 * zoomK, 0, 0, 6.2832); ctx.fill(); }
        ctx.globalAlpha = 1;
        if ((w.sm += dt) > 0.12 && fr < 0.7) { w.sm = 0; addFx(F_SMOKE, w.x + (Math.random() - 0.5) * 16, w.y + (Math.random() - 0.5) * 16, 8, 0, 0, 0, 1.4, 10); }
        ctx.fillStyle = 'rgba(235,245,250,0.7)';
        for (var q = 0; q < 4; q++) { var bt = (fxTime * 0.9 + q * 0.27 + w.t0) % 1, bx = w.x + Math.cos(q * 2.1 + w.t0) * 12 * bt, by = w.y + Math.sin(q * 2.1 + w.t0) * 12 * bt; ctx.beginPath(); ctx.arc(PX(bx, by), PY(bx, by), (1.2 + bt * 2.5) * zoomK * (1 - fr * 0.5), 0, 6.2832); ctx.fill(); }
      }
    }
  }
  /** Bugwelle (V-Linien vom Bug) + Heckschaum (wandernde, verblassende Flecken) – nur in Fahrt. */
  function wake2(e, wx, wy, dir) {
    if (!e.moving) return;
    var L = (e.r || 13) * 1.25, c = Math.cos(dir), sn = Math.sin(dir), bx = wx + c * L, by = wy + sn * L, sx0 = wx - c * L * 0.9, sy0 = wy - sn * L * 0.9, q, t;
    ctx.strokeStyle = 'rgba(236,246,252,0.5)'; ctx.lineWidth = 2 * clamp(zoomK, 0.7, 1.6); ctx.beginPath();
    for (q = -1; q <= 1; q += 2) { var a = dir + Math.PI + q * 0.42; ctx.moveTo(PX(bx, by), PY(bx, by)); ctx.lineTo(PX(bx + Math.cos(a) * L * 2.3, by + Math.sin(a) * L * 2.3), PY(bx + Math.cos(a) * L * 2.3, by + Math.sin(a) * L * 2.3)); }
    ctx.stroke();
    for (q = 0; q < 4; q++) {
      t = (fxTime * 1.3 + q / 4 + e.id * 0.13) % 1;
      var fx2 = sx0 - c * t * L * 2.2, fy2 = sy0 - sn * t * L * 2.2, rr = (0.25 + t * 0.6) * L;
      ctx.fillStyle = 'rgba(236,246,252,' + (0.38 * (1 - t)).toFixed(2) + ')'; groundEllipse(PX(fx2, fy2), PY(fx2, fy2), rr * kx, rr * ky); ctx.fill();
    }
  }
  /** Sprite-Modus: Luftfahrzeug/Schiff. → false, wenn kein Sprite (Vektorform zeichnet weiter). */
  function spV8(e, X, Y, wx, wy, tick) {
    var fac = facOf(e.owner), rec = spRecU(e.type, fac), i;
    if (!rec || !rec.hull) return false;
    track8(e);
    var k = kx * TILE / rec.p, s = rec.s || 1, dir = e.dir || 0;
    if (e.mc === 2) {
      var alt = e.alt || 0, lift = airScreen(e) + (alt > 0.5 ? Math.sin(fxTime * 2.6 + e.id) * 1.2 : 0), hf = rec.hull[spIdx(dir, rec.hull.length)];
      if (!hf) return false;
      ctx.save(); ctx.globalAlpha = 0.6 - 0.28 * alt; ctx.translate(X + alt * 9 * zoomK, Y + alt * 2 * zoomK); ctx.scale(1, 0.6); spDraw(spVar(hf, 'shadow'), 0, 0, k); ctx.restore();
      spDraw(hf, X, Y - lift, k);
      if (rec.rotors && (alt > 0 || e.moving)) {
        var cd = Math.cos(dir), sd = Math.sin(dir);
        for (i = 0; i < rec.rotors.length; i++) {
          var ro = rec.rotors[i], rx = wx + (cd * ro[0] - sd * ro[2]) * s * TILE, ry = wy + (sd * ro[0] + cd * ro[2]) * s * TILE;
          var RX = PX(rx, ry), RY = PY(rx, ry) - lift - ro[1] * s * TILE * kx * HK, rw = ro[3] * s * TILE * kx, rh = ro[3] * s * TILE * ky;
          ctx.fillStyle = 'rgba(228,232,238,0.17)'; groundEllipse(RX, RY, rw, rh); ctx.fill();
          ctx.strokeStyle = 'rgba(30,34,40,0.2)'; ctx.lineWidth = 1; ctx.stroke();
          var a0 = fxTime * 17 * (i ? -1 : 1) + e.id;
          ctx.strokeStyle = 'rgba(25,28,34,0.42)'; ctx.lineWidth = 1.6 * clamp(zoomK, 0.7, 1.6); ctx.beginPath();
          for (var q = 0; q < 2; q++) { var aa = a0 + q * 1.5708; ctx.moveTo(RX + Math.cos(aa) * rw, RY + Math.sin(aa) * rh); ctx.lineTo(RX - Math.cos(aa) * rw, RY - Math.sin(aa) * rh); }
          ctx.stroke();
        }
      }
      return true;
    }
    wake2(e, wx, wy, dir);
    return spVehicle(e.type, fac, X, Y + Math.sin(fxTime * 1.9 + e.id) * 0.8 * zoomK, dir, e.tdir || 0, {
      moving: false, fireAge: tick - (e.fireT == null ? -100 : e.fireT), open: rampT[e.id] != null && fxTime - rampT[e.id] < 3, id: e.id });
  }
  /** Bombe (fällt aus Flughöhe, Schatten am Boden) bzw. Flugabwehr-Geschoss/-Rakete (steigt zur Flughöhe des Ziels). */
  function proj8(p, fr, px, py) {
    var src = G.Sim.get(p.src), K = kx * HK, X = PX(px, py), Y = PY(px, py), z, dx = p.tx - p.x0, dy = p.ty - p.y0, dl = Math.hypot(dx, dy) || 1;
    var ux = (MUA * dx + MVA * dy) / dl, uy = (MUB * dx + MVB * dy) / dl, ul = Math.hypot(ux, uy) || 1; ux /= ul; uy /= ul;
    if (p.bomb) {
      z = (src && src.mc === 2 ? src.alt || 1 : 1) * D.AIR_H * TILE * (1 - fr * fr);
      ctx.fillStyle = 'rgba(0,0,0,' + (0.15 + 0.3 * fr).toFixed(2) + ')'; groundEllipse(X, Y, 3 * zoomK, 1.6 * zoomK); ctx.fill();
      var Yb = Y - z * K, tl = 5 * zoomK, fall = fr * 4 * zoomK;
      ctx.lineCap = 'round'; ctx.strokeStyle = '#272b31'; ctx.lineWidth = 3.6 * clamp(zoomK, 0.7, 1.6);
      ctx.beginPath(); ctx.moveTo(X - ux * tl, Yb - uy * tl - fall); ctx.lineTo(X + ux * tl * 0.4, Yb + uy * tl * 0.4 + fall * 0.4); ctx.stroke(); ctx.lineCap = 'butt';
      return;
    }
    var z0 = src && src.mc === 2 ? (src.alt || 0) * D.AIR_H * TILE : (src && src.kind === 'building' ? (BHT[src.type] || 0.5) * TILE * 0.8 : 12);
    var tg = G.Sim.get(p.tid), z1 = (tg && tg.mc === 2 ? tg.alt || 0 : 1) * D.AIR_H * TILE;
    z = z0 + (z1 - z0) * fr; Y -= z * K;
    if (p.w === 'rocket') {
      for (var tj = 5; tj >= 1; tj--) {
        var tf = fr - tj * 0.05; if (tf < 0) continue;
        var tpx = p.x0 + dx * tf, tpy = p.y0 + dy * tf, tz = z0 + (z1 - z0) * tf;
        puff(PX(tpx, tpy), PY(tpx, tpy) - tz * K, (1.8 + tj * 0.8) * zoomK, 'rgba(225,222,214,', 0.5 * (1 - tj / 6));
      }
      ctx.fillStyle = '#fb923c'; ctx.beginPath(); ctx.arc(X, Y, 3 * zoomK, 0, 6.2832); ctx.fill();
    } else {
      ctx.strokeStyle = 'rgba(255,232,150,0.9)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(X - ux * 6 * zoomK, Y + (z1 - z0) / dl * 6 * K); ctx.lineTo(X, Y); ctx.stroke();
    }
  }
  function v8P(wx, wy, c, sn, lx, ly, lift) { var x = wx + c * lx - sn * ly, y = wy + sn * lx + c * ly; tmpX = PX(x, y); tmpY = PY(x, y) - lift; }
  function v8Poly(wx, wy, dir, pts, lift, fill, stroke) {
    var c = Math.cos(dir), sn = Math.sin(dir);
    ctx.beginPath();
    for (var i = 0; i < pts.length; i += 2) { v8P(wx, wy, c, sn, pts[i], pts[i + 1], lift); if (i) ctx.lineTo(tmpX, tmpY); else ctx.moveTo(tmpX, tmpY); }
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; ctx.stroke(); }
  }
  function v8Disc(wx, wy, r, lift, fill, stroke, lw) {
    ctx.beginPath();
    for (var i = 0; i < 12; i++) { var a = i / 12 * 6.2832, x = wx + Math.cos(a) * r, y = wy + Math.sin(a) * r; if (i) ctx.lineTo(PX(x, y), PY(x, y) - lift); else ctx.moveTo(PX(x, y), PY(x, y) - lift); }
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw || 1.2; ctx.stroke(); }
  }
  function v8Line(wx0, wy0, wx1, wy1, lift, col, lw) { ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.beginPath(); ctx.moveTo(PX(wx0, wy0), PY(wx0, wy0) - lift); ctx.lineTo(PX(wx1, wy1), PY(wx1, wy1) - lift); ctx.stroke(); }
  function drawV8Unit(e, X, Y, color, wx, wy, tick) {
    var dir = e.dir || 0, OL = 'rgba(8,10,14,0.9)', c = Math.cos(dir), sn = Math.sin(dir), dk = shade(color, 0.6);
    track8(e);
    if (e.mc === 2) {
      var alt = e.alt || 0, lift = airScreen(e) + (alt > 0.5 ? Math.sin(fxTime * 3 + e.id) * 1.5 : 0), sr = e.r * (1.1 - 0.4 * alt);
      ctx.fillStyle = 'rgba(0,0,0,' + (0.38 - 0.18 * alt).toFixed(2) + ')';   // Bodenschatten
      groundEllipse(X, Y, sr * kx, sr * ky * 0.7); ctx.fill();
      if (alt > 0.3) { ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(X, Y); ctx.lineTo(X, Y - lift + 4); ctx.stroke(); }
      var spin = fxTime * 28 + e.id;
      if (e.type === 'bomber') {
        v8Poly(wx, wy, dir, [6, 0, -7, -19, -12, -19, -8, -2, -8, 2, -12, 19, -7, 19], lift, dk, OL);   // Tragflächen
        v8Poly(wx, wy, dir, [-19, -3, 14, -3, 21, 0, 14, 3, -19, 3], lift, color, OL);                    // Rumpf
        v8Poly(wx, wy, dir, [-19, -8, -14, -8, -12, -2, -12, 2, -14, 8, -19, 8], lift, dk, OL);           // Leitwerk
        if (e.ammo > 0) for (var bi = 0; bi < Math.min(6, e.ammo); bi++) { v8P(wx, wy, c, sn, -4 + (bi % 3) * 4, bi < 3 ? -7 : 7, lift); ctx.fillStyle = '#111827'; ctx.fillRect(tmpX - 1.5, tmpY - 1.5, 3, 3); }
      } else if (e.type === 'gunship') {
        v8Poly(wx, wy, dir, [-6, -1.5, -21, -1, -21, 1, -6, 1.5], lift, dk, OL);                          // Heckausleger
        v8Poly(wx, wy, dir, [-2, -9, 4, -9, 4, 9, -2, 9], lift, '#374151', OL);                          // Stummelflügel mit Raketen
        v8Poly(wx, wy, dir, [-7, -4, 11, -3.5, 16, 0, 11, 3.5, -7, 4], lift, color, OL);                  // Rumpf
        v8Disc(wx + c * 2, wy + sn * 2, 13, lift + 2, 'rgba(200,210,220,0.14)', 'rgba(230,235,240,0.35)');
        v8Line(wx + c * 2 + Math.cos(spin) * 13, wy + sn * 2 + Math.sin(spin) * 13, wx + c * 2 - Math.cos(spin) * 13, wy + sn * 2 - Math.sin(spin) * 13, lift + 2, 'rgba(20,24,30,0.7)', 2);
      } else {   // transheli: Tandem-Rotoren
        v8Poly(wx, wy, dir, [-17, -5, 12, -5, 17, -2, 17, 2, 12, 5, -17, 5], lift, color, OL);
        v8Poly(wx, wy, dir, [-8, -3, 8, -3, 8, 3, -8, 3], lift, dk, null);
        for (var ri = 0; ri < 2; ri++) {
          var ox = ri ? -12 : 11, rx = wx + c * ox, ry = wy + sn * ox, sa = spin + ri * 0.8;
          v8Disc(rx, ry, 12, lift + 2, 'rgba(200,210,220,0.12)', 'rgba(230,235,240,0.32)');
          v8Line(rx + Math.cos(sa) * 12, ry + Math.sin(sa) * 12, rx - Math.cos(sa) * 12, ry - Math.sin(sa) * 12, lift + 2, 'rgba(20,24,30,0.7)', 2);
        }
      }
      return;
    }
    // Schiffe: Rumpf auf dem Wasser, Kielwasser in Fahrt
    var bob = Math.sin(fxTime * 2 + e.id) * 0.8, L = e.type === 'destroyer' ? 24 : (e.type === 'lander' ? 18 : 16);
    wake2(e, wx, wy, dir);
    var hullC = e.type === 'lander' ? '#6b7a5e' : '#6b7280', rop = e.type === 'lander' && rampT[e.id] != null && fxTime - rampT[e.id] < 3;
    if (e.type === 'destroyer') {
      v8Poly(wx, wy, dir, [-22, -8, 12, -8, 24, 0, 12, 8, -22, 8], bob, hullC, OL);
      v8Poly(wx, wy, dir, [-9, -4.5, 5, -4.5, 5, 4.5, -9, 4.5], bob + 3, color, OL);
      [[14, 0], [-16, 0]].forEach(function (tp) {
        v8P(wx, wy, c, sn, tp[0], tp[1], bob + 3); var tx0 = wx + c * tp[0], ty0 = wy + sn * tp[0];
        v8Line(tx0, ty0, tx0 + Math.cos(e.tdir || dir) * 13, ty0 + Math.sin(e.tdir || dir) * 13, bob + 4, '#1f2937', 3);
        v8Disc(tx0, ty0, 4.5, bob + 3, '#374151', OL);
      });
    } else if (e.type === 'lander') {
      v8Poly(wx, wy, dir, [-18, -9, 14, -9, 18, -7, 18, 7, 14, 9, -18, 9], bob, hullC, OL);
      v8Poly(wx, wy, dir, [-13, -6, 11, -6, 11, 6, -13, 6], bob + 1, '#3f4a37', null);
      v8Poly(wx, wy, dir, [-18, -9, -13, -9, -13, 9, -18, 9], bob + 2, color, OL);
      v8Poly(wx, wy, dir, rop ? [18, -7, 27, -7, 27, 7, 18, 7] : [13, -7, 18, -7, 18, 7, 13, 7], rop ? bob - 1 : bob + 1, '#545f48', OL);   // Bugklappe (offen: liegt vorn)
    } else {   // gunboat
      v8Poly(wx, wy, dir, [-14, -6, 8, -6, 16, 0, 8, 6, -14, 6], bob, hullC, OL);
      v8Poly(wx, wy, dir, [-10, -2.5, 4, -2.5, 4, 2.5, -10, 2.5], bob + 1, color, null);
      var gx0 = wx + c * 6, gy0 = wy + sn * 6;
      v8Line(gx0, gy0, gx0 + Math.cos(e.tdir || dir) * 11, gy0 + Math.sin(e.tdir || dir) * 11, bob + 3, '#1f2937', 2.6);
      v8Disc(gx0, gy0, 3.8, bob + 2, '#374151', OL);
    }
    void tick; void X; void Y;
  }
  // ------------------------------------------------------------------ v0.9 Schlachtschiff (dreadnought, SPEC_v08 §14)
  // Sprite-Modus (diagonal): spV9 – Rumpf-Sprite (16 Richtungen) auf der Wasserlinie + Bugwelle/Kielwasser (wake2), Werfer-Sprite (32 Richtungen) aus
  //   rec.dtur[i] mit Zustand rec.dst[i] = [Schienen-Erhöhung 0/½/1, Raketen 2/1/0] – gewählt nach geglätteter Aufbau-Stufe (dsv) und geladenen Raketen (dreadLoad).
  // Gerade Kamera / ohne Sprite: drawV9Dread (Vektorform, Koalition grau mit Landedeck, Syndikat oliv mit Pagodenturm + zwei Schornsteinen).
  // Effekte: Start (shot.missile) Flamme + Rauchsäule + Gischt, Rakete (proj.missile) hoher Bogen mit bleibender Rauchspur (F_TRAIL), Einschlag (hit w:'missile') groß.
  // Untergang: die8/wreck8 wie die übrigen Schiffe.
  var dsv = {};   // geglättete Aufbau-Stufe je Schlachtschiff { v, t } (Sim setzt setup in Fahrt sofort auf 0, 3D glättet ebenso)
  function dreadSetup(e) {
    var o = dsv[e.id], sv = e.setup || 0;
    if (!o) o = dsv[e.id] = { v: sv, t: fxTime };
    o.v += (sv - o.v) * Math.min(1, Math.max(0, fxTime - o.t) * 5); o.t = fxTime;
    return o.v;
  }
  /** Raketen auf den Schienen (wie r3-models dreadLoad): laufende Salve → Rest, sonst geladen ab 60 % der Nachladezeit. */
  function dreadLoad(e) {
    if (e.salvoN > 0) return e.salvoN;
    var u = D.UNITS[e.type], Pl = G.Sim.S.players[e.owner], w = u && Pl ? (u[Pl.faction] || u.coalition).weapon : null;
    if (!w) return 2;
    return (e.cd || 0) <= w.rof * D.TICK_HZ * 0.4 ? (w.salvo || 2) : 0;
  }
  function spV9(e, X, Y, wx, wy, tick) {
    var fac = facOf(e.owner), rec = spRecU(e.type, fac), i;
    if (!rec || !rec.hull || !rec.dtur) return false;
    var k = kx * TILE / rec.p, s = rec.s || 1, dir = e.dir || 0, bob = Math.sin(fxTime * 1.6 + e.id) * 0.7 * zoomK, hf = rec.hull[spIdx(dir, rec.hull.length)];
    if (!hf) return false;
    track8(e);
    wake2(e, wx, wy, dir);
    spDraw(hf, X, Y + bob, k);
    var sv = dreadSetup(e), n = dreadLoad(e), best = 0, bd = 1e9;
    for (i = 0; i < rec.dst.length; i++) { var q = rec.dst[i], dd = Math.abs(q[0] - sv) + Math.abs(q[1] - n) * 0.6; if (dd < bd) { bd = dd; best = i; } }
    var set = rec.dtur[best], td = e.tdir == null ? dir : e.tdir, cd = Math.cos(dir), sd = Math.sin(dir), p0 = rec.pivot[0] * s * TILE, p1 = rec.pivot[1] * s * TILE;
    var ox = cd * p0 - sd * p1, oy = sd * p0 + cd * p1, fa = tick - (e.fireT == null ? -100 : e.fireT);
    if (fa >= 0 && fa < 5) { var rc = 0.025 * s * TILE * (1 - fa / 5); ox -= Math.cos(td) * rc; oy -= Math.sin(td) * rc; }
    spDraw(set[spIdx(td, set.length)], X + MUA * ox + MVA * oy, Y + bob + MUB * ox + MVB * oy, k);
    return true;
  }
  /** Vektorform (gerade Kamera / ohne Sprites): Rumpf ≈ 2 Kacheln, Aufbauten je Fraktion, Werfer mit Schienen (heben sich mit setup) und Raketen (geladen). */
  function drawV9Dread(e, color, wx, wy) {
    var dir = e.dir || 0, OL = 'rgba(8,10,14,0.9)', c = Math.cos(dir), sn = Math.sin(dir), bob = Math.sin(fxTime * 1.6 + e.id) * 0.6, td = e.tdir == null ? dir : e.tdir;
    var syn = facOf(e.owner) === 'syndicate', HULL = syn ? '#66705a' : '#8a96a1', DECK = syn ? '#57543f' : '#5d6870', BODY = syn ? '#7d8270' : '#c3c9cf', BODY2 = syn ? '#6a6f5e' : '#a3abb4';
    track8(e);
    wake2(e, wx, wy, dir);
    // Rumpf (Seitenwand dunkler, Deck heller), spitzer Bug
    v8Poly(wx, wy, dir, [-32, -8, 4, -8.5, 20, -6.5, 34, 0, 20, 6.5, 4, 8.5, -32, 8], bob, shade(HULL, 0.72), OL);
    v8Poly(wx, wy, dir, [-31, -7, 4, -7.5, 19, -5.6, 31, 0, 19, 5.6, 4, 7.5, -31, 7], bob + 2.5, DECK, null);
    v8Poly(wx, wy, dir, [-31, -7.2, 4, -7.7, 4, -6.4, -31, -6], bob + 2.6, color, null);   // Teamfarbe am Deckrand
    v8Poly(wx, wy, dir, [-31, 6, 4, 6.4, 4, 7.7, -31, 7.2], bob + 2.6, color, null);
    if (!syn) {
      v8Poly(wx, wy, dir, [-26, -5.5, -12, -5.5, -12, 5.5, -26, 5.5], bob + 3, BODY2, OL);                 // Hangar
      v8Disc(wx - c * 27, wy - sn * 27, 4.8, bob + 2.7, '#3a4048', 'rgba(230,230,225,0.8)', 1);             // Landedeck
      v8Poly(wx, wy, dir, [-15, -5.5, 6, -5.5, 6, 5.5, -15, 5.5], bob + 5, BODY, OL);                      // Deckshaus
      v8Poly(wx, wy, dir, [-5, -4, 3, -4, 5, 0, 3, 4, -5, 4], bob + 11, BODY2, OL);                         // Brücke
      v8Poly(wx, wy, dir, [-6, -4.2, 3.5, -4.2, 3.5, -3, -6, -3], bob + 11.2, color, null);
      v8Disc(wx - c * 11.5, wy - sn * 11.5, 2.6, bob + 13, '#2b3138', OL);                                 // Schornstein
    } else {
      v8Poly(wx, wy, dir, [-24, -6, -2, -6, -2, 6, -24, 6], bob + 5, BODY2, OL);                            // Zitadelle
      v8Poly(wx, wy, dir, [-5, -4.5, 4, -4.5, 4, 4.5, -5, 4.5], bob + 9, BODY, OL);                          // Pagodenturm
      v8Poly(wx, wy, dir, [-3.5, -3.2, 3, -3.2, 3, 3.2, -3.5, 3.2], bob + 15, '#8a4a2e', OL);
      v8Poly(wx, wy, dir, [-3, -3.4, 2.5, -3.4, 2.5, -2.4, -3, -2.4], bob + 15.2, color, null);
      v8Disc(wx - c * 7, wy - sn * 7, 2.4, bob + 12, '#8a4a2e', OL); v8Disc(wx - c * 13.5, wy - sn * 13.5, 2.4, bob + 12, '#8a4a2e', OL);   // zwei Schornsteine
      v8Disc(wx - c * 26, wy - sn * 26, 3.2, bob + 4, BODY2, OL);                                            // Heckgeschütz
      v8Line(wx - c * 27, wy - sn * 27, wx - c * 33, wy - sn * 33, bob + 5, '#2b2f26', 1.6);
    }
    // Werfer: Drehkranz + Lafette bei pivot (0.44 Kacheln), Schienen entlang tdir; Erhöhung = Spitze steigt mit setup
    var sv = dreadSetup(e), n = dreadLoad(e), px = wx + c * 14, py = wy + sn * 14, ct = Math.cos(td), st = Math.sin(td), up = smooth01(sv) * 17;
    v8Disc(px, py, 5.2, bob + 4, syn ? '#3f4337' : '#4b545e', OL);
    v8Poly(px, py, td, [-5, -4.5, 3, -4.5, 3, 4.5, -5, 4.5], bob + 6, syn ? BODY : BODY2, OL);
    function rail(off, col, lw, z0) { var x0 = px + ct * -2 - st * off, y0 = py + st * -2 + ct * off, x1 = px + ct * 15 - st * off, y1 = py + st * 15 + ct * off; ctx.strokeStyle = col; ctx.lineWidth = lw * clamp(zoomK, 0.7, 1.6); ctx.beginPath(); ctx.moveTo(PX(x0, y0), PY(x0, y0) - bob - z0); ctx.lineTo(PX(x1, y1), PY(x1, y1) - bob - z0 - up); ctx.stroke(); }
    rail(0, '#2b3036', 6, 7.5); rail(-2.3, syn ? '#8a4a2e' : '#59616b', 1.6, 8.5); rail(2.3, syn ? '#8a4a2e' : '#59616b', 1.6, 8.5);
    if (n >= 2) rail(-2.3, syn ? '#c9c19a' : '#eef0f2', 2.4, 10);
    if (n >= 1) rail(2.3, syn ? '#c9c19a' : '#eef0f2', 2.4, 10);
  }
  function smooth01(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
  /** Rakete im Flug: Höhe über dem Boden (Welt-px): von der Werferhöhe zum Ziel, Bogen wie 3D (0.6 + 0.24·Distanz Kacheln). */
  function missileZ(p, fr) { var d = Math.hypot(p.tx - p.x0, p.ty - p.y0) / TILE, h = (0.6 + 0.24 * d) * TILE; return 23 + (3 - 23) * fr + h * 4 * fr * (1 - fr); }
  var mtrail = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  /** Schlachtschiff-Rakete: Körper entlang der Bildschirm-Bahn, Triebwerksglut, bleibende Rauchspur (F_TRAIL alle ≈ 7 px Weg). */
  function missile2(p, fr) {
    var K = kx * HK, dx = p.tx - p.x0, dy = p.ty - p.y0, d = Math.hypot(dx, dy) || 1, px = p.x0 + dx * fr, py = p.y0 + dy * fr, z = missileZ(p, fr);
    var st = mtrail && mtrail.get(p);
    if (!st) { st = { f: Math.max(0, fr - 0.01) }; if (mtrail) mtrail.set(p, st); }
    var stepF = 7 / (d + 3 * TILE), nn = 0;
    while (st.f + stepF <= fr && nn++ < 30) { st.f += stepF; addFx(F_TRAIL, p.x0 + dx * st.f + (Math.random() - 0.5) * 2, p.y0 + dy * st.f + (Math.random() - 0.5) * 2, missileZ(p, st.f), 0, 0, 0, 1.5 + Math.random() * 0.6, 3 + Math.random()); }
    var X = PX(px, py), Y = PY(px, py) - z * K, f0 = Math.max(0, fr - 0.02), X0 = PX(p.x0 + dx * f0, p.y0 + dy * f0), Y0 = PY(p.x0 + dx * f0, p.y0 + dy * f0) - missileZ(p, f0) * K;
    var ux = X - X0, uy = Y - Y0, ul = Math.hypot(ux, uy) || 1, zk = clamp(zoomK, 0.7, 1.8); ux /= ul; uy /= ul;
    ctx.fillStyle = 'rgba(255,170,60,0.35)'; ctx.beginPath(); ctx.arc(X - ux * 6 * zk, Y - uy * 6 * zk, 5 * zk, 0, 6.2832); ctx.fill();
    ctx.fillStyle = 'rgba(255,235,160,0.95)'; ctx.beginPath(); ctx.arc(X - ux * 5.5 * zk, Y - uy * 5.5 * zk, 2.2 * zk, 0, 6.2832); ctx.fill();
    ctx.lineCap = 'round'; ctx.strokeStyle = '#e6e8ea'; ctx.lineWidth = 3 * zk; ctx.beginPath(); ctx.moveTo(X - ux * 4.5 * zk, Y - uy * 4.5 * zk); ctx.lineTo(X + ux * 3 * zk, Y + uy * 3 * zk); ctx.stroke();
    ctx.strokeStyle = '#30363d'; ctx.lineWidth = 3 * zk; ctx.beginPath(); ctx.moveTo(X + ux * 3 * zk, Y + uy * 3 * zk); ctx.lineTo(X + ux * 5 * zk, Y + uy * 5 * zk); ctx.stroke(); ctx.lineCap = 'butt';
  }
  function v8Building(b, color, o, cxm, cym, tm) {
    var wx = b.x != null ? b.x : (b.tx + b.w / 2) * TILE, wy = b.y != null ? b.y : (b.ty + b.h / 2) * TILE, i;
    if (b.type === 'airfield') {
      boxBase('#7b8290', '#5c6370');
      var x0 = b.tx * TILE, y0 = b.ty * TILE, W2 = b.w * TILE, H2 = b.h * TILE, lift = BG;
      ctx.fillStyle = '#3b4048'; ctx.beginPath();
      [[x0 + 4, y0 + H2 * 0.2], [x0 + W2 - 4, y0 + H2 * 0.2], [x0 + W2 - 4, y0 + H2 * 0.9], [x0 + 4, y0 + H2 * 0.9]].forEach(function (q, k) { var X0 = PX(q[0], q[1]), Y0 = PY(q[0], q[1]) - lift; if (k) ctx.lineTo(X0, Y0); else ctx.moveTo(X0, Y0); });
      ctx.closePath(); ctx.fill();
      var np = 4;
      for (i = 0; i < np; i++) {
        var px = (b.tx + (i + 0.5) * b.w / np) * TILE, py = (b.ty + b.h * 0.55) * TILE;
        v8Disc(px, py, 12, lift, '#4b5160', '#e5e7eb', 2);
        v8Line(px - 4, py - 5, px - 4, py + 5, lift, '#e5e7eb', 2); v8Line(px + 4, py - 5, px + 4, py + 5, lift, '#e5e7eb', 2); v8Line(px - 4, py, px + 4, py, lift, '#e5e7eb', 2);   // „H“
      }
      v8Line(x0 + 6, y0 + 6, x0 + W2 * 0.4, y0 + 6, lift, color, 4);
    } else if (b.type === 'shipyard') {
      boxBase('#8a8f98', '#646a74');
      rrect(BX + BW * 0.1, BY + BH * 0.25, BW * 0.5, BH * 0.5, '#1e3a5f');            // Helling
      rrect(BX, BY + BH, BW, 5, color);
      ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 3; ctx.beginPath();                 // Kran
      ctx.moveTo(BX + BW * 0.78, BY + BH * 0.8); ctx.lineTo(BX + BW * 0.78, BY - 22 * tm); ctx.lineTo(BX + BW * 0.3, BY - 22 * tm); ctx.stroke();
      ctx.strokeStyle = '#1f2937'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(BX + BW * 0.36, BY - 22 * tm); ctx.lineTo(BX + BW * 0.36, BY + BH * 0.3); ctx.stroke();
    } else {   // flak
      boxBase('#7c8794', '#5b6571');
      var a = b.tdir == null ? -1.2 : b.tdir;
      for (i = -1; i <= 1; i += 2) v8Line(wx + Math.cos(a + 1.57) * 3 * i, wy + Math.sin(a + 1.57) * 3 * i, wx + Math.cos(a + 1.57) * 3 * i + Math.cos(a) * 14, wy + Math.sin(a + 1.57) * 3 * i + Math.sin(a) * 14, BG + 10 * tm, '#111827', 3);
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(cxm, cym, 5 * tm + 2, 0, 6.2832); ctx.fill(); ctx.strokeStyle = OUT; ctx.lineWidth = 1.2; ctx.stroke();
    }
    void o;
  }
  function drawBuilding(b, color, S, o) {
    var type = b.type, hgt = bHeight(type) * (o.grow == null ? 1 : 0.3 + 0.7 * o.grow);
    bgeom(b);
    BG = hgt; BW = GW; BH = GH; BX = GCX - GW / 2; BY = GCY - GH / 2 - hgt;
    var cxm = BX + BW / 2, cym = BY + BH / 2, tc = type, tm = zoomK;
    if (o.alpha != null) ctx.globalAlpha = o.alpha;
    if (ROT && tc !== 'wall' && !o.ruin) { // gedrehte Grundfläche (Raute) unter dem aufrechten Quader
      footPath(b.tx * TILE, b.ty * TILE, b.w * TILE, b.h * TILE, 0);
      ctx.fillStyle = o.dim ? 'rgba(40,40,44,0.5)' : 'rgba(78,74,66,0.5)'; ctx.fill(); ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 1.4; ctx.stroke();
    }
    // Auswahl-/Schattenfläche am Boden
    if (o.ruin) { drawRuin(b); ctx.globalAlpha = 1; return; }
    switch (tc) {
      case 'hq':
        boxBase('#9aa3b3', '#6f7889');
        rrect(BX, BY + BH, BW, 6, color); rrect(BX + BW * 0.4, BY + BH + BG * 0.35, BW * 0.2, BG * 0.65, '#1c222b');
        windows(3, 1, '#9fd0ee', BY + BH + 6, BG * 0.6);
        ctx.fillStyle = shade(color, 0.85); ctx.fillRect(BX + BW * 0.16, BY + BH * 0.18, BW * 0.68, BH * 0.64);
        ctx.fillStyle = '#e8edf3'; ctx.beginPath(); ctx.ellipse(cxm, cym, BW * 0.2, BH * 0.34, 0, 0, 6.2832); ctx.fill();
        ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
        ctx.fillStyle = '#334155'; ctx.fillRect(cxm - 1.5, cym - BH * 0.2, 3, BH * 0.4); ctx.fillRect(cxm - BW * 0.07, cym - 1.5, BW * 0.14, 3);
        ctx.strokeStyle = '#20252c'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(BX + BW - 8, BY + 8); ctx.lineTo(BX + BW - 8, BY - 16 * tm); ctx.stroke();
        ctx.fillStyle = '#ef4444'; ctx.beginPath(); ctx.arc(BX + BW - 8, BY - 16 * tm, 2.6, 0, 6.2832); ctx.fill();
        break;
      case 'power':
        boxBase('#8c95a4', '#68707e');
        rrect(BX, BY + BH, BW, 5, color); bolt(cxm, BY + BH + BG * 0.62, clamp(BG / 22, 0.7, 1.4), '#fde047');
        for (var pi = 0; pi < 2; pi++) {
          var tx = BX + BW * (0.28 + pi * 0.44), tr = BW * 0.17, tb = BY + BH * 0.78;
          cylinder(tx, tb, tr, 20 * tm, '#cfd5de', '#2a3038');
          ctx.strokeStyle = color; ctx.lineWidth = 2.2; ctx.beginPath(); ctx.ellipse(tx, tb - 20 * tm, tr, tr * 0.45, 0, 0, 6.2832); ctx.stroke();
          var st = (fxTime * 0.5 + pi * 0.5) % 1; ctx.fillStyle = 'rgba(245,248,252,' + (0.5 * (1 - st)).toFixed(2) + ')';
          ctx.beginPath(); ctx.arc(tx + st * 4, tb - 20 * tm - st * 22, tr * (0.5 + st * 0.7), 0, 6.2832); ctx.fill();
        }
        break;
      case 'refinery':
        boxBase('#868b95', '#656b76');
        rrect(BX, BY + BH, BW, 5, color); rrect(BX + BW * 0.08, BY + BH + BG * 0.45, BW * 0.18, BG * 0.55, '#1c222b');
        cylinder(BX + BW * 0.28, BY + BH * 0.8, BW * 0.17, 16 * tm, '#b7b2a8', '#4b5059');
        cylinder(BX + BW * 0.58, BY + BH * 0.8, BW * 0.12, 22 * tm, '#a8a29e', '#4b5059');
        rrect(BX + BW * 0.74, BY + BH * 0.22, BW * 0.2, BH * 0.5, shade(color, 0.9)); rrect(BX + BW * 0.74, BY + BH * 0.22, BW * 0.2, 3, 'rgba(255,255,255,0.3)');
        ctx.strokeStyle = '#3a3f47'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(BX + BW * 0.28, BY + BH * 0.8 - 16 * tm); ctx.lineTo(BX + BW * 0.58, BY + BH * 0.8 - 22 * tm); ctx.stroke();
        var fl = 0.7 + 0.3 * Math.sin(fxTime * 11); ctx.fillStyle = 'rgba(255,170,40,' + fl.toFixed(2) + ')';
        ctx.beginPath(); ctx.arc(BX + BW * 0.58, BY + BH * 0.8 - 30 * tm, 3.6, 0, 6.2832); ctx.fill();
        ctx.fillStyle = 'rgba(255,230,120,0.9)'; ctx.beginPath(); ctx.arc(BX + BW * 0.58, BY + BH * 0.8 - 30 * tm, 1.6, 0, 6.2832); ctx.fill();
        break;
      case 'barracks':
        boxBase(hexMix('#7a3b30', color, 0.45), '#8d8376');
        ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(BX, BY + BH * 0.5 - 1, BW, 2); ctx.fillStyle = 'rgba(255,255,255,0.22)'; ctx.fillRect(BX, BY + BH * 0.5 + 1, BW, 2);
        rrect(BX + BW * 0.38, BY + BH + BG * 0.35, BW * 0.24, BG * 0.65, '#20262e'); windows(2, 1, '#cfe6f5', BY + BH, BG * 0.5);
        ctx.fillStyle = color; ctx.fillRect(BX + BW * 0.4, BY + BH * 0.2, BW * 0.2, BH * 0.18);
        break;
      case 'factory':
        boxBase('#8e96a3', '#6a7280');
        rrect(BX, BY + BH, BW, 6, color); rrect(BX + BW * 0.22, BY + BH + BG * 0.3, BW * 0.56, BG * 0.7, '#1b2028');
        ctx.fillStyle = 'rgba(255,255,255,0.12)'; for (var fi = 0; fi < 4; fi++) ctx.fillRect(BX + BW * 0.22, BY + BH + BG * (0.38 + fi * 0.16), BW * 0.56, 1.5);
        ctx.strokeStyle = 'rgba(0,0,0,0.28)'; ctx.lineWidth = 3; for (var fj = 0; fj < 3; fj++) { ctx.beginPath(); ctx.moveTo(BX + BW * (0.1 + fj * 0.3), BY + BH * 0.9); ctx.lineTo(BX + BW * (0.3 + fj * 0.3), BY + BH * 0.1); ctx.stroke(); }
        rrect(BX + BW * 0.78, BY + BH * 0.15, 9 * tm, 9 * tm, '#55606d'); cylinder(BX + BW * 0.84, BY + BH * 0.32, 5 * tm, 22 * tm, '#59616d', '#20252c');
        smokeCol(BX + BW * 0.84, BY + BH * 0.32 - 22 * tm, 3);
        break;
      case 'turret': case 'mg':
        turretShape(b, color, S, o); break;
      case 'techcenter': {
        var syn = FAC === 'syndicate', tcw = syn ? '#c9b99a' : '#9fd0ee';
        boxBase(syn ? '#7f766b' : '#9aa5b8', syn ? '#5d554c' : '#6c7890');
        rrect(BX, BY + BH, BW, 6, color); rrect(BX + BW * 0.4, BY + BH + BG * 0.35, BW * 0.2, BG * 0.65, '#1c222b');
        windows(4, 2, tcw, BY + BH + 6, BG * 0.6);
        // Dach: Labor-Kuppel, Schüssel, Mast
        ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.fillRect(BX + BW * 0.06, BY + BH * 0.5, BW * 0.5, BH * 0.4);
        var dcx = BX + BW * 0.3, dcy = BY + BH * 0.68, dr = Math.min(BW * 0.2, BH * 0.3);
        ctx.fillStyle = '#2a3038'; ctx.beginPath(); ctx.ellipse(dcx, dcy, dr * 1.1, dr * 0.5, 0, 0, 6.2832); ctx.fill();
        ctx.fillStyle = syn ? '#e0b184' : '#bfe3f5'; ctx.beginPath(); ctx.ellipse(dcx, dcy, dr, dr * 0.45, 0, 0, Math.PI); ctx.lineTo(dcx - dr, dcy); ctx.arc(dcx, dcy, dr, Math.PI, 0); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.beginPath(); ctx.ellipse(dcx - dr * 0.3, dcy - dr * 0.45, dr * 0.25, dr * 0.14, -0.5, 0, 6.2832); ctx.fill();
        ctx.strokeStyle = OUT; ctx.lineWidth = 1.1; ctx.beginPath(); ctx.arc(dcx, dcy, dr, Math.PI, 0); ctx.stroke();
        var gl = 0.5 + 0.5 * Math.sin(fxTime * 2.4); ctx.fillStyle = 'rgba(' + (syn ? '255,150,60' : '120,220,255') + ',' + (0.25 + 0.3 * gl).toFixed(2) + ')'; ctx.beginPath(); ctx.arc(dcx, dcy - dr * 0.35, dr * 0.4, 0, 6.2832); ctx.fill();
        var tmx = BX + BW * 0.72, tmb = BY + BH * 0.62; // Schüssel
        ctx.strokeStyle = '#4b5059'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(tmx, tmb); ctx.lineTo(tmx, tmb - 16 * tm); ctx.stroke();
        var tdw = (0.55 + 0.45 * Math.abs(Math.cos(fxTime * 0.9))) * BW * 0.16 + 3;
        ctx.fillStyle = '#e9ecef'; ctx.beginPath(); ctx.ellipse(tmx, tmb - 20 * tm, tdw, BW * 0.11, -0.4, 0, 6.2832); ctx.fill(); ctx.strokeStyle = OUT; ctx.lineWidth = 1.1; ctx.stroke();
        ctx.strokeStyle = '#20252c'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(BX + BW - 9, BY + BH * 0.35); ctx.lineTo(BX + BW - 9, BY + BH * 0.35 - 30 * tm); ctx.stroke();
        ctx.fillStyle = Math.sin(fxTime * 4) > 0 ? '#ef4444' : '#7f1d1d'; ctx.beginPath(); ctx.arc(BX + BW - 9, BY + BH * 0.35 - 30 * tm, 2.6, 0, 6.2832); ctx.fill();
        break; }
      case 'orbital': {
        var och = b.charge || 0, orr = och >= 1, opu = 0.6 + 0.4 * Math.sin(fxTime * 7);
        boxBase('#aab6c9', '#7885a0');
        rrect(BX, BY + BH, BW, 5, color); windows(3, 1, '#bfe9ff', BY + BH + 5, BG * 0.6); rrect(BX + BW * 0.42, BY + BH + BG * 0.45, BW * 0.16, BG * 0.55, '#1c222b');
        for (var sw2 = 0; sw2 < 2; sw2++) { // Solarflügel
          var swx = BX + (sw2 ? BW * 0.68 : BW * 0.04), sww = BW * 0.28, swy = BY + BH * 0.2, swh = BH * 0.6;
          ctx.fillStyle = '#1e3a8a'; ctx.fillRect(swx, swy, sww, swh); ctx.strokeStyle = 'rgba(147,197,253,0.7)'; ctx.lineWidth = 1; ctx.beginPath();
          for (var gi2 = 1; gi2 < 4; gi2++) { ctx.moveTo(swx + sww * gi2 / 4, swy); ctx.lineTo(swx + sww * gi2 / 4, swy + swh); } ctx.moveTo(swx, swy + swh / 2); ctx.lineTo(swx + sww, swy + swh / 2); ctx.stroke();
          ctx.strokeStyle = OUT; ctx.lineWidth = 1.1; ctx.strokeRect(swx, swy, sww, swh);
        }
        var oex = BX + BW / 2, oey = BY + BH * 0.6; // Sockel + Emitter
        ctx.fillStyle = '#2a3038'; ctx.beginPath(); ctx.ellipse(oex, oey, BW * 0.16, BH * 0.3, 0, 0, 6.2832); ctx.fill();
        ctx.fillStyle = '#cfd8e6'; ctx.beginPath(); ctx.ellipse(oex, oey - 3, BW * 0.12, BH * 0.22, 0, 0, 6.2832); ctx.fill(); ctx.strokeStyle = OUT; ctx.lineWidth = 1.1; ctx.stroke();
        var eh = 34 * tm; ctx.fillStyle = '#e5ecf6'; ctx.fillRect(oex - 3.5, oey - 3 - eh, 7, eh); ctx.fillStyle = 'rgba(0,0,0,0.2)'; ctx.fillRect(oex + 0.5, oey - 3 - eh, 3, eh);
        ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(oex - 3.5, oey - 3 - eh * 0.45); ctx.lineTo(oex + 3.5, oey - 3 - eh * 0.45); ctx.stroke();
        var lensY = oey - 3 - eh - 3, lr = 7 * tm;
        ctx.fillStyle = '#334155'; ctx.beginPath(); ctx.arc(oex, lensY, lr + 2, 0, 6.2832); ctx.fill();
        ctx.fillStyle = 'rgba(125,211,252,' + (orr ? (0.55 + 0.45 * opu) : 0.25 + 0.4 * och).toFixed(2) + ')'; ctx.beginPath(); ctx.arc(oex, lensY, lr + (orr ? 5 * opu : 0), 0, 6.2832); ctx.fill();
        ctx.fillStyle = orr ? '#ffffff' : '#7dd3fc'; ctx.beginPath(); ctx.arc(oex, lensY, lr * 0.55, 0, 6.2832); ctx.fill();
        ctx.strokeStyle = OUT; ctx.lineWidth = 1.1; ctx.beginPath(); ctx.arc(oex, lensY, lr + 2, 0, 6.2832); ctx.stroke();
        if (orr) { ctx.strokeStyle = 'rgba(190,235,255,' + (0.25 + 0.2 * opu).toFixed(2) + ')'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(oex, lensY - lr); ctx.lineTo(oex, lensY - lr - 46 * tm); ctx.stroke(); }
        break; }
      case 'silo': {
        var sch = b.charge || 0, sro = sch >= 1, spu = 0.5 + 0.5 * Math.sin(fxTime * 6);
        boxBase('#6f6c5a', '#4d4b3e');
        rrect(BX, BY + BH, BW, 5, color); ctx.fillStyle = '#facc15'; // Warnstreifen
        for (var hz2 = 0; hz2 < BW; hz2 += 14) { ctx.beginPath(); ctx.moveTo(BX + hz2, BY + BH + 5); ctx.lineTo(BX + hz2 + 7, BY + BH + 5); ctx.lineTo(BX + hz2 + 3, BY + BH + 5 + Math.min(BG - 5, 9)); ctx.lineTo(BX + hz2 - 4, BY + BH + 5 + Math.min(BG - 5, 9)); ctx.closePath(); ctx.fill(); }
        rrect(BX + BW * 0.42, BY + BH + BG * 0.55, BW * 0.16, BG * 0.45, '#16191d');
        var hx0 = BX + BW * 0.12, hy0 = BY + BH * 0.14, hw0 = BW * 0.76, hh0 = BH * 0.72, open = sro ? 0.34 : 0;
        ctx.fillStyle = '#0d0f10'; ctx.fillRect(hx0, hy0, hw0, hh0); // Schacht
        if (sro) { // Rakete ragt aus dem Schacht
          var mx3 = BX + BW / 2, mb3 = hy0 + hh0 * 0.6, mh = 30 * tm + 4 * spu;
          ctx.fillStyle = '#d6d9de'; ctx.fillRect(mx3 - 6, mb3 - mh, 12, mh); ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.fillRect(mx3 + 1, mb3 - mh, 5, mh);
          ctx.fillStyle = color; ctx.fillRect(mx3 - 6, mb3 - mh * 0.45, 12, 4); ctx.fillRect(mx3 - 6, mb3 - mh * 0.75, 12, 3);
          ctx.fillStyle = '#ef4444'; ctx.beginPath(); ctx.moveTo(mx3 - 6, mb3 - mh); ctx.lineTo(mx3, mb3 - mh - 13 * tm); ctx.lineTo(mx3 + 6, mb3 - mh); ctx.closePath(); ctx.fill();
          ctx.strokeStyle = OUT; ctx.lineWidth = 1.1; ctx.strokeRect(mx3 - 6, mb3 - mh, 12, mh);
        }
        var dw3 = hw0 / 2 * (1 - open); // Schiebetore
        for (var dd = 0; dd < 2; dd++) {
          var dx3 = dd ? hx0 + hw0 - dw3 : hx0;
          ctx.fillStyle = '#585a50'; ctx.fillRect(dx3, hy0, dw3, hh0); ctx.fillStyle = 'rgba(255,255,255,0.14)'; ctx.fillRect(dx3, hy0, dw3, 2);
          ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(dx3, hy0 + hh0 * 0.5 - 1, dw3, 2); ctx.strokeStyle = OUT; ctx.lineWidth = 1.2; ctx.strokeRect(dx3, hy0, dw3, hh0);
        }
        for (var li = 0; li < 6; li++) { // Ladelampen
          ctx.fillStyle = li < Math.floor(sch * 6) || sro ? (sro ? 'rgba(239,68,68,' + (0.5 + 0.5 * spu).toFixed(2) + ')' : '#fbbf24') : '#2a2d2b';
          ctx.beginPath(); ctx.arc(hx0 + hw0 * (li + 0.5) / 6, hy0 + hh0 + 5, 2.4, 0, 6.2832); ctx.fill();
        }
        if (sro) { ctx.fillStyle = 'rgba(239,68,68,' + (0.35 + 0.5 * spu).toFixed(2) + ')'; ctx.beginPath(); ctx.arc(BX + BW - 7, BY + 7, 3.2, 0, 6.2832); ctx.fill(); }
        break; }
      case 'house':
        boxBase('#a4604a', '#d6cbad');
        ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.fillRect(BX, BY + BH * 0.5 - 1, BW, 2); ctx.fillStyle = 'rgba(255,255,255,0.22)'; ctx.fillRect(BX, BY + BH * 0.5 + 1, BW, 2);
        ctx.fillStyle = '#c47a60'; ctx.fillRect(BX + BW * 0.78, BY + 3, BW * 0.1, BH * 0.3);
        windows(2, 1, '#6fa6c4', BY + BH, BG * 0.7); rrect(BX + BW * 0.42, BY + BH + BG * 0.45, BW * 0.16, BG * 0.55, '#5a4332');
        break;
      case 'block':
        boxBase('#a6a8a3', '#d3c9ac');
        rrect(BX + BW * 0.1, BY + BH * 0.15, BW * 0.2, BH * 0.35, '#868981'); rrect(BX + BW * 0.62, BY + BH * 0.4, BW * 0.26, BH * 0.4, '#8f928b');
        windows(4, 3, '#6fa6c4', BY + BH + 2, BG - 6); rrect(BX + BW * 0.44, BY + BH + BG * 0.62, BW * 0.12, BG * 0.38, '#5a4332');
        break;
      case 'wall': wallShape(b, color, S, o); break;
      case 'pbunker': pbunkerShape(b, color, S, o); break;
      case 'laser': laserShape(b, color, S, o); break;
      case 'tesla': teslaShape(b, color, S, o); break;
      case 'bunker':
        boxBase('#8e918a', '#a6a8a3');
        ctx.fillStyle = '#7d8079'; ctx.fillRect(BX + 3, BY + 3, BW - 6, BH - 6);
        rrect(BX + BW * 0.18, BY + BH + BG * 0.22, BW * 0.64, Math.max(3, BG * 0.4), '#1b2026');
        ctx.fillStyle = '#b39d72'; for (var bi = 0; bi < 5; bi++) { ctx.beginPath(); ctx.ellipse(BX + BW * (0.12 + bi * 0.19), BY + BH + 2, BW * 0.09, 3.5, 0, 0, 6.2832); ctx.fill(); }
        break;
      case 'oilrig':
        boxBase('#3b4249', '#2b3035');
        ctx.fillStyle = '#d97706'; ctx.fillRect(BX, BY + BH, BW, 3);
        var ox = cxm, ob = BY + BH * 0.8, oh = 64 * tm;
        ctx.strokeStyle = '#d97706'; ctx.lineWidth = 2.4; ctx.beginPath(); ctx.moveTo(ox - BW * 0.17, ob); ctx.lineTo(ox, ob - oh); ctx.lineTo(ox + BW * 0.17, ob); ctx.stroke();
        ctx.lineWidth = 1.4; ctx.beginPath(); for (var oi = 1; oi < 5; oi++) { var oy = ob - oh * oi / 5, ow = BW * 0.17 * (1 - oi / 5); ctx.moveTo(ox - ow, oy); ctx.lineTo(ox + ow, oy); } ctx.stroke();
        ctx.fillStyle = '#111827'; ctx.fillRect(ox - 4, ob - oh - 3, 8, 6);
        var ph2 = Math.sin(fxTime * 2.2); // Pumpenkopf nickt
        ctx.strokeStyle = '#1f2937'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(BX + BW * 0.22, BY + BH * 0.55 + ph2 * 2); ctx.lineTo(BX + BW * 0.62, BY + BH * 0.45 - ph2 * 3); ctx.stroke();
        ctx.fillStyle = '#d97706'; ctx.beginPath(); ctx.arc(BX + BW * 0.64, BY + BH * 0.45 - ph2 * 3, 4, 0, 6.2832); ctx.fill();
        ctx.fillStyle = '#0b0b0c'; ctx.beginPath(); ctx.ellipse(BX + BW * 0.78, BY + BH * 0.7, BW * 0.12, BH * 0.15, 0, 0, 6.2832); ctx.fill();
        break;
      case 'radar':
        boxBase('#a6a8a3', '#c9cdc9');
        rrect(BX, BY + BH, BW, 3, '#2f9e5a'); windows(2, 1, '#6fa6c4', BY + BH + 3, BG * 0.6);
        var mx2 = cxm, mb2 = BY + BH * 0.55; ctx.strokeStyle = '#4b5059'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(mx2, mb2); ctx.lineTo(mx2, mb2 - 22 * tm); ctx.stroke();
        var dw = Math.abs(Math.cos(fxTime * 1.3)) * BW * 0.34 + 4, dc = mb2 - 28 * tm;
        ctx.fillStyle = '#e9ecef'; ctx.beginPath(); ctx.ellipse(mx2, dc, dw, BW * 0.2, -0.4, 0, 6.2832); ctx.fill(); ctx.strokeStyle = OUT; ctx.lineWidth = 1.2; ctx.stroke();
        ctx.fillStyle = '#5b636c'; ctx.beginPath(); ctx.arc(mx2, dc, 2.4, 0, 6.2832); ctx.fill();
        break;
      case 'hospital':
        boxBase('#e9edf0', '#d8dee3');
        rrect(BX, BY + BH, BW, 4, '#dc2626'); windows(3, 1, '#7fb7d6', BY + BH + 4, BG * 0.7);
        var cs2 = Math.min(BW * 0.5, BH * 0.7) * 0.5;
        ctx.fillStyle = '#dc2626'; ctx.fillRect(cxm - cs2 * 0.3, cym - cs2, cs2 * 0.6, cs2 * 2); ctx.fillRect(cxm - cs2, cym - cs2 * 0.3, cs2 * 2, cs2 * 0.6);
        break;
      case 'workshop':
        boxBase('#8d9399', '#a7acb1');
        rrect(BX, BY + BH, BW, 4, '#d97706'); rrect(BX + BW * 0.18, BY + BH + BG * 0.28, BW * 0.5, BG * 0.72, '#232930');
        ctx.fillStyle = 'rgba(255,255,255,0.12)'; for (var wi = 0; wi < 3; wi++) ctx.fillRect(BX + BW * 0.18, BY + BH + BG * (0.4 + wi * 0.2), BW * 0.5, 1.5);
        ctx.fillStyle = '#d97706'; ctx.beginPath(); ctx.arc(BX + BW * 0.8, cym, Math.min(BW, BH) * 0.2, 0, 6.2832); ctx.fill();
        ctx.fillStyle = '#8d9399'; ctx.beginPath(); ctx.arc(BX + BW * 0.8, cym, Math.min(BW, BH) * 0.09, 0, 6.2832); ctx.fill();
        ctx.strokeStyle = '#d97706'; ctx.lineWidth = 3.5; for (var gi = 0; gi < 4; gi++) { var ga = gi * Math.PI / 4 + fxTime * 0.5, gr = Math.min(BW, BH) * 0.26; ctx.beginPath(); ctx.moveTo(BX + BW * 0.8 - Math.cos(ga) * gr, cym - Math.sin(ga) * gr); ctx.lineTo(BX + BW * 0.8 + Math.cos(ga) * gr, cym + Math.sin(ga) * gr); ctx.stroke(); }
        ctx.strokeStyle = '#e5e7eb'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(BX + BW * 0.1, BY + BH * 0.7); ctx.lineTo(BX + BW * 0.1, BY - 10 * tm); ctx.lineTo(BX + BW * 0.4, BY - 10 * tm); ctx.stroke();
        break;
      case 'airfield': case 'shipyard': case 'flak':   // v0.8 (Vektor-Rückfall)
        v8Building(b, color, o, cxm, cym, tm); break;
      case 'artillery':
        boxBase('#b39d72', '#8f7d58');
        ctx.fillStyle = '#9d8a63'; ctx.beginPath(); ctx.ellipse(cxm, cym, BW * 0.32, BH * 0.34, 0, 0, 6.2832); ctx.fill();
        var aa = (b.tdir == null || !o.recent) ? -0.9 : b.tdir, al = (sdir(aa), Math.hypot(DX, DY)) || 1, adx = DX, ady = DY, L2 = BW * 0.62;
        ctx.strokeStyle = '#1b2026'; ctx.lineWidth = 6 * tm; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(cxm, cym - 6); ctx.lineTo(cxm + adx / al * L2, cym - 6 + ady / al * L2 * 0.8 - L2 * 0.35); ctx.stroke(); ctx.lineCap = 'butt';
        ctx.fillStyle = '#3b4249'; ctx.beginPath(); ctx.arc(cxm, cym - 6, 8 * tm, 0, 6.2832); ctx.fill(); ctx.strokeStyle = OUT; ctx.lineWidth = 1.2; ctx.stroke();
        break;
    }
    // Teamfarbe / Fahne
    if (NEUT[tc]) {
      var owned = o.nowner != null;
      flag(BX + BW - 7, BY + 12 * tm + 2, owned ? o.nowner : BEIGE, b.id || 0);
    }
    if (!NEUT[tc] && tc !== 'turret' && tc !== 'mg' && tc !== 'wall' && tc !== 'pbunker' && tc !== 'laser' && tc !== 'tesla' && tc !== 'flak' && !o.ghostFx) {
      // kleine Teamfahne am Gebäude
      ctx.fillStyle = color; ctx.fillRect(BX + BW - 10, BY + BH + 3, 6, Math.min(BG - 4, 12));
    }
    if (o.dim) { ctx.fillStyle = 'rgba(20,24,32,0.35)'; ctx.fillRect(BX, BY, BW, BH + BG); }
    if (o.hp != null && o.hp < 0.4 && !o.dim) smokeCol(cxm, BY + BH * 0.4, 2);
    if (o.hp != null && o.hp < 0.2 && !o.dim) { ctx.fillStyle = 'rgba(255,140,30,' + (0.6 + 0.4 * Math.sin(fxTime * 13)).toFixed(2) + ')'; ctx.beginPath(); ctx.arc(cxm + BW * 0.15, BY + BH * 0.5, 5, 0, 6.2832); ctx.fill(); }
    if (o.rep) { ctx.strokeStyle = '#22c55e'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(BX + BW - 16, BY + 8); ctx.lineTo(BX + BW - 6, BY + 8); ctx.moveTo(BX + BW - 11, BY + 3); ctx.lineTo(BX + BW - 11, BY + 13); ctx.stroke(); }
    ctx.globalAlpha = 1;
  }
  function turretShape(b, color, S, o) {
    var big = b.type === 'turret', cxm = BX + BW / 2, cym = BY + BH * 0.55, R = Math.min(BW, BH * 1.3) * (big ? 0.42 : 0.38), a = b.tdir || 0;
    ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.ellipse(cxm + 3, BY + BG + BH * 0.55 + 3, R, R * 0.5, 0, 0, 6.2832); ctx.fill();
    if (big) { ctx.fillStyle = '#4b5563'; ctx.beginPath(); ctx.ellipse(cxm, BY + BG + BH * 0.55, R, R * 0.55, 0, 0, 6.2832); ctx.fill(); ctx.fillStyle = '#6b7280'; ctx.fillRect(cxm - R, cym, R * 2, BG + BH * 0.0); ctx.beginPath(); ctx.ellipse(cxm, cym + BG, R, R * 0.5, 0, 0, Math.PI); ctx.fill(); }
    else { ctx.fillStyle = '#a39070'; ctx.beginPath(); ctx.ellipse(cxm, BY + BG + BH * 0.55, R * 1.05, R * 0.6, 0, 0, 6.2832); ctx.fill(); ctx.fillStyle = '#7d6e52'; ctx.fillRect(cxm - R, cym + 2, R * 2, BG + 2); }
    sdir(a); var dx = DX, dy = DY, dl = Math.hypot(dx, dy) || 1, L = R * (big ? 1.9 : 1.5), rec = o.fire ? 3 : 0;
    ctx.strokeStyle = '#10151b'; ctx.lineWidth = big ? 6 : 3.6; ctx.lineCap = 'butt';
    ctx.beginPath(); ctx.moveTo(cxm + dx / dl * (3 - rec), cym + dy / dl * (3 - rec) * 0.8); ctx.lineTo(cxm + dx / dl * (L - rec), cym + dy / dl * (L - rec) * 0.8); ctx.stroke();
    ctx.fillStyle = big ? '#6b7280' : '#8d8f94'; ctx.beginPath(); ctx.ellipse(cxm, cym, R * 0.82, R * 0.7, 0, 0, 6.2832); ctx.fill();
    ctx.fillStyle = color; ctx.beginPath(); ctx.ellipse(cxm, cym - 1, R * 0.55, R * 0.46, 0, 0, 6.2832); ctx.fill();
    ctx.strokeStyle = OUT; ctx.lineWidth = 1.3; ctx.stroke();
  }

  // ------------------------------------------------------------------ v0.5: Mauer, Bunker, Laser, Blitzturm
  /** Aufrechter Quader über einem Weltrechteck (Mitte cx,cy, Halbmaße hx,hy in Welt-px, Höhe h in Bildschirm-px); band = Teamfarbe */
  var PGX = [0, 0, 0, 0], PGY = [0, 0, 0, 0];
  function wprismR(cx, cy, hx, hy, h, top, front, band) {
    var i, j, cyS, mx, cxS;
    PGX[0] = PX(cx - hx, cy - hy); PGY[0] = PY(cx - hx, cy - hy); PGX[1] = PX(cx + hx, cy - hy); PGY[1] = PY(cx + hx, cy - hy);
    PGX[2] = PX(cx + hx, cy + hy); PGY[2] = PY(cx + hx, cy + hy); PGX[3] = PX(cx - hx, cy + hy); PGY[3] = PY(cx - hx, cy + hy);
    cyS = PY(cx, cy); cxS = PX(cx, cy);
    for (i = 0; i < 4; i++) { // sichtbare Seitenflächen (untere Hälfte der Grundfläche)
      j = (i + 1) & 3; if ((PGY[i] + PGY[j]) / 2 <= cyS + 0.3) continue;
      mx = (PGX[i] + PGX[j]) / 2;
      ctx.fillStyle = mx > cxS + 0.5 ? shade(front, 0.82) : front;
      ctx.beginPath(); ctx.moveTo(PGX[i], PGY[i]); ctx.lineTo(PGX[j], PGY[j]); ctx.lineTo(PGX[j], PGY[j] - h); ctx.lineTo(PGX[i], PGY[i] - h); ctx.closePath(); ctx.fill();
      if (band) { ctx.fillStyle = band; ctx.beginPath(); ctx.moveTo(PGX[i], PGY[i] - h * 0.42); ctx.lineTo(PGX[j], PGY[j] - h * 0.42); ctx.lineTo(PGX[j], PGY[j] - h * 0.64); ctx.lineTo(PGX[i], PGY[i] - h * 0.64); ctx.closePath(); ctx.fill(); }
    }
    ctx.fillStyle = top; ctx.beginPath(); ctx.moveTo(PGX[0], PGY[0] - h); for (i = 1; i < 4; i++) ctx.lineTo(PGX[i], PGY[i] - h); ctx.closePath(); ctx.fill(); ctx.stroke();
  }
  /** Mauerkachel bei gedrehter Kamera: Pfeiler + Stege zu den gesetzten Nachbarn (n,e,s,w), von hinten nach vorn sortiert */
  var wParts = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  function wallRot(tx, ty, n, e, s, w, color, hpf, tint, hh) {
    var cx = (tx + 0.5) * TILE, cy = (ty + 0.5) * TILE, iso = !(n || e || s || w), p = (iso ? 0.29 : 0.23) * TILE, c = 0.16 * TILE, q = 0.5 * TILE, ch = hh * 0.72, i, j, np = 1;
    var TOP = tint || '#b9b7ae', FR = tint ? shade(tint, 0.72) : '#8b8982', pt = wParts[0];
    pt[0] = PY(cx, cy); pt[1] = 0; pt[2] = 0; pt[3] = 0;
    if (n) { pt = wParts[np++]; pt[0] = PY(cx, cy - q / 2); pt[1] = 1; pt[2] = 0; pt[3] = -1; }
    if (w) { pt = wParts[np++]; pt[0] = PY(cx - q / 2, cy); pt[1] = 1; pt[2] = -1; pt[3] = 0; }
    if (e) { pt = wParts[np++]; pt[0] = PY(cx + q / 2, cy); pt[1] = 1; pt[2] = 1; pt[3] = 0; }
    if (s) { pt = wParts[np++]; pt[0] = PY(cx, cy + q / 2); pt[1] = 1; pt[2] = 0; pt[3] = 1; }
    // Schatten (ein Pfad für alle Teile)
    var sxo = hh * 0.45, syo = hh * 0.2, k;
    ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.beginPath();
    for (i = 0; i < np; i++) {
      pt = wParts[i]; var mxw = cx + pt[2] * q / 2, myw = cy + pt[3] * q / 2, hx = pt[1] ? (pt[2] ? q / 2 : c) : p, hy = pt[1] ? (pt[3] ? q / 2 : c) : p;
      ctx.moveTo(PX(mxw - hx, myw - hy) + sxo, PY(mxw - hx, myw - hy) + syo); ctx.lineTo(PX(mxw + hx, myw - hy) + sxo, PY(mxw + hx, myw - hy) + syo);
      ctx.lineTo(PX(mxw + hx, myw + hy) + sxo, PY(mxw + hx, myw + hy) + syo); ctx.lineTo(PX(mxw - hx, myw + hy) + sxo, PY(mxw - hx, myw + hy) + syo); ctx.closePath();
    }
    ctx.fill();
    for (i = 1; i < np; i++) for (j = i; j > 0 && wParts[j][0] < wParts[j - 1][0]; j--) { var tmp = wParts[j]; wParts[j] = wParts[j - 1]; wParts[j - 1] = tmp; }
    ctx.strokeStyle = 'rgba(8,10,14,0.65)'; ctx.lineWidth = 1;
    for (i = 0; i < np; i++) {
      pt = wParts[i];
      if (pt[1] === 0) wprismR(cx, cy, p, p, hh, TOP, FR, tint ? null : color);
      else wprismR(cx + pt[2] * q / 2, cy + pt[3] * q / 2, pt[2] ? q / 2 : c, pt[3] ? q / 2 : c, ch, TOP, FR, null);
    }
    void k;
    if (hpf != null && hpf < 0.55) { // Risse
      var ccx = PX(cx, cy), ccy = PY(cx, cy) + 2;
      ctx.strokeStyle = 'rgba(20,18,16,0.8)'; ctx.lineWidth = 1.3; ctx.beginPath(); ctx.moveTo(ccx - 2, ccy - hh); ctx.lineTo(ccx, ccy - hh * 0.6); ctx.lineTo(ccx - 3, ccy - hh * 0.35); ctx.lineTo(ccx + 2, ccy - 1);
      if (hpf < 0.3) { ctx.moveTo(ccx + 4, ccy - hh); ctx.lineTo(ccx + 2, ccy - hh * 0.5); } ctx.stroke();
    }
  }
  /** Gleicher Besitzer + Typ Mauer auf Kachel (tx,ty)? (4-Nachbarschaft über S.occ) */
  function wallLink(S, tx, ty, owner) {
    var m = S.map;
    if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h) return false;
    var id = S.occ[ty * m.w + tx];
    if (!id) return false;
    var n = G.Sim.get(id);
    return !!n && !n.dead && n.type === 'wall' && n.owner === owner;
  }
  /** Quader in Kachelbruchteilen: Oberseite + Vorderwand (Ursprung (ox,oy) = Boden links oben der Kachel) */
  function wprism(ox, oy, tw, th, x0, y0, x1, y1, hh, top, front) {
    var X = ox + x0 * tw, Y = oy + y0 * th, W = (x1 - x0) * tw, H = (y1 - y0) * th;
    ctx.fillStyle = front; ctx.fillRect(X, Y + H - hh, W, hh);
    ctx.fillStyle = top; ctx.fillRect(X, Y - hh, W, H);
    ctx.fillStyle = 'rgba(255,255,255,0.22)'; ctx.fillRect(X, Y - hh, W, 1.5);
    ctx.fillStyle = 'rgba(0,0,0,0.28)'; ctx.fillRect(X, Y + H - 2, W, 2);
    ctx.strokeStyle = 'rgba(8,10,14,0.65)'; ctx.lineWidth = 1; ctx.strokeRect(X + 0.5, Y - hh + 0.5, W - 1, H + hh - 1);
  }
  /** Eine Mauerkachel: Pfeiler + Verbinder zu den gesetzten Nachbarn (n,e,s,w) */
  function wallPiece(ox, oy, tw, th, hh, n, e, s, w, color, hpf, tint) {
    var iso = !(n || e || s || w), pw = iso ? 0.58 : 0.46, p0 = 0.5 - pw / 2, p1 = 0.5 + pw / 2, cw = 0.32, c0 = 0.5 - cw / 2, c1 = 0.5 + cw / 2, ch = hh * 0.72;
    var TOP = tint || '#b9b7ae', FR = tint ? shade(tint, 0.72) : '#8b8982', i;
    // Schatten
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(ox + p0 * tw + hh * 0.45, oy + p0 * th + hh * 0.2, pw * tw, pw * th);
    if (e) ctx.fillRect(ox + p1 * tw, oy + c0 * th + hh * 0.2, (1 - p1) * tw + hh * 0.45, cw * th);
    if (w) ctx.fillRect(ox + hh * 0.45, oy + c0 * th + hh * 0.2, p0 * tw, cw * th);
    if (s) ctx.fillRect(ox + c0 * tw + hh * 0.45, oy + p1 * th + hh * 0.2, cw * tw, (1 - p1) * th);
    if (n) ctx.fillRect(ox + c0 * tw + hh * 0.45, oy + hh * 0.2, cw * tw, p0 * th);
    if (n) wprism(ox, oy, tw, th, c0, 0, c1, p0, ch, TOP, FR);
    if (w) wprism(ox, oy, tw, th, 0, c0, p0, c1, ch, TOP, FR);
    if (e) wprism(ox, oy, tw, th, p1, c0, 1, c1, ch, TOP, FR);
    wprism(ox, oy, tw, th, p0, p0, p1, p1, hh, TOP, FR);
    if (s) wprism(ox, oy, tw, th, c0, p1, c1, 1, ch, TOP, FR);
    // Pfeiler: Teamfarbband + Deckplatte
    var PX = ox + p0 * tw, PY = oy + p1 * th, PW = pw * tw;
    if (!tint) { ctx.fillStyle = color; ctx.fillRect(PX, PY - hh * 0.62, PW, Math.max(2, hh * 0.2)); }
    ctx.fillStyle = 'rgba(255,255,255,0.28)'; ctx.fillRect(PX + 1, oy + p0 * th - hh + 1.5, PW - 2, 2);
    ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.fillRect(PX + PW * 0.55, PY - hh, PW * 0.45, hh);
    if (hpf != null && hpf < 0.55) { // Risse
      ctx.strokeStyle = 'rgba(20,18,16,0.8)'; ctx.lineWidth = 1.3; ctx.beginPath();
      ctx.moveTo(PX + PW * 0.3, PY - hh); ctx.lineTo(PX + PW * 0.5, PY - hh * 0.62); ctx.lineTo(PX + PW * 0.36, PY - hh * 0.35); ctx.lineTo(PX + PW * 0.62, PY - 1);
      if (hpf < 0.3) { ctx.moveTo(PX + PW * 0.8, PY - hh); ctx.lineTo(PX + PW * 0.66, PY - hh * 0.5); }
      ctx.stroke();
    }
  }
  function wallShape(b, color, S, o) {
    if (ROT) { wallRot(b.tx, b.ty, wallLink(S, b.tx, b.ty - 1, b.owner), wallLink(S, b.tx + 1, b.ty, b.owner), wallLink(S, b.tx, b.ty + 1, b.owner), wallLink(S, b.tx - 1, b.ty, b.owner), color, o.hp, null, BG); return; }
    var tw = TILE * kx, th = TILE * ky, ox = BX, oy = BY + BG;
    wallPiece(ox, oy, tw, th, BG, wallLink(S, b.tx, b.ty - 1, b.owner), wallLink(S, b.tx + 1, b.ty, b.owner), wallLink(S, b.tx, b.ty + 1, b.owner), wallLink(S, b.tx - 1, b.ty, b.owner), color, o.hp, null);
  }
  /** Platzierungsvorschau Mauer: Reihe grüner/roter Segmente (placing.tiles = Kachel-Indizes; optional placing.oks[i]) */
  function drawWallGhost(pl, S, P) {
    var tiles = pl.tiles, m = S.map, n = tiles.length, i, j, hh = bHeight('wall'), tw = TILE * kx, th = TILE * ky, terr = D.TERRAIN, anyBad = false;
    var xs = [], ys = [], ok = [], ord = [];
    for (i = 0; i < n && i < 40; i++) {
      var ti = tiles[i], x = ti % m.w, y = (ti / m.w) | 0, good = ti >= 0 && ti < m.w * m.h && terr[m.terrain[ti]].build && !S.occ[ti];
      if (Array.isArray(pl.ok) && pl.ok[i] != null) good = !!pl.ok[i]; // UI liefert ok[] je Kachel
      else if (pl.oks && pl.oks[i] != null) good = !!pl.oks[i];
      xs.push(x); ys.push(y); ok.push(good); ord.push(i); if (!good) anyBad = true;
    }
    ord.sort(function (a, b) { return ys[a] - ys[b] || xs[a] - xs[b]; });
    function has(x, y) { for (var q = 0; q < xs.length; q++) if (xs[q] === x && ys[q] === y) return true; return false; }
    for (j = 0; j < ord.length; j++) { // Bodenmarkierung
      i = ord[j];
      ctx.fillStyle = ok[i] ? 'rgba(34,197,94,0.38)' : 'rgba(239,68,68,0.45)'; footPath(xs[i] * TILE, ys[i] * TILE, TILE, TILE, 0); ctx.fill();
    }
    ctx.globalAlpha = 0.72;
    for (j = 0; j < ord.length; j++) {
      i = ord[j];
      var x2 = xs[i], y2 = ys[i], ln = has(x2, y2 - 1) || wallLink(S, x2, y2 - 1, V.pid), le = has(x2 + 1, y2) || wallLink(S, x2 + 1, y2, V.pid), ls = has(x2, y2 + 1) || wallLink(S, x2, y2 + 1, V.pid), lw = has(x2 - 1, y2) || wallLink(S, x2 - 1, y2, V.pid), tint = ok[i] ? '#9fe3b4' : '#f0a0a0';
      if (ROT) wallRot(x2, y2, ln, le, ls, lw, P.color, null, tint, hh);
      else wallPiece(sx(xs[i] * TILE), sy(ys[i] * TILE), tw, th, hh, ln, le, ls, lw, P.color, null, tint);
    }
    ctx.globalAlpha = 1;
    ctx.lineWidth = 2.2;
    for (j = 0; j < ord.length; j++) { i = ord[j]; ctx.strokeStyle = ok[i] ? '#4ade80' : '#f87171'; footPath(xs[i] * TILE, ys[i] * TILE, TILE, TILE, -1.5 / kx); ctx.stroke(); }
    void anyBad;
  }
  /** Sockel für Türme: flache Betonplatte über die ganze Grundfläche + eingerückter Quader (Höhe ph) */
  function plinth(ph, top, front, band) {
    var gx = BX, gy = BY + BG, pd = Math.max(2, BG * 0.07);
    ctx.fillStyle = 'rgba(0,0,0,0.26)'; ctx.fillRect(gx + ph * 0.7 + 2, gy + BH * 0.2 + 3, BW * 0.7, BH * 0.62);
    ctx.fillStyle = '#7e8187'; ctx.fillRect(gx, gy + BH - pd, BW, pd);
    ctx.fillStyle = '#979a9f'; ctx.fillRect(gx, gy - pd, BW, BH);
    ctx.fillStyle = 'rgba(255,255,255,0.16)'; ctx.fillRect(gx, gy - pd, BW, 2);
    ctx.strokeStyle = 'rgba(8,10,14,0.55)'; ctx.lineWidth = 1.2; ctx.strokeRect(gx + 0.6, gy - pd + 0.6, BW - 1.2, BH + pd - 1.2);
    var X = gx + BW * 0.18, W = BW * 0.64, Y = gy + BH * 0.2 - pd, H = BH * 0.6;
    ctx.fillStyle = front; ctx.fillRect(X, Y + H - ph, W, ph);
    ctx.fillStyle = top; ctx.fillRect(X, Y - ph, W, H);
    ctx.fillStyle = 'rgba(255,255,255,0.22)'; ctx.fillRect(X, Y - ph, W, 1.5); ctx.fillRect(X, Y - ph, 1.5, H);
    if (band) { ctx.fillStyle = band; ctx.fillRect(X, Y + H - ph, W, Math.max(2.5, ph * 0.3)); }
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(X, Y + H - 2, W, 2);
    ctx.strokeStyle = 'rgba(8,10,14,0.7)'; ctx.lineWidth = 1.3; ctx.strokeRect(X + 0.6, Y - ph + 0.6, W - 1.2, H + ph - 1.2);
  }
  function pbunkerShape(b, color, S, o) {
    var cxm = BX + BW / 2, gy = BY + BG, i;
    boxBase('#a2a198', '#7b7a72');
    // gefaste Dachplatte + Aufsatz
    ctx.fillStyle = '#8f8e86'; ctx.fillRect(BX + 4, BY + 4, BW - 8, BH - 8);
    ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(BX + 4, BY + 4, BW - 8, 2);
    ctx.fillStyle = 'rgba(0,0,0,0.2)'; ctx.fillRect(BX + 4, BY + BH - 6, BW - 8, 2);
    var rl = BG * 0.3, rx0 = BX + BW * 0.16, rw = BW * 0.68, ry0 = BY + BH * 0.2, rh = BH * 0.6; // erhöhter Dachaufbau
    ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.fillRect(rx0 + rl * 0.5, ry0 + rl * 0.5, rw, rh);
    ctx.fillStyle = '#85847c'; ctx.fillRect(rx0, ry0 + rh - rl, rw, rl);
    ctx.fillStyle = '#a9a89f'; ctx.fillRect(rx0, ry0 - rl, rw, rh);
    ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.fillRect(rx0, ry0 - rl, rw, 1.5);
    ctx.strokeStyle = OUT; ctx.lineWidth = 1; ctx.strokeRect(rx0 + 0.5, ry0 - rl + 0.5, rw - 1, rh + rl - 1);
    ctx.fillStyle = shade(color, 0.9); ctx.fillRect(rx0 + rw * 0.08, ry0 - rl + rh * 0.14, rw * 0.22, rh * 0.3);
    ctx.fillStyle = '#6e6d66'; ctx.beginPath(); ctx.ellipse(rx0 + rw * 0.7, ry0 - rl + rh * 0.5, rw * 0.15, rh * 0.28, 0, 0, 6.2832); ctx.fill(); // Luke
    ctx.strokeStyle = OUT; ctx.lineWidth = 1.1; ctx.stroke();
    ctx.fillStyle = '#4b4a45'; ctx.beginPath(); ctx.ellipse(rx0 + rw * 0.7, ry0 - rl + rh * 0.5, rw * 0.09, rh * 0.16, 0, 0, 6.2832); ctx.fill();
    // Teamfarbband
    ctx.fillStyle = color; ctx.fillRect(BX, BY + BH, BW, Math.max(3, BG * 0.2));
    // Schießscharten in der Vorderwand
    var sy0 = gy + BH + BG * 0.36 - BG * 0.0, sh = Math.max(3, BG * 0.24);
    sy0 = BY + BH + BG * 0.4;
    ctx.fillStyle = '#0d0f12';
    var slits = [[0.1, 0.3], [0.38, 0.62], [0.7, 0.9]];
    for (i = 0; i < slits.length; i++) ctx.fillRect(BX + BW * slits[i][0], sy0, BW * (slits[i][1] - slits[i][0]), sh);
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    for (i = 0; i < slits.length; i++) ctx.fillRect(BX + BW * slits[i][0], sy0 + sh, BW * (slits[i][1] - slits[i][0]), 1.5);
    ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.fillRect(BX, BY + BH + BG * 0.72, BW, 1.5); // Schalungsfuge
    if (o.fire) { ctx.fillStyle = 'rgba(255,220,120,0.9)'; ctx.fillRect(BX + BW * 0.4, sy0, BW * 0.2, sh); }
  }
  function laserShape(b, color, S, o) {
    var pxc = BX + BW / 2, gyc = BY + BG + BH * 0.5, ph = BG * 0.3, base = gyc - ph - Math.max(2, BG * 0.07), hy = gyc - BG * 0.86, a = b.tdir == null ? Math.PI / 2 : b.tdir, zk = clamp(zoomK, 0.8, 1.4);
    plinth(ph, '#a9afb9', '#6e7480', color);
    // A-Gestell + Säule
    ctx.fillStyle = '#7b838f'; ctx.beginPath(); ctx.moveTo(pxc - BW * 0.26, base + 1); ctx.lineTo(pxc - BW * 0.06, hy + 4); ctx.lineTo(pxc + BW * 0.06, hy + 4); ctx.lineTo(pxc + BW * 0.26, base + 1); ctx.lineTo(pxc + BW * 0.1, base - BG * 0.12); ctx.lineTo(pxc - BW * 0.1, base - BG * 0.12); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = OUT; ctx.lineWidth = 1.1; ctx.stroke();
    ctx.fillStyle = '#c9ced6'; ctx.fillRect(pxc - BW * 0.07, hy + 2, BW * 0.14, base - hy - 2);
    ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.fillRect(pxc + BW * 0.01, hy + 2, BW * 0.06, base - hy - 2);
    ctx.strokeStyle = OUT; ctx.strokeRect(pxc - BW * 0.07, hy + 2, BW * 0.14, base - hy - 2);
    ctx.fillStyle = color; ctx.fillRect(pxc - BW * 0.07, base - (base - hy) * 0.45, BW * 0.14, Math.max(2.5, BG * 0.08));
    // Kopf
    var hr = BW * 0.17;
    ctx.fillStyle = '#2a3038'; ctx.beginPath(); ctx.ellipse(pxc, hy + 2, hr * 1.05, hr * 0.62, 0, 0, 6.2832); ctx.fill();
    ctx.fillStyle = '#d3d8df'; ctx.beginPath(); ctx.ellipse(pxc, hy, hr, hr * 0.74, 0, 0, 6.2832); ctx.fill(); ctx.strokeStyle = OUT; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.fillStyle = color; ctx.beginPath(); ctx.ellipse(pxc, hy - 1, hr * 0.55, hr * 0.38, 0, 0, 6.2832); ctx.fill();
    // Emitter in Zielrichtung + Linse
    sdir(a); var dx = DX, dy = DY, dl = Math.hypot(dx, dy) || 1, el = BW * 0.3, tx = pxc + dx / dl * el, ty = hy - 1 + dy / dl * el * 0.8;
    ctx.lineCap = 'round'; ctx.strokeStyle = '#161b22'; ctx.lineWidth = 7 * zk; ctx.beginPath(); ctx.moveTo(pxc, hy - 1); ctx.lineTo(tx, ty); ctx.stroke();
    ctx.strokeStyle = '#59616d'; ctx.lineWidth = 3 * zk; ctx.stroke(); ctx.lineCap = 'butt';
    var pu = 0.5 + 0.5 * Math.sin(fxTime * 3 + b.id), fire = o.fire ? 1 : 0, lr = 4 * zk;
    ctx.fillStyle = 'rgba(255,60,50,' + (0.22 + 0.15 * pu + 0.4 * fire).toFixed(2) + ')'; ctx.beginPath(); ctx.arc(tx, ty, lr * (1.9 + fire), 0, 6.2832); ctx.fill();
    ctx.fillStyle = fire ? '#ffffff' : '#ff6a5a'; ctx.beginPath(); ctx.arc(tx, ty, lr, 0, 6.2832); ctx.fill(); ctx.strokeStyle = OUT; ctx.lineWidth = 1; ctx.stroke();
  }
  /** Zickzack-Funke von (x0,y0) nach (x1,y1), n Teilstücke */
  function sparkPath(x0, y0, x1, y1, seed, amp, n) {
    var dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len;
    ctx.moveTo(x0, y0);
    for (var k = 1; k < n; k++) { var t = k / n, j = (hash(seed, k, 11) - 0.5) * 2 * amp; ctx.lineTo(x0 + dx * t + nx * j, y0 + dy * t + ny * j); }
    ctx.lineTo(x1, y1);
  }
  function teslaShape(b, color, S, o) {
    var pxc = BX + BW / 2, gyc = BY + BG + BH * 0.5, ph = BG * 0.3, base = gyc - ph - Math.max(2, BG * 0.07), ty = gyc - BG * 0.8, zk = clamp(zoomK, 0.8, 1.4), i;
    var fire = o.fire ? 1 : 0, pu = 0.5 + 0.5 * Math.sin(fxTime * 5 + b.id);
    plinth(ph, '#8a7f72', '#5f564c', color);
    // seitliche Isolatorstäbe
    var kn = [pxc - BW * 0.33, pxc + BW * 0.33], ky2 = ty + BG * 0.1;
    for (i = 0; i < 2; i++) {
      ctx.strokeStyle = '#3a3f47'; ctx.lineWidth = 3.4 * zk; ctx.beginPath(); ctx.moveTo(kn[i], base - 1); ctx.lineTo(kn[i], ky2); ctx.stroke();
      ctx.strokeStyle = '#9aa1ab'; ctx.lineWidth = 1.4; ctx.stroke();
      ctx.fillStyle = '#d6dbe3'; ctx.beginPath(); ctx.arc(kn[i], ky2 - 1, 3.4 * zk, 0, 6.2832); ctx.fill(); ctx.strokeStyle = OUT; ctx.lineWidth = 1; ctx.stroke();
    }
    // Spulenkörper (Kegel) + Ringe
    ctx.fillStyle = '#5b3f31'; ctx.beginPath(); ctx.moveTo(pxc - BW * 0.17, base); ctx.lineTo(pxc - BW * 0.07, ty + 3); ctx.lineTo(pxc + BW * 0.07, ty + 3); ctx.lineTo(pxc + BW * 0.17, base); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = OUT; ctx.lineWidth = 1.1; ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.beginPath(); ctx.moveTo(pxc - BW * 0.17, base); ctx.lineTo(pxc - BW * 0.07, ty + 3); ctx.lineTo(pxc - BW * 0.02, ty + 3); ctx.lineTo(pxc - BW * 0.07, base); ctx.closePath(); ctx.fill();
    for (i = 0; i < 5; i++) {
      var t = i / 4, ry = base - (base - ty - 3) * (0.12 + 0.82 * t), rx = BW * (0.17 - 0.1 * t) + 1.5;
      ctx.strokeStyle = '#d58f58'; ctx.lineWidth = 3.4 * zk; ctx.beginPath(); ctx.ellipse(pxc, ry, rx, rx * 0.4, 0, 0, Math.PI); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,225,170,0.55)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.ellipse(pxc, ry - 1, rx, rx * 0.4, 0, 0.15, Math.PI - 0.15); ctx.stroke();
    }
    ctx.fillStyle = color; ctx.fillRect(pxc - BW * 0.17, base - 3, BW * 0.34, 3);
    // Toroid + Kugel
    ctx.strokeStyle = '#2a3038'; ctx.lineWidth = 6 * zk; ctx.beginPath(); ctx.ellipse(pxc, ty, BW * 0.13, BW * 0.055, 0, 0, 6.2832); ctx.stroke();
    ctx.strokeStyle = '#d6dbe3'; ctx.lineWidth = 4 * zk; ctx.stroke();
    ctx.fillStyle = 'rgba(150,170,255,' + (0.25 + 0.15 * pu + 0.35 * fire).toFixed(2) + ')'; ctx.beginPath(); ctx.arc(pxc, ty - 5 * zk, BW * (0.14 + 0.05 * fire), 0, 6.2832); ctx.fill();
    ctx.fillStyle = '#a5b4ff'; ctx.beginPath(); ctx.arc(pxc, ty - 5 * zk, BW * 0.062, 0, 6.2832); ctx.fill(); ctx.strokeStyle = OUT; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.beginPath(); ctx.arc(pxc - 2, ty - 7 * zk, BW * 0.025, 0, 6.2832); ctx.fill();
    // knisternde Funken im Leerlauf (Form wechselt ~12×/s)
    var sd = (Math.floor(fxTime * 12) + b.id * 7) | 0;
    ctx.lineJoin = 'round';
    for (i = 0; i < 2; i++) {
      if (hash(sd, i, 21) < 0.45 && !fire) continue;
      var tx2 = kn[i], ty2 = ky2 - 2;
      ctx.beginPath(); sparkPath(pxc + (i ? 4 : -4) * zk, ty - 6 * zk, tx2, ty2, sd * 3 + i, 5 * zk, 5);
      ctx.strokeStyle = 'rgba(140,150,255,0.5)'; ctx.lineWidth = 3.6 * zk; ctx.stroke(); ctx.strokeStyle = 'rgba(235,240,255,0.95)'; ctx.lineWidth = 1.2; ctx.stroke();
    }
    if (hash(sd, 5, 22) > 0.55) { // Funke nach oben
      var ang = -1.9 + hash(sd, 6, 22) * 1.3;
      ctx.beginPath(); sparkPath(pxc, ty - 8 * zk, pxc + Math.cos(ang) * 16 * zk, ty - 8 * zk + Math.sin(ang) * 14 * zk, sd + 91, 3.5 * zk, 3);
      ctx.strokeStyle = 'rgba(230,235,255,0.9)'; ctx.lineWidth = 1.2; ctx.stroke();
    }
    ctx.lineJoin = 'miter';
  }

  // ------------------------------------------------------------------ v0.5: HQ-Aufbau nach "deploy" (Mobiler Bauhof klappt auf)
  var DEPLOY_T = 2.4;
  function ease(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
  /** Vor dem HQ: Fundamentplatte wächst, HQ wird von unten nach oben "enthüllt" (Clip) */
  function deployBegin(e, p) {
    bgeom(e); var gx = GCX - GW / 2, gy = GCY - GH / 2, gw = GW, gh = GH, H = bHeight('hq');
    var pl = ease(p / 0.3), cx = gx + gw / 2, cy = gy + gh / 2, w2 = gw * (0.35 + 0.65 * pl) / 2, h2 = gh * (0.35 + 0.65 * pl) / 2;
    ctx.globalAlpha = p < 0.8 ? 1 : Math.max(0, 1 - (p - 0.8) / 0.2);
    ctx.fillStyle = 'rgba(38,34,28,0.75)'; ctx.fillRect(cx - w2, cy - h2, w2 * 2, h2 * 2);
    ctx.strokeStyle = '#facc15'; ctx.lineWidth = 3; ctx.setLineDash([9, 7]); ctx.strokeRect(cx - w2, cy - h2, w2 * 2, h2 * 2); ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    var rv = ease((p - 0.18) / 0.62), yb = gy + gh + 14, yt = gy - H - 60;
    ctx.save(); ctx.beginPath(); ctx.rect(gx - 14, yb - rv * (yb - yt), gw + 28, rv * (yb - yt) + 2); ctx.clip();
    dpGrow = 0.2 + 0.8 * rv;
  }
  var dpGrow = 1;
  /** Nach dem HQ: Clip lösen, Scanlinie + Funken an der Aufbaukante, ausblendender Bauhof */
  function deployEnd(e, p, color) {
    ctx.restore();
    bgeom(e); var gx = GCX - GW / 2, gy = GCY - GH / 2, gw = GW, gh = GH, H = bHeight('hq'), cx = gx + gw / 2, cy = gy + gh / 2;
    var rv = ease((p - 0.18) / 0.62), yb = gy + gh + 14, yt = gy - H - 60, ye = yb - rv * (yb - yt);
    if (rv > 0 && rv < 1) {
      ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.fillRect(gx - 12, ye - 1.5, gw + 24, 3);
      ctx.fillStyle = color; ctx.globalAlpha = 0.5; ctx.fillRect(gx - 12, ye - 7, gw + 24, 6); ctx.globalAlpha = 1;
      var sd = Math.floor(fxTime * 18);
      for (var k = 0; k < 7; k++) {
        var spx = gx + hash(sd, k, 31) * gw, spl = 4 + hash(sd, k, 32) * 9;
        ctx.strokeStyle = 'rgba(255,' + (200 + hash(sd, k, 33) * 55 | 0) + ',120,0.95)'; ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(spx, ye); ctx.lineTo(spx + (hash(sd, k, 34) - 0.5) * 14, ye - spl); ctx.stroke();
      }
    }
    if (p < 0.42) { // der Bauhof verschwindet im Fundament
      var va = 1 - ease(p / 0.42);
      ctx.globalAlpha = va; if (!(spOn() && spVehicle('mcv', facOf(e.owner), cx, cy + gh * 0.1, deployFx[e.id] ? deployFx[e.id].dir : 0, 0, {}))) drawVehicle('mcv', cx, cy + gh * 0.1, deployFx[e.id] ? deployFx[e.id].dir : 0, 0, color, false, 0, 0, false); ctx.globalAlpha = 1;
    }
    dpGrow = 1;
  }
  function drawRuin(b) {
    ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(BX, BY + BG, BW, BH);
    ctx.fillStyle = '#2b2824'; ctx.beginPath();
    var x0 = BX + 2, y0 = BY + BG + 2, w = BW - 4, h = BH - 4;
    ctx.moveTo(x0 + w * 0.1, y0); ctx.lineTo(x0 + w * 0.6, y0 + h * 0.06); ctx.lineTo(x0 + w, y0 + h * 0.15); ctx.lineTo(x0 + w * 0.94, y0 + h * 0.9); ctx.lineTo(x0 + w * 0.4, y0 + h); ctx.lineTo(x0, y0 + h * 0.8); ctx.closePath(); ctx.fill();
    for (var i = 0; i < 7; i++) {
      var rx = x0 + (hash(b.tx, b.ty, i) * 0.8 + 0.05) * w, ry = y0 + (hash(b.tx, b.ty, 20 + i) * 0.6 + 0.2) * h, rw = 6 + hash(b.tx, b.ty, 40 + i) * 10, rh = 3 + hash(b.tx, b.ty, 60 + i) * 8;
      ctx.fillStyle = hash(b.tx, b.ty, 80 + i) > 0.5 ? '#4a463f' : '#5d5850'; ctx.fillRect(rx, ry - rh, rw, rh);
      ctx.fillStyle = '#2a2723'; ctx.fillRect(rx, ry, rw, 2.5);
    }
    ctx.fillStyle = 'rgba(255,120,30,' + (0.5 + 0.4 * Math.sin(fxTime * 9 + b.tx)).toFixed(2) + ')';
    ctx.beginPath(); ctx.arc(BX + BW * 0.4, BY + BG + BH * 0.5, 3.5, 0, 6.2832); ctx.fill();
    smokeCol(BX + BW * 0.5, BY + BG + BH * 0.35, 3);
  }

  // ------------------------------------------------------------------ Sprite-Modus: vorgerenderte Modern-Sprites (src/sprites-data.js)
  // G.SPRITES (tools/bake-sprites.js): Atlanten (WebP, Base64) + Index. Zelle = [Atlas, x, y, w, h, ax, ay] (Anker = Fußpunkt in Zellpixeln),
  // gerendert mit p Pixeln je Kachel aus der diagonalen Kamera (SPD.yaw, seit W11 −π/4). Zeichnen: Maßstab k = kx·TILE/p, Anker auf PX/PY des Weltpunkts.
  // Nur bei YAW = SPD.yaw (diagonal); in der geraden Kamera und für Typen ohne Sprite bleibt die Vektorzeichnung.
  var SPD = null, spImgs = [], spLoaded = 0, spReady = false, spFail = false, MODE = '2d', TAU = Math.PI * 2;
  var spDer = new Map(), wallG = null, wallGW = 0;
  function spLoad() {
    if (SPD || spFail) return;
    var S0 = G.SPRITES;
    if (!S0 || !S0.atlases || !S0.atlases.length) { spFail = true; return; }
    SPD = S0;
    var imgs = [], left = S0.atlases.length;
    S0.atlases.forEach(function (u, i) {
      var im = new Image();
      im.onload = function () { imgs[i] = im; if (--left === 0) spSlice(imgs); };
      im.onerror = function () { spFail = true; spReady = false; };
      im.src = u;
    });
  }
  /** Atlanten in Einzelbilder (ImageBitmap bzw. Canvas je Zelle) zerlegen: Ein Frame verweist so nur auf die Bilder, die er zeigt.
   *  Große Quellbilder (mehrere 16-MB-Atlanten je Frame) zwingen den Software-Canvas sonst zu vorzeitigem Rastern mitten im Frame. */
  function spSlice(imgs) {
    var frames = [];
    (function walk(o) {
      if (Array.isArray(o)) {
        if (o.length === 7 && typeof o[0] === 'number' && typeof o[3] === 'number') { frames.push(o); return; }
        for (var i = 0; i < o.length; i++) if (o[i] && typeof o[i] === 'object') walk(o[i]);
      } else for (var k in o) if (k !== 'atlases' && o[k] && typeof o[k] === 'object') walk(o[k]);
    })(SPD);
    function fin() { spImgs = imgs; spReady = true; if (world) world.spDirty = true; iconCache = {}; }
    if (window.createImageBitmap) { // erst jeden Atlas einmal dekodieren, dann daraus ausschneiden (sonst je Zelle eine neue Dekodierung)
      Promise.all(imgs.map(function (im) { return createImageBitmap(im); })).then(function (abm) {
        return Promise.all(frames.map(function (f) { return createImageBitmap(abm[f[0]], f[1], f[2], f[3], f[4]); }));
      }).then(function (bms) {
        for (var i = 0; i < frames.length; i++) { frames[i][0] = bms[i]; frames[i][1] = 0; frames[i][2] = 0; }
        fin();
      }, function () { fin(); });
    } else {
      for (var i = 0; i < frames.length; i++) {
        var f = frames[i], c = document.createElement('canvas'); c.width = f[3]; c.height = f[4];
        c.getContext('2d').drawImage(imgs[f[0]], f[1], f[2], f[3], f[4], 0, 0, f[3], f[4]);
        f[0] = c; f[1] = 0; f[2] = 0;
      }
      fin();
    }
  }
  /** Sprites aktiv? (geladen + diagonale Kamera wie beim Vorrendern) */
  function spOn() { return spReady && !spFail && ROT && Math.abs(YAWA - SPD.yaw) < 0.02; }
  function spDraw(fr, X, Y, k) {
    if (!fr) return false;
    var im = typeof fr[0] === 'number' ? spImgs[fr[0]] : fr[0];
    ctx.drawImage(im, fr[1], fr[2], fr[3], fr[4], X - fr[5] * k, Y - fr[6] * k, fr[3] * k, fr[4] * k);
    return true;
  }
  function spIdx(a, n) { var i = Math.round(a / TAU * n) % n; return i < 0 ? i + n : i; }
  function hexRGB(c) { var n = parseInt(String(c).slice(1), 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; }
  /** Abgeleitete Zelle (einmalig berechnet, gecacht): 'dmg' beschädigt, 'mem' erinnert (grau), 'wreck' Wrack, 'tint' mit Farbe rgb multipliziert */
  function spVar(fr, kind, rgb) {
    if (!fr) return null;
    var dm = spDer.get(fr), key = kind + (rgb ? ':' + rgb.join(',') : ''), d = dm && dm[key];
    if (d) return d;
    var c = document.createElement('canvas'); c.width = fr[3]; c.height = fr[4];
    var g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(typeof fr[0] === 'number' ? spImgs[fr[0]] : fr[0], fr[1], fr[2], fr[3], fr[4], 0, 0, fr[3], fr[4]);
    try {
      var id = g.getImageData(0, 0, c.width, c.height), p = id.data, i, l, r, gg, b;
      var m = kind === 'dmg' ? [0.72, 0.68, 0.64] : kind === 'mem' ? [0.62, 0.62, 0.66] : kind === 'wreck' ? [0.32, 0.3, 0.28] : kind === 'shadow' ? [0, 0, 0] : rgb;
      for (i = 0; i < p.length; i += 4) {
        if (!p[i + 3]) continue;
        if (kind === 'shadow') { p[i] = 8; p[i + 1] = 10; p[i + 2] = 16; p[i + 3] = p[i + 3] > 40 ? 150 : p[i + 3] * 3.7; continue; }   // v0.8: Silhouette für den Bodenschatten der Luftfahrzeuge
        r = p[i]; gg = p[i + 1]; b = p[i + 2];
        if (kind === 'mem' || kind === 'wreck') { l = r * 0.3 + gg * 0.55 + b * 0.15; r = l + (r - l) * 0.35; gg = l + (gg - l) * 0.35; b = l + (b - l) * 0.35; }
        p[i] = r * m[0]; p[i + 1] = gg * m[1]; p[i + 2] = b * m[2];
      }
      g.putImageData(id, 0, 0);
    } catch (e) { /* ohne Pixelzugriff: unverändert */ }
    d = [c, 0, 0, fr[3], fr[4], fr[5], fr[6]];
    if (!dm) spDer.set(fr, dm = {});
    dm[key] = d;
    if (window.createImageBitmap) createImageBitmap(c).then(function (bm) { d[0] = bm; }, function () { });
    return d;
  }
  function facOf(owner) { var p = G.Sim.S.players[owner]; return p ? p.faction : 'coalition'; }
  function spRecU(type, fac) { var t = SPD.u[type]; return t ? (t[fac] || t.coalition || t.syndicate) : null; }
  /** Fahrzeug/Infanterie als Sprite bei (X, Y). o: { moving, cargo, fireAge, wreck, firing, id } → false, wenn kein Sprite */
  function spVehicle(type, fac, X, Y, dir, tdir, o) {
    var rec = spRecU(type, fac);
    if (!rec || !rec.hull) return false;
    var k = kx * TILE / rec.p, s = rec.s || 1;
    if (!rec.tur && isInf(type)) {
      var face = o.firing ? tdir : dir, bob = 0;
      if (o.moving) bob = Math.abs(Math.sin(fxTime * 13 + (o.id || 0))) * 0.035 * s * TILE * kx * HK;
      var fi = rec.hull[spIdx(face, rec.hull.length)];
      return spDraw(o.wreck ? spVar(fi, 'wreck') : fi, X, Y - bob, k);
    }
    var travel = rec.hullT && o.moving, set = travel ? rec.hullT : (o.open && rec.hullO ? rec.hullO : (rec.hullC && o.cargo > 0 ? rec.hullC : rec.hull));
    var hf = set[spIdx(dir, set.length)];
    if (!hf) return false;
    spDraw(o.wreck ? spVar(hf, 'wreck') : hf, X, Y, k);
    if (rec.tur && !travel) {
      var td = o.wreck ? tdir + 0.4 : tdir, cd = Math.cos(dir), sd = Math.sin(dir), p0 = rec.pivot[0] * s * TILE, p1 = rec.pivot[1] * s * TILE;
      var wx = cd * p0 - sd * p1, wy = sd * p0 + cd * p1;
      if (o.fireAge != null && o.fireAge < 5 && !o.wreck) { var rc = 0.09 * s * TILE * (1 - o.fireAge / 5); wx -= Math.cos(td) * rc; wy -= Math.sin(td) * rc; }
      var tf = rec.tur[spIdx(td, rec.tur.length)];
      spDraw(o.wreck ? spVar(tf, 'wreck') : tf, X + MUA * wx + MVA * wy, Y + MUB * wx + MVB * wy, k);
    }
    return true;
  }
  function spUnit(e, X, Y, tick) {
    return spVehicle(e.type, facOf(e.owner), X, Y, e.dir || 0, e.tdir || 0, {
      moving: e.moving, cargo: e.cargo, fireAge: tick - (e.fireT == null ? -100 : e.fireT), firing: tick - (e.fireT == null ? -100 : e.fireT) < 25, id: e.id
    });
  }
  /** Höhe (Bildschirm-px) über dem Fußpunkt für einen 3D-Punkt (Kacheln) */
  function spUp(h) { return h * TILE * kx * HK; }
  function spFlag(px, py, H, col, ph) {
    var s = clamp(zoomK, 0.7, 1.6), w1 = Math.sin(fxTime * 3.2 + ph) * 2 * s;
    ctx.strokeStyle = '#2a2f36'; ctx.lineWidth = 1.6 * s; ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px, py - H); ctx.stroke();
    ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(px + 1, py - H); ctx.lineTo(px + 13 * s, py - H + 2 * s + w1); ctx.lineTo(px + 11 * s, py - H + 6 * s + w1 * 0.5); ctx.lineTo(px + 13 * s, py - H + 10 * s + w1); ctx.lineTo(px + 1, py - H + 11 * s); ctx.closePath(); ctx.fill();
  }
  /** Gebäude als Sprite. o wie drawBuilding (+ buildF Aufbau 0..1). mem = erinnert (grau). → false, wenn kein Sprite */
  function spBuilding(e, color, o, mem) {
    var type = e.type, isN = !!NEUT[type], rec, S = G.Sim.S;
    if (type === 'wall') return spWall(e, color, o, mem);
    if (isN) rec = SPD.n[o.ruin ? 'ruin' + e.w + 'x' + e.h : type];
    else { var bt = SPD.b[type]; rec = bt ? (bt[facOf(e.owner)] || bt.coalition) : null; }
    if (!rec || !rec.base) return false;
    var cxw = (e.tx + e.w / 2) * TILE, cyw = (e.ty + e.h / 2) * TILE, X = PX(cxw, cyw), Y = PY(cxw, cyw), k = kx * TILE / rec.p;
    var a0 = o.alpha != null ? o.alpha : 1, Ly = rec.layers || {}, t = fxTime, i;
    ctx.globalAlpha = a0;
    if (o.buildF != null && o.buildF < 1 && rec.build && rec.build.length) {
      spDraw(rec.build[Math.min(rec.build.length - 1, Math.floor(o.buildF * rec.build.length))], X, Y, kx * TILE / rec.bp);
      ctx.globalAlpha = 1; return true;
    }
    var dmg = !mem && o.hp != null && o.hp < 0.35;
    function V2(fr) { return mem ? spVar(fr, 'mem') : (dmg ? spVar(fr, 'dmg') : fr); }
    spDraw(V2(rec.base), X, Y, k);
    if (o.ruin) { smokeCol(X, Y - spUp(0.3), 2); ctx.globalAlpha = 1; return true; }
    var own = e.owner, low = !mem && own >= 0 && !isN && G.Sim.lowPower && G.Sim.lowPower(own), ph = hash(e.id || e.tx, e.ty, 7) * TAU;
    if (Ly.trim) { // Zierteile in Besitzerfarbe (neutral: Beige-Grau)
      var tcol = o.nowner ? hexRGB(o.nowner) : [0.66, 0.64, 0.58];
      spDraw(spVar(Ly.trim[0], 'tint', tcol.map(function (v) { return Math.round(v * 100) / 100; })), X, Y, k);
    }
    if (Ly.head) spDraw(V2(Ly.head[spIdx(e.tdir || 0, Ly.head.length)]), X, Y, k);
    if (Ly.radar) spDraw(V2(Ly.radar[mem ? 0 : spIdx(t * 1.6 + (own || 0), Ly.radar.length)]), X, Y, k);
    if (Ly.spin) spDraw(V2(Ly.spin[mem ? 0 : spIdx(t * (low ? 0.2 : 1.3), Ly.spin.length)]), X, Y, k);
    var active = isN && o.nowner != null;
    if (Ly.dish) spDraw(V2(Ly.dish[spIdx(t * (active ? 1.9 : 0.3) + ph, Ly.dish.length)]), X, Y, k);
    if (Ly.beam) { var nb = Ly.beam.length - 1; spDraw(V2(Ly.beam[active ? Math.floor(((t * 3.3 + ph) / TAU % 1) * nb) : nb]), X, Y, k); }
    if (Ly.crane) { var nc = Ly.crane.length - 1; spDraw(V2(Ly.crane[active ? Math.floor(((t * 0.55 + ph) / TAU % 1) * nc) : nc]), X, Y, k); }
    if (Ly.gun) { var gy = Math.atan2(S.map.h / 2 * TILE - cyw, S.map.w / 2 * TILE - cxw); spDraw(V2(Ly.gun[spIdx(gy, Ly.gun.length)]), X, Y, k); }
    var ch = mem ? 0 : (e.charge || 0), sw = type === 'orbital' || type === 'silo', ready = sw && ch >= 1;
    if (Ly.door) { if (Ly.door.length > 1) spDraw(V2(Ly.door[ready ? 1 : 0]), X, Y, k); else if (ready) spDraw(Ly.door[0], X, Y, k); }
    if (!mem && Ly.cell) {
      if (low) { /* aus */ } else if (ready && Ly.cell[1]) { ctx.globalAlpha = a0 * (0.55 + 0.45 * Math.sin(t * 6)); spDraw(Ly.cell[1], X, Y, k); }
      else if (ch > 0) { ctx.globalAlpha = a0 * clamp(ch, 0, 1); spDraw(Ly.cell[0], X, Y, k); }
      ctx.globalAlpha = a0;
    }
    if (!mem && Ly.glow) { // Glühteile: Helligkeit wie r3-models (Basis enthält sie gedimmt)
      var gain, gb = (SPD.cfg && SPD.cfg.glowBase) || 0.3;
      if (low) gain = 0.22;
      else if (type === 'techcenter') gain = 1.12 + 0.22 * Math.sin(t * 2 + ph);
      else if (sw) gain = 0.5 + 0.55 * ch + (ready ? 0.35 + 0.35 * Math.sin(t * 5) : 0);
      else if (type === 'pbunker') gain = (e.gar && e.gar.length ? 0.9 + 0.2 * Math.sin(t * 3 + ph) : 0.12) + (o.fire ? 1.5 : 0);
      else if (type === 'laser') gain = 0.8 + 0.4 * Math.sin(t * 1.4 + ph) + (o.fire ? 0.8 : 0);
      else if (type === 'tesla') gain = 0.95 + 0.4 * Math.sin(t * 9 + ph) * Math.sin(t * 5.3) + (o.fire ? 1.5 : 0);
      else gain = 1;
      var ga = clamp((gain - gb) / (1 - gb), 0, 1);
      if (ga > 0.01) { ctx.globalAlpha = a0 * ga; spDraw(Ly.glow[0], X, Y, k); }
      if (gain > 1.02) { ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = a0 * clamp((gain - 1) * 0.5, 0, 0.8); spDraw(Ly.glow[0], X, Y, k); ctx.globalCompositeOperation = 'source-over'; }
      ctx.globalAlpha = a0;
    }
    if (rec.lamp && active) { // Artilleriestellung: Ladelampe
      var lx = PX(cxw + rec.lamp[0] * TILE, cyw + rec.lamp[2] * TILE), ly = PY(cxw + rec.lamp[0] * TILE, cyw + rec.lamp[2] * TILE) - spUp(rec.lamp[1]);
      var lc = ch >= 1 ? 'rgba(80,255,120,' : 'rgba(255,' + (60 + ch * 160 | 0) + ',40,';
      ctx.fillStyle = lc + '0.35)'; ctx.beginPath(); ctx.arc(lx, ly, 6 * zoomK, 0, TAU); ctx.fill();
      ctx.fillStyle = lc + '1)'; ctx.beginPath(); ctx.arc(lx, ly, 2.4 * zoomK, 0, TAU); ctx.fill();
    }
    if (rec.steam && !mem && !low && !o.dim) for (i = 0; i < rec.steam.length; i++) { // Kraftwerk-Dampf
      var sp = rec.steam[i], sx0 = PX(cxw + sp[0] * TILE, cyw + sp[2] * TILE), sy0 = PY(cxw + sp[0] * TILE, cyw + sp[2] * TILE) - spUp(sp[1]);
      for (var q = 0; q < 3; q++) {
        var st = (t * 0.45 + i * 0.37 + q / 3) % 1;
        puff(sx0 + st * 10 * zoomK, sy0 - st * 34 * zoomK, (4 + st * 9) * zoomK, 'rgba(238,241,244,', 0.5 * (1 - st) * Math.min(1, st * 6));
      }
    }
    if (isN && rec.flag && (o.nowner != null)) {
      var fx0 = PX(cxw + rec.flag[0] * TILE, cyw + rec.flag[1] * TILE), fy0 = PY(cxw + rec.flag[0] * TILE, cyw + rec.flag[1] * TILE);
      spFlag(fx0, fy0, spUp(rec.flag[2] * 0.85), o.nowner, ph);
    }
    var topY = Y - spUp((rec.mh || 1) * 0.75);
    if (o.hp != null && o.hp < 0.4 && !o.dim) smokeCol(X, topY, 2);
    if (o.hp != null && o.hp < 0.2 && !o.dim) { ctx.fillStyle = 'rgba(255,140,30,' + (0.6 + 0.4 * Math.sin(fxTime * 13)).toFixed(2) + ')'; ctx.beginPath(); ctx.arc(X + 6 * zoomK, topY + 8 * zoomK, 5 * zoomK, 0, TAU); ctx.fill(); }
    if (o.rep) { ctx.strokeStyle = '#22c55e'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(X - 5, topY - 10); ctx.lineTo(X + 5, topY - 10); ctx.moveTo(X, topY - 15); ctx.lineTo(X, topY - 5); ctx.stroke(); }
    ctx.globalAlpha = 1;
    return true;
  }
  /** Mauer: Verbinder nach Osten/Süden zu gleichfarbigen Nachbarn (Raster wallG), dann Pfeiler */
  function spWall(e, color, o, mem) {
    var rec = SPD.w[facOf(e.owner)] || SPD.w.coalition;
    if (!rec || !rec.pillar) return false;
    var cx = (e.tx + 0.5) * TILE, cy = (e.ty + 0.5) * TILE, k = kx * TILE / rec.p, v = e.owner + 1, W = wallGW, idx = e.ty * W + e.tx;
    function V2(fr) { return mem ? spVar(fr, 'mem') : (o.hp != null && o.hp < 0.35 ? spVar(fr, 'dmg') : fr); }
    ctx.globalAlpha = o.alpha != null ? o.alpha : 1;
    if (wallG && e.tx + 1 < W && wallG[idx + 1] === v) spDraw(V2(rec.connX), PX(cx + TILE / 2, cy), PY(cx + TILE / 2, cy), k);
    if (wallG && wallG[idx + W] === v) spDraw(V2(rec.connY), PX(cx, cy + TILE / 2), PY(cx, cy + TILE / 2), k);
    spDraw(V2(rec.pillar), PX(cx, cy), PY(cx, cy), k);
    ctx.globalAlpha = 1;
    return true;
  }

  // --- Requisiten (Bäume, Felsen, Steine) als tiefensortierte Sprites; Erz und Brücken bodennah vorab
  function vnoise(x, y, s) { // glattes Wertrauschen (für Waldflecken)
    var ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    var a = hash(ix, iy, s), b = hash(ix + 1, iy, s), c = hash(ix, iy + 1, s), d = hash(ix + 1, iy + 1, s);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }
  function spBuildProps() {
    var P = SPD.p, m = mapRef, out = [], x, y, id, k;
    if (!P) { world.props = out; return; }
    var ids = D.TERRAIN.map(function (t) { return t.id; });
    function tt(xx, yy) { return (xx < 0 || yy < 0 || xx >= m.w || yy >= m.h) ? '' : ids[m.terrain[yy * m.w + xx]]; }
    for (y = 0; y < m.h; y++) for (x = 0; x < m.w; x++) {
      id = tt(x, y);
      if (id === 'trees' && P.tree) {
        var c = vnoise(x * 0.12 + 3.1, y * 0.12 + 7.7, 101) * 0.6 + vnoise(x * 0.24, y * 0.24, 103) * 0.4, sp = c > 0.56 ? 0 : (c < 0.42 ? 2 : 1);
        var vs = P.tree[sp]; if (!vs || !vs.length) continue;
        out.push({ x: (x + 0.5) * TILE, y: (y + 0.5) * TILE, fr: vs[(hash(x, y, 141) * vs.length) | 0], s: 0.94 + 0.12 * hash(x, y, 142) });
      } else if (id === 'rock' && P.rock) {
        var edge = tt(x - 1, y) !== 'rock' || tt(x + 1, y) !== 'rock' || tt(x, y - 1) !== 'rock' || tt(x, y + 1) !== 'rock';
        var single = [], dbl = [];
        for (k = 0; k < P.rock.length; k++) (k % 3 === 2 ? single : dbl).push(P.rock[k]);
        if (edge) out.push({ x: (x + 0.5) * TILE, y: (y + 0.5) * TILE, fr: (hash(x, y, 92) < 0.5 ? dbl : single)[(hash(x, y, 93) * 7 | 0) % (hash(x, y, 92) < 0.5 ? dbl.length : single.length)], s: 0.95 + 0.2 * hash(x, y, 94) });
        else if (hash(x, y, 93) < 0.18 && single.length) out.push({ x: (x + 0.5) * TILE, y: (y + 0.5) * TILE, fr: single[(hash(x, y, 95) * single.length) | 0], s: 1.1 + 0.3 * hash(x, y, 96) });
      } else if ((id === 'grass' || id === 'sand') && P.stone && hash(x, y, 113) < 0.035) {
        var ps = 0.24 + 0.3 * hash(x, y, 116);
        out.push({ x: (x + 0.2 + 0.6 * hash(x, y, 114)) * TILE, y: (y + 0.2 + 0.6 * hash(x, y, 115)) * TILE, fr: P.stone[(hash(x, y, 117) * P.stone.length) | 0], s: ps / 0.42 });
      }
    }
    // v0.7-deco: Kartendekoration (Lampen, Zäune, Wracks …) – gleiche Platzierung wie in 3D (G.Deco.plan, rein deterministisch), Rahmen v · NA + ai
    if (G.Deco && SPD.p.dc_lamp) {
      if (!world.decoPlan || world.decoPlan.id !== m.id || world.decoPlan.w !== m.w) world.decoPlan = { id: m.id, w: m.w, items: G.Deco.plan(m, true).items };
      var di, dit, dfr;
      for (di = 0; di < world.decoPlan.items.length; di++) {
        dit = world.decoPlan.items[di]; dfr = SPD.p['dc_' + dit.k];
        if (dfr && (dfr = dfr[dit.v * G.Deco.NA[dit.k] + dit.ai])) out.push({ x: dit.x * TILE, y: dit.y * TILE, fr: dfr, s: dit.s });
      }
    }
    out.sort(function (a, b) { return (a.x + a.y) - (b.x + b.y); });
    world.props = out;
    // Brücken (Maske der Wasser-Nachbarn: 1 N, 2 S, 4 W, 8 O) und Wasser-Kacheln für das Glitzern
    var br = [], wt = [];
    for (y = 0; y < m.h; y++) for (x = 0; x < m.w; x++) {
      id = tt(x, y);
      if (id === 'bridge' && world.bruns && world.bruns.diag[y * m.w + x]) continue;   // v0.9: Teil eines diagonalen Zugs → spBridgeRun
      if (id === 'bridge') br.push(x, y, (tt(x, y - 1) === 'water' ? 1 : 0) | (tt(x, y + 1) === 'water' ? 2 : 0) | (tt(x - 1, y) === 'water' ? 4 : 0) | (tt(x + 1, y) === 'water' ? 8 : 0));
      else if (id === 'water' && hash(x, y, 151) < 0.3) wt.push(x, y);   // v0.9: weniger Glitzer-Striche (vorher 45 %)
    }
    world.bridges = br; world.waterT = wt;
  }
  function spPushProps(mx0, my0, mx1, my1) {
    var L = world.props, P = SPD.p, k = kx * TILE / P.p;
    for (var i = 0; i < L.length; i++) {
      var p = L[i], X = PX(p.x, p.y), Y = PY(p.x, p.y);
      if (X < mx0 || X > mx1 || Y < my0 || Y > my1 + 40) continue;
      pushItem(4, p, Y - 0.5, null);
    }
    return k;
  }
  /** v0.9: diagonaler Brückenzug im Sprite-Modus: angehobene Fahrbahn (Seitenfläche zur Kamera, Bohlen quer) + Geländer mit Pfosten, hinteres zuerst.
   *  Farben/Höhen wie die gebackene Kachelbrücke (Fahrbahn 0.14, Handlauf 0.29 Kacheln). Boden darunter: paintBridgeRuns. */
  var BRC = { top: '#8b6a48', top2: '#7d5d3d', gap: 'rgba(52,34,18,0.55)', side: '#4f3720', rail: '#4a3420', railHi: '#7a5a3a' };
  function spBridgeRun(r, VW, VH) {
    var T = TILE, ux = r.ux, uy = r.uy, vx = -uy, vy = ux, hL = r.L / 2, hW = r.W / 2, cx = r.cx * T, cy = r.cy * T, k, n, sd;
    var X0 = PX(cx, cy), Y0 = PY(cx, cy), ext = (hL + hW) * T * Math.max(kx, ky) + 40;
    if (X0 < -ext || Y0 < -ext || X0 > VW + ext || Y0 > VH + ext) return;
    function P(t, s2, h) { var wx = cx + (ux * t + vx * s2) * T, wy = cy + (uy * t + vy * s2) * T; tmpX = PX(wx, wy); tmpY = PY(wx, wy) - spUp(h); }
    // Seite zur Kamera: die Längskante mit größerem Bildschirm-y
    P(0, -hW, 0); var ya = tmpY; P(0, hW, 0); var near = tmpY > ya ? 1 : -1;
    ctx.fillStyle = BRC.side; ctx.beginPath();
    P(-hL, near * hW, 0.14); ctx.moveTo(tmpX, tmpY); P(hL, near * hW, 0.14); ctx.lineTo(tmpX, tmpY); P(hL, near * hW, 0.03); ctx.lineTo(tmpX, tmpY); P(-hL, near * hW, 0.03); ctx.lineTo(tmpX, tmpY); ctx.closePath(); ctx.fill();
    ctx.fillStyle = BRC.top; ctx.beginPath();
    P(-hL, -hW, 0.14); ctx.moveTo(tmpX, tmpY); P(hL, -hW, 0.14); ctx.lineTo(tmpX, tmpY); P(hL, hW, 0.14); ctx.lineTo(tmpX, tmpY); P(-hL, hW, 0.14); ctx.lineTo(tmpX, tmpY); ctx.closePath(); ctx.fill();
    n = Math.floor(r.L / 0.2); var step = 0.2 * T * zoomK < 3.5 ? 2 : 1;
    ctx.fillStyle = BRC.top2;
    for (k = 1; k < n; k += 2) { ctx.beginPath(); P(-hL + k * 0.2, -hW, 0.14); ctx.moveTo(tmpX, tmpY); P(-hL + (k + 1) * 0.2, -hW, 0.14); ctx.lineTo(tmpX, tmpY); P(-hL + (k + 1) * 0.2, hW, 0.14); ctx.lineTo(tmpX, tmpY); P(-hL + k * 0.2, hW, 0.14); ctx.lineTo(tmpX, tmpY); ctx.closePath(); ctx.fill(); }
    ctx.strokeStyle = BRC.gap; ctx.lineWidth = Math.max(0.6, 0.7 * zoomK); ctx.beginPath();
    for (k = step; k < n; k += step) { P(-hL + k * 0.2, -hW, 0.14); ctx.moveTo(tmpX, tmpY); P(-hL + k * 0.2, hW, 0.14); ctx.lineTo(tmpX, tmpY); }
    ctx.stroke();
    // Geländer: hinten zuerst
    for (var q = 0; q < 2; q++) {
      sd = q === 0 ? -near : near; var so = sd * (hW - 0.03);
      ctx.strokeStyle = BRC.rail; ctx.lineWidth = Math.max(1, 1.4 * zoomK); ctx.beginPath();
      n = Math.max(2, Math.round(r.L / 0.6));
      for (k = 0; k <= n; k++) { var t = -hL + 0.03 + k * (r.L - 0.06) / n; P(t, so, 0.14); ctx.moveTo(tmpX, tmpY); P(t, so, 0.29); ctx.lineTo(tmpX, tmpY); }
      P(-hL, so, 0.19); ctx.moveTo(tmpX, tmpY); P(hL, so, 0.19); ctx.lineTo(tmpX, tmpY);
      ctx.stroke();
      ctx.lineWidth = Math.max(1.2, 2.2 * zoomK); ctx.beginPath(); P(-hL, so, 0.29); ctx.moveTo(tmpX, tmpY); P(hL, so, 0.29); ctx.lineTo(tmpX, tmpY); ctx.stroke();
      ctx.strokeStyle = BRC.railHi; ctx.lineWidth = Math.max(0.6, 0.8 * zoomK); ctx.beginPath(); P(-hL, so, 0.305); ctx.moveTo(tmpX, tmpY); P(hL, so, 0.305); ctx.lineTo(tmpX, tmpY); ctx.stroke();
    }
  }
  function spGroundProps(VW, VH) {
    var P = SPD.p, m = mapRef, k = kx * TILE / P.p, i, x, y, X, Y;
    // Brücken
    var br = world.bridges;
    if (br && P.bridge) for (i = 0; i < br.length; i += 3) {
      X = PX((br[i] + 0.5) * TILE, (br[i + 1] + 0.5) * TILE); Y = PY((br[i] + 0.5) * TILE, (br[i + 1] + 0.5) * TILE);
      if (X < -60 || Y < -60 || X > VW + 60 || Y > VH + 60) continue;
      spDraw(P.bridge[br[i + 2]], X, Y, k);
    }
    if (world.bruns) for (i = 0; i < world.bruns.runs.length; i++) spBridgeRun(world.bruns.runs[i], VW, VH);
    // Wasser-Glitzern (billig: kurze helle Striche mit wechselnder Deckkraft)
    var wt = world.waterT;
    if (MODE === 'sprite' && wt) {
      ctx.fillStyle = '#e8f4ff';
      var len = 7 * zoomK, th = Math.max(1, 1.3 * zoomK);
      for (i = 0; i < wt.length; i += 2) {
        x = wt[i]; y = wt[i + 1];
        var wx = (x + hash(x, y, 152)) * TILE, wy = (y + hash(x, y, 153)) * TILE;
        X = PX(wx, wy); Y = PY(wx, wy);
        if (X < -10 || Y < -10 || X > VW + 10 || Y > VH + 10) continue;
        var a = Math.sin(fxTime * (1.1 + hash(x, y, 154)) + hash(x, y, 155) * 40);
        if (a < 0.55) continue;
        ctx.globalAlpha = (a - 0.55) * 0.85;
        ctx.fillRect(X - len / 2 + Math.sin(fxTime * 0.7 + x) * 2, Y, len, th);
      }
      ctx.globalAlpha = 1;
    }
    // Erz-Kristalle (2 je Kachel, Größe nach Restmenge wie r3-terrain.updateOre)
    if (P.ore) {
      var ol = world.oreIdx, ko = k;
      for (i = 0; i < ol.length; i++) {
        var ti = ol[i], ore = m.ore[ti]; if (!(ore > 0)) continue;
        x = ti % m.w; y = (ti / m.w) | 0;
        X = PX((x + 0.5) * TILE, (y + 0.5) * TILE); Y = PY((x + 0.5) * TILE, (y + 0.5) * TILE);
        if (X < -60 || Y < -60 || X > VW + 60 || Y > VH + 80) continue;
        var mxo = (m.oreMax && m.oreMax[ti]) || 800, lvl = 1 + Math.min(15, Math.floor(ore / mxo * 15));
        for (var q = 0; q < 2; q++) {
          var s = (0.3 + 0.45 * lvl / 16) * (q ? 0.8 : 1.1) * (mxo >= 700 ? 1.15 : 1);
          var ox = (x + 0.3 + 0.4 * hash(x, y, 110 + q) + (q ? 0.12 : -0.12)) * TILE, oz = (y + 0.3 + 0.4 * hash(x, y, 120 + q)) * TILE;
          spDraw(P.ore[(hash(x, y, 130 + q) * P.ore.length) | 0], PX(ox, oz), PY(ox, oz), ko * s);
        }
      }
    }
  }

  // ------------------------------------------------------------------ Hauptzeichnen
  var items = [], itemN = 0;
  function pushItem(kind, e, key, mem) {
    var it = items[itemN];
    if (!it) it = items[itemN] = {};
    itemN++; it.k = kind; it.e = e; it.key = key; it.mem = mem;
  }
  function cmpItem(a, b) { return a.key - b.key; }

  var profOn = false, profT = 0, profA = [0, 0, 0, 0, 0, 0, 0, 0], profN = 0;
  function PROF(i) { if (!profOn) return; var t = performance.now(); profA[i] += t - profT; profT = t; if (i === 6) profN++; }
  function draw(alpha) {
    var now = performance.now(), dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 0;
    lastT = now;
    resize();
    var S = G.Sim.S;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!S || !V.running) { ctx.fillStyle = '#0b0f14'; ctx.fillRect(0, 0, V.vw, V.vh); return; }
    var t0 = performance.now(); profT = t0;
    if (mapRef !== S.map || !world) reset();
    if (fogTick < 0 || S.tick - fogTick >= 3 || S.tick < fogTick) updateFog();
    if (V.paused) dt = 0;
    fxTime += dt;
    consumeEvents(); curTick = S.tick; curAlpha = alpha || 0;
    setView();
    if (world.withUpright === ROT) buildWorld(); // Wechsel gerade ↔ diagonal: Bäume/Felsen ins Bodenbild bzw. als Sprites
    var SPM = spOn(); // Sprite-Modus: vorgerenderte Modern-Sprites statt Vektorformen
    if (SPM && (world.spDirty || !world.props)) { world.spDirty = false; spBuildProps(); }
    ctx.imageSmoothingQuality = SPM ? 'high' : 'low'; // Sprites weich skalieren (Zoom 0,5–2)
    var pid = V.pid, P = S.players[pid], fogOff = S.settings.fogOff, ents = S.ents, i, e, m = S.map;
    var VW = V.vw, VH = V.vh;
    // Hintergrund + Gelände
    ctx.fillStyle = '#0b0f14'; ctx.fillRect(0, 0, VW, VH);
    blitMap(world.terrain, world.TS, true);
    PROF(0); // Messung (nur mit _prof)
    if (ROT && !SPM) drawUpright();
    // Kartenrand
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 2;
    if (!ROT) ctx.strokeRect(sx(0), sy(0), m.w * TILE * kx, m.h * TILE * ky); else { footPath(0, 0, m.w * TILE, m.h * TILE, 0); ctx.stroke(); }
    // Erz (gesammelt in einem Pfad: Kristalle)
    var oi, ti, o, n, k;
    if (SPM) spGroundProps(VW, VH); else { // Sprite-Modus: Brücken, Wasser-Glitzern, Erz als Sprites
    ctx.fillStyle = '#c99a1c'; ctx.beginPath();
    var ex0 = -20, ey0 = -30, ex1 = VW + 20, ey1 = VH + 20, oreList = world.oreIdx;
    for (oi = 0; oi < oreList.length; oi++) {
      ti = oreList[oi]; o = m.ore[ti]; if (!(o > 0)) continue;
      var otx = ti % m.w, oty = (ti / m.w) | 0, X0 = PX(otx * TILE, oty * TILE), Y0 = PY(otx * TILE, oty * TILE);
      if (X0 < ex0 - TILE * kx * 1.5 || Y0 < ey0 - TILE * ky * 1.5 || X0 > ex1 + TILE * kx * (ROT ? 1 : 0) || Y0 > ey1 + TILE * ky * (ROT ? 1 : 0)) continue;
      n = Math.min(6, 1 + Math.ceil(o / 140));
      for (k = 0; k < n; k++) {
        var gwx = (otx + 0.14 + hash(otx, oty, 60 + k) * 0.72) * TILE, gwy = (oty + 0.25 + hash(otx, oty, 70 + k) * 0.7) * TILE, gx = PX(gwx, gwy), gy = PY(gwx, gwy), gs = (3.2 + hash(otx, oty, 80 + k) * 2.4) * zoomK;
        ctx.moveTo(gx, gy - gs * 2.1); ctx.lineTo(gx + gs, gy - gs * 0.6); ctx.lineTo(gx + gs * 0.6, gy); ctx.lineTo(gx - gs * 0.6, gy); ctx.lineTo(gx - gs, gy - gs * 0.6); ctx.closePath();
      }
    }
    ctx.fill();
    ctx.fillStyle = '#f7dc6f'; ctx.beginPath();
    for (oi = 0; oi < oreList.length; oi++) {
      ti = oreList[oi]; o = m.ore[ti]; if (!(o > 0)) continue;
      var ptx = ti % m.w, pty = (ti / m.w) | 0, XX = PX(ptx * TILE, pty * TILE), YY = PY(ptx * TILE, pty * TILE);
      if (XX < ex0 - TILE * kx * 1.5 || YY < ey0 - TILE * ky * 1.5 || XX > ex1 + TILE * kx * (ROT ? 1 : 0) || YY > ey1 + TILE * ky * (ROT ? 1 : 0)) continue;
      n = Math.min(6, 1 + Math.ceil(o / 140));
      for (k = 0; k < n; k++) {
        var hwx = (ptx + 0.14 + hash(ptx, pty, 60 + k) * 0.72) * TILE, hwy = (pty + 0.25 + hash(ptx, pty, 70 + k) * 0.7) * TILE, hx = PX(hwx, hwy), hy = PY(hwx, hwy), hs = (3.2 + hash(ptx, pty, 80 + k) * 2.4) * zoomK;
        ctx.moveTo(hx - hs * 0.2, hy - hs * 2.0); ctx.lineTo(hx + hs * 0.55, hy - hs * 0.7); ctx.lineTo(hx + hs * 0.05, hy - hs * 0.9); ctx.closePath();
      }
    }
    ctx.fill();
    }
    drawDecals();
    PROF(1); // Messung (nur mit _prof)
    // Auswahl-Menge
    var sel = V.mySel(), selSet = {};
    for (i = 0; i < sel.length; i++) selSet[sel[i].id] = 1;
    // Sortierliste
    itemN = 0;
    var mx0 = -80, my0 = -140, mx1 = VW + 80, my1 = VH + 100;
    if (SPM) { // Mauer-Raster (Besitzer+1) für die Verbinder
      if (!wallG || wallG.length !== m.w * m.h) wallG = new Int8Array(m.w * m.h);
      wallG.fill(0); wallGW = m.w;
      for (i = 0; i < ents.length; i++) { e = ents[i]; if (e.type === 'wall' && e.kind === 'building' && !e.dead) wallG[e.ty * m.w + e.tx] = e.owner + 1; }
      if (!fogOff) for (var wid in P.mem) { var wm = P.mem[wid]; if (wm.type === 'wall') wallG[wm.ty * m.w + wm.tx] = wm.owner + 1; }
      spPushProps(mx0, my0, mx1, my1);
    }
    for (i = 0; i < ents.length; i++) {
      e = ents[i];
      if (e.dead) continue;
      if (e.kind === 'building') {
        var bKy = bKey(e), bhx = (e.w + e.h) * TILE * kx * 0.5, bhy = (e.w + e.h) * TILE * ky * 0.5;
        if (GCX - bhx > mx1 || bKy - GH / 2 > my1 + 100 || GCX + bhx < mx0 || bKy - bhy * 2 - 160 * zoomK < my0 - 60 && bKy + 60 < my0) continue;
        if (NEUT[e.type]) { if (!neutralShown(e, P, fogOff)) continue; }
        else if (e.owner !== pid && !fogOff && !G.Sim.isVisible(pid, e)) continue;
        pushItem(1, e, bKy, null);
      } else {
        if (e.inside) continue;
        var uX = PX(e.x, e.y), uY = PY(e.x, e.y);
        if (uX < mx0 || uX > mx1 || uY < my0 || uY > my1 + 60) continue;
        if (e.owner !== pid && !fogOff && !G.Sim.isVisible(pid, e)) continue;
        pushItem(2, e, uY + 0.5 + (e.mc === 2 && e.alt > 0.05 ? 4000 : 0), null);   // v0.8: Fliegendes über allem
      }
    }
    if (!fogOff) for (var id in P.mem) { // erinnerte Gegnergebäude
      var mm = P.mem[id], live = G.Sim.get(mm.id);
      if (live && !live.dead && G.Sim.isVisible(pid, live)) continue;
      if (NEUT[mm.type]) continue;
      var mmk = bKey(mm), mhx = (mm.w + mm.h) * TILE * kx * 0.5, mhy = (mm.w + mm.h) * TILE * ky * 0.5;
      if (GCX - mhx > mx1 || GCY - mhy > my1 || GCX + mhx < mx0 || GCY + mhy < my0) continue;
      pushItem(3, mm, mmk, true);
    }
    // Rückwärtiges Sortieren: nur den belegten Teil
    var view = items.slice(0, itemN);
    view.sort(cmpItem);
    var tick = S.tick;
    // Bodenringe der Auswahl vor allen Körpern
    ctx.lineWidth = 2.2; ctx.strokeStyle = '#4ade80';
    for (i = 0; i < sel.length; i++) {
      e = sel[i];
      if (e.kind === 'unit' && !e.inside) {
        var qwx = e.px + (e.x - e.px) * alpha, qwy = e.py + (e.y - e.py) * alpha, qx = PX(qwx, qwy), qy = PY(qwx, qwy), qr = (e.r + 5) * 1.0;
        groundEllipse(qx, qy, qr * kx, qr * ky); ctx.stroke();
      } else if (e.kind === 'building') {
        if (!ROT) ctx.strokeRect(sx(e.tx * TILE) - 3, sy(e.ty * TILE) - 3, e.w * TILE * kx + 6, e.h * TILE * ky + 6);
        else { footPath(e.tx * TILE, e.ty * TILE, e.w * TILE, e.h * TILE, 3 / kx); ctx.stroke(); }
      }
    }
    // Körper
    PROF(2); // Messung (nur mit _prof)
    for (i = 0; i < view.length; i++) {
      var it = view[i]; e = it.e;
      if (it.k === 1) {
        var pl = e.owner >= 0 ? S.players[e.owner] : null, isN = !!NEUT[e.type], bvis = fogOff || e.owner === pid || G.Sim.isVisible(pid, e);
        var age = tick - (e.placedT == null ? -100 : e.placedT);
        FAC = pl ? pl.faction : 'coalition'; UE = null;
        var dpl = deployFx[e.id], dpp = -1;
        if (dpl) { dpp = (fxTime - dpl.t0) / DEPLOY_T; if (dpp >= 1) { delete deployFx[e.id]; dpl = null; } else { age = 100; deployBegin(e, dpp); } }
        var bo = {
          ruin: isN && e.ruin, nowner: isN && pl && bvis ? pl.color : null, grow: dpl ? dpGrow : (age < 20 ? age / 20 : null), alpha: age < 20 ? 0.45 + 0.55 * age / 20 : null,
          hp: e.maxHp > 0 && !isN ? e.hp / e.maxHp : null, rep: e.repairing, fire: tick - (e.fireT == null ? -100 : e.fireT) < 3, recent: tick - (e.fireT == null ? -1000 : e.fireT) < 80
        };
        if (SPM) { bo.buildF = dpl || isN ? null : (age < 36 ? age / 36 : null); bo.alpha = age < 8 ? 0.5 + 0.5 * age / 8 : null; }
        if (k10UseB(e, FAC)) drawK10Building(e, pl ? pl.color : BEIGE, S, bo);   // PLATZHALTER v1.0
        else if (!(SPM && spBuilding(e, pl ? pl.color : BEIGE, bo, false))) drawBuilding(e, pl ? pl.color : BEIGE, S, bo);
        if (dpl) deployEnd(e, dpp, pl ? pl.color : BEIGE);
      } else if (it.k === 3) {
        var mc = S.players[e.owner] ? S.players[e.owner].color : '#999999';
        FAC = S.players[e.owner] ? S.players[e.owner].faction : 'coalition';
        var mo = { dim: true, alpha: 0.85, ghostFx: true };
        if (k10UseB(e, FAC)) drawK10Building(e, mc, S, mo);   // PLATZHALTER v1.0
        else if (!(SPM && spBuilding(e, mc, mo, true))) drawBuilding(e, mc, S, mo);
      } else if (it.k === 2) {
        var ux = e.px + (e.x - e.px) * alpha, uy = e.py + (e.y - e.py) * alpha, X = PX(ux, uy), Y = PY(ux, uy), uc = S.players[e.owner].color;
        FAC = k10Fac(e); UE = e;   // v1.0: Herkunftsfraktion (gedankenkontrollierte Einheiten behalten ihre Gestalt, Farbe = Besitzer)
        if (FAC === 'kollektiv' || K10U[e.type]) drawK10Unit(e, X, Y, uc, ux, uy, tick);   // PLATZHALTER v1.0 (auch im Sprite-Modus Vektor)
        else if (e.type === 'dreadnought') { if (!(SPM && spV9(e, X, Y, ux, uy, tick))) drawV9Dread(e, uc, ux, uy, tick); }   // v0.9 Schlachtschiff
        else if (V8U[e.type]) { if (!(SPM && spV8(e, X, Y, ux, uy, tick))) drawV8Unit(e, X, Y, uc, ux, uy, tick); }   // v0.8: Sprites (diagonal) bzw. Vektorformen
        else if (SPM && spUnit(e, X, Y, tick)) { /* Sprite */ }
        else if (isInf(e.type)) drawInfantry(e, X, Y, uc, INFK[e.type] || 0);
        else drawVehicle(e.type, X, Y, e.dir || 0, e.tdir || 0, uc, e.moving, tick - e.fireT < 3, e.cargo, false, barrelOf[e.id]);
        UE = null;
        if (e.maxHp > 0 && e.hp / e.maxHp < 0.4) smokeCol(X, Y - unitLiftPx(e) * 0.6, 2);
      } else if (it.k === 4) { // Sprite-Modus: Baum/Fels/Stein
        spDraw(e.fr, PX(e.x, e.y), PY(e.x, e.y), kx * TILE / SPD.p.p * e.s);
      }
    }
    drawWreck8(dt, SPM);   // v0.8: Absturz / Untergang
    // Projektile
    PROF(3); // Messung (nur mit _prof)
    for (i = 0; i < S.proj.length; i++) {
      var p = S.proj[i];
      if (!fogOff && !visibleAt(p.x, p.y)) continue;
      if (p.w === 'sniper' || p.w === 'flame') continue; // Trefferscan-Waffen: Darstellung über Schuss-Ereignis
      var fr = clamp((p.t + alpha) / p.dur, 0, 1), px = p.x0 + (p.tx - p.x0) * fr, py = p.y0 + (p.ty - p.y0) * fr;
      if (p.missile) { missile2(p, fr); continue; }   // v0.9 Schlachtschiff-Rakete: hoher Bogen + Rauchspur
      if (p.bomb || p.air) { proj8(p, fr, px, py); continue; }   // v0.8: Bombe fällt aus Flughöhe / Flugabwehr steigt zum Luftziel
      var dist = Math.hypot(p.tx - p.x0, p.ty - p.y0), arc = (p.w === 'rocket' ? 26 + Math.max(0, dist - 200) * 0.22 : (p.w === 'cannon' && dist > 200 ? 8 + (dist - 200) * 0.3 : 8)) * 4 * fr * (1 - fr) + 10 * (1 - fr) + 2, X1 = PX(px, py), Y1 = PY(px, py) - arc * zoomK;
      if (p.w === 'rocket') {
        var rbx = px - (p.tx - p.x0) / p.dur * 0.12, rby = py - (p.ty - p.y0) / p.dur * 0.12, bx = PX(rbx, rby), by = PY(rbx, rby) - arc * zoomK;
        if (dist > 150) { // lange Flüge (Salve): Rauchspur entlang der Bogenbahn
          for (var tj = 7; tj >= 1; tj--) {
            var tf = fr - tj * 0.022; if (tf < 0) continue;
            var tpx = p.x0 + (p.tx - p.x0) * tf, tpy = p.y0 + (p.ty - p.y0) * tf, tar = (26 + Math.max(0, dist - 200) * 0.22) * 4 * tf * (1 - tf) + 10 * (1 - tf) + 2;
            puff(PX(tpx, tpy), PY(tpx, tpy) - tar * zoomK + tj * 0.5, (2.2 + tj * 0.85) * zoomK, 'rgba(225,222,214,', 0.55 * (1 - tj / 8));
          }
        }
        ctx.strokeStyle = 'rgba(220,220,220,0.7)'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(X1, Y1); ctx.stroke();
        ctx.fillStyle = '#fb923c'; ctx.beginPath(); ctx.arc(X1, Y1, 3.2, 0, 6.2832); ctx.fill();
      } else if (p.w === 'cannon') {
        ctx.fillStyle = '#111827'; ctx.beginPath(); ctx.arc(X1, Y1, 3.4, 0, 6.2832); ctx.fill(); ctx.fillStyle = '#fde68a'; ctx.beginPath(); ctx.arc(X1 - 1, Y1 - 1, 1.5, 0, 6.2832); ctx.fill();
      } else { ctx.fillStyle = '#fde047'; ctx.beginPath(); ctx.arc(X1, Y1, 2.4, 0, 6.2832); ctx.fill(); }
    }
    drawArtyFx();
    drawFx(dt);
    drawBolts(dt);
    // Thema/Tageszeit: Dämmerung/Nacht als einfache Tönung über der Welt (vor dem Nebel → Nebel bleibt davon unterscheidbar)
    var mt = MOOD_TINT[moodOf(m).time];
    if (mt) { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = mt; ctx.fillRect(0, 0, cv.width, cv.height); ctx.restore(); }
    // Nebel
    PROF(4); // Messung (nur mit _prof)
    if (!fogOff) blitMap(world.fogCv, 1, true);
    ctx.imageSmoothingEnabled = true;
    drawSwFx();
    drawOverlay(S, P, sel, selSet, alpha, tick);
    PROF(5); // Messung (nur mit _prof)
    if (++miniFrame % 4 === 0) drawMinimap();
    frameMs = performance.now() - t0;
    PROF(6); // Messung (nur mit _prof)
  }

  // ------------------------------------------------------------------ Superwaffen: Warnmarker, Flug, Strahl, Detonation
  var FONT_SW = 'bold 22px system-ui, sans-serif';
  function puff(X, Y, r, col, a) { if (a <= 0.01) return; ctx.fillStyle = col + a.toFixed(2) + ')'; ctx.beginPath(); ctx.arc(X, Y, r, 0, 6.2832); ctx.fill(); }
  function drawSwWarn(w, now) {
    var R = SW_R[w.kind] * TILE, X = PX(w.x, w.y), Y = PY(w.x, w.y), tot = Math.max(1, w.t2 - w.t0), fr = clamp((now - w.t0) / tot, 0, 1), rem = (w.t2 - now) / D.TICK_HZ;
    if (X < -R * kx - 40 || Y < -R * ky - 40 || X > V.vw + R * kx + 40 || Y > V.vh + R * ky + 40) return;
    var pu = 0.55 + 0.45 * Math.sin(fxTime * 14), rw = R * kx, rh = R * ky, col = S_COL(w.owner);
    ctx.fillStyle = 'rgba(255,40,30,' + (0.10 + 0.16 * fr * pu).toFixed(2) + ')'; groundEllipse(X, Y, rw, rh); ctx.fill();
    ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(8,10,14,0.7)'; groundEllipse(X, Y, rw, rh); ctx.stroke();
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,' + (70 + 120 * (1 - pu) | 0) + ',50,' + (0.7 + 0.3 * pu).toFixed(2) + ')'; groundEllipse(X, Y, rw, rh); ctx.stroke();
    ctx.setLineDash([10, 9]); ctx.lineDashOffset = -fxTime * 50; ctx.lineWidth = 3; ctx.strokeStyle = col; groundEllipse(X, Y, rw * 0.66, rh * 0.66); ctx.stroke(); ctx.setLineDash([]);
    ctx.lineWidth = 2.5; ctx.strokeStyle = 'rgba(255,255,255,0.85)'; groundEllipse(X, Y, rw * (1 - fr * 0.9), rh * (1 - fr * 0.9)); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 2; ctx.beginPath(); // Fadenkreuz
    ctx.moveTo(X - rw * 0.3, Y); ctx.lineTo(X + rw * 0.3, Y); ctx.moveTo(X, Y - rh * 0.3); ctx.lineTo(X, Y + rh * 0.3); ctx.stroke();
    if (w.kind === 'orbital' && rem < 1.2 && rem > 0) { // Strahl lädt: dünner Lichtfaden von oben
      var ga = clamp(1 - rem / 1.2, 0, 1); ctx.strokeStyle = 'rgba(190,235,255,' + (0.25 + 0.6 * ga).toFixed(2) + ')'; ctx.lineWidth = 1.5 + 3 * ga;
      ctx.beginPath(); ctx.moveTo(X, Y); ctx.lineTo(X, -10); ctx.stroke();
    }
    if (rem > 0) { // Countdown
      ctx.font = FONT_SW; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; var tx2 = String(Math.ceil(rem));
      ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(8,10,14,0.9)'; ctx.strokeText(tx2, X, Y - rh * 0.42); ctx.fillStyle = '#ffffff'; ctx.fillText(tx2, X, Y - rh * 0.42);
    }
  }
  function S_COL(owner) { var p = G.Sim.S.players[owner]; return p ? p.color : '#ffffff'; }
  function drawSwMissile(w, now) {
    var f = clamp((now - w.t0) / Math.max(1, w.t2 - w.t0), 0, 1), dist = Math.hypot(w.x - w.sx, w.y - w.sy);
    var H = Math.min(70 + dist * kx * 0.42, 440) * 1;
    function pos(ff) { var q = ff < 0 ? 0 : ff, qx = w.sx + (w.x - w.sx) * q, qy = w.sy + (w.y - w.sy) * q; return { X: PX(qx, qy), Y: PY(qx, qy) - H * 4 * q * (1 - q) * (1 + 0.0 * q) - 10 * Math.min(1, q * 8) }; }
    var p = pos(f), i;
    // Abgaswolke am Silo
    var age = (now - w.t0) / D.TICK_HZ;
    if (age < 2.6) { var sX = PX(w.sx, w.sy), sY = PY(w.sx, w.sy); for (i = 0; i < 5; i++) puff(sX + (i - 2) * 9 * zoomK, sY - 8 - age * 8 * (1 + i * 0.2), (8 + age * 9 + i * 3) * zoomK, 'rgba(225,220,210,', 0.5 * (1 - age / 2.6)); }
    // Rauchspur
    for (i = 14; i >= 1; i--) {
      var ff = f - i * 0.014; if (ff < 0) continue; var q2 = pos(ff);
      puff(q2.X, q2.Y + i * 0.6, (3.5 + i * 0.7) * zoomK, 'rgba(215,212,205,', 0.6 * (1 - i / 15));
    }
    // Bodenschatten
    var gwx = w.sx + (w.x - w.sx) * f, gwy = w.sy + (w.y - w.sy) * f, gx = PX(gwx, gwy), gy = PY(gwx, gwy);
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; groundEllipse(gx, gy, 9 * zoomK, 4 * zoomK); ctx.fill();
    // Rakete (Ausrichtung entlang der Flugbahn)
    var pn = pos(Math.min(1, f + 0.012)), ang = Math.atan2(pn.Y - p.Y, pn.X - p.X), L = 15 * clamp(zoomK, 0.9, 1.5);
    ctx.save(); ctx.translate(p.X, p.Y); ctx.rotate(ang);
    ctx.fillStyle = 'rgba(255,170,50,0.95)'; ctx.beginPath(); ctx.moveTo(-L, 0); ctx.lineTo(-L - 9 - 4 * Math.sin(fxTime * 40), -2.6); ctx.lineTo(-L - 9 - 4 * Math.sin(fxTime * 40), 2.6); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#e5e7eb'; ctx.fillRect(-L, -3.4, L * 1.5, 6.8); ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(-L, 0.4, L * 1.5, 3);
    ctx.fillStyle = '#ef4444'; ctx.beginPath(); ctx.moveTo(L * 0.5, -3.4); ctx.lineTo(L * 1.05, 0); ctx.lineTo(L * 0.5, 3.4); ctx.closePath(); ctx.fill();
    ctx.fillStyle = S_COL(w.owner); ctx.fillRect(-L * 0.2, -3.4, 4, 6.8);
    ctx.fillStyle = '#4b5563'; ctx.beginPath(); ctx.moveTo(-L, -3.4); ctx.lineTo(-L - 4, -8); ctx.lineTo(-L + 5, -3.4); ctx.moveTo(-L, 3.4); ctx.lineTo(-L - 4, 8); ctx.lineTo(-L + 5, 3.4); ctx.fill();
    ctx.strokeStyle = OUT; ctx.lineWidth = 1; ctx.strokeRect(-L, -3.4, L * 1.5, 6.8);
    ctx.restore();
  }
  function drawSwBlast(bl) {
    var t = fxTime - bl.t0, X = PX(bl.x, bl.y), Y = PY(bl.x, bl.y), rw = bl.r * kx, rh = bl.r * ky, orb = bl.kind === 'orbital', dur = orb ? 3.0 : 3.6;
    if (t > dur) return;
    if (X < -rw * 1.5 - 60 || Y < -rh * 2 - 400 || X > V.vw + rw * 1.5 + 60 || Y > V.vh + rh * 1.5 + 60) return;
    var i, a;
    if (orb && t < 1.1) { // Lichtsäule von oben + Glühen am Boden
      var pr = t < 0.12 ? t / 0.12 : Math.max(0, 1 - (t - 0.12) / 0.98), bw2 = bl.r * kx * 0.34 * (0.35 + 0.65 * pr) * (1 + 0.06 * Math.sin(fxTime * 60));
      var gr = ctx.createLinearGradient(0, 0, 0, Y);
      gr.addColorStop(0, 'rgba(140,210,255,0)'); gr.addColorStop(0.35, 'rgba(160,220,255,' + (0.55 * pr).toFixed(2) + ')'); gr.addColorStop(1, 'rgba(235,248,255,' + (0.85 * pr).toFixed(2) + ')');
      ctx.fillStyle = gr; ctx.fillRect(X - bw2 * 1.9, -10, bw2 * 3.8, Y + 10);
      gr = ctx.createLinearGradient(0, 0, 0, Y);
      gr.addColorStop(0, 'rgba(255,255,255,0.15)'); gr.addColorStop(1, 'rgba(255,255,255,' + pr.toFixed(2) + ')');
      ctx.fillStyle = gr; ctx.fillRect(X - bw2 * 0.55, -10, bw2 * 1.1, Y + 10);
      var gg = ctx.createRadialGradient(X, Y, 0, X, Y, rw * 1.05); // Bodenglut
      gg.addColorStop(0, 'rgba(255,255,255,' + (0.95 * pr).toFixed(2) + ')'); gg.addColorStop(0.35, 'rgba(150,215,255,' + (0.6 * pr).toFixed(2) + ')'); gg.addColorStop(1, 'rgba(120,190,255,0)');
      ctx.save(); ctx.translate(X, Y); ctx.scale(1, rh / rw); ctx.translate(-X, -Y); ctx.fillStyle = gg; ctx.beginPath(); ctx.arc(X, Y, rw * 1.05, 0, 6.2832); ctx.fill(); ctx.restore();
    }
    // Druckwelle
    for (i = 0; i < 2; i++) {
      var ts = t - i * 0.18; if (ts < 0 || ts > 1.1) continue;
      a = ts / 1.1; var sr = 0.15 + 1.0 * (1 - (1 - a) * (1 - a));
      ctx.lineWidth = (10 - 8 * a) * (i ? 0.6 : 1); ctx.strokeStyle = (orb ? 'rgba(200,235,255,' : 'rgba(255,225,170,') + (0.85 * (1 - a)).toFixed(2) + ')';
      groundEllipse(X, Y, rw * sr, rh * sr); ctx.stroke();
      if (!i) { ctx.fillStyle = (orb ? 'rgba(170,215,255,' : 'rgba(230,200,150,') + (0.22 * (1 - a)).toFixed(2) + ')'; groundEllipse(X, Y, rw * sr, rh * sr); ctx.fill(); }
    }
    // Feuerball
    if (t < 1.6) {
      a = t / 1.6; var fr2 = rw * (orb ? 0.5 : 0.62) * (0.3 + 0.75 * Math.sqrt(a)), rise = rh * 0.5 * a;
      puff(X, Y - rise * 0.6, fr2 * 1.15, orb ? 'rgba(80,60,50,' : 'rgba(60,52,46,', 0.5 * (1 - a));
      ctx.fillStyle = 'rgba(255,' + (150 - 90 * a | 0) + ',40,' + (0.9 * (1 - a)).toFixed(2) + ')'; ctx.beginPath(); ctx.ellipse(X, Y - rise, fr2, fr2 * 0.82, 0, 0, 6.2832); ctx.fill();
      ctx.fillStyle = 'rgba(255,240,180,' + (0.95 * (1 - a)).toFixed(2) + ')'; ctx.beginPath(); ctx.ellipse(X, Y - rise * 1.1, fr2 * 0.55, fr2 * 0.45, 0, 0, 6.2832); ctx.fill();
      if (t < 0.22) { ctx.fillStyle = 'rgba(255,255,255,' + (0.8 * (1 - t / 0.22)).toFixed(2) + ')'; groundEllipse(X, Y, rw * 1.05, rh * 1.05); ctx.fill(); }
    }
    // Rauch- und Staubsäule (aufsteigende Schwaden, keine Kappe)
    a = t / dur; var colH = rw * (orb ? 1.05 : 1.5) * Math.min(1, t / 1.4);
    for (i = 0; i < 9; i++) {
      var ph2 = i / 9, hy = colH * (0.12 + ph2 * 0.88), wob = (hash(i, 7, 3) - 0.5) * rw * 0.35 * (0.4 + ph2), rad = rw * (0.17 + 0.12 * ph2 + 0.08 * a) * (orb ? 0.8 : 1);
      puff(X + wob, Y - hy, rad, i % 2 ? 'rgba(78,72,66,' : 'rgba(112,104,94,', 0.55 * (1 - a) * (1 - 0.35 * ph2));
    }
    for (i = 0; i < 6; i++) { // Staubring am Boden
      var an = i * 1.047 + hash(i, 2, 4), dr = rw * (0.35 + 0.65 * Math.min(1, t / 1.2));
      puff(X + Math.cos(an) * dr, Y + Math.sin(an) * dr * (rh / rw), rw * 0.16, 'rgba(150,135,110,', 0.4 * (1 - a));
    }
  }
  function drawSwFx() {
    var i, now = curTick + curAlpha;
    for (i = swList.length - 1; i >= 0; i--) if (now > swList[i].t2 + 4) swList.splice(i, 1);
    for (i = swBlasts.length - 1; i >= 0; i--) if (fxTime - swBlasts[i].t0 > 3.7) swBlasts.splice(i, 1);
    for (i = 0; i < swList.length; i++) {
      var w = swList[i];
      if (now < w.t2) { drawSwWarn(w, now); if (w.kind === 'missile') drawSwMissile(w, now); }
    }
    for (i = 0; i < swBlasts.length; i++) drawSwBlast(swBlasts[i]);
    ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
  }
  /** Ladering der Superwaffe: Fortschritt in Teamfarbe, bei 1 pulsierend weiß */
  function swOverlay(e, S, pid, fogOff) {
    var X = PX(e.x, e.y + e.h * TILE * 0.08), Y = PY(e.x, e.y + e.h * TILE * 0.08);
    if (X < -200 || Y < -200 || X > V.vw + 200 || Y > V.vh + 200) return;
    var pl = S.players[e.owner]; if (!pl) return;
    var a0 = -Math.PI / 2, ch = clamp(e.charge || 0, 0, 1), rw = ((ROT ? Math.max(e.w, e.h) : e.w) / 2 + 0.45) * TILE * kx, rh = ((ROT ? Math.max(e.w, e.h) : e.h) / 2 + 0.45) * TILE * ky;
    if (ch < 1) {
      arcRing(X, Y, rw, rh, 0, 6.2832, 9, 'rgba(0,0,0,0.65)');
      arcRing(X, Y, rw, rh, 0, 6.2832, 5, 'rgba(255,255,255,0.18)');
      arcRing(X, Y, rw, rh, a0, a0 + 6.2832 * ch, 5, pl.color);
    } else {
      var pu = 0.5 + 0.5 * Math.sin(performance.now() / 150);
      arcRing(X, Y, rw, rh, 0, 6.2832, 12, 'rgba(0,0,0,0.7)');
      ctx.globalAlpha = 0.55 + 0.45 * pu; arcRing(X, Y, rw, rh, 0, 6.2832, 8, '#ffffff'); arcRing(X, Y, rw, rh, 0, 6.2832, 4, pl.color);
      ctx.globalAlpha = 0.25 * pu; arcRing(X, Y, rw * (1.06 + 0.1 * pu), rh * (1.06 + 0.1 * pu), 0, 6.2832, 6, '#ffffff'); ctx.globalAlpha = 1;
    }
  }
  function hpBar(cx, cy, w, frac) {
    var h = 5, x = Math.round(cx - w / 2), y = Math.round(cy);
    ctx.fillStyle = 'rgba(0,0,0,0.85)'; ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
    ctx.fillStyle = frac > 0.6 ? '#22c55e' : (frac > 0.3 ? '#facc15' : '#ef4444');
    ctx.fillRect(x, y, Math.max(1, Math.round(w * frac)), h);
  }
  /** Erfahrung: Rangabzeichen (1–3 Winkel). Mit Lebensbalken links daneben, sonst dezent über der Einheit; fl (0..1) = Aufblitzen nach Aufstieg. */
  function rankBadge(cx, cy, w, rank, bar, fl) {
    var s = 1.25 + 0.5 * fl, x = bar ? Math.round(cx - w / 2) - 8 : cx, y = bar ? cy + 2.5 : cy - 4, i,
        col = rank >= 3 ? '#ffd23f' : (rank === 2 ? '#fbbf24' : '#e5e7eb');
    if (fl > 0) { ctx.beginPath(); ctx.arc(x, y, 7 + 7 * fl, 0, 6.2832); ctx.fillStyle = 'rgba(255,255,255,' + (0.55 * fl).toFixed(2) + ')'; ctx.fill(); }
    ctx.save(); ctx.globalAlpha = bar || fl > 0 ? 1 : 0.8; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (var pass = 0; pass < 2; pass++) {
      ctx.lineWidth = pass ? 2 : 4.2; ctx.strokeStyle = pass ? col : 'rgba(0,0,0,0.85)';
      for (i = 0; i < rank; i++) {
        var yy = y + (i - (rank - 1) / 2) * 3.6 * s;
        ctx.beginPath(); ctx.moveTo(x - 4.5 * s, yy + 2 * s); ctx.lineTo(x, yy - 1.6 * s); ctx.lineTo(x + 4.5 * s, yy + 2 * s); ctx.stroke();
      }
    }
    ctx.restore();
  }
  function arcRing(X, Y, rw, rh, a0, a1, lw, col) {
    ctx.lineWidth = lw; ctx.strokeStyle = col; ctx.beginPath(); ctx.ellipse(X, Y, rw, rh, 0, a0, a1); ctx.stroke();
  }
  function drawOverlay(S, P, sel, selSet, alpha, tick) {
    var pid = V.pid, fogOff = S.settings.fogOff, ents = S.ents, i, e, VW = V.vw, VH = V.vh;
    drawMcLinks(S, pid, fogOff, alpha, tick);   // v1.0 Gedankenkontrolle / Magnet
    // Sammelpunkt
    if (sel.length === 1 && sel[0].kind === 'building' && sel[0].rx >= 0) {
      var b = sel[0], X0 = PX(b.x, b.y), Y0 = PY(b.x, b.y), X1 = PX(b.rx, b.ry), Y1 = PY(b.rx, b.ry);
      ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 2; ctx.setLineDash([6, 6]);
      ctx.beginPath(); ctx.moveTo(X0, Y0); ctx.lineTo(X1, Y1); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#111'; ctx.fillRect(X1 - 2, Y1 - 24, 4, 25);
      ctx.fillStyle = '#fbbf24'; ctx.beginPath(); ctx.moveTo(X1 + 2, Y1 - 24); ctx.lineTo(X1 + 18, Y1 - 18); ctx.lineTo(X1 + 2, Y1 - 12); ctx.fill();
    }
    // Neutrale: Eroberungsring, Artillerie-Ladering, Besatzungs-Pips
    for (i = 0; i < ents.length; i++) {
      e = ents[i];
      if (e.dead || e.kind !== 'building' || !NEUT[e.type] || e.ruin) continue;
      if (!neutralShown(e, P, fogOff)) continue;
      neutralOverlay(e, S, pid, fogOff);
    }
    for (i = 0; i < ents.length; i++) { // eigene Bunker: Besatzungs-Pips
      e = ents[i];
      if (e.dead || e.kind !== 'building' || e.type !== 'pbunker' || e.owner < 0) continue;
      if (e.owner !== pid && !fogOff && !G.Sim.isVisible(pid, e)) continue;
      var pbX = PX(e.x, e.y);
      if (pbX < -100 || pbX > V.vw + 100) continue;
      garrisonPips(e, S, pbX, true);
    }
    for (i = 0; i < ents.length; i++) { // Superwaffen-Ladering (eigene und sichtbare gegnerische)
      e = ents[i];
      if (e.dead || e.kind !== 'building' || (e.type !== 'orbital' && e.type !== 'silo')) continue;
      if (e.owner !== pid && !fogOff && !G.Sim.isVisible(pid, e)) continue;
      swOverlay(e, S, pid, fogOff);
    }
    // Befehlsmarker
    var tnow = performance.now();
    for (i = V.markers.length - 1; i >= 0; i--) {
      var mk = V.markers[i], mf = (tnow - mk.t0) / 600;
      if (mf >= 1) { V.markers.splice(i, 1); continue; }
      var mcol = mk.kind === 'attack' ? '248,90,80' : (mk.kind === 'rally' ? '251,191,36' : '74,222,128'), mr = (14 * (1 - mf) + 5);
      ctx.strokeStyle = 'rgba(' + mcol + ',' + (1 - mf).toFixed(2) + ')'; ctx.lineWidth = 3;
      groundEllipse(PX(mk.x, mk.y), PY(mk.x, mk.y), mr * kx / 1.2, mr * ky / 1.2); ctx.stroke();
      if (mk.kind === 'attack') { var Xm = PX(mk.x, mk.y), Ym = PY(mk.x, mk.y), cr = mr * 0.6; ctx.beginPath(); ctx.moveTo(Xm - cr, Ym); ctx.lineTo(Xm + cr, Ym); ctx.moveTo(Xm, Ym - cr * 0.8); ctx.lineTo(Xm, Ym + cr * 0.8); ctx.stroke(); }
    }
    // Platzierungsvorschau
    var pl = V.placing;
    if (pl && pl.tiles && pl.tiles.length) drawWallGhost(pl, S, P);
    else if (pl && pl.tx != null) {
      var bd = D.BUILDINGS[pl.type];
      if (bd) {
        var okc = pl.ok ? '34,197,94' : '239,68,68', gwx0 = pl.tx * TILE, gwy0 = pl.ty * TILE, gww = bd.w * TILE, gwh = bd.h * TILE;
        ctx.fillStyle = 'rgba(' + okc + ',0.35)'; footPath(gwx0, gwy0, gww, gwh, 0); ctx.fill();
        ctx.strokeStyle = 'rgba(' + okc + ',0.85)'; ctx.lineWidth = 1; ctx.beginPath();
        for (i = 1; i < bd.w; i++) { ctx.moveTo(PX(gwx0 + i * TILE, gwy0), PY(gwx0 + i * TILE, gwy0)); ctx.lineTo(PX(gwx0 + i * TILE, gwy0 + gwh), PY(gwx0 + i * TILE, gwy0 + gwh)); }
        for (i = 1; i < bd.h; i++) { ctx.moveTo(PX(gwx0, gwy0 + i * TILE), PY(gwx0, gwy0 + i * TILE)); ctx.lineTo(PX(gwx0 + gww, gwy0 + i * TILE), PY(gwx0 + gww, gwy0 + i * TILE)); }
        ctx.stroke();
        FAC = P.faction;
        drawBuilding({ type: pl.type, tx: pl.tx, ty: pl.ty, w: bd.w, h: bd.h, tdir: 0, id: 0 }, P.color, S, { alpha: 0.6, ghostFx: true });
        ctx.strokeStyle = pl.ok ? '#4ade80' : '#f87171'; ctx.lineWidth = 3; footPath(gwx0, gwy0, gww, gwh, -1.5 / kx); ctx.stroke();
      }
    }
    // Lebensbalken: ausgewählte oder beschädigte; Auswahlumriss um Gebäude
    for (i = 0; i < ents.length; i++) {
      e = ents[i];
      if (e.dead || e.inside || e.ruin || !(e.maxHp > 0)) continue;
      var isSel = selSet[e.id], noBar = e.hp >= e.maxHp && !isSel;   // Erfahrung: Rangabzeichen auch ohne Lebensbalken
      if (noBar && !(e.rk > 0)) continue;
      if (e.owner !== pid && !fogOff && !G.Sim.isVisible(pid, e)) continue;
      if (e.kind === 'unit') {
        var ux = e.px + (e.x - e.px) * alpha, uy = e.py + (e.y - e.py) * alpha, X = PX(ux, uy), Y = PY(ux, uy) - unitLiftPx(e) - 5;
        if (X < -40 || Y < -20 || X > VW + 40 || Y > VH + 40) continue;
        var bw0 = Math.round(clamp(e.r * 2 * kx * 0.95, 20, 44));
        if (!noBar) hpBar(X, Y, bw0, e.hp / e.maxHp);
        if (e.rk > 0) rankBadge(X, Y, bw0, e.rk, !noBar, Math.max(0, 1 - (S.tick - (e.rankT || -999)) / G.DATA.EXP.flashT));
        if (!noBar && (e.type === 'apc' || (e.gar && e.cap))) apcPips(e, X, Y - 4);   // v0.8: alle Transporter
      } else {
        var hg = bHeight(e.type), X2, Y2, bw = Math.round(clamp(e.w * TILE * kx * 0.75, 24, 120));
        bgeom(e); X2 = GCX; Y2 = GCY - GH / 2 - hg - 9;
        if (X2 < -100 || Y2 < -20 || X2 > VW + 100 || Y2 > VH + 60) continue;
        hpBar(X2, Y2, bw, e.hp / e.maxHp);
        if (isSel) bldSelOutline(e, hg);
      }
    }
    for (i = 0; i < sel.length; i++) { // neutrale/unzerstörbare Gebäude: Umriss ebenfalls
      e = sel[i];
      if (e.kind !== 'building' || e.maxHp > 0 && !e.ruin) continue;
      var hg2 = bHeight(e.type); bldSelOutline(e, hg2);
    }
    if (V.box) {
      ctx.strokeStyle = '#4ade80'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
      var bx0 = Math.min(V.box.x0, V.box.x1), by0 = Math.min(V.box.y0, V.box.y1), bw2 = Math.abs(V.box.x1 - V.box.x0), bh2 = Math.abs(V.box.y1 - V.box.y0);
      ctx.strokeRect(bx0, by0, bw2, bh2); ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(74,222,128,0.12)'; ctx.fillRect(bx0, by0, bw2, bh2);
    }
    if (V.amArmed) { ctx.strokeStyle = '#f87171'; ctx.lineWidth = 4; ctx.strokeRect(2, 2, VW - 4, VH - 4); }
    void tick;
  }
  /** Auswahlumriss eines Gebäudes: YAW 0 ein Rechteck (Grundfläche + Höhe); gedreht Raute der Grundfläche + Umriss des aufrechten Quaders */
  function bldSelOutline(e, hg) {
    ctx.strokeStyle = '#4ade80'; ctx.lineWidth = 2.2;
    if (!ROT) { ctx.strokeRect(sx(e.tx * TILE) - 1, sy(e.ty * TILE) - hg - 1, e.w * TILE * kx + 2, e.h * TILE * ky + hg + 2); return; }
    bgeom(e);
    footPath(e.tx * TILE, e.ty * TILE, e.w * TILE, e.h * TILE, 1 / kx); ctx.stroke();
    ctx.strokeRect(GCX - GW / 2 - 1, GCY - GH / 2 - hg - 1, GW + 2, GH + hg + 2);
  }
  /** v0.7 Schützenpanzer: Passagier-Pips (cap Plätze, gefüllt = Infanterie an Bord) über dem Lebensbalken */
  function apcPips(e, X, Y) {
    var cap = e.cap || 5, n = e.gar ? (G.Sim.usedSlots ? G.Sim.usedSlots(e) : e.gar.length) : 0, S = G.Sim.S, own = e.owner === V.pid, pl = S.players[e.owner], i;
    if (!pl || (!own && n === 0)) return;
    var rp = clamp(2.6 + zoomK * 1.7, 3.2, 5.2), sp = rp * 2 + 3, x0 = X - (cap - 1) * sp / 2, py = Y - rp - 3, shown = own ? cap : n;
    if (!own) x0 = X - (n - 1) * sp / 2;
    for (i = 0; i < shown; i++) {
      var px = x0 + i * sp, filled = i < n;
      ctx.beginPath(); ctx.arc(px, py, rp + 1.4, 0, 6.2832); ctx.fillStyle = 'rgba(0,0,0,0.85)'; ctx.fill();
      ctx.beginPath(); ctx.arc(px, py, rp, 0, 6.2832);
      if (filled) { ctx.fillStyle = pl.color; ctx.fill(); ctx.lineWidth = 1.4; ctx.strokeStyle = '#ffffff'; ctx.stroke(); }
      else { ctx.fillStyle = 'rgba(20,24,30,0.9)'; ctx.fill(); ctx.lineWidth = 1.4; ctx.strokeStyle = pl.color; ctx.stroke(); }
    }
  }
  /** Eroberungsring (capT in capBy-Farbe), Artillerie-Ladering, Besatzungs-Pips */
  function neutralOverlay(e, S, pid, fogOff) {
    var bd = NEUT[e.type], vis = fogOff || e.owner === pid || G.Sim.isVisible(pid, e);
    var X = PX(e.x, e.y), Y = PY(e.x, e.y);
    if (X < -200 || Y < -200 || X > V.vw + 200 || Y > V.vh + 200) return;
    var rr = Math.max(e.w || bd.w, e.h || bd.h) / 2 + 0.35, a0 = -Math.PI / 2, i, rw = rr * TILE * kx, rh = rr * TILE * ky;
    if (vis && e.capT > 0 && e.capT < 1 && e.capBy >= 0 && S.players[e.capBy]) {
      arcRing(X, Y, rw, rh, 0, 6.2832, 11, 'rgba(0,0,0,0.7)');
      arcRing(X, Y, rw, rh, 0, 6.2832, 7, 'rgba(255,255,255,0.25)');
      arcRing(X, Y, rw, rh, a0, a0 + 6.2832 * e.capT, 7, S.players[e.capBy].color);
    }
    if (e.type === 'artillery' && e.owner >= 0 && vis && S.players[e.owner]) {
      var ch = e.charge || 0, col = S.players[e.owner].color, rw2 = rw + 0.25 * TILE * kx, rh2 = rh + 0.25 * TILE * ky;
      if (ch < 1) {
        arcRing(X, Y, rw2, rh2, 0, 6.2832, 8, 'rgba(0,0,0,0.65)');
        arcRing(X, Y, rw2, rh2, 0, 6.2832, 4, 'rgba(255,255,255,0.18)');
        arcRing(X, Y, rw2, rh2, a0, a0 + 6.2832 * ch, 4, col);
      } else {
        arcRing(X, Y, rw2, rh2, 0, 6.2832, 9, 'rgba(0,0,0,0.7)');
        ctx.globalAlpha = 0.6 + 0.4 * Math.sin(performance.now() / 160);
        arcRing(X, Y, rw2, rh2, 0, 6.2832, 6, '#ffffff'); arcRing(X, Y, rw2, rh2, 0, 6.2832, 3, col); ctx.globalAlpha = 1;
      }
    }
    garrisonPips(e, S, X, vis);
  }
  /** Besatzungs-Pips über Haus/Block/Bunker (neutral) und Bunker (baubar) */
  function garrisonPips(e, S, X, vis) {
    var i;
    if (GARR[e.type]) {
      var cap = e.cap || (e.type === 'house' ? 3 : (e.type === 'block' ? 5 : 4)), n = e.gar ? e.gar.length : 0, owned = e.owner >= 0 && S.players[e.owner];
      if (owned && !vis) return;
      bgeom(e); var py = GCY - GH / 2 - bHeight(e.type) - 16 * clamp(zoomK, 0.8, 1.3);
      var rp = clamp(4.5 + zoomK * 2.5, 6, 9) * (owned ? 1 : 0.7), sp = rp * 2 + 5, x0 = X - (cap - 1) * sp / 2;
      for (i = 0; i < cap; i++) {
        var px = x0 + i * sp, filled = i < n && owned;
        if (!owned && !(zoomK >= 0.8)) break;
        ctx.beginPath(); ctx.arc(px, py, owned ? rp + 2 : rp + 1, 0, 6.2832); ctx.fillStyle = owned ? 'rgba(0,0,0,0.85)' : 'rgba(0,0,0,0.4)'; ctx.fill();
        ctx.beginPath(); ctx.arc(px, py, rp, 0, 6.2832);
        if (filled) { ctx.fillStyle = S.players[e.owner].color; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#ffffff'; ctx.stroke(); }
        else { ctx.fillStyle = owned ? 'rgba(20,24,30,0.9)' : 'rgba(20,24,30,0.15)'; ctx.fill(); ctx.lineWidth = owned ? 2 : 1.5; ctx.strokeStyle = owned ? S.players[e.owner].color : 'rgba(255,255,255,0.75)'; ctx.stroke(); }
      }
    }
  }

  // ------------------------------------------------------------------ Picking
  /** Entität unter Bildschirmpunkt (CSS-px des Karten-Canvas): Einheiten nach Abstand, Gebäude nach Silhouette (Grundfläche + Höhe). */
  function pickAt(px, py, slack) {
    var S = G.Sim.S;
    if (!S || !world || !V || !V.running) return null;
    setView();
    var pid = V.pid, fogOff = S.settings.fogOff, P = S.players[pid], best = null, bestD = 1e9, i, e;
    for (i = 0; i < S.ents.length; i++) {
      e = S.ents[i];
      if (e.dead || e.kind !== 'unit' || e.inside) continue;
      if (e.owner !== pid && !fogOff && !G.Sim.isVisible(pid, e)) continue;
      var X = PX(e.x, e.y), Y = PY(e.x, e.y) - (e.mc === 2 ? airScreen(e) : unitLiftPx(e) * 0.45);   // v0.8: Luftfahrzeuge in Flughöhe
      var rad = Math.max(e.r * kx, isInf(e.type) ? 9 : 12);
      var d = Math.hypot(X - px, Y - py) - rad;
      if (d <= (slack || 6) && d < bestD) { best = e; bestD = d; }
    }
    if (best) return best;
    var bestKey = -1e9;
    for (i = 0; i < S.ents.length; i++) {
      e = S.ents[i];
      if (e.dead || e.kind !== 'building') continue;
      if (NEUT[e.type]) { if (e.ruin || !neutralShown(e, P, fogOff)) continue; }
      else if (e.owner !== pid && !fogOff && !G.Sim.isVisible(pid, e)) continue;
      var hg = bHeight(e.type), hit = false, bk;
      bgeom(e); bk = GCY + GH / 2;
      if (!ROT) { var x0 = sx(e.tx * TILE), y1 = sy((e.ty + e.h) * TILE), y0 = sy(e.ty * TILE) - hg; hit = px >= x0 && px <= x0 + e.w * TILE * kx && py >= y0 && py <= y1; }
      else { // aufrechter Quader (Oberseite + Wand) oder Grundflächen-Raute
        hit = px >= GCX - GW / 2 && px <= GCX + GW / 2 && py >= GCY - GH / 2 - hg && py <= GCY + GH / 2;
        if (!hit) { toW(px, py); hit = tmpX >= e.tx * TILE && tmpX <= (e.tx + e.w) * TILE && tmpY >= e.ty * TILE && tmpY <= (e.ty + e.h) * TILE; }
      }
      if (hit && bk > bestKey) { bestKey = bk; best = e; }
    }
    return best;
  }

  // ------------------------------------------------------------------ Minimap
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
    var mxs = W / m.w, mys = H / m.h, i;
    mctx.setTransform(1, 0, 0, 1, 0, 0);
    mctx.imageSmoothingEnabled = true;
    mctx.drawImage(world.miniBase, 0, 0, W, H);
    mctx.fillStyle = '#f2c14e';
    for (i = 0; i < world.oreIdx.length; i++) {
      var ti = world.oreIdx[i];
      if (m.ore[ti] > 0) mctx.fillRect((ti % m.w) * mxs + mxs * 0.15, Math.floor(ti / m.w) * mys + mys * 0.15, mxs * 0.7, mys * 0.7);
    }
    var pid = V.pid, fogOff = S.settings.fogOff, P = S.players[pid];
    if (!fogOff) for (var id in P.mem) {
      var mm = P.mem[id]; if (NEUT[mm.type]) continue; mctx.fillStyle = '#111'; mctx.fillRect(mm.tx * mxs - 1, mm.ty * mys - 1, mm.w * mxs + 2, mm.h * mys + 2);
      mctx.fillStyle = S.players[mm.owner].color; mctx.fillRect(mm.tx * mxs, mm.ty * mys, mm.w * mxs, mm.h * mys);
    }
    var ds = Math.max(3, 2.2 * dpr);
    for (i = 0; i < S.ents.length; i++) {
      var e = S.ents[i];
      if (e.dead || e.inside) continue;
      if (e.kind === 'building' && NEUT[e.type]) {
        if (!neutralShown(e, P, fogOff)) continue;
        var nowner = e.owner >= 0 ? S.players[e.owner] : null, nvis = fogOff || e.owner === pid || G.Sim.isVisible(pid, e);
        if (e.ruin) { mctx.fillStyle = '#2b2824'; mctx.fillRect(e.tx * mxs, e.ty * mys, e.w * mxs, e.h * mys); continue; }
        mctx.fillStyle = '#0b0f14'; mctx.fillRect(e.tx * mxs - 1.5, e.ty * mys - 1.5, e.w * mxs + 3, e.h * mys + 3);
        mctx.fillStyle = nowner && nvis ? nowner.color : '#d9d2bd'; mctx.fillRect(e.tx * mxs, e.ty * mys, e.w * mxs, e.h * mys);
        if (!GARR[e.type]) { mctx.fillStyle = '#0b0f14'; mctx.fillRect(e.tx * mxs + e.w * mxs * 0.3, e.ty * mys + e.h * mys * 0.3, e.w * mxs * 0.4, e.h * mys * 0.4); }
        continue;
      }
      if (e.owner !== pid && !fogOff && !G.Sim.isVisible(pid, e)) continue;
      var col = S.players[e.owner].color, mol = miniOutline(col);   // v1.0: heller Rand für dunkle Teamfarben
      if (e.kind === 'building') {
        if (e.type !== 'wall') { mctx.fillStyle = mol; mctx.fillRect(e.tx * mxs - 1, e.ty * mys - 1, e.w * mxs + 2, e.h * mys + 2); }
        mctx.fillStyle = col; mctx.fillRect(e.tx * mxs, e.ty * mys, e.w * mxs, e.h * mys);
      } else {
        var ux = e.x / TILE * mxs, uy = e.y / TILE * mys;
        mctx.fillStyle = mol; mctx.fillRect(ux - ds / 2 - 1, uy - ds / 2 - 1, ds + 2, ds + 2);
        mctx.fillStyle = col; mctx.fillRect(ux - ds / 2, uy - ds / 2, ds, ds);
      }
    }
    if (!fogOff) { mctx.imageSmoothingEnabled = true; mctx.drawImage(world.fogCv, 0, 0, W, H); }
    if (P.radar && !fogOff) { // Radar: Gegner auch im Nebel als pulsierende Blips
      var rpul = 0.5 + 0.5 * Math.sin(performance.now() / 260), rs2 = ds + 1 + rpul;
      for (i = 0; i < S.ents.length; i++) {
        var re = S.ents[i];
        if (re.dead || re.inside || re.kind !== 'unit' || re.owner === pid || G.Sim.isVisible(pid, re)) continue;
        var rux = re.x / TILE * mxs, ruy = re.y / TILE * mys;
        mctx.fillStyle = '#ffffff'; mctx.fillRect(rux - rs2 / 2 - 1, ruy - rs2 / 2 - 1, rs2 + 2, rs2 + 2);
        mctx.fillStyle = S.players[re.owner].color; mctx.fillRect(rux - rs2 / 2, ruy - rs2 / 2, rs2, rs2);
      }
    }
    var a = V.toWorld(0, 0), b = V.toWorld(V.vw, 0), c = V.toWorld(V.vw, V.vh), d = V.toWorld(0, V.vh);
    mctx.strokeStyle = '#ffffff'; mctx.lineWidth = Math.max(1.5, dpr * 1.2);
    mctx.beginPath();
    mctx.moveTo(a.x / TILE * mxs, a.y / TILE * mys); mctx.lineTo(b.x / TILE * mxs, b.y / TILE * mys);
    mctx.lineTo(c.x / TILE * mxs, c.y / TILE * mys); mctx.lineTo(d.x / TILE * mxs, d.y / TILE * mys); mctx.closePath();
    mctx.stroke();
  }
  function miniToWorld(mx, my) {
    var S = G.Sim.S, r = mini.getBoundingClientRect();
    return { x: mx / r.width * S.map.w * TILE, y: my / r.height * S.map.h * TILE };
  }

  // ------------------------------------------------------------------ Symbole (Seitenleiste)
  var iconCache = {};
  /** Sprite-Modus: Symbol aus dem vorgerenderten Bild (Gebäude: Grundbild, Einheit: Wanne + Turm schräg nach rechts unten) */
  function spIcon(c, type, color, w, h) {
    var fac = 'coalition', F = D.FACTIONS;
    for (var f in F) if (F[f].color.toLowerCase() === String(color).toLowerCase()) fac = f;
    var fr = null, tf = null, rec, pv = null;
    if (SPD.u[type]) { rec = spRecU(type, fac); if (!rec || !rec.hull) return false; var d = Math.PI * 0.12; fr = rec.hull[spIdx(d, rec.hull.length)]; if (rec.tur) { tf = rec.tur[spIdx(d, rec.tur.length)]; pv = rec; } }
    else if (type === 'wall') { rec = SPD.w[fac]; if (!rec) return false; fr = rec.pillar; }
    else if (SPD.b[type]) { rec = SPD.b[type][fac] || SPD.b[type].coalition; if (!rec) return false; fr = rec.base; if (rec.layers && rec.layers.head) tf = rec.layers.head[0]; }
    else if (SPD.n[type]) { rec = SPD.n[type]; fr = rec.base; }
    if (!fr) return false;
    // Umriss ohne Schatten (Deckkraft > 0.8) bestimmen und einpassen
    var x0 = -fr[5], y0 = -fr[6], x1 = x0 + fr[3], y1 = y0 + fr[4], sc = Math.min(w / (x1 - x0), h / (y1 - y0)) * 0.98;
    c.save(); c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
    var ox = w / 2 - (x0 + x1) / 2 * sc, oy = h / 2 - (y0 + y1) / 2 * sc;
    var im = typeof fr[0] === 'number' ? spImgs[fr[0]] : fr[0];
    c.drawImage(im, fr[1], fr[2], fr[3], fr[4], ox + x0 * sc, oy + y0 * sc, fr[3] * sc, fr[4] * sc);
    if (tf) {
      var px = 0, py = 0;
      if (pv && pv.pivot) { // Drehpunkt-Versatz mit der Kamera des Vorrenderns (SPD.yaw) projizieren
        var dd = Math.PI * 0.12, s0 = pv.s || 1, wx = Math.cos(dd) * pv.pivot[0] * s0, wy = Math.sin(dd) * pv.pivot[0] * s0, cyw = Math.cos(SPD.yaw), syw = Math.sin(SPD.yaw);
        px = (cyw * wx - syw * wy) * pv.p; py = (syw * wx + cyw * wy) * Math.sin(G.view.PITCH) * pv.p;
      }
      c.drawImage(typeof tf[0] === 'number' ? spImgs[tf[0]] : tf[0], tf[1], tf[2], tf[3], tf[4], ox + (px - tf[5]) * sc, oy + (py - tf[6]) * sc, tf[3] * sc, tf[4] * sc);
    }
    c.restore();
    return true;
  }
  function drawIcon(c, type, color, w, h) {
    var sp = spReady && !spFail, key = type + '|' + color + '|' + w + 'x' + h + (sp ? '|s' : ''), img = iconCache[key];
    if (!img) {
      img = document.createElement('canvas'); img.width = w; img.height = h;
      var done = false;
      try { if (sp) done = spIcon(img.getContext('2d'), type, color, w, h); } catch (e) { done = false; }
      if (!done) { img.getContext('2d').clearRect(0, 0, w, h); try { paintIcon(img.getContext('2d'), type, color, w, h); } catch (e) { console.warn('Symbol nicht gezeichnet: ' + e); } }
      iconCache[key] = img;
    }
    c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, w, h); c.drawImage(img, 0, 0, w, h); c.restore();
  }
  /** Symbole: Gebäude/Neutrale als kleiner Quader mit Merkmal, Einheiten von schräg oben. Koordinaten: 40×40 um die Mitte. */
  function paintIcon(c, type, color, w, h) {
    c.translate(w / 2, h / 2);
    var s = Math.min(w, h) / 40;
    c.scale(s, s); c.lineJoin = 'round'; c.lineCap = 'round';
    var dark = '#1f2937', ol = 'rgba(8,10,14,0.85)';
    function box(x, y, bw, bh, col) { c.fillStyle = col; c.fillRect(x, y, bw, bh); c.strokeStyle = ol; c.lineWidth = 1.2; c.strokeRect(x, y, bw, bh); }
    function circ(x, y, r, col) { c.fillStyle = col; c.beginPath(); c.arc(x, y, r, 0, 6.2832); c.fill(); c.strokeStyle = ol; c.lineWidth = 1.2; c.stroke(); }
    function elp(x, y, rx, ry, col) { c.fillStyle = col; c.beginPath(); c.ellipse(x, y, rx, ry, 0, 0, 6.2832); c.fill(); c.strokeStyle = ol; c.lineWidth = 1.2; c.stroke(); }
    function bld(x, y, bw, bh, hg, top, front) { // Quader: Oberseite (bw×bh) + Vorderwand (Höhe hg), (x,y) = linke obere Ecke der Oberseite
      c.fillStyle = 'rgba(0,0,0,0.25)'; c.fillRect(x + 3, y + hg * 0.4 + 2, bw, bh + hg);
      c.fillStyle = front; c.fillRect(x, y + bh, bw, hg); c.fillStyle = top; c.fillRect(x, y, bw, bh);
      c.strokeStyle = ol; c.lineWidth = 1.3; c.strokeRect(x, y, bw, bh + hg); c.beginPath(); c.moveTo(x, y + bh); c.lineTo(x + bw, y + bh); c.stroke();
    }
    function bolt(x, y, sc, col) { c.fillStyle = col; c.beginPath(); c.moveTo(x + 2 * sc, y - 8 * sc); c.lineTo(x - 4 * sc, y + sc); c.lineTo(x, y + sc); c.lineTo(x - 2 * sc, y + 8 * sc); c.lineTo(x + 5 * sc, y - 2 * sc); c.lineTo(x + sc, y - 2 * sc); c.closePath(); c.fill(); c.strokeStyle = ol; c.lineWidth = 0.8; c.stroke(); }
    function flagI(x, y, col) { c.strokeStyle = '#161a20'; c.lineWidth = 1.6; c.beginPath(); c.moveTo(x, y); c.lineTo(x, y - 14); c.stroke(); c.fillStyle = col; c.beginPath(); c.moveTo(x, y - 14); c.lineTo(x + 8, y - 11); c.lineTo(x, y - 7); c.closePath(); c.fill(); c.strokeStyle = ol; c.lineWidth = 0.8; c.stroke(); }
    function unitBase(rot) { c.rotate(rot); }
    if (K10U[type] || K10B[type]) {   // v1.0 Kollektiv-Symbole (PLATZHALTER v1.0)
      var kb = '#232a6b', kg = '#a5b4fc';
      switch (type) {
        case 'psiadept': elp(0, 14, 9, 4, 'rgba(0,0,0,0.3)'); circ(0, 2, 8, kb); circ(0, -8, 6, color); c.strokeStyle = kg; c.lineWidth = 2.5; c.beginPath(); c.ellipse(0, -16, 9, 3.5, 0, 0, 6.2832); c.stroke(); break;
        case 'brute': circ(0, 3, 12, kb); circ(0, -9, 7, color); box(-16, -2, 6, 10, kg); box(10, -2, 6, 10, kg); break;
        case 'gatling': elp(0, 6, 17, 9, kb); circ(0, 0, 7, color); for (var gi = -1; gi <= 1; gi++) { c.strokeStyle = '#0b1030'; c.lineWidth = 2.2; c.beginPath(); c.moveTo(3, gi * 2.5); c.lineTo(18, gi * 2.5 - 4); c.stroke(); } break;
        case 'magnet': elp(0, 6, 17, 9, kb); c.strokeStyle = '#94a3b8'; c.lineWidth = 4; c.beginPath(); c.moveTo(14, -12); c.lineTo(-4, -12); c.lineTo(-4, 4); c.lineTo(14, 4); c.stroke(); circ(0, 6, 5, color); break;
        case 'psitank': elp(0, 7, 19, 10, kb); circ(0, -2, 10, color); circ(0, -6, 5, kg); break;
        case 'psitower': bld(-10, -4, 20, 10, 10, '#323c96', kb); c.strokeStyle = '#c7d2fe'; c.lineWidth = 3; c.beginPath(); c.moveTo(0, 0); c.lineTo(0, -16); c.stroke(); c.strokeStyle = kg; c.beginPath(); c.ellipse(0, -12, 9, 3.5, 0, 0, 6.2832); c.stroke(); circ(0, -17, 3, color); break;
        case 'psidome': bld(-18, -6, 36, 14, 10, '#323c96', kb); elp(0, -4, 13, 9, kg); elp(0, -6, 7, 4, color); break;
      }
      return;
    }
    switch (type) {
      case 'hq': bld(-17, -14, 34, 16, 14, '#9aa3b3', '#6f7889'); box(-17, 2, 34, 4, color); box(-4, 6, 8, 8, dark); elp(0, -6, 7, 4, '#e8edf3'); c.fillStyle = color; c.fillRect(-1, -9, 2, 6); break;
      case 'power': bld(-18, -12, 36, 16, 12, '#8c95a4', '#68707e'); box(-18, 4, 36, 3, color); bolt(0, 11, 0.9, '#fde047'); elp(-8, -10, 6, 3, '#cfd5de'); c.fillStyle = '#cfd5de'; c.fillRect(-14, -18, 12, 8); elp(-8, -18, 6, 3, '#2a3038'); c.fillStyle = '#cfd5de'; c.fillRect(2, -18, 12, 8); elp(8, -18, 6, 3, '#2a3038'); break;
      case 'refinery': bld(-18, -10, 36, 16, 11, '#868b95', '#656b76'); box(-18, 6, 36, 3, color); c.fillStyle = '#b7b2a8'; c.fillRect(-14, -17, 14, 11); elp(-7, -6, 7, 3, '#b7b2a8'); elp(-7, -17, 7, 3, '#4b5059'); box(5, -12, 11, 10, shade(color, 0.9)); circ(10, -17, 3, '#fbbf24'); break;
      case 'barracks': bld(-16, -12, 32, 16, 12, hexMix('#7a3b30', color, 0.45), '#8d8376'); c.fillStyle = 'rgba(255,255,255,0.25)'; c.fillRect(-16, -5, 32, 2); box(-4, 8, 8, 8, dark); box(-13, 7, 6, 4, '#cfe6f5'); box(7, 7, 6, 4, '#cfe6f5'); break;
      case 'factory': bld(-18, -14, 36, 16, 14, '#8e96a3', '#6a7280'); box(-18, 2, 36, 4, color); box(-10, 6, 20, 10, '#1b2028'); box(10, -18, 5, 8, '#59616d'); break;
      case 'turret': elp(0, 4, 13, 7, '#4b5563'); c.fillStyle = '#6b7280'; c.fillRect(-13, -2, 26, 6); elp(0, -2, 10, 7, '#6b7280'); elp(0, -3, 6, 4.5, color); c.strokeStyle = '#10151b'; c.lineWidth = 5; c.beginPath(); c.moveTo(2, -4); c.lineTo(19, -9); c.stroke(); break;
      case 'mg': elp(0, 3, 13, 7, '#a39070'); c.fillStyle = '#7d6e52'; c.fillRect(-11, -1, 22, 5); elp(0, -2, 8, 6, '#8d8f94'); elp(0, -3, 5, 3.5, color); c.strokeStyle = '#10151b'; c.lineWidth = 3; c.beginPath(); c.moveTo(2, -4); c.lineTo(17, -8); c.stroke(); break;
      case 'rifle': case 'rocket': {
        c.fillStyle = 'rgba(0,0,0,0.3)'; c.beginPath(); c.ellipse(0, 14, 9, 4, 0, 0, 6.2832); c.fill();
        c.strokeStyle = type === 'rocket' ? '#8b94a0' : '#11151a'; c.lineWidth = type === 'rocket' ? 4 : 3; c.beginPath(); c.moveTo(0, -2); c.lineTo(17, type === 'rocket' ? -10 : -4); c.stroke();
        if (type === 'rocket') circ(17, -10, 2.4, '#ef4444');
        elp(0, 5, 8, 10, color); circ(0, -10, 5, '#e7c9a0'); c.fillStyle = shade(color, 0.7); c.beginPath(); c.arc(0, -11, 5.2, Math.PI, 0); c.fill(); break; }
      case 'techcenter': bld(-18, -12, 36, 16, 14, '#9aa5b8', '#6c7890'); box(-18, 4, 36, 4, color); box(-4, 8, 8, 8, dark); box(-14, 7, 6, 4, '#9fd0ee'); box(8, 7, 6, 4, '#9fd0ee'); elp(-8, -6, 7, 4, '#bfe3f5'); c.strokeStyle = '#4b5059'; c.lineWidth = 2; c.beginPath(); c.moveTo(9, -4); c.lineTo(9, -13); c.stroke(); elp(9, -15, 6, 3.4, '#e9ecef'); circ(15, -18, 1.8, '#ef4444'); break;
      case 'orbital': bld(-17, -4, 34, 14, 10, '#aab6c9', '#7885a0'); box(-17, 10, 34, 3, color); box(-16, -2, 9, 7, '#1e3a8a'); box(7, -2, 9, 7, '#1e3a8a'); elp(0, 2, 7, 4, '#cfd8e6'); c.fillStyle = '#e5ecf6'; c.fillRect(-2.5, -20, 5, 22); c.strokeStyle = ol; c.lineWidth = 1; c.strokeRect(-2.5, -20, 5, 22); circ(0, -22, 4.6, '#7dd3fc'); circ(0, -22, 2, '#ffffff'); break;
      case 'silo': bld(-17, -4, 34, 14, 10, '#6f6c5a', '#4d4b3e'); box(-17, 10, 34, 3, color); box(-13, -1, 12, 9, '#585a50'); box(1, -1, 12, 9, '#585a50'); c.fillStyle = '#facc15'; for (var hs = 0; hs < 4; hs++) c.fillRect(-15 + hs * 9, 13, 4, 3); c.fillStyle = '#d6d9de'; c.fillRect(-4, -14, 8, 14); c.fillStyle = '#ef4444'; c.beginPath(); c.moveTo(-4, -14); c.lineTo(0, -22); c.lineTo(4, -14); c.closePath(); c.fill(); c.strokeStyle = ol; c.lineWidth = 1; c.strokeRect(-4, -14, 8, 14); break;
      case 'engineer': {
        c.fillStyle = 'rgba(0,0,0,0.3)'; c.beginPath(); c.ellipse(0, 14, 9, 4, 0, 0, 6.2832); c.fill();
        c.strokeStyle = '#6b7280'; c.lineWidth = 3; c.beginPath(); c.moveTo(-4, 0); c.lineTo(-13, -9); c.stroke();
        box(7, 3, 13, 10, '#d97706'); box(7, 7, 13, 2, '#facc15'); c.strokeStyle = '#1f2937'; c.lineWidth = 1.6; c.beginPath(); c.moveTo(11, 3); c.lineTo(11, 0); c.lineTo(16, 0); c.lineTo(16, 3); c.stroke();
        elp(0, 5, 8, 10, color); box(-7, 3, 14, 3, '#f59e0b'); circ(0, -10, 5, '#e7c9a0'); c.fillStyle = '#facc15'; c.beginPath(); c.arc(0, -11, 6, Math.PI, 0); c.fill(); c.strokeStyle = ol; c.lineWidth = 1; c.stroke(); break; }
      case 'howitzer': c.translate(0, 3); c.fillStyle = 'rgba(0,0,0,0.3)'; c.beginPath(); c.ellipse(1, 11, 20, 5, 0, 0, 6.2832); c.fill(); box(-20, 3, 40, 9, '#1c2128'); box(-20, -8, 40, 13, '#2a3038'); box(-17, -6, 34, 9, color); box(-19, -4, 3, 8, '#10151b'); elp(-3, -3, 8, 6, shade(color, 0.8)); c.strokeStyle = '#10151b'; c.lineWidth = 5; c.beginPath(); c.moveTo(-3, -4); c.lineTo(21, -20); c.stroke(); c.strokeStyle = '#2b323b'; c.lineWidth = 7; c.beginPath(); c.moveTo(17, -17.5); c.lineTo(21, -20); c.stroke(); box(1, -9, 5, 12, shade(color, 1.12)); break;
      case 'hunter': c.translate(0, 3); c.fillStyle = 'rgba(0,0,0,0.3)'; c.beginPath(); c.ellipse(1, 11, 21, 5, 0, 0, 6.2832); c.fill(); box(-21, 3, 42, 9, '#1c2128'); box(-21, -8, 42, 13, '#2a3038'); box(-18, -6, 36, 9, color); c.fillStyle = shade(color, 1.1); c.beginPath(); c.moveTo(-11, -4); c.lineTo(5, -6); c.lineTo(11, -2); c.lineTo(5, 3); c.lineTo(-11, 3); c.closePath(); c.fill(); c.strokeStyle = ol; c.lineWidth = 1.2; c.stroke(); c.strokeStyle = '#10151b'; c.lineWidth = 3.4; c.beginPath(); c.moveTo(6, -2); c.lineTo(30, -7); c.stroke(); c.lineWidth = 5.4; c.beginPath(); c.moveTo(26, -6); c.lineTo(30, -7); c.stroke(); break;
      case 'colossus': c.translate(0, 3); c.fillStyle = 'rgba(0,0,0,0.3)'; c.beginPath(); c.ellipse(1, 12, 22, 5.5, 0, 0, 6.2832); c.fill(); box(-22, 1, 44, 12, '#1c2128'); box(-22, -12, 44, 15, '#2a3038'); box(-19, -10, 38, 12, color); c.strokeStyle = '#10151b'; c.lineWidth = 4.4; c.beginPath(); c.moveTo(2, -9); c.lineTo(25, -15); c.moveTo(2, -2); c.lineTo(25, -8); c.stroke(); box(-12, -13, 20, 15, shade(color, 1.12)); circ(-3, -5, 4, shade(color, 0.7)); break;
      case 'scout': case 'raider': c.translate(0, 3); c.fillStyle = 'rgba(0,0,0,0.3)'; c.beginPath(); c.ellipse(1, 10, 18, 5, 0, 0, 6.2832); c.fill(); box(-17, -2, 7, 5, '#0e1114'); box(10, -2, 7, 5, '#0e1114'); box(-18, 4, 36, 8, shade(color, 0.5)); box(-18, -10, 36, 14, color); box(-6, -8, 10, 10, dark); c.strokeStyle = '#10151b'; c.lineWidth = 3; c.beginPath(); c.moveTo(0, -4); c.lineTo(17, -7); c.stroke(); break;
      case 'tank': c.translate(0, 3); c.fillStyle = 'rgba(0,0,0,0.3)'; c.beginPath(); c.ellipse(1, 11, 20, 5, 0, 0, 6.2832); c.fill(); box(-20, 2, 40, 10, '#1c2128'); box(-20, -10, 40, 14, '#2a3038'); box(-17, -8, 34, 10, color); c.strokeStyle = '#10151b'; c.lineWidth = 5; c.beginPath(); c.moveTo(2, -4); c.lineTo(22, -9); c.stroke(); elp(0, -4, 9, 7, shade(color, 1.12)); break;
      case 'harvester': c.translate(0, 3); c.fillStyle = 'rgba(0,0,0,0.3)'; c.beginPath(); c.ellipse(1, 11, 20, 5, 0, 0, 6.2832); c.fill(); box(-20, 2, 40, 10, '#1c2128'); box(-20, -10, 40, 14, '#2a3038'); box(-17, -8, 20, 10, '#44403c'); c.fillStyle = '#e8c547'; c.fillRect(-16, -6, 18, 6); box(6, -8, 11, 10, color); break;
      case 'wall':
        bld(-19, -3, 38, 6, 9, '#b9b7ae', '#8b8982');
        for (var wp = 0; wp < 3; wp++) { var wxx = -20 + wp * 16; bld(wxx, -7, 9, 8, 15, '#c4c2b9', '#8b8982'); c.fillStyle = color; c.fillRect(wxx, 3, 9, 4); c.strokeStyle = ol; c.lineWidth = 1; c.strokeRect(wxx, 3, 9, 4); }
        break;
      case 'pbunker':
        bld(-18, -10, 36, 18, 12, '#a2a198', '#7b7a72'); c.fillStyle = '#8f8e86'; c.fillRect(-14, -7, 28, 12); box(-14, -7, 8, 6, shade(color, 0.85)); elp(6, -1, 5, 3.4, '#6e6d66');
        box(-18, 8, 36, 3, color); c.fillStyle = '#0d0f12'; c.fillRect(-15, 13, 9, 3); c.fillRect(-4, 13, 8, 3); c.fillRect(7, 13, 9, 3);
        break;
      case 'laser':
        c.translate(0, 5); c.scale(0.84, 0.84);
        bld(-17, 2, 34, 14, 7, '#9ba1ab', '#6e7480'); box(-17, 16, 34, 3, color);
        c.fillStyle = '#7b838f'; c.beginPath(); c.moveTo(-11, 5); c.lineTo(-3, -14); c.lineTo(3, -14); c.lineTo(11, 5); c.closePath(); c.fill(); c.strokeStyle = ol; c.lineWidth = 1.1; c.stroke();
        box(-3, -14, 6, 19, '#c9ced6'); box(-3, -2, 6, 3, color); elp(0, -16, 7.5, 5, '#d3d8df'); elp(0, -17, 4.2, 2.8, color);
        c.strokeStyle = '#161b22'; c.lineWidth = 5; c.beginPath(); c.moveTo(0, -17); c.lineTo(14, -22); c.stroke(); circ(14, -22, 3.2, '#ff6a5a'); circ(14, -22, 1.4, '#ffffff');
        break;
      case 'tesla':
        c.translate(0, 5); c.scale(0.84, 0.84);
        bld(-17, 2, 34, 14, 7, '#8a7f72', '#5f564c'); box(-17, 16, 34, 3, color);
        c.fillStyle = '#5b3f31'; c.beginPath(); c.moveTo(-9, 4); c.lineTo(-3.5, -14); c.lineTo(3.5, -14); c.lineTo(9, 4); c.closePath(); c.fill(); c.strokeStyle = ol; c.lineWidth = 1.1; c.stroke();
        c.strokeStyle = '#d58f58'; c.lineWidth = 2.4; for (var tr = 0; tr < 4; tr++) { var tyy = 1 - tr * 4.4, trx = 8 - tr * 1.6; c.beginPath(); c.ellipse(0, tyy, trx, trx * 0.4, 0, 0, Math.PI); c.stroke(); }
        c.strokeStyle = '#3a3f47'; c.lineWidth = 2.4; c.beginPath(); c.moveTo(-15, 3); c.lineTo(-15, -12); c.moveTo(15, 3); c.lineTo(15, -12); c.stroke(); circ(-15, -13, 2.4, '#d6dbe3'); circ(15, -13, 2.4, '#d6dbe3');
        c.strokeStyle = '#d6dbe3'; c.lineWidth = 3; c.beginPath(); c.ellipse(0, -15, 8, 3.2, 0, 0, 6.2832); c.stroke();
        c.fillStyle = 'rgba(150,170,255,0.4)'; c.beginPath(); c.arc(0, -19, 8, 0, 6.2832); c.fill(); circ(0, -19, 4, '#a5b4ff');
        c.strokeStyle = '#eef1ff'; c.lineWidth = 1.5; c.beginPath(); c.moveTo(3, -20); c.lineTo(8, -17); c.lineTo(10, -22); c.lineTo(15, -13); c.moveTo(-3, -20); c.lineTo(-8, -17); c.lineTo(-10, -22); c.lineTo(-15, -13); c.stroke();
        break;
      // ---- v0.7 Einheiten
      case 'sniper': {
        c.fillStyle = 'rgba(0,0,0,0.3)'; c.beginPath(); c.ellipse(0, 14, 9, 4, 0, 0, 6.2832); c.fill();
        c.strokeStyle = '#0d1014'; c.lineWidth = 2.6; c.beginPath(); c.moveTo(-9, -1); c.lineTo(24, -11); c.stroke(); c.strokeStyle = '#6b7380'; c.lineWidth = 1; c.stroke();
        box(3, -8, 6, 3, '#1b2026'); box(12, -11, 3, 3, '#9ec5e0');
        elp(0, 5, 6.6, 10, hexMix(color, '#cfd6de', 0.5)); box(-6.6, 1, 13.2, 2.2, color);
        circ(0, -10, 5, '#e7c9a0'); c.fillStyle = '#aeb6c0'; c.beginPath(); c.arc(0, -11, 6.2, Math.PI * 0.95, Math.PI * 2.05); c.fill(); c.strokeStyle = ol; c.lineWidth = 1; c.stroke(); c.fillStyle = color; c.fillRect(-5.5, -11.5, 11, 1.8); break; }
      case 'flamer': {
        c.fillStyle = 'rgba(0,0,0,0.3)'; c.beginPath(); c.ellipse(0, 14, 11, 4.5, 0, 0, 6.2832); c.fill();
        elp(-9, 0, 5, 10, '#9b241c'); c.fillStyle = 'rgba(255,255,255,0.25)'; c.fillRect(-11, -6, 2, 10);
        c.strokeStyle = '#161a20'; c.lineWidth = 1.8; c.beginPath(); c.moveTo(-9, 4); c.quadraticCurveTo(-2, 10, 6, 0); c.stroke();
        c.strokeStyle = '#2b323b'; c.lineWidth = 5; c.beginPath(); c.moveTo(2, -1); c.lineTo(19, -5); c.stroke(); c.strokeStyle = '#8b94a0'; c.lineWidth = 1.5; c.stroke();
        c.fillStyle = 'rgba(255,150,40,0.9)'; c.beginPath(); c.ellipse(22, -9, 3.4, 5.4, 0.3, 0, 6.2832); c.fill(); c.fillStyle = 'rgba(255,240,170,0.95)'; c.beginPath(); c.ellipse(22, -8, 1.5, 2.8, 0.3, 0, 6.2832); c.fill();
        elp(0, 5, 9.5, 10.5, hexMix(color, '#4d5230', 0.42)); box(-9.5, 3, 19, 2.4, color);
        circ(0, -10, 5.4, '#3a3d32'); c.fillStyle = '#d8cf9a'; c.beginPath(); c.arc(-2.2, -10.5, 1.3, 0, 6.2832); c.arc(2.2, -10.5, 1.3, 0, 6.2832); c.fill(); break; }
      case 'medic': {
        c.fillStyle = 'rgba(0,0,0,0.3)'; c.beginPath(); c.ellipse(0, 14, 9, 4, 0, 0, 6.2832); c.fill();
        box(7, 3, 14, 11, '#f1f5f9'); c.fillStyle = '#16a34a'; c.fillRect(12.4, 5, 3.2, 7); c.fillRect(9.4, 7.1, 9.2, 3.2);
        elp(0, 5, 8, 10, hexMix(color, '#f4f6f8', 0.62)); box(-8, 2, 16, 2.2, color); c.fillStyle = '#16a34a'; c.fillRect(-1.6, 0, 3.2, 9); c.fillRect(-4.6, 2.9, 9.2, 3.2);
        circ(0, -10, 5, '#e7c9a0'); c.fillStyle = '#f1f5f9'; c.beginPath(); c.arc(0, -11, 5.8, Math.PI, 0); c.fill(); c.strokeStyle = ol; c.lineWidth = 1; c.stroke(); c.fillStyle = '#16a34a'; c.fillRect(-0.9, -16, 1.8, 4.6); c.fillRect(-2.3, -14.6, 4.6, 1.8); break; }
      case 'apc': {
        var ah = mixHex(color, '#d7dce3', 0.58);
        c.translate(0, 3); c.fillStyle = 'rgba(0,0,0,0.3)'; c.beginPath(); c.ellipse(1, 11, 21, 5, 0, 0, 6.2832); c.fill();
        c.fillStyle = '#0e1114'; for (var aw = 0; aw < 4; aw++) c.fillRect(-16 + aw * 10.5, 6, 6, 6);
        c.fillStyle = shade(ah, 0.5); c.fillRect(-20, 1, 40, 8); c.fillStyle = ah; c.beginPath(); c.moveTo(-20, -9); c.lineTo(12, -10); c.lineTo(21, -5); c.lineTo(21, 4); c.lineTo(-20, 4); c.closePath(); c.fill(); c.strokeStyle = ol; c.lineWidth = 1.3; c.stroke();
        box(-19, -4, 30, 2.4, color); c.fillStyle = 'rgba(30,50,90,0.5)'; c.fillRect(-16, -8, 12, 5);
        c.strokeStyle = '#10151b'; c.lineWidth = 2.6; c.beginPath(); c.moveTo(6, -9); c.lineTo(21, -13); c.stroke(); elp(5, -9, 7, 5, shade(ah, 1.08)); break; }
      case 'lasertank': {
        var lh = mixHex(color, '#d7dce3', 0.58);
        c.translate(0, 3); c.fillStyle = 'rgba(0,0,0,0.3)'; c.beginPath(); c.ellipse(1, 11, 22, 5, 0, 0, 6.2832); c.fill();
        box(-21, 2, 42, 10, '#1c2128'); box(-21, -10, 42, 14, '#2a3038'); box(-21, -10, 42, 5, shade(lh, 0.8)); box(-21, 0, 42, 4, shade(lh, 0.8));
        c.fillStyle = lh; c.beginPath(); c.moveTo(-18, -5); c.lineTo(14, -5); c.lineTo(20, -3); c.lineTo(20, 2); c.lineTo(14, 0); c.lineTo(-18, 0); c.closePath(); c.fill(); box(-17, -3, 30, 1.8, color);
        c.fillStyle = 'rgba(120,205,255,0.9)'; c.fillRect(8, -9, 6, 1.8); c.fillRect(8, 2, 6, 1.8);
        c.strokeStyle = '#2b323b'; c.lineWidth = 4; c.beginPath(); c.moveTo(6, -6); c.lineTo(28, -12); c.stroke(); c.strokeStyle = 'rgba(140,215,255,0.9)'; c.lineWidth = 1.2; c.stroke();
        c.fillStyle = shade(lh, 1.06); c.beginPath(); c.moveTo(-9, -4); c.lineTo(3, -12); c.lineTo(10, -8); c.lineTo(10, -3); c.lineTo(3, 1); c.lineTo(-9, 0); c.closePath(); c.fill(); c.strokeStyle = ol; c.lineWidth = 1.2; c.stroke();
        circ(28, -12, 3.6, '#ff6a5a'); circ(28, -12, 1.5, '#ffffff'); break; }
      case 'mlrs': {
        var mh = mixHex(color, '#59603a', 0.66);
        c.translate(0, 3); c.fillStyle = 'rgba(0,0,0,0.3)'; c.beginPath(); c.ellipse(1, 11, 23, 5.5, 0, 0, 6.2832); c.fill();
        c.fillStyle = '#0e1114'; c.fillRect(-18, 6, 8, 7); c.fillRect(-8, 6, 8, 7); c.fillRect(9, 6, 8, 7);
        box(-22, 1, 33, 9, shade(mh, 0.5)); box(-22, -4, 33, 7, shade(mh, 0.82)); box(10, -9, 13, 17, shade(mh, 0.6)); box(10, -13, 13, 10, shade(mh, 1.12)); box(20, -12, 3, 8, '#8fb3c8'); box(11, -9, 7, 2, color);
        for (var mr = 0; mr < 2; mr++) for (var mk = 0; mk < 3; mk++) { box(-19, -16 + mr * 4 + mk * 3, 28, 3.4, mr ? '#4a5238' : '#3a4130'); }
        c.fillStyle = '#ef4444'; for (var mn = 0; mn < 3; mn++) { c.beginPath(); c.arc(8, -14.5 + mn * 3, 1.5, 0, 6.2832); c.fill(); } break; }
      case 'shocktank': {
        var sh = mixHex(color, '#59603a', 0.66);
        c.translate(0, 4); c.fillStyle = 'rgba(0,0,0,0.3)'; c.beginPath(); c.ellipse(1, 11, 23, 5.5, 0, 0, 6.2832); c.fill();
        box(-22, 1, 44, 11, '#1c2128'); box(-22, -12, 44, 15, '#2a3038'); box(-19, -9, 38, 9, sh); box(13, -9, 5, 9, color);
        c.fillStyle = '#c9d4ff'; c.beginPath(); c.arc(24, -6, 2, 0, 6.2832); c.arc(24, -1, 2, 0, 6.2832); c.fill();
        c.fillStyle = shade(sh, 1.12); c.beginPath(); c.moveTo(-11, -4); c.lineTo(-6, -10); c.lineTo(7, -10); c.lineTo(12, -4); c.lineTo(12, 2); c.lineTo(7, 6); c.lineTo(-6, 6); c.lineTo(-11, 2); c.closePath(); c.fill(); c.strokeStyle = ol; c.lineWidth = 1.3; c.stroke();
        c.fillStyle = '#5b3f31'; c.beginPath(); c.moveTo(-6, -8); c.lineTo(-2.5, -24); c.lineTo(2.5, -24); c.lineTo(6, -8); c.closePath(); c.fill(); c.stroke();
        c.strokeStyle = '#d58f58'; c.lineWidth = 2; for (var sr = 0; sr < 4; sr++) { c.beginPath(); c.ellipse(0, -10 - sr * 3.6, 5.6 - sr * 0.8, 2.2, 0, 0, Math.PI); c.stroke(); }
        c.fillStyle = 'rgba(150,170,255,0.4)'; c.beginPath(); c.arc(0, -27, 7, 0, 6.2832); c.fill(); circ(0, -27, 3.4, '#b8c4ff');
        c.strokeStyle = '#eef1ff'; c.lineWidth = 1.4; c.beginPath(); c.moveTo(4, -28); c.lineTo(9, -25); c.lineTo(11, -30); c.lineTo(16, -22); c.stroke(); break; }
      case 'mcv': c.translate(0, 3); c.fillStyle = 'rgba(0,0,0,0.3)'; c.beginPath(); c.ellipse(1, 12, 23, 5.5, 0, 0, 6.2832); c.fill(); box(-23, 2, 46, 11, '#1c2128'); box(-23, -10, 46, 14, '#2a3038'); box(-20, -8, 40, 11, color);
        box(11, -10, 9, 13, shade(color, 1.12)); box(17, -8, 3, 9, '#9ec5e0'); box(-18, -16, 28, 13, '#6f7684'); c.fillStyle = '#facc15'; for (var mh = 0; mh < 4; mh++) { c.beginPath(); c.moveTo(-16 + mh * 7, -16); c.lineTo(-12 + mh * 7, -16); c.lineTo(-14 + mh * 7, -12); c.lineTo(-18 + mh * 7, -12); c.closePath(); c.fill(); }
        c.fillStyle = color; c.fillRect(-18, -10, 28, 3); c.strokeStyle = '#d97706'; c.lineWidth = 2.4; c.beginPath(); c.moveTo(-15, -4); c.lineTo(9, -4); c.stroke(); circ(-15, -4, 2.6, '#2b323b'); break;
      // ---- neutrale Gebäude
      case 'house': bld(-15, -12, 30, 14, 14, '#a4604a', '#d6cbad'); c.fillStyle = 'rgba(255,255,255,0.22)'; c.fillRect(-15, -5, 30, 2); box(-11, 5, 7, 6, '#6fa6c4'); box(4, 5, 7, 6, '#6fa6c4'); box(-3, 8, 6, 8, '#5a4332'); flagI(12, -12, BEIGE); break;
      case 'block': bld(-17, -16, 34, 12, 24, '#a6a8a3', '#d3c9ac'); for (var r = 0; r < 3; r++) for (var q = 0; q < 4; q++) box(-14 + q * 8, -2 + r * 7, 5, 4, '#6fa6c4'); box(-3, 12, 6, 6, '#5a4332'); flagI(14, -16, BEIGE); break;
      case 'bunker': bld(-17, -8, 34, 16, 8, '#8e918a', '#a6a8a3'); box(-12, 12, 24, 3, '#1b2026'); c.fillStyle = '#b39d72'; for (var bi = 0; bi < 5; bi++) { c.beginPath(); c.ellipse(-13 + bi * 6.5, 11, 4, 2.6, 0, 0, 6.2832); c.fill(); } flagI(14, -8, BEIGE); break;
      case 'oilrig': bld(-16, 2, 32, 12, 6, '#3b4249', '#2b3035'); c.strokeStyle = '#d97706'; c.lineWidth = 2.4; c.beginPath(); c.moveTo(-9, 4); c.lineTo(0, -18); c.lineTo(9, 4); c.moveTo(-6, -3); c.lineTo(6, -3); c.moveTo(-4, -9); c.lineTo(4, -9); c.stroke(); box(-3, -21, 6, 5, '#111827'); c.strokeStyle = '#1f2937'; c.lineWidth = 3.5; c.beginPath(); c.moveTo(6, 8); c.lineTo(15, 5); c.stroke(); flagI(-14, 2, BEIGE); break;
      case 'radar': bld(-14, -2, 28, 14, 10, '#a6a8a3', '#c9cdc9'); box(-14, 12, 28, 2, '#2f9e5a'); c.strokeStyle = '#4b5059'; c.lineWidth = 2.6; c.beginPath(); c.moveTo(0, 2); c.lineTo(0, -10); c.stroke(); c.fillStyle = '#e9ecef'; c.beginPath(); c.ellipse(0, -14, 11, 7, -0.4, 0, 6.2832); c.fill(); c.strokeStyle = ol; c.lineWidth = 1.2; c.stroke(); circ(0, -14, 2, '#5b636c'); flagI(12, -2, BEIGE); break;
      case 'hospital': bld(-18, -10, 36, 14, 12, '#e9edf0', '#d8dee3'); box(-18, 4, 36, 3, '#dc2626'); c.fillStyle = '#dc2626'; c.fillRect(-2.5, -9, 5, 12); c.fillRect(-6, -5, 12, 5); box(-12, 8, 6, 5, '#7fb7d6'); box(6, 8, 6, 5, '#7fb7d6'); flagI(15, -10, BEIGE); break;
      case 'workshop': bld(-18, -10, 36, 14, 14, '#8d9399', '#a7acb1'); box(-18, 4, 36, 3, '#d97706'); box(-12, 8, 17, 10, '#232930'); circ(11, -3, 6, '#d97706'); circ(11, -3, 2.6, '#8d9399'); c.strokeStyle = '#e5e7eb'; c.lineWidth = 2.4; c.beginPath(); c.moveTo(-14, -8); c.lineTo(-14, -17); c.lineTo(-4, -17); c.stroke(); flagI(15, -10, BEIGE); break;
      case 'artillery': bld(-16, -4, 32, 16, 6, '#b39d72', '#8f7d58'); elp(0, 4, 10, 6, '#9d8a63'); c.strokeStyle = '#1b2026'; c.lineWidth = 5.5; c.beginPath(); c.moveTo(0, 2); c.lineTo(17, -12); c.stroke(); circ(0, 2, 6, '#3b4249'); flagI(-14, -4, BEIGE); break;
      case 'dreadnought': {   // v0.9 Schlachtschiff: Seitenansicht – langer Rumpf, Brücke, Werfer mit erhobenen Schienen und zwei Raketen
        c.fillStyle = 'rgba(40,110,170,0.55)'; c.beginPath(); c.ellipse(0, 10, 21, 5, 0, 0, 6.2832); c.fill();
        c.fillStyle = '#7c8792'; c.beginPath(); c.moveTo(-21, 2); c.lineTo(14, 2); c.lineTo(22, -1); c.lineTo(17, 10); c.lineTo(-19, 10); c.closePath(); c.fill(); c.strokeStyle = ol; c.lineWidth = 1.2; c.stroke();
        c.fillStyle = color; c.fillRect(-19, 3, 33, 2);
        box(-16, -3, 14, 5, '#b7bec6'); box(-11, -9, 7, 6, '#9aa3ad'); c.fillStyle = color; c.fillRect(-11, -9, 7, 1.6);
        c.strokeStyle = '#2b3138'; c.lineWidth = 1.4; c.beginPath(); c.moveTo(-7.5, -9); c.lineTo(-7.5, -15); c.stroke();
        circ(5, 0, 3.4, '#4b545e');
        c.save(); c.translate(5, -1); c.rotate(-0.62);
        box(-2, -2.6, 17, 5.2, '#59616b');
        c.fillStyle = '#eef0f2'; c.fillRect(1, -2.2, 13, 1.8); c.fillRect(1, 0.6, 13, 1.8);
        c.fillStyle = '#c0392b'; c.fillRect(13, -2.2, 2.5, 1.8); c.fillRect(13, 0.6, 2.5, 1.8);
        c.restore();
        break; }
      // ---- v0.8 Symbole (Luft/See/Flugfeld/Werft/Flak) – Vektor-Rückfall, sonst Sprite-Symbole
      case 'transheli': case 'gunship': case 'bomber': {
        c.fillStyle = 'rgba(0,0,0,0.28)'; c.beginPath(); c.ellipse(2, 15, 16, 4, 0, 0, 6.2832); c.fill();
        if (type === 'bomber') {
          c.fillStyle = shade(color, 0.6); c.beginPath(); c.moveTo(4, -2); c.lineTo(-8, -16); c.lineTo(-12, -16); c.lineTo(-7, 0); c.lineTo(-12, 14); c.lineTo(-8, 14); c.closePath(); c.fill(); c.strokeStyle = ol; c.lineWidth = 1.2; c.stroke();
          c.fillStyle = color; c.beginPath(); c.moveTo(-19, -3); c.lineTo(13, -3); c.lineTo(20, 0); c.lineTo(13, 3); c.lineTo(-19, 3); c.closePath(); c.fill(); c.stroke();
        } else {
          box(-6, -4, 22, 8, color); box(-20, -1.5, 15, 3, shade(color, 0.6));
          if (type === 'gunship') { box(-2, -10, 6, 20, '#374151'); }
          c.strokeStyle = 'rgba(20,24,30,0.85)'; c.lineWidth = 2.2; c.beginPath(); c.moveTo(-14, -13); c.lineTo(18, -9); c.moveTo(-10, -6); c.lineTo(14, -16); c.stroke();
          if (type === 'transheli') { c.beginPath(); c.moveTo(-20, -9); c.lineTo(-4, -14); c.stroke(); }
        }
        break; }
      case 'gunboat': case 'destroyer': case 'lander': {
        c.fillStyle = 'rgba(40,110,170,0.55)'; c.beginPath(); c.ellipse(0, 8, 21, 6, 0, 0, 6.2832); c.fill();
        var hc = type === 'lander' ? '#6b7a5e' : '#6b7280', L8 = type === 'destroyer' ? 20 : 16;
        c.fillStyle = hc; c.beginPath(); c.moveTo(-L8, -2); c.lineTo(L8 - 5, -2); c.lineTo(L8 + 3, 4); c.lineTo(L8 - 5, 9); c.lineTo(-L8, 9); c.closePath(); c.fill(); c.strokeStyle = ol; c.lineWidth = 1.2; c.stroke();
        box(-L8 + 4, -6, type === 'lander' ? 6 : 12, 5, color);
        if (type !== 'lander') { c.strokeStyle = '#1f2937'; c.lineWidth = 2.6; c.beginPath(); c.moveTo(L8 - 8, -3); c.lineTo(L8 + 4, -7); c.stroke(); circ(L8 - 8, -2, 3.2, '#374151'); }
        if (type === 'destroyer') { c.beginPath(); c.moveTo(-L8 + 2, -3); c.lineTo(-L8 - 6, -7); c.stroke(); circ(-L8 + 3, -2, 3.2, '#374151'); }
        break; }
      case 'airfield':
        bld(-19, -10, 38, 18, 4, '#7b8290', '#5c6370'); box(-17, -6, 34, 9, '#3b4048');
        for (var hp8 = 0; hp8 < 4; hp8++) circ(-12.5 + hp8 * 8.4, -1.5, 3.2, '#e5e7eb');
        box(-19, 8, 38, 3, color); break;
      case 'shipyard':
        c.fillStyle = 'rgba(40,110,170,0.6)'; c.fillRect(-20, 4, 40, 12);
        bld(-18, -10, 26, 14, 8, '#8a8f98', '#646a74'); box(-15, -7, 16, 7, '#1e3a5f'); box(-18, 12, 26, 2.5, color);
        c.strokeStyle = '#f59e0b'; c.lineWidth = 2.4; c.beginPath(); c.moveTo(12, 10); c.lineTo(12, -16); c.lineTo(-6, -16); c.stroke(); break;
      case 'flak':
        bld(-10, -4, 20, 10, 8, '#7c8794', '#5b6571'); circ(0, 0, 4.5, color);
        c.strokeStyle = '#111827'; c.lineWidth = 3; c.beginPath(); c.moveTo(-3, -1); c.lineTo(6, -16); c.moveTo(3, 0); c.lineTo(12, -15); c.stroke(); break;
    }
    void unitBase;
  }

  // ------------------------------------------------------------------ Schnittstelle
  var QUALITIES = [['modern', 'Modern'], ['pixel', 'Pixel-Look'], ['sharp', 'Scharf'], ['low', 'Sparmodus'], ['sprite', 'Sprite (stabil)'], ['2d', '2D (sicher)']];
  function setQuality(q) {
    // Die Wahl wird gemerkt: 'sprite' / '2d' wirken sofort (gleicher Renderer, nur der Boden unterscheidet sich), ein 3D-Wert ab dem nächsten Seitenstart.
    try { localStorage.setItem(QKEY, q); } catch (e) { /* egal */ }
    if (q === 'sprite' || q === '2d') { if (MODE !== q) { MODE = q; if (world && G.Sim.S) buildWorld(); } return; }
    if (G.UI && G.UI.toast) G.UI.toast('3D-Grafik wird nach dem Neuladen der Seite aktiv');
  }
  function info() {
    return { calls: 0, triangles: 0, points: 0, lines: 0, ms: frameMs, quality: MODE, sprites: spReady ? (spOn() ? 'aktiv' : 'geladen') : (spFail ? 'fehlen' : 'laden'), groundMs: world ? world.groundMs : 0, buf: [cv ? cv.width : 0, cv ? cv.height : 0], particles: fxN };
  }

  G.Render2D = {
    _glCreates: function () { return 0; }, gpu: function () { return { name: '2D Canvas', safe: true }; }, _setSafe: function () { },
    restartGL: function () { }, glOK: function () { return true; }, init: init, reset: reset, draw: draw, drawIcon: drawIcon,
    miniToWorld: miniToWorld, resize: resize, pickAt: pickAt, setQuality: setQuality, getQuality: function () { return MODE; }, info: info,
    QUALITIES: QUALITIES, _heightAt: function () { return 0; }, _fxTime: function () { return fxTime; }, is2D: true,
    _prof: function (on) { if (on != null) { profOn = !!on; profA = [0, 0, 0, 0, 0, 0, 0, 0]; profN = 0; } return { n: profN, ms: profA.map(function (v) { return +(v / Math.max(1, profN)).toFixed(2); }), labels: ['Boden', 'Erz/Props', 'Sortieren', 'Körper', 'Projektile/FX', 'Nebel', 'Overlay+Mini'] }; },
    _spOff: function (off) { spFail = !!off; if (!off && SPD) spFail = false; },
    _ramp: function (id) { rampT[id] = fxTime; },   // v0.8 Test: Bugklappe öffnen
    _view: function () { setView(); return { yaw: YAWA, rot: ROT, kx: kx, ky: ky, m: [MOX, MOY, MUA, MUB, MVA, MVB] }; }
  };
})();
