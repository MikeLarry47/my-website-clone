#!/usr/bin/env node
/**
 * Full offline site builder for truereligion.com
 *
 * Phase 1 — Crawl: Firecrawl fetches every page (JS-rendered HTML)
 * Phase 2 — Assets: download all CSS, JS, images, fonts referenced in pages
 *            CSS files are further parsed for @import / url() to catch fonts
 *            and background images
 * Phase 3 — Rewrite: every src/href/url() in HTML and CSS is replaced with
 *            a correct relative local path so the site works fully offline
 */

const FirecrawlApp = require('@mendable/firecrawl-js').default;
const cheerio     = require('cheerio');
const fs          = require('fs');
const path        = require('path');
const https       = require('https');
const http        = require('http');
const { URL }     = require('url');
const crypto      = require('crypto');

const ORIGIN  = 'https://www.truereligion.com';
const SITE    = path.join(__dirname, 'site');
const app     = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });

// ── Directory setup ──────────────────────────────────────────────────────────

for (const d of ['assets/css', 'assets/js', 'assets/images', 'assets/fonts']) {
  fs.mkdirSync(path.join(SITE, d), { recursive: true });
}

// ── Maps ─────────────────────────────────────────────────────────────────────

// originalAbsoluteUrl -> absolute local file path
const assetMap = new Map();
// cleanPageUrl -> local filename (e.g. "womens-new-arrivals.html")
const pageMap  = new Map();
// original CSS url string -> original CSS absolute URL (for relative resolution)
const cssOrigUrl = new Map();

// ── Utilities ────────────────────────────────────────────────────────────────

const md5 = str => crypto.createHash('md5').update(str).digest('hex').slice(0, 12);

function urlExt(u) {
  try { return path.extname(new URL(u).pathname) || ''; } catch { return ''; }
}

function resolveUrl(href, base) {
  if (!href) return null;
  const h = href.trim();
  if (!h || /^(data:|javascript:|mailto:|tel:|#)/.test(h)) return null;
  try { return new URL(h, base).href; } catch { return null; }
}

function pageSlug(url) {
  try {
    const p = new URL(url).pathname.replace(/^\/+|\/+$/g, '');
    if (!p || p === 'home') return 'index';
    return p.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-').slice(0, 120);
  } catch { return 'pg-' + md5(url); }
}

function localAssetPath(url, type) {
  const extMap = { css: '.css', js: '.js', images: '.jpg', fonts: '.woff2' };
  const ext = urlExt(url) || extMap[type] || '';
  return path.join(SITE, 'assets', type, md5(url) + ext);
}

function relPath(fromFile, toFile) {
  return path.relative(path.dirname(fromFile), toFile).replace(/\\/g, '/');
}

// ── Downloader ────────────────────────────────────────────────────────────────

const dlSeen = new Set();

async function fetchBuf(url, redirects = 0) {
  if (redirects > 5) throw new Error('too many redirects');
  return new Promise((resolve, reject) => {
    try {
      const proto = url.startsWith('https://') ? https : http;
      const req = proto.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        timeout: 20000,
      }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          req.destroy();
          const next = resolveUrl(res.headers.location, url) || res.headers.location;
          return fetchBuf(next, redirects + 1).then(resolve).catch(reject);
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ buf: Buffer.concat(chunks), status: res.statusCode }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    } catch (e) { reject(e); }
  });
}

async function downloadTo(url, dest) {
  if (dlSeen.has(url) || !url) return;
  dlSeen.add(url);
  if (fs.existsSync(dest)) return;
  try {
    const { buf, status } = await fetchBuf(url);
    if (status >= 200 && status < 300 && buf.length > 0) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
    }
  } catch (e) {
    process.stdout.write(`  ⚠ ${url.slice(0, 70)}: ${e.message}\n`);
  }
}

// ── CSS parsing ───────────────────────────────────────────────────────────────

function parseCssUrls(css, cssAbsUrl) {
  const fonts   = new Set();
  const images  = new Set();
  const imports = new Set();

  for (const m of css.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/gi)) {
    const u = resolveUrl(m[1], cssAbsUrl);
    if (!u) continue;
    if (/\.(woff2?|ttf|eot|otf)(\?.*)?$/i.test(u))           fonts.add(u);
    else if (/\.(png|jpe?g|gif|webp|svg|ico)(\?.*)?$/i.test(u)) images.add(u);
  }
  for (const m of css.matchAll(/@import\s+(?:url\()?["']?([^"');]+)["']?\)?/gi)) {
    const u = resolveUrl(m[1].trim(), cssAbsUrl);
    if (u) imports.add(u);
  }
  return { fonts, images, imports };
}

// ── HTML asset extraction ─────────────────────────────────────────────────────

function extractHtmlAssets(html, pageAbsUrl) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const css = new Set(), js = new Set(), images = new Set();

  $('link[rel="stylesheet"], link[as="style"]').each((_, el) => {
    const u = resolveUrl($(el).attr('href'), pageAbsUrl);
    if (u) css.add(u);
  });
  $('script[src]').each((_, el) => {
    const u = resolveUrl($(el).attr('src'), pageAbsUrl);
    if (u) js.add(u);
  });
  $('img, source').each((_, el) => {
    for (const attr of ['src', 'data-src', 'data-lazy']) {
      const u = resolveUrl($(el).attr(attr), pageAbsUrl);
      if (u && !/^data:/.test(u)) images.add(u);
    }
    const srcset = $(el).attr('srcset') || '';
    for (const part of srcset.split(',')) {
      const u = resolveUrl(part.trim().split(/\s+/)[0], pageAbsUrl);
      if (u) images.add(u);
    }
  });
  $('meta[property="og:image"], meta[name="twitter:image"]').each((_, el) => {
    const u = resolveUrl($(el).attr('content'), pageAbsUrl);
    if (u) images.add(u);
  });
  // inline style background-image
  $('[style]').each((_, el) => {
    const style = $(el).attr('style') || '';
    for (const m of style.matchAll(/url\(["']?([^"')]+)["']?\)/gi)) {
      const u = resolveUrl(m[1], pageAbsUrl);
      if (u) images.add(u);
    }
  });
  // <style> blocks
  $('style').each((_, el) => {
    const { images: imgs } = parseCssUrls($(el).html() || '', pageAbsUrl);
    for (const u of imgs) images.add(u);
  });

  return { css, js, images };
}

// ── HTML rewriter ─────────────────────────────────────────────────────────────

function rewriteHtml(html, htmlFile, pageAbsUrl) {
  const $ = cheerio.load(html, { decodeEntities: false });

  const rw = (rawHref) => {
    if (!rawHref) return rawHref;
    const h = rawHref.trim();
    if (/^(data:|javascript:|mailto:|tel:|#)/.test(h)) return h;

    const abs = resolveUrl(h, pageAbsUrl);
    if (!abs) return h;

    // Internal page link
    const cleanAbs = abs.split('?')[0].split('#')[0];
    if (pageMap.has(cleanAbs)) {
      return relPath(htmlFile, path.join(SITE, pageMap.get(cleanAbs)));
    }
    // Also check without lang param variant
    const noLang = cleanAbs.replace(/[?&]lang=[^&]*/g, '').split('?')[0];
    if (pageMap.has(noLang)) {
      return relPath(htmlFile, path.join(SITE, pageMap.get(noLang)));
    }

    // Asset lookup
    if (assetMap.has(abs)) {
      return relPath(htmlFile, assetMap.get(abs));
    }

    return h;
  };

  // Rewrite standard attributes
  $('[src]').each((_, el)  => { const v = rw($(el).attr('src'));  if (v) $(el).attr('src', v); });
  $('[href]').each((_, el) => { const v = rw($(el).attr('href')); if (v) $(el).attr('href', v); });
  $('[data-src]').each((_, el) => { const v = rw($(el).attr('data-src')); if (v) $(el).attr('data-src', v); });
  $('[action]').each((_, el) => { const v = rw($(el).attr('action')); if (v) $(el).attr('action', v); });

  // srcset
  $('[srcset]').each((_, el) => {
    const rewritten = ($(el).attr('srcset') || '').replace(/([^,\s]+)(\s+[\d.]+[wx])?/g, (m, u, d) => {
      const rUrl = rw(u);
      return (rUrl || u) + (d || '');
    });
    $(el).attr('srcset', rewritten);
  });

  // Inline styles
  $('[style]').each((_, el) => {
    const rewritten = ($(el).attr('style') || '').replace(/url\(\s*["']?([^"')]+)["']?\s*\)/gi, (m, u) => {
      const abs = resolveUrl(u, pageAbsUrl);
      if (abs && assetMap.has(abs)) return `url('${relPath(htmlFile, assetMap.get(abs))}')`;
      return m;
    });
    $(el).attr('style', rewritten);
  });

  // <style> blocks
  $('style').each((_, el) => {
    const cssText = $(el).html() || '';
    const rewritten = rewriteCssText(cssText, pageAbsUrl, htmlFile);
    $(el).html(rewritten);
  });

  // Remove <base> so our relative paths work
  $('base').remove();

  // Inject offline-mode note in <head>
  $('head').prepend(`<meta name="generator" content="Offline clone — Orion's">`);

  return $.html();
}

// ── CSS rewriter ──────────────────────────────────────────────────────────────

function rewriteCssText(css, cssAbsUrl, cssFile) {
  // Rewrite url() references
  let out = css.replace(/url\(\s*["']?([^"')\s]+)["']?\s*\)/gi, (match, raw) => {
    const abs = resolveUrl(raw, cssAbsUrl);
    if (!abs) return match;
    if (assetMap.has(abs)) {
      const localAbs = assetMap.get(abs);
      const rel = relPath(cssFile, localAbs);
      return `url('${rel}')`;
    }
    return match;
  });

  // Rewrite @import
  out = out.replace(/@import\s+(?:url\()?["']?([^"');]+)["']?\)?/gi, (match, raw) => {
    const abs = resolveUrl(raw.trim(), cssAbsUrl);
    if (!abs) return match;
    if (assetMap.has(abs)) {
      const rel = relPath(cssFile, assetMap.get(abs));
      return `@import url('${rel}')`;
    }
    return match;
  });

  return out;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('━'.repeat(60));
  console.log('  Orion\'s Full Offline Site Builder');
  console.log('━'.repeat(60));
  console.log();

  // ── Phase 1: Crawl ─────────────────────────────────────────────────────────
  console.log('Phase 1 — Crawling truereligion.com...');
  console.log('  (This will take a few minutes — Firecrawl renders JS for each page)\n');

  let crawlResult;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      crawlResult = await app.crawlUrl(ORIGIN, {
        limit: 100,
        scrapeOptions: { formats: ['html'], waitFor: 500 },
      });
      break;
    } catch (e) {
      if (e.message.includes('Rate limit') && attempt < 5) {
        const wait = 30 + attempt * 15;
        console.log(`  Rate limited — waiting ${wait}s then retrying (${attempt}/5)...`);
        await new Promise(r => setTimeout(r, wait * 1000));
      } else throw e;
    }
  }

  const pages = (crawlResult.data || []).filter(p => p.html && p.html.length > 500);
  console.log(`  ✓ Crawled ${pages.length} pages\n`);

  if (pages.length === 0) {
    console.error('  ✗ No pages returned. Check API key or Firecrawl limits.');
    process.exit(1);
  }

  // ── Build page map ─────────────────────────────────────────────────────────
  for (const page of pages) {
    const rawUrl  = page.metadata?.url || page.url || '';
    const clean   = rawUrl.split('?')[0].split('#')[0].replace(/\/+$/, '');
    const slug    = pageSlug(clean);
    const fname   = slug + '.html';
    for (const variant of [clean, clean + '/', clean + '?lang=default']) {
      pageMap.set(variant, fname);
      pageMap.set(variant.split('?')[0], fname);
    }
  }

  // ── Phase 2: Asset collection & download ───────────────────────────────────
  console.log('Phase 2 — Collecting & downloading assets...\n');

  const allCss    = new Set();
  const allJs     = new Set();
  const allImages = new Set();
  const allFonts  = new Set();

  for (const page of pages) {
    const base = page.metadata?.url || ORIGIN;
    const { css, js, images } = extractHtmlAssets(page.html, base);
    for (const u of css)    allCss.add(u);
    for (const u of js)     allJs.add(u);
    for (const u of images) allImages.add(u);
  }

  // ── CSS: download + parse for fonts & images ───────────────────────────────
  console.log(`  CSS: ${allCss.size} files`);
  const pendingCss = new Set(allCss);
  const processedCss = new Set();

  while (pendingCss.size > 0) {
    const batch = [...pendingCss];
    pendingCss.clear();

    for (const url of batch) {
      if (processedCss.has(url)) continue;
      processedCss.add(url);

      const dest = localAssetPath(url, 'css');
      await downloadTo(url, dest);
      assetMap.set(url, dest);

      if (fs.existsSync(dest)) {
        const text = fs.readFileSync(dest, 'utf8');
        const { fonts, images, imports } = parseCssUrls(text, url);
        for (const u of fonts)   allFonts.add(u);
        for (const u of images)  allImages.add(u);
        for (const u of imports) {
          if (!processedCss.has(u)) {
            pendingCss.add(u);
            allCss.add(u);
          }
        }
      }
    }
  }
  console.log(`     → also discovered fonts/images from CSS`);

  // ── Fonts ──────────────────────────────────────────────────────────────────
  console.log(`  Fonts: ${allFonts.size} files`);
  for (const url of allFonts) {
    const dest = localAssetPath(url, 'fonts');
    await downloadTo(url, dest);
    assetMap.set(url, dest);
  }

  // ── JS ─────────────────────────────────────────────────────────────────────
  console.log(`  JS:    ${allJs.size} files`);
  for (const url of allJs) {
    const dest = localAssetPath(url, 'js');
    await downloadTo(url, dest);
    assetMap.set(url, dest);
  }

  // ── Images ─────────────────────────────────────────────────────────────────
  console.log(`  Images: ${allImages.size} files`);
  let imgN = 0;
  for (const url of allImages) {
    const dest = localAssetPath(url, 'images');
    await downloadTo(url, dest);
    assetMap.set(url, dest);
    if (++imgN % 25 === 0) process.stdout.write(`     ${imgN}/${allImages.size} images\n`);
  }
  console.log(`     ${imgN}/${allImages.size} images done\n`);

  // ── Phase 3: Rewrite ───────────────────────────────────────────────────────
  console.log('Phase 3 — Rewriting paths...\n');

  // Rewrite CSS files
  for (const [cssUrl, cssFile] of assetMap) {
    if (!cssFile || !cssFile.endsWith('.css') || !fs.existsSync(cssFile)) continue;
    const original = fs.readFileSync(cssFile, 'utf8');
    const rewritten = rewriteCssText(original, cssUrl, cssFile);
    fs.writeFileSync(cssFile, rewritten);
  }
  console.log(`  ✓ CSS rewritten`);

  // Write HTML pages
  let pageCount = 0;
  for (const page of pages) {
    const rawUrl  = page.metadata?.url || page.url || '';
    const clean   = rawUrl.split('?')[0].split('#')[0].replace(/\/+$/, '');
    const fname   = pageMap.get(clean) || (pageSlug(clean) + '.html');
    const htmlFile = path.join(SITE, fname);

    const rewritten = rewriteHtml(page.html, htmlFile, rawUrl);
    fs.writeFileSync(htmlFile, rewritten);
    console.log(`  ✓ ${fname}`);
    pageCount++;
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log();
  console.log('━'.repeat(60));
  console.log('  Done!');
  console.log('━'.repeat(60));
  console.log(`  Pages:   ${pageCount}`);
  console.log(`  CSS:     ${[...assetMap.keys()].filter(k => assetMap.get(k)?.endsWith('.css')).length}`);
  console.log(`  JS:      ${allJs.size}`);
  console.log(`  Images:  ${imgN}`);
  console.log(`  Fonts:   ${allFonts.size}`);
  console.log();
  console.log(`  Open:    site/index.html`);
  console.log('━'.repeat(60));
}

main().catch(err => {
  console.error('\n✗ Fatal:', err.message);
  console.error(err.stack);
  process.exit(1);
});
