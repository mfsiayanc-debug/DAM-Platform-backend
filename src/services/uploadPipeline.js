const fs = require('node:fs');
const path = require('node:path');
const { v4: uuidv4 } = require('uuid');
const FileType = require('file-type');
const { uploadToMinIO } = require('./storage');
const { addJob } = require('./queue');
const db = require('../db');

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

function isMimeTypeAllowed(mimeType) {
  return ALLOWED_MIME_TYPES.includes(mimeType);
}

function determineAssetType(mimeType) {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  return 'document';
}

function generateTags(filename, mimeType) {
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

function createStoredFileName(assetId, originalName) {
  const extension = path.extname(originalName || '');
  return extension ? `${assetId}${extension.toLowerCase()}` : assetId;
}

function shouldStrictlyValidateMimeType(mimeType) {
  return (
    mimeType?.startsWith('image/') ||
    mimeType?.startsWith('video/') ||
    mimeType === 'application/pdf'
  );
}

async function detectFileType({ buffer, sourcePath }) {
  if (buffer) {
    return FileType.fromBuffer(buffer);
  }

  if (sourcePath) {
    return FileType.fromFile(sourcePath);
  }

  return undefined;
}

async function validateUploadContent({ originalName, mimeType, buffer, sourcePath }) {
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
}) {
  if (!originalName) {
    throw new Error('Original file name is required');
  }

  if (!mimeType || !isMimeTypeAllowed(mimeType)) {
    throw new Error(`File type ${mimeType || 'unknown'} not supported`);
  }

  if (!buffer && !sourcePath) {
    throw new Error('Upload source is required');
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

  const uploadSize = size ?? buffer?.length ?? (await fs.promises.stat(sourcePath)).size;
  const uploadSource = sourcePath ? fs.createReadStream(sourcePath) : buffer;

  await uploadToMinIO(fileName, uploadSource, mimeType, uploadSize);

  const result = await db.query(
    `INSERT INTO assets 
    (id, name, type, size, mime_type, file_path, thumbnail_path, tags, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING *`,
    [
      assetId,
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

  const asset = result.rows[0];

  return {
    id: asset.id,
    name: asset.name,
    type: asset.type,
    status: asset.status,
  };
}

module.exports = {
  ALLOWED_MIME_TYPES,
  isMimeTypeAllowed,
  createAssetFromUpload,
};
