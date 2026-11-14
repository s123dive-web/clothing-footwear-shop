// Camera barcode scanner (feature "barcode"). Lazy-loaded from Billing.
//
// Uses the browser's built-in BarcodeDetector where it exists (Android Chrome) and otherwise
// loads the ZXing library on demand. If there is no camera or permission is refused, the code
// can still be typed in the box — a USB / Bluetooth scanner types into it too.
import { useEffect, useRef, useState } from "react";
import { Modal } from "./index.jsx";

const FORMATS = ["code_128", "ean_13", "ean_8", "upc_a", "upc_e", "code_39", "itf", "qr_code"];
const CAMERA = { video: { facingMode: { ideal: "environment" } }, audio: false };

export function BarcodeScanner({ onDetect, onClose }) {
  const video = useRef(null);
  const [status, setStatus] = useState("Starting camera…");
  const [manual, setManual] = useState("");
  const last = useRef({ code: "", at: 0 });
  const detectRef = useRef(onDetect);
  detectRef.current = onDetect;

  useEffect(() => {
    let dead = false;
    let stop = () => {};
    const found = (code) => {
      const text = String(code || "").trim();
      if (!text) return;
      // The same label stays in view for many frames — report it once every 1.5 s.
      const now = Date.now();
      if (text === last.current.code && now - last.current.at < 1500) return;
      last.current = { code: text, at: now };
      detectRef.current(text);
    };
    (async () => {
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)
          throw new Error("no camera API");
        if ("BarcodeDetector" in window) {
          const supported = await window.BarcodeDetector.getSupportedFormats();
          const detector = new window.BarcodeDetector({
            formats: FORMATS.filter((f) => supported.includes(f)),
          });
          const stream = await navigator.mediaDevices.getUserMedia(CAMERA);
          if (dead) return stream.getTracks().forEach((t) => t.stop());
          video.current.srcObject = stream;
          await video.current.play();
          const timer = setInterval(async () => {
            try {
              const hits = await detector.detect(video.current);
              if (hits[0]) found(hits[0].rawValue);
            } catch {
              /* frame not ready */
            }
          }, 200);
          stop = () => {
            clearInterval(timer);
            stream.getTracks().forEach((t) => t.stop());
          };
        } else {
          const { BrowserMultiFormatReader } = await import("@zxing/browser");
          if (dead) return;
          const reader = new BrowserMultiFormatReader();
          const controls = await reader.decodeFromConstraints(CAMERA, video.current, (result) => {
            if (result) found(result.getText());
          });
          stop = () => controls.stop();
          if (dead) return stop();
        }
        setStatus("Point the camera at a barcode");
      } catch (e) {
        console.error("barcode camera unavailable", e);
        if (!dead) setStatus("Camera not available — type or scan the code below.");
      }
    })();
    return () => {
      dead = true;
      stop();
    };
  }, []);

  return (
    <Modal title="Scan barcode" onClose={onClose}>
      <video
        ref={video}
        muted
        playsInline
        aria-label="Camera preview"
        style={{ width: "100%", maxHeight: 280, background: "#000", borderRadius: 10 }}
      />
      <div role="status" style={{ fontSize: 13, color: "#556A5F", margin: "8px 0" }}>
        {status}
      </div>
      <form
        style={{ display: "flex", gap: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!manual.trim()) return;
          onDetect(manual.trim());
          setManual("");
        }}
      >
        <input
          className="input"
          data-autofocus
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          placeholder="Type or scan a code"
          aria-label="Barcode"
        />
        <button className="btn primary" type="submit">
          Add
        </button>
      </form>
      <div style={{ marginTop: 12, textAlign: "right" }}>
        <button className="btn" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}
