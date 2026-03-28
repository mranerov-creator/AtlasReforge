/**
 * Tenant Guard
 *
 * Enforces job-level isolation: a request can only access resources
 * belonging to the jobId it presents.
 *
 * In the SaaS model, "tenant" = one migration job session.
 * There are no shared resources between jobs — each job has its own:
 *   - RegistrySession (scoped by jobId)
 *   - BullMQ job (scoped by jobId)
 *   - Generated files (in-memory, ephemeral)
 *
 * This guard extracts the jobId from:
 *   1. Route params (:jobId)
 *   2. Request body (.jobId)
 *   3. Custom header (x-job-id) — for WebSocket compatibility
 *
 * For the MVP, authentication is skipped (single-tenant dev mode).
 * The guard is wired but only enforces jobId format validation.
 * Production: replace with JWT verification + tenant DB lookup.
 */

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  BadRequestException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FastifyRequest = any;

export const PUBLIC_KEY = 'isPublic';

/** Mark a route as public (no tenant guard check) */
export const Public = () =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return
  Reflect.metadata(Public.toString(), true);

const JOB_ID_PATTERN = /^[0-9a-f-]{36}$/i; // UUID format

@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Skip guard for @Public() routes (health, docs)
    const isPublic = this.reflector.getAllAndOverride<boolean>(
      Public.toString(),
      [context.getHandler(), context.getClass()],
    );
    if (isPublic === true) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();

    // Extract jobId from multiple sources
    const params = request.params as Record<string, string>;
    const body = request.body as Record<string, unknown> | undefined;
    const headers = request.headers;

    const jobId =
      params['jobId'] ??
      (typeof body?.['jobId'] === 'string' ? body['jobId'] : undefined) ??
      (typeof headers['x-job-id'] === 'string' ? headers['x-job-id'] : undefined);

    if (jobId === undefined) {
      // Routes without jobId are allowed through (they're not job-scoped)
      return true;
    }

    if (!JOB_ID_PATTERN.test(jobId)) {
      throw new BadRequestException(
        `Invalid jobId format. Expected UUID, got: "${jobId}"`,
      );
    }

    // Attach validated jobId to request for downstream use
    (request as FastifyRequest & { jobId: string }).jobId = jobId;
    return true;
  }
}
