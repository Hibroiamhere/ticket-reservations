/**
 * POST /api/session/save
 * Body: { sessionId: string }
 * Called after the user has logged in manually in the window opened by
 * /api/session/start. Persists the storage state (cookies + localStorage).
 */
import { NextResponse } from "next/server";
import { saveLoginSession } from "@/lib/agent/session";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const sessionId = body.sessionId;
  if (!sessionId) return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  const result = await saveLoginSession(sessionId);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true, loggedInAs: result.loggedInAs });
}
