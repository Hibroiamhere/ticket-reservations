/**
 * POST /api/session/delete
 * Body: { sessionId: string }
 * Deletes a session record + its saved storageState file.
 */
import { NextResponse } from "next/server";
import { deleteSession } from "@/lib/agent/session";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const sessionId = body.sessionId;
  if (!sessionId) return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  await deleteSession(sessionId);
  return NextResponse.json({ ok: true });
}
