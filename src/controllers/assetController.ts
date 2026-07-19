import { NextFunction, Request, Response } from 'express';
import config from '../config';
import db from '../db';
import { deleteFromMinIO, downloadFromMinIO, getPresignedUrl } from '../services/storage';
import { createAssetFromUpload } from '../services/uploadPipeline';

type AssetRecord = {
  id: string;
  user_id?: string;
  name: string;
  type: string;
  size: number;
  mime_type: string;
  file_path: string;
  thumbnail_path?: string | null;
  tags: string | string[];
  metadata?: string | Record<string, unknown> | null;
  downloads: number;
  status: string;
  uploaded_at: string;
};

async function uploadAssets(req: Request, res: Response, next: NextFunction) {
  try {
    const files = (req.files as Express.Multer.File[] | undefined) || [];
    if (files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const uploadedAssets = [];

    for (const file of files) {
      const asset = await createAssetFromUpload({
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        buffer: file.buffer,
        ownerId: req.user!.id,
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

function buildAssetScope(req: Request, startIndex = 1) {
  if (req.user?.role === 'admin') {
    return {
      clause: '',
      params: [] as string[],
      nextIndex: startIndex,
    };
  }

  return {
    clause: ` AND user_id = $${startIndex}`,
    params: [req.user!.id],
    nextIndex: startIndex + 1,
  };
}

async function getOwnedAsset(req: Request, assetId: string): Promise<AssetRecord | null> {
  const scope = buildAssetScope(req, 2);
  const result = await db.query(`SELECT * FROM assets WHERE id = $1${scope.clause}`, [
    assetId,
    ...scope.params,
  ]);

  return (result.rows[0] as AssetRecord | undefined) || null;
}

async function getThumbnail(req: Request, res: Response, next: NextFunction) {
  try {
    const id = String(req.params.id);
    const asset = await getOwnedAsset(req, id);

    if (!asset) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    if (!asset.thumbnail_path) {
      return res.status(404).json({ error: 'Thumbnail not available' });
    }

    if (asset.status === 'processing') {
      return res
        .status(202)
        .json({ message: 'Thumbnail is being generated', status: 'processing' });
    }

    if (asset.status === 'failed') {
      return res.status(500).json({ error: 'Thumbnail generation failed' });
    }

    try {
      const fileStream = await downloadFromMinIO(asset.thumbnail_path);

      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

      fileStream.pipe(res);
    } catch (storageError) {
      console.error(`Failed to retrieve thumbnail for asset ${id}:`, storageError);
      return res.status(404).json({ error: 'Thumbnail file not found in storage' });
    }
  } catch (error) {
    next(error);
  }
}

async function getAssets(req: Request, res: Response, next: NextFunction) {
  try {
    const {
      type,
      search,
      sortBy = 'uploaded_at',
      order = 'DESC',
      limit = '50',
      offset = '0',
    } = req.query as Record<string, string | undefined>;

    let query = 'SELECT * FROM assets WHERE 1=1';
    const scope = buildAssetScope(req, 1);
    const params: Array<string | number> = [...scope.params];
    let paramCount = scope.nextIndex;
    query += scope.clause;

    if (type && type !== 'all') {
      query += ` AND type = $${paramCount}`;
      params.push(type);
      paramCount++;
    }

    if (search) {
      query += ` AND (name ILIKE $${paramCount} OR tags::text ILIKE $${paramCount})`;
      params.push(`%${search}%`);
      paramCount++;
    }

    query += ` AND status = 'completed'`;

    const allowedSortFields = ['uploaded_at', 'name', 'downloads', 'size'];
    const sortField = allowedSortFields.includes(sortBy) ? sortBy : 'uploaded_at';
    const sortOrder = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    query += ` ORDER BY ${sortField} ${sortOrder}`;

    query += ` LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    params.push(Number.parseInt(limit, 10), Number.parseInt(offset, 10));

    const result = await db.query(query, params);

    let countQuery = 'SELECT COUNT(*) FROM assets WHERE 1=1';
    const countScope = buildAssetScope(req, 1);
    const countParams: Array<string | number> = [...countScope.params];
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
    const countRow = countResult.rows[0] as { count: string };
    const total = Number.parseInt(countRow.count, 10);

    res.json({
      assets: await Promise.all(
        result.rows.map((asset: unknown) => formatAsset(asset as AssetRecord)),
      ),
      pagination: {
        total,
        limit: Number.parseInt(limit, 10),
        offset: Number.parseInt(offset, 10),
      },
    });
  } catch (error) {
    next(error);
  }
}

async function getAssetById(req: Request, res: Response, next: NextFunction) {
  try {
    const id = String(req.params.id);
    const asset = await getOwnedAsset(req, id);

    if (!asset) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    res.json(await formatAsset(asset));
  } catch (error) {
    next(error);
  }
}

async function downloadAsset(req: Request, res: Response, next: NextFunction) {
  try {
    const id = String(req.params.id);
    const asset = await getOwnedAsset(req, id);

    if (!asset) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    await db.query('UPDATE assets SET downloads = downloads + 1 WHERE id = $1', [id]);

    const fileStream = await downloadFromMinIO(asset.file_path);

    res.setHeader('Content-Type', asset.mime_type);
    res.setHeader('Content-Disposition', `attachment; filename="${asset.name}"`);
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

    fileStream.pipe(res);
  } catch (error) {
    next(error);
  }
}

async function deleteAsset(req: Request, res: Response, next: NextFunction) {
  try {
    const id = String(req.params.id);
    const asset = await getOwnedAsset(req, id);

    if (!asset) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    await deleteFromMinIO(asset.file_path);
    if (asset.thumbnail_path) {
      await deleteFromMinIO(asset.thumbnail_path);
    }

    const scope = buildAssetScope(req, 2);
    await db.query(`DELETE FROM assets WHERE id = $1${scope.clause}`, [id, ...scope.params]);

    res.json({ message: 'Asset deleted successfully' });
  } catch (error) {
    next(error);
  }
}

async function updateAssetTags(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;
    const { tags } = req.body as { tags?: unknown };

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

    res.json(await formatAsset(result.rows[0] as AssetRecord));
  } catch (error) {
    next(error);
  }
}

async function formatAsset(asset: AssetRecord) {
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
    metadata:
      typeof asset.metadata === 'string' ? JSON.parse(asset.metadata) : (asset.metadata ?? {}),
    status: asset.status,
  };
}

export {
  uploadAssets,
  getAssets,
  getAssetById,
  downloadAsset,
  deleteAsset,
  updateAssetTags,
  getThumbnail,
};
