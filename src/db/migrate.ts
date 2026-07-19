import { Pool } from 'pg';
import config from '../config';

async function runMigrations(): Promise<void> {
  const pool = new Pool({
    host: config.database.host,
    port: config.database.port,
    database: config.database.name,
    user: config.database.user,
    password: config.database.password,
  });

  try {
    console.log('Running database migrations...');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(50) NOT NULL DEFAULT 'user',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

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
      ALTER TABLE assets
      ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;
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

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_assets_user_id ON assets(user_id);
    `);

    console.log('Database migrations completed successfully.');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void runMigrations();
