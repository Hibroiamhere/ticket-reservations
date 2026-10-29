/**
 * POST /api/jobs/resume
 * Body: { jobId, action: "proceed" | "cancel" | "retry" }
 * Resolves the promise the runner is awaiting while in paused_payment state.
 *
 * - "proceed": user has completed payment manually in the IRCTC window.
 *             Job marked as success.
 * - "cancel": user wants to abandon the booking.
 * - "retry":  user wants to re-run the booking flow.
 */
import { NextResponse } from "next/server";
import { jobStore } from "@/lib/agent/store";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const jobId = body.jobId;
  const action = body.action;
  if (!jobId || !["proceed", "cancel", "retry"].includes(action)) {
    return NextResponse.json({ error: "jobId and action (proceed|cancel|retry) required" }, { status: 400 });
  }
  const delivered = jobStore.resume(jobId, { action });
  if (!delivered) {
    return NextResponse.json({ error: "Job is not currently paused (or already resumed)." }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
