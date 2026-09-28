// Estudio de imágenes: texto→imagen, imagen→imagen, inpainting, variaciones y
// upscaling a través del Model Router (routeImage). Las imágenes se guardan en
// D1 (base64) y se sirven desde /api/images/:id/file solo a su dueño.

import { Hono, type Context } from "hono";
import { requireUser } from "./auth";
import { b64ToBytes, bytesToB64 } from "./b64";
import { all, nowIso, one, run } from "./db";
import type { AppEnv, Env } from "./env";
import { fail, intIn, jsonBody, reqStr, str, toId } from "./http";
import { notify } from "./notify";
import { getSubscription, PLAN_LIMITS, usageToday, type PlanId } from "./plans";
import { hit } from "./ratelimit";
import { routeImage, RouterError, type CallContext } from "./ai/router";
import { MODELS, publicModel } from "./ai/models";

export const STYLES: Record<string, { label: string; suffix: string }> = {
  none: { label: "Sin estilo", suffix: "" },
  photo: { label: "Fotográfico", suffix: "photorealistic, 35mm photo, natural light, high detail" },
  cinematic: { label: "Cinematográfico", suffix: "cinematic still, dramatic lighting, shallow depth of field, color graded" },
  illustration: { label: "Ilustración", suffix: "digital illustration, clean lines, vibrant colors" },
  anime: { label: "Anime", suffix: "anime style, cel shading, detailed background" },
  render3d: { label: "Render 3D", suffix: "3D render, octane, soft studio lighting, high detail" },
  logo: { label: "Logo / plano", suffix: "flat vector logo, minimal, centered, white background" },
  watercolor: { label: "Acuarela", suffix: "watercolor painting, soft edges, paper texture" },
  pixel: { label: "Pixel art", suffix: "pixel art, 16-bit, crisp pixels" },
  neon: { label: "Neón futurista", suffix: "futuristic, neon glow, dark background, sleek" },
};

export const SIZES: [number, number][] = [
  [512, 512], [768, 768], [1024, 1024], [1024, 768], [768, 1024], [1280, 720], [720, 1280],
];

const MAX_UPLOAD_BYTES = 2_500_000;
const KEEP_UNSAVED = 40;

type Mode = "t2i" | "i2i" | "inpaint" | "variation" | "upscale";

export interface StoredImage {
  id: number;
  mode: string;
  prompt: string;
  model: string | null;
  width: number | null;
  height: number | null;
  mime: string;
  saved: number;
  created_at: string;
}

const META = "id, mode, prompt, negative, style, model, width, height, seed, parent_id, mime, size, saved, source, latency_ms, created_at";

export async function storeImage(
  env: Env,
  userId: number,
  i: { mode: string; prompt?: string; negative?: string; style?: string | null; model?: string | null; width?: number; height?: number; seed?: number | null; parentId?: number | null; mime: string; bytes: Uint8Array; source: string; latencyMs?: number },
) {
  const id = await run(
    env.DB,
    "INSERT INTO images (user_id, mode, prompt, negative, style, model, width, height, seed, parent_id, mime, data_b64, size, source, latency_ms, created_at)" +
      " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    userId,
    i.mode,
    (i.prompt ?? "").slice(0, 2000),
    (i.negative ?? "").slice(0, 1000),
    i.style ?? null,
    i.model ?? null,
    i.width ?? null,
    i.height ?? null,
    i.seed ?? null,
    i.parentId ?? null,
    i.mime,
    bytesToB64(i.bytes),
    i.bytes.length,
    i.source,
    i.latencyMs ?? null,
    nowIso(),
  );
  // Las no guardadas se recortan a las últimas KEEP_UNSAVED para no llenar la base de datos.
  await run(
    env.DB,
    "DELETE FROM images WHERE user_id = ? AND saved = 0 AND id NOT IN (SELECT id FROM images WHERE user_id = ? AND saved = 0 ORDER BY id DESC LIMIT ?)",
    userId,
    userId,
    KEEP_UNSAVED,
  );
  return id;
}

export async function imageBytes(env: Env, userId: number, id: number) {
  const row = await one<any>(env.DB, "SELECT id, mime, data_b64, prompt, width, height FROM images WHERE id = ? AND user_id = ?", id, userId);
  if (!row) return null;
  return { ...row, bytes: b64ToBytes(row.data_b64) };
}

function dataUrlBytes(dataUrl: string, label: string): { bytes: Uint8Array; mime: string } {
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return fail(422, `«${label}» debe ser una imagen PNG, JPEG o WebP.`);
  const bytes = b64ToBytes(m[2]);
  if (bytes.length > MAX_UPLOAD_BYTES) return fail(413, `«${label}» supera 2,5 MB. Redúcela antes de subirla.`);
  return { bytes, mime: m[1] };
}

export interface GenerateInput {
  mode: Mode;
  prompt: string;
  negative?: string;
  style?: string;
  width: number;
  height: number;
  model?: string;
  seed?: number;
  strength?: number;
  sourceId?: number | null;
  mask?: Uint8Array;
}

/** Genera y guarda una imagen. Lo usan el estudio, el orquestador y los agentes. */
export async function createImage(env: Env, userId: number, plan: PlanId, input: GenerateInput, source: string, agentId?: string | null) {
  const style = STYLES[input.style ?? "none"] ?? STYLES.none;
  let parent: any = null;
  if (input.mode !== "t2i") {
    if (!input.sourceId) throw new RouterError("Esta operación necesita una imagen de partida.", "no_source");
    parent = await imageBytes(env, userId, input.sourceId);
    if (!parent) throw new RouterError("La imagen de partida no existe.", "no_source");
  }
  let width = input.width;
  let height = input.height;
  if (input.mode === "upscale") {
    width = Math.min(2048, (parent.width || 768) * 2);
    height = Math.min(2048, (parent.height || 768) * 2);
  }
  const prompt = [input.prompt || parent?.prompt || "", style.suffix].filter(Boolean).join(", ");
  const strength = input.strength ?? (input.mode === "upscale" ? 0.25 : input.mode === "variation" ? 0.55 : 0.65);
  const seed = input.seed ?? Math.floor(Math.random() * 2 ** 31);
  const ctx: CallContext = { env, userId, plan, kind: "image", agentId: agentId ?? null };
  const out = await routeImage(ctx, {
    mode: input.mode,
    prompt: prompt || "high quality image",
    negative: input.negative,
    width,
    height,
    seed,
    strength,
    image: parent?.bytes,
    mask: input.mask,
    model: input.model,
  });
  const id = await storeImage(env, userId, {
    mode: input.mode,
    prompt: input.prompt || parent?.prompt || "",
    negative: input.negative,
    style: input.style ?? null,
    model: out.model,
    width,
    height,
    seed,
    parentId: parent?.id ?? null,
    mime: out.mime,
    bytes: out.bytes,
    source,
    latencyMs: out.latencyMs,
  });
  return { id, model: out.model, fallback: out.fallback, notices: out.notices, latency_ms: out.latencyMs, mime: out.mime, bytes: out.bytes };
}

export const imageRoutes = new Hono<AppEnv>();
imageRoutes.use("*", requireUser);

imageRoutes.get("/models", async (c) => {
  const sub = await getSubscription(c.env.DB, c.get("user").id);
  return c.json({
    models: MODELS.filter((m) => m.kind === "image").map(publicModel),
    styles: Object.entries(STYLES).map(([id, s]) => ({ id, label: s.label })),
    sizes: SIZES.map(([w, h]) => ({ width: w, height: h })),
    limits: { per_day: PLAN_LIMITS[sub.plan].imagesPerDay, used_today: (await usageToday(c.env.DB, c.get("user").id)).images },
  });
});

imageRoutes.get("/", async (c) => {
  const saved = c.req.query("saved") === "1";
  const page = Math.max(0, Number(c.req.query("page") || 0) | 0);
  const rows = await all(
    c.env.DB,
    `SELECT ${META} FROM images WHERE user_id = ? AND mode <> 'upload' ${saved ? "AND saved = 1" : ""} ORDER BY id DESC LIMIT 24 OFFSET ?`,
    c.get("user").id,
    page * 24,
  );
  return c.json(rows);
});

async function own(c: Context<AppEnv>) {
  const row = await one<any>(c.env.DB, `SELECT ${META} FROM images WHERE id = ? AND user_id = ?`, toId(c.req.param("id")), c.get("user").id);
  if (!row) fail(404, "Imagen no encontrada.");
  return row;
}

imageRoutes.get("/:id", async (c) => c.json(await own(c)));

imageRoutes.get("/:id/file", async (c) => {
  const img = await imageBytes(c.env, c.get("user").id, toId(c.req.param("id")));
  if (!img) fail(404, "Imagen no encontrada.");
  return new Response(img!.bytes, {
    headers: {
      "Content-Type": img!.mime,
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Disposition": `inline; filename="kairo-${img!.id}.${img!.mime === "image/png" ? "png" : "jpg"}"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
});

imageRoutes.patch("/:id", async (c) => {
  const row = await own(c);
  const body = await jsonBody(c.req.raw);
  const saved = body.saved === true ? 1 : body.saved === false ? 0 : row.saved;
  await run(c.env.DB, "UPDATE images SET saved = ? WHERE id = ?", saved, row.id);
  return c.json({ ...row, saved });
});

imageRoutes.delete("/:id", async (c) => {
  const row = await own(c);
  await run(c.env.DB, "DELETE FROM images WHERE id = ?", row.id);
  return c.json({ ok: true });
});

imageRoutes.post("/upload", async (c) => {
  const user = c.get("user");
  const wait = await hit(c.env.DB, `imgup:${user.id}`, 20, 60);
  if (wait) fail(429, `Demasiadas subidas. Espera ${wait} s.`);
  const body = await jsonBody(c.req.raw);
  const { bytes, mime } = dataUrlBytes(reqStr(body, "data_url", { label: "Imagen", min: 20, max: 3_600_000 }), "Imagen");
  const width = intIn(body, "width", "Ancho", 1, 8192, 0) || null;
  const height = intIn(body, "height", "Alto", 1, 8192, 0) || null;
  const id = await storeImage(c.env, user.id, { mode: "upload", mime, bytes, width: width ?? undefined, height: height ?? undefined, source: "upload", prompt: str(body, "name", { label: "Nombre", max: 200, optional: true }) ?? "" });
  return c.json({ id, mime, size: bytes.length }, 201);
});

imageRoutes.post("/generate", async (c) => {
  const user = c.get("user");
  const body = await jsonBody(c.req.raw);
  const sub = await getSubscription(c.env.DB, user.id);
  const limits = PLAN_LIMITS[sub.plan];
  const mode = reqStr(body, "mode", { label: "Modo", min: 3, max: 10, pattern: /^(t2i|i2i|inpaint|variation|upscale)$/ }) as Mode;
  const prompt = str(body, "prompt", { label: "Prompt", max: 2000, optional: true }) ?? "";
  if (mode === "t2i" && prompt.length < 3) fail(422, "Describe la imagen que quieres (mínimo 3 caracteres).");
  const style = str(body, "style", { label: "Estilo", max: 20, optional: true }) ?? "none";
  if (!STYLES[style]) fail(422, "Estilo no válido.");
  const width = intIn(body, "width", "Ancho", 256, 2048, 1024);
  const height = intIn(body, "height", "Alto", 256, 2048, 1024);
  const model = str(body, "model", { label: "Modelo", max: 80, optional: true }) ?? "auto";
  const seed = body.seed === undefined || body.seed === null || body.seed === "" ? undefined : intIn(body, "seed", "Semilla", 0, 2 ** 31 - 1);
  const strength = body.strength === undefined ? undefined : Number(body.strength);
  if (strength !== undefined && !(strength >= 0.05 && strength <= 1)) fail(422, "La intensidad debe estar entre 0,05 y 1.");
  const sourceId = body.source_id ? Number(body.source_id) : null;
  const mask = typeof body.mask_data_url === "string" ? dataUrlBytes(body.mask_data_url, "Máscara").bytes : undefined;
  if (mode === "inpaint" && !mask) fail(422, "Pinta la zona a editar (máscara).");
  const used = await usageToday(c.env.DB, user.id);
  if (used.images >= limits.imagesPerDay) fail(429, `Has usado las ${limits.imagesPerDay} imágenes de hoy.${sub.plan === "free" ? " Pro amplía el límite." : ""}`);
  const wait = await hit(c.env.DB, `img:${user.id}`, 8, 60);
  if (wait) fail(429, `Demasiadas imágenes seguidas. Espera ${wait} s.`);
  try {
    const out = await createImage(c.env, user.id, sub.plan, { mode, prompt, negative: str(body, "negative", { label: "Negativo", max: 1000, optional: true }), style, width, height, model, seed, strength, sourceId, mask }, "studio");
    const row = await one(c.env.DB, `SELECT ${META} FROM images WHERE id = ?`, out.id);
    return c.json({ image: row, fallback: out.fallback, notices: out.notices }, 201);
  } catch (err) {
    if (err instanceof RouterError) {
      await notify(c.env, user.id, { category: "ia", priority: "normal", title: "No se pudo generar la imagen", body: err.message, link: "#/studio", dedupe: "image-failed" });
      fail(err.code === "no_source" || err.code === "bad_model" ? 422 : 502, err.message);
    }
    throw err;
  }
});
