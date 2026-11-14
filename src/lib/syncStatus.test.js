import { describe, it, expect } from "vitest";
import { syncSummary } from "./syncStatus.js";

const op = (label, error) => ({ id: label + Math.random(), label, ...(error ? { error } : {}) });

describe("syncSummary", () => {
  it("online and nothing pending", () => {
    expect(syncSummary(true, [])).toMatchObject({ tone: "ok", text: "Online · syncing live" });
  });
  it("offline with nothing pending", () => {
    expect(syncSummary(false, [])).toMatchObject({
      tone: "offline",
      text: "Offline · saved on this device",
    });
  });
  it("counts bills waiting, singular and plural", () => {
    expect(syncSummary(false, [op("sale")]).text).toBe("Offline · 1 bill waiting to sync");
    expect(syncSummary(false, [op("sale"), op("sale-edit"), op("sale-delete")]).text).toBe(
      "Offline · 3 bills waiting to sync"
    );
  });
  it("separates bills from other changes", () => {
    const s = syncSummary(false, [op("sale"), op("sale"), op("expenses"), op("logs"), op("logs")]);
    expect(s.text).toBe("Offline · 2 bills + 3 other changes waiting to sync");
    expect(s).toMatchObject({ bills: 2, others: 3, short: "5 waiting" });
  });
  it("only non-bill changes", () => {
    expect(syncSummary(false, [op("expenses")]).text).toBe("Offline · 1 change waiting to sync");
  });
  it("online with failures asks for a retry", () => {
    const s = syncSummary(true, [op("sale", "PERMISSION_DENIED"), op("logs")]);
    expect(s).toMatchObject({ tone: "error", failed: 1 });
    expect(s.text).toBe("1 change not synced — tap to retry");
  });
  it("online and still sending", () => {
    expect(syncSummary(true, [op("sale")])).toMatchObject({
      tone: "pending",
      text: "Online · syncing 1 bill…",
    });
  });
});
