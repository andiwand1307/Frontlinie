/* FRONTLINIE – ai.js
 * G.AI: Computer-Gegner. Ein Controller pro KI-Spieler (S.players[i].ai = 'easy'|'medium'|'hard').
 * Arbeitet ausschließlich über G.cmd.* (gleiche Befehle wie der Mensch). Lesen darf die KI:
 * eigene Entitäten, für sie sichtbare Gegner (G.Sim.isVisible), erinnerte Gebäude (P.mem), ob ein Gegner menschlich ist (v1.0.1),
 * Kartendaten inkl. gegnerischer Startposition. Einziger Bonus: 'hard' +25 % Erz (in sim.js).
 * Der KI-Zustand liegt als reine Daten in S.aiState[pid] (wird mitgespeichert).
 *
 * v0.5 (SPEC_v05 §4): baut Bunker (pbunker, mit Infanterie besetzt) und den Fraktionsturm (laser/tesla) an der
 * Hauptangriffsrichtung (A.thrX/thrY = geglättete Position der Angriffe auf die Basis), setzt (Mittel/Schwer) sparsam
 * Mauerlinien vor Engstellen auf dem Weg zum Gegner (mit Durchlass; Erreichbarkeit per BFS geprüft), expandiert ab ~9–10 min
 * mit dem Mobilen Bauhof an entfernte Erzfelder (Raffinerie dort). Mauern durchbrechen die Einheiten selbst (sim.js),
 * die KI wählt Mauern nie als Angriffsziel. Leicht: keine Mauern, kein mcv, kein Fraktionsturm.
 *
 * v0.7 (SPEC_v07): Friedenszeit (S.settings.peace) und frühester erster Angriff (D.AI_FIRST_ATTACK: Leicht 8, Mittel 6,
 * Schwer 4 min): vorher keine Angriffswellen/Gegenstöße, keine Superwaffe, keine Ingenieur-Übernahme, Artillerie und
 * Angriffe auf besetzte Häuser nur nahe der eigenen Basis; Verteidigung und Eroberung von Spezialgebäuden erlaubt.
 * Alle von cfg.first abhängigen Zeitmarken (Heimwache, Spätphase, Patt-Brecher) verschieben sich um denselben Betrag.
 * Neue Einheiten: Scharfschützen (Koalition) / Flammenwerfer (Syndikat) je nach gegnerischem Infanterieanteil,
 * Raketenwerfer (Syndikat) gegen bekannte Türme, Laser-/Blitzpanzer im Kern (Tech), Sanitäter bei Infanteriegruppen
 * (begleiten die Welle), Schützenpanzer (Koalition) bringt Ingenieur/Infanterie zu entfernten Spezialgebäuden (A.apcJob).
 *
 * v0.8 (SPEC_v08 §6, eigener Block airSea()): Flugfeld ab AIRSEA[stufe].airAt, Werft nur, wenn am Start ein Werft-Platz am eigenen Ufer liegt
 * und dasselbe Gewässer bis an die gegnerische Basis reicht (A.navy). Bomber gegen Einheitenballungen/Verteidigung (Flak in der Nähe meiden),
 * Kampfhubschrauber begleiten die Welle bzw. verteidigen, Transporthubschrauber/Landungsboot für gelegentliche Absetzaktionen
 * (A.heliJob / A.landJob), Flak-Stellungen + mehr Raketentrupps, sobald gegnerische Luftfahrzeuge gesehen wurden, Schiffe greifen
 * über das Wasser an. Luft-/Seeeinheiten gehören nicht zu den Bodenwellen (military()). Angriffe erst ab canAttack() (Friedenszeit,
 * frühester erster Angriff unverändert).
 *
 * v1.0.1 KI-Leicht (SPEC_v10 §10, Block am Dateiende): Stufe „Sehr leicht“ (veryeasy); Leicht/Sehr leicht mit Wellen-Obergrenze (Stückzahl, wächst je Welle),
 * Mindestabstand zwischen Wellen, Rückzug bei Verlusten, Spezial-Infanterie erst spät, Flugfeld/Werft spät bzw. nie, kleinere Armee. Mittel gegen
 * MENSCHEN gedämpft (VS_HUMAN, cfgFor) – KI gegen KI (Balance-Serien) bleibt bitgleich. Keine Erz-/Bau-Boni oder -Abzüge in sim.js.
 */
var G = (typeof G !== 'undefined') ? G : {};
(function () {
  'use strict';
  var D = G.DATA, TILE = D.TILE;

  var DIFF = {
    easy:   { interval: 40, wave: 4,  first: 300, growth: 1, maxWave: 10, defense: 2, turrets: 1, harvPerRef: 1, reinforce: false, armyQ: 1,
              capFrom: 240, capJobs: 1, garMax: 3, artyMin: 6, recap: 90, counter: false, push: false, late: 5,
              ref2At: 600, maxRef: 2, maxHarv: 2, armyCap: [6, 1.2],
              ahead: 1, techAt: 720, sw: false, swMin: 0, eng: false, dodge: false, techShare: 0.35,
              bunkers: 1, bunkerAt: 540, bunkerFill: 2, defNeed: 4, towers5: 0, wallSeg: 0, wallAt: 0, wallLines: 0, mcv: false, mcvAt: 0, maxHq: 1,
              medics: 1, apcJobs: 0, apcMax: 0 },
    medium: { interval: 20, wave: 7,  first: 210, growth: 2, maxWave: 16, defense: 3, turrets: 2, harvPerRef: 2, reinforce: true, armyQ: 2,
              capFrom: 60, capJobs: 2, garMax: 6, artyMin: 5, recap: 45, counter: true, push: true, late: 4,
              ref2At: 0, maxRef: 3, maxHarv: 5, armyCap: null,
              ahead: 2, techAt: 370, sw: true, swMin: 2600, eng: true, dodge: true, techShare: 0.7,
              bunkers: 1, bunkerAt: 480, bunkerFill: 2, defNeed: 4, towers5: 1, wallSeg: 4, wallAt: 540, wallLines: 1, mcv: true, mcvAt: 600, maxHq: 2,
              medics: 2, apcJobs: 1, apcMax: 5 },
    hard:   { interval: 10, wave: 10, first: 150, growth: 3, maxWave: 22, defense: 4, turrets: 3, harvPerRef: 2, reinforce: true, armyQ: 2,
              capFrom: 30, capJobs: 3, garMax: 8, artyMin: 4, recap: 30, counter: true, push: true, late: 4,
              ref2At: 0, maxRef: 3, maxHarv: 5, armyCap: null,
              ahead: 3, techAt: 270, sw: true, swMin: 2200, eng: true, dodge: true, techShare: 0.75,
              bunkers: 2, bunkerAt: 300, bunkerFill: 4, defNeed: 2, towers5: 2, wallSeg: 12, wallAt: 420, wallLines: 2, mcv: true, mcvAt: 540, maxHq: 2,
              medics: 3, apcJobs: 1, apcMax: 7 }
  };
  var TOWERS = { turret: 1, mg: 1, pbunker: 1, laser: 1, tesla: 1, psitower: 1 };   // gegnerische Verteidigungsanlagen (meiden / Haubitzen)
  var PLAN = ['power', 'refinery', 'barracks', 'power', 'factory', 'refinery', 'power', 'turret', 'mg'];

  var S, P, A, pid, cfg;

  function ents(filter) {
    var r = [];
    for (var i = 0; i < S.ents.length; i++) { var e = S.ents[i]; if (!e.dead && filter(e)) r.push(e); }
    return r;
  }
  function mine(kind, type) { return ents(function (e) { return e.owner === pid && e.kind === kind && (!type || e.type === type); }); }
  function d2(ax, ay, bx, by) { return (ax - bx) * (ax - bx) + (ay - by) * (ay - by); }
  // ---- v0.7: Friedenszeit / frühester Angriff ----
  /** Ab dieser Spielsekunde darf die KI angreifen (frühester erster Angriff je Stärke, Friedenszeit, cfg.first). */
  function atkFrom() { return Math.max(cfg.first, D.AI_FIRST_ATTACK[P.ai] || 0, S.settings.peace || 0); }
  function canAttack() { return S.tick / D.TICK_HZ >= atkFrom() && G.Sim.peaceLeft() <= 0; }
  /** Verschiebung aller auf cfg.first bezogenen Zeitmarken. */
  function tShift() { return Math.max(0, atkFrom() - cfg.first); }
  /** Von einem Auftrag (APC-Fahrt) reservierte Einheiten. */
  function reserved(e) { var J = A.apcJob; return (!!J && (e.id === J.apc || (J.units && J.units.indexOf(e.id) >= 0))) || reservedV08(e) || (!!A.rep && A.rep[e.id] != null); }   // v1.2: A.rep = Fahrzeuge in Reparatur

  function initState() {
    var st = S.map.starts[pid], en = S.map.starts[1 - pid] || S.map.starts[0];
    var hx = (st.tx + 1.5) * TILE, hy = (st.ty + 1.5) * TILE;
    var ex = (en.tx + 1.5) * TILE, ey = (en.ty + 1.5) * TILE;
    // Sammelpunkt: von der Basis 7 Kacheln Richtung Kartenmitte
    var mx = S.map.w * TILE / 2, my = S.map.h * TILE / 2, dx = mx - hx, dy = my - hy, l = Math.sqrt(dx * dx + dy * dy) || 1;
    var rx = hx + dx / l * 7 * TILE, ry = hy + dy / l * 7 * TILE;
    var ri = G.Path.nearestPassable(1, Math.floor(rx / TILE), Math.floor(ry / TILE), 5, hx + hy > (S.map.w + S.map.h) * TILE / 2);   // v0.8: gespiegelter Gleichstand
    if (ri >= 0) { rx = (ri % S.map.w + 0.5) * TILE; ry = (Math.floor(ri / S.map.w) + 0.5) * TILE; }
    return {
      planIdx: 0, homeX: hx, homeY: hy, enemyX: ex, enemyY: ey, rallyX: rx, rallyY: ry,
      waveSize: cfg.wave, waves: 0, tx: 0, ty: 0, attack: [], attackStart: 0, attackTarget: null, lastTargetT: 0,
      defending: false, lastDefT: -9999, placeFails: 0, seenTanks: 0, seenInf: 0, seenLight: 0, seenSn: 0
    };
  }

  // ------------------------------------------------------------------ Hauptschleife
  function update(state) {
    S = state;
    for (var i = 0; i < S.players.length; i++) {
      var pl = S.players[i];
      if (!pl.ai || pl.defeated || S.over) continue;
      cfg = cfgFor(pl, i);   // v1.0.1 KI-Leicht: gegen Menschen ggf. mit VS_HUMAN-Anpassung (KI gegen KI unverändert)
      if ((S.tick + i * 7) % cfg.interval !== 0) continue;
      P = pl; pid = i;
      if (!S.aiState[pid]) S.aiState[pid] = initState();
      A = S.aiState[pid];
      think();
    }
  }

  function think() {
    events();
    scout();
    economy();
    rallies();   // v0.8
    production();
    military();
    specials();
    superweapons();
    engineers();
    bunkers();
    walls();
    expand();
    medics();
    apcFerry();
    airSea();   // v0.8
    psiAI();    // v1.0 Gedankenkontrolle (eigene und gegnerische)
    v12();      // v1.2 Neue Einheiten & Zusatzgebäude (Block am Dateiende)
  }

  // ================================================================== v1.0 Kollektiv (SPEC_v10 §6)
  // KOLL: specShare/specInf/adeptVeh = Anteil der Spezial-Infanterie (Psi-Adept, Mutant) – Grundwert, + je gegnerischem Infanterieanteil,
  //       + Adept-Zuschlag gegen fahrzeuglastige Gegner; psiMax = höchstens Psi-Kolosse; psiNeed = Faktor auf cfg.swMin für die Psi-Welle;
  //       defR = Kacheln: eigene Einheiten in diesem Umkreis greifen einen sichtbaren gegnerischen Kontrolleur an (alle Fraktionen).
  var KOLL = { specShare: 0.12, specInf: 0.2, adeptVeh: 0.15, psiMax: 1, psiNeed: 1.0, defR: 12, defN: 4 };
  G.AI_KOLL = KOLL;   // für Balance-Versuche (tests/headless.js KOLL=…)
  /** Kern-Fahrzeug des Kollektivs: Magnet-Werfer gegen viele gegnerische Panzer, sonst Psi-Koloss (höchstens KOLL.psiMax). */
  function kollCore() {
    var pt = G.Sim.countOf(pid, 'psitank', 'unit');
    for (var i = 0; i < P.q.vehicle.length; i++) if (P.q.vehicle[i].type === 'psitank') pt++;
    if (pt >= KOLL.psiMax) return 'magnet';
    return (A.seenTanks || 0) > (A.seenInf || 0) + 2 ? 'magnet' : 'psitank';
  }
  /** Spezial-Infanterie: etwa ein Psi-Adept je drei Mutanten. */
  function kollSpecial() {
    var ad = G.Sim.countOf(pid, 'psiadept', 'unit'), br = G.Sim.countOf(pid, 'brute', 'unit'), q = P.q.infantry;
    for (var i = 0; i < q.length; i++) { if (q[i].type === 'psiadept') ad++; else if (q[i].type === 'brute') br++; }
    return ad * 3 <= br + 1 ? 'psiadept' : 'brute';
  }
  /** Gedankenkontrolle aus KI-Sicht (läuft für alle Fraktionen; ohne Kollektiv-Gegner passiert nichts):
   *  1) eigene, vom Gegner übernommene Einheiten zurückholen: nahe eigene Kampfeinheiten greifen den sichtbaren Kontrolleur an
   *     (stirbt er, kehren alle seine Einheiten zurück);
   *  2) Kollektiv: übernommene unbewaffnete Fremdeinheiten (Bauhof, Ingenieur, Sanitäter) am Erzwandler recyceln (50 % Credits). */
  function psiAI() {
    var i, k, lost = null;
    for (i = 0; i < S.ents.length; i++) {
      var e = S.ents[i];
      if (e.dead || e.kind !== 'unit' || !e.mcBy || e.mcOrig !== pid) continue;
      var c = G.Sim.get(e.mcBy);
      if (!c || c.dead || c.owner === pid || !G.Sim.isVisible(pid, c)) continue;
      (lost = lost || {})[c.id] = c;
    }
    if (lost && S.tick - (A.psiDefT || -1e9) >= 40) {
      A.psiDefT = S.tick;
      var R = KOLL.defR * TILE;
      for (var cid in lost) {
        var cc = lost[cid];
        var near = ents(function (u) {
          if (u.owner !== pid || u.kind !== 'unit' || u.inside || u.mc >= 2 || reserved(u) || u.ord === 'enter' || u.ord === 'load') return false;
          var st = G.Sim.statsOf(u);
          return !!st.weapon && !st.harvester && G.Sim.canHit(st.weapon, cc) && d2(u.x, u.y, cc.x, cc.y) < R * R && !(u.ord === 'attack' && u.tgt === cc.id);
        });
        near.sort(function (a, b) { return d2(a.x, a.y, cc.x, cc.y) - d2(b.x, b.y, cc.x, cc.y) || a.id - b.id; });
        if (near.length) G.cmd.attack(pid, ids(near.slice(0, KOLL.defN)), cc.id);
      }
    }
    if (P.faction !== 'kollektiv' || (S.tick + pid * 7) % 80 >= cfg.interval) return;
    var refs = mine('building', 'refinery');
    if (!refs.length) return;
    for (i = 0; i < S.ents.length; i++) {
      var u = S.ents[i];
      if (u.dead || u.kind !== 'unit' || u.owner !== pid || u.fac === P.faction || u.ord === 'recycle' || u.inside || u.mc >= 2) continue;
      var su = G.Sim.statsOf(u);
      if (su.weapon || su.harvester || (u.gar && u.gar.length)) continue;
      var best = null, bd = 1e18;
      for (k = 0; k < refs.length; k++) { var dd = d2(u.x, u.y, refs[k].x, refs[k].y); if (dd < bd) { bd = dd; best = refs[k]; } }
      if (best) G.cmd.recycle(pid, [u.id], best.id);
    }
  }


  /** v0.8 Seitengleichheit: Basis in der „zweiten“ Kartenhälfte (unten rechts)? Dann werden Gleichstände bei der Platzsuche in
   *  gespiegelter Reihenfolge aufgelöst (vorher gewann stets die Nordwest-Kachel: P0 baute vom Gegner weg, P1 auf ihn zu). */
  function flipped() { return A.homeX + A.homeY > (S.map.w + S.map.h) * TILE / 2; }
  /** Spiegel-konsistenter Gleichstandsschlüssel (Position im eigenen Blickwinkel; statt Entitäts-ID/Scanreihenfolge, die immer P0 bevorzugen). */
  function tk(x, y) { var v = Math.round(y) * 4096 + Math.round(x); return flipped() ? -v : v; }
  /** v0.8: Sammelpunkt an Kaserne/Fahrzeugwerk (wie ein Mensch) – neue Einheiten verlassen das Gebäude auf der Seite des Sammelpunkts. */
  function rallies() {
    for (var i = 0; i < S.ents.length; i++) {
      var b = S.ents[i];
      if (b.dead || b.kind !== 'building' || b.owner !== pid || b.rx >= 0) continue;
      var pr = D.BUILDINGS[b.type].produces;
      if (pr === 'infantry' || pr === 'vehicle') G.cmd.setRally(pid, b.id, A.rallyX, A.rallyY);
    }
  }

  // ------------------------------------------------------------------ v0.4 (SPEC_v04 §5)
  /** Öffentliche Ereignisse: gegnerische Superwaffe gebaut (→ Angriffsziel), Abschuss (→ ausweichen). */
  function events() {
    var E = S.events, last = A.evSeq || 0;
    for (var i = 0; i < E.length; i++) {
      var ev = E[i];
      if (ev.seq <= last) continue;
      if (ev.t === 'swBuilt' && ev.owner !== pid) { A.enemySW = ev.id; A.swRetarget = 1; }
      else if (ev.t === 'swLaunch' && ev.owner !== pid && cfg.dodge) dodge(ev);
    }
    if (E.length) A.evSeq = E[E.length - 1].seq;
    if (A.dodgeT && S.tick >= A.dodgeT) {
      // nach dem Einschlag: ausgewichene Angreifer wieder zum Ziel
      var back = (A.dodged || []).filter(function (id) { var u = G.Sim.get(id); return u && !u.dead && A.attack.indexOf(id) >= 0; });
      if (back.length) G.cmd.attackMove(pid, back, A.tx, A.ty);
      A.dodgeT = 0; A.dodged = [];
    }
  }
  /** Eigene Einheiten aus dem Zielgebiet eines gegnerischen Superwaffen-Schlags ziehen. */
  function dodge(ev) {
    var R = (D.SW[ev.kind].radius + 1.5) * TILE;
    var us = ents(function (e) { return e.owner === pid && e.kind === 'unit' && !e.inside && d2(e.x, e.y, ev.x, ev.y) < R * R; });
    if (!us.length) return;
    var moved = [];
    for (var i = 0; i < us.length; i++) {
      var u = us[i], dx = u.x - ev.x, dy = u.y - ev.y, l = Math.sqrt(dx * dx + dy * dy);
      if (l < 1) { dx = A.homeX - ev.x; dy = A.homeY - ev.y; l = Math.sqrt(dx * dx + dy * dy) || 1; }
      var tx = ev.x + dx / l * (R + TILE), ty = ev.y + dy / l * (R + TILE);
      var ti = G.Path.nearestPassable(u.mc, Math.floor(tx / TILE), Math.floor(ty / TILE), 4);
      if (ti < 0) continue;
      if (G.Sim.statsOf(u).harvester) G.cmd.move(pid, [u.id], (ti % S.map.w + 0.5) * TILE, (Math.floor(ti / S.map.w) + 0.5) * TILE);
      else G.cmd.move(pid, [u.id], (ti % S.map.w + 0.5) * TILE, (Math.floor(ti / S.map.w) + 0.5) * TILE);
      moved.push(u.id);
    }
    A.dodged = (A.dodged || []).concat(moved);
    A.dodgeT = Math.max(A.dodgeT || 0, ev.t2 + 10);
    // Sammler nach dem Einschlag wieder sammeln lassen
    A.harvBack = (A.harvBack || []).concat(us.filter(function (u) { return G.Sim.statsOf(u).harvester; }).map(function (u) { return u.id; }));
    A.harvBackT = ev.t2 + 10;
  }

  var SWVAL = { factory: 1800, refinery: 1500, techcenter: 2000, orbital: 3500, silo: 3500, psidome: 3500, barracks: 600, power: 400, turret: 600, mg: 450, hq: 300 };
  /** Superwaffe auf die größte Ballung gegnerischer Einheiten oder Produktionsgebäude (nur Bekanntes, Ziel erforscht). */
  function superweapons() {
    if (A.harvBackT && S.tick >= A.harvBackT) {
      var hb = (A.harvBack || []).filter(function (id) { var u = G.Sim.get(id); return u && !u.dead; });
      if (hb.length) G.cmd.harvest(pid, hb, -1);
      A.harvBack = []; A.harvBackT = 0;
    }
    if (!cfg.sw) return;
    var sws = ents(function (e) { return e.kind === 'building' && e.owner === pid && D.BUILDINGS[e.type].superweapon && e.charge >= 1; });
    if (!sws.length) { A.swWait = 0; return; }
    if (!A.swWait) A.swWait = S.tick;
    var b = sws[0], C = D.SW[D.BUILDINGS[b.type].superweapon], R = C.radius * TILE;
    var foes = ents(function (e) { return e.kind === 'unit' && e.owner !== pid && e.owner >= 0 && !e.inside && G.Sim.isVisible(pid, e); });
    var blds = [];
    for (var id in P.mem) {
      var m = P.mem[id];
      if (m.neutral || m.owner === pid || m.type === 'wall') continue;
      blds.push({ x: (m.tx + m.w / 2) * TILE, y: (m.ty + m.h / 2) * TILE, m: m });
    }
    var cands = foes.map(function (e) { return { x: e.x, y: e.y }; }).concat(blds);
    var best = null, bs = 0, exp = P.exp;
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      if (!exp[G.Sim.tileOf(c.x, c.y)]) continue;
      var sc = 0, k;
      if (C.psi) {   // v1.0 Psi-Welle: Wert der übernehmbaren Einheiten im Radius (Gebäude zählen nicht)
        for (k = 0; k < foes.length; k++) { var pf = foes[k]; if (d2(pf.x, pf.y, c.x, c.y) <= R * R && G.Sim.controllable(pf)) sc += G.Sim.statsOf(pf).cost; }
        if (sc > bs) { bs = sc; best = c; }
        continue;
      }
      for (k = 0; k < foes.length; k++) {
        var f = foes[k], dd = Math.sqrt(d2(f.x, f.y, c.x, c.y));
        if (dd > R) continue;
        var dm = C.dmg * (1 - (1 - C.edge) * dd / R);
        sc += G.Sim.statsOf(f).cost * Math.min(1, dm / Math.max(1, f.hp));
      }
      for (k = 0; k < blds.length; k++) {
        var bm = blds[k].m;
        var x0 = bm.tx * TILE, y0 = bm.ty * TILE, x1 = x0 + bm.w * TILE, y1 = y0 + bm.h * TILE;
        var ddx = c.x < x0 ? x0 - c.x : (c.x > x1 ? c.x - x1 : 0), ddy = c.y < y0 ? y0 - c.y : (c.y > y1 ? c.y - y1 : 0), db = Math.sqrt(ddx * ddx + ddy * ddy);
        if (db > R) continue;
        var bdm = C.dmg * C.bld * (1 - (1 - C.edge) * db / R);
        if (bm.type === 'hq') bdm = Math.min(bdm, bm.hp - 1);
        sc += (SWVAL[bm.type] || 300) * Math.min(1, bdm / Math.max(1, bm.hp)) * 1.5;
      }
      if (sc > bs) { bs = sc; best = c; }
    }
    if (!canAttack()) return;   // v0.7: keine Superwaffe in der Friedenszeit / vor dem ersten Angriff
    var waited = S.tick - A.swWait;
    var need = waited > 20 * 90 ? cfg.swMin * 0.35 : (waited > 20 * 40 ? cfg.swMin * 0.7 : cfg.swMin);
    if (C.psi) need *= KOLL.psiNeed;   // v1.0: Psi-Welle lohnt erst gegen eine größere Gruppe
    if (best && bs >= need) {
      if (G.cmd.superweapon(pid, b.id, best.x, best.y).ok) { A.swWait = 0; A.swShots = (A.swShots || 0) + 1; }
    }
  }

  /** Ingenieure: eigene stark beschädigte Gebäude reparieren; gelegentlich schlecht verteidigte gegnerische Gebäude übernehmen. */
  function engineers() {
    if (!cfg.eng) return;
    var engs = ents(function (e) { return e.owner === pid && e.kind === 'unit' && !e.inside && e.type === 'engineer' && !reserved(e); });
    var idle = engs.filter(function (e) { return e.ord !== 'enter'; });
    A.engWant = 0;
    // 1) Reparatur
    var hurt = ents(function (e) {
      return e.owner === pid && e.kind === 'building' && !e.neutral && e.hp < e.maxHp * 0.4 && enemiesNear(e.x, e.y, 8 * TILE) === 0;
    });
    hurt.sort(function (a, c) { return (SWVAL[c.type] || 300) - (SWVAL[a.type] || 300) || a.id - c.id; });
    var busy = {};
    engs.forEach(function (e) { if (e.ord === 'enter') busy[e.enterId] = 1; });
    for (var i = 0; i < hurt.length; i++) {
      if (busy[hurt[i].id]) continue;
      if (!idle.length) { if ((SWVAL[hurt[i].type] || 0) >= 600) A.engWant = 1; break; }
      idle.sort(function (a, c) { return d2(a.x, a.y, hurt[i].x, hurt[i].y) - d2(c.x, c.y, hurt[i].x, hurt[i].y) || a.id - c.id; });
      var r = G.cmd.enter(pid, [idle[0].id], hurt[i].id);
      if (r.ok) { busy[hurt[i].id] = 1; idle.shift(); }
    }
    // 2) Übernahme: Ziel nahe der eigenen Angriffsgruppe, kaum verteidigt (v0.7: nicht in der Friedenszeit)
    if (!A.attack.length || A.attack.length < 4 || !canAttack()) return;
    var gc = centroid(A.attack), best = null, bs = 0;
    for (var id in P.mem) {
      var m = P.mem[id];
      if (m.neutral || m.owner === pid || m.type === 'hq' || m.type === 'wall' || busy[m.id]) continue;
      var b = G.Sim.get(m.id);
      if (!b || b.dead || b.owner === pid || !G.Sim.isVisible(pid, b)) continue;
      if (d2(b.x, b.y, gc.x, gc.y) > 12 * 12 * TILE * TILE) continue;
      if (enemiesNear(b.x, b.y, 7 * TILE) > 1) continue;
      var tur = 0;
      for (var id2 in P.mem) { var t2 = P.mem[id2]; if (t2.owner !== pid && TOWERS[t2.type] && d2((t2.tx + t2.w / 2) * TILE, (t2.ty + t2.h / 2) * TILE, b.x, b.y) < 7 * 7 * TILE * TILE) tur++; }
      if (tur) continue;
      var sc = (SWVAL[b.type] || 300) * (b.hp / b.maxHp);
      if (sc > bs) { bs = sc; best = b; }
    }
    if (!best) return;
    if (!idle.length) { if (S.tick - (A.engT || -1e9) > 20 * 150) { A.engWant = 1; } return; }
    idle.sort(function (a, c) { return d2(a.x, a.y, best.x, best.y) - d2(c.x, c.y, best.x, best.y) || a.id - c.id; });
    if (G.cmd.enter(pid, [idle[0].id], best.id).ok) A.engT = S.tick;
  }

  // ------------------------------------------------------------------ v0.3: Kartengebäude (SPEC_v03 §7)
  /** Besitzer eines Kartengebäudes, wie die KI ihn kennt (sichtbar → echt, sonst Erinnerung, sonst neutral). */
  function knownOwner(b) {
    if (b.owner === pid || G.Sim.isVisible(pid, b)) return b.owner;
    var m = P.mem[b.id];
    return m ? m.owner : -1;
  }
  function neutralsOf(kind2) {
    return ents(function (e) { return e.kind === 'building' && e.neutral && D.BUILDINGS[e.type].kind2 === kind2; });
  }
  function isInf(e) { return G.Sim.statsOf(e).cat === 'infantry'; }

  function specials() {
    if (!A.capJobs) { A.capJobs = {}; A.artyWait = 0; A.garT = 0; }
    capture();
    garrison();
    attackGarrisons();
    artilleryStrike();
  }

  /** Schickt günstige Schützen zu nahen/mittleren Spezialgebäuden; holt verlorene zurück. */
  function capture() {
    var secs = S.tick / D.TICK_HZ;
    if (secs < cfg.capFrom) return;
    var specs = neutralsOf('special');
    if (!specs.length) return;
    // laufende Aufträge prüfen
    var active = 0;
    for (var bid in A.capJobs) {
      var j = A.capJobs[bid], u = G.Sim.get(j.u), b = G.Sim.get(+bid);
      var consumed = b && b.capBy === pid;
      if (b && b.owner === pid) { delete A.capJobs[bid]; A.capOk = A.capOk || {}; A.capOk[bid] = S.tick; continue; }
      if (consumed) { j.t = S.tick; active++; continue; }
      if (!u || u.dead || u.ord !== 'enter' || S.tick - j.t > 20 * 90) { delete A.capJobs[bid]; continue; }
      active++;
    }
    if (active >= cfg.capJobs) return;
    // Front: Schwerpunkt der laufenden Angriffsgruppe (dort darf auch auf gegnerischer Seite erobert werden)
    var fx = 0, fy = 0, fn = 0;
    for (i = 0; i < A.attack.length; i++) { var au = G.Sim.get(A.attack[i]); if (au) { fx += au.x; fy += au.y; fn++; } }
    if (fn) { fx /= fn; fy /= fn; }
    var cands = [];
    for (var i = 0; i < specs.length; i++) {
      var b = specs[i];
      if (A.capJobs[b.id] || b.capBy === pid || knownOwner(b) === pid || (A.apcJob && A.apcJob.b === b.id)) continue;
      if (A.capOk && S.tick - (A.capOk[b.id] || -1e9) < 20 * cfg.recap) continue; // kürzlich verloren: nicht sofort Pingpong
      var dh = Math.sqrt(d2(b.x, b.y, A.homeX, A.homeY)), de = Math.sqrt(d2(b.x, b.y, A.enemyX, A.enemyY));
      var atFront = fn >= 4 && d2(b.x, b.y, fx, fy) < 12 * 12 * TILE * TILE;
      if (dh > de * 1.1 && !atFront) continue;          // gegnerische Hälfte nur, wenn die eigene Angriffsgruppe dort steht
      if (enemiesNear(b.x, b.y, 7 * TILE) > 0) {
        // umkämpft: eigenes (verlorenes) Spezialgebäude auf der eigenen Hälfte → Heimtruppen räumen es frei
        if (dh <= de * 1.1 && !A.defending && S.tick - (A.retakeT || -1e9) > 20 * 30 && (canAttack() || dh < 18 * TILE)) {
          var hm = ents(function (e) { return e.owner === pid && e.kind === 'unit' && !e.inside && e.ord === 'idle' && !!G.Sim.statsOf(e).weapon &&
                                              A.attack.indexOf(e.id) < 0 && d2(e.x, e.y, A.homeX, A.homeY) < 24 * 24 * TILE * TILE; });
          if (hm.length >= Math.max(3, enemiesNear(b.x, b.y, 7 * TILE))) { G.cmd.attackMove(pid, ids(hm), b.x, b.y + (b.h / 2 + 1) * TILE); A.retakeT = S.tick; }
        }
        continue;
      }
      var prio = { oil: 0, arty: 4, radar: 6, repair: 8, heal: 9 }[D.BUILDINGS[b.type].special] || 5;
      cands.push({ b: b, s: dh / TILE + prio * 2 + (knownOwner(b) >= 0 ? -6 : 0) });
    }
    if (!cands.length) return;
    cands.sort(function (a, c) { return a.s - c.s || tk(a.b.x, a.b.y) - tk(c.b.x, c.b.y) || a.b.id - c.b.id; });
    var inAtk = {};
    for (i = 0; i < A.attack.length; i++) inAtk[A.attack[i]] = 1;
    var busy = {};
    for (var k in A.capJobs) busy[A.capJobs[k].u] = 1;
    for (var c = 0; c < cands.length && active < cfg.capJobs; c++) {
      var tb = cands[c].b;
      var pool = ents(function (e) {
        return e.owner === pid && e.kind === 'unit' && !e.inside && e.type === 'rifle' && !busy[e.id] && e.ord !== 'enter' && !reserved(e) &&
               (inAtk[e.id] ? d2(e.x, e.y, tb.x, tb.y) < 14 * 14 * TILE * TILE : (e.ord === 'idle' || e.ord === 'move'));
      });
      if (!pool.length) {
        A.wantRifle = 1;
        // kein Schütze frei: Raketentrupp nimmt nahe Spezialgebäude auf der eigenen Hälfte
        pool = ents(function (e) {
          return e.owner === pid && e.kind === 'unit' && !e.inside && e.type === 'rocket' && !busy[e.id] && !inAtk[e.id] && e.ord === 'idle' && !reserved(e) &&
                 d2(e.x, e.y, tb.x, tb.y) < 16 * 16 * TILE * TILE;
        });
        if (!pool.length) return;
      }
      pool.sort(function (a, e) { return d2(a.x, a.y, tb.x, tb.y) - d2(e.x, e.y, tb.x, tb.y) || a.id - e.id; });
      var r = G.cmd.enter(pid, [pool[0].id], tb.id);
      if (r.ok) { A.capJobs[tb.id] = { u: pool[0].id, t: S.tick }; busy[pool[0].id] = 1; active++; }
    }
  }

  /** Bei Verteidigung: Häuser in Basisnähe/an der Front mit Infanterie besetzen; bei Einsturzgefahr räumen. */
  function garrison() {
    var houses = neutralsOf('garrison');
    if (!houses.length) return;
    var inside = 0, i;
    for (i = 0; i < houses.length; i++) {
      var h = houses[i];
      if (h.owner !== pid) continue;
      inside += h.gar.length;
      if (h.hp < h.maxHp * 0.2 && h.gar.length) G.cmd.exit(pid, h.id); // räumen, bevor es zur Ruine wird
    }
    if (A.allIn && !A.defending) { for (i = 0; i < houses.length; i++) if (houses[i].owner === pid && houses[i].gar.length) G.cmd.exit(pid, houses[i].id); return; }
    if (!A.defending || inside >= cfg.garMax) return;
    var al = P.alert;
    var inAtk = {};
    for (i = 0; i < A.attack.length; i++) inAtk[A.attack[i]] = 1;
    var cands = [];
    for (i = 0; i < houses.length; i++) {
      h = houses[i];
      if (h.ruin || h.hp < h.maxHp * 0.4 || G.Sim.enterBlock(pid, h)) continue;
      var dh = d2(h.x, h.y, A.homeX, A.homeY), da = d2(h.x, h.y, al.x, al.y), dr = d2(h.x, h.y, A.rallyX, A.rallyY);
      if (dh > 16 * 16 * TILE * TILE && dr > 6 * 6 * TILE * TILE) continue;   // Basisnähe oder Front (Sammelpunkt)
      if (da > 12 * 12 * TILE * TILE) continue;                               // nahe am Kampfgeschehen
      cands.push({ h: h, s: da });
    }
    cands.sort(function (a, c) { return a.s - c.s || tk(a.h.x, a.h.y) - tk(c.h.x, c.h.y) || a.h.id - c.h.id; });
    for (var c = 0; c < cands.length && inside < cfg.garMax; c++) {
      var hh = cands[c].h;
      var pool = ents(function (e) {
        return e.owner === pid && e.kind === 'unit' && !e.inside && isInf(e) && e.type !== 'engineer' && e.type !== 'medic' && !inAtk[e.id] && e.ord !== 'enter' &&
               e.ord !== 'load' && !reserved(e) && d2(e.x, e.y, hh.x, hh.y) < 12 * 12 * TILE * TILE;
      });
      if (!pool.length) continue;
      pool.sort(function (a, e) { return d2(a.x, a.y, hh.x, hh.y) - d2(e.x, e.y, hh.x, hh.y) || a.id - e.id; });
      var take = pool.slice(0, Math.min(hh.cap - hh.gar.length, cfg.garMax - inside));
      var r = G.cmd.enter(pid, ids(take), hh.id);
      if (r.ok) inside += r.n;
    }
  }

  /** Vom Gegner besetzte Häuser mit Panzern/Raketen angreifen; Schützen halten Abstand. */
  function attackGarrisons() {
    var calm = !canAttack();   // v0.7: vor dem ersten Angriff nur Häuser nahe der eigenen Basis
    var houses = neutralsOf('garrison').filter(function (h) {
      return h.owner >= 0 && h.owner !== pid && !h.ruin && G.Sim.isVisible(pid, h) && (!calm || d2(h.x, h.y, A.homeX, A.homeY) < 18 * 18 * TILE * TILE);
    });
    if (!houses.length) return;
    var army = ents(function (e) { return e.owner === pid && e.kind === 'unit' && !e.inside && !!G.Sim.statsOf(e).weapon; });
    for (var i = 0; i < houses.length; i++) {
      var h = houses[i], R = 10 * TILE;
      var near = army.filter(function (e) { return d2(e.x, e.y, h.x, h.y) < R * R; });
      if (!near.length) continue;
      var heavy = near.filter(function (e) { var st = G.Sim.statsOf(e); return st.cat === 'vehicle' || st.weapon.type === 'rocket'; });
      var rifles = near.filter(function (e) { var wt = G.Sim.statsOf(e).weapon.type; return (wt === 'bullet' || wt === 'flame') && G.Sim.statsOf(e).cat === 'infantry'; });
      var hitters = heavy.filter(function (e) { return !(e.ord === 'attack' && e.tgt === h.id); });
      if (hitters.length) G.cmd.attack(pid, ids(hitters), h.id);
      if (heavy.length) {
        // Schützen außer Reichweite der Insassen zurückziehen (≈ 8 Kacheln vom Haus Richtung eigene Basis)
        var back = rifles.filter(function (e) { return e.ord !== 'move' && d2(e.x, e.y, h.x, h.y) < 8 * 8 * TILE * TILE; });
        if (back.length) {
          var dx = A.homeX - h.x, dy = A.homeY - h.y, l = Math.sqrt(dx * dx + dy * dy) || 1;
          G.cmd.move(pid, ids(back), h.x + dx / l * 8.5 * TILE, h.y + dy / l * 8.5 * TILE);
        }
      }
    }
  }

  /** Artillerieschlag auf Einheitenballungen oder (nach Wartezeit) Produktionsgebäude. */
  function artilleryStrike() {
    var arts = ents(function (e) { return e.kind === 'building' && e.type === 'artillery' && e.owner === pid && e.charge >= 1; });
    if (!arts.length) { A.artyWait = 0; return; }
    var b = arts[0], R = D.ARTY.range * TILE, W = { heavy: 3, light: 2, inf: 1 };
    if (!A.artyWait) A.artyWait = S.tick;
    var calm = !canAttack(), HR = 20 * TILE;   // v0.7: vor dem ersten Angriff nur zur Verteidigung (nahe der eigenen Basis)
    var foes = ents(function (e) { return e.kind === 'unit' && e.owner !== pid && !e.inside && G.Sim.isVisible(pid, e) && d2(e.x, e.y, b.x, b.y) < R * R &&
                                          (!calm || d2(e.x, e.y, A.homeX, A.homeY) < HR * HR); });
    var best = null, bs = 0, i, k;
    for (i = 0; i < foes.length; i++) {
      var s = 0;
      for (k = 0; k < foes.length; k++) {
        if (d2(foes[i].x, foes[i].y, foes[k].x, foes[k].y) < 2.2 * 2.2 * TILE * TILE) {
          var st = G.Sim.statsOf(foes[k]);
          s += st.harvester ? 3 : (W[st.armor] || 1);
        }
      }
      if (s > bs) { bs = s; best = foes[i]; }
    }
    if (best && bs >= cfg.artyMin) { if (G.cmd.artillery(pid, b.id, best.x, best.y).ok) { A.artyWait = 0; } return; }
    if (S.tick - A.artyWait < 20 * 30 || calm) return;
    // sonst wertvollstes bekanntes Gebäude in Reichweite
    var PRIO = { factory: 5, refinery: 5, barracks: 4, turret: 4, power: 3, mg: 3, hq: 2, laser: 4, tesla: 4, pbunker: 3 }, bb = null, bbs = 0;
    for (var id in P.mem) {
      var m = P.mem[id];
      if (m.neutral || !PRIO[m.type]) continue;
      var mx = (m.tx + m.w / 2) * TILE, my = (m.ty + m.h / 2) * TILE;
      if (d2(mx, my, b.x, b.y) > R * R) continue;
      var sc = PRIO[m.type] + (1 - m.hp / m.maxHp) * 3;
      if (sc > bbs) { bbs = sc; bb = { x: mx, y: my }; }
    }
    if (bb && G.cmd.artillery(pid, b.id, bb.x, bb.y).ok) A.artyWait = 0;
  }

  /** Sichtbare gegnerische Einheiten zählen (für Konter-Komposition). */
  function scout() {
    var tanks = 0, inf = 0, light = 0, sn = 0;
    for (var i = 0; i < S.ents.length; i++) {
      var e = S.ents[i];
      if (e.dead || e.kind !== 'unit' || e.owner === pid || !G.Sim.isVisible(pid, e)) continue;
      var st = G.Sim.statsOf(e);
      if (!st.weapon) continue;
      if (e.type === 'sniper') sn++;
      if (st.armor === 'heavy') tanks++; else if (st.armor === 'inf') inf++; else light++;
    }
    // gleitendes Gedächtnis
    A.seenTanks = Math.max(tanks, A.seenTanks * 0.98);
    A.seenInf = Math.max(inf, A.seenInf * 0.98);
    A.seenLight = Math.max(light, A.seenLight * 0.98);
    A.seenSn = Math.max(sn, (A.seenSn || 0) * 0.98);   // v0.9: gegnerische Scharfschützen (Konter: Fahrzeuge statt Infanterie)
  }

  // ------------------------------------------------------------------ Wirtschaft / Bau
  function economy() {
    var q = P.q.building, dq = P.q.defense, i;
    // fertige Gebäude setzen (höchstens zwei je Entscheidung und Warteschlange)
    placeReadyFrom(q);
    placeReadyFrom(dq);
    // Voraussetzung verloren (z. B. Tech-Zentrum zerstört): nicht fertige Einträge abbrechen
    for (i = q.length - 1; i >= 0; i--) {
      var bd = D.BUILDINGS[q[i].type];
      if (!q[i].ready && bd.req && !G.Sim.hasBuilding(pid, bd.req)) G.cmd.cancel(pid, q[i].type);
    }
    for (i = dq.length - 1; i >= 0; i--) {
      var dd = D.BUILDINGS[dq[i].type];
      if (!dq[i].ready && dd.req && !G.Sim.hasBuilding(pid, dd.req)) G.cmd.cancel(pid, dq[i].type);
    }
    // 2–3 Gebäude vorausplanen (Leicht: eins)
    var pending = q.filter(function (it) { return !it.ready; }).length;
    for (var guard = 0; guard < 3 && q.length < D.QUEUE_MAX && pending < cfg.ahead; guard++) {
      var next = chooseBuilding();
      if (!next || !G.cmd.produce(pid, next).ok) break;
      pending++;
    }
    // v0.8: Verteidigung in eigener Warteschlange, parallel zum Bauplan (ein Eintrag gleichzeitig in Arbeit)
    if (dq.length < D.QUEUE_MAX && !dq.some(function (it) { return !it.ready; })) {
      var nd = chooseDefense();
      if (nd) G.cmd.produce(pid, nd);
    }
  }
  function placeReadyFrom(q) {
    var placed = 0;
    for (var i = 0; i < q.length && placed < 2; i++) {
      if (!q[i].ready) continue;
      var n0 = q.length;
      placeReady(q[i].type);
      placed++;
      if (q.length < n0) i--;
    }
  }
  /** Im Bau befindliche Einträge eines Typs (noch nicht platziert) – Gebäude- und Verteidigungs-Warteschlange. */
  function queued(t) {
    var n = 0, qs = [P.q.building, P.q.defense];
    for (var k = 0; k < 2; k++) for (var i = 0; i < qs[k].length; i++) if (qs[k][i].type === t) n++;
    return n;
  }

  function chooseBuilding() {
    var surplus = P.pwrProd - P.pwrUse;
    for (var qi = 0; qi < P.q.building.length; qi++) surplus += D.BUILDINGS[P.q.building[qi].type].power;   // geplante Gebäude mitrechnen
    for (qi = 0; qi < P.q.defense.length; qi++) surplus += D.BUILDINGS[P.q.defense[qi].type].power;
    var cnt = function (t) { return G.Sim.countOf(pid, t, 'building') + queued(t); };
    // v0.8: Verteidigung wartet auf Strom → Kraftwerk zuerst
    if (A.needPower) { A.needPower = false; if (!queued('power')) return 'power'; }
    // Energie im Blick
    if (surplus < 0 || (surplus < 25 && cnt('refinery') > 0)) return 'power';
    var ch = chooseInner(cnt, surplus);
    // Stromfresser (Tech-Zentrum, Superwaffe): vorher Kraftwerk, wenn der Überschuss nicht reicht
    if (ch && D.BUILDINGS[ch].power < 0 && surplus + D.BUILDINGS[ch].power < 0) return 'power';
    return ch;
  }
  function chooseInner(cnt, surplus) {
    var secs = S.tick / D.TICK_HZ, i;
    // fester Bauplan: zählt, was schon steht
    var need = {};
    for (i = 0; i < PLAN.length; i++) {
      var t = PLAN[i];
      need[t] = (need[t] || 0) + 1;
      if (t === 'refinery' && need[t] > 1 && S.tick < 20 * cfg.ref2At) continue; // Leicht: zweite Raffinerie erst spät
      if (TOWERS[t]) continue;   // v0.8: Verteidigungsschritte des Plans laufen in chooseDefense() (eigene Warteschlange)
      if (cnt(t) < need[t]) {
        if (G.Sim.canProduce(pid, t).ok) return t;
        return null;
      }
    }
    // v0.4: Tech-Zentrum (Mittel ~7 min), danach Superwaffe (nicht Leicht)
    if (secs >= cfg.techAt && cnt('techcenter') < 1 && G.Sim.hasBuilding(pid, 'factory') && P.credits > 400 &&
        (G.Sim.countOf(pid, 'refinery', 'building') >= 2 || secs >= cfg.techAt + 120)) return 'techcenter';
    // Superwaffe erst mit stehender Armee und Geldpolster (sonst verhungert die Front – Patt-Partien)
    if (cfg.sw && G.Sim.hasBuilding(pid, 'techcenter') && secs >= cfg.techAt + 90 && P.credits > 1200 && !A.defending && armyValue() >= 6000) {
      var swt = P.faction === 'coalition' ? 'orbital' : (P.faction === 'kollektiv' ? 'psidome' : 'silo');   // v1.0
      if (cnt(swt) < 1 && G.Sim.canProduce(pid, swt).ok) return swt;
    }
    var b12 = choose12(cnt, secs);   // v1.2: Reparaturdock, Erzsilo
    if (b12) return b12;
    var asb = chooseAirSea(cnt);   // v0.8: Flugfeld / Werft (Flak: chooseDefense)
    if (asb) return asb;
    // v0.5: Expansion (Mobiler Bauhof aufgebaut) → Raffinerie am neuen Standort
    if (A.exp && expNeedsRefinery() && cnt('refinery') - G.Sim.countOf(pid, 'refinery', 'building') === 0 && P.credits > 400) return 'refinery';
    // danach: dynamisch
    var refs = cnt('refinery');
    if (refs < cfg.maxRef && P.credits > 2200 && S.tick > 20 * 240 && farOre()) return 'refinery';
    // Geld staut sich → mehr Produktionsstätten (Produktion parallelisiert)
    if (cnt('barracks') < 2 && P.credits > 1200 && S.tick > 20 * 240) return 'barracks';
    if (P.ai !== 'easy' && P.ai !== 'veryeasy' && cnt('factory') < 2 && P.credits > (pidHard() ? 2200 : 2600)) return 'factory';
    if (surplus < 60 && P.credits > 800) return 'power';
    return null;
  }
  /** v0.8: nächste Verteidigungsanlage für die eigene Warteschlange (gleiche Reihenfolge/Bedingungen wie früher im Bauplan,
   *  aber ohne den Gebäude-Bauplan zu blockieren). Plan-Türme erst, wenn alle früheren Nicht-Verteidigungsschritte stehen. */
  function chooseDefense() {
    var surplus = P.pwrProd - P.pwrUse, i, secs = S.tick / D.TICK_HZ;
    for (i = 0; i < P.q.building.length; i++) surplus += D.BUILDINGS[P.q.building[i].type].power;
    for (i = 0; i < P.q.defense.length; i++) surplus += D.BUILDINGS[P.q.defense[i].type].power;
    var cnt = function (t) { return G.Sim.countOf(pid, t, 'building') + queued(t); };
    var pick = chooseDefenseInner(cnt, secs);
    if (pick && D.BUILDINGS[pick].power < 0 && surplus + D.BUILDINGS[pick].power < 0) {
      if (!queued('power')) A.needPower = true;
      return null;
    }
    return pick;
  }
  function chooseDefenseInner(cnt, secs) {
    var need = {}, i;
    var fk = chooseFlak(cnt);   // v0.8 Luft/See: Flugabwehr hat Vorrang (gegnerische Luftfahrzeuge sind schon da)
    if (fk) return fk;
    for (i = 0; i < PLAN.length; i++) {
      var t = PLAN[i];
      need[t] = (need[t] || 0) + 1;
      if (t === 'refinery' && need[t] > 1 && S.tick < 20 * cfg.ref2At) continue;
      if (cnt(t) < need[t]) {
        if (!TOWERS[t]) return null;   // früherer Bauplan-Schritt steht noch aus → Reihenfolge wahren
        if ((t === 'turret' || t === 'mg') && cnt(t) >= cfg.turrets) continue;
        return G.Sim.canProduce(pid, t).ok ? t : null;
      }
    }
    // v0.5: Bunker und Fraktionsturm an der Hauptangriffsrichtung (nicht im Patt-Brecher-Modus)
    if (cfg.bunkers && !A.allIn && cnt('pbunker') < cfg.bunkers && secs >= cfg.bunkerAt && P.credits > 900 && G.Sim.canProduce(pid, 'pbunker').ok &&
        ((A.defMax || 0) >= cfg.defNeed || secs >= cfg.bunkerAt + 300) && (cnt('pbunker') === 0 || secs >= cfg.bunkerAt + 240)) return 'pbunker';
    var ft = P.faction === 'coalition' ? 'laser' : (P.faction === 'kollektiv' ? 'psitower' : 'tesla');   // v1.0 Psi-Turm
    if (cfg.towers5 && !A.allIn && cnt(ft) < cfg.towers5 && secs >= cfg.techAt + 60 && P.credits > 700 && A.thrX != null && (A.defMax || 0) >= cfg.defNeed * 2 &&
        G.Sim.canProduce(pid, ft).ok &&
        (cnt(ft) === 0 || secs >= cfg.techAt + 360)) return ft;
    var d12 = chooseDef12(cnt, secs);   // v1.2: Tor, Minenfeld
    if (d12) return d12;
    if (cnt('turret') + cnt('mg') < cfg.turrets + 1 && P.credits > 1500) return (cnt('turret') <= cnt('mg')) ? 'turret' : 'mg';
    return null;
  }
  function pidHard() { return P.ai === 'hard'; }
  /** Credits-Wert der eigenen Kampfeinheiten. */
  function armyValue() {
    var v = 0;
    for (var i = 0; i < S.ents.length; i++) { var e = S.ents[i]; if (!e.dead && e.owner === pid && e.kind === 'unit' && G.Sim.statsOf(e).weapon) v += G.Sim.statsOf(e).cost; }
    return v;
  }

  /** Gibt es Erz, das weit von allen eigenen Raffinerien ist? */
  function farOre() {
    var refs = mine('building', 'refinery'), w = S.map.w;
    var nearOre = 0;
    for (var i = 0; i < S.map.ore.length; i++) {
      if (S.map.ore[i] < 100) continue;
      var x = (i % w + 0.5) * TILE, y = (Math.floor(i / w) + 0.5) * TILE;
      for (var k = 0; k < refs.length; k++) if (d2(x, y, refs[k].x, refs[k].y) < 12 * 12 * TILE * TILE) { nearOre++; break; }
    }
    return nearOre < 25;
  }

  function placeReady(type) {
    var b = D.BUILDINGS[type];
    var spot = SPOT12[type] ? SPOT12[type]() : findSpot(type, b);   // v1.2: eigene Platzwahl (Tor, Minenfeld)
    if (spot) {
      var r = G.cmd.placeBuilding(pid, type, spot.tx, spot.ty);
      if (r.ok) { A.placeFails = 0; return; }
    }
    A.placeFails++;
    if (A.placeFails > 6) { G.cmd.cancel(pid, type); A.placeFails = 0; }
  }

  /** Sucht einen Bauplatz. Bewertet nach Typ (Raffinerie nahe Erz, Türme Richtung Gegner). */
  var spotMark = null;   // Laufzeit-Puffer (kein Zustand)
  function findSpot(type, b) {
    var w = S.map.w, h = S.map.h;
    // v0.5: Bezugsgebäude für die Nähe-Regel: eigene Basisgebäude (ohne Mauern) + eroberte Spezialgebäude
    var blds = ents(function (e) {
      if (e.owner !== pid || e.kind !== 'building') return false;
      var bd = D.BUILDINGS[e.type];
      return !bd.isWall && (!e.neutral || (bd.kind2 === 'special' && !cfg.noSpecAnchor));
    });
    if (!blds.length) return null;
    // Bezugspunkt
    var ax = A.homeX, ay = A.homeY;
    if (type === 'refinery') {
      var ore = (A.exp && expNeedsRefinery()) ? { x: A.exp.oreX, y: A.exp.oreY } : bestOreSpot();
      if (ore) { ax = ore.x; ay = ore.y; }
    } else if (b.shore && A.navy && A.navy.ok) {   // v0.8 Werft: am erkundeten Ufer
      ax = A.navy.x; ay = A.navy.y;
    } else if (type === 'flak') {                    // v0.8 Flak: im Basiskern
      var fla = flakAnchor(); ax = fla.x; ay = fla.y;
    } else if (b.defense) {
      var dfa = defAnchor(type);
      ax = dfa.x; ay = dfa.y;
    }
    var best = null, bestS = 1e18;
    // Kandidaten: nur Kacheln im Nähe-Bereich eines Bezugsgebäudes (statt Rechteck um die ganze Basis – Expansionen)
    if (!spotMark || spotMark.length !== w * h) spotMark = new Uint8Array(w * h);
    spotMark.fill(0);
    var R = b.placeDist || D.PLACE_DIST, i, tx, ty;   // v0.8: Werft mit größerer Nähe-Regel
    for (i = 0; i < blds.length; i++) {
      var e = blds[i];
      for (ty = Math.max(0, e.ty - R - b.h); ty <= Math.min(h - b.h, e.ty + e.h + R); ty++)
        for (tx = Math.max(0, e.tx - R - b.w); tx <= Math.min(w - b.w, e.tx + e.w + R); tx++) spotMark[ty * w + tx] = 1;
    }
    var fl = flipped();
    for (var ty0 = 0; ty0 <= h - b.h; ty0++) {
      ty = fl ? h - b.h - ty0 : ty0;
      for (var tx0 = 0; tx0 <= w - b.w; tx0++) {
        tx = fl ? w - b.w - tx0 : tx0;
        if (!spotMark[ty * w + tx]) continue;
        var cx = (tx + b.w / 2) * TILE, cy = (ty + b.h / 2) * TILE;
        var s = d2(cx, cy, ax, ay);
        if (s >= bestS) continue;
        if (!(b.defense && b.w === 1) && !clearRing(tx, ty, b.w, b.h)) continue;
        if (!G.Sim.canPlace(pid, type, tx, ty).ok) continue;
        bestS = s; best = { tx: tx, ty: ty };
      }
    }
    return best;
  }
  /** v0.5: Bezugspunkt für Verteidigungsanlagen – Richtung der bisherigen Angriffe (sonst Sammelpunkt), seitlich versetzt. */
  function defAnchor(type) {
    if (cfg.oldAnchor && (type === 'turret' || type === 'mg')) {
      var ox = A.rallyX - A.homeX, oy = A.rallyY - A.homeY;
      var on = G.Sim.countOf(pid, 'turret', 'building') + G.Sim.countOf(pid, 'mg', 'building'), os = (on % 3) - 1;
      return { x: A.homeX + ox * 0.75 - oy * 0.35 * os, y: A.homeY + oy * 0.75 + ox * 0.35 * os };
    }
    var tx = A.thrX != null ? A.thrX : A.rallyX, ty = A.thrY != null ? A.thrY : A.rallyY;
    var dx = tx - A.homeX, dy = ty - A.homeY, l = Math.sqrt(dx * dx + dy * dy) || 1;
    dx /= l; dy /= l;
    var dist = { turret: 5.5, mg: 5.5, pbunker: 6.5, laser: 5, tesla: 4.5 }[type] || 5.5;
    var n = 0;
    for (var k in TOWERS) n += G.Sim.countOf(pid, k, 'building');
    var side = (n % 3) - 1;
    return { x: A.homeX + dx * dist * TILE - dy * 2.5 * TILE * side, y: A.homeY + dy * dist * TILE + dx * 2.5 * TILE * side };
  }
  /** Ein Kachelring um das Rechteck muss frei von Gebäuden sein (Durchgänge freihalten). */
  function clearRing(tx, ty, bw, bh) {
    var w = S.map.w, h = S.map.h;
    for (var y = ty - 1; y <= ty + bh; y++) for (var x = tx - 1; x <= tx + bw; x++) {
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      if (S.occ[y * w + x]) return false;
    }
    return true;
  }
  /** Erz-Schwerpunkt mit viel Erz nahe der Basis (für Raffinerie-Standort). */
  function bestOreSpot() {
    var w = S.map.w, best = null, bs = 1e18;
    var refs = mine('building', 'refinery');
    var fl = flipped(), N = S.map.ore.length;
    for (var i0 = 0; i0 < N; i0++) {
      var i = fl ? N - 1 - i0 : i0;
      if (S.map.ore[i] < 150) continue;
      var x = (i % w + 0.5) * TILE, y = (Math.floor(i / w) + 0.5) * TILE;
      var s = d2(x, y, A.homeX, A.homeY);
      // schon versorgte Felder meiden
      for (var k = 0; k < refs.length; k++) if (d2(x, y, refs[k].x, refs[k].y) < 8 * 8 * TILE * TILE) { s += 1e8; break; }
      if (s < bs) { bs = s; best = { x: x, y: y }; }
    }
    return best;
  }

  // ------------------------------------------------------------------ Produktion
  function production() {
    var refs = G.Sim.countOf(pid, 'refinery', 'building');
    var harvs = G.Sim.countOf(pid, 'harvester', 'unit');
    var vq = P.q.vehicle, iq = P.q.infantry;
    var hasFactory = G.Sim.hasBuilding(pid, 'factory'), hasBarracks = G.Sim.hasBuilding(pid, 'barracks');
    var wantHarv = Math.min(refs * cfg.harvPerRef, cfg.maxHarv);
    var harvQueued = vq.some(function (it) { return it.type === 'harvester'; });
    if (hasFactory && harvs < wantHarv && !harvQueued && vq.length < 2) { G.cmd.produce(pid, 'harvester'); return; }
    // v0.5: Mobiler Bauhof in Arbeit → Armee pausiert (sonst verhungert er in der Schlange), außer bei Verteidigung
    if (!A.defending && vq.length && vq[0].type === 'mcv' && P.credits < 300) return;   // mcv läuft: nichts Neues dazwischen
    // Bauplan zuerst finanzieren: wenn Gebäude noch fehlt und wenig Geld, Armee warten
    var building = (P.q.building.length && !P.q.building[0].ready) || (P.q.defense.length && !P.q.defense[0].ready);
    if (building && P.credits < 400 && S.tick < 20 * 240) return;
    var anti = A.seenTanks, antiInf = A.seenInf + A.seenLight * 0.5;
    // Leicht: Armeegröße wächst nur langsam (für Gelegenheitsspieler schlagbar)
    if (cfg.armyCap) {
      var nArmy = 0;
      for (var k = 0; k < S.ents.length; k++) { var ue = S.ents[k]; if (!ue.dead && ue.owner === pid && ue.kind === 'unit' && ue.type !== 'harvester' && !ue.host) nArmy++; }   // v1.2: ohne Träger-Drohnen
      if (nArmy + iq.length + vq.length >= cfg.armyCap[0] + S.tick / 20 / 60 * cfg.armyCap[1]) return;
    }
    // v0.4: Einträge ohne Voraussetzung (Tech-Zentrum verloren) abbrechen
    [iq, vq].forEach(function (q) { if (q.length && !G.Sim.canProduce(pid, q[0].type).ok && q[0].prog < 1) G.cmd.cancel(pid, q[0].type); });
    var tech = G.Sim.hasBuilding(pid, 'techcenter');
    if (hasBarracks && A.wantRifle && iq.length < cfg.armyQ + 1) { A.wantRifle = 0; G.cmd.produce(pid, 'rifle'); }
    if (hasBarracks && tech && A.engWant && G.Sim.countOf(pid, 'engineer', 'unit') < 2 && !iq.some(function (it) { return it.type === 'engineer'; })) {
      A.engWant = 0; G.cmd.produce(pid, 'engineer');
    }
    // v0.9: Scharfschützen treffen Fahrzeuge kaum (0,1 / 0,05) – bei vielen gesehenen Scharfschützen weniger Infanterie, mehr Fahrzeuge
    var snN = A.seenSn || 0;
    if (hasBarracks && iq.length < cfg.armyQ && !(cfg.newUnits !== false && snN >= 3 && G.Sim.rand() < Math.min(0.5, snN * 0.04))) G.cmd.produce(pid, chooseInfantry(anti, antiInf));
    // v0.7: Schützenpanzer für eine Fahrt zu einem Spezialgebäude
    if (hasFactory && A.apcWant && !vq.some(function (it) { return it.type === 'apc'; }) && G.Sim.canProduce(pid, 'apc').ok && vq.length < cfg.armyQ + 1) {
      A.apcWant = 0; G.cmd.produce(pid, 'apc');
    }
    if (hasFactory && vq.length < cfg.armyQ && !(harvs < wantHarv)) {
      var light = P.faction === 'coalition' ? 'scout' : (P.faction === 'kollektiv' ? 'gatling' : 'raider');   // v1.0
      if (light === 'scout' && cfg.newUnits !== false && G.Sim.countOf(pid, 'apc', 'unit') < 2 && G.Sim.rand() < 0.12) light = 'apc';
      var lightShare = 0.2 + Math.min(0.4, antiInf / (anti + antiInf + 1) * 0.5) + (cfg.newUnits !== false && snN >= 3 ? Math.min(0.25, snN * 0.03) : 0);
      var heavy = 'tank';
      var armyN = 0, towers = 0;
      for (var k2 = 0; k2 < S.ents.length; k2++) { var ae = S.ents[k2]; if (!ae.dead && ae.owner === pid && ae.kind === 'unit' && ae.type !== 'harvester') armyN++; }
      for (var mid in P.mem) { var mm = P.mem[mid]; if (TOWERS[mm.type] && mm.owner !== pid) towers += (mm.type === 'laser' || mm.type === 'tesla' || mm.type === 'psitower') ? 2 : 1; }
      // v0.7: Syndikat – Raketenwerfer gegen Türme (ohne Tech-Zentrum verfügbar); Artillerie gesamt ≤ 25 % der Armee
      var arty = G.Sim.countOf(pid, 'howitzer', 'unit') + G.Sim.countOf(pid, 'mlrs', 'unit');
      var artyOk = arty < Math.max(1, armyN * 0.25);
      var mlrsOk = P.faction === 'syndicate' && cfg.newUnits !== false;
      if (mlrsOk && artyOk && G.Sim.rand() < (towers >= 2 ? 0.28 : (towers ? 0.2 : 0.1))) heavy = 'mlrs';
      else if (tech) {
        // Kern: Jagd-/Kolosspanzer bzw. (v0.7) Laser-/Blitzpanzer; Haubitzen gegen Türme/Basen (mehr, wenn gegnerische Türme bekannt)
        var core = P.faction === 'coalition' ? 'hunter' : (P.faction === 'kollektiv' ? 'psitank' : 'colossus');
        if (cfg.newUnits !== false && G.Sim.rand() < 0.5) core = P.faction === 'coalition' ? 'lasertank' : (P.faction === 'kollektiv' ? kollCore() : 'shocktank');   // v1.0
        var howShare = (towers >= 2 ? 0.3 : (towers ? 0.22 : 0.12)) * (mlrsOk ? 0.5 : 1);
        var rr = G.Sim.rand();
        if (rr < howShare && artyOk) heavy = 'howitzer';
        else if (G.Sim.rand() < cfg.techShare) heavy = core;
      }
      G.cmd.produce(pid, G.Sim.rand() < lightShare ? light : heavy);
    }
  }

  /** v0.7: Infanterie-Auswahl – Sanitäter bei größeren Infanteriegruppen, Scharfschützen/Flammenwerfer gegen
   *  infanterielastige Gegner, sonst Raketen (gegen Panzer) und Schützen. */
  function chooseInfantry(anti, antiInf) {
    var rocketShare = (P.faction === 'coalition' && cfg.newUnits !== false ? 0.4 : 0.3) + Math.min(0.5, anti / (anti + antiInf + 1));   // v0.9: Koalition (Schützen/Scharfschützen kaum gegen Gebäude) mehr Raketentrupps
    if (cfg.newUnits === false) return G.Sim.rand() < rocketShare ? 'rocket' : 'rifle';
    var inf = 0, med = 0, spec = 0, k, iq = P.q.infantry;
    var special = P.faction === 'coalition' ? 'sniper' : (P.faction === 'kollektiv' ? kollSpecial() : 'flamer');   // v1.0
    for (k = 0; k < S.ents.length; k++) {
      var e = S.ents[k];
      if (e.dead || e.owner !== pid || e.kind !== 'unit' || !isInf(e)) continue;
      if (e.type === 'medic') med++; else if (e.type !== 'engineer') inf++;
      if (e.type === special) spec++;
    }
    for (k = 0; k < iq.length; k++) { if (iq[k].type === 'medic') med++; else if (iq[k].type === special) spec++; }
    if (inf >= 5 && med < Math.min(cfg.medics || 2, Math.floor(inf / 5)) && G.Sim.rand() < 0.6) return 'medic';
    var infFrac = antiInf / (anti + antiInf + 1);   // gegnerischer Infanterie-/Leichtanteil
    var specShare = (special === 'sniper' ? 0.06 : 0.1) + 0.3 * infFrac;
    if (P.faction === 'kollektiv') specShare = KOLL.specShare + KOLL.specInf * infFrac + (special === 'psiadept' ? KOLL.adeptVeh * (1 - infFrac) : 0);   // v1.0
    if (cfg.specAt && S.tick < cfg.specAt * D.TICK_HZ) specShare = 0;   // v1.0.1 KI-Leicht: keine Flammenwerfer/Scharfschützen/Mutanten-Basisraubzüge am Anfang
    if (spec < 2 + inf * (special === 'sniper' ? 0.3 : 0.4) && G.Sim.rand() < specShare) return special;
    return G.Sim.rand() < rocketShare ? 'rocket' : 'rifle';
  }

  /** v0.7: Sanitäter begleiten die Infanterie der Angriffswelle (bis zu 1 je 4 Infanteristen), die übrigen bleiben am Sammelpunkt.
   *  Geheilt wird von selbst (sim.js); untätig folgen sie verletzter Infanterie. */
  function medics() {
    var meds = ents(function (e) { return e.owner === pid && e.kind === 'unit' && !e.inside && e.type === 'medic' && e.ord !== 'load' && e.ord !== 'enter' && !reserved(e); });
    if (!meds.length) return;
    var infAtk = [];
    for (var i = 0; i < A.attack.length; i++) { var u = G.Sim.get(A.attack[i]); if (u && !u.dead && isInf(u)) infAtk.push(u.id); }
    A.medAtk = (A.medAtk || []).filter(function (id) { var m = G.Sim.get(id); return m && !m.dead && !m.inside; });
    var want = infAtk.length >= 3 ? Math.ceil(infAtk.length / 4) : 0;
    if (A.medAtk.length > want) A.medAtk = A.medAtk.slice(0, want);
    for (i = 0; i < meds.length && A.medAtk.length < want; i++) if (A.medAtk.indexOf(meds[i].id) < 0) A.medAtk.push(meds[i].id);
    var c = infAtk.length ? centroid(infAtk) : null;
    if (c) { var dx = A.homeX - c.x, dy = A.homeY - c.y, l = Math.sqrt(dx * dx + dy * dy) || 1; c.x += dx / l * 1.5 * TILE; c.y += dy / l * 1.5 * TILE; }
    for (i = 0; i < meds.length; i++) {
      var m = meds[i];
      if (m.htgt) continue;   // heilt gerade
      var go = A.medAtk.indexOf(m.id) >= 0 && c ? c : { x: A.rallyX, y: A.rallyY };
      var far = go === c ? 3.5 : 6;
      if (d2(m.x, m.y, go.x, go.y) < far * far * TILE * TILE) continue;
      if (m.ord === 'move' && d2(m.gx, m.gy, go.x, go.y) < 3 * 3 * TILE * TILE) continue;
      if (m.ord === 'idle' && m.follow) continue;   // folgt verletzter Infanterie
      if (!A.defending || go === c) G.cmd.move(pid, [m.id], go.x, go.y);
    }
  }

  /** v0.7 (Koalition): Schützenpanzer bringt Ingenieur bzw. Schützen zu einem entfernten Spezialgebäude.
   *  Phasen: 'load' (Einsteigen am APC) → 'drive' (Fahrt zum Eingang) → Aussteigen + enter. Abbruch bei Gegnern am Ziel. */
  function apcFerry() {
    if (!cfg.apcJobs || !G.Sim.isApc || !D.unitStats(P.faction, 'apc')) return;
    var secs = S.tick / D.TICK_HZ, J = A.apcJob;
    if (J) {
      var a = G.Sim.get(J.apc), b = G.Sim.get(J.b);
      J.units = J.units.filter(function (id) { var u = G.Sim.get(id); return u && !u.dead; });
      var abort = !a || a.dead || !b || b.owner === pid || b.capBy === pid || S.tick - J.t > 20 * 150 || !J.units.length;
      if (!abort && J.ph === 'load') {
        var inside = J.units.filter(function (id) { return G.Sim.get(id).inside === J.apc; }).length;
        var walking = J.units.filter(function (id) { var u = G.Sim.get(id); return !u.inside && u.ord === 'load'; }).length;
        if (!walking && !inside) abort = true;
        else if (inside === J.units.length || (inside && S.tick - J.t > 20 * 30)) {
          J.ph = 'drive'; J.t2 = S.tick;
          J.units = J.units.filter(function (id) { return G.Sim.get(id).inside === J.apc; });
          var gp = apcDrop(b, a);
          J.gx = gp.x; J.gy = gp.y;
          G.cmd.move(pid, [a.id], gp.x, gp.y);
        } else if (S.tick - J.t > 20 * 45) abort = true;
      } else if (!abort && J.ph === 'drive') {
        var dd = d2(a.x, a.y, J.gx, J.gy), danger = enemiesNear(b.x, b.y, 7 * TILE);
        if (danger > 2) { G.cmd.move(pid, [a.id], A.rallyX, A.rallyY); J.ph = 'back'; J.t3 = S.tick; }
        else if (dd < 1.5 * 1.5 * TILE * TILE || (a.ord === 'idle' && dd < 5 * 5 * TILE * TILE)) {
          var gone = J.units.slice();
          G.cmd.unload(pid, a.id);
          var eng = gone.filter(function (id) { return G.Sim.get(id).type === 'engineer'; });
          var cap = eng.length ? eng[0] : gone[0];
          var r = G.cmd.enter(pid, [cap], b.id);
          if (r.ok) { A.capJobs[b.id] = { u: cap, t: S.tick }; A.apcRides = (A.apcRides || 0) + 1; }
          A.apcJob = null;
          return;
        } else if (a.ord === 'idle' && S.tick - J.t2 > 20 * 5) G.cmd.move(pid, [a.id], J.gx, J.gy);
      } else if (!abort && J.ph === 'back') {
        if (d2(a.x, a.y, A.rallyX, A.rallyY) < 5 * 5 * TILE * TILE || S.tick - J.t3 > 20 * 40) abort = true;
      }
      if (abort) {
        if (a && !a.dead && a.gar && a.gar.length) G.cmd.unload(pid, a.id);
        J.units.forEach(function (id) { var u = G.Sim.get(id); if (u && !u.dead && u.ord === 'load') G.cmd.stop(pid, [id]); });
        A.apcJob = null; A.apcFail = (A.apcFail || 0) + 1; A.apcJobT = S.tick;
      }
      return;
    }
    if (secs < cfg.capFrom + 60 || (A.apcStarts || 0) >= cfg.apcMax || A.defending || S.tick - (A.apcJobT || -1e9) < 20 * 75 || !A.capJobs) return;
    // Ziel: Spezialgebäude weit von der Basis, nicht eigenes, ohne Gegner, höchstens leicht jenseits der Mitte
    var specs = neutralsOf('special'), best = null, bs = 1e18, fc = A.attack.length >= 4 ? centroid(A.attack) : null;
    for (var i = 0; i < specs.length; i++) {
      var sb = specs[i];
      if (A.capJobs[sb.id] || sb.capBy === pid || knownOwner(sb) === pid) continue;
      if (A.capOk && S.tick - (A.capOk[sb.id] || -1e9) < 20 * cfg.recap) continue;
      var dh = Math.sqrt(d2(sb.x, sb.y, A.homeX, A.homeY)), de = Math.sqrt(d2(sb.x, sb.y, A.enemyX, A.enemyY));
      if (dh < 14 * TILE) continue;   // nah: Schützen laufen (capture())
      var front = fc && d2(sb.x, sb.y, fc.x, fc.y) < 12 * 12 * TILE * TILE;
      if (dh > de * 1.25 && !front) continue;
      if (enemiesNear(sb.x, sb.y, 8 * TILE) > 0) continue;
      var prio = { oil: 0, arty: 4, radar: 6, repair: 8, heal: 9 }[D.BUILDINGS[sb.type].special] || 5;
      var sc = dh / TILE + prio * 2 + (knownOwner(sb) >= 0 ? -6 : 0) + tk(sb.x, sb.y) * 1e-9;
      if (sc < bs) { bs = sc; best = sb; }
    }
    if (!best) return;
    var inAtk = {};
    for (i = 0; i < A.attack.length; i++) inAtk[A.attack[i]] = 1;
    var apcs = ents(function (e) { return e.owner === pid && e.kind === 'unit' && e.type === 'apc' && !inAtk[e.id] && e.ord !== 'attack' && !e.gar.length &&
                                          d2(e.x, e.y, A.homeX, A.homeY) < 26 * 26 * TILE * TILE; });
    if (!apcs.length) { if (G.Sim.countOf(pid, 'apc', 'unit') < 1) A.apcWant = 1; return; }
    var ap = apcs[0];
    var busy = {};
    for (var k in A.capJobs) busy[A.capJobs[k].u] = 1;
    var pool = ents(function (e) {
      return e.owner === pid && e.kind === 'unit' && !e.inside && isInf(e) && !inAtk[e.id] && !busy[e.id] && e.ord === 'idle' && e.type !== 'medic' &&
             d2(e.x, e.y, ap.x, ap.y) < 16 * 16 * TILE * TILE;
    });
    if (!pool.length) { A.wantRifle = 1; return; }
    // Ingenieur zuerst (sofortige Eroberung), dann bis zu drei Schützen/Raketen als Begleitschutz
    pool.sort(function (p, q) { return ((p.type === 'engineer' ? 0 : 1) - (q.type === 'engineer' ? 0 : 1)) || d2(p.x, p.y, ap.x, ap.y) - d2(q.x, q.y, ap.x, ap.y) || p.id - q.id; });
    var take = pool.slice(0, pool[0].type === 'engineer' ? 3 : 3).filter(function (e, idx) { return idx === 0 || e.type !== 'engineer'; });
    var r = G.cmd.load(pid, ids(take), ap.id);
    if (!r.ok) return;
    G.cmd.stop(pid, [ap.id]);
    A.apcStarts = (A.apcStarts || 0) + 1;
    A.apcJob = { apc: ap.id, b: best.id, units: ids(take).filter(function (id) { return G.Sim.get(id).ord === 'load'; }), ph: 'load', t: S.tick };
  }
  /** Absetzpunkt am Spezialgebäude: Ringkachel auf der Seite zur eigenen Basis (für Fahrzeuge erreichbar). */
  function apcDrop(b, a) {
    var ring = G.Sim.ringTiles(b), w = S.map.w, best = null, bs = 1e18;
    for (var i = 0; i < ring.length; i++) {
      var t = ring[i], tx = t % w, ty = (t - tx) / w;
      var ti = G.Path.nearestPassable(1, tx, ty, 2);
      if (ti < 0) continue;
      var x = (ti % w + 0.5) * TILE, y = (Math.floor(ti / w) + 0.5) * TILE, s = d2(x, y, A.homeX, A.homeY) + d2(x, y, a.x, a.y) * 0.2 + tk(x, y) * 1e-6;
      if (s < bs) { bs = s; best = { x: x, y: y }; }
    }
    return best || { x: b.x, y: b.y + (b.h / 2 + 1.5) * TILE };
  }

  // ------------------------------------------------------------------ Militär
  function military() {
    var army = ents(function (e) { return e.owner === pid && e.kind === 'unit' && !e.inside && e.ord !== 'enter' && e.ord !== 'load' && !!G.Sim.statsOf(e).weapon && !reserved(e) && e.mc < 2; });   // v0.8: ohne Luft/See
    var inAttack = {};
    A.attack = A.attack.filter(function (id) { var e = G.Sim.get(id); return e && !e.dead && !e.inside && e.owner === pid; });   // v1.0: übernommene Einheiten fallen heraus
    for (var i = 0; i < A.attack.length; i++) inAttack[A.attack[i]] = 1;
    var home = army.filter(function (e) { return !inAttack[e.id]; });
    var secs = S.tick / D.TICK_HZ;

    // Fortschritt des Angriffs: bekannte gegnerische Gebäude verschwinden (legitime Info aus P.mem)
    var memN = 0;
    for (var mid in P.mem) if (!P.mem[mid].neutral && P.mem[mid].type !== 'wall') memN++;
    if (A.memN != null && memN < A.memN && A.attack.length) A.pushT = S.tick;
    // v0.5 Patt-Brecher: seit 4 min kein Gebäude zerstört (weder eigenes verloren noch gegnerisches) → alles nach vorn
    var lostB = P.st.buildingsLost;
    if (A.progT == null || (A.memN != null && memN < A.memN) || lostB !== A.lostB) A.progT = S.tick;
    A.lostB = lostB;
    A.memN = memN;
    var sh = tShift(), ss = secs - sh;   // v0.7: Zeitmarken relativ zum (späteren) ersten Angriff
    A.allIn = cfg.push && !cfg.noAllIn && (ss > 20 * 60 || (ss > 16 * 60 && S.tick - A.progT > 20 * 240));
    var pushing = cfg.push && A.attack.length && S.tick - (A.pushT || -1e9) < 20 * 60;

    // 1) Verteidigung: Basis oder Sammler angegriffen?
    var al = P.alert, recent = S.tick - al.tick < 60;
    var nearBase = d2(al.x, al.y, A.homeX, A.homeY) < 18 * 18 * TILE * TILE;
    // v0.7: vor dem ersten erlaubten Angriff nur Basisverteidigung (Sammler-Alarm fern der Basis würde zum Angriff eskalieren)
    if (recent && (nearBase || (al.harv && canAttack()))) {
      var threat = enemiesNear(al.x, al.y, 8 * TILE);
      if (threat > 0) {
        // nur Untätige/Bewegende neu befehligen (keine Befehlsflut / Pfad-Neuberechnung)
        var defenders = home.filter(function (e) { return e.ord === 'idle' || e.ord === 'move'; });
        if (defenders.length) G.cmd.attackMove(pid, ids(defenders), al.x, al.y);
        // bei großem Angriff Angriffsgruppe zurückrufen, wenn sie noch nah ist
        if (threat > home.length && A.attack.length) {
          var back = A.attack.filter(function (id) { var e = G.Sim.get(id); return e.ord !== 'amove' && d2(e.x, e.y, A.homeX, A.homeY) < 25 * 25 * TILE * TILE; });
          if (back.length) G.cmd.attackMove(pid, back, al.x, al.y);
        }
        if (!A.defending) A.defPeak = 0;
        A.defPeak = Math.max(A.defPeak || 0, threat);
        if (nearBase) A.defMax = Math.max(A.defMax || 0, threat);   // v0.5: größter Angriff auf die Basis bisher
        // v0.5: Hauptangriffsrichtung (geglättet) für Bunker/Fraktionsturm
        if (nearBase) { if (A.thrX == null) { A.thrX = al.x; A.thrY = al.y; } else { A.thrX = A.thrX * 0.85 + al.x * 0.15; A.thrY = A.thrY * 0.85 + al.y * 0.15; } }
        A.defending = true; A.lastDefT = S.tick;
      }
    } else if (A.defending && S.tick - A.lastDefT > 200) {
      A.defending = false;
      // Gegenstoß: Angriff abgewehrt und genug übrig → sofort nachsetzen, solange der Gegner geschwächt ist
      if (cfg.counter && canAttack() && (A.defPeak || 0) >= 4 && !A.attack.length &&
          home.length >= Math.max(5, Math.ceil(cfg.wave * 0.6))) {
        A.counterT = S.tick;
      } else G.cmd.move(pid, ids(home), A.rallyX, A.rallyY);
    }

    // 2) Untätige Heimtruppen zum Sammelpunkt
    var countering = A.counterT && S.tick - A.counterT < 20 * 10;
    if (!A.defending && !countering) {
      var strays = home.filter(function (e) { return e.ord === 'idle' && !e.tgt && d2(e.x, e.y, A.rallyX, A.rallyY) > 6 * 6 * TILE * TILE; });
      if (strays.length) G.cmd.move(pid, ids(strays), A.rallyX, A.rallyY);
    }

    // 3) Angriffswelle
    if (!A.attack.length && !A.defending && canAttack() && waveGapOk(countering)) {   // v1.0.1 KI-Leicht: waveGapOk (nur Stufen mit cfg.waveGap)
      var R = countering ? 22 : 9, cx = countering ? A.homeX : A.rallyX, cy = countering ? A.homeY : A.rallyY;
      var ready = home.filter(function (e) { return d2(e.x, e.y, cx, cy) < R * R * TILE * TILE && (e.ord === 'idle' || (countering && e.ord === 'move')); });
      var keepHome = ss > cfg.first * 3 ? 1 : cfg.defense;
      var need = A.waveSize;
      if (A.allIn) keepHome = 0;
      // Spätphase: kleinere Schwelle, keine Heimwache, damit Partien nicht im Patt enden
      if (ss > cfg.first * cfg.late) { keepHome = 0; need = Math.min(need, cfg.wave + 2); }
      if (countering) { keepHome = Math.min(keepHome, 1); need = Math.max(4, Math.ceil(cfg.wave * 0.6)); }
      // Schwelle nach Armeewert (nicht Stückzahl), damit die günstigere Fraktion nicht früher und schwächer angreift
      ready.sort(function (a, b) { return (a.mc - b.mc) || (a.id - b.id); });
      var go = ready.slice(keepHome), val = 0;
      var capFull = false;   // v1.0.1 KI-Leicht: Wellen-Obergrenze (Stückzahl) – Rest bleibt als Heimwache
      if (cfg.waveCap) { var capN = waveCapN(); if (go.length >= capN) { go = go.slice(0, capN); capFull = true; } }
      for (i = 0; i < go.length; i++) val += G.Sim.statsOf(go[i]).cost;   // v1.0: übernommene Fremdeinheiten (Werte nach Herkunft)
      if (go.length >= 3 && (val >= need * D.AI_UNIT_VALUE || capFull)) {
        // Verteidiger zurückbehalten: die schwächsten/langsamsten (Infanterie zuerst)
        A.attack = ids(go); A.attackStart = A.attack.length; A.waves++;
        if (A.firstAtkT == null) A.firstAtkT = S.tick;   // v0.7: Zeitpunkt des ersten Angriffs (Statistik/Tests)
        if (cfg.waveCap) { A.waveT = S.tick; A.attackVal = val; }   // v1.0.1 KI-Leicht
        if (!countering) A.waveSize = Math.min(cfg.maxWave, A.waveSize + cfg.growth);
        A.counterT = 0;
        sendAttack();
      }
    } else if (A.attack.length) {
      // Rückzug, wenn die Gruppe zerschlagen ist
      if ((A.attack.length < Math.max(3, A.attackStart * 0.2) && !pushing) || waveBeaten()) {   // v1.0.1 KI-Leicht: waveBeaten (Rückzug bei Verlusten)
        G.cmd.move(pid, A.attack, A.rallyX, A.rallyY);
        A.attack = [];
        return;
      }
      // Nachschub: überzählige Heimtruppen stoßen zur laufenden Welle (beim erfolgreichen Vorstoß sofort alle)
      if (!A.defending && cfg.reinforce && !cfg.waveCap) {   // v1.0.1 KI-Leicht: mit Wellen-Obergrenze kein Nachschub (würde sie umgehen)
        var keep = pushing || A.allIn || ss > cfg.first * cfg.late ? 0 : (ss > cfg.first * 3 ? 1 : cfg.defense);
        var spare = home.filter(function (e) { return e.ord === 'idle' && d2(e.x, e.y, A.rallyX, A.rallyY) < 9 * 9 * TILE * TILE; });
        if (spare.length >= keep + (pushing || A.allIn ? 2 : 3)) {
          spare.sort(function (a, b) { return (a.mc - b.mc) || (a.id - b.id); });
          var reinf = ids(spare.slice(keep));
          A.attack = A.attack.concat(reinf);
          // als Trupp zum Schwerpunkt der Welle (nicht einzeln zum Ziel tröpfeln)
          var gc = centroid(A.attack);
          G.cmd.attackMove(pid, reinf, gc.x, gc.y);
        }
      }
      if (A.swRetarget) { A.swRetarget = 0; sendAttack(); }   // gegnerische Superwaffe bekannt → sofort umlenken
      if (A.hunted && S.map.w * S.map.h > 6000) huntSeen();   // v0.9: gesehene Erzkacheln für die Suche merken
      cohesion();
      siege();
      // Ziel erreicht/zerstört? neues Ziel
      var idle = 0;
      for (i = 0; i < A.attack.length; i++) { var u = G.Sim.get(A.attack[i]); if (u.ord === 'idle' && !u.tgt && d2(u.x, u.y, A.tx, A.ty) < 8 * 8 * TILE * TILE) idle++; }
      if (idle > A.attack.length * 0.6 || S.tick - A.lastTargetT > 20 * 90) sendAttack();
    }
  }

  function ids(arr) { return arr.map(function (e) { return e.id; }); }
  // ---- v1.0.1 KI-Leicht: Wellen-Obergrenze, Mindestabstand, Rückzug (nur Stufen mit cfg.waveCap: Sehr leicht, Leicht, Mittel gegen Menschen) ----
  /** Höchstzahl Einheiten der nächsten Welle: waveCap = [erste, Zuwachs je Welle, Obergrenze]. */
  function waveCapN() { var c = cfg.waveCap; return Math.min(c[2], c[0] + (A.waves || 0) * c[1]); }
  /** Mindestabstand zwischen zwei Wellen (cfg.waveGap s, ab Start der vorigen); Gegenstöße ausgenommen. */
  function waveGapOk(countering) { return !cfg.waveGap || countering || !A.waveT || S.tick - A.waveT >= cfg.waveGap * D.TICK_HZ; }
  /** Welle hat mehr als (1 − retreatAt) ihres Startwerts verloren → Rückzug (wie ein vorsichtiger Spieler). */
  function waveBeaten() {
    if (!cfg.retreatAt || !A.attackVal) return false;
    var v = 0;
    for (var i = 0; i < A.attack.length; i++) { var u = G.Sim.get(A.attack[i]); if (u && !u.dead) v += G.Sim.statsOf(u).cost; }
    if (v >= A.attackVal * cfg.retreatAt) return false;
    A.retreats = (A.retreats || 0) + 1;   // Statistik/Tests
    return true;
  }
  /** v0.5: Welle trifft auf gegnerische Verteidigungsanlage (Turm, Bunker, Laser/Blitz): Haubitzen, Panzer und Raketentrupps
   *  nehmen sie gemeinsam unter Feuer (Haubitzen aus 11 Kacheln, außerhalb der Turmreichweite); der Rest kämpft weiter.
   *  Nur wenn kaum gegnerische Einheiten dort stehen (sonst Feldschlacht zuerst). */
  function siege() {
    if (cfg.noSiege || A.attack.length < 3) return;
    var c = centroid(A.attack), best = null, bd = 1e18;
    for (var id in P.mem) {
      var m = P.mem[id];
      if (!TOWERS[m.type] || m.owner === pid || m.owner < 0) continue;
      var b = G.Sim.get(m.id);
      if (!b || b.dead || b.owner === pid) continue;
      var mx = (m.tx + m.w / 2) * TILE, my = (m.ty + m.h / 2) * TILE, dd = d2(mx, my, c.x, c.y) + tk(mx, my) * 1e-6;
      var R = ((D.BUILDINGS[m.type].weapon ? D.BUILDINGS[m.type].weapon.range : 6) + 5) * TILE;
      if (dd < R * R && dd < bd) { bd = dd; best = b; }
    }
    if (!best) { A.siegeId = 0; return; }
    if (enemiesNear(best.x, best.y, 7 * TILE) > A.attack.length * 0.5) return;
    var hit = [];
    for (var i = 0; i < A.attack.length; i++) {
      var u = G.Sim.get(A.attack[i]);
      if (!u || u.dead) continue;
      var st = G.Sim.statsOf(u);
      if (!st.weapon || st.weapon.type === 'bullet' || st.weapon.type === 'sniper' || st.weapon.type === 'flame') continue;   // Schützen/Buggys/Scharfschützen/Flammenwerfer: weiter gegen Einheiten
      if (u.ord === 'attack' && u.tgt === best.id) continue;
      if (u.ord === 'attack' && u.tgt) { var ct = G.Sim.get(u.tgt); if (ct && ct.kind === 'unit') continue; }
      hit.push(u.id);
    }
    if (hit.length) G.cmd.attack(pid, hit, best.id);
    if (A.siegeId !== best.id) { A.siegeId = best.id; A.sieges = (A.sieges || 0) + 1; }
  }
  function centroid(idList) {
    var x = 0, y = 0, n = 0;
    for (var i = 0; i < idList.length; i++) { var u = G.Sim.get(idList[i]); if (u && !u.dead) { x += u.x; y += u.y; n++; } }
    return n ? { x: x / n, y: y / n } : { x: A.rallyX, y: A.rallyY };
  }
  /** Zusammenhalt der Welle auf dem Marsch: Vorauseilende warten, bis der Schwerpunkt aufgeschlossen hat;
   *  Nachzügler/Verstärkung am Schwerpunkt marschieren weiter zum Ziel. */
  function cohesion() {
    if (A.attack.length < 4) return;
    var c = centroid(A.attack), dC = Math.sqrt(d2(c.x, c.y, A.tx, A.ty));
    // v0.9 (große Karten): Schwerpunkt ohne Ausreißer (Einheiten > 20 Kacheln hinter/vor der Mitte der Welle, z. B. Nachzügler in der Basis) –
    // sonst hielt die Spitze der Welle dauerhaft an; Halten höchstens 30 s am Stück
    var dl = [];
    for (var j = 0; j < A.attack.length; j++) { var uj = G.Sim.get(A.attack[j]); if (uj && !uj.dead) dl.push(Math.sqrt(d2(uj.x, uj.y, A.tx, A.ty))); }
    dl.sort(function (a, b) { return a - b; });
    var dm = dl.length ? dl[dl.length >> 1] : dC, core = [];
    for (j = 0; j < A.attack.length; j++) { var uk = G.Sim.get(A.attack[j]); if (uk && !uk.dead && Math.abs(Math.sqrt(d2(uk.x, uk.y, A.tx, A.ty)) - dm) <= 20 * TILE) core.push(uk.id); }
    var big = S.map.w * S.map.h > 6000;   // nur große Karten (kleine Karten: Verhalten und Balance wie v0.8)
    if (big && core.length >= 3 && core.length < A.attack.length) { c = centroid(core); dC = Math.sqrt(d2(c.x, c.y, A.tx, A.ty)); }
    var holdOk = !big || !A.holdT || S.tick - A.holdT < 20 * 30;
    var hold = [], go = [], catchUp = [];
    for (var i = 0; i < A.attack.length; i++) {
      var u = G.Sim.get(A.attack[i]);
      if (!u || u.tgt) continue;
      var dT = Math.sqrt(d2(u.x, u.y, A.tx, A.ty)), dc2 = d2(u.x, u.y, c.x, c.y);
      if (dC > 10 * TILE && u.ord === 'amove' && dT < dC - 6 * TILE) { if (holdOk) hold.push(u.id); }
      else if (u.ord === 'idle' && (dT >= dC - 3 * TILE || dC <= 10 * TILE) && dc2 < 8 * 8 * TILE * TILE) go.push(u.id);
      // v0.9 (große Karten): untätige Nachzügler weit hinter dem Schwerpunkt schließen auf – sonst warteten die Vorauseilenden
      // (angehalten) auf einen Schwerpunkt, der sich nie bewegt (Patt mit 100+ Einheiten mitten auf der Karte)
      else if (big && u.ord === 'idle' && dT >= dC + 6 * TILE && dc2 >= 12 * 12 * TILE * TILE) catchUp.push(u.id);
    }
    if (hold.length) { G.cmd.stop(pid, hold); if (big && !A.holdT) A.holdT = S.tick; } else if (big && (holdOk || S.tick - A.holdT > 20 * 60)) A.holdT = 0;
    if (go.length) G.cmd.attackMove(pid, go, A.tx, A.ty);
    if (catchUp.length) G.cmd.attackMove(pid, catchUp, c.x, c.y);
  }
  function enemiesNear(x, y, r) {
    var n = 0;
    for (var i = 0; i < S.ents.length; i++) {
      var e = S.ents[i];
      if (e.dead || e.kind !== 'unit' || e.owner === pid) continue;
      if (d2(e.x, e.y, x, y) < r * r && G.Sim.isVisible(pid, e)) n++;
    }
    return n;
  }

  /** Suchziel: nicht sichtbare Erzkachel (Raster 4), abwechselnd nach Nähe zur gegnerischen Basis. */
  function huntSeen() {
    var w = S.map.w, vis = P.vis, hs = A.hseen = A.hseen || {};
    for (var y = 2; y < S.map.h; y += 4) for (var x = 2; x < w; x += 4) { var i = y * w + x; if (vis[i] && S.map.oreMax[i] > 0) hs[i] = S.tick; }
    for (y = S.map.h - 3; y >= 0; y -= 4) for (x = w - 3; x >= 0; x -= 4) { i = y * w + x; if (vis[i] && S.map.oreMax[i] > 0) hs[i] = S.tick; }   // gespiegeltes Raster
  }
  function huntTarget(cx, cy) {
    var w = S.map.w, vis = P.vis, list = [];
    var hfl = flipped();
    // v0.9 große Karten: zuletzt gesehene Erzkacheln (< 3 min) überspringen – sonst pendelte die Suche zwischen den nächsten (gerade verlassenen)
    // Feldern an der gegnerischen Startbasis, während ein entfernter Ausbau (Raffinerie an einer dritten Basis) nie gefunden wurde
    var big = w * S.map.h > 6000, hs = big ? (A.hseen = A.hseen || {}) : null;
    for (var y0 = 2; y0 < S.map.h; y0 += 4) for (var x0 = 2; x0 < w; x0 += 4) {
      var y = hfl ? S.map.h - 1 - y0 : y0, x = hfl ? w - 1 - x0 : x0;   // v0.8: Raster gespiegelt
      var i = y * w + x;
      if (S.map.oreMax[i] <= 0) continue;
      if (vis[i]) { if (hs) hs[i] = S.tick; continue; }
      if (hs && hs[i] && S.tick - hs[i] < 20 * 180) continue;
      list.push(i);
    }
    if (!list.length) return { x: A.enemyX, y: A.enemyY };
    list.sort(function (a, b) {
      return d2((a % w + 0.5) * TILE, (Math.floor(a / w) + 0.5) * TILE, A.enemyX, A.enemyY) - d2((b % w + 0.5) * TILE, (Math.floor(b / w) + 0.5) * TILE, A.enemyX, A.enemyY) || (flipped() ? b - a : a - b);
    });
    A.huntIdx = ((A.huntIdx || 0) + 1) % Math.min(list.length, 6);
    var t = list[A.huntIdx];
    return { x: (t % w + 0.5) * TILE, y: (Math.floor(t / w) + 0.5) * TILE };
  }

  /** Wählt ein Angriffsziel (Priorität: Sammler/Raffinerie > Produktion > Rest; Türme meiden wenn schwach). */
  function sendAttack() {
    A.lastTargetT = S.tick;
    var cx = 0, cy = 0, n = 0;
    for (var i = 0; i < A.attack.length; i++) { var u = G.Sim.get(A.attack[i]); cx += u.x; cy += u.y; n++; }
    if (!n) return;
    cx /= n; cy /= n;
    var best = null, bs = -1e18;
    var PRIO = { refinery: 300, harvester: 320, factory: 220, barracks: 200, power: 160, hq: 120, turret: 60, mg: 60,
                 techcenter: 240, orbital: 460, silo: 460, pbunker: 50, laser: 70, tesla: 70 };
    // bekannte gegnerische Verteidigung (ohne Mauern) einmal sammeln
    var towersK = [];
    for (var tid in P.mem) { var tm = P.mem[tid]; if (TOWERS[tm.type] && tm.owner !== pid) towersK.push({ x: (tm.tx + tm.w / 2) * TILE, y: (tm.ty + tm.h / 2) * TILE, k: (tm.type === 'laser' || tm.type === 'tesla') ? 2 : 1 }); }
    // sichtbare Sammler
    for (i = 0; i < S.ents.length; i++) {
      var e = S.ents[i];
      if (e.dead || e.owner === pid || e.kind !== 'unit' || e.type !== 'harvester' || !G.Sim.isVisible(pid, e)) continue;
      var sc = PRIO.harvester - Math.sqrt(d2(e.x, e.y, cx, cy)) / TILE * 4;
      if (sc > bs) { bs = sc; best = { x: e.x, y: e.y }; }
    }
    // erinnerte Gebäude
    for (var id in P.mem) {
      var m = P.mem[id];
      if (m.neutral || m.type === 'wall' || m.owner === pid) continue;
      var mx = (m.tx + m.w / 2) * TILE, my = (m.ty + m.h / 2) * TILE;
      var s = (PRIO[m.type] || 100) - Math.sqrt(d2(mx, my, cx, cy)) / TILE * 4;
      // Türme in der Nähe meiden, wenn die Gruppe klein ist
      var tur = 0;
      for (var k2 = 0; k2 < towersK.length; k2++) if (d2(towersK[k2].x, towersK[k2].y, mx, my) < 7 * 7 * TILE * TILE) tur += towersK[k2].k;
      if (!D.BUILDINGS[m.type].superweapon) s -= tur * (A.attack.length < 8 ? 80 : 25);   // gegnerische Superwaffe: trotzdem angreifen
      if (s > bs) { bs = s; best = { x: mx, y: my }; }
    }
    if (!best) {
      // nichts Bekanntes: erst Startposition des Gegners, dort angekommen → Erzfelder absuchen (Ausbauten finden)
      // v0.9 große Karten: „dort angekommen“ = ≥ 40 % der Welle in 10 Kacheln um die Startposition (der Schwerpunkt einer weit verteilten Welle erreichte sie nie)
      var arrived = d2(cx, cy, A.enemyX, A.enemyY) <= 8 * 8 * TILE * TILE;
      if (!arrived && S.map.w * S.map.h > 6000) {
        var nE = 0;
        for (i = 0; i < A.attack.length; i++) { var ua = G.Sim.get(A.attack[i]); if (ua && d2(ua.x, ua.y, A.enemyX, A.enemyY) < 10 * 10 * TILE * TILE) nE++; }
        arrived = nE >= A.attack.length * 0.4;
      }
      if (!arrived && !A.hunted) best = { x: A.enemyX, y: A.enemyY };
      else { A.hunted = 1; best = huntTarget(cx, cy); }
    } else A.hunted = 0;
    A.tx = best.x; A.ty = best.y;
    G.cmd.attackMove(pid, A.attack, best.x, best.y);
  }


  // ------------------------------------------------------------------ v0.5 (SPEC_v05 §4)
  /** Eigene Bunker mit Infanterie aus der Heimtruppe besetzen (fehlt Infanterie: Schützen nachbestellen). */
  function bunkers() {
    var bks = ents(function (e) { return e.owner === pid && e.kind === 'building' && e.type === 'pbunker'; });
    if (!bks.length) return;
    var inAtk = {}, busy = {}, i;
    for (i = 0; i < A.attack.length; i++) inAtk[A.attack[i]] = 1;
    if (A.capJobs) for (var k in A.capJobs) busy[A.capJobs[k].u] = 1;
    for (i = 0; i < bks.length; i++) {
      var b = bks[i], coming = 0;
      for (var j = 0; j < S.ents.length; j++) { var o = S.ents[j]; if (!o.dead && o.owner === pid && o.ord === 'enter' && o.enterId === b.id) coming++; }
      var free = Math.min(b.cap, cfg.bunkerFill || b.cap) - b.gar.length - coming;
      if (free <= 0) continue;
      var pool = ents(function (e) {
        return e.owner === pid && e.kind === 'unit' && !e.inside && isInf(e) && e.type !== 'engineer' && e.type !== 'medic' && !inAtk[e.id] && !busy[e.id] && !reserved(e) &&
               e.ord !== 'enter' && (e.ord === 'idle' || e.ord === 'move') && d2(e.x, e.y, b.x, b.y) < 22 * 22 * TILE * TILE;
      });
      if (!pool.length) { A.wantRifle = 1; continue; }
      // Schützen zuerst (Raketen bleiben bei der Armee), nächste zuerst
      pool.sort(function (a, c) { return ((a.type === 'rifle' ? 0 : 1) - (c.type === 'rifle' ? 0 : 1)) || d2(a.x, a.y, b.x, b.y) - d2(c.x, c.y, b.x, b.y) || a.id - c.id; });
      var r = G.cmd.enter(pid, ids(pool.slice(0, free)), b.id);
      if (r.ok) A.bunkerIn = (A.bunkerIn || 0) + r.n;
    }
  }

  /** Mauerlinie quer zur Marschroute Richtung Gegner an der engsten Stelle 5–13 Kacheln vor der Basis (mit Durchlass). */
  function walls() {
    if (!cfg.wallSeg || (A.wallLines || 0) >= cfg.wallLines || (A.wallsPlaced || 0) >= cfg.wallSeg) return;
    var secs = S.tick / D.TICK_HZ;
    if (secs < cfg.wallAt + (A.wallLines || 0) * 180 || A.defending || A.allIn || P.credits < 700) return;
    if (S.tick - (A.wallTry || -1e9) < 20 * 40) return;
    if (!G.Sim.canProduce(pid, 'wall').ok) return;
    A.wallTry = S.tick;
    var plan = planWallLine(Math.min(cfg.wallSeg - (A.wallsPlaced || 0), 6));
    if (!plan) { A.wallFails = (A.wallFails || 0) + 1; if (A.wallFails >= 3) A.wallLines = cfg.wallLines; return; }
    var r = G.cmd.placeWall(pid, plan.tiles);
    if (r.ok) {
      A.wallsPlaced = (A.wallsPlaced || 0) + r.placed; A.wallLines = (A.wallLines || 0) + 1;
      A.wallK = (A.wallK || []).concat([plan.k]);
      A.gateT = (plan.gates || []).filter(function (t) { return t != null; });   // v1.2: Tor in den Durchlass (chooseDef12)
    } else { A.wallFails = (A.wallFails || 0) + 1; if (A.wallFails >= 3) A.wallLines = cfg.wallLines; }
  }
  var bfsSeen = null, bfsQ = null;
  /** BFS (Fahrzeuge) von Kachel a nach b; block = Objekt gesperrter Kacheln. Nur lesend. */
  function reachable(a, b, block) {
    var w = S.map.w, h = S.map.h, N = w * h;
    if (!bfsSeen || bfsSeen.length !== N) { bfsSeen = new Uint8Array(N); bfsQ = new Int32Array(N); }
    bfsSeen.fill(0);
    var qh = 0, qt = 0;
    bfsQ[qt++] = a; bfsSeen[a] = 1;
    while (qh < qt) {
      var c = bfsQ[qh++];
      if (c === b) return true;
      var cx = c % w, cy = (c - cx) / w;
      for (var d = 0; d < 4; d++) {
        var nx = cx + (d === 0 ? 1 : d === 1 ? -1 : 0), ny = cy + (d === 2 ? 1 : d === 3 ? -1 : 0);
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        var ni = ny * w + nx;
        if (bfsSeen[ni] || block[ni] || !G.Path.passable(1, ni)) continue;
        bfsSeen[ni] = 1; bfsQ[qt++] = ni;
      }
    }
    return false;
  }
  function planWallLine(maxSeg) {
    var w = S.map.w, h = S.map.h, TER = D.TERRAIN;
    var st = G.Path.nearestPassable(1, Math.floor(A.rallyX / TILE), Math.floor(A.rallyY / TILE), 5);
    var en = G.Path.nearestPassable(1, Math.floor(A.enemyX / TILE), Math.floor(A.enemyY / TILE) + 3, 6);
    if (st < 0 || en < 0) return null;
    var hs = G.Path.nearestPassable(1, Math.floor(A.homeX / TILE), Math.floor(A.homeY / TILE) + 2, 5);
    if (hs < 0) return null;
    var path = G.Path.find(1, hs % w, Math.floor(hs / w), en % w, Math.floor(en / w), 6000, undefined, flipped());   // v0.8: gespiegelter Gleichstand
    if (path.length < 16) return null;
    var best = null, used = A.wallK || [];
    for (var k = 3; k < Math.min(path.length - 3, 40); k++) {
      var c = path[k], cx = c % w, cy = (c - cx) / w;
      var dh = Math.sqrt(d2((cx + .5) * TILE, (cy + .5) * TILE, A.homeX, A.homeY)) / TILE;
      if (dh < 6 || dh > 13) continue;
      var tooClose = false;
      for (var u = 0; u < used.length; u++) if (Math.abs(used[u] - k) < 4) tooClose = true;
      if (tooClose) continue;
      var p0 = path[k - 3], p1 = path[k + 3];
      var dx = (p1 % w) - (p0 % w), dy = Math.floor(p1 / w) - Math.floor(p0 / w), l = Math.sqrt(dx * dx + dy * dy) || 1;
      // senkrecht zur Marschrichtung, auf 8 Richtungen gerundet
      var nx = Math.round(-dy / l), ny = Math.round(dx / l);
      if (!nx && !ny) continue;
      var side = [[], []], width = 1;
      for (var sd = 0; sd < 2; sd++) {
        var sg = sd ? -1 : 1;
        for (var o = 1; o <= 7; o++) {
          var x = cx + nx * o * sg, y = cy + ny * o * sg;
          if (x < 0 || y < 0 || x >= w || y >= h) break;
          var ti = y * w + x;
          if (!G.Path.passable(1, ti)) break;
          width++;
          side[sd].push(ti);
        }
      }
      // Durchlass: Pfadkachel ± 2 bleibt frei (5 Kacheln, damit die eigenen Wellen nicht stauen);
      // Mauer auf beiden Seiten von außen (an Fels/Wasser angelehnt) nach innen, nur bebaubar/frei
      var tiles = [];
      for (sd = 0; sd < 2; sd++) {
        var arr = side[sd];
        for (o = arr.length - 1; o >= 2; o--) {
          var t2 = arr[o];
          if (!TER[S.map.terrain[t2]].build || S.map.ore[t2] > 0) continue;
          if (nearOwnBuilding(t2) || nearOre(t2, 3)) continue;   // Sammlerwege/Andockplätze freihalten
          tiles.push(t2);
        }
      }
      if (tiles.length < 2 || width > 11) continue;   // nur echte Engstellen
      // Engstelle: wenig freie Breite, Mauer deckt einen großen Teil ab
      var cover = Math.min(tiles.length, maxSeg) / width;
      var sc = width * 2 - cover * 6 + Math.abs(dh - 9) * 0.5;
      if (!best || sc < best.s) best = { s: sc, k: k, tiles: tiles, width: width, gates: [side[0][1], side[1][1]] };   // v1.2: gates = Kacheln am Rand des Durchlasses
    }
    if (!best) return null;
    // die äußeren Segmente zuerst (an Fels/Wasser angelehnt), höchstens maxSeg
    var sel = best.tiles.slice(0, maxSeg), block = {};
    for (var i = 0; i < sel.length; i++) block[sel[i]] = 1;
    if (!reachable(hs, en, block)) return null;
    // Nähe-Regel/Kette: mindestens ein Segment nahe der Basis, sonst würde placeWall alles verwerfen
    var pl = G.Sim.canPlaceWall(pid, sel);
    if (!pl.n) return null;
    return { tiles: sel, k: best.k, gates: best.gates };
  }
  function nearOre(ti, r) {
    var w = S.map.w, x = ti % w, y = (ti - x) / w;
    for (var oy = -r; oy <= r; oy++) for (var ox = -r; ox <= r; ox++) {
      var nx = x + ox, ny = y + oy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < S.map.h && S.map.oreMax[ny * w + nx] > 0) return true;
    }
    return false;
  }
  function nearOwnBuilding(ti) {
    var w = S.map.w, x = ti % w, y = (ti - x) / w;
    for (var oy = -2; oy <= 2; oy++) for (var ox = -2; ox <= 2; ox++) {
      var nx = x + ox, ny = y + oy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= S.map.h) continue;
      var id = S.occ[ny * w + nx];
      if (!id) continue;
      var b = G.Sim.get(id);
      if (b && !D.BUILDINGS[b.type].isWall) return true;
    }
    return false;
  }

  /** Expansion: braucht der aufgebaute Außenposten noch eine Raffinerie? */
  function expNeedsRefinery() {
    var hq = G.Sim.get(A.exp.hq);
    if (!hq || hq.dead || hq.owner !== pid) { A.exp = null; return false; }
    var refs = mine('building', 'refinery');
    for (var i = 0; i < refs.length; i++) if (d2(refs[i].x, refs[i].y, A.exp.oreX, A.exp.oreY) < 10 * 10 * TILE * TILE) return false;
    return true;
  }
  /** Mobilen Bauhof bauen, zu einem entfernten Erzfeld fahren und aufbauen (Mittel/Schwer, ab cfg.mcvAt). */
  function expand() {
    if (!cfg.mcv) return;
    var secs = S.tick / D.TICK_HZ;
    var mcvs = ents(function (e) { return e.owner === pid && e.kind === 'unit' && e.type === 'mcv'; });
    // laufender Auftrag: Fahrzeug steuern
    for (var i = 0; i < mcvs.length; i++) driveMcv(mcvs[i]);
    if (secs < cfg.mcvAt || mcvs.length || A.defending || A.allIn || (A.mcvFails || 0) >= 3) return;
    if (P.q.vehicle.some(function (it) { return it.type === 'mcv'; })) return;
    if (G.Sim.countOf(pid, 'hq', 'building') >= cfg.maxHq || !G.Sim.hasBuilding(pid, 'factory')) return;
    // nur aus einem Überschuss heraus (kein Ansparen – sonst fehlt die Armee); später genügt weniger
    if (armyValue() < 3000 || P.credits < (secs > cfg.mcvAt + 300 ? 700 : 1300)) return;
    if (S.tick - (A.mcvT || -1e9) < 20 * 60) return;
    var tgt = expansionSite();
    if (!tgt) { A.mcvT = S.tick; return; }
    if (G.cmd.produce(pid, 'mcv').ok) { A.mcvT = S.tick; A.mcvGoal = tgt; A.mcvBuilt = (A.mcvBuilt || 0) + 1; }
  }
  function driveMcv(u) {
    var g = A.mcvGoal;
    if (!g) { g = A.mcvGoal = expansionSite(); if (!g) { if (G.Sim.canDeploy(pid, u.id).ok) G.cmd.deploy(pid, u.id); return; } }
    var gx = (g.tx + 0.5) * TILE, gy = (g.ty + 0.5) * TILE, dd = d2(u.x, u.y, gx, gy);
    if (dd < 1.2 * 1.2 * TILE * TILE || (u.ord === 'idle' && dd < 4 * 4 * TILE * TILE)) {
      var c = G.Sim.canDeploy(pid, u.id);
      if (c.ok) {
        var r = G.cmd.deploy(pid, u.id);
        if (r.ok) { A.exp = { hq: r.id, oreX: g.oreX, oreY: g.oreY }; A.mcvGoal = null; A.deploys = (A.deploys || 0) + 1; }
        return;
      }
      // Platz belegt: neuen Platz nahe dem Erz suchen
      g.tries = (g.tries || 0) + 1;
      var alt = deploySpotNear(g.oreX, g.oreY, Math.floor(u.x / TILE), Math.floor(u.y / TILE));
      if (alt && g.tries < 5) { A.mcvGoal = { tx: alt.tx, ty: alt.ty, oreX: g.oreX, oreY: g.oreY, tries: g.tries }; G.cmd.move(pid, [u.id], (alt.tx + .5) * TILE, (alt.ty + .5) * TILE); }
      else { A.mcvFails = (A.mcvFails || 0) + 1; A.mcvGoal = null; }
      return;
    }
    if (u.ord === 'idle' || (S.tick - (A.mcvMoveT || 0) > 20 * 20 && !u.moving)) {
      G.cmd.move(pid, [u.id], gx, gy); A.mcvMoveT = S.tick;
      g.moves = (g.moves || 0) + 1;
      if (g.moves > 12) { A.mcvGoal = null; A.mcvFails = (A.mcvFails || 0) + 1; }
    }
  }
  /** Bestes entferntes, unversorgtes Erzfeld auf der eigenen Kartenhälfte (oder Mitte) ohne bekannte Gegnerbauten. */
  function expansionSite() {
    var w = S.map.w, h = S.map.h, refs = mine('building', 'refinery'), hqs = mine('building', 'hq');
    var foes = [];
    for (var id in P.mem) { var m = P.mem[id]; if (!m.neutral && m.owner !== pid && m.type !== 'wall') foes.push({ x: (m.tx + m.w / 2) * TILE, y: (m.ty + m.h / 2) * TILE }); }
    var best = null, bs = -1e18;
    var efl = flipped();
    for (var y0 = 1; y0 < h - 1; y0 += 2) for (var x0 = 1; x0 < w - 1; x0 += 2) {
      var y = efl ? h - 1 - y0 : y0, x = efl ? w - 1 - x0 : x0;   // v0.8: Raster + Reihenfolge gespiegelt
      var i = y * w + x;
      if (S.map.ore[i] < 150) continue;
      var px = (x + .5) * TILE, py = (y + .5) * TILE, k, ok = true;
      for (k = 0; k < refs.length && ok; k++) if (d2(px, py, refs[k].x, refs[k].y) < 13 * 13 * TILE * TILE) ok = false;
      for (k = 0; k < hqs.length && ok; k++) if (d2(px, py, hqs[k].x, hqs[k].y) < 12 * 12 * TILE * TILE) ok = false;
      for (k = 0; k < foes.length && ok; k++) if (d2(px, py, foes[k].x, foes[k].y) < 14 * 14 * TILE * TILE) ok = false;
      if (!ok) continue;
      var dh = Math.sqrt(d2(px, py, A.homeX, A.homeY)), de = Math.sqrt(d2(px, py, A.enemyX, A.enemyY));
      if (dh > de * 1.05) continue;
      // Erzmenge im Umkreis 4
      var sum = 0;
      for (var oy = -4; oy <= 4; oy++) for (var ox = -4; ox <= 4; ox++) {
        var xx = x + ox, yy = y + oy;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h) sum += S.map.ore[yy * w + xx];
      }
      if (sum < 4000) continue;
      var sc = sum / 100 - dh / TILE * 3 - (enemiesNear(px, py, 10 * TILE) * 50);
      if (sc > bs) { bs = sc; best = { x: px, y: py, tx: x, ty: y }; }
    }
    if (!best) return null;
    var sp = deploySpotNear(best.x, best.y, Math.floor(A.homeX / TILE), Math.floor(A.homeY / TILE));
    if (!sp) return null;
    return { tx: sp.tx, ty: sp.ty, oreX: best.x, oreY: best.y };
  }
  /** Aufbau-Kachel (Mitte des 3×3) 3–7 Kacheln vom Erz, mit freiem Rand, zur Seite (fx,fy) hin bevorzugt. */
  function deploySpotNear(ox, oy, fx, fy) {
    var w = S.map.w, cx = Math.floor(ox / TILE), cy = Math.floor(oy / TILE), best = null, bs = 1e18;
    for (var r = 3; r <= 7; r++) for (var dy = -r; dy <= r; dy++) for (var dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      var x = cx + dx, y = cy + dy;
      var c = G.Sim.canDeployAt(pid, x, y, -1);
      if (!c.ok || !clearRing(x - 1, y - 1, 3, 3)) continue;
      if (!G.Path.passable(1, y * w + x)) continue;
      var s = r * 4 + Math.sqrt((x - fx) * (x - fx) + (y - fy) * (y - fy)) * 0.5 + tk(x, y) * 1e-9;
      if (s < bs) { bs = s; best = { tx: x, ty: y }; }
    }
    return best;
  }

  // ================================================================== v0.8 Luftwaffe & Marine (SPEC_v08 §6)
  // Eigene Stufen-Tabelle (DIFF bleibt unverändert): airAt/navyAt = frühestens (s), air/navy = Höchstzahl je Typ, flak = höchstens Flak-Stellungen,
  // minArmy = Bodenarmee-Wert (Credits), ab dem Luft-/Seeproduktion läuft, drops = Absetzaktionen, every = Abstand zwischen Absetzaktionen (s)
  var AIRSEA = {
    easy:   { airAt: 720, navyAt: 720, air: { gunship: 1, bomber: 0, transheli: 0 }, navy: { gunboat: 2, destroyer: 0, lander: 0 }, flak: 1, minArmy: 2500, drops: false, every: 0,
              bombVal: 2500, navyWave: 2 },
    medium: { airAt: 360, navyAt: 330, air: { gunship: 2, bomber: 1, transheli: 1 }, navy: { gunboat: 2, destroyer: 2, lander: 1 }, flak: 2, minArmy: 2500, drops: true, every: 240,
              bombVal: 1800, navyWave: 3 },
    hard:   { airAt: 300, navyAt: 280, air: { gunship: 2, bomber: 2, transheli: 1 }, navy: { gunboat: 3, destroyer: 2, lander: 1 }, flak: 3, minArmy: 2500, drops: true, every: 180,
              bombVal: 1500, navyWave: 3 }
  };
  var AIR_T = { transheli: 1, gunship: 1, bomber: 1 }, NAVY_T = { gunboat: 1, destroyer: 1, lander: 1 };
  // v0.9 Schlachtschiff (SPEC_v08 §14): Höchstzahl je Stufe (navy.dreadnought), frühestens dreadAt s, nur mit Tech-Zentrum und Flotte im Wasser
  AIRSEA.easy.navy.dreadnought = 0; AIRSEA.medium.navy.dreadnought = 1; AIRSEA.hard.navy.dreadnought = 2;
  AIRSEA.easy.dreadAt = 1e9; AIRSEA.medium.dreadAt = 900; AIRSEA.hard.dreadAt = 720;
  NAVY_T.dreadnought = 1;
  var AAW = { flak: 1, rocket: 1, hunter: 1, mlrs: 1, destroyer: 1 };   // gegnerische Flugabwehr (für Bomber-/Hubschrauberziele)
  function XC() { var X = AIRSEA[P.ai] || AIRSEA.medium; return cfg.air ? xcHuman(X) : X; }   // v1.0.1 KI-Leicht: cfg.air (VS_HUMAN)
  function reservedV08(e) {
    var H = A.heliJob, L = A.landJob;
    return (!!H && (e.id === H.heli || H.units.indexOf(e.id) >= 0)) || (!!L && (e.id === L.boat || L.units.indexOf(e.id) >= 0));
  }
  function myUnits(f) { return ents(function (e) { return e.owner === pid && e.kind === 'unit' && !e.inside && f(e); }); }
  function cntU(t) { return G.Sim.countOf(pid, t, 'unit'); }

  /** Einmalig: Werft-Ufer an der eigenen Basis und Erreichbarkeit der gegnerischen Basis über dasselbe Gewässer. */
  function navyInit() {
    var w = S.map.w, h = S.map.h, st = S.map.starts[pid], en = S.map.starts[1 - pid] || st, best = null, bs = 1e18, tx, ty;
    // v0.8 Seitengleichheit: Suchfenster symmetrisch (vorher −9…+11 → für die gespiegelte Basis ein anderes Fenster), Gleichstand gespiegelt
    for (ty = Math.max(0, st.ty - 11); ty <= Math.min(h - 3, st.ty + 11); ty++) for (tx = Math.max(0, st.tx - 11); tx <= Math.min(w - 3, st.tx + 11); tx++) {
      var r = G.Sim.canPlace(pid, 'shipyard', tx, ty);
      if (!r.ok && r.reason !== 'Zu weit von der Basis') continue;
      var d = d2((tx + 1.5) * TILE, (ty + 1.5) * TILE, A.homeX, A.homeY) + (r.ok ? 0 : 4 * TILE * TILE * 9) + tk((tx + 1.5) * TILE, (ty + 1.5) * TILE) * 1e-6;
      if (d < bs) { bs = d; best = { tx: tx, ty: ty }; }
    }
    A.navy = { ok: false };
    if (!best) return;
    var comp = -1, k, i;
    for (k = 0; k < 9; k++) { i = (best.ty + Math.floor(k / 3)) * w + best.tx + k % 3; if (G.Path.waterComp(i) >= 0) { comp = G.Path.waterComp(i); break; } }
    if (comp < 0) return;
    // Wasser desselben Gewässers nahe der gegnerischen Basis (≤ 14 Kacheln) → Zielpunkt für die Flotte
    var ecx = en.tx + 1, ecy = en.ty + 1, eb = null, ebd = 1e18;
    for (ty = Math.max(0, ecy - 14); ty <= Math.min(h - 1, ecy + 14); ty++) for (tx = Math.max(0, ecx - 14); tx <= Math.min(w - 1, ecx + 14); tx++) {
      i = ty * w + tx;
      if (G.Path.waterComp(i) !== comp || !G.Path.terrainPassable(3, i)) continue;
      var dd = (tx - ecx) * (tx - ecx) + (ty - ecy) * (ty - ecy) + tk((tx + 0.5) * TILE, (ty + 0.5) * TILE) * 1e-9;
      if (dd < ebd) { ebd = dd; eb = { x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE }; }
    }
    if (!eb) return;
    A.navy = { ok: true, x: (best.tx + 1.5) * TILE, y: (best.ty + 1.5) * TILE, comp: comp, ex: eb.x, ey: eb.y };
  }

  /** v0.8: Flak, sobald gegnerische Luftfahrzeuge gesehen wurden (oder ein gegnerisches Flugfeld bekannt ist) – Verteidigungs-Warteschlange. */
  function chooseFlak(cnt) {
    if (!G.Sim.hasBuilding(pid, 'factory') || A.allIn) return null;
    var X = XC(), air = A.seenAir || 0, want = Math.min(X.flak, air > 0 ? 1 + Math.ceil(air / 2) : (A.enemyAirfield ? 1 : 0));
    if (cnt('flak') < want && P.credits > 650 && G.Sim.canProduce(pid, 'flak').ok) return 'flak';
    return null;
  }
  /** Bauentscheidung (aus chooseInner): Flugfeld, Werft. */
  function chooseAirSea(cnt) {
    if (!A.navy) navyInit();
    var X = XC(), secs = S.tick / D.TICK_HZ, fac = G.Sim.hasBuilding(pid, 'factory');
    if (!fac || A.allIn) return null;
    // (Flak läuft seit der Zusammenführung mit der Verteidigungs-Warteschlange über chooseFlak() in chooseDefenseInner())
    if (A.defending) return null;
    if (secs >= X.airAt && cnt('airfield') < 1 && P.credits > 900 && G.Sim.canProduce(pid, 'airfield').ok) return 'airfield';
    if (A.navy.ok && (A.navyFails || 0) < 2 && secs >= X.navyAt && cnt('shipyard') < 1 && P.credits > 700 && G.Sim.canProduce(pid, 'shipyard').ok) return 'shipyard';
    return null;
  }
  function flakAnchor() {
    var n = G.Sim.countOf(pid, 'flak', 'building'), bl = mine('building').filter(function (b) { return !D.BUILDINGS[b.type].defense && !b.neutral; });
    bl.sort(function (a, c) { return (SWVAL[c.type] || 300) - (SWVAL[a.type] || 300) || a.id - c.id; });
    var b = bl[n % Math.max(1, Math.min(3, bl.length))] || { x: A.homeX, y: A.homeY };
    return { x: (b.x + A.homeX) / 2, y: (b.y + A.homeY) / 2 };
  }

  function airSea() {
    if (!A.navy) navyInit();
    if (A.yardFail == null) A.yardFail = 0;
    var X = XC();
    // Werft ließ sich nicht setzen (placeReady bricht nach 6 Fehlversuchen ab) → nach 2 Abbrüchen aufgeben
    var yq = P.q.building.some(function (it) { return it.type === 'shipyard'; });
    if (A.yardQ && !yq && !G.Sim.hasBuilding(pid, 'shipyard')) A.navyFails = (A.navyFails || 0) + 1;
    A.yardQ = yq;
    seeAir();
    airProduction(X);
    navyProduction(X);
    gunships(X);
    bombers(X);
    heliDrop(X);
    fleet(X);
    landDrop(X);
    dreadnoughts(X);   // v0.9
  }
  /** Gegnerische Luftfahrzeuge (gesehen, gleitend) und bekanntes gegnerisches Flugfeld. */
  function seeAir() {
    var n = 0;
    for (var i = 0; i < S.ents.length; i++) { var e = S.ents[i]; if (!e.dead && e.kind === 'unit' && e.owner !== pid && e.mc === 2 && !e.inside && G.Sim.isVisible(pid, e)) n++; }
    A.seenAir = Math.max(n, (A.seenAir || 0) * 0.99);
    if (!A.enemyAirfield) for (var id in P.mem) if (P.mem[id].type === 'airfield' && P.mem[id].owner !== pid) { A.enemyAirfield = 1; break; }
    // mehr Raketentrupps gegen Luftfahrzeuge
    if (A.seenAir >= 1.5 && G.Sim.hasBuilding(pid, 'barracks') && P.q.infantry.length <= cfg.armyQ && G.Sim.rand() < 0.25) G.cmd.produce(pid, 'rocket');
  }
  function airProduction(X) {
    if (!G.Sim.hasBuilding(pid, 'airfield') || P.q.air.length || armyValue() < X.minArmy) return;
    var order = ['gunship', 'bomber', 'transheli', 'gunship', 'bomber'];
    for (var i = 0; i < order.length; i++) {
      var t = order[i], have = cntU(t);
      if (have >= (X.air[t] || 0)) continue;
      if (t === 'transheli' && !X.drops) continue;
      if (t === 'bomber' && X.bomberAt && S.tick < X.bomberAt * D.TICK_HZ) continue;   // v1.0.1 KI-Leicht (VS_HUMAN)
      if (P.credits < 250) return;   // Warteschlange bezahlt laufend (wie Boden): teilt sich das Einkommen mit der Bodenproduktion
      if (G.Sim.canProduce(pid, t).ok) { G.cmd.produce(pid, t); return; }
    }
  }
  function navyProduction(X) {
    if (!A.navy || !A.navy.ok || !G.Sim.hasBuilding(pid, 'shipyard') || P.q.naval.length || armyValue() < X.minArmy * 0.7) return;
    var order = ['gunboat', 'destroyer', 'dreadnought', 'gunboat', 'lander', 'destroyer', 'gunboat', 'dreadnought'];
    for (var i = 0; i < order.length; i++) {
      var t = order[i];
      if (cntU(t) >= (X.navy[t] || 0)) continue;
      if (t === 'lander' && !X.drops) continue;
      if (t === 'dreadnought' && !dreadOk(X)) continue;   // v0.9
      if (P.credits < 250) return;
      if (G.Sim.canProduce(pid, t).ok) { G.cmd.produce(pid, t); return; }
    }
  }
  /** Bekannte gegnerische Flugabwehr in der Nähe von (x, y): Flak-Stellungen (Gedächtnis) + sichtbare AA-Einheiten. */
  function aaNear(x, y, r) {
    var n = 0, R2 = r * r;
    for (var id in P.mem) { var m = P.mem[id]; if (m.type === 'flak' && m.owner !== pid && d2((m.tx + 0.5) * TILE, (m.ty + 0.5) * TILE, x, y) < R2) n += 2; }
    for (var i = 0; i < S.ents.length; i++) {
      var e = S.ents[i];
      if (e.dead || e.kind !== 'unit' || e.owner === pid || e.inside || !AAW[e.type] || !G.Sim.isVisible(pid, e)) continue;
      if (d2(e.x, e.y, x, y) < R2) n += e.type === 'rocket' ? 0.5 : 1;
    }
    return n;
  }
  /** Kampfhubschrauber: Basisverteidigung, sonst Begleitschutz der Bodenwelle bzw. Jagd auf Sammler (ab canAttack). */
  function gunships(X) {
    var gs = myUnits(function (e) { return e.type === 'gunship'; });
    if (!gs.length) return;
    var al = P.alert, hx = A.homeX, hy = A.homeY;
    for (var i = 0; i < gs.length; i++) {
      var g = gs[i];
      if (g.hp < g.maxHp * 0.35 && d2(g.x, g.y, hx, hy) > 8 * 8 * TILE * TILE) { if (g.ord !== 'move') G.cmd.move(pid, [g.id], hx, hy); continue; }
    }
    var ready = gs.filter(function (g) { return g.hp >= g.maxHp * 0.35 && (g.ord === 'idle' || g.ord === 'move' && d2(g.gx, g.gy, hx, hy) < 6 * 6 * TILE * TILE); });
    if (A.defending && S.tick - al.tick < 60 && d2(al.x, al.y, hx, hy) < 20 * 20 * TILE * TILE) {
      var dft = gs.filter(function (g) { return g.hp >= g.maxHp * 0.35 && g.ord !== 'amove' && g.ord !== 'attack'; });
      if (dft.length) G.cmd.attackMove(pid, ids(dft), al.x, al.y);
      return;
    }
    if (!canAttack() || !ready.length) return;
    if (A.attack.length >= 4) {
      var c = centroid(A.attack);
      var far = ready.filter(function (g) { return d2(g.x, g.y, c.x, c.y) > 6 * 6 * TILE * TILE; });
      if (far.length && S.tick - (A.gunT || -1e9) > 20 * 15) { A.gunT = S.tick; G.cmd.attackMove(pid, ids(far), c.x, c.y); }
      return;
    }
    if (ready.length < Math.min(2, X.air.gunship) || S.tick - (A.gunT || -1e9) < 20 * 45) return;
    // Sammler/Raffinerie ohne bekannte Flugabwehr
    var best = null, bs = -1e18;
    for (var k = 0; k < S.ents.length; k++) {
      var e = S.ents[k];
      if (e.dead || e.owner === pid || e.kind !== 'unit' || e.type !== 'harvester' || !G.Sim.isVisible(pid, e)) continue;
      var sc = 300 - aaNear(e.x, e.y, 8 * TILE) * 120 - Math.sqrt(d2(e.x, e.y, hx, hy)) / TILE;
      if (sc > bs) { bs = sc; best = { x: e.x, y: e.y }; }
    }
    for (var id in P.mem) {
      var m = P.mem[id];
      if (m.neutral || m.owner === pid || m.type !== 'refinery') continue;
      var mx = (m.tx + m.w / 2) * TILE, my = (m.ty + m.h / 2) * TILE, sm = 200 - aaNear(mx, my, 9 * TILE) * 120 - Math.sqrt(d2(mx, my, hx, hy)) / TILE;
      if (sm > bs) { bs = sm; best = { x: mx, y: my }; }
    }
    if (best && bs > 0) { A.gunT = S.tick; G.cmd.attackMove(pid, ids(ready), best.x, best.y); A.gunRaids = (A.gunRaids || 0) + 1; }
  }
  /** Bomber: aufmunitioniert und gelandet → Ziel mit dem höchsten Wert: Einheitenballung (Wert ≥ bombVal) oder Verteidigung/Produktion. */
  function bombers(X) {
    var bs = myUnits(function (e) { return e.type === 'bomber' && e.ammo > 0 && e.ord === 'idle'; });
    if (!bs.length || !canAttack()) return;
    var foes = ents(function (e) { return e.kind === 'unit' && e.owner !== pid && e.owner >= 0 && !e.inside && e.mc !== 2 && G.Sim.isVisible(pid, e); });
    var best = null, sc = 0, i, k;
    for (i = 0; i < foes.length; i++) {
      var v = 0;
      for (k = 0; k < foes.length; k++) if (d2(foes[i].x, foes[i].y, foes[k].x, foes[k].y) < 2.6 * 2.6 * TILE * TILE) v += G.Sim.statsOf(foes[k]).cost;
      v -= aaNear(foes[i].x, foes[i].y, 7 * TILE) * 600;
      if (v > sc && v >= X.bombVal) { sc = v; best = { x: foes[i].x, y: foes[i].y }; }
    }
    var PR = { turret: 900, mg: 700, pbunker: 900, laser: 1500, tesla: 1500, flak: 400, refinery: 1300, factory: 1400, techcenter: 1500, orbital: 3000, silo: 3000,
               airfield: 1500, shipyard: 1200, power: 600, barracks: 700 };
    for (var id in P.mem) {
      var m = P.mem[id];
      if (m.neutral || m.owner === pid || !PR[m.type]) continue;
      var mx = (m.tx + m.w / 2) * TILE, my = (m.ty + m.h / 2) * TILE;
      var s2 = PR[m.type] * (1.3 - 0.5 * m.hp / m.maxHp) - aaNear(mx, my, 8 * TILE) * 450;
      if (A.attack.length && d2(mx, my, A.tx, A.ty) < 10 * 10 * TILE * TILE) s2 *= 1.5;   // Welle unterstützen
      if (s2 > sc) { sc = s2; best = { x: mx, y: my }; }
    }
    if (best && G.cmd.bomb(pid, ids(bs.slice(0, 1)), best.x, best.y).ok) A.bombRuns = (A.bombRuns || 0) + 1;
  }
  /** Transporthubschrauber: 3–5 Infanteristen von der Basis hinter die gegnerischen Linien (Sammler/Raffinerie ohne Flugabwehr). */
  function heliDrop(X) {
    var J = A.heliJob;
    if (J) {
      var h = G.Sim.get(J.heli);
      J.units = J.units.filter(function (id) { var u = G.Sim.get(id); return u && !u.dead; });
      var abort = !h || h.dead || S.tick - J.t > 20 * 150 || !J.units.length;
      if (!abort && J.ph === 'load') {
        var inside = J.units.filter(function (id) { return G.Sim.get(id).inside === J.heli; });
        var walk = J.units.filter(function (id) { var u = G.Sim.get(id); return !u.inside && u.ord === 'load'; });
        if (inside.length && (!walk.length || S.tick - J.t > 20 * 30)) {
          J.units = inside; J.ph = 'fly';
          var r = G.cmd.unload(pid, h.id, J.x, J.y);
          if (!r.ok) abort = true;
        } else if (!inside.length && !walk.length) abort = true;
      } else if (!abort && J.ph === 'fly') {
        if (!h.gar.length) {
          G.cmd.attackMove(pid, J.units, J.tx, J.ty);
          G.cmd.move(pid, [h.id], A.homeX, A.homeY);
          A.heliDrops = (A.heliDrops || 0) + 1; A.heliJob = null; A.heliT = S.tick;
          return;
        }
        if (h.ord === 'idle' && h.gar.length) { var r2 = G.cmd.unload(pid, h.id, J.x, J.y); if (!r2.ok) abort = true; }
      }
      if (abort) {
        if (h && !h.dead && h.gar && h.gar.length && G.Sim.heliCanLand(h)) G.cmd.unload(pid, h.id);
        J.units.forEach(function (id) { var u = G.Sim.get(id); if (u && !u.dead && u.ord === 'load') G.cmd.stop(pid, [id]); });
        A.heliJob = null; A.heliT = S.tick;
      }
      return;
    }
    if (!X.drops || !canAttack() || A.defending || S.tick - (A.heliT || -1e9) < 20 * X.every || S.tick / D.TICK_HZ < atkFrom() + 90) return;
    var hs = myUnits(function (e) { return e.type === 'transheli' && e.ord === 'idle' && !e.gar.length && d2(e.x, e.y, A.homeX, A.homeY) < 16 * 16 * TILE * TILE; });
    if (!hs.length) return;
    var tg = dropTarget();
    if (!tg) { A.heliT = S.tick; return; }
    var h0 = hs[0];
    if (!G.Sim.heliCanLand(h0)) { var lt = G.Path.nearestPassable(0, Math.floor(A.rallyX / TILE), Math.floor(A.rallyY / TILE), 4); if (lt >= 0) G.cmd.move(pid, [h0.id], (lt % S.map.w + 0.5) * TILE, (Math.floor(lt / S.map.w) + 0.5) * TILE); return; }
    var inAtk = {};
    for (var i = 0; i < A.attack.length; i++) inAtk[A.attack[i]] = 1;
    var pool = myUnits(function (e) { var st = G.Sim.statsOf(e); return st.cat === 'infantry' && !!st.weapon && !inAtk[e.id] && e.ord === 'idle' && !reserved(e) && d2(e.x, e.y, h0.x, h0.y) < 14 * 14 * TILE * TILE; });
    if (pool.length < 3) return;
    pool.sort(function (a, b) { return d2(a.x, a.y, h0.x, h0.y) - d2(b.x, b.y, h0.x, h0.y) || a.id - b.id; });
    var take = pool.slice(0, 5), r3 = G.cmd.load(pid, ids(take), h0.id);
    if (!r3.ok) { A.heliT = S.tick; return; }
    A.heliJob = { heli: h0.id, units: ids(take).filter(function (id) { return G.Sim.get(id).ord === 'load'; }), ph: 'load', t: S.tick, x: tg.dx, y: tg.dy, tx: tg.x, ty: tg.y };
  }
  /** Absetzziel: bekannte gegnerische Raffinerie/Gebäude abseits von Türmen und Flugabwehr; Absetzpunkt 4 Kacheln davor (Seite zur eigenen Basis). */
  function dropTarget() {
    var best = null, bs = -1e18;
    for (var id in P.mem) {
      var m = P.mem[id];
      if (m.neutral || m.owner === pid || m.type === 'wall') continue;
      var mx = (m.tx + m.w / 2) * TILE, my = (m.ty + m.h / 2) * TILE, tw = 0;
      for (var id2 in P.mem) { var t2 = P.mem[id2]; if (t2.owner !== pid && TOWERS[t2.type] && d2((t2.tx + t2.w / 2) * TILE, (t2.ty + t2.h / 2) * TILE, mx, my) < 8 * 8 * TILE * TILE) tw++; }
      var sc = ({ refinery: 300, power: 220, factory: 200, barracks: 150, airfield: 220, shipyard: 180 }[m.type] || 80) - tw * 140 - aaNear(mx, my, 9 * TILE) * 160 - enemiesNear(mx, my, 7 * TILE) * 40;
      if (sc > bs) { bs = sc; best = { x: mx, y: my }; }
    }
    if (!best || bs < 60) return null;
    var dx = A.homeX - best.x, dy = A.homeY - best.y, l = Math.sqrt(dx * dx + dy * dy) || 1;
    best.dx = best.x + dx / l * 4 * TILE; best.dy = best.y + dy / l * 4 * TILE;
    return best;
  }
  /** Flotte: verteidigt das eigene Ufer, greift ab canAttack mit navyWave Kriegsschiffen über das Wasser an (Ziel: Gegnergebäude in Ufernähe). */
  function fleet(X) {
    if (!A.navy || !A.navy.ok) return;
    var ships = myUnits(function (e) { return (e.type === 'gunboat' || e.type === 'destroyer' || e.type === 'submarine' || e.type === 'carrier') && !reservedV08(e); });   // v1.2: U-Boote und Träger fahren mit der Flotte
    if (!ships.length) return;
    var yard = mine('building', 'shipyard')[0], base = yard || { x: A.navy.x, y: A.navy.y };
    // Verteidigung: Gegner (sichtbar) nahe der Werft/des Ufers
    var thr = enemiesNear(base.x, base.y, 10 * TILE);
    if (thr > 0) {
      var fs = ships.filter(function (e) { return e.ord !== 'amove' && e.ord !== 'attack'; });
      if (fs.length) G.cmd.attackMove(pid, ids(fs), base.x, base.y);
      return;
    }
    if (!canAttack()) return;
    var idle = ships.filter(function (e) { return e.ord === 'idle' && e.hp > e.maxHp * 0.3; });
    var atSea = ships.filter(function (e) { return e.ord === 'amove'; });
    if (!atSea.length && idle.length >= X.navyWave || (atSea.length && S.tick - (A.fleetT || 0) > 20 * 60)) {
      var tg = fleetTarget();
      A.fleetT = S.tick;
      G.cmd.attackMove(pid, ids(atSea.length ? atSea.concat(idle) : idle), tg.x, tg.y);
      A.fleetRaids = (A.fleetRaids || 0) + (atSea.length ? 0 : 1);
    }
    // stark beschädigte Schiffe zurück zur Werft
    ships.forEach(function (e) { if (e.hp < e.maxHp * 0.3 && e.ord === 'amove') G.cmd.move(pid, [e.id], base.x, base.y); });
  }
  /** Wasserkachel (eigenes Gewässer) in Reichweite eines bekannten gegnerischen Gebäudes, sonst Wasser vor der gegnerischen Basis. */
  function fleetTarget() {
    var w = S.map.w, h = S.map.h, best = null, bs = -1e18, comp = A.navy.comp;
    for (var id in P.mem) {
      var m = P.mem[id];
      if (m.neutral || m.owner === pid || m.type === 'wall') continue;
      var cx = m.tx + (m.w >> 1), cy = m.ty + (m.h >> 1), wt = null, wd = 1e9;
      for (var yy = cy - 6; yy <= cy + 6; yy++) for (var xx = cx - 6; xx <= cx + 6; xx++) {
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        var i = yy * w + xx;
        if (G.Path.waterComp(i) !== comp || !G.Path.passable(3, i)) continue;
        var dd = (xx - cx) * (xx - cx) + (yy - cy) * (yy - cy) + tk((xx + 0.5) * TILE, (yy + 0.5) * TILE) * 1e-9;
        if (dd < wd) { wd = dd; wt = { x: (xx + 0.5) * TILE, y: (yy + 0.5) * TILE }; }
      }
      if (!wt) continue;
      var sc = ({ shipyard: 400, refinery: 260, factory: 220, airfield: 200, power: 160, flak: 120 }[m.type] || 100) - Math.sqrt(wd) * 15;
      if (sc > bs) { bs = sc; best = wt; }
    }
    return best || { x: A.navy.ex, y: A.navy.ey };
  }
  /** Landungsboot: am eigenen Ufer 1–2 Fahrzeuge + Infanterie aufnehmen und am Ufer nahe der gegnerischen Basis absetzen. */
  function landDrop(X) {
    if (!A.navy || !A.navy.ok) return;
    var J = A.landJob;
    if (J) {
      var b = G.Sim.get(J.boat);
      J.units = J.units.filter(function (id) { var u = G.Sim.get(id); return u && !u.dead; });
      var abort = !b || b.dead || S.tick - J.t > 20 * 200 || !J.units.length;
      if (!abort && J.ph === 'dock') {
        if (G.Sim.nearShore(b) && (b.ord === 'idle' || d2(b.x, b.y, J.sx, J.sy) < 1.5 * 1.5 * TILE * TILE)) {
          G.cmd.stop(pid, [b.id]);
          var r = G.cmd.load(pid, J.units, b.id);
          if (!r.ok) abort = true; else { J.ph = 'load'; J.t2 = S.tick; }
        } else if (b.ord === 'idle') G.cmd.move(pid, [b.id], J.sx, J.sy);
      } else if (!abort && J.ph === 'load') {
        var inside = J.units.filter(function (id) { return G.Sim.get(id).inside === J.boat; });
        var walk = J.units.filter(function (id) { var u = G.Sim.get(id); return !u.inside && u.ord === 'load'; });
        if (inside.length && (!walk.length || S.tick - J.t2 > 20 * 40)) {
          J.units = inside; J.ph = 'sail';
          var r2 = G.cmd.unload(pid, b.id, A.navy.ex, A.navy.ey);
          if (!r2.ok) abort = true;
        } else if (!inside.length && !walk.length) abort = true;
      } else if (!abort && J.ph === 'sail') {
        if (!b.gar.length) {
          G.cmd.attackMove(pid, J.units, A.enemyX, A.enemyY);
          G.cmd.move(pid, [b.id], J.sx, J.sy);
          A.landDrops = (A.landDrops || 0) + 1; A.landJob = null; A.landT = S.tick;
          return;
        }
        if (b.ord === 'idle') { var r3 = G.cmd.unload(pid, b.id, A.navy.ex, A.navy.ey); if (!r3.ok) abort = true; }
      }
      if (abort) {
        if (b && !b.dead && b.gar && b.gar.length && G.Sim.nearShore(b)) G.cmd.unload(pid, b.id);
        J.units.forEach(function (id) { var u = G.Sim.get(id); if (u && !u.dead && u.ord === 'load') G.cmd.stop(pid, [id]); });
        A.landJob = null; A.landT = S.tick;
      }
      return;
    }
    if (!X.drops || !canAttack() || A.defending || S.tick - (A.landT || -1e9) < 20 * X.every * 1.3 || S.tick / D.TICK_HZ < atkFrom() + 150) return;
    var boats = myUnits(function (e) { return e.type === 'lander' && e.ord === 'idle' && !e.gar.length; });
    if (!boats.length) return;
    var bt = boats[0], sp = G.Sim.shoreSpot(bt, A.rallyX, A.rallyY);
    if (!sp) { A.landT = S.tick; return; }
    var inAtk = {};
    for (var i = 0; i < A.attack.length; i++) inAtk[A.attack[i]] = 1;
    var pool = myUnits(function (e) { var st = G.Sim.statsOf(e); return e.mc < 2 && !!st.weapon && !st.harvester && !inAtk[e.id] && e.ord === 'idle' && !reserved(e) &&
                                                d2(e.x, e.y, sp.x, sp.y) < 16 * 16 * TILE * TILE; });
    var veh = pool.filter(function (e) { return e.mc === 1; }), inf = pool.filter(function (e) { return e.mc === 0; });
    if (veh.length < 1 || veh.length + inf.length < 3) return;
    var take = veh.slice(0, 2).concat(inf.slice(0, 2));
    A.landJob = { boat: bt.id, units: ids(take), ph: 'dock', t: S.tick, sx: sp.x, sy: sp.y };
    G.cmd.move(pid, [bt.id], sp.x, sp.y);
    G.cmd.move(pid, ids(take), sp.x, sp.y);
  }

  // ================================================================== v0.9 Schlachtschiff (SPEC_v08 §14)
  /** Bauen erst spät: ab dreadAt, Tech-Zentrum steht, genug Geld und schon mindestens ein Kriegsschiff (die Flotte schützt es). */
  function dreadOk(X) {
    return S.tick / D.TICK_HZ >= (X.dreadAt || 1e9) && G.Sim.hasBuilding(pid, 'techcenter') && P.credits > 1500 && cntU('gunboat') + cntU('destroyer') >= 1;
  }
  var DREAD_SC = { turret: 420, laser: 460, tesla: 460, flak: 300, mg: 260, pbunker: 300, shipyard: 360, refinery: 300, factory: 280, airfield: 260,
                   power: 240, barracks: 200, techcenter: 260, orbital: 340, silo: 340, hq: 220 };
  /** Belagerungsziel: bekanntes gegnerisches Gebäude, das von einer Wasserkachel des eigenen Gewässers in Raketenreichweite liegt.
   *  → { id, x, y } (Feuerstellung im Wasser, möglichst weit weg: Reichweite − 1,5 Kacheln) oder null. */
  function dreadTarget(d, st) {
    var w = S.map.w, h = S.map.h, comp = A.navy.comp, wp = st.weapon, R = wp.range - 1.5, Rmin = wp.minRange + 1.5, best = null, bs = -1e18;
    for (var id in P.mem) {
      var m = P.mem[id];
      if (m.neutral || m.owner === pid || m.type === 'wall') continue;
      var b = G.Sim.get(m.id); if (!b || b.dead) continue;
      var cx = m.tx + m.w / 2, cy = m.ty + m.h / 2, wt = null, ws = 1e18, r0 = Math.ceil(R);
      for (var yy = Math.floor(cy - r0); yy <= Math.ceil(cy + r0); yy++) for (var xx = Math.floor(cx - r0); xx <= Math.ceil(cx + r0); xx++) {
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        var i = yy * w + xx;
        if (G.Path.waterComp(i) !== comp || !G.Path.passable(3, i)) continue;
        var dd = Math.sqrt((xx + 0.5 - cx) * (xx + 0.5 - cx) + (yy + 0.5 - cy) * (yy + 0.5 - cy));
        if (dd > R || dd < Rmin) continue;
        // weit weg vom Ziel (außer Reichweite der Ufertürme), nah am Schiff; Gleichstand gespiegelt
        var sc = (R - dd) * 40 + Math.sqrt(d2((xx + 0.5) * TILE, (yy + 0.5) * TILE, d.x, d.y)) / TILE * 3 + tk((xx + 0.5) * TILE, (yy + 0.5) * TILE) * 1e-9;
        if (sc < ws) { ws = sc; wt = { x: (xx + 0.5) * TILE, y: (yy + 0.5) * TILE }; }
      }
      if (!wt) continue;
      var s2 = (DREAD_SC[m.type] || 150) - Math.sqrt(d2(wt.x, wt.y, d.x, d.y)) / TILE * 6 - enemiesNear(wt.x, wt.y, 6 * TILE) * 60 + (b.hp < b.maxHp * 0.5 ? 60 : 0) + tk(wt.x, wt.y) * 1e-9;
      if (s2 > bs) { bs = s2; best = { id: m.id, x: wt.x, y: wt.y }; }
    }
    return best;
  }
  /** Schlachtschiffe: ab canAttack Feuerstellung im Wasser anfahren und Ufergebäude (Verteidigung zuerst) beschießen;
   *  stark beschädigt (< 35 %) zurück zur Werft; Gegner in Mindestreichweite → ausweichen (zurück zur Werft). */
  function dreadnoughts(X) {
    if (!A.navy || !A.navy.ok) return;
    var ds = myUnits(function (e) { return e.type === 'dreadnought'; });
    if (!ds.length) return;
    var J = A.dread = A.dread || {}, yard = mine('building', 'shipyard')[0], base = yard || { x: A.navy.x, y: A.navy.y };
    for (var jk in J) if (!G.Sim.get(+jk)) delete J[jk];   // versenkte Schiffe vergessen
    for (var k = 0; k < ds.length; k++) {
      var d = ds[k], st = G.Sim.statsOf(d), j = J[d.id] = J[d.id] || { tid: 0, x: 0, y: 0, t: 0, back: false };
      if (d.hp < d.maxHp * 0.35 && !j.back) { j.back = true; j.tid = 0; G.cmd.move(pid, [d.id], base.x, base.y); continue; }
      if (j.back) { if (d.hp > d.maxHp * 0.8 || d.ord === 'idle') j.back = d.hp < d.maxHp * 0.8 && d.ord !== 'idle'; continue; }
      if (!canAttack()) continue;
      // nahe Schiffe in Mindestreichweite: ausweichen
      if (enemiesNear(d.x, d.y, st.weapon.minRange * TILE) > 0 && d.ord !== 'move') { j.tid = 0; G.cmd.move(pid, [d.id], base.x, base.y); continue; }
      var tg = j.tid ? G.Sim.get(j.tid) : null;
      if (tg && tg.dead) tg = null;
      if (d.ord === 'attack' && tg) continue;
      if (d.ord === 'move' && tg && S.tick - j.t < 20 * 90) continue;   // unterwegs zur Feuerstellung
      if (tg && d2(d.x, d.y, j.x, j.y) < 2.5 * 2.5 * TILE * TILE) {
        var r = G.cmd.attack(pid, [d.id], tg.id);
        if (r.ok) { A.dreadShots = (A.dreadShots || 0) + 1; continue; }
      }
      if (!j.tid && S.tick - j.t < 20 * 5) continue;   // zuletzt kein Ziel: 5 s warten
      var nt = dreadTarget(d, st);
      if (!nt) { j.tid = 0; j.t = S.tick; continue; }
      j.tid = nt.id; j.x = nt.x; j.y = nt.y; j.t = S.tick;
      if (d2(d.x, d.y, nt.x, nt.y) < 2.5 * 2.5 * TILE * TILE) G.cmd.attack(pid, [d.id], nt.id);
      else G.cmd.move(pid, [d.id], nt.x, nt.y);
    }
  }

  // ================================================================== v1.0.1 KI-Leicht (SPEC_v10 §10 „KI-Schwierigkeit“)
  // Leicht muss für Gelegenheitsspieler schlagbar sein; neue Stufe „Sehr leicht“ (veryeasy). Mittel nur gegen Menschen gedämpft (VS_HUMAN), Schwer unverändert.
  // waveCap = [erste Welle, + je Welle, höchstens] Einheiten (Rest bleibt daheim), waveGap = s zwischen zwei Wellen,
  // retreatAt = Rückzug, wenn die Welle unter diesen Anteil ihres Startwerts fällt, specAt = Flammenwerfer/Scharfschützen/Mutanten erst ab (s).
  (function kiLeicht() {
    var E = DIFF.easy;
    E.waveCap = [4, 1, 8]; E.waveGap = 150; E.retreatAt = 0.5; E.specAt = 900; E.armyCap = [5, 0.8];
    var V = DIFF.veryeasy = {}, k;
    for (k in E) V[k] = E[k];
    V.interval = 60; V.wave = 3; V.waveCap = [3, 1, 6]; V.waveGap = 210; V.retreatAt = 0.6; V.specAt = 1500; V.armyCap = [4, 0.5];
    V.defense = 2; V.turrets = 1; V.maxHarv = 2; V.maxRef = 2; V.ref2At = 900; V.techAt = 1200; V.bunkers = 0; V.medics = 0;
    AIRSEA.easy.airAt = 1500; AIRSEA.easy.navyAt = 1500;
    var XA = AIRSEA.veryeasy = {};
    for (k in AIRSEA.easy) XA[k] = AIRSEA.easy[k];
    XA.airAt = 1e9; XA.navyAt = 1e9; XA.flak = 1;
    if (D.AI_FIRST_ATTACK && D.AI_FIRST_ATTACK.veryeasy == null) D.AI_FIRST_ATTACK.veryeasy = 720;   // frühester erster Angriff 12 min
  })();
  /** Anpassungen nur gegen menschliche Gegner (KI-gegen-KI-Serien und damit die Fraktions-Balance bleiben bitgleich). */
  var VS_HUMAN = { medium: { waveCap: [5, 1, 10], waveGap: 150, retreatAt: 0.45, maxRef: 2, maxHarv: 3, armyCap: [6, 1.2], specAt: 600,
                             air: { airAt: 900, navyAt: 900, bomberAt: 1200 } } };
  /** AIRSEA-Stufe mit den Luft/See-Anpassungen gegen Menschen (cfg.air). */
  function xcHuman(X) {
    var a = cfg.air;
    if (!a._m || a._b !== X) { var m = {}, k; for (k in X) m[k] = X[k]; for (k in a) if (k[0] !== '_') m[k] = a[k]; a._m = m; a._b = X; }
    return a._m;
  }
  function cfgFor(pl, i) {
    var base = DIFF[pl.ai] || DIFF.medium, adj = VS_HUMAN[pl.ai];
    if (!adj) return base;
    var human = false;
    for (var j = 0; j < S.players.length; j++) if (j !== i && !S.players[j].ai) human = true;
    if (!human) return base;
    if (!adj._m || adj._b !== base) { var m = {}, k; for (k in base) m[k] = base[k]; for (k in adj) if (k[0] !== '_') m[k] = adj[k]; adj._m = m; adj._b = base; }
    return adj._m;
  }
  // v1.0.1 KI-Leicht Ende
  // ================================================================== v1.2 Neue Einheiten & Zusatzgebäude
  // V12[stufe]: Höchstzahlen/Schalter der neuen Mittel. „Sehr leicht/Leicht“ nutzen sie sparsamer.
  //   flakT = Flakpanzer (nur wenn gegnerische Luftfahrzeuge/Flugfeld gesehen)
  //   silo = Erzsilos (wenn der Kontostand an die Lagerkapazität stößt)
  //   radar = Radarwagen (erst wenn Getarntes/Minen Schaden angerichtet haben: P.st.stealthHits), sab = Saboteure (ab Tech-Zentrum),
  //   mines/mineAt = Minenfelder gleichzeitig / frühestens ab s (insgesamt höchstens doppelt so viele)
  //   subs/carrier = U-Boote/Flugzeugträger (nur mit Werft auf Seekarten; Träger ab Tech-Zentrum), psidrone/swarm = Kollektiv
  //   dock/dockAt = Reparaturdocks / frühestens ab s; gates = Tore in Mauer-Durchlässen
  var V12 = {
    veryeasy: { subs: 0, carrier: 0, psidrone: 0, swarm: 0, flakT: 1, radar: 1, sab: 0, mines: 0, mineAt: 0, silo: 1, dock: 0, dockAt: 0, gates: 0 },
    easy:     { subs: 1, carrier: 0, psidrone: 1, swarm: 1, flakT: 1, radar: 1, sab: 0, mines: 2, mineAt: 600, silo: 2, dock: 0, dockAt: 0, gates: 0 },
    medium:   { subs: 2, carrier: 1, psidrone: 1, swarm: 2, flakT: 3, radar: 1, sab: 1, mines: 4, mineAt: 330, silo: 3, dock: 1, dockAt: 420, gates: 1 },
    hard:     { subs: 2, carrier: 1, psidrone: 2, swarm: 3, flakT: 4, radar: 2, sab: 2, mines: 6, mineAt: 270, silo: 4, dock: 1, dockAt: 360, gates: 2 }
  };
  var SPOT12 = { gate: spotGate, minefield: spotMine };
  function X12() { return V12[P.ai] || V12.medium; }
  function inQ(cat, t) { var q = P.q[cat] || [], n = 0; for (var i = 0; i < q.length; i++) if (q[i].type === t) n++; return n; }
  function v12() {
    var X = X12();
    v12Flak(X);
    v12Repair(X);
    v12Radar(X);
    v12Sab(X);
    v12AirSea(X);
  }
  /** Bauentscheidung (aus chooseInner): Reparaturdock, sobald eine Fahrzeugarmee steht. */
  function choose12(cnt, secs) {
    var X = X12();
    // Erzsilo: Kontostand nahe der Lagerkapazität (oder Sammler mussten gerade warten) → Lager erweitern
    if (P.oreCap && cnt('oresilo') < X.silo && (P.credits >= P.oreCap * 0.8 || S.tick - (P.capFullT || -9999) < 200) && G.Sim.canProduce(pid, 'oresilo').ok) return 'oresilo';
    if (A.defending || A.allIn) return null;
    if (X.dock && cnt('repairdock') < X.dock && secs >= X.dockAt && P.credits > 1300 && armyValue() >= 4500 && G.Sim.canProduce(pid, 'repairdock').ok) return 'repairdock';
    return null;
  }
  /** Verteidigungs-Warteschlange (aus chooseDefenseInner): Tor in den Durchlass einer gesetzten Mauerlinie. */
  function chooseDef12(cnt, secs) {
    var X = X12();
    if (A.allIn) return null;
    if (X.mines && secs >= X.mineAt && !A.defending && cnt('minefield') < X.mines && (A.minesBuilt || 0) < X.mines * 2 && (A.mineFails || 0) < 3 && P.credits > 500 &&
        G.Sim.canProduce(pid, 'minefield').ok) return 'minefield';
    if (X.gates && A.gateT && A.gateT.length && cnt('gate') < Math.min(X.gates, A.wallLines || 0) && P.credits > 500 && G.Sim.canProduce(pid, 'gate').ok) return 'gate';
    return null;
  }
  function spotGate() {
    var w = S.map.w, L = A.gateT || [];
    while (L.length) {
      var t = L.shift(), tx = t % w, ty = (t - tx) / w;
      if (G.Sim.canPlace(pid, 'gate', tx, ty).ok) return { tx: tx, ty: ty };
    }
    return null;
  }
  /** Minenfeld auf dem Anmarschweg des Gegners (Fahrzeugpfad Basis → Gegner), 4–9 Kacheln vor der Basis, leicht seitlich gestreut. */
  function spotMine() {
    var w = S.map.w, hs = G.Path.nearestPassable(1, Math.floor(A.homeX / TILE), Math.floor(A.homeY / TILE) + 2, 5);
    var en = G.Path.nearestPassable(1, Math.floor(A.enemyX / TILE), Math.floor(A.enemyY / TILE) + 3, 6);
    if (hs < 0 || en < 0) { A.mineFails = (A.mineFails || 0) + 1; return null; }
    var path = G.Path.find(1, hs % w, Math.floor(hs / w), en % w, Math.floor(en / w), 6000, undefined, flipped());
    for (var tr = 0; tr < 12; tr++) {
      var k = 4 + Math.floor(G.Sim.rand() * 8), c = path[Math.min(k, path.length - 1)];
      if (c == null) break;
      var tx = c % w + Math.floor(G.Sim.rand() * 5) - 2, ty = Math.floor(c / w) + Math.floor(G.Sim.rand() * 5) - 2;
      if (G.Sim.canPlace(pid, 'minefield', tx, ty).ok && !nearOre(ty * w + tx, 2)) { A.minesBuilt = (A.minesBuilt || 0) + 1; A.mineFails = 0; return { tx: tx, ty: ty }; }
    }
    A.mineFails = (A.mineFails || 0) + 1;
    return null;
  }
  /** Radarwagen: sobald Getarntes (Saboteur, Minen, U-Boot) Schaden angerichtet hat. Der erste begleitet die Angriffswelle (Minen vor der
   *  gegnerischen Basis), sonst steht er am Sammelpunkt; ein zweiter (Schwer) bleibt in der Basis. */
  function v12Radar(X) {
    var sh = P.st.stealthHits || 0;
    if (sh > (A.shSeen || 0)) { A.shSeen = sh; A.wantRadar = S.tick; }
    if (!A.wantRadar || !X.radar) return;
    var cars = myUnits(function (e) { return e.type === 'radarcar'; });
    if (cars.length + inQ('vehicle', 'radarcar') < X.radar && G.Sim.hasBuilding(pid, 'factory') && P.q.vehicle.length < cfg.armyQ + 1 && G.Sim.canProduce(pid, 'radarcar').ok) G.cmd.produce(pid, 'radarcar');
    if ((S.tick + pid) % (cfg.interval * 2) >= cfg.interval) return;
    for (var i = 0; i < cars.length; i++) {
      var c = cars[i], gx = i === 0 ? A.rallyX : A.homeX, gy = i === 0 ? A.rallyY : A.homeY + 3 * TILE;
      if (i === 0 && A.attack && A.attack.length >= 3) { var gc = centroid(A.attack); gx = gc.x; gy = gc.y; }
      if (d2(c.x, c.y, gx, gy) > 3.5 * 3.5 * TILE * TILE && d2(c.gx, c.gy, gx, gy) > 3 * 3 * TILE * TILE) G.cmd.move(pid, [c.id], gx, gy);
    }
  }
  /** Saboteure (ab Tech-Zentrum, nach dem frühesten Angriffszeitpunkt): schleichen zu bekannten gegnerischen Wirtschafts-/Technikgebäuden abseits
   *  bekannter Türme und des Hauptquartiers (Detektoren), sprengen oder legen (Superwaffe/Produktion) lahm und ziehen sich zum Nachladen zurück. */
  var SABVAL = { power: 5, refinery: 6, factory: 5, techcenter: 6, airfield: 4, shipyard: 3, barracks: 3, orbital: 7, silo: 7, psidome: 7, oresilo: 3, repairdock: 3 };
  function v12Sab(X) {
    if (!X.sab || !canAttack() || !G.Sim.hasBuilding(pid, 'techcenter')) return;
    var sabs = myUnits(function (e) { return e.type === 'saboteur'; });
    if (sabs.length + inQ('infantry', 'saboteur') < X.sab && S.tick - (A.sabT || -1e9) > 20 * 45 && P.credits > 900 && P.q.infantry.length < cfg.armyQ + 1 && G.Sim.canProduce(pid, 'saboteur').ok) {
      A.sabT = S.tick; G.cmd.produce(pid, 'saboteur');
    }
    if ((S.tick + pid) % (cfg.interval * 2) >= cfg.interval) return;
    for (var i = 0; i < sabs.length; i++) {
      var s = sabs[i];
      if (s.ord === 'sab') continue;
      if (s.cd > 0) {   // lädt nach: zurück zum Sammelpunkt
        if (s.ord === 'idle' && d2(s.x, s.y, A.rallyX, A.rallyY) > 8 * 8 * TILE * TILE) G.cmd.move(pid, [s.id], A.rallyX, A.rallyY);
        continue;
      }
      var best = null, bs = 0;
      for (var id in P.mem) {
        var m = P.mem[id];
        if (m.owner === pid || m.owner < 0 || m.neutral || !SABVAL[m.type]) continue;
        var live = G.Sim.get(m.id); if (live && live.dead) continue;
        var mx = (m.tx + m.w / 2) * TILE, my = (m.ty + m.h / 2) * TILE, risk = 0;
        for (var id2 in P.mem) {
          var t = P.mem[id2]; if (t.owner === pid || t.owner < 0) continue;
          var dr = D.BUILDINGS[t.type] && D.BUILDINGS[t.type].detect; if (!dr) continue;
          if (d2(mx, my, (t.tx + t.w / 2) * TILE, (t.ty + t.h / 2) * TILE) < Math.pow((dr + 2.5) * TILE, 2)) risk++;
        }
        var sc = SABVAL[m.type] - risk * 4 + ((m.id * 7 + s.id) % 5) * 0.3;
        if (sc > bs) { bs = sc; best = m; }
      }
      if (!best) { if (s.ord === 'idle' && d2(s.x, s.y, A.rallyX, A.rallyY) > 8 * 8 * TILE * TILE) G.cmd.move(pid, [s.id], A.rallyX, A.rallyY); continue; }
      var stun = !!D.BUILDINGS[best.type].superweapon || (best.maxHp > 1600 && G.Sim.rand() < 0.4);
      G.cmd.sabMode(pid, [s.id], stun ? 1 : 0);
      G.cmd.sabotage(pid, [s.id], best.id);
    }
  }
  /** U-Boote/Flugzeugträger (Werft, nur wenn die Flotte den Gegner erreicht: A.navy.ok), Psi-Drohne (Flugfeld) und Schwarm-Träger (Fabrik, Tech).
   *  U-Boote vor allem, wenn gegnerische Schiffe gesehen wurden; Träger erst mit Geldpolster. Die Schiffe fahren mit fleet(), Schwarm-Träger sind
   *  gewöhnliche Kampffahrzeuge der Wellen, Psi-Drohnen begleiten die Welle bzw. kreisen über dem Sammelpunkt. */
  function v12AirSea(X) {
    var secs = S.tick / D.TICK_HZ, tech = G.Sim.hasBuilding(pid, 'techcenter'), i;
    var ships = 0;
    for (i = 0; i < S.ents.length; i++) { var e = S.ents[i]; if (!e.dead && e.kind === 'unit' && e.owner !== pid && e.owner >= 0 && e.mc === 3 && G.Sim.isVisible(pid, e)) ships++; }
    A.seenShips = Math.max(ships, (A.seenShips || 0) * 0.995);
    // (navyProduction() füllt die Werft-Schlange zuerst → hier ein zweiter Eintrag dahinter, höchstens einer je Typ)
    if (A.navy && A.navy.ok && G.Sim.hasBuilding(pid, 'shipyard') && P.q.naval.length < 2 && !inQ('naval', 'submarine') && !inQ('naval', 'carrier') && armyValue() >= 2000 && P.credits > 400) {
      if (cntU('submarine') < Math.min(X.subs, A.seenShips >= 1 ? X.subs : 1) && cntU('gunboat') >= 1 && G.Sim.canProduce(pid, 'submarine').ok) G.cmd.produce(pid, 'submarine');
      else if (tech && cntU('carrier') < X.carrier && P.credits > 1500 && cntU('gunboat') + cntU('destroyer') >= 2 && G.Sim.canProduce(pid, 'carrier').ok) G.cmd.produce(pid, 'carrier');
    }
    if (P.faction !== 'kollektiv') return;
    if (X.psidrone && G.Sim.hasBuilding(pid, 'airfield') && P.q.air.length < 2 && !inQ('air', 'psidrone') && cntU('psidrone') < X.psidrone && armyValue() >= 2500 && P.credits > 500 && G.Sim.canProduce(pid, 'psidrone').ok) G.cmd.produce(pid, 'psidrone');
    if (X.swarm && tech && G.Sim.hasBuilding(pid, 'factory') && cntU('swarmcarrier') + inQ('vehicle', 'swarmcarrier') < X.swarm && P.q.vehicle.length < cfg.armyQ + 1 && P.credits > 700 &&
        S.tick - (A.swarmT || -1e9) > 20 * 40 && G.Sim.canProduce(pid, 'swarmcarrier').ok) { A.swarmT = S.tick; G.cmd.produce(pid, 'swarmcarrier'); }
    if ((S.tick + pid) % (cfg.interval * 3) >= cfg.interval) return;
    var pds = myUnits(function (u) { return u.type === 'psidrone' && (u.ord === 'idle' || u.ord === 'move'); });
    if (!pds.length) return;
    var gx = A.rallyX, gy = A.rallyY;
    if (A.attack && A.attack.length >= 3 && canAttack()) { var gc = centroid(A.attack); gx = gc.x; gy = gc.y; }
    else if (A.defending) { gx = P.alert.x; gy = P.alert.y; }
    var far = pds.filter(function (u) { return d2(u.x, u.y, gx, gy) > 5 * 5 * TILE * TILE && !u.tgt; });
    if (far.length) G.cmd.attackMove(pid, ids(far), gx, gy);
  }
  /** Reparaturdock nutzen: angeschlagene, teure Fahrzeuge außerhalb des Gefechts fahren zur Reparaturstelle und sind bis zur Genesung
   *  für Wellen gesperrt (A.rep[id] = Tick des Auftrags). */
  function v12Repair(X) {
    if (!A.rep) A.rep = {};
    var id, u, n = 0;
    for (id in A.rep) {
      u = G.Sim.get(+id);
      if (!u || u.dead || u.owner !== pid || u.hp >= u.maxHp * 0.95 || S.tick - A.rep[id] > 20 * 75) delete A.rep[id]; else n++;
    }
    if (A.allIn || n >= 4 || (S.tick + pid) % (cfg.interval * 3) >= cfg.interval) return;
    var site = G.Sim.repairSite(pid, A.homeX, A.homeY);
    if (!site || P.credits < 300) return;
    for (var i = 0; i < S.ents.length && n < 4; i++) {
      u = S.ents[i];
      if (u.dead || u.owner !== pid || !G.Sim.canRepairUnit(u) || u.hp >= u.maxHp * 0.45 || A.rep[u.id] != null) continue;
      var st = G.Sim.statsOf(u);
      if (st.harvester || (st.cost || 0) < 600 || S.tick - (u.lastAtkT || -9999) < 60 || reserved(u)) continue;
      if (d2(u.x, u.y, site.x, site.y) > 32 * 32 * TILE * TILE) continue;
      if (G.cmd.repairAt(pid, [u.id], site.id).ok) {
        A.rep[u.id] = S.tick; n++;
        var k = A.attack ? A.attack.indexOf(u.id) : -1; if (k >= 0) A.attack.splice(k, 1);
      }
    }
  }
  /** Flakpanzer: sobald gegnerische Luftfahrzeuge (A.seenAir, gleitend) oder ein gegnerisches Flugfeld bekannt sind; fahren mit den Wellen. */
  function v12Flak(X) {
    if (!G.Sim.hasBuilding(pid, 'factory')) return;
    var air = A.seenAir || 0, want = Math.min(X.flakT, air > 0.5 ? 1 + Math.ceil(air / 2) : (A.enemyAirfield ? 1 : 0));
    if (cntU('flaktank') + inQ('vehicle', 'flaktank') < want && P.q.vehicle.length < cfg.armyQ + 1 && G.Sim.canProduce(pid, 'flaktank').ok) G.cmd.produce(pid, 'flaktank');
  }

  G.AI = { update: update, DIFF: DIFF, AIRSEA: AIRSEA, VS_HUMAN: VS_HUMAN, V12: V12 };   // v1.0.1 KI-Leicht: VS_HUMAN
})();
