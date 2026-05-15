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

async function fetchRandomQuote() {
  const auth = getAuthClient();
  const docs = google.docs({ version: 'v1', auth });

  const res = await docs.documents.get({
    documentId: process.env.GOOGLE_DOC_ID,
  });

  const fullText = extractTextFromDoc(res.data);
  const lines = fullText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 30);

  if (lines.length === 0) {
    return { quote: 'No quotes available.' };
  }

  const randomLine = lines[Math.floor(Math.random() * lines.length)];
  return { quote: randomLine };
}

module.exports = { fetchRandomQuote };
