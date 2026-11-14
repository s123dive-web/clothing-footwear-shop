import { loadCachedConfig, DEFAULT_SHOP_CONFIG } from "../config/shopConfig.js";
import { useState } from "react";
import { useLang, LangSelect } from "../i18n/index.jsx";
import { signInWithEmailAndPassword, sendPasswordResetEmail } from "firebase/auth";
import { auth } from "../config/firebase.js";
import { CSS } from "../ui/styles.js";
import { LOGO_SRC } from "../lib/print.js";
import { Field } from "../ui/index.jsx";

// ---------- authentication (Firebase email/password) ----------
// Real server-side auth via Firebase. Data is gated by the database security rules
// (locked to the shop owner's email), so it is genuinely private — not just a UI gate.
export const AUTH_ERRORS = {
  "auth/invalid-credential": "Incorrect email or password.",
  "auth/wrong-password": "Incorrect email or password.",
  "auth/user-not-found": "No account with that email.",
  "auth/invalid-email": "That email address looks invalid.",
  "auth/missing-password": "Please enter your password.",
  "auth/too-many-requests": "Too many attempts — please wait a minute and retry.",
  "auth/network-request-failed": "Network error — check your internet connection.",
  "auth/unauthorized-domain": "This web address isn't authorised in Firebase Auth settings.",
};
export const authMessage = (code) => AUTH_ERRORS[code] || "Could not sign in. Please try again.";

export function Login() {
  const { t } = useLang();
  // The Realtime DB config is locked behind auth, so on the sign-in screen we can only use
  // whatever was cached from a previous session (falling back to defaults for a fresh device).
  const cfg = loadCachedConfig() || DEFAULT_SHOP_CONFIG;
  const [email, setEmail] = useState("");
  const [pwd, setPwd] = useState("");
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e?.preventDefault();
    setBusy(true);
    setErr("");
    setInfo("");
    try {
      await signInWithEmailAndPassword(auth, email.trim(), pwd);
      // App's auth listener swaps to the dashboard on success.
    } catch (ex) {
      setErr(authMessage(ex.code));
      setBusy(false);
    }
  };

  const reset = async () => {
    if (!email.trim()) return setErr("Enter your email above first, then tap reset.");
    try {
      await sendPasswordResetEmail(auth, email.trim());
      setErr("");
      setInfo("Password reset link sent to " + email.trim());
    } catch (ex) {
      setErr(authMessage(ex.code));
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "#10331F",
        padding: 16,
      }}
    >
      <style>{CSS}</style>
      <form
        onSubmit={submit}
        style={{
          background: "#fff",
          borderRadius: 16,
          padding: "26px 24px",
          width: "min(380px, 94vw)",
          boxShadow: "0 12px 40px rgba(0,0,0,.3)",
        }}
      >
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <img
            src={cfg.logoUrl || LOGO_SRC}
            alt=""
            style={{ width: 52, height: 52, borderRadius: 12, objectFit: "contain", flexShrink: 0 }}
            onError={(e) => {
              e.currentTarget.style.visibility = "hidden";
            }}
          />
          <div>
            <div style={{ fontWeight: 800, fontSize: 18, letterSpacing: "-0.02em" }}>
              {cfg.name}
            </div>
            <div style={{ fontSize: 11.5, color: "#5C6E63" }}>{cfg.address || cfg.tagline}</div>
          </div>
        </div>
        <h2 style={{ fontSize: 16, margin: "18px 0 12px" }}>{t("Sign in")}</h2>
        <Field label={t("Email")}>
          <input
            className="input"
            type="email"
            value={email}
            autoComplete="username"
            autoFocus
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label={t("Password")}>
          <input
            className="input"
            type="password"
            value={pwd}
            autoComplete="current-password"
            onChange={(e) => setPwd(e.target.value)}
          />
        </Field>
        {err && <div style={{ color: "#C44536", fontSize: 13, marginBottom: 8 }}>{err}</div>}
        {info && <div style={{ color: "#1B5E43", fontSize: 13, marginBottom: 8 }}>{info}</div>}
        <button className="btn primary big" type="submit" style={{ width: "100%" }} disabled={busy}>
          {busy ? t("Signing in…") : t("Sign in")}
        </button>
        <button
          type="button"
          onClick={reset}
          style={{
            display: "block",
            background: "none",
            border: "none",
            color: "#1B5E43",
            fontSize: 12,
            marginTop: 4,
            cursor: "pointer",
            padding: "0 4px",
            minHeight: 44,
            textAlign: "left",
          }}
        >
          {t("Forgot password? Email me a reset link")}
        </button>
        <div style={{ fontSize: 11, color: "#5C6E63", marginTop: 12, lineHeight: 1.5 }}>
          {t(
            "Sign in with your shop account. Your data syncs live across every device that signs in."
          )}
        </div>
        <LangSelect style={{ marginTop: 12 }} />
      </form>
    </div>
  );
}
