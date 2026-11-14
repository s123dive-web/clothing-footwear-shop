import { describe, it, expect, vi } from "vitest";
import { buildReport, trimPlan, createReporter, ERRORS_KEEP } from "./errorReport.js";

describe("buildReport", () => {
  it("records what, when, where — capped in size", () => {
    const err = new Error("x".repeat(900));
    err.stack = "s".repeat(5000);
    const r = buildReport(
      "crash",
      err,
      { where: "Dashboard" },
      { now: 5, device: "Android Chrome", user: "o@x.com", version: "1" }
    );
    expect(r).toMatchObject({
      at: 5,
      kind: "crash",
      device: "Android Chrome",
      user: "o@x.com",
      version: "1",
      where: "Dashboard",
    });
    expect(r.message.length).toBeLessThanOrEqual(501);
    expect(r.stack.length).toBeLessThanOrEqual(2001);
  });
  it("includes a Firebase error code, and accepts non-Error values", () => {
    expect(
      buildReport("sync", { code: "PERMISSION_DENIED", message: "nope" }, {}, { now: 1 }).message
    ).toBe("PERMISSION_DENIED: nope");
    expect(buildReport("crash", "plain text", {}, { now: 1 }).message).toBe("plain text");
    expect(buildReport("crash", undefined, {}, { now: 1 }).message).toBe("undefined");
  });
});

describe("trimPlan", () => {
  it("keeps only the newest reports", () => {
    const all = Object.fromEntries(
      Array.from({ length: ERRORS_KEEP + 3 }, (_, i) => ["e" + i, { at: i }])
    );
    expect(trimPlan(all).sort()).toEqual(["e0", "e1", "e2"]);
    expect(trimPlan({ a: { at: 1 } })).toEqual([]);
    expect(trimPlan(null)).toEqual([]);
  });
});

describe("createReporter", () => {
  const make = () => {
    const write = vi.fn(() => Promise.resolve());
    let t = 0;
    let n = 0;
    const report = createReporter({
      write,
      newId: () => "id" + n++,
      now: () => t,
      context: () => ({ device: "d" }),
    });
    return { write, report, tick: (ms) => (t += ms) };
  };
  it("writes a report", () => {
    const { write, report } = make();
    expect(report("crash", new Error("boom"))).toBe(true);
    expect(write).toHaveBeenCalledWith(
      "id0",
      expect.objectContaining({ kind: "crash", message: "boom", device: "d" })
    );
  });
  it("does not repeat the same error within a minute, and caps reports per session", () => {
    const { write, report, tick } = make();
    report("sync", new Error("same"));
    expect(report("sync", new Error("same"))).toBe(false);
    tick(61000);
    expect(report("sync", new Error("same"))).toBe(true);
    for (let i = 0; i < 40; i++) report("crash", new Error("e" + i));
    expect(write).toHaveBeenCalledTimes(15);
  });
  it("never throws, even if the writer does", () => {
    const report = createReporter({
      write: () => {
        throw new Error("db down");
      },
      newId: () => "x",
    });
    expect(() => report("crash", new Error("boom"))).not.toThrow();
    const rejecting = createReporter({
      write: () => Promise.reject(new Error("denied")),
      newId: () => "y",
    });
    expect(() => rejecting("crash", new Error("boom"))).not.toThrow();
  });
});
