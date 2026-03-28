/**
 * Crawl targets — the authoritative list of Atlassian documentation URLs
 * that the RAG engine indexes weekly.
 *
 * MAINTENANCE STRATEGY:
 * - This file is the single place to add/remove doc sources
 * - When Atlassian deprecates a URL, remove it here and add the redirect
 * - Priority 'high' = re-crawled every run; 'low' = crawled monthly
 *
 * SELECTION CRITERIA:
 * - Only pages directly relevant to Forge, REST API v3, SR Cloud, or migration
 * - Prefer reference docs over guides (denser information per token)
 * - Avoid changelog pages (noise) — we have the change-detector for that
 */

import type { CrawlTarget } from '../types/rag.types.js';

export const CRAWL_TARGETS: ReadonlyArray<CrawlTarget> = [
  // ── Forge Core ───────────────────────────────────────────────────────────
  {
    url: 'https://developer.atlassian.com/platform/forge/',
    category: 'forge-api',
    priority: 'high',
    expectedUpdateFrequency: 'weekly',
  },
  {
    url: 'https://developer.atlassian.com/platform/forge/manifest-reference/',
    category: 'forge-manifest',
    priority: 'high',
    expectedUpdateFrequency: 'weekly',
  },
  {
    url: 'https://developer.atlassian.com/platform/forge/apis-reference/forge-api/',
    category: 'forge-api',
    priority: 'high',
    expectedUpdateFrequency: 'weekly',
  },
  {
    url: 'https://developer.atlassian.com/platform/forge/apis-reference/forge-api/fetch/',
    category: 'forge-api',
    priority: 'high',
    expectedUpdateFrequency: 'weekly',
  },
  {
    url: 'https://developer.atlassian.com/platform/forge/apis-reference/forge-api/storage/',
    category: 'forge-api',
    priority: 'high',
    expectedUpdateFrequency: 'monthly',
  },
  {
    url: 'https://developer.atlassian.com/platform/forge/runtime-reference/',
    category: 'forge-api',
    priority: 'high',
    expectedUpdateFrequency: 'weekly',
  },

  // ── Forge Modules — Jira ─────────────────────────────────────────────────
  {
    url: 'https://developer.atlassian.com/platform/forge/manifest-reference/modules/jira-workflow-post-function/',
    category: 'forge-api',
    priority: 'high',
    expectedUpdateFrequency: 'monthly',
  },
  {
    url: 'https://developer.atlassian.com/platform/forge/manifest-reference/modules/jira-workflow-validator/',
    category: 'forge-api',
    priority: 'high',
    expectedUpdateFrequency: 'monthly',
  },
  {
    url: 'https://developer.atlassian.com/platform/forge/manifest-reference/modules/jira-workflow-condition/',
    category: 'forge-api',
    priority: 'high',
    expectedUpdateFrequency: 'monthly',
  },
  {
    url: 'https://developer.atlassian.com/platform/forge/manifest-reference/modules/jira-issue-panel/',
    category: 'forge-api',
    priority: 'medium',
    expectedUpdateFrequency: 'monthly',
  },
  {
    url: 'https://developer.atlassian.com/platform/forge/manifest-reference/modules/scheduled-trigger/',
    category: 'forge-api',
    priority: 'high',
    expectedUpdateFrequency: 'monthly',
  },
  {
    url: 'https://developer.atlassian.com/platform/forge/manifest-reference/modules/web-trigger/',
    category: 'forge-api',
    priority: 'high',
    expectedUpdateFrequency: 'monthly',
  },

  // ── Forge Remote ─────────────────────────────────────────────────────────
  {
    url: 'https://developer.atlassian.com/platform/forge/remote/',
    category: 'forge-api',
    priority: 'high',
    expectedUpdateFrequency: 'weekly',
  },

  // ── OAuth Scopes ─────────────────────────────────────────────────────────
  {
    url: 'https://developer.atlassian.com/cloud/jira/platform/scopes-for-oauth-2-3LO-and-forge-apps/',
    category: 'oauth-scopes',
    priority: 'high',
    expectedUpdateFrequency: 'monthly',
  },

  // ── Jira REST API v3 ─────────────────────────────────────────────────────
  {
    url: 'https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/',
    category: 'rest-api-v3',
    priority: 'high',
    expectedUpdateFrequency: 'monthly',
  },
  {
    url: 'https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/',
    category: 'rest-api-v3',
    priority: 'high',
    expectedUpdateFrequency: 'monthly',
  },
  {
    url: 'https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-fields/',
    category: 'rest-api-v3',
    priority: 'high',
    expectedUpdateFrequency: 'monthly',
  },
  {
    url: 'https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-users/',
    category: 'rest-api-v3',
    priority: 'high',
    expectedUpdateFrequency: 'monthly',
  },
  {
    url: 'https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-groups/',
    category: 'rest-api-v3',
    priority: 'high',
    expectedUpdateFrequency: 'monthly',
  },
  {
    url: 'https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-workflows/',
    category: 'rest-api-v3',
    priority: 'high',
    expectedUpdateFrequency: 'monthly',
  },
  {
    url: 'https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/',
    category: 'rest-api-v3',
    priority: 'high',
    expectedUpdateFrequency: 'monthly',
  },

  // ── Migration Guides ─────────────────────────────────────────────────────
  {
    url: 'https://developer.atlassian.com/platform/forge/migration/',
    category: 'migration-guide',
    priority: 'high',
    expectedUpdateFrequency: 'weekly',
  },
  {
    url: 'https://developer.atlassian.com/platform/forge/migration/connect-to-forge/',
    category: 'migration-guide',
    priority: 'high',
    expectedUpdateFrequency: 'monthly',
  },

  // ── ScriptRunner Cloud ────────────────────────────────────────────────────
  {
    url: 'https://scriptrunner.adaptavist.com/cloud/jira/introduction.html',
    category: 'scriptrunner-cloud',
    priority: 'high',
    expectedUpdateFrequency: 'monthly',
  },
  {
    url: 'https://scriptrunner.adaptavist.com/cloud/jira/behaviours.html',
    category: 'scriptrunner-cloud',
    priority: 'medium',
    expectedUpdateFrequency: 'rarely',
  },
  {
    url: 'https://scriptrunner.adaptavist.com/cloud/jira/listeners.html',
    category: 'scriptrunner-cloud',
    priority: 'high',
    expectedUpdateFrequency: 'monthly',
  },
  {
    url: 'https://scriptrunner.adaptavist.com/cloud/jira/workflow-functions.html',
    category: 'scriptrunner-cloud',
    priority: 'high',
    expectedUpdateFrequency: 'monthly',
  },
];
