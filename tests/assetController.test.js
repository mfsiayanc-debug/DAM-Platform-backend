const httpMocks = require('node-mocks-http');

jest.mock('../src/services/storage', () => ({
  uploadToMinIO: jest.fn().mockResolvedValue(undefined),
  downloadFromMinIO: jest.fn().mockResolvedValue({ pipe: jest.fn() }),
  deleteFromMinIO: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/services/queue', () => ({
  addJob: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/db', () => ({
  query: jest.fn(),
}));

const storage = require('../src/services/storage');
const { addJob } = require('../src/services/queue');
const db = require('../src/db');
const {
  uploadAssets,
  getAssets,
  getAssetById,
  downloadAsset,
  deleteAsset,
  updateAssetTags,
  getThumbnail,
} = require('../src/controllers/assetController');

describe('assetController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('uploadAssets returns 400 when no files', async () => {
    const req = httpMocks.createRequest({ files: [] });
    const res = httpMocks.createResponse();
    const next = jest.fn();

    await uploadAssets(req, res, next);

    expect(res.statusCode).toBe(400);
  });

  test('uploadAssets saves asset and enqueues processing job', async () => {
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'asset-1',
          name: 'file.jpg',
          type: 'image',
          size: 123,
          mime_type: 'image/jpeg',
          file_path: 'asset-1.jpg',
          thumbnail_path: 'asset-1_thumb.jpg',
          tags: '[]',
          status: 'processing',
        },
      ],
    });

    const file = {
      originalname: 'file.jpg',
      buffer: Buffer.from('test'),
      mimetype: 'image/jpeg',
      size: 4,
    };
    const req = httpMocks.createRequest({ files: [file] });
    const res = httpMocks.createResponse();
    const next = jest.fn();

    await uploadAssets(req, res, next);

    expect(storage.uploadToMinIO).toHaveBeenCalled();
    expect(addJob).toHaveBeenCalledWith(
      'process-asset',
      expect.objectContaining({
        assetId: expect.any(String),
        fileName: expect.stringContaining('.jpg'),
        thumbnailName: expect.stringContaining('_thumb.jpg'),
        assetType: 'image',
      })
    );
    expect(res.statusCode).toBe(201);
  });

  test('getAssets returns formatted assets', async () => {
    db.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: '1',
            name: 'file.jpg',
            type: 'image',
            size: 100,
            mime_type: 'image/jpeg',
            file_path: '1.jpg',
            thumbnail_path: '1_thumb.jpg',
            tags: '[]',
            metadata: '{}',
            downloads: 0,
            status: 'completed',
            uploaded_at: '2024-01-01T00:00:00Z',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ count: '1' }],
      });

    const req = httpMocks.createRequest({ query: {} });
    const res = httpMocks.createResponse();
    const next = jest.fn();

    await getAssets(req, res, next);

    expect(res.statusCode).toBe(200);
    const data = res._getJSONData();
    expect(data.assets[0]).toMatchObject({
      id: '1',
      name: 'file.jpg',
      type: 'image',
    });
  });

  test('getAssetById returns 404 when not found', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const req = httpMocks.createRequest({ params: { id: 'missing' } });
    const res = httpMocks.createResponse();
    const next = jest.fn();

    await getAssetById(req, res, next);

    expect(res.statusCode).toBe(404);
  });

  test('downloadAsset pipes file when found', async () => {
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: '1',
          name: 'file.jpg',
          mime_type: 'image/jpeg',
          file_path: '1.jpg',
        },
      ],
    });

    const req = httpMocks.createRequest({ params: { id: '1' } });
    const res = httpMocks.createResponse();
    res.setHeader = jest.fn();

    await downloadAsset(req, res, jest.fn());

    expect(storage.downloadFromMinIO).toHaveBeenCalledWith('1.jpg');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'image/jpeg');
  });

  test('deleteAsset deletes from storage and db', async () => {
    db.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: '1',
            file_path: '1.jpg',
            thumbnail_path: '1_thumb.jpg',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const req = httpMocks.createRequest({ params: { id: '1' } });
    const res = httpMocks.createResponse();

    await deleteAsset(req, res, jest.fn());

    expect(storage.deleteFromMinIO).toHaveBeenCalledWith('1.jpg');
    expect(db.query).toHaveBeenCalledWith('DELETE FROM assets WHERE id = $1', ['1']);
    expect(res.statusCode).toBe(200);
  });

  test('updateAssetTags validates tags and updates', async () => {
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: '1',
          name: 'file.jpg',
          type: 'image',
          size: 100,
          mime_type: 'image/jpeg',
          file_path: '1.jpg',
          thumbnail_path: '1_thumb.jpg',
          tags: '["tag"]',
          metadata: '{}',
          downloads: 0,
          status: 'completed',
          uploaded_at: '2024-01-01T00:00:00Z',
        },
      ],
    });

    const req = httpMocks.createRequest({
      params: { id: '1' },
      body: { tags: ['tag'] },
    });
    const res = httpMocks.createResponse();

    await updateAssetTags(req, res, jest.fn());

    expect(db.query).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  test('getThumbnail returns 202 when processing', async () => {
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: '1',
          thumbnail_path: '1_thumb.jpg',
          status: 'processing',
        },
      ],
    });

    const req = httpMocks.createRequest({ params: { id: '1' } });
    const res = httpMocks.createResponse();

    await getThumbnail(req, res, jest.fn());

    expect(res.statusCode).toBe(202);
  });
});

