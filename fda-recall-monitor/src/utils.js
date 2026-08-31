function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Whole-word match rather than plain substring: without this, a short term
// like "NY" (New York) matches inside unrelated words like "COMPANY".
function buildTermMatchers(terms) {
  return terms.map((term) => new RegExp(`\\b${escapeRegExp(term)}\\b`));
}

module.exports = { escapeRegExp, buildTermMatchers };
