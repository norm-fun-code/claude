// Calendar connector: turns today's Google Calendar into canonical
// productivity metrics + documents. Reuses the existing calendar service.
const { fetchCalendarEvents } = require('../services/calendar');

module.exports = {
  id: 'google_calendar',
  domain: 'productivity',
  displayName: 'Google Calendar',

  async sync() {
    const events = await fetchCalendarEvents();
    const now = new Date();

    const timed = events.filter((e) => !e.allDay);
    const metrics = [
      {
        ts: now,
        domain: 'productivity',
        metric: 'calendar_events',
        value: events.length,
        unit: 'count',
        source: this.id,
      },
      {
        ts: now,
        domain: 'productivity',
        metric: 'meetings',
        value: timed.length,
        unit: 'count',
        source: this.id,
      },
    ];

    const day = now.toISOString().slice(0, 10);
    const documents = events.map((e, i) => ({
      source: this.id,
      domain: 'productivity',
      externalId: `${day}:${i}:${e.title}`,
      title: e.title,
      content: [e.title, e.location, e.description].filter(Boolean).join(' — '),
      occurredAt: now,
      metadata: { startTime: e.startTime, endTime: e.endTime, allDay: e.allDay },
    }));

    return { metrics, documents };
  },
};
