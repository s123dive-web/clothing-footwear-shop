// Staff accounts (feature "staffAccounts") — a panel on the Admin screen, owner only.
// The owner creates a sign-in for a staff member and lists it at shop/users/<uid> with role
// "staff"; removing the entry takes away all access at once (the rules check it on every read
// and write). What staff can and cannot do is enforced by database.rules.json.
import { useEffect, useState } from "react";
import { createStaffLogin } from "../config/firebase.js";
import { subscribeUsers, setUser } from "../lib/sync.js";
import { confirmDialog } from "../ui/dialogs.jsx";
import { S } from "../ui/styles.js";

export function StaffAccounts({ notify, log }) {
  const [users, setUsers] = useState({});
  const [email, setEmail] = useState("");
  const [pwd, setPwd] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => subscribeUsers(setUsers), []);
  const staff = Object.entries(users).filter(([, u]) => u && u.role === "staff");

  const add = async (e) => {
    e.preventDefault();
    const mail = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return notify("Enter the staff member's email.");
    if (pwd.length < 6) return notify("Choose a password of at least 6 characters.");
    setBusy(true);
    try {
      const uid = await createStaffLogin(mail, pwd);
      await setUser(uid, { role: "staff", email: mail, addedAt: Date.now() });
      log("admin", `Added staff account ${mail}`);
      notify(`Staff account created for ${mail}`);
      setEmail("");
      setPwd("");
    } catch (err) {
      console.error("create staff failed", err);
      notify(
        err && err.code === "auth/email-already-in-use"
          ? "⚠ That email already has an account — use a different email for this staff member."
          : "⚠ Couldn't create the staff account."
      );
    }
    setBusy(false);
  };
  const removeStaff = async (uid, u) => {
    if (
      !(await confirmDialog({
        title: "Remove staff access",
        message: `Remove ${u.email || uid}? They will no longer be able to open the shop.`,
        confirmLabel: "Remove access",
        danger: true,
      }))
    )
      return;
    try {
      await setUser(uid, null);
      log("admin", `Removed staff account ${u.email || uid}`);
      notify("Staff access removed");
    } catch (err) {
      console.error("remove staff failed", err);
      notify("⚠ Couldn't remove the staff account.");
    }
  };

  return (
    <section style={{ ...S.panel, marginBottom: 16 }}>
      <div style={S.panelHead}>Staff accounts</div>
      <p style={{ fontSize: 13, color: "#445", lineHeight: 1.5, margin: "0 0 10px" }}>
        Staff can bill, see stock and bills, and take credit repayments. They cannot see profit or
        purchase prices in the app, open Reports, Expenses, Settings or Admin, or delete bills.
      </p>
      {staff.length === 0 ? (
        <div style={{ fontSize: 13, color: "#556A5F", marginBottom: 10 }}>
          No staff accounts yet.
        </div>
      ) : (
        staff.map(([uid, u]) => (
          <div key={uid} style={{ ...S.row, alignItems: "center" }}>
            <span>
              <b>{u.email || uid}</b>
              <span style={{ color: "#556A5F", fontSize: 12 }}> · staff</span>
            </span>
            <button className="btn small danger" onClick={() => removeStaff(uid, u)}>
              Remove
            </button>
          </div>
        ))
      )}
      <form
        onSubmit={add}
        style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 8, marginTop: 12 }}
      >
        <input
          className="input"
          type="email"
          autoComplete="off"
          aria-label="Staff email"
          placeholder="Staff email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          className="input"
          type="password"
          autoComplete="new-password"
          aria-label="Staff password"
          placeholder="Password (min 6)"
          value={pwd}
          onChange={(e) => setPwd(e.target.value)}
        />
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? "Adding…" : "Add staff"}
        </button>
      </form>
    </section>
  );
}
