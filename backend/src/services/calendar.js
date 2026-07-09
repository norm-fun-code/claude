const { google } = require('googleapis');
const { localDayBoundsUtc } = require('../util/date');

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

function formatTime(dateTimeStr, timeZone) {
  if (!dateTimeStr) return null;
  const date = new Date(dateTimeStr);
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone,
  });
}

async function fetchCalendarEvents({ date } = {}) {
  const auth = getAuthClient();
  const calendar = google.calendar({ version: 'v3', auth });

  const now = date instanceof Date ? date : new Date();
  // Built from the configured TZ, not the server process's local time (Date
  // getters honor the OS-level TZ env var, which may not match — an evening
  // reading near UTC midnight would otherwise fetch tomorrow's window).
  const { start: startOfDay, end: endOfDay } = localDayBoundsUtc(process.env.TZ || 'America/New_York', now);

  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: startOfDay.toISOString(),
    timeMax: endOfDay.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 20,
  });

  const events = res.data.items || [];
  const timeZone = res.data.summary ? undefined : (res.data.timeZone || 'America/New_York');

  // Birthdays are low-signal for daily planning — the AI doesn't know the person
  // or the relationship, so it can only guess generic context. Filter them out.
  const BIRTHDAY_RE = /\bbirthday\b|\b's bday\b/i;
  const filtered = events.filter((e) => !BIRTHDAY_RE.test(e.summary || ''));

  return filtered.map((event) => {
    const allDay = Boolean(event.start?.date && !event.start?.dateTime);
    const startTime = allDay ? null : formatTime(event.start?.dateTime, timeZone);
    const endTime = allDay ? null : formatTime(event.end?.dateTime, timeZone);

    return {
      title: event.summary || 'Untitled',
      startTime,
      endTime,
      allDay,
      location: event.location || null,
      description: event.description ? event.description.slice(0, 200) : null,
    };
  });
}

/**
 * Fetch busy blocks from the work calendar (shared as free/busy only).
 * Requires GOOGLE_WORK_CALENDAR_ID env var (typically the work email address).
 * Returns an array of { start, end } human-readable time strings, e.g.
 * [{ start: '9:00 AM', end: '10:00 AM' }, ...]
 * Returns [] if the env var is not set. Throws if the API call fails or
 * reports a per-calendar error (see calResult.errors below) — callers should
 * not treat a thrown error as "no meetings."
 */
async function fetchWorkBusyBlocks({ date } = {}) {
  const calId = process.env.GOOGLE_WORK_CALENDAR_ID;
  if (!calId) return [];

  const auth = getAuthClient();
  const calendar = google.calendar({ version: 'v3', auth });

  const day = date instanceof Date ? date : new Date();
  const timeZone = process.env.TZ || 'America/New_York';
  const { start: startOfDay, end: endOfDay } = localDayBoundsUtc(timeZone, day);

  const res = await calendar.freebusy.query({
    requestBody: {
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      timeZone,
      items: [{ id: calId }],
    },
  });

  const calResult = res.data.calendars?.[calId];
  // Google's freebusy.query returns HTTP 200 for the overall request even when
  // THIS calendar failed (revoked share, transient Google-side error) — the
  // failure is embedded in calendars[calId].errors, not a thrown error. Read
  // it, or a real outage silently reads as "no meetings today."
  if (calResult?.errors?.length) {
    const reasons = calResult.errors.map((e) => e.reason || 'unknown').join(', ');
    throw new Error(`Google freebusy query failed for ${calId}: ${reasons}`);
  }
  const busy = calResult?.busy ?? [];
  return busy.map((block) => ({
    start: formatTime(block.start, timeZone),
    end: formatTime(block.end, timeZone),
  }));
}

module.exports = { fetchCalendarEvents, fetchWorkBusyBlocks };
