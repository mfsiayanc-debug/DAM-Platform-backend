import express from 'express';
import multer, { FileFilterCallback } from 'multer';
import {
  deleteAsset,
  downloadAsset,
  getAssetById,
  getAssets,
  getThumbnail,
  updateAssetTags,
  uploadAssets,
} from '../controllers/assetController';
import config from '../config';
import { authenticate } from '../middleware/auth';
import { ALLOWED_MIME_TYPES } from '../services/uploadPipeline';

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.upload.maxFileSize,
  },
  fileFilter: (_req, file, cb: FileFilterCallback) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${file.mimetype} not supported`));
    }
  },
});

router.post('/upload', authenticate, upload.array('files', 10), uploadAssets);
router.get('/', authenticate, getAssets);
router.get('/:id', authenticate, getAssetById);
router.get('/:id/thumbnail', authenticate, getThumbnail);
router.get('/:id/download', authenticate, downloadAsset);
router.delete('/:id', authenticate, deleteAsset);
router.patch('/:id/tags', authenticate, updateAssetTags);

export default router;
