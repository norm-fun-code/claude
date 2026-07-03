// Pre-brief signal detection — finds genuine anomalies before the brief builds
// and returns questions for the mobile app to surface. Answers POST back as
// annotations, which flow into annotationsContext automatically next build.
//
// Each signal: { key, question, context, severity }
//   key      — stable ID for dedup / dismissal
//   question — the string shown to the user
//   context  — label prefix used when the answer is stored as an annotation
//   severity — 0–1, higher floats to top in selectQuestions()

const fmt = (n) => '$' + Math.round(Math.abs(n)).toLocaleString('en-US');

// workBusy/calendar times arrive as bare 12-hour strings ("2:00 PM"), which
// `new Date(...)` cannot parse (silently returns Invalid Date) — this used to
// leave the packed-calendar signal permanently dead (meetingMin always 0, the
// isNaN guard skipping every block without ever logging anything). Parse the
// clock string directly instead of routing it through Date.
function toMinutesSinceMidnight(t) {
  const m = String(t).match(/(\d{1,2}):(\d{2})\s*([AaPp][Mm])?/);
  if (!m) return null;
  let h = Number(m[1]);
  const mer = m[3] ? m[3].toUpperCase() : null;
  if (mer === 'PM' && h !== 12) h += 12;
  if (mer === 'AM' && h === 12) h = 0;
  return h * 60 + Number(m[2]);
}

function buildSignals({ recovery, calendar = [], workBusy = [], spend, spendBaseline, tomorrowWorkBusy = [] }) {
  const signals = [];

  // A long / all-day block on TOMORROW's work calendar (an OOO, a travel day, a
  // wall of meetings) — ask the day PRIOR so the user can add context that flows
  // into tomorrow's brief instead of it guessing from a titleless busy block.
  if (tomorrowWorkBusy.length > 0) {
    let busyMin = 0;
    let hasAllDay = false;
    for (const b of tomorrowWorkBusy) {
      const s = toMinutesSinceMidnight(b.start);
      const e = toMinutesSinceMidnight(b.end);
      if (s != null && e != null && e > s) {
        busyMin += e - s;
        if (s <= 8 * 60 && e >= 18 * 60) hasAllDay = true; // covers the whole workday
      }
    }
    if (hasAllDay || busyMin >= 6 * 60) {
      signals.push({
        key: 'tomorrow_long_block',
        question: hasAllDay
          ? "There's an all-day block on your work calendar tomorrow — what's going on? (OOO, travel, an offsite?)"
          : `Tomorrow's work calendar is heavily blocked (${(busyMin / 60).toFixed(1)}h) — anything specific driving it?`,
        context: 'calendar note',
        severity: 0.72,
      });
    }
  }

  // Recovery outlier — score < 50 (red / lower-yellow band)
  if (recovery?.score != null && recovery.score < 50) {
    const severity = 0.9 - (recovery.score / 100) * 0.4; // lower = more severe
    signals.push({
      key: 'recovery_low',
      question: `Your recovery score is ${recovery.score} today — what do you think is really driving it?`,
      context: 'recovery note',
      severity,
    });
  }

  // Packed calendar — count all meeting time today
  if (workBusy.length > 0 || calendar.length > 0) {
    let meetingMin = 0;
    for (const b of workBusy) {
      const s = toMinutesSinceMidnight(b.start);
      const e = toMinutesSinceMidnight(b.end);
      if (s != null && e != null && e > s) meetingMin += e - s;
    }
    for (const ev of calendar) {
      if (!ev.allDay && ev.startTime && ev.endTime) {
        const s = toMinutesSinceMidnight(ev.startTime);
        const e = toMinutesSinceMidnight(ev.endTime);
        if (s != null && e != null && e > s) meetingMin += e - s;
      }
    }
    const meetingH = meetingMin / 60;
    if (meetingH >= 4) {
      signals.push({
        key: 'packed_calendar',
        question: `You have ${meetingH.toFixed(1)}h of meetings today — anything specific driving that, or just a heavy week?`,
        context: 'calendar note',
        severity: Math.min(0.75, 0.4 + (meetingH - 4) * 0.06),
      });
    }
  }

  // Discretionary spending spike — today > 1.8× daily baseline.
  // Uses spending_discretionary (rent/fixed excluded) so a 1st-of-month rent
  // payment never triggers a question about something completely expected.
  if (spend != null && spendBaseline != null && spendBaseline > 10 && spend > spendBaseline * 1.8) {
    signals.push({
      key: 'spending_spike',
      question: `You spent ${fmt(spend)} in discretionary yesterday (avg is ${fmt(spendBaseline)}/day) — anything to explain that?`,
      context: 'spending note',
      severity: Math.min(0.8, 0.5 + (spend / spendBaseline - 1.8) * 0.08),
    });
  }

  return signals;
}

/** Pick the top `max` signals by severity. */
function selectQuestions(signals, max = 2) {
  return [...signals].sort((a, b) => b.severity - a.severity).slice(0, max);
}

module.exports = { buildSignals, selectQuestions };
