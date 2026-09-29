/* Oficina 3D de Kairo (Three.js).
 *
 * Cada robot del lienzo es un muñeco 3D con su mesa y su ordenador. Cuando le
 * toca trabajar (su proyecto está trabajando de verdad, o Kairo lo está usando
 * en una ejecución) se levanta, va al tablón a por la tarea y se pone a trabajar
 * en la mesa del proyecto. Si no, teclea en su mesa y de vez en cuando va a por
 * un café, agua o se sienta en el sofá.
 */
import * as THREE from "/vendor/three.min.js";

const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);
const HEX = { azul: 0x5b8cf5, rosa: 0xf26b8a, morado: 0xa97cf2, verde: 0x58cc6c, turquesa: 0x22c1ad, naranja: 0xf6a33c, amarillo: 0xf7c12e };
const hashOf = (s) => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 1000003, 7);

// ------------------------------------------------------------------ distribución
const CORRIDOR_X = 2.6;
const DESK_COLS = [-10.5, -7.3, -4.1, -0.9];
const DESK_ROWS = [-2.2, 1.6, 5.4, 9.2];
const STATIONS = [[7.6, -2.6], [11.6, -2.6], [7.6, 3], [11.6, 3], [7.6, 8.6], [11.6, 8.6]];
const KAIRO_CORE = [10.4, -8.2];
const BOARD = { spot: [3.4, -9.3], lane: [3.4, -7.4] };
const BREAKS = [
  { id: "coffee", label: "☕ café", spot: [-11.2, -9.1], lane: [-11.2, -7.4], face: Math.PI, cup: 0x6b3d1f },
  { id: "coffee", label: "☕ café", spot: [-10.2, -9.1], lane: [-10.2, -7.4], face: Math.PI, cup: 0x6b3d1f },
  { id: "water", label: "💧 agua", spot: [-7.6, -9.2], lane: [-7.6, -7.4], face: Math.PI, cup: 0x9ad7ff },
  { id: "sofa", label: "🛋 descanso", spot: [-3.8, -9.3], lane: [-3.8, -7.4], face: 0, sit: 0.42 },
  { id: "sofa", label: "🛋 descanso", spot: [-2.6, -9.3], lane: [-2.6, -7.4], face: 0, sit: 0.42 },
];
const DOOR = [CORRIDOR_X, 12.4];

// ------------------------------------------------------------------ texturas
function canvasTex(w, h, draw) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
function floorTex() {
  const t = canvasTex(512, 512, (g, w, h) => {
    g.fillStyle = "#e9e4dc"; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
      g.fillStyle = (i + j) % 2 ? "#e4ded5" : "#ece8e1";
      g.fillRect(i * 64, j * 64, 64, 64);
      g.strokeStyle = "rgba(0,0,0,.05)"; g.strokeRect(i * 64 + .5, j * 64 + .5, 63, 63);
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(8, 6);
  return t;
}
function textTex(lines, { w = 512, h = 256, bg = "rgba(0,0,0,0)", color = "#fff", font = "bold 64px Space Grotesk, Inter, sans-serif", sub = null, accent = null } = {}) {
  return canvasTex(w, h, (g) => {
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    if (accent) { g.fillStyle = accent; g.fillRect(0, 0, w, 10); }
    g.fillStyle = color; g.textAlign = "center"; g.textBaseline = "middle";
    g.font = font;
    g.fillText(lines, w / 2, sub ? h * 0.42 : h / 2, w - 30);
    if (sub) { g.font = "600 34px Inter, sans-serif"; g.globalAlpha = .8; g.fillText(sub, w / 2, h * 0.72, w - 30); g.globalAlpha = 1; }
  });
}

// Pantalla animada compartida: líneas de código que se desplazan (monitores ocupados).
function codeScreen(accentCss) {
  const c = document.createElement("canvas");
  c.width = 256; c.height = 160;
  const g = c.getContext("2d");
  const lines = Array.from({ length: 40 }, () => ({ indent: Math.floor(rand(0, 4)), len: rand(0.2, 0.8), col: ["#7dd3fc", "#a78bfa", "#86efac", "#fda4af", "#fde68a"][Math.floor(rand(0, 5))] }));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  let off = 0;
  const draw = () => {
    g.fillStyle = "#0b1220"; g.fillRect(0, 0, 256, 160);
    g.fillStyle = accentCss; g.fillRect(0, 0, 256, 10);
    for (let i = 0; i < 14; i++) {
      const l = lines[(i + off) % lines.length];
      g.fillStyle = l.col; g.globalAlpha = .9;
      g.fillRect(12 + l.indent * 14, 18 + i * 10, 200 * l.len, 5);
    }
    g.globalAlpha = 1;
    tex.needsUpdate = true;
  };
  draw();
  return { tex, tick: () => { off = (off + 1) % lines.length; draw(); } };
}

// ------------------------------------------------------------------ muñeco 3D
/** Monigote robot: cuerpo en cápsula, cabeza con visor y ojos que brillan. Único por agente. */
function makeBot(agent) {
  const seed = hashOf(agent.id);
  const color = HEX[agent.color] || HEX.azul;
  const g = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color, roughness: .45, metalness: .15 });
  const shell = new THREE.MeshStandardMaterial({ color: 0xf4f6fa, roughness: .35, metalness: .1 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x0c1118, roughness: .3, metalness: .4 });
  const eyeCol = [0x38d6ff, 0x7cffb2, 0xffd166, 0xff7ab8, 0xb69cff][seed % 5];
  const eyes = new THREE.MeshStandardMaterial({ color: eyeCol, emissive: eyeCol, emissiveIntensity: 1.6 });

  const hips = new THREE.Group(); hips.position.y = 0.62; g.add(hips);
  // Torso
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.27, 0.36, 6, 14), body);
  torso.position.y = 0.36; torso.castShadow = true; hips.add(torso);
  const chest = new THREE.Mesh(new THREE.CircleGeometry(0.1, 20), eyes);
  chest.position.set(0, 0.42, 0.27); hips.add(chest);
  // Cabeza (tres formas)
  const head = new THREE.Group(); head.position.y = 1.02; hips.add(head);
  const hv = seed % 3;
  const skull = new THREE.Mesh(hv === 0 ? new THREE.SphereGeometry(0.27, 24, 18) : hv === 1 ? new THREE.BoxGeometry(0.52, 0.42, 0.46, 3, 3, 3) : new THREE.CapsuleGeometry(0.24, 0.12, 6, 16), shell);
  if (hv === 2) skull.rotation.z = Math.PI / 2;
  skull.castShadow = true; head.add(skull);
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.17, 0.08), dark);
  visor.position.set(0, 0.02, hv === 1 ? 0.22 : 0.22); head.add(visor);
  const eyeGeo = (seed >> 3) % 2 ? new THREE.SphereGeometry(0.035, 12, 10) : new THREE.BoxGeometry(0.08, 0.04, 0.02);
  const eL = new THREE.Mesh(eyeGeo, eyes), eR = new THREE.Mesh(eyeGeo, eyes);
  eL.position.set(-0.09, 0.02, 0.27); eR.position.set(0.09, 0.02, 0.27); head.add(eL, eR);
  // Antena u orejas
  const av = (seed >> 5) % 3;
  if (av === 0) {
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.18), dark); stick.position.y = 0.33; head.add(stick);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 10), eyes); ball.position.y = 0.44; head.add(ball);
  } else if (av === 1) {
    for (const s of [-1, 1]) { const ear = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.07, 16), body); ear.rotation.z = Math.PI / 2; ear.position.set(s * 0.29, 0, 0); head.add(ear); }
  } else {
    const fin = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.2, 4), body); fin.position.y = 0.33; head.add(fin);
  }
  // Brazos y piernas con pivote (para caminar / sentarse / teclear)
  const limb = (r, len, mat) => { const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 4, 10), mat); m.position.y = -len / 2 - r; m.castShadow = true; return m; };
  const armL = new THREE.Group(), armR = new THREE.Group();
  armL.position.set(-0.34, 0.58, 0); armR.position.set(0.34, 0.58, 0);
  armL.add(limb(0.065, 0.36, body)); armR.add(limb(0.065, 0.36, body));
  const handL = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 10), shell), handR = handL.clone();
  handL.position.y = -0.5; handR.position.y = -0.5; armL.add(handL); armR.add(handR);
  hips.add(armL, armR);
  const legL = new THREE.Group(), legR = new THREE.Group();
  legL.position.set(-0.13, 0.02, 0); legR.position.set(0.13, 0.02, 0);
  legL.add(limb(0.08, 0.38, dark)); legR.add(limb(0.08, 0.38, dark));
  hips.add(legL, legR);
  // Objetos en la mano: taza y tarjeta de tarea
  const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.05, 0.12, 14), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: .3 }));
  cup.position.set(0, -0.58, 0.06); cup.visible = false; armR.add(cup);
  const card = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.18), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff3b0, emissiveIntensity: .9, side: THREE.DoubleSide }));
  card.position.set(0, -0.6, 0.12); card.visible = false; armR.add(card);
  // Aro de estado a los pies
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.5, 40), new THREE.MeshBasicMaterial({ color: eyeCol, transparent: true, opacity: 0, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.02; g.add(ring);

  // Zona de toque invisible y generosa (dedo en iPad/móvil).
  const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 2, 10), new THREE.MeshBasicMaterial({ visible: false }));
  hit.position.y = 1; g.add(hit);
  g.userData = { parts: { hips, head, armL, armR, legL, legR, cup, card, ring, eyes, torso, skull } };
  g.traverse((o) => { if (o.isMesh) o.userData.botId = agent.id; });
  return g;
}

// ------------------------------------------------------------------ mobiliario
function office(scene, accent) {
  const M = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: .7, metalness: .05, ...o });
  const box = (w, h, d, mat, x, y, z, parent = scene, cast = true) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z); m.castShadow = cast; m.receiveShadow = true; parent.add(m); return m;
  };
  const cyl = (rt, rb, h, mat, x, y, z, parent = scene, seg = 20) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
    m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m;
  };
  const wood = M(0xc8a27a), white = M(0xf7f7f5), grey = M(0x9aa3ad), black = M(0x1b1f26, { roughness: .4, metalness: .3 });
  const glass = new THREE.MeshStandardMaterial({ color: 0xbfe6ff, transparent: true, opacity: .45, roughness: .05, metalness: .1 });
  const green = M(0x3f9b58), pot = M(0xe9e1d3);

  // Suelo, alfombras y paredes
  const floor = new THREE.Mesh(new THREE.BoxGeometry(31, 0.3, 25), new THREE.MeshStandardMaterial({ map: floorTex(), roughness: .85 }));
  floor.position.set(0, -0.15, 0.5); floor.receiveShadow = true; scene.add(floor);
  const rug = (w, d, color, x, z) => { const r = new THREE.Mesh(new THREE.BoxGeometry(w, 0.02, d), M(color, { roughness: 1 })); r.position.set(x, 0.01, z); r.receiveShadow = true; scene.add(r); };
  rug(6.2, 3.2, 0x4b6a88, -3.2, -8.8); rug(8.5, 13.5, 0xd8d2c8, 9.6, 3); rug(4, 2, 0x2f3b4a, CORRIDOR_X, 11.6);
  const wallMat = M(0xf1efe9, { roughness: .9 });
  box(31, 3.4, 0.3, wallMat, 0, 1.7, -11.75, scene, false);
  box(0.3, 3.4, 25, wallMat, -15.35, 1.7, 0.5, scene, false);
  box(31, 0.2, 0.35, M(0xd9d4ca), 0, 0.1, -11.55);
  // Ventanas con cielo
  const sky = new THREE.MeshStandardMaterial({ color: 0xbfe3ff, emissive: 0x9fd4ff, emissiveIntensity: .55 });
  for (const x of [-1, 6, 13]) { box(4.2, 1.8, 0.05, sky, x, 1.9, -11.58, scene, false); box(0.08, 1.8, 0.08, white, x, 1.9, -11.55, scene, false); }
  for (const z of [3, 8]) { box(0.05, 1.8, 3.6, sky, -15.18, 1.9, z, scene, false); }
  // Letrero de neón KAIRO
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 1.1), new THREE.MeshBasicMaterial({ map: textTex("KAIRO · AI OFFICE", { w: 1024, h: 240, color: "#ffffff", font: "700 120px Space Grotesk, Inter, sans-serif" }), transparent: true }));
  sign.position.set(-7.2, 2.55, -11.58); scene.add(sign);
  const signGlow = new THREE.PointLight(accent, 6, 7); signGlow.position.set(-7.2, 2.5, -10.6); scene.add(signGlow);
  // Reloj de pared (hora real)
  const clock = new THREE.Group(); clock.position.set(-2.4, 2.4, -11.55); scene.add(clock);
  const face = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.06, 32), white); face.rotation.x = Math.PI / 2; clock.add(face);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.46, 0.04, 8, 32), black); clock.add(rim);
  const hand = (len, w) => { const p = new THREE.Group(); const m = new THREE.Mesh(new THREE.BoxGeometry(w, len, 0.02), black); m.position.y = len / 2; p.add(m); p.position.z = 0.05; clock.add(p); return p; };
  const hH = hand(0.24, 0.05), hM = hand(0.36, 0.035);

  // Zona de descanso: cafetera, fuente de agua, nevera, sofá, plantas
  box(4.2, 0.95, 0.8, white, -10.6, 0.475, -10.95);
  box(4.2, 0.06, 0.86, M(0x2e3440, { roughness: .3 }), -10.6, 0.98, -10.95);
  const machine = box(0.7, 0.8, 0.55, black, -11.2, 1.41, -11);
  box(0.5, 0.25, 0.05, M(0xb8c0cc, { metalness: .8, roughness: .2 }), -11.2, 1.45, -10.7);
  const led = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), new THREE.MeshStandardMaterial({ color: 0xff3b3b, emissive: 0xff3b3b, emissiveIntensity: 2 })); led.position.set(-10.95, 1.7, -10.72); scene.add(led);
  box(0.7, 0.8, 0.55, black, -10.2, 1.41, -11);
  for (let i = 0; i < 4; i++) cyl(0.06, 0.05, 0.12, white, -9.4 + i * 0.16, 1.07, -10.8);
  const cooler = new THREE.Group(); cooler.position.set(-7.6, 0, -10.9); scene.add(cooler);
  box(0.55, 1.05, 0.55, white, 0, 0.525, 0, cooler);
  cyl(0.24, 0.24, 0.6, new THREE.MeshStandardMaterial({ color: 0x7cc6ff, transparent: true, opacity: .6, roughness: .05 }), 0, 1.35, 0, cooler);
  box(0.12, 0.08, 0.06, M(0x3b82f6), 0, 0.8, 0.3, cooler);
  box(0.9, 1.9, 0.75, M(0xdfe3e8, { metalness: .3, roughness: .3 }), -13.6, 0.95, -10.95);
  box(0.05, 0.5, 0.05, grey, -13.25, 1.3, -10.55);
  // Sofá y mesita
  const sofa = new THREE.MeshStandardMaterial({ color: 0x33475b, roughness: .95 });
  box(3.4, 0.45, 1, sofa, -3.2, 0.225, -10.9); box(3.4, 0.7, 0.25, sofa, -3.2, 0.7, -11.3); box(0.25, 0.6, 1, sofa, -4.95, 0.45, -10.9); box(0.25, 0.6, 1, sofa, -1.45, 0.45, -10.9);
  box(1.4, 0.35, 0.7, wood, -3.2, 0.2, -9.6);
  cyl(0.07, 0.06, 0.12, white, -3.5, 0.44, -9.6);
  const plant = (x, z, s = 1) => { cyl(0.28 * s, 0.22 * s, 0.5 * s, pot, x, 0.25 * s, z); const l = new THREE.Mesh(new THREE.IcosahedronGeometry(0.55 * s, 1), green); l.position.set(x, 0.9 * s, z); l.castShadow = true; scene.add(l); const l2 = l.clone(); l2.scale.setScalar(.7); l2.position.y += 0.5 * s; scene.add(l2); };
  plant(-14.5, -10.8, 1.2); plant(-5.6, -10.9); plant(-0.3, -10.9, .9); plant(14.2, -10.8, 1.2); plant(-14.4, 10.8, 1.1); plant(5.2, 11.2, .9);
  // Estantería y pizarra
  box(0.45, 2.2, 2.6, wood, -14.9, 1.1, 5.2);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 7; j++) box(0.3, 0.38, 0.14, M([0xef4444, 0x3b82f6, 0x10b981, 0xf59e0b, 0x8b5cf6][(i + j) % 5]), -14.8, 0.35 + i * 0.52, 4.1 + j * 0.34);
  box(0.05, 1.4, 2.6, white, -15.15, 1.8, -1.5, scene, false);
  // Tablón de tareas (kanban) en la pared del fondo
  box(3.6, 1.8, 0.08, M(0xfdfcf8), BOARD.spot[0], 1.75, -11.52);
  const noteCols = [0xfde68a, 0xa7f3d0, 0xfbcfe8, 0xbfdbfe];
  const notes = [];
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) {
    const n = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.34), M(noteCols[(c + r) % 4], { roughness: 1 }));
    n.position.set(BOARD.spot[0] - 1.1 + c * 1.1, 2.25 - r * 0.45, -11.46); scene.add(n); notes.push(n);
  }
  const boardTitle = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.35), new THREE.MeshBasicMaterial({ map: textTex("TAREAS", { w: 512, h: 90, color: "#0f172a", font: "700 60px Space Grotesk, Inter, sans-serif" }), transparent: true }));
  boardTitle.position.set(BOARD.spot[0], 2.82, -11.45); scene.add(boardTitle);
  // Impresora
  box(0.8, 0.8, 0.6, white, 6.2, 0.4, -11); box(0.6, 0.12, 0.4, grey, 6.2, 0.86, -11);
  // Lámparas de pie
  for (const [x, z] of [[-13.8, 1], [14.3, 11]]) { cyl(0.03, 0.03, 2, black, x, 1, z); const s = cyl(0.25, 0.35, 0.35, M(0xfff6e0, { emissive: 0xffe2a8, emissiveIntensity: .6 }), x, 2.1, z); s.castShadow = false; }

  return {
    tick(now) {
      const d = new Date();
      hM.rotation.z = -((d.getMinutes() + d.getSeconds() / 60) / 60) * TAU;
      hH.rotation.z = -(((d.getHours() % 12) + d.getMinutes() / 60) / 12) * TAU;
      led.material.emissiveIntensity = 1.2 + Math.sin(now * 3) * .8;
      notes.forEach((n, i) => { n.rotation.z = Math.sin(now * 0.6 + i) * 0.02; });
    },
    machine, box, cyl, M, wood, white, black, glass,
  };
}

/** Mesa con ordenador y silla para un robot. */
function makeDesk(scene, kit, x, z, screenMat, idleMat) {
  const { box, cyl, wood, black } = kit;
  const g = new THREE.Group(); g.position.set(x, 0, z); scene.add(g);
  box(2, 0.06, 0.95, wood, 0, 0.76, 0, g);
  for (const [dx, dz] of [[-0.92, -0.4], [0.92, -0.4], [-0.92, 0.4], [0.92, 0.4]]) box(0.06, 0.74, 0.06, black, dx, 0.37, dz, g);
  box(0.12, 0.3, 0.12, black, 0, 0.94, -0.25, g);
  const monitor = box(1.05, 0.62, 0.06, black, 0, 1.38, -0.28, g);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.97, 0.54), idleMat);
  screen.position.set(0, 1.38, -0.245); g.add(screen);
  box(0.6, 0.03, 0.2, kit.M(0xe5e7eb), 0, 0.8, 0.12, g);
  box(0.12, 0.03, 0.18, kit.M(0xe5e7eb), 0.48, 0.8, 0.14, g);
  const mug = cyl(0.06, 0.05, 0.12, kit.M([0xef4444, 0x3b82f6, 0x10b981, 0xf59e0b][Math.floor(Math.abs(x * 7 + z) % 4)]), -0.7, 0.85, 0.05, g);
  mug.castShadow = false;
  // Silla
  const chair = new THREE.Group(); chair.position.set(0, 0, 0.75); g.add(chair);
  const seatMat = kit.M(0x2f3b4a, { roughness: .9 });
  box(0.55, 0.08, 0.5, seatMat, 0, 0.47, 0, chair); box(0.55, 0.6, 0.08, seatMat, 0, 0.82, 0.27, chair);
  cyl(0.03, 0.03, 0.42, black, 0, 0.23, 0, chair);
  cyl(0.28, 0.28, 0.04, black, 0, 0.03, 0, chair, 5);
  return { g, screen, screenMat, idleMat, monitor, seat: [x, z + 0.75], lane: [x, z + 1.75], chair };
}

/** Mesa de proyecto con pantalla holográfica. */
function makeStation(scene, kit, x, z, project, live) {
  const g = new THREE.Group(); g.position.set(x, 0, z); scene.add(g);
  const color = HEX[project.color] || HEX.azul;
  kit.cyl(1.05, 1.05, 0.08, kit.M(0xf3f4f6, { roughness: .4 }), 0, 0.78, 0, g, 40);
  kit.cyl(0.12, 0.3, 0.76, kit.black, 0, 0.38, 0, g);
  const holoMat = new THREE.MeshBasicMaterial({ map: textTex(project.name.length > 16 ? project.name.slice(0, 15) + "…" : project.name, { w: 640, h: 300, bg: "rgba(10,18,32,.82)", color: "#ffffff", font: "700 74px Space Grotesk, Inter, sans-serif", sub: project.sub || "proyecto", accent: "#" + color.toString(16).padStart(6, "0") }), transparent: true, opacity: .95, side: THREE.DoubleSide });
  const holo = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 0.9), holoMat);
  holo.position.set(0, 1.85, 0); holo.rotation.y = Math.PI / 4; g.add(holo);
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.2, 0.9, 16, 1, true), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .35, side: THREE.DoubleSide }));
  beam.position.y = 1.28; g.add(beam);
  const ring = new THREE.Mesh(new THREE.RingGeometry(1.35, 1.5, 48), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: live ? .8 : .18, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03; g.add(ring);
  const light = new THREE.PointLight(color, live ? 5 : 0, 5); light.position.y = 1.8; g.add(light);
  const spots = [0, 1, 2, 3].map((i) => { const a = Math.PI / 4 + Math.PI + (i - 1.5) * 0.75; return [x + Math.cos(a) * 1.55, z + Math.sin(a) * 1.55]; });
  g.traverse((o) => { if (o.isMesh) o.userData.stationId = project.id; });
  return { g, holo, ring, light, spots, lane: [x - 2.1, z], color, live };
}

// ------------------------------------------------------------------ rutas
function route(from, to) {
  const pts = [];
  const push = (p) => { const last = pts[pts.length - 1]; if (!last || Math.hypot(last[0] - p[0], last[1] - p[1]) > 0.05) pts.push(p); };
  if (from.lane) push(from.lane);
  const za = (from.lane || from.spot)[1], zb = (to.lane || to.spot)[1];
  push([CORRIDOR_X, za]); push([CORRIDOR_X, zb]);
  if (to.lane) push(to.lane);
  push(to.spot);
  return pts;
}

// ------------------------------------------------------------------ montaje
export function mountOffice(container, api) {
  const css = getComputedStyle(document.documentElement);
  const accentCss = css.getPropertyValue("--th-primary").trim() || "#34f5a4";
  const accent = new THREE.Color(accentCss);
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  container.append(renderer.domElement);
  const overlay = document.createElement("div");
  overlay.className = "of-overlay";
  container.append(overlay);

  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 200);
  const view = { target: new THREE.Vector3(0, 0, 0.5), zoom: 1.35, angle: Math.PI / 4 };
  const placeCam = () => {
    const w = container.clientWidth || 800, h = container.clientHeight || 600;
    const size = 17 / view.zoom;
    const aspect = w / h;
    cam.left = -size * aspect; cam.right = size * aspect; cam.top = size; cam.bottom = -size;
    cam.position.set(view.target.x + Math.cos(view.angle) * 40, 32, view.target.z + Math.sin(view.angle) * 40);
    cam.lookAt(view.target);
    cam.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  };

  scene.add(new THREE.HemisphereLight(0xffffff, 0xcfd6e0, 1.1));
  const sun = new THREE.DirectionalLight(0xfff4e5, 2.1);
  sun.position.set(14, 22, 10); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -22, right: 22, top: 22, bottom: -22, near: 1, far: 70 });
  sun.shadow.bias = -0.0004; sun.shadow.radius = 4;
  scene.add(sun);

  const kit = office(scene, accent);
  const code = codeScreen(accentCss);
  const busyScreen = new THREE.MeshBasicMaterial({ map: code.tex });
  const idleScreen = new THREE.MeshBasicMaterial({ map: textTex("K", { w: 256, h: 160, bg: "#0e1726", color: accentCss, font: "700 90px Space Grotesk, Inter, sans-serif" }) });

  const desks = new Map();     // agentId → desk
  const bots = new Map();      // agentId → actor
  const stations = new Map();  // projectId|"kairo" → station
  const clickables = [];
  const tags = new Map();

  // ---------------------------------------------------------- etiquetas HTML
  const tagFor = (key, cls) => {
    if (!tags.has(key)) { const el = document.createElement("div"); el.className = cls; overlay.append(el); tags.set(key, el); }
    return tags.get(key);
  };
  const v3 = new THREE.Vector3();
  const place = (el, x, y, z) => {
    v3.set(x, y, z).project(cam);
    const w = container.clientWidth, h = container.clientHeight;
    el.style.transform = `translate(-50%, -100%) translate(${((v3.x + 1) / 2) * w}px, ${((1 - v3.y) / 2) * h}px)`;
  };

  // ---------------------------------------------------------- construir la oficina
  function build(state) {
    // Mesas de proyecto (máx. 6) + núcleo de Kairo
    for (const [id, st] of stations) { scene.remove(st.g); }
    stations.clear();
    state.projects.slice(0, STATIONS.length).forEach((p, i) => stations.set(p.id, makeStation(scene, kit, STATIONS[i][0], STATIONS[i][1], p, p.live)));
    stations.set("kairo", makeStation(scene, kit, KAIRO_CORE[0], KAIRO_CORE[1], { id: "kairo", name: "Kairo Core", color: "morado", sub: "orquestador" }, false));
    for (const [id, st] of stations) st.g.userData.key = id;
    // Mesas y robots
    const wanted = new Set(state.agents.map((a) => a.id));
    for (const [id, d] of desks) if (!wanted.has(id)) { scene.remove(d.g); desks.delete(id); }
    for (const [id, b] of bots) if (!wanted.has(id) && !b.visitor) { scene.remove(b.g); bots.delete(id); tags.get("b" + id)?.remove(); tags.delete("b" + id); }
    state.agents.slice(0, DESK_COLS.length * DESK_ROWS.length).forEach((a, i) => {
      const x = DESK_COLS[i % DESK_COLS.length], z = DESK_ROWS[Math.floor(i / DESK_COLS.length)];
      let d = desks.get(a.id);
      if (!d || d.g.position.x !== x || d.g.position.z !== z) {
        if (d) scene.remove(d.g);
        d = makeDesk(scene, kit, x, z, busyScreen, idleScreen);
        desks.set(a.id, d);
      }
      let b = bots.get(a.id);
      if (!b) {
        const g = makeBot(a);
        scene.add(g);
        b = { id: a.id, agent: a, g, p: g.userData.parts, pos: [d.seat[0], d.seat[1]], lane: d.lane, face: Math.PI, state: "sit", path: [], speed: rand(1.7, 2.1), nextBreak: performance.now() / 1000 + rand(8, 40), phase: rand(0, TAU), work: null };
        g.position.set(d.seat[0], 0, d.seat[1]);
        bots.set(a.id, b);
      }
      b.visitor = false; b.agent = a; b.desk = d;
    });
    clickables.length = 0;
    scene.traverse((o) => { if (o.isMesh && (o.userData.botId || o.userData.stationId)) clickables.push(o); });
  }

  // ---------------------------------------------------------- comportamiento
  const goTo = (b, target, then) => {
    b.path = route({ spot: b.pos, lane: b.lane }, target);
    b.lane = target.lane; b.state = "walk"; b.then = then;
    b.p.cup.visible = false;
  };
  const deskTarget = (b) => (b.desk ? { spot: b.desk.seat, lane: b.desk.lane } : { spot: DOOR, lane: DOOR });
  const stationSpot = (b, key) => {
    const st = stations.get(key) || stations.get("kairo");
    if (!stations.has(key)) b.work = "kairo";
    const users = [...bots.values()].filter((x) => x.work === key && x !== b);
    const spot = st.spots[users.length % st.spots.length];
    return { spot, lane: st.lane, st };
  };
  const breakBusy = new Set();

  function think(b, now) {
    if (b.state === "walk") return;
    const want = b.wantWork; // id de proyecto, "kairo" o null
    if (want != null && b.work !== want && b.state !== "pickup") {
      // ¡A trabajar! Se levanta, va al tablón a por la tarea y luego a la mesa del proyecto.
      if (b.breakSpot) { breakBusy.delete(b.breakSpot); b.breakSpot = null; }
      b.work = want;
      b.label = "📋 cogiendo tarea";
      goTo(b, BOARD, () => {
        b.state = "pickup"; b.until = now + 1.6; b.face = Math.PI;
        b.onDone = () => {
          b.p.card.visible = true;
          const t = stationSpot(b, want);
          b.label = `⚡ ${t.st === stations.get("kairo") ? "Kairo" : api.projectName(want)}`;
          goTo(b, t, () => { b.state = "work"; b.face = Math.atan2(t.st.g.position.x - b.pos[0], t.st.g.position.z - b.pos[1]); b.p.card.visible = false; });
        };
      });
      return;
    }
    if (want == null && b.work != null) {
      b.work = null;
      if (b.visitor) { b.label = "👋 hasta luego"; goTo(b, { spot: DOOR, lane: [CORRIDOR_X, 10.6] }, () => { b.gone = true; }); return; }
      b.label = "↩ vuelve a su mesa";
      goTo(b, deskTarget(b), () => { b.state = "sit"; b.face = Math.PI; b.label = null; });
      return;
    }
    if (b.state === "pickup" && now > b.until) { b.state = "idle"; b.onDone?.(); return; }
    if (b.state === "break" && now > b.until) {
      breakBusy.delete(b.breakSpot); b.breakSpot = null; b.p.cup.visible = false;
      b.label = null;
      goTo(b, deskTarget(b), () => { b.state = "sit"; b.face = Math.PI; });
      b.nextBreak = now + rand(35, 90);
      return;
    }
    if (b.state === "sit" && !b.visitor && now > b.nextBreak && !reduce) {
      const free = BREAKS.filter((x) => !breakBusy.has(x));
      if (!free.length) { b.nextBreak = now + rand(10, 20); return; }
      const spot = free[Math.floor(Math.random() * free.length)];
      breakBusy.add(spot); b.breakSpot = spot;
      b.label = spot.label;
      goTo(b, spot, () => { b.state = "break"; b.until = now + rand(6, 11); b.face = spot.face; if (spot.cup) { b.p.cup.visible = true; b.p.cup.material.color.setHex(0xffffff); } });
    }
  }

  function animate(b, dt, now) {
    const { hips, armL, armR, legL, legR, head, ring, eyes, cup } = b.p;
    let moving = false;
    if (b.state === "walk" && b.path.length) {
      const [tx, tz] = b.path[0];
      const dx = tx - b.pos[0], dz = tz - b.pos[1];
      const dist = Math.hypot(dx, dz);
      const step = b.speed * dt;
      if (dist <= step) { b.pos = [tx, tz]; b.path.shift(); if (!b.path.length) { b.state = "idle"; const f = b.then; b.then = null; f?.(); } }
      else { b.pos = [b.pos[0] + (dx / dist) * step, b.pos[1] + (dz / dist) * step]; b.face = Math.atan2(dx, dz); moving = true; }
    }
    // Giro suave
    let da = b.face - b.g.rotation.y; da = Math.atan2(Math.sin(da), Math.cos(da));
    b.g.rotation.y += da * Math.min(1, dt * 10);
    b.g.position.set(b.pos[0], 0, b.pos[1]);
    const t = now * 1 + b.phase;
    const sitting = b.state === "sit" || (b.state === "break" && b.breakSpot?.sit);
    const lerp = (o, k, v) => { o.rotation[k] += (v - o.rotation[k]) * Math.min(1, dt * 12); };
    if (moving) {
      const s = Math.sin(t * 9);
      lerp(legL, "x", s * 0.7); lerp(legR, "x", -s * 0.7); lerp(armL, "x", -s * 0.6); lerp(armR, "x", b.p.card.visible ? -1.1 : s * 0.6);
      hips.position.y = 0.62 + Math.abs(Math.cos(t * 9)) * 0.05;
      head.rotation.y = 0;
    } else if (sitting) {
      hips.position.y += (0.18 + (b.breakSpot?.sit ? -0.02 : 0) - hips.position.y) * Math.min(1, dt * 8);
      lerp(legL, "x", -1.45); lerp(legR, "x", -1.45);
      const typing = b.state === "sit";
      lerp(armL, "x", typing ? -1.15 + Math.sin(t * 14) * 0.08 : -0.2); lerp(armR, "x", typing ? -1.15 + Math.cos(t * 13) * 0.08 : -0.2);
      head.rotation.x = typing ? 0.12 + Math.sin(t * 0.7) * 0.05 : -0.05;
      head.rotation.y = typing ? Math.sin(t * 0.4) * 0.15 : Math.sin(t * 0.5) * 0.4;
    } else {
      hips.position.y += (0.62 - hips.position.y) * Math.min(1, dt * 8);
      lerp(legL, "x", 0); lerp(legR, "x", 0);
      if (b.state === "work") {
        // Trabajando en la mesa del proyecto: teclea en el holograma y gesticula.
        lerp(armL, "x", -1.25 + Math.sin(t * 12) * 0.12); lerp(armR, "x", -1.25 + Math.cos(t * 11) * 0.12);
        head.rotation.x = -0.15 + Math.sin(t * 2) * 0.04; head.rotation.y = Math.sin(t * 0.8) * 0.2;
        hips.position.y = 0.62 + Math.sin(t * 5) * 0.012;
      } else if (b.state === "pickup") {
        lerp(armR, "x", -2.4 + Math.sin(t * 6) * 0.2); lerp(armL, "x", -0.3); head.rotation.x = -0.25;
      } else if (b.state === "break") {
        const sip = Math.max(0, Math.sin(t * 1.3));
        lerp(armR, "x", cup.visible ? -0.6 - sip * 1.4 : -0.1); lerp(armL, "x", -0.15);
        head.rotation.x = cup.visible ? -sip * 0.3 : 0; head.rotation.y = Math.sin(t * 0.6) * 0.5;
      } else { lerp(armL, "x", 0); lerp(armR, "x", 0); head.rotation.y = Math.sin(t * 0.5) * 0.3; }
    }
    // Aro y ojos según estado
    const active = b.work != null;
    ring.material.opacity += ((active ? 0.85 : 0) - ring.material.opacity) * Math.min(1, dt * 5);
    ring.scale.setScalar(1 + (active ? Math.sin(now * 5) * 0.06 : 0));
    eyes.emissiveIntensity = active ? 2.2 + Math.sin(now * 8) * 0.6 : 1.4;
    // Pantalla de su mesa: código si está sentado trabajando
    if (b.desk) b.desk.screen.material = b.state === "sit" ? busyScreen : idleScreen;
  }

  // ---------------------------------------------------------- partículas de vapor del café
  const steam = [];
  const steamMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: .5 });
  for (let i = 0; i < 10; i++) { const s = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), steamMat.clone()); s.userData.t = Math.random(); scene.add(s); steam.push(s); }

  // ---------------------------------------------------------- interacción: pan, zoom, clic
  const pointers = new Map();
  let drag = null, pinch = null;
  const el = renderer.domElement;
  el.style.touchAction = "none";
  el.addEventListener("pointerdown", (e) => {
    el.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.size === 1) drag = { x: e.clientX, y: e.clientY, moved: false, t: view.target.clone() };
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), z: view.zoom }; drag = null; }
  });
  el.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      view.zoom = Math.min(3, Math.max(0.5, pinch.z * Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch.d)); placeCam(); return;
    }
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.hypot(dx, dy) > 5) drag.moved = true;
    if (!drag.moved) return;
    const k = (cam.right - cam.left) / container.clientWidth;
    const right = new THREE.Vector3(-Math.sin(view.angle), 0, Math.cos(view.angle));
    const fwd = new THREE.Vector3(-Math.cos(view.angle), 0, -Math.sin(view.angle));
    view.target.copy(drag.t).addScaledVector(right, -dx * k).addScaledVector(fwd, dy * k * 1.6);
    placeCam();
  });
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  el.addEventListener("pointerup", (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (drag && !drag.moved) {
      const r = el.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, cam);
      const hit = ray.intersectObjects(clickables, false)[0];
      if (hit?.object.userData.botId) api.onBot(hit.object.userData.botId, e);
      else if (hit?.object.userData.stationId != null && hit.object.userData.stationId !== "kairo") api.onStation(hit.object.userData.stationId, e);
      else api.onEmpty?.();
    }
    drag = null;
  });
  el.addEventListener("wheel", (e) => { e.preventDefault(); view.zoom = Math.min(3, Math.max(0.5, view.zoom * (e.deltaY < 0 ? 1.1 : 0.9))); placeCam(); }, { passive: false });
  const ro = new ResizeObserver(() => placeCam());
  ro.observe(container);

  // ---------------------------------------------------------- bucle
  let alive = true, last = performance.now(), codeT = 0;
  const loop = (ms) => {
    if (!alive) return;
    if (!container.isConnected) { destroy(); return; }
    const now = ms / 1000, dt = Math.min(0.05, (ms - last) / 1000); last = ms;
    kit.tick(now);
    codeT += dt; if (codeT > 0.18) { codeT = 0; code.tick(); }
    for (const b of bots.values()) { think(b, now); animate(b, dt, now); }
    for (const [id, b] of bots) if (b.gone) { scene.remove(b.g); bots.delete(id); tags.get("b" + id)?.remove(); tags.delete("b" + id); }
    for (const st of stations.values()) {
      st.holo.position.y = 1.85 + Math.sin(now * 1.5 + st.g.position.x) * 0.05;
      const busy = [...bots.values()].some((b) => b.work === st.g.userData.key && b.state === "work");
      st.ring.material.opacity += (((st.live || busy) ? 0.75 + Math.sin(now * 4) * 0.2 : 0.16) - st.ring.material.opacity) * Math.min(1, dt * 4);
      st.light.intensity += (((st.live || busy) ? 5 : 0) - st.light.intensity) * Math.min(1, dt * 3);
    }
    const coffeeOn = [...breakBusy].some((x) => x.id === "coffee");
    steam.forEach((s, i) => {
      s.userData.t += dt * 0.4; if (s.userData.t > 1) s.userData.t = 0;
      const k = s.userData.t;
      s.position.set(-11.2 + Math.sin(k * 6 + i) * 0.08, 1.85 + k * 0.8, -10.75);
      s.material.opacity = coffeeOn ? (1 - k) * 0.5 : 0; s.scale.setScalar(0.6 + k);
    });
    // Etiquetas
    for (const b of bots.values()) {
      const tag = tagFor("b" + b.id, "of-tag");
      const status = b.label || (b.state === "sit" ? "⌨️" : "");
      const html = `<b style="--c:${"#" + (HEX[b.agent.color] || HEX.azul).toString(16).padStart(6, "0")}">${b.agent.name}</b>${status ? `<span>${status}</span>` : ""}`;
      if (tag.dataset.h !== html) { tag.innerHTML = ""; const n = document.createElement("b"); n.textContent = b.agent.name; n.style.setProperty("--c", "#" + (HEX[b.agent.color] || HEX.azul).toString(16).padStart(6, "0")); tag.append(n); if (status) { const s = document.createElement("span"); s.textContent = status; tag.append(s); } tag.dataset.h = html; }
      tag.classList.toggle("active", b.work != null);
      place(tag, b.pos[0], b.state === "sit" ? 1.9 : 2.45, b.pos[1]);
    }
    for (const [id, st] of stations) {
      const tag = tagFor("s" + id, "of-station");
      const n = [...bots.values()].filter((b) => b.work === id && b.state === "work").length;
      const txt = `${st.live || n ? "● LIVE · " : ""}${n ? `${n} trabajando` : ""}`;
      if (tag.textContent !== txt) tag.textContent = txt;
      tag.hidden = !txt;
      place(tag, st.g.position.x, 2.75, st.g.position.z);
    }
    renderer.render(scene, cam);
    requestAnimationFrame(loop);
  };

  function destroy() {
    alive = false; ro.disconnect();
    renderer.dispose();
    scene.traverse((o) => { o.geometry?.dispose?.(); if (o.material) [].concat(o.material).forEach((m) => { m.map?.dispose?.(); m.dispose?.(); }); });
  }

  // ---------------------------------------------------------- API pública
  return {
    build,
    /** Estado vivo: qué quiere hacer cada robot ahora mismo. */
    setWork(map, visitors = []) {
      for (const b of bots.values()) if (!b.visitor) b.wantWork = map.get(b.id) ?? null;
      // Agentes que Kairo está usando pero no están en la oficina: entran por la puerta.
      for (const v of visitors) {
        let b = bots.get(v.agent.id);
        if (!b) {
          const g = makeBot(v.agent); scene.add(g);
          b = { id: v.agent.id, agent: v.agent, g, p: g.userData.parts, pos: [...DOOR], lane: [CORRIDOR_X, 10.6], face: Math.PI, state: "idle", path: [], speed: 2, phase: rand(0, TAU), work: null, visitor: true, nextBreak: Infinity };
          g.position.set(DOOR[0], 0, DOOR[1]); bots.set(v.agent.id, b);
          scene.traverse((o) => { if (o.isMesh && o.userData.botId === v.agent.id) clickables.push(o); });
        }
        b.wantWork = v.work;
      }
      for (const b of bots.values()) if (b.visitor && !visitors.some((v) => v.agent.id === b.id)) b.wantWork = null;
    },
    setLive(ids) { for (const [id, st] of stations) st.live = ids.has(id); },
    zoom(k) { view.zoom = Math.min(3, Math.max(0.5, view.zoom * k)); placeCam(); },
    rotate() { view.angle += Math.PI / 2; placeCam(); },
    reset() { view.target.set(0, 0, 0.5); view.zoom = container.clientWidth < 700 ? 0.9 : 1.35; view.angle = Math.PI / 4; placeCam(); },
    destroy,
    start() { placeCam(); if (container.clientWidth < 700) { view.zoom = 0.9; placeCam(); } requestAnimationFrame(loop); },
  };
}
