/* 3D plant view (three.js r128). Builds the scene and exposes update/setView/highlight. */
(function () {
  'use strict';

  window.Plant3D = function (opts) {
    const { canvas, stage, labelsEl, P, R, core, onPick, onView } = opts;
    const S = R.S, clamp = P.clamp;
    const lerp = (a, b, t) => a + (b - a) * t;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    /* ---------- renderer, scene, lights ---------- */
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b1216);
    scene.fog = new THREE.Fog(0x0b1216, 170, 420);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 800);
    scene.add(new THREE.HemisphereLight(0xc8dae8, 0x1b2621, 0.55));
    const sun = new THREE.DirectionalLight(0xfff4e6, 0.95);
    sun.position.set(105, 100, 65); sun.target.position.set(45, 0, -5);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -95, right: 95, top: 95, bottom: -95, near: 1, far: 320 });
    sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.04;
    scene.add(sun, sun.target);

    // soft studio sky for reflections, so steel reads as metal rather than flat grey
    (function () {
      const env = new THREE.Scene();
      const geo = new THREE.SphereGeometry(50, 32, 16), pos = geo.attributes.position, cols = [];
      const top = new THREE.Color(0xa9bfcf), hor = new THREE.Color(0x4b5a62), bot = new THREE.Color(0x111816), c = new THREE.Color();
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i) / 50;
        if (y > 0) c.copy(hor).lerp(top, Math.pow(y, 0.6)); else c.copy(hor).lerp(bot, Math.min(1, -y * 3));
        cols.push(c.r, c.g, c.b);
      }
      geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
      env.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
      const box = new THREE.Mesh(new THREE.PlaneGeometry(40, 18), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }));
      box.position.set(20, 38, 22); box.lookAt(0, 0, 0); env.add(box);
      const pmrem = new THREE.PMREMGenerator(renderer);
      scene.environment = pmrem.fromScene(env, 0.03).texture;
      pmrem.dispose();
    })();

    const Y = new THREE.Vector3(0, 1, 0);
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    const M = (c, o) => new THREE.MeshStandardMaterial(Object.assign({ color: c, metalness: 0.45, roughness: 0.5 }, o || {}));
    const pickables = [];
    function add(geo, mat, pos, pick) {
      const m = new THREE.Mesh(geo, mat);
      if (pos) m.position.copy(pos);
      scene.add(m);
      if (pick) { m.userData.pick = pick; pickables.push(m); }
      return m;
    }

    const ground = add(new THREE.PlaneGeometry(600, 600), M(0x121a17, { metalness: 0, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    const grid = new THREE.GridHelper(600, 120, 0x2a3a33, 0x1f2b26);
    grid.position.y = 0.02; scene.add(grid);

    function glowTexture() {
      const c = document.createElement('canvas'); c.width = c.height = 128;
      const g = c.getContext('2d'), r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.25, 'rgba(255,255,255,.55)'); r.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = r; g.fillRect(0, 0, 128, 128);
      return new THREE.CanvasTexture(c);
    }
    const GLOW = glowTexture();

    /* ---------- pipes: routed with elbows, flow shown by moving arrows ---------- */
    const ARROWS = (function () {
      const c = document.createElement('canvas'); c.width = 128; c.height = 120;
      const g = c.getContext('2d');
      g.fillStyle = '#000'; g.fillRect(0, 0, 128, 120); g.fillStyle = '#fff';
      for (let row = 0; row < 3; row++) {
        const y = 20 + row * 40;
        g.beginPath();
        g.moveTo(26, y - 4); g.lineTo(70, y - 4); g.lineTo(70, y - 12); g.lineTo(100, y);
        g.lineTo(70, y + 12); g.lineTo(70, y + 4); g.lineTo(26, y + 4); g.closePath(); g.fill();
      }
      return c;
    })();
    const PIPE_STYLE = {
      hot:   { color: 0x8c2a1f, glow: 0xff6a45, name: 'Hot leg' },
      cold:  { color: 0x234f7d, glow: 0x6cb8ff, name: 'Cold leg' },
      surge: { color: 0x8c2a1f, glow: 0x000000, name: 'Surge line' },
      steam: { color: 0x8a6a12, glow: 0xffd65a, name: 'Main steam' },
      xover: { color: 0x7a6a3a, glow: 0xfff0b0, name: 'Crossover steam' },
      feed:  { color: 0x1f6a40, glow: 0x6ae69a, name: 'Feedwater' },
      cw:    { color: 0x1d5a6e, glow: 0x7fe0ff, name: 'Cooling water' },
      bus:   { color: 0x6d6450, glow: 0x000000, name: 'Generator busbar' }
    };
    const pipes = [];
    function elbowPath(pts, bend) {
      const path = new THREE.CurvePath();
      let prev = pts[0].clone();
      for (let i = 1; i < pts.length - 1; i++) {
        const a = pts[i - 1], p = pts[i], b = pts[i + 1];
        const d1 = p.clone().sub(a), d2 = b.clone().sub(p);
        const l1 = d1.length(), l2 = d2.length();
        d1.normalize(); d2.normalize();
        const r = Math.min(bend, l1 / 2, l2 / 2);
        const s = p.clone().addScaledVector(d1, -r), e = p.clone().addScaledVector(d2, r);
        if (prev.distanceTo(s) > 1e-4) path.add(new THREE.LineCurve3(prev.clone(), s));
        path.add(new THREE.QuadraticBezierCurve3(s, p.clone(), e));
        prev = e;
      }
      path.add(new THREE.LineCurve3(prev, pts[pts.length - 1].clone()));
      return path;
    }
    function pipe(pts, r, kind, o) {
      o = o || {};
      const path = elbowPath(pts.map(p => (p.isVector3 ? p : V(p[0], p[1], p[2]))), o.bend || Math.max(r * 2.2, 0.6));
      const L = path.getLength();
      const geo = new THREE.TubeGeometry(path, Math.min(700, Math.max(24, Math.round(L * 5))), r, 16, false);
      const st = PIPE_STYLE[kind];
      let tex = null;
      if (o.arrows !== false) {
        tex = new THREE.CanvasTexture(ARROWS);
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(Math.max(1, Math.round(L / Math.max(1.4, r * 5))), 1);
      }
      const mat = M(st.color, { metalness: 0.35, roughness: 0.42, emissive: st.glow, emissiveMap: tex, emissiveIntensity: tex ? 1 : 0 });
      const mesh = add(geo, mat, null, 'pipe');
      mesh.userData.kind = kind; mesh.userData.loop = o.loop;
      const rec = { mesh, mat, tex, kind, L, cycle: tex ? L / tex.repeat.x : 1 };
      pipes.push(rec);
      return rec;
    }

    /* ---------- containment ---------- */
    const contMat = new THREE.MeshBasicMaterial({ color: 0x9fb6c4, transparent: true, opacity: 0.06, depthWrite: false });
    add(new THREE.CylinderGeometry(16, 16, 26, 64, 1, true), contMat, V(0, 13, 0));
    add(new THREE.SphereGeometry(16, 48, 16, 0, Math.PI * 2, 0, Math.PI / 2), contMat, V(0, 26, 0));
    const ringMat = new THREE.LineBasicMaterial({ color: 0x5d7684, transparent: true, opacity: 0.45 });
    [0.1, 13, 26].forEach(h => {
      const pts = [];
      for (let i = 0; i <= 64; i++) { const a = i / 64 * Math.PI * 2; pts.push(V(16 * Math.sin(a), h, 16 * Math.cos(a))); }
      scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), ringMat));
    });

    /* ---------- reactor vessel, cut away toward +z ---------- */
    const steel = M(0x8b969c, { side: THREE.DoubleSide, metalness: 0.65, roughness: 0.42 });
    const GAP0 = 0.3 * Math.PI, GAPL = 1.4 * Math.PI;
    add(new THREE.CylinderGeometry(2.25, 2.25, 10, 48, 1, true, GAP0, GAPL), steel, V(0, 8, 0), 'vessel');
    add(new THREE.SphereGeometry(2.25, 40, 12, 0.8 * Math.PI, GAPL, Math.PI / 2, Math.PI / 2), steel, V(0, 3, 0), 'vessel').scale.y = 0.6;
    add(new THREE.SphereGeometry(2.25, 40, 12, 0.8 * Math.PI, GAPL, 0, Math.PI / 2), steel, V(0, 13, 0), 'vessel').scale.y = 0.6;
    add(new THREE.CylinderGeometry(1.98, 1.98, 6.2, 40, 1, true, GAP0, GAPL), M(0x6f7a80, { side: THREE.DoubleSide }), V(0, 5.9, 0), 'vessel');
    // give the vessel wall its thickness: an inner skin and light cut faces along the cutaway
    add(new THREE.CylinderGeometry(2.05, 2.05, 10, 48, 1, true, GAP0, GAPL), M(0x5d676c, { side: THREE.DoubleSide }), V(0, 8, 0));
    const cutMat = M(0xd3dadd, { metalness: 0.2, roughness: 0.55 });
    [GAP0, GAP0 + GAPL].forEach(th => { add(new THREE.BoxGeometry(0.02, 10, 0.2), cutMat, V(2.15 * Math.sin(th), 8, 2.15 * Math.cos(th))).rotation.y = th; });

    const waterMat = new THREE.MeshBasicMaterial({ color: 0x2c8cff, transparent: true, opacity: 0.08, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    add(new THREE.CylinderGeometry(2.15, 2.15, 9.6, 40, 1, false), waterMat, V(0, 7.9, 0));
    const coreGlowMat = new THREE.MeshBasicMaterial({ color: 0x3aa4ff, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    add(new THREE.CylinderGeometry(1.95, 1.95, 4.6, 40, 1, false), coreGlowMat, V(0, 5.5, 0));
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW, color: 0x45aaff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    halo.position.set(0, 5.5, 0.4); halo.scale.set(8.5, 8.5, 1); scene.add(halo);
    const blueLight = new THREE.PointLight(0x4aa8ff, 3, 14, 1.6);
    blueLight.position.set(0, 5.5, 1.2); scene.add(blueLight);

    /* ---------- core: 163 assemblies, 121 control clusters ---------- */
    const PITCH = 0.236, H = 3.75, CORE_B = 3.6;
    core.cells.forEach(c => { c.x = PITCH * c.u; c.z = PITCH * c.v; c.r3 = Math.hypot(c.x, c.z); });
    const inGap = c => c.r3 > 0.3 && Math.abs(Math.atan2(c.x, c.z)) < 0.3 * Math.PI;
    const fuelCells = core.cells.filter(c => !inGap(c));
    const rodded = core.cells.filter(c => c.rodded);
    const mtx = new THREE.Matrix4(), qI = new THREE.Quaternion(), one = V(1, 1, 1), tmpC = new THREE.Color();
    const hexR = PITCH / Math.sqrt(3) * 0.94;
    const fuelMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(hexR, hexR, H, 6), M(0xffffff, { metalness: 0.3, roughness: 0.55 }), fuelCells.length);
    fuelCells.forEach((c, i) => {
      mtx.compose(V(c.x, CORE_B + H / 2, c.z), qI, one);
      fuelMesh.setMatrixAt(i, mtx); fuelMesh.setColorAt(i, tmpC.set(0x7d8287));
    });
    fuelMesh.userData.pick = 'fuel'; pickables.push(fuelMesh); scene.add(fuelMesh);

    const rodMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.075, 0.075, H, 10), M(0x2e3438, { metalness: 0.6, roughness: 0.35 }), rodded.length);
    const tipMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.09, 0.09, 0.14, 10), new THREE.MeshBasicMaterial({ color: 0xffc83a }), rodded.length);
    const shaftMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.025, 0.025, 1, 6), M(0xa3adb2), rodded.length);
    const rodProxy = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.17, 0.17, H, 6), new THREE.MeshBasicMaterial(), rodded.length);
    rodProxy.visible = false; rodProxy.userData.pick = 'rod';
    scene.add(rodMesh, tipMesh, shaftMesh, rodProxy); pickables.push(rodProxy);
    const crdmCells = rodded.filter(c => !inGap(c));
    const crdm = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.075, 0.075, 3, 8), M(0x9aa4a9), crdmCells.length);
    crdmCells.forEach((c, i) => { mtx.compose(V(c.x * 1.05, 15.7, c.z * 1.05), qI, one); crdm.setMatrixAt(i, mtx); });
    scene.add(crdm);
    const sc = V(1, 1, 1), tiny = V(0.001, 0.001, 0.001);
    function updateRods() {
      const reg = R.regX();
      rodded.forEach((c, i) => {
        const x = c.group === 'reg' ? reg : S.sdX;
        const bottom = CORE_B + (1 - x) * H, top = bottom + H;
        mtx.compose(V(c.x, bottom + H / 2, c.z), qI, one);
        rodMesh.setMatrixAt(i, mtx); rodProxy.setMatrixAt(i, mtx);
        mtx.compose(V(c.x, bottom - 0.05, c.z), qI, c.group === 'reg' ? one : tiny); tipMesh.setMatrixAt(i, mtx);
        const L = 14.2 - top; sc.set(1, L, 1);
        mtx.compose(V(c.x, top + L / 2, c.z), qI, sc); shaftMesh.setMatrixAt(i, mtx);
      });
      rodMesh.instanceMatrix.needsUpdate = tipMesh.instanceMatrix.needsUpdate = true;
      shaftMesh.instanceMatrix.needsUpdate = rodProxy.instanceMatrix.needsUpdate = true;
    }
    const COLD = new THREE.Color(0x6d7378), HOT = new THREE.Color(0xe8782c), WHITE = new THREE.Color(0xffd9a0), SEL = new THREE.Color(0x7fe3ff);
    let selected = null;
    const cellIndex = new Map(core.cells.map((c, i) => [c, i]));
    function updateCore() {
      const K = P.assemblyPowers(core, R.regX(), S.sdX);
      const p = Math.min(S.n, 1.3);
      fuelCells.forEach((c, i) => {
        const g = clamp(p * K[cellIndex.get(c)] * 0.8, 0, 1.4);
        tmpC.copy(COLD).lerp(HOT, clamp(Math.pow(g, 0.6), 0, 1));
        if (g > 1) tmpC.lerp(WHITE, Math.min(0.35, (g - 1) * 0.8));
        if (c === selected) tmpC.lerp(SEL, 0.75);
        fuelMesh.setColorAt(i, tmpC);
      });
      fuelMesh.instanceColor.needsUpdate = true;
      const glow = Math.max(clamp(Math.sqrt(S.n), 0, 1.2), clamp((S.Pth - S.n * (1 - P.C.DH_SUM)) * 4, 0, 0.3));
      coreGlowMat.opacity = 0.015 + 0.11 * glow; waterMat.opacity = 0.015 + 0.05 * glow;
      halo.material.opacity = 0.03 + 0.22 * glow; blueLight.intensity = 0.15 + 1.6 * glow;
    }

    /* ---------- four primary loops ---------- */
    // steam generator shells are solid, cut open along the top so the tube bundle shows
    const sgShellMat = M(0x9aa6ac, { side: THREE.DoubleSide, metalness: 0.55, roughness: 0.48, envMapIntensity: 0.7 });
    const SG_GAP = 0.42 * Math.PI;
    const sgShellGeo = new THREE.CylinderGeometry(2, 2, 12, 40, 1, true, SG_GAP, 2 * Math.PI - 2 * SG_GAP);
    const sgCapGeo = [0, Math.PI / 2].map(t0 => new THREE.SphereGeometry(2, 32, 12, Math.PI / 2 + SG_GAP, 2 * Math.PI - 2 * SG_GAP, t0, Math.PI / 2));
    const sgTubeMat = new THREE.MeshBasicMaterial({ color: 0xd8794a });
    const sgTubes = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.05, 0.05, 10.4, 6), sgTubeMat, 4 * 5 * 7);
    let tI = 0;
    const pumps = [], sgCenters = [], pumpPos = [], hotMid = [], coldMid = [];
    const NOZ = 2.2;
    [45, 135, 225, 315].forEach((deg, k) => {
      const a = deg * Math.PI / 180, n = V(Math.sin(a), 0, Math.cos(a)), t = V(Math.cos(a), 0, -Math.sin(a));
      const c = n.clone().multiplyScalar(9.5).setY(15); sgCenters.push(c);
      const qT = new THREE.Quaternion().setFromUnitVectors(Y, t);
      // local y along the shell axis, local z (the opening) pointing up
      const qSG = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(t.clone().cross(Y), t, Y));
      const shell = add(sgShellGeo, sgShellMat, c, 'sg'); shell.quaternion.copy(qSG); shell.userData.loop = k;
      [6, -6].forEach((o, j) => {
        const cap = add(sgCapGeo[j], sgShellMat, c.clone().addScaledVector(t, o), 'sg');
        cap.quaternion.copy(qSG); cap.userData.loop = k;
      });
      for (let j = 0; j < 5; j++) for (let m = -3; m <= 3; m++) {
        mtx.compose(c.clone().addScaledVector(n, m * 0.4).setY(c.y - 1.4 + j * 0.32), qT, one);
        sgTubes.setMatrixAt(tI++, mtx);
      }
      // loops 3 and 4 are mirrored so no pump or cold leg sits in front of the vessel cutaway
      const mir = k >= 2 ? -1 : 1;
      const hc = c.clone().addScaledVector(t, -1.3 * mir), cc = c.clone().addScaledVector(t, 1.3 * mir);
      [[hc, 0xb56a5c], [cc, 0x6d8fae]].forEach(([p, col]) => {
        add(new THREE.CylinderGeometry(0.5, 0.5, 6, 18), M(col), V(p.x, 14.6, p.z), 'sg').userData.loop = k;
        add(new THREE.CylinderGeometry(0.72, 0.72, 0.25, 18), M(0x8b969c), V(p.x, 17.7, p.z));
      });
      // hot leg: straight from the upper nozzle row, elbow up into the hot collector
      const dH = V(hc.x, 0, hc.z).normalize();
      pipe([dH.clone().multiplyScalar(NOZ).setY(10.4), V(hc.x, 10.4, hc.z), V(hc.x, 11.7, hc.z)], 0.45, 'hot', { bend: 0.9, loop: k });
      hotMid.push(dH.clone().multiplyScalar(5.2).setY(10.4));
      // main coolant pump
      const pa = a + 0.40 * mir, pn = V(Math.sin(pa), 0, Math.cos(pa)), Pp = pn.clone().multiplyScalar(6.0);
      pumpPos.push(Pp.clone());
      add(new THREE.CylinderGeometry(1.0, 0.8, 2.2, 24), M(0x7f8b90), V(Pp.x, 9.0, Pp.z), 'pump').userData.loop = k;
      add(new THREE.CylinderGeometry(0.75, 0.75, 2.2, 24), M(0x3f5b4a), V(Pp.x, 11.2, Pp.z), 'pump').userData.loop = k;
      const fly = new THREE.Group(); fly.position.set(Pp.x, 12.45, Pp.z);
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.95, 0.22, 24), M(0x56646a));
      disc.userData = { pick: 'pump', loop: k }; pickables.push(disc); fly.add(disc);
      const mark = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.26, 0.16), new THREE.MeshBasicMaterial({ color: 0xffc83a }));
      mark.position.x = 0.45; fly.add(mark);
      scene.add(fly); pumps.push(fly);
      // cold leg: down from the cold collector through the loop seal into the pump, then to the lower nozzle row
      pipe([V(cc.x, 11.7, cc.z), V(cc.x, 5.5, cc.z), V(Pp.x, 5.5, Pp.z), V(Pp.x, 7.95, Pp.z)], 0.45, 'cold', { bend: 1.0, loop: k });
      pipe([V(Pp.x, 9.4, Pp.z), pn.clone().multiplyScalar(NOZ).setY(9.4)], 0.45, 'cold', { loop: k });
      coldMid.push(pn.clone().multiplyScalar(3.6).setY(9.4));
      // nozzle collars on the vessel
      [[dH, 10.4], [pn, 9.4]].forEach(([d, y]) => {
        const col = add(new THREE.CylinderGeometry(0.62, 0.62, 0.5, 18), steel, d.clone().multiplyScalar(2.35).setY(y));
        col.quaternion.setFromUnitVectors(Y, d);
      });
      // steam line from the top of the steam generator to the header outside containment
      const zk = [2.1, -2.1, -0.7, 0.7][k], yk = [21, 21, 23, 23][k];
      pipe([V(c.x, 16.9, c.z), V(c.x, yk, c.z), V(c.x, yk, zk), V(26, yk, zk), V(26, 20.05, zk)], 0.32, 'steam', { bend: 0.9, loop: k });
      // feedwater riser from the ring header into the steam generator
      pipe([n.clone().multiplyScalar(13).setY(2.5), n.clone().multiplyScalar(13).setY(15), n.clone().multiplyScalar(11.45).setY(15)], 0.2, 'feed', { bend: 0.7, loop: k });
    });
    scene.add(sgTubes);

    // pressurizer and surge line
    add(new THREE.CylinderGeometry(1.4, 1.4, 11, 32), M(0x9aa5ab), V(7.5, 11.5, 0), 'prz');
    add(new THREE.SphereGeometry(1.4, 24, 12), M(0x9aa5ab), V(7.5, 17, 0), 'prz').scale.y = 0.55;
    add(new THREE.SphereGeometry(1.4, 24, 12), M(0x9aa5ab), V(7.5, 6, 0), 'prz').scale.y = 0.55;
    const hl2 = (127.2 * Math.PI) / 180;
    pipe([V(7.5, 5.4, 0), V(7.5, 3.2, 0), V(5 * Math.sin(hl2), 3.2, 5 * Math.cos(hl2)), V(5 * Math.sin(hl2), 9.98, 5 * Math.cos(hl2))], 0.16, 'surge', { arrows: false, bend: 0.5 });

    // feedwater ring header inside containment
    const ring = add(new THREE.TorusGeometry(13, 0.24, 10, 120), M(PIPE_STYLE.feed.color, { metalness: 0.35, roughness: 0.42 }), V(0, 2.5, 0), 'pipe');
    ring.rotation.x = Math.PI / 2; ring.userData.kind = 'feed';

    /* ---------- steam header and turbine hall ---------- */
    add(new THREE.CylinderGeometry(0.7, 0.7, 6, 18), M(PIPE_STYLE.steam.color), V(26, 20, 0), 'pipe').rotation.x = Math.PI / 2;
    pickables[pickables.length - 1].userData.kind = 'steam';
    pipe([V(26, 20, 0), V(36, 20, 0), V(36, 10.4, 0)], 0.55, 'steam', { bend: 1.4 });
    pipe([V(38.6, 10.6, 0), V(38.6, 14, 0), V(46, 14, 0), V(46, 11.6, 0)], 0.6, 'xover', { bend: 1.2 });
    pipe([V(45.4, 14, 0), V(57, 14, 0), V(57, 11.6, 0)], 0.6, 'xover', { bend: 1.2 });

    const hall = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(50, 22, 26)), new THREE.LineBasicMaterial({ color: 0x4d6470, transparent: true, opacity: 0.6 }));
    hall.position.set(54, 11, 0); scene.add(hall);
    add(new THREE.BoxGeometry(50, 0.3, 26), M(0x2a3832, { metalness: 0, roughness: 1, transparent: true, opacity: 0.45, depthWrite: false }), V(54, 4.2, 0));
    const casingLo = M(0x8c979c, { side: THREE.DoubleSide });
    const casingHi = M(0xa9b6bb, { transparent: true, opacity: 0.1, depthWrite: false });
    const flangeMat = M(0x9aa6ab, { metalness: 0.7, roughness: 0.3 });
    function flange(x, r) { add(new THREE.TorusGeometry(r, 0.14, 8, 40), flangeMat, V(x, 8, 0)).rotation.y = Math.PI / 2; }
    function casing(x0, x1, r0, r1) {
      const L = x1 - x0, cx = (x0 + x1) / 2;
      add(new THREE.CylinderGeometry(r1, r0, L, 32, 1, true, 0, Math.PI), casingLo, V(cx, 8, 0), 'turbine').rotation.z = -Math.PI / 2;
      add(new THREE.CylinderGeometry(r1, r0, L, 32, 1, true, Math.PI, Math.PI), casingHi, V(cx, 8, 0)).rotation.z = -Math.PI / 2;
      flange(x0, r0); flange(x1, r1);
    }
    casing(33, 39.5, 2.0, 2.6); casing(42, 50, 3.8, 3.8); casing(53, 61, 3.8, 3.8);
    add(new THREE.CylinderGeometry(2.6, 2.6, 9, 32, 1, true, 0, Math.PI), M(0x4a6a58, { side: THREE.DoubleSide }), V(68, 8, 0), 'generator').rotation.z = -Math.PI / 2;
    add(new THREE.CylinderGeometry(2.6, 2.6, 9, 32, 1, true, Math.PI, Math.PI), M(0x6c9a80, { transparent: true, opacity: 0.12, depthWrite: false }), V(68, 8, 0)).rotation.z = -Math.PI / 2;
    flange(63.5, 2.6); flange(72.5, 2.6);
    add(new THREE.CylinderGeometry(1.1, 1.1, 2, 24), M(0x4a6a58), V(74, 8, 0), 'generator').rotation.z = Math.PI / 2;

    const rotor = new THREE.Group(); rotor.position.set(0, 8, 0); scene.add(rotor);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 44, 16), M(0xc3ccd0, { metalness: 0.8, roughness: 0.25 }));
    shaft.rotation.z = Math.PI / 2; shaft.position.x = 53.5; rotor.add(shaft);
    const rows = [];
    for (let i = 0; i < 6; i++) rows.push({ x: 34 + i * 0.95, len: 0.55 + i * 0.12 });
    [46, 57].forEach(cx => { for (let i = 0; i < 5; i++) { const l = 1.0 + i * 0.55; rows.push({ x: cx - 0.6 - i * 0.8, len: l }, { x: cx + 0.6 + i * 0.8, len: l }); } });
    const BL = 28, blades = new THREE.InstancedMesh(new THREE.BoxGeometry(0.1, 1, 0.42), M(0xd9dfe2, { metalness: 0.85, roughness: 0.22 }), rows.length * BL);
    let bI = 0;
    const qB = new THREE.Quaternion(), eul = new THREE.Euler();
    rows.forEach(rw => {
      for (let j = 0; j < BL; j++) {
        const a = j / BL * Math.PI * 2, rad = 0.45 + rw.len / 2;
        eul.set(a, 0, 0); qB.setFromEuler(eul);
        mtx.compose(V(rw.x, Math.cos(a) * rad, Math.sin(a) * rad), qB, V(1, rw.len, 1));
        blades.setMatrixAt(bI++, mtx);
      }
    });
    blades.userData.pick = 'turbine'; pickables.push(blades); rotor.add(blades);
    const genRotor = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 7, 24), M(0x7b5b3a, { metalness: 0.6 }));
    genRotor.rotation.z = Math.PI / 2; genRotor.position.x = 68; rotor.add(genRotor);
    for (let i = 0; i < 4; i++) {
      const pole = new THREE.Mesh(new THREE.BoxGeometry(7.1, 0.35, 0.5), new THREE.MeshBasicMaterial({ color: 0xd9a441 }));
      const a = i * Math.PI / 2; pole.position.set(68, Math.cos(a) * 1.38, Math.sin(a) * 1.38); pole.rotation.x = a; rotor.add(pole);
    }

    // condenser, feed train, cooling water
    add(new THREE.BoxGeometry(20, 4.2, 9), M(0x5c7484, { metalness: 0.3 }), V(51.5, 2.1, 0), 'condenser');
    add(new THREE.BoxGeometry(3, 2, 2), M(0x3f6a52), V(33, 1.2, 6.5), 'feedpump');
    pipe([V(42.5, 1.2, 4.6), V(42.5, 1.2, 6.5), V(34.6, 1.2, 6.5)], 0.22, 'feed', { bend: 0.6 });
    pipe([V(31.5, 2.5, 6.5), V(11.26, 2.5, 6.5)], 0.24, 'feed');
    pipe([V(50, 0.9, -4.6), V(50, 0.9, -26), V(94, 0.9, -26), V(94, 0.9, -34)], 0.9, 'cw', { bend: 2.4 });
    pipe([V(98, 0.9, -30), V(98, 0.9, -22), V(55, 0.9, -22), V(55, 0.9, -4.6)], 0.9, 'cw', { bend: 2.4 });

    const tp = [];
    for (let y = 0; y <= 52; y += 2) tp.push(new THREE.Vector2(9 * Math.sqrt(1 + Math.pow((y - 38) / 22, 2)), y));
    add(new THREE.LatheGeometry(tp, 56), M(0x656c68, { metalness: 0, roughness: 1, envMapIntensity: 0.25, side: THREE.DoubleSide }), V(110, 0, -42), 'tower');
    const plume = [];
    for (let i = 0; i < 16; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW, color: 0xe8eef2, transparent: true, depthWrite: false, opacity: 0.3 }));
      sp.userData.age = i / 16; scene.add(sp); plume.push(sp);
    }

    // grid connection with travelling pulses
    add(new THREE.BoxGeometry(4, 4.5, 3.5), M(0x58626a), V(80, 2.25, 9), 'generator');
    const pyl = [V(92, 0, 16), V(106, 0, 24), V(120, 0, 32)];
    pyl.forEach(p => {
      add(new THREE.CylinderGeometry(0.25, 0.9, 18, 4), M(0x7d878c), V(p.x, 9, p.z));
      add(new THREE.BoxGeometry(0.4, 0.4, 7), M(0x7d878c), V(p.x, 16.5, p.z));
    });
    const wireMat = new THREE.MeshBasicMaterial({ color: 0x3a3f30 });
    const wires = [-3, 0, 3].map(o => {
      const pts = [V(80, 4.5, 9 + o * 0.3)]; pyl.forEach(p => pts.push(V(p.x, 16.3, p.z + o)));
      const c = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.1);
      scene.add(new THREE.Mesh(new THREE.TubeGeometry(c, 80, 0.07, 6, false), wireMat));
      return c;
    });
    pipe([V(72.5, 8, 0), V(76.5, 8, 0), V(76.5, 4.5, 8)], 0.2, 'bus', { arrows: false });
    const pulseItems = [];
    wires.forEach(c => { const L = c.getLength(); for (let i = 0; i < 10; i++) pulseItems.push({ c, L, t: i / 10 }); });
    const pulses = new THREE.InstancedMesh(new THREE.SphereGeometry(0.22, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffe27a }), pulseItems.length);
    scene.add(pulses);
    const pv = V(0, 0, 0), pscale = V(1, 1, 1);

    // every solid lit surface casts and takes shadow; glass, glow and the ground plane do not cast
    scene.traverse(o => {
      if (!o.isMesh || !o.material || !o.material.isMeshStandardMaterial || o.material.transparent) return;
      o.castShadow = o !== ground; o.receiveShadow = true;
    });

    /* ---------- labels ---------- */
    const labels = [
      { name: 'Reactor', pos: V(0, 18.6, 0), pick: 'reactor', view: 'core', maxR: 400 },
      { name: 'Control rods', pos: V(0.9, 12.4, 1.7), pick: 'rodinfo', maxR: 40 },
      { name: 'Steam generator', pos: sgCenters[0].clone().setY(17.4), pick: 'sg', view: 'steam', loop: 0, maxR: 400 },
      { name: 'Main coolant pump', pos: pumpPos[3].clone().setY(12.7), pick: 'pump', view: 'steam', maxR: 95, loop: 3 },
      { name: 'Pressurizer', pos: V(7.5, 18.8, 0), pick: 'prz', maxR: 95 },
      { name: 'Hot leg', pos: hotMid[0], pick: 'pipe', kind: 'hot', loop: 0, maxR: 60 },
      { name: 'Cold leg', pos: coldMid[0], pick: 'pipe', kind: 'cold', loop: 0, maxR: 60 },
      { name: 'Main steam', pos: V(31, 21.2, 0), pick: 'pipe', kind: 'steam', maxR: 140 },
      { name: 'Feedwater', pos: V(21, 3.4, 6.5), pick: 'pipe', kind: 'feed', maxR: 140 },
      { name: 'Turbine', pos: V(48, 14.6, 0), pick: 'turbine', view: 'turbine', maxR: 400 },
      { name: 'Generator', pos: V(68, 12.5, 0), pick: 'generator', view: 'turbine', maxR: 400 },
      { name: 'Condenser', pos: V(51.5, 5, 5.5), pick: 'condenser', maxR: 150 },
      { name: 'Cooling tower', pos: V(110, 56, -42), pick: 'tower', maxR: 400 }
    ];
    labels.forEach(l => {
      const b = document.createElement('button');
      b.className = 'tag'; b.type = 'button';
      const sp = document.createElement('span'); sp.textContent = l.name; b.appendChild(sp);
      b.addEventListener('click', () => { if (l.view) setView(l.view); onPick(l.pick, { kind: l.kind, loop: l.loop }); });
      labelsEl.appendChild(b); l.el = b;
    });
    const lp = V(0, 0, 0);
    // labels are placed in list order; one that would overlap an already placed label is hidden
    function updateLabels() {
      const w = canvas.clientWidth, h = canvas.clientHeight, placed = [];
      labels.forEach(l => {
        lp.copy(l.pos).project(camera);
        let vis = lp.z < 1 && Math.abs(lp.x) < 1.05 && Math.abs(lp.y) < 1.05 && cam.r < l.maxR;
        const x = (lp.x + 1) / 2 * w, y = (1 - lp.y) / 2 * h;
        if (vis) {
          if (!l.w) { l.el.style.display = ''; l.w = l.el.offsetWidth; l.h = l.el.offsetHeight; }
          const box = [x - l.w / 2 - 3, y - l.h - 2, x + l.w / 2 + 3, y];
          vis = !placed.some(b => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]);
          if (vis) placed.push(box);
        }
        l.el.style.display = vis ? '' : 'none';
        if (vis) l.el.style.transform = 'translate(' + x + 'px,' + y + 'px) translate(-50%,-100%)';
      });
    }

    /* ---------- camera ---------- */
    const VIEWS = {
      overview: { t: V(42, 6, -6), r: 125, th: 0.6, ph: 1.08 },
      core: { t: V(0, 7, 0), r: 17, th: 0, ph: 1.15 },
      steam: { t: V(2, 12, 0), r: 30, th: 0.55, ph: 1.0 },
      turbine: { t: V(53, 7, 0), r: 44, th: 0.42, ph: 1.18 }
    };
    const cam = { t: VIEWS.overview.t.clone(), r: VIEWS.overview.r, th: VIEWS.overview.th, ph: VIEWS.overview.ph };
    const goal = { t: cam.t.clone(), r: cam.r, th: cam.th, ph: cam.ph };
    function setView(k, instant) {
      const v = VIEWS[k]; if (!v) return;
      goal.t.copy(v.t); goal.r = v.r; goal.ph = v.ph;
      let d = v.th - goal.th; d = ((d + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI; goal.th += d;
      if (instant || reduceMotion) { cam.t.copy(goal.t); cam.r = goal.r; cam.th = goal.th; cam.ph = goal.ph; }
      if (onView) onView(k);
    }
    function applyCam() {
      const s = Math.sin(cam.ph);
      camera.position.set(cam.t.x + cam.r * s * Math.sin(cam.th), cam.t.y + cam.r * Math.cos(cam.ph), cam.t.z + cam.r * s * Math.cos(cam.th));
      camera.lookAt(cam.t);
    }
    const ptrs = new Map();
    let pinch = 0, down = null;
    canvas.addEventListener('pointerdown', e => {
      canvas.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      down = ptrs.size === 1 ? { x: e.clientX, y: e.clientY, t: performance.now(), moved: false } : null;
      if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); }
    });
    canvas.addEventListener('pointermove', e => {
      if (!ptrs.has(e.pointerId)) return;
      const p = ptrs.get(e.pointerId);
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 7) down.moved = true;
      if (ptrs.size === 1) { goal.th -= (e.clientX - p.x) * 0.006; goal.ph = clamp(goal.ph - (e.clientY - p.y) * 0.005, 0.12, 1.5); }
      p.x = e.clientX; p.y = e.clientY;
      if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch > 0) goal.r = clamp(goal.r * pinch / d, 6, 260);
        pinch = d;
      }
    });
    function up(e) {
      ptrs.delete(e.pointerId); pinch = 0;
      if (e.type === 'pointerup' && down && !down.moved && performance.now() - down.t < 600 && ptrs.size === 0) pickAt(e.clientX, e.clientY);
      if (ptrs.size === 0) down = null;
    }
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('wheel', e => { e.preventDefault(); goal.r = clamp(goal.r * Math.exp(e.deltaY * 0.0012), 6, 260); }, { passive: false });

    const raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2();
    function pickAt(cx, cy) {
      const rect = canvas.getBoundingClientRect();
      ndc.set((cx - rect.left) / rect.width * 2 - 1, -(cy - rect.top) / rect.height * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObjects(pickables, false);
      if (!hits.length) return;
      const h = hits[0], u = h.object.userData;
      if (u.pick === 'fuel') onPick('assembly', { cell: fuelCells[h.instanceId] });
      else if (u.pick === 'rod') onPick('rod', { cell: rodded[h.instanceId] });
      else onPick(u.pick, { kind: u.kind, loop: u.loop });
    }

    function resize() {
      const w = stage.clientWidth, h = stage.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false); camera.aspect = w / h;
      // keep at least ~50° of horizontal view so portrait phones still frame the plant
      const minH = 50 * Math.PI / 180, vf = 2 * Math.atan(Math.tan(minH / 2) / camera.aspect) * 180 / Math.PI;
      camera.fov = Math.min(75, Math.max(45, vf));
      camera.updateProjectionMatrix();
    }

    /* ---------- per-frame update ---------- */
    const hotCol = new THREE.Color(), baseHot = new THREE.Color(PIPE_STYLE.hot.color);
    function flowOf(kind, steam, dump, rej) {
      switch (kind) {
        case 'hot': case 'cold': return { v: 3.2 * S.flow, f: S.flow };
        case 'steam': return { v: 4.5 * (steam + dump), f: steam + dump };
        case 'xover': return { v: 4 * steam, f: steam };
        case 'feed': return { v: 2 * (steam + dump), f: steam + dump };
        case 'cw': return { v: 2.2 * rej, f: rej };
        default: return { v: 0, f: 0 };
      }
    }
    function update(rdt) {
      updateRods(); updateCore();
      const steam = Math.max(0, S.Ps), dump = R.onGrid() ? 0 : S.qsg;
      const rej = clamp((S.qsg - S.Ps * P.C.ETA) / 0.6 + (S.qsg > 0.01 ? 0.12 : 0), 0, 1.3);
      pipes.forEach(p => {
        if (!p.tex) return;
        const fl = flowOf(p.kind, steam, dump, rej);
        p.tex.offset.x -= fl.v * rdt / p.cycle;
        p.mat.emissiveIntensity = fl.f > 0.01 ? 0.25 + 0.85 * Math.min(1, fl.f) : 0;
      });
      hotCol.copy(baseHot).lerp(new THREE.Color(0xd8452f), clamp((R.coreOut() - 295) / 35, 0, 1));
      pipes.forEach(p => { if (p.kind === 'hot' || p.kind === 'surge') p.mat.color.copy(hotCol); });
      sgTubeMat.color.setRGB(0.55 + 0.4 * clamp((S.Tm - 286) / 30, 0, 1), 0.4, 0.3);
      pumps.forEach((p, i) => { p.rotation.y += (S.pumps[i] ? 1 : 0.05) * S.flow * 9 * rdt; });
      rotor.rotation.x += (S.rpm / 3000) * 2 * Math.PI * 0.9 * rdt;
      plume.forEach(sp => {
        sp.userData.age = (sp.userData.age + rdt * 0.06) % 1;
        const a = sp.userData.age, s = 14 + a * 40;
        sp.position.set(110 + a * 30, 52 + a * 55, -42 + a * 8); sp.scale.set(s, s, 1);
        sp.material.opacity = clamp(rej, 0, 1.2) * 0.32 * (1 - a) * Math.min(1, a * 6);
      });
      const e = steam;
      wireMat.color.setRGB(0.23 + 0.7 * e, 0.25 + 0.6 * e, 0.19 + 0.1 * e);
      pscale.setScalar(e > 0.01 ? 1 : 0.001);
      pulseItems.forEach((it, i) => {
        it.t = (it.t + 40 * e * rdt / it.L) % 1;
        it.c.getPointAt(it.t, pv); mtx.compose(pv, qI, pscale); pulses.setMatrixAt(i, mtx);
      });
      pulses.instanceMatrix.needsUpdate = true;

      cam.t.lerp(goal.t, Math.min(1, rdt * 4));
      const k = Math.min(1, rdt * 5);
      cam.r = lerp(cam.r, goal.r, k); cam.th = lerp(cam.th, goal.th, k); cam.ph = lerp(cam.ph, goal.ph, k);
      applyCam();
      renderer.render(scene, camera);
      updateLabels();
    }

    return {
      update, setView, resize, views: VIEWS,
      highlight(cell) { selected = cell || null; },
      pipeName: kind => (PIPE_STYLE[kind] || {}).name
    };
  };
})();
