const { Pool } = require('pg');
const config = require('../config');

// Simple, idempotent migration runner for initial schema.
// In the future, you can replace this with a full migration tool
// (e.g. node-pg-migrate, Knex, Prisma) and move this SQL into
// a proper versioned migration file.

async function runMigrations() {
  const pool = new Pool({
    host: config.database.host,
    port: config.database.port,
    database: config.database.name,
    user: config.database.user,
    password: config.database.password,
  });

  try {
    console.log('Running database migrations...');

    // Initial assets table + indexes (moved from db.initializeDatabase)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS assets (
        id UUID PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        type VARCHAR(50) NOT NULL,
        size BIGINT NOT NULL,
        mime_type VARCHAR(100) NOT NULL,
        file_path VARCHAR(500) NOT NULL,
        thumbnail_path VARCHAR(500),
        tags JSONB DEFAULT '[]',
        metadata JSONB DEFAULT '{}',
        downloads INTEGER DEFAULT 0,
        status VARCHAR(50) DEFAULT 'pending',
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(type);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_assets_status ON assets(status);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_assets_uploaded_at ON assets(uploaded_at DESC);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_assets_tags ON assets USING GIN(tags);
    `);

    console.log('Database migrations completed successfully.');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

runMigrations();

