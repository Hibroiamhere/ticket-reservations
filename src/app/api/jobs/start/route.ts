/**
 * POST /api/jobs/start
 * Body: BookingRequest
 * Validates input, persists a BookingJob row, schedules the runner in the
 * background, returns the jobId immediately so the dashboard can subscribe
 * to /api/stream?jobId=... for live updates.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { scheduleJob } from "@/lib/agent/runner";
import type { BookingRequest } from "@/lib/agent/types";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Partial<BookingRequest>;
  const required = ["sessionId", "fromStation", "toStation", "journeyDate", "travelClass", "quota", "passengerIds", "contactMobile", "contactEmail"];
  for (const k of required) {
    if (body[k as keyof BookingRequest] === undefined) {
      return NextResponse.json({ error: `Missing field: ${k}` }, { status: 400 });
    }
  }
  if (!Array.isArray(body.passengerIds) || body.passengerIds!.length === 0) {
    return NextResponse.json({ error: "At least one passenger is required" }, { status: 400 });
  }

  const session = await db.session.findUnique({ where: { id: body.sessionId! } });
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 400 });
  }

  const job = await db.bookingJob.create({
    data: {
      sessionId: body.sessionId!,
      fromStation: String(body.fromStation).toUpperCase(),
      fromStationName: body.fromStationName ?? null,
      toStation: String(body.toStation).toUpperCase(),
      toStationName: body.toStationName ?? null,
      journeyDate: body.journeyDate!,
      travelClass: body.travelClass!,
      quota: body.quota!,
      preferredTrains: Array.isArray(body.preferredTrains) ? body.preferredTrains.join(",") : null,
      passengerIdsJson: JSON.stringify(body.passengerIds),
      contactMobile: body.contactMobile!,
      contactEmail: body.contactEmail!,
      retryEnabled: body.retryEnabled ?? true,
      retryIntervalSec: body.retryIntervalSec ?? 5,
      retryMaxMinutes: body.retryMaxMinutes ?? 15,
      autoConfirmBooking: body.autoConfirmBooking ?? false,
      pauseBeforePayment: body.pauseBeforePayment ?? true,
      status: "pending",
    },
  });

  // Schedule non-blocking run.
  scheduleJob(job.id);
  return NextResponse.json({ jobId: job.id });
}
