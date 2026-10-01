// AnimeAV1 para Kino
// v1.0.2 - DUB Latino
// Fix: AnimeAV1 expone las fuentes en el HTML de /media/{slug}/{episode}
// como embeds:{SUB:[{server:"...",url:"..."}],DUB:[...]}.
// La versión anterior buscaba otra representación y terminaba en
// "no hay una fuente DUB disponible" aunque la web sí mostrara DUB.

const BASE = "https://animeav1.com";
const CDN = "https://cdn.animeav1.com";

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeEscapes(s) {
  return String(s)
    .replace(/\\\//g, "/")
    .replace(/\\u0026/gi, "&")
    .replace(/\\u003d/gi, "=")
    .replace(/\\u002f/gi, "/")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function extractEmbedsBlock(html) {
  const marker = "embeds:{";
  const start0 = html.indexOf(marker);
  if (start0 < 0) return null;

  const start = start0 + marker.length - 1; // posición de "{"
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < html.length; i++) {
    const ch = html[i];

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

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return html.slice(start + 1, i);
      }
    }
  }

  return null;
}

function extractLanguageSources(html, language) {
  const embeds = extractEmbedsBlock(html);
  if (!embeds) return [];

  const reBlock = new RegExp(
    language + ":\\[([^\\]]*)\\]"
  );
  const match = embeds.match(reBlock);
  if (!match) return [];

  const block = match[1];
  const entryRe = /\{server:"([^"]+)",url:"([^"]+)"\}/g;
  const out = [];

  for (const m of block.matchAll(entryRe)) {
    const server = m[1];
    const url = decodeEscapes(m[2]);
    if (url.startsWith("http")) {
      out.push({ server, url, language });
    }
  }

  // Fallback para pequeñas variaciones del HTML.
  if (out.length === 0) {
    const looseRe =
      /\{\s*server\s*:\s*["']([^"']+)["']\s*,\s*url\s*:\s*["']([^"']+)["']\s*\}/g;
    for (const m of block.matchAll(looseRe)) {
      const server = m[1];
      const url = decodeEscapes(m[2]);
      if (url.startsWith("http")) out.push({ server, url, language });
    }
  }

  return out;
}

function getDubSources(html) {
  return extractLanguageSources(html, "DUB");
}

function rankSources(sources) {
  const priority = {
    MP4Upload: 0,
    HLS: 1,
    UPNShare: 2,
    Voe: 3,
    Byse: 4,
  };
  return [...sources].sort(
    (a, b) => (priority[a.server] ?? 50) - (priority[b.server] ?? 50)
  );
}

function extractMp4Url(html) {
  const patterns = [
    /["']file["']\s*:\s*["']([^"']+)["']/i,
    /file\s*:\s*["']([^"']+)["']/i,
    /type\s*:\s*["']video\/mp4["']\s*,\s*src\s*:\s*["']([^"']+)["']/i,
    /<source[^>]+src\s*=\s*["']([^"']+)["'][^>]+type\s*=\s*["']video\/mp4["']/i,
    /<source[^>]+type\s*=\s*["']video\/mp4["'][^>]+src\s*=\s*["']([^"']+)["']/i,
  ];

  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) {
      const url = decodeEscapes(m[1]);
      if (url.startsWith("http")) return url;
    }
  }
  return null;
}

// Busca animes por nombre.
export async function search(query) {
  const q = encodeURIComponent(query.q.trim()).replace(/%20/g, "+");
  const r = await kino.fetch(`${BASE}/catalogo/__data.json?search=${q}`);
  if (!r.ok) {
    throw new Error("animeav1: error buscando (HTTP " + r.status + ")");
  }

  const text = await r.text();
  const re =
    /"id":\d+,"title":\d+,"synopsis":\d+,"categoryId":\d+,"slug":\d+,"category":\d+\},"(\d+)","((?:\\.|[^"\\])*)","(?:\\.|[^"\\])*",(?:\d+,)?"([^"]+)"/g;

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

// Lista episodios.
export async function episodes(ref) {
  const r = await kino.fetch(`${BASE}/media/${ref}`);
  if (!r.ok) {
    throw new Error(
      "animeav1: error cargando episodios (HTTP " + r.status + ")"
    );
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

// Resuelve exclusivamente DUB.
export async function resolve(ref) {
  const pageUrl = `${BASE}/media/${ref}`;
  const r = await kino.fetch(pageUrl);

  if (!r.ok) {
    throw new Error(
      "animeav1: error cargando episodio (HTTP " + r.status + ")"
    );
  }

  const html = await r.text();
  const dub = getDubSources(html);

  if (dub.length === 0) {
    throw new Error(
      "animeav1: no hay una fuente DUB disponible para este episodio"
    );
  }

  const sources = rankSources(dub);

  // 1) MP4Upload: es el servidor que Kino ya consigue reproducir en este sitio.
  for (const source of sources) {
    if (source.server !== "MP4Upload") continue;

    try {
      const embedRes = await kino.fetch(source.url);
      if (!embedRes.ok) continue;

      const embedHtml = await embedRes.text();
      const videoUrl = extractMp4Url(embedHtml);

      if (videoUrl) return {
        url: videoUrl,
        mime: "video/mp4",
        headers: { Referer: source.url },
      };
    } catch (_) {
      // Probar la siguiente fuente DUB.
    }
  }

  // 2) Si AnimeAV1 ofrece HLS DUB, devolverlo directamente.
  const hls = sources.find(
    (s) =>
      s.server.toLowerCase() === "hls" ||
      /\.m3u8(?:$|\?)/i.test(s.url)
  );
  if (hls) return {
    url: hls.url,
    mime: "application/x-mpegURL",
    headers: { Referer: pageUrl },
  };

  const direct = sources.find((s) => /\.(mp4|m3u8)(?:[?#]|$)/i.test(s.url));
  if (direct) {
    return {
      url: direct.url,
      mime: /\.m3u8(?:[?#]|$)/i.test(direct.url) ? "application/x-mpegURL" : "video/mp4",
      headers: { Referer: pageUrl },
    };
  }

  throw new Error(
    "animeav1: DUB encontrado, pero no se pudo resolver ninguna fuente DUB (" +
      sources.map((s) => s.server).join(", ") +
      ")"
  );
}
