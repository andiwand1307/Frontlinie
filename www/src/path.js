/* FRONTLINIE – path.js
 * G.Path: Wegfindung auf dem Kachelraster.
 *  - A* mit 8 Richtungen, ohne Ecken schneiden, Teilpfad zum nächstgelegenen erreichbaren Knoten,
 *    wenn das Ziel unerreichbar ist.
 *  - Bewegungsklassen: 0 = 'foot' (Infanterie, Bäume passierbar), 1 = 'wheel' (Fahrzeuge).
 *  - Pfadanfragen laufen über eine Warteschlange im Sim-Zustand (S.pq) mit Knotenbudget pro Tick.
 *  - Formationsziele (Slots um einen Zielpunkt) und Sichtlinien-Test für Pfadglättung.
 *  - v0.5 Durchbruch: findet eine bewaffnete Einheit keinen Weg zum Ziel und gibt es gegnerische Mauern,
 *    wird ein zweiter A* gerechnet, in dem gegnerische Mauersegmente (orthogonal) mit hohen Zusatzkosten
 *    (G.DATA.WALL_PATH_COST) begehbar sind. Erreicht dieser das Ziel, wird er verwendet; sim.js lässt die Einheit
 *    dann das versperrende Segment beschießen (e.breach).
 *  - v0.8 (SPEC_v08): Klasse 2 = 'air' (überall passierbar, keine Pfadsuche – Luftfahrzeuge fliegen geradlinig),
 *    Klasse 3 = 'naval' (Wasser + Brücken, Gebäude blockieren). Gewässer-Komponenten (4-Nachbarschaft, nur Gelände) für
 *    Werft-Regel und KI: waterComp(i) → Komponenten-ID (−1 = kein Wasser), waterSize(c) → Kachelanzahl.
 * Alle Puffer sind vorab allokiert (keine Allokation pro Knoten). Keine DOM-Zugriffe.
 */
var G = (typeof G !== 'undefined') ? G : {};
(function () {
  'use strict';

  var TILE = 32;
  var W = 0, H = 0, N = 0;
  var gScore, came, stamp, open, heapF, heapN, curStamp = 1, heapSize = 0;
  var bfsQ, bfsStamp, bfsGen = 1;
  var passT = [null, null, null, null, null];   // v1.0: 4 = hover (Schwebepanzer: Land für Fahrzeuge + Wasser/Brücken)   // Gelände-Passierbarkeit je Klasse (ohne Gebäude); v0.8: 2 = air, 3 = naval
  var wComp = null, wSize = [];           // v0.8: Gewässer-Komponenten
  var occ = null;             // Referenz auf S.occ (Gebäudebelegung)
  var wallOwn = null;         // v0.5: Besitzer des Mauersegments je Kachel (−1 = keine Mauer), Laufzeit-Cache aus sim.js
  var wallCnt = [0, 0, 0, 0, 0, 0, 0, 0];

  var DX = [1, -1, 0, 0, 1, 1, -1, -1];
  var DY = [0, 0, 1, -1, 1, -1, 1, -1];
  var COST = [10, 10, 10, 10, 14, 14, 14, 14];
  // v0.8 Seitengleichheit: gespiegelte Nachbarreihenfolge (Richtung d → −d) für Besitzer mit Basis unten rechts. Damit liefern A*,
  // Formations-BFS und nearestPassable für punktsymmetrische Lagen exakt gespiegelte Ergebnisse (vorher löste +x/+y jeden Gleichstand).
  var REVD = [1, 0, 3, 2, 7, 6, 5, 4];
  /** Gespiegelte Reihenfolge für Spieler pid? (Startplatz in der unteren rechten Kartenhälfte) */
  function flipOwner(S, pid) {
    var st = S && S.map && S.map.starts && pid >= 0 ? S.map.starts[pid] : null;
    return !!st && (st.tx + st.ty + 3) * 2 > S.map.w + S.map.h;
  }

  /** Initialisiert Puffer und Passierbarkeitstabellen für den Zustand S. */
  // v0.9 große Karten: Expansionsgrenze je Anfrage wächst mit der Kartenfläche (64×64: 4000, 128×128: 8000), Zähler für Messungen
  var MAXN = 4000, PST = { req: 0, exp: 0, max: 0, cut: 0 };
  function init(S) {
    var m = S.map;
    W = m.w; H = m.h; N = W * H;
    MAXN = Math.max(4000, Math.round(N * 0.5));
    gScore = new Int32Array(N); came = new Int32Array(N); stamp = new Uint32Array(N);
    open = new Uint32Array(N); heapF = new Int32Array(N * 8 + 16); heapN = new Int32Array(N * 8 + 16);
    bfsQ = new Int32Array(N); bfsStamp = new Uint32Array(N); curStamp = 1; bfsGen = 1;
    var TER = G.DATA.TERRAIN;
    passT[0] = new Uint8Array(N); passT[1] = new Uint8Array(N); passT[2] = new Uint8Array(N); passT[3] = new Uint8Array(N); passT[4] = new Uint8Array(N);
    for (var i = 0; i < N; i++) {
      var t = TER[m.terrain[i]];
      passT[0][i] = t.foot ? 1 : 0;
      passT[1][i] = t.wheel ? 1 : 0;
      passT[2][i] = 1;                 // v0.8 air
      passT[3][i] = t.naval ? 1 : 0;   // v0.8 naval
      passT[4][i] = (t.wheel || t.naval) ? 1 : 0;   // v1.0 hover
    }
    buildWaterComps();
    occ = S.occ;
    wallOwn = new Int8Array(N); wallOwn.fill(-1);
    for (i = 0; i < wallCnt.length; i++) wallCnt[i] = 0;
  }
  /** v0.8: Gewässer-Komponenten (4-Nachbarschaft über schiffbares Gelände, ohne Gebäude). */
  function buildWaterComps() {
    wComp = new Int32Array(N); wComp.fill(-1); wSize = [];
    var st = bfsQ, pt = passT[3];
    for (var i = 0; i < N; i++) {
      if (!pt[i] || wComp[i] >= 0) continue;
      var c = wSize.length, n = 0, top = 0;
      st[top++] = i; wComp[i] = c;
      while (top > 0) {
        var k = st[--top], x = k % W, y = (k - x) / W; n++;
        for (var d = 0; d < 4; d++) {
          var nx = x + DX[d], ny = y + DY[d];
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          var ni = ny * W + nx;
          if (pt[ni] && wComp[ni] < 0) { wComp[ni] = c; st[top++] = ni; }
        }
      }
      wSize.push(n);
    }
  }
  /** v0.5: Mauersegment auf Kachel i setzen (owner ≥ 0) bzw. entfernen (−1). */
  function setWall(i, owner) {
    if (!wallOwn || i < 0 || i >= N) return;
    var o = wallOwn[i];
    if (o >= 0) wallCnt[o]--;
    wallOwn[i] = owner;
    if (owner >= 0) wallCnt[owner]++;
  }
  /** Gibt es Mauern, die nicht pid gehören? */
  function enemyWalls(pid) {
    for (var p = 0; p < wallCnt.length; p++) if (p !== pid && wallCnt[p] > 0) return true;
    return false;
  }

  function passable(cls, i) { if (cls === 2) return i >= 0 && i < N; return passT[cls][i] === 1 && occ[i] === 0; }
  function passableXY(cls, tx, ty) {
    if (tx < 0 || ty < 0 || tx >= W || ty >= H) return false;
    if (cls === 2) return true;   // v0.8 air: alles außer Kartenrand
    var i = ty * W + tx;
    return passT[cls][i] === 1 && occ[i] === 0;
  }
  /** Passierbar in Weltpixeln. */
  function passablePx(cls, x, y) { return passableXY(cls, Math.floor(x / TILE), Math.floor(y / TILE)); }

  // ---- Binärheap (min nach f) ----
  function hpush(n, f) {
    var i = heapSize++;
    while (i > 0) {
      var p = (i - 1) >> 1;
      if (heapF[p] <= f) break;
      heapF[i] = heapF[p]; heapN[i] = heapN[p]; i = p;
    }
    heapF[i] = f; heapN[i] = n;
  }
  function hpop() {
    var top = heapN[0];
    var lf = heapF[--heapSize], ln = heapN[heapSize];
    var i = 0, half = heapSize >> 1;
    while (i < half) {
      var c = 2 * i + 1;
      if (c + 1 < heapSize && heapF[c + 1] < heapF[c]) c++;
      if (heapF[c] >= lf) break;
      heapF[i] = heapF[c]; heapN[i] = heapN[c]; i = c;
    }
    heapF[i] = lf; heapN[i] = ln;
    return top;
  }
  function octile(ax, ay, bx, by) {
    var dx = ax > bx ? ax - bx : bx - ax, dy = ay > by ? ay - by : by - ay;
    return dx > dy ? 10 * dx + 4 * dy : 10 * dy + 4 * dx;
  }

  var lastExpanded = 0, lastReached = false;
  /**
   * A* von Kachel (sx,sy) nach (gx,gy) für Klasse cls.
   * Gibt Array von Kachelindizes (ohne Start, inkl. Ziel) zurück, bei Unerreichbarkeit den Pfad
   * zum Knoten mit kleinster Heuristik. [] wenn Start == Ziel oder nichts besser ist.
   * maxNodes begrenzt die Expansionen (Teilpfad bei Überschreitung).
   */
  function find(cls, sx, sy, gx, gy, maxNodes, breachOwner, rev) {
    lastExpanded = 0; lastReached = false;
    if (sx === gx && sy === gy) { lastReached = true; return []; }
    var brk = breachOwner != null && breachOwner >= 0, wcost = brk ? (G.DATA.WALL_PATH_COST || 300) : 0;
    curStamp++;
    if (curStamp >= 0xfffffff0) { stamp.fill(0); curStamp = 1; }
    var cs = curStamp, pt = passT[cls];
    heapSize = 0;
    var s = sy * W + sx, goal = gy * W + gx;
    stamp[s] = cs; gScore[s] = 0; came[s] = -1; open[s] = 1;
    hpush(s, octile(sx, sy, gx, gy));
    var best = s, bestH = octile(sx, sy, gx, gy), exp = 0;
    while (heapSize > 0) {
      var cur = hpop();
      if (open[cur] === 0) continue;   // veralteter Eintrag
      open[cur] = 0;
      if (cur === goal) { best = cur; lastReached = true; break; }
      exp++;
      if (exp > maxNodes) break;
      var cx = cur % W, cy = (cur - cx) / W, cg = gScore[cur];
      for (var d0 = 0; d0 < 8; d0++) {
        var d = rev ? REVD[d0] : d0;
        var nx = cx + DX[d], ny = cy + DY[d];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        var ni = ny * W + nx, extra = 0;
        if (pt[ni] === 0) continue;
        if (occ[ni] !== 0) {
          // v0.5: gegnerisches Mauersegment im Durchbruchsmodus (nur orthogonal) mit Zusatzkosten
          if (!brk || d >= 4 || wallOwn[ni] < 0 || wallOwn[ni] === breachOwner) continue;
          extra = wcost;
        }
        if (d >= 4) { // diagonal: keine Ecken schneiden
          var a = cy * W + nx, b = ny * W + cx;
          if (pt[a] === 0 || occ[a] !== 0 || pt[b] === 0 || occ[b] !== 0) continue;
        }
        var ng = cg + COST[d] + extra;
        if (stamp[ni] === cs && ng >= gScore[ni]) continue;
        // geschlossene Knoten mit besserem g nicht wieder öffnen (konsistente Heuristik)
        stamp[ni] = cs; gScore[ni] = ng; came[ni] = cur; open[ni] = 1;
        var h = octile(nx, ny, gx, gy);
        if (h < bestH) { bestH = h; best = ni; }
        hpush(ni, ng + h);
        if (heapSize >= heapF.length - 8) { heapSize = 0; break; } // Sicherheitsnetz
      }
    }
    lastExpanded = exp;
    if (best === s) return [];
    var path = [];
    for (var n = best; n !== s && n !== -1; n = came[n]) path.push(n);
    path.reverse();
    return path;
  }

  /** Nächste passierbare Kachel (BFS-Ringe) um (tx,ty) innerhalb maxR, sonst -1.
   *  Liefert Kachelindex. Fels/Wasser werden durchsucht (Ringe), nicht durchlaufen. */
  /** rev (v0.8): Gleichstände in gespiegelter Suchreihenfolge auflösen (von Südost statt Nordwest) – für punktsymmetrische Fairness. */
  function nearestPassable(cls, tx, ty, maxR, rev) {
    tx = Math.max(0, Math.min(W - 1, tx)); ty = Math.max(0, Math.min(H - 1, ty));
    if (passableXY(cls, tx, ty)) return ty * W + tx;
    var best = -1, bestD = 1e9;
    for (var r = 1; r <= maxR; r++) {
      for (var yy = -r; yy <= r; yy++) {
        for (var xx = -r; xx <= r; xx++) {
          var y = rev ? ty - yy : ty + yy, x = rev ? tx - xx : tx + xx;
          if (x !== tx - r && x !== tx + r && y !== ty - r && y !== ty + r) continue;
          if (!passableXY(cls, x, y)) continue;
          var d = (x - tx) * (x - tx) + (y - ty) * (y - ty);
          if (d < bestD) { bestD = d; best = y * W + x; }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  /**
   * Formations-Slots um Zielkachel: BFS über passierbare Kacheln (Klasse cls) ab Ziel.
   * needTiles: Anzahl benötigter Kacheln. Gibt Array von Kachelindizes in BFS-Reihenfolge zurück.
   */
  function slotTiles(cls, gtx, gty, needTiles, rev) {
    var res = [];
    var start = nearestPassable(cls, gtx, gty, 6, rev);
    if (start < 0) return res;
    bfsGen++;
    if (bfsGen >= 0xfffffff0) { bfsStamp.fill(0); bfsGen = 1; }
    var qh = 0, qt = 0;
    bfsQ[qt++] = start; bfsStamp[start] = bfsGen;
    while (qh < qt && res.length < needTiles) {
      var c = bfsQ[qh++];
      res.push(c);
      var cx = c % W, cy = (c - cx) / W;
      for (var d0 = 0; d0 < 8; d0++) {
        var d = rev ? REVD[d0] : d0;
        var nx = cx + DX[d], ny = cy + DY[d];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        var ni = ny * W + nx;
        if (bfsStamp[ni] === bfsGen || !passable(cls, ni)) continue;
        if (Math.abs(nx - gtx) > 12 || Math.abs(ny - gty) > 12) continue;
        bfsStamp[ni] = bfsGen; bfsQ[qt++] = ni;
      }
    }
    return res;
  }

  /**
   * Sichtlinie für Bewegung von (x0,y0) nach (x1,y1) in Pixeln, mit Freiraum r (Pixel).
   * Prüft Stichproben alle 8 px inkl. seitlicher Versätze.
   */
  function los(cls, x0, y0, x1, y1, r) {
    var dx = x1 - x0, dy = y1 - y0, len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1) return true;
    var steps = Math.ceil(len / 8), nx = -dy / len * r, ny = dx / len * r;
    for (var i = 1; i <= steps; i++) {
      var t = i / steps, x = x0 + dx * t, y = y0 + dy * t;
      if (!passablePx(cls, x, y) || !passablePx(cls, x + nx, y + ny) || !passablePx(cls, x - nx, y - ny)) return false;
    }
    return true;
  }

  /** Stellt eine Pfadanfrage in die Warteschlange (Einheit e mit Ziel e.gx/e.gy in Pixeln). */
  function request(S, e) {
    if (e.pp || e.mc === 2) return;   // v0.8: Luftfahrzeuge brauchen keinen Pfad
    e.pp = true;
    S.pq.push(e.id);
  }

  /**
   * Bearbeitet Pfadanfragen bis das Knotenbudget verbraucht ist. getEnt(id) liefert Entität.
   * Pro Anfrage max. 4000 Expansionen (dann Teilpfad).
   */
  function process(S, budget, getEnt) {
    var used = 0, n = 0;
    while (S.pq.length > 0 && used < budget) {
      var id = S.pq.shift();
      var e = getEnt(id);
      if (!e || e.dead || !e.pp) continue;
      e.pp = false;
      if (e.inside || e.mc === 2) continue;   // v0.3: Insassen eines Gebäudes haben keinen Pfad; v0.8: Luftfahrzeuge fliegen direkt
      var cls = e.pc != null ? e.pc : e.mc;   // v1.0: Schwebepanzer suchen mit Klasse 4
      var sx = Math.floor(e.x / TILE), sy = Math.floor(e.y / TILE);
      var gtx = Math.floor(e.gx / TILE), gty = Math.floor(e.gy / TILE);
      gtx = Math.max(0, Math.min(W - 1, gtx)); gty = Math.max(0, Math.min(H - 1, gty));
      var rv = flipOwner(S, e.owner);
      if (!passableXY(cls, gtx, gty)) {
        var alt = nearestPassable(cls, gtx, gty, 4, rv);
        if (alt >= 0) { gtx = alt % W; gty = (alt - gtx) / W; }
      }
      var p = find(cls, sx, sy, gtx, gty, MAXN, undefined, rv);
      used += lastExpanded + 10; n++;
      PST.req++; PST.exp += lastExpanded; if (lastExpanded > PST.max) PST.max = lastExpanded; if (lastExpanded > MAXN) PST.cut++;   // v0.9 Messung
      // v0.5: Ziel nicht erreichbar, gegnerische Mauern vorhanden, Einheit bewaffnet → Durchbruchspfad versuchen
      if (!lastReached && enemyWalls(e.owner) && G.Sim && G.Sim.statsOf(e).weapon) {
        var p2 = find(cls, sx, sy, gtx, gty, 6000, e.owner, rv);
        used += lastExpanded + 10;
        if (lastReached) p = p2;
      }
      e.path = p; e.pi = 0;
      // Zielkachel nicht erreicht → Endpunkt = Kachelmitte des letzten Pfadknotens
      var last = p.length ? p[p.length - 1] : sy * W + sx;
      e.pend = (last === gty * W + gtx) ? 1 : 0;
    }
    return n;
  }

  G.Path = {
    init: init, find: find, nearestPassable: nearestPassable, flipOwner: flipOwner, slotTiles: slotTiles, los: los,
    request: request, process: process, passable: passable, passableXY: passableXY, passablePx: passablePx,
    setWall: setWall, enemyWalls: enemyWalls, wallOwner: function (i) { return wallOwn ? wallOwn[i] : -1; },
    terrainPassable: function (cls, i) { return passT[cls][i] === 1; },
    // v0.8
    waterComp: function (i) { return wComp && i >= 0 && i < N ? wComp[i] : -1; }, waterSize: function (c) { return c >= 0 ? (wSize[c] || 0) : 0; },
    waterComps: function () { return wSize.length; },
    lastExpanded: function () { return lastExpanded; },
    stats: function (reset) { var r = { req: PST.req, exp: PST.exp, max: PST.max, cut: PST.cut, maxNodes: MAXN }; if (reset) PST = { req: 0, exp: 0, max: 0, cut: 0 }; return r; }
  };
})();
