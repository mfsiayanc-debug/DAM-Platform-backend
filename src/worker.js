const { Worker } = require('bullmq');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const nodeFs = require('fs');
const fs = require('fs').promises;
const os = require('os');
const { pipeline } = require('stream/promises');
const config = require('./config');
const { connection } = require('./services/queue');
const { uploadToMinIO, downloadFromMinIO } = require('./services/storage');
const db = require('./db');

let worker = null;

if (process.env.NODE_ENV !== 'test') {
  console.log('Starting Asset Processing Worker...');

  // Create worker
  worker = new Worker(
    config.queue.name,
    async (job) => {
      console.log(`Processing job ${job.id}:`, job.name);

      try {
        switch (job.name) {
          case 'process-asset':
            await processAsset(job.data);
            break;
          default:
            console.warn(`Unknown job type: ${job.name}`);
        }
      } catch (error) {
        console.error(`Job ${job.id} failed:`, error);
        throw error;
      }
    },
    {
      connection,
      concurrency: config.queue.concurrency,
    },
  );
}

// Process asset (thumbnails, metadata, video transcoding)
async function processAsset(data) {
  const { assetId, fileName, thumbnailName, assetType, mimeType } = data;

  console.log(`Processing asset ${assetId} (${assetType})`);

  try {
    let metadata = {};

    // Fetch original from MinIO without putting it in the queue payload.
    // Download to a temp file so we don't need to hold large originals in RAM.
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dam-asset-'));
    const inputPath = path.join(tempDir, fileName);

    try {
      await downloadMinIOToFile(fileName, inputPath);

      if (assetType === 'image') {
        metadata = await processImageFromFile(inputPath, thumbnailName);
      } else if (assetType === 'video') {
        metadata = await processVideoFromFile(inputPath, fileName, thumbnailName);
      } else {
        metadata = await processDocumentFromFile(inputPath, mimeType, thumbnailName);
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    // Update asset in database
    await db.query(
      `UPDATE assets 
       SET status = $1, metadata = $2, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $3`,
      ['completed', JSON.stringify(metadata), assetId],
    );

    console.log(`Asset ${assetId} processed successfully`);
  } catch (error) {
    console.error(`Failed to process asset ${assetId}:`, error);

    // Mark as failed
    await db.query(
      `UPDATE assets 
       SET status = $1, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $2`,
      ['failed', assetId],
    );

    throw error;
  }
}

async function downloadMinIOToFile(objectName, destPath) {
  const stream = await downloadFromMinIO(objectName);
  await pipeline(stream, nodeFs.createWriteStream(destPath));
}

// Process image: generate thumbnail and extract metadata
async function processImageFromFile(inputPath, thumbnailName) {
  console.log('Processing image...');

  const image = sharp(inputPath);
  const metadata = await image.metadata();

  // Generate thumbnail
  const thumbnailBuffer = await image
    .resize(config.processing.thumbnail.width, null, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: config.processing.thumbnail.quality })
    .toBuffer();

  // Upload thumbnail to MinIO
  await uploadToMinIO(thumbnailName, thumbnailBuffer, 'image/jpeg');

  return {
    width: metadata.width,
    height: metadata.height,
    format: metadata.format,
    space: metadata.space,
    channels: metadata.channels,
    hasAlpha: metadata.hasAlpha,
  };
}

// Process video: extract thumbnail, metadata, and transcode
async function processVideoFromFile(inputPath, fileName, thumbnailName) {
  console.log('Processing video...');

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dam-video-'));
  const thumbnailPath = path.join(tempDir, 'thumbnail.jpg');

  try {
    // Extract metadata
    const metadata = await getVideoMetadata(inputPath);

    // Generate thumbnail at 1 second
    await generateVideoThumbnail(inputPath, thumbnailPath);

    // Upload thumbnail
    const thumbnailBuffer = await fs.readFile(thumbnailPath);
    await uploadToMinIO(thumbnailName, thumbnailBuffer, 'image/jpeg');

    const renditions = await transcodeVideo(inputPath, fileName, metadata, tempDir);

    return {
      ...metadata,
      renditions,
    };
  } finally {
    // Cleanup temp files
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

// Get video metadata using ffmpeg
function getVideoMetadata(inputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) {
        reject(err);
        return;
      }

      const videoStream = metadata.streams.find((s) => s.codec_type === 'video');
      const audioStream = metadata.streams.find((s) => s.codec_type === 'audio');

      resolve({
        duration: Math.round(metadata.format.duration),
        width: videoStream?.width,
        height: videoStream?.height,
        codec: videoStream?.codec_name,
        bitrate: metadata.format.bit_rate,
        fps: eval(videoStream?.r_frame_rate), // e.g., "30/1" -> 30
        hasAudio: !!audioStream,
      });
    });
  });
}

// Generate video thumbnail
function generateVideoThumbnail(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .screenshots({
        count: 1,
        filename: path.basename(outputPath),
        folder: path.dirname(outputPath),
        size: `${config.processing.thumbnail.width}x?`,
        timemarks: ['1'],
      })
      .on('end', resolve)
      .on('error', reject);
  });
}

// Transcode video to multiple resolutions
async function transcodeVideo(inputPath, fileName, metadata, outputDir) {
  const resolutions = config.processing.video.resolutions;
  const baseName = fileName.replace(/\.[^/.]+$/, '');
  const renditions = [];

  for (const resolution of resolutions) {
    // Skip if original is smaller
    if (metadata.height < resolution) continue;

    const outputFileName = `${baseName}_${resolution}p.mp4`;
    const outputPath = path.join(outputDir || os.tmpdir(), outputFileName);

    try {
      await transcodeToResolution(inputPath, outputPath, resolution);

      // Upload transcoded file
      const transcodedStat = await fs.stat(outputPath);
      await uploadToMinIO(
        outputFileName,
        nodeFs.createReadStream(outputPath),
        'video/mp4',
        transcodedStat.size,
      );

      renditions.push({
        height: resolution,
        fileName: outputFileName,
        mimeType: 'video/mp4',
        size: transcodedStat.size,
      });

      // Cleanup
      await fs.unlink(outputPath);

      console.log(`Transcoded to ${resolution}p`);
    } catch (error) {
      console.error(`Failed to transcode to ${resolution}p:`, error);
    }
  }

  return renditions;
}

// Transcode video to specific resolution
function transcodeToResolution(inputPath, outputPath, height) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .videoCodec(config.processing.video.codec)
      .audioCodec(config.processing.video.audioCodec)
      .size(`?x${height}`)
      .outputOptions(['-preset fast', '-crf 23'])
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

// Process document: extract metadata and generate thumbnail
async function processDocumentFromFile(inputPath, mimeType, thumbnailName) {
  console.log('Processing document...');
  console.log(`Thumbnail will be saved as: ${thumbnailName}`);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dam-document-'));

  try {
    let thumbnailBuffer;
    let metadata = {
      mimeType,
    };

    // Handle PDF documents
    if (mimeType === 'application/pdf') {
      thumbnailBuffer = await createPlaceholderThumbnail('PDF', 'application/pdf');
      metadata.isPDF = true;
    } else {
      // For other document types (Word, Excel, etc.), create placeholder thumbnail
      console.log(`Creating placeholder thumbnail for ${mimeType}`);
      const docType = getDocumentTypeLabel(mimeType);
      thumbnailBuffer = await createPlaceholderThumbnail(docType, mimeType);
    }

    // Upload thumbnail to MinIO
    await uploadToMinIO(thumbnailName, thumbnailBuffer, 'image/jpeg');
    console.log(`Document thumbnail uploaded successfully: ${thumbnailName}`);

    try {
      const stat = await fs.stat(inputPath);
      metadata.size = stat.size;
    } catch {
      // Best-effort size; avoid failing processing for a missing stat
    }

    return metadata;
  } finally {
    // Cleanup temp files
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function getDocumentTypeLabel(mimeType) {
  if (!mimeType) return 'FILE';

  const map = {
    'application/pdf': 'PDF',
    'application/msword': 'DOC',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
    'application/vnd.ms-excel': 'XLS',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
    'application/vnd.ms-powerpoint': 'PPT',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PPTX',
    'text/plain': 'TXT',
    'text/csv': 'CSV',
    'application/json': 'JSON',
    'application/xml': 'XML',
  };

  return map[mimeType] || mimeType.split('/')[1]?.toUpperCase() || 'FILE';
}

async function createPlaceholderThumbnail(label, mimeType) {
  const width = config.processing.thumbnail.width;
  const height = Math.round(width * 1.3);

  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#2c2c2c"/>
      <rect x="10%" y="20%" width="80%" height="60%" rx="12" fill="#444"/>
      <text x="50%" y="50%" 
            dominant-baseline="middle" 
            text-anchor="middle" 
            font-size="48" 
            font-family="Arial, Helvetica, sans-serif"
            fill="#ffffff"
            font-weight="bold">
        ${label}
      </text>
      <text x="50%" y="70%" 
            dominant-baseline="middle" 
            text-anchor="middle" 
            font-size="16"
            font-family="Arial, Helvetica, sans-serif"
            fill="#cccccc">
        ${mimeType || ''}
      </text>
    </svg>
  `;

  return sharp(Buffer.from(svg)).jpeg({ quality: config.processing.thumbnail.quality }).toBuffer();
}

if (worker) {
  // Worker event handlers
  worker.on('completed', (job) => {
    console.log(`Job ${job.id} completed successfully`);
  });

  worker.on('failed', (job, err) => {
    console.error(`Job ${job?.id} failed:`, err.message);
  });

  worker.on('error', (err) => {
    console.error('Worker error:', err);
  });

  console.log(`Worker started with concurrency: ${config.queue.concurrency}`);
  console.log('Waiting for jobs...');

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('SIGTERM received, closing worker...');
    await worker.close();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    console.log('SIGINT received, closing worker...');
    await worker.close();
    process.exit(0);
  });
}

module.exports = {
  worker,
  processAsset,
  processImageFromFile,
  processVideoFromFile,
  processDocumentFromFile,
  downloadMinIOToFile,
  getVideoMetadata,
  generateVideoThumbnail,
  transcodeVideo,
  transcodeToResolution,
};
