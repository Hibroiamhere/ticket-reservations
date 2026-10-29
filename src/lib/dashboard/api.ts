/**
 * Client-side API helpers for the dashboard.
 * All calls go to relative paths under /api/... so they work both in dev
 * and behind the gateway.
 */

import type {
  BookingRequest,
  JobDTO,
  PassengerDTO,
  SessionDTO,
} from "@/lib/agent/types";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function listSessions(): Promise<SessionDTO[]> {
  const r = await json<{ sessions: SessionDTO[] }>(await fetch("/api/session/list"));
  return r.sessions;
}

export async function createSession(label: string): Promise<SessionDTO> {
  const r = await json<{ session: SessionDTO }>(await fetch("/api/session/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label }),
  }));
  return r.session;
}

export async function startLogin(sessionId: string): Promise<void> {
  await json(await fetch("/api/session/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  }));
}

export async function saveLogin(sessionId: string): Promise<{ loggedInAs?: string }> {
  const r = await json<{ loggedInAs?: string }>(await fetch("/api/session/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  }));
  return r;
}

export async function cancelLogin(sessionId: string): Promise<void> {
  await fetch("/api/session/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
}

export async function verifySession(sessionId: string): Promise<{ loggedIn: boolean; loggedInAs?: string; screenshotPath?: string }> {
  return json(await fetch("/api/session/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  }));
}

export async function deleteSession(sessionId: string): Promise<void> {
  await fetch("/api/session/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
}

export async function listPassengers(): Promise<PassengerDTO[]> {
  const r = await json<{ passengers: PassengerDTO[] }>(await fetch("/api/passengers/list"));
  return r.passengers;
}

export async function createPassenger(p: Omit<PassengerDTO, "id">): Promise<PassengerDTO> {
  const r = await json<{ passenger: PassengerDTO }>(await fetch("/api/passengers/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(p),
  }));
  return r.passenger;
}

export async function updatePassenger(id: string, fields: Partial<PassengerDTO>): Promise<PassengerDTO> {
  const r = await json<{ passenger: PassengerDTO }>(await fetch("/api/passengers/update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, ...fields }),
  }));
  return r.passenger;
}

export async function deletePassenger(id: string): Promise<void> {
  await fetch("/api/passengers/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
}

export async function startBooking(req: BookingRequest): Promise<string> {
  const r = await json<{ jobId: string }>(await fetch("/api/jobs/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  }));
  return r.jobId;
}

export async function listJobs(): Promise<JobDTO[]> {
  const r = await json<{ jobs: JobDTO[] }>(await fetch("/api/jobs/list"));
  return r.jobs;
}

export async function cancelJob(jobId: string): Promise<void> {
  await fetch("/api/jobs/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId }),
  });
}

export async function resumeJob(jobId: string, action: "proceed" | "cancel" | "retry"): Promise<void> {
  await fetch("/api/jobs/resume", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId, action }),
  });
}

export async function getSettings(): Promise<Record<string, unknown>> {
  const r = await json<{ settings: Record<string, unknown> }>(await fetch("/api/settings/get"));
  return r.settings;
}

export async function saveSettings(s: Record<string, unknown>): Promise<void> {
  await fetch("/api/settings/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(s),
  });
}
