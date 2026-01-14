const { Pool } = require('pg');
const config = require('../config');

// Create PostgreSQL connection pool
const pool = new Pool({
  host: config.database.host,
  port: config.database.port,
  database: config.database.name,
  user: config.database.user,
  password: config.database.password,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Query helper
async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    console.log('Executed query', { text, duration, rows: res.rowCount });
    return res;
  } catch (error) {
    console.error('Database query error:', error);
    throw error;
  }
}

// Initialize database (create tables)
async function initializeDatabase() {
  try {
    await query(`
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

    // Create indexes
    await query(`
      CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(type);
    `);
    
    await query(`
      CREATE INDEX IF NOT EXISTS idx_assets_status ON assets(status);
    `);
    
    await query(`
      CREATE INDEX IF NOT EXISTS idx_assets_uploaded_at ON assets(uploaded_at DESC);
    `);
    
    await query(`
      CREATE INDEX IF NOT EXISTS idx_assets_tags ON assets USING GIN(tags);
    `);

    console.log('Database tables initialized');
  } catch (error) {
    console.error('Database initialization error:', error);
    throw error;
  }
}

// Get pool for transactions
function getPool() {
  return pool;
}

module.exports = {
  query,
  initializeDatabase,
  getPool,
};
