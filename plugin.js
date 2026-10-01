// AnimeAV1 para Kino
// v1.0.0 - DUB Latino Only
//
// Cambio principal:
// - Ya NO determina DUB/SUB por proximidad de texto.
// - Lee directamente la estructura embeds.DUB del HTML de AnimeAV1.
// - SUB queda completamente fuera del resolver.
// - Si existe DUB pero un servidor falla, intenta el siguiente servidor DUB.
//
// Basado en la estructura pública documentada de AnimeAV1:
// embeds: { SUB: [{server,url}], DUB: [{server,url}] }

const BASE = "https://animeav1.com";
const CDN = "https://cdn.animeav1.com";

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeHtmlAndEscapes(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&#x2F;/gi, "/")
    .replace(/\\u0026/gi, "&")
    .replace(/\\u003F/gi, "?")
    .replace(/\\u003D/gi, "=")
    .replace(/\\u002F/gi, "/")
    .replace(/\\\//g, "/");
}

// Extrae un objeto/array JSON desde una posición, respetando strings y escapes.
function balancedJson(text, start, openChar, closeChar) {
  if (text[start] !== openChar) return null;

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

    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}

// Busca la clave JSON indicada y devuelve su valor como objeto/array.
// Se prueban varias apariciones porque Nuxt puede incluir datos serializados
// más de una vez en el HTML.
function extractJsonValue(text, key, openChar, closeChar) {
  const patterns = [
    new RegExp('"' + escapeRegExp(key) + '"\\s*:\\s*', "g"),
    new RegExp("\\\\\"" + escapeRegExp(key) + "\\\\\"\\s*:\\s*", "g"),
  ];

  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      let pos = m.index + m[0].length;
      while (pos < text.length && /\s/.test(text[pos])) pos++;

      if (text[pos] !== openChar) continue;

      const raw = balancedJson(text, pos, openChar, closeChar);
      if (!raw) continue;

      const attempts = [
        raw,
        decodeHtmlAndEscapes(raw),
        raw.replace(/\\"/g, '"').replace(/\\\\/g, "\\"),
      ];

      for (const candidate of attempts) {
        try {
          return JSON.parse(candidate);
        } catch (_) {}
      }
    }
  }

  return null;
}

function normalizeSources(list) {
  if (!Array.isArray(list)) return [];

  const out = [];
  const seen = new Set();

  for (const item of list) {
    if (!item || typeof item !== "object") continue;

    const server = String(item.server ?? item.name ?? "").trim();
    const url = decodeHtmlAndEscapes(String(item.url ?? "").trim());

    if (!url || !/^https?:\/\//i.test(url)) continue;

    const key = server.toLowerCase() + "|" + url;
    if (seen.has(key)) continue;

    seen.add(key);
    out.push({
      server: server || "Servidor",
      url,
    });
  }

  return out;
}

function getDubSources(html) {
  const embeds = extractJsonValue(html, "embeds", "{", "}");

  if (!embeds || typeof embeds !== "object") {
    return {
      found: false,
      sources: [],
    };
  }

  return {
    found: Array.isArray(embeds.DUB),
    sources: normalizeSources(embeds.DUB),
  };
}

function isMp4Upload(url, server) {
  return /mp4upload/i.test(server) || /mp4upload\.com/i.test(url);
}

function isHls(url, server) {
  return /hls/i.test(server) || /\.m3u8(?:[?#]|$)/i.test(url);
}

// Orden pensado para Kino/Android TV:
// HLS suele ser más natural para reproducción adaptativa;
// MP4Upload queda como fallback directo.
function rankSources(sources) {
  return [...sources].sort((a, b) => {
    const score = (x) => {
      if (isHls(x.url, x.server)) return 0;
      if (isMp4Upload(x.url, x.server)) return 1;
      return 2;
    };
    return score(a) - score(b);
  });
}

async function resolveHls(source, episodePage) {
  return {
    url: source.url,
    mime: "application/x-mpegURL",
    headers: { Referer: episodePage },
  };
}

async function resolveMp4Upload(source) {
  const embedRes = await kino.fetch(source.url);
  if (!embedRes.ok) {
    throw new Error("HTTP " + embedRes.status);
  }

  const embedHtml = await embedRes.text();

  const patterns = [
    /type:\s*"video\/mp4"\s*,\s*src:\s*"([^"]+)"/i,
    /src:\s*"([^"]+)"\s*,\s*type:\s*"video\/mp4"/i,
    /file:\s*"([^"]+\.mp4[^"]*)"/i,
  ];

  for (const re of patterns) {
    const m = embedHtml.match(re);
    if (m && m[1]) {
      return {
        url: decodeHtmlAndEscapes(m[1]),
        mime: "video/mp4",
        headers: { Referer: source.url },
      };
    }
  }

  throw new Error("no se encontró el video MP4");
}

async function resolveGeneric(source, episodePage) {
  // Algunas instalaciones de AnimeAV1 pueden devolver directamente un HLS
  // aunque el nombre del servidor no contenga "HLS".
  if (/\.m3u8(?:[?#]|$)/i.test(source.url)) {
    return resolveHls(source, episodePage);
  }

  // MP4Upload necesita abrir su página embed para obtener el MP4 final.
  if (isMp4Upload(source.url, source.server)) {
    return resolveMp4Upload(source);
  }

  // Para otros servidores DUB, si AnimeAV1 ya entrega una URL reproducible,
  // se la pasa a Kino sin tocar SUB.
  return {
    url: source.url,
    mime: "video/mp4",
    headers: { Referer: episodePage },
  };
}

// Busca animes por nombre.
export async function search(query) {
  const q = encodeURIComponent(query.q.trim()).replace(/%20/g, "+");
  const r = await kino.fetch(`${BASE}/catalogo/__data.json?search=${q}`);

  if (!r.ok) {
    throw new Error("animeav1: error buscando (HTTP " + r.status + ")");
  }

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

export async function episodes(ref) {
  const r = await kino.fetch(`${BASE}/media/${ref}`);

  if (!r.ok) {
    throw new Error("animeav1: error cargando episodios (HTTP " + r.status + ")");
  }

  const html = await r.text();

  const re = new RegExp("/media/" + escapeRegExp(ref) + "/(\\d+)", "g");
  const nums = [...html.matchAll(re)].map((m) => Number(m[1]));
  const unique = [...new Set(nums)].sort((a, b) => a - b);

  if (unique.length === 0) {
    throw new Error("animeav1: no se encontraron episodios");
  }

  const idMatch = html.match(/cdn\.animeav1\.com\/backdrops\/(\d+)\.jpg/);
  const mediaId = idMatch ? idMatch[1] : null;

  const result = {
    episodes: unique.map((n) => ({
      season: 1,
      number: n,
      ref: `${ref}/${n}`,
      still: mediaId
        ? `${CDN}/screenshots/${mediaId}/${n}.jpg`
        : undefined,
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

export async function resolve(ref) {
  const episodePage = `${BASE}/media/${ref}`;

  // IMPORTANTE:
  // Se consulta la página HTML inicial porque AnimeAV1 expone allí
  // embeds:{SUB:[...],DUB:[...]}.
  const r = await kino.fetch(episodePage);

  if (!r.ok) {
    throw new Error(
      "animeav1: error cargando episodio (HTTP " + r.status + ")"
    );
  }

  const html = await r.text();
  const dub = getDubSources(html);

  if (!dub.found) {
    throw new Error(
      "animeav1: no hay una fuente DUB disponible para este episodio"
    );
  }

  if (dub.sources.length === 0) {
    throw new Error(
      "animeav1: DUB existe, pero no contiene servidores de video"
    );
  }

  const sources = rankSources(dub.sources);
  const errors = [];

  for (const source of sources) {
    try {
      return await resolveGeneric(source, episodePage);
    } catch (e) {
      errors.push(`${source.server}: ${e?.message || "falló"}`);
    }
  }

  throw new Error(
    "animeav1: DUB encontrado, pero ninguna fuente pudo resolverse (" +
      errors.join("; ") +
      ")"
  );
}
