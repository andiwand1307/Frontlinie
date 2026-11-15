/* FRONTLINIE – save.js
 * G.Save: Serialisierung des Sim-Zustands (inkl. KI-Zustand) und Autosave in localStorage.
 *  serialize(S) → String     Typed Arrays werden lauflängenkodiert ({__ta:'Uint8Array', rle:[wert,anzahl,...]})
 *  deserialize(str) → S      (ohne Laufzeit-Caches; danach G.Sim.setState(S))
 *  save(extra) / load() / has() / clear() / info()   localStorage-Schlüssel 'frontlinie.save.v1'
 * Kurzlebige Daten (Ereignisse) werden nicht gespeichert.
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

  /** Speichert G.Sim.S plus Zusatzdaten (z. B. Kamera, Spieler-ID). */
  function save(extra) {
    var ls = store(), S = G.Sim && G.Sim.S;
    if (!ls || !S || S.over) return false;
    try {
      ls.setItem(KEY, JSON.stringify({ when: Date.now(), tick: S.tick, extra: extra || {}, state: serialize(S) }));
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
      G.Sim.setState(deserialize(o.state));
      return o.extra || {};
    } catch (e) { return null; }
  }
  function info() {
    var ls = store();
    if (!ls) return null;
    try { var o = JSON.parse(ls.getItem(KEY)); return o ? { when: o.when, tick: o.tick } : null; } catch (e) { return null; }
  }
  function has() { return !!info(); }
  function clear() { var ls = store(); if (ls) try { ls.removeItem(KEY); } catch (e) { /* egal */ } }

  G.Save = { serialize: serialize, deserialize: deserialize, save: save, load: load, has: has, clear: clear, info: info };
})();
