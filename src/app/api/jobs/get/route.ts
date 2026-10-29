/**
 * GET /api/jobs/get?jobId=...
 * Returns one job + its logs.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { jobStore } from "@/lib/agent/store";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const jobId = url.searchParams.get("jobId");
  if (!jobId) return NextResponse.json({ error: "jobId required" }, { status: 400 });

  const job = await db.bookingJob.findUnique({ where: { id: jobId }, include: { logs: { orderBy: { ts: "asc" } } } });
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });

  return NextResponse.json({
    job: {
      id: job.id,
      status: job.status,
      currentStep: job.currentStep,
      attemptCount: job.attemptCount,
      lastMessage: job.lastMessage,
      fromStation: job.fromStation,
      fromStationName: job.fromStationName,
      toStation: job.toStation,
      toStationName: job.toStationName,
      journeyDate: job.journeyDate,
      travelClass: job.travelClass,
      quota: job.quota,
      preferredTrains: job.preferredTrains,
      createdAt: job.createdAt.toISOString(),
      startedAt: job.startedAt?.toISOString() ?? null,
      finishedAt: job.finishedAt?.toISOString() ?? null,
      resultJson: job.resultJson,
    },
    logs: job.logs.map((l) => ({
      id: l.id,
      ts: l.ts.toISOString(),
      level: l.level,
      message: l.message,
      screenshotPath: l.screenshotPath,
    })),
    isActive: jobStore.isActive(jobId),
  });
}
