/* FRONTLINIE – cmd.js
 * G.cmd: Befehls-API. EINZIGER Weg (für Mensch und KI), den Sim-Zustand zu verändern.
 * Alle Funktionen nehmen die Spieler-ID (pid) als erstes Argument und prüfen den Besitz.
 * Rückgabe: { ok: bool, reason: string } (reason ist deutscher Anzeigetext).
 *
 *  move(pid, ids, x, y)            Bewegen (Weltpixel), Gruppe verteilt sich in Formation
 *  attackMove(pid, ids, x, y)      Angriff-Bewegen: unterwegs Gegner bekämpfen
 *  attack(pid, ids, targetId)      Ziel angreifen
 *  stop(pid, ids)                  Anhalten
 *  harvest(pid, ids, tileIdx)      Sammler: Erz sammeln (tileIdx = Kachel oder -1 = automatisch)
 *  returnOre(pid, ids, refId)      Sammler: zur Raffinerie
 *  smart(pid, ids, x, y)           Kontextbefehl (wie Rechtsklick): Gegner→angreifen, Erz→sammeln, sonst bewegen
 *  produce(pid, type)              Produktion starten / +1 in Warteschlange
 *  cancel(pid, type)               letztes Element dieses Typs abbrechen (Rückerstattung)
 *  placeBuilding(pid, type, tx, ty) fertiges Gebäude setzen (linke obere Kachel)
 *  sell(pid, id)                   Gebäude verkaufen (50 %)
 *  repair(pid, id, on?)            Reparatur umschalten
 *  repairAll(pid, on?)             v0.9.2 Reparatur: alle beschädigten eigenen Gebäude umschalten → {ok, n, on}
 *  setAutoRepair(pid, on)          v0.9.2 Reparatur: Auto-Reparatur (Spieler-Flag autoRepair, in Spielständen)
 *  setRally(pid, id, x, y)         Sammelpunkt eines Produktionsgebäudes
 *  setOption(key, val)             'fogOff' / 'speed' (Anzeige/Tempo, keine Spiellogik)
 *  v0.3 (SPEC_v03 §4):
 *  enter(pid, ids, buildingId)     Infanterie besetzt Gebäude (garrison) bzw. erobert Spezialgebäude (special).
 *                                  Rückgabe zusätzlich {kind:'enter'|'capture', n: Anzahl losgeschickter Einheiten}
 *  exit(pid, buildingId)           alle Insassen steigen aus
 *  artillery(pid, buildingId, x, y) Artillerieschlag (Weltpixel)
 *  v0.4 (SPEC_v04):
 *  superweapon(pid, buildingId, x, y) Orbitalschlag/Rakete (ganze Karte, Ziel erforscht)
 *  enter(...) mit Ingenieur: gegnerisches Basisgebäude übernehmen / eigenes beschädigtes reparieren /
 *                            neutrales Spezialgebäude sofort erobern. Rückgabe kind:'engineer', action:'capture'|'repair'
 *  v0.5 (SPEC_v05):
 *  placeWall(pid, tiles)           Mauersegmente (Kachelindizes y*w+x, max. 30) sofort setzen, je 50 Credits;
 *                                  Rückgabe {ok, reason, placed, skipped, ids, cost}
 *  deploy(pid, unitId)             Mobilen Bauhof zum HQ aufbauen (Gründe „Hier ist kein Platz“, „Untergrund nicht bebaubar“)
 *  enter(...) / exit(...)          auch für den baubaren Bunker 'pbunker' (nur eigene Infanterie)
 *  smart(...)                      Infanterie + Tipp auf eigenen Bunker → enter (res.kind = 'enter')
 *  v0.8:
 *  produce/cancel/placeBuilding   Gebäude mit defense:true laufen in der eigenen Warteschlange P.q.defense (parallel zu P.q.building)
 *  setCheat(pid, on)               Cheat „unbegrenzt Geld“ ein/aus (nur Mensch; P.cheat, P.cheatUsed)
 *  v0.7 (SPEC_v07 §1):
 *  load(pid, infIds, apcId)        Infanterie läuft zum eigenen Schützenpanzer und steigt ein (cap 5; nächste zuerst)
 *                                  Rückgabe {ok, reason, kind:'load', n}; Gründe „Kein Schützenpanzer“, „Schützenpanzer ist voll“,
 *                                  „Nur Infanterie kann einsteigen“
 *  unload(pid, apcId)              alle Insassen steigen an freien Nachbarkacheln aus → {ok, reason, n}; Grund „Keine Insassen“
 *  smart(...)                      Infanterie-Auswahl + Tipp auf eigenen Schützenpanzer → load (res.kind = 'load');
 *                                  unbewaffnete Nicht-Sammler (mcv, Ingenieur, Sanitäter) fahren/laufen bei Tipp auf den Boden
 *  v0.8 (SPEC_v08):
 *  load(pid, ids, transportId)     für alle Transporter: Schützenpanzer/Transporthubschrauber (Infanterie), Landungsboot (Infanterie +
 *                                  Fahrzeuge, 1/2/3 Plätze); Hubschrauber setzt dazu auf, Landungsboot muss am Ufer liegen
 *  unload(pid, transportId[, x, y]) ohne Ziel: sofort (Hubschrauber landet, Boot fährt ans nächste Ufer); mit Ziel: hinfliegen/-fahren,
 *                                  dort absetzen (ord 'drop'). Rückgabe kind:'drop' bei verzögertem Ausladen
 *  bomb(pid, ids, x, y)            Bomber: Bombenteppich über (x, y); Grund „Bomber lädt nach“, wenn keiner Bomben an Bord hat
 *  attack(...)                     nur Einheiten, die das Ziel treffen können (Luftziele: antiAir); Bomber → Bombenteppich auf das Ziel
 *  move/attackMove/smart           Luftfahrzeuge in lockerer Formation (Gitter), Schiffe über Wasser-Slots
 *  v1.2 (Neue Einheiten & Zusatzgebäude):
 *  repairAt(pid, ids[, siteId])    Fahrzeuge fahren zur Reparaturstelle (eigenes Reparaturdock / eroberte Werkstatt; ohne siteId die nächste)
 *                                  → {ok, reason, kind:'repair', n}
 *  smart(...)                      Fahrzeuge + Tipp auf eigene Reparaturstelle → repairAt (res.kind = 'repair')
 *  sabotage(pid, ids, buildingId)  Saboteure laufen zum gegnerischen Basisgebäude und legen eine Sprengladung bzw. legen es lahm (je nach Modus)
 *                                  → {ok, reason, kind:'sabotage', n}
 *  sabMode(pid, ids, mode)         Modus der Saboteure: 0 = Sprengladung, 1 = lahmlegen
 *  smart(...)                      Saboteur + Tipp auf gegnerisches Basisgebäude → sabotage (res.kind = 'sabotage')
 *  attack(...)                     getarnte, nicht aufgedeckte Ziele sind kein Ziel („Kein Ziel“)
 * v1.3 Forschung:
 *  research(pid, id)               Forschung id (D.RESEARCH) starten → {ok, reason}
 *  cancelResearch(pid)             laufende Forschung abbrechen (Rückerstattung)
 * v1.3 Fähigkeiten:
 *  ability(pid, ids, abilityId[, target])  Spezialfähigkeit (D.ABILITIES) auslösen. Ohne Ziel (target 'none'): alle bereiten Einheiten aus ids mit dieser
 *                                  Fähigkeit; läuft sie bei allen schon und ist sie umschaltbar (toggle), wird sie beendet. Mit Ziel: target = {x, y}
 *                                  (Weltpixel) bzw. {id} (gegnerische Einheit/Gebäude) – EINE bereite Einheit in Reichweite löst aus.
 *                                  → {ok, reason, n[, unit, ended]}
 */
var G = (typeof G !== 'undefined') ? G : {};
(function () {
  'use strict';
  var TILE = G.DATA.TILE;
  var FAIL = function (r) { return { ok: false, reason: r }; };
  var OK = { ok: true, reason: '' };

  function active(pid) {
    var S = G.Sim.S;
    return S && !S.over && S.players[pid] && !S.players[pid].defeated;
  }
  /** Eigene, lebende Einheiten aus ids. */
  function ownUnits(pid, ids, filter) {
    var r = [];
    if (!ids) return r;
    for (var i = 0; i < ids.length; i++) {
      var e = G.Sim.get(ids[i]);
      if (e && !e.dead && e.kind === 'unit' && e.owner === pid && !e.inside && !e.host && (!filter || filter(e))) r.push(e);   // v1.2: Träger-Drohnen (host) nehmen keine Befehle an
    }
    return r;
  }
  function armed(e) { return !!G.Sim.statsOf(e).weapon; }

  /** Verteilt Einheiten auf Formations-Slots um (x,y) und gibt sie per Sim._orderMove aus. */
  function formationOrder(units, x, y, ord) {
    var S = G.Sim.S, w = S.map.w;
    // v0.8: Luft-, See- und Bodeneinheiten getrennt einteilen
    if (units.some(function (u) { return u.mc >= 2; })) {
      var air = units.filter(function (u) { return u.mc === 2; }), sea = units.filter(function (u) { return u.mc === 3; });
      if (air.length) airFormation(air, x, y, ord);
      if (sea.length) seaFormation(sea, x, y, ord);
      units = units.filter(function (u) { return u.mc < 2; });
      if (!units.length) return;
    }
    // v1.0: Schwebepanzer (Wegfindungsklasse 4) mit Zielkachel auf dem Wasser: eigene Slots über Land und Wasser
    if (units.length > 1 && units.some(function (u) { return u.pc === 4; }) && !G.Path.passableXY(1, Math.floor(x / TILE), Math.floor(y / TILE))) {
      var hov = units.filter(function (u) { return u.pc === 4; });
      seaFormation(hov, x, y, ord, 4);
      units = units.filter(function (u) { return u.pc !== 4; });
      if (!units.length) return;
    }
    if (units.length === 1) { G.Sim._orderMove(units[0], x, y, ord); return; }
    var veh = [], inf = [], cx = 0, cy = 0;
    for (var i = 0; i < units.length; i++) {
      (units[i].mc === 1 ? veh : inf).push(units[i]);
      cx += units[i].x; cy += units[i].y;
    }
    cx /= units.length; cy /= units.length;
    var gtx = Math.floor(x / TILE), gty = Math.floor(y / TILE);
    var cls = veh.length ? 1 : 0;
    var need = veh.length + Math.ceil(inf.length / 3);
    var rv = G.Path.flipOwner(S, units[0].owner);   // v0.8 Seitengleichheit: gespiegelte Formations-BFS/Infanterie-Dreieck
    var tiles = G.Path.slotTiles(cls, gtx, gty, need + 2, rv);
    if (!tiles.length) { for (i = 0; i < units.length; i++) G.Sim._orderMove(units[i], x, y, ord); return; }
    // Slots erzeugen: Fahrzeuge je Kachel, Infanterie zu dritt pro Kachel
    var vSlots = [], iSlots = [], ti = 0;
    var OFF = rv ? [[7, 6], [-7, 6], [0, -7]] : [[-7, -6], [7, -6], [0, 7]];
    // Infanterie nach vorn (Kacheln nahe Ziel), wenn sie die Mehrheit stellen, sonst Fahrzeuge zuerst
    var infFirst = inf.length > veh.length * 3;
    function takeV() { for (var k = 0; k < veh.length; k++) { var t = tiles[Math.min(ti++, tiles.length - 1)]; vSlots.push([(t % w + 0.5) * TILE, (Math.floor(t / w) + 0.5) * TILE]); } }
    function takeI() {
      var nt = Math.ceil(inf.length / 3);
      for (var k = 0; k < nt; k++) {
        var t = tiles[Math.min(ti++, tiles.length - 1)];
        for (var o = 0; o < 3; o++) iSlots.push([(t % w + 0.5) * TILE + OFF[o][0], (Math.floor(t / w) + 0.5) * TILE + OFF[o][1]]);
      }
    }
    if (infFirst) { takeI(); takeV(); } else { takeV(); takeI(); }
    assign(veh, vSlots, cx, cy, x, y, ord);
    assign(inf, iSlots, cx, cy, x, y, ord);
  }
  /** v0.8: Luftfahrzeuge – Gitter mit 1,2 Kacheln Abstand um (x, y), keine Geländeprüfung. */
  function airFormation(units, x, y, ord) {
    if (units.length === 1) { G.Sim._orderMove(units[0], x, y, ord); return; }
    var S = G.Sim.S, n = Math.ceil(Math.sqrt(units.length)), slots = [], cx = 0, cy = 0, sp = TILE * 1.2;
    for (var i = 0; i < units.length; i++) {
      var gx = i % n, gy = Math.floor(i / n);
      slots.push([Math.max(8, Math.min(S.map.w * TILE - 8, x + (gx - (n - 1) / 2) * sp)), Math.max(8, Math.min(S.map.h * TILE - 8, y + (gy - (n - 1) / 2) * sp))]);
      cx += units[i].x; cy += units[i].y;
    }
    assign(units, slots, cx / units.length, cy / units.length, x, y, ord);
  }
  /** v0.8: Schiffe – je Schiff eine Wasserkachel (BFS ab der nächsten Wasserkachel am Ziel). */
  function seaFormation(units, x, y, ord, cls) {
    var S = G.Sim.S, w = S.map.w;
    if (units.length === 1) { G.Sim._orderMove(units[0], x, y, ord); return; }
    var tiles = G.Path.slotTiles(cls || 3, Math.floor(x / TILE), Math.floor(y / TILE), units.length + 2, G.Path.flipOwner(S, units[0].owner)), slots = [], cx = 0, cy = 0;
    if (!tiles.length) { for (var k = 0; k < units.length; k++) G.Sim._orderMove(units[k], x, y, ord); return; }
    for (var i = 0; i < tiles.length; i++) slots.push([(tiles[i] % w + 0.5) * TILE, (Math.floor(tiles[i] / w) + 0.5) * TILE]);
    for (i = 0; i < units.length; i++) { cx += units[i].x; cy += units[i].y; }
    assign(units, slots, cx / units.length, cy / units.length, x, y, ord);
  }
  function assign(units, slots, cx, cy, x, y, ord) {
    if (!units.length) return;
    var used = new Uint8Array(slots.length);
    // Einheiten, die am weitesten vorn sind (näher am Ziel), wählen zuerst
    var dxm = x - cx, dym = y - cy, len = Math.sqrt(dxm * dxm + dym * dym) || 1;
    dxm /= len; dym /= len;
    var order = units.slice().sort(function (a, b) {
      var pa = (a.x - cx) * dxm + (a.y - cy) * dym, pb = (b.x - cx) * dxm + (b.y - cy) * dym;
      return pb - pa || a.id - b.id;
    });
    for (var i = 0; i < order.length; i++) {
      var u = order[i];
      // gewünschte Position: relative Lage in der Gruppe (gestaucht) beibehalten
      var wx = x + (u.x - cx) * 0.4, wy = y + (u.y - cy) * 0.4;
      var best = -1, bd = 1e12;
      for (var s = 0; s < slots.length; s++) {
        if (used[s]) continue;
        var d = (slots[s][0] - wx) * (slots[s][0] - wx) + (slots[s][1] - wy) * (slots[s][1] - wy);
        if (d < bd) { bd = d; best = s; }
      }
      if (best < 0) { G.Sim._orderMove(u, x, y, ord); continue; }
      used[best] = 1;
      G.Sim._orderMove(u, slots[best][0], slots[best][1], ord);
    }
  }

  var cmd = {
    move: function (pid, ids, x, y) {
      if (!active(pid)) return FAIL('Nicht aktiv');
      var us = ownUnits(pid, ids);
      if (!us.length) return FAIL('Keine Einheiten');
      formationOrder(us, x, y, 'move');
      return OK;
    },
    attackMove: function (pid, ids, x, y) {
      if (!active(pid)) return FAIL('Nicht aktiv');
      var us = ownUnits(pid, ids, armed);
      var hv = ownUnits(pid, ids, function (e) { return !armed(e); });
      if (hv.length) formationOrder(hv, x, y, 'move');
      if (!us.length) return hv.length ? OK : FAIL('Keine Kampfeinheiten');
      formationOrder(us, x, y, 'amove');
      return OK;
    },
    attack: function (pid, ids, targetId) {
      if (!active(pid)) return FAIL('Nicht aktiv');
      var t = G.Sim.get(targetId);
      if (!t || t.dead || t.inside || G.Sim.hidden(pid, t)) return FAIL('Kein Ziel');   // v1.2: Getarntes ist kein Ziel
      if (t.neutral) {
        if (G.DATA.BUILDINGS[t.type].invuln) return FAIL('Unzerstörbar – mit Infanterie erobern');
        if (t.ruin) return FAIL('Ruine');
        if (t.owner < 0) return FAIL('Neutrales Gebäude');
      }
      if (t.owner === pid) return FAIL('Eigene Einheit');
      var us = ownUnits(pid, ids, armed);
      if (!us.length) return FAIL('Keine Kampfeinheiten');
      // v0.8: nur Einheiten, die das Ziel treffen können (Luftziele nur mit Flugabwehr); Bomber nur mit Bomben an Bord
      var can = us.filter(function (e) { var st = G.Sim.statsOf(e); return G.Sim.canHit(st.weapon, t) && !(st.bomber && !(e.ammo > 0)); });
      if (!can.length) {
        if (G.Sim.airborne(t)) return FAIL('Keine Flugabwehr – Luftziele nur mit Raketen/Flak');
        if (us.some(function (e) { return G.Sim.statsOf(e).bomber; })) return FAIL('Bomber lädt nach');
        if (us.some(function (e) { var w = G.Sim.statsOf(e).weapon; return w && w.psi; })) return FAIL(t.kind === 'building' ? 'Gebäude sind Psi-immun' : 'Nicht übernehmbar (Psi-immun oder schon kontrolliert)');   // v1.0
        if (us.some(function (e) { var w = G.Sim.statsOf(e).weapon; return w && w.navalOnly; })) return FAIL('Torpedos treffen nur Schiffe');
        if (us.some(function (e) { var w = G.Sim.statsOf(e).weapon; return w && w.vehicleOnly; })) return FAIL('Magnet wirkt nur auf Fahrzeuge und Schiffe');
        return FAIL('Ziel nicht angreifbar');
      }
      for (var i = 0; i < can.length; i++) G.Sim._orderAttack(can[i], targetId);
      return OK;
    },
    stop: function (pid, ids) {
      if (!active(pid)) return FAIL('Nicht aktiv');
      var us = ownUnits(pid, ids);
      for (var i = 0; i < us.length; i++) G.Sim._orderStop(us[i]);
      return OK;
    },
    harvest: function (pid, ids, tileIdx) {
      if (!active(pid)) return FAIL('Nicht aktiv');
      var us = ownUnits(pid, ids, function (e) { return !!G.Sim.statsOf(e).harvester; });
      if (!us.length) return FAIL('Keine Sammler');
      for (var i = 0; i < us.length; i++) G.Sim._orderHarvest(us[i], tileIdx == null ? -1 : tileIdx);
      return OK;
    },
    returnOre: function (pid, ids, refId) {
      if (!active(pid)) return FAIL('Nicht aktiv');
      var us = ownUnits(pid, ids, function (e) { return !!G.Sim.statsOf(e).harvester; });
      for (var i = 0; i < us.length; i++) G.Sim._orderReturn(us[i], refId);
      return us.length ? OK : FAIL('Keine Sammler');
    },
    /** Kontextbefehl. Liefert zusätzlich {kind:'attack'|'harvest'|'return'|'move'} für Rückmeldung. */
    smart: function (pid, ids, x, y) {
      if (!active(pid)) return FAIL('Nicht aktiv');
      var S = G.Sim.S;
      var t = G.Sim.entityAt(x, y, pid, 10);
      var harv = ownUnits(pid, ids, function (e) { return !!G.Sim.statsOf(e).harvester; });
      var fight = ownUnits(pid, ids, armed);
      // Fix v0.5.1: unbewaffnete Nicht-Sammler (Mobiler Bauhof, Ingenieur, …) fahren ebenfalls
      var other = ownUnits(pid, ids, function (e) { return !armed(e) && !G.Sim.statsOf(e).harvester; });
      var res = { ok: true, reason: '', kind: 'move' };
      // v0.3: neutrale/besetzbare/eroberbare Kartengebäude
      if (t && t.neutral && t.kind === 'building') {
        var inf = ownUnits(pid, ids, function (e) { return G.Sim.statsOf(e).cat === 'infantry'; });
        var hostileHouse = t.owner >= 0 && t.owner !== pid && !t.ruin && !G.DATA.BUILDINGS[t.type].invuln;
        if (hostileHouse) {
          if (fight.length) { cmd.attack(pid, ids, t.id); res.kind = 'attack'; }
          if (harv.length) formationOrder(harv, x, y, 'move');
          return res;
        }
        if (inf.length && !G.Sim.enterBlock(pid, t)) {
          var r = cmd.enter(pid, inf.map(function (e) { return e.id; }), t.id);
          var rest = ownUnits(pid, ids, function (e) { return e.ord !== 'enter'; });
          if (rest.length) formationOrder(rest, t.x, t.y + (t.h / 2 + 1.5) * TILE, 'move');
          r.kind = r.kind || 'enter';
          return r;
        }
        var all = ownUnits(pid, ids);
        if (all.length) formationOrder(all, t.x, t.y + (t.h / 2 + 1.5) * TILE, 'move');
        if (inf.length) { res.reason = G.Sim.enterBlock(pid, t); }
        return res;
      }
      // v0.7: eigener Schützenpanzer + Infanterie → einsteigen (der APC selbst und übrige Fahrzeuge bleiben stehen)
      // v0.8: alle Transporter (Hubschrauber: Infanterie, Landungsboot: Infanterie + Fahrzeuge)
      if (t && t.kind === 'unit' && t.owner === pid && G.Sim.isApc(t)) {
        var linf = ownUnits(pid, ids, function (e) { return e !== t && G.Sim.canCarry(t, e); });
        if (linf.length) {
          var lr = cmd.load(pid, linf.map(function (e) { return e.id; }), t.id);
          lr.kind = 'load';
          return lr;
        }
      }
      // v0.5: eigener Bunker (pbunker) + Infanterie → einsteigen
      if (t && t.kind === 'building' && t.owner === pid && G.DATA.BUILDINGS[t.type].garrisonOwn) {
        var binf = ownUnits(pid, ids, function (e) { return G.Sim.statsOf(e).cat === 'infantry' && !G.Sim.isEngineer(e); });
        if (binf.length && !G.Sim.enterBlock(pid, t)) {
          var br = cmd.enter(pid, binf.map(function (e) { return e.id; }), t.id);
          var brest = ownUnits(pid, ids, function (e) { return e.ord !== 'enter'; });
          if (brest.length) formationOrder(brest, t.x, t.y + (t.h / 2 + 1.5) * TILE, 'move');
          br.kind = br.kind || 'enter';
          return br;
        }
      }
      // v0.4: Ingenieur-Auswahl + Tipp auf gegnerisches (oder eigenes beschädigtes) Basisgebäude → enter
      if (t && t.kind === 'building' && !t.neutral) {
        var engs = ownUnits(pid, ids, function (e) { return G.Sim.isEngineer(e); });
        if (engs.length && G.Sim.engineerAction(pid, t)) {
          var er = cmd.enter(pid, engs.map(function (e) { return e.id; }), t.id);
          if (er.ok) {
            if (t.owner !== pid && fight.length) cmd.attack(pid, fight.map(function (e) { return e.id; }), t.id);
            var rest2 = ownUnits(pid, ids, function (e) { return e.ord !== 'enter' && !G.Sim.statsOf(e).weapon && !G.Sim.statsOf(e).harvester; });
            if (rest2.length) formationOrder(rest2, t.x, t.y + (t.h / 2 + 1.5) * TILE, 'move');
            if (harv.length) formationOrder(harv, x, y, 'move');
            return er;
          }
        }
      }
      // v1.2: Saboteur + Tipp auf gegnerisches Basisgebäude → Sprengladung / lahmlegen
      if (t && t.kind === 'building' && t.owner !== pid && t.owner >= 0 && !t.neutral) {
        var sabs = ownUnits(pid, ids, function (e) { return !!G.Sim.statsOf(e).saboteur; });
        if (sabs.length) {
          var sr = cmd.sabotage(pid, sabs.map(function (e) { return e.id; }), t.id);
          if (sr.ok) {
            if (fight.length) cmd.attack(pid, fight.map(function (e) { return e.id; }), t.id);
            var srest = ownUnits(pid, ids, function (e) { return !armed(e) && !G.Sim.statsOf(e).saboteur; });
            if (srest.length) formationOrder(srest, x, y, 'move');
            return sr;
          }
        }
      }
      if (t && t.owner !== pid) {
        if (fight.length) { cmd.attack(pid, ids, t.id); res.kind = 'attack'; }
        if (harv.length) formationOrder(harv, x, y, 'move');
        if (other.length) formationOrder(other, x, y, 'move');
        return res;
      }
      // v1.2: Fahrzeuge + Tipp auf eigene Reparaturstelle (Reparaturdock / eroberte Werkstatt) → zur Reparatur
      if (t && t.kind === 'building' && G.Sim.isRepairSite(pid, t)) {
        var rv = ownUnits(pid, ids, function (e) { return G.Sim.canRepairUnit(e); });
        if (rv.length) {
          var rres = cmd.repairAt(pid, rv.map(function (e) { return e.id; }), t.id);
          var rrest = ownUnits(pid, ids, function (e) { return !G.Sim.canRepairUnit(e); });
          if (rrest.length) formationOrder(rrest, x, y, 'move');
          return rres;
        }
      }
      // v1.0 Kollektiv: Bodeneinheiten (außer Sammlern) + Tipp auf eigenen Erzwandler → recyceln
      if (t && t.kind === 'building' && t.type === 'refinery' && t.owner === pid && S.players[pid].faction === 'kollektiv') {
        var rec = ownUnits(pid, ids, function (e) { return !G.Sim.statsOf(e).harvester && !G.Sim.recycleBlock(pid, e, t); });
        if (rec.length) {
          var rr = cmd.recycle(pid, rec.map(function (e) { return e.id; }), t.id);
          if (harv.length) cmd.returnOre(pid, harv.map(function (e) { return e.id; }), t.id);
          rr.kind = 'recycle';
          return rr;
        }
      }
      var ti = G.Sim.tileOf(x, y);
      if (harv.length) {
        if (t && t.type === 'refinery' && t.owner === pid) { cmd.returnOre(pid, harv.map(function (e) { return e.id; }), t.id); res.kind = 'return'; }
        else if (S.map.ore[ti] > 0) { cmd.harvest(pid, harv.map(function (e) { return e.id; }), ti); res.kind = 'harvest'; }
        else formationOrder(harv, x, y, 'move');
      }
      if (fight.length) formationOrder(fight, x, y, 'move');
      if (other.length) formationOrder(other, x, y, 'move');
      return res;
    },
    /** Infanterie besetzt/erobert Gebäude. Besetzen: so viele wie Plätze frei (nächste zuerst); Erobern: eine Einheit. */
    enter: function (pid, ids, buildingId) {
      if (!active(pid)) return FAIL('Nicht aktiv');
      var b = G.Sim.get(buildingId);
      if (!b || b.dead || b.kind !== 'building') return FAIL('Kein Gebäude');
      var all = ownUnits(pid, ids, function (e) { return !e.inside; });
      if (!all.length) return FAIL('Keine Einheiten');
      var inf = all.filter(function (e) { return G.Sim.statsOf(e).cat === 'infantry'; });
      if (!inf.length) return FAIL('Nur Infanterie kann Gebäude betreten');
      // v0.4: Ingenieure – Basisgebäude (übernehmen/reparieren) und Spezialgebäude (sofort erobern)
      var engs = inf.filter(function (e) { return G.Sim.isEngineer(e); });
      var bd = G.DATA.BUILDINGS[b.type];
      // v0.5: eigener unbeschädigter Bunker – Ingenieure übergehen, übrige Infanterie steigt ein
      var ownBunker = bd.garrisonOwn && b.owner === pid && !!G.Sim.engBlock(pid, b);
      if (engs.length && (!bd.neutral || bd.kind2 === 'special') && !ownBunker) {
        var ew = G.Sim.engBlock(pid, b);
        if (ew) return FAIL(ew);
        // schon ein eigener Ingenieur unterwegs zu diesem Gebäude?
        for (var j = 0; j < G.Sim.S.ents.length; j++) {
          var oe = G.Sim.S.ents[j];
          if (!oe.dead && oe.owner === pid && oe.ord === 'enter' && oe.enterId === b.id && engs.indexOf(oe) < 0 && G.Sim.isEngineer(oe)) return FAIL('Ingenieur ist schon unterwegs');
        }
        engs.sort(function (a, c) { return (G.Sim.distTo(b, a.x, a.y) - G.Sim.distTo(b, c.x, c.y)) || (a.id - c.id); });
        G.Sim._orderEnter(engs[0], b);
        return { ok: true, reason: '', kind: 'engineer', action: G.Sim.engineerAction(pid, b), n: 1 };
      }
      inf = inf.filter(function (e) { return !G.Sim.isEngineer(e) || bd.neutral; });
      if (!inf.length) return FAIL(G.Sim.engBlock(pid, b) || 'Nicht betretbar');
      var why = G.Sim.enterBlock(pid, b);
      if (why) return FAIL(why);
      var d = G.DATA.BUILDINGS[b.type];
      var special = d.kind2 === 'special';
      // bereits auf dem Weg befindliche eigene Einheiten zählen mit
      var coming = 0;
      for (var i = 0; i < G.Sim.S.ents.length; i++) {
        var o = G.Sim.S.ents[i];
        if (!o.dead && o.owner === pid && o.ord === 'enter' && o.enterId === b.id && inf.indexOf(o) < 0) coming++;
      }
      var free = special ? (coming ? 0 : 1) : b.cap - b.gar.length - coming;
      if (free <= 0) return FAIL(special ? 'Wird bereits erobert' : 'Gebäude ist voll');
      inf.sort(function (a, c) { return (G.Sim.distTo(b, a.x, a.y) - G.Sim.distTo(b, c.x, c.y)) || (a.id - c.id); });
      var n = Math.min(free, inf.length);
      for (i = 0; i < n; i++) G.Sim._orderEnter(inf[i], b);
      return { ok: true, reason: '', kind: special ? 'capture' : 'enter', n: n };
    },
    /** v1.0 Kollektiv: Einheiten fahren zum eigenen Erzwandler (refinery) und werden für 50 % der Baukosten recycelt
     *  (auch gedankenkontrollierte Einheiten des Gegners). Rückgabe {ok, reason, n}. */
    recycle: function (pid, ids, refId) {
      if (!active(pid)) return FAIL('Nicht aktiv');
      var ref = G.Sim.get(refId), us = ownUnits(pid, ids), why = '', n = 0;
      for (var i = 0; i < us.length; i++) { var w = G.Sim.recycleBlock(pid, us[i], ref); if (w) { why = w; continue; } G.Sim._recycle(us[i], ref); n++; }
      if (!n) return FAIL(why || 'Keine Einheiten');
      return { ok: true, reason: '', n: n };
    },
    /** v1.2: Fahrzeuge fahren zur Reparaturstelle (siteId oder die nächste eigene) und werden dort gegen Credits repariert. */
    repairAt: function (pid, ids, siteId) {
      if (!active(pid)) return FAIL('Nicht aktiv');
      var us = ownUnits(pid, ids, function (e) { return G.Sim.canRepairUnit(e); });
      if (!us.length) return FAIL('Nur Fahrzeuge können repariert werden');
      var cx = 0, cy = 0, i;
      for (i = 0; i < us.length; i++) { cx += us[i].x; cy += us[i].y; }
      cx /= us.length; cy /= us.length;
      var site = siteId ? G.Sim.get(siteId) : G.Sim.repairSite(pid, cx, cy);
      if (!site || !G.Sim.isRepairSite(pid, site)) return FAIL(siteId ? 'Keine Reparaturstelle' : 'Kein Reparaturdock vorhanden');
      // Stellplatz vor dem Gebäude, auf der Seite der anfahrenden Einheiten
      var dx = cx - site.x, dy = cy - site.y, dl = Math.sqrt(dx * dx + dy * dy) || 1, off = (Math.max(site.w, site.h) / 2 + 1.4) * TILE;
      formationOrder(us, site.x + dx / dl * off, site.y + dy / dl * off, 'move');
      for (i = 0; i < us.length; i++) G.Sim._orderRepair(us[i], site);
      return { ok: true, reason: '', kind: 'repair', n: us.length };
    },
    /** v1.2: Saboteure sabotieren ein gegnerisches Basisgebäude (Sprengladung oder lahmlegen, je nach Modus der Einheit). */
    sabotage: function (pid, ids, buildingId) {
      if (!active(pid)) return FAIL('Nicht aktiv');
      var b = G.Sim.get(buildingId), why = G.Sim.sabBlock(pid, b);
      if (why) return FAIL(why);
      var us = ownUnits(pid, ids, function (e) { return !!G.Sim.statsOf(e).saboteur; });
      if (!us.length) return FAIL('Kein Saboteur');
      for (var i = 0; i < us.length; i++) G.Sim._orderSab(us[i], b);
      return { ok: true, reason: '', kind: 'sabotage', n: us.length, mode: us[0].sabMode ? 'stun' : 'bomb' };
    },
    sabMode: function (pid, ids, mode) {
      if (!active(pid)) return FAIL('Nicht aktiv');
      var us = ownUnits(pid, ids, function (e) { return !!G.Sim.statsOf(e).saboteur; });
      if (!us.length) return FAIL('Kein Saboteur');
      for (var i = 0; i < us.length; i++) G.Sim._sabMode(us[i], mode);
      return { ok: true, reason: '', mode: mode ? 1 : 0 };
    },
    /** v0.7: Infanterie steigt in den Schützenpanzer. */
    load: function (pid, ids, apcId) {
      if (!active(pid)) return FAIL('Nicht aktiv');
      var a = G.Sim.get(apcId);
      if (!G.Sim.isApc(a)) return FAIL('Kein Schützenpanzer');
      if (a.owner !== pid) return FAIL('Nicht in deinem Besitz');
      var us = ownUnits(pid, ids, function (e) { return e !== a; });
      if (!us.length) return FAIL('Keine Einheiten');
      return G.Sim._load(pid, us, apcId);
    },
    /** v0.7: alle Insassen des Schützenpanzers steigen aus. v0.8: optional Absetzpunkt (x, y) – Transporter fährt/fliegt hin. */
    unload: function (pid, apcId, x, y) {
      if (!active(pid)) return FAIL('Nicht aktiv');
      return G.Sim._unload(pid, apcId, x, y);
    },
    /** v0.8: Bomber werfen einen Bombenteppich über (x, y) ab und kehren danach zum Nachladen zurück. */
    bomb: function (pid, ids, x, y) {
      if (!active(pid)) return FAIL('Nicht aktiv');
      var bs = ownUnits(pid, ids, function (e) { return !!G.Sim.statsOf(e).bomber; });
      if (!bs.length) return FAIL('Keine Bomber');
      var rdy = bs.filter(function (e) { return e.ammo > 0; });
      if (!rdy.length) return FAIL('Bomber lädt nach');
      var n = Math.ceil(Math.sqrt(rdy.length));
      for (var i = 0; i < rdy.length; i++) G.Sim._bomb(rdy[i], x + ((i % n) - (n - 1) / 2) * TILE * 1.5, y + (Math.floor(i / n) - (n - 1) / 2) * TILE * 1.5, 0);
      return { ok: true, reason: rdy.length < bs.length ? (bs.length - rdy.length) + ' Bomber laden noch nach' : '', n: rdy.length };
    },
    exit: function (pid, buildingId) {
      if (!active(pid)) return FAIL('Nicht aktiv');
      var b = G.Sim.get(buildingId);
      if (!b || b.dead || b.kind !== 'building' || !(b.neutral || G.DATA.BUILDINGS[b.type].garrisonOwn)) return FAIL('Kein besetzbares Gebäude');
      if (b.owner !== pid || !b.gar || !b.gar.length) return FAIL('Keine eigenen Insassen');
      G.Sim._ejectAll(b);
      return OK;
    },
    artillery: function (pid, buildingId, x, y) {
      if (!active(pid)) return FAIL('Nicht aktiv');
      return G.Sim._artillery(pid, buildingId, x, y);
    },
    /** v0.4: Superwaffe auslösen. Gründe: „Lädt noch (m:ss)“, „Ziel unerforscht“, „Keine Superwaffe“. */
    superweapon: function (pid, buildingId, x, y) {
      if (!active(pid)) return FAIL('Nicht aktiv');
      return G.Sim._superweapon(pid, buildingId, x, y);
    },
    /** v0.5: Mauersegmente setzen (SPEC_v05 §2). */
    placeWall: function (pid, tiles) {
      if (!active(pid)) return { ok: false, reason: 'Nicht aktiv', placed: 0 };
      return G.Sim._placeWall(pid, tiles);
    },
    /** v0.5: Mobilen Bauhof aufbauen (SPEC_v05 §3). */
    deploy: function (pid, unitId) {
      if (!active(pid)) return FAIL('Nicht aktiv');
      return G.Sim._deploy(pid, unitId);
    },
    /** v0.8: Cheat „unbegrenzt Geld“ (nur Mensch). */
    setCheat: function (pid, on) {
      if (!active(pid)) return FAIL('Nicht aktiv');
      return G.Sim._setCheat(pid, on);
    },
    /** v1.3 Forschung starten (eine je Spieler, Tech-Zentrum nötig). → {ok, reason} */
    research: function (pid, id) {
      if (!active(pid)) return FAIL('Nicht aktiv');
      var why = G.Sim.resBlock(pid, id);
      if (why) return FAIL(why);
      return G.Sim._research(pid, id) ? OK : FAIL('Nicht möglich');
    },
    /** v1.3 Fähigkeiten: Spezialfähigkeit auslösen (s. Kopfkommentar). */
    ability: function (pid, ids, abilityId, target) {
      if (!active(pid)) return FAIL('Nicht aktiv');
      var us = ownUnits(pid, ids);
      if (!us.length) return FAIL('Keine Einheiten');
      return G.Sim._ability(pid, us, abilityId, target || null);
    },
    /** v1.3 laufende Forschung abbrechen (volle Rückerstattung des bisher Bezahlten). */
    cancelResearch: function (pid) {
      if (!active(pid)) return FAIL('Nicht aktiv');
      return G.Sim._resCancel(pid) ? OK : FAIL('Keine Forschung aktiv');
    },
    produce: function (pid, type) {
      if (!active(pid)) return FAIL('Nicht aktiv');
      return G.Sim._produce(pid, type);
    },
    cancel: function (pid, type) {
      if (!active(pid)) return FAIL('Nicht aktiv');
      return G.Sim._cancel(pid, type) ? OK : FAIL('Nichts abzubrechen');
    },
    placeBuilding: function (pid, type, tx, ty) {
      if (!active(pid)) return FAIL('Nicht aktiv');
      return G.Sim._place(pid, type, tx, ty);
    },
    sell: function (pid, id) {
      if (!active(pid)) return FAIL('Nicht aktiv');
      return G.Sim._sell(pid, id) ? OK : FAIL('Nicht verkaufbar');
    },
    repair: function (pid, id, on) {
      if (!active(pid)) return FAIL('Nicht aktiv');
      var b = G.Sim.get(id);
      if (!b || b.dead || b.owner !== pid || b.kind !== 'building') return FAIL('Kein Gebäude');
      if (b.neutral) return FAIL('Nicht reparierbar');
      b.repairing = (on == null) ? !b.repairing : !!on;
      if (b.hp >= b.maxHp) b.repairing = false;
      return OK;
    },
    // v0.9.2 Reparatur: alle eigenen beschädigten Gebäude auf einmal (on null = umschalten: läuft mindestens eine nicht → alle an, sonst alle aus)
    repairAll: function (pid, on) {
      if (!active(pid)) return FAIL('Nicht aktiv');
      var S = G.Sim.S, list = [], i, e, anyOff = false;
      for (i = 0; i < S.ents.length; i++) {
        e = S.ents[i];
        if (e.dead || e.kind !== 'building' || e.owner !== pid || e.neutral || e.ruin || e.hp >= e.maxHp) continue;
        list.push(e); if (!e.repairing) anyOff = true;
      }
      var v = (on == null) ? anyOff : !!on;
      for (i = 0; i < list.length; i++) list[i].repairing = v;
      return { ok: true, reason: '', n: list.length, on: v && list.length > 0 };
    },
    // v0.9.2 Reparatur: Auto-Reparatur je Spieler (gespeichert in S.players[pid].autoRepair; Standard aus)
    setAutoRepair: function (pid, on) {
      if (!active(pid)) return FAIL('Nicht aktiv');
      G.Sim.S.players[pid].autoRepair = !!on;
      return OK;
    },
    /** Anzeige-/Partieoptionen ('fogOff': bool, 'speed': 'slow'|'normal'|'fast'), ohne Einfluss auf die Spiellogik. */
    setOption: function (key, val) {
      var S = G.Sim.S; if (!S) return FAIL('Keine Partie');
      if (key === 'fogOff') S.settings.fogOff = !!val;
      else if (key === 'speed' && G.DATA.SPEEDS[val]) S.settings.speed = val;
      else return FAIL('Unbekannt');
      return OK;
    },
    setRally: function (pid, id, x, y) {
      if (!active(pid)) return FAIL('Nicht aktiv');
      var b = G.Sim.get(id);
      if (!b || b.dead || b.owner !== pid || b.kind !== 'building') return FAIL('Kein Gebäude');
      var d = G.DATA.BUILDINGS[b.type];
      if (!d.produces) return FAIL('Kein Produktionsgebäude');
      b.rx = x; b.ry = y;
      return OK;
    }
  };
  G.cmd = cmd;
})();
