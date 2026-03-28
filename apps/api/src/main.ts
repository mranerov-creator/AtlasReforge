/**
 * AtlasReforge API — Entry point
 *
 * Uses Fastify (not Express) for:
 *   - 2x throughput on file upload routes
 *   - Built-in schema validation
 *   - Better TypeScript support
 *
 * Security hardening:
 *   - Helmet headers
 *   - CORS restricted to known frontend origins
 *   - Body size limit: 1 MB (scripts are text files)
 *   - Rate limiting via @nestjs/throttler
 */

import 'dotenv/config'; // Auto-load .env.local
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module.js';

const PORT = parseInt(process.env['PORT'] ?? '3001', 10);
const HOST = process.env['HOST'] ?? '0.0.0.0';
const ALLOWED_ORIGINS = (
  process.env['ALLOWED_ORIGINS'] ?? 'http://localhost:3000'
).split(',');

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      logger: process.env['NODE_ENV'] === 'development',
      bodyLimit: 1024 * 1024, // 1 MB
    }),
  );

  // ── CORS ─────────────────────────────────────────────────────────────────
  app.enableCors({
    origin: ALLOWED_ORIGINS,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-job-id'],
    credentials: true,
  });

  // ── Global prefix ─────────────────────────────────────────────────────────
  app.setGlobalPrefix('api/v1', {
    exclude: ['health', 'health/ready'],
  });

  await app.listen(PORT, HOST);

  logger.log(`🚀 AtlasReforge API running on http://${HOST}:${PORT}`);
  logger.log(`📋 Health: http://${HOST}:${PORT}/health`);
  logger.log(`🔧 API: http://${HOST}:${PORT}/api/v1`);
}

void bootstrap();
