const httpMocks = require('node-mocks-http');

jest.mock('../src/db', () => ({
  query: jest.fn(),
}));

const db = require('../src/db');
const { getStats } = require('../src/controllers/statsController');

describe('statsController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('getStats returns aggregated dashboard metrics', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ count: '10' }] })
      .mockResolvedValueOnce({ rows: [{ total: '42' }] })
      .mockResolvedValueOnce({ rows: [{ total: '2048' }] })
      .mockResolvedValueOnce({ rows: [{ count: '3' }] })
      .mockResolvedValueOnce({
        rows: [
          { type: 'image', count: '6' },
          { type: 'video', count: '4' },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 'asset-1', name: 'Hero video', downloads: 9 }],
      });

    const req = httpMocks.createRequest();
    const res = httpMocks.createResponse();
    const next = jest.fn();

    await getStats(req, res, next);

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({
      totalAssets: 10,
      totalDownloads: 42,
      totalStorage: 2048,
      assetsThisMonth: 3,
      assetsByType: {
        image: 6,
        video: 4,
      },
      topDownloaded: [{ id: 'asset-1', name: 'Hero video', downloads: 9 }],
    });
  });
});
