import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';

try {
  const migration = new URL('../migrations/001_initial.sql', import.meta.url);
  await pool.query(await readFile(fileURLToPath(migration), 'utf8'));
  console.log('Database migration applied.');
} finally {
  await pool.end();
}
