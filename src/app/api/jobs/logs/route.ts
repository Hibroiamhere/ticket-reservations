/**
 * GET /api/jobs/logs?jobId=...
 * Returns persisted logs for a job (used when reconnecting to a job
 * that was running while the dashboard was closed).
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const jobId = url.searchParams.get("jobId");
  if (!jobId) return NextResponse.json({ error: "jobId required" }, { status: 400 });
  const logs = await db.logEntry.findMany({
    where: { jobId },
    orderBy: { ts: "asc" },
  });
  return NextResponse.json({
    logs: logs.map((l) => ({
      id: l.id,
      ts: l.ts.toISOString(),
      level: l.level,
      message: l.message,
      screenshotPath: l.screenshotPath,
    })),
  });
}
