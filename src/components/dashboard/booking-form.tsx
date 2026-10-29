"use client";

/**
 * Booking form — the main control surface for launching a booking job.
 *
 * Collects: session, route (from/to), date, class, quota, preferred trains,
 * passengers, contact, retry config. Calls startBooking() on submit and
 * invokes onJobStarted(jobId) so the parent can switch to the Live tab.
 */

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Rocket, Zap } from "lucide-react";
import {
  TRAVEL_CLASSES,
  QUOTAS,
  type BookingRequest,
  type PassengerDTO,
  type SessionDTO,
} from "@/lib/agent/types";
import * as api from "@/lib/dashboard/api";

interface Props {
  sessions: SessionDTO[];
  passengers: PassengerDTO[];
  onJobStarted: (jobId: string) => void;
}

const POPULAR_STATIONS = [
  { code: "NDLS", name: "New Delhi" },
  { code: "BCT", name: "Mumbai Central" },
  { code: "HWH", name: "Howrah Jn" },
  { code: "MAS", name: "Mumbai CSM Terminus" },
  { code: "SBC", name: "Bengaluru" },
  { code: "SC", name: "Secunderabad" },
  { code: "PUNE", name: "Pune Jn" },
  { code: "ADI", name: "Ahmedabad" },
  { code: "CNB", name: "Kanpur Central" },
  { code: "PNBE", name: "Patna Jn" },
  { code: "LKO", name: "Lucknow" },
  { code: "JP", name: "Jaipur" },
];

export function BookingForm({ sessions, passengers, onJobStarted }: Props) {
  const { toast } = useToast();
  const [submitting, setSubmitting] = useState(false);

  // Form state.
  const [sessionId, setSessionId] = useState("");
  const [fromStation, setFromStation] = useState("");
  const [fromStationName, setFromStationName] = useState("");
  const [toStation, setToStation] = useState("");
  const [toStationName, setToStationName] = useState("");
  const [journeyDate, setJourneyDate] = useState("");
  const [travelClass, setTravelClass] = useState("3A");
  const [quota, setQuota] = useState("GN");
  const [preferredTrains, setPreferredTrains] = useState("");
  const [selectedPassengerIds, setSelectedPassengerIds] = useState<string[]>([]);
  const [contactMobile, setContactMobile] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [retryEnabled, setRetryEnabled] = useState(true);
  const [retryIntervalSec, setRetryIntervalSec] = useState(5);
  const [retryMaxMinutes, setRetryMaxMinutes] = useState(15);
  const [autoConfirmBooking, setAutoConfirmBooking] = useState(false);
  const [pauseBeforePayment, setPauseBeforePayment] = useState(true);

  // Default session = first active session.
  useEffect(() => {
    if (!sessionId && sessions.length > 0) {
      const active = sessions.find((s) => s.isActive) ?? sessions[0];
      setSessionId(active.id);
    }
  }, [sessions, sessionId]);

  // Default contact from primary passenger.
  useEffect(() => {
    if (!contactMobile && !contactEmail && passengers.length > 0) {
      const primary = passengers.find((p) => p.isPrimary);
      if (primary) {
        setSelectedPassengerIds((cur) => (cur.length === 0 ? [primary.id] : cur));
      }
    }
  }, [passengers, contactMobile, contactEmail]);

  const togglePassenger = (id: string) => {
    setSelectedPassengerIds((cur) =>
      cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id],
    );
  };

  const onSubmit = async () => {
    if (!sessionId) {
      toast({ title: "Select a session", description: "Create one in the Sessions tab first.", variant: "destructive" });
      return;
    }
    if (!fromStation || !toStation || !journeyDate) {
      toast({ title: "Missing fields", description: "From, To, and Journey date are required.", variant: "destructive" });
      return;
    }
    if (selectedPassengerIds.length === 0) {
      toast({ title: "No passengers", description: "Add at least one passenger in the Passengers tab.", variant: "destructive" });
      return;
    }
    if (!contactMobile || !contactEmail) {
      toast({ title: "Missing contact", description: "Mobile and email are required for booking.", variant: "destructive" });
      return;
    }

    const req: BookingRequest = {
      sessionId,
      fromStation: fromStation.toUpperCase(),
      fromStationName,
      toStation: toStation.toUpperCase(),
      toStationName,
      journeyDate,
      travelClass: travelClass as BookingRequest["travelClass"],
      quota: quota as BookingRequest["quota"],
      preferredTrains: preferredTrains
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      passengerIds: selectedPassengerIds,
      contactMobile,
      contactEmail,
      retryEnabled,
      retryIntervalSec,
      retryMaxMinutes,
      autoConfirmBooking,
      pauseBeforePayment,
    };

    setSubmitting(true);
    try {
      const jobId = await api.startBooking(req);
      toast({ title: "Booking started", description: `Job ${jobId.slice(0, 8)} is running.` });
      onJobStarted(jobId);
    } catch (err) {
      toast({ title: "Failed to start", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  const tatkalPreset = () => {
    setQuota("TQ");
    setRetryEnabled(true);
    setRetryIntervalSec(3);
    setRetryMaxMinutes(10);
    toast({ title: "Tatkal preset applied", description: "3s retries, 10-min window — tuned for 10 AM/11 AM Tatkal drops." });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Rocket className="h-5 w-5 text-amber-600" /> New Booking
            </CardTitle>
            <CardDescription className="mt-1">
              Fill in the journey details and the agent will run IRCTC end-to-end.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={tatkalPreset} className="gap-2">
            <Zap className="h-4 w-4 text-amber-600" /> Tatkal Preset
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Session */}
        <div className="space-y-2">
          <Label htmlFor="session">IRCTC Session</Label>
          <Select value={sessionId} onValueChange={setSessionId}>
            <SelectTrigger id="session"><SelectValue placeholder="Select a saved session" /></SelectTrigger>
            <SelectContent>
              {sessions.length === 0 && <div className="p-2 text-sm text-muted-foreground">No sessions yet — create one in the Sessions tab.</div>}
              {sessions.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.label} {s.loggedInAs ? `(${s.loggedInAs})` : s.isActive ? "(active)" : "(no login yet)"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Route */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="from">From (station code)</Label>
            <Input id="from" value={fromStation} onChange={(e) => setFromStation(e.target.value)} placeholder="e.g. NDLS" list="stations" />
            <Input value={fromStationName} onChange={(e) => setFromStationName(e.target.value)} placeholder="Station name (optional, e.g. New Delhi)" className="text-xs" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="to">To (station code)</Label>
            <Input id="to" value={toStation} onChange={(e) => setToStation(e.target.value)} placeholder="e.g. BCT" list="stations" />
            <Input value={toStationName} onChange={(e) => setToStationName(e.target.value)} placeholder="Station name (optional, e.g. Mumbai Central)" className="text-xs" />
          </div>
          <datalist id="stations">
            {POPULAR_STATIONS.map((s) => (
              <option key={s.code} value={s.code}>{s.name}</option>
            ))}
          </datalist>
        </div>

        {/* Date + class + quota */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-2">
            <Label htmlFor="date">Journey date</Label>
            <Input id="date" type="date" value={journeyDate} onChange={(e) => setJourneyDate(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Class</Label>
            <Select value={travelClass} onValueChange={setTravelClass}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {TRAVEL_CLASSES.map((c) => (
                  <SelectItem key={c.code} value={c.code}>{c.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Quota</Label>
            <Select value={quota} onValueChange={setQuota}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {QUOTAS.map((q) => (
                  <SelectItem key={q.code} value={q.code}>{q.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Preferred trains */}
        <div className="space-y-2">
          <Label htmlFor="trains">Preferred train numbers (comma-separated, optional)</Label>
          <Input id="trains" value={preferredTrains} onChange={(e) => setPreferredTrains(e.target.value)} placeholder="e.g. 12951, 12259, 12621" />
          <p className="text-xs text-muted-foreground">The agent picks the first available preferred train. If none match, it falls back to the first available Book Now button.</p>
        </div>

        {/* Passengers */}
        <div className="space-y-2">
          <Label>Passengers</Label>
          <div className="rounded-md border p-3 max-h-64 overflow-y-auto space-y-2">
            {passengers.length === 0 && (
              <div className="text-sm text-muted-foreground">No saved passengers. Add some in the Passengers tab.</div>
            )}
            {passengers.map((p) => (
              <label key={p.id} className="flex items-center gap-3 p-2 rounded hover:bg-muted/50 cursor-pointer">
                <Checkbox
                  checked={selectedPassengerIds.includes(p.id)}
                  onCheckedChange={() => togglePassenger(p.id)}
                />
                <div className="flex-1">
                  <div className="text-sm font-medium">{p.name} <span className="text-muted-foreground">· {p.age} · {p.gender}</span></div>
                  <div className="text-xs text-muted-foreground">Berth: {p.berthPref} · Food: {p.foodPref}</div>
                </div>
                {p.isPrimary && <Badge variant="secondary" className="text-xs">primary</Badge>}
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{selectedPassengerIds.length} passenger(s) selected.</p>
        </div>

        {/* Contact */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="mobile">Contact mobile</Label>
            <Input id="mobile" value={contactMobile} onChange={(e) => setContactMobile(e.target.value)} placeholder="10-digit mobile" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">Contact email</Label>
            <Input id="email" type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} placeholder="you@example.com" />
          </div>
        </div>

        {/* Retry config */}
        <div className="rounded-md border border-amber-500/30 bg-amber-50/50 dark:bg-amber-950/20 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <Label htmlFor="retry" className="font-medium">Auto-retry when sold out</Label>
            <Checkbox id="retry" checked={retryEnabled} onCheckedChange={(v) => setRetryEnabled(v === true)} />
          </div>
          {retryEnabled && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Retry interval (seconds)</Label>
                <Input type="number" min={3} max={60} value={retryIntervalSec} onChange={(e) => setRetryIntervalSec(Number(e.target.value))} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Max retry window (minutes)</Label>
                <Input type="number" min={1} max={120} value={retryMaxMinutes} onChange={(e) => setRetryMaxMinutes(Number(e.target.value))} />
              </div>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            For Tatkal bookings, set interval to 3-5s and window to 10-15 min. The agent will keep retrying the moment seats drop.
          </p>
        </div>

        {/* Payment safety */}
        <div className="space-y-3">
          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <div className="text-sm font-medium">Pause before payment</div>
              <p className="text-xs text-muted-foreground">Stops at the review page so you can complete payment manually. Strongly recommended.</p>
            </div>
            <Checkbox checked={pauseBeforePayment} onCheckedChange={(v) => setPauseBeforePayment(v === true)} />
          </div>
          <div className="flex items-center justify-between rounded-md border p-3 border-red-500/30 bg-red-50/40 dark:bg-red-950/20">
            <div>
              <div className="text-sm font-medium">Auto-confirm booking (skip pause)</div>
              <p className="text-xs text-muted-foreground">Clicks through to payment automatically. The agent will not pay on its own — it just reaches the payment page.</p>
            </div>
            <Checkbox checked={autoConfirmBooking} onCheckedChange={(v) => setAutoConfirmBooking(v === true)} />
          </div>
        </div>

        <Button onClick={onSubmit} disabled={submitting} className="w-full gap-2 bg-amber-600 hover:bg-amber-700 text-white">
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
          Start Booking
        </Button>
      </CardContent>
    </Card>
  );
}
