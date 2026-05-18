'use strict';

/**
 * runSetup.js
 * -----------
 * Reads setup.sql, splits it on GO boundaries, and executes
 * each batch sequentially against DevDatabase_Staging.
 *
 * Usage:
 *   node runSetup.js
 *
 * Requires:  npm install mssql
 */

const sql  = require('mssql');
const fs   = require('fs');
const path = require('path');

// ─── DB config ───────────────────────────────────────────────────────────────
const config = {
  server:   '160.187.54.74',
  port:     1433,
  database: 'DevDatabase_Staging',
  user:     'sa',
  password: 'g9PruSa&3qudr',
  options: {
    encrypt:                false,
    trustServerCertificate: true,
    enableArithAbort:       true,
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Split SQL source on GO statements.
 * Handles:  GO  /  go  /  Go  on their own line (with optional whitespace),
 * with any line-ending style (\r\n or \n).
 *
 * @param  {string} source  Raw file contents
 * @returns {string[]}      Non-empty trimmed batches
 */
function splitOnGo(source) {
  // Split on a line that contains only "GO" (case-insensitive), optional surrounding whitespace
  const batches = source.split(/^\s*GO\s*$/im);
  return batches
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const sqlFilePath = path.join(__dirname, 'setup.sql');

  // 1. Read the SQL file
  console.log(`\nReading SQL file: ${sqlFilePath}`);
  let source;
  try {
    source = fs.readFileSync(sqlFilePath, 'utf8');
  } catch (err) {
    console.error(`ERROR: Could not read setup.sql — ${err.message}`);
    process.exit(1);
  }

  // 2. Split into batches
  const batches = splitOnGo(source);
  console.log(`Found ${batches.length} batch(es) to execute.\n`);

  // 3. Connect
  console.log(`Connecting to ${config.server}:${config.port}  db=${config.database} …`);
  let pool;
  try {
    pool = await sql.connect(config);
    console.log('Connected.\n');
  } catch (err) {
    console.error(`ERROR: Connection failed — ${err.message}`);
    process.exit(1);
  }

  // 4. Execute each batch
  let successCount = 0;
  let errorCount   = 0;

  for (let i = 0; i < batches.length; i++) {
    const batch   = batches[i];
    const preview = batch.replace(/\s+/g, ' ').substring(0, 80);
    const label   = `Batch ${i + 1}/${batches.length}`;

    console.log(`${label}: ${preview}…`);

    try {
      const result = await pool.request().query(batch);

      // Print any PRINT-statement output SQL Server sends back
      if (result.recordset && result.recordset.length > 0) {
        console.log('  Result:', JSON.stringify(result.recordset));
      }

      successCount++;
      console.log(`  ✓ OK\n`);
    } catch (err) {
      errorCount++;
      console.error(`  ✗ FAILED: ${err.message}`);
      console.error(`  Full batch text:\n---\n${batch}\n---\n`);
      // Continue running remaining batches so we see all errors at once
    }
  }

  // 5. Close connection
  try {
    await pool.close();
  } catch (_) {
    // ignore close errors
  }

  // 6. Summary
  console.log('═══════════════════════════════════════════════════');
  console.log(`Setup complete.  Batches: ${batches.length}  |  OK: ${successCount}  |  Failed: ${errorCount}`);
  console.log('═══════════════════════════════════════════════════\n');

  if (errorCount > 0) {
    console.error(`${errorCount} batch(es) failed.  Review errors above.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
