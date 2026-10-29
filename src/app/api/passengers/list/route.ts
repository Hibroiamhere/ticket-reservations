/**
 * GET /api/passengers/list
 * List all saved passengers.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import type { PassengerDTO } from "@/lib/agent/types";

export async function GET() {
  const passengers = await db.passenger.findMany({ orderBy: { createdAt: "desc" } });
  const dtos: PassengerDTO[] = passengers.map((p) => ({
    id: p.id,
    name: p.name,
    age: p.age,
    gender: p.gender as "M" | "F" | "T",
    berthPref: p.berthPref,
    foodPref: p.foodPref,
    nationality: p.nationality,
    isPrimary: p.isPrimary,
    aadhaarLast4: p.aadhaarLast4 ?? null,
  }));
  return NextResponse.json({ passengers: dtos });
}
