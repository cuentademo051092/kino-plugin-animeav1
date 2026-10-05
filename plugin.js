// AnimeAV1 for Kino — v1.1.0
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

const BLOCKED_VOE_HOSTS = new Set(["teresapoliticallyearn.com"]);

function isBlockedVoeHost(value) {
  try {
    const host = new URL(String(value)).hostname.toLowerCase();
    for (const blocked of BLOCKED_VOE_HOSTS) {
      if (host === blocked || host.endsWith("." + blocked)) return true;
    }
  } catch (_) {}
  return false;
}

function assertVoeHostAllowed(value) {
  if (isBlockedVoeHost(value)) {
    throw kino.error("host_blocked", "Voe: blocked unwanted host");
  }
}

// Voe: voe.sx answers with a JS redirect to a mirror domain that rotates now and then; the
// mirror holds the player. The HLS lives on a CDN whose domain rotates too (hence streamHosts).
async function fromVoe(embedUrl) {
  let url = embedUrl;
  assertVoeHostAllowed(url);
  for (let hop = 0; hop < 3; hop++) {
    assertVoeHostAllowed(url);
    const r = await kino.fetch(url, { headers: { "User-Agent": BROWSER_UA } });
    if (!r.ok) throw new Error("voe HTTP " + r.status);
    const html = await r.text();
    const source = voeSourceFrom(html);
    if (source) {
      assertVoeHostAllowed(source);
      return {
        url: source,
        mime: "application/vnd.apple.mpegurl",
        headers: { "User-Agent": BROWSER_UA },
        expiresInSeconds: 3 * 3600,
      };
    }
    const next = html.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/);
    if (!next) break;
    assertVoeHostAllowed(next[1]);
    url = next[1];
  }
  throw new Error("voe: no source in page");
}

const RESOLVERS = { Voe: fromVoe, MP4Upload: fromMp4Upload };

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

function selectedServer() {
  return kino.config.get("servidor") === "mp4upload" ? "MP4Upload" : "Voe";
}

export async function resolve(ref) {
  const [slug, rawNum] = String(ref).split("/");
  const number = rawNum || "1";
  const data = await loadData(`/media/${slug}/${number}`, "resolve");
  const embeds = data.embeds || {};

  const langs = languagesToTry();
  const selected = selectedServer();
  const failures = [];

  for (const lang of langs) {
    const list = (embeds[lang] || []).filter(
      (e) => e && e.url && e.server === selected && RESOLVERS[e.server]
    );
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

  const offered = Object.keys(embeds).join(", ") || "none";
  if (failures.length === 0) {
    throw kino.error(
      "not_found",
      `no ${langs.join("/")} source for ${slug}/${number} (site offers: ${offered})`
    );
  }
  throw kino.error("unavailable", failures.join("; "));
}
