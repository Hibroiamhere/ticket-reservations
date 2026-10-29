/**
 * POST /api/jobs/cancel
 * Body: { jobId }
 * Cancels a running or paused job.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { jobStore } from "@/lib/agent/store";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const jobId = body.jobId;
  if (!jobId) return NextResponse.json({ error: "jobId required" }, { status: 400 });

  const job = await db.bookingJob.findUnique({ where: { id: jobId } });
  if (!job) return NextResponse.json({ error: "job not found" }, { status: 404 });

  const delivered = jobStore.cancel(jobId);
  if (!delivered) {
    // Job may have already finished. Mark cancelled if still in-flight status.
    if (["pending", "running", "paused_payment", "paused_review"].includes(job.status)) {
      await db.bookingJob.update({
        where: { id: jobId },
        data: { status: "cancelled", finishedAt: new Date(), lastMessage: "Cancelled by user (no active process)." },
      });
    }
  }
  return NextResponse.json({ ok: true });
}
