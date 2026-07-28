// The ONE shared context-assembly module every conversational voice entry
// point (Realtime session mint, push-to-talk /voice/ask, and the Realtime
// fast-path tools) uses to answer "what is the user looking at right now,
// and what canonical facts back that up?" — replacing two independently
// hand-maintained assemblers (chat/realtimeTools.js's old getTodayContext
// and routes/realtime.js's old buildContextPackage each re-derived the same
// today/recovery/effectiveWorkout composition separately).
//
// Two responsibilities:
//   1. resolveSelection({kind, id}) — binds a voice reference ("this",
//      "that", "why is this yellow") to a STABLE, server-resolved canonical
//      fact, by id/key, never by matching the words the user said against
//      on-screen text. Every kind here reads from the exact same
//      store/selector the corresponding screen renders from.
//   2. describeSelection(resolved) — a compact, voice-appropriate sentence
//      (never raw JSON) summarizing the resolved selection, suitable for
//      injection into a system prompt (Realtime) or a context-prefixed
//      question (push-to-talk).
'use strict';

const VALID_KINDS = new Set(['recovery', 'commitment', 'insight', 'workout', 'entity']);

/**
 * @param {{kind: string, id: string|number}|null|undefined} selection
 * @returns {Promise<{kind: string, id: string, found: boolean, data: object|null, summary: string|null}>}
 */
async function resolveSelection(selection) {
  const kind = selection && VALID_KINDS.has(selection.kind) ? selection.kind : null;
  const id = selection?.id != null ? String(selection.id) : null;
  if (!kind) return { kind: null, id: null, found: false, data: null, summary: null };

  try {
    if (kind === 'recovery') {
      const recovery = require('../intelligence/recovery');
      const r = await recovery.liveRecovery();
      if (!r) return { kind, id, found: false, data: null, summary: null };
      const label = r.presentation?.label ?? r.band;
      const summary = `Recovery is ${r.score}/100 (${label}).${r.detail ? ` ${r.detail}` : ''}`;
      return { kind, id: id ?? 'today', found: true, data: r, summary };
    }

    if (kind === 'commitment') {
      const commitmentId = Number(id);
      if (!Number.isInteger(commitmentId) || commitmentId <= 0) return { kind, id, found: false, data: null, summary: null };
      const commitmentsStore = require('../store/commitments');
      const row = await commitmentsStore.getById(commitmentId);
      if (!row) return { kind, id, found: false, data: null, summary: null };
      const summary = `Commitment: "${row.title}" (${row.status}${row.due_at ? `, due ${new Date(row.due_at).toISOString()}` : ''}).`;
      return { kind, id: String(row.id), found: true, data: row, summary };
    }

    if (kind === 'insight') {
      // Insights/anomalies (Health "Worth Knowing", Wealth findings) are
      // persisted rows with a stable evidence.anomalyKey OR numeric id —
      // look up by whichever the caller gave us, never by re-deriving the
      // insight from client-supplied title/detail text.
      const findingsStore = require('../store/findings');
      const findings = await findingsStore.listFindings({ status: 'open', limit: 100 }).catch(() => []);
      const numericId = Number(id);
      const row = findings.find((f) => (
        (f.evidence && f.evidence.anomalyKey === id) ||
        (Number.isInteger(numericId) && f.id === numericId)
      ));
      if (!row) return { kind, id, found: false, data: null, summary: null };
      const summary = `Insight: ${row.title}.${row.detail ? ` ${row.detail}` : ''}`;
      return { kind, id: row.evidence?.anomalyKey ?? String(row.id), found: true, data: row, summary };
    }

    if (kind === 'workout') {
      const { getEffectiveWorkout } = require('../services/workout');
      const w = await getEffectiveWorkout();
      if (!w) return { kind, id, found: false, data: null, summary: null };
      const adj = w.source === 'auto_downgrade' ? ' (auto-adjusted down for recovery)' : (w.source === 'override' ? ' (manually chosen)' : '');
      const summary = `Today's workout: ${w.label}${adj}.`;
      return { kind, id: id ?? 'today', found: true, data: w, summary };
    }

    // 'entity' — a caller-defined generic reference with no dedicated
    // resolver yet (deliberately inert: never fabricates a fact for an
    // unrecognized entity type).
    return { kind, id, found: false, data: null, summary: null };
  } catch (err) {
    console.error(`[voiceContext] resolveSelection(${kind}) failed:`, err.message);
    return { kind, id, found: false, data: null, summary: null };
  }
}

/** Compact, voice-safe sentence for a resolved selection, or null. */
function describeSelection(resolved) {
  if (!resolved || !resolved.found || !resolved.summary) return null;
  return resolved.summary;
}

module.exports = { VALID_KINDS, resolveSelection, describeSelection };
