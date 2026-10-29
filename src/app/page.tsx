"use client";

/**
 * IRCTC Auto-Booking Agent — main dashboard.
 *
 * Single-page app with 5 tabs:
 *   - Book: booking form + live progress feed
 *   - Passengers: manage saved passenger profiles
 *   - Sessions: manage IRCTC login sessions
 *   - History: list of past booking jobs
 *   - Settings: SMTP/email config + retry defaults
 *
 * State is fetched on mount and refreshed whenever the user takes an action
 * in a child component (via onChange callbacks).
 */

import { useEffect, useState, useCallback } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Train, BookOpen, Users, KeyRound, History, Settings, RefreshCw, AlertCircle, Github } from "lucide-react";
import { BookingForm } from "@/components/dashboard/booking-form";
import { LiveProgress } from "@/components/dashboard/live-progress";
import { PassengersManager } from "@/components/dashboard/passengers-manager";
import { SessionsManager } from "@/components/dashboard/sessions-manager";
import { JobHistory } from "@/components/dashboard/job-history";
import { SettingsPanel } from "@/components/dashboard/settings-panel";
import * as api from "@/lib/dashboard/api";
import type { JobDTO, PassengerDTO, SessionDTO } from "@/lib/agent/types";

export default function Home() {
  const [tab, setTab] = useState("book");
  const [sessions, setSessions] = useState<SessionDTO[]>([]);
  const [passengers, setPassengers] = useState<PassengerDTO[]>([]);
  const [jobs, setJobs] = useState<JobDTO[]>([]);
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    try {
      const [s, p, j] = await Promise.all([api.listSessions(), api.listPassengers(), api.listJobs()]);
      setSessions(s);
      setPassengers(p);
      setJobs(j);
      setBootError(null);
    } catch (err) {
      setBootError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  const onJobStarted = (jobId: string) => {
    setCurrentJobId(jobId);
    setTab("book");
    refreshAll();
  };

  const openHistoryJob = (jobId: string) => {
    setCurrentJobId(jobId);
    setTab("book");
  };

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Header */}
      <header className="border-b bg-card">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-amber-600 flex items-center justify-center text-white">
              <Train className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight">IRCTC Auto-Booking Agent</h1>
              <p className="text-xs text-muted-foreground">Headless Playwright agent with Tatkal auto-retry &amp; pause-before-pay safety</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={refreshAll} className="gap-2">
              <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} /> Refresh
            </Button>
          </div>
        </div>
      </header>

      {/* Boot error banner */}
      {bootError && (
        <div className="bg-red-50 dark:bg-red-950/30 border-b border-red-200 dark:border-red-900 text-red-800 dark:text-red-300 px-4 py-3 text-sm">
          <div className="container mx-auto flex items-center gap-2">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            <span>Could not load dashboard data: {bootError}. Check that the dev server is running and try Refresh.</span>
          </div>
        </div>
      )}

      {/* Main */}
      <main className="container mx-auto px-4 py-6 flex-1">
        <Tabs value={tab} onValueChange={setTab} className="space-y-6">
          <TabsList className="grid w-full grid-cols-2 md:grid-cols-5 h-auto">
            <TabsTrigger value="book" className="gap-2"><BookOpen className="h-4 w-4" /> Book</TabsTrigger>
            <TabsTrigger value="passengers" className="gap-2"><Users className="h-4 w-4" /> Passengers</TabsTrigger>
            <TabsTrigger value="sessions" className="gap-2"><KeyRound className="h-4 w-4" /> Sessions</TabsTrigger>
            <TabsTrigger value="history" className="gap-2"><History className="h-4 w-4" /> History</TabsTrigger>
            <TabsTrigger value="settings" className="gap-2"><Settings className="h-4 w-4" /> Settings</TabsTrigger>
          </TabsList>

          {/* Book tab */}
          <TabsContent value="book" className="space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <BookingForm sessions={sessions} passengers={passengers} onJobStarted={onJobStarted} />
              <div>
                {currentJobId ? (
                  <LiveProgress jobId={currentJobId} onClose={() => setCurrentJobId(null)} />
                ) : (
                  <Card className="h-full">
                    <CardContent className="h-full flex flex-col items-center justify-center text-center p-8 text-muted-foreground">
                      <Train className="h-12 w-12 mb-3 opacity-30" />
                      <p className="text-sm">No active booking. Fill out the form on the left and click <strong>Start Booking</strong> to begin.</p>
                      <p className="text-xs mt-2">Live logs, screenshots, and pause/resume controls will appear here.</p>
                    </CardContent>
                  </Card>
                )}
              </div>
            </div>
          </TabsContent>

          {/* Passengers tab */}
          <TabsContent value="passengers">
            <PassengersManager passengers={passengers} onChange={refreshAll} />
          </TabsContent>

          {/* Sessions tab */}
          <TabsContent value="sessions">
            <SessionsManager sessions={sessions} onChange={refreshAll} />
          </TabsContent>

          {/* History tab */}
          <TabsContent value="history">
            <JobHistory jobs={jobs} onOpen={openHistoryJob} />
          </TabsContent>

          {/* Settings tab */}
          <TabsContent value="settings">
            <SettingsPanel />
          </TabsContent>
        </Tabs>
      </main>

      {/* Footer */}
      <footer className="border-t bg-card mt-auto">
        <div className="container mx-auto px-4 py-4 text-xs text-muted-foreground flex flex-col md:flex-row md:items-center md:justify-between gap-2">
          <div>
            <strong>Disclaimer:</strong> This agent automates the IRCTC web UI. Use of automation on irctc.co.in may violate IRCTC&apos;s Terms of Service. Use for personal bookings only and at your own risk.
          </div>
          <div className="flex items-center gap-2">
            <Github className="h-3 w-3" />
            <span>Built with Next.js + Playwright</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
