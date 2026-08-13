import express, { Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import * as path from 'path';
import * as fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

import authRoutes from './routes/auth';
import uploadRoutes from './routes/upload';
import dataRoutes from './routes/data';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';

const allowedOrigins: (string | RegExp)[] = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

if (process.env.FRONTEND_URL) {
  allowedOrigins.push(process.env.FRONTEND_URL);
}

export function createApp(): Express {
  const app = express();

  // Behind Nginx reverse proxy — trust the first proxy so express-rate-limit
  // can read the real client IP from X-Forwarded-For.
  app.set('trust proxy', 1);

  // Security headers — must be first
  app.use(helmet());

  // Ensure required directories exist (skipped on serverless read-only FS)
  try {
    const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
    const DATA_DIR = path.join(process.cwd(), 'data');
    if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {
    // On Vercel the filesystem is read-only outside /tmp — silently skip
  }

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        const allowed = allowedOrigins.some((rule) =>
          typeof rule === 'string' ? rule === origin : rule.test(origin)
        );
        if (allowed) return callback(null, true);
        return callback(new Error(`CORS: Origin ${origin} not allowed`));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    })
  );

  app.use(express.json({ limit: '50kb' }));
  app.use(express.urlencoded({ extended: true, limit: '50kb' }));

  // Health check — no internal details
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Routes
  app.use('/api/auth', authRoutes);
  app.use('/api/upload', uploadRoutes);
  app.use('/api/data', dataRoutes);

  // Error handling — must be last
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

const app = createApp();
export default app;
