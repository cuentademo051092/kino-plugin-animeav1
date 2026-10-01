// Plugin de Kino para animeav1.com
// v1.0.0 — DUB Latino Only
//
// Regla de idioma: SOLO se lee embeds.DUB. embeds.SUB nunca participa.
// Fuentes soportadas directamente por este plugin:
//   1) HLS (.m3u8) dentro de DUB
//   2) MP4Upload dentro de DUB
// Si DUB existe pero ninguna de esas fuentes se puede resolver, se informa
// que no hay una fuente DUB resoluble. Nunca se cambia silenciosamente a SUB.

const BASE = "https://animeav1.com";
const CDN = "https://cdn.animeav1.com";

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeUrl(s) {
  return s
    .replace(/\\u0026/gi, "&")
    .replace(/\\u003F/gi, "?")
    .replace(/\\u003D/gi, "=")
    .replace(/\\u002F/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/gi, "&");
}

// Busca un valor JSON balanceado a partir de una posición. Ignora llaves/
// corchetes que estén dentro de strings.
function balancedValue(text, start) {
  const first = text[start];
  if (first !== "{" && first !== "[") return null;

  const open = first;
  const close = first === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}

function findEmbedsObject(text) {
  const keys = [
    /"embeds"\s*:/i,
    /embeds\s*:/i,
  ];

  for (const keyRe of keys) {
    const m = keyRe.exec(text);
    if (!m) continue;

    let i = m.index + m[0].length;
    while (i < text.length && /\s/.test(text[i])) i++;

    const raw = balancedValue(text, i);
    if (!raw) continue;

    try {
      return JSON.parse(raw);
    } catch (_) {
      // Algunos payloads pueden llevar escapes adicionales; seguimos con
      // extracción de arrays DUB más abajo.
    }
  }

  return null;
}

function findDubArray(text) {
  const keyRe = /"DUB"\s*:\s*/i;
  const m = keyRe.exec(text);
  if (!m) return null;

  let i = m.index + m[0].length;
  while (i < text.length && /\s/.test(text[i])) i++;

  const raw = balancedValue(text, i);
  if (!raw || raw[0] !== "[") return null;

  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function normalizeSources(text) {
  const embeds = findEmbedsObject(text);
  if (embeds && Array.isArray(embeds.DUB)) return embeds.DUB;

  const dub = findDubArray(text);
  if (Array.isArray(dub)) return dub;

  return [];
}

function sourceServer(source) {
  return String(source?.server || source?.name || "").trim().toLowerCase();
}

function sourceUrl(source) {
  const value = source?.url || source?.link || source?.src;
  return typeof value === "string" ? decodeUrl(value) : null;
}

function isHls(url) {
  return typeof url === "string" && /\.m3u8(?:$|[?#])/i.test(url);
}

function isMp4Upload(server, url) {
  return server.includes("mp4upload") || /mp4upload\.com/i.test(url || "");
}

// Busca animes por nombre.
export async function search(query) {
  const q = encodeURIComponent(query.q.trim()).replace(/%20/g, "+");
  const r = await kino.fetch(`${BASE}/catalogo/__data.json?search=${q}`);
  if (!r.ok) throw new Error("animeav1: error buscando (HTTP " + r.status + ")");
  const text = await r.text();

  const re = /"id":\d+,"title":\d+,"synopsis":\d+,"categoryId":\d+,"slug":\d+,"category":\d+\},"(\d+)","((?:\\.|[^"\\])*)","(?:\\.|[^"\\])*",(?:\d+,)?"([^"]+)"/g;
  const results = [];
  const seen = new Set();

  for (const m of text.matchAll(re)) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    results.push({
      id,
      ref: m[3],
      title: m[2],
      kind: "series",
      poster: `${CDN}/covers/${id}.jpg`,
      backdrop: `${CDN}/backdrops/${id}.jpg`,
    });
  }

  return results;
}

// Lista episodios a partir del slug.
export async function episodes(ref) {
  const r = await kino.fetch(`${BASE}/media/${ref}`);
  if (!r.ok) throw new Error("animeav1: error cargando episodios (HTTP " + r.status + ")");
  const html = await r.text();

  const re = new RegExp("/media/" + escapeRegExp(ref) + "/(\\d+)", "g");
  const nums = [...html.matchAll(re)].map((m) => Number(m[1]));
  const unique = [...new Set(nums)].sort((a, b) => a - b);

  if (unique.length === 0) throw new Error("animeav1: no se encontraron episodios");

  const idMatch = html.match(/cdn\.animeav1\.com\/backdrops\/(\d+)\.jpg/);
  const mediaId = idMatch ? idMatch[1] : null;
  const result = {
    episodes: unique.map((n) => ({
      season: 1,
      number: n,
      ref: `${ref}/${n}`,
      still: mediaId ? `${CDN}/screenshots/${mediaId}/${n}.jpg` : undefined,
    })),
  };

  if (mediaId) {
    result.series = {
      poster: `${CDN}/covers/${mediaId}.jpg`,
      backdrop: `${CDN}/backdrops/${mediaId}.jpg`,
    };
  }

  return result;
}

// Resuelve SOLO DUB. SUB jamás se consulta como fallback.
export async function resolve(ref) {
  const r = await kino.fetch(`${BASE}/media/${ref}/__data.json`);
  if (!r.ok) throw new Error("animeav1: error cargando episodio (HTTP " + r.status + ")");
  const text = await r.text();

  const dubSources = normalizeSources(text);
  if (!dubSources.length) {
    throw new Error("animeav1: no hay una fuente DUB disponible para este episodio");
  }

  // 1. HLS DUB: preferido para Android TV.
  for (const source of dubSources) {
    const url = sourceUrl(source);
    if (!url || !isHls(url)) continue;

    return {
      url,
      mime: "application/x-mpegURL",
      headers: { Referer: `${BASE}/media/${ref}` },
    };
  }

  // 2. MP4Upload DUB: fallback.
  for (const source of dubSources) {
    const url = sourceUrl(source);
    const server = sourceServer(source);
    if (!url || !isMp4Upload(server, url)) continue;

    try {
      const embedRes = await kino.fetch(url);
      if (!embedRes.ok) continue;

      const embedHtml = await embedRes.text();
      const srcMatch = embedHtml.match(
        /type:\s*["']video\/mp4["']\s*,\s*src:\s*["']([^"']+)["']/i
      );

      if (!srcMatch) continue;

      return {
        url: decodeUrl(srcMatch[1]),
        mime: "video/mp4",
        headers: { Referer: url },
      };
    } catch (_) {
      // Prueba el siguiente servidor DUB, sin tocar SUB.
    }
  }

  throw new Error(
    "animeav1: hay DUB, pero ninguna fuente DUB compatible pudo resolverse"
  );
}
