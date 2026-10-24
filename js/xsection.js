/* Cross-section viewer: core → assembly → rod, with live values from the reactor model. */
(function () {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const fmt = (v, d) => { const x = isFinite(v) ? +(+v).toFixed(d || 0) || 0 : 0; return x.toLocaleString('en-US', { maximumFractionDigits: d || 0, minimumFractionDigits: d || 0 }); };

  function ramp(stops, t) {
    t = Math.max(0, Math.min(1, t));
    const i = Math.min(stops.length - 2, Math.floor(t * (stops.length - 1)));
    const f = t * (stops.length - 1) - i;
    const a = stops[i], b = stops[i + 1];
    const c = [0, 1, 2].map(k => Math.round(a[k] + (b[k] - a[k]) * f));
    return 'rgb(' + c.join(',') + ')';
  }
  const POWER = [[251, 240, 201], [246, 193, 91], [234, 123, 44], [194, 64, 42], [125, 28, 28]];
  const HEAT = [[122, 36, 18], [200, 64, 28], [240, 125, 34], [255, 201, 74], [255, 246, 216]];
  const powerColor = k => ramp(POWER, (k - 0.4) / 1.2);
  const tempColor = T => ramp(HEAT, (T - 300) / 1900);
  const BATCH_COL = ['#8fd3c7', '#5aa9c9', '#3b6c8f'];

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  const hexPts = (cx, cy, R, rot) => {
    const p = [];
    for (let k = 0; k < 6; k++) { const a = rot + k * Math.PI / 3; p.push((cx + R * Math.cos(a)).toFixed(3) + ',' + (cy + R * Math.sin(a)).toFixed(3)); }
    return p.join(' ');
  };

  window.CrossSection = function (opts) {
    const { root, P, R, core, onSelectCell } = opts;
    const S = R.S, C = P.C;
    const pins = P.buildAssembly();
    const guides = pins.filter(p => p.type === 'guide');
    const $ = s => root.querySelector(s);
    const svgBox = $('#xsDraw'), chartBox = $('#xsChart'), facts = $('#xsFacts');
    const titleEl = $('#xsTitle'), leadEl = $('#xsLead'), crumbs = $('#xsCrumbs'), legend = $('#xsLegend'), modeBox = $('#xsMode');
    let st = { level: 'core', cell: null, pin: null, mode: 'power' };
    let refs = {};
    let lastFocus = null;

    /* ---------- shared live quantities ---------- */
    function kq() { return P.assemblyPowers(core, R.regX(), S.sdX); }
    function cellIns(c) { return !c.rodded ? 0 : (c.group === 'reg' ? R.regX() : S.sdX); }
    function midCoolant(k) { return Math.min(345, R.coreIn() + R.coreDT() * k / 2); }
    function outCoolant(k) { return Math.min(347, R.coreIn() + R.coreDT() * k); }
    function rodState(cell, pin, K) {
      const k = K[core.cells.indexOf(cell)];
      const q = P.qAvg(S.Pth) * k * P.pinFactor(pin, cell.batch) * C.KZ_MID;
      return P.rodProfile(q, midCoolant(k), S.flow, pin.type === 'gd');
    }
    function hottest(K) {
      let best = null;
      core.cells.forEach((c, i) => { if (!best || K[i] > best.k) best = { c, k: K[i] }; });
      const fuel = pins.filter(p => p.type === 'fuel' || p.type === 'gd');
      let bp = fuel[0];
      fuel.forEach(p => { if (P.pinFactor(p, best.c.batch) > P.pinFactor(bp, best.c.batch)) bp = p; });
      return { cell: best.c, pin: bp, k: best.k, prof: rodState(best.c, bp, K) };
    }

    function setFacts(rows) {
      facts.innerHTML = rows.map(r => '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>').join('');
    }
    function setCrumbs() {
      const items = [{ label: 'Core', go: () => show('core') }];
      if (st.level !== 'core' && st.cell) items.push({ label: 'Assembly ' + st.cell.id, go: () => show('assembly', st.cell) });
      if (st.level === 'rod' && st.pin) items.push({ label: pinName(st.pin) });
      crumbs.innerHTML = '';
      items.forEach((it, i) => {
        const b = document.createElement('button');
        b.type = 'button'; b.textContent = it.label;
        if (i === items.length - 1) b.setAttribute('aria-current', 'page');
        else b.addEventListener('click', it.go);
        crumbs.appendChild(b);
        if (i < items.length - 1) { const sp = document.createElement('span'); sp.textContent = '›'; sp.setAttribute('aria-hidden', 'true'); crumbs.appendChild(sp); }
      });
    }
    function pinName(p) {
      return p.type === 'guide' ? 'Guide channel ' + p.id : p.type === 'center' ? 'Central tube' : (p.type === 'gd' ? 'Gadolinia rod ' : 'Fuel rod ') + p.id;
    }

    /* ---------- core map ---------- */
    function renderCore() {
      svgBox.innerHTML = ''; chartBox.innerHTML = ''; chartBox.hidden = true;
      const svg = el('svg', { viewBox: '-8.2 -8.2 16.4 16.4', class: 'xs-svg', role: 'img', 'aria-label': 'Core cross-section with 163 fuel assemblies' }, svgBox);
      el('circle', { cx: 0, cy: 0, r: 7.9, class: 'xs-pool' }, svg);
      el('circle', { cx: 0, cy: 0, r: 7.9, class: 'xs-barrel' }, svg);
      const Rh = 1 / Math.sqrt(3) * 0.97;
      refs = { hex: [] };
      core.cells.forEach((c, i) => {
        const g = el('g', { class: 'xs-hit', 'data-i': i }, svg);
        const poly = el('polygon', { points: hexPts(c.u, c.v, Rh, Math.PI / 2), class: 'hx' }, g);
        if (c === st.cell) poly.classList.add('sel');
        if (c.rodded) el('circle', { cx: c.u, cy: c.v, r: 0.16, class: c.group === 'reg' ? 'dot-reg' : 'dot-sd' }, g);
        refs.hex.push(poly);
        g.addEventListener('click', () => show('assembly', c));
      });
      modeBox.hidden = false;
      modeBox.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.mode === st.mode));
      legend.innerHTML = st.mode === 'power'
        ? '<span class="ramp"></span><span>Relative assembly power, 0.4 to 1.6</span><span><i class="dot reg"></i>Regulating group</span><span><i class="dot sd"></i>Shutdown groups</span>'
        : BATCH_COL.map((c, i) => '<span><i class="sw" style="background:' + c + '"></i>' + P.BATCH[i].name + '</span>').join('') + '<span><i class="dot reg"></i>Regulating group</span><span><i class="dot sd"></i>Shutdown groups</span>';
      titleEl.textContent = 'Reactor core';
      leadEl.textContent = 'Each hexagon is one fuel assembly, seen from above. Colour shows its share of the power right now and dots mark control clusters. Tap an assembly to open it.';
      refreshCore();
    }
    function refreshCore() {
      const K = kq();
      refs.hex.forEach((poly, i) => poly.setAttribute('fill', st.mode === 'power' ? powerColor(K[i]) : BATCH_COL[core.cells[i].batch]));
      const hot = hottest(K);
      const nReg = core.cells.filter(c => c.group === 'reg').length;
      setFacts([
        ['Thermal power', fmt(S.Pth * C.P_NOM) + ' MWt'],
        ['Fuel assemblies', '163, hexagonal, 235 mm across flats'],
        ['Fuel rods', fmt(C.N_RODS) + ' (312 per assembly)'],
        ['Control clusters', '121, of which ' + nReg + ' form the regulating group here'],
        ['Regulating group', fmt(R.rodHeight()) + ' % of core height'],
        ['Average linear heat rate', fmt(P.qAvg(S.Pth) / 1000, 1) + ' kW/m'],
        ['Highest assembly power factor', fmt(hot.k, 2) + ' (assembly ' + hot.cell.id + ')'],
        ['Hottest rod at mid-plane', fmt(hot.prof.q / 1000, 1) + ' kW/m, centre ' + fmt(hot.prof.Tc) + ' °C'],
        ['Coolant in / out', fmt(R.coreIn(), 1) + ' / ' + fmt(R.coreOut(), 1) + ' °C'],
        ['Boric acid', fmt(S.boron) + ' ppm']
      ]);
    }

    /* ---------- fuel assembly ---------- */
    function renderAssembly() {
      const cell = st.cell;
      svgBox.innerHTML = ''; chartBox.innerHTML = ''; chartBox.hidden = true; modeBox.hidden = true;
      const svg = el('svg', { viewBox: '-142 -124 284 248', class: 'xs-svg', role: 'img', 'aria-label': 'Fuel assembly cross-section, 331 positions' }, svgBox);
      el('polygon', { points: hexPts(0, 0, 135.7, 0), class: 'xs-water' }, svg);
      refs = { pins: [], abs: [] };
      const ins = cellIns(cell), absMid = cell.rodded && ins > 0.5;
      pins.forEach(p => {
        const g = el('g', { class: 'xs-hit' }, svg);
        if (p.type === 'fuel' || p.type === 'gd') {
          // cladding tube with the pellet inside; the pellet carries the power colour
          const c = el('circle', { cx: p.x, cy: p.y, r: 4.55, class: p.type === 'gd' ? 'pin gd' : 'pin' }, g);
          refs.pins.push({ c: el('circle', { cx: p.x, cy: p.y, r: 3.8, class: 'pel' }, g), p });
          if (p === st.pin) c.classList.add('sel');
        } else if (p.type === 'guide') {
          el('circle', { cx: p.x, cy: p.y, r: 6.3, class: 'guide' + (p === st.pin ? ' sel' : '') }, g);
          const a = el('circle', { cx: p.x, cy: p.y, r: 4.1, class: 'absorber' }, g);
          a.style.display = absMid ? '' : 'none';
          refs.abs.push(a);
        } else {
          el('circle', { cx: p.x, cy: p.y, r: 5.6, class: 'ctube' + (p === st.pin ? ' sel' : '') }, g);
          el('path', { d: 'M' + (p.x - 2.4) + ' ' + p.y + 'h4.8M' + p.x + ' ' + (p.y - 2.4) + 'v4.8', class: 'cross' }, g);
        }
        g.addEventListener('click', () => show('rod', cell, p));
      });
      legend.innerHTML = '<span class="ramp"></span><span>Rod power relative to core average</span><span><i class="sw ring-gd"></i>Gadolinia rods</span><span><i class="sw guide"></i>Guide channel</span>' +
        (cell.rodded ? '<span><i class="sw abs"></i>Absorber at mid-plane</span>' : '');
      titleEl.textContent = 'Fuel assembly ' + cell.id;
      leadEl.textContent = 'TVS-2006 type: 312 fuel rods on a 12.75 mm triangular pitch, 18 guide channels for the control cluster and a central tube. Tap any rod.';
      refreshAssembly();
    }
    function refreshAssembly() {
      const cell = st.cell, K = kq(), k = K[core.cells.indexOf(cell)];
      refs.pins.forEach(o => o.c.setAttribute('fill', powerColor(k * P.pinFactor(o.p, cell.batch))));
      const ins = cellIns(cell);
      refs.abs.forEach(a => { a.style.display = cell.rodded && ins > 0.5 ? '' : 'none'; });
      const fuel = pins.filter(p => p.type === 'fuel' || p.type === 'gd');
      let hp = fuel[0]; fuel.forEach(p => { if (P.pinFactor(p, cell.batch) > P.pinFactor(hp, cell.batch)) hp = p; });
      const prof = rodState(cell, hp, K);
      const grp = !cell.rodded ? 'None in this assembly' : (cell.group === 'reg' ? 'Regulating group' : 'Shutdown group') + ', ' + fmt((1 - ins) * 100) + ' % of core height';
      setFacts([
        ['Position', cell.ring === 0 ? 'Central assembly' : 'Ring ' + cell.ring + ' of 7, counted from the centre'],
        ['Fuel', P.BATCH[cell.batch].name + ', about ' + P.BATCH[cell.batch].burnup + ' GWd/t'],
        ['Relative power', fmt(k, 2)],
        ['Assembly power', fmt(S.Pth * C.P_NOM * k / C.N_FA, 1) + ' MW'],
        ['Coolant outlet', fmt(outCoolant(k), 1) + ' °C'],
        ['Control cluster', grp],
        ['Hottest rod at mid-plane', fmt(prof.q / 1000, 1) + ' kW/m, centre ' + fmt(prof.Tc) + ' °C'],
        ['Contents', '306 UO₂ rods, 6 UO₂–Gd₂O₃ rods, 18 guide channels, 1 central tube']
      ]);
    }

    /* ---------- rods ---------- */
    function leader(svg, x0, y0, y1, text, cls) {
      el('polyline', { points: x0 + ',' + y0 + ' 7.9,' + y1 + ' 8.5,' + y1, class: 'lead' }, svg);
      const t = el('text', { x: 8.8, y: y1 + 0.33, class: 'lbl' + (cls ? ' ' + cls : '') }, svg);
      t.textContent = text;
      return t;
    }
    function renderRod() {
      chartBox.hidden = true; chartBox.innerHTML = ''; modeBox.hidden = true;
      const p = st.pin;
      if (p.type === 'guide') return renderGuide();
      if (p.type === 'center') return renderCenter();
      titleEl.textContent = (p.type === 'gd' ? 'Gadolinia fuel rod ' : 'Fuel rod ') + p.id;
      leadEl.textContent = 'Cut through the core mid-plane. Heat flows outward from the pellet, through the helium gap and the cladding, into the water.';
      legend.innerHTML = '<span class="heat"></span><span>Pellet temperature, 300 to 2200 °C</span>';
      chartBox.hidden = false;
      refreshRod();
    }
    function refreshRod() {
      const p = st.pin;
      if (p.type !== 'fuel' && p.type !== 'gd') return refreshGuide();
      const K = kq(), prof = rodState(st.cell, p, K);
      svgBox.innerHTML = '';
      const svg = el('svg', { viewBox: '-7.6 -7.6 29.6 15.2', class: 'xs-svg', role: 'img', 'aria-label': 'Fuel rod cross-section' }, svgBox);
      const defs = el('defs', {}, svg);
      const gr = el('radialGradient', { id: 'pelletGrad', cx: 0.5, cy: 0.5, r: 0.5 }, defs);
      const fr = 0.6 / 3.8;
      [[0, prof.Tc], [fr, prof.Tc], [0.55, prof.Tc - (prof.Tc - prof.Tps) * 0.45], [1, prof.Tps]].forEach(([o, T]) => el('stop', { offset: o, 'stop-color': tempColor(T) }, gr));
      el('polygon', { points: hexPts(0, 0, 7.36, 0), class: 'xs-water' }, svg);
      el('circle', { cx: 0, cy: 0, r: 4.55, class: 'clad' }, svg);
      el('circle', { cx: 0, cy: 0, r: 3.865, class: 'gap' }, svg);
      el('circle', { cx: 0, cy: 0, r: 3.8, fill: 'url(#pelletGrad)', class: p.type === 'gd' ? 'pellet gdring' : 'pellet' }, svg);
      el('circle', { cx: 0, cy: 0, r: 0.6, class: 'hole' }, svg);
      leader(svg, 5.4, -4.6, -5.6, 'Coolant water');
      leader(svg, 3.6, -2.08, -3.2, 'Zr-1%Nb cladding');
      leader(svg, 3.83, 0, -0.8, 'Helium gap');
      leader(svg, 1.9, 1.1, 1.6, (p.type === 'gd' ? 'UO₂–Gd₂O₃ pellet' : 'UO₂ pellet ⌀7.6 mm'));
      leader(svg, 0.42, 0.42, 4.0, 'Central hole ⌀1.2 mm');
      drawProfile(prof);
      const margin = P.ROD.T_MELT - prof.Tc;
      setFacts([
        ['Linear heat rate', fmt(prof.q / 1000, 1) + ' kW/m (' + fmt(prof.q / 100) + ' W/cm)'],
        ['Surface heat flux', fmt(prof.flux / 1000) + ' kW/m²'],
        ['Pellet centre', fmt(prof.Tc) + ' °C'],
        ['Pellet surface', fmt(prof.Tps) + ' °C'],
        ['Cladding outer surface', fmt(prof.Tco) + ' °C'],
        ['Coolant here', fmt(prof.Tcool) + ' °C'],
        ['Margin to UO₂ melting', fmt(margin) + ' K below 2840 °C'],
        ['Heat transfer to water', fmt(prof.h / 1000, 1) + ' kW/m²·K at ' + fmt(S.flow * 100) + ' % flow'],
        ['Geometry', 'Rod ⌀9.1 mm, cladding 0.69 mm, pellet ⌀7.6 mm, pitch 12.75 mm'],
        ['Basis', 'Mid-plane, axial factor ' + C.KZ_MID + ', rod factor ' + fmt(P.pinFactor(p, st.cell.batch), 2)]
      ]);
    }
    function drawProfile(prof) {
      chartBox.innerHTML = '';
      const W = 340, Hh = 178, x0 = 44, x1 = 330, y0 = 14, y1 = 146, rMax = 6.375;
      const tLo = Math.floor((prof.Tcool - 20) / 100) * 100, tHi = Math.max(tLo + 300, Math.ceil((prof.Tc + 60) / 100) * 100);
      const X = r => x0 + (x1 - x0) * r / rMax, Yv = T => y1 - (y1 - y0) * (T - tLo) / (tHi - tLo);
      const svg = el('svg', { viewBox: '0 0 ' + W + ' ' + Hh, class: 'xs-chart', role: 'img', 'aria-label': 'Radial temperature profile' }, chartBox);
      [[0, 0.6, 'z-hole'], [0.6, 3.8, 'z-fuel'], [3.8, 3.865, 'z-gap'], [3.865, 4.55, 'z-clad'], [4.55, rMax, 'z-water']].forEach(([a, b, c]) =>
        el('rect', { x: X(a), y: y0, width: Math.max(0.8, X(b) - X(a)), height: y1 - y0, class: c }, svg));
      for (let T = tLo; T <= tHi; T += (tHi - tLo > 900 ? 200 : 100)) {
        el('line', { x1: x0, x2: x1, y1: Yv(T), y2: Yv(T), class: 'gridl' }, svg);
        el('text', { x: x0 - 5, y: Yv(T) + 3.5, class: 'ax', 'text-anchor': 'end' }, svg).textContent = T;
      }
      [0, 1, 2, 3, 4, 5, 6].forEach(r => { el('text', { x: X(r), y: y1 + 13, class: 'ax', 'text-anchor': 'middle' }, svg).textContent = r; });
      el('text', { x: x1, y: Hh - 3, class: 'ax', 'text-anchor': 'end' }, svg).textContent = 'radius, mm';
      el('text', { x: 4, y: 10, class: 'ax' }, svg).textContent = '°C';
      el('polyline', { points: prof.profile.map(pt => X(pt.r).toFixed(1) + ',' + Yv(pt.T).toFixed(1)).join(' '), class: 'curve' }, svg);
      [[0.15, prof.Tc, 'Centre ' + fmt(prof.Tc)], [3.8, prof.Tps, fmt(prof.Tps)], [4.55, prof.Tco, fmt(prof.Tco)]].forEach(([r, T, s], i) => {
        el('circle', { cx: X(r), cy: Yv(T), r: 2.6, class: 'pt' }, svg);
        el('text', { x: X(r) + 5, y: Yv(T) - 5 - (i === 2 ? 4 : 0), class: 'ax strong' }, svg).textContent = s;
      });
    }
    function renderGuide() {
      const cell = st.cell;
      titleEl.textContent = 'Guide channel ' + st.pin.id;
      leadEl.textContent = cell.rodded
        ? 'One of 18 guide channels. The control cluster’s absorber rods slide down these channels together.'
        : 'One of 18 guide channels. This assembly sits under no control drive, so its channels hold only water.';
      legend.innerHTML = '';
      refreshGuide();
    }
    function refreshGuide() {
      const cell = st.cell, p = st.pin;
      if (p.type === 'center') return refreshCenter();
      const ins = cellIns(cell), inMid = cell.rodded && ins > 0.5;
      svgBox.innerHTML = '';
      const svg = el('svg', { viewBox: '-7.6 -7.6 29.6 15.2', class: 'xs-svg', role: 'img', 'aria-label': 'Guide channel cross-section' }, svgBox);
      el('polygon', { points: hexPts(0, 0, 7.36, 0), class: 'xs-water' }, svg);
      el('circle', { cx: 0, cy: 0, r: 6.3, class: 'gtube' }, svg);
      el('circle', { cx: 0, cy: 0, r: 5.45, class: 'xs-water' }, svg);
      leader(svg, 4.9, -3.8, -5.6, 'Guide channel');
      if (inMid) {
        el('circle', { cx: 0, cy: 0, r: 4.1, class: 'aclad' }, svg);
        el('circle', { cx: 0, cy: 0, r: 3.5, class: 'b4c' }, svg);
        leader(svg, 4.6, -1.2, -2.6, 'Water');
        leader(svg, 3.8, 1.2, 0.4, 'Steel cladding ⌀8.2 mm');
        leader(svg, 1.6, 1.6, 3.4, 'Boron carbide (B₄C)');
      } else {
        leader(svg, 2, 1, 0.4, 'Water only');
      }
      const tip = cell.rodded ? (1 - ins) * C.ACTIVE_H : null;
      setFacts([
        ['Control cluster', !cell.rodded ? 'None' : (cell.group === 'reg' ? 'Regulating group' : 'Shutdown group')],
        ['Sizes', 'Guide channel about ⌀12.6 mm, zirconium alloy; absorber rod ⌀8.2 mm'],
        ['Cluster position', cell.rodded ? fmt((1 - ins) * 100) + ' % of core height' : '–'],
        ['Absorber tip', cell.rodded ? fmt(tip, 2) + ' m above the bottom of the fuel' : '–'],
        ['At the mid-plane', inMid ? 'Absorber present' : 'Water only'],
        ['Absorber', 'Boron carbide; newer VVER clusters add dysprosium titanate at the tip'],
        ['On a scram', 'Clusters fall under gravity, all the way in within about 4 s'],
        ['Reactivity from rods now', fmt(S.parts.rods) + ' pcm']
      ]);
    }
    function renderCenter() {
      titleEl.textContent = 'Central tube';
      leadEl.textContent = 'The tube in the middle of every assembly. In instrumented assemblies it carries in-core detectors that measure the local neutron flux.';
      legend.innerHTML = '';
      refreshCenter();
    }
    function refreshCenter() {
      svgBox.innerHTML = '';
      const svg = el('svg', { viewBox: '-7.6 -7.6 29.6 15.2', class: 'xs-svg', role: 'img', 'aria-label': 'Central tube cross-section' }, svgBox);
      el('polygon', { points: hexPts(0, 0, 7.36, 0), class: 'xs-water' }, svg);
      el('circle', { cx: 0, cy: 0, r: 5.6, class: 'gtube' }, svg);
      el('circle', { cx: 0, cy: 0, r: 4.9, class: 'xs-water' }, svg);
      el('circle', { cx: 0, cy: 0, r: 1.9, class: 'aclad' }, svg);
      leader(svg, 4.9, -2.8, -4.8, 'Central tube');
      leader(svg, 3.2, 0.6, -1.4, 'Water');
      leader(svg, 1.2, 1.4, 2.4, 'Detector channel');
      const k = kq()[core.cells.indexOf(st.cell)];
      setFacts([
        ['Detectors', 'Self-powered neutron detectors along the core height'],
        ['What they read here', 'Relative power ' + fmt(k, 2) + ' at this assembly'],
        ['Why it matters', 'Operators reconstruct the 3D power map from these signals']
      ]);
    }

    /* ---------- navigation ---------- */
    function show(level, cell, pin) {
      st.level = level;
      if (level === 'core') { st.pin = null; }
      if (cell !== undefined) st.cell = cell;
      if (pin !== undefined) st.pin = pin;
      if (level === 'rod' && !st.pin) st.pin = guides[0];
      if (onSelectCell) onSelectCell(st.cell);
      setCrumbs();
      if (level === 'core') renderCore();
      else if (level === 'assembly') renderAssembly();
      else renderRod();
      root.querySelector('.xs-sheet').scrollTop = 0;
    }
    function open(level, cell, pin) {
      if (root.hidden) lastFocus = document.activeElement;
      root.hidden = false;
      document.documentElement.classList.add('xs-open');
      show(level || 'core', cell === undefined ? st.cell : cell, pin === undefined ? null : pin);
      $('#xsClose').focus({ preventScroll: true });
    }
    function close() {
      root.hidden = true;
      document.documentElement.classList.remove('xs-open');
      if (onSelectCell) onSelectCell(null);
      if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
    }
    function tick() {
      if (root.hidden) return;
      if (st.level === 'core') refreshCore();
      else if (st.level === 'assembly') refreshAssembly();
      else refreshRod();
    }
    $('#xsClose').addEventListener('click', close);
    root.addEventListener('click', e => { if (e.target === root) close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !root.hidden) close(); });
    modeBox.querySelectorAll('button').forEach(b => b.addEventListener('click', () => { st.mode = b.dataset.mode; renderCore(); }));

    return { open, close, tick, isOpen: () => !root.hidden, guides };
  };
})();
