"use client";

/**
 * Job history — list of recent booking jobs with status, route, attempts.
 * Click a job to open the live progress view (read-only if terminal).
 */

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { History, Eye } from "lucide-react";
import type { JobDTO, JobStatus } from "@/lib/agent/types";

interface Props {
  jobs: JobDTO[];
  onOpen: (jobId: string) => void;
}

const STATUS_BADGE: Record<JobStatus, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  pending: { label: "Pending", variant: "outline" },
  running: { label: "Running", variant: "default" },
  paused_review: { label: "Paused", variant: "secondary" },
  paused_payment: { label: "Paused (Pay)", variant: "secondary" },
  success: { label: "Success", variant: "default" },
  failed: { label: "Failed", variant: "destructive" },
  cancelled: { label: "Cancelled", variant: "outline" },
  exhausted: { label: "Exhausted", variant: "destructive" },
};

export function JobHistory({ jobs, onOpen }: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><History className="h-5 w-5 text-amber-600" /> Booking history</CardTitle>
        <CardDescription>Last {jobs.length} job(s). Click to view full log.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {jobs.length === 0 && <div className="text-sm text-muted-foreground">No jobs yet.</div>}
        {jobs.map((j) => {
          const badge = STATUS_BADGE[j.status];
          return (
            <div key={j.id} className="rounded-md border p-3 flex items-center justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium">{j.fromStationName ?? j.fromStation} → {j.toStationName ?? j.toStation}</span>
                  <Badge variant={badge.variant}>{badge.label}</Badge>
                  {j.attemptCount > 0 && <Badge variant="outline">attempts: {j.attemptCount}</Badge>}
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {j.journeyDate} · {j.travelClass} · {j.quota}
                  {j.preferredTrains && ` · trains: ${j.preferredTrains}`}
                  {j.currentStep && ` · ${j.currentStep}`}
                </div>
                <div className="text-xs text-muted-foreground">
                  Created {new Date(j.createdAt).toLocaleString()}
                  {j.finishedAt && ` · Finished ${new Date(j.finishedAt).toLocaleString()}`}
                </div>
              </div>
              <Button size="sm" variant="ghost" onClick={() => onOpen(j.id)} className="gap-2">
                <Eye className="h-4 w-4" /> View
              </Button>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
