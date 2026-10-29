/**
 * Job runner — orchestrates one BookingJob's full lifecycle.
 *
 * For each job:
 *   1. Load job + passengers + session from DB.
 *   2. Mark job as running, log "started".
 *   3. Loop:
 *      a. Run one IRCTC booking attempt.
 *      b. If outcome is success → mark success, send email, exit.
 *      c. If outcome is paused_payment → wait for user decision:
 *           - "proceed" → mark success (user paid manually), send email, exit.
 *           - "cancel"  → mark cancelled, send email, exit.
 *      d. If outcome is fatal → mark failed, send email, exit.
 *      e. If outcome is retry AND retryEnabled AND within retryMaxMinutes
 *         → increment attempt, sleep retryIntervalSec, retry.
 *         Otherwise → mark exhausted, send email, exit.
 *
 * The runner is invoked from the /api/jobs/start route via
 * `scheduleJob(jobId)` which runs it in the background (non-blocking).
 */

import path from "node:path";
import { db } from "@/lib/db";
import { JobLogger } from "./logger";
import { runIrctcBooking, type AgentRunResult } from "./irctc-agent";
import { jobStore, type ResumeDecision } from "./store";
import { sendBookingNotification } from "./email";
import type { AttemptOutcome, JobStatus, PassengerDTO } from "./types";

function safeJson<T>(value: T): string {
  return JSON.stringify(value);
}

export async function runJob(jobId: string) {
  const job = await db.bookingJob.findUnique({ where: { id: jobId } });
  if (!job) {
    console.error(`[runner] job ${jobId} not found`);
    return;
  }

  const logger = new JobLogger(jobId);
  const session = await db.session.findUnique({ where: { id: job.sessionId } });
  if (!session) {
    await failJob(jobId, "Session not found. Please recreate the session.");
    return;
  }

  // Parse passenger IDs.
  let passengerIds: string[] = [];
  try {
    passengerIds = JSON.parse(job.passengerIdsJson) as string[];
  } catch {
    passengerIds = [];
  }
  const passengers = (await db.passenger.findMany({
    where: { id: { in: passengerIds } },
  })) as PassengerDTO[];

  if (passengers.length === 0) {
    await failJob(jobId, "No passengers attached to this job.");
    return;
  }

  const preferredTrains = (job.preferredTrains ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Mark running.
  await db.bookingJob.update({
    where: { id: jobId },
    data: {
      status: "running",
      startedAt: new Date(),
      currentStep: "Starting booking agent…",
    },
  });
  await logger.step(`Job started. From ${job.fromStation} → ${job.toStation}, date ${job.journeyDate}, class ${job.travelClass}, quota ${job.quota}.`);
  await logger.info(`Retry config: enabled=${job.retryEnabled}, every ${job.retryIntervalSec}s, max ${job.retryMaxMinutes} min.`);
  await logger.info(`Passengers: ${passengers.map((p) => p.name).join(", ")}`);
  if (preferredTrains.length) await logger.info(`Preferred trains: ${preferredTrains.join(", ")}`);

  const startTime = Date.now();
  const maxMs = job.retryMaxMinutes * 60_000;
  let attempt = 0;

  // Main retry loop.
  while (true) {
    attempt += 1;
    const elapsed = Date.now() - startTime;

    // Check cancellation.
    if (jobStore.cancel.bind(jobStore, jobId) && false) {
      // (no-op; cancel is checked via abortSignal inside the agent)
    }

    await db.bookingJob.update({
      where: { id: jobId },
      data: { attemptCount: attempt, currentStep: `Attempt ${attempt} in progress…` },
    });
    await logger.step(`── Attempt ${attempt} started (elapsed ${Math.floor(elapsed / 1000)}s) ──`);

    const result: AgentRunResult = await runIrctcBooking({
      jobId,
      sessionId: session.id,
      storageFileName: session.storagePath,
      fromStation: job.fromStation,
      fromStationName: job.fromStationName ?? undefined,
      toStation: job.toStation,
      toStationName: job.toStationName ?? undefined,
      journeyDate: job.journeyDate,
      travelClass: job.travelClass,
      quota: job.quota,
      preferredTrains,
      passengers,
      contactMobile: job.contactMobile,
      contactEmail: job.contactEmail,
      pauseBeforePayment: job.pauseBeforePayment,
      autoConfirmBooking: job.autoConfirmBooking,
    });

    jobStore.setLastOutcome(jobId, result.outcome);
    const outcome = result.outcome;

    // Success.
    if (outcome.kind === "success") {
      await succeedJob(jobId, outcome, attempt);
      jobStore.unregister(jobId);
      return;
    }

    // Paused for payment — wait for user.
    if (outcome.kind === "paused_payment") {
      await logger.warn(`Paused before payment. Screenshot: ${outcome.screenshotPath ?? "n/a"}`);
      await db.bookingJob.update({
        where: { id: jobId },
        data: {
          status: "paused_payment",
          currentStep: "Paused before payment — awaiting user",
          lastMessage: outcome.message,
          resultJson: safeJson({ screenshotPath: outcome.screenshotPath }),
        },
      });

      // Send email so user knows to come complete payment.
      await sendBookingNotification(jobId, "paused_payment", {
        message: outcome.message,
        screenshotPath: outcome.screenshotPath,
      }).catch(() => {});

      // Wait for user decision (proceed / cancel). The dashboard's
      // /api/jobs/resume route calls jobStore.resume().
      const { waitForResume } = jobStore.register(jobId); // re-register for resume
      const decision: ResumeDecision = await waitForResume();
      jobStore.unregister(jobId);

      if (decision.action === "cancel") {
        await cancelJob(jobId, "User cancelled at payment step.");
        jobStore.unregister(jobId);
        return;
      }
      if (decision.action === "proceed") {
        // User completed payment manually in the IRCTC window. Mark success.
        await succeedJob(jobId, { kind: "success", reviewScreenshot: outcome.screenshotPath }, attempt);
        jobStore.unregister(jobId);
        return;
      }
      // "retry" — loop again.
      await logger.step("User requested retry. Restarting attempt…");
      continue;
    }

    // Paused for review (rare — autoConfirmBooking off but reached review
    // without going to payment). Treat like paused_payment.
    if (outcome.kind === "paused_review") {
      await db.bookingJob.update({
        where: { id: jobId },
        data: {
          status: "paused_review",
          currentStep: "Paused for review",
          lastMessage: outcome.message,
          resultJson: safeJson({ screenshotPath: outcome.screenshotPath }),
        },
      });
      const { waitForResume } = jobStore.register(jobId);
      const decision = await waitForResume();
      jobStore.unregister(jobId);
      if (decision.action === "cancel") {
        await cancelJob(jobId, "User cancelled at review step.");
        return;
      }
      continue;
    }

    // Fatal — no retry.
    if (outcome.kind === "fatal") {
      await failJob(jobId, outcome.reason);
      jobStore.unregister(jobId);
      return;
    }

    // Retry outcome — check retry policy.
    if (outcome.kind === "retry") {
      const retryable = job.retryEnabled && Date.now() - startTime < maxMs;
      await logger.warn(`Attempt ${attempt} needs retry: ${outcome.reason}`);
      if (!retryable) {
        const reason = job.retryEnabled
          ? `Retry window (${job.retryMaxMinutes} min) exhausted.`
          : "Retry disabled by user.";
        await exhaustJob(jobId, reason);
        jobStore.unregister(jobId);
        return;
      }
      await db.bookingJob.update({
        where: { id: jobId },
        data: { currentStep: `Retry ${attempt} scheduled — waiting ${job.retryIntervalSec}s…`, lastMessage: outcome.reason },
      });
      await logger.info(`Sleeping ${job.retryIntervalSec}s before next attempt…`);
      await sleep(job.retryIntervalSec * 1000);
      continue;
    }
  }
}

async function succeedJob(jobId: string, outcome: Extract<AttemptOutcome, { kind: "success" }>, attempt: number) {
  const logger = new JobLogger(jobId);
  await db.bookingJob.update({
    where: { id: jobId },
    data: {
      status: "success",
      currentStep: "Booking successful",
      lastMessage: `Succeeded on attempt ${attempt}.`,
      finishedAt: new Date(),
      resultJson: safeJson({ pnr: outcome.pnr, transactionId: outcome.transactionId, reviewScreenshot: outcome.reviewScreenshot }),
    },
  });
  await logger.success(`Booking succeeded on attempt ${attempt}.`);
  await sendBookingNotification(jobId, "success", { pnr: outcome.pnr, transactionId: outcome.transactionId }).catch(() => {});
}

async function failJob(jobId: string, reason: string) {
  const logger = new JobLogger(jobId);
  await db.bookingJob.update({
    where: { id: jobId },
    data: { status: "failed", currentStep: "Failed", lastMessage: reason, finishedAt: new Date() },
  });
  await logger.error(`Job failed: ${reason}`);
  await sendBookingNotification(jobId, "failed", { reason }).catch(() => {});
}

async function exhaustJob(jobId: string, reason: string) {
  const logger = new JobLogger(jobId);
  await db.bookingJob.update({
    where: { id: jobId },
    data: { status: "exhausted", currentStep: "Retries exhausted", lastMessage: reason, finishedAt: new Date() },
  });
  await logger.error(`Retries exhausted: ${reason}`);
  await sendBookingNotification(jobId, "exhausted", { reason }).catch(() => {});
}

async function cancelJob(jobId: string, reason: string) {
  const logger = new JobLogger(jobId);
  await db.bookingJob.update({
    where: { id: jobId },
    data: { status: "cancelled", currentStep: "Cancelled", lastMessage: reason, finishedAt: new Date() },
  });
  await logger.warn(`Job cancelled: ${reason}`);
  await sendBookingNotification(jobId, "cancelled", { reason }).catch(() => {});
}

export function statusIsTerminal(status: JobStatus): boolean {
  return ["success", "failed", "cancelled", "exhausted"].includes(status);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Schedule a job to run in the background without blocking the API call. */
export function scheduleJob(jobId: string) {
  // Use setImmediate so the API response can return first.
  setImmediate(() => {
    runJob(jobId).catch((err) => {
      console.error(`[runner] uncaught error for job ${jobId}:`, err);
    });
  });
}
