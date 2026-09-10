import { describe, expect, it } from "vitest";
import { eventRange, localDate, startOfDay, transactionRange } from "./time-range.ts";

describe("time ranges", () => {
  const now = new Date("2026-09-10T09:00:00.000Z"); // Thursday

  it("computes today / tomorrow / week in UTC by default", () => {
    expect(eventRange("today", { now })).toEqual({ from: "2026-09-10T00:00:00.000Z", to: "2026-09-11T00:00:00.000Z" });
    expect(eventRange("tomorrow", { now })).toEqual({ from: "2026-09-11T00:00:00.000Z", to: "2026-09-12T00:00:00.000Z" });
    expect(eventRange("week", { now })).toEqual({ from: "2026-09-07T00:00:00.000Z", to: "2026-09-14T00:00:00.000Z" });
    expect(eventRange({ from: "2026-01-01", to: "2026-02-01" }, { now })).toEqual({ from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z" });
  });

  it("uses the given IANA timezone for day boundaries", () => {
    const stockholm = { now, timezone: "Europe/Stockholm" }; // CEST, UTC+2 in September
    expect(eventRange("today", stockholm)).toEqual({ from: "2026-09-09T22:00:00.000Z", to: "2026-09-10T22:00:00.000Z" });
    expect(localDate(now, "Pacific/Honolulu")).toBe("2026-09-09");
    expect(startOfDay(now, "Pacific/Honolulu").toISOString()).toBe("2026-09-09T10:00:00.000Z");
    // Week starts Monday local time.
    expect(eventRange("week", stockholm).from).toBe("2026-09-06T22:00:00.000Z");
  });

  it("handles a DST transition inside the week without drifting", () => {
    const octoberNow = new Date("2026-10-27T12:00:00.000Z"); // Tuesday; Europe/Stockholm falls back on Sunday Oct 25 2026
    const r = eventRange("week", { now: octoberNow, timezone: "Europe/Stockholm" });
    expect(r.from).toBe("2026-10-25T23:00:00.000Z"); // Monday 26 Oct 00:00 CET (UTC+1, after the fall-back)
    expect(r.to).toBe("2026-11-01T23:00:00.000Z"); // Monday 2 Nov 00:00 CET
    const springNow = new Date("2026-03-31T12:00:00.000Z"); // Tuesday; spring forward Sunday Mar 29
    expect(eventRange("week", { now: springNow, timezone: "Europe/Stockholm" })).toEqual({ from: "2026-03-29T22:00:00.000Z", to: "2026-04-05T22:00:00.000Z" });
  });

  it("transaction ranges are inclusive posted-date windows", () => {
    expect(transactionRange("month", { now })).toEqual({ from: "2026-09-01", to: "2026-09-10" });
    expect(transactionRange("week", { now })).toEqual({ from: "2026-09-04", to: "2026-09-10" });
    expect(transactionRange("all", { now })).toBeNull();
    expect(transactionRange(undefined, { now })).toBeNull();
  });
});
