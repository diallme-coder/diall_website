import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 15,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined
});
pool.on('error', (error) => console.error('Unexpected PostgreSQL idle client error:', error.message));

export type Db = typeof pool;
