'use strict';
// Usage: node migrate.js ./cohen-planner-backup.json
require('dotenv').config();
const fs = require('fs');
const db = require('./db');

(async () => {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: node migrate.js <backup.json>');
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error('Failed to read/parse file:', err.message);
    process.exit(1);
  }

  await db.initSchema();

  // Planner state
  if (data.plannerState && Object.keys(data.plannerState).length) {
    await db.query(
      `INSERT INTO planner_state (id, state) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET state = $1, updated_at = NOW()`,
      [JSON.stringify(data.plannerState)]
    );
    console.log('✓ Imported planner state');
  } else {
    console.log('— No planner state to import');
  }

  // Scenarios
  if (Array.isArray(data.scenarios) && data.scenarios.length) {
    for (const s of data.scenarios) {
      await db.query(
        `INSERT INTO scenarios (id, name, color, params, results)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING`,
        [s.id, s.name, s.color || null, JSON.stringify(s.params || {}), JSON.stringify(s.results || null)]
      );
    }
    console.log(`✓ Imported ${data.scenarios.length} scenario(s)`);
  } else {
    console.log('— No scenarios to import');
  }

  // Advisor chats
  if (data.advisorChats) {
    const chats = data.advisorChats.chats || data.advisorChats;
    const entries = Object.entries(chats);
    for (const [id, c] of entries) {
      await db.query(
        `INSERT INTO advisor_chats (id, title, messages)
         VALUES ($1, $2, $3)
         ON CONFLICT (id) DO NOTHING`,
        [c.id || id, c.title || 'Imported chat', JSON.stringify(c.messages || [])]
      );
    }
    console.log(`✓ Imported ${entries.length} chat(s)`);
  } else {
    console.log('— No advisor chats to import');
  }

  console.log('\nMigration complete.');
  process.exit(0);
})().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
