import { useState, useEffect } from "react";
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
      footwearSizeMin: Number(f.footwearSizeMin) || 3,
      footwearSizeMax: Number(f.footwearSizeMax) || 9,
    });
    setBusy(false);
  };

  return (
    <div>
      <Header title="Settings" sub="Shop identity — shown in the header, receipts, and reports" />
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
