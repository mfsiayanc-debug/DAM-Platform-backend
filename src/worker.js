const { Worker } = require('bullmq');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const config = require('./config');
const { connection } = require('./services/queue');
const { uploadToMinIO } = require('./services/storage');
const db = require('./db');

console.log('Starting Asset Processing Worker...');

// Create worker
const worker = new Worker(
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
  }
);

// Process asset (thumbnails, metadata, video transcoding)
async function processAsset(data) {
  const { assetId, fileName, thumbnailName, assetType, mimeType, originalBuffer } = data;
  
  console.log(`Processing asset ${assetId} (${assetType})`);

  try {
    // Convert base64 buffer back to Buffer
    const buffer = Buffer.from(originalBuffer, 'base64');
    
    let metadata = {};

    if (assetType === 'image') {
      metadata = await processImage(buffer, thumbnailName);
    } else if (assetType === 'video') {
      metadata = await processVideo(buffer, fileName, thumbnailName);
    } else {
      metadata = await processDocument(buffer);
    }

    // Update asset in database
    await db.query(
      `UPDATE assets 
       SET status = $1, metadata = $2, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $3`,
      ['completed', JSON.stringify(metadata), assetId]
    );

    console.log(`Asset ${assetId} processed successfully`);
  } catch (error) {
    console.error(`Failed to process asset ${assetId}:`, error);
    
    // Mark as failed
    await db.query(
      `UPDATE assets 
       SET status = $1, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $2`,
      ['failed', assetId]
    );
    
    throw error;
  }
}

// Process image: generate thumbnail and extract metadata
async function processImage(buffer, thumbnailName) {
  console.log('Processing image...');
  
  const image = sharp(buffer);
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
async function processVideo(buffer, fileName, thumbnailName) {
  console.log('Processing video...');
  
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dam-video-'));
  const inputPath = path.join(tempDir, 'input.mp4');
  const thumbnailPath = path.join(tempDir, 'thumbnail.jpg');

  try {
    // Write buffer to temp file
    await fs.writeFile(inputPath, buffer);

    // Extract metadata
    const metadata = await getVideoMetadata(inputPath);

    // Generate thumbnail at 1 second
    await generateVideoThumbnail(inputPath, thumbnailPath);

    // Upload thumbnail
    const thumbnailBuffer = await fs.readFile(thumbnailPath);
    await uploadToMinIO(thumbnailName, thumbnailBuffer, 'image/jpeg');

    // Transcode video to different resolutions (optional, can be heavy)
    // await transcodeVideo(inputPath, fileName, metadata);

    return metadata;
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

      const videoStream = metadata.streams.find(s => s.codec_type === 'video');
      const audioStream = metadata.streams.find(s => s.codec_type === 'audio');

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
async function transcodeVideo(inputPath, fileName, metadata) {
  const resolutions = config.processing.video.resolutions;
  const baseName = fileName.replace(/\.[^/.]+$/, '');

  for (const resolution of resolutions) {
    // Skip if original is smaller
    if (metadata.height < resolution) continue;

    const outputFileName = `${baseName}_${resolution}p.mp4`;
    const outputPath = path.join(os.tmpdir(), outputFileName);

    try {
      await transcodeToResolution(inputPath, outputPath, resolution);
      
      // Upload transcoded file
      const transcodedBuffer = await fs.readFile(outputPath);
      await uploadToMinIO(outputFileName, transcodedBuffer, 'video/mp4');
      
      // Cleanup
      await fs.unlink(outputPath);
      
      console.log(`Transcoded to ${resolution}p`);
    } catch (error) {
      console.error(`Failed to transcode to ${resolution}p:`, error);
    }
  }
}

// Transcode video to specific resolution
function transcodeToResolution(inputPath, outputPath, height) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .videoCodec(config.processing.video.codec)
      .audioCodec(config.processing.video.audioCodec)
      .size(`?x${height}`)
      .outputOptions([
        '-preset fast',
        '-crf 23',
      ])
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

// Process document: extract metadata and generate thumbnail
async function processDocument(buffer, mimeType, thumbnailName) {
  console.log('Processing document...');
  console.log(`Thumbnail will be saved as: ${thumbnailName}`);
  
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dam-document-'));
  
  try {
    let thumbnailBuffer;
    let metadata = {
      size: buffer.length,
      mimeType,
    };

    // Handle PDF documents
    if (mimeType === 'application/pdf') {
      const inputPath = path.join(tempDir, 'input.pdf');
      const outputPrefix = path.join(tempDir, 'page');
      
      // Write PDF to temp file
      await fs.writeFile(inputPath, buffer);

      try {
        // Convert first page of PDF to PNG
        const opts = {
          format: 'png',
          out_dir: tempDir,
          out_prefix: 'page',
          page: 1,
        };

        await convert(inputPath, opts);
        
        // Read the generated PNG
        const pngPath = path.join(tempDir, 'page-1.png');
        const pngBuffer = await fs.readFile(pngPath);
        
        // Resize PNG to thumbnail using Sharp
        thumbnailBuffer = await sharp(pngBuffer)
          .resize(config.processing.thumbnail.width, null, {
            fit: 'inside',
            withoutEnlargement: true,
          })
          .jpeg({ quality: config.processing.thumbnail.quality })
          .toBuffer();
        
        console.log(`PDF thumbnail generated: ${thumbnailBuffer.length} bytes`);
        
        // Extract PDF metadata (page count, etc.)
        // This is a simple implementation - you can enhance with pdf-lib for more details
        metadata.isPDF = true;
        
      } catch (pdfError) {
        console.warn('PDF thumbnail generation failed, creating placeholder:', pdfError.message);
        thumbnailBuffer = await createPlaceholderThumbnail('PDF', 'application/pdf');
      }
    } else {
      // For other document types (Word, Excel, etc.), create placeholder thumbnail
      console.log(`Creating placeholder thumbnail for ${mimeType}`);
      const docType = getDocumentTypeLabel(mimeType);
      thumbnailBuffer = await createPlaceholderThumbnail(docType, mimeType);
    }

    // Upload thumbnail to MinIO
    await uploadToMinIO(thumbnailName, thumbnailBuffer, 'image/jpeg');
    console.log(`Document thumbnail uploaded successfully: ${thumbnailName}`);

    return metadata;
  } finally {
    // Cleanup temp files
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

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
