jest.mock('../src/services/storage', () => ({
  uploadToMinIO: jest.fn().mockResolvedValue(undefined),
  downloadFromMinIO: jest.fn().mockResolvedValue({}),
}));

jest.mock('sharp', () => {
  const metadata = {
    width: 800,
    height: 600,
    format: 'jpeg',
    space: 'srgb',
    channels: 3,
    hasAlpha: false,
  };

  const sharp = jest.fn(() => ({
    metadata: jest.fn().mockResolvedValue(metadata),
    resize: jest.fn().mockReturnThis(),
    jpeg: jest.fn().mockReturnThis(),
    toBuffer: jest.fn().mockResolvedValue(Buffer.from('thumbnail')),
  }));

  return sharp;
});

jest.mock('fs', () => {
  const promises = {
    mkdtemp: jest.fn().mockResolvedValue('/tmp/dam-test'),
    rm: jest.fn().mockResolvedValue(undefined),
    readFile: jest.fn().mockResolvedValue(Buffer.from('file')),
    stat: jest.fn().mockResolvedValue({ size: 2048 }),
    unlink: jest.fn().mockResolvedValue(undefined),
  };

  return {
    promises,
    createWriteStream: jest.fn(() => ({})),
    createReadStream: jest.fn(() => ({})),
  };
});

jest.mock('os', () => ({
  tmpdir: () => '/tmp',
}));

jest.mock('stream/promises', () => ({
  pipeline: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/db', () => ({
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
}));

jest.mock('fluent-ffmpeg', () => {
  const ffmpeg = jest.fn(() => {
    const handlers = {};
    const command = {
      screenshots: jest.fn(() => {
        setImmediate(() => handlers.end?.());
        return command;
      }),
      on: jest.fn((event, handler) => {
        handlers[event] = handler;
        return command;
      }),
      videoCodec: jest.fn(() => command),
      audioCodec: jest.fn(() => command),
      size: jest.fn(() => command),
      outputOptions: jest.fn(() => command),
      output: jest.fn(() => command),
      run: jest.fn(() => {
        setImmediate(() => handlers.end?.());
      }),
    };

    return command;
  });

  ffmpeg.ffprobe = (inputPath, cb) => {
    cb(null, {
      format: { duration: 10, bit_rate: 1000 },
      streams: [
        {
          codec_type: 'video',
          width: 1920,
          height: 1080,
          codec_name: 'h264',
          r_frame_rate: '30/1',
        },
      ],
    });
  };

  return ffmpeg;
});

describe('worker processing logic', () => {
  const storage = require('../src/services/storage');
  const db = require('../src/db');
  const {
    processImageFromFile,
    processDocumentFromFile,
    processVideoFromFile,
    processAsset,
  } = require('../src/worker');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('processImageFromFile generates thumbnail and returns metadata', async () => {
    const result = await processImageFromFile('/tmp/input.jpg', 'thumb.jpg');

    expect(storage.uploadToMinIO).toHaveBeenCalledWith(
      'thumb.jpg',
      expect.any(Buffer),
      'image/jpeg',
    );

    expect(result).toMatchObject({
      width: 800,
      height: 600,
      format: 'jpeg',
      space: 'srgb',
      channels: 3,
      hasAlpha: false,
    });
  });

  test('processDocumentFromFile creates placeholder thumbnail for non-PDF', async () => {
    const mimeType = 'text/plain';
    const result = await processDocumentFromFile('/tmp/doc.txt', mimeType, 'doc-thumb.jpg');

    expect(storage.uploadToMinIO).toHaveBeenCalledWith(
      'doc-thumb.jpg',
      expect.any(Buffer),
      'image/jpeg',
    );

    expect(result).toMatchObject({
      mimeType,
    });
  });

  test('processVideoFromFile extracts metadata and thumbnail', async () => {
    const result = await processVideoFromFile('/tmp/video.mp4', 'video.mp4', 'video-thumb.jpg');

    expect(storage.uploadToMinIO).toHaveBeenCalledWith(
      'video-thumb.jpg',
      expect.any(Buffer),
      'image/jpeg',
    );
    expect(result.renditions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ height: 1080, fileName: 'video_1080p.mp4' }),
        expect.objectContaining({ height: 720, fileName: 'video_720p.mp4' }),
      ]),
    );
  });

  test('processAsset updates database status to completed on success', async () => {
    const assetId = '00000000-0000-0000-0000-000000000001';
    const data = {
      assetId,
      fileName: 'file.jpg',
      thumbnailName: 'file_thumb.jpg',
      assetType: 'image',
      mimeType: 'image/jpeg',
    };

    await processAsset(data);

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE assets'),
      expect.arrayContaining(['completed', expect.any(String), assetId]),
    );
  });
});
