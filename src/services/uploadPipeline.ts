import fs from 'node:fs';
import path from 'node:path';
import * as FileType from 'file-type';
import { v4 as uuidv4 } from 'uuid';
import db from '../db';
import { addJob } from './queue';
import { uploadToMinIO } from './storage';

type CreateAssetFromUploadInput = {
  assetId?: string;
  originalName: string;
  mimeType: string;
  size?: number;
  buffer?: Buffer;
  sourcePath?: string;
  ownerId: string;
};

const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/mpeg',
  'video/quicktime',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

function isMimeTypeAllowed(mimeType: string): boolean {
  return ALLOWED_MIME_TYPES.includes(mimeType);
}

function determineAssetType(mimeType: string): 'image' | 'video' | 'document' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  return 'document';
}

function generateTags(filename: string, mimeType: string): string[] {
  const tags = [];

  if (mimeType.startsWith('image/')) tags.push('image');
  if (mimeType.startsWith('video/')) tags.push('video');
  if (mimeType.startsWith('application/')) tags.push('document');

  const nameParts = filename
    .toLowerCase()
    .replace(/\.[^/.]+$/, '')
    .split(/[-_\s]+/)
    .filter((part) => part.length > 2);

  tags.push(...nameParts.slice(0, 5));

  return [...new Set(tags)];
}

function createStoredFileName(assetId: string, originalName: string): string {
  const extension = path.extname(originalName || '');
  return extension ? `${assetId}${extension.toLowerCase()}` : assetId;
}

function shouldStrictlyValidateMimeType(mimeType?: string): boolean {
  return (
    mimeType?.startsWith('image/') ||
    mimeType?.startsWith('video/') ||
    mimeType === 'application/pdf'
  );
}

async function detectFileType({
  buffer,
  sourcePath,
}: {
  buffer?: Buffer;
  sourcePath?: string;
}) {
  if (buffer) {
    return FileType.fromBuffer(buffer);
  }

  if (sourcePath) {
    return FileType.fromFile(sourcePath);
  }

  return undefined;
}

async function validateUploadContent({
  originalName,
  mimeType,
  buffer,
  sourcePath,
}: {
  originalName: string;
  mimeType: string;
  buffer?: Buffer;
  sourcePath?: string;
}) {
  if (!shouldStrictlyValidateMimeType(mimeType)) {
    return;
  }

  const detectedFileType = await detectFileType({ buffer, sourcePath });

  if (!detectedFileType) {
    throw new Error(
      `Uploaded content for ${originalName} does not match the declared file type ${mimeType}`,
    );
  }

  if (detectedFileType.mime !== mimeType) {
    throw new Error(
      `Uploaded content for ${originalName} was detected as ${detectedFileType.mime}, not ${mimeType}`,
    );
  }
}

async function createAssetFromUpload({
  assetId = uuidv4(),
  originalName,
  mimeType,
  size,
  buffer,
  sourcePath,
  ownerId,
}: CreateAssetFromUploadInput) {
  if (!originalName) {
    throw new Error('Original file name is required');
  }

  if (!mimeType || !isMimeTypeAllowed(mimeType)) {
    throw new Error(`File type ${mimeType || 'unknown'} not supported`);
  }

  if (!buffer && !sourcePath) {
    throw new Error('Upload source is required');
  }

  if (!ownerId) {
    throw new Error('Asset owner is required');
  }

  await validateUploadContent({
    originalName,
    mimeType,
    buffer,
    sourcePath,
  });

  const fileName = createStoredFileName(assetId, originalName);
  const thumbnailName = `${assetId}_thumb.jpg`;
  const assetType = determineAssetType(mimeType);
  const tags = generateTags(originalName, mimeType);

  const uploadSize = size ?? buffer?.length ?? (await fs.promises.stat(sourcePath!)).size;
  const uploadSource = sourcePath ? fs.createReadStream(sourcePath) : buffer!;

  await uploadToMinIO(fileName, uploadSource, mimeType, uploadSize);

  const result = await db.query(
    `INSERT INTO assets 
    (id, user_id, name, type, size, mime_type, file_path, thumbnail_path, tags, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING *`,
    [
      assetId,
      ownerId,
      originalName,
      assetType,
      uploadSize,
      mimeType,
      fileName,
      thumbnailName,
      JSON.stringify(tags),
      'processing',
    ],
  );

  await addJob('process-asset', {
    assetId,
    fileName,
    thumbnailName,
    assetType,
    mimeType,
  });

  const asset = result.rows[0] as { id: string; name: string; type: string; status: string };

  return {
    id: asset.id,
    name: asset.name,
    type: asset.type,
    status: asset.status,
  };
}

export { ALLOWED_MIME_TYPES, isMimeTypeAllowed, createAssetFromUpload };
