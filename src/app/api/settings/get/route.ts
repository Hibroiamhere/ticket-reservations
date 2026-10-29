/**
 * GET /api/settings/get
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET() {
  const settings = await db.settings.findUnique({ where: { id: "singleton" } });
  if (!settings) {
    return NextResponse.json({
      settings: {
        emailEnabled: false,
        smtpHost: "",
        smtpPort: 587,
        smtpUser: "",
        smtpPass: "",
        smtpFrom: "",
        notifyEmail: "",
        defaultRetryIntervalSec: 5,
        defaultRetryMaxMinutes: 15,
      },
    });
  }
  return NextResponse.json({
    settings: {
      emailEnabled: settings.emailEnabled,
      smtpHost: settings.smtpHost ?? "",
      smtpPort: settings.smtpPort ?? 587,
      smtpUser: settings.smtpUser ?? "",
      // Don't echo the password back to the client. We send a boolean flag
      // so the UI can show "configured / not configured".
      smtpPassSet: !!settings.smtpPass,
      smtpFrom: settings.smtpFrom ?? "",
      notifyEmail: settings.notifyEmail ?? "",
      defaultRetryIntervalSec: settings.defaultRetryIntervalSec,
      defaultRetryMaxMinutes: settings.defaultRetryMaxMinutes,
    },
  });
}
