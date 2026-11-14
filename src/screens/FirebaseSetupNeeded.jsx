// ---------- Firebase-not-configured screen ----------
// Shown when src/config/firebase.js still holds placeholder values, so the app degrades to a
// clear setup message instead of crashing on Firebase init / null auth.
export function FirebaseSetupNeeded() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "#2A1A22",
        padding: 20,
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: 16,
          padding: "28px 26px",
          maxWidth: 560,
          boxShadow: "0 12px 40px rgba(0,0,0,.35)",
        }}
      >
        <h1 style={{ fontSize: 20, margin: "0 0 6px", color: "#8E2C48" }}>
          ⚙️ Configure Firebase to get started
        </h1>
        <p style={{ color: "#445", lineHeight: 1.55, fontSize: 14 }}>
          This app needs its own Firebase project before it can run. Right now
          <code
            style={{ background: "#F4EEF0", padding: "1px 5px", borderRadius: 5, margin: "0 3px" }}
          >
            src/config/firebase.js
          </code>
          still contains placeholder values.
        </p>
        <ol style={{ color: "#445", lineHeight: 1.7, fontSize: 13.5, paddingLeft: 20 }}>
          <li>
            Create a project at <b>console.firebase.google.com</b>.
          </li>
          <li>
            Enable <b>Realtime Database</b> and <b>Authentication → Email/Password</b>.
          </li>
          <li>
            Copy your web-app config into <b>src/config/firebase.js</b> (replace every{" "}
            <code>YOUR_…</code> value).
          </li>
          <li>
            Deploy the security rules: <code>firebase deploy --only database,storage</code>.
          </li>
        </ol>
        <p style={{ color: "#5E5E72", fontSize: 12.5, marginTop: 10 }}>
          See the README (“Firebase setup”) for the full walkthrough.
        </p>
      </div>
    </div>
  );
}
