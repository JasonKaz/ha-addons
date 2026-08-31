// Plain-text line logger: "DATETIME: LEVEL: CONTENT". Every level writes
// to stdout (never console.error) so the add-on's log stays in one
// consistent stream, in the order things actually happened.
function write(level, msg, extra) {
  let content = msg;
  if (extra instanceof Error) {
    content += ` (${extra.message})`;
  } else if (extra && typeof extra === "object") {
    const fields = Object.entries(extra)
      .map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : value}`)
      .join(", ");
    if (fields) {
      content += ` (${fields})`;
    }
  }
  console.log(`${new Date().toISOString()}: ${level.toUpperCase()}: ${content}`);
}

const logger = {
  debug: (msg, extra) => write("debug", msg, extra),
  info: (msg, extra) => write("info", msg, extra),
  warn: (msg, extra) => write("warn", msg, extra),
  error: (msg, extra) => write("error", msg, extra),
};

module.exports = { logger };
