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
// Solo para pruebas: ?officeSpeed=20 acelera el tiempo de la oficina.
const SPEED = Math.min(40, Math.max(1, Number(new URLSearchParams(location.search).get("officeSpeed")) || 1));
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
function marbleTex() {
  const t = canvasTex(1024, 1024, (g, w, h) => {
    g.fillStyle = "#e8e4de"; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 70; i++) {
      g.strokeStyle = `rgba(${150 + Math.random() * 40},${140 + Math.random() * 40},${130 + Math.random() * 30},${0.08 + Math.random() * 0.12})`;
      g.lineWidth = rand(0.6, 2.4);
      g.beginPath(); let x = rand(0, w), y = rand(0, h); g.moveTo(x, y);
      for (let k = 0; k < 8; k++) { x += rand(-120, 120); y += rand(-40, 140); g.lineTo(x, y); }
      g.stroke();
    }
    g.strokeStyle = "rgba(90,80,70,.18)"; g.lineWidth = 2;
    for (let i = 0; i <= 4; i++) { g.beginPath(); g.moveTo(i * 256, 0); g.lineTo(i * 256, h); g.stroke(); g.beginPath(); g.moveTo(0, i * 256); g.lineTo(w, i * 256); g.stroke(); }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(4, 3.2);
  return t;
}
/** Pantalla de tareas (kanban digital) con tarjetas que se mueven. */
function kanbanScreen(accentCss) {
  const c = document.createElement("canvas"); c.width = 768; c.height = 384;
  const g = c.getContext("2d");
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const cols = ["POR HACER", "EN CURSO", "HECHO"];
  const cards = Array.from({ length: 11 }, (_, i) => ({ col: i % 3, y: 0, hue: ["#fde68a", "#a7f3d0", "#fbcfe8", "#bfdbfe", "#ddd6fe"][i % 5], w: rand(.55, .9) }));
  const draw = () => {
    g.fillStyle = "#0a1020"; g.fillRect(0, 0, 768, 384);
    g.fillStyle = accentCss; g.fillRect(0, 0, 768, 8);
    g.font = "700 30px Inter, sans-serif"; g.fillStyle = "#fff"; g.fillText("KAIRO · TAREAS", 24, 52);
    cols.forEach((name, i) => {
      const x = 24 + i * 248;
      g.fillStyle = "rgba(255,255,255,.06)"; g.fillRect(x, 72, 228, 296);
      g.font = "700 18px Inter, sans-serif"; g.fillStyle = "rgba(255,255,255,.7)"; g.fillText(name, x + 12, 98);
      cards.filter((k) => k.col === i).forEach((k, j) => {
        g.fillStyle = k.hue; g.fillRect(x + 12, 112 + j * 62, 204, 50);
        g.fillStyle = "rgba(15,23,42,.55)"; g.fillRect(x + 22, 126 + j * 62, 180 * k.w, 7); g.fillRect(x + 22, 140 + j * 62, 120 * k.w, 7);
      });
    });
    tex.needsUpdate = true;
  };
  draw();
  return { tex, tick: () => { const k = cards[Math.floor(Math.random() * cards.length)]; k.col = (k.col + 1) % 3; draw(); } };
}

function office(scene, accent, accentCss, env) {
  const M = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: .5, metalness: .05, envMap: env, ...o });
  const box = (w, h, d, mat, x, y, z, parent = scene, cast = true) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z); m.castShadow = cast; m.receiveShadow = true; parent.add(m); return m;
  };
  const cyl = (rt, rb, h, mat, x, y, z, parent = scene, seg = 24) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
    m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m;
  };
  const gold = M(0xc9a45c, { metalness: 1, roughness: .28, envMapIntensity: 1.4 });
  const chrome = M(0xdfe5ec, { metalness: 1, roughness: .15 });
  const black = M(0x14171c, { roughness: .35, metalness: .4 });
  const white = M(0xf6f5f2, { roughness: .25 });
  const wood = M(0x6b4a33, { roughness: .45 }); // nogal oscuro
  const marble = new THREE.MeshStandardMaterial({ map: marbleTex(), roughness: .32, metalness: .08, envMap: env, envMapIntensity: .9 });
  const cream = M(0xe9dfcf, { roughness: .9 });
  const glass = new THREE.MeshStandardMaterial({ color: 0xa8c8e6, transparent: true, opacity: .16, roughness: .02, metalness: .9, envMap: env, envMapIntensity: 1.3, depthWrite: false });
  const leaf = M(0x2f6b3f, { roughness: .8 });

  // Suelo de mármol pulido con borde dorado
  const floor = new THREE.Mesh(new THREE.BoxGeometry(31, 0.35, 25), marble);
  floor.position.set(0, -0.175, 0.5); floor.receiveShadow = true; scene.add(floor);
  box(31.2, 0.08, 0.12, gold, 0, 0.02, 13.02, scene, false); box(0.12, 0.08, 25.2, gold, 15.52, 0.02, 0.5, scene, false);
  const rug = (w, d, color, x, z) => { const r = new THREE.Mesh(new THREE.BoxGeometry(w, 0.02, d), M(color, { roughness: 1, envMap: null })); r.position.set(x, 0.012, z); r.receiveShadow = true; scene.add(r); };
  rug(7, 3.6, 0x3a4150, -3.2, -9); rug(9, 14.5, 0x2c2f38, 9.6, 3.2); rug(3.6, 1.8, 0x1c1f26, CORRIDOR_X, 11.9);

  // Cristaleras de suelo a techo (fondo e izquierda) con perfilería negra
  const H = 3.8;
  box(31, H, 0.04, glass, 0, H / 2, -11.8, scene, false);
  box(0.04, H, 25, glass, -15.4, H / 2, 0.5, scene, false);
  for (let x = -15.4; x <= 15.5; x += 3.1) box(0.1, H, 0.12, black, x, H / 2, -11.8, scene, false);
  for (let z = -11.8; z <= 13; z += 3.1) box(0.12, H, 0.1, black, -15.4, H / 2, z, scene, false);
  box(31, 0.12, 0.16, black, 0, H, -11.8, scene, false); box(0.16, 0.12, 25, black, -15.4, H, 0.5, scene, false);
  // Barandilla de cristal baja en los lados abiertos (para ver dentro)
  box(31, 1.05, 0.04, glass, 0, 0.52, 13.05, scene, false); box(0.04, 1.05, 25, glass, 15.55, 0.52, 0.5, scene, false);
  box(31, 0.06, 0.1, gold, 0, 1.06, 13.05, scene, false); box(0.1, 0.06, 25, gold, 15.55, 1.06, 0.5, scene, false);

  // Muro de mármol retroiluminado con el logo KAIRO
  box(7, 3.2, 0.3, marble, -8.2, 1.6, -11.2, scene, true);
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 0.95), new THREE.MeshBasicMaterial({ map: textTex("KAIRO", { w: 1024, h: 220, color: "#ffffff", font: "300 150px Space Grotesk, Inter, sans-serif" }), transparent: true, toneMapped: false }));
  sign.position.set(-8.2, 2.3, -11.04); scene.add(sign);
  const signGlow = new THREE.PointLight(accent, 8, 8); signGlow.position.set(-8.2, 2.2, -10.2); scene.add(signGlow);
  box(6.6, 0.03, 0.03, M(0x000000, { emissive: accent, emissiveIntensity: 3 }), -8.2, 0.06, -11.04, scene, false);
  // Reloj minimalista en el muro
  const clock = new THREE.Group(); clock.position.set(-6.1, 1.25, -11.03); scene.add(clock);
  const face = new THREE.Mesh(new THREE.CircleGeometry(0.34, 40), black); clock.add(face);
  const hand = (len, w) => { const p = new THREE.Group(); const m = new THREE.Mesh(new THREE.BoxGeometry(w, len, 0.01), gold); m.position.y = len / 2; p.add(m); p.position.z = 0.01; clock.add(p); return p; };
  const hH = hand(0.18, 0.035), hM = hand(0.28, 0.025);

  // Barra de café de mármol con taburetes dorados, cafetera cromada y fuente de agua
  box(4.6, 1.02, 0.85, black, -11.3, 0.51, -10.7);
  box(4.8, 0.07, 0.95, marble, -11.3, 1.05, -10.7);
  const machine = box(0.62, 0.62, 0.5, chrome, -11.2, 1.4, -10.85);
  box(0.46, 0.2, 0.04, black, -11.2, 1.46, -10.59);
  const ledDot = new THREE.Mesh(new THREE.SphereGeometry(0.03, 10, 8), new THREE.MeshStandardMaterial({ color: 0x22ff99, emissive: 0x22ff99, emissiveIntensity: 2 })); ledDot.position.set(-10.98, 1.62, -10.59); scene.add(ledDot);
  box(0.62, 0.62, 0.5, chrome, -10.25, 1.4, -10.85);
  for (let i = 0; i < 5; i++) cyl(0.055, 0.045, 0.1, white, -9.6 + i * 0.15, 1.13, -10.55);
  for (const x of [-12.6, -11.6, -10.6]) { cyl(0.2, 0.2, 0.06, cream, x, 0.78, -9.8); cyl(0.025, 0.025, 0.75, gold, x, 0.38, -9.8); cyl(0.2, 0.22, 0.02, gold, x, 0.01, -9.8); }
  const cooler = new THREE.Group(); cooler.position.set(-7.6, 0, -10.95); scene.add(cooler);
  box(0.5, 1.1, 0.45, white, 0, 0.55, 0, cooler);
  cyl(0.2, 0.2, 0.55, new THREE.MeshStandardMaterial({ color: 0x7cc6ff, transparent: true, opacity: .55, roughness: .02, envMap: env }), 0, 1.38, 0, cooler);
  box(0.3, 0.05, 0.05, gold, 0, 0.82, 0.24, cooler);
  // Lounge: sofá curvo crema, butacas y mesa dorada
  const sofaG = new THREE.Group(); sofaG.position.set(-3.2, 0, -10.6); scene.add(sofaG);
  box(3.8, 0.42, 1.05, cream, 0, 0.21, 0, sofaG); box(3.8, 0.55, 0.28, cream, 0, 0.62, -0.42, sofaG);
  for (const s of [-1, 1]) { const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.8, 6, 12), cream); arm.rotation.x = Math.PI / 2; arm.position.set(s * 1.95, 0.52, 0); arm.castShadow = true; sofaG.add(arm); }
  cyl(0.65, 0.65, 0.05, marble, -3.2, 0.42, -8.7, scene, 40); cyl(0.05, 0.05, 0.4, gold, -3.2, 0.2, -8.7); cyl(0.4, 0.45, 0.02, gold, -3.2, 0.01, -8.7);
  cyl(0.07, 0.06, 0.11, white, -3.4, 0.5, -8.6);
  // Olivos en maceteros blancos
  const tree = (x, z, s = 1) => {
    cyl(0.42 * s, 0.34 * s, 0.7 * s, white, x, 0.35 * s, z, scene, 28);
    cyl(0.05 * s, 0.07 * s, 1.1 * s, wood, x, 1.1 * s, z, scene, 8);
    for (let i = 0; i < 4; i++) { const l = new THREE.Mesh(new THREE.IcosahedronGeometry(0.45 * s, 1), leaf); l.position.set(x + rand(-0.35, 0.35) * s, (1.7 + rand(0, 0.5)) * s, z + rand(-0.35, 0.35) * s); l.castShadow = true; scene.add(l); }
  };
  tree(-14.6, -10.9, 1.15); tree(-0.4, -11, .95); tree(14.6, -11, 1.2); tree(-14.6, 12.3, 1.1); tree(6, 12.3, .9); tree(14.6, 12.3, 1);
  // Estantería de nogal con objetos
  box(0.4, 2.4, 3.2, wood, -15, 1.2, 5.4);
  for (let i = 0; i < 4; i++) { box(0.42, 0.04, 3.2, gold, -14.98, 0.5 + i * 0.55, 5.4, scene, false); for (let j = 0; j < 4; j++) if ((i + j) % 2) box(0.22, 0.3, 0.3, [white, black, gold][(i + j) % 3], -14.95, 0.68 + i * 0.55, 4.2 + j * 0.8); }
  // Pantalla de tareas (kanban digital) exenta, junto al cristal
  const kb = kanbanScreen(accentCss);
  box(3.8, 2.05, 0.12, black, BOARD.spot[0], 1.75, -11.3);
  const kbScreen = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 1.8), new THREE.MeshBasicMaterial({ map: kb.tex, toneMapped: false }));
  kbScreen.position.set(BOARD.spot[0], 1.75, -11.23); scene.add(kbScreen);
  box(0.12, 0.7, 0.12, black, BOARD.spot[0] - 1.2, 0.35, -11.3); box(0.12, 0.7, 0.12, black, BOARD.spot[0] + 1.2, 0.35, -11.3);
  // Lámparas de pie tipo arco
  for (const [x, z] of [[-13.9, 0.8], [14.6, 9.5]]) {
    cyl(0.25, 0.28, 0.06, black, x, 0.03, z); cyl(0.02, 0.02, 2.3, gold, x, 1.15, z);
    const shade = cyl(0.32, 0.18, 0.3, M(0xfff6e0, { emissive: 0xffdca0, emissiveIntensity: 1.2 }), x, 2.35, z); shade.castShadow = false;
    const pl = new THREE.PointLight(0xffd6a0, 4, 6); pl.position.set(x, 2.2, z); scene.add(pl);
  }

  let kbT = 0;
  return {
    tick(now, dt = 0.016) {
      const d = new Date();
      hM.rotation.z = -((d.getMinutes() + d.getSeconds() / 60) / 60) * TAU;
      hH.rotation.z = -(((d.getHours() % 12) + d.getMinutes() / 60) / 12) * TAU;
      ledDot.material.emissiveIntensity = 1.2 + Math.sin(now * 3) * .8;
      kbT += dt; if (kbT > 2.2) { kbT = 0; kb.tick(); }
    },
    machine, box, cyl, M, wood, white, black, glass, gold, marble, cream, chrome,
  };
}

/** Mesa moderna (blanca, patas negras) con monitor fino y silla ergonómica. */
function makeDesk(scene, kit, x, z, screenMat, idleMat) {
  const { box, cyl, white, black, gold } = kit;
  const g = new THREE.Group(); g.position.set(x, 0, z); scene.add(g);
  box(2.1, 0.05, 0.95, white, 0, 0.76, 0, g);
  for (const s of [-1, 1]) { box(0.05, 0.74, 0.8, black, s * 0.98, 0.37, 0, g); box(0.05, 0.02, 0.8, gold, s * 0.98, 0.745, 0, g, false); }
  box(0.08, 0.32, 0.08, black, 0, 0.94, -0.25, g);
  const monitor = box(1.15, 0.64, 0.03, black, 0, 1.38, -0.28, g);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.6), idleMat);
  screen.position.set(0, 1.38, -0.262); g.add(screen);
  box(0.62, 0.02, 0.2, kit.M(0xd1d5db), 0, 0.795, 0.12, g);
  box(0.1, 0.02, 0.16, kit.M(0xd1d5db), 0.5, 0.795, 0.14, g);
  const lamp = cyl(0.015, 0.015, 0.45, gold, -0.85, 1, -0.3, g, 8); lamp.castShadow = false;
  box(0.3, 0.03, 0.06, kit.M(0xffffff, { emissive: 0xfff1d6, emissiveIntensity: 1.5 }), -0.72, 1.22, -0.25, g, false);
  const chair = new THREE.Group(); chair.position.set(0, 0, 0.75); g.add(chair);
  const seatMat = kit.M(0x1f2329, { roughness: .8 });
  box(0.56, 0.08, 0.52, seatMat, 0, 0.47, 0, chair); box(0.56, 0.68, 0.06, seatMat, 0, 0.86, 0.28, chair);
  cyl(0.025, 0.025, 0.42, kit.chrome, 0, 0.23, 0, chair, 8);
  cyl(0.3, 0.3, 0.03, kit.chrome, 0, 0.03, 0, chair, 5);
  return { g, screen, screenMat, idleMat, monitor, seat: [x, z + 0.75], lane: [x, z + 1.75], chair };
}

// ------------------------------------------------------------------ Nave industrial gigante
// La oficina de tu equipo es una entreplanta acristalada; abajo, la nave con todos los agentes.
const FLOOR_Y = -16;                       // suelo de la nave (la entreplanta está 16 m por encima)
const HALL = { x0: -310, x1: 140, z0: -250, z1: 105, h: 48 };

function hallBgTex() {
  return canvasTex(64, 512, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, "#0b0e13"); gr.addColorStop(0.5, "#161b22"); gr.addColorStop(1, "#0d1015");
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  });
}
/** Entorno para reflejos: interior oscuro con franjas de lucernario. */
function hallEnvTex() {
  return canvasTex(256, 128, (g, w, h) => {
    g.fillStyle = "#1a1f27"; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 12; i++) { g.fillStyle = "rgba(220,235,255,.85)"; g.fillRect(i * 22 + 4, 8, 10, 40); }
    g.fillStyle = "#2a2f38"; g.fillRect(0, h * 0.6, w, h * 0.4);
  });
}
function concreteTex() {
  const t = canvasTex(512, 512, (g, w, h) => {
    g.fillStyle = "#8b8f95"; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 2500; i++) { const c = 95 + Math.random() * 40; g.fillStyle = `rgba(${c},${c},${c + 4},.18)`; g.fillRect(Math.random() * w, Math.random() * h, 2 + Math.random() * 6, 2 + Math.random() * 6); }
    g.strokeStyle = "rgba(30,32,36,.35)"; g.lineWidth = 2;
    for (let i = 0; i <= 4; i++) { g.beginPath(); g.moveTo(i * 128, 0); g.lineTo(i * 128, h); g.stroke(); g.beginPath(); g.moveTo(0, i * 128); g.lineTo(w, i * 128); g.stroke(); }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(70, 45); t.anisotropy = 8;
  return t;
}
function corrugatedTex() {
  const t = canvasTex(256, 64, (g, w, h) => {
    for (let x = 0; x < w; x += 8) { const gr = g.createLinearGradient(x, 0, x + 8, 0); gr.addColorStop(0, "#39414b"); gr.addColorStop(.5, "#56606c"); gr.addColorStop(1, "#39414b"); g.fillStyle = gr; g.fillRect(x, 0, 8, h); }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(90, 6);
  return t;
}
function rackTex() {
  const t = canvasTex(64, 256, (g, w, h) => {
    g.fillStyle = "#0b0f14"; g.fillRect(0, 0, w, h);
    for (let y = 4; y < h; y += 8) { g.fillStyle = "#1a212b"; g.fillRect(4, y, w - 8, 6); for (let k = 0; k < 4; k++) { g.fillStyle = ["#22ff9a", "#38d6ff", "#ffb020", "#22ff9a"][(y + k) % 4]; if (Math.random() < .55) g.fillRect(8 + k * 12, y + 2, 3, 2); } }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Estructura de la nave: suelo, muros de chapa, pilares, cerchas, lucernarios, lámparas, puente grúa, racks... */
function industrialHall(scene, env, accentCss) {
  const g = new THREE.Group(); scene.add(g);
  const { x0, x1, z0, z1, h } = HALL;
  const W = x1 - x0, D = z1 - z0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const steel = new THREE.MeshStandardMaterial({ color: 0x2b3038, metalness: .8, roughness: .45, envMap: env });
  const colMat = new THREE.MeshStandardMaterial({ color: 0x5b6572, metalness: .6, roughness: .5, envMap: env });
  const yellow = new THREE.MeshStandardMaterial({ color: 0xf2b705, metalness: .5, roughness: .45, envMap: env });
  const geoBox = new THREE.BoxGeometry(1, 1, 1);
  const ceil = new THREE.Group(); g.add(ceil); // techo: se oculta al mirar desde arriba
  const inst = (geo, mat, list, cast = false, parent = g) => {
    const m = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach(([x, y, z, sx, sy, sz, ry = 0], i) => m.setMatrixAt(i, new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, 0)), new THREE.Vector3(sx, sy, sz))));
    m.castShadow = cast; m.receiveShadow = true; parent.add(m); return m;
  };
  // Suelo de hormigón pulido con pasillos pintados
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ map: concreteTex(), roughness: .55, metalness: .1, envMap: env, envMapIntensity: .5 }));
  floor.rotation.x = -Math.PI / 2; floor.position.set(cx, FLOOR_Y, cz); floor.receiveShadow = true; g.add(floor);
  const lineMat = new THREE.MeshBasicMaterial({ color: 0xf2c200 });
  const lines = [];
  for (const z of [-140, -96, -30, 26, 64]) lines.push([cx, FLOOR_Y + 0.03, z, W - 20, 0.02, 0.5]);
  for (const x of [-160, -26, 30, 100]) lines.push([x, FLOOR_Y + 0.03, cz, 0.5, 0.02, D - 20]);
  inst(geoBox, lineMat, lines);
  // Muros de chapa con franja de ventanas altas
  const wallMat = new THREE.MeshStandardMaterial({ map: corrugatedTex(), metalness: .6, roughness: .5, envMap: env });
  const wallH = h;
  const walls = [[cx, FLOOR_Y + wallH / 2, z0, W, wallH, 1], [cx, FLOOR_Y + wallH / 2, z1, W, wallH, 1], [x0, FLOOR_Y + wallH / 2, cz, 1, wallH, D], [x1, FLOOR_Y + wallH / 2, cz, 1, wallH, D]];
  walls.forEach(([x, y, z, sx, sy, sz]) => { const m = new THREE.Mesh(geoBox, wallMat); m.position.set(x, y, z); m.scale.set(sx, sy, sz); m.receiveShadow = true; g.add(m); });
  const winMat = new THREE.MeshBasicMaterial({ color: 0xbcd6f5 });
  inst(geoBox, winMat, [[cx, FLOOR_Y + wallH - 7, z0 + 0.8, W - 10, 5, 0.2], [x0 + 0.8, FLOOR_Y + wallH - 7, cz, 0.2, 5, D - 10], [cx, FLOOR_Y + wallH - 7, z1 - 0.8, W - 10, 5, 0.2], [x1 - 0.8, FLOOR_Y + wallH - 7, cz, 0.2, 5, D - 10]]);
  // Portones enrollables amarillos
  const doors = [];
  for (let x = x0 + 40; x < x1 - 30; x += 70) doors.push([x, FLOOR_Y + 9, z0 + 0.7, 22, 18, 0.4]);
  inst(geoBox, new THREE.MeshStandardMaterial({ color: 0xd9a400, roughness: .6, metalness: .4 }), doors);
  // Rótulo gigante en el muro del fondo
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(120, 16), new THREE.MeshBasicMaterial({ map: textTex("KAIRO INTELLIGENCE", { w: 2048, h: 272, color: "#ffffff", font: "700 200px Space Grotesk, Inter, sans-serif" }), transparent: true, toneMapped: false }));
  sign.position.set(-95, FLOOR_Y + 36, z0 + 1.2); g.add(sign);
  const bar = new THREE.Mesh(geoBox, new THREE.MeshBasicMaterial({ color: new THREE.Color(accentCss), toneMapped: false })); bar.scale.set(120, 0.6, 0.3); bar.position.set(-95, FLOOR_Y + 27, z0 + 1.2); g.add(bar);
  // Pilares (H) y cerchas de cubierta
  const cols = [], trusses = [], purlins = [];
  for (let x = x0 + 30; x < x1; x += 60) for (let z = z0 + 30; z < z1; z += 60) {
    if (x > -40 && x < 40 && z > -30 && z < 45) continue; // alrededor de la entreplanta, despejado
    cols.push([x, FLOOR_Y + h / 2, z, 0.8, h, 0.8]);
  }
  for (let x = x0 + 24; x < x1; x += 30) {
    trusses.push([x, FLOOR_Y + h - 1, cz, 0.9, 1.4, D]);        // cordón inferior
    trusses.push([x, FLOOR_Y + h + 3, cz, 0.7, 0.9, D]);        // cordón superior
    for (let z = z0 + 6; z < z1; z += 8) trusses.push([x, FLOOR_Y + h + 1, z, 0.3, 4, 0.3]); // montantes
  }
  for (let z = z0 + 12; z < z1; z += 18) purlins.push([cx, FLOOR_Y + h + 3.6, z, W, 0.5, 0.5]);
  inst(geoBox, colMat, cols); inst(geoBox, steel, trusses, false, ceil); inst(geoBox, steel, purlins, false, ceil);
  // Cubierta con lucernarios
  const roof = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ color: 0x1a1d22, roughness: .9, side: THREE.DoubleSide }));
  roof.rotation.x = Math.PI / 2; roof.position.set(cx, FLOOR_Y + h + 4.2, cz); ceil.add(roof);
  const sky = [];
  for (let x = x0 + 39; x < x1; x += 30) sky.push([x, FLOOR_Y + h + 4.0, cz, 9, 0.2, D - 30]);
  inst(geoBox, new THREE.MeshBasicMaterial({ color: 0xdfeaff }), sky, false, ceil);
  // Lámparas industriales colgantes (campanas con brillo)
  const lampPos = [];
  for (let x = x0 + 30; x < x1; x += 22) for (let z = z0 + 20; z < z1; z += 22) if (!(x > -24 && x < 24 && z > -20 && z < 22)) lampPos.push([x, FLOOR_Y + h - 6, z, 2.4, 1.4, 2.4]);
  inst(new THREE.ConeGeometry(0.6, 1, 16, 1, true), new THREE.MeshStandardMaterial({ color: 0x20252c, metalness: .7, roughness: .4, side: THREE.DoubleSide }), lampPos, false, ceil);
  inst(new THREE.CircleGeometry(0.55, 16).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xfff1d6, side: THREE.DoubleSide }), lampPos.map(([x, y, z]) => [x, y - 0.75, z, 2.4, 1, 2.4]), false, ceil);
  const cable = lampPos.map(([x, y, z]) => [x, y + 3.2, z, 0.06, 5, 0.06]);
  inst(geoBox, steel, cable, false, ceil);
  // Luz de las lámparas: halos en el suelo (baratos) y unas pocas luces reales
  const pool = new THREE.MeshBasicMaterial({ color: 0xffe2b0, transparent: true, opacity: .11, depthWrite: false });
  inst(new THREE.CircleGeometry(1, 24).rotateX(-Math.PI / 2), pool, lampPos.map(([x, , z]) => [x, FLOOR_Y + 0.05, z, 9, 1, 9]));
  // Racks de servidores con LEDs a lo largo del muro derecho y del fondo
  const racks = [];
  for (let z = z0 + 30; z < z1 - 20; z += 2.2) racks.push([x1 - 6, FLOOR_Y + 2.2, z, 1.6, 4.4, 1.9]);
  for (let x = 30; x < x1 - 10; x += 2.2) racks.push([x, FLOOR_Y + 2.2, z0 + 8, 1.9, 4.4, 1.6]);
  const rt = rackTex(); rt.repeat.set(1, 1);
  inst(geoBox, new THREE.MeshStandardMaterial({ color: 0x0f141b, emissive: 0xffffff, emissiveMap: rt, emissiveIntensity: 1.1, map: rt, roughness: .4, metalness: .6 }), racks);
  // Palés y cajas en la zona de carga (izquierda)
  const crates = [];
  for (let x = x0 + 12; x < x0 + 60; x += 3.2) for (let z = -40; z < 80; z += 3.2) if (Math.random() < .55) { const lv = 1 + Math.floor(Math.random() * 3); for (let k = 0; k < lv; k++) crates.push([x, FLOOR_Y + 0.6 + k * 1.2, z, 2.6, 1.1, 2.6, Math.random() * 0.1]); }
  inst(geoBox, new THREE.MeshStandardMaterial({ color: 0x9c7a52, roughness: .9 }), crates);
  // Puente grúa amarillo que recorre la nave
  const crane = new THREE.Group(); ceil.add(crane);
  const beam = new THREE.Mesh(geoBox, yellow); beam.scale.set(3, 2.4, D - 12); beam.position.set(0, FLOOR_Y + h - 4, cz); crane.add(beam);
  const trolley = new THREE.Mesh(geoBox, yellow); trolley.scale.set(4, 2, 5); trolley.position.set(0, FLOOR_Y + h - 6, cz); crane.add(trolley);
  const hook = new THREE.Mesh(geoBox, steel); hook.scale.set(0.3, 14, 0.3); hook.position.set(0, FLOOR_Y + h - 14, cz); crane.add(hook);
  const railMat = steel;
  for (const z of [z0 + 5, z1 - 5]) { const r = new THREE.Mesh(geoBox, railMat); r.scale.set(W, 1.2, 1.2); r.position.set(cx, FLOOR_Y + h - 3, z); ceil.add(r); }
  // Vehículos autónomos (AGV) con luz que recorren los pasillos
  const agvs = [];
  const agvMat = new THREE.MeshStandardMaterial({ color: 0xe8ecf1, roughness: .4, metalness: .3 });
  const agvLight = new THREE.MeshBasicMaterial({ color: new THREE.Color(accentCss) });
  for (let i = 0; i < 7; i++) {
    const a = new THREE.Group();
    const body = new THREE.Mesh(geoBox, agvMat); body.scale.set(2.2, 0.7, 1.4); body.position.y = 0.45; a.add(body);
    const box = new THREE.Mesh(geoBox, new THREE.MeshStandardMaterial({ color: 0xb08650 })); box.scale.set(1.4, 1, 1); box.position.y = 1.3; a.add(box);
    const led = new THREE.Mesh(geoBox, agvLight); led.scale.set(2.25, 0.12, 1.45); led.position.y = 0.82; a.add(led);
    a.position.set(rand(x0 + 30, x1 - 30), FLOOR_Y, [-140, -96, -30, 26, 64][i % 5]); a.userData = { v: (i % 2 ? 1 : -1) * rand(4, 7) };
    g.add(a); agvs.push(a);
  }
  // Soportes de la entreplanta y escalera
  const sup = [];
  for (const x of [-15, -5, 5, 15]) for (const z of [-11.5, 0.5, 12.5]) sup.push([x, FLOOR_Y / 2 - 0.2, z, 0.8, -FLOOR_Y - 0.4, 0.8]);
  inst(geoBox, steel, sup);
  const under = new THREE.Mesh(geoBox, new THREE.MeshStandardMaterial({ color: 0x1b1f25, metalness: .6, roughness: .5 })); under.scale.set(31.4, 1.4, 25.4); under.position.set(0, -1.05, 0.5); g.add(under);
  const edgeLed = new THREE.Mesh(geoBox, new THREE.MeshBasicMaterial({ color: new THREE.Color(accentCss), toneMapped: false })); edgeLed.scale.set(31.6, 0.12, 25.6); edgeLed.position.set(0, -1.8, 0.5); g.add(edgeLed);
  const steps = [];
  for (let i = 0; i < 32; i++) steps.push([-14 - i * 0.62 * 0 + 0, -0.5 - i * 0.5, 14 + i * 0.7, 3, 0.18, 0.75]);
  inst(geoBox, steel, steps);

  let craneX = 0, craneDir = 1;
  return {
    tick(now, dt, camY = 0) {
      ceil.visible = camY < FLOOR_Y + h - 4;
      craneX += craneDir * dt * 6; if (craneX > x1 - 30 || craneX < x0 + 30) craneDir *= -1;
      crane.position.x = craneX;
      trolley.position.z = cz + Math.sin(now * 0.05) * (D / 2 - 30); hook.position.z = trolley.position.z;
      for (const a of agvs) { a.position.x += a.userData.v * dt; if (a.position.x > x1 - 25 || a.position.x < x0 + 25) { a.userData.v *= -1; } a.rotation.y = a.userData.v > 0 ? 0 : Math.PI; }
      agvLight.color.setHSL(0.45, 1, 0.45 + Math.sin(now * 6) * 0.15);
    },
  };
}

// ------------------------------------------------------------------ multitud: todos los agentes en sus mesas
// Instanciado: cada pieza del robot (torso, cabeza, visor, ojos, brazos, piernas) es un solo dibujo para los 271.
// Tres zonas de mesas alrededor de la entreplanta y diez mesas conjuntas entre ellas.
const CROWD_FIELDS = [
  { x0: -150, z0: -128, group: 6, groups: 4, rows: 5 },
  { x0: -150, z0: 34, group: 6, groups: 4, rows: 4 },
  { x0: 44, z0: -128, group: 6, groups: 2, rows: 6 },
];
const CROWD_DX = 3.4, CROWD_AISLE = 10, CROWD_DZ = 6.4;
const TEAM_TABLES = (() => {
  const out = [];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) out.push({ x: -130 + i * 30, z: -80 + j * 26, seats: 14 });
  out.push({ x: 66, z: -70, seats: 14 }, { x: 66, z: -44, seats: 14 });
  return out;
})();

function crowdLayout(n) {
  const slots = [];
  for (const f of CROWD_FIELDS) for (let r = 0; r < f.rows && slots.length < n; r++) {
    for (let gi = 0; gi < f.groups && slots.length < n; gi++) for (let k = 0; k < f.group && slots.length < n; k++) {
      const gx = f.x0 + gi * (f.group * CROWD_DX + CROWD_AISLE);
      const x = gx + k * CROWD_DX, z = f.z0 + r * CROWD_DZ;
      slots.push({ x, z, seat: [x, z + 0.75], lane: [x, z + 1.9], aisle: gx - CROWD_AISLE / 2 - CROWD_DX / 2 });
    }
  }
  // Si hubiera más agentes que puestos, filas extra al final.
  for (let i = 0; slots.length < n; i++) { const x = -150 + (i % 36) * CROWD_DX, z = 70 + Math.floor(i / 36) * CROWD_DZ; slots.push({ x, z, seat: [x, z + 0.75], lane: [x, z + 1.9], aisle: -158 }); }
  return slots;
}

function makeCrowd(scene, agents, codeTex, accentCss) {
  const N = agents.length;
  const slots = crowdLayout(N);
  const geoBox = new THREE.BoxGeometry(1, 1, 1);
  // Mesas con ordenador (instanciadas)
  const deskParts = [
    [geoBox, new THREE.MeshStandardMaterial({ color: 0xf2f2ef, roughness: .35 }), (s) => [s.x, FLOOR_Y + 0.76, s.z, 2.1, 0.05, 0.95]],
    [geoBox, new THREE.MeshStandardMaterial({ color: 0x15181d, roughness: .4, metalness: .4 }), (s) => [s.x - 0.98, FLOOR_Y + 0.37, s.z, 0.05, 0.74, 0.8]],
    [geoBox, new THREE.MeshStandardMaterial({ color: 0x15181d, roughness: .4, metalness: .4 }), (s) => [s.x + 0.98, FLOOR_Y + 0.37, s.z, 0.05, 0.74, 0.8]],
    [geoBox, new THREE.MeshStandardMaterial({ color: 0x0c0e12, roughness: .3, metalness: .5 }), (s) => [s.x, FLOOR_Y + 1.36, s.z - 0.28, 1.1, 0.62, 0.04]],
    [geoBox, new THREE.MeshBasicMaterial({ map: codeTex, toneMapped: false }), (s) => [s.x, FLOOR_Y + 1.36, s.z - 0.255, 1.02, 0.55, 0.01]],
    [geoBox, new THREE.MeshStandardMaterial({ color: 0x1f2329, roughness: .8 }), (s) => [s.x, FLOOR_Y + 0.47, s.z + 0.75, 0.55, 0.08, 0.5]],
    [geoBox, new THREE.MeshStandardMaterial({ color: 0x1f2329, roughness: .8 }), (s) => [s.x, FLOOR_Y + 0.85, s.z + 1.02, 0.55, 0.66, 0.06]],
  ];
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), sc = new THREE.Vector3();
  for (const [geo, mat, f] of deskParts) {
    const mesh = new THREE.InstancedMesh(geo, mat, N);
    slots.forEach((s, i) => { const [x, y, z, sx, sy, sz] = f(s); mesh.setMatrixAt(i, m4.compose(v.set(x, y, z), q.identity(), sc.set(sx, sy, sz))); });
    mesh.receiveShadow = true; scene.add(mesh);
  }
  // Mesas conjuntas (grandes, de 14 plazas) con pantalla central
  const tableMat = new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: .35, metalness: .5 });
  const tableTop = new THREE.MeshStandardMaterial({ color: 0xf4f3ef, roughness: .3 });
  const tables = TEAM_TABLES.map((t, ti) => {
    const grp = new THREE.Group(); grp.position.set(t.x, FLOOR_Y, t.z); scene.add(grp);
    const top = new THREE.Mesh(geoBox, tableTop); top.scale.set(16, 0.08, 3.2); top.position.y = 0.78; grp.add(top);
    for (const sx of [-7, 0, 7]) { const leg = new THREE.Mesh(geoBox, tableMat); leg.scale.set(0.3, 0.74, 2.6); leg.position.set(sx, 0.37, 0); grp.add(leg); }
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(6, 2.2), new THREE.MeshBasicMaterial({ map: codeTex, toneMapped: false, side: THREE.DoubleSide }));
    scr.position.set(0, 2.6, 0); grp.add(scr);
    const glow = new THREE.Mesh(new THREE.RingGeometry(9, 9.6, 64).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(accentCss), transparent: true, opacity: 0, toneMapped: false }));
    glow.scale.set(1, 1, 0.34); glow.position.y = 0.05; grp.add(glow);
    const seats = [];
    for (let k = 0; k < t.seats / 2; k++) for (const side of [-1, 1]) seats.push({ spot: [t.x - 6 + k * 2, t.z + side * 2.1], face: side > 0 ? Math.PI : 0 });
    return { ...t, id: ti, grp, glow, seats, busy: 0, until: 0, members: [], real: false };
  });

  // Robots instanciados
  const mk = (geo, mat) => { const m = new THREE.InstancedMesh(geo, mat, N); m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.castShadow = false; scene.add(m); return m; };
  const body = new THREE.MeshStandardMaterial({ roughness: .45, metalness: .15 });
  const parts = {
    torso: mk(new THREE.CapsuleGeometry(0.27, 0.36, 4, 10), body),
    head: mk(new THREE.SphereGeometry(0.27, 14, 10), new THREE.MeshStandardMaterial({ color: 0xf4f6fa, roughness: .35 })),
    visor: mk(geoBox, new THREE.MeshStandardMaterial({ color: 0x0c1118, roughness: .3, metalness: .4 })),
    eyes: mk(geoBox, new THREE.MeshBasicMaterial({ toneMapped: false })),
    armL: mk(new THREE.CapsuleGeometry(0.065, 0.36, 3, 6), body), armR: mk(new THREE.CapsuleGeometry(0.065, 0.36, 3, 6), body),
    legL: mk(new THREE.CapsuleGeometry(0.08, 0.38, 3, 6), new THREE.MeshStandardMaterial({ color: 0x14171c })),
    legR: mk(new THREE.CapsuleGeometry(0.08, 0.38, 3, 6), new THREE.MeshStandardMaterial({ color: 0x14171c })),
  };
  const eyeCols = [0x38d6ff, 0x7cffb2, 0xffd166, 0xff7ab8, 0xb69cff];
  const bots = agents.map((a, i) => {
    const col = new THREE.Color(HEX[a.color] || HEX.azul);
    parts.torso.setColorAt(i, col); parts.armL.setColorAt(i, col); parts.armR.setColorAt(i, col);
    parts.eyes.setColorAt(i, new THREE.Color(eyeCols[hashOf(a.id) % 5]));
    const s = slots[i];
    return { i, agent: a, slot: s, pos: [...s.seat], face: Math.PI, rot: Math.PI, state: "sit", path: [], table: null, phase: rand(0, TAU), speed: rand(1.8, 2.3) };
  });
  for (const k of ["torso", "armL", "armR", "eyes"]) parts[k].instanceColor.needsUpdate = true;

  const route = (b, to, lane) => {
    const s = b.slot;
    if (b.state === "sit") return [s.lane, [s.aisle, s.lane[1]], [s.aisle, lane[1]], lane, to];
    return [lane, [s.aisle, lane[1]], [s.aisle, s.lane[1]], s.lane, to];
  };
  const tableLane = (t, seat) => [seat.spot[0], t.z + (seat.spot[1] > t.z ? 3.6 : -3.6)];
  const sendTo = (b, t) => {
    const seat = t.seats.find((x) => !x.b);
    if (!seat) return false;
    seat.b = b; b.table = t; b.seat = seat;
    b.path = route(b, seat.spot, tableLane(t, seat)); b.state = "walk"; b.going = "table";
    t.members.push(b);
    return true;
  };
  const sendHome = (b) => {
    const t = b.table;
    if (b.seat) b.seat.b = null;
    if (t) t.members = t.members.filter((x) => x !== b);
    b.path = route({ ...b, state: "table" }, b.slot.seat, tableLane(t, b.seat));
    b.table = null; b.seat = null; b.state = "walk"; b.going = "desk";
  };

  // Matrices de pose (reutilizadas: sin crear objetos en cada fotograma)
  const base = new THREE.Matrix4(), tmp = new THREE.Matrix4(), local = new THREE.Matrix4();
  const P = new THREE.Vector3(), Q = new THREE.Quaternion(), SC = new THREE.Vector3(), ONE = new THREE.Vector3(1, 1, 1), AX = new THREE.Vector3(1, 0, 0), AY = new THREE.Vector3(0, 1, 0);
  const put = (mesh, i, x, y, z, q, sx = 1, sy = 1, sz = 1) => { local.compose(P.set(x, y, z), q, sx === 1 && sy === 1 && sz === 1 ? ONE : SC.set(sx, sy, sz)); tmp.multiplyMatrices(base, local); mesh.setMatrixAt(i, tmp); };
  const QI = new THREE.Quaternion(), QY = new THREE.Quaternion();
  const limb = (mesh, i, px, py, ang, len) => { const L = len / 2 + 0.07; Q.setFromAxisAngle(AX, ang); put(mesh, i, px, py - L * Math.cos(ang), -L * Math.sin(ang), Q); };
  let nextDispatch = 2, realIds = new Set();

  return {
    count: N,
    idOf: (i) => agents[i]?.id,
    pick: [parts.torso, parts.head],
    setReal(ids) { realIds = ids; },
    tables,
    tick(now, dt) {
      // Equipos que se forman: 10-15 agentes cercanos van a una mesa conjunta libre.
      if (now > nextDispatch) {
        nextDispatch = now + rand(6, 12);
        const free = tables.filter((t) => !t.members.length);
        if (free.length) {
          const t = free[Math.floor(Math.random() * free.length)];
          const size = 10 + Math.floor(Math.random() * 6);
          const idle = bots.filter((b) => b.state === "sit").sort((a, b) => Math.hypot(a.pos[0] - t.x, a.pos[1] - t.z) - Math.hypot(b.pos[0] - t.x, b.pos[1] - t.z)).slice(0, size * 2);
          idle.sort(() => Math.random() - .5).slice(0, size).forEach((b) => sendTo(b, t));
          t.until = Infinity; t.started = false; t.real = false;
        }
      }
      // Agentes que Kairo está usando de verdad: van a la mesa más cercana libre y se marca LIVE.
      for (const b of bots) if (realIds.has(b.agent.id) && b.state === "sit") {
        const t = tables.find((x) => x.real && x.seats.some((s) => !s.b)) || tables.find((x) => !x.members.length);
        if (t) { t.real = true; t.until = Infinity; sendTo(b, t); }
      }
      for (const t of tables) {
        if (t.real && !t.members.some((b) => realIds.has(b.agent.id))) { t.real = false; t.started = true; t.until = now + 4; }
        // El tiempo de trabajo cuenta desde que el equipo se ha sentado.
        if (!t.real && !t.started && t.members.length && t.members.every((b) => b.state === "work")) { t.started = true; t.until = now + rand(25, 45); }
        if (now > t.until && t.members.length) [...t.members].forEach((b) => { if (b.state === "work" || b.state === "walk") sendHome(b); });
        const on = t.members.some((b) => b.state === "work");
        t.glow.material.opacity += ((on ? 0.8 + Math.sin(now * 4) * 0.15 : 0) - t.glow.material.opacity) * Math.min(1, dt * 3);
      }
      for (const b of bots) {
        if (b.state === "walk") {
          const tgt = b.path[0];
          if (!tgt) { b.state = b.going === "table" ? "work" : "sit"; b.face = b.going === "table" ? b.seat.face : Math.PI; }
          else {
            const dx = tgt[0] - b.pos[0], dz = tgt[1] - b.pos[1], d = Math.hypot(dx, dz), st = b.speed * dt;
            if (d <= st) { b.pos = [tgt[0], tgt[1]]; b.path.shift(); } else { b.pos = [b.pos[0] + dx / d * st, b.pos[1] + dz / d * st]; b.face = Math.atan2(dx, dz); }
          }
        }
        let da = b.face - b.rot; da = Math.atan2(Math.sin(da), Math.cos(da)); b.rot += da * Math.min(1, dt * 10);
        const t = now + b.phase;
        const walking = b.state === "walk" && b.path.length;
        const sitting = b.state === "sit";
        const hy = sitting ? 0.18 : 0.62 + (walking ? Math.abs(Math.cos(t * 9)) * 0.05 : 0);
        base.makeRotationY(b.rot).setPosition(b.pos[0], FLOOR_Y, b.pos[1]);
        const s = Math.sin(t * 9);
        const typing = sitting || b.state === "work";
        const aL = walking ? -s * 0.6 : typing ? -1.15 + Math.sin(t * 13) * 0.1 : 0;
        const aR = walking ? s * 0.6 : typing ? -1.15 + Math.cos(t * 12) * 0.1 : 0;
        const lg = walking ? s * 0.7 : sitting ? -1.45 : 0;
        put(parts.torso, b.i, 0, hy + 0.36, 0, QI);
        const yaw = typing ? Math.sin(t * 0.4) * 0.2 : 0, sy = Math.sin(yaw), cy = Math.cos(yaw);
        const qYaw = QY.setFromAxisAngle(AY, yaw);
        put(parts.head, b.i, 0, hy + 1.02, 0, qYaw);
        put(parts.visor, b.i, 0.21 * sy, hy + 1.04, 0.21 * cy, qYaw, 0.42, 0.16, 0.08);
        put(parts.eyes, b.i, 0.255 * sy, hy + 1.04, 0.255 * cy, qYaw, 0.3, 0.05, 0.02);
        limb(parts.armL, b.i, -0.34, hy + 0.58, aL, 0.36);
        limb(parts.armR, b.i, 0.34, hy + 0.58, aR, 0.36);
        limb(parts.legL, b.i, -0.13, hy + 0.02, walking ? lg : sitting ? lg : 0, 0.38);
        limb(parts.legR, b.i, 0.13, hy + 0.02, walking ? -lg : sitting ? lg : 0, 0.38);
      }
      for (const k in parts) parts[k].instanceMatrix.needsUpdate = true;
    },
  };
}

/** Mesa de proyecto con pantalla holográfica. */
function makeStation(scene, kit, x, z, project, live) {
  const g = new THREE.Group(); g.position.set(x, 0, z); scene.add(g);
  const color = HEX[project.color] || HEX.azul;
  kit.cyl(1.05, 1.05, 0.07, kit.marble, 0, 0.78, 0, g, 48);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(1.05, 0.025, 8, 64), kit.gold); rim.rotation.x = Math.PI / 2; rim.position.y = 0.78; g.add(rim);
  kit.cyl(0.1, 0.34, 0.76, kit.black, 0, 0.38, 0, g);
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

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  container.append(renderer.domElement);
  const overlay = document.createElement("div");
  overlay.className = "of-overlay";
  container.append(overlay);

  const scene = new THREE.Scene();
  // Cielo de atardecer en Dubái + reflejos (entorno generado a partir del propio cielo)
  scene.background = hallBgTex();
  scene.fog = new THREE.FogExp2(0x1b2129, 0.0027);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), new THREE.MeshBasicMaterial({ map: hallEnvTex(), side: THREE.BackSide })));
  const env = pmrem.fromScene(envScene, 0.04).texture;
  pmrem.dispose();

  const cam = new THREE.PerspectiveCamera(42, 1, 0.5, 9000);
  const view = { target: new THREE.Vector3(0, 5, 0.5), zoom: 1, angle: Math.PI / 4, pitch: 0.34 };
  const dist = () => 50 / view.zoom;
  const placeCam = () => {
    const w = container.clientWidth || 800, h = container.clientHeight || 600;
    const d = dist();
    cam.aspect = w / h;
    cam.position.set(view.target.x + Math.cos(view.angle) * Math.cos(view.pitch) * d, view.target.y + Math.sin(view.pitch) * d, view.target.z + Math.sin(view.angle) * Math.cos(view.pitch) * d);
    cam.lookAt(view.target);
    cam.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  };

  scene.add(new THREE.HemisphereLight(0xeef3ff, 0x3a3e46, 1.6));
  const sun = new THREE.DirectionalLight(0xfff3e2, 1.9); // luz cenital de los lucernarios
  sun.position.set(-18, 40, -12); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -24, right: 24, top: 24, bottom: -24, near: 1, far: 90 });
  sun.shadow.bias = -0.0004; sun.shadow.radius = 4;
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x9fb8ff, 0.7); fill.position.set(20, 18, 16); scene.add(fill);

  const kit = office(scene, accent, accentCss, env);
  const city = industrialHall(scene, env, accentCss);
  let crowd = null;
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
      view.zoom = Math.min(3.2, Math.max(0.16, pinch.z * Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch.d)); placeCam(); return;
    }
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.hypot(dx, dy) > 5) drag.moved = true;
    if (!drag.moved) return;
    const k = (2 * dist() * Math.tan((cam.fov * Math.PI) / 360)) / container.clientHeight;
    const right = new THREE.Vector3(-Math.sin(view.angle), 0, Math.cos(view.angle));
    const fwd = new THREE.Vector3(-Math.cos(view.angle), 0, -Math.sin(view.angle));
    view.target.copy(drag.t).addScaledVector(right, -dx * k).addScaledVector(fwd, dy * k * 1.8);
    view.target.x = Math.max(-18, Math.min(18, view.target.x)); view.target.z = Math.max(-15, Math.min(16, view.target.z));
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
      const hit = ray.intersectObjects(crowd ? [...clickables, ...crowd.pick] : clickables, false)[0];
      if (hit && crowd?.pick.includes(hit.object) && hit.instanceId != null) api.onBot(crowd.idOf(hit.instanceId), e);
      else if (hit?.object.userData.botId) api.onBot(hit.object.userData.botId, e);
      else if (hit?.object.userData.stationId != null && hit.object.userData.stationId !== "kairo") api.onStation(hit.object.userData.stationId, e);
      else api.onEmpty?.();
    }
    drag = null;
  });
  el.addEventListener("wheel", (e) => { e.preventDefault(); view.zoom = Math.min(3.2, Math.max(0.16, view.zoom * (e.deltaY < 0 ? 1.1 : 0.9))); placeCam(); }, { passive: false });
  const ro = new ResizeObserver(() => placeCam());
  ro.observe(container);

  // ---------------------------------------------------------- bucle
  let alive = true, last = performance.now(), codeT = 0;
  const loop = (ms) => {
    if (!alive) return;
    if (!container.isConnected) { destroy(); return; }
    const now = (ms / 1000) * SPEED, dt = Math.min(0.05, (ms - last) / 1000) * SPEED; last = ms;
    kit.tick(now, dt); city.tick(now, dt, cam.position.y); crowd?.tick(now, dt);
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
    if (crowd) for (const t of crowd.tables) {
      const tag = tagFor("t" + t.id, "of-station team");
      const n = t.members.filter((b) => b.state === "work").length;
      const txt = n ? `${t.real ? "● LIVE · Kairo · " : "⚡ Equipo · "}${n} agentes` : "";
      if (tag.textContent !== txt) tag.textContent = txt;
      tag.hidden = !txt;
      if (txt) place(tag, t.x, FLOOR_Y + 4.2, t.z);
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
      for (const b of bots.values()) b.wantWork = map.get(b.id) ?? null;
      // Agentes que Kairo usa y no están en la entreplanta: en la nave se levantan y van a una mesa conjunta (LIVE).
      crowd?.setReal(new Set(visitors.map((v) => v.agent.id)));
    },
    /** Todos los agentes del registro, cada uno en su mesa de la nave. */
    setCrowd(agents) {
      if (crowd || !agents.length) return;
      crowd = makeCrowd(scene, agents, code.tex, accentCss);
    },
    setLive(ids) { for (const [id, st] of stations) st.live = ids.has(id); },
    zoom(k) { view.zoom = Math.min(3.2, Math.max(0.16, view.zoom * k)); placeCam(); },
    rotate() { view.angle += Math.PI / 2; placeCam(); },
    reset() { view.target.set(0, 5, 0.5); view.zoom = container.clientWidth < 700 ? 0.75 : 1; view.angle = Math.PI / 4; placeCam(); },
    destroy,
    start() { placeCam(); if (container.clientWidth < 700) { view.zoom = 0.75; placeCam(); } requestAnimationFrame(loop); },
  };
}
