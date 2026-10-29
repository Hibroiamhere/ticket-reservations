/**
 * GET /api/jobs/list
 * Returns recent jobs (latest 50).
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import type { JobDTO } from "@/lib/agent/types";

export async function GET() {
  const jobs = await db.bookingJob.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  const dtos: JobDTO[] = jobs.map((j) => ({
    id: j.id,
    status: j.status as JobDTO["status"],
    currentStep: j.currentStep,
    attemptCount: j.attemptCount,
    lastMessage: j.lastMessage,
    fromStation: j.fromStation,
    fromStationName: j.fromStationName,
    toStation: j.toStation,
    toStationName: j.toStationName,
    journeyDate: j.journeyDate,
    travelClass: j.travelClass,
    quota: j.quota,
    preferredTrains: j.preferredTrains,
    createdAt: j.createdAt.toISOString(),
    startedAt: j.startedAt ? j.startedAt.toISOString() : null,
    finishedAt: j.finishedAt ? j.finishedAt.toISOString() : null,
    resultJson: j.resultJson,
  }));
  return NextResponse.json({ jobs: dtos });
}
