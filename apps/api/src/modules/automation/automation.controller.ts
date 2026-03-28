/**
 * Automation Import Controller
 *
 * Proxy endpoint: POST /automation/import
 *
 * WHY A PROXY?
 *   The Atlassian Automation import API requires a server-side call.
 *   Calling it directly from the browser would:
 *     1. Expose the user's API token in browser network logs
 *     2. Be blocked by CORS (Atlassian doesn't allow cross-origin calls)
 *
 * SECURITY:
 *   - API token is used only for this single forwarded request
 *   - Token is NEVER logged, NEVER persisted, NEVER returned in the response
 *   - Basic Auth header is built server-side and not echoed back
 *   - ruleJson is validated as parseable JSON before forwarding
 *   - jiraBaseUrl is validated to be a valid HTTPS Atlassian URL
 *
 * ATLASSIAN AUTOMATION IMPORT API:
 *   POST {jiraBaseUrl}/rest/automation/internal/GLOBAL/rule/import
 *   Content-Type: application/json
 *   Authorization: Basic base64(email:apiToken)
 *
 *   Body: { "rules": [ <rule object> ] }
 *
 *   Note: The endpoint expects an unwrapped rule object (not the export envelope).
 *   We parse the ruleJson and forward it inside the { rules: [...] } wrapper.
 */

import {
  BadRequestException,
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Logger,
  Post,
} from '@nestjs/common';
import type {
  AutomationImportDto,
  AutomationImportResponse,
} from '../../common/dto.js';

// ─── URL validation ───────────────────────────────────────────────────────────

const ATLASSIAN_URL_PATTERN = /^https:\/\/[a-zA-Z0-9-]+\.atlassian\.net$/;

function validateJiraBaseUrl(url: string): string {
  const trimmed = url.replace(/\/$/, ''); // strip trailing slash
  if (!ATLASSIAN_URL_PATTERN.test(trimmed)) {
    throw new BadRequestException(
      'jiraBaseUrl must be a valid Atlassian Cloud URL ' +
      '(e.g. https://yourcompany.atlassian.net)',
    );
  }
  return trimmed;
}

// ─── JSON validation ──────────────────────────────────────────────────────────

function parseAndValidateRuleJson(ruleJson: string): object {
  let parsed: unknown;
  try {
    parsed = JSON.parse(ruleJson);
  } catch {
    throw new BadRequestException('ruleJson is not valid JSON');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BadRequestException('ruleJson must be a JSON object');
  }

  const rule = parsed as Record<string, unknown>;

  // Basic structural validation — must have at minimum a name
  if (typeof rule['name'] !== 'string' || rule['name'].trim().length === 0) {
    throw new BadRequestException(
      'ruleJson must contain a "name" field (Atlassian Automation rule schema)',
    );
  }

  return rule;
}

// ─── Controller ───────────────────────────────────────────────────────────────

@Controller('automation')
export class AutomationController {
  private readonly logger = new Logger(AutomationController.name);

  /**
   * POST /automation/import
   *
   * Proxies the Automation rule JSON to Atlassian Cloud's import endpoint.
   * The user's API token is used for Basic Auth and never stored.
   */
  @Post('import')
  async importRule(
    @Body() dto: AutomationImportDto,
  ): Promise<AutomationImportResponse> {
    // ── Input validation ─────────────────────────────────────────────────

    if (!dto.ruleJson || !dto.jiraBaseUrl || !dto.email || !dto.apiToken) {
      throw new BadRequestException(
        'Required fields: ruleJson, jiraBaseUrl, email, apiToken',
      );
    }

    const baseUrl = validateJiraBaseUrl(dto.jiraBaseUrl);
    const ruleObject = parseAndValidateRuleJson(dto.ruleJson);
    const ruleName = (ruleObject as Record<string, unknown>)['name'] as string;

    // ── Build Basic Auth — NEVER logged ──────────────────────────────────
    const credentials = Buffer.from(`${dto.email}:${dto.apiToken}`).toString('base64');

    const importUrl = `${baseUrl}/rest/automation/internal/GLOBAL/rule/import`;

    this.logger.log(
      `Importing Automation rule "${ruleName}" to ${baseUrl} (token: [REDACTED])`,
    );

    // ── Forward to Atlassian ──────────────────────────────────────────────
    let atlassianResponse: Response;
    try {
      atlassianResponse = await fetch(importUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${credentials}`,
          'Accept': 'application/json',
          // Required by Atlassian to identify the calling app
          'X-Atlassian-Token': 'no-check',
        },
        body: JSON.stringify({ rules: [ruleObject] }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Network error calling Atlassian: ${msg}`);
      throw new HttpException(
        `Could not reach Atlassian Cloud at ${baseUrl}. ` +
        'Check that the URL is correct and the instance is accessible.',
        HttpStatus.BAD_GATEWAY,
      );
    }

    // ── Parse Atlassian response ──────────────────────────────────────────
    const responseText = await atlassianResponse.text();

    if (!atlassianResponse.ok) {
      this.logger.warn(
        `Atlassian returned ${atlassianResponse.status} for rule import: ${responseText.slice(0, 300)}`,
      );

      // Map common Atlassian error codes to user-friendly messages
      const userMessage = (() => {
        switch (atlassianResponse.status) {
          case 401: return 'Authentication failed. Check your email and API token.';
          case 403: return 'Insufficient permissions. You need "Manage automation rules" permission in Jira.';
          case 404: return 'Automation API not found. Confirm the Jira base URL is correct.';
          case 413: return 'Rule JSON too large. Simplify the rule before importing.';
          default:  return `Atlassian returned an error (HTTP ${atlassianResponse.status}). ` +
                           'Check the rule JSON and try again.';
        }
      })();

      throw new HttpException(
        { success: false, message: userMessage, ruleId: null, ruleName: null, ruleUrl: null },
        atlassianResponse.status >= 500 ? HttpStatus.BAD_GATEWAY : HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // ── Parse success response ────────────────────────────────────────────
    let ruleId: string | null = null;
    let ruleUrl: string | null = null;

    try {
      const parsed = JSON.parse(responseText) as Record<string, unknown>;

      // Atlassian returns the created rule(s) in a "rules" array
      const rules = parsed['rules'] as Array<Record<string, unknown>> | undefined;
      const createdRule = rules?.[0];

      if (createdRule !== undefined) {
        ruleId = String(createdRule['id'] ?? '');
        // Build direct link to the rule in Jira Automation settings
        if (ruleId) {
          ruleUrl = `${baseUrl}/jira/settings/automation#/rule/${ruleId}`;
        }
      }
    } catch {
      // Response parsing is best-effort — import may have succeeded
      this.logger.warn('Could not parse Atlassian import response body');
    }

    this.logger.log(
      `Rule "${ruleName}" imported successfully to ${baseUrl}` +
      (ruleId ? ` (id: ${ruleId})` : ''),
    );

    return {
      success: true,
      ruleId,
      ruleName,
      ruleUrl,
      message: ruleId
        ? `Rule "${ruleName}" imported successfully. Click the link to review and enable it.`
        : `Rule "${ruleName}" imported successfully.`,
    };
  }
}
