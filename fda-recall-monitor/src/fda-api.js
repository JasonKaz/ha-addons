// Queries openFDA's food/drug/device enforcement (recall) endpoints and
// filters them the same way fda-recalls-scraper.js filters the scraped FDA page —
// same whole-word, case-sensitive term matching, applied locally rather
// than through openFDA's own search query syntax (different semantics,
// would need per-term/per-field query construction to replicate).
//
// This exists because the page scraper and this API have been confirmed
// to disagree in both directions: recalls exist on the FDA site that
// never appear in openFDA, and recalls exist in openFDA that never appear
// on the FDA site. Querying both and merging their results (done in run.js)
// is the only way to get a reasonably complete picture.
//
// Deliberately excludes drug/event, device/510k, and cosmetic/event —
// investigated and confirmed not to be recall data: the /event endpoints
// are individual adverse-event case reports (tens of millions of records,
// no product-description/location fields), and device/510k is a
// clearance-to-market database with no safety/incident concept at all.

const crypto = require("crypto");
const { logger } = require("./logger.js");
const { buildTermMatchers } = require("./utils.js");

const ENFORCEMENT_ENDPOINTS = {
  food: "https://api.fda.gov/food/enforcement.json",
  drug: "https://api.fda.gov/drug/enforcement.json",
  device: "https://api.fda.gov/device/enforcement.json",
};

// openFDA has no reliable per-record public page for a given recall_number
// (recalls found via the API frequently don't have a corresponding page on
// fda.gov at all), so instead of leaving API-sourced entries with no link
// at all, point at a Google search. The bare recall_number is nearly never
// indexed anywhere (it's an internal FDA enforcement-report id, not
// something news coverage or FDA's own press releases mention) — searching
// on the firm name and product description instead reliably surfaces the
// FDA announcement page or press coverage when either exists.
function googleSearchUrl(query) {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

// "20260819" -> "08/19/2026", matching the page scraper's date format.
function formatDate(yyyymmdd) {
  if (!yyyymmdd || yyyymmdd.length !== 8) {
    return null;
  }
  const year = yyyymmdd.slice(0, 4);
  const month = yyyymmdd.slice(4, 6);
  const day = yyyymmdd.slice(6, 8);
  return `${month}/${day}/${year}`;
}

// openFDA represents a missing recall_number inconsistently — sometimes an
// empty string, sometimes the literal text "N/A" — so both must be treated
// as absent, not as a real (and falsely shared) recall number.
function normalizeRecallNumber(recallNumber) {
  const trimmed = (recallNumber || "").trim();
  return trimmed && trimmed.toLowerCase() !== "n/a" ? trimmed : null;
}

// Fallback unique id for records missing recall_number: hash enough
// distinguishing fields that two genuinely different recalls won't collide.
function hashRecord(r) {
  const basis = [
    r.event_id,
    r.recalling_firm,
    r.product_description,
    r.reason_for_recall,
    r.report_date,
  ]
    .filter(Boolean)
    .join("|");
  return crypto.createHash("sha1").update(basis).digest("hex").slice(0, 12);
}

async function fetchCategoryMatches(category, url, terms, limit, termMatchers, apiKey) {
  const params = new URLSearchParams({ sort: "report_date:desc", limit: String(limit) });
  if (apiKey) {
    params.set("api_key", apiKey);
  }

  const res = await fetch(`${url}?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${category} enforcement data`);
  }
  const body = await res.json();

  return (body.results || [])
    .map((r) => {
      const searchableText = [
        r.product_description,
        r.reason_for_recall,
        r.recalling_firm,
        r.distribution_pattern,
      ]
        .filter(Boolean)
        .join(" ");
      const matchedTerms = terms.filter((t, i) => termMatchers[i].test(searchableText));
      if (matchedTerms.length === 0) {
        return null;
      }
      // recall_number is occasionally missing from openFDA's data — as a
      // blank string, or (seen in the wild) the literal text "N/A". Falling
      // back to the bare "api:<category>:" id, or treating "N/A" as if it
      // were a real recall number, would collide across every such record,
      // causing acknowledging one to silently swallow all others that also
      // lack a recall_number. Hash the rest of the record's identifying
      // fields instead so each stays distinct.
      const recallNumber = normalizeRecallNumber(r.recall_number);
      const idSuffix = recallNumber || hashRecord(r);
      const productDescription = (r.product_description || "").replace(/\s+/g, " ").trim();
      return {
        id: `api:${category}:${idSuffix}`,
        source: "api",
        category,
        date: formatDate(r.report_date),
        brand: r.recalling_firm, // openFDA has no separate "brand" concept
        companyName: r.recalling_firm,
        productDescription,
        productType: r.product_type || null,
        recallReason: r.reason_for_recall || null,
        url: googleSearchUrl(`FDA recall ${r.recalling_firm} ${productDescription}`.slice(0, 200)),
        recallNumber,
        classification: r.classification || null,
        distributionPattern: r.distribution_pattern || null,
        status: r.status || null,
        codeInfo: r.code_info || null,
        matchedTerms,
      };
    })
    .filter(Boolean);
}

async function getMatchingRecallsFromApi({ terms, limit, apiKey }) {
  const termMatchers = buildTermMatchers(terms);

  const perCategory = await Promise.all(
    Object.entries(ENFORCEMENT_ENDPOINTS).map(async ([category, url]) => {
      try {
        return await fetchCategoryMatches(category, url, terms, limit, termMatchers, apiKey);
      } catch (err) {
        logger.error(`Failed to fetch ${category} enforcement data from openFDA`, err);
        return [];
      }
    }),
  );

  return perCategory.flat();
}

module.exports = getMatchingRecallsFromApi;
