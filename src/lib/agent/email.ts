/**
 * Email notifications via nodemailer.
 *
 * Reads SMTP config from the singleton Settings row. If email isn't
 * configured, notification calls silently no-op (the dashboard shows
 * a banner telling the user to configure SMTP).
 */

import nodemailer from "nodemailer";
import { db } from "@/lib/db";
import { JobLogger } from "./logger";

export type NotificationKind = "success" | "failed" | "cancelled" | "exhausted" | "paused_payment";

export interface NotificationPayload {
  message?: string;
  reason?: string;
  screenshotPath?: string;
  pnr?: string;
  transactionId?: string;
}

async function getSettings() {
  return db.settings.findUnique({ where: { id: "singleton" } });
}

export async function isEmailConfigured(): Promise<boolean> {
  const s = await getSettings();
  if (!s || !s.emailEnabled) return false;
  return !!(s.smtpHost && s.smtpPort && s.smtpUser && s.smtpPass && s.smtpFrom && s.notifyEmail);
}

export async function sendBookingNotification(jobId: string, kind: NotificationKind, payload: NotificationPayload) {
  const s = await getSettings();
  if (!s || !s.emailEnabled || !s.smtpHost || !s.smtpUser || !s.smtpPass || !s.smtpFrom || !s.notifyEmail) {
    // Email not configured — silently skip. Dashboard will show a banner.
    return false;
  }

  const job = await db.bookingJob.findUnique({ where: { id: jobId } });
  if (!job) return false;

  const subject = subjectFor(kind, job);
  const body = bodyFor(kind, job, payload);

  const transporter = nodemailer.createTransport({
    host: s.smtpHost,
    port: s.smtpPort,
    secure: s.smtpPort === 465,
    auth: { user: s.smtpUser, pass: s.smtpPass },
  });

  try {
    await transporter.sendMail({
      from: s.smtpFrom,
      to: s.notifyEmail,
      subject,
      text: body,
      attachments: payload.screenshotPath
        ? [{ filename: "screenshot.png", path: payload.screenshotPath }]
        : undefined,
    });
    const logger = new JobLogger(jobId);
    await logger.info(`Email notification sent to ${s.notifyEmail} (${kind}).`);
    return true;
  } catch (err) {
    const logger = new JobLogger(jobId);
    await logger.warn(`Email notification failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function subjectFor(kind: NotificationKind, job: { fromStation: string; toStation: string; journeyDate: string; travelClass: string }): string {
  const route = `${job.fromStation} → ${job.toStation}`;
  const date = job.journeyDate;
  switch (kind) {
    case "success":
      return `[Booking Success] ${route} on ${date} (${job.travelClass})`;
    case "failed":
      return `[Booking Failed] ${route} on ${date}`;
    case "cancelled":
      return `[Booking Cancelled] ${route} on ${date}`;
    case "exhausted":
      return `[Booking Retries Exhausted] ${route} on ${date}`;
    case "paused_payment":
      return `[Action Required] Complete payment for ${route} on ${date}`;
  }
}

function bodyFor(kind: NotificationKind, job: {
  fromStation: string; toStation: string; journeyDate: string; travelClass: string; quota: string;
  preferredTrains: string | null; contactMobile: string; contactEmail: string; attemptCount: number;
}, payload: NotificationPayload): string {
  const lines: string[] = [];
  lines.push(`IRCTC Booking Agent — ${kind.toUpperCase()}`);
  lines.push("");
  lines.push(`Route:           ${job.fromStation} → ${job.toStation}`);
  lines.push(`Journey date:    ${job.journeyDate}`);
  lines.push(`Class / Quota:   ${job.travelClass} / ${job.quota}`);
  if (job.preferredTrains) lines.push(`Preferred trains: ${job.preferredTrains}`);
  lines.push(`Attempts made:   ${job.attemptCount}`);
  lines.push(`Contact:         ${job.contactMobile} / ${job.contactEmail}`);
  lines.push("");
  switch (kind) {
    case "success":
      lines.push("Booking completed successfully.");
      if (payload.pnr) lines.push(`PNR: ${payload.pnr}`);
      if (payload.transactionId) lines.push(`Transaction ID: ${payload.transactionId}`);
      break;
    case "failed":
      lines.push(`Booking failed: ${payload.reason ?? "unknown error"}`);
      lines.push("Please check the dashboard for full logs.");
      break;
    case "cancelled":
      lines.push(`Booking cancelled: ${payload.reason ?? "user-initiated"}`);
      break;
    case "exhausted":
      lines.push(`Retry window exhausted: ${payload.reason ?? "no availability found"}`);
      lines.push("You may want to try a different train, date, or quota.");
      break;
    case "paused_payment":
      lines.push(payload.message ?? "Booking reached the review page. Please complete payment manually in the IRCTC browser window, or click Continue in the dashboard.");
      break;
  }
  lines.push("");
  lines.push("— IRCTC Auto-Booking Agent");
  return lines.join("\n");
}
