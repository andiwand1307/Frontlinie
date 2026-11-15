/* FRONTLINIE – src/r3-shadow.js  (W11-look: Schatten-Ersatz ohne Schattenkarte, G.R3S)
 *
 * Wenn Modern-Materialien laufen, die echte Schattenkarte aber aus ist (PowerVR-Startprofil, Flag shadows/S aus), zeichnet dieses Modul
 * weiche Boden-Schatten: je Einheit / Gebäude / Baum / Fels EIN Quad (Instanz), dessen Fragment-Shader die Grundfläche des Objekts entlang
 * der Sonnenrichtung „verschmiert“ (Minkowski-Summe Grundfläche + Schattenstrecke, 6 Abtastungen, Halbschatten wächst mit der Entfernung).
 * Dazu ein schmaler Kontaktschatten rund um die Grundfläche (Ersatz für die fehlende Umgebungsverdeckung/AO).
 *
 * Stabilität (PowerVR): keine Render-Targets, keine Schattenkarte, keine Texturen. Eine Geometrie (4 Ecken), ein ShaderMaterial,
 * zwei Instanz-Batches (G.R3M.Batch) mit fester Startkapazität: statisch (Bäume, Felsen, Deko – einmal je Karte gefüllt und
 * hochgeladen) und dynamisch (Einheiten + Gebäude – Teil-Upload über n wie alle anderen Batches, R.F.fixedBuf).
 * Flag: liteLook (Code F). Aus → nichts (wie vorher). Mit Schattenkarte (Flag S an) → nichts (echte Schatten).
 *
 * Instanz-Kodierung (Batch.put): Position = Mitte der Grundfläche am Boden, Drehung = Objektdrehung, Skalierung x/z = Grundfläche
 * (volle Breite/Tiefe in Kacheln), Skalierung y = Höhe (Länge der Schattenstrecke); Instanzfarbe r = Deckkraft, g = Weichheit (Kacheln),
 * b = Rundung (0 Kasten … 1 Ellipse).
 */
(function () {
  'use strict';
  var G = window.G = window.G || {};
  var R = G.R3, THREE = R && R.THREE;
  if (!R || !THREE) return;
  var M3 = null, T3 = null, D = G.DATA, TILE = D.TILE;

  var mat = null, geo = null, dyn = null, stat = null, root = null, worldRef = null, used = false;
  var sd = null, tmpV = null, tmpQ = null, tmpS = null, tmpM = null;
  var LOOK = { unitA: 0.58, bldA: 0.66, treeA: 0.5, rockA: 0.45, soft: 0.16, col: [0.035, 0.05, 0.08] };   // abgestimmt per Vergleich mit Modern (tests/look-w11.js)

  function link() { M3 = G.R3M; T3 = G.R3T; }
  /** aktiv: Modern-Materialien + Flag liteLook + keine echte Schattenkarte */
  function wanted() { var F = R.F || {}; return !!(R.std && F.liteLook && !(R.Q && R.Q.shadows)); }
  /** v0.8: Luftfahrzeuge brauchen IMMER einen Bodenschatten (sonst fehlt jeder Höhenbezug) – ohne Schattenkarte auch ohne Flag F (M-U, Sparmodus). */
  function airWanted() { return !!(R.SH && !(R.Q && R.Q.shadows)); }

  function makeMat() {
    var SH = R.SH;
    return new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, depthTest: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
      uniforms: { uSd: { value: sd }, uCol: { value: new THREE.Vector3().fromArray(LOOK.col) }, uFow: SH.uFow, uFowScale: SH.uFowScale, uFowOn: SH.uFowOn },
      vertexShader: [
        'uniform vec2 uSd;',
        'varying vec2 vRel; varying vec2 vAx; varying vec2 vHs; varying vec2 vL; varying vec3 vPar; varying vec2 vW;',
        'void main(){',
        '  mat4 im = instanceMatrix;',
        '  vec3 ctr = im[3].xyz; vec2 ax = im[0].xz, az = im[2].xz;',
        '  float sx = max(length(ax), 1e-4), sz = max(length(az), 1e-4), h = length(im[1].xyz);',
        '  vec2 axn = ax / sx, azn = az / sz, hs = vec2(sx, sz) * 0.5;',
        '  vec2 e = abs(axn) * hs.x + abs(azn) * hs.y;',
        '  vec3 par = vec3(1.0, 0.15, 0.0);',
        '#ifdef USE_INSTANCING_COLOR',
        '  par = instanceColor;',
        '#endif',
        '  vec2 L = uSd * h, m = vec2(par.y * 2.0 + 0.02);',
        '  vec2 mn = min(vec2(0.0), L) - e - m, mx = max(vec2(0.0), L) + e + m;',
        '  vec2 wp = ctr.xz + mix(mn, mx, position.xz + 0.5);',
        '  vRel = wp - ctr.xz; vAx = axn; vHs = hs; vL = L; vPar = par; vW = wp;',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(wp.x, ctr.y, wp.y, 1.0);',
        '}'].join('\n'),
      fragmentShader: [
        'uniform vec3 uCol; uniform sampler2D uFow; uniform vec2 uFowScale; uniform float uFowOn;',
        'varying vec2 vRel; varying vec2 vAx; varying vec2 vHs; varying vec2 vL; varying vec3 vPar; varying vec2 vW;',
        'float sdb(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }',
        'void main(){',
        '  vec2 azn = vec2(-vAx.y, vAx.x);',
        '  float soft = vPar.y, rr = vPar.z * min(vHs.x, vHs.y), a = 0.0;',
        '  for (int k = 0; k < 6; k++) {',
        '    float t = float(k) / 5.0;',
        '    vec2 q = vRel - vL * t;',
        '    float d = sdb(vec2(dot(q, vAx), dot(q, azn)), vHs, rr);',
        '    float sw = soft * (0.5 + 1.1 * t);',
        '    a = max(a, (1.0 - smoothstep(-sw, sw, d)) * (1.0 - 0.3 * t));',
        '  }',
        '  float c0 = sdb(vec2(dot(vRel, vAx), dot(vRel, azn)), vHs, rr);',   // Kontaktschatten: schmaler dunkler Saum um die Grundfläche
        '  a = max(a, (1.0 - smoothstep(0.0, soft * 1.6, c0)) * 1.12);',
        '  a = clamp(a * vPar.x, 0.0, 0.9);',
        '  a *= mix(1.0, texture2D(uFow, vW * uFowScale).r, uFowOn);',
        '  if (a < 0.004) discard;',
        '  gl_FragColor = vec4(uCol, a);',
        '}'].join('\n')
    });
  }

  function ensure() {
    if (!sd) { sd = new THREE.Vector2(0.91, 0.59); tmpV = new THREE.Vector3(); tmpQ = new THREE.Quaternion(); tmpS = new THREE.Vector3(); tmpM = new THREE.Matrix4(); }
    if (!geo) { geo = new THREE.PlaneGeometry(1, 1); geo.rotateX(-Math.PI / 2); geo.deleteAttribute('normal'); geo.deleteAttribute('uv'); }
    if (!mat) mat = makeMat();
    var fb = (R.F || {}).fixedBuf;
    if (!dyn) { dyn = new M3.Batch(geo, mat, fb ? 640 : 128, false); dyn.mesh.renderOrder = 1; dyn.mesh.receiveShadow = false; }
    if (root !== R.dynRoot) {    // neuer Renderer/Szene (Kontextverlust, Qualitätswechsel)
      root = R.dynRoot;
      if (dyn.mesh.parent) dyn.mesh.parent.remove(dyn.mesh);
      if (root) root.add(dyn.mesh);
      worldRef = null;
    }
  }

  // ---- Größe je Modell (einmal): Grundfläche der „Masse“ (Ecken oberhalb eines Bruchteils der Höhe), Mitte, Höhe
  var boxCache = {};
  function modelBox(key, M, cut) {
    var b = boxCache[key];
    if (b) return b;
    var x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9, y1 = 0, k, i, p, yc = (M.h || 1) * cut;
    for (k in M.parts) {
      var g = M.parts[k];
      if (!g || !g.isBufferGeometry || k === 'icon' || !(p = g.attributes.position)) continue;
      for (i = 0; i < p.count; i++) {
        var y = p.getY(i); if (y > y1) y1 = y;
        if (y < yc) continue;
        var x = p.getX(i), z = p.getZ(i);
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
    }
    if (x1 < x0) { x0 = z0 = -0.3; x1 = z1 = 0.3; }
    b = boxCache[key] = { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, w: x1 - x0, d: z1 - z0, h: Math.max(0.1, y1) };
    return b;
  }

  // ---- statische Schatten (Bäume, Felsen, Deko, Erz): einmal je Welt aus den Instanz-Meshes der Geländegruppe
  function buildStatic() {
    var w = T3.world && T3.world();
    worldRef = w;
    if (stat) { if (stat.mesh.parent) stat.mesh.parent.remove(stat.mesh); stat.mesh.dispose(); stat = null; }
    if (!w || !w.group) return;
    var list = [], n = 0;
    w.group.traverse(function (o) { if (o.isInstancedMesh && o.castShadow && o.count > 0 && o.geometry && o.geometry.attributes.position) { list.push(o); n += o.count; } });
    if (!n) return;
    stat = new M3.Batch(geo, mat, n, false); stat.mesh.renderOrder = 1; stat.mesh.receiveShadow = false;
    for (var li = 0; li < list.length; li++) {
      var o = list[li], g = o.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      var bb = g.boundingBox, gw = bb.max.x - bb.min.x, gd = bb.max.z - bb.min.z, gh = bb.max.y, gcx = (bb.min.x + bb.max.x) / 2, gcz = (bb.min.z + bb.max.z) / 2;
      if (gh < 0.06 || gw > 3 || gd > 3) continue;                  // flache Teile / große Sammel-Meshes nicht
      var tree = gh > 0.55 && gw < 1.2, rnd = tree ? 1 : 0.6, A = tree ? LOOK.treeA : LOOK.rockA, wk = tree ? 0.62 : 0.9;  // Baum: Krone schmaler als die Hülle
      for (var i = 0; i < o.count; i++) {
        o.getMatrixAt(i, tmpM); tmpM.decompose(tmpV, tmpQ, tmpS);
        var ang = -2 * Math.atan2(tmpQ.y, tmpQ.w);                       // Drehung um y (Sim-Winkel wie Batch.put)
        var c = Math.cos(-ang), s = Math.sin(-ang), ox = gcx * tmpS.x, oz = gcz * tmpS.z;
        stat.put(tmpV.x + c * ox + s * oz, tmpV.y + 0.02, tmpV.z - s * ox + c * oz, ang, gw * tmpS.x * wk, gh * tmpS.y * (tree ? 0.8 : 1), gd * tmpS.z * wk, A, LOOK.soft * (tree ? 1.3 : 0.8), rnd);
      }
    }
    stat.flush();                                                       // einmal hochladen; danach unverändert (count bleibt)
    if (root) root.add(stat.mesh);
  }

  function hide() { if (dyn) { dyn.n = 0; dyn.flush(); } if (stat) stat.mesh.visible = false; }

  /** je Frame nach M3.fill (rs-Winkel aktuell): Einheiten + Gebäude */
  function fill(S, alpha) {
    var full = wanted(), airOnly = !full && airWanted();
    if (!full && !airOnly) { hide(); return; }
    ensure();
    if (full) {
      if (worldRef !== (T3.world && T3.world()) || (stat && stat.mesh.parent !== root)) buildStatic();
      if (stat) stat.mesh.visible = stat.mesh.count > 0;
    } else if (stat) stat.mesh.visible = false;
    // Sonnenrichtung → Schattenversatz je Höhe (Boden-xz)
    var sun = R.sun;
    if (sun) {
      tmpV.copy(sun.position).sub(sun.target.position);
      if (tmpV.y > 0.05) sd.set(-tmpV.x / tmpV.y, -tmpV.z / tmpV.y);
    }
    var V = R.V, pid = V.pid, P = S.players[pid], fogOff = S.settings.fogOff, ents = S.ents, inView = R.inView, heightAt = T3.heightAt;
    var NEUT = M3.NEUT, BH = M3.BH, SCALE = M3.SCALE, rs = M3.rs, i, e, x, z, b, M, Pm, n = 0;
    for (i = 0; i < ents.length; i++) {
      e = ents[i];
      if (e.dead || e.inside) continue;
      if (airOnly && e.mc !== 2) continue;
      if (e.kind === 'building') {
        x = e.x / TILE; z = e.y / TILE;
        if (!inView(x, z)) continue;
        if (NEUT[e.type]) {
          if (!M3.neutralShown(e, P, fogOff)) continue;
          dyn.put(x, heightAt(x, z) + 0.03, z, 0, e.w * 0.8, (BH[e.type] || 0.9), e.h * 0.8, LOOK.bldA, LOOK.soft, 0.08); n++;
          continue;
        }
        if (e.owner !== pid && !fogOff && !G.Sim.isVisible(pid, e)) continue;
        if (e.type === 'wall') { dyn.put(x, heightAt(x, z) + 0.03, z, 0, 0.62, 0.6, 0.62, LOOK.bldA * 0.9, LOOK.soft * 0.8, 0.1); n++; continue; }
        Pm = S.players[e.owner]; M = M3.model(e.type, Pm.faction, Pm.color);
        b = modelBox('b' + e.type + Pm.faction + Pm.color, M, 0.3);
        dyn.put(x + b.cx, heightAt(x, z) + 0.03, z + b.cz, 0, Math.min(b.w, e.w), b.h, Math.min(b.d, e.h), LOOK.bldA, LOOK.soft, 0.08); n++;
      } else if (e.kind === 'unit') {
        x = (e.px + (e.x - e.px) * alpha) / TILE; z = (e.py + (e.y - e.py) * alpha) / TILE;
        if (!inView(x, z)) continue;
        if (e.owner !== pid && !fogOff && !G.Sim.isVisible(pid, e)) continue;
        Pm = S.players[e.owner]; M = M3.model(e.type, Pm.faction, Pm.color);
        var r = rs.get(e.id), ang = r ? r.dir : (e.dir || 0), sc = SCALE[e.type] || 1, inf = !!M3.INF[e.type];
        b = modelBox('u' + e.type + Pm.faction + Pm.color, M, 0);
        var c = Math.cos(-ang), s = Math.sin(-ang), ox = b.cx * sc, oz = b.cz * sc;
        if (e.mc === 2) {   // v0.8: Luftfahrzeug – Schatten um Flughöhe entlang der Sonne versetzt, flacher (nur Rumpf), weicher mit der Höhe; Rotorkreis als Hauch
          var al = r && r.alt != null ? r.alt : (e.alt || 0), ah = al * D.AIR_H + b.h * sc * 0.35, sx0 = x + c * ox + s * oz + sd.x * ah, sz0 = z - s * ox + c * oz + sd.y * ah;
          var gy0 = Math.max(heightAt(sx0, sz0), M3.WL || -0.13) + 0.02, fa = LOOK.unitA * (1 - 0.32 * al);
          dyn.put(sx0, gy0, sz0, ang, b.w * sc * 0.8, 0.04 + b.h * sc * 0.12, b.d * sc * 0.75, fa, LOOK.soft * (0.6 + al * 1.1), 0.55); n++;
          if (M.rotors && r && r.rpm > 0.3) for (var ri = 0; ri < M.rotors.length; ri++) {
            var ro = M.rotors[ri], rxx = sx0 + (c * ro[0] + s * ro[2]) * sc, rzz = sz0 + (-s * ro[0] + c * ro[2]) * sc;
            dyn.put(rxx, gy0, rzz, 0, ro[3] * sc * 2, 0.02, ro[3] * sc * 2, 0.16 * r.rpm * (1 - 0.3 * al), LOOK.soft * 1.4, 1); n++;
          }
          continue;
        }
        if (e.mc === 3) { dyn.put(x + c * ox + s * oz, (M3.WL || -0.13) + 0.015, z - s * ox + c * oz, ang, b.w * sc * 0.95, 0.12, b.d * sc * 0.9, LOOK.unitA * 0.55, LOOK.soft * 0.9, 0.5); n++; continue; }   // v0.8: Schiff – schwacher Saum auf dem Wasser
        if (inf) dyn.put(x, heightAt(x, z) + 0.02, z, ang, 0.2, b.h * sc * 0.9, 0.2, LOOK.unitA * 0.9, LOOK.soft * 0.6, 1);
        else dyn.put(x + c * ox + s * oz, heightAt(x, z) + 0.02, z - s * ox + c * oz, ang, b.w * sc * 0.92, b.h * sc * 0.85, b.d * sc * 0.92, LOOK.unitA, LOOK.soft * 0.7, 0.35);
        n++;
      }
    }
    if (n && !used && full) { used = true; if (R.mark) R.mark('liteLook'); }
  }
  function flush() { if (dyn) dyn.flush(); }
  /** neue Karte / neuer Aufbau: statische Schatten beim nächsten fill neu */
  function reset() { worldRef = null; boxCache = {}; used = false; }
  function info() { return { on: wanted(), air: airWanted(), dyn: dyn ? dyn.mesh.count : 0, stat: stat ? stat.mesh.count : 0, cap: dyn ? dyn.cap : 0 }; }

  G.R3S = { link: link, fill: fill, flush: flush, reset: reset, info: info, LOOK: LOOK, wanted: wanted };
})();
