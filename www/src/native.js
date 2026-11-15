/* Frontlinie – native Huelle (Capacitor/Android). Ausserhalb von Capacitor passiert nichts.
 * Zurueck-Taste: laufende Partie -> Pause umschalten, Startmenue -> App minimieren. */
(function () {
  'use strict';
  var C = window.Capacitor;
  if (!C || !(C.isNativePlatform ? C.isNativePlatform() : C.getPlatform && C.getPlatform() !== 'web')) return;
  var App = C.registerPlugin ? C.registerPlugin('App') : (C.Plugins && C.Plugins.App);
  if (!App || !App.addListener) return;
  App.addListener('backButton', function () {
    var G = window.G, V = G && G.view;
    if (V && V.running && G.Main && G.Main.togglePause) G.Main.togglePause();
    else if (App.minimizeApp) App.minimizeApp();
    else if (App.exitApp) App.exitApp();
  });
})();
