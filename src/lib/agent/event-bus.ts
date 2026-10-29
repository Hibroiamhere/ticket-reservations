/**
 * In-process event bus for streaming job logs to SSE clients.
 *
 * Each subscriber gets a buffered iterator that yields LogEvents in real time.
 * When a job emits a log, all subscribers for that jobId receive it.
 * Subscribers also receive a small replay of recent logs so a freshly opened
 * SSE connection immediately shows history.
 */

import type { LogEvent, LogLevel } from "./types";

type Subscriber = {
  push: (event: LogEvent) => void;
  close: () => void;
};

// jobId -> recent log buffer + active subscribers
const MAX_BUFFER = 200;

class JobChannel {
  recent: LogEvent[] = [];
  subscribers = new Set<Subscriber>();

  emit(event: LogEvent) {
    this.recent.push(event);
    if (this.recent.length > MAX_BUFFER) this.recent.shift();
    for (const sub of this.subscribers) {
      try {
        sub.push(event);
      } catch {
        // subscriber gone — ignore
      }
    }
  }

  subscribe(sub: Subscriber) {
    this.subscribers.add(sub);
    // replay
    for (const e of this.recent) sub.push(e);
  }

  unsubscribe(sub: Subscriber) {
    this.subscribers.delete(sub);
  }

  close() {
    for (const sub of this.subscribers) sub.close();
    this.subscribers.clear();
  }
}

class EventBus {
  private channels = new Map<string, JobChannel>();

  private channel(jobId: string): JobChannel {
    let ch = this.channels.get(jobId);
    if (!ch) {
      ch = new JobChannel();
      this.channels.set(jobId, ch);
    }
    return ch;
  }

  emit(jobId: string, level: LogLevel, message: string, screenshotPath?: string) {
    const event: LogEvent = {
      jobId,
      ts: new Date().toISOString(),
      level,
      message,
      screenshotPath,
    };
    this.channel(jobId).emit(event);
  }

  subscribe(jobId: string): { next: () => Promise<LogEvent | null>; close: () => void } {
    const ch = this.channel(jobId);
    const queue: LogEvent[] = [];
    let waiting: ((e: LogEvent | null) => void) | null = null;
    let closed = false;

    const sub: Subscriber = {
      push: (event) => {
        if (waiting) {
          const resolve = waiting;
          waiting = null;
          resolve(event);
        } else {
          queue.push(event);
        }
      },
      close: () => {
        closed = true;
        if (waiting) {
          const resolve = waiting;
          waiting = null;
          resolve(null);
        }
      },
    };

    ch.subscribe(sub);

    return {
      next: () =>
        new Promise<LogEvent | null>((resolve) => {
          if (closed) return resolve(null);
          if (queue.length > 0) return resolve(queue.shift()!);
          waiting = resolve;
        }),
      close: () => {
        ch.unsubscribe(sub);
      },
    };
  }

  /** Drop a channel entirely (called when a job is fully finished & old). */
  drop(jobId: string) {
    const ch = this.channels.get(jobId);
    if (ch) {
      ch.close();
      this.channels.delete(jobId);
    }
  }
}

export const eventBus = new EventBus();
