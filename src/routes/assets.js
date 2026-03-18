const express = require('express');
const multer = require('multer');
const config = require('../config');
const { authenticate } = require('../middleware/auth');
const { ALLOWED_MIME_TYPES } = require('../services/uploadPipeline');
const {
  uploadAssets,
  getAssets,
  getAssetById,
  downloadAsset,
  deleteAsset,
  updateAssetTags,
  getThumbnail,
} = require('../controllers/assetController');

const router = express.Router();

// Configure multer for file uploads (store in memory for processing)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.upload.maxFileSize,
  },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${file.mimetype} not supported`));
    }
  },
});

// Routes
router.post('/upload', authenticate, upload.array('files', 10), uploadAssets);
router.get('/', authenticate, getAssets);
router.get('/:id', authenticate, getAssetById);
router.get('/:id/thumbnail', authenticate, getThumbnail);
router.get('/:id/download', authenticate, downloadAsset);
router.delete('/:id', authenticate, deleteAsset);
router.patch('/:id/tags', authenticate, updateAssetTags);

module.exports = router;
