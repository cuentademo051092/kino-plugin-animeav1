/**
 * Plugin de AnimeAV1 para Kino
 * Configuración: Pantalla de inicio personalizada + 6 Géneros en Categorías.
 */

const BASE_URL = "https://animeav1.com";

// Función auxiliar para descargar y parsear el contenido HTML de animeav1.com
async function fetchDOM(url) {
  const res = await kino.fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
  });
  const html = await res.text();
  return kino.parseHTML(html);
}

// --- MANEJO DE CATÁLOGOS Y GÉNEROS ---
// Esta función carga las filas de la pantalla de inicio y las secciones de categorías.
async function catalog(id, page = 1) {
  let url = BASE_URL;

  switch (id) {
    // 1. Filas de la Pantalla de Inicio
    case "ultimos":
      url = `${BASE_URL}/episodes?page=${page}`;
      break;
    case "emision":
      url = `${BASE_URL}/catalogo?status=emision&page=${page}`;
      break;
    case "populares":
      url = `${BASE_URL}/catalogo?order=popular&page=${page}`;
      break;
    case "peliculas":
      url = `${BASE_URL}/catalogo?type=movie&page=${page}`;
      break;
    case "series":
      url = `${BASE_URL}/catalogo?type=tv-anime&page=${page}`;
      break;

    // 2. Filas por Géneros (Sección Categorías)
    case "shounen":
      url = `${BASE_URL}/catalogo?genre=shounen&page=${page}`;
      break;
    case "romance":
      url = `${BASE_URL}/catalogo?genre=romance&page=${page}`;
      break;
    case "fantasia":
      url = `${BASE_URL}/catalogo?genre=fantasia&page=${page}`;
      break;
    case "scifi":
      url = `${BASE_URL}/catalogo?genre=ciencia-ficcion&page=${page}`;
      break;
    case "aventura":
      url = `${BASE_URL}/catalogo?genre=aventura&page=${page}`;
      break;
    case "ecchi":
      url = `${BASE_URL}/catalogo?genre=ecchi&page=${page}`;
      break;

    default:
      url = `${BASE_URL}/catalogo?page=${page}`;
  }

  const doc = await fetchDOM(url);
  const items = [];
  
  // Usar selector de episodios si es el catálogo "últimos", o selector de animes para los demás
  const selector = id === "ultimos" ? ".episode-item, .anime-card, article" : ".anime-card, .article-anime, article";
  const elements = doc.querySelectorAll(selector);

  elements.forEach((el) => {
    const linkEl = el.querySelector("a");
    const imgEl = el.querySelector("img");
    const titleEl = el.querySelector(".title, .name, h3, h2") || linkEl;

    if (linkEl) {
      const href = linkEl.getAttribute("href") || "";
      const title = titleEl ? titleEl.textContent.trim() : "Sin título";
      const poster = imgEl ? (imgEl.getAttribute("src") || imgEl.getAttribute("data-src") || "") : "";

      const fullPoster = poster.startsWith("http") ? poster : `${BASE_URL}${poster}`;
      const fullHref = href.startsWith("http") ? href : `${BASE_URL}${href}`;

      items.push({
        id: fullHref,
        title: title,
        poster: fullPoster,
        backdrop: fullPoster,
        type: id === "peliculas" ? "movie" : "series"
      });
    }
  });

  return items;
}

// --- BUSCADOR ---
// Procesa la barra de búsqueda global en la app Kino
async function search(query) {
  const doc = await fetchDOM(`${BASE_URL}/catalogo?q=${encodeURIComponent(query)}`);
  const items = [];

  doc.querySelectorAll(".anime-card, .article-anime, article").forEach((el) => {
    const linkEl = el.querySelector("a");
    const imgEl = el.querySelector("img");
    const titleEl = el.querySelector(".title, .name, h3") || linkEl;

    if (linkEl) {
      const href = linkEl.getAttribute("href") || "";
      const title = titleEl ? titleEl.textContent.trim() : "Sin título";
      const poster = imgEl ? (imgEl.getAttribute("src") || imgEl.getAttribute("data-src") || "") : "";

      items.push({
        id: href.startsWith("http") ? href : `${BASE_URL}${href}`,
        title: title,
        poster: poster.startsWith("http") ? poster : `${BASE_URL}${poster}`,
        type: "series"
      });
    }
  });

  return items;
}

// --- LISTA DE EPISODIOS ---
// Extrae la lista de capítulos de la página de un anime en particular
async function episodes(seriesId) {
  const doc = await fetchDOM(seriesId);
  const epList = [];

  doc.querySelectorAll(".episode-list a, .list-episodes a, #episodes a").forEach((el, index) => {
    const href = el.getAttribute("href") || "";
    const title = el.textContent.trim() || `Episodio ${index + 1}`;

    epList.push({
      id: href.startsWith("http") ? href : `${BASE_URL}${href}`,
      title: title,
      season: 1,
      episode: index + 1
    });
  });

  return epList;
}

// --- RESOLUCIÓN DE SERVIDORES Y REPRODUCCIÓN ---
// Extrae las URLs de video (VOE, MP4Upload, etc.) para que Kino pueda reproducirlos
async function resolve(episodeId) {
  const doc = await fetchDOM(episodeId);
  const streams = [];
  const iframes = doc.querySelectorAll("iframe, .player-container iframe");

  for (const iframe of iframes) {
    const src = iframe.getAttribute("src") || iframe.getAttribute("data-src") || "";

    // Servidores VOE y espejos
    if (src.includes("voe") || src.includes("jeremy") || src.includes("teresa")) {
      streams.push({
        name: "Voe (720p HD)",
        quality: "720p",
        url: src.startsWith("//") ? `https:${src}` : src,
        type: "embed"
      });
    }

    // Servidor MP4Upload
    if (src.includes("mp4upload")) {
      streams.push({
        name: "MP4Upload (1080p Full HD)",
        quality: "1080p",
        url: src.startsWith("//") ? `https:${src}` : src,
        type: "embed"
      });
    }
  }

  // Si no se encontraron en iframe, buscar botones de selección de servidor
  if (streams.length === 0) {
    doc.querySelectorAll(".server-option, [data-player]").forEach((btn) => {
      const pUrl = btn.getAttribute("data-player") || btn.getAttribute("value");
      if (pUrl) {
        streams.push({
          name: "Servidor Secundario",
          quality: "720p",
          url: pUrl.startsWith("//") ? `https:${pUrl}` : pUrl,
          type: "embed"
        });
      }
    });
  }

  return streams;
    }
