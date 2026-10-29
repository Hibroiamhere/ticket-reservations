/**
 * POST /api/passengers/create
 * Body: PassengerDTO (without id)
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const { name, age, gender, berthPref, foodPref, nationality, isPrimary, aadhaarLast4 } = body;
  if (!name || typeof age !== "number" || !gender) {
    return NextResponse.json({ error: "name, age, gender are required" }, { status: 400 });
  }
  const passenger = await db.passenger.create({
    data: {
      name: String(name),
      age: Number(age),
      gender: String(gender),
      berthPref: String(berthPref ?? "NC"),
      foodPref: String(foodPref ?? "D"),
      nationality: String(nationality ?? "India"),
      isPrimary: Boolean(isPrimary),
      aadhaarLast4: aadhaarLast4 ? String(aadhaarLast4) : null,
    },
  });
  return NextResponse.json({ passenger });
}
