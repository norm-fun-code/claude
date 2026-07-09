// Shared LLM output boundary: one JSON-extraction implementation and one
// validate-and-log wrapper, replacing ~10 call sites that each hand-rolled
// their own version (three near-identical local `extractJson` copies, plus
// several single-shot `JSON.parse` calls with no fallback and no failure
// logging at all). See the engineering review's #4 — the "outage string
// read as empty success" and "silently stale Chief-of-Staff brief" bugs
// were both this exact class of failure: a shape mismatch nobody could see.
//
// The single most common way a model asked to write natural multi-sentence
// prose INSIDE a JSON string value breaks JSON.parse: it emits a literal
// newline/tab byte instead of the two characters \ and n — valid as writing,
// invalid as JSON (raw control characters aren't legal inside a JSON string).
// This repairs exactly that, leaving structural whitespace between tokens
// (which JSON.parse doesn't care about either way) untouched — a small state
// machine tracking whether we're inside a string literal, correctly stepping
// over escaped quotes so it doesn't flip state on `\"` inside the text.
function escapeControlCharsInStrings(s) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (!inString) {
      if (c === '"') inString = true;
      out += c;
      continue;
    }
    if (escaped) {
      out += c;
      escaped = false;
      continue;
    }
    if (c === '\\') {
      out += c;
      escaped = true;
      continue;
    }
    if (c === '"') {
      inString = false;
      out += c;
      continue;
    }
    const code = c.charCodeAt(0);
    if (code < 0x20) {
      if (c === '\n') out += '\\n';
      else if (c === '\r') out += '\\r';
      else if (c === '\t') out += '\\t';
      else out += `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }
    out += c;
  }
  return out;
}

// Extraction handles the shapes models actually return: a clean JSON object,
// one wrapped in a ```json fence, one with leading/trailing prose around it
// (sliced between the first `{` and last `}`), and — on any of those failing
// outright — one repaired for unescaped control characters inside strings
// before a final parse attempt.
function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(s);
  } catch {
    // Even before slicing to the outermost braces, a straight parse failure
    // is often just unescaped control characters — try repairing the whole
    // string first (cheap, and handles cases with no leading/trailing prose).
    try { return JSON.parse(escapeControlCharsInStrings(s)); } catch { /* fall through */ }

    const i = s.indexOf('{');
    const j = s.lastIndexOf('}');
    if (i < 0 || j <= i) return null;
    const sliced = s.slice(i, j + 1);
    try {
      return JSON.parse(sliced);
    } catch {
      try { return JSON.parse(escapeControlCharsInStrings(sliced)); } catch { return null; }
    }
  }
}

/**
 * Parse LLM text as JSON and hand it to `validate` for shape-checking.
 * Both failure modes (unparseable text, and a parsed-but-invalid shape) are
 * logged with a preview of what the model actually returned — the piece
 * every ad-hoc version of this was missing, which is what let a bad shape
 * recur silently instead of ever getting fixed.
 *
 * @param {string} text - raw LLM output.
 * @param {object} opts
 * @param {string} opts.label - tag for log lines (e.g. 'chief-brief').
 * @param {(parsed: any) => T | null} opts.validate - shape-check/transform
 *   the parsed JSON; return null to reject it (gets logged).
 * @returns {T | null}
 */
function parseAndValidate(text, { label, validate }) {
  const parsed = extractJson(text);
  if (parsed == null) {
    const raw = String(text || '');
    console.error(
      `[llm parse] ${label}: response was not valid JSON, length=${raw.length}. ` +
      `Preview: ${JSON.stringify(raw.slice(0, 500))}`
    );
    return null;
  }
  const result = validate(parsed);
  if (result == null) {
    console.error(`[llm parse] ${label}: shape validation failed. Parsed: ${JSON.stringify(parsed).slice(0, 500)}`);
    return null;
  }
  return result;
}

module.exports = { extractJson, parseAndValidate };
