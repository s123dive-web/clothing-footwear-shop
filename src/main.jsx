import { StrictMode, Component } from "react";
import { createRoot } from "react-dom/client";
import App from "./clothing-footwear-shop.jsx";

// ----------------------------------------------------------------------------
// Error boundary — without this, any render-time exception unmounts the whole
// app and leaves a blank white screen. This shows a recoverable message and
// keeps the user's saved data intact (it lives in localStorage, not in state).
// ----------------------------------------------------------------------------
class ErrorBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error("App crashed:", error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            maxWidth: 560,
            margin: "60px auto",
            padding: 24,
            fontFamily: "system-ui, sans-serif",
          }}
        >
          <h1 style={{ fontSize: 22, color: "#C44536" }}>Something went wrong</h1>
          <p style={{ color: "#445", lineHeight: 1.5 }}>
            The app hit an unexpected error. Your saved store data is safe on this device. Try
            reloading; if it keeps happening, the details below help with debugging.
          </p>
          <pre
            style={{
              background: "#F4F7F4",
              padding: 12,
              borderRadius: 8,
              overflow: "auto",
              fontSize: 12.5,
            }}
          >
            {String(this.state.error?.stack || this.state.error)}
          </pre>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: "10px 18px",
              borderRadius: 9,
              border: "none",
              background: "#1B5E43",
              color: "#fff",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Reload app
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ----------------------------------------------------------------------------
// Shim for the artifact-sandbox `window.storage` API this component expects.
// Backed by localStorage so data persists on this device between reloads.
// The original returns a record like { value: "<string>" } from get().
// ----------------------------------------------------------------------------
if (!window.storage) {
  window.storage = {
    async get(key) {
      const value = localStorage.getItem(key);
      return value == null ? null : { value };
    },
    async set(key, value) {
      localStorage.setItem(key, value);
    },
  };
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
