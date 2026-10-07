function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Whole-word match rather than plain substring: without this, a short term
// like "NY" (New York) matches inside unrelated words like "COMPANY".
function buildTermMatchers(terms) {
  return terms.map((term) => new RegExp(`\\b${escapeRegExp(term)}\\b`));
}

// Shortens text to at most maxLength chars (plus a trailing "…"), cutting at
// the last "; " or space boundary so a lot/serial code isn't split mid-value.
// Returns the text unchanged if it already fits.
function truncateText(text, maxLength) {
  if (text == null || text.length <= maxLength) {
    return text;
  }
  const head = text.slice(0, maxLength);
  const boundary = Math.max(head.lastIndexOf(";"), head.lastIndexOf(" "));
  const cut = boundary > 0 ? head.slice(0, boundary) : head;
  return `${cut.replace(/[\s;,]+$/, "")}…`;
}

module.exports = { escapeRegExp, buildTermMatchers, truncateText };
