/**
 * GET /api/session/list
 * List all saved IRCTC sessions.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import type { SessionDTO } from "@/lib/agent/types";

export async function GET() {
  const sessions = await db.session.findMany({ orderBy: { createdAt: "desc" } });
  const dtos: SessionDTO[] = sessions.map((s) => ({
    id: s.id,
    label: s.label,
    isActive: s.isActive,
    loggedInAs: s.loggedInAs ?? null,
    lastVerifiedAt: s.lastVerifiedAt ? s.lastVerifiedAt.toISOString() : null,
    createdAt: s.createdAt.toISOString(),
  }));
  return NextResponse.json({ sessions: dtos });
}
