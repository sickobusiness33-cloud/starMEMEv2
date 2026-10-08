// Comprobación de licencias de fuentes open source (Update Checker).
//
// Solo descarga el ARCHIVO DE LICENCIA desde raw.githubusercontent.com: nunca
// descarga ni ejecuta código. Clasifica en:
//   compatible   → MIT / Apache-2.0 / BSD / ISC / CC0 / Unlicense sin cláusulas extra
//   restricted   → copyleft (GPL/AGPL/LGPL/MPL) o cláusulas adicionales (marca, EE, multi-tenant…)
//   incompatible → no comercial, Commons Clause, PolyForm, Sustainable Use, BUSL, Elastic
//   unverifiable → no se encontró el archivo de licencia

export type LicenseStatus = "compatible" | "restricted" | "incompatible" | "unverifiable";

export function classifyLicense(text: string): { license: string; status: LicenseStatus; flags: string[] } {
  const t = text.toLowerCase();
  const flags: string[] = [];
  const has = (s: string) => t.includes(s);
  if (has("commons clause")) flags.push("Commons Clause");
  if (has("polyform")) flags.push("PolyForm");
  if (has("sustainable use")) flags.push("Sustainable Use");
  if (has("business source license")) flags.push("BUSL");
  if (has("elastic license")) flags.push("Elastic");
  if (/non-?commercial/.test(t) && !has("gnu")) flags.push("NonCommercial");
  if (has("additional conditions") || has("additional terms")) flags.push("condiciones adicionales");
  if (/(logo|branding|trademark)[^.]{0,120}(may not|must not|shall not|prohibited)/.test(t)) flags.push("restricción de marca");
  if (has("multi-tenant")) flags.push("restricción multi-tenant");
  if (has("enterprise edition") || /\bee\//.test(t)) flags.push("partes Enterprise");

  let license = "Desconocida";
  if (has("gnu affero")) license = "AGPL-3.0";
  else if (has("gnu lesser")) license = "LGPL";
  else if (has("gnu general public license")) license = "GPL";
  else if (has("mozilla public license")) license = "MPL-2.0";
  else if (/apache license[\s,]*version 2\.0/.test(t) || (has("apache license") && has("2.0"))) license = "Apache-2.0";
  else if (has("permission is hereby granted, free of charge")) license = "MIT";
  else if (has("permission to use, copy, modify, and/or distribute this software for any purpose")) license = "ISC";
  else if (has("redistribution and use in source and binary forms")) license = has("neither the name") ? "BSD-3-Clause" : "BSD-2-Clause";
  else if (has("attribution-noncommercial")) license = "CC-BY-NC";
  else if (has("cc0") || has("creative commons zero")) license = "CC0-1.0";
  else if (has("this is free and unencumbered software released into the public domain")) license = "Unlicense";
  else if (has("creative commons attribution")) license = "CC-BY";

  const hard = flags.some((f) => ["Commons Clause", "PolyForm", "Sustainable Use", "BUSL", "Elastic", "NonCommercial"].includes(f));
  let status: LicenseStatus;
  if (hard || license === "CC-BY-NC") status = "incompatible";
  else if (["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "CC0-1.0", "Unlicense"].includes(license)) {
    status = flags.length ? "restricted" : "compatible";
  } else if (license === "Desconocida") status = "unverifiable";
  else status = "restricted";
  return { license, status, flags };
}

const FILES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"];

/** Busca el archivo de licencia de un repo (máx. 4 peticiones, dentro del límite de subrequests). */
export async function checkRepoLicense(repo: string) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return { license: null, status: "unverifiable" as LicenseStatus, flags: ["nombre no válido"] };
  const attempts: [string, string][] = [["HEAD", "LICENSE"], ["HEAD", "LICENSE.md"], ["HEAD", "LICENSE.txt"], ["HEAD", "COPYING"]];
  for (const [ref, file] of attempts.slice(0, FILES.length)) {
    try {
      const r = await fetch(`https://raw.githubusercontent.com/${repo}/${ref}/${file}`, { signal: AbortSignal.timeout(10_000) });
      if (r.ok) {
        const text = (await r.text()).slice(0, 40_000);
        if (text.length > 40) return classifyLicense(text);
      }
    } catch {
      /* siguiente intento */
    }
  }
  return { license: null, status: "unverifiable" as LicenseStatus, flags: ["sin archivo de licencia en la rama principal"] };
}
