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
  if (!r.ok) throw new Error("animeav1: error cargando episodio (HTTP " + r.status + ")");
  const text = await r.text();

  const hls = chooseCandidate(collectHls(text));
  if (hls) {
    return {
      url: hls.url,
      mime: "application/x-mpegURL",
      headers: { Referer: `${BASE}/media/${ref}` },
    };
  }

  const mp4 = chooseCandidate(collectMp4Upload(text));
  if (!mp4) {
    throw new Error("animeav1: no se encontró una fuente HLS ni MP4Upload para este episodio");
  }

  const embedRes = await kino.fetch(mp4.url);
  if (!embedRes.ok) {
    throw new Error("mp4upload: error cargando el reproductor (HTTP " + embedRes.status + ")");
  }
  const embedHtml = await embedRes.text();
  const srcMatch = embedHtml.match(/type:\s*"video\/mp4",\s*src:\s*"([^"]+)"/);
  if (!srcMatch) throw new Error("mp4upload: no se pudo extraer el link del video");

  return {
    url: srcMatch[1],
    mime: "video/mp4",
    headers: { Referer: mp4.url },
  };
}
