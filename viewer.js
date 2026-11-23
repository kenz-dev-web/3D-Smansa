import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { buildWorld } from './world/index.js';
import { Lighting } from './world/lighting.js';
import { interactive, toggleLeaf, updateLeaves, setAllLeaves } from './engine/openings.js';

/* Cinematic grade: teal shadows / warm highlights, filmic S-curve, soft vignette, subtle fringe + grain */
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uBars: { value: 0 }, uNight: { value: 0 }, uAspect: { value: 1 }, uFish: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float uTime, uBars, uNight, uAspect, uFish; varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
    void main(){
      vec2 uv = vUv; vec2 c = uv - 0.5;
      float r2 = dot(c * vec2(uAspect,1.0), c * vec2(uAspect,1.0));
      uv = 0.5 + c * (1.0 + uFish * r2 * 0.9);
      float ca = 0.0016 + r2 * 0.004;
      vec3 col = vec3(texture2D(tDiffuse, uv + c * ca).r, texture2D(tDiffuse, uv).g, texture2D(tDiffuse, uv - c * ca).b);
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      // filmic contrast around mid-grey
      col = mix(vec3(l), col, 1.14);
      col = (col - 0.5) * 1.1 + 0.5 + 0.01;
      // split toning
      vec3 shadow = vec3(0.04, 0.17, 0.22), high = vec3(1.0, 0.72, 0.42);
      float sh = pow(1.0 - clamp(l, 0.0, 1.0), 2.4), hi = pow(clamp(l, 0.0, 1.0), 2.0);
      col = mix(col, col * (1.0 + shadow * 1.6) + shadow * 0.07, sh * 0.55);
      col = mix(col, col * (0.9 + high * 0.24), hi * 0.6);
      col = mix(col, col * vec3(0.9, 0.98, 1.2), uNight * 0.45);
      // lifted blacks (film) + gentle roll-off
      col = max(col, vec3(0.012, 0.016, 0.02));
      col = col / (1.0 + 0.06 * col);
      // vignette
      float v = smoothstep(1.05, 0.28, length(c * vec2(uAspect * 0.78, 1.0)) * 1.25);
      col *= mix(0.62, 1.0, v);
      // grain
      float g = hash(uv * 1500.0 + fract(uTime) * 91.7) - 0.5;
      col += g * 0.035 * (1.0 - l * 0.6);
      // letterbox
      float bar = uBars * 0.115;
      if (vUv.y < bar || vUv.y > 1.0 - bar) col = vec3(0.0);
      gl_FragColor = vec4(col, 1.0);
    }`,
};

const $ = (s) => document.querySelector(s);

export async function startViewer({ onProgress, onReady }) {
  const container = $('#viewer');
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false });
  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(DPR); renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.6;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 0.4, 5200);
  camera.position.set(52, 26, 128); scene.add(camera);

  const world = await buildWorld(scene, onProgress);
  const { ctx, colliders } = world;
  const lighting = new Lighting(renderer, scene, ctx);

  // ---- post processing ----
  const rt = new THREE.WebGLRenderTarget(innerWidth * DPR, innerHeight * DPR, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(DPR); composer.setSize(innerWidth, innerHeight);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.38, 0.7, 0.9); composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const grade = new ShaderPass(GradeShader); composer.addPass(grade);
  grade.uniforms.uAspect.value = innerWidth / innerHeight;

  // ---- camera modes ----
  const orbit = new OrbitControls(camera, renderer.domElement);
  orbit.target.set(0, 5, 26); orbit.enableDamping = true; orbit.dampingFactor = 0.07;
  orbit.maxPolarAngle = Math.PI * 0.495; orbit.minDistance = 3; orbit.maxDistance = 420; orbit.autoRotateSpeed = 0.5;
  let mode = 'orbit';
  const modeListeners = [];
  const tween = { active: false, t: 0, dur: 2, fromP: new THREE.Vector3(), toP: new THREE.Vector3(), fromT: new THREE.Vector3(), toT: new THREE.Vector3() };
  const presets = {
    gerbang: { p: [30, 7, 128], t: [0, 5, 80], label: 'Gerbang depan' },
    fasad: { p: [-4, 3.2, 96], t: [0, 6, 70], label: 'Fasad & logo' },
    lobi: { p: [0, 2.1, 80], t: [0, 2.4, 40], label: 'Lobi tembus' },
    upacara: { p: [0, 3.0, 50], t: [0, 7, 0], label: 'Halaman upacara' },
    utama: { p: [-18, 5, 24], t: [0, 6, -4], label: 'Gedung utama' },
    masjid: { p: [-52, 12, -48], t: [-76, 8, -76], label: 'Masjid' },
    jalan: { p: [58, 5, 128], t: [92, 3, 114], label: 'Perempatan Merbabu' },
    atas: { p: [0, 270, 46], t: [0, 0, 6], label: 'Denah dari atas' },
  };
  function flyTo(key) {
    const pr = presets[key]; if (!pr) return;
    setMode('orbit');
    tween.fromP.copy(camera.position); tween.fromT.copy(orbit.target);
    tween.toP.set(...pr.p); tween.toT.set(...pr.t); tween.t = 0; tween.dur = key === 'atas' ? 2.8 : 2.2; tween.active = true;
  }

  // walk
  const walk = { yaw: Math.PI, pitch: 0, pos: new THREE.Vector3(0, 1.65, 112), keys: {}, vy: 0 };
  const keys = walk.keys;
  addEventListener('keydown', (e) => { keys[e.code] = true; if (e.code === 'KeyL') toggleLamps(); if (e.code === 'KeyE') interactCenter(); });
  addEventListener('keyup', (e) => { keys[e.code] = false; });
  let dragging = false, lx = 0, ly = 0, dragMoved = 0, downX = 0, downY = 0;
  renderer.domElement.addEventListener('pointerdown', (e) => { dragging = true; lx = downX = e.clientX; ly = downY = e.clientY; dragMoved = 0; renderer.domElement.setPointerCapture(e.pointerId); });
  addEventListener('pointerup', (e) => {
    dragging = false;
    if (e.target === renderer.domElement && Math.hypot(e.clientX - downX, e.clientY - downY) < 6) click(e.clientX, e.clientY);
  });
  addEventListener('pointermove', (e) => {
    if (dragging && mode === 'walk') { walk.yaw -= (e.clientX - lx) * 0.0032; walk.pitch = Math.max(-1.3, Math.min(1.3, walk.pitch - (e.clientY - ly) * 0.0032)); }
    lx = e.clientX; ly = e.clientY; hover(e.clientX, e.clientY);
  });
  const touchMove = { x: 0, z: 0 };
  document.querySelectorAll('[data-move]').forEach((b) => {
    const [dx, dz] = b.dataset.move.split(',').map(Number);
    b.addEventListener('pointerdown', (e) => { e.stopPropagation(); touchMove.x = dx; touchMove.z = dz; });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => b.addEventListener(ev, () => { touchMove.x = 0; touchMove.z = 0; }));
  });

  function collides(x, z, rad) {
    for (const c of colliders) if (c.h > 1.8 && x > c.x0 - rad && x < c.x1 + rad && z > c.z0 - rad && z < c.z1 + rad) return true;
    return false;
  }
  function updateWalk(dt) {
    const fwd = (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0) + touchMove.z;
    const str = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0) + touchMove.x;
    const sp = (keys.ShiftLeft ? 7 : 3.6) * dt;
    const sy = Math.sin(walk.yaw), cy = Math.cos(walk.yaw);
    const dx = (-sy * fwd + cy * str) * sp, dz = (-cy * fwd - sy * str) * sp;
    const nx = walk.pos.x + dx, nz = walk.pos.z + dz;
    if (!collides(nx, walk.pos.z, 0.45)) walk.pos.x = nx;
    if (!collides(walk.pos.x, nz, 0.45)) walk.pos.z = nz;
    const bob = (fwd || str) ? Math.sin(performance.now() * 0.009) * 0.035 : 0;
    camera.position.set(walk.pos.x, 1.65 + bob, walk.pos.z);
    camera.rotation.set(walk.pitch, walk.yaw, 0, 'YXZ');
  }

  // ---- drone FPV ----
  const droneCurves = buildDroneCurves();
  const drone = { u: 0, lap: 0, curve: droneCurves[0], smoothLook: new THREE.Vector3(), roll: 0, prevYaw: 0, bat: 100, speed: 0, lastPos: new THREE.Vector3() };
  function buildDroneCurves() {
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    const run = [V(0, 11, 138), V(0, 6, 112), V(0, 3.8, 90), V(0, 3.3, 74), V(0, 3.1, 66), V(0, 3.0, 60), V(0, 3.1, 54), V(0, 3.4, 44), V(2.8, 3.6, 30), V(2.8, 3.8, 15), V(0, 3.2, 6), V(0, 3.0, 0), V(0, 3.0, -8), V(0, 3.0, -18), V(0, 3.2, -30), V(0, 3.6, -42), V(0, 5.5, -52)];
    const west = [V(-14, 12, -66), V(-46, 18, -70), V(-90, 17, -62), V(-104, 12, -30), V(-104, 11, 20), V(-98, 10, 70), V(-70, 10, 112), V(-34, 9, 126), V(-10, 10, 134)];
    const east = [V(22, 16, -70), V(64, 24, -84), V(104, 20, -44), V(112, 16, 12), V(110, 14, 66), V(84, 11, 108), V(58, 9, 126), V(24, 10, 136), V(8, 11, 139)];
    const mk = (a) => new THREE.CatmullRomCurve3([...run, ...a], true, 'centripetal');
    return [mk(west), mk(east)];
  }
  const noise = (t, s) => Math.sin(t * 2.1 * s) * 0.5 + Math.sin(t * 3.7 * s + 1.3) * 0.3 + Math.sin(t * 6.3 * s + 2.2) * 0.2;
  function updateDrone(dt, t) {
    const c = drone.curve; const len = c.getLength();
    const p = c.getPointAt(drone.u);
    const inRun = Math.abs(p.x) < 7 && p.z > -50 && p.z < 78 && p.y < 7;
    const spd = inRun ? 10 : 26; drone.speed += (spd - drone.speed) * Math.min(1, dt * 1.5);
    const prevU = drone.u; drone.u += (drone.speed * dt) / len;
    if (drone.u >= 1) { drone.u -= 1; drone.lap++; drone.curve = droneCurves[drone.lap % 2]; }
    const look = drone.curve.getPointAt((drone.u + 14 / len) % 1);
    const pos = drone.curve.getPointAt(drone.u);
    pos.x += noise(t, 1) * 0.12; pos.y += noise(t + 9, 1.3) * 0.12;
    camera.position.copy(pos);
    drone.smoothLook.lerp(look, Math.min(1, dt * 5.5));
    camera.up.set(0, 1, 0); camera.lookAt(drone.smoothLook);
    // bank into turns + FPV tilt-up
    const yaw = Math.atan2(look.x - pos.x, look.z - pos.z); let dy = yaw - drone.prevYaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); drone.prevYaw = yaw;
    drone.roll += ((-dy / Math.max(dt, 0.001)) * 0.22 - drone.roll) * Math.min(1, dt * 3.0);
    drone.roll = Math.max(-0.7, Math.min(0.7, drone.roll));
    camera.rotateZ(drone.roll + noise(t, 2.5) * 0.01); camera.rotateX(0.14);
    camera.fov += ((inRun ? 88 : 98) - camera.fov) * Math.min(1, dt * 2); camera.updateProjectionMatrix();
    drone.bat = Math.max(8, drone.bat - dt * 0.05);
    osd.alt.textContent = pos.y.toFixed(0) + ' m'; osd.spd.textContent = (drone.speed * 3.6).toFixed(0) + ' km/j'; osd.bat.textContent = drone.bat.toFixed(0) + '%';
    osd.lap.textContent = drone.lap % 2 === 0 ? 'ORBIT BARAT' : 'ORBIT TIMUR'; osd.run.style.opacity = inRun ? 1 : 0;
  }
  const osd = { alt: $('#osd-alt'), spd: $('#osd-spd'), bat: $('#osd-bat'), lap: $('#osd-lap'), run: $('#osd-run') };

  function setMode(m) {
    if (m === mode) return; const prev = mode; mode = m;
    orbit.enabled = m === 'orbit';
    document.body.dataset.mode = m;
    if (m === 'walk') { if (prev === 'orbit') { walk.pos.set(Math.max(-40, Math.min(40, camera.position.x)), 1.65, Math.min(125, camera.position.z)); if (collides(walk.pos.x, walk.pos.z, 0.5) || camera.position.y > 30) walk.pos.set(0, 1.65, 112); } walk.yaw = Math.PI; walk.pitch = 0; camera.fov = 68; camera.updateProjectionMatrix(); }
    if (m === 'drone') { camera.fov = 98; camera.updateProjectionMatrix(); drone.smoothLook.copy(drone.curve.getPointAt(0.02)); grade.uniforms.uFish.value = 0.55; }
    else grade.uniforms.uFish.value = 0;
    if (m === 'orbit') {
      camera.fov = 48; camera.updateProjectionMatrix(); camera.up.set(0, 1, 0); camera.rotation.z = 0;
      const d = new THREE.Vector3(); camera.getWorldDirection(d); orbit.target.copy(camera.position).addScaledVector(d, 30); orbit.target.y = Math.max(1, orbit.target.y);
    }
    modeListeners.forEach((f) => f(m));
  }

  // ---- interaction ----
  const ray = new THREE.Raycaster(); ray.far = 260; const ndc = new THREE.Vector2();
  function pick(x, y) {
    ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1); ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects(interactive, true);
    for (const h of hits) { let o = h.object; while (o && !o.userData.act) o = o.parent; if (o) return { root: o, dist: h.distance }; }
    return null;
  }
  function activate(root) {
    const a = root.userData.act;
    if (a.type === 'switch') { const on = toggleLamps(); toast(on ? 'Lampu dinyalakan' : 'Lampu dimatikan'); return; }
    toggleLeaf(root);
    const open = root.userData.target === 1;
    toast(`${open ? 'Membuka' : 'Menutup'} ${a.label}`);
  }
  function click(x, y) { if (mode === 'drone') return; const h = pick(x, y); if (h) activate(h.root); }
  function interactCenter() { const h = pick(innerWidth / 2, innerHeight / 2); if (h && h.dist < 8) activate(h.root); }
  const tip = $('#tip'); let lastHover = 0;
  function hover(x, y) {
    const now = performance.now(); if (now - lastHover < 60 || mode === 'drone') return; lastHover = now;
    const h = pick(x, y);
    renderer.domElement.style.cursor = h ? 'pointer' : (mode === 'walk' ? 'grab' : 'default');
    if (h) { const a = h.root.userData.act; tip.textContent = a.type === 'switch' ? 'Klik untuk saklar lampu' : `Klik: ${h.root.userData.target ? 'tutup' : 'buka'} ${a.label}`; tip.style.opacity = 1; tip.style.transform = `translate(${x + 16}px, ${y + 14}px)`; } else tip.style.opacity = 0;
  }
  let toastTimer; function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 1800); }
  function toggleLamps() { const on = lighting.toggleLamps(); syncLampUI(); return on; }
  function syncLampUI() { const b = $('#btn-lamp'); if (b) { b.classList.toggle('on', lighting.lampsOn); b.querySelector('span').textContent = lighting.lampsOn ? 'Lampu: Nyala' : 'Lampu: Mati'; } $('#btn-auto')?.classList.toggle('on', lighting.manual === null); }
  lighting.onChange = syncLampUI;

  // ---- UI wiring ----
  const timeEl = $('#time'), timeLabel = $('#time-label'), playBtn = $('#btn-play');
  let playing = false;
  const fmt = (h) => { const hh = Math.floor(h), mm = Math.floor((h - hh) * 60); return `${String(hh).padStart(2, '0')}.${String(mm).padStart(2, '0')}`; };
  const setTime = (h) => { lighting.update(((h % 24) + 24) % 24); timeEl.value = lighting.hour; timeLabel.textContent = fmt(lighting.hour) + (lighting.nightness > 0.5 ? ' · malam' : lighting.hour < 8 || lighting.hour > 16 ? ' · senja' : ' · siang'); syncLampUI(); };
  timeEl.addEventListener('input', () => setTime(parseFloat(timeEl.value)));
  playBtn.addEventListener('click', () => { playing = !playing; playBtn.classList.toggle('on', playing); });
  document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  document.querySelectorAll('[data-fly]').forEach((b) => b.addEventListener('click', () => flyTo(b.dataset.fly)));
  $('#btn-lamp').addEventListener('click', () => { const on = toggleLamps(); toast(on ? 'Lampu dinyalakan' : 'Lampu dimatikan'); });
  $('#btn-auto').addEventListener('click', () => { lighting.autoLamps(); syncLampUI(); toast('Lampu otomatis: menyala saat malam'); });
  let doorsOpen = false, winOpen = false, gatesOpen = false;
  $('#btn-doors').addEventListener('click', (e) => { doorsOpen = !doorsOpen; setAllLeaves(['door'], doorsOpen); e.currentTarget.classList.toggle('on', doorsOpen); toast(doorsOpen ? 'Semua pintu dibuka' : 'Semua pintu ditutup'); });
  $('#btn-wins').addEventListener('click', (e) => { winOpen = !winOpen; setAllLeaves(['window'], winOpen); e.currentTarget.classList.toggle('on', winOpen); toast(winOpen ? 'Semua jendela dibuka' : 'Semua jendela ditutup'); });
  $('#btn-gates').addEventListener('click', (e) => { gatesOpen = !gatesOpen; setAllLeaves(['gate'], gatesOpen); e.currentTarget.classList.toggle('on', gatesOpen); toast(gatesOpen ? 'Semua gerbang dibuka' : 'Semua gerbang ditutup'); });
  $('#btn-cine').addEventListener('click', (e) => { const v = grade.uniforms.uBars.value ? 0 : 1; grade.uniforms.uBars.value = v; e.currentTarget.classList.toggle('on', !!v); });
  $('#btn-bloom').addEventListener('click', (e) => { bloom.enabled = !bloom.enabled; e.currentTarget.classList.toggle('on', bloom.enabled); });
  $('#btn-bloom').classList.add('on');
  $('#btn-shot').addEventListener('click', () => { composer.render(); const a = document.createElement('a'); a.download = 'smansa-klaten-3d.png'; a.href = renderer.domElement.toDataURL('image/png'); a.click(); });

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight); composer.setSize(innerWidth, innerHeight); grade.uniforms.uAspect.value = innerWidth / innerHeight;
  });

  // ---- main loop ----
  const clock = new THREE.Clock(); let acc = 0, frames = 0, fpsT = 0;
  const flagBase = world.flag.base, flagPos = world.flag.mesh.geometry.attributes.position;
  function animate() {
    const dt = Math.min(clock.getDelta(), 0.05), t = clock.elapsedTime; acc += dt;
    if (tween.active) {
      tween.t += dt / tween.dur; const k = Math.min(1, tween.t), e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      camera.position.lerpVectors(tween.fromP, tween.toP, e); orbit.target.lerpVectors(tween.fromT, tween.toT, e); if (k >= 1) tween.active = false;
    }
    if (mode === 'orbit') orbit.update(); else if (mode === 'walk') updateWalk(dt); else updateDrone(dt, t);
    if (playing) { setTime(lighting.hour + dt * 0.35); }
    updateLeaves(dt); world.traffic.update(dt); world.people.update(t, dt);
    for (let i = 0; i < flagPos.count; i++) { const x = flagBase[i * 3]; const w = Math.min(1, x / 4.2); flagPos.setZ(i, Math.sin(x * 1.7 - t * 4.2) * 0.32 * w + Math.sin(x * 3.1 - t * 6) * 0.07 * w); flagPos.setY(i, flagBase[i * 3 + 1] - Math.sin(x * 1.7 - t * 4.2) * 0.04 * w); }
    flagPos.needsUpdate = true; world.flag.mesh.geometry.computeVertexNormals();
    grade.uniforms.uTime.value = t; grade.uniforms.uNight.value = lighting.nightness;
    composer.render();
    frames++; fpsT += dt; if (fpsT > 1) { $('#fps').textContent = Math.round(frames / fpsT) + ' fps'; frames = 0; fpsT = 0; }
    requestAnimationFrame(animate);
  }
  // initial cinematic reveal
  camera.position.set(95, 34, 170); orbit.target.set(0, 5, 20);
  flyTo('gerbang'); setTime(16.4); syncLampUI();
  animate();
  onReady && onReady();
  return { setMode, flyTo, presets, setTime };
}
