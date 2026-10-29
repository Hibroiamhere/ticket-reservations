/**
 * Shared types for the IRCTC auto-booking agent.
 */

export type JobStatus =
  | "pending"
  | "running"
  | "paused_review"
  | "paused_payment"
  | "success"
  | "failed"
  | "cancelled"
  | "exhausted";

export type LogLevel = "info" | "warn" | "error" | "success" | "step" | "screenshot";

export interface LogEvent {
  jobId: string;
  ts: string; // ISO timestamp
  level: LogLevel;
  message: string;
  screenshotPath?: string;
}

/** Shape of the booking form the dashboard submits. */
export interface BookingRequest {
  sessionId: string;
  fromStation: string;
  fromStationName?: string;
  toStation: string;
  toStationName?: string;
  journeyDate: string; // YYYY-MM-DD
  travelClass: "SL" | "3A" | "2A" | "1A" | "CC" | "EC" | "2S";
  quota: "GN" | "TQ" | "PT" | "LD" | "HP";
  preferredTrains?: string[]; // train numbers, e.g. ["12951", "12259"]
  passengerIds: string[];
  contactMobile: string;
  contactEmail: string;
  retryEnabled: boolean;
  retryIntervalSec: number;
  retryMaxMinutes: number;
  autoConfirmBooking: boolean;
  pauseBeforePayment: boolean;
}

export interface PassengerDTO {
  id: string;
  name: string;
  age: number;
  gender: "M" | "F" | "T";
  berthPref: string;
  foodPref: string;
  nationality: string;
  isPrimary: boolean;
  aadhaarLast4?: string | null;
}

export interface SessionDTO {
  id: string;
  label: string;
  isActive: boolean;
  loggedInAs: string | null;
  lastVerifiedAt: string | null;
  createdAt: string;
}

export interface JobDTO {
  id: string;
  status: JobStatus;
  currentStep: string | null;
  attemptCount: number;
  lastMessage: string | null;
  fromStation: string;
  fromStationName: string | null;
  toStation: string;
  toStationName: string | null;
  journeyDate: string;
  travelClass: string;
  quota: string;
  preferredTrains: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  resultJson: string | null;
}

/** Result of one attempt inside the runner. */
export type AttemptOutcome =
  | { kind: "success"; pnr?: string; transactionId?: string; reviewScreenshot?: string }
  | { kind: "paused_review"; screenshotPath: string; message: string }
  | { kind: "paused_payment"; screenshotPath: string; message: string }
  | { kind: "retry"; reason: string }
  | { kind: "fatal"; reason: string };

export const TRAVEL_CLASSES = [
  { code: "SL", label: "Sleeper (SL)" },
  { code: "3A", label: "AC 3 Tier (3A)" },
  { code: "2A", label: "AC 2 Tier (2A)" },
  { code: "1A", label: "AC First (1A)" },
  { code: "CC", label: "AC Chair Car (CC)" },
  { code: "EC", label: "Exec Chair (EC)" },
  { code: "2S", label: "Second Sitting (2S)" },
] as const;

export const QUOTAS = [
  { code: "GN", label: "General" },
  { code: "TQ", label: "Tatkal" },
  { code: "PT", label: "Premium Tatkal" },
  { code: "LD", label: "Ladies" },
  { code: "HP", label: "Handicapped / Divyang" },
] as const;

export const BERTH_PREFERENCES = [
  { code: "NC", label: "No Choice" },
  { code: "LB", label: "Lower" },
  { code: "MB", label: "Middle" },
  { code: "UB", label: "Upper" },
  { code: "SL", label: "Side Lower" },
  { code: "SU", label: "Side Upper" },
  { code: "WS", label: "Window Side" },
] as const;

export const FOOD_PREFERENCES = [
  { code: "D", label: "No Food" },
  { code: "V", label: "Veg" },
  { code: "N", label: "Non-Veg" },
] as const;
