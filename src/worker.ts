import nodeFs from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Worker } from 'bullmq';
import ffmpeg from 'fluent-ffmpeg';
import sharp from 'sharp';
import config from './config';
import db from './db';
import { connection } from './services/queue';
import { downloadFromMinIO, uploadToMinIO } from './services/storage';

type AssetType = 'image' | 'video' | 'document';

type ProcessAssetJobData = {
  assetId: string;
  fileName: string;
  thumbnailName: string;
  assetType: AssetType;
  mimeType: string;
};

type FfmpegVideoStream = {
  codec_type?: string;
  width?: number;
  height?: number;
  codec_name?: string;
  r_frame_rate?: string;
};

type FfprobeMetadata = {
  format: {
    duration?: number;
    bit_rate?: string | number;
  };
  streams: Array<FfmpegVideoStream & { codec_type?: string }>;
};

if (config.processing.video.ffmpegPath) {
  ffmpeg.setFfmpegPath(config.processing.video.ffmpegPath);
}

if (config.processing.video.ffprobePath) {
  ffmpeg.setFfprobePath(config.processing.video.ffprobePath);
}

let worker: Worker | null = null;

if (process.env.NODE_ENV !== 'test') {
  console.log('Starting Asset Processing Worker...');

  worker = new Worker(
    config.queue.name,
    async (job) => {
      console.log(`Processing job ${job.id}:`, job.name);

      try {
        switch (job.name) {
          case 'process-asset':
            await processAsset(job.data as ProcessAssetJobData);
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

async function processAsset(data: ProcessAssetJobData): Promise<void> {
  const { assetId, fileName, thumbnailName, assetType, mimeType } = data;

  console.log(`Processing asset ${assetId} (${assetType})`);

  try {
    let metadata: Record<string, unknown> = {};
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
      await removeDirectoryWithRetries(tempDir);
    }

    await db.query(
      `UPDATE assets 
       SET status = $1, metadata = $2, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $3`,
      ['completed', JSON.stringify(metadata), assetId],
    );

    console.log(`Asset ${assetId} processed successfully`);
  } catch (error) {
    console.error(`Failed to process asset ${assetId}:`, error);

    await db.query(
      `UPDATE assets 
       SET status = $1, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $2`,
      ['failed', assetId],
    );

    throw error;
  }
}

async function downloadMinIOToFile(objectName: string, destPath: string): Promise<void> {
  const stream = await downloadFromMinIO(objectName);
  await pipeline(stream, nodeFs.createWriteStream(destPath));
}

async function processImageFromFile(inputPath: string, thumbnailName: string) {
  console.log('Processing image...');

  const inputBuffer = await fs.readFile(inputPath);
  const image = sharp(inputBuffer);
  const metadata = await image.metadata();

  const thumbnailBuffer = await image
    .resize(config.processing.thumbnail.width, null, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: config.processing.thumbnail.quality })
    .toBuffer();

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

function ensureFfprobeAvailable(): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg.getAvailableFormats((error) => {
      if (error) {
        reject(
          new Error(
            'FFmpeg/ffprobe is not available. Install FFmpeg and ensure ffmpeg/ffprobe are on PATH, or set FFMPEG_PATH and FFPROBE_PATH.',
          ),
        );
        return;
      }

      resolve();
    });
  });
}

async function ensureVideoTooling(): Promise<void> {
  await ensureFfprobeAvailable();
}

function parseFrameRate(frameRate?: string): number | undefined {
  if (!frameRate) {
    return undefined;
  }

  const [numeratorRaw, denominatorRaw] = frameRate.split('/');
  const numerator = Number(numeratorRaw);
  const denominator = Number(denominatorRaw || '1');

  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return undefined;
  }

  return numerator / denominator;
}

function getVideoMetadata(inputPath: string) {
  return new Promise<{
    duration: number;
    width?: number;
    height?: number;
    codec?: string;
    bitrate?: string | number;
    fps?: number;
    hasAudio: boolean;
  }>((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, metadata: FfprobeMetadata) => {
      if (err) {
        reject(err);
        return;
      }

      const videoStream = metadata.streams.find((s) => s.codec_type === 'video');
      const audioStream = metadata.streams.find((s) => s.codec_type === 'audio');
      const duration = metadata.format.duration ?? 0;

      resolve({
        duration: Math.round(duration),
        width: videoStream?.width,
        height: videoStream?.height,
        codec: videoStream?.codec_name,
        bitrate: metadata.format.bit_rate,
        fps: parseFrameRate(videoStream?.r_frame_rate),
        hasAudio: !!audioStream,
      });
    });
  });
}

function generateVideoThumbnail(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .screenshots({
        count: 1,
        filename: path.basename(outputPath),
        folder: path.dirname(outputPath),
        size: `${config.processing.thumbnail.width}x?`,
        timemarks: ['1'],
      })
      .on('end', () => resolve())
      .on('error', reject);
  });
}

type VideoMetadata = Awaited<ReturnType<typeof getVideoMetadata>>;

async function transcodeVideo(
  inputPath: string,
  fileName: string,
  metadata: VideoMetadata,
  outputDir: string,
) {
  const resolutions = config.processing.video.resolutions;
  const baseName = fileName.replace(/\.[^/.]+$/, '');
  const renditions = [];

  for (const resolution of resolutions) {
    if ((metadata.height ?? 0) < resolution) continue;

    const outputFileName = `${baseName}_${resolution}p.mp4`;
    const outputPath = path.join(outputDir || os.tmpdir(), outputFileName);

    try {
      await transcodeToResolution(inputPath, outputPath, resolution);

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

      await fs.unlink(outputPath);

      console.log(`Transcoded to ${resolution}p`);
    } catch (error) {
      console.error(`Failed to transcode to ${resolution}p:`, error);
    }
  }

  return renditions;
}

function transcodeToResolution(inputPath: string, outputPath: string, height: number): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .videoCodec(config.processing.video.codec)
      .audioCodec(config.processing.video.audioCodec)
      .size(`?x${height}`)
      .outputOptions(['-preset fast', '-crf 23'])
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', reject)
      .run();
  });
}

async function processVideoFromFile(inputPath: string, fileName: string, thumbnailName: string) {
  console.log('Processing video...');

  await ensureVideoTooling();

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dam-video-'));
  const thumbnailPath = path.join(tempDir, 'thumbnail.jpg');

  try {
    const metadata = await getVideoMetadata(inputPath);
    await generateVideoThumbnail(inputPath, thumbnailPath);

    const thumbnailBuffer = await fs.readFile(thumbnailPath);
    await uploadToMinIO(thumbnailName, thumbnailBuffer, 'image/jpeg');

    const renditions = await transcodeVideo(inputPath, fileName, metadata, tempDir);

    return {
      ...metadata,
      renditions,
    };
  } finally {
    await removeDirectoryWithRetries(tempDir);
  }
}

async function processDocumentFromFile(
  inputPath: string,
  mimeType: string,
  thumbnailName: string,
) {
  console.log('Processing document...');
  console.log(`Thumbnail will be saved as: ${thumbnailName}`);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dam-document-'));

  try {
    let thumbnailBuffer: Buffer;
    const metadata: Record<string, unknown> = {
      mimeType,
    };

    if (mimeType === 'application/pdf') {
      thumbnailBuffer = await createPlaceholderThumbnail('PDF', 'application/pdf');
      metadata.isPDF = true;
    } else {
      console.log(`Creating placeholder thumbnail for ${mimeType}`);
      const docType = getDocumentTypeLabel(mimeType);
      thumbnailBuffer = await createPlaceholderThumbnail(docType, mimeType);
    }

    await uploadToMinIO(thumbnailName, thumbnailBuffer, 'image/jpeg');
    console.log(`Document thumbnail uploaded successfully: ${thumbnailName}`);

    try {
      const stat = await fs.stat(inputPath);
      metadata.size = stat.size;
    } catch {
      // Best-effort size only.
    }

    return metadata;
  } finally {
    await removeDirectoryWithRetries(tempDir);
  }
}

async function removeDirectoryWithRetries(
  targetPath: string,
  retries = 5,
  delayMs = 150,
): Promise<void> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await fs.rm(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      const isLastAttempt = attempt === retries;
      const isRetryableWindowsLock = ['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(err.code || '');

      if (!isRetryableWindowsLock || isLastAttempt) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
    }
  }
}

function getDocumentTypeLabel(mimeType?: string): string {
  if (!mimeType) return 'FILE';

  const map: Record<string, string> = {
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

async function createPlaceholderThumbnail(label: string, mimeType?: string): Promise<Buffer> {
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

  process.on('SIGTERM', async () => {
    console.log('SIGTERM received, closing worker...');
    await worker?.close();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    console.log('SIGINT received, closing worker...');
    await worker?.close();
    process.exit(0);
  });
}

export {
  worker,
  processAsset,
  processImageFromFile,
  processVideoFromFile,
  processDocumentFromFile,
  ensureVideoTooling,
  removeDirectoryWithRetries,
  downloadMinIOToFile,
  getVideoMetadata,
  generateVideoThumbnail,
  transcodeVideo,
  transcodeToResolution,
};
