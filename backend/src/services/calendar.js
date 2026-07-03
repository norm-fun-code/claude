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

async function fetchCalendarEvents() {
  const auth = getAuthClient();
  const calendar = google.calendar({ version: 'v3', auth });

  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

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
 * Returns [] if the env var is not set or the call fails.
 */
async function fetchWorkBusyBlocks({ date } = {}) {
  const calId = process.env.GOOGLE_WORK_CALENDAR_ID;
  if (!calId) return [];

  const auth = getAuthClient();
  const calendar = google.calendar({ version: 'v3', auth });

  const day = date instanceof Date ? date : new Date();
  const startOfDay = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0);
  const endOfDay = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59, 59);
  const timeZone = process.env.TZ || 'America/New_York';

  const res = await calendar.freebusy.query({
    requestBody: {
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      timeZone,
      items: [{ id: calId }],
    },
  });

  const busy = res.data.calendars?.[calId]?.busy ?? [];
  return busy.map((block) => ({
    start: formatTime(block.start, timeZone),
    end: formatTime(block.end, timeZone),
  }));
}

module.exports = { fetchCalendarEvents, fetchWorkBusyBlocks };
