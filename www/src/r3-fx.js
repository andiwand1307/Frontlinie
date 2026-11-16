/* FRONTLINIE – r3-fx.js  (v0.6: aus render3d.js ausgelagert)  →  G.R3F
 * Besitzt: Partikel (2 Pools: 0 = additiv/Feuer/Funken/Glühen, 1 = normal/Rauch/Staub/Trümmer), Leuchtspuren, Projektile (Raketen,
 *   Granaten, Artillerie-Granaten + Zielmarker), Mündungsfeuer, Strahlen/Blitze (Laser, Blitzturm, Funkenbögen), Explosionen,
 *   Bodenringe (Eroberung/Reparatur/Bauhof), Superwaffen (Warnmarker, Orbitalstrahl, Rakete, Druckwelle + 2D-Beschriftung),
 *   Lichtblitz (PointLight), Kamerawackeln, Auswertung der Sim-Ereignisse (S.events) → Effekte.
 * Kontext: G.R3 (Kern): R.THREE, R.scene, R.dynRoot, R.V, R.Q, R.std/R.post/R.lite, R.safeGPU, R.COS/R.SIN (Kamera-Neigung),
 *   R.t (Effektzeit – setzt DIESES Modul in update()), R.dt, R.hash/clamp/rnd, R.visibleAt, R.inView, R.octx + R.project (2D-Überlagerung).
 *   Aus G.R3M: Batch, MAT, model(), partBatch(), nst(), rs, teamRGB(), muzzleOf(), addWreck(), deployEvt(), DIE_SMALL.
 *   Aus G.R3T: groundAt(), decal().
 * Exporte (G.R3F):
 *   link(), init(), reset()
 *   emit(pool, x,y,z, vx,vy,vz, life, s0,s1, r0,g0,b0,a0, r1,g1,b1,a1, grav, drag)   Partikel (Farben linear, additiv darf > 1)
 *   sparkle(x,y,z,k), explosion(x,y,z,k,debris), dust(x,y,z,k), tracer(...), beamImpact(x,y,z,kind,k), arcSpark(...), addPulse(x,z,color,rad,dur)
 *   flashAt(x,y,z,dur,k)       Lichtblitz
 *   consumeEvents(S)           neue S.events seit letztem Aufruf auswerten
 *   fill(S, alpha, dt)         Projektile, Artillerie, Bodenringe, Superwaffen (vor flush())
 *   flush()                    eigene Batches abschließen
 *   update(dt)                 Effektzeit R.t += dt, Partikel/Leuchtspuren/Strahlen/Lichtblitz simulieren + hochladen
 *   overlay(S, alpha)          2D-Beschriftung der Superwaffen-Warnmarker (auf R.octx)
 *   shakeUpdate(), shakeOffset() → {x, z}, setShake(on), getShake(), addShake(a, dur)
 *   setMax(n), setPointScale(px je Einheit), setMaxPoint(px), particleCount()
 *   Bewegung: terrK/dstC (Staub je Untergrund), mzJet (Mündungsstrahl), casing (Hülsen), fountain (Erd-/Sandfontäne), hitMark/hitNear (Trefferblitz + Ruck
 *   über rs.hitT/hitK), Wrack-Felder pop/ox/oz/spin/ckT (abgesprengter Turm, Nachexplosion), Wrack-Art 'fall' (Infanterie); _counts() für Leck-Tests.
 * Leuchten/Bloom: siehe docs/RENDER_MODULES.md – additive Partikel/Strahlen mit Farbwerten > 1 leuchten in Modern über Bloom.
 */
var G = (typeof G !== 'undefined') ? G : {};
(function () {
  'use strict';
  var R = G.R3 = G.R3 || {};
  var THREE = R.THREE, D = R.D, TILE = R.TILE;
  var clamp = R.clamp, rnd = R.rnd, visibleAt = R.visibleAt;
  var M3 = null, T3 = null, Batch = null, MAT = null, model = null, partBatch = null, nst = null, rs = null, teamRGB = null, groundAt = null, decal = null;
  var V = null, scene = null, dynRoot = null, flash = null, lastSeq = 0, tmpV = null;
  function link() {
    M3 = G.R3M; T3 = G.R3T; Batch = M3.Batch; MAT = M3.MAT; model = M3.model; partBatch = M3.partBatch; nst = M3.nst; rs = M3.rs; teamRGB = M3.teamRGB;
    groundAt = T3.groundAt; decal = T3.decal; V = R.V; scene = R.scene; dynRoot = R.dynRoot;
  }
  var safeGPU = false;   // aus R.safeGPU (je Frame aktualisiert)

  // ------------------------------------------------------------------ Effekte (Partikel, Leuchtspuren, Decals)
  var fx = null;
  function initFx() {
    var N = 1600, Q = R.Q;
    fx = { max: Q.particles, pools: [] };
    var vsh = 'attribute float aSize; attribute vec4 aCol; uniform float uScale; uniform float uMaxPt; varying vec4 vCol;' +
      'void main(){ vCol = aCol; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * mv; gl_PointSize = clamp(aSize * uScale, 1.0, uMaxPt); }';
    // v0.6: uLin = 1 (Modern mit Nachbearbeitung, linearer HDR-Puffer): Farben sRGB→linear; additiver Pool × uGain (> 1 → Bloom)
    var fsh = 'uniform float uLin; uniform float uGain; uniform vec3 uTint; varying vec4 vCol; void main(){ vec2 d = gl_PointCoord - 0.5; float r = dot(d,d) * 4.0; if (r > 1.0) discard; float a = vCol.a * (1.0 - r * r);' +
      ' vec3 c = vCol.rgb * uTint; if (uLin > 0.5) c = pow(max(c, vec3(0.0)), vec3(2.2)) * uGain; gl_FragColor = vec4(c, a); }';
    fx.uLin = { value: 0 };
    fx.uScale = { value: 10 }; fx.uMaxPt = { value: 48 };
    for (var p = 0; p < 2; p++) {
      var geo = new THREE.BufferGeometry();
      var pos = new Float32Array(N * 3), col = new Float32Array(N * 4), siz = new Float32Array(N);
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('aCol', new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('aSize', new THREE.BufferAttribute(siz, 1).setUsage(THREE.DynamicDrawUsage));
      geo.setDrawRange(0, 0);
      var mat = new THREE.ShaderMaterial({ uniforms: { uScale: fx.uScale, uMaxPt: fx.uMaxPt, uLin: fx.uLin, uGain: { value: p === 0 ? 2.2 : 1.0 }, uTint: { value: new THREE.Vector3(1, 1, 1) } }, vertexShader: vsh, fragmentShader: fsh, transparent: true, depthWrite: false,
        blending: p === 0 ? THREE.AdditiveBlending : THREE.NormalBlending, toneMapped: false });
      var pts = new THREE.Points(geo, mat);
      pts.frustumCulled = false; pts.renderOrder = p === 0 ? 6 : 5;
      scene.add(pts);
      fx.pools.push({ pts: pts, geo: geo, pos: pos, col: col, siz: siz, n: 0, N: N,
        x: new Float32Array(N), y: new Float32Array(N), z: new Float32Array(N), vx: new Float32Array(N), vy: new Float32Array(N), vz: new Float32Array(N),
        age: new Float32Array(N), life: new Float32Array(N), s0: new Float32Array(N), s1: new Float32Array(N),
        c0: new Float32Array(N * 4), c1: new Float32Array(N * 4), grav: new Float32Array(N), drag: new Float32Array(N) });
    }
    // Leuchtspuren (v0.6b: als Bänder in updateBeams gezeichnet, nicht mehr als 1-px-Linien)
    var TN = 220;
    fx.tr = { n: 0, N: TN, x0: new Float32Array(TN), y0: new Float32Array(TN), z0: new Float32Array(TN), x1: new Float32Array(TN), y1: new Float32Array(TN), z1: new Float32Array(TN),
      age: new Float32Array(TN), life: new Float32Array(TN), kind: new Float32Array(TN) };
    flash = new THREE.PointLight('#ffb35c', 0, 5, 1.2);
    scene.add(flash);
    tmpV = new THREE.Vector3();
    fx.time = 0;
    fx.flashT = 0;
  }
  // ============================================================== v0.6b: Sprite-Partikel (Modern / Modern Lite), Trümmer, Bodenwellen
  // Stufen (spTier): 0 = klassisch (Punkt-Partikel, wie v0.6), 1 = Modern Lite / Schonmodus (Sprites, kleiner Atlas, additive Lichthöfe statt Bloom),
  // 2 = Modern (Sprites, großer Atlas, Farbwerte > 1 → Bloom). Sprites = MeshBasicMaterial mit Vertexfarben (RGBA) + Textur-Atlas – KEIN ShaderMaterial.
  var spTier = 0, spQ = 1, GN = 1, SP = null, DB = null, wvRing = null, wvGlow = null;
  var accMap = new Map(), waves = [], burns = [];
  var AT_C = 4, AT_R = 4, SM_C = 4, SM_R = 2, LX = [-1, 1, 1, -1], LY = [-1, -1, 1, 1];
  function ss(a, b, x) { var t = x < a ? 0 : x > b ? 1 : (x - a) / (b - a); return t * t * (3 - 2 * t); }
  function nh(ix, iy, s) { var h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(s, 1274126177)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) & 0xffff) / 65535; }
  function vn(x, y, s) {
    var ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy; fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    var a = nh(ix, iy, s), b = nh(ix + 1, iy, s), c = nh(ix, iy + 1, s), d = nh(ix + 1, iy + 1, s);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }
  function fbm(x, y, s, o) { var v = 0, a = 0.5, f = 1, t = 0; for (var i = 0; i < o; i++) { v += a * vn(x * f, y * f, s + i * 31); t += a; a *= 0.5; f *= 2.03; } return v / t; }
  /** Prozedurale Atlanten: Rauch (4×2 Zellen: 0–3 rund, 4–7 zerfranst/Staub) und Feuer/Licht (4×4: 0–7 Feuerball-Flipbook, 8 Glow, 9 Stern, 10 Funke, 11 Scheibe, 12–15 Flammenzunge). */
  function buildAtlas(C) {
    var cvA = document.createElement('canvas'), cvS = document.createElement('canvas');
    cvA.width = C * AT_C; cvA.height = C * AT_R; cvS.width = C * SM_C; cvS.height = C * SM_R;
    var gA = cvA.getContext('2d'), gS = cvS.getContext('2d'), id = gA.createImageData(C, C), d = id.data, c, x, y, i, px, py, r, n, v, a, sh, I, rg, tr, tg, tb;
    for (c = 0; c < 8; c++) {
      var seed = c * 17 + 3, wisp = c >= 4, fr = wisp ? 3.4 : 2.1;
      for (y = 0; y < C; y++) for (x = 0; x < C; x++) {
        px = (x + 0.5) / C * 2 - 1; py = (y + 0.5) / C * 2 - 1; r = Math.sqrt(px * px + py * py);
        n = fbm(px * fr + seed, py * fr + seed * 0.7, seed, 4);
        v = (1 - ss(0.2, 1, r)) * (0.5 + 1.0 * n) - (wisp ? 0.14 : 0.03);
        a = ss(0.1, 0.6, v) * (1 - ss(0.82, 1, r)); sh = 0.6 + 0.55 * fbm(px * 3 + seed * 3, py * 3, seed + 9, 3);
        i = (y * C + x) * 4; d[i] = d[i + 1] = d[i + 2] = Math.min(255, sh * 255) | 0; d[i + 3] = a * 255 | 0;
      }
      gS.putImageData(id, (c % SM_C) * C, ((c / SM_C) | 0) * C);
    }
    for (c = 0; c < 16; c++) {
      var fq = c < 8 ? c : (c >= 12 ? c - 12 : 0), s0 = c >= 12 ? 45 : 5;
      for (y = 0; y < C; y++) for (x = 0; x < C; x++) {
        px = (x + 0.5) / C * 2 - 1; py = (y + 0.5) / C * 2 - 1; r = Math.sqrt(px * px + py * py); I = 0; rg = 1; tr = -1;
        if (c < 8) {
          n = fbm(px * 2.1 + s0, py * 2.1 + fq * 0.42 + s0, s0, 4);
          v = (1 - r) + (n - 0.5) * 0.9; I = ss(0.06, 0.6, v) * (1 - ss(0.8, 1, r)); rg = 0.35 + 0.65 * I;
        } else if (c === 8) { I = Math.pow(Math.max(0, 1 - r), 2.2); }
        else if (c === 9) {
          var ax = Math.abs(px), ay = Math.abs(py), u = (px + py) * 0.7071, w = (px - py) * 0.7071;
          I = Math.exp(-r * 8) + 1.1 * Math.exp(-ax * 26) * Math.exp(-ay * 2.4) + 1.1 * Math.exp(-ay * 26) * Math.exp(-ax * 2.4) + 0.45 * Math.exp(-Math.abs(u) * 34) * Math.exp(-Math.abs(w) * 3.4) + 0.45 * Math.exp(-Math.abs(w) * 34) * Math.exp(-Math.abs(u) * 3.4);
          I = Math.min(1, I) * (1 - ss(0.78, 1, r));
        } else if (c === 10) { I = Math.pow(Math.max(0, 1 - r), 4.5); }
        else if (c === 11) { I = 1 - ss(0.45, 1, r); }
        else {
          var q = (1 - py) * 0.5, hw = 0.62 * Math.pow(1 - q, 0.55) * Math.min(1, (q + 0.12) * 4);
          n = fbm(px * 2.6 + s0, py * 2.2 + fq * 0.7 + s0, s0, 4);
          v = hw > 0.01 ? 1 - Math.abs(px + (n - 0.5) * 0.9 * q) / hw + (n - 0.5) * 0.9 - q * 0.3 : -1;
          I = ss(0, 0.7, v) * (1 - ss(0.8, 1, q)) * ss(0, 0.07, q);
          var core = Math.pow(I, 2);
          tr = 1; tg = 0.62 - 0.5 * q + 0.28 * core; tb = 0.32 * (1 - q) * (0.2 + core); rg = 1;
        }
        i = (y * C + x) * 4;
        if (tr >= 0) { d[i] = Math.min(255, tr * 255) | 0; d[i + 1] = Math.min(255, tg * 255) | 0; d[i + 2] = Math.min(255, tb * 255) | 0; } else d[i] = d[i + 1] = d[i + 2] = Math.min(255, rg * 255) | 0;
        d[i + 3] = Math.min(255, I * 255) | 0;
      }
      gA.putImageData(id, (c % AT_C) * C, ((c / AT_C) | 0) * C);
    }
    return { add: cvA, sm: cvS };
  }
  function ringTex() {
    var c = document.createElement('canvas'); c.width = c.height = 128; var g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 63);
    gr.addColorStop(0, 'rgba(255,255,255,0.05)'); gr.addColorStop(0.55, 'rgba(255,255,255,0.1)'); gr.addColorStop(0.8, 'rgba(255,255,255,0.55)'); gr.addColorStop(0.9, 'rgba(255,255,255,1)'); gr.addColorStop(0.96, 'rgba(255,255,255,0.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128); var t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  }
  var SPF = ['x', 'y', 'z', 'vx', 'vy', 'vz', 'age', 'life', 's0', 's1', 'rot', 'rv', 'grav', 'drag', 'cell', 'fl', 'shade', 'gr'];
  function mkSpritePool(N, additive, ro) {
    var geo = new THREE.BufferGeometry(), pos = new Float32Array(N * 12), uv = new Float32Array(N * 8), col = new Float32Array(N * 16), idx = new Uint16Array(N * 6), i;
    for (i = 0; i < N; i++) { var v = i * 4; idx[i * 6] = v; idx[i * 6 + 1] = v + 1; idx[i * 6 + 2] = v + 2; idx[i * 6 + 3] = v; idx[i * 6 + 4] = v + 2; idx[i * 6 + 5] = v + 3; }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(new THREE.BufferAttribute(idx, 1)); geo.setDrawRange(0, 0);
    var mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending });
    var mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false; mesh.renderOrder = ro; mesh.visible = false; scene.add(mesh);
    var P = { N: N, cap: N, n: 0, geo: geo, pos: pos, uv: uv, col: col, mat: mat, mesh: mesh, add: additive, c0: new Float32Array(N * 4), c1: new Float32Array(N * 4), f: [] };
    for (i = 0; i < SPF.length; i++) { P[SPF[i]] = new Float32Array(N); P.f.push(P[SPF[i]]); }
    return P;
  }
  function setAtlas(C) {
    var at = buildAtlas(C), t0 = new THREE.CanvasTexture(at.add), t1 = new THREE.CanvasTexture(at.sm), k;
    [t0, t1].forEach(function (t) { t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; });
    if (SP.t0) { SP.t0.dispose(); SP.t1.dispose(); }
    SP.t0 = t0; SP.t1 = t1; SP.C = C;
    SP.pools[0].mat.map = t0; SP.pools[1].mat.map = t1; SP.pools[0].mat.needsUpdate = true; SP.pools[1].mat.needsUpdate = true;
    SP.pools[0].pu = 0.6 / (C * AT_C); SP.pools[0].pv = 0.6 / (C * AT_R); SP.pools[1].pu = 0.6 / (C * SM_C); SP.pools[1].pv = 0.6 / (C * SM_R);
  }
  function initSprites() {
    SP = { pools: [mkSpritePool(720, true, 6.3), mkSpritePool(1100, false, 5.3)], t0: null, t1: null, C: 0 };
    setAtlas(64);
    var pg = new THREE.PlaneGeometry(2, 2); pg.rotateX(-Math.PI / 2);
    var mk = function (map) { return new THREE.MeshBasicMaterial({ map: map, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }); };
    wvRing = new Batch(pg, mk(ringTex()), 48, false); wvRing.mesh.renderOrder = 3.6; dynRoot.add(wvRing.mesh);
    wvGlow = new Batch(pg, mk(blobTex([[0, 1], [0.3, 0.7], [0.65, 0.25], [1, 0]])), 48, false); wvGlow.mesh.renderOrder = 3.5; dynRoot.add(wvGlow.mesh);
    var MB = M3.MB, dg = new MB('unit');
    dg.box('#ffffff', 1, 0.7, 0.8, 0, -0.35, 0).box('#c8c8c8', 0.55, 0.5, 0.6, 0.28, -0.1, 0.05, 0.6, 0.3, 0.2);
    var dbN = 200;
    DB = { bat: new Batch(dg.geo(false), MAT.std, dbN, false), N: dbN, n: 0 };
    dynRoot.add(DB.bat.mesh);
    var fl = ['x', 'y', 'z', 'vx', 'vy', 'vz', 'age', 'life', 'size', 'yaw', 'pit', 'wy', 'wp', 'r', 'g', 'b', 'bn'], i;
    for (i = 0; i < fl.length; i++) DB[fl[i]] = new Float32Array(dbN);
    for (i = 0; i < 48; i++) waves.push({ on: false, kind: 0, x: 0, y: 0, z: 0, t0: 0, dur: 1, r0: 0, r1: 1, cr: 1, cg: 1, cb: 1 });
    for (i = 0; i < 28; i++) burns.push({ on: false, x: 0, y: 0, z: 0, t0: 0, dur: 1, sz: 1, acc: 0, fire: 0 });
  }
  function resetV06() {
    var p, i;
    if (SP) for (p = 0; p < 2; p++) { SP.pools[p].n = 0; SP.pools[p].mesh.visible = false; }
    if (DB) DB.n = 0;
    for (i = 0; i < waves.length; i++) waves[i].on = false;
    for (i = 0; i < burns.length; i++) burns[i].on = false;
    accMap.clear();
  }
  /** Qualitätsstufe der Effekte bestimmen; bei Wechsel Atlas (groß/klein) und Puffer-Grenzen anpassen. */
  function syncTier() {
    var t = (!R.std || !(R.F || {}).sprites) ? 0 : ((R.lite || R.safeGPU) ? 1 : 2);   // v0.8: Flag sprites (R) aus → Punkt-Partikel (Stufe 0)
    if (t === spTier || !SP) return;
    spTier = t; GN = t === 2 ? 1.25 : 0.9;
    var sg = R.safeGPU ? 0.7 : 1, sc = clamp(fx.max / 1400, 0.4, 1);
    if (t) {
      var C = t === 2 ? 128 : 64; if (C !== SP.C) setAtlas(C);
      SP.pools[0].cap = Math.round((t === 2 ? 700 : 240 * sg) * sc); SP.pools[1].cap = Math.round((t === 2 ? 1050 : 400 * sg) * sc);
      spQ = t === 2 ? 1 : 0.55 * sg;
    } else for (var p = 0; p < 2; p++) { SP.pools[p].n = 0; SP.pools[p].mesh.visible = false; }
  }
  /** Sprite erzeugen. pool 0 additiv (Feuer/Glühen/Funken), 1 normal (Rauch/Staub). Größen = Durchmesser (wie bei Punkt-Partikeln). */
  function spn(pool, cell, fl, x, y, z, vx, vy, vz, life, s0, s1, rot, rv, r0, g0, b0, a0, r1, g1, b1, a1, grav, drag, shade, gr) {
    var P = SP.pools[pool];
    if (P.n >= P.cap) return;
    if (!P.n && R.mark) R.mark('sprites');
    var i = P.n++, o = i * 4;
    P.x[i] = x; P.y[i] = y; P.z[i] = z; P.vx[i] = vx; P.vy[i] = vy; P.vz[i] = vz; P.age[i] = 0; P.life[i] = life; P.s0[i] = s0; P.s1[i] = s1;
    P.rot[i] = rot; P.rv[i] = rv; P.grav[i] = grav; P.drag[i] = drag; P.cell[i] = cell; P.fl[i] = fl; P.shade[i] = shade; P.gr[i] = gr;
    P.c0[o] = r0; P.c0[o + 1] = g0; P.c0[o + 2] = b0; P.c0[o + 3] = a0; P.c1[o] = r1; P.c1[o + 1] = g1; P.c1[o + 2] = b1; P.c1[o + 3] = a1;
  }
  function updSprites(dt) {
    var VD = R.VDIR, vx = VD ? VD.x : 0, vy = VD ? VD.y : -R.SIN, vz = VD ? VD.z : -R.COS;
    var rX = 1, rY = 0, rZ = 0, RG = R.RIGHT; if (RG) { if (RG.length === 2) { rX = RG[0]; rY = 0; rZ = RG[1]; } else { rX = RG.x; rY = RG.y; rZ = RG.z; } } // Kern liefert [rx, rz]
    var uX = rY * vz - rZ * vy, uY = rZ * vx - rX * vz, uZ = rX * vy - rY * vx;   // oben = rechts × Blick
    var p, i, k, P, n, f, o, sz, cr, sr, lx, ly, ox, oy, px, py, pz, ar, ag, ab, aa, br, c, col, row, cols, rows, u0, v0, u1, v1, lf, j, l, q;
    for (p = 0; p < 2; p++) {
      P = SP.pools[p]; cols = p === 0 ? AT_C : SM_C; rows = p === 0 ? AT_R : SM_R;
      for (i = 0; i < P.n; i++) {
        P.age[i] += dt;
        if (P.age[i] >= P.life[i]) {
          l = --P.n;
          if (i !== l) { for (j = 0; j < P.f.length; j++) P.f[j][i] = P.f[j][l]; for (q = 0; q < 4; q++) { P.c0[i * 4 + q] = P.c0[l * 4 + q]; P.c1[i * 4 + q] = P.c1[l * 4 + q]; } }
          i--; continue;
        }
        var dr = Math.max(0, 1 - P.drag[i] * dt);
        P.vx[i] *= dr; P.vz[i] *= dr; P.vy[i] = P.vy[i] * dr + P.grav[i] * dt;
        P.x[i] += P.vx[i] * dt; P.y[i] += P.vy[i] * dt; P.z[i] += P.vz[i] * dt; P.rot[i] += P.rv[i] * dt;
        f = P.age[i] / P.life[i]; o = i * 4;
        lf = P.gr[i] > 0 ? 1 - (1 - f) * (1 - f) : f;
        sz = (P.s0[i] + (P.s1[i] - P.s0[i]) * lf) * 0.5;
        ar = P.c0[o] + (P.c1[o] - P.c0[o]) * f; ag = P.c0[o + 1] + (P.c1[o + 1] - P.c0[o + 1]) * f; ab = P.c0[o + 2] + (P.c1[o + 2] - P.c0[o + 2]) * f;
        aa = P.c0[o + 3] + (P.c1[o + 3] - P.c0[o + 3]) * (p ? f * Math.sqrt(f) : f);
        if (p) aa *= Math.min(1, f * 9);
        cr = Math.cos(P.rot[i]) * sz; sr = Math.sin(P.rot[i]) * sz;
        px = P.x[i] - vx * sz * 0.55; py = P.y[i] - vy * sz * 0.55; pz = P.z[i] - vz * sz * 0.55;   // zur Kamera hin versetzt: weniger Anschneiden am Boden
        c = (P.cell[i] | 0) + (P.fl[i] > 0 ? Math.min(P.fl[i] - 1, (f * P.fl[i]) | 0) : 0);
        col = c % cols; row = (c / cols) | 0;
        u0 = col / cols + P.pu; u1 = (col + 1) / cols - P.pu; v1 = 1 - row / rows - P.pv; v0 = 1 - (row + 1) / rows + P.pv;
        for (k = 0; k < 4; k++) {
          lx = LX[k]; ly = LY[k];
          ox = lx * cr - ly * sr; oy = lx * sr + ly * cr;
          var vo = (i * 4 + k);
          P.pos[vo * 3] = px + rX * ox + uX * oy; P.pos[vo * 3 + 1] = py + rY * ox + uY * oy; P.pos[vo * 3 + 2] = pz + rZ * ox + uZ * oy;
          br = 1 + P.shade[i] * (oy / (sz + 1e-5)) * 0.42;
          P.col[vo * 4] = ar * br; P.col[vo * 4 + 1] = ag * br; P.col[vo * 4 + 2] = ab * br; P.col[vo * 4 + 3] = aa;
          P.uv[vo * 2] = k === 0 || k === 3 ? u0 : u1; P.uv[vo * 2 + 1] = k < 2 ? v0 : v1;
        }
      }
      n = P.n; P.geo.setDrawRange(0, n * 6); P.mesh.visible = n > 0;
      if (n) {
        var A = P.geo.attributes;
        A.position.needsUpdate = A.uv.needsUpdate = A.color.needsUpdate = true;
        A.position.updateRanges.length = 0; A.position.addUpdateRange(0, n * 12);
        A.uv.updateRanges.length = 0; A.uv.addUpdateRange(0, n * 8);
        A.color.updateRanges.length = 0; A.color.addUpdateRange(0, n * 16);
      }
    }
  }
  function room(frac) { return SP.pools[1].n < SP.pools[1].cap * frac; }
  // --- Sprite-Bausteine (nur spTier > 0)
  /** Rauchpuff: g = Grauwert (linear), a = Deckkraft, hot = orange Anfangsglut. */
  function sm(x, y, z, vx, vy, vz, life, s0, s1, g, a, hot, rv) {
    spn(1, (rnd() * 4) | 0, 0, x, y, z, vx, vy, vz, life, s0, s1, rnd() * 6.283, rv != null ? rv : (rnd() - 0.5) * 0.9, g + hot * 0.3, g + hot * 0.12, g + hot * 0.02, a, g * 1.12, g * 1.1, g * 1.04, 0, 0, 0.9, 0.9, 1);
  }
  function dstS(x, y, z, vx, vy, vz, life, s0, s1, a, g) {
    g = g || 1; spn(1, 4 + ((rnd() * 4) | 0), 0, x, y, z, vx, vy, vz, life, s0, s1, rnd() * 6.283, (rnd() - 0.5) * 0.6, 0.46 * g, 0.37 * g, 0.24 * g, a, 0.36 * g, 0.3 * g, 0.2 * g, 0, 0, 1.9, 0.55, 1);
  }
  function fbl(x, y, z, vx, vy, vz, life, s0, s1, k, r0, g0, b0) {     // Feuerball-Sprite (Flipbook)
    spn(0, 0, 8, x, y, z, vx, vy, vz, life, s0, s1, rnd() * 6.283, (rnd() - 0.5) * 1.6, (r0 == null ? 1.0 : r0) * GN * k, (g0 == null ? 0.7 : g0) * GN * k, (b0 == null ? 0.28 : b0) * GN * k, 1, 0.55 * GN * k, 0.08 * GN * k, 0.02 * GN, 0, 0, 1.6, 0, 1);
  }
  function tng(x, y, z, vy, life, size, k) {                       // Flammenzunge (Textur trägt den Farbverlauf), flackert über 4 Bilder
    spn(0, 12, 4, x, y + size * 0.45, z, (rnd() - 0.5) * 0.15, vy, (rnd() - 0.5) * 0.15, life, size * 0.8, size * 1.05, 0, 0, 1.0 * GN * k, 0.9 * GN * k, 0.8 * GN * k, 0.95, 0.7 * GN * k, 0.5 * GN * k, 0.4 * GN * k, 0, 0, 0.6, 0, 0);
  }
  function glw(x, y, z, s0, s1, r, g, b, life, a) { spn(0, 8, 0, x, y, z, 0, 0, 0, life, s0, s1, 0, 0, r * GN, g * GN, b * GN, a, r * 0.5 * GN, g * 0.4 * GN, b * 0.3 * GN, 0, 0, 0, 0, 0); }
  function star(x, y, z, s0, s1, r, g, b, life) { spn(0, 9, 0, x, y, z, 0, 0, 0, life, s0, s1, (rnd() - 0.5) * 1.2, 0, r * GN, g * GN, b * GN, 1, r * GN, g * 0.6 * GN, b * 0.3 * GN, 0, 0, 0, 0, 0); }
  function spk(x, y, z, vx, vy, vz, life, size, r, g, b, grav, drag) { spn(0, 10, 0, x, y, z, vx, vy, vz, life, size, size * 0.45, 0, 0, r * GN, g * GN, b * GN, 1, r * 0.7 * GN, g * 0.3 * GN, b * 0.1 * GN, 0, grav, drag || 0, 0, 0); }
  // --- Bewegung: Untergrund-abhängiger Staub, Mündungsstrahl, Hülsen, Erdfontäne, Trefferblitz
  /** Untergrund an Weltposition (Kacheln): 0 Gras/sonst, 1 Sand, 2 Straße/Brücke, 3 Wasser. */
  function terrK(x, z) {
    var S = G.Sim.S, m = S && S.map, tx = x | 0, tz = z | 0;
    if (!m || tx < 0 || tz < 0 || tx >= m.w || tz >= m.h) return 0;
    var id = D.TERRAIN[m.terrain[tz * m.w + tx]].id;
    return id === 'sand' ? 1 : ((id === 'road' || id === 'bridge') ? 2 : (id === 'water' ? 3 : 0));
  }
  var DCOL = [[0.36, 0.33, 0.21, 0.8], [0.6, 0.5, 0.33, 1.3], [0.4, 0.4, 0.4, 0.3], [0.85, 0.9, 0.95, 1]];   // Staubfarbe (linear) + Menge je Untergrund
  /** Staub in der Farbe des Untergrunds k (nur Sprite-Stufen). */
  function dstC(x, y, z, vx, vy, vz, life, s0, s1, a, k) {
    var c = DCOL[k];
    spn(1, 4 + ((rnd() * 4) | 0), 0, x, y, z, vx, vy, vz, life, s0, s1, rnd() * 6.283, (rnd() - 0.5) * 0.6, c[0], c[1], c[2], a, c[0] * 0.8, c[1] * 0.8, c[2] * 0.8, 0, 0, 1.9, 0.55, 1);
  }
  /** Mündungsstrahl: n kurze Feuerzungen entlang (dx, dz) (nur Sprite-Stufen). */
  function mzJet(x, y, z, dx, dz, k, n) {
    for (var i = 0; i < n; i++) fbl(x + dx * 0.1 * i * k, y, z + dz * 0.1 * i * k, dx * (2.2 + i) * k, 0.1, dz * (2.2 + i) * k, 0.07 + 0.025 * i, 0.2 * k, (0.42 + 0.1 * i) * k, 1.0, 1.0, 0.82, 0.45);
  }
  /** Ausgeworfene Hülse (kleines Messing-Trümmerstück, quer zur Schussrichtung) – nur wenn der Trümmer-Vorrat reichlich frei ist. */
  function casing(x, y, z, dx, dz) {
    if (!DB || DB.n > DB.N * 0.35) return;
    var sp = 0.9 + rnd() * 0.7;
    chunk(x - dx * 0.12, y, z - dz * 0.12, -dz * sp - dx * 0.3, 1.6 + rnd() * 0.9, dx * sp - dz * 0.3, 0.03, 0.9, 0.66, 0.2, 0.75 + rnd() * 0.3);
  }
  /** Erd-/Sand-/Wasserfontäne bei Einschlägen in den Boden (k = Stärke). */
  function fountain(x, gy, z, k) {
    var tk = terrK(x, z), i, a, sp, n, c = DCOL[tk];
    if (!spTier) return;
    n = Math.max(2, Math.round(5 * k * spQ));
    for (i = 0; i < n; i++) { a = rnd() * 6.283; sp = rnd() * 0.5; dstC(x + Math.cos(a) * 0.08, gy + 0.1, z + Math.sin(a) * 0.08, Math.cos(a) * sp, (2.4 + rnd() * 2.6) * Math.sqrt(k), Math.sin(a) * sp, 0.7 + rnd() * 0.5, 0.22 * k, 0.75 * k, 0.75, tk); }
    if (tk === 2) return;
    n = Math.round(3 * k * (spTier === 2 ? 1 : 0.5));
    for (i = 0; i < n; i++) { a = rnd() * 6.283; sp = 0.5 + rnd() * 1.1; chunk(x, gy + 0.15, z, Math.cos(a) * sp, 3 + rnd() * 2.5, Math.sin(a) * sp, 0.045 + rnd() * 0.035, c[0] * 0.6, c[1] * 0.6, c[2] * 0.6, 0.9 + rnd() * 0.6); }
  }
  /** Trefferblitz + Ruck: Einheit id bzw. Einheiten im Umkreis rad (Sim-Pixel) um (px, py) – liest nur, schreibt den Render-Zustand rs. */
  function hitMark(id, k) { var r = rs.get(id); if (r) { r.hitT = fx.time; r.hitK = k || 1; } }   // k: 1 = Granate/Rakete, klein = Kugeln
  function hitNear(px, py, rad) {
    var ents = G.Sim.S.ents, i, e, dx, dy, any = false;
    for (i = 0; i < ents.length; i++) {
      e = ents[i]; if (e.kind !== 'unit' || e.dead) continue;
      dx = e.x - px; dy = e.y - py;
      if (dx * dx + dy * dy < rad * rad) { hitMark(e.id); any = true; }
    }
    return any;
  }
  /** Rauch/Staub-Puff, in allen Stufen (spTier 0: klassisches Punkt-Partikel). */
  function puff(x, y, z, vx, vy, vz, life, s0, s1, g, a, hot) {
    if (spTier) { if (room(0.97)) sm(x, y, z, vx, vy, vz, life, s0, s1, g, a, hot || 0); return; }
    var c = Math.pow(g, 0.4545); emit(1, x, y, z, vx, vy, vz, life, s0, s1, Math.min(1, c + (hot || 0) * 0.3), c, c, a, c, c, c, 0, 0, 1.2);
  }
  /** Bodenwelle (flach, additiv): kind 0 Ring, 1 Lichtfleck. */
  function wave(kind, x, z, r0, r1, dur, cr, cg, cb, delay) {
    var i, w = null;
    for (i = 0; i < waves.length; i++) if (!waves[i].on) { w = waves[i]; break; }
    if (!w) w = waves[(rnd() * waves.length) | 0];
    w.on = true; w.kind = kind; w.x = x; w.z = z; w.y = groundAt(x, z) + (kind ? 0.04 : 0.06); w.t0 = fx.time + (delay || 0); w.dur = dur; w.r0 = r0; w.r1 = r1; w.cr = cr; w.cg = cg; w.cb = cb;
  }
  /** Trümmerstück (Instanz, ballistisch, springt, schrumpft am Ende). */
  function chunk(x, y, z, vx, vy, vz, size, r, g, b, life) {
    if (!DB || DB.n >= DB.N * (spTier === 2 ? 1 : 0.55)) return;
    var i = DB.n++;
    DB.x[i] = x; DB.y[i] = y; DB.z[i] = z; DB.vx[i] = vx; DB.vy[i] = vy; DB.vz[i] = vz; DB.age[i] = 0; DB.life[i] = life; DB.size[i] = size;
    DB.yaw[i] = rnd() * 6.283; DB.pit[i] = rnd() * 6.283; DB.wy[i] = (rnd() - 0.5) * 16; DB.wp[i] = (rnd() - 0.5) * 20; DB.r[i] = r; DB.g[i] = g; DB.b[i] = b; DB.bn[i] = 0;
  }
  function updDebris(dt) {
    var i, l, gy, s, ca, sa, cb, sb, e, o, fade;
    for (i = 0; i < DB.n; i++) {
      DB.age[i] += dt;
      if (DB.age[i] >= DB.life[i]) { l = --DB.n; if (i !== l) { for (var q = 0; q < DEBF.length; q++) DB[DEBF[q]][i] = DB[DEBF[q]][l]; } i--; continue; }
      DB.vy[i] -= 15 * dt;
      DB.x[i] += DB.vx[i] * dt; DB.y[i] += DB.vy[i] * dt; DB.z[i] += DB.vz[i] * dt;
      s = DB.size[i]; gy = groundAt(DB.x[i], DB.z[i]) + s * 0.3;
      if (DB.y[i] < gy) {
        DB.y[i] = gy;
        if (DB.vy[i] < -1.3 && DB.bn[i] < 3) { DB.vy[i] *= -0.36; DB.vx[i] *= 0.62; DB.vz[i] *= 0.62; DB.wy[i] *= 0.6; DB.wp[i] *= 0.6; DB.bn[i]++; if (spTier && s > 0.09 && room(0.8)) dstS(DB.x[i], gy, DB.z[i], 0, 0.25, 0, 0.6, 0.12, 0.4, 0.3, 0.9); }
        else { DB.vy[i] = 0; DB.vx[i] *= 0.84; DB.vz[i] *= 0.84; DB.wy[i] *= 0.7; DB.wp[i] *= 0.6; }
      } else { DB.yaw[i] += DB.wy[i] * dt; DB.pit[i] += DB.wp[i] * dt; if (spTier && DB.age[i] < 0.7 && s > 0.075 && rnd() < dt * 16 * spQ && room(0.85)) sm(DB.x[i], DB.y[i], DB.z[i], 0, 0.2, 0, 0.7, 0.08, 0.3, 0.12, 0.4, 0.2); }
      fade = Math.min(1, (DB.life[i] - DB.age[i]) / 0.5);
      DB.bat.put(0, 0, 0, 0, 1, 1, 1, DB.r[i], DB.g[i], DB.b[i]);
      e = DB.bat.mesh.instanceMatrix.array; o = (DB.bat.n - 1) * 16;
      ca = Math.cos(DB.yaw[i]); sa = Math.sin(DB.yaw[i]); cb = Math.cos(DB.pit[i]); sb = Math.sin(DB.pit[i]);
      s *= fade;
      e[o] = ca * s; e[o + 1] = 0; e[o + 2] = -sa * s; e[o + 4] = sa * sb * s * 0.8; e[o + 5] = cb * s * 0.8; e[o + 6] = ca * sb * s * 0.8; e[o + 8] = sa * cb * s; e[o + 9] = -sb * s; e[o + 10] = ca * cb * s;
      e[o + 12] = DB.x[i]; e[o + 13] = DB.y[i]; e[o + 14] = DB.z[i];
    }
  }
  var DEBF = ['x', 'y', 'z', 'vx', 'vy', 'vz', 'age', 'life', 'size', 'yaw', 'pit', 'wy', 'wp', 'r', 'g', 'b', 'bn'];
  function updWaves() {
    var i, w, f, rad, fd, B;
    for (i = 0; i < waves.length; i++) {
      w = waves[i]; if (!w.on) continue;
      f = (fx.time - w.t0) / w.dur;
      if (f >= 1) { w.on = false; continue; }
      if (f < 0) continue;
      rad = w.r0 + (w.r1 - w.r0) * (1 - Math.pow(1 - f, 2.2)); fd = Math.pow(1 - f, 1.6) * GN;
      B = w.kind ? wvGlow : wvRing;
      B.put(w.x, w.y, w.z, 0, rad, 1, rad, w.cr * fd, w.cg * fd, w.cb * fd);
    }
  }
  /** Brennende Stelle (Wrack, Ruine, Einschlag): Rauchsäule + Flammen über dur Sekunden, sz = Größe. */
  function burn(x, z, dur, sz, fire) {
    var i, b = null, oldest = 1e9, k = 0;
    for (i = 0; i < burns.length; i++) { if (!burns[i].on) { b = burns[i]; break; } if (burns[i].t0 < oldest) { oldest = burns[i].t0; k = i; } }
    if (!b) b = burns[k];
    b.on = true; b.x = x; b.z = z; b.y = groundAt(x, z); b.t0 = fx.time; b.dur = dur; b.sz = sz; b.acc = 0; b.fire = fire || 0;
  }
  function updBurns(dt) {
    var i, b, f, rate, a, sc = spTier ? spQ : 0.35;
    for (i = 0; i < burns.length; i++) {
      b = burns[i]; if (!b.on) continue;
      f = (fx.time - b.t0) / b.dur;
      if (f >= 1) { b.on = false; continue; }
      if (!inViewT(b.x, b.z)) continue;
      rate = (4.5 * (1 - f * 0.8)) * sc * (0.7 + 0.5 * b.sz); b.acc += dt * rate;
      while (b.acc >= 1) {
        b.acc -= 1; a = rnd() * 6.283;
        puff(b.x + Math.cos(a) * 0.18 * b.sz, b.y + 0.3 * b.sz, b.z + Math.sin(a) * 0.18 * b.sz, 0.32 + rnd() * 0.2, 0.8 + rnd() * 0.7, (rnd() - 0.5) * 0.2, 2.2 + rnd() * 1.3, 0.3 * b.sz, 1.2 * b.sz, 0.06 + 0.08 * f, 0.5 * (1 - f * 0.5), (1 - f) * 0.35);
        if (spTier && f < 0.7 && b.fire && rnd() < 0.55) tng(b.x + (rnd() - 0.5) * 0.45 * b.sz, b.y + 0.12, b.z + (rnd() - 0.5) * 0.45 * b.sz, 0.5 + rnd() * 0.5, 0.45 + rnd() * 0.3, (0.38 + rnd() * 0.3) * b.sz * (1 - f * 0.6), 0.9);
        if (spTier && f < 0.5 && rnd() < 0.2) spk(b.x + (rnd() - 0.5) * 0.3, b.y + 0.3, b.z + (rnd() - 0.5) * 0.3, (rnd() - 0.5) * 0.5, 1 + rnd() * 1.2, (rnd() - 0.5) * 0.5, 0.7 + rnd() * 0.6, 0.06, 1, 0.55, 0.15, -0.5, 0.5);
      }
    }
  }
  var DEB_COL = [0.1, 0.095, 0.09], BLD_DEB = [0.3, 0.28, 0.25], UNIT_DEB = [0.1, 0.1, 0.1];
  // ------------------------------------------------------------------ v0.6b: Effekt-Bausteine je Stufe (Sprites) – Mündungsfeuer, Explosionen, Einschläge, Staub
  function sparkleS(x, y, z, k) {
    star(x, y, z, 0.8 * k, 1.5 * k, 1.0, 0.8, 0.4, 0.08);
    glw(x, y, z, 1.0 * k, 1.6 * k, 1.0, 0.6, 0.2, 0.1, spTier === 2 ? 0.6 : 0.9);
    if (rnd() < 0.5 + 0.5 * spQ) puff(x, y, z, (rnd() - 0.5) * 0.3, 0.25, (rnd() - 0.5) * 0.3, 0.55, 0.08 * k, 0.32 * k, 0.32, 0.3, 0.1);
    if (k >= 1.4) flashAt(x, y + 0.1, z, 0.08, 0.9 + k * 0.5);
  }
  function explosionS(x, y, z, k, debris, dc) {
    var q = spQ, t2 = spTier === 2, i, a, sp, n, c, m, kg;
    kg = Math.pow(k, 0.75);
    glw(x, y + 0.25 * k, z, 0.9 * kg, 1.9 * kg, 1.0, 0.8, 0.45, 0.14, 0.85);
    if (!t2) glw(x, y + 0.25 * k, z, 2.2 * kg, 3.2 * kg, 1.0, 0.55, 0.2, 0.3, 0.4);       // Lite: Lichthof statt Bloom
    if (k >= 0.5) star(x, y + 0.3 * k, z, 1.0 * kg, 1.9 * kg, 1.0, 0.9, 0.65, 0.09);
    wave(1, x, z, 0.3 * kg, 1.5 * kg, 0.45, 0.5, 0.26, 0.1);
    if (k >= 0.5) wave(0, x, z, 0.2 * kg, 1.9 * kg, 0.4, 0.45, 0.38, 0.27);
    n = Math.max(2, Math.round((3 + 5 * k) * q));
    for (i = 0; i < n; i++) {          // Feuerball: Flipbook-Sprites, wachsen und steigen
      a = rnd() * 6.283; sp = rnd() * 0.5 * k;
      fbl(x + Math.cos(a) * sp * 0.5, y + 0.1 * k + rnd() * 0.2 * k, z + Math.sin(a) * sp * 0.5, Math.cos(a) * sp * 1.1, 0.5 + rnd() * 1.2 * k, Math.sin(a) * sp * 1.1, 0.34 + rnd() * 0.3 + 0.12 * k, 0.5 * k, (0.9 + rnd() * 0.7) * k, 0.8);
    }
    if (k >= 0.8) { n = Math.round((2 + 2 * k) * q); for (i = 0; i < n; i++) { a = rnd() * 6.283; sp = rnd() * 0.4 * k; tng(x + Math.cos(a) * sp, y, z + Math.sin(a) * sp, 0.7 + rnd() * 0.8, 0.55 + rnd() * 0.4, (0.55 + rnd() * 0.3) * k, 1); } }
    n = Math.max(2, Math.round((2 + 4 * k) * q));
    for (i = 0; i < n; i++) {          // aufsteigender Rauch (heiß → grau)
      a = rnd() * 6.283; sp = rnd() * 0.3 * k;
      puff(x + Math.cos(a) * sp * 0.4, y + 0.2 * k, z + Math.sin(a) * sp * 0.4, Math.cos(a) * sp + 0.12, 0.7 + rnd() * 1.1 * Math.sqrt(k), Math.sin(a) * sp, 1.6 + rnd() * 1.3 + 0.4 * k, 0.45 * k, (1.7 + rnd() * 0.8) * k, 0.1, 0.6, 0.45);
    }
    n = Math.round((5 + 8 * k) * q);
    for (i = 0; i < n; i++) {          // Staub-/Rauchring am Boden
      a = i / n * 6.283 + rnd() * 0.4; sp = (1.0 + rnd() * 0.9) * (0.5 + 0.6 * k);
      dstS(x + Math.cos(a) * 0.15 * k, y + 0.05, z + Math.sin(a) * 0.15 * k, Math.cos(a) * sp, 0.1 + rnd() * 0.25, Math.sin(a) * sp, 0.8 + rnd() * 0.6, 0.3 * k, (0.9 + rnd() * 0.5) * k, 0.3, 0.9);
    }
    n = Math.round((6 + 10 * k) * q);
    for (i = 0; i < n; i++) {          // Funken
      a = rnd() * 6.283; sp = (1.2 + rnd() * 3.0) * (0.6 + 0.4 * k);
      spk(x, y + 0.15, z, Math.cos(a) * sp, 2 + rnd() * 4, Math.sin(a) * sp, 0.35 + rnd() * 0.4, 0.08 + rnd() * 0.04, 1.0, 0.8, 0.35, -10, 0.2);
    }
    if (k >= 0.6) { n = Math.round((2 + 4 * k) * q); for (i = 0; i < n; i++) { a = rnd() * 6.283; spk(x + Math.cos(a) * 0.2, y + 0.2, z + Math.sin(a) * 0.2, Math.cos(a) * 0.5, 0.5 + rnd() * 1.0, Math.sin(a) * 0.5, 1.2 + rnd() * 1.1, 0.06, 1.0, 0.45, 0.1, 0.3, 0.6); } }   // Glut
    if (debris) {
      n = Math.round((2 + 3 * k) * (spTier === 2 ? 1 : 0.6)); c = dc || DEB_COL;
      for (i = 0; i < n; i++) {
        a = rnd() * 6.283; sp = 0.7 + rnd() * 1.5 * (0.5 + 0.5 * k); m = 0.5 + rnd() * 0.7;
        chunk(x, y + 0.2, z, Math.cos(a) * sp, 3 + rnd() * 3.5 * Math.sqrt(k), Math.sin(a) * sp, (0.05 + rnd() * 0.05) * (0.7 + 0.4 * k), c[0] * m, c[1] * m, c[2] * m, 1.2 + rnd() * 1.2);
      }
    }
    if (k >= 0.6) { flash.position.set(x, y + 0.6, z); fx.flashT = Math.max(fx.flashT, 0.25 * Math.min(2, k)); fx.flashK = Math.min(3, 1.2 * k + 0.5); }
  }
  function dustS(x, y, z, k) {
    var n = Math.max(1, Math.round((3 + 4 * k) * spQ)), i, a, sp;
    for (i = 0; i < n; i++) { a = rnd() * 6.283; sp = 0.3 + rnd() * 0.6; dstS(x + Math.cos(a) * 0.3 * k, y + 0.05, z + Math.sin(a) * 0.3 * k, Math.cos(a) * sp * k, 0.12 + rnd() * 0.25, Math.sin(a) * sp * k, 0.9 + rnd() * 0.6, 0.3 * k, (0.8 + rnd() * 0.5) * k, 0.38); }
  }
  /** Einschläge von Kugeln je Panzerung: inf (Erde), light/heavy (Metallfunken), building (Betonstaub + Splitter). */
  function impact(x, y, z, ar) {
    var i, a, sp;
    if (!spTier) { emit(0, x, y, z, 0, 0.4, 0, 0.12, 0.12, 0.04, 1, 0.8, 0.4, 1, 1, 0.5, 0.1, 0); return; }
    if (ar === 'inf') {
      for (i = 0; i < 2; i++) dstS(x + (rnd() - 0.5) * 0.1, y, z + (rnd() - 0.5) * 0.1, (rnd() - 0.5) * 0.5, 0.5 + rnd() * 0.5, (rnd() - 0.5) * 0.5, 0.5 + rnd() * 0.3, 0.1, 0.38, 0.5, 0.7);
      spk(x, y, z, (rnd() - 0.5), 1.5, (rnd() - 0.5), 0.2, 0.05, 0.7, 0.45, 0.2, -9, 0);
      return;
    }
    glw(x, y + 0.05, z, 0.35, 0.7, 1.0, 0.75, 0.35, 0.1, 0.8);
    star(x, y + 0.05, z, 0.45, 0.65, 1.0, 0.9, 0.6, 0.07);
    for (i = 0; i < Math.max(2, Math.round(5 * spQ)); i++) { a = rnd() * 6.283; sp = 0.8 + rnd() * 1.8; spk(x, y, z, Math.cos(a) * sp, 1.2 + rnd() * 2.6, Math.sin(a) * sp, 0.2 + rnd() * 0.25, 0.055, 1.0, 0.82, 0.45, -9, 0); }
    if (ar === 'building') dstS(x, y, z, (rnd() - 0.5) * 0.3, 0.3, (rnd() - 0.5) * 0.3, 0.7, 0.14, 0.5, 0.42, 0.85);
  }
  function beamImpactS(x, y, z, kind, k) {
    var r = kind ? 0.55 : 0.35, g = kind ? 0.7 : 0.9, b = 1, i, a, sp, t2 = spTier === 2;
    glw(x, y + 0.08, z, 1.3 * k, 2.3 * k, r, g, b, 0.24, t2 ? 0.8 : 1);
    star(x, y + 0.1, z, 1.0 * k, 0.5 * k, 0.8, 0.95, 1, 0.12);
    glw(x, y + 0.1, z, 0.4 * k, 0.15 * k, 1, 1, 1, 0.1, 1);
    wave(0, x, z, 0.1 * k, 0.85 * k, 0.3, r * 0.6, g * 0.6, b * 0.6);
    for (i = 0; i < Math.max(3, Math.round(((kind ? 7 : 6) + 3) * spQ)); i++) { a = rnd() * 6.283; sp = 0.6 + rnd() * 1.5; spk(x, y, z, Math.cos(a) * sp, 0.8 + rnd() * 2.0, Math.sin(a) * sp, 0.2 + rnd() * 0.3, 0.07, r + 0.4, g + 0.3, 1, -7, 0); }
    if (!kind) { glw(x, y + 0.05, z, 0.5, 0.3, 1, 0.45, 0.12, 0.7, 0.45); puff(x, y + 0.1, z, 0.1, 0.5, 0, 0.9, 0.1, 0.45, 0.25, 0.3, 0.1); }   // glühender Boden + dünner Rauch
  }
  /** Superwaffen-Druckwelle (Sprites): Blitz, Feuerball, aufsteigender Ball, Staubring, Rauchsäule, Trümmer, Funken, Glut. */
  function swBlastS(x, gy, z, r, orb) {
    var q = spQ, n, i, a, sp, c = orb ? [0.45, 0.8, 1.0] : [1.0, 0.62, 0.22], t2 = spTier === 2, m;
    glw(x, gy + 0.8, z, r * 0.35, r * 0.9, 1, 0.95, 0.8, 0.3, t2 ? 0.5 : 0.8);
    if (!t2) glw(x, gy + 0.5, z, r * 0.9, r * 1.7, c[0], c[1], c[2], 0.7, 0.55);
    star(x, gy + 1, z, r * 0.5, r * 1.1, 1, 0.95, 0.85, 0.15);
    wave(1, x, z, r * 0.5, r * 1.6, 1.4, c[0] * 0.3, c[1] * 0.3, c[2] * 0.3);
    wave(0, x, z, 0.3, r * 1.8, 0.8, 1, 0.92, 0.8); wave(0, x, z, 0.2, r * 1.35, 0.95, c[0], c[1], c[2], 0.12);
    n = Math.round(8 * q + 3);
    for (i = 0; i < n; i++) { a = rnd() * 6.283; sp = Math.sqrt(rnd()) * r * 0.5; fbl(x + Math.cos(a) * sp, gy + 0.4 + rnd() * 0.6, z + Math.sin(a) * sp, Math.cos(a) * sp * 0.6, 0.8 + rnd() * 2.2, Math.sin(a) * sp * 0.6, 0.6 + rnd() * 0.7, r * 0.45, r * (0.7 + rnd() * 0.6), 0.8, orb ? 0.55 : 1, orb ? 0.85 : 0.7, orb ? 1 : 0.28); }
    n = Math.round(3 * q + 2);
    for (i = 0; i < n; i++) fbl(x + (rnd() - 0.5) * r * 0.5, gy + r * 0.3, z + (rnd() - 0.5) * r * 0.5, (rnd() - 0.5) * 0.8, 2.5 + rnd() * 2.2, (rnd() - 0.5) * 0.8, 1.0 + rnd() * 0.6, r * 0.5, r * (0.9 + rnd() * 0.4), 0.7, orb ? 0.55 : 1, orb ? 0.85 : 0.6, orb ? 1 : 0.22);
    n = Math.round(16 * q + 5);
    for (i = 0; i < n; i++) { a = i / n * 6.283 + rnd() * 0.2; sp = r / 0.8 * (0.7 + rnd() * 0.5); dstS(x + Math.cos(a) * 0.4, gy + 0.1, z + Math.sin(a) * 0.4, Math.cos(a) * sp, 0.25 + rnd() * 0.5, Math.sin(a) * sp, 1.1 + rnd() * 0.7, 0.8, 2.4, 0.6); }
    n = Math.round(18 * q + 5);
    for (i = 0; i < n; i++) { a = rnd() * 6.283; sp = rnd() * r * 0.3; puff(x + Math.cos(a) * sp, gy + 0.3, z + Math.sin(a) * sp, Math.cos(a) * 0.3, 1.8 + rnd() * 2.6, Math.sin(a) * 0.3, 3 + rnd() * 2.4, 0.9, 3.2, 0.08 + rnd() * 0.05, 0.75, 0.55); }
    n = Math.round(18 * q + 4);
    for (i = 0; i < n; i++) { a = rnd() * 6.283; sp = 3 + rnd() * r * 1.4; m = 0.6 + rnd() * 0.9; chunk(x, gy + 0.3, z, Math.cos(a) * sp, 6 + rnd() * 7, Math.sin(a) * sp, 0.1 + rnd() * 0.12, 0.1 * m, 0.095 * m, 0.09 * m, 2.2 + rnd() * 1.5); }
    n = Math.round(36 * q + 8);
    for (i = 0; i < n; i++) { a = rnd() * 6.283; sp = 3 + rnd() * r * 1.8; spk(x, gy + 0.3, z, Math.cos(a) * sp, 3 + rnd() * 9, Math.sin(a) * sp, 0.5 + rnd() * 0.7, 0.1, c[0] + 0.2, c[1] + 0.2, c[2] + 0.1, -11, 0); }
    n = Math.round(12 * q + 4);
    for (i = 0; i < n; i++) { a = rnd() * 6.283; sp = rnd() * r * 0.8; spk(x + Math.cos(a) * sp, gy + 0.2, z + Math.sin(a) * sp, (rnd() - 0.5) * 0.4, 0.6 + rnd() * 1.0, (rnd() - 0.5) * 0.4, 1.6 + rnd() * 1.0, 0.07, 1, 0.5, 0.12, 0.4, 0.4); }
  }
  /** Dauerhafte Quellen je Bild: Rauchsäulen/Flammen an beschädigten Gebäuden, Staubfahnen und Qualm an Fahrzeugen. */
  var AMB_V = { x: 0, z: 0 };
  function ambient(S, dt) {
    var ents = S.ents, i, e, fogOff = S.settings.fogOff, hf, sev, acc, h, bx, bz, sc = spTier ? spQ : 0.4, UN = D.UNITS, ud;
    for (i = 0; i < ents.length; i++) {
      e = ents[i];
      if (e.dead || !e.maxHp) continue;
      hf = e.hp / e.maxHp;
      if (e.kind === 'building') {
        if (hf >= 0.55 || e.type === 'wall') continue;
        bx = e.x / TILE; bz = e.y / TILE;
        if (!inViewT(bx, bz) || (!fogOff && !visibleAt(e.x, e.y))) continue;
        if (spTier && !room(0.62)) continue;
        sev = 1 - hf / 0.55; h = (M3.BH[e.type] || 1);
        acc = (accMap.get(e.id) || 0) + dt * (3.2 + 6 * sev) * sc;
        while (acc >= 1) {
          acc -= 1;
          puff(bx + (rnd() - 0.5) * e.w * 0.5, h * (0.7 + rnd() * 0.3), bz + (rnd() - 0.5) * e.h * 0.5, 0.35 + rnd() * 0.2, 1.3 + rnd() * 0.8, (rnd() - 0.5) * 0.1, 3.4 + rnd() * 1.6, 0.6, 2.6 + sev * 0.8, 0.05 + 0.12 * (1 - sev), 0.7, 0);
          if (spTier && hf < 0.3 && rnd() < 0.5) tng(bx + (rnd() - 0.5) * e.w * 0.6, h * (0.8 + rnd() * 0.2), bz + (rnd() - 0.5) * e.h * 0.6, 0.3 + rnd() * 0.4, 0.5 + rnd() * 0.3, 0.7 + rnd() * 0.4, 0.9);
          else if (!spTier && hf < 0.3 && rnd() < 0.5) emit(0, bx + (rnd() - 0.5) * e.w * 0.6, h * (0.8 + rnd() * 0.2), bz + (rnd() - 0.5) * e.h * 0.6, 0, 0.5, 0, 0.35, 0.3, 0.1, 1, 0.55, 0.15, 0.9, 1, 0.3, 0.05, 0);
        }
        accMap.set(e.id, acc);
      } else if (spTier && e.kind === 'unit') {
        ud = UN[e.type];
        if (!ud || ud.cat !== 'vehicle') continue;
        bx = e.x / TILE; bz = e.y / TILE;
        if (!inViewT(bx, bz) || (!fogOff && !visibleAt(e.x, e.y))) continue;
        if (!room(0.5)) continue;
        if (hf < 0.4) {
          acc = (accMap.get(e.id) || 0) + dt * (3 + 4 * (0.4 - hf) / 0.4) * spQ;
          while (acc >= 1) {
            acc -= 1;
            sm(bx + (rnd() - 0.5) * 0.2, 0.4, bz + (rnd() - 0.5) * 0.2, 0.2, 0.7 + rnd() * 0.5, 0, 1.5 + rnd() * 0.8, 0.18, 0.7, 0.07, 0.5, 0.15);
            if (hf < 0.2 && rnd() < 0.5) tng(bx + (rnd() - 0.5) * 0.25, 0.35, bz + (rnd() - 0.5) * 0.25, 0.3 + rnd() * 0.3, 0.3 + rnd() * 0.2, 0.28 + rnd() * 0.15, 0.9);
          }
          accMap.set(e.id, acc);
        } else if (e.moving) {   // Bewegung: Staubfahne je Untergrund (Sand viel/hell, Gras wenig/dunkel, Straße kaum), abwechselnd hinter beiden Ketten/Rädern, beim Anfahren ein Schwall
          var rr = rs.get(e.id), tk = terrK(bx, bz), vf = rr ? Math.min(1.6, Math.abs(rr.vf) * 0.5) : 1, lat = (ud.radius || 11) / TILE * 0.6, gyv = groundAt(bx, bz), sdr, cdx = Math.cos(e.dir), sdz = Math.sin(e.dir);
          acc = (accMap.get(e.id) || 0) + dt * 4.2 * spQ * DCOL[tk][3] * (0.35 + vf) * (rr && rr.pv > 0.04 ? 2.6 : 1);
          while (acc >= 1) {
            acc -= 1; sdr = rnd() < 0.5 ? -lat : lat;
            if (tk === 3) puff(bx - cdx * 0.3 - sdz * sdr, M3.WL + 0.05, bz - sdz * 0.3 + cdx * sdr, -cdx * 0.3, 0.5 + rnd() * 0.5, -sdz * 0.3, 0.6 + rnd() * 0.3, 0.12, 0.5, 0.9, 0.5, 0);
            else dstC(bx - cdx * 0.34 - sdz * sdr + (rnd() - 0.5) * 0.08, gyv + 0.05, bz - sdz * 0.34 + cdx * sdr + (rnd() - 0.5) * 0.08, -cdx * 0.25, 0.14 + rnd() * 0.2, -sdz * 0.25, 0.9 + rnd() * 0.6, 0.16, 0.66, tk === 1 ? 0.3 : 0.24, tk);
          }
          accMap.set(e.id, acc);
        }
      }
    }
    if (accMap.size > 500) accMap.clear();
  }

  /** Partikel erzeugen. pool 0 = additiv (Feuer, Blitze), 1 = normal (Rauch, Staub, Trümmer). */
  function emit(pool, x, y, z, vx, vy, vz, life, s0, s1, r0, g0, b0, a0, r1, g1, b1, a1, grav, drag) {
    var P = fx.pools[pool], lim = Math.min(P.N, pool === 0 ? fx.max * 0.45 : fx.max * 0.55) | 0, i;
    if (P.n < lim) i = P.n++; else i = (Math.random() * P.n) | 0;
    P.x[i] = x; P.y[i] = y; P.z[i] = z; P.vx[i] = vx; P.vy[i] = vy; P.vz[i] = vz;
    P.age[i] = 0; P.life[i] = life; P.s0[i] = s0; P.s1[i] = s1;
    var o = i * 4;
    P.c0[o] = r0; P.c0[o + 1] = g0; P.c0[o + 2] = b0; P.c0[o + 3] = a0;
    P.c1[o] = r1; P.c1[o + 1] = g1; P.c1[o + 2] = b1; P.c1[o + 3] = a1;
    P.grav[i] = grav || 0; P.drag[i] = drag || 0;
  }
  /** v0.6 Modern Lite: Ersatz für Bloom – großer, schwacher additiver Lichthof (nur Partikel-Pool 0, keine Render-Targets). */
  function halo(x, y, z, size, r, g, b, life) {
    if (!R.lite) return;
    emit(0, x, y, z, 0, 0, 0, life, size, size * 1.3, r * 0.45, g * 0.45, b * 0.45, 0.55, r * 0.2, g * 0.2, b * 0.2, 0);
  }
  function sparkleL(x, y, z, k) { // Mündungsblitz
    emit(0, x, y, z, 0, 0.2, 0, 0.07, 0.32 * k, 0.12 * k, 1, 0.9, 0.55, 1, 1, 0.5, 0.1, 0);
    halo(x, y, z, 0.9 * k, 1, 0.75, 0.4, 0.1);
    emit(1, x, y, z, (rnd() - 0.5) * 0.3, 0.3, (rnd() - 0.5) * 0.3, 0.4, 0.06 * k, 0.2 * k, 0.6, 0.6, 0.58, 0.2, 0.5, 0.5, 0.5, 0, 0, 1);
  }
  function explosionL(x, y, z, k, debris) {
    var i, a, sp;
    halo(x, y + 0.2, z, 2.6 * k, 1, 0.6, 0.25, 0.35);
    emit(0, x, y + 0.1, z, 0, 0, 0, 0.14, 1.3 * k, 0.5 * k, 1, 0.95, 0.75, 1, 1, 0.6, 0.2, 0);
    var nf = Math.round(5 + 7 * k);
    for (i = 0; i < nf; i++) {
      a = rnd() * 6.283; sp = (0.4 + rnd() * 0.9) * k;
      emit(0, x, y + 0.08, z, Math.cos(a) * sp, 0.6 + rnd() * 1.2 * k, Math.sin(a) * sp, 0.3 + rnd() * 0.35, 0.42 * k, 0.12 * k, 1, 0.72, 0.28, 1, 0.75, 0.18, 0.04, 0, 0.5, 2.2);
    }
    var ns = Math.round(3 + 5 * k);
    for (i = 0; i < ns; i++) {
      a = rnd() * 6.283; sp = (0.15 + rnd() * 0.4) * k;
      emit(1, x + Math.cos(a) * 0.1, y + 0.1, z + Math.sin(a) * 0.1, Math.cos(a) * sp, 0.35 + rnd() * 0.5, Math.sin(a) * sp, 1.3 + rnd() * 1.2, 0.35 * k, 1.0 * k, 0.24, 0.22, 0.2, 0.7, 0.42, 0.4, 0.38, 0, -0.05, 1.2);
    }
    if (debris) for (i = 0; i < 8 * k; i++) {
      a = rnd() * 6.283; sp = 0.8 + rnd() * 1.6 * k;
      emit(1, x, y + 0.15, z, Math.cos(a) * sp, 1.8 + rnd() * 2.5, Math.sin(a) * sp, 0.6 + rnd() * 0.5, 0.07, 0.06, 0.12, 0.11, 0.1, 1, 0.12, 0.11, 0.1, 0.8, -9, 0);
      emit(0, x, y + 0.15, z, Math.cos(a) * sp * 1.4, 1.5 + rnd() * 2, Math.sin(a) * sp * 1.4, 0.35 + rnd() * 0.3, 0.06, 0.03, 1, 0.85, 0.4, 1, 1, 0.4, 0.1, 0, -6, 0);
    }
    if (k >= 0.6) { flash.position.set(x, y + 0.6, z); fx.flashT = Math.max(fx.flashT, 0.25 * Math.min(2, k)); fx.flashK = Math.min(3, 1.2 * k + 0.5); }
  }
  function dustL(x, y, z, k) {
    for (var i = 0; i < 10 * k; i++) {
      var a = rnd() * 6.283, sp = 0.4 + rnd() * 0.8;
      emit(1, x + Math.cos(a) * 0.3 * k, y + 0.05, z + Math.sin(a) * 0.3 * k, Math.cos(a) * sp * k, 0.15 + rnd() * 0.3, Math.sin(a) * sp * k, 0.9 + rnd() * 0.6, 0.3 * k, 0.8 * k, 0.62, 0.56, 0.45, 0.6, 0.62, 0.56, 0.45, 0, 0, 1.8);
    }
  }
  function sparkle(x, y, z, k) { if (spTier) sparkleS(x, y, z, k); else sparkleL(x, y, z, k); }
  function explosion(x, y, z, k, debris, dc) { if (spTier) explosionS(x, y, z, k, debris, dc); else explosionL(x, y, z, k, debris); }
  function dust(x, y, z, k) { if (spTier) dustS(x, y, z, k); else dustL(x, y, z, k); }
  function beamImpact(x, y, z, kind, k) { if (spTier) beamImpactS(x, y, z, kind, k); else beamImpactL(x, y, z, kind, k); }
  function tracer(x0, y0, z0, x1, y1, z1, life, kind) {
    var T = fx.tr, i = T.n < T.N ? T.n++ : (Math.random() * T.N) | 0;
    T.x0[i] = x0; T.y0[i] = y0; T.z0[i] = z0; T.x1[i] = x1; T.y1[i] = y1; T.z1[i] = z1; T.age[i] = 0; T.life[i] = life; T.kind[i] = kind || 0;
  }
  function updateFx(dt) {
    fx.time += dt; R.t = fx.time; syncTier();
    fx.uLin.value = R.post ? 1 : 0;
    for (var p = 0; p < 2; p++) {
      var P = fx.pools[p];
      for (var i = 0; i < P.n; i++) {
        P.age[i] += dt;
        if (P.age[i] >= P.life[i]) { // letzten hierher
          var l = --P.n;
          if (i !== l) {
            P.x[i] = P.x[l]; P.y[i] = P.y[l]; P.z[i] = P.z[l]; P.vx[i] = P.vx[l]; P.vy[i] = P.vy[l]; P.vz[i] = P.vz[l];
            P.age[i] = P.age[l]; P.life[i] = P.life[l]; P.s0[i] = P.s0[l]; P.s1[i] = P.s1[l]; P.grav[i] = P.grav[l]; P.drag[i] = P.drag[l];
            for (var q = 0; q < 4; q++) { P.c0[i * 4 + q] = P.c0[l * 4 + q]; P.c1[i * 4 + q] = P.c1[l * 4 + q]; }
          }
          i--; continue;
        }
        var dr = Math.max(0, 1 - P.drag[i] * dt);
        P.vx[i] *= dr; P.vz[i] *= dr; P.vy[i] = P.vy[i] * dr + P.grav[i] * dt;
        P.x[i] += P.vx[i] * dt; P.y[i] += P.vy[i] * dt; P.z[i] += P.vz[i] * dt;
        if (P.grav[i] < -1 && P.y[i] < 0) { P.y[i] = 0; P.vy[i] *= -0.3; P.vx[i] *= 0.5; P.vz[i] *= 0.5; }
        var f = P.age[i] / P.life[i], o = i * 4;
        P.pos[i * 3] = P.x[i]; P.pos[i * 3 + 1] = P.y[i]; P.pos[i * 3 + 2] = P.z[i];
        P.siz[i] = P.s0[i] + (P.s1[i] - P.s0[i]) * f;
        P.col[o] = P.c0[o] + (P.c1[o] - P.c0[o]) * f; P.col[o + 1] = P.c0[o + 1] + (P.c1[o + 1] - P.c0[o + 1]) * f;
        P.col[o + 2] = P.c0[o + 2] + (P.c1[o + 2] - P.c0[o + 2]) * f; P.col[o + 3] = P.c0[o + 3] + (P.c1[o + 3] - P.c0[o + 3]) * f;
      }
      P.geo.setDrawRange(0, P.n);
      if (P.n) {
        P.geo.attributes.position.needsUpdate = true; P.geo.attributes.aCol.needsUpdate = true; P.geo.attributes.aSize.needsUpdate = true;
        P.geo.attributes.position.updateRanges.length = 0; P.geo.attributes.position.addUpdateRange(0, P.n * 3);
        P.geo.attributes.aCol.updateRanges.length = 0; P.geo.attributes.aCol.addUpdateRange(0, P.n * 4);
        P.geo.attributes.aSize.updateRanges.length = 0; P.geo.attributes.aSize.addUpdateRange(0, P.n);
      }
    }
    if (spTier) updSprites(dt);
    // Leuchtspuren altern (Zeichnen in updateBeams)
    var T = fx.tr;
    for (i = 0; i < T.n; i++) {
      T.age[i] += dt;
      if (T.age[i] >= T.life[i]) {
        var l = --T.n;
        if (i !== l) { T.x0[i] = T.x0[l]; T.y0[i] = T.y0[l]; T.z0[i] = T.z0[l]; T.x1[i] = T.x1[l]; T.y1[i] = T.y1[l]; T.z1[i] = T.z1[l]; T.age[i] = T.age[l]; T.life[i] = T.life[l]; T.kind[i] = T.kind[l]; }
        i--;
      }
    }
    // Licht-Blitz
    if (fx.flashT > 0) { fx.flashT -= dt; flash.intensity = Math.max(0, fx.flashT) * 40 * (fx.flashK || 1) * (R.glowK || 1); }   // Tageszeit: nachts kräftiger (R.glowK, r3-mood.js) else flash.intensity = 0;
  }

  function consumeEvents(S) {
    var ev = S.events;
    for (var i = 0; i < ev.length; i++) {
      var e = ev[i];
      if (e.seq <= lastSeq) continue;
      var x = e.x / TILE, z = e.y / TILE;
      if ((e.t === 'mc' || e.t === 'clone' || e.t === 'recycle') && visibleAt(e.x, e.y)) {   // v1.0 PLATZHALTER v1.0
        wave(0, x, z, 0.2, e.t === 'mc' ? 1.1 : 0.7, 0.6, e.t === 'recycle' ? 0.5 : 0.62, e.t === 'recycle' ? 0.85 : 0.68, 1.0, 0);
        continue;
      }
      if (e.t === 'shot') {
        if (!visibleAt(e.x, e.y) && !visibleAt(e.tx, e.ty)) continue;
        var src = G.Sim.get(e.src);
        if (src && e.barrel != null) { var sbr = rs.get(src.id); if (sbr) { if (e.barrel) sbr.b1 = fx.time; else sbr.b0 = fx.time; } }
        if (e.aux && src) { var raa = rs.get(src.id); if (raa) { raa.aaDir = Math.atan2(e.ty - src.y, e.tx - src.x); raa.aaT0 = fx.time; } }   // v0.8: Zerstörer-Flak richtet sich aus
        if (src && !src.dead) M3.muzzleOf(src, tmpV, e.tx / TILE, e.ty / TILE, e.barrel, e.aux); else tmpV.set(x, 0.3, z);
        var tx = e.tx / TILE, tz = e.ty / TILE, ty = groundAt(tx, tz) + 0.18;
        if (e.air) ty = airY(e.tid, tx, tz);   // v0.8: Ziel in der Luft → Leuchtspur/Strahl in Flughöhe
        // Bewegung: Schussrichtung (waagerecht, normiert) für Mündungsstrahl/Hülsen/Rückstrahl; Sofort-Treffer lassen das Ziel aufblitzen
        var sdx = tx - tmpV.x, sdz = tz - tmpV.z, sdl = Math.sqrt(sdx * sdx + sdz * sdz) || 1; sdx /= sdl; sdz /= sdl;
        if (e.tid && (e.w === 'bullet' || e.w === 'sniper' || e.w === 'flame' || e.w === 'laser' || e.w === 'lightning' || e.w === 'melee')) hitMark(e.tid, e.w === 'bullet' ? 0.3 : (e.w === 'flame' ? 0.2 : 0.7));
        if (e.w === 'psi') {               // v1.0 PLATZHALTER v1.0: Psi-Strahl (Blitz-Optik) + Ring am Ziel
          lightningShot(e, src, tx, ty, tz); wave(0, tx, tz, 0.15, 0.7, 0.45, 0.62, 0.68, 1.0, 0);
        } else if (e.w === 'magnet' || e.w === 'disc') {   // v1.0 PLATZHALTER v1.0: Magnet-/Diskus-Strahl (Laser-Optik)
          laserShot(src, tx, ty, tz);
        } else if (e.w === 'flak') {              // v0.8: Flak – Mündungsfeuer, Leuchtspur in die Flughöhe (Sprengwolke beim Treffer)
          sparkle(tmpV.x, tmpV.y, tmpV.z, 0.75);
          tracer(tmpV.x, tmpV.y, tmpV.z, tmpV.x + (tx - tmpV.x) * 0.55, tmpV.y + (ty - tmpV.y) * 0.55, tmpV.z + (tz - tmpV.z) * 0.55, 0.1, 0);
          puff(tmpV.x, tmpV.y, tmpV.z, (rnd() - 0.5) * 0.4, 0.3, (rnd() - 0.5) * 0.4, 0.7, 0.08, 0.3, 0.45, 0.35, 0);
        } else if (e.w === 'sniper') {            // v0.7: dünne, sehr schnelle helle Linie + kleiner Mündungsblitz + Staubpuff am Ziel
          sniperShot(tx, ty, tz, e);
        } else if (e.w === 'flame') {      // v0.7: Flammenstrahl (kurzer Kegel aus Feuerteilchen) + Brandfleck
          flameShot(tx, ty, tz);
        } else if (e.missile) {            // v0.9 Schlachtschiff: Startflamme + Rauchsäule am Werfer
          missileLaunch(src, e, tx, tz);
        } else if (e.w === 'rocket' && e.salvo != null) {   // v0.7 MLRS-Salve: Rohrfeuer, Rückstoß-Rauch, Startrauch
          salvoLaunch(src, e, tx, tz);
        } else if (e.w === 'bullet') {   // Bewegung: Fahrzeug-MG (dicke Leuchtspur, größerer Blitz, Hülsen) ≠ Gewehr (dünn, kurz)
          var vmg = src && src.kind === 'unit' && !M3.INF[src.type];
          sparkle(tmpV.x, tmpV.y, tmpV.z, vmg ? 0.95 : 0.6);
          tracer(tmpV.x, tmpV.y, tmpV.z, tx, ty, tz, vmg ? 0.13 : 0.1, vmg ? 1 : 0);
          if (spTier && inViewT(tmpV.x, tmpV.z)) {
            mzJet(tmpV.x, tmpV.y, tmpV.z, sdx, sdz, vmg ? 0.8 : 0.5, 1);
            if (spTier === 2 && rnd() < (vmg ? 0.9 : 0.5)) casing(tmpV.x, tmpV.y, tmpV.z, sdx, sdz);
          }
        } else if (e.w === 'cannon') {
          var bigGun = src && (src.type === 'howitzer' || src.type === 'colossus');
          if (spTier && inViewT(tmpV.x, tmpV.z)) {   // Bewegung: Feuerstrahl aus dem Rohr, Lichtfleck + aufgewirbelter Staub am Boden unter der Mündung
            var mgk = bigGun ? 1.7 : 1.15, mgy = groundAt(tmpV.x, tmpV.z), mtk = terrK(tmpV.x, tmpV.z);
            mzJet(tmpV.x, tmpV.y, tmpV.z, sdx, sdz, mgk, spTier === 2 ? 3 : 2);
            wave(1, tmpV.x + sdx * 0.2, tmpV.z + sdz * 0.2, 0.35 * mgk, 1.25 * mgk, 0.18, 0.85, 0.5, 0.2);
            if (mtk !== 3) for (var mq = 0; mq < (spTier === 2 ? 4 : 2); mq++) { var msd = (mq & 1 ? 1 : -1) * (0.5 + rnd() * 0.7); dstC(tmpV.x + sdx * 0.15, mgy + 0.05, tmpV.z + sdz * 0.15, sdx * 0.7 - sdz * msd, 0.15 + rnd() * 0.2, sdz * 0.7 + sdx * msd, 0.6 + rnd() * 0.4, 0.2 * mgk, 0.6 * mgk, 0.3, mtk); }
          }
          sparkle(tmpV.x, tmpV.y, tmpV.z, bigGun ? 2.2 : (src && src.type === 'hunter' ? 1.7 : 1.5));
          if (bigGun) { for (var bq = 0; bq < 6; bq++) puff(tmpV.x, tmpV.y, tmpV.z, (rnd() - 0.5) * 1.2, 0.2 + rnd() * 0.5, (rnd() - 0.5) * 1.2, 1.2 + rnd() * 0.8, 0.25, 0.9, 0.5, 0.5, 0); if (src.type === 'howitzer') dust(src.x / TILE, 0, src.y / TILE, 0.8); }
          for (var q = 0; q < 4; q++) puff(tmpV.x, tmpV.y, tmpV.z, (rnd() - 0.5) * 0.8, 0.2 + rnd() * 0.3, (rnd() - 0.5) * 0.8, 0.8 + rnd() * 0.4, 0.15, 0.45, 0.42, 0.4, 0);
        } else if (e.w === 'laser') {
          laserShot(src, tx, ty, tz);
        } else if (e.w === 'lightning') {
          lightningShot(e, src, tx, ty, tz);
        } else {
          sparkle(tmpV.x, tmpV.y, tmpV.z, 1.1);
          for (var q2 = 0; q2 < 5; q2++) puff(tmpV.x, tmpV.y, tmpV.z, (rnd() - 0.5) * 0.6, 0.1 + rnd() * 0.3, (rnd() - 0.5) * 0.6, 0.9 + rnd() * 0.5, 0.12, 0.4, 0.55, 0.4, 0);
          if (e.w === 'rocket' && spTier && inViewT(tmpV.x, tmpV.z)) {   // Bewegung: Rückstrahl des Raketenwerfers nach hinten
            mzJet(tmpV.x - sdx * 0.3, tmpV.y, tmpV.z - sdz * 0.3, -sdx, -sdz, 0.9, 2);
            for (var rb = 0; rb < 3; rb++) puff(tmpV.x - sdx * (0.35 + rb * 0.12), tmpV.y, tmpV.z - sdz * (0.35 + rb * 0.12), -sdx * (1.4 + rnd()) + (rnd() - 0.5) * 0.4, 0.2 + rnd() * 0.3, -sdz * (1.4 + rnd()) + (rnd() - 0.5) * 0.4, 0.7 + rnd() * 0.5, 0.14, 0.55, 0.6, 0.4, 0.2);
          }
        }
      } else if (e.t === 'hit') {
        if (!visibleAt(e.x, e.y)) continue;
        var gy = groundAt(x, z);
        if (e.w === 'bomb') { bombHit(x, z); continue; }   // v0.8: Bombenteppich
        if (e.w === 'missile') { missileHit(x, z, (e.splash || 1.3 * TILE) / TILE); continue; }   // v0.9: Schlachtschiff-Rakete
        if (e.w === 'flak' || e.w === 'rocket' || e.w === 'bullet' || e.w === 'cannon') {   // v0.8: Treffer in der Luft → Sprengwolke in Flughöhe
          var ae = airAt(e.x, e.y, e.w === 'flak' ? 40 : 22);
          if (ae || e.w === 'flak') { var ah = gy + (ae ? airAlt(ae) : 1) * D.AIR_H + 0.15; flakBurst(x + (rnd() - 0.5) * 0.3, ah + (rnd() - 0.4) * 0.3, z + (rnd() - 0.5) * 0.3, e.w === 'flak' ? 1 : (e.w === 'rocket' ? 1.15 : 0.5)); continue; }
        }
        // Bewegung: getroffene Einheiten blitzen kurz auf und rucken; Einschläge ins Wasser → Fontäne, in den Boden → Erd-/Sandfontäne
        var hitU = (e.w === 'cannon' || e.w === 'rocket') ? hitNear(e.x, e.y, e.splash ? Math.min(e.splash, 40) : 20) : false;
        if ((e.w === 'cannon' || e.w === 'rocket') && !hitU && terrK(x, z) === 3 && T3.heightAt(x, z) < -0.09) { splash(x, z, e.w === 'cannon' ? 0.9 : 0.75); continue; }
        if (e.w === 'laser' || e.w === 'lightning') { beamImpact(x, gy + 0.25, z, e.w === 'laser' ? 0 : 1, 0.8); decal(x, z, 0.4, 10); }
        else if (e.w === 'cannon') { explosion(x, gy + 0.1, z, 0.65, true); decal(x, z, 0.7, 14); if (!hitU || e.splash) fountain(x, gy, z, e.splash ? 1 : 0.7); }
        else if (e.w === 'bullet') { var hte = e.tid ? G.Sim.get(e.tid) : null; impact(x, gy + 0.2, z, hte ? (hte.kind === 'building' ? 'building' : (D.UNITS[hte.type] ? D.UNITS[hte.type].armor : 'light')) : 'light'); }
        else { explosion(x, gy + 0.15, z, 0.55, false); decal(x, z, 0.55, 12); }
      } else if (e.t === 'die') {
        if (e.inside) { rs.delete(e.id); continue; }   // v0.8: Insasse eines Transporters – kein eigener Effekt
        if (!visibleAt(e.x, e.y)) continue;
        var g2 = groundAt(x, z), Pd = S.players[e.owner];
        if (Pd && e.kind === 'unit' && v8Die(e, x, z, g2, Pd)) { rs.delete(e.id); continue; }   // v0.8: Absturz / Untergang
        if (!Pd) { explosion(x, g2 + 0.2, z, 0.8, true); decal(x, z, 1.0, 30); rs.delete(e.id); continue; }
        if (e.kind === 'building' && e.type === 'wall') {   // Mauerstück: Betonbrocken + Staub, kein Wrack
          if (spTier) for (var wq0 = 0; wq0 < 5; wq0++) { var wa0 = rnd() * 6.283, wsp0 = 0.6 + rnd() * 1.2, wc0 = 0.4 + rnd() * 0.2; chunk(x + (rnd() - 0.5) * 0.5, 0.3 + rnd() * 0.3, z + (rnd() - 0.5) * 0.5, Math.cos(wa0) * wsp0, 2.5 + rnd() * 2.5, Math.sin(wa0) * wsp0, 0.09 + rnd() * 0.06, wc0, wc0, wc0 * 0.95, 1.6 + rnd()); }
          else for (var wq = 0; wq < 7; wq++) {
            var wa2 = rnd() * 6.283, wsp = 0.5 + rnd() * 1.2, wc = 0.42 + rnd() * 0.16;
            emit(1, x + (rnd() - 0.5) * 0.5, 0.3 + rnd() * 0.3, z + (rnd() - 0.5) * 0.5, Math.cos(wa2) * wsp, 1.3 + rnd() * 2, Math.sin(wa2) * wsp, 0.5 + rnd() * 0.5, 0.09, 0.07, wc, wc, wc * 0.95, 1, wc, wc, wc * 0.95, 0.8, -9, 0);
          }
          if (spTier) glw(x, 0.3, z, 0.8, 1.4, 1, 0.8, 0.45, 0.12, 0.8); else emit(0, x, 0.3, z, 0, 0.1, 0, 0.12, 0.7, 0.3, 1, 0.85, 0.5, 0.9, 1, 0.5, 0.1, 0);
          dust(x, 0, z, 1.0); decal(x, z, 0.8, 24);
          continue;
        }
        if (e.kind === 'building') {
          var k = Math.max(e.w || 1, e.h || 1);
          for (var b = 0; b < 3; b++) explosion(x + (rnd() - 0.5) * e.w * 0.6, 0.3 + rnd() * 0.4, z + (rnd() - 0.5) * e.h * 0.6, 0.6 + 0.4 * k, true, BLD_DEB);
          if (spTier) { dust(x, 0, z, 1.2 + 0.5 * k); burn(x, z, 10 + 2 * k, 0.8 + 0.3 * k, 1); }
          decal(x, z, k * 1.5, 40);
          if (inViewT(x, z)) addShake(0.035 + 0.012 * k, 0.32);   // Bewegung: leichtes Kamerawackeln bei Gebäude-Explosionen im Bild
          M3.addWreck({ kind: 'building', type: e.type, owner: e.owner, fac: Pd.faction, color: Pd.color, x: x, z: z, dir: 0, tdir: 0, t0: fx.time, life: 4 });
        } else if (M3.INF[e.type]) {   // Bewegung: alle Infanteristen fallen um (Wrack-Art 'fall') statt nur zu verpuffen
          var rfi = rs.get(e.id);
          M3.addWreck({ kind: 'fall', type: e.type, owner: e.owner, fac: Pd.faction, color: Pd.color, x: x, z: z, dir: rfi ? rfi.fc : 0, t0: fx.time, life: 4.2, side: rnd() < 0.7 ? 1 : -1 });
          if (spTier) { glw(x, g2 + 0.2, z, 0.4, 0.9, 1, 0.6, 0.3, 0.14, 0.8); for (var q4 = 0; q4 < 3; q4++) dstS(x + (rnd() - 0.5) * 0.2, g2 + 0.1, z + (rnd() - 0.5) * 0.2, (rnd() - 0.5) * 0.6, 0.3 + rnd() * 0.4, (rnd() - 0.5) * 0.6, 0.7, 0.15, 0.5, 0.5, 0.9); }
          else { for (var q3 = 0; q3 < 5; q3++) emit(1, x, g2 + 0.1, z, (rnd() - 0.5) * 0.6, 0.3 + rnd() * 0.4, (rnd() - 0.5) * 0.6, 0.8, 0.12, 0.3, 0.55, 0.5, 0.42, 0.6, 0.55, 0.5, 0.42, 0, 0, 2);
          emit(0, x, g2 + 0.15, z, 0, 0.3, 0, 0.15, 0.3, 0.1, 1, 0.6, 0.3, 0.8, 1, 0.3, 0.1, 0); }
        } else {
          var tcd = teamRGB(Pd.color); UNIT_DEB[0] = 0.08 + tcd[0] * 0.35; UNIT_DEB[1] = 0.08 + tcd[1] * 0.35; UNIT_DEB[2] = 0.08 + tcd[2] * 0.35;
          explosion(x, g2 + 0.2, z, 1.05, true, UNIT_DEB);
          if (spTier) burn(x, z, 6, 0.65, 1);
          decal(x, z, 1.1, 30);
          var r = rs.get(e.id);
          // Bewegung: Turm wird (meist) abgesprengt und landet versetzt; gelegentlich späte Nachexplosion (Munition); leichtes Wackeln im Bild
          var wpa = rnd() * 6.283, wpd = 0.12 + rnd() * 0.2;
          M3.addWreck({ kind: 'unit', type: e.type, owner: e.owner, fac: Pd.faction, color: Pd.color, x: x, z: z, dir: r ? r.dir : 0, tdir: r ? r.tdir : 0, t0: fx.time, life: 9,
            pop: rnd() < 0.7 ? 0.3 + rnd() * 0.4 : 0, ox: Math.cos(wpa) * wpd, oz: Math.sin(wpa) * wpd, spin: (rnd() - 0.5) * 5, ckT: rnd() < 0.5 ? 0.6 + rnd() * 1.4 : 0, landed: false });
          if (inViewT(x, z)) addShake(0.03, 0.22);
        }
        rs.delete(e.id);
      } else if (e.t === 'enter' || e.t === 'exit') {
        var gb = G.Sim.get(e.id);
        if (gb && !gb.dead && (S.settings.fogOff || G.Sim.isVisible(V.pid, gb))) dust(gb.x / TILE, 0, gb.y / TILE + gb.h * 0.42, 0.3);
      } else if (e.t === 'capture') {
        var cb = G.Sim.get(e.id), cp = S.players[e.owner];
        if (cb && !cb.dead && cp) {
          nst(cb.id).flagT0 = fx.time;
          if (S.settings.fogOff || G.Sim.isVisible(V.pid, cb)) {
            var cc = teamRGB(cp.color), ccx = cb.x / TILE, ccz = cb.y / TILE;
            addPulse(ccx, ccz, cp.color, Math.max(cb.w, cb.h) * 0.8 + 0.7, 1.0);
            for (var cq = 0; cq < 14; cq++) emit(0, ccx + (rnd() - 0.5) * cb.w, 0.3 + rnd() * 0.6, ccz + (rnd() - 0.5) * cb.h, 0, 0.9 + rnd() * 0.8, 0, 0.9, 0.14, 0.03, cc[0] * 1.5 + 0.2, cc[1] * 1.5 + 0.2, cc[2] * 1.5 + 0.2, 1, cc[0], cc[1], cc[2], 0, 0, 0.5);
          }
        }
      } else if (e.t === 'ruin') {
        var rb = G.Sim.get(e.id);
        if (rb) {
          nst(rb.id).ruinT = fx.time;
          if (S.settings.fogOff || G.Sim.isVisible(V.pid, rb)) {
            var rx = rb.x / TILE, rz2 = rb.y / TILE, rk = Math.max(rb.w, rb.h);
            for (var rq = 0; rq < 4; rq++) explosion(rx + (rnd() - 0.5) * rb.w * 0.7, 0.3 + rnd() * 0.5, rz2 + (rnd() - 0.5) * rb.h * 0.7, 0.7 + 0.3 * rk, true, BLD_DEB);
            decal(rx, rz2, rk * 1.5, 60); dust(rx, 0, rz2, 1.8); if (spTier) burn(rx, rz2, 14, 1 + 0.4 * rk, 1);
          }
        }
      } else if (e.t === 'arty') {
        var ab = G.Sim.get(e.id);
        if (ab) artyLaunch(ab, e);
      } else if (e.t === 'artyHit') {
        if (visibleAt(e.x, e.y)) { var ahy = groundAt(x, z); explosion(x, ahy + 0.1, z, 1.2, true); dust(x, 0, z, 1.2); decal(x, z, 1.2, 50); fountain(x, ahy, z, 1.3); hitNear(e.x, e.y, 40); if (inViewT(x, z)) addShake(0.06, 0.3); }
      } else if (e.t === 'swLaunch') {
        swLaunchEvt(e);
      } else if (e.t === 'swHit') {
        swHitEvt(e);
      } else if (e.t === 'swBuilt' || e.t === 'swReady') {
        var sb = G.Sim.get(e.id), sP = S.players[e.owner];
        if (sb && !sb.dead && sP) {
          nst(sb.id).swT = e.t === 'swReady' ? fx.time - 3.4 : -1e9;
          if (S.settings.fogOff || G.Sim.isVisible(V.pid, sb)) {
            addPulse(sb.x / TILE, sb.y / TILE, e.t === 'swReady' ? '#ffffff' : sP.color, Math.max(sb.w, sb.h) * 1.1 + 0.8, 1.2);
            if (e.t === 'swReady') for (var rq2 = 0; rq2 < 16; rq2++) emit(0, sb.x / TILE + (rnd() - 0.5) * sb.w, 0.4 + rnd() * 0.8, sb.y / TILE + (rnd() - 0.5) * sb.h, 0, 1 + rnd(), 0, 1, 0.14, 0.03, 0.7, 1, 0.8, 1, 0.3, 0.9, 0.5, 0);
          }
        }
      } else if (e.t === 'repairFull') {
        var rfb = G.Sim.get(e.id);
        if (rfb && !rfb.dead && (S.settings.fogOff || G.Sim.isVisible(V.pid, rfb))) {
          addPulse(rfb.x / TILE, rfb.y / TILE, '#4ade80', Math.max(rfb.w, rfb.h) * 0.8 + 0.7, 1.0);
          for (var rfq = 0; rfq < 18; rfq++) emit(0, rfb.x / TILE + (rnd() - 0.5) * rfb.w, 0.2 + rnd() * 0.8, rfb.y / TILE + (rnd() - 0.5) * rfb.h, 0, 0.9 + rnd(), 0, 0.9, 0.14, 0.03, 0.4, 1, 0.5, 1, 0.1, 0.6, 0.2, 0);
        }
      } else if (e.t === 'wall') {
        var wids = e.ids || [];
        for (var wi = 0; wi < wids.length && wi < 40; wi++) {
          var wb = G.Sim.get(wids[wi]);
          if (wb && !wb.dead && (S.settings.fogOff || wb.owner === V.pid || G.Sim.isVisible(V.pid, wb))) dust(wb.x / TILE, 0, wb.y / TILE, 0.32);
        }
      } else if (e.t === 'deploy') {
        M3.deployEvt(e);
      } else if (e.t === 'heal') {
        healEvt(e, S);
      } else if (e.t === 'takeoff' || e.t === 'land' || e.t === 'beach' || e.t === 'rearm') {   // v0.8
        v8Evt(e, S, x, z);
      } else if (e.t === 'load' || e.t === 'unload') {   // v0.7 Schützenpanzer: kleine Staubwolke an Luke/Heck
        var apc = G.Sim.get(e.id);
        if (apc && apc.mc >= 2) { v8Evt(e, S, apc.x / TILE, apc.y / TILE); continue; }   // v0.8: Hubschrauber / Landungsboot
        if (apc && (S.settings.fogOff || apc.owner === V.pid || G.Sim.isVisible(V.pid, apc))) {
          var ax = apc.x / TILE, az = apc.y / TILE, bk = (apc.dir || 0) + Math.PI;
          dust(ax + Math.cos(bk) * 0.3, 0, az + Math.sin(bk) * 0.3, e.t === 'load' ? 0.3 : 0.45);
          if (e.t === 'unload') { dust(ax - Math.sin(bk) * 0.3, 0, az + Math.cos(bk) * 0.3, 0.3); addPulse(ax, az, '#e3d9bd', 0.7, 0.5); }
        }
      } else if (e.t === 'place' || e.t === 'sell') {
        var bd = D.BUILDINGS[e.type];
        dust(x, 0, z, bd ? Math.max(bd.w, bd.h) * 0.7 : 1);
      }
    }
    if (ev.length) lastSeq = Math.max(lastSeq, ev[ev.length - 1].seq);
  }

  /** Artillerie-Abschuss: Mündungsfeuer, Rauch, Staubring; merkt Flug + Zielmarker. */
  function artyLaunch(ab, e) {
    var S = G.Sim.S, st = nst(ab.id), ax = ab.x / TILE, az = ab.y / TILE, tx = e.x / TILE, tz = e.y / TILE, M = model('artillery');
    var vis = S.settings.fogOff || G.Sim.isVisible(V.pid, ab);
    st.yaw = Math.atan2(tz - az, tx - ax); st.artyT = fx.time;
    var L = 1.45, cp = Math.cos(0.95), mx = ax + Math.cos(st.yaw) * L * cp, my = M.at.barrel[1] + L * Math.sin(0.95), mz = az + Math.sin(st.yaw) * L * cp;
    var shown = vis || visibleAt(e.x, e.y);
    if (vis) {
      if (spTier) { star(mx, my, mz, 1.3, 2.4, 1, 0.9, 0.6, 0.1); glw(mx, my, mz, 1.5, 2.6, 1, 0.65, 0.25, 0.16, 0.9); wave(0, ax, az, 0.2, 2.0, 0.5, 0.9, 0.8, 0.6); }
      else { emit(0, mx, my, mz, 0, 0.2, 0, 0.17, 1.3, 0.4, 1, 0.95, 0.7, 1, 1, 0.6, 0.2, 0);
      emit(0, mx, my, mz, 0, 0.1, 0, 0.1, 0.7, 0.2, 1, 1, 1, 1, 1, 0.8, 0.5, 0); }
      for (var q = 0; q < 12; q++) puff(mx + (rnd() - 0.5) * 0.2, my, mz + (rnd() - 0.5) * 0.2, (rnd() - 0.5) * 1.3, 0.3 + rnd() * 0.7, (rnd() - 0.5) * 1.3, 1.8 + rnd() * 1.4, 0.4, 1.7, 0.5, 0.55, 0);
      dust(ax, 0, az, 1.5); dust(ax + Math.cos(st.yaw) * 0.5, 0, az + Math.sin(st.yaw) * 0.5, 1.0);
      flash.position.set(mx, my, mz); fx.flashT = Math.max(fx.flashT, 0.22); fx.flashK = 2.2;
    }
    var P = S.players[ab.owner], f = null, k;
    if (artyFx.length >= 8) artyFx.shift();
    f = { tx: tx, tz: tz, sx: mx, sy: my, sz: mz, t0: fx.time, dur: 2, color: P ? P.color : '#ffffff', show: shown, own: ab.owner === V.pid, ox: [0, 0, 0], oz: [0, 0, 0] };
    for (k = 0; k < 3; k++) { var a = rnd() * 6.28, r = 0.4 + rnd() * 1.4; f.ox[k] = Math.cos(a) * r; f.oz[k] = Math.sin(a) * r; }
    artyFx.push(f);
  }

  // ------------------------------------------------------------------ v0.4: Superwaffen (Ziel-Warnmarker, Orbitalstrahl, Rakete, Druckwelle), Kamerawackeln
  // Ablauf (Zeit in Sim-Ticks, damit Spielgeschwindigkeit/Pause stimmen): swLaunch {id, owner, kind, x, y, t2, sx, sy} startet den Marker (für BEIDE Seiten,
  // auch im Nebel) – orbital: Vorwarnung, dünner Zielstrahl; missile: Rakete steigt vom Silo im Bogen auf. swHit {kind, x, y, r} löst Strahl/Explosion aus.
  var SW_N = 6;
  var sws = [];            // Pool laufender Schläge (wiederverwendet, keine Allokation je Frame)
  var swRing, swRingN, swDash, swCross, swDisc, swGlow, swBeam, swDome;
  var shk = { a0: 0, t0: -1e9, dur: 1, ox: 0, oz: 0, off: { x: 0, z: 0 } };
  var shakeOn = true;
  try { var sk0 = localStorage.getItem('frontlinie.shake'); if (sk0 === '0') shakeOn = false; else if (sk0 == null && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) shakeOn = false; } catch (e) { /* egal */ }
  function setShake(on) { shakeOn = !!on; try { localStorage.setItem('frontlinie.shake', shakeOn ? '1' : '0'); } catch (e) { /* egal */ } }
  function addShake(a, dur) { if (!shakeOn || safeGPU) return; if (a * a > shk.a0 * shk.a0 * Math.max(0, 1 - (fx.time - shk.t0) / shk.dur)) { shk.a0 = a; shk.t0 = fx.time; shk.dur = dur; } }
  function shakeUpdate() {
    var age = fx.time - shk.t0, a = age < shk.dur && shakeOn && !safeGPU ? shk.a0 * Math.pow(1 - age / shk.dur, 2) : 0, t = fx.time;
    shk.ox = a * (Math.sin(t * 61) + 0.6 * Math.sin(t * 37 + 2)); shk.oz = a * (Math.sin(t * 53 + 1) + 0.6 * Math.sin(t * 29));
    shk.off.x = shk.ox; shk.off.z = shk.oz;
  }
  function blobTex(stops) {
    var c = document.createElement('canvas'); c.width = c.height = 128;
    var g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 63);
    for (var i = 0; i < stops.length; i++) gr.addColorStop(stops[i][0], 'rgba(255,255,255,' + stops[i][1] + ')');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    var tx = new THREE.CanvasTexture(c); tx.colorSpace = THREE.SRGBColorSpace; return tx;
  }
  function flatGeo(pos) { var g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(null); g.computeVertexNormals(); return g; }
  /** Gestrichelter Ring: n Bögen, Anteil fill des Teilungswinkels, Radien r0..r1 (flach, Normale nach oben). */
  function dashRingGeo(n, fill, r0, r1) {
    var pos = [], seg = 3, i, s;
    for (i = 0; i < n; i++) for (s = 0; s < seg; s++) {
      var a0 = (i + (s / seg) * fill) / n * 6.2832, a1 = (i + ((s + 1) / seg) * fill) / n * 6.2832;
      var c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      pos.push(c0 * r0, 0, s0 * r0, c0 * r1, 0, s0 * r1, c1 * r1, 0, s1 * r1, c0 * r0, 0, s0 * r0, c1 * r1, 0, s1 * r1, c1 * r0, 0, s1 * r0);
    }
    return flatGeo(pos);
  }
  function crossGeo(r0, r1, th) {
    var pos = [], a, c, s;
    for (a = 0; a < 4; a++) {
      c = Math.cos(a * 1.5708); s = Math.sin(a * 1.5708);
      // Balken von r0 bis r1 entlang (c,s), Breite th
      var px = -s * th, pz = c * th;
      pos.push(c * r0 - px, 0, s * r0 - pz, c * r1 - px, 0, s * r1 - pz, c * r1 + px, 0, s * r1 + pz, c * r0 - px, 0, s * r0 - pz, c * r1 + px, 0, s * r1 + pz, c * r0 + px, 0, s * r0 + pz);
    }
    return flatGeo(pos);
  }
  function initSwFx() {
    var mk = function (map, side) { return new THREE.MeshBasicMaterial({ map: map || null, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, side: side || THREE.FrontSide }); };
    var mkN = function (map, side) { return new THREE.MeshBasicMaterial({ map: map || null, transparent: true, depthWrite: false, toneMapped: false, side: side || THREE.FrontSide }); };
    var rg = new THREE.RingGeometry(0.88, 1, 64); rg.rotateX(-Math.PI / 2);
    swRing = new Batch(rg, mk(), 24, false); swRing.mesh.renderOrder = 4; dynRoot.add(swRing.mesh);
    swRingN = new Batch(rg, mkN(), 8, false); swRingN.mesh.renderOrder = 3; dynRoot.add(swRingN.mesh);
    swDash = new Batch(dashRingGeo(18, 0.55, 0.9, 1), mkN(null, THREE.DoubleSide), 8, false); swDash.mesh.renderOrder = 3; dynRoot.add(swDash.mesh);
    swCross = new Batch(crossGeo(0.25, 1, 0.03), mkN(null, THREE.DoubleSide), 8, false); swCross.mesh.renderOrder = 3; dynRoot.add(swCross.mesh);
    var pg = new THREE.PlaneGeometry(2, 2); pg.rotateX(-Math.PI / 2);
    swDisc = new Batch(pg, mkN(blobTex([[0, 0.12], [0.55, 0.22], [0.86, 0.5], [0.97, 0.7], [1, 0]])), 8, false); swDisc.mesh.renderOrder = 2; dynRoot.add(swDisc.mesh);
    swGlow = new Batch(pg, mk(blobTex([[0, 1], [0.35, 0.65], [0.7, 0.22], [1, 0]])), 12, false); swGlow.mesh.renderOrder = 4; dynRoot.add(swGlow.mesh);
    var bg = new THREE.CylinderGeometry(1, 1, 1, 14, 6, true); bg.translate(0, 0.5, 0);
    var bp = bg.attributes.position, bc = new Float32Array(bp.count * 3);
    for (var i = 0; i < bp.count; i++) { var v = Math.max(0, 1 - Math.pow(bp.getY(i), 1.4)); bc[i * 3] = bc[i * 3 + 1] = bc[i * 3 + 2] = v; }
    bg.setAttribute('color', new THREE.BufferAttribute(bc, 3));
    var bm = mk(null, THREE.DoubleSide); bm.vertexColors = true;
    swBeam = new Batch(bg, bm, 6, false); swBeam.mesh.renderOrder = 5; dynRoot.add(swBeam.mesh);
    var dg = new THREE.SphereGeometry(1, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2);
    swDome = new Batch(dg, mk(null, THREE.DoubleSide), 4, false); swDome.mesh.renderOrder = 5; dynRoot.add(swDome.mesh);
    for (i = 0; i < SW_N; i++) sws.push({ on: false, hit: false, kind: '', owner: 0, x: 0, z: 0, r: 3, sx: 0, sz: 0, t0: 0, t2: 1, ht: 0, dist: 0, H: 6, yaw: 0, acc: 0, tcol: [1, 1, 1], launchT: 0, born: 0 });
    swFlush.push(swRing, swRingN, swDash, swCross, swDisc, swGlow, swBeam, swDome);
  }
  var swFlush = [];

  function bigScale() { return clamp(fx.max / 1400, 0.35, 1) * (safeGPU ? 0.75 : 1); }
  /** Große neutrale Druckwelle: Feuerball, Staubring, Rauchsäule, Trümmer, Funken, Brandfleck. */
  function swBlast(s) {
    var x = s.x, z = s.z, r = s.r, gy = groundAt(x, z), k = bigScale(), n, i, a, sp, orb = s.kind === 'orbital';
    var gr = orb ? [0.5, 0.85, 1.0] : [1.0, 0.62, 0.22];     // Glutfarbe: Orbital bläulich-weiß, Rakete orange
    if (spTier) swBlastS(x, gy, z, r, orb); else {
    for (i = 0; i < 4; i++) emit(0, x + (rnd() - 0.5) * 0.4, gy + 0.5, z + (rnd() - 0.5) * 0.4, 0, 0.2, 0, 0.22 + rnd() * 0.12, 3.2, 1.6, 1, 0.97, 0.88, 1, gr[0], gr[1], gr[2], 0);
    n = Math.round(46 * k);
    for (i = 0; i < n; i++) {        // Feuerball
      a = rnd() * 6.283; sp = Math.sqrt(rnd()) * r * 0.9;
      var dl = 0.35 + rnd() * 0.5;
      emit(0, x + Math.cos(a) * sp * 0.35, gy + 0.2, z + Math.sin(a) * sp * 0.35, Math.cos(a) * sp * 1.1, 0.9 + rnd() * 2.6, Math.sin(a) * sp * 1.1, dl + 0.35, 1.0 + rnd() * 0.6, 0.5, 1, 0.78, 0.35, 1, 0.8, 0.22, 0.06, 0, 0.6, 2.4);
    }
    n = Math.round(44 * k);
    for (i = 0; i < n; i++) {        // Staub-/Druckring
      a = i / n * 6.283 + rnd() * 0.1; sp = r / 0.75 * (0.7 + rnd() * 0.5);
      emit(1, x + Math.cos(a) * 0.4, gy + 0.1, z + Math.sin(a) * 0.4, Math.cos(a) * sp, 0.25 + rnd() * 0.5, Math.sin(a) * sp, 1.0 + rnd() * 0.7, 0.7, 1.7, 0.66, 0.6, 0.5, 0.65, 0.6, 0.55, 0.47, 0, 0, 2.3);
    }
    n = Math.round(34 * k);
    for (i = 0; i < n; i++) {        // dunkle Rauchsäule (niedrig, kein Pilz)
      a = rnd() * 6.283; sp = rnd() * r * 0.35;
      emit(1, x + Math.cos(a) * sp, gy + 0.2, z + Math.sin(a) * sp, Math.cos(a) * 0.25, 1.2 + rnd() * 2.2, Math.sin(a) * 0.25, 2.4 + rnd() * 2.2, 0.9, 2.6, 0.2, 0.18, 0.17, 0.75, 0.38, 0.37, 0.36, 0, -0.1, 0.9);
    }
    n = Math.round(30 * k);
    for (i = 0; i < n; i++) {        // Trümmer + Funken
      a = rnd() * 6.283; sp = 2 + rnd() * r * 1.7;
      emit(1, x, gy + 0.2, z, Math.cos(a) * sp, 4 + rnd() * 6, Math.sin(a) * sp, 0.9 + rnd() * 0.8, 0.1, 0.08, 0.1, 0.09, 0.08, 1, 0.1, 0.09, 0.08, 0.9, -11, 0);
      if (i % 2) emit(0, x, gy + 0.2, z, Math.cos(a) * sp * 1.3, 3 + rnd() * 6, Math.sin(a) * sp * 1.3, 0.5 + rnd() * 0.5, 0.09, 0.03, 1, 0.9, 0.5, 1, 1, 0.45, 0.1, 0, -8, 0);
    }
    }
    decal(x, z, r * 1.9, 160); decal(x + (rnd() - 0.5) * 0.6, z + (rnd() - 0.5) * 0.6, r * 1.1, 170);
    for (i = 0; i < 5; i++) { a = rnd() * 6.283; sp = r * (0.4 + rnd() * 0.5); decal(x + Math.cos(a) * sp, z + Math.sin(a) * sp, 0.9 + rnd() * 1.2, 150); }
    flash.position.set(x, gy + 1.2, z); fx.flashT = Math.max(fx.flashT, 0.6); fx.flashK = 3;
    // Kamerawackeln: nur wenn der Einschlag im Bild liegt, stärker nahe der Bildmitte
    if (R.VDIR && R.inView) { if (R.inView(x, z)) addShake(0.16, 0.75); return; }
    var c0 = V.toWorld(0, 0), c1 = V.toWorld(V.vw, V.vh);
    var wx = x * TILE, wz = z * TILE;
    if (wx > c0.x - r * TILE && wx < c1.x + r * TILE && wz > c0.y - r * TILE && wz < c1.y + r * TILE) {
      var dxn = (wx - (c0.x + c1.x) / 2) / Math.max(1, (c1.x - c0.x) / 2), dzn = (wz - (c0.y + c1.y) / 2) / Math.max(1, (c1.y - c0.y) / 2);
      addShake(0.2 * (1 - 0.45 * Math.min(1, Math.sqrt(dxn * dxn + dzn * dzn))), 0.75);
    }
  }
  function swSlot() {
    var i, best = 0, old = 1e9;
    for (i = 0; i < sws.length; i++) { if (!sws[i].on) return sws[i]; if (sws[i].born < old) { old = sws[i].born; best = i; } }
    return sws[best];
  }
  function swLaunchEvt(e) {
    if (e.kind === 'psi') { var px0 = e.x / TILE, pz0 = e.y / TILE; for (var pw = 0; pw < 3; pw++) wave(0, px0, pz0, 3.5, 0.3, 0.7, 0.55, 0.6, 1.0, pw * 0.6); return; }   // v1.0 PLATZHALTER v1.0: Psi-Welle zieht sich zusammen
    var S = G.Sim.S, s = swSlot(), P = S.players[e.owner];
    s.on = true; s.hit = false; s.kind = e.kind; s.owner = e.owner; s.born = fx.time;
    s.x = e.x / TILE; s.z = e.y / TILE; s.r = e.kind === 'orbital' ? 3 : 4;
    s.t0 = e.tick != null ? e.tick : S.tick; s.t2 = Math.max(s.t0 + 1, e.t2 != null ? e.t2 : s.t0 + 60);
    s.sx = (e.sx != null ? e.sx : e.x) / TILE; s.sz = (e.sy != null ? e.sy : e.y) / TILE;
    s.dist = Math.hypot(s.x - s.sx, s.z - s.sz); s.H = 6 + 0.14 * s.dist; s.yaw = Math.atan2(s.z - s.sz, s.x - s.sx); s.acc = 0; s.px = NaN; s.launchT = fx.time;
    var c = P ? teamRGB(P.color) : [1, 1, 1]; s.tcol[0] = c[0]; s.tcol[1] = c[1]; s.tcol[2] = c[2];
    var b = G.Sim.get(e.id);
    if (b) { var st = nst(b.id); st.swT = fx.time; }
    if (e.kind === 'missile' && b && !b.dead && (S.settings.fogOff || G.Sim.isVisible(V.pid, b))) {   // Startwolke am Silo
      var bx = b.x / TILE, bz = b.y / TILE, k = bigScale(), i;
      for (i = 0; i < Math.round(16 * k); i++) { var a = rnd() * 6.283; emit(1, bx + Math.cos(a) * 0.3, 0.8, bz + Math.sin(a) * 0.3, Math.cos(a) * 1.4, 0.3 + rnd() * 0.8, Math.sin(a) * 1.4, 1.6 + rnd() * 1.4, 0.5, 2.0, 0.85, 0.83, 0.78, 0.75, 0.6, 0.6, 0.6, 0, 0, 1.4); }
      emit(0, bx, 0.9, bz - 0.1, 0, 1.2, 0, 0.5, 2.0, 0.6, 1, 0.85, 0.5, 1, 1, 0.4, 0.1, 0);
      flash.position.set(bx, 1.2, bz); fx.flashT = Math.max(fx.flashT, 0.35); fx.flashK = 2;
    }
  }
  function swHitEvt(e) {
    if (e.kind === 'psi') { for (var pw = 0; pw < 3; pw++) wave(0, e.x / TILE, e.y / TILE, 0.3, 3.8, 0.9, 0.65, 0.7, 1.0, pw * 0.25); flashAt(e.x / TILE, 1.0, e.y / TILE, 0.3, 1.2); return; }   // v1.0 PLATZHALTER v1.0
    var x = e.x / TILE, z = e.y / TILE, s = null, i;
    for (i = 0; i < sws.length; i++) if (sws[i].on && !sws[i].hit && sws[i].kind === e.kind && Math.abs(sws[i].x - x) < 0.5 && Math.abs(sws[i].z - z) < 0.5) { s = sws[i]; break; }
    if (!s) {   // kein Start gesehen (z. B. Spielstand geladen): trotzdem darstellen
      s = swSlot(); s.on = true; s.kind = e.kind; s.owner = 0; s.x = x; s.z = z; s.born = fx.time; s.tcol[0] = s.tcol[1] = s.tcol[2] = 1;
    }
    s.hit = true; s.ht = fx.time;
    if (e.r > 0) s.r = e.r / TILE; else s.r = e.kind === 'orbital' ? 3 : 4;
    swBlast(s);
  }

  var SW_CAM = 0, bk = 1, bw = 1;
  function swFrame(S, alpha, dt) {
    var now = S.tick + alpha, i, j, t = fx.time, k = bigScale();
    bk = R.post ? 0.6 : 1;
    for (i = 0; i < sws.length; i++) {
      var s = sws[i];
      if (!s.on) continue;
      var gy = groundAt(s.x, s.z) + 0.08, orb = s.kind === 'orbital';
      if (!s.hit) {
        var p = clamp((now - s.t0) / (s.t2 - s.t0), 0, 1);
        if (now > s.t2 + 40) { s.on = false; continue; }          // nie ein swHit gekommen (Aufräumen)
        var pu = 0.62 + 0.38 * Math.sin(t * (9 + 11 * p));
        swDisc.put(s.x, gy - 0.02, s.z, 0, s.r * 1.02, 1, s.r * 1.02, 0.95 * (0.7 + 0.3 * pu), 0.06, 0.05);
        swRingN.put(s.x, gy, s.z, 0, s.r, 1, s.r, 0.55 + 0.45 * pu, 0.04, 0.03);
        swRingN.put(s.x, gy + 0.005, s.z, 0, s.r * (1 - 0.8 * p) + 0.2, 1, s.r * (1 - 0.8 * p) + 0.2, 1, 0.75 + 0.2 * pu, 0.7);
        swDash.put(s.x, gy + 0.01, s.z, t * 0.9, s.r * 0.72, 1, s.r * 0.72, 1, 0.92, 0.88);
        swCross.put(s.x, gy + 0.01, s.z, -t * 0.5, s.r * 0.62, 1, s.r * 0.62, 1, 0.9 + 0.1 * pu, 0.85);
        if (orb && p > 0.35) {                                   // dünner roter Zielstrahl wird dichter
          var q = (p - 0.35) / 0.65, bw = 0.025 + 0.11 * q * q, fl = 0.55 + 0.45 * Math.sin(t * 60);
          swBeam.put(s.x, gy, s.z, 0, bw, 38, bw, (0.7 + 1.4 * q) * fl, 0.25 * fl, 0.2 * fl);
          swGlow.put(s.x, gy + 0.03, s.z, 0, 0.9 + q * 1.6, 1, 0.9 + q * 1.6, 1.2 * q, 0.3 * q, 0.2 * q);
        }
        if (!orb) {                                              // Rakete im Bogen
          var f = p, gf = Math.pow(f, 1.7), dgf = 1.7 * Math.pow(f, 0.7);
          var mx = s.sx + (s.x - s.sx) * gf, mz = s.sz + (s.z - s.sz) * gf, my = -0.18 + s.H * Math.sin(Math.PI * f) + Math.max(0, groundAt(mx, mz));
          var pit = Math.atan2(s.H * Math.PI * Math.cos(Math.PI * f), s.dist * dgf + 1e-4);
          var Ps = S.players[s.owner];
          if (Ps) {
            var MM = model('silo', Ps.faction, Ps.color);
            partBatch('b', 'silo', s.owner, 'mslf', MM).putP(mx, my, mz, s.yaw, pit, 1, 1, 1);
            // Schweif: Flamme + Rauchspur entlang der Flugrichtung (Heck der Rakete)
            var cp = Math.cos(pit), tx = mx - Math.cos(s.yaw) * cp * 0.05, ty = my - Math.sin(pit) * 0.05, tz = mz - Math.sin(s.yaw) * cp * 0.05;
            if (spTier) {
              fbl(tx, ty, tz, 0, 0, 0, 0.09, 0.5, 0.2, 1);
              glw(tx, ty, tz, 0.9, 0.5, 1, 0.7, 0.3, 0.07, 0.9); glw(tx, ty, tz, 0.35, 0.15, 1, 1, 0.9, 0.05, 1);
              if (rnd() < dt * 30 * spQ) puff(tx + (rnd() - 0.5) * 0.1, ty, tz + (rnd() - 0.5) * 0.1, (rnd() - 0.5) * 0.2, 0.1 + rnd() * 0.15, (rnd() - 0.5) * 0.2, 2.4 + rnd() * 1.0, 0.45, 1.9, 0.5, 0.6, 0.15);
              s.px = tx; s.py = ty; s.pz = tz;
            } else {
            emit(0, tx, ty, tz, 0, 0, 0, 0.09, 0.95, 0.25, 1, 0.8, 0.35, 1, 1, 0.35, 0.05, 0);
            emit(0, tx, ty, tz, 0, 0, 0, 0.05, 0.3, 0.1, 1, 1, 0.9, 1, 1, 0.8, 0.4, 0);
            if (!(s.px === s.px)) { s.px = tx; s.py = ty; s.pz = tz; }
            var nn = Math.max(1, Math.round(dt * 90 * k)), qq;
            for (qq = 0; qq < nn; qq++) {
              var u = (qq + rnd()) / nn;
              emit(1, s.px + (tx - s.px) * u + (rnd() - 0.5) * 0.1, s.py + (ty - s.py) * u + (rnd() - 0.5) * 0.1, s.pz + (tz - s.pz) * u + (rnd() - 0.5) * 0.1, (rnd() - 0.5) * 0.25, 0.1 + rnd() * 0.15, (rnd() - 0.5) * 0.25, 2.2 + rnd() * 1.2, 0.5, 2.0, 0.95, 0.94, 0.92, 0.8, 0.66, 0.66, 0.66, 0, 0, 0.5);
            }
            s.px = tx; s.py = ty; s.pz = tz; }
            if (f < 0.12) { emit(0, tx, ty, tz, (rnd() - 0.5) * 1.5, -0.5, (rnd() - 0.5) * 1.5, 0.3, 0.9, 0.2, 1, 0.7, 0.3, 0.9, 1, 0.3, 0.05, 0); }
          }
        }
      } else {
        var age = t - s.ht;
        if (age > 6.5) { s.on = false; continue; }
        var life = age / 1.0;
        if (orb && age < 1.25) {                                 // der Strahl
          var w1 = age < 0.3 ? 0.95 + 0.12 * Math.sin(age * 90) : 0.95 * Math.pow(Math.max(0, 1 - (age - 0.3) / 0.95), 1.4);
          if (w1 > 0.01) {
            bw = R.post ? 0.55 : 1;
            swBeam.put(s.x, gy, s.z, 0, w1 * 1.2 * bw, 38, w1 * 1.2 * bw, 0.08 * bk, 0.3 * bk, 0.5 * bk);
            swBeam.put(s.x, gy, s.z, 0, w1 * 0.8 * bw, 38, w1 * 0.8 * bw, 0.25 * bk, 0.7 * bk, 1.1 * bk);
            swBeam.put(s.x, gy, s.z, 0, w1 * 0.36 * bw, 38, w1 * 0.36 * bw, 1.5 * bk, 1.5 * bk, 1.5 * bk);
            if (spTier) {
              glw(s.x, gy + 0.3, s.z, 1.3 * w1 + 0.6, 1.6 * w1 + 0.8, 0.5, 0.85, 1, 0.07, 0.55);
              if (rnd() < 0.7) { var oa = rnd() * 6.283, os = 1 + rnd() * 2.5; spk(s.x + Math.cos(oa) * 0.5, gy + 0.2, s.z + Math.sin(oa) * 0.5, Math.cos(oa) * os, 1 + rnd() * 5, Math.sin(oa) * os, 0.4 + rnd() * 0.4, 0.09, 0.6, 0.9, 1, -8, 0); }
            }
          }
          if (inViewT(s.x, s.z)) for (j = 0; j < 3 * k; j++) emit(0, s.x + (rnd() - 0.5) * 1.3, gy + rnd() * 2, s.z + (rnd() - 0.5) * 1.3, 0, 6 + rnd() * 9, 0, 0.5, 0.12, 0.04, 0.6, 0.95, 1, 1, 0.3, 0.7, 1, 0);
        }
        if (age < 0.9) {                                         // Druckwelle (zwei Ringe)
          var u = age / 0.9, rr = s.r * 1.1 * (1 - (1 - u) * (1 - u)), fk = (1 - u);
          swRing.put(s.x, gy + 0.02, s.z, 0, rr, 1, rr, (2.0 * fk + 0.1) * bk, (2.2 * fk + 0.1) * bk, (2.4 * fk + 0.1) * bk);
          if (age > 0.08) { var r2 = rr * 0.78; swRing.put(s.x, gy + 0.02, s.z, 0, r2, 1, r2, 1.0 * fk * bk, 1.1 * fk * bk, 1.2 * fk * bk); }
        }
        if (age < 0.4) { var dr = s.r * 0.95 * Math.pow(age / 0.4, 0.55), dk2 = Math.pow(1 - age / 0.4, 1.2) * 0.5; swDome.put(s.x, gy, s.z, 0, dr, dr * 0.75, dr, dk2 * bk * (orb ? 0.5 : 1), dk2 * bk * (orb ? 0.9 : 0.7), dk2 * bk * (orb ? 1 : 0.4)); }
        if (age < 2.2) {                                         // Bodenglühen
          var gk = Math.pow(1 - age / 2.2, 1.4), gs = s.r * (1.3 + 0.5 * Math.min(1, age * 2));
          if (orb) swGlow.put(s.x, gy + 0.03, s.z, 0, gs, 1, gs, 0.5 * gk * 1.6 * bk, 1.0 * gk * 1.6 * bk, 1.4 * gk * 1.6 * bk);
          else swGlow.put(s.x, gy + 0.03, s.z, 0, gs, 1, gs, 1.7 * gk * bk, 0.8 * gk * bk, 0.25 * gk * bk);
        }
        if (age > 0.4 && age < 5.5 && inViewT(s.x, s.z)) {       // Nachbrand: glühender Boden, Rauch
          var ak = 1 - age / 5.5;
          if (spTier) {
            if (rnd() < dt * 9 * ak * spQ) { var sa2 = rnd() * 6.283, sr2 = rnd() * s.r * 0.7; sm(s.x + Math.cos(sa2) * sr2, gy + 0.1, s.z + Math.sin(sa2) * sr2, 0.3, 0.8 + rnd() * 0.8, 0.05, 3 + rnd() * 1.8, 0.7, 2.6, 0.07, 0.6 * ak + 0.2, 0.2 * ak); }
            if (rnd() < dt * 6 * ak * spQ) { var sa3 = rnd() * 6.283, sr3 = rnd() * s.r * 0.75; tng(s.x + Math.cos(sa3) * sr3, gy + 0.05, s.z + Math.sin(sa3) * sr3, 0.4 + rnd() * 0.4, 0.5 + rnd() * 0.4, 0.5 + rnd() * 0.5, 0.9 * ak + 0.2); }
          } else {
          if (rnd() < dt * 22 * ak * k) { var aa = rnd() * 6.283, ar = rnd() * s.r * 0.7; emit(1, s.x + Math.cos(aa) * ar, gy + 0.1, s.z + Math.sin(aa) * ar, 0.2, 0.7 + rnd() * 0.8, 0.05, 2.5 + rnd() * 1.5, 0.6, 1.8, 0.17, 0.16, 0.15, 0.65, 0.34, 0.34, 0.34, 0, 0, 0.5); }
          if (rnd() < dt * 12 * ak * k) { var ab = rnd() * 6.283, br = rnd() * s.r * 0.8; emit(0, s.x + Math.cos(ab) * br, gy + 0.1, s.z + Math.sin(ab) * br, 0, 0.4, 0, 0.5, 0.3, 0.06, 1, 0.5, 0.12, 0.9, 0.9, 0.2, 0.05, 0); }
          }
        }
        void life;
      }
    }
  }
  function inViewT(x, z) {
    if (R.VDIR && R.inView) return R.inView(x, z);
    var c0 = V.toWorld(-60, -60), c1 = V.toWorld(V.vw + 60, V.vh + 140);
    return x * TILE > c0.x - 64 && x * TILE < c1.x + 64 && z * TILE > c0.y - 64 && z * TILE < c1.y + 64;
  }

  /** Beschriftung + Restzeit am Warnmarker (2D, scharf); Randpfeil, wenn das Ziel außerhalb des Bildes liegt. */
  var ovP = { x: 0, y: 0 }, ovQ = { x: 0, y: 0 };
  function swOverlay(S, alpha) {
    var octx = R.octx, project = R.project;
    var now = S.tick + alpha, i, HZ = D.TICK_HZ;
    for (i = 0; i < sws.length; i++) {
      var s = sws[i];
      if (!s.on || s.hit) continue;
      var rem = Math.max(0, (s.t2 - now) / HZ), mine = s.owner === V.pid;
      var title = s.kind === 'orbital' ? 'ORBITALSCHLAG' : 'RAKETENANGRIFF', txt = rem.toFixed(1) + ' s';
      project(s.x, 0.1, s.z, ovP);
      var fs = 15, m = 34;
      octx.font = '800 ' + fs + 'px system-ui, sans-serif'; octx.textAlign = 'center'; octx.textBaseline = 'middle'; octx.lineJoin = 'round';
      if (ovP.x > m && ovP.x < V.vw - m && ovP.y > m + 40 && ovP.y < V.vh - m) {
        project(s.x, 0.1, s.z + s.r, ovQ);
        var ty = Math.min(V.vh - m, ovQ.y + 20);
        octx.lineWidth = 5; octx.strokeStyle = 'rgba(0,0,0,0.85)'; octx.fillStyle = mine ? '#9ee6ff' : '#ffb4a8';
        var lx = clamp(ovP.x, 70, V.vw - 70);
        octx.strokeText(title, lx, ty); octx.fillText(title, lx, ty);
        octx.font = '800 ' + (fs + 4) + 'px system-ui, sans-serif'; octx.fillStyle = '#ffffff';
        octx.strokeText(txt, lx, ty + fs + 3); octx.fillText(txt, lx, ty + fs + 3);
      } else {                                                 // Randpfeil
        var cx = V.vw / 2, cy = V.vh / 2, dx = ovP.x - cx, dy = ovP.y - cy, kx = (V.vw / 2 - m) / Math.max(1, Math.abs(dx)), ky = (V.vh / 2 - m - 40) / Math.max(1, Math.abs(dy)), kk = Math.min(kx, ky);
        var ax = cx + dx * kk, ay = cy + dy * kk + 20, an = Math.atan2(dy, dx);
        octx.save(); octx.translate(ax, ay); octx.rotate(an);
        octx.fillStyle = 'rgba(0,0,0,0.8)'; octx.beginPath(); octx.moveTo(20, 0); octx.lineTo(-10, -15); octx.lineTo(-10, 15); octx.closePath(); octx.fill();
        octx.fillStyle = '#ff5a4a'; octx.beginPath(); octx.moveTo(15, 0); octx.lineTo(-6, -10); octx.lineTo(-6, 10); octx.closePath(); octx.fill();
        octx.restore();
        octx.lineWidth = 4; octx.strokeStyle = 'rgba(0,0,0,0.85)'; octx.fillStyle = '#ffffff';
        octx.font = '800 ' + (fs + 1) + 'px system-ui, sans-serif';
        octx.strokeText(txt, ax - Math.cos(an) * 34, ay - Math.sin(an) * 22); octx.fillText(txt, ax - Math.cos(an) * 34, ay - Math.sin(an) * 22);
      }
    }
    octx.textBaseline = 'alphabetic';
  }

  // ------------------------------------------------------------------ v0.5: Strahlen & Blitze, Bauhof-Aufbau, Mauern
  // Strahlen/Blitze: gepoolte Bänder (Quads, MeshBasicMaterial, additiv, Vertexfarben) – KEIN ShaderMaterial, daher auch im Schonmodus erlaubt.
  // Ein Band liegt in der Ebene, die von der Segmentrichtung und der (festen) Blickrichtung der Kamera aufgespannt wird → immer sichtbar breit.
  var BM = null, BM_N = 2600, BOLT_N = 14, BOLT_SEG = 110;
  function initBeams() {
    var N = BM_N, geo = new THREE.BufferGeometry(), pos = new Float32Array(N * 12), col = new Float32Array(N * 12), idx = new Uint16Array(N * 6), i;
    for (i = 0; i < N; i++) { var v = i * 4; idx[i * 6] = v; idx[i * 6 + 1] = v + 1; idx[i * 6 + 2] = v + 2; idx[i * 6 + 3] = v; idx[i * 6 + 4] = v + 2; idx[i * 6 + 5] = v + 3; }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.setDrawRange(0, 0);
    var mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, toneMapped: false, side: THREE.DoubleSide });
    var mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false; mesh.renderOrder = 7;
    scene.add(mesh);
    BM = { pos: pos, col: col, geo: geo, mesh: mesh, n: 0, N: N, bolts: [] };
    for (i = 0; i < BOLT_N; i++) BM.bolts.push({ on: false, kind: 0, t0: 0, life: 0.2, nn: 0, nx: new Float32Array(6), ny: new Float32Array(6), nz: new Float32Array(6), segs: new Float32Array(BOLT_SEG * 7), segs2: new Float32Array(BOLT_SEG * 7), ns2: 0, ns: 0, jit: -1, fl: 1 });
  }
  function freeBolt() {
    var B = BM.bolts, best = 0, bt = 1e9, i;
    for (i = 0; i < B.length; i++) { if (!B[i].on) return B[i]; if (B[i].t0 < bt) { bt = B[i].t0; best = i; } }
    return B[best];
  }
  /** Ein Band (Quad) von p0 nach p1, Halbbreite hw, Farbe rgb (darf >1 sein, additiv). */
  function bq(x0, y0, z0, x1, y1, z1, hw, r, g, b) {
    if (BM.n >= BM.N) return;
    var dx = x1 - x0, dy = y1 - y0, dz = z1 - z0, l = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-6;
    var VD = R.VDIR, vx = VD ? VD.x : 0, vy = VD ? VD.y : -R.SIN, vz = VD ? VD.z : -R.COS;   // Blickrichtung (Fallback: feste Kamera (0,−SIN,−COS))
    var wx = dy * vz - dz * vy, wy = dz * vx - dx * vz, wz = dx * vy - dy * vx, wl = Math.sqrt(wx * wx + wy * wy + wz * wz);   // Segment × Blickrichtung
    if (wl < 1e-5) { wx = 1; wy = 0; wz = 0; wl = 1; }
    var k = hw / wl, ex = dx / l * hw * 0.6, ey = dy / l * hw * 0.6, ez = dz / l * hw * 0.6;
    wx *= k; wy *= k; wz *= k;
    var P = BM.pos, C = BM.col, o = BM.n * 12, q;
    P[o] = x0 - ex + wx; P[o + 1] = y0 - ey + wy; P[o + 2] = z0 - ez + wz;
    P[o + 3] = x0 - ex - wx; P[o + 4] = y0 - ey - wy; P[o + 5] = z0 - ez - wz;
    P[o + 6] = x1 + ex - wx; P[o + 7] = y1 + ey - wy; P[o + 8] = z1 + ez - wz;
    P[o + 9] = x1 + ex + wx; P[o + 10] = y1 + ey + wy; P[o + 11] = z1 + ez + wz;
    for (q = 0; q < 4; q++) { C[o + q * 3] = r; C[o + q * 3 + 1] = g; C[o + q * 3 + 2] = b; }
    BM.n++;
  }
  /** Band mit Farbverlauf: Farbe c0 am Ende p0, c1 am Ende p1 (Leuchtspuren: dunkler Schweif, heller Kopf). */
  function bqg(x0, y0, z0, x1, y1, z1, hw, r0, g0, b0, r1, g1, b1) {
    if (BM.n >= BM.N) return;
    var o = BM.n * 12, C = BM.col;
    bq(x0, y0, z0, x1, y1, z1, hw, r0, g0, b0);
    if (BM.n * 12 === o) return;
    C[o + 6] = C[o + 9] = r1; C[o + 7] = C[o + 10] = g1; C[o + 8] = C[o + 11] = b1;
  }
  function segPush(B, ax, ay, az, bx, by, bz, lvl) {
    if (B.ns >= BOLT_SEG) return;
    var o = B.ns++ * 7, s = B.segs;
    s[o] = ax; s[o + 1] = ay; s[o + 2] = az; s[o + 3] = bx; s[o + 4] = by; s[o + 5] = bz; s[o + 6] = lvl;
  }
  /** Zackiger Linienzug a→b (n Teilstücke, seitliche Auslenkung amp, Gewicht lvl 0 Hauptast / 1 Nebenast). */
  function zig(B, ax, ay, az, bx, by, bz, amp, lvl, n) {
    var dx = bx - ax, dz = bz - az, dl = Math.sqrt(dx * dx + dz * dz) + 1e-6, nx = -dz / dl, nz = dx / dl;
    var px = ax, py = ay, pz = az, i, t, qx, qy, qz, env, o;
    for (i = 1; i <= n; i++) {
      t = i / n; qx = ax + (bx - ax) * t; qy = ay + (by - ay) * t; qz = az + (bz - az) * t;
      if (i < n) {
        env = Math.sin(Math.PI * t) * 0.7 + 0.3; o = (rnd() * 2 - 1) * amp * env;
        qx += nx * o; qz += nz * o; qy += (rnd() * 2 - 1) * amp * 0.45 * env;
      }
      segPush(B, px, py, pz, qx, qy, qz, lvl);
      if (lvl === 0 && !safeGPU && i > 1 && i < n && rnd() < 0.3) {          // Nebenast
        var a = (rnd() < 0.5 ? -1 : 1) * (0.5 + rnd() * 0.7), ca = Math.cos(a), sa = Math.sin(a), ux = dx / dl, uz = dz / dl, len = 0.35 + rnd() * 0.5;
        zig(B, qx, qy, qz, qx + (ux * ca - uz * sa) * len, qy - 0.04 - rnd() * 0.12, qz + (ux * sa + uz * ca) * len, 0.07, 1, 3);
      }
      px = qx; py = qy; pz = qz;
    }
  }
  function genBolt(B) {
    B.ns = 0;
    var amp = B.kind === 2 ? 0.07 : 0.15, i;
    for (i = 0; i + 1 < B.nn; i++) {
      var dx = B.nx[i + 1] - B.nx[i], dy = B.ny[i + 1] - B.ny[i], dz = B.nz[i + 1] - B.nz[i], L = Math.sqrt(dx * dx + dy * dy + dz * dz);
      var n = clamp(Math.round(L / (safeGPU ? 0.7 : 0.38)), 3, safeGPU ? 7 : 13);
      zig(B, B.nx[i], B.ny[i], B.nz[i], B.nx[i + 1], B.ny[i + 1], B.nz[i + 1], amp, 0, n);
    }
  }
  function updateBeams() {
    if (!BM) return;
    BM.n = 0;
    var Bs = BM.bolts, i, j, B, age, f, fade, s, o;
    var T = fx.tr, tg, th0, th1, tk, soft = R.post ? 1 : 1.5;
    for (i = 0; i < T.n; i++) {       // Leuchtspuren: Kopf fliegt vom Lauf zum Ziel, glühender Schweif (mehrlagig)
      tg = T.age[i] / T.life[i]; th1 = Math.min(1, tg * 1.35); th0 = Math.max(0, th1 - 0.5); tk = 1 - tg * 0.55;
      var dx = T.x1[i] - T.x0[i], dy = T.y1[i] - T.y0[i], dz = T.z1[i] - T.z0[i], big = T.kind[i] > 0.5;
      var ax = T.x0[i] + dx * th0, ay = T.y0[i] + dy * th0, az = T.z0[i] + dz * th0, bx2 = T.x0[i] + dx * th1, by2 = T.y0[i] + dy * th1, bz2 = T.z0[i] + dz * th1;
      bqg(ax, ay, az, bx2, by2, bz2, (big ? 0.075 : 0.045) * soft, 0.1 * tk, 0.05 * tk, 0, 0.9 * tk, 0.45 * tk, 0.1 * tk);
      bqg(ax, ay, az, bx2, by2, bz2, big ? 0.032 : 0.02, 0.35 * tk, 0.3 * tk, 0.1 * tk, 1.7 * tk, 1.5 * tk, 0.8 * tk);
    }
    for (i = 0; i < Bs.length; i++) {
      B = Bs[i];
      if (!B.on) continue;
      age = fx.time - B.t0;
      if (age >= B.life) { B.on = false; continue; }
      f = age / B.life;
      if (B.kind === 3) {                                        // v0.7 Scharfschütze: Kopf fliegt in ~40 ms, kurzer Schweif, dünn und hell
        var sh1 = Math.min(1, age / 0.04), sh0 = clamp((age - 0.015) / 0.09, 0, 1), sfd = 1 - f * f;
        var sx0 = B.nx[0] + (B.nx[1] - B.nx[0]) * sh0, sy0 = B.ny[0] + (B.ny[1] - B.ny[0]) * sh0, sz0 = B.nz[0] + (B.nz[1] - B.nz[0]) * sh0;
        var sx1 = B.nx[0] + (B.nx[1] - B.nx[0]) * sh1, sy1 = B.ny[0] + (B.ny[1] - B.ny[0]) * sh1, sz1 = B.nz[0] + (B.nz[1] - B.nz[0]) * sh1;
        bq(B.nx[0], B.ny[0], B.nz[0], B.nx[1], B.ny[1], B.nz[1], 0.012, 0.05 * sfd, 0.09 * sfd, 0.18 * sfd);        // schwacher Nachglanz der ganzen Bahn
        if (sh0 < 1) {
          bq(sx0, sy0, sz0, sx1, sy1, sz1, 0.045 * soft, 0.12, 0.25, 0.6);
          bq(sx0, sy0, sz0, sx1, sy1, sz1, 0.011, 1.6, 1.7, 1.8);
        }
      } else if (B.kind === 0) {                                        // Laser: gerade, hell, verjüngt sich, Nachglühen
        fade = 1 - f * f; var wk = 1 - 0.55 * f, sh = 1 + 0.08 * Math.sin(fx.time * 90), af = f < 0.45 ? 1 : Math.max(0, 1 - (f - 0.45) / 0.55);
        for (j = 0; j + 1 < B.nn; j++) {
          bq(B.nx[j], B.ny[j], B.nz[j], B.nx[j + 1], B.ny[j + 1], B.nz[j + 1], 0.2 * wk * sh * soft, 0.02 * fade * af, 0.1 * fade * af, 0.34 * fade * af);
          bq(B.nx[j], B.ny[j], B.nz[j], B.nx[j + 1], B.ny[j + 1], B.nz[j + 1], 0.1 * wk * sh, 0.1 * fade * af, 0.5 * fade * af, 1.3 * fade * af);
          bq(B.nx[j], B.ny[j], B.nz[j], B.nx[j + 1], B.ny[j + 1], B.nz[j + 1], 0.055 * wk, 0.35 * fade, 0.95 * fade, 1.5 * fade);
          bq(B.nx[j], B.ny[j], B.nz[j], B.nx[j + 1], B.ny[j + 1], B.nz[j + 1], 0.024 * wk, 1.5 * fade * af, 1.6 * fade * af, 1.6 * fade * af);
        }
      } else {                                                   // Blitz: zackig, flackert, Nachbild
        if (B.jit < 0 || fx.time - B.jit > 0.04) {
          if (B.jit >= 0) { B.segs2.set(B.segs); B.ns2 = B.ns; }
          genBolt(B); B.jit = fx.time; B.fl = 0.55 + 0.45 * rnd();
        }
        fade = (1 - f * f) * B.fl * (B.kind === 2 ? 0.8 : 1);
        if (B.ns2 > 0) for (j = 0; j < B.ns2; j++) {             // Nachbild: vorherige Form, schwach
          s = B.segs2; o = j * 7;
          bq(s[o], s[o + 1], s[o + 2], s[o + 3], s[o + 4], s[o + 5], s[o + 6] < 0.5 ? 0.07 : 0.035, 0.05 * fade, 0.1 * fade, 0.4 * fade);
        }
        for (j = 0; j < B.ns; j++) {
          s = B.segs; o = j * 7;
          var main = s[o + 6] < 0.5;
          bq(s[o], s[o + 1], s[o + 2], s[o + 3], s[o + 4], s[o + 5], (main ? 0.16 : 0.08) * soft, 0.03 * fade, 0.07 * fade, 0.3 * fade);
          bq(s[o], s[o + 1], s[o + 2], s[o + 3], s[o + 4], s[o + 5], main ? 0.085 : 0.045, 0.2 * fade, 0.34 * fade, 1.25 * fade);
          bq(s[o], s[o + 1], s[o + 2], s[o + 3], s[o + 4], s[o + 5], main ? 0.024 : 0.013, 1.4 * fade, 1.55 * fade, 1.8 * fade);
        }
      }
    }
    healBeams(soft);
    BM.geo.setDrawRange(0, BM.n * 6);
    BM.mesh.visible = BM.n > 0;
    if (BM.n) { BM.geo.attributes.position.needsUpdate = true; BM.geo.attributes.color.needsUpdate = true; }
  }
  /** Einschlagsglühen (kind 0 Laser cyan, 1 Blitz blau-weiß). */
  function beamImpactL(x, y, z, kind, k) {
    var r = kind ? 0.55 : 0.35, g = kind ? 0.7 : 0.9, b = 1;
    halo(x, y, z, 1.8 * k, r, g, b, 0.25);
    emit(0, x, y, z, 0, 0.1, 0, 0.22, 0.95 * k, 0.3 * k, r, g, b, 1, r * 0.4, g * 0.5, b, 0);
    emit(0, x, y, z, 0, 0, 0, 0.1, 0.4 * k, 0.15 * k, 1, 1, 1, 1, 1, 1, 1, 0);
    var n = Math.round((kind ? 7 : 6) * bigScale()), i, a, sp;
    for (i = 0; i < n; i++) {
      a = rnd() * 6.283; sp = 0.5 + rnd() * 1.1;
      emit(0, x, y, z, Math.cos(a) * sp, 0.6 + rnd() * 1.4, Math.sin(a) * sp, 0.2 + rnd() * 0.25, 0.07, 0.02, r + 0.4, g + 0.3, 1, 1, r * 0.5, g * 0.5, 1, 0, -7, 0);
    }
  }
  // ------------------------------------------------------------------ v0.7: neue Waffeneffekte (Scharfschütze, Flammenwerfer, MLRS-Salve, Sanitäter)
  var flames = [], heals = [];     // laufende Flammenstrahlen (≤ 10) und Heil-Pulse (≤ 20); Pool, Obergrenze → keine Allokation je Frame
  /** Scharfschuss: Linie läuft in ~40 ms vom Lauf zum Ziel (Kopf), Schweif folgt; kleiner Treffer-Puff. */
  function sniperShot(tx, ty, tz, e) {
    var B = freeBolt();
    B.kind = 3; B.nn = 2; B.t0 = fx.time; B.life = 0.2; B.ns2 = 0; B.jit = -1; B.on = true;
    B.nx[0] = tmpV.x; B.ny[0] = tmpV.y; B.nz[0] = tmpV.z; B.nx[1] = tx; B.ny[1] = ty; B.nz[1] = tz;
    sparkle(tmpV.x, tmpV.y, tmpV.z, 0.55);
    var hte = e.tid ? G.Sim.get(e.tid) : null;
    impact(tx, ty + 0.05, tz, hte ? (hte.kind === 'building' ? 'building' : (D.UNITS[hte.type] ? D.UNITS[hte.type].armor : 'inf')) : 'inf');
    puff(tx, ty, tz, (rnd() - 0.5) * 0.3, 0.25, (rnd() - 0.5) * 0.3, 0.5, 0.1, 0.32, 0.5, 0.45, 0);
  }
  /** Flammenstrahl: Düse tmpV → Ziel; die Teilchen werden in fill() über 0,5 s ausgestoßen (Kegel). */
  function flameShot(tx, ty, tz) {
    var f = null, i, old = 1e9, k = 0;
    for (i = 0; i < flames.length; i++) { if (!flames[i].on) { f = flames[i]; break; } if (flames[i].t0 < old) { old = flames[i].t0; k = i; } }
    if (!f) { if (flames.length < 10) { f = {}; flames.push(f); } else f = flames[k]; }
    f.on = true; f.t0 = fx.time; f.dur = 0.5; f.acc = 0; f.x0 = tmpV.x; f.y0 = tmpV.y; f.z0 = tmpV.z; f.x1 = tx; f.y1 = ty + 0.08; f.z1 = tz;
    decal(tx, tz, 0.6, 18);                                   // Brandfleck
    if (spTier) burn(tx, tz, 2.5, 0.45, 1);
    else halo(tx, ty + 0.1, tz, 1.4, 1, 0.55, 0.15, 0.45);
    if (spTier) glw(tmpV.x, tmpV.y, tmpV.z, 0.35, 0.2, 1, 0.75, 0.3, 0.3, 0.9); else emit(0, tmpV.x, tmpV.y, tmpV.z, 0, 0, 0, 0.3, 0.3, 0.12, 1, 0.8, 0.35, 1, 1, 0.4, 0.1, 0);
  }
  function flameUpdate(dt) {
    var i, f, age, dx, dz, L, ux, uz, px, pz, spd, n, kq = spTier ? spQ : (safeGPU ? 0.5 : 1);
    for (i = 0; i < flames.length; i++) {
      f = flames[i]; if (!f.on) continue;
      age = fx.time - f.t0;
      if (age > f.dur) { f.on = false; continue; }
      if (dt <= 0) continue;
      dx = f.x1 - f.x0; dz = f.z1 - f.z0; L = Math.sqrt(dx * dx + dz * dz) + 1e-4; ux = dx / L; uz = dz / L; px = -uz; pz = ux;
      f.acc += dt * 170 * kq * (age < 0.08 ? age / 0.08 : (age > f.dur - 0.12 ? (f.dur - age) / 0.12 : 1));
      n = Math.min(14, f.acc | 0); f.acc -= n;
      while (n-- > 0) {
        var sp = (L / 0.3) * (0.7 + 0.45 * rnd()), lat = (rnd() - 0.5) * sp * 0.34, vy = (f.y1 - f.y0) / 0.3 * 0.6 + 0.25 + rnd() * 0.5, life = 0.26 + rnd() * 0.12, sz = 0.28 + rnd() * 0.16, o = rnd() * 0.12;
        if (spTier) spn(0, 12, 4, f.x0 + ux * o, f.y0, f.z0 + uz * o, ux * sp + px * lat, vy, uz * sp + pz * lat, life, sz * 0.7, sz * 2.1, 0, 0, GN, 0.9 * GN, 0.8 * GN, 0.95, 0.7 * GN, 0.5 * GN, 0.4 * GN, 0, 0.5, 0.4, 0, 0);
        else emit(0, f.x0 + ux * o, f.y0, f.z0 + uz * o, ux * sp + px * lat, vy, uz * sp + pz * lat, life, sz * 0.9, sz * 1.9, 1, 0.78, 0.3, 0.95, 0.85, 0.22, 0.05, 0, 0.5, 0.4);
        if (rnd() < 0.12) puff(f.x0 + ux * L * 0.7, f.y0 + 0.1, f.z0 + uz * L * 0.7, px * lat * 0.3, 0.5, pz * lat * 0.3, 0.9, 0.16, 0.5, 0.2, 0.4, 0);
      }
    }
  }
  /** MLRS: eine Rakete der Salve startet – Rohrversatz je salvo-Index (2×3), Mündungsfeuer, Rauchwolke hinten, Funkenschweif. */
  function salvoLaunch(src, e, tx, tz) {
    var ang = Math.atan2(tz - tmpV.z, tx - tmpV.x), idx = e.salvo | 0, lat = ((idx % 3) - 1) * 0.085;
    tmpV.x += -Math.sin(ang) * lat; tmpV.z += Math.cos(ang) * lat; tmpV.y += (idx < 3 ? 0 : 0.06);
    sparkle(tmpV.x, tmpV.y, tmpV.z, 0.9);
    var bx = -Math.cos(ang), bz = -Math.sin(ang), q;
    for (q = 0; q < 4; q++) puff(tmpV.x + bx * 0.08, tmpV.y, tmpV.z + bz * 0.08, bx * (0.5 + rnd() * 0.9) + (rnd() - 0.5) * 0.4, 0.15 + rnd() * 0.5, bz * (0.5 + rnd() * 0.9) + (rnd() - 0.5) * 0.4, 1.0 + rnd() * 0.8, 0.14, 0.7, 0.55, 0.5, 0);
    if (idx === 0 || idx === 3) { dust(tmpV.x + bx * 0.3, 0, tmpV.z + bz * 0.3, 0.6); flash.position.set(tmpV.x, tmpV.y + 0.2, tmpV.z); fx.flashT = Math.max(fx.flashT, 0.15); fx.flashK = 1.2; }
    if (src && !src.dead) { var ss = rs.get(src.id); if (ss) ss.b0 = fx.time; }
  }  // ------------------------------------------------------------------ v0.9 Schlachtschiff-Raketen
  /** Bahnhöhe über der Geraden (Kacheln): hoher ballistischer Bogen, Steigung am Start ≈ Schienen-Erhöhung. */
  function missileArc(dist) { return 0.6 + 0.24 * dist; }
  /** Raketenstart (Ereignis shot.missile, je Rakete): Startflamme, Rauchsäule aus dem Abgasstrahl, Blitz, Gischt neben der Bordwand. */
  function missileLaunch(src, e, tx, tz) {
    var idx = e.salvo | 0;
    if (src && !src.dead) M3.muzzleOf(src, tmpV, tx, tz, idx % 2); 
    var ang = Math.atan2(tz - tmpV.z, tx - tmpV.x), bx = -Math.cos(ang), bz = -Math.sin(ang), q, n = safeGPU ? 6 : 12;
    sparkle(tmpV.x, tmpV.y, tmpV.z, 1.8);
    if (spTier) {
      glw(tmpV.x, tmpV.y, tmpV.z, 1.4, 0.4, 1, 0.7, 0.3, 0.25, 1);
      for (q = 0; q < 5; q++) tng(tmpV.x + bx * 0.1 * q, tmpV.y - 0.06 * q, tmpV.z + bz * 0.1 * q, -0.2, 0.25 + rnd() * 0.15, 0.3 - q * 0.03, 1.2);
    } else halo(tmpV.x, tmpV.y, tmpV.z, 1.6, 1, 0.7, 0.3, 0.3);
    for (q = 0; q < n; q++) {   // Abgasstrahl: Rauch schießt nach hinten/unten aus der Schiene, quillt über das Deck
      var sp = 0.6 + rnd() * 1.4, f = q / n;
      puff(tmpV.x + bx * (0.1 + f * 0.4), tmpV.y - f * 0.3, tmpV.z + bz * (0.1 + f * 0.4), bx * sp + (rnd() - 0.5) * 0.6, -0.15 + rnd() * 0.5, bz * sp + (rnd() - 0.5) * 0.6, 2.2 + rnd() * 1.6, 0.18, 1.1 + rnd() * 0.5, 0.78, 0.55, q < 3 ? 0.5 : 0);
    }
    for (q = 0; q < 3; q++) puff(tmpV.x, tmpV.y + 0.1, tmpV.z, (rnd() - 0.5) * 0.3, 0.6 + rnd() * 0.5, (rnd() - 0.5) * 0.3, 3 + rnd(), 0.2, 1.3, 0.7, 0.4, 0);   // aufsteigende Säule
    if (src && !src.dead) { var sx = src.x / TILE, sz = src.y / TILE; wave(0, sx + bx * 0.3, sz + bz * 0.3, 0.3, 1.6, 0.9, 0.35, 0.38, 0.4); }
    flashAt(tmpV.x, tmpV.y + 0.3, tmpV.z, 0.16, 1.5); addShake(0.05, 0.25);
    if (src && !src.dead) { var ss = rs.get(src.id); if (ss) ss.b0 = fx.time; }
  }
  /** Rakete im Flug: Lage entlang der Bahn, Triebwerksglut, dichte Rauchspur (lückenlos zwischen zwei Bildern). */
  function missileProj(p, fr, x, z, dt) {
    var src = G.Sim.get(p.src), d = Math.hypot(p.tx - p.x0, p.ty - p.y0) / TILE + 1e-4, h = missileArc(d);
    var y0 = src && !src.dead && src.mc === 3 ? M3.WL + 0.55 : (p.y0p != null ? p.y0p : M3.WL + 0.55), y1 = groundAt(p.tx / TILE, p.ty / TILE) + 0.1;
    if (p.y0p == null) p.y0p = y0; else y0 = p.y0p;
    var y = y0 + (y1 - y0) * fr + h * 4 * fr * (1 - fr), ang = Math.atan2(p.ty - p.y0, p.tx - p.x0), pit = Math.atan2((y1 - y0) + h * 4 * (1 - 2 * fr), d);
    missileB.putP(x, y, z, ang, pit, 1.25, 1.25, 1.25);
    var cp = Math.cos(pit), tx = x - Math.cos(ang) * cp * 0.24, ty = y - Math.sin(pit) * 0.24, tz = z - Math.sin(ang) * cp * 0.24;
    if (p.lx == null) { p.lx = tx; p.ly = ty; p.lz = tz; }
    var seg = Math.hypot(tx - p.lx, ty - p.ly, tz - p.lz), n = Math.min(6, Math.ceil(seg / (safeGPU ? 0.14 : 0.08))), q, f;
    for (q = 0; q < n; q++) {
      f = (q + rnd()) / n;
      var qx = p.lx + (tx - p.lx) * f, qy = p.ly + (ty - p.ly) * f, qz = p.lz + (tz - p.lz) * f;
      if (spTier) puff(qx, qy, qz, (rnd() - 0.5) * 0.06, 0.04, (rnd() - 0.5) * 0.06, 2.4 + rnd() * 1.2, 0.1, 0.62 + rnd() * 0.2, 0.82, 0.5, 0);
      else emit(1, qx, qy, qz, 0, 0.04, 0, 1.8 + rnd() * 0.6, 0.09, 0.42, 0.88, 0.88, 0.9, 0.55, 0.78, 0.78, 0.8, 0, 0, 1);
    }
    p.lx = tx; p.ly = ty; p.lz = tz;
    if (spTier) {
      glw(tx, ty, tz, 0.5, 0.2, 1, 0.62, 0.22, 0.05, 1);
      spn(0, 10, 0, tx, ty, tz, 0, 0, 0, 0.05, 0.24, 0.08, 0, 0, 1.3 * GN, 1.0 * GN, 0.6 * GN, 1, 1 * GN, 0.45 * GN, 0.1 * GN, 0, 0, 0, 0, 0);
    } else emit(0, tx, ty, tz, 0, 0, 0, 0.07, 0.24, 0.08, 1, 0.8, 0.4, 1, 1, 0.45, 0.1, 0);
    void dt;
  }
  /** Einschlag (hit w:'missile'): große Explosion, Feuerball + aufsteigender Rauchpilz, Druckwelle, Krater; auf Wasser hohe Fontäne. */
  function missileHit(x, z, k) {
    var gy = groundAt(x, z), q, n;
    k = clamp(k || 1.3, 0.8, 2);
    if (T3.heightAt(x, z) < -0.09) {
      splash(x, z, 1.5 * k); splash(x + 0.2, z - 0.15, 1.1 * k);
      flashAt(x, M3.WL + 0.6, z, 0.16, 1.5); addShake(0.1, 0.4); return;
    }
    explosion(x, gy + 0.2, z, 1.25 * k, true);
    explosion(x + (rnd() - 0.5) * 0.5, gy + 0.35, z + (rnd() - 0.5) * 0.5, 0.8 * k, false);
    dust(x, gy, z, 1.3 * k);
    n = safeGPU ? 4 : 8;
    for (q = 0; q < n; q++) puff(x + (rnd() - 0.5) * 0.4, gy + 0.3 + q * 0.12, z + (rnd() - 0.5) * 0.4, (rnd() - 0.5) * 0.25, 0.7 + q * 0.1, (rnd() - 0.5) * 0.25, 3.2 + rnd() * 1.5, 0.3, 1.2 * k, 0.22, 0.6, q < 2 ? 0.8 : 0);   // Rauchpilz
    if (spTier) { burn(x, z, 8 + rnd() * 4, 0.9 * k, 1); glw(x, gy + 0.4, z, 2.6 * k, 1.2 * k, 1, 0.6, 0.25, 0.35, 1); }
    else halo(x, gy + 0.4, z, 2.2 * k, 1, 0.6, 0.25, 0.35);
    wave(0, x, z, 0.3, 3.0 * k, 0.6, 0.7, 0.55, 0.35); wave(1, x, z, 0.4, 1.8 * k, 0.5, 0.9, 0.5, 0.2);
    decal(x, z, 1.4 * k, 50);
    flashAt(x, gy + 0.6, z, 0.2, 2.2); addShake(0.16, 0.45);
  }

  /** Sanitäter-Heilung (Ereignis heal, ≤ 1/s je Sanitäter): Bodenring, aufsteigendes grünes Kreuz + Glitzer am Ziel, kurzer Faden Sanitäter → Ziel. */
  function healEvt(e, S) {
    var tg = G.Sim.get(e.tid);
    if (!tg || tg.dead || !(S.settings.fogOff || tg.owner === V.pid || G.Sim.isVisible(V.pid, tg))) return;
    var x = tg.x / TILE, z = tg.y / TILE, y = groundAt(x, z), h = null, i, old = 1e9, k = 0;
    for (i = 0; i < heals.length; i++) { if (!heals[i].on) { h = heals[i]; break; } if (heals[i].t0 < old) { old = heals[i].t0; k = i; } }
    if (!h) { if (heals.length < 20) { h = {}; heals.push(h); } else h = heals[k]; }
    h.on = true; h.t0 = fx.time; h.x = x; h.y = y; h.z = z; h.mx = (e.sx != null ? e.sx : e.x) / TILE; h.mz = (e.sy != null ? e.sy : e.y) / TILE; h.ph = rnd() * 6;
    addPulse(x, z, '#4ade80', 0.5, 0.8);
    var n = safeGPU ? 3 : 6, q;
    for (q = 0; q < n; q++) {
      var a = rnd() * 6.283, r = 0.1 + rnd() * 0.22;
      if (spTier) spk(x + Math.cos(a) * r, y + 0.1, z + Math.sin(a) * r, 0, 0.7 + rnd() * 0.5, 0, 0.7 + rnd() * 0.3, 0.07, 0.35, 1, 0.5, 0.1, 0);
      else emit(0, x + Math.cos(a) * r, y + 0.1, z + Math.sin(a) * r, 0, 0.6 + rnd() * 0.5, 0, 0.7 + rnd() * 0.3, 0.07, 0.03, 0.4, 1, 0.55, 1, 0.2, 0.8, 0.3, 0, 0, 0);
    }
    halo(x, y + 0.3, z, 1.0, 0.3, 1, 0.5, 0.5);
  }
  /** Heil-Kreuze als Bänder (in updateBeams): zwei Pulse je Ereignis, steigen auf und blenden aus. */
  function healBeams(soft) {
    var RG = R.RIGHT, rx = RG ? (RG.length === 2 ? RG[0] : RG.x) : 1, rz = RG ? (RG.length === 2 ? RG[1] : RG.z) : 0, i, h, k, age, q, a, s, cy;
    for (i = 0; i < heals.length; i++) {
      h = heals[i]; if (!h.on) continue;
      age = fx.time - h.t0;
      if (age > 1.0) { h.on = false; continue; }
      if (age < 0.28) {   // Faden Sanitäter → Ziel
        a = 0.35 * (1 - age / 0.28);
        bq(h.mx, h.y + 0.3, h.mz, h.x, h.y + 0.3, h.z, 0.012 * soft, 0.1 * a, 0.9 * a, 0.35 * a);
      }
      for (k = 0; k < 2; k++) {
        q = (age - k * 0.22) / 0.7; if (q <= 0 || q >= 1) continue;
        a = Math.sin(q * Math.PI); s = k ? 0.12 : 0.16; cy = h.y + 0.7 + 0.45 * q;
        bq(h.x, cy - s, h.z, h.x, cy + s, h.z, 0.07 * soft, 0.08 * a, 0.55 * a, 0.2 * a);        // Leuchtrand
        bq(h.x - rx * s, cy, h.z - rz * s, h.x + rx * s, cy, h.z + rz * s, 0.07 * soft, 0.08 * a, 0.55 * a, 0.2 * a);
        bq(h.x, cy - s, h.z, h.x, cy + s, h.z, 0.032, 0.35 * a, 1.6 * a, 0.6 * a);                // Kern
        bq(h.x - rx * s, cy, h.z - rz * s, h.x + rx * s, cy, h.z + rz * s, 0.032, 0.35 * a, 1.6 * a, 0.6 * a);
      }
    }
  }
  function laserShot(src, tx, ty, tz) {
    var B = freeBolt();
    B.kind = 0; B.nn = 2; B.t0 = fx.time; B.life = 0.24; B.ns2 = 0; B.jit = -1; B.on = true;
    B.nx[0] = tmpV.x; B.ny[0] = tmpV.y; B.nz[0] = tmpV.z; B.nx[1] = tx; B.ny[1] = ty; B.nz[1] = tz;
    emit(0, tmpV.x, tmpV.y, tmpV.z, 0, 0.05, 0, 0.12, 0.5, 0.15, 0.4, 0.95, 1, 1, 0.2, 0.6, 1, 0);
    beamImpact(tx, ty, tz, 0, 1);
    halo(tmpV.x, tmpV.y, tmpV.z, 0.8, 0.4, 0.9, 1, 0.14);
    decal(tx, tz, 0.32, 8);   // v0.7: Ruß-/Brennfleck am Ziel
    if (src) nst(src.id).v5T = fx.time;
  }
  function lightningShot(e, src, tx, ty, tz) {
    var B = freeBolt(), ch = e.chain, j, px = tx, pz = tz;
    B.kind = 1; B.nn = 2; B.t0 = fx.time; B.life = 0.26; B.ns2 = 0; B.jit = -1; B.on = true;
    B.nx[0] = tmpV.x; B.ny[0] = tmpV.y; B.nz[0] = tmpV.z; B.nx[1] = tx; B.ny[1] = ty; B.nz[1] = tz;
    if (ch) for (j = 0; j < ch.length && B.nn < 5; j++) {
      var cx = ch[j].x / TILE, cz = ch[j].y / TILE;
      if (Math.abs(cx - px) + Math.abs(cz - pz) < 0.3) continue;      // doppelter Eintrag (Hauptziel)
      B.nx[B.nn] = cx; B.ny[B.nn] = groundAt(cx, cz) + 0.3; B.nz[B.nn] = cz; B.nn++; px = cx; pz = cz;
    }
    emit(0, tmpV.x, tmpV.y, tmpV.z, 0, 0.05, 0, 0.14, 0.7, 0.2, 0.55, 0.7, 1, 1, 0.2, 0.3, 1, 0);
    for (j = 1; j < B.nn; j++) { beamImpact(B.nx[j], B.ny[j], B.nz[j], 1, j === 1 ? 1 : 0.8); decal(B.nx[j], B.nz[j], 0.3, 8); if (j > 1) arcSpark(B.nx[j], B.ny[j] + 0.35, B.nz[j] - 0.1, B.nx[j] + 0.25, B.ny[j], B.nz[j] + 0.12); }   // v0.7: Kettensprung + Brandflecken
    arcSpark(tmpV.x, tmpV.y, tmpV.z, tmpV.x + 0.22, tmpV.y + 0.12, tmpV.z - 0.1); arcSpark(tmpV.x, tmpV.y, tmpV.z, tmpV.x - 0.18, tmpV.y + 0.1, tmpV.z + 0.16);
    if (src) nst(src.id).v5T = fx.time;
  }
  /** Kurzer Funkenbogen (Leerlauf des Blitzturms). */
  function arcSpark(x0, y0, z0, x1, y1, z1) {
    var B = freeBolt();
    B.kind = 2; B.nn = 2; B.t0 = fx.time; B.life = 0.1; B.ns2 = 0; B.jit = -1; B.on = true;
    B.nx[0] = x0; B.ny[0] = y0; B.nz[0] = z0; B.nx[1] = x1; B.ny[1] = y1; B.nz[1] = z1;
  }

  // ------------------------------------------------------------------ Bodenringe, Projektile, Zusatz-Batches
  var artyFx = [];       // laufende Artillerieschläge { tx,tz, sx,sy,sz, t0, dur, color, show, ox[3], oz[3] }
  var pulses = [];       // Bodenringe (Eroberung, Reparatur, Bauhof)
  var tgtRing = null, rocketB = null, shellB = null, bombB = null, missileB = null;
  function addPulse(x, z, color, rad, dur) {
    var p = pulses.length < 12 ? null : pulses[(rnd() * 12) | 0];
    if (!p) { p = {}; pulses.push(p); }
    p.x = x; p.z = z; p.color = color; p.rad = rad; p.dur = dur; p.t0 = fx.time;
  }
  /** Lichtblitz (PointLight) bei x,y,z; dur = Abklingzeit s, k = Stärke. */
  function flashAt(x, y, z, dur, k) { flash.position.set(x, y, z); fx.flashT = Math.max(fx.flashT, dur); fx.flashK = k; }

  // ============================================================== v0.8: Luftwaffe & Marine – Flak, Bomben, Absturz/Untergang, Abwind, Kielwasser
  /** Darstellungshöhe eines Luftfahrzeugs (geglättet aus r3-models, sonst e.alt). */
  function airAlt(e) { var r = rs.get(e.id); return r && r.alt != null ? r.alt : (e.alt || 0); }
  /** Höhe (Kacheln) für einen Treffpunkt in der Luft: Ziel tid, sonst volle Flughöhe. */
  function airY(tid, tx, tz) { var t = tid ? G.Sim.get(tid) : null; return groundAt(tx, tz) + (t && t.mc === 2 ? airAlt(t) : 1) * D.AIR_H + 0.15; }
  /** Fliegendes Luftfahrzeug nahe (px, py) (Weltpixel, Radius rad) – für Trefferereignisse ohne Ziel-ID. */
  function airAt(px, py, rad) {
    var E = G.Sim.S.ents, i, e, dx, dy, best = null, bd = rad * rad;
    for (i = 0; i < E.length; i++) { e = E[i]; if (e.kind !== 'unit' || e.dead || e.mc !== 2 || !(e.alt > 0.5)) continue; dx = e.x - px; dy = e.y - py; if (dx * dx + dy * dy < bd) { bd = dx * dx + dy * dy; best = e; } }
    return best;
  }
  /** Flak-Sprengwolke in der Luft: Blitz, schwarzer Rauch, Splitter (alle Stufen; Lite: Lichthof statt Bloom). */
  function flakBurst(x, y, z, k) {
    var i, a, n;
    if (spTier) {
      glw(x, y, z, 0.45 * k, 0.95 * k, 1, 0.72, 0.32, 0.09, 0.9); star(x, y, z, 0.4 * k, 0.75 * k, 1, 0.85, 0.5, 0.06);
      if (spTier === 1 || !R.post) glw(x, y, z, 1.0 * k, 1.5 * k, 1, 0.55, 0.2, 0.14, 0.32);
      n = Math.max(2, Math.round(4 * spQ * Math.min(1.5, k)));
      for (i = 0; i < n; i++) { a = rnd() * 6.283; puff(x + Math.cos(a) * 0.08, y + (rnd() - 0.5) * 0.1, z + Math.sin(a) * 0.08, Math.cos(a) * 0.45 * k, 0.12 + rnd() * 0.2, Math.sin(a) * 0.45 * k, 1.5 + rnd() * 0.9, 0.2 * k, 0.75 * k, 0.05, 0.82, 0.3); }
      n = Math.max(2, Math.round(5 * spQ));
      for (i = 0; i < n; i++) { a = rnd() * 6.283; var sp = 1 + rnd() * 2; spk(x, y, z, Math.cos(a) * sp, (rnd() - 0.3) * 2.2, Math.sin(a) * sp, 0.22 + rnd() * 0.15, 0.05, 1, 0.8, 0.4, -6, 0); }
    } else {
      emit(0, x, y, z, 0, 0, 0, 0.12, 0.5 * k, 0.2, 1, 0.85, 0.5, 1, 1, 0.5, 0.1, 0);
      for (i = 0; i < 3; i++) emit(1, x, y, z, (rnd() - 0.5) * 0.6, 0.1, (rnd() - 0.5) * 0.6, 1.3, 0.2 * k, 0.6 * k, 0.14, 0.14, 0.14, 0.85, 0.28, 0.28, 0.28, 0, 0, 0.5);
    }
  }
  /** Explosion in der Luft (Abschuss): Sprengwolke + Feuerbälle + Lichtblitz. */
  function airBoom(x, y, z, k) {
    var i, a, n;
    if (spTier) {
      n = Math.max(2, Math.round(5 * spQ));
      for (i = 0; i < n; i++) { a = rnd() * 6.283; fbl(x, y, z, Math.cos(a) * 0.7, 0.1 + rnd() * 0.5, Math.sin(a) * 0.7, 0.4 + rnd() * 0.3, 0.3 * k, 0.8 * k, 0.75); }
      for (i = 0; i < n; i++) { a = rnd() * 6.283; puff(x, y, z, Math.cos(a) * 0.5, 0.2 + rnd() * 0.3, Math.sin(a) * 0.5, 1.8 + rnd(), 0.3 * k, 1.0 * k, 0.07, 0.8, 0.5); }
      for (i = 0; i < n + 2; i++) { a = rnd() * 6.283; var sp = 1 + rnd() * 2.5; spk(x, y, z, Math.cos(a) * sp, (rnd() - 0.2) * 3, Math.sin(a) * sp, 0.4 + rnd() * 0.3, 0.06, 1, 0.75, 0.35, -8, 0.1); }
      if (!R.post) glw(x, y, z, 1.0 * k, 1.6 * k, 1, 0.55, 0.2, 0.18, 0.35);
    } else { flakBurst(x, y, z, k); emit(0, x, y, z, 0, 0.2, 0, 0.3, 0.9 * k, 0.3, 1, 0.7, 0.3, 1, 1, 0.3, 0.05, 0); }
    flashAt(x, y, z, 0.14, 1.1);
  }
  /** Wasserfontäne (Bombe/Granate ins Wasser, Absturz). */
  function splash(x, z, k) {
    var WL = M3.WL, i, a, sp, n = Math.round((spTier ? 9 * spQ : 6) * k) + 2;
    for (i = 0; i < n; i++) { a = rnd() * 6.283; sp = rnd() * 0.5 * k; puff(x + Math.cos(a) * 0.1, WL + 0.05, z + Math.sin(a) * 0.1, Math.cos(a) * sp, (1.6 + rnd() * 2) * Math.sqrt(k), Math.sin(a) * sp, 0.9 + rnd() * 0.5, 0.18 * k, 0.75 * k, 0.92, 0.7, 0); }
    wave(0, x, z, 0.2, 1.8 * k, 0.8, 0.45, 0.5, 0.55);
  }
  /** Bombeneinschlag (Teppich: je Bombe ein hit {w:'bomb'}). */
  function bombHit(x, z) {
    var gy = groundAt(x, z);
    if (T3.heightAt(x, z) < -0.09) { splash(x, z, 1.4); flashAt(x, M3.WL + 0.4, z, 0.1, 1); addShake(0.06, 0.3); return; }
    explosion(x, gy + 0.15, z, 1.3, true);
    dust(x, gy, z, 1.4);
    if (spTier) { burn(x, z, 6 + rnd() * 4, 0.8, 1); wave(0, x, z, 0.3, 2.6, 0.55, 0.55, 0.45, 0.3); }
    decal(x, z, 1.5, 45);
    addShake(0.11, 0.35);
  }
  /** Tod eines Luftfahrzeugs (in der Luft → Absturz-Wrack) bzw. Schiffs (→ sinkendes Wrack). true = erledigt. */
  function v8Die(e, x, z, g2, Pd) {
    var ud = D.UNITS[e.type], r = rs.get(e.id), i;
    if (!ud || (ud.cat !== 'air' && ud.cat !== 'naval')) return false;
    if (ud.cat === 'air') {
      var al = r && r.alt != null ? r.alt : 0;
      if (al < 0.08) return false;                                     // am Boden: normale Explosion + Wrack
      var ay = g2 + al * D.AIR_H + 0.2;
      airBoom(x, ay, z, 1.3);
      M3.addWreck({ kind: 'crash', type: e.type, owner: e.owner, fac: Pd.faction, color: Pd.color, x: x, z: z, y: ay - 0.2, vx: r ? r.vx * 0.85 : 0, vz: r ? r.vz * 0.85 : 0, vy: 0.5,
        dir: r ? r.dir : 0, pit: 0, roll: 0, spin: ud.bomber ? 0.15 : (rnd() < 0.5 ? -1 : 1) * (2.5 + rnd() * 2), rs: ud.bomber ? (rnd() < 0.5 ? -1 : 1) * 0.7 : (rnd() - 0.5) * 0.8, t0: fx.time, life: 8 });
      return true;
    }
    var tcd = teamRGB(Pd.color); UNIT_DEB[0] = 0.08 + tcd[0] * 0.35; UNIT_DEB[1] = 0.08 + tcd[1] * 0.35; UNIT_DEB[2] = 0.08 + tcd[2] * 0.35;
    explosion(x, M3.WL + 0.25, z, 1.05, true, UNIT_DEB);
    splash(x, z, 1.1);
    for (i = 0; i < 2; i++) wake(x + (rnd() - 0.5) * 0.6, z + (rnd() - 0.5) * 0.6, rnd() * 6.28, 0, 0.5, 1);
    M3.addWreck({ kind: 'sink', type: e.type, owner: e.owner, fac: Pd.faction, color: Pd.color, x: x, z: z, dir: r ? r.dir : 0, tdir: r ? r.tdir : 0, t0: fx.time, life: 5.5,
      side: rnd() < 0.5 ? -1 : 1, side2: rnd() < 0.5 ? -1 : 1 });
    return true;
  }
  /** takeoff/land (Abwind), beach/load/unload (Landungsboot: Bugklappe + Gischt; Hubschrauber: Abwind), rearm (Bomber geladen). */
  function v8Evt(e, S, x, z) {
    var u = G.Sim.get(e.id), i, a, WL = M3.WL;
    if (!u || u.dead || !(S.settings.fogOff || u.owner === V.pid || G.Sim.isVisible(V.pid, u))) return;
    var ux = u.x / TILE, uz = u.y / TILE, r = rs.get(u.id), wat = T3.heightAt(ux, uz) < -0.09, gy = groundAt(ux, uz);
    if (e.t === 'rearm') { addPulse(ux, uz, '#4ade80', 0.9, 0.7); return; }
    if (u.mc === 3) {
      if (r) r.rampT = fx.time;
      var d = r ? r.dir : (u.dir || 0), bx = ux + Math.cos(d) * 0.62, bz = uz + Math.sin(d) * 0.62;
      for (i = 0; i < 5; i++) { a = d + (rnd() - 0.5) * 2; puff(bx, WL + 0.05, bz, Math.cos(a) * 0.8, 0.5 + rnd() * 0.6, Math.sin(a) * 0.8, 0.8, 0.1, 0.45, 0.92, 0.6, 0); }
      if (e.t !== 'load') { dust(bx + Math.cos(d) * 0.35, groundAt(bx + Math.cos(d) * 0.35, bz + Math.sin(d) * 0.35), bz + Math.sin(d) * 0.35, 0.55); wave(0, bx, bz, 0.2, 1.1, 0.7, 0.4, 0.45, 0.5); }
      return;
    }
    if (u.mc !== 2) return;
    var heli = !D.UNITS[u.type].bomber, k = heli ? 1 : 0.6;
    if (e.t === 'load' && rnd() < 0.6) return;
    if (wat) for (i = 0; i < 8; i++) { a = i / 8 * 6.283; puff(ux + Math.cos(a) * 0.3, WL + 0.04, uz + Math.sin(a) * 0.3, Math.cos(a) * 1.8 * k, 0.3, Math.sin(a) * 1.8 * k, 0.9, 0.12, 0.6, 0.92, 0.55, 0); }
    else { dust(ux, gy, uz, 0.9 * k); for (i = 0; i < 6; i++) { a = i / 6 * 6.283 + rnd() * 0.5; puff(ux + Math.cos(a) * 0.35, gy + 0.05, uz + Math.sin(a) * 0.35, Math.cos(a) * 1.8 * k, 0.15, Math.sin(a) * 1.8 * k, 0.9, 0.15, 0.7, 0.55, 0.45, 0); } }
    wave(0, ux, uz, 0.2, 1.4 * k, 0.6, 0.3, 0.28, 0.24);
  }
  // --- Kielwasser/Bugwelle: flache, additive Schaumflecken auf dem Wasser (Pool fester Größe, eine Instanz-Batch, keine Allokation je Frame)
  var WK = null;
  function initWake() {
    var N = 240, pg = new THREE.PlaneGeometry(1, 1), F = Float32Array; pg.rotateX(-Math.PI / 2); pg.deleteAttribute('normal');
    var mat = new THREE.MeshBasicMaterial({ map: blobTex([[0, 0.9], [0.35, 0.55], [0.7, 0.18], [1, 0]]), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    WK = { bt: new Batch(pg, mat, N, false), N: N, n: 0, head: 0, on: new Uint8Array(N), x: new F(N), z: new F(N), vx: new F(N), vz: new F(N), a: new F(N), t0: new F(N), life: new F(N), s0: new F(N), s1: new F(N), el: new F(N), b: new F(N) };
    WK.bt.mesh.renderOrder = 3.4; dynRoot.add(WK.bt.mesh);
  }
  /** Schaumfleck: kind 1 = Bugwelle (zwei schräg nach außen laufende, gestreckte Flecken), 0 = Heckschaum. Flag tracks (K) aus → nur Gischt-Partikel. */
  function wake(x, z, ang, kind, size, k) {
    var F = R.F || {}, i, j, c = Math.cos(ang), sn = Math.sin(ang), cap = safeGPU ? 150 : WK.N;
    if (kind === 1 && spTier && rnd() < 0.5 * spQ * k) puff(x, M3.WL + 0.06, z, -c * 0.3 + (rnd() - 0.5) * 0.6, 0.35 + rnd() * 0.3, -sn * 0.3 + (rnd() - 0.5) * 0.6, 0.6, 0.06, 0.28, 0.95, 0.55, 0);
    if (F.tracks === false || !WK) return;
    if (R.mark && !WK.used) { WK.used = true; R.mark('tracks'); }
    for (j = 0; j < (kind === 1 ? 2 : 1); j++) {
      i = WK.head; WK.head = (WK.head + 1) % cap; WK.on[i] = 1;
      var sd = j ? 1 : -1;
      if (kind === 1) {   // Bugwelle: seitlich nach außen/hinten laufend
        WK.x[i] = x - sn * sd * size * 0.4; WK.z[i] = z + c * sd * size * 0.4;
        WK.vx[i] = (-sn * sd * 0.55 - c * 0.25) * k; WK.vz[i] = (c * sd * 0.55 - sn * 0.25) * k;
        WK.a[i] = ang + sd * 0.55; WK.s0[i] = size * 0.9; WK.s1[i] = size * 2.6; WK.el[i] = 0.35; WK.life[i] = 1.3; WK.b[i] = 0.34 * Math.min(1, k);
      } else {            // Heckschaum: breiter werdend, langsam verblassend
        WK.x[i] = x + (rnd() - 0.5) * size * 0.3; WK.z[i] = z + (rnd() - 0.5) * size * 0.3;
        WK.vx[i] = -c * 0.15 * k; WK.vz[i] = -sn * 0.15 * k;
        WK.a[i] = ang; WK.s0[i] = size * 1.4; WK.s1[i] = size * 3.4; WK.el[i] = 0.7; WK.life[i] = 2.3; WK.b[i] = 0.3 * Math.min(1, k);
      }
      WK.t0[i] = fx.time;
    }
    if (WK.n < cap) WK.n = Math.min(cap, Math.max(WK.n, WK.head === 0 ? cap : WK.head));
  }
  function updWake(dt) {
    if (!WK) return;
    var i, f, s, c, y = M3.WL + 0.012, bt = WK.bt;
    for (i = 0; i < WK.n; i++) {
      if (!WK.on[i]) continue;
      f = (fx.time - WK.t0[i]) / WK.life[i];
      if (f >= 1 || f < 0) { WK.on[i] = 0; continue; }
      WK.x[i] += WK.vx[i] * dt; WK.z[i] += WK.vz[i] * dt;
      s = WK.s0[i] + (WK.s1[i] - WK.s0[i]) * Math.sqrt(f); c = WK.b[i] * (1 - f) * (1 - f) * Math.min(1, f * 8);
      if (!R.inView(WK.x[i], WK.z[i])) continue;
      bt.put(WK.x[i], y, WK.z[i], WK.a[i], s, 1, s * WK.el[i], c, c, c * 1.04);
    }
  }
  function init() {
    initFx(); initSprites();
    var MB = M3.MB;
    var rk = new MB('unit');
    rk.cylX('#c8ccd0', 0.025, 0.025, 0.2, 5, 0, 0, 0).add(new THREE.ConeGeometry(0.025, 0.06, 5), '#dc2626', 0.13, 0, 0, 0, 0, -Math.PI / 2).box('#555', 0.05, 0.06, 0.01, -0.08, -0.03, 0);
    rocketB = new Batch(rk.geo(false), MAT.std, 16, false); dynRoot.add(rocketB.mesh);
    var bm = new MB('unit');   // v0.8: Fliegerbombe (Spitze +x)
    bm.add(new THREE.CylinderGeometry(0.035, 0.035, 0.16, 6, 1, true), '#3a3f45', 0, 0, 0, 0, 0, -Math.PI / 2).add(new THREE.ConeGeometry(0.035, 0.08, 6, 1, true), '#3a3f45', 0.12, 0, 0, 0, 0, -Math.PI / 2);
    bm.add(new THREE.ConeGeometry(0.035, 0.06, 6, 1, true), '#3a3f45', -0.11, 0, 0, 0, 0, Math.PI / 2).add(new THREE.BoxGeometry(0.05, 0.09, 0.006), '#2a2d31', -0.13, 0, 0).add(new THREE.BoxGeometry(0.05, 0.006, 0.09), '#2a2d31', -0.13, 0, 0);
    bombB = new Batch(bm.geo(false), MAT.std, 16, false); dynRoot.add(bombB.mesh);
    var mm = new MB('unit');   // v0.9: Schlachtschiff-Rakete (Spitze +x), Ursprung = Mitte
    mm.cylX('#e3e5e8', 0.034, 0.034, 0.3, 8, 0, 0, 0).add(new THREE.ConeGeometry(0.034, 0.1, 8), '#30363d', 0.2, 0, 0, 0, 0, -Math.PI / 2).cylX('#30363d', 0.026, 0.03, 0.04, 8, -0.17, 0, 0);
    mm.add(new THREE.BoxGeometry(0.06, 0.1, 0.006), '#b8322a', -0.12, 0, 0).add(new THREE.BoxGeometry(0.06, 0.006, 0.1), '#b8322a', -0.12, 0, 0).add(new THREE.BoxGeometry(0.03, 0.006, 0.07), '#30363d', 0.08, 0, 0);
    missileB = new Batch(mm.geo(false), MAT.std, 16, false); dynRoot.add(missileB.mesh);
    initWake();
    shellB = new Batch(new THREE.SphereGeometry(0.045, 6, 4), MAT.glow, 16, false); dynRoot.add(shellB.mesh);
    var tg = new THREE.RingGeometry(0.93, 1, 40); tg.rotateX(-Math.PI / 2);
    tgtRing = new Batch(tg, MAT.marker, 32, false); tgtRing.mesh.renderOrder = 3; dynRoot.add(tgtRing.mesh);
    initSwFx();
    initBeams();
  }
  function reset() {
    artyFx.length = 0; pulses.length = 0; flames.length = 0; heals.length = 0;
    if (BM) for (var bi = 0; bi < BM.bolts.length; bi++) BM.bolts[bi].on = false;
    for (var swi = 0; swi < sws.length; swi++) sws[swi].on = false;
    shk.a0 = 0;
    for (var p = 0; p < 2; p++) fx.pools[p].n = 0;
    fx.tr.n = 0; resetV06();
    if (WK) { WK.n = 0; WK.head = 0; WK.on.fill(0); }
    lastSeq = G.Sim.S.evSeq;
  }
  function fill(S, alpha, dt) {
    var fogOff = S.settings.fogOff, i, x, z, y;
    safeGPU = R.safeGPU; syncTier();
    // --- Projektile
    for (i = 0; i < S.proj.length; i++) {
      var p = S.proj[i];
      if (!fogOff && !visibleAt(p.x, p.y)) continue;
      var fr = clamp((p.t + alpha) / p.dur, 0, 1);
      x = (p.x0 + (p.tx - p.x0) * fr) / TILE; z = (p.y0 + (p.ty - p.y0) * fr) / TILE;
      var psrc = (p.w === 'cannon' || p.air || p.bomb || p.w === 'rocket') ? G.Sim.get(p.src) : null, lob = psrc && psrc.type === 'howitzer';
      var arc = p.w === 'rocket' ? (p.salvo != null ? 0.75 + 0.13 * Math.hypot(p.tx - p.x0, p.ty - p.y0) / TILE : 0.55) : (lob ? 0.5 + 0.16 * Math.hypot(p.tx - p.x0, p.ty - p.y0) / TILE : 0.12);
      var ang = Math.atan2(p.ty - p.y0, p.tx - p.x0), y0p = 0.35, y1p = groundAt(x, z) + 0.2;   // v0.8: Start in Flughöhe/Deckshöhe, Ziel in der Luft
      if (psrc && psrc.mc === 2) { y0p = groundAt(p.x0 / TILE, p.y0 / TILE) + airAlt(psrc) * D.AIR_H; arc = p.air ? 0.1 : 0.06; }
      else if (psrc && psrc.mc === 3) y0p = M3.WL + 0.3;
      if (p.missile) { missileProj(p, fr, x, z, dt); continue; }   // v0.9 Schlachtschiff-Rakete: hoher ballistischer Bogen + Rauchspur
      if (p.bomb) {   // Bombe fällt aus Flughöhe (beschleunigt), Spitze neigt sich nach unten
        y0p = groundAt(p.x0 / TILE, p.y0 / TILE) + (psrc && psrc.mc === 2 ? airAlt(psrc) : 1) * D.AIR_H - 0.05;
        y = y0p + (Math.max(y1p - 0.2, M3.WL) - y0p) * fr * fr;
        bombB.putP(x, y, z, ang, -0.15 - fr * 1.2, 1, 1, 1);
        continue;
      }
      if (p.air) { y1p = airY(p.tid, p.tx / TILE, p.ty / TILE) - 0.1; arc = p.w === 'rocket' && p.salvo != null ? 0.5 : 0.12; }
      y = y0p + (y1p - y0p) * fr + arc * 4 * fr * (1 - fr);
      if (p.air && p.w === 'rocket') {   // Flugabwehrrakete steigt: nickt entlang der Bahn, Rauchspur
        var dha = Math.hypot(p.tx - p.x0, p.ty - p.y0) / TILE + 1e-4;
        rocketB.putP(x, y, z, ang, Math.atan2((y1p - y0p) + arc * 4 * (1 - 2 * fr), dha), 1, 1, 1);
        if (spTier) { if (rnd() < dt * 60 * spQ) puff(x, y, z, (rnd() - 0.5) * 0.08, 0.04, (rnd() - 0.5) * 0.08, 1.2 + rnd() * 0.6, 0.08, 0.45, 0.65, 0.45, 0); glw(x - Math.cos(ang) * 0.1, y, z - Math.sin(ang) * 0.1, 0.3, 0.14, 1, 0.65, 0.25, 0.05, 0.9); }
        else emit(1, x, y, z, 0, 0.05, 0, 0.8, 0.07, 0.3, 0.85, 0.85, 0.85, 0.6, 0.7, 0.7, 0.7, 0, 0, 1);
        continue;
      }
      if (p.w === 'rocket') {
        if (p.salvo != null) {   // v0.7 MLRS: Rakete nickt entlang der Flugbahn
          var dh = Math.hypot(p.tx - p.x0, p.ty - p.y0) / TILE + 1e-4, dyf = (groundAt(p.tx / TILE, p.ty / TILE) + 0.2 - 0.35) + arc * 4 * (1 - 2 * fr);
          rocketB.putP(x, y, z, ang, Math.atan2(dyf, dh), 1, 1, 1);
          if (spTier && rnd() < dt * 50 * spQ) puff(x, y, z, (rnd() - 0.5) * 0.08, 0.05, (rnd() - 0.5) * 0.08, 1.5 + rnd() * 0.6, 0.1, 0.5, 0.6, 0.45, 0);
        } else
        rocketB.put(x, y, z, ang, 1, 1, 1, 1, 1, 1);
        if (spTier) {
          if (rnd() < dt * 40 * spQ) puff(x, y, z, (rnd() - 0.5) * 0.1, 0.1, (rnd() - 0.5) * 0.1, 0.9 + rnd() * 0.5, 0.12, 0.55, 0.45, 0.5, 0);
          glw(x - Math.cos(ang) * 0.1, y, z - Math.sin(ang) * 0.1, 0.34, 0.16, 1, 0.65, 0.25, 0.05, 0.9);
          spn(0, 10, 0, x - Math.cos(ang) * 0.13, y, z - Math.sin(ang) * 0.13, 0, 0, 0, 0.05, 0.16, 0.06, 0, 0, 1.2 * GN, 0.9 * GN, 0.5 * GN, 1, 1 * GN, 0.4 * GN, 0.1 * GN, 0, 0, 0, 0, 0);
        } else {
        emit(1, x, y, z, (rnd() - 0.5) * 0.1, 0.1, (rnd() - 0.5) * 0.1, 0.8 + rnd() * 0.4, 0.07, 0.3, 0.85, 0.85, 0.85, 0.6, 0.7, 0.7, 0.7, 0, 0, 1);
        emit(0, x - Math.cos(ang) * 0.12, y, z - Math.sin(ang) * 0.12, 0, 0, 0, 0.06, 0.16, 0.06, 1, 0.75, 0.35, 1, 1, 0.4, 0.1, 0); }
      } else {
        shellB.put(x, y, z, ang, lob ? 2.2 : 1.4, lob ? 1.5 : 1, lob ? 1.5 : 1, 1, 1, 1);
        if (spTier) { glw(x, y, z, lob ? 0.3 : 0.22, 0.1, 1, 0.78, 0.38, 0.06, 0.85); if (lob && rnd() < dt * 30 * spQ) puff(x, y, z, 0, 0.05, 0, 1.0, 0.1, 0.45, 0.4, 0.4, 0); }
        else { emit(0, x, y, z, 0, 0, 0, 0.08, lob ? 0.18 : 0.12, 0.03, 1, 0.8, 0.4, 0.7, 1, 0.5, 0.1, 0);
        if (lob && rnd() < dt * 30) emit(1, x, y, z, 0, 0.05, 0, 0.9, 0.1, 0.4, 0.8, 0.8, 0.8, 0.4, 0.7, 0.7, 0.7, 0, 0, 1); }
      }
    }
    // --- Artillerieschlag: Zielmarker (Teamfarbe) + Granaten im Flug
    for (i = artyFx.length - 1; i >= 0; i--) {
      var af = artyFx[i], aa = R.t - af.t0;
      if (aa > af.dur + 0.4) { artyFx.splice(i, 1); continue; }
      if (!af.show && !af.own) continue;
      var ac = teamRGB(af.color), afr = Math.min(1, aa / af.dur), afa = aa > af.dur ? 1 - (aa - af.dur) / 0.4 : 1;
      var apu = (0.7 + 0.3 * Math.sin(R.t * 16)) * afa * 1.4, agy = groundAt(af.tx, af.tz) + 0.07;
      tgtRing.put(af.tx, agy, af.tz, 0, 2.0, 1, 2.0, ac[0] * apu + 0.1 * afa, ac[1] * apu + 0.1 * afa, ac[2] * apu + 0.1 * afa);
      tgtRing.put(af.tx, agy, af.tz, 0, 2.0 - 1.7 * afr, 1, 2.0 - 1.7 * afr, ac[0] * afa * 1.5, ac[1] * afa * 1.5, ac[2] * afa * 1.5);
      tgtRing.put(af.tx, agy, af.tz, 0, 0.22, 1, 0.22, ac[0] * apu, ac[1] * apu, ac[2] * apu);
      if (aa < af.dur) for (var sk = 0; sk < 3; sk++) {
        var shx = af.sx + (af.tx + af.ox[sk] - af.sx) * afr, shz = af.sz + (af.tz + af.oz[sk] - af.sz) * afr;
        var shy = af.sy + (0.2 - af.sy) * afr * afr + (5 + 0.2 * Math.hypot(af.tx - af.sx, af.tz - af.sz)) * 4 * afr * (1 - afr);
        shellB.put(shx, shy, shz, Math.atan2(af.tz - af.sz, af.tx - af.sx), 2.4, 1.8, 1.8, 1, 1, 1);
        if (rnd() < dt * 40) puff(shx, shy, shz, (rnd() - 0.5) * 0.1, 0.05, (rnd() - 0.5) * 0.1, 0.9, 0.12, 0.45, 0.4, 0.4, 0);
        if (spTier) glw(shx, shy, shz, 0.3, 0.12, 1, 0.8, 0.4, 0.06, 0.8);
      }
    }
    // --- Bodenringe (Eroberung)
    for (i = pulses.length - 1; i >= 0; i--) {
      var pu2 = pulses[i], pf = (R.t - pu2.t0) / pu2.dur;
      if (pf >= 1) { pulses.splice(i, 1); continue; }
      var pc = teamRGB(pu2.color), pk = (1 - pf) * 1.6, pr = pu2.rad * (0.3 + 0.7 * Math.sqrt(pf));
      tgtRing.put(pu2.x, 0.07, pu2.z, 0, pr, 1, pr, pc[0] * pk, pc[1] * pk, pc[2] * pk);
    }
    ambient(S, dt); updBurns(dt); updWaves(); updDebris(dt); flameUpdate(dt); updWake(dt);
    swFrame(S, alpha, dt);
  }
  function flush() {
    DB.bat.flush(); wvRing.flush(); wvGlow.flush();
    for (var i = 0; i < swFlush.length; i++) swFlush[i].flush();
    rocketB.flush(); shellB.flush(); tgtRing.flush(); bombB.flush(); missileB.flush(); if (WK) WK.bt.flush();
  }
  G.R3F = {
    link: link, init: init, reset: reset,
    emit: emit, halo: halo, sparkle: sparkle, explosion: explosion, dust: dust, tracer: tracer, beamImpact: beamImpact, arcSpark: arcSpark,
    addPulse: addPulse, flashAt: flashAt, impact: impact, puff: puff, burn: burn, wave: wave, chunk: chunk, tier: function () { return spTier; }, laserShot: laserShot, lightningShot: lightningShot,
    consumeEvents: function (S) { safeGPU = R.safeGPU; syncTier(); consumeEvents(S); },
    fill: fill, flush: flush,
    update: function (dt) { updateFx(dt); updateBeams(); },
    wake: wake, flakBurst: flakBurst, splash: splash, airBoom: airBoom,   // v0.8
    overlay: swOverlay,
    shakeUpdate: shakeUpdate, shakeOffset: function () { return shk.off; }, setShake: setShake, getShake: function () { return shakeOn; }, addShake: addShake,
    setMax: function (n) { if (fx) fx.max = n; }, setPointScale: function (v) { if (fx) fx.uScale.value = v; }, setMaxPoint: function (v) { if (fx) fx.uMaxPt.value = v; },
    particleCount: function () { return fx ? fx.pools[0].n + fx.pools[1].n : 0; },
    _counts: function () { var wv = 0, bn = 0, i; for (i = 0; i < waves.length; i++) if (waves[i].on) wv++; for (i = 0; i < burns.length; i++) if (burns[i].on) bn++;
      return { pts: fx ? fx.pools[0].n + fx.pools[1].n : 0, spr: SP ? SP.pools[0].n + SP.pools[1].n : 0, deb: DB ? DB.n : 0, waves: wv, burns: bn, tracers: fx ? fx.tr.n : 0, acc: accMap.size, rs: rs.size, wrecks: M3._wreckCount ? M3._wreckCount() : -1, tier: spTier }; },
    time: function () { return fx ? fx.time : 0; },
    // Thema/Wetter/Tageszeit (r3-mood.js): Rauch/Staub (normale Pools) in Stimmungsfarbe tönen, additive Pools × glow (Nacht: Feuer leuchtet heraus)
    moodTint: function (r, g, b, glow) {
      if (fx) { fx.pools[1].pts.material.uniforms.uTint.value.set(r, g, b); fx.pools[0].pts.material.uniforms.uTint.value.setScalar(glow || 1); }
      if (SP) { SP.pools[1].mat.color.setRGB(r, g, b); SP.pools[0].mat.color.setScalar(glow || 1); }
    },
    debug: function () { return { heals: heals.map(function (h) { return [h.on, +(fx.time - h.t0).toFixed(2), h.x, h.y, h.z]; }), flames: flames.length, bolts: BM ? BM.n : -1, t: fx.time, q: BM ? Array.prototype.slice.call(BM.pos, Math.max(0, BM.n - 2) * 12, BM.n * 12).map(function (v) { return +v.toFixed(2); }).concat(Array.prototype.slice.call(BM.col, Math.max(0, BM.n - 1) * 12, BM.n * 12).map(function (v) { return +v.toFixed(2); })) : null, vdir: R.VDIR && [R.VDIR.x, R.VDIR.y, R.VDIR.z] }; }
  };
})();
