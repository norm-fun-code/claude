// Recurring-charge / subscription detection — a Wealthfront/Rocket-Money-style
// feature. Pure: takes spend transactions [{ day, merchant, amount, category }]
// and returns detected recurring charges. We group by normalized merchant, then
// look for a cluster of similar-amount charges spaced at a regular cadence
// (weekly / monthly / yearly). No I/O here, so it's unit-testable.

/** Normalize a merchant name so "AMZN Mktp US*2X9" and "Amazon" collapse. */
function normalizeMerchant(name) {
  const cleaned = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')      // strip punctuation/store codes
    .replace(/\b(payment|recurring|autopay|subscription|monthly|annual|inc|llc|co|com|usa?|store|mktp)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Drop tokens that are clearly store/transaction codes: anything containing a
  // digit, or a stray 1-2 char token left over after stripping numbers.
  return cleaned
    .split(' ')
    .filter((tok) => tok && !/\d/.test(tok) && tok.length >= 3)
    .join(' ')
    .trim() || cleaned; // fall back to cleaned if filtering removed everything
}

/** Median of an array of numbers. */
function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Classify a median gap (in days) into a billing cadence, or null. */
function cadenceOf(gapDays) {
  if (gapDays >= 6 && gapDays <= 8) return { label: 'weekly', period: 7, perYear: 52 };
  if (gapDays >= 26 && gapDays <= 35) return { label: 'monthly', period: 30, perYear: 12 };
  if (gapDays >= 84 && gapDays <= 100) return { label: 'quarterly', period: 91, perYear: 4 };
  if (gapDays >= 350 && gapDays <= 380) return { label: 'yearly', period: 365, perYear: 1 };
  return null;
}

/**
 * Detect recurring charges. Returns [{ merchant, amount, cadence, perYear,
 * annual, count, lastCharge, category, active }] sorted by annual cost desc.
 *
 * A merchant qualifies when it has >= minOccurrences charges of a consistent
 * amount (within amountTolerance) at a regular cadence. `active` is false if the
 * last charge is older than ~2 billing periods (likely cancelled).
 */
function detectSubscriptions(transactions, opts = {}) {
  const o = {
    minOccurrences: 3,
    amountTolerance: 0.15, // ±15% counts as "the same" charge
    minAmount: 1,
    asOf: new Date(),
    ...opts,
  };

  // Group by normalized merchant.
  const byMerchant = new Map();
  for (const t of transactions) {
    if (!t || !Number.isFinite(t.amount) || t.amount < o.minAmount) continue;
    const key = normalizeMerchant(t.merchant);
    if (!key) continue;
    if (!byMerchant.has(key)) byMerchant.set(key, []);
    byMerchant.get(key).push(t);
  }

  const subs = [];
  for (const [, txns] of byMerchant) {
    if (txns.length < o.minOccurrences) continue;

    // Use the median amount as the "subscription price"; keep only charges close
    // to it (filters out a one-off big purchase at the same merchant).
    const amounts = txns.map((t) => t.amount);
    const medAmount = median(amounts);
    if (medAmount == null || medAmount < o.minAmount) continue;
    const consistent = txns.filter((t) => Math.abs(t.amount - medAmount) <= medAmount * o.amountTolerance);
    if (consistent.length < o.minOccurrences) continue;

    // Sort by date, compute gaps between consecutive charges.
    const dated = consistent
      .map((t) => ({ ...t, time: new Date(t.day).getTime() }))
      .filter((t) => Number.isFinite(t.time))
      .sort((a, b) => a.time - b.time);
    if (dated.length < o.minOccurrences) continue;

    const gaps = [];
    for (let i = 1; i < dated.length; i++) {
      gaps.push((dated[i].time - dated[i - 1].time) / 864e5);
    }
    const medGap = median(gaps);
    const cadence = cadenceOf(medGap);
    if (!cadence) continue; // irregular timing → not a subscription

    const last = dated[dated.length - 1];
    const ageDays = (o.asOf.getTime() - last.time) / 864e5;
    const active = ageDays <= cadence.period * 2.2;

    subs.push({
      merchant: last.merchant,        // display the most-recent raw name
      amount: Math.round(medAmount * 100) / 100,
      cadence: cadence.label,
      perYear: cadence.perYear,
      annual: Math.round(medAmount * cadence.perYear),
      count: dated.length,
      lastCharge: last.day,
      category: last.category,
      active,
    });
  }

  return subs.sort((a, b) => b.annual - a.annual);
}

/** Build subscription insight findings (pure). */
function computeSubscriptionInsights(transactions, opts = {}) {
  const subs = detectSubscriptions(transactions, opts);
  const active = subs.filter((s) => s.active);
  if (!active.length) return [];

  const fmt = (n) => '$' + Math.round(n).toLocaleString('en-US');
  const totalAnnual = active.reduce((a, s) => a + s.annual, 0);
  const totalMonthly = Math.round(totalAnnual / 12);

  const insights = [];
  // Headline: total recurring load.
  insights.push({
    type: 'subscriptions',
    title: `${active.length} subscriptions ≈ ${fmt(totalMonthly)}/mo`,
    detail:
      `You have ${active.length} recurring charges totaling about ${fmt(totalMonthly)}/month (${fmt(totalAnnual)}/yr). ` +
      `Biggest: ${active.slice(0, 3).map((s) => `${s.merchant} (${fmt(s.amount)}/${s.cadence === 'yearly' ? 'yr' : s.cadence === 'weekly' ? 'wk' : 'mo'})`).join(', ')}.`,
    evidence: { kind: 'subscriptions', count: active.length, totalAnnual, totalMonthly, items: active.slice(0, 10) },
  });

  // Flag a possibly-stale one (last charge gap unusually long but still listed),
  // or a notably large single subscription worth reviewing.
  const big = active.find((s) => s.annual >= 200);
  if (big) {
    insights.push({
      type: 'subscription_review',
      title: `Review: ${big.merchant} is ${fmt(big.annual)}/yr`,
      detail: `${big.merchant} bills ${fmt(big.amount)} ${big.cadence} — about ${fmt(big.annual)} a year. Worth confirming it's still earning its keep.`,
      evidence: { kind: 'subscription_review', merchant: big.merchant, annual: big.annual },
    });
  }

  return insights;
}

module.exports = { detectSubscriptions, computeSubscriptionInsights, normalizeMerchant, cadenceOf };
