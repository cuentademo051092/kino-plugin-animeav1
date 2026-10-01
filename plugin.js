// Plugin de Kino para animeav1.com
// Fuente resuelta: MP4Upload, con preferencia por audio DUB (latino)
// v0.7.0: la 0.6.0 intentaba reconstruir a mano el formato de datos comprimido
// de SvelteKit para elegir entre DUB/SUB, y eso rompía el motor de Kino
// ("Cannot convert java type 'g7.s' to a js value") tumbando toda la
// reproducción, tanto en celular como en TV box. Se quita ese método.
// Ahora elige DUB/SUB con una forma más simple y segura: mirando qué tan cerca
// del texto "DUB" o "SUB" aparece cada enlace de MP4Upload, sin tocar el JSON.

const BASE = "https://animeav1.com";
const CDN = "https://cdn.animeav1.com";

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Busca animes por nombre. Ej: search({ q: "Mushoku Tensei" })
export async function search(query) {
  const q = encodeURIComponent(query.q.trim()).replace(/%20/g, "+");
  const r = await kino.fetch(`${BASE}/catalogo/__data.json?search=${q}`);
  if (!r.ok) throw new Error("animeav1: error buscando (HTTP " + r.status + ")");
  const text = await r.text();

  // Cada resultado: {"id":N,"title":N,"synopsis":N,"categoryId":N,"slug":N,"category":N},
  //   "<id>","<título>","<sinopsis>",[<categoría>,]"<slug>"
  // El número de categoría solo aparece en el primer resultado (los demás lo reutilizan).
  const re = /"id":\d+,"title":\d+,"synopsis":\d+,"categoryId":\d+,"slug":\d+,"category":\d+\},"(\d+)","((?:\\.|[^"\\])*)","(?:\\.|[^"\\])*",(?:\d+,)?"([^"]+)"/g;

  const results = [];
  const seen = new Set();
  for (const m of text.matchAll(re)) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    results.push({
      id,
      ref: m[3],       // slug, ej: "mushoku-tensei-iii-isekai-ittara-honki-dasu"
      title: m[2],
      kind: "series",  // Kino solo acepta "movie" o "series"
      poster: `${CDN}/covers/${id}.jpg`,
      backdrop: `${CDN}/backdrops/${id}.jpg`,
    });
  }
  return results;
}

// Lista los episodios de un anime a partir de su slug (ref devuelto por search).
// Lee la página HTML normal: cada episodio aparece como un link "/media/<slug>/<n>".
export async function episodes(ref) {
  const r = await kino.fetch(`${BASE}/media/${ref}`);
  if (!r.ok) throw new Error("animeav1: error cargando episodios (HTTP " + r.status + ")");
  const html = await r.text();

  const re = new RegExp("/media/" + escapeRegExp(ref) + "/(\\d+)", "g");
  const nums = [...html.matchAll(re)].map((m) => Number(m[1]));
  const unique = [...new Set(nums)].sort((a, b) => a - b);

  if (unique.length === 0) {
    throw new Error("animeav1: no se encontraron episodios");
  }

  // El id interno del anime (ej. 4384) aparece en la URL del backdrop.
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

// De todos los enlaces de MP4Upload que aparecen en el texto, elige el de audio
// DUB (latino) si existe; si no, cae al de SUB (japonés). No usa JSON.parse ni
// reconstruye la estructura de datos: solo mira qué etiqueta ("DUB" o "SUB")
// aparece más cerca, antes, de cada enlace.
function pickMp4UploadEmbed(text) {
  const embedRe = /"MP4Upload","(https:\/\/(?:www\.)?mp4upload\.com\/embed-[a-zA-Z0-9]+\.html)"/g;
  const candidates = [...text.matchAll(embedRe)].map((m) => ({ url: m[1], index: m.index }));
  if (candidates.length === 0) return null;

  const dubPos = text.indexOf('"DUB":');
  const subPos = text.indexOf('"SUB":');

  function langBefore(idx) {
    let lang = null;
    let bestPos = -1;
    if (dubPos !== -1 && dubPos <= idx && dubPos > bestPos) { lang = "DUB"; bestPos = dubPos; }
    if (subPos !== -1 && subPos <= idx && subPos > bestPos) { lang = "SUB"; bestPos = subPos; }
    return lang;
  }

  for (const c of candidates) c.lang = langBefore(c.index);

  return candidates.find((c) => c.lang === "DUB")
    || candidates.find((c) => c.lang === "SUB")
    || candidates[0];
}

// Resuelve el link final del video para un episodio (ref = "slug/numero")
export async function resolve(ref) {
  const r = await kino.fetch(`${BASE}/media/${ref}/__data.json`);
  if (!r.ok) throw new Error("animeav1: error cargando episodio (HTTP " + r.status + ")");
  const text = await r.text();

  const hit = pickMp4UploadEmbed(text);
  if (!hit) {
    throw new Error("animeav1: no se encontró servidor MP4Upload para este episodio");
  }

  const embedUrl = hit.url;
  const embedRes = await kino.fetch(embedUrl);
  if (!embedRes.ok) {
    throw new Error("mp4upload: error cargando el reproductor (HTTP " + embedRes.status + ")");
  }
  const embedHtml = await embedRes.text();

  const srcMatch = embedHtml.match(/type:\s*"video\/mp4",\s*src:\s*"([^"]+)"/);
  if (!srcMatch) {
    throw new Error("mp4upload: no se pudo extraer el link del video");
  }

  return {
    url: srcMatch[1],
    mime: "video/mp4",
    headers: { Referer: embedUrl },
  };
}
