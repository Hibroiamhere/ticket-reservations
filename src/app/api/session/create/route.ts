/**
 * POST /api/session/create
 * Body: { label: string }
 * Creates a new session record. The user then calls /api/session/start to
 * open the IRCTC login window.
 */
import { NextResponse } from "next/server";
import { createSession } from "@/lib/agent/session";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const label = (body.label ?? "IRCTC session").toString().trim() || "IRCTC session";
  const session = await createSession(label);
  return NextResponse.json({ session });
}
