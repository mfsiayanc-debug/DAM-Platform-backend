jest.mock('../src/services/storage', () => ({
  uploadToMinIO: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/services/queue', () => ({
  addJob: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/db', () => ({
  query: jest.fn(),
}));

const mockNodeFs = {
  createReadStream: jest.fn(() => ({ mocked: true })),
  promises: {
    stat: jest.fn().mockResolvedValue({ size: 4096 }),
  },
};

jest.mock('node:fs', () => mockNodeFs);

const fs = require('node:fs');
const db = require('../src/db');
const { addJob } = require('../src/services/queue');
const { uploadToMinIO } = require('../src/services/storage');
const {
  isMimeTypeAllowed,
  createAssetFromUpload,
} = require('../src/services/uploadPipeline');

describe('uploadPipeline', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('isMimeTypeAllowed accepts supported types and rejects unknown ones', () => {
    expect(isMimeTypeAllowed('image/jpeg')).toBe(true);
    expect(isMimeTypeAllowed('application/x-msdownload')).toBe(false);
  });

  test('createAssetFromUpload stores buffer uploads and enqueues processing', async () => {
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'asset-1',
          name: 'photo.jpg',
          type: 'image',
          status: 'processing',
        },
      ],
    });

    const result = await createAssetFromUpload({
      assetId: 'asset-1',
      originalName: 'photo.jpg',
      mimeType: 'image/jpeg',
      size: 4,
      buffer: Buffer.from('data'),
    });

    expect(uploadToMinIO).toHaveBeenCalledWith('asset-1.jpg', expect.any(Buffer), 'image/jpeg', 4);
    expect(addJob).toHaveBeenCalledWith(
      'process-asset',
      expect.objectContaining({
        assetId: 'asset-1',
        fileName: 'asset-1.jpg',
        thumbnailName: 'asset-1_thumb.jpg',
        assetType: 'image',
        mimeType: 'image/jpeg',
      }),
    );
    expect(result).toEqual({
      id: 'asset-1',
      name: 'photo.jpg',
      type: 'image',
      status: 'processing',
    });
  });

  test('createAssetFromUpload supports file-path based uploads', async () => {
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'asset-2',
          name: 'clip.mp4',
          type: 'video',
          status: 'processing',
        },
      ],
    });

    await createAssetFromUpload({
      assetId: 'asset-2',
      originalName: 'clip.mp4',
      mimeType: 'video/mp4',
      sourcePath: '/tmp/clip.mp4',
    });

    expect(fs.createReadStream).toHaveBeenCalledWith('/tmp/clip.mp4');
    expect(uploadToMinIO).toHaveBeenCalledWith(
      'asset-2.mp4',
      expect.any(Object),
      'video/mp4',
      4096,
    );
  });

  test('createAssetFromUpload rejects unsupported mime types', async () => {
    await expect(
      createAssetFromUpload({
        originalName: 'malware.exe',
        mimeType: 'application/x-msdownload',
        buffer: Buffer.from('data'),
      }),
    ).rejects.toThrow('File type application/x-msdownload not supported');
  });
});
