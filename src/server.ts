import cors from 'cors';
import express, { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import config from './config';
import routes from './routes';
import { initializeMinIO } from './services/storage';
import { resumableUploadPath, tusServer } from './services/tusServer';

const app = express();
const resumableUploadApp = express();
resumableUploadApp.all('*', tusServer.handle.bind(tusServer));

app.use(helmet());
app.use(
  cors({
    origin: config.server.frontendUrl,
    credentials: true,
  }),
);
app.use(morgan('combined'));
app.use(resumableUploadPath, resumableUploadApp);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.use('/api', routes);

app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Error:', err);
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.status(err.status || 500).json({
    error: {
      message: err.message || 'Internal Server Error',
      ...(config.server.env === 'development' ? { stack: err.stack } : {}),
    },
  });
});

async function startServer(): Promise<void> {
  try {
    await initializeMinIO();
    console.log('MinIO storage initialized');

    app.listen(config.server.port, () => {
      console.log(`Server running on port ${config.server.port}`);
      console.log(`Environment: ${config.server.env}`);
      console.log(`API URL: ${config.server.apiUrl}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

void startServer();

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  process.exit(0);
});
