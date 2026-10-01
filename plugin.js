// Plugin de Kino para animeav1.com
// v0.8.0: prioriza HLS (.m3u8) para mejorar compatibilidad con Android TV.
// Fallback: MP4Upload. La selección DUB/SUB se hace por cercanía al enlace.

const BASE = "https://animeav1.com";
const CDN = "https://cdn.animeav1.com";

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeUrl(s) {
  try {
    return s
      .replace(/\\u0026/g, "&")
      .replace(/\\u003F/gi, "?")
      .replace(/\\u003D/gi, "=")
      .replace(/\\\//g, "/")
      .replace(/&amp;/g, "&");
  } catch (_) {
    return s;
  }
}

// Busca la etiqueta de idioma más cercana que aparezca antes del enlace.
// Limitamos la ventana para no asociar accidentalmente un DUB/SUB lejano.
function languageBefore(text, index) {
  const windowStart = Math.max(0, index - 2500);
  const before = text.slice(windowStart, index);
  const matches = [...before.matchAll(/"?(DUB|SUB)"?\s*:/gi)];
  if (!matches.length) return null;
  return matches[matches.length - 1][1].toUpperCase();
}

function collectHls(text) {
  const out = [];
  const seen = new Set();
  // Captura URLs m3u8 aunque estén escapadas dentro del __data.json.
  const re = /https?:\\?\/?\\?\/?[^"'\\s<>]+?\.m3u8(?:\?[^"'\\s<>\\]*)?/gi;
  for (const m of text.matchAll(re)) {
    const url = decodeUrl(m[0]);
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, index: m.index, lang: languageBefore(text, m.index) });
  }
  return out;
}

function collectMp4Upload(text) {
  const out = [];
  const seen = new Set();
  const re = /"MP4Upload"\s*[,\:]\s*"(https:\/\/(?:www\.)?mp4upload\.com\/embed-[a-zA-Z0-9]+\.html)"/gi;
  for (const m of text.matchAll(re)) {
    const url = m[1];
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, index: m.index, lang: languageBefore(text, m.index) });
  }
  return out;
}

function chooseCandidate(candidates) {
  if (!candidates.length) return null;
  // Prioridad: DUB > SUB > sin etiqueta; dentro de cada grupo, primera fuente.
  return candidates.find(c => c.lang === "DUB")
    || candidates.find(c => c.lang === "SUB")
    || candidates[0];
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

// Resuelve primero HLS. Si no existe, usa MP4Upload.
// Esto evita depender de un único codec/container cuando el dispositivo es un Android TV.
export async function resolve(ref) {
  const r = await kino.fetch(`${BASE}/media/${ref}/__data.json`);

  if (!r.ok) {
    throw new Error(
      "animeav1: error cargando episodio (HTTP " + r.status + ")"
    );
  }

  const text = await r.text();

  // DUB ONLY:
  // Separa DUB/SUB por proximidad y jamás permite usar una fuente SUB.
  function nearestLanguage(index) {
    const matches = [];
    const re = /"?(DUB|SUB)"?\s*:/gi;

    for (const m of text.matchAll(re)) {
      matches.push({
        lang: m[1].toUpperCase(),
        index: m.index
      });
    }

    if (!matches.length) return null;

    let best = null;
    let distance = Infinity;

    for (const item of matches) {
      const d = Math.abs(item.index - index);
      if (d < distance) {
        distance = d;
        best = item.lang;
      }
    }

    return best;
  }

  function decodeUrl(url) {
    return url
      .replace(/\\u0026/g, "&")
      .replace(/\\u003F/g, "?")
      .replace(/\\u002F/g, "/")
      .replace(/\\\//g, "/")
      .replace(/&amp;/g, "&");
  }

  // Primero busca HLS perteneciente al bloque DUB.
  const hlsUrls = [];
  const hlsRe =
    /https?:\/\/[^"'\\\s<>]+?\.m3u8(?:\?[^"'\\\s<>]*)?/gi;

  for (const m of text.matchAll(hlsRe)) {
    const url = decodeUrl(m[0]);
    if (nearestLanguage(m.index) === "DUB" && !hlsUrls.includes(url)) {
      hlsUrls.push(url);
    }
  }

  if (hlsUrls.length) {
    return {
      url: hlsUrls[0],
      mime: "application/x-mpegURL",
      headers: {
        Referer: `${BASE}/media/${ref}`
      }
    };
  }

  // Después busca MP4Upload, pero SOLO si pertenece a DUB.
  const embeds = [];
  const mp4Re =
    /"MP4Upload"\s*[,:]\s*"(https:\/\/(?:www\.)?mp4upload\.com\/embed-[A-Za-z0-9]+\.html)"/gi;

  for (const m of text.matchAll(mp4Re)) {
    const url = m[1];

    if (nearestLanguage(m.index) === "DUB" && !embeds.includes(url)) {
      embeds.push(url);
    }
  }

  for (const embedUrl of embeds) {
    try {
      const embedRes = await kino.fetch(embedUrl);
      if (!embedRes.ok) continue;

      const html = await embedRes.text();
      const src = html.match(
        /type:\s*"video\/mp4",\s*src:\s*"([^"]+)"/
      );

      if (!src) continue;

      return {
        url: decodeUrl(src[1]),
        mime: "video/mp4",
        headers: {
          Referer: embedUrl
        }
      };
    } catch (_) {
      // Continúa con el siguiente servidor DUB.
    }
  }

  throw new Error(
    "animeav1: no hay una fuente DUB disponible para este episodio"
  );
}
