import { BrowserWindow } from 'electron'
import { log } from '../log.js'

/**
 * Offscreen browsing.
 *
 * Pages are opened in a real Chromium window rather than fetched as text.
 * That matters for three reasons a raw `fetch` cannot solve:
 *
 *   1. Many publishers block plain HTTP clients outright — Britannica and
 *      fbi.gov both returned 403 to fetch while loading fine in a browser.
 *   2. News sites lazy-load their photography, so the real images only exist
 *      after JavaScript has run.
 *   3. The rendered DOM reports actual laid-out image dimensions, which is a
 *      far better signal than a declared `width` attribute.
 *
 * Windows are offscreen, script-isolated, and destroyed immediately after
 * extraction. Nothing is shown to the user and no session state is shared with
 * their real browser profile.
 */

export interface PageImage {
  url: string
  alt: string
  /** Rendered size on the page — the honest measure of prominence. */
  width: number
  height: number
  /** Nearby caption text, when the image sits in a figure. */
  caption: string
  /** Largest width the page offers for this image, from srcset. */
  maxWidth: number
  /** True when `url` was rewritten to a larger derivative than the page used. */
  upgraded: boolean
}

export interface PageContent {
  url: string
  title: string
  description: string
  /** Readable body text, boilerplate stripped. */
  text: string
  images: PageImage[]
  /** Publisher's own preview image, kept separate so it can be ranked lower. */
  ogImage: string | null
  /** Dates the page declares about its content. */
  published: string | null
  failure?: string
}

/**
 * Extraction runs inside the page.
 *
 * Tagged `String.raw` rather than written as a plain template literal: the
 * script is dense with regular expressions, and in an ordinary template every
 * backslash is an escape sequence — which silently turned `/\/thumb\//` into
 * a line comment and broke extraction on every page at once. `String.raw`
 * passes the characters through exactly as written.
 */
const EXTRACT = String.raw`(() => {
  const abs = (u) => { try { return new URL(u, location.href).href } catch { return null } };

  const meta = (...names) => {
    for (const n of names) {
      const el = document.querySelector(
        'meta[property="' + n + '"], meta[name="' + n + '"]'
      );
      if (el && el.content) return el.content.trim();
    }
    return '';
  };

  // Pages lay images out small — Wikipedia renders 250px thumbnails of
  // photographs that exist at 1280px and above. Displaying what the page
  // displayed would put a postage stamp on a cinema screen, so where a larger
  // derivative is known to exist, ask for that one instead.
  const upgrade = (u) => {
    try {
      const url = new URL(u);
      // Wikimedia encodes the rendition width in the filename.
      if (/wiki(m|p)edia\.org$/.test(url.hostname) && url.pathname.indexOf('/thumb/') >= 0) {
        const up = url.pathname.replace(/\/\d+px-/, '/1280px-');
        if (up !== url.pathname) { url.pathname = up; url.search = ''; return url.href; }
      }
      // BBC and several others put the rendition width in the path.
      if (/bbci?\.co\.uk$/.test(url.hostname)) {
        const up = url.pathname.replace(/\/(\d{2,4})\//, (m, w) =>
          (Number(w) < 1536 ? '/1536/' : m));
        if (up !== url.pathname) { url.pathname = up; return url.href; }
      }
      // Query-string resizers: dropping the constraint returns the original.
      if (/[?&](w|width|resize|size)=\d+/.test(url.search)) {
        for (const k of ['w','width','h','height','resize','size','c','q','fit','crop','quality']) {
          url.searchParams.delete(k);
        }
        return url.href;
      }
      return null;
    } catch { return null; }
  };

  // Largest candidate a responsive image offers, usually far bigger than the
  // one the layout happened to pick.
  const fromSrcset = (img) => {
    const ss = img.getAttribute('srcset') || img.getAttribute('data-srcset') || '';
    let bestU = null, bestW = 0;
    for (const part of ss.split(',')) {
      const bits = part.trim().split(/\s+/);
      if (!bits[0]) continue;
      const w = bits[1] && bits[1].slice(-1) === 'w' ? parseInt(bits[1], 10) : 0;
      if (w > bestW) { bestW = w; bestU = bits[0]; }
    }
    return { url: bestU, width: bestW };
  };

  // Caption text, looking beyond <figure> because many CMSs do not use it.
  const captionOf = (img) => {
    const fig = img.closest('figure');
    if (fig) {
      const fc = fig.querySelector('figcaption');
      if (fc && fc.innerText && fc.innerText.trim()) return fc.innerText;
    }
    let node = img.parentElement;
    for (let d = 0; node && d < 3; d++, node = node.parentElement) {
      const el = node.querySelector('[class*="aption"],[class*="redit"],[data-component="caption"]');
      if (el && el.innerText && el.innerText.trim().length > 8) return el.innerText;
    }
    return '';
  };

  const images = [];
  const seen = new Set();
  for (const img of document.querySelectorAll('img')) {
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    // Small in layout is not small in truth; let the ranking upstream decide.
    if (w < 120 || h < 90) continue;
    const src = img.currentSrc || img.src;
    if (!src || src.slice(0, 5) === 'data:') continue;

    let chosen = abs(src);
    if (!chosen) continue;
    let maxWidth = w;
    let upgraded = false;

    const ss = fromSrcset(img);
    if (ss.url && ss.width > w) {
      const a = abs(ss.url);
      if (a) { chosen = a; maxWidth = ss.width; upgraded = true; }
    }
    const bigger = upgrade(chosen);
    if (bigger) { chosen = bigger; maxWidth = Math.max(maxWidth, 1280); upgraded = true; }

    if (seen.has(chosen)) continue;
    seen.add(chosen);

    images.push({
      url: chosen,
      alt: (img.alt || '').trim().slice(0, 300),
      width: w,
      height: h,
      maxWidth: maxWidth,
      upgraded: upgraded,
      caption: captionOf(img).trim().slice(0, 300)
    });
  }

  // Readable text: prefer article containers, strip furniture.
  const root =
    document.querySelector('article') ||
    document.querySelector('main') ||
    document.querySelector('[role="main"]') ||
    document.body;

  const clone = root.cloneNode(true);
  for (const el of clone.querySelectorAll(
    'script,style,nav,header,footer,aside,form,iframe,noscript,[aria-hidden="true"]'
  )) el.remove();

  const text = (clone.innerText || '')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 12000);

  return {
    title: document.title || meta('og:title'),
    description: meta('og:description', 'twitter:description', 'description'),
    text,
    images: images.slice(0, 60),
    ogImage: abs(meta('og:image:secure_url', 'og:image', 'twitter:image')) || null,
    published: meta('article:published_time', 'datePublished', 'pubdate') || null
  };
})()`

/** Opens one page offscreen and extracts its content. */
export async function readPage(url: string, timeoutMs = 12_000): Promise<PageContent> {
  const empty: PageContent = {
    url,
    title: '',
    description: '',
    text: '',
    images: [],
    ogImage: null,
    published: null
  }

  let win: BrowserWindow | null = null
  try {
    win = new BrowserWindow({
      show: false,
      width: 1440,
      height: 1000,
      webPreferences: {
        offscreen: true,
        // Untrusted third-party pages: no Node, no shared session, isolated.
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        javascript: true,
        images: true,
        webSecurity: true,
        partition: 'jarvis-scratch'
      }
    })

    // Some sites stall on trackers forever; resolve on dom-ready and move on.
    const loaded = new Promise<void>((resolve, reject) => {
      const done = (): void => resolve()
      win?.webContents.once('dom-ready', done)
      win?.webContents.once('did-fail-load', (_e, code, desc) =>
        reject(new Error(`${code} ${desc}`))
      )
      setTimeout(done, timeoutMs)
    })

    void win.loadURL(url, {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/122.0 Safari/537.36'
    })
    await loaded

    // Let lazy-loaded imagery settle after first paint.
    await new Promise((r) => setTimeout(r, 900))

    const raw = (await win.webContents.executeJavaScript(EXTRACT, true)) as Omit<
      PageContent,
      'url'
    >
    return { url, ...raw }
  } catch (err) {
    return {
      ...empty,
      failure: err instanceof Error ? err.message.slice(0, 200) : String(err)
    }
  } finally {
    if (win && !win.isDestroyed()) win.destroy()
  }
}

/**
 * Opens several pages at once.
 * Concurrency is capped because each page is a real renderer process.
 */
export async function readPages(urls: string[], concurrency = 4): Promise<PageContent[]> {
  const out: PageContent[] = []
  const queue = [...urls]
  const started = Date.now()

  async function worker(): Promise<void> {
    for (;;) {
      const next = queue.shift()
      if (!next) return
      out.push(await readPage(next))
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker))
  const ok = out.filter((p) => !p.failure && p.text.length > 200).length
  log(`browser: read ${ok}/${urls.length} pages in ${Date.now() - started}ms`)
  return out
}
