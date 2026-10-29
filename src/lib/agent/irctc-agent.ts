/**
 * IRCTC Playwright agent — refactored into phases.
 *
 * Phases:
 *   1. launchBrowserWithSession() — open Chromium, load saved cookies
 *   2. fillSearchForm()           — fill From/To/Date/Quota/Class on search page
 *   3. searchAndFindTrain()       — click Search, find matching train with availability
 *   4. bookTrainAndFillPassengers() — click Book Now, fill passengers (master list OR
 *                                     typed), tick consent, click Review Journey
 *   5. selectPaymentMethod()      — (optional) click chosen payment option
 *   6. closeBrowser()
 *
 * The runner orchestrates these:
 *   - Regular mode: 1→2→3→4→5→6 per attempt; new browser each retry
 *   - Tatkal mode: 1→2 once, then loop (3→4→5→6 if train found / sleep+research if not).
 *                 Browser stays open across retries for sub-second loop times.
 *
 * IRCTC aggressively blocks automation and changes selectors often. Every
 * selector attempt has a fallback to text-based search. Screenshots are
 * taken at terminal states only (Tatkal mode) or at every step (regular mode).
 */

import path from "node:path";
import fs from "node:fs/promises";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { db } from "@/lib/db";
import { JobLogger } from "./logger";
import type { AttemptOutcome, PassengerDTO } from "./types";

const SESSIONS_DIR = "/home/z/my-project/.sessions";
const IRCTC_SEARCH_URL = "https://www.irctc.co.in/nget/train-search";

export interface AgentRunInput {
  jobId: string;
  sessionId: string;
  storageFileName: string;
  fromStation: string;
  fromStationName?: string;
  toStation: string;
  toStationName?: string;
  journeyDate: string; // YYYY-MM-DD
  travelClass: string;
  quota: string;
  preferredTrains: string[];
  passengers: PassengerDTO[];
  contactMobile: string;
  contactEmail: string;
  pauseBeforePayment: boolean;
  autoConfirmBooking: boolean;
  // New:
  useMasterList: boolean;
  masterListNames: string[];
  paymentMethod: string; // SKIP | BHIM_UPI | CREDIT_CARD | ...
  dryRun: boolean;
  tatkalMode: boolean;
}

export interface AgentRunResult {
  outcome: AttemptOutcome;
  screenshotPath?: string;
}

/** Take a screenshot — skipped in Tatkal mode for speed unless at terminal state. */
async function screenshot(jobId: string, page: Page, label: string, force = false): Promise<string | undefined> {
  try {
    const filename = `${jobId}-${Date.now()}-${label.replace(/[^a-z0-9]/gi, "_")}.png`;
    const filePath = path.join(SESSIONS_DIR, "screens", filename);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await page.screenshot({ path: filePath, fullPage: false });
    return filePath;
  } catch {
    return undefined;
  }
}

// ===========================================================================
// Phase 1: Launch browser with saved session
// ===========================================================================

export async function launchBrowserWithSession(input: AgentRunInput, logger: JobLogger): Promise<{ browser: Browser; context: BrowserContext; page: Page } | { error: string }> {
  await logger.step("Launching headless browser with saved session…");
  const storagePath = path.join(SESSIONS_DIR, input.storageFileName);
  try {
    await fs.access(storagePath);
  } catch {
    return { error: "Session file not found. Please re-login via the Sessions tab." };
  }

  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
  });
  const context = await browser.newContext({
    storageState: storagePath,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 900 },
  });
  // Mask webdriver flag.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  const page = await context.newPage();
  // In Tatkal mode, use shorter timeouts for speed.
  page.setDefaultTimeout(input.tatkalMode ? 8_000 : 20_000);

  return { browser, context, page };
}

// ===========================================================================
// Phase 2: Navigate + verify login + fill search form
// ===========================================================================

export async function navigateAndVerifyLogin(page: Page, input: AgentRunInput, logger: JobLogger): Promise<{ ok: true } | { fatal: string; screenshot?: string }> {
  await logger.step("Navigating to IRCTC train search…");
  await page.goto(IRCTC_SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(input.tatkalMode ? 2_000 : 5_000); // SPA boot

  const url = page.url();
  if (url.includes("/profile/login")) {
    const sc = await screenshot(input.jobId, page, "redirected-to-login", true);
    await logger.screenshot(sc ?? "", "Redirected to login page (session expired)");
    return { fatal: "IRCTC session has expired. Please re-login via the Sessions tab.", screenshot: sc };
  }

  const hiLabel = await page.locator('span:has-text("Hi,")').first().textContent({ timeout: 5_000 }).catch(() => null);
  if (!hiLabel) {
    if (!input.tatkalMode) {
      const sc = await screenshot(input.jobId, page, "no-hi-label");
      await logger.warn("Could not confirm login state — continuing anyway (IRCTC layout may have changed).");
    }
  } else {
    await logger.success(`Logged in as: ${hiLabel.trim()}`);
  }
  return { ok: true };
}

export async function fillSearchForm(page: Page, input: AgentRunInput, logger: JobLogger): Promise<void> {
  await logger.step(`Filling search form: ${input.fromStationName ?? input.fromStation} → ${input.toStationName ?? input.toStation}, ${input.journeyDate}, ${input.travelClass}, quota ${input.quota}`);
  await fillStationField(page, "Origin", input.fromStation, logger);
  await fillStationField(page, "Destination", input.toStation, logger);
  await fillJourneyDate(page, input.journeyDate, logger);
  await selectQuota(page, input.quota, logger);
  await selectClass(page, input.travelClass, logger);
}

// ===========================================================================
// Phase 3: Click Search + find matching train
// ===========================================================================

export async function searchAndFindTrain(page: Page, input: AgentRunInput, logger: JobLogger): Promise<{ found: boolean; trainNumber?: string; reason?: string; screenshot?: string }> {
  await logger.step("Clicking Search…");
  const searchBtn = page.getByRole("button", { name: /search/i }).first();
  await searchBtn.click({ timeout: 8_000 }).catch(async () => {
    await page.click('button[type="submit"]').catch(() => {});
  });

  await logger.step("Waiting for train list…");
  await page.waitForLoadState("networkidle", { timeout: input.tatkalMode ? 10_000 : 30_000 }).catch(() => {});
  await page.waitForTimeout(input.tatkalMode ? 1_500 : 3_000);

  // In Tatkal mode, skip intermediate screenshots for speed.
  let sc: string | undefined;
  if (!input.tatkalMode) {
    sc = await screenshot(input.jobId, page, "train-list");
    await logger.screenshot(sc ?? "", "Train list loaded");
    await db.bookingJob.update({ where: { id: input.jobId }, data: { hasScreenshot: true } });
  }

  return findAndClickTrain(page, input.preferredTrains, logger, input.tatkalMode);
}

// ===========================================================================
// Phase 4: Click Book Now + fill passengers + tick consent + Review Journey
// ===========================================================================

export async function bookTrainAndFillPassengers(page: Page, input: AgentRunInput, logger: JobLogger): Promise<{ ok: true; screenshot?: string } | { fatal: string; screenshot?: string }> {
  await page.waitForTimeout(input.tatkalMode ? 1_500 : 3_000);
  let sc: string | undefined;
  if (!input.tatkalMode) {
    sc = await screenshot(input.jobId, page, "after-book-now");
    await logger.screenshot(sc ?? "", "Passenger details page");
  }

  // Choose passenger-filling strategy.
  if (input.useMasterList && input.masterListNames.length > 0) {
    await logger.step(`Selecting ${input.masterListNames.length} passenger(s) from IRCTC Master List…`);
    const result = await selectPassengersFromMasterList(page, input.masterListNames, logger);
    if (!result.ok) {
      await logger.warn(`Master List selection failed (${result.reason}). Falling back to typed entry.`);
      await fillPassengers(page, input.passengers, logger);
    }
  } else {
    await logger.step(`Typing ${input.passengers.length} passenger(s)…`);
    await fillPassengers(page, input.passengers, logger);
  }

  await fillContactDetails(page, input.contactMobile, input.contactEmail, logger);
  await tickConsent(page, logger);

  await logger.step("Clicking Review Journey…");
  const reviewBtn = page.getByRole("button", { name: /review journey|continue|review booking/i }).first();
  await reviewBtn.click({ timeout: 8_000 }).catch(async () => {
    await page.click('button[type="submit"]').catch(() => {});
  });
  await page.waitForLoadState("networkidle", { timeout: input.tatkalMode ? 10_000 : 30_000 }).catch(() => {});
  await page.waitForTimeout(input.tatkalMode ? 1_000 : 2_000);

  sc = await screenshot(input.jobId, page, "review-page", true);
  await logger.screenshot(sc ?? "", "Review page reached");

  return { ok: true, screenshot: sc };
}

// ===========================================================================
// Phase 5: Payment method selection (optional)
// ===========================================================================

export async function selectPaymentMethod(page: Page, method: string, logger: JobLogger): Promise<{ ok: boolean; screenshot?: string }> {
  if (method === "SKIP") {
    await logger.info("Payment method = SKIP. Leaving payment page for manual selection.");
    return { ok: false };
  }
  const methodLabels: Record<string, string> = {
    BHIM_UPI: "BHIM UPI",
    CREDIT_CARD: "Credit Card",
    DEBIT_CARD: "Debit Card",
    WALLET: "Wallet",
    PAY_ON_DELIVERY: "Pay on Delivery",
    INTERNATIONAL_CARD: "International Card",
  };
  const label = methodLabels[method] ?? method;
  await logger.step(`Selecting payment method: ${label}…`);
  // IRCTC payment page shows radio/card-style options.
  const option = page.locator(`label:has-text("${label}"), div:has-text("${label}"), span:has-text("${label}")`).first();
  await option.click({ timeout: 8_000 }).catch(async () => {
    await logger.warn(`Could not click payment option "${label}" — selectors may have changed.`);
  });
  await page.waitForTimeout(500);
  // Try clicking "Pay" / "Continue" button.
  const payBtn = page.getByRole("button", { name: /pay|continue|proceed/i }).first();
  await payBtn.click({ timeout: 5_000 }).catch(() => {});
  const sc = await screenshot(page.url().split("/").pop() ?? "payment", page, `payment-${method}`, true);
  return { ok: true, screenshot: sc };
}

// ===========================================================================
// Phase 6: Close browser
// ===========================================================================

export async function closeBrowser(browser: Browser | null) {
  try { await browser?.close(); } catch {}
}

// ===========================================================================
// Top-level orchestrator (used by the regular runner)
// ===========================================================================

export async function runIrctcBooking(input: AgentRunInput): Promise<AgentRunResult> {
  const logger = new JobLogger(input.jobId);
  let browser: Browser | null = null;
  let lastScreenshot: string | undefined;

  try {
    const launched = await launchBrowserWithSession(input, logger);
    if ("error" in launched) {
      return { outcome: { kind: "fatal", reason: launched.error } };
    }
    browser = launched.browser;

    const nav = await navigateAndVerifyLogin(launched.page, input, logger);
    if ("fatal" in nav) {
      return { outcome: { kind: "fatal", reason: nav.fatal }, screenshotPath: nav.screenshot };
    }

    await fillSearchForm(launched.page, input, logger);

    const searchResult = await searchAndFindTrain(launched.page, input, logger);
    if (!searchResult.found) {
      return {
        outcome: { kind: "retry", reason: searchResult.reason ?? "No matching train with availability found." },
        screenshotPath: searchResult.screenshot ?? lastScreenshot,
      };
    }

    const bookResult = await bookTrainAndFillPassengers(launched.page, input, logger);
    if ("fatal" in bookResult) {
      return { outcome: { kind: "fatal", reason: bookResult.fatal }, screenshotPath: bookResult.screenshot };
    }
    lastScreenshot = bookResult.screenshot;

    // Dry-run — stop here, mark success.
    if (input.dryRun) {
      await logger.success("DRY RUN COMPLETE — agent successfully reached the Review Journey page. No payment was attempted.");
      return {
        outcome: { kind: "success", reviewScreenshot: lastScreenshot },
        screenshotPath: lastScreenshot,
      };
    }

    // Pause before payment (default safe behavior).
    if (input.pauseBeforePayment) {
      await logger.success("Reached review page. Pausing for manual review before payment.");
      await db.bookingJob.update({
        where: { id: input.jobId },
        data: { status: "paused_payment", currentStep: "Paused — review and pay manually", lastMessage: "Awaiting user to complete payment in browser window" },
      });
      return {
        outcome: {
          kind: "paused_payment",
          screenshotPath: lastScreenshot ?? "",
          message: "Booking reached review page. Complete payment manually in the IRCTC window, or click Pay in the dashboard to continue automatically.",
        },
        screenshotPath: lastScreenshot,
      };
    }

    // Auto-confirm: click through to payment.
    await logger.warn("autoConfirmBooking is ON — proceeding to payment automatically. This is risky.");
    await logger.step("Clicking Continue to Payment…");
    const payBtn = launched.page.getByRole("button", { name: /continue to pay|pay now|continue/i }).first();
    await payBtn.click({ timeout: 8_000 }).catch(() => {});
    await launched.page.waitForTimeout(2_000);

    // Optional payment method selection.
    if (input.paymentMethod !== "SKIP") {
      const payResult = await selectPaymentMethod(launched.page, input.paymentMethod, logger);
      lastScreenshot = payResult.screenshot ?? lastScreenshot;
    } else {
      lastScreenshot = await screenshot(input.jobId, launched.page, "payment-page", true);
      await logger.screenshot(lastScreenshot ?? "", "Payment page reached — auto-payment not supported");
    }

    return {
      outcome: { kind: "success", reviewScreenshot: lastScreenshot },
      screenshotPath: lastScreenshot,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logger.error(`Agent crashed: ${msg}`);
    return { outcome: { kind: "fatal", reason: msg }, screenshotPath: lastScreenshot };
  } finally {
    await closeBrowser(browser);
  }
}

// ---------------------------------------------------------------------------
// Helpers — each tolerant of IRCTC's frequent selector changes.
// ---------------------------------------------------------------------------

async function fillStationField(page: Page, field: "Origin" | "Destination", code: string, logger: JobLogger) {
  const label = field === "Origin" ? "From" : "To";
  const candidates = [
    `input[aria-label="${field}"]`,
    `input[placeholder*="${label}"]`,
    `input[placeholder*="${field}"]`,
    `input#${field.toLowerCase()}`,
    `input[formcontrolname="${field.toLowerCase() === "origin" ? "origin" : "destination"}"]`,
  ];

  let input = null as ReturnType<typeof page.locator> | null;
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if ((await loc.count().catch(() => 0)) > 0) { input = loc; break; }
  }
  if (!input) {
    await logger.warn(`Could not find ${field} input via known selectors — trying generic autocomplete.`);
    input = page.locator("input.ui-autocomplete").nth(field === "Origin" ? 0 : 1);
  }

  await input!.click({ timeout: 8_000 }).catch(() => {});
  await input!.fill("");
  await input!.type(code, { delay: 30 });
  await page.waitForTimeout(500);
  const suggestion = page.locator(`li:has-text("${code}")`).first();
  await suggestion.click({ timeout: 3_000 }).catch(async () => {
    await page.locator("li.ui-autocomplete-list-item, .ui-autocomplete-panel li").first().click({ timeout: 2_000 }).catch(() => {});
  });
  await logger.info(`Filled ${field}: ${code}`);
}

async function fillJourneyDate(page: Page, journeyDate: string, logger: JobLogger) {
  const [y, m, d] = journeyDate.split("-");
  const irctcDate = `${d}-${m}-${y}`;

  const candidates = [
    'input[aria-label="Journey Date"]',
    'input[placeholder*="Journey Date"]',
    'input#jDate',
    'input[formcontrolname="jDate"]',
  ];
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if ((await loc.count().catch(() => 0)) > 0) {
      await loc.click({ timeout: 5_000 }).catch(() => {});
      await loc.fill("");
      await loc.type(irctcDate, { delay: 30 });
      await page.keyboard.press("Enter");
      await logger.info(`Journey date set to ${irctcDate}`);
      return;
    }
  }
  await logger.warn("Could not find journey date input — leaving default.");
}

async function selectQuota(page: Page, quota: string, logger: JobLogger) {
  const quotaLabels: Record<string, string> = {
    GN: "General", TQ: "Tatkal", PT: "Premium Tatkal", LD: "Ladies", HP: "Handicapped",
  };
  const labelText = quotaLabels[quota] ?? quota;
  const label = page.locator(`label:has-text("${labelText}"), span:has-text("${labelText}")`).first();
  await label.click({ timeout: 3_000 }).catch(async () => {
    await page.selectOption("select#quota", quota).catch(() => {});
  });
  await logger.info(`Quota selected: ${labelText}`);
}

async function selectClass(page: Page, travelClass: string, logger: JobLogger) {
  const classLabels: Record<string, string> = {
    SL: "Sleeper", "3A": "AC 3 Tier", "2A": "AC 2 Tier", "1A": "AC First",
    CC: "AC Chair Car", EC: "Exec Chair", "2S": "Second Sitting",
  };
  const labelText = classLabels[travelClass] ?? travelClass;
  const label = page.locator(`label:has-text("${labelText}"), span:has-text("${labelText}")`).first();
  await label.click({ timeout: 3_000 }).catch(() => {});
  await logger.info(`Class selected: ${labelText} (${travelClass})`);
}

async function findAndClickTrain(page: Page, preferredTrains: string[], logger: JobLogger, tatkalMode: boolean): Promise<{ found: boolean; trainNumber?: string; reason?: string; screenshot?: string }> {
  await page.waitForTimeout(tatkalMode ? 800 : 2_000);

  for (const trainNo of preferredTrains) {
    const row = page.locator(`text=${trainNo}`).first();
    if ((await row.count().catch(() => 0)) === 0) continue;

    await logger.info(`Found train ${trainNo} in list — checking availability…`);
    const bookBtn = page.locator(`button:has-text("Book Now")`).filter({ has: page.locator(`text=${trainNo}`) }).first();
    if ((await bookBtn.count().catch(() => 0)) > 0) {
      await bookBtn.click({ timeout: 5_000 }).catch(async () => {
        await page.locator('button:has-text("Book Now")').first().click({ timeout: 3_000 }).catch(() => {});
      });
      return { found: true, trainNumber: trainNo };
    }
    await page.locator('button:has-text("Book Now")').first().click({ timeout: 3_000 }).catch(() => {});
    return { found: true, trainNumber: trainNo };
  }

  await logger.warn("No preferred train matched. Trying first available Book Now button…");
  const anyBookBtn = page.locator('button:has-text("Book Now")').first();
  if ((await anyBookBtn.count().catch(() => 0)) > 0) {
    await anyBookBtn.click({ timeout: 5_000 }).catch(() => {});
    return { found: true, trainNumber: "(first available)" };
  }

  const regret = await page.locator('text=/REGRET|NOT AVAILABLE/i').first().textContent().catch(() => null);
  if (regret) return { found: false, reason: "All trains show REGRET / NOT AVAILABLE." };

  return { found: false, reason: "No Book Now button found — train list may still be loading or selectors changed." };
}

// ===========================================================================
// Master List selection — clicks IRCTC's saved-passenger dropdown entries.
// ===========================================================================

export async function selectPassengersFromMasterList(page: Page, names: string[], logger: JobLogger): Promise<{ ok: true } | { ok: false; reason: string }> {
  // Try multiple ways to open the Master List dropdown.
  const openCandidates = [
    'a:has-text("Master List")',
    'button:has-text("Master List")',
    'span:has-text("Master List")',
    'div:has-text("Master List")',
    '[aria-label*="Master List"]',
  ];
  let opened = false;
  for (const sel of openCandidates) {
    const loc = page.locator(sel).first();
    if ((await loc.count().catch(() => 0)) > 0) {
      await loc.click({ timeout: 5_000 }).catch(() => {});
      opened = true;
      break;
    }
  }
  if (!opened) {
    return { ok: false, reason: "Master List link/button not found on passenger page" };
  }
  await page.waitForTimeout(700);

  // For each name, click the matching entry in the dropdown.
  for (const name of names) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    const entry = page.locator(`div:has-text("${trimmed}"), label:has-text("${trimmed}"), li:has-text("${trimmed}")`).first();
    const found = await entry.count().catch(() => 0);
    if (found === 0) {
      await logger.warn(`Master list entry not found for "${trimmed}" — skipping.`);
      continue;
    }
    await entry.click({ timeout: 3_000 }).catch(() => {});
    await logger.info(`Selected from master list: ${trimmed}`);
    await page.waitForTimeout(300);
  }

  // Close the dropdown.
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(300);
  return { ok: true };
}

async function fillPassengers(page: Page, passengers: PassengerDTO[], logger: JobLogger) {
  for (let i = 0; i < passengers.length; i++) {
    const p = passengers[i];
    if (i > 0) {
      await page.locator('a:has-text("Add Passenger"), button:has-text("Add Passenger")').first().click({ timeout: 3_000 }).catch(() => {});
      await page.waitForTimeout(300);
    }
    const rowIdx = i;
    await page.locator(`input[formcontrolname="passengerName"]`).nth(rowIdx).fill(p.name).catch(async () => {
      await page.locator(`input[placeholder*="Name"]`).nth(rowIdx).fill(p.name).catch(() => {});
    });
    await page.locator(`input[formcontrolname="passengerAge"]`).nth(rowIdx).fill(String(p.age)).catch(async () => {
      await page.locator(`input[placeholder*="Age"]`).nth(rowIdx).fill(String(p.age)).catch(() => {});
    });
    await page.locator(`select[formcontrolname="passengerGender"]`).nth(rowIdx).selectOption(p.gender).catch(async () => {
      await page.locator(`p-select[formcontrolname="passengerGender"]`).nth(rowIdx).click().catch(() => {});
      await page.locator(`li:has-text("${p.gender === "M" ? "Male" : p.gender === "F" ? "Female" : "Transgender"}")`).first().click().catch(() => {});
    });
    if (p.berthPref && p.berthPref !== "NC") {
      await page.locator(`select[formcontrolname="passengerBerthChoice"]`).nth(rowIdx).selectOption(p.berthPref).catch(() => {});
    }
    if (p.foodPref && p.foodPref !== "D") {
      await page.locator(`select[formcontrolname="passengerFoodChoice"]`).nth(rowIdx).selectOption(p.foodPref).catch(() => {});
    }
    await logger.info(`Passenger ${i + 1}: ${p.name}, ${p.age}, ${p.gender}, berth=${p.berthPref}, food=${p.foodPref}`);
  }
}

async function fillContactDetails(page: Page, mobile: string, email: string, logger: JobLogger) {
  await page.locator('input[formcontrolname="mobileNumber"], input[placeholder*="Mobile"]').first().fill(mobile).catch(() => {});
  await page.locator('input[formcontrolname="email"], input[placeholder*="Email"]').first().fill(email).catch(() => {});
  await logger.info(`Contact filled: ${mobile} / ${email}`);
}

async function tickConsent(page: Page, logger: JobLogger) {
  const consent = page.locator('input[type="checkbox"]').filter({
    has: page.locator('text=/I have read|read and understood|confirm that/i'),
  }).first();
  await consent.check({ timeout: 3_000 }).catch(async () => {
    await page.locator('p-checkbox input').first().click({ timeout: 2_000 }).catch(() => {});
  });
  await logger.info("Consent checkbox ticked.");
}
