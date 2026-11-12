import { runDueAlerts, runLearningSummaries } from '../alerts/queue.js';
import { runReminders as runDueReminders } from '../ingest/handlers/deprecation.js';
import type { Deps } from '../web/app.js';

type Job = (deps: Deps, now: number) => Promise<void>;
export type SchedulerJobs = { runDue: Job; runLearning: Job; runMaintenance: Job; runReminders: Job };

/**
 * Daily maintenance hook (03:00 UTC). Task 12 replaces this no-op: pass its function as
 * `jobs.runMaintenance` from server.ts (or change the default below).
 */
const noopMaintenance: Job = async () => {};

const TICK_MS = 60_000;

export function startScheduler(deps: Deps, jobs: Partial<SchedulerJobs> = {}): () => void {
  const { runDue = runDueAlerts, runLearning = runLearningSummaries, runMaintenance = noopMaintenance, runReminders = runDueReminders } = jobs;
  let running = false;
  let lastMaintenanceDay = '';

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const now = Date.now();
      await runDue(deps, now).catch(e => console.error('scheduler: alerts failed', e instanceof Error ? e.message : 'error'));
      await runLearning(deps, now).catch(e => console.error('scheduler: learning summaries failed', e instanceof Error ? e.message : 'error'));
      await runReminders(deps, now).catch(e => console.error('scheduler: reminders failed', e instanceof Error ? e.message : 'error'));
      const d = new Date(now);
      const day = d.toISOString().slice(0, 10);
      if (d.getUTCHours() === 3 && day !== lastMaintenanceDay) {
        lastMaintenanceDay = day;
        await runMaintenance(deps, now).catch(e => console.error('scheduler: maintenance failed', e instanceof Error ? e.message : 'error'));
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => { void tick(); }, TICK_MS);
  return () => clearInterval(timer);
}
