const { google } = require('googleapis');

function getAuthClient() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  });
  return oauth2Client;
}

function extractTextFromDoc(document) {
  const body = document.body;
  if (!body || !body.content) return '';

  const lines = [];

  for (const element of body.content) {
    if (element.paragraph) {
      const paragraphText = (element.paragraph.elements || [])
        .map((el) => el.textRun?.content || '')
        .join('')
        .trim();
      if (paragraphText) lines.push(paragraphText);
    }
  }

  return lines.join('\n');
}

/**
 * Pure: filter raw doc lines down to ones that are actually quotable. Split
 * out from fetchRandomQuote so this heuristic chain is unit-testable without
 * a live Google Docs call.
 */
function filterQuoteLines(lines) {
  return lines
    .map((l) => l.trim())
    .filter((l) => l.length > 30)
    .filter((l) => !/^[★☆#]/.test(l))   // skip decorative heading markers
    .filter((l) => !l.endsWith(':'))       // skip intro fragments like "Chapter 3:"
    // Skip numbered section/chapter headings ("03   Adversity Is the Curriculum")
    // — a leading number then a short Title Case phrase with no sentence-ending
    // punctuation. These aren't quotes at all, so any "insight" written about one
    // reads as disconnected commentary rather than actually engaging with a line.
    .filter((l) => !/^\d{1,3}\s+[A-Z]/.test(l) || /[.!?"']$/.test(l));
}

async function fetchRandomQuote() {
  const auth = getAuthClient();
  const docs = google.docs({ version: 'v1', auth });

  const res = await docs.documents.get({
    documentId: process.env.GOOGLE_DOC_ID,
  });

  const fullText = extractTextFromDoc(res.data);
  const lines = filterQuoteLines(fullText.split('\n'));

  if (lines.length === 0) {
    return { quote: 'No quotes available.' };
  }

  const randomLine = lines[Math.floor(Math.random() * lines.length)];
  return { quote: randomLine };
}

module.exports = { fetchRandomQuote, filterQuoteLines };
