/**
 * Logger that writes to the database AND emits to the SSE event bus.
 *
 * Each job has one logger instance. The runner and the agent both use it
 * so the dashboard gets a single unified timeline of what's happening.
 */

import { db } from "@/lib/db";
import { eventBus } from "./event-bus";
import type { LogLevel } from "./types";

export class JobLogger {
  constructor(private jobId: string) {}

  async info(message: string) {
    await this.write("info", message);
  }

  async step(message: string) {
    await this.write("step", message);
  }

  async success(message: string) {
    await this.write("success", message);
  }

  async warn(message: string) {
    await this.write("warn", message);
  }

  async error(message: string) {
    await this.write("error", message);
  }

  async screenshot(path: string, caption: string) {
    await this.write("screenshot", caption, path);
  }

  private async write(level: LogLevel, message: string, screenshotPath?: string) {
    // Emit to SSE first so the dashboard is live.
    eventBus.emit(this.jobId, level, message, screenshotPath);

    // Then persist to DB. Fire-and-forget for non-blocking, but await on
    // important events so we don't lose them on crash.
    try {
      await db.logEntry.create({
        data: {
          jobId: this.jobId,
          level,
          message,
          screenshotPath: screenshotPath ?? null,
        },
      });
    } catch {
      // DB write failure shouldn't kill the job.
    }
  }
}
