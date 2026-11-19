/* Oficina 3D de Kairo · parqué de Wall Street (Three.js).
 *
 * Una sola planta, todo a la vista:
 *   - Al fondo, el videowall de KAIRO con KPIs reales y un teletipo que corre.
 *   - Delante, las mesas de proyecto (hologramas) y Kairo Core.
 *   - Primera fila: TU EQUIPO, cada robot con su puesto de trader de 3 pantallas.
 *     La pantalla central muestra lo que el agente está haciendo DE VERDAD.
 *   - Detrás, todo el catálogo en filas de trading desks.
 * Toca un robot para ver su ficha; toca su ordenador para ver qué le pidieron y qué genera.
 */
import * as THREE from "/vendor/three.min.js";

const TAU = Math.PI * 2;
// Solo para pruebas: ?officeSpeed=20 acelera el tiempo de la oficina.
const SPEED = Math.min(40, Math.max(1, Number(new URLSearchParams(location.search).get("officeSpeed")) || 1));
const rand = (a, b) => a + Math.random() * (b - a);
const HEX = { azul: 0x5b8cf5, rosa: 0xf26b8a, morado: 0xa97cf2, verde: 0x58cc6c, turquesa: 0x22c1ad, naranja: 0xf6a33c, amarillo: 0xf7c12e };
const hexCss = (c) => "#" + (HEX[c] || HEX.azul).toString(16).padStart(6, "0");
const hashOf = (s) => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 1000003, 7);
const FONT = "Geist, Inter, system-ui, sans-serif";
const MONO = "'Geist Mono', 'JetBrains Mono', ui-monospace, monospace";

// ------------------------------------------------------------------ distribución (metros)
const HALL = { x0: -42, x1: 42, z0: -34, z1: 34, h: 10 };
const WALK_Z = -15.2;                         // pasillo transversal delante de tu equipo
const TEAM_Z = -10.6;                         // asientos de tu equipo
const TEAM_LANE_Z = -8.6;                     // pasillo detrás de tu equipo
// Del centro hacia fuera, alternando lados: con pocos robots se quedan en el centro del parqué.
const TEAM_X = Array.from({ length: 16 }, (_, i) => (i % 2 ? 1 : -1) * (2.2 + Math.floor(i / 2) * 2.45));
const STATIONS = [[-30, -22.5], [-19, -22.5], [-8.5, -24.5], [8.5, -24.5], [19, -22.5], [30, -22.5]];
const KAIRO_CORE = [0, -24.5];
const BOARD = { spot: [-4.6, -16.6], lane: [-4.6, WALK_Z + 0.4] };
const BREAKS = [
  { id: "coffee", label: "☕ café", spot: [-38.4, -12.6], lane: [-36.6, TEAM_LANE_Z], face: -Math.PI / 2, cup: 0x6b3d1f },
  { id: "coffee", label: "☕ café", spot: [-38.4, -11.2], lane: [-36.6, TEAM_LANE_Z], face: -Math.PI / 2, cup: 0x6b3d1f },
  { id: "water", label: "💧 agua", spot: [38.4, -12.4], lane: [36.6, TEAM_LANE_Z], face: Math.PI / 2, cup: 0x9ad7ff },
  { id: "sofa", label: "🛋 descanso", spot: [38.5, -6.2], lane: [36.6, TEAM_LANE_Z], face: -Math.PI / 2, sit: 0.42 },
  { id: "sofa", label: "🛋 descanso", spot: [38.5, -4.9], lane: [36.6, TEAM_LANE_Z], face: -Math.PI / 2, sit: 0.42 },
];
const DOOR = [0, 33.2];
// Filas del parqué (todo el catálogo)
const ROW_Z0 = -3.2, ROW_DZ = 3.35, ROWS = 10, SEAT_DX = 2.3, SEATS_HALF = 15;
const CROWD_CAP = ROWS * SEATS_HALF * 2;
const HUDDLES = [[-26, 31.2], [-9, 31.2], [9, 31.2], [26, 31.2]];
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
function textTex(lines, { w = 512, h = 256, bg = "rgba(0,0,0,0)", color = "#fff", font = `600 64px ${FONT}`, sub = null, accent = null } = {}) {
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

// ------------------------------------------------------------------ pantallas del parqué
/** Gráfico de velas que avanza (pantallas laterales: ambiente de trading). */
function chartScreen(accentCss) {
  const c = document.createElement("canvas"); c.width = 256; c.height = 160;
  const g = c.getContext("2d");
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  let v = 80; const candles = Array.from({ length: 34 }, () => { const o = v; v = Math.max(20, Math.min(140, v + rand(-12, 12))); return [o, v, Math.max(o, v) + rand(0, 8), Math.min(o, v) - rand(0, 8)]; });
  const draw = () => {
    g.fillStyle = "#070b12"; g.fillRect(0, 0, 256, 160);
    g.strokeStyle = "rgba(255,255,255,.06)"; g.lineWidth = 1;
    for (let y = 20; y < 160; y += 28) { g.beginPath(); g.moveTo(0, y); g.lineTo(256, y); g.stroke(); }
    candles.forEach(([o, cl, hi, lo], i) => {
      const x = 6 + i * 7.3, up = cl >= o;
      g.strokeStyle = g.fillStyle = up ? "#34d399" : "#f87171";
      g.beginPath(); g.moveTo(x + 2.5, 160 - hi); g.lineTo(x + 2.5, 160 - lo); g.stroke();
      g.fillRect(x, 160 - Math.max(o, cl), 5, Math.max(2, Math.abs(cl - o)));
    });
    g.fillStyle = accentCss; g.fillRect(0, 0, 256, 3);
    tex.needsUpdate = true;
  };
  draw();
  return { tex, tick: () => { candles.shift(); const o = candles[candles.length - 1][1]; const cl = Math.max(20, Math.min(140, o + rand(-12, 12))); candles.push([o, cl, Math.max(o, cl) + rand(0, 8), Math.min(o, cl) - rand(0, 8)]); draw(); } };
}

/** Pantalla central del puesto de un agente: lo que hace DE VERDAD (petición / salida / estado). */
function agentScreen(agent, accentCss) {
  const c = document.createElement("canvas"); c.width = 640; c.height = 400;
  const g = c.getContext("2d");
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  let data = null, blink = 0;
  const wrap = (text, n) => String(text || "").replace(/\r/g, "").split("\n").flatMap((l) => (l.length ? l.match(new RegExp(`.{1,${n}}`, "g")) : [""]));
  const draw = () => {
    g.fillStyle = "#06090f"; g.fillRect(0, 0, 640, 400);
    g.fillStyle = "#0e1420"; g.fillRect(0, 0, 640, 44);
    g.fillStyle = hexCss(agent.color); g.beginPath(); g.arc(24, 22, 7, 0, TAU); g.fill();
    g.font = `600 22px ${FONT}`; g.fillStyle = "#e5e7eb"; g.textBaseline = "middle"; g.fillText(agent.name.slice(0, 30), 42, 23);
    const live = data?.live;
    const pill = live ? "● EN VIVO" : data ? "✓ ÚLTIMO TRABAJO" : "EN ESPERA";
    g.font = `700 15px ${MONO}`; const pw = g.measureText(pill).width + 20;
    g.fillStyle = live ? "rgba(52,211,153,.18)" : "rgba(255,255,255,.08)"; g.fillRect(640 - pw - 14, 11, pw, 24);
    g.fillStyle = live ? "#34d399" : "#9ca3af"; g.fillText(pill, 640 - pw - 4, 23);
    g.textBaseline = "alphabetic";
    if (!data) {
      g.font = `500 20px ${FONT}`; g.fillStyle = "#6b7280"; g.fillText("Sin tareas todavía.", 24, 110);
      g.font = `400 16px ${FONT}`; g.fillText("Cuando Kairo o un proyecto lo use, verás aquí", 24, 140); g.fillText("la petición y el resultado en tiempo real.", 24, 162);
    } else {
      g.font = `600 14px ${MONO}`; g.fillStyle = accentCss; g.fillText("› " + String(data.request || data.task || "").replace(/\s+/g, " ").slice(0, 64), 20, 72);
      g.font = `400 15px ${MONO}`;
      const lines = wrap(data.output || data.action || "…", 66);
      const shown = lines.slice(-17);
      let inCode = false;
      shown.forEach((l, i) => {
        if (/^```/.test(l)) inCode = !inCode;
        g.fillStyle = /^```/.test(l) ? "#6b7280" : inCode ? "#7dd3fc" : /^#|^\*\*/.test(l) ? "#f9fafb" : "#cbd5e1";
        g.fillText(l, 20, 100 + i * 17.5);
      });
      if (live && blink % 2 === 0) { g.fillStyle = accentCss; g.fillRect(20 + Math.min(600, g.measureText(shown[shown.length - 1] || "").width + 4), 86 + (shown.length - 1) * 17.5, 9, 16); }
      if (live && data.progress) { g.fillStyle = "rgba(255,255,255,.08)"; g.fillRect(0, 394, 640, 6); g.fillStyle = accentCss; g.fillRect(0, 394, 6.4 * Math.min(100, data.progress), 6); }
    }
    tex.needsUpdate = true;
  };
  draw();
  return { tex, set(d) { const k = JSON.stringify(d); if (k !== this.k) { this.k = k; data = d; draw(); } }, tick() { if (data?.live) { blink++; draw(); } } };
}

/** Skyline nocturno de Manhattan para las cristaleras. */
function skylineTex() {
  return canvasTex(2048, 512, (g, w, h) => {
    const sky = g.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, "#050914"); sky.addColorStop(0.6, "#0d1a33"); sky.addColorStop(1, "#1d2b4a");
    g.fillStyle = sky; g.fillRect(0, 0, w, h);
    for (let layer = 0; layer < 3; layer++) {
      let x = 0;
      while (x < w) {
        const bw = rand(40, 120) * (layer ? 1 : 0.8), bh = rand(120, 430) * (1 - layer * 0.18);
        g.fillStyle = ["#0b1222", "#0e1730", "#121d38"][layer]; g.fillRect(x, h - bh, bw, bh);
        if (Math.random() < 0.18) { g.beginPath(); g.moveTo(x + bw / 2, h - bh - rand(30, 90)); g.lineTo(x + bw * 0.3, h - bh); g.lineTo(x + bw * 0.7, h - bh); g.fill(); }
        for (let wy = h - bh + 8; wy < h - 6; wy += 9) for (let wx = x + 5; wx < x + bw - 6; wx += 8) if (Math.random() < 0.32 - layer * 0.06) {
          g.fillStyle = Math.random() < 0.85 ? `rgba(255,${200 + rand(0, 40) | 0},${120 + rand(0, 60) | 0},${0.5 + Math.random() * 0.4})` : "rgba(160,200,255,.7)";
          g.fillRect(wx, wy, 3.5, 4);
        }
        x += bw + rand(2, 14);
      }
    }
  });
}

/** Suelo: mármol oscuro pulido en damero suave. */
function floorTex() {
  const t = canvasTex(1024, 1024, (g, w, h) => {
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) { g.fillStyle = (x + y) % 2 ? "#1b1e24" : "#22262d"; g.fillRect(x * 256, y * 256, 256, 256); }
    for (let i = 0; i < 90; i++) {
      g.strokeStyle = `rgba(255,255,255,${0.015 + Math.random() * 0.035})`; g.lineWidth = rand(0.5, 1.8);
      g.beginPath(); let x = rand(0, w), y = rand(0, h); g.moveTo(x, y);
      for (let k = 0; k < 6; k++) { x += rand(-90, 90); y += rand(-30, 110); g.lineTo(x, y); }
      g.stroke();
    }
    g.strokeStyle = "rgba(201,164,92,.35)"; g.lineWidth = 2;
    for (let i = 0; i <= 4; i++) { g.beginPath(); g.moveTo(i * 256, 0); g.lineTo(i * 256, h); g.stroke(); g.beginPath(); g.moveTo(0, i * 256); g.lineTo(w, i * 256); g.stroke(); }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(10, 8);
  return t;
}

/** Videowall principal: marca + KPIs reales. */
function ledWall(accentCss) {
  const c = document.createElement("canvas"); c.width = 2560; c.height = 400;
  const g = c.getContext("2d");
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  let kpis = [];
  const draw = () => {
    const bg = g.createLinearGradient(0, 0, 0, 400); bg.addColorStop(0, "#04070d"); bg.addColorStop(1, "#0a1220");
    g.fillStyle = bg; g.fillRect(0, 0, 2560, 400);
    g.fillStyle = "rgba(255,255,255,.025)"; for (let x = 0; x < 2560; x += 4) g.fillRect(x, 0, 1, 400);
    g.textBaseline = "middle";
    g.font = `600 96px ${FONT}`; g.fillStyle = "#f8fafc"; g.fillText("KAIRO", 80, 150);
    g.fillStyle = accentCss; g.fillText("INTELLIGENCE", 80 + g.measureText("KAIRO ").width, 150);
    g.font = `500 32px ${MONO}`; g.fillStyle = "#94a3b8"; g.fillText("AGENT TRADING FLOOR · " + new Date().toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" }).toUpperCase(), 84, 260);
    // KPIs en la mitad derecha (sin pisar el título)
    const left = 1400, cw = Math.min(260, (2560 - left - 40) / Math.max(1, kpis.length));
    kpis.forEach((k, i) => {
      const x = left + i * cw;
      g.fillStyle = "rgba(255,255,255,.05)"; g.fillRect(x, 80, cw - 18, 220);
      g.font = `500 24px ${MONO}`; g.fillStyle = "#94a3b8"; g.fillText(k.label.toUpperCase(), x + 18, 124, cw - 36);
      g.font = `600 ${String(k.value).length > 6 ? 58 : 80}px ${FONT}`; g.fillStyle = k.tone === "up" ? "#34d399" : k.tone === "live" ? accentCss : "#f8fafc"; g.fillText(String(k.value), x + 16, 215, cw - 30);
    });
    tex.needsUpdate = true;
  };
  draw();
  return { tex, set(k) { const s = JSON.stringify(k); if (s !== this.s) { this.s = s; kpis = k.slice(0, 5); draw(); } } };
}

/** Teletipo (cinta que corre bajo el videowall). */
function tickerTape(accentCss) {
  const c = document.createElement("canvas"); c.width = 4096; c.height = 96;
  const g = c.getContext("2d");
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  const draw = (items) => {
    g.fillStyle = "#020408"; g.fillRect(0, 0, 4096, 96);
    g.font = `600 44px ${MONO}`; g.textBaseline = "middle";
    let x = 30; const list = items.length ? items : [{ text: "KAIRO INTELLIGENCE", tone: "live" }];
    for (let rep = 0; x < 4096 && rep < 20; rep++) for (const it of list) {
      g.fillStyle = it.tone === "up" ? "#34d399" : it.tone === "down" ? "#f87171" : it.tone === "live" ? accentCss : "#e5e7eb";
      g.fillText(it.text, x, 50); x += g.measureText(it.text).width + 40;
      g.fillStyle = "#334155"; g.fillText("•", x - 26, 50);
      if (x > 4096) break;
    }
    tex.needsUpdate = true;
  };
  draw([]);
  return { tex, set(items) { const s = JSON.stringify(items); if (s !== this.s) { this.s = s; draw(items); } } };
}

// ------------------------------------------------------------------ edificio
function tradingFloor(scene, accent, accentCss, env) {
  const M = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: .5, metalness: .05, envMap: env, ...o });
  const box = (w, h, d, mat, x, y, z, parent = scene, cast = false) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z); m.castShadow = cast; m.receiveShadow = true; parent.add(m); return m;
  };
  const cyl = (rt, rb, h, mat, x, y, z, parent = scene, seg = 24) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
    m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m;
  };
  const gold = M(0xc9a45c, { metalness: 1, roughness: .28, envMapIntensity: 1.3 });
  const chrome = M(0xdfe5ec, { metalness: 1, roughness: .15 });
  const black = M(0x111317, { roughness: .35, metalness: .4 });
  const white = M(0xf3f2ee, { roughness: .3 });
  const wood = M(0x4a3222, { roughness: .4 });
  const marble = new THREE.MeshStandardMaterial({ map: marbleTex(), roughness: .3, metalness: .05, envMap: env });
  const cream = M(0xe9dfcf, { roughness: .9 });
  const leaf = M(0x2f6b3f, { roughness: .8 });
  const { x0, x1, z0, z1, h } = HALL;
  const W = x1 - x0, D = z1 - z0;

  // Suelo de mármol oscuro pulido + moqueta azul marino bajo los puestos
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ map: floorTex(), roughness: .34, metalness: .1, envMap: env, envMapIntensity: .6 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
  const carpet = M(0x141b2b, { roughness: 1, envMap: null });
  box(44, 0.02, 4.4, carpet, 0, 0.01, TEAM_Z - 0.4);                                              // tu equipo
  for (const s of [-1, 1]) box(SEATS_HALF * SEAT_DX + 1, 0.02, ROWS * ROW_DZ, carpet, s * (2.4 + (SEATS_HALF - 1) * SEAT_DX / 2), 0.01, ROW_Z0 + (ROWS - 1) * ROW_DZ / 2 - 0.2);
  // Líneas doradas que marcan los pasillos
  box(0.08, 0.025, D - 4, gold, -1.3, 0.015, 2); box(0.08, 0.025, D - 4, gold, 1.3, 0.015, 2);
  box(W - 6, 0.025, 0.08, gold, 0, 0.015, WALK_Z - 1.4); box(W - 6, 0.025, 0.08, gold, 0, 0.015, WALK_Z + 1.4);

  // Paredes: piedra clara abajo, cristaleras con el skyline arriba, pilastras de mármol
  const stone = M(0x2a2c31, { roughness: .7 });
  const sky = new THREE.MeshBasicMaterial({ map: skylineTex(), toneMapped: false });
  const wall = (len, x, z, ry) => {
    const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = ry; scene.add(g);
    box(len, 1.4, 0.3, stone, 0, 0.7, 0, g);
    const win = new THREE.Mesh(new THREE.PlaneGeometry(len, h - 2.6), sky); win.position.set(0, 1.4 + (h - 2.6) / 2, -0.05); g.add(win);
    for (let px = -len / 2; px <= len / 2 + 0.01; px += 4.2) box(0.6, h, 0.6, marble, px, h / 2, 0.1, g, false);
    box(len, 0.3, 0.5, gold, 0, 1.45, 0.05, g); box(len, 1.2, 0.6, stone, 0, h - 0.6, 0.05, g);
    return g;
  };
  wall(W, 0, z1, Math.PI);           // fondo (detrás de las filas)
  wall(D, x0, 0, Math.PI / 2);       // izquierda
  wall(D, x1, 0, -Math.PI / 2);      // derecha
  // Pared frontal: el videowall
  box(W, h, 0.4, stone, 0, h / 2, z0 - 0.2);
  // Techo oscuro con tiras de luz
  const ceil = new THREE.Group(); scene.add(ceil);
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(W, D), M(0x0d0f13, { roughness: .9 })); ceiling.rotation.x = Math.PI / 2; ceiling.position.y = h; ceil.add(ceiling);
  const strip = new THREE.MeshBasicMaterial({ color: 0xfff4e0 });
  for (let z = z0 + 4; z < z1 - 2; z += 4.2) { const s = new THREE.Mesh(new THREE.BoxGeometry(W - 10, 0.06, 0.22), strip); s.position.set(0, h - 0.05, z); ceil.add(s); }

  // Videowall + teletipo
  const led = ledWall(accentCss), tape = tickerTape(accentCss);
  box(48.6, 8.4, 0.3, black, 0, 5.6, z0 + 0.25);
  const ledMesh = new THREE.Mesh(new THREE.PlaneGeometry(48, 7.5), new THREE.MeshBasicMaterial({ map: led.tex, toneMapped: false }));
  ledMesh.position.set(0, 5.85, z0 + 0.42); scene.add(ledMesh);
  const tapeMesh = new THREE.Mesh(new THREE.PlaneGeometry(W - 1, 0.95), new THREE.MeshBasicMaterial({ map: tape.tex, toneMapped: false }));
  tapeMesh.position.set(0, 1.25, z0 + 0.45); tape.tex.repeat.set(2, 1); scene.add(tapeMesh);
  // Segundo teletipo en las paredes laterales (anillo de cotizaciones)
  for (const s of [-1, 1]) { const m = new THREE.Mesh(new THREE.PlaneGeometry(D - 6, 0.7), new THREE.MeshBasicMaterial({ map: tape.tex, toneMapped: false })); m.position.set(s * (x1 - 0.45), h - 1.7, 0); m.rotation.y = -s * Math.PI / 2; scene.add(m); }
  

  // Tablón de tareas (kanban) delante de Kairo Core
  const kb = kanbanScreen(accentCss);
  box(4.4, 2.4, 0.14, black, BOARD.spot[0], 1.9, BOARD.spot[1] - 1.25);
  const kbScreen = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 2.1), new THREE.MeshBasicMaterial({ map: kb.tex, toneMapped: false }));
  kbScreen.position.set(BOARD.spot[0], 1.9, BOARD.spot[1] - 1.17); scene.add(kbScreen);
  box(0.14, 0.7, 0.14, black, BOARD.spot[0] - 1.6, 0.35, BOARD.spot[1] - 1.25); box(0.14, 0.7, 0.14, black, BOARD.spot[0] + 1.6, 0.35, BOARD.spot[1] - 1.25);

  // Cartel colgante «TU EQUIPO»
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 0.7), new THREE.MeshBasicMaterial({ map: textTex("TU EQUIPO", { w: 1024, h: 150, bg: "#0b0f17", color: "#ffffff", font: `600 92px ${FONT}`, accent: accentCss }), toneMapped: false, side: THREE.DoubleSide }));
  sign.position.set(0, 5.8, TEAM_Z - 1.4); scene.add(sign);
  for (const s of [-1, 1]) box(0.02, h - 6.2, 0.02, black, s * 2.1, 5.8 + (h - 6.2) / 2, TEAM_Z - 1.4);

  // Barra de café (pared izquierda) y agua + lounge (pared derecha)
  box(0.9, 1.05, 4.2, black, -40.6, 0.52, -11.9); box(1.0, 0.07, 4.4, marble, -40.6, 1.08, -11.9);
  const machine = box(0.5, 0.62, 0.62, chrome, -40.8, 1.43, -12.6); box(0.5, 0.62, 0.62, chrome, -40.8, 1.43, -11.2);
  const ledDot = new THREE.Mesh(new THREE.SphereGeometry(0.03, 10, 8), new THREE.MeshStandardMaterial({ color: 0x22ff99, emissive: 0x22ff99, emissiveIntensity: 2 })); ledDot.position.set(-40.5, 1.62, -12.3); scene.add(ledDot);
  const cooler = new THREE.Group(); cooler.position.set(40.6, 0, -12.4); scene.add(cooler);
  box(0.5, 1.1, 0.45, white, 0, 0.55, 0, cooler);
  cyl(0.2, 0.2, 0.55, new THREE.MeshStandardMaterial({ color: 0x7cc6ff, transparent: true, opacity: .55, roughness: .02, envMap: env }), 0, 1.38, 0, cooler);
  const sofa = new THREE.Group(); sofa.position.set(38.9, 0, -5.55); sofa.rotation.y = -Math.PI / 2; scene.add(sofa);
  box(3, 0.42, 1, cream, 0, 0.21, 0, sofa); box(3, 0.55, 0.26, cream, 0, 0.62, -0.4, sofa);
  // Olivos en macetero
  const tree = (x, z, s = 1) => {
    cyl(0.42 * s, 0.34 * s, 0.7 * s, white, x, 0.35 * s, z, scene, 28);
    cyl(0.05 * s, 0.07 * s, 1.1 * s, wood, x, 1.1 * s, z, scene, 8);
    for (let i = 0; i < 4; i++) { const l = new THREE.Mesh(new THREE.IcosahedronGeometry(0.45 * s, 1), leaf); l.position.set(x + rand(-0.35, 0.35) * s, (1.7 + rand(0, 0.5)) * s, z + rand(-0.35, 0.35) * s); scene.add(l); }
  };
  for (const [x, z] of [[-39.5, -31.5], [39.5, -31.5], [-39.5, -16.5], [39.5, -16.5], [-39.5, 31.5], [39.5, 31.5], [-13, -31.6], [13, -31.6]]) tree(x, z, 1.25);
  // Mesas altas de reunión al fondo (los equipos se reúnen aquí)
  for (const [x, z] of HUDDLES) { cyl(1.25, 1.25, 0.06, marble, x, 1.08, z, scene, 40); cyl(0.08, 0.3, 1.05, black, x, 0.53, z); }
  // Puerta principal (fondo)
  box(4, 3.4, 0.2, M(0x1a1d22, { metalness: .6, roughness: .3 }), DOOR[0], 1.7, z1 - 0.1);
  box(4.4, 0.18, 0.3, gold, DOOR[0], 3.5, z1 - 0.15);

  let kbT = 0;
  return {
    led, tape,
    tick(now, dt = 0.016) {
      tape.tex.offset.x = (tape.tex.offset.x + dt * 0.012) % 1;
      ledDot.material.emissiveIntensity = 1.2 + Math.sin(now * 3) * .8;
      kbT += dt; if (kbT > 2.2) { kbT = 0; kb.tick(); }
    },
    ceil, box, cyl, M, wood, white, black, gold, marble, cream, chrome, machine,
  };
}

/** Puesto de trader de tu equipo: mesa de nogal, 3 pantallas (la central es la del agente) y silla. */
function makeDesk(scene, kit, x, z, centerMat, sideTex) {
  const { box, cyl, black, gold } = kit;
  const g = new THREE.Group(); g.position.set(x, 0, z); scene.add(g);
  const top = kit.M(0x3a281b, { roughness: .35 });
  box(2.35, 0.06, 1.05, top, 0, 0.76, -0.85, g, true);
  box(2.35, 0.72, 0.05, black, 0, 0.38, -1.33, g);
  for (const s of [-1, 1]) box(0.05, 0.74, 0.95, black, s * 1.12, 0.37, -0.85, g);
  box(2.35, 0.02, 0.04, gold, 0, 0.79, -0.33, g);
  const screens = [];
  for (const [dx, ry, w] of [[-0.78, 0.38, 0.62], [0, 0, 0.92], [0.78, -0.38, 0.62]]) {
    const mon = new THREE.Group(); mon.position.set(dx, 1.3, -1.12 + Math.abs(dx) * 0.16); mon.rotation.y = ry; g.add(mon);
    box(w + 0.05, w * 0.6 + 0.05, 0.03, black, 0, 0, -0.02, mon);
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(w, w * 0.6), dx === 0 ? centerMat : new THREE.MeshBasicMaterial({ map: sideTex, toneMapped: false }));
    scr.position.z = 0.0; mon.add(scr); screens.push(scr);
  }
  box(0.06, 0.4, 0.06, black, 0, 0.96, -1.16, g);
  box(0.6, 0.02, 0.2, kit.M(0x2a2e35), 0, 0.8, -0.55, g);
  const chair = new THREE.Group(); chair.position.set(0, 0, 0); g.add(chair);
  const leather = kit.M(0x111111, { roughness: .55 });
  box(0.58, 0.08, 0.54, leather, 0, 0.47, 0, chair); box(0.58, 0.75, 0.07, leather, 0, 0.9, 0.29, chair);
  cyl(0.025, 0.025, 0.42, kit.chrome, 0, 0.23, 0, chair, 8); cyl(0.3, 0.3, 0.03, kit.chrome, 0, 0.03, 0, chair, 5);
  return { g, screen: screens[1], screens, seat: [x, z], lane: [x, TEAM_LANE_Z] };
}

/** Mesa de proyecto con pantalla holográfica. */
function makeStation(scene, kit, x, z, project, live) {
  const g = new THREE.Group(); g.position.set(x, 0, z); scene.add(g);
  const color = HEX[project.color] || HEX.azul;
  kit.cyl(1.25, 1.25, 0.07, kit.marble, 0, 1.05, 0, g, 48);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(1.25, 0.025, 8, 64), kit.gold); rim.rotation.x = Math.PI / 2; rim.position.y = 1.05; g.add(rim);
  kit.cyl(0.1, 0.38, 1.03, kit.black, 0, 0.52, 0, g);
  const holoMat = new THREE.MeshBasicMaterial({ map: textTex(project.name.length > 16 ? project.name.slice(0, 15) + "…" : project.name, { w: 640, h: 300, bg: "rgba(10,18,32,.86)", color: "#ffffff", font: `600 72px ${FONT}`, sub: project.sub || "proyecto", accent: "#" + color.toString(16).padStart(6, "0") }), transparent: true, opacity: .96, side: THREE.DoubleSide });
  const holo = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 1.08), holoMat);
  holo.position.set(0, 2.35, 0); g.add(holo);
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.24, 1, 16, 1, true), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .35, side: THREE.DoubleSide }));
  beam.position.y = 1.6; g.add(beam);
  const ring = new THREE.Mesh(new THREE.RingGeometry(1.6, 1.78, 48), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: live ? .8 : .18, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03; g.add(ring);
  const light = new THREE.PointLight(color, live ? 6 : 0, 7); light.position.y = 2.2; g.add(light);
  // Puestos de pie alrededor (por delante: mirando a la mesa)
  const spots = Array.from({ length: 8 }, (_, i) => { const a = Math.PI / 2 + (i - 3.5) * 0.36; return [x + Math.cos(a) * 1.85, z + Math.sin(a) * 1.85]; });
  g.traverse((o) => { if (o.isMesh) o.userData.stationId = project.id; });
  return { g, holo, ring, light, spots, lane: [x, WALK_Z], color, live };
}

// ------------------------------------------------------------------ todo el catálogo en el parqué
function crowdLayout(n) {
  const slots = [];
  for (let r = 0; r < ROWS && slots.length < n; r++) for (let k = 0; k < SEATS_HALF && slots.length < n; k++) for (const s of [-1, 1]) {
    if (slots.length >= n) break;
    const x = s * (2.4 + k * SEAT_DX), z = ROW_Z0 + r * ROW_DZ;
    slots.push({ x, z, seat: [x, z], lane: [x, z + 1.4] });
  }
  return slots;
}

function makeCrowd(scene, agents, codeTex, chartTex, accentCss) {
  const N = Math.min(agents.length, CROWD_CAP);
  agents = agents.slice(0, N);
  const slots = crowdLayout(N);
  const geoBox = new THREE.BoxGeometry(1, 1, 1);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), sc = new THREE.Vector3(), E = new THREE.Euler();
  const inst = (mat, f, count = N) => {
    const mesh = new THREE.InstancedMesh(geoBox, mat, count);
    slots.forEach((s, i) => { const [x, y, z, sx, sy, sz, ry = 0] = f(s); mesh.setMatrixAt(i, m4.compose(v.set(x, y, z), q.setFromEuler(E.set(0, ry, 0)), sc.set(sx, sy, sz))); });
    mesh.receiveShadow = true; scene.add(mesh); return mesh;
  };
  // Trading desks: nogal oscuro, faldón negro, 2 pantallas por puesto (código + velas)
  inst(new THREE.MeshStandardMaterial({ color: 0x3a281b, roughness: .35 }), (s) => [s.x, 0.76, s.z - 0.85, SEAT_DX - 0.05, 0.06, 1.0]);
  inst(new THREE.MeshStandardMaterial({ color: 0x111317, roughness: .4, metalness: .4 }), (s) => [s.x, 0.38, s.z - 1.33, SEAT_DX - 0.05, 0.72, 0.05]);
  const frame = new THREE.MeshStandardMaterial({ color: 0x0b0c0f, roughness: .3, metalness: .5 });
  inst(frame, (s) => [s.x - 0.38, 1.28, s.z - 1.1, 0.74, 0.46, 0.03, 0.25]);
  inst(frame, (s) => [s.x + 0.38, 1.28, s.z - 1.1, 0.74, 0.46, 0.03, -0.25]);
  const scrA = inst(new THREE.MeshBasicMaterial({ map: codeTex, toneMapped: false }), (s) => [s.x - 0.38, 1.28, s.z - 1.08, 0.7, 0.42, 0.005, 0.25]);
  const scrB = inst(new THREE.MeshBasicMaterial({ map: chartTex, toneMapped: false }), (s) => [s.x + 0.38, 1.28, s.z - 1.08, 0.7, 0.42, 0.005, -0.25]);
  inst(new THREE.MeshStandardMaterial({ color: 0x111111, roughness: .6 }), (s) => [s.x, 0.85, s.z + 0.3, 0.55, 0.7, 0.07]); // respaldo silla

  // Robots instanciados (ligeros)
  const mk = (geo, mat) => { const m = new THREE.InstancedMesh(geo, mat, N); m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(m); return m; };
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
    return { i, agent: a, slot: s, pos: [...s.seat], face: Math.PI, rot: Math.PI, state: "sit", path: [], table: null, phase: rand(0, TAU), speed: rand(1.9, 2.4) };
  });
  for (const k of ["torso", "armL", "armR", "eyes"]) parts[k].instanceColor.needsUpdate = true;

  // Reuniones al fondo (6-8 agentes) y, si Kairo usa a alguien de verdad, a Kairo Core.
  const tables = HUDDLES.map(([x, z], ti) => ({
    id: ti, x, z, real: false, members: [], busy: false, until: 0,
    seats: Array.from({ length: 8 }, (_, k) => { const a = (k / 8) * TAU; return { spot: [x + Math.cos(a) * 1.75, z + Math.sin(a) * 1.75], face: Math.atan2(-Math.cos(a), -Math.sin(a)) }; }),
    lane: [x, z - 2.4],
  }));
  const core = { id: "core", x: KAIRO_CORE[0], z: KAIRO_CORE[1], real: true, members: [], until: Infinity, lane: [KAIRO_CORE[0], WALK_Z],
    seats: Array.from({ length: 12 }, (_, k) => { const a = Math.PI / 2 + (k - 5.5) * 0.26; const r = 2.9 + (k % 2) * 0.8; return { spot: [KAIRO_CORE[0] + Math.cos(a) * r, KAIRO_CORE[1] + Math.sin(a) * r], face: Math.atan2(-Math.cos(a), -Math.sin(a)) }; }) };
  // Ruta: pasillo de su fila → pasillo central → destino
  const route = (b, t, seat, home) => {
    const s = b.slot;
    const go = [s.lane, [0, s.lane[1]], [0, t.lane[1]], t.lane, seat.spot];
    return home ? [t.lane, [0, t.lane[1]], [0, s.lane[1]], s.lane, s.seat] : go;
  };
  const sendTo = (b, t) => {
    const seat = t.seats.find((x) => !x.b);
    if (!seat) return false;
    seat.b = b; b.table = t; b.seat = seat;
    b.path = route(b, t, seat, false); b.state = "walk"; b.going = "table";
    t.members.push(b);
    return true;
  };
  const sendHome = (b) => {
    const t = b.table;
    if (b.seat) b.seat.b = null;
    if (t) t.members = t.members.filter((x) => x !== b);
    b.path = [b.seat?.spot || b.pos, ...route(b, t, b.seat, true)];
    b.table = null; b.seat = null; b.state = "walk"; b.going = "desk";
  };

  const base = new THREE.Matrix4(), tmp = new THREE.Matrix4(), local = new THREE.Matrix4();
  const P = new THREE.Vector3(), Q = new THREE.Quaternion(), SC = new THREE.Vector3(), ONE = new THREE.Vector3(1, 1, 1), AX = new THREE.Vector3(1, 0, 0), AY = new THREE.Vector3(0, 1, 0);
  const put = (mesh, i, x, y, z, q, sx = 1, sy = 1, sz = 1) => { local.compose(P.set(x, y, z), q, sx === 1 && sy === 1 && sz === 1 ? ONE : SC.set(sx, sy, sz)); tmp.multiplyMatrices(base, local); mesh.setMatrixAt(i, tmp); };
  const QI = new THREE.Quaternion(), QY = new THREE.Quaternion();
  const limb = (mesh, i, px, py, ang, len) => { const L = len / 2 + 0.07; Q.setFromAxisAngle(AX, ang); put(mesh, i, px, py - L * Math.cos(ang), -L * Math.sin(ang), Q); };
  let nextDispatch = 3, realIds = new Set();

  return {
    count: N,
    ids: new Set(agents.map((a) => a.id)),
    idOf: (i) => agents[i]?.id,
    pick: [parts.torso, parts.head],
    screens: [scrA, scrB],
    setReal(ids) { realIds = ids; },
    tables: [...tables, core],
    tick(now, dt) {
      if (now > nextDispatch) {
        nextDispatch = now + rand(7, 13);
        const free = tables.filter((t) => !t.members.length);
        if (free.length) {
          const t = free[Math.floor(Math.random() * free.length)];
          const size = 5 + Math.floor(Math.random() * 4);
          const idle = bots.filter((b) => b.state === "sit" && !realIds.has(b.agent.id)).sort((a, b) => Math.hypot(a.pos[0] - t.x, a.pos[1] - t.z) - Math.hypot(b.pos[0] - t.x, b.pos[1] - t.z)).slice(0, size * 3);
          idle.sort(() => Math.random() - .5).slice(0, size).forEach((b) => sendTo(b, t));
          t.until = Infinity; t.started = false;
        }
      }
      // Agentes que Kairo está usando de verdad: se levantan y van a Kairo Core.
      for (const b of bots) if (realIds.has(b.agent.id) && b.state === "sit") sendTo(b, core);
      for (const b of core.members) if (!realIds.has(b.agent.id) && b.state === "work") sendHome(b);
      for (const t of tables) {
        if (!t.started && t.members.length && t.members.every((b) => b.state === "work")) { t.started = true; t.until = now + rand(22, 40); }
        if (now > t.until && t.members.length) [...t.members].forEach((b) => { if (b.state === "work") sendHome(b); });
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
        base.makeRotationY(b.rot).setPosition(b.pos[0], 0, b.pos[1]);
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

// ------------------------------------------------------------------ rutas de tu equipo
/** Por el pasillo de origen → pasillo central (x=0) → pasillo de destino → destino. */
function route(from, to) {
  const pts = [];
  const push = (p) => { const last = pts[pts.length - 1]; if (!last || Math.hypot(last[0] - p[0], last[1] - p[1]) > 0.05) pts.push(p); };
  const a = from.lane || from.spot, b = to.lane || to.spot;
  push(a);
  if (Math.abs(a[1] - b[1]) > 0.3) {
    // Cambiar de pasillo: por el central, o por el lateral si ambos extremos están en un lado
    const side = Math.sign(a[0]) === Math.sign(b[0]) && Math.abs(a[0]) > 30 && Math.abs(b[0]) > 30 ? Math.sign(a[0]) * 36.6 : 0;
    push([side, a[1]]); push([side, b[1]]);
  }
  push(b);
  push(to.spot);
  return pts;
}

// ------------------------------------------------------------------ montaje
export const CAPACITY = CROWD_CAP;

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
  renderer.toneMappingExposure = 1.05;
  container.append(renderer.domElement);
  const overlay = document.createElement("div");
  overlay.className = "of-overlay";
  container.append(overlay);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x07090d);
  scene.fog = new THREE.Fog(0x07090d, 70, 150);
  // Reflejos: entorno cálido de interior (para el mármol y el oro)
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), new THREE.MeshBasicMaterial({ side: THREE.BackSide, map: canvasTex(256, 256, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, "#fff3dc"); gr.addColorStop(0.45, "#3a4253"); gr.addColorStop(1, "#0b0d12"); g.fillStyle = gr; g.fillRect(0, 0, w, h);
  }) })));
  const env = pmrem.fromScene(envScene, 0.04).texture;
  pmrem.dispose();

  const cam = new THREE.PerspectiveCamera(40, 1, 0.5, 400);
  const HOME = { x: 0, y: 0, z: -14, angle: Math.PI / 2 - 0.28, pitch: 0.48, zoom: 1.45 };
  const view = { target: new THREE.Vector3(HOME.x, HOME.y, HOME.z), zoom: HOME.zoom, angle: HOME.angle, pitch: HOME.pitch };
  const dist = () => 52 / view.zoom;
  const placeCam = () => {
    const w = container.clientWidth || 800, h = container.clientHeight || 600;
    const d = dist();
    cam.aspect = w / h;
    cam.position.set(view.target.x + Math.cos(view.angle) * Math.cos(view.pitch) * d, view.target.y + Math.sin(view.pitch) * d, view.target.z + Math.sin(view.angle) * Math.cos(view.pitch) * d);
    cam.lookAt(view.target);
    cam.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    // Desde fuera (por encima del techo) se quita el techo para ver dentro.
    kit.ceil.visible = cam.position.y < HALL.h - 0.3 && Math.abs(cam.position.x) < HALL.x1 && Math.abs(cam.position.z) < HALL.z1;
  };

  scene.add(new THREE.HemisphereLight(0xfff4e6, 0x20242c, 1.25));
  const sun = new THREE.DirectionalLight(0xfff1dc, 1.6);
  sun.position.set(-14, 34, -4); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -42, right: 42, top: 22, bottom: -34, near: 1, far: 90 });
  sun.target.position.set(0, 0, -14); scene.add(sun.target);
  sun.shadow.bias = -0.0004; sun.shadow.radius = 3;
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x9fb8ff, 0.5); fill.position.set(20, 18, 26); scene.add(fill);

  const kit = tradingFloor(scene, accent, accentCss, env);
  let crowd = null;
  const code = codeScreen(accentCss);
  const chart = chartScreen(accentCss);

  const desks = new Map();     // agentId → desk (tu equipo)
  const screens = new Map();   // agentId → pantalla real
  const bots = new Map();      // agentId → robot detallado
  const stations = new Map();  // projectId|"kairo" → mesa
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
    const off = v3.z > 1 || v3.x < -1.2 || v3.x > 1.2 || v3.y < -1.2 || v3.y > 1.2;
    el.style.visibility = off ? "hidden" : "";
    el.style.transform = `translate(-50%, -100%) translate(${((v3.x + 1) / 2) * w}px, ${((1 - v3.y) / 2) * h}px)`;
  };

  // ---------------------------------------------------------- construir
  function build(state) {
    for (const st of stations.values()) scene.remove(st.g);
    stations.clear();
    state.projects.slice(0, STATIONS.length).forEach((p, i) => stations.set(p.id, makeStation(scene, kit, STATIONS[i][0], STATIONS[i][1], p, p.live)));
    stations.set("kairo", makeStation(scene, kit, KAIRO_CORE[0], KAIRO_CORE[1], { id: "kairo", name: "Kairo Core", color: "morado", sub: "orquestador" }, false));
    for (const [id, st] of stations) st.g.userData.key = id;
    const wanted = new Set(state.agents.map((a) => a.id));
    for (const [id, d] of desks) if (!wanted.has(id)) { scene.remove(d.g); desks.delete(id); }
    for (const [id, b] of bots) if (!wanted.has(id) && !b.visitor) { scene.remove(b.g); bots.delete(id); tags.get("b" + id)?.remove(); tags.delete("b" + id); }
    state.agents.slice(0, TEAM_X.length).forEach((a, i) => {
      const x = TEAM_X[i], z = TEAM_Z;
      let d = desks.get(a.id);
      if (!d || d.g.position.x !== x) {
        if (d) scene.remove(d.g);
        if (!screens.has(a.id)) screens.set(a.id, agentScreen(a, accentCss));
        d = makeDesk(scene, kit, x, z, new THREE.MeshBasicMaterial({ map: screens.get(a.id).tex, toneMapped: false }), chart.tex);
        d.screens.forEach((s) => { s.userData.screenOf = a.id; });
        desks.set(a.id, d);
      }
      let b = bots.get(a.id);
      if (!b) {
        const g = makeBot(a);
        scene.add(g);
        b = { id: a.id, agent: a, g, p: g.userData.parts, pos: [d.seat[0], d.seat[1]], lane: d.lane, face: Math.PI, state: "sit", path: [], speed: rand(1.9, 2.3), nextBreak: performance.now() / 1000 + rand(30, 150), phase: rand(0, TAU), work: null };
        g.position.set(d.seat[0], 0, d.seat[1]);
        bots.set(a.id, b);
      }
      b.visitor = false; b.agent = a; b.desk = d;
    });
    clickables.length = 0;
    scene.traverse((o) => { if (o.isMesh && (o.userData.botId || o.userData.stationId || o.userData.screenOf)) clickables.push(o); });
  }

  // ---------------------------------------------------------- comportamiento de tu equipo
  const goTo = (b, target, then) => {
    b.path = route({ spot: b.pos, lane: b.lane }, target);
    b.lane = target.lane; b.state = "walk"; b.then = then;
    b.p.cup.visible = false;
  };
  const deskTarget = (b) => (b.desk ? { spot: b.desk.seat, lane: b.desk.lane } : { spot: DOOR, lane: [0, 30] });
  const stationSpot = (b, key) => {
    const st = stations.get(key) || stations.get("kairo");
    if (!stations.has(key)) b.work = "kairo";
    const users = [...bots.values()].filter((x) => x.work === key && x !== b);
    return { spot: st.spots[users.length % st.spots.length], lane: st.lane, st };
  };
  const breakBusy = new Set();

  function think(b, now) {
    if (b.state === "walk") return;
    const want = b.wantWork;
    if (want != null && b.work !== want && b.state !== "pickup") {
      if (b.breakSpot) { breakBusy.delete(b.breakSpot); b.breakSpot = null; }
      b.work = want;
      b.label = "📋 coge la tarea";
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
      if (b.visitor) { b.label = "👋 hasta luego"; goTo(b, { spot: DOOR, lane: [0, 30] }, () => { b.gone = true; }); return; }
      b.label = "↩ a su puesto";
      goTo(b, deskTarget(b), () => { b.state = "sit"; b.face = Math.PI; b.label = null; });
      return;
    }
    if (b.state === "pickup" && now > b.until) { b.state = "idle"; b.onDone?.(); return; }
    if (b.state === "break" && now > b.until) {
      breakBusy.delete(b.breakSpot); b.breakSpot = null; b.p.cup.visible = false; b.label = null;
      goTo(b, deskTarget(b), () => { b.state = "sit"; b.face = Math.PI; });
      b.nextBreak = now + rand(45, 110);
      return;
    }
    if (b.state === "sit" && !b.visitor && now > b.nextBreak && !reduce && !b.live) {
      const free = BREAKS.filter((x) => !breakBusy.has(x));
      // Como mucho 2 de descanso a la vez: el parqué nunca se queda vacío.
      if (!free.length || breakBusy.size >= 2) { b.nextBreak = now + rand(15, 40); return; }
      const spot = free[Math.floor(Math.random() * free.length)];
      breakBusy.add(spot); b.breakSpot = spot; b.label = spot.label;
      goTo(b, spot, () => { b.state = "break"; b.until = now + rand(6, 11); b.face = spot.face; if (spot.cup) b.p.cup.visible = true; });
    }
  }

  function animate(b, dt, now) {
    const { hips, armL, armR, legL, legR, head, ring, eyes, cup } = b.p;
    let moving = false;
    if (b.state === "walk" && b.path.length) {
      const [tx, tz] = b.path[0];
      const dx = tx - b.pos[0], dz = tz - b.pos[1];
      const d = Math.hypot(dx, dz), step = b.speed * dt;
      if (d <= step) { b.pos = [tx, tz]; b.path.shift(); if (!b.path.length) { b.state = "idle"; const f = b.then; b.then = null; f?.(); } }
      else { b.pos = [b.pos[0] + (dx / d) * step, b.pos[1] + (dz / d) * step]; b.face = Math.atan2(dx, dz); moving = true; }
    }
    let da = b.face - b.g.rotation.y; da = Math.atan2(Math.sin(da), Math.cos(da));
    b.g.rotation.y += da * Math.min(1, dt * 10);
    b.g.position.set(b.pos[0], 0, b.pos[1]);
    const t = now + b.phase;
    const sitting = b.state === "sit" || (b.state === "break" && b.breakSpot?.sit);
    const lerp = (o, k, v) => { o.rotation[k] += (v - o.rotation[k]) * Math.min(1, dt * 12); };
    if (moving) {
      const s = Math.sin(t * 9);
      lerp(legL, "x", s * 0.7); lerp(legR, "x", -s * 0.7); lerp(armL, "x", -s * 0.6); lerp(armR, "x", b.p.card.visible ? -1.1 : s * 0.6);
      hips.position.y = 0.62 + Math.abs(Math.cos(t * 9)) * 0.05; head.rotation.y = 0;
    } else if (sitting) {
      hips.position.y += (0.18 - hips.position.y) * Math.min(1, dt * 8);
      lerp(legL, "x", -1.45); lerp(legR, "x", -1.45);
      const typing = b.state === "sit";
      const fast = b.live ? 1.6 : 1;   // si su tarea es real, teclea más rápido
      lerp(armL, "x", typing ? -1.15 + Math.sin(t * 14 * fast) * 0.08 : -0.2); lerp(armR, "x", typing ? -1.15 + Math.cos(t * 13 * fast) * 0.08 : -0.2);
      head.rotation.x = typing ? 0.12 + Math.sin(t * 0.7) * 0.05 : -0.05;
      head.rotation.y = typing ? Math.sin(t * 0.4) * 0.15 : Math.sin(t * 0.5) * 0.4;
    } else {
      hips.position.y += (0.62 - hips.position.y) * Math.min(1, dt * 8);
      lerp(legL, "x", 0); lerp(legR, "x", 0);
      if (b.state === "work") {
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
    const active = b.work != null || b.live;
    ring.material.opacity += ((active ? 0.85 : 0) - ring.material.opacity) * Math.min(1, dt * 5);
    ring.scale.setScalar(1 + (active ? Math.sin(now * 5) * 0.06 : 0));
    eyes.emissiveIntensity = active ? 2.2 + Math.sin(now * 8) * 0.6 : 1.4;
  }

  // ---------------------------------------------------------- interacción: arrastrar, zoom, tocar
  const pointers = new Map();
  let drag = null, pinch = null, hoverKey = null;
  const el = renderer.domElement;
  el.style.touchAction = "none";
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  const pickAt = (e) => {
    const r = el.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, cam);
    const hit = ray.intersectObjects(crowd ? [...clickables, ...crowd.pick, ...crowd.screens] : clickables, false)[0];
    if (!hit) return null;
    if (crowd?.screens.includes(hit.object) && hit.instanceId != null) return { kind: "computer", id: crowd.idOf(hit.instanceId) };
    if (crowd?.pick.includes(hit.object) && hit.instanceId != null) return { kind: "bot", id: crowd.idOf(hit.instanceId) };
    if (hit.object.userData.screenOf) return { kind: "computer", id: hit.object.userData.screenOf };
    if (hit.object.userData.botId) return { kind: "bot", id: hit.object.userData.botId };
    if (hit.object.userData.stationId != null && hit.object.userData.stationId !== "kairo") return { kind: "station", id: hit.object.userData.stationId };
    return null;
  };
  el.addEventListener("pointerdown", (e) => {
    el.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.size === 1) drag = { x: e.clientX, y: e.clientY, moved: false, t: view.target.clone(), a: view.angle, p: view.pitch, rotate: e.button === 2 || e.shiftKey };
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), z: view.zoom }; drag = null; }
  });
  el.addEventListener("contextmenu", (e) => e.preventDefault());
  el.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) {
      // Cursor de mano sobre lo que se puede tocar (solo ratón)
      if (e.pointerType === "mouse") { const h = pickAt(e); const k = h ? h.kind : null; if (k !== hoverKey) { hoverKey = k; el.style.cursor = k ? "pointer" : "grab"; } }
      return;
    }
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      view.zoom = Math.min(4, Math.max(0.35, pinch.z * Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch.d)); placeCam(); return;
    }
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.hypot(dx, dy) > 5) drag.moved = true;
    if (!drag.moved) return;
    if (drag.rotate) { view.angle = drag.a + dx * 0.006; view.pitch = Math.min(1.35, Math.max(0.18, drag.p + dy * 0.004)); placeCam(); return; }
    const k = (2 * dist() * Math.tan((cam.fov * Math.PI) / 360)) / container.clientHeight;
    const right = new THREE.Vector3(-Math.sin(view.angle), 0, Math.cos(view.angle));
    const fwd = new THREE.Vector3(-Math.cos(view.angle), 0, -Math.sin(view.angle));
    view.target.copy(drag.t).addScaledVector(right, -dx * k).addScaledVector(fwd, dy * k * 1.6);
    view.target.x = Math.max(-38, Math.min(38, view.target.x)); view.target.z = Math.max(-30, Math.min(30, view.target.z));
    placeCam();
  });
  el.addEventListener("pointerup", (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (drag && !drag.moved) {
      const h = pickAt(e);
      if (h?.kind === "computer") api.onComputer?.(h.id, e);
      else if (h?.kind === "bot") api.onBot(h.id, e);
      else if (h?.kind === "station") api.onStation(h.id, e);
      else api.onEmpty?.();
    }
    drag = null;
  });
  el.addEventListener("wheel", (e) => { e.preventDefault(); view.zoom = Math.min(4, Math.max(0.35, view.zoom * (e.deltaY < 0 ? 1.1 : 0.9))); placeCam(); }, { passive: false });
  const ro = new ResizeObserver(() => placeCam());
  ro.observe(container);

  // Vuelo suave de cámara (para «ir a» un agente)
  let fly = null;
  const flyTo = (x, z, zoom = 2.4) => { const side = container.clientWidth > 760 ? 2.2 : 0; fly = { from: view.target.clone(), z0: view.zoom, p0: view.pitch, a0: view.angle, to: new THREE.Vector3(x + side, 0.9, z), z1: zoom, t: 0 }; };

  // ---------------------------------------------------------- bucle
  let alive = true, last = performance.now(), codeT = 0, chartT = 0, blinkT = 0;
  const loop = (ms) => {
    if (!alive) return;
    if (!container.isConnected) { destroy(); return; }
    const now = (ms / 1000) * SPEED, dt = Math.min(0.05, (ms - last) / 1000) * SPEED; last = ms;
    if (fly) {
      fly.t = Math.min(1, fly.t + dt / 0.9);
      const k = 1 - Math.pow(1 - fly.t, 3);
      view.target.lerpVectors(fly.from, fly.to, k); view.zoom = fly.z0 + (fly.z1 - fly.z0) * k; view.pitch = fly.p0 + (0.42 - fly.p0) * k; view.angle = fly.a0 + (Math.PI / 2 - 0.18 - fly.a0) * k; placeCam();
      if (fly.t >= 1) fly = null;
    }
    kit.tick(now, dt); crowd?.tick(now, dt);
    codeT += dt; if (codeT > 0.2) { codeT = 0; code.tick(); }
    chartT += dt; if (chartT > 1.4) { chartT = 0; chart.tick(); }
    blinkT += dt; if (blinkT > 0.55) { blinkT = 0; for (const s of screens.values()) s.tick(); }
    for (const b of bots.values()) { think(b, now); animate(b, dt, now); }
    for (const [id, b] of bots) if (b.gone) { scene.remove(b.g); bots.delete(id); tags.get("b" + id)?.remove(); tags.delete("b" + id); }
    for (const st of stations.values()) {
      st.holo.position.y = 2.35 + Math.sin(now * 1.5 + st.g.position.x) * 0.05;
      st.holo.lookAt(cam.position.x, st.holo.getWorldPosition(v3).y, cam.position.z);
      const busy = [...bots.values()].some((b) => b.work === st.g.userData.key && b.state === "work");
      st.ring.material.opacity += (((st.live || busy) ? 0.75 + Math.sin(now * 4) * 0.2 : 0.16) - st.ring.material.opacity) * Math.min(1, dt * 4);
      st.light.intensity += (((st.live || busy) ? 6 : 0) - st.light.intensity) * Math.min(1, dt * 3);
    }
    // Etiquetas
    for (const b of bots.values()) {
      const tag = tagFor("b" + b.id, "of-tag");
      const status = b.label || (b.live ? "● en vivo" : "");
      const key = b.agent.name + "|" + status;
      if (tag.dataset.h !== key) {
        tag.replaceChildren();
        const n = document.createElement("b"); n.textContent = b.agent.name; n.style.setProperty("--c", hexCss(b.agent.color)); tag.append(n);
        if (status) { const s = document.createElement("span"); s.textContent = status; tag.append(s); }
        tag.dataset.h = key;
      }
      tag.classList.toggle("active", b.work != null || !!b.live);
      place(tag, b.pos[0], b.state === "sit" ? 1.95 : 2.5, b.pos[1]);
    }
    for (const [id, st] of stations) {
      const tag = tagFor("s" + id, "of-station");
      const n = [...bots.values()].filter((b) => b.work === id && b.state === "work").length + (id === "kairo" && crowd ? crowd.tables.find((t) => t.id === "core").members.filter((b) => b.state === "work").length : 0);
      const txt = `${st.live || n ? "● LIVE" : ""}${n ? ` · ${n} trabajando` : ""}`;
      if (tag.textContent !== txt) tag.textContent = txt;
      tag.hidden = !txt;
      place(tag, st.g.position.x, 3.3, st.g.position.z);
    }
    if (crowd) for (const t of crowd.tables) if (t.id !== "core") {
      const tag = tagFor("t" + t.id, "of-station team");
      const n = t.members.filter((b) => b.state === "work").length;
      const txt = n ? `Reunión · ${n} agentes` : "";
      if (tag.textContent !== txt) tag.textContent = txt;
      tag.hidden = !txt;
      if (txt) place(tag, t.x, 3.2, t.z);
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
    capacity: CROWD_CAP,
    /** Estado vivo: qué quiere hacer cada robot de tu equipo y qué agentes usa Kairo ahora. */
    setWork(map, visitors = []) {
      for (const b of bots.values()) b.wantWork = map.get(b.id) ?? null;
      crowd?.setReal(new Set(visitors.filter((v) => crowd.ids.has(v.agent.id)).map((v) => v.agent.id)));
      // Los que no están en el parqué entran por la puerta como visitantes.
      for (const v of visitors) if (!crowd?.ids.has(v.agent.id) && !bots.has(v.agent.id)) {
        const g = makeBot(v.agent); scene.add(g);
        const b = { id: v.agent.id, agent: v.agent, g, p: g.userData.parts, pos: [...DOOR], lane: [0, 30], face: Math.PI, state: "idle", path: [], speed: 2.1, nextBreak: Infinity, phase: rand(0, TAU), work: null, visitor: true };
        bots.set(v.agent.id, b); scene.traverse((o) => { if (o.isMesh && o.userData.botId === v.agent.id) clickables.push(o); });
      }
      const visiting = new Map(visitors.map((v) => [v.agent.id, v.work]));
      for (const b of bots.values()) if (b.visitor) b.wantWork = visiting.get(b.id) ?? null;
    },
    /** Lo que muestra la pantalla central de cada puesto (datos reales del servidor). */
    setScreens(map) {
      for (const [id, s] of screens) { const d = map.get(id) || null; s.set(d); const b = bots.get(id); if (b) b.live = !!d?.live; }
    },
    /** KPIs del videowall y cinta del teletipo. */
    setBoard({ kpis = [], ticker = [] }) { kit.led.set(kpis); kit.tape.set(ticker); },
    setCrowd(agents) {
      if (crowd || !agents.length) return;
      crowd = makeCrowd(scene, agents, code.tex, chart.tex, accentCss);
    },
    setLive(ids) { for (const [id, st] of stations) st.live = ids.has(id); },
    /** Lleva la cámara hasta un agente (tu equipo o el parqué). */
    focus(id) {
      const b = bots.get(id);
      if (b) return flyTo(b.pos[0], b.pos[1] - 1.1, 4.4);
      if (crowd) { const i = [...crowd.ids].indexOf(id); if (i >= 0) { const s = crowdLayout(i + 1)[i]; flyTo(s.x, s.z - 1.1, 4.4); } }
    },
    zoom(k) { view.zoom = Math.min(4, Math.max(0.35, view.zoom * k)); placeCam(); },
    rotate() { view.angle += Math.PI / 2; placeCam(); },
    reset() { fly = null; view.target.set(HOME.x, HOME.y, HOME.z); view.zoom = container.clientWidth < 700 ? 0.8 : HOME.zoom; view.angle = HOME.angle; view.pitch = HOME.pitch; placeCam(); },
    destroy,
    start() { placeCam(); if (container.clientWidth < 700) { view.zoom = 0.8; placeCam(); } el.style.cursor = "grab"; requestAnimationFrame(loop); },
  };
}
