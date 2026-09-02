import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2';
import { createPool, type Pool } from 'mysql2/promise';
import * as schema from './schema.js';

export type Database = MySql2Database<typeof schema>;

export interface DatabaseConnection {
  db: Database;
  pool: Pool;
}

export function createDatabase(databaseUrl: string): DatabaseConnection {
  // MySQL DATETIME columns carry no zone, so the driver reads and writes them as UTC...
  const pool = createPool({ uri: databaseUrl, timezone: 'Z', connectionLimit: 10 });
  // ...and every connection pins its session time zone so CURRENT_TIMESTAMP defaults agree.
  pool.pool.on('connection', (connection) => {
    connection.query("SET time_zone = '+00:00'");
  });
  return { db: drizzle(pool, { schema, mode: 'default' }), pool };
}
