const { describe, test, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");

const path = require("path");

const acknowledgedModule = require("./acknowledged.js");

const fixturesDir = path.join(__dirname, "fixtures");
const pageHtmlFixture = fs.readFileSync(path.join(fixturesDir, "fda-listing-page.html"), "utf8");
const ajaxFixture = JSON.parse(
  fs.readFileSync(path.join(fixturesDir, "fda-ajax-response.json"), "utf8"),
);
const detailHtmlFixture = fs.readFileSync(path.join(fixturesDir, "fda-detail-page.html"), "utf8");

// run.js reads SUPERVISOR_TOKEN into a module-load-time const, and calls
// acknowledged.load() at require time (populating its private
// `acknowledgedIds`) — both must be set up before the first require here.
process.env.SUPERVISOR_TOKEN = "test-token";
const loadStub = mock.method(acknowledgedModule, "load", () => new Set());
const run = require("./run.js");
loadStub.mock.restore();

const { logger } = require("./logger.js");

const SUPERVISOR_URL = "http://supervisor/core/api/states/sensor.fda_recall_count";
const OPTIONS_PATH = "/data/options.json";

function stubSupervisorFetch({ ok = true, status = 200 } = {}) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    if (url !== SUPERVISOR_URL) {
      throw new Error(`unexpected fetch to ${url}`);
    }
    return { ok, status };
  };
  return { restore: () => (global.fetch = original), calls };
}

// Routes every fetch call by URL prefix: the supervisor push, FDA's page
// scraper endpoints, and openFDA's enforcement endpoints. Lets runOnce()
// tests control each source (success/empty/failure) independently.
function stubAllFetch({
  supervisor = { ok: true },
  pageFetchFails = true,
  apiFetchFails = false,
  apiResults = {},
  pageRowCount = 1,
} = {}) {
  const original = global.fetch;
  global.fetch = async (url) => {
    if (url === SUPERVISOR_URL) {
      return { ok: supervisor.ok, status: supervisor.status || 200 };
    }
    if (url === "https://www.fda.gov/safety/recalls-market-withdrawals-safety-alerts") {
      if (pageFetchFails) {
        return { ok: false, status: 503 };
      }
      return { ok: true, text: async () => pageHtmlFixture };
    }
    if (url.startsWith("https://www.fda.gov/datatables/views/ajax")) {
      return {
        ok: true,
        json: async () => ({ ...ajaxFixture, data: ajaxFixture.data.slice(0, pageRowCount) }),
      };
    }
    if (url.startsWith("https://www.fda.gov/safety/recalls-market-withdrawals-safety-alerts/")) {
      return { ok: true, text: async () => detailHtmlFixture };
    }
    if (url.startsWith("https://api.fda.gov/")) {
      if (apiFetchFails) {
        return { ok: false, status: 500 };
      }
      const category = ["food", "drug", "device"].find((c) =>
        url.startsWith(`https://api.fda.gov/${c}/enforcement.json`),
      );
      return { ok: true, json: async () => ({ results: apiResults[category] || [] }) };
    }
    throw new Error(`unexpected fetch to ${url}`);
  };
  return { restore: () => (global.fetch = original) };
}

describe("escapeHtml", () => {
  test("escapes all special characters and handles nullish input", () => {
    assert.equal(
      run.escapeHtml(`<a href="x">O'Brien & Co</a>`),
      "&lt;a href=&quot;x&quot;&gt;O&#039;Brien &amp; Co&lt;/a&gt;",
    );
    assert.equal(run.escapeHtml(null), "");
    assert.equal(run.escapeHtml(undefined), "");
    assert.equal(run.escapeHtml(42), "42");
  });
});

describe("computeNewMatches", () => {
  test("returns everything when nothing is acknowledged", () => {
    const matches = [{ id: "a" }, { id: "b" }];
    assert.deepEqual(run.computeNewMatches(matches), matches);
  });
});

describe("pushState", () => {
  test("posts the expected sensor body and headers", async (t) => {
    const { restore, calls } = stubSupervisorFetch();
    t.after(restore);

    const matches = [
      {
        id: "x",
        date: "08/29/2026",
        brand: "Acme",
        productDescription: "Widget",
        recallReason: "Defect",
        url: "https://example.com",
        source: "api",
        category: "food",
        recallNumber: null,
        classification: null,
        status: "Ongoing",
        codeInfo: "Lot # ABC123",
      },
    ];
    await run.pushState(matches, matches, ["widget"]);

    assert.equal(calls.length, 1);
    const { url, init } = calls[0];
    assert.equal(url, SUPERVISOR_URL);
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Authorization, "Bearer test-token");
    const body = JSON.parse(init.body);
    assert.equal(body.state, 1);
    assert.equal(body.attributes.total_matching_recalls, 1);
    assert.equal(body.attributes.filter_terms.length, 1);
    assert.equal(body.attributes.recalls[0].brand, "Acme");
    assert.equal(body.attributes.recalls[0].isNew, true);
    assert.equal(body.attributes.recalls[0].status, "Ongoing");
    assert.equal(body.attributes.recalls[0].codeInfo, "Lot # ABC123");
  });

  test("status and codeInfo fall back to null for page-sourced matches lacking them", async (t) => {
    const { restore, calls } = stubSupervisorFetch();
    t.after(restore);

    const matches = [{ id: "x", date: "08/29/2026", brand: "Acme", source: "page" }];
    await run.pushState(matches, matches, ["widget"]);

    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.attributes.recalls[0].status, null);
    assert.equal(body.attributes.recalls[0].codeInfo, null);
  });

  test("sorts new matches ahead of acknowledged ones so they survive the attribute cap", async (t) => {
    const { restore, calls } = stubSupervisorFetch();
    t.after(restore);

    // 10 already-acknowledged matches followed by 1 new one: with a naive
    // slice(0, MAX_ATTRIBUTE_RECALLS) the new match would be cut entirely.
    const acknowledgedMatches = Array.from({ length: 10 }, (_, i) => ({
      id: `old-${i}`,
      date: "01/01/2026",
      brand: `Old ${i}`,
    }));
    const newMatch = { id: "new-1", date: "01/02/2026", brand: "New Co" };
    const matches = [...acknowledgedMatches, newMatch];

    await run.pushState(matches, [newMatch], ["widget"]);

    const body = JSON.parse(calls[0].init.body);
    assert.ok(
      body.attributes.recalls.some((r) => r.brand === "New Co" && r.isNew === true),
      "expected the new match to appear in the capped recalls attribute",
    );
  });

  test("logs and does not throw on a non-ok response", async (t) => {
    const { restore } = stubSupervisorFetch({ ok: false, status: 500 });
    t.after(restore);
    const errorMock = t.mock.method(logger, "error", () => {});

    await run.pushState([], [], []);

    assert.equal(errorMock.mock.calls.length, 1);
    assert.match(errorMock.mock.calls[0].arguments[0], /Failed to update sensor state/);
  });

  test("logs and does not throw when fetch itself rejects", async (t) => {
    const original = global.fetch;
    global.fetch = async () => {
      throw new Error("network down");
    };
    t.after(() => (global.fetch = original));
    const errorMock = t.mock.method(logger, "error", () => {});

    await run.pushState([], [], []);

    assert.equal(errorMock.mock.calls.length, 1);
    assert.match(errorMock.mock.calls[0].arguments[0], /Failed to reach Home Assistant/);
  });
});

describe("runOnce", () => {
  test("with an empty filter logs a warning, pushes empty state, and returns early", async (t) => {
    t.mock.method(fs, "readFileSync", (p) => {
      assert.equal(p, OPTIONS_PATH);
      return JSON.stringify({ filter: "  , ,  ", scan_interval_minutes: 45 });
    });
    const { restore, calls } = stubSupervisorFetch();
    t.after(restore);
    const warnMock = t.mock.method(logger, "warn", () => {});

    const interval = await run.runOnce();

    assert.equal(interval, 45);
    assert.equal(warnMock.mock.calls.length, 1);
    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(calls[0].init.body).state, 0);
  });

  test("merges page and API results, tolerating a page-scraper failure", async (t) => {
    t.mock.method(fs, "readFileSync", (p) => {
      assert.equal(p, OPTIONS_PATH);
      return JSON.stringify({
        filter: "Nationwide",
        scan_interval_minutes: 30,
        openfda_api_key: "",
      });
    });
    const apiRecord = {
      event_id: "1",
      recalling_firm: "Nationwide Co",
      product_description: "Nationwide test product",
      reason_for_recall: "Nationwide test reason",
      report_date: "20260101",
      recall_number: "C-1",
    };
    const { restore } = stubAllFetch({ pageFetchFails: true, apiResults: { drug: [apiRecord] } });
    t.after(restore);
    const errorMock = t.mock.method(logger, "error", () => {});

    const interval = await run.runOnce();

    assert.equal(interval, 30);
    assert.ok(errorMock.mock.calls.some((c) => c.arguments[0] === "Page scraper scan failed"));
  });

  test("maps a successful page-scraper result and tolerates an openFDA fetch failure", async (t) => {
    t.mock.method(fs, "readFileSync", () =>
      JSON.stringify({ filter: "Salmonella", scan_interval_minutes: 15, openfda_api_key: "" }),
    );
    // fda-recalls-scraper.js persists its cache via fs.promises — stub those so this
    // test doesn't touch the real (container-only) /data/fda-recalls-cache path.
    const fsPromises = require("fs").promises;
    t.mock.method(fsPromises, "readFile", async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    t.mock.method(fsPromises, "mkdir", async () => {});
    t.mock.method(fsPromises, "writeFile", async () => {});
    const { restore } = stubAllFetch({
      pageFetchFails: false,
      apiFetchFails: true,
      pageRowCount: 2,
    });
    t.after(restore);
    const errorMock = t.mock.method(logger, "error", () => {});

    const interval = await run.runOnce();

    assert.equal(interval, 15);
    // apiFetchFails is handled inside fda-api.js's own per-category try/catch
    // (it never rejects the outer call), so this confirms that failure was
    // logged rather than silently dropped.
    assert.ok(
      errorMock.mock.calls.some((c) =>
        /Failed to fetch .* enforcement data from openFDA/.test(c.arguments[0]),
      ),
    );

    // Two matches exercises renderRecallsPage's date-descending sort comparator.
    const html = run.renderRecallsPage();
    assert.match(html, /Martina/);
    assert.match(html, /Everything Sprouts/);
    assert.match(html, /NEW/);
  });
});

describe("renderRecallsPage", () => {
  test("escapes injected fields and shows the empty-state message", async (t) => {
    t.mock.method(fs, "readFileSync", () =>
      JSON.stringify({ filter: "", scan_interval_minutes: 60 }),
    );
    const { restore } = stubSupervisorFetch();
    t.after(restore);
    await run.runOnce();

    const html = run.renderRecallsPage();

    assert.match(html, /No matching recalls\./);
  });
});

describe("handleAcknowledge", () => {
  test("saves acknowledged ids, pushes state, and responds with JSON", async (t) => {
    t.mock.method(fs, "readFileSync", () =>
      JSON.stringify({ filter: "Nationwide", scan_interval_minutes: 30, openfda_api_key: "" }),
    );
    const apiRecord = {
      event_id: "42",
      recalling_firm: "Nationwide Co",
      product_description: "Nationwide widget",
      reason_for_recall: "Nationwide reason",
      report_date: "20260102",
      recall_number: "D-42",
    };
    const { restore } = stubAllFetch({ pageFetchFails: true, apiResults: { food: [apiRecord] } });
    t.after(restore);
    await run.runOnce();

    const saveMock = t.mock.method(acknowledgedModule, "save", () => {});
    const writeHead = t.mock.fn();
    const end = t.mock.fn();

    await run.handleAcknowledge({ writeHead, end });

    assert.equal(saveMock.mock.calls.length, 1);
    assert.equal(writeHead.mock.calls[0].arguments[0], 200);
    const body = JSON.parse(end.mock.calls[0].arguments[0]);
    assert.equal(body.ok, true);
    assert.equal(body.acknowledgedCount, 1);

    // The acknowledged id from the run above should now be filtered out.
    const stillNew = run.computeNewMatches([{ id: "api:food:D-42" }, { id: "api:food:brand-new" }]);
    assert.deepEqual(
      stillNew.map((m) => m.id),
      ["api:food:brand-new"],
    );
  });
});

describe("startServer", () => {
  test("routes GET /, GET /recalls, POST /acknowledge, and 404s everything else", async (t) => {
    t.mock.method(fs, "readFileSync", () =>
      JSON.stringify({ filter: "", scan_interval_minutes: 60 }),
    );
    t.mock.method(acknowledgedModule, "save", () => {});
    const { restore } = stubSupervisorFetch();
    await run.runOnce();
    restore();

    const server = run.startServer();
    t.after(() => new Promise((resolve) => server.close(resolve)));

    // The server's own handler calls pushState() (POST /acknowledge), which
    // fetches the (unreachable in tests) supervisor host — stub just that
    // URL through to a fast fake response so real HTTP calls to the local
    // server below aren't slowed down by a real DNS failure.
    const originalFetch = global.fetch;
    global.fetch = async (url, init) => {
      if (url === SUPERVISOR_URL) {
        return { ok: true, status: 200 };
      }
      return originalFetch(url, init);
    };
    t.after(() => (global.fetch = originalFetch));

    const base = "http://127.0.0.1:8099";
    const rootRes = await fetch(`${base}/`);
    assert.equal(rootRes.status, 200);
    assert.match(await rootRes.text(), /FDA Recall Monitor add-on is running\./);

    const recallsRes = await fetch(`${base}/recalls`);
    assert.equal(recallsRes.status, 200);
    assert.match(await recallsRes.text(), /FDA Recalls/);

    const ackRes = await fetch(`${base}/acknowledge`, { method: "POST" });
    assert.equal(ackRes.status, 200);
    const ackBody = await ackRes.json();
    assert.equal(ackBody.ok, true);

    const notFoundRes = await fetch(`${base}/nope`);
    assert.equal(notFoundRes.status, 404);

    // Same server/connection — now make handleAcknowledge throw and confirm
    // the route's catch responds 500 rather than crashing the server.
    // (A second startServer() on the same port in a separate test causes
    // undici's fetch keep-alive pool to reuse a socket from the now-closed
    // first server, producing spurious ECONNRESETs — so this is exercised
    // here instead of in its own test.)
    acknowledgedModule.save.mock.mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    const errorMock = t.mock.method(logger, "error", () => {});

    const failedAckRes = await fetch(`${base}/acknowledge`, { method: "POST" });

    assert.equal(failedAckRes.status, 500);
    const failedBody = await failedAckRes.json();
    assert.equal(failedBody.ok, false);
    assert.equal(failedBody.error, "disk full");
    assert.ok(errorMock.mock.calls.some((c) => c.arguments[0] === "Acknowledge request failed"));
  });
});
