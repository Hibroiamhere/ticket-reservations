"use client";

/**
 * Sessions manager — create, login (open IRCTC window), save, verify, delete.
 *
 * Flow:
 *   1. Click "Create session" — adds an empty session row.
 *   2. Click "Open IRCTC login" — opens a visible Chromium window for the
 *      user to log in manually (and solve the captcha).
 *   3. After logging in, click "I'm logged in — Save" — persists cookies
 *      + localStorage. The session is now ready for booking.
 *   4. "Verify" — opens a headless browser to check the session is still
 *      valid. Useful before running a job.
 *   5. "Delete" — removes the session record + storage file.
 */

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Loader2, LogIn, Save, ShieldCheck, Trash2, Plus, ExternalLink, AlertTriangle } from "lucide-react";
import * as api from "@/lib/dashboard/api";
import type { SessionDTO } from "@/lib/agent/types";

interface Props {
  sessions: SessionDTO[];
  onChange: () => void;
}

export function SessionsManager({ sessions, onChange }: Props) {
  const { toast } = useToast();
  const [newLabel, setNewLabel] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loginOpenId, setLoginOpenId] = useState<string | null>(null);

  const create = async () => {
    try {
      await api.createSession(newLabel || "IRCTC session");
      setNewLabel("");
      onChange();
      toast({ title: "Session created", description: "Now click 'Open IRCTC login' to start a manual login." });
    } catch (err) {
      toast({ title: "Failed", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    }
  };

  const startLogin = async (id: string) => {
    setBusyId(id);
    try {
      await api.startLogin(id);
      setLoginOpenId(id);
      toast({
        title: "IRCTC login window opened",
        description: "Log in to IRCTC in the new browser window (solve the captcha yourself). When done, click 'I'm logged in — Save'.",
      });
    } catch (err) {
      toast({
        title: "Could not open login window",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setBusyId(null);
    }
  };

  const saveLogin = async (id: string) => {
    setBusyId(id);
    try {
      const r = await api.saveLogin(id);
      setLoginOpenId(null);
      onChange();
      toast({ title: "Session saved", description: r.loggedInAs ? `Logged in as ${r.loggedInAs}` : "Cookies + storage persisted." });
    } catch (err) {
      toast({ title: "Save failed", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const cancelLogin = async (id: string) => {
    await api.cancelLogin(id);
    setLoginOpenId(null);
  };

  const verify = async (id: string) => {
    setBusyId(id);
    try {
      const r = await api.verifySession(id);
      onChange();
      toast({
        title: r.loggedIn ? "Session valid" : "Session invalid",
        description: r.loggedIn
          ? `Logged in as ${r.loggedInAs ?? "unknown"}`
          : "IRCTC no longer considers you logged in. Re-open login and save again.",
        variant: r.loggedIn ? "default" : "destructive",
      });
    } catch (err) {
      toast({ title: "Verify failed", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this session? Saved cookies will be removed.")) return;
    await api.deleteSession(id);
    onChange();
    toast({ title: "Session deleted" });
  };

  return (
    <div className="space-y-4">
      <Card className="border-amber-500/30 bg-amber-50/40 dark:bg-amber-950/20">
        <CardContent className="pt-4 pb-4 flex gap-3">
          <AlertTriangle className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="text-sm space-y-1">
            <p className="font-medium">How sessions work</p>
            <p className="text-muted-foreground">
              We never store your IRCTC password. Instead, you log in once in a real browser window that the agent opens —
              we save only the resulting cookies. If IRCTC expires the session (usually after a few days), just re-login
              and click Save again.
            </p>
            <p className="text-muted-foreground">
              The login window requires a display. On a headless server, run with <code className="text-xs bg-muted px-1 rounded">xvfb-run bun run dev</code> or set <code className="text-xs bg-muted px-1 rounded">DISPLAY=:99</code>.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Plus className="h-5 w-5 text-amber-600" /> Create new session</CardTitle>
          <CardDescription>Give it a label so you can tell multiple accounts apart.</CardDescription>
        </CardHeader>
        <CardContent className="flex gap-3">
          <Input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="e.g. Personal IRCTC account" />
          <Button onClick={create} className="gap-2 bg-amber-600 hover:bg-amber-700 text-white">
            <Plus className="h-4 w-4" /> Create
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Saved sessions ({sessions.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {sessions.length === 0 && <div className="text-sm text-muted-foreground">No sessions yet — create one above.</div>}
          {sessions.map((s) => (
            <div key={s.id} className="rounded-md border p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{s.label}</div>
                  <div className="text-xs text-muted-foreground">
                    Created {new Date(s.createdAt).toLocaleString()}
                    {s.lastVerifiedAt && ` · Last verified ${new Date(s.lastVerifiedAt).toLocaleString()}`}
                  </div>
                  {s.loggedInAs && <div className="text-xs mt-1">Logged in as: <span className="font-medium">{s.loggedInAs}</span></div>}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {s.isActive && s.loggedInAs && <Badge variant="default" className="bg-emerald-600">Active</Badge>}
                  {!s.loggedInAs && <Badge variant="outline">Needs login</Badge>}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {loginOpenId === s.id ? (
                  <>
                    <Button size="sm" onClick={() => saveLogin(s.id)} disabled={busyId === s.id} className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white">
                      {busyId === s.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                      I&apos;m logged in — Save
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => cancelLogin(s.id)}>Cancel login</Button>
                  </>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => startLogin(s.id)} disabled={busyId === s.id} className="gap-2">
                    {busyId === s.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
                    Open IRCTC login
                  </Button>
                )}
                <Button size="sm" variant="outline" onClick={() => verify(s.id)} disabled={busyId === s.id} className="gap-2">
                  <ShieldCheck className="h-4 w-4" /> Verify
                </Button>
                <Button size="sm" variant="ghost" onClick={() => remove(s.id)} className="gap-2 text-red-600 hover:text-red-700">
                  <Trash2 className="h-4 w-4" /> Delete
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
