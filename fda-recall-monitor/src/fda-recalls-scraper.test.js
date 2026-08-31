// Uses real, downloaded FDA fixtures (fixtures/fda-listing-page.html,
// fda-ajax-response.json, fda-detail-page.html) rather than hand-authored
// markup, so the drupalSettings/#datatable extraction and AJAX row parsing
// are exercised against actual FDA site structure. Error-branch tests
// derive minimal mutations of the real listing-page fixture (e.g. strip
// the settings script, delete the #datatable key) instead of inventing
// new markup from scratch.
const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const getMatchingRecalls = require("./fda-recalls-scraper.js");
const { logger } = require("./logger.js");

const PAGE_URL = "https://www.fda.gov/safety/recalls-market-withdrawals-safety-alerts";
const AJAX_URL = "https://www.fda.gov/datatables/views/ajax";
const MANGO_ROW_URL =
  "https://www.fda.gov/safety/recalls-market-withdrawals-safety-alerts/panorama-produce-recalls-mangoes-due-possible-salmonella-contamination";
const SPROUTS_ROW_URL =
  "https://www.fda.gov/safety/recalls-market-withdrawals-safety-alerts/everything-sprouts-llc-expands-voluntarily-recall-include-robust-radish-mix-due-potential-e-coli-and";

const fixturesDir = path.join(__dirname, "fixtures");
const pageHtmlFixture = fs.readFileSync(path.join(fixturesDir, "fda-listing-page.html"), "utf8");
const ajaxFixture = JSON.parse(
  fs.readFileSync(path.join(fixturesDir, "fda-ajax-response.json"), "utf8"),
);
const detailHtmlFixture = fs.readFileSync(path.join(fixturesDir, "fda-detail-page.html"), "utf8");

const SETTINGS_SCRIPT_RE =
  /<script type="application\/json" data-drupal-selector="drupal-settings-json">([\s\S]*?)<\/script>/;

function makeTmpCacheDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fda-recalls-test-"));
}

function singleRowAjax(rowIndex = 0) {
  return { ...ajaxFixture, data: [ajaxFixture.data[rowIndex]] };
}

// Rewrites the real listing-page fixture's drupalSettings JSON via `mutate`,
// so structural error-path tests use a minimal edit of real markup rather
// than a hand-authored page.
function pageHtmlWithMutatedSettings(mutate) {
  const scriptMatch = pageHtmlFixture.match(SETTINGS_SCRIPT_RE);
  const settings = JSON.parse(scriptMatch[1]);
  mutate(settings);
  return pageHtmlFixture.replace(scriptMatch[1], JSON.stringify(settings));
}

function pageHtmlWithoutSettingsScript() {
  return pageHtmlFixture.replace(SETTINGS_SCRIPT_RE, "<script>window.foo = 1;</script>");
}

// options:
//   pageResponse: override for the listing-page fetch ({ ok, text } / { ok, status })
//   ajaxResponse: override for the AJAX fetch ({ ok, json } / { ok, status })
//   detailHtml: url -> html string override (default: the real detail fixture for any URL)
//   detailFail: Set of urls whose detail fetch should throw
function stubFetch({ pageResponse, ajaxResponse, detailHtml = {}, detailFail = new Set() } = {}) {
  const original = global.fetch;
  const detailCalls = [];
  global.fetch = async (url) => {
    if (url === PAGE_URL) {
      return pageResponse || { ok: true, text: async () => pageHtmlFixture };
    }
    if (url.startsWith(AJAX_URL)) {
      return ajaxResponse || { ok: true, json: async () => ajaxFixture };
    }
    detailCalls.push(url);
    if (detailFail.has(url)) {
      throw new Error(`simulated network failure for ${url}`);
    }
    const html = Object.prototype.hasOwnProperty.call(detailHtml, url)
      ? detailHtml[url]
      : detailHtmlFixture;
    return { ok: true, text: async () => html };
  };
  return { restore: () => (global.fetch = original), detailCalls };
}

describe("getMatchingRecalls", () => {
  test("happy path: scans, matches terms, decodes entities, and writes cache files", async (t) => {
    const cacheDir = makeTmpCacheDir();
    t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
    const { restore } = stubFetch({
      ajaxResponse: { ok: true, json: async () => singleRowAjax() },
    });
    t.after(restore);

    const matches = await getMatchingRecalls({
      terms: ["Salmonella"],
      limit: 5,
      cacheDir,
      maxAgeDays: 0,
    });

    assert.equal(matches.length, 1);
    const [m] = matches;
    assert.equal(m.brand, "Martina");
    assert.equal(m.url, MANGO_ROW_URL);
    assert.deepEqual(m.matchedTerms, ["Salmonella"]);
    // cols[3] in the real fixture is "Food &amp; Beverages, Foodborne Illness" — confirms decodeEntities ran.
    assert.equal(m.productType, "Food & Beverages, Foodborne Illness");

    const manifestPath = path.join(cacheDir, "manifest.json");
    assert.ok(fs.existsSync(manifestPath));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.ok(manifest[MANGO_ROW_URL]);
    assert.equal(manifest[MANGO_ROW_URL].fdaNodeId, "429763");
    assert.ok(fs.existsSync(path.join(cacheDir, manifest[MANGO_ROW_URL].cachedPath)));
  });

  test("extractAjaxConfig throws when drupal-settings-json script is missing", async (t) => {
    const cacheDir = makeTmpCacheDir();
    t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
    const { restore } = stubFetch({
      pageResponse: { ok: true, text: async () => pageHtmlWithoutSettingsScript() },
    });
    t.after(restore);

    await assert.rejects(
      getMatchingRecalls({ terms: ["Salmonella"], limit: 5, cacheDir, maxAgeDays: 0 }),
      /Could not find drupal-settings-json/,
    );
  });

  test("extractAjaxConfig throws when no entry targets #datatable", async (t) => {
    const cacheDir = makeTmpCacheDir();
    t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
    const mutatedHtml = pageHtmlWithMutatedSettings((settings) => {
      for (const table of Object.values(settings.datatables || {})) {
        table.datatable_selector = "#not-datatable";
      }
    });
    const { restore } = stubFetch({ pageResponse: { ok: true, text: async () => mutatedHtml } });
    t.after(restore);

    await assert.rejects(
      getMatchingRecalls({ terms: ["Salmonella"], limit: 5, cacheDir, maxAgeDays: 0 }),
      /Could not find #datatable's config/,
    );
  });

  test("extractAjaxConfig throws when #datatable isn't configured for server-side AJAX", async (t) => {
    const cacheDir = makeTmpCacheDir();
    t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
    const mutatedHtml = pageHtmlWithMutatedSettings((settings) => {
      const domId = Object.keys(settings.datatables).find(
        (id) => settings.datatables[id].datatable_selector === "#datatable",
      );
      settings.datatables[domId].serverSide = false;
    });
    const { restore } = stubFetch({ pageResponse: { ok: true, text: async () => mutatedHtml } });
    t.after(restore);

    await assert.rejects(
      getMatchingRecalls({ terms: ["Salmonella"], limit: 5, cacheDir, maxAgeDays: 0 }),
      /not configured for server-side AJAX/,
    );
  });

  test("throws when the listing page fetch is non-ok", async (t) => {
    const cacheDir = makeTmpCacheDir();
    t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
    const { restore } = stubFetch({ pageResponse: { ok: false, status: 503 } });
    t.after(restore);

    await assert.rejects(
      getMatchingRecalls({ terms: ["Salmonella"], limit: 5, cacheDir, maxAgeDays: 0 }),
      /HTTP 503 fetching/,
    );
  });

  test("throws when the AJAX listing fetch is non-ok", async (t) => {
    const cacheDir = makeTmpCacheDir();
    t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
    const { restore } = stubFetch({ ajaxResponse: { ok: false, status: 500 } });
    t.after(restore);

    await assert.rejects(
      getMatchingRecalls({ terms: ["Salmonella"], limit: 5, cacheDir, maxAgeDays: 0 }),
      /HTTP 500 fetching listing data/,
    );
  });

  test("throws when the listing endpoint returns zero rows", async (t) => {
    const cacheDir = makeTmpCacheDir();
    t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
    const { restore } = stubFetch({ ajaxResponse: { ok: true, json: async () => ({ data: [] }) } });
    t.after(restore);

    await assert.rejects(
      getMatchingRecalls({ terms: ["Salmonella"], limit: 5, cacheDir, maxAgeDays: 0 }),
      /No rows returned from the listing endpoint/,
    );
  });

  test("parseRow skips a malformed row (missing date/link) without failing the scan", async (t) => {
    const cacheDir = makeTmpCacheDir();
    t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
    const malformedRow = [
      "not a time cell",
      '<a href="/x">no closing tag issue but no time above',
      "",
      "",
      "",
      "",
      "",
      "",
    ];
    const ajaxResponse = {
      ok: true,
      json: async () => ({ ...ajaxFixture, data: [ajaxFixture.data[0], malformedRow] }),
    };
    const { restore } = stubFetch({ ajaxResponse });
    t.after(restore);

    const matches = await getMatchingRecalls({
      terms: ["Salmonella"],
      limit: 5,
      cacheDir,
      maxAgeDays: 0,
    });

    assert.equal(matches.length, 1);
    assert.equal(matches[0].url, MANGO_ROW_URL);
  });

  test("cache hit: reads detail HTML from disk instead of fetching it", async (t) => {
    const cacheDir = makeTmpCacheDir();
    t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(cacheDir, "pages"), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "pages", "mango.html"), detailHtmlFixture);
    fs.writeFileSync(
      path.join(cacheDir, "manifest.json"),
      JSON.stringify({
        [MANGO_ROW_URL]: {
          url: MANGO_ROW_URL,
          cachedPath: path.join("pages", "mango.html"),
          firstCrawledDate: new Date().toISOString(),
          updatedDate: new Date().toISOString(),
          fdaNodeId: "429763",
          fdaPublishedDate: null,
          fdaModifiedDate: null,
        },
      }),
    );

    const { restore, detailCalls } = stubFetch({
      ajaxResponse: { ok: true, json: async () => singleRowAjax() },
    });
    t.after(restore);

    const matches = await getMatchingRecalls({
      terms: ["Salmonella"],
      limit: 5,
      cacheDir,
      maxAgeDays: 0,
    });

    assert.equal(matches.length, 1);
    assert.equal(detailCalls.length, 0);
  });

  test("a detail-page fetch failure excludes that row but keeps others, and logs a warning", async (t) => {
    const cacheDir = makeTmpCacheDir();
    t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
    const ajaxResponse = {
      ok: true,
      json: async () => ({ ...ajaxFixture, data: ajaxFixture.data.slice(0, 2) }),
    };
    const { restore } = stubFetch({ ajaxResponse, detailFail: new Set([SPROUTS_ROW_URL]) });
    t.after(restore);
    const warnMock = t.mock.method(logger, "warn", () => {});

    const matches = await getMatchingRecalls({
      terms: ["Salmonella"],
      limit: 5,
      cacheDir,
      maxAgeDays: 0,
    });

    assert.equal(matches.length, 1);
    assert.equal(matches[0].url, MANGO_ROW_URL);
    assert.equal(warnMock.mock.calls.length, 1);
    assert.equal(warnMock.mock.calls[0].arguments[1].url, SPROUTS_ROW_URL);
  });

  test("pruneExpiredEntries deletes stale manifest entries and their cached files", async (t) => {
    const cacheDir = makeTmpCacheDir();
    t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(cacheDir, "pages"), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "pages", "mango.html"), detailHtmlFixture);
    fs.writeFileSync(path.join(cacheDir, "pages", "stale.html"), "<html>stale</html>");
    const staleUrl =
      "https://www.fda.gov/safety/recalls-market-withdrawals-safety-alerts/stale-recall";
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(
      path.join(cacheDir, "manifest.json"),
      JSON.stringify({
        [MANGO_ROW_URL]: {
          url: MANGO_ROW_URL,
          cachedPath: path.join("pages", "mango.html"),
          firstCrawledDate: new Date().toISOString(),
          updatedDate: new Date().toISOString(),
        },
        [staleUrl]: {
          url: staleUrl,
          cachedPath: path.join("pages", "stale.html"),
          firstCrawledDate: oldDate,
          updatedDate: oldDate,
        },
      }),
    );
    const { restore } = stubFetch({
      ajaxResponse: { ok: true, json: async () => singleRowAjax() },
    });
    t.after(restore);
    const infoMock = t.mock.method(logger, "info", () => {});

    await getMatchingRecalls({ terms: ["Salmonella"], limit: 5, cacheDir, maxAgeDays: 7 });

    const manifest = JSON.parse(fs.readFileSync(path.join(cacheDir, "manifest.json"), "utf8"));
    assert.ok(!manifest[staleUrl]);
    assert.ok(!fs.existsSync(path.join(cacheDir, "pages", "stale.html")));
    assert.ok(infoMock.mock.calls.some((c) => c.arguments[0] === "Pruned expired cache entries"));
  });

  test("maxAgeDays 0 disables pruning entirely", async (t) => {
    const cacheDir = makeTmpCacheDir();
    t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(cacheDir, "pages"), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "pages", "mango.html"), detailHtmlFixture);
    const staleUrl =
      "https://www.fda.gov/safety/recalls-market-withdrawals-safety-alerts/stale-recall";
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(
      path.join(cacheDir, "manifest.json"),
      JSON.stringify({
        [MANGO_ROW_URL]: {
          url: MANGO_ROW_URL,
          cachedPath: path.join("pages", "mango.html"),
          firstCrawledDate: new Date().toISOString(),
          updatedDate: new Date().toISOString(),
        },
        [staleUrl]: {
          url: staleUrl,
          cachedPath: path.join("pages", "missing.html"),
          firstCrawledDate: oldDate,
          updatedDate: oldDate,
        },
      }),
    );
    const { restore } = stubFetch({
      ajaxResponse: { ok: true, json: async () => singleRowAjax() },
    });
    t.after(restore);

    await getMatchingRecalls({ terms: ["Salmonella"], limit: 5, cacheDir, maxAgeDays: 0 });

    const manifest = JSON.parse(fs.readFileSync(path.join(cacheDir, "manifest.json"), "utf8"));
    assert.ok(manifest[staleUrl]);
  });

  test("pruning tolerates a manifest entry whose cached file is already gone", async (t) => {
    const cacheDir = makeTmpCacheDir();
    t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(cacheDir, "pages"), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "pages", "mango.html"), detailHtmlFixture);
    const staleUrl =
      "https://www.fda.gov/safety/recalls-market-withdrawals-safety-alerts/stale-recall";
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(
      path.join(cacheDir, "manifest.json"),
      JSON.stringify({
        [MANGO_ROW_URL]: {
          url: MANGO_ROW_URL,
          cachedPath: path.join("pages", "mango.html"),
          firstCrawledDate: new Date().toISOString(),
          updatedDate: new Date().toISOString(),
        },
        [staleUrl]: {
          url: staleUrl,
          cachedPath: path.join("pages", "already-gone.html"),
          firstCrawledDate: oldDate,
          updatedDate: oldDate,
        },
      }),
    );
    const { restore } = stubFetch({
      ajaxResponse: { ok: true, json: async () => singleRowAjax() },
    });
    t.after(restore);

    await assert.doesNotReject(
      getMatchingRecalls({ terms: ["Salmonella"], limit: 5, cacheDir, maxAgeDays: 7 }),
    );

    const manifest = JSON.parse(fs.readFileSync(path.join(cacheDir, "manifest.json"), "utf8"));
    assert.ok(!manifest[staleUrl]);
  });

  test("term matching is whole-word: a substring of a matched word does not match on its own", async (t) => {
    const cacheDir = makeTmpCacheDir();
    t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
    const detailHtml = {
      [MANGO_ROW_URL]:
        "<html><body><script>var x = 1;</script><style>.a{color:red}</style>" +
        "<p>Recall notice: NYC retailers pulled the product due to Salmonella contamination.</p></body></html>",
    };
    const { restore } = stubFetch({
      ajaxResponse: { ok: true, json: async () => singleRowAjax() },
      detailHtml,
    });
    t.after(restore);

    const matches = await getMatchingRecalls({
      terms: ["NY", "Salmonella"],
      limit: 5,
      cacheDir,
      maxAgeDays: 0,
    });

    assert.equal(matches.length, 1);
    assert.deepEqual(matches[0].matchedTerms, ["Salmonella"]);
  });

  test("processes multiple uncached rows concurrently and returns all matches", async (t) => {
    const cacheDir = makeTmpCacheDir();
    t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
    const ajaxResponse = {
      ok: true,
      json: async () => ({ ...ajaxFixture, data: ajaxFixture.data.slice(0, 3) }),
    };
    const { restore, detailCalls } = stubFetch({ ajaxResponse });
    t.after(restore);

    const matches = await getMatchingRecalls({
      terms: ["Salmonella"],
      limit: 5,
      cacheDir,
      maxAgeDays: 0,
    });

    assert.equal(detailCalls.length, 3);
    assert.equal(matches.length, 3);
  });
});
