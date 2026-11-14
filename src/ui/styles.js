// ---------- styles ----------
export const S = {
  app: {
    display: "flex",
    minHeight: "100vh",
    background: "#EFF3EE",
    fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
    color: "#1E2421",
  },
  nav: {
    width: 210,
    background: "#10331F",
    color: "#E6F0E9",
    display: "flex",
    flexDirection: "column",
    gap: 4,
    padding: "16px 10px",
    position: "sticky",
    top: 0,
    height: "100vh",
    boxSizing: "border-box",
  },
  logo: { display: "flex", gap: 10, alignItems: "center", padding: "4px 8px 18px" },
  logoMark: {
    width: 38,
    height: 38,
    borderRadius: 10,
    background: "#E8A33D",
    color: "#10331F",
    display: "grid",
    placeItems: "center",
    fontWeight: 800,
    fontSize: 17,
  },
  main: {
    flex: 1,
    padding: "26px 30px",
    maxWidth: 1280,
    margin: "0 auto",
    width: "100%",
    boxSizing: "border-box",
  },
  cards: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14 },
  card: { background: "#fff", borderRadius: 14, padding: "16px 18px", border: "1px solid #E2EAE3" },
  panel: { background: "#fff", borderRadius: 14, padding: 16, border: "1px solid #E2EAE3" },
  panelHead: {
    fontWeight: 800,
    fontSize: 13.5,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: "#3A5547",
    display: "flex",
    alignItems: "center",
    marginBottom: 10,
  },
  row: {
    display: "flex",
    justifyContent: "space-between",
    padding: "8px 2px",
    borderBottom: "1px dashed #E5ECE6",
    fontSize: 13.5,
  },
  receipt: {
    background: "#FFFDF6",
    borderRadius: 4,
    padding: "18px 16px",
    border: "1px solid #E8E2CF",
    boxShadow: "0 2px 10px rgba(40,60,40,.07)",
    alignSelf: "start",
    backgroundImage:
      "repeating-linear-gradient(transparent, transparent 27px, rgba(180,170,140,.12) 28px)",
  },
  receiptHead: {
    textAlign: "center",
    fontWeight: 800,
    letterSpacing: "0.25em",
    fontSize: 12,
    color: "#6B6347",
    borderBottom: "2px dashed #D8D0B8",
    paddingBottom: 10,
    marginBottom: 8,
  },
  rcptLine: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "7px 0",
    borderBottom: "1px dotted #E0D9C4",
  },
  rcptTotal: {
    display: "flex",
    justifyContent: "space-between",
    fontWeight: 800,
    fontSize: 18,
    paddingTop: 12,
    marginTop: 6,
    borderTop: "2px dashed #C9BF9F",
  },
  badge: {
    background: "#C44536",
    color: "#fff",
    fontSize: 10.5,
    fontWeight: 800,
    borderRadius: 9,
    padding: "1px 7px",
    marginLeft: 8,
  },
  badgeInline: {
    background: "#FBECEF",
    color: "#B0324C",
    fontSize: 10,
    fontWeight: 800,
    borderRadius: 6,
    padding: "1px 6px",
    marginLeft: 6,
    textTransform: "uppercase",
    letterSpacing: ".04em",
  },
  toast: {
    position: "fixed",
    bottom: 24,
    left: "50%",
    transform: "translateX(-50%)",
    background: "#10331F",
    color: "#fff",
    padding: "10px 20px",
    borderRadius: 10,
    fontSize: 13.5,
    boxShadow: "0 6px 20px rgba(0,0,0,.25)",
    zIndex: 60,
  },
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(15,30,20,.45)",
    display: "grid",
    placeItems: "center",
    zIndex: 50,
  },
  modal: {
    background: "#fff",
    borderRadius: 16,
    padding: 20,
    width: "min(480px, 92vw)",
    maxHeight: "86vh",
    overflow: "auto",
  },
};

export const CSS = `
  .navbtn { display:flex; align-items:center; gap:6px; width:100%; text-align:left; background:none; border:none; color:#BCD2C4; padding:10px 12px; border-radius:9px; font-size:13.5px; font-weight:600; cursor:pointer; position:relative; }
  .navbtn:hover { background:#1A4A2E; color:#fff; }
  .navbtn.active { background:#1B5E43; color:#fff; }
  .navbtn.sub { padding-left:26px; font-size:13px; color:#A8C2B4; }
  .navbtn.sub::before { content:""; position:absolute; left:14px; top:9px; bottom:9px; width:2px; background:#2A5A3E; border-radius:2px; }
  .input { width:100%; box-sizing:border-box; padding:10px 12px; border:1.5px solid #D5E0D6; border-radius:9px; font-size:14px; background:#fff; outline:none; font-family:inherit; }
  .input:focus { border-color:#1B5E43; box-shadow:0 0 0 3px rgba(27,94,67,.12); }
  .btn { border:none; border-radius:9px; padding:9px 16px; font-size:13.5px; font-weight:700; cursor:pointer; background:#E4ECE5; color:#23402F; font-family:inherit; }
  .btn:hover { filter:brightness(.96); }
  .btn.primary { background:#1B5E43; color:#fff; }
  .btn.big { padding:13px 18px; font-size:15px; }
  .btn.ghost { background:transparent; border:1.5px solid #CFDCD1; }
  .btn.small { padding:5px 10px; font-size:12px; }
  .btn.danger { background:#FBEAE7; color:#C44536; }
  .pick { text-align:left; background:#F6FAF6; border:1.5px solid #DDE8DE; border-radius:11px; padding:10px 12px; cursor:pointer; font-family:inherit; }
  .pick:hover:not(:disabled) { border-color:#1B5E43; background:#fff; }
  .pick:disabled { opacity:.7; cursor:not-allowed; background:#F0F2F0; }
  .qty { width:26px; height:26px; border-radius:7px; border:1.5px solid #D0C7AB; background:#fff; font-size:15px; font-weight:700; cursor:pointer; line-height:1; }
  .seg { border:none; background:#F1ECEF; color:#5E4A54; padding:7px 12px; font-size:13px; font-weight:700; cursor:pointer; font-family:inherit; }
  .seg.wide { flex:1; border-radius:8px; }
  .seg.on { background:#8E2C48; color:#fff; }
  .chipbtn { display:inline-flex; align-items:center; gap:3px; border:1.5px solid #E1D4DA; background:#fff; color:#4A3A42; border-radius:16px; padding:4px 10px; font-size:12px; font-weight:600; cursor:pointer; margin:0 5px 5px 0; font-family:inherit; }
  .chipbtn.on { background:#8E2C48; color:#fff; border-color:#8E2C48; }
  .tbl { width:100%; border-collapse:collapse; font-size:13.5px; }
  .tbl th { text-align:left; font-size:11.5px; text-transform:uppercase; letter-spacing:.05em; color:#7A8C81; padding:6px 8px; border-bottom:2px solid #E2EAE3; }
  .tbl td { padding:9px 8px; border-bottom:1px solid #EEF3EE; }
  .tbl tr:hover td { background:#F7FAF7; }
  .tap { min-width:44px; min-height:44px; }
  .stepper { display:flex; align-items:center; gap:4px; }
  .step { width:44px; height:44px; border-radius:10px; border:1.5px solid #CFC3C9; background:#fff; color:#3A2A32; font-size:22px; font-weight:700; line-height:1; cursor:pointer; font-family:inherit; }
  .step:active { background:#F1ECEF; }
  .quick-row { display:flex; gap:6px; overflow-x:auto; padding-bottom:8px; margin-bottom:6px; -webkit-overflow-scrolling:touch; }
  .quick { flex:0 0 auto; min-height:44px; padding:0 12px; border-radius:22px; border:1.5px solid #E1D4DA; background:#FFF9EC; color:#3A2A32; font-size:13px; font-weight:700; cursor:pointer; white-space:nowrap; font-family:inherit; }
  .held { display:inline-flex; border:1.5px solid #D9C7CF; border-radius:10px; overflow:hidden; background:#fff; }
  .held-main { min-height:44px; padding:0 12px; border:none; background:#FBF4F7; color:#5A2338; font-size:13px; font-weight:700; cursor:pointer; font-family:inherit; }
  .held-x { min-width:44px; min-height:44px; border:none; border-left:1.5px solid #D9C7CF; background:#fff; color:#8A5566; font-size:14px; cursor:pointer; }
  .bill-bar-total, .bill-bar-spacer { display:none; }
  .toasts { position:fixed; left:50%; transform:translateX(-50%); bottom:24px; z-index:90; display:flex; flex-direction:column; gap:8px; width:max-content; max-width:min(560px, calc(100vw - 24px)); }
  @media (max-width: 820px) {
    .toasts { bottom:calc(88px + env(safe-area-inset-bottom, 0px)); width:auto; left:12px; right:12px; transform:none; }
    /* Billing: total + Complete pinned to the bottom of the phone screen */
    .bill-bar { position:fixed; left:0; right:0; bottom:0; z-index:40; display:flex; align-items:center; gap:12px; background:#fff; border-top:1.5px solid #E1D4DA; box-shadow:0 -6px 18px rgba(0,0,0,.12); padding:10px 14px calc(10px + env(safe-area-inset-bottom, 0px)); }
    .bill-bar-total { display:flex; flex-direction:column; min-width:96px; line-height:1.25; }
    .bill-bar .btn.big { min-height:52px; }
    .bill-bar-spacer { display:block; height:76px; }
    .app { flex-direction:column !important; }
    .nav { width:auto !important; height:auto !important; position:static !important;
           flex-direction:row !important; flex-wrap:wrap !important; gap:4px !important; }
    .nav .navbtn { width:auto !important; }
    .main { padding:16px !important; max-width:none !important; }
    /* 16px inputs stop mobile browsers auto-zooming on focus */
    .input { font-size:16px; }
    /* inline grids are 2- or 4-column; collapse them all on small screens */
    [style*="grid-template-columns"] { grid-template-columns:1fr !important; }
    /* let wide tables scroll horizontally instead of overflowing the panel */
    .tbl { display:block; overflow-x:auto; white-space:nowrap; }
  }
`;
