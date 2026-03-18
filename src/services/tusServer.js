const fs = require('node:fs');
const path = require('node:path');
const { v4: uuidv4 } = require('uuid');
const { Server } = require('@tus/server');
const { FileStore } = require('@tus/file-store');
const { EXPOSED_HEADERS } = require('@tus/utils');
const config = require('../config');
const { getUserFromRequest } = require('../middleware/auth');
const { createAssetFromUpload, isMimeTypeAllowed } = require('./uploadPipeline');

const resumableUploadPath = '/api/uploads/resumable';
const uploadDirectory = path.join(process.cwd(), 'uploads', 'tus');

fs.mkdirSync(uploadDirectory, { recursive: true });

const datastore = new FileStore({
  directory: uploadDirectory,
});

const tusServer = new Server({
  path: resumableUploadPath,
  datastore,
  maxSize: config.upload.maxFileSize,
  allowedOrigins: [config.server.frontendUrl],
  allowedCredentials: true,
  allowedHeaders: [
    'Authorization',
    'Upload-Length',
    'Upload-Offset',
    'Upload-Metadata',
    'Tus-Resumable',
    'X-HTTP-Method-Override',
  ],
  namingFunction: () => uuidv4(),
  async onIncomingRequest(req) {
    if (req.method === 'OPTIONS') {
      return;
    }

    req.user = getUserFromRequest(req);
  },
  async onUploadCreate(req, res, upload) {
    const fileName = upload.metadata?.filename;
    const mimeType = upload.metadata?.filetype;

    if (!fileName) {
      throw { status_code: 400, body: 'filename metadata is required' };
    }

    if (!mimeType || !isMimeTypeAllowed(mimeType)) {
      throw { status_code: 400, body: `File type ${mimeType || 'unknown'} not supported` };
    }

    return {
      res,
      metadata: {
        filename: fileName,
        filetype: mimeType,
      },
    };
  },
  async onUploadFinish(req, res, upload) {
    const originalName = upload.metadata?.filename || upload.id;
    const mimeType = upload.metadata?.filetype || 'application/octet-stream';
    const filePath = upload.storage?.path || path.join(uploadDirectory, upload.id);

    const asset = await createAssetFromUpload({
      assetId: upload.id,
      originalName,
      mimeType,
      size: upload.size,
      sourcePath: filePath,
      ownerId: req.user.id,
    });

    await datastore.remove(upload.id);

    return {
      res,
      headers: {
        'Upload-Completed-Asset-Id': asset.id,
      },
    };
  },
});

const originalTusHandle = tusServer.handle.bind(tusServer);
tusServer.handle = async (req, res) => {
  const originalSetHeader = res.setHeader.bind(res);

  res.setHeader = (name, value) => {
    if (typeof name === 'string' && name.toLowerCase() === 'access-control-expose-headers') {
      const existingValues = String(value)
        .split(',')
        .map((header) => header.trim())
        .filter(Boolean);

      if (!existingValues.includes('Upload-Completed-Asset-Id')) {
        existingValues.push('Upload-Completed-Asset-Id');
      }

      return originalSetHeader(name, existingValues.join(', '));
    }

    return originalSetHeader(name, value);
  };

  res.setHeader(
    'Access-Control-Expose-Headers',
    `${EXPOSED_HEADERS}, Upload-Completed-Asset-Id`,
  );

  return originalTusHandle(req, res);
};

module.exports = {
  resumableUploadPath,
  tusServer,
};
