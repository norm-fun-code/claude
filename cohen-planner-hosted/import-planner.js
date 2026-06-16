'use strict';
require('dotenv').config();
const db = require('./db');

const COLORS = ['#ff6b6b','#ffd43b','#ff922b','#e64980','#20c997','#845ef7','#339af0','#f783ac'];

const data = require('./cohen_planner_1.json');

function advUuid() { return Date.now().toString(36) + Math.random().toString(36).slice(2,8); }

(async () => {
  await db.initSchema();

  // Import planner state (P)
  if (data.P && Object.keys(data.P).length) {
    await db.query(
      `INSERT INTO planner_state (id, state) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET state = $1, updated_at = NOW()`,
      [JSON.stringify({ P: data.P })]
    );
    console.log('✓ Imported planner state (P)');
  }

  // Import scenarios
  if (Array.isArray(data.scenarios) && data.scenarios.length) {
    for (let i = 0; i < data.scenarios.length; i++) {
      const s = data.scenarios[i];
      const id = advUuid();
      const color = COLORS[i % COLORS.length];
      await db.query(
        `INSERT INTO scenarios (id, name, color, params, results)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING`,
        [id, s.name, color, JSON.stringify(s.params), null]
      );
      console.log(`✓ Imported scenario: ${s.name}`);
    }
  }

  console.log('\nDone.');
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
