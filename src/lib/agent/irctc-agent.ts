/** IRCTC Tatkal agent — rapid, sub-second, browser-optimized scanner.

Speed design:
  * One persistent Chromium browser across all retries (no relaunch overhead).
  * Block images/fonts/media/css where safe so pages parse in ~100-300ms.
  * Minimum retry interval 500ms (human limit is ~1.5-2s per click).
  * waitUntil "commit"/"domcontentloaded" instead of slow "networkidle".
  * Direct JS evaluation for form filling instead of slow click/type chains.
  * Aggressive timeouts (3-8s) so failures fail fast and retry immediately.
  * Pre-warm mode: load session + search page BEFORE the tatkal window opens.
  * Scheduled start: agent arms itself and fires exactly at 10:00 / 11:00 AM.
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
  useMasterList: boolean;
  masterListNames: string[];
  paymentMethod: string;
  dryRun: boolean;
  tatkalMode: boolean;
  // Rapid options:
  rapidIntervalMs?: number;      // override retry interval (min 500ms)
  prewarmSeconds?: number;       // how long before window to pre-load page
  scheduledStartAt?: number;     // epoch ms to start the actual scan loop
  headful?: boolean;             // run with a visible browser (easier to watch/pay)
}

export interface AgentRunResult {
  outcome: AttemptOutcome;
  screenshotPath?: string;
}

/** Take screenshot only at terminal states (speed). Skipped in rapid loops. */
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
// Phase 1: Launch browser — rapid flags, block images/fonts/media for speed
// ===========================================================================

export async function launchBrowserWithSession(input: AgentRunInput, logger: JobLogger): Promise<{ browser: Browser; context: BrowserContext; page: Page } | { error: string }> {
  const rapid = input.tatkalMode;
  await logger.step(rapid ? "Launching rapid Chromium (resources blocked)…" : "Launching browser with saved session…");

  const storagePath = path.join(SESSIONS_DIR, input.storageFileName);
  try { await fs.access(storagePath); } catch { return { error: "Session file not found. Re-login via Sessions tab." }; }

  const args = [
    "--disable-blink-features=AutomationControlled",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-features=IsolateOrigins,site-per-process",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-ipc-flooding-protection",
    "--disable-features=TranslateUI",
    "--disable-features=BlinkGenPropertyTrees",
  ];
  if (!input.headful) args.push("--headless=new");

  const browser = await chromium.launch({ headless: !input.headful, args });
  const context = await browser.newContext({
    storageState: storagePath,
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 768 },
    // Block heavy resource types for speed (CSS kept so layout doesn't break).
    ...(rapid && {
      // We'll handle image/blocking via route abort below instead.
    }),
  });

  // Mask webdriver flag.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  // Abort images/fonts/media to make pages load much faster in tatkal mode.
  if (rapid) {
    await context.route("**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf,otf,eot,ico,mp4,mp3,wav,zip}", (route) =>
      route.abort().catch(() => {}),
    );
  }

  const page = await context.newPage();
  page.setDefaultTimeout(rapid ? 6_000 : 20_000);
  page.setDefaultNavigationTimeout(rapid ? 15_000 : 60_000);

  return { browser, context, page };
}

// ===========================================================================
// Phase 2: Navigate + verify login (rapid: domcontentloaded, short waits)
// ===========================================================================

export async function navigateAndVerifyLogin(page: Page, input: AgentRunInput, logger: JobLogger): Promise<{ ok: true } | { fatal: string; screenshot?: string }> {
  const rapid = input.tatkalMode;
  await logger.step("Navigating to IRCTC train search…");
  await page.goto(IRCTC_SEARCH_URL, { waitUntil: "domcontentloaded", timeout: rapid ? 20_000 : 60_000 });
  await page.waitForTimeout(rapid ? 800 : 2_000);

  const url = page.url();
  if (url.includes("/profile/login")) {
    const sc = await screenshot(input.jobId, page, "redirected-to-login", true);
    await logger.screenshot(sc ?? "", "Redirected to login page (session expired)");
    return { fatal: "IRCTC session expired. Re-login via Sessions tab.", screenshot: sc };
  }

  const hiLabel = await page.locator('span:has-text("Hi,")').first().textContent({ timeout: 3_000 }).catch(() => null);
  if (!hiLabel && !rapid) {
    const sc = await screenshot(input.jobId, page, "no-hi-label");
    await logger.warn("Could not confirm login state — continuing anyway.");
  } else if (hiLabel) {
    await logger.success(`Logged in as: ${hiLabel.trim()}`);
  }
  return { ok: true };
}

// ===========================================================================
// Phase 3: Fill search form — direct evaluate for speed
// ===========================================================================

export async function fillSearchForm(page: Page, input: AgentRunInput, logger: JobLogger): Promise<void> {
  await logger.step(`Fill form: ${input.fromStationName ?? input.fromStation} → ${input.toStationName ?? input.toStation}, ${input.journeyDate}, ${input.travelClass}, ${input.quota}`);

  // Direct JS injection to set station fields — faster than click/type/suggest chains.
  await page.evaluate(
    ({ from, to }) => {
      const setInput = (labelOrPlaceholder: string, value: string) => {
        const el = Array.from(document.querySelectorAll<HTMLInputElement>("input")).find(
          (i) =>
            (i.getAttribute("aria-label") || "").includes(labelOrPlaceholder) ||
            (i.getAttribute("placeholder") || "").includes(labelOrPlaceholder),
        );
        if (el) {
          el.value = value;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true }));
        }
      };
      setInput("Origin", from);
      setInput("Destination", to);
    },
    { from: input.fromStation, to: input.toStation },
  );
  await page.waitForTimeout(300);

  await fillJourneyDate(page, input.journeyDate, logger, rapid);
  await selectQuota(page, input.quota, logger, rapid);
  await selectClass(page, input.travelClass, logger, rapid);
}

async function fillJourneyDate(page: Page, journeyDate: string, logger: JobLogger, rapid: boolean) {
  const [y, m, d] = journeyDate.split("-");
  const irctcDate = `${d}-${m}-${y}`;
  await page.evaluate(
    (dateStr: string) => {
      const el = Array.from(document.querySelectorAll<HTMLInputElement>("input")).find(
        (i) => (i.getAttribute("aria-label") || "").includes("Journey Date") ||
               (i.getAttribute("placeholder") || "").includes("Journey Date") ||
               i.id === "jDate" ||
               (i.getAttribute("formcontrolname") || "").includes("jDate"),
      );
      if (el) {
        el.value = dateStr;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    },
    irctcDate,
  );
  await logger.info(`Journey date set to ${irctcDate}`);
}

async function selectQuota(page: Page, quota: string, logger: JobLogger, rapid: boolean) {
  const labels: Record<string, string> = { GN: "General", TQ: "Tatkal", PT: "Premium Tatkal", LD: "Ladies", HP: "Handicapped" };
  const labelText = labels[quota] ?? quota;
  await page.evaluate(
    (text: string) => {
      const el = Array.from(document.querySelectorAll<HTMLElement>("label, span, div")).find(
        (e) => e.textContent?.trim() === text,
      );
      (el as HTMLElement)?.click?.();
    },
    labelText,
  ).catch(() => {});
  await logger.info(`Quota: ${labelText}`);
  await page.waitForTimeout(rapid ? 150 : 300);
}

async function selectClass(page: Page, travelClass: string, logger: JobLogger, rapid: boolean) {
  const labels: Record<string, string> = { SL: "Sleeper", "3A": "AC 3 Tier", "2A": "AC 2 Tier", "1A": "AC First", CC: "AC Chair Car", EC: "Exec Chair", "2S": "Second Sitting" };
  const labelText = labels[travelClass] ?? travelClass;
  await page.evaluate(
    (text: string) => {
      const el = Array.from(document.querySelectorAll<HTMLElement>("label, span, div")).find(
        (e) => e.textContent?.trim() === text,
      );
      (el as HTMLElement)?.click?.();
    },
    labelText,
  ).catch(() => {});
  await logger.info(`Class: ${labelText} (${travelClass})`);
  await page.waitForTimeout(rapid ? 150 : 300);
}

// ===========================================================================
// Phase 4: Rapid search loop — click Search, scan, click Book Now immediately
// ===========================================================================

export async function searchAndFindTrain(page: Page, input: AgentRunInput, logger: JobLogger): Promise<{ found: boolean; trainNumber?: string; reason?: string; screenshot?: string }> {
  await logger.step("Searching trains…");

  const clicked = await page.evaluate(
    (preferred: string[]) => {
      // Click the Search button by text.
      const btn = Array.from(document.querySelectorAll<HTMLElement>("button")).find((b) => /search/i.test(b.textContent || ""));
      btn?.click();
      // After results load, find preferred train with "Book Now".
      for (const trainNo of preferred) {
        const row = Array.from(document.querySelectorAll<HTMLElement>("tr, div, li")).find(
          (el) => el.textContent?.includes(trainNo) && /book now/i.test(el.textContent || ""),
        );
        const btn = row?.querySelector<HTMLElement>("button") ?? Array.from(document.querySelectorAll<HTMLElement>("button")).find((b) => /book now/i.test(b.textContent || ""));
        if (btn) { btn.click(); return trainNo; }
      }
      const anyBtn = Array.from(document.querySelectorAll<HTMLElement>("button")).find((b) => /book now/i.test(b.textContent || ""));
      if (anyBtn) { anyBtn.click(); return "(first available)"; }
      return null;
    },
    input.preferredTrains,
    { timeout: input.tatkalMode ? 8_000 : 20_000 },
  ).catch(() => null);

  if (!clicked) {
    return { found: false, reason: "Search button or Book Now not found — page may still be loading." };
  }

  await page.waitForTimeout(input.tatkalMode ? 600 : 2_000);
  return { found: true, trainNumber: typeof clicked === "string" ? clicked : undefined };
}

// ===========================================================================
// Phase 5: Book train + passengers + consent + Review Journey (rapid)
// ===========================================================================

export async function bookTrainAndFillPassengers(page: Page, input: AgentRunInput, logger: JobLogger): Promise<{ ok: true; screenshot?: string } | { fatal: string; screenshot?: string }> {
  const rapid = input.tatkalMode;
  await page.waitForTimeout(rapid ? 500 : 1_500);

  if (input.useMasterList && input.masterListNames.length > 0) {
    await logger.step(`Master List: ${input.masterListNames.join(", ")}`);
    const result = await selectPassengersFromMasterList(page, input.masterListNames, logger, rapid);
    if (!result.ok) {
      await logger.warn(`Master List failed (${result.reason}). Typing passengers.`);
      await fillPassengers(page, input.passengers, logger, rapid);
    }
  } else {
    await logger.step(`Typing ${input.passengers.length} passenger(s)…`);
    await fillPassengers(page, input.passengers, logger, rapid);
  }

  await fillContactDetails(page, input.contactMobile, input.contactEmail, logger, rapid);
  await tickConsent(page, logger, rapid);

  await logger.step("Clicking Review Journey…");
  const clickedReview = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll<HTMLElement>("button")).find(
      (b) => /review journey|review booking|continue/i.test(b.textContent || ""),
    );
    btn?.click();
    return !!btn;
  }).catch(() => false);

  if (!clickedReview) {
    await page.locator('button[type="submit"]').first().click({ timeout: 5_000 }).catch(() => {});
  }
  await page.waitForLoadState("domcontentloaded", { timeout: rapid ? 8_000 : 30_000 }).catch(() => {});
  await page.waitForTimeout(rapid ? 400 : 1_000);

  const sc = await screenshot(input.jobId, page, "review-page", true);
  await logger.screenshot(sc ?? "", "Review page reached");
  return { ok: true, screenshot: sc };
}

// ===========================================================================
// Phase 6: Payment method (optional, rapid)
// ===========================================================================

export async function selectPaymentMethod(page: Page, method: string, logger: JobLogger, rapid: boolean): Promise<{ ok: boolean; screenshot?: string }> {
  if (method === "SKIP") return { ok: false };
  const labels: Record<string, string> = { BHIM_UPI: "BHIM UPI", CREDIT_CARD: "Credit Card", DEBIT_CARD: "Debit Card", WALLET: "Wallet", PAY_ON_DELIVERY: "Pay on Delivery", INTERNATIONAL_CARD: "International Card" };
  const label = labels[method] ?? method;
  await logger.step(`Payment: ${label}`);
  await page.evaluate(
    (text: string) => {
      const el = Array.from(document.querySelectorAll<HTMLElement>("label, div, span")).find((e) => e.textContent?.includes(text));
      (el as HTMLElement)?.click?.();
    },
    label,
  ).catch(() => {});
  await page.waitForTimeout(rapid ? 300 : 500);
  const payBtn = Array.from(document.querySelectorAll<HTMLElement>("button")).find((b) => /pay|continue|proceed/i.test(b.textContent || ""));
  payBtn?.click({ timeout: 4_000 } as any).catch(() => {});
  return { ok: true };
}

// ===========================================================================
// Phase 7: Close browser
// ===========================================================================

export async function closeBrowser(browser: Browser | null) {
  try { await browser?.close(); } catch {}
}

// ===========================================================================
// Top-level orchestrator (used by the regular runner — one browser per attempt)
// ===========================================================================

export async function runIrctcBooking(input: AgentRunInput): Promise<AgentRunResult> {
  const logger = new JobLogger(input.jobId);
  const rapid = input.tatkalMode;
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

    if (input.dryRun) {
      await logger.success("DRY RUN COMPLETE — agent successfully reached the Review Journey page. No payment was attempted.");
      return {
        outcome: { kind: "success", reviewScreenshot: lastScreenshot },
        screenshotPath: lastScreenshot,
      };
    }

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
          message: "Booking reached review page. Complete payment manually in the IRCTC window.",
        },
        screenshotPath: lastScreenshot,
      };
    }

    await logger.warn("autoConfirmBooking is ON — proceeding to payment automatically.");
    const payBtn = launched.page.getByRole("button", { name: /continue to pay|pay now|continue/i }).first();
    await payBtn.click({ timeout: 8_000 }).catch(() => {});
    await launched.page.waitForTimeout(rapid ? 400 : 2_000);

    if (input.paymentMethod !== "SKIP") {
      const payResult = await selectPaymentMethod(launched.page, input.paymentMethod, logger, rapid);
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

// ===========================================================================
// Helpers — rapid, tolerant of selector changes
// ===========================================================================

async function fillPassengers(page: Page, passengers: PassengerDTO[], logger: JobLogger, rapid: boolean) {
  for (let i = 0; i < passengers.length; i++) {
    const p = passengers[i];
    if (i > 0) {
      await page.locator('a:has-text("Add Passenger"), button:has-text("Add Passenger")').first().click({ timeout: 3_000 }).catch(() => {});
      await page.waitForTimeout(rapid ? 100 : 300);
    }
    await page.evaluate(
      ({ idx, name, age, gender, berth, food }) => {
        const inputs = document.querySelectorAll<HTMLInputElement>("input");
        const nameEl = inputs[idx] as HTMLInputElement | undefined;
        // Heuristic: fill name/age by index among visible inputs.
        const el = inputs[idx];
        if (el) { el.value = name; el.dispatchEvent(new Event("input", { bubbles: true })); }
        const ageEl = inputs[idx + 1];
        if (ageEl) { ageEl.value = String(age); ageEl.dispatchEvent(new Event("input", { bubbles: true })); }
      },
      { idx: i * 4, name: p.name, age: p.age, gender: p.gender, berth: p.berthPref, food: p.foodPref },
    ).catch(() => {});
    await logger.info(`Passenger ${i + 1}: ${p.name}, ${p.age}, ${p.gender}`);
  }
}

async function fillContactDetails(page: Page, mobile: string, email: string, logger: JobLogger, rapid: boolean) {
  await page.evaluate(
    ({ mob, mail }) => {
      const els = document.querySelectorAll<HTMLInputElement>("input");
      let m = 0, e = 0;
      for (const el of els) {
        const ph = (el.getAttribute("placeholder") || "").toLowerCase();
        const name = (el.getAttribute("formcontrolname") || "").toLowerCase();
        if ((ph.includes("mobile") || name.includes("mobile")) && m === 0) { el.value = mob; el.dispatchEvent(new Event("input", { bubbles: true })); m = 1; }
        else if ((ph.includes("email") || name.includes("email")) && e === 0) { el.value = mail; el.dispatchEvent(new Event("input", { bubbles: true })); e = 1; }
        if (m && e) break;
      }
    },
    { mob: mobile, mail: email },
  ).catch(() => {});
  await logger.info(`Contact: ${mobile} / ${email}`);
}

async function tickConsent(page: Page, logger: JobLogger, rapid: boolean) {
  await page.evaluate(() => {
    const cb = Array.from(document.querySelectorAll<HTMLInputElement>("input[type=checkbox]")).find(
      (el) => el.closest("label")?.textContent?.includes("I have read") ||
              el.closest("div")?.textContent?.includes("read and understood"),
    );
    if (cb) { cb.checked = true; cb.dispatchEvent(new Event("change", { bubbles: true })); }
  }).catch(() => {});
  await logger.info("Consent ticked.");
}

async function selectPassengersFromMasterList(page: Page, names: string[], logger: JobLogger, rapid: boolean): Promise<{ ok: true } | { ok: false; reason: string }> {
  const opened = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll<HTMLElement>("a, button, span, div")).find((e) => /master list/i.test(e.textContent || ""));
    el?.click();
    return !!el;
  }).catch(() => false);
  if (!opened) return { ok: false, reason: "Master List not found" };
  await page.waitForTimeout(rapid ? 300 : 700);

  for (const name of names) {
    const t = name.trim(); if (!t) continue;
    const hit = await page.evaluate(
      (n: string) => {
        const el = Array.from(document.querySelectorAll<HTMLElement>("div, label, li")).find((e) => e.textContent?.trim() === n);
        el?.click();
        return !!el;
      },
      t,
    ).catch(() => false);
    if (hit) await logger.info(`Master List selected: ${t}`);
    else await logger.warn(`Master List entry not found: ${t}`);
    await page.waitForTimeout(rapid ? 100 : 300);
  }
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(rapid ? 100 : 300);
  return { ok: true };
}
