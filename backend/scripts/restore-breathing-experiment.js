// One-time fix: restore the diaphragmatic breathing experiment that was
// incorrectly cancelled by proposeExperiments(), and cancel the auto-started
// gratitude experiment that replaced it without user approval.
require('dotenv').config();
const { query } = require('../src/db');

async function run() {
  // Find the cancelled breathing experiment.
  const { rows: breathing } = await query(
    `SELECT id, hypothesis, status FROM experiments WHERE hypothesis ILIKE '%diaphragmatic breathing%' ORDER BY created_at DESC LIMIT 1`
  );
  if (!breathing.length) {
    console.log('Breathing experiment not found in DB — may have been hard-deleted.');
  } else {
    const exp = breathing[0];
    console.log(`Found: [${exp.id}] "${exp.hypothesis}" (${exp.status})`);
    if (exp.status === 'cancelled') {
      // Restore to running with fresh 14-day window from today.
      const today = new Date().toISOString().slice(0, 10);
      const end = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      await query(
        `UPDATE experiments SET status='running', start_date=$1, end_date=$2 WHERE id=$3`,
        [today, end, exp.id]
      );
      console.log(`✓ Restored to running — ends ${end}`);
    } else {
      console.log(`Already ${exp.status}, no change needed.`);
    }
  }

  // Cancel the auto-started gratitude experiment (it wasn't user-approved).
  const { rows: gratitude } = await query(
    `SELECT id, hypothesis, status FROM experiments WHERE hypothesis ILIKE '%gratitude%' AND status = 'running' ORDER BY created_at DESC LIMIT 1`
  );
  if (!gratitude.length) {
    console.log('Gratitude experiment not found or already not running.');
  } else {
    const exp = gratitude[0];
    console.log(`Found: [${exp.id}] "${exp.hypothesis}" (${exp.status})`);
    await query(`UPDATE experiments SET status='cancelled' WHERE id=$1`, [exp.id]);
    console.log(`✓ Cancelled auto-started gratitude experiment.`);
  }

  process.exit(0);
}

run().catch((e) => { console.error(e); process.exit(1); });
