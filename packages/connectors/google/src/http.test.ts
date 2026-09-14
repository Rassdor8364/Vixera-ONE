import { describe, expect, it } from "vitest";
import { mapConcurrent } from "./http.ts";

describe("mapConcurrent", () => {
  it("keeps input order with bounded concurrency", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const out = await mapConcurrent([5, 1, 3, 2, 4], 2, async (n) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, n));
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 30, 20, 40]);
    expect(maxInFlight).toBe(2);
  });

  it("stops dequeuing work after the first failure and rejects with that error once everything in flight settled", async () => {
    const started: number[] = [];
    let inFlight = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);
    const error = await mapConcurrent(items, 4, async (n) => {
      started.push(n);
      inFlight++;
      await new Promise((r) => setTimeout(r, n === 2 ? 1 : 5));
      inFlight--;
      if (n === 2) throw new Error("boom 2");
      return n;
    }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error?.message).toBe("boom 2");
    // the 4 in flight when item 2 failed, plus nothing dequeued afterwards
    expect(started).toEqual([0, 1, 2, 3]);
    // the promise only settles once the other workers finished their current item
    expect(inFlight).toBe(0);
  });
});
