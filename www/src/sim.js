/* FRONTLINIE – sim.js
 * G.Sim: Weltzustand + fester Tick (20 Hz). Deterministisch (eigener RNG), keine DOM-Zugriffe.
 *
 * ZUSTAND (G.Sim.S) – reine Daten, JSON-serialisierbar (Typed Arrays werden in save.js gewandelt):
 *   S.tick            Tick-Zähler (20 pro Spielsekunde)
 *   S.map             { id, name, w, h, terrain:Uint8Array, ore:Uint16Array, oreMax:Uint16Array, starts }
 *   S.occ             Int32Array(w*h): ID des Gebäudes auf der Kachel oder 0
 *   S.ents            Array aller Entitäten (Einheiten und Gebäude), stabile Reihenfolge
 *   S.proj            Projektile: { x0,y0, x,y, tx,ty, t, dur, w:'rocket'|'cannon', owner }
 *   S.events          Ereignisse der letzten ~2 s: { seq, tick, t, x, y, ... } (s. emit())
 *   S.evSeq           laufende Ereignisnummer (Renderer merkt sich die zuletzt gesehene)
 *   S.players[i]      { id, faction, color, ai:null|'easy'|'medium'|'hard', credits, pwrProd, pwrUse,
 *                       defeated, q:{building:[], infantry:[], vehicle:[]}, vis:Uint8Array, exp:Uint8Array,
 *                       mem:{id:{type,owner,tx,ty,w,h,hp,maxHp}}, st:{...Statistik}, alert:{tick,x,y}, oreMul }
 *                     Warteschlangen-Element: { type, prog:0..1, spent, ready(bool, nur Gebäude) }
 *   S.settings        { fogOff, speed, diff, mapId, seed }
 *   S.over, S.winner  Spielende (winner = Spielerindex oder -1)
 *   S.aiState         Zustand der KI-Controller (reine Daten, von ai.js verwaltet)
 *
 * EINHEIT { id, kind:'unit', type, owner, x, y, px, py (Position vorheriger Tick, für Interpolation),
 *           hp, maxHp, r (Radius px), dir (Fahrtrichtung rad), tdir (Turm/Zielrichtung rad), mc (0 foot/1 wheel),
 *           ord: 'idle'|'move'|'attack'|'amove'|'harvest', tgt (Ziel-ID oder 0), moving (bool),
 *           fireT (Tick des letzten Schusses), cargo (Sammler), hs (Sammlerzustand), dead }
 * GEBÄUDE { id, kind:'building', type, owner, tx, ty, w, h, x, y (Mitte px), hp, maxHp, placedT,
 *           rx, ry (Sammelpunkt px, -1 = keiner), repairing, tdir, tgt, fireT, dead }
 *
 * ERFAHRUNG (Rangstufen, Abschnitt „Erfahrung“ vor damage()): EINHEIT zusätzlich xp (Punkte), rk (Rang 0..3), rankT (Tick des letzten Aufstiegs);
 *   Ereignis rankup {id, owner, rank}. Tabelle D.EXP (data.js); wirksame Werte zentral über G.Sim.mods(e) (dmg/hp/rof/regen).
 *
 * v0.3 (SPEC_v03, additiv):
 *   GEBÄUDE zusätzlich: neutral (bool; Kartengebäude aus map.structures, Startbesitzer −1),
 *           gar (Insassen-IDs), cap, ruin, capT (0..1), capBy (pid|-1), charge (0..1, nur artillery)
 *   EINHEIT zusätzlich: inside (Gebäude-ID oder 0), enterId (Ziel von ord 'enter'), ftgt (Ziel des
 *           Turms beim Schießen in der Fahrt, nur Fahrzeuge mit Turm), fleeT (Sammler: Tick des letzten Treffers)
 *           ord zusätzlich 'enter'; Sammler hs zusätzlich 'hide' (wartet nach Flucht an der Raffinerie)
 *   SPIELER zusätzlich: radar (bool), st.captures, st.oil
 *   S.strikes  laufende Artilleriegranaten { t (Einschlagtick), x, y, owner, src }
 *
 * v0.4 (SPEC_v04, additiv):
 *   P.q.building bis zu 5 Einträge; es läuft der erste mit ready === false, fertige bleiben (ready:true) stehen.
 *   GEBÄUDE zusätzlich: charge (0..1) auch bei Superwaffen (orbital/silo), swRdy (bool, swReady schon gemeldet)
 *   EINHEIT zusätzlich: setup (0..1, Haubitze: Aufbau-Fortschritt im Stand), barrel (0|1, zuletzt benutztes Rohr)
 *   S.sw       laufende Superwaffen-Schläge { kind:'orbital'|'missile', owner, src (Gebäude-ID), x, y, t0 (Abschusstick),
 *              t (Einschlagtick), sx, sy (Startposition) } – für Ziel-Warnmarker (beide Seiten) und Flugbahn
 *   Projektil zusätzlich: arc (bool, ballistisch, nicht zielsuchend), sp (Splash-Radius px), raw (Rohschaden), wt (Waffentyp)
 *   Ereignisse: swBuilt {id, owner, kind}, swReady {id, owner}, swLaunch {id, owner, kind, x, y, t2[, sx, sy]},
 *               swHit {kind, x, y, r, owner, id}, capture {..., eng:true}, repairFull {id, owner}, shot.barrel (Kolosspanzer)
 *
 * v0.5 (SPEC_v05, additiv):
 *   Platzierung: Nähe-Regel zählt eigene Basisgebäude (ohne Mauern) + eroberte Spezialgebäude (nearBase()).
 *   wall: 1×1-Gebäude (isWall), gesetzt über placeWall (sofort, 50 je Segment), zählt nicht für Sieg/Nähe-Regel,
 *         wird nie automatisch beschossen. Ereignis wall {ids, owner, n, cost}.
 *   pbunker: Basisgebäude mit gar/cap wie Häuser (garrisonOwn: nur eigene Infanterie; Besitzer bleibt beim Leeren);
 *         Zerstörung, Verkauf und Ingenieur-Übernahme werfen die Insassen aus (Zerstörung: mit 50 % HP).
 *   laser/tesla: Strahlwaffen (Treffer sofort), kein Feuer bei Energiemangel; shot.beam = true,
 *         Blitz: shot.chain = [{x, y, id}] (bis zu 2 weitere Ziele ≤ 2 Kacheln vom Ziel, je 50 %).
 *   mcv: deploy(pid, unitId) → HQ (3×3) auf (tx−1, ty−1), Ereignis deploy {id (HQ), unit, owner}.
 *   EINHEIT zusätzlich: breach (ID der gegnerischen Mauer, die den Pfad versperrt und gerade beschossen wird, sonst 0)
 *   SPIELER zusätzlich: st.walls (gesetzte Segmente), st.deploys
 *   Pfade: ist ein Ziel nur durch gegnerische Mauern erreichbar, führt der Pfad mit hohen Kosten hindurch (path.js),
 *         bewaffnete Einheiten beschießen dann das versperrende Segment (e.breach).
 *
 * v0.7 (SPEC_v07, additiv):
 *   Neue Einheiten sniper, apc, lasertank, flamer, mlrs, shocktank, medic (Werte in data.js).
 *   EINHEIT zusätzlich: gar (Insassen-IDs) + cap nur beim Schützenpanzer (apc); Insassen: inside = APC-ID (wie Garnison)
 *           loadId (Ziel-APC von ord 'load'), salvoN/salvoI/salvoT0/salvoX/salvoY/salvoTid (laufende Raketensalve des mlrs),
 *           htgt (Heilziel des Sanitäters), healT (Tick des letzten heal-Ereignisses), follow (Sanitäter folgt untätig dieser Einheit)
 *           ord zusätzlich 'load' (Infanterie läuft zum APC und steigt ein)
 *   S.settings.peace  Friedenszeit in Sekunden (0 = keine); S.peaceDone (Ereignis peaceOver schon gesendet)
 *   Ereignisse: shot.w 'sniper'|'flame' (Soforttreffer; flame mit area = Radius px), mlrs: 6 × shot {w:'rocket', arc:true, salvo:0..5}
 *               (gestaffelt 0.12 s), heal {id (Sanitäter), tid, owner, sx, sy} höchstens 1×/s je Sanitäter,
 *               load {id (APC), unit, owner}, unload {id (APC), n, owner[, destroyed:true]}, peaceOver {}
 *   G.Sim.peaceLeft() → Sekunden Friedenszeit übrig (0 wenn vorbei/keine).
 *
 * v0.8 (additiv):
 *   P.q.defense    eigene Bau-Warteschlange für Gebäude mit defense:true (läuft parallel zu P.q.building; gleiche ready/place-Mechanik;
 *                  Mauern bleiben noQueue). Altstände ohne q.defense werden in migrate() umgezogen.
 *   P.cheat        (bool, nur Mensch) „unbegrenzt Geld“: Credits werden jeden Tick auf mindestens CHEAT_CREDITS aufgefüllt
 *   P.cheatUsed    (bool, sticky) Cheat wurde in dieser Partie je benutzt → Hinweis in der Endstatistik
 *   G.cmd.setCheat(pid, on) → G.Sim._setCheat; Ereignis cheat {owner, on}
 * v0.8 (SPEC_v08, additiv) – Luftwaffe & Marine:
 *   Bewegungsklassen e.mc: 0 foot, 1 wheel, 2 air (fliegt geradlinig, keine Pfadsuche, kollidiert nur mit Luftfahrzeugen),
 *           3 naval (A* über Wasser + Brücken). Gebäude airfield (Flugfeld, Landeplätze), shipyard (Werft, Uferregel), flak.
 *   EINHEIT zusätzlich (nur Luftfahrzeuge): alt (0 = am Boden … 1 = Flughöhe), land (bool, will landen), home (Flugfeld-ID), pad (Landeplatz 0..3),
 *           Bomber: ammo (Bomben an Bord), bx/by (Zielpunkt), bdrop (abgeworfene Bomben dieses Anflugs), blx/bly (letzter Abwurf), rearmT (Ticks)
 *           Transporter (apc, transheli, lander): gar/cap (cap = Plätze; Infanterie 1, Fahrzeug 2, groß 3), dropX/dropY (Ziel von ord 'drop')
 *           ord zusätzlich 'bomb' (Bomber-Anflug), 'rtb' (zurück zum Flugfeld), 'rearm' (lädt nach), 'drop' (Transporter fliegt/fährt hin und lädt aus)
 *   P.q.air, P.q.naval  Warteschlangen wie infantry/vehicle (Flugfeld bzw. Werft)
 *   Projektil zusätzlich: bomb (bool), air (Ziel war in der Luft)
 *   Ereignisse: takeoff {id, owner, type}, land {id, owner, type}, bomb {id, owner, tx, ty, i, n, t2}, rearm {id, owner},
 *               beach {id, owner, n} (Landungsboot setzt am Ufer ab), shot.air (Ziel in der Luft), shot.w 'flak'
 *   Regeln: nur Waffen mit antiAir treffen Ziele in der Luft (alt > 0.5); airOnly-Waffen (Flak) nur solche; Flächenschaden trifft
 *           keine fliegenden Einheiten. Luftfahrzeuge werden nicht von Bodenwaffen erfasst, blockieren nichts, können nichts besetzen.
 *
 * v0.8 Zusammenführung (SPEC_v08 §12.1) – Seitengleichheit: flipOf(pid) (Startplatz unten rechts) spiegelt Gleichstände: Raffinerie-Andockseite
 *   (Süd/Nord, die dem Sammler zugewandte), Sammler-Startkachel, findOre, Garnison-Ausstieg, findTarget-Reihenfolge; Produktionsausgang auf der Seite
 *   des Sammelpunkts (Nord, wenn b.ry über der Oberkante); Werft-Ausfahrt zur Kartenmitte.
 *
 * Laufzeit-Caches (nicht im Zustand): byId-Map, Gebäudelisten, räumliches Gitter.
 */
var G = (typeof G !== 'undefined') ? G : {};
(function () {
  'use strict';
  var D = G.DATA, TILE = D.TILE, HZ = D.TICK_HZ, DT = 1 / HZ;
  var S = null;
  var byId = new Map();
  var CELL = 64, gw = 0, gh = 0, gHead = null, gNext = null, gEnts = [];
  var stats = [];       // stats[pid][type] → Einheitenwerte
  var statsF = {};      // v1.0: statsF[fraktion][type] → Einheitenwerte (für Entitäten über e.fac)
  var drainEnd = -1;    // v1.0: letzter Tick, an dem ein Kraftwerk noch vom Diskus entzogen ist (Laufzeit-Cache, aus drainT neu berechnet)
  var circles = {};     // Sichtkreis-Offsets je Radius
  var sepX = new Float32Array(1024), sepY = new Float32Array(1024);
  var CHEAT_CREDITS = 999999;
  var oreTiles = [];    // Kachelindizes mit oreMax > 0

  // ------------------------------------------------------------------ RNG
  function rand() { // mulberry32
    var t = (S.rng = (S.rng + 0x6D2B79F5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // ------------------------------------------------------------------ Erzeugen
  /**
   * Neue Partie. opts: { mapId, seed, fogOff, speed, players:[{faction, ai:null|'easy'|'medium'|'hard'}] }
   */
  function create(opts) {
    var def = G.MAPS.byId(opts.mapId || 'flussgabel');
    var map = G.MAPS.parse(def);
    S = {
      version: D.SAVE_VERSION, tick: 0, rng: (opts.seed >>> 0) || 1, nextId: 1, evSeq: 0,
      map: map, occ: new Int32Array(map.w * map.h), ents: [], proj: [], strikes: [], sw: [], events: [], pq: [], charges: [],
      players: [], over: false, winner: -1, aiState: {},
      settings: { fogOff: !!opts.fogOff, speed: opts.speed || 'normal', mapId: def.id, seed: opts.seed >>> 0,
                  peace: Math.max(0, Math.round(+opts.peace || 0)) },   // v0.7: opts.peace in SEKUNDEN (G.Main.start rechnet Minuten × 60)
      peaceDone: false
    };
    for (var i = 0; i < opts.players.length; i++) {
      var po = opts.players[i], fac = D.FACTIONS[po.faction];
      S.players.push({
        id: i, faction: po.faction, color: (S.players.some(function (q) { return q.faction === po.faction; }) && fac.alt) ? fac.alt : fac.color, ai: po.ai || null,   // v1.0: Spiegelpartie → Ersatzfarbe
        credits: D.START_CREDITS, pwrProd: 0, pwrUse: 0, defeated: false,
        q: { building: [], defense: [], infantry: [], vehicle: [] },
        vis: new Uint8Array(map.w * map.h), exp: new Uint8Array(map.w * map.h), mem: {},
        st: { unitsBuilt: 0, unitsLost: 0, buildingsBuilt: 0, buildingsLost: 0, kills: 0, ore: 0, spent: 0, captures: 0, oil: 0, walls: 0, deploys: 0 },
        alert: { tick: -9999, x: 0, y: 0, harv: false }, radar: false,
        oreMul: po.ai === 'hard' ? 1.25 : 1
      });
    }
    rebuild();
    for (i = 0; i < S.players.length; i++) {
      var st = map.starts[i];
      addBuilding(i, 'hq', st.tx, st.ty, true);
      // Startausstattung: zwei Schützen
      var exit = Math.floor((st.ty + 3.5) * TILE);
      spawnUnit(i, 'rifle', (st.tx + 0.7) * TILE, exit + 8);
      spawnUnit(i, 'rifle', (st.tx + 2.3) * TILE, exit + 8);
    }
    // v0.3: neutrale Kartengebäude (map.structures) mit Besitzer −1 – nach den HQs, Überlappungen werden übersprungen
    var structs = def.structures || [];
    for (i = 0; i < structs.length; i++) addStructure(structs[i].type, structs[i].tx, structs[i].ty);
    updateFog(true);
    G.Sim.S = S;
    return S;
  }

  /** Baut Laufzeit-Caches aus S neu auf (nach create und nach Laden). */
  function rebuild() {
    G.Sim.S = S;
    byId.clear();
    for (var i = 0; i < S.ents.length; i++) byId.set(S.ents[i].id, S.ents[i]);
    gw = Math.ceil(S.map.w * TILE / CELL); gh = Math.ceil(S.map.h * TILE / CELL);
    gHead = new Int32Array(gw * gh);
    gNext = new Int32Array(4096);
    stats = [];
    for (i = 0; i < S.players.length; i++) {
      var t = {};
      for (var k in D.UNITS) t[k] = D.unitStats(S.players[i].faction, k);
      stats.push(t);
    }
    statsF = {};
    for (var fk in D.FACTIONS) { var tf = statsF[fk] = {}; for (var k2 in D.UNITS) tf[k2] = D.unitStats(fk, k2); }
    oreTiles = [];
    for (i = 0; i < S.map.oreMax.length; i++) if (S.map.oreMax[i] > 0) oreTiles.push(i);
    migrate();
    drainEnd = -1;
    for (i = 0; i < S.ents.length; i++) if (S.ents[i].drainT > S.tick) drainEnd = Math.max(drainEnd, S.ents[i].drainT);   // v1.0
    G.Path.init(S);
    // v0.5: Mauer-Belegung für Durchbruchspfade
    for (i = 0; i < S.ents.length; i++) { var we = S.ents[i]; if (!we.dead && isWall(we) && !D.BUILDINGS[we.type].noOcc) { G.Path.setWall(we.ty * S.map.w + we.tx, we.owner); if (D.BUILDINGS[we.type].gate) G.Path.setGate(we.ty * S.map.w + we.tx, we.owner); } }   // v1.2: Tore
    recalcPower();
  }

  /** v0.8: Bau-Warteschlange eines Gebäudetyps: 'defense' (D.BUILDINGS[t].defense) oder 'building'. */
  function bcat(type) { var d = D.BUILDINGS[type]; return d && d.defense ? 'defense' : 'building'; }

  /** Ältere Spielstände (v0.1) um v0.3-Felder ergänzen (additiv, ändert nichts Bestehendes). */
  function migrate() {
    if (!S.strikes) S.strikes = [];
    if (!S.sw) S.sw = [];
    if (!S.settings) S.settings = {};
    if (S.settings.peace == null) S.settings.peace = 0;   // v0.7
    if (S.peaceDone == null) S.peaceDone = S.settings.peace > 0 && S.tick >= S.settings.peace * HZ;
    for (var p = 0; p < S.players.length; p++) {
      var P = S.players[p];
      if (P.radar == null) P.radar = false;
      if (P.st.captures == null) P.st.captures = 0;
      if (P.st.oil == null) P.st.oil = 0;
      if (P.st.walls == null) { P.st.walls = 0; P.st.deploys = 0; }   // v0.5
      if (P.st.heroes == null) P.st.heroes = 0;   // Erfahrung: Anzahl Beförderungen zum höchsten Rang
      // v0.8: eigene Verteidigungs-Warteschlange; Altstände: Verteidigungseinträge aus q.building umziehen
      if (!P.q.defense) {
        P.q.defense = [];
        var keep = [];
        for (var qi = 0; qi < P.q.building.length; qi++) (bcat(P.q.building[qi].type) === 'defense' ? P.q.defense : keep).push(P.q.building[qi]);
        P.q.building = keep;
      }
      if (P.cheat == null) P.cheat = false;   // v0.8
      if (P.cheatUsed == null) P.cheatUsed = false;
    }
    for (var i = 0; i < S.ents.length; i++) {
      var e = S.ents[i];
      if (e.kind === 'unit') {
        if (e.inside == null) { e.inside = 0; e.enterId = 0; e.ftgt = 0; e.fleeT = -9999; e.lastAtkT = -9999; e.retal = 0; }
        if (e.setup == null) { e.setup = 0; e.barrel = 0; }
        if (e.breach == null) e.breach = 0;   // v0.5
        if (e.xp == null) { e.xp = 0; e.rk = 0; }   // Erfahrung: Altstände ohne Feld → Rekrut
        if (e.salvoN == null) { e.salvoN = 0; e.salvoI = 0; e.salvoT0 = 0; e.salvoX = 0; e.salvoY = 0; e.salvoTid = 0; e.htgt = 0; e.healT = -100; e.follow = 0; e.loadId = 0; }   // v0.7
        if (!e.fac) e.fac = S.players[e.owner].faction;   // v1.0
        var ust0 = D.unitStats(e.fac, e.type);
        if (ust0 && ust0.transport && !e.gar) { e.gar = []; e.cap = ust0.transport; }
      } else {
        var b = D.BUILDINGS[e.type];
        if (b.superweapon && e.charge == null) { e.charge = 0; e.swRdy = false; }
        if (e.neutral == null) e.neutral = !!b.neutral;
        if (b.neutral && !e.gar) { e.gar = []; e.cap = b.cap || 0; e.ruin = false; e.capT = 0; e.capBy = -1; if (b.special === 'arty') e.charge = 0; }
        if (b.garrisonOwn && !e.gar) { e.gar = []; e.cap = b.cap || 0; }   // v0.5
      }
    }
    migrateV08();
    migrateV12();   // v1.2 Neue Einheiten (Abschnitt am Dateiende)
  }

  function circle(r) {
    if (circles[r]) return circles[r];
    var a = [], R = Math.ceil(r);
    for (var y = -R; y <= R; y++) for (var x = -R; x <= R; x++) if (x * x + y * y <= r * r + r) a.push(x, y);
    return (circles[r] = a);
  }

  // ------------------------------------------------------------------ Entitäten
  function addBuilding(owner, type, tx, ty, instant) {
    var b = D.BUILDINGS[type];
    var e = {
      id: S.nextId++, kind: 'building', type: type, owner: owner, tx: tx, ty: ty, w: b.w, h: b.h,
      x: (tx + b.w / 2) * TILE, y: (ty + b.h / 2) * TILE, hp: b.hp, maxHp: b.hp, placedT: instant ? -100 : S.tick,
      rx: -1, ry: -1, repairing: false, tdir: Math.PI / 2, tgt: 0, fireT: -100, cd: 0, dead: false, neutral: !!b.neutral
    };
    if (b.neutral) {
      e.gar = []; e.cap = b.cap || 0; e.ruin = false; e.capT = 0; e.capBy = -1;
      if (b.special === 'arty') e.charge = 0;
    }
    if (b.superweapon) { e.charge = 0; e.swRdy = false; }
    if (b.garrisonOwn) { e.gar = []; e.cap = b.cap || 0; }   // v0.5 baubarer Bunker
    if (b.cloak) e.clk = 1;                                   // v1.2 Tarnung
    if (b.mine) { e.ch = b.mine.charges; }                    // v1.2 Minenfeld: Ladungen
    S.ents.push(e); byId.set(e.id, e);
    if (!b.noOcc) for (var y = ty; y < ty + b.h; y++) for (var x = tx; x < tx + b.w; x++) S.occ[y * S.map.w + x] = e.id;   // v1.2: noOcc (Minenfeld) belegt keine Kachel
    if (b.isWall && !b.noOcc) G.Path.setWall(ty * S.map.w + tx, owner);
    if (b.gate) G.Path.setGate(ty * S.map.w + tx, owner);   // v1.2 Tor
    recalcPower();
    // Einheiten, die (durch Pfadänderung) über die Fläche wollen, planen neu
    for (var i = 0; i < S.ents.length; i++) {
      var u = S.ents[i];
      if (u.kind === 'unit' && u.path && u.path.length) { u.repathT = S.tick; }
    }
    return e;
  }

  /** Neutrales Kartengebäude setzen (prüft Grenzen/Überlappung, sonst übersprungen). */
  function addStructure(type, tx, ty) {
    var b = D.BUILDINGS[type];
    if (!b || !b.neutral) return null;
    if (tx < 0 || ty < 0 || tx + b.w > S.map.w || ty + b.h > S.map.h) return null;
    for (var y = ty; y < ty + b.h; y++) for (var x = tx; x < tx + b.w; x++) if (S.occ[y * S.map.w + x]) return null;
    var x0 = tx * TILE, y0 = ty * TILE, x1 = x0 + b.w * TILE, y1 = y0 + b.h * TILE;
    for (var i = 0; i < S.ents.length; i++) {
      var u = S.ents[i];
      if (u.kind === 'unit' && u.x + u.r > x0 && u.x - u.r < x1 && u.y + u.r > y0 && u.y - u.r < y1) return null;
    }
    return addBuilding(-1, type, tx, ty, true);
  }

  function spawnUnit(owner, type, x, y) {
    var st = stats[owner][type];
    if (!st) return null;
    var e = {
      id: S.nextId++, kind: 'unit', type: type, owner: owner, x: x, y: y, px: x, py: y,
      hp: st.hp, maxHp: st.hp, r: st.radius, dir: Math.PI / 2, tdir: Math.PI / 2, mc: D.MOVE_CLASS[st.move] || 0,
      ord: 'idle', tgt: 0, gx: x, gy: y, hx: x, hy: y, path: null, pi: 0, pp: false, pend: 1,
      moving: false, cd: 0, fireT: -100, scanT: 0, stuck: 0, lastX: x, lastY: y, repathT: -1, giveUp: 0,
      cargo: 0, hs: '', oreT: -1, refId: 0, kills: 0, xp: 0, rk: 0, lastAtk: 0, dead: false, chase: false, amx: null, amy: null, mineT: 0,
      inside: 0, enterId: 0, ftgt: 0, fleeT: -9999, lastAtkT: -9999, retal: 0, setup: 0, barrel: 0, breach: 0,
      // v0.7
      salvoN: 0, salvoI: 0, salvoT0: 0, salvoX: 0, salvoY: 0, salvoTid: 0, htgt: 0, healT: -100, follow: 0, loadId: 0
    };
    e.fac = S.players[owner].faction;                         // v1.0: Herkunftsfraktion (bleibt bei Gedankenkontrolle)
    if (st.move === 'hover') e.pc = D.HOVER_PC;               // v1.0 Schwebepanzer: Wegfindung über Land und Wasser
    if (st.transport) { e.gar = []; e.cap = st.transport; }   // v0.7 Schützenpanzer (v0.8: alle Transporter)
    if (e.mc === 2) initFlyer(e, st);                         // v0.8 Luftfahrzeug
    if (st.cloak) e.clk = 1;                                  // v1.2 Tarnung
    S.ents.push(e); byId.set(e.id, e);
    return e;
  }

  function get(id) { return byId.get(id); }
  /** v0.5: Mauersegment? */
  function isWall(e) { return !!e && e.kind === 'building' && !!D.BUILDINGS[e.type].isWall; }
  function statsOf(e) { return e.kind === 'unit' ? ust(e) : D.BUILDINGS[e.type]; }
  /** v1.0: Einheitenwerte nach Herkunftsfraktion e.fac (gedankenkontrollierte Einheiten behalten ihre Werte), sonst Fraktion des Besitzers. */
  function ust(e) { var f = e.fac || (S.players[e.owner] ? S.players[e.owner].faction : 'coalition'); return statsF[f][e.type]; }
  /** v1.0: Wegfindungsklasse (Schwebepanzer: 4 = Land + Wasser), sonst Bewegungsklasse. */
  function pcOf(e) { return e.pc != null ? e.pc : e.mc; }

  function emit(t, x, y, extra) {
    var ev = { seq: ++S.evSeq, tick: S.tick, t: t, x: x, y: y };
    if (extra) for (var k in extra) ev[k] = extra[k];
    S.events.push(ev);
    return ev;
  }

  function recalcPower() {
    for (var p = 0; p < S.players.length; p++) { S.players[p].pwrProd = 0; S.players[p].pwrUse = 0; }
    for (var i = 0; i < S.ents.length; i++) {
      var e = S.ents[i];
      if (e.kind !== 'building' || e.dead || e.owner < 0 || e.neutral) continue;
      var pw = D.BUILDINGS[e.type].power, P = S.players[e.owner];
      if (pw > 0) { if (!(e.drainT > S.tick) && !(e.offT > S.tick)) P.pwrProd += pw; } else P.pwrUse -= pw;   // v1.0: vom Diskus entzogen → kein Strom
    }
    recalcCap();   // v1.2 Erzlager (gleiche Aufrufstellen wie die Energie: Bau, Verlust, Übernahme)
  }
  function lowPower(pid) { var P = S.players[pid]; return P.pwrUse > P.pwrProd; }

  // ------------------------------------------------------------------ Abfragen
  function tileOf(x, y) { return Math.floor(y / TILE) * S.map.w + Math.floor(x / TILE); }

  /** Ist Entität e für Spieler pid sichtbar (Nebel)? */
  function isVisible(pid, e) {
    if (e.owner === pid) return true;
    if (e.clk && hidden(pid, e)) return false;   // v1.2 Tarnung
    var vis = S.players[pid].vis, w = S.map.w;
    if (e.kind === 'unit') return !e.inside && vis[tileOf(e.x, e.y)] === 1;
    for (var y = e.ty; y < e.ty + e.h; y++) for (var x = e.tx; x < e.tx + e.w; x++) if (vis[y * w + x]) return true;
    return false;
  }

  /** Gebäude e für pid erforscht (mind. eine Kachel)? */
  function explored(pid, e) {
    var ex = S.players[pid].exp, w = S.map.w;
    for (var y = e.ty; y < e.ty + e.h; y++) for (var x = e.tx; x < e.tx + e.w; x++) if (ex[y * w + x]) return true;
    return false;
  }
  /** Darf ein Angreifer von Spieler pid die Entität t beschießen? (v0.3: Insassen, Neutrale, Spezial, Ruinen) */
  function hostile(pid, t) {
    if (!t || t.dead || t.inside || t.owner === pid || t.owner < 0) return false;
    if (t.neutral) { if (t.ruin || D.BUILDINGS[t.type].invuln) return false; }
    return true;
  }
  /** Abstand von Punkt (x,y) zur Oberfläche von e (Gebäude: Rechteck; Einheit: Kreis). */
  function distTo(e, x, y) {
    if (e.kind === 'building') {
      var x0 = e.tx * TILE, y0 = e.ty * TILE, x1 = x0 + e.w * TILE, y1 = y0 + e.h * TILE;
      var dx = x < x0 ? x0 - x : (x > x1 ? x - x1 : 0), dy = y < y0 ? y0 - y : (y > y1 ? y - y1 : 0);
      return Math.sqrt(dx * dx + dy * dy);
    }
    var ex = e.x - x, ey = e.y - y;
    return Math.max(0, Math.sqrt(ex * ex + ey * ey) - e.r);
  }

  function hasBuilding(pid, type) {
    for (var i = 0; i < S.ents.length; i++) {
      var e = S.ents[i];
      if (e.kind === 'building' && !e.dead && e.owner === pid && e.type === type) return true;
    }
    return false;
  }
  function countOf(pid, type, kind) {
    var n = 0;
    for (var i = 0; i < S.ents.length; i++) {
      var e = S.ents[i];
      if (!e.dead && e.owner === pid && e.type === type && (!kind || e.kind === kind)) n++;
    }
    return n;
  }

  /** Kann Spieler pid Typ (Gebäude oder Einheit) produzieren? → { ok, reason } */
  function canProduce(pid, type) {
    var P = S.players[pid];
    if (D.BUILDINGS[type]) {
      var b = D.BUILDINGS[type];
      if (type === 'hq' || b.neutral) return { ok: false, reason: 'Nicht baubar' };
      if (b.faction && b.faction !== P.faction) return { ok: false, reason: 'Nicht für ' + D.FACTIONS[P.faction].name };
      if (!hasBuilding(pid, 'hq')) return { ok: false, reason: 'Hauptquartier fehlt' };
      if (b.req && !hasBuilding(pid, b.req)) return { ok: false, reason: 'Benötigt ' + D.BUILDINGS[b.req].name };
      if (b.limit) {
        var have = countOf(pid, type, 'building');
        var bqc = P.q[bcat(type)];
        for (var qi = 0; qi < bqc.length; qi++) if (bqc[qi].type === type) have++;
        if (have >= b.limit) return { ok: false, reason: 'Höchstens ' + b.limit + ' erlaubt' };
      }
      return { ok: true, reason: '' };
    }
    var st = stats[pid][type];
    if (!st) return { ok: false, reason: 'Nicht für ' + D.FACTIONS[P.faction].name };
    if (!hasBuilding(pid, st.producer)) return { ok: false, reason: 'Benötigt ' + D.BUILDINGS[st.producer].name };
    if (st.req && !hasBuilding(pid, st.req)) return { ok: false, reason: 'Benötigt ' + D.BUILDINGS[st.req].name };
    if (st.cat === 'air') { var pb = airPadBlock(pid); if (pb) return { ok: false, reason: pb }; }   // v0.8 Landeplätze
    return { ok: true, reason: '' };
  }

  /** Platzierungsprüfung: → { ok, reason } */
  function canPlace(pid, type, tx, ty) {
    var b = D.BUILDINGS[type], m = S.map, TER = D.TERRAIN;
    if (!b || b.neutral) return { ok: false, reason: 'Unbekannt' };
    if (b.shore) return canPlaceShore(pid, type, tx, ty);   // v0.8 Werft
    if (tx < 0 || ty < 0 || tx + b.w > m.w || ty + b.h > m.h) return { ok: false, reason: 'Außerhalb der Karte' };
    for (var y = ty; y < ty + b.h; y++) for (var x = tx; x < tx + b.w; x++) {
      var i = y * m.w + x;
      if (!TER[m.terrain[i]].build) return { ok: false, reason: 'Ungeeignetes Gelände' };
      if (m.ore[i] > 0) return { ok: false, reason: 'Nicht auf Erz' };
      if (S.occ[i]) return { ok: false, reason: 'Belegt' };
    }
    if (noOccAt(tx, ty, b.w, b.h)) return { ok: false, reason: 'Belegt' };   // v1.2 Minenfeld (ohne Kachelbelegung)
    if (unitsOnRect(tx, ty, b.w, b.h, 0)) return { ok: false, reason: 'Einheiten im Weg' };
    if (!nearBase(pid, tx, ty, b.w, b.h, b.placeDist) && !(b.gate && wallAdjacent(pid, tx, ty))) return { ok: false, reason: b.gate ? 'Zu weit von Basis und Mauer' : 'Zu weit von der Basis' };   // v1.2: placeDist; Tor auch direkt an eigener Mauer
    return { ok: true, reason: '' };
  }
  /** v1.2: Grenzt Kachel (tx,ty) (8 Nachbarn) an ein eigenes Mauersegment/Tor? */
  function wallAdjacent(pid, tx, ty) {
    for (var oy = -1; oy <= 1; oy++) for (var ox = -1; ox <= 1; ox++) {
      var x = tx + ox, y = ty + oy;
      if ((!ox && !oy) || x < 0 || y < 0 || x >= S.map.w || y >= S.map.h) continue;
      var o = S.occ[y * S.map.w + x], we = o ? byId.get(o) : null;
      if (we && we.owner === pid && isWall(we)) return true;
    }
    return false;
  }
  /** Steht eine (sichtbare, nicht eingestiegene) Einheit außer exceptId auf dem Kachelrechteck? */
  function unitsOnRect(tx, ty, w, h, exceptId) {
    var x0 = tx * TILE, y0 = ty * TILE, x1 = x0 + w * TILE, y1 = y0 + h * TILE;
    for (var k = 0; k < S.ents.length; k++) {
      var e = S.ents[k];
      if (e.dead || e.kind !== 'unit' || e.inside || e.id === exceptId || e.mc === 2) continue;   // v0.8: Luftfahrzeuge blockieren nicht
      if (e.x + e.r > x0 && e.x - e.r < x1 && e.y + e.r > y0 && e.y - e.r < y1) return true;
    }
    return false;
  }
  /** v0.5 Nähe-Regel (SPEC_v05 §1): ≤ PLACE_DIST Kacheln zu eigenem Basisgebäude (keine Mauern, keine neutralen)
   *  ODER zu einem eroberten neutralen Spezialgebäude. Besetzte Häuser zählen nicht. */
  function nearBase(pid, tx, ty, w, h, dist) {
    var maxD = dist || D.PLACE_DIST;   // v0.8: Werft darf weiter weg stehen (placeDist)
    for (var k = 0; k < S.ents.length; k++) {
      var e = S.ents[k];
      if (e.dead || e.kind !== 'building' || e.owner !== pid) continue;
      var bd = D.BUILDINGS[e.type];
      if (bd.isWall) continue;
      if (e.neutral && bd.kind2 !== 'special') continue;
      var gx = Math.max(0, e.tx - (tx + w), tx - (e.tx + e.w));
      var gy = Math.max(0, e.ty - (ty + h), ty - (e.ty + e.h));
      if (Math.max(gx, gy) <= maxD) return true;
    }
    return false;
  }

  // ---- v0.5: Mauern (SPEC_v05 §2) ----
  /** Prüft/plant eine Mauerkette, ohne den Zustand zu ändern. → { res:[{i, ok, reason}], ok:[Kachelindizes in Setzreihenfolge] }
   *  Jedes Segment: bebaubar, frei, Nähe-Regel ODER (8-)angrenzend an ein bereits gültiges Segment desselben Aufrufs;
   *  Kosten 50 je Segment, solange die Credits reichen. Mehrere Durchgänge, damit die Reihenfolge der Kacheln egal ist. */
  function planWall(pid, tiles) {
    var m = S.map, w = m.w, TER = D.TERRAIN, d = D.BUILDINGS.wall, P = S.players[pid];
    var list = [], seen = {}, res = [];
    tiles = tiles || [];
    for (var k = 0; k < tiles.length; k++) {
      var ti = tiles[k];
      if (typeof ti !== 'number' || ti !== Math.floor(ti)) { res.push({ i: ti, ok: false, reason: 'Ungültige Kachel' }); continue; }
      if (seen[ti]) continue;
      seen[ti] = 1;
      if (list.length >= D.WALL_MAX) { res.push({ i: ti, ok: false, reason: 'Höchstens ' + D.WALL_MAX + ' Segmente' }); continue; }
      list.push(ti);
    }
    var state = {}, why = {}, okList = [], ok = {};
    // Grundprüfung je Segment
    for (k = 0; k < list.length; k++) {
      ti = list[k];
      var tx = ti % w, ty = (ti - tx) / w, r = '';
      if (ti < 0 || ti >= w * m.h) r = 'Außerhalb der Karte';
      else if (!TER[m.terrain[ti]].build) r = 'Ungeeignetes Gelände';
      else if (m.ore[ti] > 0) r = 'Nicht auf Erz';
      else if (S.occ[ti] || noOccAt(tx, ty, 1, 1)) r = 'Belegt';
      else if (unitsOnRect(tx, ty, 1, 1, 0)) r = 'Einheiten im Weg';
      why[ti] = r; state[ti] = r ? -1 : (nearBase(pid, tx, ty, 1, 1) ? 1 : 0);   // 1 = Nähe ok, 0 = braucht Kette
    }
    var credits = P.credits, cost = d.cost, poor = {}, changed = true;
    while (changed) {
      changed = false;
      for (k = 0; k < list.length; k++) {
        ti = list[k];
        if (ok[ti] || state[ti] < 0) continue;
        var good = state[ti] === 1;
        if (!good) {
          var cx = ti % w, cy = (ti - cx) / w;
          for (var oy = -1; oy <= 1 && !good; oy++) for (var ox = -1; ox <= 1; ox++) {
            if (!ox && !oy) continue;
            var nx = cx + ox, ny = cy + oy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= m.h) continue;
            if (ok[ny * w + nx]) { good = true; break; }
          }
        }
        if (!good) continue;
        if (credits < cost) { poor[ti] = 1; continue; }
        credits -= cost; ok[ti] = 1; okList.push(ti); changed = true;
      }
    }
    for (k = 0; k < list.length; k++) {
      ti = list[k];
      if (ok[ti]) res.push({ i: ti, ok: true, reason: '' });
      else res.push({ i: ti, ok: false, reason: why[ti] || (poor[ti] ? 'Zu wenig Credits' : 'Zu weit von der Basis') });
    }
    return { res: res, ok: okList };
  }
  /** Mauersegmente setzen (über G.cmd.placeWall). → { ok, reason, placed, skipped, ids, cost } */
  function placeWall(pid, tiles) {
    var c = canProduce(pid, 'wall');
    if (!c.ok) return { ok: false, reason: c.reason, placed: 0 };
    if (!tiles || !tiles.length) return { ok: false, reason: 'Keine Kacheln', placed: 0 };
    var plan = planWall(pid, tiles), P = S.players[pid], d = D.BUILDINGS.wall, ids = [], w = S.map.w;
    for (var k = 0; k < plan.ok.length; k++) {
      var ti = plan.ok[k];
      if (P.credits < d.cost) break;
      var b = addBuilding(pid, 'wall', ti % w, (ti - ti % w) / w, false);
      P.credits -= d.cost; P.st.spent += d.cost; P.st.walls++;
      ids.push(b.id);
    }
    var skipped = plan.res.length - ids.length;
    if (!ids.length) {
      var first = '';
      for (k = 0; k < plan.res.length; k++) if (!plan.res[k].ok) { first = plan.res[k].reason; break; }
      return { ok: false, reason: first || 'Nicht möglich', placed: 0, skipped: skipped, ids: [] };
    }
    var f = get(ids[0]);
    emit('wall', f.x, f.y, { ids: ids, owner: pid, n: ids.length, cost: ids.length * d.cost });
    updateFogFor(P);
    return { ok: true, reason: skipped ? skipped + ' Segment' + (skipped > 1 ? 'e' : '') + ' übersprungen' : '', placed: ids.length, skipped: skipped, ids: ids, cost: ids.length * d.cost };
  }
  /** Vorschau für die Bedienung: je Kachel {i, ok, reason} plus Gesamtkosten der gültigen. */
  function canPlaceWall(pid, tiles) {
    var c = canProduce(pid, 'wall');
    if (!c.ok) return { ok: false, reason: c.reason, tiles: (tiles || []).map(function (i) { return { i: i, ok: false, reason: c.reason }; }), cost: 0, n: 0 };
    var plan = planWall(pid, tiles);
    return { ok: plan.ok.length > 0, reason: '', tiles: plan.res, cost: plan.ok.length * D.BUILDINGS.wall.cost, n: plan.ok.length };
  }

  // ---- v0.5: Mobiler Bauhof (SPEC_v05 §3) ----
  /** Kann an Kachel (cx,cy) ein HQ (3×3, linke obere Kachel cx−1, cy−1) aufgebaut werden? exceptId = das Fahrzeug selbst. */
  function canDeployAt(pid, cx, cy, exceptId) {
    var m = S.map, TER = D.TERRAIN, tx = cx - 1, ty = cy - 1;
    var r = { ok: false, reason: 'Hier ist kein Platz', tx: tx, ty: ty };
    if (tx < 0 || ty < 0 || tx + 3 > m.w || ty + 3 > m.h) return r;
    var bad = false;
    for (var y = ty; y < ty + 3; y++) for (var x = tx; x < tx + 3; x++) {
      var i = y * m.w + x;
      if (S.occ[i]) return r;
      if (!TER[m.terrain[i]].build || m.ore[i] > 0) bad = true;
    }
    if (bad) { r.reason = 'Untergrund nicht bebaubar'; return r; }
    if (unitsOnRect(tx, ty, 3, 3, exceptId)) return r;
    r.ok = true; r.reason = '';
    return r;
  }
  /** G.Sim.canDeploy(pid, unitId) → {ok, reason, tx, ty} (Vorschau). */
  function canDeploy(pid, unitId) {
    var u = byId.get(unitId);
    if (!u || u.dead || u.kind !== 'unit' || u.inside || !ust(u) || !ust(u).deploys) return { ok: false, reason: 'Kein Mobiler Bauhof', tx: -1, ty: -1 };
    if (u.owner !== pid) return { ok: false, reason: 'Nicht in deinem Besitz', tx: -1, ty: -1 };
    return canDeployAt(pid, Math.floor(u.x / TILE), Math.floor(u.y / TILE), u.id);
  }
  /** Mobilen Bauhof aufbauen (über G.cmd.deploy). → { ok, reason, id } */
  function deploy(pid, unitId) {
    var c = canDeploy(pid, unitId);
    if (!c.ok) return { ok: false, reason: c.reason };
    var u = byId.get(unitId), P = S.players[pid];
    removeEntity(u);
    var b = addBuilding(pid, 'hq', c.tx, c.ty, false);
    P.st.deploys++; P.st.buildingsBuilt++;
    emit('deploy', b.x, b.y, { id: b.id, unit: u.id, owner: pid, type: 'hq' });
    updateFogFor(P);
    return { ok: true, reason: '', id: b.id };
  }

  /** Oberste Entität an Weltposition (x,y), die für pid sichtbar ist (oder null). */
  function entityAt(x, y, pid, slack) {
    slack = slack || 6;
    var best = null, bestD = 1e9;
    for (var i = 0; i < S.ents.length; i++) {
      var e = S.ents[i];
      if (e.dead || e.inside) continue;
      if (pid != null && e.clk && hidden(pid, e)) continue;   // v1.2 Tarnung (auch ohne Nebel)
      if (pid != null && e.owner !== pid && !S.settings.fogOff && !isVisible(pid, e) && !(e.neutral && explored(pid, e))) continue;
      var d = distTo(e, x, y);
      if (e.kind === 'unit') { if (d <= slack && d < bestD) { best = e; bestD = d - 2; } }
      else if (d <= 0 && bestD > 0) { best = e; bestD = 0; }
    }
    return best;
  }

  /** Eigene Einheiten im Rechteck (Weltpixel). */
  function unitsInRect(pid, x0, y0, x1, y1) {
    var r = [], ax = Math.min(x0, x1), bx = Math.max(x0, x1), ay = Math.min(y0, y1), by = Math.max(y0, y1);
    for (var i = 0; i < S.ents.length; i++) {
      var e = S.ents[i];
      if (!e.dead && e.kind === 'unit' && !e.inside && e.owner === pid && e.x >= ax && e.x <= bx && e.y >= ay && e.y <= by) r.push(e.id);
    }
    return r;
  }

  /** Erste (primäre) Produktionsstätte eines Typs. */
  function producerOf(pid, btype) {
    for (var i = 0; i < S.ents.length; i++) {
      var e = S.ents[i];
      if (e.kind === 'building' && !e.dead && e.owner === pid && e.type === btype) return e;
    }
    return null;
  }

  // ------------------------------------------------------------------ Befehle (intern, von cmd.js genutzt)
  function setGoal(e, x, y) {
    e.gx = x; e.gy = y; e.path = null; e.pi = 0; e.stuck = 0; e.giveUp = 0; e.breach = 0;
    e.lastX = e.x; e.lastY = e.y;
    G.Path.request(S, e);
  }
  function orderMove(e, x, y, ord) {
    e.enterId = 0; e.loadId = 0; e.follow = 0; e.repId = 0;   // v1.2: repId (Reparaturziel) verfällt mit jedem neuen Fahrbefehl
    if (e.mc === 2) { e.land = false; e.bdrop = 0; }   // v0.8: Luftfahrzeug startet
    e.ord = ord || 'move'; e.tgt = 0; e.chase = false; e.hs = '';
    setGoal(e, x, y);
  }
  function orderAttack(e, tid) {
    var t = byId.get(tid);
    if (!t || t.dead) return;
    if (e.mc === 2) { e.land = false; if (statsOf(e).bomber) { orderBomb(e, t.x, t.y, tid); return; } }   // v0.8
    e.ord = 'attack'; e.tgt = tid; e.chase = false; e.hs = ''; e.enterId = 0; e.breach = 0; e.loadId = 0;
    e.path = null; e.pp = false; e.gx = t.x; e.gy = t.y;
  }
  function orderStop(e) {
    e.enterId = 0; e.loadId = 0; e.follow = 0;
    e.ord = 'idle'; e.tgt = 0; e.path = null; e.pp = false; e.hs = ''; e.chase = false; e.breach = 0;
    e.hx = e.x; e.hy = e.y; e.moving = false;
  }
  function orderHarvest(e, tileIdx) {
    if (!statsOf(e).harvester) return;
    e.ord = 'harvest'; e.tgt = 0; e.chase = false;
    e.oreT = tileIdx >= 0 ? tileIdx : -1;
    if (e.cargo >= statsOf(e).capacity) { e.hs = 'ret'; e.refId = 0; startReturn(e); }
    else if (tileIdx >= 0 && S.map.ore[tileIdx] > 0) { e.hs = 'go'; setGoal(e, (tileIdx % S.map.w + 0.5) * TILE, (Math.floor(tileIdx / S.map.w) + 0.5) * TILE); }
    else { e.hs = 'seek'; }
  }
  // ---- v0.3: Gebäude betreten / erobern ----
  /** Warum kann pid das Gebäude b (jetzt) nicht betreten? '' = geht. */
  function enterBlock(pid, b) {
    if (!b || b.dead || b.kind !== 'building') return 'Kein Gebäude';
    var d = D.BUILDINGS[b.type];
    if (d.garrisonOwn) {   // v0.5 baubarer Bunker: nur eigene Infanterie
      if (b.owner !== pid) return 'Nur eigene Infanterie kann hinein';
      if (b.gar.length >= b.cap) return 'Gebäude ist voll';
      return '';
    }
    if (!d.neutral) return b.owner === pid ? 'Eigene Basis-Gebäude sind nicht besetzbar' : 'Nicht betretbar';
    if (b.ruin) return 'Ruine – nicht mehr besetzbar';
    if (d.kind2 === 'garrison') {
      if (b.owner >= 0 && b.owner !== pid) return 'Vom Gegner besetzt – erst freikämpfen';
      if (b.gar.length >= b.cap) return 'Gebäude ist voll';
    } else {
      if (b.owner === pid) return 'Gehört bereits dir';
      if (b.capBy === pid) return 'Wird bereits erobert';
    }
    return '';
  }
  /** v0.4: Warum kann ein Ingenieur von pid das Gebäude b nicht betreten? '' = geht. */
  function engBlock(pid, b) {
    if (!b || b.dead || b.kind !== 'building') return 'Kein Gebäude';
    var d = D.BUILDINGS[b.type];
    if (d.neutral) return enterBlock(pid, b);
    if (b.owner === pid) return b.hp >= b.maxHp ? 'Gebäude ist unbeschädigt' : '';
    if (b.owner < 0) return 'Nicht betretbar';
    if (b.type === 'hq') return 'Hauptquartier kann nicht übernommen werden';
    if (d.isWall) return 'Mauer kann nicht übernommen werden';
    return '';
  }
  /** Was würde ein Ingenieur von pid an b tun? 'capture' | 'repair' | '' (für Hinweise in der Bedienung). */
  function engineerAction(pid, b) {
    if (engBlock(pid, b)) return '';
    if (D.BUILDINGS[b.type].neutral) return D.BUILDINGS[b.type].kind2 === 'special' ? 'capture' : '';
    return b.owner === pid ? 'repair' : 'capture';
  }
  function isEngineer(e) { return e.kind === 'unit' && !!ust(e).engineer; }
  function blockFor(e, b) { return isEngineer(e) ? engBlock(e.owner, b) : enterBlock(e.owner, b); }
  /** Gebäude b geht (durch Ingenieur) an pid über. */
  function transferBuilding(b, pid) {
    var prev = b.owner, d = D.BUILDINGS[b.type];
    if (b.gar && b.gar.length) ejectAll(b);   // v0.5: Bunker-Insassen des Vorbesitzers steigen aus
    if (b.mcList && b.mcList.length) releaseAll(b, 'capture');   // v1.0: übernommener Psi-Turm gibt seine Einheiten frei
    b.owner = pid; b.rx = -1; b.ry = -1; b.repairing = false; b.tgt = 0; b.cd = 0;
    if (prev >= 0 && d.produces) {
      // Warteschlange des Vorbesitzers zurücksetzen, wenn ihm keine Produktionsstätte dieses Typs bleibt
      var PP = S.players[prev], cat = d.produces;
      if (!countOf(prev, b.type, 'building')) {
        for (var i = 0; i < PP.q[cat].length; i++) { PP.credits += PP.q[cat][i].spent; PP.st.spent -= PP.q[cat][i].spent; }
        PP.q[cat] = [];
      }
    }
    recalcPower();
    S.players[pid].st.captures++;
    delete S.players[pid].mem[b.id];
    emit('capture', b.x, b.y, { id: b.id, owner: pid, prev: prev, type: b.type, eng: true });
    if (d.superweapon) { b.swRdy = b.charge >= 1; announceSW(b); }
    updateFogFor(S.players[pid]);
    if (prev >= 0) updateFogFor(S.players[prev]);
  }
  /** Ingenieur e ist am Eingang von b angekommen (Basisgebäude oder Spezialgebäude). */
  function arriveEngineer(e, b) {
    var d = D.BUILDINGS[b.type];
    e.path = null; e.pp = false; e.moving = false; e.enterId = 0; e.tgt = 0; e.enterTry = 0;
    if (d.neutral) {
      // Spezialgebäude: sofortige Eroberung (ohne 4-s-Fortschritt)
      var prev = b.owner;
      b.owner = e.owner; b.capBy = -1; b.capT = 0;
      S.players[e.owner].st.captures++;
      emit('capture', b.x, b.y, { id: b.id, owner: e.owner, prev: prev, type: b.type, eng: true });
      updateFogFor(S.players[e.owner]);
    } else if (b.owner === e.owner) {
      b.hp = b.maxHp; b.repairing = false;
      emit('repairFull', b.x, b.y, { id: b.id, owner: e.owner, type: b.type });
    } else transferBuilding(b, e.owner);
    e.dead = true;
    return true;
  }
  /** Freie, für Infanterie passierbare Kacheln direkt um Gebäude b (stabile Reihenfolge). */
  function ringTiles(b) {
    var r = [], w = S.map.w, h = S.map.h;
    for (var y = b.ty - 1; y <= b.ty + b.h; y++) for (var x = b.tx - 1; x <= b.tx + b.w; x++) {
      if (x >= b.tx && x < b.tx + b.w && y >= b.ty && y < b.ty + b.h) continue;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      if (G.Path.passable(0, y * w + x)) r.push(y * w + x);
    }
    return r;
  }
  function orderEnter(e, b) {
    var st = statsOf(e);
    if (st.cat !== 'infantry' || e.mcBy) return false;   // v1.0: gedankenkontrollierte Infanterie betritt keine Gebäude
    e.ord = 'enter'; e.enterId = b.id; e.tgt = 0; e.chase = false; e.hs = '';
    var ring = ringTiles(b), w = S.map.w, best = -1, bd = 1e18;
    // Eingangskacheln, die schon andere Einheiten ansteuern, meiden (sonst blockieren sie sich gegenseitig)
    var taken = {};
    for (var k = 0; k < S.ents.length; k++) {
      var o = S.ents[k];
      if (o !== e && !o.dead && o.ord === 'enter' && o.enterId === b.id) taken[tileOf(o.gx, o.gy)] = 1;
    }
    for (var i = 0; i < ring.length; i++) {
      var cx = (ring[i] % w + 0.5) * TILE, cy = (Math.floor(ring[i] / w) + 0.5) * TILE, d = dist2(cx, cy, e.x, e.y);
      if (taken[ring[i]]) d += 1e12;
      if (d < bd) { bd = d; best = ring[i]; }
    }
    if (best < 0) { setGoal(e, b.x, b.y + b.h * TILE / 2 + TILE / 2); return true; }
    setGoal(e, (best % w + 0.5) * TILE, (Math.floor(best / w) + 0.5) * TILE);
    return true;
  }
  /** Einheit e ist am Eingang von b angekommen. */
  function arriveEnter(e, b) {
    var why = blockFor(e, b);
    if (why) { orderStop(e); return false; }
    var d = D.BUILDINGS[b.type];
    if (isEngineer(e) && (!d.neutral || d.kind2 === 'special')) return arriveEngineer(e, b);
    e.path = null; e.pp = false; e.moving = false; e.enterId = 0; e.tgt = 0; e.ftgt = 0; e.enterTry = 0;
    if (d.kind2 === 'garrison') {
      if (b.owner !== e.owner) { b.tgt = 0; }
      b.owner = e.owner;
      b.gar.push(e.id);
      e.inside = b.id; e.ord = 'idle';
      e.x = e.px = e.hx = b.x; e.y = e.py = e.hy = b.y;
      emit('enter', b.x, b.y, { id: b.id, unit: e.id, owner: e.owner, type: b.type });
    } else {
      // Spezialgebäude: Einheit wird verbraucht, Eroberung läuft (spätere Eroberung gewinnt)
      b.capBy = e.owner; b.capT = 0;
      emit('enter', b.x, b.y, { id: b.id, unit: e.id, owner: e.owner, type: b.type, capture: true });
      e.dead = true;
    }
    return true;
  }
  /** Alle Insassen steigen aus (an freie Nachbarkacheln). Letzter raus → Besitzer −1. */
  function ejectAll(b) {
    if (!b.gar || !b.gar.length) return 0;
    var ring = ringTiles(b), w = S.map.w, n = 0;
    // v0.8 Seitengleichheit: Ausgang an der Unterkante – für Besitzer mit Basis unten rechts gespiegelt an der Oberkante
    // (vorher stiegen die Insassen der nördlichen Seite immer Richtung Gegner aus, die der südlichen Richtung eigene Basis)
    var efl = b.owner >= 0 && flipOf(b.owner), ey = efl ? b.ty - 1 : b.ty + b.h;
    if (!ring.length) { var alt = G.Path.nearestPassable(0, efl ? b.tx + b.w - 1 - (b.w >> 1) : b.tx + (b.w >> 1), ey, 5, efl); if (alt >= 0) ring.push(alt); }
    // nächstgelegene Kacheln zuerst: Reihenfolge nach Abstand zur Ausgangskante
    ring.sort(function (a, c) {
      var ay = Math.floor(a / w), cy = Math.floor(c / w);
      return (Math.abs(ay - ey) - Math.abs(cy - ey)) || (efl ? c - a : a - c);
    });
    var OFF = [[0, 0], [-8, -6], [8, 6], [8, -6], [-8, 6]];
    for (var i = 0; i < b.gar.length; i++) {
      var u = byId.get(b.gar[i]);
      if (!u || u.dead) continue;
      var t = ring.length ? ring[i % ring.length] : -1, o = OFF[Math.floor(i / Math.max(1, ring.length)) % OFF.length];
      var x = t >= 0 ? (t % w + 0.5) * TILE + o[0] * (efl ? -1 : 1) : b.x, y = t >= 0 ? (Math.floor(t / w) + 0.5) * TILE + o[1] * (efl ? -1 : 1) : b.y + (b.h * TILE / 2 + 8) * (efl ? -1 : 1);
      u.inside = 0; u.x = u.px = u.hx = u.lastX = x; u.y = u.py = u.hy = u.lastY = y;
      u.ord = 'idle'; u.tgt = 0; u.path = null; u.pp = false; u.moving = false; u.chase = false; u.enterId = 0;
      n++;
    }
    b.gar = [];
    if (!D.BUILDINGS[b.type].garrisonOwn) b.owner = -1;   // v0.5: baubarer Bunker bleibt im Besitz
    b.tgt = 0;
    emit('exit', b.x, b.y, { id: b.id, n: n });
    return n;
  }
  // ---- v0.7: Schützenpanzer (SPEC_v07 §1); v0.8: alle Transporter (apc, transheli, lander) ----
  /** Transporter (Daten-Feld transport)? (Name aus v0.7 beibehalten) */
  function isApc(e) { return !!e && e.kind === 'unit' && !e.dead && !!e.gar && !!ust(e) && !!ust(e).transport; }
  function tName(a) { return D.UNITS[a.type] ? D.UNITS[a.type].name : 'Transporter'; }
  /** v0.8: Platzbedarf – Infanterie 1, Fahrzeug 2, große Fahrzeuge (Radius ≥ 15) 3. */
  function slotOf(u) { var st = u && u.kind === 'unit' && ust(u); return !st || st.cat === 'infantry' ? 1 : (u.r >= 15 ? 3 : 2); }
  /** Belegte Plätze (wie v0.7 je Eintrag mindestens 1 – auch für noch nicht aufgeräumte IDs). */
  function usedSlots(a) { var n = 0; for (var i = 0; i < a.gar.length; i++) n += slotOf(byId.get(a.gar[i])); return n; }
  /** v0.8: Darf Transporter a die Einheit u aufnehmen? carry 'inf' (Standard) = nur Infanterie, 'any' = Infanterie und Fahrzeuge (keine Luft-/Seeeinheiten). */
  function canCarry(a, u) {
    if (!a || !u || u === a || u.kind !== 'unit' || u.dead || u.inside || u.mc >= 2 || u.mcBy || !isApc(a)) return false;   // v1.0: gedankenkontrollierte Einheiten steigen nicht ein
    var us = ust(u);
    if ((ust(a).carry || 'inf') === 'inf') return us.cat === 'infantry';
    return us.cat === 'infantry' || us.cat === 'vehicle';
  }
  /** Warum kann Einheit u (von pid) nicht in den APC a einsteigen? '' = geht. */
  function loadBlock(pid, a) {
    if (!isApc(a) || a.inside) return 'Kein Schützenpanzer';
    if (a.owner !== pid) return 'Nicht in deinem Besitz';
    if (usedSlots(a) >= a.cap) return tName(a) + ' ist voll';
    if (a.mc === 2 && !heliCanLand(a)) return 'Hier kann der Hubschrauber nicht landen';   // v0.8
    if (a.mc === 3 && !nearShore(a)) return 'Landungsboot muss am Ufer liegen';           // v0.8
    return '';
  }
  /** v0.8: Abstand (px, Rand zu Rand), ab dem eingestiegen wird. */
  function boardDist(a) { return a.mc === 3 ? D.BEACH_RANGE * TILE : (a.mc === 2 ? D.HELI_BOARD * TILE - a.r : 10); }
  /** v0.8: Hubschrauber muss aufgesetzt haben. */
  function canBoardNow(a) { return a.mc !== 2 || a.alt <= 0.15; }
  /** Eigene Einheiten, die gerade zu APC a laufen. */
  function loadingTo(a, except) {
    var n = 0;
    for (var i = 0; i < S.ents.length; i++) { var o = S.ents[i]; if (!o.dead && o.ord === 'load' && o.loadId === a.id && (!except || except.indexOf(o) < 0)) n++; }
    return n;
  }
  function loadingSlots(a, except) {
    var n = 0;
    for (var i = 0; i < S.ents.length; i++) { var o = S.ents[i]; if (!o.dead && o.ord === 'load' && o.loadId === a.id && (!except || except.indexOf(o) < 0)) n += slotOf(o); }
    return n;
  }
  /** G.cmd.load: Einheiten laufen zum Transporter und steigen ein (nächste zuerst, so viele wie Plätze frei). → {ok, reason, kind:'load', n} */
  function load(pid, units, apcId) {
    var a = byId.get(apcId);
    var why = loadBlock(pid, a);
    if (why) return { ok: false, reason: why };
    var inf = units.filter(function (u) { return canCarry(a, u); });
    if (!inf.length) return { ok: false, reason: (ust(a).carry === 'any') ? 'Nur Bodeneinheiten können einsteigen' : 'Nur Infanterie kann einsteigen' };
    var free = a.cap - usedSlots(a) - loadingSlots(a, inf);
    if (free <= 0) return { ok: false, reason: tName(a) + ' ist voll' };
    inf.sort(function (p, q) { return (dist2(p.x, p.y, a.x, a.y) - dist2(q.x, q.y, a.x, a.y)) || (p.id - q.id); });
    var n = 0;
    for (var i = 0; i < inf.length; i++) {
      var u = inf[i], sz = slotOf(u);
      if (sz > free) continue;
      free -= sz; n++;
      u.ord = 'load'; u.loadId = a.id; u.tgt = 0; u.chase = false; u.hs = ''; u.enterId = 0; u.follow = 0; u.loadTry = 0;
      setGoal(u, a.x, a.y);
    }
    if (!n) return { ok: false, reason: tName(a) + ' ist voll' };
    if (a.mc === 2) { if (a.ord !== 'idle') orderStop(a); a.land = true; }   // v0.8: Hubschrauber setzt zum Einsteigen auf
    return { ok: true, reason: n < inf.length ? 'Nur ' + n + ' Plätze frei' : '', kind: 'load', n: n };
  }
  function boardApc(e, a) {
    if (usedSlots(a) + slotOf(e) > a.cap) { orderStop(e); return false; }
    e.path = null; e.pp = false; e.moving = false; e.loadId = 0; e.tgt = 0; e.ftgt = 0; e.enterId = 0; e.follow = 0; e.htgt = 0;
    e.inside = a.id; e.ord = 'idle';
    e.x = e.px = e.hx = a.x; e.y = e.py = e.hy = a.y;
    a.gar.push(e.id);
    emit('load', a.x, a.y, { id: a.id, unit: e.id, owner: e.owner, type: e.type });
    return true;
  }
  /** v0.8: Passagier (und dessen Passagiere) geht mit dem Transporter unter. */
  function killInside(u, src) {
    if (u.gar) for (var i = 0; i < u.gar.length; i++) { var q = byId.get(u.gar[i]); if (q && !q.dead) killInside(q, src); }
    u.gar && (u.gar = []);
    if (src && src.owner >= 0 && src.owner !== u.owner) S.players[src.owner].st.kills++;
    emit('die', u.x, u.y, { owner: u.owner, type: u.type, kind: 'unit', id: u.id, w: 1, h: 1, src: src && src.id ? src.id : 0, inside: true });
    S.players[u.owner].st.unitsLost++;
    u.inside = 0;
    removeEntity(u);
  }
  /** Alle Insassen steigen an freien Nachbarkacheln des APC aus (hpFrac: HP-Obergrenze als Anteil, z. B. 0.5 bei Zerstörung).
   *  v0.8: Kacheln je Bewegungsklasse des Passagiers (Fahrzeuge brauchen befahrbares Land); Hubschrauber: auch die Landekachel;
   *  findet ein Passagier eines Luft-/Seetransporters keinen Platz, bleibt er an Bord (bzw. geht bei Zerstörung unter). */
  function unloadApc(a, hpFrac, destroyed, src) {
    if (!a.gar || !a.gar.length) return 0;
    var w = S.map.w, h = S.map.h, cx = Math.floor(a.x / TILE), cy = Math.floor(a.y / TILE), rings = {}, used = {};
    function ringFor(cls) {
      if (rings[cls]) return rings[cls];
      var ring = [];
      for (var r = a.mc === 2 ? 0 : 1; r <= 3 && ring.length < a.gar.length * 2; r++) {
        var lay = [];
        for (var y = cy - r; y <= cy + r; y++) for (var x = cx - r; x <= cx + r; x++) {
          if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== r || x < 0 || y < 0 || x >= w || y >= h) continue;
          if (G.Path.passable(cls, y * w + x)) lay.push(y * w + x);
        }
        lay.sort(function (p, q) {
          return (dist2((p % w + 0.5) * TILE, (Math.floor(p / w) + 0.5) * TILE, a.x, a.y) - dist2((q % w + 0.5) * TILE, (Math.floor(q / w) + 0.5) * TILE, a.x, a.y)) || (p - q);
        });
        ring = ring.concat(lay);
      }
      if (!ring.length && a.mc < 2 && G.Path.passable(0, cy * w + cx)) ring.push(cy * w + cx);
      return (rings[cls] = ring);
    }
    var OFF = [[0, 0], [-8, -6], [8, 6], [8, -6], [-8, 6]], n = 0, keep = [];
    for (var i = 0; i < a.gar.length; i++) {
      var u = byId.get(a.gar[i]);
      if (!u || u.dead) continue;
      var cls = u.mc, ring = ringFor(cls), k = used[cls] || 0;
      if (!ring.length && a.mc >= 2) { if (destroyed) killInside(u, src); else keep.push(u.id); continue; }   // v0.8: kein Land in Reichweite
      used[cls] = k + 1;
      var t = ring.length ? ring[k % ring.length] : -1, o = OFF[Math.floor(k / Math.max(1, ring.length)) % OFF.length];
      var px = t >= 0 ? (t % w + 0.5) * TILE + o[0] : a.x, py = t >= 0 ? (Math.floor(t / w) + 0.5) * TILE + o[1] : a.y;
      u.inside = 0; u.x = u.px = u.hx = u.lastX = px; u.y = u.py = u.hy = u.lastY = py;
      u.ord = 'idle'; u.tgt = 0; u.path = null; u.pp = false; u.moving = false; u.chase = false; u.enterId = 0; u.loadId = 0;
      if (hpFrac != null) u.hp = Math.max(1, Math.min(u.hp, u.maxHp * hpFrac));
      if (u.gar) syncPassengers(u);
      n++;
    }
    a.gar = keep;
    var ex = { id: a.id, n: n, owner: a.owner };
    if (destroyed) ex.destroyed = true;
    emit('unload', a.x, a.y, ex);
    if (a.mc === 3 && n && !destroyed) emit('beach', a.x, a.y, { id: a.id, owner: a.owner, n: n });   // v0.8 Landungsboot am Ufer
    return n;
  }
  /** G.cmd.unload → {ok, reason, n}. v0.8: mit (x, y) bzw. für Hubschrauber/Landungsboot ohne Ufer: erst hinfliegen/-fahren (ord 'drop'). */
  function unload(pid, apcId, x, y) {
    var a = byId.get(apcId);
    if (!isApc(a)) return { ok: false, reason: 'Kein Schützenpanzer' };
    if (a.owner !== pid) return { ok: false, reason: 'Nicht in deinem Besitz' };
    if (!a.gar.length) return { ok: false, reason: 'Keine Insassen' };
    if (x != null && y != null) return orderDrop(a, x, y);
    if (a.mc === 2 || (a.mc === 3 && !nearShore(a))) return orderDrop(a, a.x, a.y);
    var n = unloadApc(a, null, false);
    if (!n) return { ok: false, reason: 'Kein Platz zum Aussteigen' };
    return { ok: true, reason: '', n: n };
  }

  // ---- v0.7: Sanitäter ----
  /** Kann Sanitäter m die Einheit u heilen? */
  function healable(m, u) {
    return !!u && !u.dead && !u.inside && u.kind === 'unit' && u !== m && u.owner === m.owner && u.hp < u.maxHp && ust(u).cat === 'infantry';
  }
  /** Am stärksten verletzte (Anteil), dann nächste eigene Infanterie ≤ R px um m (Mittelpunktabstand). */
  function findHeal(m, R) {
    var best = null, bs = 1e18, R2 = R * R;
    var c0x = Math.max(0, Math.floor((m.x - R) / CELL)), c1x = Math.min(gw - 1, Math.floor((m.x + R) / CELL));
    var c0y = Math.max(0, Math.floor((m.y - R) / CELL)), c1y = Math.min(gh - 1, Math.floor((m.y + R) / CELL));
    for (var cy = c0y; cy <= c1y; cy++) for (var cx = c0x; cx <= c1x; cx++) {
      for (var k = gHead[cy * gw + cx]; k !== -1; k = gNext[k]) {
        var u = gEnts[k];
        if (!healable(m, u)) continue;
        var d = dist2(u.x, u.y, m.x, m.y);
        if (d > R2) continue;
        var sc = (u.hp / u.maxHp) * 1e8 + d + u.id * 1e-6;
        if (sc < bs) { bs = sc; best = u; }
      }
    }
    return best;
  }
  /** Heilt das aktuelle Ziel (rate HP/s). → true, wenn geheilt wird. */
  function tickMedic(e, st) {
    var M = st.medic, R = M.radius * TILE;
    var h = e.htgt ? byId.get(e.htgt) : null;
    if (h && (!healable(e, h) || dist2(h.x, h.y, e.x, e.y) > R * R)) { h = null; e.htgt = 0; }
    if (!h && (S.tick + e.id) % 5 === 0) { h = findHeal(e, R); e.htgt = h ? h.id : 0; }
    if (!h) return false;
    h.hp = Math.min(h.maxHp, h.hp + M.rate / HZ);
    if (S.tick - e.healT >= HZ) { e.healT = S.tick; emit('heal', h.x, h.y, { id: e.id, tid: h.id, owner: e.owner, sx: e.x, sy: e.y }); }
    if (h.hp >= h.maxHp) e.htgt = 0;
    return true;
  }
  /** Untätiger Sanitäter: folgt der nächsten verletzten eigenen Infanterie (≤ follow Kacheln) bis in Heilreichweite. */
  function medicIdle(e, st, healing) {
    var M = st.medic;
    if (healing) { e.moving = false; e.path = null; e.pp = false; e.hx = e.x; e.hy = e.y; return; }
    var f = e.follow ? byId.get(e.follow) : null, F = (M.follow + 2) * TILE;
    if (f && (!healable(e, f) || dist2(f.x, f.y, e.x, e.y) > F * F)) { f = null; e.follow = 0; }
    if (!f && (S.tick + e.id) % 10 === 0) {
      f = findHeal(e, M.follow * TILE);
      e.follow = f ? f.id : 0;
      if (f) { e.gx = f.x; e.gy = f.y; e.path = null; e.pp = false; e.stuck = 0; e.giveUp = 0; G.Path.request(S, e); }
    }
    if (!f) { e.moving = false; e.hx = e.x; e.hy = e.y; return; }
    var near = (M.radius - 1) * TILE;
    if (dist2(f.x, f.y, e.x, e.y) <= near * near) { e.moving = false; e.path = null; e.pp = false; return; }
    if (!e.pp && (S.tick + e.id) % 10 === 0 && dist2(e.gx, e.gy, f.x, f.y) > TILE * TILE) { e.gx = f.x; e.gy = f.y; e.path = null; G.Path.request(S, e); }
    if (followPath(e, st) || checkStuck(e)) { e.path = null; e.moving = false; if (e.giveUp >= 5) e.follow = 0; }
  }

  // ---- v0.7: Raketensalve (mlrs) ----
  function launchSalvoRocket(e, wpn) {
    var t = e.salvoTid ? byId.get(e.salvoTid) : null;
    if (t && hostile(e.owner, t) && isVisible(e.owner, t)) { e.salvoX = t.x; e.salvoY = t.y; }
    if (t && airborne(t) && wpn.antiAir) { salvoAA(e, wpn, t); return; }   // v0.8: Salve gegen Luftziel zielsuchend
    var an = rand() * Math.PI * 2, r = Math.sqrt(rand()) * (wpn.scatter || 0) * TILE;
    var tx = e.salvoX + Math.cos(an) * r, ty = e.salvoY + Math.sin(an) * r;
    var dd = Math.sqrt(dist2(tx, ty, e.x, e.y)), idx = e.salvoI;
    var pj9 = { x0: e.x, y0: e.y, x: e.x, y: e.y, tx: tx, ty: ty, tid: 0, t: 0, dur: Math.max(4, Math.round(dd / (wpn.pspeed || 9))), w: wpn.type,
                  dmg: wpn.dmg, owner: e.owner, src: e.id, arc: true, sp: wpn.splash * TILE, raw: wpn.dmg, wt: wpn.type, salvo: idx };
    S.proj.push(pj9);
    e.fireT = S.tick; e.tdir = Math.atan2(ty - e.y, tx - e.x);
    var sh9 = emit('shot', e.x, e.y, { tx: tx, ty: ty, w: wpn.type, owner: e.owner, src: e.id, arc: true, salvo: idx });
    if (wpn.missile) { pj9.missile = true; sh9.missile = true; sh9.n = wpn.salvo; sh9.t2 = S.tick + pj9.dur; }   // v0.9 Schlachtschiff: Raketenstart (Darstellung)
    e.salvoI++; e.salvoN--;
  }
  /** Fällige Raketen der laufenden Salve abfeuern; Fahrt bricht die Salve ab (nur stehend). */
  function tickSalvo(e, st) {
    var wpn = st.weapon;
    if (e.moving || !wpn || !wpn.salvo) { e.salvoN = 0; return; }
    var gap = (wpn.salvoGap || 0.12) * HZ;
    while (e.salvoN > 0 && e.salvoT0 + Math.round(e.salvoI * gap) <= S.tick) launchSalvoRocket(e, wpn);
  }

  /** Artillerieschlag (über G.cmd.artillery). → { ok, reason } */
  function artillery(pid, bid, x, y) {
    var b = byId.get(bid), A = D.ARTY;
    if (!b || b.dead || b.type !== 'artillery') return { ok: false, reason: 'Keine Artilleriestellung' };
    if (b.owner !== pid) return { ok: false, reason: 'Nicht in deinem Besitz' };
    if (b.charge < 1) return { ok: false, reason: 'Artillerie lädt noch (' + Math.ceil((1 - b.charge) * A.charge) + ' s)' };
    if (x < 0 || y < 0 || x >= S.map.w * TILE || y >= S.map.h * TILE) return { ok: false, reason: 'Ziel außer Reichweite' };
    if (dist2(x, y, b.x, b.y) > A.range * TILE * A.range * TILE) return { ok: false, reason: 'Ziel außer Reichweite' };
    if (!S.players[pid].exp[tileOf(x, y)]) return { ok: false, reason: 'Ziel unerforscht' };
    b.charge = 0; b.fireT = S.tick; b.tdir = Math.atan2(y - b.y, x - b.x);
    emit('arty', x, y, { id: b.id, owner: pid, sx: b.x, sy: b.y, t2: S.tick + Math.round(A.delay * HZ) });
    for (var k = 0; k < A.shells; k++) {
      var an = rand() * Math.PI * 2, r = Math.sqrt(rand()) * A.spread * TILE;
      S.strikes.push({ t: S.tick + Math.round(A.delay * HZ) + k * 3, x: x + Math.cos(an) * r, y: y + Math.sin(an) * r, owner: pid, src: b.id });
    }
    return { ok: true, reason: '' };
  }
  function tickStrikes() {
    var A = D.ARTY, R = A.splash * TILE;
    for (var i = 0; i < S.strikes.length; i++) {
      var s = S.strikes[i];
      if (s.t > S.tick) continue;
      S.strikes.splice(i--, 1);
      emit('artyHit', s.x, s.y, { owner: s.owner });
      emit('hit', s.x, s.y, { w: 'cannon', owner: s.owner, arty: true });
      var src = byId.get(s.src) || { owner: s.owner, kind: 'x' };
      if (src.owner !== s.owner) src = { owner: s.owner, kind: 'x' };
      for (var k = 0; k < S.ents.length; k++) {
        var t = S.ents[k];
        if (!hostile(s.owner, t) || airborne(t)) continue;
        var d = distTo(t, s.x, s.y);
        if (d > (t.kind === 'building' ? R * 0.5 : R)) continue;
        var arm = t.kind === 'building' ? 'building' : ust(t).armor;
        damage(t, A.dmg * D.DAMAGE[A.weapon][arm], src);
      }
    }
  }
  // ---- v0.4: Superwaffen (SPEC_v04 §3) ----
  /** Superwaffe gebaut/übernommen: Ereignis swBuilt; Gegner kennen das Gebäude ab sofort (P.mem + erforschte Fläche). */
  function announceSW(b) {
    emit('swBuilt', b.x, b.y, { id: b.id, owner: b.owner, kind: D.BUILDINGS[b.type].superweapon, type: b.type });
    for (var p = 0; p < S.players.length; p++) {
      if (p === b.owner) continue;
      var P = S.players[p];
      P.mem[b.id] = { id: b.id, type: b.type, owner: b.owner, tx: b.tx, ty: b.ty, w: b.w, h: b.h, hp: b.hp, maxHp: b.maxHp };
      for (var y = b.ty; y < b.ty + b.h; y++) for (var x = b.tx; x < b.tx + b.w; x++) P.exp[y * S.map.w + x] = 1;
    }
  }
  function swRate(b) { return DT / D.SW.charge * (lowPower(b.owner) ? 0.5 : 1); }
  function tickSWCharge(b) {
    if (b.owner < 0 || b.offT > S.tick) return;   // v1.2: lahmgelegt → lädt nicht
    if (b.charge < 1) b.charge = Math.min(1, b.charge + swRate(b));
    if (b.charge >= 1 && !b.swRdy) { b.swRdy = true; emit('swReady', b.x, b.y, { id: b.id, owner: b.owner, kind: D.BUILDINGS[b.type].superweapon }); }
  }
  /** Restladezeit in Sekunden beim aktuellen Energiezustand. */
  function swRemaining(b) {
    if (!b || b.charge == null) return 0;
    return Math.max(0, (1 - b.charge) * D.SW.charge * (lowPower(b.owner) ? 2 : 1));
  }
  function mmss(sec) { sec = Math.ceil(sec); var m = Math.floor(sec / 60), r = sec % 60; return m + ':' + (r < 10 ? '0' : '') + r; }
  /** Superwaffe auslösen (über G.cmd.superweapon). → { ok, reason } */
  function superweapon(pid, bid, x, y) {
    var b = byId.get(bid), d = b && b.kind === 'building' ? D.BUILDINGS[b.type] : null;
    if (!b || b.dead || !d || !d.superweapon) return { ok: false, reason: 'Keine Superwaffe' };
    if (b.owner !== pid) return { ok: false, reason: 'Nicht in deinem Besitz' };
    if (b.charge < 1) return { ok: false, reason: 'Lädt noch (' + mmss(swRemaining(b)) + ')' };
    if (!(x >= 0 && y >= 0 && x < S.map.w * TILE && y < S.map.h * TILE) || !S.players[pid].exp[tileOf(x, y)]) return { ok: false, reason: 'Ziel unerforscht' };
    var kind = d.superweapon, C = D.SW[kind], t2 = S.tick + Math.round(C.delay * HZ);
    b.charge = 0; b.swRdy = false; b.fireT = S.tick; b.tdir = Math.atan2(y - b.y, x - b.x);
    S.sw.push({ kind: kind, owner: pid, src: b.id, x: x, y: y, t0: S.tick, t: t2, sx: b.x, sy: b.y });
    var ex = { id: b.id, owner: pid, kind: kind, t2: t2 };
    if (kind === 'missile') { ex.sx = b.x; ex.sy = b.y; }
    emit('swLaunch', x, y, ex);
    var P = S.players[pid]; P.st.sw = (P.st.sw || 0) + 1;
    return { ok: true, reason: '' };
  }
  /** Flächenschaden gegen alles für owner Feindliche: f(t, d) → Schaden (d = Abstand zur Oberfläche, px). */
  function areaDamage(owner, x, y, R, src, f) {
    var killsU = 0, killsB = 0, hits = 0;
    for (var k = 0; k < S.ents.length; k++) {
      var t = S.ents[k];
      if (!hostile(owner, t) || airborne(t)) continue;   // v0.8: Flächenschaden trifft keine Luftfahrzeuge in der Luft
      var dd = distTo(t, x, y);
      if (dd > R) continue;
      var amt = f(t, dd);
      if (!(amt > 0)) continue;
      hits++;
      damage(t, amt, src);
      if (t.dead) { if (t.kind === 'unit') killsU++; else killsB++; }
    }
    return { u: killsU, b: killsB, n: hits };
  }
  function tickSW() {
    for (var i = 0; i < S.sw.length; i++) {
      var s = S.sw[i];
      if (s.t > S.tick) continue;
      S.sw.splice(i--, 1);
      var C = D.SW[s.kind], R = C.radius * TILE;
      if (C.psi) { psiWave(s, R); continue; }   // v1.0 Psi-Welle (keine Explosion)
      var ev = emit('swHit', s.x, s.y, { kind: s.kind, r: R, owner: s.owner, id: s.src });
      emit('hit', s.x, s.y, { w: 'cannon', owner: s.owner, sw: s.kind });
      var src = byId.get(s.src);
      if (!src || src.dead || src.owner !== s.owner) src = { owner: s.owner, kind: 'x' };
      var res = areaDamage(s.owner, s.x, s.y, R, src, function (t, dd) {
        var amt = C.dmg * (1 - (1 - C.edge) * Math.min(1, dd / R));
        if (t.kind === 'building') amt *= C.bld;
        if (t.type === 'hq') amt = Math.min(amt, t.hp - 1);   // HQ überlebt einen Treffer immer
        return amt;
      });
      ev.kills = res.u; ev.bkills = res.b; ev.n = res.n;
    }
  }

  /** Neutrale Kartengebäude pro Tick: Insassen schießen, Eroberung, Spezialeffekte. */
  function tickNeutral(b, d) {
    if (d.kind2 === 'garrison') { if (b.gar.length) tickGarrison(b, d); return; }
    if (b.capBy >= 0) {
      b.capT += DT / D.CAPTURE_TIME;
      if (b.capT >= 1) {
        var prev = b.owner;
        b.owner = b.capBy; b.capBy = -1; b.capT = 0;
        S.players[b.owner].st.captures++;
        emit('capture', b.x, b.y, { id: b.id, owner: b.owner, prev: prev, type: b.type });
        updateFogFor(S.players[b.owner]);
      }
    }
    if (b.owner < 0) return;
    var P = S.players[b.owner];
    switch (d.special) {
      case 'oil': P.credits += D.OIL_INCOME / HZ; P.st.oil += D.OIL_INCOME / HZ; break;
      case 'radar': P.radar = true; break;
      case 'trade': P.trade = (P.trade || 0) + 1; break;   // v1.2 Handelsposten
      case 'arty': b.charge = Math.min(1, (b.charge || 0) + DT / D.ARTY.charge); break;
      case 'heal': case 'repair':
        if ((S.tick + b.id) % 10 !== 0) break;
        var heal = (d.special === 'heal' ? D.HEAL_RATE : D.UNIT_REPAIR_RATE) * 10 / HZ, R = D.SUPPORT_RADIUS * TILE;
        for (var i = 0; i < S.ents.length; i++) {
          var u = S.ents[i];
          if (u.kind !== 'unit' || u.dead || u.inside || u.owner !== b.owner || u.hp >= u.maxHp) continue;
          var cat = ust(u).cat;
          if ((d.special === 'heal') !== (cat === 'infantry')) continue;
          if (distTo(b, u.x, u.y) > R) continue;
          u.hp = Math.min(u.maxHp, u.hp + heal);
        }
        break;
    }
  }
  /** Insassen schießen aus dem Gebäude (eigene Waffe, Reichweite +bonus, Ursprung Gebäudemitte). */
  function tickGarrison(b, d) {
    var half = Math.min(b.w, b.h) * TILE / 2;
    for (var i = b.gar.length - 1; i >= 0; i--) {
      var u = byId.get(b.gar[i]);
      if (!u || u.dead) { b.gar.splice(i, 1); continue; }
      if (u.cd > 0) u.cd--;
      var w = ust(u).weapon;
      if (!w || w.psi || w.type === 'melee') continue;   // v1.0: Psi/Nahkampf wirken nicht aus Gebäuden
      var rangePx = (w.range + (d.rangeBonus || 1)) * TILE + half;
      var t = u.tgt ? byId.get(u.tgt) : null;
      if (t && (!hostile(b.owner, t) || distTo(t, b.x, b.y) > rangePx || !isVisible(b.owner, t) || !canHit(w, t))) { t = null; u.tgt = 0; }
      if (!t && (S.tick + u.id) % 5 === 0) { t = findTarget(u, b.x, b.y, rangePx, w.type); if (t) u.tgt = t.id; }
      if (t && u.cd <= 0) {
        fire(b, t, w); b.tgt = t.id;
        u.cd = reloadT(w, u);
      }
    }
    if (!b.gar.length && !d.garrisonOwn) { b.owner = -1; b.tgt = 0; }
  }

  function orderReturn(e, refId) {
    if (!statsOf(e).harvester) return;
    e.ord = 'harvest'; e.hs = 'ret'; e.refId = refId || 0; startReturn(e);
  }

  // ------------------------------------------------------------------ Produktion
  function produce(pid, type) {
    var P = S.players[pid];
    var c = canProduce(pid, type);
    if (!c.ok) return c;
    if (D.BUILDINGS[type]) {
      if (D.BUILDINGS[type].noQueue) return { ok: false, reason: 'Mauern direkt auf der Karte setzen' };
      var bq0 = P.q[bcat(type)];
      if (bq0.length >= D.QUEUE_MAX) return { ok: false, reason: 'Warteschlange voll (' + D.QUEUE_MAX + ')' };
      bq0.push({ type: type, prog: 0, spent: 0, ready: false });
      return { ok: true };
    }
    var cat = D.UNITS[type].cat, q = P.q[cat];
    var n = 0;
    for (var i = 0; i < q.length; i++) if (q[i].type === type) n++;
    if (n >= D.QUEUE_MAX) return { ok: false, reason: 'Warteschlange voll' };
    if (q.length >= D.QUEUE_MAX * 2) return { ok: false, reason: 'Warteschlange voll' };
    q.push({ type: type, prog: 0, spent: 0, ready: false });
    return { ok: true };
  }
  /** Bricht das letzte Element dieses Typs ab (Rückerstattung des bereits Bezahlten). */
  function cancel(pid, type) {
    var P = S.players[pid];
    var cat = D.BUILDINGS[type] ? bcat(type) : D.UNITS[type] && D.UNITS[type].cat;
    if (!cat) return false;
    var q = P.q[cat];
    for (var i = q.length - 1; i >= 0; i--) {
      if (q[i].type === type) {
        P.credits += q[i].spent; P.st.spent -= q[i].spent;
        q.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  function costOf(pid, type) {
    if (D.BUILDINGS[type]) return D.BUILDINGS[type].cost;
    var st = stats[pid][type], tr = S.players[pid].trade;
    if (tr > 0 && st.cat === 'vehicle') return Math.round(st.cost * (1 - D.TRADE.discount * Math.min(tr, D.TRADE.max)));   // v1.2 Handelsposten: Rabatt auf Fahrzeuge
    return st.cost;
  }
  function timeOf(pid, type) { return D.BUILDINGS[type] ? D.BUILDINGS[type].time : stats[pid][type].time; }

  function tickProduction(P) {
    var pid = P.id, slow = lowPower(pid) ? 0.5 : 1;
    // Gebäude
    // v0.4: es läuft der erste noch nicht fertige Eintrag; fertige bleiben stehen und blockieren nicht
    // v0.8: Verteidigung läuft in eigener Warteschlange parallel zu den Gebäuden
    tickBuildQueue(P, P.q.building, slow);
    tickBuildQueue(P, P.q.defense, slow);
    tickUnitQueue(P, 'infantry', 'barracks', slow);
    tickUnitQueue(P, 'vehicle', 'factory', slow);
  }
  function tickBuildQueue(P, bq, slow) {
    var pid = P.id, cur = null;
    for (var i = 0; i < bq.length; i++) if (!bq[i].ready) { cur = bq[i]; break; }
    if (cur) {
      var bd = D.BUILDINGS[cur.type];
      if (!activeCount(pid, 'hq') || (bd.req && !hasBuilding(pid, bd.req))) { /* kein Bauhof / Voraussetzung verloren: pausiert (v1.2: auch wenn alle HQ lahmgelegt sind) */ }
      else advanceItem(P, cur, slow);
      if (cur.prog >= 1) { cur.ready = true; if (!P.ai) emit('ready', 0, 0, { owner: pid, type: cur.type }); }
    }
  }
  function advanceItem(P, it, mult) {
    var cost = costOf(P.id, it.type), time = timeOf(P.id, it.type);
    var dp = DT / time * mult;
    if (it.prog + dp > 1) dp = 1 - it.prog;
    var dc = cost * dp;
    if (P.credits < dc) return; // pausiert mangels Credits
    P.credits -= dc; it.spent += dc; P.st.spent += dc; it.prog += dp;
    if (it.prog > 0.99999) it.prog = 1;
  }
  function tickUnitQueue(P, cat, btype, slow) {
    var q = P.q[cat];
    if (!q.length) return;
    var nprod = activeCount(P.id, btype);   // v1.2: lahmgelegte Produktionsstätten zählen nicht
    if (!nprod) return;
    var it = q[0], ust = stats[P.id][it.type];
    if (ust && ust.req && !hasBuilding(P.id, ust.req)) return; // v0.4: Tech-Zentrum verloren → pausiert
    if (it.prog < 1) advanceItem(P, it, slow * Math.min(2, 1 + 0.5 * (nprod - 1)));
    if (it.prog >= 1) {
      var b = producerOf(P.id, btype);
      if (b && deliverUnit(P.id, it.type, b)) { q.shift(); P.st.unitsBuilt++; }
    }
  }
  /** Erzeugt fertige Einheit am Ausgang von b und schickt sie zum Sammelpunkt. */
  function deliverUnit(pid, type, b) {
    var st = stats[pid][type], cls = st.move === 'foot' ? 0 : 1, cloneOf = arguments[3];
    if (st.move === 'air' || st.move === 'naval') return deliverAirSea(pid, type, b, st);   // v0.8
    // v0.8: Ausgang auf der Seite des Sammelpunkts – liegt er nördlich der Gebäudeoberkante, Nordausgang (gespiegelt zum Südausgang),
    // sonst wie bisher Süd. Vorher kamen Einheiten der südlichen Basis immer auf der vom Gegner abgewandten Seite heraus (Seitenvorteil P0).
    var north = b.rx >= 0 && b.ry < b.ty * TILE;
    var ex = north ? b.tx + Math.ceil(b.w / 2) - 1 : b.tx + Math.floor(b.w / 2), ey = north ? b.ty - 1 : b.ty + b.h;
    var ti = G.Path.nearestPassable(cls, ex, ey, 6, north);
    if (ti < 0 && north) { north = false; ti = G.Path.nearestPassable(cls, b.tx + Math.floor(b.w / 2), b.ty + b.h, 6); }
    if (ti < 0) return false;
    var tx = ti % S.map.w, ty = (ti - tx) / S.map.w;
    var u = spawnUnit(pid, type, (tx + 0.5) * TILE + (rand() - 0.5) * 6, (ty + 0.5) * TILE + (rand() - 0.5) * 6);
    u.dir = north ? -Math.PI / 2 : Math.PI / 2;
    var spv = emit('spawn', u.x, u.y, { owner: pid, type: type, id: u.id });
    if (cloneOf) { spv.clone = true; emit('clone', u.x, u.y, { owner: pid, type: type, id: u.id, src: b.id }); S.players[pid].st.clones = (S.players[pid].st.clones || 0) + 1; }
    else if (st.cat === 'infantry' && S.players[pid].faction === 'kollektiv' && !st.engineer && !st.medic) {
      // v1.0 Klonlabor: jede D.CLONE_EVERY-te Infanterie-Einheit erscheint zusätzlich als Gratis-Klon
      var Pk = S.players[pid]; Pk.cloneN = (Pk.cloneN || 0) + 1;
      if (Pk.cloneN % D.CLONE_EVERY === 0) deliverUnit(pid, type, b, true);
    }
    if (st.harvester) { orderHarvest(u, -1); return true; }
    if (b.rx >= 0) orderMove(u, b.rx, b.ry, 'move');
    else orderMove(u, u.x + (rand() - 0.5) * TILE * 2, u.y + TILE * 1.5, 'move');
    return true;
  }

  /** Setzt fertiges Gebäude. → { ok, reason, id } */
  function placeBuilding(pid, type, tx, ty) {
    var P = S.players[pid], qi = -1, pq = P.q[bcat(type)];
    for (var k = 0; k < pq.length; k++) if (pq[k].type === type && pq[k].ready) { qi = k; break; }
    if (qi < 0) return { ok: false, reason: 'Nicht bereit' };
    var c = canPlace(pid, type, tx, ty);
    if (!c.ok) return c;
    pq.splice(qi, 1);
    var b = addBuilding(pid, type, tx, ty, false);
    P.st.buildingsBuilt++;
    emit('place', b.x, b.y, { owner: pid, type: type, id: b.id });
    if (D.BUILDINGS[type].superweapon) announceSW(b);
    if (type === 'refinery') {
      // v0.8 Seitengleichheit: Startkachel des Sammlers für die gespiegelte Basis gespiegelt (vorher immer Südrand → anderes erstes Erz)
      var rfl = flipOf(pid), rbw = D.BUILDINGS[type].w, rbh = D.BUILDINGS[type].h;
      var hcx = rfl ? tx + rbw - 2 : tx + 1, hcy = rfl ? ty + rbh - 3 : ty + 2;
      var u = spawnUnit(pid, 'harvester', (hcx + 0.5) * TILE, (hcy + 0.5) * TILE);
      var ti = G.Path.nearestPassable(1, hcx, hcy, 5, rfl);
      if (ti >= 0) { u.x = u.px = (ti % S.map.w + 0.5) * TILE; u.y = u.py = (Math.floor(ti / S.map.w) + 0.5) * TILE; }
      P.st.unitsBuilt++;
      orderHarvest(u, -1);
    }
    updateFogFor(P);
    return { ok: true, id: b.id };
  }

  function sell(pid, id) {
    var b = byId.get(id);
    if (!b || b.dead || b.owner !== pid || b.kind !== 'building') return false;
    var d = D.BUILDINGS[b.type];
    if (d.sellable === false) return false;
    if (b.gar && b.gar.length) ejectAll(b);   // v0.5 Bunker
    S.players[pid].credits += Math.floor(d.cost * D.SELL_REFUND);
    emit('sell', b.x, b.y, { owner: pid, type: b.type, id: b.id });
    removeEntity(b);
    return true;
  }

  // ------------------------------------------------------------------ Erfahrung (Rangstufen; Tabelle: D.EXP in data.js)
  var MODS = { dmg: 1, hp: 1, rof: 1, psi: 1, regen: 0 };
  /** ZENTRALE STELLE für wirksame Einheitenwerte: Schadensfaktor (dmg), Schadensminderung (hp: Treffer / hp), Nachladefaktor (rof, <1 = schneller),
   *  Selbstheilung (regen, Anteil maxHp/s). Gilt für Einheiten beider Seiten; Gebäude und Rekruten → neutrale Werte.
   *  Spätere Systeme (Forschung, Fähigkeiten) hier weitere Faktoren aufmultiplizieren. Gibt ein wiederverwendetes Objekt zurück: sofort auslesen. */
  function mods(e) {
    var r = D.EXP.ranks[e.rk || 0] || D.EXP.ranks[0];
    MODS.dmg = r.dmg; MODS.hp = r.hp; MODS.rof = r.rof; MODS.psi = r.psi; MODS.regen = r.regen;
    return MODS;
  }
  /** src hat dealt Lebenspunkte Schaden an t verursacht → Erfahrung nach Wert des Ziels (Schadensanteil × Kosten / costDiv). */
  function expGain(src, t, dealt) {
    var E = D.EXP;
    if (!(dealt > 0) || !(t.maxHp > 0) || src.rk == null || !D.expEligible(ust(src))) return;
    var val = t.kind === 'unit' ? (ust(t).cost || 0) : (isWall(t) ? 0 : (D.BUILDINGS[t.type].cost || 0) * E.bldWeight);
    if (!(val > 0)) return;
    expAdd(src, dealt / t.maxHp * val / E.costDiv);
  }
  /** Punkte gutschreiben und ggf. befördern. */
  function expAdd(src, pts) {
    var E = D.EXP;
    src.xp = (src.xp || 0) + pts;
    var r = D.expRank(src.xp);
    if (r > (src.rk || 0)) { src.rk = r; src.rankT = S.tick; if (r === E.ranks.length - 1) S.players[src.owner].st.heroes++; emit('rankup', src.x, src.y, { id: src.id, owner: src.owner, rank: r }); }
  }
  /** Selbstheilung (Rang mit regen > 0) außerhalb des Gefechts. */
  function expRegen(e) {
    if (!e.rk || e.hp >= e.maxHp || e.hp <= 0) return;
    var rg = mods(e).regen;
    if (rg > 0 && S.tick - Math.max(e.fireT, e.lastAtkT || -9999) > D.EXP.regenDelay * HZ) e.hp = Math.min(e.maxHp, e.hp + rg * e.maxHp / HZ);
  }

  // ------------------------------------------------------------------ Schaden / Tod
  function damage(t, amount, src) {
    if (t.dead || t.inside || t.owner < 0) return;
    if (t.neutral && (t.ruin || D.BUILDINGS[t.type].invuln)) return;
    if (src && !(src.owner >= 0)) src = null;
    var xpSrc = src && src.kind === 'unit' && src.owner !== t.owner ? src : null;   // Erfahrung: nur Einheiten, nur gegen Feinde
    if (xpSrc) amount *= mods(xpSrc).dmg;
    if (t.kind === 'unit') amount /= mods(t).hp;
    var hp0 = t.hp;
    t.hp -= amount;
    if (src && (src.clk || src.stealth) && src.owner !== t.owner) { var Pv = S.players[t.owner]; Pv.st.stealthHits = (Pv.st.stealthHits || 0) + 1; Pv.stealthT = S.tick; }   // v1.2: Schaden durch Getarntes (KI baut Detektoren)
    if (G.Sim._onDamage) G.Sim._onDamage(t, Math.min(amount, hp0), src);   // nur Messung (Balance-Serien)
    if (xpSrc) expGain(xpSrc, t, Math.min(amount, hp0));
    var P = S.players[t.owner];
    if (src && src.owner !== t.owner) {
      if (S.tick - P.alert.tick > 20 || (t.kind === 'building') || t.type === 'harvester') {
        P.alert.tick = S.tick; P.alert.x = t.x; P.alert.y = t.y;
        P.alert.harv = t.type === 'harvester'; P.alert.bld = t.kind === 'building';
      }
      if (t.kind === 'unit' && src.id) { t.lastAtk = src.id; t.lastAtkT = S.tick; }
      if (t.type === 'harvester') t.fleeT = S.tick;
    }
    if (t.hp <= 0 && t.neutral) { t.hp = 0; ruinBuilding(t, src); return; }
    if (t.hp <= 0) {
      t.hp = 0;
      if (src) {
        S.players[src.owner].st.kills++;
        if (src.kind === 'unit') src.kills++;
      }
      if (t.kind === 'unit' && t.gar && t.gar.length) {   // v0.7: APC zerstört → Insassen mit 50 % HP heraus
        if (airborne(t)) { for (var gi = 0; gi < t.gar.length; gi++) { var gu = byId.get(t.gar[gi]); if (gu && !gu.dead) killInside(gu, src); } t.gar = []; }   // v0.8: abgeschossen
        else unloadApc(t, D.APC_EJECT_HP, true, src);
      }
      else if (t.gar && t.gar.length) {   // v0.5: Bunker zerstört → Insassen mit 50 % HP heraus
        var occ0 = t.gar.slice();
        ejectAll(t);
        for (var oi = 0; oi < occ0.length; oi++) { var ou = byId.get(occ0[oi]); if (ou && !ou.dead) ou.hp = Math.max(1, Math.min(ou.hp, ou.maxHp * D.RUIN_HP)); }
      }
      emit('die', t.x, t.y, { owner: t.owner, type: t.type, kind: t.kind, id: t.id, w: t.w || 1, h: t.h || 1, src: src && src.id ? src.id : 0 });
      if (t.kind === 'unit') P.st.unitsLost++; else P.st.buildingsLost++;
      removeEntity(t);
    }
  }
  /** Besetzbares Gebäude wird zur Ruine: Insassen kommen mit 50 % HP heraus, Besitzer −1. */
  function ruinBuilding(b, src) {
    if (src && src.owner >= 0 && src.owner !== b.owner) S.players[src.owner].st.kills++;
    b.ruin = true; b.hp = 0;
    var occ = b.gar.slice();
    ejectAll(b);
    for (var i = 0; i < occ.length; i++) {
      var u = byId.get(occ[i]);
      if (u && !u.dead) u.hp = Math.max(1, Math.min(u.hp, u.maxHp * D.RUIN_HP));
    }
    b.owner = -1; b.tgt = 0;
    emit('ruin', b.x, b.y, { id: b.id, type: b.type });
  }
  function removeEntity(e) {
    if (e.dead) return;
    e.dead = true;
    if (e.mcList && e.mcList.length) releaseAll(e, 'lost');   // v1.0: Kontrolleur weg → Einheiten kehren zurück
    if (e.mcBy) unlinkMc(e);
    if (e.kind === 'building') {
      for (var y = e.ty; y < e.ty + e.h; y++) for (var x = e.tx; x < e.tx + e.w; x++) {
        var i = y * S.map.w + x; if (S.occ[i] === e.id) S.occ[i] = 0;
      }
      if (D.BUILDINGS[e.type].isWall && !D.BUILDINGS[e.type].noOcc) G.Path.setWall(e.ty * S.map.w + e.tx, -1);
      if (D.BUILDINGS[e.type].gate) G.Path.setGate(e.ty * S.map.w + e.tx, -1);   // v1.2 Tor
      recalcPower();
    }
  }

  // ------------------------------------------------------------------ Räumliches Gitter
  function buildGrid() {
    gHead.fill(-1);
    gEnts.length = 0;
    for (var i = 0; i < S.ents.length; i++) {
      var e = S.ents[i];
      if (e.dead || e.kind !== 'unit' || e.inside) continue;
      var k = gEnts.length;
      gEnts.push(e);
      if (k >= gNext.length) { var nn = new Int32Array(gNext.length * 2); nn.set(gNext); gNext = nn; }
      var cx = Math.min(gw - 1, Math.max(0, Math.floor(e.x / CELL))), cy = Math.min(gh - 1, Math.max(0, Math.floor(e.y / CELL)));
      var c = cy * gw + cx;
      gNext[k] = gHead[c]; gHead[c] = k;
    }
    if (sepX.length < gEnts.length) { sepX = new Float32Array(gEnts.length * 2); sepY = new Float32Array(gEnts.length * 2); }
  }

  /** Bestes feindliches Ziel für e innerhalb rangePx (nur für e.owner sichtbare). */
  function findTarget(e, x, y, rangePx, preferWeapon, minR, wobj) {
    var best = null, bestS = 1e9, pid = e.owner, P = S.players[pid];
    minR = minR || 0;
    var WP = wobj || (e.kind === 'unit' ? ust(e).weapon : D.BUILDINGS[e.type].weapon);   // v0.8: Luft-/Bodenziel-Regel
    if (WP && WP.psi && mcList(e).length >= WP.psi.safe) return null;   // v1.0: alle (sicheren) Psi-Plätze belegt → kein neues Ziel
    var c0x = Math.max(0, Math.floor((x - rangePx) / CELL)), c1x = Math.min(gw - 1, Math.floor((x + rangePx) / CELL));
    var c0y = Math.max(0, Math.floor((y - rangePx) / CELL)), c1y = Math.min(gh - 1, Math.floor((y + rangePx) / CELL));
    var tfl = flipOf(pid);   // v0.8 Seitengleichheit: Zellen in gespiegelter Reihenfolge (Gleichstände)
    for (var cy0 = c0y; cy0 <= c1y; cy0++) for (var cx0 = c0x; cx0 <= c1x; cx0++) {
      var cy = tfl ? c1y + c0y - cy0 : cy0, cx = tfl ? c1x + c0x - cx0 : cx0;
      for (var k = gHead[cy * gw + cx]; k !== -1; k = gNext[k]) {
        var t = gEnts[k];
        if (t.owner === pid || t.dead) continue;
        if (WP && !canHit(WP, t)) continue;
        var d = distTo(t, x, y);
        if (d > rangePx || d < minR) continue;
        if (!P.vis[tileOf(t.x, t.y)]) continue;
        if (t.clk && hidden(pid, t)) continue;   // v1.2 Tarnung
        var sc = d;
        if (WP && WP.psi) { var pst = ust(t); sc -= Math.min(96, (pst.cost || 0) / 20) + (pst.weapon ? 0 : -64); }   // v1.0: wertvolle, bewaffnete Ziele übernehmen
        else if (preferWeapon) { var tw = ust(t).weapon; if (!tw) sc += 64; else sc -= 16 * (D.DAMAGE[preferWeapon][ust(t).armor] - 0.5); }
        if (sc < bestS) { bestS = sc; best = t; }
      }
    }
    if (best || (WP && (WP.airOnly || WP.psi || WP.navalOnly || WP.vehicleOnly))) return best;   // v1.0: Psi/Torpedo/Magnet nie gegen Gebäude
    // Gebäude
    for (var i0 = 0, nE = S.ents.length; i0 < nE; i0++) {
      var b = S.ents[tfl ? nE - 1 - i0 : i0];
      if (b.kind !== 'building' || b.dead || b.owner === pid || b.owner < 0) continue;
      if (b.neutral && (b.ruin || D.BUILDINGS[b.type].invuln)) continue;
      if (D.BUILDINGS[b.type].isWall && !D.BUILDINGS[b.type].mine) continue;   // v0.5: Mauern nur auf Befehl / bei versperrtem Weg (v1.2: aufgedeckte Minenfelder schon)
      var db = distTo(b, x, y);
      if (db > rangePx || db < minR) continue;
      if (!isVisible(pid, b)) continue;
      var sb = db + (D.BUILDINGS[b.type].defense || (b.neutral && b.gar.length) ? -20 : 0);
      if (sb < bestS) { bestS = sb; best = b; }
    }
    return best;
  }

  // ------------------------------------------------------------------ Kampf
  function fire(e, t, wpn) {
    if (wpn.psi) { firePsi(e, t, wpn); return; }   // v1.0 Gedankenkontrolle (kein Schaden)
    if ((wpn.vehicleOnly || wpn.navalOnly) && !canHit(wpn, t)) return;
    var dmg = wpn.dmg * D.DAMAGE[wpn.type][t.kind === 'building' ? 'building' : ust(t).armor];
    var aux = e.kind === 'unit' && ust(e).aa === wpn, inAir = airborne(t);   // v0.8: Zweitwaffe (Flak) dreht den Turm nicht
    if (e.clk) e.revT = S.tick + D.CLOAK.fireReveal * HZ;   // v1.2 Tarnung: Schuss verrät
    if (!aux) e.fireT = S.tick;
    var ang = Math.atan2(t.y - e.y, t.x - e.x);
    if (!aux) e.tdir = ang;
    var bx = null;
    if (wpn.barrels) { e.barrel = ((e.barrel || 0) + 1) % wpn.barrels; bx = e.barrel; }
    if (wpn.salvo) {
      // v0.7 Raketenwerfer: Salve aus wpn.salvo Raketen, gestaffelt (tickSalvo), erste sofort
      e.salvoN = wpn.salvo; e.salvoI = 0; e.salvoT0 = S.tick; e.salvoX = t.x; e.salvoY = t.y; e.salvoTid = t.id;
      launchSalvoRocket(e, wpn);
    } else if (wpn.type === 'bullet' || wpn.type === 'sniper' || wpn.type === 'melee') {   // v1.0: Nahkampf trifft sofort
      // v0.7: Scharfschütze trifft sofort wie bullet (Ereignis w:'sniper')
      var bev = emit('shot', e.x, e.y, { tx: t.x + (rand() - 0.5) * 8, ty: t.y + (rand() - 0.5) * 8, w: wpn.type, owner: e.owner, src: e.id, tid: t.id });
      if (inAir) bev.air = true;
      if (wpn.spin) { e.spin = Math.min(1, (e.spin || 0) + 0.1); bev.spin = e.spin; }   // v1.0 Gatling dreht hoch
      damage(t, dmg, e);
    } else if (wpn.area) {
      // v0.7 Flammenwerfer: Sofortwirkung an der Zielposition, Flächenschaden (Rand 50 %), Hauptziel immer voll
      var AR = wpn.area * TILE, fx = t.x, fy = t.y;
      emit('shot', e.x, e.y, { tx: fx, ty: fy, w: wpn.type, owner: e.owner, src: e.id, tid: t.id, area: AR });
      damage(t, dmg, e);
      areaDamage(e.owner, fx, fy, AR, e, function (tt, dd) {
        if (tt === t) return 0;
        var arm = tt.kind === 'building' ? 'building' : ust(tt).armor;
        return wpn.dmg * D.DAMAGE[wpn.type][arm] * (1 - 0.5 * Math.min(1, dd / AR));
      });
    } else if (wpn.beam) {
      // v0.5 Laser/Blitz: Treffer sofort. Blitz springt auf bis zu wpn.chain weitere Gegner ≤ chainR Kacheln vom Ziel.
      var ev = { tx: t.x, ty: t.y, w: wpn.type, owner: e.owner, src: e.id, tid: t.id, beam: true };
      var extra = [];
      if (wpn.chain) {
        ev.chain = [];
        extra = chainTargets(e.owner, t, wpn.chainR * TILE, wpn.chain);
        for (var ci = 0; ci < extra.length; ci++) ev.chain.push({ x: extra[ci].x, y: extra[ci].y, id: extra[ci].id });
      }
      if (wpn.vehicleOnly) ev.w = 'magnet';
      emit('shot', e.x, e.y, ev);
      damage(t, dmg, e);
      if (wpn.vehicleOnly && !t.dead) { t.magT = S.tick + Math.round((wpn.hold || 1) * HZ); t.magBy = e.id; }   // v1.0 Magnet hält fest
      if (e.kind === 'unit' && ust(e).drain && t.kind === 'building' && !t.dead) drainBld(e, t, ust(e).drain);   // v1.0 Diskus
      for (ci = 0; ci < extra.length; ci++) {
        var c = extra[ci];
        if (c.dead) continue;
        damage(c, wpn.dmg * (wpn.chainDmg || 0.5) * D.DAMAGE[wpn.type][c.kind === 'building' ? 'building' : ust(c).armor], e);
      }
    } else if (wpn.splash) {
      // v0.4 Haubitze: ballistische Granate auf die Zielposition (nicht zielsuchend), Flächenschaden
      var dd = Math.sqrt((t.x - e.x) * (t.x - e.x) + (t.y - e.y) * (t.y - e.y));
      S.proj.push({ x0: e.x, y0: e.y, x: e.x, y: e.y, tx: t.x, ty: t.y, tid: 0, t: 0, dur: Math.max(4, Math.round(dd / 13)), w: wpn.type,
                    dmg: dmg, owner: e.owner, src: e.id, arc: true, sp: wpn.splash * TILE, raw: wpn.dmg, wt: wpn.type });
      emit('shot', e.x, e.y, { tx: t.x, ty: t.y, w: wpn.type, owner: e.owner, src: e.id, arc: true });
    } else {
      var d = Math.sqrt((t.x - e.x) * (t.x - e.x) + (t.y - e.y) * (t.y - e.y));
      var speed = wpn.type === 'rocket' ? 9 : (wpn.type === 'flak' ? 20 : (wpn.type === 'torpedo' ? 8 : 16)); // px/tick (v1.0 Torpedo langsam)
      var pj = { x0: e.x, y0: e.y, x: e.x, y: e.y, tx: t.x, ty: t.y, tid: t.id, t: 0,
                 dur: Math.max(2, Math.round(d / speed)), w: wpn.type, dmg: dmg, owner: e.owner, src: e.id };
      if (inAir) pj.air = true;
      S.proj.push(pj);
      var sx = { tx: t.x, ty: t.y, w: wpn.type, owner: e.owner, src: e.id };
      if (bx !== null) sx.barrel = bx;
      if (inAir) sx.air = true;
      if (aux) { sx.aux = true; sx.tid = t.id; }
      emit('shot', e.x, e.y, sx);
    }
  }
  /** v0.5 Kettenblitz: bis zu n weitere sichtbare Gegner (Einheiten, dann Gebäude ohne Mauern) im Umkreis R px um t, nächste zuerst. */
  function chainTargets(pid, t, R, n) {
    var c = [], P = S.players[pid];
    for (var i = 0; i < S.ents.length; i++) {
      var o = S.ents[i];
      if (o === t || !hostile(pid, o) || isWall(o) || airborne(o)) continue;
      var d = distTo(o, t.x, t.y);
      if (d > R) continue;
      if (o.kind === 'unit' ? (!P.vis[tileOf(o.x, o.y)] || (o.clk && hidden(pid, o))) : !isVisible(pid, o)) continue;
      c.push({ e: o, s: d + (o.kind === 'building' ? 1e6 : 0) });
    }
    c.sort(function (a, b) { return a.s - b.s || a.e.id - b.e.id; });
    var r = [];
    for (i = 0; i < c.length && r.length < n; i++) r.push(c[i].e);
    return r;
  }
  function tickProjectiles() {
    for (var i = S.proj.length - 1; i >= 0; i--) {
      var p = S.proj[i];
      var t = byId.get(p.tid);
      if (t && !t.dead && !t.inside) { p.tx = t.x; p.ty = t.y; }
      p.t++;
      var f = p.t / p.dur;
      p.x = p.x0 + (p.tx - p.x0) * f; p.y = p.y0 + (p.ty - p.y0) * f;
      if (p.t >= p.dur) {
        if (p.sp) {
          emit('hit', p.tx, p.ty, { w: p.w, owner: p.owner, splash: p.sp });
          var pss = byId.get(p.src), psrc = pss && !pss.dead && pss.owner === p.owner ? pss : { owner: p.owner, kind: 'x' };
          areaDamage(p.owner, p.tx, p.ty, p.sp, psrc, function (tt, dd) {
            var arm = tt.kind === 'building' ? 'building' : ust(tt).armor;
            return p.raw * D.DAMAGE[p.wt][arm] * (1 - 0.5 * Math.min(1, dd / p.sp));
          });
          S.proj.splice(i, 1);
          continue;
        }
        emit('hit', p.tx, p.ty, { w: p.w, owner: p.owner });
        if (hostile(p.owner, t)) {
          var ps = byId.get(p.src);
          damage(t, p.dmg, ps && !ps.dead && ps.owner === p.owner ? ps : { owner: p.owner, kind: 'x' });
        }
        S.proj.splice(i, 1);
      }
    }
  }
  function turnTo(a, b, rate) {
    var d = b - a;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    if (d > rate) return a + rate; if (d < -rate) return a - rate;
    return b;
  }
  function angDiff(a, b) {
    var d = b - a;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return Math.abs(d);
  }

  function tickDefense(b) {
    var d = D.BUILDINGS[b.type];
    if (!d.weapon) return;
    if (b.mcList) mcList(b);   // v1.0 Psi-Turm: Liste aufräumen
    if (b.cd > 0) b.cd--;
    if (d.noFireLowPower && lowPower(b.owner)) { b.tgt = 0; return; }   // v0.5 Laser/Blitz: bei Energiemangel kein Feuer
    if (b.offT > S.tick) { b.tgt = 0; return; }   // v1.2: vom Saboteur lahmgelegt
    var t = b.tgt ? byId.get(b.tgt) : null, rangePx = d.weapon.range * TILE;
    if (!hostile(b.owner, t) || distTo(t, b.x, b.y) > rangePx || !isVisible(b.owner, t) || !canHit(d.weapon, t)) {
      b.tgt = 0; t = null;
      if ((S.tick + b.id) % 5 === 0) { t = findTarget(b, b.x, b.y, rangePx, d.weapon.type); if (t) b.tgt = t.id; }
    }
    if (t) {
      var ang = Math.atan2(t.y - b.y, t.x - b.x);
      b.tdir = turnTo(b.tdir, ang, 0.25);
      if (b.cd <= 0 && angDiff(b.tdir, ang) < 0.3) {
        fire(b, t, d.weapon); b.tdir = ang;
        b.cd = Math.round(d.weapon.rof * HZ * (lowPower(b.owner) ? 2 : 1));
      }
    }
  }

  // ------------------------------------------------------------------ Bewegung
  /** Bewegt e entlang seines Pfades. Gibt true zurück, wenn das Ziel erreicht ist. */
  function followPath(e, st) {
    if (e.mc === 2) return flyStep(e, st);   // v0.8: Luftfahrzeuge fliegen direkt
    if (e.pp) { e.moving = false; return false; }
    if (!e.path) { G.Path.request(S, e); e.moving = false; return false; }
    if (e.repathT >= 0) { e.repathT = -1; G.Path.request(S, e); }
    var w = S.map.w, wx, wy, final = false;
    // Pfadglättung: so weit wie möglich vorausspringen (Sichtlinie)
    if (e.pi < e.path.length - 1 && (S.tick + e.id) % 4 === 0) {
      for (var look = Math.min(e.path.length - 1, e.pi + 4); look > e.pi; look--) {
        var li = e.path[look];
        if (G.Path.los(pcOf(e), e.x, e.y, (li % w + 0.5) * TILE, (Math.floor(li / w) + 0.5) * TILE, e.r * 0.8, e.owner)) { e.pi = look; break; }
      }
    }
    if (e.pi >= e.path.length) { wx = e.gx; wy = e.gy; final = true; }
    else {
      var ti = e.path[e.pi];
      if (!G.Path.passable(pcOf(e), ti, e.owner)) {
        // v0.5: Durchbruchspfad – gegnerische Mauer versperrt den Weg → bewaffnete Einheit beschießt das Segment
        var wb = S.occ[ti] ? byId.get(S.occ[ti]) : null;
        if (wb && isWall(wb) && hostile(e.owner, wb) && st.weapon) { e.breach = wb.id; e.moving = false; return false; }
        G.Path.request(S, e); e.moving = false; return false; // blockiert
      }
      if (e.pi === e.path.length - 1 && e.pend) { wx = e.gx; wy = e.gy; final = true; }
      else { wx = (ti % w + 0.5) * TILE; wy = (Math.floor(ti / w) + 0.5) * TILE; final = e.pi === e.path.length - 1; }
    }
    var dx = wx - e.x, dy = wy - e.y, dist = Math.sqrt(dx * dx + dy * dy);
    var spd = st.speed * TILE / HZ;
    if (e.mc === 1) {
      var tt = S.map.terrain[tileOf(e.x, e.y)];
      if (D.TERRAIN[tt].wheelSpeed) spd *= D.TERRAIN[tt].wheelSpeed;
    }
    if (dist < (final ? 2 : Math.max(spd, 6))) {
      if (final) { e.moving = false; return true; }
      e.pi++;
      return false;
    }
    var ang = Math.atan2(dy, dx);
    if (e.mc === 1 || e.mc === 3) {   // v0.8: Schiffe drehen wie Fahrzeuge
      e.dir = turnTo(e.dir, ang, e.mc === 3 ? 0.16 : 0.22);
      if (angDiff(e.dir, ang) > 1.0) { e.moving = true; return false; } // erst drehen
    } else e.dir = ang;
    var step = Math.min(spd, dist);
    moveBy(e, dx / dist * step, dy / dist * step);
    e.moving = true;
    return false;
  }
  /** Verschiebt e, gleitet an Hindernissen entlang. */
  function moveBy(e, mx, my) {
    var nx = e.x + mx, ny = e.y + my;
    var pc = pcOf(e);
    var ow = e.owner;   // v1.2: eigene Tore sind passierbar
    if (G.Path.passablePx(pc, nx, ny, ow)) { e.x = nx; e.y = ny; return true; }
    if (G.Path.passablePx(pc, nx, e.y, ow)) { e.x = nx; return true; }
    if (G.Path.passablePx(pc, e.x, ny, ow)) { e.y = ny; return true; }
    return false;
  }

  /** Stuck-Erkennung für bewegende Einheiten. Gibt true zurück, wenn aufgegeben/angekommen. */
  function checkStuck(e) {
    if ((S.tick + e.id) % 20 !== 0) return false;
    var dx = e.x - e.lastX, dy = e.y - e.lastY;
    e.lastX = e.x; e.lastY = e.y;
    if (e.pp || !e.moving) return false;
    if (dx * dx + dy * dy > 36) { e.stuck = 0; return false; }
    e.stuck++;
    var gd = Math.sqrt((e.gx - e.x) * (e.gx - e.x) + (e.gy - e.y) * (e.gy - e.y));
    if (gd < TILE * (1.5 + e.stuck * 0.5)) return true;   // nah genug (Gedränge am Ziel)
    if (e.stuck >= 2) { e.giveUp++; G.Path.request(S, e); }
    if (e.giveUp >= 5) return true;
    return false;
  }

  function separation() {
    var n = gEnts.length;
    for (var i = 0; i < n; i++) { sepX[i] = 0; sepY[i] = 0; }
    for (i = 0; i < n; i++) {
      var a = gEnts[i];
      var cx = Math.floor(a.x / CELL), cy = Math.floor(a.y / CELL);
      for (var oy = -1; oy <= 1; oy++) {
        var yy = cy + oy; if (yy < 0 || yy >= gh) continue;
        for (var ox = -1; ox <= 1; ox++) {
          var xx = cx + ox; if (xx < 0 || xx >= gw) continue;
          for (var k = gHead[yy * gw + xx]; k !== -1; k = gNext[k]) {
            if (k <= i) continue;
            var b = gEnts[k];
            if (a.mc !== b.mc && (a.mc >= 2 || b.mc >= 2)) continue;          // v0.8: Luft, Wasser, Boden getrennt
            if (a.mc === 2 && (a.alt < 0.5 || b.alt < 0.5)) continue;          // v0.8: gelandete Luftfahrzeuge (Landeplätze) nicht schieben
            var dx = b.x - a.x, dy = b.y - a.y, rr = a.r + b.r;
            if (a.mc === 0 && b.mc === 0) rr *= 0.8;   // Infanterie darf enger stehen
            var d2 = dx * dx + dy * dy;
            if (d2 >= rr * rr) continue;
            var d = Math.sqrt(d2), ux, uy;
            if (d < 0.01) { var an = ((a.id * 7919 + b.id) % 628) / 100; ux = Math.cos(an); uy = Math.sin(an); d = 0; }
            else { ux = dx / d; uy = dy / d; }
            var ov = (rr - d);
            // Gewichtung: Bewegende drängen Stehende stärker weg
            var wa = 0.5, wb = 0.5;
            var am = a.moving, bm = b.moving;
            if (am && !bm) { wa = 0.15; wb = 0.85; } else if (!am && bm) { wa = 0.85; wb = 0.15; }
            if (a.hs === 'mine' || a.hs === 'unload') { wa *= 0.3; } if (b.hs === 'mine' || b.hs === 'unload') { wb *= 0.3; }
            var push = Math.min(ov, 4) * 0.5;
            sepX[i] -= ux * push * wa * 2; sepY[i] -= uy * push * wa * 2;
            sepX[k] += ux * push * wb * 2; sepY[k] += uy * push * wb * 2;
          }
        }
      }
    }
    for (i = 0; i < n; i++) {
      if (sepX[i] !== 0 || sepY[i] !== 0) moveBy(gEnts[i], sepX[i], sepY[i]);
    }
  }

  // ------------------------------------------------------------------ Einheiten-Logik
  /** Fahrzeuge mit Turm: Turm verfolgt Ziele in Reichweite unabhängig von der Wanne und schießt in der Fahrt. */
  function turretFire(e, st, aim) {
    var wpn = st.weapon;
    if (!st.turret || !wpn) { if (aim) e.tdir = turnTo(e.tdir, Math.atan2(aim.y - e.y, aim.x - e.x), 0.2); else e.tdir = turnTo(e.tdir, e.dir, 0.2); return; }
    if (st.setup) { e.ftgt = 0; e.tdir = turnTo(e.tdir, aim ? Math.atan2(aim.y - e.y, aim.x - e.x) : e.dir, 0.15); return; } // Haubitze: nur stehend
    var rangePx = wpn.range * TILE;
    var t = e.ftgt ? byId.get(e.ftgt) : null;
    if (t && (!hostile(e.owner, t) || distTo(t, e.x, e.y) > rangePx || !isVisible(e.owner, t) || !canHit(wpn, t))) { t = null; e.ftgt = 0; }
    if (!t && (S.tick + e.id) % 6 === 0) { t = findTarget(e, e.x, e.y, rangePx, wpn.type); e.ftgt = t ? t.id : 0; }
    if (!t) { e.tdir = turnTo(e.tdir, aim ? Math.atan2(aim.y - e.y, aim.x - e.x) : e.dir, 0.2); return; }
    var ang = Math.atan2(t.y - e.y, t.x - e.x);
    e.tdir = turnTo(e.tdir, ang, 0.25);
    if (e.cd <= 0 && angDiff(e.tdir, ang) < 0.3) { fire(e, t, wpn); e.cd = reloadT(wpn, e); }
  }

  function engage(e, st, t) {
    var wpn = st.weapon, rangePx = wpn.range * TILE;
    var d = distTo(t, e.x, e.y);
    if (wpn.minRange && d < wpn.minRange * TILE) {
      // v0.4 Haubitze: zu nah. Expliziter Angriff → Abstand gewinnen; sonst Ziel aufgeben (anderes suchen)
      if (e.ord === 'attack') {
        if (!e.path || (S.tick + e.id) % 20 === 0) {
          var ax = e.x - t.x, ay = e.y - t.y, al = Math.sqrt(ax * ax + ay * ay) || 1, back = (wpn.minRange + 2) * TILE;
          var bi = G.Path.nearestPassable(pcOf(e), Math.floor((t.x + ax / al * back) / TILE), Math.floor((t.y + ay / al * back) / TILE), 4);
          if (bi >= 0 && !e.pp) { e.gx = (bi % S.map.w + 0.5) * TILE; e.gy = (Math.floor(bi / S.map.w) + 0.5) * TILE; e.path = null; G.Path.request(S, e); }
        }
        turretFire(e, st, t);
        followPath(e, st);
      } else { e.tgt = 0; e.chase = false; }
      return;
    }
    if (d <= rangePx) {
      e.ftgt = 0;
      e.moving = false; e.path = null; e.pp = false;
      var ang = Math.atan2(t.y - e.y, t.x - e.x);
      e.tdir = turnTo(e.tdir, ang, st.setup ? 0.15 : 0.3);
      if (e.mc === 0) e.dir = ang;
      else if (e.mc === 2) e.dir = turnTo(e.dir, ang, 0.25);   // v0.8 Kampfhubschrauber dreht zum Ziel
      if (st.setup && e.setup < 1) { e.setup = Math.min(1, e.setup + DT / st.setup); return; } // Aufbauen (1 s)
      if (e.cd <= 0 && (!st.setup || angDiff(e.tdir, ang) < 0.3)) { fire(e, t, wpn); e.cd = reloadT(wpn, e); }
      return;
    }
    // hinterherfahren
    var moved2 = (e.gx - t.x) * (e.gx - t.x) + (e.gy - t.y) * (e.gy - t.y);
    if (!e.path || (moved2 > 4 * TILE * TILE && (S.tick + e.id) % 10 === 0)) {
      if (!e.pp) { e.gx = t.x; e.gy = t.y; e.path = null; G.Path.request(S, e); }
    }
    turretFire(e, st, t);
    if (followPath(e, st)) { e.path = null; }
  }

  function tickUnit(e) {
    var st = ust(e);
    e.px = e.x; e.py = e.y;
    if (e.cd > 0) e.cd--;
    expRegen(e);                                                                 // Erfahrung: Selbstheilung (Held)
    if (e.magT > S.tick && tickHeld(e)) return;                                  // v1.0: vom Magnet-Werfer festgehalten
    if (e.mcList && e.mcList.length && tickPsiCtl(e, st)) return;               // v1.0: Gedankenkontrolle (Überlastung)
    if (e.spin > 0 && S.tick - e.fireT > 20) e.spin = Math.max(0, e.spin - 0.025);   // v1.0 Gatling kühlt ab
    if (e.mc === 2) { if (st.bomber) { tickBomber(e, st); return; } airPre(e, st); }   // v0.8 Luftfahrzeuge
    if (st.aa) tickAA(e, st);                                                          // v0.8 Flak (Zerstörer)
    if (st.harvester) {
      if (e.ord === 'recycle') { tickRecycle(e, st); return; }   // v1.0
      if (e.ord === 'harvest') { tickHarvester(e, st); }
      else if (e.ord === 'move') { if (followPath(e, st) || checkStuck(e)) { orderStop(e); } }
      else orderStop(e);
      return;
    }
    var t = e.tgt ? byId.get(e.tgt) : null;
    if (t && (!hostile(e.owner, t) || (st.weapon && !canHit(st.weapon, t)) || (t.clk && hidden(e.owner, t)))) { t = null; e.tgt = 0; }   // v0.8: Luftziele nur mit Flugabwehr; v1.2: Getarntes verliert sich
    if (st.saboteur && e.ord === 'sab') { tickSab(e, st); return; }   // v1.2 Saboteur
    var sightPx = st.sight * TILE;
    if (e.gar) syncPassengers(e);                       // v0.7 Schützenpanzer: Insassen fahren mit
    if (e.salvoN > 0) tickSalvo(e, st);                 // v0.7 Raketensalve läuft
    var healing = st.medic ? tickMedic(e, st) : false;  // v0.7 Sanitäter heilt in jedem Zustand
    if (e.breach && tickBreach(e, st, t)) return;
    if (!st.weapon && e.ord !== 'recycle') { // v0.4: unbewaffnet (Ingenieur): nur bewegen/betreten
      t = null; e.tgt = 0;
      if (e.ord === 'amove') e.ord = 'move';
      else if (e.ord === 'attack') orderStop(e);
    }
    switch (e.ord) {
      case 'load': {   // v0.7: zum Schützenpanzer laufen und einsteigen
        var ap = byId.get(e.loadId);
        if (loadBlock(e.owner, ap)) { orderStop(e); break; }
        var dd = Math.sqrt(dist2(e.x, e.y, ap.x, ap.y)) - ap.r - e.r, bdist = boardDist(ap);
        if (dd <= bdist) { if (canBoardNow(ap)) boardApc(e, ap); else { e.moving = false; e.path = null; e.pp = false; } break; }   // v0.8: Hubschrauber setzt noch auf
        if (!e.pp && (S.tick + e.id) % 10 === 0 && dist2(e.gx, e.gy, ap.x, ap.y) > TILE * TILE) { e.gx = ap.x; e.gy = ap.y; e.path = null; G.Path.request(S, e); }
        if (followPath(e, st) || checkStuck(e)) {
          if (dd <= TILE + bdist) { if (canBoardNow(ap)) boardApc(e, ap); }
          else if ((e.loadTry = (e.loadTry || 0) + 1) <= 8) { e.gx = ap.x; e.gy = ap.y; e.path = null; e.stuck = 0; e.giveUp = 0; G.Path.request(S, e); }
          else orderStop(e);
        }
        break;
      }
      case 'drop':   // v0.8: Transporter fährt/fliegt zum Absetzpunkt und lädt dort aus
        tickDrop(e, st);
        break;
      case 'recycle':   // v1.0 Kollektiv: zum eigenen Erzwandler fahren und dort recyceln
        tickRecycle(e, st);
        break;
      case 'move':
        if (st.turret) turretFire(e, st, null);
        if (followPath(e, st) || checkStuck(e)) orderStop(e);
        break;
      case 'enter': {
        var eb = byId.get(e.enterId);
        if (!eb || blockFor(e, eb)) { orderStop(e); break; }
        if (distTo(eb, e.x, e.y) <= TILE * 0.7 + e.r) { arriveEnter(e, eb); break; }
        if (followPath(e, st) || checkStuck(e)) {
          if (distTo(eb, e.x, e.y) <= TILE * 1.6) arriveEnter(e, eb);
          else if ((e.enterTry = (e.enterTry || 0) + 1) <= 4) orderEnter(e, eb); // anderen Eingang versuchen
          else { e.enterTry = 0; orderStop(e); }
        }
        break;
      }
      case 'attack':
        if (!t) { orderStop(e); break; }
        engage(e, st, t);
        break;
      case 'amove':
        if (t && !isVisible(e.owner, t)) { t = null; e.tgt = 0; }
        if (!t && (S.tick + e.id) % 6 === 0) {
          t = findTarget(e, e.x, e.y, Math.max(sightPx, st.weapon.range * TILE), st.weapon.type, minPx(st));
          if (t) { e.tgt = t.id; e.path = null; e.pp = false; e.amx = e.gx; e.amy = e.gy; }
        }
        if (t) { engage(e, st, t); break; }
        if (e.amx !== undefined && e.amx !== null) { e.gx = e.amx; e.gy = e.amy; e.amx = null; e.path = null; G.Path.request(S, e); }
        if (st.turret) turretFire(e, st, null);
        if (followPath(e, st) || checkStuck(e)) orderStop(e);
        break;
      default: // idle
        if (st.medic) { medicIdle(e, st, healing); break; }   // v0.7
        if (!st.weapon) { e.moving = false; e.hx = e.x; e.hy = e.y; break; }
        if (t && (!(isVisible(e.owner, t) || (t.id === e.retal && S.tick - e.lastAtkT < 60)) || (e.chase && dist2(e.x, e.y, e.hx, e.hy) > Math.pow(sightPx + 3 * TILE, 2)))) {
          // Leine: zurück zur Ausgangsposition
          e.tgt = 0; t = null;
          if (e.chase) { e.chase = false; orderMove(e, e.hx, e.hy, 'move'); break; }
        }
        if (!t && (S.tick + e.id) % 8 === 0) {
          t = findTarget(e, e.x, e.y, Math.max(sightPx, st.weapon.minRange ? st.weapon.range * TILE : 0), st.weapon.type, minPx(st));
          if (!t && e.lastAtk) {
            // Erwidern – auch auf (noch) unsichtbare Schützen, die gerade getroffen haben (z. B. Raketen R6 > Sicht 5)
            var la = byId.get(e.lastAtk);
            if (hostile(e.owner, la) && canHit(st.weapon, la) && (isVisible(e.owner, la) || S.tick - (e.lastAtkT || 0) < 60) &&
                distTo(la, e.x, e.y) < sightPx + 4 * TILE) { t = la; e.retal = la.id; }
          }
          e.lastAtk = 0;
          if (t) { e.tgt = t.id; e.chase = true; e.path = null; e.pp = false; }
        }
        if (t) engage(e, st, t);
        else {
          e.moving = false;
          if ((S.tick + e.id) % 8 === 0) e.chase = false;
          if (!e.chase) { e.hx = e.x; e.hy = e.y; }
          e.tdir = turnTo(e.tdir, e.dir, 0.1);
        }
    }
    if (st.setup && e.moving) e.setup = 0;   // Haubitze: Fahrt beendet den Aufbau
  }
  /** v0.5: Einheit e beschießt die gegnerische Mauer e.breach, die ihren Pfad versperrt. true = Tick erledigt.
   *  Ein echtes Ziel in Waffenreichweite (Angriffsziel bzw. bei Angriff-Bewegen/untätig ein sichtbarer Gegner) hat Vorrang. */
  function tickBreach(e, st, t) {
    var wb = byId.get(e.breach), wpn = st.weapon;
    if (!wb || wb.dead || !hostile(e.owner, wb) || !wpn || !canHit(wpn, wb)) { e.breach = 0; return false; }   // v1.0: Psi/Magnet/Torpedo brechen nicht durch
    var rangePx = wpn.range * TILE;
    if (t && distTo(t, e.x, e.y) <= rangePx) { e.breach = 0; return false; }
    if ((e.ord === 'amove' || e.ord === 'idle') && (S.tick + e.id) % 6 === 0) {
      var ft = findTarget(e, e.x, e.y, rangePx, wpn.type, minPx(st));
      if (ft) { e.breach = 0; e.tgt = ft.id; if (e.ord === 'amove') { e.amx = e.gx; e.amy = e.gy; } return false; }
    }
    var d = distTo(wb, e.x, e.y);
    if (d > rangePx + TILE) { e.breach = 0; return false; }   // Pfad führt woanders hin
    e.moving = false;
    var ang = Math.atan2(wb.y - e.y, wb.x - e.x);
    e.tdir = turnTo(e.tdir, ang, 0.3);
    if (e.mc === 0) e.dir = ang;
    if (wpn.minRange && d < wpn.minRange * TILE) return true;   // Haubitze zu nah: warten (andere brechen durch)
    if (st.setup && e.setup < 1) { e.setup = Math.min(1, e.setup + DT / st.setup); return true; }
    if (e.cd <= 0 && angDiff(e.tdir, ang) < 0.3) { fire(e, wb, wpn); e.cd = reloadT(wpn, e); }
    return true;
  }
  /** v0.7: Insassen eines APC stehen (unsichtbar) an dessen Position. */
  function syncPassengers(a) {
    for (var i = a.gar.length - 1; i >= 0; i--) {
      var u = byId.get(a.gar[i]);
      if (!u || u.dead || u.inside !== a.id) { a.gar.splice(i, 1); continue; }
      u.px = u.x = a.x; u.py = u.y = a.y;
    }
  }
  function minPx(st) { return st.weapon && st.weapon.minRange ? st.weapon.minRange * TILE : 0; }
  function reloadT(w, e) { var rof = w.spin && e ? w.rof + (w.spin.min - w.rof) * (e.spin || 0) : w.rof; if (e && e.kind === 'unit') rof *= w.psi ? mods(e).psi : mods(e).rof; return Math.round(rof * HZ / (w.barrels || 1)); }   // v1.0: Gatling-Hochdrehen
  function dist2(ax, ay, bx, by) { return (ax - bx) * (ax - bx) + (ay - by) * (ay - by); }

  // ------------------------------------------------------------------ Sammler
  function findOre(e, ax, ay) {
    var w = S.map.w, best = -1, bestS = 1e12, fl = flipOf(e.owner), nT = oreTiles.length;
    // Andrang: andere Sammler, die dieselbe Kachel ansteuern
    for (var i0 = 0; i0 < nT; i0++) {
      var ti = oreTiles[fl ? nT - 1 - i0 : i0];   // v0.8: Gleichstand gespiegelt
      if (S.map.ore[ti] < 40) continue;
      var tx = (ti % w + 0.5) * TILE, ty = (Math.floor(ti / w) + 0.5) * TILE;
      var s = dist2(tx, ty, ax, ay);
      if (s >= bestS) continue;
      // Kachel belegt von anderem Sammler?
      var taken = false;
      for (var k = 0; k < S.ents.length; k++) {
        var o = S.ents[k];
        if (o !== e && o.kind === 'unit' && o.oreT === ti && o.ord === 'harvest' && (o.hs === 'go' || o.hs === 'mine')) { taken = true; break; }
      }
      if (taken) s += 3 * TILE * 3 * TILE;
      if (s < bestS) { bestS = s; best = ti; }
    }
    return best;
  }
  function nearestRefinery(e) {
    var best = null, bd = 1e12;
    for (var i = 0; i < S.ents.length; i++) {
      var b = S.ents[i];
      if (b.kind !== 'building' || b.dead || b.owner !== e.owner || b.type !== 'refinery') continue;
      var d = dist2(b.x, b.y, e.x, e.y);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }
  /** v0.8 Seitengleichheit: Startplatz in der „zweiten“ Kartenhälfte (unten rechts)? Dann Gleichstände gespiegelt auflösen. */
  function flipOf(pid) {
    var st = S.map.starts && S.map.starts[pid];
    return !!st && (st.tx + st.ty + 3) * 2 > S.map.w + S.map.h;
  }
  function startReturn(e) {
    var r = (e.refId && byId.get(e.refId)) || nearestRefinery(e);
    if (!r || r.dead || r.owner !== e.owner) { r = nearestRefinery(e); }
    if (!r) { e.hs = 'wait'; e.moving = false; return; }
    e.refId = r.id;
    // v0.8 Seitengleichheit: Andockseite (Süd/Nord) die dem Sammler zugewandte – vorher immer Süd, d. h. die südliche Basis fuhr
    // bei Erz zwischen den Basen jedes Mal um die Raffinerie herum (P0-Vorteil ≈ 15–25 % Erz)
    var south = (r.ty + r.h + 0.5) * TILE, north = (r.ty - 0.5) * TILE, fl = flipOf(e.owner);
    var dS = Math.abs(e.y - south), dN = Math.abs(e.y - north), useN = fl ? dN <= dS : dN < dS;
    var sx = r.tx + 1, nx = r.tx + r.w - 2;
    var ti = useN ? G.Path.nearestPassable(1, nx, r.ty - 1, 4, true) : G.Path.nearestPassable(1, sx, r.ty + r.h, 4, false);
    if (ti < 0) ti = useN ? G.Path.nearestPassable(1, sx, r.ty + r.h, 4, false) : G.Path.nearestPassable(1, nx, r.ty - 1, 4, true);
    if (ti < 0) { e.hs = 'wait'; return; }
    setGoal(e, (ti % S.map.w + 0.5) * TILE, (Math.floor(ti / S.map.w) + 0.5) * TILE);
  }
  function tickHarvester(e, st) {
    var w = S.map.w, P = S.players[e.owner];
    // v0.3: unter Beschuss → zur Raffinerie fliehen (mit Teilladung), danach weitermachen
    if (S.tick - e.fleeT < 5 && (e.hs === 'go' || e.hs === 'mine' || e.hs === 'seek' || e.hs === 'idle')) {
      e.hs = 'ret'; e.refId = 0; startReturn(e);
      if (e.hs === 'wait') e.hs = 'seek';
      else emit('flee', e.x, e.y, { id: e.id, owner: e.owner });
    }
    switch (e.hs) {
      case 'seek': {
        if ((S.tick + e.id) % 5 !== 0) { e.moving = false; return; }
        var ax = e.x, ay = e.y;
        if (e.oreT >= 0) { ax = (e.oreT % w + 0.5) * TILE; ay = (Math.floor(e.oreT / w) + 0.5) * TILE; }
        var ti = findOre(e, ax, ay);
        if (ti < 0) { e.hs = 'idle'; e.moving = false; return; }
        e.oreT = ti; e.hs = 'go';
        setGoal(e, (ti % w + 0.5) * TILE, (Math.floor(ti / w) + 0.5) * TILE);
        break;
      }
      case 'go': {
        if (S.map.ore[e.oreT] <= 0) { e.hs = 'seek'; return; }
        var arrived = followPath(e, st);
        if (!arrived && checkStuck(e)) {
          arrived = tileOf(e.x, e.y) === e.oreT || S.map.ore[tileOf(e.x, e.y)] > 0;
          if (!arrived) { e.hs = 'seek'; e.oreT = -1; return; }
        }
        if (arrived) {
          var here = tileOf(e.x, e.y);
          if (S.map.ore[here] > 0) e.oreT = here;
          e.hs = 'mine'; e.moving = false; e.mineT = 0;
        }
        break;
      }
      case 'mine': {
        e.moving = false;
        var amt = D.ORE_RATE / HZ;
        var cap = st.capacity;
        var o = S.map.ore[e.oreT];
        if (o <= 0) {
          // benachbarte Erz-Kachel suchen
          var nb = -1, cx = e.oreT % w, cy = Math.floor(e.oreT / w), bd = 1e9, fo = flipOf(e.owner) ? -1 : 1;
          for (var y0 = -2; y0 <= 2; y0++) for (var x0 = -2; x0 <= 2; x0++) {
            var yy = cy + y0 * fo, xx = cx + x0 * fo;   // v0.8: Gleichstand gespiegelt
            if (xx < 0 || yy < 0 || xx >= w || yy >= S.map.h) continue;
            var ni = yy * w + xx;
            if (S.map.ore[ni] > 20 && G.Path.passable(1, ni)) { var dd = (xx - cx) * (xx - cx) + (yy - cy) * (yy - cy); if (dd < bd) { bd = dd; nb = ni; } }
          }
          if (nb >= 0 && e.cargo < cap) { e.oreT = nb; e.hs = 'go'; setGoal(e, (nb % w + 0.5) * TILE, (Math.floor(nb / w) + 0.5) * TILE); }
          else if (e.cargo > 0) { e.hs = 'ret'; startReturn(e); }
          else e.hs = 'seek';
          return;
        }
        var take = Math.min(amt, o, cap - e.cargo);
        // Erz in ganzen Einheiten verwalten
        e.mineT = (e.mineT || 0) + take;
        var whole = Math.floor(e.mineT);
        if (whole > 0) { e.mineT -= whole; S.map.ore[e.oreT] = Math.max(0, o - whole); e.cargo += whole; }
        if (e.cargo >= cap) { e.cargo = cap; e.hs = 'ret'; startReturn(e); }
        break;
      }
      case 'ret': {
        var r = byId.get(e.refId);
        if (!r || r.dead) { startReturn(e); if (e.hs === 'wait') return; r = byId.get(e.refId); }
        if (distTo(r, e.x, e.y) < TILE * 0.9 + e.r) { e.hs = 'unload'; e.moving = false; e.path = null; e.pp = false; return; }
        var arr = followPath(e, st);
        if (arr || checkStuck(e)) {
          if (distTo(r, e.x, e.y) < TILE * 1.6 + e.r) { e.hs = 'unload'; e.moving = false; }
          else if (arr || e.giveUp >= 5) startReturn(e);
        }
        break;
      }
      case 'unload': {
        e.moving = false;
        var rr = byId.get(e.refId);
        if (!rr || rr.dead) { e.hs = 'ret'; startReturn(e); return; }
        var u = Math.min(e.cargo, D.UNLOAD_RATE / HZ);
        // v1.2 Erzlager: nur so viel abladen, wie ins Lager passt – ist es voll, wartet der Sammler (P.capFullT = Tick, für Anzeige/KI)
        if (!P.cheat) { var room = (P.oreCap || 0) - P.credits; if (u * P.oreMul > room) { u = Math.max(0, room / P.oreMul); P.capFullT = S.tick; P.st.capWait = (P.st.capWait || 0) + 1; } }
        e.cargo -= u;
        var gain = u * P.oreMul;
        P.credits += gain; P.st.ore += gain;
        if (e.cargo <= 0.001) { e.cargo = 0; e.hs = S.tick - e.fleeT < D.HARV_HIDE * HZ ? 'hide' : 'seek'; }
        break;
      }
      case 'hide': { // nach Flucht: an der Raffinerie warten, bis D.HARV_HIDE s Ruhe ist
        e.moving = false;
        if (S.tick - e.fleeT >= D.HARV_HIDE * HZ) e.hs = 'seek';
        break;
      }
      case 'wait':
        e.moving = false;
        if ((S.tick + e.id) % 40 === 0) { if (e.cargo > 0) { e.hs = 'ret'; startReturn(e); } else e.hs = 'seek'; }
        break;
      default: // 'idle' – kein Erz gefunden
        e.moving = false;
        if ((S.tick + e.id) % 100 === 0) e.hs = e.cargo > 0 ? 'ret' : 'seek';
        if (e.hs === 'ret') startReturn(e);
    }
  }

  // ------------------------------------------------------------------ Nebel
  function updateFogFor(P) {
    var vis = P.vis, exp = P.exp, w = S.map.w, h = S.map.h;
    vis.fill(0);
    for (var i = 0; i < S.ents.length; i++) {
      var e = S.ents[i];
      if (e.dead || e.owner !== P.id || e.inside) continue;
      var sight = e.kind === 'unit' ? ust(e).sight : D.BUILDINGS[e.type].sight;
      var c = circle(sight);
      var cx = Math.floor(e.x / TILE), cy = Math.floor(e.y / TILE);
      for (var k = 0; k < c.length; k += 2) {
        var x = cx + c[k], y = cy + c[k + 1];
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        var ti = y * w + x;
        vis[ti] = 1; exp[ti] = 1;
      }
    }
    // Gebäude-Erinnerung
    for (i = 0; i < S.ents.length; i++) {
      var b = S.ents[i];
      if (b.kind !== 'building' || b.dead) continue;
      if (b.owner === P.id) { if (P.mem[b.id]) delete P.mem[b.id]; continue; }
      if (isVisible(P.id, b)) {
        var mm = P.mem[b.id] = { id: b.id, type: b.type, owner: b.owner, tx: b.tx, ty: b.ty, w: b.w, h: b.h, hp: b.hp, maxHp: b.maxHp };
        if (b.neutral) { mm.neutral = true; mm.ruin = b.ruin; mm.garN = b.gar.length; }
      }
    }
    for (var id in P.mem) {
      var m = P.mem[id], be = byId.get(m.id);
      if (!be || be.dead) {
        if (vis[(m.ty + (m.h >> 1)) * w + m.tx + (m.w >> 1)]) delete P.mem[id];
      }
    }
  }
  function updateFog(all) {
    for (var p = 0; p < S.players.length; p++) {
      if (all || (S.tick + p * 2) % 4 === 0) updateFogFor(S.players[p]);
    }
  }

  // ------------------------------------------------------------------ Tick
  function step() {
    if (!S || S.over) { if (S) S.tick++; return; }
    if (G.AI && G.AI.update) G.AI.update(S);
    S.tick++;
    // v0.7: Ende der Friedenszeit einmalig melden
    if (!S.peaceDone && S.settings.peace > 0 && S.tick >= S.settings.peace * HZ) { S.peaceDone = true; emit('peaceOver', 0, 0, { peace: S.settings.peace }); }
    G.Path.process(S, 3000, get);
    buildGrid();
    if (S.tick % D.CLOAK.every === 0) tickReveal();   // v1.2 Tarnung/Aufdeckung
    var i, e, n = S.ents.length;
    for (var p0 = 0; p0 < S.players.length; p0++) { S.players[p0].radar = false; S.players[p0].trade = 0; }   // v1.2: trade = eigene Handelsposten
    for (i = 0; i < n; i++) {
      e = S.ents[i];
      if (e.dead) continue;
      if (e.kind === 'unit') { if (!e.inside) tickUnit(e); }
      else {
        var bd = D.BUILDINGS[e.type];
        if (bd.weapon) tickDefense(e);
        if (bd.superweapon) tickSWCharge(e);
        if (e.repairing) tickRepair(e);
        else if (e.hp < e.maxHp && !e.neutral && !e.ruin && S.players[e.owner] && S.players[e.owner].autoRepair && S.players[e.owner].credits >= AUTO_REPAIR_MIN) e.repairing = true;   // v0.9.2 Reparatur
        if (bd.neutral) tickNeutral(e, bd);
        else if (bd.garrisonOwn && e.gar.length) tickGarrison(e, bd);   // v0.5
        if (bd.x12) tickBld12(e, bd);   // v1.2 Reparaturdock, Tor, Minenfeld
      }
    }
    separation();
    tickProjectiles();
    if (S.charges.length) tickCharges();   // v1.2 Sprengladungen
    if (S.strikes.length) tickStrikes();
    if (S.sw.length) tickSW();
    for (var p = 0; p < S.players.length; p++) if (!S.players[p].defeated) tickProduction(S.players[p]);
    // v0.8: Cheat „unbegrenzt Geld“ – am Tickende auffüllen, damit die Credits nie sichtbar unter CHEAT_CREDITS fallen
    for (p = 0; p < S.players.length; p++) if (S.players[p].cheat && S.players[p].credits < CHEAT_CREDITS) S.players[p].credits = CHEAT_CREDITS;
    for (p = 0; p < S.players.length; p++) if (!S.players[p].defeated) tickAirSeaQueues(S.players[p]);   // v0.8 Flugfeld/Werft
    if (S.tick % 40 === 0) regrowOre();
    if (drainEnd >= 0 && S.tick % 5 === 0) { recalcPower(); if (S.tick > drainEnd + 5) drainEnd = -1; }   // v1.0 Diskus-Stromentzug läuft ab
    if (offEnd >= 0 && S.tick % 5 === 0) { recalcPower(); if (S.tick > offEnd + 5) offEnd = -1; }       // v1.2 lahmgelegte Kraftwerke laufen wieder an
    updateFog(false);
    // Tote entfernen
    var j = 0;
    for (i = 0; i < S.ents.length; i++) {
      e = S.ents[i];
      if (e.dead) { byId.delete(e.id); continue; }
      S.ents[j++] = e;
    }
    S.ents.length = j;
    // Ereignisse älter als 2 s verwerfen
    var cut = S.tick - 40, k = 0;
    while (k < S.events.length && S.events[k].tick < cut) k++;
    if (k) S.events.splice(0, k);
    if (S.tick % 10 === 0) checkVictory();
  }

  var AUTO_REPAIR_MIN = 300;   // v0.9.2 Reparatur: Auto-Reparatur startet erst ab dieser Kreditmenge
  function tickRepair(b) {
    var P = S.players[b.owner], d = D.BUILDINGS[b.type];
    if (b.hp >= b.maxHp) { b.repairing = false; return; }
    var heal = b.maxHp * D.REPAIR_RATE / HZ;
    var cost = heal / b.maxHp * (d.cost || 2000) * D.REPAIR_COST;
    if (P.credits < cost) return;
    P.credits -= cost; P.st.spent += cost;
    b.hp = Math.min(b.maxHp, b.hp + heal);
  }
  function regrowOre() {
    var m = S.map;
    for (var i = 0; i < oreTiles.length; i++) {
      var t = oreTiles[i];
      if (m.ore[t] < m.oreMax[t]) m.ore[t] = Math.min(m.oreMax[t], m.ore[t] + Math.round(D.ORE_REGROW * 2));
    }
  }
  function checkVictory() {
    var alive = [];
    for (var p = 0; p < S.players.length; p++) {
      var P = S.players[p];
      if (P.defeated) continue;
      var has = false;
      for (var i = 0; i < S.ents.length; i++) { var e = S.ents[i]; if (e.kind === 'building' && !e.dead && e.owner === p && !e.neutral && !D.BUILDINGS[e.type].isWall) { has = true; break; } }
      if (!has) { P.defeated = true; emit('defeat', 0, 0, { owner: p }); }
      else alive.push(p);
    }
    if (alive.length <= 1) {
      S.over = true; S.winner = alive.length ? alive[0] : -1;
      emit('over', 0, 0, { winner: S.winner });
    }
  }

  /** v0.8: Cheat „unbegrenzt Geld“ ein/aus (nur für menschliche Spieler, nie für die KI). */
  function setCheat(pid, on) {
    var P = S.players[pid];
    if (!P) return { ok: false, reason: 'Unbekannter Spieler' };
    if (P.ai) return { ok: false, reason: 'Nicht für die KI' };
    on = !!on;
    P.cheat = on;
    if (on) { P.cheatUsed = true; if (P.credits < CHEAT_CREDITS) P.credits = CHEAT_CREDITS; }
    emit('cheat', 0, 0, { owner: pid, on: on });
    return { ok: true, reason: '' };
  }
  // ================================================================== v0.8 Luftwaffe & Marine (SPEC_v08)
  /** In der Luft (nicht gelandet)? Nur dann gelten die Flugabwehr-Regeln. */
  function airborne(e) { return !!e && e.kind === 'unit' && e.mc === 2 && e.alt > 0.5; }
  /** Darf Waffe w das Ziel t treffen? Luftziele nur mit antiAir; airOnly-Waffen (Flak) nur Luftziele. */
  function canHit(w, t) {
    if (!w || !t) return false;
    if (w.psi) return controllable(t);                                                     // v1.0 Gedankenkontrolle
    if (w.navalOnly) return t.kind === 'unit' && t.mc === 3;                               // v1.0 Torpedo: nur Schiffe
    if (w.vehicleOnly && (t.kind !== 'unit' || airborne(t) || !VEH_CAT[ust(t).cat])) return false;   // v1.0 Magnet: Fahrzeuge/Schiffe
    if (airborne(t)) return !!w.antiAir;
    return !w.airOnly;
  }
  var VEH_CAT = { vehicle: 1, naval: 1 };
  function initFlyer(e, st) {
    e.alt = 0; e.land = false; e.home = 0; e.pad = -1;
    if (st.bomber) { e.ammo = st.weapon.bombs; e.bx = 0; e.by = 0; e.bdrop = 0; e.blx = 0; e.bly = 0; e.rearmT = 0; }
  }
  function migrateV08() {
    for (var p = 0; p < S.players.length; p++) { var P = S.players[p]; if (!P.q.air) P.q.air = []; if (!P.q.naval) P.q.naval = []; }
    for (var i = 0; i < S.ents.length; i++) { var e = S.ents[i]; if (e.kind === 'unit' && e.mc === 2 && e.alt == null) initFlyer(e, D.unitStats(S.players[e.owner].faction, e.type)); }
  }
  function clampMap(e) {
    var W = S.map.w * TILE - 1, H = S.map.h * TILE - 1;
    if (e.x < 1) e.x = 1; else if (e.x > W) e.x = W;
    if (e.y < 1) e.y = 1; else if (e.y > H) e.y = H;
  }

  // ---- Landeplätze (Flugfeld)
  function airPads(pid) {
    var n = 0;
    for (var i = 0; i < S.ents.length; i++) { var b = S.ents[i]; if (!b.dead && b.kind === 'building' && b.owner === pid && D.BUILDINGS[b.type].pads) n += D.BUILDINGS[b.type].pads; }
    return n;
  }
  /** Begründung, warum kein weiteres Luftfahrzeug gebaut werden kann ('' = geht): je Flugfeld pads Luftfahrzeuge (lebende + in der Warteschlange). */
  function airPadBlock(pid) {
    var cap = airPads(pid), n = 0;
    for (var i = 0; i < S.ents.length; i++) { var e = S.ents[i]; if (!e.dead && e.kind === 'unit' && e.owner === pid && e.mc === 2) n++; }
    var q = S.players[pid].q.air; if (q) n += q.length;
    return n >= cap ? 'Alle Landeplätze belegt (' + cap + ')' : '';
  }
  function padPos(b, i) {
    if (i == null || i < 0) return { x: b.x, y: b.y };
    var n = D.BUILDINGS[b.type].pads || 4;
    return { x: (b.tx + (i % n + 0.5) * b.w / n) * TILE, y: (b.ty + b.h * 0.55) * TILE };
  }
  function padsUsed(a, except) {
    var u = {};
    for (var i = 0; i < S.ents.length; i++) { var o = S.ents[i]; if (!o.dead && o !== except && o.kind === 'unit' && o.mc === 2 && o.home === a.id) u[o.pad] = 1; }
    return u;
  }
  /** Heimat-Flugfeld (eigenes, lebendes); sonst nächstes Flugfeld mit freiem Landeplatz zuweisen. */
  function homeOf(e) {
    var b = e.home ? byId.get(e.home) : null;
    if (b && !b.dead && b.owner === e.owner && D.BUILDINGS[b.type].pads) return b;
    e.home = 0; e.pad = -1;
    var best = null, bd = 1e18, bp = -1;
    for (var i = 0; i < S.ents.length; i++) {
      var a = S.ents[i];
      if (a.dead || a.kind !== 'building' || a.owner !== e.owner || !D.BUILDINGS[a.type].pads) continue;
      var used = padsUsed(a, e), d = dist2(a.x, a.y, e.x, e.y);
      for (var p = 0; p < D.BUILDINGS[a.type].pads; p++) if (!used[p]) { if (d < bd) { bd = d; best = a; bp = p; } break; }
    }
    if (best) { e.home = best.id; e.pad = bp; }
    return best;
  }

  // ---- Flughöhe / Flug
  /** Höhe nachführen (want 0 = landen, 1 = fliegen); Ereignisse takeoff (verlässt den Boden) und land (setzt auf). */
  function tickAlt(e, want) {
    var a = e.alt || 0, r = DT / D.AIR_CLIMB;
    if (want > a) { if (a <= 0) emit('takeoff', e.x, e.y, { id: e.id, owner: e.owner, type: e.type }); e.alt = Math.min(1, a + r); }
    else if (want < a) { e.alt = Math.max(0, a - r); if (e.alt <= 0) emit('land', e.x, e.y, { id: e.id, owner: e.owner, type: e.type }); }
  }
  /** Hubschrauber: direkt zum Ziel (e.gx, e.gy). → true, wenn angekommen. */
  function flyStep(e, st) {
    var dx = e.gx - e.x, dy = e.gy - e.y, dist = Math.sqrt(dx * dx + dy * dy);
    var spd = st.speed * TILE / HZ * (0.35 + 0.65 * Math.min(1, e.alt || 0));
    if (dist <= Math.max(2, spd)) { e.x = e.gx; e.y = e.gy; clampMap(e); e.moving = false; return true; }
    e.dir = turnTo(e.dir, Math.atan2(dy, dx), 0.2);
    e.x += dx / dist * spd; e.y += dy / dist * spd;
    clampMap(e);
    e.moving = true;
    return false;
  }
  /** Vor der normalen Einheiten-Logik (Hubschrauber): landen, wenn gewünscht; sonst Flughöhe. */
  function airPre(e, st) {
    if (e.land && e.ord === 'idle' && (S.tick + e.id) % 10 === 0 && !loadingTo(e)) e.land = false;   // niemand mehr unterwegs → abheben
    tickAlt(e, e.land ? 0 : 1);
    if (e.land) { e.moving = false; }
  }
  function heliCanLand(a) { return G.Path.passable(0, tileOf(a.x, a.y)); }
  /** Landungsboot nah genug am Ufer (befahr-/begehbares Land in ≤ BEACH_RANGE Kacheln)? */
  function nearShore(a) {
    var w = S.map.w, h = S.map.h, cx = Math.floor(a.x / TILE), cy = Math.floor(a.y / TILE), R = Math.floor(D.BEACH_RANGE);
    for (var y = cy - R; y <= cy + R; y++) for (var x = cx - R; x <= cx + R; x++) {
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      if (G.Path.passable(0, y * w + x) && !G.Path.terrainPassable(3, y * w + x)) return true;
    }
    return false;
  }
  /** Wasserkachel am Ufer (Land direkt daneben) im Gewässer des Boots, möglichst nah an (x, y), ≤ 16 Kacheln. */
  function shoreSpot(a, x, y) {
    var w = S.map.w, h = S.map.h, tx = Math.floor(x / TILE), ty = Math.floor(y / TILE), comp = G.Path.waterComp(tileOf(a.x, a.y)), best = null, bd = 1e18;
    for (var yy = ty - 16; yy <= ty + 16; yy++) for (var xx = tx - 16; xx <= tx + 16; xx++) {
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      var i = yy * w + xx;
      if (!G.Path.passable(3, i) || G.Path.waterComp(i) !== comp) continue;
      var shore = false;
      for (var oy = -1; oy <= 1 && !shore; oy++) for (var ox = -1; ox <= 1; ox++) {
        var nx = xx + ox, ny = yy + oy;
        if (nx >= 0 && ny >= 0 && nx < w && ny < h && G.Path.passable(0, ny * w + nx) && !G.Path.terrainPassable(3, ny * w + nx)) { shore = true; break; }
      }
      if (!shore) continue;
      var d = (xx - tx) * (xx - tx) + (yy - ty) * (yy - ty);
      if (d < bd) { bd = d; best = { x: (xx + 0.5) * TILE, y: (yy + 0.5) * TILE }; }
    }
    return best;
  }
  /** Transporter fährt/fliegt nach (x, y) und lädt dort aus (Hubschrauber: Landekachel, Landungsboot: Uferkachel). */
  function orderDrop(a, x, y) {
    var w = S.map.w;
    if (a.mc === 2) {
      var ti = G.Path.nearestPassable(0, Math.floor(x / TILE), Math.floor(y / TILE), 4);
      if (ti < 0) return { ok: false, reason: 'Hier kann nicht gelandet werden' };
      a.ord = 'drop'; a.tgt = 0; a.land = false; a.chase = false;
      a.gx = a.dropX = (ti % w + 0.5) * TILE; a.gy = a.dropY = (Math.floor(ti / w) + 0.5) * TILE;
      return { ok: true, reason: '', kind: 'drop', n: 0 };
    }
    if (a.mc === 3) {
      var sp = shoreSpot(a, x, y);
      if (!sp) return { ok: false, reason: 'Kein erreichbares Ufer in der Nähe' };
      orderMove(a, sp.x, sp.y, 'drop'); a.dropX = sp.x; a.dropY = sp.y;
      return { ok: true, reason: '', kind: 'drop', n: 0 };
    }
    orderMove(a, x, y, 'drop'); a.dropX = x; a.dropY = y;
    return { ok: true, reason: '', kind: 'drop', n: 0 };
  }
  function tickDrop(e, st) {
    if (!e.gar || !e.gar.length) { e.land = false; orderStop(e); return; }
    if (e.mc === 2) {
      if (flyStep(e, st)) { e.land = true; if (e.alt <= 0) { unloadApc(e, null, false); e.land = false; orderStop(e); } }
      return;
    }
    if (st.turret) turretFire(e, st, null);
    var arrived = followPath(e, st) || checkStuck(e);
    if (e.mc === 3) {
      var close = dist2(e.x, e.y, e.dropX, e.dropY) < 1.6 * 1.6 * TILE * TILE;
      if ((arrived || close) && nearShore(e)) { e.moving = false; e.path = null; unloadApc(e, null, false); orderStop(e); }
      else if (arrived) orderStop(e);
      return;
    }
    if (arrived) { unloadApc(e, null, false); orderStop(e); }
  }

  // ---- Bomber
  function orderBomb(e, x, y, tid) {
    e.ord = 'bomb'; e.tgt = tid || 0; e.bdrop = 0; e.land = false; e.chase = false; e.path = null; e.pp = false;
    e.bx = Math.max(0, Math.min(S.map.w * TILE - 1, x)); e.by = Math.max(0, Math.min(S.map.h * TILE - 1, y));
  }
  /** Starrflügler: konstante Fahrt, begrenzte Kurvenrate; liegt das Ziel innerhalb des Wendekreises, erst geradeaus Abstand gewinnen. */
  function fixedWing(e, st, tx, ty, arriveR) {
    var spd = st.speed * TILE / HZ * (0.3 + 0.7 * Math.min(1, e.alt || 0));
    var dx = tx - e.x, dy = ty - e.y, d = Math.sqrt(dx * dx + dy * dy), ang = Math.atan2(dy, dx), rate = 0.09, R = spd / rate;
    if (!(angDiff(e.dir, ang) > 1.2 && d < 2.2 * R)) e.dir = turnTo(e.dir, ang, rate);
    e.x += Math.cos(e.dir) * spd; e.y += Math.sin(e.dir) * spd;
    clampMap(e);
    e.moving = true;
    return d <= (arriveR || Math.max(spd * 1.5, 12));
  }
  function startRtb(e) { e.bdrop = 0; e.ord = homeOf(e) ? 'rtb' : 'idle'; }
  function dropBomb(e, w, spd) {
    var i = w.bombs - e.ammo, fall = 12;
    var gx = Math.max(0, Math.min(S.map.w * TILE - 1, e.x + Math.cos(e.dir) * spd * fall * 0.5)), gy = Math.max(0, Math.min(S.map.h * TILE - 1, e.y + Math.sin(e.dir) * spd * fall * 0.5));
    S.proj.push({ x0: e.x, y0: e.y, x: e.x, y: e.y, tx: gx, ty: gy, tid: 0, t: 0, dur: fall, w: 'bomb', dmg: w.dmg, owner: e.owner, src: e.id,
                  bomb: true, sp: w.splash * TILE, raw: w.dmg, wt: 'bomb' });
    emit('bomb', e.x, e.y, { id: e.id, owner: e.owner, tx: gx, ty: gy, i: i, n: w.bombs, t2: S.tick + fall });
    e.ammo--; e.bdrop++; e.blx = e.x; e.bly = e.y; e.fireT = S.tick;
  }
  /** Bomber-Zustände: bomb (Anflug + Teppich) → rtb (zum Landeplatz) → rearm (Nachladen) → idle (gelandet). Kein Selbstverteidigungsfeuer. */
  function tickBomber(e, st) {
    var w = st.weapon, spd = st.speed * TILE / HZ, h, p, d;
    if (e.ord === 'amove' || e.ord === 'attack') orderBomb(e, e.ord === 'amove' ? e.gx : e.bx, e.ord === 'amove' ? e.gy : e.by, 0);
    switch (e.ord) {
      case 'bomb': {
        if (e.ammo <= 0) { startRtb(e); break; }
        var t = e.tgt ? byId.get(e.tgt) : null;
        if (t && !e.bdrop && hostile(e.owner, t) && isVisible(e.owner, t) && !airborne(t)) { e.bx = t.x; e.by = t.y; }
        tickAlt(e, 1);
        var dx = e.bx - e.x, dy = e.by - e.y, dd = Math.sqrt(dx * dx + dy * dy), half = (w.bombs - 1) / 2 * w.spacing * TILE;
        if (!e.bdrop) {
          fixedWing(e, st, e.bx, e.by, 1);
          if (dd <= half + spd * 6 + spd && angDiff(e.dir, Math.atan2(dy, dx)) < 0.35 && e.alt >= 1) dropBomb(e, w, spd);   // + Vorhalt (Fallzeit)
        } else {
          fixedWing(e, st, e.x + Math.cos(e.dir) * 200, e.y + Math.sin(e.dir) * 200, 1);
          if (dist2(e.x, e.y, e.blx, e.bly) >= w.spacing * w.spacing * TILE * TILE) dropBomb(e, w, spd);
        }
        if (e.ammo <= 0) startRtb(e);
        break;
      }
      case 'move':
        tickAlt(e, 1);
        if (fixedWing(e, st, e.gx, e.gy)) startRtb(e);
        break;
      case 'rtb': {
        h = homeOf(e);
        if (!h) { e.ord = 'idle'; break; }
        p = padPos(h, e.pad); d = Math.sqrt(dist2(e.x, e.y, p.x, p.y));
        if (d > 2.5 * TILE) { tickAlt(e, 1); fixedWing(e, st, p.x, p.y, 1); break; }
        // Landeanflug: senkrecht auf den Landeplatz (VTOL)
        var sp2 = Math.min(d, spd * 0.6);
        if (d > 0.5) { e.x += (p.x - e.x) / d * sp2; e.y += (p.y - e.y) / d * sp2; }
        e.moving = d > 1;
        if (d < 0.7 * TILE) tickAlt(e, 0);
        if (d <= 1 && e.alt <= 0) {
          e.x = p.x; e.y = p.y; e.moving = false;
          if (e.ammo < w.bombs) { e.ord = 'rearm'; e.rearmT = Math.round(w.rearm * HZ); } else e.ord = 'idle';
        }
        break;
      }
      case 'rearm':
        e.moving = false; tickAlt(e, 0);
        if (!homeOf(e)) { e.ord = 'idle'; break; }
        e.rearmT -= lowPower(e.owner) ? 0.5 : 1;
        if (e.rearmT <= 0) { e.rearmT = 0; e.ammo = w.bombs; e.ord = 'idle'; emit('rearm', e.x, e.y, { id: e.id, owner: e.owner }); }
        break;
      default: {   // idle: am Landeplatz parken; ohne Flugfeld über der Stelle kreisen
        h = homeOf(e);
        if (h) {
          p = padPos(h, e.pad);
          if (dist2(e.x, e.y, p.x, p.y) <= 4 && e.alt <= 0) { e.moving = false; if (e.ammo < w.bombs) { e.ord = 'rearm'; e.rearmT = Math.round(w.rearm * HZ); } break; }
          e.ord = 'rtb'; break;
        }
        tickAlt(e, 1);
        e.dir += 0.06;
        e.x += Math.cos(e.dir) * spd * 0.8; e.y += Math.sin(e.dir) * spd * 0.8; clampMap(e); e.moving = true;
      }
    }
  }

  // ---- Flak-Zweitwaffe (Zerstörer) und Flugabwehr-Salve (Raketenwerfer)
  function tickAA(e, st) {
    var w = st.aa, R = w.range * TILE;
    if (e.cd2 > 0) e.cd2--;
    var t = e.atgt ? byId.get(e.atgt) : null;
    if (t && (!hostile(e.owner, t) || !airborne(t) || distTo(t, e.x, e.y) > R || !isVisible(e.owner, t))) { t = null; e.atgt = 0; }
    if (!t && (S.tick + e.id) % 5 === 0) { t = findTarget(e, e.x, e.y, R, w.type, 0, w); e.atgt = t ? t.id : 0; }
    if (t && !(e.cd2 > 0)) { fire(e, t, w); e.cd2 = reloadT(w, e); }
  }
  function salvoAA(e, wpn, t) {
    var idx = e.salvoI, dd = Math.sqrt(dist2(t.x, t.y, e.x, e.y));
    S.proj.push({ x0: e.x, y0: e.y, x: e.x, y: e.y, tx: t.x, ty: t.y, tid: t.id, t: 0, dur: Math.max(3, Math.round(dd / 11)), w: wpn.type,
                  dmg: wpn.dmg * D.DAMAGE[wpn.type].air, owner: e.owner, src: e.id, salvo: idx, air: true });
    e.fireT = S.tick; e.tdir = Math.atan2(t.y - e.y, t.x - e.x);
    emit('shot', e.x, e.y, { tx: t.x, ty: t.y, w: wpn.type, owner: e.owner, src: e.id, salvo: idx, air: true, tid: t.id });
    e.salvoI++; e.salvoN--;
  }

  // ---- Produktion: Flugfeld (Landeplatz) / Werft (Wasserkachel neben der Werft)
  function tickAirSeaQueues(P) {
    var slow = lowPower(P.id) ? 0.5 : 1;
    tickUnitQueue(P, 'air', 'airfield', slow);
    tickUnitQueue(P, 'naval', 'shipyard', slow);
  }
  /** Führt von Wasserkachel i ein freier Wasserweg (Gebäude zählen, Rechteck rx..rx+rw−1 × ry..ry+rh−1 zusätzlich gesperrt) zu mindestens need
   *  schiffbaren Kacheln? (Sonst läge die Ausfahrt in einer von der Werft abgeschnittenen Bucht.) */
  var owQ = null, owSeen = null, owGen = 0;
  function openWater(i, rx, ry, rw, rh, need) {
    var w = S.map.w, h = S.map.h, N = w * h;
    if (!owQ || owQ.length !== N) { owQ = new Int32Array(N); owSeen = new Uint32Array(N); owGen = 0; }
    owGen++;
    function blocked(k) { var x = k % w, y = (k - x) / w; return !G.Path.passable(3, k) || (x >= rx && x < rx + rw && y >= ry && y < ry + rh); }
    if (blocked(i)) return false;
    var qh = 0, qt = 0; owQ[qt++] = i; owSeen[i] = owGen;
    while (qh < qt) {
      var c = owQ[qh++], cx = c % w, cy = (c - cx) / w;
      if (qt >= need) return true;
      for (var d = 0; d < 4; d++) {
        var nx = cx + (d === 0 ? 1 : d === 1 ? -1 : 0), ny = cy + (d === 2 ? 1 : d === 3 ? -1 : 0);
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        var ni = ny * w + nx;
        if (owSeen[ni] === owGen || blocked(ni)) continue;
        owSeen[ni] = owGen; owQ[qt++] = ni;
      }
    }
    return qt >= need;
  }
  /** Freie schiffbare Kachel um die Werft (Ring 1..4) mit Verbindung ins offene Wasser, im größten Gewässer. */
  function shipExit(b) {
    var w = S.map.w, h = S.map.h, best = -1, bs = -1;
    for (var r = 1; r <= 4 && best < 0; r++) {
      for (var y = b.ty - r; y < b.ty + b.h + r; y++) for (var x = b.tx - r; x < b.tx + b.w + r; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        if (x > b.tx - r && x < b.tx + b.w + r - 1 && y > b.ty - r && y < b.ty + b.h + r - 1) continue;   // nur der Ring
        var i = y * w + x;
        if (!G.Path.passable(3, i)) continue;
        // v0.8 Seitengleichheit: Ausfahrt zur Kartenmitte (vorher immer Südseite → die südliche Werft fuhr vom Gegner weg)
        var sc = G.Path.waterSize(G.Path.waterComp(i)) * 64 - dist2(x + 0.5, y + 0.5, S.map.w / 2, S.map.h / 2);
        if (openWater(i, -1, -1, 0, 0, D.NAVAL_MIN_WATER)) sc += 1e9;   // offenes Wasser vor abgeschnittener Bucht
        if (sc > bs) { bs = sc; best = i; }
      }
    }
    return best;
  }
  function deliverAirSea(pid, type, b, st) {
    var w = S.map.w, u;
    if (st.move === 'air') {
      var home = b, pad = -1, used = padsUsed(b, null), np = D.BUILDINGS[b.type].pads || 4;
      for (var k = 0; k < np; k++) if (!used[k]) { pad = k; break; }
      if (pad < 0) {   // anderes eigenes Flugfeld mit freiem Landeplatz
        for (var i = 0; i < S.ents.length && pad < 0; i++) {
          var a = S.ents[i];
          if (a === b || a.dead || a.kind !== 'building' || a.owner !== pid || !D.BUILDINGS[a.type].pads) continue;
          var ua = padsUsed(a, null);
          for (k = 0; k < D.BUILDINGS[a.type].pads; k++) if (!ua[k]) { pad = k; home = a; break; }
        }
      }
      var pp = padPos(home, pad);
      u = spawnUnit(pid, type, pp.x, pp.y);
      u.home = pad >= 0 ? home.id : 0; u.pad = pad; u.dir = -Math.PI / 2; u.alt = 0;
      emit('spawn', u.x, u.y, { owner: pid, type: type, id: u.id });
      if (!st.bomber) {
        if (b.rx >= 0) orderMove(u, b.rx, b.ry, 'move');
        else orderMove(u, b.x + (rand() - 0.5) * TILE * 3, (b.ty + b.h) * TILE + TILE * 1.5, 'move');
      }
      return true;
    }
    var ex = shipExit(b);
    if (ex < 0) return false;
    u = spawnUnit(pid, type, (ex % w + 0.5) * TILE + (rand() - 0.5) * 6, (Math.floor(ex / w) + 0.5) * TILE + (rand() - 0.5) * 6);
    u.dir = Math.atan2(u.y - b.y, u.x - b.x);
    emit('spawn', u.x, u.y, { owner: pid, type: type, id: u.id });
    if (b.rx >= 0) orderMove(u, b.rx, b.ry, 'move');
    else orderMove(u, u.x + Math.cos(u.dir) * 2.5 * TILE, u.y + Math.sin(u.dir) * 2.5 * TILE, 'move');
    return true;
  }
  /** Werft-Platzierung (SPEC_v08 §2): 3×3, jede Kachel Wasser oder bebaubares Land ohne Erz, ≥ shoreWater Wasserkacheln in einem schiffbaren
   *  Gewässer (≥ NAVAL_MIN_WATER Kacheln), Land im oder direkt am Rechteck, freie Ausfahrt aufs Wasser, Nähe-Regel mit placeDist. */
  function canPlaceShore(pid, type, tx, ty) {
    var b = D.BUILDINGS[type], m = S.map, TER = D.TERRAIN, w = m.w, x, y, i;
    if (tx < 0 || ty < 0 || tx + b.w > m.w || ty + b.h > m.h) return { ok: false, reason: 'Außerhalb der Karte' };
    var water = 0, land = 0, comp = -1;
    for (y = ty; y < ty + b.h; y++) for (x = tx; x < tx + b.w; x++) {
      i = y * w + x;
      var t = TER[m.terrain[i]];
      if (S.occ[i]) return { ok: false, reason: 'Belegt' };
      if (t.id === 'water') { water++; var c = G.Path.waterComp(i); if (G.Path.waterSize(c) > G.Path.waterSize(comp)) comp = c; }
      else if (t.build) { if (m.ore[i] > 0) return { ok: false, reason: 'Nicht auf Erz' }; land++; }
      else return { ok: false, reason: 'Ungeeignetes Gelände' };
    }
    if (water < (b.shoreWater || 3)) return { ok: false, reason: 'Werft muss am Wasser stehen' };
    if (G.Path.waterSize(comp) < D.NAVAL_MIN_WATER) return { ok: false, reason: 'Gewässer zu klein für Schiffe' };
    var adjLand = land > 0, exit = false;
    for (y = ty - 1; y <= ty + b.h; y++) for (x = tx - 1; x <= tx + b.w; x++) {
      if (x < 0 || y < 0 || x >= w || y >= m.h || (x >= tx && x < tx + b.w && y >= ty && y < ty + b.h)) continue;
      i = y * w + x;
      if (!exit && G.Path.passable(3, i) && openWater(i, tx, ty, b.w, b.h, D.NAVAL_MIN_WATER)) exit = true;   // Ausfahrt ins offene Wasser
      var orth = (x >= tx && x < tx + b.w) || (y >= ty && y < ty + b.h);
      if (orth && TER[m.terrain[i]].build && !S.occ[i]) adjLand = true;
    }
    if (!adjLand) return { ok: false, reason: 'Werft braucht Anschluss ans Ufer' };
    if (!exit) return { ok: false, reason: 'Keine Ausfahrt aufs Wasser' };
    if (unitsOnRect(tx, ty, b.w, b.h, 0)) return { ok: false, reason: 'Einheiten im Weg' };
    if (!nearBase(pid, tx, ty, b.w, b.h, b.placeDist)) return { ok: false, reason: 'Zu weit von der Basis' };
    return { ok: true, reason: '' };
  }

  /** Setzt einen geladenen Zustand als aktiv. */
  // ================================================================== v1.0 Kollektiv (SPEC_v10): Gedankenkontrolle, Magnet, Diskus, Recycling
  // Felder (alle im Spielstand): EINHEIT fac (Herkunftsfraktion), pc (Wegfindungsklasse, nur Schwebepanzer = 4), mcBy (ID des Kontrolleurs, 0 = frei),
  //   mcOrig (ursprünglicher Besitzer, −1), mcN (wie oft schon übernommen), mcFree (Tick, bis zu dem die Einheit nach der Freigabe geschützt ist),
  //   magT/magBy (vom Magnet-Werfer gehalten bis Tick / von), spin (Gatling 0..1), recId (Ziel-Erzwandler von ord 'recycle').
  // KONTROLLEUR (Einheit oder Psi-Turm): mcList (IDs der kontrollierten Einheiten, älteste zuerst). GEBÄUDE drainT (Kraftwerk ohne Strom bis Tick).
  // SPIELER cloneN (gelieferte Kollektiv-Infanterie), st.mc / st.mcLost / st.clones / st.recycled / st.drained / st.psiWave.
  /** Psi-Werte (slots, safe) des Kontrolleurs e oder null. */
  function psiOf(e) {
    var w = e.kind === 'unit' ? (ust(e) || {}).weapon : D.BUILDINGS[e.type].weapon;
    return w && w.psi ? w.psi : null;
  }
  /** Kann t (jetzt) übernommen werden? Nur gegnerische Einheiten am Boden/auf dem Wasser: keine Gebäude, Luftfahrzeuge, Transporter,
   *  Psi-Einheiten; nicht schon kontrolliert, nicht öfter als D.PSI.maxControls, nicht kurz nach einer Freigabe. */
  function controllable(t) {
    if (!t || t.dead || t.kind !== 'unit' || t.inside || t.owner < 0 || t.mcBy) return false;
    if ((t.mcN || 0) >= D.PSI.maxControls || t.mcFree > S.tick) return false;
    var st = ust(t);
    return !!st && !st.psiImmune && !st.flyer && !st.transport && t.mc !== 2;
  }
  /** Liste der von c kontrollierten Einheiten (räumt Tote/Verlorene auf). */
  function mcList(c) {
    if (!c.mcList) return (c.mcList = []);
    var L = c.mcList;
    for (var i = L.length - 1; i >= 0; i--) { var u = byId.get(L[i]); if (!u || u.dead || u.mcBy !== c.id) L.splice(i, 1); }
    return L;
  }
  /** Einheit nach Besitzerwechsel in einen sauberen Zustand bringen (keine Ziele/Aufträge des alten Besitzers). */
  function resetOwned(t) {
    orderStop(t);
    t.lastAtk = 0; t.retal = 0; t.ftgt = 0; t.salvoN = 0; t.magT = 0; t.refId = 0; t.htgt = 0; t.amx = null; t.amy = null; t.setup = 0;
    if (ust(t).harvester) orderHarvest(t, -1);
  }
  function firePsi(e, t, wpn) {
    if (!controllable(t) || !hostile(e.owner, t)) return;
    var L = mcList(e), explicit = e.kind === 'unit' && e.ord === 'attack' && e.tgt === t.id;
    if (L.length >= (explicit ? wpn.psi.slots : wpn.psi.safe)) {
      if (!explicit || !L.length) return;
      release(byId.get(L[0]), 'switch');   // ausdrücklicher Befehl bei vollen Plätzen: älteste Einheit freigeben
    }
    e.fireT = S.tick; e.tdir = Math.atan2(t.y - e.y, t.x - e.x);
    emit('shot', e.x, e.y, { tx: t.x, ty: t.y, w: 'psi', owner: e.owner, src: e.id, tid: t.id, beam: true });
    control(e, t, false);
  }
  /** c übernimmt t (perm = dauerhaft, z. B. Psi-Welle: ohne Kontrolleur, danach resistent). */
  function control(c, t, perm) {
    var prev = t.owner;
    t.owner = c.owner;
    t.mcN = perm ? D.PSI.maxControls : (t.mcN || 0) + 1;
    if (c.kind === 'unit' && !perm && c.rk != null && D.expEligible(ust(c))) expAdd(c, (ust(t).cost || 0) / D.EXP.costDiv * D.EXP.psiWeight);   // Erfahrung: Psi-Einheit
    if (perm) { t.mcBy = 0; t.mcOrig = -1; }
    else { t.mcBy = c.id; t.mcOrig = prev; mcList(c).push(t.id); }
    resetOwned(t);
    var Pn = S.players[c.owner], Pp = S.players[prev];
    Pn.st.mc = (Pn.st.mc || 0) + 1; if (Pp) Pp.st.mcLost = (Pp.st.mcLost || 0) + 1;
    emit('mc', t.x, t.y, { id: t.id, by: perm ? 0 : c.id, owner: c.owner, prev: prev, on: true, type: t.type, perm: !!perm, sx: c.x, sy: c.y });
  }
  /** Gibt t frei: zurück an den ursprünglichen Besitzer, D.PSI.reImmune s Schutz. why: 'lost' (Kontrolleur weg), 'switch', 'capture'. */
  function release(t, why) {
    if (!t || !t.mcBy) return;
    var by = t.mcBy, o = t.mcOrig, cur = t.owner, c = byId.get(by);
    t.mcBy = 0; t.mcOrig = -1; t.mcFree = S.tick + Math.round(D.PSI.reImmune * HZ);
    if (c && c.mcList) { var k = c.mcList.indexOf(t.id); if (k >= 0) c.mcList.splice(k, 1); }
    if (c && !c.dead && why !== 'lost') c.cd = Math.max(c.cd || 0, Math.round(D.PSI.relink * HZ * mods(c).psi));
    if (t.dead) return;
    if (o >= 0 && S.players[o]) t.owner = o;
    resetOwned(t);
    emit('mc', t.x, t.y, { id: t.id, by: by, owner: t.owner, prev: cur, on: false, type: t.type, why: why || '' });
  }
  function releaseAll(c, why) {
    var L = c.mcList.slice();
    for (var i = 0; i < L.length; i++) { var u = byId.get(L[i]); if (u && u.mcBy === c.id) release(u, why); }
    c.mcList = [];
  }
  /** Kontrollierte Einheit verschwindet (Tod/Recycling): aus der Liste des Kontrolleurs nehmen. */
  function unlinkMc(t) {
    var c = byId.get(t.mcBy);
    if (c && c.mcList) { var k = c.mcList.indexOf(t.id); if (k >= 0) c.mcList.splice(k, 1); }
    if (c && !c.dead) c.cd = Math.max(c.cd || 0, Math.round(D.PSI.relink * HZ * mods(c).psi));   // Abklingzeit, bevor der Kontrolleur nachlegt
  }
  /** Kontrolleur je Tick: Liste aufräumen; mehr als psi.safe Einheiten → Überlastung (Schaden). true = Einheit ist dabei gestorben. */
  function tickPsiCtl(e, st) {
    var L = mcList(e), ps = st.weapon && st.weapon.psi;
    if (!ps || L.length <= ps.safe) return false;
    var over = L.length - ps.safe;
    if (S.tick % 20 === 0) emit('psiOver', e.x, e.y, { id: e.id, owner: e.owner, n: over });
    damage(e, D.PSI.overload * over / HZ, null);
    return e.dead;
  }
  /** Vom Magnet-Werfer gehalten: kann weder fahren noch schießen, wird zum Werfer gezogen (bis stop Kacheln). true = Tick erledigt. */
  function tickHeld(e) {
    var m = byId.get(e.magBy);
    if (!m || m.dead || m.owner === e.owner) { e.magT = 0; return false; }
    e.moving = false; e.path = null; e.pp = false;
    var w = ust(m).weapon, dx = m.x - e.x, dy = m.y - e.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
    if (w && d > (w.stop || 2.5) * TILE + m.r + e.r) { var sp = (w.pull || 0.8) * TILE / HZ; moveBy(e, dx / d * sp, dy / d * sp); }
    if (e.gar) syncPassengers(e);
    return true;
  }
  /** Diskus trifft Gebäude: Credits abziehen (gehen an den Diskus-Besitzer), Kraftwerk drain.pwr s ohne Strom. */
  function drainBld(e, t, dr) {
    if (t.neutral || t.owner < 0 || t.owner === e.owner) return;
    var Pt = S.players[t.owner], Pe = S.players[e.owner], take = Math.min(Math.max(0, Pt.credits), dr.cr || 0);
    if (take > 0 && !Pt.cheat) { Pt.credits -= take; Pe.credits += take; Pe.st.drained = (Pe.st.drained || 0) + take; }
    if (t.type === 'power' && dr.pwr) {
      var was = t.drainT > S.tick;
      t.drainT = S.tick + Math.round(dr.pwr * HZ);
      drainEnd = Math.max(drainEnd, t.drainT);
      if (!was) recalcPower();
    }
    emit('drain', t.x, t.y, { id: t.id, src: e.id, owner: e.owner, cr: take, pwr: t.type === 'power' });
  }
  /** Psi-Welle: alle übernehmbaren gegnerischen Einheiten im Radius gehören dauerhaft dem Auslöser. */
  function psiWave(s, R) {
    var src = byId.get(s.src), c = (src && !src.dead && src.owner === s.owner) ? src : { owner: s.owner, x: s.sx, y: s.sy, id: 0 }, n = 0;
    var cands = [];
    for (var k = 0; k < S.ents.length; k++) {
      var t = S.ents[k];
      if (!hostile(s.owner, t) || t.kind !== 'unit' || !controllable(t) || distTo(t, s.x, s.y) > R) continue;
      cands.push(t);
    }
    for (k = 0; k < cands.length; k++) { control(c, cands[k], true); n++; }
    var P = S.players[s.owner]; P.st.psiWave = (P.st.psiWave || 0) + n;
    emit('swHit', s.x, s.y, { kind: s.kind, r: R, owner: s.owner, id: s.src, n: n, kills: 0, bkills: 0, psi: n });
  }
  // ---- Recycling (Kollektiv): Einheit fährt zum eigenen Erzwandler (refinery) und wird für D.PSI.recycle × Baukosten zerlegt
  function recycleBlock(pid, e, ref) {
    if (S.players[pid].faction !== 'kollektiv') return 'Nur für das Kollektiv';
    if (!ref || ref.dead || ref.kind !== 'building' || ref.type !== 'refinery' || ref.owner !== pid) return 'Kein eigener Erzwandler';
    if (!e || e.dead || e.kind !== 'unit' || e.owner !== pid || e.inside || e.mc >= 2) return 'Nur Bodeneinheiten';
    if (e.gar && e.gar.length) return 'Erst aussteigen lassen';
    return '';
  }
  function orderRecycle(e, ref) {
    orderStop(e);
    e.ord = 'recycle'; e.recId = ref.id;
    var ring = ringTiles(ref), w = S.map.w, best = -1, bd = 1e18;
    for (var i = 0; i < ring.length; i++) { var cx = (ring[i] % w + 0.5) * TILE, cy = (Math.floor(ring[i] / w) + 0.5) * TILE, d = dist2(cx, cy, e.x, e.y); if (d < bd) { bd = d; best = ring[i]; } }
    if (best < 0) setGoal(e, ref.x, ref.y + ref.h * TILE / 2 + TILE / 2);
    else setGoal(e, (best % w + 0.5) * TILE, (Math.floor(best / w) + 0.5) * TILE);
  }
  function tickRecycle(e, st) {
    var ref = byId.get(e.recId);
    if (recycleBlock(e.owner, e, ref)) { orderStop(e); return; }
    var near = distTo(ref, e.x, e.y) <= TILE * 0.8 + e.r;
    if (!near) {
      if (!(followPath(e, st) || checkStuck(e))) return;
      if (distTo(ref, e.x, e.y) > TILE * 1.8 + e.r) { orderStop(e); return; }
    }
    var P = S.players[e.owner], cr = Math.floor((st.cost || 0) * D.PSI.recycle);
    P.credits += cr; P.st.recycled = (P.st.recycled || 0) + 1;
    emit('recycle', e.x, e.y, { id: e.id, owner: e.owner, type: e.type, cr: cr, ref: ref.id, mc: !!e.mcBy });
    removeEntity(e);
  }

  // ================================================================== v1.2 Neue Einheiten & Zusatzgebäude
  /** Altstände (S.version < D.SAVE_VERSION) um v1.2-Felder ergänzen; danach gilt der Stand als aktuell. */
  function migrateV12() {
    S.version = D.SAVE_VERSION;
    if (!S.charges) S.charges = [];
    for (var p = 0; p < S.players.length; p++) { var P = S.players[p]; if (P.trade == null) P.trade = 0; if (P.capFullT == null) P.capFullT = -9999; }
    for (var i = 0; i < S.ents.length; i++) {
      var e = S.ents[i], d = e.kind === 'unit' ? D.unitStats(e.fac || S.players[e.owner].faction, e.type) : D.BUILDINGS[e.type];
      if (d && d.cloak && !e.clk) e.clk = 1;
    }
    offEnd = -1;
    for (i = 0; i < S.ents.length; i++) if (S.ents[i].offT > S.tick) offEnd = Math.max(offEnd, S.ents[i].offT);
  }

  // ================================================================== TARNUNG / AUFDECKUNG
  // Felder (im Spielstand): clk (1 = Typ ist getarnt), revM (Bitmaske der Spieler, in deren Detektor-Radius das Objekt gerade liegt; alle
  //   D.CLOAK.every Ticks neu), revT (bis zu diesem Tick für ALLE sichtbar – nach Schuss/Sprengladung/Auslösung).
  // hidden(pid, e): für Spieler pid unsichtbar? Wird von isVisible, findTarget, entityAt, Zielverfolgung, cmd.attack und den Renderern benutzt –
  // gilt für Mensch und KI gleichermaßen (die KI liest Gegner nur über isVisible). Der Nebel bleibt davon unberührt (zusätzliche Bedingung).
  function hidden(pid, e) { return !!e.clk && e.owner !== pid && e.owner >= 0 && !(e.revT > S.tick) && !((e.revM >> pid) & 1); }
  /** Darstellung: 0 = nicht getarnt, 1 = eigene getarnte Einheit (Schimmer), 2 = getarnt, aber für pid aufgedeckt, 3 = für pid unsichtbar. */
  function cloakState(pid, e) { if (!e.clk) return 0; if (e.owner === pid) return 1; return hidden(pid, e) ? 3 : 2; }
  var rvC = [], rvD = [];
  /** Aufdeckung neu berechnen: wenige getarnte Objekte × wenige Detektoren (ein Durchlauf über S.ents, kein Jeder-gegen-jeden). */
  function tickReveal() {
    rvC.length = 0; rvD.length = 0;
    var i, e, n = S.ents.length;
    for (i = 0; i < n; i++) {
      e = S.ents[i];
      if (e.dead || e.inside || e.owner < 0) continue;
      if (e.clk) rvC.push(e);
      var dr = e.kind === 'unit' ? ust(e).detect : D.BUILDINGS[e.type].detect;
      if (dr && !(e.offT > S.tick)) rvD.push(e);
    }
    for (i = 0; i < rvC.length; i++) {
      var c = rvC[i], m = 0;
      for (var k = 0; k < rvD.length; k++) {
        var d = rvD[k];
        if (d.owner === c.owner || ((m >> d.owner) & 1)) continue;
        var R = (d.kind === 'unit' ? ust(d).detect : D.BUILDINGS[d.type].detect) * TILE + (d.kind === 'building' ? Math.max(d.w, d.h) * TILE / 2 : 0);
        if (dist2(d.x, d.y, c.x, c.y) <= R * R) m |= 1 << d.owner;
      }
      if (m && !c.revM) emit('reveal', c.x, c.y, { id: c.id, owner: c.owner, by: m, type: c.type });
      c.revM = m;
    }
  }
  /** Minenfeld (oder anderes Gebäude ohne Kachelbelegung) auf dem Rechteck? */
  function noOccAt(tx, ty, w, h) {
    for (var i = 0; i < S.ents.length; i++) {
      var e = S.ents[i];
      if (e.kind !== 'building' || e.dead || !D.BUILDINGS[e.type].noOcc) continue;
      if (e.tx < tx + w && e.tx + e.w > tx && e.ty < ty + h && e.ty + e.h > ty) return true;
    }
    return false;
  }
  /** Nicht lahmgelegte eigene Gebäude eines Typs. */
  function activeCount(pid, type) {
    var n = 0;
    for (var i = 0; i < S.ents.length; i++) { var e = S.ents[i]; if (e.kind === 'building' && !e.dead && e.owner === pid && e.type === type && !(e.offT > S.tick)) n++; }
    return n;
  }
  var offEnd = -1;   // letzter Tick, an dem noch ein Gebäude lahmgelegt ist (Laufzeit-Cache wie drainEnd)

  // ---- Minenfeld
  function tickMine(b, md) {
    if ((S.tick + b.id) % 3 !== 0 || b.cdT > S.tick) return;
    var R = md.trig * TILE, x = b.x, y = b.y, hit = false;
    var c0x = Math.max(0, Math.floor((x - R) / CELL)), c1x = Math.min(gw - 1, Math.floor((x + R) / CELL));
    var c0y = Math.max(0, Math.floor((y - R) / CELL)), c1y = Math.min(gh - 1, Math.floor((y + R) / CELL));
    for (var cy = c0y; cy <= c1y && !hit; cy++) for (var cx = c0x; cx <= c1x; cx++) {
      for (var k = gHead[cy * gw + cx]; k !== -1; k = gNext[k]) {
        var u = gEnts[k];
        if (u.owner === b.owner || u.owner < 0 || u.dead || u.mc >= 2 || u.pc === 4) continue;   // nur gegnerische Bodeneinheiten (nicht schwebend)
        if (dist2(u.x, u.y, x, y) <= (R + u.r * 0.5) * (R + u.r * 0.5)) { hit = true; break; }
      }
      if (hit) break;
    }
    if (!hit) return;
    var AR = md.r * TILE;
    b.ch = (b.ch || 1) - 1; b.cdT = S.tick + Math.round(md.cd * HZ); b.revT = S.tick + D.CLOAK.actReveal * HZ;
    emit('mine', x, y, { id: b.id, owner: b.owner, r: AR, left: b.ch });
    S.players[b.owner].st.mineHits = (S.players[b.owner].st.mineHits || 0) + 1;
    areaDamage(b.owner, x, y, AR, { owner: b.owner, kind: 'x', stealth: true, type: 'minefield' }, function (tt, dd) {
      if (tt.kind !== 'unit' || tt.pc === 4) return 0;
      return md.dmg * D.DAMAGE.mine[ust(tt).armor] * (1 - 0.5 * Math.min(1, dd / AR));
    });
    if (b.ch <= 0) { emit('die', x, y, { owner: b.owner, type: b.type, kind: 'building', id: b.id, w: 1, h: 1, src: 0, used: true }); removeEntity(b); }
  }

  // ---- Saboteur: ord 'sab', sabId (Zielgebäude), sabMode (0 = Sprengladung, 1 = lahmlegen), cd (Ticks bis zur nächsten Ladung)
  // S.charges: gelegte Sprengladungen { t (Zündtick), bid, owner, src, dmg, x, y }. GEBÄUDE offT (lahmgelegt bis Tick).
  function sabBlock(pid, b) {
    if (!b || b.dead || b.kind !== 'building') return 'Kein Gebäude';
    if (b.owner === pid) return 'Eigenes Gebäude';
    if (b.owner < 0 || b.neutral) return 'Nur gegnerische Basisgebäude';
    if (hidden(pid, b)) return 'Kein Gebäude';
    return '';
  }
  function orderSab(e, b) {
    orderStop(e);
    e.ord = 'sab'; e.sabId = b.id;
    var bd = D.BUILDINGS[b.type];
    if (bd.noOcc) { setGoal(e, b.x, b.y); return; }
    var ring = ringTiles(b), w = S.map.w, best = -1, bdist = 1e18;
    for (var i = 0; i < ring.length; i++) { var cx = (ring[i] % w + 0.5) * TILE, cy = (Math.floor(ring[i] / w) + 0.5) * TILE, d = dist2(cx, cy, e.x, e.y); if (d < bdist) { bdist = d; best = ring[i]; } }
    if (best < 0) setGoal(e, b.x, b.y + b.h * TILE / 2 + TILE / 2);
    else setGoal(e, (best % w + 0.5) * TILE, (Math.floor(best / w) + 0.5) * TILE);
  }
  function tickSab(e, st) {
    var b = byId.get(e.sabId), sb = st.saboteur;
    if (sabBlock(e.owner, b)) { orderStop(e); return; }
    var near = distTo(b, e.x, e.y) <= TILE * 0.8 + e.r;
    if (!near) {
      if (!(followPath(e, st) || checkStuck(e))) return;
      if (distTo(b, e.x, e.y) > TILE * 1.7 + e.r) { if ((e.sabTry = (e.sabTry || 0) + 1) <= 3) orderSab(e, b); else { e.sabTry = 0; orderStop(e); } return; }
    }
    e.moving = false; e.path = null; e.pp = false; e.sabTry = 0;
    if (e.cd > 0) return;   // lädt noch nach: wartet am Gebäude
    var P = S.players[e.owner];
    e.cd = Math.round(sb.cd * HZ); e.revT = S.tick + D.CLOAK.actReveal * HZ; e.fireT = S.tick;
    P.st.sabotage = (P.st.sabotage || 0) + 1;
    if (e.sabMode === 1) {
      b.offT = S.tick + Math.round(sb.stun * HZ); b.tgt = 0; offEnd = Math.max(offEnd, b.offT);
      recalcPower();
      emit('sabotage', b.x, b.y, { id: b.id, src: e.id, owner: e.owner, victim: b.owner, mode: 'stun', t2: b.offT, type: b.type });
    } else {
      S.charges.push({ t: S.tick + Math.round(sb.delay * HZ), bid: b.id, owner: e.owner, src: e.id, dmg: sb.dmg, x: b.x, y: b.y });
      emit('sabotage', b.x, b.y, { id: b.id, src: e.id, owner: e.owner, victim: b.owner, mode: 'bomb', t2: S.tick + Math.round(sb.delay * HZ), type: b.type });
    }
    var Pv = S.players[b.owner]; if (Pv) { Pv.alert.tick = S.tick; Pv.alert.x = b.x; Pv.alert.y = b.y; Pv.alert.harv = false; Pv.alert.bld = true; Pv.st.stealthHits = (Pv.st.stealthHits || 0) + 1; Pv.stealthT = S.tick; }
    orderStop(e);
  }
  function tickCharges() {
    for (var i = S.charges.length - 1; i >= 0; i--) {
      var c = S.charges[i];
      if (S.tick < c.t) continue;
      S.charges.splice(i, 1);
      var b = byId.get(c.bid), src = byId.get(c.src);
      emit('sabBoom', c.x, c.y, { id: c.bid, owner: c.owner });
      if (b && !b.dead && b.owner !== c.owner) damage(b, c.dmg, src && !src.dead && src.owner === c.owner ? src : { owner: c.owner, kind: 'x', stealth: true, type: 'saboteur' });
    }
  }

  // ---- Erzlager: P.oreCap = D.ORE_CAP.base + Summe store der eigenen Gebäude. Sinkt die Kapazität unter den Kontostand (Lager verloren),
  // verfällt der Überschuss (P.st.capLost, Ereignis capLost {owner, lost}); steigende Kapazität und Altstände ohne oreCap ändern nichts.
  function recalcCap() {
    if (!D.ORE_CAP) return;
    var cap = [], p, i;
    for (p = 0; p < S.players.length; p++) cap.push(D.ORE_CAP.base);
    for (i = 0; i < S.ents.length; i++) {
      var e = S.ents[i];
      if (e.kind !== 'building' || e.dead || e.owner < 0 || e.neutral) continue;
      var st = D.BUILDINGS[e.type].store;
      if (st) cap[e.owner] += st;
    }
    for (p = 0; p < S.players.length; p++) {
      var P = S.players[p], old = P.oreCap;
      P.oreCap = cap[p];
      if (old != null && cap[p] < old && !P.cheat && !P.defeated && P.credits > cap[p]) {
        var lost = P.credits - cap[p];
        P.credits = cap[p]; P.st.capLost = (P.st.capLost || 0) + lost;
        emit('capLost', 0, 0, { owner: p, lost: Math.round(lost) });
      }
    }
  }

  // ---- Gebäude-Tick der v1.2-Gebäude (Datenfeld x12)
  function tickBld12(b, bd) {
    if (bd.repairPad) tickRepairPad(b, bd.repairPad);
    else if (bd.gate) { if ((S.tick + b.id) % 5 === 0) b.open = unitNear(b.owner, b.x, b.y, 1.7 * TILE); }
    else if (bd.mine) tickMine(b, bd.mine);
  }
  /** Steht eine eigene Bodeneinheit von pid im Umkreis R px um (x,y)? (räumliches Gitter) */
  function unitNear(pid, x, y, R) {
    var c0x = Math.max(0, Math.floor((x - R) / CELL)), c1x = Math.min(gw - 1, Math.floor((x + R) / CELL));
    var c0y = Math.max(0, Math.floor((y - R) / CELL)), c1y = Math.min(gh - 1, Math.floor((y + R) / CELL));
    for (var cy = c0y; cy <= c1y; cy++) for (var cx = c0x; cx <= c1x; cx++) {
      for (var k = gHead[cy * gw + cx]; k !== -1; k = gNext[k]) {
        var u = gEnts[k];
        if (u.owner === pid && !u.dead && u.mc < 2 && dist2(u.x, u.y, x, y) <= R * R) return true;
      }
    }
    return false;
  }

  // ---- Reparaturdock: repariert eigene Fahrzeuge im Umkreis gegen Credits (Mechanik der neutralen Werkstatt, aber kostenpflichtig).
  // GEBÄUDE repT (Tick der letzten Reparatur – für die Darstellung). EINHEIT repId (Ziel-Dock von G.cmd.repairAt, 0 = keins).
  function tickRepairPad(b, rp) {
    if ((S.tick + b.id) % 10 !== 0 || b.offT > S.tick) return;
    var P = S.players[b.owner]; if (!P) return;
    var heal = rp.rate * 10 / HZ * (lowPower(b.owner) ? 0.5 : 1), R = rp.r * TILE;
    var x0 = b.tx * TILE - R, y0 = b.ty * TILE - R, x1 = (b.tx + b.w) * TILE + R, y1 = (b.ty + b.h) * TILE + R;
    var c0x = Math.max(0, Math.floor(x0 / CELL)), c1x = Math.min(gw - 1, Math.floor(x1 / CELL));
    var c0y = Math.max(0, Math.floor(y0 / CELL)), c1y = Math.min(gh - 1, Math.floor(y1 / CELL));
    for (var cy = c0y; cy <= c1y; cy++) for (var cx = c0x; cx <= c1x; cx++) {
      for (var k = gHead[cy * gw + cx]; k !== -1; k = gNext[k]) {
        var u = gEnts[k];
        if (u.owner !== b.owner || u.dead || u.hp >= u.maxHp || u.mc !== 1) continue;
        var st = ust(u);
        if (st.cat !== 'vehicle' || distTo(b, u.x, u.y) > R) continue;
        var h = Math.min(heal, u.maxHp - u.hp), cost = h / u.maxHp * (st.cost || 0) * rp.cost;
        if (P.credits < cost) continue;
        P.credits -= cost; P.st.spent += cost; P.st.repaired = (P.st.repaired || 0) + h;
        u.hp += h; b.repT = S.tick;
        if (u.hp >= u.maxHp) { u.hp = u.maxHp; if (u.repId) { u.repId = 0; emit('repairFull', u.x, u.y, { id: u.id, owner: u.owner, type: u.type, unit: true }); } }
      }
    }
  }
  /** Reparaturstelle für Fahrzeuge? (eigenes Reparaturdock oder eroberte Werkstatt) */
  function isRepairSite(pid, b) {
    if (!b || b.dead || b.kind !== 'building' || b.owner !== pid) return false;
    var d = D.BUILDINGS[b.type];
    return !!d.repairPad || d.special === 'repair';
  }
  /** Nächste Reparaturstelle von pid zu (x,y) oder null. */
  function repairSite(pid, x, y) {
    var best = null, bd = 1e18;
    for (var i = 0; i < S.ents.length; i++) {
      var b = S.ents[i];
      if (!isRepairSite(pid, b)) continue;
      var d = dist2(b.x, b.y, x, y);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }
  function canRepairUnit(u) { return !!u && u.kind === 'unit' && !u.dead && !u.inside && u.mc === 1 && ust(u).cat === 'vehicle'; }

  function setState(st) { S = st; rebuild(); }
  /** v0.7: verbleibende Friedenszeit in Sekunden (0 = vorbei bzw. keine). */
  function peaceLeft() { return S ? Math.max(0, (S.settings.peace || 0) - S.tick / HZ) : 0; }

  G.Sim = {
    S: null, create: create, step: step, setState: setState, rebuild: rebuild,
    get: get, statsOf: statsOf, mods: mods, unitStats: function (pid, type) { return stats[pid][type]; },
    isVisible: isVisible, distTo: distTo, entityAt: entityAt, unitsInRect: unitsInRect,
    canPlace: canPlace, canProduce: canProduce, hasBuilding: hasBuilding, countOf: countOf,
    costOf: costOf, timeOf: timeOf, lowPower: lowPower, producerOf: producerOf, tileOf: tileOf,
    rand: function () { return rand(); },
    // intern für cmd.js:
    _orderMove: orderMove, _orderAttack: orderAttack, _orderStop: orderStop, _orderHarvest: orderHarvest,
    _orderReturn: orderReturn, _produce: produce, _cancel: cancel, _place: placeBuilding, _sell: sell,
    _emit: emit,
    _setCheat: setCheat, CHEAT_CREDITS: CHEAT_CREDITS,
    // v0.3:
    _orderEnter: orderEnter, _ejectAll: ejectAll, _artillery: artillery, enterBlock: enterBlock, hostile: hostile,
    explored: explored, ringTiles: ringTiles,
    // v0.4:
    _superweapon: superweapon, swRemaining: swRemaining, engBlock: engBlock, engineerAction: engineerAction, isEngineer: isEngineer,
    // v0.5:
    _placeWall: placeWall, _deploy: deploy, canPlaceWall: canPlaceWall, canDeploy: canDeploy, canDeployAt: canDeployAt,
    nearBase: nearBase, isWall: isWall,
    // v0.7:
    peaceLeft: peaceLeft, isApc: isApc, loadBlock: loadBlock, _load: load, _unload: unload, healable: healable,
    // v0.8:
    airborne: airborne, canHit: canHit, canCarry: canCarry, usedSlots: usedSlots, slotOf: slotOf, isTransport: isApc, nearShore: nearShore,
    heliCanLand: heliCanLand, airPads: airPads, airPadBlock: airPadBlock, padPos: padPos, homeOf: function (e) { return homeOf(e); },
    canPlaceShore: canPlaceShore, shoreSpot: shoreSpot, _bomb: orderBomb,
    // v1.0 Kollektiv:
    controllable: controllable, mcList: function (e) { return e && e.mcList ? mcList(e) : []; }, psiOf: psiOf, pcOf: pcOf, _recycle: orderRecycle, recycleBlock: recycleBlock,
    ust: function (e) { return ust(e); },
    // v1.2 Neue Einheiten:
    hidden: hidden, cloakState: cloakState, sabBlock: sabBlock, _orderSab: orderSab, _sabMode: function (u, m) { u.sabMode = m ? 1 : 0; }, noOccAt: noOccAt,
    isRepairSite: isRepairSite, repairSite: repairSite, canRepairUnit: canRepairUnit, _orderRepair: function (u, site) { u.repId = site.id; },
    // nur für Tests/Debug (nicht von Spiellogik/KI/UI benutzen):
    _debugSpawn: function (owner, type, x, y) { return spawnUnit(owner, type, x, y); },
    _debugKill: function (id) { var e = byId.get(id); if (e) damage(e, 1e9, null); },
    _debugBuild: function (owner, type, tx, ty) { var b = addBuilding(owner, type, tx, ty, true); if (D.BUILDINGS[type].superweapon) announceSW(b); return b; }
  };
})();
