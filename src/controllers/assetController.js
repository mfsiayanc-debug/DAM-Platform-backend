const { downloadFromMinIO, deleteFromMinIO, getPresignedUrl } = require('../services/storage');
const { createAssetFromUpload } = require('../services/uploadPipeline');
const config = require('../config');
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
        ownerId: req.user.id,
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

function buildAssetScope(req, startIndex = 1) {
  if (req.user?.role === 'admin') {
    return {
      clause: '',
      params: [],
      nextIndex: startIndex,
    };
  }

  return {
    clause: ` AND user_id = $${startIndex}`,
    params: [req.user.id],
    nextIndex: startIndex + 1,
  };
}

async function getOwnedAsset(req, assetId) {
  const scope = buildAssetScope(req, 2);
  const result = await db.query(`SELECT * FROM assets WHERE id = $1${scope.clause}`, [
    assetId,
    ...scope.params,
  ]);

  return result.rows[0] || null;
}

// Get thumbnail
async function getThumbnail(req, res, next) {
  try {
    const { id } = req.params;
    const asset = await getOwnedAsset(req, id);

    if (!asset) {
      return res.status(404).json({ error: 'Asset not found' });
    }

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
    const scope = buildAssetScope(req, 1);
    const params = [...scope.params];
    let paramCount = scope.nextIndex;
    query += scope.clause;

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
    const countScope = buildAssetScope(req, 1);
    const countParams = [...countScope.params];
    let countParamIndex = countScope.nextIndex;
    countQuery += countScope.clause;

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
      assets: await Promise.all(result.rows.map((asset) => formatAsset(asset))),
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
    const asset = await getOwnedAsset(req, id);

    if (!asset) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    res.json(await formatAsset(asset));
  } catch (error) {
    next(error);
  }
}

// Download asset
async function downloadAsset(req, res, next) {
  try {
    const { id } = req.params;
    const asset = await getOwnedAsset(req, id);

    if (!asset) {
      return res.status(404).json({ error: 'Asset not found' });
    }

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
    const asset = await getOwnedAsset(req, id);

    if (!asset) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    // Delete from MinIO
    await deleteFromMinIO(asset.file_path);
    if (asset.thumbnail_path) {
      await deleteFromMinIO(asset.thumbnail_path);
    }

    // Delete from database
    const scope = buildAssetScope(req, 2);
    await db.query(`DELETE FROM assets WHERE id = $1${scope.clause}`, [id, ...scope.params]);

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

    const scope = buildAssetScope(req, 3);
    const result = await db.query(
      `UPDATE assets SET tags = $1 WHERE id = $2${scope.clause} RETURNING *`,
      [JSON.stringify(tags), id, ...scope.params],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    res.json(formatAsset(result.rows[0]));
  } catch (error) {
    next(error);
  }
}

// Helper: Format asset for API response
async function formatAsset(asset) {
  let thumbnailUrl = `/api/assets/${asset.id}/thumbnail`;
  let assetUrl = `/api/assets/${asset.id}/download`;

  try {
    if (asset.thumbnail_path && asset.status === 'completed') {
      thumbnailUrl = await getPresignedUrl(
        asset.thumbnail_path,
        config.minio.presignedExpirySeconds,
      );
    }
  } catch (error) {
    console.error(`Failed to create thumbnail presigned URL for asset ${asset.id}:`, error);
  }

  try {
    if (asset.file_path && asset.status === 'completed') {
      assetUrl = await getPresignedUrl(asset.file_path, config.minio.presignedExpirySeconds);
    }
  } catch (error) {
    console.error(`Failed to create file presigned URL for asset ${asset.id}:`, error);
  }

  return {
    id: asset.id,
    name: asset.name,
    type: asset.type,
    size: asset.size,
    mimeType: asset.mime_type,
    uploadedAt: asset.uploaded_at,
    thumbnailUrl,
    url: assetUrl,
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
