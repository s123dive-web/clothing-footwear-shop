// Wraps a screen that needs EVERY bill (Reports, Admin). The app normally holds only recent
// bills (lib/salesWindow.js); this fetches the rest once — not live — before showing the screen.
import { useEffect, useState } from "react";
import { Empty } from "./index.jsx";

export function AllSalesGate({ salesFrom, loadOlderSales, allowPartial = false, children }) {
  const all = salesFrom === null;
  const [state, setState] = useState("loading"); // loading | failed | partial
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (all) return;
    let dead = false;
    setState("loading");
    loadOlderSales(null).then((ok) => {
      if (!dead && !ok) setState("failed");
    });
    return () => {
      dead = true;
    };
  }, [all, loadOlderSales, attempt]);

  if (all || state === "partial") return children;
  if (state === "failed")
    return (
      <Empty text="Couldn't load the full sales history — this needs an internet connection.">
        <button className="btn primary" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </button>
        {allowPartial && (
          <button className="btn" style={{ marginLeft: 8 }} onClick={() => setState("partial")}>
            Show bills since {salesFrom} only
          </button>
        )}
      </Empty>
    );
  return <div style={{ padding: 40, color: "#667" }}>Loading full sales history…</div>;
}
