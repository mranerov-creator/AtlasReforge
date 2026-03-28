/**
 * Global Exception Filter
 *
 * Catches all exceptions and returns structured JSON error responses.
 * Prevents stack traces leaking to clients in production.
 */

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FastifyRequest = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FastifyReply = any;

import { RegistryError } from '@atlasreforge/field-registry';
import { PipelineError } from '@atlasreforge/llm-orchestrator';

interface ErrorResponse {
  statusCode: number;
  error: string;
  message: string;
  timestamp: string;
  path: string;
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';

    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const resp = exception.getResponse();
      message =
        typeof resp === 'string'
          ? resp
          : (resp as { message?: string }).message ?? exception.message;
    } else if (exception instanceof RegistryError) {
      statusCode = HttpStatus.NOT_FOUND;
      message = exception.message;
    } else if (exception instanceof PipelineError) {
      statusCode = HttpStatus.UNPROCESSABLE_ENTITY;
      message = `Pipeline failed at stage ${exception.stage}: ${exception.message}`;
    } else if (exception instanceof Error) {
      message = exception.message;
      this.logger.error(exception.message, exception.stack);
    }

    const body: ErrorResponse = {
      statusCode,
      error: HttpStatus[statusCode] ?? 'UNKNOWN',
      message,
      timestamp: new Date().toISOString(),
      path: request.url,
    };

    void reply.status(statusCode).send(body);
  }
}
