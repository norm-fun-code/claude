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

  let failedCount = 0;
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
        // 15K matches the proven Apps Script setup — plenty for deep newsletter
        // summaries. (Call speed is bounded by OUTPUT length, not input.)
        const body = rawBody.slice(0, Number(process.env.EMAIL_BODY_CHARS || 15000));

        return { from, subject, snippet, body };
      } catch (err) {
        failedCount++;
        console.error(`Failed to fetch thread ${thread.id}:`, err.message);
        return null;
      }
    })
  );

  // Every thread we tried to fetch threw — a real outage (rate limit, revoked
  // token, transient Gmail-side error), not "all threads happened to be
  // empty." A partial failure logs above and quietly reports fewer threads
  // (same as one legitimately-empty thread); a TOTAL failure must be visible
  // instead of silently reading as "zero unread email," which is exactly the
  // 200-OK-read-as-success gap already fixed for Monarch/Calendar/Notion.
  if (threads.length > 0 && failedCount === threads.length) {
    throw new Error(`Gmail: all ${failedCount} unread thread(s) failed to fetch`);
  }

  return results.filter(Boolean);
}

module.exports = { fetchGmailThreads };
