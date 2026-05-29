'use strict';

/**
 * Runs sp_fixes.sql — patches 5 stored procedures for race-condition and
 * edge-case fixes. Safe to run on a live database; no tables are touched.
 *
 * Usage: node src/database/runSpFixes.js
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const sql  = require('mssql');

const config = {
  server:   process.env.DB_SERVER,
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  port:     parseInt(process.env.DB_PORT, 10) || 1433,
  options:  { trustServerCertificate: true, encrypt: false },
};

async function run() {
  const sqlFile = path.join(__dirname, 'stored_procedures.sql');
  const raw     = fs.readFileSync(sqlFile, 'utf8');
  const batches = raw.split(/^\s*GO\s*$/im).map((b) => b.trim()).filter(Boolean);

  console.log(`sp_fixes.sql — ${batches.length} batches to run`);

  const pool = await sql.connect(config);
  let ok = 0, failed = 0;

  for (let i = 0; i < batches.length; i++) {
    try {
      await pool.request().batch(batches[i]);
      ok++;
    } catch (err) {
      failed++;
      console.error(`Batch ${i + 1} FAILED: ${err.message.split('\n')[0]}`);
    }
  }

  await pool.close();
  console.log(`\nDone: ${ok} OK, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => { console.error(err); process.exit(1); });
