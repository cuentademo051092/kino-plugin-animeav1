// Plugin de Kino para animeav1.com
// v0.8.0: prioriza HLS (.m3u8) para mejorar compatibilidad con Android TV.
// v0.9.0 — DUB Latino Only
// Solo acepta fuentes asociadas al bloque DUB. Nunca hace fallback a SUB.
// Dentro de DUB: HLS primero, MP4Upload como respaldo.

function decodeUrl(s) {
  return s
    .replace(/\\u0026/g, "&")
    .replace(/\\u003F/g, "?")
    .replace(/\\u002F/g, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&");
}

function nearestDubBefore(text, idx) {
  let best = -1;
  const re = /"DUB"\s*:/g;
  for (const m of text.matchAll(re)) {
    if (m.index <= idx && m.index > best) best = m.index;
  }
  return best;
}

function findDubHls(text) {
  const re = /https?:\/\/[^"\\\s]+?\.m3u8(?:\?[^"\\\s]*)?/gi;
  const urls = [];

  for (const m of text.matchAll(re)) {
    if (nearestDubBefore(text, m.index) !== -1) {
      urls.push(decodeUrl(m[0]));
    }
  }

  return [...new Set(urls)];
}

function findDubMp4Upload(text) {
  const re = /"MP4Upload"\s*,\s*"(https:\/\/(?:www\.)?mp4upload\.com\/embed-[a-zA-Z0-9]+\.html)"/g;
  const urls = [];

  for (const m of text.matchAll(re)) {
    if (nearestDubBefore(text, m.index) !== -1) {
      urls.push(m[1]);
    }
  }

  return [...new Set(urls)];
}

// Resuelve SOLO DUB. Si DUB no está disponible, falla;
// jamás cambia silenciosamente a SUB.
export async function resolve(ref) {
  const r = await kino.fetch(`${BASE}/media/${ref}/__data.json`);

  if (!r.ok) {
    throw new Error(
      "animeav1: error cargando episodio (HTTP " + r.status + ")"
    );
  }

  const text = await r.text();

  // 1. DUB HLS — preferido para Android TV.
  const hls = findDubHls(text);

  if (hls.length > 0) {
    return {
      url: hls[0],
      mime: "application/vnd.apple.mpegurl",
      headers: {
        Referer: `${BASE}/media/${ref}`
      }
    };
  }

  // 2. DUB MP4Upload — fallback, pero únicamente DUB.
  const embeds = findDubMp4Upload(text);

  for (const embedUrl of embeds) {
    try {
      const embedRes = await kino.fetch(embedUrl);
      if (!embedRes.ok) continue;

      const embedHtml = await embedRes.text();

      const srcMatch = embedHtml.match(
        /type:\s*"video\/mp4",\s*src:\s*"([^"]+)"/
      );

      if (!srcMatch) continue;

      return {
        url: decodeUrl(srcMatch[1]),
        mime: "video/mp4",
        headers: {
          Referer: embedUrl
        }
      };
    } catch (_) {
      // Intenta otro servidor DUB, sin pasar nunca a SUB.
    }
  }

  throw new Error(
    "animeav1: no hay una fuente DUB disponible para este episodio"
  );
}
