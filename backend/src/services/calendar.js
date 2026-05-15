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

  return events.map((event) => {
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

module.exports = { fetchCalendarEvents };
