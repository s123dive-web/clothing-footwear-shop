// The app's error reporter: sends crashes and sync failures to shop/meta/errors so the owner
// can see them from another device (Admin → Error reports). See errorReport.js for the logic.
import { auth } from "../config/firebase.js";
import { createReporter, trimPlan } from "./errorReport.js";
import { writeErrorReport, readErrorReports, removeErrorReports } from "./sync.js";
import { uid } from "./format.js";

const device = () => {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const m = ua.match(/(Android [\d.]+|iPhone OS [\d_]+|Windows NT [\d.]+|Mac OS X [\d_]+|Linux)/);
  const b = ua.match(/(Chrome|Firefox|Safari|Edg)\/[\d.]+/);
  return [
    m && m[1],
    b && b[0],
    typeof screen !== "undefined" ? `${screen.width}×${screen.height}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
};

export const reportError = createReporter({
  newId: () => uid(),
  context: () => ({
    device: device(),
    user: (auth && auth.currentUser && auth.currentUser.email) || "",
  }),
  // Only a signed-in user can write; before sign-in there is nowhere to report to.
  write: async (id, rec) => {
    if (!auth || !auth.currentUser) return;
    await writeErrorReport(id, rec);
    // Keep the list short. Only the owner may delete, so for staff this quietly does nothing.
    try {
      const extra = trimPlan(await readErrorReports());
      if (extra.length) await removeErrorReports(extra);
    } catch {
      /* not the owner, or offline — the next owner session trims */
    }
  },
});

// Uncaught errors and promise rejections anywhere in the page.
let installed = false;
export function installGlobalErrorReporting() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (e) => {
    reportError("crash", e.error || new Error(e.message), { where: "window.onerror" });
  });
  window.addEventListener("unhandledrejection", (e) => {
    reportError("crash", e.reason instanceof Error ? e.reason : new Error(String(e.reason)), {
      where: "unhandledrejection",
    });
  });
}
