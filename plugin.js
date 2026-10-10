// AnimeAV1 for Kino — v1.5.0 (home + categories, 5 servers)
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

// ---------------------------------------------------------------------------------------------
// More hosters (v1.5.0): YourUpload, StreamTape and UPNShare.
//
// Every link is checked with a tiny request (2 bytes of the video, or the first playlist and
// segment) BEFORE it is returned. A dead or refused link throws, and resolve() simply moves on to
// the next server instead of leaving the person on "Cargando video…".

function decodeHtml(s) {
  return String(s).replace(/&amp;/g, "&").replace(/&#x2F;/gi, "/").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
}

function resolveUrl(base, rel) {
  try {
    return new URL(rel, base).href;
  } catch (_) {
    return rel;
  }
}

// A progressive video link is good only if the server answers a 2-byte range request.
async function checkVideo(url, headers) {
  const r = await kino.fetch(url, {
    headers: Object.assign({ Range: "bytes=0-1" }, headers),
    timeoutMs: 8000,
  });
  if (r.status !== 200 && r.status !== 206) throw new Error("HTTP " + r.status);
  return r;
}

// An HLS link is good if the playlist loads, and so does the first segment of the first variant.
async function checkHls(url, headers) {
  const get = async (u, h) => {
    const r = await kino.fetch(u, { headers: h, timeoutMs: 8000 });
    if (r.status !== 200 && r.status !== 206) throw new Error("HTTP " + r.status);
    return r;
  };
  const linesOf = (t) => String(t).split("\n").map((l) => l.trim()).filter(Boolean);
  let playlistUrl = url;
  let text = await (await get(playlistUrl, headers)).text();
  if (text.indexOf("#EXTM3U") === -1) throw new Error("not a playlist");
  let lines = linesOf(text);
  if (lines.some((l) => l.indexOf("#EXT-X-STREAM-INF") === 0)) {
    const variant = lines.find((l) => l.charAt(0) !== "#");
    if (!variant) throw new Error("empty master playlist");
    playlistUrl = resolveUrl(playlistUrl, variant);
    text = await (await get(playlistUrl, headers)).text();
    lines = linesOf(text);
  }
  const seg = lines.find((l) => l.charAt(0) !== "#");
  if (!seg) throw new Error("no segments in playlist");
  await get(resolveUrl(playlistUrl, seg), Object.assign({ Range: "bytes=0-1" }, headers));
}

// YourUpload: the embed page names the mp4 in its og:video tag, and the file host answers 500 unless
// the request carries YourUpload's own Referer.
async function fromYourUpload(embedUrl) {
  const r = await kino.fetch(embedUrl, { headers: { "User-Agent": BROWSER_UA, Referer: BASE + "/" } });
  if (!r.ok) throw new Error("yourupload HTTP " + r.status);
  const html = await r.text();
  const m =
    html.match(/<meta[^>]+og:video["'][^>]*content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+og:video["']/i) ||
    html.match(/file\s*:\s*["'](https?:\/\/[^"']+)["']/i);
  if (!m) throw new Error("yourupload: no video in embed");
  const url = decodeHtml(decodeEscapes(m[1]));
  const headers = { Referer: "https://www.yourupload.com/", "User-Agent": BROWSER_UA };
  await checkVideo(url, headers);
  return { url, mime: "video/mp4", headers, expiresInSeconds: 1800 };
}

// StreamTape: the page's own script assembles the link in two pieces
//   el.innerHTML = '//streamtape.com/get_vide' + ('xcdo?id=...&token=...').substring(2).substring(1)
// (a decoy copy of the link sits in the HTML with a wrong token). get_video answers with a redirect
// to the real file, which is signed for the caller's IP; the final address is what the player gets.
async function fromStreamTape(embedUrl) {
  const r = await kino.fetch(embedUrl, { headers: { "User-Agent": BROWSER_UA, Referer: BASE + "/" } });
  if (!r.ok) throw new Error("streamtape HTTP " + r.status);
  const html = await r.text();
  const re = /getElementById\(\s*['"](?:robotlink|ideoolink|norobotlink)['"]\s*\)\.innerHTML\s*=\s*['"]([^'"]*)['"]\s*\+\s*\(\s*['"]([^'"]*)['"]\s*\)((?:\s*\.substring\(\s*\d+\s*\))*)/g;
  const links = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    let tail = m[2];
    const cuts = m[3].match(/\d+/g) || [];
    for (let i = 0; i < cuts.length; i++) tail = tail.substring(Number(cuts[i]));
    const head = m[1];
    links.push((head.indexOf("//") === 0 ? "https:" : "") + head + tail);
  }
  if (links.length === 0) throw new Error("streamtape: no link in embed");
  let lastErr;
  for (const link of links.slice(0, 3)) {
    try {
      const v = await checkVideo(link, { "User-Agent": BROWSER_UA });
      return {
        url: v.url || link,
        mime: "video/mp4",
        headers: { "User-Agent": BROWSER_UA },
        expiresInSeconds: 900,
      };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("streamtape: no working link");
}

// --- AES-128-CBC decrypt, plain JS (UPNShare answers with hex of an AES-CBC encrypted JSON) --------
const AES_SBOX_HEX = "637c777bf26b6fc53001672bfed7ab76ca82c97dfa5947f0add4a2af9ca472c0b7fd9326363ff7cc34a5e5f171d8311504c723c31896059a071280e2eb27b27509832c1a1b6e5aa0523bd6b329e32f8453d100ed20fcb15b6acbbe394a4c58cfd0efaafb434d338545f9027f503c9fa851a3408f929d38f5bcb6da2110fff3d2cd0c13ec5f974417c4a77e3d645d197360814fdc222a908846eeb814de5e0bdbe0323a0a4906245cc2d3ac629195e479e7c8376d8dd54ea96c56f4ea657aae08ba78252e1ca6b4c6e8dd741f4bbd8b8a703eb5664803f60e613557b986c11d9ee1f8981169d98e949b1e87e9ce5528df8ca1890dbfe6426841992d0fb054bb16";
const AES_SBOX = new Uint8Array(256);
const AES_INV = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  AES_SBOX[i] = parseInt(AES_SBOX_HEX.substr(i * 2, 2), 16);
  AES_INV[AES_SBOX[i]] = i;
}
function aesMul(a, b) {
  let p = 0;
  while (b) {
    if (b & 1) p ^= a;
    a = ((a << 1) ^ (a & 0x80 ? 0x11b : 0)) & 0xff;
    b >>= 1;
  }
  return p;
}
const AES_M9 = new Uint8Array(256), AES_M11 = new Uint8Array(256), AES_M13 = new Uint8Array(256), AES_M14 = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  AES_M9[i] = aesMul(i, 9);
  AES_M11[i] = aesMul(i, 11);
  AES_M13[i] = aesMul(i, 13);
  AES_M14[i] = aesMul(i, 14);
}
function aesExpandKey(key) {
  const w = new Uint8Array(176);
  w.set(key);
  let rcon = 1;
  for (let i = 16; i < 176; i += 4) {
    let t0 = w[i - 4], t1 = w[i - 3], t2 = w[i - 2], t3 = w[i - 1];
    if (i % 16 === 0) {
      const x = t0;
      t0 = AES_SBOX[t1] ^ rcon;
      t1 = AES_SBOX[t2];
      t2 = AES_SBOX[t3];
      t3 = AES_SBOX[x];
      rcon = ((rcon << 1) ^ (rcon & 0x80 ? 0x11b : 0)) & 0xff;
    }
    w[i] = w[i - 16] ^ t0;
    w[i + 1] = w[i - 15] ^ t1;
    w[i + 2] = w[i - 14] ^ t2;
    w[i + 3] = w[i - 13] ^ t3;
  }
  return w;
}
function aesDecryptBlock(w, input, out) {
  let s = new Uint8Array(16);
  const t = new Uint8Array(16);
  for (let i = 0; i < 16; i++) s[i] = input[i] ^ w[160 + i];
  for (let round = 9; round >= 0; round--) {
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) t[((c + r) % 4) * 4 + r] = s[c * 4 + r];
    for (let i = 0; i < 16; i++) s[i] = AES_INV[t[i]] ^ w[round * 16 + i];
    if (round > 0) {
      for (let c = 0; c < 4; c++) {
        const a0 = s[c * 4], a1 = s[c * 4 + 1], a2 = s[c * 4 + 2], a3 = s[c * 4 + 3];
        s[c * 4] = AES_M14[a0] ^ AES_M11[a1] ^ AES_M13[a2] ^ AES_M9[a3];
        s[c * 4 + 1] = AES_M9[a0] ^ AES_M14[a1] ^ AES_M11[a2] ^ AES_M13[a3];
        s[c * 4 + 2] = AES_M13[a0] ^ AES_M9[a1] ^ AES_M14[a2] ^ AES_M11[a3];
        s[c * 4 + 3] = AES_M11[a0] ^ AES_M13[a1] ^ AES_M9[a2] ^ AES_M14[a3];
      }
    }
  }
  out.set(s);
}
// hex string in -> text out; key and iv are 16-character strings.
function aesCbcDecryptHex(hex, keyText, ivText) {
  const clean = String(hex).trim();
  if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length % 32 !== 0) throw new Error("not AES-CBC hex");
  const data = new Uint8Array(clean.length / 2);
  for (let i = 0; i < data.length; i++) data[i] = parseInt(clean.substr(i * 2, 2), 16);
  const w = aesExpandKey(Uint8Array.from(keyText, (c) => c.charCodeAt(0)));
  let prev = Uint8Array.from(ivText, (c) => c.charCodeAt(0));
  const out = new Uint8Array(data.length);
  const block = new Uint8Array(16);
  for (let off = 0; off < data.length; off += 16) {
    aesDecryptBlock(w, data.subarray(off, off + 16), block);
    for (let i = 0; i < 16; i++) out[off + i] = block[i] ^ prev[i];
    prev = data.subarray(off, off + 16);
  }
  const pad = out[out.length - 1];
  const end = pad >= 1 && pad <= 16 ? out.length - pad : out.length;
  return new TextDecoder().decode(out.subarray(0, end));
}

// UPNShare: /api/v1/video answers with the player's settings, encrypted with a fixed key that the
// site's own player uses. Inside: "cfNative" (the playlist served through the player's own host)
// and "source" (the same playlist on a bare IP). Both need the player's Referer.
const UPN_KEY = "kiemtienmua911ca";
const UPN_IV = "1234567890oiuytr";
async function fromUpnShare(embedUrl) {
  const id = (String(embedUrl).split("#")[1] || "").replace(/^\//, "");
  const om = String(embedUrl).match(/^https?:\/\/[^\/#?]+/);
  if (!id || !om) throw new Error("upnshare: bad embed url");
  const origin = om[0];
  const headers = { Referer: origin + "/", "User-Agent": BROWSER_UA };
  const api = origin + "/api/v1/video?id=" + encodeURIComponent(id) + "&w=1920&h=1080&r=" + encodeURIComponent(BASE + "/");
  const r = await kino.fetch(api, { headers });
  if (!r.ok) throw new Error("upnshare api HTTP " + r.status);
  let info;
  try {
    info = JSON.parse(aesCbcDecryptHex(await r.text(), UPN_KEY, UPN_IV));
  } catch (e) {
    throw new Error("upnshare: cannot read reply (" + (e && e.message) + ")");
  }
  const candidates = [info.cfNative, info.source]
    .filter((s) => typeof s === "string" && s)
    .map((s) => resolveUrl(origin + "/", s));
  if (candidates.length === 0) throw new Error("upnshare: no playlist in reply");
  let lastErr;
  for (const url of candidates) {
    try {
      await checkHls(url, headers);
      return { url, mime: "application/vnd.apple.mpegurl", headers, expiresInSeconds: 1800 };
    } catch (e) {
      lastErr = e;
      kino.log("animeav1 upnshare candidate failed:", e && e.message);
    }
  }
  throw lastErr || new Error("upnshare: no playable link");
}

const RESOLVERS = {
  Voe: fromVoe,
  MP4Upload: fromMp4Upload,
  YourUpload: fromYourUpload,
  StreamTape: fromStreamTape,
  UPNShare: fromUpnShare,
};

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

// Voe first (H.264 720p plays on every TV), then UPNShare (H.264 up to 1080p), then the plain mp4
// hosters, whose files are AV1 and stutter on many TVs. The person's pick in Configurar goes first.
const SERVER_KEYS = {
  voe: "Voe",
  mp4upload: "MP4Upload",
  yourupload: "YourUpload",
  streamtape: "StreamTape",
  upnshare: "UPNShare",
};
const DEFAULT_ORDER = ["Voe", "UPNShare", "MP4Upload", "YourUpload", "StreamTape"];

function serverOrder() {
  const first = SERVER_KEYS[kino.config.get("servidor")];
  return first ? [first].concat(DEFAULT_ORDER.filter((s) => s !== first)) : DEFAULT_ORDER;
}

// resolve() has 20 s in total; stop starting new servers a bit before that.
const RESOLVE_BUDGET_MS = 15000;

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
  const started = Date.now();

  for (const lang of langs) {
    const list = (embeds[lang] || []).filter((e) => e && e.url && RESOLVERS[e.server]);
    list.sort((a, b) => order.indexOf(a.server) - order.indexOf(b.server));
    for (const e of list) {
      if (Date.now() - started > RESOLVE_BUDGET_MS) {
        failures.push(`${lang}/${e.server}: skipped, out of time`);
        continue;
      }
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

// [slug on the site, name shown]. Kino's Categorías only accepts a closed list of groups
// (peliculas, series, anime, infantil, documentales, deportes, noticias, musica,
// entretenimiento, otros), so every genre row goes under "anime".
const GENEROS = [
  ["accion", "Acción"],
  ["aventura", "Aventura"],
  ["comedia", "Comedia"],
  ["drama", "Drama"],
  ["fantasia", "Fantasía"],
  ["ciencia-ficcion", "Ciencia ficción"],
  ["romance", "Romance"],
  ["shounen", "Shounen"],
  ["misterio", "Misterio"],
  ["terror", "Terror"],
  ["deportes", "Deportes"],
  ["slice-of-life", "Slice of life"],
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

// Keeps only backdrops that exist and puts items that have one first: the app uses the first
// item's backdrop as the cover of each category tile (and the banner for the first row).
// If none of the checked items has a backdrop, the first item falls back to its poster.
const backdropOk = new Map();
async function hasBackdrop(it) {
  if (!it.backdrop) return false;
  if (!backdropOk.has(it.backdrop)) {
    backdropOk.set(
      it.backdrop,
      (async () => {
        try {
          const r = await kino.fetch(it.backdrop, { method: "HEAD" });
          return !!r.ok;
        } catch (_) {
          return false;
        }
      })()
    );
  }
  return backdropOk.get(it.backdrop);
}

async function withVerifiedBackdrops(items, n) {
  const head = items.slice(0, n);
  const checks = await Promise.all(head.map(hasBackdrop));
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
  const out = [...good, ...rest, ...items.slice(n)];
  if (good.length === 0 && out.length > 0 && out[0].poster) out[0].backdrop = out[0].poster;
  return out;
}

export async function home() {
  const defs = [
    ["emi", "En emisión", "emi", "anime"],
    ["eps", "Últimos episodios", "eps", null],
    ["ord", "Populares", "ord", "anime"],
    ["peli", "Películas", "peli", "peliculas"],
    ["serie", "Series", "serie", "series"],
    ...GENEROS.map(([slug, name]) => ["gen-" + slug, name, "gen:" + slug, "anime"]),
  ];
  const rowsRaw = await Promise.all(defs.map(buildRow));
  const rows = rowsRaw.filter(Boolean);
  await Promise.all(
    rows.map(async (row, i) => {
      try {
        row.items = await withVerifiedBackdrops(row.items, i === 0 ? 8 : 4);
      } catch (_) {}
    })
  );
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
