/**
 * Tatkal runner — keeps ONE browser open across all retries.
 *
 * Why this matters for Tatkal:
 *   - Browser launch + session load + SPA boot = 3-5s of overhead per retry
 *   - Tatkal bookings sell out in 5-30 seconds — you can't afford 3-5s per attempt
 *   - This runner launches the browser ONCE, fills the search form ONCE,
 *     then loops "click Search → check availability → click Book Now"
 *     with sub-second cycle times.
 *
 * Flow:
 *   1. Launch browser, load session, navigate to search page. (one-time)
 *   2. Fill From/To/Date/Class/Quota. (one-time)
 *   3. Loop:
 *      a. Click Search.
 *      b. Look for a matching train with Book Now available.
 *      c. If found → click Book Now → master list / typed passengers →
 *         tick consent → click Review Journey → pause for payment (success).
 *      d. If not found → wait retryIntervalSec (default 2s for Tatkal) → loop.
 *      e. If retryMaxMinutes exceeded → mark exhausted.
 *
 * NOTE: This runner does NOT close the browser between retries. If the
 * page navigates to a different URL (e.g. captcha interstitial), it
 * navigates back to the search URL.
 */

import { db } from "@/lib/db";
import { JobLogger } from "./logger";
import { jobStore, type ResumeDecision } from "./store";
import { sendBookingNotification } from "./email";
import type { AttemptOutcome, PassengerDTO } from "./types";
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

export async function runTatkalJob(jobId: string, input: AgentRunInput) {
  const logger = new JobLogger(jobId);
  const startTime = Date.now();
  const maxMs = (input.retryMaxMinutes || 15) * 60_000;
  const intervalMs = Math.max(1_000, (input.retryIntervalSec || 2) * 1_000);
  let attempt = 0;
  let browser: Browser | null = null;
  let page: Page | null = null;
  let lastScreenshot: string | undefined;

  await logger.step("🚀 TATKAL MODE — persistent browser, fast retries, master list enabled.");
  await logger.info(`Retry interval: ${intervalMs / 1000}s. Window: ${maxMs / 60_000} min.`);

  try {
    // ----- One-time setup: launch + navigate + fill form -----
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

    // ----- Loop: search → check → book or retry -----
    while (true) {
      attempt += 1;
      const elapsed = Date.now() - startTime;
      if (elapsed > maxMs) {
        await exhaustJob(jobId, `Tatkal retry window (${maxMs / 60_000} min) exhausted after ${attempt} attempts.`);
        return;
      }

      await db.bookingJob.update({
        where: { id: jobId },
        data: { attemptCount: attempt, currentStep: `Tatkal attempt ${attempt} — searching…` },
      });
      await logger.step(`── Tatkal attempt ${attempt} (elapsed ${Math.floor(elapsed / 1000)}s) ──`);

      const searchResult = await searchAndFindTrain(page, input, logger);
      if (!searchResult.found) {
        await logger.warn(`Attempt ${attempt}: ${searchResult.reason ?? "no availability"}. Retrying in ${intervalMs / 1000}s.`);
        await db.bookingJob.update({
          where: { id: jobId },
          data: { currentStep: `Waiting ${intervalMs / 1000}s for retry`, lastMessage: searchResult.reason ?? "" },
        });
        await sleep(intervalMs);
        continue;
      }

      // Train found — proceed to book.
      await logger.success(`Train ${searchResult.trainNumber} available! Booking now…`);
      const bookResult = await bookTrainAndFillPassengers(page, input, logger);
      if ("fatal" in bookResult) {
        // Booking phase failed — fatal, don't retry.
        await failJob(jobId, bookResult.fatal);
        return;
      }
      lastScreenshot = bookResult.screenshot;

      // Dry-run — stop here.
      if (input.dryRun) {
        await logger.success("DRY RUN COMPLETE — agent reached Review Journey page. No payment attempted.");
        await succeedJob(jobId, { kind: "success", reviewScreenshot: lastScreenshot }, attempt);
        return;
      }

      // Pause before payment.
      if (input.pauseBeforePayment) {
        await logger.success("Reached review page. Pausing for manual payment.");
        await db.bookingJob.update({
          where: { id: jobId },
          data: {
            status: "paused_payment",
            currentStep: "Paused before payment — awaiting user",
            lastMessage: "Tatkal booking reached review page. Complete payment manually.",
            resultJson: safeJson({ screenshotPath: lastScreenshot }),
          },
        });
        await sendBookingNotification(jobId, "paused_payment", {
          message: "Tatkal booking reached review page. Complete payment NOW in the IRCTC browser window!",
          screenshotPath: lastScreenshot,
        }).catch(() => {});

        // Wait for user decision.
        const { waitForResume } = jobStore.register(jobId);
        const decision: ResumeDecision = await waitForResume();
        jobStore.unregister(jobId);

        if (decision.action === "cancel") {
          await cancelJob(jobId, "User cancelled at payment step.");
          return;
        }
        if (decision.action === "proceed") {
          // User completed payment manually.
          await succeedJob(jobId, { kind: "success", reviewScreenshot: lastScreenshot }, attempt);
          return;
        }
        // "retry" — start a fresh booking attempt with same persistent browser.
        await logger.step("User requested retry. Restarting booking flow on persistent browser…");
        // Navigate back to search page for the next attempt.
        await page.goto("https://www.irctc.co.in/nget/train-search", { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
        await page.waitForTimeout(2_000);
        await fillSearchForm(page, input, logger);
        continue;
      }

      // Auto-confirm + payment method.
      await logger.warn("autoConfirmBooking ON — clicking through to payment.");
      const payBtn = page.getByRole("button", { name: /continue to pay|pay now|continue/i }).first();
      await payBtn.click({ timeout: 8_000 }).catch(() => {});
      await page.waitForTimeout(1_500);

      if (input.paymentMethod !== "SKIP") {
        const r = await selectPaymentMethod(page, input.paymentMethod, logger);
        lastScreenshot = r.screenshot ?? lastScreenshot;
      }

      await succeedJob(jobId, { kind: "success", reviewScreenshot: lastScreenshot }, attempt);
      return;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logger.error(`Tatkal runner crashed: ${msg}`);
    await failJob(jobId, msg);
  } finally {
    await closeBrowser(browser);
    jobStore.unregister(jobId);
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

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
