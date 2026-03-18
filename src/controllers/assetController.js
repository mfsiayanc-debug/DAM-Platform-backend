const { downloadFromMinIO, deleteFromMinIO } = require('../services/storage');
const { createAssetFromUpload } = require('../services/uploadPipeline');
const db = require('../db');

// Upload multiple assets
async function uploadAssets(req, res, next) {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const uploadedAssets = [];

    for (const file of req.files) {
      const asset = await createAssetFromUpload({
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        buffer: file.buffer,
      });

      uploadedAssets.push(asset);
    }

    res.status(201).json({
      message: `${uploadedAssets.length} asset(s) uploaded successfully`,
      assets: uploadedAssets,
    });
  } catch (error) {
    next(error);
  }
}

// Get thumbnail
async function getThumbnail(req, res, next) {
  try {
    const { id } = req.params;

    const result = await db.query('SELECT * FROM assets WHERE id = $1', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    const asset = result.rows[0];

    if (!asset.thumbnail_path) {
      return res.status(404).json({ error: 'Thumbnail not available' });
    }

    // Check if thumbnail processing is complete
    if (asset.status === 'processing') {
      return res
        .status(202)
        .json({ message: 'Thumbnail is being generated', status: 'processing' });
    }

    if (asset.status === 'failed') {
      return res.status(500).json({ error: 'Thumbnail generation failed' });
    }

    // Get thumbnail from MinIO
    try {
      const fileStream = await downloadFromMinIO(asset.thumbnail_path);

      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 1 day
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

      fileStream.pipe(res);
    } catch (storageError) {
      console.error(`Failed to retrieve thumbnail for asset ${id}:`, storageError);
      // If thumbnail doesn't exist in MinIO, return 404
      return res.status(404).json({ error: 'Thumbnail file not found in storage' });
    }
  } catch (error) {
    next(error);
  }
}

// Get all assets with filters
async function getAssets(req, res, next) {
  try {
    const {
      type,
      search,
      sortBy = 'uploaded_at',
      order = 'DESC',
      limit = 50,
      offset = 0,
    } = req.query;

    let query = 'SELECT * FROM assets WHERE 1=1';
    const params = [];
    let paramCount = 1;

    // Filter by type
    if (type && type !== 'all') {
      query += ` AND type = $${paramCount}`;
      params.push(type);
      paramCount++;
    }

    // Search by name or tags
    if (search) {
      query += ` AND (name ILIKE $${paramCount} OR tags::text ILIKE $${paramCount})`;
      params.push(`%${search}%`);
      paramCount++;
    }

    // Only show completed assets
    query += ` AND status = 'completed'`;

    // Sorting
    const allowedSortFields = ['uploaded_at', 'name', 'downloads', 'size'];
    const sortField = allowedSortFields.includes(sortBy) ? sortBy : 'uploaded_at';
    const sortOrder = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    query += ` ORDER BY ${sortField} ${sortOrder}`;

    // Pagination
    query += ` LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await db.query(query, params);

    // Get total count
    let countQuery = 'SELECT COUNT(*) FROM assets WHERE 1=1';
    const countParams = [];
    let countParamIndex = 1;

    if (type && type !== 'all') {
      countQuery += ` AND type = $${countParamIndex}`;
      countParams.push(type);
      countParamIndex++;
    }

    if (search) {
      countQuery += ` AND (name ILIKE $${countParamIndex} OR tags::text ILIKE $${countParamIndex})`;
      countParams.push(`%${search}%`);
    }

    countQuery += ` AND status = 'completed'`;

    const countResult = await db.query(countQuery, countParams);
    const total = parseInt(countResult.rows[0].count);

    res.json({
      assets: result.rows.map(formatAsset),
      pagination: {
        total,
        limit: parseInt(limit),
        offset: parseInt(offset),
      },
    });
  } catch (error) {
    next(error);
  }
}

// Get single asset by ID
async function getAssetById(req, res, next) {
  try {
    const { id } = req.params;

    const result = await db.query('SELECT * FROM assets WHERE id = $1', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    res.json(formatAsset(result.rows[0]));
  } catch (error) {
    next(error);
  }
}

// Download asset
async function downloadAsset(req, res, next) {
  try {
    const { id } = req.params;

    const result = await db.query('SELECT * FROM assets WHERE id = $1', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    const asset = result.rows[0];

    // Increment download count
    await db.query('UPDATE assets SET downloads = downloads + 1 WHERE id = $1', [id]);

    // Get file from MinIO
    const fileStream = await downloadFromMinIO(asset.file_path);

    res.setHeader('Content-Type', asset.mime_type);
    res.setHeader('Content-Disposition', `attachment; filename="${asset.name}"`);
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

    fileStream.pipe(res);
  } catch (error) {
    next(error);
  }
}

// Delete asset
async function deleteAsset(req, res, next) {
  try {
    const { id } = req.params;

    const result = await db.query('SELECT * FROM assets WHERE id = $1', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    const asset = result.rows[0];

    // Delete from MinIO
    await deleteFromMinIO(asset.file_path);
    if (asset.thumbnail_path) {
      await deleteFromMinIO(asset.thumbnail_path);
    }

    // Delete from database
    await db.query('DELETE FROM assets WHERE id = $1', [id]);

    res.json({ message: 'Asset deleted successfully' });
  } catch (error) {
    next(error);
  }
}

// Update asset tags
async function updateAssetTags(req, res, next) {
  try {
    const { id } = req.params;
    const { tags } = req.body;

    if (!Array.isArray(tags)) {
      return res.status(400).json({ error: 'Tags must be an array' });
    }

    const result = await db.query('UPDATE assets SET tags = $1 WHERE id = $2 RETURNING *', [
      JSON.stringify(tags),
      id,
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    res.json(formatAsset(result.rows[0]));
  } catch (error) {
    next(error);
  }
}

// Helper: Format asset for API response
function formatAsset(asset) {
  return {
    id: asset.id,
    name: asset.name,
    type: asset.type,
    size: asset.size,
    mimeType: asset.mime_type,
    uploadedAt: asset.uploaded_at,
    thumbnailUrl: `/api/assets/${asset.id}/thumbnail`,
    url: `/api/assets/${asset.id}/download`,
    downloads: asset.downloads,
    tags: typeof asset.tags === 'string' ? JSON.parse(asset.tags) : asset.tags,
    metadata: typeof asset.metadata === 'string' ? JSON.parse(asset.metadata) : asset.metadata,
    status: asset.status,
  };
}

module.exports = {
  uploadAssets,
  getAssets,
  getAssetById,
  downloadAsset,
  deleteAsset,
  updateAssetTags,
  getThumbnail,
};
