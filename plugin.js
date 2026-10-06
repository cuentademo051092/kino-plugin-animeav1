// AnimeAV1 for Kino — v1.3.1 (home + categories + HLS + diagnostico temporal)
//
// Why Voe comes first: MP4Upload serves AnimeAV1's files as AV1 10-bit at 1440x1080. A phone
// decodes that in software, but most Android TVs and Fire TV Sticks have no AV1 decoder and
// cannot keep up, so the video never starts or stutters. Voe re-encodes the same episode to
// H.264 720p HLS, which every TV plays. MP4Upload stays as the fallback (or first, if the
// person picks it in Configurar).
//
// Data comes from SvelteKit's `__data.json` endpoints instead of scraping HTML: the same
// payload the site's own pages hydrate from, so a layout change does not break us.

const BASE = "https://animeav1.com";
const CDN = "https://cdn.animeav1.com";
const BROWSER_UA =
  "Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const SEARCH_PAGES = 3;

// ---------------------------------------------------------------------------------------------
// SvelteKit data

// Rebuilds a devalue-flattened array (what `__data.json` nodes carry) into plain values.
function unflatten(flat) {
  const cache = new Map();
  function get(i) {
    if (typeof i !== "number" || i < 0) return undefined;
    if (cache.has(i)) return cache.get(i);
    const v = flat[i];
    if (Array.isArray(v)) {
      // A typed value (["Date", "..."], ["Map", ...]) starts with a string tag.
      if (typeof v[0] === "string") {
        cache.set(i, v[1]);
        return v[1];
      }
      const out = [];
      cache.set(i, out);
      for (const x of v) out.push(get(x));
      return out;
    }
    if (v && typeof v === "object") {
      const out = {};
      cache.set(i, out);
      for (const k of Object.keys(v)) out[k] = get(v[k]);
      return out;
    }
    cache.set(i, v);
    return v;
  }
  return get(0);
}

async function loadData(path, what) {
  const r = await kino.fetch(`${BASE}${path}/__data.json`, {
    headers: { Accept: "application/json" },
  });
  if (r.status === 404) throw kino.error("not_found", `${what}: ${path}`);
  if (r.status === 429) throw kino.error("rate_limited", `${what}: HTTP 429`);
  if (!r.ok) throw kino.error("unavailable", `${what}: HTTP ${r.status}`);
  const body = await r.json();
  if (body.type === "redirect" || body.type === "error") {
    throw kino.error("not_found", `${what}: ${body.type} ${path}`);
  }
  // The page's own node is the last one with data; the earlier ones are layouts (auth, menus).
  const nodes = (body.nodes || []).filter((n) => n && n.type === "data" && Array.isArray(n.data));
  if (nodes.length === 0) throw kino.error("unavailable", `${what}: empty __data.json`);
  return unflatten(nodes[nodes.length - 1].data);
}

// ---------------------------------------------------------------------------------------------
// Items

function isMovie(media) {
  const c = media.category || {};
  return c.slug === "pelicula" || c.malId === "Movie";
}

function toItem(media) {
  const id = String(media.id);
  const movie = isMovie(media);
  const item = {
    id,
    // A movie is resolved as its episode 1; `resolve` accepts a bare slug for that.
    ref: media.slug,
    title: media.title,
    kind: movie ? "movie" : "series",
    poster: `${CDN}/covers/${id}.jpg`,
    backdrop: `${CDN}/backdrops/${id}.jpg`,
    genres: ["Anime"],
  };
  if (media.synopsis) item.overview = String(media.synopsis).trim();
  const year = String(media.startDate || "").slice(0, 4);
  if (/^\d{4}$/.test(year)) item.year = year;
  return item;
}

async function searchOnce(q) {
  const enc = encodeURIComponent(q).replace(/%20/g, "+");
  const first = await loadSearch(enc, 1);
  const items = [...first.items];
  const pages = Math.min(first.totalPages, SEARCH_PAGES);
  for (let p = 2; p <= pages; p++) {
    try {
      items.push(...(await loadSearch(enc, p)).items);
    } catch (_) {
      break; // page 1 is enough to answer
    }
  }
  return items;
}

async function loadSearch(enc, page) {
  const r = await kino.fetch(
    `${BASE}/catalogo/__data.json?search=${enc}` + (page > 1 ? `&page=${page}` : ""),
    { headers: { Accept: "application/json" } }
  );
  if (r.status === 429) throw kino.error("rate_limited", "search: HTTP 429");
  if (!r.ok) throw kino.error("unavailable", "search: HTTP " + r.status);
  const body = await r.json();
  const nodes = (body.nodes || []).filter((n) => n && n.type === "data" && Array.isArray(n.data));
  const data = nodes.length ? unflatten(nodes[nodes.length - 1].data) : {};
  return {
    items: (data.results || []).filter((m) => m && m.id != null && m.slug && m.title).map(toItem),
    totalPages: (data.pagination && data.pagination.totalPages) || 1,
  };
}

export async function search(query) {
  const tries = [query.q, query.originalTitle, ...(query.altTitles || [])]
    .map((s) => (s || "").trim())
    .filter((s, i, all) => s && all.indexOf(s) === i);

  for (const q of tries) {
    const items = await searchOnce(q);
    if (items.length === 0) continue;
    const seen = new Set();
    const unique = items.filter((it) => !seen.has(it.id) && seen.add(it.id));
    // `type` is only a hint: put the kind it names first, keep the rest.
    if (query.type === "movie" || query.type === "series") {
      unique.sort((a, b) => (a.kind === query.type ? 0 : 1) - (b.kind === query.type ? 0 : 1));
    }
    return unique.slice(0, 100);
  }
  return [];
}

// ---------------------------------------------------------------------------------------------
// Episodes

export async function episodes(ref) {
  const slug = String(ref).split("/")[0];
  const data = await loadData(`/media/${slug}`, "episodes");
  const media = data.media;
  if (!media) throw kino.error("not_found", "episodes: no media for " + slug);

  const id = String(media.id);
  const nums = [...new Set((media.episodes || []).map((e) => Number(e && e.number)))]
    .filter((n) => Number.isInteger(n) && n >= 1)
    .sort((a, b) => a - b);
  if (nums.length === 0) throw kino.error("not_found", "episodes: none listed for " + slug);

  const series = {
    title: media.title,
    poster: `${CDN}/covers/${id}.jpg`,
    backdrop: `${CDN}/backdrops/${id}.jpg`,
  };
  if (media.synopsis) series.overview = String(media.synopsis).trim();
  const year = String(media.startDate || "").slice(0, 4);
  if (/^\d{4}$/.test(year)) series.year = year;

  return {
    series,
    episodes: nums.map((n) => ({
      season: 1,
      number: n,
      ref: `${slug}/${n}`,
      still: `${CDN}/screenshots/${id}/${n}.jpg`,
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Hosters

function decodeEscapes(s) {
  return String(s).replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\\//g, "/");
}

// MP4Upload: one progressive MP4 (AV1 10-bit 1080p today) on a:183-style hosts that only answer
// with the site's Referer.
async function fromMp4Upload(embedUrl) {
  const r = await kino.fetch(embedUrl, { headers: { "User-Agent": BROWSER_UA } });
  if (!r.ok) throw new Error("mp4upload HTTP " + r.status);
  const html = await r.text();
  const m =
    html.match(/src\s*:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i) ||
    html.match(/["']?file["']?\s*:\s*["'](https?:\/\/[^"']+)["']/i) ||
    html.match(/<source[^>]+src\s*=\s*["'](https?:\/\/[^"']+)["']/i);
  if (!m) throw new Error("mp4upload: no video in embed");
  return {
    url: decodeEscapes(m[1]),
    mime: "video/mp4",
    headers: { Referer: "https://www.mp4upload.com/", "User-Agent": BROWSER_UA },
    expiresInSeconds: 3600,
  };
}

// Voe hides its sources in a JSON-wrapped string: rot13, junk markers, base64, a -3 char shift,
// reversed, base64 again.
function voeDecode(packed) {
  let s = packed.replace(/[a-zA-Z]/g, (c) => {
    const base = c <= "Z" ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });
  for (const junk of ["@$", "^^", "~@", "%?", "*~", "!!", "#&"]) s = s.split(junk).join("");
  s = atob(s);
  let shifted = "";
  for (let i = 0; i < s.length; i++) shifted += String.fromCharCode(s.charCodeAt(i) - 3);
  return JSON.parse(atob(shifted.split("").reverse().join("")));
}

function voeSourceFrom(html) {
  const packed = html.match(/<script type="application\/json">\s*\[\s*"([^"]+)"\s*\]\s*<\/script>/);
  if (packed) {
    const data = voeDecode(packed[1]);
    if (data && data.source) return data.source;
  }
  // Older Voe pages.
  const hls = html.match(/["']hls["']\s*:\s*["']([^"']+)["']/);
  if (hls) {
    const v = hls[1];
    return v.startsWith("http") ? v : atob(v);
  }
  return null;
}

// Voe: voe.sx answers with a JS redirect to a mirror domain that rotates now and then; the
// mirror holds the player. The HLS lives on a CDN whose domain rotates too (hence streamHosts).
async function fromVoe(embedUrl) {
  let url = embedUrl;
  for (let hop = 0; hop < 3; hop++) {
    const r = await kino.fetch(url, { headers: { "User-Agent": BROWSER_UA } });
    if (!r.ok) throw new Error("voe HTTP " + r.status);
    const html = await r.text();
    const source = voeSourceFrom(html);
    if (source) {
      return {
        url: source,
        mime: "application/vnd.apple.mpegurl",
        headers: { "User-Agent": BROWSER_UA },
        expiresInSeconds: 3 * 3600,
      };
    }
    const next = html.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/);
    if (!next) break;
    url = next[1];
  }
  throw new Error("voe: no source in page");
}

// HLS: the site's own player (player.zilla-networks.com) sits behind Cloudflare and only answers
// when the request looks like it comes from animeav1.com, so we send that Referer. The page
// carries an .m3u8 address somewhere in its scripts; we look for it without assuming a layout.
async function fromHls(embedUrl) {
  const origin = (embedUrl.match(/^https?:\/\/[^/]+/) || [""])[0];
  const r = await kino.fetch(embedUrl, {
    headers: { "User-Agent": BROWSER_UA, Referer: BASE + "/", Origin: BASE },
  });
  if (r.status === 403 || r.status === 503) throw new Error("HLS bloqueado (HTTP " + r.status + ")");
  if (!r.ok) throw new Error("HLS HTTP " + r.status);
  const html = decodeEscapes(await r.text());
  const m =
    html.match(/["'(](https?:\/\/[^"'\s)<>]+\.m3u8[^"'\s)<>]*)/i) ||
    html.match(/["']((?:\/)[^"'\s)<>]+\.m3u8[^"'\s)<>]*)/i) ||
    html.match(/["'](?:file|src|source|hls)["']\s*:\s*["']([^"']+)["']/i);
  if (!m) throw new Error("HLS sin video en el reproductor");
  let url = m[1];
  if (url.startsWith("//")) url = "https:" + url;
  else if (url.startsWith("/")) url = origin + url;
  return {
    url,
    mime: "application/vnd.apple.mpegurl",
    headers: { Referer: origin + "/", Origin: origin, "User-Agent": BROWSER_UA },
    expiresInSeconds: 3 * 3600,
  };
}

const RESOLVERS = { HLS: fromHls, Voe: fromVoe, MP4Upload: fromMp4Upload };

// ---------------------------------------------------------------------------------------------
// Resolve

function languagesToTry() {
  switch (kino.config.get("idioma")) {
    case "sub":
      return ["SUB"];
    case "dub-sub":
      return ["DUB", "SUB"];
    default:
      return ["DUB"];
  }
}

function serverOrder() {
  switch (kino.config.get("servidor")) {
    case "mp4upload":
      return ["MP4Upload", "HLS", "Voe"];
    case "voe":
      return ["Voe", "HLS", "MP4Upload"];
    default:
      return ["HLS", "Voe", "MP4Upload"];
  }
}

export async function resolve(ref) {
  const [slug, rawNum] = String(ref).split("/");
  let number = rawNum || "1";
  let data;
  try {
    data = await loadData(`/media/${slug}/${number}`, "resolve");
  } catch (e) {
    // A movie (bare slug) may not have an episode "1": use the first one the site lists.
    if (rawNum) throw e;
    const media = (await loadData(`/media/${slug}`, "resolve")).media || {};
    const nums = (media.episodes || []).map((x) => Number(x && x.number)).filter((n) => n >= 0);
    if (nums.length === 0) throw e;
    number = String(Math.min(...nums));
    data = await loadData(`/media/${slug}/${number}`, "resolve");
  }
  const embeds = data.embeds || {};

  const langs = languagesToTry();
  const order = serverOrder();
  const failures = [];

  for (const lang of langs) {
    const list = (embeds[lang] || []).filter((e) => e && e.url && RESOLVERS[e.server]);
    list.sort((a, b) => order.indexOf(a.server) - order.indexOf(b.server));
    for (const e of list) {
      try {
        return await RESOLVERS[e.server](e.url);
      } catch (err) {
        if (err && err.code === "host_not_allowed") failures.push(`${lang}/${e.server}: host rejected`);
        else failures.push(`${lang}/${e.server}: ${err && err.message}`);
        kino.log("animeav1:", lang, e.server, "failed:", err && err.message);
      }
    }
  }

  const offered = Object.keys(embeds).filter((k) => (embeds[k] || []).length).join(", ") || "none";
  if (failures.length === 0) {
    throw kino.error(
      "not_found",
      `no ${langs.join("/")} source for ${slug}/${number} (site offers: ${offered})`
    );
  }
  throw kino.error("unavailable", failures.join("; "));
}

// ---------------------------------------------------------------------------------------------
// Home and categories (v1.2.0)
//
// The site filters its catalog with query params: page, order, status, genre, category, minYear,
// maxYear, search. Their accepted VALUES for order/status are not documented, so the plugin tries
// a few likely ones and keeps the first that really changes the results. A row that cannot be
// built is simply left out; it never breaks the others.

const ROW_LIMIT = 60;
const PAGE_LIMIT = 100;

// [slug on the site, name shown, genre group in Kino's Categorías]
const GENEROS = [
  ["accion", "Acción", "Acción"],
  ["aventura", "Aventura", "Aventura"],
  ["comedia", "Comedia", "Comedia"],
  ["drama", "Drama", "Drama"],
  ["fantasia", "Fantasía", "Fantasía"],
  ["ciencia-ficcion", "Ciencia ficción", "Ciencia ficción"],
  ["romance", "Romance", "Romance"],
  ["shounen", "Shounen", "Anime"],
  ["misterio", "Misterio", "Misterio"],
  ["terror", "Terror", "Terror"],
  ["deportes", "Deportes", "Anime"],
  ["slice-of-life", "Slice of life", "Anime"],
];

const ORDER_CANDIDATES = ["popular", "popularity", "views", "score", "rating"];
const STATUS_CANDIDATES = ["emision", "en-emision", "airing", "1"];
const MOVIE_CANDIDATES = ["pelicula", "peliculas", "movie"];

async function loadCatalog(params, page) {
  const qs = Object.keys(params)
    .map((k) => `${k}=${encodeURIComponent(params[k])}`)
    .concat(page > 1 ? [`page=${page}`] : [])
    .join("&");
  const r = await kino.fetch(`${BASE}/catalogo/__data.json${qs ? "?" + qs : ""}`, {
    headers: { Accept: "application/json" },
  });
  if (r.status === 429) throw kino.error("rate_limited", "catalog: HTTP 429");
  if (!r.ok) throw kino.error("unavailable", "catalog: HTTP " + r.status);
  const body = await r.json();
  const nodes = (body.nodes || []).filter((n) => n && n.type === "data" && Array.isArray(n.data));
  const data = nodes.length ? unflatten(nodes[nodes.length - 1].data) : {};
  const raw = (data.results || []).filter((m) => m && m.id != null && m.slug && m.title);
  return {
    raw,
    items: raw.map(toItem),
    totalPages: (data.pagination && data.pagination.totalPages) || 1,
    orderKey: data.orderKey,
  };
}

let baselineIds = null;
async function baseline() {
  if (!baselineIds) {
    const b = await loadCatalog({}, 1);
    baselineIds = b.raw.slice(0, 10).map((m) => m.id).join(",");
  }
  return baselineIds;
}

// Tries each candidate params object; returns the first one whose results differ from the
// unfiltered catalog (or whose orderKey is no longer "default").
async function pickParams(candidates, extra) {
  const base = await baseline();
  for (const c of candidates) {
    try {
      const p = Object.assign({}, extra, c);
      const res = await loadCatalog(p, 1);
      const ids = res.raw.slice(0, 10).map((m) => m.id).join(",");
      if (res.raw.length > 0 && (ids !== base || (res.orderKey && res.orderKey !== "default"))) {
        return p;
      }
    } catch (e) {
      kino.log("animeav1 probe failed:", JSON.stringify(c), e && e.message);
    }
  }
  return null;
}

// Rows are described by a ref string: "ord", "emi", "peli", "serie", "eps", "gen:<slug>".
async function paramsFor(ref) {
  if (ref === "ord") return pickParams(ORDER_CANDIDATES.map((o) => ({ order: o })));
  if (ref === "emi") return pickParams(STATUS_CANDIDATES.map((s) => ({ status: s })));
  if (ref === "peli") return pickParams(MOVIE_CANDIDATES.map((c) => ({ category: c })));
  if (ref.startsWith("gen:")) return { genre: ref.slice(4) };
  return null;
}

function mediaFromEpisode(e) {
  const m = e && e.media;
  if (!m || m.id == null || !m.slug || !m.title) return null;
  const it = toItem(m);
  if (e.number != null) {
    it.badges = ["EP " + e.number];
    // New shows often lack a backdrop; the latest episode's screenshot always exists.
    it.backdrop = `${CDN}/screenshots/${it.id}/${e.number}.jpg`;
  }
  return it;
}

let homeCache = null;
async function loadHome() {
  if (!homeCache) homeCache = await loadData("", "home");
  return homeCache;
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((it) => !seen.has(it.id) && seen.add(it.id));
}

async function buildRow(def) {
  const [id, title, ref, genre] = def;
  let items = [];
  try {
    if (id === "eps") {
      const d = await loadHome();
      items = dedupe((d.latestEpisodes || []).map(mediaFromEpisode).filter(Boolean));
    } else if (id === "serie") {
      const res = await loadCatalog({}, 1);
      const raw = res.raw.filter((m) => !isMovie(m));
      items = raw.map(toItem);
    } else {
      const p = await paramsFor(ref);
      if (p) items = (await loadCatalog(p, 1)).items;
      else if (id === "emi") {
        // Fallback: what got a new episode lately is what is airing.
        const d = await loadHome();
        items = dedupe((d.latestEpisodes || []).map(mediaFromEpisode).filter(Boolean));
      }
    }
  } catch (e) {
    kino.log("animeav1 row", id, "failed:", e && e.message);
  }
  if (items.length === 0) return null;
  const row = { id, title, items: items.slice(0, ROW_LIMIT) };
  if (id !== "eps") row.ref = ref;
  if (genre) row.genre = genre;
  return row;
}

// Keeps only backdrops that exist, and puts the items that have one first (the app's banner
// uses the first item of the first row).
async function withVerifiedBackdrops(items) {
  const head = items.slice(0, 8);
  const checks = await Promise.all(
    head.map(async (it) => {
      if (!it.backdrop) return false;
      try {
        const r = await kino.fetch(it.backdrop, { method: "HEAD" });
        return !!r.ok;
      } catch (_) {
        return false;
      }
    })
  );
  const good = [];
  const rest = [];
  head.forEach((it, i) => {
    if (checks[i]) good.push(it);
    else {
      const copy = Object.assign({}, it);
      delete copy.backdrop;
      rest.push(copy);
    }
  });
  return [...good, ...rest, ...items.slice(8)];
}

// TEMPORARY: reports why each server fails, as cards, because Kino has no plugin log.
function short(s, n) {
  s = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

async function probePlayer(name, embedUrl) {
  try {
    if (name === "HLS") {
      const origin = (embedUrl.match(/^https?:\/\/[^/]+/) || [""])[0];
      const r = await kino.fetch(embedUrl, {
        headers: { "User-Agent": BROWSER_UA, Referer: BASE + "/", Origin: BASE },
      });
      const text = await r.text();
      const m3u8 = /\.m3u8/i.test(decodeEscapes(text));
      const title = (text.match(/<title>([^<]*)<\/title>/i) || [])[1] || "";
      return `HLS: HTTP ${r.status}, ${text.length} bytes, m3u8: ${m3u8 ? "SÍ" : "no"}, título: ${short(title, 40)}, inicio: ${short(text.replace(/<[^>]+>/g, " "), 60)} [${origin}]`;
    }
    const res = await RESOLVERS[name](embedUrl);
    return `${name}: OK (${short(res.url, 60)})`;
  } catch (e) {
    return `${name}: FALLA - ${short(e && e.message, 110)}`;
  }
}

async function diagnosticRow() {
  const lines = [];
  try {
    const d = await loadHome();
    const ep = (d.latestEpisodes || []).find((e) => e && e.media && e.media.slug);
    if (!ep) return null;
    const data = await loadData(`/media/${ep.media.slug}/${ep.number}`, "diag");
    const embeds = data.embeds || {};
    const lang = (embeds.DUB || []).length ? "DUB" : "SUB";
    lines.push(`Prueba: ${short(ep.media.title, 40)} ep ${ep.number} (${lang})`);
    const offered = (embeds[lang] || []).map((e) => e.server).join(", ");
    lines.push("Servidores del sitio: " + offered);
    for (const name of ["HLS", "Voe", "MP4Upload"]) {
      const e = (embeds[lang] || []).find((x) => x.server === name);
      lines.push(e ? await probePlayer(name, e.url) : `${name}: no ofrecido`);
    }
  } catch (e) {
    lines.push("Diagnóstico falló: " + short(e && e.message, 150));
  }
  return {
    id: "diag",
    title: "Diagnóstico (temporal)",
    items: lines.map((l, i) => ({
      id: "diag-" + i,
      ref: "diag",
      title: short(l, 150),
      kind: "movie",
      overview: l,
      genres: ["Anime"],
    })),
  };
}

export async function home() {
  const defs = [
    ["emi", "En emisión", "emi", null],
    ["eps", "Últimos episodios", "eps", null],
    ["ord", "Populares", "ord", null],
    ["peli", "Películas", "peli", "Película"],
    ["serie", "Series", "serie", "Serie"],
    ...GENEROS.map(([slug, name, group]) => ["gen-" + slug, name, "gen:" + slug, group]),
  ];
  const [rowsRaw, diag] = await Promise.all([Promise.all(defs.map(buildRow)), diagnosticRow()]);
  const rows = rowsRaw.filter(Boolean);
  if (rows.length > 0) {
    try {
      rows[0].items = await withVerifiedBackdrops(rows[0].items);
    } catch (_) {}
  }
  if (diag) rows.push(diag);
  if (rows.length === 0) throw kino.error("unavailable", "home: no rows could be built");
  return rows;
}

export async function browse(ref, cursor) {
  const page = Math.max(1, parseInt(cursor, 10) || 1);
  ref = String(ref);
  let res;
  if (ref === "eps") {
    const d = await loadHome();
    return { items: dedupe((d.latestEpisodes || []).map(mediaFromEpisode).filter(Boolean)).slice(0, PAGE_LIMIT) };
  }
  if (ref === "serie") {
    res = await loadCatalog({}, page);
    res.items = res.raw.filter((m) => !isMovie(m)).map(toItem);
  } else {
    const p = await paramsFor(ref);
    if (!p) throw kino.error("unavailable", "browse: filter not supported " + ref);
    res = await loadCatalog(p, page);
  }
  return {
    items: dedupe(res.items).slice(0, PAGE_LIMIT),
    next: page < res.totalPages ? String(page + 1) : undefined,
  };
}
