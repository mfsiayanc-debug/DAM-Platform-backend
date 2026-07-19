import fs from 'node:fs';
import path from 'node:path';
import { IncomingMessage, ServerResponse } from 'http';
import { FileStore } from '@tus/file-store';
import { Server } from '@tus/server';
import { EXPOSED_HEADERS } from '@tus/utils';
import { v4 as uuidv4 } from 'uuid';
import config from '../config';
import { getUserFromRequest } from '../middleware/auth';
import { createAssetFromUpload, isMimeTypeAllowed } from './uploadPipeline';

type TusUpload = {
  id: string;
  size?: number;
  metadata?: {
    filename?: string;
    filetype?: string;
  };
  storage?: {
    path?: string;
  };
};

type TusRequest = IncomingMessage & {
  user?: {
    id: string;
    email?: string;
    role?: string;
  };
  query?: Record<string, unknown>;
};

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
  async onIncomingRequest(req: TusRequest) {
    if (req.method === 'OPTIONS') {
      return;
    }

    req.user = getUserFromRequest(req as never);
  },
  async onUploadCreate(_req: TusRequest, res: ServerResponse, upload: TusUpload) {
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
  async onUploadFinish(req: TusRequest, res: ServerResponse, upload: TusUpload) {
    const originalName = upload.metadata?.filename || upload.id;
    const mimeType = upload.metadata?.filetype || 'application/octet-stream';
    const filePath = upload.storage?.path || path.join(uploadDirectory, upload.id);

    const asset = await createAssetFromUpload({
      assetId: upload.id,
      originalName,
      mimeType,
      size: upload.size,
      sourcePath: filePath,
      ownerId: req.user!.id,
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
const handleTusRequest = async (req: IncomingMessage, res: ServerResponse) => {
  const originalSetHeader = res.setHeader.bind(res);

  res.setHeader = (name: string, value: number | string | readonly string[]) => {
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

(tusServer as unknown as { handle: typeof handleTusRequest }).handle = handleTusRequest;

export { resumableUploadPath, tusServer };
