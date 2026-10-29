"use client";

/**
 * Booking form — the main control surface for launching a booking job.
 *
 * Collects: session, route (from/to), date, class, quota, preferred trains,
 * passengers, contact, retry config, master list selection, payment method,
 * dry-run toggle, and Tatkal mode. Calls startBooking() on submit and
 * invokes onJobStarted(jobId) so the parent can switch to the Live tab.
 *
 * Also exposes a "Test Booking" button that runs the same flow as a dry-run
 * (stops at Review Journey page without paying).
 */

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Rocket, Zap, FlaskConical, Train } from "lucide-react";
import {
  TRAVEL_CLASSES,
  QUOTAS,
  PAYMENT_METHODS,
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
  { code: "PUNE", name: "Pune Jn" },
  { code: "BSB", name: "Varanasi Jn (Manduadih)" },
  { code: "BSB", name: "Varanasi City" },
  { code: "NDLS", name: "New Delhi" },
  { code: "BCT", name: "Mumbai Central" },
  { code: "HWH", name: "Howrah Jn" },
  { code: "CSMT", name: "Mumbai CSM Terminus" },
  { code: "SBC", name: "Bengaluru" },
  { code: "SC", name: "Secunderabad" },
  { code: "ADI", name: "Ahmedabad" },
  { code: "CNB", name: "Kanpur Central" },
  { code: "PNBE", name: "Patna Jn" },
  { code: "LKO", name: "Lucknow" },
  { code: "JP", name: "Jaipur" },
];

export function BookingForm({ sessions, passengers, onJobStarted }: Props) {
  const { toast } = useToast();
  const [submitting, setSubmitting] = useState(false);
  const [testing, setTesting] = useState(false);

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

  // New fields.
  const [tatkalMode, setTatkalMode] = useState(false);
  const [useMasterList, setUseMasterList] = useState(true);
  const [masterListNames, setMasterListNames] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("SKIP");
  const [dryRun, setDryRun] = useState(false);

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

  const buildRequest = (): BookingRequest => ({
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
    tatkalMode,
    useMasterList,
    masterListNames: masterListNames.split(",").map((s) => s.trim()).filter(Boolean),
    paymentMethod: paymentMethod as BookingRequest["paymentMethod"],
    dryRun,
  });

  const validate = (): string | null => {
    if (!sessionId) return "Select a session first (Sessions tab).";
    if (!fromStation || !toStation || !journeyDate) return "From, To, and Journey date are required.";
    if (useMasterList && !masterListNames.trim()) return "Master List is ON but no names were entered. Either add names or turn Master List off.";
    if (!useMasterList && selectedPassengerIds.length === 0) return "No passengers selected. Either select passengers or enable Master List.";
    if (!contactMobile || !contactEmail) return "Mobile and email are required for booking.";
    return null;
  };

  const onSubmit = async () => {
    const err = validate();
    if (err) { toast({ title: "Missing fields", description: err, variant: "destructive" }); return; }
    setSubmitting(true);
    try {
      const jobId = await api.startBooking(buildRequest());
      toast({ title: "Booking started", description: `Job ${jobId.slice(0, 8)} is running.` });
      onJobStarted(jobId);
    } catch (err) {
      toast({ title: "Failed to start", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  const onTest = async () => {
    const err = validate();
    if (err) { toast({ title: "Missing fields", description: err, variant: "destructive" }); return; }
    setTesting(true);
    try {
      const jobId = await api.testBooking(buildRequest());
      toast({
        title: "Test booking started",
        description: "Dry-run mode — agent will stop at the Review Journey page without paying.",
      });
      onJobStarted(jobId);
    } catch (err) {
      toast({ title: "Test failed to start", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    } finally {
      setTesting(false);
    }
  };

  // Presets.
  const tatkalPreset = () => {
    setQuota("TQ");
    setTatkalMode(true);
    setRetryEnabled(true);
    setRetryIntervalSec(2);
    setRetryMaxMinutes(10);
    setUseMasterList(true);
    setPauseBeforePayment(true);
    toast({
      title: "🚀 Tatkal preset applied",
      description: "Tatkal mode ON, 2s retries, 10-min window, master list ON, pause before pay. Tune class/date for your route.",
    });
  };

  const puneVaranasiPreset = () => {
    setFromStation("PUNE");
    setFromStationName("Pune Jn");
    setToStation("BSB");
    setToStationName("Varanasi Jn");
    setTravelClass("3A");
    setQuota("TQ");
    setTatkalMode(true);
    setRetryEnabled(true);
    setRetryIntervalSec(2);
    setRetryMaxMinutes(15);
    setUseMasterList(true);
    setPreferredTrains("11033, 11039, 22131");
    toast({
      title: "Pune → Varanasi preset applied",
      description: "Route PUNE → BSB, 3A Tatkal, with popular trains pre-filled. Edit date + master list names before booking.",
    });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Rocket className="h-5 w-5 text-amber-600" /> New Booking
            </CardTitle>
            <CardDescription className="mt-1">
              Fill in journey details. Agent runs IRCTC end-to-end, pauses before payment.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={puneVaranasiPreset} className="gap-2">
              <Train className="h-4 w-4 text-amber-600" /> Pune→Varanasi
            </Button>
            <Button variant="outline" size="sm" onClick={tatkalPreset} className="gap-2">
              <Zap className="h-4 w-4 text-amber-600" /> Tatkal Preset
            </Button>
          </div>
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
            <Input id="from" value={fromStation} onChange={(e) => setFromStation(e.target.value)} placeholder="e.g. PUNE" list="stations" />
            <Input value={fromStationName} onChange={(e) => setFromStationName(e.target.value)} placeholder="Station name (optional, e.g. Pune Jn)" className="text-xs" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="to">To (station code)</Label>
            <Input id="to" value={toStation} onChange={(e) => setToStation(e.target.value)} placeholder="e.g. BSB" list="stations" />
            <Input value={toStationName} onChange={(e) => setToStationName(e.target.value)} placeholder="Station name (optional, e.g. Varanasi Jn)" className="text-xs" />
          </div>
          <datalist id="stations">
            {POPULAR_STATIONS.map((s, i) => (
              <option key={`${s.code}-${i}`} value={s.code}>{s.name}</option>
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
          <Label htmlFor="trains">Preferred train numbers (comma-separated)</Label>
          <Input id="trains" value={preferredTrains} onChange={(e) => setPreferredTrains(e.target.value)} placeholder="e.g. 11033, 11039, 22131 (Pune-Varanasi Darbhanga, Mahanagari, etc.)" />
          <p className="text-xs text-muted-foreground">Agent picks the first available preferred train. If none match, falls back to first available Book Now.</p>
        </div>

        {/* Passenger strategy: Master List vs typed */}
        <div className="rounded-md border p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">Use IRCTC Master List (recommended)</div>
              <p className="text-xs text-muted-foreground">Clicks saved passengers from your IRCTC account&apos;s Master List dropdown — much faster than typing each field.</p>
            </div>
            <Checkbox checked={useMasterList} onCheckedChange={(v) => setUseMasterList(v === true)} />
          </div>
          {useMasterList && (
            <div className="space-y-2">
              <Label htmlFor="masterListNames">Master List passenger names (comma-separated, EXACT match)</Label>
              <Input id="masterListNames" value={masterListNames} onChange={(e) => setMasterListNames(e.target.value)} placeholder="e.g. RAHUL SHARMA, PRIYA SHARMA" />
              <p className="text-xs text-muted-foreground">These must match the names exactly as they appear in your IRCTC account&apos;s Master List. Names are case-sensitive.</p>
            </div>
          )}
        </div>

        {/* Fallback passenger selection (only used if master list off or fails) */}
        {!useMasterList && (
          <div className="space-y-2">
            <Label>Fallback passengers (typed into form)</Label>
            <div className="rounded-md border p-3 max-h-64 overflow-y-auto space-y-2">
              {passengers.length === 0 && (
                <div className="text-sm text-muted-foreground">No saved passengers. Add some in the Passengers tab.</div>
              )}
              {passengers.map((p) => (
                <label key={p.id} className="flex items-center gap-3 p-2 rounded hover:bg-muted/50 cursor-pointer">
                  <Checkbox checked={selectedPassengerIds.includes(p.id)} onCheckedChange={() => togglePassenger(p.id)} />
                  <div className="flex-1">
                    <div className="text-sm font-medium">{p.name} <span className="text-muted-foreground">· {p.age} · {p.gender}</span></div>
                    <div className="text-xs text-muted-foreground">Berth: {p.berthPref} · Food: {p.foodPref}</div>
                  </div>
                  {p.isPrimary && <Badge variant="secondary" className="text-xs">primary</Badge>}
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{selectedPassengerIds.length} passenger(s) selected as fallback.</p>
          </div>
        )}

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

        {/* Tatkal mode + retry config */}
        <div className="rounded-md border border-amber-500/30 bg-amber-50/50 dark:bg-amber-950/20 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium flex items-center gap-2">
                <Zap className="h-4 w-4 text-amber-600" /> Tatkal mode (persistent browser, fast retries)
              </div>
              <p className="text-xs text-muted-foreground">Keeps ONE browser open across all retries — no relaunch overhead. Sub-second search loops. Skips intermediate screenshots.</p>
            </div>
            <Checkbox checked={tatkalMode} onCheckedChange={(v) => setTatkalMode(v === true)} />
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <Label htmlFor="retry" className="font-medium text-sm">Auto-retry when sold out</Label>
            <Checkbox id="retry" checked={retryEnabled} onCheckedChange={(v) => setRetryEnabled(v === true)} />
          </div>
          {retryEnabled && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Retry interval (seconds)</Label>
                <Input type="number" min={1} max={60} value={retryIntervalSec} onChange={(e) => setRetryIntervalSec(Number(e.target.value))} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Max retry window (minutes)</Label>
                <Input type="number" min={1} max={120} value={retryMaxMinutes} onChange={(e) => setRetryMaxMinutes(Number(e.target.value))} />
              </div>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            {tatkalMode
              ? "Tatkal mode: retry interval recommended 1-2s, window 10-15 min. AC classes open at 10 AM, non-AC at 11 AM."
              : "Regular mode: retry interval recommended 5-10s. Use Tatkal mode for time-critical bookings."}
          </p>
        </div>

        {/* Payment + safety */}
        <div className="space-y-3">
          <div className="space-y-2">
            <Label>Payment method (auto-select on payment page)</Label>
            <Select value={paymentMethod} onValueChange={setPaymentMethod}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {PAYMENT_METHODS.map((m) => (
                  <SelectItem key={m.code} value={m.code}>{m.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Agent clicks this option on the IRCTC payment page. Only applies when auto-confirm booking is ON
              (otherwise the agent pauses before payment and you select manually).
            </p>
          </div>

          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <div className="text-sm font-medium">Pause before payment</div>
              <p className="text-xs text-muted-foreground">Stops at the review page so you complete payment manually. Strongly recommended for real money.</p>
            </div>
            <Checkbox checked={pauseBeforePayment} onCheckedChange={(v) => setPauseBeforePayment(v === true)} />
          </div>
          <div className="flex items-center justify-between rounded-md border p-3 border-red-500/30 bg-red-50/40 dark:bg-red-950/20">
            <div>
              <div className="text-sm font-medium">Auto-confirm booking (skip pause)</div>
              <p className="text-xs text-muted-foreground">Clicks through to payment automatically. The agent will not enter OTP/card details — it just reaches the payment page with your chosen method pre-selected.</p>
            </div>
            <Checkbox checked={autoConfirmBooking} onCheckedChange={(v) => setAutoConfirmBooking(v === true)} />
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex flex-col sm:flex-row gap-2">
          <Button onClick={onSubmit} disabled={submitting || testing} className="flex-1 gap-2 bg-amber-600 hover:bg-amber-700 text-white">
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
            {dryRun ? "Start Dry-Run Booking" : "Start Booking"}
          </Button>
          <Button onClick={onTest} disabled={submitting || testing} variant="outline" className="flex-1 gap-2 border-amber-500 text-amber-700 hover:bg-amber-50">
            {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <FlaskConical className="h-4 w-4" />}
            Test Booking (dry-run)
          </Button>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <Checkbox id="dryRunToggle" checked={dryRun} onCheckedChange={(v) => setDryRun(v === true)} />
          <label htmlFor="dryRunToggle" className="text-muted-foreground cursor-pointer">
            Mark this real booking as dry-run too (will not attempt payment)
          </label>
        </div>
      </CardContent>
    </Card>
  );
}
