/* FRONTLINIE – ui.js  (v0.3: kompaktes HUD, Kontext-Befehlsleiste, Bau-Sheet, Karten-Auswahl, Hilfe)
 * G.UI: DOM-HUD (obere Leiste, Produktions-Sheet mit Tabs/Kacheln, Kontext-Befehlsleiste, Auswahl-Info,
 * Platzierungs-/Zielleiste, Meldungen), Start-, Pause-, Hilfe- und Endbildschirm.
 * Verändert die Simulation ausschließlich über G.cmd.* bzw. G.Input-/G.Main-Funktionen.
 *
 * Öffentliche Schnittstelle:
 *   init()            einmalig (baut statische DOM-Teile)
 *   update(dt)        pro Frame (HUD intern auf ~10 Hz gedrosselt, Overlay jeden Frame)
 *   onGameStart()     nach Start/Fortsetzen
 *   onSelection()     nach Auswahländerung (sofortige Aktualisierung)
 *   onPause(paused)   Pause-Overlay
 *   showStart(), showEnd(), showHelp(), hideHelp(), toggleHelp()
 *   toast(text, bad, onTap)   kurze Meldung (onTap: Meldung wird antippbar, z. B. Kamera zur Basis)
 *   setHint(text, x, y)       Maus-Hinweis am Zeiger (Desktop)
 * v0.5: Reiter Verteidigung (Mauer/Bunker/Fraktionsturm), Mauer-Modus + Bauhof-„Aufbauen“ (Platzierungsleiste), Lautsprecher-Knopf (#btnMute),
 *       Regler Musik/Effekte/Ansagen in Start- und Pausemenü, UI-Ansagen (noMoney/buildStart) über G.Audio.say – alles tolerant gegen fehlendes G.Audio.
 * v0.7: Grafik-Menü „Kamera: Diagonal / Gerade“ (G.view.setCamMode, localStorage 'frontlinie.cam', wirkt sofort), Startoption
 *       „Friedenszeit: Aus / 5 / 10 / 15 Minuten“ (opts.peace, Standard 5), Countdown „Frieden m:ss“ in der oberen Leiste solange G.Sim.peaceLeft() > 0,
 *       Ereignis peaceOver → Meldung. Neue Einheiten erscheinen automatisch aus UNIT_ORDER (Fraktionsfilter über unitStats bzw. Feld faction);
 *       Schützenpanzer mit Passagieren: Knopf „Aussteigen (n)“ (G.Input.unloadSel → G.cmd.unload). Hilfe: neue Einheiten, Kamera, Friedenszeit.
 * Liest: G.Sim.S (players[pid].credits/pwrProd/pwrUse/q/alert/st, tick, events, over/winner), G.view,
 *        Gebäude-Felder des Vertrags SPEC_v03 (neutral, gar, cap, ruin, capT, capBy, charge) – alle optional.
 */
var G = (typeof G !== 'undefined') ? G : {};
(function () {
  'use strict';
  var D = G.DATA, V, TILE = D.TILE;
  var $ = function (id) { return document.getElementById(id); };
  var tileEls = {}, curTab = 'building', tilesFor = '', acc = 0, lastSel = '', lastEvSeq = 0, lastAlert = -9999, lastAlertSeen = -9999;
  var swFoes = {}, swAlert = null, swSig = '', swEls = {}, qSig = '', qEls = [], engTipShown = false;
  var muteShown = null, artyReady = {}, ovCtx = null, ovW = 0, ovH = 0, ovDirty = false, fine = false;
  var opts = { faction: 'coalition', aiFaction: 'random', mapId: 'flussgabel', diff: 'easy', speed: 'normal', fogOff: false, peace: 5 };   // v1.0: aiFaction 'random' | Fraktions-ID; v1.0.1 KI-Leicht: Standard „Leicht“
  // v1.0.1 KI-Leicht: Stufen der KI (Startbildschirm, Pause) mit Kurzbeschreibung
  var DIFFS = [['veryeasy', 'Sehr leicht'], ['easy', 'Leicht'], ['medium', 'Mittel'], ['hard', 'Schwer']];
  var DIFF_HELP = { veryeasy: 'Zum Kennenlernen: kleine, seltene Angriffe ab 12 Minuten.', easy: 'Für Gelegenheitsspieler: kleine Angriffswellen, die KI zieht sich bei Verlusten zurück.',
                    medium: 'Fordernd: größere Wellen, Luftwaffe, Superwaffe.', hard: 'Für Erfahrene: schnelle, große Angriffe und mehr Erz.' };
  function diffName(d) { for (var i = 0; i < DIFFS.length; i++) if (DIFFS[i][0] === d) return DIFFS[i][1]; return 'Mittel'; }
  var peaceShown = null, peaceOverShown = false;
  var capShown = -1, capToastT = -1e9, mineToastT = -1e9;   // v1.2 Erzlager-Anzeige, Minen-Hinweis
  /** v0.7: Restzeit der Friedenszeit in Sekunden (0, wenn G.Sim.peaceLeft fehlt oder vorbei). */
  function peaceLeft() { try { return (G.Sim.peaceLeft && +G.Sim.peaceLeft()) || 0; } catch (e) { return 0; } }

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fmtTime(t) { var s = Math.floor(t / D.TICK_HZ), m = Math.floor(s / 60); s %= 60; return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s; }
  function fmtNum(n) { return Math.floor(n).toLocaleString('de-DE'); }
  /** Ansage über G.Audio (tolerant; eigener Cooldown zusätzlich zu dem im Audio-Modul). */
  var sayLast = {};
  function say(key, cd) {
    try { var t = performance.now(); if (t - (sayLast[key] || -1e9) < (cd || 6000)) return; sayLast[key] = t; if (G.Audio && G.Audio.say) G.Audio.say(key); } catch (e) { /* Ton optional */ }
  }
  function vib(p) { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) { /* egal */ } }

  // ------------------------------------------------------------------ Symbole (Inline-SVG, 24er Raster)
  var IC = {
    pause: '<path class="f" d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    stop: '<rect class="f" x="6" y="6" width="12" height="12" rx="2"/>',
    attack: '<circle cx="12" cy="12" r="6.5"/><path d="M12 2.5v5M12 16.5v5M2.5 12h5M16.5 12h5"/>',
    frame: '<rect x="4" y="5" width="16" height="14" rx="1" stroke-dasharray="3.5 3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    army: '<path d="M12 3l2.6 5.6 6 .8-4.4 4.2 1.1 6-5.3-3-5.3 3 1.1-6L3.4 9.4l6-.8z"/>',
    idle: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
    building: '<path d="M3 20V10l6 3V10l6 3V5h4v15zM3 20h18"/>',
    defense: '<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"/><path d="M9 12l2.2 2.2L15.5 10"/>',
    infantry: '<path d="M5 12a7 7 0 0 1 14 0zM4 12h16v2.5H4zM8 18c1.2 2 6.8 2 8 0"/>',
    vehicle: '<rect x="3" y="14" width="18" height="5" rx="2.5"/><path d="M7 14v-4h8v4M15 11.5h6"/>',
    air: '<path d="M3 13l8-2V5.5a1 1 0 0 1 2 0V11l8 2v2l-8-1.2V18l2.5 1.6V21L12 20l-3.5 1v-1.4L11 18v-4.2L3 15z"/>',   // v0.8
    naval: '<path d="M3 15h18l-2.5 4.5H5.5zM6 15v-3h9v3M9 12V8h4v4M11 8V4"/>',                                   // v0.8
    up: '<path d="M6 15l6-6 6 6"/>',
    down: '<path d="M6 9l6 6 6-6"/>',
    enter: '<path d="M5 21V4h9v17M3 21h18"/><circle class="f" cx="11.5" cy="13" r="1.2"/>',
    exit: '<path d="M14 4h6v16h-6M10 8l-4 4 4 4M6 12h10"/>',
    arty: '<circle cx="12" cy="12" r="3.8"/><path d="M12 2v4.5M12 17.5V22M2 12h4.5M17.5 12H22M5 5l3 3M16 16l3 3M19 5l-3 3M8 16l-3 3"/>',
    sell: '<circle cx="12" cy="12" r="8.5"/><path d="M15 9.4c-.6-.9-1.6-1.4-2.9-1.4-1.7 0-3 1-3 2.3 0 3.1 6 1.6 6 4.5 0 1.3-1.3 2.3-3.1 2.3-1.3 0-2.4-.5-3-1.5M12 6v12"/>',
    repair: '<path d="M14.5 4.5a4.2 4.2 0 0 0 5 5.4L10.8 18.6a2.2 2.2 0 0 1-3.1-3.1l8.7-8.7z"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.3 9.4a2.8 2.8 0 1 1 3.9 2.5c-.8.4-1.2 1-1.2 1.9M12 17.2h.01"/>',
    flag: '<path d="M6 21V4M6 5h12l-3 4 3 4H6"/>',
    orbital: '<circle cx="12" cy="17" r="3.2"/><path d="M12 2v8.5M9 6l3 3.5L15 6M5 21h14"/>',
    missile: '<path d="M12 2c2.6 2.4 3.6 5.6 3.6 9v6h-7.2v-6c0-3.4 1-6.6 3.6-9zM8.4 14l-3 3.5v2.5l3-1.5M15.6 14l3 3.5v2.5l-3-1.5M12 18v4"/>',
    psi: '<circle cx="12" cy="12" r="3"/><path d="M12 3a9 9 0 0 1 9 9M3 12a9 9 0 0 1 9-9M12 21a9 9 0 0 1-9-9M21 12a9 9 0 0 1-9 9M7 12a5 5 0 0 1 5-5M17 12a5 5 0 0 1-5 5"/>',   // v1.0 Psi-Welle
    speaker: '<path class="f" d="M4 9.5v5h3.5l4.5 4v-13l-4.5 4z"/><path d="M15.5 9.2a4.2 4.2 0 0 1 0 5.6M18.2 6.5a8 8 0 0 1 0 11"/>',
    speakerOff: '<path class="f" d="M4 9.5v5h3.5l4.5 4v-13l-4.5 4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
    wall: '<path d="M3 6h18v12H3zM3 12h18M9 6v6M15 12v6"/>',
    warn: '<path d="M12 3.5l9.5 16.5h-19zM12 10v4.5M12 17.2h.01"/>',
    // v1.2: Sprengladung, lahmlegen (Blitz), Drohnen
    bomb: '<circle cx="11" cy="14.5" r="6.2"/><path d="M15.2 9.8l2.3-2.3M17.5 7.5c.3-1.8 1.6-2.8 3.2-2.6M20.5 2.6v.01M22 6.5v.01"/>',
    bolt: '<path d="M13.5 2.5L5 13.5h6l-1.5 8L18.5 10h-6z"/>',
    drone: '<circle cx="12" cy="12" r="2.6"/><path d="M12 9.4V5M12 14.6V19M9.4 12H5M14.6 12H19M3 5h4M17 5h4M3 19h4M17 19h4"/>',
    // v1.3 Forschung: Kolben
    flask: '<path d="M9.5 3h5M10.5 3v6.2L5 18.6a1.6 1.6 0 0 0 1.4 2.4h11.2a1.6 1.6 0 0 0 1.4-2.4L13.5 9.2V3M7.6 15h8.8"/>'
  };
  function ic(n) { return '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">' + IC[n] + '</svg>'; }

  // ------------------------------------------------------------------ Neutrale / Spezialgebäude (Anzeigetexte; Namen aus G.DATA haben Vorrang)
  var NEUTRAL = {
    house: { name: 'Wohnhaus', fx: 'Deckung für Infanterie' },
    block: { name: 'Wohnblock', fx: 'Deckung für Infanterie' },
    bunker: { name: 'Bunker', fx: 'Deckung für Infanterie, +2 Reichweite' },
    oilrig: { name: 'Ölbohrturm', fx: '+12 Credits/s für den Besitzer' },
    radar: { name: 'Radarstation', fx: 'Sicht 14 Kacheln, Gegner auf der Minimap sichtbar' },
    hospital: { name: 'Feldlazarett', fx: 'Heilt eigene Infanterie im Umkreis (5 HP/s)' },
    workshop: { name: 'Werkstatt', fx: 'Repariert eigene Fahrzeuge im Umkreis (15 HP/s)' },
    artillery: { name: 'Artilleriestellung', fx: 'Artillerieschlag: 6 Granaten, Reichweite 30 Kacheln' },
    tradepost: { name: 'Handelsposten', fx: 'Fahrzeuge 10 % günstiger (höchstens 2 Posten zählen)' }   // v1.2
  };
  // v1.0: Namen je Fraktion (Kollektiv: „Psi-Reaktor“, „Klonlabor“ …); owner = Besitzer (Standard: eigener Spieler)
  function facOfOwner(owner) { var S = G.Sim.S, p = S && S.players[owner != null && owner >= 0 ? owner : V.pid]; return p ? p.faction : 'coalition'; }
  function bName(type, owner) { if (NEUTRAL[type] && !D.BUILDINGS[type]) return NEUTRAL[type].name; if (D.BUILDINGS[type] && D.BUILDINGS[type].neutral) return D.BUILDINGS[type].name; return D.BUILDINGS[type] ? D.bName(type, facOfOwner(owner)) : ((NEUTRAL[type] && NEUTRAL[type].name) || String(type)); }
  function uName(type, fac) { return D.uName(type, fac || facOfOwner()); }

  // ------------------------------------------------------------------ Meldungen
  function toast(text, bad, onTap) {
    var box = $('toasts');
    var el = document.createElement('div');
    el.className = 'toast' + (bad ? ' bad' : '') + (onTap ? ' act' : '');
    el.textContent = text;
    if (onTap) el.addEventListener('click', function () { onTap(); if (el.parentNode) el.parentNode.removeChild(el); });
    box.appendChild(el);
    while (box.children.length > 3) box.removeChild(box.firstChild);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, onTap ? 5000 : 2800);
  }
  function setHint(text, x, y) {
    var h = $('hint');
    if (!text) { h.style.display = 'none'; return; }
    h.textContent = text; h.style.display = 'block';
    var w = h.offsetWidth || 120;
    h.style.left = Math.max(4, Math.min(V.vw - w - 4, x + 20)) + 'px'; h.style.top = Math.max(4, y + 22) + 'px';
  }

  // ------------------------------------------------------------------ Langdruck-Helfer
  function pressable(el, onTap, onLong) {
    var t = null, fired = false;
    el.addEventListener('pointerdown', function (ev) {
      if (ev.button === 2) return;
      fired = false;
      t = setTimeout(function () { fired = true; t = null; onLong && onLong(); }, 550);
    });
    function clear() { if (t) { clearTimeout(t); t = null; } }
    el.addEventListener('pointerup', function (ev) { if (ev.button === 2) return; if (t) { clear(); if (!fired) onTap(); } });
    el.addEventListener('pointercancel', clear);
    el.addEventListener('pointerleave', clear);
    el.addEventListener('contextmenu', function (ev) { ev.preventDefault(); if (onLong) onLong(); });
  }

  // ------------------------------------------------------------------ Ton: Schnellknopf + Regler
  function audioOn() { return !!(G.Audio && G.Audio.getVolume); }
  function refreshMute() {
    if (!audioOn()) return;
    var m = !!G.Audio.isMuted(), b = $('btnMute');
    b.innerHTML = ic(m ? 'speakerOff' : 'speaker'); b.classList.toggle('muted', m);
    b.setAttribute('aria-label', m ? 'Ton einschalten' : 'Ton ausschalten'); b.setAttribute('aria-pressed', m ? 'true' : 'false');
    Array.prototype.forEach.call(document.querySelectorAll('[data-mute]'), function (x) { x.innerHTML = ic(m ? 'speakerOff' : 'speaker') + '<span>' + (m ? 'Ton ist aus' : 'Ton ist an') + '</span>'; x.classList.toggle('muted', m); });
  }
  var VOLS = [['music', 'Musik'], ['sfx', 'Effekte'], ['voice', 'Ansagen']];
  /** Ton-Block für Start- und Pausemenü (keine IDs: beide Menüs können gleichzeitig im DOM sein). */
  function audioOpt() {
    if (!audioOn()) return '';
    var h = '<div class="opt"><div class="lbl">Ton</div><button class="tonebtn" data-mute></button>';
    VOLS.forEach(function (v) {
      var val = Math.round((+G.Audio.getVolume(v[0]) || 0) * 100);
      h += '<label class="vol"><span class="vn">' + v[1] + '</span><input type="range" min="0" max="100" step="5" value="' + val + '" data-vol="' + v[0] + '" aria-label="' + v[1] + '"><span class="vv">' + val + ' %</span></label>';
    });
    return h + '</div>';
  }
  function bindAudio(root) {
    if (!audioOn()) return;
    Array.prototype.forEach.call(root.querySelectorAll('input[data-vol]'), function (inp) {
      inp.addEventListener('input', function () {
        G.Audio.setVolume(inp.dataset.vol, (+inp.value) / 100);
        inp.parentNode.querySelector('.vv').textContent = inp.value + ' %';
      });
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-mute]'), function (b) { b.onclick = function () { G.Audio.setMuted(!G.Audio.isMuted()); refreshMute(); }; });
    refreshMute();
  }

  // ------------------------------------------------------------------ Statische Teile
  function init() {
    V = G.view;
    fine = !!(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches);
    try { var o = JSON.parse(localStorage.getItem('frontlinie.opts')); if (o) for (var k in o) opts[k] = o[k]; } catch (e) { /* egal */ }
    if ([0, 5, 10, 15].indexOf(+opts.peace) < 0) opts.peace = 5; else opts.peace = +opts.peace;
    if (!D.FACTIONS[opts.faction]) opts.faction = 'coalition';                               // v1.0
    if (opts.aiFaction !== 'random' && !D.FACTIONS[opts.aiFaction]) opts.aiFaction = 'random';
    if (!DIFF_HELP[opts.diff]) opts.diff = 'easy';   // v1.0.1 KI-Leicht
    ovCtx = $('ov').getContext('2d');
    $('btnPause').innerHTML = ic('pause'); $('btnMenu').innerHTML = ic('menu');
    var bm = $('btnMute');
    if (G.Audio && G.Audio.isMuted) { bm.onclick = function () { G.Audio.setMuted(!G.Audio.isMuted()); refreshMute(); }; refreshMute(); } else bm.style.display = 'none';
    $('btnPause').onclick = function () { if (V.running) G.Main.togglePause(); };
    $('btnMenu').onclick = function () { if (V.running) G.Main.setPaused(true); };
    $('placeNo').innerHTML = ic('close');
    $('placeOk').onclick = function () {
      if (V.arty) { G.Input.artyFire(); return; }
      var pl = V.placing, special = !!(pl && (pl.wall || pl.deploy));
      if (G.Input.confirmPlacement() && !special) toast('Gebäude gesetzt');   // Mauer/Bauhof melden selbst
    };
    $('placeNo').onclick = function () { if (V.arty) G.Input.cancelArty(); else G.Input.cancelPlacement(); };
    $('placeNo').setAttribute('aria-label', 'Abbrechen');
    // Tabs
    var tabs = $('tabs');
    ['building', 'defense', 'infantry', 'vehicle', 'air', 'naval'].forEach(function (cat) {   // v0.8: air/naval erscheinen erst mit Flugfeld/Werft
      var b = document.createElement('button');
      b.innerHTML = ic(cat) + '<span class="tl">' + D.CAT_NAMES[cat] + '</span><i class="dot"></i>';
      b.dataset.cat = cat; b.setAttribute('aria-label', D.CAT_NAMES[cat]);
      b.onclick = function () { curTab = cat; V.tab = cat; buildTiles(); };
      tabs.appendChild(b);
    });
    // v0.9.2 Reparatur: dauerhafter Knopf „Reparieren“ (Modus), Leiste #repbar mit „Alle beschädigten reparieren“
    var rb = $('btnRepair');   // sitzt in #map direkt unter der Minimap (immer sichtbar, in allen Layouts gleich)
    rb.innerHTML = ic('repair') + '<span class="tl">Reparieren</span>'; rb.setAttribute('aria-label', 'Reparieren (R)'); rb.title = 'Reparieren (R)';
    rb.onclick = function () { if (V.running) G.Input.toggleRepairMode(); };
    $('repbar').addEventListener('click', function (ev) {
      var t = ev.target.closest('button'); if (!t) return;
      if (t.dataset.act === 'repairall') G.Input.repairAll(); else if (t.dataset.act === 'repairend') G.Input.toggleRepairMode(false);
    });
    $('repbar').querySelector('[data-act="repairall"]').insertAdjacentHTML('afterbegin', ic('repair'));
    $('repbar').querySelector('[data-act="repairend"]').insertAdjacentHTML('afterbegin', ic('close'));
    var ex = document.createElement('button');
    ex.id = 'expand'; ex.innerHTML = ic('up'); ex.setAttribute('aria-label', 'Bauleiste erweitern');
    ex.onclick = function () { var s = $('side'); s.classList.toggle('expanded'); ex.innerHTML = ic(s.classList.contains('expanded') ? 'down' : 'up'); };
    tabs.appendChild(ex);
    // Delegation für Befehlsleiste und Auswahl-Info
    $('cmdbar').addEventListener('click', onCmdClick);
    $('selinfo').addEventListener('click', onCmdClick);
    // Tastenhinweise (nur Desktop sichtbar)
    $('hotkeys').innerHTML = '<b>Maus:</b> Links wählen / Rahmen, Rechts Befehl, Rad Zoom<br><b>Tasten:</b> WASD Karte · 1–3 Gruppe (Strg+Zahl speichern) · <b>A</b> Angriff · <b>S</b> Stopp · <b>E</b> Aussteigen · <b>F</b> Artillerie · <b>X</b> Superwaffe · <b>R</b> Reparieren · <b>T</b> Forschung · <b>D</b> Bauhof aufbauen · <b>Leertaste</b> Pause · <b>Esc</b> Abbruch · <b>H</b> Hilfe';
    window.addEventListener('resize', function () { ovW = 0; });
    $('swstack').addEventListener('click', onSwStack);
    $('swalert').addEventListener('click', function () { if (swAlert) G.Main.jumpTo(swAlert.x, swAlert.y); });
  }

  // v1.0: Meldungen zur Gedankenkontrolle (gedrosselt: höchstens alle 4 s je Art)
  var mcT = {};
  function mcToast(ev) {
    var now = Date.now(), k, msg, bad = false, nm = uName(ev.type, (G.Sim.get(ev.id) || {}).fac);
    if (ev.on && ev.prev === V.pid) { k = 'lost'; msg = nm + ' wurde übernommen (Psi)'; bad = true; }
    else if (ev.on && ev.owner === V.pid) { k = 'gain'; msg = ev.perm ? 'Psi-Welle: Einheiten übernommen' : nm + ' übernommen'; }
    else if (!ev.on && ev.owner === V.pid) { k = 'back'; msg = nm + ' ist wieder frei'; }
    else if (!ev.on && ev.prev === V.pid) { k = 'free'; msg = 'Kontrolle über ' + nm + ' verloren'; bad = true; }
    else return;
    if (now - (mcT[k] || 0) < 4000) return;
    mcT[k] = now; toast(msg, bad);
    if (bad) vib(40);
  }
  function onCmdClick(ev) {
    var b = ev.target.closest('button'); if (!b || b.disabled) return;
    var act = b.dataset.act, id = +b.dataset.id;
    switch (act) {
      case 'army': G.Input.selectArmy(); break;
      case 'idle': G.Input.selectIdle(); break;
      case 'stop': G.Input.stopSel(); break;
      case 'am': G.Input.toggleAttackMove(); if (!V.amArmed) toast('Erst Einheiten wählen', true); break;
      case 'box': G.Input.toggleBoxMode(); if (V.boxMode) toast('Rahmen: Auf der Karte ziehen'); break;
      case 'add': G.Input.toggleAddMode(); break;
      case 'sell': if (G.cmd.sell(V.pid, id).ok) { toast('Verkauft'); G.Input.deselect(); } break;
      case 'repair': G.cmd.repair(V.pid, id); break;
      case 'desel': G.Input.deselect(); break;
      case 'exit': G.Input.exitSel(); break;
      case 'unload': G.Input.unloadSel(); break;
      case 'repgo': G.Input.repairSel(); break;   // v1.2: zur Reparatur
      case 'sabmode': G.Input.sabToggle(); break; // v1.2: Saboteur-Modus
      case 'research': toggleResearch(); break;   // v1.3 Forschung
      case 'deploy': G.Input.beginDeploy(); break;
      case 'arty': if (V.arty) G.Input.cancelArty(); else G.Input.beginArty(); break;
      case 'sw': swPress(id); break;
      case 'narrow': G.Input.selectType(b.dataset.type); break;
      case 'help': showHelp(); break;
    }
    lastSel = '';
  }

  // ------------------------------------------------------------------ Produktions-Sheet
  function typesFor(cat) {
    var S = G.Sim.S, fac = S.players[V.pid].faction;
    // v0.4: Gebäude fremder Fraktion (Orbital-Leitstelle / Raketensilo) werden ausgeblendet
    var mine = function (t) { var f = D.BUILDINGS[t].faction; return !f || f === fac; };
    // v0.5: Verteidigung = Türme, Mauer, Bunker, Fraktionsturm (Flag defense, notfalls isWall bzw. besetzbarer Basisbunker); fehlt ein Typ in BUILD_ORDER, wird er angehängt
    var isDef = function (t) { var d = D.BUILDINGS[t]; return !!(d.defense || d.isWall || (d.kind2 === 'garrison' && !d.neutral)); };
    var order = D.BUILD_ORDER.slice();
    ['wall', 'pbunker', 'laser', 'tesla'].forEach(function (t) { if (D.BUILDINGS[t] && order.indexOf(t) < 0) order.push(t); });
    if (cat === 'building') return order.filter(function (t) { return !isDef(t) && mine(t); });
    if (cat === 'defense') return order.filter(function (t) { return isDef(t) && mine(t); });
    // v0.7: neue Einheiten kommen automatisch aus UNIT_ORDER; Fraktionsfilter über unitStats (null = fremd) und optionales Feld faction ('beide' = beide)
    return D.UNIT_ORDER[cat].filter(function (t) {
      var d = D.UNITS[t]; if (!d) return false;
      if (d.faction && d.faction !== fac && d.faction !== 'beide' && d.faction !== 'both') return false;
      if (!D.unitStats(fac, t)) return false;
      try { G.Sim.costOf(V.pid, t); } catch (e) { return false; }   // Sim kennt den Typ (noch) nicht → keine Kachel statt Dauerfehler
      return true;
    });
  }
  /** v0.8: Verteidigung hat eine eigene Warteschlange (P.q.defense), parallel zu P.q.building. */
  function qCat(cat) { return cat; }
  function isBq(qc) { return qc === 'building' || qc === 'defense'; }   // Gebäude-artige Warteschlangen (ready → platzieren)
  function bqOf(P, type) { return P.q[D.BUILDINGS[type] && D.BUILDINGS[type].defense ? 'defense' : 'building']; }
  var moneyTipShown = false, cheatShown = false;
  function moneyTip(type) {
    if (moneyTipShown) return;
    var P = G.Sim.S.players[V.pid];
    if (P.credits >= G.Sim.costOf(V.pid, type)) return;
    moneyTipShown = true;
    setTimeout(function () { toast('Tipp: Eigenes Gebäude antippen → „Verkaufen“ bringt die Hälfte der Kosten zurück'); }, 1200);
  }
  function buildTiles() {
    var S = G.Sim.S; if (!S) return;
    var box = $('tiles'); box.innerHTML = ''; tileEls = {};
    Array.prototype.forEach.call($('tabs').querySelectorAll('button[data-cat]'), function (b) { b.classList.toggle('cur', b.dataset.cat === curTab); });
    var P = S.players[V.pid];
    typesFor(curTab).forEach(function (type) {
      var name = D.BUILDINGS[type] ? D.bName(type, P.faction) : D.uName(type, P.faction);   // v1.0: Fraktionsnamen
      var el = document.createElement('div');
      el.className = 'tile'; el.dataset.type = type;
      el.innerHTML = '<canvas class="icon" width="128" height="88"></canvas><canvas class="ring" width="96" height="96"></canvas>' +
        '<div class="nm">' + esc(name) + '</div><div class="pr">₵ ' + G.Sim.costOf(V.pid, type) + (D.BUILDINGS[type] && D.BUILDINGS[type].noQueue ? ' je' : '') + '</div><div class="cnt"></div><div class="rd">Bereit</div>';
      try { G.Render.drawIcon(el.querySelector('canvas.icon').getContext('2d'), type, P.color, 128, 88); } catch (e) { /* Icon optional */ }
      pressable(el, function () { tileTap(type); }, function () { tileLong(type); });
      box.appendChild(el);
      tileEls[type] = { el: el, ring: el.querySelector('canvas.ring').getContext('2d'), cnt: el.querySelector('.cnt'), pr: el.querySelector('.pr'), rd: el.querySelector('.rd'), lastWhy: null, lastP: -1, lastN: -1, lastR: -1, lastState: '' };
    });
    box.scrollLeft = 0;
    tilesFor = curTab;
    refreshTiles();
  }
  /** Fertiger (ready) Eintrag dieses Typs in der Gebäude-Warteschlange? */
  function readyCount(P, type) { var n = 0; bqOf(P, type).forEach(function (it) { if (it.type === type && it.ready) n++; }); return n; }
  function tileTap(type) {
    var S = G.Sim.S, P = S.players[V.pid];
    if (!V.running || S.over) return;
    if (D.BUILDINGS[type]) {
      if (D.BUILDINGS[type].noQueue) {                                             // Mauer: kein Warteschlangen-Eintrag → Mauer-Modus (erneut antippen = beenden)
        if (V.placing && V.placing.wall) { G.Input.cancelPlacement(); return; }
        var cw = G.Sim.canProduce(V.pid, type);
        if (!cw.ok) { toast(cw.reason, true); return; }
        if (G.cmd.placeWall && G.Input.beginWall()) toast('Mauer: Auf der Karte von A nach B ziehen');
        else if (!G.cmd.placeWall) toast('Mauern nicht verfügbar', true);
        return;
      }
      if (readyCount(P, type) > 0) { G.Input.beginPlacement(type); return; }   // fertig → platzieren
    }
    var poor = P.credits < G.Sim.costOf(V.pid, type);
    var r = G.cmd.produce(V.pid, type);                                           // sonst: in die Warteschlange
    if (!r.ok) { toast(r.reason, true); if (/Credits|Geld/i.test(r.reason || '')) say('noMoney'); }
    else if (D.BUILDINGS[type]) say(poor ? 'noMoney' : 'buildStart', poor ? 15000 : 1500);
    moneyTip(type);
  }
  function tileLong(type) {
    if (D.BUILDINGS[type] && D.BUILDINGS[type].noQueue) return;
    var S = G.Sim.S, P = S.players[V.pid], q = D.BUILDINGS[type] ? bqOf(P, type) : P.q[D.UNITS[type].cat], refund = 0;
    for (var i = q.length - 1; i >= 0; i--) if (q[i].type === type) { refund = Math.floor(q[i].spent || 0); break; }
    if (G.cmd.cancel(V.pid, type).ok) {
      toast(refund > 0 ? 'Abgebrochen – ₵ ' + fmtNum(refund) + ' erstattet' : 'Abgebrochen');
      if (V.placing && V.placing.type === type && readyCount(P, type) === 0) G.Input.cancelPlacement();
    }
  }
  function refreshTiles() {
    var S = G.Sim.S, P = S.players[V.pid];
    var cat = curTab, qc = qCat(cat), q = P.q[qc], isB = isBq(qc);
    var active = null;                                            // laufender Eintrag (Gebäude: erster nicht fertiger; Einheiten: erster)
    if (isB) { for (var a = 0; a < q.length; a++) if (!q[a].ready) { active = q[a]; break; } } else active = q[0] || null;
    for (var type in tileEls) {
      var t = tileEls[type];
      var cp = G.Sim.canProduce(V.pid, type), can = cp.ok;
      var n = 0, rdy = 0, prog = -1;
      for (var i = 0; i < q.length; i++) if (q[i].type === type) {
        if (isB && q[i].ready) rdy++; else n++;
        if (q[i] === active) prog = q[i].prog;
      }
      var locked = !can && n + rdy === 0;
      var why = locked ? (cp.reason || '') : '';
      if (why !== t.lastWhy) {
        t.lastWhy = why;
        t.pr.textContent = locked ? why.replace(/^Benötigt /, 'erst ') : '₵ ' + G.Sim.costOf(V.pid, type) + (D.BUILDINGS[type] && D.BUILDINGS[type].noQueue ? ' je' : '');
        t.pr.classList.toggle('why', locked);
      }
      var wallOn = !!(D.BUILDINGS[type] && D.BUILDINGS[type].noQueue && V.placing && V.placing.wall);
      t.el.classList.toggle('sel', wallOn);
      var state = (locked ? 'x' : 'c') + (rdy ? 'r' : '');
      if (state !== t.lastState) { t.el.classList.toggle('off', locked); t.el.classList.toggle('ready', rdy > 0); t.lastState = state; }
      if (rdy !== t.lastR) { t.rd.textContent = 'Bereit (' + rdy + ')'; t.lastR = rdy; }
      if (n !== t.lastN) { t.cnt.textContent = n > 0 ? String(n) : ''; t.cnt.style.display = n > 0 ? '' : 'none'; t.lastN = n; }
      var pr = prog < 0 ? -1 : Math.round(prog * 100);
      if (pr !== t.lastP) {
        var c = t.ring; c.clearRect(0, 0, 96, 96);
        if (pr >= 0) {
          c.lineWidth = 9; c.strokeStyle = 'rgba(0,0,0,0.6)';
          c.beginPath(); c.arc(48, 48, 40, 0, 6.283); c.stroke();
          c.strokeStyle = '#fbbf24';
          c.beginPath(); c.arc(48, 48, 40, -Math.PI / 2, -Math.PI / 2 + 6.283 * prog); c.stroke();
        }
        t.lastP = pr;
      }
    }
    renderQueue(P, qc);
    // Hinweis-Punkt an Gebäude-/Verteidigungs-Reiter, wenn dort etwas fertig ist (und der Reiter nicht offen ist)
    var rb = { building: false, defense: false };
    P.q.building.forEach(function (it) { if (it.ready) rb.building = true; });
    P.q.defense.forEach(function (it) { if (it.ready) rb.defense = true; });
    Array.prototype.forEach.call($('tabs').querySelectorAll('button[data-cat]'), function (b) {
      var c = b.dataset.cat; b.classList.toggle('badge', !!rb[c] && c !== curTab);
    });
    airSeaTabs(P);
  }
  /** v0.8: Reiter „Luftwaffe“/„Marine“ nur zeigen, wenn Flugfeld bzw. Werft steht (oder dort produziert wird); verschwindet er, zurück zu „Gebäude“. */
  var tabVis = {};
  function airSeaTabs(P) {
    var S = G.Sim.S;
    [['air', 'airfield'], ['naval', 'shipyard']].forEach(function (cb) {
      var on = G.Sim.hasBuilding(V.pid, cb[1]) || (P.q[cb[0]] && P.q[cb[0]].length > 0);
      if (tabVis[cb[0]] === on) return;
      var first = tabVis[cb[0]] === false && on;
      tabVis[cb[0]] = on;
      var b = $('tabs').querySelector('button[data-cat="' + cb[0] + '"]');
      if (b) b.style.display = on ? '' : 'none';
      if (first && S && S.tick > 0) toast('Neuer Reiter: ' + D.CAT_NAMES[cb[0]]);
      if (!on && curTab === cb[0]) { curTab = 'building'; V.tab = curTab; buildTiles(); }
      $('tabs').classList.toggle('many', !!(tabVis.air || tabVis.naval));
    });
  }
  /** Statuszeile #qinfo: Warteschlange als kleine Symbole; aktiver Eintrag mit Fortschritt, fertige als „Bereit“. */
  function renderQueue(P, qc) {
    var q = P.q[qc], box = $('qinfo'), groups = [], isB = isBq(qc), active = -1, i;
    for (i = 0; i < q.length; i++) {
      var g = groups[groups.length - 1], rd = isB && !!q[i].ready;
      if (!isB && g && g.type === q[i].type) { g.n++; continue; }
      groups.push({ type: q[i].type, n: 1, ready: rd, item: q[i] });
    }
    for (i = 0; i < groups.length; i++) if (!groups[i].ready) { active = i; break; }
    var sig = qc + '|' + groups.map(function (g) { return g.type + g.n + (g.ready ? 'r' : ''); }).join(',') + '|' + active;
    if (sig !== qSig) {
      qSig = sig; qEls = []; box.innerHTML = '';
      if (!groups.length) { box.innerHTML = '<span class="qe">Warteschlange leer</span>'; }
      groups.forEach(function (g, gi) {
        var d = document.createElement('div');
        d.className = 'qc' + (g.ready ? ' rdy' : (gi === active ? ' act' : ''));
        d.innerHTML = '<canvas width="72" height="52"></canvas><span class="qt"></span>' + (gi === active ? '<span class="qb"><i></i></span>' : '');
        try { G.Render.drawIcon(d.querySelector('canvas').getContext('2d'), g.type, P.color, 72, 52); } catch (e) { /* optional */ }
        box.appendChild(d);
        qEls.push({ g: g, tx: d.querySelector('.qt'), bar: d.querySelector('.qb i'), last: '' });
      });
    }
    for (i = 0; i < qEls.length; i++) {
      var r = qEls[i], gg = groups[i];
      if (!gg) continue;
      var txt = gg.ready ? 'Bereit' : ((gg.n > 1 ? '×' + gg.n + ' ' : '') + (i === active ? Math.round(gg.item.prog * 100) + ' %' : ''));
      if (txt !== r.last) { r.tx.textContent = txt; r.last = txt; }
      if (r.bar) r.bar.style.width = Math.round(gg.item.prog * 100) + '%';
    }
  }

  // ------------------------------------------------------------------ Auswahl-Info + Kontext-Befehlsleiste
  function cb(act, icon, label, hk, cls, id, extra) {
    return '<button class="cb ' + (cls || '') + '" data-act="' + act + '"' + (id != null ? ' data-id="' + id + '"' : '') + (extra || '') + '>' + ic(icon) +
      '<span class="lb">' + label + '</span>' + (hk ? '<span class="hk">' + hk + '</span>' : '') + '</button>';
  }
  function groupBtns() {
    return '<span class="grpbox"><span class="sep"></span>' + [0, 1, 2].map(function (n) {   // Gruppenknöpfe bleiben beim Umbrechen zusammen
      return '<button class="cb g" data-grp="' + n + '" aria-label="Gruppe ' + (n + 1) + '">' + (n + 1) + '</button>';
    }).join('') + '</span>';
  }
  function ownerTag(o) {
    if (o === V.pid) return '<span class="tag me">Dir</span>';
    if (o >= 0) return '<span class="tag foe">Gegner</span>';
    return '<span class="tag neu">Niemand</span>';
  }
  function bInfoHtml(b) {
    var d = D.BUILDINGS[b.type] || {}, nt = G.Input.isNeutralType(b), mine = b.owner === V.pid, h = '';
    h += '<div class="nm"><span class="t">' + esc(bName(b.type, b.owner)) + '</span><button class="x" data-act="desel" aria-label="Abwählen">' + ic('close') + '</button></div>';
    if (!nt) {
      h += '<div class="bar"><div data-dyn="hp"></div></div>';
      if (mine && G.Input.swKind(b)) h += '<div class="help" data-dyn="swtxt"></div><div class="bar chg"><div data-dyn="charge"></div></div>';
      if (mine && G.Input.isGarrison(b)) h += '<div class="help">Besetzt: ' + (b.gar || []).length + '/' + G.Input.capOf(b) + ' – Infanterie wählen, dann antippen = besetzen</div>';
      if (mine && d.produces) h += '<div class="help">Karte tippen = Sammelpunkt</div>';
      if (mine && b.type === D.RESEARCH_BUILDING) h += '<div class="help" data-dyn="restxt"></div><div class="bar cap" data-dyn="reswrap"><div data-dyn="resbar"></div></div>';   // v1.3 Forschung
      if (mine && d.store) h += '<div class="help">Erzlager: +' + fmtNum(d.store) + ' (gesamt ' + fmtNum(G.Sim.S.players[V.pid].oreCap || 0) + ')</div>';   // v1.2
      if (mine && d.sellable !== false) h += '<div class="help">Verkaufen: ₵ ' + Math.floor(d.cost * D.SELL_REFUND) + '</div>';
      return h;
    }
    var fx = (NEUTRAL[b.type] && NEUTRAL[b.type].fx) || (b.neutral ? d.desc : D.bDesc(b.type, facOfOwner(b.owner))) || '';
    var kind2 = G.Input.bkind2(b), cap = G.Input.capOf(b), n = (b.gar || []).length;
    if (kind2 === 'garrison' && cap) fx = 'Deckung für ' + cap + ' Infanteristen' + ', +' + ((d && d.rangeBonus) || 1) + ' Reichweite';
    h += '<div class="help">' + ownerTag(b.owner) + esc(fx) + '</div>';
    if (b.ruin) { h += '<div class="help">Ruine – nicht mehr besetzbar</div>'; return h; }
    if (kind2 === 'garrison') {
      if (b.owner >= 0 && !mine) h += '<div class="help">Vom Gegner besetzt – erst freikämpfen</div>';
      else h += '<div class="help">Besetzt: ' + n + '/' + cap + (mine && n ? '' : ' – Infanterie wählen, dann antippen = besetzen') + '</div>';
      if (b.hp < b.maxHp) h += '<div class="bar"><div data-dyn="hp"></div></div>';
    } else {
      var sp = G.Input.bkindSpecial(b);
      if (sp === 'arty' && mine) h += '<div class="help" data-dyn="chgtxt"></div><div class="bar chg"><div data-dyn="charge"></div></div>';
      else if (!mine) h += '<div class="help">Infanterie wählen, dann antippen = erobern (4 s)</div>';
      else h += '<div class="help">Gehört dir – der Gegner kann es zurückerobern</div>';
      if (b.capT > 0 && b.capT < 1) h += '<div class="help">Eroberung läuft …</div><div class="bar cap"><div data-dyn="cap"></div></div>';
    }
    return h;
  }
  /** Erfahrung: Rang und Fortschritt (eine Einheit) bzw. Rangübersicht (mehrere) der Auswahl; leer bei Nicht-Kämpfern. */
  function rankText(units) {
    var R = D.EXP.ranks, cnt = [0, 0, 0, 0], n = 0, last = null;
    units.forEach(function (u) { if (D.expEligible(G.Sim.statsOf(u))) { cnt[u.rk || 0]++; n++; last = u; } });
    if (!n) return '';
    if (n === 1) {
      var r = last.rk || 0, nx = R[r + 1];
      return R[r].name + (nx ? ' · Erfahrung ' + Math.floor(last.xp || 0) + ' / ' + nx.xp : ' · höchster Rang');
    }
    var parts = [];
    for (var i = R.length - 1; i > 0; i--) if (cnt[i]) parts.push(cnt[i] + '× ' + R[i].name);
    return parts.length ? parts.join(', ') : '';
  }
  /** v1.2: Zusatzzeile der Auswahl-Info (Träger: Staffeln, Saboteur: Nachladen, Getarnt). */
  function info12(units) {
    var S = G.Sim.S, hgN = 0, hgR = 0, sabCd = 0, clk = 0, parts = [];
    units.forEach(function (u) {
      if (u.hg) { hgN += u.hg.length; hgR += G.Sim.hangarReady(u); }
      if (u.type === 'saboteur' && u.cd > 0) sabCd = Math.max(sabCd, u.cd);
      if (u.clk) clk++;
    });
    if (hgN) parts.push('Drohnen bereit ' + hgR + '/' + hgN);
    if (sabCd) parts.push('lädt nach ' + Math.ceil(sabCd / D.TICK_HZ) + ' s');
    if (clk) parts.push(units.some(function (u) { return u.clk && (u.revT > S.tick || u.revM); }) ? 'aufgedeckt!' : 'getarnt');
    return parts.length ? (' · ' + parts.join(' · ')).replace(/^ · /, '') .replace(/^/, ' ') : '';
  }
  /** v1.2: Zusatzknöpfe der Befehlsleiste für die Auswahl (Signatur für die Neuaufbau-Erkennung + HTML). */
  function ctx12(units) {
    var S = G.Sim.S, html = '', sig = '';
    var veh = units.some(function (u) { return G.Sim.canRepairUnit(u); });
    if (veh && G.Sim.repairSite(V.pid, units[0].x, units[0].y)) { html += cb('repgo', 'repair', 'Reparatur', '', ''); sig += 'r'; }
    var sab = units.filter(function (u) { return u.type === 'saboteur'; });
    if (sab.length) { var sm = sab[0].sabMode ? 1 : 0; html += cb('sabmode', sm ? 'bolt' : 'bomb', sm ? 'Lahmlegen' : 'Sprengen', '', 'go'); sig += 's' + sm; }
    return { html: html, sig: sig };
  }
  function refreshContext(force) {
    var sel = V.mySel(), box = $('selinfo'), bar = $('cmdbar');
    var units = sel.filter(function (e) { return e.kind === 'unit'; });
    var b = (sel.length === 1 && sel[0].kind === 'building') ? sel[0] : null;
    var counts = {}, order = [];
    units.forEach(function (e) { if (!counts[e.type]) { counts[e.type] = 0; order.push(e.type); } counts[e.type]++; });
    var sig;
    if (b) sig = 'b:' + b.id + ':' + b.owner + ':' + (b.gar ? b.gar.length : 0) + ':' + (b.repairing ? 1 : 0) + ':' + (b.hp < b.maxHp ? 1 : 0) + ':' + ((b.charge || 0) >= 1 ? 1 : 0) + ':' + (b.ruin ? 1 : 0) + ':' + ((b.capT > 0 && b.capT < 1) ? 1 : 0);
    var pas = 0; units.forEach(function (u) { if (G.Input.isTransport && G.Input.isTransport(u)) pas += G.Input.passengers(u); });   // v0.7 Schützenpanzer-Passagiere
    var x12 = units.length ? ctx12(units) : null;   // v1.2: Zusatzknöpfe der neuen Einheiten/Gebäude
    if (b) { /* unten */ }
    else if (units.length) sig = 'u:' + order.map(function (t) { return t + counts[t]; }).join(',') + '|p' + pas + '|' + x12.sig;
    else sig = 'n';
    if (sig !== lastSel || force) {
      lastSel = sig;
      var hs = '', hb = '';
      if (b) {
        hs = bInfoHtml(b);
        var d = D.BUILDINGS[b.type] || {}, mine = b.owner === V.pid;
        hb = '<div class="row">';
        if (mine && !G.Input.isNeutralType(b)) {
          if (d.sellable !== false) hb += cb('sell', 'sell', 'Verkaufen', '', '', b.id);
          if (b.hp < b.maxHp) hb += cb('repair', 'repair', 'Reparieren', '', b.repairing ? 'on' : '', b.id);
        }
        if (isResBld(b)) hb += cb('research', 'flask', 'Forschung', 'T', 'res', b.id);   // v1.3
        if (mine && G.Input.isGarrison(b) && b.gar && b.gar.length) hb += cb('exit', 'exit', 'Aussteigen (' + b.gar.length + ')', 'E', '', b.id);
        if (mine && G.Input.bkindSpecial(b) === 'arty') hb += cb('arty', 'arty', 'Artillerieschlag', 'F', 'arty', b.id);
        if (mine && G.Input.swKind(b)) hb += cb('sw', G.Input.swKind(b), G.Input.SWD[G.Input.swKind(b)].go, 'X', 'arty sw', b.id);
        hb += '</div>';
        if (hb === '<div class="row"></div>') hb = '';
      } else if (units.length) {
        hs = '<div class="chips">' + order.map(function (t) {
          return '<button class="chip" data-act="narrow" data-type="' + t + '" aria-label="' + esc(uName(t)) + ' (' + counts[t] + ')"><canvas width="76" height="56"></canvas><span>' + counts[t] + '</span></button>';
        }).join('') + (order.length === 1 ? '<span class="nmx">' + esc(uName(order[0])) + '</span>' : '<span class="nmx"></span>') + '<button class="x chip" data-act="desel" aria-label="Abwählen">' + ic('close') + '</button></div>';
        hs += '<div class="bar"><div data-dyn="hp"></div></div><div class="help" data-dyn="rank" style="display:none"></div>';   // Erfahrung: Rang/Fortschritt
        var onlyMcv = order.length === 1 && order[0] === 'mcv';
        hb = '<div class="row">' + (counts.mcv ? cb('deploy', 'building', 'Aufbauen', 'D', 'go') : '') + (pas > 0 ? cb('unload', 'exit', 'Aussteigen (' + pas + ')', 'E', 'go') : '') + x12.html + cb('stop', 'stop', 'Stopp', 'S') + (onlyMcv ? '' : cb('am', 'attack', 'Angriff', 'A')) + (onlyMcv ? '' : cb('box', 'frame', 'Rahmen') + cb('add', 'plus', '', '', '', null, ' aria-label="Zur Auswahl hinzufügen"')) + groupBtns() + '</div>';
        if (counts.rifle || counts.rocket) { /* Hinweis nur im Panel */ }
      } else {
        hb = '<div class="row">' + cb('army', 'army', 'Armee') + cb('idle', 'idle', 'Idle') + cb('box', 'frame', 'Rahmen') + groupBtns() + '</div>';
      }
      box.innerHTML = hs; box.style.display = hs ? 'block' : 'none';
      bar.innerHTML = hb;
      // Typ-Symbole in die Chips zeichnen
      Array.prototype.forEach.call(box.querySelectorAll('.chip canvas'), function (c, i) {
        try { G.Render.drawIcon(c.getContext('2d'), order[i], G.Sim.S.players[V.pid].color, 76, 56); } catch (e) { /* optional */ }
      });
      // Gruppen: Tipp = abrufen, Langdruck = speichern
      Array.prototype.forEach.call(bar.querySelectorAll('[data-grp]'), function (g) {
        var n = +g.dataset.grp;
        pressable(g, function () { G.Input.recallGroup(n); }, function () { G.Input.saveGroup(n); });
      });
    }
    if (!engTipShown && units.some(function (u) { return u.type === 'engineer'; })) {
      engTipShown = true;
      setTimeout(function () { toast('Ingenieur: Gegnerisches Gebäude antippen = Übernehmen, eigenes beschädigtes = Reparieren'); }, 300);
    }
    // Dynamisches (jeden Tick): Balken, Schalter
    if (b) {
      var hp = box.querySelector('[data-dyn="hp"]'); if (hp) hp.style.width = (b.hp / b.maxHp * 100) + '%';
      var ch = box.querySelector('[data-dyn="charge"]'), ct = box.querySelector('[data-dyn="chgtxt"]'), c = b.charge || 0;
      if (ch) ch.style.width = (Math.min(1, c) * 100) + '%';
      if (ct) ct.textContent = c >= 1 ? 'Artillerie bereit' : 'Aufladung ' + Math.floor(c * 100) + ' % (noch ' + Math.ceil((1 - c) * 180) + ' s)';
      var cp = box.querySelector('[data-dyn="cap"]'); if (cp) cp.style.width = ((b.capT || 0) * 100) + '%';
      var rt = box.querySelector('[data-dyn="restxt"]');   // v1.3 Forschung: Statuszeile am Tech-Zentrum
      if (rt) {
        var rs = resStatus(), rw = box.querySelector('[data-dyn="reswrap"]'), rbr = box.querySelector('[data-dyn="resbar"]');
        if (rt.textContent !== rs.txt) rt.textContent = rs.txt;
        rw.style.display = rs.cur ? '' : 'none'; if (rs.cur) rbr.style.width = (rs.cur.prog * 100) + '%';
        var rbtn = bar.querySelector('[data-act="research"]'); if (rbtn) rbtn.classList.toggle('on', resOpen);
      }
      var swi = b.owner === V.pid ? G.Input.swInfo(b) : null, swt = box.querySelector('[data-dyn="swtxt"]');
      if (swi) {
        if (ch) ch.style.width = (swi.c * 100) + '%';
        if (swt) swt.textContent = swi.ready ? swi.name + ' bereit' : swi.name + ' lädt: ' + Math.floor(swi.c * 100) + ' % (noch ' + swi.txt + ')';
        var sb = bar.querySelector('.cb.sw');
        if (sb) {
          sb.classList.toggle('ready', swi.ready && !V.arty); sb.classList.toggle('on', !!V.arty && !!V.arty.sw);
          sb.style.background = (swi.ready || V.arty) ? '' : 'linear-gradient(90deg,rgba(234,88,12,.5) ' + (swi.c * 100) + '%,rgba(255,255,255,.035) ' + (swi.c * 100) + '%)';
          sb.querySelector('.lb').textContent = V.arty && V.arty.sw ? 'Abbrechen' : (swi.ready ? swi.go : 'Lädt ' + swi.txt);
        }
      }
      var ab = swi ? null : bar.querySelector('.cb.arty');
      if (ab) {
        var rdy = c >= 1;
        ab.classList.toggle('ready', rdy && !V.arty); ab.classList.toggle('on', !!V.arty);
        ab.style.background = rdy ? '' : 'linear-gradient(90deg,rgba(234,88,12,.5) ' + (c * 100) + '%,rgba(255,255,255,.035) ' + (c * 100) + '%)';
        ab.querySelector('.lb').textContent = V.arty ? 'Abbrechen' : (rdy ? 'Artillerieschlag' : 'Lädt ' + Math.ceil((1 - c) * 180) + ' s');
      }
    } else if (units.length) {
      var tot = 0, mx = 0; units.forEach(function (u) { tot += u.hp; mx += u.maxHp; });
      var hp2 = box.querySelector('[data-dyn="hp"]'); if (hp2) hp2.style.width = (tot / mx * 100) + '%';
      var rk2 = box.querySelector('[data-dyn="rank"]'); if (rk2) { var rt2 = rankText(units) + info12(units); rk2.textContent = rt2; rk2.style.display = rt2 ? '' : 'none'; }
      var q = function (a) { return bar.querySelector('[data-act="' + a + '"]'); };
      if (q('am')) q('am').classList.toggle('on', V.amArmed);
      if (q('add')) q('add').classList.toggle('on', V.addMode);
    }
    var qb = bar.querySelector('[data-act="box"]'); if (qb) qb.classList.toggle('on', V.boxMode);
  }
  // v0.9.2 Reparatur: Knopf hervorgehoben + Hinweisleiste, solange der Reparatur-Modus aktiv ist
  var lastRep = null;
  function refreshRepair() {
    var on = !!V.repairMode; if (on === lastRep) return; lastRep = on;
    var b = $('btnRepair'); if (b) { b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
    $('repbar').style.display = on ? 'flex' : 'none';
    $('map').classList.toggle('repmode', on);
  }
  function onSelection() { lastSel = ''; if (resOpen && !resSelected()) openResearch(false); if (V.running) refreshContext(true); }

  // ------------------------------------------------------------------ v1.3 Forschung: Liste am angewählten Tech-Zentrum (#resSheet über der Karte)
  var resOpen = false, resSig = '', resTipShown = false;
  function isResBld(b) { return !!b && b.kind === 'building' && b.type === D.RESEARCH_BUILDING && b.owner === V.pid; }
  function resSelected() { var s = V.mySel(); return (s.length === 1 && isResBld(s[0])) ? s[0] : null; }
  function resSheet() {
    var el = $('resSheet');
    if (!el) { el = document.createElement('div'); el.id = 'resSheet'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Forschung'); $('map').appendChild(el); el.addEventListener('click', onResClick); }
    return el;
  }
  /** Statuszeile: laufende Forschung, Restzeit bzw. Grund der Pause. */
  function resStatus() {
    var S = G.Sim.S, P = S.players[V.pid], c = P.res && P.res.cur, n = 0, list = D.researchList(P.faction);
    list.forEach(function (id) { if (P.res.done[id]) n++; });
    if (!c) return { cur: null, txt: n >= list.length ? 'Alles erforscht (' + n + '/' + list.length + ')' : 'Keine Forschung aktiv – ' + n + '/' + list.length + ' erforscht', n: n, total: list.length };
    var r = D.RESEARCH[c.id], left = Math.ceil((1 - c.prog) * r.time * (G.Sim.lowPower(V.pid) ? 2 : 1));
    var why = !G.Sim.resRunning(V.pid) ? 'pausiert: kein betriebsbereites Tech-Zentrum' : (P.credits < r.cost / r.time / D.TICK_HZ ? 'wartet auf Credits' : 'noch ' + left + ' s' + (G.Sim.lowPower(V.pid) ? ' (Energiemangel)' : ''));
    return { cur: c, r: r, txt: 'Forscht: ' + r.name + ' – ' + why, why: why, n: n, total: list.length };
  }
  function openResearch(on) {
    resOpen = !!on && !!resSelected();
    var el = resSheet();
    el.style.display = resOpen ? 'flex' : 'none';
    $('map').classList.toggle('res-open', resOpen);
    resSig = '';
    if (resOpen) { refreshResearch(); el.scrollTop = 0; }
  }
  function toggleResearch() { if (!resSelected()) { if (V.running) toast('Erst das Tech-Zentrum wählen', true); return; } openResearch(!resOpen); }
  function onResClick(ev) {
    var b = ev.target.closest('button'); if (!b) return;
    if (b.dataset.act === 'resclose') { openResearch(false); return; }
    if (b.dataset.act === 'rescancel') { var rc = G.cmd.cancelResearch(V.pid); toast(rc.ok ? 'Forschung abgebrochen – Credits erstattet' : rc.reason, !rc.ok); resSig = ''; return; }
    var id = b.dataset.res; if (!id) return;
    var r = G.cmd.research(V.pid, id);
    if (r.ok) { toast('Forschung gestartet: ' + D.RESEARCH[id].name); vib(20); } else toast(r.reason, true);
    resSig = '';
  }
  function refreshResearch() {
    if (!resOpen) return;
    if (!resSelected()) { openResearch(false); return; }
    var S = G.Sim.S, P = S.players[V.pid], el = resSheet(), list = D.researchList(P.faction), st = resStatus();
    var sig = list.map(function (id) { return G.Sim.resState(V.pid, id)[1]; }).join('') + '|' + (st.cur ? st.cur.id : '');
    if (sig !== resSig) {
      resSig = sig;
      var keep = el.querySelector('.rlist') ? el.querySelector('.rlist').scrollTop : 0;
      var h = '<div class="rhead"><span class="t">' + ic('flask') + 'Forschung <span class="cnt">' + st.n + '/' + st.total + '</span></span><button class="x" data-act="resclose" aria-label="Forschung schließen">' + ic('close') + '</button></div><div class="rlist">';
      list.forEach(function (id) {
        var r = D.RESEARCH[id], state = G.Sim.resState(V.pid, id);
        var head = '<span class="rn">' + esc(r.name) + '</span>';
        if (state === 'done') h += '<div class="rrow done">' + head + '<span class="rc ok">' + ic('check') + 'Erforscht</span><span class="rd">' + esc(r.desc) + '</span></div>';
        else if (state === 'active') h += '<div class="rrow active">' + head + '<span class="rc" data-dyn="rleft"></span><span class="rd">' + esc(r.desc) + '</span>' +
          '<div class="bar cap"><div data-dyn="rprog"></div></div><button class="rcancel" data-act="rescancel">' + ic('close') + '<span data-dyn="rback">Abbrechen</span></button></div>';
        else {
          var lock = state === 'locked', busy = !!st.cur;
          h += '<button class="rrow' + (lock || busy ? ' off' : '') + '" data-res="' + id + '">' + head + '<span class="rc">₵ ' + fmtNum(r.cost) + ' · ' + r.time + ' s</span><span class="rd">' + esc(r.desc) +
            (lock ? ' <i>– benötigt ' + esc(D.RESEARCH[r.req].name) + '</i>' : '') + '</span></button>';
        }
      });
      el.innerHTML = h + '</div>';
      el.querySelector('.rlist').scrollTop = keep;
    }
    if (st.cur) {
      var q = function (k) { return el.querySelector('[data-dyn="' + k + '"]'); };
      if (q('rprog')) q('rprog').style.width = (st.cur.prog * 100) + '%';
      var lt = Math.floor(st.cur.prog * 100) + ' % – ' + st.why; if (q('rleft') && q('rleft').textContent !== lt) q('rleft').textContent = lt;
      var bt = 'Abbrechen (₵ ' + fmtNum(st.cur.spent) + ' zurück)'; if (q('rback') && q('rback').textContent !== bt) q('rback').textContent = bt;
    }
  }

  // ------------------------------------------------------------------ v0.4 Superwaffen: Schnellknopf, Gegner-Warnungen
  var SW_FULL = 360;                                   // s bis zur vollen Ladung (SPEC_v04 §3)
  function swPress(id) {
    if (V.arty && V.arty.sw) { G.Input.cancelArty(); return; }
    if (id == null) { var o = G.Input.ownSupers()[0]; if (!o) return; id = o.id; }
    G.Input.beginSuper(id);
  }
  function onSwStack(ev) {
    var b = ev.target.closest('button'); if (!b) return;
    if (b.dataset.foe) { var f = swFoes[b.dataset.foe]; if (f && f.x != null) G.Main.jumpTo(f.x, f.y); return; }
    swPress(+b.dataset.id);
  }
  function jumpToEnt(id) { var e = G.Sim.get(id); if (e) { G.Main.jumpTo((e.tx + e.w / 2) * TILE, (e.ty + e.h / 2) * TILE); V.sel = [e.id]; onSelection(); } }
  function foeKindName(k) { return k === 'orbital' ? 'Gegner-Orbital' : (k === 'missile' ? 'Gegner-Rakete' : (k === 'psi' ? 'Gegner-Psi-Welle' : 'Gegner-Waffe')); }
  /** Gegnerische Superwaffe vermerken (Ereignis swBuilt oder bekannt aus P.mem). */
  function foeAdd(id, kind, x, y, tick, announce) {
    var f = swFoes[id];
    if (!f) { f = swFoes[id] = { id: id, kind: kind || '', t0: tick, x: x, y: y, seen: false }; }
    else { if (kind) f.kind = kind; if (x != null) { f.x = x; f.y = y; } if (announce) f.t0 = tick; }
    return f;
  }
  /** Geschätzte Restzeit (s) der gegnerischen Ladung: aus building.charge, wenn sichtbar, sonst seit swBuilt gerechnet. */
  function foeSecs(f, S) {
    var e = G.Sim.get(f.id);
    if (e && !e.dead && typeof e.charge === 'number' && (S.settings.fogOff || G.Sim.isVisible(V.pid, e))) return (1 - Math.min(1, e.charge)) * SW_FULL;
    return Math.max(0, SW_FULL - (S.tick - f.t0) / D.TICK_HZ);
  }
  function refreshSW(S, P) {
    var i, id, e, own = G.Input.ownSupers();
    // gegnerische Superwaffen aus dem Gedächtnis (z. B. nach dem Fortsetzen)
    var mem = P.mem || {};
    for (id in mem) {
      var m = mem[id], d = D.BUILDINGS[m.type];
      if (d && d.superweapon && m.owner !== V.pid && m.owner >= 0 && !swFoes[m.id]) foeAdd(m.id, d.superweapon, (m.tx + m.w / 2) * TILE, (m.ty + m.h / 2) * TILE, S.tick, false);
    }
    for (id in swFoes) {
      var f = swFoes[id]; e = G.Sim.get(+id);
      if (e && !e.dead) { f.seen = true; f.x = (e.tx + e.w / 2) * TILE; f.y = (e.ty + e.h / 2) * TILE; if (!f.kind) f.kind = G.Input.swKind(e); }
      var gone = f.seen && (!e || e.dead) && !mem[id];
      var mineNow = e && e.owner === V.pid;                      // per Ingenieur übernommen
      var stale = !f.seen && (S.tick - f.t0) / D.TICK_HZ > SW_FULL * 3;
      if (gone || mineNow || stale) delete swFoes[id];
    }
    var foes = Object.keys(swFoes);
    var sig = own.map(function (b) { return b.id; }).join(',') + '|' + foes.join(',');
    var box = $('swstack');
    if (sig !== swSig) {
      swSig = sig; swEls = {}; box.innerHTML = '';
      own.forEach(function (b) {
        var k = G.Input.swKind(b), btn = document.createElement('button');
        btn.className = 'swb own'; btn.dataset.id = b.id; btn.setAttribute('aria-label', G.Input.SWD[k].name);
        btn.innerHTML = '<i class="swf"></i><span class="swl1">' + ic(k) + '<b class="swt"></b></span><span class="swn">' + G.Input.SWD[k].name + '</span>';
        box.appendChild(btn); swEls['o' + b.id] = { btn: btn, f: btn.querySelector('.swf'), t: btn.querySelector('.swt'), last: '' };
      });
      foes.forEach(function (fid) {
        var f = swFoes[fid], btn = document.createElement('button');
        btn.className = 'swb foe'; btn.dataset.foe = fid; btn.setAttribute('aria-label', 'Gegnerische Superwaffe');
        btn.innerHTML = '<i class="swf"></i><span class="swl1">' + ic('warn') + '<b class="swt"></b></span><span class="swn">' + foeKindName(f.kind) + '</span>';
        box.appendChild(btn); swEls['f' + fid] = { btn: btn, f: btn.querySelector('.swf'), t: btn.querySelector('.swt'), last: '' };
      });
    }
    own.forEach(function (b) {
      var r = swEls['o' + b.id], inf = G.Input.swInfo(b); if (!r || !inf) return;
      var aim = !!(V.arty && V.arty.sw && V.arty.id === b.id), txt = aim ? 'Zielen' : (inf.ready ? 'BEREIT' : inf.txt);
      if (txt !== r.last) { r.t.textContent = txt; r.last = txt; }
      r.f.style.width = (inf.c * 100) + '%';
      r.btn.classList.toggle('ready', inf.ready && !aim); r.btn.classList.toggle('aim', aim);
    });
    foes.forEach(function (fid) {
      var r = swEls['f' + fid], f = swFoes[fid]; if (!r) return;
      var secs = foeSecs(f, S), txt = G.Input.swFmt(secs);
      if (txt !== r.last) { r.t.textContent = txt; r.last = txt; }
      r.f.style.width = Math.max(0, Math.min(100, (1 - secs / SW_FULL) * 100)) + '%';
      r.btn.classList.toggle('ready', secs <= 0);
    });
  }
  function swLaunchAlert(ev, S) {
    var x = typeof ev.x === 'number' ? ev.x : null, y = typeof ev.y === 'number' ? ev.y : null;
    swAlert = { x: x, y: y, t2: ev.t2 != null ? ev.t2 : S.tick + D.TICK_HZ * (D.SW[ev.kind] ? D.SW[ev.kind].delay : 3), kind: ev.kind };
    if (x == null) { var f = swFoes[ev.id]; if (f) { swAlert.x = f.x; swAlert.y = f.y; } }
    vib([400, 150, 400, 150, 700]);
    var f2 = swFoes[ev.id]; if (f2) f2.t0 = S.tick;          // Neuladung beginnt
  }
  function refreshAlert(S) {
    var el = $('swalert');
    if (!swAlert || S.tick > swAlert.t2 + D.TICK_HZ * 1.5) { swAlert = null; el.style.display = 'none'; return; }
    var left = Math.max(0, Math.ceil((swAlert.t2 - S.tick) / D.TICK_HZ));
    var h = '<b>Superwaffe im Anflug!</b><span>' + (left > 0 ? 'Einschlag in ' + left + ' s' : 'Einschlag!') + (swAlert.x != null ? ' – antippen: Kamera zum Ziel' : '') + '</span>';
    if (el.innerHTML !== h) el.innerHTML = h;
    el.style.display = 'flex';
  }
  function handleSwEvent(ev, S) {
    if (ev.t === 'swBuilt') {
      if (ev.owner === V.pid || ev.owner < 0) return;
      var pos = (typeof ev.x === 'number') ? { x: ev.x, y: ev.y } : null, e = G.Sim.get(ev.id);
      if (e) pos = { x: (e.tx + e.w / 2) * TILE, y: (e.ty + e.h / 2) * TILE };
      foeAdd(ev.id, ev.kind || (e && G.Input.swKind(e)) || '', pos && pos.x, pos && pos.y, S.tick, true);
      toast('Gegner hat eine Superwaffe gebaut!', true, pos ? function () { G.Main.jumpTo(pos.x, pos.y); } : undefined);
      vib([120, 60, 120]);
    } else if (ev.t === 'swLaunch') {
      if (ev.owner !== V.pid) swLaunchAlert(ev, S);
    } else if (ev.t === 'swReady' && ev.owner === V.pid) {
      toast('Superwaffe bereit', false, function () { jumpToEnt(ev.id); });
      vib([60, 40, 60]);
    }
  }

  // ------------------------------------------------------------------ Overlay (Artillerie-Radius, Halte-Ring)
  function drawOverlay() {
    var cv = $('ov'), dpr = Math.min(2, window.devicePixelRatio || 1);
    var wl = V.placing && V.placing.wall && V.placing.tiles && V.placing.tiles.length ? V.placing : null;
    var need = V.arty || V.hold || wl;
    if (!need && !ovDirty) return;
    if (ovW !== V.vw || ovH !== V.vh || cv.width !== Math.round(V.vw * dpr)) {
      cv.width = Math.round(V.vw * dpr); cv.height = Math.round(V.vh * dpr); ovW = V.vw; ovH = V.vh;
    }
    var c = ovCtx; c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, V.vw, V.vh);
    ovDirty = !!need;
    var px = V.ppx(), py = V.ppy();
    if (V.arty) {
      var a = V.arty, b = G.Sim.get(a.id);
      if (b) {
        var bc = V.toScreen((b.tx + b.w / 2) * TILE, (b.ty + b.h / 2) * TILE);
        if (!a.sw) {
          c.save(); c.setLineDash([10, 8]); c.lineWidth = 3; c.strokeStyle = 'rgba(251,146,60,.75)';
          c.beginPath(); c.ellipse(bc.x, bc.y, G.Input.ARTY_RANGE * TILE * px, G.Input.ARTY_RANGE * TILE * py, 0, 0, 6.2832); c.stroke(); c.restore();
        }
        if (a.set) {
          var rad = a.radius || G.Input.ARTY_RADIUS, t = V.toScreen(a.x, a.y), rx = rad * TILE * px, ry = rad * TILE * py;
          var col = a.ok ? '239,68,68' : '148,163,184';
          c.save(); c.setLineDash([4, 8]); c.lineWidth = 2; c.strokeStyle = 'rgba(' + col + ',.8)';
          c.beginPath(); c.moveTo(bc.x, bc.y); c.lineTo(t.x, t.y); c.stroke(); c.restore();
          c.fillStyle = 'rgba(' + col + ',.30)'; c.beginPath(); c.ellipse(t.x, t.y, rx, ry, 0, 0, 6.2832); c.fill();
          c.lineWidth = 5; c.strokeStyle = '#000'; c.beginPath(); c.ellipse(t.x, t.y, rx, ry, 0, 0, 6.2832); c.stroke();
          c.lineWidth = 3; c.strokeStyle = a.ok ? '#fecaca' : '#cbd5e1'; c.beginPath(); c.ellipse(t.x, t.y, rx, ry, 0, 0, 6.2832); c.stroke();
          c.beginPath(); c.moveTo(t.x - rx * 0.5, t.y); c.lineTo(t.x + rx * 0.5, t.y); c.moveTo(t.x, t.y - ry * 0.5); c.lineTo(t.x, t.y + ry * 0.5); c.stroke();
        }
      }
    }
    if (wl) {                                              // v0.5 Mauerlinie: Kachelrahmen (grün/rot) + Kostenschild am Ende; die Renderer zeichnen zusätzlich die Segmente
      var mw = G.Sim.S.map.w, lx = 0, ly = 0;
      c.lineWidth = 2;
      for (var wi = 0; wi < wl.tiles.length; wi++) {
        var wx = wl.tiles[wi] % mw, wy = (wl.tiles[wi] - wx) / mw, good = wl.ok[wi];
        // v0.7: Kachel als projiziertes Viereck (bei diagonaler Kamera eine Raute), leicht eingerückt
        var q0 = V.toScreen((wx + 0.04) * TILE, (wy + 0.04) * TILE), q1 = V.toScreen((wx + 0.96) * TILE, (wy + 0.04) * TILE),
          q2 = V.toScreen((wx + 0.96) * TILE, (wy + 0.96) * TILE), q3 = V.toScreen((wx + 0.04) * TILE, (wy + 0.96) * TILE);
        c.fillStyle = good ? 'rgba(34,197,94,.22)' : 'rgba(239,68,68,.30)'; c.strokeStyle = good ? '#4ade80' : '#f87171';
        c.beginPath(); c.moveTo(q0.x, q0.y); c.lineTo(q1.x, q1.y); c.lineTo(q2.x, q2.y); c.lineTo(q3.x, q3.y); c.closePath(); c.fill(); c.stroke();
        lx = (q0.x + q2.x) / 2; ly = Math.min(q0.y, q1.y, q2.y, q3.y);
      }
      var lab = '₵ ' + fmtNum(wl.cost || 0);
      c.font = '800 18px system-ui, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      var lw = c.measureText(lab).width + 16, lcx = Math.max(lw / 2 + 4, Math.min(V.vw - lw / 2 - 4, lx)), lcy = Math.max(20, ly - 26);
      c.fillStyle = 'rgba(0,0,0,.88)'; c.fillRect(lcx - lw / 2, lcy - 14, lw, 28);
      c.strokeStyle = wl.valid ? '#4ade80' : '#f87171'; c.lineWidth = 2; c.strokeRect(lcx - lw / 2, lcy - 14, lw, 28);
      c.fillStyle = '#fff'; c.fillText(lab, lcx, lcy + 1);
    }
    if (V.hold) {
      var k = Math.min(1, (performance.now() - V.hold.t0) / 250);
      c.lineWidth = 5; c.strokeStyle = '#000'; c.beginPath(); c.arc(V.hold.x, V.hold.y, 30 * k + 4, 0, 6.2832); c.stroke();
      c.lineWidth = 3; c.strokeStyle = '#fbbf24'; c.beginPath(); c.arc(V.hold.x, V.hold.y, 30 * k + 4, 0, 6.2832); c.stroke();
    }
  }

  // ------------------------------------------------------------------ pro Frame
  function update(dt) {
    var S = G.Sim.S;
    if (!V || !V.running || !S) return;
    acc += dt;
    drawOverlay();
    // Platzierungs-/Zielleiste sofort
    var pl = V.placing, ar = V.arty, pbar = $('placebar');
    $('cmdbar').style.display = (pl || ar) ? 'none' : 'flex';
    $('map').classList.toggle('mode-place', !!(pl || ar));
    pbar.style.display = (pl || ar) ? 'flex' : 'none';
    if (pl || ar) {
      var msg = $('placeMsg'), ok = $('placeOk'), m, good;
      if (pl && pl.wall) {
        var nv = pl.valid || 0, nb = pl.tiles.length - nv;
        good = !pl.tiles.length || nv > 0;
        m = !pl.tiles.length ? (fine ? 'Mauer: Maus von A nach B ziehen' : 'Mauer: Auf der Karte von A nach B ziehen')
          : (nv > 0 ? nv + ' × Mauer · ₵ ' + fmtNum(pl.cost) + (nb > 0 ? ' · ' + nb + ' nicht möglich' : '') : (pl.reason || 'Hier nicht möglich'));
        ok.disabled = nv < 1; ok.innerHTML = '<span>Bauen</span>' + ic('check');
      } else if (pl && pl.deploy) {
        good = pl.ok; m = pl.ok ? 'Bauhof aufbauen – hier ist Platz' + (fine ? ' (D / Enter)' : '') : (pl.reason || 'Hier nicht möglich');
        ok.disabled = !pl.ok; ok.innerHTML = '<span>Aufbauen</span>' + ic('check');
      } else if (pl) {
        good = pl.ok; m = pl.ok ? bName(pl.type) + ' – ' + (fine ? 'Klick = bauen' : 'ziehen zum Verschieben') : (pl.reason || 'Hier nicht möglich');
        ok.disabled = !pl.ok; ok.innerHTML = '<span>Bauen</span>' + ic('check');
      } else {
        good = !ar.set || ar.ok;
        var an = ar.sw ? G.Input.SWD[ar.sw].name : 'Artillerieschlag', arad = ar.radius || G.Input.ARTY_RADIUS;
        m = !ar.set ? 'Ziel auf der Karte antippen' : (ar.ok ? an + ' – Radius ' + arad + ' Kacheln' + (fine ? ' · Klick = Feuer' : '') : ar.reason);
        ok.disabled = !(ar.set && ar.ok); ok.innerHTML = '<span>Feuer</span>' + ic(ar.sw ? 'check' : 'arty');
      }
      if (msg.textContent !== m) msg.textContent = m;
      msg.classList.toggle('bad', !good);
    }
    if (acc < 0.1) return;
    acc = 0;
    var P = S.players[V.pid];
    var ch = !!P.cheat;
    $('credits').textContent = ch ? '₵ ∞' : '₵ ' + fmtNum(P.credits);   // v0.8: Cheat → ∞ (spart Platz in der schmalen Leiste)
    // v1.2 Erzlager: dezente Warnfarbe, wenn das Lager fast voll (orange) bzw. voll (rot) ist; einmalige Meldung beim Volllaufen
    var capK = (!ch && P.oreCap) ? (P.credits >= P.oreCap - 1 ? 2 : (P.credits >= P.oreCap * D.ORE_CAP.warn ? 1 : 0)) : 0;
    if (capK !== capShown) {
      capShown = capK;
      $('credits').style.color = capK === 2 ? '#f87171' : (capK === 1 ? '#fb923c' : '');
      $('credits').title = 'Credits' + (P.oreCap ? ' – Erzlager ' + fmtNum(P.oreCap) : '');
    }
    if (capK === 2 && S.tick - (P.capFullT || -9999) < 40 && S.tick - capToastT > 20 * 90) { capToastT = S.tick; toast('Erzlager voll (' + fmtNum(P.oreCap) + ') – Sammler warten. Erzsilo bauen oder Geld ausgeben.', true); }
    if (ch !== cheatShown) { cheatShown = ch; $('cheatTag').style.display = ch ? '' : 'none'; $('top').classList.toggle('cheat', ch); }
    $('pwrtxt').textContent = P.pwrUse + '/' + P.pwrProd;
    var ratio = P.pwrProd ? P.pwrUse / P.pwrProd : 1;
    var fill = $('pwrfill');
    fill.style.width = Math.min(100, ratio * 100) + '%';
    fill.style.background = ratio > 1 ? '#ef4444' : (ratio > 0.8 ? '#facc15' : '#22c55e');
    $('clock').textContent = fmtTime(S.tick);
    // v0.7 Friedenszeit-Countdown
    var pl0 = peaceLeft(), pk = pl0 > 0 ? Math.ceil(pl0) : 0;
    if (pk !== peaceShown) {
      peaceShown = pk;
      var pe = $('peace');
      if (pk > 0) { pe.innerHTML = '<span>Frieden</span> <span>' + Math.floor(pk / 60) + ':' + ('0' + (pk % 60)).slice(-2) + '</span>'; pe.style.display = ''; }
      else pe.style.display = 'none';
      $('top').classList.toggle('peace', pk > 0);
    }
    if (audioOn()) { var mu = !!G.Audio.isMuted(); if (mu !== muteShown) { muteShown = mu; refreshMute(); } }
    // Produktion hängt, weil die Credits fehlen → Ansage „Zu wenig Credits“ (Cooldown 25 s)
    if (P.credits < 40) {
      var stalled = false;
      ['building', 'defense', 'infantry', 'vehicle', 'air', 'naval'].forEach(function (c) {   // v0.8: + Luftwaffe/Marine
        var q = P.q[c] || [], it = null;
        if (c === 'building' || c === 'defense') { for (var qi = 0; qi < q.length; qi++) if (!q[qi].ready) { it = q[qi]; break; } } else it = q[0];
        if (it && it.prog < 1 && P.credits < G.Sim.costOf(V.pid, it.type) / Math.max(1, G.Sim.timeOf ? G.Sim.timeOf(V.pid, it.type) : 10) * 0.15) stalled = true;
      });
      if (stalled) say('noMoney', 25000);
    }
    if (tilesFor !== curTab) buildTiles(); else refreshTiles();
    refreshContext(false);
    refreshRepair();   // v0.9.2 Reparatur
    refreshResearch(); // v1.3 Forschung
    if (!resTipShown && P.res && !P.res.cur && !P.st.research && S.tick % 20 === 0 && G.Sim.hasBuilding(V.pid, D.RESEARCH_BUILDING)) {
      resTipShown = true;
      var tcb = G.Sim.producerOf(V.pid, D.RESEARCH_BUILDING);
      toast('Tech-Zentrum bereit – antippen und „Forschung“ wählen', false, tcb ? function () { jumpToEnt(tcb.id); } : undefined);
    }
    // Ereignisse → Meldungen
    for (var i = 0; i < S.events.length; i++) {
      var ev = S.events[i];
      if (ev.seq <= lastEvSeq) continue;
      if (ev.t === 'ready' && ev.owner === V.pid) toast(bName(ev.type) + ' fertig – antippen zum Platzieren');
      else if (ev.t === 'swBuilt' || ev.t === 'swLaunch' || ev.t === 'swReady') handleSwEvent(ev, S);
      else if (ev.t === 'mc') mcToast(ev);   // v1.0 Gedankenkontrolle
      else if (ev.t === 'research' && ev.owner === V.pid) {   // v1.3 Forschung abgeschlossen
        var rtc = G.Sim.producerOf(V.pid, D.RESEARCH_BUILDING);
        toast('Forschung abgeschlossen: ' + D.RESEARCH[ev.id].name, false, rtc ? (function (tid) { return function () { jumpToEnt(tid); }; })(rtc.id) : undefined); vib(30);
      }
      else if (ev.t === 'sabotage') {   // v1.2 Saboteur
        var sbn = bName(ev.type, ev.victim);
        if (ev.victim === V.pid) { toast(ev.mode === 'stun' ? 'Sabotage! ' + sbn + ' ist lahmgelegt' : 'Sabotage! Sprengladung an: ' + sbn, true, (function (jx, jy) { return function () { G.Main.jumpTo(jx, jy); }; })(ev.x, ev.y)); vib([80, 40, 80]); }
        else if (ev.owner === V.pid) toast(ev.mode === 'stun' ? sbn + ' lahmgelegt (20 s)' : 'Sprengladung gelegt – zündet in 4 s');
      }
      else if (ev.t === 'mine' && ev.owner !== V.pid && G.Sim.S.players[V.pid] && S.tick - mineToastT > 20 * 20) { mineToastT = S.tick; toast('Minen! Radarwagen oder Ingenieur decken Minenfelder auf', true); }
      else if (ev.t === 'capLost' && ev.owner === V.pid) { toast('Lager verloren: ₵ ' + fmtNum(ev.lost) + ' Überschuss verfallen', true); }   // v1.2 Erzlager
      else if (ev.t === 'peaceOver') { if (!peaceOverShown) { peaceOverShown = true; toast('Friedenszeit vorbei – der Gegner kann angreifen', true); vib([120, 60, 120]); } }
      else if (ev.t === 'capture') {
        var cb2 = G.Sim.get(ev.id), nm = cb2 ? bName(cb2.type) : 'Gebäude';
        if (ev.owner === V.pid) { toast(nm + ' erobert'); vib(30); }
        else if (ev.prev === V.pid) { toast(nm + ' verloren', true); vib([80, 40, 80]); }
      } else if (ev.t === 'ruin') {
        var rb = G.Sim.get(ev.id);
        if (rb && rb.owner === V.pid) toast(bName(rb.type) + ' zerstört', true);
      }
    }
    if (S.events.length) lastEvSeq = S.events[S.events.length - 1].seq;
    refreshSW(S, P); refreshAlert(S);
    // Artillerie bereit
    for (var k = 0; k < S.ents.length; k++) {
      var e = S.ents[k];
      if (e.kind !== 'building' || e.dead || e.owner !== V.pid || G.Input.bkindSpecial(e) !== 'arty') continue;
      var rdy = (e.charge || 0) >= 1;
      if (artyReady[e.id] === false && rdy) { toast('Artillerie bereit', false, function () { G.Main.jumpTo((e.tx + e.w / 2) * TILE, (e.ty + e.h / 2) * TILE); G.view.sel = [e.id]; onSelection(); }); vib(40); }
      artyReady[e.id] = rdy;
    }
    // Angriff auf Basis/Sammler (antippen = Kamera hin)
    if (P.alert.tick > lastAlertSeen) {
      lastAlertSeen = P.alert.tick;
      if (S.tick - lastAlert > 20 * 15) {
        var ax = P.alert.x, ay = P.alert.y;
        toast(P.alert.harv ? 'Sammler wird angegriffen!' : 'Basis wird angegriffen!', true, function () { G.Main.jumpTo(ax, ay); });
        if (!P.alert.harv) vib([200, 100, 200]);
        lastAlert = S.tick;
      }
    }
  }

  function onGameStart() {
    ['startScreen', 'pauseScreen', 'endScreen', 'helpScreen'].forEach(function (id) { $(id).classList.remove('show'); });
    $('pausedTag').style.display = 'none';
    moneyTipShown = false; peaceShown = null; peaceOverShown = false; capShown = -1; capToastT = -1e9;
    curTab = 'building'; V.tab = curTab; tilesFor = ''; lastSel = ''; lastAlert = -9999; lastAlertSeen = G.Sim.S.players[V.pid].alert.tick;
    lastEvSeq = G.Sim.S.evSeq; artyReady = {};
    resTipShown = !!(G.Sim.S.players[V.pid].res && (G.Sim.S.players[V.pid].res.cur || G.Sim.S.players[V.pid].st.research)); openResearch(false);   // v1.3
    swFoes = {}; swAlert = null; swSig = ''; swEls = {}; qSig = ''; engTipShown = false; $('swalert').style.display = 'none'; $('swstack').innerHTML = '';
    G.Sim.S.ents.forEach(function (e) { if (e.kind === 'building' && e.owner === V.pid && G.Input.bkindSpecial(e) === 'arty') artyReady[e.id] = (e.charge || 0) >= 1; });
    $('side').classList.remove('expanded'); $('expand').innerHTML = ic('up');
    buildTiles();
    refreshContext(true);
    muteShown = null; refreshMute(); sayLast = {};
    try { if (G.Audio && G.Audio.onGameStart) G.Audio.onGameStart(); } catch (e) { /* Ton optional */ }
  }

  // ------------------------------------------------------------------ Bildschirme
  function seg(name, items, cur) {
    return '<div class="seg" data-opt="' + name + '">' + items.map(function (it) {
      return '<button data-v="' + it[0] + '" class="' + (String(cur) === String(it[0]) ? 'on' : '') + '">' + it[1] + '</button>';
    }).join('') + '</div>';
  }
  function bindSeg(root, onChange) {
    Array.prototype.forEach.call(root.querySelectorAll('.seg[data-opt]'), function (s) {
      s.addEventListener('click', function (ev) {
        var b = ev.target.closest('button'); if (!b) return;
        Array.prototype.forEach.call(s.children, function (c) { c.classList.toggle('on', c === b); });
        onChange(s.dataset.opt, b.dataset.v);
      });
    });
  }
  // 3D: Grafik-Auswahl (INK: Gezeichnet (Standard) / v0.6: Modern / Pixel-Look / Scharf / Sparmodus) – Wert liegt in G.Render (localStorage 'frontlinie.gfx')
  function gfxOpt() {
    if (!G.Render.QUALITIES) return '';
    var cur = G.Render.getQuality();
    var qs = G.Render.QUALITIES.slice(); // 2D-Fallback: "2D (sicher)" immer anbieten
    // v0.8: Modern mit eingeschränkten Grafik-Funktionen (PowerVR-Profil / Selbstheilung / Grafik-Test) → Name mit Profil-Code
    try { var X = G.Gfx3D, inf = G.Render.info && G.Render.info(); if (X && inf && inf.flags != null && inf.flags !== X.FULL) qs = qs.map(function (q) { return q[0] === 'modern' ? ['modern', 'Modern (' + X.pretty(inf.flags) + ')'] : (q[0] === 'ink' ? ['ink', 'Gezeichnet (' + X.pretty(inf.flags) + ')'] : q); }); } catch (e) { /* egal */ }
    if (!qs.some(function (q) { return q[0] === '2d'; })) qs.push(['2d', '2D (sicher)']);
    if (!qs.some(function (q) { return q[0] === 'sprite'; })) qs.push(['sprite', 'Sprite (stabil)']); // Sprite-Modus: vorgerenderte Grafik, kein WebGL
    return '<div class="opt"><div class="lbl">Grafik</div><select id="gfxSel" aria-label="Grafik" style="width:100%">' + qs.map(function (q) {
      return '<option value="' + q[0] + '"' + (q[0] === cur ? ' selected' : '') + '>' + q[1] + '</option>';
    }).join('') + '</select>' + camOpt() + weatherOpt() + gfxTools() + '</div>';
  }
  /** W11-look: gut lesbare Zeile „Aktiv: …“ (Modus/Profil, Schatten, Bildpuffer), damit Spieler den laufenden Modus melden können. */
  function gfxActive() {
    try {
      var X = G.Gfx3D, R3 = G.R3 || {}, q = G.Render.getQuality ? G.Render.getQuality() : '';
      if (G.Render.is2D || q === 'sprite' || q === '2d') {
        var c2 = document.getElementById('cv');
        return 'Aktiv: ' + (q === 'sprite' ? 'Sprite (stabil)' : '2D (sicher)') + ' · ohne WebGL' + (c2 ? ' · Bild ' + c2.width + '×' + c2.height : '');
      }
      var inf = G.Render.info(), code = inf.flags || '', F = R3.F || {}, nm;
      var base = q === 'ink' ? ((R3.Q && R3.Q.lite) ? 'Gezeichnet einfach' : 'Gezeichnet') : 'Modern';   // INK
      if (q !== 'modern' && q !== 'ink') nm = { pixel: 'Pixel-Look', sharp: 'Scharf', low: 'Sparmodus' }[q] || q;
      else if (X && code === X.FULL) nm = base + ' (voll)';
      else nm = base + ' ' + (X ? X.pretty(code) : code) + (X && code === X.POWERVR ? ' (PowerVR-Start)' : '');
      var sh = (R3.Q && R3.Q.shadows) ? 'echt' : (G.R3S && G.R3S.wanted && G.R3S.wanted() ? 'Ersatz' : 'aus');
      return 'Aktiv: ' + nm + ' · Schatten ' + sh + ' · Bild ' + inf.buf[0] + '×' + inf.buf[1];
    } catch (e) { return ''; }
  }
  /** v0.8: Grafik-Test, Grafik zurücksetzen, Grafik-Info (Diagnose) – Status in einer Zeile (≥ 16 px). */
  function gfxTools() {
    var X = G.Gfx3D; if (!X) return '';
    var st = '';
    try {
      var p = X.profile() || {}, g = X.gpu();
      st = (G.Render.is2D ? '2D-Grafik aktiv' : 'Funktionen: ' + X.pretty(X.code())) + (g.safe ? ' · Schonprofil (' + esc(String(g.name).slice(0, 28)) + ')' : '') +
        (p.lastTest ? ' · Test: ' + X.pretty(p.lastTest.ok) : '') + ((p.crashes || []).length ? ' · ' + p.crashes.length + ' Absturz/Abstürze' : '');
    } catch (e) { /* egal */ }
    return '<div id="gfxActive" style="margin-top:10px;font-size:17px;font-weight:700;line-height:1.35;color:var(--text,#e8edf3);font-variant-numeric:tabular-nums">' + gfxActive() + '</div>' +
      '<div class="help" id="gfxStatus" style="margin-top:4px">' + st + '</div>' +
      '<div class="seg" style="margin-top:6px"><button id="gfxTest" aria-label="Grafik-Test" style="min-width:140px">Grafik-Test</button><button id="gfxDiagBtn" aria-label="Grafik-Info" style="min-width:140px">Grafik-Info</button><button id="gfxReset" aria-label="Grafik zurücksetzen" style="flex-basis:100%">Grafik zurücksetzen</button></div>' +
      '<div class="help">Grafik-Test: prüft ca. 4 Minuten lang jede Grafik-Funktion einzeln und behält nur, was stabil läuft.</div>';
  }
  /** Thema/Wetter/Tageszeit: „Wetter: An / Aus“ (G.Mood, localStorage 'frontlinie.weather', Standard An) – wirkt sofort, rein optisch. */
  function weatherOpt() {
    if (!G.Mood) return '';
    var cur = G.Mood.weatherOn() ? '1' : '0';
    return '<div class="lbl sublbl">Wetter</div><div class="seg" data-weather="1">' + [['1', 'An'], ['0', 'Aus']].map(function (it) {
      return '<button data-v="' + it[0] + '" class="' + (cur === it[0] ? 'on' : '') + '" aria-label="Wetter: ' + it[1] + '">' + it[1] + '</button>';
    }).join('') + '</div>';
  }
  function bindWeather(root) {
    var sg = (root || document).querySelector('.seg[data-weather]'); if (!sg || !G.Mood) return;
    sg.addEventListener('click', function (ev) {
      var b = ev.target.closest('button'); if (!b) return;
      G.Mood.setWeather(b.dataset.v === '1');
      Array.prototype.forEach.call(sg.children, function (c) { c.classList.toggle('on', c === b); });
    });
  }
  /** v0.7: „Kamera: Diagonal / Gerade“ – eigene Segmentgruppe (data-cam), wirkt sofort, Bildmitte bleibt. */
  function camOpt() {
    if (!V || !V.setCamMode) return '';
    var cur = V.camMode === 'straight' ? 'straight' : 'diag';
    return '<div class="lbl sublbl">Kamera</div><div class="seg" data-cam="1">' + [['diag', 'Diagonal'], ['straight', 'Gerade']].map(function (it) {
      return '<button data-v="' + it[0] + '" class="' + (cur === it[0] ? 'on' : '') + '" aria-label="Kamera: ' + it[1] + '">' + it[1] + '</button>';
    }).join('') + '</div>';
  }
  function bindCam(root) {
    var sg = (root || document).querySelector('.seg[data-cam]'); if (!sg) return;
    sg.addEventListener('click', function (ev) {
      var b = ev.target.closest('button'); if (!b) return;
      var m = V.setCamMode(b.dataset.v);
      Array.prototype.forEach.call(sg.children, function (c) { c.classList.toggle('on', c.dataset.v === m); });
    });
  }
  // Start- und Pausemenü enthalten je ein #gfxSel → innerhalb des jeweiligen Menüs suchen (getElementById fände immer das erste)
  function bindGfx(root) {
    var r = root || document, el = r.querySelector('#gfxSel'); if (el) el.onchange = function () { G.Render.setQuality(el.value); }; bindCam(root); bindWeather(root);
    var bt = r.querySelector('#gfxTest'), br = r.querySelector('#gfxReset'), bd = r.querySelector('#gfxDiagBtn');
    if (bt) bt.onclick = function () { if (G.GfxTest) G.GfxTest.start(); };
    if (br) br.onclick = function () {
      if (!br.dataset.sure) { br.dataset.sure = '1'; br.textContent = 'Wirklich zurücksetzen?'; setTimeout(function () { if (br.isConnected) { br.dataset.sure = ''; br.textContent = 'Grafik zurücksetzen'; } }, 3000); return; }
      G.Gfx3D.reset(); toast('Grafik zurückgesetzt – Modern mit Standardprofil');
      var sc = r.closest ? r.closest('.screen') : null; if (V.paused) onPause(true); else if (!V.running) showStart(); void sc;
    };
    if (bd) bd.onclick = function () { if (G.GfxDiag) G.GfxDiag.toggle(); };
  }
  function saveOpts() { try { localStorage.setItem('frontlinie.opts', JSON.stringify(opts)); } catch (e) { /* egal */ } }

  // Vorschau einer Karte: Gelände aus den Zeilen, Strukturpunkte, Startpositionen
  var TCOL0 = { '.': '#5f8f3f', ',': '#bba76f', '#': '#6e6a64', '~': '#2f6ea3', 'T': '#2d5a2a', '=': '#77746c', 'H': '#9a7344', 'o': '#e0b030', 'O': '#ffd23f' };
  var SCOL = { house: '#f1f5f9', block: '#f1f5f9', bunker: '#fb923c', oilrig: '#111827', radar: '#22d3ee', hospital: '#4ade80', workshop: '#f59e0b', artillery: '#f43f5e', tradepost: '#a3e635' };
  // Thema/Wetter/Tageszeit: Winter-Farben der Vorschau, Tönung für Dämmerung/Nacht, Kennzeichnung in der Kartenkarte
  var TCOL_W = { '.': '#d2d9e4', ',': '#b8c3d2', '#': '#64666c', '~': '#2a4c70', 'T': '#33504a', '=': '#7c7f87', 'H': '#7a5c40', 'o': '#e0b030', 'O': '#ffd23f' };
  var MOOD_TXT = { theme: { winter: 'Winter' }, time: { dusk: 'Dämmerung', night: 'Nacht' }, weather: { rain: 'Regen', snow: 'Schneefall', sand: 'Sandsturm' } };
  function moodTxt(m) {
    if (!G.MAPS.mood) return '';
    var o = G.MAPS.mood(m.id), a = [MOOD_TXT.theme[o.theme], MOOD_TXT.time[o.time], MOOD_TXT.weather[o.weather]].filter(Boolean);
    return a.length ? ' · ' + a.join(' · ') : '';
  }
  function drawThumb(cv, m) {
    var rows = m.rows, h = rows.length, w = rows[0].length, S = cv.width, s = S / Math.max(w, h), c = cv.getContext('2d');
    var mo = G.MAPS.mood ? G.MAPS.mood(m.id) : { theme: 'temperate', time: 'day' }, TCOL = mo.theme === 'winter' ? TCOL_W : TCOL0;
    var ox = (S - w * s) / 2, oy = (S - h * s) / 2;
    c.fillStyle = '#05080c'; c.fillRect(0, 0, S, S);
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      c.fillStyle = TCOL[rows[y][x]] || '#555'; c.fillRect(ox + x * s, oy + y * s, Math.ceil(s) + 0.5, Math.ceil(s) + 0.5);
    }
    if (mo.time === 'night') { c.fillStyle = 'rgba(8,16,44,0.5)'; c.fillRect(ox, oy, w * s, h * s); }
    else if (mo.time === 'dusk') { c.fillStyle = 'rgba(150,60,40,0.18)'; c.fillRect(ox, oy, w * s, h * s); }
    (m.structures || []).forEach(function (st) {
      var d = D.BUILDINGS[st.type], sw = (d && d.w) || 2, sh = (d && d.h) || 2, cx = ox + (st.tx + sw / 2) * s, cy = oy + (st.ty + sh / 2) * s, r = Math.max(4, s * 1.5);
      c.fillStyle = SCOL[st.type] || '#fff'; c.strokeStyle = st.type === 'oilrig' ? '#fbbf24' : '#000'; c.lineWidth = 2;
      c.beginPath(); c.arc(cx, cy, r, 0, 6.2832); c.fill(); c.stroke();
    });
    (m.starts || []).forEach(function (st, i) {
      var cx = ox + (st.tx + 1.5) * s, cy = oy + (st.ty + 1.5) * s, r = Math.max(6, s * 2.6);
      c.fillStyle = i === 0 ? '#3b82f6' : '#ef4444'; c.strokeStyle = '#fff'; c.lineWidth = 3;
      c.fillRect(cx - r, cy - r, 2 * r, 2 * r); c.strokeRect(cx - r, cy - r, 2 * r, 2 * r);
    });
  }
  function mapCards() {
    return '<div class="maplist" data-opt="mapId">' + G.MAPS.list.map(function (m) {
      var w = m.rows[0].length, h = m.rows.length;
      return '<button class="mapcard ' + (opts.mapId === m.id ? 'on' : '') + '" data-v="' + m.id + '"><canvas width="168" height="168"></canvas><span><span class="mt">' + esc(m.name) +
        '</span><span class="ms">' + esc((m.size || (w + '×' + h)) + moodTxt(m)) + '</span><span class="md">' + esc(m.desc || '') + '</span></span></button>';
    }).join('') + '</div>';
  }
  function showStart() {
    var el = $('startScreen'), save = G.Save.info();
    var F = D.FACTIONS;
    if (!G.MAPS.list.some(function (m) { return m.id === opts.mapId; })) opts.mapId = G.MAPS.list[0].id;
    var h = '<div class="card wide"><h1>FRONTLINIE</h1><div class="sub">ECHTZEITSTRATEGIE · BASIS BAUEN · ERZ SAMMELN · GEGNER BESIEGEN</div>';
    if (save) h += '<button class="big alt" id="btnResume">Partie fortsetzen (' + fmtTime(save.tick) + ')</button>';
    h += '<div class="opt"><div class="lbl">Karte</div>' + mapCards() + '</div>';
    h += '<div class="optgrid"><div class="opt span2"><div class="lbl">Fraktion</div><div class="seg facs" data-opt="faction">' +
      D.FACTION_IDS.map(function (f) {   // v1.0: drei Fraktionen (Kollektiv: Dunkelblau)
        return '<button data-v="' + f + '" class="fac ' + (opts.faction === f ? 'on' : '') + '" style="--fc:' + F[f].color + '"><span><i class="fdot" style="background:' + F[f].color + '"></i>' + F[f].name + '</span><small>' + F[f].desc + '</small></button>';
      }).join('') + '</div></div>';
    h += '<div class="opt span2"><div class="lbl">Gegner-Fraktion</div>' + seg('aiFaction', [['random', 'Zufall']].concat(D.FACTION_IDS.map(function (f) { return [f, F[f].name]; })), opts.aiFaction || 'random') + '</div>';
    h += '<div class="opt span2" id="diffOpt"><div class="lbl">KI-Stärke: <b id="diffCur">' + esc(diffName(opts.diff)) + '</b></div>' + seg('diff', DIFFS, opts.diff) +   // v1.0.1 KI-Leicht
      '<div class="help" id="diffHelp">' + esc(DIFF_HELP[opts.diff] || '') + '</div></div>';
    h += '<div class="opt"><div class="lbl">Tempo</div>' + seg('speed', [['slow', 'Langsam'], ['normal', 'Normal'], ['fast', 'Schnell']], opts.speed) + '</div>';
    h += '<div class="opt"><div class="lbl">Nebel des Krieges</div>' + seg('fogOff', [['false', 'An'], ['true', 'Aus']], String(opts.fogOff)) + '</div>';
    h += '<div class="opt"><div class="lbl">Friedenszeit</div>' + seg('peace', [['0', 'Aus'], ['5', '5 Min.'], ['10', '10 Min.'], ['15', '15 Min.']], String(opts.peace == null ? 5 : opts.peace)) +
      '<div class="help">So lange greift die KI nicht an – Zeit zum Aufbauen.</div></div>';
    h += gfxOpt() + '</div>';
    h += audioOpt();
    h += '<button class="big gray" id="btnHelp">So spielst du</button>';
    h += '<div class="stickybar"><button class="big" id="btnStart">Partie starten · KI ' + esc(diffName(opts.diff)) + '</button></div></div>';   // v1.0.1 KI-Leicht
    el.innerHTML = h;
    bindSeg(el, function (k, v) {
      opts[k] = (k === 'fogOff') ? v === 'true' : (k === 'peace' ? +v : v); saveOpts();
      if (k === 'diff') { $('diffCur').textContent = diffName(v); $('diffHelp').textContent = DIFF_HELP[v] || ''; $('btnStart').textContent = 'Partie starten · KI ' + diffName(v); }   // v1.0.1 KI-Leicht
    });
    var cards = el.querySelectorAll('.mapcard');
    Array.prototype.forEach.call(cards, function (c, i) {
      drawThumb(c.querySelector('canvas'), G.MAPS.list[i]);
      c.addEventListener('click', function () {
        Array.prototype.forEach.call(cards, function (o) { o.classList.toggle('on', o === c); });
        opts.mapId = c.dataset.v; saveOpts();
      });
    });
    $('btnStart').onclick = function () { G.Main.start(opts); };
    $('btnHelp').onclick = showHelp;
    bindGfx(el); bindAudio(el);
    try { if (G.Audio && G.Audio.onMenu) G.Audio.onMenu(); } catch (e) { /* Ton optional */ }
    if (save) $('btnResume').onclick = function () { if (!G.Main.resume()) { toast('Spielstand defekt', true); G.Save.clear(); showStart(); } };
    ['pauseScreen', 'endScreen'].forEach(function (id) { $(id).classList.remove('show'); });
    el.classList.add('show');
    el.scrollTop = 0;
  }
  function showHelp() {
    var el = $('helpScreen');
    function li(a, b) { return '<li><b>' + a + '</b><span>' + b + '</span></li>'; }
    var h = '<div class="card panel wide"><h2>So spielst du</h2>';
    h += '<h3>Ziel</h3><p class="help">Zerstöre alle gegnerischen Gebäude. Baue Kraftwerk, Raffinerie und Kaserne, sammle Erz, bilde Einheiten aus und besetze oder erobere Gebäude auf der Karte.</p>';
    h += '<h3>Touch (Handy)</h3><ul class="hl">' +
      li('Tippen', 'Einheit oder Gebäude wählen. Mit Auswahl: Boden = bewegen, Gegner = angreifen, Erz = sammeln.') +
      li('Doppeltippen', 'Alle Einheiten dieses Typs im Bild wählen.') +
      li('1 Finger ziehen', 'Karte schieben (mit Schwung).') +
      li('2 Finger', 'Zoomen und schieben – der Punkt zwischen den Fingern bleibt stehen.') +
      li('Halten + Ziehen', 'Auswahlrahmen aufziehen. Halten und loslassen = Angriff-Bewegen. Alternativ „Rahmen“ antippen.') +
      li('Symbole oben im Feld', 'Typ-Symbole antippen = nur diesen Typ behalten. ✕ = Auswahl aufheben.') +
      li('Zifferntasten', 'Antippen = Gruppe abrufen, lange drücken = Auswahl als Gruppe speichern.') +
      li('Minimap', 'Antippen = Kamera dorthin. Lange drücken mit Auswahl = Einheiten hinschicken.') +
      li('Bauen', 'Gebäude-Kachel antippen = in die Warteschlange. Ist es fertig („Bereit“), Kachel erneut antippen, den Geist mit dem Finger verschieben, dann „Bauen“.') +
      '</ul>';
    h += '<h3>Maus &amp; Tastatur</h3><ul class="hl">' +
      li('Linksklick', 'Wählen. Ziehen = Auswahlrahmen. Umschalt = zur Auswahl hinzufügen.') +
      li('Rechtsklick', 'Befehl: bewegen, angreifen, besetzen, erobern.') +
      li('Mausrad', 'Zoom zum Mauszeiger. Mittlere Taste ziehen oder Bildrand = Karte schieben.') +
      li('Tasten', 'WASD / Pfeile Karte · 1–3 Gruppe abrufen · Strg+1–3 speichern · A Angriff-Bewegen · S Stopp · E Aussteigen · F Artillerieschlag · X Superwaffe · R Reparieren · Leertaste Pause · Esc Abbruch · H Hilfe') +
      '</ul>';
    h += '<h3>Kollektiv</h3><ul class="hl">' +   // v1.0
      li('Gedankenkontrolle', 'Psi-Adept, Psi-Koloss und Psi-Turm übernehmen gegnerische Einheiten. Stirbt der Kontrolleur, kehren sie zurück. Jede Einheit lässt sich nur einmal übernehmen; Gebäude, Luftfahrzeuge, Transporter und Psi-Einheiten sind immun.') +
      li('Klonlabor', 'Jede 6. Infanterie-Einheit erscheint doppelt.') +
      li('Recyceln', 'Einheiten wählen und den eigenen Erzwandler antippen: 50 % der Kosten zurück – auch für übernommene Gegner.') +
      li('Schwebepanzer', 'Fährt über Land und Wasser.') +
      li('Psi-Welle', 'Superwaffe: übernimmt alle Gegner-Einheiten im Zielgebiet dauerhaft.') +
      '</ul>';
    h += '<h3>Gebäude besetzen</h3><p class="help">Wähle Infanterie und tippe auf ein Wohnhaus, einen Wohnblock oder einen Bunker (Maus: Rechtsklick). Die Soldaten steigen ein, schießen von drinnen mit mehr Reichweite und nehmen keinen Schaden – das Gebäude trägt ihn. Fällt es aus, kommen sie mit halber Gesundheit heraus. Wähle das Gebäude und tippe „Aussteigen“, um alle herauszuholen.</p>';
    h += '<h3>Gebäude erobern</h3><ul class="hl">' +
      li('Ölbohrturm', '+12 Credits pro Sekunde für den Besitzer.') +
      li('Radarstation', 'Große Sichtweite, Gegner auf der Minimap sichtbar.') +
      li('Feldlazarett', 'Heilt eigene Infanterie in der Nähe.') +
      li('Werkstatt', 'Repariert eigene Fahrzeuge in der Nähe.') +
      li('Artilleriestellung', 'Lädt auf. Wenn bereit: Gebäude wählen, „Artillerieschlag“ antippen, dann das Ziel auf der Karte wählen (Radius 2 Kacheln, Reichweite 30 Kacheln).') +
      '</ul><p class="help">Ein Infanterist, der ein Spezialgebäude betritt, erobert es in 4 Sekunden und wird dabei verbraucht. Der Gegner kann es auf dieselbe Weise zurückerobern.</p>';
    h += '<h3>Bauwarteschlange</h3><ul class="hl">' +
      li('Einreihen', 'Tippe eine Gebäude-Kachel mehrmals an: bis zu 5 Gebäude werden nacheinander gebaut. Die Zahl auf der Kachel zeigt, wie viele noch warten.') +
      li('Bereit', 'Fertige Gebäude warten mit „Bereit (n)“ auf ihren Platz und halten den Bau nicht auf. Kachel antippen = platzieren.') +
      li('Abbrechen', 'Kachel lange drücken: der letzte Eintrag dieses Typs wird gestrichen, das Bezahlte erstattet.') +
      li('Statuszeile', 'Unter den Reitern siehst du die Warteschlange mit Symbolen und dem Fortschritt des laufenden Eintrags.') +
      '</ul>';
    h += '<h3>Mauern</h3><ul class="hl">' +
      li('Bauen', 'Im Reiter „Verteidigung“ die Kachel „Mauer“ antippen: Du bist im Mauer-Modus. Mauern sind nicht in der Warteschlange, kosten ₵ 50 je Segment und stehen sofort.') +
      li('Linie ziehen', 'Mit einem Finger (Maus: Taste gedrückt) auf der Karte von Punkt A nach B ziehen: Es entsteht eine gerade oder L-förmige Linie. Grün = möglich, Rot = blockiert. Unten siehst du die Gesamtkosten.') +
      li('Bestätigen', '„Bauen ✓“ setzt die grünen Segmente. Du bleibst im Mauer-Modus und kannst weitere Linien ziehen, bis du ✕ antippst (Esc). Zum Verschieben der Karte nimmst du zwei Finger.') +
      li('Wirkung', 'Mauern sind unpassierbar, blockieren aber keine Schüsse. Sie müssen an deine Basis anschließen (höchstens 3 Kacheln Abstand oder an eine verbundene Mauer). Gegner greifen sie an, wenn sie den Weg versperren.') +
      '</ul>';
    h += '<h3>Bunker</h3><p class="help">Der Bunker (Verteidigung, braucht eine Kaserne) fasst 4 Infanteristen und gibt ihnen +2 Reichweite. Infanterie wählen und den eigenen Bunker antippen (Maus: Rechtsklick) = besetzen; Bunker wählen und „Aussteigen“ (E) holt alle heraus. Er zählt wie ein normales Gebäude: Er kann verkauft, repariert und vom Gegner mit einem Ingenieur übernommen werden – die Besatzung steigt dann aus. Gegner können ihn nicht besetzen.</p>';
    h += '<h3>Fraktionstürme</h3><ul class="hl">' +
      li('Lasergeschütz', 'Koalition, braucht das Tech-Zentrum. Schießt einen sofort treffenden Strahl (Reichweite 8), stark gegen Fahrzeuge. Braucht Energie – bei Stromausfall feuert es nicht.') +
      li('Blitzturm', 'Syndikat, braucht das Tech-Zentrum. Der Blitz springt auf bis zu zwei weitere Gegner in der Nähe (Reichweite 6,5), stark gegen Infanterie. Braucht Energie – bei Stromausfall feuert er nicht.') +
      '</ul>';
    h += '<h3>Mobiler Bauhof</h3><ul class="hl">' +
      li('Bauen', 'Das Fahrzeugwerk baut den Mobilen Bauhof (₵ 3000, Reiter „Fahrzeuge“). Er fährt wie ein Fahrzeug – zum Beispiel zu einem entfernten Erzfeld.') +
      li('Aufbauen', 'Bauhof wählen und „Aufbauen“ (Taste D) antippen: Eine 3×3-Vorschau zeigt, ob dort Platz ist (grün/rot). „Aufbauen ✓“ verwandelt ihn in ein neues Hauptquartier. Schneller: den Bauhof doppelt antippen.') +
      li('Hinweis', 'Du darfst mehrere Hauptquartiere haben; die Bauwarteschlange bleibt gemeinsam. Die Nähe-Regel gilt für das Aufbauen nicht.') +
      '</ul>';
    h += '<h3>Ton</h3><ul class="hl">' +
      li('Lautsprecher', 'Der Lautsprecher-Knopf oben schaltet allen Ton stumm bzw. wieder an.') +
      li('Regler', 'Im Startmenü und im Pausemenü regelst du Musik, Effekte und Ansagen getrennt. Die Einstellung bleibt gespeichert.') +
      li('Ansagen', 'Kurze Funk-Ansagen melden z. B. „Basis unter Beschuss“, „Zu wenig Credits“ oder „Superwaffe bereit“. Der Ton startet erst nach dem ersten Antippen.') +
      '</ul>';
    h += '<h3>Musik und Stimmen: Quellen</h3><ul class="hl">' + ((G.Audio && G.Audio.credits) || []).map(function (c) {
      return li(c.title, c.author + ' – ' + c.license + (c.note ? ' (' + c.note + ')' : '') + ' – ' + c.url.replace('https://', ''));
    }).join('') + '</ul>';
    h += '<h3>Tech-Zentrum</h3><p class="help">Das Tech-Zentrum (benötigt ein Fahrzeugwerk) schaltet mächtige Einheiten frei: die Mobile Artillerie (Haubitze, große Reichweite, schießt nur stehend), den Jagdpanzer (Koalition) bzw. den Kolosspanzer (Syndikat) – und die Superwaffe deiner Fraktion. Solange es fehlt, steht auf den Kacheln „erst Tech-Zentrum“.</p>';
    h += '<h3>Ingenieur</h3><ul class="hl">' +
      li('Übernehmen', 'Ingenieur wählen und ein gegnerisches Gebäude antippen (Maus: Rechtsklick): Es gehört sofort dir. Der Ingenieur wird dabei verbraucht. Das Hauptquartier geht nicht.') +
      li('Reparieren (Knopf)', 'Knopf „Reparieren“ (Schraubenschlüssel, Taste R) antippen, dann beschädigte eigene Gebäude antippen: Die Reparatur läuft gegen Credits. „Alle beschädigten reparieren“ startet sie überall. Leere Fläche, Esc oder Rechtsklick beenden den Modus. Im Pausemenü gibt es „Automatisch reparieren“.') +
      li('Reparieren', 'Ingenieur auf ein eigenes beschädigtes Gebäude schicken: volle Gesundheit, der Ingenieur wird verbraucht.') +
      '</ul>';
    h += '<h3>Superwaffen</h3><ul class="hl">' +
      li('Orbitalschlag', 'Koalition (Orbital-Leitstelle): Strahl aus dem All, Radius 3 Kacheln, 3 Sekunden Vorwarnung am Ziel.') +
      li('Rakete', 'Syndikat (Raketensilo): Flugzeit 5 Sekunden, Radius 4 Kacheln.') +
      li('Laden', 'Die Ladung dauert 6 Minuten (bei Energiemangel doppelt so lang). Der Knopf links unter der Minimap zeigt den Countdown und pulsiert, sobald die Waffe bereit ist.') +
      li('Feuern', 'Knopf antippen (Taste X), Ziel auf der Karte setzen, „Feuer ✓“. Das Ziel muss erforscht sein. Maus: Klick feuert direkt.') +
      li('Warnung', 'Baut der Gegner eine Superwaffe, siehst du eine rote Warnung mit geschätztem Countdown (antippen = Kamera hin). Bei einem Start erscheint „Superwaffe im Anflug!“ – antippen springt zum Ziel. Zerstöre oder übernimm die Waffe rechtzeitig.') +
      '</ul>';
    h += '<h3>Neue Einheiten</h3><ul class="hl">' +
      li('Scharfschütze', 'Koalition, Kaserne. Sehr große Reichweite (9 Kacheln), schaltet Infanterie mit einem Schuss aus – gegen Fahrzeuge und Gebäude nahezu wirkungslos.') +
      li('Schützenpanzer', 'Koalition, Fahrzeugwerk. Leicht bewaffnet, transportiert bis zu 5 Infanteristen. Infanterie wählen und den eigenen Schützenpanzer antippen (Maus: Rechtsklick) = einsteigen. Schützenpanzer wählen, „Aussteigen (n)“ (Taste E) = alle steigen aus. Die Punkte über dem Panzer zeigen die Besatzung. Passagiere schießen nicht und nehmen keinen Schaden; wird der Panzer zerstört, steigen sie mit halber Gesundheit aus.') +
      li('Laserpanzer', 'Koalition, braucht das Tech-Zentrum. Sofort treffender Strahl, stark gegen Fahrzeuge.') +
      li('Flammenwerfer', 'Syndikat, Kaserne. Kurze Reichweite, Flächenschaden – verheerend gegen Infanterie und Gebäude.') +
      li('Raketenwerfer-Lkw', 'Syndikat, Fahrzeugwerk. Feuert stehend eine Salve aus 6 Raketen (Reichweite 9, mindestens 2 Kacheln Abstand) mit Flächenschaden.') +
      li('Blitzpanzer', 'Syndikat, braucht das Tech-Zentrum. Der Blitz springt auf ein weiteres Ziel über.') +
      li('Sanitäter', 'Beide Fraktionen, Kaserne. Unbewaffnet. Heilt eigene Infanterie im Umkreis von 3 Kacheln und folgt von selbst verletzten Infanteristen in der Nähe. Einfach mit der Truppe mitschicken.') +
      '</ul>';
    // v0.8: Luftwaffe & Marine
    h += '<h3>Luftwaffe und Marine</h3><ul class="hl">' +
      li('Flugfeld', 'Braucht das Fahrzeugwerk. Baut Luftfahrzeuge im Reiter „Luftwaffe“. Jedes Flugfeld hat 4 Landeplätze – mehr Luftfahrzeuge gehen nicht.') +
      li('Luftziele', 'Fliegende Einheiten treffen nur Raketentrupps, Jagdpanzer, Raketenwerfer-Lkw, Zerstörer und die Flak-Stellung. Gelandete Hubschrauber sind dagegen für alle ein Ziel.') +
      li('Transporthubschrauber', 'Fliegt 5 Infanteristen über Wasser und Felsen. Infanterie wählen und den Hubschrauber antippen = einsteigen (er landet dazu). „Aussteigen“ landet ihn auf freiem Land.') +
      li('Kampfhubschrauber', 'Raketen gegen Bodenziele und Schiffe, wehrlos gegen Luftziele.') +
      li('Bomber', 'Gegner oder Boden antippen = Bombenteppich (6 Bomben) über dem Ziel. Danach fliegt er zum Flugfeld zurück und lädt nach.') +
      li('Werft', 'Braucht das Fahrzeugwerk. Mindestens 3 der 9 Kacheln müssen Wasser sein, der Rest bebaubares Ufer; bis zu 5 Kacheln von der Basis entfernt.') +
      li('Schiffe', 'Kanonenboot (schnell), Zerstörer (schwere Geschütze + Flak) und Landungsboot (Infanterie und Fahrzeuge; am Ufer einsteigen, „Aussteigen“ fährt ans nächste Ufer).') +
      '</ul>';
    // v1.2: neue Einheiten und Gebäude
    h += '<h3>Neu in 1.2</h3><ul class="hl">' +
      li('Flakpanzer', 'Alle Fraktionen, Fahrzeugwerk. Mobile Flugabwehr: stark gegen Luftziele, brauchbar gegen Infanterie, schwach gegen Panzer.') +
      li('Reparaturdock', 'Braucht das Fahrzeugwerk. Repariert eigene Fahrzeuge im Umkreis von 3 Kacheln gegen Credits (volle Reparatur = 30 % der Baukosten). Fahrzeuge wählen und „Reparatur“ antippen oder das Dock antippen.') +
      li('Tarnung', 'Saboteure und Minenfelder sind für den Gegner unsichtbar. Aufgedeckt werden sie im Umkreis von Radarwagen (7 Kacheln), Zerstörern (6), Hauptquartier (4), Geschütz- und Abwehrtürmen (3), Ingenieuren (3) und einer eroberten Radarstation (8) – und kurz nach einer eigenen Aktion.') +
      li('Saboteur', 'Kaserne, braucht das Tech-Zentrum. Wehrlos. Gegnerisches Gebäude antippen = Sprengladung (700 Schaden nach 4 s). Mit dem Knopf „Sprengen / Lahmlegen“ den Modus wechseln: Lahmlegen schaltet das Gebäude 20 s ab (keine Produktion, kein Strom, kein Feuer). Danach 40 s Nachladen.') +
      li('Radarwagen', 'Fahrzeugwerk. Unbewaffnet, weite Sicht, deckt Getarntes und Minen im Umkreis von 7 Kacheln auf. Mit der Truppe mitschicken.') +
      li('Minenfeld', 'Reiter Verteidigung, höchstens 8, bis 7 Kacheln von der Basis. Unsichtbar für den Gegner; schädigt gegnerische Infanterie und Fahrzeuge, die darüberfahren (2 Ladungen). Eigene Einheiten lösen nicht aus.') +
      li('U-Boot', 'Koalition und Syndikat, Werft. Getaucht getarnt, Torpedos nur gegen Schiffe; nach jedem Schuss 3 s sichtbar. Zerstörer decken U-Boote auf.') +
      li('Flugzeugträger', 'Koalition und Syndikat, Werft + Tech-Zentrum. Startet bis zu 3 Jäger auf Ziele in 12 Kacheln Reichweite; sie kehren nach 4 Schüssen zurück und laden nach. Abgeschossene Jäger werden kostenlos nachgebaut. Die Jäger lassen sich nicht einzeln steuern – Ziel für den Träger antippen.') +
      li('Psi-Drohne', 'Kollektiv, Diskus-Hangar. Schneller Aufklärer mit großer Sicht; lähmt alle 10 s eine gegnerische Bodeneinheit oder ein Schiff für 4 s.') +
      li('Schwarm-Träger', 'Kollektiv, Kriegsfabrik + Psi-Labor. Setzt 4 Kampfdrohnen auf Ziele in 7 Kacheln aus; sie leben 10 s, kehren zurück und starten nach 7 s erneut.') +
      li('Erzsilo', 'Credits aus Erz passen nur ins Lager: Grundlager 5.000, jede Raffinerie +5.000, jedes Erzsilo +3.000. Ist es voll, warten die Sammler mit dem Abladen – die Credits-Anzeige wird orange (fast voll) bzw. rot (voll). Geht ein Lager verloren, verfällt der Überschuss.') +
      li('Tor', 'Reiter Verteidigung. Mauerstück, das eigene Bodeneinheiten durchlässt und für Gegner wie eine Mauer wirkt.') +
      li('Handelsposten', 'Neutrales Kartengebäude, mit Infanterie erobern: Fahrzeuge werden 10 % günstiger (bis zu 2 Posten zählen).') +
      '</ul>';
    // v1.3: Forschung
    h += '<h3>Neu in 1.3: Forschung</h3><p class="help">Im Tech-Zentrum (Kollektiv: Psi-Labor) erforschst du dauerhafte Verbesserungen für die laufende Partie. Tech-Zentrum antippen und „Forschung“ wählen (Taste T): Die Liste zeigt Kosten, Dauer und Wirkung, Erforschtes ist abgehakt.</p><ul class="hl">' +
      li('Regeln', 'Immer nur eine Forschung gleichzeitig. Bezahlt wird nach und nach wie beim Bauen; „Abbrechen“ erstattet alles bisher Bezahlte. Ohne betriebsbereites Tech-Zentrum pausiert die Forschung (der Fortschritt bleibt), bei Energiemangel läuft sie halb so schnell. Erforschtes bleibt bis zum Ende der Partie – auch wenn das Tech-Zentrum fällt.') +
      li('Für alle', 'Verbundpanzerung I/II (Fahrzeuge und Schiffe je 10 % weniger Schaden), Feuerkraft I/II (alle Einheiten je 8 % mehr Schaden), Großraumlader (Sammler +25 % Ladung), Fernoptik (+1 Kachel Sicht), Instandsetzung (Reparatur 60 % schneller, 25 % günstiger). Stufe II braucht Stufe I.') +
      li('Koalition', 'Zielrechner (Fahrzeuge und Schiffe laden 12 % schneller nach), Präzisionsmunition (Scharfschützen, Jagdpanzer, Haubitzen +18 % Schaden), Luftüberlegenheit (Luftfahrzeuge und Trägerjäger +15 % Schaden und Schutz).') +
      li('Syndikat', 'Fließbandfertigung (Infanterie 15 % günstiger), Bollwerk (Gebäude erleiden 15 % weniger Schaden), Feldinstandsetzung (Fahrzeuge reparieren sich außerhalb des Gefechts langsam selbst).') +
      li('Kollektiv', 'Psi-Fokus (Gedankenkontrolle und Lähmung laden 20 % schneller nach), Schwarmbrut (Schwarmdrohnen +25 % Schaden und Haltbarkeit, Mutanten 15 % robuster), Phasenschleier (Getarntes nach einer Aktion nur halb so lang sichtbar, gegnerische Detektoren reichen 1 Kachel kürzer).') +
      li('KI', 'Auch der Computer forscht – auf „Sehr leicht“ und „Leicht“ spät und wenig.') +
      '</ul>';
    h += '<h3>Kamera</h3><ul class="hl">' +
      li('Diagonal', 'Standard: Die Karte liegt schräg wie bei klassischen Strategiespielen, die Kacheln erscheinen als Rauten. Wischen, Tasten und Bildrand schieben immer in Bildschirmrichtung.') +
      li('Gerade', 'Die Karte ist nach Norden ausgerichtet. Umschalten im Start- oder Pausemenü unter „Grafik → Kamera“ – wirkt sofort, die Bildmitte bleibt.') +
      li('Mauern', 'Die Mauerlinie folgt der Kachelreihe, die deiner ersten Fingerbewegung am nächsten liegt; danach knickt sie bei Bedarf einmal ab (L-Form).') +
      '</ul>';
    h += '<h3>Friedenszeit</h3><p class="help">Im Startmenü wählst du „Friedenszeit“: Aus, 5, 10 oder 15 Minuten (Standard 5). So lange greift die KI nicht an – sie baut nur auf und verteidigt ihre Basis. Oben in der Leiste läuft der Countdown „Frieden 4:32“. Ist die Zeit um, erscheint „Friedenszeit vorbei – der Gegner kann angreifen“.</p>';
    h += '<button class="big" id="hClose">Verstanden</button></div>';
    el.innerHTML = h;
    $('hClose').onclick = hideHelp;
    el.classList.add('show'); el.scrollTop = 0;
  }
  function hideHelp() { $('helpScreen').classList.remove('show'); }
  function toggleHelp() { if ($('helpScreen').classList.contains('show')) hideHelp(); else showHelp(); }

  function onPause(p) {
    $('pausedTag').style.display = 'none';
    var el = $('pauseScreen');
    if (!p) { el.classList.remove('show'); return; }
    var S = G.Sim.S, P = S.players[V.pid];
    var h = '<div class="card panel"><h2>Pause</h2>';
    h += '<div class="stat2"><span>Spielzeit ' + fmtTime(S.tick) + '</span><span>₵ ' + fmtNum(P.credits) + '</span></div>';
    h += '<div class="help" id="pDiff">KI-Stärke: ' + esc(diffName(S.settings.diff || (S.players[1 - V.pid] && S.players[1 - V.pid].ai) || 'medium')) + '</div>';   // v1.0.1 KI-Leicht
    h += '<button class="big alt" id="pResume">Weiter</button>';
    h += '<div class="opt"><div class="lbl">Tempo</div>' + seg('speed', [['slow', 'Langsam'], ['normal', 'Normal'], ['fast', 'Schnell']], V.speed) + '</div>';
    h += '<div class="opt"><div class="lbl">Nebel des Krieges</div>' + seg('fogOff', [['false', 'An'], ['true', 'Aus']], String(!!S.settings.fogOff)) + '</div>';
    h += '<div class="opt"><div class="lbl">Automatisch reparieren (ab ₵ 300)</div>' + seg('autoRepair', [['false', 'Aus'], ['true', 'An']], String(!!P.autoRepair)) + '</div>';   // v0.9.2 Reparatur
    h += '<div class="opt"><div class="lbl">Cheat: unbegrenzt Geld</div>' + seg('cheat', [['false', 'Aus'], ['true', 'An']], String(!!P.cheat)) + '</div>';
    h += gfxOpt();
    h += audioOpt();
    h += '<button class="big gray" id="pHelp">So spielst du</button>';
    h += '<button class="big gray" id="pMenu">Speichern &amp; Hauptmenü</button>';
    h += '<button class="big danger" id="pQuit">Aufgeben</button></div>';
    el.innerHTML = h;
    bindSeg(el, function (k, v) {
      // Anzeige-Einstellungen (kein Eingriff in die Spiellogik)
      if (k === 'speed') { V.speed = v; G.cmd.setOption('speed', v); }
      if (k === 'fogOff') G.cmd.setOption('fogOff', v === 'true');
      if (k === 'autoRepair') G.cmd.setAutoRepair(V.pid, v === 'true');   // v0.9.2 Reparatur
      if (k === 'cheat') G.cmd.setCheat(V.pid, v === 'true');   // v0.8: wirkt sofort, nur für den Menschen
    });
    $('pResume').onclick = function () { G.Main.setPaused(false); };
    $('pHelp').onclick = showHelp;
    bindGfx(el); bindAudio(el);
    $('pMenu').onclick = function () { G.Main.quitToMenu(); };
    var q = $('pQuit');
    q.onclick = function () {
      if (!q.dataset.sure) { q.dataset.sure = '1'; q.textContent = 'Wirklich aufgeben?'; setTimeout(function () { if (q.isConnected) { q.dataset.sure = ''; q.textContent = 'Aufgeben'; } }, 3000); return; }
      G.Save.clear(); V.running = false; V.paused = false; showStart();
    };
    el.classList.add('show'); el.scrollTop = 0;
  }
  function showEnd() {
    var S = G.Sim.S, me = S.players[V.pid], en = S.players[1 - V.pid];
    var win = S.winner === V.pid;
    var rows = [['Einheiten gebaut', 'unitsBuilt'], ['Einheiten verloren', 'unitsLost'], ['Gebäude gebaut', 'buildingsBuilt'],
      ['Gebäude verloren', 'buildingsLost'], ['Abschüsse', 'kills'], ['Helden befördert', 'heroes'], ['Forschungen', 'research'], ['Erz gesammelt', 'ore'], ['Gebäude erobert', 'captures']];
    var h = '<div class="card panel"><div class="banner ' + (win ? 'win' : 'lose') + '"><h1>' + (win ? 'SIEG!' : 'NIEDERLAGE') + '</h1></div>';
    h += '<div class="sub">Dauer ' + fmtTime(S.tick) + '</div><table class="stats"><tr><th></th><th>Du</th><th>Gegner</th></tr>';
    rows.forEach(function (r) { if (me.st[r[1]] == null) return; h += '<tr><td>' + r[0] + '</td><td>' + fmtNum(me.st[r[1]]) + '</td><td>' + fmtNum(en.st[r[1]] || 0) + '</td></tr>'; });
    h += '</table>';
    if (me.cheatUsed) h += '<div class="sub cheatnote">Cheat „unbegrenzt Geld“ wurde benutzt</div>';
    h += '<button class="big" id="eNew">Neue Partie</button></div>';
    var el = $('endScreen');
    el.innerHTML = h;
    try { if (G.Audio && G.Audio.onGameEnd) G.Audio.onGameEnd(win); } catch (e) { /* Ton optional */ }
    $('eNew').onclick = function () { V.running = false; showStart(); };
    el.classList.add('show');
  }

  G.UI = { init: init, update: update, onGameStart: onGameStart, onSelection: onSelection, onPause: onPause,
           showStart: showStart, showEnd: showEnd, showHelp: showHelp, hideHelp: hideHelp, toggleHelp: toggleHelp, toast: toast, setHint: setHint,
           toggleResearch: toggleResearch, researchOpen: function () { return resOpen; }, closeResearch: function () { openResearch(false); } };   // v1.3
})();
