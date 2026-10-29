/**
 * GET /api/stream?jobId=...
 *
 * Server-Sent Events endpoint. Streams LogEvents for a given job in real
 * time. The browser uses EventSource to consume this.
 *
 * The stream stays open until the client disconnects or the job finishes
 * (we close the stream after the terminal event).
 */

import { eventBus } from "@/lib/agent/event-bus";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TERMINAL_STATUSES = new Set(["success", "failed", "cancelled", "exhausted"]);

export async function GET(req: Request) {
  const url = new URL(req.url);
  const jobId = url.searchParams.get("jobId");
  if (!jobId) {
    return new Response("jobId required", { status: 400 });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      // Send a "ready" ping so the client knows we're connected.
      send("ready", { jobId, ts: new Date().toISOString() });

      // If the job is already terminal, send current state and close.
      const job = await db.bookingJob.findUnique({ where: { id: jobId } });
      if (job && TERMINAL_STATUSES.has(job.status)) {
        send("status", { status: job.status, finishedAt: job.finishedAt?.toISOString() });
        controller.close();
        return;
      }

      // Subscribe to live events.
      const sub = eventBus.subscribe(jobId);

      // Watcher: poll job status every 2s and emit a "status" event when
      // it changes. This is the only "polling" we do — it's cheap (single
      // DB read) and ensures the dashboard always knows the current status
      // even if no log line was emitted.
      let lastStatus = job?.status ?? "pending";
      const statusWatcher = setInterval(async () => {
        const j = await db.bookingJob.findUnique({ where: { id: jobId } });
        if (!j) return;
        if (j.status !== lastStatus) {
          lastStatus = j.status;
          send("status", { status: j.status, currentStep: j.currentStep, attemptCount: j.attemptCount, lastMessage: j.lastMessage, finishedAt: j.finishedAt?.toISOString() });
          if (TERMINAL_STATUSES.has(j.status)) {
            send("done", { status: j.status });
            clearInterval(statusWatcher);
            sub.close();
            controller.close();
          }
        }
      }, 2000);

      // Also send a status snapshot every 5s so the dashboard can update
      // attemptCount / currentStep even when status hasn't changed.
      const snapshotTimer = setInterval(async () => {
        const j = await db.bookingJob.findUnique({ where: { id: jobId } });
        if (!j) return;
        send("snapshot", {
          status: j.status,
          currentStep: j.currentStep,
          attemptCount: j.attemptCount,
          lastMessage: j.lastMessage,
        });
      }, 5000);

      // Pump events from the bus to the SSE stream.
      (async () => {
        while (true) {
          const ev = await sub.next();
          if (!ev) break;
          send("log", ev);
        }
      })();

      // Handle client disconnect.
      req.signal?.addEventListener("abort", () => {
        clearInterval(statusWatcher);
        clearInterval(snapshotTimer);
        sub.close();
        try { controller.close(); } catch {}
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
