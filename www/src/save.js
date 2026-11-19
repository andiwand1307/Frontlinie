/* FRONTLINIE – save.js
 * G.Save: Serialisierung des Sim-Zustands (inkl. KI-Zustand) und Autosave in localStorage.
 *  serialize(S) → String     Typed Arrays werden lauflängenkodiert ({__ta:'Uint8Array', rle:[wert,anzahl,...]})
 *  deserialize(str) → S      (ohne Laufzeit-Caches; danach G.Sim.setState(S))
 *  save(extra) / load() / has() / clear() / info()   localStorage-Schlüssel 'frontlinie.save.v1'
 * Kurzlebige Daten (Ereignisse) werden nicht gespeichert.
 * v1.2 Versionsprüfung: der Stand trägt S.version (G.DATA.SAVE_VERSION). Ältere Stände (Version fehlt/kleiner) werden geladen und in
 *  G.Sim.rebuild() → migrate() ergänzt. Stände einer NEUEREN Version, mit unbekannten Typen oder defekter Struktur gelten als
 *  „nicht mehr kompatibel“: compatible(S) → '' oder Grund; info()/has() liefern dann nichts und der Stand wird verworfen (kein Absturz).
 * v1.3 Forschung: SAVE_VERSION 3. Der Forschungsstand liegt als reine Daten in S.players[i].res ({done, cur}) und wird unverändert mitgespeichert;
 *  Stände der Versionen 1/2 (ohne res) ergänzt G.Sim.migrate() → migrateV13() (keine Forschung erforscht). Die wirksamen Werte (RM-Cache) baut rebuild() neu auf.
 * v1.3 Fähigkeiten: SAVE_VERSION 4. Zustand als reine Daten (Einheit ab/abT/abCd/zT/zHp/vT/markT/markV, S.zones, S.players[i].abG, st.abil) – wird
 *  unverändert mitgespeichert; Stände der Versionen ≤ 3 ergänzt migrateV14() (keine Wirkfelder, keine Abklingzeiten).
 */
var G = (typeof G !== 'undefined') ? G : {};
(function () {
  'use strict';
  var KEY = 'frontlinie.save.v1';
  var TYPES = { Uint8Array: Uint8Array, Uint16Array: Uint16Array, Int32Array: Int32Array, Uint32Array: Uint32Array, Float32Array: Float32Array };

  function rle(a) {
    var out = [], i = 0, n = a.length;
    while (i < n) {
      var v = a[i], c = 1;
      while (i + c < n && a[i + c] === v) c++;
      out.push(v, c); i += c;
    }
    return out;
  }
  function unrle(type, data) {
    var n = 0, i;
    for (i = 1; i < data.length; i += 2) n += data[i];
    var a = new TYPES[type](n), k = 0;
    for (i = 0; i < data.length; i += 2) { a.fill(data[i], k, k + data[i + 1]); k += data[i + 1]; }
    return a;
  }

  function serialize(S) {
    return JSON.stringify(S, function (key, val) {
      if (key === 'events') return [];
      if (val && typeof val === 'object' && ArrayBuffer.isView && ArrayBuffer.isView(val)) {
        return { __ta: val.constructor.name, rle: rle(val) };
      }
      return val;
    });
  }
  function deserialize(str) {
    return JSON.parse(str, function (key, val) {
      if (val && typeof val === 'object' && val.__ta) return unrle(val.__ta, val.rle);
      return val;
    });
  }

  function store() { try { return (typeof localStorage !== 'undefined') ? localStorage : null; } catch (e) { return null; } }

  /** v1.2: '' wenn der (deserialisierte) Zustand geladen werden kann, sonst der Grund. */
  function compatible(st) {
    var D = G.DATA, cur = D.SAVE_VERSION || 1;
    if (!st || typeof st !== 'object' || !st.map || !st.players || !st.players.length || !Array.isArray(st.ents) || !st.occ) return 'Spielstand defekt';
    if ((st.version || 1) > cur) return 'Spielstand stammt aus einer neueren Version';
    for (var p = 0; p < st.players.length; p++) if (!D.FACTIONS[st.players[p].faction] || !st.players[p].q) return 'Spielstand nicht mehr kompatibel';
    for (var i = 0; i < st.ents.length; i++) {
      var e = st.ents[i];
      if (!e || !(e.kind === 'unit' ? D.UNITS[e.type] : D.BUILDINGS[e.type])) return 'Spielstand nicht mehr kompatibel';
    }
    return '';
  }

  /** Speichert G.Sim.S plus Zusatzdaten (z. B. Kamera, Spieler-ID). */
  function save(extra) {
    var ls = store(), S = G.Sim && G.Sim.S;
    if (!ls || !S || S.over) return false;
    try {
      ls.setItem(KEY, JSON.stringify({ when: Date.now(), tick: S.tick, v: G.DATA.SAVE_VERSION || 1, extra: extra || {}, state: serialize(S) }));
      return true;
    } catch (e) { return false; }
  }
  /** Lädt den Spielstand, setzt ihn aktiv. → extra-Objekt oder null. */
  function load() {
    var ls = store();
    if (!ls) return null;
    try {
      var o = JSON.parse(ls.getItem(KEY));
      if (!o) return null;
      var st = deserialize(o.state);
      if (compatible(st)) { clear(); return null; }   // v1.2: nicht mehr kompatibel → verwerfen
      var prev = G.Sim.S;
      try { G.Sim.setState(st); }
      catch (e2) { if (prev) { try { G.Sim.setState(prev); } catch (e3) { /* egal */ } } clear(); return null; }
      return o.extra || {};
    } catch (e) { return null; }
  }
  function info() {
    var ls = store();
    if (!ls) return null;
    try {
      var o = JSON.parse(ls.getItem(KEY));
      if (!o) return null;
      if ((o.v || 1) > (G.DATA.SAVE_VERSION || 1) || typeof o.state !== 'string') { clear(); return null; }   // v1.2: neuere Version/defekt → verwerfen
      return { when: o.when, tick: o.tick, v: o.v || 1 };
    } catch (e) { clear(); return null; }
  }
  function has() { return !!info(); }
  function clear() { var ls = store(); if (ls) try { ls.removeItem(KEY); } catch (e) { /* egal */ } }

  G.Save = { serialize: serialize, deserialize: deserialize, save: save, load: load, has: has, clear: clear, info: info, compatible: compatible };
})();
