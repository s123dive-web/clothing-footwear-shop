import { describe, it, expect } from "vitest";
import { roleFrom, STAFF_TABS, STAFF_SLICES } from "./role.js";

describe("roleFrom", () => {
  it("a staff entry means staff", () =>
    expect(roleFrom({ value: { role: "staff" } })).toBe("staff"));
  it("no entry but able to read the shop, or an owner entry, means owner", () => {
    expect(roleFrom({ value: null, owner: true })).toBe("owner");
    expect(roleFrom({ value: { role: "owner" } })).toBe("owner");
  });
  it("a refused read, a missing entry without shop access, or an unknown role means no access", () => {
    expect(roleFrom({ denied: true })).toBe("none");
    expect(roleFrom({ value: null })).toBe("none");
    expect(roleFrom({ value: { role: "something-else" } })).toBe("none");
    expect(roleFrom(undefined)).toBe("none");
  });
  it("staff see no profit / admin tabs and subscribe only to products and bills", () => {
    for (const t of [
      "dashboard",
      "stats",
      "finance",
      "expense",
      "admin",
      "settings",
      "raw",
      "logs",
      "vendorbills",
      "dailybills",
    ])
      expect(STAFF_TABS).not.toContain(t);
    expect(STAFF_TABS).toContain("billing");
    expect(STAFF_SLICES).toEqual(["items", "sales"]);
  });
});
