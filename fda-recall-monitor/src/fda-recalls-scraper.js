// Core FDA recall scrape/cache/filter logic. Kept as a self-contained file
// (only requires other files within this add-on's own folder) so the
// add-on can be built and installed on its own, independent of any other
// project.
//
// Exports a single function:
//   getMatchingRecalls({ terms, limit, cacheDir, maxAgeDays }) -> Promise<matches[]>

const fs = require("fs").promises;
const path = require("path");
const { logger } = require("./logger.js");
const { buildTermMatchers } = require("./utils.js");

const PAGE_URL = "https://www.fda.gov/safety/recalls-market-withdrawals-safety-alerts";
const AJAX_URL = "https://www.fda.gov/datatables/views/ajax";
const BASE = "https://www.fda.gov";
const DETAIL_FETCH_CONCURRENCY = 2;
const DETAIL_FETCH_DELAY_MS = 500;

async function fetchPage(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  return res.text();
}

const HTML_ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#039;": "'",
  "&nbsp;": " ",
};

function decodeEntities(text) {
  return text.replace(/&(?:amp|lt|gt|quot|#039|nbsp);/g, (m) => HTML_ENTITIES[m]);
}

function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

async function loadManifest(manifestPath) {
  try {
    return JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch {
    return {};
  }
}

async function saveManifest(manifestPath, pagesDir, manifest) {
  await fs.mkdir(pagesDir, { recursive: true });
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}

function slugFromUrl(url) {
  return new URL(url).pathname.split("/").filter(Boolean).pop();
}

// Detail pages carry FDA's own metadata in their <head> — a stable node
// ID and the dates FDA itself published/last modified the page. Cheap to
// grab while we already have the HTML, and fdaModifiedDate is exactly the
// signal a future cache-refresh feature would need to detect a page that
// changed upstream after we cached it. Each field is optional: return null
// rather than throwing if the markup doesn't have it.
function extractDetailMetadata(html) {
  const nodeIdMatch = html.match(/<link rel="shortlink" href="[^"]*\/node\/(\d+)"/);
  const publishedMatch = html.match(/<meta property="article:published_time" content="([^"]+)"/);
  const modifiedMatch = html.match(/<meta property="article:modified_time" content="([^"]+)"/);
  return {
    fdaNodeId: nodeIdMatch ? nodeIdMatch[1] : null,
    fdaPublishedDate: publishedMatch ? publishedMatch[1] : null,
    fdaModifiedDate: modifiedMatch ? modifiedMatch[1] : null,
  };
}

// The DataTables AJAX request needs several view_* identifiers that come
// from the page's own Drupal settings blob (drupalSettings.views.ajaxViews
// / drupalSettings.datatables) rather than anything guessable — pulled out
// here so a future markup change just needs this regex/JSON.parse to keep
// working, instead of us hardcoding IDs that could go stale.
function extractAjaxConfig(pageHtml) {
  const scriptMatch = pageHtml.match(
    /<script type="application\/json" data-drupal-selector="drupal-settings-json">([\s\S]*?)<\/script>/,
  );
  if (!scriptMatch) {
    throw new Error("Could not find drupal-settings-json on the page — markup may have changed.");
  }
  const settings = JSON.parse(scriptMatch[1]);
  const tables = settings.datatables || {};
  const domId = Object.keys(tables).find((id) => tables[id].datatable_selector === "#datatable");
  if (!domId) {
    throw new Error("Could not find #datatable's config in drupalSettings.datatables.");
  }
  const config = tables[domId];
  if (!config.serverSide || !config.ajax || !config.ajax.url) {
    throw new Error("#datatable is not configured for server-side AJAX as expected.");
  }
  return config.ajax.data;
}

// Each row from the AJAX endpoint is an array of column HTML strings in
// the same order as the visible table: date, brand link, product
// description, product type, recall reason, company name, terminated
// recall, excerpt.
function parseRow(cols) {
  const dateMatch = cols[0].match(/<time[^>]*>([^<]+)<\/time>/);
  const linkMatch = cols[1].match(/<a href="([^"]+)"[^>]*>([^<]*)<\/a>/);
  if (!dateMatch || !linkMatch) {
    return null;
  }
  return {
    date: dateMatch[1].trim(),
    brand: decodeEntities(linkMatch[2].trim()),
    url: new URL(linkMatch[1], BASE).href,
    productDescription: htmlToText(cols[2]),
    productType: htmlToText(cols[3]),
    recallReason: htmlToText(cols[4]),
    companyName: htmlToText(cols[5]),
  };
}

async function fetchListingRows(ajaxData, limit) {
  const params = new URLSearchParams({
    ...ajaxData,
    total_items: String(ajaxData.total_items),
    draw: "1",
    start: "0",
    length: String(limit),
  });

  const res = await fetch(`${AJAX_URL}?${params.toString()}`, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching listing data`);
  }
  const body = await res.json();
  return body.data.map(parseRow).filter(Boolean);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Paces actual network fetches of detail pages so no two start less than
// DETAIL_FETCH_DELAY_MS apart — FDA's detail pages 403 fairly readily
// under a burst of requests, so capping concurrency alone wasn't enough to
// stay under their rate limit. Cache hits never call this, so they aren't
// subject to the delay.
let lastDetailDispatch = 0;
async function throttledFetchPage(url) {
  const wait = Math.max(0, lastDetailDispatch + DETAIL_FETCH_DELAY_MS - Date.now());
  lastDetailDispatch = Date.now() + wait;
  if (wait > 0) {
    await sleep(wait);
  }
  return fetchPage(url);
}

// Returns a row's detail page HTML, using the on-disk cache when this URL
// has already been crawled and otherwise fetching it (subject to the
// throttle above), caching it to disk, and recording it in `manifest`.
// `manifest` is mutated in place rather than persisted here — the caller
// saves it once after all rows are processed.
async function getDetailHtml(row, manifest, cacheDir, pagesDir) {
  const cached = manifest[row.url];
  if (cached) {
    return fs.readFile(path.join(cacheDir, cached.cachedPath), "utf8");
  }

  const html = await throttledFetchPage(row.url);
  const slug = slugFromUrl(row.url);
  const cachedPath = path.join("pages", `${slug}.html`);
  await fs.mkdir(pagesDir, { recursive: true });
  await fs.writeFile(path.join(cacheDir, cachedPath), html);

  const now = new Date().toISOString();
  manifest[row.url] = {
    url: row.url,
    cachedPath,
    firstCrawledDate: now,
    updatedDate: now,
    ...extractDetailMetadata(html),
  };

  return html;
}

// Deletes any manifest entry (and its cached HTML file) whose
// firstCrawledDate is older than maxAgeDays, mutating `manifest` in
// place. maxAgeDays of 0/undefined disables pruning entirely — the
// default, matching this cache's original never-expires behavior.
// Returns how many entries were pruned.
async function pruneExpiredEntries(manifest, cacheDir, maxAgeDays) {
  if (!maxAgeDays) {
    return 0;
  }
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let prunedCount = 0;
  for (const [url, entry] of Object.entries(manifest)) {
    const crawledAt = new Date(entry.firstCrawledDate).getTime();
    if (Number.isFinite(crawledAt) && crawledAt < cutoff) {
      try {
        await fs.unlink(path.join(cacheDir, entry.cachedPath));
      } catch {
        // already gone — fine, the manifest entry is being removed either way
      }
      delete manifest[url];
      prunedCount++;
    }
  }
  return prunedCount;
}

// Runs `worker` over `items` with at most `limit` in flight at once.
async function mapWithConcurrency(items, limit, worker) {
  const results = Array.from({ length: items.length });
  let nextIndex = 0;

  async function runNext() {
    const i = nextIndex++;
    if (i >= items.length) {
      return;
    }
    results[i] = await worker(items[i], i);
    await runNext();
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
  return results;
}

// terms: array of whole-word, case-sensitive search terms (ANY match wins).
// limit: how many listing rows to pull before filtering.
// cacheDir: directory for the detail-page cache + manifest.json (created if missing).
// maxAgeDays: prune cached detail pages older than this many days (0/undefined = never).
async function getMatchingRecalls({ terms, limit, cacheDir, maxAgeDays }) {
  const pagesDir = path.join(cacheDir, "pages");
  const manifestPath = path.join(cacheDir, "manifest.json");

  const pageHtml = await fetchPage(PAGE_URL);
  const ajaxData = extractAjaxConfig(pageHtml);

  const rows = await fetchListingRows(ajaxData, limit);
  if (rows.length === 0) {
    throw new Error(
      "No rows returned from the listing endpoint — page structure may have changed.",
    );
  }

  const manifest = await loadManifest(manifestPath);

  const prunedCount = await pruneExpiredEntries(manifest, cacheDir, maxAgeDays);
  if (prunedCount > 0) {
    logger.info("Pruned expired cache entries", { prunedCount });
  }

  const termMatchers = buildTermMatchers(terms);

  const checked = await mapWithConcurrency(rows, DETAIL_FETCH_CONCURRENCY, async (row) => {
    let detailText;
    try {
      detailText = htmlToText(await getDetailHtml(row, manifest, cacheDir, pagesDir));
    } catch (err) {
      logger.warn("Failed to fetch recall detail page", { url: row.url, err });
      return null;
    }
    const matchedTerms = terms.filter((t, i) => termMatchers[i].test(detailText));
    return matchedTerms.length > 0 ? { ...row, matchedTerms } : null;
  });

  await saveManifest(manifestPath, pagesDir, manifest);

  return checked.filter(Boolean);
}

module.exports = getMatchingRecalls;
