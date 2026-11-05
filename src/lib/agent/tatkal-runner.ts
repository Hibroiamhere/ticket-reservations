/**
 * Tatkal runner — rapid-fire, sub-second booking software.
 *
 * Designed to beat human speed:
 *   * Persistent browser — launched ONCE, reused for every retry.
 *   * Images/fonts/media blocked — pages parse in ~100-300ms.
 *   * Minimum retry interval 500ms (humans need ~1.5-2s per click).
 *   * Scheduled start — arms at a set time (10:00 AM AC / 11:00 AM non-AC)
 *     and begins scanning the instant the window opens.
 *   * Pre-warm — loads session + search page before the window so the first
 *     search fires immediately at T-0.
 *   * Direct DOM evaluation — no slow click/type/suggest chains.
 *   * Fail-fast timeouts (6s) — if IRCTC hiccups, retry immediately.
 *
 * Flow:
 *   1. [Optional pre-warm] Launch browser, load session, navigate to search,
 *      fill form once — keep page warm until scheduled start.
 *   2. At scheduled start: enter rapid loop:
 *      a. Click Search → scan preferred trains → click Book Now (sub-second)
 *      b. If found → fill passengers (master list preferred) → Review Journey
 *      c. Pause before payment (default) OR auto-confirm payment method
 *      d. If not found → wait interval (≥500ms) → loop
 *   3. Exhaust when retry window exceeded.
 */

import { db } from "@/lib/db";
import { JobLogger } from "./logger";
import { jobStore, type ResumeDecision } from "./store";
import { sendBookingNotification } from "./email";
import type { AttemptOutcome } from "./types";
import {
  launchBrowserWithSession,
  navigateAndVerifyLogin,
  fillSearchForm,
  searchAndFindTrain,
  bookTrainAndFillPassengers,
  selectPaymentMethod,
  closeBrowser,
  type AgentRunInput,
} from "./irctc-agent";
import type { Browser, Page } from "playwright";

function safeJson<T>(value: T): string {
  return JSON.stringify(value);
}

const MIN_INTERVAL_MS = 500; // hard floor — faster than human clicking

export async function runTatkalJob(jobId: string, input: AgentRunInput) {
  const logger = new JobLogger(jobId);
  const rapid = input.tatkalMode;
  const startTime = Date.now();
  const maxMs = (input.retryMaxMinutes || 15) * 60_000;
  const intervalMs = Math.max(
    MIN_INTERVAL_MS,
    input.rapidIntervalMs ?? (input.retryIntervalSec ?? 1) * 1_000,
  );
  const scheduledAt = input.scheduledStartAt;
  let attempt = 0;
  let browser: Browser | null = null;
  let page: Page | null = null;
  let lastScreenshot: string | undefined;

  await logger.step("🚄 RAPID TATKAL SCANNER — sub-second retry loop, resources blocked.");
  await logger.info(`Interval: ${intervalMs}ms. Window: ${maxMs / 60_000} min.`);
  if (scheduledAt) {
    const wait = scheduledAt - Date.now();
    await logger.info(`Scheduled start in ${Math.max(0, Math.floor(wait / 1000))}s at ${new Date(scheduledAt).toLocaleTimeString()}.`);
  }

  try {
    // ----- One-time setup: launch + navigate + fill form (pre-warm) -----
    const launched = await launchBrowserWithSession(input, logger);
    if ("error" in launched) {
      await failJob(jobId, launched.error);
      return;
    }
    browser = launched.browser;
    page = launched.page;

    const nav = await navigateAndVerifyLogin(page, input, logger);
    if ("fatal" in nav) {
      await failJob(jobId, nav.fatal);
      return;
    }

    await fillSearchForm(page, input, logger);
    await logger.success("Search form pre-filled. Waiting for tatkal window…");

    // ----- Wait for scheduled start if set -----
    if (scheduledAt && Date.now() < scheduledAt) {
      await sleep(scheduledAt - Date.now());
      await logger.step("Tatkal window OPEN — rapid scan starting NOW.");
    }

    // ----- Rapid loop: search → scan → book or retry -----
    while (true) {
      attempt += 1;
      const elapsed = Date.now() - startTime;
      if (elapsed > maxMs) {
        await exhaustJob(jobId, `Rapid scan window (${maxMs / 60_000} min) exhausted after ${attempt} scans.`);
        return;
      }

      await db.bookingJob.update({
        where: { id: jobId },
        data: {
          attemptCount: attempt,
          currentStep: `Rapid scan #${attempt} — searching… (${Math.floor(elapsed / 1000)}s elapsed)`,
        },
      });
      await logger.step(`── Rapid scan #${attempt} (${Math.floor(elapsed / 1000)}s) ──`);

      const searchResult = await searchAndFindTrain(page, input, logger);
      if (!searchResult.found) {
        await logger.warn(`Scan #${attempt}: ${searchResult.reason ?? "no availability"}. Next scan in ${intervalMs}ms.`);
        await db.bookingJob.update({
          where: { id: jobId },
          data: { currentStep: `Scanning again in ${intervalMs}ms…`, lastMessage: searchResult.reason ?? "" },
        });
        await sleep(intervalMs);
        continue;
      }

      // Train found — book immediately.
      await logger.success(`Train ${searchResult.trainNumber} AVAILABLE! Booking now…`);
      const bookResult = await bookTrainAndFillPassengers(page, input, logger);
      if ("fatal" in bookResult) {
        await failJob(jobId, bookResult.fatal);
        return;
      }
      lastScreenshot = bookResult.screenshot;

      // Dry-run — stop at Review Journey.
      if (input.dryRun) {
        await logger.success("DRY RUN COMPLETE — Review Journey page reached. No payment attempted.");
        await succeedJob(jobId, { kind: "success", reviewScreenshot: lastScreenshot }, attempt);
        return;
      }

      // Pause before payment (default safety).
      if (input.pauseBeforePayment) {
        await logger.success("Reached review page. PAUSE — complete payment manually NOW.");
        await db.bookingJob.update({
          where: { id: jobId },
          data: {
            status: "paused_payment",
            currentStep: "Paused before payment — awaiting user",
            lastMessage: "Tatkal booking reached review page. Complete payment in the IRCTC browser window!",
            resultJson: safeJson({ screenshotPath: lastScreenshot }),
          },
        });
        await sendBookingNotification(jobId, "paused_payment", {
          message: "Tatkal booking reached review page. Complete payment NOW!",
          screenshotPath: lastScreenshot,
        }).catch(() => {});

        const { waitForResume } = jobStore.register(jobId);
        const decision: ResumeDecision = await waitForResume();
        jobStore.unregister(jobId);

        if (decision.action === "cancel") {
          await cancelJob(jobId, "User cancelled at payment step.");
          return;
        }
        if (decision.action === "proceed") {
          await succeedJob(jobId, { kind: "success", reviewScreenshot: lastScreenshot }, attempt);
          return;
        }
        // "retry" — fresh scan on same persistent browser.
        await logger.step("User retry. Restarting scan loop on persistent browser…");
        await page?.goto("https://www.irctc.co.in/nget/train-search", {
          waitUntil: "domcontentloaded",
          timeout: 20_000,
        }).catch(() => {});
        await page?.waitForTimeout(rapid ? 600 : 1_500);
        await fillSearchForm(page!, input, logger);
        continue;
      }

      // Auto-confirm + payment method.
      await logger.warn("auto-confirm ON — clicking through to payment.");
      const payBtn = page
        ?.getByRole("button", { name: /continue to pay|pay now|continue/i })
        .first();
      await payBtn.click({ timeout: 8_000 }).catch(() => {});
      await page?.waitForTimeout(rapid ? 400 : 1_500);

      if (input.paymentMethod !== "SKIP") {
        const r = await selectPaymentMethod(page!, input.paymentMethod, logger, rapid);
        lastScreenshot = r.screenshot ?? lastScreenshot;
      }

      await succeedJob(jobId, { kind: "success", reviewScreenshot: lastScreenshot }, attempt);
      return;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logger.error(`Rapid scanner crashed: ${msg}`);
    await failJob(jobId, msg);
  } finally {
    await closeBrowser(browser);
    jobStore.unregister(jobId);
  }
}

// ===========================================================================
// Job terminal helpers
// ===========================================================================

async function succeedJob(jobId: string, outcome: Extract<AttemptOutcome, { kind: "success" }>, attempt: number) {
  const logger = new JobLogger(jobId);
  await db.bookingJob.update({
    where: { id: jobId },
    data: {
      status: "success",
      currentStep: "Booking successful",
      lastMessage: `Succeeded on scan #${attempt}.`,
      finishedAt: new Date(),
      resultJson: safeJson({ pnr: outcome.pnr, transactionId: outcome.transactionId, reviewScreenshot: outcome.reviewScreenshot }),
    },
  });
  await logger.success(`Booking succeeded on scan #${attempt}.`);
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
    data: { status: "exhausted", currentStep: "Scans exhausted", lastMessage: reason, finishedAt: new Date() },
  });
  await logger.error(`Scans exhausted: ${reason}`);
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

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
