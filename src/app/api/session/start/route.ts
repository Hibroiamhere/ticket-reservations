/**
 * POST /api/session/start
 * Body: { sessionId: string }
 * Opens a VISIBLE Chromium window pointed at the IRCTC login page so the
 * user can log in manually (and solve the captcha themselves).
 *
 * NOTE: This requires a display. In a headless server environment this will
 * fail unless Xvfb or similar is running. The dashboard will show the error.
 */
import { NextResponse } from "next/server";
import { openLoginWindow } from "@/lib/agent/session";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const sessionId = body.sessionId;
  if (!sessionId) return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  const result = await openLoginWindow(sessionId);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, hint: "If you're on a headless server, you must run with Xvfb: `xvfb-run bun run dev` or set DISPLAY=:99." },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true });
}
