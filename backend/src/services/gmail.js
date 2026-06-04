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

function decodeBase64(encoded) {
  if (!encoded) return '';
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf-8');
}

function extractBody(payload) {
  if (!payload) return '';

  // Direct body
  if (payload.body && payload.body.data) {
    return decodeBase64(payload.body.data);
  }

  // Multipart: prefer text/plain, fall back to text/html
  if (payload.parts) {
    const textPart = payload.parts.find((p) => p.mimeType === 'text/plain');
    if (textPart && textPart.body && textPart.body.data) {
      return decodeBase64(textPart.body.data);
    }
    const htmlPart = payload.parts.find((p) => p.mimeType === 'text/html');
    if (htmlPart && htmlPart.body && htmlPart.body.data) {
      // Strip tags for plain text
      return decodeBase64(htmlPart.body.data).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
    // Recurse into nested parts
    for (const part of payload.parts) {
      const nested = extractBody(part);
      if (nested) return nested;
    }
  }

  return '';
}

async function fetchGmailThreads() {
  const auth = getAuthClient();
  const gmail = google.gmail({ version: 'v1', auth });

  // List unread threads, max 15
  const listRes = await gmail.users.threads.list({
    userId: 'me',
    q: 'is:unread',
    maxResults: 15,
  });

  const threads = listRes.data.threads || [];
  if (threads.length === 0) return [];

  const results = await Promise.all(
    threads.map(async (thread) => {
      try {
        const threadRes = await gmail.users.threads.get({
          userId: 'me',
          id: thread.id,
          format: 'full',
        });

        const messages = threadRes.data.messages || [];
        if (messages.length === 0) return null;

        const firstMessage = messages[0];
        const headers = firstMessage.payload?.headers || [];

        const getHeader = (name) =>
          headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

        const from = getHeader('From');
        const subject = getHeader('Subject');
        const snippet = firstMessage.snippet || '';
        const rawBody = extractBody(firstMessage.payload);
        // Capture the substance of the email without hauling huge bodies around
        // (the prompt builder caps per-email anyway). 8K is plenty for a
        // newsletter's key content and keeps the LLM call fast.
        const body = rawBody.slice(0, Number(process.env.EMAIL_BODY_CHARS || 8000));

        return { from, subject, snippet, body };
      } catch (err) {
        console.error(`Failed to fetch thread ${thread.id}:`, err.message);
        return null;
      }
    })
  );

  return results.filter(Boolean);
}

module.exports = { fetchGmailThreads };
