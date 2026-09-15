// Regression test for the "api:drug:" id-collision bug: openFDA sometimes
// returns a record with a blank recall_number, and the id builder used to
// produce the bare "api:<category>:" string for every such record — meaning
// acknowledging one silently swallowed all others that also lacked a
// recall_number. See fixtures/openfda-drug-missing-recall-number.json
// for a real example (a Baxter Healthcare drug recall, event_id 99463).
const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const getMatchingRecallsFromApi = require("./fda-api.js");
const { logger } = require("./logger.js");

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures/openfda-drug-missing-recall-number.json"), "utf8"),
);

// Stubs global.fetch so the module's three parallel enforcement-endpoint
// calls resolve without hitting the network. `drugResults` is what the
// drug/enforcement.json endpoint returns; food/device always return empty.
function stubFetch(drugResults) {
  const original = global.fetch;
  global.fetch = async (url) => {
    const results = url.startsWith("https://api.fda.gov/drug/enforcement.json") ? drugResults : [];
    return { ok: true, json: async () => ({ results }) };
  };
  return () => {
    global.fetch = original;
  };
}

// Stubs global.fetch with a per-category response map, keyed by
// "food"/"drug"/"device". Any category not present resolves to [].
// Entries can be `{ results }` (ok) or `{ status }` (non-ok, throws).
function stubFetchByCategory(byCategory) {
  const original = global.fetch;
  const seenUrls = [];
  global.fetch = async (url) => {
    seenUrls.push(url);
    const category = ["food", "drug", "device"].find((c) =>
      url.startsWith(`https://api.fda.gov/${c}/enforcement.json`),
    );
    const entry = byCategory[category];
    if (!entry) {
      return { ok: true, json: async () => ({ results: [] }) };
    }
    if (entry.status) {
      return { ok: false, status: entry.status, json: async () => ({}) };
    }
    return { ok: true, json: async () => ({ results: entry.results }) };
  };
  return { restore: () => (global.fetch = original), seenUrls };
}

describe("getMatchingRecallsFromApi", () => {
  test("record with blank recall_number gets a non-bare, distinct id", async (t) => {
    const restore = stubFetch([fixture]);
    t.after(restore);

    const matches = await getMatchingRecallsFromApi({
      terms: ["Nationwide"],
      limit: 10,
      apiKey: null,
    });

    assert.equal(matches.length, 1);
    const [match] = matches;
    assert.equal(match.category, "drug");
    assert.match(match.id, /^api:drug:.+$/);
    assert.notEqual(match.id, "api:drug:");
  });

  test("the fallback id is deterministic across separate calls", async (t) => {
    const restore = stubFetch([fixture]);
    t.after(restore);

    const [first] = await getMatchingRecallsFromApi({
      terms: ["Nationwide"],
      limit: 10,
      apiKey: null,
    });
    const [second] = await getMatchingRecallsFromApi({
      terms: ["Nationwide"],
      limit: 10,
      apiKey: null,
    });

    assert.equal(first.id, second.id);
  });

  test("two different records both missing recall_number don't collide", async (t) => {
    const otherFixture = {
      ...fixture,
      event_id: "99999",
      product_description: "A completely different product description for a separate recall.",
      report_date: "20260820",
    };
    const restore = stubFetch([fixture, otherFixture]);
    t.after(restore);

    const matches = await getMatchingRecallsFromApi({
      terms: ["Nationwide"],
      limit: 10,
      apiKey: null,
    });

    assert.equal(matches.length, 2);
    assert.notEqual(matches[0].id, matches[1].id);
  });

  test("record with a present recall_number uses it directly for id", async (t) => {
    const record = {
      ...fixture,
      recall_number: "F-1234-2026",
      recalling_firm: "Acme Foods",
    };
    const { restore } = stubFetchByCategory({ food: { results: [record] } });
    t.after(restore);

    const [match] = await getMatchingRecallsFromApi({
      terms: ["Nationwide"],
      limit: 10,
      apiKey: null,
    });

    assert.equal(match.category, "food");
    assert.equal(match.id, "api:food:F-1234-2026");
    assert.equal(match.recallNumber, "F-1234-2026");
  });

  test("url is a Google search built from the firm and product description, not the bare recall number", async (t) => {
    const record = {
      ...fixture,
      recall_number: "F-1234-2026",
      recalling_firm: "Acme Foods",
      product_description: "Canned Beans, 15oz",
    };
    const { restore } = stubFetchByCategory({ food: { results: [record] } });
    t.after(restore);

    const [match] = await getMatchingRecallsFromApi({
      terms: ["Nationwide"],
      limit: 10,
      apiKey: null,
    });

    assert.equal(
      match.url,
      `https://www.google.com/search?q=${encodeURIComponent("FDA recall Acme Foods Canned Beans, 15oz")}`,
    );
  });

  test("url is still populated when recall_number is absent", async (t) => {
    const record = {
      ...fixture,
      recall_number: "",
      recalling_firm: "Acme Foods",
      product_description: "Canned Beans, 15oz",
    };
    const { restore } = stubFetchByCategory({ food: { results: [record] } });
    t.after(restore);

    const [match] = await getMatchingRecallsFromApi({
      terms: ["Nationwide"],
      limit: 10,
      apiKey: null,
    });

    assert.ok(match.url.startsWith("https://www.google.com/search?q="));
  });

  test("status and codeInfo are carried through from the record", async (t) => {
    const record = {
      ...fixture,
      recall_number: "F-1234-2026",
      status: "Ongoing",
      code_info: "Lot # ABC123, Exp Date: 01-Jan-2027.",
    };
    const { restore } = stubFetchByCategory({ food: { results: [record] } });
    t.after(restore);

    const [match] = await getMatchingRecallsFromApi({
      terms: ["Nationwide"],
      limit: 10,
      apiKey: null,
    });

    assert.equal(match.status, "Ongoing");
    assert.equal(match.codeInfo, "Lot # ABC123, Exp Date: 01-Jan-2027.");
  });

  test("status and codeInfo fall back to null when absent", async (t) => {
    const record = {
      event_id: "1",
      recalling_firm: "Nationwide Co",
      product_description: "Nationwide test product",
      reason_for_recall: "Nationwide test reason",
      report_date: "20260101",
      recall_number: "C-1",
      // status, code_info intentionally omitted
    };
    const { restore } = stubFetchByCategory({ drug: { results: [record] } });
    t.after(restore);

    const [match] = await getMatchingRecallsFromApi({
      terms: ["Nationwide"],
      limit: 10,
      apiKey: null,
    });

    assert.equal(match.status, null);
    assert.equal(match.codeInfo, null);
  });

  test('a literal "N/A" recall_number is treated as missing, using the hashed fallback id', async (t) => {
    const record = { ...fixture, recall_number: "N/A" };
    const { restore } = stubFetchByCategory({ food: { results: [record] } });
    t.after(restore);

    const [match] = await getMatchingRecallsFromApi({
      terms: ["Nationwide"],
      limit: 10,
      apiKey: null,
    });

    assert.equal(match.recallNumber, null);
    assert.notEqual(match.id, "api:food:N/A");
    assert.match(match.id, /^api:food:.+$/);
  });

  test('two different records both with a literal "N/A" recall_number don\'t collide', async (t) => {
    const otherFixture = {
      ...fixture,
      recall_number: "N/A",
      event_id: "99999",
      product_description: "A completely different product description for a separate recall.",
      report_date: "20260820",
    };
    const record = { ...fixture, recall_number: "N/A" };
    const { restore } = stubFetchByCategory({ food: { results: [record, otherFixture] } });
    t.after(restore);

    const matches = await getMatchingRecallsFromApi({
      terms: ["Nationwide"],
      limit: 10,
      apiKey: null,
    });

    assert.equal(matches.length, 2);
    assert.notEqual(matches[0].id, matches[1].id);
  });

  test("records that match no term are excluded", async (t) => {
    const { restore } = stubFetchByCategory({ drug: { results: [fixture] } });
    t.after(restore);

    const matches = await getMatchingRecallsFromApi({
      terms: ["ZZZ-not-present"],
      limit: 10,
      apiKey: null,
    });

    assert.equal(matches.length, 0);
  });

  test("a record matching multiple terms lists all of them in matchedTerms", async (t) => {
    const record = {
      ...fixture,
      reason_for_recall: "Nationwide distribution, possible Salmonella contamination",
    };
    const { restore } = stubFetchByCategory({ drug: { results: [record] } });
    t.after(restore);

    const [match] = await getMatchingRecallsFromApi({
      terms: ["Nationwide", "Salmonella"],
      limit: 10,
      apiKey: null,
    });

    assert.deepEqual(match.matchedTerms.toSorted(), ["Nationwide", "Salmonella"]);
  });

  test("apiKey is appended as an api_key query param when provided", async (t) => {
    const { restore, seenUrls } = stubFetchByCategory({ drug: { results: [fixture] } });
    t.after(restore);

    await getMatchingRecallsFromApi({ terms: ["Nationwide"], limit: 10, apiKey: "secret-key" });

    assert.ok(seenUrls.some((u) => u.includes("api_key=secret-key")));
  });

  test("apiKey is omitted from the query string when not provided", async (t) => {
    const { restore, seenUrls } = stubFetchByCategory({ drug: { results: [fixture] } });
    t.after(restore);

    await getMatchingRecallsFromApi({ terms: ["Nationwide"], limit: 10, apiKey: null });

    assert.ok(seenUrls.every((u) => !u.includes("api_key=")));
  });

  test("a non-ok HTTP response for one category yields [] for it and logs, without failing others", async (t) => {
    const record = { ...fixture, recall_number: "D-9999" };
    const { restore } = stubFetchByCategory({
      drug: { status: 500 },
      food: { results: [record] },
    });
    t.after(restore);
    const errorMock = t.mock.method(logger, "error", () => {});

    const matches = await getMatchingRecallsFromApi({
      terms: ["Nationwide"],
      limit: 10,
      apiKey: null,
    });

    assert.equal(matches.length, 1);
    assert.equal(matches[0].category, "food");
    assert.equal(errorMock.mock.calls.length, 1);
    assert.match(errorMock.mock.calls[0].arguments[0], /Failed to fetch drug enforcement data/);
  });

  test("formatDate handles well-formed, null, and malformed report_date", async (t) => {
    const wellFormed = { ...fixture, recall_number: "A-1", report_date: "20260819" };
    const missing = { ...fixture, recall_number: "A-2", report_date: undefined };
    const malformed = { ...fixture, recall_number: "A-3", report_date: "2026" };
    const { restore } = stubFetchByCategory({
      drug: { results: [wellFormed, missing, malformed] },
    });
    t.after(restore);

    const matches = await getMatchingRecallsFromApi({
      terms: ["Nationwide"],
      limit: 10,
      apiKey: null,
    });

    const byNumber = Object.fromEntries(matches.map((m) => [m.recallNumber, m.date]));
    assert.equal(byNumber["A-1"], "08/19/2026");
    assert.equal(byNumber["A-2"], null);
    assert.equal(byNumber["A-3"], null);
  });

  test("productDescription whitespace is collapsed and trimmed", async (t) => {
    const record = {
      ...fixture,
      recall_number: "B-1",
      product_description: "  Some   product\n\ndescription  ",
    };
    const { restore } = stubFetchByCategory({ drug: { results: [record] } });
    t.after(restore);

    const [match] = await getMatchingRecallsFromApi({
      terms: ["Nationwide"],
      limit: 10,
      apiKey: null,
    });

    assert.equal(match.productDescription, "Some product description");
  });

  test("optional fields fall back to null when absent from the record", async (t) => {
    const record = {
      event_id: "1",
      recalling_firm: "Nationwide Co",
      product_description: "Nationwide test product",
      reason_for_recall: "Nationwide test reason",
      report_date: "20260101",
      recall_number: "C-1",
      // product_type, classification, distribution_pattern intentionally omitted
    };
    const { restore } = stubFetchByCategory({ drug: { results: [record] } });
    t.after(restore);

    const [match] = await getMatchingRecallsFromApi({
      terms: ["Nationwide"],
      limit: 10,
      apiKey: null,
    });

    assert.equal(match.productType, null);
    assert.equal(match.classification, null);
    assert.equal(match.distributionPattern, null);
  });

  test("merges matches across all three categories in a single call", async (t) => {
    const foodRecord = { ...fixture, recall_number: "FOOD-1" };
    const drugRecord = { ...fixture, recall_number: "DRUG-1" };
    const deviceRecord = { ...fixture, recall_number: "DEVICE-1" };
    const { restore } = stubFetchByCategory({
      food: { results: [foodRecord] },
      drug: { results: [drugRecord] },
      device: { results: [deviceRecord] },
    });
    t.after(restore);

    const matches = await getMatchingRecallsFromApi({
      terms: ["Nationwide"],
      limit: 10,
      apiKey: null,
    });

    assert.equal(matches.length, 3);
    assert.deepEqual(matches.map((m) => m.category).toSorted(), ["device", "drug", "food"]);
  });
});
