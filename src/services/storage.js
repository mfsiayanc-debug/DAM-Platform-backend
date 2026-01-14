const Minio = require('minio');
const config = require('../config');

// Initialize MinIO client
const minioClient = new Minio.Client({
  endPoint: config.minio.endPoint,
  port: config.minio.port,
  useSSL: config.minio.useSSL,
  accessKey: config.minio.accessKey,
  secretKey: config.minio.secretKey,
});

// Initialize MinIO bucket
async function initializeMinIO() {
  try {
    const bucketExists = await minioClient.bucketExists(config.minio.bucket);
    
    if (!bucketExists) {
      await minioClient.makeBucket(config.minio.bucket, 'us-east-1');
      console.log(`Bucket "${config.minio.bucket}" created successfully`);
      
      // Set bucket policy to allow public read access for thumbnails
      const policy = {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { AWS: ['*'] },
            Action: ['s3:GetObject'],
            Resource: [`arn:aws:s3:::${config.minio.bucket}/*`],
          },
        ],
      };
      
      await minioClient.setBucketPolicy(
        config.minio.bucket,
        JSON.stringify(policy)
      );
    }
  } catch (error) {
    console.error('MinIO initialization error:', error);
    throw error;
  }
}

// Upload file to MinIO
async function uploadToMinIO(fileName, buffer, contentType) {
  try {
    await minioClient.putObject(
      config.minio.bucket,
      fileName,
      buffer,
      buffer.length,
      {
        'Content-Type': contentType,
      }
    );
    return fileName;
  } catch (error) {
    console.error('MinIO upload error:', error);
    throw error;
  }
}

// Download file from MinIO
async function downloadFromMinIO(fileName) {
  try {
    return await minioClient.getObject(config.minio.bucket, fileName);
  } catch (error) {
    console.error('MinIO download error:', error);
    throw error;
  }
}

// Delete file from MinIO
async function deleteFromMinIO(fileName) {
  try {
    await minioClient.removeObject(config.minio.bucket, fileName);
  } catch (error) {
    console.error('MinIO delete error:', error);
    throw error;
  }
}

// Get presigned URL for file
async function getPresignedUrl(fileName, expirySeconds = 3600) {
  try {
    return await minioClient.presignedGetObject(
      config.minio.bucket,
      fileName,
      expirySeconds
    );
  } catch (error) {
    console.error('MinIO presigned URL error:', error);
    throw error;
  }
}

module.exports = {
  minioClient,
  initializeMinIO,
  uploadToMinIO,
  downloadFromMinIO,
  deleteFromMinIO,
  getPresignedUrl,
};
