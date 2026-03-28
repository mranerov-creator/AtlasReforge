/**
 * Health Controller
 *
 * GET /health      — liveness probe (is the process alive?)
 * GET /health/ready — readiness probe (is the app ready to serve traffic?)
 *
 * Used by:
 *   - Docker Compose healthcheck
 *   - Kubernetes liveness/readiness probes
 *   - Load balancer health checks
 */

import { Controller, Get, Logger } from '@nestjs/common';
import type { HealthResponse } from '../../common/dto.js';

@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);
  private readonly startedAt = Date.now();

  @Get()
  liveness(): { status: 'ok'; uptime: number } {
    return {
      status: 'ok',
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  @Get('ready')
  readiness(): HealthResponse {
    // In production this would check DB + Redis connections
    // For now, return healthy if process is running
    return {
      status: 'ok',
      version: process.env['npm_package_version'] ?? '0.1.0',
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
      services: {
        database: 'up',
        redis: 'up',
        ragIndex: 'up',
      },
    };
  }
}
