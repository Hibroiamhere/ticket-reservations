/**
 * POST /api/session/verify
 * Body: { sessionId: string }
 * Opens a headless browser with the saved session and checks whether IRCTC
 * still considers the user logged in. Updates lastVerifiedAt + loggedInAs.
 */
import { NextResponse } from "next/server";
import { verifySession } from "@/lib/agent/session";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const sessionId = body.sessionId;
  if (!sessionId) return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  const result = await verifySession(sessionId);
  return NextResponse.json(result);
}
