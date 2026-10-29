/**
 * POST /api/settings/save
 * Body: { ...settings }
 * Upserts the singleton Settings row.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const data: Record<string, unknown> = {
    emailEnabled: Boolean(body.emailEnabled),
    smtpHost: body.smtpHost ? String(body.smtpHost) : null,
    smtpPort: body.smtpPort ? Number(body.smtpPort) : null,
    smtpUser: body.smtpUser ? String(body.smtpUser) : null,
    smtpFrom: body.smtpFrom ? String(body.smtpFrom) : null,
    notifyEmail: body.notifyEmail ? String(body.notifyEmail) : null,
    defaultRetryIntervalSec: Number(body.defaultRetryIntervalSec ?? 5),
    defaultRetryMaxMinutes: Number(body.defaultRetryMaxMinutes ?? 15),
  };
  // Only update password if the client sent a non-empty value. The form
  // shows "•••••" placeholder when a password is already stored.
  if (body.smtpPass && body.smtpPass.trim() !== "") {
    data.smtpPass = String(body.smtpPass);
  }

  const settings = await db.settings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", ...data, smtpPass: data.smtpPass as string | null ?? null },
    update: data,
  });

  return NextResponse.json({ ok: true, emailEnabled: settings.emailEnabled });
}
