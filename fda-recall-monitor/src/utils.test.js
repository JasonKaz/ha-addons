const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const { escapeRegExp, buildTermMatchers, truncateText } = require("./utils.js");

describe("escapeRegExp", () => {
  test("escapes regex special characters", () => {
    assert.equal(escapeRegExp("a.b*c?d"), "a\\.b\\*c\\?d");
    assert.equal(escapeRegExp("(x|y)[z]"), "\\(x\\|y\\)\\[z\\]");
    assert.equal(escapeRegExp("plain text"), "plain text");
  });
});

describe("buildTermMatchers", () => {
  test("returns one whole-word RegExp per term", () => {
    const matchers = buildTermMatchers(["Salmonella", "E. coli"]);

    assert.equal(matchers.length, 2);
    assert.ok(matchers.every((m) => m instanceof RegExp));
    assert.ok(matchers[0].test("A Salmonella outbreak"));
    assert.ok(matchers[1].test("possible E. coli contamination"));
  });

  test("matches whole words only, not substrings", () => {
    const [matcher] = buildTermMatchers(["NY"]);

    assert.ok(matcher.test("Recalled in NY stores"));
    assert.ok(!matcher.test("Recalled by ANYCO Inc"));
  });

  test("escapes regex-special characters within a term", () => {
    const [matcher] = buildTermMatchers(["A.B.C"]);

    assert.ok(matcher.test("recalled by A.B.C Foods"));
    assert.ok(!matcher.test("recalled by AxBxC Foods"));
  });
});

describe("truncateText", () => {
  test("returns short text and null/undefined unchanged", () => {
    assert.equal(truncateText("Lot # ABC123", 20), "Lot # ABC123");
    assert.equal(truncateText(null, 20), null);
    assert.equal(truncateText(undefined, 20), undefined);
  });

  test("cuts at the last space or semicolon boundary and appends an ellipsis", () => {
    assert.equal(truncateText("V2842901 V2841713 V2841724", 20), "V2842901 V2841713…");
    assert.equal(truncateText("Model No: 1-200; UDI-DI: 008417", 22), "Model No: 1-200…");
  });

  test("hard-cuts when there is no boundary to cut at", () => {
    assert.equal(truncateText("ABCDEFGHIJ", 5), "ABCDE…");
  });
});
