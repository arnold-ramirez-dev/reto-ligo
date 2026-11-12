require("dotenv/config");

const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  const directory = path.join(process.cwd(), 'migrations');
  const files = fs.readdirSync(directory).filter((file) => file.endsWith('.sql')).sort();
  for (const filename of files) {
    const alreadyApplied = await client.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [filename]);
    if (alreadyApplied.rowCount) continue;
    await client.query('BEGIN');
    try {
      await client.query(fs.readFileSync(path.join(directory, filename), 'utf8'));
      await client.query('INSERT INTO schema_migrations(filename) VALUES ($1)', [filename]);
      await client.query('COMMIT');
      console.log(`Applied migration ${filename}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
  await client.end();
}

main().catch((error) => { console.error(error); process.exit(1); });
