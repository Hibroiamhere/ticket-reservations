/**
 * POST /api/passengers/update
 * Body: { id, ...fields }
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const { id, ...rest } = body;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const data: Record<string, unknown> = {};
  for (const k of ["name", "age", "gender", "berthPref", "foodPref", "nationality", "isPrimary", "aadhaarLast4"]) {
    if (rest[k] !== undefined) data[k] = rest[k];
  }
  const passenger = await db.passenger.update({ where: { id: String(id) }, data });
  return NextResponse.json({ passenger });
}
