const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const { logger } = require("./logger.js");

const LINE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z: (DEBUG|INFO|WARN|ERROR): (.*)$/;

function lastLogLine(mock) {
  return mock.mock.calls.at(-1).arguments[0];
}

describe("logger", () => {
  test("debug/info/warn/error each prefix with timestamp and uppercased level", (t) => {
    const logMock = t.mock.method(console, "log", () => {});

    logger.debug("a message");
    const debugLine = lastLogLine(logMock);
    assert.match(debugLine, LINE_RE);
    assert.equal(debugLine.match(LINE_RE)[1], "DEBUG");
    assert.equal(debugLine.match(LINE_RE)[2], "a message");

    logger.info("info message");
    assert.equal(lastLogLine(logMock).match(LINE_RE)[1], "INFO");

    logger.warn("warn message");
    assert.equal(lastLogLine(logMock).match(LINE_RE)[1], "WARN");

    logger.error("error message");
    assert.equal(lastLogLine(logMock).match(LINE_RE)[1], "ERROR");
  });

  test("Error extra appends its message in parens", (t) => {
    const logMock = t.mock.method(console, "log", () => {});

    logger.error("failed", new Error("boom"));

    assert.equal(lastLogLine(logMock).match(LINE_RE)[2], "failed (boom)");
  });

  test("plain-object extra with primitive values appends key=value pairs", (t) => {
    const logMock = t.mock.method(console, "log", () => {});

    logger.info("scan complete", { count: 3, name: "food" });

    assert.equal(lastLogLine(logMock).match(LINE_RE)[2], "scan complete (count=3, name=food)");
  });

  test("plain-object extra with an object/array value JSON-stringifies it inline", (t) => {
    const logMock = t.mock.method(console, "log", () => {});

    logger.warn("bad row", { terms: ["a", "b"], meta: { x: 1 } });

    assert.equal(
      lastLogLine(logMock).match(LINE_RE)[2],
      `bad row (terms=${JSON.stringify(["a", "b"])}, meta=${JSON.stringify({ x: 1 })})`,
    );
  });

  test("falsy primitive extra appends nothing", (t) => {
    const logMock = t.mock.method(console, "log", () => {});

    logger.debug("no extras", null);
    assert.equal(lastLogLine(logMock).match(LINE_RE)[2], "no extras");

    logger.debug("no extras 2", undefined);
    assert.equal(lastLogLine(logMock).match(LINE_RE)[2], "no extras 2");

    logger.debug("no extras 3", 0);
    assert.equal(lastLogLine(logMock).match(LINE_RE)[2], "no extras 3");
  });

  test("empty-object extra appends nothing (no empty parens)", (t) => {
    const logMock = t.mock.method(console, "log", () => {});

    logger.debug("empty extra", {});

    assert.equal(lastLogLine(logMock).match(LINE_RE)[2], "empty extra");
  });
});
