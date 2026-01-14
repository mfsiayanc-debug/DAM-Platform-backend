const express = require('express');
const multer = require('multer');
const config = require('../config');
const {
  uploadAssets,
  getAssets,
  getAssetById,
  downloadAsset,
  deleteAsset,
  updateAssetTags,
  getThumbnail
} = require('../controllers/assetController');

const router = express.Router();

// Configure multer for file uploads (store in memory for processing)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.upload.maxFileSize,
  },
  fileFilter: (req, file, cb) => {
    // Accept images, videos, and documents
    const allowedMimes = [
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'video/mp4',
      'video/mpeg',
      'video/quicktime',
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];
    
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${file.mimetype} not supported`));
    }
  },
});

// Routes
router.post('/upload', upload.array('files', 10), uploadAssets);
router.get('/', getAssets);
router.get('/:id', getAssetById);
router.get('/:id/thumbnail', getThumbnail);
router.get('/:id/download', downloadAsset);
router.delete('/:id', deleteAsset);
router.patch('/:id/tags', updateAssetTags);

module.exports = router;
