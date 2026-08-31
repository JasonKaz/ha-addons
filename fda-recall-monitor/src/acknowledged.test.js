const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");

const acknowledged = require("./acknowledged.js");
const { logger } = require("./logger.js");

describe("load()", () => {
  test("returns a Set of acknowledgedIds from valid JSON", (t) => {
    t.mock.method(fs, "readFileSync", () => JSON.stringify({ acknowledgedIds: ["a", "b", "c"] }));

    const result = acknowledged.load();

    assert.ok(result instanceof Set);
    assert.deepEqual(Array.from(result).toSorted(), ["a", "b", "c"]);
  });

  test("returns an empty Set when the file doesn't exist yet (ENOENT)", (t) => {
    t.mock.method(fs, "readFileSync", () => {
      throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
    });
    const errorMock = t.mock.method(logger, "error", () => {});

    const result = acknowledged.load();

    assert.ok(result instanceof Set);
    assert.equal(result.size, 0);
    assert.equal(errorMock.mock.calls.length, 0);
  });

  test("logs and rethrows when the file can't be read for a reason other than it being missing", (t) => {
    const readError = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    t.mock.method(fs, "readFileSync", () => {
      throw readError;
    });
    const errorMock = t.mock.method(logger, "error", () => {});

    assert.throws(() => acknowledged.load(), readError);

    assert.equal(errorMock.mock.calls.length, 1);
    assert.equal(errorMock.mock.calls[0].arguments[0], "Failed to read acknowledged recalls");
    assert.equal(errorMock.mock.calls[0].arguments[1], readError);
  });

  test("logs and rethrows on malformed JSON", (t) => {
    t.mock.method(fs, "readFileSync", () => "{not valid json");
    const errorMock = t.mock.method(logger, "error", () => {});

    assert.throws(() => acknowledged.load(), SyntaxError);

    assert.equal(errorMock.mock.calls.length, 1);
    assert.equal(errorMock.mock.calls[0].arguments[0], "Failed to parse acknowledged recalls");
    assert.ok(errorMock.mock.calls[0].arguments[1] instanceof SyntaxError);
  });

  test("returns an empty Set when acknowledgedIds is missing", (t) => {
    t.mock.method(fs, "readFileSync", () => JSON.stringify({}));

    const result = acknowledged.load();

    assert.equal(result.size, 0);
  });
});

describe("save()", () => {
  test("writes acknowledgedIds as pretty JSON to the fixed path", (t) => {
    const writeMock = t.mock.method(fs, "writeFileSync", () => {});

    acknowledged.save(new Set(["x", "y"]));

    assert.equal(writeMock.mock.calls.length, 1);
    const [filePath, contents] = writeMock.mock.calls[0].arguments;
    assert.equal(filePath, "/data/acknowledged.json");
    assert.deepEqual(JSON.parse(contents), { acknowledgedIds: ["x", "y"] });
    assert.equal(contents, JSON.stringify({ acknowledgedIds: ["x", "y"] }, null, 2));
  });

  test("logs and rethrows when the write fails", (t) => {
    const writeError = new Error("ENOSPC: no space left on device");
    t.mock.method(fs, "writeFileSync", () => {
      throw writeError;
    });
    const errorMock = t.mock.method(logger, "error", () => {});

    assert.throws(() => acknowledged.save(new Set(["x"])), writeError);

    assert.equal(errorMock.mock.calls.length, 1);
    assert.equal(errorMock.mock.calls[0].arguments[0], "Failed to save acknowledged recalls");
    assert.equal(errorMock.mock.calls[0].arguments[1], writeError);
  });
});
