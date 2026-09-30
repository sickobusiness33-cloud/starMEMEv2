#!/usr/bin/env python3
"""Añade al catálogo los agentes listados en agent-directory (github.com/…/agent-directory).

Uso:  python3 scripts/import_agent_directory.py <carpeta agent-directory-main>
Escribe src/agents/catalog/directory.ts.

Ese repositorio NO declara licencia, así que NO se copia ningún texto suyo: solo se toma el
NOMBRE de cada agente (un título genérico, p. ej. «Meal Planner») y su sector. Descripción e
instrucciones las genera Kairo (plantillas propias por sector). Se descartan duplicados entre
listas y contra los agentes que ya existen en el catálogo.
"""
import json, re, sys, unicodedata
from pathlib import Path

SRC = Path(sys.argv[1])
CAT_DIR = Path(__file__).resolve().parent.parent / "src/agents/catalog"
OUT = CAT_DIR / "directory.ts"

def slug(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")

STOP = {"ai", "agent", "agents", "the", "a", "an", "of", "for", "and", "powered", "driven", "based", "smart", "automated", "intelligent", "system"}
def key(name):
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"\(.*?\)", " ", s).replace("&", " and ").replace("/", " ")
    words = [w for w in re.split(r"[^a-z0-9]+", s) if w and w not in STOP]
    words = [w[:-1] if len(w) > 3 and w.endswith("s") and not w.endswith("ss") else w for w in words]
    return " ".join(sorted(words))

def clean(name):
    name = re.sub(r"\(.*?\)", "", name).replace('"', '').strip(" :*.-")
    name = re.sub(r"^(AI[- ](Powered|Driven)|AI)\s+", "", name, flags=re.I)
    name = re.sub(r"\s+(AI\s+)?(Agent|AI)$", "", name, flags=re.I).strip()
    return re.sub(r"\s{2,}", " ", name)[:60]

# Nombres existentes (manifiestos del catálogo actual) para no duplicar
existing_ids, existing_keys = set(), set()
for p in CAT_DIR.glob("*.ts"):
    if p.name == "directory.ts":
        continue
    t = p.read_text(encoding="utf-8")
    existing_ids |= set(re.findall(r'"?id"?:\s*"([a-z0-9-]+)"', t))
    existing_keys |= {key(n) for n in re.findall(r'"?name"?:\s*"([^"]{3,80})"', t)}

# ------------------------------------------------------------ sectores → categoría Kairo
SEC_1000 = {
    "Personal AI Agents": "personal", "Professional AI Agents": "productivity", "Enterprise AI Agents": "business",
    "Government AI Agents": "public", "Healthcare": "health", "Pharmaceutical": "health", "Biotechnology": "health",
    "Financial Services": "finance", "Insurance Industry": "finance", "Education": "education",
    "Media & Entertainment": "video", "Technology Sector": "coding", "Sports & Recreation": "sports",
    "Digital Marketing": "marketing", "Cybersecurity": "security", "Research & Development": "research",
    "Smart Cities": "public", "Non-Profit": "public", "Gaming Industry": "game", "Retail": "sales", "E-commerce": "sales",
    "Professional Services": "business", "Hospitality": "business", "Fashion & Apparel": "design",
}
INDUSTRY = {"Manufacturing", "Energy", "Transportation & Logistics", "Construction & Real Estate", "Agriculture", "Telecommunications",
            "Automotive", "Aerospace & Defense", "Chemical Industry", "Mining & Resources", "Environmental Services", "Consumer Goods",
            "Food & Beverage", "Utilities", "Public Transportation"}
SEC_500 = {  # (sección romana, subsección) → categoría
    "Health & Wellness": "health", "Productivity & Learning": "productivity", "Security & Privacy": "security", "Financial": "finance",
    "Office & Administration": "productivity", "Sales & Marketing": "marketing", "Customer Service": "support",
    "Finance & Accounting": "finance", "Human Resources": "business", "Legal": "legal", "Healthcare": "health",
    "Education": "education", "Manufacturing": "industry", "Real Estate": "industry", "Information Technology": "coding",
}
MAIN_500 = {"Personal": "personal", "Professional": "productivity", "Enterprise": "business", "Government": "public"}

found = []  # (name, category, sector)
def add(raw, cat, sector):
    n = clean(raw)
    if len(n) >= 4:
        found.append((n, cat, sector))

# 1000AGENTS.md
sec = None
for line in (SRC / "1000AGENTS.md").read_text(encoding="utf-8").splitlines():
    m = re.match(r"^#{2,3}\s+(.+)$", line)
    if m:
        sec = m.group(1).strip()
        continue
    m = re.match(r"^\d+\.\s+(.+)$", line)
    if m and sec:
        add(m.group(1), "industry" if sec in INDUSTRY else SEC_1000.get(sec, "specialized"), sec.replace(" AI Agents", ""))

# 500AGENT.md
main = sub = None
for line in (SRC / "500AGENT.md").read_text(encoding="utf-8").splitlines():
    m = re.match(r"^\*\*[IVX]+\.\s+(\w+)", line)
    if m:
        main, sub = m.group(1), None
        continue
    m = re.match(r"^\*\*[A-Z]\.\s+(.+?)\*\*", line)
    if m:
        sub = m.group(1).strip()
        continue
    m = re.match(r"^\d+\.\s+\*\*(.+?):?\*\*", line)
    if m and main:
        add(m.group(1), SEC_500.get(sub or "", MAIN_500.get(main, "specialized")), sub or main)

# Motorsport
for f in ("MOTORSPORTS.md", "FAN_ENGAGEMENT.md"):
    for m in re.finditer(r"^\* \*\*\d+\.\s+(.+?):?\*\*", (SRC / "docs/motorsports" / f).read_text(encoding="utf-8"), re.M):
        add(m.group(1), "sports", "Motorsport")

# PERSONAL.md (títulos de agentes)
for m in re.finditer(r"^#### [\d.]+\s+(.+)$", (SRC / "docs/PERSONAL.md").read_text(encoding="utf-8"), re.M):
    n = m.group(1)
    add(n, "health" if re.search(r"health|sleep|diet|nutrition", n, re.I) else "personal", "Personal")

# Un mismo nombre en varios sectores (p. ej. «Market Analysis») → un solo agente multisector
sectors_by_key = {}
for name, cat, sector in found:
    sectors_by_key.setdefault(key(name), set()).add(cat)
found = [(n, c, s) if len(sectors_by_key[key(n)]) == 1 else (n, "business", "Multisector") for n, c, s in found]

agents, seen_keys, seen_ids = [], set(existing_keys), set(existing_ids)
dup_existing = dup_internal = 0
for name, cat, sector in found:
    k = key(name)
    if not k:
        continue
    if k in seen_keys:
        if k in existing_keys:
            dup_existing += 1
        else:
            dup_internal += 1
        continue
    seen_keys.add(k)
    base = "ad-" + slug(name)[:50]
    aid, i = base, 2
    while aid in seen_ids:
        aid, i = f"{base}-{i}", i + 1
    seen_ids.add(aid)
    agents.append([aid, name, cat, sector])

OUT.write_text(
    "// GENERADO por scripts/import_agent_directory.py — no editar a mano.\n"
    "// Nombres de agentes tomados de la lista «agent-directory» (sin licencia declarada: solo se usan\n"
    "// los títulos genéricos; descripción e instrucciones son plantillas propias de Kairo).\n"
    'import { buildDirectoryAgents, type DirEntry } from "./_directory";\n\n'
    f"const entries: DirEntry[] = {json.dumps(agents, ensure_ascii=False)};\n\n"
    "export default buildDirectoryAgents(entries);\n",
    encoding="utf-8")
print(f"{len(found)} nombres leídos · {dup_existing} ya existían en el catálogo · {dup_internal} repetidos entre listas · {len(agents)} agentes nuevos → {OUT}")
from collections import Counter
print(Counter(a[2] for a in agents).most_common())
