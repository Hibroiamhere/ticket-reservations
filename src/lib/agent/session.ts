/**
 * Session manager.
 *
 * A "session" = a saved Playwright storageState (cookies + localStorage) for
 * an IRCTC account. The user creates one by:
 *   1. Clicking "Open IRCTC Login" in the dashboard.
 *   2. A real, visible Chromium window opens to the IRCTC login page.
 *   3. The user solves the captcha and logs in normally.
 *   4. The user clicks "I'm logged in — Save session" in our dashboard.
 *   5. We read storageState from that browser context and persist it.
 *
 * We never see or store the IRCTC password — only the resulting session.
 */

import path from "node:path";
import fs from "node:fs/promises";
import { chromium } from "playwright";
import { db } from "@/lib/db";

const SESSIONS_DIR = "/home/z/my-project/.sessions";
const IRCTC_LOGIN_URL = "https://www.irctc.co.in/nget/profile/login";
const IRCTC_DASHBOARD_URL = "https://www.irctc.co.in/nget/train-search";

/** Track the user-initiated login browser context (only one at a time). */
interface LiveLogin {
  browser: import("playwright").Browser;
  context: import("playwright").BrowserContext;
  page: import("playwright").Page;
  sessionId: string;
  startedAt: number;
}

const liveLogins = new Map<string, LiveLogin>();

export async function ensureSessionsDir() {
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
  await fs.mkdir(path.join(SESSIONS_DIR, "screens"), { recursive: true });
}

/** Open a visible browser window so the user can log in manually. */
export async function openLoginWindow(sessionId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  await ensureSessionsDir();
  // Close any existing window for this session.
  await closeLoginWindow(sessionId);

  try {
    const browser = await chromium.launch({
      headless: false, // must be visible so the user can interact
      args: ["--start-maximized"],
    });
    const context = await browser.newContext({
      viewport: null, // use the actual window size
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();
    await page.goto(IRCTC_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

    liveLogins.set(sessionId, {
      browser,
      context,
      page,
      sessionId,
      startedAt: Date.now(),
    });

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Save the current storage state from the live login window.
 * Called when the user clicks "I'm logged in — Save session".
 */
export async function saveLoginSession(sessionId: string): Promise<{ ok: true; loggedInAs?: string } | { ok: false; error: string }> {
  const live = liveLogins.get(sessionId);
  if (!live) {
    return { ok: false, error: "No active login window. Click 'Open IRCTC Login' first." };
  }
  try {
    // Check if logged in: IRCTC dashboard shows a "Hi, <name>" element after login.
    const loggedInAs = await tryDetectLoggedInUser(live.page);

    const storagePath = path.join(SESSIONS_DIR, `${sessionId}.json`);
    await live.context.storageState({ path: storagePath });

    await db.session.update({
      where: { id: sessionId },
      data: {
        isActive: true,
        lastVerifiedAt: new Date(),
        loggedInAs: loggedInAs ?? null,
      },
    });

    // Close the browser window — we have what we need.
    await closeLoginWindow(sessionId);

    return { ok: true, loggedInAs: loggedInAs ?? undefined };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Cancel an in-progress login window without saving. */
export async function cancelLoginWindow(sessionId: string) {
  await closeLoginWindow(sessionId);
}

async function closeLoginWindow(sessionId: string) {
  const live = liveLogins.get(sessionId);
  if (!live) return;
  liveLogins.delete(sessionId);
  try {
    await live.context.close();
  } catch {}
  try {
    await live.browser.close();
  } catch {}
}

/** Try to read the username shown on the IRCTC dashboard. */
async function tryDetectLoggedInUser(page: import("playwright").Page): Promise<string | null> {
  try {
    // IRCTC shows a "Hi, <username>" label after login.
    const el = await page.locator('span:has-text("Hi,")').first({ timeout: 5_000 }).catch(() => null);
    if (el) {
      const text = await el.textContent();
      if (text) return text.replace(/^Hi,?\s*/i, "").trim();
    }
  } catch {}
  return null;
}

/** Verify a saved session is still logged in (used before booking). */
export async function verifySession(sessionId: string): Promise<{ loggedIn: boolean; loggedInAs?: string; screenshotPath?: string }> {
  const session = await db.session.findUnique({ where: { id: sessionId } });
  if (!session) return { loggedIn: false };

  const storagePath = path.join(SESSIONS_DIR, session.storagePath);
  let storageExists = false;
  try {
    await fs.access(storagePath);
    storageExists = true;
  } catch {
    storageExists = false;
  }
  if (!storageExists) {
    await db.session.update({
      where: { id: sessionId },
      data: { lastVerifiedAt: new Date(), loggedInAs: null },
    });
    return { loggedIn: false };
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      storageState: storagePath,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();
    await page.goto(IRCTC_DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    // Give SPA time to render.
    await page.waitForTimeout(5_000);

    const loggedInAs = await tryDetectLoggedInUser(page);
    const loggedIn = !!loggedInAs;

    const screenshotPath = path.join(SESSIONS_DIR, "screens", `verify-${sessionId}-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false });

    await db.session.update({
      where: { id: sessionId },
      data: { lastVerifiedAt: new Date(), loggedInAs: loggedInAs ?? null },
    });

    return { loggedIn, loggedInAs: loggedInAs ?? undefined, screenshotPath };
  } finally {
    try {
      await browser?.close();
    } catch {}
  }
}

export function getStoragePath(sessionId: string, storageFileName: string): string {
  return path.join(SESSIONS_DIR, storageFileName);
}

export async function listSessions() {
  return db.session.findMany({ orderBy: { createdAt: "desc" } });
}

export async function createSession(label: string) {
  const id = (await import("crypto")).randomUUID();
  const storageFileName = `${id}.json`;
  const session = await db.session.create({
    data: {
      id,
      label,
      storagePath: storageFileName,
      isActive: false, // not active until user logs in
    },
  });
  return session;
}

export async function deleteSession(sessionId: string) {
  const session = await db.session.findUnique({ where: { id: sessionId } });
  if (!session) return;
  await closeLoginWindow(sessionId);
  try {
    await fs.unlink(path.join(SESSIONS_DIR, session.storagePath));
  } catch {}
  await db.session.delete({ where: { id: sessionId } });
}
