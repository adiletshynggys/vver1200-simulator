/*
 * VVER-1200 teaching model.
 * Point kinetics (6 delayed groups, U-235) + two-lump thermal model + simple secondary side.
 * Also: core and fuel assembly layouts, assembly power shares and a fuel rod
 * radial temperature solver. Runs in the browser (window.VVERPhysics) and in Node (require).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VVERPhysics = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  /* ---------- kinetics data (U-235 thermal fission) ---------- */
  const BETA = [2.15e-4, 1.424e-3, 1.274e-3, 2.568e-3, 7.48e-4, 2.73e-4];
  const LAMB = [0.0124, 0.0305, 0.111, 0.301, 1.14, 3.01];
  const BT = BETA.reduce((a, b) => a + b, 0);

  /* ---------- plant and model constants ---------- */
  const C = {
    GEN: 2e-5,              // prompt neutron generation time, s
    P_NOM: 3200,            // MWt
    PE_NOM: 1200,           // MWe gross
    TF0: 900,               // core-average fuel temperature at 100 %, °C (lumped)
    TM0: 311.6,             // core-average coolant temperature at 100 %, °C
    TS: 285.8,              // saturation temperature at 7.0 MPa, °C
    DT_CORE: 26.8,          // core ΔT at 100 % power and flow, K
    P_PRIMARY: 16.2, P_STEAM: 7.0,
    W_REG: 3000,            // regulating group worth, pcm (exaggerated, see README)
    W_SD: 9000,             // shutdown banks worth, pcm
    A_D: -2.2,              // Doppler coefficient, pcm/K
    A_M: -25,               // moderator temperature coefficient, pcm/K
    B0: 600, DB: -12,       // boric acid reference, ppm; worth pcm/ppm
    X0: 0.30,               // regulating group insertion at 100 % power (70 % of core height)
    ROD_SPEED: 0.01,        // fraction of core height per second (real VVER ≈ 0.005)
    SD_DROP_ACC: 1.4, SD_DROP_VMAX: 0.45, SD_OUT_SPEED: 0.008,
    BORON_RATE: 1.5,        // ppm/s
    DH_A: [0.015, 0.02, 0.03], DH_T: [3, 40, 1000],
    SRC: 3e-4,              // neutron source term, relative units per s
    TRIP_POWER: 1.12, TRIP_TOUT: 335, TRIP_PERIOD: 10,
    BLOCK_PERIOD: 20, BLOCK_POWER: 1.04, BLOCK_TOUT: 330,
    N_FA: 163, PINS_PER_FA: 312, ACTIVE_H: 3.73, KZ_MID: 1.3,
    ETA: 1200 / 3200,
    BETA_TOTAL: BT
  };
  C.N_RODS = C.N_FA * C.PINS_PER_FA;
  C.DH_SUM = C.DH_A.reduce((a, b) => a + b, 0);
  const RF = C.TF0 - C.TM0, CF = 5 / RF, KSG = 1 / (C.TM0 - C.TS), CM = 0.3;

  /** integral rod worth, S-curve, x = fraction inserted */
  const worth = x => x - Math.sin(2 * Math.PI * x) / (2 * Math.PI);

  function createReactor() {
    const S = {};

    function reset() {
      Object.assign(S, {
        n: 1, C: BETA.map((b, i) => b / (C.GEN * LAMB[i])), D: C.DH_A.slice(),
        Tf: C.TF0, Tm: C.TM0,
        rodX: C.X0, rodTarget: C.X0, sdX: 0, sdV: 0,
        scram: false, trip: '', block: '',
        boron: C.B0, boronTarget: C.B0,
        pumps: [true, true, true, true], flow: 1,
        Ps: 1, online: true, rpm: 3000,
        inv: 0, period: Infinity, rho: 0, parts: { rods: 0, boron: 0, dop: 0, mod: 0 },
        Pth: 1, qsg: 1, t: 0
      });
    }

    const regX = () => Math.max(S.rodX, S.sdX);
    const coreDT = () => Math.min(C.DT_CORE * S.Pth / Math.max(S.flow, 0.04), 120);
    const coreOut = () => S.Tm + coreDT() / 2;
    const coreIn = () => S.Tm - coreDT() / 2;
    const decayHeat = () => S.D[0] + S.D[1] + S.D[2];
    const pumpsOn = () => S.pumps.filter(Boolean).length;
    const onGrid = () => S.online && S.rpm >= 2999;
    const rodHeight = () => (1 - regX()) * 100;
    const targetHeight = () => (1 - S.rodTarget) * 100;

    function scram(reason) {
      if (S.scram) return;
      S.scram = true; S.trip = reason || 'Scram'; S.online = false; S.sdV = 0; S.rodTarget = 1;
    }
    function resetProtection() {
      if (!S.scram) return;
      S.scram = false; S.trip = '';
      S.rodX = Math.max(S.rodX, S.sdX); S.rodTarget = S.rodX;
    }
    /** h: target position in % of core height, 100 = fully withdrawn */
    function setRodHeight(h) { S.rodTarget = clamp(1 - h / 100, 0, 1); }
    function holdRods() { S.rodTarget = S.rodX; }
    function startTurbine() { if (!S.scram && S.Pth > 0.08) { S.online = true; return true; } return false; }
    function tripTurbine() { S.online = false; }

    function step(dt) {
      // regulating group drive with interlocks on withdrawal
      const wantUp = S.rodTarget < S.rodX - 1e-9;
      let block = '';
      if (wantUp) {
        if (S.scram) block = 'Rods held in by emergency protection';
        else if (S.sdX > 0.001) block = 'Waiting for the shutdown banks to withdraw';
        else if (S.period > 0 && S.period < C.BLOCK_PERIOD) block = 'Withdrawal blocked: period below 20 s';
        else if (S.Pth > C.BLOCK_POWER) block = 'Withdrawal blocked: power above 104 %';
        else if (coreOut() > C.BLOCK_TOUT) block = 'Withdrawal blocked: core outlet above 330 °C';
      }
      S.block = block;
      if (!block) S.rodX += clamp(S.rodTarget - S.rodX, -C.ROD_SPEED * dt, C.ROD_SPEED * dt);

      // shutdown banks: gravity drop on scram, slow withdrawal after reset
      if (S.scram) {
        S.sdV = Math.min(S.sdV + C.SD_DROP_ACC * dt, C.SD_DROP_VMAX);
        S.sdX = Math.min(1, S.sdX + S.sdV * dt);
        if (S.sdX >= 1) { S.rodX = 1; S.rodTarget = 1; }
      } else if (S.sdX > 0) {
        S.sdX = Math.max(0, S.sdX - C.SD_OUT_SPEED * dt);
      }

      S.boron += clamp(S.boronTarget - S.boron, -C.BORON_RATE * dt, C.BORON_RATE * dt);

      const on = pumpsOn(), fT = Math.max(on / 4, 0.04);
      S.flow += (fT - S.flow) * dt / (fT < S.flow ? 8 : 4);

      // reactivity, pcm
      const pr = -C.W_REG * (worth(regX()) - worth(C.X0)) - C.W_SD * worth(S.sdX);
      const pb = C.DB * (S.boron - C.B0), pd = C.A_D * (S.Tf - C.TF0), pm = C.A_M * (S.Tm - C.TM0);
      S.rho = pr + pb + pd + pm;
      S.parts = { rods: pr, boron: pb, dop: pd, mod: pm };
      const r = S.rho * 1e-5;

      // point kinetics, implicit in n (stiff), implicit precursors
      let src = 0;
      for (let i = 0; i < 6; i++) src += LAMB[i] * S.C[i];
      S.n = (S.n + dt * (src + C.SRC)) / (1 - dt * (r - BT) / C.GEN);
      if (S.n < 1e-12) S.n = 1e-12;
      for (let i = 0; i < 6; i++) S.C[i] = (S.C[i] + dt * BETA[i] / C.GEN * S.n) / (1 + dt * LAMB[i]);
      for (let i = 0; i < 3; i++) S.D[i] += (C.DH_A[i] * S.n - S.D[i]) * dt / C.DH_T[i];

      // fuel and coolant lumps
      const Pth = S.n * (1 - C.DH_SUM) + decayHeat();
      const qfc = (S.Tf - S.Tm) / RF;
      S.Tf += (Pth - qfc) * dt / CF;
      const hx = Math.pow(Math.max(S.flow, 0.04), 0.8);
      const qsg = Math.max(0, KSG * hx * (S.Tm - C.TS));
      S.Tm += (qfc - qsg) * dt / CM;
      S.Pth = Pth; S.qsg = qsg;

      // turbine-generator
      if (S.online) {
        if (S.rpm < 3000) S.rpm = Math.min(3000, S.rpm + 60 * dt);
        const tgt = S.rpm >= 2999 ? qsg : 0;
        S.Ps += (tgt - S.Ps) * dt / 3;
      } else {
        S.Ps += (0 - S.Ps) * Math.min(1, dt / 0.5);
        S.rpm = Math.max(0, S.rpm - (S.rpm * 0.004 + 1.5) * dt);
      }

      // emergency protection
      if (!S.scram) {
        if (Pth > C.TRIP_POWER) scram('Scram: power above 112 %');
        else if (coreOut() > C.TRIP_TOUT) scram('Scram: core outlet above 335 °C');
        else if (on <= 2 && S.n > 0.3) scram('Scram: two or more coolant pumps lost');
      }
      S.t += dt;
    }

    /** advance the model by simDt seconds of plant time */
    function advance(simDt) {
      if (!(simDt > 0)) return;
      const N = Math.max(1, Math.ceil(simDt / (1 / 600))), h = simDt / N, ln0 = Math.log(S.n);
      for (let i = 0; i < N; i++) step(h);
      const dl = (Math.log(S.n) - ln0) / simDt;
      S.inv += (dl - S.inv) * Math.min(1, simDt / 0.8);
      S.period = Math.abs(S.inv) < 1e-3 ? Infinity : 1 / S.inv;
      // period protection works in the source and intermediate ranges
      if (!S.scram && S.period > 0 && S.period < C.TRIP_PERIOD && S.n > 1e-4 && S.n < 0.1) {
        scram('Scram: reactor period below 10 s');
      }
    }

    reset();
    return {
      S, reset, step, advance, scram, resetProtection, setRodHeight, holdRods,
      startTurbine, tripTurbine, regX, coreDT, coreIn, coreOut, decayHeat, pumpsOn, onGrid,
      rodHeight, targetHeight
    };
  }

  /* ---------- core layout: 163 hexagonal assemblies ---------- */
  function buildCore() {
    const cells = [];
    for (let q = -7; q <= 7; q++) for (let r = -7; r <= 7; r++) {
      const s = -q - r;
      if (Math.abs(s) > 7) continue;
      const big = [Math.abs(q), Math.abs(r), Math.abs(s)].filter(v => v === 7).length;
      if (big >= 2) continue;                                   // drop the 6 corners: 169 - 6 = 163
      cells.push({ q, r, s, ring: Math.max(Math.abs(q), Math.abs(r), Math.abs(s)) });
    }
    // number row by row, top to bottom, left to right
    cells.forEach(c => { c.u = c.q + c.r / 2; c.v = c.r * Math.sqrt(3) / 2; c.rr = Math.hypot(c.u, c.v); });
    cells.sort((a, b) => (a.r - b.r) || (a.q - b.q));
    cells.forEach((c, i) => { c.id = i + 1; });
    // illustrative low-leakage loading: burned fuel on the rim, fresh/once-burned checkerboard inside
    cells.forEach(c => {
      if (c.ring >= 6) c.batch = (c.ring === 7 || ((c.q - c.r) % 3 + 3) % 3 === 0) ? 2 : 1;
      else c.batch = (((c.q - c.r) % 3 + 3) % 3 === 0) ? 0 : (((c.q + 2 * c.r) % 2 + 2) % 2 === 0 ? 1 : 2);
      if (c.ring === 0) c.batch = 2;
    });
    // 121 control clusters, chosen deterministically; every 6th is in the regulating group
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    cells.forEach(c => { c.h = rnd(); c.rodded = false; c.group = null; });
    cells.slice().sort((a, b) => a.h - b.h).slice(0, 121).forEach((c, i) => {
      c.rodded = true; c.group = (i % 6 === 0) ? 'reg' : 'sd';
    });
    const R = Math.max(...cells.map(c => c.rr)) + 0.5;
    cells.forEach(c => { c.shape = 1 - 0.45 * Math.pow(c.rr / R, 2); });
    return { cells, R };
  }

  const BATCH = [
    { name: 'Fresh fuel', burnup: 0, factor: 1.10 },
    { name: 'One cycle in core', burnup: 18, factor: 1.0 },
    { name: 'Two cycles in core', burnup: 36, factor: 0.86 }
  ];

  /** relative assembly powers Kq (core average = 1); rods depress power where they are inserted */
  function assemblyPowers(core, regIns, sdIns) {
    const raw = core.cells.map(c => {
      let ins = 0;
      if (c.rodded) ins = c.group === 'reg' ? regIns : sdIns;
      return c.shape * BATCH[c.batch].factor * (1 - 0.35 * ins);
    });
    const mean = raw.reduce((a, b) => a + b, 0) / raw.length;
    return raw.map(v => v / mean);
  }

  /* ---------- fuel assembly: 331 positions = 312 fuel rods + 18 guide channels + 1 central tube ---------- */
  function buildAssembly() {
    const pins = [];
    const dirs = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
    pins.push({ q: 0, r: 0, ring: 0, side: 0, j: 0, type: 'center' });
    for (let k = 1; k <= 10; k++) {
      let q = -k, r = k;                       // start corner, then walk the six sides
      for (let s = 0; s < 6; s++) {
        for (let j = 0; j < k; j++) {
          pins.push({ q, r, ring: k, side: s, j, type: 'fuel' });
          q += dirs[s][0]; r += dirs[s][1];
        }
      }
    }
    pins.forEach(p => {
      if ((p.ring === 3 && p.j === 0) || (p.ring === 5 && (p.j === 2 || p.j === 3))) p.type = 'guide';
      else if (p.ring === 7 && p.j === 3) p.type = 'gd';
    });
    pins.forEach((p, i) => {
      p.id = i + 1;
      p.x = 12.75 * (p.q + p.r / 2);
      p.y = 12.75 * (p.r * Math.sqrt(3) / 2);
    });
    // pin power factors: rods near the water gap run a little hotter; normalised over fuel rods
    const fuel = pins.filter(p => p.type === 'fuel' || p.type === 'gd');
    fuel.forEach(p => { p.kraw = 0.96 + 0.09 * Math.pow(p.ring / 10, 2); });
    const m = fuel.reduce((a, p) => a + p.kraw, 0) / fuel.length;
    fuel.forEach(p => { p.kpin = p.kraw / m; });
    return pins;
  }
  function pinFactor(pin, batch) {
    if (pin.type === 'gd') return pin.kpin * (batch === 0 ? 0.72 : 0.95);
    return pin.kpin || 0;
  }

  /* ---------- fuel rod radial temperatures ---------- */
  const ROD = {
    R_CO: 4.55e-3, R_CI: 3.865e-3, R_P: 3.8e-3, R_H: 0.6e-3, PITCH: 12.75e-3,
    K_CLAD: 17, H_GAP: 6000, T_MELT: 2840
  };
  /** UO2 thermal conductivity, 95 % dense (Fink 2000), W/m·K; T in °C */
  function kUO2(Tc) {
    const t = (Tc + 273.15) / 1000;
    return 100 / (7.5408 + 17.692 * t + 3.6142 * t * t) + 6400 / Math.pow(t, 2.5) * Math.exp(-16.35 / t);
  }
  /**
   * q: linear heat rate, W/m; Tcool: bulk coolant, °C; flow: fraction of nominal; gd: gadolinia rod
   * returns temperatures in °C and a profile [{r (mm), T}] from the pellet centre to the cell edge
   */
  function rodProfile(q, Tcool, flow, gd) {
    q = Math.max(q, 0);
    const h = Math.max(5000, 34000 * Math.pow(Math.max(flow, 0.04), 0.8));
    const flux = q / (2 * Math.PI * ROD.R_CO);
    const Tco = Tcool + flux / h;
    const Tci = Tco + q / (2 * Math.PI * ROD.K_CLAD) * Math.log(ROD.R_CO / ROD.R_CI);
    const Tps = Tci + q / (2 * Math.PI * ROD.R_P * ROD.H_GAP);
    const qv = q / (Math.PI * (ROD.R_P * ROD.R_P - ROD.R_H * ROD.R_H));
    const kf = gd ? 0.8 : 1;
    const N = 80, dr = (ROD.R_P - ROD.R_H) / N;
    const pellet = [{ r: ROD.R_P, T: Tps }];
    let T = Tps;
    for (let i = 0; i < N; i++) {
      const r = ROD.R_P - i * dr;
      const g = rr => qv / 2 * (rr - ROD.R_H * ROD.R_H / rr);
      const k1 = kUO2(T) * kf;
      const Tm = T + g(r) / k1 * dr / 2;
      const k2 = kUO2(Tm) * kf;
      T = T + g(r - dr / 2) / k2 * dr;
      pellet.push({ r: r - dr, T });
    }
    const Tc = T;
    const profile = [{ r: 0, T: Tc }];
    for (let i = pellet.length - 1; i >= 0; i--) profile.push({ r: pellet[i].r * 1e3, T: pellet[i].T });
    profile.push({ r: ROD.R_CI * 1e3, T: Tci });
    for (let i = 1; i <= 6; i++) {
      const r = ROD.R_CI + (ROD.R_CO - ROD.R_CI) * i / 6;
      profile.push({ r: r * 1e3, T: Tci - (Tci - Tco) * Math.log(r / ROD.R_CI) / Math.log(ROD.R_CO / ROD.R_CI) });
    }
    profile.push({ r: ROD.R_CO * 1e3 + 0.15, T: Tcool + (Tco - Tcool) * 0.25 });
    profile.push({ r: ROD.R_CO * 1e3 + 0.35, T: Tcool });
    profile.push({ r: ROD.PITCH / 2 * 1e3, T: Tcool });
    return { Tc, Tps, Tci, Tco, Tcool, flux, h, profile, q };
  }

  /** average linear heat rate in the core, W/m, for relative thermal power p */
  const qAvg = p => p * C.P_NOM * 1e6 / (C.N_RODS * C.ACTIVE_H);

  return {
    C, BETA, LAMB, worth, createReactor, buildCore, assemblyPowers, BATCH,
    buildAssembly, pinFactor, ROD, kUO2, rodProfile, qAvg, clamp
  };
});
