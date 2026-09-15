// Home Assistant add-on entry point: reads the configured filter terms and
// scan interval from Supervisor-provided options, periodically scans both
// FDA's recall listing page (fda-recalls-scraper.js) and openFDA's food/drug/
// device enforcement APIs (fda-api.js) — the two sources have been found
// to disagree in both directions, so neither alone is a complete picture
// — merges their results, and pushes the count of new (not yet
// acknowledged) matching recalls, plus per-recall detail attributes, to
// sensor.fda_recall_count via Home Assistant Core's REST API, proxied
// through the Supervisor. Also runs a small HTTP server so an
// "acknowledge" action (e.g. a dashboard button via a rest_command) can
// mark the currently-shown recalls as seen, dropping the sensor back to 0
// until a genuinely new recall shows up.

const fs = require("fs");
const http = require("http");
const getMatchingRecalls = require("./fda-recalls-scraper.js");
const getMatchingRecallsFromApi = require("./fda-api.js");
const { logger } = require("./logger.js");
const acknowledged = require("./acknowledged.js");

const OPTIONS_PATH = "/data/options.json";
const CACHE_DIR = "/data/fda-recalls-cache";
const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN;
const ENTITY_ID = "sensor.fda_recall_count";
const LIMIT = 25; // not user-configurable; fixed page-scraper listing-row count per scan
const API_LIMIT = 50; // not user-configurable; fixed openFDA row count per category per scan
// Kept small deliberately — this only needs to support a quick-glance
// dashboard card and automations. The full, unbounded list lives at
// GET /recalls instead (see renderRecallsPage below), which isn't subject
// to Home Assistant's ~16KB recorder-history attribute-size warning since
// it isn't a state attribute at all.
const MAX_ATTRIBUTE_RECALLS = 10;
const SERVER_PORT = 8099;

let acknowledgedIds = acknowledged.load();
let lastMatches = [];
let lastFilterTerms = [];
let lastAcknowledged = null;

function computeNewMatches(matches) {
  return matches.filter((m) => !acknowledgedIds.has(m.id));
}

async function pushState(matches, newMatches, filterTerms) {
  const body = {
    state: newMatches.length,
    attributes: {
      friendly_name: "FDA Recall Count",
      unit_of_measurement: "recalls",
      icon: "mdi:alert-circle-outline",
      filter_terms: filterTerms,
      last_checked: new Date().toISOString(),
      last_acknowledged: lastAcknowledged,
      total_matching_recalls: matches.length,
      recalls: matches
        .toSorted((a, b) => {
          const aNew = !acknowledgedIds.has(a.id);
          const bNew = !acknowledgedIds.has(b.id);
          if (aNew !== bNew) {
            return aNew ? -1 : 1;
          }
          const dateA = a.date ? new Date(a.date) : 0;
          const dateB = b.date ? new Date(b.date) : 0;
          return dateB - dateA;
        })
        .slice(0, MAX_ATTRIBUTE_RECALLS)
        .map((m) => ({
          date: m.date,
          brand: m.brand,
          productDescription: m.productDescription,
          recallReason: m.recallReason,
          url: m.url,
          source: m.source,
          category: m.category || null,
          recallNumber: m.recallNumber || null,
          classification: m.classification || null,
          isNew: !acknowledgedIds.has(m.id),
        })),
    },
  };

  try {
    const res = await fetch(`http://supervisor/core/api/states/${ENTITY_ID}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SUPERVISOR_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      logger.error("Failed to update sensor state", { entityId: ENTITY_ID, status: res.status });
    }
  } catch (err) {
    // Never let a network hiccup here fail the caller — acknowledging is
    // already persisted to disk by this point (handleAcknowledge saves
    // before calling pushState), and the next scan will retry the push.
    logger.error("Failed to reach Home Assistant to update sensor state", err);
  }
}

async function runOnce() {
  const options = JSON.parse(fs.readFileSync(OPTIONS_PATH, "utf8"));
  const filterTerms = (options.filter || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  lastFilterTerms = filterTerms;

  if (filterTerms.length === 0) {
    logger.warn(
      "No filter configured — set the 'filter' option in this add-on's Configuration tab.",
    );
    lastMatches = [];
    await pushState([], [], []);
    return options.scan_interval_minutes;
  }

  let pageMatches = [];
  try {
    const rawPageMatches = await getMatchingRecalls({
      terms: filterTerms,
      limit: LIMIT,
      cacheDir: CACHE_DIR,
      maxAgeDays: options.cache_max_age_days,
    });
    pageMatches = rawPageMatches.map((m) => ({ ...m, source: "page", id: m.url }));
  } catch (err) {
    logger.error("Page scraper scan failed", err);
  }

  let apiMatches = [];
  try {
    apiMatches = await getMatchingRecallsFromApi({
      terms: filterTerms,
      limit: API_LIMIT,
      apiKey: options.openfda_api_key,
    });
  } catch (err) {
    logger.error("openFDA API scan failed", err);
  }

  const matches = [...pageMatches, ...apiMatches];

  for (const m of matches) {
    logger.info("Recall matched filter", {
      source: m.source,
      id: m.id,
      brand: m.brand,
      matchedTerms: m.matchedTerms,
    });
  }

  const newMatches = computeNewMatches(matches);
  lastMatches = matches;
  logger.info("Scan complete", {
    matchCount: matches.length,
    newCount: newMatches.length,
    pageCount: pageMatches.length,
    apiCount: apiMatches.length,
    filterTerms,
  });
  await pushState(matches, newMatches, filterTerms);

  return options.scan_interval_minutes;
}

function escapeHtml(text) {
  return String(text ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[c],
  );
}

// Full, unbounded HTML listing of the latest scan's matches — meant to be
// embedded via a Lovelace "iframe" card, since none of Home Assistant's
// built-in cards can fetch arbitrary data themselves. Recall text comes
// from external FDA sources, so everything is HTML-escaped before
// insertion.
function renderRecallsPage() {
  const newCount = computeNewMatches(lastMatches).length;
  const sorted = lastMatches.toSorted((a, b) => {
    const dateA = a.date ? new Date(a.date) : 0;
    const dateB = b.date ? new Date(b.date) : 0;
    return dateB - dateA;
  });

  const rows = sorted
    .map((m) => {
      const isNew = !acknowledgedIds.has(m.id);
      const linkText = m.recallNumber || "details";
      const reference = m.url
        ? `<a href="${escapeHtml(m.url)}" target="_blank" rel="noopener">${escapeHtml(linkText)}</a>`
        : escapeHtml(m.recallNumber || "no reference");
      const categoryBadge = m.category ? ` &middot; ${escapeHtml(m.category)}` : "";
      return `
        <li class="${isNew ? "new" : ""}">
          <div class="meta">${escapeHtml(m.date || "")} &middot; ${escapeHtml(m.source)}${categoryBadge}${isNew ? ' <span class="badge">NEW</span>' : ""}</div>
          <div class="brand">${escapeHtml(m.brand || "")}</div>
          <div class="desc">${escapeHtml(m.productDescription || "")}</div>
          <div class="reason">${escapeHtml(m.recallReason || "")}</div>
          <div class="ref">${reference}</div>
        </li>`;
    })
    .join("\n");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="light dark">
<title>FDA Recalls</title>
<style>
  :root {
    --bg: #fafafa;
    --card-bg: #ffffff;
    --primary-text: #212121;
    --secondary-text: #727272;
    --divider: #e0e0e0;
    --accent: #03a9f4;
    --accent-text: #ffffff;
    --new-border: #ffa600;
    --badge-bg: #db4437;
    --badge-text: #ffffff;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #111111;
      --card-bg: #1c1c1c;
      --primary-text: #e1e1e1;
      --secondary-text: #9b9b9b;
      --divider: #333333;
      --accent: #58a6ff;
      --accent-text: #000000;
      --new-border: #ffb74d;
      --badge-bg: #cf6679;
      --badge-text: #000000;
    }
  }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    margin: 0;
    padding: 1rem;
    background: var(--bg);
    color: var(--primary-text);
  }
  h1 { font-size: 1.1rem; font-weight: 500; margin: 0 0 0.75rem; }
  .summary {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
    margin-bottom: 1rem;
    color: var(--secondary-text);
    font-size: 0.9rem;
  }
  .summary strong { color: var(--primary-text); }
  button {
    font-family: inherit;
    font-size: 0.85rem;
    font-weight: 500;
    padding: 0.5rem 1rem;
    cursor: pointer;
    background: var(--accent);
    color: var(--accent-text);
    border: none;
    border-radius: 20px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  button:hover { filter: brightness(1.08); }
  ul { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.5rem; }
  li {
    background: var(--card-bg);
    border-radius: 8px;
    padding: 0.75rem 1rem;
    border: 1px solid var(--divider);
  }
  li.new { border-left: 4px solid var(--new-border); }
  .meta { font-size: 0.75rem; color: var(--secondary-text); margin-bottom: 0.15rem; }
  .badge {
    background: var(--badge-bg);
    color: var(--badge-text);
    border-radius: 10px;
    padding: 0 6px;
    font-size: 0.7rem;
    font-weight: 600;
  }
  .brand { font-weight: 600; margin-bottom: 0.15rem; }
  .desc { font-size: 0.9rem; margin-bottom: 0.15rem; }
  .reason { font-size: 0.85rem; color: var(--secondary-text); margin-bottom: 0.3rem; }
  a { color: var(--accent); }
</style>
</head>
<body>
  <h1>FDA Recalls</h1>
  <div class="summary">
    <span><strong>${newCount}</strong> new recall(s) out of <strong>${sorted.length}</strong> total matching (${escapeHtml(lastFilterTerms.join(", "))})</span>
    <button id="ack">Acknowledge All</button>
  </div>
  <ul>${rows || "<li>No matching recalls.</li>"}</ul>
  <script>
    document.getElementById("ack").addEventListener("click", async () => {
      const res = await fetch("/acknowledge", { method: "POST" });
      if (res.ok) {
        location.reload();
      } else {
        alert("Failed to acknowledge — check the add-on's log.");
      }
    });
  </script>
</body>
</html>`;
}

async function handleAcknowledge(res) {
  const acknowledgedCount = lastMatches.length;
  for (const m of lastMatches) {
    acknowledgedIds.add(m.id);
  }
  acknowledged.save(acknowledgedIds);
  lastAcknowledged = new Date().toISOString();
  logger.info("Recalls acknowledged", { acknowledgedCount });

  await pushState(lastMatches, [], lastFilterTerms);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, acknowledgedCount }));
}

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("FDA Recall Monitor add-on is running.");
      return;
    }
    if (req.method === "GET" && req.url === "/recalls") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderRecallsPage());
      return;
    }
    if (req.method === "POST" && req.url === "/acknowledge") {
      handleAcknowledge(res).catch((err) => {
        logger.error("Acknowledge request failed", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });
  server.listen(SERVER_PORT, "0.0.0.0", () => {
    logger.info("HTTP server listening", { port: SERVER_PORT });
  });
  return server;
}

async function main() {
  startServer();
  for (;;) {
    const intervalMinutes = await runOnce();
    await new Promise((resolve) => setTimeout(resolve, intervalMinutes * 60 * 1000));
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  computeNewMatches,
  pushState,
  runOnce,
  escapeHtml,
  renderRecallsPage,
  handleAcknowledge,
  startServer,
  main,
};
