import { useState, useEffect } from "react";
import { PAYMENT_QR_SRC } from "../lib/print.js";
import { featureOn } from "../config/features.js";
import { S } from "../ui/styles.js";
import { LangSelect } from "../i18n/index.jsx";
import { DEFAULT_SHOP_CONFIG, validateConfig } from "../config/shopConfig.js";
import { Header, Section, Field } from "../ui/index.jsx";

// ---------- Settings (shop config) ----------
export const MAX_LOGO_BYTES = 250 * 1024; // keep the logo small — it's stored inline in the DB config
export function Settings({ config, onSave, notify }) {
  const [f, setF] = useState(() => ({ ...DEFAULT_SHOP_CONFIG, ...config }));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setF({ ...DEFAULT_SHOP_CONFIG, ...config });
  }, [config]);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));

  const onQr = (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!/^image\//.test(file.type)) return notify("Please choose an image file for the QR.");
    if (file.size > MAX_LOGO_BYTES)
      return notify("QR image is too large — please use an image under 250 KB.");
    const reader = new FileReader();
    reader.onload = () => setF((s) => ({ ...s, paymentQrUrl: String(reader.result || "") }));
    reader.onerror = () => notify("Couldn't read that image.");
    reader.readAsDataURL(file);
  };

  const onLogo = (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!/^image\//.test(file.type)) return notify("Please choose an image file for the logo.");
    if (file.size > MAX_LOGO_BYTES)
      return notify("Logo is too large — please use an image under 250 KB.");
    const reader = new FileReader();
    reader.onload = () => setF((s) => ({ ...s, logoUrl: String(reader.result || "") }));
    reader.onerror = () => notify("Couldn't read that image.");
    reader.readAsDataURL(file);
  };

  const save = async () => {
    const err = validateConfig(f);
    if (err) return notify("⚠ " + err);
    setBusy(true);
    await onSave({
      name: f.name.trim(),
      tagline: f.tagline,
      address: f.address,
      phone: f.phone,
      email: f.email.trim(),
      gstin: f.gstin.trim(),
      currency: f.currency.trim() || "₹",
      logoUrl: f.logoUrl,
      receiptFooter: f.receiptFooter,
      ...(featureOn("paymentSettings")
        ? {
            upiId: (f.upiId || "").trim(),
            paymentQrUrl: f.paymentQrUrl || "",
            receiptWidth: Number(f.receiptWidth) || 0,
          }
        : {}),
      footwearSizeMin: Number(f.footwearSizeMin) || 3,
      footwearSizeMax: Number(f.footwearSizeMax) || 9,
    });
    setBusy(false);
  };

  return (
    <div>
      <Header title="Settings" sub="Shop identity — shown in the header, receipts, and reports" />
      <section
        style={{ ...S.panel, marginBottom: 16, display: "flex", alignItems: "center", gap: 12 }}
      >
        <label htmlFor="lang-setting" style={{ fontWeight: 700, fontSize: 13.5 }}>
          🌐 Language / भाषा
        </label>
        <LangSelect id="lang-setting" style={{ width: "auto", minWidth: 160 }} />
        <span style={{ fontSize: 12, color: "#556A5F" }}>
          Menus, Billing and the printed receipt. Saved on this device.
        </span>
      </section>
      <div style={{ maxWidth: 720 }}>
        <Section title="Shop details">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Shop name *">
              <input
                className="input"
                value={f.name}
                onChange={set("name")}
                placeholder="e.g. Riya Ladies Collection"
              />
            </Field>
            <Field label="Tagline">
              <input
                className="input"
                value={f.tagline}
                onChange={set("tagline")}
                placeholder="Ladies Fashion & Footwear"
              />
            </Field>
          </div>
          <Field label="Address">
            <input
              className="input"
              value={f.address}
              onChange={set("address")}
              placeholder="Shop no., street, area, city, PIN"
            />
          </Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Phone">
              <input
                className="input"
                value={f.phone}
                onChange={set("phone")}
                placeholder="Contact number"
              />
            </Field>
            <Field label="Email">
              <input
                className="input"
                type="email"
                value={f.email}
                onChange={set("email")}
                placeholder="shop@email.com"
              />
            </Field>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="GSTIN (optional)">
              <input
                className="input"
                value={f.gstin}
                onChange={set("gstin")}
                placeholder="15-digit GSTIN"
              />
            </Field>
            <Field label="Currency symbol">
              <input
                className="input"
                style={{ width: 90 }}
                value={f.currency}
                onChange={set("currency")}
                maxLength={3}
              />
            </Field>
          </div>
        </Section>

        <Section title="Logo (optional)">
          <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
            {f.logoUrl ? (
              <img
                src={f.logoUrl}
                alt="Shop logo"
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: 12,
                  objectFit: "contain",
                  background: "#fff",
                  border: "1px solid #E3E9E5",
                }}
              />
            ) : (
              <div
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: 12,
                  background: "#F4F7F4",
                  display: "grid",
                  placeItems: "center",
                  color: "#5F6B6B",
                  fontSize: 24,
                }}
              >
                🛍️
              </div>
            )}
            <label className="btn">
              Upload logo
              <input type="file" accept="image/*" onChange={onLogo} style={{ display: "none" }} />
            </label>
            {f.logoUrl && (
              <button className="btn ghost" onClick={() => setF((s) => ({ ...s, logoUrl: "" }))}>
                Remove
              </button>
            )}
            <span style={{ fontSize: 12, color: "#5C6E63" }}>PNG/JPG under 250 KB.</span>
          </div>
        </Section>

        <Section title="Receipt & sizes">
          {featureOn("paymentSettings") && (
            <div style={{ background: "#F4F7F4", borderRadius: 10, padding: 12, marginBottom: 12 }}>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>
                Payment &amp; receipt paper
              </div>
              <Field label="UPI ID (printed under the QR)">
                <input
                  className="input"
                  value={f.upiId || ""}
                  onChange={set("upiId")}
                  placeholder="e.g. shopname@upi"
                />
              </Field>
              <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 10 }}>
                <img
                  src={f.paymentQrUrl || PAYMENT_QR_SRC}
                  alt="Payment QR preview"
                  style={{ width: 84, height: 84, objectFit: "contain", background: "#fff" }}
                />
                <label className="btn" style={{ cursor: "pointer" }}>
                  Upload payment QR
                  <input
                    type="file"
                    accept="image/*"
                    onChange={onQr}
                    style={{ display: "none" }}
                    aria-label="Upload payment QR image"
                  />
                </label>
                {f.paymentQrUrl && (
                  <button
                    className="btn ghost"
                    onClick={() => setF((s) => ({ ...s, paymentQrUrl: "" }))}
                  >
                    Use built-in QR
                  </button>
                )}
              </div>
              <Field label="Receipt paper width">
                <select
                  className="input"
                  value={String(f.receiptWidth || 0)}
                  onChange={set("receiptWidth")}
                >
                  <option value="0">Standard (as before)</option>
                  <option value="58">58 mm roll</option>
                  <option value="80">80 mm roll</option>
                </select>
              </Field>
            </div>
          )}
          <Field label="Receipt / invoice footer text">
            <textarea
              className="input"
              rows={2}
              value={f.receiptFooter}
              onChange={set("receiptFooter")}
              placeholder="Thank you! Please visit again."
            />
          </Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Footwear size — min (IND/UK)">
              <input
                className="input"
                type="number"
                inputMode="decimal"
                min="1"
                max="15"
                value={f.footwearSizeMin}
                onChange={set("footwearSizeMin")}
              />
            </Field>
            <Field label="Footwear size — max (IND/UK)">
              <input
                className="input"
                type="number"
                inputMode="decimal"
                min="1"
                max="15"
                value={f.footwearSizeMax}
                onChange={set("footwearSizeMax")}
              />
            </Field>
          </div>
        </Section>

        <button className="btn primary big" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save settings"}
        </button>
      </div>
    </div>
  );
}
