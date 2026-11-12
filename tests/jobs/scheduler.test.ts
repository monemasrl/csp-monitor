import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startScheduler } from '../../src/jobs/scheduler.js';
import { testDeps } from '../helpers.js';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('scheduler', () => {
  it('does not start a round while the previous one is running, and stops', async () => {
    let release!: () => void;
    const runDue = vi.fn(() => new Promise<void>(r => { release = r; }));
    const stop = startScheduler(testDeps(), { runDue, runLearning: async () => {}, runMaintenance: async () => {} });
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runDue).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runDue).toHaveBeenCalledTimes(2);
    stop();
    release();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(runDue).toHaveBeenCalledTimes(2);
  });

  it('runs maintenance once a day at 03:00 UTC', async () => {
    vi.setSystemTime(Date.UTC(2026, 10, 12, 2, 58));
    const runMaintenance = vi.fn(async () => {});
    const stop = startScheduler(testDeps(), { runDue: async () => {}, runLearning: async () => {}, runMaintenance });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runMaintenance).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(runMaintenance).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(runMaintenance).toHaveBeenCalledTimes(1);
    stop();
  });

  it('survives a failing round', async () => {
    const runDue = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
    const stop = startScheduler(testDeps(), { runDue, runLearning: async () => {}, runMaintenance: async () => {} });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await vi.advanceTimersByTimeAsync(120_000);
    expect(runDue).toHaveBeenCalledTimes(2);
    stop();
  });

  it('runs the reminders job every tick and survives its failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const runReminders = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
    const stop = startScheduler(testDeps(), { runDue: async () => {}, runLearning: async () => {}, runMaintenance: async () => {}, runReminders });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(runReminders).toHaveBeenCalledTimes(2);
    stop();
  });
});
