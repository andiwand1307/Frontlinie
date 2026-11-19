/* FRONTLINIE – r3-models.js  (v0.6: aus render3d.js ausgelagert)  →  G.R3M
 * Besitzt: Modell-Fabrik model() für JEDE Einheit/jedes Gebäude (Geometrie + Teile-Layout), Paletten/Teamfarben,
 *   Material-Fabrik (Lambert für Pixel/Scharf/Spar, MeshStandardMaterial für Modern), Instanz-Verwaltung je (Typ, Besitzer, Teil),
 *   Zustand + Animation je Entität (Türme, Rückstoß, Aufbau, Bauhof-Aufbau, Mauer-Verbindungen, Neutrale, Wracks), Platzierungsvorschau.
 * Kontext: G.R3 (vom Kern render3d.js befüllt): R.THREE, R.scene, R.camera, R.dynRoot, R.Q, R.std/R.post/R.lite, R.safeGPU, R.t (Effektzeit s),
 *   R.dt, R.V (G.view), R.hash/clamp/lerpAng/smooth/rnd, R.fowify, R.visibleAt, R.inView, R.selRing/R.selSquare (Auswahl-Batches des Kerns).
 * Exporte (G.R3M) – vom Kern/anderen Modulen benutzt:
 *   link()                     Querverweise auf G.R3T/G.R3F binden (einmal in Render.init)
 *   makeMaterials()            Materialien für aktuelle Qualität (neu) anlegen; bestehende Batches werden umgehängt
 *   material(kind, opts)       Fabrik: 'std' | 'ore' | 'terrain' {map} | 'water-lite' | 'tint' {color} | 'emis' | 'ghost'
 *   MAT                        { std, ore, glow, emis, ring, marker, ghost, foot, ghostW, footW } (Objekt bleibt, Inhalte wechseln)
 *   SURF, surfOf(col)          Oberflächen-Tabelle [roughness, metalness] und Zuordnung Farbe → Oberfläche (für Modern)
 *   MB, Batch, batch(key, geoFn, mat, cap, shadow), partBatch(kind, type, owner, part, M)
 *   model(type, fac, color), unitModelOf(e), facOfColor(color), isBld(type), teamRGB(color)
 *   NEUT, GARR, BH, SCALE, INF, neutralShown(e, P, fogOff), nst(id), rs (Map je Einheit), addWreck(w), muzzleOf(src, out, tx, tz, barrel)
 *   W11: Gebäude-Modelle (außer Mauer) sind an x gespiegelt (mirrorModel, M.mir/M.mirA) – Fronten zeigen nach Süd + West (Kamera YAW = −π/4)
 *   deployEvt(e), fill(S, alpha, dt, selSet), flush(), reset(), getFlagModel(), ruinModel(w, h)
 *   Bewegung (Abschnitt „Bewegung“ vor fill()): Bodenfahrzeuge hängen an einer gefederten Basis (Nicken beim Anfahren/Bremsen, Wanken in Kurven,
 *   Rückstoß, Trefferruck, Geländeneigung; vehDyn + Batch.putM/putMS), Infanterie hat das Zusatzteil 'leg' (M.xparts.leg, infLegs; Schritt/Knien/Fallen:
 *   drawInf/drawFall, Wrack-Art 'fall'). Zustand je Einheit in rs (vf, yr, pv/pw, rl/rw, gp, steer, mv, kn, fc, hitT/hitK – hitT setzt r3-fx.js).
 *   Alles nur aus lesbarem Sim-Zustand + dt abgeleitet; dt = 0 (Pause) → Stillstand.
 * Konventionen: siehe docs/RENDER_MODULES.md (Oberflächen/Metall, Glühen/Bloom, Teile-Namen).
 * GB (Gebäude): Kollektiv-Gebäude haben eigene Modelle (buildKB, Abschnitt „GB“; nicht gespiegelt, Grundflächen/Ausgänge/Andockpunkte/Mündungen
 *   wie die gemeinsamen Modelle). GA: Gebäude zeigen Produktion/Andocken/Auslastung/Strommangel/Schaden (actPre/actDraw/dmgFx/litGain, liest
 *   nur den Sim-Zustand; Zusatzteile über actAttach bzw. M.act). Einziger Haken in r3-fx.js: G.R3F.bFlame/bSpark (angehängt).
 * v1.2 Modelle (Abschnitt „v1.2 Modelle“ vor TARNUNG): eigene Modelle aller v1.2-Typen (OWN12 → kein look-Rückfall mehr; 2D bleibt bei look),
 *   Träger-Plätze (hangarDraw), U-Boot taucht, Tor richtet sich nach den Mauern (wgG), Erzsilo-Füllstand, Reparaturdock-Arbeit (act12),
 *   Zustände lahmgelegt/gelähmt/Sprengladung (offFx/stunFx/chargeDraw), Tarnung halbtransparent (MAT.cloak über pbMode in partBatch).
 */
var G = (typeof G !== 'undefined') ? G : {};
(function () {
  'use strict';
  var R = G.R3 = G.R3 || {};
  var THREE = R.THREE, D = R.D, TILE = R.TILE;
  var hash = R.hash, clamp = R.clamp, lerpAng = R.lerpAng, smooth = R.smooth, rnd = R.rnd, fowify = R.fowify, visibleAt = R.visibleAt;
  var T3 = null, F3 = null;
  // aus r3-fx.js / r3-terrain.js (in link() gebunden)
  var emit = null, dust = null, arcSpark = null, addPulse = null, flashAt = null, groundAt = null;
  function link() {
    T3 = G.R3T; F3 = G.R3F; V = R.V;
    emit = F3.emit; dust = F3.dust; arcSpark = F3.arcSpark; addPulse = F3.addPulse; flashAt = F3.flashAt; groundAt = T3.groundAt;
  }

  // ------------------------------------------------------------------ Materialien (Fabrik)
  // Oberflächen für Modern (MeshStandardMaterial): je Vertex [roughness, metalness] als Attribut 'surf'.
  // Zuordnung automatisch über die Palettenfarbe (surfOf) oder ausdrücklich per MB.surf(name) für die folgenden Primitive.
  var SURF = {
    paint: [0.42, 0.18],    // Teamfarbe: leicht glänzender Lack
    body: [0.58, 0.32],     // Fahrzeug-Wanne/-Turm (lackiertes Metall)
    bodyB: [0.78, 0.06],    // Gebäude-Außenwand
    metal: [0.36, 0.72],    // blankes Metall (Rohre, Antennen, Nieten)
    dark: [0.5, 0.5],       // dunkle Stahlteile, Rohre
    track: [0.78, 0.3],     // Ketten, Reifen
    glass: [0.12, 0.25],    // Scheiben
    conc: [0.9, 0.0],       // Beton, Sandsäcke, Fundamente
    matte: [0.86, 0.0],     // Standard (Natur, Holz, Ziegel)
    organic: [0.95, 0.0],   // Bäume, Haut, Stoff
    glow: [1.0, 0.0]
  };
  var surfCol = {};         // Farbe (klein, #rrggbb) → Oberflächenname
  function initSurf() {
    var k, f, P;
    for (f in PAL) {
      P = PAL[f];
      surfCol[P.metal] = 'metal'; surfCol[P.dark] = 'dark'; surfCol[P.track] = 'track'; surfCol[P.glass] = 'glass';
      surfCol[P.body] = 'body'; surfCol[P.body2] = 'body'; surfCol[P.roof] = 'body'; surfCol[P.conc] = 'conc';
      surfCol[P.pan] = 'body'; surfCol[P.rust] = 'body'; surfCol[P.skin] = 'organic'; surfCol[P.cloth] = 'organic'; surfCol[P.helm] = 'body';
    }
    surfCol['#1f2326'] = 'dark'; surfCol['#1b1c1e'] = 'track'; surfCol['#c8ccd0'] = 'metal'; surfCol['#b8bec4'] = 'metal'; surfCol['#cfd5da'] = 'metal';
    surfCol['#6b6d6b'] = 'conc'; surfCol['#a39272'] = 'conc'; surfCol['#b3a27c'] = 'conc'; surfCol['#fde68a'] = 'glass';
    for (k in NP) if (!surfCol[NP[k]]) surfCol[NP[k]] = k === 'glass' ? 'glass' : (k === 'metal' ? 'metal' : (k === 'dark' ? 'dark' : 'matte'));
  }
  var curKind = 'env';      // 'unit' | 'bld' | 'env' – vom Modellbau gesetzt; Voreinstellung der Oberfläche für unbekannte Farben
  /** Oberfläche einer Farbe (String oder THREE.Color mit .surf). */
  function surfOf(col, kind) {
    if (col && col.isColor) return col.surf || 'paint';
    var s = surfCol[String(col).toLowerCase()];
    if (s) { if (s === 'body' && kind === 'bld') return 'bodyB'; return s; }
    return kind === 'unit' ? 'body' : 'matte';
  }

  var MAT = {}, matGen = 0;
  /** Oberflächen-Attribut in Standard-Material einbauen (roughness/metalness je Vertex, Faktor 1 = Tabelle). */
  function surfify(mat) {
    mat.userData.surf = true;
    mat.onBeforeCompile = function (sh) {
      sh.vertexShader = 'attribute vec2 surf; varying vec2 vSurf;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vSurf = surf;');
      sh.fragmentShader = 'varying vec2 vSurf;\n' + sh.fragmentShader
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor *= vSurf.x;')
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n  metalnessFactor *= vSurf.y;');
    };
    mat.customProgramCacheKey = function () { return 'surf1'; };
    return mat;
  }
  /** Material-Fabrik. kind: 'std' (Modelle, Vertexfarben), 'ore', 'terrain' {map}, 'tint' {color}, 'emis' (leuchtende Teile), 'ghost'. */
  function material(kind, o) {
    o = o || {};
    var std = !!R.std, m;
    if (kind === 'std' || kind === 'tint' || kind === 'ore') {
      var pr = { vertexColors: true };
      if (kind === 'tint') pr.color = new THREE.Color(o.color);
      if (std) {
        pr.roughness = 1; pr.metalness = 1;
        m = surfify(new THREE.MeshStandardMaterial(pr));
        if (kind === 'ore') { m.emissive = new THREE.Color('#6a4208'); m.emissiveIntensity = 1; m.userData.surfDefault = [0.3, 0.1]; }
      } else {
        m = new THREE.MeshLambertMaterial(pr);
        if (kind === 'ore') { m.emissive = new THREE.Color('#5a3806'); m.emissiveIntensity = 1; }
      }
      return fowify(m);
    }
    if (kind === 'terrain') {
      if (std) return fowify(new THREE.MeshStandardMaterial({ map: o.map, roughness: 0.92, metalness: 0, normalMap: o.normalMap || null }));
      return fowify(new THREE.MeshLambertMaterial({ map: o.map }));
    }
    if (kind === 'emis') {   // Glühteile: unbeleuchtet, Helligkeit = Vertexfarbe × Instanzfarbe × Verstärkung (Modern > 1 → Bloom)
      m = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
      if (std) m.color.setScalar(R.post ? 1.2 : 1.1);
      return fowify(m);
    }
    if (kind === 'ghost') {
      if (std) return new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, opacity: 0.6, depthWrite: false, roughness: 0.7, metalness: 0 });
      return new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.6, depthWrite: false });
    }
    throw new Error('material: unbekannt ' + kind);
  }
  /** Materialien für die aktuelle Qualität (neu) anlegen. Bestehende Batches/Meshes werden auf die neuen Materialien umgehängt. */
  function makeMaterials() {
    var old = {}, k;
    for (k in MAT) old[k] = MAT[k];
    MAT.std = material('std');
    MAT.ore = material('ore');
    MAT.emis = material('emis');
    MAT.glow = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.3, 0.7), toneMapped: false });
    MAT.ring = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95, depthWrite: false, toneMapped: false });
    MAT.marker = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    MAT.ghost = material('ghost');
    MAT.foot = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.45, depthWrite: false, toneMapped: false });
    MAT.ghostW = MAT.ghost.clone();   // Mauer-Vorschau: Farbe je Instanz (grün/rot)
    MAT.footW = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.5, depthWrite: false, toneMapped: false });
    MAT.cloak = material('std');   // v1.2 Tarnung: eigene getarnte Objekte halbtransparent, bläulich schimmernd (Deckkraft je Frame in fill)
    MAT.cloak.transparent = true; MAT.cloak.opacity = 0.42; MAT.cloak.depthWrite = false; MAT.cloak.color.setRGB(0.72, 0.9, 1.25);
    if (MAT.cloak.emissive) MAT.cloak.emissive.setRGB(0.04, 0.1, 0.16);
    matGen++;
    if (old.std) {   // umhängen: alle Instanz-Batches, Szene-Meshes mit alten Materialien
      var map = new Map();
      for (k in old) if (MAT[k]) map.set(old[k], MAT[k]);
      var swap = function (o) { if (o.material && map.has(o.material)) { var nm = map.get(o.material); o.material = nm; if (nm.userData.surf && o.geometry) ensureSurf(o.geometry); } };
      if (R.scene) R.scene.traverse(swap);
      for (var i = 0; i < batchList.length; i++) swap(batchList[i].mesh);
      if (ghost) { if (ghost.group.parent) ghost.group.parent.remove(ghost.group); ghost = null; }
      dropBatches();   // Teile-Batches neu anlegen lassen (Glühteile wechseln je nach Klasse zwischen MAT.std und MAT.emis)
      for (k in old) if (old[k] && old[k].dispose) old[k].dispose();
    }
  }
  /** Geometrie ohne 'surf'-Attribut (fremde Primitive) bekommt eine einheitliche matte Oberfläche. */
  function ensureSurf(geo, rm) {
    if (!geo || geo.attributes.surf || !geo.attributes.position) return geo;
    var n = geo.attributes.position.count, a = new Float32Array(n * 2), r0 = rm ? rm[0] : 0.85, m0 = rm ? rm[1] : 0;
    for (var i = 0; i < n; i++) { a[i * 2] = r0; a[i * 2 + 1] = m0; }
    geo.setAttribute('surf', new THREE.BufferAttribute(a, 2));
    return geo;
  }



  // ------------------------------------------------------------------ Modell-Baukasten (v0.7)
  /** Quader mit abgeschrägten Kanten (Fase c, 44 Dreiecke); Normalen je Fläche, Attribut hl = 1 auf den Fasen (Kantenlicht). */
  function chamBox(w, h, d, c, noBot) {
    var hw = w / 2, hh = h / 2, hd = d / 2, pos = [], nor = [], hlv = [], sg = [-1, 1];
    c = Math.min(c, Math.min(hw, hh, hd) * 0.9);
    function V(k, sx, sy, sz) {
      return k === 0 ? [sx * hw, sy * (hh - c), sz * (hd - c)] : (k === 1 ? [sx * (hw - c), sy * hh, sz * (hd - c)] : [sx * (hw - c), sy * (hh - c), sz * hd]);
    }
    function tri(a, b, cc, hl) {
      var ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = cc[0] - a[0], vy = cc[1] - a[1], vz = cc[2] - a[2];
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, t;
      if (nx * (a[0] + b[0] + cc[0]) + ny * (a[1] + b[1] + cc[1]) + nz * (a[2] + b[2] + cc[2]) < 0) { t = b; b = cc; cc = t; nx = -nx; ny = -ny; nz = -nz; }
      var l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1; nx /= l; ny /= l; nz /= l;
      pos.push(a[0], a[1], a[2], b[0], b[1], b[2], cc[0], cc[1], cc[2]);
      nor.push(nx, ny, nz, nx, ny, nz, nx, ny, nz); hlv.push(hl, hl, hl);
    }
    function quad(a, b, cc, e, hl) { tri(a, b, cc, hl); tri(a, cc, e, hl); }
    var i, j, s, t2;
    for (i = 0; i < 2; i++) {
      s = sg[i];
      quad(V(0, s, -1, -1), V(0, s, 1, -1), V(0, s, 1, 1), V(0, s, -1, 1), 0);                       // ±x
      if (!(noBot && s < 0)) quad(V(1, -1, s, -1), V(1, 1, s, -1), V(1, 1, s, 1), V(1, -1, s, 1), 0); // ±y
      quad(V(2, -1, -1, s), V(2, 1, -1, s), V(2, 1, 1, s), V(2, -1, 1, s), 0);                       // ±z
      for (j = 0; j < 2; j++) {
        t2 = sg[j];
        quad(V(0, s, t2, -1), V(0, s, t2, 1), V(1, s, t2, 1), V(1, s, t2, -1), 1);                     // x–y
        quad(V(0, s, -1, t2), V(0, s, 1, t2), V(2, s, 1, t2), V(2, s, -1, t2), 1);                     // x–z
        quad(V(1, -1, s, t2), V(1, 1, s, t2), V(2, 1, s, t2), V(2, -1, s, t2), 1);                     // y–z
        tri(V(0, s, t2, -1), V(1, s, t2, -1), V(2, s, t2, -1), 1); tri(V(0, s, t2, 1), V(1, s, t2, 1), V(2, s, t2, 1), 1);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('hl', new THREE.Float32BufferAttribute(hlv, 1));
    return g;
  }

  /** Sammelt Primitive (mit Farbe + Matrix) und führt sie zu EINER Geometrie mit Vertexfarben zusammen (Quader gefast, Rundungen weich). */
  function MB(kind) { this.list = []; this.kind = kind || curKind; this.sf = null; this.bv = null; this.flat = false; this.seed = 0; }
  MB.prototype.add = function (geo, col, x, y, z, ry, rx, rz, sx, sy, sz) {
    var m = new THREE.Matrix4(), e = new THREE.Euler(rx || 0, ry || 0, rz || 0);
    m.compose(new THREE.Vector3(x || 0, y || 0, z || 0), new THREE.Quaternion().setFromEuler(e), new THREE.Vector3(sx || 1, sy || 1, sz || 1));
    this.list.push([geo, col, m, this.sf || surfOf(col, this.kind)]);
    return this;
  };
  /** Oberfläche (Name aus SURF) für die FOLGENDEN Primitive festlegen; surf(null) = wieder automatisch nach Farbe. */
  MB.prototype.surf = function (name) { this.sf = name || null; return this; };
  /** Fasenbreite für die folgenden Quader (null = automatisch, 0 = glatte Quader). */
  MB.prototype.bevel = function (v) { this.bv = v == null ? null : v; return this; };
  /** Quader mit Unterkante bei y; ab einer Kantenlänge von 0.08 mit Fase. */
  MB.prototype.box = function (col, w, h, d, x, y, z, ry, rx, rz) {
    var mn = Math.min(w, h, d), c = this.bv != null ? this.bv : Math.min(0.03, mn * 0.2), g;
    if (this.flat || mn < 0.08 || c < 0.005) g = new THREE.BoxGeometry(w, h, d);
    else g = chamBox(w, h, d, c, y < 0.06 && !rx && !rz);
    return this.add(g, col, x || 0, (y || 0) + h / 2, z || 0, ry, rx, rz);
  };
  /** Glatter Quader (keine Fase) – für Kleinteile. */
  MB.prototype.pbox = function (col, w, h, d, x, y, z, ry, rx, rz) { return this.add(new THREE.BoxGeometry(w, h, d), col, x || 0, (y || 0) + h / 2, z || 0, ry, rx, rz); };
  /** Zylinder (stehend), Unterkante bei y. */
  MB.prototype.cyl = function (col, rt, rb, h, seg, x, y, z) { return this.add(new THREE.CylinderGeometry(rt, rb, h, seg || 8), col, x, y + h / 2, z); };
  /** Flache Scheibe (Kreis) in der xy-Ebene bei z, Blick nach sd (±1) – Radseite/Nabe ohne Innenkappe. */
  MB.prototype.disc = function (col, r, seg, x, y, z, sd) { return this.add(new THREE.CircleGeometry(r, seg || 8), col, x, y, z, sd < 0 ? Math.PI : 0); };
  /** Laufrad für Seitenansicht: offener Mantel + Außenscheibe + Nabe (≈ 30 Dreiecke), Außenseite zeigt nach sd. */
  MB.prototype.rollr = function (col, hubCol, r, wd, x, y, z, sd, seg) {
    seg = seg || 8;
    this.add(new THREE.CylinderGeometry(r, r, wd, seg, 1, true), col, x, y, z, 0, Math.PI / 2, 0);
    this.disc(col, r, seg, x, y, z + sd * wd / 2, sd);
    if (hubCol) this.disc(hubCol, r * 0.5, 6, x, y, z + sd * (wd / 2 + 0.004), sd);
    return this;
  };
  /** Zylinder mit Fase an Ober-/Unterkante (stehend). */
  MB.prototype.cylB = function (col, r, h, seg, x, y, z, c) {
    c = Math.min(c == null ? Math.min(0.025, r * 0.25, h * 0.3) : c, r * 0.5, h * 0.45);
    var pts = [new THREE.Vector2(0, 0), new THREE.Vector2(r - c, 0), new THREE.Vector2(r, c), new THREE.Vector2(r, h - c), new THREE.Vector2(r - c, h), new THREE.Vector2(0, h)];
    var g = new THREE.LatheGeometry(pts, seg || 10);
    return this.add(g, col, x, y, z);
  };
  /** Zylinder entlang der x-Achse, Mitte bei (x,y,z). */
  MB.prototype.cylX = function (col, rt, rb, len, seg, x, y, z, ry) { return this.add(new THREE.CylinderGeometry(rt, rb, len, seg || 6), col, x, y, z, ry || 0, 0, -Math.PI / 2); };
  /** Zylinder entlang der z-Achse, Mitte bei (x,y,z). */
  MB.prototype.cylZ = function (col, r, len, seg, x, y, z) { return this.add(new THREE.CylinderGeometry(r, r, len, seg || 8), col, x, y, z, 0, Math.PI / 2, 0); };
  /** Kegelstumpf/Konus-Zylinder entlang z mit zwei Radien (r0 bei −z, r1 bei +z). */
  MB.prototype.cylZ2 = function (col, r0, r1, len, seg, x, y, z) { return this.add(new THREE.CylinderGeometry(r1, r0, len, seg || 8), col, x, y, z, 0, Math.PI / 2, 0); };
  /** Prisma: Seitenprofil pts [[x,y],…] (gegen den Uhrzeigersinn), Breite in z, zentriert, mit feiner Fase. */
  MB.prototype.prism = function (col, pts, width, x, y, z, ry, bev) {
    var sh = new THREE.Shape(), bs = bev == null ? Math.min(0.02, width * 0.06) : bev;
    sh.moveTo(pts[0][0], pts[0][1]);
    for (var i = 1; i < pts.length; i++) sh.lineTo(pts[i][0], pts[i][1]);
    var g;
    if (bs > 0.004) {
      g = new THREE.ExtrudeGeometry(sh, { depth: width - 2 * bs, bevelEnabled: true, bevelThickness: bs, bevelSize: bs, bevelOffset: -bs, bevelSegments: 1, steps: 1, curveSegments: 1 });
      g.translate(0, 0, -(width - 2 * bs) / 2);
    } else {
      g = new THREE.ExtrudeGeometry(sh, { depth: width, bevelEnabled: false, steps: 1, curveSegments: 1 });
      g.translate(0, 0, -width / 2);
    }
    return this.add(g, col, x, y, z, ry);
  };
  /** Profil gedreht (Kühlturm, Silo-Kuppel). pts [[r,y],…] */
  MB.prototype.lathe = function (col, pts, seg, x, y, z) {
    var v = pts.map(function (p) { return new THREE.Vector2(p[0], p[1]); });
    return this.add(new THREE.LatheGeometry(v, seg || 10), col, x, y, z);
  };
  MB.prototype.ico = function (col, r, x, y, z, sx, sy, sz, detail) { return this.add(new THREE.IcosahedronGeometry(r, detail || 0), col, x, y, z, 0, 0, 0, sx, sy, sz); };
  /** Halbkugel/Kuppel (Pol nach oben), Unterkante bei y. */
  MB.prototype.dome = function (col, r, x, y, z, sx, sy, sz, seg) { return this.add(new THREE.SphereGeometry(r, seg || 10, Math.max(3, (seg || 10) >> 1), 0, Math.PI * 2, 0, Math.PI / 2), col, x, y, z, 0, 0, 0, sx, sy, sz); };
  MB.prototype.sph = function (col, r, x, y, z, sx, sy, sz, seg) { return this.add(new THREE.SphereGeometry(r, seg || 8, Math.max(3, (seg || 8) >> 1)), col, x, y, z, 0, 0, 0, sx, sy, sz); };
  /** Freies Viereck a-b-c-d (Weltpunkte [x,y,z]), Normale zeigt zur Seite von hint – für Paneelfugen, Streifen, Zeichen (2 Dreiecke). */
  MB.prototype.quad = function (col, a, b, c, d, hint) {
    var g = new THREE.BufferGeometry(), p = [a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2]];
    var ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (hint && nx * hint[0] + ny * hint[1] + nz * hint[2] < 0) p = [a[0], a[1], a[2], c[0], c[1], c[2], b[0], b[1], b[2], a[0], a[1], a[2], d[0], d[1], d[2], c[0], c[1], c[2]];
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    return this.add(g, col, 0, 0, 0);
  };
  /** Dünner Streifen auf einer Oberseite bei Höhe y von (x0,z0) nach (x1,z1), Breite wd (Paneelfuge/Markierung). */
  MB.prototype.top = function (col, x0, z0, x1, z1, y, wd) {
    var dx = x1 - x0, dz = z1 - z0, l = Math.sqrt(dx * dx + dz * dz) || 1, nx = -dz / l * wd / 2, nz = dx / l * wd / 2;
    return this.quad(col, [x0 - nx, y, z0 - nz], [x1 - nx, y, z1 - nz], [x1 + nx, y, z1 + nz], [x0 + nx, y, z0 + nz], [0, 1, 0]);
  };
  /** Dünner Streifen auf einer Wand senkrecht zu z (Nord/Süd) bei z, von (x0,y0) nach (x1,y1), Dicke wd; dir = ±1 Blickrichtung. */
  MB.prototype.wallZ = function (col, x0, y0, x1, y1, z, wd, dir) {
    var dx = x1 - x0, dy = y1 - y0, l = Math.sqrt(dx * dx + dy * dy) || 1, nx = -dy / l * wd / 2, ny = dx / l * wd / 2;
    return this.quad(col, [x0 - nx, y0 - ny, z], [x1 - nx, y1 - ny, z], [x1 + nx, y1 + ny, z], [x0 + nx, y0 + ny, z], [0, 0, dir || 1]);
  };
  /** … auf einer Wand senkrecht zu x. */
  MB.prototype.wallX = function (col, z0, y0, z1, y1, x, wd, dir) {
    var dz = z1 - z0, dy = y1 - y0, l = Math.sqrt(dz * dz + dy * dy) || 1, nz = -dy / l * wd / 2, ny = dz / l * wd / 2;
    return this.quad(col, [x, y0 - ny, z0 - nz], [x, y1 - ny, z1 - nz], [x, y1 + ny, z1 + nz], [x, y0 + ny, z0 + nz], [dir || 1, 0, 0]);
  };
  function hsh(n) { var s = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return s - Math.floor(s); }
  /** Zusammenführen. ao: Unterseiten leicht abdunkeln (Schmutz/Umgebungsverdeckung); Fasenkanten heller, Oberseiten minimal heller, je Primitiv leichte Tönung. */
  MB.prototype.geo = function (ao) {
    var pos = [], col = [], srf = [], nor = [], v = new THREE.Vector3(), nv = new THREE.Vector3(), C = new THREE.Color(), tot = 0, k, i;
    for (k = 0; k < this.list.length; k++) { var g0 = this.list[k][0]; tot += g0.index ? g0.index.count : g0.attributes.position.count; }
    for (k = 0; k < this.list.length; k++) {
      var g = this.list[k][0], ng = g.index ? g.toNonIndexed() : g, p = ng.attributes.position, nn = ng.attributes.normal, hl = ng.attributes.hl, m = this.list[k][2], sv = SURF[this.list[k][3]] || SURF.matte;
      var nm = new THREE.Matrix3().getNormalMatrix(m), jit = 0.965 + 0.07 * hsh(k + this.seed * 7.31);
      if (!nn) { ng.computeVertexNormals(); nn = ng.attributes.normal; }
      C.set(this.list[k][1]);
      for (i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i).applyMatrix4(m);
        nv.fromBufferAttribute(nn, i).applyMatrix3(nm).normalize();
        pos.push(v.x, v.y, v.z); nor.push(nv.x, nv.y, nv.z);
        var f = (ao === false ? 1 : 0.74 + 0.26 * clamp((v.y + 0.02) / 0.3, 0, 1)) * jit * (1 + 0.045 * nv.y + (hl && hl.getX(i) > 0.5 ? 0.12 : 0));
        col.push(C.r * f, C.g * f, C.b * f);
        srf.push(sv[0], sv[1]);
      }
      if (ng !== g) ng.dispose();
      g.dispose();
    }
    var out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    out.setAttribute('surf', new THREE.Float32BufferAttribute(srf, 2));   // [roughness, metalness] je Vertex (nur Modern ausgewertet)
    out.computeBoundingSphere(); out.computeBoundingBox();
    out.userData.tris = pos.length / 9;
    return out;
  };

  // ------------------------------------------------------------------ Paletten
  var PAL = {
    coalition: { body: '#bfc8cf', body2: '#97a3ad', dark: '#2c333a', track: '#1e2125', glass: '#4fb0e8', metal: '#dde3e8', roof: '#7b8792', conc: '#a3a5a3', skin: '#e0b48c', cloth: '#6a7885', helm: '#d3dae0', pan: '#eef2f5', rust: '#6c7882' },
    kollektiv: { body: '#5560b8', body2: '#3a4392', dark: '#151a40', track: '#1e2125', glass: '#a5b4fc', metal: '#dde3e8', roof: '#2c3378', conc: '#a3a5a3', skin: '#e0b48c', cloth: '#323a7a', helm: '#c7d2fe', pan: '#eef2f5', rust: '#3d4686' },   // v1.0 Kollektiv (PLATZHALTER v1.0: Dunkelblau/Indigo)
    syndicate: { body: '#6c6b48', body2: '#515037', dark: '#25231d', track: '#1f1e1a', glass: '#b8c566', metal: '#8f8873', roof: '#413e31', conc: '#82796c', skin: '#d9a77c', cloth: '#4d4936', helm: '#34311f', pan: '#8e4d2c', rust: '#8a4727' }
  };
  function teamCols(color) {
    var t = new THREE.Color(color), d = t.clone().multiplyScalar(0.55), l = t.clone().lerp(new THREE.Color('#ffffff'), 0.45);
    t.surf = d.surf = l.surf = 'paint';
    return { team: t, teamD: d, teamL: l };
  }
  function rivets(b, col, x0, x1, y, z, n) { for (var i = 0; i < n; i++) b.pbox(col, 0.03, 0.03, 0.02, x0 + (x1 - x0) * (n > 1 ? i / (n - 1) : 0.5), y, z); }
  /** Nietenreihe entlang z an einer x-Wand. */
  function rivetsX(b, col, z0, z1, y, x, n) { for (var i = 0; i < n; i++) b.pbox(col, 0.02, 0.03, 0.03, x, y, z0 + (z1 - z0) * (n > 1 ? i / (n - 1) : 0.5)); }
  /** Rad (Achse z, Ursprung = Mitte): Reifen mit Profilstollen, Felge, Nabe, Radmuttern – dreht als eigenes Teil. */
  function wheelGeo(r, wd, tire, rim, hub, lugs) {
    var w = new MB('unit'), i, a, n = lugs || 8;
    w.cylZ(tire, r, wd, 12, 0, 0, 0);
    for (i = 0; i < n; i++) { a = i / n * Math.PI * 2; w.pbox(tire, r * 0.3, r * 0.2, wd * 1.04, Math.cos(a) * r * 0.97, Math.sin(a) * r * 0.97 - r * 0.1, 0, 0, 0, a + Math.PI / 2); }
    w.cylZ(rim, r * 0.62, wd + 0.012, 10, 0, 0, 0);
    w.cylZ(hub, r * 0.3, wd + 0.026, 8, 0, 0, 0);
    for (i = 0; i < 5; i++) { a = i / 5 * Math.PI * 2; w.pbox(hub, r * 0.14, r * 0.14, wd + 0.034, Math.cos(a) * r * 0.45, Math.sin(a) * r * 0.45 - r * 0.07, 0); }
    return w.geo(false);
  }
  /** Kettenstollen als Teil (läuft in Fahrt durch): flache Querstege im Abstand pitch von -len/2 … len/2 (+ eine Periode), Breite wd (nur Oberseiten, 2 Dreiecke je Steg). */
  function treadGeo(len, wd, pitch, hh, col) {
    var t = new MB('unit'), n = Math.round(len / pitch) + 1, i, w2 = wd / 2, x, hl = pitch * 0.21;
    for (i = 0; i <= n; i++) { x = -len / 2 + i * pitch; t.quad(col, [x - hl, hh, -w2], [x + hl, hh, -w2], [x + hl, hh, w2], [x - hl, hh, w2], [0, 1, 0]); }
    return t.geo(false);
  }


  // ------------------------------------------------------------------ Einheiten-Modelle
  // Jedes Modell: { parts:{hull, turret?, barrel?, cargo?, glow?}, xparts/xp (Räder, Kettenstollen), pivot:[x,z], recoil, muzzle:[x,y] (im Turm), h (Höhe), scale }
  // Turm/Rohr sind relativ zum Drehpunkt M.pivot gebaut; Hülle relativ zur Fahrzeugmitte, Vorwärts = +x.
  var SCALE = { psiadept: 1.9, brute: 1.9, gatling: 1.0, magnet: 1.0, psitank: 1.05, mcv: 1.0, rifle: 1.9, rocket: 1.9, scout: 1.12, raider: 1.12, tank: 1.08, harvester: 1.0, engineer: 1.9, howitzer: 1.0, hunter: 1.05, colossus: 1.12 };
  var LAMPC = '#fff1c4', TAILC = '#ff3b2a';

  /** Laufwerk einer Seite: Band (abgerundete Enden), Laufrollen, Treib-/Leitrad, Stützrollen. z = Mitte, sd = ±1 (Außenseite). o: L halbe Länge der Fläche, H Höhe, W Breite, n Laufrollen, rr Rollenradius */
  function trackSide(b, P, o, z, sd) {
    var L = o.L, H = o.H, W = o.W, cap = H * 0.5, i, y0 = o.y0 || 0, zo = z + sd * (W / 2);
    b.prism(P.track, [[-L - cap * 0.5, 0.0], [L + cap * 0.5, 0.0], [L + cap, cap * 0.6], [L + cap * 0.7, H], [-L - cap * 0.7, H], [-L - cap, cap * 0.6]], W, 0, y0, z, 0, 0);
    var rr = o.rr || H * 0.34, n = o.n || 5, ry = y0 + rr + 0.012;
    for (i = 0; i < n; i++) b.rollr(P.dark, P.metal, rr, 0.026, -L + 2 * L * (n > 1 ? i / (n - 1) : 0.5), ry, zo, sd, 8);
    b.rollr(P.dark, P.metal, H * 0.44, 0.03, L + cap * 0.55, y0 + H * 0.5, zo, sd, 8);          // Leitrad
    b.rollr(P.dark, P.metal, H * 0.46, 0.03, -L - cap * 0.55, y0 + H * 0.5, zo, sd, 8);          // Treibrad
  }
  /** Kettenstollen-Teile (xp, laufen in Fahrt): pro Seite ein Streifen auf der Oberseite. */
  function addTreads(M, P, o, zs, y) {
    M.xparts.trk = treadGeo(2 * o.L + o.H * 0.6, o.W * 0.8, o.pitch || 0.065, 0.004, P.dark);
    for (var i = 0; i < zs.length; i++) M.xp.push({ p: 'trk', x: 0, y: y, z: zs[i], k: 'trk', pitch: o.pitch || 0.065 });
  }

  /** Bewegung: ein Bein (Hüfte im Ursprung, hängt nach unten) – als Zusatzteil 'leg' zweimal je Soldat gezeichnet (Schrittbewegung in fill()). */
  function infLegs(M, P, k, colL, colB) {
    k = k || 1;
    var lb = new MB();
    lb.pbox(colL || P.cloth, 0.055 * k, 0.13 * k, 0.058 * k, 0.003, -0.13 * k, 0).pbox(colB || P.dark, 0.085 * k, 0.035 * k, 0.066 * k, 0.027, -0.13 * k, 0);
    M.xparts.leg = lb.geo(false); M.legY = 0.13 * k; M.legZ = 0.04 * k;
    M.xp = [{ p: 'leg', k: 'leg', x: 0, y: M.legY, z: M.legZ }, { p: 'leg', k: 'leg', x: 0, y: M.legY, z: -M.legZ }];   // (auch für das Seitenleisten-Symbol)
  }
  function soldier(b, P, T, fac, kind) {
    var syn = fac === 'syndicate', rocket = kind === 'rocket';
    // Bewegung: Beine + Stiefel sind ein eigenes Teil (infLegs), damit sie laufen/knien können
    b.pbox(T.teamD, 0.07, 0.03, 0.15, 0.0, 0.115, 0);                                                                // Gürtel
    b.box(P.cloth, 0.1, 0.15, 0.15, 0, 0.125, 0).pbox(T.team, 0.104, 0.1, 0.12, 0.002, 0.15, 0);                      // Torso + Weste in Teamfarbe
    b.pbox(syn ? P.body2 : P.pan, 0.106, 0.02, 0.124, 0.002, 0.2, 0);                                               // Kragen/Streifen
    b.pbox(T.team, 0.062, 0.036, 0.06, -0.005, 0.258, 0.1).pbox(T.team, 0.062, 0.036, 0.06, -0.005, 0.258, -0.1);   // Schulterpolster (Teamfarbe, gut lesbar)
    b.pbox(P.skin, 0.055, 0.055, 0.06, 0.012, 0.275, 0);                                                              // Gesicht
    if (kind === 'engineer') { /* Schutzhelm wird im Ingenieur-Modell gesetzt */ }
    else if (syn) {                                                                                                    // Syndikat: Schutzmaske + Kappe
      b.pbox(P.dark, 0.05, 0.04, 0.062, 0.04, 0.268, 0).pbox(P.glass, 0.012, 0.022, 0.07, 0.056, 0.296, 0);
      b.cylB(P.helm, 0.056, 0.05, 8, 0.0, 0.303, 0, 0.012).pbox(P.helm, 0.1, 0.012, 0.09, 0.012, 0.3, 0).pbox(T.team, 0.02, 0.016, 0.1, -0.044, 0.325, 0);
    } else {                                                                                                           // Koalition: runder Helm mit Visier
      b.dome(P.helm, 0.064, 0.003, 0.292, 0, 1, 0.9, 1.05, 10);
      b.pbox(P.glass, 0.014, 0.024, 0.07, 0.058, 0.286, 0).pbox(T.team, 0.03, 0.01, 0.118, 0.0, 0.332, 0);
    }
    b.box(P.dark, 0.075, 0.15, 0.115, -0.092, 0.115, 0).pbox(T.teamD, 0.08, 0.034, 0.118, -0.092, 0.18, 0).pbox(P.metal, 0.02, 0.02, 0.02, -0.14, 0.2, 0.03);   // Rucksack + Rolle
    if (rocket) {
      b.cylX(syn ? '#5c6340' : P.body2, 0.04, 0.04, 0.4, 8, 0.07, 0.275, 0.07).cylX(P.dark, 0.054, 0.048, 0.08, 8, -0.15, 0.275, 0.07).cylX(T.team, 0.043, 0.043, 0.035, 8, 0.1, 0.275, 0.07);
      b.add(new THREE.ConeGeometry(0.044, 0.1, 8), '#d6431a', 0.31, 0.275, 0.07, 0, 0, -Math.PI / 2);
      b.pbox(P.dark, 0.06, 0.03, 0.03, 0.04, 0.31, 0.07).pbox(P.glass, 0.02, 0.02, 0.02, 0.07, 0.34, 0.07);
      b.pbox(P.cloth, 0.12, 0.045, 0.045, 0.045, 0.21, 0.09, -0.35).pbox(P.cloth, 0.12, 0.045, 0.045, 0.06, 0.2, -0.07, 0.4);
    } else if (kind === 'engineer') {
      return;
    } else {
      b.pbox(syn ? '#4b3b2a' : P.body2, 0.12, 0.05, 0.04, 0.02, 0.19, 0.075);                                         // Schaft
      b.pbox(P.dark, 0.2, 0.034, 0.034, 0.16, 0.2, 0.075).cylX(P.metal, 0.012, 0.012, 0.11, 6, 0.3, 0.215, 0.075);        // Lauf + Mündung
      b.pbox(P.dark, 0.05, 0.075, 0.03, 0.1, 0.13, 0.075).pbox(syn ? P.dark : P.glass, 0.07, 0.03, 0.03, 0.12, 0.24, 0.075);   // Magazin + Zielfernrohr
      b.pbox(P.cloth, 0.12, 0.045, 0.045, 0.045, 0.21, 0.1, -0.2).pbox(P.cloth, 0.12, 0.045, 0.045, 0.08, 0.2, -0.06, 0.45);   // Arme
    }
  }

  function buildUnit(type, fac, color) {
    if (V12U[type]) return buildU12(type, fac, color);   // v1.2 eigene Modelle (Abschnitt „v1.2 Modelle“)
    if (V9M[type]) return buildV9(type, fac, color);   // v0.9 Schlachtschiff
    if (V8M[type]) return buildV8(type, fac, color);   // v0.8 Luftwaffe & Marine
    if (V4U[type]) return buildUnitV4(type, fac, color);
    if (V5U[type]) return buildUnitV5(type, fac, color);
    if (V7U[type]) return buildUnitV7(type, fac, color);
    var P = PAL[fac], T = teamCols(color), syn = fac === 'syndicate', M = { parts: {}, xparts: {}, xp: [], pivot: [0, 0], recoil: 0, muzzle: [0.2, 0.2], h: 0.4 };
    var b, t, r, g, i;
    if (type === 'rifle' || type === 'rocket') {
      b = new MB(); soldier(b, P, T, fac, type);
      M.parts.hull = b.geo(false); M.muzzle = type === 'rocket' ? [0.3, 0.3] : [0.35, 0.215]; M.h = 0.36; infLegs(M, P);
    } else if (type === 'tank') {
      b = new MB(); t = new MB(); r = new MB(); g = new MB();
      if (!syn) {                                                      // Koalition: flacher, eckiger Kampfpanzer mit Seitenschürzen
        var o = { L: 0.34, H: 0.17, W: 0.15, n: 4, rr: 0.058 };
        trackSide(b, P, o, 0.255, 1); trackSide(b, P, o, -0.255, -1);
        b.prism(P.body, [[-0.45, 0.08], [0.4, 0.08], [0.52, 0.17], [0.42, 0.245], [-0.4, 0.245], [-0.47, 0.19]], 0.4, 0, 0, 0);
        b.prism(P.body2, [[0.36, 0.2], [0.53, 0.165], [0.54, 0.185], [0.4, 0.255], [0.36, 0.255]], 0.3, 0, 0, 0);               // Bugpanzerung
        b.box(P.body, 0.74, 0.04, 0.19, -0.04, 0.2, 0.245).box(P.body, 0.74, 0.04, 0.19, -0.04, 0.2, -0.245);                   // Kotflügel
        b.pbox(T.team, 0.74, 0.012, 0.045, -0.04, 0.242, 0.3).pbox(T.team, 0.74, 0.012, 0.045, -0.04, 0.242, -0.3);             // Teamkante
        for (i = 0; i < 3; i++) { b.box(P.body2, 0.2, 0.12, 0.03, -0.2 + i * 0.205, 0.075, 0.345).box(P.body2, 0.2, 0.12, 0.03, -0.2 + i * 0.205, 0.075, -0.345); b.pbox(T.team, 0.18, 0.025, 0.034, -0.2 + i * 0.205, 0.15, 0.348).pbox(T.team, 0.18, 0.025, 0.034, -0.2 + i * 0.205, 0.15, -0.348); }
        b.box(P.body2, 0.2, 0.025, 0.28, -0.3, 0.245, 0).top(P.track, -0.38, -0.1, -0.22, -0.1, 0.272, 0.012).top(P.track, -0.38, 0.0, -0.22, 0.0, 0.272, 0.012).top(P.track, -0.38, 0.1, -0.22, 0.1, 0.272, 0.012);   // Motorgitter
        b.box(T.team, 0.16, 0.012, 0.3, -0.18, 0.245, 0);                                                                           // Teamplatte
        b.top(P.dark, 0.12, -0.17, 0.12, 0.17, 0.2565, 0.01).top(P.dark, 0.3, -0.15, 0.3, 0.15, 0.2565, 0.01);
        b.cylB(P.dark, 0.012, 0.18, 6, -0.46, 0.17, 0.14, 0.003).cylB(P.dark, 0.012, 0.18, 6, -0.46, 0.17, -0.14, 0.003);       // Heckauspuff
        g.pbox(LAMPC, 0.02, 0.03, 0.05, 0.52, 0.15, 0.13).pbox(LAMPC, 0.02, 0.03, 0.05, 0.52, 0.15, -0.13).pbox(TAILC, 0.02, 0.025, 0.05, -0.47, 0.18, 0.15).pbox(TAILC, 0.02, 0.025, 0.05, -0.47, 0.18, -0.15);
        // Turm (Drehpunkt −0.03)
        t.prism(P.body2, [[-0.22, 0.245], [0.06, 0.245], [0.2, 0.275], [0.23, 0.33], [0.13, 0.385], [-0.15, 0.385], [-0.25, 0.335]], 0.3, 0, 0, 0);
        t.box(P.body, 0.14, 0.09, 0.07, 0.12, 0.28, 0.14, -0.4).box(P.body, 0.14, 0.09, 0.07, 0.12, 0.28, -0.14, 0.4);               // Wangen
        t.box(T.team, 0.2, 0.012, 0.22, -0.04, 0.385, 0).pbox(P.pan, 0.2, 0.004, 0.012, -0.04, 0.398, 0.07).pbox(P.pan, 0.2, 0.004, 0.012, -0.04, 0.398, -0.07);
        t.box(P.dark, 0.075, 0.1, 0.13, 0.215, 0.275, 0).pbox(P.dark, 0.05, 0.06, 0.1, 0.25, 0.3, 0);                                // Blende
        t.cylB(P.body, 0.06, 0.03, 8, -0.1, 0.385, 0.08, 0.008).cylB(P.dark, 0.036, 0.016, 8, -0.1, 0.413, 0.08, 0.005);               // Kommandantenkuppel
        t.pbox(P.dark, 0.07, 0.05, 0.06, -0.02, 0.385, -0.09).pbox(P.glass, 0.012, 0.03, 0.05, 0.016, 0.395, -0.09);                  // Optik
        for (i = 0; i < 3; i++) t.cylX(P.dark, 0.012, 0.012, 0.04, 5, 0.12, 0.31 + i * 0.022, -0.185 - 0.0);                            // Nebelwerfer
        t.cyl(P.metal, 0.006, 0.008, 0.26, 4, -0.2, 0.385, -0.1);
        r.cylX(P.dark, 0.034, 0.034, 0.12, 8, 0.27, 0.328, 0).cylX(P.dark, 0.026, 0.028, 0.46, 8, 0.52, 0.328, 0).cylX(P.metal, 0.034, 0.034, 0.09, 8, 0.5, 0.328, 0);
        r.box(P.body2, 0.1, 0.06, 0.064, 0.78, 0.298, 0).pbox(P.track, 0.02, 0.05, 0.068, 0.76, 0.303, 0).pbox(P.track, 0.02, 0.05, 0.068, 0.8, 0.303, 0);
        M.muzzle = [0.84, 0.328]; M.pivot = [-0.03, 0];
      } else {                                                         // Syndikat: breit, genietet, schwere Schürzen
        var o2 = { L: 0.34, H: 0.19, W: 0.17, n: 4, rr: 0.065 };
        trackSide(b, P, o2, 0.265, 1); trackSide(b, P, o2, -0.265, -1);
        b.box(P.body, 0.92, 0.17, 0.4, -0.02, 0.07, 0);
        b.prism(P.body, [[0.38, 0.07], [0.52, 0.12], [0.44, 0.27], [0.3, 0.27]], 0.4, 0, 0, 0);
        b.box(P.body2, 0.86, 0.045, 0.62, -0.04, 0.2, 0);                                                                            // Oberwanne
        b.box(P.rust, 0.3, 0.03, 0.34, -0.3, 0.245, 0).pbox(P.dark, 0.2, 0.012, 0.22, -0.32, 0.275, 0);                                // Motordeck mit Gitter
        for (i = 0; i < 4; i++) b.top(P.track, -0.4, -0.09 + i * 0.06, -0.24, -0.09 + i * 0.06, 0.2875, 0.012);
        b.pbox(T.team, 0.05, 0.04, 0.62, 0.12, 0.245, 0).pbox(T.team, 0.5, 0.02, 0.045, -0.04, 0.245, 0.3).pbox(T.team, 0.5, 0.02, 0.045, -0.04, 0.245, -0.3);
        for (i = 0; i < 4; i++) { b.box(P.body2, 0.2, 0.15, 0.04, -0.22 + i * 0.21, 0.065, 0.375).box(P.body2, 0.2, 0.15, 0.04, -0.22 + i * 0.21, 0.065, -0.375); }
        rivets(b, P.metal, -0.3, 0.38, 0.19, 0.396, 7); rivets(b, P.metal, -0.3, 0.38, 0.19, -0.396, 7);
        b.pbox(T.team, 0.2, 0.025, 0.045, -0.12, 0.17, 0.4).pbox(T.team, 0.2, 0.025, 0.045, -0.12, 0.17, -0.4);
        b.box(P.dark, 0.1, 0.1, 0.1, -0.5, 0.15, 0.13).box(P.dark, 0.1, 0.1, 0.1, -0.5, 0.15, -0.13);                                  // Kanister
        b.cylB(P.rust, 0.035, 0.22, 6, -0.55, 0.25, 0.2, 0.004).cylB(P.dark, 0.04, 0.02, 6, -0.55, 0.47, 0.2, 0.004);                   // Auspuff
        for (i = 0; i < 4; i++) b.pbox(P.dark, 0.1, 0.02, 0.06, 0.4 + i * 0.012, 0.18 + i * 0.015, -0.12 + i * 0.07, 0, 0, -0.5);          // Reservekettenglieder
        g.pbox(LAMPC, 0.02, 0.035, 0.05, 0.5, 0.18, 0.19).pbox(LAMPC, 0.02, 0.035, 0.05, 0.5, 0.18, -0.19).pbox(TAILC, 0.02, 0.025, 0.05, -0.47, 0.2, 0.2).pbox(TAILC, 0.02, 0.025, 0.05, -0.47, 0.2, -0.2);
        // Turm: runder Guss
        t.cylB(P.body2, 0.22, 0.1, 10, 0.0, 0.245, 0, 0.012);
        t.prism(P.body, [[-0.27, 0.34], [0.1, 0.34], [0.2, 0.36], [0.2, 0.43], [0.1, 0.46], [-0.2, 0.46], [-0.28, 0.4]], 0.4, 0, 0, 0);
        t.box(P.body, 0.34, 0.1, 0.36, -0.02, 0.28, 0).box(P.dark, 0.1, 0.22, 0.32, 0.2, 0.3, 0);                                         // Blendenwulst
        t.cylB(P.rust, 0.075, 0.03, 8, -0.13, 0.46, 0.1, 0.01).cylB(P.dark, 0.05, 0.016, 8, -0.13, 0.49, 0.1, 0.005);                   // Kommandantenkuppel
        t.pbox(T.team, 0.22, 0.014, 0.24, -0.05, 0.46, 0).box(P.rust, 0.14, 0.05, 0.12, -0.2, 0.46, -0.1).pbox(P.glass, 0.014, 0.03, 0.08, -0.12, 0.49, -0.1);
        rivetsX(t, P.metal, -0.14, 0.14, 0.35, 0.215, 5); rivets(t, P.metal, -0.2, 0.06, 0.4, 0.201, 5); rivets(t, P.metal, -0.2, 0.06, 0.4, -0.201, 5);
        t.box(P.rust, 0.14, 0.1, 0.1, -0.3, 0.3, 0).box(P.dark, 0.1, 0.07, 0.07, -0.18, 0.3, 0.2);                                      // Stauraum hinten
        r.cylX(P.dark, 0.046, 0.05, 0.18, 8, 0.32, 0.352, 0).cylX(P.dark, 0.034, 0.038, 0.46, 8, 0.6, 0.352, 0).cylX(P.rust, 0.05, 0.05, 0.07, 8, 0.56, 0.352, 0);
        r.cylX(P.dark, 0.056, 0.056, 0.1, 8, 0.86, 0.352, 0).pbox(P.track, 0.014, 0.1, 0.1, 0.9, 0.3, 0);
        M.muzzle = [0.92, 0.352]; M.pivot = [-0.03, 0];
      }
      M.parts.hull = b.geo(); M.parts.turret = t.geo(); M.parts.barrel = r.geo(); M.parts.glow = g.geo(false);
      addTreads(M, P, syn ? o2 : o, syn ? [0.265, -0.265] : [0.255, -0.255], (syn ? 0.19 : 0.17) + 0.004);
      M.recoil = 0.1; M.h = syn ? 0.5 : 0.44; M.exhaust = syn ? [[-0.55, 0.47, 0.2]] : [[-0.46, 0.35, 0.14], [-0.46, 0.35, -0.14]];
    } else if (type === 'scout') {
      b = new MB(); t = new MB(); g = new MB();                       // Koalition: flacher Späher-Buggy mit MG
      var wr = 0.095;
      M.xparts.wheel = wheelGeo(wr, 0.085, P.track, P.metal, P.body2, 8);
      [[0.23, 1], [0.23, -1], [-0.2, 1], [-0.2, -1]].forEach(function (w) { M.xp.push({ p: 'wheel', x: w[0], y: wr, z: w[1] * 0.225, k: 'wheel', r: wr }); });
      b.box(P.dark, 0.62, 0.05, 0.3, 0, 0.1, 0);                                                                                        // Rahmen
      b.prism(P.body, [[-0.34, 0.12], [0.34, 0.12], [0.4, 0.17], [0.32, 0.215], [0.1, 0.225], [-0.04, 0.3], [-0.12, 0.3], [-0.18, 0.225], [-0.34, 0.225]], 0.34, 0, 0, 0);
      b.prism(P.glass, [[0.1, 0.225], [0.17, 0.225], [0.07, 0.31], [0.03, 0.31]], 0.3, 0, 0, 0);                                         // Frontscheibe
      b.pbox(P.body2, 0.18, 0.05, 0.3, -0.19, 0.225, 0);                                                                                 // Ladefläche
      for (i = 0; i < 2; i++) { b.box(P.body, 0.26, 0.05, 0.1, 0.23, 0.185, i ? -0.215 : 0.215).box(P.body, 0.26, 0.05, 0.1, -0.2, 0.185, i ? -0.215 : 0.215); }   // Radkästen
      b.pbox(T.team, 0.3, 0.012, 0.24, 0.22, 0.23, 0).pbox(T.team, 0.3, 0.02, 0.05, -0.08, 0.23, 0.17).pbox(T.team, 0.3, 0.02, 0.05, -0.08, 0.23, -0.17);
      b.top(P.pan, -0.3, 0.11, 0.28, 0.11, 0.246, 0.008).top(P.pan, -0.3, -0.11, 0.28, -0.11, 0.246, 0.008);
      b.pbox(P.dark, 0.04, 0.07, 0.3, 0.405, 0.08, 0).pbox(P.dark, 0.03, 0.03, 0.34, -0.36, 0.14, 0);                                   // Stoßfänger
      b.pbox(P.dark, 0.026, 0.12, 0.026, -0.2, 0.225, 0.14).pbox(P.dark, 0.026, 0.12, 0.026, -0.2, 0.225, -0.14).pbox(P.dark, 0.026, 0.026, 0.3, -0.2, 0.34, 0);   // Überrollbügel
      b.cylZ(P.track, 0.065, 0.06, 8, -0.35, 0.2, 0).cylZ(P.metal, 0.03, 0.065, 6, -0.35, 0.2, 0);                                      // Ersatzrad
      b.cyl(P.metal, 0.005, 0.007, 0.34, 4, -0.3, 0.3, 0.12);
      g.pbox(LAMPC, 0.02, 0.035, 0.06, 0.39, 0.15, 0.1).pbox(LAMPC, 0.02, 0.035, 0.06, 0.39, 0.15, -0.1).pbox(TAILC, 0.02, 0.03, 0.05, -0.345, 0.18, 0.15).pbox(TAILC, 0.02, 0.03, 0.05, -0.345, 0.18, -0.15);
      t.cylB(P.dark, 0.05, 0.075, 8, 0, 0.23, 0, 0.008).box(P.body2, 0.1, 0.07, 0.11, 0.0, 0.3, 0);
      t.box(P.body, 0.04, 0.12, 0.2, 0.07, 0.3, 0).pbox(T.team, 0.045, 0.02, 0.2, 0.07, 0.42, 0);                                         // Schutzschild
      t.cylX(P.dark, 0.014, 0.014, 0.2, 6, 0.14, 0.355, 0).cylX(P.metal, 0.02, 0.02, 0.05, 6, 0.24, 0.355, 0).pbox(P.dark, 0.06, 0.04, 0.04, -0.03, 0.34, 0.04);
      M.parts.hull = b.geo(); M.parts.turret = t.geo(); M.parts.glow = g.geo(false);
      M.pivot = [-0.12, 0]; M.muzzle = [0.3, 0.355]; M.h = 0.42; M.recoil = 0.02;
    } else if (type === 'raider') {
      b = new MB(); t = new MB(); g = new MB();                       // Syndikat: wuchtiger Kampfbuggy mit Käfig
      var wr2 = 0.115;
      M.xparts.wheel = wheelGeo(wr2, 0.1, P.track, P.rust, P.dark, 8);
      [[0.23, 1], [0.23, -1], [-0.22, 1], [-0.22, -1]].forEach(function (w) { M.xp.push({ p: 'wheel', x: w[0], y: wr2, z: w[1] * 0.255, k: 'wheel', r: wr2 }); });
      b.box(P.dark, 0.66, 0.06, 0.34, 0, 0.1, 0);
      b.box(P.body, 0.6, 0.1, 0.36, 0, 0.15, 0);
      b.prism(P.body2, [[0.2, 0.25], [0.34, 0.17], [0.4, 0.15], [0.4, 0.25]], 0.34, 0, 0, 0);
      b.box(P.rust, 0.12, 0.08, 0.3, -0.12, 0.25, 0).box(P.dark, 0.2, 0.06, 0.2, 0.22, 0.25, 0);                                         // Motorblock offen
      for (i = 0; i < 3; i++) b.cylB(P.metal, 0.02, 0.08, 5, 0.17 + i * 0.05, 0.31, 0.0, 0.003);
      b.pbox(T.team, 0.34, 0.016, 0.3, -0.08, 0.255, 0).pbox(T.team, 0.05, 0.1, 0.38, 0.36, 0.14, 0);
      b.pbox(P.dark, 0.06, 0.1, 0.46, 0.43, 0.08, 0);                                                                                    // Rammbügel
      for (i = 0; i < 3; i++) b.add(new THREE.ConeGeometry(0.02, 0.07, 4), P.metal, 0.47, 0.12, -0.15 + i * 0.15, 0, 0, -Math.PI / 2);
      for (i = -1; i <= 1; i += 2) { b.box(P.body2, 0.3, 0.04, 0.12, 0.23, 0.22, i * 0.255).box(P.body2, 0.3, 0.04, 0.12, -0.22, 0.22, i * 0.255); }   // Kotflügel
      b.pbox(P.dark, 0.03, 0.22, 0.03, 0.04, 0.25, 0.17).pbox(P.dark, 0.03, 0.22, 0.03, 0.04, 0.25, -0.17).pbox(P.dark, 0.03, 0.22, 0.03, -0.3, 0.25, 0.17).pbox(P.dark, 0.03, 0.22, 0.03, -0.3, 0.25, -0.17);
      b.pbox(P.dark, 0.36, 0.03, 0.03, -0.13, 0.47, 0.17).pbox(P.dark, 0.36, 0.03, 0.03, -0.13, 0.47, -0.17).pbox(P.dark, 0.03, 0.03, 0.37, 0.04, 0.47, 0).pbox(P.dark, 0.03, 0.03, 0.37, -0.3, 0.47, 0);
      b.pbox(P.dark, 0.3, 0.02, 0.02, -0.13, 0.36, 0.17, 0, 0, 0.5).pbox(P.dark, 0.3, 0.02, 0.02, -0.13, 0.36, -0.17, 0, 0, -0.5);
      b.box(P.body2, 0.14, 0.12, 0.26, -0.28, 0.25, 0).cyl(P.rust, 0.05, 0.05, 0.2, 6, -0.38, 0.22, 0.14).cyl(P.dark, 0.055, 0.055, 0.03, 6, -0.38, 0.42, 0.14);
      b.pbox('#c9b99a', 0.012, 0.14, 0.12, -0.3, 0.37, 0.0);                                                                             // Warnflagge
      g.pbox(LAMPC, 0.02, 0.04, 0.07, 0.4, 0.19, 0.15).pbox(LAMPC, 0.02, 0.04, 0.07, 0.4, 0.19, -0.15).pbox(TAILC, 0.02, 0.03, 0.05, -0.31, 0.22, 0.14).pbox(TAILC, 0.02, 0.03, 0.05, -0.31, 0.22, -0.14);
      t.cylB(P.dark, 0.06, 0.08, 8, 0, 0.36, 0, 0.01).box(P.body2, 0.12, 0.09, 0.14, 0.0, 0.43, 0);
      t.box(P.rust, 0.04, 0.17, 0.26, 0.09, 0.43, 0).pbox(T.team, 0.045, 0.025, 0.26, 0.09, 0.6, 0);
      t.cylX(P.dark, 0.022, 0.022, 0.26, 6, 0.2, 0.5, 0).cylX(P.metal, 0.034, 0.034, 0.06, 6, 0.32, 0.5, 0).pbox(P.dark, 0.08, 0.05, 0.05, -0.03, 0.48, 0.05);
      M.parts.hull = b.geo(); M.parts.turret = t.geo(); M.parts.glow = g.geo(false);
      M.pivot = [-0.1, 0]; M.muzzle = [0.36, 0.5]; M.h = 0.62; M.recoil = 0.02; M.exhaust = [[-0.38, 0.42, 0.14]];
    } else if (type === 'harvester') {
      b = new MB(); t = new MB(); g = new MB();
      var ho = { L: 0.34, H: 0.2, W: 0.15, n: 4, rr: 0.065, pitch: 0.07 }, hw = 0.3;
      trackSide(b, P, ho, hw, 1); trackSide(b, P, ho, -hw, -1);
      b.box(syn ? P.body2 : P.body, 0.9, 0.13, 0.52, -0.02, 0.1, 0);
      b.pbox(T.team, 0.86, 0.02, 0.05, -0.02, 0.22, 0.3).pbox(T.team, 0.86, 0.02, 0.05, -0.02, 0.22, -0.3);
      if (!syn) {                                                                                                                         // Kabine vorn
        b.prism(P.body, [[0.18, 0.22], [0.44, 0.22], [0.46, 0.34], [0.34, 0.48], [0.18, 0.48]], 0.34, 0, 0, 0.12);
        b.prism(P.glass, [[0.34, 0.36], [0.465, 0.345], [0.35, 0.475], [0.32, 0.475]], 0.28, 0, 0, 0.12);
        b.box(T.team, 0.3, 0.02, 0.36, 0.3, 0.48, 0.12).pbox(P.dark, 0.1, 0.06, 0.06, 0.2, 0.5, 0.12);
      } else {
        b.box(P.body, 0.28, 0.28, 0.34, 0.31, 0.22, 0.12).pbox(P.glass, 0.03, 0.1, 0.28, 0.45, 0.38, 0.12).box(P.rust, 0.3, 0.03, 0.36, 0.31, 0.5, 0.12).pbox(T.team, 0.18, 0.02, 0.26, 0.3, 0.53, 0.12);
        rivets(b, P.metal, 0.2, 0.44, 0.44, 0.292, 4);
      }
      // Trichter (offen), Wände in Körperfarbe, Boden dunkel
      b.box(P.dark, 0.5, 0.03, 0.46, -0.16, 0.23, 0);
      b.box(syn ? P.body2 : P.body, 0.54, 0.2, 0.04, -0.16, 0.23, 0.245, 0, 0.25).box(syn ? P.body2 : P.body, 0.54, 0.2, 0.04, -0.16, 0.23, -0.245, 0, -0.25);
      b.box(syn ? P.body : P.body2, 0.04, 0.2, 0.5, -0.43, 0.23, 0).box(syn ? P.body : P.body2, 0.04, 0.16, 0.46, 0.1, 0.23, 0);
      b.pbox(T.team, 0.5, 0.025, 0.04, -0.16, 0.46, 0.27).pbox(T.team, 0.5, 0.025, 0.04, -0.16, 0.46, -0.27);
      // Schaufel vorn mit Zähnen
      b.prism(P.dark, [[0.44, 0.02], [0.58, 0.02], [0.52, 0.18], [0.46, 0.18]], 0.54, 0, 0, 0);
      b.pbox(P.metal, 0.03, 0.04, 0.5, 0.58, 0.04, 0).pbox(P.rust, 0.05, 0.02, 0.54, 0.52, 0.17, 0);
      for (i = 0; i < 6; i++) b.pbox('#d0c9b8', 0.06, 0.025, 0.035, 0.61, 0.02, -0.225 + i * 0.09);
      b.cylB(P.rust, 0.025, 0.2, 6, -0.46, 0.2, 0.2, 0.004);                                                                              // Auspuff
      g.ico('#ffb42e', 0.035, 0.3, 0.55, 0.28, 1, 0.7, 1, 1); g.pbox(LAMPC, 0.02, 0.04, 0.08, 0.48, 0.2, 0.2).pbox(LAMPC, 0.02, 0.04, 0.08, 0.48, 0.2, 0.04);
      // Ladung: Erzhaufen (Teil cargo, wird nach Füllstand skaliert)
      t.dome(syn ? '#e0a82a' : '#e6b422', 0.22, 0, 0, 0, 1.1, 0.8, 0.95, 7);
      t.ico('#ffd75e', 0.07, 0.1, 0.16, 0.08).ico('#d99a1c', 0.06, -0.12, 0.15, -0.07).ico('#f5cc4a', 0.06, 0.0, 0.18, -0.12).ico('#c98a18', 0.05, -0.06, 0.12, 0.12);
      M.parts.hull = b.geo(); M.parts.cargo = t.geo(false); M.parts.glow = g.geo(false); M.cargoAt = [-0.16, 0.25]; M.h = 0.52; M.exhaust = [[-0.46, 0.4, 0.2]];
      addTreads(M, P, ho, [hw, -hw], 0.2 + 0.004);
    }
    return M;
  }


  // ------------------------------------------------------------------ v0.4: Haubitze, Ingenieur, Jagdpanzer, Kolosspanzer (SPEC_v04 §4)
  // Haubitze: Rad/Kette, Rohr hebt sich beim Aufbauen. Animierte Teile liegen in M.xparts (Instanzen je Zustand), Ruhepose in M.xp (für Symbol und Vorschau).
  var V4U = { howitzer: 1, engineer: 1, hunter: 1, colossus: 1 };
  var V4B = { techcenter: [3, 3], orbital: [3, 2], silo: [3, 2] };
  var HOW_EL = 0.62;                       // Rohr-Elevation der Haubitze im Feuern (rad)
  var HOW_TRAVEL = 0.06;                   // … in Fahrt
  var GLOWC = { coalition: '#b5f3ff', syndicate: '#ffbe55', kollektiv: '#a5b4fc' };   // v1.0

  function buildUnitV4(type, fac, color) {
    var P = PAL[fac], T = teamCols(color), syn = fac === 'syndicate', M = { parts: {}, xparts: {}, xp: [], pivot: [0, 0], recoil: 0, muzzle: [0.2, 0.2], h: 0.4 };
    var b = new MB(), t = new MB(), r = new MB(), g = new MB(), i, sd;
    if (type === 'engineer') {
      var hat = syn ? '#e8731a' : '#f7c81e', hatD = syn ? '#9a4a10' : '#b28f10';
      soldier(b, P, T, fac, 'engineer');
      b.dome(hat, 0.07, 0.003, 0.285, 0, 1, 0.85, 1.05, 10); b.pbox(hat, 0.1, 0.012, 0.13, 0.04, 0.286, 0).pbox(hatD, 0.1, 0.02, 0.026, 0, 0.34, 0).pbox(P.glass, 0.014, 0.024, 0.066, 0.058, 0.272, 0);
      b.pbox('#f3f1e6', 0.108, 0.02, 0.124, 0.002, 0.17, 0).pbox('#f3f1e6', 0.108, 0.02, 0.124, 0.002, 0.13, 0);                         // Reflexstreifen
      b.box('#c2410c', 0.14, 0.1, 0.07, 0.07, 0.04, 0.14).pbox(P.dark, 0.06, 0.016, 0.026, 0.07, 0.14, 0.14).pbox(T.teamL, 0.145, 0.02, 0.072, 0.07, 0.09, 0.14); // Werkzeugkoffer
      b.pbox(P.cloth, 0.12, 0.045, 0.045, 0.045, 0.21, 0.1, -0.2).pbox(P.cloth, 0.12, 0.045, 0.045, 0.05, 0.2, -0.08, 0.3);
      b.cyl('#c8ced3', 0.014, 0.014, 0.2, 5, -0.12, 0.2, -0.04).pbox('#c8ced3', 0.05, 0.026, 0.02, -0.12, 0.4, -0.04).cyl('#c8ced3', 0.02, 0.02, 0.03, 6, -0.12, 0.4, -0.04);   // Rucksack + Schraubenschlüssel
      M.parts.hull = b.geo(false); M.muzzle = [0.1, 0.17]; M.h = 0.4; infLegs(M, P);
      return M;
    }
    if (type === 'howitzer') {
      var sp = new MB();
      if (!syn) {                                                          // Koalition: sechsrädrige Radhaubitze
        var wr = 0.105;
        M.xparts.wheel = wheelGeo(wr, 0.1, P.track, P.metal, P.body2, 8);
        [0.4, 0.04, -0.32].forEach(function (ax) { [1, -1].forEach(function (s2) {
          M.xp.push({ p: 'wheel', x: ax, y: wr, z: s2 * 0.285, k: 'wheel', r: wr });
          b.box(P.body2, 0.27, 0.035, 0.12, ax, 0.205, s2 * 0.285);
        }); });
        b.box(P.dark, 1.08, 0.07, 0.36, -0.05, 0.1, 0);
        b.prism(P.body, [[0.18, 0.17], [0.6, 0.17], [0.64, 0.27], [0.52, 0.35], [0.3, 0.42], [0.18, 0.42]], 0.46, 0, 0, 0);       // Kabine
        b.pbox(P.glass, 0.03, 0.09, 0.38, 0.56, 0.27, 0, 0, 0, -0.35).pbox(P.glass, 0.17, 0.07, 0.012, 0.36, 0.3, 0.232).pbox(P.glass, 0.17, 0.07, 0.012, 0.36, 0.3, -0.232);
        b.box(T.team, 0.3, 0.02, 0.47, 0.34, 0.42, 0);
        b.box(P.body2, 0.82, 0.07, 0.52, -0.22, 0.16, 0).pbox(T.team, 0.82, 0.03, 0.54, -0.22, 0.2, 0);
        b.cylB(P.dark, 0.2, 0.05, 12, -0.12, 0.23, 0, 0.01).top(P.metal, -0.32, 0, 0.08, 0, 0.283, 0.008);
        b.box(P.body, 0.22, 0.12, 0.14, -0.45, 0.23, 0.16).box(P.body, 0.22, 0.12, 0.14, -0.45, 0.23, -0.16);                     // Munitionskästen
        b.box(P.dark, 0.1, 0.14, 0.36, -0.6, 0.1, 0).pbox(T.team, 0.02, 0.06, 0.3, -0.655, 0.16, 0);
        b.cyl(P.dark, 0.012, 0.012, 0.2, 4, 0.22, 0.42, 0.18);
        g.pbox(LAMPC, 0.02, 0.03, 0.05, 0.645, 0.2, 0.15).pbox(LAMPC, 0.02, 0.03, 0.05, 0.645, 0.2, -0.15).pbox(TAILC, 0.02, 0.03, 0.05, -0.655, 0.2, 0.15).pbox(TAILC, 0.02, 0.03, 0.05, -0.655, 0.2, -0.15);
        t.cylB(P.body2, 0.17, 0.05, 12, 0, 0.27, 0, 0.01);
        t.box(P.body2, 0.05, 0.24, 0.4, 0.14, 0.3, 0).pbox(T.team, 0.056, 0.04, 0.41, 0.14, 0.46, 0);                                // Schutzschild
        t.box(P.body, 0.36, 0.17, 0.045, -0.06, 0.3, 0.17).box(P.body, 0.36, 0.17, 0.045, -0.06, 0.3, -0.17);
        t.box(P.dark, 0.2, 0.09, 0.3, -0.2, 0.3, 0).box(P.dark, 0.1, 0.15, 0.3, 0.0, 0.3, 0);
        t.box(T.team, 0.3, 0.015, 0.3, -0.1, 0.47, 0).top(P.pan, -0.25, 0.0, 0.05, 0.0, 0.4855, 0.01);
        r.cylX(P.dark, 0.056, 0.056, 0.34, 8, 0.17, 0, 0).cylX(P.metal, 0.034, 0.03, 0.66, 8, 0.6, 0, 0).cylX(P.dark, 0.05, 0.05, 0.1, 8, 0.4, 0, 0).cylX(P.dark, 0.05, 0.05, 0.13, 8, 0.96, 0, 0).pbox(P.dark, 0.1, 0.07, 0.1, -0.06, -0.035, 0);
        r.pbox(P.metal, 0.08, 0.022, 0.1, 1.02, 0.035, 0).pbox(P.metal, 0.08, 0.022, 0.1, 1.02, -0.057, 0);
        sp.add(new THREE.BoxGeometry(0.3, 0.04, 0.4), P.dark, -0.14, -0.1, 0, 0, 0, 0.6).add(new THREE.BoxGeometry(0.1, 0.045, 0.4), T.team, -0.26, -0.17, 0, 0, 0, 0.6);
        M.pivot = [-0.12, 0]; M.trun = [0.0, 0.42]; M.muzzle = [0.82, 1.0]; M.spadeAt = [-0.54, 0.2, 0];
      } else {                                                             // Syndikat: Kettenhaubitze
        var ho = { L: 0.38, H: 0.17, W: 0.14, n: 5, rr: 0.06 };
        trackSide(b, P, ho, 0.26, 1); trackSide(b, P, ho, -0.26, -1);
        addTreads(M, P, ho, [0.26, -0.26], 0.17 + 0.004);
        b.box(P.body, 0.96, 0.17, 0.42, -0.02, 0.09, 0);
        b.prism(P.body, [[0.4, 0.09], [0.58, 0.14], [0.48, 0.28], [0.36, 0.28]], 0.42, 0, 0, 0);
        b.box(P.body2, 0.34, 0.1, 0.38, 0.3, 0.26, 0).box(P.dark, 0.22, 0.012, 0.3, 0.3, 0.36, 0).pbox(P.rust, 0.05, 0.03, 0.38, 0.5, 0.26, 0);
        for (i = 0; i < 4; i++) b.top(P.track, 0.2, -0.1 + i * 0.07, 0.4, -0.1 + i * 0.07, 0.373, 0.012);
        b.cyl(P.dark, 0.06, 0.06, 0.05, 6, 0.42, 0.26, 0.12).pbox(P.glass, 0.02, 0.05, 0.14, 0.51, 0.3, -0.1);
        rivets(b, P.metal, -0.4, 0.2, 0.2, 0.21, 6); rivets(b, P.metal, -0.4, 0.2, 0.2, -0.21, 6);
        b.box(P.dark, 0.12, 0.17, 0.42, -0.54, 0.09, 0).box(P.body2, 0.2, 0.1, 0.12, -0.4, 0.26, 0.16).box(P.body2, 0.2, 0.1, 0.12, -0.4, 0.26, -0.16);
        b.pbox(T.team, 0.9, 0.025, 0.04, -0.02, 0.17, 0.215).pbox(T.team, 0.9, 0.025, 0.04, -0.02, 0.17, -0.215);
        b.cylB(P.rust, 0.025, 0.22, 6, -0.52, 0.26, 0.18, 0.004);
        g.pbox(LAMPC, 0.02, 0.03, 0.05, 0.575, 0.18, 0.16).pbox(LAMPC, 0.02, 0.03, 0.05, 0.575, 0.18, -0.16).pbox(TAILC, 0.02, 0.03, 0.05, -0.605, 0.2, 0.16).pbox(TAILC, 0.02, 0.03, 0.05, -0.605, 0.2, -0.16);
        t.cylB(P.body2, 0.21, 0.08, 10, 0, 0.27, 0, 0.012);
        t.prism(P.body, [[-0.28, 0.34], [0.12, 0.34], [0.22, 0.4], [0.16, 0.57], [-0.26, 0.57], [-0.31, 0.46]], 0.44, 0, 0, 0);
        t.box(P.dark, 0.1, 0.22, 0.32, 0.2, 0.34, 0).box(T.team, 0.3, 0.02, 0.36, -0.07, 0.57, 0).pbox(P.rust, 0.14, 0.05, 0.14, -0.16, 0.59, 0);
        rivets(t, P.metal, -0.22, 0.08, 0.5, 0.225, 5); rivets(t, P.metal, -0.22, 0.08, 0.5, -0.225, 5);
        t.cylB(P.dark, 0.06, 0.04, 6, -0.14, 0.59, 0.12, 0.006).box(P.rust, 0.12, 0.1, 0.1, -0.34, 0.34, 0);
        r.cylX(P.dark, 0.07, 0.07, 0.3, 10, 0.15, 0, 0).cylX(P.dark, 0.044, 0.044, 0.78, 8, 0.64, 0, 0).sph(P.rust, 0.08, 0.5, 0, 0, 1.2, 1, 1, 8).cylX(P.dark, 0.056, 0.056, 0.14, 8, 1.02, 0, 0).pbox(P.dark, 0.12, 0.08, 0.12, -0.05, -0.04, 0);
        r.pbox(P.metal, 0.1, 0.02, 0.12, 1.06, 0.056, 0).pbox(P.metal, 0.1, 0.02, 0.12, 1.06, -0.076, 0);
        sp.add(new THREE.BoxGeometry(0.3, 0.05, 0.44), P.dark, -0.14, -0.1, 0, 0, 0, 0.6).add(new THREE.BoxGeometry(0.1, 0.055, 0.44), T.team, -0.26, -0.17, 0, 0, 0, 0.6);
        M.pivot = [-0.12, 0]; M.trun = [0.08, 0.46]; M.muzzle = [0.91, 1.05]; M.spadeAt = [-0.54, 0.2, 0];
      }
      M.parts.hull = b.geo(); M.parts.turret = t.geo(); M.parts.barrel = r.geo(); M.parts.spades = sp.geo(); M.parts.glow = g.geo(false);
      M.at = { barrel: [M.pivot[0] + M.trun[0], M.trun[1], 0], spades: M.spadeAt }; M.rest = HOW_EL;
      M.recoil = 0.16; M.h = 0.62; M.how = true; if (syn) M.exhaust = [[-0.52, 0.48, 0.18]];
      return M;
    }
    if (type === 'hunter') {                                               // Koalition: flach, keilförmig, lange Kanone
      var hu = { L: 0.34, H: 0.14, W: 0.12, n: 4, rr: 0.048 };
      trackSide(b, P, hu, 0.265, 1); trackSide(b, P, hu, -0.265, -1);
      addTreads(M, P, hu, [0.265, -0.265], 0.14 + 0.004);
      b.box(P.body2, 0.78, 0.1, 0.07, -0.02, 0.09, 0.325).box(P.body2, 0.78, 0.1, 0.07, -0.02, 0.09, -0.325);                           // Schürzen
      b.pbox(T.team, 0.8, 0.025, 0.075, -0.02, 0.185, 0.325).pbox(T.team, 0.8, 0.025, 0.075, -0.02, 0.185, -0.325);
      b.prism(P.body, [[-0.47, 0.06], [0.44, 0.06], [0.58, 0.13], [0.36, 0.23], [-0.4, 0.23], [-0.49, 0.15]], 0.52, 0, 0, 0);
      b.prism(P.body2, [[0.34, 0.23], [0.58, 0.13], [0.6, 0.15], [0.4, 0.26]], 0.44, 0, 0, 0);
      b.box(T.team, 0.2, 0.012, 0.44, -0.3, 0.23, 0).box(P.dark, 0.16, 0.025, 0.34, -0.4, 0.235, 0);
      for (i = 0; i < 3; i++) b.top(P.track, -0.46, -0.1 + i * 0.1, -0.34, -0.1 + i * 0.1, 0.2605, 0.012);
      b.top(P.pan, -0.1, -0.2, -0.1, 0.2, 0.2325, 0.01).top(P.pan, 0.2, -0.18, 0.2, 0.18, 0.2325, 0.01);
      g.pbox(LAMPC, 0.02, 0.03, 0.06, 0.585, 0.11, 0.18).pbox(LAMPC, 0.02, 0.03, 0.06, 0.585, 0.11, -0.18).pbox(TAILC, 0.02, 0.025, 0.05, -0.495, 0.14, 0.18).pbox(TAILC, 0.02, 0.025, 0.05, -0.495, 0.14, -0.18);
      g.pbox('#7ee7ff', 0.012, 0.02, 0.04, 0.07, 0.4, 0.1);
      b.cylB(P.dark, 0.012, 0.18, 6, -0.5, 0.15, 0.2, 0.003).cylB(P.dark, 0.012, 0.18, 6, -0.5, 0.15, -0.2, 0.003);
      t.prism(P.body2, [[-0.27, 0.23], [0.14, 0.23], [0.3, 0.27], [0.2, 0.37], [-0.14, 0.37], [-0.28, 0.31]], 0.36, 0, 0, 0);
      t.prism(P.body, [[-0.14, 0.37], [0.2, 0.37], [0.1, 0.405], [-0.1, 0.405]], 0.28, 0, 0, 0);
      t.box(T.team, 0.18, 0.012, 0.2, -0.04, 0.405, 0).box(P.dark, 0.1, 0.07, 0.1, -0.08, 0.37, -0.1).pbox(P.glass, 0.014, 0.03, 0.07, -0.025, 0.4, -0.1);
      t.box(P.dark, 0.07, 0.065, 0.07, 0.02, 0.37, 0.1).pbox('#7ee7ff', 0.012, 0.02, 0.04, 0.056, 0.39, 0.1).cyl(P.metal, 0.006, 0.008, 0.28, 4, -0.2, 0.37, 0.12);
      t.box(P.dark, 0.08, 0.1, 0.18, 0.3, 0.255, 0);
      r.cylX(P.dark, 0.03, 0.034, 0.36, 8, 0.38, 0.31, 0).cylX(P.metal, 0.02, 0.024, 0.66, 8, 0.82, 0.31, 0).cylX(P.metal, 0.034, 0.034, 0.08, 8, 0.6, 0.31, 0).cylX(P.dark, 0.036, 0.036, 0.13, 8, 1.15, 0.31, 0).pbox(P.dark, 0.05, 0.06, 0.05, 0.12, 0.31, 0);
      r.pbox(P.metal, 0.07, 0.016, 0.07, 1.16, 0.34, 0);
      M.parts.hull = b.geo(); M.parts.turret = t.geo(); M.parts.barrel = r.geo(); M.parts.glow = g.geo(false);
      M.pivot = [-0.06, 0]; M.recoil = 0.12; M.muzzle = [1.22, 0.31]; M.h = 0.42;
      return M;
    }
    if (type === 'colossus') {                                             // Syndikat: riesig, Zwillingsrohre
      var r2 = new MB(), co = { L: 0.44, H: 0.26, W: 0.24, n: 5, rr: 0.09, pitch: 0.08 };
      trackSide(b, P, co, 0.4, 1); trackSide(b, P, co, -0.4, -1);
      addTreads(M, P, co, [0.4, -0.4], 0.26 + 0.004);
      b.box(P.body2, 1.1, 0.14, 0.05, 0, 0.12, 0.555).box(P.body2, 1.1, 0.14, 0.05, 0, 0.12, -0.555);                                // Schürzen
      for (i = 0; i < 5; i++) { b.pbox(P.dark, 0.012, 0.15, 0.06, -0.48 + i * 0.24, 0.115, 0.555).pbox(P.dark, 0.012, 0.15, 0.06, -0.48 + i * 0.24, 0.115, -0.555); }
      b.pbox(T.team, 1.1, 0.03, 0.06, 0, 0.26, 0.555).pbox(T.team, 1.1, 0.03, 0.06, 0, 0.26, -0.555);
      b.box(P.body, 1.1, 0.26, 0.6, -0.02, 0.1, 0);
      b.prism(P.body, [[0.5, 0.1], [0.72, 0.16], [0.56, 0.38], [0.4, 0.36]], 0.6, 0, 0, 0);
      b.box(P.body2, 0.44, 0.1, 0.56, -0.36, 0.36, 0).box(P.dark, 0.32, 0.012, 0.42, -0.36, 0.46, 0).pbox(T.team, 0.06, 0.05, 0.9, 0.2, 0.26, 0);
      for (i = 0; i < 5; i++) b.top(P.track, -0.52, -0.16 + i * 0.08, -0.2, -0.16 + i * 0.08, 0.4725, 0.014);
      rivets(b, P.metal, -0.5, 0.42, 0.3, 0.306, 8); rivets(b, P.metal, -0.5, 0.42, 0.3, -0.306, 8); rivetsX(b, P.metal, -0.24, 0.24, 0.34, 0.6, 5);
      b.cylB(P.rust, 0.055, 0.34, 6, -0.62, 0.3, 0.2, 0.005).cylB(P.rust, 0.055, 0.34, 6, -0.62, 0.3, -0.2, 0.005);                   // Auspuff
      b.cylB(P.dark, 0.065, 0.02, 6, -0.62, 0.64, 0.2, 0.004).cylB(P.dark, 0.065, 0.02, 6, -0.62, 0.64, -0.2, 0.004);
      b.pbox(P.rust, 0.2, 0.08, 0.16, 0.5, 0.36, 0.0).box(P.rust, 0.34, 0.07, 0.12, 0.1, 0.36, 0.3).box(P.rust, 0.34, 0.07, 0.12, 0.1, 0.36, -0.3);
      g.pbox(LAMPC, 0.02, 0.04, 0.06, 0.7, 0.2, 0.23).pbox(LAMPC, 0.02, 0.04, 0.06, 0.7, 0.2, -0.23).pbox(TAILC, 0.02, 0.03, 0.06, -0.55, 0.26, 0.26).pbox(TAILC, 0.02, 0.03, 0.06, -0.55, 0.26, -0.26);
      g.ico('#ff4a30', 0.025, -0.05, 0.68, -0.22, 1, 1, 1, 1);
      t.cylB(P.body2, 0.34, 0.08, 10, 0, 0.36, 0, 0.014);
      t.prism(P.body, [[-0.38, 0.42], [0.28, 0.42], [0.4, 0.48], [0.36, 0.67], [-0.32, 0.67], [-0.42, 0.55]], 0.68, 0, 0, 0);
      t.box(P.dark, 0.1, 0.3, 0.58, 0.4, 0.4, 0).box(T.team, 0.44, 0.025, 0.46, -0.04, 0.67, 0);
      rivets(t, P.metal, -0.3, 0.22, 0.6, 0.34, 5); rivets(t, P.metal, -0.3, 0.22, 0.6, -0.34, 5);
      t.cylB(P.body2, 0.1, 0.1, 8, -0.16, 0.67, 0.16, 0.012).cylB(P.dark, 0.05, 0.04, 6, -0.16, 0.77, 0.16, 0.006);                   // Kommandantenkuppel
      t.box(P.rust, 0.22, 0.1, 0.1, -0.08, 0.67, -0.2).pbox(P.glass, 0.02, 0.04, 0.08, 0.04, 0.71, -0.2);
      t.box(P.rust, 0.5, 0.14, 0.08, -0.4, 0.5, 0.0).box(P.dark, 0.1, 0.1, 0.1, -0.44, 0.67, 0.2);
      for (sd = -1; sd <= 1; sd += 2) t.pbox(P.dark, 0.08, 0.08, 0.04, 0.2, 0.42, sd * 0.27 + sd * 0.03);
      var barrelGeo = function (gg, z) {
        gg.cylX(P.dark, 0.056, 0.062, 0.46, 8, 0.64, 0.5, z).cylX(P.dark, 0.036, 0.042, 0.78, 8, 1.1, 0.5, z).cylX(P.rust, 0.06, 0.06, 0.1, 8, 0.96, 0.5, z).cylX(P.dark, 0.06, 0.06, 0.14, 8, 1.5, 0.5, z);
        gg.pbox(P.metal, 0.1, 0.02, 0.1, 1.55, 0.558, z).pbox(P.dark, 0.1, 0.1, 0.1, 1.46, 0.45, z);
      };
      barrelGeo(r, 0.15); barrelGeo(r2, -0.15);
      M.parts.hull = b.geo(); M.parts.turret = t.geo(); M.parts.barrel = r.geo(); M.parts.barrel2 = r2.geo(); M.parts.glow = g.geo(false);
      M.pivot = [-0.05, 0]; M.recoil = 0.16; M.muzzle = [1.58, 0.5]; M.mz2 = 0.15; M.h = 0.8; M.exhaust = [[-0.62, 0.66, 0.2], [-0.62, 0.66, -0.2]];
      return M;
    }
    return M;
  }


  // ------------------------------------------------------------------ Gebäude-Modelle
  var BH = { hq: 1.65, power: 1.2, refinery: 1.15, barracks: 0.8, factory: 1.1, turret: 0.62, mg: 0.42, techcenter: 1.6, orbital: 1.5, silo: 1.0 };
  var WINLIT = '#f0cb86';
  /** Fundament: Randstein, Betonplatte mit Fugen, Ecken in Teamfarbe. Oberkante 0.06. */
  function slab(b, P, w, h, T) {
    var i;
    b.box('#85888a', w - 0.02, 0.05, h - 0.02, 0, 0, 0).box(P.conc, w - 0.16, 0.06, h - 0.16, 0, 0, 0);
    for (i = 1; i < w; i++) b.top('#6f7274', i - w / 2, -h / 2 + 0.1, i - w / 2, h / 2 - 0.1, 0.0615, 0.012);
    for (i = 1; i < h; i++) b.top('#6f7274', -w / 2 + 0.1, i - h / 2, w / 2 - 0.1, i - h / 2, 0.0615, 0.012);
    if (T) for (i = 0; i < 4; i++) b.pbox(T.team, 0.16, 0.012, 0.06, (i & 1 ? 1 : -1) * (w / 2 - 0.14), 0.05, (i & 2 ? 1 : -1) * (h / 2 - 0.045));
  }
  /** Fensterreihe an einer Südwand (z fest, Blick +z): n Scheiben, Rahmen dunkel, ein Teil leuchtet (g). */
  function winS(b, g, P, x0, x1, y, z, n, ww, wh, lit, seed, dir) {
    var d = dir || 1;
    for (var i = 0; i < n; i++) {
      var x = x0 + (x1 - x0) * (n > 1 ? i / (n - 1) : 0.5);
      b.pbox(P.dark, ww + 0.03, wh + 0.03, 0.016, x, y - 0.015, z + d * 0.006);
      if (g && hsh(i * 5.1 + seed) < lit) g.pbox(WINLIT, ww, wh, 0.012, x, y, z + d * 0.016); else b.pbox(P.glass, ww, wh, 0.012, x, y, z + d * 0.016);
    }
  }
  /** … an einer Ostwand (x fest, Blick ±x). */
  function winE(b, g, P, z0, z1, y, x, n, ww, wh, lit, seed, dir) {
    var d = dir || 1;
    for (var i = 0; i < n; i++) {
      var z = z0 + (z1 - z0) * (n > 1 ? i / (n - 1) : 0.5);
      b.pbox(P.dark, 0.016, wh + 0.03, ww + 0.03, x + d * 0.006, y - 0.015, z);
      if (g && hsh(i * 3.7 + seed) < lit) g.pbox(WINLIT, 0.012, wh, ww, x + d * 0.016, y, z); else b.pbox(P.glass, 0.012, wh, ww, x + d * 0.016, y, z);
    }
  }
  /** Klimagerät mit Lüfter. */
  function acUnit(b, P, x, y, z, w) {
    w = w || 0.2; b.box(P.body2, w, 0.1, w * 0.8, x, y, z).cylB(P.dark, w * 0.3, 0.012, 8, x, y + 0.1, z, 0.003).top(P.metal, x - w * 0.28, z, x + w * 0.28, z, y + 0.1125, 0.008);
  }
  /** Warnstreifen (gelb/schwarz) auf dem Boden, Länge entlang x, Breite wd, bei z. */
  function hazardX(b, x0, x1, z, y, wd) {
    var n = Math.max(2, Math.round((x1 - x0) / (wd * 1.6))), dx = (x1 - x0) / n;
    for (var i = 0; i < n; i++) b.quad(i % 2 ? '#e6b81c' : '#23272b', [x0 + i * dx, y, z - wd / 2], [x0 + (i + 1) * dx, y, z - wd / 2], [x0 + (i + 1) * dx + wd * 0.5, y, z + wd / 2], [x0 + i * dx + wd * 0.5, y, z + wd / 2], [0, 1, 0]);
  }
  /** Solarpaneel (geneigt, mit Zellenlinien). */
  function solar(b, P, x, y, z, w, d) {
    b.pbox(P.dark, w, 0.02, d, x, y + 0.04, z, 0, -0.35).pbox('#27466e', w - 0.04, 0.012, d - 0.04, x, y + 0.052, z, 0, -0.35);
    b.pbox(P.metal, 0.02, 0.06, 0.02, x, y, z + d * 0.4).pbox(P.metal, 0.02, 0.1, 0.02, x, y, z - d * 0.4);
  }
  /** Rundumleuchte / Warnlicht (leuchtend). */
  function beacon(g, col, x, y, z, r) { g.ico(col, r || 0.035, x, y, z, 1, 1, 1, 1); }
  /** Teamzeichen auf Flachdächern: Raute in Teamfarbe mit weißem Kern (nur 4 Dreiecke, aus der Kamera gut lesbar). */
  function insignia(b, T, P, x, y, z, sx, sz) {
    b.quad(T.team, [x - sx, y, z], [x, y, z - sz], [x + sx, y, z], [x, y, z + sz], [0, 1, 0]);
    b.quad(P.pan, [x - sx * 0.46, y + 0.002, z], [x, y + 0.002, z - sz * 0.46], [x + sx * 0.46, y + 0.002, z], [x, y + 0.002, z + sz * 0.46], [0, 1, 0]);
  }
  /** Dachlüfter (rund, mit Schlitzen). */
  function roofFan(b, P, x, y, z, r) {
    b.cylB(P.body2, r, 0.07, 10, x, y, z, 0.012).cylB(P.dark, r * 0.78, 0.014, 10, x, y + 0.07, z, 0.004);
    b.top(P.metal, x - r * 0.7, z, x + r * 0.7, z, y + 0.0865, 0.012).top(P.metal, x, z - r * 0.7, x, z + r * 0.7, y + 0.0865, 0.012);
  }
  /** Fahnenmast mit Teamflagge (statisch). */
  function flagPole(b, T, P, x, z, hgt) {
    b.cyl(P.metal, 0.012, 0.016, hgt, 5, x, 0.06, z).pbox(T.team, 0.24, 0.15, 0.012, x + 0.13, hgt - 0.12, z).pbox(T.teamD, 0.24, 0.025, 0.014, x + 0.13, hgt - 0.12, z).sph(P.metal, 0.02, x, hgt + 0.06, z);
  }

  function buildBuilding(type, fac, color) {
    if (V12B[type]) return buildB12(type, fac, color);   // v1.2 eigene Modelle (Abschnitt „v1.2 Modelle“)
    if (V8M[type]) return buildV8(type, fac, color);   // v0.8 Luftwaffe & Marine
    if (V4B[type]) return buildBuildingV4(type, fac, color);
    if (V5B[type]) return buildBuildingV5(type, fac, color);
    var P = PAL[fac], T = teamCols(color), syn = fac === 'syndicate', bd = D.BUILDINGS[type];
    var b = new MB(), g = new MB(), M = { parts: {}, h: BH[type] || 1 }, w = bd.w, h = bd.h, i, k;
    var hd, br, GC = GLOWC[fac];
    slab(b, P, w, h, T);
    if (type === 'hq') {
      if (!syn) {
        // Sockelgeschoss
        b.box(P.body2, 2.34, 0.1, 1.84, -0.1, 0.06, 0.2).box(P.body, 2.3, 0.5, 1.8, -0.1, 0.16, 0.2).box(T.team, 2.34, 0.05, 1.84, -0.1, 0.6, 0.2).box(P.roof, 2.34, 0.07, 1.84, -0.1, 0.65, 0.2);
        for (k = -1; k <= 1; k += 2) { b.pbox(P.pan, 2.34, 0.08, 0.04, -0.1, 0.72, 0.2 + k * 0.9); b.pbox(P.pan, 0.04, 0.08, 1.84, -0.1 + k * 1.15, 0.72, 0.2); }
        winS(b, g, P, -1.0, 0.8, 0.22, 1.1, 7, 0.19, 0.15, 0.55, 1); winS(b, g, P, -1.0, 0.8, 0.43, 1.1, 7, 0.19, 0.12, 0.45, 7);
        winE(b, g, P, -0.5, 0.9, 0.22, 1.05, 5, 0.19, 0.15, 0.5, 4, 1); winE(b, g, P, -0.5, 0.9, 0.43, 1.05, 5, 0.19, 0.12, 0.4, 11, 1);
        for (i = 0; i < 8; i++) b.pbox(P.pan, 0.026, 0.52, 0.026, -1.1 + i * 0.2575 - 0.0, 0.14, 1.108);
        insignia(b, T, P, -0.55, 0.722, 0.05, 0.42, 0.42);
        // Eingang mit Vordach
        b.box(T.team, 1.0, 0.05, 0.5, -0.1, 0.46, 1.32).pbox(P.metal, 0.04, 0.4, 0.04, -0.56, 0.06, 1.52).pbox(P.metal, 0.04, 0.4, 0.04, 0.36, 0.06, 1.52).pbox(P.dark, 0.5, 0.32, 0.03, -0.1, 0.06, 1.1);
        b.pbox('#9aa0a4', 0.8, 0.03, 0.3, -0.1, 0.06, 1.3).pbox('#8d9296', 0.8, 0.03, 0.15, -0.1, 0.06, 1.45);
        // Dach: Klimageräte, Solar, Schüssel
        acUnit(b, P, -0.95, 0.72, 0.8); acUnit(b, P, -0.65, 0.72, 0.8); roofFan(b, P, -1.0, 0.72, 0.4, 0.09);
        solar(b, P, -1.0, 0.72, -0.4, 0.5, 0.3); solar(b, P, -0.4, 0.72, -0.4, 0.5, 0.3); solar(b, P, 0.2, 0.72, 0.6, 0.4, 0.3);
        b.box(P.glass, 0.5, 0.04, 0.2, -0.1, 0.72, 0.1).box(P.body2, 0.3, 0.16, 0.3, 0.4, 0.72, 0.8).cylB(P.metal, 0.07, 0.04, 6, 0.9, 0.72, 0.8).dome(P.pan, 0.1, 0.9, 0.76, 0.8, 1, 0.5, 1, 8);
        // Turm
        b.box(P.body2, 1.0, 0.62, 0.9, 0.55, 0.72, -0.35).box(T.team, 1.04, 0.05, 0.94, 0.55, 1.25, -0.35).box(P.roof, 1.04, 0.06, 0.94, 0.55, 1.3, -0.35);
        for (i = 0; i < 5; i++) { b.pbox(P.glass, 0.17, 0.46, 0.012, 0.24 + i * 0.155, 0.78, 0.108); b.pbox(P.pan, 0.014, 0.58, 0.022, 0.165 + i * 0.155, 0.74, 0.108); }
        for (i = 0; i < 4; i++) { b.pbox(P.glass, 0.012, 0.46, 0.17, 1.058, 0.78, -0.64 + i * 0.22); b.pbox(P.pan, 0.022, 0.58, 0.014, 1.058, 0.74, -0.75 + i * 0.22); }
        for (i = 0; i < 5; i++) if (hsh(i + 2.2) < 0.6) g.pbox(WINLIT, 0.15, 0.1, 0.012, 0.24 + i * 0.155, 0.86 + (i % 2) * 0.16, 0.116);
        insignia(b, T, P, 0.35, 1.362, -0.35, 0.2, 0.25);
        b.cylB(P.dark, 0.07, 0.15, 6, 0.55, 1.36, -0.35).cyl(P.metal, 0.012, 0.016, 0.55, 5, 0.93, 1.36, -0.62); beacon(g, '#ff5a3c', 0.93, 1.94, -0.62, 0.032);
        b.pbox(P.metal, 0.3, 0.012, 0.012, 0.93, 1.72, -0.62).pbox(P.metal, 0.012, 0.012, 0.3, 0.93, 1.62, -0.62);
        // Hubschrauberlandeplatz + Fahne
        b.cylB('#4a5560', 0.2, 0.03, 12, 1.27, 0.06, 0.75, 0.006).top('#e8ecef', 1.2, 0.75, 1.34, 0.75, 0.0915, 0.03).top('#e8ecef', 1.2, 0.67, 1.2, 0.83, 0.0915, 0.03).top('#e8ecef', 1.34, 0.67, 1.34, 0.83, 0.0915, 0.03);
        flagPole(b, T, P, -1.3, 1.3, 0.85);
      } else {
        b.prism(P.body, [[-1.3, 0.06], [1.3, 0.06], [1.14, 0.64], [-1.14, 0.64]], 2.2, 0, 0, 0.1);
        b.box(P.body2, 2.34, 0.07, 2.06, 0, 0.28, 0.1).box(T.team, 2.36, 0.08, 2.08, 0, 0.36, 0.1).box(P.roof, 2.12, 0.09, 1.86, 0, 0.64, 0.1);
        rivets(b, P.metal, -1.1, 1.1, 0.5, 1.205, 10); rivets(b, P.metal, -1.1, 1.1, 0.16, 1.205, 10);
        for (i = -2; i <= 2; i++) b.box(P.body2, 0.14, 0.52, 0.12, i * 0.5, 0.06, 1.22);                                      // Strebepfeiler
        b.box(P.dark, 0.64, 0.4, 0.07, 0, 0.06, 1.2).box(P.rust, 0.7, 0.05, 0.1, 0, 0.46, 1.22); hazardX(b, -0.32, 0.32, 1.34, 0.062, 0.1);
        g.pbox('#ffb23c', 0.1, 0.06, 0.02, -0.46, 0.4, 1.235).pbox('#ffb23c', 0.1, 0.06, 0.02, 0.46, 0.4, 1.235);
        b.pbox(T.team, 0.3, 0.5, 0.02, -0.8, 0.12, 1.24).pbox(T.team, 0.3, 0.5, 0.02, 0.8, 0.12, 1.24);                       // Banner
        for (i = 0; i < 3; i++) b.top(P.dark, -0.95, 0.4 + i * 0.5, 0.95, 0.4 + i * 0.5, 0.7, 0.014);
        b.box(P.body2, 1.0, 0.5, 0.9, -0.4, 0.73, -0.3).box(P.dark, 1.06, 0.07, 0.96, -0.4, 1.0, -0.3).box(T.team, 1.04, 0.07, 0.94, -0.4, 1.2, -0.3).box(P.roof, 1.0, 0.05, 0.9, -0.4, 1.27, -0.3);
        for (i = 0; i < 4; i++) g.pbox('#ffb23c', 0.16, 0.05, 0.012, -0.7 + i * 0.2, 0.88, 0.158);
        for (i = 0; i < 4; i++) b.pbox(P.dark, 0.18, 0.08, 0.012, -0.7 + i * 0.2, 0.88, 0.152);
        rivets(b, P.metal, -0.8, 0, 0.78, 0.16, 5);
        b.cyl(P.rust, 0.11, 0.13, 0.7, 7, 0.82, 0.73, 0.5).cylB(P.dark, 0.13, 0.05, 7, 0.82, 1.43, 0.5, 0.008).cyl(P.rust, 0.1, 0.12, 0.5, 7, 1.02, 0.73, 0.2).cylB(P.dark, 0.12, 0.05, 7, 1.02, 1.23, 0.2, 0.008);
        g.cyl('#ff7a22', 0.07, 0.07, 0.02, 6, 0.82, 1.47, 0.5); g.cyl('#ff7a22', 0.06, 0.06, 0.02, 6, 1.02, 1.27, 0.2);
        b.cyl(P.metal, 0.014, 0.018, 0.6, 5, -0.8, 1.32, -0.55); beacon(g, '#ff3a2a', -0.8, 1.94, -0.55, 0.03);
        b.cylB(P.dark, 0.1, 0.07, 6, 0.5, 0.73, -0.7).pbox(P.dark, 0.3, 0.03, 0.03, 0.62, 0.84, -0.7).pbox(P.dark, 0.3, 0.03, 0.03, 0.62, 0.8, -0.65);   // Flak
        sandbags(b, 0.75, 1.15, 1.25, 1, false); sandbags(b, -1.2, -0.85, 1.25, 1, false);
        flagPole(b, T, P, 1.25, 1.35, 0.9);
      }
      hd = new MB();
      hd.cylB(P.dark, 0.05, 0.1, 6, 0, 0, 0, 0.01).add(new THREE.CylinderGeometry(0.28, 0.05, 0.1, 12, 1, true), P.metal, 0.04, 0.2, 0, 0, 0, -0.6).cylX(T.team, 0.025, 0.025, 0.05, 6, 0.14, 0.31, 0, 0).pbox(P.metal, 0.04, 0.04, 0.04, 0.17, 0.33, 0).pbox(P.dark, 0.012, 0.18, 0.012, 0.12, 0.15, 0, 0, 0, -0.6);
      M.parts.radar = hd.geo(false); M.radarAt = syn ? [-0.4, 1.35, -0.3] : [0.55, 1.52, -0.35];
    } else if (type === 'power') {
      var tower = syn ? [[0.42, 0], [0.36, 0.3], [0.29, 0.62], [0.3, 0.85], [0.33, 1.0], [0.3, 1.0]] : [[0.4, 0], [0.33, 0.35], [0.27, 0.7], [0.29, 0.92], [0.31, 1.08], [0.28, 1.08]];
      var tc = syn ? '#a49d8c' : '#e6eaec', ty = 0.06, tz = syn ? 1.0 : 1.08, tcc = [[-0.45, -0.42], [0.42, -0.35]];
      for (i = 0; i < 2; i++) {
        b.surf('conc'); b.lathe(tc, tower, syn ? 9 : 14, tcc[i][0], ty, tcc[i][1]); b.surf(null);
        b.cyl('#3a3a38', 0.27, 0.27, 0.01, 12, tcc[i][0], tz + ty, tcc[i][1]);
        b.lathe(T.team, [[0.352, 0], [0.34, 0.09]], 14, tcc[i][0], 0.34, tcc[i][1]);
        b.cylB(P.dark, 0.39, 0.1, 10, tcc[i][0], ty, tcc[i][1], 0.015);
        g.lathe(syn ? '#ff8a2a' : '#7fdcff', [[0.3725, 0], [0.362, 0.03]], 14, tcc[i][0], 0.52, tcc[i][1]);
      }
      b.box(syn ? P.body : P.body2, 1.6, 0.34, 0.5, 0, 0.06, 0.58).box(T.team, 1.64, 0.05, 0.54, 0, 0.3, 0.58).box(P.roof, 1.6, 0.06, 0.5, 0, 0.35, 0.58);
      winS(b, g, P, -0.6, 0.6, 0.15, 0.83, 5, 0.15, 0.1, 0.5, 8);
      for (i = 0; i < 3; i++) { b.cylB(P.dark, 0.1, 0.14, 8, -0.5 + i * 0.5, 0.41, 0.58, 0.012); b.cylB('#fbbf24', 0.06, 0.03, 8, -0.5 + i * 0.5, 0.55, 0.58, 0.006); }
      b.pbox(T.team, 1.5, 0.014, 0.05, 0, 0.415, 0.8);
      // Trafostation + Leitungen
      b.box(P.body2, 0.34, 0.26, 0.26, 0.72, 0.06, -0.78).box(P.dark, 0.36, 0.04, 0.28, 0.72, 0.32, -0.78);
      for (i = 0; i < 3; i++) b.cyl(P.metal, 0.018, 0.022, 0.2, 5, 0.62 + i * 0.1, 0.36, -0.78).sph('#d8d0c0', 0.03, 0.62 + i * 0.1, 0.57, -0.78);
      b.cylX(P.metal, 0.022, 0.022, 0.9, 6, 0.05, 0.14, -0.05).cylX(P.metal, 0.018, 0.018, 0.8, 6, 0.0, 0.1, 0.05);
      if (syn) { rivets(b, P.metal, -0.7, 0.7, 0.2, 0.835, 8); b.box(P.rust, 0.2, 0.3, 0.2, -0.8, 0.06, 0.98); }
      else solar(b, P, 0.75, 0.35, 0.58, 0.5, 0.3);
      M.steam = [[-0.45, tz + 0.06, -0.42], [0.42, tz + 0.06, -0.35]];
    } else if (type === 'refinery') {
      var sc = syn ? P.body : '#cfd4d8';
      for (i = 0; i < 2; i++) {
        var sx = -0.95 + i * 0.7;
        b.surf('metal'); b.cylB(sc, 0.3, 0.85, 14, sx, 0.06, -0.4, 0.02).lathe(sc, [[0.3, 0], [0.24, 0.1], [0.12, 0.17], [0, 0.19]], 14, sx, 0.91, -0.4); b.surf(null);
        b.cyl(T.team, 0.307, 0.307, 0.09, 14, sx, 0.6, -0.4).cyl(P.dark, 0.305, 0.305, 0.03, 14, sx, 0.3, -0.4).cyl(P.dark, 0.305, 0.305, 0.03, 14, sx, 0.82, -0.4);
        b.cyl(P.metal, 0.02, 0.02, 0.9, 4, sx + 0.27, 0.06, -0.12).pbox(P.dark, 0.1, 0.012, 0.012, sx + 0.27, 0.9, -0.12); b.pbox(P.metal, 0.012, 0.04, 0.3, sx + 0.3, 0.3, -0.25);
      }
      b.cylB(P.dark, 0.05, 0.5, 6, -0.6, 0.06, -0.1, 0.005);
      b.box(syn ? P.body2 : P.body, 1.0, 0.55, 0.9, 0.8, 0.06, -0.3).box(T.team, 1.04, 0.07, 0.94, 0.8, 0.5, -0.3);
      b.prism(P.roof, [[-0.5, 0.61], [0.5, 0.61], [0.5, 0.7], [-0.5, 0.86]], 0.9, 0.8, 0, -0.3, 0, 0.012);
      winS(b, g, P, 0.45, 1.15, 0.2, 0.15, 3, 0.16, 0.12, 0.35, 3);
      b.cylX(P.metal, 0.05, 0.05, 1.3, 8, -0.3, 0.5, -0.05).cylX(P.metal, 0.04, 0.04, 1.3, 8, -0.3, 0.32, 0.0);
      for (i = 0; i < 4; i++) { b.pbox(P.dark, 0.04, 0.26, 0.04, -0.85 + i * 0.4, 0.06, -0.05); b.pbox(P.dark, 0.1, 0.02, 0.1, -0.85 + i * 0.4, 0.32, -0.05); }
      b.cylB(P.dark, 0.07, 0.55, 8, 1.2, 0.61, -0.62, 0.01).cylB(P.metal, 0.05, 0.12, 8, 1.2, 1.16, -0.62, 0.008); beacon(g, '#ff9a2e', 1.2, 1.32, -0.62, 0.05);        // Fackel
      b.cylB(P.rust, 0.1, 0.16, 8, 0.55, 0.61, -0.7, 0.01).cylB(P.dark, 0.05, 0.1, 6, 0.55, 0.77, -0.7);
      // Abladefläche vorn mit Warnstreifen
      b.pbox('#3f4244', 2.6, 0.03, 0.55, 0, 0.06, 0.66); hazardX(b, -1.25, 1.25, 0.93, 0.095, 0.08); hazardX(b, -1.25, 1.25, 0.4, 0.095, 0.05);
      b.box(T.team, 0.5, 0.025, 0.4, 0.2, 0.09, 0.66).top(P.pan, 0.0, 0.66, 0.4, 0.66, 0.1165, 0.03);
      b.box(P.body2, 0.22, 0.3, 0.2, 1.3, 0.06, 0.7).pbox(P.dark, 0.12, 0.06, 0.012, 1.3, 0.24, 0.805);
      if (syn) rivets(b, P.metal, 0.35, 1.25, 0.4, 0.155, 6);
      // v0.8 Seitengleichheit: Sammler docken auch an der Nordseite an (Mittelspalte) → Annahmeklappe + Warnstreifen an der Nordkante
      b.pbox('#3f4244', 0.9, 0.03, 0.22, 0, 0.06, -0.86); hazardX(b, -0.45, 0.45, -0.95, 0.095, 0.05);
      b.box(P.body2, 0.36, 0.22, 0.12, 0, 0.06, -0.74).pbox(P.dark, 0.26, 0.12, 0.012, 0, 0.1, -0.806).pbox(T.team, 0.38, 0.03, 0.124, 0, 0.28, -0.74);
    } else if (type === 'barracks') {
      if (!syn) {
        b.box(P.body, 1.6, 0.42, 1.15, 0, 0.06, -0.1).box(P.body2, 1.64, 0.08, 1.19, 0, 0.06, -0.1);
        var sl = Math.atan2(0.34, 0.66), sw = Math.sqrt(0.66 * 0.66 + 0.34 * 0.34) + 0.06;
        b.prism(P.body2, [[-0.66, 0.48], [0.66, 0.48], [0, 0.82]], 1.56, 0, 0, -0.1, Math.PI / 2, 0.01);
        b.pbox(T.team, 1.82, 0.05, sw, 0, 0.64, 0.23, 0, sl).pbox(T.teamD, 1.82, 0.05, sw, 0, 0.64, -0.43, 0, -sl).pbox(P.pan, 1.84, 0.05, 0.08, 0, 0.805, -0.1);
        b.pbox(P.glass, 0.34, 0.02, 0.2, -0.5, 0.675, 0.24, 0, sl).pbox(P.glass, 0.34, 0.02, 0.2, 0.0, 0.675, 0.24, 0, sl);
        for (i = 0; i < 2; i++) b.pbox(P.dark, 0.34, 0.01, 0.014, -0.5 + i * 0.5, 0.688, 0.24, 0, sl);
        b.cylB(P.body2, 0.06, 0.2, 6, 0.55, 0.6, -0.3, 0.01);
        b.box(P.dark, 0.34, 0.3, 0.05, 0, 0.06, 0.5).box(T.teamD, 0.46, 0.04, 0.2, 0, 0.38, 0.58).pbox(P.metal, 0.03, 0.3, 0.03, -0.2, 0.06, 0.66).pbox(P.metal, 0.03, 0.3, 0.03, 0.2, 0.06, 0.66);
        winS(b, g, P, -0.6, 0.6, 0.22, 0.475, 2, 0.2, 0.12, 0.6, 5); winE(b, g, P, -0.5, 0.3, 0.22, 0.8, 2, 0.2, 0.12, 0.5, 6, 1);
        b.box(P.dark, 0.1, 0.2, 0.1, 0.55, 0.5, 0.0);
      } else {
        b.add(new THREE.CylinderGeometry(0.64, 0.64, 1.56, 12, 1, false, 0, Math.PI), P.body, 0, 0.06, -0.1, 0, 0, Math.PI / 2);
        for (i = 0; i < 5; i++) b.add(new THREE.CylinderGeometry(0.655, 0.655, 0.07, 12, 1, true, 0, Math.PI), i % 2 ? T.team : P.body2, -0.62 + i * 0.31, 0.06, -0.1, 0, 0, Math.PI / 2);
        b.box(P.dark, 0.08, 0.34, 0.42, 0.78, 0.06, -0.1).box(T.team, 0.09, 0.06, 0.44, 0.79, 0.44, -0.1).box(P.rust, 0.12, 0.05, 0.5, 0.74, 0.5, -0.1);
        b.pbox(P.dark, 1.5, 0.04, 0.04, 0, 0.04, 0.54);
        g.pbox('#ffb23c', 0.016, 0.06, 0.1, 0.82, 0.3, 0.2).pbox('#ffb23c', 0.016, 0.06, 0.1, 0.82, 0.3, -0.4);
        b.cylB(P.rust, 0.04, 0.3, 6, -0.4, 0.6, -0.1, 0.005);
        rivetsX(b, P.metal, -0.28, 0.1, 0.2, 0.808, 4);
      }
      for (i = 0; i < 5; i++) b.pbox(i % 2 ? '#b3a27c' : '#a39272', 0.14, 0.08, 0.1, -0.75 + i * 0.15, 0.06, 0.8);   // Sandsäcke
      b.pbox('#a39272', 0.14, 0.08, 0.1, -0.67, 0.14, 0.8).pbox('#b3a27c', 0.14, 0.08, 0.1, -0.52, 0.14, 0.8).pbox('#a39272', 0.14, 0.08, 0.1, -0.37, 0.14, 0.8);
      flagPole(b, T, P, -0.9, 0.86, 0.8);
      // v0.8: Nordausgang (Spalte tx → vor der Spiegelung x = +0.5)
      b.box(P.dark, 0.32, 0.28, 0.04, 0.45, 0.06, syn ? -0.75 : -0.69).pbox(T.teamD, 0.4, 0.04, 0.08, 0.45, 0.36, syn ? -0.76 : -0.71);
    } else if (type === 'factory') {
      b.box(syn ? P.body : P.body2, 2.6, 0.62, 2.0, 0, 0.06, -0.2).box(syn ? P.body2 : P.body, 2.64, 0.1, 2.04, 0, 0.06, -0.2).box(T.team, 2.64, 0.07, 2.04, 0, 0.5, -0.2);
      for (i = 0; i < 4; i++) { // Sheddach, Glasflächen nach Süden (zur Kamera)
        var rz = -1.2 + i * 0.5;
        b.prism(i % 2 ? T.team : P.roof, [[-0.25, 0.68], [0.25, 0.68], [0.25, 0.92]], 2.6, 0, 0, rz + 0.25, Math.PI / 2, 0.012);
        b.pbox(P.glass, 2.5, 0.2, 0.012, 0, 0.69, rz + 0.51, 0, -0.35);
        g.pbox('#9ad7ff', 0.9, 0.06, 0.01, 0.5, 0.78, rz + 0.51 + 0.002);
      }
      b.box(P.roof, 2.6, 0.06, 2.0, 0, 0.62, -0.2).box(P.dark, 1.04, 0.5, 0.05, 0.2, 0.06, 0.81).box('#fbbf24', 1.1, 0.06, 0.07, 0.2, 0.56, 0.83);
      hazardX(b, -0.35, 0.75, 1.05, 0.062, 0.1);
      for (i = 0; i < 3; i++) b.pbox(P.dark, 1.0, 0.008, 0.016, 0.2, 0.18 + i * 0.12, 0.8355);
      b.cylB(P.dark, 0.1, 0.75, 8, -1.05, 0.68, -0.95, 0.012).cylB(P.metal, 0.12, 0.05, 8, -1.05, 1.43, -0.95, 0.01); beacon(g, '#ff9a2e', -1.05, 1.5, -0.95, 0.04);
      // Kran
      b.pbox('#d97706', 0.05, 0.9, 0.05, 1.3, 0.06, 1.25).pbox('#d97706', 0.05, 0.9, 0.05, 1.3, 0.06, 0.6).pbox('#d97706', 0.07, 0.07, 0.75, 1.3, 0.94, 0.92).pbox('#d97706', 0.05, 0.05, 0.05, 1.3, 0.8, 0.92);
      b.pbox(P.dark, 0.12, 0.1, 0.12, 1.3, 0.78, 0.9).pbox(P.metal, 0.012, 0.3, 0.012, 1.3, 0.5, 0.9);
      b.box(P.body2, 0.3, 0.3, 0.3, 1.1, 0.06, 1.15, 0.3);
      if (syn) { rivets(b, P.metal, -1.2, 1.2, 0.45, 0.805, 12); b.box(P.body2, 0.3, 0.3, 0.3, -1.15, 0.06, 1.1).box(P.rust, 0.3, 0.2, 0.3, -0.8, 0.06, 1.15); b.cylB(P.rust, 0.08, 0.5, 6, 0.8, 0.68, -0.9, 0.01); }
      else { winS(b, g, P, -1.2, -0.5, 0.3, 0.805, 3, 0.15, 0.15, 0.6, 9); solar(b, P, 0.95, 0.62, -0.8, 0.5, 0.3); solar(b, P, 0.35, 0.62, -0.8, 0.5, 0.3); }
      roofFan(b, P, -0.9, 0.92, -0.45, 0.1); roofFan(b, P, 0.9, 0.92, -0.45, 0.1); acUnit(b, P, -0.2, 0.68, -0.75);
      // v0.8: Nordtor (Mittelspalte) – Einheiten verlassen das Werk bei nördlichem Sammelpunkt nach Norden
      b.box(P.dark, 0.9, 0.46, 0.04, 0, 0.06, -1.22).box('#fbbf24', 0.96, 0.05, 0.06, 0, 0.52, -1.23); hazardX(b, -0.45, 0.45, -1.36, 0.062, 0.08);
    } else if (type === 'turret') {
      b.cylB(P.conc, 0.42, 0.14, 10, 0, 0.04, 0, 0.02).cylB(T.team, 0.44, 0.04, 10, 0, 0.17, 0, 0.01).cylB(P.body2, 0.34, 0.06, 10, 0, 0.21, 0, 0.012);
      for (i = 0; i < 4; i++) b.pbox(P.dark, 0.1, 0.06, 0.06, Math.cos(i * 1.57 + 0.78) * 0.4, 0.08, Math.sin(i * 1.57 + 0.78) * 0.4, -(i * 1.57 + 0.78));
      hd = new MB(); br = new MB();
      if (!syn) {
        hd.prism(P.body2, [[-0.22, 0.27], [0.14, 0.27], [0.22, 0.32], [0.14, 0.44], [-0.2, 0.44], [-0.26, 0.36]], 0.34, 0, 0, 0);
        hd.box(T.team, 0.18, 0.016, 0.26, -0.06, 0.44, 0).box(P.body, 0.12, 0.08, 0.06, 0.1, 0.32, 0.15, -0.3).box(P.body, 0.12, 0.08, 0.06, 0.1, 0.32, -0.15, 0.3);
        hd.pbox(P.glass, 0.02, 0.04, 0.08, 0.2, 0.36, 0.0); hd.box(P.dark, 0.08, 0.1, 0.14, 0.19, 0.28, 0).cyl(P.metal, 0.006, 0.008, 0.2, 4, -0.18, 0.44, 0.1);
        br.cylX(P.dark, 0.028, 0.032, 0.5, 8, 0.4, 0.34, 0).cylX(P.metal, 0.034, 0.034, 0.1, 8, 0.42, 0.34, 0).box(P.dark, 0.08, 0.06, 0.06, 0.66, 0.31, 0);
      } else {
        hd.cylB(P.body, 0.24, 0.2, 10, 0, 0.27, 0, 0.012).box(P.body2, 0.24, 0.14, 0.3, 0.06, 0.3, 0).cylB(T.team, 0.26, 0.03, 10, 0, 0.47, 0, 0.008);
        rivets(hd, P.metal, -0.15, 0.15, 0.4, 0.17, 4); hd.box(P.rust, 0.12, 0.08, 0.1, -0.16, 0.47, 0.08);
        br.cylX(P.dark, 0.038, 0.042, 0.46, 8, 0.38, 0.36, 0).cylX(P.rust, 0.056, 0.056, 0.08, 8, 0.38, 0.36, 0).cylX(P.dark, 0.05, 0.05, 0.12, 8, 0.64, 0.36, 0).box(P.dark, 0.08, 0.08, 0.08, 0.66, 0.31, 0);
      }
      M.parts.head = hd.geo(); M.parts.barrel = br.geo(); M.muzzle = [0.72, 0.34]; M.recoil = 0.1;
    } else if (type === 'mg') {
      b.cylB('#5b5446', 0.3, 0.04, 10, 0, 0.04, 0, 0.01);
      for (var ly = 0; ly < 2; ly++) for (i = 0; i < 11; i++) {
        var a = (i + ly * 0.5) / 11 * Math.PI * 2;
        if (Math.cos(a) > 0.9 && ly === 1) continue;
        b.pbox(i % 2 ? '#b3a27c' : '#a39272', 0.2, 0.1, 0.12, Math.cos(a) * 0.38, 0.05 + ly * 0.1, Math.sin(a) * 0.38, -a + Math.PI / 2);
      }
      b.pbox(T.team, 0.14, 0.04, 0.14, -0.28, 0.25, 0);
      hd = new MB();
      hd.cyl(P.dark, 0.02, 0.05, 0.22, 4, 0, 0.04, 0).box(P.body2, 0.16, 0.08, 0.1, 0, 0.24, 0).box(T.team, 0.04, 0.14, 0.24, 0.1, 0.2, 0);
      hd.cylX('#1f2326', 0.018, 0.018, 0.3, 6, 0.2, 0.28, 0).pbox('#1f2326', 0.06, 0.06, 0.04, 0.0, 0.2, 0.05).cylX(P.metal, 0.024, 0.024, 0.04, 6, 0.36, 0.28, 0).pbox(P.dark, 0.05, 0.07, 0.03, 0.05, 0.22, -0.06);
      M.parts.head = hd.geo(); M.muzzle = [0.37, 0.28]; M.recoil = 0.02;
    }
    M.parts.body = b.geo();
    var gg = g.geo(false); if (g.list.length) { M.parts.glow = gg; M.lit = true; }
    return M;
  }

  /** Kleine Parabolschüssel (Kegelstumpf + Scheibe + Zuleitung), Ursprung = Drehpunkt, Öffnung zeigt nach +y. */
  function dishGeo(rad, col, rim, arm) {
    var d = new MB();
    d.cyl('#59636b', 0.03, 0.04, 0.16 * rad / 0.3, 6, 0, 0, 0);
    d.add(new THREE.CylinderGeometry(rad, rad * 0.22, rad * 0.4, 10), col, 0, 0.16 * rad / 0.3 + rad * 0.2, 0);
    d.add(new THREE.CylinderGeometry(rad, rad, 0.02, 10), rim, 0, 0.16 * rad / 0.3 + rad * 0.4, 0);
    d.cyl(arm, 0.012, 0.012, rad * 0.9, 4, 0, 0.16 * rad / 0.3 + rad * 0.4, 0);
    d.box(arm, 0.05, 0.04, 0.05, 0, 0.16 * rad / 0.3 + rad * 0.4 + rad * 0.9, 0);
    return d.geo(false);
  }
  /** Schlanker Gitterturm (4 Streben, konisch) mit Querstreben. */
  function lattice(b, col, x, z, w0, w1, y0, y1, levels, t) {
    var cs = [[-1, -1], [1, -1], [1, 1], [-1, 1]], i, k;
    for (i = 0; i < 4; i++) strut(b, col, x + cs[i][0] * w0, y0, z + cs[i][1] * w0, x + cs[i][0] * w1, y1, z + cs[i][1] * w1, t);
    for (k = 1; k <= levels; k++) {
      var f = k / levels, y = y0 + (y1 - y0) * f, w = w0 + (w1 - w0) * f;
      for (i = 0; i < 4; i++) { var c0 = cs[i], c1 = cs[(i + 1) % 4]; strut(b, col, x + c0[0] * w, y, z + c0[1] * w, x + c1[0] * w, y, z + c1[1] * w, t * 0.7); }
    }
  }
  /** Gefahrenstreifen-Rahmen (gelb/schwarz) um eine Öffnung. */
  function hazardFrame(b, cx, cz, w, d, y) {
    var n = Math.round(w / 0.16), i;
    for (i = 0; i < n; i++) { var x = cx - w / 2 + (i + 0.5) * w / n; b.box(i % 2 ? '#facc15' : '#1f2937', w / n, 0.02, 0.1, x, y, cz - d / 2 - 0.05).box(i % 2 ? '#1f2937' : '#facc15', w / n, 0.02, 0.1, x, y, cz + d / 2 + 0.05); }
    n = Math.round(d / 0.16);
    for (i = 0; i < n; i++) { var z = cz - d / 2 + (i + 0.5) * d / n; b.box(i % 2 ? '#facc15' : '#1f2937', 0.1, 0.02, d / n, cx - w / 2 - 0.05, y, z).box(i % 2 ? '#1f2937' : '#facc15', 0.1, 0.02, d / n, cx + w / 2 + 0.05, y, z); }
  }

  function buildBuildingV4(type, fac, color) {
    // W10: im Stil der v0.7-Basisgebäude neu gestaltet (Fundament mit Teamecken, Geschossbänder, beleuchtete Fenster = Teil wlit,
    // Dachaufbauten, Teamzeichen). Animations-Haken unverändert: dish (xp spin/dish), cell (xp, 8 Ladezellen vorn), door (doorL/doorR,
    // Schacht bei z = −0.1, Oberkante 0.76), msl/mslf (Rakete), glow (Helligkeit je Frame in drawBldV4), emitAt.
    var P = PAL[fac], T = teamCols(color), syn = fac === 'syndicate', sz = V4B[type], w = sz[0], h = sz[1], hi = HI();
    var b = new MB(), g = new MB(), wl = new MB(), M = { parts: {}, xparts: {}, xp: [], h: BH[type] || 1, lo: !hi }, i, k, sd, GC = GLOWC[fac];
    slab(b, P, w, h, T);
    if (type === 'techcenter') {
      if (!syn) {                                                     // Koalition: Forschungslabor mit Glasfassade, Laborturm, Sternwarte, Gittermast
        b.box(P.body2, 2.3, 0.08, 1.5, -0.15, 0.06, 0.45).box(P.body, 2.22, 0.5, 1.42, -0.15, 0.14, 0.45);
        b.box(T.team, 2.26, 0.05, 1.46, -0.15, 0.37, 0.45).box(P.roof, 2.28, 0.06, 1.48, -0.15, 0.64, 0.45);
        for (sd = -1; sd <= 1; sd += 2) { b.pbox(P.pan, 2.28, 0.06, 0.04, -0.15, 0.7, 0.45 + sd * 0.72); b.pbox(P.pan, 0.04, 0.06, 1.48, -0.15 + sd * 1.12, 0.7, 0.45); }
        winS(b, wl, P, -1.1, 0.3, 0.18, 1.16, 6, 0.19, 0.13, 0.5, 2); winS(b, wl, P, -1.1, 0.3, 0.45, 1.16, 6, 0.19, 0.12, 0.6, 5);
        winE(b, wl, P, -0.05, 0.95, 0.18, 0.96, 4, 0.19, 0.13, 0.45, 3, 1); winE(b, wl, P, -0.05, 0.95, 0.45, 0.96, 4, 0.19, 0.12, 0.55, 9, 1);
        for (i = 0; i < 7; i++) b.pbox(P.pan, 0.022, 0.5, 0.022, -1.2 + i * 0.235, 0.14, 1.168);                                             // Fassadenpfosten
        // Eingang mit Vordach (Teamfarbe)
        b.pbox(P.dark, 0.42, 0.32, 0.02, 0.66, 0.14, 1.162).pbox(P.glass, 0.34, 0.26, 0.012, 0.66, 0.14, 1.175);
        b.box(T.team, 0.66, 0.045, 0.38, 0.66, 0.47, 1.33).pbox(P.metal, 0.035, 0.41, 0.035, 0.38, 0.06, 1.48).pbox(P.metal, 0.035, 0.41, 0.035, 0.94, 0.06, 1.48);
        b.pbox('#9aa0a4', 0.6, 0.03, 0.3, 0.66, 0.06, 1.3);
        // Laborturm auf dem Dach mit Technik-Lichtband, darauf die drehende Schüssel
        b.box(P.body2, 1.1, 0.4, 0.8, -0.62, 0.7, 0.3).box(T.team, 1.14, 0.05, 0.84, -0.62, 1.04, 0.3).box(P.roof, 1.14, 0.05, 0.84, -0.62, 1.09, 0.3);
        b.pbox(P.dark, 1.0, 0.14, 0.02, -0.62, 0.8, 0.705).pbox(P.dark, 0.02, 0.14, 0.7, -0.065, 0.8, 0.3);
        g.pbox(GC, 0.94, 0.08, 0.012, -0.62, 0.83, 0.716).pbox(GC, 0.012, 0.08, 0.64, -0.055, 0.83, 0.3);
        insignia(b, T, P, -0.86, 1.142, 0.05, 0.16, 0.16);
        acUnit(b, P, 0.3, 0.7, 0.95); acUnit(b, P, 0.6, 0.7, 0.95); roofFan(b, P, 0.75, 0.7, 0.05, 0.09);
        insignia(b, T, P, 0.42, 0.702, 0.42, 0.2, 0.2);
        solar(b, P, -0.6, 0.7, 0.95, 0.5, 0.26);
        // Sternwarte (Kuppel mit leuchtendem Spalt) hinten rechts
        b.cyl(P.conc, 0.5, 0.54, 0.22, 12, 0.82, 0.06, -0.86).add(new THREE.CylinderGeometry(0.545, 0.545, 0.05, 12, 1, true), T.team, 0.82, 0.25, -0.86);
        b.dome('#e4e9ec', 0.48, 0.82, 0.28, -0.86, 1, 1, 1, 12);
        b.pbox(P.dark, 0.12, 0.42, 0.06, 0.82, 0.32, -0.4, 0, -0.35);
        g.pbox(GC, 0.05, 0.36, 0.02, 0.82, 0.35, -0.37, 0, -0.35);
        // Kryotanks + Leitung, Gittermast mit Bake
        for (i = 0; i < 2; i++) { b.cyl(P.metal, 0.13, 0.13, 0.46, 10, -0.15 + i * 0.32, 0.06, -0.95).cyl(T.team, 0.133, 0.133, 0.05, 10, -0.15 + i * 0.32, 0.3, -0.95).dome(P.metal, 0.13, -0.15 + i * 0.32, 0.52, -0.95, 1, 0.5, 1, 10); }
        b.cylZ(P.metal, 0.03, 0.4, 6, 0.0, 0.42, -0.55);
        lattice(b, P.metal, -1.15, -0.95, 0.14, 0.03, 0.06, 1.75, 4, 0.03);
        beacon(g, '#ff5a3c', -1.15, 1.8, -0.95, 0.045);
        if (hi) { for (i = 0; i < 2; i++) { b.cyl(P.dark, 0.012, 0.016, 0.42, 4, 1.3 - i * 2.55, 0.06, 1.35); g.ico(WINLIT, 0.03, 1.3 - i * 2.55, 0.5, 1.35, 1, 1, 1, 0); } }   // Laternen
        M.xparts.dish = dishGeo(0.26, '#dfe5e8', '#f8fafc', P.dark);
        M.xp.push({ p: 'dish', x: -0.42, y: 1.14, z: 0.45, k: 'spin' });
      } else {                                                        // Syndikat: Halle mit Schrägwänden, Reaktor mit Glutring, Schlote, Gittermast
        b.prism(P.body, [[-1.3, 0.06], [1.3, 0.06], [1.16, 0.62], [-1.16, 0.62]], 1.4, 0, 0, 0.55);
        b.box(T.team, 2.34, 0.08, 1.48, 0, 0.32, 0.55).box(P.roof, 2.24, 0.08, 1.32, 0, 0.62, 0.55);
        b.box(P.body2, 2.36, 0.06, 1.5, 0, 0.12, 0.55);
        if (hi) rivets(b, P.metal, -1.05, 1.05, 0.5, 1.236, 9);
        for (i = 0; i < 3; i++) { b.pbox(P.dark, 0.5, 0.1, 0.03, -0.75 + i * 0.75, 0.43, 1.215); g.pbox(GC, 0.42, 0.055, 0.02, -0.75 + i * 0.75, 0.452, 1.228); }   // Glutschlitze
        b.pbox(P.dark, 0.5, 0.3, 0.03, 0, 0.06, 1.27).pbox(P.rust, 0.6, 0.05, 0.08, 0, 0.36, 1.28); hazardX(b, -0.3, 0.3, 1.38, 0.062, 0.09);
        b.pbox(T.team, 0.28, 0.42, 0.02, -1.0, 0.1, 1.24).pbox(T.team, 0.28, 0.42, 0.02, 1.0, 0.1, 1.24);                                      // Banner
        for (i = 0; i < 3; i++) b.top(P.dark, -1.0, 0.1 + i * 0.45, 1.0, 0.1 + i * 0.45, 0.701, 0.014);
        // Aufbau auf dem Dach mit Schüssel
        b.box(P.body2, 0.8, 0.24, 0.5, -0.55, 0.7, 0.6).box(T.team, 0.82, 0.04, 0.52, -0.55, 0.9, 0.6).box(P.rust, 0.84, 0.03, 0.54, -0.55, 0.94, 0.6);
        for (i = 0; i < 3; i++) { b.pbox(P.dark, 0.16, 0.08, 0.012, -0.8 + i * 0.25, 0.78, 0.856); wl.pbox('#ffb23c', 0.13, 0.05, 0.012, -0.8 + i * 0.25, 0.795, 0.862); }
        acUnit(b, P, 0.45, 0.7, 0.35, 0.22); roofFan(b, P, 0.85, 0.7, 0.85, 0.1);
        // Reaktor hinten rechts
        b.cyl(P.body2, 0.5, 0.56, 0.9, 12, 0.62, 0.06, -0.84).cyl(P.dark, 0.52, 0.52, 0.06, 12, 0.62, 0.42, -0.84);
        b.add(new THREE.CylinderGeometry(0.57, 0.57, 0.09, 12, 1, true), T.team, 0.62, 0.3, -0.84);
        g.add(new THREE.CylinderGeometry(0.575, 0.575, 0.045, 12, 1, true), GC, 0.62, 0.66, -0.84);
        b.lathe(P.body2, [[0.5, 0], [0.42, 0.1], [0.24, 0.18], [0.0, 0.2]], 12, 0.62, 0.96, -0.84);
        for (i = 0; i < 8; i++) { var fa = i / 8 * Math.PI * 2; b.pbox(P.dark, 0.05, 0.62, 0.08, 0.62 + Math.cos(fa) * 0.56, 0.12, -0.84 + Math.sin(fa) * 0.56, -fa); }
        // Schlote mit Glut, Rohrleitungen, Gittermast
        b.cyl(P.rust, 0.1, 0.13, 1.2, 8, -0.7, 0.06, -0.62).cyl(P.dark, 0.12, 0.12, 0.05, 8, -0.7, 1.26, -0.62).cyl(P.rust, 0.08, 0.11, 0.95, 8, -0.38, 0.06, -1.02).cyl(P.dark, 0.1, 0.1, 0.05, 8, -0.38, 1.01, -1.02);
        g.cyl('#ff7a22', 0.07, 0.07, 0.02, 6, -0.7, 1.31, -0.62).cyl('#ff7a22', 0.06, 0.06, 0.02, 6, -0.38, 1.06, -1.02);
        b.cylX(P.metal, 0.045, 0.045, 0.9, 8, 0.0, 0.5, -0.45).cylX(P.dark, 0.035, 0.035, 0.9, 6, 0.0, 0.36, -0.36);
        lattice(b, P.metal, -1.18, -1.15, 0.14, 0.04, 0.06, 1.95, 4, 0.035);
        beacon(g, '#ff3a2a', -1.18, 2.0, -1.15, 0.055);
        sandbags(b, 0.7, 1.3, 1.42, 1, false);
        if (hi) { b.box('#a39272', 0.16, 0.14, 0.14, -1.3, 0.06, -0.2).box(P.rust, 0.2, 0.14, 0.2, 1.3, 0.06, 0.0); }
        M.xparts.dish = dishGeo(0.22, '#b8b19b', '#d6d0bd', P.dark);
        M.xp.push({ p: 'dish', x: -0.55, y: 0.97, z: 0.6, k: 'spin' });
      }
    } else if (type === 'orbital') {                                  // Koalition: Uplink-Leitstand, Ladepult (8 Zellen) vorn, Emittermast, drei Schüsseln
      b.box(P.body2, 2.62, 0.08, 1.5, 0, 0.06, 0.12).box(P.body, 2.54, 0.36, 1.44, 0, 0.14, 0.12);
      b.box(T.team, 2.58, 0.05, 1.48, 0, 0.45, 0.12).box(P.roof, 2.6, 0.05, 1.5, 0, 0.5, 0.12);
      for (sd = -1; sd <= 1; sd += 2) { b.pbox(P.pan, 2.6, 0.05, 0.035, 0, 0.55, 0.12 + sd * 0.735); b.pbox(P.pan, 0.035, 0.05, 1.5, sd * 1.285, 0.55, 0.12); }
      winS(b, wl, P, -1.1, 1.1, 0.34, 0.85, 9, 0.17, 0.08, 0.55, 3);
      winE(b, wl, P, -0.4, 0.6, 0.22, 1.27, 4, 0.17, 0.16, 0.5, 6, 1);
      // Ladepult mit 8 Zellen (xp cell bei z 1.025, y 0.15)
      b.box(P.body2, 2.14, 0.24, 0.14, 0, 0.06, 0.93).pbox(P.glass, 2.0, 0.012, 0.1, 0, 0.3, 0.93).pbox(T.team, 2.16, 0.025, 0.15, 0, 0.27, 0.93);
      for (i = 0; i < 8; i++) b.pbox(P.dark, 0.21, 0.15, 0.02, -0.84 + i * 0.24, 0.13, 1.0);
      // Uplink-Turm hinten Mitte: Sockel, Trommel, Mast mit leuchtenden Emitterringen, Kristall
      b.cyl(P.conc, 0.38, 0.44, 0.14, 10, 0, 0.55, -0.3).cylB(P.body2, 0.27, 0.3, 10, 0, 0.69, -0.3, 0.02).add(new THREE.CylinderGeometry(0.28, 0.28, 0.05, 10, 1, true), T.team, 0, 0.88, -0.3);
      b.cyl(P.metal, 0.06, 0.1, 0.72, 8, 0, 0.99, -0.3);
      for (i = 0; i < 3; i++) {
        var er = 0.2 - i * 0.04;
        b.cyl(i % 2 ? T.team : P.body2, er, er, 0.05, 10, 0, 1.1 + i * 0.2, -0.3);
        g.add(new THREE.CylinderGeometry(er + 0.012, er + 0.012, 0.016, 10, 1, true), GC, 0, 1.125 + i * 0.2, -0.3);
      }
      for (i = 0; i < 4; i++) { var sa = i * Math.PI / 2 + Math.PI / 4; strut(b, P.dark, Math.cos(sa) * 0.36, 0.69, -0.3 + Math.sin(sa) * 0.36, Math.cos(sa) * 0.07, 1.25, -0.3 + Math.sin(sa) * 0.07, 0.025); }
      b.cyl(P.metal, 0.03, 0.06, 0.18, 6, 0, 1.71, -0.3);
      g.ico('#ffffff', 0.11, 0.0, 1.95, -0.3, 1, 1.25, 1, 1);
      M.emitAt = [0.0, 1.95, -0.3];
      // drei Schüsseln auf dem Dach (xp dish)
      M.xparts.dish = dishGeo(0.3, '#e7edf0', '#ffffff', P.dark);
      [[-0.95, -0.2, 0], [0.95, -0.2, 2.1], [0.0, 0.5, 4.2]].forEach(function (d) { b.box(P.body2, 0.22, 0.05, 0.22, d[0], 0.55, d[1]); M.xp.push({ p: 'dish', x: d[0], y: 0.6, z: d[1], k: 'dish', ph: d[2] }); });
      insignia(b, T, P, -0.6, 0.552, 0.5, 0.18, 0.18); solar(b, P, 0.62, 0.55, 0.5, 0.42, 0.24);
      acUnit(b, P, -0.5, 0.55, -0.42, 0.18); roofFan(b, P, 0.55, 0.55, -0.45, 0.08);
      // Kondensatorbank hinten (leuchtende Spulen), Antennenmast
      for (i = 0; i < 4; i++) { b.cyl(P.dark, 0.09, 0.1, 0.32, 8, -1.05 + i * 0.7, 0.06, -0.82).cyl(P.metal, 0.06, 0.06, 0.05, 8, -1.05 + i * 0.7, 0.38, -0.82); g.add(new THREE.CylinderGeometry(0.105, 0.105, 0.03, 8, 1, true), GC, -1.05 + i * 0.7, 0.26, -0.82); }
      b.cyl(P.metal, 0.012, 0.018, 0.7, 4, 1.3, 0.55, 0.6); beacon(g, '#ff5a3c', 1.3, 1.27, 0.6, 0.03);
      var cm = new MB(); cm.box('#ffffff', 0.17, 0.11, 0.05, 0, 0, 0); M.xparts.cell = cm.geo(false);
      for (i = 0; i < 8; i++) M.xp.push({ p: 'cell', x: -0.84 + i * 0.24, y: 0.15, z: 1.025, k: 'cell', ci: i });
    } else if (type === 'silo') {                                     // Syndikat: Raketenbunker, Schacht mit Schiebetoren, Ladeanzeige vorn, Leitstand
      b.box(P.body, 2.7, 0.5, 1.8, 0, 0.06, 0).box(T.team, 2.74, 0.08, 1.84, 0, 0.3, 0).box(P.body2, 2.76, 0.06, 1.86, 0, 0.1, 0);
      b.prism(P.body2, [[-1.35, 0.56], [1.35, 0.56], [1.2, 0.76], [-1.2, 0.76]], 1.7, 0, 0, 0);
      if (hi) { rivets(b, P.metal, -1.2, 1.2, 0.47, 0.905, 12); rivetsX(b, P.metal, -0.75, 0.75, 0.47, 1.355, 6); }
      for (i = 0; i < 4; i++) b.pbox(P.rust, 0.42, 0.16, 0.012, -1.05 + i * 0.7, 0.12, -0.906);
      // Schacht + Gefahrenrahmen + Torschienen
      b.pbox('#14110e', 1.1, 0.012, 0.9, 0, 0.76, -0.1);
      b.flat = true; hazardFrame(b, 0, -0.1, 1.1, 0.9, 0.762); b.flat = false;
      for (sd = -1; sd <= 1; sd += 2) b.pbox(P.dark, 2.2, 0.03, 0.05, 0, 0.765, -0.1 + sd * 0.5);
      for (sd = -1; sd <= 1; sd += 2) { b.cyl(P.dark, 0.05, 0.05, 0.16, 6, sd * 0.72, 0.76, 0.5).cyl(P.metal, 0.03, 0.03, 0.1, 6, sd * 0.72, 0.92, 0.5); }   // Hydraulik
      // Ladeanzeige (8 Zellen vorn, xp cell z 0.93, y 0.15)
      for (i = 0; i < 8; i++) b.pbox(P.dark, 0.21, 0.15, 0.03, -0.84 + i * 0.24, 0.13, 0.9);
      b.pbox(P.dark, 2.1, 0.02, 0.05, 0, 0.29, 0.92);
      // Seitentor (Ost) mit Warnstreifen
      b.pbox(P.dark, 0.03, 0.34, 0.5, 1.36, 0.06, 0.35); hazardX(b, 1.4, 1.48, 0.35, 0.062, 0.5);
      // Leitstand (Ost, auf dem Dach) mit Fenstern + Mast
      b.box(P.body, 0.5, 0.3, 0.44, 1.0, 0.6, 0.45).box(T.team, 0.52, 0.04, 0.46, 1.0, 0.86, 0.45).box(P.rust, 0.54, 0.04, 0.48, 1.0, 0.9, 0.45);
      winS(b, wl, P, 0.86, 1.14, 0.7, 0.67, 2, 0.11, 0.08, 0.7, 5); winE(b, wl, P, 0.32, 0.58, 0.7, 1.25, 2, 0.1, 0.08, 0.6, 2, 1);
      b.cyl(P.metal, 0.02, 0.025, 0.66, 4, 1.15, 0.94, 0.3); beacon(g, '#ff4a30', 1.15, 1.62, 0.3, 0.05);
      // Lüftungsschlote + Tanks West
      b.cyl(P.dark, 0.1, 0.1, 0.42, 8, -1.0, 0.7, -0.55).cyl(P.dark, 0.12, 0.12, 0.03, 8, -1.0, 1.12, -0.55).cyl(P.rust, 0.08, 0.1, 0.3, 8, -0.75, 0.7, -0.68);
      b.cyl(P.body2, 0.17, 0.17, 0.32, 10, -0.98, 0.56, 0.48).add(new THREE.CylinderGeometry(0.175, 0.175, 0.05, 10, 1, true), T.team, -0.98, 0.76, 0.48).dome(P.body2, 0.17, -0.98, 0.88, 0.48, 1, 0.4, 1, 10);
      g.pbox('#ffb23c', 0.012, 0.05, 0.3, 1.258, 0.68, 0.0);
      // Schiebetore (xp door), Rakete (msl / mslf)
      var db = new MB(); db.box(P.body2, 0.55, 0.07, 0.9, 0, 0, 0); db.flat = true; hazardFrame(db, 0, 0, 0.47, 0.82, 0.07); db.flat = false;
      db.pbox(T.team, 0.5, 0.012, 0.1, 0, 0.075, 0); if (hi) rivets(db, P.metal, -0.22, 0.22, 0.03, 0.452, 4);
      M.xparts.door = db.geo(false);
      M.xp.push({ p: 'door', x: -0.275, y: 0.78, z: -0.1, k: 'doorL' }, { p: 'door', x: 0.275, y: 0.78, z: -0.1, k: 'doorR' });
      var ms = new MB();
      ms.cylX('#d8dbd9', 0.1, 0.1, 0.9, 10, 0.45, 0, 0).add(new THREE.ConeGeometry(0.1, 0.34, 10), '#c8301f', 1.07, 0, 0, 0, 0, -Math.PI / 2);
      ms.cylX(T.team, 0.102, 0.102, 0.1, 10, 0.7, 0, 0).cylX('#25282b', 0.102, 0.102, 0.06, 10, 0.2, 0, 0).cylX('#25282b', 0.102, 0.102, 0.02, 10, 0.86, 0, 0);
      ms.pbox('#4b5157', 0.22, 0.02, 0.36, 0.1, -0.01, 0).pbox('#4b5157', 0.22, 0.36, 0.02, 0.1, -0.18, 0);
      ms.cylX('#4b5157', 0.07, 0.09, 0.1, 8, -0.04, 0, 0);
      M.xparts.msl = ms.geo(false); M.xparts.mslf = M.xparts.msl.clone(); M.xparts.mslf.scale(1.7, 1.7, 1.7);
      var cm2 = new MB(); cm2.box('#ffffff', 0.17, 0.12, 0.05, 0, 0, 0); M.xparts.cell = cm2.geo(false);
      for (i = 0; i < 8; i++) M.xp.push({ p: 'cell', x: -0.84 + i * 0.24, y: 0.15, z: 0.93, k: 'cell', ci: i });
    }
    void k;
    M.parts.glow = g.geo(false);
    if (wl.list.length) M.parts.wlit = wl.geo(false);
    M.parts.body = b.geo();
    return M;
  }

  // ------------------------------------------------------------------ v0.5: Mauer, Bunker, Laser, Blitzturm, Mobiler Bauhof (SPEC_v05 §2/§3/§5)
  // Mauer: Teile pillar (Pfeiler, je Segment) + conn (Verbinder, Länge 1 entlang x, wird gedreht gesetzt) – Verbindung wird je Frame aus dem Raster bestimmt.
  // Bunker: body (+ glow = Schießscharten-Glühen, wenn besetzt/feuernd). Laser: body, head (dreht), glow (Sockel), hglow (Linse, dreht).
  // Blitzturm: body, glow (Spulenringe + Elektrode). Mobiler Bauhof: hull, xparts crane + jib (Kran, Pose per putP).
  var V5B = { wall: [1, 1], pbunker: [2, 2], laser: [2, 2], tesla: [2, 2] };
  var V5U = { mcv: 1 };
  BH.wall = 0.66; BH.pbunker = 0.62; BH.laser = 1.5; BH.tesla = 1.85;
  var WALL_BUILD = 10;                     // Aufbau-Animation Mauer (Ticks = 0.5 s)
  var MCV_CRANE = [-0.4, 0.66];            // Kran-Drehpunkt (x, y) im Fahrzeug; Arm L1, Ausleger L2
  var MCV_L1 = 0.7, MCV_L2 = 0.5;
  var GLOW5 = { laser: '#7fe9ff', tesla: '#7fa6ff', slit: '#ffb23c' };

  function wallPillar(b, P, T, syn, x, z) {
    // W10: Betonpfeiler mit Sockel, Teamband, Abdeckplatte (kein blankes Metall mehr oben → kein Überstrahlen), Fugen zur Kamera
    var cc = syn ? P.body : P.conc;
    b.pbox('#6b6d6b', 0.44, 0.06, 0.44, x, 0, z);
    b.box(cc, 0.34, 0.52, 0.34, x, 0.06, z);
    b.pbox(T.team, 0.355, 0.07, 0.355, x, 0.38, z);
    b.pbox(syn ? P.body2 : '#b9bcb8', 0.4, 0.06, 0.4, x, 0.58, z);
    b.pbox(P.dark, 0.012, 0.2, 0.06, x + 0.172, 0.12, z).pbox(P.dark, 0.06, 0.2, 0.012, x, 0.12, z + 0.172);
    if (syn) b.add(new THREE.ConeGeometry(0.045, 0.12, 4), P.dark, x, 0.7, z, Math.PI / 4);
    else b.pbox(T.teamD, 0.14, 0.035, 0.14, x, 0.64, z);
  }
  function wallConn(b, P, T, syn, x, z, alongZ) {
    var L = 1.0, k = alongZ ? 1 : 0, i;
    function bx(col, lw, h, d, ox, y, plain) { if (k) b[plain ? 'pbox' : 'box'](col, d, h, lw, x, y, z + ox); else b[plain ? 'pbox' : 'box'](col, lw, h, d, x + ox, y, z); }
    bx('#6b6d6b', L, 0.05, 0.3, 0, 0, true);
    bx(syn ? P.body2 : P.conc, 0.96, 0.42, 0.2, 0, 0.05);
    for (i = -1; i <= 1; i += 2) bx(P.dark, 0.016, 0.36, 0.212, i * 0.17, 0.08, true);                    // Fugen
    bx(T.team, 0.98, 0.05, 0.214, 0, 0.32, true);
    bx(syn ? P.dark : '#b9bcb8', 1.0, 0.05, 0.26, 0, 0.47, true);
    if (syn) for (i = 0; i < 4; i++) bx(i % 2 ? '#facc15' : '#1f2937', 0.12, 0.012, 0.18, -0.36 + i * 0.24, 0.52, true);
    else bx(P.body2, 0.5, 0.012, 0.12, 0, 0.52, true);
  }

  function buildBuildingV5(type, fac, color) {
    // W10: Bunker, Laser, Blitzturm, Mauer im Stil der v0.7-Gebäude neu gestaltet. Haken unverändert:
    // pbunker win[] + glow (Scharten), laser head/hglow/glow + muzzle [0.7, 1.1], tesla glow + elec/ringY/ringR + muzzle, wall pillar/conn/icon.
    var P = PAL[fac], T = teamCols(color), syn = fac === 'syndicate', sz = V5B[type], w = sz[0], h = sz[1], hi = HI();
    var b = new MB(), g = new MB(), M = { parts: {}, xparts: {}, xp: [], h: BH[type] || 1, v5: type, win: [], lo: !hi }, i, k, sd;
    if (type === 'wall') {
      var pl = new MB(), cn = new MB(), ic = new MB();
      wallPillar(pl, P, T, syn, 0, 0);
      wallConn(cn, P, T, syn, 0, 0, false);
      // Symbol: L-förmiger Mauerzug aus 4 Segmenten, um den Ursprung zentriert
      var cells = [[0, 0], [1, 0], [2, 0], [2, 1]], ox = -1.0, oz = -0.5;
      for (i = 0; i < cells.length; i++) wallPillar(ic, P, T, syn, cells[i][0] + ox, cells[i][1] + oz);
      wallConn(ic, P, T, syn, 0.5 + ox, oz, false); wallConn(ic, P, T, syn, 1.5 + ox, oz, false); wallConn(ic, P, T, syn, 2 + ox, 0.5 + oz, true);
      ic.box('#6b6d6b', 3.0, 0.02, 1.7, 0, -0.02, 0);
      M.parts.pillar = pl.geo(); M.parts.conn = cn.geo(); M.parts.icon = ic.geo(); M.iconOnly = 'icon'; M.wall = true;
      return M;
    }
    slab(b, P, w, h, T);
    if (type === 'pbunker') {                                         // Kasematte aus Beton: geneigte Seitenwände, Scharten mit Betonblende, MG-Kuppel, Sandsäcke
      var cc = syn ? P.body : P.conc, cc2 = syn ? P.body2 : '#b2b4b0';
      b.box('#74766f', 1.84, 0.08, 1.74, 0, 0.06, 0);
      b.prism(cc, [[-0.86, 0.14], [0.86, 0.14], [0.74, 0.5], [-0.74, 0.5]], 1.6, 0, 0, 0);
      b.pbox(T.team, 1.7, 0.06, 1.62, 0, 0.2, 0);
      b.box(cc2, 1.56, 0.08, 1.66, 0, 0.5, 0).pbox(P.dark, 1.2, 0.012, 1.3, 0, 0.58, 0);
      // Scharten (Süd ×3, Ost/West, Nord) – Glühteil = besetzt/feuernd; M.win = Mündungspunkte
      for (i = 0; i < 3; i++) {
        var sx = -0.5 + i * 0.5;
        b.pbox('#14171a', 0.34, 0.1, 0.03, sx, 0.3, 0.8).pbox(cc2, 0.42, 0.05, 0.1, sx, 0.4, 0.82);
        g.pbox(GLOW5.slit, 0.26, 0.05, 0.012, sx, 0.325, 0.818); M.win.push([sx, 0.36, 0.86]);
      }
      for (sd = -1; sd <= 1; sd += 2) { b.pbox('#14171a', 0.05, 0.1, 0.34, sd * 0.8, 0.3, 0.1); g.pbox(GLOW5.slit, 0.012, 0.05, 0.26, sd * 0.826, 0.325, 0.1); M.win.push([sd * 0.86, 0.36, 0.1]); }
      b.pbox('#14171a', 0.34, 0.1, 0.03, 0.3, 0.3, -0.8); M.win.push([0.3, 0.36, -0.86]);
      b.pbox(P.dark, 0.3, 0.3, 0.03, -0.5, 0.14, -0.8).pbox(cc2, 0.4, 0.05, 0.12, -0.5, 0.44, -0.84);              // Eingang hinten
      // MG-Kuppel + Luke + Sehrohr, Funkmast mit Wimpel
      b.cyl(P.dark, 0.14, 0.16, 0.1, 10, 0.42, 0.58, -0.25).cyl(syn ? P.rust : P.body2, 0.12, 0.13, 0.06, 10, 0.42, 0.68, -0.25);
      b.cylX(P.dark, 0.016, 0.016, 0.22, 6, 0.6, 0.66, -0.25);
      b.cyl(P.dark, 0.08, 0.08, 0.03, 8, -0.35, 0.58, 0.3).cyl(P.metal, 0.02, 0.02, 0.12, 5, -0.15, 0.58, -0.4);
      b.cyl(P.metal, 0.01, 0.012, 0.52, 4, -0.62, 0.58, -0.55).pbox(T.team, 0.14, 0.09, 0.012, -0.55, 1.0, -0.55);
      if (syn) { if (hi) rivets(b, P.metal, -0.7, 0.7, 0.42, 0.806, 7); b.pbox(P.rust, 0.5, 0.012, 0.3, -0.3, 0.582, 0.2); hazardX(b, -0.7, 0.7, 0.72, 0.582, 0.06); sandbags(b, -0.82, 0.82, 1.0, 2, false); }
      else { insignia(b, T, P, -0.25, 0.592, 0.25, 0.2, 0.2); sandbags(b, -0.6, 0.6, 1.0, 1, false); }
      sandbags(b, -0.55, 0.45, -0.98, 1, false);
      if (hi) { sandbags(b, -0.5, 0.5, 0.98, 1, true); sandbags(b, -0.5, 0.5, -0.98, 1, true); }
      M.parts.glow = g.geo(false);
    } else if (type === 'laser') {                                    // Achteck-Sockel, vier Kondensatorsäulen mit Lichtbändern, Mast, schlanker Emitterkopf
      var hd = new MB(), hg = new MB(), LC = GLOW5.laser;
      b.cyl(P.conc, 0.74, 0.8, 0.12, 8, 0, 0.04, 0).add(new THREE.CylinderGeometry(0.752, 0.752, 0.05, 8, 1, true), T.team, 0, 0.185, 0);
      b.cylB(P.body2, 0.56, 0.18, 8, 0, 0.16, 0, 0.02).cyl(P.dark, 0.42, 0.46, 0.06, 8, 0, 0.34, 0);
      for (i = 0; i < 4; i++) {
        var ca = i * Math.PI / 2 + Math.PI / 4, cxp = Math.cos(ca), czp = Math.sin(ca);
        b.box(P.body, 0.14, 0.44, 0.2, cxp * 0.52, 0.16, czp * 0.52, -ca).pbox(P.body2, 0.18, 0.04, 0.24, cxp * 0.52, 0.6, czp * 0.52, -ca);
        b.pbox(T.team, 0.145, 0.04, 0.205, cxp * 0.52, 0.48, czp * 0.52, -ca);
        g.pbox(LC, 0.012, 0.26, 0.1, cxp * 0.594, 0.2, czp * 0.594, -ca);
        if (hi) strut(b, P.dark, cxp * 0.45, 0.56, czp * 0.45, cxp * 0.13, 0.78, czp * 0.13, 0.03);
      }
      b.cyl(P.body2, 0.12, 0.17, 0.58, 8, 0, 0.4, 0).add(new THREE.CylinderGeometry(0.15, 0.15, 0.05, 8, 1, true), T.team, 0, 0.7, 0);
      g.add(new THREE.CylinderGeometry(0.4, 0.4, 0.02, 8, 1, true), LC, 0, 0.385, 0).add(new THREE.CylinderGeometry(0.13, 0.13, 0.03, 8, 1, true), LC, 0, 0.92, 0);
      // Kopf (dreht): Gehäuse, Kühlrippen, Emitter mit Fokusringen, Optik
      hd.cyl(P.dark, 0.16, 0.18, 0.06, 8, 0, 0.96, 0);
      hd.prism(P.body2, [[-0.26, 0.99], [0.16, 0.99], [0.25, 1.06], [0.2, 1.2], [-0.2, 1.22], [-0.29, 1.1]], 0.34, 0, 0, 0);
      hd.pbox(T.team, 0.3, 0.014, 0.26, -0.04, 1.205, 0).pbox(P.pan, 0.3, 0.004, 0.012, -0.04, 1.219, 0.07).pbox(P.pan, 0.3, 0.004, 0.012, -0.04, 1.219, -0.07);
      for (i = 0; i < 4; i++) hd.pbox(P.dark, 0.018, 0.16, 0.36, -0.3 - i * 0.035, 1.02, 0);
      hd.cylX(P.dark, 0.08, 0.08, 0.22, 10, 0.31, 1.1, 0).cylX(P.metal, 0.11, 0.11, 0.03, 10, 0.24, 1.1, 0).cylX(P.metal, 0.1, 0.1, 0.03, 10, 0.39, 1.1, 0);
      hd.cylX(P.body2, 0.05, 0.058, 0.16, 8, 0.5, 1.1, 0).cylX(P.dark, 0.075, 0.075, 0.05, 10, 0.605, 1.1, 0);
      hd.pbox(P.dark, 0.1, 0.06, 0.08, -0.06, 1.22, -0.08).pbox(P.glass, 0.012, 0.035, 0.06, -0.008, 1.235, -0.08);
      hg.cylX(LC, 0.058, 0.058, 0.02, 10, 0.638, 1.1, 0).ico('#ffffff', 0.032, 0.652, 1.1, 0, 1, 1, 1, 0);
      hg.add(new THREE.CylinderGeometry(0.112, 0.112, 0.012, 10, 1, true), LC, 0.24, 1.1, 0, 0, 0, -Math.PI / 2).add(new THREE.CylinderGeometry(0.102, 0.102, 0.012, 10, 1, true), LC, 0.39, 1.1, 0, 0, 0, -Math.PI / 2);
      M.parts.head = hd.geo(); M.parts.hglow = hg.geo(false); M.parts.glow = g.geo(false); M.muzzle = [0.7, 1.1]; M.recoil = 0;
    } else if (type === 'tesla') {                                    // Sockel mit Blitzableitern, Kern mit drei Kupferspulen (Leuchtbänder), Elektrodenkugel
      var TC = GLOW5.tesla, rr = [0.44, 0.38, 0.32], ry = [0.55, 0.85, 1.15], CU = '#8a5a3c', INS = '#cfc8b4';
      b.cyl(P.conc, 0.74, 0.8, 0.12, 8, 0, 0.04, 0).add(new THREE.CylinderGeometry(0.752, 0.752, 0.05, 8, 1, true), T.team, 0, 0.185, 0);
      b.cylB(syn ? P.body : P.body2, 0.54, 0.22, 8, 0, 0.16, 0, 0.02);
      if (syn && hi) rivets(b, P.metal, -0.36, 0.36, 0.3, 0.505, 5);
      b.cyl(P.dark, 0.15, 0.2, 1.24, 8, 0, 0.38, 0);
      for (i = 0; i < 3; i++) {
        b.cyl(CU, rr[i], rr[i], 0.1, 12, 0, ry[i], 0).cyl(P.dark, rr[i] - 0.03, rr[i] - 0.03, 0.14, 12, 0, ry[i] - 0.02, 0);
        g.add(new THREE.CylinderGeometry(rr[i] + 0.012, rr[i] + 0.012, 0.035, 12, 1, true), TC, 0, ry[i] + 0.05, 0);
        if (i < 2) for (k = 0; k < 3; k++) { var ia = k / 3 * Math.PI * 2 + i; b.cyl(INS, 0.025, 0.025, 0.2, 5, Math.cos(ia) * rr[i] * 0.75, ry[i] + 0.1, Math.sin(ia) * rr[i] * 0.75); }
      }
      b.cyl(P.metal, 0.07, 0.17, 0.22, 8, 0, 1.6, 0).cyl(INS, 0.1, 0.1, 0.04, 8, 0, 1.4, 0);
      g.ico('#d9e6ff', 0.17, 0, 1.9, 0, 1, 1, 1, 1);                                                                     // Elektrode
      for (i = 0; i < 4; i++) {                                                                                         // Blitzableiter an den Ecken
        var ta = i * Math.PI / 2 + Math.PI / 4, tx2 = Math.cos(ta) * 0.68, tz2 = Math.sin(ta) * 0.68;
        b.cyl(P.dark, 0.014, 0.03, 0.88, 5, tx2, 0.16, tz2).cyl(INS, 0.045, 0.045, 0.025, 6, tx2, 0.42, tz2).cyl(INS, 0.04, 0.04, 0.025, 6, tx2, 0.66, tz2);
        g.ico('#cfe0ff', 0.035, tx2, 1.06, tz2, 1, 1, 1, 0);
      }
      b.box(P.body2, 0.24, 0.18, 0.16, 0.4, 0.16, 0.52).pbox(T.team, 0.25, 0.03, 0.17, 0.4, 0.28, 0.52).pbox('#e6b81c', 0.08, 0.06, 0.012, 0.4, 0.22, 0.602);   // Schaltkasten
      if (hi) { strut(b, P.dark, 0.4, 0.2, 0.44, 0.14, 0.4, 0.12, 0.025); b.box(P.body2, 0.18, 0.14, 0.14, -0.5, 0.16, 0.42); }
      M.parts.glow = g.geo(false); M.muzzle = [0, 1.95]; M.elec = [0, 1.9, 0]; M.ringY = ry; M.ringR = rr;
    }
    void k;
    M.parts.body = b.geo();
    return M;
  }

  /** Kran des Mobilen Bauhofs: Arm (L1) mit Gitterschienen, Ausleger (L2) klappt aus. Ursprung = Drehpunkt, Länge entlang +x. */
  function craneGeo(len, wd, col, team, thick) {
    var c = new MB(), n = Math.round(len / 0.14), i;
    c.box(col, len, thick, thick, len / 2, -thick / 2, wd).box(col, len, thick, thick, len / 2, -thick / 2, -wd);
    for (i = 0; i <= n; i++) { var x = len * i / n; c.box(col, thick * 0.8, thick * 0.8, wd * 2, x, -thick * 0.4, 0); }
    c.box(team, len * 0.9, thick * 0.6, thick * 0.9, len * 0.5, thick * 0.4 - thick, 0);
    return c;
  }

  function buildUnitV5(type, fac, color) {
    var P = PAL[fac], T = teamCols(color), syn = fac === 'syndicate', M = { parts: {}, xparts: {}, xp: [], pivot: [0, 0], recoil: 0, muzzle: [0.2, 0.2], h: 0.85, mcv: true };
    var b = new MB(), g = new MB(), i, o = { L: 0.5, H: 0.24, W: syn ? 0.2 : 0.17, n: 5, rr: 0.08, pitch: 0.08 };
    trackSide(b, P, o, 0.38, 1); trackSide(b, P, o, -0.38, -1); addTreads(M, P, o, [0.38, -0.38], 0.24 + 0.004);
    b.box(syn ? P.body2 : P.body, 1.3, 0.14, 0.64, 0, 0.12, 0).pbox(T.team, 1.34, 0.03, 0.05, 0, 0.22, 0.34).pbox(T.team, 1.34, 0.03, 0.05, 0, 0.22, -0.34);
    // Führerhaus vorn
    if (!syn) {
      b.prism(P.body, [[0.26, 0.26], [0.68, 0.26], [0.68, 0.38], [0.56, 0.56], [0.26, 0.56]], 0.6, 0, 0, 0);
      b.prism(P.glass, [[0.56, 0.4], [0.69, 0.4], [0.575, 0.54], [0.56, 0.54]], 0.52, 0, 0, 0);
      b.box(T.team, 0.32, 0.025, 0.62, 0.41, 0.56, 0); b.pbox(P.glass, 0.012, 0.1, 0.1, 0.3, 0.42, 0.302).pbox(P.glass, 0.012, 0.1, 0.1, 0.3, 0.42, -0.302);
    } else {
      b.box(P.body, 0.42, 0.32, 0.58, 0.47, 0.26, 0).pbox(P.glass, 0.02, 0.1, 0.46, 0.685, 0.42, 0).box(T.team, 0.44, 0.03, 0.6, 0.47, 0.58, 0);
      b.box(P.dark, 0.1, 0.24, 0.62, 0.74, 0.18, 0).box(P.rust, 0.1, 0.04, 0.4, 0.74, 0.42, 0);
      rivets(b, P.metal, 0.3, 0.64, 0.32, 0.29, 4); rivets(b, P.metal, 0.3, 0.64, 0.32, -0.29, 4);
    }
    // Container („das zusammengefaltete Hauptquartier“) auf der Ladefläche
    b.box(syn ? P.body : P.body2, 0.84, 0.36, 0.7, -0.18, 0.26, 0).box(T.team, 0.86, 0.05, 0.72, -0.18, 0.44, 0).box(P.roof, 0.82, 0.04, 0.68, -0.18, 0.62, 0);
    for (i = 0; i < 4; i++) { b.pbox(P.dark, 0.14, 0.14, 0.02, -0.46 + i * 0.2, 0.3, 0.352).pbox(P.dark, 0.14, 0.14, 0.02, -0.46 + i * 0.2, 0.3, -0.352); b.top(P.dark, -0.54 + i * 0.2, -0.3, -0.54 + i * 0.2, 0.3, 0.6615, 0.012); }
    b.pbox(P.metal, 0.03, 0.36, 0.03, 0.22, 0.26, 0.355).pbox(P.metal, 0.03, 0.36, 0.03, 0.22, 0.26, -0.355);
    b.cylB(P.dark, 0.13, 0.1, 10, MCV_CRANE[0], 0.62, 0, 0.012);
    b.box(P.dark, 0.3, 0.1, 0.3, MCV_CRANE[0] - 0.05, 0.62, 0);
    b.box(P.dark, 0.12, 0.1, 0.1, -0.7, 0.2, 0.3).box(P.dark, 0.12, 0.1, 0.1, -0.7, 0.2, -0.3);                           // Stützen
    if (syn) { b.cylB(P.rust, 0.04, 0.4, 6, -0.42, 0.62, 0.3, 0.005).cylB(P.rust, 0.04, 0.34, 6, -0.42, 0.62, -0.3, 0.005); }
    else { b.cyl(P.metal, 0.012, 0.014, 0.5, 4, 0.18, 0.62, 0.3).pbox(P.glass, 0.1, 0.03, 0.1, 0.18, 1.1, 0.3); }
    g.pbox(LAMPC, 0.02, 0.04, 0.08, 0.745, 0.19, 0.22).pbox(LAMPC, 0.02, 0.04, 0.08, 0.745, 0.19, -0.22).pbox(TAILC, 0.02, 0.04, 0.08, -0.66, 0.2, 0.2).pbox(TAILC, 0.02, 0.04, 0.08, -0.66, 0.2, -0.2);
    g.ico('#ffb42e', 0.035, 0.35, 0.62, 0.24, 1, 0.8, 1, 1);
    M.parts.hull = b.geo(); M.parts.glow = g.geo(false);
    var arm = craneGeo(MCV_L1, 0.06, P.metal, T.team, 0.04), jib = craneGeo(MCV_L2, 0.03, P.body2, T.teamL, 0.03);
    arm.pbox('#d97706', 0.12, 0.08, 0.2, -0.1, -0.04, 0);                                                // Gegengewicht
    jib.pbox(P.dark, 0.02, 0.02, 0.02, MCV_L2 + 0.01, -0.02, 0);
    jib.pbox('#d97706', 0.05, 0.1, 0.05, MCV_L2, -0.12, 0);                                              // Haken
    M.xparts.crane = arm.geo(false); M.xparts.jib = jib.geo(false);
    M.craneAt = MCV_CRANE; M.pivot = [0, 0]; if (syn) M.exhaust = [[-0.42, 1.0, 0.3], [-0.42, 0.96, -0.3]];
    // Symbol: Kran in Ruhepose (aufgeklappt zur Hälfte, damit man ihn erkennt)
    M.iconAdd = function (grp, mat) {
      var m1 = new THREE.Mesh(M.xparts.crane, mat); m1.position.set(MCV_CRANE[0], MCV_CRANE[1], 0); m1.rotation.z = 0.0; grp.add(m1);
      var m2 = new THREE.Mesh(M.xparts.jib, mat); m2.position.set(MCV_CRANE[0] + MCV_L1, MCV_CRANE[1], 0.0); m2.rotation.z = -3.06; grp.add(m2);
    };
    return M;
  }


  // ------------------------------------------------------------------ v0.9 (W10): Modelle der sieben v0.7-Einheiten (SPEC_v07 §1)
  // Infanterie (sniper, flamer, medic): Teil hull (+ glow: Zündflamme des Flammenwerfers). Fahrzeuge: hull, turret, barrel (+ glow = Lampen
  // an der Wanne, tglow = Glühteile am Turm: Laserlinse / Blitzspule – dreht mit dem Turm, Helligkeit je Frame in fill()).
  // Raketenwerfer: Haubitzen-Mechanik (M.how): turret = Drehkranz, barrel = Raketenkasten (hebt sich stehend), spades = Abstützungen.
  // Detailstufe: Flag hiPoly (V) aus → Kleinteile (Nieten, Muttern, Antennen, Gitter) entfallen (lo-Modell, eigener Cache-/Batch-Schlüssel).
  var V7U = { sniper: 1, apc: 1, lasertank: 1, flamer: 1, mlrs: 1, shocktank: 1, medic: 1 };
  SCALE.sniper = 1.9; SCALE.flamer = 1.9; SCALE.medic = 1.9; SCALE.apc = 1.06; SCALE.lasertank = 1.06; SCALE.mlrs = 1.0; SCALE.shocktank = 1.1;
  var MEDX = '#22a34a';                    // Kreuz auf dem Sanitäter-Rucksack (grün wie das Lazarett – das rote Kreuz ist ein geschütztes Schutzzeichen)
  var LOD = { dreadnought: 1, sniper: 1, apc: 1, lasertank: 1, flamer: 1, mlrs: 1, shocktank: 1, medic: 1, techcenter: 1, orbital: 1, silo: 1, wall: 1, pbunker: 1, laser: 1, tesla: 1,
    transheli: 1, gunship: 1, bomber: 1, gunboat: 1, destroyer: 1, lander: 1, airfield: 1, shipyard: 1, flak: 1 };   // v0.8
  /** Detailstufe hoch? (Flag hiPoly/V; ohne Flags = hoch) */
  function HI() { var F = R.F; return !F || F.hiPoly !== false; }
  /** Sparsames Rad (≈ 84 Dreiecke): offener Reifenmantel + Reifen-/Felgenscheiben beidseitig, Nabenkreuz. */
  function wheelLite(r, wd, tire, rim, hub) {
    var w = new MB('unit'), sd, i, a;
    w.add(new THREE.CylinderGeometry(r, r, wd, 10, 1, true), tire, 0, 0, 0, 0, Math.PI / 2, 0);
    for (sd = -1; sd <= 1; sd += 2) {
      w.disc(tire, r * 0.98, 10, 0, 0, sd * wd / 2, sd).disc(rim, r * 0.6, 8, 0, 0, sd * (wd / 2 + 0.003), sd);
      w.add(new THREE.PlaneGeometry(r * 0.56, r * 0.14), hub, 0, 0, sd * (wd / 2 + 0.006), sd < 0 ? Math.PI : 0).add(new THREE.PlaneGeometry(r * 0.14, r * 0.56), hub, 0, 0, sd * (wd / 2 + 0.006), sd < 0 ? Math.PI : 0);   // Nabenkreuz (zeigt die Drehung)
    }
    void i; void a;
    return w.geo(false);
  }
  /** Arme mit Waffe im Anschlag (wie Schütze). */
  function armsAim(b, P) { b.pbox(P.cloth, 0.12, 0.045, 0.045, 0.045, 0.21, 0.1, -0.2).pbox(P.cloth, 0.12, 0.045, 0.045, 0.08, 0.2, -0.06, 0.45); }

  function buildUnitV7(type, fac, color) {
    var P = PAL[fac], T = teamCols(color), syn = fac === 'syndicate', hi = HI(), M = { parts: {}, xparts: {}, xp: [], pivot: [0, 0], recoil: 0, muzzle: [0.2, 0.2], h: 0.4, lo: !hi };
    var b = new MB(), t = new MB(), r = new MB(), g = new MB(), tg = new MB(), i, sd;
    if (type === 'sniper') {                                           // Koalition: Tarnhut + Ghillie-Überwurf, langes Gewehr mit Zielfernrohr und Zweibein
      var gh = '#5f6b3c', gh2 = '#4b5630', gh3 = '#76804a';
      soldier(b, P, T, fac, 'engineer');
      b.dome(gh, 0.066, 0.0, 0.29, 0, 1, 0.8, 1.05, 8).cyl(gh2, 0.098, 0.098, 0.014, 8, 0.004, 0.292, 0).cyl(T.team, 0.07, 0.07, 0.016, 8, 0.0, 0.304, 0);   // Buschhut, Teamband
      b.pbox(P.glass, 0.014, 0.018, 0.07, 0.058, 0.28, 0);
      b.ico(gh, 0.07, -0.05, 0.24, 0.07, 1.1, 0.7, 0.9).ico(gh2, 0.07, -0.05, 0.24, -0.07, 1.1, 0.7, 0.9).ico(gh3, 0.06, -0.11, 0.17, 0, 0.9, 1.1, 1.2);             // Ghillie über Schultern/Rücken
      if (hi) b.pbox(gh2, 0.012, 0.11, 0.03, -0.13, 0.1, 0.05, 0, 0, 0.3).pbox(gh, 0.012, 0.12, 0.03, -0.14, 0.09, -0.04, 0, 0, 0.2).pbox(gh3, 0.012, 0.09, 0.03, -0.12, 0.12, 0.0, 0, 0, 0.4);
      b.pbox('#5a4632', 0.15, 0.05, 0.04, 0.0, 0.19, 0.075).pbox(P.dark, 0.17, 0.036, 0.034, 0.14, 0.2, 0.075);                                            // Schaft, Verschluss
      b.cylX(P.dark, 0.011, 0.011, 0.2, 6, 0.3, 0.217, 0.075).pbox(P.dark, 0.035, 0.026, 0.03, 0.41, 0.204, 0.075);                                       // langer Lauf + Mündungsbremse
      b.cylX(P.dark, 0.019, 0.019, 0.15, 8, 0.13, 0.252, 0.075).pbox(P.dark, 0.03, 0.02, 0.02, 0.13, 0.226, 0.075);                                      // Zielfernrohr
      b.add(new THREE.CircleGeometry(0.016, 8), P.glass, 0.206, 0.252, 0.075, Math.PI / 2);
      b.pbox(P.dark, 0.012, 0.1, 0.012, 0.33, 0.11, 0.09, 0, 0, -0.35).pbox(P.dark, 0.012, 0.1, 0.012, 0.33, 0.11, 0.06, 0, 0, -0.35);                    // Zweibein (eingeklappt schräg)
      armsAim(b, P);
      M.parts.hull = b.geo(false); M.muzzle = [0.43, 0.217]; M.h = 0.36; infLegs(M, P);
      return M;
    }
    if (type === 'flamer') {                                           // Syndikat: Schutzmaske, zwei Brennstofftanks auf dem Rücken, Schlauch, Strahlrohr mit Zündflamme
      soldier(b, P, T, fac, 'engineer');
      b.pbox(P.dark, 0.05, 0.045, 0.064, 0.04, 0.262, 0).cylX(P.dark, 0.016, 0.02, 0.04, 6, 0.08, 0.27, 0).pbox(P.glass, 0.012, 0.02, 0.026, 0.058, 0.296, 0.018).pbox(P.glass, 0.012, 0.02, 0.026, 0.058, 0.296, -0.018);
      b.cylB(P.helm, 0.058, 0.05, 8, 0.0, 0.302, 0, 0.012).pbox(T.team, 0.02, 0.016, 0.104, -0.044, 0.325, 0);
      b.pbox('#7a6a4a', 0.11, 0.1, 0.155, 0.006, 0.07, 0);                                                                                                 // feuerfeste Schürze
      for (sd = -1; sd <= 1; sd += 2) {
        b.cyl('#b8471f', 0.036, 0.036, 0.19, 8, -0.15, 0.08, sd * 0.042).dome(P.dark, 0.036, -0.15, 0.27, sd * 0.042, 1, 0.6, 1, 6);                         // Tanks
        b.add(new THREE.CylinderGeometry(0.039, 0.039, 0.026, 8, 1, true), T.team, -0.15, 0.213, sd * 0.042);
      }
      if (hi) b.cyl(P.metal, 0.008, 0.008, 0.05, 4, -0.15, 0.3, 0.0).pbox(P.metal, 0.03, 0.012, 0.1, -0.15, 0.32, 0);                                      // Ventil + Bügel
      strut(b, '#2a2622', -0.15, 0.1, 0.0, -0.02, 0.12, 0.09, 0.016); strut(b, '#2a2622', -0.02, 0.12, 0.09, 0.06, 0.18, 0.08, 0.016);                     // Schlauch
      b.pbox(P.dark, 0.14, 0.04, 0.036, 0.08, 0.18, 0.08).pbox(P.rust, 0.05, 0.06, 0.03, 0.06, 0.13, 0.08);                                                // Strahlrohr + Griff
      b.cylX(P.metal, 0.016, 0.02, 0.13, 6, 0.21, 0.2, 0.08).cylX(P.dark, 0.024, 0.024, 0.03, 6, 0.285, 0.2, 0.08);
      g.ico('#ffa230', 0.02, 0.31, 0.2, 0.08, 1.3, 0.8, 0.8).ico('#ffe08a', 0.011, 0.312, 0.2, 0.08);                                                       // Zündflamme
      armsAim(b, P);
      M.parts.hull = b.geo(false); M.parts.glow = g.geo(false); M.muzzle = [0.32, 0.2]; M.h = 0.36; M.pilot = true; infLegs(M, P);
      return M;
    }
    if (type === 'medic') {                                            // beide Fraktionen: weißer Helm, weißer Sanitätsrucksack mit Kreuz, Verbandskoffer in der Hand
      var wh = '#c9cdc6';                                             // gebrochenes Weiß (reines Weiß überstrahlt im Modern-Bloom)
      soldier(b, P, T, fac, 'engineer');
      b.dome(wh, 0.064, 0.003, 0.292, 0, 1, 0.9, 1.05, 10).pbox(P.glass, 0.014, 0.024, 0.07, 0.058, 0.286, 0).pbox(T.team, 0.03, 0.01, 0.118, 0.0, 0.332, 0);
      b.pbox(MEDX, 0.004, 0.026, 0.008, 0.066, 0.31, 0.0).pbox(MEDX, 0.004, 0.008, 0.026, 0.066, 0.318, 0.0);                                             // Kreuz vorn am Helm
      b.box(wh, 0.09, 0.16, 0.13, -0.125, 0.11, 0);                                                                                                          // Rucksack
      b.pbox(MEDX, 0.006, 0.1, 0.032, -0.171, 0.14, 0).pbox(MEDX, 0.006, 0.032, 0.1, -0.171, 0.174, 0);                                                    // Kreuz hinten
      b.pbox(MEDX, 0.07, 0.006, 0.022, -0.125, 0.27, 0).pbox(MEDX, 0.022, 0.006, 0.07, -0.125, 0.27, 0);                                                   // Kreuz oben (Kamera)
      b.pbox(wh, 0.08, 0.03, 0.03, 0.0, 0.228, 0.106).pbox(MEDX, 0.03, 0.03, 0.006, 0.0, 0.228, 0.122);                                                    // Armbinde
      b.pbox(P.cloth, 0.045, 0.12, 0.045, 0.01, 0.12, 0.1).pbox(P.cloth, 0.12, 0.045, 0.045, 0.06, 0.2, -0.07, 0.45);                                      // Arme
      b.box(wh, 0.09, 0.07, 0.04, 0.03, 0.05, 0.13).pbox(MEDX, 0.03, 0.01, 0.042, 0.03, 0.08, 0.13).pbox(MEDX, 0.01, 0.03, 0.042, 0.03, 0.07, 0.13).pbox(P.dark, 0.04, 0.012, 0.012, 0.03, 0.12, 0.13);
      M.parts.hull = b.geo(false); M.muzzle = [0.1, 0.2]; M.h = 0.36; infLegs(M, P);
      return M;
    }
    if (type === 'apc') {                                              // Koalition: 8×8-Radpanzer, kleiner MK-Turm, Heckrampe
      var wr = 0.095, ax = [0.33, 0.12, -0.11, -0.32];
      M.xparts.wheel = wheelLite(wr, 0.075, P.track, P.metal, P.body2);
      ax.forEach(function (x) { [1, -1].forEach(function (s2) { M.xp.push({ p: 'wheel', x: x, y: wr, z: s2 * 0.268, k: 'wheel', r: wr }); }); });
      b.box(P.dark, 0.96, 0.07, 0.34, -0.01, 0.06, 0);                                                                                                       // Unterboden
      b.prism(P.body, [[-0.5, 0.1], [0.38, 0.1], [0.53, 0.19], [0.45, 0.32], [-0.47, 0.32], [-0.51, 0.27]], 0.44, 0, 0, 0);                                    // Wanne
      b.prism(P.body2, [[0.4, 0.19], [0.54, 0.185], [0.55, 0.205], [0.44, 0.27], [0.4, 0.27]], 0.36, 0, 0, 0);                                                // Schwallblech
      for (sd = -1; sd <= 1; sd += 2) {
        b.pbox(P.dark, 0.06, 0.05, 0.05, 0.225, 0.11, sd * 0.215).pbox(P.dark, 0.06, 0.05, 0.05, -0.215, 0.11, sd * 0.215);                                   // Achsträger
        b.pbox(P.body2, 0.86, 0.07, 0.03, -0.03, 0.22, sd * 0.226);                                                                                          // Seitenpanzer
        b.pbox(T.team, 0.86, 0.022, 0.012, -0.03, 0.262, sd * 0.243);                                                                                        // Teamstreifen
        b.pbox(T.team, 0.8, 0.012, 0.04, -0.05, 0.32, sd * 0.19);
        for (i = 0; i < 3; i++) b.pbox(P.glass, 0.04, 0.025, 0.006, -0.3 + i * 0.16, 0.27, sd * 0.222);                                                      // Winkelspiegel
      }
      b.box(P.body2, 0.36, 0.03, 0.3, -0.26, 0.32, 0).pbox(T.team, 0.14, 0.012, 0.22, -0.26, 0.35, 0);                                                        // Kampfraum-Dach
      insignia(b, T, P, -0.26, 0.363, 0, 0.07, 0.07);
      b.cyl(P.body2, 0.045, 0.045, 0.02, 8, -0.12, 0.32, 0.12).cyl(P.body2, 0.045, 0.045, 0.02, 8, -0.12, 0.32, -0.12);                                   // Luken
      b.cyl(P.body2, 0.05, 0.05, 0.02, 8, 0.36, 0.3, 0.1).pbox(P.glass, 0.012, 0.025, 0.12, 0.43, 0.27, 0.0, 0, 0, -0.6);                                  // Fahrerluke + Sichtblock
      b.prism(P.body2, [[-0.5, 0.1], [-0.47, 0.1], [-0.47, 0.3], [-0.5, 0.29]], 0.3, -0.035, 0, 0);                                                           // Heckrampe
      b.pbox(P.dark, 0.012, 0.014, 0.3, -0.535, 0.12, 0).pbox(P.dark, 0.012, 0.014, 0.3, -0.535, 0.28, 0);
      for (i = 0; i < 4; i++) b.pbox(i % 2 ? '#23272b' : '#e6b81c', 0.008, 0.035, 0.28, -0.541, 0.13 + i * 0.035, 0);                                            // Warnstreifen an der Rampe
      if (hi) {
        b.cylZ(P.dark, 0.014, 0.32, 6, -0.535, 0.12, 0);                                                                                                      // Rampenscharnier
        for (i = 0; i < 2; i++) b.cylX(P.dark, 0.012, 0.012, 0.05, 5, 0.25, 0.33 + i * 0.022, 0.2).cylX(P.dark, 0.012, 0.012, 0.05, 5, 0.25, 0.33 + i * 0.022, -0.2);   // Nebelwerfer
        b.cyl(P.metal, 0.005, 0.007, 0.32, 4, -0.42, 0.32, 0.17).cyl(P.metal, 0.005, 0.007, 0.24, 4, -0.42, 0.32, -0.17);                                     // Antennen
        b.pbox(P.body2, 0.12, 0.06, 0.1, 0.12, 0.32, -0.15).pbox(P.dark, 0.05, 0.03, 0.34, 0.51, 0.1, 0);                                                     // Staukasten, Abschlepphaken
      }
      g.pbox(LAMPC, 0.02, 0.03, 0.05, 0.52, 0.2, 0.15).pbox(LAMPC, 0.02, 0.03, 0.05, 0.52, 0.2, -0.15).pbox(TAILC, 0.02, 0.025, 0.04, -0.52, 0.27, 0.19).pbox(TAILC, 0.02, 0.025, 0.04, -0.52, 0.27, -0.19);
      // Turm (Drehpunkt 0.08): Ein-Mann-Turm mit Maschinenkanone
      t.cyl(P.body2, 0.11, 0.11, 0.04, 10, 0, 0.32, 0);
      t.prism(P.body, [[-0.12, 0.355], [0.07, 0.355], [0.14, 0.39], [0.08, 0.45], [-0.1, 0.45], [-0.13, 0.4]], 0.2, 0, 0, 0);
      t.box(T.team, 0.12, 0.012, 0.14, -0.03, 0.45, 0).pbox(P.glass, 0.04, 0.035, 0.05, 0.02, 0.45, 0.06).pbox(P.dark, 0.05, 0.04, 0.05, 0.02, 0.447, 0.06);
      t.box(P.dark, 0.06, 0.07, 0.08, 0.12, 0.37, 0);
      if (hi) t.cyl(P.metal, 0.005, 0.007, 0.2, 4, -0.09, 0.45, -0.06);
      r.cylX(P.dark, 0.022, 0.022, 0.1, 6, 0.18, 0.405, 0).cylX(P.dark, 0.012, 0.013, 0.26, 6, 0.36, 0.405, 0).cylX(P.metal, 0.018, 0.018, 0.04, 6, 0.49, 0.405, 0);
      r.cylX(P.dark, 0.008, 0.008, 0.12, 4, 0.2, 0.38, 0.05);                                                                                                 // Koax-MG
      M.parts.hull = b.geo(); M.parts.turret = t.geo(); M.parts.barrel = r.geo(); M.parts.glow = g.geo(false);
      M.pivot = [0.08, 0]; M.muzzle = [0.51, 0.405]; M.recoil = 0.03; M.h = 0.48; M.exhaust = [[-0.3, 0.32, 0.2]];
      return M;
    }
    if (type === 'lasertank') {                                        // Koalition: flache, glatte Keilwanne, Schürzen über dem Laufwerk, Emitterturm mit leuchtender Linse
      var LC = GLOW5.laser, lo = { L: 0.33, H: 0.14, W: 0.13, n: 4, rr: 0.05 };
      trackSide(b, P, lo, 0.255, 1); trackSide(b, P, lo, -0.255, -1); addTreads(M, P, lo, [0.255, -0.255], 0.14 + 0.004);
      b.prism(P.body, [[-0.48, 0.07], [0.42, 0.07], [0.58, 0.13], [0.42, 0.235], [-0.42, 0.235], [-0.5, 0.17]], 0.44, 0, 0, 0);
      for (sd = -1; sd <= 1; sd += 2) {
        b.prism(P.body2, [[-0.46, 0.07], [0.44, 0.07], [0.52, 0.13], [0.44, 0.2], [-0.44, 0.2]], 0.05, 0, 0, sd * 0.33);                                     // Schürzen
        b.pbox(T.team, 0.86, 0.02, 0.054, -0.01, 0.2, sd * 0.33);
        b.top(P.pan, -0.42, sd * 0.2, 0.36, sd * 0.2, 0.236, 0.012);
        g.pbox(LC, 0.5, 0.012, 0.006, -0.02, 0.12, sd * 0.357);                                                                                               // Leuchtstreifen an der Schürze
      }
      b.prism(P.body2, [[0.38, 0.235], [0.58, 0.13], [0.6, 0.15], [0.42, 0.255]], 0.36, 0, 0, 0);
      b.box(P.dark, 0.22, 0.03, 0.34, -0.36, 0.235, 0);                                                                                                      // Kühlgitter Energieblock
      for (i = 0; i < 4; i++) b.top(P.track, -0.46, -0.12 + i * 0.08, -0.26, -0.12 + i * 0.08, 0.2655, 0.012);
      g.pbox(LC, 0.012, 0.03, 0.26, -0.49, 0.19, 0);                                                                                                         // Heck: Energiezellen-Glühen
      b.box(T.team, 0.14, 0.012, 0.36, -0.15, 0.235, 0);
      g.pbox(LAMPC, 0.02, 0.025, 0.06, 0.585, 0.12, 0.17).pbox(LAMPC, 0.02, 0.025, 0.06, 0.585, 0.12, -0.17);
      for (sd = -1; sd <= 1; sd += 2) g.pbox(LC, 0.62, 0.006, 0.018, -0.06, 0.236, sd * 0.175);                                                      // Lichtbänder auf dem Deck (von oben sichtbar)
      // Turm: flache Untertasse mit Lichtring, Emittergehäuse oben, Emitterrohr mit Fokusringen und großer Linse
      t.lathe(P.body, [[0.0, 0.235], [0.23, 0.235], [0.25, 0.265], [0.21, 0.32], [0.1, 0.35], [0.0, 0.35]], 14, 0, 0, 0);
      tg.add(new THREE.CylinderGeometry(0.247, 0.247, 0.012, 14, 1, true), LC, 0, 0.266, 0);
      t.box(P.body2, 0.26, 0.08, 0.18, 0.04, 0.3, 0).box(T.team, 0.16, 0.012, 0.2, -0.06, 0.38, 0).pbox(P.pan, 0.16, 0.004, 0.012, -0.06, 0.392, 0);
      for (sd = -1; sd <= 1; sd += 2) { t.box(P.body2, 0.2, 0.06, 0.06, -0.08, 0.3, sd * 0.15); tg.pbox(LC, 0.16, 0.006, 0.024, -0.08, 0.361, sd * 0.15); }   // Kondensatoren mit Lichtfeld oben
      t.box(P.dark, 0.07, 0.05, 0.06, -0.16, 0.35, 0.0).pbox(P.glass, 0.012, 0.025, 0.045, -0.124, 0.36, 0.0);
      if (hi) t.cyl(P.metal, 0.005, 0.007, 0.24, 4, -0.2, 0.3, 0.1);
      r.cylX(P.dark, 0.052, 0.052, 0.16, 10, 0.25, 0.34, 0).cylX(P.metal, 0.064, 0.064, 0.025, 10, 0.2, 0.34, 0).cylX(P.metal, 0.06, 0.06, 0.025, 10, 0.31, 0.34, 0);
      r.cylX(P.body2, 0.034, 0.04, 0.18, 8, 0.42, 0.34, 0).cylX(P.dark, 0.056, 0.056, 0.05, 10, 0.535, 0.34, 0);
      tg.cylX(LC, 0.044, 0.044, 0.01, 10, 0.564, 0.34, 0).ico('#ffffff', 0.02, 0.57, 0.34, 0);                                                              // Linse
      tg.add(new THREE.CylinderGeometry(0.066, 0.066, 0.01, 10, 1, true), LC, 0.255, 0.34, 0, 0, 0, -Math.PI / 2);                                         // Fokusring
      M.parts.hull = b.geo(); M.parts.turret = t.geo(); M.parts.barrel = r.geo(); M.parts.glow = g.geo(false); M.parts.tglow = tg.geo(false);
      M.pivot = [-0.04, 0]; M.muzzle = [0.58, 0.34]; M.recoil = 0; M.h = 0.42; M.tg = 'laser';
      return M;
    }
    if (type === 'shocktank') {                                        // Syndikat: wuchtiger Kettenpanzer, Tesla-Spule auf dem Turm
      var SC = GLOW5.tesla, so = { L: 0.34, H: 0.18, W: 0.16, n: 4, rr: 0.062 };
      trackSide(b, P, so, 0.27, 1); trackSide(b, P, so, -0.27, -1); addTreads(M, P, so, [0.27, -0.27], 0.18 + 0.004);
      b.box(P.body, 0.92, 0.17, 0.4, -0.02, 0.07, 0);
      b.prism(P.body, [[0.38, 0.07], [0.53, 0.12], [0.45, 0.26], [0.3, 0.26]], 0.4, 0, 0, 0);
      b.box(P.body2, 0.86, 0.045, 0.62, -0.04, 0.2, 0);
      for (sd = -1; sd <= 1; sd += 2) {
        for (i = 0; i < 3; i++) b.pbox(P.body2, 0.27, 0.14, 0.04, -0.28 + i * 0.28, 0.07, sd * 0.375);
        b.pbox(T.team, 0.84, 0.03, 0.045, -0.04, 0.214, sd * 0.31);
        if (hi) rivets(b, P.metal, -0.3, 0.3, 0.18, sd * 0.397, 4);
      }
      b.pbox(P.rust, 0.28, 0.12, 0.4, -0.33, 0.245, 0);                                                                                                      // Generator hinten
      for (i = 0; i < 3; i++) { b.pbox(P.dark, 0.03, 0.1, 0.42, -0.43 + i * 0.1, 0.255, 0); }
      g.pbox(SC, 0.012, 0.05, 0.3, -0.475, 0.28, 0).pbox(SC, 0.2, 0.012, 0.012, -0.33, 0.367, 0.12).pbox(SC, 0.2, 0.012, 0.012, -0.33, 0.367, -0.12);       // Generator-Glühen
      strut(b, P.dark, -0.22, 0.33, 0.14, -0.1, 0.27, 0.14, 0.025); strut(b, P.dark, -0.22, 0.33, -0.14, -0.1, 0.27, -0.14, 0.025);                          // Kabel zum Turm
      b.cylB(P.rust, 0.03, 0.2, 6, -0.5, 0.25, 0.22, 0.004);
      g.pbox(LAMPC, 0.02, 0.035, 0.05, 0.52, 0.17, 0.17).pbox(LAMPC, 0.02, 0.035, 0.05, 0.52, 0.17, -0.17).pbox(TAILC, 0.02, 0.025, 0.05, -0.49, 0.2, 0.2).pbox(TAILC, 0.02, 0.025, 0.05, -0.49, 0.2, -0.2);
      // Turm: Drehkranz, gedrungenes Gehäuse, Spule mit drei Kupferringen, Elektrode
      t.cyl(P.body2, 0.22, 0.22, 0.06, 10, 0, 0.245, 0);
      t.prism(P.body, [[-0.22, 0.3], [0.14, 0.3], [0.21, 0.34], [0.16, 0.41], [-0.18, 0.41], [-0.24, 0.36]], 0.36, 0, 0, 0);
      t.box(T.team, 0.3, 0.014, 0.3, -0.02, 0.41, 0);
      if (hi) { rivets(t, P.metal, -0.14, 0.1, 0.37, 0.181, 3); rivets(t, P.metal, -0.14, 0.1, 0.37, -0.181, 3); }
      t.cyl(P.dark, 0.05, 0.065, 0.3, 8, 0, 0.42, 0);
      var cr = [0.12, 0.1, 0.08], cy = [0.47, 0.56, 0.65];
      for (i = 0; i < 3; i++) { t.cyl('#8a5a3c', cr[i], cr[i], 0.04, 10, 0, cy[i], 0); tg.add(new THREE.CylinderGeometry(cr[i] + 0.008, cr[i] + 0.008, 0.014, 10, 1, true), SC, 0, cy[i] + 0.02, 0); }
      t.cyl(P.metal, 0.02, 0.04, 0.1, 6, 0, 0.72, 0);
      tg.ico('#d9e6ff', 0.055, 0, 0.84, 0, 1, 1, 1, 0);
      for (sd = -1; sd <= 1; sd += 2) { t.cyl(P.dark, 0.035, 0.035, 0.12, 6, -0.14, 0.41, sd * 0.12); tg.disc(SC, 0.024, 6, -0.14, 0.532, sd * 0.12, 1); }   // Kondensatoren
      r.cylX(P.metal, 0.014, 0.018, 0.16, 6, 0.27, 0.36, 0.05).cylX(P.metal, 0.014, 0.018, 0.16, 6, 0.27, 0.36, -0.05).pbox(P.dark, 0.05, 0.05, 0.16, 0.2, 0.335, 0);   // Entladegabel vorn
      tg.ico(SC, 0.02, 0.36, 0.36, 0.05).ico(SC, 0.02, 0.36, 0.36, -0.05);
      M.parts.hull = b.geo(); M.parts.turret = t.geo(); M.parts.barrel = r.geo(); M.parts.glow = g.geo(false); M.parts.tglow = tg.geo(false);
      M.pivot = [-0.04, 0]; M.muzzle = [0.0, 0.84]; M.recoil = 0; M.h = 0.88; M.tg = 'tesla'; M.exhaust = [[-0.5, 0.45, 0.22]];
      return M;
    }
    if (type === 'mlrs') {                                             // Syndikat: Lkw mit drehbarem, sich aufrichtendem Raketenkasten (Haubitzen-Mechanik)
      var sp = new MB(), wr2 = 0.1, ax2 = [0.34, -0.13, -0.35];
      M.xparts.wheel = wheelLite(wr2, 0.085, P.track, P.rust, P.dark);
      ax2.forEach(function (x) { [1, -1].forEach(function (s2) { M.xp.push({ p: 'wheel', x: x, y: wr2, z: s2 * 0.235, k: 'wheel', r: wr2 }); }); });
      b.box(P.dark, 1.02, 0.06, 0.3, -0.02, 0.1, 0);                                                                                                         // Rahmen
      b.box(P.body, 0.28, 0.26, 0.42, 0.36, 0.14, 0);                                                                                                         // Fahrerhaus
      b.prism(P.body, [[0.5, 0.14], [0.56, 0.14], [0.56, 0.26], [0.5, 0.4]], 0.42, 0, 0, 0);
      b.prism(P.glass, [[0.5, 0.28], [0.535, 0.28], [0.5, 0.37], [0.49, 0.37]], 0.36, 0.012, 0, 0);
      b.box(P.rust, 0.3, 0.03, 0.44, 0.36, 0.4, 0).pbox(T.team, 0.2, 0.012, 0.3, 0.36, 0.43, 0);
      for (sd = -1; sd <= 1; sd += 2) {
        b.pbox(T.team, 0.18, 0.06, 0.006, 0.36, 0.26, sd * 0.212).pbox(P.glass, 0.1, 0.06, 0.006, 0.4, 0.32, sd * 0.212);
        b.box(P.body2, 0.24, 0.03, 0.1, 0.34, 0.2, sd * 0.235).box(P.body2, 0.5, 0.03, 0.1, -0.24, 0.2, sd * 0.235);                                        // Kotflügel
        b.box(P.dark, 0.1, 0.06, 0.06, 0.1, 0.12, sd * 0.2);                                                                                                 // Tank/Batterie
      }
      b.pbox(P.dark, 0.04, 0.08, 0.44, 0.57, 0.1, 0).pbox(P.track, 0.012, 0.08, 0.26, 0.565, 0.18, 0);                                                      // Stoßfänger, Kühlergrill
      b.box(P.body2, 0.66, 0.05, 0.44, -0.18, 0.18, 0);                                                                                                        // Pritsche
      b.cylB(P.rust, 0.025, 0.24, 6, 0.2, 0.2, 0.19, 0.004);                                                                                                  // Auspuff
      b.box(P.body2, 0.12, 0.1, 0.12, -0.47, 0.23, 0.13).box(P.body2, 0.12, 0.1, 0.12, -0.47, 0.23, -0.13);
      if (hi) { rivets(b, P.metal, 0.24, 0.48, 0.38, 0.212, 4); rivets(b, P.metal, 0.24, 0.48, 0.38, -0.212, 4); b.cyl(P.dark, 0.006, 0.008, 0.26, 4, 0.26, 0.43, -0.16); }
      g.pbox(LAMPC, 0.02, 0.04, 0.06, 0.565, 0.22, 0.16).pbox(LAMPC, 0.02, 0.04, 0.06, 0.565, 0.22, -0.16).pbox(TAILC, 0.02, 0.03, 0.05, -0.53, 0.25, 0.16).pbox(TAILC, 0.02, 0.03, 0.05, -0.53, 0.25, -0.16);
      g.ico('#ffb42e', 0.026, 0.36, 0.44, 0.15, 1, 0.8, 1, 1);
      // Drehkranz (Drehpunkt −0.16) mit Lagerböcken bis zur Schildzapfenhöhe 0.36
      t.cyl(P.dark, 0.17, 0.17, 0.05, 10, 0, 0.23, 0).add(new THREE.CylinderGeometry(0.175, 0.175, 0.016, 10, 1, true), T.team, 0, 0.263, 0);
      t.box(P.body, 0.14, 0.12, 0.04, 0.0, 0.27, 0.17).box(P.body, 0.14, 0.12, 0.04, 0.0, 0.27, -0.17).box(P.dark, 0.08, 0.06, 0.26, -0.03, 0.27, 0);
      t.box(P.body2, 0.08, 0.1, 0.1, -0.12, 0.27, 0.0);                                                                                                       // Hydraulikblock
      // Raketenkasten (Ursprung = Schildzapfen, Länge nach +x)
      r.cylZ(P.dark, 0.03, 0.36, 8, 0, 0, 0);
      r.box(P.body, 0.6, 0.2, 0.32, 0.1, -0.035, 0).pbox(T.team, 0.6, 0.02, 0.33, 0.1, 0.1, 0).pbox(P.rust, 0.5, 0.012, 0.28, 0.1, 0.165, 0);
      r.pbox(P.dark, 0.012, 0.19, 0.31, 0.402, -0.03, 0);
      for (i = 0; i < 6; i++) {
        var rz = -0.09 + (i % 3) * 0.09, ry = 0.02 + ((i / 3) | 0) * 0.08;
        r.add(new THREE.CircleGeometry(0.034, 8), '#1a1916', 0.409, ry, rz, Math.PI / 2).add(new THREE.CircleGeometry(0.02, 6), '#c8401a', 0.411, ry, rz, Math.PI / 2);
      }
      if (hi) { rivets(r, P.metal, -0.1, 0.3, 0.13, 0.162, 4); rivets(r, P.metal, -0.1, 0.3, 0.13, -0.162, 4); }
      r.pbox(P.dark, 0.06, 0.04, 0.2, -0.2, 0.0, 0);
      // Abstützungen hinten (klappen in Fahrt hoch)
      for (sd = -1; sd <= 1; sd += 2) sp.box(P.dark, 0.04, 0.2, 0.04, 0, -0.2, sd * 0.2).box(P.metal, 0.09, 0.02, 0.09, 0, -0.205, sd * 0.2);
      sp.pbox(T.team, 0.03, 0.03, 0.44, 0, -0.06, 0);
      M.parts.hull = b.geo(); M.parts.turret = t.geo(); M.parts.barrel = r.geo(); M.parts.spades = sp.geo(); M.parts.glow = g.geo(false);
      M.pivot = [-0.16, 0]; M.trun = [0.02, 0.36]; M.spadeAt = [-0.5, 0.2, 0];
      M.muzzle = [M.trun[0] + 0.29, M.trun[1] + 0.28];
      M.at = { barrel: [M.pivot[0] + M.trun[0], M.trun[1], 0], spades: M.spadeAt }; M.rest = HOW_EL;
      M.recoil = 0.03; M.h = 0.62; M.how = true; M.exhaust = [[0.2, 0.46, 0.19]];
      return M;
    }
    return M;
  }

  // ------------------------------------------------------------------ Neutrale Gebäude (SPEC_v03)
  // Teile: body (feste Farben), trim (weiß → pro Instanz mit Besitzerfarbe bzw. neutralem Beige getönt), dazu bewegte Teile
  // (dish, beam, crane, gun, barrel, lamp). Fahne (pole/cloth) ist für alle Typen gemeinsam. M.win = Fensterpositionen für Mündungsfeuer.
  var NEUT = {
    house: { w: 2, h: 2 }, block: { w: 3, h: 2 }, bunker: { w: 2, h: 2 }, oilrig: { w: 2, h: 2 },
    radar: { w: 2, h: 2 }, hospital: { w: 3, h: 2 }, workshop: { w: 3, h: 2 }, artillery: { w: 2, h: 2 },
    tradepost: { w: 3, h: 2 }   // v1.2 Handelsposten
  };
  var GARR = { house: 1, block: 1, bunker: 1 };
  BH.house = 1.0; BH.block = 1.3; BH.bunker = 0.55; BH.oilrig = 1.6; BH.radar = 1.45; BH.hospital = 0.75; BH.workshop = 1.0; BH.artillery = 0.55; BH.tradepost = 1.2;
  var NP = { wall: '#d6cbad', wall2: '#b8ad92', roof: '#a4604a', conc: '#a6a8a3', conc2: '#868981', dark: '#3b4249', glass: '#6fa6c4', metal: '#cfd5da',
    wood: '#7a5a3c', sand: '#b39d72', canvas: '#e9e5d4', green: '#2f9e5a', orange: '#d97706', earth: '#6b5a3c', frame: '#f3efe4' };
  var NTINT = [0.66, 0.64, 0.58]; // neutrale „Besitzerfarbe“ der Zierteile

  /** Streben/Stangen von p0 nach p1 (Quader mit Querschnitt t). */
  function strut(b, col, x0, y0, z0, x1, y1, z1, t) {
    var dx = x1 - x0, dy = y1 - y0, dz = z1 - z0, len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    var q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx / len, dy / len, dz / len));
    var e = new THREE.Euler().setFromQuaternion(q);
    return b.add(new THREE.BoxGeometry(t, len, t), col, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, e.y, e.x, e.z);
  }
  /** Rahmen um die Grundfläche (Zierteil, in Besitzerfarbe). */
  function nFrame(t, w, h) {
    var th = 0.09, hw = w / 2 - 0.03, hh = h / 2 - 0.03;
    t.box('#ffffff', w - 0.06, 0.07, th, 0, 0, hh - th / 2).box('#ffffff', w - 0.06, 0.07, th, 0, 0, -hh + th / 2)
      .box('#ffffff', th, 0.07, h - 0.06 - 2 * th, hw - th / 2, 0, 0).box('#ffffff', th, 0.07, h - 0.06 - 2 * th, -hw + th / 2, 0, 0);
  }
  function sandbags(b, x0, x1, z, rows, ry) {
    var n = Math.max(1, Math.round(Math.abs(x1 - x0) / 0.19));
    for (var r = 0; r < rows; r++) for (var i = 0; i < n - (r % 2); i++) {
      var x = x0 + (x1 - x0) * ((i + (r % 2) * 0.5 + 0.5) / n);
      b.pbox((i + r) % 2 ? '#b3a27c' : '#a39272', 0.2, 0.085, 0.13, ry ? z : x, 0.05 + r * 0.08, ry ? x : z, ry ? Math.PI / 2 : 0);
    }
  }

  function buildNeutral(type) {
    var bd = NEUT[type], w = bd.w, h = bd.h, b = new MB(), t = new MB(), M = { key: type, parts: {}, h: BH[type], at: {}, win: [], neutral: true, bt: {} }, i, k, d;
    var plate = type === 'oilrig' ? '#4d4438' : (type === 'artillery' ? '#74684c' : NP.conc);
    b.box(plate, w - 0.1, 0.05, h - 0.1, 0, 0, 0);
    nFrame(t, w, h);
    if (type === 'house') {
      b.box(NP.wall, 1.5, 0.56, 1.1, -0.05, 0.05, -0.05);
      b.prism(NP.wall, [[-0.62, 0.61], [0.62, 0.61], [0, 1.0]], 1.5, -0.05, 0, -0.05, Math.PI / 2);                  // Giebel
      var sl = Math.atan2(0.4, 0.66), sw = Math.sqrt(0.66 * 0.66 + 0.4 * 0.4) + 0.08;
      b.add(new THREE.BoxGeometry(1.8, 0.06, sw), NP.roof, -0.05, 0.82, 0.3, 0, sl, 0);                                   // Dach Süd
      b.add(new THREE.BoxGeometry(1.8, 0.06, sw), '#8d4f3d', -0.05, 0.82, -0.4, 0, -sl, 0);                                // Dach Nord
      t.box('#ffffff', 1.84, 0.07, 0.13, -0.05, 0.99, -0.05);                                                             // Firstband
      t.box('#ffffff', 1.8, 0.05, 0.05, -0.05, 0.56, 0.63);                                                               // Traufbrett
      for (i = 0; i < 2; i++) { var wx = -0.45 + i * 0.7; b.box(NP.frame, 0.3, 0.3, 0.015, wx, 0.17, 0.5).box(NP.glass, 0.2, 0.2, 0.025, wx, 0.22, 0.5); M.win.push([wx, 0.32, 0.52]); }
      b.box(NP.wood, 0.24, 0.38, 0.03, 0.55, 0.05, 0.5).box(NP.sand, 0.4, 0.05, 0.18, 0.55, 0.05, 0.6);                   // Tür + Stufe
      for (i = 0; i < 2; i++) { var wz = -0.3 + i * 0.45; b.box(NP.frame, 0.015, 0.3, 0.3, 0.7, 0.17, wz).box(NP.glass, 0.025, 0.2, 0.2, 0.7, 0.22, wz); M.win.push([0.72, 0.32, wz]); }
      b.box('#8b4a3a', 0.17, 0.5, 0.17, 0.42, 0.75, -0.32).box(NP.dark, 0.21, 0.04, 0.21, 0.42, 1.25, -0.32);               // Schornstein
      b.ico('#4a7a3c', 0.16, -0.78, 0.14, 0.72, 1.2, 0.85, 1.2, 1).ico('#5a8a45', 0.12, -0.55, 0.1, 0.8, 1, 0.8, 1, 1);
      b.box(NP.wall2, 0.34, 0.26, 0.3, -0.78, 0.05, -0.62);                                                               // Schuppen
      M.chim = [0.42, 1.3, -0.32]; M.flag = [-0.84, 0.84, 1.55];
    } else if (type === 'block') {
      b.box('#d2cab6', 2.6, 1.05, 1.5, 0, 0.05, 0);
      for (i = 0; i < 2; i++) b.box(NP.wall2, 2.64, 0.04, 1.54, 0, 0.38 + i * 0.32, 0);
      b.box(NP.conc, 2.68, 0.1, 0.08, 0, 1.1, 0.75).box(NP.conc, 2.68, 0.1, 0.08, 0, 1.1, -0.75).box(NP.conc, 0.08, 0.1, 1.58, 1.3, 1.1, 0).box(NP.conc, 0.08, 0.1, 1.58, -1.3, 1.1, 0);
      b.box('#5f625f', 2.5, 0.03, 1.42, 0, 1.1, 0);
      t.box('#ffffff', 2.64, 0.09, 0.03, 0, 0.96, 0.77);                                                                  // Fassadenband
      for (k = 0; k < 3; k++) {
        var wy = 0.14 + k * 0.32;
        for (i = 0; i < 5; i++) {
          var bx = -1.0 + i * 0.5;
          if (k === 0 && i === 2) { b.box(NP.dark, 0.32, 0.42, 0.03, 0, 0.05, 0.752); continue; }
          b.box(NP.frame, 0.3, 0.26, 0.015, bx, wy - 0.02, 0.752).box(NP.glass, 0.22, 0.19, 0.025, bx, wy + 0.015, 0.752);
          if (k > 0 && i % 2 === 0) { b.box(NP.conc, 0.42, 0.04, 0.24, bx, wy - 0.03, 0.87).box('#6b6f73', 0.42, 0.1, 0.02, bx, wy - 0.03, 0.98); }
          if (k > 0) M.win.push([bx, wy + 0.1, 0.77]);
        }
      }
      t.box('#ffffff', 0.56, 0.05, 0.22, 0, 0.5, 0.86);                                                                    // Vordach
      for (i = 0; i < 3; i++) { var sz = -0.5 + i * 0.5; for (k = 0; k < 3; k++) { b.box(NP.frame, 0.015, 0.26, 0.3, 1.3, 0.12 + k * 0.32, sz).box(NP.glass, 0.025, 0.19, 0.22, 1.3, 0.155 + k * 0.32, sz); } M.win.push([1.32, 0.7, sz]); }
      b.box(NP.wall2, 0.55, 0.3, 0.55, -0.85, 1.1, -0.25).box(NP.dark, 0.2, 0.2, 0.03, -0.85, 1.1, 0.04);
      b.box('#9aa0a4', 0.3, 0.14, 0.22, 0.6, 1.1, -0.2).box('#9aa0a4', 0.3, 0.14, 0.22, 0.95, 1.1, 0.2).cyl(NP.dark, 0.1, 0.1, 0.03, 8, 0.6, 1.24, -0.2);
      b.cyl(NP.metal, 0.012, 0.012, 0.5, 4, -0.85, 1.4, -0.25);
      M.flag = [1.2, 0.98, 1.95];
    } else if (type === 'bunker') {
      b.box(NP.conc2, 1.7, 0.3, 1.4, 0, 0.05, 0.02);
      b.box(NP.conc, 1.5, 0.2, 1.2, 0, 0.35, 0);
      b.prism(NP.conc, [[-0.75, 0.55], [0.75, 0.55], [0.6, 0.62], [-0.6, 0.62]], 1.2, 0, 0, 0, Math.PI / 2);
      for (i = 0; i < 3; i++) { b.box(NP.dark, 0.34, 0.07, 0.03, -0.45 + i * 0.45, 0.4, 0.61); M.win.push([-0.45 + i * 0.45, 0.45, 0.63]); }
      for (i = 0; i < 2; i++) { b.box(NP.dark, 0.03, 0.07, 0.3, 0.76, 0.4, -0.2 + i * 0.4); b.box(NP.dark, 0.03, 0.07, 0.3, -0.76, 0.4, -0.2 + i * 0.4); }
      M.win.push([0.78, 0.45, 0], [-0.78, 0.45, 0]);
      b.box(NP.dark, 0.26, 0.24, 0.03, -0.62, 0.05, 0.72);                                                                // Eingang
      b.cyl(NP.dark, 0.13, 0.15, 0.1, 8, 0.4, 0.6, -0.15).cyl(NP.metal, 0.03, 0.03, 0.12, 6, 0.4, 0.7, -0.15);            // Luke + Sehrohr
      t.box('#ffffff', 1.5, 0.05, 0.08, 0, 0.62, 0.56).box('#ffffff', 1.5, 0.05, 0.08, 0, 0.62, -0.56);                   // Dachrand
      sandbags(b, -0.85, 0.85, 0.88, 2, false); sandbags(b, 0.45, 0.85, 0.7, 1, false);
      sandbags(b, -0.5, 0.6, 0.93, 1, true); sandbags(b, -0.35, 0.45, -0.93, 1, true);
      M.flag = [0.95, 0.92, 1.4];
    } else if (type === 'oilrig') {
      var dx = -0.45, dz = -0.32, H = 1.55, Ls = [0.05, 0.45, 0.85, 1.2, H], hwf = function (y) { return 0.3 - 0.22 * (y / H); };
      var cs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      for (i = 0; i < 4; i++) strut(b, '#7f8a93', dx + cs[i][0] * 0.3, 0.05, dz + cs[i][1] * 0.3, dx + cs[i][0] * hwf(H), H, dz + cs[i][1] * hwf(H), 0.04);
      for (k = 0; k < 4; k++) for (i = 0; i < 4; i++) {
        var c0 = cs[i], c1 = cs[(i + 1) % 4], w0 = hwf(Ls[k]), w1 = hwf(Ls[k + 1]);
        strut(b, '#a9b2b8', dx + c0[0] * w0, Ls[k], dz + c0[1] * w0, dx + c1[0] * w1, Ls[k + 1], dz + c1[1] * w1, 0.025);
        strut(b, '#a9b2b8', dx + c0[0] * w1, Ls[k + 1], dz + c0[1] * w1, dx + c1[0] * w1, Ls[k + 1], dz + c1[1] * w1, 0.025);
      }
      t.box('#ffffff', 2 * hwf(0.85) + 0.12, 0.05, 2 * hwf(0.85) + 0.12, dx, 0.83, dz);                                    // Plattform in Besitzerfarbe
      b.box('#d9772b', 0.26, 0.12, 0.26, dx, H, dz).cyl('#d9772b', 0.012, 0.012, 0.2, 4, dx, H + 0.12, dz).cyl(NP.dark, 0.07, 0.09, 0.22, 6, dx, 0.05, dz);
      b.cyl('#b9bec2', 0.3, 0.3, 0.55, 10, 0.58, 0.05, -0.5).lathe('#b9bec2', [[0.3, 0], [0.22, 0.07], [0.0, 0.1]], 10, 0.58, 0.6, -0.5);
      t.cyl('#ffffff', 0.308, 0.308, 0.12, 10, 0.58, 0.3, -0.5);
      b.cylX(NP.dark, 0.035, 0.035, 1.0, 6, 0.1, 0.14, -0.4).cylX(NP.dark, 0.03, 0.03, 0.9, 6, 0.0, 0.1, 0.1);
      var jx = -0.05, jz = 0.52;
      b.box('#5b5f63', 1.1, 0.06, 0.34, jx, 0.05, jz);
      strut(b, '#6f7880', jx - 0.12, 0.1, jz - 0.14, jx, 0.62, jz - 0.04, 0.04); strut(b, '#6f7880', jx + 0.12, 0.1, jz - 0.14, jx, 0.62, jz - 0.04, 0.04);
      strut(b, '#6f7880', jx - 0.12, 0.1, jz + 0.14, jx, 0.62, jz + 0.04, 0.04); strut(b, '#6f7880', jx + 0.12, 0.1, jz + 0.14, jx, 0.62, jz + 0.04, 0.04);
      b.box(NP.orange, 0.24, 0.17, 0.22, jx - 0.44, 0.1, jz).cyl(NP.dark, 0.12, 0.12, 0.05, 8, jx - 0.3, 0.2, jz + 0.13).box(NP.dark, 0.06, 0.06, 0.06, jx + 0.0, 0.62, jz);
      b.cyl('#444a50', 0.055, 0.06, 0.34, 6, jx + 0.45, 0.1, jz).cyl(NP.dark, 0.09, 0.09, 0.04, 6, jx + 0.45, 0.1, jz);
      b.cyl('#3b6ea5', 0.1, 0.1, 0.22, 8, 0.8, 0.05, 0.3).cyl('#a5421c', 0.1, 0.1, 0.22, 8, 0.82, 0.05, 0.62);
      b.cyl('#1d1b19', 0.3, 0.3, 0.012, 10, 0.72, 0.05, 0.05);
      d = new MB();
      d.box('#c2410c', 1.0, 0.07, 0.1, 0, -0.035, 0).box('#c2410c', 0.1, 0.09, 0.2, 0, -0.05, 0);
      d.prism('#c2410c', [[0.40, 0.04], [0.40, -0.02], [0.52, -0.27], [0.59, -0.22], [0.52, 0.04]], 0.12, 0, 0, 0);
      d.box(NP.dark, 0.18, 0.2, 0.14, -0.47, -0.2, 0).box('#c2410c', 0.1, 0.07, 0.07, -0.47, -0.03, 0);
      M.parts.beam = d.geo(); M.at.beam = [jx, 0.62, jz];
      M.flag = [-0.85, 0.85, 1.75];
    } else if (type === 'radar') {
      b.box(NP.wall2, 1.15, 0.4, 0.85, -0.3, 0.05, 0.3).box(NP.conc, 1.22, 0.05, 0.92, -0.3, 0.45, 0.3);
      for (i = 0; i < 3; i++) b.box(NP.frame, 0.2, 0.15, 0.015, -0.65 + i * 0.35, 0.22, 0.726).box(NP.glass, 0.15, 0.1, 0.025, -0.65 + i * 0.35, 0.245, 0.726);
      b.box(NP.dark, 0.2, 0.28, 0.03, 0.0, 0.05, 0.726);
      b.box('#8a9096', 0.5, 0.3, 0.35, 0.45, 0.05, 0.55).box(NP.dark, 0.5, 0.04, 0.37, 0.45, 0.35, 0.55).cyl(NP.dark, 0.03, 0.03, 0.2, 5, 0.6, 0.35, 0.5);
      b.add(new THREE.CylinderGeometry(0.2, 0.05, 0.1, 10), NP.metal, -0.72, 0.65, 0.2, 0, 0, -0.5).cyl(NP.dark, 0.03, 0.03, 0.15, 5, -0.72, 0.5, 0.2);
      for (k = 0; k < 5; k++) b.cyl(k % 2 ? '#e5e7eb' : '#d1491f', 0.075, 0.085, 0.2, 6, 0.4, 0.05 + k * 0.2, -0.4);
      b.cyl(NP.dark, 0.22, 0.22, 0.04, 8, 0.4, 1.03, -0.4);
      t.cyl('#ffffff', 0.098, 0.098, 0.07, 6, 0.4, 0.5, -0.4); t.box('#ffffff', 1.16, 0.05, 0.05, -0.3, 0.4, 0.74);
      d = new MB();
      d.cyl(NP.dark, 0.04, 0.05, 0.2, 6, 0, 0, 0);
      var th = 0.6, ax = Math.sin(th), ay = Math.cos(th);
      d.add(new THREE.CylinderGeometry(0.5, 0.07, 0.17, 14), '#9ba4aa', 0.08, 0.34, 0, 0, 0, -th);
      d.add(new THREE.CylinderGeometry(0.5, 0.5, 0.025, 14), '#eef1f3', 0.08 + ax * 0.09, 0.34 + ay * 0.09, 0, 0, 0, -th);
      strut(d, NP.dark, 0.08 + ax * 0.1, 0.34 + ay * 0.1, 0, 0.08 + ax * 0.34, 0.34 + ay * 0.34, 0, 0.03);
      d.box('#d1491f', 0.07, 0.07, 0.07, 0.08 + ax * 0.36, 0.34 + ay * 0.36 - 0.03, 0);
      M.parts.dish = d.geo(); M.at.dish = [0.4, 1.07, -0.4];
      M.flag = [-0.85, 0.85, 1.8];
    } else if (type === 'hospital') {
      var tent = [[-0.5, 0.04], [0.5, 0.04], [0.5, 0.36], [0, 0.72], [-0.5, 0.36]];
      b.prism(NP.canvas, tent, 1.7, -0.62, 0, -0.28, Math.PI / 2);
      t.box('#ffffff', 1.72, 0.07, 0.03, -0.62, 0.27, 0.225);                                                             // Zeltband
      b.box(NP.dark, 0.34, 0.3, 0.03, -0.62, 0.05, 0.22).box('#cfd0c4', 0.4, 0.04, 0.05, -0.62, 0.35, 0.22);
      b.box('#cfd6d3', 1.0, 0.5, 0.95, 0.92, 0.05, -0.22).box(NP.conc, 1.06, 0.05, 1.0, 0.92, 0.55, -0.22);
      for (i = 0; i < 2; i++) b.box(NP.frame, 0.2, 0.2, 0.015, 0.68 + i * 0.5, 0.18, 0.255).box(NP.glass, 0.14, 0.14, 0.025, 0.68 + i * 0.5, 0.21, 0.255);
      t.box('#ffffff', 1.06, 0.06, 0.06, 0.92, 0.5, 0.27);
      b.box('#ffffff', 0.5, 0.02, 0.5, 0.92, 0.6, -0.22).box(NP.green, 0.34, 0.025, 0.1, 0.92, 0.61, -0.22).box(NP.green, 0.1, 0.025, 0.34, 0.92, 0.61, -0.22);   // flaches Symbol auf dem Dach
      // Sanitätswagen
      b.box('#f1f3f2', 0.62, 0.26, 0.32, -0.55, 0.12, 0.7).box('#f1f3f2', 0.2, 0.18, 0.31, -0.15, 0.12, 0.7).box(NP.glass, 0.02, 0.1, 0.25, -0.04, 0.2, 0.7);
      b.cylZ(NP.dark, 0.07, 0.04, 8, -0.7, 0.07, 0.86).cylZ(NP.dark, 0.07, 0.04, 8, -0.2, 0.07, 0.86).cylZ(NP.dark, 0.07, 0.04, 8, -0.7, 0.07, 0.54).cylZ(NP.dark, 0.07, 0.04, 8, -0.2, 0.07, 0.54);
      b.box(NP.green, 0.2, 0.1, 0.012, -0.55, 0.18, 0.866).box(NP.green, 0.07, 0.22, 0.012, -0.55, 0.12, 0.866);          // grünes Kreuz (nicht das Rotkreuz-Zeichen)
      t.box('#ffffff', 0.62, 0.04, 0.325, -0.55, 0.3, 0.7);
      // Hinweisschild auf Pfosten (weiß mit grünem Kreuz)
      b.cyl(NP.dark, 0.02, 0.02, 0.6, 4, 0.5, 0.05, 0.78).box('#ffffff', 0.5, 0.5, 0.04, 0.5, 0.6, 0.78).box(NP.green, 0.34, 0.11, 0.05, 0.5, 0.795, 0.78).box(NP.green, 0.11, 0.34, 0.05, 0.5, 0.685, 0.78);
      M.flag = [1.28, 0.8, 1.55];
    } else if (type === 'workshop') {
      b.box('#b4b09a', 2.6, 0.72, 1.3, 0, 0.05, -0.25);
      b.prism('#7e8a8e', [[-0.7, 0.77], [0.7, 0.77], [0, 1.0]], 2.7, 0, 0, -0.25, Math.PI / 2);
      b.box('#5f6a6e', 2.74, 0.04, 0.1, 0, 0.98, -0.25);
      b.box(NP.dark, 1.0, 0.56, 0.04, -0.3, 0.05, 0.41);                                                                   // offenes Tor: dunkle Halle
      b.box('#7a6f58', 0.96, 0.02, 0.7, -0.3, 0.05, 0.1);
      b.box(NP.orange, 0.34, 0.56, 0.05, -0.97, 0.05, 0.43).box(NP.orange, 0.34, 0.56, 0.05, 0.37, 0.05, 0.43).box('#1f2937', 0.34, 0.05, 0.055, -0.97, 0.3, 0.43).box('#1f2937', 0.34, 0.05, 0.055, 0.37, 0.3, 0.43);
      t.box('#ffffff', 2.64, 0.12, 0.06, 0, 0.64, 0.42);                                                                   // Blende über dem Tor
      for (i = 0; i < 2; i++) b.box(NP.frame, 0.4, 0.2, 0.015, 0.75 + i * 0.4, 0.38, 0.41).box(NP.glass, 0.33, 0.14, 0.025, 0.75 + i * 0.4, 0.41, 0.41);
      M.win.push([0.8, 0.45, 0.43]);
      b.cyl(NP.dark, 0.06, 0.06, 0.1, 6, 0.9, 0.05, 0.62).cyl(NP.dark, 0.06, 0.06, 0.1, 6, 0.9, 0.15, 0.62).cyl(NP.dark, 0.06, 0.06, 0.1, 6, 0.88, 0.25, 0.62);  // Reifenstapel
      b.cyl('#3b6ea5', 0.1, 0.1, 0.22, 8, -1.25, 0.05, 0.72).cyl('#a5421c', 0.1, 0.1, 0.22, 8, -1.05, 0.05, 0.8).box('#6b7176', 0.34, 0.2, 0.28, 0.35, 0.05, 0.78);
      d = new MB();
      d.box(NP.orange, 0.07, 1.1, 0.07, 0, 0, 0).box(NP.orange, 1.0, 0.06, 0.07, -0.45, 1.04, 0);
      strut(d, NP.orange, 0, 0.7, 0, -0.35, 1.04, 0, 0.04);
      d.box(NP.dark, 0.1, 0.08, 0.1, -0.88, 0.98, 0).cyl(NP.dark, 0.012, 0.012, 0.3, 4, -0.88, 0.68, 0).box(NP.metal, 0.07, 0.07, 0.07, -0.88, 0.62, 0);
      d.box(NP.dark, 0.18, 0.06, 0.18, 0, 0, 0);
      M.parts.crane = d.geo(); M.at.crane = [1.2, 0.05, 0.65];
      M.flag = [-1.35, 0.85, 1.6];
      M.spark = [-0.3, 0.2, 0.3];
    } else if (type === 'tradepost') {   // v1.2 Handelsposten: Lagerhalle mit Münzschild, Marktstände (Markisen in Besitzerfarbe), Container, Lkw, drehende Münze
      b.box('#c9b99a', 1.9, 0.6, 0.78, -0.3, 0.05, -0.52).box(NP.conc, 1.96, 0.05, 0.84, -0.3, 0.65, -0.52);
      for (i = 0; i < 3; i++) { b.box(NP.dark, 0.42, 0.4, 0.02, -0.95 + i * 0.62, 0.05, -0.125); b.pbox('#6b6f73', 0.42, 0.012, 0.024, -0.95 + i * 0.62, 0.15 + (i % 2) * 0.12, -0.12); }
      t.box('#ffffff', 1.92, 0.08, 0.04, -0.3, 0.52, -0.11);
      b.box('#3a3f45', 0.9, 0.32, 0.05, -0.3, 0.7, -0.2).cylZ('#e6b422', 0.11, 0.03, 12, -0.62, 0.86, -0.17).cylZ('#c58f12', 0.07, 0.035, 12, -0.62, 0.86, -0.17);
      b.box('#e9e5d4', 0.42, 0.06, 0.012, -0.12, 0.89, -0.17).box('#e9e5d4', 0.34, 0.05, 0.012, -0.16, 0.79, -0.17);
      for (i = 0; i < 2; i++) {   // Marktstände mit gestreiften Markisen
        var mx = -0.95 + i * 0.85;
        b.box(NP.wood, 0.58, 0.18, 0.3, mx, 0.05, 0.45);
        for (k = 0; k < 4; k++) b.pbox(['#d97706', '#4a7a3c', '#a5421c', '#e6b422'][(k + i) % 4], 0.1, 0.06, 0.1, mx - 0.21 + k * 0.14, 0.23, 0.45);
        for (k = 0; k < 4; k++) b.pbox(NP.wood, 0.025, 0.46, 0.025, mx + (k & 1 ? 0.3 : -0.3), 0.05, 0.45 + (k & 2 ? 0.24 : -0.24));
        for (k = 0; k < 5; k++) (k % 2 ? b : t).add(new THREE.BoxGeometry(0.134, 0.025, 0.62), k % 2 ? NP.canvas : '#ffffff', mx - 0.27 + k * 0.135, 0.5, 0.48, 0, -0.28, 0);
      }
      b.box('#2f6f8f', 0.34, 0.3, 0.7, 1.05, 0.05, -0.45).box('#b4532a', 0.34, 0.3, 0.7, 1.05, 0.35, -0.42).box('#557a3a', 0.34, 0.3, 0.6, 1.4, 0.05, -0.5);
      for (i = 0; i < 3; i++) b.box(NP.wood, 0.2, 0.17, 0.2, 0.7 + (i % 2) * 0.24, 0.05 + (i === 2 ? 0.17 : 0), 0.3 + (i === 2 ? 0.1 : 0));
      b.box('#d9d2bf', 0.32, 0.26, 0.3, 1.12, 0.12, 0.62).box('#6b7176', 0.26, 0.2, 0.3, 1.42, 0.12, 0.62).box(NP.glass, 0.02, 0.09, 0.24, 1.555, 0.2, 0.62);   // Lkw
      b.cylZ(NP.dark, 0.065, 0.32, 8, 1.05, 0.065, 0.62).cylZ(NP.dark, 0.065, 0.32, 8, 1.42, 0.065, 0.62);
      t.box('#ffffff', 0.33, 0.03, 0.31, 1.12, 0.38, 0.62);
      b.cyl(NP.dark, 0.022, 0.028, 0.95, 6, 0.55, 0.05, 0.75);
      d = new MB(); d.cylZ('#e6b422', 0.17, 0.035, 14, 0, 0, 0).cylZ('#c58f12', 0.12, 0.045, 14, 0, 0, 0).box('#f5d76e', 0.04, 0.16, 0.05, 0, -0.08, 0);
      M.parts.coin = d.geo(); M.at.coin = [0.55, 1.18, 0.75];
      M.flag = [-1.35, 0.8, 1.55];
    } else if (type === 'artillery') {
      b.box(NP.earth, 1.8, 0.28, 0.3, 0, 0.05, -0.8).box(NP.earth, 0.3, 0.28, 1.6, 0.82, 0.05, -0.1).box(NP.earth, 0.3, 0.28, 1.6, -0.82, 0.05, -0.1);
      sandbags(b, -0.9, 0.9, -0.8, 1, false); b.box('#5c4d33', 1.7, 0.03, 0.2, 0, 0.33, -0.8);
      sandbags(b, -0.95, -0.5, 0.78, 2, false); sandbags(b, 0.55, 0.95, 0.78, 2, false);
      for (i = 0; i < 3; i++) b.box(NP.wood, 0.22, 0.16, 0.18, 0.55, 0.05 + 0.16 * (i % 2), -0.45 + (i === 2 ? 0.2 : i * 0.22));   // Munitionskisten
      b.cylX('#b08d2c', 0.04, 0.04, 0.3, 6, 0.45, 0.09, 0.3).cylX('#b08d2c', 0.04, 0.04, 0.3, 6, 0.45, 0.09, 0.4).cylX('#b08d2c', 0.04, 0.04, 0.3, 6, 0.45, 0.17, 0.35);
      b.cyl(NP.dark, 0.02, 0.025, 0.55, 4, 0.72, 0.05, 0.72);                                                             // Lampenpfosten
      t.box('#ffffff', 1.8, 0.04, 0.12, 0, 0.33, -0.7);                                                                    // Besitzerband auf dem Wall
      d = new MB();   // Lafette (dreht mit dem Gieren)
      d.cyl('#4a523f', 0.34, 0.38, 0.1, 10, 0, 0.05, 0).box('#4f5a46', 0.5, 0.2, 0.34, -0.05, 0.12, 0);
      d.cylZ(NP.dark, 0.17, 0.06, 10, -0.05, 0.17, 0.34).cylZ(NP.dark, 0.17, 0.06, 10, -0.05, 0.17, -0.34);
      d.box('#4f5a46', 0.04, 0.34, 0.5, 0.2, 0.15, 0).box(NP.dark, 0.9, 0.05, 0.06, -0.55, 0.1, 0.14).box(NP.dark, 0.9, 0.05, 0.06, -0.55, 0.1, -0.14);
      d.box('#3b4249', 0.1, 0.1, 0.1, -0.98, 0.07, 0.3).box('#3b4249', 0.1, 0.1, 0.1, -0.98, 0.07, -0.3);
      d.box('#4f5a46', 0.18, 0.12, 0.3, 0.0, 0.3, 0);
      M.parts.gun = d.geo(); M.at.gun = [0, 0, 0.0];
      d = new MB();
      d.cylX('#5d6a52', 0.085, 0.09, 0.5, 8, 0.15, 0, 0).cylX('#4a5441', 0.06, 0.07, 1.0, 8, 0.85, 0, 0).cylX(NP.dark, 0.075, 0.075, 0.14, 8, 1.37, 0, 0);
      d.box('#4a5441', 0.26, 0.2, 0.2, -0.2, -0.08, 0).cylX(NP.dark, 0.04, 0.04, 0.26, 6, 0.3, -0.12, 0);
      M.parts.barrel = d.geo(); M.at.barrel = [0, 0.38, 0]; M.rest = 0.18;
      d = new MB(); d.box('#ffffff', 0.13, 0.11, 0.13, 0, 0, 0);
      M.parts.lamp = d.geo(false); M.at.lamp = [0.72, 0.6, 0.72];
      M.flag = [-0.92, 0.9, 1.5];
    }
    // W10: Feinschliff im Stil der v0.7-Modelle (zusätzliche Details am Körper; Teile/Haken – trim, dish, beam, crane, gun, barrel, lamp,
    // flag, chim, win, spark – unverändert). Kleinteile nur mit Flag hiPoly (V).
    var hi = HI(), sd, NPX = { body2: '#9aa0a4', dark: NP.dark, metal: NP.metal };
    if (type === 'house') {
      for (i = 0; i < 2; i++) { var hx = -0.45 + i * 0.7; b.pbox(NP.wood, 0.05, 0.26, 0.02, hx - 0.18, 0.19, 0.515).pbox(NP.wood, 0.05, 0.26, 0.02, hx + 0.18, 0.19, 0.515).pbox(NP.frame, 0.34, 0.025, 0.06, hx, 0.15, 0.525); }
      b.pbox('#6d4a39', 1.82, 0.03, 0.05, -0.05, 0.585, 0.66);                                                            // Regenrinne
      b.pbox(NP.roof, 0.42, 0.03, 0.24, 0.55, 0.46, 0.62).pbox(NP.wood, 0.025, 0.4, 0.025, 0.36, 0.06, 0.72).pbox(NP.wood, 0.025, 0.4, 0.025, 0.74, 0.06, 0.72);   // Vordach
      for (i = 0; i < 3; i++) b.pbox(NP.sand, 0.14, 0.012, 0.1, 0.55, 0.05, 0.78 + i * 0.12);                                // Trittplatten
      b.pbox('#d9d2bf', 0.9, 0.03, 0.02, -0.0, 0.16, 0.93).pbox('#d9d2bf', 0.9, 0.03, 0.02, -0.0, 0.24, 0.93);               // Zaun
      if (hi) for (i = 0; i < 5; i++) b.pbox('#d9d2bf', 0.03, 0.24, 0.03, -0.45 + i * 0.225, 0.05, 0.93);
      if (hi) { b.cyl(NP.dark, 0.012, 0.012, 0.16, 4, -0.5, 0.84, 0.2).add(new THREE.CylinderGeometry(0.09, 0.03, 0.04, 8), '#d9dde0', -0.5, 1.0, 0.2, 0, 0, -0.7); }   // Satellitenschüssel
    } else if (type === 'block') {
      for (sd = -1; sd <= 1; sd += 2) b.pbox('#8a8f92', 0.02, 0.06, 1.42, sd * 1.24, 1.13, 0).pbox('#8a8f92', 2.48, 0.06, 0.02, 0, 1.13, sd * 0.7);   // Dachgeländer
      b.cyl('#7b8186', 0.17, 0.17, 0.26, 10, 0.2, 1.24, -0.42).cyl('#5d6266', 0.18, 0.18, 0.03, 10, 0.2, 1.5, -0.42);         // Wassertank
      for (i = 0; i < 4; i++) b.pbox(NP.dark, 0.025, 0.12, 0.025, 0.2 + (i & 1 ? 0.12 : -0.12), 1.12, -0.42 + (i & 2 ? 0.12 : -0.12));
      b.pbox('#2d6a4f', 0.5, 0.12, 0.012, -0.5, 0.36, 0.77).pbox('#e9e5d4', 0.4, 0.05, 0.014, -0.5, 0.39, 0.775);           // Ladenschild
      if (hi) { b.box('#3f6b4a', 0.3, 0.16, 0.2, 1.12, 0.05, 0.92).box('#5b6066', 0.3, 0.16, 0.2, -1.1, 0.05, 0.92); acUnit(b, NPX, -0.2, 1.1, 0.35, 0.18); }   // Container, Klimagerät
    } else if (type === 'bunker') {
      b.quad('#5d6340', [-0.75, 0.66, -0.6], [0.15, 0.66, -0.6], [0.25, 0.7, 0.2], [-0.8, 0.68, 0.25], [0, 1, 0]);           // Tarnnetz
      b.quad('#6b6f48', [0.15, 0.66, -0.6], [0.7, 0.64, -0.55], [0.72, 0.66, 0.05], [0.25, 0.7, 0.2], [0, 1, 0]);
      b.cyl(NP.metal, 0.008, 0.01, 0.45, 4, -0.6, 0.62, -0.45).box(NP.wood, 0.2, 0.12, 0.16, 0.6, 0.05, -0.85).box(NP.wood, 0.2, 0.12, 0.16, 0.85, 0.05, -0.85);
      if (hi) for (i = 0; i < 4; i++) { b.pbox(NP.dark, 0.02, 0.18, 0.02, -0.85 + i * 0.55, 0.05, -0.95); }                   // Stacheldrahtpfosten
      if (hi) b.pbox('#55595c', 1.7, 0.012, 0.012, -0.03, 0.18, -0.95).pbox('#55595c', 1.7, 0.012, 0.012, -0.03, 0.12, -0.95);
    } else if (type === 'oilrig') {
      b.cylX('#59636b', 0.04, 0.04, 0.7, 6, 0.25, 0.1, -0.5).cylZ('#59636b', 0.035, 0.6, 6, 0.95, 0.1, 0.05);                // Rohrleitungen
      b.pbox('#e6b81c', 0.62, 0.03, 0.03, -0.45, 1.0, -0.02).pbox('#e6b81c', 0.03, 0.03, 0.62, -0.14, 1.0, -0.32);            // Geländer Plattform
      if (hi) for (i = 0; i < 6; i++) b.pbox('#9aa3a8', 0.08, 0.012, 0.03, -0.45 + 0.27, 0.15 + i * 0.12, -0.32 + 0.29);       // Leiter
      b.box('#c9ced2', 0.3, 0.24, 0.26, -0.75, 0.05, 0.6).pbox(NP.glass, 0.012, 0.08, 0.14, -0.6, 0.18, 0.6).pbox('#d97706', 0.32, 0.03, 0.28, -0.75, 0.29, 0.6);   // Steuerhütte
    } else if (type === 'radar') {
      b.cyl(NP.dark, 0.012, 0.016, 0.7, 4, -0.95, 0.45, 0.65).box('#d1491f', 0.05, 0.05, 0.05, -0.95, 1.15, 0.65);            // Mast mit Warnlicht
      acUnit(b, NPX, -0.55, 0.5, 0.0, 0.2); b.pbox(NP.dark, 0.012, 0.012, 0.9, -0.15, 0.52, 0.3);
      if (hi) { b.box('#8a9096', 0.14, 0.12, 0.1, 0.75, 0.05, -0.85).cylX(NP.dark, 0.02, 0.02, 0.4, 5, 0.55, 0.12, -0.6); }
    } else if (type === 'hospital') {
      for (sd = -1; sd <= 1; sd += 2) { b.pbox(NP.canvas, 0.03, 0.03, 0.03, -0.62 + sd * 0.95, 0.05, 0.3); strut(b, '#8a8577', -0.62 + sd * 0.85, 0.42, 0.22, -0.62 + sd * 0.95, 0.06, 0.3, 0.008); }   // Abspannseile
      b.pbox('#6b7a5a', 0.4, 0.04, 0.14, -0.1, 0.12, 0.95).pbox(NP.dark, 0.02, 0.1, 0.02, -0.28, 0.05, 0.9).pbox(NP.dark, 0.02, 0.1, 0.02, 0.08, 0.05, 0.9);   // Trage
      b.box(NP.wood, 0.18, 0.14, 0.16, 1.25, 0.05, 0.55).box('#e9e5d4', 0.16, 0.12, 0.14, 1.25, 0.19, 0.55).pbox(NP.green, 0.08, 0.025, 0.145, 1.25, 0.25, 0.55);
      if (hi) b.cyl('#9aa0a4', 0.12, 0.12, 0.3, 8, 1.3, 0.55, -0.55);
    } else if (type === 'workshop') {
      for (i = 0; i < 3; i++) b.pbox(NP.glass, 0.45, 0.012, 0.2, -0.85 + i * 0.85, 0.89, 0.02, 0, -0.32);                    // Oberlichter (Südseite des Satteldachs)
      roofFan(b, NPX, -0.4, 0.95, -0.55, 0.08); roofFan(b, NPX, 0.6, 0.95, -0.55, 0.08);
      b.quad('#2b2a27', [-0.75, 0.051, 0.5], [0.2, 0.051, 0.5], [0.15, 0.051, 0.85], [-0.6, 0.051, 0.8], [0, 1, 0]);        // Ölfleck vor dem Tor
      b.pbox('#6b5a3c', 0.5, 0.2, 0.18, -0.3, 0.05, -0.3).pbox(NP.dark, 0.5, 0.03, 0.2, -0.3, 0.25, -0.3);                   // Werkbank in der Halle
      if (hi) { b.cyl('#3a7d44', 0.04, 0.04, 0.24, 6, 1.2, 0.05, 0.5).cyl('#9b2c2c', 0.04, 0.04, 0.24, 6, 1.3, 0.05, 0.42); }   // Gasflaschen
    } else if (type === 'artillery') {
      for (i = 0; i < 4; i++) b.pbox(NP.wood, 0.025, 0.5, 0.025, (i & 1 ? 0.75 : -0.75), 0.05, (i & 2 ? 0.55 : -0.65));     // Tarnnetzstangen
      b.quad('#59603d', [-0.78, 0.56, -0.66], [0.78, 0.56, -0.66], [0.78, 0.5, -0.3], [-0.78, 0.5, -0.3], [0, 1, 0]);        // Tarnnetz (hinten, über dem Wall)
      if (hi) { b.cyl(NP.dark, 0.008, 0.012, 0.26, 4, -0.55, 0.05, 0.45).box('#4a5441', 0.1, 0.06, 0.06, -0.55, 0.3, 0.45); }   // Entfernungsmesser
    }
    if (!hi) M.key = type + '~';
    M.parts.body = b.geo(); M.parts.trim = t.geo(false);
    return M;
  }

  var ruinCache = {};
  /** Trümmerhaufen für Fläche w×h (Kacheln). */
  function ruinModel(w, h) {
    var key = w + 'x' + h;
    if (ruinCache[key]) return ruinCache[key];
    var b = new MB(), i, cols = ['#3d3a35', '#4a453d', '#2e2c29', '#5a5246', '#36322d'];
    b.box('#2a2724', w - 0.1, 0.04, h - 0.1, 0, 0, 0);
    for (i = 0; i < 26; i++) {
      var sx = 0.14 + hash(i, w, 3) * 0.4, sz = 0.14 + hash(i, h, 5) * 0.4, sy = 0.06 + hash(i, 7, w * h) * 0.24;
      var px = (hash(i, 11, w) - 0.5) * (w - 0.5), pz = (hash(i, 13, h) - 0.5) * (h - 0.5);
      b.box(cols[i % 5], sx, sy, sz, px, 0.03 + (hash(i, 17, 1) < 0.25 ? 0.1 : 0), pz, hash(i, 19, 2) * 3.14, (hash(i, 23, 1) - 0.5) * 0.4, (hash(i, 29, 1) - 0.5) * 0.4);
    }
    for (i = 0; i < 3; i++) b.box('#6b6558', 0.5 + hash(i, 31, 1) * 0.5, 0.35 + hash(i, 37, 1) * 0.25, 0.08, (hash(i, 41, w) - 0.5) * (w - 1), 0.03, (hash(i, 43, h) - 0.5) * (h - 1.2), hash(i, 47, 1) * 1.2);
    for (i = 0; i < 5; i++) b.cyl('#2c1f16', 0.025, 0.03, 0.8, 4, (hash(i, 53, w) - 0.5) * (w - 0.6), 0.05, (hash(i, 59, h) - 0.5) * (h - 0.6));
    return (ruinCache[key] = { key: 'ruin' + key, parts: { body: b.geo() }, h: 0.4, bt: {} });
  }

  var flagModel = null;
  function getFlagModel() {
    if (flagModel) return flagModel;
    var p = new MB(), c = new MB();
    p.cyl('#c9ced2', 0.02, 0.026, 1, 6, 0, 0, 0);
    c.box('#ffffff', 0.42, 0.34, 0.018, 0.21, 0, 0);
    return (flagModel = { key: 'flag', parts: { pole: p.geo(false), cloth: c.geo(false) }, bt: {} });
  }

  var modelCache = {};
  function facOfColor(color) {
    var F = D.FACTIONS;
    var c = String(color).toLowerCase();
    for (var k in F) if (F[k].color.toLowerCase() === c || (F[k].alt && F[k].alt.toLowerCase() === c)) return k;   // GB: auch Ersatzfarbe (Spiegelpartie)
    return 'coalition';
  }
  function isBld(type) { return !!(D.BUILDINGS[type] || NEUT[type] || V4B[type] || V5B[type]); }
  // ------------------------------------------------------------------ v0.8: Luftwaffe & Marine (SPEC_v08 §7) – Modelle im Modern-Stil
  // Konvention wie alle Einheiten: Vorwärts = +x, Kacheln; Ursprung = Bodenpunkt (Luft: Fahrwerk-Unterkante, See: Wasserlinie).
  // Animierte Teile (gezeichnet in drawV8U / drawBldV8):
  //   Luft: xp k 'rotor' (dreht um die eigene y-Achse, d = Drehsinn), 'trot' (Heckrotor, Achse z), 'prop' (Propeller, Achse x),
  //         'bomb' (Bombe i, sichtbar solange i < e.ammo); M.rotors = [[x, y, z, r], …] (Rotorkreise: Unschärfe-Scheibe, Sprites).
  //   See:  turret/barrel um M.pivot (wie Panzer); Zerstörer zusätzlich turB/barB (Heckturm, Ruhe nach achtern) um M.piv2 und
  //         aaT/aaB (Flak-Lafette, aaB erhöht um M.aaTr); Landungsboot xp k 'ramp' (Bugklappe; Gelenk im Ursprung, geschlossen = senkrecht).
  //   Teile mit eigenem Drehpunkt (turB, barB, aaT, aaB; Flak-Stellung: barrel) sind in Rumpf-/Gebäudekoordinaten in Ruhestellung gebaut –
  //   Symbole und das Sprite-Bake zeigen sie ohne Sonderbehandlung richtig; zur Laufzeit dreht r3-models sie um ihren Drehpunkt.
  // Detailstufe: Flag hiPoly (V) aus → ohne Kleinteile (Typen in LOD). Budget: Einheiten ≲ 1,6k, Gebäude ≲ 4k Dreiecke.
  var V8M = { transheli: 1, gunship: 1, bomber: 1, gunboat: 1, destroyer: 1, lander: 1, airfield: 1, shipyard: 1, flak: 1 };
  var WL8 = -0.13;                          // Wasserspiegel (wie r3-terrain WL)
  var RAMP_OPEN = -1.95;                    // Bugklappe offen (rad um die Querachse, nach vorn/unten)
  var NAVL = '#ff3b2a', NAVR = '#36e07a', STROBE = '#fff4d8';
  function triO(arr, p, q, r, h) {          // Dreieck, Außenseite zur Richtung h
    var ux = q[0] - p[0], uy = q[1] - p[1], uz = q[2] - p[2], vx = r[0] - p[0], vy = r[1] - p[1], vz = r[2] - p[2];
    if ((uy * vz - uz * vy) * h[0] + (uz * vx - ux * vz) * h[1] + (ux * vy - uy * vx) * h[2] < 0) { var t = q; q = r; r = t; }
    arr.push(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2]);
  }
  function geoOf(arr) { var g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3)); g.computeVertexNormals(); return g; }
  /** Schiffsrumpf aus Spanten st = [[x, halbe Breite, Deckhöhe, Kielhöhe], …] (Heck → Bug): Bordwand (Knickspant) col, Deck dcol,
   *  optional Band bcol zwischen den Bordwand-Anteilen f0..f1 (0 = Deckkante, 1 = Kimm) – Teamfarbe/Wasserpass. */
  function loftHull(b, col, dcol, st, bcol, f0, f1) {
    var sd = [], dk = [], bd = [], i, j;
    function P(s, sg, f) {
      var w = s[1], cy = s[3] + (s[2] - s[3]) * 0.4;
      if (f <= 1) return [s[0], s[2] + (cy - s[2]) * f, sg * (w - w * 0.14 * f)];
      return [s[0], s[3], 0];
    }
    for (i = 0; i < st.length - 1; i++) {
      var a = st[i], c = st[i + 1];
      for (j = -1; j <= 1; j += 2) {
        var a0 = P(a, j, 0), a1 = P(a, j, 1), a2 = P(a, j, 2), c0 = P(c, j, 0), c1 = P(c, j, 1), c2 = P(c, j, 2), hu = [0, 0.2, j], hd = [0, -0.6, j];
        triO(sd, a0, c0, c1, hu); triO(sd, a0, c1, a1, hu); triO(sd, a1, c1, c2, hd); triO(sd, a1, c2, a2, hd);
        if (bcol) {
          var A0 = P(a, j, f0), A1 = P(a, j, f1), C0 = P(c, j, f0), C1 = P(c, j, f1), o = j * 0.004;
          A0[2] += o; A1[2] += o; C0[2] += o; C1[2] += o;
          triO(bd, A0, C0, C1, [0, 0, j]); triO(bd, A0, C1, A1, [0, 0, j]);
        }
      }
      triO(dk, [a[0], a[2], -a[1]], [c[0], c[2], -c[1]], [c[0], c[2], c[1]], [0, 1, 0]); triO(dk, [a[0], a[2], -a[1]], [c[0], c[2], c[1]], [a[0], a[2], a[1]], [0, 1, 0]);
    }
    var s0 = st[0], hb = [-1, 0, 0], sl = st[st.length - 1], hf = [1, 0, 0];
    triO(sd, P(s0, -1, 0), P(s0, -1, 1), P(s0, 1, 1), hb); triO(sd, P(s0, -1, 0), P(s0, 1, 1), P(s0, 1, 0), hb); triO(sd, P(s0, -1, 1), P(s0, 1, 2), P(s0, 1, 1), hb);
    if (sl[1] > 0.003) { triO(sd, P(sl, -1, 0), P(sl, -1, 1), P(sl, 1, 1), hf); triO(sd, P(sl, -1, 0), P(sl, 1, 1), P(sl, 1, 0), hf); triO(sd, P(sl, -1, 1), P(sl, 1, 2), P(sl, 1, 1), hf); }
    b.add(geoOf(sd), col, 0, 0, 0); b.add(geoOf(dk), dcol, 0, 0, 0);
    if (bcol && bd.length) b.add(geoOf(bd), bcol, 0, 0, 0);
    return b;
  }
  /** Flache Tragfläche/Platte: Grundriss pts [[x, z], …], Dicke th, Unterkante y. */
  function wing(b, col, pts, th, y) {
    var sh = new THREE.Shape(), i;
    sh.moveTo(pts[0][0], pts[0][1]);
    for (i = 1; i < pts.length; i++) sh.lineTo(pts[i][0], pts[i][1]);
    var g = new THREE.ExtrudeGeometry(sh, { depth: th, bevelEnabled: false, steps: 1, curveSegments: 1 });
    g.rotateX(Math.PI / 2); g.deleteAttribute('uv');
    return b.add(g, col, 0, y + th, 0);
  }
  /** Spiegelbild eines Grundrisses an z = 0 (für symmetrische Flächen aus einer Hälfte). */
  function symZ(half) { var o = half.slice(), i; for (i = half.length - 1; i >= 0; i--) o.push([half[i][0], -half[i][1]]); return o; }
  /** Hauptrotor (Achse y, Ursprung = Nabe): nb Blätter, Länge r, Blattspitzen hell. */
  function rotorGeo(r, nb, wd, col, hub, lo) {
    var g = new MB('unit'), i, a;
    g.cylB(hub, 0.045, 0.05, lo ? 6 : 8, 0, -0.03, 0, 0.01);
    for (i = 0; i < nb; i++) {
      a = i / nb * Math.PI * 2;
      g.add(new THREE.BoxGeometry(r - 0.04, 0.012, wd), col, Math.cos(a) * (r / 2 + 0.01), 0.008, Math.sin(a) * (r / 2 + 0.01), -a);
      if (!lo) g.add(new THREE.BoxGeometry(0.05, 0.013, wd + 0.002), '#e4e7ea', Math.cos(a) * (r - 0.035), 0.008, Math.sin(a) * (r - 0.035), -a);
    }
    return g.geo(false);
  }
  /** Heckrotor (Achse z, Ursprung = Nabe). */
  function trotGeo(r, col, hub) {
    var g = new MB('unit');
    g.cylZ(hub, 0.022, 0.04, 6, 0, 0, 0);
    g.add(new THREE.BoxGeometry(r * 2, 0.026, 0.008), col, 0, 0, 0.02).add(new THREE.BoxGeometry(0.026, r * 2, 0.008), col, 0, 0, 0.02);
    return g.geo(false);
  }
  /** Propeller (Achse x, Ursprung = Nabe): Spinner + 4 Blätter. */
  function propGeo(r, col, hub) {
    var g = new MB('unit'), i, a;
    g.add(new THREE.ConeGeometry(0.034, 0.08, 8), hub, 0.03, 0, 0, 0, 0, -Math.PI / 2);
    for (i = 0; i < 4; i++) { a = i * Math.PI / 2 + 0.4; g.add(new THREE.BoxGeometry(0.01, r, 0.036), col, 0, Math.cos(a) * r / 2, Math.sin(a) * r / 2, 0, a, 0); }
    return g.geo(false);
  }
  /** Bombe (Ursprung = Mitte, Spitze +x) mit Leitwerk und gelbem Ring. */
  function bombGeo(col, fin) {
    var g = new MB('unit');
    g.add(new THREE.CylinderGeometry(0.03, 0.03, 0.15, 6, 1, true), col, 0, 0, 0, 0, 0, -Math.PI / 2).add(new THREE.ConeGeometry(0.03, 0.07, 6, 1, true), col, 0.11, 0, 0, 0, 0, -Math.PI / 2).add(new THREE.ConeGeometry(0.03, 0.06, 6, 1, true), col, -0.105, 0, 0, 0, 0, Math.PI / 2);
    g.add(new THREE.BoxGeometry(0.05, 0.08, 0.006), fin, -0.125, 0, 0).add(new THREE.BoxGeometry(0.05, 0.006, 0.08), fin, -0.125, 0, 0);
    g.add(new THREE.CylinderGeometry(0.031, 0.031, 0.014, 6, 1, true), '#e8c547', 0.06, 0, 0, 0, 0, -Math.PI / 2);
    return g.geo(false);
  }
  /** Geschützturm (Seeziel-Kanone) am Drehpunkt px (Rumpfkoordinaten), Blick sg = ±1; t Turm, r Rohr. hgt: Ober-/Unterkante. */
  function navTurret(t, r, P, T, px, sg, big, syn, hy) {
    var L = function (x) { return px + sg * x; }, ry = sg < 0 ? Math.PI : 0, k = big ? 1 : 0.8;
    t.cylB(P.body2, 0.1 * k, 0.05, 10, px, hy, 0, 0.01);
    if (!syn) {
      t.prism(P.body, [[-0.12 * k, hy + 0.04], [0.05 * k, hy + 0.04], [0.13 * k, hy + 0.08], [0.06 * k, hy + 0.14 * k], [-0.12 * k, hy + 0.14 * k]], 0.19 * k, px, 0, 0, ry, 0.012);
      t.pbox(T.team, 0.12 * k, 0.008, 0.12 * k, L(-0.04 * k), hy + 0.14 * k, 0);
    } else {
      t.box(P.body, 0.2 * k, 0.1 * k, 0.2 * k, L(-0.01), hy + 0.04, 0).box(P.rust, 0.05 * k, 0.12 * k, 0.22 * k, L(0.1 * k), hy + 0.04, 0);
      t.pbox(T.team, 0.1 * k, 0.008, 0.21 * k, L(-0.05 * k), hy + 0.04 + 0.1 * k, 0);
    }
    var by = hy + 0.09 * k, bl = big ? 0.32 : 0.24;
    r.cylX(P.dark, 0.02 * k + 0.004, 0.017 * k + 0.003, bl, 8, L(0.08 * k + bl / 2), by, 0).cylX(P.metal, 0.026 * k, 0.026 * k, 0.04, 8, L(0.08 * k + bl - 0.01), by, 0);
    return { muzzle: [0.08 * k + bl + 0.01, by] };
  }

  function buildV8(type, fac, color) {
    var P = PAL[fac], T = teamCols(color), syn = fac === 'syndicate', hi = HI(), lo = !hi, i, k, a, zz;
    var b = new MB(), g = new MB(), t = new MB(), r = new MB();
    var M = { parts: {}, xparts: {}, xp: [], pivot: [0, 0], recoil: 0.04, muzzle: [0.3, 0.2], h: 0.4, lo: lo };
    var bd = D.BUILDINGS[type];
    if (bd) { M.h = 0.6; buildBldV8(type, fac, color, M, P, T, syn, hi, b, g, t, r, bd); M.v8b = type; M.parts.body = b.geo(); if (g.list.length) M.parts.glow = g.geo(false); return M; }
    var HULL = syn ? '#6f7a63' : '#8d99a4', HULL2 = syn ? '#565f4c' : '#6c7782', DECK = syn ? '#5b5848' : '#626c74';
    if (type === 'transheli') {
      M.air = 1; M.h = 0.62;
      if (!syn) {   // Koalition: Tandemrotor-Transporter, lange Kastenzelle, hoher Heckpylon
        b.prism(P.body, [[-0.6, 0.1], [0.46, 0.07], [0.6, 0.13], [0.64, 0.22], [0.56, 0.33], [0.4, 0.38], [-0.56, 0.38], [-0.64, 0.3]], 0.32, 0, 0, 0);
        b.prism(P.glass, [[0.44, 0.22], [0.615, 0.18], [0.645, 0.23], [0.56, 0.33], [0.42, 0.365]], 0.326, 0, 0, 0, 0, 0.004);
        b.box(P.body2, 0.34, 0.16, 0.22, -0.44, 0.36, 0).prism(P.body2, [[-0.64, 0.36], [-0.26, 0.36], [-0.32, 0.46], [-0.58, 0.58]], 0.2, 0, 0, 0);
        b.box(P.body2, 0.22, 0.06, 0.16, 0.4, 0.36, 0);
        b.cylX(P.body2, 0.055, 0.055, 0.6, 8, -0.04, 0.12, 0.18).cylX(P.body2, 0.055, 0.055, 0.6, 8, -0.04, 0.12, -0.18);   // Seitentanks
        b.cylX(P.dark, 0.055, 0.05, 0.24, 8, -0.43, 0.46, 0.15).cylX(P.dark, 0.055, 0.05, 0.24, 8, -0.43, 0.46, -0.15);   // Triebwerke
        b.pbox(T.team, 1.02, 0.045, 0.328, -0.05, 0.27, 0).pbox(T.team, 0.44, 0.008, 0.18, -0.02, 0.38, 0).pbox(T.team, 0.14, 0.03, 0.204, -0.47, 0.5, 0);
        for (i = 0; i < 4; i++) b.pbox(P.glass, 0.05, 0.05, 0.33, -0.32 + i * 0.16, 0.19, 0);
        if (hi) {
          b.cylX(P.metal, 0.058, 0.058, 0.02, 8, -0.31, 0.46, 0.15).cylX(P.metal, 0.058, 0.058, 0.02, 8, -0.31, 0.46, -0.15);
          b.pbox(P.dark, 0.012, 0.18, 0.3, -0.63, 0.12, 0).top(P.dark, -0.2, -0.16, 0.3, -0.16, 0.3805, 0.01).top(P.dark, -0.2, 0.16, 0.3, 0.16, 0.3805, 0.01);
          b.cyl(P.metal, 0.006, 0.008, 0.12, 4, 0.1, 0.38, 0.05);
        }
        for (i = 0; i < 4; i++) b.cylZ(P.track, 0.042, 0.035, 8, i < 2 ? 0.38 : -0.42, 0.042, (i & 1 ? 1 : -1) * 0.12);
        M.xparts.rotor = rotorGeo(0.45, 3, 0.055, P.dark, P.metal, lo);
        M.xp.push({ p: 'rotor', x: 0.4, y: 0.45, z: 0, k: 'rotor', d: 1 }, { p: 'rotor', x: -0.46, y: 0.61, z: 0, k: 'rotor', d: -1 });
        M.rotors = [[0.4, 0.46, 0, 0.45], [-0.46, 0.62, 0, 0.45]];
        g.ico(NAVL, 0.02, 0.02, 0.14, -0.17, 1, 1, 1, 0).ico(NAVR, 0.02, 0.02, 0.14, 0.17, 1, 1, 1, 0).ico(STROBE, 0.022, -0.56, 0.6, 0, 1, 1, 1, 0);
        M.exhaust = [[-0.56, 0.46, 0.15], [-0.56, 0.46, -0.15]];
      } else {      // Syndikat: schwerer Einrotor-Transporter mit Heckausleger, runde Fenster, Zusatztanks
        b.prism(P.body, [[-0.38, 0.08], [0.36, 0.06], [0.5, 0.12], [0.56, 0.21], [0.5, 0.32], [0.32, 0.38], [-0.38, 0.38]], 0.34, 0, 0, 0);
        b.prism(P.glass, [[0.4, 0.2], [0.548, 0.19], [0.505, 0.31], [0.33, 0.37]], 0.346, 0, 0, 0, 0, 0.004);
        b.prism(P.body2, [[-0.98, 0.25], [-0.34, 0.18], [-0.34, 0.36], [-0.94, 0.31]], 0.1, 0, 0, 0);
        b.prism(P.body2, [[-1.04, 0.24], [-0.9, 0.26], [-0.88, 0.5], [-0.98, 0.52]], 0.04, 0, 0, 0);
        b.box(P.body2, 0.54, 0.11, 0.22, 0.0, 0.37, 0).box(P.rust, 0.18, 0.06, 0.16, -0.24, 0.42, 0);
        b.cylX(P.dark, 0.05, 0.05, 0.1, 8, 0.29, 0.43, 0.065).cylX(P.dark, 0.05, 0.05, 0.1, 8, 0.29, 0.43, -0.065);
        b.cylX(P.body2, 0.06, 0.06, 0.38, 8, -0.02, 0.17, 0.205).cylX(P.body2, 0.06, 0.06, 0.38, 8, -0.02, 0.17, -0.205);
        for (i = 0; i < 4; i++) b.cylZ(P.glass, 0.028, 0.348, 8, -0.24 + i * 0.13, 0.25, 0);
        b.pbox(T.team, 0.86, 0.04, 0.348, -0.04, 0.31, 0).pbox(T.team, 0.12, 0.09, 0.104, -0.7, 0.23, 0).pbox(T.team, 0.3, 0.008, 0.16, -0.02, 0.48, 0);
        if (hi) {
          b.cylX(P.rust, 0.03, 0.04, 0.1, 6, -0.26, 0.46, 0.08).cylX(P.rust, 0.03, 0.04, 0.1, 6, -0.26, 0.46, -0.08);
          b.pbox(P.dark, 0.16, 0.2, 0.012, -0.12, 0.08, 0.172).pbox(P.dark, 0.012, 0.22, 0.3, -0.385, 0.1, 0);
          rivets(b, P.metal, -0.3, 0.3, 0.12, 0.172, 6);
        }
        b.cylZ(P.track, 0.04, 0.03, 8, 0.42, 0.04, 0).cylZ(P.track, 0.045, 0.035, 8, -0.12, 0.045, 0.19).cylZ(P.track, 0.045, 0.035, 8, -0.12, 0.045, -0.19);
        M.xparts.rotor = rotorGeo(0.56, 5, 0.05, P.dark, P.metal, lo); M.xparts.trot = trotGeo(0.12, P.dark, P.metal);
        M.xp.push({ p: 'rotor', x: 0.02, y: 0.5, z: 0, k: 'rotor', d: 1 }, { p: 'trot', x: -0.95, y: 0.42, z: 0.045, k: 'trot', d: 1 });
        M.rotors = [[0.02, 0.51, 0, 0.56]];
        g.ico(NAVL, 0.02, 0.1, 0.16, -0.21, 1, 1, 1, 0).ico(NAVR, 0.02, 0.1, 0.16, 0.21, 1, 1, 1, 0).ico(STROBE, 0.022, -0.98, 0.53, 0, 1, 1, 1, 0);
        M.exhaust = [[-0.32, 0.46, 0.08], [-0.32, 0.46, -0.08]];
      }
    } else if (type === 'gunship') {
      M.air = 1; M.h = 0.5; M.pods = 1;
      if (!syn) {   // Koalition: schlanker Kampfhubschrauber, Tandemkanzel, Stummelflügel mit Raketenbehältern, Kinnkanone
        b.prism(P.body, [[-0.32, 0.12], [0.3, 0.08], [0.44, 0.13], [0.46, 0.19], [0.36, 0.23], [-0.08, 0.3], [-0.32, 0.29]], 0.18, 0, 0, 0);
        b.prism(P.glass, [[0.12, 0.24], [0.4, 0.205], [0.31, 0.29], [0.15, 0.32]], 0.14, 0, 0, 0, 0, 0.006).prism(P.glass, [[-0.08, 0.29], [0.13, 0.285], [0.09, 0.36], [-0.05, 0.37]], 0.15, 0, 0, 0, 0, 0.006);
        b.prism(P.body2, [[-0.88, 0.24], [-0.3, 0.17], [-0.3, 0.29], [-0.86, 0.29]], 0.08, 0, 0, 0);
        b.prism(P.body, [[-0.94, 0.24], [-0.8, 0.26], [-0.84, 0.47], [-0.93, 0.47]], 0.03, 0, 0, 0).pbox(T.team, 0.09, 0.04, 0.034, -0.885, 0.44, 0);
        b.box(P.body2, 0.08, 0.016, 0.34, -0.8, 0.27, 0);
        b.cylX(P.body2, 0.05, 0.045, 0.26, 8, -0.15, 0.3, 0.115).cylX(P.body2, 0.05, 0.045, 0.26, 8, -0.15, 0.3, -0.115);
        b.box(P.body2, 0.12, 0.025, 0.58, -0.02, 0.19, 0);
        for (k = -1; k <= 1; k += 2) {
          b.pbox(P.dark, 0.03, 0.04, 0.03, 0.0, 0.16, k * 0.25).cylX(P.dark, 0.042, 0.042, 0.22, 8, 0.01, 0.135, k * 0.25).cylX(P.metal, 0.044, 0.044, 0.02, 8, 0.12, 0.135, k * 0.25);
          b.pbox(P.dark, 0.18, 0.025, 0.05, 0.0, 0.14, k * 0.14);
          if (hi) b.cylX('#d6d2c4', 0.012, 0.012, 0.12, 5, 0.06, 0.13, k * 0.155).cylX('#d6d2c4', 0.012, 0.012, 0.12, 5, 0.06, 0.13, k * 0.125);
        }
        b.sph(P.dark, 0.035, 0.36, 0.08, 0, 1, 1, 1, 6).cylX(P.dark, 0.009, 0.009, 0.14, 4, 0.44, 0.075, 0);
        b.pbox(T.team, 0.4, 0.035, 0.184, -0.06, 0.2, 0).pbox(T.team, 0.12, 0.03, 0.084, -0.6, 0.255, 0).pbox(T.team, 0.12, 0.012, 0.58, -0.02, 0.215, 0);
        b.cylZ(P.track, 0.036, 0.03, 8, 0.16, 0.036, 0.12).cylZ(P.track, 0.036, 0.03, 8, 0.16, 0.036, -0.12).cylZ(P.track, 0.03, 0.02, 6, -0.8, 0.12, 0);
        if (hi) { b.pbox(P.dark, 0.012, 0.18, 0.012, 0.16, 0.036, 0.12).pbox(P.dark, 0.012, 0.18, 0.012, 0.16, 0.036, -0.12); b.cyl(P.metal, 0.005, 0.007, 0.1, 4, -0.2, 0.32, 0.04); }
        M.xparts.rotor = rotorGeo(0.5, 4, 0.05, P.dark, P.metal, lo); M.xparts.trot = trotGeo(0.1, P.dark, P.metal);
        M.xp.push({ p: 'rotor', x: -0.02, y: 0.4, z: 0, k: 'rotor', d: 1 }, { p: 'trot', x: -0.88, y: 0.42, z: 0.035, k: 'trot', d: 1 });
        M.rotors = [[-0.02, 0.41, 0, 0.5]];
        g.ico(NAVL, 0.018, -0.02, 0.21, -0.29, 1, 1, 1, 0).ico(NAVR, 0.018, -0.02, 0.21, 0.29, 1, 1, 1, 0).ico(STROBE, 0.02, -0.9, 0.48, 0, 1, 1, 1, 0);
        M.muzzle = [0.14, 0.135]; M.mz2 = 0.25; M.exhaust = [[-0.3, 0.3, 0.115], [-0.3, 0.3, -0.115]];
      } else {      // Syndikat: wuchtiger Kampfhubschrauber mit Doppelkuppel, Stummelflügeln (Anhedral) und 4 Raketenbehältern
        b.prism(P.body, [[-0.38, 0.1], [0.3, 0.07], [0.48, 0.12], [0.5, 0.18], [0.4, 0.24], [0.0, 0.34], [-0.38, 0.33]], 0.24, 0, 0, 0);
        b.dome(P.glass, 0.08, 0.38, 0.2, 0, 1.25, 0.9, 1, 8).dome(P.glass, 0.085, 0.22, 0.26, 0, 1.35, 1.0, 1.05, 8);
        b.box(P.body2, 0.46, 0.1, 0.22, -0.1, 0.33, 0);
        b.cylX(P.dark, 0.046, 0.046, 0.08, 8, 0.16, 0.38, 0.07).cylX(P.dark, 0.046, 0.046, 0.08, 8, 0.16, 0.38, -0.07);
        b.prism(P.body2, [[-0.98, 0.26], [-0.36, 0.2], [-0.36, 0.33], [-0.95, 0.31]], 0.09, 0, 0, 0);
        b.prism(P.body2, [[-1.03, 0.26], [-0.92, 0.28], [-0.95, 0.5], [-1.03, 0.51]], 0.035, 0, 0, 0).pbox(T.team, 0.08, 0.05, 0.04, -0.99, 0.45, 0);
        for (k = -1; k <= 1; k += 2) {
          b.box(P.body2, 0.16, 0.025, 0.3, -0.02, 0.17, k * 0.26, 0, k * 0.22);
          b.cylX(P.dark, 0.04, 0.04, 0.18, 8, 0.0, 0.11, k * 0.25).cylX(P.dark, 0.04, 0.04, 0.18, 8, 0.0, 0.08, k * 0.37);
          if (hi) b.cylX(P.rust, 0.042, 0.042, 0.02, 8, 0.09, 0.11, k * 0.25).cylX(P.rust, 0.042, 0.042, 0.02, 8, 0.09, 0.08, k * 0.37);
        }
        b.sph(P.dark, 0.038, 0.44, 0.09, 0, 1, 1, 1, 6).cylX(P.dark, 0.012, 0.012, 0.12, 4, 0.52, 0.085, 0);
        b.pbox(T.team, 0.5, 0.04, 0.244, -0.08, 0.24, 0).pbox(T.team, 0.12, 0.05, 0.094, -0.68, 0.24, 0).pbox(T.team, 0.3, 0.008, 0.14, -0.1, 0.43, 0);
        if (hi) { rivets(b, P.metal, -0.3, 0.2, 0.18, 0.122, 5); rivets(b, P.metal, -0.3, 0.2, 0.18, -0.122, 5); b.cylX(P.rust, 0.03, 0.04, 0.08, 6, -0.32, 0.38, 0.08).cylX(P.rust, 0.03, 0.04, 0.08, 6, -0.32, 0.38, -0.08); }
        b.cylZ(P.track, 0.04, 0.03, 8, 0.3, 0.04, 0).cylZ(P.track, 0.042, 0.032, 8, -0.15, 0.042, 0.15).cylZ(P.track, 0.042, 0.032, 8, -0.15, 0.042, -0.15);
        M.xparts.rotor = rotorGeo(0.56, 5, 0.05, P.dark, P.metal, lo); M.xparts.trot = trotGeo(0.11, P.dark, P.metal);
        M.xp.push({ p: 'rotor', x: -0.04, y: 0.46, z: 0, k: 'rotor', d: 1 }, { p: 'trot', x: -0.98, y: 0.44, z: 0.04, k: 'trot', d: 1 });
        M.rotors = [[-0.04, 0.47, 0, 0.56]];
        g.ico(NAVL, 0.018, -0.02, 0.17, -0.41, 1, 1, 1, 0).ico(NAVR, 0.018, -0.02, 0.17, 0.41, 1, 1, 1, 0).ico(STROBE, 0.02, -0.99, 0.52, 0, 1, 1, 1, 0);
        M.muzzle = [0.12, 0.1]; M.mz2 = 0.31; M.exhaust = [[-0.36, 0.38, 0.08], [-0.36, 0.38, -0.08]];
      }
    } else if (type === 'bomber') {
      M.air = 1; M.h = 0.5; M.fixed = 1;
      M.xparts.bmb = bombGeo(syn ? '#4a4c3a' : '#3c4248', syn ? P.rust : P.dark);
      if (!syn) {   // Koalition: Schwenkflügel-Strahlbomber, vier Triebwerke in zwei Gondeln, hohes Seitenleitwerk
        b.prism(P.body, [[-0.74, 0.12], [0.5, 0.1], [0.8, 0.15], [0.68, 0.21], [0.42, 0.25], [-0.6, 0.25], [-0.76, 0.21]], 0.2, 0, 0, 0);
        b.prism(P.glass, [[0.4, 0.23], [0.62, 0.2], [0.52, 0.265], [0.4, 0.272]], 0.13, 0, 0, 0, 0, 0.005);
        wing(b, P.body2, [[0.26, -0.1], [0.26, 0.1], [-0.1, 0.66], [-0.26, 0.66], [-0.22, 0.1], [-0.22, -0.1], [-0.26, -0.66], [-0.1, -0.66]], 0.03, 0.15);
        wing(b, T.team, [[-0.05, 0.58], [-0.1, 0.665], [-0.26, 0.665], [-0.255, 0.58]], 0.034, 0.148);
        wing(b, T.team, [[-0.05, -0.58], [-0.255, -0.58], [-0.26, -0.665], [-0.1, -0.665]], 0.034, 0.148);
        for (k = -1; k <= 1; k += 2) for (i = 0; i < 2; i++) {
          zz = k * (0.25 + i * 0.15); a = 0.0 - i * 0.08;
          b.cylX(P.dark, 0.05, 0.044, 0.32, 8, a, 0.1, zz).cylX(P.metal, 0.052, 0.052, 0.02, 8, a + 0.16, 0.1, zz);
          if (hi) b.pbox(P.body2, 0.12, 0.03, 0.02, a + 0.02, 0.13, zz);
        }
        b.prism(P.body, [[-0.76, 0.23], [-0.5, 0.25], [-0.66, 0.52], [-0.77, 0.52]], 0.035, 0, 0, 0).pbox(T.team, 0.12, 0.06, 0.04, -0.715, 0.46, 0);
        wing(b, P.body2, symZ([[-0.56, 0.05], [-0.69, 0.3], [-0.78, 0.3], [-0.75, 0.05]]), 0.02, 0.21);
        b.pbox(T.team, 0.7, 0.012, 0.12, -0.1, 0.25, 0).pbox(T.team, 0.5, 0.035, 0.204, 0.0, 0.17, 0);
        if (hi) { b.top(P.dark, 0.1, -0.06, -0.45, -0.06, 0.2505, 0.008).top(P.dark, 0.1, 0.06, -0.45, 0.06, 0.2505, 0.008); b.cyl(P.metal, 0.005, 0.008, 0.08, 4, 0.2, 0.25, 0); }
        b.cylZ(P.track, 0.035, 0.03, 8, 0.5, 0.035, 0).cylZ(P.track, 0.045, 0.06, 8, -0.12, 0.045, 0.1).cylZ(P.track, 0.045, 0.06, 8, -0.12, 0.045, -0.1);
        for (i = 0; i < 6; i++) M.xp.push({ p: 'bmb', x: 0.16 - (i % 3) * 0.16, y: 0.075, z: (i < 3 ? -1 : 1) * 0.16, k: 'bomb', i: i });
        g.ico(NAVL, 0.02, -0.26, 0.17, -0.67, 1, 1, 1, 0).ico(NAVR, 0.02, -0.26, 0.17, 0.67, 1, 1, 1, 0).ico(STROBE, 0.02, -0.72, 0.53, 0, 1, 1, 1, 0);
        g.pbox('#ffb46a', 0.012, 0.06, 0.06, -0.165, 0.1, 0.25).pbox('#ffb46a', 0.012, 0.06, 0.06, -0.165, 0.1, -0.25).pbox('#ffb46a', 0.012, 0.06, 0.06, -0.245, 0.1, 0.4).pbox('#ffb46a', 0.012, 0.06, 0.06, -0.245, 0.1, -0.4);
        M.exhaust = [[-0.17, 0.1, 0.25], [-0.17, 0.1, -0.25], [-0.25, 0.1, 0.4], [-0.25, 0.1, -0.4]];
      } else {      // Syndikat: schwerer Propellerbomber, Glasnase, vier Motoren, doppeltes Seitenleitwerk
        b.cylX(P.body, 0.115, 0.1, 1.16, 10, -0.06, 0.21, 0);
        b.add(new THREE.SphereGeometry(0.115, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2), P.glass, 0.52, 0.21, 0, 0, 0, -Math.PI / 2);
        b.add(new THREE.ConeGeometry(0.1, 0.24, 10), P.body, -0.76, 0.22, 0, 0, 0, Math.PI / 2);
        b.prism(P.glass, [[0.26, 0.3], [0.42, 0.29], [0.38, 0.34], [0.28, 0.345]], 0.12, 0, 0, 0, 0, 0.005);
        wing(b, P.body2, [[0.2, -0.1], [0.2, 0.1], [0.08, 0.74], [-0.07, 0.74], [-0.13, 0.1], [-0.13, -0.1], [-0.07, -0.74], [0.08, -0.74]], 0.032, 0.18);
        wing(b, T.team, [[0.095, 0.66], [0.08, 0.745], [-0.07, 0.745], [-0.085, 0.66]], 0.036, 0.178);
        wing(b, T.team, [[0.095, -0.66], [-0.085, -0.66], [-0.07, -0.745], [0.08, -0.745]], 0.036, 0.178);
        M.xparts.prop = propGeo(0.14, P.dark, P.metal);
        for (k = -1; k <= 1; k += 2) for (i = 0; i < 2; i++) {
          zz = k * (0.27 + i * 0.2); a = 0.06 - i * 0.03;
          b.cylX(P.body2, 0.048, 0.04, 0.3, 8, a, 0.17, zz).cylX(P.rust, 0.05, 0.05, 0.03, 8, a + 0.13, 0.17, zz);
          M.xp.push({ p: 'prop', x: a + 0.17, y: 0.17, z: zz, k: 'prop', d: k });
        }
        for (k = -1; k <= 1; k += 2) b.prism(P.body, [[-0.84, 0.2], [-0.68, 0.22], [-0.78, 0.44], [-0.87, 0.44]], 0.025, 0, 0, k * 0.2).pbox(T.team, 0.08, 0.05, 0.03, -0.83, 0.39, k * 0.2);
        wing(b, P.body2, symZ([[-0.62, 0.05], [-0.66, 0.24], [-0.82, 0.24], [-0.82, 0.05]]), 0.02, 0.24);
        b.cylX(T.team, 0.118, 0.118, 0.07, 10, -0.42, 0.21, 0).cylX(T.team, 0.118, 0.118, 0.07, 10, 0.3, 0.21, 0);
        if (hi) { b.cylB(P.glass, 0.04, 0.03, 8, -0.2, 0.32, 0, 0.008); b.cylX(P.rust, 0.103, 0.103, 0.2, 10, -0.6, 0.21, 0); b.cylX(P.dark, 0.007, 0.007, 0.12, 4, -0.9, 0.24, 0); }
        b.cylZ(P.track, 0.045, 0.06, 8, -0.02, 0.045, 0.27).cylZ(P.track, 0.045, 0.06, 8, -0.02, 0.045, -0.27).cylZ(P.track, 0.03, 0.03, 6, -0.68, 0.06, 0);
        for (i = 0; i < 6; i++) M.xp.push({ p: 'bmb', x: 0.14 - (i % 3) * 0.15, y: 0.105, z: (i < 3 ? -1 : 1) * 0.155, k: 'bomb', i: i });
        g.ico(NAVL, 0.02, -0.07, 0.2, -0.75, 1, 1, 1, 0).ico(NAVR, 0.02, -0.07, 0.2, 0.75, 1, 1, 1, 0).ico(STROBE, 0.02, -0.86, 0.45, 0.2, 1, 1, 1, 0);
        M.exhaust = [[-0.1, 0.17, 0.27], [-0.1, 0.17, -0.27], [-0.13, 0.17, 0.47], [-0.13, 0.17, -0.47]];
      }
    } else if (type === 'gunboat') {
      M.naval = 1; M.h = 0.42; M.recoil = 0.05;
      if (!syn) {   // Koalition: schnelles Kanonenboot, scharfer Bug, Brückenhaus mittschiffs, Geschütz vorn
        loftHull(b, HULL, DECK, [[-0.5, 0.15, 0.1, -0.05], [-0.2, 0.17, 0.1, -0.08], [0.15, 0.165, 0.11, -0.08], [0.38, 0.1, 0.135, -0.06], [0.54, 0.004, 0.16, 0.0]], T.team, 0.12, 0.42);
        b.box(P.body, 0.32, 0.13, 0.2, -0.12, 0.1, 0).prism(P.body, [[-0.1, 0.23], [0.06, 0.23], [0.02, 0.32], [-0.1, 0.32]], 0.17, -0.06, 0, 0, 0, 0.01);
        b.pbox(P.glass, 0.012, 0.045, 0.15, 0.0, 0.26, 0, 0, 0, 0.4).pbox(T.team, 0.12, 0.012, 0.172, -0.1, 0.32, 0);
        b.cyl(P.metal, 0.01, 0.014, 0.24, 4, -0.18, 0.32, 0).pbox(P.metal, 0.012, 0.012, 0.16, -0.18, 0.5, 0).box(P.dark, 0.06, 0.03, 0.06, -0.18, 0.56, 0);
        b.box(P.body2, 0.1, 0.06, 0.12, -0.36, 0.1, 0).cylX(P.dark, 0.008, 0.008, 0.12, 4, -0.43, 0.18, 0.03);
        if (hi) { winS(b, null, P, -0.24, 0.0, 0.17, 0.1, 4, 0.04, 0.035, 0, 1); b.cylZ('#e8743a', 0.025, 0.08, 8, -0.3, 0.13, 0.15).cylZ('#e8743a', 0.025, 0.08, 8, -0.3, 0.13, -0.15); b.pbox(P.dark, 0.06, 0.015, 0.29, 0.42, 0.13, 0); }
      } else {      // Syndikat: breiteres Patrouillenboot, kantiges Steuerhaus, offene Geschützlafette, Zwillings-MG achtern
        loftHull(b, HULL, DECK, [[-0.48, 0.16, 0.09, -0.05], [0.1, 0.175, 0.1, -0.08], [0.36, 0.12, 0.125, -0.06], [0.52, 0.01, 0.15, -0.01]], T.team, 0.1, 0.36);
        b.box(P.body, 0.26, 0.15, 0.22, -0.1, 0.09, 0).box(P.rust, 0.28, 0.03, 0.24, -0.1, 0.24, 0).pbox(P.glass, 0.012, 0.04, 0.18, 0.031, 0.18, 0);
        b.pbox(T.team, 0.18, 0.01, 0.16, -0.12, 0.27, 0).cyl(P.rust, 0.01, 0.014, 0.2, 4, -0.16, 0.27, 0.06).pbox(P.metal, 0.1, 0.012, 0.012, -0.16, 0.42, 0.06);
        b.cylB(P.dark, 0.05, 0.05, 8, -0.36, 0.09, 0, 0.01).cylX(P.dark, 0.008, 0.008, 0.14, 4, -0.44, 0.17, 0.025).cylX(P.dark, 0.008, 0.008, 0.14, 4, -0.44, 0.17, -0.025).box(P.rust, 0.04, 0.06, 0.1, -0.38, 0.14, 0);
        if (hi) { rivets(b, P.metal, -0.2, 0.0, 0.17, 0.112, 4); rivets(b, P.metal, -0.2, 0.0, 0.17, -0.112, 4); b.box(P.dark, 0.08, 0.05, 0.08, 0.15, 0.11, 0.08).box(P.rust, 0.08, 0.05, 0.08, 0.15, 0.11, -0.08); }
      }
      var tg = navTurret(t, r, P, T, 0, 1, false, syn, 0.11);
      M.pivot = [0.25, 0]; M.muzzle = tg.muzzle;
      g.ico(NAVL, 0.016, -0.06, 0.15, -0.14, 1, 1, 1, 0).ico(NAVR, 0.016, -0.06, 0.15, 0.14, 1, 1, 1, 0).ico(STROBE, 0.016, -0.18, syn ? 0.44 : 0.6, syn ? 0.06 : 0, 1, 1, 1, 0);
      M.exhaust = [[-0.5, 0.06, 0.06], [-0.5, 0.06, -0.06]]; M.wake = [0.5, -0.5, 0.16];
    } else if (type === 'destroyer') {
      M.naval = 1; M.h = 0.8; M.recoil = 0.06;
      var aa = new MB(), ab = new MB(), t2 = new MB(), r2 = new MB(), rd = new MB();
      if (!syn) {   // Koalition: schlanker Zerstörer, geschlossener Brückenaufbau, Gittermast mit Radar, ein Schornstein, Flak auf dem Hangar
        loftHull(b, HULL, DECK, [[-0.86, 0.17, 0.12, -0.06], [-0.5, 0.215, 0.12, -0.1], [0.1, 0.22, 0.125, -0.1], [0.5, 0.15, 0.15, -0.08], [0.8, 0.05, 0.18, -0.04], [0.92, 0.004, 0.19, 0.0]], T.team, 0.1, 0.3);
        b.box(P.body, 0.52, 0.16, 0.28, 0.06, 0.12, 0).box(P.body, 0.24, 0.13, 0.22, 0.17, 0.28, 0).prism(P.body, [[0.04, 0.41], [0.3, 0.41], [0.26, 0.47], [0.06, 0.47]], 0.2, 0, 0, 0, 0, 0.01);
        b.pbox(P.glass, 0.012, 0.04, 0.2, 0.29, 0.36, 0, 0, 0, 0.35).pbox(T.team, 0.2, 0.012, 0.2, 0.15, 0.47, 0);
        b.cyl(P.metal, 0.012, 0.03, 0.36, 6, 0.05, 0.47, 0).pbox(P.metal, 0.012, 0.012, 0.3, 0.05, 0.7, 0).pbox(P.metal, 0.012, 0.012, 0.2, 0.05, 0.6, 0);
        b.prism(P.body2, [[-0.15, 0.28], [0.03, 0.28], [0.0, 0.48], [-0.13, 0.48]], 0.13, -0.12, 0, 0, 0, 0.01).box(P.dark, 0.11, 0.02, 0.1, -0.19, 0.48, 0).pbox(T.team, 0.15, 0.04, 0.134, -0.19, 0.41, 0);
        b.box(P.body, 0.28, 0.13, 0.26, -0.38, 0.12, 0).pbox(T.team, 0.24, 0.006, 0.2, -0.38, 0.25, 0);
        b.cylB(P.body2, 0.06, 0.04, 8, 0.48, 0.12, 0, 0.01);
        if (hi) {
          winS(b, null, P, 0.08, 0.26, 0.33, 0.111, 4, 0.03, 0.03, 0, 2); winS(b, null, P, 0.08, 0.26, 0.33, -0.111, 4, 0.03, 0.03, 0, 3, -1);
          b.cylZ('#e8743a', 0.03, 0.1, 8, -0.05, 0.16, 0.16).cylZ('#e8743a', 0.03, 0.1, 8, -0.05, 0.16, -0.16);
          b.box(P.dark, 0.1, 0.03, 0.1, -0.74, 0.12, 0.06).box(P.dark, 0.1, 0.03, 0.1, -0.74, 0.12, -0.06).cyl(P.metal, 0.006, 0.008, 0.18, 4, -0.8, 0.12, 0).pbox(T.team, 0.08, 0.05, 0.008, -0.76, 0.24, 0);
          b.box(P.dark, 0.08, 0.06, 0.14, 0.32, 0.12, 0);
        }
        rd.pbox(P.dark, 0.03, 0.04, 0.03, 0, 0, 0).pbox(P.metal, 0.03, 0.05, 0.22, 0, 0.03, 0);
        M.xparts.rdr = rd.geo(false); M.xp.push({ p: 'rdr', x: 0.05, y: 0.71, z: 0, k: 'spin' });
        M.exhaust = [[-0.19, 0.5, 0]];
      } else {      // Syndikat: älterer Zerstörer, offene Brücke, zwei Schornsteine mit Rostkragen, Flak hinter den Schornsteinen
        loftHull(b, HULL, DECK, [[-0.86, 0.16, 0.11, -0.05], [-0.4, 0.215, 0.11, -0.1], [0.2, 0.22, 0.12, -0.1], [0.55, 0.14, 0.14, -0.08], [0.82, 0.05, 0.17, -0.04], [0.92, 0.006, 0.18, 0.0]], T.team, 0.1, 0.32);
        b.box(P.body, 0.36, 0.15, 0.26, 0.15, 0.11, 0).box(P.body2, 0.2, 0.12, 0.22, 0.22, 0.26, 0).box(P.rust, 0.22, 0.025, 0.24, 0.22, 0.38, 0);
        b.pbox(P.glass, 0.012, 0.04, 0.18, 0.321, 0.31, 0).pbox(T.team, 0.16, 0.01, 0.18, 0.2, 0.405, 0);
        b.cyl(P.rust, 0.012, 0.022, 0.34, 6, 0.12, 0.38, 0).pbox(P.metal, 0.012, 0.012, 0.26, 0.12, 0.62, 0);
        for (i = 0; i < 2; i++) { var fx8 = -0.06 - i * 0.18; b.cyl(P.body2, 0.052, 0.058, 0.2, 8, fx8, 0.25, 0).cyl(P.rust, 0.06, 0.06, 0.05, 8, fx8, 0.44, 0); }
        b.box(P.body, 0.5, 0.14, 0.24, -0.1, 0.11, 0).pbox(T.team, 0.12, 0.03, 0.118, -0.06, 0.38, 0);
        b.box(P.body, 0.18, 0.14, 0.22, -0.42, 0.11, 0);
        if (hi) {
          rivets(b, P.metal, -0.3, 0.1, 0.17, 0.122, 6); rivets(b, P.metal, -0.3, 0.1, 0.17, -0.122, 6);
          b.cylZ(P.body2, 0.03, 0.12, 8, 0.0, 0.18, 0.14).cylZ(P.body2, 0.03, 0.12, 8, 0.0, 0.18, -0.14);
          b.box(P.rust, 0.08, 0.04, 0.12, -0.76, 0.11, 0).cyl(P.metal, 0.006, 0.008, 0.18, 4, -0.82, 0.11, 0).pbox(T.team, 0.08, 0.05, 0.008, -0.78, 0.24, 0);
        }
        rd.pbox(P.dark, 0.03, 0.04, 0.03, 0, 0, 0).pbox(P.rust, 0.02, 0.04, 0.16, 0, 0.03, 0);
        M.xparts.rdr = rd.geo(false); M.xp.push({ p: 'rdr', x: 0.12, y: 0.63, z: 0, k: 'spin' });
        M.exhaust = [[-0.06, 0.49, 0], [-0.24, 0.49, 0]];
      }
      var t1 = navTurret(t, r, P, T, 0, 1, true, syn, 0.13);
      M.pivot = [0.48, 0]; M.muzzle = t1.muzzle;
      var rx8 = syn ? -0.62 : -0.62;
      navTurret(t2, r2, P, T, rx8, -1, true, syn, 0.12);
      M.parts.turB = t2.geo(); M.parts.barB = r2.geo(); M.piv2 = [rx8, 0]; M.muzzle2 = t1.muzzle;
      // Flak-Lafette (Ruhe: Rohre waagerecht nach vorn), Drehpunkt aaP, Schildzapfen aaTr
      var ax = syn ? -0.38 : -0.38, ay = syn ? 0.25 : 0.25;
      aa.cylB(P.body2, 0.055, 0.04, 8, ax, ay, 0, 0.008).box(P.body, 0.07, 0.08, 0.025, ax, ay + 0.03, 0.05).box(P.body, 0.07, 0.08, 0.025, ax, ay + 0.03, -0.05).pbox(T.team, 0.05, 0.01, 0.12, ax - 0.03, ay + 0.04, 0);
      ab.box(P.dark, 0.08, 0.05, 0.07, ax + 0.01, ay + 0.065, 0).cylX(P.dark, 0.008, 0.008, 0.16, 4, ax + 0.11, ay + 0.09, 0.022).cylX(P.dark, 0.008, 0.008, 0.16, 4, ax + 0.11, ay + 0.09, -0.022);
      M.parts.aaT = aa.geo(); M.parts.aaB = ab.geo(); M.aaP = [ax, 0]; M.aaTr = [ax, ay + 0.09]; M.aaL = 0.2;
      g.ico(NAVL, 0.018, 0.18, 0.3, -0.12, 1, 1, 1, 0).ico(NAVR, 0.018, 0.18, 0.3, 0.12, 1, 1, 1, 0).ico(STROBE, 0.02, syn ? 0.12 : 0.05, syn ? 0.73 : 0.84, 0, 1, 1, 1, 0);
      M.wake = [0.92, -0.86, 0.2];
    } else {        // lander
      M.naval = 1; M.h = 0.5;
      var rp = new MB();
      if (!syn) {   // Koalition: Landungsboot mit offenem Laderaum, Steuerhaus achtern, Bugklappe
        loftHull(b, HULL2, '#4f5a50', [[-0.58, 0.25, 0.11, -0.04], [-0.3, 0.27, 0.11, -0.06], [0.42, 0.27, 0.11, -0.06], [0.54, 0.25, 0.11, -0.03]], T.team, 0.05, 0.4);
        b.box(P.body2, 0.9, 0.12, 0.04, 0.03, 0.11, 0.25).box(P.body2, 0.9, 0.12, 0.04, 0.03, 0.11, -0.25).pbox(T.team, 0.9, 0.02, 0.044, 0.03, 0.2, 0.25).pbox(T.team, 0.9, 0.02, 0.044, 0.03, 0.2, -0.25);
        b.box(P.body, 0.2, 0.22, 0.34, -0.46, 0.11, 0).box(P.body, 0.14, 0.1, 0.22, -0.48, 0.33, 0).pbox(P.glass, 0.012, 0.04, 0.2, -0.409, 0.37, 0).pbox(T.team, 0.12, 0.012, 0.2, -0.48, 0.43, 0);
        b.cyl(P.metal, 0.008, 0.012, 0.18, 4, -0.5, 0.43, 0).pbox(P.metal, 0.012, 0.012, 0.12, -0.5, 0.57, 0);
        if (hi) { for (i = 0; i < 4; i++) b.top(P.dark, -0.3 + i * 0.2, -0.22, -0.3 + i * 0.2, 0.22, 0.1215, 0.012); b.cylZ('#e8743a', 0.025, 0.08, 8, -0.4, 0.15, 0.2).box(P.dark, 0.06, 0.04, 0.06, -0.38, 0.33, 0.1); }
        rp.box(HULL2, 0.035, 0.24, 0.48, -0.0175, 0, 0).pbox(T.team, 0.04, 0.03, 0.48, -0.02, 0.2, 0);
        if (hi) for (i = 0; i < 4; i++) rp.pbox(P.dark, 0.03, 0.2, 0.02, 0.006, 0.02, -0.18 + i * 0.12);
      } else {      // Syndikat: rostiges Landungsschiff, versetztes Steuerhaus, MG-Stand
        loftHull(b, HULL2, '#4c4a3d', [[-0.58, 0.26, 0.11, -0.04], [-0.2, 0.28, 0.11, -0.06], [0.42, 0.28, 0.11, -0.06], [0.54, 0.26, 0.11, -0.03]], P.rust, 0.05, 0.35);
        b.box(P.body2, 0.9, 0.13, 0.04, 0.03, 0.11, 0.26).box(P.body2, 0.9, 0.13, 0.04, 0.03, 0.11, -0.26).pbox(T.team, 0.5, 0.025, 0.044, 0.1, 0.2, 0.26).pbox(T.team, 0.5, 0.025, 0.044, 0.1, 0.2, -0.26);
        b.box(P.body, 0.22, 0.2, 0.2, -0.46, 0.11, 0.1).box(P.rust, 0.24, 0.025, 0.22, -0.46, 0.31, 0.1).pbox(P.glass, 0.012, 0.04, 0.16, -0.349, 0.25, 0.1).pbox(T.team, 0.14, 0.01, 0.16, -0.47, 0.335, 0.1);
        b.cylB(P.dark, 0.04, 0.05, 8, -0.46, 0.11, -0.14, 0.01).cylX(P.dark, 0.008, 0.008, 0.14, 4, -0.4, 0.19, -0.14).cyl(P.rust, 0.008, 0.012, 0.16, 4, -0.5, 0.335, 0.1);
        if (hi) { rivets(b, P.metal, -0.3, 0.4, 0.17, 0.282, 7); rivets(b, P.metal, -0.3, 0.4, 0.17, -0.282, 7); b.box(P.rust, 0.08, 0.05, 0.08, -0.25, 0.11, 0.1); }
        rp.box(HULL2, 0.035, 0.25, 0.5, -0.0175, 0, 0).pbox(P.rust, 0.04, 0.04, 0.5, -0.02, 0.2, 0).pbox(T.team, 0.04, 0.02, 0.5, -0.02, 0.12, 0);
        if (hi) for (i = 0; i < 5; i++) rp.pbox(P.dark, 0.03, 0.2, 0.02, 0.006, 0.02, -0.2 + i * 0.1);
      }
      M.xparts.ramp = rp.geo(); M.xp.push({ p: 'ramp', x: 0.55, y: 0.07, z: 0, k: 'ramp' }); M.ramp = 1;
      g.ico(NAVL, 0.016, -0.4, 0.2, -0.26, 1, 1, 1, 0).ico(NAVR, 0.016, -0.4, 0.2, 0.26, 1, 1, 1, 0).ico(STROBE, 0.018, -0.5, syn ? 0.5 : 0.6, syn ? 0.1 : 0, 1, 1, 1, 0);
      M.exhaust = [[-0.6, 0.05, 0.12], [-0.6, 0.05, -0.12]]; M.wake = [0.55, -0.58, 0.26];
    }
    M.parts.hull = b.geo();
    if (t.list.length) M.parts.turret = t.geo();
    if (r.list.length) M.parts.barrel = r.geo();
    if (g.list.length) M.parts.glow = g.geo(false);
    M.v8u = M.air ? 'air' : 'naval';
    return M;
  }

  /** v0.8-Gebäude: Flugfeld (4 Landeplätze bei padPos, Tower mit Radar, Hangar), Werft (Kaje auf Pfählen, Helling, Portalkran),
   *  Flak-Stellung (Kopf dreht mit tdir, Rohre erhöhen sich um M.trun). Gebaut für die ALTE Diagonale – mirrorModel spiegelt an x. */
  function buildBldV8(type, fac, color, M, P, T, syn, hi, b, g, hd, br, bd) {
    var w = bd.w, h = bd.h, i, k, x, z;
    if (type === 'airfield') {
      M.h = 1.05; M.lit = true;
      slab(b, P, w, h, T);
      b.box('#4a4f55', w - 0.3, 0.012, 1.95, 0, 0.06, 0.45);                                                          // Vorfeld
      for (i = 0; i < 4; i++) {
        x = -w / 2 + (i + 0.5) * w / 4; z = h * 0.55 - h / 2;
        b.cyl('#62686f', 0.44, 0.44, 0.02, 14, x, 0.06, z);
        b.add(new THREE.RingGeometry(0.36, 0.41, 14), i % 2 ? '#e8eaec' : '#e9d36a', x, 0.082, z, 0, -Math.PI / 2);
        b.top('#f2f3f4', x - 0.1, z - 0.15, x - 0.1, z + 0.15, 0.0825, 0.045).top('#f2f3f4', x + 0.1, z - 0.15, x + 0.1, z + 0.15, 0.0825, 0.045).top('#f2f3f4', x - 0.1, z, x + 0.1, z, 0.0825, 0.045);
        for (k = 0; k < 4; k++) g.pbox('#a6f0ff', 0.03, 0.02, 0.03, x + (k & 1 ? 0.33 : -0.33), 0.075, z + (k & 2 ? 0.28 : -0.28));
      }
      b.top('#e6b81c', -w / 2 + 0.2, 0.86, w / 2 - 0.2, 0.86, 0.0735, 0.035).pbox(T.team, w - 0.4, 0.012, 0.07, 0, 0.066, h / 2 - 0.13);
      for (i = 0; i < 7; i++) g.pbox('#ffd27a', 0.035, 0.03, 0.035, -1.65 + i * 0.55, 0.06, 1.28);
      // Hangar (Bogendach), Tor nach Süden
      b.box(P.body2, 1.7, 0.36, 0.86, 0.92, 0.06, -1.0).add(new THREE.CylinderGeometry(0.43, 0.43, 1.72, hi ? 12 : 8, 1, false, 0, Math.PI), P.roof, 0.92, 0.42, -1.0, 0, 0, Math.PI / 2);
      b.box(P.dark, 1.24, 0.3, 0.02, 0.92, 0.06, -0.565).pbox(T.team, 1.72, 0.05, 0.02, 0.92, 0.38, -0.565);
      for (i = 0; i < 5; i++) b.pbox('#3a3f45', 0.012, 0.3, 0.022, 0.42 + i * 0.25, 0.06, -0.562);
      // Tower mit Radar
      b.box(P.body, 0.5, 0.3, 0.5, -1.55, 0.06, -1.05).box(P.body2, 0.22, 0.52, 0.22, -1.55, 0.36, -1.05);
      b.cyl(P.glass, 0.22, 0.19, 0.12, 8, -1.55, 0.88, -1.05).cylB(syn ? P.body2 : P.body, 0.24, 0.05, 8, -1.55, 0.84, -1.05, 0.01).cylB(T.team, 0.235, 0.035, 8, -1.55, 1.0, -1.05, 0.008);
      beacon(g, '#ff5a3a', -1.55, 1.2, -1.05, 0.03);
      br.pbox(P.dark, 0.05, 0.06, 0.05, 0, 0, 0).pbox(P.metal, 0.06, 0.07, 0.34, 0.01, 0.05, 0).pbox(P.dark, 0.02, 0.05, 0.3, -0.02, 0.06, 0);
      M.parts.radar = br.geo(); M.radarAt = [-1.55, 1.035, -1.05];
      // Tanklager, Windsack, Kleinteile
      b.cylX(P.metal, 0.12, 0.12, 0.42, 10, -0.75, 0.19, -1.2).cylX(P.metal, 0.12, 0.12, 0.42, 10, -0.75, 0.19, -0.88).pbox(T.team, 0.44, 0.03, 0.01, -0.75, 0.2, -0.755);
      b.box(P.dark, 0.52, 0.06, 0.6, -0.75, 0.06, -1.04);
      b.cyl(P.metal, 0.012, 0.012, 0.42, 4, 1.85, 0.06, 1.3).add(new THREE.ConeGeometry(0.04, 0.17, 8, 1, true), '#f97316', 1.77, 0.44, 1.3, 0, 0, Math.PI / 2);
      if (hi) {
        acUnit(b, P, -1.55, 0.36, -0.8, 0.14); winS(b, null, P, -1.7, -1.4, 0.2, -0.795, 3, 0.06, 0.06, 0, 4);
        for (i = 0; i < 3; i++) b.box(i === 1 ? T.teamD : P.body2, 0.18, 0.12, 0.14, 1.85 - i * 0.22, 0.06, 0.62);
        b.box(P.dark, 0.3, 0.1, 0.16, 1.3, 0.06, -0.44).cylZ(P.track, 0.03, 0.03, 6, 1.2, 0.09, -0.36).cylZ(P.track, 0.03, 0.03, 6, 1.4, 0.09, -0.36);
        if (syn) rivets(b, P.metal, 0.2, 1.65, 0.3, -0.545, 8); else { solar(b, P, 0.6, 0.85, -1.05, 0.4, 0.3); solar(b, P, 1.2, 0.85, -1.05, 0.4, 0.3); }
      }
    } else if (type === 'shipyard') {
      M.h = 1.25; M.lit = true;
      for (k = -1; k <= 1; k += 2) {                                                                                      // Kaje (Pfähle bis unter Wasser)
        for (i = 0; i < 4; i++) for (var j = 0; j < 2; j++) b.cyl(P.conc, 0.05, 0.06, 0.5, 6, k * (0.6 + j * 0.8), -0.45, -1.3 + i * 0.86);
        b.box(P.conc, 1.02, 0.12, 3.0, k * 1.0, -0.02, 0).box('#85888a', 1.04, 0.03, 3.02, k * 1.0, 0.07, 0);
        b.pbox(T.team, 0.05, 0.014, 2.4, k * 0.52, 0.1, 0.3);
        for (i = 0; i < 4; i++) b.cylB('#2e3238', 0.03, 0.05, 6, k * 0.56, 0.1, -0.4 + i * 0.55, 0.006);
      }
      b.box(P.conc, 1.0, 0.12, 0.62, 0, -0.02, -1.19).box('#85888a', 1.0, 0.03, 0.64, 0, 0.07, -1.19);
      b.box('#55595d', 0.98, 0.03, 2.42, 0, -0.03, 0.3);                                                                   // Trockendock-Sohle
      for (i = 0; i < 5; i++) b.pbox('#3a3d40', 0.12, 0.04, 0.08, 0, 0.0, -0.3 + i * 0.32);                                 // Kielpallen
      b.pbox(P.rust, 0.05, 0.04, 1.4, 0, 0.04, 0.25);                                                                      // Kiel des Neubaus
      for (i = 0; i < (hi ? 7 : 4); i++) { z = -0.35 + i * (hi ? 0.2 : 0.4); b.pbox(P.rust, 0.03, 0.2, 0.03, 0.15, 0.04, z).pbox(P.rust, 0.03, 0.2, 0.03, -0.15, 0.04, z).pbox(P.rust, 0.3, 0.025, 0.03, 0, 0.22, z); }
      b.box(P.body2, 0.28, 0.14, 0.3, 0, 0.0, -0.62).pbox(T.team, 0.3, 0.02, 0.32, 0, 0.13, -0.62);
      // Werkhalle (hinten, wird nach Osten gespiegelt) mit Teamdach, Tor nach Süden
      b.box(syn ? P.body : P.body2, 0.92, 0.52, 1.0, -1.0, 0.1, -0.92).prism(T.team, [[-0.5, 0.62], [0.5, 0.62], [0.5, 0.7], [-0.5, 0.82]], 1.0, -1.0, 0, -0.92, Math.PI / 2, 0.01);
      b.box(P.dark, 0.5, 0.36, 0.02, -1.0, 0.1, -0.415).pbox('#fbbf24', 0.54, 0.04, 0.024, -1.0, 0.46, -0.415);
      winE(b, g, P, -1.3, -0.6, 0.4, -0.535, 3, 0.1, 0.08, 0.5, 8, 1);
      // Kleinteile auf der östlichen Kaje (wird West = vorn): Container, Kisten, Laternen
      for (i = 0; i < 3; i++) b.box(['#2f6f8f', '#b4532a', '#557a3a'][i], 0.36, 0.17, 0.17, 1.05, 0.1 + (i === 2 ? 0.17 : 0), 0.4 + (i === 2 ? 0.05 : i * 0.2));
      b.box(P.body2, 0.14, 0.12, 0.14, 1.3, 0.1, -0.7).box(T.teamD, 0.14, 0.12, 0.14, 1.3, 0.1, -0.5);
      for (i = 0; i < 2; i++) { b.cyl(P.metal, 0.012, 0.014, 0.5, 4, 1.45, 0.1, -1.2 + i * 2.4); g.pbox('#ffe2a0', 0.06, 0.03, 0.06, 1.45, 0.6, -1.2 + i * 2.4); }
      if (hi) {
        b.cyl(P.rust, 0.04, 0.05, 0.6, 6, -1.35, 0.1, 1.2).box(P.dark, 0.12, 0.08, 0.12, -1.35, 0.7, 1.2);
        roofFan(b, P, -1.2, 0.75, -0.95, 0.08); roofFan(b, P, -0.8, 0.75, -0.95, 0.08);
        hazardX(b, -1.45, -0.55, 1.45, 0.1, 0.05); hazardX(b, 0.55, 1.45, 1.45, 0.1, 0.05);
      }
      // Portalkran über der Helling (fährt entlang z, Laufkatze entlang x) – Ruhestellung bei z = 0.25
      var gc = new MB(), gk = new MB(), CR = '#e0a526';
      gc.surf('metal');
      for (k = -1; k <= 1; k += 2) for (i = -1; i <= 1; i += 2) gc.box(CR, 0.06, 0.95, 0.06, k * 0.66, 0.1, 0.25 + i * 0.16);
      for (i = -1; i <= 1; i += 2) gc.box(CR, 1.46, 0.08, 0.07, 0, 1.0, 0.25 + i * 0.16);
      gc.pbox(T.team, 1.46, 0.03, 0.072, 0, 1.08, 0.09).pbox(T.team, 1.46, 0.03, 0.072, 0, 1.08, 0.41).surf(null);
      gc.box(P.dark, 0.14, 0.06, 0.16, -0.66, 0.1, 0.25).box(P.dark, 0.14, 0.06, 0.16, 0.66, 0.1, 0.25);
      gk.box(P.body2, 0.18, 0.1, 0.38, 0, 0.98, 0.25).cyl(P.dark, 0.006, 0.006, 0.6, 4, 0, 0.38, 0.25).box('#c2410c', 0.06, 0.05, 0.06, 0, 0.33, 0.25);
      M.parts.gantry = gc.geo(); M.parts.trolley = gk.geo();
    } else {        // flak
      M.h = 0.62;
      b.cylB(P.conc, 0.44, 0.12, 8, 0, 0.0, 0, 0.02).cylB('#85888a', 0.36, 0.02, 8, 0, 0.12, 0, 0.004);
      for (i = 0; i < 10; i++) { var a8 = i / 10 * Math.PI * 2 + 0.3; b.pbox(i % 2 ? '#b3a27c' : '#a39272', 0.15, 0.08, 0.09, Math.cos(a8) * 0.39, 0.12, Math.sin(a8) * 0.39, -a8 + Math.PI / 2); }
      b.cylB(T.team, 0.3, 0.025, 10, 0, 0.14, 0, 0.006);
      if (hi) { b.box(P.body2, 0.1, 0.08, 0.14, 0.27, 0.12, 0.27, 0.6).box(T.teamD, 0.1, 0.08, 0.14, -0.27, 0.12, 0.27, -0.5).box(P.body2, 0.12, 0.06, 0.1, 0.0, 0.12, -0.33); }
      hd.cylB(P.body2, 0.2, 0.06, 10, 0, 0.16, 0, 0.012).box(P.body, 0.14, 0.18, 0.04, 0, 0.21, 0.1).box(P.body, 0.14, 0.18, 0.04, 0, 0.21, -0.1);
      hd.box(P.body, 0.04, 0.14, 0.3, 0.13, 0.2, 0).pbox(T.team, 0.045, 0.025, 0.3, 0.13, 0.34, 0).pbox(P.dark, 0.08, 0.04, 0.08, -0.12, 0.24, 0.0).pbox(P.glass, 0.02, 0.03, 0.04, -0.07, 0.29, 0.13);
      var tr = 0.34;
      br.box(P.dark, 0.16, 0.08, 0.13, 0.0, tr - 0.04, 0);
      if (!syn) { br.cylX(P.dark, 0.016, 0.014, 0.46, 6, 0.26, tr, 0.04).cylX(P.dark, 0.016, 0.014, 0.46, 6, 0.26, tr, -0.04).cylX(P.metal, 0.022, 0.022, 0.05, 6, 0.47, tr, 0.04).cylX(P.metal, 0.022, 0.022, 0.05, 6, 0.47, tr, -0.04); }
      else for (i = 0; i < 4; i++) br.cylX(P.dark, 0.013, 0.012, 0.38, 6, 0.22, tr + (i < 2 ? 0.025 : -0.025), (i & 1 ? 1 : -1) * 0.035);
      br.box(P.body2, 0.08, 0.1, 0.03, -0.04, tr - 0.07, 0.085).box(P.body2, 0.08, 0.1, 0.03, -0.04, tr - 0.07, -0.085);
      M.parts.head = hd.geo(); M.parts.barrel = br.geo(); M.trun = [0, tr]; M.recoil = 0.04; M.flakL = syn ? 0.42 : 0.5;
      M.muzzle = [Math.cos(0.9) * M.flakL, tr + Math.sin(0.9) * M.flakL];
    }
  }

  // ------------------------------------------------------------------ v0.8: Zeichnen/Animation Luft & See (je Frame, ohne Allokation)
  // Basis b9 = [Fx,Fy,Fz, Ux,Uy,Uz, Zx,Zy,Zz] = lokale x/y/z-Achse in Weltkoordinaten (Batch.putM).
  var B8 = [1, 0, 0, 0, 1, 0, 0, 0, 1], B8b = [1, 0, 0, 0, 1, 0, 0, 0, 1], B8c = [1, 0, 0, 0, 1, 0, 0, 0, 1], B8d = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  var P8 = [0, 0, 0];
  /** Gieren (Sim-Winkel), Nicken (Nase hoch +), Rollen (+ = Querachse +z nach unten, d. h. in eine Kurve mit wachsendem Winkel). */
  function basis(o, yaw, pit, roll) {
    var ca = Math.cos(yaw), sa = Math.sin(yaw), cp = Math.cos(pit), sp = Math.sin(pit), cr = Math.cos(roll), sr = Math.sin(roll);
    var Ux = -sp * ca, Uy = cp, Uz = -sp * sa, Zx = -sa, Zz = ca;
    o[0] = cp * ca; o[1] = sp; o[2] = cp * sa;
    o[3] = Ux * cr + Zx * sr; o[4] = Uy * cr; o[5] = Uz * cr + Zz * sr;
    o[6] = Zx * cr - Ux * sr; o[7] = -Uy * sr; o[8] = Zz * cr - Uz * sr;
    return o;
  }
  /** Drehung um die lokale y-Achse (Gieren relativ): Ergebnis-Gierwinkel = Gieren − phi. */
  function spinY(o, s9, phi) {
    var c = Math.cos(phi), s = Math.sin(phi), k, F, Z;
    for (k = 0; k < 3; k++) { F = s9[k]; Z = s9[6 + k]; o[k] = F * c - Z * s; o[3 + k] = s9[3 + k]; o[6 + k] = F * s + Z * c; }
    return o;
  }
  /** Drehung um die lokale x-Achse (Propeller). */
  function spinX(o, s9, phi) {
    var c = Math.cos(phi), s = Math.sin(phi), k, U, Z;
    for (k = 0; k < 3; k++) { U = s9[3 + k]; Z = s9[6 + k]; o[k] = s9[k]; o[3 + k] = U * c + Z * s; o[6 + k] = -U * s + Z * c; }
    return o;
  }
  /** Drehung um die lokale z-Achse (Erhöhung: + = Vorderende hoch; Heckrotor). */
  function spinZ(o, s9, phi) {
    var c = Math.cos(phi), s = Math.sin(phi), k, F, U;
    for (k = 0; k < 3; k++) { F = s9[k]; U = s9[3 + k]; o[k] = F * c + U * s; o[3 + k] = -F * s + U * c; o[6 + k] = s9[6 + k]; }
    return o;
  }
  /** Lokaler Punkt (lx, ly, lz) × s mit Basis b9 → P8 (Versatz, ohne Position). */
  function lv(b9, lx, ly, lz, s) { P8[0] = (b9[0] * lx + b9[3] * ly + b9[6] * lz) * s; P8[1] = (b9[1] * lx + b9[4] * ly + b9[7] * lz) * s; P8[2] = (b9[2] * lx + b9[5] * ly + b9[8] * lz) * s; return P8; }
  /** Batch-Instanz mit beliebiger Basis (gleichmäßige Skalierung s). */
  Batch.prototype.putM = function (x, y, z, b9, s, r, g, b) {
    if (this.n >= this.cap) this.make(this.cap * 2);
    var i = this.n++, e = this.mesh.instanceMatrix.array, o = i * 16;
    e[o] = b9[0] * s; e[o + 1] = b9[1] * s; e[o + 2] = b9[2] * s; e[o + 3] = 0;
    e[o + 4] = b9[3] * s; e[o + 5] = b9[4] * s; e[o + 6] = b9[5] * s; e[o + 7] = 0;
    e[o + 8] = b9[6] * s; e[o + 9] = b9[7] * s; e[o + 10] = b9[8] * s; e[o + 11] = 0;
    e[o + 12] = x; e[o + 13] = y; e[o + 14] = z; e[o + 15] = 1;
    var ca = this.mesh.instanceColor.array; ca[i * 3] = r; ca[i * 3 + 1] = g; ca[i * 3 + 2] = b;
  };
  /** Bewegung: wie putM, mit ungleichmäßiger Skalierung je lokaler Achse (Ladung des Sammlers auf geneigter Wanne). */
  Batch.prototype.putMS = function (x, y, z, b9, sx, sy, sz, r, g, b) {
    if (this.n >= this.cap) this.make(this.cap * 2);
    var i = this.n++, e = this.mesh.instanceMatrix.array, o = i * 16;
    e[o] = b9[0] * sx; e[o + 1] = b9[1] * sx; e[o + 2] = b9[2] * sx; e[o + 3] = 0;
    e[o + 4] = b9[3] * sy; e[o + 5] = b9[4] * sy; e[o + 6] = b9[5] * sy; e[o + 7] = 0;
    e[o + 8] = b9[6] * sz; e[o + 9] = b9[7] * sz; e[o + 10] = b9[8] * sz; e[o + 11] = 0;
    e[o + 12] = x; e[o + 13] = y; e[o + 14] = z; e[o + 15] = 1;
    var ca = this.mesh.instanceColor.array; ca[i * 3] = r; ca[i * 3 + 1] = g; ca[i * 3 + 2] = b;
  };
  /** Teil mit eigenem Drehpunkt q (Rumpfkoordinaten, in Ruhestellung gebaut) und Endbasis bf; Rumpf (x, y, z, bh, s). */
  function putPiv(bt, x, y, z, bh, bf, qx, qy, qz, s, cr, cg, cb) {
    var ax = (bh[0] - bf[0]) * qx + (bh[3] - bf[3]) * qy + (bh[6] - bf[6]) * qz, ay = (bh[1] - bf[1]) * qx + (bh[4] - bf[4]) * qy + (bh[7] - bf[7]) * qz, az = (bh[2] - bf[2]) * qx + (bh[5] - bf[5]) * qy + (bh[8] - bf[8]) * qz;
    bt.putM(x + ax * s, y + ay * s, z + az * s, bf, s, cr, cg, cb);
  }
  /** … zweistufig (Gieren um q, dann Erhöhung um q2): Ursprung = P + s·(Bh·q + Ba·(q2 − q) − Bb·q2). */
  function putPiv2(bt, x, y, z, bh, ba, bb, qx, qz, q2x, q2y, s, rcl, cr, cg, cb) {
    var dx = q2x - qx, dz = -qz;
    var ox = bh[0] * qx + bh[6] * qz + ba[0] * dx + ba[3] * q2y + ba[6] * dz - bb[0] * q2x - bb[3] * q2y;
    var oy = bh[1] * qx + bh[7] * qz + ba[1] * dx + ba[4] * q2y + ba[7] * dz - bb[1] * q2x - bb[4] * q2y;
    var oz = bh[2] * qx + bh[8] * qz + ba[2] * dx + ba[5] * q2y + ba[8] * dz - bb[2] * q2x - bb[5] * q2y;
    bt.putM(x + (ox - bb[0] * rcl) * s, y + (oy - bb[1] * rcl) * s, z + (oz - bb[2] * rcl) * s, bb, s, cr, cg, cb);
  }
  var v8discMat = null;
  /** Rotor-Unschärfe: flache Ringscheibe (additiv, innen schwächer), eine Instanz je Rotor. */
  function discBatch() {
    if (!v8discMat) v8discMat = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, blending: THREE.AdditiveBlending });
    return batch('v8disc', function () {
      var g = new THREE.RingGeometry(0.1, 1, 24, 2), p = g.attributes.position, c = new Float32Array(p.count * 3), i, rr;
      g.rotateX(-Math.PI / 2);
      for (i = 0; i < p.count; i++) { rr = Math.sqrt(p.getX(i) * p.getX(i) + p.getZ(i) * p.getZ(i)); c[i * 3] = c[i * 3 + 1] = c[i * 3 + 2] = rr > 0.97 ? 0.15 : 0.25 + 0.75 * rr; }
      g.setAttribute('color', new THREE.BufferAttribute(c, 3)); g.deleteAttribute('uv'); g.deleteAttribute('normal');
      return g;
    }, v8discMat, 16, false);
  }
  function isWaterAt(x, z) { return R3T0() && G.R3T.heightAt(x, z) < -0.09; }
  function R3T0() { return !!(G.R3T && G.R3T.heightAt); }

  /** Luftfahrzeug / Schiff zeichnen (statt des allgemeinen Einheiten-Pfads). r = Render-Zustand (rs). */
  function drawV8U(e, M, r, x, z, s, dt, tick, alpha, sel, inV) {
    var own = e.owner, type = e.type, t = R.t, i, xe, bt, F3 = G.R3F, gy = groundAt(x, z), a = e.alt || 0, y, al, k, q;
    if (r.alt == null) { r.alt = a; r.ax = x; r.az = z; r.vx = 0; r.vz = 0; r.turn = 0; r.pdir = r.dir; r.rpm = a > 0 ? 1 : 0; r.rot = r.ph; r.dw = 0; r.wk = 0; r.ramp = 0; r.rampT = -1e9; r.aaY = r.dir; r.aaE = 0.15; r.aaT0 = -1e9; r.aaDir = r.dir; r.tdB = r.dir + Math.PI; r.mzA = 0; }
    var idt = dt > 1e-4 ? 1 / dt : 0, kv = Math.min(1, dt * 5), mx = x - r.ax, mz = z - r.az;
    if (mx * mx + mz * mz > 1) { r.vx = 0; r.vz = 0; } else { r.vx += (mx * idt - r.vx) * kv; r.vz += (mz * idt - r.vz) * kv; }
    r.ax = x; r.az = z;
    var dd = r.dir - r.pdir; while (dd > Math.PI) dd -= 2 * Math.PI; while (dd < -Math.PI) dd += 2 * Math.PI;
    if (dt > 1e-4) r.turn += (dd * idt - r.turn) * Math.min(1, dt * 4);
    r.pdir = r.dir;
    var spd = Math.sqrt(r.vx * r.vx + r.vz * r.vz), hfu = e.hp / e.maxHp;
    if (M.air) {
      r.alt += (a - r.alt) * Math.min(1, dt * 7); al = r.alt;
      y = gy + al * D.AIR_H + (al > 0.5 ? Math.sin(t * 2.6 + r.ph) * 0.03 * al : 0);
      var bank = clamp(r.turn * (M.fixed ? 0.3 : 0.22), -0.6, 0.6) * Math.min(1, al * 1.6);
      var pit = M.fixed ? clamp((a - r.alt) * 3, -0.15, 0.22) : -clamp(spd / 3.4, 0, 1) * 0.17 * Math.min(1, al * 2);
      basis(B8, r.dir, pit, bank);
      var spinT = (a > 0 || e.moving) ? 1 : 0;
      r.rpm += (spinT - r.rpm) * Math.min(1, dt * (spinT ? 1.8 : 0.4));
      r.rot += dt * (3 + 19 * r.rpm) * r.rpm;
      partBatch('u', type, own, 'hull', M).putM(x, y, z, B8, s, 1, 1, 1);
      if (M.parts.glow) { var gl = M.pulse ? 1.0 + 0.55 * Math.sin(t * 3.2 + r.ph) + (tick - e.fireT < 8 ? 1.4 : 0) : (((t * 1.1 + r.ph) % 1) < 0.07 ? 2.6 : 0.85); partBatch('u', type, own, 'glow', M).putM(x, y, z, B8, s, gl, gl, gl); }   // v1.2 Kollektiv-Flieger: pulsierender Kern
      for (i = 0; i < M.xp.length; i++) {
        xe = M.xp[i];
        if (xe.k === 'bomb' && e.ammo != null && xe.i >= e.ammo) continue;
        lv(B8, xe.x, xe.y, xe.z, s);
        var Bx = B8;
        if (xe.k === 'rotor') Bx = spinY(B8b, B8, r.rot * (xe.d || 1));
        else if (xe.k === 'trot') Bx = spinZ(B8b, B8, r.rot * 2.3);
        else if (xe.k === 'prop') Bx = spinX(B8b, B8, r.rot * 1.7 * (xe.d || 1));
        else if (xe.k === 'kspin') Bx = spinY(B8b, B8, t * 0.9 * (xe.d || 1) + r.ph);   // v1.2 Psi-Drohne: Ring kreist langsam
        partBatch('u', type, own, xe.p, M).putM(x + P8[0], y + P8[1], z + P8[2], Bx, s, 1, 1, 1);
      }
      if (M.rotors && r.rpm > 0.3) {
        var dk = 0.16 * (r.rpm - 0.3) / 0.7, db = discBatch();
        for (i = 0; i < M.rotors.length; i++) { var ro = M.rotors[i]; lv(B8, ro[0], ro[1] + 0.012, ro[2], s); db.putM(x + P8[0], y + P8[1], z + P8[2], B8, ro[3] * s, dk, dk, dk * 1.05); }
      }
      if (sel) R.selRing.put(x, gy + 0.03, z, 0, e.r / TILE * 1.25 + 0.06, 1, e.r / TILE * 1.25 + 0.06, 0.6, 1, 0.6);
      if (!inV) return;
      if (!M.fixed && r.rpm > 0.55 && al < 0.85 && (r.dw += dt) > 0.11) {   // Abwind: Staub bzw. Gischt am Boden
        r.dw = 0; k = (1 - al) * r.rpm;
        var wat = isWaterAt(x, z);
        for (q = 0; q < 2; q++) {
          var da = rnd() * 6.283, rr = 0.3 + rnd() * 0.4, cx = Math.cos(da), cz = Math.sin(da);
          if (wat) F3.puff(x + cx * rr, WL8 + 0.04, z + cz * rr, cx * 1.6, 0.25, cz * 1.6, 0.8, 0.12, 0.55, 0.9, 0.42 * k, 0);
          else F3.puff(x + cx * rr, gy + 0.04, z + cz * rr, cx * 1.5, 0.2, cz * 1.5, 0.9, 0.14, 0.6, 0.55, 0.38 * k, 0);
        }
      }
      if (M.exhaust && al > 0.2 && rnd() < dt * (M.fixed ? 9 : 4) * (R.safeGPU ? 0.5 : 1)) {   // Abgas/Kondensstreifen
        var ex = M.exhaust[(rnd() * M.exhaust.length) | 0]; lv(B8, ex[0], ex[1], ex[2], s);
        emit(1, x + P8[0], y + P8[1], z + P8[2], -Math.cos(r.dir) * 0.3, 0.05, -Math.sin(r.dir) * 0.3, M.fixed ? 1.1 : 0.6, 0.05, M.fixed ? 0.28 : 0.18, 0.75, 0.75, 0.76, M.fixed ? 0.45 : 0.3, 0.82, 0.82, 0.84, 0, 0, 0.6);
      }
      if (hfu < 0.4 && rnd() < dt * 9) emit(1, x, y + M.h * 0.6 * s, z, -Math.cos(r.dir) * 0.4, 0.4, -Math.sin(r.dir) * 0.4, 1.4, 0.1, 0.45, 0.12, 0.12, 0.12, 0.7, 0.3, 0.3, 0.3, 0, 0, 0.4);
      if (hfu < 0.2 && rnd() < dt * 9) emit(0, x, y + M.h * 0.5 * s, z, 0, 0.4, 0, 0.3, 0.2, 0.06, 1, 0.6, 0.2, 1, 0.9, 0.2, 0.05, 0);
      return;
    }
    // ---- Schiff: Wasserlinie, Seegang, Krängung in Kurven, Bug hebt sich mit der Fahrt
    y = WL8 + Math.sin(t * 1.9 + r.ph) * 0.012;
    if (M.sub) {   // v1.2 U-Boot: getaucht (eigenes, unentdecktes) → nur der Turm ragt heraus; aufgedeckt/nach dem Schuss → aufgetaucht
      var dv = (e.clk && G.Sim.cloakState(V.pid, e) === 1 && !(e.revT > tick) && !e.revM) ? 1 : 0;
      r.dv = r.dv == null ? dv : r.dv + (dv - r.dv) * Math.min(1, dt * 1.3);
      y -= r.dv * M.sub * s;
    }
    var heel = clamp(r.turn * spd * 0.06, -0.12, 0.12), roll = Math.sin(t * 1.2 + r.ph) * 0.022 + heel;
    var pit8 = Math.sin(t * 1.5 + r.ph * 1.7) * 0.012 + clamp(spd * 0.014, 0, 0.045);
    basis(B8, r.dir, pit8, roll);
    partBatch('u', type, own, 'hull', M).putM(x, y, z, B8, s, 1, 1, 1);
    if (M.parts.glow) { var gn = (((t * 0.9 + r.ph) % 1) < 0.07 ? 2.4 : 0.85); partBatch('u', type, own, 'glow', M).putM(x, y, z, B8, s, gn, gn, gn); }
    if (M.dread) dreadParts(e, M, r, x, y, z, s, dt, own, type, 1);   // v0.9 Schlachtschiff: Werfer, Schienen (setup), Raketen
    else if (M.parts.turret) {
      var Bt = spinY(B8b, B8, r.dir - r.tdir), rc0;
      if (M.piv2) { var ra0 = t - (r.b0 || -1e9); rc0 = ra0 < 0.35 ? M.recoil * (1 - ra0 / 0.35) : 0; }
      else { var fa = tick - e.fireT + alpha; rc0 = fa < 6 ? M.recoil * (1 - fa / 6) : 0; }
      lv(B8, M.pivot[0], 0, M.pivot[1], s);
      partBatch('u', type, own, 'turret', M).putM(x + P8[0], y + P8[1], z + P8[2], Bt, s, 1, 1, 1);
      if (M.parts.barrel) partBatch('u', type, own, 'barrel', M).putM(x + P8[0] - Bt[0] * rc0 * s, y + P8[1] - Bt[1] * rc0 * s, z + P8[2] - Bt[2] * rc0 * s, Bt, s, 1, 1, 1);
    }
    if (M.parts.turB) {   // Heckturm: folgt tdir, solange das Ziel achteraus liegt (Schwenkbereich ±125°), sonst Ruhe nach achtern
      var aft = r.dir + Math.PI, dB = r.tdir - aft; while (dB > Math.PI) dB -= 2 * Math.PI; while (dB < -Math.PI) dB += 2 * Math.PI;
      r.tdB = lerpAng(r.tdB, Math.abs(dB) < 2.2 ? r.tdir : aft, Math.min(1, dt * 3));
      var B2 = spinY(B8c, B8, aft - r.tdB), ra1 = t - (r.b1 || -1e9), rc1 = ra1 < 0.35 ? M.recoil * (1 - ra1 / 0.35) : 0;
      putPiv(partBatch('u', type, own, 'turB', M), x, y, z, B8, B2, M.piv2[0], 0, M.piv2[1], s, 1, 1, 1);
      putPiv(partBatch('u', type, own, 'barB', M), x + B2[0] * rc1 * s, y + B2[1] * rc1 * s, z + B2[2] * rc1 * s, B8, B2, M.piv2[0], 0, M.piv2[1], s, 1, 1, 1);
    }
    if (M.parts.aaT) {    // Flak-Lafette: dreht/erhöht sich zum letzten Luftziel (Ereignis shot.aux), sonst Ruhe
      var hot = t - r.aaT0 < 2.4;
      r.aaY = lerpAng(r.aaY, hot ? r.aaDir : r.dir, Math.min(1, dt * 6));
      r.aaE += ((hot ? 0.85 : 0.12) - r.aaE) * Math.min(1, dt * 4);
      var Ba = spinY(B8b, B8, r.dir - r.aaY), Bb = spinZ(B8d, Ba, r.aaE), ar = t - r.aaT0 < 0.12 ? 0.02 : 0;
      putPiv(partBatch('u', type, own, 'aaT', M), x, y, z, B8, Ba, M.aaP[0], 0, M.aaP[1], s, 1, 1, 1);
      putPiv2(partBatch('u', type, own, 'aaB', M), x, y, z, B8, Ba, Bb, M.aaP[0], M.aaP[1], M.aaTr[0], M.aaTr[1], s, ar, 1, 1, 1);
    }
    if (M.ramp) {   // Bugklappe: offen nach 'beach'/'load'/'unload' (r.rampT, aus R3F) für 3 s
      r.ramp += ((t - r.rampT < 3 ? 1 : 0) - r.ramp) * Math.min(1, dt * 2.2);
    }
    if (M.hgS) hangarDraw(e, M, type, own, x, y, z, B8, s, tick, 1);   // v1.2 Flugzeugträger: Jäger an Deck
    for (i = 0; i < M.xp.length; i++) {
      xe = M.xp[i]; lv(B8, xe.x, xe.y, xe.z, s);
      var Bq = B8;
      if (xe.k === 'spin') Bq = spinY(B8c, B8, t * 2.4);
      else if (xe.k === 'ramp') Bq = spinZ(B8c, B8, RAMP_OPEN * smooth(r.ramp));
      partBatch('u', type, own, xe.p, M).putM(x + P8[0], y + P8[1], z + P8[2], Bq, s, 1, 1, 1);
    }
    if (sel) R.selRing.put(x, y + 0.03, z, 0, e.r / TILE * 1.25 + 0.06, 1, e.r / TILE * 1.25 + 0.06, 0.6, 1, 0.6);
    if (!inV) return;
    var cd = Math.cos(r.dir), sd = Math.sin(r.dir);
    if (M.sub && r.dv > 0.5) { if (spd > 0.15 && rnd() < dt * 6) F3.puff(x - cd * 0.45 * s, WL8 + 0.02, z - sd * 0.45 * s, (rnd() - 0.5) * 0.2, 0.15, (rnd() - 0.5) * 0.2, 0.5, 0.05, 0.22, 0.85, 0.5, 0); }   // getaucht: nur Blasen
    else if (M.wake && spd > 0.15 && (r.wk += dt) > 0.07) {   // Bugwelle + Heckschaum (R3F.wake: flache Schaumflecken auf dem Wasser + Gischt)
      r.wk = 0; k = clamp(spd / 2.5, 0.3, 1.2);
      F3.wake(x + cd * M.wake[0] * s, z + sd * M.wake[0] * s, r.dir, 1, M.wake[2] * s, k);
      F3.wake(x + cd * M.wake[1] * s, z + sd * M.wake[1] * s, r.dir, 0, M.wake[2] * s, k);
    }
    if (M.exhaust && rnd() < dt * (e.moving ? 6 : 1.5) * (R.safeGPU ? 0.5 : 1)) {   // Schornstein-/Motorabgas
      var ex2 = M.exhaust[(rnd() * M.exhaust.length) | 0];
      emit(1, x + (cd * ex2[0] - sd * ex2[2]) * s, y + ex2[1] * s, z + (sd * ex2[0] + cd * ex2[2]) * s, -cd * 0.15, 0.35, -sd * 0.15, 1.0 + rnd() * 0.5, 0.05, 0.26, 0.28, 0.28, 0.29, 0.5, 0.45, 0.45, 0.46, 0, -0.1, 0.5);
    }
    if (hfu < 0.4 && rnd() < dt * 7) emit(1, x, y + M.h * 0.5 * s, z, 0.1, 0.5, 0.03, 1.6, 0.12, 0.5, 0.12, 0.12, 0.12, 0.7, 0.3, 0.3, 0.3, 0, 0, 0.4);
    if (hfu < 0.2 && rnd() < dt * 8) emit(0, x, y + M.h * 0.4 * s, z, 0, 0.5, 0, 0.3, 0.2, 0.06, 1, 0.6, 0.2, 1, 0.9, 0.2, 0.05, 0);
  }

  /** v0.8-Gebäude: Werft (Portalkran fährt, Laufkatze, Schweißfunken), Flak (Kopf dreht, Rohre erhöhen sich beim Feuern). */
  function drawBldV8(b, M, owner, x, z, tdir, sy, cr, cg, cb) {
    var t = R.t, mem = cr === GREY, st = nst(b.id), low = !mem && G.Sim.lowPower(owner);
    if (M.v8b === 'shipyard') {
      var sp = mem ? 0 : (low ? 0.2 : (st.actOn ? 1 : 0.12));   // GA: Kran fährt nur bei laufender Produktion zügig
      st.gz = (st.gz || 0) + fdt * sp; var off = Math.sin(st.gz * 0.22 + st.ph) * 0.55, tro = Math.sin(st.gz * 0.5 + st.ph * 1.3) * 0.42;
      partBatch('b', b.type, owner, 'gantry', M).put(x, 0, z + off * sy, 0, 1, sy, 1, cr, cg, cb);
      partBatch('b', b.type, owner, 'trolley', M).put(x + tro, 0, z + off * sy, 0, 1, sy, 1, cr, cg, cb);
      if (!mem && !low && st.actOn && inV5 && sy >= 1 && rnd() < fdt * 3.5) {   // Schweißfunken am Neubau (GA: nur bei Produktion)
        var wx = x + (rnd() - 0.5) * 0.3, wz = z + 0.25 + (rnd() - 0.5) * 1.1;
        for (var q = 0; q < 4; q++) emit(0, wx, 0.22, wz, (rnd() - 0.5) * 0.9, 0.5 + rnd() * 0.8, (rnd() - 0.5) * 0.9, 0.3, 0.07, 0.02, 0.8, 0.9, 1, 1, 1, 0.6, 0.2, 0, -5);
      }
    } else if (M.v8b === 'flak') {
      var tk = G.Sim.S.tick, rec = !mem && b.fireT != null && tk - b.fireT < 50;
      st.el = st.el == null ? 0.35 : st.el + ((rec ? 0.9 : 0.35) - st.el) * Math.min(1, fdt * 3);
      partBatch('b', b.type, owner, 'head', M).put(x, 0, z, tdir, 1, sy, 1, cr, cg, cb);
      var bt = partBatch('b', b.type, owner, 'barrel', M);
      if (sy < 0.999) { bt.put(x, 0, z, tdir, 1, sy, 1, cr, cg, cb); return; }
      var rc = (b.fireT != null && tk - b.fireT < 3) ? M.recoil * (1 - (tk - b.fireT) / 3) : 0;
      basis(B8, tdir, 0, 0); spinZ(B8b, B8, st.el);
      putPiv2(bt, x, 0, z, B8, B8, B8b, 0, 0, M.trun[0], M.trun[1], 1, rc, cr, cg, cb);
    }
  }

  // ------------------------------------------------------------------ v0.9 Schlachtschiff (dreadnought, SPEC_v08 §14)
  // Rumpf ≈ 2 Kacheln (Vorwärts = +x), Aufbauten mittschiffs, Raketenwerfer vorn: turret = Drehkranz + Lafette (dreht mit tdir um M.pivot),
  // barrel = Startschienen (Ursprung = Schildzapfen M.trun im Turm-Koordinatensystem, Erhöhung M.EL·setup), mslA/mslB = Raketen auf den Schienen
  // (sichtbar solange geladen, mslA startet zuerst). Zeichnen: drawV8U (Schiffspfad) + dreadParts; Untergang/Wrack wie die übrigen Schiffe.
  var V9M = { dreadnought: 1 };
  var DREAD_EL = 0.78;                       // Schienen-Erhöhung bei setup = 1 (rad)
  function buildV9(type, fac, color) {
    var P = PAL[fac], T = teamCols(color), syn = fac === 'syndicate', hi = HI(), i, k;
    var b = new MB(), g = new MB(), t = new MB(), r = new MB(), mA = new MB(), mB = new MB(), rd = new MB();
    var M = { parts: {}, xparts: {}, xp: [], pivot: [0.44, 0], recoil: 0.02, muzzle: [0.3, 0.5], h: 0.95, lo: !hi, naval: 1, dread: 1, EL: DREAD_EL };
    var HULL = syn ? '#66705a' : '#8a96a1', DECK = syn ? '#57543f' : '#5d6870', DY = 0.14, trx, tryy, ml, mz;
    if (!syn) {   // Koalition: moderner Raketen-Kreuzer/Schlachtschiff – glatter Rumpf, Brückenturm mit Schrägfenstern, Gittermast, integrierter Schornstein, Hubschrauberdeck
      loftHull(b, HULL, DECK, [[-1.0, 0.2, 0.13, -0.06], [-0.7, 0.25, 0.13, -0.11], [0.1, 0.26, 0.135, -0.12], [0.55, 0.2, 0.16, -0.1], [0.86, 0.09, 0.2, -0.06], [1.06, 0.004, 0.235, 0.0]], T.team, 0.1, 0.28);
      b.box(P.body, 0.66, 0.15, 0.34, -0.14, 0.13, 0);                                                                   // Deckshaus
      b.prism(P.body, [[-0.2, 0.28], [0.2, 0.28], [0.14, 0.42], [-0.2, 0.42]], 0.28, 0, 0, 0, 0, 0.012);                    // Brückenblock (Schrägfront)
      b.prism(P.body2, [[-0.12, 0.42], [0.12, 0.42], [0.08, 0.5], [-0.12, 0.5]], 0.24, 0, 0, 0, 0, 0.01);                 // Brücke
      b.pbox(P.glass, 0.012, 0.035, 0.22, 0.105, 0.455, 0, 0, 0, 0.45).pbox(T.team, 0.2, 0.012, 0.22, -0.02, 0.5, 0);      // Brückenfenster, Dachstreifen
      b.prism(P.body2, [[-0.46, 0.28], [-0.26, 0.28], [-0.29, 0.48], [-0.44, 0.48]], 0.18, 0, 0, 0, 0, 0.01).box(P.dark, 0.13, 0.02, 0.13, -0.365, 0.48, 0);   // Schornstein
      b.pbox(T.team, 0.17, 0.05, 0.186, -0.36, 0.38, 0);
      b.cyl(P.metal, 0.012, 0.03, 0.34, 6, -0.08, 0.5, 0).pbox(P.metal, 0.012, 0.012, 0.3, -0.08, 0.72, 0).pbox(P.metal, 0.012, 0.012, 0.2, -0.08, 0.62, 0);   // Gittermast
      b.box(P.body, 0.22, 0.09, 0.3, -0.6, 0.13, 0);                                                                       // Hangar
      b.cyl(P.dark, 0.15, 0.15, 0.006, 12, -0.84, 0.13, 0);                                                                // Landedeck
      b.pbox('#e8e8e2', 0.12, 0.008, 0.018, -0.84, 0.136, 0).pbox('#e8e8e2', 0.018, 0.008, 0.1, -0.88, 0.136, 0).pbox('#e8e8e2', 0.018, 0.008, 0.1, -0.8, 0.136, 0);   // „H“
      b.prism(P.body2, [[0.76, 0.18], [0.84, 0.21], [0.84, 0.23], [0.74, 0.23]], 0.2, 0, 0, 0, 0, 0.006);   // Wellenbrecher
      if (hi) {
        winS(b, null, P, -0.4, 0.1, 0.22, 0.171, 5, 0.035, 0.03, 0, 4); winS(b, null, P, -0.4, 0.1, 0.22, -0.171, 5, 0.035, 0.03, 0, 5, -1);
        for (i = 0; i < 2; i++) for (k = 0; k < 3; k++) b.top(P.dark, 0.615 + i * 0.065, -0.07 + k * 0.07, 0.665 + i * 0.065, -0.07 + k * 0.07, 0.172 + i * 0.006, 0.05);   // VLS-Deckel vor dem Werfer
        b.dome(P.metal, 0.045, -0.47, 0.28, 0.12).dome(P.metal, 0.045, -0.47, 0.28, -0.12).cyl(P.body2, 0.04, 0.045, 0.03, 8, 0.13, 0.42, 0);   // Nahbereichsabwehr
        b.cylZ('#e8743a', 0.03, 0.1, 8, -0.3, 0.2, 0.19).cylZ('#e8743a', 0.03, 0.1, 8, -0.3, 0.2, -0.19);             // Rettungsinseln
        b.cyl(P.metal, 0.005, 0.007, 0.16, 4, -1.0, 0.13, 0).pbox(T.team, 0.08, 0.05, 0.006, -0.96, 0.24, 0);            // Heckflagge
      }
      rd.pbox(P.dark, 0.03, 0.04, 0.03, 0, 0, 0).pbox(P.metal, 0.03, 0.06, 0.26, 0, 0.03, 0);
      M.xparts.rdr = rd.geo(false); M.xp.push({ p: 'rdr', x: -0.08, y: 0.85, z: 0, k: 'spin' });
      M.exhaust = [[-0.365, 0.5, 0]];
      // Werfer: Drehkranz + Lafette mit zwei Wangen
      t.cylB(P.body2, 0.15, 0.05, 12, 0, DY, 0, 0.012).box(P.body, 0.26, 0.08, 0.26, -0.03, DY + 0.05, 0);
      t.pbox(P.body, 0.12, 0.13, 0.025, -0.06, DY + 0.1, 0.13).pbox(P.body, 0.12, 0.13, 0.025, -0.06, DY + 0.1, -0.13).pbox(T.team, 0.2, 0.01, 0.2, -0.04, DY + 0.13, 0);
      if (hi) t.cylZ(P.metal, 0.03, 0.3, 8, -0.06, DY + 0.19, 0);
      trx = -0.06; tryy = DY + 0.19;
      // Startschienen (Ursprung = Schildzapfen): Rahmen + zwei Schienen + Strebe
      r.box(P.body2, 0.5, 0.035, 0.2, 0.18, -0.03, 0).pbox(P.dark, 0.56, 0.022, 0.03, 0.2, 0.005, 0.07).pbox(P.dark, 0.56, 0.022, 0.03, 0.2, 0.005, -0.07);
      r.pbox(P.metal, 0.03, 0.05, 0.22, -0.04, -0.03, 0).pbox(T.team, 0.12, 0.008, 0.204, 0.3, 0.006, 0);
      ml = function (mb, z) {
        mb.cylX('#e6e8ea', 0.032, 0.032, 0.38, 8, 0.2, 0.06, z).add(new THREE.ConeGeometry(0.032, 0.1, 8), '#2b3138', 0.44, 0.06, z, 0, 0, -Math.PI / 2);
        mb.pbox('#c0392b', 0.025, 0.066, 0.006, 0.03, 0.03, z).pbox('#c0392b', 0.025, 0.006, 0.066, 0.03, 0.057, z).pbox(T.team, 0.04, 0.012, 0.066, 0.3, 0.054, z);
      };
      mz = 0.49;
    } else {      // Syndikat: altes, schweres Schlachtschiff – breiter Rumpf, Pagodenturm, zwei Schornsteine mit Rostkragen, Nieten, gepanzerter Kastenwerfer, Heckgeschütz
      loftHull(b, HULL, DECK, [[-1.0, 0.23, 0.12, -0.06], [-0.6, 0.28, 0.12, -0.12], [0.15, 0.285, 0.125, -0.12], [0.6, 0.21, 0.15, -0.1], [0.9, 0.08, 0.19, -0.05], [1.05, 0.008, 0.21, 0.0]], P.rust, 0.08, 0.3);
      b.box(P.body, 0.74, 0.14, 0.36, -0.16, 0.12, 0);                                                                    // Zitadelle
      b.box(P.body, 0.28, 0.12, 0.28, 0.03, 0.26, 0).box(P.body2, 0.22, 0.1, 0.22, 0.04, 0.38, 0).box(P.body, 0.16, 0.08, 0.17, 0.05, 0.48, 0);   // Pagodenturm
      b.box(P.rust, 0.2, 0.025, 0.2, 0.05, 0.56, 0).pbox(P.glass, 0.012, 0.035, 0.14, 0.131, 0.5, 0).pbox(T.team, 0.12, 0.01, 0.14, 0.04, 0.585, 0);
      b.cyl(P.rust, 0.012, 0.022, 0.26, 6, 0.04, 0.585, 0).pbox(P.metal, 0.012, 0.012, 0.24, 0.04, 0.78, 0);
      for (i = 0; i < 2; i++) { k = -0.22 - i * 0.2; b.cyl(P.body2, 0.06, 0.068, 0.24, 8, k, 0.26, 0).cyl(P.rust, 0.07, 0.07, 0.05, 8, k, 0.48, 0).cyl(P.dark, 0.052, 0.052, 0.012, 8, k, 0.53, 0); }
      b.pbox(T.team, 0.12, 0.04, 0.14, -0.22, 0.38, 0);
      b.box(P.body, 0.2, 0.12, 0.28, -0.66, 0.12, 0);
      // Heckgeschütz (fest, Blick nach achtern)
      b.cylB(P.body2, 0.1, 0.04, 10, -0.8, 0.12, 0, 0.01).box(P.body, 0.2, 0.09, 0.18, -0.8, 0.16, 0).box(P.rust, 0.05, 0.1, 0.19, -0.71, 0.16, 0);
      b.cylX(P.dark, 0.018, 0.016, 0.26, 6, -0.98, 0.2, 0.045).cylX(P.dark, 0.018, 0.016, 0.26, 6, -0.98, 0.2, -0.045);
      if (hi) {
        rivets(b, P.metal, -0.48, 0.16, 0.23, 0.182, 7); rivets(b, P.metal, -0.48, 0.16, 0.23, -0.182, 7);
        b.cylZ(P.body2, 0.03, 0.14, 8, -0.06, 0.18, 0.2).cylZ(P.body2, 0.03, 0.14, 8, -0.06, 0.18, -0.2);
        b.box(P.rust, 0.08, 0.05, 0.1, -0.42, 0.26, 0.12).box(P.rust, 0.08, 0.05, 0.1, -0.42, 0.26, -0.12);
        b.cylX(P.dark, 0.008, 0.008, 0.12, 4, -0.38, 0.33, 0.12).cylX(P.dark, 0.008, 0.008, 0.12, 4, -0.38, 0.33, -0.12);
        b.cyl(P.metal, 0.005, 0.007, 0.16, 4, -1.0, 0.12, 0).pbox(T.team, 0.08, 0.05, 0.006, -0.96, 0.23, 0);
      }
      rd.pbox(P.dark, 0.03, 0.04, 0.03, 0, 0, 0).pbox(P.rust, 0.02, 0.05, 0.2, 0, 0.03, 0);
      M.xparts.rdr = rd.geo(false); M.xp.push({ p: 'rdr', x: 0.04, y: 0.79, z: 0, k: 'spin' });
      M.exhaust = [[-0.22, 0.53, 0], [-0.42, 0.53, 0]];
      // Werfer: gepanzertes Gehäuse mit Schrägfront
      t.cylB(P.dark, 0.16, 0.05, 12, 0, DY - 0.01, 0, 0.012);
      t.prism(P.body, [[-0.16, DY + 0.04], [0.06, DY + 0.04], [0.14, DY + 0.1], [0.06, DY + 0.18], [-0.16, DY + 0.18]], 0.28, 0, 0, 0, 0, 0.012);
      t.box(P.rust, 0.06, 0.15, 0.3, -0.14, DY + 0.04, 0).pbox(T.team, 0.14, 0.01, 0.26, -0.06, DY + 0.18, 0);
      if (hi) { rivetsX(t, P.metal, -0.1, 0.1, DY + 0.14, 0.081, 4); t.pbox(P.dark, 0.05, 0.03, 0.05, -0.1, DY + 0.19, 0.08); }
      trx = -0.04; tryy = DY + 0.17;
      // Kastenschienen (Gitterträger)
      r.box(P.body2, 0.52, 0.04, 0.24, 0.16, -0.035, 0).pbox(P.rust, 0.54, 0.03, 0.03, 0.18, 0.005, 0.085).pbox(P.rust, 0.54, 0.03, 0.03, 0.18, 0.005, -0.085);
      r.pbox(P.dark, 0.035, 0.07, 0.26, -0.06, -0.04, 0).pbox(P.dark, 0.03, 0.05, 0.24, 0.4, -0.02, 0);
      ml = function (mb, z) {
        mb.cylX('#a8a27a', 0.038, 0.038, 0.36, 8, 0.18, 0.07, z).add(new THREE.ConeGeometry(0.038, 0.11, 8), '#7a2a1c', 0.415, 0.07, z, 0, 0, -Math.PI / 2);
        mb.pbox(P.dark, 0.03, 0.08, 0.006, 0.02, 0.03, z).pbox(P.dark, 0.03, 0.006, 0.08, 0.02, 0.067, z).pbox(P.rust, 0.03, 0.078, 0.078, 0.29, 0.031, z);
      };
      mz = 0.47;
    }
    ml(mA, syn ? 0.085 : 0.07); ml(mB, syn ? -0.085 : -0.07);
    M.trun = [trx, tryy];
    var ce = Math.cos(DREAD_EL), se = Math.sin(DREAD_EL), my = 0.06;
    M.muzzle = [trx + ce * mz - se * my, tryy + se * mz + ce * my]; M.mz2 = syn ? 0.085 : 0.07;
    g.ico(NAVL, 0.018, 0.1, 0.32, -0.15, 1, 1, 1, 0).ico(NAVR, 0.018, 0.1, 0.32, 0.15, 1, 1, 1, 0).ico(STROBE, 0.02, syn ? 0.04 : -0.08, syn ? 0.86 : 0.92, 0, 1, 1, 1, 0);
    M.wake = [1.05, -1.0, 0.3];
    M.parts.hull = b.geo(); M.parts.turret = t.geo(); M.parts.barrel = r.geo(); M.parts.mslA = mA.geo(); M.parts.mslB = mB.geo(); M.parts.glow = g.geo(false);
    M.v8u = 'naval';
    void type;
    return M;
  }
  /** Raketen auf den Schienen (0..salvo): laufende Salve → Rest, sonst geladen, sobald 60 % der Nachladezeit um sind. */
  function dreadLoad(e) {
    if (e.salvoN > 0) return e.salvoN;
    var u = D.UNITS[e.type], Pl = G.Sim.S && G.Sim.S.players[e.owner], w = u && Pl ? (u[Pl.faction] || u.coalition).weapon : null;
    if (!w) return 2;
    return (e.cd || 0) <= w.rof * D.TICK_HZ * 0.4 ? (w.salvo || 2) : 0;
  }
  /** Werfer des Schlachtschiffs: Lafette dreht mit tdir, Schienen heben sich mit setup, Raketen sichtbar solange geladen. */
  function dreadParts(e, M, r, x, y, z, s, dt, own, type, dk) {
    r.sv = r.sv == null ? (e.setup || 0) : r.sv + ((e.setup || 0) - r.sv) * Math.min(1, dt * 5);
    var Bt = spinY(B8b, B8, r.dir - r.tdir), el = M.EL * smooth(clamp(r.sv, 0, 1)), Be = spinZ(B8d, Bt, el), ra = R.t - (r.b0 || -1e9), kick = ra < 0.25 ? 0.025 * (1 - ra / 0.25) : 0;
    lv(B8, M.pivot[0], 0, M.pivot[1], s); var px = x + P8[0], py = y + P8[1], pz = z + P8[2];
    partBatch('u', type, own, 'turret', M).putM(px, py, pz, Bt, s, dk, dk, dk);
    lv(Bt, M.trun[0], M.trun[1], 0, s); px += P8[0] - Be[0] * kick * s; py += P8[1] - Be[1] * kick * s; pz += P8[2] - Be[2] * kick * s;
    partBatch('u', type, own, 'barrel', M).putM(px, py, pz, Be, s, dk, dk, dk);
    var n = e.hp != null ? dreadLoad(e) : 0;
    if (n >= 2) partBatch('u', type, own, 'mslA', M).putM(px, py, pz, Be, s, dk, dk, dk);
    if (n >= 1) partBatch('u', type, own, 'mslB', M).putM(px, py, pz, Be, s, dk, dk, dk);
  }
  /** Abgestürztes Luftfahrzeug (fällt mit Schwung, dreht/rollt, Rauchfahne) bzw. sinkendes Schiff (Krängung, sinkt, Rauch/Blasen). → false = entfernen */
  function drawV8Wreck(w, wa, dt) {
    var M = model(w.type, w.fac, w.color), s = SCALE[w.type] || 1, F3 = G.R3F, i, xe, dk = 0.42, gy;
    if (w.kind === 'crash') {
      w.vy -= 5.5 * dt; w.x += w.vx * dt; w.z += w.vz * dt; w.y += w.vy * dt; w.dir += w.spin * dt; w.roll += w.rs * dt; w.pit = Math.max(-0.85, w.pit - 0.7 * dt);
      gy = groundAt(w.x, w.z);
      var wat = R3T0() && G.R3T.heightAt(w.x, w.z) < -0.09, fl = wat ? WL8 : gy;
      if (w.y <= fl + 0.03 || wa > 5) {   // Aufschlag
        var vis = visibleAt(w.x * TILE, w.z * TILE);
        if (vis) {
          F3.explosion(w.x, fl + 0.2, w.z, wat ? 0.9 : 1.25, !wat);
          if (wat) { for (i = 0; i < 10; i++) { var sa = rnd() * 6.283; F3.puff(w.x, WL8 + 0.05, w.z, Math.cos(sa) * 1.2, 1.4 + rnd() * 1.5, Math.sin(sa) * 1.2, 1.0, 0.15, 0.5, 0.92, 0.6, 0); } F3.wave(0, w.x, w.z, 0.2, 1.6, 0.9, 0.5, 0.55, 0.6); }
          else { G.R3T.decal(w.x, w.z, 1.2, 32); F3.burn(w.x, w.z, 7, 0.7, 1); F3.dust(w.x, gy, w.z, 1.2); }
          flashAt(w.x, fl + 0.5, w.z, 0.18, 1.4); F3.addShake(0.07, 0.3);
        }
        if (wat) return false;
        w.kind = 'unit'; w.t0 = R.t; w.life = 9; w.tdir = w.dir;
        return true;
      }
      basis(B8, w.dir, w.pit, w.roll);
      partBatch('u', w.type, w.owner, 'hull', M).putM(w.x, w.y, w.z, B8, s, dk, dk * 0.95, dk * 0.9);
      for (i = 0; i < M.xp.length; i++) {
        xe = M.xp[i]; if (xe.k === 'bomb') continue; lv(B8, xe.x, xe.y, xe.z, s);
        partBatch('u', w.type, w.owner, xe.p, M).putM(w.x + P8[0], w.y + P8[1], w.z + P8[2], xe.k === 'rotor' ? spinY(B8b, B8, wa * 9) : B8, s, dk, dk, dk);
      }
      if (rnd() < dt * 40) emit(1, w.x, w.y + 0.1, w.z, (rnd() - 0.5) * 0.2, 0.3, (rnd() - 0.5) * 0.2, 1.6 + rnd(), 0.15, 0.6, 0.1, 0.1, 0.1, 0.8, 0.3, 0.3, 0.3, 0, 0, 0.4);
      if (rnd() < dt * 30) emit(0, w.x, w.y + 0.12, w.z, 0, 0.2, 0, 0.25, 0.3, 0.08, 1, 0.65, 0.2, 1, 0.9, 0.2, 0.05, 0);
      return true;
    }
    // sinkendes Schiff
    var f = wa / w.life;
    if (f >= 1) return false;
    var yy = WL8 - f * f * 0.85 * s, rl = w.side * (0.06 + 0.55 * f * f), pp = w.side2 * 0.32 * f * f;
    dk = 0.36 + 0.2 * Math.max(0, 1 - wa * 1.5);
    basis(B8, w.dir, pp, rl);
    partBatch('u', w.type, w.owner, 'hull', M).putM(w.x, yy, w.z, B8, s, dk, dk * 0.95, dk * 0.9);
    if (M.parts.turret) {
      var Bt = spinY(B8b, B8, w.dir - w.tdir); lv(B8, M.pivot[0], 0, M.pivot[1], s);
      partBatch('u', w.type, w.owner, 'turret', M).putM(w.x + P8[0], yy + P8[1], w.z + P8[2], Bt, s, dk, dk, dk);
      if (M.dread) { var tq0 = P8[0], tq1 = P8[1], tq2 = P8[2]; lv(Bt, M.trun[0], M.trun[1], 0, s); partBatch('u', w.type, w.owner, 'barrel', M).putM(w.x + tq0 + P8[0], yy + tq1 + P8[1], w.z + tq2 + P8[2], Bt, s, dk, dk, dk); }   // v0.9: Schienen am Schildzapfen
      else if (M.parts.barrel) partBatch('u', w.type, w.owner, 'barrel', M).putM(w.x + P8[0], yy + P8[1], w.z + P8[2], Bt, s, dk, dk, dk);
    }
    if (M.parts.turB) { partBatch('u', w.type, w.owner, 'turB', M).putM(w.x, yy, w.z, B8, s, dk, dk, dk); partBatch('u', w.type, w.owner, 'barB', M).putM(w.x, yy, w.z, B8, s, dk, dk, dk); }
    if (M.parts.aaT) { partBatch('u', w.type, w.owner, 'aaT', M).putM(w.x, yy, w.z, B8, s, dk, dk, dk); partBatch('u', w.type, w.owner, 'aaB', M).putM(w.x, yy, w.z, B8, s, dk, dk, dk); }
    for (i = 0; i < M.xp.length; i++) { xe = M.xp[i]; lv(B8, xe.x, xe.y, xe.z, s); partBatch('u', w.type, w.owner, xe.p, M).putM(w.x + P8[0], yy + P8[1], w.z + P8[2], B8, s, dk, dk, dk); }
    if (!visibleAt(w.x * TILE, w.z * TILE)) return true;
    var cd = Math.cos(w.dir), sd = Math.sin(w.dir), L = (M.wake ? (M.wake[0] - M.wake[1]) * 0.5 : 0.5) * s;
    if (f < 0.65 && rnd() < dt * 18) emit(1, w.x, yy + 0.35, w.z, 0.1, 0.5, 0.03, 2.2, 0.2, 0.9, 0.1, 0.1, 0.1, 0.8, 0.3, 0.3, 0.3, 0, 0, 0.3);
    if (f < 0.35 && rnd() < dt * 14) emit(0, w.x + cd * (rnd() - 0.5) * L, yy + 0.2, w.z + sd * (rnd() - 0.5) * L, 0, 0.5, 0, 0.35, 0.3, 0.08, 1, 0.6, 0.2, 1, 0.9, 0.2, 0.05, 0);
    if (rnd() < dt * 16) { var bo = (rnd() - 0.5) * 2 * L; F3.puff(w.x + cd * bo, WL8 + 0.03, w.z + sd * bo, (rnd() - 0.5) * 0.3, 0.25, (rnd() - 0.5) * 0.3, 0.7, 0.06, 0.3, 0.92, 0.55, 0); }
    if ((w.wk = (w.wk || 0) + dt) > 0.25 && f < 0.8) { w.wk = 0; F3.wake(w.x + cd * (rnd() - 0.5) * L, w.z + sd * (rnd() - 0.5) * L, w.dir, 0, 0.3 * s, 0.6); }
    return true;
  }

  // ================================================================== v1.0 Kollektiv – PLATZHALTER v1.0 (3D)
  // Gemeinsame Typen (hq, power, tank, rifle …) nutzen die vorhandenen Modelle mit der dunkelblauen Kollektiv-Palette PAL.kollektiv
  // (Koalitions-Geometrie); neue Typen bekommen hier einfache Formen mit den üblichen Teilen (hull/turret/barrel bzw. body/head/glow).
  var K10M = { psiadept: 1, brute: 1, gatling: 1, magnet: 1, psitank: 1, psitower: 1, psidome: 1 };
  var K10_GLOWC = '#a5b4fc';
  function buildK10(type, color) {   // PLATZHALTER v1.0
    var P = PAL.kollektiv, T = teamCols(color), b = new MB(), t = new MB(), r = new MB(), g = new MB(), i;
    var M = { parts: {}, xparts: {}, xp: [], pivot: [0, 0], recoil: 0.05, muzzle: [0.45, 0.3], h: 0.5, k10: true };
    if (type === 'psiadept' || type === 'brute') {
      var k = type === 'brute' ? 1.35 : 1;
      infLegs(M, P, k);   // Bewegung: Beine als eigenes Teil
      b.box(T.team, 0.11 * k, 0.15 * k, 0.16 * k, 0, 0.12 * k, 0).ico(P.helm, 0.055 * k, 0.01, 0.31 * k, 0);
      if (type === 'psiadept') { b.add(new THREE.TorusGeometry(0.09, 0.012, 5, 14), K10_GLOWC, 0, 0.4, 0, 0, Math.PI / 2, 0); b.ico(K10_GLOWC, 0.022, 0.05, 0.31, 0); }
      else { b.ico(P.body2, 0.05, 0.03, 0.2 * k, 0.12 * k).ico(P.body2, 0.05, 0.03, 0.2 * k, -0.12 * k); }
      M.parts.hull = b.geo(false); M.h = 0.36 * k; M.muzzle = [0.2, 0.3];
      return M;
    }
    if (type === 'psitower' || type === 'psidome') {
      var dome = type === 'psidome', w = dome ? 3 : 2, hh = 2;
      b.box(P.conc, w * 0.92, 0.22, hh * 0.92, 0, 0, 0).box(T.team, w * 0.94, 0.05, hh * 0.94, 0, 0.18, 0);
      if (dome) { b.dome(P.body2, 0.62, 0, 0.22, 0, 1.3, 1, 1, 14); g.ico(K10_GLOWC, 0.22, 0, 0.75, 0, 1, 0.7, 1, 1); M.h = 1.0; }
      else {
        b.cyl(P.body, 0.14, 0.32, 1.25, 8, 0, 0.22, 0);
        t.add(new THREE.TorusGeometry(0.42, 0.045, 6, 18), K10_GLOWC, 0, 1.1, 0, 0, Math.PI / 2, 0);
        t.box(P.dark, 0.5, 0.06, 0.06, 0.25, 1.1, 0);
        g.ico(K10_GLOWC, 0.16, 0, 1.55, 0, 1, 1, 1, 1); M.parts.head = t.geo(); M.h = 1.6;
      }
      M.parts.body = b.geo(); M.parts.glow = g.geo(false); M.lit = true;
      return M;
    }
    // Fahrzeuge: flache Wanne auf Schwebe-Kufen, Turm um den Drehpunkt
    var sc = type === 'psitank' ? 1.2 : 1;
    b.box(P.body, 0.86 * sc, 0.16, 0.56 * sc, 0, 0.07, 0).box(T.team, 0.5 * sc, 0.03, 0.58 * sc, -0.05, 0.2, 0);
    for (i = -1; i <= 1; i += 2) b.box(P.dark, 0.74 * sc, 0.06, 0.1, 0, 0.0, i * 0.24 * sc);
    t.cylB(P.body2, 0.2 * sc, 0.12, 8, 0, 0.23, 0, 0.012);
    if (type === 'gatling') { for (i = -1; i <= 1; i++) r.cylX(P.dark, 0.02, 0.02, 0.42, 6, 0.36, 0.3 + (i === 0 ? 0.03 : 0), i * 0.035); M.muzzle = [0.58, 0.3]; }
    else if (type === 'magnet') { r.box(P.metal, 0.4, 0.06, 0.06, 0.25, 0.32, 0.12).box(P.metal, 0.4, 0.06, 0.06, 0.25, 0.32, -0.12).box(P.metal, 0.06, 0.06, 0.3, 0.05, 0.32, 0); M.muzzle = [0.45, 0.35]; }
    else { t.dome(P.glass, 0.2, 0, 0.35, 0, 1, 1, 1, 10); g.ico(K10_GLOWC, 0.1, 0, 0.5, 0, 1, 1, 1, 1); M.muzzle = [0.1, 0.55]; }
    M.parts.hull = b.geo(); M.parts.turret = t.geo(); if (type !== 'psitank') M.parts.barrel = r.geo(); else M.parts.glow = g.geo(false);
    M.h = 0.45 * sc;
    return M;
  }

  /** v1.0 PLATZHALTER: Ring um gedankenkontrollierte (hellindigo) bzw. vom Magnet gehaltene (grau) Einheiten + leuchtende Verbindung zum Kontrolleur. */
  function k10Link(e, x, z, alpha, tick, selRing, pid, fogOff) {
    var gy = groundAt(x, z) + 0.04, pu = 0.75 + 0.25 * Math.sin(R.t * 5);
    if (e.magT > tick) selRing.put(x, gy, z, 0, 0.42, 1, 0.42, 0.7, 0.75, 0.8);
    if (!e.mcBy) return;
    selRing.put(x, gy, z, 0, 0.36 + 0.04 * pu, 1, 0.36 + 0.04 * pu, 0.6 * pu, 0.66 * pu, 1.0 * pu);
    var c = G.Sim.get(e.mcBy);
    if (!c || c.dead || (!fogOff && c.owner !== pid && !G.Sim.isVisible(pid, c))) return;
    var cx = (c.kind === 'unit' ? c.px + (c.x - c.px) * alpha : c.x) / TILE, cz = (c.kind === 'unit' ? c.py + (c.y - c.py) * alpha : c.y) / TILE;
    var dx = x - cx, dz = z - cz, L = Math.sqrt(dx * dx + dz * dz);
    if (L < 0.05) return;
    var lb = batch('k10link', function () { var mb = new MB(); mb.flat = true; mb.box('#ffffff', 1, 0.04, 0.04, 0, -0.02, 0); return mb.geo(false); }, partMat('glow'), 32, false);
    var ly = Math.max(groundAt(cx, cz), groundAt(x, z)) + (c.kind === 'unit' ? 0.45 : 1.1);
    lb.put((cx + x) / 2, ly, (cz + z) / 2, Math.atan2(dz, dx), L, 1, 1, 0.55 * pu, 0.62 * pu, 1.0 * pu);
  }
  // ================================================================== GB: Kollektiv-Gebäude – eigene Formensprache (Psi)
  // Statt der Koalitions-Kästen: achteckige dunkle Sockel, Perlmutt-Kuppeln/-Gewölbe, schräge Finnen, schwebende Ringe (Teamfarbe) und
  // leuchtende Kristalle. Jeder Typ hat ein „sprechendes“ Merkmal: Zentrale = Kuppel + Traktor-Ausleger über der Bauplattform, Reaktor =
  // Kristallkern in drei Finnen mit Ringen, Erzwandler = Erzkugeln + Trichter + Schrägförderer, Klonlabor = drei Klonröhren + Appellplatz +
  // Torbogen, Kriegsfabrik = Gewölbehalle + Portal über offener Montagebucht, Psi-Labor = Stufenturm mit Kristall + Halo + Antennen,
  // Psi-Verstärker = offene Kuppel mit Emitter + Ladezellen, Psi-Turm = Dreibein mit Ringkopf, Geschütze klar mit Rohr.
  // Modelle sind direkt für die Kamera aus Süd-West gebaut (Fronten Süd + West) → KEINE Spiegelung (M.mir = true).
  // Grundflächen, Ausgänge (Mitte Süd bzw. Nordausgang), Andockseiten, Landeplätze, Mündungspunkte und Teile-Haken wie bei den gemeinsamen Modellen.
  // Bewegte Teile liegen in Ruhestellung in M.parts (Symbol/Vorschau zeigen sie ohne Sonderfall); Anzeigen (Hologramm, Strahl, Füllstand,
  // Förderstollen) liegen nur in M.xparts. Gezeichnet/animiert werden sie in actDraw (Abschnitt GA unten).
  var KB = { hq: 1, power: 1, refinery: 1, barracks: 1, factory: 1, techcenter: 1, turret: 1, mg: 1, flak: 1, pbunker: 1, airfield: 1, shipyard: 1, psitower: 1, psidome: 1,
    repairdock: 1, oresilo: 1, minefield: 1, gate: 1 };   // v1.2 (buildB12)
  var KP = { edge: '#4b4660', plate: '#77718c', base: '#3a3450', base2: '#4f4869', shell: '#e0daec', shell2: '#a99fca', dark: '#1e1b2a', metal: '#c9c5d8',
    glass: '#9cc9ff', glow: '#eaa9ff', glow2: '#8ff3ff', ore: '#ffb44a', line: '#5b5573', conc: '#8b8699', body: '#e0daec', body2: '#a99fca', rust: '#4f4869', roof: '#3a3450', pan: '#f2eff8' };
  (function () {   // Oberflächen für Modern
    surfCol[KP.edge] = 'conc'; surfCol[KP.plate] = 'conc'; surfCol[KP.base] = 'body'; surfCol[KP.base2] = 'body'; surfCol[KP.shell] = 'body'; surfCol[KP.shell2] = 'body';
    surfCol[KP.dark] = 'dark'; surfCol[KP.metal] = 'metal'; surfCol[KP.glass] = 'glass'; surfCol[KP.line] = 'conc'; surfCol[KP.pan] = 'body';
  })();
  /** Achteck-Prisma (Flächen achsparallel), Unterkante y, Radius r (Mitte → Ecke) oben/unten, optional gestreckt (sx, sz). */
  function kOct(b, col, rt, rb, h, x, y, z, sx, sz, seg) {
    var g = new THREE.CylinderGeometry(rt, rb, h, seg || 8); if (!seg || seg === 8) g.rotateY(Math.PI / 8);
    return b.add(g, col, x, y + h / 2, z, 0, 0, 0, sx || 1, 1, sz || 1);
  }
  /** Offenes Band (Ring-Mantel) – Teamstreifen, Leuchtfugen. */
  function kBand(b, col, r, y, h, x, z, seg) {
    var g = new THREE.CylinderGeometry(r, r, h, seg || 16, 1, true); if (seg === 8) g.rotateY(Math.PI / 8);
    return b.add(g, col, x, y + h / 2, z);
  }
  /** Liegender Ring (Torus in der xz-Ebene). */
  function kTor(b, col, R0, tube, x, y, z, rs, ts) { return b.add(new THREE.TorusGeometry(R0, tube, rs || 5, ts || 18), col, x, y, z, 0, Math.PI / 2, 0); }
  /** Flacher Leuchtring auf einer Oberseite. */
  function kDisc(b, col, r0, r1, x, y, z, seg) { return b.add(new THREE.RingGeometry(r0, r1, seg || 18), col, x, y, z, 0, -Math.PI / 2, 0); }
  /** Bodenplatte: achteckig (Ecken gekappt), Randstein dunkel, Platte hell, Teamstreifen an Süd- und Westkante. Oberkante 0.06. */
  function kPlate(b, T, w, h) {
    var k = 1 / 0.924;
    kOct(b, KP.edge, 0.5, 0.5, 0.05, 0, 0, 0, (w - 0.03) * k, (h - 0.03) * k);
    kOct(b, KP.plate, 0.5, 0.5, 0.012, 0, 0.05, 0, (w - 0.2) * k, (h - 0.2) * k);
    b.top(T.team, -w * 0.32, h / 2 - 0.075, w * 0.32, h / 2 - 0.075, 0.052, 0.075);
    b.top(T.team, -w / 2 + 0.075, -h * 0.32, -w / 2 + 0.075, h * 0.32, 0.052, 0.075);
  }
  /** Finne (schräges Blatt) radial bei Winkel a (Richtung (cos a, sin a) in x/z), Profil r0..r1 unten bis Spitze rt bei Höhe ht. */
  function kFin(b, col, a, r0, r1, rt, ht, th, y0, cx, cz) {
    var pts = [[r0, 0], [r1, 0], [rt + 0.05, ht], [rt, ht]];
    return b.prism(col, pts, th, cx || 0, y0 || 0.06, cz || 0, -a, 0.008);
  }
  /** Tonnengewölbe (obere Zylinderhälfte), Achse entlang x (alongZ: entlang z), Mitte der Grundlinie bei (x, y, z). */
  function kVault(b, col, r, len, x, y, z, alongZ, seg) {
    var g = new THREE.CylinderGeometry(r, r, len, seg || 12, 1, false, 0, Math.PI); g.rotateZ(Math.PI / 2); if (alongZ) g.rotateY(Math.PI / 2);
    return b.add(g, col, x, y, z);
  }
  /** Antennen-Nadel mit Leuchtspitze. */
  function kSpire(b, g, x, z, y0, hgt, r) {
    b.cyl(KP.shell2, 0.012, r || 0.06, hgt, 6, x, y0, z).cylB(KP.base, (r || 0.06) * 1.4, 0.06, 6, x, y0, z, 0.01);
    g.ico(KP.glow, 0.04, x, y0 + hgt + 0.02, z, 1, 1.4, 1, 0);
  }
  /** Drahtgitter-Würfel (Hologramm) – Kanten + zwei Querschnitte, Unterkante 0, Breite a. */
  function kHoloGeo(a, hgt) {
    var m = new MB(), h2 = a / 2, t = 0.022, i, y;
    m.flat = true;
    for (i = 0; i < 4; i++) m.pbox('#ffffff', t, hgt, t, (i & 1 ? 1 : -1) * h2, 0, (i & 2 ? 1 : -1) * h2);
    for (i = 0; i < 3; i++) {
      y = i === 0 ? 0 : (i === 1 ? hgt * 0.5 : hgt - t);
      m.pbox('#ffffff', a, t, t, 0, y, h2).pbox('#ffffff', a, t, t, 0, y, -h2).pbox('#ffffff', t, t, a, h2, y, 0).pbox('#ffffff', t, t, a, -h2, y, 0);
    }
    m.pbox('#ffffff', a * 0.55, hgt * 0.62, a * 0.55, 0, 0, 0);   // Kern (wächst mit)
    return m.geo(false);
  }

  function buildKB(type, color) {
    if (V12B[type]) return buildB12(type, 'kollektiv', color);   // v1.2: Regenerator, Erzspeicher, Minenfeld, Kristalltor
    var T = teamCols(color), hi = HI(), P = KP, i, a, x, z, sd;
    var b = new MB(), g = new MB(), M = { parts: {}, xparts: {}, xp: [], h: 1, mir: true, mirA: 1, kb: type, lit: true, lo: !hi, act: null };
    var bd = D.BUILDINGS[type], w = bd.w, h = bd.h;
    if (type !== 'shipyard') kPlate(b, T, w, h);
    if (type === 'hq') {                                    // Psi-Zentrale: Kuppel auf Achteck-Sockel, Mast + Traktor-Ausleger über der Bauplattform
      var hx = -0.4, hz = -0.4;
      kOct(b, P.base, 1.02, 1.08, 0.26, hx, 0.06, hz); kBand(b, T.team, 1.09, 0.2, 0.08, hx, hz, 8);
      kOct(b, P.base2, 0.98, 1.0, 0.04, hx, 0.32, hz);
      kBand(g, P.glow, 0.95, 0.36, 0.045, hx, hz, 16);
      b.dome(P.shell, 0.9, hx, 0.36, hz, 1, 0.74, 1, 16);
      kTor(b, T.team, 0.5, 0.04, hx, 0.36 + 0.9 * 0.74 * 0.84, hz, 5, 16); b.dome(T.team, 0.33, hx, 0.975, hz, 1, 0.42, 1, 12);
      b.cylB(P.shell2, 0.1, 0.62, 8, hx, 0.98, hz, 0.012).cylB(T.team, 0.14, 0.07, 8, hx, 1.3, hz, 0.01).cylB(P.base, 0.15, 0.08, 8, hx, 1.56, hz, 0.012);
      // Tor (Süd-West-Seite) + Teamfinnen links/rechts
      b.box(P.dark, 0.42, 0.3, 0.1, hx - 0.7, 0.06, hz + 0.7, Math.PI / 4).box(T.team, 0.52, 0.05, 0.16, hx - 0.72, 0.36, hz + 0.72, Math.PI / 4);
      g.pbox(P.glow, 0.34, 0.03, 0.02, hx - 0.745, 0.3, hz + 0.745, Math.PI / 4);
      for (sd = -1; sd <= 1; sd += 2) { a = Math.PI * 0.75 + sd * 0.5; kFin(b, T.team, a, 0.96, 1.16, 0.9, 0.95, 0.07, 0.06, hx, hz); }
      // Bauplattform (vorn links) mit Leuchtring
      var px = 0.84, pz = 0.84;
      kOct(b, P.base, 0.56, 0.6, 0.08, px, 0.06, pz); kBand(b, T.team, 0.61, 0.07, 0.05, px, pz, 8);
      kDisc(g, P.glow, 0.36, 0.43, px, 0.141, pz, 16); kDisc(b, P.line, 0.0, 0.3, px, 0.1405, pz, 8);
      b.top(T.teamL, px - 0.18, pz, px + 0.18, pz, 0.142, 0.04).top(T.teamL, px, pz - 0.18, px, pz + 0.18, 0.142, 0.04);
      // Antennen hinten, Leitungen
      kSpire(b, g, 1.2, -1.2, 0.06, 1.05, 0.06); if (hi) kSpire(b, g, 0.55, -1.25, 0.06, 0.7, 0.05);
      b.cylX(P.base2, 0.045, 0.045, 0.62, 6, 0.3, 0.12, 0.3, -Math.PI / 4);
      if (hi) { b.box(P.base2, 0.3, 0.2, 0.3, -1.15, 0.06, 1.12).pbox(T.team, 0.32, 0.03, 0.32, -1.15, 0.26, 1.12); g.pbox(P.glow, 0.2, 0.05, 0.012, -1.15, 0.14, 1.276); }
      // Ausleger (dreht um den Mast): Richtung zur Plattform, Gegengewicht, Emitter an der Spitze
      var bm = new MB(), BL = 1.7, a0 = Math.atan2(pz - hz, px - hx);
      bm.box(P.shell, BL + 0.45, 0.12, 0.14, (BL - 0.45) / 2, -0.06, 0).pbox(T.team, BL + 0.3, 0.03, 0.145, (BL - 0.3) / 2 + 0.05, 0.06, 0);
      bm.box(P.base2, BL * 0.72, 0.045, 0.07, BL * 0.42, -0.26, 0); for (i = 0; i < 4; i++) bm.pbox(P.base2, 0.03, 0.2, 0.05, 0.12 + i * BL * 0.22, -0.24, 0);
      bm.box(P.base, 0.26, 0.2, 0.22, -0.36, -0.12, 0).cylB(P.base2, 0.13, 0.08, 8, 0, -0.04, 0, 0.01);
      bm.add(new THREE.CylinderGeometry(0.05, 0.12, 0.2, 8), P.shell2, BL - 0.02, -0.16, 0).cyl(P.glow, 0.045, 0.045, 0.05, 8, BL - 0.02, -0.31, 0);
      if (hi) for (i = 0; i < 5; i++) bm.pbox(P.base2, 0.02, 0.12, 0.148, 0.25 + i * 0.3, -0.06, 0);
      var bg = bm.geo(); bg.rotateY(-a0); bg.translate(hx, 1.64, hz);
      M.parts.kboom = bg; M.kPiv = [hx, hz]; M.kTip = [hx + Math.cos(a0) * (BL - 0.02), 1.33, hz + Math.sin(a0) * (BL - 0.02)]; M.kPad = [px, 0.15, pz];
      M.xparts.kholo = kHoloGeo(0.52, 0.5);
      var bmb = new MB(); bmb.flat = true; bmb.add(new THREE.CylinderGeometry(0.05, 0.12, 1, 8, 1, true), '#ffffff', 0, 0.5, 0); M.xparts.kbeam = bmb.geo(false);
      M.h = 1.65; M.act = { k: 'hq', cells: [-0.95, 1.4, 0.1, 1.4, 0.062] };
    } else if (type === 'power') {                          // Psi-Reaktor: Kristallkern, drei Finnen, schwebende Teamringe
      kOct(b, P.base, 0.7, 0.76, 0.16, 0, 0.06, 0); kBand(b, T.team, 0.77, 0.14, 0.06, 0, 0, 8);
      b.cylB(P.dark, 0.27, 0.12, 10, 0, 0.22, 0, 0.012).cylB(P.base2, 0.2, 0.06, 10, 0, 0.34, 0, 0.01);
      g.cyl('#c4fcff', 0.13, 0.16, 0.7, 8, 0, 0.38, 0); g.ico('#c4fcff', 0.16, 0, 1.22, 0, 1, 2.1, 1, 0);
      for (i = 0; i < 3; i++) {
        a = -Math.PI / 4 + i * Math.PI * 2 / 3;
        kFin(b, P.shell, a, 0.5, 0.74, 0.3, 1.16, 0.12, 0.2);
        b.box(T.team, 0.2, 0.1, 0.16, Math.cos(a) * 0.62, 0.2, Math.sin(a) * 0.62, -a);
        g.ico(P.glow, 0.045, Math.cos(a) * 0.36, 1.4, Math.sin(a) * 0.36, 1, 1.5, 1, 0);
      }
      // Schaltkasten vorn links + Leitungen
      b.box(P.base2, 0.28, 0.22, 0.24, -0.66, 0.06, 0.66, Math.PI / 4).pbox(T.team, 0.3, 0.03, 0.26, -0.66, 0.28, 0.66, Math.PI / 4);
      g.pbox(P.glow2, 0.16, 0.05, 0.012, -0.6, 0.15, 0.75, Math.PI / 4);
      if (hi) { b.cylX(P.base2, 0.03, 0.03, 0.5, 6, -0.4, 0.1, 0.4, -Math.PI / 4); for (i = 0; i < 4; i++) b.pbox(P.dark, 0.06, 0.04, 0.06, Math.cos(i * 1.57 + 0.78) * 0.86, 0.06, Math.sin(i * 1.57 + 0.78) * 0.86); }
      var rg = new MB();
      kTor(rg, T.team, 0.4, 0.045, 0, 0.56, 0, 5, 18); kTor(rg, T.teamL, 0.33, 0.04, 0, 0.9, 0, 5, 16);
      for (i = 0; i < 3; i++) { a = i * Math.PI * 2 / 3; rg.box(P.shell, 0.09, 0.09, 0.09, Math.cos(a) * 0.4, 0.515, Math.sin(a) * 0.4).box(P.shell, 0.08, 0.08, 0.08, Math.cos(a + 1) * 0.33, 0.86, Math.sin(a + 1) * 0.33); }
      M.parts.kring = rg.geo();
      M.h = 1.45; M.act = { k: 'power' };
    } else if (type === 'refinery') {                       // Erzwandler: Konverter mit Gewölbe, zwei Erzkugeln, Trichter an der Andockbucht, Schrägförderer
      // Konverter: Achteck-Sockel + Kegelturm mit Erz-Glutring
      kOct(b, P.base, 0.5, 0.54, 0.3, 0.3, 0.06, -0.5); kBand(b, T.team, 0.55, 0.26, 0.07, 0.3, -0.5, 8);
      b.add(new THREE.CylinderGeometry(0.27, 0.48, 0.62, 10), P.shell, 0.3, 0.36 + 0.31, -0.5);
      kBand(b, T.team, 0.4, 0.6, 0.07, 0.3, -0.5, 10); kBand(g, P.ore, 0.29, 0.94, 0.04, 0.3, -0.5, 10);
      b.cylB(P.base, 0.2, 0.12, 8, 0.3, 0.98, -0.5, 0.01).cyl(P.dark, 0.08, 0.1, 0.16, 6, 0.3, 1.1, -0.5);
      g.pbox(P.ore, 0.3, 0.06, 0.012, 0.2, 0.2, -0.06).pbox(P.dark, 0.36, 0.1, 0.012, 0.2, 0.18, -0.07);
      // Erzkugeln
      var orbs = [[-1.02, -0.42, 0.38], [1.12, 0.48, 0.3]];
      for (i = 0; i < 2; i++) {
        x = orbs[i][0]; z = orbs[i][1]; var rr = orbs[i][2];
        b.cylB(P.base, rr * 0.55, 0.22, 8, x, 0.06, z, 0.012);
        b.sph(i ? P.shell2 : P.shell, rr, x, 0.24 + rr, z, 1, 1, 1, 14);
        kTor(b, T.team, rr + 0.005, 0.03, x, 0.24 + rr, z, 4, 16);
        g.ico(P.ore, rr * 0.28, x - rr * 0.62, 0.3 + rr, z + rr * 0.62, 1, 1, 1, 0);
      }
      b.cylX(P.base2, 0.05, 0.05, 0.5, 6, -0.46, 0.5, -0.42).cylX(P.base2, 0.045, 0.045, 0.5, 6, 0.86, 0.3, 0.12);
      // Trichter an der Andockbucht (Süd, Mitte) + Schrägförderer zum Konverter
      for (i = 0; i < 4; i++) b.pbox(P.dark, 0.04, 0.3, 0.04, (i & 1 ? 1 : -1) * 0.2, 0.06, 0.55 + (i & 2 ? 1 : -1) * 0.2);
      b.add(new THREE.CylinderGeometry(0.34, 0.12, 0.28, 8, 1, true), P.shell2, 0, 0.5, 0.55).cyl(P.dark, 0.2, 0.2, 0.02, 8, 0, 0.5, 0.55);
      kTor(g, P.ore, 0.34, 0.025, 0, 0.64, 0.55, 4, 16);
      var cl = Math.atan2(0.5, 0.76), cL = Math.sqrt(0.5 * 0.5 + 0.76 * 0.76);
      b.box(P.base2, 0.22, 0.05, cL, 0, 0.625, 0.18, 0, cl).box(P.dark, 0.16, 0.03, cL, 0, 0.655, 0.18, 0, cl);
      M.kBelt = [0, 0.42, 0.56, 0, 0.92, -0.2];   // Förderstollen: von (x,y,z) nach (x,y,z)
      var cm = new MB(); cm.box(P.ore, 0.17, 0.04, 0.05, 0, 0, 0); M.xparts.kbelt = cm.geo(false);
      // Andockbucht vorn: Führungslinien in Teamfarbe; Nordannahme
      b.pbox(P.base, 0.9, 0.012, 0.36, 0, 0.06, 0.8);
      b.top(T.teamL, -0.42, 0.66, -0.42, 0.98, 0.0735, 0.04).top(T.teamL, 0.42, 0.66, 0.42, 0.98, 0.0735, 0.04);
      b.box(P.dark, 0.4, 0.22, 0.04, 0, 0.06, -0.955).pbox(T.team, 0.46, 0.03, 0.06, 0, 0.28, -0.955);
      var dl = new MB(); dl.pbox('#ffffff', 0.08, 0.03, 0.08, 0, 0, 0); M.xparts.kdock = dl.geo(false);
      M.kDockL = [[-0.42, 0.08, 1.0], [0.42, 0.08, 1.0], [-0.24, 0.08, -0.99], [0.24, 0.08, -0.99]];
      M.h = 1.1; M.act = { k: 'refinery' };
    } else if (type === 'barracks') {                       // Klonlabor: drei Klonröhren (Westseite), Unterkunftsflügel hinten, Appellplatz + Torbogen
      b.box(P.base, 1.76, 0.28, 0.6, 0, 0.06, -0.58).box(T.team, 1.78, 0.06, 0.62, 0, 0.3, -0.58);
      for (i = 0; i < 3; i++) { b.dome(P.shell, 0.27, -0.56 + i * 0.56, 0.36, -0.58, 1, 0.85, 1, 12); kTor(b, T.teamL, 0.2, 0.025, -0.56 + i * 0.56, 0.36 + 0.27 * 0.85 * 0.69, -0.58, 4, 12); }
      for (i = 0; i < 4; i++) g.pbox(WINLIT, 0.16, 0.08, 0.012, -0.55 + i * 0.36, 0.17, -0.274);
      for (i = 0; i < 4; i++) b.pbox(P.dark, 0.19, 0.11, 0.012, -0.55 + i * 0.36, 0.155, -0.279);
      b.box(P.dark, 0.3, 0.24, 0.04, -0.5, 0.06, -0.885).pbox(T.team, 0.36, 0.035, 0.06, -0.5, 0.3, -0.885);   // Nordausgang
      // Klonröhren
      M.kTubes = [];
      for (i = 0; i < 3; i++) {
        z = -0.06 + i * 0.36; x = -0.66;
        b.cylB(P.base, 0.16, 0.12, 10, x, 0.06, z, 0.012); kBand(b, T.team, 0.165, 0.14, 0.05, x, z, 10);
        b.cyl('#4f8fb0', 0.12, 0.12, 0.8, 10, x, 0.18, z);
        b.cylB(P.shell, 0.15, 0.08, 10, x, 0.98, z, 0.012).cylB(T.team, 0.1, 0.05, 8, x, 1.06, z, 0.008); g.ico(P.glow, 0.045, x, 1.15, z, 1, 1.3, 1, 0);
        b.cylX(P.base2, 0.03, 0.03, 0.3, 6, x + 0.2, 0.12, z);
        M.kTubes.push([x, 0.18, z]);
      }
      var fl = new MB(); fl.cyl('#ffffff', 0.128, 0.128, 0.78, 10, 0, 0, 0); M.xparts.kfill = fl.geo(false);
      // Appellplatz + Fahne + Torbogen (Südausgang bei x = +0.5)
      b.pbox(P.line, 1.0, 0.012, 0.86, 0.32, 0.06, 0.4);
      b.top(T.team, -0.12, 0.05, 0.76, 0.05, 0.0735, 0.03).top(T.team, -0.12, 0.75, 0.25, 0.75, 0.0735, 0.03);
      for (i = 0; i < 3; i++) b.pbox(P.shell2, 0.05, 0.012, 0.05, 0.05 + i * 0.25, 0.072, 0.4);
      flagPole(b, T, P, 0.86, -0.1, 0.95);
      b.box(P.shell2, 0.09, 0.5, 0.12, 0.2, 0.06, 0.9).box(P.shell2, 0.09, 0.5, 0.12, 0.8, 0.06, 0.9).box(T.team, 0.78, 0.09, 0.16, 0.5, 0.56, 0.9);
      g.pbox(P.glow, 0.5, 0.025, 0.02, 0.5, 0.6, 0.985);
      var dr = new MB(); dr.pbox('#ffffff', 0.5, 0.48, 0.02, 0, 0, 0); M.xparts.kdoor = dr.geo(false); M.kDoor = [0.5, 0.07, 0.9];
      M.h = 1.05; M.act = { k: 'barracks', cells: [-0.95, 0.97, -0.25, 0.97, 0.062] };
    } else if (type === 'factory') {                        // Kriegsfabrik: Gewölbehalle hinten, Portal mit Greifarmen über offener Montagebucht, Rampe
      b.box(P.base, 2.8, 0.3, 1.3, 0, 0.06, -0.77).box(T.team, 2.82, 0.06, 1.32, 0, 0.3, -0.77);
      kVault(b, P.shell, 0.64, 2.76, 0, 0.36, -0.77, false, 14);
      for (i = 0; i < 3; i++) b.add(new THREE.TorusGeometry(0.655, 0.05, 4, 12, Math.PI), T.team, -0.95 + i * 0.95, 0.36, -0.77, Math.PI / 2);
      b.box(P.dark, 1.2, 0.56, 0.06, 0, 0.06, -0.11);                               // Hallentor zur Bucht
      g.pbox(P.glow, 1.24, 0.035, 0.02, 0, 0.62, -0.075).pbox(P.glow, 0.035, 0.56, 0.02, -0.62, 0.06, -0.075).pbox(P.glow, 0.035, 0.56, 0.02, 0.62, 0.06, -0.075);
      b.box(P.dark, 0.8, 0.36, 0.04, 0, 0.06, -1.43).pbox(T.team, 0.86, 0.04, 0.06, 0, 0.42, -1.43);   // Nordtor
      // Montagebucht: Boden, Leitpfeile, Rampe nach Süd
      b.pbox(P.base2, 2.3, 0.03, 1.32, 0, 0.06, 0.54);
      for (i = 0; i < 3; i++) { z = 0.15 + i * 0.36; b.top(T.teamL, -0.2, z, 0, z + 0.12, 0.0915, 0.04).top(T.teamL, 0.2, z, 0, z + 0.12, 0.0915, 0.04); }
      b.pbox(P.base2, 1.0, 0.018, 0.3, 0, 0.06, 1.34);
      // Portal (Pylonen + Träger)
      for (sd = -1; sd <= 1; sd += 2) {
        b.box(P.base, 0.3, 0.12, 0.34, sd * 1.22, 0.06, 0.55).box(P.shell2, 0.16, 0.94, 0.22, sd * 1.22, 0.18, 0.55).box(T.team, 0.18, 0.08, 0.24, sd * 1.22, 0.62, 0.55);
      }
      b.box(P.shell, 2.62, 0.18, 0.22, 0, 1.0, 0.55).box(T.team, 2.5, 0.1, 0.03, 0, 1.04, 0.668).box(T.team, 2.5, 0.03, 0.18, 0, 1.18, 0.55);
      g.pbox(P.glow, 2.2, 0.025, 0.06, 0, 0.985, 0.55);
      if (hi) { roofFan(b, P, 0.9, 0.98, -0.95, 0.09); kSpire(b, g, -1.25, -1.3, 0.06, 0.9, 0.05); }
      var am = new MB(); am.box(P.base, 0.26, 0.1, 0.26, 0, 0.9, 0.55).cyl(T.teamL, 0.04, 0.04, 0.44, 6, 0, 0.47, 0.55).box(P.shell2, 0.18, 0.1, 0.16, 0, 0.4, 0.55);
      am.box(P.base2, 0.05, 0.14, 0.05, -0.06, 0.27, 0.55).box(P.base2, 0.05, 0.14, 0.05, 0.06, 0.27, 0.55).cyl(P.glow, 0.02, 0.035, 0.06, 6, 0, 0.3, 0.55);
      M.parts.karm = am.geo();
      M.h = 1.15; M.act = { k: 'factory', cells: [-1.2, 1.42, -0.35, 1.42, 0.062], veh: [0, 0.09, 0.5, 1.75], open: true };
    } else if (type === 'techcenter') {                     // Psi-Labor: Stufenturm, Kristall mit Halo, drei Antennen
      var tx = 0.12, tz = -0.12;
      kOct(b, P.base, 1.22, 1.28, 0.3, tx, 0.06, tz); kBand(b, T.team, 1.29, 0.26, 0.07, tx, tz, 8);
      kOct(b, P.shell, 0.86, 0.94, 0.4, tx, 0.36, tz); kBand(g, P.glow, 0.9, 0.48, 0.05, tx, tz, 8);
      kOct(b, P.shell2, 0.56, 0.62, 0.3, tx, 0.76, tz); kBand(b, T.team, 0.58, 0.96, 0.06, tx, tz, 8);
      b.cylB(P.base, 0.24, 0.1, 8, tx, 1.06, tz, 0.012);
      g.ico(P.glow, 0.2, tx, 1.38, tz, 1, 1.75, 1, 0);
      for (i = 0; i < 3; i++) { a = -Math.PI / 4 + i * Math.PI * 2 / 3; kSpire(b, g, tx + Math.cos(a) * 1.02, tz + Math.sin(a) * 1.02, 0.36, 1.1, 0.06); }
      b.box(P.dark, 0.44, 0.26, 0.1, tx - 0.84, 0.06, tz + 0.84, Math.PI / 4).box(T.team, 0.56, 0.05, 0.22, tx - 0.88, 0.32, tz + 0.88, Math.PI / 4);
      if (hi) { acUnit(b, P, tx + 0.5, 0.76, tz + 0.5, 0.18); b.cylX(P.base2, 0.04, 0.04, 0.6, 6, -1.1, 0.12, 1.1); }
      var hl = new MB(); hl.add(new THREE.TorusGeometry(0.4, 0.04, 5, 20), T.team, 0, 0, 0).add(new THREE.TorusGeometry(0.4, 0.03, 5, 20), T.teamL, 0, 0, 0, Math.PI / 2);
      hl.box(P.shell, 0.09, 0.09, 0.09, 0.4, 0, 0).box(P.shell, 0.09, 0.09, 0.09, -0.4, 0, 0).box(P.shell, 0.09, 0.09, 0.09, 0, 0, 0.4).box(P.shell, 0.09, 0.09, 0.09, 0, 0, -0.4);
      var hg = hl.geo(); hg.translate(tx, 1.38, tz); M.parts.kspin = hg; M.kPiv = [tx, tz];   // Gyroskop-Ringe um den Kristall
      M.h = 1.7; M.act = { k: 'tech' };
    } else if (type === 'psidome') {                        // Psi-Verstärker: offene Kuppel mit Emitter, Stützfinnen, Ladezellen vorn, schwebender Ring
      kOct(b, P.base, 1.0, 1.06, 0.2, 0, 0.06, -0.08, 1.3, 0.85); kBand(b, T.team, 1.07, 0.2, 0.06, 0, -0.08, 8);
      b.add(new THREE.SphereGeometry(0.86, 16, 7, 0, Math.PI * 2, 0.42, Math.PI / 2 - 0.42), P.shell, 0, 0.26, -0.08, 0, 0, 0, 1.15, 0.85, 0.85);
      kTor(b, T.team, 0.36 * 1.0, 0.04, 0, 0.26 + 0.86 * 0.85 * Math.cos(0.42), -0.08, 5, 16);
      b.cylB(P.dark, 0.3, 0.3, 10, 0, 0.3, -0.08, 0.01);
      g.ico(P.glow, 0.2, 0, 0.92, -0.08, 1, 1.7, 1, 1);
      for (i = 0; i < 4; i++) {                             // vier Zinken, die sich über der Kuppel zum Emitter neigen
        a = Math.PI / 4 + i * Math.PI / 2;
        b.prism(P.shell2, [[0.92, 0], [1.12, 0], [0.5, 1.28], [0.42, 1.24]], 0.1, 0, 0.06, -0.08, -a, 0.008);
        b.prism(T.team, [[1.0, 0.3], [1.08, 0.3], [0.62, 1.1], [0.56, 1.08]], 0.11, 0, 0.06, -0.08, -a, 0.004);
        g.ico(P.glow, 0.06, Math.cos(a) * 0.47, 1.34, -0.08 + Math.sin(a) * 0.47, 1, 1.3, 1, 0);
      }
      b.box(P.base2, 2.1, 0.16, 0.16, 0, 0.06, 0.86).pbox(P.dark, 2.0, 0.012, 0.12, 0, 0.22, 0.86);
      for (i = 0; i < 8; i++) b.pbox(P.dark, 0.2, 0.1, 0.02, -0.84 + i * 0.24, 0.1, 0.94);
      var cm2 = new MB(); cm2.box('#ffffff', 0.17, 0.08, 0.04, 0, 0, 0); M.xparts.cell = cm2.geo(false);
      for (i = 0; i < 8; i++) M.xp.push({ p: 'cell', x: -0.84 + i * 0.24, y: 0.11, z: 0.955, k: 'cell', ci: i });
      var sr = new MB(); kTor(sr, T.team, 0.5, 0.04, 0, 0, 0, 5, 20); for (i = 0; i < 3; i++) sr.box(P.shell, 0.1, 0.1, 0.1, Math.cos(i * 2.09) * 0.5, -0.05, Math.sin(i * 2.09) * 0.5);
      M.xparts.spin = sr.geo(); M.xp.push({ p: 'spin', x: 0, y: 1.05, z: -0.08, k: 'spin' });
      M.emitAt = [0, 0.95, -0.08];
      M.h = 1.3; M.lit = false;   // Glühen über drawBldV4 (Aufladung)
    } else if (type === 'psitower') {                       // Psi-Turm: Dreibein, Säule, Ringkopf mit Gabel (dreht), schwebende Kugel
      kOct(b, P.base, 0.62, 0.7, 0.14, 0, 0.06, 0); kBand(b, T.team, 0.71, 0.12, 0.06, 0, 0, 8);
      b.cylB(P.base2, 0.36, 0.1, 8, 0, 0.2, 0, 0.012);
      for (i = 0; i < 3; i++) { a = -Math.PI / 4 + i * Math.PI * 2 / 3; strut(b, P.shell2, Math.cos(a) * 0.5, 0.2, Math.sin(a) * 0.5, Math.cos(a) * 0.1, 0.8, Math.sin(a) * 0.1, 0.045); b.box(T.team, 0.14, 0.12, 0.14, Math.cos(a) * 0.5, 0.2, Math.sin(a) * 0.5, -a); }
      b.cyl(P.shell, 0.07, 0.15, 0.86, 8, 0, 0.2, 0).cylB(T.team, 0.12, 0.08, 8, 0, 0.7, 0, 0.01);
      var hd = new MB();
      kTor(hd, T.team, 0.34, 0.05, 0, 1.12, 0, 5, 18); hd.cylB(P.base, 0.13, 0.12, 8, 0, 1.04, 0, 0.012);
      hd.box(P.shell, 0.42, 0.06, 0.06, 0.26, 1.1, 0.09).box(P.shell, 0.42, 0.06, 0.06, 0.26, 1.1, -0.09).box(P.shell2, 0.1, 0.1, 0.26, 0.06, 1.08, 0);
      hd.ico(P.glow, 0.05, 0.48, 1.13, 0.09, 1, 1, 1, 0).ico(P.glow, 0.05, 0.48, 1.13, -0.09, 1, 1, 1, 0);
      M.parts.head = hd.geo();
      g.ico(P.glow, 0.15, 0, 1.52, 0, 1, 1.3, 1, 1);
      M.muzzle = [0.45, 0.3]; M.recoil = 0; M.h = 1.6;
    } else if (type === 'turret') {                         // Strahlkanone: Achteck-Sockel, Kapsel-Kopf, langes Emitterrohr
      kOct(b, P.base, 0.38, 0.44, 0.14, 0, 0.04, 0); kBand(b, T.team, 0.45, 0.14, 0.05, 0, 0, 8);
      b.cylB(P.base2, 0.3, 0.06, 8, 0, 0.18, 0, 0.01);
      var th = new MB(), tb = new MB();
      th.sph(P.shell, 0.2, -0.02, 0.34, 0, 1.25, 0.6, 1.05, 12).box(T.team, 0.24, 0.03, 0.08, -0.06, 0.44, 0).box(P.dark, 0.1, 0.12, 0.2, 0.14, 0.28, 0);
      th.add(new THREE.ConeGeometry(0.05, 0.14, 4), T.team, -0.24, 0.42, 0, 0, 0, Math.PI / 2 + 0.6);
      tb.cylX(P.shell2, 0.035, 0.045, 0.5, 8, 0.42, 0.34, 0).cylX(T.team, 0.052, 0.052, 0.04, 8, 0.3, 0.34, 0).cylX(P.base, 0.05, 0.05, 0.04, 8, 0.55, 0.34, 0);
      tb.cylX(P.glow, 0.03, 0.03, 0.04, 8, 0.69, 0.34, 0);
      M.parts.head = th.geo(); M.parts.barrel = tb.geo(); M.muzzle = [0.72, 0.34]; M.recoil = 0.1; M.h = 0.62; M.lit = false;
    } else if (type === 'mg') {                             // Gatling-Stand: Ringwall mit Zinnen, Drehkopf mit Dreifachrohr
      kOct(b, P.base, 0.4, 0.44, 0.1, 0, 0.04, 0);
      for (i = 0; i < 8; i++) { a = i * Math.PI / 4 + Math.PI / 8; if (Math.cos(a) > 0.85) continue; b.box(i % 2 ? T.team : P.shell2, 0.16, 0.14, 0.08, Math.cos(a) * 0.36, 0.14, Math.sin(a) * 0.36, -a + Math.PI / 2); }
      var mh = new MB();
      mh.cyl(P.dark, 0.03, 0.06, 0.18, 6, 0, 0.06, 0).sph(P.shell, 0.09, 0, 0.26, 0, 1.2, 0.75, 1, 10).box(T.team, 0.06, 0.12, 0.2, -0.06, 0.2, 0);
      for (i = 0; i < 3; i++) mh.cylX(P.dark, 0.016, 0.016, 0.26, 6, 0.22, 0.28 + Math.cos(i * 2.09) * 0.025, Math.sin(i * 2.09) * 0.025);
      mh.cylX(P.shell2, 0.045, 0.045, 0.04, 8, 0.14, 0.28, 0).cylX(P.shell2, 0.04, 0.04, 0.03, 8, 0.34, 0.28, 0);
      M.parts.head = mh.geo(); M.muzzle = [0.37, 0.28]; M.recoil = 0.02; M.h = 0.42; M.lit = false;
    } else if (type === 'flak') {                           // Abwehrspule: Sockel, Joch (dreht), Doppelspule (hebt sich)
      kOct(b, P.base, 0.4, 0.44, 0.12, 0, 0.0, 0); kBand(b, T.team, 0.45, 0.1, 0.04, 0, 0, 8);
      b.cylB(P.base2, 0.3, 0.03, 8, 0, 0.12, 0, 0.006);
      if (hi) for (i = 0; i < 3; i++) { a = i * 2.09 + 0.5; b.box(P.shell2, 0.1, 0.08, 0.12, Math.cos(a) * 0.32, 0.12, Math.sin(a) * 0.32, -a); }
      var fh = new MB(), fb = new MB(), tr = 0.34;
      fh.cylB(P.shell2, 0.18, 0.06, 10, 0, 0.15, 0, 0.012).box(P.shell, 0.14, 0.2, 0.04, 0, 0.2, 0.1).box(P.shell, 0.14, 0.2, 0.04, 0, 0.2, -0.1).pbox(T.team, 0.15, 0.03, 0.22, 0, 0.36, 0);
      fb.box(P.base, 0.14, 0.08, 0.13, 0, tr - 0.04, 0);
      for (sd = -1; sd <= 1; sd += 2) {
        fb.cylX(P.base2, 0.026, 0.022, 0.44, 8, 0.24, tr, sd * 0.045);
        for (i = 0; i < 3; i++) fb.cylX(i === 1 ? T.team : P.shell2, 0.042, 0.042, 0.03, 8, 0.14 + i * 0.1, tr, sd * 0.045);
        fb.cylX(P.glow, 0.02, 0.02, 0.03, 6, 0.47, tr, sd * 0.045);
      }
      M.parts.head = fh.geo(); M.parts.barrel = fb.geo(); M.trun = [0, tr]; M.recoil = 0.04; M.flakL = 0.5;
      M.muzzle = [Math.cos(0.9) * M.flakL, tr + Math.sin(0.9) * M.flakL]; M.v8b = 'flak'; M.h = 0.62; M.lit = false;
    } else if (type === 'pbunker') {                        // Psi-Bunker: Achteckwall mit Scharten, flache Kuppel, Teamband
      kOct(b, P.base, 0.84, 0.9, 0.42, 0, 0.06, 0); kBand(b, T.team, 0.87, 0.36, 0.06, 0, 0, 8);
      b.dome(P.shell, 0.78, 0, 0.48, 0, 1, 0.42, 1, 14); kTor(b, P.shell2, 0.3, 0.03, 0, 0.48 + 0.78 * 0.42 * 0.92, 0, 4, 12);
      M.win = [];
      for (i = 0; i < 3; i++) { x = -0.5 + i * 0.5; b.pbox(P.dark, 0.3, 0.09, 0.04, x, 0.28, 0.8); g.pbox(P.glow, 0.24, 0.045, 0.012, x, 0.3, 0.822); M.win.push([x, 0.36, 0.86]); }
      for (sd = -1; sd <= 1; sd += 2) { b.pbox(P.dark, 0.04, 0.09, 0.3, sd * 0.8, 0.28, 0.1); g.pbox(P.glow, 0.012, 0.045, 0.24, sd * 0.822, 0.3, 0.1); M.win.push([sd * 0.86, 0.36, 0.1]); }
      b.pbox(P.dark, 0.3, 0.09, 0.04, -0.3, 0.28, -0.8); M.win.push([-0.3, 0.36, -0.86]);
      b.box(P.dark, 0.26, 0.26, 0.06, 0.4, 0.06, -0.8);
      b.cyl(P.metal, 0.012, 0.014, 0.5, 4, 0.55, 0.7, -0.35).pbox(T.team, 0.14, 0.09, 0.012, 0.62, 1.1, -0.35);
      M.v5 = 'pbunker'; M.h = 0.85; M.lit = false;
    } else if (type === 'airfield') {                       // Diskus-Hangar: vier runde Landeplätze, Gewölbehangar hinten, Leitturm mit Linsenkanzel
      b.box(P.base2, w - 0.3, 0.012, 1.7, 0, 0.06, 0.38);
      for (i = 0; i < 4; i++) {
        x = -w / 2 + (i + 0.5) * w / 4; z = h * 0.55 - h / 2;
        kOct(b, P.base, 0.44, 0.46, 0.03, x, 0.06, z, 1, 1, 16); kBand(b, T.team, 0.465, 0.06, 0.03, x, z, 16);
        kDisc(b, P.plate, 0.0, 0.3, x, 0.091, z, 16); kDisc(b, P.shell, 0.3, 0.37, x, 0.0915, z, 16); kDisc(b, T.team, 0.0, 0.08, x, 0.092, z, 8);
        for (a = 0; a < 6; a++) g.pbox(P.glow, 0.035, 0.02, 0.035, x + Math.cos(a * 1.047) * 0.4, 0.09, z + Math.sin(a * 1.047) * 0.4);
      }
      b.top(T.teamL, -w / 2 + 0.25, 0.85, w / 2 - 0.25, 0.85, 0.0735, 0.035);
      b.box(P.base, 1.8, 0.24, 0.84, 0.95, 0.06, -1.02);
      kVault(b, P.shell, 0.42, 1.78, 0.95, 0.3, -1.02, false, hi ? 14 : 10);
      b.box(P.dark, 1.2, 0.5, 0.04, 0.95, 0.06, -0.6).pbox(T.team, 1.8, 0.05, 0.03, 0.95, 0.3, -0.6);
      g.pbox(P.glow, 1.16, 0.03, 0.02, 0.95, 0.53, -0.585);
      // Leitturm (West, hinten)
      kOct(b, P.base, 0.26, 0.3, 0.2, -1.5, 0.06, -1.05); b.cyl(P.shell2, 0.08, 0.12, 0.62, 8, -1.5, 0.26, -1.05);
      b.sph(P.glass, 0.24, -1.5, 0.94, -1.05, 1, 0.45, 1, 12); kTor(b, T.team, 0.24, 0.03, -1.5, 0.94, -1.05, 4, 14);
      b.cylB(P.shell, 0.12, 0.06, 8, -1.5, 1.02, -1.05, 0.01);
      var rd = new MB(); kTor(rd, P.shell2, 0.12, 0.018, 0, 0.05, 0, 4, 12); rd.pbox(P.glow, 0.26, 0.02, 0.03, 0, 0.05, 0).cyl(P.dark, 0.02, 0.02, 0.06, 4, 0, 0, 0);
      M.parts.radar = rd.geo(); M.radarAt = [-1.5, 1.08, -1.05];
      if (hi) { for (i = 0; i < 2; i++) b.sph(P.shell2, 0.14, -0.7 + i * 0.32, 0.2, -1.2, 1, 1, 1, 10); kSpire(b, g, 1.9, -1.35, 0.06, 0.6, 0.04); }
      M.h = 1.05; M.act = { k: 'air', cells: [-1.6, 1.38, -0.4, 1.38, 0.062] };
    } else if (type === 'shipyard') {                       // U-Boot-Werft: Kaje auf Pfählen, U-Boot-Rumpf in der Helling, Bunkergewölbe, Bogenkran
      for (sd = -1; sd <= 1; sd += 2) {
        for (i = 0; i < 4; i++) for (var j = 0; j < 2; j++) b.cyl(P.conc, 0.05, 0.06, 0.5, 6, sd * (0.6 + j * 0.8), -0.45, -1.3 + i * 0.86);
        b.box(P.base, 1.02, 0.12, 3.0, sd * 1.0, -0.02, 0).box(P.edge, 1.04, 0.03, 3.02, sd * 1.0, 0.07, 0);
        b.pbox(T.team, 0.05, 0.014, 2.4, sd * 0.52, 0.1, 0.3);
      }
      b.box(P.base, 1.0, 0.12, 0.62, 0, -0.02, -1.19).box(P.edge, 1.0, 0.03, 0.64, 0, 0.07, -1.19);
      b.box('#3e3a50', 0.98, 0.03, 2.42, 0, -0.03, 0.3);
      b.sph(P.base2, 0.2, 0, 0.06, 0.3, 0.9, 0.55, 3.0, 12).box(P.shell2, 0.16, 0.12, 0.3, 0, 0.12, 0.1).pbox(T.team, 0.17, 0.03, 0.31, 0, 0.24, 0.1);
      // Bunkergewölbe über dem hinteren Becken (Ost) + Werkhalle
      b.box(P.base, 0.92, 0.3, 1.0, 1.0, 0.1, -0.92);
      kVault(b, P.shell, 0.46, 1.0, 1.0, 0.4, -0.92, true, 12);
      b.box(P.dark, 0.5, 0.3, 0.02, 1.0, 0.1, -0.41).pbox(T.team, 0.94, 0.04, 0.03, 1.0, 0.4, -0.41);
      g.pbox(P.glow, 0.46, 0.025, 0.02, 1.0, 0.38, -0.395);
      for (i = 0; i < 2; i++) { b.cyl(P.metal, 0.012, 0.014, 0.5, 4, -1.45, 0.1, -1.2 + i * 2.4); g.ico(P.glow, 0.04, -1.45, 0.62, -1.2 + i * 2.4, 1, 1, 1, 0); }
      if (hi) { b.sph(P.shell2, 0.16, -1.1, 0.26, 0.4, 1, 1, 1, 10).sph(P.shell, 0.13, -1.12, 0.23, 0.82, 1, 1, 1, 10); kSpire(b, g, 1.4, 1.3, 0.1, 0.6, 0.04); }
      var gc = new MB(), gk = new MB();
      for (sd = -1; sd <= 1; sd += 2) gc.box(P.shell2, 0.1, 0.9, 0.12, sd * 0.66, 0.1, 0.25).box(P.base, 0.18, 0.08, 0.2, sd * 0.66, 0.1, 0.25);
      gc.add(new THREE.TorusGeometry(0.66, 0.06, 5, 14, Math.PI), P.shell, 0, 0.98, 0.25).pbox(T.team, 1.2, 0.04, 0.13, 0, 1.0, 0.25);
      gk.box(P.base, 0.18, 0.1, 0.22, 0, 1.0, 0.25).cyl(P.glow, 0.008, 0.008, 0.55, 4, 0, 0.45, 0.25).box(P.shell2, 0.08, 0.05, 0.08, 0, 0.4, 0.25);
      M.parts.gantry = gc.geo(); M.parts.trolley = gk.geo(); M.v8b = 'shipyard';
      M.h = 1.25; M.act = { k: 'naval', cells: [-1.35, -0.6, -1.35, 0.6, 0.105] };
    }
    M.parts.body = b.geo();
    if (g.list.length) M.parts.glow = g.geo(false); else M.lit = false;
    return M;
  }

  // ================================================================== GA: Gebäude zeigen, was sie tun (alle Fraktionen) – LIEST nur den Sim-Zustand
  // Quellen: Produktion = P.q[cat][0].prog am ERSTEN Produzenten des Typs (wie G.Sim.producerOf), Bauhof = erster nicht fertiger Eintrag aus
  // P.q.building/P.q.defense (fertige warten auf Platzierung); „arbeitet“ = Fortschritt ist in den letzten 0,35 s (Effektzeit) gestiegen
  // (steht bei fehlenden Credits); fertig/ausgeliefert = Fortschritt fällt von ≥ 0,97 ab. Andocken = Sammler mit hs 'unload' und refId.
  // Strom: P.pwrUse / P.pwrProd (Auslastung), G.Sim.lowPower (Mangel → flackernde Fenster an allen Gebäuden). Landeplätze: Luftfahrzeuge mit home/pad.
  // Alles aus Zustand + R.t (Effektzeit, steht bei Pause) – Partikel nur über R3F, ohne Allokation je Frame.
  // Teile: pcell (Fortschrittslampen am Boden vor dem Ausgang), door2/dlit (Rolltor bzw. Schiebetür + Licht dahinter), crmast/crjib (Baukran
  // Koalition/Syndikat), dlamp (Andocklampen), padlit (Ring auf dem Ziel-Landeplatz); Kollektiv: kboom/kbeam/kholo, kring, kfill/kdoor, karm,
  // kbelt/kdock, kspin (siehe GB). Plätze je Modell in M.act (nach der Spiegelung, Modellkoordinaten).
  var actFrame = 0, actProd = null, actInit = false;
  var PCAT = { barracks: 'infantry', factory: 'vehicle', airfield: 'air', shipyard: 'naval', hq: 'building' };
  var PCI = { infantry: 0, vehicle: 1, air: 2, naval: 3, building: 4 };
  var aProg = 0, aAct = false, aReady = false, aType = null, aSt = null;
  var CRANE_C = '#d97706';
  /** Zusatzteile für die gemeinsamen Modelle (Koalition/Syndikat; nach mirrorModel, d. h. Fronten Süd + West). */
  function actAttach(M, type, fac) {
    if (M.act !== undefined) return M;
    M.act = null; M.xparts = M.xparts || {};
    var P = PAL[fac] || PAL.coalition, syn = fac === 'syndicate', m, i;
    if (type === 'factory') {
      M.act = { k: 'factory', cells: [-0.75, 1.42, 0.35, 1.42, 0.062], veh: [-0.2, 0, 0.2, 1.55], door: { x: -0.2, y: 0.08, z: 0.85, w: 0.98, h: 0.46, f: 's', roll: 1 } };
    } else if (type === 'barracks') {
      M.act = { k: 'barracks', cells: [-0.78, 0.94, -0.18, 0.94, 0.062], door: syn ? { x: -0.835, y: 0.07, z: -0.1, w: 0.38, h: 0.32, f: 'w' } : { x: 0, y: 0.065, z: 0.535, w: 0.3, h: 0.28, f: 's' } };
    } else if (type === 'hq') {
      M.act = { k: 'hq', cells: [-0.95, 1.43, 0.05, 1.43, 0.062], crane: [-1.3, -1.3, 1.72, Math.PI / 4] };
      var cm = new MB(), cj = new MB(), H = 1.72;
      cm.box(P.dark, 0.3, 0.08, 0.3, 0, 0.06, 0);
      for (i = 0; i < 4; i++) cm.pbox(CRANE_C, 0.025, H - 0.12, 0.025, (i & 1 ? 1 : -1) * 0.055, 0.12, (i & 2 ? 1 : -1) * 0.055);
      for (i = 0; i < 6; i++) cm.pbox(CRANE_C, 0.13, 0.02, 0.13, 0, 0.3 + i * 0.24, 0);
      cm.box(P.dark, 0.16, 0.12, 0.16, 0, H - 0.02, 0);
      cj.box(CRANE_C, 1.35, 0.07, 0.08, 0.5, H + 0.1, 0).box(CRANE_C, 0.42, 0.06, 0.08, -0.36, H + 0.1, 0).box(P.dark, 0.16, 0.14, 0.14, -0.52, H + 0.02, 0);
      cj.pbox(CRANE_C, 0.05, 0.3, 0.05, 0, H + 0.1, 0).box(P.body2, 0.14, 0.1, 0.12, 0.05, H - 0.02, 0.0);
      cj.cyl(P.dark, 0.006, 0.006, H - 0.75, 4, 0.95, 0.8, 0).box('#ffffff', 0.1, 0.07, 0.08, 0.95, 0.73, 0);
      // Teamfarbe am Ausleger (für die Lesbarkeit der Besitzer)
      var T = M.T0; if (T) cj.pbox(T.team, 1.3, 0.025, 0.085, 0.5, H + 0.17, 0);
      var gm = cm.geo(), gj = cj.geo();
      gm.translate(-1.3, 0, -1.3); gj.rotateY(-Math.PI / 4); gj.translate(-1.3, 0, -1.3);
      M.parts.crmast = gm; M.parts.crjib = gj;
    } else if (type === 'refinery') {
      M.act = { k: 'refinery', dock: [[-0.6, 0.09, 0.66], [0.6, 0.09, 0.66], [-0.38, 0.09, -0.86], [0.38, 0.09, -0.86]], flare: [-1.2, 1.36, -0.62] };
    } else if (type === 'airfield') {
      M.act = { k: 'air', cells: [-1.6, 1.12, -0.4, 1.12, 0.062] };
    } else if (type === 'shipyard') {
      M.act = { k: 'naval', cells: [-0.62, -0.5, -0.62, 0.7, 0.105] };
    } else if (type === 'power') {
      M.act = { k: 'power' };
    }
    if (M.act && M.act.door) {
      var d = M.act.door, dd = new MB(), dl = new MB();
      if (d.f === 's') {
        dd.box(P.body2, d.w, d.h, 0.02, 0, 0, 0);
        if (d.roll) { for (i = 1; i < 6; i++) dd.pbox(P.dark, d.w - 0.04, 0.008, 0.024, 0, i * d.h / 6, 0); dd.pbox('#fbbf24', d.w, 0.04, 0.026, 0, 0, 0); }
        else dd.pbox(P.dark, 0.02, d.h * 0.4, 0.026, d.w * 0.32, d.h * 0.35, 0);
        dl.pbox('#ffffff', d.w - 0.02, d.h - 0.02, 0.01, 0, 0, -0.008);
      } else {
        dd.box(P.body2, 0.02, d.h, d.w, 0, 0, 0).pbox(P.dark, 0.026, d.h * 0.4, 0.02, 0, d.h * 0.35, d.w * 0.32);
        dl.pbox('#ffffff', 0.01, d.h - 0.02, d.w - 0.02, 0.008, 0, 0);
      }
      M.xparts.door2 = dd.geo(false); M.xparts.dlit = dl.geo(false);
    }
    return M;
  }
  /** Gemeinsame Anzeige-Geometrien (Lampen, Ring) – je Modell einmal. */
  function actGeo(M) {
    var m;
    if (M.act && M.act.cells && !M.xparts.pcell) { m = new MB(); m.flat = true; m.pbox('#ffffff', 0.15, 0.03, 0.1, 0, 0, 0); M.xparts.pcell = m.geo(false); }
    if (M.act && M.act.k === 'air' && !M.xparts.padlit) { m = new MB(); m.flat = true; m.add(new THREE.RingGeometry(0.3, 0.45, 18), '#ffffff', 0, 0, 0, 0, -Math.PI / 2, 0); M.xparts.padlit = m.geo(false); }
    if (M.act && M.act.dock && !M.xparts.dlamp) { m = new MB(); m.flat = true; m.pbox('#ffffff', 0.09, 0.05, 0.09, 0, 0, 0); M.xparts.dlamp = m.geo(false); }
  }

  /** Je Frame vor den Gebäuden: Produzenten je Spieler/Kategorie, angedockte Sammler, belegte Landeplätze. */
  function actPre(S) {
    if (!actInit) {
      actInit = true;
      GLOW_PARTS.pcell = 1; GLOW_PARTS.dlit = 1; GLOW_PARTS.padlit = 1; GLOW_PARTS.dlamp = 1;
      GLOW_PARTS.kholo = 1; GLOW_PARTS.kbeam = 1; GLOW_PARTS.kfill = 1; GLOW_PARTS.kdoor = 1; GLOW_PARTS.kbelt = 1; GLOW_PARTS.kdock = 1;
    }
    actFrame++;
    var np = S.players.length, ents = S.ents, i, e, c, k, st;
    if (!actProd || actProd.length < np * 5) actProd = new Int32Array(Math.max(8, np) * 5);
    actProd.fill(0);
    for (i = 0; i < ents.length; i++) {
      e = ents[i];
      if (e.dead) continue;
      if (e.kind === 'building') {
        c = PCAT[e.type];
        if (c && e.owner >= 0 && e.owner < np) { k = e.owner * 5 + PCI[c]; if (!actProd[k]) actProd[k] = e.id; }
      } else if (e.hs === 'unload' && e.refId) { st = nst(e.refId); st.dockF = actFrame; st.dockS = e.y; }
      else if (e.mc === 2 && e.home && e.pad >= 0) { st = nst(e.home); if (st.padF !== actFrame) { st.padF = actFrame; st.padM = 0; } st.padM |= 1 << e.pad; }
    }
  }
  /** Produktionszustand des Gebäudes b → aProg/aAct/aReady/aType (+ Merker st.outT beim Ausliefern). false = produziert nichts. */
  function prodState(b, P, st) {
    var cat = PCAT[b.type], it = null, q, i;
    aProg = 0; aAct = false; aReady = false; aType = null;
    if (!cat || actProd[b.owner * 5 + PCI[cat]] !== b.id) { st.lp = 0; return false; }
    if (cat === 'building') {
      for (q = 0; q < 2 && !it; q++) { var bq = q ? P.q.defense : P.q.building; if (!bq) continue; for (i = 0; i < bq.length; i++) { if (!bq[i].ready) { it = bq[i]; break; } aReady = true; } }
      if (!it && !aReady) { if ((st.lp || 0) >= 0.97) st.outT = R.t; st.lp = 0; return false; }
    } else { q = P.q[cat]; it = q && q.length ? q[0] : null; }
    var p = it ? it.prog : 0, lp = st.lp || 0;
    if (lp >= 0.97 && (!it || p < lp - 0.3)) { st.outT = R.t; st.outTy = st.lty; }
    if (it && p > lp + 1e-7) st.lpT = R.t;
    st.lp = p; st.lty = it ? it.type : null;
    aProg = p; aType = it ? it.type : null; aAct = !!it && R.t - (st.lpT || -9) < 0.35;
    return !!it || aReady;
  }
  var NOSHADOW = { pcell: 1, dlit: 1, padlit: 1, dlamp: 1, kholo: 1, kbeam: 1, kfill: 1, kdoor: 1, kbelt: 1, kdock: 1 };
  /** partBatch für Anzeige-Teile: ohne Schattenwurf (spart den Schatten-Durchgang je Teil). */
  function apb(b, owner, part, M) {
    var bt = partBatch('b', b.type, owner, part, M);
    if (bt.shadow && NOSHADOW[part]) { bt.shadow = false; bt.mesh.castShadow = false; }
    return bt;
  }
  function flick(id) { var t = R.t; return (Math.sin(t * 11.3 + id * 1.7) * Math.sin(t * 4.1 + id * 0.37) > 0.25) ? 0.7 : 0.1; }
  /** Helligkeit der Leuchtteile (glow/wlit) eines Gebäudes: erinnert grau, Strommangel flackert, Kraftwerk nach Auslastung, Produzent heller. */
  function litGain(b, M, owner, cr) {
    if (cr === GREY) return 0.3;
    if (b.offT > G.Sim.S.tick) return 0.08 + (Math.sin(R.t * 13 + b.id) > 0.8 ? 0.5 : 0);   // v1.2 lahmgelegt: Lichter aus, kurzes Zucken
    var P = G.Sim.S.players[owner], st;
    if (P.pwrUse > P.pwrProd) return flick(b.id) * (b.type === 'power' ? 0.5 : 1);
    if (b.type === 'power') { var ld = P.pwrProd > 0 ? Math.min(1.25, P.pwrUse / P.pwrProd) : 0; return 1.0 + 0.6 * ld + 0.18 * ld * Math.sin(R.t * (2 + 3 * ld) + b.id); }
    st = nrs.get(b.id);
    if (st && st.actOn) return 1.12 + 0.18 * Math.sin(R.t * 4 + b.id);
    if (st && st.dockF === actFrame) return 1.3 + 0.3 * Math.sin(R.t * 7);
    return 1;
  }
  /** Rotation eines in Ruhestellung modellierten Teils um die senkrechte Achse durch (px, pz) (Modellkoordinaten). */
  function putRot(bt, x, y, z, px, pz, ang, sy, r, g, bb) {
    var c = Math.cos(-ang), s = Math.sin(-ang);
    bt.put(x + px - (c * px + s * pz), y, z + pz - (-s * px + c * pz), ang, 1, sy, 1, r, g, bb);
  }
  /** Einheit (Modell) als „im Bau“ zeichnen: Rumpf, Turm, Rohr, Kleinteile – k = Helligkeit, sy = Höhe (wächst). */
  function ghostUnit(type, P, owner, x, y, z, dir, k, sy) {
    if (!type) return;
    var Mu = model(type, P.faction, P.color), s = SCALE[type] || 1, cd = Math.cos(dir), sd = Math.sin(dir), i;
    if (!Mu || !Mu.parts || !Mu.parts.hull) return;
    partBatch('u', type, owner, 'hull', Mu).put(x, y, z, dir, s, s * sy, s, k, k, k);
    if (Mu.parts.glow && !Mu.v8u) partBatch('u', type, owner, 'glow', Mu).put(x, y, z, dir, s, s * sy, s, k, k, k);
    if (Mu.v8u) return;
    var pv = Mu.pivot || [0, 0], pxp = x + (cd * pv[0] - sd * pv[1]) * s, pzp = z + (sd * pv[0] + cd * pv[1]) * s;
    if (Mu.parts.turret) partBatch('u', type, owner, 'turret', Mu).put(pxp, y, pzp, dir, s, s * sy, s, k, k, k);
    if (Mu.parts.barrel && !Mu.how) partBatch('u', type, owner, 'barrel', Mu).put(pxp, y, pzp, dir, s, s * sy, s, k, k, k);
    if (Mu.parts.barrel2) partBatch('u', type, owner, 'barrel2', Mu).put(pxp, y, pzp, dir, s, s * sy, s, k, k, k);
    if (Mu.xp) for (i = 0; i < Mu.xp.length; i++) {
      var xe = Mu.xp[i]; if (!Mu.xparts[xe.p] || (xe.k !== 'wheel' && xe.k !== 'trk' && xe.k)) continue;
      partBatch('u', type, owner, xe.p, Mu).put(x + (cd * xe.x - sd * xe.z) * s, y + xe.y * s * sy, z + (sd * xe.x + cd * xe.z) * s, dir, s, s * sy, s, k, k, k);
    }
  }
  function cellsDraw(b, M, owner, x, z, rgb, prog, act, ready) {
    var c = M.act.cells, bt = apb(b, owner, 'pcell', M), n = 6, i, f, lk, ang = Math.atan2(c[3] - c[1], c[2] - c[0]), t = R.t;
    for (i = 0; i < n; i++) {
      f = (i + 0.5) / n;
      if (ready) lk = 0.9 + 0.7 * (0.5 + 0.5 * Math.sin(t * 6 - i * 0.9));
      else { var lit = clamp(prog * n - i, 0, 1); lk = 0.12 + 1.5 * lit; if (act && lit > 0 && lit < 1) lk = 0.5 + 1.2 * (0.5 + 0.5 * Math.sin(t * 9)); }
      bt.put(x + c[0] + (c[2] - c[0]) * f, c[4], z + c[1] + (c[3] - c[1]) * f, ang, 1, 1, 1, rgb[0] * lk + 0.05 * lk, rgb[1] * lk + 0.05 * lk, rgb[2] * lk + 0.05 * lk);
    }
  }
  function doorDraw(b, M, owner, x, z, open, light) {
    var d = M.act.door, bt = partBatch('b', b.type, owner, 'door2', M), lb = apb(b, owner, 'dlit', M);
    if (d.roll) { var sh = Math.max(0.04, 1 - open); bt.put(x + d.x, d.y + d.h * (1 - sh), z + d.z, 0, 1, sh, 1, 1, 1, 1); }
    else if (d.f === 's') bt.put(x + d.x + open * d.w * 0.95, d.y, z + d.z, 0, 1, 1, 1, 1, 1, 1);
    else bt.put(x + d.x, d.y, z + d.z + open * d.w * 0.95, 0, 1, 1, 1, 1, 1, 1);
    if (light > 0.02) lb.put(x + d.x, d.y + 0.01, z + d.z, 0, 1, 1, 1, 1.25 * light, 0.95 * light, 0.62 * light);
  }

  var FX_LOW = 1;   // Partikel-Faktor (Spar-/Schonmodus kleiner)
  /** Bewegliche Teile in Ruhestellung (Gebäude im Aufbau: wachsen mit sy mit). */
  function restDraw(b, M, owner, x, z, sy) {
    var p = M.parts;
    if (p.kboom) partBatch('b', b.type, owner, 'kboom', M).put(x, 0, z, 0, 1, sy, 1, 1, 1, 1);
    if (p.karm) { var ab = partBatch('b', b.type, owner, 'karm', M); ab.put(x - 0.42, 0, z, 0, 1, sy, 1, 1, 1, 1); ab.put(x + 0.42, 0, z, 0, 1, sy, 1, 1, 1, 1); }
    if (p.crmast) { partBatch('b', b.type, owner, 'crmast', M).put(x, 0, z, 0, 1, sy, 1, 1, 1, 1); partBatch('b', b.type, owner, 'crjib', M).put(x, 0, z, 0, 1, sy, 1, 1, 1, 1); }
    if (p.kring) partBatch('b', b.type, owner, 'kring', M).put(x, 0, z, 0, 1, sy, 1, 1, 1, 1);
    if (p.kspin) partBatch('b', b.type, owner, 'kspin', M).put(x, 0, z, 0, 1, sy, 1, 1, 1, 1);
    if (M.b12) rest12(b, M, owner, x, z, sy, 1, 1, 1);   // v1.2
  }
  /** Aktivität eines lebenden, sichtbaren Gebäudes (nach drawBuildingInst). sy < 1 = noch im Aufbau → nur Grundzustand. */
  function actDraw(b, M, x, z, sy, inV, dt) {
    var S = G.Sim.S, owner = b.owner, P = S.players[owner], st = nst(b.id), A = M.act, t = R.t, i, k, f, open;
    if (!A || !P) return;
    actGeo(M);
    FX_LOW = (R.safeGPU || (R.Q && R.Q.mode === 'low')) ? 0.4 : 1;
    var rgb = teamRGB(P.color), low = P.pwrUse > P.pwrProd, built = sy >= 0.999;
    if (!built) { restDraw(b, M, owner, x, z, sy); st.lp = 0; return; }   // im Aufbau: bewegliche Teile in Ruhestellung, mitwachsend
    if (M.b12) { act12(b, M, A, x, z, inV, dt, st, P, owner, low); return; }   // v1.2 Reparaturdock / Erzsilo
    var has = prodState(b, P, st);
    st.actOn = has && aAct;
    var since = t - (st.outT == null ? -99 : st.outT);
    if (A.cells && has && !low) cellsDraw(b, M, owner, x, z, rgb, aProg, aAct, aReady && !aType);
    else if (A.cells && has) cellsDraw(b, M, owner, x, z, rgb, aProg * flick(b.id + 3), false, false);
    switch (A.k) {
      case 'factory': {
        var vp = A.veh, vt = aType || st.outTy;
        if (A.open) {                                        // Kollektiv: offene Montagebucht unter dem Portal
          var ab = partBatch('b', b.type, owner, 'karm', M), sw = has && aAct ? Math.sin(t * 2.2) : 0, ar = 0.42 + 0.08 * Math.sin(t * 0.4);
          ab.put(x - ar - 0.12 * sw, 0, z, 0, 1, 1, 1, 1, 1, 1); ab.put(x + ar + 0.12 * Math.sin(t * 2.2 + 1.3) * (has && aAct ? 1 : 0), 0, z, 0, 1, 1, 1, 1, 1, 1);
          if (has && aType) {
            var gp = clamp(aProg / 0.88, 0, 1), roll = clamp((aProg - 0.88) / 0.12, 0, 1);
            ghostUnit(aType, P, owner, x + vp[0], vp[1], z + vp[2] + (vp[3] - vp[2]) * smooth(roll), Math.PI / 2, 0.35 + 0.65 * gp, 0.15 + 0.85 * smooth(gp));
            if (aAct && inV && aProg < 0.88 && rnd() < dt * 7 * FX_LOW) {
              var sx = x + (rnd() < 0.5 ? -1 : 1) * (ar - 0.05), sz = z + 0.55;
              for (k = 0; k < 3; k++) G.R3F.bSpark ? G.R3F.bSpark(sx, 0.38, sz, (rnd() - 0.5) * 0.9, 0.3 + rnd() * 0.8, (rnd() - 0.5) * 0.9) : 0;
            }
          }
        } else {                                             // Halle mit Rolltor: Fahrzeug erscheint im Tor und rollt hinaus
          open = 0;
          if (has && aType && aProg > 0.85) open = smooth((aProg - 0.85) / 0.05);
          if (since < 2.2) open = Math.max(open, 1 - smooth((since - 0.8) / 1.2));
          doorDraw(b, M, owner, x, z, open, has && aAct ? 0.55 + 0.45 * open + 0.15 * Math.sin(t * 13) : open * 0.8);
          if (has && aType && aProg > 0.89) ghostUnit(aType, P, owner, x + vp[0], vp[1], z + vp[2] + (vp[3] - vp[2]) * smooth((aProg - 0.89) / 0.11), Math.PI / 2, 1, 1);
          if (has && aAct && inV && aProg < 0.85 && rnd() < dt * 5 * FX_LOW && G.R3F.bSpark) {
            var dx2 = x + A.door.x + (rnd() - 0.5) * 0.8;
            for (k = 0; k < 3; k++) G.R3F.bSpark(dx2, 0.1, z + A.door.z + 0.02, (rnd() - 0.5) * 0.6, 0.2 + rnd() * 0.6, 0.2 + rnd() * 0.5);
          }
        }
        void vt;
        break;
      }
      case 'barracks': {
        open = 0;
        if (has && aType && aProg > 0.92) open = smooth((aProg - 0.92) / 0.06);
        if (since < 1.8) open = Math.max(open, 1 - smooth((since - 0.6) / 1.0));
        if (A.door) doorDraw(b, M, owner, x, z, open, has && aAct ? 0.45 + 0.6 * open : open * 0.7);
        if (M.kTubes) {                                      // Kollektiv: Klonröhren füllen sich nacheinander, Torfeld öffnet
          var fb = apb(b, owner, 'kfill', M), pg = has ? aProg : 0;
          for (i = 0; i < 3; i++) {
            f = clamp(pg * 3 - i, 0, 1); var tu = M.kTubes[i], fk = low ? 0.3 : (has && aAct && f > 0 && f < 1 ? 1.2 + 0.4 * Math.sin(t * 6 + i) : 0.95);
            if (f > 0.02) fb.put(x + tu[0], tu[1], z + tu[2], 0, 1, f, 1, 0.92 * fk, 0.66 * fk, 1.0 * fk);
            else if (!has) fb.put(x + tu[0], tu[1], z + tu[2], 0, 1, 0.9, 1, 0.42, 0.26, 0.62);   // Ruhe: Nährlösung, gedämpft
          }
          var kd = apb(b, owner, 'kdoor', M), dsh = 1 - open, dk2 = low ? 0.25 : 0.55 + 0.15 * Math.sin(t * 2 + b.id);
          if (dsh > 0.03) kd.put(x + M.kDoor[0], M.kDoor[1], z + M.kDoor[2], 0, dsh, 1, 1, 0.9 * dk2, 0.62 * dk2, 1.0 * dk2);
        }
        break;
      }
      case 'hq': {
        var work = has && aAct;
        if (A.crane) {                                       // Koalition/Syndikat: Baukran schwenkt beim Bauen, ruht sonst
          st.crA = (st.crA || 0) + dt * (work ? 1 : 0.12);
          var ca = work ? 0.75 * Math.sin(st.crA * 0.7 + st.ph) : 0.12 * Math.sin(st.crA * 0.9 + st.ph);
          partBatch('b', b.type, owner, 'crmast', M).put(x, 0, z, 0, 1, 1, 1, 1, 1, 1);
          putRot(partBatch('b', b.type, owner, 'crjib', M), x, 0, z, A.crane[0], A.crane[1], ca, 1, 1, 1, 1);
          if (work && inV && rnd() < dt * 4 * FX_LOW && G.R3F.bSpark) {
            var ha = A.crane[3] - ca, hx2 = x + A.crane[0] + Math.cos(ha) * 0.95, hz2 = z + A.crane[1] + Math.sin(ha) * 0.95;
            for (k = 0; k < 2; k++) G.R3F.bSpark(hx2, 0.72, hz2, (rnd() - 0.5) * 0.6, 0.3 + rnd() * 0.5, (rnd() - 0.5) * 0.6);
          }
        }
        if (M.kPiv) {                                        // Kollektiv: Traktor-Ausleger, Strahl und Hologramm auf der Bauplattform
          st.crA = (st.crA || 0) + dt * (work ? 1 : 0.1);
          var ka = work ? 0.22 * Math.sin(st.crA * 1.3 + st.ph) : 0.06 * Math.sin(st.crA + st.ph);
          putRot(partBatch('b', b.type, owner, 'kboom', M), x, 0, z, M.kPiv[0], M.kPiv[1], ka, 1, 1, 1, 1);
          if (has) {
            var c = Math.cos(-ka), s = Math.sin(-ka), tdx = M.kTip[0] - M.kPiv[0], tdz = M.kTip[2] - M.kPiv[1];
            var tx = x + M.kPiv[0] + c * tdx + s * tdz, tz = z + M.kPiv[1] - s * tdx + c * tdz, pd = M.kPad;
            var hp = aReady && !aType ? 1 : aProg, hk = low ? 0.35 : (aReady && !aType ? 1.0 + 0.4 * Math.sin(t * 5) : 0.85 + 0.25 * Math.sin(t * 8));
            apb(b, owner, 'kholo', M).put(x + pd[0], pd[1], z + pd[2], t * 0.4, 1, Math.max(0.04, hp), 1, 0.85 * hk, 0.6 * hk, 1.0 * hk);
            if (work) {
              var bk = 0.8 + 0.3 * Math.sin(t * 17);
              apb(b, owner, 'kbeam', M).put(tx, pd[1], tz, 0, 1, Math.max(0.1, M.kTip[1] - pd[1]), 1, 0.85 * bk, 0.6 * bk, 1.0 * bk);
              if (inV && rnd() < dt * 6 * FX_LOW) emit(0, x + pd[0] + (rnd() - 0.5) * 0.5, pd[1] + rnd() * 0.5 * hp, z + pd[2] + (rnd() - 0.5) * 0.5, 0, 0.35, 0, 0.6, 0.09, 0.02, 0.9, 0.6, 1.0, 0.9, 0.5, 0.3, 1.0, 0);
            }
          }
          if (since < 0.6 && inV) { if (rnd() < dt * 30) emit(0, x + M.kPad[0] + (rnd() - 0.5) * 0.6, 0.2 + rnd() * 0.5, z + M.kPad[2] + (rnd() - 0.5) * 0.6, 0, 0.6, 0, 0.5, 0.12, 0.02, 1, 0.8, 1, 1, 0.6, 0.4, 1, 0); }
        }
        break;
      }
      case 'refinery': {
        var dock = built && st.dockF === actFrame;
        if (A.dock && dock) {
          var dlb = apb(b, owner, 'dlamp', M), on = dock ? (Math.sin(t * 8) > 0 ? 1.6 : 0.35) : 0.18, north = dock && st.dockS < b.y;
          for (i = 0; i < 4; i++) { var dp = A.dock[i], li = dock && ((i >= 2) === north) ? on : 0.18; dlb.put(x + dp[0], dp[1], z + dp[2], 0, 1, 1, 1, 1.0 * li, 0.62 * li, 0.15 * li); }
          if (dock && inV && rnd() < dt * 10 * FX_LOW) emit(0, x + A.flare[0] + (rnd() - 0.5) * 0.06, A.flare[1], z + A.flare[2] + (rnd() - 0.5) * 0.06, (rnd() - 0.5) * 0.1, 0.7 + rnd() * 0.4, (rnd() - 0.5) * 0.1, 0.45, 0.2, 0.05, 1, 0.75, 0.3, 1, 1, 0.3, 0.05, 0);
        }
        if (M.kBelt && dock) {                               // Kollektiv: Förderstollen laufen, Andocklampen (nur beim Andocken)
          var kb = apb(b, owner, 'kbelt', M), bl = M.kBelt, ph = (st.blt = (st.blt || 0) + dt * (dock ? 0.9 : 0)) % 0.25;
          for (i = 0; i < 4; i++) { f = (ph + i * 0.25) / 1.0; var bk2 = dock ? 1.3 : 0.4; kb.put(x + bl[0] + (bl[3] - bl[0]) * f, bl[1] + (bl[4] - bl[1]) * f, z + bl[2] + (bl[5] - bl[2]) * f, 0, 1, 1, 1, bk2, bk2 * 0.75, bk2 * 0.35); }
          var kdl = apb(b, owner, 'kdock', M), on2 = dock ? (Math.sin(t * 8) > 0 ? 1.5 : 0.4) : 0.2, north2 = dock && st.dockS < b.y;
          for (i = 0; i < 4; i++) { var kp = M.kDockL[i], l2 = dock && ((i >= 2) === north2) ? on2 : 0.2; kdl.put(x + kp[0], kp[1], z + kp[2], 0, 1, 1, 1, 1.0 * l2, 0.65 * l2, 0.2 * l2); }
          if (dock && inV && rnd() < dt * 9 * FX_LOW) emit(0, x + (rnd() - 0.5) * 0.4, 0.62, z + 0.55 + (rnd() - 0.5) * 0.4, 0, 0.5 + rnd() * 0.3, 0, 0.6, 0.07, 0.02, 1, 0.75, 0.3, 1, 1, 0.5, 0.1, 0);
        } else if (!M.kBelt && dock && inV && rnd() < dt * 6 * FX_LOW) {
          var dz = st.dockS < b.y ? -0.86 : 0.66;
          emit(0, x + (rnd() - 0.5) * 0.5, 0.15, z + dz + (rnd() - 0.5) * 0.2, 0, 0.45 + rnd() * 0.3, 0, 0.55, 0.06, 0.02, 1, 0.75, 0.3, 1, 1, 0.5, 0.1, 0);
        }
        break;
      }
      case 'power': {
        var ld = P.pwrProd > 0 ? Math.min(1.3, P.pwrUse / P.pwrProd) : 0;
        if (M.parts.kring) {                                 // Kollektiv: Ringe drehen und schweben nach Auslastung
          st.rgA = (st.rgA || 0) + dt * (low ? 2.6 : 0.25 + 1.4 * ld);
          var bob = 0.03 * Math.sin(t * 1.1 + st.ph);
          partBatch('b', b.type, owner, 'kring', M).put(x, bob * sy, z, st.rgA, 1, sy, 1, 1, 1, 1);
          if (built && inV && rnd() < dt * (1 + 5 * ld) * FX_LOW) { var wa = rnd() * 6.283; emit(0, x + Math.cos(wa) * 0.12, 0.45 + rnd() * 0.5, z + Math.sin(wa) * 0.12, Math.cos(wa) * 0.05, 0.5 + 0.5 * ld, Math.sin(wa) * 0.05, 0.7, 0.08, 0.02, 0.5, 0.95, 1, 0.9, 0.3, 0.6, 1, 0); }
          if (low && inV && rnd() < dt * 2 && G.R3F.bSpark) G.R3F.bSpark(x, 1.1, z, (rnd() - 0.5) * 1.2, 0.5, (rnd() - 0.5) * 1.2);
        }
        break;
      }
      case 'tech': {
        st.actOn = !!(P.res && P.res.cur) && G.Sim.resRunning(owner);   // v1.3 Forschung: Gyroskop dreht schneller, Leuchtteile pulsieren (litGain)
        if (M.parts.kspin) { st.rgA = (st.rgA || 0) + dt * (low ? 0.05 : (st.actOn ? 2.4 : 0.45)); putRot(partBatch('b', b.type, owner, 'kspin', M), x, 0, z, M.kPiv[0], M.kPiv[1], st.rgA, sy, 1, 1, 1); }
        break;
      }
      case 'air': {
        if (has && aType) {
          var free = 0, pm = st.padF === actFrame ? st.padM : 0;
          while (free < 4 && (pm & (1 << free))) free++;
          if (free < 4) {
            var bw = b.w || 4, bh = b.h || 3, px2 = x - bw / 2 + (free + 0.5) * bw / 4, pz2 = z - bh / 2 + bh * 0.55, pk = (0.35 + 1.1 * aProg) * (aAct ? 0.85 + 0.25 * Math.sin(t * 6) : 0.7);
            apb(b, owner, 'padlit', M).put(px2, 0.1, pz2, 0, 1, 1, 1, rgb[0] * pk + 0.1, rgb[1] * pk + 0.1, rgb[2] * pk + 0.1);
            if (aProg > 0.7) ghostUnit(aType, P, owner, px2, 0, pz2, -Math.PI / 2, 0.3 + 0.7 * smooth((aProg - 0.7) / 0.3), 0.3 + 0.7 * smooth((aProg - 0.7) / 0.3));
          }
        }
        break;
      }
      case 'naval': {
        if (has && aType) ghostUnit(aType, P, owner, x, WL8, z + 0.3, Math.PI / 2, 0.3 + 0.7 * aProg, 0.25 + 0.75 * smooth(aProg));
        break;
      }
    }
    if (st.actOn && !st.wasOn && inV && t - (st.pulT || -9) > 4) { st.pulT = t; addPulse(x, z, P.color, Math.max(b.w || 2, b.h || 2) * 0.55, 0.6); }
    st.wasOn = st.actOn;
  }

  /** Schaden: feste Brandstellen je Gebäude (aus der ID), Rauch ab 60 %, Funken ab 40 %, Flammen ab 25 % HP. */
  function dmgFx(b, M, x, z, hf, dt) {
    if (hf >= 0.6) return;
    var w = b.w || 2, h = b.h || 2, q = FX_LOW, k, sx, sz, sy, sev = 1 - hf / 0.6;
    for (k = 0; k < (hf < 0.4 ? 2 : 1); k++) {
      sx = x + (hash(b.id, k, 11) - 0.5) * w * 0.55; sz = z + (hash(b.id, k, 23) - 0.5) * h * 0.55; sy = M.h * (0.45 + 0.4 * hash(b.id, k, 37));
      if (rnd() < dt * (2.5 + 7 * sev) * q) { var gg = hf < 0.3 ? 0.12 : 0.3; F3.puff(sx, sy, sz, 0.08 + rnd() * 0.08, 0.45 + rnd() * 0.3, 0.03, 2.2 + rnd(), 0.22, 0.95 + sev * 0.4, gg, 0.62, hf < 0.25 ? 0.4 : 0); }
      if (hf < 0.25 && rnd() < dt * 9 * q) { if (F3.bFlame) F3.bFlame(sx + (rnd() - 0.5) * 0.12, sy - 0.05, sz + (rnd() - 0.5) * 0.12, 0.32 + rnd() * 0.15); else emit(0, sx, sy, sz, 0, 0.6, 0, 0.4, 0.3, 0.08, 1, 0.6, 0.15, 1, 0.9, 0.2, 0.05, 0); }
      if (hf < 0.4 && k === 1 && rnd() < dt * 1.4 * q && F3.bSpark) { for (var n = 0; n < 4; n++) F3.bSpark(sx, sy, sz, (rnd() - 0.5) * 1.6, 0.6 + rnd() * 1.2, (rnd() - 0.5) * 1.6); }
    }
  }

  function model(type, fac, color) {
    var M;
    if (LOOK12[type]) type = LOOK12[type];   // v1.2 look-Rückfall: Typ ohne eigenes Modell → Modell seines look (siehe lookAlias)
    if (NEUT[type]) { var nk = 'N|' + type + (HI() ? '' : '|lo'); M = modelCache[nk]; if (!M) { curKind = 'bld'; M = modelCache[nk] = mirrorModel(buildNeutral(type)); curKind = 'env'; } return M; }
    var key = type + '|' + fac + '|' + color + (LOD[type] && !HI() ? '|lo' : '');   // W10: Detailstufe (Flag hiPoly/V) im Schlüssel
    if (!modelCache[key] && fac === 'kollektiv' && KB[type]) {   // GB: eigene Kollektiv-Gebäude (nicht gespiegelt, siehe buildKB)
      curKind = 'bld';
      try { modelCache[key] = buildKB(type, color); } finally { curKind = 'env'; }
      modelCache[key].mkey = key;
    }
    if (!modelCache[key] && K10M[type]) {   // v1.0 Kollektiv-Typen (PLATZHALTER v1.0)
      curKind = D.BUILDINGS[type] ? 'bld' : 'unit';
      try { modelCache[key] = D.BUILDINGS[type] ? mirrorModel(buildK10(type, color)) : buildK10(type, color); } finally { curKind = 'env'; }
      modelCache[key].mkey = key;
    }
    if (!PAL[fac]) fac = 'coalition';
    if (!modelCache[key]) {
      var bld = !!(D.BUILDINGS[type] || V4B[type] || V5B[type]);
      curKind = bld ? 'bld' : 'unit';
      try {
        modelCache[key] = bld ? (type === 'wall' ? buildBuilding(type, fac, color) : mirrorModel(buildBuilding(type, fac, color))) : buildUnit(type, fac, color);
        if (bld && type !== 'wall') { modelCache[key].T0 = teamCols(color); actAttach(modelCache[key], type, fac); }   // GA: Aktivitäts-Teile (Tor, Kran, Lampen)
      } finally { curKind = 'env'; }
      modelCache[key].mkey = key;   // Zusammenführung: Batch-Schlüssel je Modell (Fraktion/Farbe), nicht nur je Besitzer – sonst behielt eine neue Partie mit anderer Fraktion die alten Modelle
    }
    return modelCache[key];
  }

  // ------------------------------------------------------------------ W11: Gebäude an x spiegeln (Kamera blickt aus Süd-West)
  // Die Gebäude wurden für die alte Diagonale (YAW = +π/4, Blick aus Süd-OST) gebaut: Fronten, Tore, Fenster, Schilder an Süd- und Ostseite.
  // Seit W11 blickt die Kamera aus Süd-WEST (YAW = −π/4) → jedes Gebäude (außer Mauern) wird beim Erzeugen an der Ebene x = 0 (Mitte der
  // Grundfläche) gespiegelt: Süd bleibt Süd, Ost wird West. Grundfläche, Ausgänge (Mitte Südseite) und Andockpunkte bleiben gleich.
  // Gezielte/drehende Teile (MIR_KEEP) behalten ihre Geometrie (sonst zielten Rohre falsch bzw. kippten Schüsseln nach unten); nur ihre
  // Ankerpunkte werden gespiegelt. Gespiegelte Teile mit Animation um die eigene Achse (Werkstatt-Kran, Ölpumpen-Schwinge) bekommen den
  // Winkel mit M.mirA (= −1) → exakt das Spiegelbild der alten Bewegung. Schiebetore: doorL/doorR werden vertauscht.
  var MIR_KEEP = { head: 1, barrel: 1, hglow: 1, gun: 1, radar: 1, dish: 1, msl: 1, mslf: 1 };
  function mirGeo(g) {
    var o = g.clone(), a = o.attributes, k, i, j, t, arr, n, st;
    if (a.position.isInterleavedBufferAttribute) return o;   // (kommt in den Modellen nicht vor)
    arr = a.position.array; for (i = 0; i < arr.length; i += 3) arr[i] = -arr[i];
    if (a.normal) { arr = a.normal.array; for (i = 0; i < arr.length; i += 3) arr[i] = -arr[i]; }
    if (o.index) {   // Umlaufsinn umkehren (Spiegelung dreht ihn um → sonst Rückseiten-Culling verkehrt)
      arr = o.index.array; for (i = 0; i + 2 < arr.length; i += 3) { t = arr[i + 1]; arr[i + 1] = arr[i + 2]; arr[i + 2] = t; }
      o.index.needsUpdate = true;
    } else {
      for (k in a) {
        arr = a[k].array; st = a[k].itemSize; n = a[k].count;
        for (i = 0; i + 2 < n; i += 3) for (j = 0; j < st; j++) { t = arr[(i + 1) * st + j]; arr[(i + 1) * st + j] = arr[(i + 2) * st + j]; arr[(i + 2) * st + j] = t; }
      }
    }
    for (k in a) a[k].needsUpdate = true;
    o.computeBoundingBox(); o.computeBoundingSphere();
    return o;
  }
  function mirX(v) { if (v && v.length) v[0] = -v[0]; }
  function mirrorModel(M) {
    if (!M || M.mir) return M;
    var done = new Map(), k, i;
    function mg(g) { if (!g || !g.isBufferGeometry) return g; var m = done.get(g); if (!m) { m = mirGeo(g); done.set(g, m); } return m; }
    if (M.parts) for (k in M.parts) if (!MIR_KEEP[k]) M.parts[k] = mg(M.parts[k]);
    if (M.xparts) for (k in M.xparts) if (!MIR_KEEP[k]) M.xparts[k] = mg(M.xparts[k]);
    if (M.xp) for (i = 0; i < M.xp.length; i++) {
      var xe = M.xp[i]; xe.x = -xe.x;
      if (xe.k === 'doorL') xe.k = 'doorR'; else if (xe.k === 'doorR') xe.k = 'doorL';
    }
    if (M.at) for (k in M.at) mirX(M.at[k]);
    mirX(M.radarAt); mirX(M.flag); mirX(M.emitAt); mirX(M.chim); mirX(M.spark); mirX(M.elec);
    if (M.steam) for (i = 0; i < M.steam.length; i++) mirX(M.steam[i]);
    if (M.win) for (i = 0; i < M.win.length; i++) mirX(M.win[i]);
    M.mir = true; M.mirA = -1;
    return M;
  }

  // ------------------------------------------------------------------ Instanz-Batches
  function Batch(geo, mat, cap, shadow) {
    this.geo = geo; this.mat = mat; this.n = 0; this.shadow = shadow !== false;
    if (mat && mat.userData && mat.userData.surf) ensureSurf(geo, mat.userData.surfDefault);
    this.make(cap);
  }
  Batch.prototype.make = function (cap) {
    var old = this.mesh;
    if (R.glCount) R.glCount.newBatch++;   // v0.8: Zähler (Neuanlage während des Spiels = Wachstum)
    this.cap = cap;
    if (old) this.mat = old.material;   // v0.6: Material kann inzwischen umgehängt sein (Qualitätswechsel)
    this.mesh = new THREE.InstancedMesh(this.geo, this.mat, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = this.shadow; this.mesh.receiveShadow = true;
    this.mesh.count = 0;
    if (old) {
      this.mesh.instanceMatrix.array.set(old.instanceMatrix.array);
      this.mesh.instanceColor.array.set(old.instanceColor.array);
      this.mesh.renderOrder = old.renderOrder;
      if (old.parent) { old.parent.add(this.mesh); old.parent.remove(old); }
      old.dispose();
    }
  };
  /** Instanz hinzufügen: Position, Drehung um y (Sim-Winkel!), Skalierung, Farbe (r,g,b Multiplikator). */
  Batch.prototype.put = function (x, y, z, ang, sx, sy, sz, r, g, b) {
    if (this.n >= this.cap) this.make(this.cap * 2);
    var i = this.n++, e = this.mesh.instanceMatrix.array, o = i * 16;
    var c = Math.cos(-ang), s = Math.sin(-ang);
    e[o] = c * sx; e[o + 1] = 0; e[o + 2] = -s * sx; e[o + 3] = 0;
    e[o + 4] = 0; e[o + 5] = sy; e[o + 6] = 0; e[o + 7] = 0;
    e[o + 8] = s * sz; e[o + 9] = 0; e[o + 10] = c * sz; e[o + 11] = 0;
    e[o + 12] = x; e[o + 13] = y; e[o + 14] = z; e[o + 15] = 1;
    var ca = this.mesh.instanceColor.array; ca[i * 3] = r; ca[i * 3 + 1] = g; ca[i * 3 + 2] = b;
  };
  /** Instanz mit Neigung (Elevation) um die lokale z-Achse nach dem Gieren um y (Nicken, Rohr-Erhöhung). */
  Batch.prototype.putP = function (x, y, z, ang, pit, r, g, b) {
    if (this.n >= this.cap) this.make(this.cap * 2);
    var i = this.n++, e = this.mesh.instanceMatrix.array, o = i * 16;
    var c = Math.cos(-ang), s = Math.sin(-ang), cp = Math.cos(pit), sp = Math.sin(pit);
    e[o] = cp * c; e[o + 1] = sp; e[o + 2] = -cp * s; e[o + 3] = 0;
    e[o + 4] = -sp * c; e[o + 5] = cp; e[o + 6] = sp * s; e[o + 7] = 0;
    e[o + 8] = s; e[o + 9] = 0; e[o + 10] = c; e[o + 11] = 0;
    e[o + 12] = x; e[o + 13] = y; e[o + 14] = z; e[o + 15] = 1;
    var ca = this.mesh.instanceColor.array; ca[i * 3] = r; ca[i * 3 + 1] = g; ca[i * 3 + 2] = b;
  };
  /** Wie putP, mit gleichmäßiger Skalierung s (Räder skalierter Fahrzeuge). */
  Batch.prototype.putPS = function (x, y, z, ang, pit, s, r, g, b) {
    if (this.n >= this.cap) this.make(this.cap * 2);
    var i = this.n++, e = this.mesh.instanceMatrix.array, o = i * 16;
    var c = Math.cos(-ang), sn = Math.sin(-ang), cp = Math.cos(pit), sp = Math.sin(pit);
    e[o] = cp * c * s; e[o + 1] = sp * s; e[o + 2] = -cp * sn * s; e[o + 3] = 0;
    e[o + 4] = -sp * c * s; e[o + 5] = cp * s; e[o + 6] = sp * sn * s; e[o + 7] = 0;
    e[o + 8] = sn * s; e[o + 9] = 0; e[o + 10] = c * s; e[o + 11] = 0;
    e[o + 12] = x; e[o + 13] = y; e[o + 14] = z; e[o + 15] = 1;
    var ca = this.mesh.instanceColor.array; ca[i * 3] = r; ca[i * 3 + 1] = g; ca[i * 3 + 2] = b;
  };
  Batch.prototype.flush = function () {
    this.mesh.count = this.n;
    this.mesh.visible = this.n > 0;
    if (this.n) {
      var im = this.mesh.instanceMatrix, ic = this.mesh.instanceColor;
      im.needsUpdate = true; ic.needsUpdate = true;
      if ((R.F || {}).fixedBuf) {   // v0.8 PowerVR: nur den benutzten Teil hochladen (bufferSubData über n Instanzen statt über die ganze Kapazität)
        im.clearUpdateRanges(); im.addUpdateRange(0, this.n * 16);
        ic.clearUpdateRanges(); ic.addUpdateRange(0, this.n * 3);
      }
    }
    this.n = 0;
  };

  var batches = {}, batchList = [];
  function dropBatches() {
    for (var i = 0; i < batchList.length; i++) { var m = batchList[i].mesh; if (m.parent) m.parent.remove(m); m.dispose(); }
    batches = {}; batchList = [];
    for (var k in modelCache) { if (modelCache[k].bt) modelCache[k].bt = {}; modelCache[k].pbt = null; }
    for (k in ruinCache) ruinCache[k].bt = {};
    if (flagModel) flagModel.bt = {};
  }
  // v0.6: Glühteile (Emissive-Konvention): in Modern unbeleuchtet über MAT.emis (Bloom), sonst wie bisher MAT.std
  var GLOW_PARTS = { glow: 1, hglow: 1, lamp: 1, cell: 1, tglow: 1, wlit: 1 };   // W10: tglow (Turm-Glühteil der Einheiten), wlit (beleuchtete Fenster)
  function partMat(part) { return (R.std && GLOW_PARTS[part]) ? MAT.emis : MAT.std; }
  function batch(key, geoFn, mat, cap, shadow) {
    var bt = batches[key];
    if (!bt) {
      bt = batches[key] = new Batch(geoFn(), mat || MAT.std, cap || 16, shadow);
      batchList.push(bt);
      R.dynRoot.add(bt.mesh);
    }
    return bt;
  }

  // ------------------------------------------------------------------ Ereignisse
  var rs = new Map(); // Render-Zustand je Einheit: geglättete Winkel, Staub-Timer
  var wrecks = [];    // { type, owner, fac, color, x, z, dir, tdir, t0, kind, bx, bz }

  function unitModelOf(e) { var S = G.Sim.S, P = S.players[e.owner]; return model(e.type, P.faction, P.color); }
  /** Mündungsposition (Welt, Kacheln) für Schütze src. */
  var mzTx = 0, mzTz = 0, mzBarrel = 0;
  /** tx/tz = Ziel (Kacheln, für Fenster-/Schießschartenwahl), barrel = 0|1 (Zwillingsrohr). */
  function muzzleOf(src, out, tx, tz, barrel, aux) {
    var S = G.Sim.S, M, x, z, y0, ang, s;
    mzTx = tx || 0; mzTz = tz || 0; mzBarrel = barrel ? 1 : 0;
    if (src.kind === 'building' && NEUT[src.type]) {
      var NM = model(src.type);
      if (NM.win.length) return windowOf(src, NM, mzTx, mzTz, out);
      return out.set(src.x / TILE, 0.5, src.y / TILE);
    }
    if (src.kind === 'building') {
      var Pb = S.players[src.owner];
      M = model(src.type, Pb.faction, Pb.color);
      if (M.win && M.win.length) return windowOf(src, M, mzTx, mzTz, out);   // Bunker: Schießscharte zum Ziel
      x = src.x / TILE; z = src.y / TILE; y0 = 0; ang = src.tdir || 0; s = 1;
      out.set(x + Math.cos(ang) * M.muzzle[0], y0 + M.muzzle[1], z + Math.sin(ang) * M.muzzle[0]);
      return out;
    }
    M = unitModelOf(src); s = SCALE[src.type] || 1;
    var r = rs.get(src.id), dir = r ? r.dir : src.dir;
    x = src.x / TILE; z = src.y / TILE; y0 = groundAt(x, z);
    if (src.mc === 2) y0 += (r && r.alt != null ? r.alt : (src.alt || 0)) * D.AIR_H; else if (src.mc === 3) y0 = WL8;   // v0.8
    ang = src.tdir;
    var pv = M.pivot, mz = M.muzzle;
    if (M.air) { ang = dir; if (M.pods && r) mzBarrel = r.mzA = r.mzA ? 0 : 1; }   // v0.8: Raketenbehälter links/rechts im Wechsel, Blick = Flugrichtung
    else if (M.naval && aux && M.aaTr) {   // Zerstörer-Flak: Mündung an der Lafette (Richtung/Erhöhung aus dem Render-Zustand)
      var ay = r ? r.aaY : dir, ae = r ? Math.max(0.5, r.aaE) : 0.8, cdq = Math.cos(dir), sdq = Math.sin(dir), ml = M.aaL * Math.cos(ae);
      return out.set(x + (cdq * M.aaP[0] - sdq * M.aaP[1]) * s + Math.cos(ay) * ml * s, y0 + (M.aaTr[1] + Math.sin(ae) * M.aaL) * s, z + (sdq * M.aaP[0] + cdq * M.aaP[1]) * s + Math.sin(ay) * ml * s);
    } else if (M.piv2 && r) {   // Zerstörer: Bug- und Heckturm im Wechsel, sofern das Ziel achteraus liegt
      var dB = ang - dir - Math.PI; while (dB > Math.PI) dB -= 2 * Math.PI; while (dB < -Math.PI) dB += 2 * Math.PI;
      r.mzA = Math.abs(dB) < 2.2 ? (r.mzA ? 0 : 1) : 0;
      if (r.mzA) { pv = M.piv2; mz = M.muzzle2; r.b1 = R.t; } else r.b0 = R.t;
    } else if (M.alt2 && r) mzBarrel = r.mzA = r.mzA ? 0 : 1;   // v1.2: Doppellafetten feuern links/rechts im Wechsel
    var px = x + (Math.cos(dir) * pv[0] - Math.sin(dir) * pv[1]) * s, pz = z + (Math.sin(dir) * pv[0] + Math.cos(dir) * pv[1]) * s;
    out.set(px + Math.cos(ang) * mz[0] * s, y0 + mz[1] * s, pz + Math.sin(ang) * mz[0] * s);
    if (M.mz2) { var lat = (mzBarrel ? -1 : 1) * M.mz2 * s; out.x -= Math.sin(ang) * lat; out.z += Math.cos(ang) * lat; }
    return out;
  }
  var DIE_SMALL = { rifle: 1, rocket: 1, engineer: 1, sniper: 1, flamer: 1, medic: 1 };
  var INF = { rifle: 1, rocket: 1, engineer: 1, sniper: 1, flamer: 1, medic: 1, psiadept: 1, brute: 1 };   // v1.0

  // ------------------------------------------------------------------ Neutrale Gebäude: Zustand, Zeichnen, Effekte
  var nrs = new Map();   // Render-Zustand je neutralem Gebäude (zuletzt gesehener Besitzer, Animationsphasen, Ruinenzeit, Geschützrichtung)
  function nst(id) {
    var s = nrs.get(id);
    if (!s) {
      s = { shown: -2, flagT0: -1e9, ph: hash(id, 3, 4) * 6.28, spin: hash(id, 5, 1) * 6.28, nodPh: hash(id, 7, 1) * 6.28, ruinT: -1e9, artyT: -1e9, yaw: NaN, door: 0, swT: -1e9, v5T: -1e9 };
      nrs.set(id, s);
    }
    return s;
  }
  var teamRGBc = {};
  function teamRGB(color) {
    var c = teamRGBc[color];
    if (!c) { var t = new THREE.Color(color); c = teamRGBc[color] = [t.r, t.g, t.b]; }
    return c;
  }
  function nbat(M, part) {
    var q = M.bt[part];
    if (!q) q = M.bt[part] = batch('N:' + M.key + ':' + part, function () { return M.parts[part]; }, partMat(part), 8);
    return q;
  }
  /** Neutrales Gebäude erkundet (oder Nebel aus)? Sonst gar nicht zeichnen/anklicken. */
  function neutralShown(e, P, fogOff) {
    if (fogOff) return true;
    var w = G.Sim.S.map.w, ex = P.exp;
    for (var yy = e.ty; yy < e.ty + e.h; yy++) for (var xx = e.tx; xx < e.tx + e.w; xx++) if (ex[yy * w + xx]) return true;
    return false;
  }

  function drawFlag(M, x, z, rgb, frac, st) {
    var FM = getFlagModel(), H = M.flag[2], px = x + M.flag[0], pz = z + M.flag[1];
    nbat(FM, 'pole').put(px, 0, pz, 0, 1, H, 1, 1, 1, 1);
    var cy = 0.1 + (H - 0.5) * frac, tt = R.t * 3.2 + st.ph;
    var p1 = Math.sin(tt) * 0.2, a1 = 0.1 + Math.sin(tt * 0.7) * 0.28, c1 = Math.cos(p1) * 0.42;
    nbat(FM, 'cloth').putP(px + 0.02, cy, pz, a1, p1, rgb[0], rgb[1], rgb[2]);
    nbat(FM, 'cloth').putP(px + 0.02 + Math.cos(a1) * c1, cy + Math.sin(p1) * 0.42, pz + Math.sin(a1) * c1, a1 + Math.sin(tt * 0.9 + 1) * 0.35, Math.sin(tt - 1.3) * 0.3, rgb[0] * 0.9, rgb[1] * 0.9, rgb[2] * 0.9);
  }

  function drawNeutral(e, S, pid, fogOff, dt, inV) {
    var M = model(e.type), x = e.x / TILE, z = e.y / TILE, st = nst(e.id), bd = NEUT[e.type], i;
    var vis = fogOff || e.owner === pid || G.Sim.isVisible(pid, e);
    if (vis) {
      var ow = e.owner < 0 ? -1 : e.owner;
      if (st.shown !== ow) { if (st.shown !== -2) st.flagT0 = R.t; st.shown = ow; }
    }
    var sh = st.shown < 0 ? -1 : st.shown, own = sh >= 0 ? S.players[sh] : null, rgb = own ? teamRGB(own.color) : NTINT;
    var hf = e.maxHp > 0 ? e.hp / e.maxHp : 1, dk = hf < 0.35 ? 0.8 : 1, active = sh >= 0, ew = e.w || bd.w, eh = e.h || bd.h;
    // --- Ruine: Einsturz, dann Trümmerhaufen mit Rauch
    if (e.ruin) {
      var ra = R.t - st.ruinT, RM = ruinModel(ew, eh);
      if (ra < 0.9) nbat(M, 'body').put(x, 0, z, 0, 1, Math.max(0.06, 1 - ra * 1.25), 1, 0.45, 0.42, 0.4);
      nbat(RM, 'body').put(x, 0, z, 0, 1, ra < 0.5 ? 0.35 + ra * 1.3 : 1, 1, 0.95, 0.92, 0.9);
      if (inV && ra < 45) {
        if (rnd() < dt * (ra < 12 ? 10 : 4 * (1 - ra / 45) + 0.5)) emit(1, x + (rnd() - 0.5) * (ew - 0.6), 0.25, z + (rnd() - 0.5) * (eh - 0.6), 0.12, 0.5 + rnd() * 0.3, 0.04, 2.8 + rnd(), 0.35, 1.3, 0.12, 0.115, 0.11, 0.85, 0.32, 0.32, 0.32, 0, 0, 0.3);
        if (ra < 10 && rnd() < dt * 5) emit(0, x + (rnd() - 0.5) * (ew - 0.8), 0.15, z + (rnd() - 0.5) * (eh - 0.8), 0, 0.4, 0, 0.45, 0.2, 0.05, 1, 0.55, 0.15, 1, 0.9, 0.2, 0.05, 0);
      }
      return;
    }
    nbat(M, 'body').put(x, 0, z, 0, 1, 1, 1, dk, dk, dk);
    nbat(M, 'trim').put(x, 0, z, 0, 1, 1, 1, rgb[0] * dk, rgb[1] * dk, rgb[2] * dk);
    var at = M.at;
    if (e.type === 'radar') {
      st.spin += dt * (active ? 1.9 : 0.3);
      nbat(M, 'dish').put(x + at.dish[0], at.dish[1], z + at.dish[2], st.spin, 1, 1, 1, dk, dk, dk);
    } else if (e.type === 'oilrig') {
      if (active) st.nodPh += dt * 3.3;
      nbat(M, 'beam').putP(x + at.beam[0], at.beam[1], z + at.beam[2], 0, (active ? Math.sin(st.nodPh) * 0.17 : -0.07) * (M.mirA || 1), dk, dk, dk);
    } else if (e.type === 'workshop') {
      nbat(M, 'crane').put(x + at.crane[0], at.crane[1], z + at.crane[2], (active ? Math.sin(R.t * 0.55 + st.ph) * 0.55 : 0.25) * (M.mirA || 1), 1, 1, 1, dk, dk, dk);
      if (active && inV && rnd() < dt * 3.5) emit(0, x + M.spark[0] + (rnd() - 0.5) * 0.2, M.spark[1], z + M.spark[2], (rnd() - 0.5) * 0.8, 0.5 + rnd(), (rnd() - 0.2) * 0.8, 0.3, 0.06, 0.02, 1, 0.95, 0.6, 1, 1, 0.6, 0.2, 0, -4);
    } else if (e.type === 'tradepost') {   // v1.2 Handelsposten: Münze dreht sich, wenn eingenommen
      st.spin += dt * (active ? 1.7 : 0.12);
      var ck = active ? dk * 1.1 : dk * 0.8;
      nbat(M, 'coin').put(x + at.coin[0], at.coin[1], z + at.coin[2], st.spin, 1, 1, 1, ck, ck, ck);
    } else if (e.type === 'hospital') {
      if (active && inV && rnd() < dt * 2) emit(0, x - 1.3 + rnd() * 2.6, 0.5, z - 0.8 + rnd() * 1.6, 0, 0.3, 0, 1.4, 0.09, 0.02, 0.3, 1, 0.55, 0.8, 0.2, 0.8, 0.4, 0);
    } else if (e.type === 'artillery') {
      if (st.yaw !== st.yaw) st.yaw = Math.atan2(S.map.h / 2 - z, S.map.w / 2 - x);
      var tf = R.t - st.artyT, pit = M.rest, rec = 0;
      if (tf < 3.6) {
        pit = M.rest + (0.95 - M.rest) * (tf < 1.8 ? 1 : 1 - (tf - 1.8) / 1.8);
        if (tf < 0.8) rec = 0.3 * Math.exp(-tf * 7);
      }
      nbat(M, 'gun').put(x, 0, z, st.yaw, 1, 1, 1, dk, dk, dk);
      nbat(M, 'barrel').putP(x + at.barrel[0] - Math.cos(st.yaw) * rec, at.barrel[1], z - Math.sin(st.yaw) * rec, st.yaw, pit, dk, dk, dk);
      var ch = e.charge || 0, lr, lg, lb;
      if (!active) { lr = lg = lb = 0.3; }
      else if (ch >= 1) { var pu = 1.2 + 0.8 * Math.sin(R.t * 5); lr = 0.25 * pu; lg = 1.5 * pu; lb = 0.35 * pu; }
      else { lr = 1.7 - ch * 0.5; lg = 0.2 + ch * 0.9; lb = 0.1; }
      nbat(M, 'lamp').put(x + at.lamp[0], at.lamp[1], z + at.lamp[2], 0, 1, 1, 1, lr, lg, lb);
    }
    // --- Fahne (Besitzerfarbe; beim Erobern steigt die Fahne des Eroberers)
    if (vis && e.capT > 0 && e.capT < 1 && e.capBy >= 0 && S.players[e.capBy]) drawFlag(M, x, z, teamRGB(S.players[e.capBy].color), e.capT, st);
    else if (own) drawFlag(M, x, z, rgb, clamp((R.t - st.flagT0) / 0.9, 0.05, 1), st);
    if (!inV) return;
    // --- Schadensrauch; Schornstein bewohnter Häuser
    if (hf < 0.55 && rnd() < dt * (hf < 0.3 ? 12 : 5)) {
      var sx2 = x + (rnd() - 0.5) * ew * 0.6, sz2 = z + (rnd() - 0.5) * eh * 0.6, sh2 = M.h * (0.5 + rnd() * 0.4);
      emit(1, sx2, sh2, sz2, 0.15, 0.5 + rnd() * 0.3, 0.05, 2 + rnd(), 0.25, 0.9, 0.16, 0.15, 0.14, 0.75, 0.3, 0.3, 0.3, 0, 0, 0.3);
      if (hf < 0.3) emit(0, sx2, sh2, sz2, 0, 0.6, 0, 0.4, 0.3, 0.08, 1, 0.6, 0.15, 1, 0.9, 0.2, 0.05, 0);
    }
    if (e.type === 'house' && e.gar && e.gar.length && rnd() < dt * 1.6) emit(1, x + M.chim[0], M.chim[1], z + M.chim[2], 0.1, 0.4, 0.02, 2.4, 0.1, 0.5, 0.78, 0.78, 0.78, 0.55, 0.9, 0.9, 0.9, 0, 0, 0.3);
  }

  /** Mündungspunkt eines Gebäudes aus dem Fenster/der Schießscharte, die zum Ziel zeigt. */
  function windowOf(src, M, tx, tz, out) {
    var x = src.x / TILE, z = src.y / TILE, best = -1e9, bi = 0, dx = tx - x, dz = tz - z, dl = Math.sqrt(dx * dx + dz * dz) + 1e-6;
    for (var i = 0; i < M.win.length; i++) {
      var w = M.win[i], wl = Math.sqrt(w[0] * w[0] + w[2] * w[2]) + 1e-6, sc = (w[0] * dx + w[2] * dz) / (wl * dl) + rnd() * 0.5;
      if (sc > best) { best = sc; bi = i; }
    }
    var wv = M.win[bi] || [0, 0.4, 0.5];
    return out.set(x + wv[0], wv[1], z + wv[2]);
  }

  /** v0.4-Gebäude: leuchtende Teile, Antennenschüsseln, Lade-Zellen, Silotore + Rakete. mem = erinnertes (graues) Gebäude. */
  function drawBldV4(b, M, owner, x, z, sy, dk, mem) {
    var S = G.Sim.S, st = nst(b.id), P = S.players[owner], rgb = teamRGB(P.color), t = R.t, i, xe, bt;
    var sw = b.type !== 'techcenter', ch = mem ? 0 : (b.charge || 0), ready = sw && ch >= 1, low = !mem && G.Sim.lowPower(owner);
    var res13 = !sw && !mem && P.res && P.res.cur && G.Sim.resRunning(owner) ? P.res.cur : null; if (res13) ch = res13.prog;   // v1.3 Forschung: Ladezellen = Fortschritt
    var fl = t - st.swT, flare = sw && fl < 8 ? (fl < 3.4 ? 1 : Math.exp(-(fl - 3.4) * 1.2)) : 0;
    if (!mem && sw) st.door += ((ready || (b.type === 'silo' && fl < 3.6) ? 1 : 0) - st.door) * Math.min(1, fdt * 2.6);
    var gain;
    if (mem) gain = dk;
    else if (low) gain = 0.28;
    else if (sw) gain = 0.5 + 0.55 * ch + (ready ? 0.35 + 0.35 * Math.sin(t * 5) : 0) + flare * (1.9 + 0.5 * Math.sin(t * 22));
    else gain = res13 ? 1.3 + 0.3 * Math.sin(t * 6 + st.ph) : 1.05 + 0.12 * Math.sin(t * 2 + st.ph);
    partBatch('b', b.type, owner, 'glow', M).put(x, 0, z, 0, 1, sy, 1, gain, gain, gain);
    for (i = 0; i < M.xp.length; i++) {
      xe = M.xp[i]; bt = partBatch('b', b.type, owner, xe.p, M);
      if (xe.k === 'spin') bt.put(x + xe.x, xe.y * sy, z + xe.z, mem ? 0 : t * (low ? 0.2 : 1.3), 1, sy, 1, dk, dk, dk);
      else if (xe.k === 'dish') bt.putP(x + xe.x, xe.y * sy, z + xe.z, mem ? xe.ph : t * 0.45 + xe.ph, mem ? 0.5 : 0.5 + 0.3 * Math.sin(t * 0.5 + xe.ph), dk, dk, dk);
      else if (xe.k === 'cell') {
        var lit = clamp(ch * 8 - xe.ci, 0, 1), cr, cg, cb;
        if (mem) { cr = cg = cb = dk * 0.5; }
        else if (low) { cr = cg = cb = 0.12; }
        else if (ready) { var wv = 0.5 + 0.5 * Math.sin(t * 6 - xe.ci * 0.8); cr = 0.5 + wv * 1.3; cg = 0.9 + wv * 1.0; cb = 0.5 + wv * 0.9; }
        else { var lk = 0.1 + lit * 1.7; cr = rgb[0] * lk + 0.04; cg = rgb[1] * lk + 0.04; cb = rgb[2] * lk + 0.04; }
        bt.put(x + xe.x, xe.y * sy, z + xe.z, 0, 1, sy, 1, cr, cg, cb);
      } else if (xe.k === 'doorL') bt.put(x + xe.x - st.door * 0.52, xe.y * sy, z + xe.z, 0, 1, sy, 1, dk, dk, dk);
      else if (xe.k === 'doorR') bt.put(x + xe.x + st.door * 0.52, xe.y * sy, z + xe.z, 0, 1, sy, 1, dk, dk, dk);
    }
    if (b.type === 'silo' && !mem && st.door > 0.55 && (ready || fl < 0.25)) {     // Rakete schaut aus dem Schacht (bis zum Start)
      var rise = 0.5 + 0.06 * Math.sin(t * 2.5);
      partBatch('b', 'silo', owner, 'msl', M).putP(x, (0.76 + rise - 1.24) * sy, z - 0.1, 0, Math.PI / 2, dk, dk, dk);
    }
  }

  // --- Mobiler Bauhof: Kran + Aufbau
  var DEPLOY_B = 52;                                  // Aufbau-Animation des Bauhof-HQ (Ticks = 2.6 s; normaler Bau 36)
  var dplFx = [], craneTip = { x: 0, y: 0, z: 0 };
  function isDeployHq(id) { for (var i = 0; i < dplFx.length; i++) if (dplFx[i].hq === id) return true; return false; }
  /** Kran in Pose u (0 = zusammengeklappt auf dem Container, 1 = ausgefahren). pos: Fahrzeugposition (Welt), dir: Fahrzeugrichtung. */
  function craneDraw(M, owner, x, y, z, dir, u) {
    var e1 = smooth(u), pit = 0.02 + 1.12 * e1, rel = -3.06 + 2.44 * smooth((u - 0.2) / 0.8);
    var cd = Math.cos(dir), sd = Math.sin(dir), px = x + cd * M.craneAt[0], pz = z + sd * M.craneAt[0], py = y + M.craneAt[1];
    partBatch('u', 'mcv', owner, 'crane', M).putP(px, py, pz, dir, pit, 1, 1, 1);
    var cp = Math.cos(pit), sp = Math.sin(pit), jx = px + cd * MCV_L1 * cp, jz = pz + sd * MCV_L1 * cp, jy = py + MCV_L1 * sp, jp = pit + rel;
    partBatch('u', 'mcv', owner, 'jib', M).putP(jx, jy, jz, dir, jp, 1, 1, 1);
    craneTip.x = jx + cd * MCV_L2 * Math.cos(jp); craneTip.z = jz + sd * MCV_L2 * Math.cos(jp); craneTip.y = jy + MCV_L2 * Math.sin(jp);
  }
  function deployEvt(e) {
    var S = G.Sim.S, P = S.players[e.owner], hq = G.Sim.get(e.id), i, q;
    if (!P) return;
    if (!hq || hq.kind !== 'building') hq = G.Sim.get(e.unit);
    if (!hq || hq.kind !== 'building') {
      hq = null;
      for (i = 0; i < S.ents.length; i++) { q = S.ents[i]; if (q.kind === 'building' && q.type === 'hq' && q.owner === e.owner && !q.dead && Math.abs(q.x - e.x) < 96 && Math.abs(q.y - e.y) < 96 && S.tick - q.placedT < 6) hq = q; }
    }
    var ur = rs.get(e.unit) || rs.get(e.id), dir = e.dir != null ? e.dir : (ur ? ur.dir : 0), x = hq ? hq.x / TILE : e.x / TILE, z = hq ? hq.y / TILE : e.y / TILE;
    if (dplFx.length >= 6) dplFx.shift();
    dplFx.push({ hq: hq ? hq.id : 0, ent: hq, owner: e.owner, x0: e.x / TILE, z0: e.y / TILE, dir: dir, t0: R.t });
    rs.delete(e.unit); rs.delete(e.id);
    if (S.settings.fogOff || e.owner === V.pid || visibleAt(e.x, e.y)) {
      dust(x, 0, z, 1.8); addPulse(x, z, P.color, 2.6, 1.1);
      flashAt(x, 0.8, z, 0.15, 1);
    }
  }
  function drawDeploy(S, alpha, dt, inView) {
    var i, d, hq, a, x, z, k, sink, M, P, hx, hz, u;
    for (i = dplFx.length - 1; i >= 0; i--) {
      d = dplFx[i]; hq = d.ent;
      if (hq && (hq.dead || hq.placedT == null)) hq = d.ent = null;
      a = hq ? (S.tick - hq.placedT + alpha) / DEPLOY_B : (R.t - d.t0) / 2.6;
      if (a >= 1 || a < -0.5) { dplFx.splice(i, 1); continue; }
      if (!S.settings.fogOff && d.owner !== V.pid && !visibleAt(d.x0 * TILE, d.z0 * TILE)) continue;
      P = S.players[d.owner]; M = model('mcv', P.faction, P.color);
      hx = hq ? hq.x / TILE : d.x0; hz = hq ? hq.y / TILE : d.z0;
      k = smooth(a / 0.2); x = d.x0 + (hx - d.x0) * k; z = d.z0 + (hz - d.z0) * k;
      sink = a > 0.5 ? smooth((a - 0.5) / 0.5) * 0.95 : 0;
      partBatch('u', 'mcv', d.owner, 'hull', M).put(x, -sink, z, d.dir, 1, 1, 1, 1, 1, 1);
      u = Math.min(1, a / 0.5);
      craneDraw(M, d.owner, x, -sink, z, d.dir, u);
      if (!inView(x, z)) continue;
      if (a > 0.08 && a < 0.8 && rnd() < dt * 26) emit(0, craneTip.x, craneTip.y, craneTip.z, (rnd() - 0.5) * 0.8, 0.4 + rnd() * 0.8, (rnd() - 0.5) * 0.8, 0.25, 0.07, 0.02, 1, 0.95, 0.6, 1, 1, 0.55, 0.15, 0, -5);
      if (a > 0.2 && a < 0.9 && rnd() < dt * 9) { var sa = rnd() * 6.283; dust(x + Math.cos(sa) * 1.4, 0, z + Math.sin(sa) * 1.4, 0.4); }
    }
  }

  // --- Mauern
  var wgG = null;   // v1.2: Tore (Besitzer + 1) im Mauerraster – Ausrichtung der Tore und Halbverbinder der Nachbarmauern
  var wg = null, wgW = 0, wgH = 0, wgSy = null, wgDk = null, wgMem = null, wLE = [], wLM = [], wN = 0, wGhostG = null, wGi = new Int32Array(64), wTmp = [0];
  function wallCell(e, mem, tick, alpha) {
    var idx = e.ty * wgW + e.tx;
    if (idx < 0 || idx >= wg.length || e.tx < 0 || e.tx >= wgW) return;
    wg[idx] = e.owner + 1;
    var age = (mem || e.placedT == null) ? 99 : tick - e.placedT + alpha, hf = e.maxHp > 0 ? e.hp / e.maxHp : 1;
    wgSy[idx] = age < WALL_BUILD ? 0.06 + 0.94 * (1 - Math.pow(1 - clamp(age / WALL_BUILD, 0, 1), 2)) : 1;
    wgDk[idx] = hf < 0.35 ? 0.78 : (hf < 0.65 ? 0.9 : 1);
    wgMem[idx] = mem ? 1 : 0;
    wLE[wN] = e; wLM[wN] = mem; wN++;
  }
  /** Alle Mauersegmente (sichtbare + erinnerte) ins Raster, dann Pfeiler + Verbinder zu gleichfarbigen 4-Nachbarn instanzieren. */
  function wallPass(S, P, pid, fogOff, alpha, dt, selSet, inView) {
    var w = S.map.w, h = S.map.h, tick = S.tick, ents = S.ents, i, e, id, mm, live;
    if (!wg || wgW !== w || wgH !== h) { wgW = w; wgH = h; wg = new Int8Array(w * h); wgSy = new Float32Array(w * h); wgDk = new Float32Array(w * h); wgMem = new Uint8Array(w * h); wgG = new Int8Array(w * h); }
    wg.fill(0); wgG.fill(0); wN = 0;
    for (i = 0; i < ents.length; i++) {
      e = ents[i];
      if (e.type === 'gate' && e.kind === 'building' && !e.dead && !G.Sim.hidden(pid, e) && (e.owner === pid || fogOff || G.Sim.isVisible(pid, e)) && e.tx >= 0 && e.tx < w) wgG[e.ty * w + e.tx] = e.owner + 1;   // v1.2
      if (e.type !== 'wall' || e.kind !== 'building' || e.dead) continue;
      if (G.Sim.hidden(pid, e) || (e.owner !== pid && !fogOff && !G.Sim.isVisible(pid, e))) continue;
      wallCell(e, false, tick, alpha);
    }
    if (!fogOff) for (id in P.mem) {
      mm = P.mem[id];
      if (mm.type === 'gate' && mm.tx >= 0 && mm.tx < w) { live = G.Sim.get(mm.id); if (!(live && !live.dead && G.Sim.isVisible(pid, live))) wgG[mm.ty * w + mm.tx] = mm.owner + 1; continue; }   // v1.2
      if (mm.type !== 'wall') continue;
      live = G.Sim.get(mm.id);
      if (live && !live.dead && G.Sim.isVisible(pid, live)) continue;
      wallCell(mm, true, tick, alpha);
    }
    var x, z, idx, v, sy, sy2, mem, dk, cr, cb, Pm, M, hf;
    for (i = 0; i < wN; i++) {
      e = wLE[i]; idx = e.ty * w + e.tx; v = wg[idx]; sy = wgSy[idx]; mem = wgMem[idx]; dk = wgDk[idx];
      cr = mem ? GREY : dk; cb = mem ? GREY * 1.05 : dk;
      x = e.tx + 0.5; z = e.ty + 0.5;
      Pm = S.players[e.owner]; M = model('wall', Pm.faction, Pm.color);
      partBatch('b', 'wall', e.owner, 'pillar', M).put(x, 0, z, 0, 1, sy, 1, cr, cr, cb);
      if (e.tx + 1 < w && wg[idx + 1] === v) { sy2 = Math.min(sy, wgSy[idx + 1]); partBatch('b', 'wall', e.owner, 'conn', M).put(x + 0.5, 0, z, 0, 1, sy2, 1, cr, cr, cb); }
      if (e.ty + 1 < h && wg[idx + w] === v) { sy2 = Math.min(sy, wgSy[idx + w]); partBatch('b', 'wall', e.owner, 'conn', M).put(x, 0, z + 0.5, Math.PI / 2, 1, sy2, 1, cr, cr, cb); }
      // v1.2: halber Verbinder bis an den Rand eines angrenzenden eigenen Tors
      if (e.tx + 1 < w && wgG[idx + 1] === v) partBatch('b', 'wall', e.owner, 'conn', M).put(x + 0.25, 0, z, 0, 0.5, sy, 1, cr, cr, cb);
      if (e.tx > 0 && wgG[idx - 1] === v) partBatch('b', 'wall', e.owner, 'conn', M).put(x - 0.25, 0, z, 0, 0.5, sy, 1, cr, cr, cb);
      if (e.ty + 1 < h && wgG[idx + w] === v) partBatch('b', 'wall', e.owner, 'conn', M).put(x, 0, z + 0.25, Math.PI / 2, 0.5, sy, 1, cr, cr, cb);
      if (e.ty > 0 && wgG[idx - w] === v) partBatch('b', 'wall', e.owner, 'conn', M).put(x, 0, z - 0.25, Math.PI / 2, 0.5, sy, 1, cr, cr, cb);
      if (mem) continue;
      if (selSet[e.id]) R.selSquare.put(x, 0.04, z, 0, 0.7, 1, 0.7, 0.6, 1, 0.6);
      hf = e.maxHp > 0 ? e.hp / e.maxHp : 1;
      if (hf < 0.4 && rnd() < dt * 2.5 && inView(x, z)) emit(1, x + (rnd() - 0.5) * 0.3, 0.5, z + (rnd() - 0.5) * 0.3, 0.1, 0.4, 0.03, 1.6, 0.12, 0.45, 0.16, 0.15, 0.14, 0.65, 0.3, 0.3, 0.3, 0, 0, 0.3);
    }
  }
  /** Mauer-Vorschau: placing.tiles (Kachelindizes y*w+x oder {tx,ty}); Gültigkeit je Kachel aus placing.oks[i] (bool-Array), sonst placing.ok (bool). */
  function tileOk(pl, i, idx) {
    if (Array.isArray(pl.ok)) return !!pl.ok[i]; // UI liefert ok[] je Kachel
    if (pl.oks && pl.oks.length != null) return !!pl.oks[i];
    if (pl.ok && pl.ok.length != null) return !!pl.ok[i];
    if (pl.bad && pl.bad.length != null) { for (var q = 0; q < pl.bad.length; q++) if (pl.bad[q] === idx) return false; }
    return pl.ok !== false;
  }
  function wallGhost(pl) {
    var S = G.Sim.S, P = S.players[V.pid], W = S.map.w, H = S.map.h, tiles = pl.tiles, n, i, t, idx, tx, ty;
    if (!tiles || !tiles.length) { if (pl.tx == null) return; wTmp[0] = pl.ty * W + pl.tx; tiles = wTmp; }
    n = Math.min(tiles.length, 60);
    if (!wGhostG || wGhostG.length !== W * H) wGhostG = new Int8Array(W * H);
    var cnt = 0;
    for (i = 0; i < n; i++) {
      t = tiles[i];
      if (typeof t === 'number') { tx = t % W; ty = (t / W) | 0; } else { tx = t.tx != null ? t.tx : t.x; ty = t.ty != null ? t.ty : t.y; }
      idx = ty * W + tx;
      if (tx < 0 || ty < 0 || tx >= W || ty >= H) { wGi[i] = -1; continue; }
      wGi[i] = idx; wGhostG[idx] = 1; cnt++;
    }
    if (!cnt) return;
    var M = model('wall', P.faction, P.color), own = P.id + 1, key = ':' + P.color;
    var bp = batch('gw:p' + key, function () { return M.parts.pillar; }, MAT.ghostW, 32, false);
    var bc = batch('gw:c' + key, function () { return M.parts.conn; }, MAT.ghostW, 32, false);
    var bf = batch('gw:f', function () { var g = new THREE.PlaneGeometry(0.92, 0.92); g.rotateX(-Math.PI / 2); return g; }, MAT.footW, 32, false);
    bp.mesh.renderOrder = bc.mesh.renderOrder = bf.mesh.renderOrder = 4; bp.mesh.receiveShadow = bc.mesh.receiveShadow = false;
    for (i = 0; i < n; i++) {
      idx = wGi[i]; if (idx < 0) continue;
      tx = idx % W; ty = (idx / W) | 0;
      var ok = tileOk(pl, i, idx), x = tx + 0.5, z = ty + 0.5, r = ok ? 0.55 : 1.0, g = ok ? 1.0 : 0.45, b = ok ? 0.65 : 0.45;
      bp.put(x, 0.02, z, 0, 1, 1, 1, r, g, b);
      bf.put(x, 0.06, z, 0, 1, 1, 1, ok ? 0.2 : 0.95, ok ? 0.9 : 0.2, ok ? 0.4 : 0.2);
      if (tx + 1 < W && (wGhostG[idx + 1] || wg[idx + 1] === own)) bc.put(x + 0.5, 0.02, z, 0, 1, 1, 1, r, g, b);
      if (ty + 1 < H && (wGhostG[idx + W] || wg[idx + W] === own)) bc.put(x, 0.02, z + 0.5, Math.PI / 2, 1, 1, 1, r, g, b);
      if (tx > 0 && !wGhostG[idx - 1] && wg[idx - 1] === own) bc.put(x - 0.5, 0.02, z, 0, 1, 1, 1, r, g, b);
      if (ty > 0 && !wGhostG[idx - W] && wg[idx - W] === own) bc.put(x, 0.02, z - 0.5, Math.PI / 2, 1, 1, 1, r, g, b);
    }
    for (i = 0; i < n; i++) if (wGi[i] >= 0) wGhostG[wGi[i]] = 0;
  }

  // --- Hooks für Bunker / Laser / Blitzturm (je Gebäude und Frame)
  var inV5 = false;
  function drawBldV5(b, M, owner, x, z, tdir, sy, dk, mem) {
    var S = G.Sim.S, st = nst(b.id), t = R.t, low = !mem && G.Sim.lowPower(owner), since = t - st.v5T, fl = since < 0.5 ? Math.exp(-since * 7) : 0, gain, i;
    if (M.v5 === 'pbunker') {
      var gar = !mem && b.gar && b.gar.length > 0;
      gain = mem ? 0 : ((gar ? 0.9 + 0.2 * Math.sin(t * 3 + st.ph) : 0.12) + fl * 2.2);
      partBatch('b', b.type, owner, 'glow', M).put(x, 0, z, 0, 1, sy, 1, gain, gain, gain);
    } else if (M.v5 === 'laser') {
      gain = mem ? dk * 0.4 : (low ? 0.22 : 1.0 + 0.35 * Math.sin(t * 2.2 + st.ph) + fl * 2.6);
      partBatch('b', b.type, owner, 'hglow', M).put(x, 0, z, tdir, 1, sy, 1, gain, gain, gain);
      var g2 = mem ? dk * 0.4 : (low ? 0.2 : 0.8 + 0.4 * Math.sin(t * 1.4 + st.ph) + fl * 0.8);
      partBatch('b', b.type, owner, 'glow', M).put(x, 0, z, 0, 1, sy, 1, g2, g2, g2);
      if (!mem && !low && inV5 && sy >= 1 && rnd() < fdt * 3) emit(0, x + Math.cos(tdir) * 0.68, 1.1, z + Math.sin(tdir) * 0.68, (rnd() - 0.5) * 0.2, 0.2, (rnd() - 0.5) * 0.2, 0.5, 0.08, 0.02, 0.4, 0.95, 1, 0.8, 0.2, 0.6, 1, 0);
    } else if (M.v5 === 'tesla') {
      gain = mem ? dk * 0.4 : (low ? 0.2 : 0.95 + 0.4 * Math.sin(t * 9 + st.ph) * Math.sin(t * 5.3) + fl * 2.0);
      partBatch('b', b.type, owner, 'glow', M).put(x, 0, z, 0, 1, sy, 1, gain, gain, gain);
      if (!mem && !low && inV5 && sy >= 1) {
        var qs = R.safeGPU ? 0.4 : 1;
        if (rnd() < fdt * 16 * qs) {
          var sa = rnd() * 6.283, sr = rnd() * 0.25;
          emit(0, x + Math.cos(sa) * sr, 1.88 + rnd() * 0.12, z + Math.sin(sa) * sr, Math.cos(sa) * 0.6, 0.5 + rnd() * 0.8, Math.sin(sa) * 0.6, 0.18 + rnd() * 0.15, 0.08, 0.02, 0.7, 0.85, 1, 1, 0.3, 0.4, 1, 0, -3);
        }
        if (rnd() < fdt * 1.8 * qs) {          // Funkenbogen von der Elektrode zu einem Spulenring
          var ri = (rnd() * 3) | 0, ra = rnd() * 6.283, rr = M.ringR[ri] + 0.02;
          arcSpark(x, 1.88, z, x + Math.cos(ra) * rr, M.ringY[ri] + 0.05, z + Math.sin(ra) * rr);
        }
      }
    }
    void S; void i;
  }

  // ================================================================== Bewegung: Fahrwerk (Nicken/Wanken/Rückstoß), Infanterie (Schritt/Knien/Fallen)
  // Alles rein aus dem lesbaren Zustand abgeleitet: Positionsdifferenzen je Bild (→ Tempo, Beschleunigung, Gierrate), e.fireT (Schuss),
  // r.hitT (Treffer, setzt r3-fx.js aus den hit-/shot-Ereignissen). Zustand je Einheit in rs (Felder vf, yr, pv/pw, rl/rw, gp, mv, kn, fc …).
  // dt = 0 (Pause) → nichts ändert sich. Keine zusätzlichen Zeichenaufrufe außer dem Teil 'leg' je Infanterie-Typ/Besitzer.
  var BVh = [1, 0, 0, 0, 1, 0, 0, 0, 1], BVt = [1, 0, 0, 0, 1, 0, 0, 0, 1], BVx = [1, 0, 0, 0, 1, 0, 0, 0, 1], BVy = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  var VKICK = { cannon: 2.3, rocket: 1.0, bullet: 0.42, flak: 0.5, sniper: 0.5 };
  var IKICK = { rocket: 0.2, sniper: 0.15, rifle: 0.08, brute: -0.3, flamer: 0.04 }, NOKNEEL = { brute: 1, psiadept: 1, engineer: 1, medic: 1 };
  /** Einmal je Modell: Weichheit des Fahrwerks, Rückstoß-Stärke (aus Waffe/Radius der Daten). */
  function dynInit(M, e, fac) {
    var ud = D.UNITS[e.type] || {}, st = ud[fac] || ud.coalition || ud.syndicate || ud.kollektiv || {}, w = st.weapon, rad = ud.radius || 11;
    M.soft = M.mcv ? 0.35 : (rad <= 10 ? 1.3 : (rad >= 13 ? 0.7 : 0.95));
    M.kick = w ? (VKICK[w.type] || 0) * ((w.dmg >= 80 || w.range >= 7) ? 1.3 : 1) : 0;
    M.wfreq = rad >= 13 ? 10 : 13;
    M.dyn = true;
  }
  /** Rohrrücklauf: schlägt in ~0,6 Ticks zurück, läuft weich wieder vor (fa in Ticks seit dem Schuss, n = Dauer). */
  function rcl(fa, n) { if (fa < 0.6) return fa / 0.6; var q = 1 - (fa - 0.6) / (n - 0.6); return q > 0 ? q * q : 0; }
  function angd(a) { while (a > Math.PI) a -= 6.283185307; while (a < -Math.PI) a += 6.283185307; return a; }
  /** Fahrwerk je Bild fortschreiben (dt > 0): Tempo/Beschleunigung/Gierrate aus der Bewegung, gedämpfte Federn für Nicken und Wanken. */
  function vehDyn(e, r, M, x, z, cd, sd, dt, tick, hov) {
    var ddx = x - r.lx, ddz = z - r.lz, dfw = ddx * cd + ddz * sd, sp = 0;
    r.lx = x; r.lz = z;
    if (ddx * ddx + ddz * ddz < 1) { r.trk += dfw; sp = dfw / dt; }
    var v0 = r.vf; r.vf = v0 + (sp - v0) * Math.min(1, dt * 7);
    var acc = (r.vf - v0) / dt, av = Math.min(1, Math.abs(r.vf));
    r.yr += (angd(r.dir - r.ld) / dt - r.yr) * Math.min(1, dt * 6); r.ld = r.dir;
    var soft = M.soft * (hov ? 1.5 : 1);
    var pt = clamp(acc * 0.0115 * soft, -0.16, 0.16) + Math.sin(r.trk * 9 + r.p0) * 0.013 * av * soft;
    var rt = clamp(-r.yr * r.vf * 0.022 * soft, -0.13, 0.13) + Math.sin(r.trk * 6.1 + r.p0 * 2) * 0.016 * av * soft;
    if (hov) { pt += 0.035 * Math.sin(R.t * 1.6 + r.p0); rt += 0.04 * Math.sin(R.t * 1.25 + r.p0 * 1.7); }
    if (e.fireT !== r.lf) {              // Schuss: Wanne nickt vom Rohr weg
      r.lf = e.fireT;
      if (tick - e.fireT < 4 && M.kick) { var da = (M.how ? r.dir + (r.tdir - r.dir) * r.dep : r.tdir) - r.dir, kj = M.kick * (0.6 + 0.4 * soft); r.pw += Math.cos(da) * kj; r.rw -= Math.sin(da) * kj * 1.2; }
    }
    if (r.hitT !== r.lh) { r.lh = r.hitT; r.pw += (rnd() - 0.5) * 1.3 * soft * r.hitK; r.rw += (rnd() - 0.5) * 1.9 * soft * r.hitK; }   // Treffer: kurzer Ruck
    var n = dt > 0.034 ? 3 : 1, h = dt / n, w2 = M.wfreq * M.wfreq, dc = 0.8 * M.wfreq, i;
    for (i = 0; i < n; i++) {
      r.pw += ((pt - r.pv) * w2 - r.pw * dc) * h; r.pv += r.pw * h;
      r.rw += ((rt - r.rl) * w2 - r.rw * dc) * h; r.rl += r.rw * h;
    }
    r.pv = clamp(r.pv, -0.17, 0.17); r.rl = clamp(r.rl, -0.15, 0.15);
    r.steer += (clamp(r.yr * 0.3, -0.5, 0.5) * av - r.steer) * Math.min(1, dt * 10);
    if (sp !== 0 || r.gp !== r.gp) {     // Geländeneigung (Brückenrampen, Ufer) entlang der Fahrtrichtung
      var L = 0.32, gt = Math.atan2(groundAt(x + cd * L, z + sd * L) - groundAt(x - cd * L, z - sd * L), 2 * L);
      r.gp = r.gp !== r.gp ? gt : r.gp + (clamp(gt, -0.3, 0.3) - r.gp) * Math.min(1, dt * 9);
    }
  }
  /** Infanterist zeichnen: Rumpf lehnt sich in den Schritt, Beine schwingen (Schrittlänge = Weg), kniet beim Feuern im Stand, Rückstoß, Trefferblitz. */
  function drawInf(e, M, r, x, y, z, s, dt, tick, alpha) {
    var own = e.owner, type = e.type, fa = tick - e.fireT + alpha, firing = fa < 25;
    if (dt > 0) {
      var ddx = x - r.lx, ddz = z - r.lz, d2 = ddx * ddx + ddz * ddz, d = d2 < 0.25 ? Math.sqrt(d2) : 0, mt = d > dt * 0.12 ? 1 : 0;
      r.lx = x; r.lz = z; r.ph += d * 11.5;
      r.mv += (mt - r.mv) * Math.min(1, dt * 9);
      var kt = (!mt && fa < 70 && !NOKNEEL[type]) ? 1 : 0;
      r.kn += (kt - r.kn) * Math.min(1, dt * (kt ? 10 : 5));
      r.fc = lerpAng(r.fc, firing ? r.tdir : r.dir, Math.min(1, dt * 13));
    }
    var mv = r.mv, kn = r.kn, idle = (1 - mv) * (1 - kn), sw = Math.sin(r.ph) * 0.72 * mv;
    var ik = IKICK[type] == null ? 0.05 : IKICK[type], kick = fa < 6 ? ik * (1 - fa / 6) : 0;
    var yaw = r.fc + idle * 0.2 * Math.sin(R.t * 0.55 + r.p0), pit = -0.14 * mv - 0.08 * kn + kick, roll = Math.sin(r.ph) * 0.06 * mv;
    var by = y + (Math.abs(Math.cos(r.ph)) * 0.02 * mv - 0.068 * kn + idle * 0.004 * Math.sin(R.t * 2.1 + r.p0)) * s;
    var hf = R.t - r.hitT, c = hf < 0.14 ? 1 + 0.6 * Math.min(1, r.hitK * 2) * (1 - hf / 0.14) : 1;
    basis(BVh, yaw, pit, roll);
    partBatch('u', type, own, 'hull', M).putM(x, by, z, BVh, s, c, c, c);
    if (M.parts.glow) {   // W10: Zündflamme (Flammenwerfer) flackert, beim Feuern hell
      var pg = M.pilot ? (firing && fa < 6 ? 2.2 : 0.9 + 0.35 * Math.sin(R.t * 23 + r.ph) * Math.sin(R.t * 7.1)) : 1;
      partBatch('u', type, own, 'glow', M).putM(x, by, z, BVh, s, pg, pg, pg);
    }
    if (M.sab) {   // v1.2 Saboteur: Ladung nur, wenn bereit (cd ≤ 0); Lampe rot (Sprengladung) / blau (lahmlegen), bernstein langsam beim Nachladen
      var sb = e.cd > 0, md = e.sabMode ? 1 : 0, on;
      if (!sb) partBatch('u', type, own, 'chg', M).putM(x, by, z, BVh, s, md ? 0.62 * c : c, md ? 0.82 * c : c, md ? 1.3 * c : c);
      if (sb) { on = Math.sin(R.t * 2.2 + r.p0) > 0.55 ? 1.1 : 0.18; partBatch('u', type, own, 'chgl', M).putM(x, by, z, BVh, s, on, on * 0.62, on * 0.12); }
      else { on = Math.sin(R.t * 6.5 + r.p0) > 0 ? 1.9 : 0.35; partBatch('u', type, own, 'chgl', M).putM(x, by, z, BVh, s, md ? 0.25 * on : on, md ? 0.85 * on : 0.12 * on, md ? 1.25 * on : 0.08 * on); }
    }
    if (M.xparts.leg) {
      var lb = partBatch('u', type, own, 'leg', M), a1 = sw * (1 - kn) + 0.95 * kn, a2 = -sw * (1 - kn) - 1.15 * kn;
      basis(BVt, yaw, 0, 0);
      lv(BVh, 0, M.legY, M.legZ, s); spinZ(BVx, BVt, a1); lb.putM(x + P8[0], by + P8[1], z + P8[2], BVx, s, c, c, c);
      lv(BVh, 0, M.legY, -M.legZ, s); spinZ(BVx, BVt, a2); lb.putM(x + P8[0], by + P8[1], z + P8[2], BVx, s, c, c, c);
    }
  }
  /** Gefallener Infanterist (Wrack-Art 'fall'): kippt um, bleibt kurz liegen, versinkt. */
  function drawFall(w, wa) {
    var M = model(w.type, w.fac, w.color), s = SCALE[w.type] || 1, f = Math.min(1, wa / 0.36), ang = 1.5 * f * f;
    if (wa > 0.36 && wa < 0.6) ang -= 0.13 * Math.sin((wa - 0.36) / 0.24 * Math.PI);
    var snk = wa > w.life - 1.3 ? (wa - (w.life - 1.3)) / 1.3 : 0, dk = 1 - 0.5 * Math.min(1, wa / 1.2);
    var y = groundAt(w.x, w.z) + (0.05 * f * f - snk * 0.16) * s;
    basis(BVh, w.dir, ang * (w.side || 1), 0);
    partBatch('u', w.type, w.owner, 'hull', M).putM(w.x, y, w.z, BVh, s, dk, dk, dk);
    if (M.xparts.leg) {
      var lb = partBatch('u', w.type, w.owner, 'leg', M);
      lv(BVh, 0, M.legY, M.legZ, s); spinZ(BVx, BVh, 0.3 * f); lb.putM(w.x + P8[0], y + P8[1], w.z + P8[2], BVx, s, dk, dk, dk);
      lv(BVh, 0, M.legY, -M.legZ, s); spinZ(BVx, BVh, -0.2 * f); lb.putM(w.x + P8[0], y + P8[1], w.z + P8[2], BVx, s, dk, dk, dk);
    }
  }

  // ------------------------------------------------------------------ Szene füllen
  var scaffold = null;
  function ensureAux() {
    if (scaffold) return;
    var sb = new MB('bld'), c = '#e0a526';
    sb.surf('metal');
    [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5], [0, -0.5], [0, 0.5], [-0.5, 0], [0.5, 0]].forEach(function (p) { sb.box(c, 0.03, 1, 0.03, p[0], 0, p[1]); });
    [0.33, 0.66, 0.98].forEach(function (y) { sb.box(c, 1.02, 0.025, 0.025, 0, y, -0.5).box(c, 1.02, 0.025, 0.025, 0, y, 0.5).box(c, 0.025, 0.025, 1.02, -0.5, y, 0).box(c, 0.025, 0.025, 1.02, 0.5, y, 0); });
    scaffold = new Batch(sb.geo(false), MAT.std, 4); R.dynRoot.add(scaffold.mesh);
  }

  var pbMode = 0;   // v1.2 Tarnung: 1 = Teile des gerade gezeichneten Objekts in die halbtransparenten Tarn-Batches (MAT.cloak, ohne Schatten)
  var PBC = {};     // Teilname → Schlüssel der Tarn-Variante (einmal je Teilname, keine Zeichenketten je Frame)
  function partBatch(kind, type, owner, part, M) {
    var pk = pbMode ? (PBC[part] || (PBC[part] = '~' + part)) : part;
    var bo = M.pbt || (M.pbt = {}), by = bo[owner] || (bo[owner] = {}), bt = by[pk];   // v0.7: Batch-Verweis je Modell/Besitzer/Teil zwischenspeichern (keine Zeichenketten je Frame)
    if (bt && bt.mesh.parent) return bt;
    // v0.8 PowerVR (fixedBuf): großzügige Startkapazität, damit Batches im Spiel praktisch nie wachsen (jedes Wachstum = neuer GPU-Puffer)
    var fb = (R.F || {}).fixedBuf;
    bt = batch(kind + (M.mkey || type + (M.lo ? '~' : '')) + ':' + owner + ':' + pk, function () { return M.parts[part] || M.xparts[part]; }, pbMode ? MAT.cloak : partMat(part), pbMode ? 4 : (kind === 'u' ? (fb ? 96 : 24) : (fb ? 24 : 8)), (part === 'leg' || pbMode) ? false : undefined);   // Bewegung: Beine werfen keinen eigenen Schatten (spart den Zeichenaufruf im Schattendurchgang)
    if (pbMode) bt.mesh.renderOrder = 3;
    by[pk] = bt;
    return bt;
  }

  var GREY = 0.62;
  function drawBuildingInst(b, M, owner, x, z, tdir, sy, cr, cg, cb) {
    if (M.gate) { gateDraw(b, M, owner, x, z, sy, cr, cg, cb); return; }   // v1.2 Tor (Ausrichtung nach den Nachbarmauern)
    partBatch('b', b.type, owner, 'body', M).put(x, 0, z, 0, 1, sy, 1, cr, cg, cb);
    if (M.mine12) mineDraw(b, M, owner, x, z, sy, cr, cg, cb);   // v1.2 Minenfeld: Ladungen
    if (M.b12 && cr === GREY) rest12(b, M, owner, x, z, sy, cr, cg, cb);   // v1.2 erinnertes Reparaturdock: Arme in Ruhe
    var h = sy;
    if (M.parts.head && M.v8b !== 'flak') {
      partBatch('b', b.type, owner, 'head', M).put(x, 0, z, tdir, 1, h, 1, cr, cg, cb);
      if (M.parts.barrel) {
        var rc = (b.fireT != null && G.Sim.S.tick - b.fireT < 4) ? M.recoil * (1 - (G.Sim.S.tick - b.fireT) / 4) : 0;
        partBatch('b', b.type, owner, 'barrel', M).put(x - Math.cos(tdir) * rc, 0, z - Math.sin(tdir) * rc, tdir, 1, h, 1, cr, cg, cb);
      }
    }
    if (M.parts.radar) partBatch('b', b.type, owner, 'radar', M).put(x + M.radarAt[0], M.radarAt[1] * sy, z + M.radarAt[2], R.t * 1.6 + owner, 1, sy, 1, cr, cg, cb);
    if (M.lit) {   // Fensterlicht / Signallichter (Glühteil): bei Stromausfall gedimmt, erinnerte Gebäude grau
      var lg = litGain(b, M, owner, cr);   // GA: Strommangel flackert, Kraftwerk nach Auslastung, Produzent heller
      partBatch('b', b.type, owner, 'glow', M).put(x, 0, z, 0, 1, sy, 1, lg, lg, lg);
    }
    if (M.parts.wlit) {   // W10: beleuchtete Fenster (v0.4/v0.5-Gebäude): Stromausfall gedimmt, erinnert grau
      var wg2 = litGain(b, M, owner, cr);
      partBatch('b', b.type, owner, 'wlit', M).put(x, 0, z, 0, 1, sy, 1, wg2, wg2, wg2);
    }
    if (M.xp && M.xp.length) drawBldV4(b, M, owner, x, z, sy, cr, cr === GREY);
    if (M.v5) drawBldV5(b, M, owner, x, z, tdir, sy, cr, cr === GREY);
    if (M.v8b) drawBldV8(b, M, owner, x, z, tdir, sy, cr, cg, cb);
  }

  /** Je Frame: alle Gebäude/Einheiten/Wracks/Vorschau instanzieren. selSet = {id:1} der Auswahl (Ringe über R.selRing/R.selSquare). */
  function fill(S, alpha, dt, selSet) {
    var V = R.V, pid = V.pid, P = S.players[pid], fogOff = S.settings.fogOff, ents = S.ents, tick = S.tick, inView = R.inView;
    var selRing = R.selRing, selSquare = R.selSquare;
    var i, e, Pm, M, x, z, y, s;
    fdt = dt;
    if (MAT.cloak) MAT.cloak.opacity = 0.36 + 0.08 * Math.sin(R.t * 2.6);   // v1.2 Tarnung: Schimmer (eine Zahl je Frame, kein neues Programm)
    // --- Mauern (Raster + automatische Verbindungen)
    wallPass(S, P, pid, fogOff, alpha, dt, selSet, inView);
    // --- Gebäude
    actPre(S);   // GA: Produzenten, angedockte Sammler, Landeplätze
    for (i = 0; i < ents.length; i++) {
      e = ents[i];
      if (e.kind !== 'building' || e.dead || e.type === 'wall') continue;
      if (NEUT[e.type]) {
        if (!neutralShown(e, P, fogOff)) continue;
        x = e.x / TILE; z = e.y / TILE;
        drawNeutral(e, S, pid, fogOff, dt, inView(x, z));
        if (selSet[e.id]) selSquare.put(x, 0.04, z, 0, e.w * 0.62 + 0.08, 1, e.h * 0.62 + 0.08, 0.6, 1, 0.6);
        continue;
      }
      if (G.Sim.hidden(pid, e) || (e.owner !== pid && !fogOff && !G.Sim.isVisible(pid, e))) continue;
      Pm = S.players[e.owner]; M = model(e.type, Pm.faction, Pm.color);
      x = e.x / TILE; z = e.y / TILE;
      var age = tick - e.placedT + alpha, BUILD = (e.type === 'hq' && isDeployHq(e.id)) ? DEPLOY_B : 36;
      var sy = 1;
      if (age < BUILD) {
        var f = clamp(age / BUILD, 0, 1);
        sy = 0.06 + 0.94 * (1 - Math.pow(1 - f, 2));
        scaffold.put(x, 0, z, 0, e.w + 0.08, (M.h + 0.1) * (0.4 + 0.6 * f), e.h + 0.08, 1, 1, 1);
        if (rnd() < dt * 12 && inView(x, z)) emit(0, x + (rnd() - 0.5) * e.w, rnd() * M.h * sy, z + e.h / 2, 0, 0.5, 0, 0.2, 0.08, 0.02, 1, 0.9, 0.5, 1, 1, 0.5, 0.1, 0, -4);
      }
      var hf = e.hp / e.maxHp, dk = hf < 0.35 ? 0.78 : 1;
      inV5 = inView(x, z);
      if (e.clk && cloakMark(e, pid, x, 0.05, z, Math.max(e.w, e.h) * 0.5, tick)) { pbMode = 1; drawBuildingInst(e, M, e.owner, x, z, e.tdir || 0, sy, dk, dk, dk); pbMode = 0; }   // v1.2 Tarnung: eigenes, unentdecktes Gebäude halbtransparent
      else if (e.offT > tick) { var okf = 0.92 + 0.08 * Math.sin(R.t * 17 + e.id); drawBuildingInst(e, M, e.owner, x, z, e.tdir || 0, sy, dk * 0.5 * okf, dk * 0.56 * okf, dk * 0.74 * okf); offFx(e, M, x, z, dt, inV5); }   // v1.2 lahmgelegt: kalt entsättigt, Lichter aus, Entladungen
      else drawBuildingInst(e, M, e.owner, x, z, e.tdir || 0, sy, dk, dk, dk);
      if (selSet[e.id]) selSquare.put(x, 0.04, z, 0, e.w * 0.62 + 0.08, 1, e.h * 0.62 + 0.08, 0.6, 1, 0.6);
      if (M.act) actDraw(e, M, x, z, sy, inV5, dt);   // GA: Produktion, Tor, Kran, Andocken, Auslastung
      if (!inView(x, z)) continue;
      dmgFx(e, M, x, z, hf, dt);   // GA: Schaden – feste Brandstellen (Rauch, Funken, Flammen)
      // Kraftwerk-Dampf (GA: Menge/Größe nach Auslastung des Besitzers, bei Strommangel stoßweise)
      if (M.steam && age > BUILD) {
        var ldS = Pm.pwrProd > 0 ? Math.min(1.25, Pm.pwrUse / Pm.pwrProd) : 0, lowS = Pm.pwrUse > Pm.pwrProd, rS = lowS ? (Math.sin(R.t * 3 + e.id) > 0.3 ? 9 : 0.5) : 1.5 + 5 * ldS;
        for (var st = 0; st < M.steam.length; st++) if (rnd() < dt * rS * (R.safeGPU ? 0.6 : 1)) {
          var sp = M.steam[st], sk = 0.75 + 0.4 * ldS;
          emit(1, x + sp[0] + (rnd() - 0.5) * 0.2, sp[1], z + sp[2] + (rnd() - 0.5) * 0.2, 0.12 + rnd() * 0.08, (0.4 + rnd() * 0.25) * sk, 0.04, 2.2 + rnd() + ldS, 0.24 * sk, 0.8 * sk, 0.93, 0.94, 0.95, 0.55, 0.95, 0.96, 0.97, 0, 0, 0.25);
        }
      }
      if (e.repairing && rnd() < dt * 6) emit(0, x + (rnd() - 0.5) * e.w * 0.7, M.h * (0.4 + rnd() * 0.6), z + (rnd() - 0.5) * e.h * 0.7, 0, 0.8, 0, 0.35, 0.12, 0.04, 0.4, 1, 0.5, 1, 0.1, 0.6, 0.2, 0);
    }
    // --- erinnerte (nicht sichtbare) gegnerische Gebäude: grau
    if (!fogOff) {
      for (var id in P.mem) {
        var mm = P.mem[id], live = G.Sim.get(mm.id);
        if (NEUT[mm.type] || mm.type === 'wall') continue;
        if (live && !live.dead && G.Sim.isVisible(pid, live)) continue;
        inV5 = false;
        Pm = S.players[mm.owner]; M = model(mm.type, Pm.faction, Pm.color);
        drawBuildingInst(mm, M, mm.owner, mm.tx + mm.w / 2, mm.ty + mm.h / 2, live ? (live.tdir || 0) : 0, 1, GREY, GREY, GREY * 1.05);
      }
    }
    // --- Einheiten
    var kr = Math.min(1, dt * 10);
    for (i = 0; i < ents.length; i++) {
      e = ents[i];
      if (e.kind !== 'unit' || e.dead || e.inside) continue;
      if (G.Sim.hidden(pid, e) || (e.owner !== pid && !fogOff && !G.Sim.isVisible(pid, e))) continue;
      x = (e.px + (e.x - e.px) * alpha) / TILE; z = (e.py + (e.y - e.py) * alpha) / TILE;
      var r = rs.get(e.id);
      if (!r) {
        r = { dir: e.dir || 0, tdir: e.tdir || 0, dust: 0, ph: hash(e.id, 1, 2) * 6.28, dep: e.moving ? 0 : 1, wasDep: 1, b0: -1e9, b1: -1e9, trk: 0, lx: x, lz: z,
          // Bewegung: Fahrwerk/Schritt (siehe vehDyn/drawInf)
          p0: hash(e.id, 4, 9) * 6.28, vf: 0, yr: 0, ld: e.dir || 0, pv: 0, pw: 0, rl: 0, rw: 0, gp: NaN, steer: 0, lf: e.fireT, hitT: -1e9, hitK: 1, lh: -1e9, mv: 0, kn: 0, fc: e.dir || 0 };
        rs.set(e.id, r);
      }
      r.dir = lerpAng(r.dir, e.dir, kr); r.tdir = lerpAng(r.tdir, e.tdir || 0, Math.min(1, dt * 14));
      Pm = S.players[e.owner]; M = model(e.type, e.fac || Pm.faction, Pm.color); s = SCALE[e.type] || 1;   // v1.0: Herkunftsfraktion, Farbe = Besitzer
      if (e.mcBy || e.magT > tick) k10Link(e, x, z, alpha, tick, selRing, pid, fogOff);   // v1.0 Gedankenkontrolle / Magnet (PLATZHALTER v1.0)
      pbMode = 0;
      if (e.clk && cloakMark(e, pid, x, (e.mc === 3 ? WL8 : groundAt(x, z)) + 0.04, z, (e.r || 8) / TILE * 1.4, tick)) pbMode = 1;   // v1.2 Tarnung: eigenes, unentdecktes Objekt halbtransparent
      if (e.stunT > tick) stunFx(e, M, x, (e.mc === 3 ? WL8 : groundAt(x, z)), z, s, dt, inView(x, z));   // v1.2 gelähmt: kreisende Psi-Fesseln
      if (M.v8u) { drawV8U(e, M, r, x, z, s, dt, tick, alpha, !!selSet[e.id], inView(x, z)); continue; }   // v0.8: Luftfahrzeuge (Flughöhe, Rotoren, Neigung) / Schiffe (Wasserlinie, Seegang, Türme)
      y = groundAt(x, z);
      if (e.pc === 4) y = Math.max(y, WL8 + 0.02) + 0.06 + 0.03 * Math.sin(R.t * 3 + e.id);   // v1.0 Schwebepanzer schwebt (auch über Wasser)
      if (e.magT > tick) y += 0.25 + 0.06 * Math.sin(R.t * 9);                             // v1.0 vom Magnet angehoben
      var hfu = e.hp / e.maxHp;
      if (INF[e.type]) {   // Bewegung: Schritt, Knien, Rückstoß (drawInf)
        drawInf(e, M, r, x, y, z, s, dt, tick, alpha);
        if (selSet[e.id]) selRing.put(x, y + 0.03, z, 0, 0.24, 1, 0.24, 0.6, 1, 0.6);
        continue;
      }
      // Bewegung: Wanne auf gefedertem Fahrwerk (Basis BVh = Gieren + Nicken + Wanken), alle Teile hängen an dieser Basis
      var cd = Math.cos(r.dir), sd = Math.sin(r.dir), own = e.owner, typ = e.type, hov = e.pc === 4;
      if (!M.dyn) dynInit(M, e, e.fac || Pm.faction);
      if (dt > 0) vehDyn(e, r, M, x, z, cd, sd, dt, tick, hov);
      var fa = tick - e.fireT + alpha, hfl = R.t - r.hitT, hc = hfl < 0.14 ? 1 + 0.5 * r.hitK * (1 - hfl / 0.14) : 1;
      var pitv = r.pv + (r.gp === r.gp ? r.gp : 0), rolv = r.rl;
      if (M.exhaust && r.vf < 0.05 && r.vf > -0.05) { y += 0.005 * Math.sin(R.t * 41 + r.p0) * s; rolv += 0.006 * Math.sin(R.t * 37 + r.p0); }   // Leerlauf: Motor zittert
      y += (Math.abs(r.pv) * 0.3 + Math.abs(rolv) * 0.2) * s;
      var tyaw = r.tdir;
      if (M.how) {            // Haubitze: stehend aufbauen (Rohr hebt sich, Sporne senken sich), in Fahrt einklappen
        if (e.moving) r.dep = Math.max(0, r.dep - dt * 2.2); else r.dep = Math.min(1, r.dep + dt);
        var dpS = r.dep * r.dep * (3 - 2 * r.dep);
        tyaw = lerpAng(r.dir, r.tdir, dpS);
      }
      if (fa < 12 && M.kick) { var ko = M.kick * 0.022 * s * Math.exp(-fa * 0.45) * Math.min(1, fa * 2); x -= Math.cos(tyaw) * ko; z -= Math.sin(tyaw) * ko; }   // Rückstoß schiebt das Fahrzeug kurz zurück
      basis(BVh, r.dir, pitv, rolv);
      partBatch('u', typ, own, 'hull', M).putM(x, y, z, BVh, s, hc, hc, hc);
      if (M.mcv) craneDraw(M, own, x, y, z, r.dir, 0);
      if (M.parts.glow) partBatch('u', typ, own, 'glow', M).putM(x, y, z, BVh, s, 1, 1, 1);
      for (var xi = 0; M.xp && xi < M.xp.length; xi++) {   // Räder drehen (und lenken vorn), Kettenstollen laufen (zurückgelegter Weg entlang der Fahrtrichtung)
        var xe = M.xp[xi], xbt = partBatch('u', typ, own, xe.p, M), xl = xe.x;
        if (xe.k === 'trk') { var pch = xe.pitch * s; xl = xe.x + ((((r.trk % pch) + pch) % pch) / s); }
        lv(BVh, xl, xe.y, xe.z, s);
        if (xe.k === 'wheel') {
          if (xe.x > 0.1 && r.steer) { spinY(BVy, BVh, -r.steer); spinZ(BVx, BVy, -r.trk / (xe.r * s)); } else spinZ(BVx, BVh, -r.trk / (xe.r * s));
          xbt.putM(x + P8[0], y + P8[1], z + P8[2], BVx, s, hc, hc, hc);
        } else if (xe.k === 'spin') {   // v1.2: Radarantenne dreht (Effektzeit; Pause → steht)
          spinY(BVx, BVh, R.t * (xe.w || 1.6) + r.p0); xbt.putM(x + P8[0], y + P8[1], z + P8[2], BVx, s, hc, hc, hc);
        } else xbt.putM(x + P8[0], y + P8[1], z + P8[2], BVh, s, hc, hc, hc);
      }
      if (M.hgS) hangarDraw(e, M, typ, own, x, y, z, BVh, s, tick, hc);   // v1.2 Schwarm-Träger: Waben belegt/leer/lädt
      lv(BVh, M.pivot[0], 0, M.pivot[1], s);
      var pxp = x + P8[0], pyp = y + P8[1], pzp = z + P8[2];
      spinY(BVt, BVh, r.dir - tyaw);
      if (M.how) {
        if (r.dep >= 1 && r.wasDep < 1 && inView(x, z)) { dust(x - cd * 0.55, y, z - sd * 0.55, 0.9); }
        r.wasDep = r.dep;
        partBatch('u', typ, own, 'turret', M).putM(pxp, pyp, pzp, BVt, s, hc, hc, hc);
        var hrc = fa < 11 ? M.recoil * s * rcl(fa, 11) * 1.25 : 0, hpit = HOW_TRAVEL + (HOW_EL - HOW_TRAVEL) * dpS;
        spinZ(BVx, BVt, hpit); lv(BVt, M.trun[0], M.trun[1], 0, s);
        partBatch('u', typ, own, 'barrel', M).putM(pxp + P8[0] - BVx[0] * hrc, pyp + P8[1] - BVx[1] * hrc, pzp + P8[2] - BVx[2] * hrc, BVx, s, hc, hc, hc);
        spinZ(BVx, BVh, -1.0 * (1 - dpS)); lv(BVh, M.spadeAt[0], M.spadeAt[1], 0, s);
        partBatch('u', typ, own, 'spades', M).putM(x + P8[0], y + P8[1], z + P8[2], BVx, s, hc, hc, hc);
      } else {
        if (M.parts.turret) partBatch('u', typ, own, 'turret', M).putM(pxp, pyp, pzp, BVt, s, hc, hc, hc);
        if (M.parts.tglow) {   // W10: Glühteile am Turm (Laserlinse / Blitzspule): Grundglühen + Aufblitzen beim Schuss (nst.v5T aus R3F)
          var tst = nst(e.id), tsince = R.t - tst.v5T, tfl = tsince < 0.6 ? Math.exp(-tsince * 6) : 0, tgn;
          if (M.tg === 'tesla') tgn = 0.85 + 0.35 * Math.sin(R.t * 9 + r.ph) * Math.sin(R.t * 5.3) + tfl * 2.2;
          else if (M.tg === 'coil') tgn = 0.8 + 0.25 * Math.sin(R.t * 3.1 + r.ph) + (fa < 10 ? 1.8 * (1 - fa / 10) : 0);   // v1.2 Spulenpanzer: Ringe blitzen beim Schuss
          else tgn = 0.95 + 0.25 * Math.sin(R.t * 2.4 + r.ph) + tfl * 2.4;
          partBatch('u', typ, own, 'tglow', M).putM(pxp, pyp, pzp, BVt, s, tgn, tgn, tgn);
          if (M.tg === 'tesla' && rnd() < dt * 5 * (R.safeGPU ? 0.4 : 1) && inView(x, z)) {   // Funken an der Elektrode
            var tsa = rnd() * 6.283;
            emit(0, pxp + Math.cos(tsa) * 0.05 * s, y + 0.84 * s, pzp + Math.sin(tsa) * 0.05 * s, Math.cos(tsa) * 0.4, 0.4 + rnd() * 0.5, Math.sin(tsa) * 0.4, 0.15 + rnd() * 0.1, 0.06, 0.02, 0.7, 0.85, 1, 1, 0.3, 0.4, 1, 0, -3);
          }
        }
        if (M.parts.barrel2) {   // Kolosspanzer: Zwillingsrohre mit eigenem Rückstoß (shot.barrel 0|1)
          var ra0 = (R.t - r.b0) * 15, ra1 = (R.t - r.b1) * 15, rk0 = ra0 < 9 ? M.recoil * s * rcl(ra0, 9) * 1.3 : 0, rk1 = ra1 < 9 ? M.recoil * s * rcl(ra1, 9) * 1.3 : 0;
          partBatch('u', typ, own, 'barrel', M).putM(pxp - BVt[0] * rk0, pyp - BVt[1] * rk0, pzp - BVt[2] * rk0, BVt, s, hc, hc, hc);
          partBatch('u', typ, own, 'barrel2', M).putM(pxp - BVt[0] * rk1, pyp - BVt[1] * rk1, pzp - BVt[2] * rk1, BVt, s, hc, hc, hc);
        } else if (M.parts.barrel) {
          var rc = fa < 8 ? M.recoil * s * rcl(fa, 8) * 1.3 : 0;
          partBatch('u', typ, own, 'barrel', M).putM(pxp - BVt[0] * rc, pyp - BVt[1] * rc, pzp - BVt[2] * rc, BVt, s, hc, hc, hc);
        }
      }
      if (M.parts.cargo && e.cargo > 0) {
        var cf = clamp(e.cargo / 700, 0.08, 1);
        lv(BVh, M.cargoAt[0], M.cargoAt[1], 0, s);
        partBatch('u', typ, own, 'cargo', M).putMS(x + P8[0], y + P8[1], z + P8[2], BVh, s, s * cf, s, hc, hc, hc);
      }
      if (selSet[e.id]) selRing.put(x, y + 0.03, z, 0, e.r / TILE * 1.25 + 0.06, 1, e.r / TILE * 1.25 + 0.06, 0.6, 1, 0.6);
      if (!inView(x, z)) continue;
      var cls = !F3.tier();   // Sprite-Stufen: Staubfahne und Schadensqualm kommen aus r3-fx.js (ambient) – hier nur die klassische Stufe
      if (cls && e.moving && (r.dust += dt) > 0.12) { // Staub hinter Fahrzeugen
        r.dust = 0;
        emit(1, x - cd * 0.4 * s, y + 0.05, z - sd * 0.4 * s, -cd * 0.2, 0.15, -sd * 0.2, 0.9, 0.12, 0.4, 0.6, 0.55, 0.44, 0.4, 0.6, 0.55, 0.44, 0, 0, 1);
      }
      var xacc = r.pv > 0.035 && e.moving ? 1 : 0;   // Bewegung: beim Anfahren (Bug hebt sich) dunkler, kräftiger Abgasstoß
      if (M.exhaust && rnd() < dt * (e.moving ? 7 + 16 * xacc : 1.5) * (R.safeGPU ? 0.5 : 1)) {   // Abgasfahne aus dem Auspuff
        var ex = M.exhaust[(rnd() * M.exhaust.length) | 0], xg = xacc ? 0.14 : 0.3;
        emit(1, x + (cd * ex[0] - sd * ex[2]) * s, y + ex[1] * s, z + (sd * ex[0] + cd * ex[2]) * s, -cd * 0.14, 0.32 + 0.25 * xacc, -sd * 0.14, 0.7 + rnd() * 0.4, 0.03 + 0.02 * xacc, 0.19 + 0.12 * xacc, xg, xg, xg, 0.5 + 0.2 * xacc, 0.42, 0.42, 0.42, 0, -0.12, 0.5);
      }
      if (cls && hfu < 0.4 && rnd() < dt * 7) emit(1, x, y + M.h * s, z, 0.1, 0.5, 0.03, 1.6, 0.12, 0.5, 0.12, 0.12, 0.12, 0.7, 0.3, 0.3, 0.3, 0, 0, 0.4);
      if (cls && hfu < 0.2 && rnd() < dt * 8) emit(0, x, y + M.h * s * 0.8, z, 0, 0.5, 0, 0.3, 0.2, 0.06, 1, 0.6, 0.2, 1, 0.9, 0.2, 0.05, 0);
    }
    pbMode = 0;
    if (S.charges && S.charges.length) chargeDraw(S, pid, fogOff, tick, dt, inView);   // v1.2 laufende Sprengladungen
    drawDeploy(S, alpha, dt, inView);
    // --- Wracks (verkohlt, sinken langsam ein)
    for (i = wrecks.length - 1; i >= 0; i--) {
      var w = wrecks[i], wa = R.t - w.t0;
      if (wa > w.life) { wrecks.splice(i, 1); continue; }
      if (w.kind === 'crash' || w.kind === 'sink') { if (!drawV8Wreck(w, wa, dt)) wrecks.splice(i, 1); continue; }   // v0.8
      if (w.kind === 'fall') { drawFall(w, wa); continue; }   // Bewegung: gefallener Infanterist
      M = model(w.type, w.fac, w.color);
      var sink = wa > w.life * 0.6 ? (wa - w.life * 0.6) / (w.life * 0.4) : 0, dkc = 0.22 + 0.2 * Math.max(0, 1 - wa * 2);
      if (w.kind === 'building') {
        var bsy = Math.max(0.02, 1 - wa / w.life * 1.2);
        partBatch('b', w.type, w.owner, 'body', M).put(w.x, -wa * 0.15, w.z, 0, 1, bsy * 0.6, 1, dkc, dkc * 0.95, dkc * 0.9);
        if (rnd() < dt * 10) emit(1, w.x + (rnd() - 0.5) * 1.5, 0.3, w.z + (rnd() - 0.5) * 1.5, 0.1, 0.6, 0, 2.5, 0.4, 1.2, 0.15, 0.14, 0.13, 0.7, 0.3, 0.3, 0.3, 0, 0, 0.3);
        continue;
      }
      s = SCALE[w.type] || 1;
      var wy = groundAt(w.x, w.z) - sink * 0.4 * s;
      // Bewegung: Wrack glüht kurz nach (Instanzfarbe), Turm wird abgesprengt (w.pop: Flughöhe, w.ox/w.oz: Versatz, w.spin), späte Nachexplosion (w.ckT)
      var hot = wa < 2.4 ? (1 - wa / 2.4) : 0, wr = dkc + 0.6 * hot * hot, wg = dkc * 0.95 + 0.17 * hot * hot, wb = dkc * 0.9;
      partBatch('u', w.type, w.owner, 'hull', M).put(w.x, wy, w.z, w.dir, s, s, s, wr, wg, wb);
      var wcd = Math.cos(w.dir), wsd = Math.sin(w.dir);
      if (w.pop && (!M.parts.turret || M.how)) w.pop = 0;
      var tf = w.pop ? Math.min(1, wa / 0.75) : 1, tpx = w.x + (wcd * M.pivot[0]) * s + (w.pop ? w.ox * tf : 0), tpz = w.z + (wsd * M.pivot[0]) * s + (w.pop ? w.oz * tf : 0);
      var tpy = wy - 0.03 + (w.pop ? w.pop * 4 * tf * (1 - tf) : 0), tya = w.tdir + 0.4 + (w.pop ? w.spin * tf : 0);
      if (w.pop && tf >= 1 && !w.landed) { w.landed = true; if (inView(tpx, tpz)) dust(tpx, wy, tpz, 0.45); }
      if (w.ckT && wa > w.ckT) { w.ckT = 0; if (inView(w.x, w.z)) F3.explosion(w.x + (rnd() - 0.5) * 0.2, wy + 0.3, w.z + (rnd() - 0.5) * 0.2, 0.42, false); }
      if (M.parts.turret) partBatch('u', w.type, w.owner, 'turret', M).put(tpx, tpy, tpz, tya, s, s, s, wr, wg, wb);
      if (M.how) partBatch('u', w.type, w.owner, 'barrel', M).putP(w.x + (wcd * M.pivot[0]) * s, wy + M.trun[1] * s, w.z + (wsd * M.pivot[0]) * s, w.tdir + 0.4, 0.3, dkc, dkc * 0.95, dkc * 0.9);
      else if (M.parts.barrel) partBatch('u', w.type, w.owner, 'barrel', M).put(tpx, tpy, tpz, tya, s, s, s, wr, wg, wb);
      if (M.parts.barrel2) partBatch('u', w.type, w.owner, 'barrel2', M).put(tpx, tpy, tpz, tya, s, s, s, wr, wg, wb);
      if (M.xp && M.xp.length) for (var wxi = 0; wxi < M.xp.length; wxi++) {
        var wxe = M.xp[wxi], wbt = partBatch('u', w.type, w.owner, wxe.p, M), wxp2 = w.x + (wcd * wxe.x - wsd * wxe.z) * s, wzp2 = w.z + (wsd * wxe.x + wcd * wxe.z) * s;
        if (wxe.k === 'wheel') wbt.putPS(wxp2, wy + wxe.y * s, wzp2, w.dir, 0.4 * wxi, s, dkc, dkc * 0.95, dkc * 0.9);
        else wbt.put(wxp2, wy + wxe.y * s, wzp2, w.dir, s, s, s, dkc, dkc * 0.95, dkc * 0.9);
      }
      if (wa < w.life * 0.7 && rnd() < dt * 9) emit(1, w.x, wy + 0.3, w.z, 0.1, 0.5, 0.03, 1.8, 0.15, 0.6, 0.1, 0.1, 0.1, 0.75, 0.28, 0.28, 0.28, 0, 0, 0.4);
      if (wa < w.life * 0.3 && rnd() < dt * 10) emit(0, w.x, wy + 0.25, w.z, 0, 0.5, 0, 0.3, 0.2, 0.06, 1, 0.6, 0.2, 1, 0.9, 0.2, 0.05, 0);
    }
    // --- Platzierungsvorschau
    updateGhost();
  }
  /** Alle Teile-Batches für dieses Frame abschließen (Kern ruft nach fill()). */
  function flush() {
    for (var i = 0; i < batchList.length; i++) batchList[i].flush();
    if (scaffold) scaffold.flush();
  }
  /** Neues Spiel/Karte: Render-Zustand leeren. */
  function reset() {
    ensureAux();
    rs.clear(); wrecks.length = 0; nrs.clear(); dplFx.length = 0;
  }
  function addWreck(w) { wrecks.push(w); if (wrecks.length > 60) wrecks.splice(0, wrecks.length - 60); }

  // ------------------------------------------------------------------ Platzierungs-Geist
  var ghost = null;
  function updateGhost() {
    var pl = V.placing;
    if (pl && (pl.tiles || pl.type === 'wall')) { if (ghost) ghost.group.visible = false; wallGhost(pl); return; }
    if (!pl || pl.tx == null) { if (ghost) ghost.group.visible = false; return; }
    var S = G.Sim.S, P = S.players[V.pid], bd = D.BUILDINGS[pl.type];
    if (!ghost) {
      ghost = { group: new THREE.Group(), meshes: {}, foot: null };
      var fc = document.createElement('canvas'); fc.width = fc.height = 32;
      var fg = fc.getContext('2d'); fg.fillStyle = '#ffffff'; fg.fillRect(0, 0, 32, 32); fg.clearRect(2, 2, 28, 28); fg.fillStyle = 'rgba(255,255,255,0.45)'; fg.fillRect(2, 2, 28, 28);
      var ft = new THREE.CanvasTexture(fc); ft.wrapS = ft.wrapT = THREE.RepeatWrapping; ft.magFilter = THREE.NearestFilter;
      var fm = MAT.foot.clone(); fm.map = ft;
      var pg = new THREE.PlaneGeometry(1, 1); pg.rotateX(-Math.PI / 2);
      ghost.foot = new THREE.Mesh(pg, fm); ghost.foot.renderOrder = 4;
      ghost.group.add(ghost.foot);
      R.scene.add(ghost.group);
    }
    var key = pl.type + P.color;
    if (!ghost.meshes[key]) {
      var M = model(pl.type, P.faction, P.color), g = new THREE.Group();
      for (var k in M.parts) {
        var mesh = new THREE.Mesh(M.parts[k], MAT.ghost);
        if (k === 'radar') mesh.position.set(M.radarAt[0], M.radarAt[1], M.radarAt[2]);
        mesh.renderOrder = 4;
        g.add(mesh);
      }
      if (M.xp) for (var xi = 0; xi < M.xp.length; xi++) { var xm = new THREE.Mesh(M.xparts[M.xp[xi].p], MAT.ghost); xm.position.set(M.xp[xi].x, M.xp[xi].y, M.xp[xi].z); xm.renderOrder = 4; g.add(xm); }
      ghost.meshes[key] = g; ghost.group.add(g);
    }
    for (var kk in ghost.meshes) ghost.meshes[kk].visible = kk === key;
    var cx = pl.tx + bd.w / 2, cz = pl.ty + bd.h / 2;
    ghost.meshes[key].position.set(cx, 0.02, cz);
    ghost.foot.position.set(cx, 0.06, cz);
    ghost.foot.scale.set(bd.w, 1, bd.h);
    ghost.foot.material.map.repeat.set(bd.w, bd.h);
    ghost.foot.material.color.set(pl.ok ? '#22c55e' : '#ef4444');
    MAT.ghost.color.set(pl.ok ? '#bbf7d0' : '#fecaca');
    ghost.group.visible = true;
  }

  // ================================================================== v1.2 Modelle: eigene Modelle der v1.2-Einheiten/-Gebäude (ersetzen den look-Rückfall)
  // Einheiten (buildU12): Teile wie gewohnt (hull/turret/barrel/glow/tglow, xp-Räder/-Ketten); neu:
  //   xp k 'spin' (dreht um die eigene y-Achse, Rate xe.w rad/s – Radarantenne), M.alt2 (Mündung wechselt links/rechts, Flak-Doppellafetten),
  //   M.tg 'coil' (Turm-Glühteil blitzt bei e.fireT), M.sab (Saboteur: Teil chg = Ladung, nur ohne Nachladen sichtbar; chgl = Lampe nach sabMode/cd).
  // Kollektiv-Varianten im Formenkanon der Kollektiv-Gebäude (Palette KP: Perlmutt, dunkles Violett, Leuchtkristalle), Fahrzeuge ohne Räder auf Gleitkufen.
  var V12U = { flaktank: 1, saboteur: 1, radarcar: 1, submarine: 1, carrier: 1, carrierjet: 1, psidrone: 1, swarmling: 1, swarmcarrier: 1 };
  SCALE.flaktank = 1.05; SCALE.radarcar = 1.04; SCALE.saboteur = 1.9; SCALE.swarmcarrier = 1.05;
  LOD.submarine = 1; LOD.carrier = 1; LOD.carrierjet = 1; LOD.psidrone = 1; LOD.swarmcarrier = 1;
  GLOW_PARTS.hlamp = 1;
  var BH12 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  /** Träger-Plätze (M.hgS = [[x, y, z, Gieren], …], Teil M.hgP = Flugzeug/Drohne an Deck, M.hgL = Platzlampe): e.hg[i].id ≠ 0 → Platz leer (im Einsatz),
   *  t > tick → lädt (abgedunkelt, Lampe blinkt), sonst bereit. b9 = Basis des Rumpfs (Seegang/Fahrwerk). */
  function hangarDraw(e, M, type, own, x, y, z, b9, s, tick, dk) {
    var hb = partBatch('u', type, own, M.hgP, M), lb = partBatch('u', type, own, M.hgL, M), i, q, sl, ld, k, lk, t = R.t, L = M.hgLC;
    for (i = 0; i < M.hgS.length; i++) {
      q = M.hgS[i]; sl = e.hg ? e.hg[i] : null;
      lv(b9, q[0], q[1], q[2], s);
      var px = x + P8[0], py = y + P8[1], pz = z + P8[2];
      if (sl && sl.id) { lb.putM(px, py, pz, b9, s, L[0] * 0.12, L[1] * 0.12, L[2] * 0.12); continue; }   // im Einsatz: Platz leer, Lampe aus
      ld = sl && sl.t > tick; k = (ld ? 0.3 : 1) * dk;
      hb.putM(px, py, pz, q[3] ? spinY(BH12, b9, q[3]) : b9, s * (M.hgK || 1), k, k, k);
      if (ld) { lk = Math.sin(t * 5 + i * 1.7) > 0 ? 1.5 : 0.25; lb.putM(px, py, pz, b9, s, 1.6 * lk, 0.75 * lk, 0.15 * lk); }   // lädt: bernstein blinkend
      else { lk = 0.9 + 0.25 * Math.sin(t * 2 + i); lb.putM(px, py, pz, b9, s, L[0] * lk, L[1] * lk, L[2] * lk); }
    }
  }
  INF.saboteur = 1; DIE_SMALL.saboteur = 1; NOKNEEL.saboteur = 1;
  LOD.flaktank = 1; LOD.radarcar = 1; LOD.saboteur = 1;
  GLOW_PARTS.chgl = 1;
  /** Elevierter Zylinder (Rohr) von Punkt (x0, y0, z) in Richtung el (rad über der Waagerechten, Vorwärts +x), Länge len. */
  function elCyl(b, col, r0, r1, len, seg, x0, y0, z, el, off) {
    var o = off || 0, c = Math.cos(el), s = Math.sin(el);
    return b.add(new THREE.CylinderGeometry(r1, r0, len, seg || 6), col, x0 + c * (o + len / 2), y0 + s * (o + len / 2), z, 0, 0, el - Math.PI / 2);
  }
  /** Kettenlaufwerk wie trackSide, aber um xo entlang x versetzt (Halbkettenfahrzeug). */
  function trackAt(b, P, o, xo, z, sd) {
    var L = o.L, H = o.H, W = o.W, cap = H * 0.5, i, zo = z + sd * (W / 2);
    b.prism(P.track, [[xo - L - cap * 0.5, 0.0], [xo + L + cap * 0.5, 0.0], [xo + L + cap, cap * 0.6], [xo + L + cap * 0.7, H], [xo - L - cap * 0.7, H], [xo - L - cap, cap * 0.6]], W, 0, 0, z, 0, 0);
    var rr = o.rr || H * 0.34, n = o.n || 3, ry = rr + 0.012;
    for (i = 0; i < n; i++) b.rollr(P.dark, P.metal, rr, 0.026, xo - L + 2 * L * (n > 1 ? i / (n - 1) : 0.5), ry, zo, sd, 8);
    b.rollr(P.dark, P.metal, H * 0.44, 0.03, xo + L + cap * 0.55, H * 0.5, zo, sd, 8).rollr(P.dark, P.metal, H * 0.46, 0.03, xo - L - cap * 0.55, H * 0.5, zo, sd, 8);
  }
  /** Kollektiv-Gleitwanne: gestrecktes Achteck auf zwei Kufen mit Leuchtstreifen, Perlmuttschale, Teamband. L = halbe Länge, W = halbe Breite. */
  function kHull(b, g, T, L, W, h0, hgt) {
    var k = 1 / 0.924, sd;
    kOct(b, KP.base, 0.5, 0.5, hgt, 0, h0, 0, 2 * L * k * 0.92, 2 * W * k * 0.92);
    kOct(b, KP.shell, 0.5, 0.5, 0.04, 0, h0 + hgt, 0, 2 * L * k * 0.82, 2 * W * k * 0.8);
    b.add(new THREE.CylinderGeometry(0.5, 0.5, 0.035, 8, 1, true).rotateY(Math.PI / 8), T.team, 0, h0 + hgt - 0.03, 0, 0, 0, 0, 2 * L * k * 0.93, 1, 2 * W * k * 0.93);
    for (sd = -1; sd <= 1; sd += 2) {
      b.cylX(KP.base2, 0.055, 0.045, 2 * L * 0.9, 8, 0, 0.065, sd * W * 0.8);
      b.add(new THREE.ConeGeometry(0.055, 0.1, 8), KP.shell2, L * 0.9 + 0.05, 0.065, sd * W * 0.8, 0, 0, -Math.PI / 2);
      g.pbox(KP.glow2, 2 * L * 0.7, 0.008, 0.035, -0.02, 0.008, sd * W * 0.8);
    }
  }

  /** Rotationskörper entlang x (Bug +x): Profil [[Radius, x], …] von Heck nach Bug; sy = vertikale Stauchung. */
  function latheX(b, col, prof, seg, y, sy) {
    var v = prof.map(function (p) { return new THREE.Vector2(p[0], p[1]); });
    return b.add(new THREE.LatheGeometry(v, seg || 12), col, 0, y || 0, 0, 0, 0, -Math.PI / 2, sy || 1, 1, 1);
  }
  /** U-Boot: Ursprung = Wasserlinie (aufgetaucht). M.sub = Tauchtiefe (getaucht ragt nur der Turm heraus, siehe drawV8U). */
  function buildSub12(M, P, T, syn, hi, b, g) {
    var i, sd, HULL = syn ? '#3e4535' : '#2e3842', HULL2 = syn ? '#2f3429' : '#232b33', DK = syn ? '#5a5444' : '#3a4650';
    M.naval = 1; M.v8u = 'naval'; M.h = 0.32; M.sub = 0.2; M.recoil = 0; M.muzzle = [0.56, -0.03];
    if (!syn) {   // Koalition: Tropfenrumpf, hoher schmaler Turm mit Tiefenrudern, Kreuzleitwerk, Pumpjet
      latheX(b, HULL, [[0, -0.6], [0.03, -0.57], [0.07, -0.47], [0.1, -0.3], [0.112, -0.05], [0.112, 0.25], [0.1, 0.42], [0.075, 0.52], [0.04, 0.58], [0, 0.6]], 12, 0, 0.92);
      b.pbox(DK, 0.7, 0.012, 0.07, 0.02, 0.098, 0).pbox(T.team, 0.5, 0.006, 0.02, 0.0, 0.11, 0);
      b.prism(HULL, [[0.04, 0.08], [0.3, 0.08], [0.29, 0.2], [0.25, 0.27], [0.08, 0.27], [0.05, 0.22]], 0.07, 0, 0, 0, 0, 0.01);
      b.pbox(T.team, 0.215, 0.035, 0.074, 0.165, 0.21, 0).pbox(HULL2, 0.07, 0.012, 0.26, 0.2, 0.2, 0);
      b.cyl(P.metal, 0.008, 0.01, 0.1, 4, 0.1, 0.27, 0).cyl(P.dark, 0.006, 0.008, 0.08, 4, 0.14, 0.27, 0);
      b.prism(HULL2, [[-0.58, 0.02], [-0.44, 0.04], [-0.52, 0.17], [-0.59, 0.17]], 0.018, 0, 0, 0, 0, 0.004).pbox(T.team, 0.05, 0.025, 0.022, -0.555, 0.13, 0);
      b.pbox(HULL2, 0.1, 0.012, 0.32, -0.5, 0.0, 0).cylX(P.dark, 0.05, 0.045, 0.07, 10, -0.6, 0.0, 0);
      if (hi) { b.pbox(P.dark, 0.06, 0.004, 0.03, 0.42, 0.075, 0).pbox(P.dark, 0.06, 0.004, 0.03, -0.25, 0.1, 0); b.cyl(P.dark, 0.012, 0.012, 0.04, 6, 0.24, 0.27, 0.0); }
    } else {      // Syndikat: älteres Boot – Decksaufbau mit Holzdeck, Satteltanks, gestufter Turm mit Brücke, Deckgeschütz
      latheX(b, HULL, [[0, -0.6], [0.035, -0.55], [0.07, -0.4], [0.09, -0.15], [0.09, 0.25], [0.075, 0.45], [0.04, 0.56], [0, 0.6]], 10, 0, 0.9);
      for (sd = -1; sd <= 1; sd += 2) b.cylX(HULL2, 0.045, 0.045, 0.56, 8, 0.0, -0.01, sd * 0.07);
      b.box(HULL, 0.98, 0.05, 0.11, 0.0, 0.05, 0).pbox(DK, 0.96, 0.012, 0.09, 0.0, 0.1, 0);
      b.prism(HULL, [[0.42, 0.05], [0.6, 0.05], [0.6, 0.06], [0.42, 0.1]], 0.1, 0, 0, 0, 0, 0.004);
      b.box(HULL, 0.24, 0.1, 0.12, -0.02, 0.1, 0).box(HULL2, 0.15, 0.06, 0.1, -0.03, 0.2, 0).cylB(HULL, 0.06, 0.06, 8, 0.08, 0.1, 0, 0.008);
      b.pbox(T.team, 0.25, 0.03, 0.124, -0.02, 0.16, 0).pbox(P.rust, 0.16, 0.012, 0.104, -0.03, 0.26, 0);
      b.cyl(P.metal, 0.007, 0.009, 0.12, 4, -0.04, 0.26, 0.02).cyl(P.metal, 0.006, 0.008, 0.09, 4, -0.08, 0.26, -0.02);
      b.cylB(P.dark, 0.03, 0.03, 8, 0.25, 0.11, 0, 0.006).cylX(P.dark, 0.01, 0.009, 0.16, 6, 0.33, 0.15, 0).box(P.rust, 0.04, 0.05, 0.06, 0.25, 0.13, 0);
      b.prism(HULL2, [[-0.58, 0.02], [-0.46, 0.03], [-0.53, 0.13], [-0.59, 0.13]], 0.016, 0, 0, 0, 0, 0.004);
      b.pbox(HULL2, 0.08, 0.01, 0.26, -0.52, 0.0, 0);
      if (hi) { rivets(b, P.metal, -0.1, 0.06, 0.13, 0.062, 4); for (i = 0; i < 5; i++) b.pbox(P.metal, 0.006, 0.04, 0.006, -0.42 + i * 0.1, 0.1, 0.05); b.pbox(P.metal, 0.4, 0.004, 0.004, -0.22, 0.14, 0.05); }
    }
    g.ico(NAVL, 0.012, 0.1, 0.24, -0.04, 1, 1, 1, 0).ico(NAVR, 0.012, 0.1, 0.24, 0.04, 1, 1, 1, 0);
    M.wake = [0.6, -0.6, 0.12];
  }
  /** Flugzeugträger: Flugdeck, Insel (Steuerbord), drehendes Radar; 3 Plätze mit Jägern an Deck (M.hgS, hangarDraw). */
  function buildCarrier12(M, P, T, syn, hi, b, g, fac, color) {
    var i, k, sd, HULL = syn ? '#66705a' : '#8a96a1', DECK = syn ? '#57543f' : '#5d6870', FD = syn ? '#6d5f47' : '#454c53', MK = syn ? '#e6c14a' : '#e8e8e2', rd = new MB();
    M.naval = 1; M.v8u = 'naval'; M.h = 0.95; M.recoil = 0; M.muzzle = [0.4, 0.3];
    if (!syn) {   // Koalition: Superträger mit Schrägdeck, schlanke Insel mit Gittermast
      loftHull(b, HULL, DECK, [[-1.02, 0.2, 0.15, -0.05], [-0.7, 0.25, 0.155, -0.1], [0.2, 0.26, 0.16, -0.11], [0.7, 0.19, 0.17, -0.08], [1.0, 0.06, 0.18, -0.03], [1.1, 0.004, 0.185, 0.0]], T.team, 0.12, 0.32);
      wing(b, FD, [[-1.04, -0.36], [0.2, -0.36], [0.55, -0.26], [1.1, -0.12], [1.12, 0.1], [0.75, 0.28], [-0.95, 0.28], [-1.04, 0.2]], 0.035, 0.155);
      for (i = 0; i < 8; i++) b.top(MK, -0.9 + i * 0.25, 0.0, -0.8 + i * 0.25, 0.0, 0.1915, 0.014);
      b.top('#e6b81c', -0.98, -0.02, 0.25, -0.33, 0.1915, 0.016).top('#e6b81c', -0.98, 0.13, 0.32, -0.2, 0.1915, 0.016);
      b.top(P.dark, 0.35, 0.05, 1.05, 0.05, 0.1915, 0.02).top(P.dark, 0.35, -0.1, 1.05, -0.1, 0.1915, 0.02);
      insignia(b, T, P, -0.6, 0.192, 0.12, 0.09, 0.09);
      b.box(P.body, 0.34, 0.2, 0.11, -0.2, 0.19, 0.225).box(P.body2, 0.22, 0.1, 0.12, -0.16, 0.39, 0.225).pbox(T.team, 0.35, 0.04, 0.114, -0.2, 0.32, 0.225);
      b.pbox(P.glass, 0.012, 0.035, 0.1, -0.05, 0.43, 0.225, 0, 0, 0.3).box(P.dark, 0.12, 0.03, 0.08, -0.27, 0.39, 0.225);
      b.cyl(P.metal, 0.01, 0.025, 0.24, 6, -0.16, 0.49, 0.225).pbox(P.metal, 0.01, 0.01, 0.18, -0.16, 0.66, 0.225);
      rd.pbox(P.dark, 0.03, 0.04, 0.03, 0, 0, 0).pbox(P.metal, 0.03, 0.06, 0.24, 0, 0.03, 0);
      M.xparts.rdr = rd.geo(false); M.xp.push({ p: 'rdr', x: -0.16, y: 0.73, z: 0.225, k: 'spin' });
      if (hi) { winS(b, null, P, -0.32, -0.08, 0.27, 0.281, 4, 0.03, 0.025, 0, 6); b.cylZ('#e8743a', 0.025, 0.08, 8, -0.5, 0.13, 0.27); b.cylZ('#e8743a', 0.025, 0.08, 8, 0.3, 0.13, 0.26); for (i = 0; i < 2; i++) b.pbox(P.dark, 0.16, 0.08, 0.006, -0.55 + i * 0.7, 0.07, 0.262 - i * 0.02); }
      M.exhaust = [[-0.25, 0.42, 0.225]];
      M.hgS = [[0.82, 0.19, 0.04, 0], [0.5, 0.19, 0.06, 0], [0.18, 0.19, 0.06, 0]];
    } else {      // Syndikat: älterer Träger mit geradem Holzdeck, kastige Insel mit zwei Schornsteinen, Nieten
      loftHull(b, HULL, DECK, [[-1.0, 0.22, 0.14, -0.05], [-0.6, 0.27, 0.145, -0.11], [0.3, 0.27, 0.15, -0.11], [0.75, 0.18, 0.16, -0.08], [1.05, 0.008, 0.18, 0.0]], P.rust, 0.1, 0.3);
      wing(b, FD, [[-1.02, -0.27], [0.9, -0.27], [1.02, -0.17], [1.02, 0.17], [0.9, 0.27], [-1.02, 0.27]], 0.035, 0.15);
      for (i = 0; i < 9; i++) b.top('#5e523c', -0.95 + i * 0.22, -0.25, -0.95 + i * 0.22, 0.25, 0.1865, 0.01);
      b.top(MK, -0.95, -0.22, 0.98, -0.22, 0.1865, 0.016).top(MK, -0.95, 0.15, 0.98, 0.15, 0.1865, 0.016).top(MK, 0.7, 0.0, 0.95, 0.0, 0.1865, 0.02);
      b.pbox(T.team, 0.3, 0.006, 0.14, -0.62, 0.186, -0.04);
      b.box(P.body, 0.38, 0.17, 0.12, -0.15, 0.185, 0.215).box(P.body2, 0.22, 0.09, 0.12, -0.08, 0.355, 0.215).box(P.rust, 0.24, 0.02, 0.13, -0.08, 0.445, 0.215);
      b.pbox(P.glass, 0.012, 0.03, 0.1, 0.031, 0.4, 0.215).pbox(T.team, 0.39, 0.035, 0.124, -0.15, 0.3, 0.215);
      for (i = 0; i < 2; i++) { k = -0.22 - i * 0.12; b.cyl(P.body2, 0.045, 0.05, 0.2, 8, k, 0.355, 0.215).cyl(P.rust, 0.052, 0.052, 0.04, 8, k, 0.555, 0.215); }
      b.cyl(P.rust, 0.01, 0.018, 0.22, 6, -0.04, 0.465, 0.215);
      rd.pbox(P.dark, 0.03, 0.04, 0.03, 0, 0, 0).pbox(P.rust, 0.02, 0.05, 0.18, 0, 0.03, 0);
      M.xparts.rdr = rd.geo(false); M.xp.push({ p: 'rdr', x: -0.04, y: 0.69, z: 0.215, k: 'spin' });
      if (hi) { rivets(b, P.metal, -0.8, 0.8, 0.1, 0.27, 10); rivets(b, P.metal, -0.8, 0.8, 0.1, -0.27, 10); b.cylZ(P.body2, 0.03, 0.12, 8, 0.4, 0.12, -0.27); }
      M.exhaust = [[-0.22, 0.6, 0.215], [-0.34, 0.6, 0.215]];
      M.hgS = [[0.78, 0.185, -0.02, 0], [0.48, 0.185, -0.04, 0], [0.18, 0.185, -0.04, 0]];
    }
    var hl = new MB(); hl.flat = true; hl.pbox('#ffffff', 0.04, 0.02, 0.04, -0.13, 0, 0.1).pbox('#ffffff', 0.04, 0.02, 0.04, -0.13, 0, -0.1); M.xparts.hlamp = hl.geo(false);
    M.xparts.hjet = model('carrierjet', fac, color).parts.hull;
    M.hgP = 'hjet'; M.hgL = 'hlamp'; M.hgK = 0.62; M.hgLC = [0.4, 1.4, 0.55];
    M.iconAdd = function (grp, mat) { for (var q = 0; q < M.hgS.length; q++) { var jm = new THREE.Mesh(M.xparts.hjet, mat); jm.position.set(M.hgS[q][0], M.hgS[q][1], M.hgS[q][2]); jm.scale.setScalar(M.hgK); grp.add(jm); } };
    g.ico(NAVL, 0.018, 0.1, 0.2, -0.28, 1, 1, 1, 0).ico(NAVR, 0.018, 0.1, 0.2, 0.28, 1, 1, 1, 0).ico(STROBE, 0.02, -0.16, syn ? 0.6 : 0.8, 0.225, 1, 1, 1, 0);
    M.wake = [1.08, -1.0, 0.32];
  }
  /** Trägerjäger: kleiner Strahljäger (Ursprung = Fahrwerk), Nachbrenner als Glühteil. */
  function buildJet12(M, P, T, syn, hi, b, g) {
    M.air = 1; M.fixed = 1; M.h = 0.24; M.pods = 1; M.recoil = 0; M.v8u = 'air';
    if (!syn) {   // Koalition: Delta mit Entenflügeln, ein Triebwerk, ein Seitenleitwerk
      b.prism(P.body, [[-0.33, 0.035], [0.18, 0.03], [0.36, 0.06], [0.3, 0.08], [0.12, 0.105], [-0.3, 0.095], [-0.35, 0.065]], 0.09, 0, 0, 0);
      b.prism(P.glass, [[0.07, 0.09], [0.24, 0.07], [0.16, 0.12], [0.05, 0.125]], 0.06, 0, 0, 0, 0, 0.004);
      wing(b, P.body2, symZ([[0.08, 0.04], [-0.2, 0.25], [-0.28, 0.25], [-0.27, 0.04]]), 0.014, 0.05);
      wing(b, T.team, [[-0.2, 0.2], [-0.215, 0.256], [-0.285, 0.256], [-0.28, 0.2]], 0.017, 0.049); wing(b, T.team, [[-0.2, -0.2], [-0.28, -0.2], [-0.285, -0.256], [-0.215, -0.256]], 0.017, 0.049);
      wing(b, P.body2, symZ([[0.22, 0.04], [0.16, 0.11], [0.12, 0.11], [0.13, 0.04]]), 0.01, 0.075);
      b.prism(P.body, [[-0.33, 0.09], [-0.18, 0.09], [-0.29, 0.24], [-0.34, 0.24]], 0.014, 0, 0, 0, 0, 0.003).pbox(T.team, 0.06, 0.03, 0.016, -0.31, 0.2, 0);
      b.cylX(P.dark, 0.034, 0.03, 0.06, 8, -0.37, 0.065, 0);
      if (hi) b.cylX(P.metal, 0.006, 0.006, 0.05, 4, 0.38, 0.06, 0);
      g.ico('#ffb46a', 0.026, -0.405, 0.065, 0, 1.4, 1, 1, 0).ico(NAVL, 0.012, -0.26, 0.055, -0.255, 1, 1, 1, 0).ico(NAVR, 0.012, -0.26, 0.055, 0.255, 1, 1, 1, 0);
      M.exhaust = [[-0.41, 0.065, 0]]; M.muzzle = [-0.05, 0.035]; M.mz2 = 0.16;
    } else {      // Syndikat: Pfeilflügel, zwei Triebwerke, Doppelleitwerk, seitliche Lufteinläufe
      b.prism(P.body, [[-0.34, 0.035], [0.2, 0.035], [0.37, 0.06], [0.32, 0.085], [0.14, 0.11], [-0.32, 0.105], [-0.36, 0.07]], 0.11, 0, 0, 0);
      b.prism(P.glass, [[0.1, 0.095], [0.26, 0.075], [0.18, 0.125], [0.08, 0.13]], 0.065, 0, 0, 0, 0, 0.004);
      for (var sd = -1; sd <= 1; sd += 2) { b.box(P.body2, 0.2, 0.06, 0.04, 0.0, 0.04, sd * 0.07).cylX(P.dark, 0.03, 0.028, 0.06, 8, -0.38, 0.07, sd * 0.035); b.prism(P.body2, [[-0.33, 0.1], [-0.2, 0.1], [-0.3, 0.22], [-0.35, 0.22]], 0.012, 0, 0, sd * 0.06, 0, 0.003); b.pbox(T.team, 0.05, 0.03, 0.014, -0.32, 0.18, sd * 0.06); }
      wing(b, P.body2, symZ([[0.06, 0.05], [-0.14, 0.27], [-0.22, 0.27], [-0.18, 0.05]]), 0.016, 0.05);
      wing(b, T.team, [[-0.13, 0.22], [-0.145, 0.275], [-0.225, 0.275], [-0.2, 0.22]], 0.019, 0.049); wing(b, T.team, [[-0.13, -0.22], [-0.2, -0.22], [-0.225, -0.275], [-0.145, -0.275]], 0.019, 0.049);
      wing(b, P.body2, symZ([[-0.24, 0.05], [-0.32, 0.14], [-0.37, 0.14], [-0.35, 0.05]]), 0.012, 0.07);
      if (hi) { b.pbox(P.rust, 0.12, 0.012, 0.11, 0.0, 0.11, 0); rivets(b, P.metal, -0.2, 0.15, 0.08, 0.056, 4); }
      g.ico('#ffb46a', 0.022, -0.415, 0.07, 0.035, 1.4, 1, 1, 0).ico('#ffb46a', 0.022, -0.415, 0.07, -0.035, 1.4, 1, 1, 0).ico(NAVL, 0.012, -0.18, 0.06, -0.275, 1, 1, 1, 0).ico(NAVR, 0.012, -0.18, 0.06, 0.275, 1, 1, 1, 0);
      M.exhaust = [[-0.42, 0.07, 0.035], [-0.42, 0.07, -0.035]]; M.muzzle = [-0.02, 0.04]; M.mz2 = 0.17;
    }
  }
  /** Kollektiv-Flieger: Psi-Drohne (Kristallkern in drei Perlmuttschalen, kreisender Ring, Emitter unten) bzw. Schwarmdrohne (Kristallpfeil). */
  function buildKAir12(type, M, T, hi, b, g) {
    var i, a, rg = new MB();
    M.air = 1; M.v8u = 'air'; M.pulse = 1; M.recoil = 0;
    if (type === 'psidrone') {
      g.ico(KP.glow2, 0.085, 0, 0.33, 0, 1, 1.7, 1, 0).ico('#ffffff', 0.035, 0, 0.34, 0, 1, 1.5, 1, 0);
      for (i = 0; i < 3; i++) {
        a = i * 2.094 + 0.5;
        b.add(new THREE.SphereGeometry(0.1, 8, 6), KP.shell, Math.cos(a) * 0.13, 0.33, Math.sin(a) * 0.13, -a, 0, -0.38, 0.45, 1.75, 0.95);
        b.add(new THREE.SphereGeometry(0.1, 6, 4), T.team, Math.cos(a) * 0.168, 0.22, Math.sin(a) * 0.168, -a, 0, -0.5, 0.25, 0.5, 0.6);
      }
      b.cylB(KP.base, 0.11, 0.06, 8, 0, 0.13, 0, 0.012).cylB(KP.base2, 0.06, 0.06, 8, 0, 0.47, 0, 0.01);
      b.add(new THREE.ConeGeometry(0.05, 0.12, 6), KP.base2, 0, 0.07, 0, 0, Math.PI, 0);
      g.ico(KP.glow, 0.03, 0, 0.02, 0, 1, 1, 1, 0).ico(KP.glow, 0.025, 0, 0.55, 0, 1, 1.4, 1, 0);
      kTor(rg, KP.shell2, 0.25, 0.012, 0, 0, 0, 4, 20);
      for (i = 0; i < 3; i++) { a = i * 2.094; rg.ico(T.team, 0.035, Math.cos(a) * 0.25, 0, Math.sin(a) * 0.25, 1, 1.5, 1, 0); }
      M.xparts.kring = rg.geo(false); M.xp.push({ p: 'kring', x: 0, y: 0.33, z: 0, k: 'kspin', d: 1 });
      M.h = 0.55; M.muzzle = [0.0, 0.02];
    } else {   // Schwarmdrohne
      M.fixed = 1;
      b.ico(KP.shell, 0.06, 0.02, 0.065, 0, 2.6, 0.75, 1.0, 0).ico(KP.base2, 0.042, -0.1, 0.065, 0, 1.7, 0.8, 0.95, 0);   // Kristallkörper
      for (i = -1; i <= 1; i += 2) {                                                                                      // zwei Kristallklingen nach hinten außen
        b.add(new THREE.ConeGeometry(0.026, 0.2, 4), KP.shell2, -0.065, 0.065, i * 0.09, 0, i * Math.PI / 2, 0.46);
        b.ico(T.team, 0.022, -0.11, 0.065, i * 0.18, 1, 1, 1, 0);
      }
      g.ico(KP.glow2, 0.026, 0.12, 0.07, 0, 1, 1, 1, 0).ico(KP.glow, 0.028, -0.16, 0.065, 0, 1.4, 1, 1, 0);
      M.h = 0.14; M.muzzle = [0.16, 0.06]; M.exhaust = null;
    }
  }

  function buildU12(type, fac, color) {
    var P = PAL[fac] || PAL.coalition, T = teamCols(color), syn = fac === 'syndicate', kol = fac === 'kollektiv', hi = HI();
    var M = { parts: {}, xparts: {}, xp: [], pivot: [0, 0], recoil: 0, muzzle: [0.3, 0.3], h: 0.45, lo: !hi };
    var b = new MB(), t = new MB(), r = new MB(), g = new MB(), tg = new MB(), c = new MB(), i, sd, k, x, wr, el, sx, sy;
    if (type === 'flaktank') {
      if (kol) {                                                      // Spulenpanzer: Gleitwanne, Perlmuttkuppel, drei Spulen-Emitter (Leuchtringe)
        kHull(b, g, T, 0.46, 0.27, 0.1, 0.13);
        for (sd = -1; sd <= 1; sd += 2) b.prism(KP.shell2, [[-0.5, 0.22], [-0.3, 0.22], [-0.44, 0.44], [-0.52, 0.44]], 0.03, 0, 0, sd * 0.13, 0, 0.006);
        b.dome(KP.base2, 0.12, -0.3, 0.27, 0, 1.2, 0.6, 1.4, 8); g.ico(KP.glow, 0.035, -0.4, 0.3, 0, 1, 0.8, 1, 0);
        if (hi) for (sd = -1; sd <= 1; sd += 2) g.pbox(KP.glow, 0.012, 0.03, 0.12, 0.43, 0.17, sd * 0.1);
        t.cylB(KP.base2, 0.17, 0.07, 8, 0, 0.27, 0, 0.012).dome(KP.shell, 0.15, -0.02, 0.33, 0, 1.1, 0.9, 1, 12);
        tg.add(new THREE.CylinderGeometry(0.175, 0.175, 0.02, 12, 1, true), KP.glow, 0, 0.335, 0);
        t.box(T.team, 0.12, 0.03, 0.2, -0.08, 0.44, 0);
        el = 0.72;
        for (i = -1; i <= 1; i++) {
          var cz = i * 0.12, cx0 = 0.02 - Math.abs(i) * 0.04, cy0 = 0.42 - Math.abs(i) * 0.05, ln = 0.46 - Math.abs(i) * 0.08;
          elCyl(r, KP.base, 0.05, 0.04, 0.1, 6, cx0, cy0, cz, el);
          elCyl(r, KP.shell, 0.034, 0.016, ln, 6, cx0, cy0, cz, el, 0.08);
          for (k = 0; k < 3; k++) elCyl(tg, KP.glow, 0.052 - k * 0.009, 0.052 - k * 0.009, 0.02, 10, cx0, cy0, cz, el, 0.13 + k * 0.1);
          tg.ico(KP.glow2, 0.036, cx0 + Math.cos(el) * (ln + 0.1), cy0 + Math.sin(el) * (ln + 0.1), cz, 1, 1, 1, 0);
        }
        M.pivot = [-0.04, 0]; M.muzzle = [0.02 + Math.cos(el) * 0.56, 0.42 + Math.sin(el) * 0.56]; M.recoil = 0; M.h = 0.85; M.tg = 'coil'; M.mz2 = 0.12; M.alt2 = 1;
      } else if (!syn) {                                              // Koalition: 6×6-Radwanne, schmaler Turm mit Feuerleitradar, zwei Zwillingslafetten seitlich
        wr = 0.088;
        M.xparts.wheel = wheelLite(wr, 0.07, P.track, P.metal, P.body2);
        [0.3, 0.02, -0.27].forEach(function (ax) { M.xp.push({ p: 'wheel', x: ax, y: wr, z: 0.245, k: 'wheel', r: wr }, { p: 'wheel', x: ax, y: wr, z: -0.245, k: 'wheel', r: wr }); });
        b.box(P.dark, 0.9, 0.07, 0.32, -0.01, 0.06, 0);
        b.prism(P.body, [[-0.48, 0.1], [0.36, 0.1], [0.51, 0.17], [0.44, 0.28], [-0.45, 0.28], [-0.49, 0.23]], 0.42, 0, 0, 0);
        b.prism(P.body2, [[0.38, 0.17], [0.52, 0.165], [0.53, 0.185], [0.45, 0.25], [0.38, 0.25]], 0.34, 0, 0, 0);
        for (sd = -1; sd <= 1; sd += 2) {
          b.box(P.body2, 0.86, 0.05, 0.08, -0.02, 0.185, sd * 0.245).pbox(T.team, 0.86, 0.02, 0.084, -0.02, 0.235, sd * 0.245);
          b.pbox(T.team, 0.62, 0.012, 0.04, -0.1, 0.28, sd * 0.17);
          if (hi) for (i = 0; i < 2; i++) b.pbox(P.glass, 0.04, 0.025, 0.006, 0.2 - i * 0.14, 0.24, sd * 0.212);
        }
        b.box(P.body2, 0.22, 0.03, 0.32, -0.36, 0.28, 0);
        for (i = 0; i < 3; i++) b.top(P.track, -0.45, -0.1 + i * 0.1, -0.27, -0.1 + i * 0.1, 0.311, 0.012);
        b.cyl(P.body2, 0.045, 0.045, 0.02, 8, 0.3, 0.28, 0.1).pbox(P.glass, 0.012, 0.025, 0.12, 0.45, 0.25, 0, 0, 0, -0.6);
        if (hi) { b.cyl(P.metal, 0.005, 0.007, 0.3, 4, -0.42, 0.28, 0.16).cyl(P.metal, 0.005, 0.007, 0.22, 4, -0.42, 0.28, -0.16); b.box(P.body2, 0.12, 0.06, 0.08, 0.15, 0.28, -0.15); }
        g.pbox(LAMPC, 0.02, 0.03, 0.05, 0.515, 0.19, 0.14).pbox(LAMPC, 0.02, 0.03, 0.05, 0.515, 0.19, -0.14).pbox(TAILC, 0.02, 0.025, 0.04, -0.49, 0.24, 0.16).pbox(TAILC, 0.02, 0.025, 0.04, -0.49, 0.24, -0.16);
        // Turm (Drehpunkt −0.06): schmaler Mittelblock, Radar hinten, Zapfengehäuse seitlich
        t.cyl(P.body2, 0.16, 0.16, 0.04, 10, 0, 0.28, 0);
        t.prism(P.body, [[-0.21, 0.32], [0.08, 0.32], [0.16, 0.36], [0.13, 0.47], [-0.16, 0.48], [-0.22, 0.43]], 0.22, 0, 0, 0);
        t.box(T.team, 0.18, 0.012, 0.18, -0.04, 0.475, 0).pbox(P.pan, 0.18, 0.004, 0.012, -0.04, 0.488, 0.05);
        t.pbox(P.dark, 0.05, 0.05, 0.05, 0.12, 0.4, 0).add(new THREE.CircleGeometry(0.02, 8), P.glass, 0.146, 0.425, 0, Math.PI / 2);
        for (sd = -1; sd <= 1; sd += 2) t.box(P.body2, 0.16, 0.12, 0.05, 0.0, 0.33, sd * 0.135);
        t.cyl(P.dark, 0.02, 0.025, 0.1, 6, -0.15, 0.48, 0);
        t.box(P.metal, 0.03, 0.15, 0.26, -0.15, 0.58, 0, 0, 0, 0.25).pbox(P.dark, 0.012, 0.13, 0.24, -0.135, 0.59, 0, 0, 0, 0.25);
        // Zwillingslafetten (Erhöhung fest 0.5 rad): Gehäuse + zwei Rohre je Seite
        el = 0.5; sx = 0.0; sy = 0.4;
        for (sd = -1; sd <= 1; sd += 2) {
          r.box(P.body, 0.18, 0.09, 0.09, sx + 0.04, sy - 0.06, sd * 0.205, 0, 0, el).pbox(T.team, 0.12, 0.012, 0.094, sx + 0.03, sy - 0.005, sd * 0.205, 0, 0, el);
          for (k = -1; k <= 1; k += 2) { elCyl(r, P.dark, 0.013, 0.011, 0.36, 6, sx, sy, sd * 0.205 + k * 0.025, el, 0.1); elCyl(r, P.metal, 0.019, 0.019, 0.04, 6, sx, sy, sd * 0.205 + k * 0.025, el, 0.44); }
        }
        M.pivot = [-0.06, 0]; M.muzzle = [sx + Math.cos(el) * 0.48, sy + Math.sin(el) * 0.48]; M.mz2 = 0.205; M.alt2 = 1; M.recoil = 0.035; M.h = 0.66; M.exhaust = [[-0.42, 0.3, 0.17]];
      } else {                                                        // Syndikat: Halbkette mit offener Vierlingslafette hinter Schutzschild
        wr = 0.095;
        M.xparts.wheel = wheelLite(wr, 0.075, P.track, P.rust, P.dark);
        M.xp.push({ p: 'wheel', x: 0.33, y: wr, z: 0.23, k: 'wheel', r: wr }, { p: 'wheel', x: 0.33, y: wr, z: -0.23, k: 'wheel', r: wr });
        var ht = { L: 0.17, H: 0.16, W: 0.13, n: 3, rr: 0.05, pitch: 0.06 };
        trackAt(b, P, ht, -0.2, 0.24, 1); trackAt(b, P, ht, -0.2, -0.24, -1);
        M.xparts.trk = treadGeo(2 * ht.L + ht.H * 0.6, ht.W * 0.8, ht.pitch, 0.004, P.dark);
        M.xp.push({ p: 'trk', x: -0.2, y: ht.H + 0.004, z: 0.24, k: 'trk', pitch: ht.pitch }, { p: 'trk', x: -0.2, y: ht.H + 0.004, z: -0.24, k: 'trk', pitch: ht.pitch });
        b.box(P.dark, 0.96, 0.06, 0.3, -0.02, 0.09, 0);
        b.prism(P.body, [[0.24, 0.13], [0.6, 0.13], [0.6, 0.25], [0.44, 0.31], [0.24, 0.31]], 0.34, 0, 0, 0);   // Motorhaube
        b.pbox(P.track, 0.012, 0.09, 0.22, 0.605, 0.15, 0);
        for (i = 0; i < 3; i++) b.pbox(P.dark, 0.14, 0.006, 0.012, 0.44, 0.27 + i * 0.012, -0.12 + i * 0.12, 0, 0, -0.35);
        b.box(P.body, 0.22, 0.22, 0.42, 0.13, 0.13, 0).box(P.body2, 0.04, 0.14, 0.42, 0.24, 0.31, 0, 0, 0, -0.25);   // Fahrerstand + Panzerscheibe
        b.pbox(P.glass, 0.012, 0.025, 0.3, 0.262, 0.38, 0, 0, 0, -0.25);
        for (sd = -1; sd <= 1; sd += 2) {
          b.box(P.body2, 0.22, 0.03, 0.1, 0.33, 0.2, sd * 0.23);
          b.box(P.body2, 0.56, 0.12, 0.03, -0.23, 0.2, sd * 0.215).pbox(T.team, 0.56, 0.03, 0.034, -0.23, 0.29, sd * 0.215);
          if (hi) rivets(b, P.metal, -0.48, 0.02, 0.25, sd * 0.232, 5);
        }
        b.box(P.body2, 0.6, 0.04, 0.4, -0.23, 0.18, 0);                                           // Ladefläche
        b.cyl(P.rust, 0.045, 0.045, 0.09, 8, -0.45, 0.22, 0.12).cyl(P.rust, 0.045, 0.045, 0.09, 8, -0.45, 0.22, -0.12).cyl(P.dark, 0.046, 0.046, 0.012, 8, -0.45, 0.31, 0.12);
        b.pbox(T.team, 0.2, 0.012, 0.3, 0.42, 0.3, 0);
        b.cylB(P.rust, 0.022, 0.2, 6, 0.2, 0.2, 0.2, 0.004);
        g.pbox(LAMPC, 0.02, 0.035, 0.05, 0.605, 0.2, 0.13).pbox(LAMPC, 0.02, 0.035, 0.05, 0.605, 0.2, -0.13).pbox(TAILC, 0.02, 0.025, 0.04, -0.54, 0.2, 0.17).pbox(TAILC, 0.02, 0.025, 0.04, -0.54, 0.2, -0.17);
        // Lafette (Drehpunkt −0.24): Drehscheibe, Sitz, geneigter Schutzschild
        t.cyl(P.dark, 0.17, 0.17, 0.035, 10, 0, 0.22, 0).box(P.body2, 0.12, 0.12, 0.16, 0.0, 0.255, 0);
        t.box(P.rust, 0.03, 0.17, 0.34, 0.14, 0.255, 0, 0, 0, 0.3).pbox(T.team, 0.034, 0.03, 0.34, 0.12, 0.41, 0, 0, 0, 0.3);
        t.box(P.dark, 0.08, 0.05, 0.1, -0.11, 0.255, 0).box(P.dark, 0.02, 0.1, 0.1, -0.15, 0.3, 0);
        // Vierling (Erhöhung 0.55): Wiege + 2 × 2 Rohre
        el = 0.55; sx = 0.0; sy = 0.4;
        r.box(P.body, 0.18, 0.11, 0.16, sx + 0.02, sy - 0.08, 0, 0, 0, el).box(P.rust, 0.06, 0.06, 0.18, sx - 0.06, sy - 0.12, 0, 0, 0, el);
        for (k = 0; k < 4; k++) {
          var oz = (k & 1 ? 1 : -1) * 0.05, on = (k & 2 ? 1 : -1) * 0.028, nx = -Math.sin(el) * on, ny = Math.cos(el) * on;
          elCyl(r, P.dark, 0.012, 0.011, 0.38, 6, sx + nx, sy + ny, oz, el, 0.06); if (hi) elCyl(r, P.dark, 0.017, 0.017, 0.04, 6, sx + nx, sy + ny, oz, el, 0.42);
        }
        M.pivot = [-0.24, 0]; M.muzzle = [sx + Math.cos(el) * 0.46, sy + Math.sin(el) * 0.46]; M.mz2 = 0.05; M.alt2 = 1; M.recoil = 0.03; M.h = 0.62; M.exhaust = [[0.2, 0.42, 0.2]];
      }
    } else if (type === 'radarcar') {
      var rd = new MB();
      if (kol) {                                                      // Psi-Sensor: Gleitwanne, Stiel mit schwebendem Auge, kreisende Ringe
        kHull(b, g, T, 0.42, 0.25, 0.1, 0.12);
        b.dome(KP.shell2, 0.16, 0.12, 0.26, 0, 1.4, 0.55, 1.1, 10).dome(KP.base2, 0.1, -0.28, 0.26, 0, 1.2, 0.7, 1.3, 8);
        b.cyl(KP.base2, 0.06, 0.09, 0.08, 8, -0.1, 0.26, 0).cyl(KP.shell2, 0.022, 0.04, 0.36, 6, -0.1, 0.32, 0);
        for (sd = -1; sd <= 1; sd += 2) b.add(new THREE.ConeGeometry(0.03, 0.2, 5), KP.shell, -0.1 + 0.04, 0.4, sd * 0.06, 0, 0, sd * 0.35);
        g.ico(KP.glow2, 0.075, -0.1, 0.78, 0, 1, 1.25, 1, 1).ico('#ffffff', 0.03, -0.065, 0.79, 0, 1, 1, 1, 0);
        if (hi) g.pbox(KP.glow, 0.012, 0.03, 0.14, 0.4, 0.17, 0);
        kTor(rd, T.team, 0.17, 0.016, 0, 0, 0, 4, 18); rd.add(new THREE.TorusGeometry(0.13, 0.012, 4, 16), KP.shell, 0, 0, 0, 0, Math.PI / 2 - 0.7, 0);
        for (i = 0; i < 3; i++) { var ra = i * 2.094; rd.ico(KP.shell2, 0.025, Math.cos(ra) * 0.17, 0, Math.sin(ra) * 0.17, 1, 1.6, 1, 0); }
        M.xparts.rdr = rd.geo(false); M.xp.push({ p: 'rdr', x: -0.1, y: 0.78, z: 0, k: 'spin', w: 1.1 });
        M.h = 0.95;
      } else if (!syn) {                                              // Koalition: 4×4-Radfahrzeug mit Aufbau, Teleskopmast, drehende Flachantenne
        wr = 0.1;
        M.xparts.wheel = wheelLite(wr, 0.08, P.track, P.metal, P.body2);
        [0.27, -0.24].forEach(function (ax) { M.xp.push({ p: 'wheel', x: ax, y: wr, z: 0.235, k: 'wheel', r: wr }, { p: 'wheel', x: ax, y: wr, z: -0.235, k: 'wheel', r: wr }); });
        b.box(P.dark, 0.86, 0.07, 0.32, 0, 0.07, 0);
        b.prism(P.body, [[0.06, 0.12], [0.38, 0.12], [0.47, 0.2], [0.42, 0.33], [0.06, 0.35]], 0.42, 0, 0, 0);
        b.prism(P.glass, [[0.37, 0.27], [0.44, 0.245], [0.4, 0.325], [0.34, 0.34]], 0.36, 0, 0, 0, 0, 0.004);
        b.box(P.body2, 0.56, 0.27, 0.44, -0.2, 0.12, 0).box(T.team, 0.5, 0.015, 0.38, -0.2, 0.39, 0);
        insignia(b, T, P, -0.06, 0.405, 0, 0.06, 0.06);
        for (sd = -1; sd <= 1; sd += 2) {
          b.box(P.body, 0.24, 0.04, 0.09, 0.27, 0.2, sd * 0.235).box(P.body, 0.24, 0.04, 0.09, -0.24, 0.2, sd * 0.235);
          b.pbox(T.team, 0.54, 0.03, 0.006, -0.2, 0.3, sd * 0.222);
          b.pbox(P.dark, 0.12, 0.13, 0.006, -0.32, 0.16, sd * 0.222);                            // Seitentür
          if (hi) b.pbox(P.glass, 0.06, 0.04, 0.006, -0.08, 0.3, sd * 0.223);
        }
        b.pbox(P.dark, 0.04, 0.06, 0.34, 0.47, 0.1, 0);
        b.cylB(P.dark, 0.06, 0.05, 8, -0.24, 0.39, 0, 0.01).cyl(P.metal, 0.022, 0.03, 0.34, 6, -0.24, 0.44, 0).cyl(P.body2, 0.032, 0.032, 0.05, 6, -0.24, 0.6, 0);
        if (hi) { b.cyl(P.metal, 0.005, 0.007, 0.3, 4, 0.0, 0.39, 0.16).cyl(P.metal, 0.005, 0.007, 0.24, 4, -0.44, 0.39, -0.16); acUnit(b, P, -0.42, 0.39, 0.12, 0.1); }
        g.pbox(LAMPC, 0.02, 0.03, 0.05, 0.475, 0.2, 0.15).pbox(LAMPC, 0.02, 0.03, 0.05, 0.475, 0.2, -0.15).pbox(TAILC, 0.02, 0.025, 0.04, -0.48, 0.25, 0.17).pbox(TAILC, 0.02, 0.025, 0.04, -0.48, 0.25, -0.17);
        g.ico('#7ee7ff', 0.022, -0.24, 0.66, 0.0, 1, 1, 1, 0);
        // drehende Flachantenne (Ursprung = Mastspitze)
        var pa = 0.95, pc = Math.cos(pa), ps = Math.sin(pa);   // Flachantenne, um pa nach hinten geneigt (von oben gut lesbar)
        rd.box(P.dark, 0.05, 0.06, 0.05, 0, 0, 0).add(new THREE.BoxGeometry(0.035, 0.26, 0.46), P.body, -ps * 0.1, 0.05 + pc * 0.1, 0, 0, 0, pa);
        rd.add(new THREE.BoxGeometry(0.01, 0.22, 0.42), '#2c3d50', -ps * 0.1 + pc * 0.019, 0.05 + pc * 0.1 + ps * 0.019, 0, 0, 0, pa);
        for (i = 0; i < 4; i++) rd.add(new THREE.BoxGeometry(0.012, 0.012, 0.42), '#5d7a96', -ps * (0.02 + i * 0.05) + pc * 0.025, 0.05 + pc * (0.02 + i * 0.05) + ps * 0.025, 0, 0, 0, pa);
        rd.add(new THREE.BoxGeometry(0.04, 0.03, 0.47), T.team, -ps * 0.235, 0.05 + pc * 0.235, 0, 0, 0, pa);
        M.xparts.rdr = rd.geo(false); M.xp.push({ p: 'rdr', x: -0.24, y: 0.65, z: 0, k: 'spin', w: 2.2 });
        M.h = 0.9; M.exhaust = [[-0.3, 0.4, 0.2]];
      } else {                                                        // Syndikat: Sechsrad-Lkw mit Shelter und großer Parabolschüssel
        wr = 0.095;
        M.xparts.wheel = wheelLite(wr, 0.08, P.track, P.rust, P.dark);
        [0.33, -0.14, -0.35].forEach(function (ax) { M.xp.push({ p: 'wheel', x: ax, y: wr, z: 0.235, k: 'wheel', r: wr }, { p: 'wheel', x: ax, y: wr, z: -0.235, k: 'wheel', r: wr }); });
        b.box(P.dark, 1.0, 0.06, 0.3, -0.02, 0.1, 0);
        b.box(P.body, 0.26, 0.26, 0.42, 0.36, 0.14, 0).prism(P.body, [[0.49, 0.14], [0.55, 0.14], [0.55, 0.26], [0.49, 0.38]], 0.42, 0, 0, 0);
        b.prism(P.glass, [[0.49, 0.28], [0.525, 0.28], [0.49, 0.36], [0.48, 0.36]], 0.36, 0.012, 0, 0);
        b.box(P.rust, 0.28, 0.03, 0.44, 0.36, 0.4, 0).pbox(T.team, 0.18, 0.012, 0.3, 0.36, 0.43, 0);
        b.box(P.body2, 0.6, 0.3, 0.44, -0.22, 0.16, 0).box(P.rust, 0.62, 0.03, 0.46, -0.22, 0.46, 0);
        for (sd = -1; sd <= 1; sd += 2) {
          b.box(P.body2, 0.22, 0.03, 0.1, 0.33, 0.2, sd * 0.235).box(P.body2, 0.42, 0.03, 0.1, -0.25, 0.2, sd * 0.235);
          b.pbox(T.team, 0.6, 0.04, 0.006, -0.22, 0.38, sd * 0.222).pbox(P.dark, 0.1, 0.16, 0.006, -0.1, 0.18, sd * 0.222);
          if (hi) rivets(b, P.metal, -0.48, 0.04, 0.32, sd * 0.224, 6);
        }
        b.pbox(P.dark, 0.04, 0.08, 0.42, 0.56, 0.1, 0).cylB(P.rust, 0.025, 0.24, 6, 0.21, 0.2, 0.2, 0.004);
        // Drehkranz mit kurzem Gittermast
        b.cylB(P.dark, 0.1, 0.05, 8, -0.24, 0.49, 0, 0.01);
        if (hi) lattice(b, P.metal, -0.24, 0, 0.06, 0.03, 0.54, 0.7, 2, 0.016); else b.cyl(P.metal, 0.03, 0.05, 0.16, 6, -0.24, 0.54, 0);
        if (hi) b.cyl(P.dark, 0.006, 0.008, 0.26, 4, 0.26, 0.43, -0.16);
        g.pbox(LAMPC, 0.02, 0.04, 0.06, 0.555, 0.22, 0.16).pbox(LAMPC, 0.02, 0.04, 0.06, 0.555, 0.22, -0.16).pbox(TAILC, 0.02, 0.03, 0.05, -0.53, 0.25, 0.16).pbox(TAILC, 0.02, 0.03, 0.05, -0.53, 0.25, -0.16);
        g.ico('#ffb42e', 0.024, 0.36, 0.44, 0.15, 1, 0.8, 1, 1);
        // Parabolschüssel (Ursprung = Mastspitze), schräg nach oben geöffnet
        var de = 0.85;
        rd.box(P.dark, 0.06, 0.05, 0.06, 0, 0, 0).box(P.rust, 0.05, 0.12, 0.05, 0.03, 0.02, 0, 0, 0, -0.5);
        rd.add(new THREE.CylinderGeometry(0.26, 0.05, 0.09, 12, 1, true), P.metal, 0.09, 0.12, 0, 0, 0, de - Math.PI / 2 - Math.PI);
        rd.add(new THREE.CircleGeometry(0.255, 12), '#9aa0a4', 0.09 + Math.cos(de) * -0.04, 0.12 + Math.sin(de) * -0.04, 0, 0, 0, de - Math.PI / 2).add(new THREE.CircleGeometry(0.255, 12), P.body2, 0.09 + Math.cos(de) * -0.042, 0.12 + Math.sin(de) * -0.042, 0, 0, 0, de + Math.PI / 2);
        elCyl(rd, P.dark, 0.008, 0.008, 0.2, 4, 0.09, 0.12, 0, de - Math.PI, -0.2); rd.box(P.dark, 0.035, 0.035, 0.035, 0.09 + Math.cos(de) * 0.2 - 0.02, 0.12 + Math.sin(de) * 0.2 - 0.02, 0);
        rd.pbox(T.team, 0.03, 0.03, 0.18, 0.04, -0.02, 0);
        M.xparts.rdr = rd.geo(false); M.xp.push({ p: 'rdr', x: -0.24, y: 0.72, z: 0, k: 'spin', w: 1.4 });
        M.h = 0.98; M.exhaust = [[0.21, 0.46, 0.2]];
      }
    } else if (type === 'submarine') {
      buildSub12(M, P, T, syn, hi, b, g);
    } else if (type === 'carrier') {
      buildCarrier12(M, P, T, syn, hi, b, g, fac, color);
    } else if (type === 'carrierjet') {
      buildJet12(M, P, T, syn, hi, b, g);
    } else if (type === 'psidrone' || type === 'swarmling') {
      buildKAir12(type, M, T, hi, b, g);
    } else if (type === 'swarmcarrier') {
      kHull(b, g, T, 0.56, 0.34, 0.1, 0.15);
      kOct(b, KP.base2, 0.3, 0.33, 0.08, -0.06, 0.29, 0, 1.25, 1.05);
      for (sd = -1; sd <= 1; sd += 2) {
        b.prism(KP.shell2, [[-0.6, 0.25], [-0.36, 0.25], [-0.5, 0.52], [-0.6, 0.52]], 0.03, 0, 0, sd * 0.2, 0, 0.006);
        b.add(new THREE.ConeGeometry(0.035, 0.22, 5), KP.shell, 0.42, 0.3, sd * 0.16, 0, 0, -1.1);
      }
      b.dome(KP.shell2, 0.13, 0.38, 0.25, 0, 1.3, 0.7, 1.4, 10); g.ico(KP.glow2, 0.05, 0.5, 0.31, 0, 1.2, 0.8, 1.6, 0);
      var cells = [[0.1, 0.14], [0.1, -0.14], [-0.21, 0.14], [-0.21, -0.14]];
      M.hgS = [];
      for (i = 0; i < 4; i++) {
        var hx = cells[i][0], hz = cells[i][1];
        b.cyl(KP.shell, 0.135, 0.15, 0.1, 6, hx, 0.35, hz).cyl(KP.dark, 0.105, 0.105, 0.012, 6, hx, 0.448, hz);
        b.add(new THREE.CylinderGeometry(0.152, 0.152, 0.025, 6, 1, true), i & 1 ? T.team : T.teamD, hx, 0.4, hz);
        M.hgS.push([hx, 0.47, hz, 0]);
      }
      var hl = new MB(); hl.flat = true; hl.add(new THREE.CircleGeometry(0.112, 6), '#ffffff', 0, 0.004, 0, 0, -Math.PI / 2, 0); M.xparts.hlamp = hl.geo(false);   // Wabenboden leuchtet (belegt), blinkt (lädt), dunkel (leer)
      M.xparts.hdrone = model('swarmling', 'kollektiv', color).parts.hull;
      M.hgP = 'hdrone'; M.hgL = 'hlamp'; M.hgK = 1.15; M.hgLC = [0.95, 0.5, 1.35];
      if (hi) for (i = 0; i < 3; i++) g.pbox(KP.glow, 0.05, 0.012, 0.012, -0.05 - i * 0.12, 0.38, 0);
      M.h = 0.66;
    } else if (type === 'saboteur') {
      soldier(b, P, T, fac, 'engineer');
      if (kol) {                                                      // Infiltrator: Kapuze mit Leuchtschlitz, Umhang, Kristallladung
        b.dome(KP.base2, 0.068, 0.0, 0.27, 0, 1.05, 1.15, 1.1, 8).pbox(KP.dark, 0.03, 0.03, 0.07, 0.05, 0.275, 0);
        g.pbox(KP.glow2, 0.006, 0.012, 0.06, 0.066, 0.29, 0);
        b.prism(KP.base, [[-0.06, 0.26], [-0.02, 0.26], [-0.07, 0.04], [-0.13, 0.05]], 0.16, 0, 0, 0, 0, 0.004);
        b.pbox(T.team, 0.012, 0.03, 0.16, -0.045, 0.24, 0);
        c.cylB(KP.base2, 0.04, 0.05, 6, -0.12, 0.2, 0, 0.006);
        c.add(new THREE.ConeGeometry(0.03, 0.15, 5), KP.shell2, -0.12, 0.31, 0).add(new THREE.ConeGeometry(0.022, 0.11, 5), KP.shell, -0.13, 0.28, 0.035, 0, 0, 0.4).add(new THREE.ConeGeometry(0.022, 0.1, 5), KP.shell, -0.11, 0.28, -0.035, 0, 0, -0.4);
      } else if (!syn) {                                              // Koalition: Sturmhaube, Nachtsichtbrille, Tornister mit Sprengladung, Zünder in der Hand
        b.pbox('#23272c', 0.058, 0.06, 0.064, 0.012, 0.272, 0).dome('#2b3038', 0.062, 0.003, 0.29, 0, 1, 0.78, 1.04, 8);
        b.pbox(P.dark, 0.03, 0.024, 0.074, 0.05, 0.292, 0);
        g.pbox('#7dff9a', 0.006, 0.014, 0.022, 0.066, 0.293, 0.019).pbox('#7dff9a', 0.006, 0.014, 0.022, 0.066, 0.293, -0.019);
        b.box('#3f4537', 0.075, 0.14, 0.12, -0.095, 0.1, 0);
        c.box('#c8b88a', 0.06, 0.035, 0.11, -0.115, 0.24, 0).box('#bcab7c', 0.06, 0.035, 0.11, -0.115, 0.275, 0).pbox('#c0392b', 0.062, 0.006, 0.112, -0.115, 0.26, 0).pbox(P.dark, 0.03, 0.03, 0.04, -0.09, 0.31, 0.03);
      } else {                                                        // Syndikat: Kapuze, Halstuch, Patronengurt, Dynamitbündel mit Zeitzünder
        b.dome('#5b4a35', 0.068, 0.0, 0.272, 0, 1.05, 1.1, 1.1, 8).pbox('#3a3328', 0.05, 0.036, 0.066, 0.035, 0.258, 0);
        b.pbox(P.glass, 0.008, 0.012, 0.05, 0.062, 0.292, 0);
        b.pbox(P.dark, 0.11, 0.02, 0.03, 0.0, 0.17, 0, 0, 0.75).box('#4a3f2c', 0.07, 0.13, 0.12, -0.095, 0.1, 0);
        for (i = 0; i < 4; i++) c.cyl('#b3261e', 0.02, 0.02, 0.15, 6, -0.12 - (i & 1) * 0.03, 0.17, -0.045 + i * 0.03);
        c.pbox(P.dark, 0.07, 0.015, 0.13, -0.13, 0.2, 0).pbox(P.dark, 0.07, 0.015, 0.13, -0.13, 0.28, 0).box('#d8cfb4', 0.04, 0.04, 0.05, -0.1, 0.25, 0.0);
      }
      b.pbox(P.cloth, 0.045, 0.12, 0.045, 0.02, 0.12, 0.1).pbox(P.cloth, 0.12, 0.045, 0.045, 0.06, 0.2, -0.07, 0.45);   // Arme
      b.pbox(P.dark, 0.04, 0.06, 0.03, 0.03, 0.08, 0.11).cyl(P.metal, 0.004, 0.004, 0.06, 4, 0.04, 0.14, 0.11);   // Zünder
      M.parts.chg = c.geo(false);
      var cl = new MB(); cl.flat = true; cl.pbox('#ffffff', 0.024, 0.024, 0.024, -0.07, 0.22, 0.07); M.parts.chgl = cl.geo(false);
      M.parts.hull = b.geo(false); if (g.list.length) M.parts.glow = g.geo(false);
      M.muzzle = [0.1, 0.2]; M.h = 0.36; M.sab = 1; infLegs(M, P);
      return M;
    }
    M.parts.hull = b.geo();
    if (t.list.length) M.parts.turret = t.geo();
    if (r.list.length) M.parts.barrel = r.geo();
    if (g.list.length) M.parts.glow = g.geo(false);
    if (tg.list.length) M.parts.tglow = tg.geo(false);
    return M;
  }

  // ---- v1.2 Gebäude (buildB12): direkt für die Kamera aus Süd-West gebaut (Fronten Süd + West, M.mir = true → keine Spiegelung).
  // Reparaturdock (M.act.k 'repair': Arme/Laufkatze/Ring + Lampen, aktiv solange tick − repT < 20), Erzsilo (Teil ofill = Füllstand P.credits / P.oreCap),
  // Minenfeld (M.mine12: Teil mine je Ladung e.ch, sonst Krater), Tor (M.gate 'slide' | 'lift' | 'sink', e.open; Ausrichtung nach den Nachbarmauern).
  var V12B = { repairdock: [3, 2], oresilo: [2, 2], minefield: [1, 1], gate: [1, 1] };
  NOSHADOW.rlamp = 1; NOSHADOW.ofill = 1; NOSHADOW.rpool = 1;
  BH.repairdock = 1.1; BH.oresilo = 1.35; BH.minefield = 0.06; BH.gate = 0.85;
  LOD.repairdock = 1; LOD.oresilo = 1; LOD.minefield = 1; LOD.gate = 1;
  GLOW_PARTS.rlamp = 1; GLOW_PARTS.ofill = 1; GLOW_PARTS.rpool = 1; GLOW_PARTS.gfield = 1; GLOW_PARTS.mglow = 1;
  var ORE12 = '#f2b632';
  /** Roboterarm des Reparaturdocks (Ursprung = Drehfuß, Arm zeigt nach +x; Werkzeugspitze bei [0.52, 0.26]). */
  function repArm(P, T, col) {
    var a = new MB('bld');
    a.cylB(P.dark, 0.11, 0.08, 8, 0, 0, 0, 0.01).box(col, 0.16, 0.13, 0.16, 0, 0.08, 0).pbox(T.team, 0.166, 0.03, 0.166, 0, 0.2, 0);
    strut(a, col, 0, 0.18, 0, 0.17, 0.62, 0, 0.07); a.box(P.dark, 0.09, 0.09, 0.09, 0.17, 0.57, 0);
    strut(a, col, 0.17, 0.62, 0, 0.52, 0.44, 0, 0.055); a.box(P.dark, 0.07, 0.07, 0.07, 0.52, 0.4, 0);
    a.cyl(P.metal, 0.012, 0.03, 0.13, 6, 0.52, 0.28, 0).cyl(P.dark, 0.008, 0.008, 0.03, 4, 0.52, 0.25, 0);
    return a.geo();
  }
  function buildB12(type, fac, color) {
    var kol = fac === 'kollektiv', P = PAL[fac] || PAL.coalition, T = teamCols(color), syn = fac === 'syndicate', hi = HI();
    var b = new MB('bld'), g = new MB('bld'), M = { parts: {}, xparts: {}, xp: [], h: BH[type] || 1, mir: true, mirA: 1, lo: !hi, act: null, b12: type }, i, k, sd, x, z, m;
    var bd = D.BUILDINGS[type], w = bd.w, h = bd.h;
    if (type === 'repairdock') {
      var lamps = [[-0.52, 0.07, 0.72], [1.38, 0.07, 0.72], [-0.52, 0.07, -0.66], [1.38, 0.07, -0.66]];
      if (kol) {                                                      // Regenerator: Achteckbecken mit Leuchtflüssigkeit, drei Rippenbögen, schwebender Ring
        kPlate(b, T, w, h);
        kOct(b, KP.base, 0.75, 0.8, 0.1, 0.35, 0.06, 0, 1.3, 1.02); kBand(b, T.team, 0.81, 0.1, 0.05, 0.35, 0, 8);
        for (i = 0; i < 3; i++) {
          x = 0.35 + (i - 1) * 0.42;
          b.add(new THREE.TorusGeometry(0.6, 0.045, 5, 14, Math.PI), i === 1 ? KP.shell : KP.shell2, x, 0.16, 0, Math.PI / 2);
          b.ico(T.team, 0.05, x, 0.78, 0, 1, 0.8, 1, 0);
          for (sd = -1; sd <= 1; sd += 2) b.cylB(KP.base2, 0.08, 0.1, 6, x, 0.12, sd * 0.6, 0.01);
        }
        b.dome(KP.shell, 0.38, -1.02, 0.06, -0.2, 1, 0.95, 1.1, 12); kTor(b, T.team, 0.36, 0.035, -1.02, 0.2, -0.2, 4, 16);
        kSpire(b, g, -1.02, -0.2, 0.42, 0.55, 0.05);
        b.box(KP.base2, 0.3, 0.16, 0.3, -1.1, 0.06, 0.58).pbox(T.team, 0.32, 0.03, 0.32, -1.1, 0.22, 0.58); g.pbox(KP.glow, 0.2, 0.04, 0.012, -1.1, 0.12, 0.735);
        b.cylX(KP.base2, 0.045, 0.045, 0.6, 6, -0.62, 0.12, -0.2);
        m = new MB('bld'); m.flat = true; kOct(m, '#ffffff', 0.72, 0.72, 0.012, 0, 0, 0, 1.3, 1.02); M.xparts.rpool = m.geo(false);
        m = new MB('bld'); kTor(m, T.team, 0.5, 0.032, 0, 0, 0, 4, 20); for (i = 0; i < 4; i++) m.ico(KP.shell, 0.05, Math.cos(i * 1.571) * 0.5, 0, Math.sin(i * 1.571) * 0.5, 1, 1.6, 1, 0);
        M.parts.rring = m.geo();
        M.act = { k: 'repair', pool: [0.35, 0.165, 0], ring: [0.35, 0.98, 0], fx: [0.35, 0.2, 0] }; M.at = { rring: M.act.ring };
        M.h = 1.2;
      } else {                                                        // Koalition/Syndikat: Betonplatte mit Plus-Markierung, Portal hinten, Werkstatthaus West, Roboterarme
        slab(b, P, w, h, T);
        b.box(syn ? P.body : P.body2, 0.78, 0.5, 1.5, -1.06, 0.06, -0.1).box(P.roof, 0.84, 0.04, 1.56, -1.06, 0.56, -0.1).pbox(T.team, 0.84, 0.05, 0.03, -1.06, 0.5, 0.665);
        b.box(P.dark, 0.34, 0.34, 0.02, -1.0, 0.06, 0.656).pbox('#fbbf24', 0.38, 0.03, 0.025, -1.0, 0.4, 0.657);
        winE(b, g, P, -0.6, 0.3, 0.36, -1.452, 2, 0.14, 0.1, 0.6, 7, -1);
        if (hi) { acUnit(b, P, -1.2, 0.6, -0.4, 0.16); b.cyl(P.metal, 0.008, 0.01, 0.4, 4, -0.82, 0.6, -0.7); }
        insignia(b, T, P, -1.05, 0.602, 0.15, 0.14, 0.14);
        b.box('#55595d', 1.86, 0.02, 1.4, 0.45, 0.06, 0.0);
        hazardFrame(b, 0.45, 0.0, 1.7, 1.24, 0.06);
        b.top(T.teamL, 0.1, 0.0, 0.8, 0.0, 0.0815, 0.12).top(T.teamL, 0.45, -0.35, 0.45, 0.35, 0.0815, 0.12);   // Plus-Zeichen (Reparatur)
        var pc = syn ? P.rust : P.body;
        b.box(pc, 0.12, 0.98, 0.12, -0.42, 0.06, -0.8).box(pc, 0.12, 0.98, 0.12, 1.32, 0.06, -0.8).box(pc, 1.86, 0.12, 0.15, 0.45, 1.0, -0.8);
        b.pbox(T.team, 1.7, 0.05, 0.155, 0.45, 1.05, -0.8);
        if (syn) { for (i = 0; i < 6; i++) b.pbox(i % 2 ? '#facc15' : '#1f2937', 0.2, 0.04, 0.152, -0.25 + i * 0.3, 0.97, -0.8); b.cyl('#7a3b1c', 0.07, 0.07, 0.18, 8, 1.35, 0.06, 0.55).cyl('#3b4a2a', 0.07, 0.07, 0.18, 8, 1.2, 0.06, 0.65); if (hi) rivets(b, P.metal, -1.4, -0.7, 0.45, 0.66, 5); }
        else { b.box(P.body2, 0.3, 0.3, 0.2, 1.2, 0.06, -0.55).pbox(P.glass, 0.2, 0.08, 0.012, 1.2, 0.24, -0.448); b.cyl(P.dark, 0.05, 0.05, 0.24, 8, 1.36, 0.06, 0.52); }
        if (hi) { b.cyl(P.dark, 0.014, 0.014, 0.6, 4, 0.0, 0.42, -0.8).cyl(P.dark, 0.014, 0.014, 0.5, 4, 0.9, 0.5, -0.8); }   // Schläuche
        var ac = syn ? '#d97706' : '#e8c547';
        M.xparts.rarm = repArm(P, T, ac);
        var arms = [[-0.35, 0.06, 0.48], [1.25, 0.06, -0.46]];
        for (i = 0; i < 2; i++) arms[i].push(Math.atan2(0 - arms[i][2], 0.45 - arms[i][0]));
        M.act = { k: 'repair', arms: arms, fx: [0.45, 0.25, 0] };
        if (syn) {                                                     // Syndikat: zusätzlich Laufkatze mit Haken am Portal
          m = new MB('bld'); m.box(P.body2, 0.2, 0.12, 0.24, 0, 0.88, -0.8).cyl(P.dark, 0.006, 0.006, 0.5, 4, 0, 0.38, -0.8).box('#c2410c', 0.07, 0.06, 0.07, 0, 0.33, -0.8);
          M.xparts.rtrol = m.geo(); M.act.trol = [0.45, 0, 0];
        }
        M.h = 1.12;
      }
      m = new MB('bld'); m.flat = true; m.pbox('#ffffff', 0.08, 0.05, 0.08, 0, 0, 0); M.xparts.rlamp = m.geo(false);
      M.act.lamps = lamps;
      M.iconAdd = function (grp, mat) {   // Symbol: Arme/Laufkatze in Ruhestellung (Ring liegt in M.parts)
        var A = M.act, q, mm;
        if (A.arms) for (q = 0; q < A.arms.length; q++) { mm = new THREE.Mesh(M.xparts.rarm, mat); mm.position.set(A.arms[q][0], A.arms[q][1], A.arms[q][2]); mm.rotation.y = -(A.arms[q][3] + 0.6); grp.add(mm); }
        if (A.trol) { mm = new THREE.Mesh(M.xparts.rtrol, mat); mm.position.x = A.trol[0]; grp.add(mm); }
      };
    } else if (type === 'oresilo') {
      M.ofill = [];
      m = new MB('bld'); m.flat = true;
      if (kol) {                                                      // Erzspeicher: Achtecksockel, Rippenkäfig mit leuchtender Erzsäule, Perlmuttkappe
        kPlate(b, T, w, h);
        kOct(b, KP.base, 0.62, 0.68, 0.18, 0, 0.06, 0); kBand(b, T.team, 0.69, 0.16, 0.06, 0, 0, 8);
        b.cyl(KP.dark, 0.4, 0.4, 0.02, 10, 0, 0.24, 0);
        for (i = 0; i < 6; i++) {
          var ra = i * Math.PI / 3 + 0.26, rcx = Math.cos(ra), rcz = Math.sin(ra);
          strut(b, KP.shell, rcx * 0.46, 0.22, rcz * 0.46, rcx * 0.52, 0.7, rcz * 0.52, 0.06); strut(b, KP.shell, rcx * 0.52, 0.7, rcz * 0.52, rcx * 0.38, 1.14, rcz * 0.38, 0.06);
        }
        kTor(b, T.team, 0.5, 0.03, 0, 0.7, 0, 4, 18);
        b.dome(KP.shell2, 0.42, 0, 1.12, 0, 1, 0.5, 1, 12); g.ico(KP.glow, 0.07, 0, 1.36, 0, 1, 1.6, 1, 0);
        b.box(KP.base2, 0.28, 0.18, 0.24, -0.72, 0.06, 0.66, Math.PI / 4).pbox(T.team, 0.3, 0.03, 0.26, -0.72, 0.24, 0.66, Math.PI / 4);
        m.cyl('#ffffff', 0.34, 0.34, 1, 10, 0, 0, 0); M.ofill.push([0, 0.25, 0, 0.86]);
        M.h = 1.45;
      } else if (!syn) {                                              // Koalition: zwei Silos mit Füllstandsfenster, Pumpenhaus, Laufsteg
        slab(b, P, w, h, T);
        var sil = [[-0.36, -0.3, 0.36, 1.12], [0.42, 0.24, 0.3, 0.9]];
        for (i = 0; i < 2; i++) {
          x = sil[i][0]; z = sil[i][1]; var sr = sil[i][2], sh = sil[i][3], ga = 0.75 * Math.PI, gx = x + Math.cos(ga) * (sr + 0.005), gz = z + Math.sin(ga) * (sr + 0.005);
          b.cylB(P.conc, sr + 0.06, 0.1, 12, x, 0.06, z, 0.012).cyl(P.body, sr, sr, sh, 14, x, 0.16, z);
          b.lathe(P.body2, [[sr, 0], [sr * 0.75, sr * 0.3], [0.06, sr * 0.42], [0, sr * 0.42]], 14, x, 0.16 + sh, z);
          b.add(new THREE.CylinderGeometry(sr + 0.006, sr + 0.006, 0.07, 14, 1, true), T.team, x, 0.16 + sh * 0.82, z);
          b.box(P.dark, 0.12, sh * 0.78, 0.12, gx, 0.2, gz, -ga);
          b.box('#1c2a35', 0.086, sh * 0.76, 0.126, gx + Math.cos(ga) * 0.004, 0.21, gz + Math.sin(ga) * 0.004, -ga);
          for (k = 1; k < 4; k++) b.pbox(P.metal, 0.03, 0.01, 0.13, gx, 0.2 + sh * 0.78 * k / 4, gz, -ga);
          M.ofill.push([gx + Math.cos(ga) * 0.03, 0.22, gz + Math.sin(ga) * 0.03, sh * 0.74]);
          g.ico('#ff5a3a', 0.025, x, 0.16 + sh + sr * 0.44, z, 1, 1, 1, 0);
        }
        m.cyl('#ffffff', 0.036, 0.036, 1, 6, 0, 0, 0);
        b.box(P.body2, 0.42, 0.3, 0.32, -0.55, 0.06, 0.55).box(P.roof, 0.46, 0.03, 0.36, -0.55, 0.36, 0.55).pbox(T.team, 0.44, 0.04, 0.02, -0.55, 0.3, 0.712);
        b.pbox(P.dark, 0.14, 0.2, 0.012, -0.5, 0.06, 0.716);
        b.cylX(P.metal, 0.045, 0.045, 0.6, 8, -0.05, 0.24, 0.55).cylZ(P.metal, 0.04, 0.5, 8, -0.36, 0.24, 0.2);
        strut(b, P.dark, -0.12, 1.2, -0.2, 0.22, 1.0, 0.12, 0.05);
        if (hi) { for (k = 0; k < 7; k++) b.pbox(P.metal, 0.012, 0.012, 0.1, 0.06, 0.25 + k * 0.12, -0.3); acUnit(b, P, -0.55, 0.39, 0.5, 0.14); }
        M.h = 1.5;
      } else {                                                        // Syndikat: offener Erzbunker (Füllung von oben sichtbar), Schrägförderband, Nieten
        slab(b, P, w, h, T);
        var bx = 0.15, bz = -0.15;
        b.lathe(P.body, [[0.5, 0], [0.62, 0.66]], 10, bx, 0.12, bz).lathe(P.body2, [[0.58, 0.66], [0.46, 0.02]], 10, bx, 0.12, bz);   // Bunker offen: Außen- und Innenwand
        b.add(new THREE.TorusGeometry(0.61, 0.045, 4, 10), P.rust, bx, 0.79, bz, 0, Math.PI / 2, 0).cyl(P.dark, 0.48, 0.48, 0.02, 10, bx, 0.12, bz);
        for (i = 0; i < 6; i++) { var la = i * Math.PI / 3 + 0.3; b.box(P.dark, 0.07, 0.12, 0.07, bx + Math.cos(la) * 0.5, 0.06, bz + Math.sin(la) * 0.5); }
        b.add(new THREE.CylinderGeometry(0.585, 0.565, 0.06, 10, 1, true), T.team, bx, 0.6, bz);
        if (hi) for (i = 0; i < 10; i++) { var ra2 = i / 10 * Math.PI * 2; b.pbox(P.metal, 0.02, 0.02, 0.02, bx + Math.cos(ra2) * 0.6, 0.4, bz + Math.sin(ra2) * 0.6); }
        strut(b, P.dark, -0.8, 0.12, 0.72, -0.3, 0.86, 0.18, 0.13); strut(b, P.body2, -0.8, 0.17, 0.72, -0.3, 0.91, 0.18, 0.09);
        strut(b, P.dark, -0.55, 0.06, 0.45, -0.55, 0.5, 0.45, 0.04);
        b.box(P.body2, 0.3, 0.2, 0.26, -0.78, 0.06, 0.7).pbox(T.team, 0.32, 0.03, 0.28, -0.78, 0.26, 0.7);
        b.box(P.dark, 0.08, 0.5, 0.08, 0.82, 0.06, 0.62).box(P.rust, 0.18, 0.12, 0.14, 0.82, 0.56, 0.62);
        m.dome('#ffffff', 0.52, 0, 0, 0, 1, 0.42, 1, 10); m.ico('#ffffff', 0.12, 0.15, 0.12, 0.1).ico('#ffffff', 0.1, -0.2, 0.1, -0.12);
        M.ofill.push([bx, 0.13, bz, 0.6, 1]);
        M.h = 1.0;
      }
      M.xparts.ofill = m.geo(false);
      M.act = { k: 'silo12' };
    } else if (type === 'minefield') {                                 // Minenfeld: aufgewühlter Boden, je Ladung eine Minengruppe (sonst Krater)
      var soil = kol ? '#4d4458' : (syn ? '#5b4b38' : '#55503f');
      b.add(new THREE.CylinderGeometry(0.44, 0.47, 0.014, 9), soil, 0, 0.007, 0, 0.3, 0, 0, 1.08, 1, 0.94);
      for (i = 0; i < 6; i++) b.pbox(i % 2 ? '#6b6352' : '#4a4436', 0.05, 0.02, 0.04, (hsh(i * 3.1) - 0.5) * 0.7, 0.01, (hsh(i * 5.3) - 0.5) * 0.65, hsh(i));
      m = new MB('bld'); var mg = new MB('bld'), cr = new MB('bld');
      if (kol) {
        for (i = 0; i < 3; i++) { var ka = i * 2.1; m.add(new THREE.ConeGeometry(0.035, 0.14, 5), i ? KP.shell2 : KP.shell, Math.cos(ka) * 0.05, 0.03, Math.sin(ka) * 0.05, 0, Math.sin(ka) * 0.5, Math.cos(ka) * 0.5); }
        m.cylB(KP.base2, 0.07, 0.02, 6, 0, 0, 0, 0.005); mg.ico('#ffffff', 0.03, 0, 0.05, 0, 1, 1.4, 1, 0);
      } else if (!syn) {
        m.cylB('#4b5240', 0.08, 0.03, 10, 0, 0, 0, 0.008).cyl(T.team, 0.028, 0.028, 0.012, 8, 0, 0.03, 0).cylB('#4b5240', 0.06, 0.025, 10, 0.12, 0, 0.07, 0.006).cyl(T.teamD, 0.02, 0.02, 0.01, 8, 0.12, 0.025, 0.07);
        if (hi) m.pbox('#2a2e24', 0.002, 0.03, 0.002, -0.04, 0.03, 0.03);
      } else {
        m.cylB('#5a4a36', 0.09, 0.035, 8, 0, 0, 0, 0.008).cyl(P.rust, 0.04, 0.04, 0.012, 8, 0, 0.035, 0);
        for (i = 0; i < 3; i++) m.cyl(P.metal, 0.005, 0.005, 0.05, 4, Math.cos(i * 2.1) * 0.025, 0.04, Math.sin(i * 2.1) * 0.025);
        m.pbox(T.team, 0.03, 0.012, 0.09, 0.1, 0.0, -0.05);
      }
      if (syn && hi) { b.pbox(P.wood || '#7a5a3c', 0.025, 0.2, 0.025, 0.36, 0.0, -0.3, 0, 0, 0.2); b.pbox('#55595c', 0.36, 0.006, 0.006, 0.2, 0.1, -0.32, 0.3); }
      cr.flat = true; cr.add(new THREE.RingGeometry(0.03, 0.11, 9), '#221e1a', 0, 0.016, 0, 0, -Math.PI / 2, 0).add(new THREE.CircleGeometry(0.035, 7), '#3a342c', 0, 0.015, 0, 0, -Math.PI / 2, 0);
      M.xparts.mine = m.geo(); M.xparts.mcrat = cr.geo(false); if (mg.list.length) M.xparts.mglow = mg.geo(false);
      M.mine12 = [[-0.17, 0.014, -0.11], [0.15, 0.014, 0.13]];
      M.iconAdd = function (grp, mat) { for (var q = 0; q < M.mine12.length; q++) { var mm = new THREE.Mesh(M.xparts.mine, mat); mm.position.set(M.mine12[q][0], M.mine12[q][1], M.mine12[q][2]); mm.rotation.y = -q * 1.3; grp.add(mm); } };
      M.h = 0.08;
    } else if (type === 'gate') {                                     // Tor: zwei Pfeiler im Stil der Mauer, Torflügel (Koalition schiebt, Syndikat hebt, Kollektiv senkt ein Kraftfeld)
      var cc = syn ? P.body : P.conc, gl = new MB('bld');
      for (sd = -1; sd <= 1; sd += 2) {
        x = sd * 0.36;
        b.pbox('#6b6d6b', 0.3, 0.06, 0.4, x, 0, 0).box(cc, 0.24, 0.84, 0.32, x, 0.06, 0).pbox(T.team, 0.255, 0.09, 0.335, x, 0.5, 0);
        b.pbox(syn ? P.body2 : '#b9bcb8', 0.3, 0.06, 0.38, x, 0.9, 0).pbox(P.dark, 0.012, 0.36, 0.06, x - sd * 0.124, 0.1, 0.1);
        if (kol) { b.add(new THREE.ConeGeometry(0.07, 0.24, 5), KP.shell2, x, 0.96, 0).add(new THREE.ConeGeometry(0.045, 0.14, 5), KP.shell, x + sd * 0.06, 0.9, 0.06, 0, 0, -sd * 0.4); g.ico(KP.glow, 0.035, x, 0.84, 0.17, 1, 1, 1, 0); }
        else if (!syn) g.ico('#ffb42e', 0.035, x, 1.0, 0, 1, 1, 1, 0);
      }
      b.pbox('#55595d', 0.48, 0.012, 0.36, 0, 0, 0);
      if (kol) {
        gl.flat = true; gl.pbox('#ffffff', 0.48, 0.56, 0.02, 0, 0.06, 0); for (i = 0; i < 4; i++) gl.pbox('#ffffff', 0.48, 0.025, 0.05, 0, 0.12 + i * 0.13, 0);
        M.xparts.gfield = gl.geo(false); M.gate = 'sink'; M.gleaf = 'gfield';
      } else if (!syn) {
        b.box(P.body2, 0.96, 0.08, 0.16, 0, 0.84, 0).pbox(T.team, 0.5, 0.06, 0.165, 0, 0.85, 0);   // Torsturz
        gl.box('#525c66', 0.25, 0.6, 0.05, 0, 0.07, 0).pbox(T.team, 0.255, 0.06, 0.056, 0, 0.48, 0);
        for (i = 0; i < 3; i++) gl.pbox('#3b434b', 0.012, 0.36, 0.054, -0.08 + i * 0.08, 0.12, 0);
        for (i = 0; i < 3; i++) gl.pbox(i % 2 ? '#23272b' : '#e6b81c', 0.085, 0.05, 0.054, -0.085 + i * 0.085, 0.07, 0);
        M.xparts.gleaf = gl.geo(); M.gate = 'slide'; M.gleaf = 'gleaf';
      } else {
        b.box(P.rust, 0.98, 0.12, 0.22, 0, 0.84, 0); for (i = 0; i < 5; i++) b.pbox(i % 2 ? '#facc15' : '#1f2937', 0.18, 0.06, 0.226, -0.36 + i * 0.18, 0.86, 0);
        for (i = 0; i < 6; i++) gl.pbox('#3a3328', 0.025, 0.58, 0.04, -0.21 + i * 0.084, 0.06, 0);
        for (i = 0; i < 3; i++) gl.pbox('#4a4033', 0.5, 0.03, 0.045, 0, 0.14 + i * 0.2, 0);
        gl.pbox(T.team, 0.5, 0.04, 0.05, 0, 0.6, 0);
        M.xparts.gleaf = gl.geo(); M.gate = 'lift'; M.gleaf = 'gleaf';
      }
      M.iconAdd = function (grp, mat) { if (M.gate === 'slide') { for (var q = -1; q <= 1; q += 2) { var lm = new THREE.Mesh(M.xparts.gleaf, mat); lm.position.x = q * 0.125; grp.add(lm); } } else grp.add(new THREE.Mesh(M.xparts[M.gleaf], mat)); };
      M.h = 0.85;
    }
    M.parts.body = b.geo();
    if (g.list.length) { M.parts.glow = g.geo(false); M.lit = true; }
    return M;
  }

  /** Reparaturdock/Regenerator in Ruhe (Aufbau, erinnertes Gebäude): Arme, Laufkatze, Ring in Ruhestellung. */
  function rest12(b, M, owner, x, z, sy, cr, cg, cb) {
    var A = M.act, i, q;
    if (!A || A.k !== 'repair') return;
    if (A.arms) for (i = 0; i < A.arms.length; i++) { q = A.arms[i]; partBatch('b', b.type, owner, 'rarm', M).put(x + q[0], q[1] * sy, z + q[2], q[3] + 0.6, 1, sy, 1, cr, cg, cb); }
    if (A.trol) partBatch('b', b.type, owner, 'rtrol', M).put(x + A.trol[0], 0, z + A.trol[2], 0, 1, sy, 1, cr, cg, cb);
    if (A.ring) partBatch('b', b.type, owner, 'rring', M).put(x + A.ring[0], A.ring[1] * sy, z + A.ring[2], 0, 1, sy, 1, cr, cg, cb);
  }
  /** v1.2 Aktivität (aus actDraw): Reparaturdock, Erzsilo. */
  function act12(b, M, A, x, z, inV, dt, st, P, owner, low) {
    var t = R.t, S = G.Sim.S, i, q, k;
    if (A.k === 'silo12') {
      var f = P.oreCap > 0 ? clamp(P.credits / P.oreCap, 0, 1) : 0, fb = apb(b, owner, 'ofill', M), full = f > 0.97, gk = low ? 0.35 : (full ? 1.0 + 0.5 * Math.sin(t * 6) : 0.95);
      st.ofl = st.ofl == null ? f : st.ofl + (f - st.ofl) * Math.min(1, dt * 2);
      for (i = 0; i < M.ofill.length; i++) {
        q = M.ofill[i];
        if (q[4]) fb.put(x + q[0], q[1] + q[3] * st.ofl, z + q[2], 0, 1, 0.35 + 0.65 * Math.min(1, st.ofl * 3), 1, 1.0 * gk, 0.68 * gk, 0.2 * gk);   // Erzhaufen steigt im Bunker
        else fb.put(x + q[0], q[1], z + q[2], 0, 1, Math.max(0.01, q[3] * st.ofl), 1, 1.0 * gk, 0.68 * gk, 0.2 * gk);
      }
      return;
    }
    // Reparaturdock: arbeitet, solange in den letzten 20 Ticks repariert wurde
    var rep = b.repT != null && S.tick - b.repT < 20 && !(b.offT > S.tick);
    st.rpA = (st.rpA || 0) + dt * (rep ? 1 : 0.15);
    if (A.arms) for (i = 0; i < A.arms.length; i++) {
      q = A.arms[i];
      var ya = q[3] + (rep ? 0.32 * Math.sin(st.rpA * 1.6 + i * 2.1) : 0.6 + 0.04 * Math.sin(t * 0.4 + i)), pi = rep ? 0.14 * Math.sin(st.rpA * 2.3 + i) - 0.05 : 0;
      partBatch('b', b.type, owner, 'rarm', M).putP(x + q[0], q[1], z + q[2], ya, pi, 1, 1, 1);
      if (rep && inV && rnd() < dt * 9 * FX_LOW && G.R3F.bSpark) {
        var tx = x + q[0] + Math.cos(ya) * 0.52, tz = z + q[2] + Math.sin(ya) * 0.52;
        for (k = 0; k < 3; k++) G.R3F.bSpark(tx, 0.28, tz, (rnd() - 0.5) * 0.8, 0.3 + rnd() * 0.6, (rnd() - 0.5) * 0.8);
      }
    }
    if (A.trol) partBatch('b', b.type, owner, 'rtrol', M).put(x + A.trol[0] + (rep ? Math.sin(st.rpA * 0.9) * 0.6 : -0.6), 0, z + A.trol[2], 0, 1, 1, 1, 1, 1, 1);
    if (A.ring) {
      st.rgA = (st.rgA || 0) + dt * (rep ? 2.4 : 0.3);
      partBatch('b', b.type, owner, 'rring', M).put(x + A.ring[0], A.ring[1] + 0.05 * Math.sin(t * 1.3 + st.ph) + (rep ? 0.06 : 0), z + A.ring[2], st.rgA, 1, 1, 1, 1, 1, 1);
      var pg = low ? 0.25 : (rep ? 1.5 + 0.4 * Math.sin(t * 7) : 0.65 + 0.15 * Math.sin(t * 1.5));
      apb(b, owner, 'rpool', M).put(x + A.pool[0], A.pool[1], z + A.pool[2], 0, 1, 1, 1, 0.45 * pg, 0.95 * pg, 1.0 * pg);
      if (rep && inV && rnd() < dt * 14 * FX_LOW) emit(0, x + A.fx[0] + (rnd() - 0.5) * 0.9, A.fx[1], z + A.fx[2] + (rnd() - 0.5) * 0.7, 0, 0.6 + rnd() * 0.4, 0, 0.8, 0.07, 0.02, 0.6, 0.95, 1, 0.9, 0.5, 0.6, 1, 0);
    }
    if (A.lamps) {
      var lb = apb(b, owner, 'rlamp', M);
      for (i = 0; i < A.lamps.length; i++) {
        q = A.lamps[i];
        if (rep) { k = Math.sin(t * 7 + i * 1.6) > 0 ? 1.7 : 0.3; lb.put(x + q[0], q[1], z + q[2], 0, 1, 1, 1, 1.6 * k, 0.8 * k, 0.12 * k); }
        else { k = low ? 0.15 : 0.7; lb.put(x + q[0], q[1], z + q[2], 0, 1, 1, 1, 0.3 * k, 1.3 * k, 0.45 * k); }
      }
    }
  }
  /** Minenfeld: je verbliebener Ladung eine Minengruppe, verbrauchte als Krater. */
  function mineDraw(b, M, owner, x, z, sy, cr, cg, cb) {
    var ch = b.ch == null ? M.mine12.length : b.ch, i, q, mem = cr === GREY, pu;
    for (i = 0; i < M.mine12.length; i++) {
      q = M.mine12[i];
      if (i < ch) {
        partBatch('b', b.type, owner, 'mine', M).put(x + q[0], q[1], z + q[2], i * 1.3, 1, sy, 1, cr, cg, cb);
        if (M.xparts.mglow && !mem) { pu = 0.6 + 0.4 * Math.sin(R.t * 2.2 + i * 2 + b.id); partBatch('b', b.type, owner, 'mglow', M).put(x + q[0], q[1], z + q[2], 0, 1, sy, 1, 0.9 * pu, 0.6 * pu, 1.2 * pu); }
      } else partBatch('b', b.type, owner, 'mcrat', M).put(x + q[0], 0, z + q[2], i, 1, 1, 1, cr, cg, cb);
    }
  }
  /** Tor: Ausrichtung entlang der angrenzenden eigenen Mauern/Tore (wg/wgG aus wallPass), Flügel nach e.open (geglättet). */
  function gateDraw(b, M, owner, x, z, sy, cr, cg, cb) {
    var mem = cr === GREY, st = nst(b.id), tx = b.tx, ty = b.ty, v = owner + 1, ang = 0;
    if (wg && wgG && tx != null) {
      var idx = ty * wgW + tx, hx = (tx > 0 && (wg[idx - 1] === v || wgG[idx - 1] === v)) || (tx + 1 < wgW && (wg[idx + 1] === v || wgG[idx + 1] === v));
      var vz = (ty > 0 && (wg[idx - wgW] === v || wgG[idx - wgW] === v)) || (ty + 1 < wgH && (wg[idx + wgW] === v || wgG[idx + wgW] === v));
      if (vz && !hx) ang = Math.PI / 2;
    }
    var tgt = !mem && b.open ? 1 : 0;
    st.go = st.go == null ? tgt : st.go + (tgt - st.go) * Math.min(1, fdt * 3.5);
    var o = smooth(clamp(st.go, 0, 1)), ca = Math.cos(ang), sa = Math.sin(ang), lf = partBatch('b', b.type, owner, M.gleaf, M);
    partBatch('b', b.type, owner, 'body', M).put(x, 0, z, ang, 1, sy, 1, cr, cg, cb);
    if (M.parts.glow) partBatch('b', b.type, owner, 'glow', M).put(x, 0, z, ang, 1, sy, 1, mem ? 0.3 : 1, mem ? 0.3 : 1, mem ? 0.3 : 1);
    if (M.gate === 'slide') { for (var sd = -1; sd <= 1; sd += 2) { var off = sd * (0.125 + 0.22 * o); lf.put(x + ca * off, 0, z + sa * off, ang, 1, sy, 1, cr, cg, cb); } }
    else if (M.gate === 'lift') lf.put(x, 0.5 * o * sy, z, ang, 1, sy * (1 - 0.15 * o), 1, cr, cg, cb);
    else {
      var fk = mem ? 0.25 : (0.75 + 0.25 * Math.sin(R.t * 5 + b.id)) * (1 - 0.5 * o);
      if (o < 0.97) lf.put(x, 0, z, ang, 1, Math.max(0.03, (1 - o) * sy), 1, 0.85 * fk, 0.55 * fk, 1.15 * fk);
    }
  }

  // ---- v1.2 Zustände: lahmgelegt (offT), gelähmt (stunT), Sprengladung (S.charges)
  var BST = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  /** Lahmgelegtes Gebäude: Entladungsbögen und Funken über dem Dach, ab und zu ein Rauchwölkchen (Lichter aus: litGain). */
  function offFx(e, M, x, z, dt, inV) {
    if (!inV || !(dt > 0)) return;
    var w = e.w || 1, h = e.h || 1, y = (M.h || 1) * 0.8, q = (R.safeGPU ? 0.5 : 1);
    if (rnd() < dt * 2.2 * q) arcSpark(x + (rnd() - 0.5) * w * 0.6, y, z + (rnd() - 0.5) * h * 0.6, x + (rnd() - 0.5) * w * 0.6, y * (0.5 + rnd() * 0.4), z + (rnd() - 0.5) * h * 0.6);
    if (rnd() < dt * 3 * q && G.R3F.bSpark) { var sx = x + (rnd() - 0.5) * w * 0.7, sz = z + (rnd() - 0.5) * h * 0.7; for (var k = 0; k < 3; k++) G.R3F.bSpark(sx, y, sz, (rnd() - 0.5) * 0.9, 0.3 + rnd() * 0.6, (rnd() - 0.5) * 0.9); }
    if (rnd() < dt * 0.8 * q) emit(1, x + (rnd() - 0.5) * w * 0.5, y, z + (rnd() - 0.5) * h * 0.5, 0.05, 0.35, 0.02, 1.6, 0.1, 0.4, 0.35, 0.38, 0.45, 0.5, 0.5, 0.52, 0.55, 0, 0, 0.3);
  }
  /** Gelähmte Einheit: zwei schräg kreisende violette Psi-Fesseln um die Einheit (Glühteil, eigener Batch), kleine Funken. */
  function stunGeo() { var m = new MB(); m.flat = true; m.add(new THREE.TorusGeometry(1, 0.075, 4, 22), '#ffffff', 0, 0, 0, 0, Math.PI / 2, 0); return m.geo(false); }
  function chgGeo() { var m = new MB('bld'); m.box('#c8b88a', 0.16, 0.09, 0.11, 0, 0, 0).box('#bcab7c', 0.16, 0.06, 0.11, 0, 0.09, 0).pbox('#c0392b', 0.165, 0.012, 0.115, 0, 0.07, 0).box('#2a2e33', 0.07, 0.05, 0.06, 0.02, 0.15, 0.0).pbox('#e6b81c', 0.004, 0.06, 0.004, -0.05, 0.15, 0.03); return m.geo(); }
  function chgLGeo() { var m = new MB(); m.flat = true; m.pbox('#ffffff', 0.035, 0.03, 0.035, 0.02, 0.2, 0); return m.geo(false); }
  function stunFx(e, M, x, gy, z, s, dt, inV) {
    var bt = batch('stun12', stunGeo, partMat('glow'), 16, false);
    var rr = Math.max(0.2, (e.r || 8) / TILE * 1.15), t = R.t, y = gy + Math.max(0.12, (M.h || 0.4) * s * 0.55), k = 0.75 + 0.35 * Math.sin(t * 9 + e.id), i;
    for (i = 0; i < 2; i++) {
      basis(BST, t * (i ? -2.4 : 3.1) + e.id, 0.32 * Math.sin(t * 1.7 + i * 2), 0.32 * Math.cos(t * 1.3 + i * 2));
      bt.putM(x, y + (i ? 0.06 : -0.04), z, BST, rr * (i ? 0.85 : 1), 0.95 * k, 0.45 * k, 1.35 * k);
    }
    if (inV && dt > 0 && rnd() < dt * 4) { var a = rnd() * 6.283; emit(0, x + Math.cos(a) * rr, y, z + Math.sin(a) * rr, 0, 0.4, 0, 0.4, 0.06, 0.02, 0.85, 0.5, 1, 0.9, 0.5, 0.3, 1, 0); }
  }
  /** Gelegte Sprengladung an der Südwest-Ecke des Zielgebäudes: Paket mit Lampe, die bis zur Zündung immer schneller blinkt. */
  function chargeDraw(S, pid, fogOff, tick, dt, inView) {
    var bb = batch('chg12', chgGeo, MAT.std, 4), lb = batch('chg12l', chgLGeo, partMat('glow'), 4, false);
    var hz = D.TICK_HZ || 20, i, c, b, bx, bz, rem, fq, on;
    for (i = 0; i < S.charges.length; i++) {
      c = S.charges[i]; b = G.Sim.get(c.bid);
      if (!b || b.dead || b.kind !== 'building') continue;
      if (!fogOff && b.owner !== pid && !G.Sim.isVisible(pid, b)) continue;
      bx = b.x / TILE - (b.w || 1) / 2 + 0.28; bz = b.y / TILE + (b.h || 1) / 2 - 0.16;
      rem = Math.max(0, (c.t - tick) / hz); fq = 2.5 + 10 * clamp(1 - rem / 4, 0, 1); on = Math.sin(R.t * fq * 3.1416) > 0 ? 2.2 : 0.25;
      bb.put(bx, 0.06, bz, 0.4, 1.5, 1.5, 1.5, 1, 1, 1);
      lb.put(bx, 0.06, bz, 0.4, 1.5, 1.5, 1.5, on, on * 0.12, on * 0.08);
      if (on > 1 && inView(bx, bz) && dt > 0 && rnd() < dt * 3 && G.R3F.bSpark) G.R3F.bSpark(bx, 0.42, bz, (rnd() - 0.5) * 0.4, 0.4, (rnd() - 0.5) * 0.4);
    }
  }

  // ------------------------------------------------------------------ v1.2 TARNUNG (Haken in fill())
  // G.Sim.cloakState(pid, e): 1 = eigenes getarntes Objekt, 2 = gegnerisches, gerade aufgedecktes, 3 = unsichtbar (in fill() gar nicht gezeichnet – G.Sim.hidden).
  // Darstellung: eigenes Objekt, das der Gegner gerade NICHT sieht → halbtransparent mit bläulichem Schimmer (MAT.cloak, Deckkraft pulsiert global);
  // eigenes, aber gerade aufgedecktes (revT/revM) und gegnerisches aufgedecktes → normal deckend + schwacher roter Warnring („enttarnt“).
  /** Rückgabe true = Objekt halbtransparent zeichnen (pbMode). */
  function cloakMark(e, pid, x, y, z, rad, tick) {
    var st = G.Sim.cloakState(pid, e);
    if (st === 1 && !(e.revT > tick) && !e.revM) return true;
    if (st === 1 || st === 2) { var k = 0.4 + 0.3 * Math.sin(R.t * 5 + e.id * 0.7); R.selRing.put(x, y, z, 0, rad, 1, rad, 1.0 * k, 0.28 * k, 0.2 * k); }
    return false;
  }

  // ------------------------------------------------------------------ v1.2 look-Rückfall (ZENTRALE STELLE, vorläufige Darstellung)
  // Neue Typen (data.js, Feld look) benutzen Modell, Maßstab und Tabellen-Einträge des look-Typs, solange sie kein eigenes Modell haben.
  // Eigenes Modell nachrüsten: Typ in OWN12 eintragen (dann greift kein Rückfall mehr) und wie gewohnt in den Bau-Tabellen ergänzen.
  var LOOK12 = {}, OWN12 = { flaktank: 1, saboteur: 1, radarcar: 1, submarine: 1, carrier: 1, carrierjet: 1, psidrone: 1, swarmling: 1, swarmcarrier: 1,
    repairdock: 1, oresilo: 1, minefield: 1, gate: 1, tradepost: 1 };   // v1.2: Typen mit eigenem Modell (Abschnitt „v1.2 Modelle“)
  function lookAlias() {
    var tabs = [SCALE, INF, NEUT, GARR, BH, LOD, K10M, KB, V4U, V4B, V5B, V5U, V7U, V8M, V9M, PCAT, IKICK, NOKNEEL, DIE_SMALL];
    [D.UNITS, D.BUILDINGS].forEach(function (T) {
      for (var t in T) {
        var l = T[t].look;
        if (!l || l === t || OWN12[t]) continue;
        LOOK12[t] = l;
        for (var k = 0; k < tabs.length; k++) {
          if ((tabs[k] === NEUT || tabs[k] === GARR) && !T[t].neutral) continue;   // Tabellen der neutralen Kartengebäude nur für neutrale Typen
          if (tabs[k] && (l in tabs[k]) && !(t in tabs[k])) tabs[k][t] = tabs[k][l];
        }
      }
    });
  }
  lookAlias();

  var fdt = 0, V = null;
  initSurf();
  G.R3M = {
    link: link, makeMaterials: makeMaterials, material: material, MAT: MAT, SURF: SURF, surfOf: surfOf, ensureSurf: ensureSurf,
    MB: MB, Batch: Batch, batch: batch, partBatch: partBatch, partMat: partMat, GLOW_PARTS: GLOW_PARTS,
    model: model, unitModelOf: unitModelOf, facOfColor: facOfColor, isBld: isBld, teamRGB: teamRGB, PAL: PAL, teamCols: teamCols,
    NEUT: NEUT, GARR: GARR, BH: BH, SCALE: SCALE, INF: INF, DIE_SMALL: DIE_SMALL, _wreckCount: function () { return wrecks.length; },
    neutralShown: neutralShown, nst: nst, rs: rs, addWreck: addWreck, muzzleOf: muzzleOf,
    deployEvt: deployEvt, fill: fill, flush: flush, reset: reset, getFlagModel: getFlagModel, ruinModel: ruinModel,
    get: function (type, fac, color) { return model(type, fac, color); },
    LOOK12: LOOK12, OWN12: OWN12, lookAlias: lookAlias,   // v1.2 look-Rückfall
    WL: WL8, RAMP_OPEN: RAMP_OPEN   // v0.8: Wasserspiegel (Schiffe), Bugklappe offen (rad)
  };
})();
