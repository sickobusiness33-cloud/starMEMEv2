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

// ------------------------------------------------------------------ Dubái: cielo, ciudad y torre
const CITY_Y = -260; // el suelo de la ciudad queda muy por debajo: estamos en lo alto de una torre

function skyTex() {
  return canvasTex(64, 512, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, "#070b1f"); gr.addColorStop(0.35, "#1b1d45"); gr.addColorStop(0.55, "#5b3b73");
    gr.addColorStop(0.7, "#e0785a"); gr.addColorStop(0.8, "#f6b36b"); gr.addColorStop(1, "#2a2438");
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  });
}
/** Fachada con ventanas: algunas encendidas (cálidas) y otras apagadas. */
function windowTex(cols = 16, rows = 32, lit = 0.35) {
  const t = canvasTex(cols * 8, rows * 8, (g) => {
    g.fillStyle = "#0c131e"; g.fillRect(0, 0, cols * 8, rows * 8);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const on = Math.random() < lit;
      g.fillStyle = on ? ["#ffd9a0", "#fff1c9", "#cfe8ff", "#ffcf8a"][Math.floor(Math.random() * 4)] : ["#16202e", "#1b2738", "#121a26"][Math.floor(Math.random() * 3)];
      g.fillRect(c * 8 + 1, r * 8 + 2, 6, 5);
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
  return t;
}
/** Caja con UV repetidas según su tamaño real (las ventanas no se estiran). */
function towerGeo(uvx, uvy) {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  geo.translate(0, 0.5, 0);
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * uvx, uv.getY(i) * uvy);
  return geo;
}

function dubai(scene) {
  const group = new THREE.Group(); scene.add(group);
  const winTex = windowTex(16, 32, 0.35);
  const facade = (repeatY = 1) => {
    const t = winTex.clone(); t.needsUpdate = true; t.repeat.set(1, repeatY);
    return new THREE.MeshStandardMaterial({ map: t, emissiveMap: t, emissive: 0xffffff, emissiveIntensity: 0.55, roughness: 0.3, metalness: 0.6, color: 0x7d8fa3 });
  };
  // Suelo del desierto, mar y costa
  const sand = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000), new THREE.MeshStandardMaterial({ color: 0x5e4b40, roughness: 1 }));
  sand.rotation.x = -Math.PI / 2; sand.position.y = CITY_Y; group.add(sand);
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(4000, 9000), new THREE.MeshStandardMaterial({ color: 0x1b3b5a, roughness: 0.12, metalness: 0.7 }));
  sea.rotation.x = -Math.PI / 2; sea.position.set(-3000, CITY_Y + 0.4, 0); group.add(sea);
  // Autopista con coches (luces que se mueven)
  const road = new THREE.Mesh(new THREE.PlaneGeometry(5000, 40), new THREE.MeshStandardMaterial({ color: 0x1a1c22, roughness: .9 }));
  road.rotation.x = -Math.PI / 2; road.position.set(0, CITY_Y + 0.5, -320); group.add(road);
  const CARS = 260;
  const carPos = new Float32Array(CARS * 3), carCol = new Float32Array(CARS * 3), carV = [];
  for (let i = 0; i < CARS; i++) {
    const dir = i % 2 ? 1 : -1;
    carPos.set([rand(-2400, 2400), CITY_Y + 1.5, -320 + (dir > 0 ? -9 : 9) + rand(-4, 4)], i * 3);
    const c = dir > 0 ? [1, 0.25, 0.2] : [1, 0.95, 0.8];
    carCol.set(c, i * 3); carV.push(dir * rand(40, 80));
  }
  const carGeo = new THREE.BufferGeometry();
  carGeo.setAttribute("position", new THREE.BufferAttribute(carPos, 3));
  carGeo.setAttribute("color", new THREE.BufferAttribute(carCol, 3));
  const cars = new THREE.Points(carGeo, new THREE.PointsMaterial({ size: 5, vertexColors: true, transparent: true, opacity: .95, sizeAttenuation: true, fog: true }));
  group.add(cars);

  // Rascacielos (3 alturas con ventanas a escala)
  const classes = [
    { n: 260, h: [40, 160], uvy: 5 }, { n: 150, h: [160, 320], uvy: 10 }, { n: 60, h: [320, 520], uvy: 16 },
  ];
  const dummy = new THREE.Object3D();
  const tops = [];
  const palette = [0x8fa6bf, 0x9fb6c9, 0x7f93a8, 0xb5c2cf, 0x6f8aa3, 0xa9b8c4];
  for (const cl of classes) {
    const mesh = new THREE.InstancedMesh(towerGeo(2, cl.uvy), facade(), cl.n);
    let placed = 0, tries = 0;
    while (placed < cl.n && tries++ < cl.n * 20) {
      // Más alto y denso hacia el «downtown» (detrás de la oficina).
      const a = rand(0, TAU), r = rand(110, 1900);
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (x < -1000) continue; // mar
      if (Math.abs(z + 320) < 40) continue; // autopista
      const downtown = Math.max(0, 1 - Math.hypot(x + 420, z + 520) / 900);
      if (cl.h[0] > 300 && downtown < 0.2 && Math.random() < 0.85) continue;
      const w = rand(24, 60), d = rand(24, 60);
      // Cerca de nuestra torre, los edificios quedan por debajo: miramos la ciudad desde arriba.
      const hgt = Math.min(rand(cl.h[0], cl.h[1]) * (0.7 + downtown * 0.6), 60 + (r - 110) * 0.55);
      dummy.position.set(x, CITY_Y, z); dummy.scale.set(w, hgt, d); dummy.rotation.y = rand(0, Math.PI);
      dummy.updateMatrix(); mesh.setMatrixAt(placed, dummy.matrix);
      mesh.setColorAt(placed, new THREE.Color(palette[placed % palette.length]));
      if (hgt > 220) tops.push([x, CITY_Y + hgt, z]);
      placed++;
    }
    mesh.count = placed;
    group.add(mesh);
  }
  // Agujas y luces de aviación rojas en las torres altas
  const spireMat = new THREE.MeshStandardMaterial({ color: 0xc7d2dd, metalness: .8, roughness: .25 });
  const beacons = new THREE.InstancedMesh(new THREE.SphereGeometry(2.5, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff2a2a }), tops.length);
  tops.forEach((p, i) => {
    if (i % 3 === 0) { const s = new THREE.Mesh(new THREE.ConeGeometry(6, 60, 6), spireMat); s.position.set(p[0], p[1] + 30, p[2]); group.add(s); p = [p[0], p[1] + 60, p[2]]; }
    dummy.position.set(p[0], p[1] + 1, p[2]); dummy.scale.setScalar(1); dummy.rotation.set(0, 0, 0); dummy.updateMatrix(); beacons.setMatrixAt(i, dummy.matrix);
  });
  group.add(beacons);

  // Burj Khalifa (escalonado, con aguja) — el gigante del fondo
  const burj = new THREE.Group(); burj.position.set(-520, CITY_Y, -900); group.add(burj);
  const bMat = facade(); bMat.color.setHex(0xc9d6e2); bMat.emissiveIntensity = .7;
  let y = 0;
  [[62, 160], [52, 140], [42, 130], [33, 120], [25, 110], [18, 95], [12, 80], [8, 65]].forEach(([r, hh]) => {
    const seg = new THREE.Mesh(new THREE.CylinderGeometry(r * .82, r, hh, 6), bMat);
    seg.position.y = y + hh / 2; burj.add(seg); y += hh;
  });
  const needle = new THREE.Mesh(new THREE.CylinderGeometry(1, 5, 200, 8), spireMat); needle.position.y = y + 100; burj.add(needle);
  const bLight = new THREE.Mesh(new THREE.SphereGeometry(5, 10, 8), new THREE.MeshBasicMaterial({ color: 0xff3030 })); bLight.position.y = y + 202; burj.add(bLight);

  // Burj Al Arab (vela) en el mar
  const sail = new THREE.Shape();
  sail.moveTo(0, 0); sail.quadraticCurveTo(95, 130, 8, 320); sail.lineTo(0, 320); sail.lineTo(0, 0);
  const sailMesh = new THREE.Mesh(new THREE.ExtrudeGeometry(sail, { depth: 46, bevelEnabled: false, curveSegments: 24 }),
    new THREE.MeshStandardMaterial({ color: 0xf4f1ea, emissive: 0x6a7fb0, emissiveIntensity: .35, roughness: .4 }));
  sailMesh.position.set(-1150, CITY_Y, 520); sailMesh.rotation.y = Math.PI / 3; group.add(sailMesh);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 3.5, 370, 8), spireMat); mast.position.set(-1142, CITY_Y + 185, 512); group.add(mast);
  // Emirates Towers (dos prismas triangulares)
  for (const [x, hgt] of [[160, 360], [220, 300]]) {
    const t = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 34, hgt, 3), bMat); t.position.set(x, CITY_Y + hgt / 2, -640); group.add(t);
  }
  // La torre en la que estamos: fachada bajo la oficina
  const own = new THREE.Mesh(towerGeo(4, 14), facade()); own.scale.set(33, -CITY_Y - 0.4, 27); own.position.set(0, CITY_Y, 0.5); group.add(own);

  return {
    tick(now, dt) {
      for (let i = 0; i < CARS; i++) {
        let x = carPos[i * 3] + carV[i] * dt;
        if (x > 2400) x = -2400; if (x < -2400) x = 2400;
        carPos[i * 3] = x;
      }
      carGeo.attributes.position.needsUpdate = true;
      const blink = Math.sin(now * 2.4) > 0.3;
      beacons.visible = blink; bLight.visible = !blink;
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
  const sky = skyTex();
  scene.background = sky;
  scene.fog = new THREE.FogExp2(0x8a6078, 0.00055);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const skySphere = new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), new THREE.MeshBasicMaterial({ map: sky, side: THREE.BackSide }));
  envScene.add(skySphere);
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

  scene.add(new THREE.HemisphereLight(0xdfe6ff, 0x2a2d35, 1.05));
  const sun = new THREE.DirectionalLight(0xffc596, 2.0); // sol bajo del atardecer, entra por las cristaleras
  sun.position.set(-26, 16, -20); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -24, right: 24, top: 24, bottom: -24, near: 1, far: 90 });
  sun.shadow.bias = -0.0004; sun.shadow.radius = 4;
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x9fb8ff, 0.7); fill.position.set(20, 18, 16); scene.add(fill);

  const kit = office(scene, accent, accentCss, env);
  const city = dubai(scene);
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
      view.zoom = Math.min(3.2, Math.max(0.35, pinch.z * Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch.d)); placeCam(); return;
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
      const hit = ray.intersectObjects(clickables, false)[0];
      if (hit?.object.userData.botId) api.onBot(hit.object.userData.botId, e);
      else if (hit?.object.userData.stationId != null && hit.object.userData.stationId !== "kairo") api.onStation(hit.object.userData.stationId, e);
      else api.onEmpty?.();
    }
    drag = null;
  });
  el.addEventListener("wheel", (e) => { e.preventDefault(); view.zoom = Math.min(3.2, Math.max(0.35, view.zoom * (e.deltaY < 0 ? 1.1 : 0.9))); placeCam(); }, { passive: false });
  const ro = new ResizeObserver(() => placeCam());
  ro.observe(container);

  // ---------------------------------------------------------- bucle
  let alive = true, last = performance.now(), codeT = 0;
  const loop = (ms) => {
    if (!alive) return;
    if (!container.isConnected) { destroy(); return; }
    const now = ms / 1000, dt = Math.min(0.05, (ms - last) / 1000); last = ms;
    kit.tick(now, dt); city.tick(now, dt);
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
    zoom(k) { view.zoom = Math.min(3.2, Math.max(0.35, view.zoom * k)); placeCam(); },
    rotate() { view.angle += Math.PI / 2; placeCam(); },
    reset() { view.target.set(0, 5, 0.5); view.zoom = container.clientWidth < 700 ? 0.75 : 1; view.angle = Math.PI / 4; placeCam(); },
    destroy,
    start() { placeCam(); if (container.clientWidth < 700) { view.zoom = 0.75; placeCam(); } requestAnimationFrame(loop); },
  };
}
