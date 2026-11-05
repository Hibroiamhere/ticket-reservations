/**
 * Master List fetcher.
 *
 * After the user logs into IRCTC manually in a visible browser and saves
 * their session, this module can launch a browser with that saved session,
 * navigate to IRCTC's Master List page, and scrape the saved passenger names
 * so the user can pick from them when booking — exactly like the IRCTC app
 * shows their saved passengers.
 *
 * We never store the IRCTC password — only the session cookies, and we only
 * read the passenger list that the user already saved in their own account.
 */

import path from "node:path";
import fs from "node:fs/promises";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { db } from "@/lib/db";
import { JobLogger } from "./logger";

const SESSIONS_DIR = "/home/z/my-project/.sessions";
const IRCTC_MASTER_LIST_URL =
  "https://www.irctc.co.in/nget/master-list";

export interface MasterListPassenger {
  name: string;
  age?: number;
  gender?: "M" | "F" | "T";
  berthPref?: string;
  aadhaarLast4?: string | null;
}

/** Fetch the saved master-list passengers from the user's IRCTC account. */
export async function fetchMasterList(
  sessionId: string,
  storageFileName: string,
  logger: JobLogger,
): Promise<{ ok: true; passengers: MasterListPassenger[] } | { ok: false; error: string }> {
  const storagePath = path.join(SESSIONS_DIR, storageFileName);
  try { await fs.access(storagePath); } catch {
    return { ok: false, error: "Session file not found. Re-login and save first." };
  }

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    await logger.step("Opening browser to read your IRCTC Master List…");
    browser = await chromium.launch({
      headless: false, // visible so the user can see what's being read
      args: ["--start-maximized"],
    });
    context = await browser.newContext({
      storageState: storagePath,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
      viewport: null,
    });
    // Mask automation flag.
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    page = await context.newPage();
    page.setDefaultTimeout(20_000);

    await logger.step("Navigating to IRCTC Master List page…");
    await page.goto(IRCTC_MASTER_LIST_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(3_000);

    const url = page.url();
    if (url.includes("/profile/login")) {
      return {
        ok: false,
        error: "Session expired — you're redirected to login. Re-save your session first.",
      };
    }

    const passengers = await scrapeMasterList(page, logger);
    await logger.success(`Found ${passengers.length} passenger(s) in your IRCTC Master List.`);

    // Persist fetched passengers to our DB so they're selectable at booking time.
    let saved = 0;
    for (const p of passengers) {
      try {
        await db.passenger.create({
          data: {
            name: p.name,
            age: p.age ?? 0,
            gender: p.gender ?? "M",
            berthPref: p.berthPref ?? "NC",
            foodPref: "D",
            nationality: "India",
            isPrimary: saved === 0, // first one is primary
            aadhaarLast4: p.aadhaarLast4 ?? null,
          },
        });
        saved += 1;
      } catch {
        // skip duplicates / errors
      }
    }
    await logger.info(`Saved ${saved} new passenger(s) to your address book.`);

    return { ok: true, passengers };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logger.error(`Master List fetch failed: ${msg}`);
    return { ok: false, error: msg };
  } finally {
    try { await page?.close(); } catch {}
    try { await context?.close(); } catch {}
    try { await browser?.close(); } catch {}
  }
}

/**
 * Scrape passenger entries from the Master List page.
 * IRCTC changes selectors often, so we try several strategies and fall back
 * to generic text scanning.
 */
async function scrapeMasterList(page: Page, logger: JobLogger): Promise<MasterListPassenger[]> {
  // Strategy 1: look for common master-list containers / rows.
  const selectors = [
    ".master-list-passenger",
    ".passenger-row",
    ".masterListPassenger",
    "li.passenger",
    "tr.passenger",
    "[class*='masterList'] div",
    "[class*='passengerList'] div",
  ];

  let nodes: Array<{ text: string; el: any }> = [];

  for (const sel of selectors) {
    try {
      const els = await page.locator(sel).all();
      for (const el of els) {
        const text = (await el.textContent()).trim();
        if (text && text.length > 2) {
          nodes.push({ text, el });
        }
      }
      if (nodes.length > 0) break;
    } catch {}
  }

  // Strategy 2: generic — scan all divs/spans that look like names.
  if (nodes.length === 0) {
    const allText = await page.locator("div, span, li").all();
    for (const el of allText) {
      const text = (await el.textContent()).trim();
      // A passenger name is usually 2-4 words, all caps or title case, no digits.
      if (/^[A-Za-z][A-Za-z .]{2,40}$/.test(text) && !/\d/.test(text)) {
        nodes.push({ text, el });
      }
      if (nodes.length >= 12) break; // cap
    }
  }

  const passengers: MasterListPassenger[] = [];
  const seen = new Set<string>();

  for (const n of nodes) {
    const name = n.text.replace(/\s+/g, " ").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    passengers.push({ name });
    if (passengers.length >= 10) break; // IRCTC master list cap is usually 9-10
  }

  await logger.info(`Scraped ${passengers.length} master-list entry(ies).`);
  return passengers;
}
