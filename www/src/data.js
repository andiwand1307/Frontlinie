/* FRONTLINIE – data.js
 * G.DATA: reine Spieldaten (Fraktionen, Gebäude, Einheiten, Schadenstabelle, Gelände).
 * Keine Logik außer kleinen Nachschlage-Helfern. Werte gemäß SPEC §2.
 */
var G = (typeof G !== 'undefined') ? G : {};
(function () {
  'use strict';

  var TILE = 32;          // Weltpixel pro Kachel
  var TICK_HZ = 20;       // feste Sim-Rate

  // Geländetypen (Index = Wert im Terrain-Array)
  var TERRAIN = [
    { id: 'grass',  name: 'Gras',   foot: true,  wheel: true,  build: true  },
    { id: 'sand',   name: 'Sand',   foot: true,  wheel: true,  build: true  },
    { id: 'rock',   name: 'Fels',   foot: false, wheel: false, build: false },
    { id: 'water',  name: 'Wasser', foot: false, wheel: false, build: false },
    { id: 'trees',  name: 'Bäume',  foot: true,  wheel: false, build: false },
    { id: 'road',   name: 'Straße', foot: true,  wheel: true,  build: true , wheelSpeed: 1.25 },
    { id: 'bridge', name: 'Brücke', foot: true,  wheel: true,  build: false, wheelSpeed: 1.25 }
  ];
  var T = {}; TERRAIN.forEach(function (t, i) { T[t.id] = i; });

  var FACTIONS = {
    coalition: { id: 'coalition', name: 'Koalition', color: '#3b82f6', dark: '#1e40af', light: '#93c5fd',
                 desc: 'schnell, präzise, teurer' },
    syndicate: { id: 'syndicate', name: 'Syndikat',  color: '#ef4444', dark: '#991b1b', light: '#fca5a5',
                 desc: 'robust, massig, günstiger, langsamer' }
  };

  // Schadensmultiplikatoren: DAMAGE[waffe][panzerung]
  var DAMAGE = {
    bullet: { inf: 1.0, light: 0.5, heavy: 0.25, building: 0.25 },
    rocket: { inf: 0.3, light: 1.0, heavy: 1.2,  building: 0.8 },
    cannon: { inf: 0.4, light: 0.9, heavy: 1.0,  building: 0.9 },
    // v0.5 (SPEC_v05 §2): Fraktionstürme
    laser:     { inf: 0.6, light: 1.2, heavy: 1.3,  building: 0.5 },
    lightning: { inf: 1.2, light: 1.0, heavy: 0.9,  building: 0.4 },
    // v0.7 (SPEC_v07 §1): Scharfschütze, Flammenwerfer
    sniper:    { inf: 1.5, light: 0.1, heavy: 0.05, building: 0.05 },
    flame:     { inf: 1.5, light: 0.8, heavy: 0.3,  building: 0.65 }
  };

  // Gebäude (für beide Fraktionen gleich). cost/time in Credits/Sekunden.
  // weapon: nur bei Türmen. sight in Kacheln.
  var BUILDINGS = {
    hq:       { id: 'hq', name: 'Hauptquartier', w: 3, h: 3, cost: 0,    time: 0,  power: 10,  hp: 3000, req: null,       sight: 5, sellable: false,
                desc: 'Baut Gebäude' },
    power:    { id: 'power', name: 'Kraftwerk',  w: 2, h: 2, cost: 300,  time: 10, power: 100, hp: 800,  req: 'hq',       sight: 5,
                desc: 'Liefert Energie' },
    refinery: { id: 'refinery', name: 'Raffinerie', w: 3, h: 2, cost: 1500, time: 20, power: -30, hp: 1500, req: 'power', sight: 5,
                desc: 'Erz → Credits, mit Sammler' },
    barracks: { id: 'barracks', name: 'Kaserne', w: 2, h: 2, cost: 400,  time: 12, power: -20, hp: 900,  req: 'power',    sight: 5, produces: 'infantry',
                desc: 'Bildet Infanterie aus' },
    factory:  { id: 'factory', name: 'Fahrzeugwerk', w: 3, h: 3, cost: 1800, time: 25, power: -40, hp: 2000, req: 'refinery', sight: 5, produces: 'vehicle',
                desc: 'Baut Fahrzeuge' },
    turret:   { id: 'turret', name: 'Geschützturm', w: 1, h: 1, cost: 600, time: 12, power: -20, hp: 1000, req: 'barracks', sight: 8, defense: true,
                weapon: { type: 'cannon', range: 7, dmg: 60, rof: 1.5 }, desc: 'Gut gegen Fahrzeuge' },
    mg:       { id: 'mg', name: 'MG-Stellung', w: 1, h: 1, cost: 450, time: 10, power: -10, hp: 700, req: 'barracks', sight: 7, defense: true,
                weapon: { type: 'bullet', range: 5, dmg: 14, rof: 0.4 }, desc: 'Gut gegen Infanterie' },

    // ---- v0.3: neutrale Kartengebäude (stehen auf der Karte, werden nicht gebaut; Startbesitzer −1) ----
    // kind2 'garrison': Infanterie besetzt es (cap Plätze, rangeBonus auf Waffenreichweite der Insassen).
    // kind2 'special' : unzerstörbar (invuln), wird durch Infanterie erobert; special = Effektart.
    house:    { id: 'house', name: 'Wohnhaus', w: 2, h: 2, cost: 0, time: 0, power: 0, hp: 1200, req: null, sight: 6, sellable: false,
                neutral: true, kind2: 'garrison', cap: 3, rangeBonus: 1, desc: 'Infanterie kann es besetzen' },
    block:    { id: 'block', name: 'Wohnblock', w: 3, h: 2, cost: 0, time: 0, power: 0, hp: 2000, req: null, sight: 6, sellable: false,
                neutral: true, kind2: 'garrison', cap: 5, rangeBonus: 1, desc: 'Infanterie kann es besetzen' },
    bunker:   { id: 'bunker', name: 'Bunker', w: 2, h: 2, cost: 0, time: 0, power: 0, hp: 2500, req: null, sight: 7, sellable: false,
                neutral: true, kind2: 'garrison', cap: 4, rangeBonus: 2, desc: 'Besetzbar, +2 Reichweite' },
    oilrig:   { id: 'oilrig', name: 'Ölbohrturm', w: 2, h: 2, cost: 0, time: 0, power: 0, hp: 1000, req: null, sight: 4, sellable: false,
                neutral: true, kind2: 'special', special: 'oil', invuln: true, desc: '+12 Credits/s' },
    radar:    { id: 'radar', name: 'Radarstation', w: 2, h: 2, cost: 0, time: 0, power: 0, hp: 1000, req: null, sight: 14, sellable: false,
                neutral: true, kind2: 'special', special: 'radar', invuln: true, desc: 'Weite Sicht, Gegner auf der Minimap' },
    hospital: { id: 'hospital', name: 'Feldlazarett', w: 3, h: 2, cost: 0, time: 0, power: 0, hp: 1000, req: null, sight: 5, sellable: false,
                neutral: true, kind2: 'special', special: 'heal', invuln: true, desc: 'Heilt eigene Infanterie' },
    workshop: { id: 'workshop', name: 'Werkstatt', w: 3, h: 2, cost: 0, time: 0, power: 0, hp: 1000, req: null, sight: 5, sellable: false,
                neutral: true, kind2: 'special', special: 'repair', invuln: true, desc: 'Repariert eigene Fahrzeuge' },
    artillery:{ id: 'artillery', name: 'Artilleriestellung', w: 2, h: 2, cost: 0, time: 0, power: 0, hp: 1000, req: null, sight: 5, sellable: false,
                neutral: true, kind2: 'special', special: 'arty', invuln: true, desc: 'Artillerieschlag (Aufladung 180 s)' },

    // ---- v0.4: Tech-Zentrum + fraktionsgebundene Superwaffen (SPEC_v04 §2/§3) ----
    techcenter: { id: 'techcenter', name: 'Tech-Zentrum', w: 3, h: 3, cost: 2000, time: 25, power: -60, hp: 1800, req: 'factory', sight: 6,
                desc: 'Schaltet Spitzentechnik frei' },
    orbital:  { id: 'orbital', name: 'Orbital-Leitstelle', w: 3, h: 2, cost: 3500, time: 40, power: -150, hp: 2500, req: 'techcenter', sight: 6,
                faction: 'coalition', superweapon: 'orbital', limit: 1, desc: 'Orbitalschlag (Aufladung 6 min)' },
    silo:     { id: 'silo', name: 'Raketensilo', w: 3, h: 2, cost: 3500, time: 40, power: -150, hp: 2500, req: 'techcenter', sight: 6,
                faction: 'syndicate', superweapon: 'missile', limit: 1, desc: 'Großrakete (Aufladung 6 min)' },

    // ---- v0.5: Verteidigung (SPEC_v05 §2, Reiter „Verteidigung“ über defense:true) ----
    // wall: kein Warteschlangen-Eintrag, Platzierung über G.cmd.placeWall (sofort, 50 je Segment); zählt nicht für Sieg/Nähe-Regel.
    wall:     { id: 'wall', name: 'Mauer', w: 1, h: 1, cost: 50, time: 0, power: 0, hp: 800, req: 'barracks', sight: 1, defense: true,
                isWall: true, noQueue: true, buildAnim: 0.5, desc: 'Blockiert den Weg (50 je Segment)' },
    // pbunker: baubarer Bunker – nur eigene Infanterie (garrisonOwn), Insassen +2 Reichweite; normales Basisgebäude.
    pbunker:  { id: 'pbunker', name: 'Bunker', w: 2, h: 2, cost: 700, time: 14, power: 0, hp: 2200, req: 'barracks', sight: 7, defense: true,
                kind2: 'garrison', cap: 4, rangeBonus: 2, garrisonOwn: true, desc: 'Eigene Infanterie besetzt ihn, +2 Reichweite' },
    // laser/tesla: feuern bei Energiemangel gar nicht (noFireLowPower). Laser trifft sofort (Strahl);
    // Blitz springt auf bis zu chain weitere Gegner im Umkreis chainR Kacheln vom Ziel mit je chainDmg Anteil.
    laser:    { id: 'laser', name: 'Lasergeschütz', w: 2, h: 2, cost: 1500, time: 20, power: -80, hp: 1500, req: 'techcenter', sight: 9, defense: true,
                faction: 'coalition', noFireLowPower: true, weapon: { type: 'laser', range: 8, dmg: 120, rof: 1.6, beam: true }, desc: 'Strahlwaffe, stark gegen Fahrzeuge' },
    tesla:    { id: 'tesla', name: 'Blitzturm', w: 2, h: 2, cost: 1500, time: 20, power: -100, hp: 1700, req: 'techcenter', sight: 8, defense: true,
                faction: 'syndicate', noFireLowPower: true, weapon: { type: 'lightning', range: 6.5, dmg: 200, rof: 2.5, beam: true, chain: 2, chainR: 2, chainDmg: 0.5 },
                desc: 'Kettenblitz, springt auf weitere Gegner' }
  };
  var NEUTRAL_TYPES = ['house', 'block', 'bunker', 'oilrig', 'radar', 'hospital', 'workshop', 'artillery'];
  var BUILD_ORDER = ['power', 'refinery', 'barracks', 'factory', 'turret', 'mg', 'techcenter', 'orbital', 'silo',
                     'wall', 'pbunker', 'laser', 'tesla']; // Sidebar-Reihenfolge (v0.5: Verteidigung angehängt)

  // Einheiten: pro Fraktion eigene Werte (null = nicht verfügbar).
  // speed in Kacheln/s, range in Kacheln, rof in s.
  function W(type, range, dmg, rof) { return { type: type, range: range, dmg: dmg, rof: rof }; }
  function WX(type, range, dmg, rof, extra) { var w = W(type, range, dmg, rof); for (var k in extra) w[k] = extra[k]; return w; }
  var UNITS = {
    rifle: {
      id: 'rifle', name: 'Schütze', cat: 'infantry', armor: 'inf', move: 'foot', radius: 6, sight: 5,
      desc: 'Gut gegen Infanterie',
      coalition: { cost: 98, time: 5, hp: 100, speed: 1.2, weapon: W('bullet', 4.25, 18, 1.0) },
      syndicate: { cost: 80,  time: 4, hp: 110, speed: 1.0, weapon: W('bullet', 4, 15, 1.0) }
    },
    rocket: {
      id: 'rocket', name: 'Raketentrupp', cat: 'infantry', armor: 'inf', move: 'foot', radius: 6, sight: 5,
      desc: 'Gut gegen Fahrzeuge',
      coalition: { cost: 285, time: 7, hp: 100, speed: 1.0, weapon: W('rocket', 6.25, 55, 2.4) },
      syndicate: { cost: 250, time: 6, hp: 100, speed: 0.9, weapon: W('rocket', 5.5, 55, 2.8) }
    },
    scout: {
      id: 'scout', name: 'Späher-Jeep', cat: 'vehicle', armor: 'light', move: 'wheel', radius: 10, sight: 6,
      desc: 'Schnell, gegen Infanterie', turret: true,
      coalition: { cost: 470, time: 8, hp: 270, speed: 3.2, weapon: W('bullet', 5.25, 22, 0.6) },
      syndicate: null
    },
    raider: {
      id: 'raider', name: 'Kampfbuggy', cat: 'vehicle', armor: 'light', move: 'wheel', radius: 10, sight: 6,
      desc: 'Schnell, gegen Infanterie', turret: true,
      coalition: null,
      syndicate: { cost: 400, time: 6, hp: 280, speed: 2.8, weapon: W('bullet', 4.5, 18, 0.6) }
    },
    tank: {
      id: 'tank', name: 'Kampfpanzer', cat: 'vehicle', armor: 'heavy', move: 'wheel', radius: 12, sight: 6,
      desc: 'Schwer gepanzert', turret: true,
      coalition: { cost: 895, time: 14, hp: 680, speed: 1.8, weapon: W('cannon', 5.5, 75, 1.5) },
      syndicate: { cost: 800, time: 12, hp: 750, speed: 1.4, weapon: W('cannon', 5, 75, 1.8) }
    },
    harvester: {
      id: 'harvester', name: 'Sammler', cat: 'vehicle', armor: 'heavy', move: 'wheel', radius: 13, sight: 6,
      desc: 'Sammelt Erz', harvester: true, capacity: 700,
      coalition: { cost: 1400, time: 18, hp: 1000, speed: 1.3, weapon: null },
      syndicate: { cost: 1400, time: 18, hp: 1200, speed: 1.1, weapon: null }
    },
    // ---- v0.4 (SPEC_v04 §4): benötigen zusätzlich ein Tech-Zentrum (req) ----
    // howitzer: schießt nur stehend (setup s Aufbauzeit), Mindestreichweite minRange, Flächenschaden splash (Kacheln),
    //           Granate fliegt ballistisch auf die Zielposition (nicht zielsuchend).
    howitzer: {
      id: 'howitzer', name: 'Mobile Artillerie', cat: 'vehicle', armor: 'light', move: 'wheel', radius: 12, sight: 6, req: 'techcenter',
      desc: 'Weitreichend, gegen Türme und Basen', turret: true, setup: 1,
      coalition: { cost: 1100, time: 16, hp: 320, speed: 1.3, weapon: WX('cannon', 11, 90, 4.0, { minRange: 3, splash: 1 }) },
      syndicate: { cost: 1100, time: 16, hp: 320, speed: 1.3, weapon: WX('cannon', 11, 90, 4.0, { minRange: 3, splash: 1 }) }
    },
    // engineer: unbewaffnet; enter → gegnerisches Basisgebäude übernehmen / eigenes reparieren / Spezialgebäude sofort erobern
    engineer: {
      id: 'engineer', name: 'Ingenieur', cat: 'infantry', armor: 'inf', move: 'foot', radius: 6, sight: 5, req: 'techcenter',
      desc: 'Übernimmt Gebäude, repariert eigene', engineer: true,
      coalition: { cost: 500, time: 8, hp: 80, speed: 1.0, weapon: null },
      syndicate: { cost: 500, time: 8, hp: 80, speed: 1.0, weapon: null }
    },
    hunter: {
      id: 'hunter', name: 'Jagdpanzer', cat: 'vehicle', armor: 'heavy', move: 'wheel', radius: 12, sight: 7, req: 'techcenter',
      desc: 'Schnell, weitreichend', turret: true,
      coalition: { cost: 1300, time: 16, hp: 450, speed: 2.4, weapon: W('cannon', 7, 85, 1.8) },
      syndicate: null
    },
    // colossus: zwei Rohre feuern abwechselnd (je Rohr alle rof s → Schuss alle rof/2 s), Ereignis shot.barrel 0|1
    colossus: {
      id: 'colossus', name: 'Kolosspanzer', cat: 'vehicle', armor: 'heavy', move: 'wheel', radius: 15, sight: 6, req: 'techcenter',
      desc: 'Extrem schwer gepanzert', turret: true,
      coalition: null,
      syndicate: { cost: 1800, time: 22, hp: 1500, speed: 1.0, weapon: WX('cannon', 5.5, 80, 2.0, { barrels: 2 }) }
    },
    // ---- v0.5 (SPEC_v05 §3): Mobiler Bauhof – G.cmd.deploy → HQ (3×3) zentriert auf der Fahrzeugkachel ----
    mcv: {
      id: 'mcv', name: 'Mobiler Bauhof', cat: 'vehicle', armor: 'heavy', move: 'wheel', radius: 15, sight: 6,
      desc: 'Baut sich zu einem Hauptquartier auf', deploys: 'hq',
      coalition: { cost: 3000, time: 30, hp: 1500, speed: 1.0, weapon: null },
      syndicate: { cost: 3000, time: 30, hp: 1500, speed: 1.0, weapon: null }
    },
    // ---- v0.7 (SPEC_v07 §1): sieben neue Einheiten. faction = nur diese Fraktion (wie hunter/colossus über null-Werte) ----
    // sniper: Soforttreffer (wie bullet), Sicht 9 (= Reichweite, sonst nutzt er sie untätig nie)
    sniper: {
      id: 'sniper', name: 'Scharfschütze', cat: 'infantry', armor: 'inf', move: 'foot', radius: 6, sight: 9, faction: 'coalition',
      desc: 'Weitreichend, tödlich gegen Infanterie',
      coalition: { cost: 750, time: 10, hp: 80, speed: 1.1, weapon: W('sniper', 9, 120, 3.0) },
      syndicate: null
    },
    // apc: Transport für bis zu transport (5) Infanteristen – G.cmd.load / G.cmd.unload; Einheitenfelder gar (Insassen-IDs), cap
    apc: {
      id: 'apc', name: 'Schützenpanzer', cat: 'vehicle', armor: 'light', move: 'wheel', radius: 12, sight: 6, faction: 'coalition',
      desc: 'Transportiert 5 Infanteristen', turret: true, transport: 5,
      coalition: { cost: 800, time: 12, hp: 400, speed: 2.6, weapon: W('bullet', 5, 16, 0.5) },
      syndicate: null
    },
    lasertank: {
      id: 'lasertank', name: 'Laserpanzer', cat: 'vehicle', armor: 'heavy', move: 'wheel', radius: 12, sight: 7, req: 'techcenter', faction: 'coalition',
      desc: 'Strahlwaffe, stark gegen Panzer', turret: true,
      coalition: { cost: 1400, time: 18, hp: 500, speed: 2.0, weapon: WX('laser', 6.5, 90, 1.4, { beam: true }) },
      syndicate: null
    },
    // flamer: Sofortwirkung auf die Zielposition mit Flächenschaden area (Kacheln), Rand 50 %
    flamer: {
      id: 'flamer', name: 'Flammenwerfer', cat: 'infantry', armor: 'inf', move: 'foot', radius: 6, sight: 5, faction: 'syndicate',
      desc: 'Kurze Reichweite, verheerend gegen Infanterie',
      coalition: null,
      syndicate: { cost: 300, time: 7, hp: 130, speed: 1.0, weapon: WX('flame', 2.5, 35, 0.5, { area: 0.75 }) }
    },
    // mlrs: Salve aus salvo Raketen (Abstand salvoGap s), ballistisch auf die Zielposition (Streuung scatter Kacheln),
    //       Flächenschaden splash; nur stehend (setup 1 s), Mindestreichweite minRange
    mlrs: {
      id: 'mlrs', name: 'Raketenwerfer-Lkw', cat: 'vehicle', armor: 'light', move: 'wheel', radius: 12, sight: 6, faction: 'syndicate',
      desc: 'Raketensalven, gegen Türme und Gruppen', turret: true, setup: 1,
      coalition: null,
      syndicate: { cost: 1000, time: 14, hp: 300, speed: 1.8, weapon: WX('rocket', 9, 40, 6.0, { minRange: 2, splash: 0.75, salvo: 6, salvoGap: 0.12, scatter: 0.6 }) }
    },
    shocktank: {
      id: 'shocktank', name: 'Blitzpanzer', cat: 'vehicle', armor: 'heavy', move: 'wheel', radius: 13, sight: 6, req: 'techcenter', faction: 'syndicate',
      desc: 'Kettenblitz, springt auf ein weiteres Ziel', turret: true,
      coalition: null,
      syndicate: { cost: 1500, time: 18, hp: 650, speed: 1.6, weapon: WX('lightning', 5, 120, 2.2, { beam: true, chain: 1, chainR: 2, chainDmg: 0.5 }) }
    },
    // medic: unbewaffnet; heilt die am stärksten verletzte eigene Infanterie im Umkreis radius um rate HP/s (ein Ziel),
    //        folgt untätig der nächsten verletzten Infanterie bis follow Kacheln
    medic: {
      id: 'medic', name: 'Sanitäter', cat: 'infantry', armor: 'inf', move: 'foot', radius: 6, sight: 5,
      desc: 'Heilt eigene Infanterie', medic: { rate: 12, radius: 3, follow: 6 },
      coalition: { cost: 400, time: 8, hp: 90, speed: 1.1, weapon: null },
      syndicate: { cost: 400, time: 8, hp: 90, speed: 1.1, weapon: null }
    }
  };
  var UNIT_ORDER = { infantry: ['rifle', 'rocket', 'engineer', 'sniper', 'flamer', 'medic'],
                     vehicle: ['scout', 'raider', 'apc', 'tank', 'hunter', 'colossus', 'lasertank', 'shocktank', 'howitzer', 'mlrs', 'harvester', 'mcv'] };

  // Zusammengeführte Werte einer Einheit für eine Fraktion (gecacht).
  var statCache = {};
  function unitStats(faction, type) {
    var key = faction + ':' + type;
    if (key in statCache) return statCache[key];
    var base = UNITS[type], f = base && base[faction], r = null;
    if (f) {
      r = {};
      for (var k in base) if (!FACTIONS[k]) r[k] = base[k];   // v1.0: alle Fraktions-Blöcke überspringen (auch kollektiv)
      for (k in f) r[k] = f[k];
      r.producer = base.producer || (base.cat === 'infantry' ? 'barracks' : 'factory');   // v0.8: air → airfield, naval → shipyard
    }
    statCache[key] = r;
    return r;
  }

  G.DATA = {
    TILE: TILE, TICK_HZ: TICK_HZ, TERRAIN: TERRAIN, T: T, FACTIONS: FACTIONS, DAMAGE: DAMAGE,
    BUILDINGS: BUILDINGS, BUILD_ORDER: BUILD_ORDER, NEUTRAL_TYPES: NEUTRAL_TYPES, UNITS: UNITS, UNIT_ORDER: UNIT_ORDER,
    unitStats: unitStats,
    START_CREDITS: 4000,
    ORE_RATE: 50,          // Erz pro Sekunde beim Sammeln
    UNLOAD_RATE: 350,      // Erz pro Sekunde beim Abladen
    ORE_REGROW: 1.5,       // (v0.8: verdoppelt, vorher 0.75) Erz pro Sekunde und Kachel Nachwachsen (nur Felder mit oreMax>0)
    QUEUE_MAX: 5,
    // v0.3 Spezialgebäude
    CAPTURE_TIME: 4,       // s bis Eroberung abgeschlossen
    OIL_INCOME: 12,        // Credits/s je Ölbohrturm
    HEAL_RATE: 5,          // HP/s Infanterie am Feldlazarett
    UNIT_REPAIR_RATE: 15,  // HP/s Fahrzeuge an der Werkstatt
    SUPPORT_RADIUS: 5,     // Kacheln (Lazarett/Werkstatt)
    // v0.4 Superwaffen: charge = Ladezeit s (bei Energiemangel halbe Geschwindigkeit), delay = Vorwarn-/Flugzeit s,
    // radius in Kacheln, dmg in der Mitte → edge (Anteil) am Rand, bld = Faktor für Gebäude. Kein Schaden an eigenen Einheiten.
    SW: { charge: 360,
          orbital: { delay: 3, radius: 3, dmg: 600, edge: 0.5, bld: 0.6 },
          missile: { delay: 5, radius: 4, dmg: 450, edge: 0.5, bld: 0.6 } },
    ARTY: { charge: 180, range: 30, delay: 2, shells: 6, spread: 2, dmg: 110, weapon: 'cannon', splash: 0.8 },
    RUIN_HP: 0.5,
    APC_EJECT_HP: 0.5,     // v0.7: Insassen eines zerstörten Schützenpanzers steigen mit 50 % HP aus
    PEACE_OPTIONS: [0, 5, 10, 15],   // v0.7: Friedenszeit in Minuten (S.settings.peace in Sekunden)
    AI_FIRST_ATTACK: { easy: 480, medium: 360, hard: 240 },   // v0.7: frühester erster KI-Angriff (s)
    HARV_HIDE: 8,
    AI_UNIT_VALUE: 380,    // KI: Credits-Wert je „Einheit“ der Wellengröße (Wellenschwelle nach Wert statt Stückzahl)          // s Ruhe, bevor ein geflohener Sammler weitersammelt          // Insassen verlassen eine Ruine mit 50 % HP
    PLACE_DIST: 3,         // max. Kachelabstand zu eigenem Gebäude
    WALL_MAX: 30,          // v0.5: max. Mauersegmente je G.cmd.placeWall
    WALL_PATH_COST: 300,   // v0.5: Zusatzkosten (A*-Einheiten, 10 = 1 Kachel) je gegnerischem Mauersegment im Durchbruchspfad
    SELL_REFUND: 0.5,
    REPAIR_RATE: 0.04,     // Anteil maxHp pro Sekunde
    REPAIR_COST: 0.5,      // Anteil der Baukosten für volle Reparatur
    SPEEDS: { slow: 0.75, normal: 1, fast: 1.5 },
    SPEED_NAMES: { slow: 'Langsam', normal: 'Normal', fast: 'Schnell' },
    DIFFS: { easy: 'Leicht', medium: 'Mittel', hard: 'Schwer' },
    CAT_NAMES: { building: 'Gebäude', defense: 'Verteidigung', infantry: 'Infanterie', vehicle: 'Fahrzeuge' }
  };
})();

/* ---- Erfahrung (Rangstufen) – eigener Block; alle Zahlen hier nachstellbar ----
 * Kampfeinheiten sammeln Erfahrung (e.xp) durch ausgeteilten Schaden: Punkte = Schadensanteil am Ziel × Wert des Ziels (Kosten / 100,
 * Gebäude × bldWeight). Psi-Einheiten sammeln Erfahrung durch erfolgreiche Gedankenkontrolle. Nicht-Kämpfer (ohne Waffe, Sammler, Ingenieur, Bauhof) steigen nicht auf, Gebäude/Türme auch nicht.
 * ranks[i]: xp = Schwelle, dmg = Schadensfaktor, hp = Schadensminderung (Treffer / hp), rof = Faktor auf die Nachladezeit (<1 = schneller),
 * psi = Faktor auf Abklingzeit/Nachladen von Psi-Waffen (Psi-Adept, Psi-Koloss, <1 = schneller), regen = Selbstheilung (Anteil maxHp je Sekunde, nur ohne Gefecht seit regenDelay s). Wirksame Werte liefert G.Sim.mods(e) (sim.js). */
(function () {
  'use strict';
  var D = G.DATA;
  D.EXP = {
    ranks: [
      { id: 'recruit', name: 'Rekrut',   xp: 0,  dmg: 1.0,  hp: 1.0,  rof: 1.0,  psi: 1.0,  regen: 0 },
      { id: 'vet',     name: 'Veteran',  xp: 8, dmg: 1.1,  hp: 1.1,  rof: 1.0,  psi: 0.92, regen: 0 },
      { id: 'elite',   name: 'Elite',    xp: 24, dmg: 1.2,  hp: 1.2,  rof: 1.0,  psi: 0.84, regen: 0 },
      { id: 'hero',    name: 'Held',     xp: 55, dmg: 1.3,  hp: 1.3,  rof: 0.9,  psi: 0.75, regen: 0.008 }
    ],
    psiWeight: 0.5,     // Psi-Einheiten: Punkte je erfolgreicher Gedankenkontrolle = Zielwert (Kosten / costDiv) × psiWeight
    costDiv: 100,       // Wert des Ziels = Kosten / costDiv
    bldWeight: 0.5,     // Gebäude als Ziel zählen nur halb
    regenDelay: 10,     // s ohne Schuss/Treffer, bevor die Selbstheilung (Rang mit regen > 0) einsetzt
    flashT: 40          // Ticks Aufblitzen des Abzeichens nach einem Aufstieg (nur Darstellung)
  };
  /** Rang (0..3) zu Erfahrungspunkten. */
  D.expRank = function (xp) { var r = D.EXP.ranks, i = r.length - 1; while (i > 0 && xp < r[i].xp) i--; return i; };
  /** Kann diese Einheit (Werte aus unitStats) Erfahrung sammeln? */
  D.expEligible = function (st) { return !!(st && st.weapon && !st.harvester && !st.engineer && !st.mcv); };
})();

/* ---- v0.8 (SPEC_v08): Luftwaffe & Marine – eigener Block, damit Zusammenführungen mit parallelen Änderungen sauber bleiben ----
 * Neue Bewegungsklassen: 'air' (fliegt geradlinig, ignoriert Gelände/Gebäude) und 'naval' (nur Wasser + unter Brücken).
 * Neue Panzerung 'air' (Luftfahrzeuge in der Luft); nur Waffen mit antiAir:true treffen fliegende Ziele, airOnly:true trifft nur Luftziele.
 * Neue Produktionskategorien 'air' (Flugfeld) und 'naval' (Werft) mit eigener Warteschlange P.q.air / P.q.naval. */
(function () {
  'use strict';
  var D = G.DATA, B = D.BUILDINGS, U = D.UNITS;
  function W(type, range, dmg, rof, extra) { var w = { type: type, range: range, dmg: dmg, rof: rof }; for (var k in extra) w[k] = extra[k]; return w; }

  // Gelände: Schiffe fahren auf Wasser und unter Brücken hindurch
  D.TERRAIN[D.T.water].naval = true;
  D.TERRAIN[D.T.bridge].naval = true;

  // Schadenstabelle: Spalte 'air' für alle Waffen (zählt nur, wenn die Waffe das Ziel überhaupt treffen darf – gelandete Luftfahrzeuge
  // gelten als Bodenziel mit Panzerung 'air'), neue Waffen flak (Flugabwehr) und bomb (Bombenteppich)
  var AIR = { bullet: 0.5, rocket: 0.9, cannon: 0.5, laser: 1.0, lightning: 1.0, sniper: 0.1, flame: 0.8 };
  for (var wt in AIR) if (D.DAMAGE[wt]) D.DAMAGE[wt].air = AIR[wt];
  D.DAMAGE.flak = { inf: 0.3, light: 0.5, heavy: 0.2, building: 0.1, air: 1.0 };
  D.DAMAGE.bomb = { inf: 1.0, light: 1.0, heavy: 0.85, building: 1.1, air: 0 };

  // Bestehende Flugabwehr-fähige Waffen: Raketentrupp, Jagdpanzer, Raketenwerfer-Lkw (Salve fliegt gegen Luftziele zielsuchend)
  [['rocket', 'coalition'], ['rocket', 'syndicate'], ['hunter', 'coalition'], ['mlrs', 'syndicate']].forEach(function (p) {
    var f = U[p[0]] && U[p[0]][p[1]]; if (f && f.weapon) f.weapon.antiAir = true;
  });

  // ---- Gebäude
  B.airfield = { id: 'airfield', name: 'Flugfeld', w: 4, h: 3, cost: 1500, time: 20, power: -40, hp: 1600, req: 'factory', sight: 6, produces: 'air',
                 pads: 4, desc: 'Baut Luftfahrzeuge, 4 Landeplätze' };
  // shore: Werft-Platzierungsregel (sim.js canPlaceShore): 3×3, jede Kachel Wasser oder bebaubares Land (ohne Erz), mind. shoreWater Wasserkacheln,
  // an Land angrenzend, Wasser gehört zu einem schiffbaren Gewässer (≥ D.NAVAL_MIN_WATER Kacheln); Nähe-Regel placeDist statt PLACE_DIST
  B.shipyard = { id: 'shipyard', name: 'Werft', w: 3, h: 3, cost: 1200, time: 18, power: -30, hp: 1800, req: 'factory', sight: 7, produces: 'naval',
                 shore: true, shoreWater: 3, placeDist: 5, desc: 'Baut Schiffe – am Ufer, teils im Wasser' };
  // Flak-Stellung: reine Flugabwehr (defense:true → Reiter „Verteidigung“ bzw. Verteidigungs-Warteschlange)
  B.flak = { id: 'flak', name: 'Flak-Stellung', w: 1, h: 1, cost: 550, time: 12, power: -20, hp: 900, req: 'barracks', sight: 9, defense: true,
             weapon: W('flak', 8, 28, 0.45, { antiAir: true, airOnly: true }), desc: 'Flugabwehr – nur gegen Luftziele' };
  D.BUILD_ORDER.push('airfield', 'shipyard', 'flak');

  // ---- Einheiten. Gemeinsame Felder: cat, move, producer, armor; Fraktionswerte wie bisher (Koalition schneller/teurer)
  // flyer: fliegt (Feld e.alt 0..1), transport: Plätze (Infanterie 1, Fahrzeug 2, groß 3), carry: 'inf' | 'any'
  U.transheli = {
    id: 'transheli', name: 'Transporthubschrauber', cat: 'air', move: 'air', producer: 'airfield', armor: 'air', radius: 13, sight: 7, flyer: true,
    desc: 'Fliegt 5 Infanteristen überallhin', transport: 5, carry: 'inf',
    coalition: { cost: 900, time: 14, hp: 380, speed: 3.6, weapon: null },
    syndicate: { cost: 800, time: 13, hp: 440, speed: 3.1, weapon: null }
  };
  U.gunship = {
    id: 'gunship', name: 'Kampfhubschrauber', cat: 'air', move: 'air', producer: 'airfield', armor: 'air', radius: 13, sight: 7, flyer: true,
    desc: 'Raketen gegen Bodenziele',
    coalition: { cost: 1300, time: 16, hp: 420, speed: 3.2, weapon: W('rocket', 5.5, 40, 1.5) },
    syndicate: { cost: 1150, time: 15, hp: 500, speed: 2.7, weapon: W('rocket', 5, 44, 1.7) }
  };
  // bomber: Bombenteppich aus bombs Bomben im Abstand spacing (Kacheln) entlang der Flugbahn, mittig über dem Ziel; danach zurück zum Flugfeld,
  // landen, rearm s nachladen (bei Energiemangel doppelt so lange). Keine Wirkung gegen Luftziele.
  U.bomber = {
    id: 'bomber', name: 'Bomber', cat: 'air', move: 'air', producer: 'airfield', armor: 'air', radius: 15, sight: 6, flyer: true, bomber: true,
    desc: 'Bombenteppich, danach Nachladen am Flugfeld',
    coalition: { cost: 2000, time: 26, hp: 520, speed: 5.0, weapon: W('bomb', 1, 115, 0.2, { bombs: 6, spacing: 0.8, splash: 1.0, rearm: 40 }) },
    syndicate: { cost: 1800, time: 26, hp: 620, speed: 4.4, weapon: W('bomb', 1, 125, 0.2, { bombs: 6, spacing: 0.85, splash: 1.05, rearm: 44 }) }
  };
  U.gunboat = {
    id: 'gunboat', name: 'Kanonenboot', cat: 'naval', move: 'naval', producer: 'shipyard', armor: 'light', radius: 13, sight: 7, turret: true,
    desc: 'Schnell, leicht bewaffnet',
    coalition: { cost: 650, time: 10, hp: 380, speed: 3.2, weapon: W('cannon', 5.5, 32, 1.0) },
    syndicate: { cost: 580, time: 9, hp: 440, speed: 2.8, weapon: W('cannon', 5, 34, 1.1) }
  };
  // destroyer: schwere Geschütze (weapon) + Flak (aa, eigener Feuertakt, nur Luftziele)
  U.destroyer = {
    id: 'destroyer', name: 'Zerstörer', cat: 'naval', move: 'naval', producer: 'shipyard', armor: 'heavy', radius: 17, sight: 8, turret: true,
    desc: 'Schwere Geschütze, Flak gegen Luftziele',
    coalition: { cost: 1800, time: 22, hp: 1300, speed: 1.9, weapon: W('cannon', 8, 85, 2.2), aa: W('flak', 6, 22, 0.5, { antiAir: true, airOnly: true }) },
    syndicate: { cost: 1650, time: 22, hp: 1550, speed: 1.6, weapon: W('cannon', 7.5, 90, 2.4), aa: W('flak', 5.5, 24, 0.55, { antiAir: true, airOnly: true }) }
  };
  U.lander = {
    id: 'lander', name: 'Landungsboot', cat: 'naval', move: 'naval', producer: 'shipyard', armor: 'light', radius: 16, sight: 6,
    desc: 'Bringt Infanterie und Fahrzeuge an Land', transport: 6, carry: 'any',
    coalition: { cost: 800, time: 12, hp: 650, speed: 2.4, weapon: null },
    syndicate: { cost: 700, time: 12, hp: 760, speed: 2.1, weapon: null }
  };
  D.UNIT_ORDER.air = ['transheli', 'gunship', 'bomber'];
  D.UNIT_ORDER.naval = ['gunboat', 'destroyer', 'lander'];
  D.CAT_NAMES.air = 'Luftwaffe';
  D.CAT_NAMES.naval = 'Marine';

  D.MOVE_CLASS = { foot: 0, wheel: 1, air: 2, naval: 3 };   // e.mc
  D.AIR_CLIMB = 0.8;          // s vom Boden auf Flughöhe (e.alt 0 → 1)
  D.AIR_H = 2.2;              // Flughöhe in Kacheln (3D-Darstellung, Picking)
  D.AIR_LIFT = 44;            // Flughöhe in Bildschirm-px bei Zoom 1 (2D-Darstellung)
  D.NAVAL_MIN_WATER = 40;     // Mindestgröße eines Gewässers (Kacheln) für Werft/Schiffe
  D.BEACH_RANGE = 2.2;        // Kacheln: so nah muss ein Landungsboot am Ufer liegen (Ein-/Aussteigen)
  D.HELI_BOARD = 1.3;         // Kacheln: Einsteigeabstand am gelandeten Hubschrauber
})();

/* ---- v0.9 (SPEC_v08 §14): Schlachtschiff „Dreadnought“ – eigener Block (Zusammenführung mit parallelen Grafik-Änderungen) ----
 * Schweres Raketenschiff aus der Werft (zusätzlich Tech-Zentrum): langsam, sehr robust, feuert Salven ballistischer Raketen weit ins
 * Landesinnere (wie Haubitze/Raketenwerfer: nur stehend nach Aufbau, Mindestreichweite, Flächenschaden, nicht zielsuchend, braucht Sicht).
 * Keine Flugabwehr (Waffe ohne antiAir → trifft keine Luftziele), schwach gegen nahe Schiffe (Mindestreichweite) und Bomber. */
(function () {
  'use strict';
  var D = G.DATA, U = D.UNITS;
  function W(type, range, dmg, rof, extra) { var w = { type: type, range: range, dmg: dmg, rof: rof }; for (var k in extra) w[k] = extra[k]; return w; }
  // neue Waffe 'missile': stark gegen Gebäude, mäßig gegen Fahrzeuge, schwach gegen Infanterie, nie gegen Luftziele
  D.DAMAGE.missile = { inf: 0.5, light: 0.9, heavy: 0.8, building: 1.25, air: 0 };
  // salvo: Raketen je Salve (Abstand salvoGap s), scatter: Streuung (Kacheln), pspeed: Fluggeschwindigkeit (px/Tick), missile: Darstellungs-Flag
  U.dreadnought = {
    id: 'dreadnought', name: 'Schlachtschiff', cat: 'naval', move: 'naval', producer: 'shipyard', armor: 'heavy', radius: 20, sight: 7, turret: true,
    setup: 1.5, req: 'techcenter',
    desc: 'Raketen weit ins Landesinnere – braucht Aufklärung, keine Flugabwehr',
    coalition: { cost: 2600, time: 34, hp: 2000, speed: 1.3,
                 weapon: W('missile', 15, 150, 8.0, { minRange: 5, splash: 1.3, salvo: 2, salvoGap: 0.6, scatter: 0.6, pspeed: 7, missile: true }) },
    syndicate: { cost: 2400, time: 34, hp: 2400, speed: 1.1,
                 weapon: W('missile', 14, 160, 8.5, { minRange: 5, splash: 1.4, salvo: 2, salvoGap: 0.6, scatter: 0.7, pspeed: 7, missile: true }) }
  };
  D.UNIT_ORDER.naval.push('dreadnought');
})();

/* ---- v1.0 (SPEC_v10): dritte Fraktion „Kollektiv“ (Psi / Gedankenkontrolle / Zukunftstechnik) – eigener Block ----
 * Fraktionsfarbe Dunkelblau (Indigo) – klar unterscheidbar vom hellen Koalitions-Blau #3b82f6.
 * Gemeinsame Rollen (rifle, rocket, tank, harvester, …) bekommen einen kollektiv-Block mit eigenem Namen (unitStats übernimmt name/desc
 * aus dem Fraktions-Block); eigene Mechaniken laufen über neue Typen (psiadept, brute, gatling, magnet, psitank, psitower, psidome).
 * Gebäude sind für alle Fraktionen gleich (Werte), Kollektiv-Namen über NAMES_B (D.bName(type, fac)).
 * Neue Waffen: psi (Gedankenkontrolle, kein Schaden), melee (Nahkampf), magnet (hält Fahrzeuge fest und zieht sie heran), torpedo (nur Schiffe),
 * disc (Diskus-Strahl, entzieht Gebäuden Credits/Strom). Gatling-Feuer beschleunigt (weapon.spin). */
(function () {
  'use strict';
  var D = G.DATA, U = D.UNITS, B = D.BUILDINGS;
  function W(type, range, dmg, rof, extra) { var w = { type: type, range: range, dmg: dmg, rof: rof }; for (var k in extra) w[k] = extra[k]; return w; }

  D.FACTIONS.kollektiv = { id: 'kollektiv', name: 'Kollektiv', color: '#3341c8', dark: '#1c2470', light: '#a5b4fc',
                           desc: 'Psi-Kräfte, Gedankenkontrolle, Schwebetechnik' };
  // v1.0: Ersatzfarbe für den zweiten Spieler, wenn beide dieselbe Fraktion spielen (Spiegelpartie)
  D.FACTIONS.coalition.alt = '#06b6d4'; D.FACTIONS.syndicate.alt = '#f97316'; D.FACTIONS.kollektiv.alt = '#c026d3';
  D.FACTION_IDS = ['coalition', 'syndicate', 'kollektiv'];

  // Schadenstabelle (psi richtet keinen Schaden an; Werte nur als Zielvorliebe)
  D.DAMAGE.psi = { inf: 0, light: 0, heavy: 0, building: 0, air: 0 };
  D.DAMAGE.melee = { inf: 1.25, light: 0.9, heavy: 0.6, building: 0.5, air: 0 };
  D.DAMAGE.magnet = { inf: 0, light: 1.0, heavy: 1.1, building: 0, air: 0 };
  D.DAMAGE.torpedo = { inf: 0, light: 1.1, heavy: 1.0, building: 0, air: 0 };
  D.DAMAGE.disc = { inf: 0.7, light: 0.8, heavy: 0.6, building: 0.8, air: 0 };

  // Bewegungsklasse 'hover' = Fahrzeug (e.mc 1), Wegfindung Klasse 4 (Land für Fahrzeuge + Wasser/Brücken), Feld e.pc
  D.MOVE_CLASS.hover = 1;
  D.HOVER_PC = 4;

  // Gedankenkontrolle (SPEC_v10 §3)
  D.PSI = {
    maxControls: 1,      // so oft kann eine Einheit insgesamt übernommen werden, danach Psi-resistent
    reImmune: 10,        // s Schutz nach der Freigabe (kein sofortiges Zurückholen)
    relink: 6,           // s Abklingzeit des Kontrolleurs, wenn eine kontrollierte Einheit stirbt/recycelt/freigegeben wird
    overload: 25,        // HP/s Schaden je Einheit über psi.safe (Psi-Koloss)
    recycle: 0.5         // Recycling am Erzwandler: Anteil der Baukosten
  };
  D.CLONE_EVERY = 6;     // Klonlabor (Kollektiv-Kaserne): jede 6. Infanterie-Einheit erscheint doppelt (Klon gratis, nicht Ingenieur/Sanitäter)
  D.SW.psi = { delay: 2, radius: 3.5, dmg: 0, edge: 1, bld: 0, psi: true };   // Psi-Welle: übernimmt alle übernehmbaren Gegner im Radius dauerhaft

  // ---- Kollektiv-Namen der gemeinsamen Gebäude
  D.NAMES_B = { kollektiv: { hq: 'Psi-Zentrale', power: 'Psi-Reaktor', refinery: 'Erzwandler', barracks: 'Klonlabor', factory: 'Kriegsfabrik',
                             turret: 'Strahlkanone', mg: 'Gatling-Stand', techcenter: 'Psi-Labor', wall: 'Kristallmauer', pbunker: 'Psi-Bunker',
                             airfield: 'Diskus-Hangar', shipyard: 'U-Boot-Werft', flak: 'Abwehrspule' } };
  D.DESC_B = { kollektiv: { refinery: 'Erz → Credits; Einheiten recyceln', barracks: 'Infanterie, jede 4. Einheit als Gratis-Klon' } };
  D.bName = function (type, fac) { var n = fac && D.NAMES_B[fac] && D.NAMES_B[fac][type]; return n || (B[type] ? B[type].name : String(type)); };
  D.bDesc = function (type, fac) { var n = fac && D.DESC_B[fac] && D.DESC_B[fac][type]; return n || (B[type] ? B[type].desc : ''); };
  D.uName = function (type, fac) { var s = fac && D.unitStats(fac, type); return (s && s.name) || (U[type] ? U[type].name : String(type)); };

  // ---- Fraktionsgebäude
  B.psitower = { id: 'psitower', name: 'Psi-Turm', w: 2, h: 2, cost: 1500, time: 20, power: -80, hp: 1500, req: 'techcenter', sight: 8, defense: true,
                 faction: 'kollektiv', noFireLowPower: true,
                 weapon: W('psi', 6.5, 0, 4.0, { psi: { slots: 3, safe: 3 }, beam: true }), desc: 'Übernimmt bis zu 3 Angreifer (Gedankenkontrolle)' };
  B.psidome = { id: 'psidome', name: 'Psi-Verstärker', w: 3, h: 2, cost: 3500, time: 40, power: -150, hp: 2500, req: 'techcenter', sight: 6,
                faction: 'kollektiv', superweapon: 'psi', limit: 1, desc: 'Psi-Welle: übernimmt Gegner im Umkreis (Aufladung 6 min)' };
  D.BUILD_ORDER.push('psidome', 'psitower');

  // ---- Kollektiv-Blöcke gemeinsamer Rollen
  U.rifle.kollektiv = { name: 'Initiand', cost: 90, time: 4.5, hp: 100, speed: 1.1, weapon: W('bullet', 4.25, 16, 1.0) };
  U.rocket.kollektiv = { name: 'Plasmatrupp', cost: 270, time: 6.5, hp: 95, speed: 1.0, weapon: W('rocket', 6, 52, 2.5, { antiAir: true }) };
  U.engineer.kollektiv = { name: 'Techniker', cost: 500, time: 8, hp: 80, speed: 1.0, weapon: null };
  U.medic.kollektiv = { name: 'Heiler', cost: 400, time: 8, hp: 90, speed: 1.1, weapon: null };
  U.harvester.kollektiv = { name: 'Erzsauger', cost: 1400, time: 18, hp: 1100, speed: 1.2, weapon: null };
  U.mcv.kollektiv = { cost: 3000, time: 30, hp: 1500, speed: 1.0, weapon: null };
  U.tank.kollektiv = { name: 'Schwebepanzer', desc: 'Schwebt über Land und Wasser', move: 'hover', cost: 850, time: 13, hp: 620, speed: 2.0,
                       weapon: W('cannon', 5.25, 70, 1.6) };
  U.transheli.kollektiv = { name: 'Transportgleiter', cost: 850, time: 14, hp: 400, speed: 3.4, weapon: null };
  // Diskus (Rolle Kampfhubschrauber): Strahl gegen Bodenziele; trifft er Gebäude, entzieht er dem Besitzer Credits (drain.cr je Treffer),
  // Kraftwerke liefern drain.pwr s lang keinen Strom
  U.gunship.kollektiv = { name: 'Diskus', desc: 'Fliegende Untertasse – entzieht Gebäuden Credits und Strom', cost: 1400, time: 17, hp: 480, speed: 2.8,
                          weapon: W('disc', 5, 34, 1.2, { beam: true }), drain: { cr: 8, pwr: 3 } };
  U.gunboat.kollektiv = { name: 'Tauchboot', desc: 'Torpedos – nur gegen Schiffe', cost: 700, time: 10, hp: 420, speed: 2.8,
                          weapon: W('torpedo', 6, 60, 1.6, { navalOnly: true }) };
  U.destroyer.kollektiv = { name: 'Raketen-Tauchboot', desc: 'Raketen gegen Land- und Seeziele, Flugabwehr', cost: 1750, time: 22, hp: 1300, speed: 1.8,
                            weapon: W('rocket', 8, 75, 2.3), aa: W('flak', 6, 22, 0.5, { antiAir: true, airOnly: true }) };
  U.lander.kollektiv = { name: 'Schwebefähre', cost: 750, time: 12, hp: 700, speed: 2.3, weapon: null };

  // ---- neue Kollektiv-Einheiten
  // psi: { slots: max. gleichzeitig kontrollierte Einheiten, safe: davon ohne Überlastung }; psiImmune: nicht übernehmbar
  U.psiadept = {
    id: 'psiadept', name: 'Psi-Adept', cat: 'infantry', armor: 'inf', move: 'foot', radius: 6, sight: 7, faction: 'kollektiv', psiImmune: true,
    desc: 'Übernimmt eine gegnerische Einheit (Gedankenkontrolle)',
    kollektiv: { cost: 800, time: 11, hp: 90, speed: 1.1, weapon: W('psi', 6, 0, 3.5, { psi: { slots: 1, safe: 1 }, beam: true }) }
  };
  U.brute = {
    id: 'brute', name: 'Mutant', cat: 'infantry', armor: 'inf', move: 'foot', radius: 7, sight: 5, faction: 'kollektiv',
    desc: 'Zäher Nahkämpfer, zerschlägt Infanterie und Fahrzeuge',
    kollektiv: { cost: 420, time: 8, hp: 400, speed: 1.15, weapon: W('melee', 1.1, 55, 1.2) }
  };
  U.gatling = {
    id: 'gatling', name: 'Gatling-Panzer', cat: 'vehicle', armor: 'light', move: 'wheel', radius: 11, sight: 7, faction: 'kollektiv', turret: true,
    desc: 'Dreht hoch – gegen Infanterie und Luftziele',
    // spin: Feuertakt sinkt bei Dauerfeuer von rof auf min (spin 0 → 1 in etwa up s Dauerfeuer), kühlt ohne Feuer wieder ab
    kollektiv: { cost: 650, time: 9, hp: 300, speed: 2.4, weapon: W('bullet', 5.5, 8, 0.6, { antiAir: true, spin: { min: 0.3, up: 3 } }) }
  };
  U.magnet = {
    id: 'magnet', name: 'Magnet-Werfer', cat: 'vehicle', armor: 'light', move: 'wheel', radius: 12, sight: 8, faction: 'kollektiv', turret: true, req: 'techcenter',
    desc: 'Hält Fahrzeuge und Schiffe fest und zieht sie heran',
    // magnet: hold s Festhalten je Treffer, pull Kacheln/s Zug zum Werfer (bis stop Kacheln Abstand); vehicleOnly: nur Fahrzeuge/Schiffe
    kollektiv: { cost: 1300, time: 16, hp: 420, speed: 1.5, weapon: W('magnet', 8, 30, 1.0, { beam: true, vehicleOnly: true, hold: 1.3, pull: 0.8, stop: 2.5 }) }
  };
  U.psitank = {
    id: 'psitank', name: 'Psi-Koloss', cat: 'vehicle', armor: 'heavy', move: 'wheel', radius: 15, sight: 8, faction: 'kollektiv', turret: true, req: 'techcenter',
    psiImmune: true, desc: 'Kontrolliert bis zu 2 Einheiten – mehr überlastet ihn',
    kollektiv: { cost: 2200, time: 24, hp: 1000, speed: 1.1, weapon: W('psi', 6, 0, 5.0, { psi: { slots: 3, safe: 2 }, beam: true }) }
  };
  D.UNIT_ORDER.infantry.push('psiadept', 'brute');
  D.UNIT_ORDER.vehicle.splice(D.UNIT_ORDER.vehicle.indexOf('harvester'), 0, 'gatling', 'magnet', 'psitank');
})();

/* ---- v1.2 Neue Einheiten & Zusatzgebäude – eigener Block ----
 * SPIELSTAND-VERSION: D.SAVE_VERSION (S.version). Ältere Stände werden über G.Sim.migrate() ergänzt (fehlende Felder → Standard),
 * neuere/unbekannte als „nicht mehr kompatibel“ verworfen (save.js).
 * VORLÄUFIGE DARSTELLUNG: jedes neue Objekt hat ein Feld look = ID eines vorhandenen Typs, dessen Modell/Symbol/Sprite benutzt wird, solange
 * es kein eigenes gibt (D.lookOf(type); Renderer: r3-models.js lookAlias()/model(), render2d.js lookType()). Im 2D-/Sprite-Rückfall bleibt look dauerhaft.
 * Neue Datenfelder (Einheiten): cloak (getarnt, s. sim.js „Tarnung“), detect (Aufdeckradius in Kacheln), saboteur {dmg, delay, stun, cd},
 *   hangar {type, slots, range, rebuild, life, ammo} (Träger: startet Drohnen-Einheiten des Typs type), drone (nicht baubar/nicht steuerbar),
 *   Waffe: stun (s Lähmung statt Schaden), fx (Waffentyp für die Darstellung, falls abweichend von type).
 * Neue Datenfelder (Gebäude): detect, repairPad {r, rate, cost}, store (Erz-Lagerkapazität), mine {dmg, r, charges, trig}, gate, noOcc, placeDist, cloak. */
(function () {
  'use strict';
  var D = G.DATA, U = D.UNITS, B = D.BUILDINGS;
  function W(type, range, dmg, rof, extra) { var w = { type: type, range: range, dmg: dmg, rof: rof }; for (var k in extra) w[k] = extra[k]; return w; }

  D.SAVE_VERSION = 2;   // 1 = bis v1.1 (ohne Versionsprüfung), 2 = v1.2
  /** Typ, dessen Modell/Symbol/Sprite vorläufig benutzt wird (oder type selbst). */
  D.lookOf = function (type) { var d = U[type] || B[type]; return (d && d.look) || type; };

  // ---- Flakpanzer: mobile Flugabwehr (alle Fraktionen). Flak-Waffe ohne airOnly → trifft auch Bodenziele (schwach gegen Panzer).
  U.flaktank = {
    id: 'flaktank', name: 'Flakpanzer', cat: 'vehicle', armor: 'light', move: 'wheel', radius: 11, sight: 8, turret: true, look: 'gatling',
    desc: 'Mobile Flugabwehr – stark gegen Luftziele, schwach gegen Panzer',
    coalition: { cost: 700, time: 10, hp: 340, speed: 2.4, weapon: W('flak', 7, 22, 0.4, { antiAir: true }) },
    syndicate: { cost: 620, time: 9, hp: 400, speed: 2.0, weapon: W('flak', 6.5, 24, 0.45, { antiAir: true }) },
    kollektiv: { name: 'Spulenpanzer', cost: 660, time: 10, hp: 360, speed: 2.2, weapon: W('flak', 7, 22, 0.42, { antiAir: true }) }
  };
  D.UNIT_ORDER.vehicle.splice(D.UNIT_ORDER.vehicle.indexOf('tank'), 0, 'flaktank');

  // ---- Reparaturdock: repariert eigene Fahrzeuge im Umkreis r Kacheln um rate HP/s; volle Reparatur kostet cost × Baukosten der Einheit.
  // x12: Gebäude hat einen eigenen Tick in sim.js (tickBld12).
  B.repairdock = { id: 'repairdock', name: 'Reparaturdock', w: 3, h: 2, cost: 900, time: 14, power: -30, hp: 1200, req: 'factory', sight: 5, look: 'silo',
                   x12: true, repairPad: { r: 3, rate: 25, cost: 0.3 }, desc: 'Repariert eigene Fahrzeuge im Umkreis (gegen Credits)' };
  // ---- Tor: Mauersegment (isWall: zählt nicht für Sieg/Nähe-Regel, wird nie automatisch beschossen), das eigene Bodeneinheiten durchlässt.
  B.gate = { id: 'gate', name: 'Tor', w: 1, h: 1, cost: 200, time: 5, power: 0, hp: 1000, req: 'barracks', sight: 1, defense: true, look: 'wall',
             isWall: true, gate: true, x12: true, buildAnim: 0.5, desc: 'Mauerstück, das nur eigene Einheiten durchlässt' };
  // ---- Handelsposten: neutrales, einnehmbares Kartengebäude – je Posten discount Rabatt auf Fahrzeuge (höchstens max Posten zählen)
  B.tradepost = { id: 'tradepost', name: 'Handelsposten', w: 3, h: 2, cost: 0, time: 0, power: 0, hp: 1000, req: null, sight: 5, sellable: false, look: 'workshop',
                  neutral: true, kind2: 'special', special: 'trade', invuln: true, desc: 'Fahrzeuge 10 % günstiger' };
  // ---- Erzsilo / Lagerkapazität: Credits aus Erz sind durch die Kapazität P.oreCap begrenzt = ORE_CAP.base + Summe store aller eigenen Gebäude.
  // Ist das Lager voll, wartet der Sammler mit dem Abladen (nichts geht verloren). Andere Einnahmen (Öl, Verkauf, Recycling) sind nicht begrenzt.
  // Geht Lager verloren (Raffinerie/Silo zerstört, verkauft, übernommen), verfällt der Überschuss über der neuen Kapazität.
  D.ORE_CAP = { base: 5000, warn: 0.9 };
  B.refinery.store = 5000;
  B.oresilo = { id: 'oresilo', name: 'Erzsilo', w: 2, h: 2, cost: 400, time: 8, power: -5, hp: 700, req: 'refinery', sight: 3, look: 'power',
                store: 3000, desc: 'Lager für 3000 Credits aus Erz' };
  D.TRADE = { discount: 0.10, max: 2 };

  // ---- TARNUNG / AUFDECKUNG (sim.js Abschnitt „Tarnung“): Objekte mit cloak sind für Gegner unsichtbar (nicht anwählbar, kein Ziel – auch für die KI),
  // außer im Aufdeckradius detect (Kacheln) eines gegnerischen Detektors oder fireReveal/actReveal s nach eigener Aktion (Schuss, Sprengladung, Mine).
  // Detektoren: Radarwagen (7), Zerstörer (6), Ingenieur (3), Hauptquartier (4), Geschütz-/Abwehrtürme (3), eroberte Radarstation (8).
  D.CLOAK = { fireReveal: 3, actReveal: 6, every: 5 };
  B.hq.detect = 4; B.radar.detect = 8;
  ['turret', 'mg', 'flak', 'laser', 'tesla', 'psitower'].forEach(function (t) { B[t].detect = 3; });
  U.destroyer.detect = 6; U.engineer.detect = 3;
  D.DAMAGE.mine = { inf: 1.0, light: 1.0, heavy: 0.8, building: 0, air: 0 };

  // ---- Saboteur: getarnte, wehrlose Infanterie. G.cmd.sabotage → läuft zum gegnerischen Gebäude und legt eine Sprengladung (dmg Gebäudeschaden nach
  // delay s) oder legt es stun s lahm (Modus e.sabMode 0|1, G.cmd.sabMode); danach cd s Nachladen. Nach der Aktion kurz sichtbar.
  U.saboteur = {
    id: 'saboteur', name: 'Saboteur', cat: 'infantry', armor: 'inf', move: 'foot', radius: 6, sight: 6, req: 'techcenter', look: 'engineer',
    cloak: true, saboteur: { dmg: 700, delay: 4, stun: 20, cd: 40 }, desc: 'Getarnt – sprengt Gebäude oder legt sie lahm, wehrlos',
    coalition: { cost: 600, time: 10, hp: 70, speed: 1.3, weapon: null },
    syndicate: { cost: 550, time: 10, hp: 80, speed: 1.2, weapon: null },
    kollektiv: { name: 'Infiltrator', cost: 580, time: 10, hp: 70, speed: 1.3, weapon: null }
  };
  // ---- Radarwagen: unbewaffnet, deckt Getarntes im Umkreis detect auf, große Sichtweite
  U.radarcar = {
    id: 'radarcar', name: 'Radarwagen', cat: 'vehicle', armor: 'light', move: 'wheel', radius: 11, sight: 10, detect: 7, look: 'apc',
    desc: 'Deckt Getarntes und Minen im Umkreis auf, weite Sicht – unbewaffnet',
    coalition: { cost: 600, time: 9, hp: 300, speed: 2.6, weapon: null },
    syndicate: { cost: 550, time: 9, hp: 360, speed: 2.2, weapon: null },
    kollektiv: { name: 'Psi-Sensor', cost: 580, time: 9, hp: 320, speed: 2.4, weapon: null }
  };
  D.UNIT_ORDER.infantry.push('saboteur');
  D.UNIT_ORDER.vehicle.splice(D.UNIT_ORDER.vehicle.indexOf('tank'), 0, 'radarcar');
  // ---- U-Boot (Koalition, Syndikat; das Kollektiv hat bereits Tauchboot und Raketen-Tauchboot): getaucht getarnt, Torpedos nur gegen Schiffe.
  // Aufgedeckt von Zerstörern (6), Radarwagen am Ufer (7), Türmen/HQ in Ufernähe und 3 s nach jedem Torpedo.
  U.submarine = {
    id: 'submarine', name: 'U-Boot', cat: 'naval', move: 'naval', producer: 'shipyard', armor: 'light', radius: 14, sight: 6, cloak: true, look: 'gunboat',
    faction: 'both', desc: 'Getaucht getarnt – Torpedos nur gegen Schiffe',
    coalition: { cost: 1000, time: 14, hp: 460, speed: 2.3, weapon: W('torpedo', 6.5, 95, 2.4, { navalOnly: true }) },
    syndicate: { cost: 900, time: 14, hp: 540, speed: 2.0, weapon: W('torpedo', 6, 100, 2.6, { navalOnly: true }) }
  };
  // ---- TRÄGER-MECHANIK (sim.js „Träger/Drohnen“): Waffe mit hangar = { type (Drohnentyp), slots (Staffelplätze), ammo (Schüsse je Einsatz, 0 = unbegrenzt),
  // life (s Einsatzdauer, 0 = unbegrenzt), rearm (s nach Rückkehr), rebuild (s nach Verlust) }. Die Trägerwaffe richtet keinen Schaden an: „Feuern“ startet
  // je Takt (rof) eine bereite Drohne auf das Ziel. Drohnen (drone: true) sind echte Lufteinheiten (abschießbar), nicht baubar und nicht steuerbar; sie
  // fliegen das Ziel an, kämpfen, kehren zurück (ammo/life verbraucht, Ziel weg) und landen. Abschüsse/Erfahrung zählen für den Träger.
  D.DAMAGE.drone = { inf: 1, light: 1, heavy: 1, building: 1, air: 1 };
  U.carrierjet = {
    id: 'carrierjet', name: 'Trägerjäger', cat: 'air', move: 'air', producer: 'shipyard', armor: 'air', radius: 9, sight: 5, flyer: true, drone: true, look: 'gunship',
    desc: 'Startet vom Flugzeugträger',
    coalition: { cost: 250, time: 1, hp: 130, speed: 5.4, weapon: W('rocket', 3.5, 40, 0.45, { antiAir: true }) },
    syndicate: { cost: 250, time: 1, hp: 150, speed: 4.8, weapon: W('rocket', 3.5, 44, 0.5, { antiAir: true }) }
  };
  U.carrier = {
    id: 'carrier', name: 'Flugzeugträger', cat: 'naval', move: 'naval', producer: 'shipyard', armor: 'heavy', radius: 22, sight: 9, req: 'techcenter', look: 'dreadnought',
    faction: 'both', desc: '3 Jägerstaffeln greifen Ziele in großer Reichweite an und kehren zurück',
    coalition: { cost: 3000, time: 36, hp: 2200, speed: 1.2,
                 weapon: W('drone', 12, 0, 1.2, { antiAir: true, hangar: { type: 'carrierjet', slots: 3, ammo: 4, life: 0, rearm: 6, rebuild: 16 } }) },
    syndicate: { cost: 2800, time: 36, hp: 2600, speed: 1.0,
                 weapon: W('drone', 11.5, 0, 1.3, { antiAir: true, hangar: { type: 'carrierjet', slots: 3, ammo: 4, life: 0, rearm: 6.5, rebuild: 17 } }) }
  };
  D.UNIT_ORDER.naval.push('submarine', 'carrier');
  // ---- Kollektiv statt Träger: Psi-Drohne (Luft, lähmt) und Schwarm-Träger (Fahrzeug, kurzlebige Kampfdrohnen)
  // Waffe mit stun: kein Schaden, das Ziel (Bodeneinheit/Schiff) ist stun s gelähmt (e.stunT), danach 3 s immun; fx = Darstellung wie die Psi-Strahlen.
  D.DAMAGE.stun = { inf: 1, light: 1, heavy: 1, building: 0, air: 0 };
  D.STUN_IMMUNE = 3;
  U.psidrone = {
    id: 'psidrone', name: 'Psi-Drohne', cat: 'air', move: 'air', producer: 'airfield', armor: 'air', radius: 10, sight: 10, flyer: true, faction: 'kollektiv', look: 'gunship',
    psiImmune: true, desc: 'Schneller Aufklärer – lähmt eine gegnerische Einheit kurz',
    kollektiv: { cost: 900, time: 12, hp: 260, speed: 4.4, weapon: W('stun', 5, 0, 10, { stun: 4, beam: true, fx: 'psi' }) }
  };
  U.swarmling = {
    id: 'swarmling', name: 'Schwarmdrohne', cat: 'air', move: 'air', producer: 'factory', armor: 'air', radius: 6, sight: 4, flyer: true, drone: true, faction: 'kollektiv', look: 'gunship',
    desc: 'Kurzlebige Kampfdrohne des Schwarm-Trägers',
    kollektiv: { cost: 120, time: 1, hp: 55, speed: 4.6, weapon: W('laser', 2.5, 13, 0.7, { beam: true, antiAir: true }) }
  };
  U.swarmcarrier = {
    id: 'swarmcarrier', name: 'Schwarm-Träger', cat: 'vehicle', armor: 'heavy', move: 'wheel', radius: 14, sight: 8, req: 'techcenter', faction: 'kollektiv', look: 'psitank',
    desc: 'Setzt 4 kurzlebige Kampfdrohnen auf Ziele in mittlerer Reichweite aus',
    kollektiv: { cost: 1400, time: 18, hp: 650, speed: 1.4,
                 weapon: W('drone', 7, 0, 0.8, { antiAir: true, hangar: { type: 'swarmling', slots: 4, ammo: 0, life: 10, rearm: 7, rebuild: 9 } }) }
  };
  D.UNIT_ORDER.air.push('psidrone');
  D.UNIT_ORDER.vehicle.splice(D.UNIT_ORDER.vehicle.indexOf('harvester'), 0, 'swarmcarrier');
  // ---- Minenfeld: getarntes 1×1-Feld ohne Kachelbelegung (noOcc: blockiert keine Wege). Löst aus, wenn eine gegnerische Bodeneinheit (nicht schwebend,
  // nicht fliegend) näher als trig Kacheln kommt: Flächenschaden dmg im Radius r, charges Ladungen, dann verbraucht. Höchstens D.MINE_MAX je Spieler.
  D.MINE_MAX = 8;
  B.minefield = { id: 'minefield', name: 'Minenfeld', w: 1, h: 1, cost: 150, time: 4, power: 0, hp: 200, req: 'barracks', sight: 1, defense: true, look: 'mg',
                  cloak: true, noOcc: true, x12: true, isWall: true, limit: D.MINE_MAX, placeDist: 7, buildAnim: 0.5,
                  mine: { dmg: 260, r: 1.3, charges: 2, trig: 0.8, cd: 1 }, desc: 'Unsichtbar für den Gegner – schädigt Bodeneinheiten (2 Ladungen)' };
  D.NEUTRAL_TYPES.push('tradepost');
  D.BUILD_ORDER.push('oresilo', 'repairdock', 'gate', 'minefield');
  D.NAMES_B.kollektiv.repairdock = 'Regenerator'; D.NAMES_B.kollektiv.gate = 'Kristalltor'; D.NAMES_B.kollektiv.oresilo = 'Erzspeicher';
})();

/* ---- v1.3 Forschung – eigener Block (Sim: sim.js Abschnitt „v1.3 FORSCHUNG“ am Dateiende) ----
 * Forschungen werden im Tech-Zentrum gegen Credits und Zeit erforscht und gelten dauerhaft für die laufende Partie (je Spieler).
 * Immer nur EINE Forschung gleichzeitig je Spieler (auch bei mehreren Tech-Zentren); Bezahlung fortlaufend wie bei der Produktion;
 * Abbruch erstattet den bisher bezahlten Betrag vollständig. Ohne betriebsbereites Tech-Zentrum (zerstört, verkauft, lahmgelegt)
 * PAUSIERT die laufende Forschung (Fortschritt bleibt); abgeschlossene Forschungen bleiben auch ohne Tech-Zentrum wirksam.
 * Energiemangel halbiert das Forschungstempo (wie die Produktion).
 * D.RESEARCH[id] = { id, name, desc, cost, time (s), faction (fehlt = alle), req (ID der Vorstufe), tier (1|2, nur Anzeige), fx }
 * fx (alle Felder optional; mehrere Forschungen multiplizieren sich bzw. addieren sich bei sight/regen/detectCut):
 *   unit: [{ cat: Kategorie oder Liste | types: Typliste | all: true, dmg, hp, rof, psi (Faktoren wie D.EXP), regen (Zuschlag, Anteil maxHp/s) }]
 *         → fließt in G.Sim.mods(e) ein (wird mit den Rangwerten multipliziert). Hinweis: Drohnentreffer zählen für den Träger (dmg am Träger angeben).
 *   sight: +Kacheln Sichtweite (Einheiten und Gebäude)      harvCap: Faktor Sammler-Ladung
 *   repair: Faktor Reparaturtempo (Gebäude, Reparaturdock)   repairCost: Faktor Reparaturkosten
 *   bldHp: Schadensminderung eigener Gebäude (Treffer / bldHp)
 *   cost: { Kategorie: Faktor } auf Einheitenkosten          cloakReveal: Faktor auf die Enttarnungsdauer nach eigener Aktion
 *   detectCut: gegnerische Detektoren decken eigene getarnte Objekte erst um so viele Kacheln näher auf (Radius mindestens 1 Kachel)
 * D.RESEARCH_ORDER = Anzeigereihenfolge; D.researchList(fraktion) → IDs dieser Fraktion in Anzeigereihenfolge. */
(function () {
  'use strict';
  var D = G.DATA;
  D.SAVE_VERSION = 3;   // 3 = v1.3 (Forschung: P.res)
  D.RESEARCH_BUILDING = 'techcenter';
  var R = D.RESEARCH = {};
  function add(id, name, cost, time, desc, fx, extra) { var r = R[id] = { id: id, name: name, cost: cost, time: time, desc: desc, fx: fx, tier: 1 }; for (var k in extra) r[k] = extra[k]; }
  var ARMORED = ['vehicle', 'naval'];
  // ---- gemeinsamer Kern
  add('armor1', 'Verbundpanzerung I', 800, 40, 'Fahrzeuge und Schiffe erleiden 10 % weniger Schaden', { unit: [{ cat: ARMORED, hp: 1.10 }] });
  add('armor2', 'Verbundpanzerung II', 1400, 60, 'Fahrzeuge und Schiffe erleiden weitere 10 % weniger Schaden', { unit: [{ cat: ARMORED, hp: 1.10 }] }, { req: 'armor1', tier: 2 });
  add('fire1', 'Feuerkraft I', 800, 40, 'Alle Einheiten richten 8 % mehr Schaden an', { unit: [{ all: true, dmg: 1.08 }] });
  add('fire2', 'Feuerkraft II', 1400, 60, 'Alle Einheiten richten weitere 8 % mehr Schaden an', { unit: [{ all: true, dmg: 1.08 }] }, { req: 'fire1', tier: 2 });
  add('harv', 'Großraumlader', 700, 35, 'Sammler laden 25 % mehr Erz je Fahrt', { harvCap: 1.25 });
  add('optics', 'Fernoptik', 500, 30, 'Einheiten und Gebäude sehen 1 Kachel weiter', { sight: 1 });
  add('repair', 'Instandsetzung', 600, 30, 'Gebäudereparatur und Reparaturdock arbeiten 60 % schneller und 25 % günstiger', { repair: 1.6, repairCost: 0.75 });
  // ---- Koalition: Präzision / Luft
  add('c_calc', 'Zielrechner', 1000, 45, 'Fahrzeuge und Schiffe laden 12 % schneller nach', { unit: [{ cat: ARMORED, rof: 0.88 }] }, { faction: 'coalition' });
  add('c_ammo', 'Präzisionsmunition', 900, 45, 'Scharfschützen, Jagdpanzer und Haubitzen richten 18 % mehr Schaden an', { unit: [{ types: ['sniper', 'hunter', 'howitzer'], dmg: 1.18 }] }, { faction: 'coalition' });
  add('c_air', 'Luftüberlegenheit', 1000, 45, 'Luftfahrzeuge und Trägerjäger: 15 % mehr Schaden, 15 % weniger Schaden erlitten', { unit: [{ cat: 'air', dmg: 1.15, hp: 1.15 }, { types: ['carrier'], dmg: 1.15 }] }, { faction: 'coalition' });
  // ---- Syndikat: billig / robust
  add('s_mass', 'Fließbandfertigung', 1000, 45, 'Infanterie kostet 15 % weniger', { cost: { infantry: 0.85 } }, { faction: 'syndicate' });
  add('s_wall', 'Bollwerk', 900, 45, 'Eigene Gebäude erleiden 15 % weniger Schaden', { bldHp: 1.15 }, { faction: 'syndicate' });
  add('s_patch', 'Feldinstandsetzung', 1000, 50, 'Fahrzeuge reparieren sich außerhalb des Gefechts langsam selbst', { unit: [{ cat: 'vehicle', regen: 0.008 }] }, { faction: 'syndicate' });
  // ---- Kollektiv: Psi / Schwarm / Tarnung
  add('k_psi', 'Psi-Fokus', 1000, 45, 'Psi-Kräfte laden 20 % schneller nach (Gedankenkontrolle, Lähmung)', { unit: [{ all: true, psi: 0.80 }, { types: ['psidrone'], rof: 0.80 }] }, { faction: 'kollektiv' });
  add('k_swarm', 'Schwarmbrut', 900, 45, 'Schwarmdrohnen: 25 % mehr Schaden und Haltbarkeit; Mutanten 15 % robuster', { unit: [{ types: ['swarmcarrier'], dmg: 1.25 }, { types: ['swarmling'], hp: 1.25 }, { types: ['brute'], hp: 1.15 }] }, { faction: 'kollektiv' });
  add('k_veil', 'Phasenschleier', 800, 40, 'Getarntes ist nach einer Aktion nur halb so lang sichtbar; gegnerische Detektoren reichen 1 Kachel kürzer', { cloakReveal: 0.5, detectCut: 1 }, { faction: 'kollektiv' });
  D.RESEARCH_ORDER = ['armor1', 'armor2', 'fire1', 'fire2', 'harv', 'optics', 'repair', 'c_calc', 'c_ammo', 'c_air', 's_mass', 's_wall', 's_patch', 'k_psi', 'k_swarm', 'k_veil'];
  D.researchList = function (fac) { return D.RESEARCH_ORDER.filter(function (id) { var r = R[id]; return !r.faction || r.faction === fac; }); };
})();

/* ---- v1.3 Spezialfähigkeiten – eigener Block (Sim: sim.js Abschnitt „v1.3 FÄHIGKEITEN“ am Dateiende) ----
 * Aktive Fähigkeiten einzelner Einheitentypen, vom Spieler per Knopf ausgelöst (G.cmd.ability), mit Abklingzeit je Einheit.
 * Je Einheitentyp UND Fraktion höchstens EINE Fähigkeit (D.abilityOf(fraktion, typ)); maßgeblich ist die Herkunftsfraktion der Einheit.
 * D.ABILITIES[id] = { id, name, desc, faction, units: [Typen], cd (s Abklingzeit), dur (s Wirkdauer, 0 = sofort),
 *   target: 'none' (sofort, alle bereiten Einheiten der Auswahl) | 'point' (Zielpunkt) | 'enemy' (gegnerische Einheit/Gebäude)
 *           – bei point/enemy löst EINE bereite Einheit in Reichweite aus (die nächste am Ziel),
 *   range (Kacheln, nur mit Ziel), gcd (s gemeinsame Sperre aller eigenen Einheiten mit dieser Fähigkeit nach einer Auslösung),
 *   req (Forschungs-ID als Voraussetzung), boost { res: Forschungs-ID, dur | cd: neuer Wert mit dieser Forschung }, psiCd (Abklingzeit × Psi-Faktor aus mods),
 *   toggle (erneutes Auslösen beendet die laufende Wirkung vorzeitig), look (Darstellung: Farbe/Art für die Renderer),
 *   fx: GENAU EINE Wirkungsart:
 *     self  { dmg, hp, rof, speed (Faktoren; hp = Treffer / hp), regen (Anteil maxHp/s, auch im Gefecht), root (bool: kann sich nicht bewegen) }
 *     zone  { r (Kacheln), ally { hp (Faktor), cloak (bool: getarnt) }, enemy { dps (Flammenschaden/s an Bodeneinheiten) } }   – Feld am Zielpunkt
 *     mark  { vuln (Schadensfaktor auf das Ziel), reveal (bool: getarntes Ziel bleibt sichtbar) }
 *     pulse { r (Kacheln), stun (s Lähmung gegnerischer Bodeneinheiten im Umkreis) }
 *     jump  true   – die Einheit versetzt sich an den Zielpunkt }
 * D.ABILITY_RANK_CD = Abklingzeit-Nachlass je Erfahrungsrang (Anteil). */
(function () {
  'use strict';
  var D = G.DATA;
  D.SAVE_VERSION = 4;   // 4 = v1.3 Teil 2 (Fähigkeiten: S.zones, P.abG, Einheit ab/abT/abCd)
  D.ABILITY_RANK_CD = 0.05;
  var A = D.ABILITIES = {};
  function add(id, faction, units, name, cd, dur, target, desc, fx, extra) {
    var a = A[id] = { id: id, faction: faction, units: units, name: name, cd: cd, dur: dur, target: target, desc: desc, fx: fx, look: 'buff' };
    for (var k in extra) a[k] = extra[k];
  }
  // ---- Koalition: Präzision / Luft / Technik
  add('c_mark', 'coalition', ['sniper'], 'Zielmarkierung', 35, 10, 'enemy', 'Markiert ein gegnerisches Ziel: 10 s aufgedeckt, erleidet 15 % mehr Schaden',
      { mark: { vuln: 1.15, reveal: true } }, { range: 10, look: 'mark' });
  add('c_salvo', 'coalition', ['tank'], 'Feuerstoß', 45, 6, 'none', 'Lädt 6 s lang deutlich schneller nach (8 s mit Zielrechner)',
      { self: { rof: 0.72 } }, { boost: { res: 'c_calc', dur: 8 }, look: 'attack' });
  add('c_smoke', 'coalition', ['scout'], 'Nebelwand', 45, 10, 'point', 'Nebelfeld am Zielpunkt: eigene Einheiten darin erleiden ein Viertel weniger Schaden',
      { zone: { r: 2.5, ally: { hp: 1.33 } } }, { range: 7, gcd: 10, look: 'smoke' });
  add('c_flare', 'coalition', ['gunship'], 'Täuschkörper', 30, 5, 'none', 'Wirft Täuschkörper ab: 5 s lang 60 % weniger Schaden',
      { self: { hp: 2.5 } }, { look: 'shield' });
  // ---- Syndikat: robust / billig / Masse
  add('s_dig', 'syndicate', ['rifle'], 'Eingraben', 30, 20, 'none', 'Gräbt sich 20 s ein: 45 % weniger Schaden, aber unbeweglich. Erneut tippen oder Fahrbefehl beendet es',
      { self: { hp: 1.8, root: true } }, { toggle: true, look: 'shield' });
  add('s_rush', 'syndicate', ['raider'], 'Nachbrenner', 35, 5, 'none', '5 s lang 60 % schneller und 30 % mehr Schaden',
      { self: { speed: 1.6, dmg: 1.3 } }, { look: 'attack' });
  add('s_fire', 'syndicate', ['flamer'], 'Brandteppich', 45, 8, 'point', 'Setzt eine Fläche 8 s in Brand – schädigt gegnerische Bodeneinheiten darin',
      { zone: { r: 2, enemy: { dps: 13 } } }, { range: 5, gcd: 10, look: 'fire' });
  add('s_fix', 'syndicate', ['tank', 'colossus'], 'Notreparatur', 60, 6, 'none', 'Repariert in 6 s 30 % der Panzerung – auch im Gefecht (benötigt Feldinstandsetzung)',
      { self: { regen: 0.05 } }, { req: 's_patch', look: 'heal' });
  // ---- Kollektiv: Psi / Schwarm / Tarnung
  add('k_shriek', 'kollektiv', ['psiadept'], 'Psi-Schrei', 50, 0, 'none', 'Lähmt gegnerische Bodeneinheiten im Umkreis 3 s (lädt mit Psi-Fokus schneller nach)',
      { pulse: { r: 3.5, stun: 3 } }, { psiCd: true, look: 'psi' });
  add('k_frenzy', 'kollektiv', ['brute'], 'Raserei', 30, 6, 'none', '6 s lang 50 % schneller und viel schnellere Angriffe',
      { self: { speed: 1.5, rof: 0.6 } }, { look: 'attack' });
  add('k_jump', 'kollektiv', ['tank'], 'Phasensprung', 30, 0, 'point', 'Versetzt den Schwebepanzer sofort an einen freien Zielpunkt in der Nähe',
      { jump: true }, { range: 6, look: 'psi' });
  add('k_shroud', 'kollektiv', ['rifle'], 'Schleierfeld', 60, 8, 'point', 'Eigene Einheiten im Feld sind 8 s getarnt, solange sie nicht feuern (11 s mit Phasenschleier)',
      { zone: { r: 2.5, ally: { cloak: true } } }, { range: 6, gcd: 20, boost: { res: 'k_veil', dur: 11 }, look: 'veil' });
  D.ABILITY_ORDER = ['c_mark', 'c_salvo', 'c_smoke', 'c_flare', 's_dig', 's_rush', 's_fire', 's_fix', 'k_shriek', 'k_frenzy', 'k_jump', 'k_shroud'];
  var IDX = {};
  D.ABILITY_ORDER.forEach(function (id) { var a = A[id]; a.units.forEach(function (t) { IDX[a.faction + ':' + t] = a; }); });
  /** Fähigkeit des Einheitentyps type der Fraktion fac oder null. */
  D.abilityOf = function (fac, type) { return IDX[fac + ':' + type] || null; };
})();
