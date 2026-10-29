"use client";

/**
 * Settings panel — SMTP/email config + retry defaults.
 * SMTP password is never echoed back from the server; we show "configured"
 * vs "not configured" based on the smtpPassSet flag.
 */

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Save, Mail } from "lucide-react";
import * as api from "@/lib/dashboard/api";

export function SettingsPanel() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState(587);
  const [smtpUser, setSmtpUser] = useState("");
  const [smtpPass, setSmtpPass] = useState("");
  const [smtpPassSet, setSmtpPassSet] = useState(false);
  const [smtpFrom, setSmtpFrom] = useState("");
  const [notifyEmail, setNotifyEmail] = useState("");
  const [defaultRetryIntervalSec, setDefaultRetryIntervalSec] = useState(5);
  const [defaultRetryMaxMinutes, setDefaultRetryMaxMinutes] = useState(15);

  useEffect(() => {
    (async () => {
      try {
        const s = await api.getSettings();
        setEmailEnabled(Boolean(s.emailEnabled));
        setSmtpHost(String(s.smtpHost ?? ""));
        setSmtpPort(Number(s.smtpPort ?? 587));
        setSmtpUser(String(s.smtpUser ?? ""));
        setSmtpPassSet(Boolean(s.smtpPassSet));
        setSmtpFrom(String(s.smtpFrom ?? ""));
        setNotifyEmail(String(s.notifyEmail ?? ""));
        setDefaultRetryIntervalSec(Number(s.defaultRetryIntervalSec ?? 5));
        setDefaultRetryMaxMinutes(Number(s.defaultRetryMaxMinutes ?? 15));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await api.saveSettings({
        emailEnabled,
        smtpHost,
        smtpPort,
        smtpUser,
        smtpPass: smtpPass || undefined, // don't overwrite existing with empty
        smtpFrom,
        notifyEmail,
        defaultRetryIntervalSec,
        defaultRetryMaxMinutes,
      });
      setSmtpPass("");
      toast({ title: "Settings saved" });
      // Refresh to get updated smtpPassSet flag.
      const s = await api.getSettings();
      setSmtpPassSet(Boolean(s.smtpPassSet));
    } catch (err) {
      toast({ title: "Save failed", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="flex justify-center p-8"><Loader2 className="h-6 w-6 animate-spin text-amber-600" /></div>;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Mail className="h-5 w-5 text-amber-600" /> Email notifications</CardTitle>
          <CardDescription>Get an email when a booking succeeds, fails, or pauses for payment. SMTP info is stored locally only.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-center gap-3">
            <Checkbox checked={emailEnabled} onCheckedChange={(v) => setEmailEnabled(v === true)} />
            <span className="text-sm">Enable email notifications</span>
          </label>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="smtpHost">SMTP host</Label>
              <Input id="smtpHost" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} placeholder="smtp.gmail.com" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="smtpPort">SMTP port</Label>
              <Input id="smtpPort" type="number" value={smtpPort} onChange={(e) => setSmtpPort(Number(e.target.value))} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="smtpUser">SMTP username</Label>
              <Input id="smtpUser" value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} placeholder="you@gmail.com" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="smtpPass">SMTP password / app password</Label>
              <Input id="smtpPass" type="password" value={smtpPass} onChange={(e) => setSmtpPass(e.target.value)} placeholder={smtpPassSet ? "•••••••• (configured — leave blank to keep)" : "app password"} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="smtpFrom">From address</Label>
              <Input id="smtpFrom" type="email" value={smtpFrom} onChange={(e) => setSmtpFrom(e.target.value)} placeholder="you@gmail.com" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="notifyEmail">Notify (to)</Label>
              <Input id="notifyEmail" type="email" value={notifyEmail} onChange={(e) => setNotifyEmail(e.target.value)} placeholder="you@gmail.com" />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            For Gmail, use an <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer" className="underline">App Password</a> (not your regular password).
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Retry defaults</CardTitle>
          <CardDescription>Used to pre-fill the booking form.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>Default retry interval (seconds)</Label>
            <Input type="number" min={3} max={60} value={defaultRetryIntervalSec} onChange={(e) => setDefaultRetryIntervalSec(Number(e.target.value))} />
          </div>
          <div className="space-y-2">
            <Label>Default retry window (minutes)</Label>
            <Input type="number" min={1} max={120} value={defaultRetryMaxMinutes} onChange={(e) => setDefaultRetryMaxMinutes(Number(e.target.value))} />
          </div>
        </CardContent>
      </Card>

      <Button onClick={save} disabled={saving} className="gap-2 bg-amber-600 hover:bg-amber-700 text-white">
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        Save settings
      </Button>
    </div>
  );
}
