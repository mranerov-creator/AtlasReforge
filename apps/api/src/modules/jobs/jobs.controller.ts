/**
 * Jobs Module
 *
 * Handles script file ingestion and BullMQ job submission.
 *
 * Flow:
 *   POST /jobs (multipart file upload)
 *     → validate file type + size
 *     → parse script content
 *     → submit to 'migration' BullMQ queue
 *     → return jobId + registry URL + polling URL
 *
 * GET /jobs/:jobId/status
 *     → poll BullMQ for job state
 *     → return JobStatusResponse
 *
 * GET /jobs/:jobId/result
 *     → return completed MigrationResult (or 404 if not done)
 *
 * POST /jobs/:jobId/resolve
 *     → trigger placeholder resolution with completed registry session
 *     → returns patched generated files
 */

import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  UnprocessableEntityException,
  UploadedFile,
  UseInterceptors,
  Logger,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { v4 as uuidv4 } from 'uuid';
import { ParserService } from '@atlasreforge/parser';
import { RegistryService } from '@atlasreforge/field-registry';
import type {
  JobStatusResponse,
  JobSubmittedResponse,
  MigrationResultDto,
  SubmitJobDto,
} from '../../common/dto.js';
import {
  JOB_NAMES,
  QUEUES,
  type MigrationJobData,
} from './job.constants.js';

/** Minimal Multer file type — avoids Express namespace dependency */
interface MulterFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

// ─── Allowed file extensions ──────────────────────────────────────────────────

const ALLOWED_EXTENSIONS = new Set(['.groovy', '.java', '.sil', '.SIL', '.txt']);
const MAX_FILE_SIZE_BYTES = 512 * 1024; // 512 KB

function validateUploadedFile(
  file: MulterFile | undefined,
): { content: string; filename: string } {
  if (file === undefined) {
    throw new UnprocessableEntityException('No file uploaded');
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw new UnprocessableEntityException(
      `File exceeds 512 KB limit (received ${file.size} bytes)`,
    );
  }

  const ext = file.originalname.slice(file.originalname.lastIndexOf('.'));
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new UnprocessableEntityException(
      `File type "${ext}" not supported. Allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}`,
    );
  }

  const content = file.buffer.toString('utf-8');
  if (content.trim().length === 0) {
    throw new UnprocessableEntityException('Uploaded file is empty');
  }

  return { content, filename: file.originalname };
}

// ─── Controller ───────────────────────────────────────────────────────────────

@Controller('jobs')
export class JobsController {
  private readonly logger = new Logger(JobsController.name);

  constructor(
    @InjectQueue(QUEUES.MIGRATION)
    private readonly migrationQueue: Queue<MigrationJobData>,
    private readonly parserService: ParserService,
    private readonly registryService: RegistryService,
  ) {}

  /**
   * POST /jobs
   * Accepts multipart/form-data with:
   *   - file: the script file (.groovy, .java, .sil)
   *   - body: SubmitJobDto fields
   */
  @Post()
  async submitJob(
    @UploadedFile() file: MulterFile | undefined,
    @Body() dto: SubmitJobDto,
  ): Promise<JobSubmittedResponse> {
    const { content, filename } = validateUploadedFile(file);

    const jobId = uuidv4();
    const tenantId = jobId; // For MVP, tenant = job

    // Phase 1: Parse the script synchronously (fast — no LLM)
    // This gives us the dependency map needed to bootstrap the Registry
    const parsedScript = await this.parserService.parse({
      content,
      filename,
      requestId: jobId,
    });

    this.logger.log(
      `Job ${jobId}: parsed ${filename} — ${parsedScript.language} ` +
      `${parsedScript.moduleType} (${parsedScript.cloudReadiness.overallLevel})`,
    );

    // Phase 2: Bootstrap the Field Mapping Registry session
    await this.registryService.buildSession({
      jobId,
      originalFilename: filename,
      customFieldRefs: parsedScript.dependencies.customFields.map((cf) => ({
        fieldId: cf.fieldId,
        usageType: cf.usageType,
      })),
      groupRefs: parsedScript.dependencies.groups.map((g) => ({
        groupName: g.groupName,
      })),
      userRefs: parsedScript.dependencies.users.map((u) => ({
        identifier: u.identifier,
        identifierType: u.identifierType,
        gdprRisk: 'high' as const,
      })),
    });

    // Phase 3: Submit migration job to BullMQ queue
    const jobData: MigrationJobData = {
      jobId,
      filename,
      scriptContent: content,      // Ephemeral — stays in Redis job data only
      preferredTarget: dto.preferredTarget,
      cloudBaseUrl: dto.cloudBaseUrl,
      accessToken: dto.accessToken, // Ephemeral — never written to DB
      tenantId,
      submittedAt: new Date().toISOString(),
    };

    // If registry has unmapped items, hold job until user completes registry
    const hasRequiredMappings =
      parsedScript.dependencies.customFields.length > 0 ||
      parsedScript.dependencies.groups.length > 0 ||
      parsedScript.dependencies.users.length > 0;

    await this.migrationQueue.add(JOB_NAMES.PROCESS_SCRIPT, jobData, {
      jobId,
      // If there are mappings needed, delay actual processing
      // Worker will check registry completion before running S4
      delay: hasRequiredMappings ? 0 : 0,
      attempts: 2,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { age: 3600 }, // Keep completed jobs for 1h
      removeOnFail: { age: 86400 },    // Keep failed jobs for 24h
    });

    const estimatedCostUsd =
      parsedScript.cloudReadiness.estimatedEffortHours.aiAssistedHours > 2
        ? 0.05  // Complex script — more tokens
        : 0.02; // Simple script

    return {
      jobId,
      status: 'queued',
      estimatedCostUsd,
      registrySessionUrl: `/registry/${jobId}`,
      statusUrl: `/jobs/${jobId}/status`,
    };
  }

  /**
   * GET /jobs/:jobId/status
   * Polls BullMQ for current job state.
   */
  @Get(':jobId/status')
  async getJobStatus(
    @Param('jobId') jobId: string,
  ): Promise<JobStatusResponse> {
    const job = await this.migrationQueue.getJob(jobId);

    if (job === undefined) {
      throw new NotFoundException(`Job "${jobId}" not found`);
    }

    const state = await job.getState();
    const progress = typeof job.progress === 'number' ? job.progress : 0;

    // Map BullMQ states to our domain states
    const statusMap: Record<string, JobStatusResponse['status']> = {
      waiting: 'queued',
      delayed: 'queued',
      active: 'generating',
      completed: 'completed',
      failed: 'failed',
      prioritized: 'queued',
    };

    const status = statusMap[state] ?? 'queued';

    let result: MigrationResultDto | null = null;
    if (state === 'completed' && job.returnvalue !== null) {
      result = job.returnvalue as MigrationResultDto;
    }

    return {
      jobId,
      status,
      progress,
      currentStage: (job.data as MigrationJobData & { currentStage?: string }).currentStage ?? 'queued',
      createdAt: new Date(job.timestamp).toISOString(),
      updatedAt: new Date(job.processedOn ?? job.timestamp).toISOString(),
      error: job.failedReason ?? null,
      result,
    };
  }

  /**
   * GET /jobs/:jobId/result
   * Returns the completed migration result or 404.
   */
  @Get(':jobId/result')
  async getJobResult(
    @Param('jobId') jobId: string,
  ): Promise<MigrationResultDto> {
    const job = await this.migrationQueue.getJob(jobId);

    if (job === undefined) {
      throw new NotFoundException(`Job "${jobId}" not found`);
    }

    const state = await job.getState();
    if (state !== 'completed') {
      throw new NotFoundException(
        `Job "${jobId}" is not completed yet (current state: ${state})`,
      );
    }

    if (job.returnvalue === null || job.returnvalue === undefined) {
      throw new NotFoundException(`Job "${jobId}" has no result`);
    }

    return job.returnvalue as MigrationResultDto;
  }
}
