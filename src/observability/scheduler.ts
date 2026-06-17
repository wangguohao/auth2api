import { Config } from "../config";
import { generateDailyReport } from "./report";
import { previousDateKey, TraceRecorder } from "./trace";

export class DailyReportScheduler {
  private timer: NodeJS.Timeout | null = null;
  private config: Config;
  private recorder: TraceRecorder;
  private sendMail?: (
    subject: string,
    body: { text: string; html?: string },
    recipients: string[],
  ) => Promise<void>;

  constructor(
    config: Config,
    recorder: TraceRecorder,
    sendMail?: (
      subject: string,
      body: { text: string; html?: string },
      recipients: string[],
    ) => Promise<void>,
  ) {
    this.config = config;
    this.recorder = recorder;
    this.sendMail = sendMail;
  }

  start(): void {
    if (
      !this.config.observability.enabled ||
      !this.config.observability.report.enabled
    ) {
      return;
    }
    this.scheduleNext();
  }

  stop(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private scheduleNext(): void {
    const delay = this.nextDelayMs();
    this.timer = setTimeout(() => {
      this.run().finally(() => this.scheduleNext());
    }, delay);
    this.timer.unref();
  }

  private async run(): Promise<void> {
    const timezone = this.config.observability.report.timezone;
    const date = previousDateKey(new Date(), timezone);
    try {
      const result = await generateDailyReport(
        this.config,
        this.recorder,
        { date, sendEmail: true },
        this.sendMail,
      );
      this.recorder.prune();
      console.log(
        `[observability] daily report generated for ${date}: ${result.htmlFilePath}`,
      );
    } catch (err: any) {
      console.error(
        `[observability] daily report failed for ${date}: ${err?.message || String(err)}`,
      );
    }
  }

  private nextDelayMs(): number {
    const now = new Date();
    const timezone = this.config.observability.report.timezone;
    const parts = zonedParts(now, timezone);
    let targetUtcMs = zonedTimeToUtcMs(
      parts.year,
      parts.month,
      parts.day,
      this.config.observability.report.scheduleHour,
      timezone,
    );
    if (targetUtcMs <= now.getTime()) {
      const nextDay = new Date(
        Date.UTC(parts.year, parts.month - 1, parts.day) + 24 * 60 * 60 * 1000,
      );
      targetUtcMs = zonedTimeToUtcMs(
        nextDay.getUTCFullYear(),
        nextDay.getUTCMonth() + 1,
        nextDay.getUTCDate(),
        this.config.observability.report.scheduleHour,
        timezone,
      );
    }
    return Math.max(1_000, targetUtcMs - now.getTime());
  }
}

function zonedParts(
  date: Date,
  timezone: string,
): {
  year: number;
  month: number;
  day: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value || "0");
  return { year: get("year"), month: get("month"), day: get("day") };
}

function timezoneOffsetMs(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value || "0");
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc - date.getTime();
}

function zonedTimeToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  timezone: string,
): number {
  let utcMs = Date.UTC(year, month - 1, day, hour, 0, 0);
  utcMs =
    Date.UTC(year, month - 1, day, hour, 0, 0) -
    timezoneOffsetMs(new Date(utcMs), timezone);
  return (
    Date.UTC(year, month - 1, day, hour, 0, 0) -
    timezoneOffsetMs(new Date(utcMs), timezone)
  );
}
