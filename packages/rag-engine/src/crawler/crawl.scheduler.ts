import type { Queue } from 'bullmq';
import { QUEUES, JOB_NAMES } from '@atlasreforge/shared';
import type { RagCrawlJobData } from '@atlasreforge/shared';

const DEFAULT_CRAWL_CRON = '0 2 * * 1';

export interface SchedulerConfig {
  readonly crawlCron?: string;
  readonly enabled?: boolean;
}

export async function registerCrawlSchedule(
  ragCrawlQueue: Queue<RagCrawlJobData>,
  config: SchedulerConfig = {},
): Promise<void> {
  if (config.enabled === false) {
    console.log('[Scheduler] Crawl schedule DISABLED');
    return;
  }

  const cron = config.crawlCron
    ?? process.env['ATLASSIAN_DOCS_CRAWL_SCHEDULE']
    ?? DEFAULT_CRAWL_CRON;

  await ragCrawlQueue.removeRepeatable(JOB_NAMES.CRAWL_DOCS, {
    pattern: cron,
    key: 'atlassian-docs-weekly',
  }).catch(() => undefined);

  await ragCrawlQueue.add(
    JOB_NAMES.CRAWL_DOCS,
    { triggeredBy: 'scheduler', triggeredAt: new Date().toISOString() },
    {
      repeat: { pattern: cron, key: 'atlassian-docs-weekly' },
      removeOnComplete: { count: 5 },
      removeOnFail: { count: 5 },
      attempts: 2,
      backoff: { type: 'exponential', delay: 60_000 },
    },
  );

  console.log(`[Scheduler] Weekly crawl scheduled: "${cron}"`);
  console.log(`[Scheduler] Next run: ${getNextRun(cron).toISOString()}`);
}

export async function triggerManualCrawl(
  ragCrawlQueue: Queue<RagCrawlJobData>,
  reason = 'manual',
): Promise<string> {
  const job = await ragCrawlQueue.add(
    JOB_NAMES.CRAWL_DOCS,
    { triggeredBy: 'manual', triggeredAt: new Date().toISOString() },
    {
      priority: 10,
      attempts: 1,
      removeOnComplete: { count: 5 },
      removeOnFail: { count: 5 },
    },
  );

  console.log(`[Scheduler] Manual crawl queued: job ID ${job.id ?? '?'} (reason: ${reason})`);
  return job.id ?? 'unknown';
}

function getNextRun(cron: string): Date {
  const now = new Date();
  const next = new Date(now);
  const parts = cron.split(' ');
  const targetHour = parseInt(parts[1] ?? '2', 10);
  const targetMinute = parseInt(parts[0] ?? '0', 10);
  const targetWeekday = parseInt(parts[4] ?? '1', 10);

  const currentDay = now.getUTCDay();
  let daysUntil = (targetWeekday - currentDay + 7) % 7;
  if (daysUntil === 0 && (now.getUTCHours() > targetHour ||
    (now.getUTCHours() === targetHour && now.getUTCMinutes() >= targetMinute))) {
    daysUntil = 7;
  }

  next.setUTCDate(now.getUTCDate() + daysUntil);
  next.setUTCHours(targetHour, targetMinute, 0, 0);
  return next;
}
