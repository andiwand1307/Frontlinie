// Aufruf: node scene.js <outdir> <prefix> [mobile]
const { chromium, devices } = require('playwright');
(async () => {
  const out = process.argv[2], pre = process.argv[3], mob = process.argv[4] === 'mobile';
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await b.newContext(mob ? { ...devices['Pixel 7'] } : { viewport: { width: 1280, height: 720 } });
  const pg = await ctx.newPage();
  const errs = []; pg.on('pageerror', e => errs.push('' + e)); pg.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await pg.goto('http://localhost:8765/'); await pg.waitForTimeout(1000);
  await pg.evaluate(() => {
    G.Main.start({ faction: 'coalition', mapId: 'seenplatte', diff: 'easy', fogOff: true, peace: 15, speed: 'normal', seed: 4242 });
    const S = G.Sim.S, m = S.map, T = G.DATA.TERRAIN; let best = null, bd = 1e9;
    for (let y = 6; y < m.h - 6; y++) for (let x = 6; x < m.w - 6; x++) {
      if (T[m.terrain[y * m.w + x]].id !== 'grass') continue; let near = false;
      for (let k = 0; k < 16 && !near; k++) { const a = k / 16 * 6.283, tx = Math.round(x + Math.cos(a) * 5), ty = Math.round(y + Math.sin(a) * 5); if (T[m.terrain[ty * m.w + tx]] && T[m.terrain[ty * m.w + tx]].id === 'water') near = true; }
      const d = Math.abs(x - m.w / 2) + Math.abs(y - m.h / 2) + (near ? 0 : 30); if (d < bd) { bd = d; best = { x, y }; }
    }
    window.__c = best;
    const W = [['tank', 0, -3], ['tank', 1, -1], ['rifle', 0, 1], ['rocket', 1, 2], ['scout', 0, 3]];
    for (const w of W) for (let o = 0; o < 2; o++) { const u = G.Sim._debugSpawn(o, w[0], (best.x + (o ? 4 : -4)) * 32 + 16, (best.y + w[2] * 0.8) * 32 + 16); if (u) G.Sim._orderMove(u, (best.x + (o ? -5 : 5)) * 32, (best.y + w[2]) * 32); }
    G.view.cam.zoom = 1.3; G.view.centerOn(best.x * 32, best.y * 32);
  });
  await pg.waitForTimeout(9000);
  await pg.screenshot({ path: `${out}/${pre}_battle.png` });
  await pg.evaluate(() => { const S = G.Sim.S; const hq = S.ents.find(e => e.kind === 'bld' || e.kind === 'building' || e.w); G.view.cam.zoom = 1.0; if (hq) G.view.centerOn(hq.x, hq.y); });
  await pg.waitForTimeout(2500);
  await pg.screenshot({ path: `${out}/${pre}_base.png` });
  console.log(JSON.stringify(await pg.evaluate(() => G.Render.info())));
  console.log('ERR', errs.slice(0, 5));
  await b.close();
})();
