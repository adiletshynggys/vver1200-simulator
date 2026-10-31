/* UI wiring and main loop. */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const P = window.VVERPhysics, C = P.C, clamp = P.clamp;
  const R = P.createReactor(), S = R.S;
  const core = P.buildCore();
  const fmt = (v, d) => { const x = isFinite(v) ? +(+v).toFixed(d || 0) || 0 : 0; return x.toLocaleString('en-US', { maximumFractionDigits: d || 0, minimumFractionDigits: d || 0 }); };
  let speed = 5, plant = null;

  /* ---------- cross-sections and 3D ---------- */
  const XS = window.CrossSection({ root: $('#xs'), P, R, core, onSelectCell: c => { if (plant) plant.highlight(c); } });
  function onView(k) {
    document.querySelectorAll('.views button').forEach(b => b.setAttribute('aria-pressed', b.dataset.view === k));
  }
  function onPick(kind, data) {
    data = data || {};
    if (kind === 'assembly') return XS.open('assembly', data.cell, null);
    if (kind === 'rod') return XS.open('rod', data.cell, XS.guides[0]);
    if (kind === 'rodinfo') return XS.open('rod', core.cells.find(c => c.group === 'reg'), XS.guides[0]);
    if (kind === 'vessel') return XS.open('core');
    showInfo(kind, data);
  }
  try {
    plant = window.Plant3D({ canvas: $('#scene'), stage: $('#stage'), labelsEl: $('#labels'), P, R, core, onPick, onView });
  } catch (err) {
    const m = document.createElement('p');
    m.className = 'trip'; m.style.top = '45%';
    m.textContent = 'The 3D view needs WebGL, which this browser has turned off. The controls and cross-sections still work.';
    $('#stage').appendChild(m);
  }
  document.querySelectorAll('.views button').forEach(b => b.addEventListener('click', () => plant && plant.setView(b.dataset.view)));

  /* ---------- info cards with live values ---------- */
  const pe = () => Math.max(0, S.Ps * C.PE_NOM);
  const loopName = d => (d && d.loop != null ? ' ' + (d.loop + 1) : '');
  const INFO = {
    reactor: { title: () => 'Reactor', text: 'Pressure vessel holding 163 fuel assemblies with 3.73 m of fuel height. Water at 16.2 MPa enters near 298 °C and leaves near 325 °C. The blue glow is Cherenkov light: fast electrons outrunning light in water.',
      live: () => fmt(S.Pth * C.P_NOM) + ' MWt now, coolant in ' + fmt(R.coreIn(), 1) + ' °C, out ' + fmt(R.coreOut(), 1) + ' °C',
      go: () => ({ label: 'Open core cross-section', act: () => XS.open('core') }) },
    sg: { title: d => 'Steam generator' + loopName(d), text: 'A horizontal steam generator, a VVER signature; most Western PWRs use vertical U-tubes. Primary water runs through thousands of horizontal tubes and boils the water around them into steam at about 7 MPa.',
      live: () => 'Transferring ' + fmt(S.qsg * C.P_NOM / 4) + ' MW now' },
    pump: { title: d => 'Main coolant pump' + loopName(d), text: 'Each pump moves about a quarter of the roughly 86 000 m³/h that flows through the core. A heavy flywheel keeps the flow coasting down slowly if power is lost.',
      live: d => (d.loop != null ? (S.pumps[d.loop] ? 'Running. ' : 'Stopped. ') : '') + 'Core flow ' + fmt(S.flow * 100) + ' %',
      go: d => d.loop == null ? null : ({ label: S.pumps[d.loop] ? 'Trip this pump' : 'Start this pump', act: () => { S.pumps[d.loop] = !S.pumps[d.loop]; renderPumps(); } }) },
    prz: { title: () => 'Pressurizer', text: 'Holds the primary circuit at 16.2 MPa with electric heaters and a water spray, so the coolant never boils in the core. The thin surge line ties it to a hot leg.' },
    turbine: { title: () => 'Turbine', text: 'A high-pressure and two low-pressure cylinders on one shaft. On the grid it turns at exactly 3000 rpm, 50 Hz, at any load: power changes the steam torque, not the speed. The spin here is slowed for viewing.',
      live: () => fmt(S.rpm) + ' rpm, ' + (R.onGrid() ? 'on the grid' : 'off the grid') },
    generator: { title: () => 'Generator', text: 'Turns shaft power into electricity, about 1200 MWe at full load. When the turbine trips the breaker opens and the shaft coasts down.',
      live: () => fmt(pe()) + ' MWe to the grid' },
    condenser: { title: () => 'Condenser', text: 'Turns turbine exhaust back into water under vacuum. About two thirds of the reactor heat leaves the plant here.',
      live: () => 'Rejecting about ' + fmt(Math.max(0, S.qsg * C.P_NOM - pe())) + ' MW' },
    feedpump: { title: () => 'Feedwater pump', text: 'Pushes condensate back to the steam generators. Heaters and the deaerator are not drawn.' },
    tower: { title: () => 'Cooling tower', text: 'Rejects the condenser heat to the air. The plume grows and shrinks with the heat being dumped.',
      live: () => 'About ' + fmt(Math.max(0, S.qsg * C.P_NOM - pe())) + ' MW of waste heat' }
  };
  const PIPES = {
    hot: { t: 'Hot leg', x: 'Carries water from the reactor outlet nozzle straight to the hot collector of the steam generator.', l: () => fmt(R.coreOut(), 1) + ' °C at 16.2 MPa, flow ' + fmt(S.flow * 100) + ' %' },
    cold: { t: 'Cold leg', x: 'Returns water from the cold collector down through the loop seal and the main coolant pump to the lower nozzle row.', l: () => fmt(R.coreIn(), 1) + ' °C, flow ' + fmt(S.flow * 100) + ' %' },
    surge: { t: 'Surge line', x: 'Connects the pressurizer to a hot leg so it can absorb the coolant swelling and shrinking as it heats and cools.' },
    steam: { t: 'Main steam', x: 'Saturated steam at about 7.0 MPa and 286 °C runs from the four steam generators to a header and on to the turbine.', l: () => R.onGrid() ? 'Steam flow ' + fmt(S.Ps * 100) + ' % of full' : 'Turbine off line, ' + fmt(S.qsg * 100) + ' % going to the condenser through dump valves' },
    xover: { t: 'Crossover pipes', x: 'Carry steam from the high-pressure cylinder to the two low-pressure cylinders. Moisture separator-reheaters sit in between in a real plant; they are not drawn.' },
    feed: { t: 'Feedwater', x: 'Water pumped back from the condenser, heated to about 225 °C in a real plant and fed to each steam generator from a ring header.', l: () => 'Flow ' + fmt((R.onGrid() ? S.Ps : S.qsg) * 100) + ' % of full' },
    cw: { t: 'Cooling water', x: 'Large pipes carry condenser cooling water to the cooling tower and back.', l: () => 'About ' + fmt(Math.max(0, S.qsg * C.P_NOM - pe())) + ' MW of heat' },
    bus: { t: 'Generator busbar', x: 'Carries the generator output to the step-up transformer and the grid.', l: () => fmt(pe()) + ' MWe' }
  };
  let infoCur = null;
  const infoEl = $('#info');
  function showInfo(kind, data) {
    infoCur = { kind, data: data || {} };
    if (kind === 'pipe') {
      const p = PIPES[data.kind] || { t: 'Pipe', x: '' };
      $('#infoTitle').textContent = p.t + ((data.kind === 'hot' || data.kind === 'cold') ? ', loop' + loopName(data) : '');
      $('#infoText').textContent = p.x;
    } else {
      const it = INFO[kind]; if (!it) return;
      $('#infoTitle').textContent = it.title(data || {});
      $('#infoText').textContent = it.text;
    }
    infoEl.hidden = false;
    refreshInfo();
  }
  function refreshInfo() {
    if (!infoCur || infoEl.hidden) return;
    const { kind, data } = infoCur;
    let live = '', go = null;
    if (kind === 'pipe') { const p = PIPES[data.kind]; live = p && p.l ? p.l() : ''; }
    else { const it = INFO[kind]; live = it.live ? it.live(data) : ''; go = it.go ? it.go(data) : null; }
    $('#infoLive').textContent = live;
    const b = $('#infoGo');
    b.hidden = !go;
    if (go) { b.textContent = go.label; b.onclick = go.act; }
  }
  $('#infoClose').addEventListener('click', () => { infoEl.hidden = true; infoCur = null; });

  /* ---------- controls ---------- */
  const rodSet = $('#rodSet');
  let holding = false;
  function holdButton(btn, dir) {
    let t0 = 0, h0 = 0, active = false;
    btn.addEventListener('pointerdown', e => {
      e.preventDefault();
      try { btn.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      active = holding = true; btn.classList.add('held');
      t0 = performance.now(); h0 = R.rodHeight();
      R.setRodHeight(dir > 0 ? 100 : 0);
    });
    const end = () => {
      if (!active) return;
      active = holding = false; btn.classList.remove('held');
      if (performance.now() - t0 < 280) R.setRodHeight(clamp(h0 + dir * 5, 0, 100));
      else R.holdRods();
    };
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(ev => btn.addEventListener(ev, end));
    btn.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); R.setRodHeight(clamp(R.targetHeight() + dir * 5, 0, 100)); }
    });
    btn.addEventListener('contextmenu', e => e.preventDefault());
  }
  holdButton($('#rodUp'), 1);
  holdButton($('#rodDn'), -1);
  rodSet.addEventListener('input', () => R.setRodHeight(+rodSet.value));
  $('#gNom').style.top = (6 + C.X0 * 160) + 'px';

  const pumpsEl = $('#pumps');
  function renderPumps() {
    pumpsEl.innerHTML = '';
    S.pumps.forEach((on, i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.setAttribute('aria-pressed', on);
      b.innerHTML = '<i></i>Pump ' + (i + 1);
      b.addEventListener('click', () => { S.pumps[i] = !S.pumps[i]; renderPumps(); refreshInfo(); });
      pumpsEl.appendChild(b);
    });
  }
  $('#boron').addEventListener('input', e => { S.boronTarget = +e.target.value; });
  $('#scram').addEventListener('click', () => R.scram('Scram: manual emergency protection'));
  $('#turb').addEventListener('click', () => { if (S.online) R.tripTurbine(); else R.startTurbine(); });
  $('#resetTrip').addEventListener('click', () => R.resetProtection());
  $('#resetAll').addEventListener('click', () => { R.reset(); $('#boron').value = C.B0; hist.length = 0; renderPumps(); endScenario(); });
  function setSpeed(v) {
    speed = v;
    document.querySelectorAll('.speed button').forEach(x => x.setAttribute('aria-pressed', +x.dataset.speed === v));
  }
  document.querySelectorAll('.speed button').forEach(b => b.addEventListener('click', () => setSpeed(+b.dataset.speed)));

  /* ---------- accident scenarios ---------- */
  const scenList = $('#scenList'), autoProt = $('#autoProt'), evlog = $('#evlog');
  const trace = []; let traceAcc = 0, logShown = 0;
  [...new Set(P.SCENARIOS.map(s => s.group))].forEach(g => {
    const box = document.createElement('div'); box.className = 'scen-group';
    box.innerHTML = '<h3>' + g + '</h3><div></div>';
    P.SCENARIOS.filter(s => s.group === g).forEach(s => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'scen-btn'; b.dataset.id = s.id; b.setAttribute('aria-pressed', 'false');
      b.innerHTML = '<b></b><span></span>';
      b.firstChild.textContent = s.name; b.lastChild.textContent = s.what;
      b.addEventListener('click', () => startScenario(s.id));
      box.lastChild.appendChild(b);
    });
    scenList.appendChild(box);
  });
  autoProt.addEventListener('change', () => { S.autoProt = autoProt.checked; });
  function startScenario(id) {
    S.autoProt = autoProt.checked;
    R.runScenario(id);
    $('#boron').value = C.B0; hist.length = 0; renderPumps();
    trace.length = 0; traceAcc = 0; logShown = 0; evlog.innerHTML = '';
    const sc = P.SCENARIOS.find(s => s.id === id);
    $('#scenName').textContent = sc.name + (S.autoProt ? '' : ', no automatic protection');
    $('#scenRun').hidden = false;
    document.querySelectorAll('.scen-btn').forEach(b => b.setAttribute('aria-pressed', b.dataset.id === id));
    setSpeed(1);
    if (plant) plant.setView(id === 'lofw' || id === 'sbo' ? 'steam' : 'core');
    sizeCanvases();
  }
  function endScenario() {
    $('#scenRun').hidden = true; trace.length = 0;
    document.querySelectorAll('.scen-btn').forEach(b => b.setAttribute('aria-pressed', 'false'));
  }
  function sampleTrace(simDt) {
    if (!S.scenario) return;
    traceAcc += simDt;
    if (traceAcc < 0.1) return;
    traceAcc = 0;
    trace.push({ t: S.t, p: S.Pth, f: S.flow, q: S.qsg, th: R.hotOut() });
    if (trace.length > 3000) for (let i = trace.length - 1; i > 0; i -= 2) trace.splice(i, 1);  // keep every other point
  }
  const BAD = /Scram|DNB|boiling|dry|fails|lost|seizes|stop/;
  function renderLog() {
    if (!S.scenario) return;
    $('#scenClock').textContent = 't = ' + fmt(S.t, S.t < 100 ? 1 : 0) + ' s';
    while (logShown < S.log.length) {
      const e = S.log[logShown++], li = document.createElement('li');
      li.innerHTML = '<time></time><span></span>';
      li.firstChild.textContent = fmt(e.t, e.t < 100 ? 1 : 0) + ' s';
      li.lastChild.textContent = e.text;
      if (BAD.test(e.text) && e.t > 0) li.className = 'bad';
      evlog.appendChild(li);
      evlog.scrollTop = evlog.scrollHeight;
    }
  }
  function drawTrace() {
    if (!S.scenario || $('#scenRun').hidden) return;
    const cs = getComputedStyle(document.documentElement), W = tplot.width, Hh = tplot.height;
    if (!W) return;
    const d = W / tplot.clientWidth, L = 38 * d, Rr = W - 6 * d;
    const tMax = Math.max(60, Math.ceil((trace.length ? trace[trace.length - 1].t : 0) / 30) * 30);
    const X = t => L + (Rr - L) * t / tMax;
    // upper panel: percent of rated; lower panel: hottest channel outlet temperature
    const a0 = 8 * d, a1 = Hh * 0.55, b0 = Hh * 0.55 + 16 * d, b1 = Hh - 20 * d;
    const Yp = v => a1 - (a1 - a0) * Math.min(v, 1.3) / 1.3;
    const T0 = 280, T1 = 370, Yt = T => b1 - (b1 - b0) * (Math.min(Math.max(T, T0), T1) - T0) / (T1 - T0);
    tg.clearRect(0, 0, W, Hh);
    tg.font = (11 * d) + 'px Barlow, sans-serif'; tg.lineWidth = 1;
    const ink2 = cs.getPropertyValue('--ink-2'), rule = cs.getPropertyValue('--rule');
    const hline = (y, label, dash) => {
      tg.strokeStyle = rule; tg.setLineDash(dash ? [4 * d, 3 * d] : []);
      tg.beginPath(); tg.moveTo(L, y); tg.lineTo(Rr, y); tg.stroke(); tg.setLineDash([]);
      tg.fillStyle = ink2; tg.textAlign = 'right'; tg.fillText(label, L - 4 * d, y + 4 * d);
    };
    [0, 0.5, 1].forEach(v => hline(Yp(v), (v * 100) + ' %'));
    [290, 320].forEach(T => hline(Yt(T), T + ' °C'));
    tg.strokeStyle = cs.getPropertyValue('--hot'); tg.setLineDash([4 * d, 3 * d]);
    tg.beginPath(); tg.moveTo(L, Yt(C.TSAT_P)); tg.lineTo(Rr, Yt(C.TSAT_P)); tg.stroke(); tg.setLineDash([]);
    tg.fillStyle = cs.getPropertyValue('--hot'); tg.textAlign = 'left';
    tg.fillText('boiling at 16.2 MPa', L + 4 * d, Yt(C.TSAT_P) - 4 * d);
    tg.fillStyle = ink2; tg.textAlign = 'center';
    for (let t = 0; t <= tMax; t += tMax / 4) tg.fillText(fmt(t) + ' s', X(t), Hh - 4 * d);
    const line = (key, Y, col) => {
      tg.strokeStyle = col; tg.lineWidth = 2 * d; tg.beginPath();
      trace.forEach((p, i) => { const x = X(p.t), y = Y(p[key]); if (i) tg.lineTo(x, y); else tg.moveTo(x, y); });
      tg.stroke();
    };
    line('f', Yp, cs.getPropertyValue('--cold'));
    line('q', Yp, cs.getPropertyValue('--steam'));
    line('p', Yp, cs.getPropertyValue('--hot'));
    line('th', Yt, cs.getPropertyValue('--ink'));
  }
  $('#xsOpen').addEventListener('click', () => XS.open('core'));

  /* ---------- readouts ---------- */
  const lamp = (id, on) => $(id).classList.toggle('on', !!on);
  function rodMessage() {
    if (S.scram) return { t: 'Emergency protection holds every rod at the bottom. Press Reset protection to re-arm, then raise the group to restart.', w: true };
    if (S.block) {
      let t = S.block + '.';
      if (S.sdX > 0.001) t = 'Shutdown banks withdrawing, ' + fmt(S.sdX * 100) + ' % in. The regulating group moves once they are out.';
      return { t, w: S.block.indexOf('Waiting') < 0 };
    }
    const moving = Math.abs(S.rodTarget - S.rodX) > 0.002;
    if (moving) return { t: (S.rodTarget < S.rodX ? 'Raising' : 'Lowering') + ' to ' + fmt(R.targetHeight()) + ' %. Power follows as feedback catches up.' };
    if (S.n < 1e-3) return { t: 'Subcritical. Raise the group to restart: neutron power climbs through several decades before any heat shows, so try 20× time.' };
    return { t: 'Hold Raise or Lower to drive the rods, or tap for a 5 % step.' };
  }
  function updateUI() {
    $('#pth').textContent = fmt(S.Pth * C.P_NOM); $('#pe').textContent = fmt(pe());
    $('#pthBar').style.width = clamp(S.Pth / 1.15, 0, 1) * 100 + '%';
    $('#peBar').style.width = clamp(S.Ps / 1.15, 0, 1) * 100 + '%';
    $('#rho').textContent = (S.rho > 0.5 ? '+' : '') + fmt(S.rho) + ' pcm';
    $('#per').textContent = !isFinite(S.period) || Math.abs(S.period) > 999 ? '∞' : fmt(S.period, 1) + ' s';
    $('#flow').textContent = fmt(S.flow * 100) + ' %';
    $('#tin').textContent = fmt(R.coreIn(), 1) + ' °C';
    const to = R.coreOut();
    $('#tout').textContent = to >= C.TSAT_P ? 'Boiling' : fmt(to, 1) + ' °C';
    $('#tout').classList.toggle('warn', to >= C.TSAT_P);
    $('#tf').textContent = fmt(S.Tf) + ' °C';
    $('#rpm').textContent = fmt(S.rpm) + ' rpm';
    $('#dh').textContent = fmt(R.decayHeat() * 100, 2) + ' %';
    $('#bor').textContent = fmt(S.boron) + ' ppm';
    const dn = $('#dnbr');
    dn.textContent = S.dnbr > 9.9 ? '> 10' : fmt(S.dnbr, 2);
    dn.classList.toggle('warn', S.dnbr < C.DNBR_LIM);
    const th = R.hotOut(), tv = $('#thot');
    tv.textContent = th >= C.TSAT_P ? 'Boiling' : fmt(th, 1) + ' °C';
    tv.classList.toggle('warn', th >= C.TSAT_P);
    $('#sgl').textContent = fmt(S.sg * 100) + ' %';
    $('#sgl').classList.toggle('warn', S.sg < C.SG_LOW);
    if (autoProt.checked !== S.autoProt) autoProt.checked = S.autoProt;
    const np = S.n * 100;
    $('#npow').textContent = np >= 0.1 ? fmt(np, np >= 10 ? 0 : 1) + ' %' : np.toExponential(1) + ' %';
    $('#nbar').style.width = clamp((Math.log10(S.n) + 8) / 8, 0, 1) * 100 + '%';

    lamp('#lCrit', !S.scram && Math.abs(S.rho) < 15 && S.n > 1e-4);
    lamp('#lAZ', S.scram);
    lamp('#lGrid', R.onGrid());
    lamp('#lBlock', !!S.block && S.block.indexOf('Waiting') < 0);

    $('#rodPos').textContent = fmt(R.rodHeight()) + ' %';
    $('#gRod').style.height = (R.regX() * 160) + 'px';
    $('#gSd').style.height = (S.sdX * 160) + 'px';
    const tg = $('#gTgt');
    tg.style.display = holding ? 'none' : '';
    tg.style.top = (6 + S.rodTarget * 160) + 'px';
    if (document.activeElement !== rodSet) rodSet.value = Math.round(holding ? R.rodHeight() : R.targetHeight());
    $('#rodTgtTxt').textContent = holding ? 'Moving' : 'Target ' + fmt(R.targetHeight()) + ' %';
    const m = rodMessage(), rm = $('#rodMsg');
    rm.textContent = m.t; rm.classList.toggle('warn', !!m.w);

    $('#boronVal').textContent = fmt(S.boronTarget) + ' ppm';
    $('#boronSub').textContent = 'Now ' + fmt(S.boron) + ' ppm, changing 1.5 ppm/s, about −12 pcm per ppm.';
    const p = S.parts, row = (k, v, c) => '<dt' + (c ? ' class="sum"' : '') + '>' + k + '</dt><dd' + (c ? ' class="sum"' : '') + '>' + (v > 0.5 ? '+' : '') + fmt(v) + ' pcm</dd>';
    $('#rhoList').innerHTML = row('Control rods', p.rods) + row('Boric acid', p.boron) + row('Doppler (fuel)', p.dop) + row('Moderator', p.mod) + row('Net reactivity', S.rho, true);

    const tb = $('#turb');
    tb.textContent = S.online ? 'Trip turbine' : 'Start turbine';
    tb.disabled = !S.online && (S.scram || S.Pth <= 0.08);
    $('#resetTrip').disabled = !S.scram;
    const tr = $('#trip'); tr.hidden = !S.trip; tr.textContent = S.trip;
    document.querySelectorAll('#pumps button').forEach((b, i) => b.setAttribute('aria-pressed', S.pumps[i]));
  }

  /* ---------- power history ---------- */
  const hist = []; let histAcc = 0;
  const plot = $('#plot'), pg = plot.getContext('2d'), fis = $('#fis'), fg = fis.getContext('2d');
  const tplot = $('#tplot'), tg = tplot.getContext('2d');
  function sizeCanvases() {
    const d = Math.min(window.devicePixelRatio || 1, 2);
    [plot, fis, tplot].forEach(c => { c.width = Math.round(c.clientWidth * d); c.height = Math.round(c.clientHeight * d); });
  }
  function sample(simDt) {
    histAcc += simDt;
    const every = 0.5 * Math.max(1, speed / 2.5);
    if (histAcc >= every) {
      hist.push({ th: S.Pth * C.P_NOM, el: pe(), dt: histAcc }); histAcc = 0;
      if (hist.length > 240) hist.shift();
    }
  }
  function drawPlot() {
    const cs = getComputedStyle(document.documentElement), W = plot.width, Hh = plot.height;
    if (!W) return;
    const d = W / plot.clientWidth;
    pg.clearRect(0, 0, W, Hh);
    pg.strokeStyle = cs.getPropertyValue('--rule'); pg.lineWidth = 1;
    pg.fillStyle = cs.getPropertyValue('--ink-2'); pg.font = (11 * d) + 'px Barlow, sans-serif';
    [0, 1000, 2000, 3000].forEach(v => {
      const y = Hh - 8 * d - (v / 3700) * (Hh - 16 * d);
      pg.beginPath(); pg.moveTo(34 * d, y); pg.lineTo(W, y); pg.stroke(); pg.fillText(v, 4 * d, y + 4 * d);
    });
    const N = 240;
    [['th', cs.getPropertyValue('--hot')], ['el', cs.getPropertyValue('--steam')]].forEach(([k, col]) => {
      pg.strokeStyle = col; pg.lineWidth = 2 * d; pg.beginPath();
      hist.forEach((h, i) => {
        const x = 34 * d + (i + N - hist.length) / (N - 1) * (W - 36 * d), y = Hh - 8 * d - (h[k] / 3700) * (Hh - 16 * d);
        if (i) pg.lineTo(x, y); else pg.moveTo(x, y);
      });
      pg.stroke();
    });
    const span = hist.reduce((a, h) => a + h.dt, 0);
    $('#plotSpan').textContent = span > 0 ? 'last ' + (span >= 120 ? fmt(span / 60, 1) + ' min' : fmt(span) + ' s') + ' of plant time' : '';
  }

  /* ---------- fission close-up ---------- */
  const FW = 320, FH = 180, nuc = [], neu = [], frag = [], flash = [];
  let seed = 11; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 12; i++) for (let j = 0; j < 6; j++) nuc.push({ x: 18 + i * 23 + (rnd() - 0.5) * 8, y: 20 + j * 28 + (rnd() - 0.5) * 8, u5: rnd() < 0.25, cd: 0 });
  let fisAcc = 0;
  function fission() {
    const c = nuc.filter(n => n.u5 && n.cd <= 0); if (!c.length) return;
    const n = c[Math.floor(Math.random() * c.length)];
    n.cd = 2.2; flash.push({ x: n.x, y: n.y, life: 1, big: true });
    const a = Math.random() * Math.PI * 2;
    [1, -1].forEach(sg => frag.push({ x: n.x, y: n.y, vx: Math.cos(a) * 60 * sg, vy: Math.sin(a) * 60 * sg, life: 0.8 }));
    const k = Math.random() < 0.45 ? 3 : 2;
    for (let i = 0; i < k; i++) { const b = Math.random() * Math.PI * 2; neu.push({ x: n.x, y: n.y, vx: Math.cos(b) * 140, vy: Math.sin(b) * 140, life: 1.6 }); }
  }
  function updateFis(dt) {
    if (!fis.width) return;
    fisAcc += Math.min(S.n, 1.3) * 9 * dt;
    while (fisAcc > 1) { fisAcc -= 1; fission(); }
    if (Math.random() < Math.min(S.n, 1.3) * 2 * dt) fission();
    const rodY = R.regX() * FH;
    nuc.forEach(n => { n.cd -= dt; });
    for (let i = neu.length - 1; i >= 0; i--) {
      const p = neu[i]; p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt;
      if (p.x > 292 && p.x < 306 && p.y < rodY) { flash.push({ x: p.x, y: p.y, life: 0.5 }); neu.splice(i, 1); continue; }
      if (p.life <= 0 || p.x < 0 || p.x > FW || p.y < 0 || p.y > FH) neu.splice(i, 1);
    }
    for (let i = frag.length - 1; i >= 0; i--) { const p = frag[i]; p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt; if (p.life <= 0) frag.splice(i, 1); }
    for (let i = flash.length - 1; i >= 0; i--) { flash[i].life -= dt * 2.2; if (flash[i].life <= 0) flash.splice(i, 1); }
    const d = fis.width / FW; fg.setTransform(d, 0, 0, d, 0, 0);
    fg.fillStyle = '#0b1418'; fg.fillRect(0, 0, FW, FH);
    const cg = clamp(Math.sqrt(S.n), 0, 1);
    fg.fillStyle = 'rgba(60,160,255,' + (0.04 + 0.14 * cg) + ')'; fg.fillRect(0, 0, FW, FH);
    nuc.forEach(n => {
      fg.beginPath(); fg.arc(n.x, n.y, n.u5 ? 5 : 4.2, 0, 7);
      fg.fillStyle = n.u5 ? (n.cd > 0 ? 'rgba(242,154,64,.18)' : '#f29a40') : '#5d6a70'; fg.fill();
    });
    fg.fillStyle = '#232a2e'; fg.fillRect(292, 0, 14, rodY); fg.fillStyle = '#ffc83a'; fg.fillRect(292, rodY - 3, 14, 3);
    frag.forEach(p => { fg.beginPath(); fg.arc(p.x, p.y, 3.4, 0, 7); fg.fillStyle = 'rgba(255,120,80,' + p.life + ')'; fg.fill(); });
    neu.forEach(p => { fg.beginPath(); fg.arc(p.x, p.y, 1.9, 0, 7); fg.fillStyle = 'rgba(235,245,255,' + Math.min(1, p.life) + ')'; fg.fill(); });
    flash.forEach(f => {
      const r = (f.big ? 16 : 7) * (1.2 - f.life);
      fg.beginPath(); fg.arc(f.x, f.y, r, 0, 7);
      fg.fillStyle = f.big ? 'rgba(255,230,170,' + f.life * 0.8 + ')' : 'rgba(170,190,200,' + f.life * 0.6 + ')'; fg.fill();
    });
  }

  /* ---------- resize, links, loop ---------- */
  function resizeAll() { if (plant) plant.resize(); sizeCanvases(); }
  const ro = new ResizeObserver(resizeAll);
  ro.observe($('#stage')); ro.observe(plot);
  function applyHash() {
    const h = location.hash.slice(1);
    if (h === 'sections') XS.open('core');
    else if (plant && plant.views[h]) plant.setView(h, true);
  }
  window.addEventListener('hashchange', applyHash);

  renderPumps(); resizeAll(); applyHash();
  let last = performance.now(), uiT = 1, plotT = 1, xsT = 0, infoT = 0;
  function frame(now) {
    const rdt = Math.min(0.05, Math.max(0, (now - last) / 1000)); last = now;
    const simDt = rdt * speed;
    R.advance(simDt); sample(simDt); sampleTrace(simDt);
    if (plant) plant.update(rdt);
    updateFis(rdt);
    uiT += rdt; if (uiT > 0.1) { uiT = 0; updateUI(); renderLog(); }
    plotT += rdt; if (plotT > 0.25) { plotT = 0; drawPlot(); drawTrace(); }
    xsT += rdt; if (xsT > 0.5) { xsT = 0; XS.tick(); }
    infoT += rdt; if (infoT > 0.3) { infoT = 0; refreshInfo(); }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  window.VVERSim = { R, S, core, XS, get plant() { return plant; } };
})();
