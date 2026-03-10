require('dotenv').config();

module.exports = {
  server: {
    port: process.env.PORT || 3001,
    env: process.env.NODE_ENV || 'development',
    apiUrl: process.env.API_URL || 'http://localhost:3001',
    frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
  },
  
  database: {
    url: process.env.DATABASE_URL,
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 5432,
    name: process.env.DB_NAME || 'dam_platform',
    user: process.env.DB_USER || 'dam_user',
    password: process.env.DB_PASSWORD || 'dam_password',
  },
  
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
  },
  
  minio: {
    endPoint: process.env.MINIO_ENDPOINT || 'localhost',
    port: parseInt(process.env.MINIO_PORT) || 9000,
    useSSL: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
    secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
    bucket: process.env.MINIO_BUCKET || 'dam-assets',
  },
  
  queue: {
    name: process.env.QUEUE_NAME || 'asset-processing',
    concurrency: parseInt(process.env.WORKER_CONCURRENCY) || 3,
  },
  
  upload: {
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE) || 104857600, // 100MB
  },
  
  processing: {
    thumbnail: {
      width: parseInt(process.env.THUMBNAIL_WIDTH) || 400,
      quality: parseInt(process.env.THUMBNAIL_QUALITY) || 80,
    },
    video: {
      resolutions: (process.env.VIDEO_RESOLUTIONS || '1080,720,480').split(',').map(r => parseInt(r)),
      codec: process.env.VIDEO_CODEC || 'libx264',
      audioCodec: process.env.VIDEO_AUDIO_CODEC || 'aac',
    },
  },

  auth: {
    jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '1h',
  },
};
