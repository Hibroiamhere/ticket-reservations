import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    name: "IRCTC Auto-Booking Agent",
    version: "1.0.0",
    status: "ok",
  });
}
