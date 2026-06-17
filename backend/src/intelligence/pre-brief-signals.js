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

function buildSignals({ recovery, calendar = [], workBusy = [], spend, spendBaseline }) {
  const signals = [];

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
      const s = new Date(b.start);
      const e = new Date(b.end);
      if (!isNaN(s) && !isNaN(e)) meetingMin += (e - s) / 60000;
    }
    for (const ev of calendar) {
      if (!ev.allDay && ev.startTime && ev.endTime) {
        const s = new Date(ev.startTime);
        const e = new Date(ev.endTime);
        if (!isNaN(s) && !isNaN(e)) meetingMin += (e - s) / 60000;
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
      question: `You spent ${fmt(spend)} in discretionary today (avg is ${fmt(spendBaseline)}/day) — anything to explain that?`,
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
