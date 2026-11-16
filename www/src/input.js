/* FRONTLINIE – input.js  (v0.3: 3D-Kamera-Gesten, Gebäude besetzen/erobern, Artillerie)
 * G.Input: Touch / Maus / Tastatur → Kamera (G.view.cam), Auswahl (G.view.sel) und Befehle über G.cmd.
 * Verändert die Simulation AUSSCHLIESSLICH über G.cmd.*.
 *
 * Öffentliche Schnittstelle (u. a. von ui.js für Schnellbuttons genutzt):
 *   init()                 Listener registrieren (Canvas #cv, Minimap #mini, window)
 *   update(dt)             pro Frame: Tastatur-/Randscrollen, Trägheit, Langdruck, Hover-Hinweis
 *   selectArmy() / selectIdle() / selectType(typ)   Auswahlhilfen (selectType: Auswahl auf einen Typ einengen)
 *   saveGroup(n) / recallGroup(n)   Gruppen 0..2 (Anzeige 1..3); recall zweimal kurz = Kamera hin
 *   stopSel(), toggleAttackMove(), toggleBoxMode(), toggleAddMode(), deselect()
 *   beginPlacement(type)   Platzierungsmodus; Geist startet auf einem sinnvollen freien Platz nahe der Basis
 *   confirmPlacement(), cancelPlacement()
 *   exitSel()              Aussteigen für ein ausgewähltes eigenes besetztes Gebäude (G.cmd.exit)
 *   beginArty() / artyAim(wx,wy) / artyFire() / cancelArty()   Artillerieschlag: Zielwahl (V.arty)
 *   beginSuper(id) / swKind(b) / swInfo(b) / ownSupers() / toggleSuper()   v0.4 Superwaffen (Orbital/Rakete): Zielwahl nutzt V.arty
 *                          mit zusätzlichem Feld sw ('orbital'|'missile') und radius (Kacheln); Abfeuern über G.cmd.superweapon
 *   command(wx, wy, forceAM, target)   Kontextbefehl (wie Rechtsklick / Tippen mit Auswahl)
 *   tap(sx, sy, mouseBtn)  Tippen/Klick an Bildschirmposition
 *   isNeutralType(e), enterKind(e)     'enter' | 'capture' | null: kann die Auswahl dieses Gebäude betreten/erobern?
 *
 * Touch-Gesten: Tippen = wählen/befehlen, Doppeltipp auf Einheit = alle dieses Typs im Bild,
 *   1 Finger ziehen = Karte schieben (mit Trägheit), 2 Finger = Zoom + Schieben (Punkt zwischen den Fingern bleibt fest),
 *   Halten (0,4 s) + Ziehen = Auswahlrahmen, Halten + Loslassen mit Auswahl = Angriff-Bewegen,
 *   „Rahmen“-Schalter: nächstes Ziehen = Auswahlrahmen, Langdruck auf Minimap mit Auswahl = dorthin bewegen.
 *   Platzieren/Zielwahl: Geist bzw. Zielkreis mit dem Finger ziehen (Ziehen daneben schiebt die Karte), Tippen setzt neu.
 * Maus: Links wählen, Links ziehen Rahmen, Rechts Befehl, Mausrad Zoom zum Zeiger, Mitte ziehen = schieben, Bildrand scrollt.
 * Tasten: WASD/Pfeile scrollen (A/S nur ohne Auswahl), Strg+1..3 speichern, 1..3 abrufen, A Angriff-Bewegen,
 *   S Stopp, E Aussteigen, F Artillerieschlag, X Superwaffe, H Hilfe, Leertaste Pause, Esc abbrechen.
 * v0.5 Mauern: beginPlacement('wall') bzw. Kachel „Mauer“ → Mauer-Modus (V.placing = { type:'wall', tiles:[Index], ok:[bool je Kachel], cost, valid }).
 *   Ziehen (Touch 1 Finger / Maus links) von A nach B setzt eine gerade oder L-förmige Linie; „Bauen“ → G.cmd.placeWall(pid, tiles); Modus bleibt bis ✕ / Esc.
 * v0.5 Mobiler Bauhof: beginDeploy() (Taste D) → V.placing = { type:'hq', deploy:true, unitId, tx, ty, ok, reason }; Bestätigen → G.cmd.deploy.
 *   Doppeltipp auf den Bauhof baut direkt auf, wenn G.Sim.canDeploy ok. Eigener Bunker (kind2 garrison, nicht neutral) wird wie ein Haus besetzt (isGarrison).
 * v0.7 Diagonale Kamera: Wischen/Trägheit/Tasten/Bildrand schieben in Bildschirmrichtung (G.view.panBy), Auswahlrahmen im Bildschirmraum
 *   (Einheiten werden projiziert: unitsInScreenRect), Mauerlinie folgt der Kachelachse, die der ersten Fingerbewegung in Weltrichtung am nächsten ist
 *   (danach ggf. L-Knick), alle Platzierungs-/Zielmodi arbeiten in Weltkoordinaten unter dem Finger.
 * v0.7 Schützenpanzer: Infanterie wählen + eigenen Schützenpanzer antippen (Maus: Rechtsklick) = einsteigen (G.cmd.load, sonst G.cmd.smart);
 *   unloadSel() / Taste E = alle aussteigen (G.cmd.unload) für gewählte Schützenpanzer mit Passagieren. isTransport(e), passengers(e).
 * v0.4 Ingenieur: Auswahl mit Ingenieur + Tipp/Rechtsklick auf gegnerisches Basisgebäude = übernehmen (smart),
 *   auf eigenes beschädigtes Basisgebäude = reparieren (G.cmd.enter); Hover-Hinweis „Übernehmen“ / „Reparieren“.
 */
var G = (typeof G !== 'undefined') ? G : {};
(function () {
  'use strict';
  var D = G.DATA, TILE = D.TILE;
  var V, cv, mini;
  var ptrs = new Map();       // aktive Pointer auf dem Canvas
  var mode = 'none';          // none | maybe | pan | box | pinch | mpan | gdrag
  var downX = 0, downY = 0, downT = 0, holdArmed = false, isMouse = false;
  var pinch = null, gd = null;
  var lastTap = { t: 0, id: 0 };
  var keys = {};
  var mouse = { x: -1, y: -1, inside: false };
  var miniDown = null;
  var inertia = null, vel = { x: 0, y: 0, t: 0 };
  var lastP = { x: 0, y: 0 }, lastHover = 0;

  var ARTY_RANGE = 30, ARTY_RADIUS = 2;
  var SW_CHARGE = 360;                                  // Sekunden bis voll (SPEC_v04 §3)
  var SWD = { orbital: { name: 'Orbitalschlag', go: 'Orbitalschlag', radius: 3 }, missile: { name: 'Rakete', go: 'Rakete starten', radius: 4 },
              psi: { name: 'Psi-Welle', go: 'Psi-Welle auslösen', radius: 3.5 } };   // v1.0 Kollektiv

  function now() { return performance.now(); }
  function S() { return G.Sim.S; }
  function canAct() { return V.running && S() && !S().over; }
  function vib(p) { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) { /* egal */ } }
  function toast(t, bad, fn) { if (G.UI && G.UI.toast) G.UI.toast(t, bad, fn); }
  var lastSay = {};
  function say(key, cd) { try { var t = now(); if (t - (lastSay[key] || -1e9) < (cd || 8000)) return; lastSay[key] = t; if (G.Audio && G.Audio.say) G.Audio.say(key); } catch (e) { /* Ton optional */ } }
  var wd = null;              // laufende Mauer-Linie: { a:{x,y}, prev:{...} }
  var WALL_MAX = 30, lastWallEval = 0, lastDeployEval = 0;

  function localXY(ev, el) { var r = el.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; }

  // ------------------------------------------------------------------ Auswahl-Helfer
  function selUnits() { return V.mySel().filter(function (e) { return e.kind === 'unit'; }); }
  function selIds(arr) { return arr.map(function (e) { return e.id; }); }
  function setSel(ids) { V.sel = ids.slice(); G.UI && G.UI.onSelection && G.UI.onSelection(); }
  function marker(x, y, kind) { V.markers.push({ x: x, y: y, kind: kind, t0: now() }); }
  function isInfantry(u) { var d = D.UNITS[u.type]; return !!d && d.cat === 'infantry'; }
  function bcenter(b) { return { x: (b.tx + b.w / 2) * TILE, y: (b.ty + b.h / 2) * TILE }; }
  /** v0.7: Transportfahrzeug (Schützenpanzer) – Typ 'apc' oder Daten-/Entitätsfeld cap/transport. */
  function isTransport(e) {
    if (!e || e.kind !== 'unit') return false;
    var d = D.UNITS[e.type];
    return e.type === 'apc' || !!(d && (d.transport || d.cap)) || (e.cap > 0 && Array.isArray(e.gar));
  }
  function passengers(e) { return (e && e.gar) ? e.gar.length : 0; }
  function tcap(e) { var d = D.UNITS[e.type]; return e.cap || (d && (d.cap || (d.transport && d.transport.cap))) || 5; }
  /** v0.7: eigene Einheiten, deren (projizierte) Position im Bildschirmrechteck liegt – Auswahlrahmen arbeitet im Bildschirmraum. */
  function unitsInScreenRect(x0, y0, x1, y1) {
    var ax = Math.min(x0, x1), bx = Math.max(x0, x1), ay = Math.min(y0, y1), by = Math.max(y0, y1), r = [], ents = S().ents;
    for (var i = 0; i < ents.length; i++) {
      var e = ents[i];
      if (e.dead || e.inside || e.kind !== 'unit' || e.owner !== V.pid) continue;
      var p = V.toScreen(e.x, e.y), m = Math.min(10, (e.r || 8) * V.ppx() * 0.5);
      if (p.x >= ax - m && p.x <= bx + m && p.y >= ay - m && p.y <= by + m) r.push(e.id);
    }
    return r;
  }

  /** Neutrales/besetzbares Gebäude (Wohnhaus, Wohnblock, Bunker, Spezialgebäude)? */
  function isNeutralType(e) {
    if (!e || e.kind !== 'building') return false;
    var d = D.BUILDINGS[e.type];
    return !!(e.neutral || (d && d.neutral));
  }
  /** Besetzbares Gebäude (kind2 'garrison'): neutral (Haus, Block, Bunker) oder eigener Basis-Bunker (pbunker). */
  function isGarrison(e) { if (!e || e.kind !== 'building') return false; var d = D.BUILDINGS[e.type]; return !!(d && d.kind2 === 'garrison'); }
  function bkind2(e) { var d = D.BUILDINGS[e.type]; return (d && d.kind2) || (e.cap ? 'garrison' : 'special'); }
  function capOf(e) { var d = D.BUILDINGS[e.type]; return e.cap || (d && d.cap) || 0; }
  /** Was würde die aktuelle Infanterie-Auswahl mit diesem Gebäude tun? 'enter' | 'capture' | 'full' | null */
  function enterKind(e) {
    if (!e || e.ruin) return null;
    if (!isNeutralType(e) && !(isGarrison(e) && e.owner === V.pid)) return null;   // Basis-Bunker: nur der eigene lässt sich besetzen
    if (bkind2(e) === 'garrison') {
      if (e.owner >= 0 && e.owner !== V.pid) return null;   // vom Gegner besetzt → angreifen
      if ((e.gar || []).length >= capOf(e)) return 'full';
      return 'enter';
    }
    return e.owner === V.pid ? null : 'capture';
  }

  /** v0.4 Ingenieur: was würde die Auswahl (mit Ingenieur) mit diesem Basisgebäude tun? 'takeover' | 'repair' | null */
  function engKind(e) {
    if (!e || e.kind !== 'building' || e.dead || isNeutralType(e)) return null;
    if (!selUnits().some(function (u) { return u.type === 'engineer'; })) return null;
    if (e.owner >= 0 && e.owner !== V.pid) return e.type === 'hq' ? null : 'takeover';
    if (e.owner === V.pid && e.hp < e.maxHp) return 'repair';
    return null;
  }

  function selectArmy() {
    var r = [];
    S().ents.forEach(function (e) { if (!e.dead && !e.inside && e.kind === 'unit' && e.owner === V.pid && G.Sim.statsOf(e).weapon) r.push(e.id); });
    setSel(r);
  }
  function selectIdle() {
    var r = [];
    S().ents.forEach(function (e) {
      if (e.dead || e.inside || e.kind !== 'unit' || e.owner !== V.pid) return;
      var harv = !!G.Sim.statsOf(e).harvester;
      if ((!harv && e.ord === 'idle' && !e.tgt) || (harv && e.ord !== 'harvest' && e.ord !== 'move') || (harv && (e.hs === 'idle' || e.hs === 'wait'))) r.push(e.id);
    });
    setSel(r);
    if (r.length) { var e = G.Sim.get(r[0]); V.centerOn(e.x, e.y); } else toast('Keine untätigen Einheiten');
  }
  function selectType(type) { setSel(selUnits().filter(function (e) { return e.type === type; }).map(function (e) { return e.id; })); }
  var lastRecall = { n: -1, t: 0 };
  function saveGroup(n) {
    V.groups[n] = selIds(selUnits());
    toast('Gruppe ' + (n + 1) + ' gespeichert (' + V.groups[n].length + ')');
    vib(20);
  }
  function recallGroup(n) {
    var ids = (V.groups[n] || []).filter(function (id) { var e = G.Sim.get(id); return e && !e.dead; });
    V.groups[n] = ids;
    if (!ids.length) { toast('Gruppe ' + (n + 1) + ' ist leer – Taste lange drücken zum Speichern'); return; }
    setSel(ids);
    if (lastRecall.n === n && now() - lastRecall.t < 400 && ids.length) { var e = G.Sim.get(ids[0]); V.centerOn(e.x, e.y); }
    lastRecall.n = n; lastRecall.t = now();
  }
  /** v1.2: gewählte Fahrzeuge zur nächsten Reparaturstelle schicken (Knopf „Reparatur“). */
  function repairSel() {
    var u = selUnits(); if (!u.length) return;
    var r = G.cmd.repairAt(V.pid, selIds(u));
    if (!r.ok) { toast(r.reason || 'Nicht möglich', true); return; }
    toast(r.n + (r.n === 1 ? ' Fahrzeug fährt' : ' Fahrzeuge fahren') + ' zur Reparatur');
  }
  function stopSel() { var u = selUnits(); if (u.length) G.cmd.stop(V.pid, selIds(u)); V.amArmed = false; }
  function toggleAttackMove() { V.amArmed = !V.amArmed && selUnits().length > 0; }
  function toggleBoxMode() { V.boxMode = !V.boxMode; }
  function toggleAddMode() { V.addMode = !V.addMode; }
  function deselect() { setSel([]); V.amArmed = false; V.arty = null; }
  // ---- v0.9.2 Reparatur: Reparatur-Modus (Gebäude antippen = Reparatur umschalten), Alle reparieren
  function toggleRepairMode(on) {
    var v = (on == null) ? !V.repairMode : !!on;
    if (v && !canAct()) return false;
    if (v) { if (V.placing) cancelPlacement(); V.arty = null; V.amArmed = false; V.boxMode = false; V.addMode = false; }
    V.repairMode = v;
    return v;
  }
  function repairAll() {
    var r = G.cmd.repairAll(V.pid);
    if (!r.ok) return r;
    toast(!r.n ? 'Nichts beschädigt' : (r.on ? 'Reparatur läuft: ' + r.n + (r.n === 1 ? ' Gebäude' : ' Gebäude') : 'Reparatur gestoppt'), !r.n);
    return r;
  }
  /** Eigenes, reparierbares Gebäude an Bildschirmposition (Einheiten darüber werden ignoriert). */
  function repairTarget(sx, sy, w, slack) {
    var e = pick(sx, sy, slack, w);
    if (e && e.kind === 'building' && e.owner === V.pid && !e.neutral) return e;
    var S0 = S(), TL = G.DATA.TILE;
    for (var i = 0; i < S0.ents.length; i++) {
      var b = S0.ents[i];
      if (b.dead || b.kind !== 'building' || b.owner !== V.pid || b.neutral) continue;
      if (w.x >= b.tx * TL - slack && w.x < (b.tx + b.w) * TL + slack && w.y >= b.ty * TL - slack && w.y < (b.ty + b.h) * TL + slack) return b;
    }
    return null;
  }
  function repairTap(sx, sy, mouseBtn) {
    var w = V.toWorld(sx, sy), b = repairTarget(sx, sy, w, mouseBtn ? 2 : 10);
    if (!b) { V.repairMode = false; return; }                         // Boden / anderes = Modus beenden
    if (b.hp >= b.maxHp) { toast('Unbeschädigt', true); return; }
    var r = G.cmd.repair(V.pid, b.id);
    if (r.ok) { toast(b.repairing ? 'Reparatur läuft' : 'Reparatur gestoppt'); vib(10); } else toast(r.reason || 'Nicht reparierbar', true);
  }

  // ------------------------------------------------------------------ Platzierung
  /** Sinnvoller freier Bauplatz: nahe dem Bildschirmzentrum (falls dort Basis ist), sonst nahe dem HQ, mit Luft zu Nachbarn. */
  function findSpot(type) {
    var s = S(), b = D.BUILDINGS[type], P = V.pid, own = [], hq = null;
    s.ents.forEach(function (e) { if (!e.dead && e.kind === 'building' && e.owner === P) { own.push(e); if (e.type === 'hq') hq = e; } });
    if (!own.length) return null;
    var ref = hq ? { x: hq.tx + hq.w / 2, y: hq.ty + hq.h / 2 } : { x: own[0].tx, y: own[0].ty };
    var c = V.toWorld(V.vw / 2, V.vh / 2); c = { x: c.x / TILE, y: c.y / TILE };
    if (Math.hypot(c.x - ref.x, c.y - ref.y) < 13) ref = c;
    var m = s.map, seen = {}, best = null, bs = 1e9, R = D.PLACE_DIST;
    function occ(x, y) { return x < 0 || y < 0 || x >= m.w || y >= m.h || s.occ[y * m.w + x] || !D.TERRAIN[m.terrain[y * m.w + x]].build || m.ore[y * m.w + x] > 0; }
    own.forEach(function (o) {
      for (var ty = o.ty - b.h - R; ty <= o.ty + o.h + R; ty++) for (var tx = o.tx - b.w - R; tx <= o.tx + o.w + R; tx++) {
        var k = ty * 4096 + tx; if (seen[k]) continue; seen[k] = 1;
        var d = Math.hypot(tx + b.w / 2 - ref.x, ty + b.h / 2 - ref.y);
        if (d > bs) continue;                                    // schon schlechter als der beste → billig überspringen
        var crowd = 0;                                           // Ring um den Grundriss: belegt = Engstelle für Fahrzeuge
        for (var x = tx - 1; x <= tx + b.w; x++) { crowd += occ(x, ty - 1) + occ(x, ty + b.h); }
        for (var y = ty; y < ty + b.h; y++) { crowd += occ(tx - 1, y) + occ(tx + b.w, y); }
        var sc = d + crowd * 0.9;
        if (sc >= bs) continue;
        if (!G.Sim.canPlace(P, type, tx, ty).ok) continue;
        bs = sc; best = { tx: tx, ty: ty };
      }
    });
    return best;
  }
  function beginPlacement(type) {
    var b = D.BUILDINGS[type];
    if (b && b.noQueue) return beginWall();   // v1.2: Tor (isWall, aber mit Warteschlange) wird normal platziert
    V.placing = { type: type, tx: null, ty: null, ok: false, reason: '', set: false };
    V.amArmed = false; V.arty = null;
    setSel([]);
    var spot = findSpot(type);
    if (spot) {
      var p = V.placing; p.tx = spot.tx; p.ty = spot.ty;
      var r = G.Sim.canPlace(V.pid, type, p.tx, p.ty); p.ok = r.ok; p.reason = r.reason; p.set = true;
      var sc = V.toScreen((p.tx + b.w / 2) * TILE, (p.ty + b.h / 2) * TILE), mb = 90;
      if (sc.x < mb || sc.y < mb || sc.x > V.vw - mb || sc.y > V.vh - mb - 40) V.centerOn((p.tx + b.w / 2) * TILE, (p.ty + b.h / 2) * TILE);
    } else {
      var c = V.toWorld(V.vw / 2, V.vh / 2);
      setGhost(c.x, c.y);
    }
    return b;
  }
  function setGhost(wx, wy) {
    var p = V.placing, b = D.BUILDINGS[p.type];
    if (!p || p.wall || p.deploy) return;
    p.tx = Math.floor(wx / TILE - b.w / 2 + 0.5); p.ty = Math.floor(wy / TILE - b.h / 2 + 0.5);
    var r = G.Sim.canPlace(V.pid, p.type, p.tx, p.ty);
    p.ok = r.ok; p.reason = r.reason; p.set = true;
  }
  function confirmPlacement() {
    var p = V.placing;
    if (p && p.wall) return confirmWall();
    if (p && p.deploy) return confirmDeploy();
    if (!p || p.tx == null) return false;
    var r = G.cmd.placeBuilding(V.pid, p.type, p.tx, p.ty);
    if (r.ok) { V.placing = null; return true; }
    toast(r.reason || 'Hier nicht möglich', true);
    if (/Credits|Geld/i.test(r.reason || '')) say('noMoney');
    return false;
  }
  function cancelPlacement() { V.placing = null; wd = null; }
  function nearGhost(w) {
    var p = V.placing; if (!p || p.tx == null || p.deploy || p.wall) return null;
    var b = D.BUILDINGS[p.type], cx = (p.tx + b.w / 2) * TILE, cy = (p.ty + b.h / 2) * TILE;
    if (Math.abs(w.x - cx) <= (b.w / 2 + 1.2) * TILE && Math.abs(w.y - cy) <= (b.h / 2 + 1.2) * TILE) return { dx: cx - w.x, dy: cy - w.y, kind: 'place' };
    return null;
  }

  // ------------------------------------------------------------------ v0.5 Mauern
  function isWallMode() { return !!(V.placing && V.placing.wall); }
  function wallCost() { var d = D.BUILDINGS.wall; return (d && d.cost) || 50; }
  function beginWall() {
    if (!D.BUILDINGS.wall) { toast('Mauern nicht verfügbar', true); return null; }
    V.placing = { type: 'wall', wall: true, tiles: [], ok: [], cost: 0, valid: 0, reason: '', tx: null, ty: null, set: false };
    V.amArmed = false; V.arty = null; wd = null;
    setSel([]);
    return V.placing;
  }
  function tileAt(sx, sy) {
    var m = S().map, w = V.toWorld(sx, sy);
    return { x: Math.max(0, Math.min(m.w - 1, Math.floor(w.x / TILE))), y: Math.max(0, Math.min(m.h - 1, Math.floor(w.y / TILE))) };
  }
  /** Gerade bzw. L-förmige Kachelfolge von a nach b (Hauptachse zuerst), höchstens WALL_MAX Kacheln.
   *  axis ('x'|'y', optional): v0.7 – erste Achse vorgeben (aus der Fingerrichtung), sonst die längere Strecke. */
  function wallLine(a, b, axis) {
    var w = S().map.w, r = [], x = a.x, y = a.y, dx = b.x - a.x, dy = b.y - a.y, sx = dx < 0 ? -1 : 1, sy = dy < 0 ? -1 : 1;
    function add(px, py) { if (r.length < WALL_MAX) r.push(py * w + px); }
    add(x, y);
    if (axis ? axis === 'x' : Math.abs(dx) >= Math.abs(dy)) {
      while (x !== b.x) { x += sx; add(x, y); }
      while (y !== b.y) { y += sy; add(x, y); }
    } else {
      while (y !== b.y) { y += sy; add(x, y); }
      while (x !== b.x) { x += sx; add(x, y); }
    }
    return r;
  }
  /** Bebaubarkeit je Kachel (wie G.Sim.canPlace für 1×1, ohne Nähe-Regel) + Nähe-Regel mit Kettenfortsetzung; Kosten, Credits-Grenze. */
  function wallEval(p) {
    var s = S(), m = s.map, P = s.players[V.pid], n = p.tiles.length, i, e, TER = D.TERRAIN;
    var bases = [], ownWalls = {}, units = [];
    for (i = 0; i < s.ents.length; i++) {
      e = s.ents[i];
      if (e.dead) continue;
      if (e.kind === 'unit') { if (!e.inside) units.push(e); continue; }
      var d = D.BUILDINGS[e.type];
      if (e.owner !== V.pid) continue;
      if (d && d.isWall) ownWalls[e.ty * m.w + e.tx] = 1;
      else if (!e.neutral || (d && d.kind2 === 'special')) bases.push(e);
    }
    var base = [], ok = [], why = [];
    for (i = 0; i < n; i++) {
      var idx = p.tiles[i], x = idx % m.w, y = (idx - x) / m.w, r = '';
      if (!TER[m.terrain[idx]].build) r = 'Ungeeignetes Gelände';
      else if (m.ore[idx] > 0) r = 'Nicht auf Erz';
      else if (s.occ[idx]) r = 'Belegt';
      else {
        for (var k = 0; k < units.length; k++) { var u = units[k]; if (u.x + u.r > x * TILE && u.x - u.r < (x + 1) * TILE && u.y + u.r > y * TILE && u.y - u.r < (y + 1) * TILE) { r = 'Einheiten im Weg'; break; } }
      }
      base.push(!r); why.push(r);
      var near = false;
      if (!r) {
        for (k = 0; k < bases.length && !near; k++) {
          var b = bases[k], gx = Math.max(0, b.tx - (x + 1), x - (b.tx + b.w)), gy = Math.max(0, b.ty - (y + 1), y - (b.ty + b.h));
          if (Math.max(gx, gy) <= D.PLACE_DIST) near = true;
        }
        if (!near) near = !!(ownWalls[idx - 1] || ownWalls[idx + 1] || ownWalls[idx - m.w] || ownWalls[idx + m.w]);   // schließt an eigene Mauerkette an
        if (!near) why[i] = 'Zu weit von der Basis';
      }
      ok.push(base[i] && near);
    }
    for (var pass = 0, ch = true; ch && pass < 4; pass++) {          // Kette: Nachbar in der Linie mit gültiger Nähe-Regel reicht
      ch = false;
      for (i = 0; i < n; i++) if (base[i] && !ok[i] && ((i > 0 && ok[i - 1]) || (i < n - 1 && ok[i + 1]))) { ok[i] = true; ch = true; }
    }
    var cost = wallCost(), afford = Math.floor(P.credits / cost), valid = 0, broke = false;
    for (i = 0; i < n; i++) {
      if (!ok[i]) continue;
      if (valid >= afford) { ok[i] = false; why[i] = 'Zu wenig Credits'; broke = true; continue; }
      valid++;
    }
    p.ok = ok; p.valid = valid; p.cost = valid * cost; p.broke = broke;
    p.reason = valid ? '' : (why.filter(Boolean)[0] || (n ? 'Hier nicht möglich' : ''));
    lastWallEval = now();
  }
  function setWallLine(a, b) {
    var p = V.placing; if (!p || !p.wall) return;
    p.tiles = wallLine(a, b, wd && wd.axis); wallEval(p); p.set = p.tiles.length > 0;
  }
  /** v0.7: Mauer-Ziehen – erste Achse = Kachelachse, die der Fingerrichtung (in Weltkoordinaten) am nächsten liegt.
   *  Festgelegt, sobald der Finger ≥ 0,6 Kacheln vom Start entfernt ist; kehrt er bis auf 0,35 Kacheln zurück, wird neu entschieden. */
  function wallDragTo(sx, sy) {
    if (!wd) return;
    var w = V.toWorld(sx, sy), dx = (w.x - wd.w0.x) / TILE, dy = (w.y - wd.w0.y) / TILE, d = Math.hypot(dx, dy);
    if (d < 0.35) wd.axis = null;
    else if (!wd.axis && d >= 0.6) wd.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
    setWallLine(wd.a, tileAt(sx, sy));
  }
  function startWall(px, py) {
    var p = V.placing, t = tileAt(px, py);
    wd = { a: t, w0: V.toWorld(px, py), axis: null, prev: { tiles: p.tiles, ok: p.ok, cost: p.cost, valid: p.valid, reason: p.reason, set: p.set } };
    setWallLine(t, t);
    mode = 'wdrag';
  }
  function restoreWall() {
    var p = V.placing; if (!p || !p.wall || !wd) return;
    for (var k in wd.prev) p[k] = wd.prev[k];
  }
  function confirmWall() {
    var p = V.placing; if (!p || !p.wall) return false;
    var ids = p.tiles.filter(function (t, i) { return p.ok[i]; });
    if (!ids.length) { toast(p.reason || 'Zuerst eine Linie ziehen', true); return false; }
    if (!G.cmd.placeWall) { toast('Mauern nicht verfügbar', true); return false; }
    var r = G.cmd.placeWall(V.pid, ids.slice(0, WALL_MAX));
    var placed = r && r.placed != null ? r.placed : (r && r.ok ? ids.length : 0);
    if (placed > 0) {
      toast(placed === 1 ? '1 Mauersegment gebaut' : placed + ' Mauersegmente gebaut' + (placed < ids.length ? ' (von ' + ids.length + ')' : ''));
      vib(25);
      if (r && r.reason && /Credits|Geld/i.test(r.reason)) say('noMoney');
      p.tiles = []; p.ok = []; p.cost = 0; p.valid = 0; p.reason = ''; p.set = false; wd = null;
      return true;
    }
    var why = (r && r.reason) || 'Hier nicht möglich';
    toast(why, true);
    if (/Credits|Geld/i.test(why)) say('noMoney');
    wallEval(p);
    return false;
  }

  // ------------------------------------------------------------------ v0.5 Mobiler Bauhof
  function selMcv() { return selUnits().filter(function (e) { return e.type === 'mcv'; })[0] || null; }
  /** Vorschau: HQ (3×3) zentriert auf der Kachel des Fahrzeugs (tx−1, ty−1); Gültigkeit aus G.Sim.canDeploy. */
  function deployInfo(u) {
    var r = (G.Sim.canDeploy && G.Sim.canDeploy(V.pid, u.id)) || { ok: false, reason: 'Aufbauen nicht verfügbar' };
    return { ok: !!r.ok, reason: r.reason || '', tx: Math.floor(u.x / TILE) - 1, ty: Math.floor(u.y / TILE) - 1 };
  }
  function beginDeploy() {
    var u = selMcv();
    if (!u) { toast('Zuerst den Mobilen Bauhof wählen', true); return false; }
    if (!G.cmd.deploy) { toast('Aufbauen nicht verfügbar', true); return false; }
    var i = deployInfo(u);
    V.placing = { type: 'hq', deploy: true, unitId: u.id, tx: i.tx, ty: i.ty, ok: i.ok, reason: i.reason, set: true };
    V.amArmed = false; V.arty = null;
    var sc = V.toScreen(u.x, u.y), mb = 90;
    if (sc.x < mb || sc.y < mb || sc.x > V.vw - mb || sc.y > V.vh - mb - 40) V.centerOn(u.x, u.y);
    if (!i.ok) toast(i.reason || 'Hier nicht möglich', true);
    return true;
  }
  function refreshDeploy() {
    var p = V.placing; if (!p || !p.deploy) return;
    var u = G.Sim.get(p.unitId);
    if (!u || u.dead || u.kind !== 'unit') { V.placing = null; return; }
    var i = deployInfo(u); p.tx = i.tx; p.ty = i.ty; p.ok = i.ok; p.reason = i.reason; lastDeployEval = now();
  }
  function confirmDeploy() {
    var p = V.placing; if (!p || !p.deploy) return false;
    refreshDeploy(); p = V.placing; if (!p) return false;
    if (!p.ok) { toast(p.reason || 'Hier nicht möglich', true); return false; }
    var r = G.cmd.deploy(V.pid, p.unitId);
    if (r && r.ok !== false) { V.placing = null; setSel([]); toast('Bauhof aufgebaut'); vib([30, 30, 60]); return true; }
    toast((r && r.reason) || 'Hier nicht möglich', true);
    return false;
  }
  /** Direkt aufbauen (Doppeltipp auf den Bauhof), wenn möglich – sonst Begründung. */
  function deployNow(u) {
    var i = deployInfo(u);
    if (!i.ok) { toast(i.reason || 'Hier nicht möglich', true); return false; }
    if (!G.cmd.deploy) { toast('Aufbauen nicht verfügbar', true); return false; }
    var r = G.cmd.deploy(V.pid, u.id);
    if (r && r.ok !== false) { toast('Bauhof aufgebaut'); vib([30, 30, 60]); setSel([]); return true; }
    toast((r && r.reason) || 'Hier nicht möglich', true);
    return false;
  }

  // ------------------------------------------------------------------ Artillerie
  function selBuilding() { var s = V.mySel(); return (s.length === 1 && s[0].kind === 'building') ? s[0] : null; }
  function beginArty() {
    var b = selBuilding();
    if (!b || b.owner !== V.pid || bkindSpecial(b) !== 'arty') return false;
    if ((b.charge || 0) < 1) { toast('Artillerie lädt noch (' + Math.ceil((1 - (b.charge || 0)) * 180) + ' s)', true); return false; }
    V.arty = { id: b.id, x: 0, y: 0, set: false, ok: false, reason: '' };
    V.amArmed = false; V.placing = null;
    // Vorbelegung: Bildschirmmitte
    var c = V.toWorld(V.vw / 2, V.vh / 2); artyAim(c.x, c.y); V.arty.set = false;
    toast('Ziel auf der Karte wählen');
    return true;
  }
  function bkindSpecial(b) { var d = D.BUILDINGS[b.type]; return (d && d.special) || (b.type === 'artillery' ? 'arty' : ''); }
  function artyAim(wx, wy) {
    var a = V.arty; if (!a) return;
    var b = G.Sim.get(a.id); if (!b) { V.arty = null; return; }
    a.x = wx; a.y = wy; a.set = true;
    if (a.sw) {                                              // ganze Karte Reichweite, Ziel muss erforscht sein
      var m = S().map, tx = Math.floor(wx / TILE), ty = Math.floor(wy / TILE);
      if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h) { a.ok = false; a.reason = 'Ziel außerhalb der Karte'; return; }
      var known = S().settings.fogOff || !G.Sim.explored || G.Sim.explored(V.pid, { tx: tx, ty: ty, w: 1, h: 1 });
      a.ok = !!known; a.reason = known ? '' : 'Ziel unerforscht';
      return;
    }
    var c = bcenter(b), d = Math.hypot(wx - c.x, wy - c.y) / TILE;
    a.ok = d <= ARTY_RANGE; a.reason = a.ok ? '' : 'Ziel außer Reichweite';
  }
  function artyFire() {
    var a = V.arty; if (!a || !a.set) return false;
    if (a.sw) {
      if (!G.cmd.superweapon) { toast('Superwaffe nicht verfügbar', true); return false; }
      var sr = G.cmd.superweapon(V.pid, a.id, a.x, a.y);
      if (sr && sr.ok) { marker(a.x, a.y, 'attack'); V.arty = null; toast(a.sw === 'orbital' ? 'Orbitalschlag eingeleitet' : (a.sw === 'psi' ? 'Psi-Welle ausgelöst' : 'Rakete gestartet')); vib([60, 40, 100]); return true; }
      toast((sr && sr.reason) || 'Nicht möglich', true);
      if (sr && /lädt|geladen|Keine Superwaffe/i.test(sr.reason || '')) V.arty = null;
      return false;
    }
    if (!G.cmd.artillery) { toast('Artillerie nicht verfügbar', true); return false; }
    var r = G.cmd.artillery(V.pid, a.id, a.x, a.y);
    if (r && r.ok) { marker(a.x, a.y, 'attack'); V.arty = null; toast('Artillerieschlag unterwegs'); vib(40); return true; }
    toast((r && r.reason) || 'Nicht möglich', true);
    if (r && /geladen|lädt/i.test(r.reason || '')) V.arty = null;
    return false;
  }
  function cancelArty() { V.arty = null; }

  // ------------------------------------------------------------------ v0.4 Superwaffen
  /** 'orbital' | 'missile' | '' für ein (eigenes oder fremdes) Superwaffen-Gebäude. */
  function swKind(b) { var d = b && D.BUILDINGS[b.type]; return (d && d.superweapon) || ''; }
  function swFmt(sec) { sec = Math.max(0, Math.ceil(sec)); var m = Math.floor(sec / 60), r = sec % 60; return m + ':' + (r < 10 ? '0' : '') + r; }
  /** Zustand einer eigenen Superwaffe: { kind, name, go, radius, c (0..1), ready, secs (Restzeit), txt (m:ss) } */
  function swInfo(b) {
    var k = swKind(b); if (!k) return null;
    var c = Math.max(0, Math.min(1, b.charge || 0)), P = S().players[b.owner >= 0 ? b.owner : V.pid];
    var rate = (P && P.pwrUse > P.pwrProd) ? 0.5 : 1;              // Energiemangel: halbe Ladegeschwindigkeit
    var secs = (1 - c) * SW_CHARGE / rate, d = SWD[k];
    return { kind: k, name: d.name, go: d.go, radius: d.radius, c: c, ready: c >= 1, secs: secs, txt: swFmt(secs) };
  }
  function ownSupers() {
    return S().ents.filter(function (e) { return e.kind === 'building' && !e.dead && e.owner === V.pid && swKind(e); });
  }
  function beginSuper(id) {
    var b = id != null ? G.Sim.get(id) : null;
    if (!b || b.dead || b.owner !== V.pid || !swKind(b)) return false;
    var inf = swInfo(b);
    if (!inf.ready) { toast(inf.name + ' lädt noch (' + inf.txt + ')', true); return false; }
    if (!G.cmd.superweapon) { toast('Superwaffe nicht verfügbar', true); return false; }
    V.arty = { id: b.id, x: 0, y: 0, set: false, ok: false, reason: '', sw: inf.kind, radius: inf.radius };
    V.amArmed = false; V.placing = null;
    var c = V.toWorld(V.vw / 2, V.vh / 2); artyAim(c.x, c.y); V.arty.set = false;
    toast('Ziel auf der Karte wählen');
    return true;
  }
  /** Hotkey X: Zielwahl der gewählten bzw. ersten eigenen Superwaffe ein/aus. */
  function toggleSuper() {
    if (V.arty && V.arty.sw) { cancelArty(); return; }
    var b = selBuilding();
    if (!(b && b.owner === V.pid && swKind(b))) b = ownSupers()[0];
    if (!b) { toast('Keine Superwaffe vorhanden', true); return; }
    beginSuper(b.id);
  }
  /** v0.7: gewählte eigene Schützenpanzer mit Passagieren → alle aussteigen (G.cmd.unload). */
  function selApcs() { return selUnits().filter(function (u) { return isTransport(u) && passengers(u) > 0; }); }
  function unloadSel() {
    var a = selApcs();
    if (!a.length) { toast('Keine Passagiere an Bord', true); return false; }
    if (!G.cmd.unload) { toast('Aussteigen nicht verfügbar', true); return false; }
    var n = 0, why = '';
    a.forEach(function (u) { var c = passengers(u), r = G.cmd.unload(V.pid, u.id); if (r && r.ok === false) why = r.reason || 'Nicht möglich'; else n += c; });
    if (n) toast(n === 1 ? '1 Infanterist steigt aus' : n + ' Infanteristen steigen aus'); else toast(why || 'Nicht möglich', true);
    return n > 0;
  }
  function exitSel() {
    var b = selBuilding();
    if (!b && selApcs().length) { unloadSel(); return; }
    if (!b || b.owner !== V.pid || !G.cmd.exit) return;
    var r = G.cmd.exit(V.pid, b.id);
    if (r && r.ok === false) toast(r.reason || 'Nicht möglich', true); else toast('Einheiten steigen aus');
  }

  // ------------------------------------------------------------------ Befehle
  /** Kontextbefehl für die aktuelle Auswahl an Weltposition. target: optional bereits ermittelte Entität. */
  function command(wx, wy, forceAM, target) {
    var units = selUnits(), sel = V.mySel();
    if (units.length) {
      var ids = selIds(units);
      if (V.amArmed || forceAM) {
        G.cmd.attackMove(V.pid, ids, wx, wy); marker(wx, wy, 'attack'); V.amArmed = false; return true;
      }
      var inf = units.filter(isInfantry), ek = target && enterKind(target);
      // v0.7: Infanterie + eigener Schützenpanzer → einsteigen (G.cmd.load; ohne load übernimmt G.cmd.smart an der Panzerposition)
      if (target && isTransport(target) && target.owner === V.pid && !target.dead) {
        // v0.8: alle Transporter – wer einsteigen darf, entscheidet die Sim (Landungsboot auch Fahrzeuge)
        var pinf = units.filter(function (u) { return u.id !== target.id && (G.Sim.canCarry ? G.Sim.canCarry(target, u) : isInfantry(u)); });
        if (pinf.length) {
          var free = tcap(target) - (G.Sim.usedSlots ? G.Sim.usedSlots(target) : passengers(target));
          if (free <= 0) { toast((D.UNITS[target.type] ? D.UNITS[target.type].name : 'Schützenpanzer') + ' ist voll', true); return true; }
          var lr = G.cmd.load ? G.cmd.load(V.pid, selIds(pinf), target.id) : G.cmd.smart(V.pid, selIds(pinf), target.x, target.y);
          if (lr && lr.ok === false) { toast(lr.reason || 'Nicht möglich', true); return true; }
          marker(target.x, target.y, 'move');
          toast(lr && lr.n != null && lr.n < pinf.length ? 'Einsteigen: nur ' + lr.n + ' passen hinein' : (pinf.every(isInfantry) ? 'Infanterie steigt ein …' : 'Einheiten steigen ein …'));
          var rest0 = units.filter(function (u) { return pinf.indexOf(u) < 0 && u.id !== target.id; });
          if (rest0.length) G.cmd.smart(V.pid, selIds(rest0), target.x, target.y);
          return true;
        }
      }
      if (target && ek && ek !== 'full' && inf.length && G.cmd.enter) {
        var er = G.cmd.enter(V.pid, selIds(inf), target.id);
        if (!er.ok) { toast(er.reason || 'Nicht möglich', true); return true; }
        var bc = bcenter(target);
        marker(bc.x, bc.y, 'move');
        toast(ek === 'capture' ? 'Infanterie erobert …' : 'Infanterie besetzt …');
        var rest = units.filter(function (u) { return !isInfantry(u); });
        if (rest.length) G.cmd.smart(V.pid, selIds(rest), wx, wy);
        return true;
      }
      if (ek === 'full') { toast('Gebäude ist voll', true); return true; }
      if (target && engKind(target) === 'repair' && G.cmd.enter) {          // Ingenieur repariert eigenes beschädigtes Gebäude
        var engs = units.filter(function (u) { return u.type === 'engineer'; });
        var rr2 = G.cmd.enter(V.pid, selIds(engs), target.id);
        if (!rr2 || rr2.ok === false) { toast((rr2 && rr2.reason) || 'Nicht möglich', true); return true; }
        var bc2 = bcenter(target); marker(bc2.x, bc2.y, 'move'); toast('Ingenieur repariert …');
        var rest2 = units.filter(function (u) { return u.type !== 'engineer'; });
        if (rest2.length) G.cmd.smart(V.pid, selIds(rest2), wx, wy);
        return true;
      }
      var r = G.cmd.smart(V.pid, ids, wx, wy);
      if (r && r.ok === false) { toast(r.reason || 'Nicht möglich', true); return true; }
      marker(wx, wy, r && r.kind === 'attack' ? 'attack' : 'move');
      if (r && r.kind === 'repair') toast('Zur Reparatur …');   // v1.2
      if (r && r.kind === 'enter') toast('Infanterie besetzt …'); else if (r && r.kind === 'capture') toast('Infanterie erobert …'); else if (r && r.kind === 'engineer') toast('Ingenieur übernimmt …');
      return true;
    }
    if (sel.length === 1 && sel[0].kind === 'building' && sel[0].owner === V.pid && D.BUILDINGS[sel[0].type].produces) {
      var rr = G.cmd.setRally(V.pid, sel[0].id, wx, wy);
      if (rr.ok) { marker(wx, wy, 'rally'); toast('Sammelpunkt gesetzt'); }
      return true;
    }
    return false;
  }

  function selectAllOfTypeOnScreen(type) {
    var r = unitsInScreenRect(0, 0, V.vw, V.vh).filter(function (id) { var e = G.Sim.get(id); return e && e.type === type; });   // v0.7: im Bild = Bildschirmraum
    setSel(r);
    toast(r.length + '× ' + D.UNITS[type].name + ' gewählt');
  }

  function pick(sx, sy, slack, w) {
    var e = (G.Render.pickAt && G.Render.pickAt(sx, sy, slack)) || G.Sim.entityAt(w.x, w.y, V.pid, slack);
    return (e && !e.dead && !e.inside) ? e : null;
  }

  /** Tippen/Linksklick an Bildschirmposition. */
  function tap(sx, sy, mouseBtn) {
    if (G.Render.glOK && !G.Render.glOK()) { G.Render.restartGL(); return; } // Grafik fehlt: Tippen = neuer Versuch
    if (!canAct()) return;
    if (V.repairMode && (V.placing || V.arty)) V.repairMode = false;       // v0.9.2 Reparatur
    if (V.repairMode) { repairTap(sx, sy, mouseBtn); return; }              // v0.9.2 Reparatur
    var w = V.toWorld(sx, sy);
    if (V.placing) {
      if (V.placing.wall || V.placing.deploy) return;           // Mauer: Ziehen; Bauhof: Knopf „Aufbauen“
      setGhost(w.x, w.y);
      if (mouseBtn) confirmPlacement();
      return;
    }
    if (V.arty) {
      artyAim(w.x, w.y);
      if (mouseBtn) artyFire();
      return;
    }
    var units = selUnits();
    if (V.amArmed && units.length) { command(w.x, w.y, true); return; }
    var e = pick(sx, sy, mouseBtn ? 6 : 14, w);
    var hasInf = units.some(isInfantry);
    if (e && e.kind === 'unit' && e.owner === V.pid && !mouseBtn && !V.addMode && isTransport(e) && units.some(function (u) { return u.id !== e.id && (G.Sim.canCarry ? G.Sim.canCarry(e, u) : isInfantry(u)); }) && V.sel.indexOf(e.id) < 0) {
      command(e.x, e.y, false, e); return;                      // v0.7: Infanterie gewählt + eigenen Schützenpanzer antippen = einsteigen
    }
    if (e && e.kind === 'unit' && e.owner === V.pid) {
      var t = now();
      if (lastTap.id === e.id && t - lastTap.t < 380) {
        lastTap.t = 0;
        if (e.type === 'mcv') { deployNow(e); return; }         // Doppeltipp auf den Bauhof = aufbauen (falls möglich)
        selectAllOfTypeOnScreen(e.type); return;
      }
      lastTap.id = e.id; lastTap.t = t;
      if (V.addMode || (mouseBtn && keys.Shift)) {
        var ids = V.sel.slice(), k = ids.indexOf(e.id);
        if (k >= 0) ids.splice(k, 1); else if (!(ids.length === 1 && G.Sim.get(ids[0]) && G.Sim.get(ids[0]).kind === 'building')) ids.push(e.id); else ids = [e.id];
        setSel(ids);
      } else setSel([e.id]);
      return;
    }
    if (e && e.kind === 'building') {
      var mine = e.owner === V.pid, neutral = isNeutralType(e) || (mine && isGarrison(e));   // eigener Bunker verhält sich wie ein Haus
      // Touch mit Auswahl: Befehl (besetzen/erobern/angreifen/abladen)
      if (!mouseBtn && units.length) {
        if (mine && G.Sim.isRepairSite(V.pid, e) && units.some(function (u) { return G.Sim.canRepairUnit(u); })) { command(w.x, w.y, false, e); return; }   // v1.2: zur Reparatur
        if (mine && e.type === 'refinery' && units.some(function (u) { return G.Sim.statsOf(u).harvester; })) { command(w.x, w.y, false, e); return; }
        if (neutral && hasInf && enterKind(e) && enterKind(e) !== 'full') { command(w.x, w.y, false, e); return; }
        if (neutral && enterKind(e) === 'full' && hasInf) { toast('Gebäude ist voll', true); return; }
        if (mine && engKind(e)) { command(w.x, w.y, false, e); return; }   // Ingenieur: eigenes beschädigtes Gebäude reparieren
        if (!mine) { command(w.x, w.y, false, e); return; }     // Gegner / vom Gegner besetzt → angreifen (Ingenieur: übernehmen)
      }
      // sonst: wählen (eigene Gebäude, neutrale/gegnerische Sondergebäude zur Info)
      if (mine || neutral) { setSel([e.id]); return; }
      return;
    }
    if (e && e.owner !== V.pid) {            // gegnerische Einheit
      if (!mouseBtn && units.length) command(w.x, w.y, false, e);
      return;
    }
    // Boden
    if (mouseBtn) { deselect(); return; }
    if (!command(w.x, w.y)) deselect();
  }

  // ------------------------------------------------------------------ Canvas-Pointer
  function onDown(ev) {
    if (!canAct()) return;
    ev.preventDefault();
    try { cv.setPointerCapture(ev.pointerId); } catch (e) { /* egal */ }
    var p = localXY(ev, cv);
    ptrs.set(ev.pointerId, { x: p.x, y: p.y });
    isMouse = ev.pointerType === 'mouse';
    inertia = null;
    if (isMouse) {
      if (ev.button === 2) {
        var w = V.toWorld(p.x, p.y);
        if (V.placing && V.placing.wall && V.placing.tiles.length) { V.placing.tiles = []; V.placing.ok = []; V.placing.cost = 0; V.placing.valid = 0; V.placing.set = false; }
        else if (V.placing) cancelPlacement();
        else if (V.arty) cancelArty();
        else if (V.amArmed) V.amArmed = false;
        else if (V.repairMode) V.repairMode = false;   // v0.9.2 Reparatur
        else command(w.x, w.y, false, pick(p.x, p.y, 6, w));
        ptrs.delete(ev.pointerId);
        return;
      }
      if (ev.button === 1) { mode = 'mpan'; downX = p.x; downY = p.y; return; }
      if (isWallMode()) { startWall(p.x, p.y); return; }
      mode = 'maybe'; downX = p.x; downY = p.y; downT = now(); holdArmed = false;
      return;
    }
    if (ptrs.size === 1) {
      if (isWallMode()) { lastP.x = p.x; lastP.y = p.y; startWall(p.x, p.y); return; }   // Mauer-Modus: ein Finger zeichnet
      mode = 'maybe'; downX = p.x; downY = p.y; downT = now(); holdArmed = false; V.hold = null;
      vel.x = vel.y = 0; vel.t = now(); lastP.x = p.x; lastP.y = p.y;
      var w0 = V.toWorld(p.x, p.y);
      if (V.placing) { var g = nearGhost(w0); if (g) { gd = g; mode = 'gdrag'; } }
      else if (V.arty && V.arty.set && Math.hypot(w0.x - V.arty.x, w0.y - V.arty.y) <= ((V.arty.radius || ARTY_RADIUS) + 1.2) * TILE) {
        gd = { dx: V.arty.x - w0.x, dy: V.arty.y - w0.y, kind: 'arty' }; mode = 'gdrag';
      }
    } else if (ptrs.size === 2) {
      var a = Array.from(ptrs.values());
      var cx = (a[0].x + a[1].x) / 2, cy = (a[0].y + a[1].y) / 2;
      pinch = { d0: Math.max(10, Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y)), z0: V.cam.zoom, w: V.toWorld(cx, cy) };
      if (wd) { restoreWall(); wd = null; }                        // zwei Finger = Karte, die angefangene Linie wird verworfen
      mode = 'pinch'; V.box = null; V.hold = null; holdArmed = false;
    }
  }
  function onMove(ev) {
    var p = localXY(ev, cv);
    if (ev.pointerType === 'mouse') {
      mouse.x = p.x; mouse.y = p.y; mouse.inside = true; V.hover = V.toWorld(p.x, p.y);
      if (ev.buttons === 0) {
        if (V.placing) setGhost(V.hover.x, V.hover.y);
        else if (V.arty) artyAim(V.hover.x, V.hover.y);
      }
    }
    var q = ptrs.get(ev.pointerId);
    if (!q) return;
    ev.preventDefault();
    var dx = p.x - q.x, dy = p.y - q.y;
    q.x = p.x; q.y = p.y; lastP.x = p.x; lastP.y = p.y;
    if (mode === 'mpan') {
      V.panBy(dx, dy);
    } else if (mode === 'wdrag') {
      if (wd && isWallMode()) wallDragTo(p.x, p.y);
    } else if (mode === 'pan') {
      V.panBy(dx, dy);
      var t = now(), dtm = Math.max(1, t - vel.t);
      vel.x = vel.x * 0.55 + (dx / dtm * 1000) * 0.45; vel.y = vel.y * 0.55 + (dy / dtm * 1000) * 0.45; vel.t = t;
    } else if (mode === 'gdrag') {
      var w = V.toWorld(p.x, p.y);
      if (gd.kind === 'place' && V.placing) setGhost(w.x + gd.dx, w.y + gd.dy);
      else if (gd.kind === 'arty' && V.arty) artyAim(w.x + gd.dx, w.y + gd.dy);
    } else if (mode === 'maybe') {
      var dist = Math.hypot(p.x - downX, p.y - downY);
      if (dist > (isMouse ? 6 : 12)) {
        if (holdArmed) { mode = 'box'; V.hold = null; V.box = { x0: downX, y0: downY, x1: p.x, y1: p.y }; vib(10); }
        else if (V.placing && !isMouse) { mode = 'pan'; vel.t = now(); V.panBy(p.x - downX, p.y - downY); }
        else if (isMouse || V.boxMode) { mode = 'box'; V.box = { x0: downX, y0: downY, x1: p.x, y1: p.y }; }
        else { mode = 'pan'; vel.t = now(); V.panBy(p.x - downX, p.y - downY); }
      }
    } else if (mode === 'box') {
      V.box.x1 = p.x; V.box.y1 = p.y;
    } else if (mode === 'pinch' && ptrs.size >= 2) {
      var a = Array.from(ptrs.values());
      var cx = (a[0].x + a[1].x) / 2, cy = (a[0].y + a[1].y) / 2;
      var d = Math.max(10, Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y));
      V.cam.zoom = Math.max(0.5, Math.min(2, pinch.z0 * d / pinch.d0));
      V.anchor(pinch.w, cx, cy); // Weltpunkt unter dem Fingermittelpunkt bleibt dort (Zoom + Schieben in einem)
    }
  }
  function onUp(ev) {
    var q = ptrs.get(ev.pointerId);
    if (!q) return;
    ptrs.delete(ev.pointerId);
    var p = localXY(ev, cv);
    if (mode === 'maybe') {
      if (holdArmed) {
        V.hold = null;
        var w = V.toWorld(downX, downY);
        if (selUnits().length) { command(w.x, w.y, true); toast('Angriff-Bewegen'); }
      } else tap(p.x, p.y, ev.pointerType === 'mouse');
    } else if (mode === 'box' && V.box) {
      // v0.7: Rahmen im Bildschirmraum (bei gedrehter Kamera ist er auf dem Boden eine Raute)
      var ids = unitsInScreenRect(V.box.x0, V.box.y0, V.box.x1, V.box.y1);
      // Kampfeinheiten bevorzugen, wenn gemischt mit Sammlern
      var fighters = ids.filter(function (id) { return !!G.Sim.statsOf(G.Sim.get(id)).weapon; });
      if (fighters.length) ids = fighters;
      if ((V.addMode || keys.Shift) && ids.length) ids = V.sel.concat(ids.filter(function (id) { return V.sel.indexOf(id) < 0; }));
      setSel(ids);
      V.box = null; V.boxMode = false;
    } else if (mode === 'pan' && ptrs.size === 0 && now() - vel.t < 90 && Math.hypot(vel.x, vel.y) > 180) {
      var vs = Math.hypot(vel.x, vel.y), cap = Math.min(1, 2500 / vs);
      inertia = { x: vel.x * cap, y: vel.y * cap };
    }
    if (ptrs.size === 0) { mode = 'none'; pinch = null; gd = null; wd = null; }
    else if (mode === 'pinch') { mode = 'pan'; vel.x = vel.y = 0; vel.t = now(); } // Rest-Finger schiebt weiter
  }
  function onCancel(ev) { ptrs.delete(ev.pointerId); if (!ptrs.size) { if (wd) restoreWall(); mode = 'none'; V.box = null; V.hold = null; gd = null; pinch = null; wd = null; } }
  function onWheel(ev) {
    if (!canAct()) return;
    ev.preventDefault();
    var p = localXY(ev, cv), w = V.toWorld(p.x, p.y);
    var dy = ev.deltaMode === 1 ? ev.deltaY * 33 : ev.deltaY;
    var z = V.cam.zoom * Math.pow(1.0015, -dy);
    V.cam.zoom = Math.max(0.5, Math.min(2, z));
    V.anchor(w, p.x, p.y); // Zoom zum Mauszeiger
  }

  // ------------------------------------------------------------------ Minimap
  function miniDownH(ev) {
    if (!canAct()) return;
    ev.preventDefault(); ev.stopPropagation();
    try { mini.setPointerCapture(ev.pointerId); } catch (e) { /* egal */ }
    var p = localXY(ev, mini), w = G.Render.miniToWorld(p.x, p.y);
    if (ev.pointerType === 'mouse' && ev.button === 2) {
      if (selUnits().length) command(w.x, w.y);
      return;
    }
    inertia = null;
    miniDown = { id: ev.pointerId, t: now(), x: p.x, y: p.y, fired: false, touch: ev.pointerType !== 'mouse' };
    V.centerOn(w.x, w.y);
  }
  function miniMoveH(ev) {
    if (!miniDown || miniDown.id !== ev.pointerId) return;
    ev.preventDefault();
    var p = localXY(ev, mini), w = G.Render.miniToWorld(p.x, p.y);
    if (Math.hypot(p.x - miniDown.x, p.y - miniDown.y) > 8) miniDown.moved = true;
    V.centerOn(w.x, w.y);
  }
  function miniUpH(ev) { if (miniDown && miniDown.id === ev.pointerId) miniDown = null; }

  // ------------------------------------------------------------------ Tastatur
  function onKey(ev) {
    var k = ev.key;
    if (ev.type === 'keyup') { keys[k] = false; keys[k.toLowerCase()] = false; if (k === 'Shift') keys.Shift = false; return; }
    keys[k] = true; keys[k.toLowerCase()] = true;
    if (k === 'Shift') keys.Shift = true;
    var lk = k.toLowerCase();
    if (lk === 'h' || k === 'F1' || k === '?') { ev.preventDefault(); if (G.UI.toggleHelp) G.UI.toggleHelp(); return; }
    if (!V.running) return;
    if (k === ' ') { ev.preventDefault(); G.Main.togglePause(); return; }
    if (k === 'Escape') {
      if (V.repairMode) V.repairMode = false; else if (V.placing) cancelPlacement(); else if (V.arty) cancelArty(); else if (V.amArmed) V.amArmed = false; else if (V.boxMode) V.boxMode = false; else deselect();
      return;
    }
    if (k >= '1' && k <= '3') {
      var n = +k - 1;
      if (ev.ctrlKey || ev.metaKey) { ev.preventDefault(); saveGroup(n); } else recallGroup(n);
      return;
    }
    if (lk === 'a' && selUnits().length && !ev.ctrlKey) { toggleAttackMove(); keys.a = false; return; }
    if (lk === 's' && selUnits().length && !ev.ctrlKey) { stopSel(); keys.s = false; return; }
    if (k === 'Enter' && V.placing) { ev.preventDefault(); confirmPlacement(); return; }
    if (lk === 'd' && !ev.ctrlKey && (selMcv() || (V.placing && V.placing.deploy))) {
      keys.d = false;
      if (V.placing && V.placing.deploy) cancelPlacement(); else beginDeploy();
      return;
    }
    if (lk === 'e' && !ev.ctrlKey) { exitSel(); return; }
    if (lk === 'f' && !ev.ctrlKey) { if (V.arty) cancelArty(); else beginArty(); return; }
    if (lk === 'x' && !ev.ctrlKey) { toggleSuper(); return; }
    if (lk === 'r' && !ev.ctrlKey && !ev.metaKey && !ev.altKey) { toggleRepairMode(); return; }   // v0.9.2 Reparatur
  }

  // ------------------------------------------------------------------ Hover-Hinweis (Maus)
  function updateHover() {
    var kind = '', text = '';
    if (V.repairMode) {                                               // v0.9.2 Reparatur
      var rw = V.toWorld(mouse.x, mouse.y), rb = repairTarget(mouse.x, mouse.y, rw, 2);
      if (rb) { kind = rb.hp < rb.maxHp ? 'repair' : 'no'; text = rb.hp < rb.maxHp ? (rb.repairing ? 'Reparatur stoppen' : 'Reparieren') : 'Unbeschädigt'; }
      else { kind = 'repair'; text = 'Gebäude antippen zum Reparieren'; }
    } else if (V.arty) { kind = 'arty'; text = ''; }
    else if (!V.placing && !V.amArmed) {
      var units = selUnits();
      if (units.length) {
        var w = V.toWorld(mouse.x, mouse.y), e = pick(mouse.x, mouse.y, 6, w);
        if (e) {
          var ek = enterKind(e), hasInf = units.some(isInfantry);
          if (hasInf && isTransport(e) && e.owner === V.pid && V.sel.indexOf(e.id) < 0) { var fr = passengers(e) >= tcap(e); kind = fr ? 'no' : 'enter'; text = (fr ? 'Voll (' : 'Einsteigen (') + passengers(e) + '/' + tcap(e) + ')'; }
          else if (hasInf && ek === 'enter') { kind = 'enter'; text = 'Besetzen (' + (e.gar || []).length + '/' + capOf(e) + ')'; }
          else if (hasInf && ek === 'capture') { kind = 'capture'; text = 'Erobern'; }
          else if (hasInf && ek === 'full') { kind = 'no'; text = 'Voll (' + capOf(e) + '/' + capOf(e) + ')'; }
          else if (e.kind === 'building' && G.Sim.isRepairSite(V.pid, e) && units.some(function (u) { return G.Sim.canRepairUnit(u); })) { kind = 'repair'; text = 'Zur Reparatur'; }   // v1.2
          else if (engKind(e) === 'takeover') { kind = 'capture'; text = 'Übernehmen'; }
          else if (engKind(e) === 'repair') { kind = 'repair'; text = 'Reparieren'; }
          else if (e.owner >= 0 && e.owner !== V.pid) { kind = 'attack'; text = isNeutralType(e) ? 'Besetztes Gebäude angreifen' : 'Angreifen'; }
        }
      }
    }
    cv.dataset.cur = kind;
    if (G.UI.setHint) G.UI.setHint(text, mouse.x, mouse.y);
  }

  // ------------------------------------------------------------------ pro Frame
  function update(dt) {
    if (!canAct()) return;
    var sp = 700 * dt * V.K, mx = 0, my = 0;   // v0.7: Bildschirm-px (gleiche Geschwindigkeit in beide Richtungen, unabhängig vom Zoom in Welt-px)
    var hasSel = selUnits().length > 0;
    if (keys.ArrowLeft || (keys.a && !hasSel)) mx -= sp;
    if (keys.ArrowRight || keys.d) mx += sp;
    if (keys.ArrowUp || keys.w) my -= sp;
    if (keys.ArrowDown || (keys.s && !hasSel)) my += sp;
    // Bildrand-Scrollen (nur Maus, nicht während Ziehen)
    if (mouse.inside && mode === 'none' && !(V.placing && V.placing.wall) && document.hasFocus && document.hasFocus()) {
      var E = 12;
      if (mouse.x >= 0 && mouse.x < E) mx -= sp; else if (mouse.x > V.vw - E && mouse.x <= V.vw) mx += sp;
      if (mouse.y >= 0 && mouse.y < E) my -= sp; else if (mouse.y > V.vh - E && mouse.y <= V.vh) my += sp;
    }
    if (mx || my) V.panBy(-mx, -my); // v0.7: Bildschirmrichtung (bei diagonaler Kamera diagonal über die Karte)
    // Trägheit nach dem Wischen
    if (inertia) {
      V.panBy(inertia.x * dt, inertia.y * dt);
      var f = Math.exp(-4 * dt); inertia.x *= f; inertia.y *= f;
      if (Math.hypot(inertia.x, inertia.y) < 20) inertia = null;
    }
    if (mode === 'wdrag' && wd && isWallMode()) {                // Mauerlinie am Bildrand ziehen → Karte scrollt mit
      var wx = lastP.x < 40 ? 1 : (lastP.x > V.vw - 40 ? -1 : 0), wy = lastP.y < 40 ? 1 : (lastP.y > V.vh - 40 ? -1 : 0);
      if (wx || wy) { V.panBy(wx * 260 * dt, wy * 260 * dt); wallDragTo(lastP.x, lastP.y); }
    }
    if (V.placing && V.placing.wall && V.placing.tiles.length && mode !== 'wdrag' && now() - lastWallEval > 400) wallEval(V.placing);
    if (V.placing && V.placing.deploy && now() - lastDeployEval > 100) refreshDeploy();
    // Ghost/Zielkreis am Bildrand ziehen → Karte scrollt mit
    if (mode === 'gdrag') {
      var ex = lastP.x < 56 ? 1 : (lastP.x > V.vw - 56 ? -1 : 0), ey = lastP.y < 56 ? 1 : (lastP.y > V.vh - 90 ? -1 : 0);
      if (ex || ey) {
        V.panBy(ex * 260 * dt, ey * 260 * dt);
        var w2 = V.toWorld(lastP.x, lastP.y);
        if (gd.kind === 'place' && V.placing) setGhost(w2.x + gd.dx, w2.y + gd.dy); else if (gd.kind === 'arty' && V.arty) artyAim(w2.x + gd.dx, w2.y + gd.dy);
      }
    }
    // Halten (Touch): nach 0,4 s „scharf“ → Ziehen = Auswahlrahmen, Loslassen = Angriff-Bewegen
    if (mode === 'maybe' && !isMouse && !holdArmed && now() - downT > 400 && !V.placing && !V.arty) {
      holdArmed = true; V.hold = { x: downX, y: downY, t0: now() }; vib(15);
    }
    // Langdruck Minimap (Touch) mit Auswahl = bewegen
    if (miniDown && miniDown.touch && !miniDown.fired && !miniDown.moved && now() - miniDown.t > 550) {
      miniDown.fired = true;
      var ww = G.Render.miniToWorld(miniDown.x, miniDown.y);
      if (selUnits().length) { command(ww.x, ww.y); toast('Bewegen zur Position'); }
    }
    if (mouse.inside && mode === 'none' && now() - lastHover > 70) { lastHover = now(); updateHover(); }
    else if (!mouse.inside && cv.dataset.cur) { cv.dataset.cur = ''; if (G.UI.setHint) G.UI.setHint('', 0, 0); }
  }

  function init() {
    V = G.view;
    cv = document.getElementById('cv'); mini = document.getElementById('mini');
    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('pointercancel', onCancel);
    cv.addEventListener('pointerleave', function (ev) { if (ev.pointerType === 'mouse') { mouse.inside = false; V.hover = null; } });
    cv.addEventListener('wheel', onWheel, { passive: false });
    cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    mini.addEventListener('pointerdown', miniDownH);
    mini.addEventListener('pointermove', miniMoveH);
    mini.addEventListener('pointerup', miniUpH);
    mini.addEventListener('pointercancel', miniUpH);
    mini.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('blur', function () { keys = {}; mouse.inside = false; });
  }

  G.Input = {
    init: init, update: update, selectArmy: selectArmy, selectIdle: selectIdle, selectType: selectType, saveGroup: saveGroup, recallGroup: recallGroup,
    stopSel: stopSel, toggleAttackMove: toggleAttackMove, toggleBoxMode: toggleBoxMode, toggleAddMode: toggleAddMode,
    beginPlacement: beginPlacement, confirmPlacement: confirmPlacement, cancelPlacement: cancelPlacement, deselect: deselect,
    beginSuper: beginSuper, toggleSuper: toggleSuper, swKind: swKind, swInfo: swInfo, swFmt: swFmt, ownSupers: ownSupers, SWD: SWD, SW_CHARGE: SW_CHARGE,
    engKind: engKind, beginArty: beginArty, artyAim: artyAim, artyFire: artyFire, cancelArty: cancelArty, exitSel: exitSel,
    command: command, tap: tap, isNeutralType: isNeutralType, enterKind: enterKind, capOf: capOf, bkind2: bkind2, bkindSpecial: bkindSpecial,
    ARTY_RANGE: ARTY_RANGE, ARTY_RADIUS: ARTY_RADIUS,
    beginWall: beginWall, confirmWall: confirmWall, isWallMode: isWallMode, wallLine: wallLine,
    beginDeploy: beginDeploy, deployNow: deployNow, selMcv: selMcv, isGarrison: isGarrison, say: say,
    toggleRepairMode: toggleRepairMode, repairAll: repairAll,   // v0.9.2 Reparatur
    repairSel: repairSel,   // v1.2
    isTransport: isTransport, passengers: passengers, transportCap: tcap, unloadSel: unloadSel, unitsInScreenRect: unitsInScreenRect
  };
})();
