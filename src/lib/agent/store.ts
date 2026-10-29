/**
 * In-memory store of running / paused jobs.
 *
 * Holds the cancellation signal and resume callback for each active job
 * so the dashboard can:
 *  - cancel a running job (signal.abort)
 *  - resume a paused_review / paused_payment job
 *
 * This is intentionally in-process — the booking agent runs in the same
 * Node process as Next.js. If the process restarts, paused jobs are
 * marked as "failed" on next boot (best-effort recovery).
 */

import type { AttemptOutcome } from "./types";

export type ResumeDecision =
  | { action: "proceed" } // user clicked "Confirm & continue to payment"
  | { action: "cancel" } // user clicked "Cancel booking"
  | { action: "retry" }; // user clicked "Retry now" while paused

interface RunningJob {
  jobId: string;
  abortController: AbortController;
  /** Resolved when the user makes a decision on a paused_review/paused_payment state. */
  resumeResolve: ((d: ResumeDecision) => void) | null;
  /** Snapshot of the last attempt outcome (for dashboard display). */
  lastOutcome: AttemptOutcome | null;
  startedAt: number;
}

class JobStore {
  private jobs = new Map<string, RunningJob>();

  register(jobId: string): {
    abortSignal: AbortSignal;
    waitForResume: () => Promise<ResumeDecision>;
  } {
    const abortController = new AbortController();
    const entry: RunningJob = {
      jobId,
      abortController,
      resumeResolve: null,
      lastOutcome: null,
      startedAt: Date.now(),
    };
    this.jobs.set(jobId, entry);

    const waitForResume = () =>
      new Promise<ResumeDecision>((resolve) => {
        entry.resumeResolve = resolve;
      });

    return { abortSignal: abortController.signal, waitForResume };
  }

  /** User (or timeout) decided to resume a paused job. Returns true if delivered. */
  resume(jobId: string, decision: ResumeDecision): boolean {
    const entry = this.jobs.get(jobId);
    if (!entry || !entry.resumeResolve) return false;
    entry.resumeResolve(decision);
    entry.resumeResolve = null;
    return true;
  }

  /** Cancel a running or paused job. */
  cancel(jobId: string): boolean {
    const entry = this.jobs.get(jobId);
    if (!entry) return false;
    if (entry.resumeResolve) {
      entry.resumeResolve({ action: "cancel" });
      entry.resumeResolve = null;
    }
    entry.abortController.abort();
    return true;
  }

  setLastOutcome(jobId: string, outcome: AttemptOutcome) {
    const entry = this.jobs.get(jobId);
    if (entry) entry.lastOutcome = outcome;
  }

  getLastOutcome(jobId: string): AttemptOutcome | null {
    return this.jobs.get(jobId)?.lastOutcome ?? null;
  }

  isActive(jobId: string): boolean {
    return this.jobs.has(jobId);
  }

  unregister(jobId: string) {
    this.jobs.delete(jobId);
  }

  listActive(): string[] {
    return Array.from(this.jobs.keys());
  }
}

export const jobStore = new JobStore();
