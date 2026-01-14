const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const config = require('./config');
const routes = require('./routes');
const { initializeMinIO } = require('./services/storage');
const { initializeDatabase } = require('./db');

const app = express();

// Middleware
app.use(helmet());
app.use(cors({
  origin: config.server.frontendUrl,
  credentials: true,
}));
app.use(morgan('combined'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// API Routes
app.use('/api', routes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.status(err.status || 500).json({
    error: {
      message: err.message || 'Internal Server Error',
      ...(config.server.env === 'development' && { stack: err.stack }),
    },
  });
});

// Initialize services and start server
async function startServer() {
  try {
    // Initialize database
    await initializeDatabase();
    console.log('✓ Database initialized');

    // Initialize MinIO
    await initializeMinIO();
    console.log('✓ MinIO storage initialized');

    // Start server
    app.listen(config.server.port, () => {
      console.log(`✓ Server running on port ${config.server.port}`);
      console.log(`✓ Environment: ${config.server.env}`);
      console.log(`✓ API URL: ${config.server.apiUrl}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  process.exit(0);
});
