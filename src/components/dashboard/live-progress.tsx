"use client";

/**
 * Live progress feed for one booking job.
 *
 * Connects to /api/stream?jobId=... via EventSource and renders the log
 * timeline in real time. Shows:
 *   - Current status badge + attempt count
 *   - Current step label
 *   - Last screenshot thumbnail (clickable to view full size)
 *   - Scrollable log feed
 *   - Action buttons when paused:
 *       paused_payment → "I paid — mark success" / "Cancel" / "Retry"
 *       running        → "Cancel"
 */

import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, CheckCircle2, XCircle, Clock, AlertTriangle, Camera, Square, Play } from "lucide-react";
import * as api from "@/lib/dashboard/api";
import type { JobStatus, LogLevel } from "@/lib/agent/types";

interface LogEntry {
  ts: string;
  level: LogLevel;
  message: string;
  screenshotPath?: string;
}

interface Props {
  jobId: string;
  onClose: () => void;
}

const STATUS_BADGE: Record<JobStatus, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  pending: { label: "Pending", variant: "outline" },
  running: { label: "Running", variant: "default" },
  paused_review: { label: "Paused — Review", variant: "secondary" },
  paused_payment: { label: "Paused — Payment", variant: "secondary" },
  success: { label: "Success", variant: "default" },
  failed: { label: "Failed", variant: "destructive" },
  cancelled: { label: "Cancelled", variant: "outline" },
  exhausted: { label: "Retries Exhausted", variant: "destructive" },
};

const LEVEL_STYLE: Record<LogLevel, string> = {
  info: "text-foreground",
  warn: "text-amber-600 dark:text-amber-400",
  error: "text-red-600 dark:text-red-400",
  success: "text-emerald-600 dark:text-emerald-400 font-medium",
  step: "text-amber-600 dark:text-amber-400 font-medium uppercase text-xs tracking-wide",
  screenshot: "text-blue-600 dark:text-blue-400",
};

export function LiveProgress({ jobId, onClose }: Props) {
  const [status, setStatus] = useState<JobStatus>("pending");
  const [currentStep, setCurrentStep] = useState<string>("");
  const [attemptCount, setAttemptCount] = useState(0);
  const [lastMessage, setLastMessage] = useState<string>("");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [lastScreenshot, setLastScreenshot] = useState<string | undefined>();
  const [showScreenshot, setShowScreenshot] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const logEndRef = useRef<HTMLDivElement>(null);

  // 1. Load persisted history on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/jobs/get?jobId=${jobId}`);
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        if (data.job) {
          setStatus(data.job.status);
          setCurrentStep(data.job.currentStep ?? "");
          setAttemptCount(data.job.attemptCount ?? 0);
          setLastMessage(data.job.lastMessage ?? "");
        }
        if (data.logs) {
          setLogs(data.logs.map((l: LogEntry & { id: string }) => ({
            ts: l.ts, level: l.level as LogLevel, message: l.message, screenshotPath: l.screenshotPath ?? undefined,
          })));
          // Pick the last screenshot-bearing log.
          const withShot = data.logs.filter((l: LogEntry) => l.screenshotPath);
          if (withShot.length) setLastScreenshot(withShot[withShot.length - 1].screenshotPath);
        }
      } finally {
        if (!cancelled) setLoadingHistory(false);
      }
    })();
    return () => { cancelled = true; };
  }, [jobId]);

  // 2. Subscribe to SSE for live updates.
  useEffect(() => {
    const es = new EventSource(`/api/stream?jobId=${jobId}`);

    es.addEventListener("log", (e) => {
      try {
        const ev = JSON.parse(e.data);
        setLogs((cur) => [...cur, { ts: ev.ts, level: ev.level, message: ev.message, screenshotPath: ev.screenshotPath }]);
        if (ev.screenshotPath) setLastScreenshot(ev.screenshotPath);
      } catch {}
    });
    es.addEventListener("status", (e) => {
      try {
        const ev = JSON.parse(e.data);
        if (ev.status) setStatus(ev.status);
        if (ev.currentStep !== undefined) setCurrentStep(ev.currentStep ?? "");
        if (ev.attemptCount !== undefined) setAttemptCount(ev.attemptCount ?? 0);
        if (ev.lastMessage !== undefined) setLastMessage(ev.lastMessage ?? "");
      } catch {}
    });
    es.addEventListener("snapshot", (e) => {
      try {
        const ev = JSON.parse(e.data);
        if (ev.currentStep !== undefined) setCurrentStep(ev.currentStep ?? "");
        if (ev.attemptCount !== undefined) setAttemptCount(ev.attemptCount ?? 0);
        if (ev.lastMessage !== undefined) setLastMessage(ev.lastMessage ?? "");
      } catch {}
    });
    es.addEventListener("done", (e) => {
      try {
        const ev = JSON.parse(e.data);
        if (ev.status) setStatus(ev.status);
      } catch {}
      es.close();
    });
    es.onerror = () => {
      // EventSource auto-reconnects; nothing to do here.
    };

    return () => es.close();
  }, [jobId]);

  // Auto-scroll to bottom on new logs.
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [logs]);

  const isPaused = status === "paused_payment" || status === "paused_review";
  const isRunning = status === "running" || status === "pending";
  const isTerminal = ["success", "failed", "cancelled", "exhausted"].includes(status);

  const handleProceed = async () => {
    try {
      await api.resumeJob(jobId, "proceed");
    } catch (err) {
      console.error(err);
    }
  };
  const handleRetry = async () => {
    try {
      await api.resumeJob(jobId, "retry");
    } catch (err) {
      console.error(err);
    }
  };
  const handleCancel = async () => {
    try {
      await api.cancelJob(jobId);
    } catch (err) {
      console.error(err);
    }
  };

  const badge = STATUS_BADGE[status];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              {isRunning && <Loader2 className="h-4 w-4 animate-spin text-amber-600" />}
              {status === "success" && <CheckCircle2 className="h-5 w-5 text-emerald-600" />}
              {status === "failed" && <XCircle className="h-5 w-5 text-red-600" />}
              {isPaused && <Clock className="h-5 w-5 text-amber-600" />}
              {(status === "exhausted" || status === "cancelled") && <AlertTriangle className="h-5 w-5 text-amber-600" />}
              Job {jobId.slice(0, 8)}
            </CardTitle>
            <CardDescription className="mt-1">
              {currentStep || (loadingHistory ? "Loading…" : "Waiting to start…")}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={badge.variant}>{badge.label}</Badge>
            {attemptCount > 0 && <Badge variant="outline">Attempt {attemptCount}</Badge>}
            <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Last message banner */}
        {lastMessage && (
          <div className="rounded-md border p-3 text-sm bg-muted/30">
            <span className="text-muted-foreground">Latest: </span>{lastMessage}
          </div>
        )}

        {/* Dry-run completion banner */}
        {status === "success" && lastMessage?.toLowerCase().includes("dry run") && (
          <div className="rounded-md border border-emerald-500/40 bg-emerald-50/60 dark:bg-emerald-950/30 p-4 space-y-2">
            <div className="font-medium flex items-center gap-2 text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="h-5 w-5" /> Test passed!
            </div>
            <p className="text-sm">
              Your saved IRCTC session is valid and the agent successfully reached the Review Journey page.
              You&apos;re ready for a real Tatkal booking. Go back to the Book tab, uncheck &quot;dry-run&quot; if needed,
              and click <strong>Start Booking</strong>.
            </p>
          </div>
        )}

        {/* Tatkal mode info banner */}
        {attemptCount > 0 && isRunning && !isPaused && (
          <div className="rounded-md border border-amber-500/30 bg-amber-50/40 dark:bg-amber-950/20 p-3 text-sm">
            <span className="text-amber-700 dark:text-amber-400 font-medium">⏱ Tatkal retry loop active: </span>
            attempt #{attemptCount} in progress. The agent is refreshing the search and clicking Book Now the moment seats drop.
          </div>
        )}

        {/* Action buttons for paused state */}
        {isPaused && (
          <div className="rounded-md border border-amber-500/40 bg-amber-50/60 dark:bg-amber-950/30 p-4 space-y-2">
            <div className="font-medium flex items-center gap-2">
              <Clock className="h-4 w-4 text-amber-600" />
              {status === "paused_payment"
                ? "Agent paused before payment. Complete payment in the IRCTC window, then:"
                : "Agent paused for review. Choose an action:"}
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              {status === "paused_payment" && (
                <Button size="sm" variant="default" className="bg-emerald-600 hover:bg-emerald-700 gap-2" onClick={handleProceed}>
                  <CheckCircle2 className="h-4 w-4" /> I paid — mark success
                </Button>
              )}
              <Button size="sm" variant="outline" className="gap-2" onClick={handleRetry}>
                <Play className="h-4 w-4" /> Retry booking
              </Button>
              <Button size="sm" variant="destructive" className="gap-2" onClick={handleCancel}>
                <XCircle className="h-4 w-4" /> Cancel
              </Button>
            </div>
          </div>
        )}

        {/* Cancel button for running state */}
        {isRunning && !isPaused && (
          <Button size="sm" variant="outline" className="gap-2 text-red-600 hover:text-red-700" onClick={handleCancel}>
            <Square className="h-3 w-3" /> Cancel job
          </Button>
        )}

        {/* Screenshot thumbnail */}
        {lastScreenshot && (
          <div className="space-y-2">
            <div className="text-xs text-muted-foreground uppercase tracking-wide flex items-center gap-1">
              <Camera className="h-3 w-3" /> Last screenshot
            </div>
            <button
              onClick={() => setShowScreenshot(true)}
              className="block rounded-md overflow-hidden border hover:opacity-80 transition"
            >
              <img
                src={`/api/screenshot?path=${encodeURIComponent(lastScreenshot)}`}
                alt="Last screenshot"
                className="max-h-64 w-auto"
              />
            </button>
          </div>
        )}

        {/* Log feed */}
        <div className="rounded-md border bg-black/95 dark:bg-black text-white p-3 font-mono text-xs max-h-96 overflow-y-auto">
          {logs.length === 0 && !loadingHistory && (
            <div className="text-gray-400">Waiting for first log line…</div>
          )}
          {logs.map((l, i) => (
            <div key={i} className={`py-0.5 ${LEVEL_STYLE[l.level]}`}>
              <span className="text-gray-500 mr-2">{new Date(l.ts).toLocaleTimeString()}</span>
              {l.level === "screenshot" && "📸 "}
              {l.message}
            </div>
          ))}
          <div ref={logEndRef} />
        </div>

        {/* Screenshot modal */}
        {showScreenshot && lastScreenshot && (
          <div
            className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4"
            onClick={() => setShowScreenshot(false)}
          >
            <img
              src={`/api/screenshot?path=${encodeURIComponent(lastScreenshot)}`}
              alt="Screenshot"
              className="max-w-full max-h-full"
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
