/**
 * POST /api/session/cancel
 * Body: { sessionId: string }
 * Closes the manual-login browser window without saving.
 */
import { NextResponse } from "next/server";
import { cancelLoginWindow } from "@/lib/agent/session";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const sessionId = body.sessionId;
  if (!sessionId) return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  await cancelLoginWindow(sessionId);
  return NextResponse.json({ ok: true });
}
