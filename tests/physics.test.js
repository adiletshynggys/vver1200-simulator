// Run with: node --test tests/physics.test.js   (Node 18+)
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../js/physics.js');

function run(R, seconds) { for (let t = 0; t < seconds; t += 0.1) R.advance(0.1); }

test('layouts match the VVER-1200 core and TVS-2006 assembly', () => {
  const core = P.buildCore();
  assert.equal(core.cells.length, 163);
  assert.equal(core.cells.filter(c => c.rodded).length, 121);
  const pins = P.buildAssembly();
  const n = t => pins.filter(p => p.type === t).length;
  assert.equal(pins.length, 331);
  assert.equal(n('fuel') + n('gd'), 312);
  assert.equal(n('guide'), 18);
  assert.equal(n('center'), 1);
  assert.equal(new Set(pins.map(p => p.q + ',' + p.r)).size, 331);
});

test('assembly powers average to one', () => {
  const core = P.buildCore();
  const K = P.assemblyPowers(core, P.C.X0, 0);
  const mean = K.reduce((a, b) => a + b, 0) / K.length;
  assert.ok(Math.abs(mean - 1) < 1e-9);
  assert.ok(Math.max(...K) < 1.6 && Math.min(...K) > 0.5);
});

test('steady state holds at full power', () => {
  const R = P.createReactor();
  run(R, 60);
  assert.ok(Math.abs(R.S.n - 1) < 1e-3);
  assert.ok(Math.abs(R.coreOut() - 325) < 0.2);
  assert.ok(Math.abs(R.coreIn() - 298.2) < 0.2);
  assert.ok(Math.abs(R.S.Ps * P.C.PE_NOM - 1200) < 2);
});

test('lowering then raising the rods brings power back', () => {
  const R = P.createReactor();
  R.setRodHeight(40); run(R, 120);
  assert.ok(R.S.Pth < 0.4, 'power should fall well below full');
  R.setRodHeight(70); run(R, 200);
  assert.ok(Math.abs(R.S.Pth - 1) < 0.01, 'power should return to 100 %');
  assert.equal(R.S.scram, false);
});

test('withdrawal above nominal stops at the 104 % interlock without a trip', () => {
  const R = P.createReactor();
  R.setRodHeight(100); run(R, 200);
  assert.equal(R.S.scram, false);
  assert.ok(R.S.Pth > 1.02 && R.S.Pth < 1.06);
  assert.match(R.S.block, /104/);
});

test('scram, reset and restart reach full power again', () => {
  const R = P.createReactor();
  R.scram('test'); run(R, 60);
  assert.ok(R.S.Pth < 0.05, 'only decay heat after a scram');
  R.resetProtection(); run(R, 140);
  assert.ok(R.S.sdX === 0 && R.S.rho < 0, 'subcritical with shutdown banks out');
  R.setRodHeight(70); run(R, 900);
  assert.equal(R.S.scram, false);
  assert.ok(Math.abs(R.S.Pth - 1) < 0.01);
});

test('losing two coolant pumps trips the reactor', () => {
  const R = P.createReactor();
  R.S.pumps[0] = R.S.pumps[1] = false; run(R, 10);
  assert.equal(R.S.scram, true);
});

test('fuel rod temperatures are physically sensible', () => {
  assert.ok(Math.abs(P.kUO2(1000 - 273.15) - 3.47) < 0.02); // Fink 2000 at 1000 K
  const q = P.qAvg(1);
  assert.ok(Math.abs(q / 1000 - 16.87) < 0.05);           // average linear heat rate, kW/m
  const r = P.rodProfile(q * P.C.KZ_MID, 311.6, 1, false);
  assert.ok(r.Tc > 850 && r.Tc < 1150, 'average rod centre ' + r.Tc);
  assert.ok(r.Tc > r.Tps && r.Tps > r.Tci && r.Tci > r.Tco && r.Tco > r.Tcool);
});

/* ---------- accident scenarios ---------- */
function scenario(id, seconds, autoProt) {
  const R = P.createReactor();
  R.S.autoProt = autoProt !== false;
  assert.ok(R.runScenario(id), 'unknown scenario ' + id);
  let minDnbr = Infinity;
  for (let t = 0; t < seconds; t += 0.1) { R.advance(0.1); if (R.S.t > 5) minDnbr = Math.min(minDnbr, R.S.dnbr); }
  return { R, S: R.S, minDnbr, said: re => R.S.log.some(l => re.test(l.text)) };
}

test('every scenario has a name and at least one event', () => {
  assert.equal(new Set(P.SCENARIOS.map(s => s.id)).size, P.SCENARIOS.length);
  P.SCENARIOS.forEach(s => { assert.ok(s.name && s.what && s.group); assert.ok(s.events.length >= 1); });
});

test('loss of all pumps: flywheel coastdown, scram, then natural circulation', () => {
  const R = P.createReactor(); R.runScenario('lofa');
  run(R, 15);
  assert.ok(R.S.flow > 0.5 && R.S.flow < 0.7, 'flow coasts down, not instantly: ' + R.S.flow);
  const r = scenario('lofa', 900);
  assert.equal(r.S.scram, true);
  assert.ok(r.minDnbr > P.C.DNBR_LIM, 'scram keeps DNB margin: ' + r.minDnbr);
  assert.ok(r.S.natural && r.S.flow > 0.02 && r.S.flow < 0.06);
  assert.ok(r.R.hotOut() < P.C.TSAT_P, 'decay heat removed without boiling');
});

test('loss of all pumps without scram: feedback cuts power but the fuel loses DNB margin', () => {
  const r = scenario('lofa', 300, false);
  assert.equal(r.S.scram, false);
  assert.ok(r.S.Pth < 0.4, 'moderator feedback pulls power down: ' + r.S.Pth);
  assert.ok(r.minDnbr < P.C.DNBR_LIM);
  assert.ok(r.said(/boiling point/));
});

test('one pump trip runs the reactor back to about two thirds power without a scram', () => {
  const r = scenario('pump1', 300);
  assert.equal(r.S.scram, false);
  assert.ok(r.S.Pth > 0.6 && r.S.Pth < 0.78, 'power ' + r.S.Pth);
  assert.ok(Math.abs(r.S.flow - 0.75) < 0.03);
  assert.equal(r.S.log.filter(l => /power reduction drives/.test(l.text)).length, 1);
});

test('a seized pump drops flow at once and trips the reactor', () => {
  const R = P.createReactor(); R.runScenario('seize');
  run(R, 5.2);
  assert.ok(R.S.flow < 0.7, 'flow falls immediately: ' + R.S.flow);
  assert.equal(R.S.scram, true);
});

test('loss of feedwater: low steam generator level trips, emergency feedwater refills', () => {
  const r = scenario('lofw', 1200);
  assert.ok(r.said(/water level low/));
  assert.equal(r.S.efw, true);
  assert.ok(r.S.sg > P.C.SG_LOW - 0.05, 'level recovering: ' + r.S.sg);
  assert.ok(r.R.hotOut() < P.C.TSAT_P);
});

test('station blackout: passive heat removal keeps the core cool with no AC power', () => {
  const r = scenario('sbo', 1800);
  assert.equal(r.S.scram, true);
  assert.equal(r.S.phrs, true);
  assert.equal(r.S.efw, false);
  assert.ok(r.S.sg > 0.8, 'steam condensed and returned, little water lost: ' + r.S.sg);
  assert.ok(r.R.hotOut() < P.C.TSAT_P);
});

test('uncontrolled rod withdrawal trips on high power; without protection it settles above 110 %', () => {
  const r = scenario('rodw', 60);
  assert.ok(r.said(/power above 112/));
  const a = scenario('rodw', 300, false);
  assert.ok(a.S.Pth > 1.1 && a.S.Pth < 1.4, 'feedback limits the excursion: ' + a.S.Pth);
  assert.ok(a.minDnbr < P.C.DNBR_LIM);
});
