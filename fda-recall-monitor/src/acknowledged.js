// Persists the set of recall ids the user has already acknowledged, so
// the sensor's main count only reflects recalls that are new since the
// last time the user cleared them. An id is a page-scraped recall's url,
// or "api:<category>:<recall_number>" for an API-sourced recall (which
// has no url of its own).
const fs = require("fs");
const { logger } = require("./logger.js");

const PATH = "/data/acknowledged.json";

function load() {
  let raw;
  try {
    raw = fs.readFileSync(PATH, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      // No file yet, that is ok
      return new Set();
    }
    logger.error("Failed to read acknowledged recalls", err);
    throw err;
  }

  try {
    const data = JSON.parse(raw);
    return new Set(data.acknowledgedIds || []);
  } catch (err) {
    logger.error("Failed to parse acknowledged recalls", err);
    throw err;
  }
}

function save(acknowledgedIds) {
  try {
    fs.writeFileSync(PATH, JSON.stringify({ acknowledgedIds: [...acknowledgedIds] }, null, 2));
  } catch (err) {
    logger.error("Failed to save acknowledged recalls", err);
    throw err;
  }
}

module.exports = { load, save };
