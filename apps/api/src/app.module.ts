/**
 * App Module — NestJS root module
 *
 * Wires together:
 *   - BullMQ queues (migration + rag-crawl)
 *   - Parser, Registry, Orchestrator, RAG Engine services
 *   - HTTP controllers
 *   - Global guards, filters, interceptors
 */

import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core';
import { ParserService } from '@atlasreforge/parser';
import {
  InMemoryRegistryStore,
  RegistryService,
} from '@atlasreforge/field-registry';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter.js';
import { TenantGuard } from './common/guards/tenant.guard.js';
import { JobsController } from './modules/jobs/jobs.controller.js';
import { HealthController } from './modules/health/health.controller.js';
import { RegistryController } from './modules/registry/registry.controller.js';
import { AutomationController } from './modules/automation/automation.controller.js';
import { QUEUES } from './modules/jobs/job.constants.js';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

@Module({
  imports: [
    // ── BullMQ ──────────────────────────────────────────────────────────
    BullModule.forRoot({
      connection: {
        host: new URL(REDIS_URL).hostname,
        port: parseInt(new URL(REDIS_URL).port || '6379', 10),
      },
    }),
    BullModule.registerQueue(
      { name: QUEUES.MIGRATION },
      { name: QUEUES.RAG_CRAWL },
    ),
  ],
  controllers: [
    HealthController,
    JobsController,
    RegistryController,
    AutomationController,
  ],
  providers: [
    // ── Core services ────────────────────────────────────────────────────
    {
      provide: ParserService,
      useFactory: () => new ParserService({ enableAst: false }),
    },
    {
      provide: InMemoryRegistryStore,
      useFactory: () => new InMemoryRegistryStore(),
    },
    {
      provide: RegistryService,
      useFactory: (store: InMemoryRegistryStore) => new RegistryService(store),
      inject: [InMemoryRegistryStore],
    },

    // ── Global filter ────────────────────────────────────────────────────
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },

    // ── Global guard ─────────────────────────────────────────────────────
    Reflector,
    {
      provide: APP_GUARD,
      useClass: TenantGuard,
    },
  ],
})
export class AppModule {}
