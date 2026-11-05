/** GET /api/session/master-list?sessionId=...
 * Fetch the saved Master List passengers from the user's IRCTC account
 * using their saved session, and persist them to the local address book.
 */
import { NextResponse } from "next/server";
import { fetchMasterList } from "@/lib/agent/master-list";
import { JobLogger } from "@/lib/agent/logger";
import { db } from "@/lib/db";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const sessionId = searchParams.get("sessionId");
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  }

  const logger = new JobLogger(`masterlist-${sessionId}`);
  const s = await db.session.findUnique({ where: { id: sessionId } });
  if (!s) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const result = await fetchMasterList(sessionId, s.storagePath, logger);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true, passengers: result.passengers });
}
