/* FRONTLINIE – r3-terrain.js  (v0.7: Gelände-Überarbeitung)  →  G.R3T
 * Besitzt: Höhenfeld (Küstenhänge, Felsrücken), prozedurale Bodentexturen (7 Schichten: Gras, Trockengras, Erde, Sand, Fels, Asphalt, Erzboden
 *   als Textur-Array + Normalen/Rauheit), Splat-Karte aus dem Kachelgitter (weich, verrauscht), Straßen mit Rand/Markierung/Spurrillen,
 *   Wasser (Distanzfeld: Tiefe, Schaum, Fluss), Bäume (3 Arten, Wind), Felsbrocken, Gras-Büschel/Büsche (nur nahe Ansicht), Erz, Brücken,
 *   Decal-Ebene (Krater/Brandflecken/Panzerspuren), Erz-Funkeln, heightAt/groundAt.
 * Kontext: G.R3 (Kern): R.THREE, R.scene, R.SH, R.Q, R.std/R.post/R.lite, R.safeGPU, R.t, R.hash/clamp/rnd, R.fowify, R.inView.
 * Qualitätsstufen:  Modern = volle Textur-Shader (Höhen-Überblendung, Normalen, 256er Schichten, Wind);
 *                    Modern Lite = gleiche Shader-Linie, 128er Schichten, einfache Überblendung, kein Wind, weniger Büschel;
 *                    Pixel/Scharf/Spar = Lambert, Boden wird einmal in eine Canvas-Textur „gebacken“ (kein neuer Shader), einfaches Wasser.
 * Exporte (G.R3T):
 *   link(), init()             einmalig
 *   build(map) → world         Welt neu bauen; world = { group, W, H, hts, GW, GH, res, oreIdx[], water, stats, ... }
 *   dispose(), world()         aktuelle Welt oder null
 *   updateOre(force)           Erz-Kristalle an Restmenge anpassen
 *   heightAt(x, z), groundAt(x, z)   Geländehöhe / Standhöhe (Brücke = 0.15) in Kacheln
 *   terrAt(m, x, y)            Geländetyp-ID
 *   decal(x, z, size, life, kind?)   Krater/Brandfleck (kind 0 Brand, 1 Rußfleck, 2 Krater; ohne kind: nach Größe)
 *   track(x, z, ang, halfWidth, size)  optional: Spurabdruck (Fahrzeug bei (x,z) Kacheln, Richtung ang = Sim-Winkel); fill() setzt sie selbst
 *   fill(S, dt, fogOff, P)     je Frame vor dem Abschluss (Erz-Funkeln, Spuren)
 *   update(dt)                 je Frame nach den Effekten (Decals, Wasserzeit, Wind, Büschel)
 *   info()                     { texBytes, genMs, buildMs, ... } (Messwerte der letzten Welt)
 * Grafik-Anhebung „Android“: B1 = ruhigere/natürlichere Bodenschichten + weichere Erdflecken + sanftere Makro-Tönung (wirkt in allen Stufen,
 *   auch gebacken); C1 = rund schattierte Baumkronen/Felsen (Acc.add round, gleiche Dreieckszahl); A3 = Vorland am Kartenrand (buildApron,
 *   ersetzt die schwarze Sockelfläche; world.apron) + Rand-Abdunklung im Wasser (R.SH.uEdge vom Kern).
 */
var G = (typeof G !== 'undefined') ? G : {};
(function () {
  'use strict';
  var R = G.R3 = G.R3 || {};
  var THREE = R.THREE, D = R.D;
  var hash = R.hash, rnd = R.rnd, fowify = R.fowify;
  var M3 = null, F3 = null, MB = null, Batch = null, MAT = null, emit = null;
  var world = null, mapRef = null, SH = null, scene = null, safeGPU = false;
  var WL = -0.13;                       // Wasserspiegel
  var stats = { texBytes: 0, genMs: 0, buildMs: 0, layerMs: 0, fieldMs: 0, tris: 0 };
  function link() { M3 = G.R3M; F3 = G.R3F; MB = M3.MB; Batch = M3.Batch; MAT = M3.MAT; emit = F3.emit; }
  function now() { return (typeof performance !== 'undefined' ? performance.now() : Date.now()); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function sstep(a, b, x) { var t = (x - a) / (b - a); t = t < 0 ? 0 : (t > 1 ? 1 : t); return t * t * (3 - 2 * t); }
  function mix(a, b, t) { return a + (b - a) * t; }

  // ------------------------------------------------------------------ v0.7-deco: Kartendekoration (rein visuell, nicht blockierend)
  // G.Deco.plan(map, fine) → { items: [{k, x, y, ai, v, s}], counts }  (reine Funktion, deterministisch aus map.id + Karteninhalt, kein Math.random,
  // kein THREE/DOM → auch von render2d.js im Sprite-Modus ohne WebGL benutzt). x, y in Kacheln (Weltpixel = · TILE). Winkel = ai · 2π / NA[k];
  // Variante v (Farbvariante, Tabelle VARS). Rahmennummer im Sprite-Atlas = v · NA + ai.
  var DECO = (function () {
    var ORDER = ['lamp', 'sign', 'fence', 'bush', 'sandbag', 'wreck', 'crate', 'barrel'];
    var NA = { lamp: 4, sign: 2, fence: 2, bush: 4, sandbag: 8, wreck: 8, crate: 4, barrel: 1 };
    var NV = { lamp: 1, sign: 3, fence: 3, bush: 3, sandbag: 1, wreck: 2, crate: 2, barrel: 4 };
    var CAP = { lamp: 66, sign: 22, fence: 56, bush: 48, sandbag: 30, wreck: 14, crate: 30, barrel: 30 };
    // Farbvarianten (Faktor auf die Vertexfarben der Geometrie)
    var VARS = {
      lamp: [[1, 1, 1]],
      sign: [[1.0, 0.16, 0.12], [1.0, 0.82, 0.12], [0.2, 0.45, 1.0]],
      fence: [[1.0, 0.98, 0.92], [0.78, 0.55, 0.34], [0.62, 0.68, 0.74]],
      bush: [[0.9, 1.0, 0.85], [1.0, 1.0, 1.0], [1.15, 1.0, 0.7]],
      sandbag: [[1, 1, 1]],
      wreck: [[0.42, 0.40, 0.40], [0.9, 0.5, 0.3]],
      crate: [[0.85, 0.62, 0.38], [0.62, 0.7, 0.46]],
      barrel: [[0.8, 0.14, 0.1], [0.2, 0.36, 0.78], [0.9, 0.72, 0.15], [0.45, 0.5, 0.42]]
    };
    var TOWN = { house: 1, block: 1, hospital: 1 }, INDUSTRY = { workshop: 1, oilrig: 1, radar: 1 }, MIL = { bunker: 1, artillery: 1 };
    function seedOf(id) { var h = 5381; id = String(id || ''); for (var i = 0; i < id.length; i++) h = (Math.imul(h, 33) + id.charCodeAt(i)) | 0; return h; }
    function plan(m, fine) {
      var W = m.w, H = m.h, N = W * H, seed = seedOf(m.id), x, y, i, k;
      function ih(a, b, s) { var h = (Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(s + seed, 1274126177)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
      var TI = G.DATA.TERRAIN, tid = new Array(TI.length);
      for (i = 0; i < TI.length; i++) tid[i] = TI[i].id;
      function T(a, b) { return (a < 0 || b < 0 || a >= W || b >= H) ? '' : tid[m.terrain[b * W + a]]; }
      function land(a, b) { var t = T(a, b); return t === 'grass' || t === 'sand'; }
      var oreN = new Uint8Array(N), startD = new Uint8Array(N).fill(255), occ = new Uint8Array(N), used = new Uint8Array(N), ore = m.ore, om = m.oreMax;
      for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
        if ((ore && ore[y * W + x] > 0) || (om && om[y * W + x] > 0)) for (var oy = -1; oy <= 1; oy++) for (var ox = -1; ox <= 1; ox++) if (x + ox >= 0 && y + oy >= 0 && x + ox < W && y + oy < H) oreN[(y + oy) * W + x + ox] = 1;
      }
      var starts = m.starts || [];
      for (i = 0; i < starts.length; i++) {
        var scx = starts[i].tx + 1, scy = starts[i].ty + 1;
        for (y = Math.max(0, scy - 14); y <= Math.min(H - 1, scy + 14); y++) for (x = Math.max(0, scx - 14); x <= Math.min(W - 1, scx + 14); x++) {
          var dd = Math.max(Math.abs(x - scx), Math.abs(y - scy)); if (dd < startD[y * W + x]) startD[y * W + x] = dd;
        }
      }
      var BD = G.DATA.BUILDINGS, st = m.structures || [], S2 = [];
      for (i = 0; i < st.length; i++) {
        var bd = BD[st[i].type]; if (!bd) continue;
        S2.push({ type: st[i].type, tx: st[i].tx, ty: st[i].ty, w: bd.w, h: bd.h });
        for (y = st[i].ty; y < st[i].ty + bd.h; y++) for (x = st[i].tx; x < st[i].tx + bd.w; x++) if (x >= 0 && y >= 0 && x < W && y < H) occ[y * W + x] = 1;
      }
      var START_R = 8;
      function free(a, b) { return a >= 1 && b >= 1 && a < W - 1 && b < H - 1 && land(a, b) && !oreN[b * W + a] && startD[b * W + a] > START_R && !occ[b * W + a] && !used[b * W + a]; }
      var scale = fine ? 1 : 0.6, items = [], counts = {};
      function commit(kind, cands, cap) {   // Kandidaten nach Wertung sortieren, bis zur Obergrenze übernehmen (Kachel noch frei)
        cands.sort(function (p, q) { return p.sc - q.sc || p.tx - q.tx || p.ty - q.ty; });
        var n = 0, lim = Math.round(cap * scale * (kind === 'bush' && !fine ? 0.8 : 1));
        for (var c = 0; c < cands.length && n < lim; c++) {
          var q = cands[c], ti = q.ty * W + q.tx;
          if (used[ti] && !q.multi) continue;
          used[ti] = 1; n++;
          items.push({ k: kind, x: q.x, y: q.y, ai: q.ai, v: q.v, s: q.s || 1 });
        }
        counts[kind] = n;
      }
      var DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
      // --- Straßenlampen: an der Straßenkante auf geraden Abschnitten, versetzt links/rechts
      var cand = [];
      for (y = 1; y < H - 1; y++) for (x = 1; x < W - 1; x++) {
        if (T(x, y) !== 'road') continue;
        for (k = 0; k < 4; k++) {
          var nx = x + DX[k], ny = y + DY[k];
          if (!free(nx, ny)) continue;
          var tx2 = DY[k] !== 0 ? 1 : 0, ty2 = DX[k] !== 0 ? 1 : 0;   // Richtung entlang der Straße
          if (T(x + tx2, y + ty2) !== 'road' || T(x - tx2, y - ty2) !== 'road') continue;
          var tpos = DX[k] !== 0 ? y : x;
          if ((tpos + (k < 2 ? 3 : 0)) % 6 !== 0 || ih(x, y, 11 + k) > 0.85) continue;
          var ai = (k + 2) & 3;   // Ausleger zeigt zur Straße
          cand.push({ tx: nx, ty: ny, x: nx + 0.5 - DX[k] * 0.36 + tx2 * (ih(x, y, 20) - 0.5) * 0.2, y: ny + 0.5 - DY[k] * 0.36 + ty2 * (ih(x, y, 21) - 0.5) * 0.2, ai: ai, v: 0, sc: ih(x, y, 12) });
        }
      }
      commit('lamp', cand, CAP.lamp);
      // --- Verkehrsschilder: an Kreuzungen/Einmündungen/Kurven und vor Brücken
      cand = [];
      for (y = 1; y < H - 1; y++) for (x = 1; x < W - 1; x++) {
        var tt = T(x, y);
        if (tt === 'road') {
          var rn = 0, rx = 0, ry = 0;
          for (k = 0; k < 4; k++) if (T(x + DX[k], y + DY[k]) === 'road' || T(x + DX[k], y + DY[k]) === 'bridge') { rn++; rx += DX[k]; ry += DY[k]; }
          var junction = rn >= 3 || (rn === 2 && (rx !== 0 || ry !== 0));
          if (!junction || ih(x, y, 31) > 0.55) continue;
          for (k = 0; k < 4; k++) {
            var ddx = DX[k] + DX[(k + 1) & 3], ddy = DY[k] + DY[(k + 1) & 3], cx2 = x + ddx, cy2 = y + ddy;
            if (!free(cx2, cy2)) continue;
            cand.push({ tx: cx2, ty: cy2, x: cx2 + 0.5 - ddx * 0.34, y: cy2 + 0.5 - ddy * 0.34, ai: (ih(x, y, 32) * 2) | 0, v: ih(x, y, 33) < 0.5 ? 0 : 2, sc: ih(x, y, 34) });
            break;
          }
        } else if (tt === 'bridge') {
          for (k = 0; k < 4; k++) {
            var ax = x + DX[k], ay = y + DY[k], at = T(ax, ay);
            if (at === 'bridge' || at === 'water' || at === '' || at === 'rock') continue;
            var px2 = -DY[k], py2 = DX[k];   // seitlich der Zufahrt
            var sx2 = ax + px2, sy2 = ay + py2;
            if (!free(sx2, sy2)) { sx2 = ax - px2; sy2 = ay - py2; px2 = -px2; py2 = -py2; }
            if (!free(sx2, sy2)) continue;
            cand.push({ tx: sx2, ty: sy2, x: sx2 + 0.5 - px2 * 0.34, y: sy2 + 0.5 - py2 * 0.34, ai: DX[k] !== 0 ? 1 : 0, v: 1, sc: ih(x, y, 36) * 0.5 });
          }
        }
      }
      commit('sign', cand, CAP.sign);
      // --- Sandsäcke: Bogen vor der Basis (außerhalb der Bauzone), an Brückenköpfen, vor Bunkern/Artillerie
      cand = [];
      var cxm = W / 2, cym = H / 2;
      for (i = 0; i < starts.length; i++) {
        var bcx = starts[i].tx + 1, bcy = starts[i].ty + 1, toward = Math.atan2(cym - bcy, cxm - bcx);
        for (y = Math.max(1, bcy - 13); y <= Math.min(H - 2, bcy + 13); y++) for (x = Math.max(1, bcx - 13); x <= Math.min(W - 2, bcx + 13); x++) {
          var sd = startD[y * W + x];
          if (sd < START_R + 1 || sd > START_R + 4 || used[y * W + x] || !land(x, y) || oreN[y * W + x] || occ[y * W + x]) continue;
          var ang2 = Math.atan2(y - bcy, x - bcx), da = Math.abs(Math.atan2(Math.sin(ang2 - toward), Math.cos(ang2 - toward)));
          if (da > 1.0 || ih(x, y, 41) > 0.12) continue;
          cand.push({ tx: x, ty: y, x: x + 0.3 + 0.4 * ih(x, y, 42), y: y + 0.3 + 0.4 * ih(x, y, 43), ai: ((Math.round((ang2 + Math.PI / 2) / (Math.PI / 4)) % 8) + 8) % 8, v: 0, sc: ih(x, y, 44) });
        }
      }
      for (y = 1; y < H - 1; y++) for (x = 1; x < W - 1; x++) {
        if (T(x, y) !== 'bridge') continue;
        for (k = 0; k < 4; k++) {
          var bax = x + DX[k], bay = y + DY[k], bt = T(bax, bay);
          if (bt === 'bridge' || bt === 'water' || bt === '') continue;
          for (var sg = -1; sg <= 1; sg += 2) {
            var qx = bax - DY[k] * sg * 2, qy = bay + DX[k] * sg * 2;   // 2 Kacheln neben der Zufahrt (Straßenrand)
            if (!free(qx, qy) || ih(qx, qy, 45) > 0.7) continue;
            cand.push({ tx: qx, ty: qy, x: qx + 0.5 - DY[k] * sg * 0.15, y: qy + 0.5 + DX[k] * sg * 0.15, ai: DX[k] !== 0 ? 2 : 0, v: 0, sc: ih(qx, qy, 46) * 0.6 });
          }
        }
      }
      for (i = 0; i < S2.length; i++) {
        var sb = S2[i]; if (!MIL[sb.type]) continue;
        for (k = 0; k < 4; k++) {
          var ox2 = DX[k] !== 0 ? (DX[k] > 0 ? sb.tx + sb.w : sb.tx - 1) : sb.tx + ((ih(sb.tx, sb.ty, 47 + k) * sb.w) | 0), oy2 = DY[k] !== 0 ? (DY[k] > 0 ? sb.ty + sb.h : sb.ty - 1) : sb.ty + ((ih(sb.tx, sb.ty, 51 + k) * sb.h) | 0);
          if (!free(ox2, oy2) || ih(ox2, oy2, 55) > 0.6) continue;
          cand.push({ tx: ox2, ty: oy2, x: ox2 + 0.5, y: oy2 + 0.5, ai: DX[k] !== 0 ? 2 : 0, v: 0, sc: ih(ox2, oy2, 56) * 0.5 });
        }
      }
      commit('sandbag', cand, CAP.sandbag);
      // --- Zäune: lückenhafter Ring um Wohn-/Gewerbegebäude (Tür = Mitte der Südseite)
      cand = [];
      for (i = 0; i < S2.length; i++) {
        var fb = S2[i]; if (!TOWN[fb.type] && !INDUSTRY[fb.type]) continue;
        var vIdx = TOWN[fb.type] ? (ih(fb.tx, fb.ty, 61) < 0.55 ? 0 : 1) : 2, gap = fb.type === 'block' ? 0.4 : 0.3;
        var seg = function (ftx, fty, sx3, sy3, ai3, side, j) {
          if (!free(ftx, fty)) return;
          if (side === 2 && j === ((fb.w - 1) >> 1)) return;   // Tür
          if (ih(ftx, fty, 62) < gap) return;
          cand.push({ tx: ftx, ty: fty, x: sx3, y: sy3, ai: ai3, v: vIdx, sc: ih(fb.tx, fb.ty, 64) + 0.001 * ih(ftx, fty, 63) });   // ganze Gebäude zuerst
        };
        for (x = fb.tx - 1; x <= fb.tx + fb.w; x++) {
          seg(x, fb.ty - 1, x + 0.5, fb.ty - 0.82, 0, 0, x - fb.tx);
          seg(x, fb.ty + fb.h, x + 0.5, fb.ty + fb.h + 0.82, 0, 2, x - fb.tx);
        }
        for (y = fb.ty; y < fb.ty + fb.h; y++) {
          seg(fb.tx - 1, y, fb.tx - 0.82, y + 0.5, 1, 1, y - fb.ty);
          seg(fb.tx + fb.w, y, fb.tx + fb.w + 0.82, y + 0.5, 1, 3, y - fb.ty);
        }
      }
      commit('fence', cand, CAP.fence);
      // --- Kisten/Fässer an Gewerbe-/Hofgebäuden
      var cc = [], bc = [];
      for (i = 0; i < S2.length; i++) {
        var cb = S2[i]; if (!INDUSTRY[cb.type] && cb.type !== 'hospital' && cb.type !== 'block') continue;
        var nIt = 2 + ((ih(cb.tx, cb.ty, 71) * 3) | 0);
        for (k = 0; k < nIt; k++) {
          var side = (ih(cb.tx, cb.ty, 72 + k) * 4) | 0, jx, jy;
          if (side & 1) { jx = side === 1 ? cb.tx + cb.w : cb.tx - 1; jy = cb.ty + ((ih(cb.tx, cb.ty, 80 + k) * cb.h) | 0); }
          else { jy = side === 0 ? cb.ty - 1 : cb.ty + cb.h; jx = cb.tx + ((ih(cb.tx, cb.ty, 84 + k) * cb.w) | 0); }
          if (!free(jx, jy)) continue;
          if (cb.type === 'oilrig' || ih(cb.tx, cb.ty, 90 + k) < 0.45) {
            for (var q3 = 0; q3 < 2; q3++) bc.push({ tx: jx, ty: jy, multi: q3 > 0, x: jx + 0.28 + 0.44 * ih(jx, jy, 92 + q3), y: jy + 0.28 + 0.44 * ih(jx, jy, 94 + q3), ai: 0, v: cb.type === 'oilrig' ? 0 : (ih(jx, jy, 96) * 4) | 0, sc: ih(jx, jy, 98) + q3 * 0.001 });
          } else cc.push({ tx: jx, ty: jy, x: jx + 0.3 + 0.4 * ih(jx, jy, 99), y: jy + 0.3 + 0.4 * ih(jx, jy, 100), ai: (ih(jx, jy, 101) * 4) | 0, v: ih(jx, jy, 102) < 0.5 ? 0 : 1, sc: ih(jx, jy, 103) });
        }
      }
      commit('crate', cc, CAP.crate); commit('barrel', bc, CAP.barrel);
      // --- Autowracks: verstreut, bevorzugt an Straßen
      cand = [];
      for (y = 2; y < H - 2; y++) for (x = 2; x < W - 2; x++) {
        if (!free(x, y)) continue;
        var nearRoad = T(x + 1, y) === 'road' || T(x - 1, y) === 'road' || T(x, y + 1) === 'road' || T(x, y - 1) === 'road';
        if (ih(x, y, 111) > (nearRoad ? 0.02 : 0.004)) continue;
        cand.push({ tx: x, ty: y, x: x + 0.3 + 0.4 * ih(x, y, 112), y: y + 0.3 + 0.4 * ih(x, y, 113), ai: (ih(x, y, 114) * 8) | 0, v: ih(x, y, 115) < 0.6 ? 0 : 1, s: 0.95 + 0.2 * ih(x, y, 116), sc: ih(x, y, 117) });
      }
      commit('wreck', cand, CAP.wreck);
      // --- Büsche: Waldränder, Ufer, Straßenränder (nur Gras)
      cand = [];
      for (y = 1; y < H - 1; y++) for (x = 1; x < W - 1; x++) {
        if (T(x, y) !== 'grass' || !free(x, y)) continue;
        var pr = 0.004, nb = 0;
        for (k = 0; k < 4; k++) { var nt = T(x + DX[k], y + DY[k]); if (nt === 'trees') nb |= 1; else if (nt === 'water') nb |= 2; else if (nt === 'road') nb |= 4; else if (nt === 'rock') nb |= 8; }
        if (nb & 1) pr = 0.16; if (nb & 2) pr = Math.max(pr, 0.14); if (nb & 8) pr = Math.max(pr, 0.1); if (nb & 4) pr = Math.max(pr, 0.05);
        if (ih(x, y, 121) > pr) continue;
        cand.push({ tx: x, ty: y, x: x + 0.2 + 0.6 * ih(x, y, 122), y: y + 0.2 + 0.6 * ih(x, y, 123), ai: (ih(x, y, 124) * 4) | 0, v: (ih(x, y, 125) * 3) | 0, s: 0.8 + 0.55 * ih(x, y, 126), sc: ih(x, y, 127) });
      }
      commit('bush', cand, CAP.bush);
      return { items: items, counts: counts };
    }
    return { plan: plan, ORDER: ORDER, NA: NA, NV: NV, VARS: VARS, CAP: CAP };
  })();
  G.Deco = DECO;

  // ------------------------------------------------------------------ v0.9: Brückenzüge (G.Bridges, rein, ohne THREE/DOM – auch render2d/Sprite-Modus)
  // G.Bridges.plan(map) → { runs: [{ cx, cy, ux, uy, L, W, n }], diag: Uint8Array(w·h) (1 = Kachel gehört zu einem diagonalen Zug) }
  // Zusammenhängende Brückenkacheln (8er-Nachbarschaft) → Hauptachse über die Kovarianz der Kachelmitten. Ein Zug gilt als DIAGONAL, wenn seine Achse
  // 22–68° zur Kartenachse liegt, er länglich ist (λ1 ≥ 2,2 λ2) und ≥ 4 Kacheln hat: Auf der Karte ist er eine Treppe aus Kacheln (Inselreich, Kreuzung),
  // gezeichnet wird er als EIN gerader Steg (Mitte cx/cy, Richtung ux/uy, Länge L, Breite W in Kacheln) – 3D (buildStatics), 2D-Boden + Sprite-Geländer
  // (render2d). Achsparallele Brücken bleiben kachelweise. Die Sim fährt unverändert über die Kacheln (Steg deckt alle Kachelmitten + 0,37 Rand).
  var BRIDGES = (function () {
    function plan(m) {
      var W = m.w, H = m.h, Bt = -1, i, k;
      for (i = 0; i < D.TERRAIN.length; i++) if (D.TERRAIN[i].id === 'bridge') Bt = i;
      var seen = new Uint8Array(W * H), diag = new Uint8Array(W * H), runs = [], st = [];
      for (i = 0; i < W * H; i++) {
        if (m.terrain[i] !== Bt || seen[i]) continue;
        var tiles = []; st.length = 0; st.push(i); seen[i] = 1;
        while (st.length) {
          var q = st.pop(), qx = q % W, qy = (q - qx) / W; tiles.push(q);
          for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
            var nx = qx + dx, ny = qy + dy, ni = ny * W + nx;
            if ((dx || dy) && nx >= 0 && ny >= 0 && nx < W && ny < H && !seen[ni] && m.terrain[ni] === Bt) { seen[ni] = 1; st.push(ni); }
          }
        }
        if (tiles.length < 4) continue;
        var mx = 0, my = 0, sxx = 0, syy = 0, sxy = 0, n = tiles.length;
        for (k = 0; k < n; k++) { mx += tiles[k] % W + 0.5; my += Math.floor(tiles[k] / W) + 0.5; }
        mx /= n; my /= n;
        for (k = 0; k < n; k++) { var ax = tiles[k] % W + 0.5 - mx, ay = Math.floor(tiles[k] / W) + 0.5 - my; sxx += ax * ax; syy += ay * ay; sxy += ax * ay; }
        var tr = (sxx + syy) / 2, dt = Math.sqrt(Math.max(0, (sxx - syy) * (sxx - syy) / 4 + sxy * sxy)), l1 = tr + dt, l2 = Math.max(1e-6, tr - dt);
        var th = 0.5 * Math.atan2(2 * sxy, sxx - syy), deg = Math.abs(((th * 180 / Math.PI) % 90 + 90) % 90);
        if (l1 < 2.2 * l2 || deg < 22 || deg > 68) continue;
        if (Math.abs(deg - 45) < 12) th = sxy >= 0 ? Math.PI / 4 : -Math.PI / 4;   // Kachel-Treppen sind (fast) immer genau diagonal gemeint
        var ux = Math.cos(th), uy = Math.sin(th), t0 = 1e9, t1 = -1e9, s0 = 1e9, s1 = -1e9;
        for (k = 0; k < n; k++) {
          var bx = tiles[k] % W + 0.5 - mx, by = Math.floor(tiles[k] / W) + 0.5 - my, t = bx * ux + by * uy, s = -bx * uy + by * ux;
          if (t < t0) t0 = t; if (t > t1) t1 = t; if (s < s0) s0 = s; if (s > s1) s1 = s;
        }
        var tm = (t0 + t1) / 2, sm = (s0 + s1) / 2;
        runs.push({ cx: mx + ux * tm - uy * sm, cy: my + uy * tm + ux * sm, ux: ux, uy: uy, L: t1 - t0 + 1.25, W: Math.max(1.2, Math.min(2.8, s1 - s0 + 0.75)), n: n });
        for (k = 0; k < n; k++) diag[tiles[k]] = 1;
      }
      return { runs: runs, diag: diag };
    }
    return { plan: plan };
  })();
  G.Bridges = BRIDGES;

  // ------------------------------------------------------------------ Rauschen (Wertrauschen, kachelbar über Gitter-Periode)
  var LAT = {};
  function lat(P, seed) {
    var k = P * 1000 + seed, a = LAT[k];
    if (!a) {
      a = new Float32Array(P * P); var s = (seed * 9301 + 49297) | 0;
      for (var i = 0; i < a.length; i++) { s = (Math.imul(s, 1103515245) + 12345) | 0; a[i] = ((s >>> 8) & 0xffff) / 65535; }
      LAT[k] = a;
    }
    return a;
  }
  function vnoise(L, P, x, y) {
    var xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi, m = P - 1;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    var x0 = xi & m, x1 = (x0 + 1) & m, y0 = (yi & m) * P, y1 = (((yi & m) + 1) & m) * P;
    var a = L[y0 + x0], b = L[y0 + x1], c = L[y1 + x0], d = L[y1 + x1];
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }
  /** kachelbarer fbm auf [0,1)²: Periode P0 Zellen, oct Oktaven → Wert 0..1 */
  function mkFbm(P0, oct, seed, gain) {
    var Ls = [], Ps = [], norm = 0, a = 1, i; gain = gain || 0.5;
    for (i = 0; i < oct; i++) { Ps.push(P0 << i); Ls.push(lat(P0 << i, seed + i * 7)); norm += a; a *= gain; }
    return function (u, v) { var s = 0, g = 1; for (var k = 0; k < oct; k++) { s += g * vnoise(Ls[k], Ps[k], u * Ps[k], v * Ps[k]); g *= gain; } return s / norm; };
  }
  /** Welt-fbm (nicht kachelbar, Periode 128 Zellen): f(x, z) mit Frequenz freq (Zellen je Kachel) */
  function mkWorldFbm(freq, oct, seed, gain) {
    var Ls = [], norm = 0, a = 1, i; gain = gain || 0.5;
    for (i = 0; i < oct; i++) { Ls.push(lat(128, seed + i * 11)); norm += a; a *= gain; }
    return function (x, z) { var s = 0, g = 1, f = freq; for (var k = 0; k < oct; k++) { s += g * vnoise(Ls[k], 128, x * f, z * f); g *= gain; f *= 2; } return s / norm; };
  }

  // ------------------------------------------------------------------ Bodenschichten (einmal je Auflösung erzeugt, im Speicher gehalten)
  // 0 Gras, 1 Trockengras, 2 Erde, 3 Sand, 4 Fels, 5 Asphalt, 6 Erzboden.  alb: sRGB-RGBA (a = Höhe), nrm: (xy = Normale, b = Rauheit, a = Verdeckung)
  var NL = 7, layerCache = {};
  function fh(i, j, s) { var h = Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(s, 1274126177); h = Math.imul(h ^ (h >>> 13), 1103515245); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
  function genLayers(S) {
    if (layerCache[S]) return layerCache[S];
    var t0 = now(), N = S * S;
    var alb = new Uint8Array(NL * N * 4), nrm = new Uint8Array(NL * N * 4);
    var fa = mkFbm(4, 5, 3), fb = mkFbm(16, 3, 11), fc = mkFbm(64, 2, 17), ga = mkFbm(2, 5, 23), gb = mkFbm(8, 4, 29), gc = mkFbm(32, 3, 37);
    var A1 = new Float32Array(N), A2 = new Float32Array(N), A3 = new Float32Array(N), B1 = new Float32Array(N), B2 = new Float32Array(N), B3 = new Float32Array(N);
    var i, j, k;
    for (j = 0; j < S; j++) for (i = 0; i < S; i++) {
      var u = i / S, v = j / S; k = j * S + i;
      A1[k] = fa(u, v); A2[k] = fb(u, v); A3[k] = fc(u, v); B1[k] = ga(u, v); B2[k] = gb(u, v); B3[k] = gc(u, v);
    }
    var hb = new Float32Array(N), L;
    var NSTR = [3.4, 3.0, 4.2, 2.4, 6.0, 2.4, 4.2];   // B1: Gras/Trockengras flacher (weniger Flimmern)
    var TAU = Math.PI * 2;
    for (L = 0; L < NL; L++) {
      var o = L * N * 4, rr = new Float32Array(N);
      for (j = 0; j < S; j++) for (i = 0; i < S; i++) {
        k = j * S + i;
        var u2 = i / S, v2 = j / S, n1 = A1[k], n2 = A2[k], n3 = A3[k], m1 = B1[k], m2 = B2[k], m3 = B3[k];
        var r, g, b, h, rg, t, sp = fh(i, j, 40 + L);
        if (L === 0) {            // Gras
          // B1 (Boden): ruhiger – feines Korn (n2/n3) trägt nur noch halb so stark zur Farbe bei (vorher 1.1 / 0.7 → „Fernsehrauschen“),
          // engerer Tonumfang, natürlicheres Grün statt Giftgrün (vorher 44,92,32 … 112,164,62); das Feindetail bleibt in Höhe/Normale
          t = clamp(0.26 + 0.5 * n1 + 0.5 * (n2 - 0.5) + 0.3 * (n3 - 0.5), 0, 1);
          r = mix(70, 110, t); g = mix(103, 141, t); b = mix(52, 72, t);
          var y = sstep(0.6, 0.85, n2) * 0.26; r += 26 * y; g += 8 * y;
          if (sp > 0.975) { r += 9; g += 11; }
          h = clamp(0.4 + 0.9 * (n2 - 0.5) + 0.55 * (n3 - 0.5) + 0.25 * (n1 - 0.5), 0, 1); rg = 0.9;
        } else if (L === 1) {     // Trockengras (Stroh)
          t = clamp(0.28 + 0.5 * m1 + 0.42 * (m2 - 0.5) + 0.24 * (n3 - 0.5), 0, 1);
          r = mix(136, 192, t); g = mix(118, 168, t); b = mix(66, 102, t);
          var dk = sstep(0.62, 0.8, n2) * 0.18; r *= 1 - dk; g *= 1 - dk; b *= 1 - dk;
          if (sp > 0.97) { r += 12; g += 11; b += 5; }
          h = clamp(0.4 + 0.8 * (m2 - 0.5) + 0.6 * (n3 - 0.5), 0, 1); rg = 0.93;
        } else if (L === 2) {     // Erde
          t = clamp(0.3 + 0.5 * n1 + 0.5 * (m2 - 0.5), 0, 1);
          r = mix(104, 150, t); g = mix(83, 122, t); b = mix(60, 90, t);   // B1: weniger Rotbraun
          var pb = sstep(0.7, 0.76, m3), cr = 1 - Math.abs(2 * n2 - 1), ck = sstep(0.93, 0.985, cr);
          r = mix(r, 168, pb * 0.55); g = mix(g, 156, pb * 0.55); b = mix(b, 142, pb * 0.55);
          r *= 1 - ck * 0.4; g *= 1 - ck * 0.4; b *= 1 - ck * 0.4;
          h = clamp(0.4 + 0.5 * (n2 - 0.5) + 0.5 * (n3 - 0.5) + pb * 0.3 - ck * 0.35, 0, 1); rg = 0.95;
        } else if (L === 3) {     // Sand (Dünenwellen)
          var rip = Math.sin((v2 * 12 + (n1 - 0.5) * 5 + (m2 - 0.5) * 1.5) * TAU) * 0.5 + 0.5;
          t = clamp(0.35 + 0.35 * n1 + 0.25 * (n3 - 0.5) + 0.18 * (rip - 0.5), 0, 1);
          r = mix(204, 238, t); g = mix(180, 216, t); b = mix(126, 160, t);
          if (sp > 0.97) { r -= 15; g -= 16; b -= 15; }
          h = clamp(0.5 + 0.28 * (rip - 0.5) + 0.2 * (n3 - 0.5), 0, 1); rg = 0.92;
        } else if (L === 4) {     // Fels (Schichten, Risse)
          var ra = 1 - Math.abs(2 * n1 - 1), rb = 1 - Math.abs(2 * m2 - 1), st = Math.sin((v2 * 9 + n1 * 3 + (n2 - 0.5)) * TAU) * 0.5 + 0.5;
          t = clamp(0.25 + 0.4 * ra + 0.35 * st * 0.5 + 0.3 * (n3 - 0.5), 0, 1);
          r = mix(84, 154, t); g = mix(80, 144, t); b = mix(74, 130, t);
          var crk = sstep(0.9, 0.985, rb); r *= 1 - 0.45 * crk; g *= 1 - 0.45 * crk; b *= 1 - 0.45 * crk;
          if (n2 > 0.66) { var mo = sstep(0.66, 0.8, n2) * 0.22; r = mix(r, 92, mo); g = mix(g, 110, mo); b = mix(b, 70, mo); }
          h = clamp(0.25 + 0.5 * ra * ra + 0.3 * rb * 0.6 + 0.2 * st - crk * 0.3, 0, 1); rg = 0.86;
        } else if (L === 5) {     // Asphalt
          var cr2 = 1 - Math.abs(2 * m2 - 1), ck2 = sstep(0.955, 0.992, cr2);
          t = clamp(0.5 + 0.5 * (n1 - 0.5) + 0.5 * (n3 - 0.5), 0, 1);
          r = mix(62, 86, t); g = mix(64, 88, t); b = mix(66, 90, t);
          var oil = sstep(0.62, 0.74, m1) * 0.22; r *= 1 - oil; g *= 1 - oil; b *= 1 - oil;
          r *= 1 - ck2 * 0.45; g *= 1 - ck2 * 0.45; b *= 1 - ck2 * 0.45;
          if (sp > 0.93) { r += 14; g += 14; b += 14; }
          h = clamp(0.5 + 0.3 * (n3 - 0.5) - ck2 * 0.4, 0, 1); rg = 0.78 + 0.18 * n2 - 0.2 * oil * 4;
        } else {                  // Erzboden: dunkle Erde mit Bernstein-Splittern
          t = clamp(0.3 + 0.5 * n1 + 0.5 * (n2 - 0.5), 0, 1);
          r = mix(76, 118, t); g = mix(68, 106, t); b = mix(60, 92, t);       // B1: neutraler, etwas heller (vorher 58,42,32 … 112,78,52 = harter rotbrauner Fleck)
          var sk = sstep(0.82, 0.9, m3) + sstep(0.86, 0.93, n3) * 0.8;
          if (sk > 0) { sk = Math.min(1, sk); r = mix(r, 244, sk * 0.72); g = mix(g, 194, sk * 0.72); b = mix(b, 84, sk * 0.72); }
          h = clamp(0.4 + 0.45 * (n2 - 0.5) + 0.35 * (n3 - 0.5) + sk * 0.35, 0, 1); rg = sk > 0.2 ? 0.45 : 0.92;
        }
        hb[k] = h; rr[k] = rg;
        var q = o + k * 4;
        alb[q] = r < 0 ? 0 : (r > 255 ? 255 : r); alb[q + 1] = g < 0 ? 0 : (g > 255 ? 255 : g); alb[q + 2] = b < 0 ? 0 : (b > 255 ? 255 : b); alb[q + 3] = h * 255;
      }
      var st2 = NSTR[L];
      for (j = 0; j < S; j++) for (i = 0; i < S; i++) {
        k = j * S + i;
        var hx = hb[j * S + (i + 1) % S] - hb[j * S + (i + S - 1) % S], hz = hb[((j + 1) % S) * S + i] - hb[((j + S - 1) % S) * S + i];
        var nx = clamp(-hx * st2, -1, 1), nz = clamp(-hz * st2, -1, 1), q2 = o + k * 4;
        nrm[q2] = (0.5 + 0.5 * nx) * 255; nrm[q2 + 1] = (0.5 + 0.5 * nz) * 255; nrm[q2 + 2] = clamp(rr[k], 0, 1) * 255;
        nrm[q2 + 3] = (0.62 + 0.38 * hb[k]) * 255;
      }
    }
    var out = { S: S, alb: alb, nrm: nrm };
    layerCache[S] = out;
    out.ms = now() - t0; stats.layerMs += out.ms;
    return out;
  }

  // ------------------------------------------------------------------ Welt-Felder (Distanzfelder, Höhen, Splat, Straßen) – reine Rechnung
  var CLS = { grass: 0, sand: 1, rock: 2, water: 3, trees: 4, road: 5, bridge: 6 };
  function terrAt(m, x, y) {
    x = x < 0 ? 0 : (x >= m.w ? m.w - 1 : x); y = y < 0 ? 0 : (y >= m.h ? m.h - 1 : y);
    return D.TERRAIN[m.terrain[y * m.w + x]].id;
  }

  /** Chamfer-Distanz (in Texeln) zum nächsten Texel mit mask === target */
  function chamfer(mask, w, h, target) {
    var INF = 1e9, d = new Float32Array(w * h), i, j, k;
    for (k = 0; k < d.length; k++) d[k] = mask[k] === target ? 0 : INF;
    var a = 1, b = 1.4142;
    for (j = 0; j < h; j++) for (i = 0; i < w; i++) {
      k = j * w + i; var v = d[k]; if (v === 0) continue;
      if (i > 0) v = Math.min(v, d[k - 1] + a);
      if (j > 0) { v = Math.min(v, d[k - w] + a); if (i > 0) v = Math.min(v, d[k - w - 1] + b); if (i < w - 1) v = Math.min(v, d[k - w + 1] + b); }
      d[k] = v;
    }
    for (j = h - 1; j >= 0; j--) for (i = w - 1; i >= 0; i--) {
      k = j * w + i; v = d[k]; if (v === 0) continue;
      if (i < w - 1) v = Math.min(v, d[k + 1] + a);
      if (j < h - 1) { v = Math.min(v, d[k + w] + a); if (i < w - 1) v = Math.min(v, d[k + w + 1] + b); if (i > 0) v = Math.min(v, d[k + w - 1] + b); }
      d[k] = v;
    }
    return d;
  }
  /** vorzeichenbehaftetes Feld in Kacheln: > 0 innerhalb der Maske, < 0 außerhalb (Abstand zum Rand), geglättet */
  function signedField(mask, w, h, F) {
    var dIn = chamfer(mask, w, h, 0), dOut = chamfer(mask, w, h, 1), s = new Float32Array(w * h), k;
    var anyIn = false, anyOut = false;
    for (k = 0; k < s.length && !(anyIn && anyOut); k++) { if (mask[k]) anyIn = true; else anyOut = true; }
    for (k = 0; k < s.length; k++) {
      if (!anyIn) s[k] = -9; else if (!anyOut) s[k] = 9;
      else s[k] = mask[k] ? (dIn[k] - 0.5) / F : -(dOut[k] - 0.5) / F;
    }
    return anyIn ? blur(blur(s, w, h, 2), w, h, 1) : s;
  }
  function blur(src, w, h, r) {   // Kastenfilter (separabel, laufende Summe)
    var tmp = new Float32Array(w * h), dst = new Float32Array(w * h), i, j, s, n = 2 * r + 1, c;
    for (j = 0; j < h; j++) {
      s = 0; for (i = -r; i <= r; i++) s += src[j * w + (i < 0 ? 0 : (i >= w ? w - 1 : i))];
      for (i = 0; i < w; i++) {
        tmp[j * w + i] = s / n;
        c = i + r + 1; s += src[j * w + (c >= w ? w - 1 : c)]; c = i - r; s -= src[j * w + (c < 0 ? 0 : c)];
      }
    }
    for (i = 0; i < w; i++) {
      s = 0; for (j = -r; j <= r; j++) s += tmp[(j < 0 ? 0 : (j >= h ? h - 1 : j)) * w + i];
      for (j = 0; j < h; j++) {
        dst[j * w + i] = s / n;
        c = j + r + 1; s += tmp[(c >= h ? h - 1 : c) * w + i]; c = j - r; s -= tmp[(c < 0 ? 0 : c) * w + i];
      }
    }
    return dst;
  }

  function coarse(fn, W, H, Gr) {
    var gw = W * Gr + 2, gh = H * Gr + 2, a = new Float32Array(gw * gh), i, j;
    for (j = 0; j < gh; j++) for (i = 0; i < gw; i++) a[j * gw + i] = fn(i / Gr, j / Gr);
    return function (x, z) {
      var fx = x * Gr, fz = z * Gr, i0 = fx | 0, j0 = fz | 0, tx = fx - i0, tz = fz - j0, o = j0 * gw + i0;
      return a[o] * (1 - tx) * (1 - tz) + a[o + 1] * tx * (1 - tz) + a[o + gw] * (1 - tx) * tz + a[o + gw + 1] * tx * tz;
    };
  }
  function buildFields(m, cf) {
    var t0 = now(), W = m.w, H = m.h, F = cf.F, cw = W * F, ch = H * F, NT = cw * ch, i, j, k, x, y;
    var fl = { W: W, H: H, F: F, cw: cw, ch: ch };
    // --- Kachelklassen (Straße → Untergrund wie die Nachbarn; Brücke → Wasser)
    var cls = new Uint8Array(W * H), ore = new Uint8Array(W * H);
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      var id = D.TERRAIN[m.terrain[y * W + x]].id; cls[y * W + x] = CLS[id];
      if (m.oreMax[y * W + x] > 0 || m.ore[y * W + x] > 0) ore[y * W + x] = 1;
    }
    var base = new Uint8Array(W * H);   // Untergrundklasse ohne Straße
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      var c0 = cls[y * W + x];
      if (c0 === 5) {
        var sn = 0, gn = 0, rn = 0;
        for (var q = 0; q < 8; q++) {
          var nn = terrAt(m, x + [1, -1, 0, 0, 1, -1, 1, -1][q], y + [0, 0, 1, -1, 1, 1, -1, -1][q]);
          if (nn === 'sand') sn++; else if (nn === 'grass' || nn === 'trees') gn++; else if (nn === 'rock') rn++;
        }
        c0 = sn > gn + rn ? 1 : (gn >= rn ? 0 : 2); if (c0 === 2 && rn < 4) c0 = sn >= gn ? 1 : 0;
      }
      base[y * W + x] = c0;
    }
    // --- verwackelte Klassenkarte (Texel → Klasse), organische Küsten-/Felsränder
    var wn1 = coarse(mkWorldFbm(0.9, 3, 31), W, H, 4), wn2 = coarse(mkWorldFbm(0.9, 3, 47), W, H, 4), wam = 0.34;
    var wcls = new Uint8Array(NT), wore = new Uint8Array(NT), wmaskW = new Uint8Array(NT), wmaskR = new Uint8Array(NT);
    for (j = 0; j < ch; j++) for (i = 0; i < cw; i++) {
      var u = (i + 0.5) / F, v = (j + 0.5) / F;
      var tx = Math.floor(u + (wn1(u, v) - 0.5) * 2 * wam), ty = Math.floor(v + (wn2(u, v) - 0.5) * 2 * wam);
      tx = tx < 0 ? 0 : (tx >= W ? W - 1 : tx); ty = ty < 0 ? 0 : (ty >= H ? H - 1 : ty);
      k = j * cw + i; var cc = base[ty * W + tx], c1 = cls[ty * W + tx];
      wcls[k] = cc; wore[k] = ore[ty * W + tx];
      if (c1 === 3 || c1 === 6) wmaskW[k] = 1;
      if (c1 === 2) wmaskR[k] = 1;
    }
    var tp = now(); stats.fp = [];
    var sdW = signedField(wmaskW, cw, ch, F), sdR = signedField(wmaskR, cw, ch, F); stats.fp.push(['sdf', now() - tp]); tp = now();
    fl.sdW = sdW; fl.sdR = sdR;
    // --- Höhenfeld (Texelraster F)
    var bn = coarse(mkWorldFbm(0.085, 3, 53), W, H, 2), bn2 = coarse(mkWorldFbm(0.22, 2, 59), W, H, 2), rg = coarse(mkWorldFbm(0.55, 3, 61), W, H, 4), rg2 = coarse(mkWorldFbm(1.6, 2, 67), W, H, 4);
    var hF = new Float32Array(NT);
    for (j = 0; j < ch; j++) for (i = 0; i < cw; i++) {
      k = j * cw + i; var xx = (i + 0.5) / F, zz = (j + 0.5) / F;
      var b0 = 0.004 + 0.044 * (bn(xx, zz) - 0.5), sw = sdW[k], sr = sdR[k], hh = b0;
      if (sw > -0.6) {
        var tw = sstep(-0.55, 0.9, sw), deep = -0.62 - 0.1 * (bn2(xx, zz) - 0.5);
        hh = b0 + (deep - b0) * tw;
      }
      if (sr > -0.7) {
        if (sr > 0) {
          var prof = sstep(-0.1, 1.0, sr) * (0.55 + 0.5 * sstep(0.5, 2.6, sr));
          var ridge = 1 - Math.abs(2 * rg(xx, zz) - 1);
          hh += prof * (0.72 + 0.5 * ridge * ridge) + 0.09 * sstep(0.2, 1.2, sr) * (rg2(xx, zz) - 0.5) * 2;
        } else hh += 0.06 * sstep(0.7, 0, -sr);
      }
      hF[k] = hh;
    }
    fl.hF = hF; stats.fp.push(['height', now() - tp]); tp = now();
    // --- Straßenfeld (Texelraster RF): Abdeckung (A), Mittelstrich (R), Randlinie (G), Spurrillen (B)
    var RF = cf.RF, rw = W * RF, rh = H * RF, road = null, rdist = null, segs = [], deg = new Uint8Array(W * H);
    var isRoad = function (xx2, yy2) { if (xx2 < 0 || yy2 < 0 || xx2 >= W || yy2 >= H) return false; var c = cls[yy2 * W + xx2]; return c === 5 || c === 6; };
    var isBr = function (xx2, yy2) { return xx2 >= 0 && yy2 >= 0 && xx2 < W && yy2 < H && cls[yy2 * W + xx2] === 6; };
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      if (cls[y * W + x] !== 5) continue;
      var any = 0, nb = [[1, 0], [0, 1], [-1, 0], [0, -1]], dg = [[1, 1], [1, -1], [-1, 1], [-1, -1]], z;
      for (z = 0; z < 4; z++) {
        var nx2 = x + nb[z][0], ny2 = y + nb[z][1];
        if (isRoad(nx2, ny2)) { any++; if (nb[z][0] > 0 || nb[z][1] > 0 || isBr(nx2, ny2)) segs.push([x, y, nx2, ny2]); }
      }
      for (z = 0; z < 4; z++) {
        var dx2 = x + dg[z][0], dy2 = y + dg[z][1];
        if (isRoad(dx2, dy2) && !isRoad(dx2, y) && !isRoad(x, dy2)) { any++; if (dg[z][0] > 0) segs.push([x, y, dx2, dy2]); }
      }
      if (!any) segs.push([x, y, x, y]);
      deg[y * W + x] = any;
    }
    if (segs.length) {
      road = new Uint8Array(rw * rh * 4); rdist = new Float32Array(rw * rh); rdist.fill(9);
      var HW = 0.4;
      for (var s = 0; s < segs.length; s++) {
        var sg = segs[s], ax = sg[0] + 0.5, ay = sg[1] + 0.5, bx = sg[2] + 0.5, by = sg[3] + 0.5;
        var L = Math.hypot(bx - ax, by - ay), ddx = L > 0 ? (bx - ax) / L : 1, ddy = L > 0 ? (by - ay) / L : 0;
        var tLo = 0, tHi = L; if (isBr(sg[0], sg[1])) tLo = L * 0.5; if (isBr(sg[2], sg[3])) tHi = L * 0.5;
        if (tLo > tHi) continue;
        var dA = deg[sg[1] * W + sg[0]], dB = (sg[2] >= 0 && sg[3] >= 0 && sg[2] < W && sg[3] < H) ? deg[sg[3] * W + sg[2]] : 0;
        var x0 = Math.max(0, Math.floor((Math.min(ax, bx) - 0.6) * RF)), x1 = Math.min(rw - 1, Math.ceil((Math.max(ax, bx) + 0.6) * RF));
        var y0 = Math.max(0, Math.floor((Math.min(ay, by) - 0.6) * RF)), y1 = Math.min(rh - 1, Math.ceil((Math.max(ay, by) + 0.6) * RF));
        for (j = y0; j <= y1; j++) for (i = x0; i <= x1; i++) {
          var px = (i + 0.5) / RF - ax, py = (j + 0.5) / RF - ay;
          var tt = clamp(px * ddx + py * ddy, tLo, tHi), ox = px - ddx * tt, oy = py - ddy * tt, dist = Math.sqrt(ox * ox + oy * oy);
          k = j * rw + i;
          if (dist >= rdist[k]) continue;
          rdist[k] = dist;
          if (dist > 0.47) continue;
          var off = Math.abs(-ddy * px + ddx * py), q3 = k * 4, cov = clamp((HW - dist) * RF * 0.8 + 0.5, 0, 1);
          // an Kreuzungen/Enden keine Markierung
          var mk = 1; if ((dA >= 3 || dA === 1) && tt < 0.45) mk = 0; if ((dB >= 3 || dB === 1) && L - tt < 0.45) mk = 0;
          if (dA === 0 && dB === 0) mk = 0;
          var ph = ((tt % 0.5) + 0.5) % 0.5, dashA = Math.min(clamp(ph * RF * 0.9, 0, 1), clamp((0.27 - ph) * RF * 0.9, 0, 1));
          var cen = clamp((0.05 - off) * RF * 0.9, 0, 1) * dashA * mk;
          var edg = clamp((0.016 - Math.abs(off - 0.318)) * RF * 1.1, 0, 1) * mk * (dist < HW ? 1 : 0);
          var wq = (off - 0.14) / 0.05, wear = dist < HW ? Math.exp(-wq * wq) * 0.9 : 0;
          road[q3] = cen * 255; road[q3 + 1] = edg * 255; road[q3 + 2] = wear * 255; road[q3 + 3] = cov * 255;
        }
      }
    }
    stats.fp.push(['road', now() - tp]); tp = now();
    fl.road = road; fl.RF = RF; fl.rw = rw; fl.rh = rh; fl.rdist = rdist;
    // --- Gewichte glätten (Kasten-Filter über das verwackelte Klassenraster)
    var rb = Math.max(1, Math.round(F * 0.34)), chn = [], cnames = ['g', 's', 'r', 'w', 'f', 'o'];
    for (k = 0; k < 6; k++) chn.push(new Float32Array(NT));
    for (k = 0; k < NT; k++) {
      var cv = wcls[k];
      if (cv === 0) chn[0][k] = 1; else if (cv === 4) { chn[0][k] = 1; chn[4][k] = 1; } else if (cv === 1) chn[1][k] = 1; else if (cv === 2) chn[2][k] = 1; else chn[3][k] = 1;
      if (wore[k] && cv !== 3 && cv !== 6 && cv !== 2) chn[5][k] = 1;
    }
    for (k = 0; k < 6; k++) chn[k] = blur(blur(chn[k], cw, ch, rb), cw, ch, rb);
    void cnames;
    // --- Splat (A: Gras, Trocken, Erde, Sand;  B: Fels, Makro, Erz, Wald)
    var dryN = coarse(mkWorldFbm(0.1, 3, 71), W, H, 2), dirtN = coarse(mkWorldFbm(0.3, 3, 73), W, H, 4), macN = coarse(mkWorldFbm(0.07, 3, 79), W, H, 2), mac2 = coarse(mkWorldFbm(0.21, 2, 83), W, H, 2), bankN = coarse(mkWorldFbm(0.7, 2, 89), W, H, 4);
    var splA = new Uint8Array(NT * 4), splB = new Uint8Array(NT * 4), shore = new Uint8Array(NT * 2);
    var dryW = new Uint8Array(W * H);
    for (j = 0; j < ch; j++) for (i = 0; i < cw; i++) {
      k = j * cw + i; var wx = (i + 0.5) / F, wz = (j + 0.5) / F;
      var gW = chn[0][k], sW = chn[1][k], rW = chn[2][k], wW = chn[3][k], fW = Math.min(chn[4][k], gW), oW = chn[5][k];
      var nD = dryN(wx, wz), nM = dirtN(wx, wz), mc = macN(wx, wz) * 0.75 + mac2(wx, wz) * 0.25, bk = bankN(wx, wz);
      var sdw = sdW[k], sdr = sdR[k];
      var dry = sstep(0.5, 0.7, nD) * 0.92 * (1 - fW * 0.85), dirtP = sstep(0.62, 0.88, nM) * 0.62 * (1 - fW * 0.6);   // B1: Erdflecken weicher und nur teildeckend (vorher 0.64–0.8 · 0.8)
      var Lg = gW * (1 - dry) * (1 - dirtP), Ld = gW * dry * (1 - dirtP), Le = gW * dirtP, Ls = sW, Lr = rW, Lo = 0;
      Le += fW * 0.42 * (0.5 + 0.5 * nM); Lg -= Math.min(Lg, fW * 0.42 * (0.5 + 0.5 * nM));
      // Sandufer (Land nahe Wasser), Wasserbett
      if (sdw < 0 && sdw > -1.15) {
        var bank = sstep(1.15, 0.15, -sdw) * (0.55 + 0.7 * bk); bank = bank > 1 ? 1 : bank;
        var takeG = (Lg + Ld) * bank; var fr = (Lg + Ld) > 1e-4 ? takeG / (Lg + Ld) : 0;
        Lg -= Lg * fr; Ld -= Ld * fr; Ls += takeG;
      }
      if (wW > 0.01) { var mud = sstep(0.1, 1.4, sdw); Ls += wW * (1 - mud); Le += wW * mud; }
      // Felsränder: Geröll + Erde
      if (sdr < 0 && sdr > -1.1) {
        var foot = sstep(0.45, 0.0, -sdr) * 0.6, scr = sstep(1.0, 0.1, -sdr) * 0.55 * (0.5 + nM);
        var tot0 = Lg + Ld + Ls + Le; if (tot0 > 1e-4) { var cut = Math.min(0.9, foot + scr); var kf = 1 - cut; Lg *= kf; Ld *= kf; Ls *= kf; Le *= kf; Lr += tot0 * foot; Le += tot0 * scr; }
      }
      // Straßen-Schotter (Rand), Erz
      if (rdist) {
        var rk = ((Math.min(rh - 1, Math.floor(wz * RF))) * rw + Math.min(rw - 1, Math.floor(wx * RF)));
        var sh = sstep(0.66, 0.4, rdist[rk]) * 0.85;
        if (sh > 0) {
          var tot1 = Lg + Ld + Ls + Le + Lr, sandF = tot1 > 1e-4 ? Ls / tot1 : 0, kk = 1 - sh * 0.75;
          Lg *= kk; Ld *= kk; Lr *= kk; Ls *= 1 - sh * 0.35; Le += sh * (0.75 * (1 - sandF) + 0.3 * sandF);
        }
      }
      if (oW > 0.01) { var oo = Math.min(1, oW * 1.25) * 0.95; var ko = 1 - oo; Lg *= ko; Ld *= ko; Ls *= ko; Le *= ko; Lr *= ko; Lo = oo; }
      Lg = Lg < 0 ? 0 : Lg; Ld = Ld < 0 ? 0 : Ld; Ls = Ls < 0 ? 0 : Ls; Le = Le < 0 ? 0 : Le;
      var sum = Lg + Ld + Le + Ls + Lr + Lo; if (sum < 1e-4) { Lg = 1; sum = 1; }
      var q4 = k * 4, is = 255 / sum;
      splA[q4] = Lg * is; splA[q4 + 1] = Ld * is; splA[q4 + 2] = Le * is; splA[q4 + 3] = Ls * is;
      splB[q4] = Lr * is; splB[q4 + 1] = clamp(mc, 0, 1) * 255; splB[q4 + 2] = Lo * is; splB[q4 + 3] = fW * 255;
      var sdc = sdw < -3 ? -3 : (sdw > 3 ? 3 : sdw);
      shore[k * 2] = (0.5 + sdc / 6) * 255;
      shore[k * 2 + 1] = clamp((WL - hF[k]) / 0.5, 0, 1) * 255;
    }
    fl.splA = splA; fl.splB = splB; fl.shore = shore; stats.fp.push(['splat', now() - tp]);
    // Kachel-Daten für Büschel (Trockenanteil, Eignung)
    var tuftOk = new Uint8Array(W * H), dryT = new Uint8Array(W * H);
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      var kc = (Math.min(ch - 1, y * F + (F >> 1))) * cw + Math.min(cw - 1, x * F + (F >> 1)), q5 = kc * 4;
      var gsum = splA[q5] + splA[q5 + 1], gf = gsum / 255;
      tuftOk[y * W + x] = cls[y * W + x] === 0 && gf > 0.45 && splB[q5 + 3] < 120 ? 1 : 0;
      dryT[y * W + x] = gsum > 0 ? splA[q5 + 1] / gsum * 255 : 0;
    }
    fl.tuftOk = tuftOk; fl.dryT = dryT; fl.cls = cls;
    stats.fieldMs = now() - t0;
    return fl;
  }

  // ------------------------------------------------------------------ Gelände: Mesh, Material
  var TREP = [0.62, 0.62, 0.85, 0.85, 0.5, 0.75, 1.0];
  var TINT_A = [0.9, 0.96, 0.93], TINT_B = [1.08, 1.05, 0.9];   // B1: großflächige Tönung kühl ↔ warm (vorher 0.84,0.94,0.92 ↔ 1.14,1.08,0.86); Shader und Bake
  var VS_TERRAIN = ['varying vec3 vTW; varying vec3 vTN;'].join('\n');
  var FS_HEAD = [
    'uniform sampler2DArray uAlb; uniform sampler2DArray uNrm;',
    'uniform sampler2D uSplA; uniform sampler2D uSplB; uniform sampler2D uRoad; uniform sampler2D uShoreT;',
    'uniform vec2 uInvWH; uniform float uNK;',
    'varying vec3 vTW; varying vec3 vTN;',
    'const float TREP[7] = float[7](0.62, 0.62, 0.85, 0.85, 0.5, 0.75, 1.0);',
    'const float TNS[7] = float[7](1.0, 0.9, 1.0, 0.8, 1.5, 0.8, 1.1);',
    'float tH(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }',
    'float tV(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(tH(i), tH(i + vec2(1.0, 0.0)), f.x), mix(tH(i + vec2(0.0, 1.0)), tH(i + vec2(1.0, 1.0)), f.x), f.y); }'
  ].join('\n');
  var FS_MAP = [
    '  vec2 tP = vTW.xz; vec2 tUV = tP * uInvWH;',
    '  vec4 sA = texture2D(uSplA, tUV); vec4 sB = texture2D(uSplB, tUV);',
    '  vec4 rdT = texture2D(uRoad, tUV); vec2 shT = texture2D(uShoreT, tUV).rg;',
    '  float sdf = (shT.r - 0.5) * 6.0;',
    '  vec3 gnT = normalize(vTN); float slopeT = 1.0 - gnT.y;',
    '  vec2 dxw = dFdx(tP); vec2 dyw = dFdy(tP);',
    '#ifdef T_INK',
    '  dxw *= 4.0; dyw *= 4.0;',          // INK: gröbere Mip-Stufe → ruhige, lasierte Flächen statt Texturkorn (und billigere Zugriffe)
    '#endif',
    '  float wT[7];',
    '  wT[0] = sA.x; wT[1] = sA.y; wT[2] = sA.z; wT[3] = sA.w; wT[4] = sB.x; wT[5] = 0.0; wT[6] = sB.z;',
    '  float rsT = smoothstep(0.21, 0.46, slopeT) * (1.0 - smoothstep(0.0, 0.6, sdf + 0.3));',
    '  for (int i = 0; i < 7; i++) wT[i] *= (1.0 - rsT);',
    '  wT[4] += rsT;',
    '  float rcT = 0.0; vec4 a5T = vec4(0.0);',
    '  if (rdT.a > 0.01) { a5T = textureGrad(uAlb, vec3(tP * TREP[5], 5.0), dxw * TREP[5], dyw * TREP[5]); rcT = smoothstep(0.38, 0.62, rdT.a + (a5T.a - 0.5) * 0.5); }',
    '  vec4 aT[7]; float bT[7]; float maT = -1.0;',
    '  for (int i = 0; i < 7; i++) {',
    '    bT[i] = -1.0; aT[i] = vec4(0.0);',
    '    float wi = wT[i] * (1.0 - rcT);',
    '    if (wi > 0.012) {',
    '      vec2 uvT = tP * TREP[i];',
    '      aT[i] = textureGrad(uAlb, vec3(uvT, float(i)), dxw * TREP[i], dyw * TREP[i]);',
    '#ifndef T_LITE',
    '      if (i == 0) { vec2 u2 = vec2(tP.x * 0.8 - tP.y * 0.6, tP.x * 0.6 + tP.y * 0.8) * TREP[i] * 0.43 + vec2(17.3, 5.7);',
    '        vec4 a2 = textureGrad(uAlb, vec3(u2, float(i)), dxw * TREP[i] * 0.43, dyw * TREP[i] * 0.43);',
    '        aT[i] = mix(aT[i], a2, smoothstep(0.3, 0.7, tV(tP * 0.31 + 3.0)) * 0.62); }',
    '#endif',
    '#ifdef T_LITE',
    '      bT[i] = wi * wi * 2.0 + 0.1 * aT[i].a * wi;',
    '#else',
    '      bT[i] = wi + 0.5 * aT[i].a * (0.25 + wi);',
    '#endif',
    '      maT = max(maT, bT[i]);',
    '    }',
    '  }',
    '  vec3 colT = vec3(0.0); float rghT = 0.0; vec2 nrmT = vec2(0.0); float aoT = 0.0; float totT = 0.0;',
    '  for (int i = 0; i < 7; i++) {',
    '    if (bT[i] > -0.5) {',
    '#ifdef T_LITE',
    '      float bw = max(bT[i] - maT + 0.34, 0.0);',
    '#else',
    '      float bw = max(bT[i] - maT + 0.26, 0.0);',
    '#endif',
    '      if (bw > 0.02) {',
    '        totT += bw; colT += aT[i].rgb * bw;',
    '        vec4 nT = textureGrad(uNrm, vec3(tP * TREP[i], float(i)), dxw * TREP[i], dyw * TREP[i]);',
    '        nrmT += (nT.rg * 2.0 - 1.0) * (bw * TNS[i]); rghT += nT.b * bw; aoT += nT.a * bw;',
    '      }',
    '    }',
    '  }',
    '  float itT = 1.0 / max(totT, 0.001); colT *= itT; nrmT *= itT; rghT *= itT; aoT *= itT;',
    '#ifdef T_INK',
    // INK (Aquarell): Pigment sammelt sich wolkig (weltfeste, großflächige Schwankung) + dunklerer „nasser Rand“ dort, wo zwei Schichten
    // ineinanderlaufen (totT > Einzel-Schicht-Wert); Normalen fast flach, matt
    '  { float wcN = tV(tP * 0.43 + 1.7) * 0.6 + tV(tP * 1.6 + 5.3) * 0.4;',
    '    colT *= 0.9 + 0.2 * wcN;',
    '#ifdef T_LITE',
    '    float wcB = 0.34;',
    '#else',
    '    float wcB = 0.26;',
    '#endif',
    '    float wcE = smoothstep(wcB * 1.05, wcB * 1.3, totT) * (1.0 - smoothstep(wcB * 1.45, wcB * 1.85, totT));',
    '    colT *= 1.0 - 0.13 * wcE; nrmT *= 0.3; aoT = mix(1.0, aoT, 0.5);',
    '    float wcL = dot(colT, vec3(0.2126, 0.7152, 0.0722)); colT = mix(vec3(wcL), colT, 0.7) * vec3(1.04, 1.02, 0.97); }',   // gedeckter Boden → Einheiten heben sich ab
    '#endif',
    '  if (totT < 0.001) { colT = vec3(0.1, 0.2, 0.05); rghT = 0.9; aoT = 1.0; }',
    // Makro-Färbung (Gras/Erde) + Waldboden
    '  float kgT = sA.x + sA.y + sA.z + sA.w * 0.5;',
    '  vec3 tintT = mix(vec3(' + TINT_A.join(', ') + '), vec3(' + TINT_B.join(', ') + '), sB.y);',
    '  colT *= mix(vec3(1.0), tintT, clamp(kgT, 0.0, 1.0) * 0.95);',
    '  colT *= mix(vec3(1.0), vec3(0.7, 0.8, 0.68), sB.w * 0.85);',   // Waldboden (B1: etwas heller – mit den kräftigeren Schatten sonst schwarz)
    // Straße
    '  if (rcT > 0.0) {',
    '    vec4 n5T = textureGrad(uNrm, vec3(tP * TREP[5], 5.0), dxw * TREP[5], dyw * TREP[5]);',
    '    vec3 rcol = a5T.rgb * (1.0 - 0.26 * rdT.b);',
    '    rcol = mix(rcol, vec3(0.85, 0.78, 0.5), clamp(rdT.r * 1.3, 0.0, 1.0));',
    '    rcol = mix(rcol, vec3(0.5, 0.5, 0.46), rdT.g * 0.6);',
    '    colT = mix(colT, rcol, rcT);',
    '    rghT = mix(rghT, n5T.b * (1.0 - 0.3 * rdT.b), rcT);',
    '    nrmT = mix(nrmT, (n5T.rg * 2.0 - 1.0) * 0.8, rcT); aoT = mix(aoT, n5T.a, rcT);',
    '  }',
    // nasser Ufersaum
    '  float wetT = smoothstep(-0.62, -0.1, sdf) * (1.0 - rcT * 0.8);',
    '  colT *= mix(1.0, 0.6, wetT); rghT = mix(rghT, 0.32, wetT * 0.75);',
    '  diffuseColor.rgb *= colT * mix(1.0, aoT, 0.85);',
    '  float tRough = clamp(rghT, 0.2, 1.0); vec2 tNrm = nrmT;'
  ].join('\n');

  /** A3 (Kartenrand): Vorland rund um die Karte. EIN Ring (8 Dreiecke, 1 Draw-Call, unbeleuchteter Shader, keine Schatten): setzt die Farbe der
   *  äußersten Kacheln fort (kleine Farbkarte W×H aus den Schicht-Mittelwerten, Rand-Texel per Clamp, mit Rauschen entlang der Kante verwischt),
   *  genauso abgedunkelt wie der Kartenrand selbst (SH.uEdge) und über ~7 Kacheln in dunklen Dunst auslaufend. Nebel des Krieges wie überall
   *  (Rand-Texel der Nebelkarte) → vor unerkundetem Gebiet bleibt es schwarz. Liegt knapp unter dem Wasserspiegel und reicht eine halbe Kachel
   *  unter die Karte (kein Spalt an der vorderen Kante). */
  function buildApron(m, fl, ly) {
    var W = m.w, H = m.h, N = ly.S * ly.S, mean = [], L, k, x, y;
    for (L = 0; L < NL; L++) {   // mittlere Farbe je Schicht (linear), grob abgetastet
      var r = 0, g = 0, b = 0, n = 0;
      for (k = 0; k < N; k += 37) { var q = (L * N + k) * 4; r += Math.pow(ly.alb[q] / 255, 2.2); g += Math.pow(ly.alb[q + 1] / 255, 2.2); b += Math.pow(ly.alb[q + 2] / 255, 2.2); n++; }
      mean.push([r / n, g / n, b / n]);
    }
    var d = new Uint8Array(W * H * 4), F = fl.F, cw = fl.cw, ch = fl.ch;
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      var kc = Math.min(ch - 1, y * F + (F >> 1)) * cw + Math.min(cw - 1, x * F + (F >> 1)), q4 = kc * 4, o = (y * W + x) * 4;
      var w = [fl.splA[q4], fl.splA[q4 + 1], fl.splA[q4 + 2], fl.splA[q4 + 3], fl.splB[q4], 0, fl.splB[q4 + 2]], cr = 0, cg = 0, cb = 0, ws = 0;
      for (L = 0; L < NL; L++) { cr += mean[L][0] * w[L]; cg += mean[L][1] * w[L]; cb += mean[L][2] * w[L]; ws += w[L]; }
      if (ws > 0) { cr /= ws; cg /= ws; cb /= ws; }
      var wet = sstep(-0.1, 0.5, (fl.shore[kc * 2] / 255 - 0.5) * 6);   // Wasser: dunkles Blau wie die tiefe See
      cr = mix(cr, 0.03, wet); cg = mix(cg, 0.1, wet); cb = mix(cb, 0.17, wet);
      d[o] = Math.pow(cr, 1 / 2.2) * 255; d[o + 1] = Math.pow(cg, 1 / 2.2) * 255; d[o + 2] = Math.pow(cb, 1 / 2.2) * 255; d[o + 3] = 255;
    }
    var tex = makeSplatTex(d, W, H); tex.colorSpace = THREE.SRGBColorSpace; world.texs.push(tex);
    var IN = 0.5, OUT = 70, yy = WL - 0.012;
    var P = [IN, IN, W - IN, IN, W - IN, H - IN, IN, H - IN, -OUT, -OUT, W + OUT, -OUT, W + OUT, H + OUT, -OUT, H + OUT], pos = new Float32Array(24);
    for (k = 0; k < 8; k++) { pos[k * 3] = P[k * 2]; pos[k * 3 + 1] = yy; pos[k * 3 + 2] = P[k * 2 + 1]; }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex([0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0]);
    var mat = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      uniforms: { uCol: { value: tex }, uInv: { value: new THREE.Vector2(1 / W, 1 / H) }, uLit: { value: R.std ? APRON.litStd : APRON.litClassic },
        uFar: { value: new THREE.Vector3().fromArray(R.std ? APRON.far : APRON.farClassic) }, uFow: SH.uFow, uFowOn: SH.uFowOn, uEdge: SH.uEdge },
      vertexShader: 'varying vec2 vP; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vP = w.xz; gl_Position = projectionMatrix * viewMatrix * w; }',
      fragmentShader: [
        'uniform sampler2D uCol; uniform sampler2D uFow; uniform vec2 uInv; uniform float uLit; uniform vec3 uFar; uniform float uFowOn; uniform vec2 uEdge;',
        'varying vec2 vP;',
        'float hsh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }',
        'float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);',
        '  return mix(mix(hsh(i), hsh(i + vec2(1.0, 0.0)), f.x), mix(hsh(i + vec2(0.0, 1.0)), hsh(i + vec2(1.0, 1.0)), f.x), f.y); }',
        'void main(){',
        '  vec2 uv = vP * uInv;',
        '  float d = length(max(max(-uv, uv - 1.0), 0.0) / uInv);',                                  // Abstand zur Karte in Kacheln
        '  float n1 = vn(vP * 0.42), n2 = vn(vP * 1.7 + 7.3);',
        '  vec2 cuv = clamp(uv + (vec2(n1, n2) - 0.5) * uInv * 3.0 * min(d, 1.5), 0.5 * uInv, 1.0 - 0.5 * uInv);',
        '  vec3 c = texture2D(uCol, cuv).rgb * (uLit * uEdge.y * (0.86 + 0.28 * n2));',
        '  c = mix(c, uFar, smoothstep(0.0, 7.0, d + (n1 - 0.5) * 2.2));',
        '  c *= mix(1.0, texture2D(uFow, uv).r, uFowOn);',
        '  gl_FragColor = vec4(c, 1.0);',
        '  #include <tonemapping_fragment>',
        '  #include <colorspace_fragment>',
        '}'].join('\n')
    });
    var mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    world.apron = mesh;
    return mesh;
  }
  var APRON = { far: [0.046, 0.052, 0.06], farClassic: [0.02, 0.025, 0.032], litStd: 1.0, litClassic: 1.5 };   // Dunstfarbe (linear) + Helligkeits-Angleich an den beleuchteten Boden

  function makeSplatTex(data, w, h, fmt) {
    var t = new THREE.DataTexture(data, w, h, fmt || THREE.RGBAFormat, THREE.UnsignedByteType);
    t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearFilter; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.generateMipmaps = false; t.flipY = false; t.needsUpdate = true;
    return t;
  }
  function makeArrayTex(data, S, srgb) {
    var t = new THREE.DataArrayTexture(data, S, S, NL);
    t.format = THREE.RGBAFormat; t.type = THREE.UnsignedByteType;
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true; t.anisotropy = 4; t.flipY = false;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  }

  /** Modern/Lite: Standard-Material mit Splat-Überblendung der Bodenschichten */
  function terrainMaterialStd(fl, ly, texs, lite) {
    var ink = !!R.ink;   // INK: Aquarell-Boden (T_INK)
    var mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
    var U = {
      uAlb: { value: makeArrayTex(ly.alb, ly.S, true) }, uNrm: { value: makeArrayTex(ly.nrm, ly.S, false) },
      uSplA: { value: makeSplatTex(fl.splA, fl.cw, fl.ch) }, uSplB: { value: makeSplatTex(fl.splB, fl.cw, fl.ch) },
      uRoad: { value: fl.road ? makeSplatTex(fl.road, fl.rw, fl.rh) : makeSplatTex(new Uint8Array(4), 1, 1) },
      uShoreT: { value: fl.shoreTex },
      uInvWH: { value: new THREE.Vector2(1 / fl.W, 1 / fl.H) }, uNK: { value: lite ? 0.9 : 1.0 }
    };
    texs.push(U.uAlb.value, U.uNrm.value, U.uSplA.value, U.uSplB.value, U.uRoad.value);
    mat.onBeforeCompile = function (sh) {
      for (var k in U) sh.uniforms[k] = U[k];
      sh.vertexShader = VS_TERRAIN + '\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vTW = position; vTN = normal;');
      sh.fragmentShader = (lite ? '#define T_LITE\n' : '') + (ink ? '#define T_INK\n' : '') + FS_HEAD + '\n' + sh.fragmentShader
        .replace('#include <map_fragment>', FS_MAP)
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = tRough;')
        .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n  { vec3 tpn = (viewMatrix * vec4(tNrm.x, 0.0, tNrm.y, 0.0)).xyz; normal = normalize(normal + tpn * uNK); }');
    };
    mat.customProgramCacheKey = function () { return 'r3t7' + (lite ? 'L' : 'F') + (ink ? 'I' : ''); };
    return fowify(mat);
  }

  /** Pixel/Scharf/Spar: Boden einmalig in eine Canvas-Textur backen (Lambert, kein eigener Shader) */
  function bakeTerrain(m, fl, ly, P, withAO) {
    var W = m.w, H = m.h, cw = W * P, ch = H * P, S = ly.S, mk = S - 1, SS = S * S;
    var c = document.createElement('canvas'); c.width = cw; c.height = ch;
    var g = c.getContext('2d'), img = g.createImageData(cw, ch), d = img.data;
    var alb = ly.alb, nrmA = ly.nrm, F = fl.F, fw = fl.cw, fh = fl.ch, sA = fl.splA, sB = fl.splB, rd = fl.road, RF = fl.RF, rw = fl.rw, hF = fl.hF, sh = fl.shore;
    var lin = new Float32Array(256), i, j, k;
    for (i = 0; i < 256; i++) lin[i] = Math.pow(i / 255, 2.2);
    var wv = new Float32Array(NL), bv = new Float32Array(NL), qi = new Int32Array(NL), pi = 0;
    for (j = 0; j < ch; j++) {
      var wz = (j + 0.5) / P, fy = clamp(wz * F - 0.5, 0, fh - 1.001), j0 = fy | 0, ty = fy - j0;
      for (i = 0; i < cw; i++, pi += 4) {
        var wx = (i + 0.5) / P, fx = clamp(wx * F - 0.5, 0, fw - 1.001), i0 = fx | 0, tx = fx - i0;
        var o00 = (j0 * fw + i0) * 4, o10 = o00 + 4, o01 = o00 + fw * 4, o11 = o01 + 4;
        var w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
        for (k = 0; k < 4; k++) wv[k] = (sA[o00 + k] * w00 + sA[o10 + k] * w10 + sA[o01 + k] * w01 + sA[o11 + k] * w11) / 255;
        wv[4] = (sB[o00] * w00 + sB[o10] * w10 + sB[o01] * w01 + sB[o11] * w11) / 255; wv[5] = 0;
        wv[6] = (sB[o00 + 2] * w00 + sB[o10 + 2] * w10 + sB[o01 + 2] * w01 + sB[o11 + 2] * w11) / 255;
        var mc = (sB[o00 + 1] * w00 + sB[o10 + 1] * w10 + sB[o01 + 1] * w01 + sB[o11 + 1] * w11) / 255;
        var fo = (sB[o00 + 3] * w00 + sB[o10 + 3] * w10 + sB[o01 + 3] * w01 + sB[o11 + 3] * w11) / 255;
        var hk = j0 * fw + i0;
        var gx = (hF[hk + 1] - hF[hk]) * F, gz = (hF[hk + fw] - hF[hk]) * F, gl = Math.sqrt(gx * gx + gz * gz), slope = 1 - 1 / Math.sqrt(1 + gl * gl);
        var sdf = ((sh[hk * 2] / 255) - 0.5) * 6;
        var rs = sstep(0.21, 0.46, slope) * (1 - sstep(0, 0.6, sdf + 0.3));
        var kg = wv[0] + wv[1] + wv[2] + wv[3] * 0.5;
        for (k = 0; k < NL; k++) wv[k] *= 1 - rs;
        wv[4] += rs;
        var rc = 0, rcen = 0, redg = 0, rwear = 0;
        if (rd) {
          var rx = Math.min(rw - 1, (wx * RF) | 0), ry = Math.min(fl.rh - 1, (wz * RF) | 0), rq = (ry * rw + rx) * 4;
          rc = sstep(0.38, 0.62, rd[rq + 3] / 255); rcen = rd[rq] / 255; redg = rd[rq + 1] / 255; rwear = rd[rq + 2] / 255;
        }
        var mx = -1, tot = 0;
        for (k = 0; k < NL; k++) {
          bv[k] = -1;
          var wi = wv[k] * (1 - rc);
          if (wi > 0.02) {
            var tu = ((wx * TREP[k]) % 1 * S) | 0, tv = ((wz * TREP[k]) % 1 * S) | 0;
            bv[k] = wi * wi * 2 + 0.1 * wi; qi[k] = k * SS * 4 + ((tv & mk) * S + (tu & mk)) * 4; if (bv[k] > mx) mx = bv[k];
          }
        }
        var cr = 0, cg = 0, cb = 0, ao = 0;
        for (k = 0; k < NL; k++) if (bv[k] > -0.5) { var bw = bv[k] - mx + 0.34; if (bw > 0) { var q = qi[k]; tot += bw; cr += lin[alb[q]] * bw; cg += lin[alb[q + 1]] * bw; cb += lin[alb[q + 2]] * bw; if (withAO) ao += nrmA[q + 3] * bw; } }
        if (tot > 0) { cr /= tot; cg /= tot; cb /= tot; ao /= tot * 255; } else { cr = 0.07; cg = 0.18; cb = 0.03; ao = 1; }
        if (withAO) { var aof = 1 + (ao - 1) * 0.85; cr *= aof; cg *= aof; cb *= aof; }   // v0.8: wie der Boden-Shader (Hohlraum-Abdunklung der Schichten)
        var kk = clamp(kg, 0, 1) * 0.95;
        cr *= 1 + (mix(TINT_A[0], TINT_B[0], mc) - 1) * kk; cg *= 1 + (mix(TINT_A[1], TINT_B[1], mc) - 1) * kk; cb *= 1 + (mix(TINT_A[2], TINT_B[2], mc) - 1) * kk;
        cr *= 1 - 0.30 * fo * 0.85; cg *= 1 - 0.20 * fo * 0.85; cb *= 1 - 0.32 * fo * 0.85;
        if (rc > 0) {
          var rq2 = 5 * SS * 4 + ((((wz * TREP[5]) % 1 * S) | 0) & mk) * S * 4 + ((((wx * TREP[5]) % 1 * S) | 0) & mk) * 4;
          var wf2 = 1 - 0.26 * rwear, ar = lin[alb[rq2]] * wf2, ag = lin[alb[rq2 + 1]] * wf2, ab = lin[alb[rq2 + 2]] * wf2;
          ar = mix(ar, 0.66, rcen * 0.95); ag = mix(ag, 0.6, rcen * 0.95); ab = mix(ab, 0.36, rcen * 0.95);
          ar = mix(ar, 0.5, redg * 0.6); ag = mix(ag, 0.5, redg * 0.6); ab = mix(ab, 0.46, redg * 0.6);
          cr = mix(cr, ar, rc); cg = mix(cg, ag, rc); cb = mix(cb, ab, rc);
        }
        var wf = 1 - 0.4 * sstep(-0.62, -0.1, sdf) * (1 - rc * 0.8);
        d[pi] = Math.pow(cr * wf, 1 / 2.2) * 255; d[pi + 1] = Math.pow(cg * wf, 1 / 2.2) * 255; d[pi + 2] = Math.pow(cb * wf, 1 / 2.2) * 255; d[pi + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    var tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace; tex.flipY = false; tex.anisotropy = 4; tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
    world.texCanvas = c;
    return tex;
  }

  /** v0.8 (Flag terrainArray aus, PowerVR-Start): Modern-Boden ohne eigenen Shader – die Splat-Überblendung (gleiche Schichten, Makro-Färbung,
   *  Straßen, nasses Ufer, Hohlraum-AO) wird EINMAL beim Kartenaufbau in eine 2D-Canvas-Textur gebacken (Seite ≤ 2048, 9–20 px je Kachel)
   *  und mit MeshStandardMaterial (Material-Fabrik 'terrain') gezeichnet. Keine Textur-Arrays, kein textureGrad, keine Schleifen im Shader. */
  function bakedStd(m, fl, ly) {
    var P = clamp(Math.floor(2048 / Math.max(m.w, m.h)), 9, 32);   // W11-look: bis 32 px je Kachel (vorher 20; Seite bleibt ≤ 2048, einmal je Karte)
    var tex = bakeTerrain(m, fl, ly, P, true);
    tex.anisotropy = 2;
    world.texs.push(tex);
    var mat = M3.material('terrain', { map: tex });
    if ((R.F || {}).liteLook) addDetail(mat, m);   // W11-look: feines Korn über dem gebackenen Boden (Flag liteLook)
    return mat;
  }
  /** W11-look: kachelbare Kornstruktur (256², 1 Kanal, einmal erzeugt) – 2,5 Wiederholungen je Kachel über die gebackene Bodentextur
   *  moduliert. Ersetzt die Schärfe der Modern-Detailtexturen ohne Textur-Arrays/Schleifen; keine Kosten je Bild außer einem Textur-Zugriff. */
  var detTex = null;
  function detailTex() {
    if (detTex) return detTex;
    var S = 256, d = new Uint8Array(S * S), f1 = mkFbm(8, 3, 131), f2 = mkFbm(32, 3, 137), f3 = mkFbm(64, 2, 139);
    for (var j = 0; j < S; j++) for (var i = 0; i < S; i++) {
      var u = i / S, v = j / S, n = 0.3 * f1(u, v) + 0.4 * f2(u, v) + 0.3 * f3(u, v) + (fh(i, j, 141) - 0.5) * 0.25;
      d[j * S + i] = clamp(128 + (n - 0.5) * 2.4 * 255, 0, 255);
    }
    detTex = new THREE.DataTexture(d, S, S, THREE.RedFormat, THREE.UnsignedByteType);
    detTex.wrapS = detTex.wrapT = THREE.RepeatWrapping; detTex.magFilter = THREE.LinearFilter; detTex.minFilter = THREE.LinearMipmapLinearFilter;
    detTex.generateMipmaps = true; detTex.needsUpdate = true;
    return detTex;
  }
  function addDetail(mat, m) {
    var prev = mat.onBeforeCompile, prevKey = mat.customProgramCacheKey, rep = new THREE.Vector2(m.w * 2.5, m.h * 2.5), dt = detailTex();
    mat.onBeforeCompile = function (sh, rr) {
      prev.call(mat, sh, rr);
      sh.uniforms.uDet = { value: dt }; sh.uniforms.uDetRep = { value: rep };
      sh.fragmentShader = 'uniform sampler2D uDet; uniform vec2 uDetRep;\n' + sh.fragmentShader.replace('#include <map_fragment>',
        '#include <map_fragment>\n  { float dn = texture2D(uDet, vMapUv * uDetRep).r; diffuseColor.rgb *= 0.74 + 0.52 * dn; }');
    };
    mat.customProgramCacheKey = function () { return 'det1' + (prevKey ? prevKey.call(mat) : ''); };
  }

  // ------------------------------------------------------------------ Welt bauen
  function disposeWorld() {
    if (!world) return;
    world.group.traverse(function (o) {
      if (o.geometry) o.geometry.dispose();
      if (o.material && o.material !== MAT.std && o.material !== MAT.ore) {
        if (o.material.map) o.material.map.dispose();
        if (o.material.uniforms && o.material.uniforms.uShore) o.material.uniforms.uShore.value.dispose();
        o.material.dispose();
      }
      if (o.isInstancedMesh) o.dispose();
    });
    if (world.texs) world.texs.forEach(function (t) { t.dispose(); });
    scene.remove(world.group);
    world = null; R.world = null;
  }

  function buildWorld(m) {
    var tb = now();
    scene = R.scene; SH = R.SH; safeGPU = R.safeGPU;
    disposeWorld();
    var W = m.w, H = m.h;
    mapRef = m;
    var std = !!R.std, lite = !!R.lite, FF = R.F || {};
    var cf = std ? (lite ? { S: 128, F: 4, RF: 8, N: 3, tuft: 2, wind: false, mode: 'lite' } : { S: 192, F: 5, RF: 12, N: 3, tuft: 4, wind: true, mode: 'modern' })
      : { S: 128, F: 4, RF: 8, N: 2, tuft: 0, wind: false, mode: 'classic' };
    // v0.8 Flags: grass (G) → Büschel, wind (L) → Wind-Vertex-Shader, hiPoly (V) → Baum-Detail, terrainArray (B) → Boden-Shader oder gebackene Textur
    if (std) { if (!FF.grass) cf.tuft = 0; cf.wind = !!FF.wind; }
    if (R.ink) cf.tuft = 0;   // INK: keine Gras-Büschel – im Zeichenstil nur Unruhe (jedes Büschel bekäme eine Kontur); spart Dreiecke
    cf.hiPoly = std && !!FF.hiPoly;
    cf.array = std && FF.terrainArray !== false;
    // v0.9 große Turnierkarten (> 96 Kacheln Seite): Gelände-Gitter 1 Unterteilung weniger (128×128: 257² statt 385² Punkte),
    // Straßen-/Splat-Felder höchstens 2048 je Seite
    var MX = Math.max(W, H);
    if (MX > 96) cf.N = Math.max(2, cf.N - 1);
    cf.RF = Math.min(cf.RF, Math.floor(2048 / MX)); cf.F = Math.min(cf.F, Math.floor(2048 / MX));
    world = { group: new THREE.Group(), W: W, H: H, cfg: cf, texs: [] };
    scene.add(world.group);
    stats.layerMs = 0;
    var ly = genLayers(cf.S);
    var fl = buildFields(m, cf);
    world.fl = null;
    // Wasser-/Ufer-Textur (RG: Distanzfeld, Tiefe)
    var shoreTex = makeSplatTex(fl.shore, fl.cw, fl.ch, THREE.RGFormat);
    fl.shoreTex = shoreTex; world.texs.push(shoreTex);
    // --- Höhen: Gitter mit N Unterteilungen je Kachel (bilinear aus dem Felsfeld)
    var Nn = cf.N, GW = Nn * W + 1, GH = Nn * H + 1, hts = new Float32Array(GW * GH), i, j, k;
    var F = fl.F, fw = fl.cw, fh = fl.ch, hF = fl.hF;
    for (j = 0; j < GH; j++) {
      var zf = clamp((j / Nn) * F - 0.5, 0, fh - 1.001), j0 = zf | 0, tz = zf - j0;
      for (i = 0; i < GW; i++) {
        var xf = clamp((i / Nn) * F - 0.5, 0, fw - 1.001), i0 = xf | 0, tx = xf - i0, o = j0 * fw + i0;
        hts[j * GW + i] = hF[o] * (1 - tx) * (1 - tz) + hF[o + 1] * tx * (1 - tz) + hF[o + fw] * (1 - tx) * tz + hF[o + fw + 1] * tx * tz;
      }
    }
    world.hts = hts; world.GW = GW; world.GH = GH; world.res = Nn;
    // --- Geländegeometrie
    var pos = new Float32Array(GW * GH * 3), uv = new Float32Array(GW * GH * 2), idx = (GW * GH > 65000) ? new Uint32Array((GW - 1) * (GH - 1) * 6) : new Uint16Array((GW - 1) * (GH - 1) * 6), ii = 0;
    for (j = 0; j < GH; j++) for (i = 0; i < GW; i++) {
      k = j * GW + i;
      pos[k * 3] = i / Nn; pos[k * 3 + 1] = hts[k]; pos[k * 3 + 2] = j / Nn;
      uv[k * 2] = i / Nn / W; uv[k * 2 + 1] = j / Nn / H;
    }
    for (j = 0; j < GH - 1; j++) for (i = 0; i < GW - 1; i++) {
      var p0 = j * GW + i, p1 = p0 + 1, p2 = p0 + GW, p3 = p2 + 1;
      if ((i + j) & 1) { idx[ii++] = p0; idx[ii++] = p2; idx[ii++] = p1; idx[ii++] = p1; idx[ii++] = p2; idx[ii++] = p3; }
      else { idx[ii++] = p0; idx[ii++] = p2; idx[ii++] = p3; idx[ii++] = p0; idx[ii++] = p3; idx[ii++] = p1; }
    }
    var tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    tg.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    tg.setIndex(new THREE.BufferAttribute(idx, 1));
    tg.computeVertexNormals();
    stats.tris = idx.length / 3;
    var tmat;
    if (cf.array) tmat = terrainMaterialStd(fl, ly, world.texs, lite);
    else if (std) tmat = bakedStd(m, fl, ly);     // v0.8: Flag terrainArray aus → Splat-Überblendung einmal in EINE 2D-Textur (≤ 2048) backen
    else { tmat = M3.material('terrain', { map: bakeTerrain(m, fl, ly, 9) }); }
    var terrain = new THREE.Mesh(tg, tmat);
    terrain.receiveShadow = true;
    world.group.add(terrain);
    // Rand um die Karte (dunkler „Sockel“, damit der Kartenrand nicht im Nichts endet)
    world.group.add(buildApron(m, fl, ly));   // A3: abgedunkeltes Vorland, das in Dunst ausläuft (vorher einfarbig fast schwarze Fläche)
    // Texturspeicher (Näherung, Byte)
    var tb2 = 0;
    if (cf.array) tb2 = (ly.alb.length + ly.nrm.length) * 1.34 + fl.splA.length + fl.splB.length + (fl.road ? fl.road.length : 4);
    else if (std && world.texCanvas) tb2 = world.texCanvas.width * world.texCanvas.height * 4 * 1.34 + (world.detailBytes || 0);
    tb2 += fl.shore.length + W * H * 4;   // + Farbkarte des Vorlands (A3)
    world.fl = fl;
    buildWater(m, fl);
    buildStatics(m, fl);
    ensureDecals();
    world.occ = new Uint8Array(W * H); world.occT = -999; world.tuftKey = '';
    world.tuftsBuilt = false;
    buildScatter(m, fl);
    if (std) tb2 += (world.waterTexBytes || 0);
    stats.texBytes = tb2; stats.buildMs = now() - tb; stats.genMs = ly.ms;
    world.stats = stats;
    R.world = world;
    return world;
  }

  // ------------------------------------------------------------------ Wasser
  function buildWater(m, fl) {
    var W = m.w, H = m.h, any = false, i;
    for (i = 0; i < W * H; i++) { var t = D.TERRAIN[m.terrain[i]].id; if (t === 'water' || t === 'bridge') { any = true; break; } }
    if (!any) return;
    var shore = fl.shoreTex;
    var quad = function () {
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, W, 0, 0, 0, 0, H, W, 0, H]), 3));
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), 2));
      g.setIndex([0, 2, 1, 1, 2, 3]); g.computeVertexNormals(); return g;
    };
    if (!(R.F || {}).waterShader) {
      // v0.8 Flag waterShader aus (PowerVR-Start): einfaches, durchscheinendes Wasser ohne eigenen Shader – Ufer/Tiefe/Schaum einmal in eine Textur gebacken
      var tex = bakeWaterTex(fl, W, H), smat;
      if (R.std) smat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.16, metalness: 0.1, transparent: true, depthWrite: false });
      else smat = new THREE.MeshLambertMaterial({ map: tex, transparent: true, depthWrite: false });
      smat = fowify(smat);
      var splane = new THREE.Mesh(quad(), smat);
      splane.position.set(0, WL, 0);
      world.group.add(splane); world.texs.push(tex); world.water = null;
      return;
    }
    var mat;
    if (R.std) mat = modernWater(shore, W, H, !!R.lite);
    else {
      // klassisch: R8-Maske m (0.5 = Ufer, → 1 tief) aus dem Distanzfeld
      var data = new Uint8Array(fl.cw * fl.ch);
      for (i = 0; i < data.length; i++) { var sd = (fl.shore[i * 2] / 255 - 0.5) * 6; data[i] = clamp(0.5 + 0.5 * (sd + 0.1), 0, 1) * 255; }
      var mt = makeSplatTex(data, fl.cw, fl.ch, THREE.RedFormat); world.texs.push(mt);
      mat = classicWater(mt, W, H);
    }
    var plane = new THREE.Mesh(quad(), mat);
    plane.position.set(0, WL, 0);
    plane.renderOrder = 0;
    world.group.add(plane);
    world.water = mat;
    if (R.mark) R.mark('waterShader');
  }

  function bakeWaterTex(fl, W, H) {
    var cw = fl.cw, ch = fl.ch, c = document.createElement('canvas'); c.width = cw; c.height = ch;
    var g = c.getContext('2d'), img = g.createImageData(cw, ch), d = img.data, k;
    for (k = 0; k < cw * ch; k++) {
      var sdf = (fl.shore[k * 2] / 255 - 0.5) * 6 + 0.1, dep = fl.shore[k * 2 + 1] / 255, q = k * 4;
      var deep = sstep(0.0, 0.7, dep) * 0.7 + sstep(0.2, 1.8, sdf) * 0.3;
      var r = mix(46, 14, deep), gg = mix(120, 66, deep), b = mix(122, 96, deep);
      var foam = sstep(0.2, 0.0, sdf) * sstep(-0.12, 0.0, sdf);
      r = mix(r, 224, foam * 0.8); gg = mix(gg, 232, foam * 0.8); b = mix(b, 230, foam * 0.8);
      var a = mix(0.34, 0.9, sstep(0.0, 0.6, dep)) + foam * 0.3; if (dep <= 0.001 && sdf < 0.05) a *= sstep(-0.1, 0.05, sdf);
      d[q] = r; d[q + 1] = gg; d[q + 2] = b; d[q + 3] = clamp(a, 0, 1) * 255;
    }
    g.putImageData(img, 0, 0);
    var tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.flipY = false;
    tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
    return tex;
  }

  function classicWater(shore, W, H) {
    return new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { uTime: { value: 0 }, uShore: { value: shore }, uInv: { value: new THREE.Vector2(1 / W, 1 / H) },
        uFow: SH.uFow, uFowScale: SH.uFowScale, uFowOn: SH.uFowOn, uHazeCol: SH.uHazeCol, uHaze: SH.uHaze, uEdge: SH.uEdge },
      vertexShader: 'varying vec3 vW; varying float vD; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; vec4 mv = viewMatrix * w; vD = -mv.z; gl_Position = projectionMatrix * mv; }',
      fragmentShader: [
        'uniform float uTime; uniform sampler2D uShore; uniform vec2 uInv; uniform sampler2D uFow; uniform vec2 uFowScale; uniform float uFowOn; uniform vec3 uHazeCol; uniform vec3 uHaze; uniform vec2 uEdge;',
        'varying vec3 vW; varying float vD;',
        'void main(){',
        '  vec2 uv = vW.xz * uInv; float m = texture2D(uShore, uv).r; float t = uTime;',
        '  float w = sin(vW.x*3.1 + t*1.3) * sin(vW.z*2.7 - t*1.1) + 0.5*sin((vW.x+vW.z)*5.3 + t*2.1) + 0.3*sin((vW.x-vW.z)*9.0 - t*2.7);',
        '  vec3 deep = vec3(0.02, 0.10, 0.20); vec3 shallow = vec3(0.07, 0.30, 0.36);',
        '  vec3 col = mix(shallow, deep, smoothstep(0.55, 0.95, m));',
        '  col += vec3(0.03, 0.05, 0.06) * w;',
        '  col += vec3(0.55, 0.6, 0.55) * smoothstep(1.25, 1.55, w);',
        '  float foam = smoothstep(0.66, 0.5, m) * (0.55 + 0.45 * sin(t*2.0 + vW.x*7.0 + vW.z*5.0)) * smoothstep(0.3, 0.5, m);',
        '  col = mix(col, vec3(0.75, 0.82, 0.85), foam * 0.75);',
        '  float a = mix(0.45, 0.9, smoothstep(0.5, 0.9, m)) * smoothstep(0.32, 0.5, m);',
        '  vec2 fowUV = vW.xz * uFowScale; float fowV = mix(1.0, texture2D(uFow, fowUV).r, uFowOn);',
        '  vec2 edQ = min(fowUV, 1.0 - fowUV) / uFowScale; fowV *= clamp(min(edQ.x, edQ.y) * uEdge.x + uEdge.y, 0.0, 1.0);',
        '  float hz = clamp((vD - uHaze.x) / (uHaze.y - uHaze.x), 0.0, 1.0) * uHaze.z * uFowOn;',
        '  col = mix(col, uHazeCol, hz) * fowV;',
        '  gl_FragColor = vec4(col, a);',
        '  #include <tonemapping_fragment>',
        '  #include <colorspace_fragment>',
        '}'].join('\n')
    });
  }

  /** Modern/Lite: Wasser mit weichen Wellen-Normalen, Tiefenverlauf aus Distanzfeld + Bett-Tiefe, Himmelsspiegelung, Sonnenglanz,
   *  weichem Ufer-Schaum (Distanzfeld) und sanfter Strömung. Nur Rechnung im Shader (keine Render-Targets) → auch für Lite. */
  function modernWater(shore, W, H, lite) {
    var V = R.V, cs = Math.cos(V.PITCH), sn = Math.sin(V.PITCH);
    return new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { uTime: { value: 0 }, uShore: { value: shore }, uInv: { value: new THREE.Vector2(1 / W, 1 / H) },
        uView: { value: new THREE.Vector3((V.sy || 0) * cs, sn, (V.cy == null ? 1 : V.cy) * cs) },   // W11: Kern führt uView/uSun jedes Frame nach (YAW)
        uSun: { value: new THREE.Vector3().fromArray(V.lightDir ? V.lightDir([-0.62, 0.68, -0.4]) : [-0.62, 0.68, -0.4]).normalize() },
        uFow: SH.uFow, uFowScale: SH.uFowScale, uFowOn: SH.uFowOn, uHazeCol: SH.uHazeCol, uHaze: SH.uHaze, uEdge: SH.uEdge },
      vertexShader: 'varying vec3 vW; varying float vD; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; vec4 mv = viewMatrix * w; vD = -mv.z; gl_Position = projectionMatrix * mv; }',
      fragmentShader: [
        (lite ? '#define W_LITE' : ''), (R.ink ? '#define W_INK' : ''),
        'uniform float uTime; uniform sampler2D uShore; uniform vec2 uInv; uniform vec3 uView; uniform vec3 uSun;',
        'uniform sampler2D uFow; uniform vec2 uFowScale; uniform float uFowOn; uniform vec3 uHazeCol; uniform vec3 uHaze; uniform vec2 uEdge;',
        'varying vec3 vW; varying float vD;',
        'float hsh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }',
        'float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);',
        '  return mix(mix(hsh(i), hsh(i + vec2(1.0, 0.0)), f.x), mix(hsh(i + vec2(0.0, 1.0)), hsh(i + vec2(1.0, 1.0)), f.x), f.y); }',
        'float wav(vec2 p, float t){',
        '  vec2 fl = vec2(t * 0.16, t * 0.07);',                                                                   // sanfte Strömung
        '  float s = vn(p * 1.3 + vec2(t * 0.35, t * 0.22) + fl) * 0.6 + vn(p * 2.9 - vec2(t * 0.28, -t * 0.4) + fl * 1.7) * 0.3;',
        '#ifndef W_LITE',
        '  s += vn(p * 6.1 + vec2(-t * 0.6, t * 0.5)) * 0.1;',
        '#endif',
        '  return s; }',
        'void main(){',
        '  vec2 uv = vW.xz * uInv; vec2 tx = texture2D(uShore, uv).rg; float t = uTime;',
        '  float sdf = (tx.r - 0.5) * 6.0 + 0.1; float dep = tx.g;',                                         // sdf: 0 = Wasserlinie, > 0 Wasser
        '  float e = 0.06, h0 = wav(vW.xz, t);',
        // v0.9: Wellen-Normalen flacher (vorher × 3.2) – auf großen offenen Flächen bei starkem Zoom dominierten Himmelsspiegelung + Sonnenglanz
        // (fleckig weiß); jetzt tiefes Blau mit dezenten Lichtern: Fresnel-Himmel ≤ 0.2, Glanz schmal und schwächer, Wellenhelligkeit ± 9 %.
        '  vec3 n = normalize(vec3((h0 - wav(vW.xz + vec2(e, 0.0), t)) * 1.5, 1.0, (h0 - wav(vW.xz + vec2(0.0, e), t)) * 1.5));',
        '  float dd = smoothstep(0.0, 0.8, dep) * 0.7 + smoothstep(0.3, 2.2, sdf) * 0.3;',
        '  vec3 deep = vec3(0.012, 0.062, 0.13), shallow = vec3(0.05, 0.26, 0.27);',
        '  vec3 col = mix(shallow, deep, dd);',
        '  col = mix(col, vec3(0.1, 0.34, 0.24), smoothstep(0.25, 0.0, dep) * 0.35);',                           // flaches Wasser: Sandgrün
        '  float fr = 0.04 + 0.96 * pow(1.0 - max(dot(n, uView), 0.0), 5.0);',
        '  vec3 sky = mix(vec3(0.4, 0.54, 0.7), vec3(0.24, 0.4, 0.64), n.y);',
        '  col = mix(col, sky, clamp(fr * 0.9 + 0.04, 0.0, 0.2));',
        '  vec3 hv = normalize(uSun + uView); float ndh = max(dot(n, hv), 0.0);',
        '  col += vec3(1.0, 0.93, 0.8) * (pow(ndh, 1800.0) * 0.5 + pow(ndh, 90.0) * 0.02);',
        '  col *= 0.91 + 0.18 * h0;',
        // Schaum: dünner Saum an der Wasserlinie + auslaufende Wellenlinien
        '  float fn = vn(vW.xz * 4.5 + vec2(t * 0.35, -t * 0.22));',
        '  float rim = smoothstep(0.26, 0.02, sdf) * smoothstep(-0.14, 0.02, sdf) * (0.5 + 0.9 * fn);',
        '  float rip = 0.5 + 0.5 * sin(sdf * 17.0 - t * 1.5 + fn * 5.0);',
        '  float lines = smoothstep(0.82, 0.98, rip) * smoothstep(0.7, 0.18, sdf) * smoothstep(0.04, 0.2, sdf) * smoothstep(0.35, 0.7, fn);',
        '  float foam = clamp(rim + lines * 0.7, 0.0, 1.0);',
        '  col = mix(col, vec3(0.9, 0.94, 0.94), foam * 0.85);',
        '  float a = mix(0.32, 0.97, smoothstep(0.0, 0.55, dep)) + foam * 0.35;',
        '#ifdef W_INK',
        // INK: gezeichnetes Wasser – 3 klare Tonstufen nach Tiefe (statt Verlauf + Spiegelung + Glanz), weltfeste Wellen-Striche (kurze, leicht
        // geschwungene helle Linien, die langsam treiben), harte Schaumkante am Ufer mit dunkler Tuschelinie an der Wasserlinie
        '  { float aw = fwidth(dd) + 0.01;',
        '    float s1 = smoothstep(0.22 - aw, 0.22 + aw, dd), s2 = smoothstep(0.58 - aw, 0.58 + aw, dd);',
        '    col = mix(mix(vec3(0.17, 0.42, 0.45), vec3(0.075, 0.25, 0.36), s1), vec3(0.04, 0.14, 0.25), s2);',
        '    vec2 fd = normalize(uView.xz + vec2(1e-4)), sd = vec2(fd.y, -fd.x);',                               // Bildschirm-oben / -rechts am Boden (dreht mit YAW)
        '    vec2 wp = vec2(dot(vW.xz, sd), dot(vW.xz, fd));',
        '    float wy = wp.y * 1.8 + sin(wp.x * 1.1 + t * 0.5) * 0.3 + vn(wp * 0.35) * 1.4 + t * 0.1;',            // Striche ≈ waagrecht, leicht geschwungen
        '    float wl = abs(fract(wy) - 0.5), wf = fwidth(wy);',
        '    float dash = smoothstep(0.72, 0.86, vn(vec2(wp.x * 1.6 - t * 0.2, floor(wy) * 3.7)));',
        '    float stroke = (1.0 - smoothstep(0.035, 0.035 + wf * 1.2, wl)) * dash * smoothstep(0.15, 0.6, sdf) * (1.0 - smoothstep(0.25, 0.6, wf));',
        '    col = mix(col, vec3(0.72, 0.84, 0.86), stroke * 0.75);',
        '    float fw = fwidth(sdf) + 0.004, fb = 0.17 + 0.07 * fn;',
        '    float rimI = 1.0 - smoothstep(fb - fw, fb + fw, sdf);',                                              // Schaumband (hart begrenzt)
        '    col = mix(col, vec3(0.93, 0.93, 0.88), rimI * 0.92);',
        '    float edgeL = 1.0 - smoothstep(fw * 0.6, fw * 2.2, abs(sdf - fb));',                                 // Tuschelinie an der Schaumkante
        '    col = mix(col, vec3(0.06, 0.14, 0.18), edgeL * 0.55);',
        '    float shoreL = 1.0 - smoothstep(fw * 0.8, fw * 2.6, abs(sdf + 0.03));',                              // und an der Wasserlinie
        '    col = mix(col, vec3(0.08, 0.075, 0.07), shoreL * 0.8);',
        '    a = mix(0.55, 0.97, smoothstep(0.0, 0.35, dep)); a = max(a, rimI * 0.95); a = max(a, shoreL * 0.85); }',
        '#endif',
        '  a *= smoothstep(-0.16, -0.01, sdf);',
        '  vec2 fowUV = vW.xz * uFowScale; float fowV = mix(1.0, texture2D(uFow, fowUV).r, uFowOn);',
        '  vec2 edQ = min(fowUV, 1.0 - fowUV) / uFowScale; fowV *= clamp(min(edQ.x, edQ.y) * uEdge.x + uEdge.y, 0.0, 1.0);',
        '  float hz = clamp((vD - uHaze.x) / (uHaze.y - uHaze.x), 0.0, 1.0) * uHaze.z * uFowOn;',
        '  col = mix(col, uHazeCol, hz) * fowV;',
        '  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));',
        '  #include <tonemapping_fragment>',
        '  #include <colorspace_fragment>',
        '}'].join('\n')
    });
  }

  // ------------------------------------------------------------------ Vegetation: Bausteine
  /** kleiner Geometrie-Sammler: flach schattiert, Vertexfarbe, Wind-Gewicht (Höhe) */
  // C1 (Vegetation/Felsen): optional „rund“ (round 0..1) – die Normale eines Teils wird zur Richtung vom Teil-Mittelpunkt hin gemischt
  // (Kugel-Normalen): Kronen und Brocken wirken weich und bauschig statt kantig-klotzig, OHNE ein einziges Dreieck mehr; dazu wird die
  // Unterseite jedes runden Teils abgedunkelt (Eigenschatten/Laubtiefe). round = 0/undefined → wie bisher flach schattiert.
  function Acc() { this.p = []; this.c = []; this.y = []; this.n = []; }
  Acc.prototype.add = function (geo, col, x, y, z, sx, sy, sz, ry, jit, round, up) {
    var g = geo.index ? geo.toNonIndexed() : geo, p = g.attributes.position, C = new THREE.Color(col), v = new THREE.Vector3();
    var cy = Math.cos(ry || 0), sy2 = Math.sin(ry || 0), i, y0 = 1e9, y1 = -1e9;
    if (round) for (i = 0; i < p.count; i++) { var py = p.getY(i) * sy; if (py < y0) y0 = py; if (py > y1) y1 = py; }
    for (i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      if (jit) { var hh = hash((v.x * 977) | 0, (v.y * 977 + v.z * 131) | 0, 7 + ((jit * 10) | 0)); var rr = 1 + (hh - 0.5) * 2 * jit; v.multiplyScalar(rr); }
      v.x *= sx; v.y *= sy; v.z *= sz;
      var rx = v.x * cy + v.z * sy2, rz = -v.x * sy2 + v.z * cy;
      this.p.push(rx + x, v.y + y, rz + z);
      var f = 0.74 + 0.4 * clamp((v.y + y) / 0.8, 0, 1);
      if (round) {
        f *= 0.66 + 0.36 * sstep(0, 1, (v.y - y0) / Math.max(1e-4, y1 - y0));
        var ym = (y0 + y1) * 0.5, nl = Math.sqrt(rx * rx + (v.y - ym) * (v.y - ym) + rz * rz) || 1;
        this.n.push(round, rx / nl, (v.y - ym) / nl + (up || 0.25), rz / nl);
      } else this.n.push(0, 0, 0, 0);
      this.c.push(C.r * f, C.g * f, C.b * f); this.y.push(v.y + y);
    }
    if (g !== geo) g.dispose();
    geo.dispose();
    return this;
  };
  Acc.prototype.geo = function (hmax) {
    var out = new THREE.BufferGeometry(), n = this.y.length, w = new Float32Array(n), i;
    for (i = 0; i < n; i++) w[i] = clamp(this.y[i] / hmax, 0, 1);
    out.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    out.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    out.setAttribute('aWind', new THREE.BufferAttribute(w, 1));
    out.computeVertexNormals();
    var na = out.attributes.normal, nn = this.n;
    for (i = 0; i < n; i++) {
      var k = nn[i * 4];
      if (k > 0) {
        var ax = na.getX(i) * (1 - k) + nn[i * 4 + 1] * k, ay = na.getY(i) * (1 - k) + nn[i * 4 + 2] * k, az = na.getZ(i) * (1 - k) + nn[i * 4 + 3] * k, al = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
        na.setXYZ(i, ax / al, ay / al, az / al);
      }
    }
    out.computeBoundingSphere();
    return out;
  };
  var windU = { uWT: { value: 0 } };
  /** Pflanzen-Material: Vertexfarben; Modern: Wind (Vertex-Shader, nur Bewegung) */
  function plantMaterial(wind, doubleSide) {
    var mat;
    if (R.std) mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0, side: doubleSide ? THREE.DoubleSide : THREE.FrontSide });
    else mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: doubleSide ? THREE.DoubleSide : THREE.FrontSide });
    if (wind) {
      mat.onBeforeCompile = function (sh) {
        sh.uniforms.uWT = windU.uWT;
        sh.vertexShader = 'attribute float aWind; uniform float uWT;\n' + sh.vertexShader.replace('#include <begin_vertex>',
          '#include <begin_vertex>\n' +
          '  float wPh = 0.0;\n#ifdef USE_INSTANCING\n  wPh = instanceMatrix[3].x * 0.9 + instanceMatrix[3].z * 0.7;\n#endif\n' +
          '  float wA = aWind * aWind;\n' +
          '  transformed.x += (sin(uWT * 1.6 + wPh) * 0.7 + sin(uWT * 3.1 + wPh * 1.7) * 0.3) * 0.032 * wA;\n' +
          '  transformed.z += sin(uWT * 1.25 + wPh * 1.3 + 1.7) * 0.018 * wA;');
      };
      mat.customProgramCacheKey = function () { return 'r3tw1'; };
    }
    return fowify(mat);
  }

  function treeGeos() {
    var lowp = !(world && world.cfg && world.cfg.hiPoly);   // v0.8: Flag hiPoly (V); Lite/klassisch wie bisher grob
    var det = lowp ? 0 : 1, T = THREE;
    // C1: Kronen „rund“ schattiert (Kugel-Normalen, dunklere Unterseite), Farben etwas gedeckter und zum neuen Gras passend; gleiche Dreieckszahl
    // Kiefer
    var pine = new Acc();
    pine.add(new T.CylinderGeometry(0.026, 0.04, 0.2, 5), '#5b3d24', 0, 0.1, 0, 1, 1, 1, 0);
    pine.add(new T.ConeGeometry(0.22, 0.34, 7), '#356d4c', 0, 0.3, 0, 1, 1, 1, 0.3, 0.06, 0.8, 0.6);   // Kegel: Normalen stärker nach oben (Mantel stand fast senkrecht → von der Kamera aus schwarz)
    pine.add(new T.ConeGeometry(0.18, 0.32, 7), '#3c7854', 0, 0.5, 0, 1, 1, 1, 0.9, 0.06, 0.8, 0.6);
    pine.add(new T.ConeGeometry(0.13, 0.3, 7), '#44845c', 0, 0.68, 0, 1, 1, 1, 0.5, 0.05, 0.8, 0.6);
    pine.add(new T.ConeGeometry(0.075, 0.2, 6), '#4d9064', 0, 0.84, 0, 1, 1, 1, 0.2, 0, 0.8, 0.6);
    // Eiche / Laubbaum
    var oak = new Acc();
    oak.add(new T.CylinderGeometry(0.035, 0.055, 0.3, 6), '#5f4126', 0, 0.15, 0, 1, 1, 1, 0);
    oak.add(new T.IcosahedronGeometry(0.25, det), '#3f6e3a', 0, 0.5, 0, 1, 0.9, 1, 0.4, 0.14, 0.8);
    oak.add(new T.IcosahedronGeometry(0.17, det), '#4a7f42', 0.13, 0.64, 0.04, 1, 0.9, 1, 1.2, 0.14, 0.8);
    oak.add(new T.IcosahedronGeometry(0.15, det), '#37633a', -0.13, 0.54, -0.08, 1, 0.85, 1, 2.0, 0.14, 0.8);
    oak.add(new T.IcosahedronGeometry(0.13, 0), '#56894a', 0.02, 0.72, -0.05, 1, 0.9, 1, 0.1, 0.12, 0.8);
    // Birke / Pappel (schlank, hell)
    var birch = new Acc();
    birch.add(new T.CylinderGeometry(0.02, 0.032, 0.5, 5), '#d8d2c0', 0, 0.25, 0, 1, 1, 1, 0);
    birch.add(new T.IcosahedronGeometry(0.2, det), '#6a9148', 0, 0.66, 0, 0.62, 1.45, 0.62, 0.7, 0.12, 0.8);
    birch.add(new T.IcosahedronGeometry(0.13, 0), '#7da254', 0.05, 0.9, 0.03, 0.7, 1.2, 0.7, 1.9, 0.1, 0.8);
    return [pine.geo(0.95), oak.geo(0.85), birch.geo(1.0)];
  }
  function rockGeos() {
    var out = [], T = THREE, v;
    for (v = 0; v < 3; v++) {
      var a = new Acc(), base = ['#8e8a82', '#847f76', '#928c80'][v];
      var g = new T.IcosahedronGeometry(0.34, 1);
      var p = g.attributes.position, tmp = new T.Vector3(), q;
      for (q = 0; q < p.count; q++) {   // facettierte Brocken: Verformung + abgeflachter Boden
        tmp.fromBufferAttribute(p, q);
        var hh = hash((tmp.x * 311) | 0, (tmp.y * 211 + tmp.z * 97) | 0, 23 + v), sc = 0.8 + 0.34 * hh;
        tmp.multiplyScalar(sc); if (tmp.y < -0.12) tmp.y = -0.12 - (tmp.y + 0.12) * 0.15;
        p.setXYZ(q, tmp.x, tmp.y, tmp.z);
      }
      a.add(g, base, 0, 0.1, 0, 1, v === 1 ? 1.1 : 0.78, v === 2 ? 1.25 : 0.95, v * 1.7, 0, 0.4);   // C1: Facetten bleiben, aber weicher
      if (v !== 1) {
        var g2 = new T.DodecahedronGeometry(0.17, 0);
        a.add(g2, ['#7b766d', '#9a948a'][v >> 1], 0.22, 0.05, 0.1, 1, 0.7, 1, 0.6, 0, 0.4);
      }
      out.push(a.geo(0.6));
    }
    return out;
  }
  function tuftGeo(bush) {
    var a = new Acc(), T = THREE;
    if (bush) {
      a.add(new T.IcosahedronGeometry(0.15, 0), '#3d7a2c', 0, 0.08, 0, 1, 0.72, 1, 0, 0.16, 0.7);
      a.add(new T.IcosahedronGeometry(0.1, 0), '#4a8c34', 0.1, 0.06, 0.05, 1, 0.7, 1, 1, 0.16, 0.7);
      return a.geo(0.25);
    }
    // 7 Halme (Dreiecke, leicht geneigt), Farbverlauf Fuß → Spitze
    var pos = [], col = [], yy = [], n = 7, i;
    for (i = 0; i < n; i++) {
      var ang = i / n * 6.283 + (i % 2) * 0.4, rr = 0.012 + (i % 3) * 0.012, hh = 0.1 + 0.07 * hash(i, 3, 5), lean = 0.045 + 0.04 * hash(i, 4, 5);
      var cx = Math.cos(ang) * rr, cz = Math.sin(ang) * rr, tx = Math.cos(ang) * (rr + lean), tz = Math.sin(ang) * (rr + lean), px = -Math.sin(ang) * 0.011, pz = Math.cos(ang) * 0.011;
      pos.push(cx - px, 0, cz - pz, cx + px, 0, cz + pz, tx, hh, tz);
      col.push(0.21, 0.31, 0.13, 0.21, 0.31, 0.13, 0.45, 0.62, 0.27);   // B1: Spitzen gedeckter (vorher 0.5, 0.72, 0.26) yy.push(0, 0, hh);
    }
    var gg = new T.BufferGeometry();
    gg.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); gg.setAttribute('color', new T.Float32BufferAttribute(col, 3));
    var w = new Float32Array(yy.length); for (i = 0; i < w.length; i++) w[i] = clamp(yy[i] / 0.14, 0, 1) * 0.9;
    gg.setAttribute('aWind', new T.BufferAttribute(w, 1)); gg.computeVertexNormals();
    // Normalen nach oben ziehen (weiches Licht auf Halmen)
    var nm = gg.attributes.normal; for (i = 0; i < nm.count; i++) nm.setXYZ(i, nm.getX(i) * 0.3, 1, nm.getZ(i) * 0.3);
    gg.computeBoundingSphere();
    return gg;
  }

  // ------------------------------------------------------------------ v0.7-deco: Geometrien + instanzierte Batches der Kartendekoration
  /** Dekorations-Geometrien (Einheitsmaß: Kacheln, +x = Vorderseite/Ausleger, Fußpunkt = Ursprung). fine = feines Modell (Flag hiPoly V), sonst gröber. */
  function decoGeos(fine) {
    var T = THREE, out = {}, b;
    var ocyl = function (bb, col, rt, rb, h, seg, x, y, z) { return bb.add(new T.CylinderGeometry(rt, rb, h, seg, 1, true), col, x, y + h / 2, z); };
    b = new MB().surf('metal');   // Straßenlampe
    ocyl(b, '#565c62', 0.012, 0.019, 0.54, fine ? 6 : 4, 0, 0, 0);
    if (fine) b.pbox('#3a3e43', 0.05, 0.04, 0.05, 0, 0, 0);
    b.pbox('#565c62', 0.16, 0.016, 0.016, 0.07, 0.525, 0).pbox('#2f3338', 0.075, 0.024, 0.048, 0.15, 0.5, 0);
    if (fine) b.surf(null).pbox('#fff0b0', 0.052, 0.006, 0.032, 0.15, 0.496, 0);
    out.lamp = b.geo();
    b = new MB().surf('metal');   // Verkehrsschild (Platte weiß, wird je Variante getönt)
    ocyl(b, '#2e3236', 0.009, 0.009, 0.34, 4, 0, 0, 0);
    b.surf('matte').pbox('#f6f6f0', 0.13, 0.13, 0.012, 0, 0.25, 0);
    if (fine) b.pbox('#26292d', 0.085, 0.024, 0.014, 0, 0.303, 0);
    out.sign = b.geo();
    b = new MB().surf('matte');   // Zaun (Länge 0.98 entlang x)
    if (fine) {
      for (var fp = -1; fp <= 1; fp++) b.pbox('#d9d4c6', 0.034, 0.15, 0.034, fp * 0.46, 0, 0);
      b.pbox('#cfc9ba', 0.98, 0.022, 0.014, 0, 0.04, 0).pbox('#cfc9ba', 0.98, 0.022, 0.014, 0, 0.1, 0);
    } else b.pbox('#d9d4c6', 0.04, 0.14, 0.04, -0.46, 0, 0).pbox('#d9d4c6', 0.04, 0.14, 0.04, 0.46, 0, 0).pbox('#cfc9ba', 0.98, 0.1, 0.014, 0, 0.03, 0);
    out.fence = b.geo();
    b = new MB().surf('organic');   // Busch
    b.ico('#3d7a2c', 0.14, 0, 0.08, 0, 1, 0.75, 1, 0);
    if (fine) b.ico('#4c8c36', 0.095, 0.1, 0.07, 0.05, 1, 0.72, 1, 0).ico('#35702a', 0.08, -0.08, 0.06, -0.06, 1, 0.7, 1, 0);
    out.bush = b.geo();
    b = new MB().surf('conc');   // Sandsack-Wall (Länge ≈ 0.46)
    if (fine) {
      for (var sb = -1; sb <= 1; sb++) b.pbox(sb & 1 ? '#a89868' : '#b8a77c', 0.15, 0.062, 0.1, sb * 0.155, 0, sb * 0.008, sb * 0.05);
      b.pbox('#b3a276', 0.15, 0.06, 0.1, -0.078, 0.06, 0.006, 0.04).pbox('#a89868', 0.15, 0.06, 0.1, 0.078, 0.06, -0.004, -0.05);
    } else b.pbox('#b3a276', 0.46, 0.06, 0.1, 0, 0, 0).pbox('#a89868', 0.34, 0.06, 0.1, 0, 0.06, 0);
    out.sandbag = b.geo();
    b = new MB().surf('body');   // ausgebranntes Autowrack (Grundfarbe hell; Variante tönt)
    b.pbox('#8a8a8a', 0.44, 0.06, 0.2, 0, 0.025, 0).pbox('#5e5e5e', 0.2, 0.05, 0.17, -0.03, 0.085, 0);
    if (fine) {
      b.surf('track');
      for (var wx = -1; wx <= 1; wx += 2) for (var wz = -1; wz <= 1; wz += 2) b.pbox('#232323', 0.07, 0.07, 0.03, wx * 0.14, 0, wz * 0.105);
      b.surf('body').pbox('#4a4a4a', 0.12, 0.012, 0.18, 0.15, 0.085, 0, 0, 0, 0.35);
    }
    out.wreck = b.geo();
    b = new MB().surf('matte');   // Kiste
    b.pbox('#b79468', 0.13, 0.13, 0.13, 0, 0, 0);
    if (fine) b.pbox('#8a6b42', 0.136, 0.02, 0.136, 0, 0.055, 0).pbox('#8a6b42', 0.02, 0.136, 0.136, 0, 0, 0);
    out.crate = b.geo();
    b = new MB().surf('metal');   // Fass
    b.add(new T.CylinderGeometry(0.045, 0.045, 0.13, fine ? 8 : 6), '#b4b8bc', 0, 0.065, 0);
    if (fine) ocyl(b, '#e6e8ea', 0.049, 0.049, 0.018, 8, 0, 0.056, 0);
    out.barrel = b.geo();
    return out;
  }
  function triCount(g) { return g.index ? g.index.count / 3 : g.attributes.position.count / 3; }
  /** Kopie der Geometrie mit Vertexfarben · tint (für Sprites/Bake). */
  function tintGeo(geo, tint) {
    var g = geo.clone(), c = g.attributes.color, a = new Float32Array(c.array.length);
    for (var i = 0; i < a.length; i += 3) { a[i] = c.array[i] * tint[0]; a[i + 1] = c.array[i + 1] * tint[1]; a[i + 2] = c.array[i + 2] * tint[2]; }
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    return g;
  }
  /** Dekoration der aktuellen Karte aufbauen: je Typ ein InstancedMesh (statisch, einmal gefüllt). */
  function buildDeco(m) {
    var cf = world.cfg, fine = !!cf.hiPoly, pl = DECO.plan(m, fine), geos = decoGeos(fine), by = {}, i, tris = 0;
    for (i = 0; i < pl.items.length; i++) (by[pl.items[i].k] || (by[pl.items[i].k] = [])).push(pl.items[i]);
    var info = { fine: fine, counts: {}, tris: 0, draws: 0 };
    DECO.ORDER.forEach(function (k) {
      var L = by[k], g = geos[k];
      if (!L || !L.length) { g.dispose(); return; }
      var bt = new Batch(g, MAT.std, L.length, !safeGPU), na = DECO.NA[k], vr = DECO.VARS[k];
      for (var j = 0; j < L.length; j++) {
        var it = L[j], tn = vr[it.v % vr.length], s = it.s;
        bt.put(it.x, heightAt(it.x, it.y) - 0.005, it.y, it.ai * 6.283185307 / na, s, s, s, tn[0], tn[1], tn[2]);
      }
      bt.flush(); bt.mesh.castShadow = !safeGPU; bt.mesh.receiveShadow = true;
      world.group.add(bt.mesh);
      info.counts[k] = L.length; info.tris += triCount(g) * L.length; info.draws++;
    });
    world.deco = info; stats.decoTris = info.tris;
  }

  /** Bäume, Felsbrocken, Erzkristalle, Brücken (statisch bzw. selten aktualisiert). */
  /** v0.9: diagonaler Brückenzug (G.Bridges-Lauf r) als ein gerader Steg: Fahrbahn, Querbohlen, Geländer mit Pfosten, Pfeiler – gleiche Höhen/Farben wie die Kachelbrücke. */
  function diagBridge(bb, r) {
    var ry = -Math.atan2(r.uy, r.ux), ux = r.ux, uz = r.uy, vx = -uz, vz = ux, L = r.L, Wd = r.W, k, t, n;
    bb.box('#7b5a3a', L, 0.08, Wd, r.cx, 0.06, r.cy, ry);
    bb.bevel(0);
    n = Math.floor((L - 0.04) / 0.2);
    for (k = 0; k < n; k++) { t = -L / 2 + 0.12 + k * 0.2; bb.box(k % 2 ? '#8d6a45' : '#6f5032', 0.17, 0.01, Wd - 0.04, r.cx + ux * t, 0.14, r.cy + uz * t, ry); }
    for (var sd = -1; sd <= 1; sd += 2) {
      var ox = vx * sd * (Wd / 2 - 0.03), oz = vz * sd * (Wd / 2 - 0.03);
      bb.box('#4a3420', L, 0.05, 0.05, r.cx + ox, 0.26, r.cy + oz, ry);                 // Handlauf
      bb.box('#4a3420', L, 0.04, 0.04, r.cx + ox, 0.15, r.cy + oz, ry);                 // Fußleiste
      n = Math.max(2, Math.round(L / 0.6));
      for (k = 0; k <= n; k++) { t = -L / 2 + 0.03 + k * (L - 0.06) / n; bb.box('#3d2a18', 0.05, 0.13, 0.05, r.cx + ox + ux * t, 0.14, r.cy + oz + uz * t, ry); }
    }
    bb.bevel(null);
    n = Math.max(1, Math.round(L / 1.6));
    for (k = 0; k < n; k++) {
      t = -L / 2 + (k + 0.5) * L / n;
      for (sd = -1; sd <= 1; sd += 2) bb.cyl('#5d5a55', 0.08, 0.1, 0.6, 6, r.cx + ux * t + vx * sd * Wd * 0.3, -0.55, r.cy + uz * t + vz * sd * Wd * 0.3);
    }
  }
  function buildStatics(m, fl) {
    var W = m.w, H = m.h, x, y, i, t, k;
    var trees = [], rocks = [], bridges = [], cf = world.cfg;
    world.oreIdx = []; world.oreLvl = [];
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      t = D.TERRAIN[m.terrain[y * W + x]].id;
      if (t === 'trees') trees.push(x, y);
      else if (t === 'rock') rocks.push(x, y);
      else if (t === 'bridge') bridges.push(x, y);
      if (m.oreMax[y * W + x] > 0 || m.ore[y * W + x] > 0) world.oreIdx.push(y * W + x);
    }
    // Bäume: Kiefer / Eiche / Birke, nach Waldflecken (Rauschen) gemischt, Größe + Farbe variiert, im Wind (Modern)
    var tg = treeGeos(), tmat = plantMaterial(cf.wind, false), per = (cf.mode === 'modern') ? 4 : 3;
    var cn = mkWorldFbm(0.12, 2, 101);
    var tb = [new Batch(tg[0], tmat, Math.max(1, trees.length / 2 * per)), new Batch(tg[1], tmat, Math.max(1, trees.length / 2 * per)), new Batch(tg[2], tmat, Math.max(1, trees.length / 2 * per))];
    for (i = 0; i < trees.length; i += 2) for (k = 0; k < per; k++) {
      var tx = trees[i], ty = trees[i + 1];
      var ox = tx + 0.16 + 0.68 * hash(tx, ty, 20 + k), oz = ty + 0.16 + 0.68 * hash(tx, ty, 30 + k);
      var c = cn(tx + 0.5, ty + 0.5), sp = c > 0.56 ? 0 : (c < 0.4 ? 2 : 1);
      var rr = hash(tx, ty, 60 + k); if (rr > 0.82) sp = (sp + 1 + ((rr * 7) | 0) % 2) % 3;
      var s = 0.78 + 0.6 * hash(tx, ty, 40 + k), tint = 0.8 + 0.24 * hash(tx, ty, 50 + k);   // C1: etwas gedeckter (vorher 0.84 + 0.3)
      var hue = hash(tx, ty, 90 + k), cr = tint, cg = tint, cb = tint;
      if (sp === 1) { if (hue > 0.9) { cr = tint * 1.35; cg = tint * 1.05; cb = tint * 0.55; } else { cr = tint * (0.9 + 0.2 * hue); cb = tint * 0.9; } }
      else if (sp === 2) { cr = tint * (0.95 + 0.25 * hue); cg = tint * 1.05; cb = tint * 0.8; }
      else { cb = tint * 1.05; cr = tint * 0.92; }
      var hy = heightAt(ox, oz) - 0.012;
      tb[sp].put(ox, hy, oz, hash(tx, ty, 70 + k) * 6.28, s * (0.9 + 0.2 * hash(tx, ty, 91 + k)), s * (0.88 + 0.3 * hash(tx, ty, 80 + k)), s, cr, cg, cb);
    }
    for (i = 0; i < 3; i++) { tb[i].flush(); tb[i].mesh.castShadow = true; tb[i].mesh.receiveShadow = true; world.group.add(tb[i].mesh); }
    // Felsbrocken: abgeschrägte Low-Poly-Brocken (3 Formen); Rand dichter, Inneres sparsam; einzelne Steine auf dem Vorland
    var rg = rockGeos(), rmat = plantMaterial(false, false);
    var rl = [new Batch(rg[0], rmat, 64), new Batch(rg[1], rmat, 64), new Batch(rg[2], rmat, 64)];
    var rockAt = function (xx, yy) { return terrAt(m, xx, yy) === 'rock'; };
    for (i = 0; i < rocks.length; i += 2) {
      x = rocks[i]; y = rocks[i + 1];
      var edge = !rockAt(x - 1, y) || !rockAt(x + 1, y) || !rockAt(x, y - 1) || !rockAt(x, y + 1);
      var nr = edge ? 1 + (hash(x, y, 92) < 0.5 ? 1 : 0) : (hash(x, y, 93) < 0.18 ? 1 : 0);
      for (k = 0; k < nr; k++) {
        var rx = x + 0.2 + 0.6 * hash(x, y, 90 + k), rz = y + 0.2 + 0.6 * hash(x, y, 95 + k), rs = (edge ? 0.8 : 1.0) * (0.8 + 0.8 * hash(x, y, 99 + k));
        var tn = 0.82 + 0.3 * hash(x, y, 101 + k), vs = (hash(x, y, 107 + k) * 3) | 0;
        rl[vs].put(rx, heightAt(rx, rz) - 0.05 * rs, rz, hash(x, y, 103 + k) * 6.28, rs, rs * (0.75 + 0.6 * hash(x, y, 104 + k)), rs * (0.9 + 0.3 * hash(x, y, 105 + k)), tn, tn * 0.98, tn * 0.94);
      }
    }
    if (cf.mode !== 'classic') for (y = 0; y < H; y++) for (x = 0; x < W; x++) {   // Streusteine
      var ty2 = terrAt(m, x, y);
      if ((ty2 === 'grass' || ty2 === 'sand') && hash(x, y, 113) < 0.035) {
        var px2 = x + 0.2 + 0.6 * hash(x, y, 114), pz2 = y + 0.2 + 0.6 * hash(x, y, 115), ps = 0.24 + 0.3 * hash(x, y, 116);
        rl[(hash(x, y, 117) * 3) | 0].put(px2, heightAt(px2, pz2) - 0.02, pz2, hash(x, y, 118) * 6.28, ps, ps * 0.8, ps, 1, 0.98, 0.94);
      }
    }
    for (i = 0; i < 3; i++) { rl[i].flush(); rl[i].mesh.castShadow = true; rl[i].mesh.receiveShadow = true; world.group.add(rl[i].mesh); }
    // Erz: Kristallgruppen (2 je Kachel), Größe folgt der Restmenge
    var cr2 = new Acc(), T = THREE;
    var cryst = function (col, x2, z2, h2, rx2, ry2) { cr2.add(new T.CylinderGeometry(0.0, 0.07, h2, 6, 1), col, x2, h2 * 0.5, z2, 1, 1, 1, ry2, 0.1); };
    cryst('#f2c14e', 0, 0, 0.34, 0, 0.1); cryst('#ffd96b', 0.09, 0.05, 0.22, 0.3, 0.8); cryst('#d9971f', -0.08, 0.06, 0.2, -0.3, 1.4);
    cryst('#f7cf5c', 0.02, -0.09, 0.18, 0.45, 2.1); cryst('#e8a92e', -0.06, -0.06, 0.14, -0.3, 0.4);
    var cgeo = cr2.geo(0.4); cgeo.deleteAttribute('aWind');
    var ob = new Batch(cgeo, MAT.ore, Math.max(1, world.oreIdx.length * 2));
    world.oreBatch = ob;
    for (i = 0; i < world.oreIdx.length; i++) world.oreLvl.push(-1);
    world.group.add(ob.mesh);
    ob.mesh.castShadow = true;
    updateOre(true);
    // Brücken: Fahrbahn + Geländer + Pfeiler, zusammengeführt
    if (bridges.length) {
      var bb = new MB();
      var wet = function (xx, yy) { var tt = terrAt(m, xx, yy); return tt === 'water'; };
      var bpl = BRIDGES.plan(m);
      for (i = 0; i < bpl.runs.length; i++) diagBridge(bb, bpl.runs[i]);   // v0.9: diagonale Züge als ein gerader Steg
      for (i = 0; i < bridges.length; i += 2) {
        x = bridges[i]; y = bridges[i + 1];
        if (bpl.diag[y * m.w + x]) continue;
        var cx = x + 0.5, cz = y + 0.5;
        bb.box('#7b5a3a', 1.0, 0.08, 1.0, cx, 0.06, cz);
        for (k = 0; k < 5; k++) bb.box(k % 2 ? '#8d6a45' : '#6f5032', 0.98, 0.01, 0.17, cx, 0.14, cz - 0.4 + k * 0.2);
        if (wet(x, y - 1)) bb.box('#4a3420', 1.0, 0.1, 0.05, cx, 0.14, cz - 0.48);
        if (wet(x, y + 1)) bb.box('#4a3420', 1.0, 0.1, 0.05, cx, 0.14, cz + 0.48);
        if (wet(x - 1, y)) bb.box('#4a3420', 0.05, 0.1, 1.0, cx - 0.48, 0.14, cz);
        if (wet(x + 1, y)) bb.box('#4a3420', 0.05, 0.1, 1.0, cx + 0.48, 0.14, cz);
        bb.cyl('#5d5a55', 0.08, 0.1, 0.6, 6, cx - 0.35, -0.55, cz - 0.35).cyl('#5d5a55', 0.08, 0.1, 0.6, 6, cx + 0.35, -0.55, cz + 0.35);
      }
      var bm = new THREE.Mesh(bb.geo(false), MAT.std);
      bm.castShadow = true; bm.receiveShadow = true;
      world.group.add(bm);
    }
    buildDeco(m);   // v0.7-deco: nach dem Erz (Bake-Seite sucht Bäume/Felsen/Erz über die Reihenfolge der Instanz-Meshes)
  }

  /** Erz-Kristalle an Restmenge anpassen (nur geänderte Kacheln neu schreiben). */
  function updateOre(force) {
    var m = G.Sim.S.map, ob = world.oreBatch, W = m.w, changed = false;
    if (!ob) return;
    for (var i = 0; i < world.oreIdx.length; i++) {
      var ti = world.oreIdx[i], ore = m.ore[ti], mx = m.oreMax[ti] || 800;
      var lvl = ore <= 0 ? 0 : 1 + Math.min(15, Math.floor(ore / mx * 15));
      if (!force && lvl === world.oreLvl[i]) continue;
      world.oreLvl[i] = lvl; changed = true;
      var tx = ti % W, ty = (ti / W) | 0;
      for (var k = 0; k < 2; k++) {
        var s = lvl === 0 ? 0 : (0.3 + 0.45 * lvl / 16) * (k ? 0.8 : 1.1) * (mx >= 700 ? 1.15 : 1);
        var ox = tx + 0.3 + 0.4 * hash(tx, ty, 110 + k) + (k ? 0.12 : -0.12), oz = ty + 0.3 + 0.4 * hash(tx, ty, 120 + k);
        ob.n = i * 2 + k;
        ob.put(ox, heightAt(ox, oz) - 0.01, oz, hash(tx, ty, 130 + k) * 6.28, s, s, s, 1, 1, 1);
      }
    }
    ob.mesh.count = world.oreIdx.length * 2;
    ob.n = 0;
    if (changed) { ob.mesh.instanceMatrix.needsUpdate = true; ob.mesh.instanceColor.needsUpdate = true; }
  }

  /** Geländehöhe (bilinear) an Weltposition in Kacheln. */
  function heightAt(x, z) {
    if (!world) return 0;
    var n = world.res, gx = x * n, gz = z * n, GW = world.GW, GH = world.GH;
    if (gx < 0) gx = 0; if (gz < 0) gz = 0; if (gx > GW - 1.001) gx = GW - 1.001; if (gz > GH - 1.001) gz = GH - 1.001;
    var ix = gx | 0, iz = gz | 0, fx = gx - ix, fz = gz - iz, o = iz * GW + ix, h = world.hts;
    return h[o] * (1 - fx) * (1 - fz) + h[o + 1] * fx * (1 - fz) + h[o + GW] * (1 - fx) * fz + h[o + GW + 1] * fx * fz;
  }
  /** Standhöhe einer Einheit (Brücken: Fahrbahn). */
  function groundAt(x, z) {
    var m = mapRef, tx = x | 0, tz = z | 0;
    if (m && tx >= 0 && tz >= 0 && tx < m.w && tz < m.h && D.TERRAIN[m.terrain[tz * m.w + tx]].id === 'bridge') return 0.15;
    return Math.max(heightAt(x, z), -0.05);
  }

  // ------------------------------------------------------------------ Büschel + Büsche (nur Nahansicht, instanziert, nach Sicht gefüllt)
  var sc = null;
  function buildScatter(m, fl) {
    sc = null;
    var cf = world.cfg;
    if (cf.tuft <= 0) return;
    var cap = cf.mode === 'modern' ? 7000 : 2600;
    var mat = plantMaterial(cf.wind, true), bmat = plantMaterial(cf.wind, false);
    var tb = new Batch(tuftGeo(false), mat, cap, false), bb = new Batch(tuftGeo(true), bmat, 600, false);
    tb.mesh.castShadow = false; bb.mesh.castShadow = false; bb.mesh.receiveShadow = true;
    world.group.add(tb.mesh); world.group.add(bb.mesh);
    sc = { tb: tb, bb: bb, cap: cap, per: cf.tuft, x0: 0, z0: 0, x1: -1, z1: -1, zb: -1, occV: -1, last: '' };
  }
  function scatterTile(x, y, fl, W) {
    var ti = y * W + x, dry = fl.dryT[ti] / 255, per = sc.per, k, tb = sc.tb;
    var n = per + (hash(x, y, 130) < 0.5 ? 1 : 0);
    for (k = 0; k < n && tb.n < sc.cap; k++) {
      var px = x + 0.08 + 0.84 * hash(x, y, 140 + k), pz = y + 0.08 + 0.84 * hash(x, y, 150 + k);
      var s = 0.8 + 0.9 * hash(x, y, 160 + k), hv = hash(x, y, 170 + k), gr = 0.85 + 0.35 * hv;
      var dd = clamp(dry + (hv - 0.5) * 0.3, 0, 1);
      tb.put(px, heightAt(px, pz), pz, hash(x, y, 180 + k) * 6.28, s, s * (0.8 + 0.5 * hash(x, y, 190 + k)), s,
        gr * mix(0.82, 1.5, dd), gr * mix(1.0, 1.28, dd), gr * mix(0.8, 0.62, dd));
    }
    if (sc.bb.n < 600 && hash(x, y, 200) < (sc.per >= 4 ? 0.075 : 0.04)) {
      var bx = x + 0.2 + 0.6 * hash(x, y, 201), bz = y + 0.2 + 0.6 * hash(x, y, 202), bs = 0.7 + 0.7 * hash(x, y, 203), bt = 0.8 + 0.4 * hash(x, y, 204);
      sc.bb.put(bx, heightAt(bx, bz) - 0.01, bz, hash(x, y, 205) * 6.28, bs, bs, bs, bt * (0.9 + 0.3 * dry), bt, bt * 0.85);
    }
  }
  function updateScatter() {
    if (!sc || !world) return;
    var V = R.V, z = V.cam.zoom, on = z >= 0.8, W = world.W, H = world.H;
    sc.tb.mesh.visible = sc.bb.mesh.visible = on;
    if (!on) { sc.x1 = -1; return; }
    if (R.mark) R.mark('grass');
    var occV = world.occVer | 0;
    // aktueller Sichtbereich (Kacheln), Rand 3
    var tx0, tz0, tx1, tz1;
    if (!sc._key || sc._cx !== V.cam.x || sc._cy !== V.cam.y || sc._cz !== z || sc._vw !== V.vw || sc._vh !== V.vh) {
      // W11: Hüllrechteck aller vier (gedrehten) Bildecken – zwei Ecken reichen nur bei YAW = 0
      var cq = [V.toWorld(-30, -30), V.toWorld(V.vw + 30, -30), V.toWorld(V.vw + 30, V.vh + 150), V.toWorld(-30, V.vh + 150)], bx0 = 1e9, bz0 = 1e9, bx1 = -1e9, bz1 = -1e9;
      for (var ci = 0; ci < 4; ci++) { bx0 = Math.min(bx0, cq[ci].x); bx1 = Math.max(bx1, cq[ci].x); bz0 = Math.min(bz0, cq[ci].y); bz1 = Math.max(bz1, cq[ci].y); }
      sc._cx = V.cam.x; sc._cy = V.cam.y; sc._cz = z; sc._vw = V.vw; sc._vh = V.vh; sc._key = 1;
      sc._bx0 = bx0 / 32; sc._bz0 = bz0 / 32; sc._bx1 = bx1 / 32; sc._bz1 = bz1 / 32;
    }
    tx0 = Math.max(0, Math.floor(sc._bx0)); tz0 = Math.max(0, Math.floor(sc._bz0)); tx1 = Math.min(W - 1, Math.ceil(sc._bx1)); tz1 = Math.min(H - 1, Math.ceil(sc._bz1));
    if (tx0 >= sc.x0 && tz0 >= sc.z0 && tx1 <= sc.x1 && tz1 <= sc.z1 && occV === sc.occV) return;   // gebauter Bereich deckt die Sicht ab
    var rx0 = Math.max(0, tx0 - 4), rz0 = Math.max(0, tz0 - 4), rx1 = Math.min(W - 1, tx1 + 4), rz1 = Math.min(H - 1, tz1 + 4);
    // Kapazität: bei zu großem Bereich Rand weglassen
    if ((rx1 - rx0 + 1) * (rz1 - rz0 + 1) * (sc.per + 0.5) > sc.cap) { rx0 = tx0; rz0 = tz0; rx1 = tx1; rz1 = tz1; }
    var fl = world.fl, occ = world.occ, x, y;
    for (y = rz0; y <= rz1; y++) for (x = rx0; x <= rx1; x++) {
      var ti = y * W + x;
      if (!fl.tuftOk[ti] || occ[ti]) continue;
      scatterTile(x, y, fl, W);
    }
    sc.tb.flush(); sc.bb.flush();
    sc.x0 = rx0; sc.z0 = rz0; sc.x1 = rx1; sc.z1 = rz1; sc.occV = occV;
  }
  /** Belegung durch Gebäude (für Büschel/Spuren): alle ~8 Frames prüfen */
  function updateOcc(S) {
    var W = world.W, H = world.H, occ = world.occ, i, e, x, y, h = 0, cnt = 0;
    var ents = S.ents;
    for (i = 0; i < ents.length; i++) { e = ents[i]; if (e.kind === 'building' && !e.dead) { h = (h * 31 + e.tx * 7 + e.ty * 13 + e.w) | 0; cnt++; } }
    h = (h * 31 + cnt) | 0;
    if (h === world.occHash) return;
    world.occHash = h; world.occVer = (world.occVer | 0) + 1;
    occ.fill(0);
    for (i = 0; i < ents.length; i++) {
      e = ents[i];
      if (e.kind !== 'building' || e.dead) continue;
      for (y = e.ty - 1; y < e.ty + e.h + 1; y++) for (x = e.tx - 1; x < e.tx + e.w + 1; x++) if (x >= 0 && y >= 0 && x < W && y < H) occ[y * W + x] = 1;
    }
  }

  // ------------------------------------------------------------------ Decal-Ebene (Krater/Brand/Ruß, Panzerspuren)
  var dec = null, trk = null, decAtlas = null;
  function drawAtlas() {
    var c = document.createElement('canvas'); c.width = c.height = 256;
    var g = c.getContext('2d'), q, a, r;
    function cell(ix, iy, fn) { g.save(); g.beginPath(); g.rect(ix * 128, iy * 128, 128, 128); g.clip(); g.translate(ix * 128 + 64, iy * 128 + 64); fn(); g.restore(); }
    // 0: Brandfleck – verbrannter, ausgefranster Fleck mit Strahlen
    cell(0, 0, function () {
      var gr = g.createRadialGradient(0, 0, 2, 0, 0, 60); gr.addColorStop(0, 'rgba(14,11,8,0.92)'); gr.addColorStop(0.45, 'rgba(24,19,14,0.7)'); gr.addColorStop(0.8, 'rgba(40,32,24,0.22)'); gr.addColorStop(1, 'rgba(40,32,24,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(0, 0, 60, 0, 6.283); g.fill();
      for (q = 0; q < 26; q++) { a = hash(q, 1, 3) * 6.283; r = 20 + hash(q, 2, 3) * 38; g.strokeStyle = 'rgba(18,14,10,' + (0.25 + hash(q, 5, 3) * 0.35) + ')'; g.lineWidth = 1 + hash(q, 4, 3) * 3; g.beginPath(); g.moveTo(Math.cos(a) * 10, Math.sin(a) * 10); g.lineTo(Math.cos(a) * r, Math.sin(a) * r); g.stroke(); }
      for (q = 0; q < 30; q++) { a = hash(q, 7, 3) * 6.283; r = 18 + hash(q, 8, 3) * 36; g.fillStyle = 'rgba(16,12,9,0.5)'; g.beginPath(); g.arc(Math.cos(a) * r, Math.sin(a) * r, 1.5 + hash(q, 9, 3) * 3.5, 0, 6.283); g.fill(); }
    });
    // 1: Rußfleck (klein, weich)
    cell(1, 0, function () {
      var gr = g.createRadialGradient(0, 0, 1, 0, 0, 52); gr.addColorStop(0, 'rgba(20,16,12,0.8)'); gr.addColorStop(0.55, 'rgba(30,24,18,0.38)'); gr.addColorStop(1, 'rgba(30,24,18,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(0, 0, 52, 0, 6.283); g.fill();
      for (q = 0; q < 14; q++) { a = hash(q, 11, 4) * 6.283; r = 12 + hash(q, 12, 4) * 26; g.fillStyle = 'rgba(18,14,10,0.4)'; g.beginPath(); g.arc(Math.cos(a) * r, Math.sin(a) * r, 2 + hash(q, 13, 4) * 5, 0, 6.283); g.fill(); }
    });
    // 2: Krater – dunkle Mulde, aufgeworfener heller Rand (Erde), Ruß-Hof
    cell(0, 1, function () {
      var gr = g.createRadialGradient(0, 0, 4, 0, 0, 62); gr.addColorStop(0, 'rgba(10,8,6,0.95)'); gr.addColorStop(0.5, 'rgba(26,20,15,0.78)'); gr.addColorStop(0.78, 'rgba(30,24,18,0.3)'); gr.addColorStop(1, 'rgba(30,24,18,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(0, 0, 62, 0, 6.283); g.fill();
      g.lineWidth = 7;
      for (q = 0; q < 40; q++) {
        a = q / 40 * 6.283; r = 33 + 4 * Math.sin(q * 2.3) + hash(q, 15, 5) * 4;
        g.strokeStyle = 'rgba(' + (128 + hash(q, 16, 5) * 30 | 0) + ',' + (104 + hash(q, 17, 5) * 24 | 0) + ',' + (80 + hash(q, 18, 5) * 20 | 0) + ',0.55)';
        g.beginPath(); g.arc(0, 0, r, a, a + 0.18); g.stroke();
      }
      var gi = g.createRadialGradient(0, 0, 2, 0, 0, 30); gi.addColorStop(0, 'rgba(6,5,4,0.9)'); gi.addColorStop(1, 'rgba(14,11,8,0.35)');
      g.fillStyle = gi; g.beginPath(); g.arc(0, 0, 29, 0, 6.283); g.fill();
      for (q = 0; q < 22; q++) { a = hash(q, 19, 5) * 6.283; r = 36 + hash(q, 20, 5) * 20; g.fillStyle = 'rgba(112,92,70,0.5)'; g.beginPath(); g.arc(Math.cos(a) * r, Math.sin(a) * r, 1 + hash(q, 21, 5) * 2.4, 0, 6.283); g.fill(); }
    });
    // 3: Kettenabdruck (Stollen quer, entlang +x)
    cell(1, 1, function () {
      g.fillStyle = 'rgba(30,24,18,0.45)'; g.fillRect(-60, -22, 120, 44);
      g.fillStyle = 'rgba(14,11,8,0.7)';
      for (q = -56; q < 56; q += 11) g.fillRect(q, -20, 5.5, 40);
      var e1 = g.createLinearGradient(-64, 0, 64, 0); e1.addColorStop(0, 'rgba(0,0,0,0.9)'); e1.addColorStop(0.2, 'rgba(0,0,0,0)'); e1.addColorStop(0.8, 'rgba(0,0,0,0)'); e1.addColorStop(1, 'rgba(0,0,0,0.9)');
      g.globalCompositeOperation = 'destination-out'; g.fillStyle = e1; g.fillRect(-64, -30, 128, 60); g.globalCompositeOperation = 'source-over';
    });
    var tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4; tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter;
    return tex;
  }
  function cellGeo(ix, iy, sx, sz) {
    var g = new THREE.PlaneGeometry(1, 1); g.rotateX(-Math.PI / 2); if (sx) g.scale(sx, 1, sz);
    var uv = g.attributes.uv, i, u0 = ix * 0.5, v0 = 0.5 - iy * 0.5 - 0.5 + (iy === 0 ? 0.5 : 0);
    // Zelle (ix, iy): Zeile iy=0 oben im Canvas → v = 1 - (iy+1)/2 … 1 - iy/2
    v0 = 1 - (iy + 1) * 0.5;
    for (i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * 0.5, v0 + uv.getY(i) * 0.5);
    return g;
  }
  function decalMaterial() {
    var map = decAtlas, m;
    var pr = { map: map, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 };
    if (R.std) { pr.roughness = 1; pr.metalness = 0; m = new THREE.MeshStandardMaterial(pr); } else m = new THREE.MeshLambertMaterial(pr);
    // Instanzfarbe (r) steuert die Deckkraft (Ausblenden), nicht die Farbe
    m.onBeforeCompile = function (sh) {
      sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\n#ifdef USE_INSTANCING_COLOR\n  diffuseColor.a *= vColor.r; diffuseColor.rgb /= max(vColor.r, 0.02);\n#endif');
    };
    m.customProgramCacheKey = function () { return 'r3td1'; };
    return fowify(m);
  }
  function ensureDecals() {
    if (dec && dec.std === !!R.std && dec.ink === !!R.ink && dec.scene === R.scene) { resetDecals(); return; }   // INK: Stilwechsel → Material neu
    if (dec) { dec.meshes.forEach(function (b) { if (b.mesh.parent) b.mesh.parent.remove(b.mesh); b.mesh.dispose(); }); dec.mat.dispose(); trk.b.mesh.parent && trk.b.mesh.parent.remove(trk.b.mesh); trk.b.mesh.dispose(); }
    if (!decAtlas) decAtlas = drawAtlas();
    try { if (R.renderer && R.renderer.initTexture) R.renderer.initTexture(decAtlas); } catch (e) { /* egal */ }   // W11-look: beim Aufbau hochladen, nicht erst beim ersten Krater mitten im Spiel
    var mat = decalMaterial(), N = 96;
    var bs = [new Batch(cellGeo(0, 0), mat, N, false), new Batch(cellGeo(1, 0), mat, N, false), new Batch(cellGeo(0, 1), mat, N, false)];
    var tb = new Batch(cellGeo(1, 1, 1.0, 0.5), mat, 720, false);
    bs.forEach(function (b) { b.mesh.renderOrder = 1; b.mesh.receiveShadow = false; R.scene.add(b.mesh); });
    tb.mesh.renderOrder = 1; tb.mesh.receiveShadow = false; R.scene.add(tb.mesh);
    dec = { b: bs, meshes: bs.concat([tb]), mat: mat, N: N, n: 0, used: 0, x: new Float32Array(N), z: new Float32Array(N), s: new Float32Array(N), r: new Float32Array(N), t0: new Float32Array(N), life: new Float32Array(N), kind: new Uint8Array(N), std: !!R.std, ink: !!R.ink, scene: R.scene };
    trk = { b: tb, N: 720, n: 0, used: 0, x: new Float32Array(720), z: new Float32Array(720), a: new Float32Array(720), w: new Float32Array(720), l: new Float32Array(720), t0: new Float32Array(720), life: 40, dirty: true, nextT: 0,
      ids: new Int32Array(512), lx: new Float32Array(512), lz: new Float32Array(512) };
  }
  /** Brandfleck/Krater bei (x, z) Kacheln, Größe s, Lebensdauer life s (Ringpuffer, 96 Stück). kind: 0 Brand, 1 Ruß, 2 Krater. */
  function decal(x, z, s, life, kind) {
    if (!dec) return;
    var d = dec, i = d.n; d.n = (d.n + 1) % d.N; d.used = Math.min(d.N, d.used + 1);
    if (kind === undefined) kind = s >= 0.95 ? (rnd() < 0.7 ? 2 : 0) : (s >= 0.6 ? (rnd() < 0.5 ? 0 : 1) : 1);
    d.x[i] = x; d.z[i] = z; d.s[i] = s * (kind === 2 ? 1.25 : 1.15); d.r[i] = rnd() * 6.28; d.t0[i] = R.t; d.life[i] = life; d.kind[i] = kind;
  }
  /** Spurabdruck (links/rechts zur Fahrtrichtung) – von fill() automatisch gesetzt, optional von außen */
  function track(x, z, ang, hw, size) {
    if (!trk || !world) return;
    var t = trk, c = Math.cos(ang), s = Math.sin(ang), side, i;
    for (side = -1; side <= 1; side += 2) {
      i = t.n; t.n = (t.n + 1) % t.N; t.used = Math.min(t.N, t.used + 1);
      t.x[i] = x - s * hw * side; t.z[i] = z + c * hw * side; t.a[i] = ang; t.w[i] = size; t.l[i] = size; t.t0[i] = R.t;
    }
    t.dirty = true;
  }
  function resetDecals() { if (dec) { dec.used = 0; dec.n = 0; } if (trk) { trk.used = 0; trk.n = 0; trk.dirty = true; trk.ids.fill(0); } }

  // ------------------------------------------------------------------ je Frame
  var VEH = {};
  function isVeh(type) { var v = VEH[type]; if (v === undefined) { var u = D.UNITS[type]; v = VEH[type] = u && u.cat === 'vehicle' ? 1 : 0; } return v; }
  function fill(S, dt, fogOff, P) {
    // Funkeln auf Erz
    if (world.oreIdx.length && rnd() < dt * 12) {
      var oi = world.oreIdx[(rnd() * world.oreIdx.length) | 0], om = S.map;
      if (om.ore[oi] > 0) {
        var ox = oi % om.w + 0.2 + rnd() * 0.6, oz = ((oi / om.w) | 0) + 0.2 + rnd() * 0.6;
        if (R.inView(ox, oz) && (fogOff || P.vis[oi])) emit(0, ox, heightAt(ox, oz) + 0.12 + rnd() * 0.2, oz, 0, 0.05, 0, 0.45, 0.02, 0.16, 1, 0.95, 0.7, 1, 1, 0.8, 0.3, 0);
      }
    }
    // Belegung (Gebäude) für Büschel
    if (sc && ((world.occF = (world.occF | 0) + 1) & 7) === 1) updateOcc(S);
    // Fahrzeugspuren (Modern + Lite, nur sichtbare Kacheln, nur Boden)
    if (trk && R.std && dt > 0 && (R.F || {}).tracks) {   // v0.8: Flag tracks (K)
      var ents = S.ents, W = S.map.w, i, e, t = trk, k, dx, dz, key;
      for (i = 0; i < ents.length; i++) {
        e = ents[i];
        if (e.kind !== 'unit' || !e.moving || e.dead || !isVeh(e.type)) continue;
        var tx = e.x / 32, tz = e.y / 32, ti = (tz | 0) * W + (tx | 0);
        if (!(fogOff || P.vis[ti])) continue;
        key = e.id & 511;
        if (t.ids[key] !== e.id) { t.ids[key] = e.id; t.lx[key] = tx; t.lz[key] = tz; continue; }
        dx = tx - t.lx[key]; dz = tz - t.lz[key];
        if (dx * dx + dz * dz < 0.1) continue;
        t.lx[key] = tx; t.lz[key] = tz;
        var tt = terrAt(S.map, tx | 0, tz | 0);
        if (tt === 'road' || tt === 'bridge' || tt === 'water') continue;
        var rad = (D.UNITS[e.type].radius || 10) / 32;
        track(tx, tz, Math.atan2(dz, dx), rad * 0.62, 0.34 + rad * 0.5); if (R.mark) R.mark('tracks');
        void k;
      }
    }
  }
  function update(dt) {
    var Dd = dec, i, now2 = R.t;
    if (Dd) {
      var nb = Dd.b.length, k;
      for (i = 0; i < Dd.used; i++) {
        var age = now2 - Dd.t0[i], lf = Dd.life[i];
        if (age > lf) continue;
        var a = age < lf * 0.6 ? 0.95 : 0.95 * (1 - (age - lf * 0.6) / (lf * 0.4));
        var gx = Dd.x[i], gz = Dd.z[i];
        Dd.b[Dd.kind[i]].put(gx, heightAt(gx, gz) + 0.025, gz, Dd.r[i], Dd.s[i], 1, Dd.s[i], a, a, a);
      }
      for (k = 0; k < nb; k++) Dd.b[k].flush();
    }
    var T = trk;
    if (T && (T.dirty || now2 >= T.nextT)) {
      T.nextT = now2 + 0.4; T.dirty = false;
      var b = T.b, nn = 0;
      for (i = 0; i < T.used; i++) {
        var ag = now2 - T.t0[i];
        if (ag > T.life) continue;
        var al = ag < T.life * 0.5 ? 0.62 : 0.62 * (1 - (ag - T.life * 0.5) / (T.life * 0.5));
        var tx = T.x[i], tz = T.z[i];
        b.put(tx, heightAt(tx, tz) + 0.02, tz, T.a[i], T.l[i], 1, T.w[i] * 0.42, al, al, al); nn++;
      }
      b.flush();
    }
    if (world && world.water) world.water.uniforms.uTime.value = R.t;
    windU.uWT.value = R.t;
    updateScatter();
    MAT.ore.emissiveIntensity = 0.85 + 0.25 * Math.sin(R.t * 2.2);
  }

  function init() { /* Decals werden mit der Welt (Material-Klasse) angelegt: ensureDecals() in build */ }

  G.R3T = {
    link: link, init: init,
    build: function (m) { var w = buildWorld(m); return w; },
    dispose: disposeWorld, world: function () { return world; },
    updateOre: function (force) { if (world) updateOre(force); },
    heightAt: heightAt, groundAt: groundAt, terrAt: terrAt,
    decal: decal, track: track, fill: fill, update: update,
    decoPlan: DECO.plan, decoGeos: function (fine) { return decoGeos(fine !== false); }, decoTint: tintGeo,
    info: function () { return { texBytes: stats.texBytes, genMs: stats.genMs, fieldMs: stats.fieldMs, buildMs: stats.buildMs, tris: stats.tris, decoTris: stats.decoTris | 0, mode: world && world.cfg.mode, fp: stats.fp }; }
  };
})();
