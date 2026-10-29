/**
 * POST /api/passengers/delete
 * Body: { id }
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const id = body.id;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await db.passenger.delete({ where: { id: String(id) } });
  return NextResponse.json({ ok: true });
}
