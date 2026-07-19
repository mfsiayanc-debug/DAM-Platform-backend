import { Client as MinioClient } from 'minio';
import { Readable } from 'stream';
import config from '../config';

const minioClient = new MinioClient({
  endPoint: config.minio.endPoint,
  port: config.minio.port,
  useSSL: config.minio.useSSL,
  accessKey: config.minio.accessKey,
  secretKey: config.minio.secretKey,
});

async function initializeMinIO() {
  try {
    const bucketExists = await minioClient.bucketExists(config.minio.bucket);

    if (!bucketExists) {
      await minioClient.makeBucket(config.minio.bucket, 'us-east-1');
      console.log(`Bucket "${config.minio.bucket}" created successfully`);

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

      await minioClient.setBucketPolicy(config.minio.bucket, JSON.stringify(policy));
    }
  } catch (error) {
    console.error('MinIO initialization error:', error);
    throw error;
  }
}

async function uploadToMinIO(
  fileName: string,
  data: Buffer | Readable,
  contentType: string,
  size?: number,
) {
  try {
    const uploadSize = Buffer.isBuffer(data) ? data.length : size;

    await minioClient.putObject(config.minio.bucket, fileName, data, uploadSize, {
      'Content-Type': contentType,
    });
    return fileName;
  } catch (error) {
    console.error('MinIO upload error:', error);
    throw error;
  }
}

async function downloadFromMinIO(fileName: string) {
  try {
    return await minioClient.getObject(config.minio.bucket, fileName);
  } catch (error) {
    console.error('MinIO download error:', error);
    throw error;
  }
}

async function deleteFromMinIO(fileName: string) {
  try {
    await minioClient.removeObject(config.minio.bucket, fileName);
  } catch (error) {
    console.error('MinIO delete error:', error);
    throw error;
  }
}

async function getPresignedUrl(fileName: string, expirySeconds = 3600) {
  try {
    return await minioClient.presignedGetObject(config.minio.bucket, fileName, expirySeconds);
  } catch (error) {
    console.error('MinIO presigned URL error:', error);
    throw error;
  }
}

export {
  minioClient,
  initializeMinIO,
  uploadToMinIO,
  downloadFromMinIO,
  deleteFromMinIO,
  getPresignedUrl,
};
