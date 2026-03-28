/**
 * Registry Controller
 *
 * REST endpoints for the Field Mapping Registry UI.
 * The React frontend calls these to show the user what needs mapping
 * and to save their mappings before triggering code generation.
 *
 * All endpoints are scoped to a jobId — no cross-job access.
 *
 * GET  /registry/:jobId              — get full session state
 * PUT  /registry/:jobId/fields       — map a custom field
 * PUT  /registry/:jobId/groups       — map a group
 * PUT  /registry/:jobId/users        — map a user → accountId
 * POST /registry/:jobId/skip         — skip a mapping
 * POST /registry/:jobId/validate     — validate all mapped values against Jira Cloud
 * GET  /registry/:jobId/export       — export session as JSON
 * POST /registry/:jobId/import       — import a previously exported session
 * POST /registry/:jobId/resolve/:fileType — resolve placeholders in generated code
 */

import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { RegistryService } from '@atlasreforge/field-registry';
import type { RegistrySession } from '@atlasreforge/field-registry';
import type {
  SkipMappingDto,
  UpdateFieldMappingDto,
  UpdateGroupMappingDto,
  UpdateUserMappingDto,
} from '../../common/dto.js';

@Controller('registry')
export class RegistryController {
  private readonly logger = new Logger(RegistryController.name);

  constructor(private readonly registryService: RegistryService) {}

  // ─── GET session ─────────────────────────────────────────────────────────

  @Get(':jobId')
  async getSession(
    @Param('jobId') jobId: string,
  ): Promise<RegistrySession> {
    const session = await this.registryService.getSession(jobId);
    if (session === null) {
      throw new NotFoundException(
        `Registry session for job "${jobId}" not found or expired`,
      );
    }
    return session;
  }

  // ─── Field mapping ────────────────────────────────────────────────────────

  @Put(':jobId/fields')
  async updateField(
    @Param('jobId') jobId: string,
    @Body() dto: UpdateFieldMappingDto,
  ): Promise<RegistrySession> {
    return this.registryService.updateField(jobId, {
      serverFieldId: dto.serverFieldId,
      cloudFieldId: dto.cloudFieldId,
      cloudFieldName: dto.cloudFieldName,
      notes: dto.notes,
    });
  }

  // ─── Group mapping ────────────────────────────────────────────────────────

  @Put(':jobId/groups')
  async updateGroup(
    @Param('jobId') jobId: string,
    @Body() dto: UpdateGroupMappingDto,
  ): Promise<RegistrySession> {
    return this.registryService.updateGroup(jobId, {
      serverGroupName: dto.serverGroupName,
      cloudGroupId: dto.cloudGroupId,
      cloudGroupName: dto.cloudGroupName,
      notes: dto.notes,
    });
  }

  // ─── User mapping (GDPR) ──────────────────────────────────────────────────

  @Put(':jobId/users')
  async updateUser(
    @Param('jobId') jobId: string,
    @Body() dto: UpdateUserMappingDto,
  ): Promise<RegistrySession> {
    return this.registryService.updateUser(jobId, {
      serverIdentifier: dto.serverIdentifier,
      cloudAccountId: dto.cloudAccountId,
      cloudDisplayName: dto.cloudDisplayName,
      cloudEmail: dto.cloudEmail,
      resolutionStrategy: dto.resolutionStrategy,
      notes: dto.notes,
    });
  }

  // ─── Skip mapping ─────────────────────────────────────────────────────────

  @Post(':jobId/skip')
  async skipMapping(
    @Param('jobId') jobId: string,
    @Body() dto: SkipMappingDto,
  ): Promise<RegistrySession> {
    return this.registryService.skipMapping(jobId, {
      type: dto.type,
      identifier: dto.identifier,
      notes: dto.notes,
    });
  }

  // ─── Validate against Jira Cloud ─────────────────────────────────────────

  @Post(':jobId/validate')
  async validateAll(
    @Param('jobId') jobId: string,
    @Body() body: { cloudBaseUrl: string; accessToken: string },
  ): Promise<RegistrySession> {
    if (typeof body.cloudBaseUrl !== 'string' || body.cloudBaseUrl.trim() === '') {
      throw new BadRequestException('cloudBaseUrl is required for validation');
    }
    if (typeof body.accessToken !== 'string' || body.accessToken.trim() === '') {
      throw new BadRequestException('accessToken is required for validation');
    }

    this.logger.log(`Validating registry session ${jobId} against ${body.cloudBaseUrl}`);

    return this.registryService.validateAll(jobId, {
      cloudBaseUrl: body.cloudBaseUrl.replace(/\/$/, ''),
      accessToken: body.accessToken,
      requestDelayMs: 150,
    });
  }

  // ─── Export ───────────────────────────────────────────────────────────────

  @Get(':jobId/export')
  async exportSession(
    @Param('jobId') jobId: string,
  ): Promise<{ json: string; filename: string }> {
    const json = await this.registryService.exportSession(jobId);
    return {
      json,
      filename: `atlasreforge-registry-${jobId}.json`,
    };
  }

  // ─── Import ───────────────────────────────────────────────────────────────

  @Post(':jobId/import')
  async importSession(
    @Body() body: { json: string },
  ): Promise<RegistrySession> {
    if (typeof body.json !== 'string') {
      throw new BadRequestException('json field is required');
    }
    return this.registryService.importSession(body.json);
  }

  // ─── Resolve placeholders ─────────────────────────────────────────────────

  @Post(':jobId/resolve')
  async resolveCode(
    @Param('jobId') jobId: string,
    @Body() body: { code: string },
  ): Promise<{
    resolvedCode: string;
    totalPlaceholders: number;
    resolved: number;
    unresolved: number;
    unresolvedPlaceholders: ReadonlyArray<string>;
  }> {
    if (typeof body.code !== 'string') {
      throw new BadRequestException('code field is required');
    }
    return this.registryService.resolveCode(jobId, body.code);
  }
}
