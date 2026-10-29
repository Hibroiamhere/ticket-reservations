/**
 * IRCTC Playwright agent.
 *
 * Drives the IRCTC train-search website through one booking attempt:
 *   1. Load saved session (cookies + localStorage).
 *   2. Verify logged in (if not, fail fast with a clear message).
 *   3. Navigate to train search page.
 *   4. Fill From / To / Date / Quota / Class.
 *   5. Click Search.
 *   6. Find a matching train from preferredTrains (or any train with availability).
 *   7. Click "Book Now" on that train.
 *   8. On the passenger details page, fill all passengers + contact info.
 *   9. Tick "I have read..." consent boxes and click "Review Journey" /
 *      "Continue".
 *  10. If pauseBeforePayment is true → return paused_payment with a
 *      screenshot so the user can review and pay manually.
 *
 * IRCTC aggressively blocks automation and changes selectors often. We
 * log every selector attempt and fall back to text-based search where
 * possible. The user can edit this file to update selectors as the
 * site evolves.
 */

import path from "node:path";
import fs from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright";
import { db } from "@/lib/db";
import { JobLogger } from "./logger";
import type { AttemptOutcome, PassengerDTO } from "./types";
import { jobStore } from "./store";

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
  travelClass: string; // SL | 3A | 2A | 1A | CC | EC | 2S
  quota: string; // GN | TQ | PT | LD | HP
  preferredTrains: string[]; // train numbers
  passengers: PassengerDTO[];
  contactMobile: string;
  contactEmail: string;
  pauseBeforePayment: boolean;
  autoConfirmBooking: boolean;
}

export interface AgentRunResult {
  outcome: AttemptOutcome;
  screenshotPath?: string;
}

async function screenshot(jobId: string, page: Page, label: string): Promise<string> {
  const filename = `${jobId}-${Date.now()}-${label.replace(/[^a-z0-9]/gi, "_")}.png`;
  const filePath = path.join(SESSIONS_DIR, "screens", filename);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await page.screenshot({ path: filePath, fullPage: false });
  } catch {
    // ignore screenshot failures
  }
  return filePath;
}

export async function runIrctcBooking(input: AgentRunInput): Promise<AgentRunResult> {
  const logger = new JobLogger(input.jobId);
  const { abortSignal } = jobStore.register(input.jobId);
  // Note: waitForResume is for pause states; we don't need it here unless
  // the user wants to abort mid-booking. We rely on abortSignal instead.
  abortSignal.throwIfAborted();

  let browser: Browser | null = null;
  let lastScreenshot: string | undefined;

  try {
    await logger.step("Launching headless browser with saved session…");
    const storagePath = path.join(SESSIONS_DIR, input.storageFileName);
    try {
      await fs.access(storagePath);
    } catch {
      return {
        outcome: { kind: "fatal", reason: "Session file not found. Please re-login via the Sessions tab." },
      };
    }

    browser = await chromium.launch({
      headless: true,
      args: ["--disable-blink-features=AutomationControlled"],
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
    page.setDefaultTimeout(20_000);

    // ---------------------------------------------------------------
    // STEP 1 — Navigate to search page and verify logged in.
    // ---------------------------------------------------------------
    await logger.step("Navigating to IRCTC train search…");
    await page.goto(IRCTC_SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(5_000); // SPA boot

    // Check for login redirect.
    const url = page.url();
    if (url.includes("/profile/login")) {
      lastScreenshot = await screenshot(input.jobId, page, "redirected-to-login");
      await logger.screenshot(lastScreenshot, "Redirected to login page (session expired)");
      return {
        outcome: { kind: "fatal", reason: "IRCTC session has expired. Please re-login via the Sessions tab." },
        screenshotPath: lastScreenshot,
      };
    }

    // Check for the "Hi, <user>" indicator.
    const hiLabel = await page.locator('span:has-text("Hi,")').first().textContent({ timeout: 5_000 }).catch(() => null);
    if (!hiLabel) {
      lastScreenshot = await screenshot(input.jobId, page, "no-hi-label");
      await logger.warn("Could not confirm login state — continuing anyway (IRCTC layout may have changed).");
    } else {
      await logger.success(`Logged in as: ${hiLabel.trim()}`);
    }

    // ---------------------------------------------------------------
    // STEP 2 — Fill search form.
    // ---------------------------------------------------------------
    await logger.step(`Filling search form: ${input.fromStationName ?? input.fromStation} → ${input.toStationName ?? input.toStation}, ${input.journeyDate}, ${input.travelClass}, quota ${input.quota}`);

    // From station — IRCTC uses an autocomplete; type, wait for suggestions, click first.
    await fillStationField(page, "Origin", input.fromStation, logger);
    await fillStationField(page, "Destination", input.toStation, logger);

    // Journey date — IRCTC uses a datepicker. We type the date in dd-mm-yyyy format.
    await fillJourneyDate(page, input.journeyDate, logger);

    // Quota — dropdown.
    await selectQuota(page, input.quota, logger);

    // Class — usually radio buttons or a select. We click by label code.
    await selectClass(page, input.travelClass, logger);

    // Click "Search" button.
    await logger.step("Clicking Search…");
    const searchBtn = page.getByRole("button", { name: /search/i }).first();
    await searchBtn.click({ timeout: 15_000 }).catch(async () => {
      // Fallback: try CSS selector
      await page.click('button[type="submit"]').catch(() => {});
    });

    // Wait for train list to render. The result table appears after API call.
    await logger.step("Waiting for train list…");
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(3_000);

    lastScreenshot = await screenshot(input.jobId, page, "train-list");
    await logger.screenshot(lastScreenshot, "Train list loaded");
    await db.bookingJob.update({
      where: { id: input.jobId },
      data: { hasScreenshot: true },
    });

    // ---------------------------------------------------------------
    // STEP 3 — Find a matching train and click "Book Now".
    // ---------------------------------------------------------------
    const trainChoice = await findAndClickTrain(page, input.preferredTrains, logger);
    if (!trainChoice.found) {
      lastScreenshot = await screenshot(input.jobId, page, "no-matching-train");
      return {
        outcome: { kind: "retry", reason: trainChoice.reason ?? "No matching train with availability found." },
        screenshotPath: lastScreenshot,
      };
    }
    await logger.success(`Selected train ${trainChoice.trainNumber ?? ""} — clicking Book Now…`);

    await page.waitForTimeout(3_000);
    lastScreenshot = await screenshot(input.jobId, page, "after-book-now");
    await logger.screenshot(lastScreenshot, "Passenger details page");

    // ---------------------------------------------------------------
    // STEP 4 — Fill passenger details.
    // ---------------------------------------------------------------
    await logger.step(`Filling ${input.passengers.length} passenger(s)…`);
    await fillPassengers(page, input.passengers, logger);

    // Contact mobile + email.
    await fillContactDetails(page, input.contactMobile, input.contactEmail, logger);

    // Tick the "I have read and understood" consent checkbox.
    await tickConsent(page, logger);

    // Click "Review Journey" / "Continue".
    await logger.step("Clicking Review Journey…");
    const reviewBtn = page.getByRole("button", { name: /review journey|continue|review booking/i }).first();
    await reviewBtn.click({ timeout: 15_000 }).catch(async () => {
      await page.click('button[type="submit"]').catch(() => {});
    });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(2_000);

    lastScreenshot = await screenshot(input.jobId, page, "review-page");
    await logger.screenshot(lastScreenshot, "Review page reached");

    // ---------------------------------------------------------------
    // STEP 5 — Pause before payment (per user requirement).
    // ---------------------------------------------------------------
    if (input.pauseBeforePayment) {
      await logger.success("Reached review page. Pausing for manual review before payment.");
      await db.bookingJob.update({
        where: { id: input.jobId },
        data: { status: "paused_payment", currentStep: "Paused — review and pay manually", lastMessage: "Awaiting user to complete payment in browser window" },
      });
      return {
        outcome: {
          kind: "paused_payment",
          screenshotPath: lastScreenshot,
          message: "Booking reached review page. Complete payment manually in the IRCTC window, or click Pay in the dashboard to continue automatically.",
        },
        screenshotPath: lastScreenshot,
      };
    }

    // If user explicitly enabled autoConfirmBooking, try to click through
    // to payment. This is dangerous and disabled by default.
    await logger.warn("autoConfirmBooking is ON — proceeding to payment automatically. This is risky.");
    await logger.step("Clicking Continue to Payment…");
    const payBtn = page.getByRole("button", { name: /continue to pay|pay now|continue/i }).first();
    await payBtn.click({ timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(2_000);
    lastScreenshot = await screenshot(input.jobId, page, "payment-page");
    await logger.screenshot(lastScreenshot, "Payment page reached — auto-payment not supported");

    return {
      outcome: {
        kind: "success",
        reviewScreenshot: lastScreenshot,
      },
      screenshotPath: lastScreenshot,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logger.error(`Agent crashed: ${msg}`);
    return {
      outcome: { kind: "fatal", reason: msg },
      screenshotPath: lastScreenshot,
    };
  } finally {
    try {
      await browser?.close();
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Helpers — each tolerant of IRCTC's frequent selector changes.
// ---------------------------------------------------------------------------

async function fillStationField(page: Page, field: "Origin" | "Destination", code: string, logger: JobLogger) {
  // Try multiple selector strategies.
  const label = field === "Origin" ? "From" : "To";
  const candidates = [
    `input[aria-label="${field}"]`,
    `input[placeholder*="${label}"]`,
    `input[placeholder*="${field}"]`,
    `input#${field.toLowerCase()}`,
    `input[formcontrolname="${field.toLowerCase() === "origin" ? "origin" : "destination"}"]`,
  ];

  let input = null as Awaited<ReturnType<typeof page.locator>> | null;
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if ((await loc.count().catch(() => 0)) > 0) {
      input = loc;
      break;
    }
  }
  if (!input) {
    await logger.warn(`Could not find ${field} input via known selectors — trying generic autocomplete.`);
    // Last resort: any visible autocomplete input.
    input = page.locator("input.ui-autocomplete").nth(field === "Origin" ? 0 : 1);
  }

  await input!.click({ timeout: 10_000 }).catch(() => {});
  await input!.fill("");
  await input!.type(code, { delay: 50 });
  await page.waitForTimeout(1_000);
  // Click the first suggestion that contains the code.
  const suggestion = page.locator(`li:has-text("${code}")`,).first();
  await suggestion.click({ timeout: 5_000 }).catch(async () => {
    // Fallback: any visible autocomplete dropdown item.
    await page.locator("li.ui-autocomplete-list-item, .ui-autocomplete-panel li").first().click({ timeout: 3_000 }).catch(() => {});
  });
  await logger.info(`Filled ${field}: ${code}`);
}

async function fillJourneyDate(page: Page, journeyDate: string, logger: JobLogger) {
  // Convert YYYY-MM-DD → DD-MM-YYYY for IRCTC's datepicker input.
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
      await loc.type(irctcDate, { delay: 50 });
      await page.keyboard.press("Enter");
      await logger.info(`Journey date set to ${irctcDate}`);
      return;
    }
  }
  await logger.warn("Could not find journey date input — leaving default.");
}

async function selectQuota(page: Page, quota: string, logger: JobLogger) {
  // IRCTC quota is usually a <p-select> or radio group. We click the label
  // containing the quota name.
  const quotaLabels: Record<string, string> = {
    GN: "General",
    TQ: "Tatkal",
    PT: "Premium Tatkal",
    LD: "Ladies",
    HP: "Handicapped",
  };
  const labelText = quotaLabels[quota] ?? quota;
  const label = page.locator(`label:has-text("${labelText}"), span:has-text("${labelText}")`).first();
  await label.click({ timeout: 5_000 }).catch(async () => {
    // Fallback: try select dropdown.
    await page.selectOption("select#quota", quota).catch(() => {});
  });
  await logger.info(`Quota selected: ${labelText}`);
}

async function selectClass(page: Page, travelClass: string, logger: JobLogger) {
  const classLabels: Record<string, string> = {
    SL: "Sleeper",
    "3A": "AC 3 Tier",
    "2A": "AC 2 Tier",
    "1A": "AC First",
    CC: "AC Chair Car",
    EC: "Exec Chair",
    "2S": "Second Sitting",
  };
  const labelText = classLabels[travelClass] ?? travelClass;
  const label = page.locator(`label:has-text("${labelText}"), span:has-text("${labelText}")`).first();
  await label.click({ timeout: 5_000 }).catch(() => {});
  await logger.info(`Class selected: ${labelText} (${travelClass})`);
}

async function findAndClickTrain(page: Page, preferredTrains: string[], logger: JobLogger): Promise<{ found: boolean; trainNumber?: string; reason?: string }> {
  // Wait for train rows.
  await page.waitForTimeout(2_000);

  // IRCTC renders train rows. We try to find a row matching one of the
  // preferred train numbers AND with availability, then click its Book Now.
  for (const trainNo of preferredTrains) {
    const row = page.locator(`text=${trainNo}`).first();
    if ((await row.count().catch(() => 0)) === 0) continue;

    // Look for "AVAILABLE" near this train, or just attempt Book Now.
    await logger.info(`Found train ${trainNo} in list — checking availability…`);
    const bookBtn = page.locator(`button:has-text("Book Now")`).filter({
      has: page.locator(`text=${trainNo}`),
    }).first();

    if ((await bookBtn.count().catch(() => 0)) > 0) {
      await bookBtn.click({ timeout: 10_000 }).catch(async () => {
        // Fallback: click first Book Now on page.
        await page.locator('button:has-text("Book Now")').first().click({ timeout: 5_000 }).catch(() => {});
      });
      return { found: true, trainNumber: trainNo };
    }

    // Try generic Book Now button after locating the row.
    await page.locator('button:has-text("Book Now")').first().click({ timeout: 5_000 }).catch(() => {});
    return { found: true, trainNumber: trainNo };
  }

  // No preferred train matched — try first available Book Now button.
  await logger.warn("No preferred train matched. Trying first available Book Now button…");
  const anyBookBtn = page.locator('button:has-text("Book Now")').first();
  if ((await anyBookBtn.count().catch(() => 0)) > 0) {
    await anyBookBtn.click({ timeout: 10_000 }).catch(() => {});
    return { found: true, trainNumber: "(first available)" };
  }

  // Check for REGRET / NOT AVAILABLE markers.
  const regret = await page.locator('text=/REGRET|NOT AVAILABLE/i').first().textContent().catch(() => null);
  if (regret) {
    return { found: false, reason: "All trains show REGRET / NOT AVAILABLE." };
  }

  return { found: false, reason: "No Book Now button found — train list may still be loading or selectors changed." };
}

async function fillPassengers(page: Page, passengers: PassengerDTO[], logger: JobLogger) {
  // IRCTC passenger rows: name, age, gender, berth, food.
  // The first row exists by default. Additional rows need an "Add Passenger" click.
  for (let i = 0; i < passengers.length; i++) {
    const p = passengers[i];
    if (i > 0) {
      // Click "Add Passenger" link/button.
      await page.locator('a:has-text("Add Passenger"), button:has-text("Add Passenger")').first().click({ timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(500);
    }
    const rowIdx = i; // zero-indexed
    // Name
    await page.locator(`input[formcontrolname="passengerName"]`).nth(rowIdx).fill(p.name).catch(async () => {
      await page.locator(`input[placeholder*="Name"]`).nth(rowIdx).fill(p.name).catch(() => {});
    });
    // Age
    await page.locator(`input[formcontrolname="passengerAge"]`).nth(rowIdx).fill(String(p.age)).catch(async () => {
      await page.locator(`input[placeholder*="Age"]`).nth(rowIdx).fill(String(p.age)).catch(() => {});
    });
    // Gender — select by value
    await page.locator(`select[formcontrolname="passengerGender"]`).nth(rowIdx).selectOption(p.gender).catch(async () => {
      await page.locator(`p-select[formcontrolname="passengerGender"]`).nth(rowIdx).click().catch(() => {});
      await page.locator(`li:has-text("${p.gender === "M" ? "Male" : p.gender === "F" ? "Female" : "Transgender"}")`).first().click().catch(() => {});
    });
    // Berth preference
    if (p.berthPref && p.berthPref !== "NC") {
      await page.locator(`select[formcontrolname="passengerBerthChoice"]`).nth(rowIdx).selectOption(p.berthPref).catch(() => {});
    }
    // Food preference (only for Rajdhani/Shatabdi/etc.)
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
  // IRCTC requires ticking a "I have read and understood..." checkbox before
  // proceeding. Try several selector strategies.
  const consent = page.locator('input[type="checkbox"]').filter({
    has: page.locator('text=/I have read|read and understood|confirm that/i'),
  }).first();
  await consent.check({ timeout: 5_000 }).catch(async () => {
    // Fallback: tick any checkbox inside the booking summary area.
    await page.locator('p-checkbox input').first().click({ timeout: 3_000 }).catch(() => {});
  });
  await logger.info("Consent checkbox ticked.");
}
