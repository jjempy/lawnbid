import { useState, useEffect, useCallback, useRef, forwardRef, createContext, useContext, useMemo } from "react";
import supabase, {
  loadQuotes, upsertQuote, deleteQuote, updateQuoteStatus,
  loadClients, upsertClient,
  loadSettings, saveSettings as dbSaveSettings,
  nextQuoteId,
  uploadQuoteFile, deleteQuoteFile,
  countRecentQuotes,
} from "./supabase.js";

// ─── Stripe checkout ────────────────────────────────────────────────────────────
async function redirectToStripeCheckout(priceId) {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    const response = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/create-checkout-session`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priceId, userId: user.id, userEmail: user.email }),
      }
    );
    const { url, error } = await response.json();
    if (error) throw new Error(error);
    window.location.href = url;
  } catch (err) {
    alert("Could not start checkout. Please try again.");
    console.error("[LawnBid] Stripe checkout error:", err);
  }
}

// ─── Constants ──────────────────────────────────────────────────────────────────
const APP_VERSION = "1.0.0";
const DEFAULT_SETTINGS = {
  mow_rate: 110, trim_rate: 18, equipment_cost: 12.35, hourly_rate: 22.80,
  minimum_bid: 55, complexity_default: 1.0, risk_default: 1.0,
  profit_margin: 0.30,
  quote_validity_days: 30,
  company_name: "", company_phone: "", company_email: "", company_logo_base64: "",
  plan: "free", quote_count_this_month: 0, quote_count_reset_at: new Date().toISOString(),
};
const PLANS = {
  free: { name:"Free", quote_limit:10,   map:false, pdf:false, photos:false },
  pro:  { name:"Pro",  quote_limit:null, map:true,  pdf:true,  photos:true  },
  team: { name:"Team", quote_limit:null, map:true,  pdf:true,  photos:true  },
};
const PLAN_PRICE = "$19/month";
const PlanContext = createContext(null);
const usePlan = () => useContext(PlanContext);
const COMPLEXITY = [
  { label: "Simple",    value: 1.0,  desc: "Open lawn, no obstacles" },
  { label: "Moderate",  value: 1.3,  desc: "Some trees, beds, tight spaces" },
  { label: "Complex",   value: 1.6,  desc: "Heavy tree cover, dense landscaping" },
  { label: "V.Complex", value: 2.0,  desc: "Heavily wooded, narrow gates" },
];
const RISK = [
  { label: "Low",      value: 1.0,  desc: "Flat, open, dry" },
  { label: "Moderate", value: 1.25, desc: "Mild slope or wet areas" },
  { label: "High",     value: 1.5,  desc: "Steep hills, drainage issues" },
  { label: "Severe",   value: 1.75, desc: "Swampy, very steep, liability concern" },
];
const AREA_UNITS  = [
  { label: "sq ft",    value: "sqft",   conv: v => v },
  { label: "acres",    value: "acres",  conv: v => v * 43560 },
  { label: "sq yards", value: "sqyard", conv: v => v * 9 },
];
const PERIM_UNITS = [
  { label: "linear ft", value: "ft", conv: v => v },
  { label: "yards",     value: "yd", conv: v => v * 3 },
  { label: "miles",     value: "mi", conv: v => v * 5280 },
];
// ─── Google Maps loader (bootstrap script injection, single shared promise) ───
const mapsReady = (() => {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (window.google?.maps) return Promise.resolve(window.google);
  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-lb-maps]');
    if (existing) {
      existing.addEventListener("load", () => resolve(window.google));
      existing.addEventListener("error", reject);
      return;
    }
    window.__lb_gm_cb = () => resolve(window.google);
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${import.meta.env.VITE_GOOGLE_MAPS_KEY}&libraries=geometry,places&callback=__lb_gm_cb&loading=async`;
    script.async = true;
    script.defer = true;
    script.setAttribute("data-lb-maps", "1");
    script.onerror = reject;
    document.head.appendChild(script);
  });
})().catch(err => { console.error("Google Maps failed to load:", err); throw err; });

const MAX_ATTACHMENTS = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB
const ALLOWED_EXT = ["jpg","jpeg","png","pdf","txt","heic"];
const ATTACH_ACCEPT = ".jpg,.jpeg,.png,.pdf,.txt,.heic,image/jpeg,image/png,application/pdf,text/plain,image/heic";

const STATUS_COLOR = { draft:"#f59e0b", sent:"#3b82f6", accepted:"#16a34a" };
const STATUS_BG    = { draft:"#fffbeb", sent:"#eff6ff", accepted:"#f0fdf4" };

const uid = () => Math.random().toString(36).slice(2,8).toUpperCase();

// ─── Responsive ─────────────────────────────────────────────────────────────
function getBP(){
  if (typeof window === "undefined") return "desktop";
  const w = window.innerWidth;
  if (w < 768) return "mobile";
  if (w < 1200) return "tablet";
  return "desktop";
}
function useBreakpoint(){
  const [bp,setBp] = useState(getBP);
  useEffect(()=>{
    const onResize = ()=>setBp(getBP());
    window.addEventListener("resize",onResize);
    return ()=>window.removeEventListener("resize",onResize);
  },[]);
  return bp;
}

// ─── Formula ────────────────────────────────────────────────────────────────────
const $$ = v => `$${(+(v||0)).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const fmtT = h => { if(!h||h<=0) return "—"; const hr=Math.floor(h),m=Math.round((h-hr)*60); return hr===0?`${m}m`:m===0?`${hr}h`:`${hr}h ${m}m`; };
const fmtD = iso => new Date(iso).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"});
const fmtTS= iso => new Date(iso).toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit"});
const fmtArea = (sqft) => { if(!sqft) return "—"; return `${Math.round(sqft).toLocaleString()} sqft (${(sqft/43560).toFixed(2)} ac)`; };
const isExpired = iso => iso && new Date(iso) < new Date();
const addDays = (iso, days) => new Date(new Date(iso).getTime() + (days||30)*86400000).toISOString();

const COMPANY_LOGO_CACHE = "lb_company_logo";

// ─── Smart error messages ───────────────────────────────────────────────────
function authErrorMessage(err) {
  const msg = (err?.message || "").toLowerCase();
  if (msg.includes("invalid login credentials")) return "Email or password is incorrect. Double-check your details or tap Forgot Password to reset.";
  if (msg.includes("email not confirmed")) return "Please check your email and click the confirmation link we sent before logging in.";
  if (msg.includes("user already registered") || msg.includes("already been registered")) return "An account with this email already exists. Try logging in instead.";
  if (msg.includes("password should be at least")) return "Password must be at least 6 characters. Please choose a longer password.";
  if (msg.includes("too many requests") || msg.includes("rate limit")) return "Too many attempts. Please wait a few minutes and try again.";
  if (msg.includes("failed to fetch") || msg.includes("network")) return "Could not connect. Check your internet connection and try again.";
  return "Something went wrong signing in. Check your internet connection and try again.";
}
function dbErrorMessage(err) {
  const msg = (err?.message || "").toLowerCase();
  const code = err?.code || "";
  if (msg.includes("failed to fetch") || msg.includes("network") || msg.includes("networkerror")) return "Could not connect to the database. Check your internet connection and try again.";
  if (code === "42501" || msg.includes("row-level security") || msg.includes("row level security") || msg.includes("permission denied") || msg.includes("not authorized")) return "Permission denied. Try logging out and back in.";
  return "Could not save your data. Check your connection and try again. Your quote information is preserved.";
}

function calcQ(area, perim, cx, risk, disc, s, ov=null) {
  if(!area||!perim||area<=0||perim<=0) return null;
  const mh=area/20000, th=perim/3000;
  const mc=area*(s.mow_rate/20000), tc=perim*(s.trim_rate/3000), ec=s.equipment_cost*(mh+th);
  const sub=mc+tc+ec, acx=sub*cx, ar=acx*risk;
  // 1. Floor at minimum bid
  const fl=Math.max(ar,s.minimum_bid), minA=ar<s.minimum_bid;
  // 2. Apply discount (reduces billable amount)
  const afterDisc=fl*(1-disc/100);
  // 3. Apply profit margin on the discounted price: final = discounted / (1 - margin)
  const margin = Math.min(0.8, Math.max(0, (s.profit_margin ?? 0.30)));
  const fin = margin > 0 ? afterDisc / (1 - margin) : afterDisc;
  const disp=ov!==null?(parseFloat(ov)||0):fin;
  const bd=[
    {label:"Mow (area)",       note:`${fmtArea(area)} × ($${s.mow_rate}÷20,000)`, value:mc},
    {label:"Trim (perimeter)", note:`${Math.round(perim).toLocaleString()} ft × ($${s.trim_rate}÷3,000)`,  value:tc},
    {label:"Equipment",        note:`${(mh+th).toFixed(2)} hrs × $${s.equipment_cost}/hr`,                 value:ec},
    {subtotal:true, label:"Subtotal (costs)", value:sub},
    {modifier:true, label:`Complexity (${cx}×)`,  value:acx-sub},
    {modifier:true, label:`Risk (${risk}×)`,       value:ar-acx},
    ...(disc>0?[{modifier:true,label:`Discount (${disc}%)`,value:-(fl*disc/100)}]:[]),
    ...(margin>0?[{modifier:true,label:`Profit margin (${Math.round(margin*100)}%)`,value:fin-afterDisc}]:[]),
  ];
  return {mh,th,mc,tc,ec,sub,acx,ar,afterDisc,minA,fl,fin,disp,bd};
}

function calcTime(area, perim, crew, cx) {
  if(!area||!perim||area<=0||perim<=0) return null;
  const mh=area/20000, th=perim/3000;
  const wall=crew>=2?Math.max(mh,th):mh+th, adj=wall*cx, pct=Math.min(100,(adj/8)*100);
  return { mh, th, wall, adj, pct,
    crew_times:[1,2,3,4].map(n=>({n, t:(n>=2?Math.max(mh,th):mh+th)*cx})) };
}

async function generateQuotePDF(quote, settings, calc, time) {
  const { default: jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const W = doc.internal.pageSize.getWidth();
  const M = 48;                       // page margin
  const PRIMARY = [21,128,61];        // #15803d
  const DARK = [15,23,42];            // #0f172a
  const MUTED = [100,116,139];        // #64748b
  const LINE  = [226,232,240];        // #e2e8f0
  const expiryISO = quote.expiry_date || addDays(quote.created_at, settings.quote_validity_days || 30);
  const expiryStr = fmtD(expiryISO);
  let y = M;

  // ── Header: logo + company block ──
  const logoSize = 60;
  if (settings.company_logo_base64) {
    try {
      const fmt = /^data:image\/(png|jpeg|jpg|webp)/i.exec(settings.company_logo_base64)?.[1]?.toUpperCase() || "PNG";
      doc.addImage(settings.company_logo_base64, fmt==="JPG"?"JPEG":fmt, M, y, logoSize, logoSize);
    } catch(_) { /* ignore bad image */ }
  }
  const textX = settings.company_logo_base64 ? M + logoSize + 16 : M;
  doc.setFont("helvetica","bold"); doc.setFontSize(20); doc.setTextColor(...DARK);
  doc.text(settings.company_name || "LawnBid", textX, y + 22);
  doc.setFont("helvetica","normal"); doc.setFontSize(10); doc.setTextColor(...MUTED);
  const contact = [settings.company_phone, settings.company_email].filter(Boolean).join("  ·  ");
  if (contact) doc.text(contact, textX, y + 40);
  // Right side: QUOTE label
  doc.setFont("helvetica","bold"); doc.setFontSize(22); doc.setTextColor(...PRIMARY);
  doc.text("QUOTE", W - M, y + 22, { align: "right" });
  doc.setFont("helvetica","normal"); doc.setFontSize(10); doc.setTextColor(...MUTED);
  doc.text(`#${quote.quote_id}`, W - M, y + 40, { align: "right" });

  y += logoSize + 14;
  doc.setDrawColor(...LINE); doc.setLineWidth(0.8);
  doc.line(M, y, W - M, y);
  y += 22;

  // ── Meta row: dates ──
  doc.setFont("helvetica","bold"); doc.setFontSize(8); doc.setTextColor(...MUTED);
  doc.text("DATE ISSUED", M, y);
  doc.text("EXPIRES", M + 180, y);
  doc.text("QUOTE ID", M + 340, y);
  doc.setFont("helvetica","normal"); doc.setFontSize(11); doc.setTextColor(...DARK);
  doc.text(fmtD(quote.created_at), M, y + 14);
  doc.text(expiryStr, M + 180, y + 14);
  doc.text(quote.quote_id, M + 340, y + 14);
  y += 34;

  // ── Client box ──
  doc.setDrawColor(...LINE); doc.setFillColor(248,250,252);
  doc.roundedRect(M, y, W - M*2, 76, 6, 6, "FD");
  doc.setFont("helvetica","bold"); doc.setFontSize(8); doc.setTextColor(...MUTED);
  doc.text("BILL TO", M + 14, y + 18);
  doc.setFont("helvetica","bold"); doc.setFontSize(12); doc.setTextColor(...DARK);
  doc.text(quote.client_name || "—", M + 14, y + 34);
  doc.setFont("helvetica","normal"); doc.setFontSize(10); doc.setTextColor(...MUTED);
  if (quote.client_phone) doc.text(quote.client_phone, M + 14, y + 50);
  doc.text(quote.address || "", M + 14, y + 66, { maxWidth: W - M*2 - 28 });
  y += 96;

  // ── Service & measurements ──
  doc.setFont("helvetica","bold"); doc.setFontSize(8); doc.setTextColor(...MUTED);
  doc.text("SERVICE", M, y);
  doc.setFont("helvetica","normal"); doc.setFontSize(11); doc.setTextColor(...DARK);
  doc.text("Lawn Mowing, Trimming & Edging", M, y + 14);
  y += 32;

  doc.setFont("helvetica","bold"); doc.setFontSize(8); doc.setTextColor(...MUTED);
  doc.text("AREA", M, y);
  doc.text("PERIMETER", M + 180, y);
  doc.text("EST. TIME", M + 340, y);
  doc.setFont("helvetica","normal"); doc.setFontSize(11); doc.setTextColor(...DARK);
  doc.text(fmtArea(quote.area_sqft), M, y + 14);
  doc.text(`${Math.round(quote.linear_ft).toLocaleString()} ft`, M + 180, y + 14);
  doc.text(time ? fmtT(time.adj) : "—", M + 340, y + 14);
  y += 34;

  // ── Line item table ──
  doc.setDrawColor(...LINE); doc.line(M, y, W - M, y); y += 14;
  doc.setFont("helvetica","bold"); doc.setFontSize(8); doc.setTextColor(...MUTED);
  doc.text("DESCRIPTION", M, y);
  doc.text("AMOUNT", W - M, y, { align: "right" });
  y += 10;
  doc.line(M, y, W - M, y); y += 14;

  doc.setFont("helvetica","normal"); doc.setFontSize(10); doc.setTextColor(...DARK);
  (calc?.bd || []).forEach(r => {
    if (r.subtotal) {
      doc.setDrawColor(...LINE); doc.line(M, y - 4, W - M, y - 4);
      doc.setFont("helvetica","bold"); doc.setTextColor(...DARK);
    } else if (r.modifier) {
      doc.setFont("helvetica","normal"); doc.setTextColor(...MUTED);
    } else {
      doc.setFont("helvetica","normal"); doc.setTextColor(...DARK);
    }
    doc.text(r.label, M, y);
    const amt = `${r.modifier && r.value>0 ? "+" : ""}${$$(r.value)}`;
    doc.text(amt, W - M, y, { align: "right" });
    y += 18;
  });

  y += 6;
  doc.setDrawColor(...DARK); doc.setLineWidth(1.2); doc.line(M, y, W - M, y); y += 26;
  doc.setFont("helvetica","bold"); doc.setFontSize(14); doc.setTextColor(...DARK);
  doc.text("TOTAL", M, y);
  doc.setFontSize(22); doc.setTextColor(...PRIMARY);
  doc.text($$(quote.final_price), W - M, y + 2, { align: "right" });
  y += 36;

  // ── Notes ──
  if (quote.notes) {
    doc.setFont("helvetica","bold"); doc.setFontSize(8); doc.setTextColor(...MUTED);
    doc.text("NOTES", M, y); y += 14;
    doc.setFont("helvetica","normal"); doc.setFontSize(10); doc.setTextColor(...DARK);
    const lines = doc.splitTextToSize(quote.notes, W - M*2);
    doc.text(lines, M, y); y += lines.length * 14 + 10;
  }

  // ── Attachments note ──
  const attachCount = Array.isArray(quote.attachments) ? quote.attachments.length : 0;
  if (attachCount > 0) {
    doc.setFont("helvetica","italic"); doc.setFontSize(9); doc.setTextColor(...MUTED);
    doc.text(`${attachCount} attachment${attachCount>1?"s":""} included in digital quote.`, M, y);
    y += 18;
  }

  // ── Footer ──
  const footerY = doc.internal.pageSize.getHeight() - M;
  doc.setDrawColor(...LINE); doc.line(M, footerY - 24, W - M, footerY - 24);
  doc.setFont("helvetica","normal"); doc.setFontSize(9); doc.setTextColor(...MUTED);
  const footerText = `Quote valid until ${expiryStr}. To accept${settings.company_phone?` reply or call ${settings.company_phone}`:" please reply"}.`;
  doc.text(footerText, M, footerY - 8, { maxWidth: W - M*2 });

  const safeName = (quote.client_name || "client").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
  doc.save(`LawnBid-${quote.quote_id}-${safeName}.pdf`);
}

function quoteText(q, s) {
  return [
    "LAWN CARE QUOTE",
    s.company_name?`${s.company_name}${s.company_phone?" | "+s.company_phone:""}`:"",
    "",`Quote ID: ${q.quote_id}`,`Date: ${fmtTS(q.created_at)}`,
    q.parent_id?`Revision of: ${q.parent_id}`:"",
    "",`Client: ${q.client_name||"—"}`,`Property: ${q.address}`,
    "","Service: Lawn Mowing, Trimming & Edging",
    `Area: ${fmtArea(q.area_sqft)}`,
    `Perimeter: ${Math.round(q.linear_ft).toLocaleString()} linear ft`,
    "",`TOTAL: ${$$(q.final_price)}`,
    "",s.company_phone?`To accept, call ${s.company_phone}.`:"To accept, please reply.",
  ].filter(Boolean).join("\n");
}

// ─── Shared UI ──────────────────────────────────────────────────────────────────
const CARD_SHADOW = "0 1px 3px rgba(0,0,0,.06), 0 1px 2px rgba(0,0,0,.04)";
const Card  = ({children,style={},onClick,...p}) => <div onClick={onClick} style={{background:"#ffffff",borderRadius:16,padding:"var(--card-padding)",marginBottom:12,boxShadow:CARD_SHADOW,cursor:onClick?"pointer":undefined,...style}} {...p}>{children}</div>;
const Lbl   = ({children,style={}}) => <div style={{fontSize:11,fontWeight:700,color:"#64748b",letterSpacing:1,textTransform:"uppercase",marginBottom:10,...style}}>{children}</div>;
const Inp   = forwardRef(({style={},...p},ref) => <input ref={ref} style={{width:"100%",height:48,padding:"0 14px",border:"1.5px solid #e2e8f0",borderRadius:12,fontSize:16,fontWeight:500,color:"#0f172a",background:"#ffffff",outline:"none",boxSizing:"border-box",fontFamily:"inherit",...style}} {...p}/>);
const Sel   = ({style={},...p}) => <select style={{height:48,padding:"0 10px",border:"1.5px solid #e2e8f0",borderRadius:12,fontSize:14,fontWeight:500,color:"#0f172a",background:"#ffffff",outline:"none",fontFamily:"inherit",...style}} {...p}/>;
const Btn   = ({children,variant="primary",style={},...p}) => {
  const vs={
    primary:{background:"#15803d",color:"#ffffff",border:"none"},
    secondary:{background:"#f1f5f9",color:"#0f172a",border:"none"},
    outline:{background:"#ffffff",color:"#15803d",border:"1.5px solid #15803d"},
    danger:{background:"#ffffff",color:"#dc2626",border:"1.5px solid #fecaca"},
    warning:{background:"#ffffff",color:"#b45309",border:"1.5px solid #fcd34d"},
  };
  return <button style={{height:48,minHeight:48,padding:"0 20px",borderRadius:16,fontSize:15,fontWeight:600,cursor:p.disabled?"not-allowed":"pointer",opacity:p.disabled?.55:1,fontFamily:"inherit",letterSpacing:-.1,...vs[variant],...style}} {...p}>{children}</button>;
};
const Chip  = ({label,active,onClick,style={}}) => <button onClick={onClick} style={{height:36,minHeight:36,padding:"0 16px",borderRadius:18,border:active?"1.5px solid #15803d":"1.5px solid #e2e8f0",background:active?"#15803d":"#ffffff",color:active?"#ffffff":"#374151",fontSize:13,fontWeight:600,cursor:"pointer",whiteSpace:"nowrap",fontFamily:"inherit",flexShrink:0,display:"inline-flex",alignItems:"center",...style}}>{label}</button>;
const Badge = ({status}) => <span style={{padding:"3px 9px",borderRadius:999,fontSize:10,fontWeight:700,background:STATUS_BG[status]||"#f1f5f9",color:STATUS_COLOR[status]||"#64748b",textTransform:"uppercase",letterSpacing:.6}}>{status}</span>;
const ErrMsg= ({msg}) => msg?<div style={{color:"#dc2626",fontSize:13,marginTop:6,fontWeight:500,background:"#fef2f2",borderLeft:"3px solid #dc2626",padding:"8px 10px",borderRadius:"0 8px 8px 0"}}>⚠ {msg}</div>:null;
const ErrBox= ({children,style={}}) => children?<div style={{color:"#dc2626",fontSize:13,fontWeight:500,background:"#fef2f2",borderLeft:"3px solid #dc2626",padding:"10px 12px",borderRadius:"0 8px 8px 0",...style}}>⚠ {children}</div>:null;
const QID   = ({id}) => <span style={{fontFamily:"ui-monospace, SFMono-Regular, Menlo, monospace",fontSize:11,background:"#f1f5f9",color:"#475569",padding:"2px 7px",borderRadius:6,letterSpacing:.3,fontWeight:600}}>{id}</span>;
const Back  = ({onClick}) => <button onClick={onClick} style={{width:40,height:40,minHeight:40,display:"inline-flex",alignItems:"center",justifyContent:"center",background:"none",border:"none",fontSize:26,cursor:"pointer",color:"#15803d",fontFamily:"inherit",lineHeight:1,padding:0,marginLeft:-8}}>‹</button>;

// ─── App ─────────────────────────────────────────────────────────────────────────
export default function LawnBid() {
  const bp = useBreakpoint();
  const [authReady,setAuthReady]= useState(false);
  const [session,  setSession]  = useState(null);
  const [recovering,setRecovering] = useState(false);
  const [upgradeFor,setUpgradeFor] = useState(null);
  const [ready,    setReady]    = useState(false);
  const [dbErr,    setDbErr]    = useState(null);
  const [quotes,   setQuotes]   = useState([]);
  const [clients,  setClients]  = useState([]);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [tab,      setTab]      = useState("quotes");
  const [screen,   setScreen]   = useState("home");
  const [selQ,     setSelQ]     = useState(null);
  const [selC,     setSelC]     = useState(null);
  const [flow,     setFlow]     = useState(null);
  const [step,     setStep]     = useState(1);
  const [errors,   setErrors]   = useState({});
  const [saving,   setSaving]   = useState(false);
  const [quotesUsedLive, setQuotesUsedLive] = useState(0);
  const [toast, setToast] = useState(null);
  const settingsRef = useRef(settings);
  useEffect(() => { settingsRef.current = settings; }, [settings]);

  // ── Auth: check existing session and listen for changes ──
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session || null);
      setAuthReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === "PASSWORD_RECOVERY") setRecovering(true);
      setSession(s || null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // ── Cache company logo for AuthScreen ──
  useEffect(() => {
    if (settings?.company_logo_base64) {
      try { localStorage.setItem(COMPANY_LOGO_CACHE, settings.company_logo_base64); } catch {}
    }
  }, [settings?.company_logo_base64]);

  // ── Plan context value ──
  const planValue = useMemo(() => {
    const key = settings?.plan || "free";
    const cfg = PLANS[key] || PLANS.free;
    return {
      plan: key,
      planName: cfg.name,
      canUseMap: cfg.map,
      canExportPDF: cfg.pdf,
      canAttachPhotos: cfg.photos,
      quoteLimit: cfg.quote_limit,
      quotesUsed: quotesUsedLive,
      quotesRemaining: cfg.quote_limit !== null ? Math.max(0, cfg.quote_limit - quotesUsedLive) : null,
      isAtLimit: cfg.quote_limit !== null && quotesUsedLive >= cfg.quote_limit,
      showUpgrade: (feature) => setUpgradeFor(feature),
    };
  }, [settings?.plan, quotesUsedLive]);

  // ── Load all data from Supabase once authenticated ──
  useEffect(() => {
    if (!session) { setReady(false); setQuotes([]); setClients([]); setSettings(DEFAULT_SETTINGS); setQuotesUsedLive(0); return; }
    (async () => {
      try {
        const [q, c, s, qCount] = await Promise.all([loadQuotes(), loadClients(), loadSettings(), countRecentQuotes(30)]);
        setQuotes(q);
        setClients(c);
        if (s) setSettings(prev => ({ ...prev, ...s }));
        setQuotesUsedLive(qCount);
        setReady(true);
        // Handle Stripe upgrade return
        try {
          const up = new URLSearchParams(window.location.search).get("upgrade");
          if (up === "success") {
            // Re-fetch settings to pick up the updated plan from webhook
            const fresh = await loadSettings();
            if (fresh) setSettings(prev => ({ ...prev, ...fresh }));
            setToast("Welcome to Pro! All features are now unlocked.");
            window.history.replaceState({}, "", "/app/");
          } else if (up === "cancelled") {
            setToast("Upgrade cancelled — you can upgrade anytime from Settings.");
            window.history.replaceState({}, "", "/app/");
          }
        } catch {}
      } catch (e) {
        setDbErr(dbErrorMessage(e));
        setReady(true);
      }
    })();
  }, [session]);

  const goHome = useCallback(() => { setScreen("home"); setFlow(null); setErrors({}); }, []);

  const startNew = useCallback(() => {
    const cfg = PLANS[settings.plan || "free"] || PLANS.free;
    if (cfg.quote_limit !== null && quotesUsedLive >= cfg.quote_limit) {
      setUpgradeFor("Unlimited Quotes");
      return;
    }
    setFlow({
      isNew:true, parentId:null, existingId:null,
      clientId:null, clientName:"", clientPhone:"", clientEmail:"",
      address:"", areaVal:"", areaUnit:"sqft", perimVal:"", perimUnit:"ft",
      crew:1, cx:settings.complexity_default, risk:settings.risk_default,
      disc:0, customDisc:"", override:null, notes:"", saveClient:true,
      attachments:[],
    });
    setStep(1); setErrors({}); setScreen("flow");
  }, [settings]);

  const editQuote = useCallback((q, forceNew=false) => {
    if (forceNew) {
      const cfg = PLANS[settings.plan || "free"] || PLANS.free;
      if (cfg.quote_limit !== null && quotesUsedLive >= cfg.quote_limit) {
        setUpgradeFor("Unlimited Quotes"); return;
      }
    }
    setFlow({
      isNew:forceNew, parentId:forceNew?q.quote_id:(q.parent_id||null), existingId:forceNew?null:q.quote_id,
      clientId:q.client_id, clientName:q.client_name||"", clientPhone:q.client_phone||"", clientEmail:q.client_email||"",
      address:q.address, areaVal:String(q.area_sqft), areaUnit:"sqft", perimVal:String(q.linear_ft), perimUnit:"ft",
      crew:q.crew_size, cx:q.complexity, risk:q.risk, disc:q.discount_pct||0, customDisc:"",
      override:null, notes:q.notes||"", saveClient:true, sentAt:q.sent_at,
      attachments:Array.isArray(q.attachments)?q.attachments:[],
    });
    setStep(2); setErrors({}); setScreen("flow");
  }, []);

  const quotesUsedRef = useRef(quotesUsedLive);
  useEffect(() => { quotesUsedRef.current = quotesUsedLive; }, [quotesUsedLive]);

  const handleSave = useCallback(async (rec, cliData, status) => {
    // Gate: free plan quote limit — any new record counts (brand new, V2, duplicate)
    if (rec.isNew) {
      const s = settingsRef.current || {};
      const cfg = PLANS[s.plan || "free"] || PLANS.free;
      if (cfg.quote_limit !== null && quotesUsedRef.current >= cfg.quote_limit) {
        setUpgradeFor("Unlimited Quotes");
        return;
      }
    }
    setSaving(true);
    try {
      // 1. Resolve client
      let cid = rec.clientId;
      if (cliData && rec.saveClient) {
        if (!cid) cid = uid();
        const clientRecord = { id: cid, created_at: new Date().toISOString(), ...cliData };
        await upsertClient(clientRecord);
        // Update local state
        setClients(prev => {
          const existing = prev.find(c => c.id === cid);
          return existing ? prev.map(c => c.id === cid ? { ...c, ...cliData } : c)
                          : [...prev, clientRecord];
        });
      }

      // 2. Build quote record
      const now = new Date().toISOString();
      let quoteId = rec.existingId;
      if (!quoteId) {
        quoteId = await nextQuoteId();
      }

      const record = {
        quote_id:    quoteId,
        created_at:  rec.isNew ? now : undefined,
        updated_at:  now,
        address:     rec.address,
        area_sqft:   rec.area_sqft,
        linear_ft:   rec.linear_ft,
        crew_size:   rec.crew_size,
        complexity:  rec.complexity,
        risk:        rec.risk,
        discount_pct:      rec.discount_pct,
        mow_rate_used:     rec.mow_rate_used,
        trim_rate_used:    rec.trim_rate_used,
        equipment_cost_used: rec.equipment_cost_used,
        formula_price: rec.formula_price,
        final_price:   rec.final_price,
        status,
        client_id:   cid || null,
        client_name: rec.client_name,
        client_phone:rec.client_phone,
        client_email:rec.client_email,
        parent_id:   rec.parentId || null,
        notes:       rec.notes,
        attachments: Array.isArray(rec.attachments) ? rec.attachments : [],
        sent_at:     status === "sent" ? now : (rec.sentAt || null),
        expiry_date: rec.isNew ? addDays(now, settingsRef.current.quote_validity_days || 30) : undefined,
      };

      // Remove undefined fields
      Object.keys(record).forEach(k => record[k] === undefined && delete record[k]);

      await upsertQuote(record);

      // 3. Update local quotes state
      setQuotes(prev => {
        const exists = prev.find(q => q.quote_id === quoteId);
        return exists ? prev.map(q => q.quote_id === quoteId ? { ...q, ...record } : q)
                      : [record, ...prev];
      });

      // 4. Bump local quote count for immediate UI feedback when a new record is created
      if (rec.isNew) {
        setQuotesUsedLive(n => n + 1);
      }

      setSelQ(quoteId);
      setScreen("quote-detail");
      setFlow(null);
    } catch (e) {
      alert(dbErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }, []);

  const handleSaveSettings = useCallback(async ns => {
    setSettings(ns);
    await dbSaveSettings(ns); // let errors propagate so callers know if save failed
  }, []);

  const handleDeleteQuote = useCallback(async (quoteId) => {
    try {
      await deleteQuote(quoteId);
      setQuotes(prev => prev.filter(q => q.quote_id !== quoteId));
      goHome();
    } catch(e) { alert(dbErrorMessage(e)); }
  }, [goHome]);

  const handleAccepted = useCallback(async (quoteId) => {
    const now = new Date().toISOString();
    try {
      await updateQuoteStatus(quoteId, "accepted", { accepted_at: now });
      setQuotes(prev => prev.map(q => q.quote_id === quoteId ? { ...q, status: "accepted", accepted_at: now } : q));
    } catch(e) { alert(dbErrorMessage(e)); }
  }, []);

  if (!authReady) return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100vh",fontFamily:"system-ui",gap:12}}>
      <img src="/logo.png" alt="LawnBid" style={{width:80,height:80,borderRadius:"50%",objectFit:"cover"}}/>
      <div style={{fontSize:20,fontWeight:900,color:"#16a34a"}}>LawnBid</div>
    </div>
  );

  if (recovering) return <ResetPasswordScreen onDone={()=>setRecovering(false)}/>;

  if (!session) return <AuthScreen/>;

  if (!ready) return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100vh",fontFamily:"system-ui",gap:12}}>
      <img src="/logo.png" alt="LawnBid" style={{width:80,height:80,borderRadius:"50%",objectFit:"cover"}}/>
      <div style={{fontSize:20,fontWeight:900,color:"#16a34a"}}>LawnBid</div>
      <div style={{fontSize:13,color:"#64748b"}}>Connecting to database…</div>
    </div>
  );

  const activeQ = quotes.find(q => q.quote_id === selQ);
  const activeC = clients.find(c => c.id === selC);
  const isDesktop = bp === "desktop";
  const isTablet  = bp === "tablet";

  const pageTitle = (() => {
    if (screen === "flow") return flow?.parentId ? "New Revision" : flow?.existingId ? "Edit Quote" : "New Quote";
    if (screen === "quote-detail") return "Quote Details";
    if (screen === "client-detail") return activeC?.name || "Client";
    return tab==="quotes" ? "Quotes" : tab==="clients" ? "Clients" : "Settings";
  })();

  const screenContent = screen==="flow" ? (
    <QuoteFlow bp={bp} step={step} setStep={setStep} flow={flow} setFlow={setFlow}
      errors={errors} setErrors={setErrors} settings={settings}
      clients={clients} quotes={quotes} onSave={handleSave} onCancel={goHome} saving={saving}/>
  ):screen==="quote-detail"&&activeQ ? (
    <QuoteDetail bp={bp} quote={activeQ} allQuotes={quotes} settings={settings}
      onBack={()=>setScreen(selC&&tab==="clients"?"client-detail":"home")}
      onEdit={()=>editQuote(activeQ, activeQ.status==="sent"||activeQ.status==="accepted")}
      onDuplicate={()=>editQuote(activeQ,true)}
      onDelete={()=>handleDeleteQuote(activeQ.quote_id)}
      onAccepted={()=>handleAccepted(activeQ.quote_id)}/>
  ):screen==="client-detail"&&activeC ? (
    <ClientDetail bp={bp} client={activeC} quotes={quotes.filter(q=>q.client_id===activeC.id)}
      onBack={()=>{setTab("clients");setScreen("home");}}
      onViewQuote={qid=>{setSelQ(qid);setScreen("quote-detail");}}/>
  ):tab==="quotes" ? (
    <HomeScreen bp={bp} quotes={quotes} onNew={startNew} onView={qid=>{setSelQ(qid);setScreen("quote-detail");}}/>
  ):tab==="clients" ? (
    <ClientsScreen bp={bp} clients={clients} quotes={quotes} onView={cid=>{setSelC(cid);setScreen("client-detail");}}/>
  ):(
    <SettingsScreen bp={bp} settings={settings} onSave={handleSaveSettings} onLogout={()=>supabase.auth.signOut()}/>
  );

  const dbBanner = dbErr && (
    <div style={{background:"#fef2f2",borderBottom:"2px solid #fca5a5",padding:"10px 16px",fontSize:13,color:"#dc2626",fontWeight:600,textAlign:"center"}}>
      ⚠ {dbErr}
    </div>
  );
  // Auto-dismiss toast
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);
  const toastBanner = toast && (
    <div style={{position:"fixed",top:"env(safe-area-inset-top)",left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:480,background:"#dcfce7",borderBottom:"2px solid #bbf7d0",padding:"10px 16px",fontSize:13,color:"#166534",fontWeight:600,zIndex:999,textAlign:"center",boxSizing:"border-box"}}>{toast}</div>
  );
  const savingBanner = saving && (
    <div style={{position:"fixed",top:"env(safe-area-inset-top)",left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:480,background:"#f0fdf4",borderBottom:"2px solid #bbf7d0",padding:"8px 16px",fontSize:13,color:"#166534",fontWeight:600,zIndex:999,textAlign:"center",boxSizing:"border-box"}}>
      💾 Saving…
    </div>
  );

  const upgradeModal = upgradeFor && <UpgradeModal feature={upgradeFor} onClose={()=>setUpgradeFor(null)}/>;

  // ─── Desktop layout: sidebar + top bar ───
  if (isDesktop) {
    return (
      <PlanContext.Provider value={planValue}>
        <div style={{display:"flex",minHeight:"100vh",background:"#f8fafc",color:"#0f172a",fontFamily:"'Inter',system-ui,-apple-system,sans-serif"}}>
  
          {upgradeModal}
          <SideNav tab={tab} setTab={setTab} setScreen={setScreen}/>
          <div style={{flex:1,display:"flex",flexDirection:"column",minWidth:0}}>
            {dbBanner}
            {savingBanner}
          {toastBanner}
            <TopBar title={pageTitle} onNew={startNew} showBack={screen==="quote-detail"||screen==="client-detail"||screen==="flow"} onBack={screen==="flow"?goHome:()=>setScreen(screen==="quote-detail"&&selC&&tab==="clients"?"client-detail":"home")}/>
            <div className="lb-scroll" style={{flex:1,padding:"24px"}}>
              <div style={{maxWidth:900,margin:"0 auto",width:"100%"}}>
                {screenContent}
              </div>
            </div>
          </div>
        </div>
      </PlanContext.Provider>
    );
  }

  // ─── Mobile / tablet layout: bottom nav ───
  const maxW = isTablet ? 720 : 480;
  return (
    <PlanContext.Provider value={planValue}>
      <div style={{maxWidth:maxW,margin:"0 auto",minHeight:"100vh",display:"flex",flexDirection:"column",fontFamily:"'Inter',system-ui,-apple-system,sans-serif",background:"#f8fafc",color:"#0f172a"}}>

        {upgradeModal}
        {dbBanner}
        {savingBanner}
        <div className="lb-scroll" style={{flex:1,overflowY:"auto",paddingBottom:screen==="flow"?0:"calc(56px + env(safe-area-inset-bottom) + 8px)"}}>
          {screenContent}
        </div>
        {screen!=="flow" && <BottomNav tab={tab} screen={screen} setTab={setTab} setScreen={setScreen} bp={bp} maxW={maxW}/>}
      </div>
    </PlanContext.Provider>
  );
}

// ─── Sidebar (desktop) ───
function SideNav({tab,setTab,setScreen}){
  const items = [["quotes","📋","Quotes"],["clients","👥","Clients"],["settings","⚙️","Settings"]];
  return (
    <aside style={{width:240,flexShrink:0,background:"#ffffff",borderRight:"1px solid #e2e8f0",display:"flex",flexDirection:"column",position:"sticky",top:0,height:"100vh"}}>
      <div style={{padding:"20px 20px 16px",display:"flex",alignItems:"center",gap:12,borderBottom:"1px solid #e2e8f0"}}>
        <img src="/logo.png" alt="LawnBid" style={{width:40,height:40,borderRadius:"50%",objectFit:"cover"}}/>
        <div style={{fontSize:18,fontWeight:900,color:"#0f172a",letterSpacing:-.3}}>LawnBid</div>
      </div>
      <nav style={{padding:"12px 0",display:"flex",flexDirection:"column",gap:2}}>
        {items.map(([t,icon,lbl])=>{
          const active = tab===t;
          return (
            <button key={t} onClick={()=>{setTab(t);setScreen("home");}} style={{display:"flex",alignItems:"center",gap:12,padding:"12px 20px",minHeight:48,border:"none",background:active?"#dcfce7":"transparent",color:active?"#15803d":"#334155",borderLeft:active?"3px solid #15803d":"3px solid transparent",fontSize:14,fontWeight:active?700:600,fontFamily:"inherit",textAlign:"left",cursor:"pointer"}}>
              <span style={{fontSize:18,filter:active?"none":"grayscale(1) opacity(.7)"}}>{icon}</span>{lbl}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

// ─── Top bar (desktop) ───
function TopBar({title,onNew,showBack,onBack}){
  return (
    <div style={{height:56,minHeight:56,background:"#ffffff",borderBottom:"1px solid #e2e8f0",display:"flex",alignItems:"center",justifyContent:"space-between",padding:"0 24px",position:"sticky",top:0,zIndex:10}}>
      <div style={{display:"flex",alignItems:"center",gap:10,minWidth:0}}>
        {showBack && <button onClick={onBack} style={{width:36,height:36,minHeight:36,display:"inline-flex",alignItems:"center",justifyContent:"center",background:"none",border:"none",fontSize:22,cursor:"pointer",color:"#15803d",fontFamily:"inherit",padding:0,marginLeft:-8}}>‹</button>}
        <div style={{fontSize:18,fontWeight:700,color:"#0f172a",letterSpacing:-.2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{title}</div>
      </div>
      <Btn onClick={onNew} style={{height:40,minHeight:40,padding:"0 16px",fontSize:13,borderRadius:12}}>+ New Quote</Btn>
    </div>
  );
}

// ─── Bottom nav (mobile/tablet) ───
function BottomNav({tab,screen,setTab,setScreen,bp,maxW}){
  const scale = bp==="tablet" ? 1.1 : 1;
  return (
    <div style={{position:"fixed",bottom:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:maxW,background:"#ffffff",borderTop:"1px solid #e2e8f0",display:"flex",zIndex:100,paddingBottom:"env(safe-area-inset-bottom)"}}>
      {[["quotes","📋","Quotes"],["clients","👥","Clients"],["settings","⚙️","Settings"]].map(([t,icon,lbl])=>{
        const active = tab===t && screen==="home";
        return (
          <button key={t} onClick={()=>{setTab(t);setScreen("home");}} style={{flex:1,height:56,minHeight:56,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:2,border:"none",background:"none",cursor:"pointer",fontSize:10*scale,fontWeight:700,color:active?"#15803d":"#94a3b8",textTransform:"uppercase",letterSpacing:.5,fontFamily:"inherit"}}>
            <div style={{fontSize:20*scale,lineHeight:1,filter:active?"none":"grayscale(1) opacity(.7)"}}>{icon}</div>{lbl}
          </button>
        );
      })}
    </div>
  );
}

// ─── Upgrade modal (plan gate) ───
function UpgradeModal({feature,onClose}){
  return (
    <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(0,0,0,.6)",zIndex:450,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#ffffff",borderRadius:16,padding:24,width:"100%",maxWidth:400,boxSizing:"border-box",boxShadow:"0 10px 40px rgba(0,0,0,.25)"}}>
        <div style={{display:"flex",justifyContent:"center",marginBottom:12}}>
          <div style={{width:56,height:56,borderRadius:"50%",background:"#dcfce7",display:"flex",alignItems:"center",justifyContent:"center"}}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#15803d" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="12 3 20 8 20 16 12 21 4 16 4 8 12 3"/><line x1="12" y1="12" x2="12" y2="21"/><polyline points="4 8 12 12 20 8"/></svg>
          </div>
        </div>
        <div style={{fontSize:18,fontWeight:800,color:"#0f172a",textAlign:"center",marginBottom:4,letterSpacing:-.2}}>{feature}</div>
        <div style={{fontSize:13,color:"#64748b",textAlign:"center",lineHeight:1.5,marginBottom:16}}>Upgrade to Pro for unlimited quotes, satellite map measurement, PDF exports, and photo attachments.</div>
        <div style={{display:"flex",alignItems:"baseline",justifyContent:"center",gap:4,marginBottom:18}}>
          <span style={{fontSize:28,fontWeight:900,color:"#0f172a",letterSpacing:-.5}}>$19</span>
          <span style={{fontSize:13,color:"#64748b",fontWeight:500}}>/month</span>
        </div>
        <Btn onClick={()=>redirectToStripeCheckout(import.meta.env.VITE_STRIPE_PRO_PRICE_ID)} style={{width:"100%"}}>Upgrade to Pro — $19/month</Btn>
        <div style={{textAlign:"center",marginTop:8}}>
          <button type="button" onClick={()=>redirectToStripeCheckout(import.meta.env.VITE_STRIPE_TEAM_PRICE_ID)} style={{background:"none",border:"none",color:"#15803d",fontSize:13,fontWeight:600,cursor:"pointer",textDecoration:"underline",padding:"6px 12px",minHeight:32,fontFamily:"inherit"}}>Upgrade to Team instead ($39/mo)</button>
        </div>
        <div style={{textAlign:"center",marginTop:4}}>
          <button type="button" onClick={onClose} style={{background:"none",border:"none",color:"#64748b",fontSize:13,fontWeight:600,cursor:"pointer",padding:"8px 12px",minHeight:32,fontFamily:"inherit"}}>Maybe later</button>
        </div>
      </div>
    </div>
  );
}

// ─── Home ──────────────────────────────────────────────────────────────────────
function HomeScreen({bp,quotes,onNew,onView}){
  const [filter,setFilter]=useState("all");
  const shown=(filter==="all"?quotes:quotes.filter(q=>q.status===filter)).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
  const isDesktop = bp==="desktop";
  const showDetailRow = bp!=="mobile";
  return(
    <div style={{padding:isDesktop?0:16,display:isDesktop?"grid":"block",gridTemplateColumns:isDesktop?"minmax(0,3fr) minmax(0,2fr)":undefined,gap:isDesktop?24:0}}>
      <div style={{minWidth:0}}>
      {!isDesktop && (
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <img src="/logo.png" alt="LawnBid" style={{width:36,height:36,borderRadius:"50%",objectFit:"cover",marginRight:8}}/>
            <div>
              <div style={{fontSize:26,fontWeight:900,color:"#0f172a"}}>LawnBid</div>
              <div style={{fontSize:12,color:"#64748b"}}>{quotes.length} quote{quotes.length!==1?"s":""} in database</div>
            </div>
          </div>
          <Btn onClick={onNew} style={{height:40,minHeight:40,padding:"0 14px",fontSize:13,borderRadius:12}}>+ New Quote</Btn>
        </div>
      )}
      <div className="lb-scroll" style={{display:"flex",gap:6,margin:isDesktop?"0 0 12px":"12px 0 8px",overflowX:"auto",paddingBottom:4}}>
        {["all","draft","sent","accepted"].map(f=>(
          <Chip key={f} label={f==="all"?`All (${quotes.length})`:`${f[0].toUpperCase()+f.slice(1)} (${quotes.filter(q=>q.status===f).length})`} active={filter===f} onClick={()=>setFilter(f)}/>
        ))}
      </div>
      {shown.length===0?(
        <div style={{textAlign:"center",padding:"60px 20px",color:"#64748b"}}>
          <div style={{fontSize:48,marginBottom:12}}>📋</div>
          <div style={{fontWeight:700,fontSize:16}}>{quotes.length===0?"No quotes yet":"No quotes match this filter"}</div>
          {quotes.length===0&&<div style={{fontSize:13,marginTop:6}}>Tap + New Quote to get started</div>}
        </div>
      ):shown.map(q=>{
        const expired = isExpired(q.expiry_date) && q.status!=="accepted";
        return (
        <Card key={q.quote_id} style={{cursor:"pointer",padding:"16px 18px",marginBottom:8,borderLeft:`3px solid ${STATUS_COLOR[q.status]||"#e2e8f0"}`}} onClick={()=>onView(q.quote_id)}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:12}}>
            <div style={{flex:1,minWidth:0}}>
              <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:2,flexWrap:"wrap"}}>
                <div style={{fontWeight:600,fontSize:15,color:"#0f172a",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",letterSpacing:-.1}}>{q.client_name||"No client"}</div>
                {q.parent_id&&<span style={{fontSize:10,background:"#e0f2fe",color:"#0369a1",padding:"1px 5px",borderRadius:4,fontWeight:700,flexShrink:0}}>V2</span>}
                {expired&&<span style={{fontSize:10,background:"#fee2e2",color:"#dc2626",padding:"1px 6px",borderRadius:4,fontWeight:700,flexShrink:0,letterSpacing:.4}}>EXPIRED</span>}
              </div>
              <div style={{fontSize:13,color:"#64748b",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontWeight:400}}>{q.address}</div>
              {showDetailRow && (
                <div style={{display:"flex",gap:14,marginTop:6,fontSize:12,color:"#475569",fontWeight:500}}>
                  <span><span style={{color:"#94a3b8"}}>Area </span>{fmtArea(q.area_sqft)}</span>
                  <span><span style={{color:"#94a3b8"}}>Perim </span>{Math.round(q.linear_ft).toLocaleString()} ft</span>
                </div>
              )}
              <div style={{display:"flex",alignItems:"center",gap:8,marginTop:6}}>
                <QID id={q.quote_id}/><span style={{fontSize:11,color:"#94a3b8",fontWeight:500}}>{fmtD(q.created_at)}</span>
              </div>
            </div>
            <div style={{textAlign:"right",flexShrink:0}}>
              <div style={{fontSize:20,fontWeight:900,color:"#0f172a",letterSpacing:-.5}}>{$$(q.final_price)}</div>
              <div style={{marginTop:4,textTransform:"uppercase",fontSize:10,fontWeight:700,letterSpacing:.6,color:STATUS_COLOR[q.status]||"#64748b"}}>{q.status}</div>
            </div>
          </div>
        </Card>
      );})}
      </div>
      {isDesktop && <HomeStats quotes={quotes}/>}
    </div>
  );
}

function HomeStats({quotes}){
  const total = quotes.length;
  const drafts = quotes.filter(q=>q.status==="draft").length;
  const sent = quotes.filter(q=>q.status==="sent").length;
  const accepted = quotes.filter(q=>q.status==="accepted");
  const revenue = accepted.reduce((s,q)=>s+(q.final_price||0),0);
  const rows = [
    {lbl:"Total Quotes",v:total.toString(),color:"#0f172a"},
    {lbl:"Drafts",v:drafts.toString(),color:"#f59e0b"},
    {lbl:"Sent",v:sent.toString(),color:"#3b82f6"},
    {lbl:"Accepted",v:accepted.length.toString(),color:"#16a34a"},
  ];
  return (
    <div style={{position:"sticky",top:80,alignSelf:"start"}}>
      <Card>
        <Lbl>Pipeline</Lbl>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
          {rows.map(r=>(
            <div key={r.lbl} style={{padding:"14px",borderRadius:12,background:"#f8fafc"}}>
              <div style={{fontSize:11,fontWeight:700,color:"#94a3b8",textTransform:"uppercase",letterSpacing:1}}>{r.lbl}</div>
              <div style={{fontSize:28,fontWeight:900,color:r.color,letterSpacing:-.8,marginTop:4,lineHeight:1}}>{r.v}</div>
            </div>
          ))}
        </div>
      </Card>
      <Card style={{background:"#0f172a"}}>
        <div style={{fontSize:11,fontWeight:700,color:"#64748b",textTransform:"uppercase",letterSpacing:1}}>Revenue (Accepted)</div>
        <div style={{fontSize:36,fontWeight:900,color:"#4ade80",letterSpacing:-1.2,marginTop:6,lineHeight:1}}>{$$(revenue)}</div>
        <div style={{fontSize:12,color:"#94a3b8",marginTop:6,fontWeight:500}}>{accepted.length} accepted quote{accepted.length!==1?"s":""}</div>
      </Card>
    </div>
  );
}

// ─── Clients ──────────────────────────────────────────────────────────────────
function ClientsScreen({bp,clients,quotes,onView}){
  const [search,setSearch]=useState("");
  const shown=clients.filter(c=>c.name?.toLowerCase().includes(search.toLowerCase())||c.phone?.includes(search)).sort((a,b)=>a.name?.localeCompare(b.name));
  const isDesktop = bp==="desktop";
  return(
    <div style={{padding:isDesktop?0:16}}>
      {!isDesktop && <div style={{fontSize:26,fontWeight:900,color:"#0f172a",marginBottom:14}}>Clients</div>}
      <Inp placeholder="Search name or phone…" value={search} onChange={e=>setSearch(e.target.value)} style={{marginBottom:14}}/>
      {shown.length===0?(
        <div style={{textAlign:"center",padding:"60px 20px",color:"#64748b"}}>
          <div style={{fontSize:48,marginBottom:12}}>👥</div>
          <div style={{fontWeight:700}}>{clients.length===0?"No clients yet":"No results"}</div>
          <div style={{fontSize:13,marginTop:6}}>Clients are saved automatically when you send a quote</div>
        </div>
      ):shown.map(c=>{
        const cqs=quotes.filter(q=>q.client_id===c.id).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
        const last=cqs[0],total=cqs.reduce((s,q)=>s+(q.final_price||0),0);
        return(
          <Card key={c.id} style={{cursor:"pointer"}} onClick={()=>onView(c.id)}>
            <div style={{display:"flex",justifyContent:"space-between",gap:12}}>
              <div style={{minWidth:0,flex:1}}>
                <div style={{fontWeight:700,fontSize:16}}>{c.name}</div>
                <div style={{fontSize:13,color:"#64748b"}}>{c.phone}</div>
                {c.default_address&&<div style={{fontSize:12,color:"#94a3b8",marginTop:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.default_address}</div>}
                <div style={{fontSize:11,color:"#94a3b8",marginTop:4}}>{cqs.length} quote{cqs.length!==1?"s":""}</div>
              </div>
              <div style={{textAlign:"right",flexShrink:0}}>
                {last&&<div style={{fontSize:18,fontWeight:900,color:"#0f172a",letterSpacing:-.3}}>{$$(last.final_price)}</div>}
                {last&&<div style={{fontSize:11,color:"#94a3b8",marginTop:2}}>{fmtD(last.created_at)}</div>}
                {cqs.length>1&&<div style={{fontSize:11,color:"#64748b",marginTop:2}}>Total: {$$(total)}</div>}
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

// ─── Client Detail ────────────────────────────────────────────────────────────
function ClientDetail({bp,client,quotes,onBack,onViewQuote}){
  const sorted=[...quotes].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
  const total=quotes.reduce((s,q)=>s+(q.final_price||0),0);
  const isDesktop = bp==="desktop";

  const contactCard = (
    <Card>
      <Lbl>Contact</Lbl>
      <div style={{fontWeight:700,fontSize:18,marginBottom:4}}>{client.name}</div>
      {client.phone&&<a href={`tel:${client.phone}`} style={{display:"block",fontSize:15,color:"#16a34a",textDecoration:"none",marginBottom:4}}>📞 {client.phone}</a>}
      {client.email&&<div style={{fontSize:14,color:"#64748b",marginBottom:4}}>✉ {client.email}</div>}
      {client.default_address&&<div style={{fontSize:13,color:"#64748b"}}>📍 {client.default_address}</div>}
    </Card>
  );
  const measurementsCard = client.last_area_sqft && (
    <Card>
      <Lbl>Last Job Measurements</Lbl>
      <div style={{display:"flex",gap:32}}>
        <div><div style={{fontSize:10,color:"#94a3b8",textTransform:"uppercase",fontWeight:700,letterSpacing:1}}>Area</div><div style={{fontSize:20,fontWeight:800,color:"#0f172a",letterSpacing:-.3,marginTop:2}}>{fmtArea(client.last_area_sqft)}</div></div>
        <div><div style={{fontSize:10,color:"#94a3b8",textTransform:"uppercase",fontWeight:700,letterSpacing:1}}>Perimeter</div><div style={{fontSize:20,fontWeight:800,color:"#0f172a",letterSpacing:-.3,marginTop:2}}>{Math.round(client.last_linear_ft||0).toLocaleString()} ft</div></div>
      </div>
    </Card>
  );
  const historyBlock = (
    <>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
        <div style={{fontWeight:700,fontSize:16}}>Quote History</div>
        <div style={{fontSize:13,color:"#64748b"}}>{quotes.length} · {$$(total)} total</div>
      </div>
      {sorted.length===0?(
        <div style={{textAlign:"center",padding:40,color:"#64748b",fontSize:14}}>No quotes for this client yet</div>
      ):sorted.map(q=>(
        <Card key={q.quote_id} style={{cursor:"pointer"}} onClick={()=>onViewQuote(q.quote_id)}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:12}}>
            <div style={{flex:1,minWidth:0}}>
              <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4,flexWrap:"wrap"}}>
                <QID id={q.quote_id}/>
                {q.parent_id&&<span style={{fontSize:10,background:"#e0f2fe",color:"#0369a1",padding:"1px 5px",borderRadius:4,fontWeight:700}}>V2</span>}
                <Badge status={q.status}/>
              </div>
              <div style={{fontSize:12,color:"#64748b"}}>{fmtTS(q.created_at)}</div>
              <div style={{fontSize:12,color:"#94a3b8",marginTop:2}}>
                {fmtArea(q.area_sqft)} · {q.crew_size} crew · {COMPLEXITY.find(o=>o.value===q.complexity)?.label} · {RISK.find(o=>o.value===q.risk)?.label}
              </div>
              {q.parent_id&&<div style={{fontSize:11,color:"#94a3b8",marginTop:2}}>Revision of {q.parent_id}</div>}
            </div>
            <div style={{textAlign:"right",flexShrink:0}}><div style={{fontSize:20,fontWeight:900,color:"#0f172a",letterSpacing:-.4}}>{$$(q.final_price)}</div></div>
          </div>
        </Card>
      ))}
    </>
  );

  if (isDesktop) {
    return (
      <div style={{display:"grid",gridTemplateColumns:"minmax(0,1fr) minmax(0,1.4fr)",gap:24}}>
        <div style={{minWidth:0}}>{contactCard}{measurementsCard}</div>
        <div style={{minWidth:0}}>{historyBlock}</div>
      </div>
    );
  }

  return(
    <div>
      <div style={{background:"#fff",padding:"calc(12px + env(safe-area-inset-top)) 16px 12px",borderBottom:"1px solid #e2e8f0",display:"flex",alignItems:"center",gap:12,position:"sticky",top:0,zIndex:10}}>
        <Back onClick={onBack}/><div style={{fontWeight:700,fontSize:16}}>{client.name}</div>
      </div>
      <div style={{padding:16}}>
        {contactCard}
        {measurementsCard}
        {historyBlock}
      </div>
    </div>
  );
}

// ─── Quote Detail ─────────────────────────────────────────────────────────────
function QuoteDetail({bp,quote,allQuotes,settings,onBack,onEdit,onDuplicate,onDelete,onAccepted}){
  const {canExportPDF,showUpgrade} = usePlan();
  const [confirmDel,setConfirmDel]=useState(false);
  const [copied,setCopied]=useState(false);
  const [lightbox,setLightbox]=useState(null);
  const attachments = Array.isArray(quote.attachments) ? quote.attachments : [];
  const snap={...settings,mow_rate:quote.mow_rate_used||settings.mow_rate,trim_rate:quote.trim_rate_used||settings.trim_rate,equipment_cost:quote.equipment_cost_used||settings.equipment_cost};
  const calc=calcQ(quote.area_sqft,quote.linear_ft,quote.complexity,quote.risk,quote.discount_pct||0,snap);
  const time=calcTime(quote.area_sqft,quote.linear_ft,quote.crew_size,quote.complexity);
  const ratesChanged=quote.mow_rate_used&&(quote.mow_rate_used!==settings.mow_rate||quote.trim_rate_used!==settings.trim_rate);
  const versions=allQuotes.filter(q=>q.parent_id===quote.quote_id||q.quote_id===quote.parent_id);
  const isSent=quote.status==="sent"||quote.status==="accepted";
  const isDesktop = bp==="desktop";

  const share=()=>{
    const txt=quoteText(quote,settings);
    const title=`Quote ${quote.quote_id} — ${quote.client_name||""}`.trim();
    if(navigator.share){navigator.share({title,text:txt}).catch(()=>{});}
    else{navigator.clipboard?.writeText(txt);setCopied(true);setTimeout(()=>setCopied(false),2000);}
  };
  const downloadPDF=async()=>{
    try { await generateQuotePDF(quote, settings, calc, time); }
    catch(e){ alert("Could not generate PDF: "+(e.message||"Unknown error")); }
  };

  const heroCard = (
    <Card style={{background:"#0f172a",textAlign:"center",padding:"28px 24px",boxShadow:"0 4px 16px rgba(15,23,42,.12)"}}>
      <div style={{fontSize:"var(--price-hero)",fontWeight:900,color:"#ffffff",letterSpacing:-2,lineHeight:1}}>{$$(quote.final_price)}</div>
      <div style={{fontSize:12,color:"#94a3b8",marginTop:8,fontWeight:500,textTransform:"uppercase",letterSpacing:1}}>Mowing · Trimming · Edging</div>
      {time&&<div style={{fontSize:13,color:"#4ade80",marginTop:8,fontWeight:700}}>Est. {fmtT(time.adj)}</div>}
      <div style={{marginTop:10,fontSize:11,color:"#64748b",fontWeight:500}}>Sent: {quote.sent_at?fmtTS(quote.sent_at):"Not yet sent"}</div>
    </Card>
  );
  const clientCard = quote.client_name && (
    <Card>
      <Lbl>Client</Lbl>
      <div style={{fontWeight:700,fontSize:16,marginBottom:4}}>{quote.client_name}</div>
      {quote.client_phone&&<a href={`tel:${quote.client_phone}`} style={{display:"block",fontSize:14,color:"#16a34a",textDecoration:"none",marginBottom:2}}>📞 {quote.client_phone}</a>}
      {quote.client_email&&<div style={{fontSize:14,color:"#64748b"}}>✉ {quote.client_email}</div>}
    </Card>
  );
  const jobDetailsCard = (
    <Card>
      <Lbl>Job Details</Lbl>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
        {[{l:"Address",v:quote.address,full:true},{l:"Area",v:fmtArea(quote.area_sqft)},{l:"Perimeter",v:`${Math.round(quote.linear_ft).toLocaleString()} ft`},{l:"Crew",v:`${quote.crew_size} worker${quote.crew_size>1?"s":""}`},{l:"Complexity",v:COMPLEXITY.find(o=>o.value===quote.complexity)?.label},{l:"Risk",v:RISK.find(o=>o.value===quote.risk)?.label},{l:"Discount",v:(quote.discount_pct||0)>0?`${quote.discount_pct}%`:"None"},{l:"Created",v:fmtTS(quote.created_at),full:true},{l:"Sent",v:quote.sent_at?fmtTS(quote.sent_at):"Not sent",full:true},{l:"Expires",v:quote.expiry_date?`${fmtD(quote.expiry_date)}${isExpired(quote.expiry_date)?" (expired)":""}`:"—",full:true}]
          .map(({l,v,full})=>(
            <div key={l} style={{gridColumn:full?"1 / -1":"auto"}}>
              <div style={{fontSize:10,fontWeight:700,color:"#94a3b8",textTransform:"uppercase"}}>{l}</div>
              <div style={{fontSize:13,fontWeight:600,color:"#0f172a",marginTop:2}}>{v}</div>
            </div>
          ))}
      </div>
    </Card>
  );
  const breakdownCard = calc && (
    <Card>
      <Lbl>Formula Breakdown</Lbl>
      {calc.bd.map((r,i)=>(
        <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",padding:"5px 0",borderBottom:r.subtotal?"1.5px solid #e2e8f0":"1px solid #f1f5f9",fontWeight:r.subtotal?700:400,color:r.subtotal?"#0f172a":r.modifier?"#64748b":"#334155"}}>
          <div><div style={{fontSize:13}}>{r.label}</div>{r.note&&<div style={{fontSize:10,color:"#cbd5e1"}}>{r.note}</div>}</div>
          <div style={{fontSize:13,fontWeight:600}}>{r.modifier&&r.value>0?"+":""}{$$(r.value)}</div>
        </div>
      ))}
      <div style={{display:"flex",justifyContent:"space-between",marginTop:10,fontSize:18,fontWeight:900,color:"#16a34a"}}><span>FINAL BID</span><span>{$$(quote.final_price)}</span></div>
      {quote.mow_rate_used&&<div style={{marginTop:10,padding:"8px 10px",background:"#f8fafc",borderRadius:8,fontSize:11,color:"#64748b"}}>Rates at quoting time: mow ${quote.mow_rate_used}/20k · trim ${quote.trim_rate_used}/3k · equip ${quote.equipment_cost_used}/hr</div>}
    </Card>
  );
  const notesCard = quote.notes && <Card><Lbl>Notes</Lbl><div style={{fontSize:14,color:"#334155",lineHeight:1.5}}>{quote.notes}</div></Card>;
  const attachmentsCard = attachments.length>0 && (
    <Card>
      <Lbl>Attachments ({attachments.length})</Lbl>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3, 1fr)",gap:8}}>
        {attachments.map(att=>{
          const isImg = att.type?.startsWith("image/");
          const isPdf = att.type==="application/pdf" || att.name?.toLowerCase().endsWith(".pdf");
          const onTap = ()=> isImg ? setLightbox(att) : window.open(att.url,"_blank","noopener,noreferrer");
          return (
            <div key={att.id} onClick={onTap} style={{cursor:"pointer"}}>
              <div style={{width:"100%",aspectRatio:"1",borderRadius:12,border:"1.5px solid #e2e8f0",background:"#f8fafc",overflow:"hidden",display:"flex",alignItems:"center",justifyContent:"center",fontSize:32}}>
                {isImg ? <img src={att.url} alt={att.name} style={{width:"100%",height:"100%",objectFit:"cover"}}/> : isPdf ? "📄" : "📎"}
              </div>
              <div style={{fontSize:10,color:"#64748b",marginTop:4,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontWeight:500}}>{att.name}</div>
            </div>
          );
        })}
      </div>
    </Card>
  );
  const threadCard = versions.length>0 && (
    <Card>
      <Lbl>Quote Thread</Lbl>
      {versions.sort((a,b)=>new Date(a.created_at)-new Date(b.created_at)).map((v,i,arr)=>(
        <div key={v.quote_id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 0",borderBottom:i<arr.length-1?"1px solid #e2e8f0":"none"}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}><QID id={v.quote_id}/><Badge status={v.status}/></div>
          <div style={{fontSize:14,fontWeight:700,color:"#0f172a"}}>{$$(v.final_price)}</div>
        </div>
      ))}
    </Card>
  );
  const banners = (
    <>
      {ratesChanged&&<div style={{background:"#fffbeb",border:"1px solid #fde68a",borderRadius:12,padding:"10px 14px",marginBottom:12,fontSize:12,color:"#92400e"}}>ℹ Rates changed since sent. Showing rates used at time of quoting.</div>}
      {isSent&&<div style={{background:"#eff6ff",border:"1px solid #bfdbfe",borderRadius:12,padding:"10px 14px",marginBottom:12,fontSize:13,color:"#1d4ed8"}}>✏️ <strong>Editing a sent quote creates a new V2</strong> — original preserved.</div>}
    </>
  );
  const actions = (
    <div style={{display:"flex",flexDirection:"column",gap:8}}>
      <Btn onClick={share} style={{width:"100%"}}>{copied?"✓ Copied!":"📤 Resend Quote"}</Btn>
      {canExportPDF
        ? <Btn variant="outline" onClick={downloadPDF} style={{width:"100%"}}>⬇ Download PDF</Btn>
        : <Btn variant="outline" onClick={()=>showUpgrade("PDF Quote Export")} style={{width:"100%",opacity:.7,display:"inline-flex",alignItems:"center",justifyContent:"center",gap:8}}><LockIcon size={14} color="#15803d"/>Download PDF — Pro</Btn>
      }
      {quote.status==="sent"&&<Btn variant="outline" onClick={onAccepted} style={{width:"100%"}}>✅ Mark as Accepted</Btn>}
      <Btn variant="warning" onClick={onEdit} style={{width:"100%"}}>✏️ {isSent?"Edit (creates V2 quote)":"Edit Quote"}</Btn>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
        <Btn variant="secondary" onClick={onDuplicate}>📋 Duplicate</Btn>
        {!confirmDel?<Btn variant="danger" onClick={()=>setConfirmDel(true)}>🗑 Delete</Btn>:<Btn variant="danger" onClick={onDelete}>Confirm ✓</Btn>}
      </div>
      {confirmDel&&<Btn variant="secondary" onClick={()=>setConfirmDel(false)} style={{width:"100%"}}>Cancel</Btn>}
    </div>
  );
  const lightboxEl = lightbox && (
    <div onClick={()=>setLightbox(null)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,.92)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center",padding:20,cursor:"pointer"}}>
      <img src={lightbox.url} alt={lightbox.name} style={{maxWidth:"100%",maxHeight:"100%",objectFit:"contain",borderRadius:8}}/>
      <button onClick={e=>{e.stopPropagation();setLightbox(null);}} style={{position:"absolute",top:16,right:16,width:44,height:44,borderRadius:"50%",background:"rgba(255,255,255,.15)",border:"none",color:"#fff",fontSize:22,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",justifyContent:"center"}}>×</button>
    </div>
  );

  if (isDesktop) {
    return (
      <div>
        {banners}
        {heroCard}
        <div style={{display:"grid",gridTemplateColumns:"minmax(0,1.4fr) minmax(0,1fr)",gap:24,marginTop:4}}>
          <div style={{minWidth:0}}>{jobDetailsCard}{breakdownCard}{notesCard}</div>
          <div style={{minWidth:0}}>{clientCard}{attachmentsCard}{threadCard}{actions}</div>
        </div>
        {lightboxEl}
      </div>
    );
  }

  return(
    <div>
      <div style={{background:"#fff",padding:"calc(12px + env(safe-area-inset-top)) 16px 12px",borderBottom:"1px solid #e2e8f0",display:"flex",alignItems:"center",gap:12,position:"sticky",top:0,zIndex:10}}>
        <Back onClick={onBack}/>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontWeight:700,fontSize:15,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{quote.client_name||"Quote"}</div>
          <div style={{display:"flex",alignItems:"center",gap:6,marginTop:2}}>
            <QID id={quote.quote_id}/>
            {quote.parent_id&&<span style={{fontSize:10,background:"#e0f2fe",color:"#0369a1",padding:"1px 5px",borderRadius:4,fontWeight:700}}>REVISED</span>}
          </div>
        </div>
        <Badge status={quote.status}/>
      </div>
      <div style={{padding:16}}>
        {banners}
        {threadCard}
        {heroCard}
        {clientCard}
        {jobDetailsCard}
        {breakdownCard}
        {notesCard}
        {attachmentsCard}
        {lightboxEl}
        {actions}
      </div>
    </div>
  );
}

// ─── Settings ─────────────────────────────────────────────────────────────────
function PlanBadge(){
  const {plan,planName,quoteLimit,quotesUsed} = usePlan();
  if (plan === "free") {
    return (
      <Card style={{background:"#f0fdf4",border:"1px solid #bbf7d0",display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:"wrap",padding:"16px 18px",marginBottom:14}}>
        <div style={{minWidth:0}}>
          <div style={{fontSize:14,fontWeight:700,color:"#166534"}}>Free Plan</div>
          <div style={{fontSize:12,color:"#15803d",fontWeight:500,marginTop:3}}>{quotesUsed} of {quoteLimit} quotes used · Rolling 30 days</div>
        </div>
        <button onClick={()=>redirectToStripeCheckout(import.meta.env.VITE_STRIPE_PRO_PRICE_ID)} style={{height:36,minHeight:36,padding:"0 14px",borderRadius:10,border:"none",background:"#15803d",color:"#ffffff",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap"}}>Upgrade to Pro →</button>
      </Card>
    );
  }
  return (
    <Card style={{background:"#f0fdf4",border:"1px solid #bbf7d0",display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,padding:"16px 18px",marginBottom:14}}>
      <div style={{minWidth:0}}>
        <div style={{fontSize:14,fontWeight:700,color:"#166534"}}>{planName} Plan</div>
        <div style={{fontSize:12,color:"#15803d",fontWeight:600,marginTop:3}}>Unlimited quotes ✓</div>
      </div>
    </Card>
  );
}

function SettingsScreen({bp,settings,onSave,onLogout}){
  const [loc,setLoc]=useState(settings);
  const [tip,setTip]=useState(null);
  const [saved,setSaved]=useState(false);
  const [autoSaveErr,setAutoSaveErr]=useState("");
  const set=(k,v)=>setLoc(s=>({...s,[k]:v}));
  // Auto-save with 1.5s debounce — "set it and forget it"
  const isFirstRender = useRef(true);
  useEffect(()=>{
    if (isFirstRender.current) { isFirstRender.current = false; return; }
    setAutoSaveErr("");
    const t = setTimeout(()=>{
      onSave(loc).then(()=>{
        setSaved(true); setTimeout(()=>setSaved(false),1500);
      }).catch(e=>{
        console.error("[LawnBid] Auto-save failed:", e);
        setAutoSaveErr("Could not save — check connection.");
        setTimeout(()=>setAutoSaveErr(""),4000);
      });
    }, 1500);
    return ()=>clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[loc]);
  const save=async()=>{
    try { await onSave(loc); setSaved(true); setTimeout(()=>setSaved(false),2000); }
    catch(e) { console.error("[LawnBid] Settings save failed:", e); alert("Could not save settings. Check your connection and try again."); }
  };
  const reset=async()=>{if(confirm("Reset formula settings to defaults?")){const ns={...loc,...DEFAULT_SETTINGS};setLoc(ns);try{await onSave(ns);}catch(e){console.error("[LawnBid] Settings reset failed:",e);}}};
  const TIPS={mow_rate:"Dollar value of mowing 20,000 sqft (≈½ acre) in 1 hr.",trim_rate:"Cost to trim 3,000 linear feet in 1 hr. Most crews do 2,500–4,000 ft/hr.",equipment_cost:"Hourly cost to run your equipment — fuel, maintenance, depreciation.",hourly_rate:"True cost per worker per hour: wages + payroll taxes + benefits.",minimum_bid:"No quote goes below this. Covers drive time, mobilization, admin.",quote_validity_days:"How many days a new quote is valid before it is marked expired.",profit_margin:"Your target profit. 30% means for every $100 charged, $30 is profit after all costs. Most lawn care businesses target 25–40%. Formula: price = cost ÷ (1 - margin)"};
  const FIELDS=[{key:"mow_rate",label:"Mow Rate ($/20k sqft)"},{key:"trim_rate",label:"Trim Rate ($/3k linear ft)"},{key:"equipment_cost",label:"Equipment Cost ($/hr)"},{key:"hourly_rate",label:"Hourly Rate ($/worker/hr)"},{key:"minimum_bid",label:"Minimum Bid ($)"},{key:"profit_margin",label:"Profit Margin (%)",pct:true},{key:"quote_validity_days",label:"Quote Valid For (days)"}];
  const [logoMsg,setLogoMsg]=useState("");
  const compressLogo = (file) => new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const MAX = 256;
      let w = img.width, h = img.height;
      if (w > MAX || h > MAX) {
        if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
        else { w = Math.round(w * MAX / h); h = MAX; }
      }
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL("image/png", 0.9));
      URL.revokeObjectURL(url);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
  const onLogo=async e=>{
    const f=e.target.files?.[0]; if(!f) return;
    if(!/^image\/(png|jpe?g|webp)$/i.test(f.type)){ alert("Please choose a PNG, JPG, or WebP image."); return; }
    setLogoMsg("Processing…");
    const b64 = await compressLogo(f);
    if (!b64) { setLogoMsg("Could not read image."); setTimeout(()=>setLogoMsg(""), 3000); return; }
    console.log("[LawnBid] Logo compressed:", Math.round(b64.length/1024)+"KB");
    const next = { ...loc, company_logo_base64: b64 };
    setLoc(next);
    try {
      await onSave(next);
      try { localStorage.setItem(COMPANY_LOGO_CACHE, b64); } catch {}
      setLogoMsg("Logo saved ✓"); setTimeout(()=>setLogoMsg(""), 2000);
    } catch(err) {
      console.error("[LawnBid] Logo save failed:", err);
      setLogoMsg("Could not save logo — check connection and try again.");
      setTimeout(()=>setLogoMsg(""), 4000);
      setLoc(s => ({ ...s, company_logo_base64: settings.company_logo_base64 || "" }));
    }
  };
  const onLogoImgError = () => {
    setLoc(s => ({ ...s, company_logo_base64: "" }));
  };
  const removeLogo=async()=>{
    const next = { ...loc, company_logo_base64: "" };
    setLoc(next);
    try { await onSave(next); try { localStorage.removeItem(COMPANY_LOGO_CACHE); } catch {} }
    catch(err) { console.error("[LawnBid] Logo remove failed:", err); }
  };
  const isDesktop = bp==="desktop";
  const formulaCard = (
      <Card>
        <Lbl>Formula Defaults</Lbl>
        {FIELDS.map(({key,label,pct})=>{
          const val = pct ? Math.round((loc[key] ?? 0) * 100) : loc[key];
          const onChange = pct
            ? e => { const n = Math.min(80, Math.max(0, parseFloat(e.target.value)||0)); set(key, n/100); }
            : e => set(key, parseFloat(e.target.value)||0);
          return (
          <div key={key} style={{marginBottom:14}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
              <span style={{fontSize:13,fontWeight:600,color:"#334155"}}>{label}</span>
              <button onClick={()=>setTip(tip===key?null:key)} style={{width:20,height:20,borderRadius:"50%",border:"1.5px solid #d1d5db",background:"none",fontSize:10,cursor:"pointer",color:"#64748b",fontFamily:"inherit"}}>?</button>
            </div>
            {tip===key&&<div style={{background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:8,padding:"8px 12px",fontSize:12,color:"#166534",marginBottom:6}}>{TIPS[key]}</div>}
            <Inp type="number" min={pct?0:undefined} max={pct?80:undefined} value={val} onChange={onChange}/>
          </div>
          );
        })}
        <div style={{marginBottom:12}}>
          <Lbl>Complexity Default</Lbl>
          <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>{COMPLEXITY.map(o=><Chip key={o.value} label={`${o.label} (${o.value}×)`} active={loc.complexity_default===o.value} onClick={()=>set("complexity_default",o.value)}/>)}</div>
        </div>
        <div>
          <Lbl>Risk Default</Lbl>
          <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>{RISK.map(o=><Chip key={o.value} label={`${o.label} (${o.value}×)`} active={loc.risk_default===o.value} onClick={()=>set("risk_default",o.value)}/>)}</div>
        </div>
      </Card>
  );
  const businessCard = (
      <Card>
        <Lbl>Business Info</Lbl>
        <div style={{marginBottom:14}}>
          <div style={{fontSize:13,fontWeight:600,color:"#334155",marginBottom:8}}>Company Logo</div>
          <div style={{display:"flex",alignItems:"center",gap:14}}>
            {loc.company_logo_base64
              ? <img src={loc.company_logo_base64} alt="Logo" onError={onLogoImgError} style={{width:64,height:64,borderRadius:"50%",objectFit:"cover",border:"1.5px solid #e2e8f0"}}/>
              : <div style={{width:64,height:64,borderRadius:"50%",background:"#f1f5f9",border:"1.5px dashed #cbd5e1",display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,color:"#94a3b8"}}>🏢</div>
            }
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              <label style={{height:36,minHeight:36,padding:"0 14px",borderRadius:12,border:"1.5px solid #15803d",background:"#ffffff",color:"#15803d",fontSize:13,fontWeight:600,cursor:"pointer",display:"inline-flex",alignItems:"center",justifyContent:"center",fontFamily:"inherit"}}>
                {loc.company_logo_base64?"Replace Logo":"Upload Logo"}
                <input type="file" accept="image/png,image/jpeg,image/webp" onChange={onLogo} style={{display:"none"}}/>
              </label>
              {loc.company_logo_base64 && <button onClick={removeLogo} style={{background:"none",border:"none",color:"#dc2626",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit",textAlign:"left",padding:0}}>Remove</button>}
              {logoMsg && <div style={{fontSize:12,color:logoMsg.startsWith("Logo saved")?"#15803d":"#dc2626",fontWeight:600}}>{logoMsg}</div>}
            </div>
          </div>
        </div>
        {[["company_name","Company Name","text","Your Company"],["company_phone","Phone","tel","(555) 000-0000"],["company_email","Email","email","you@example.com"]].map(([k,lbl,t,ph])=>(
          <div key={k} style={{marginBottom:12}}>
            <div style={{fontSize:13,fontWeight:600,color:"#334155",marginBottom:4}}>{lbl}</div>
            <Inp type={t} value={loc[k]||""} onChange={e=>set(k,e.target.value)} placeholder={ph}/>
          </div>
        ))}
      </Card>
  );
  const footer = (
    <>
      {autoSaveErr && <div style={{fontSize:12,color:"#dc2626",background:"#fef2f2",borderLeft:"3px solid #dc2626",borderRadius:"0 8px 8px 0",padding:"8px 10px",fontWeight:500,marginBottom:10}}>⚠ {autoSaveErr}</div>}
      <Btn onClick={save} style={{width:"100%"}}>{saved?"✓ Saved!":"Save Settings"}</Btn>
      <div style={{textAlign:"center",fontSize:11,color:"#94a3b8",marginTop:6}}>Settings auto-save as you type</div>
      <Btn variant="danger" onClick={onLogout} style={{width:"100%",marginTop:10}}>Log Out</Btn>
      <div style={{textAlign:"center",fontSize:11,color:"#94a3b8",marginTop:20}}>LawnBid v{APP_VERSION} · Built for lawn care professionals</div>
    </>
  );

  if (isDesktop) {
    return (
      <div>
        <PlanBadge/>
        <div style={{display:"flex",justifyContent:"flex-end",marginBottom:12}}>
          <button onClick={reset} style={{background:"none",border:"none",color:"#dc2626",fontSize:13,fontWeight:700,cursor:"pointer",padding:"8px 12px",minHeight:36}}>↺ Reset Defaults</button>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"minmax(0,1fr) minmax(0,1fr)",gap:24,marginBottom:16}}>
          <div style={{minWidth:0}}>{formulaCard}</div>
          <div style={{minWidth:0}}>{businessCard}</div>
        </div>
        <div style={{maxWidth:480,marginLeft:"auto",marginRight:"auto"}}>{footer}</div>
      </div>
    );
  }

  return(
    <div style={{padding:16}}>
      <PlanBadge/>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
        <div style={{fontSize:26,fontWeight:900,color:"#0f172a"}}>Settings</div>
        <button onClick={reset} style={{background:"none",border:"none",color:"#dc2626",fontSize:13,fontWeight:700,cursor:"pointer",minHeight:36,padding:"6px 0"}}>↺ Reset Defaults</button>
      </div>
      {formulaCard}
      {businessCard}
      {footer}
    </div>
  );
}

// ─── Auth Screen ──────────────────────────────────────────────────────────────
const LockIcon = ({size=14,color="#94a3b8"}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{flexShrink:0}}>
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
  </svg>
);
const EyeOpen = ({color}) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
  </svg>
);
const EyeOff = ({color}) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a19.79 19.79 0 0 1 5.06-5.94M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a19.77 19.77 0 0 1-3.17 4.19"/>
    <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><line x1="1" y1="1" x2="23" y2="23"/>
  </svg>
);

function AuthScreen(){
  // Read ?plan= and ?new=1 from URL to route new users to signup
  const urlParams = (()=>{ try { return new URLSearchParams(window.location.search); } catch { return new URLSearchParams(); } })();
  const initialPlanFromUrl = (()=>{ const p = urlParams.get("plan"); return p==="pro"||p==="team"?p:null; })();
  const isNewFromUrl = urlParams.get("new") === "1";
  if (initialPlanFromUrl) {
    try { localStorage.setItem("lb_intended_plan", initialPlanFromUrl); } catch {}
  }
  const [mode,setMode]=useState(
    (initialPlanFromUrl || isNewFromUrl) ? "signup" : "login"
  ); // "login" | "signup" | "reset"
  const [email,setEmail]=useState("");
  const [password,setPassword]=useState("");
  const [password2,setPassword2]=useState("");
  const [showPw,setShowPw]=useState(false);
  const [showPw2,setShowPw2]=useState(false);
  const [err,setErr]=useState("");
  const [info,setInfo]=useState("");
  const [busy,setBusy]=useState(false);

  const clearMsgs = () => { setErr(""); setInfo(""); };
  const pwLongEnough = password.length >= 6;
  const pwMatch = password2.length > 0 && password === password2;
  const canSignup = pwLongEnough && pwMatch && email.trim().length > 0;

  const login=async()=>{
    clearMsgs(); setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if(error) setErr(authErrorMessage(error));
  };
  const [emailBlurred,setEmailBlurred]=useState(false);
  const emailLooksValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const signup=async()=>{
    clearMsgs();
    if (!pwLongEnough) { setErr("Password must be at least 6 characters long."); return; }
    if (!pwMatch) { setErr("Passwords do not match. Please retype."); return; }
    setBusy(true);
    const { data, error } = await supabase.auth.signUp({ email, password });
    setBusy(false);
    if (error) { setErr(authErrorMessage(error)); return; }
    // Supabase returns an empty identities array when the email is already registered
    if (data?.user?.identities?.length === 0) {
      setErr("duplicate-email");
      return;
    }
    if (!data.session) setInfo("signup-check-email");
  };
  const sendReset=async()=>{
    clearMsgs(); setBusy(true);
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: "https://winwinlawnbid.com/app" });
    setBusy(false);
    if(error) setErr(authErrorMessage(error));
    else setInfo(`Check your email — we sent a password reset link to ${email}`);
  };

  const cachedLogo = (()=>{ try { return localStorage.getItem(COMPANY_LOGO_CACHE) || ""; } catch { return ""; } })();
  const logoSrc = cachedLogo || "/logo.png";
  const subtitleFor = m => m==="reset"?"Reset your password":m==="signup"?"Create your account":"Sign in to your account";

  return(
    <div style={{maxWidth:480,margin:"0 auto",minHeight:"100vh",display:"flex",flexDirection:"column",justifyContent:"center",padding:"24px",fontFamily:"'Inter',system-ui,-apple-system,sans-serif",background:"#f8fafc",boxSizing:"border-box",color:"#0f172a"}}>
      <div style={{textAlign:"center",marginBottom:28}}>
        <img src={logoSrc} alt="LawnBid" style={{width:72,height:72,borderRadius:"50%",objectFit:"cover",marginBottom:12}}/>
        <div style={{fontSize:32,fontWeight:900,color:"#0f172a",letterSpacing:-.6}}>LawnBid</div>
        <div style={{fontSize:13,color:"#64748b",marginTop:4,fontWeight:500}}>{subtitleFor(mode)}</div>
      </div>
      {mode==="signup" && initialPlanFromUrl && (
        <div style={{background:"#dcfce7",border:"1px solid #bbf7d0",borderLeft:"3px solid #15803d",borderRadius:"0 10px 10px 0",padding:"10px 14px",marginBottom:12,fontSize:13,color:"#166534",fontWeight:600,display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontSize:15}}>🌿</span>
          <span>You're signing up for LawnBid {initialPlanFromUrl==="pro"?"Pro":"Team"} — 14-day free trial</span>
        </div>
      )}
      <Card>
        <div style={{marginBottom:12}}>
          <div style={{fontSize:13,fontWeight:600,color:"#334155",marginBottom:4}}>Email</div>
          <Inp type="email" value={email} onChange={e=>{setEmail(e.target.value);setEmailBlurred(false);}} onBlur={()=>setEmailBlurred(true)} placeholder="you@example.com" autoComplete="email"/>
          {mode==="signup" && emailBlurred && emailLooksValid && (
            <div style={{fontSize:12,color:"#64748b",marginTop:6}}>If you already have an account, <button type="button" onClick={()=>{clearMsgs();setMode("login");}} style={{background:"none",border:"none",color:"#15803d",fontSize:12,fontWeight:600,cursor:"pointer",textDecoration:"underline",padding:0,fontFamily:"inherit"}}>log in instead →</button></div>
          )}
        </div>
        {mode==="login" && (
          <>
            <div style={{marginBottom:4}}>
              <div style={{fontSize:13,fontWeight:600,color:"#334155",marginBottom:4}}>Password</div>
              <div style={{position:"relative"}}>
                <Inp type={showPw?"text":"password"} value={password} onChange={e=>setPassword(e.target.value)} placeholder="••••••••" autoComplete="current-password" style={{paddingRight:44}}/>
                <button type="button" onClick={()=>setShowPw(v=>!v)} aria-label={showPw?"Hide password":"Show password"} style={{position:"absolute",right:12,top:"50%",transform:"translateY(-50%)",width:24,height:24,minHeight:24,padding:0,border:"none",background:"transparent",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>
                  {showPw ? <EyeOpen color="#15803d"/> : <EyeOff color="#94a3b8"/>}
                </button>
              </div>
            </div>
            <div style={{textAlign:"right",marginBottom:12}}>
              <button type="button" onClick={()=>{clearMsgs();setMode("reset");}} style={{background:"none",border:"none",color:"#15803d",fontSize:12,fontWeight:600,cursor:"pointer",textDecoration:"underline",padding:"4px 0",minHeight:28,fontFamily:"inherit"}}>Forgot password?</button>
            </div>
            <Btn onClick={login} disabled={busy||!email||!password} style={{width:"100%"}}>Log In</Btn>
            <div style={{height:1,background:"#e2e8f0",margin:"16px 0"}}/>
            <div style={{textAlign:"center",fontSize:13,color:"#64748b"}}>
              Don't have an account? <button type="button" onClick={()=>{clearMsgs();setMode("signup");}} style={{background:"none",border:"none",color:"#15803d",fontSize:13,fontWeight:600,cursor:"pointer",textDecoration:"underline",padding:"4px 2px",fontFamily:"inherit"}}>Create one →</button>
            </div>
          </>
        )}
        {mode==="signup" && (
          <>
            <div style={{marginBottom:12}}>
              <div style={{fontSize:13,fontWeight:600,color:"#334155",marginBottom:4}}>Password</div>
              <div style={{position:"relative"}}>
                <Inp type={showPw?"text":"password"} value={password} onChange={e=>setPassword(e.target.value)} placeholder="At least 6 characters" autoComplete="new-password" style={{paddingRight:44}}/>
                <button type="button" onClick={()=>setShowPw(v=>!v)} aria-label={showPw?"Hide password":"Show password"} style={{position:"absolute",right:12,top:"50%",transform:"translateY(-50%)",width:24,height:24,minHeight:24,padding:0,border:"none",background:"transparent",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>
                  {showPw ? <EyeOpen color="#15803d"/> : <EyeOff color="#94a3b8"/>}
                </button>
              </div>
            </div>
            <div style={{marginBottom:12}}>
              <div style={{fontSize:13,fontWeight:600,color:"#334155",marginBottom:4}}>Confirm password</div>
              <div style={{position:"relative"}}>
                <Inp type={showPw2?"text":"password"} value={password2} onChange={e=>setPassword2(e.target.value)} placeholder="Retype your password" autoComplete="new-password" style={{paddingRight:72}}/>
                {password2.length>0 && (
                  <span style={{position:"absolute",right:44,top:"50%",transform:"translateY(-50%)",display:"flex",alignItems:"center",justifyContent:"center",pointerEvents:"none"}}>
                    {pwMatch
                      ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#15803d" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                      : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>}
                  </span>
                )}
                <button type="button" onClick={()=>setShowPw2(v=>!v)} aria-label={showPw2?"Hide password":"Show password"} style={{position:"absolute",right:12,top:"50%",transform:"translateY(-50%)",width:24,height:24,minHeight:24,padding:0,border:"none",background:"transparent",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>
                  {showPw2 ? <EyeOpen color="#15803d"/> : <EyeOff color="#94a3b8"/>}
                </button>
              </div>
            </div>
            <Btn onClick={signup} disabled={busy||!canSignup} style={{width:"100%"}}>{busy?"Creating account…":"Create Account"}</Btn>
            <div style={{height:1,background:"#e2e8f0",margin:"16px 0"}}/>
            <div style={{textAlign:"center",fontSize:13,color:"#64748b"}}>
              Already have an account? <button type="button" onClick={()=>{clearMsgs();setMode("login");}} style={{background:"none",border:"none",color:"#15803d",fontSize:13,fontWeight:600,cursor:"pointer",textDecoration:"underline",padding:"4px 2px",fontFamily:"inherit"}}>Log in →</button>
            </div>
          </>
        )}
        {mode==="reset" && (
          <>
            <Btn onClick={sendReset} disabled={busy||!email} style={{width:"100%",marginTop:4}}>Send Reset Link</Btn>
            <div style={{textAlign:"center",marginTop:12}}>
              <button type="button" onClick={()=>{clearMsgs();setMode("login");}} style={{background:"none",border:"none",color:"#15803d",fontSize:13,fontWeight:600,cursor:"pointer",textDecoration:"underline",padding:"6px 0",minHeight:28,fontFamily:"inherit"}}>← Back to login</button>
            </div>
          </>
        )}
        {err==="duplicate-email" ? (
          <div style={{marginTop:12,padding:"12px 14px",background:"#eff6ff",borderLeft:"3px solid #3b82f6",borderRadius:"0 8px 8px 0",color:"#1e40af",fontSize:13,fontWeight:500,lineHeight:1.5}}>
            An account with <strong>{email}</strong> already exists.
            <div style={{marginTop:8}}>
              <button type="button" onClick={()=>{clearMsgs();setMode("login");}} style={{height:36,minHeight:36,padding:"0 16px",borderRadius:8,border:"none",background:"#3b82f6",color:"#ffffff",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Log in instead →</button>
            </div>
          </div>
        ) : err ? <ErrBox style={{marginTop:12}}>{err}</ErrBox> : null}
        {info==="signup-check-email" ? (
          <div style={{marginTop:12,padding:"10px 12px",background:"#f0fdf4",borderLeft:"3px solid #16a34a",borderRadius:"0 8px 8px 0",color:"#166534",fontSize:13,fontWeight:500,lineHeight:1.5}}>
            ✓ Check your email to confirm your account. If you already have an account, use the login screen instead.
            <div style={{marginTop:6}}><button type="button" onClick={()=>{clearMsgs();setMode("login");}} style={{background:"none",border:"none",color:"#15803d",fontSize:13,fontWeight:600,cursor:"pointer",textDecoration:"underline",padding:0,fontFamily:"inherit"}}>Already have an account? Log in →</button></div>
          </div>
        ) : info ? (
          <div style={{marginTop:12,padding:"10px 12px",background:"#f0fdf4",borderLeft:"3px solid #16a34a",borderRadius:"0 8px 8px 0",color:"#166534",fontSize:13,fontWeight:500}}>✓ {info}</div>
        ) : null}
      </Card>
      <div style={{textAlign:"center",marginTop:16}}>
        <a href="https://winwinlawnbid.com" style={{color:"#94a3b8",fontSize:12,fontWeight:500,textDecoration:"none"}}>← Back to winwinlawnbid.com</a>
      </div>
    </div>
  );
}

// ─── Reset Password Screen (after email recovery link) ───
function ResetPasswordScreen({onDone}){
  const [pw,setPw]=useState("");
  const [pw2,setPw2]=useState("");
  const [showPw,setShowPw]=useState(false);
  const [showPw2,setShowPw2]=useState(false);
  const [err,setErr]=useState("");
  const [info,setInfo]=useState("");
  const [busy,setBusy]=useState(false);

  const submit = async () => {
    setErr(""); setInfo("");
    if (pw.length < 6) { setErr("Password must be at least 6 characters. Please choose a longer password."); return; }
    if (pw !== pw2) { setErr("Passwords do not match. Please retype the new password."); return; }
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: pw });
    setBusy(false);
    if (error) { setErr(authErrorMessage(error)); return; }
    setInfo("Password updated. You're now logged in.");
    setTimeout(onDone, 1200);
  };

  return(
    <div style={{maxWidth:480,margin:"0 auto",minHeight:"100vh",display:"flex",flexDirection:"column",justifyContent:"center",padding:"24px",fontFamily:"'Inter',system-ui,-apple-system,sans-serif",background:"#f8fafc",boxSizing:"border-box",color:"#0f172a"}}>
      <div style={{textAlign:"center",marginBottom:28}}>
        <img src="/logo.png" alt="LawnBid" style={{width:72,height:72,borderRadius:"50%",objectFit:"cover",marginBottom:12}}/>
        <div style={{fontSize:32,fontWeight:900,color:"#0f172a",letterSpacing:-.8}}>Set a new password</div>
        <div style={{fontSize:13,color:"#64748b",marginTop:4,fontWeight:500}}>Choose something at least 6 characters long.</div>
      </div>
      <Card>
        <div style={{marginBottom:12}}>
          <div style={{fontSize:13,fontWeight:600,color:"#334155",marginBottom:4}}>New password</div>
          <div style={{position:"relative"}}>
            <Inp type={showPw?"text":"password"} value={pw} onChange={e=>setPw(e.target.value)} placeholder="••••••••" autoComplete="new-password" style={{paddingRight:44}}/>
            <button type="button" onClick={()=>setShowPw(v=>!v)} aria-label={showPw?"Hide password":"Show password"} style={{position:"absolute",right:12,top:"50%",transform:"translateY(-50%)",width:24,height:24,minHeight:24,padding:0,border:"none",background:"transparent",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>
              {showPw ? <EyeOpen color="#15803d"/> : <EyeOff color="#94a3b8"/>}
            </button>
          </div>
        </div>
        <div style={{marginBottom:12}}>
          <div style={{fontSize:13,fontWeight:600,color:"#334155",marginBottom:4}}>Confirm new password</div>
          <div style={{position:"relative"}}>
            <Inp type={showPw2?"text":"password"} value={pw2} onChange={e=>setPw2(e.target.value)} placeholder="••••••••" autoComplete="new-password" style={{paddingRight:44}}/>
            <button type="button" onClick={()=>setShowPw2(v=>!v)} aria-label={showPw2?"Hide password":"Show password"} style={{position:"absolute",right:12,top:"50%",transform:"translateY(-50%)",width:24,height:24,minHeight:24,padding:0,border:"none",background:"transparent",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>
              {showPw2 ? <EyeOpen color="#15803d"/> : <EyeOff color="#94a3b8"/>}
            </button>
          </div>
        </div>
        <Btn onClick={submit} disabled={busy||!pw||!pw2} style={{width:"100%",marginTop:4}}>{busy?"Updating…":"Update Password"}</Btn>
        {err && <ErrBox style={{marginTop:12}}>{err}</ErrBox>}
        {info && <div style={{marginTop:12,padding:"10px 12px",background:"#f0fdf4",borderLeft:"3px solid #16a34a",borderRadius:"0 8px 8px 0",color:"#166534",fontSize:13,fontWeight:500}}>✓ {info}</div>}
      </Card>
    </div>
  );
}

// ─── Quote Flow ────────────────────────────────────────────────────────────────
function QuoteFlow({bp,step,setStep,flow,setFlow,errors,setErrors,settings,clients,quotes,onSave,onCancel,saving}){
  const isDesktop = bp==="desktop";
  const [sharePay,setSharePay]=useState(null);
  const [copied,setCopied]=useState(false);
  const set=(k,v)=>setFlow(f=>({...f,[k]:v}));

  const aU=AREA_UNITS.find(u=>u.value===flow.areaUnit)||AREA_UNITS[0];
  const pU=PERIM_UNITS.find(u=>u.value===flow.perimUnit)||PERIM_UNITS[0];
  const area=aU.conv(parseFloat(flow.areaVal)||0);
  const perim=pU.conv(parseFloat(flow.perimVal)||0);
  const calc=calcQ(area,perim,flow.cx,flow.risk,flow.disc,settings,flow.override);
  const time=calcTime(area,perim,flow.crew,flow.cx);

  const v1=()=>{const e={};
    if(!flow.clientName?.trim()) e.clientName="Enter the client's name to continue.";
    if(!flow.clientPhone?.trim()) e.clientPhone="A phone number is required to send quotes.";
    if(!flow.address?.trim()) e.address="Enter the property address to load the map.";
    setErrors(e); return !Object.keys(e).length;};
  const v2=()=>{const e={};
    if(!flow.areaVal||area<=0) e.area="Enter the lawn area or use the map to draw the property boundary.";
    if(!flow.perimVal||perim<=0) e.perim="Enter the perimeter or draw the boundary on the map — it calculates automatically.";
    setErrors(e); return !Object.keys(e).length;};
  const next=()=>{if(step===1&&!v1())return;if(step===2&&!v2())return;setStep(s=>s+1);};

  const buildRec=(status)=>({
    isNew:flow.isNew!==false, existingId:flow.existingId||null, parentId:flow.parentId||null,
    address:flow.address, area_sqft:area, linear_ft:perim, crew_size:flow.crew,
    complexity:flow.cx, risk:flow.risk, discount_pct:flow.disc,
    mow_rate_used:settings.mow_rate, trim_rate_used:settings.trim_rate, equipment_cost_used:settings.equipment_cost,
    formula_price:calc?.fl||0, final_price:calc?.disp||0, status,
    clientId:flow.clientId, client_name:flow.clientName, client_phone:flow.clientPhone, client_email:flow.clientEmail,
    notes:flow.notes, attachments:flow.attachments||[], saveClient:flow.saveClient, sentAt:flow.sentAt||null,
  });
  const buildCli=()=>flow.saveClient?{name:flow.clientName,phone:flow.clientPhone,email:flow.clientEmail,default_address:flow.address,last_area_sqft:area,last_linear_ft:perim}:null;

  const handleSend=async(status)=>{
    const rec=buildRec(status),cli=buildCli();
    if(status==="sent"){
      // Reserve the real quote_id now so the shared text shows it (not "PENDING")
      if(!rec.existingId){
        try{ rec.existingId=await nextQuoteId(); }
        catch(e){ alert(dbErrorMessage(e)); return; }
      }
      const preview={...rec,quote_id:rec.existingId,created_at:new Date().toISOString()};
      const txt=quoteText(preview,settings);
      if(navigator.share){try{await navigator.share({text:txt});}catch(_){}onSave(rec,cli,status);}
      else setSharePay({txt,rec,cli});
    } else onSave(rec,cli,status);
  };

  const STEPS=["Client & Address","Measurements","Quote Builder","Review & Send"];

  return(
    <div>
      {sharePay&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.6)",zIndex:200,display:"flex",alignItems:isDesktop||bp==="tablet"?"center":"flex-end",justifyContent:"center",padding:isDesktop||bp==="tablet"?20:0}}>
          <div style={{background:"#fff",borderRadius:isDesktop||bp==="tablet"?16:"16px 16px 0 0",padding:20,width:"100%",maxWidth:480,boxSizing:"border-box",paddingBottom:isDesktop||bp==="tablet"?20:"calc(20px + env(safe-area-inset-bottom))"}}>
            <div style={{fontWeight:700,fontSize:17,marginBottom:12}}>📤 Ready to Send</div>
            <textarea readOnly value={sharePay.txt} style={{width:"100%",height:200,border:"1.5px solid #e2e8f0",borderRadius:12,padding:"10px 12px",fontSize:12,fontFamily:"ui-monospace,monospace",boxSizing:"border-box",resize:"none"}}/>
            <div style={{display:"flex",gap:8,marginTop:12}}>
              <Btn style={{flex:1}} onClick={()=>{navigator.clipboard?.writeText(sharePay.txt);setCopied(true);setTimeout(()=>setCopied(false),2000);}}>{copied?"✓ Copied!":"Copy"}</Btn>
              <Btn variant="secondary" style={{flex:1}} onClick={()=>{const{rec,cli}=sharePay;setSharePay(null);onSave(rec,cli,"sent");}}>Done ›</Btn>
            </div>
          </div>
        </div>
      )}
      {!isDesktop && (
        <div style={{background:"#fff",padding:"calc(12px + env(safe-area-inset-top)) 16px 12px",borderBottom:"1px solid #e2e8f0",display:"flex",alignItems:"center",gap:12,position:"sticky",top:0,zIndex:10}}>
          <button onClick={step===1?onCancel:()=>setStep(s=>s-1)} style={{width:40,height:40,minHeight:40,display:"inline-flex",alignItems:"center",justifyContent:"center",background:"none",border:"none",fontSize:24,cursor:"pointer",color:"#15803d",fontFamily:"inherit",lineHeight:1,padding:0,marginLeft:-8}}>‹</button>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontWeight:700,fontSize:15}}>{flow.parentId?"New V2 Quote":"New Quote"} — Step {step} of 4</div>
            <div style={{fontSize:12,color:"#64748b"}}>{STEPS[step-1]}{flow.parentId?` · Revision of ${flow.parentId}`:""}</div>
          </div>
          <button onClick={onCancel} style={{width:40,height:40,minHeight:40,display:"inline-flex",alignItems:"center",justifyContent:"center",background:"none",border:"none",fontSize:16,color:"#94a3b8",cursor:"pointer",fontFamily:"inherit"}}>✕</button>
        </div>
      )}
      {isDesktop ? (
        <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:20}}>
          {STEPS.map((lbl,i)=>{
            const n=i+1, done=n<step, active=n===step;
            return (
              <button key={n} onClick={()=>n<step&&setStep(n)} style={{flex:1,display:"flex",alignItems:"center",gap:10,padding:"10px 14px",minHeight:44,borderRadius:12,border:"1.5px solid "+(active?"#15803d":"#e2e8f0"),background:active?"#dcfce7":done?"#ffffff":"#ffffff",color:active?"#15803d":done?"#334155":"#94a3b8",cursor:done?"pointer":"default",fontFamily:"inherit",textAlign:"left"}}>
                <span style={{width:24,height:24,borderRadius:"50%",background:active||done?"#15803d":"#e2e8f0",color:active||done?"#ffffff":"#64748b",display:"inline-flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:700,flexShrink:0}}>{done?"✓":n}</span>
                <span style={{fontSize:13,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{lbl}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <div style={{height:3,background:"#f1f5f9"}}><div style={{height:"100%",background:"#15803d",width:`${step*25}%`,transition:"width .3s"}}/></div>
      )}
      <div style={{padding:isDesktop?0:16}}>
        {step===1&&<S1 flow={flow} set={set} errors={errors} clients={clients}/>}
        {step===2&&<S2 bp={bp} flow={flow} set={set} errors={errors} area={area} perim={perim} onAdvance={()=>setStep(3)}/>}
        {step===3&&<S3 bp={bp} flow={flow} set={set} area={area} perim={perim} calc={calc} time={time} settings={settings}/>}
        {step===4&&<S4 bp={bp} flow={flow} set={set} setFlow={setFlow} area={area} perim={perim} calc={calc} time={time} onSend={handleSend} saving={saving}/>}
        {step<4&&<Btn onClick={next} style={{width:"100%",marginTop:8}}>Next →</Btn>}
        {isDesktop&&step>1&&<Btn variant="secondary" onClick={()=>setStep(s=>s-1)} style={{width:"100%",marginTop:8}}>← Back</Btn>}
      </div>
    </div>
  );
}

function S1({flow,set,errors,clients}){
  const [sugg,setSugg]=useState([]);
  const addressRef = useRef(null);
  useEffect(() => {
    let cancelled = false;
    mapsReady.then(google => {
      if (cancelled || !addressRef.current || !google?.maps?.places) return;
      const ac = new google.maps.places.Autocomplete(addressRef.current, {
        types: ["address"],
        componentRestrictions: { country: "us" },
        fields: ["formatted_address","geometry"],
      });
      ac.addListener("place_changed", () => {
        const place = ac.getPlace();
        if (place?.formatted_address) set("address", place.formatted_address);
      });
    }).catch(()=>{});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const onName=v=>{set("clientName",v);set("clientId",null);setSugg(v.length>1?clients.filter(c=>c.name?.toLowerCase().includes(v.toLowerCase())||c.phone?.includes(v)).slice(0,5):[]);};
  const pick=c=>{set("clientId",c.id);set("clientName",c.name);set("clientPhone",c.phone||"");set("clientEmail",c.email||"");set("address",c.default_address||"");if(c.last_area_sqft){set("areaVal",String(c.last_area_sqft));set("areaUnit","sqft");}if(c.last_linear_ft){set("perimVal",String(c.last_linear_ft));set("perimUnit","ft");}setSugg([]);};
  return(
    <div>
      <Card>
        <Lbl>Client Information</Lbl>
        <div style={{marginBottom:12,position:"relative"}}>
          <div style={{fontSize:13,fontWeight:600,color:"#334155",marginBottom:4}}>Client Name *</div>
          <Inp value={flow.clientName} onChange={e=>onName(e.target.value)} onBlur={()=>setTimeout(()=>setSugg([]),150)} placeholder="Name or search existing client"/>
          <ErrMsg msg={errors.clientName}/>
          {sugg.length>0&&(
            <div style={{position:"absolute",top:"100%",left:0,right:0,background:"#fff",border:"1.5px solid #e2e8f0",borderRadius:8,boxShadow:"0 4px 12px rgba(0,0,0,.12)",zIndex:50,marginTop:2}}>
              {sugg.map(c=>(
                <div key={c.id} onMouseDown={()=>pick(c)} style={{padding:"10px 14px",cursor:"pointer",borderBottom:"1px solid #f1f5f9"}}>
                  <div style={{fontWeight:600}}>{c.name}</div>
                  <div style={{fontSize:12,color:"#64748b"}}>{c.phone}{c.default_address?" · "+c.default_address:""}</div>
                </div>
              ))}
            </div>
          )}
        </div>
        {flow.clientId&&<div style={{background:"#f0fdf4",borderRadius:8,padding:"6px 10px",fontSize:12,color:"#166534",marginBottom:10}}>✓ Existing client — measurements pre-filled from last quote</div>}
        <div style={{marginBottom:12}}>
          <div style={{fontSize:13,fontWeight:600,color:"#334155",marginBottom:4}}>Phone *</div>
          <Inp type="tel" value={flow.clientPhone} onChange={e=>set("clientPhone",e.target.value)} placeholder="(555) 000-0000"/>
          <ErrMsg msg={errors.clientPhone}/>
        </div>
        <div>
          <div style={{fontSize:13,fontWeight:600,color:"#334155",marginBottom:4}}>Email (optional)</div>
          <Inp type="email" value={flow.clientEmail} onChange={e=>set("clientEmail",e.target.value)} placeholder="client@email.com"/>
        </div>
      </Card>
      <Card>
        <Lbl>Job Address</Lbl>
        <Inp ref={addressRef} value={flow.address} onChange={e=>set("address",e.target.value)} placeholder="Start typing an address…" autoComplete="off"/>
        <ErrMsg msg={errors.address}/>
      </Card>
    </div>
  );
}

function S2({bp,flow,set,errors,area,perim,onAdvance}){
  const twoCol = bp !== "mobile";
  const {canUseMap,showUpgrade} = usePlan();
  const [mTab,setMTab] = useState(canUseMap?"map":"manual");
  const [mapConfirmed,setMapConfirmed] = useState(false);
  const applyMapMeasurements = ({areaSqft, perimFt}) => {
    set("areaVal", String(areaSqft));
    set("areaUnit", "sqft");
    set("perimVal", String(perimFt));
    set("perimUnit", "ft");
  };
  const areaCard = (
    <Card>
      <Lbl>Lawn Area</Lbl>
      <div style={{display:"flex",gap:8,marginBottom:4}}>
        <Inp type="number" value={flow.areaVal} onChange={e=>set("areaVal",e.target.value)} placeholder="Enter area" style={{flex:1}}/>
        <Sel value={flow.areaUnit} onChange={e=>set("areaUnit",e.target.value)}>{AREA_UNITS.map(u=><option key={u.value} value={u.value}>{u.label}</option>)}</Sel>
      </div>
      {area>0&&flow.areaUnit!=="sqft"&&<div style={{fontSize:12,color:"#16a34a",marginBottom:2}}>= {area.toLocaleString(undefined,{maximumFractionDigits:0})} sq ft</div>}
      {area>0&&<div style={{fontSize:12,color:"#64748b"}}>{(area/43560).toFixed(4)} acres</div>}
      <ErrMsg msg={errors.area}/>
    </Card>
  );
  const perimCard = (
    <Card>
      <Lbl>Perimeter</Lbl>
      <div style={{display:"flex",gap:8,marginBottom:4}}>
        <Inp type="number" value={flow.perimVal} onChange={e=>set("perimVal",e.target.value)} placeholder="Enter perimeter" style={{flex:1}}/>
        <Sel value={flow.perimUnit} onChange={e=>set("perimUnit",e.target.value)}>{PERIM_UNITS.map(u=><option key={u.value} value={u.value}>{u.label}</option>)}</Sel>
      </div>
      {perim>0&&flow.perimUnit!=="ft"&&<div style={{fontSize:12,color:"#16a34a",marginBottom:2}}>= {perim.toLocaleString(undefined,{maximumFractionDigits:0})} linear ft</div>}
      <ErrMsg msg={errors.perim}/>
      <div style={{fontSize:11,color:"#94a3b8",marginTop:6}}>💡 Perimeter drives your trimming price. Rough guide: perimeter ≈ 4 × √area</div>
    </Card>
  );
  const manualBlock = twoCol ? (
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
      <div style={{minWidth:0}}>{areaCard}</div>
      <div style={{minWidth:0}}>{perimCard}</div>
    </div>
  ) : (<>{areaCard}{perimCard}</>);

  return(
    <div>
      {flow.clientId&&flow.areaVal&&<div style={{background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:12,padding:"10px 14px",marginBottom:12,fontSize:13,color:"#166534"}}>📐 Measurements pre-filled from last quote. Adjust if area has changed.</div>}
      <div style={{display:"flex",gap:6,marginBottom:12,background:"#f1f5f9",borderRadius:12,padding:4}}>
        {[["map","🗺 Map",true],["manual","✏️ Manual",true]].map(([k,lbl])=>{
          const active = mTab===k;
          const locked = k==="map" && !canUseMap;
          return (
            <button key={k} onClick={()=>{ if(locked){ setMTab("map"); } else setMTab(k); }} style={{flex:1,height:40,minHeight:40,border:"none",borderRadius:9,background:active?"#ffffff":"transparent",color:active?"#0f172a":"#64748b",fontWeight:active?700:600,fontSize:13,cursor:"pointer",fontFamily:"inherit",boxShadow:active?"0 1px 3px rgba(0,0,0,.08)":"none",display:"inline-flex",alignItems:"center",justifyContent:"center",gap:6}}>
              {locked && <LockIcon size={13} color={active?"#94a3b8":"#94a3b8"}/>}{lbl}
            </button>
          );
        })}
      </div>
      {mTab==="map" && !canUseMap && (
        <Card>
          <div style={{display:"flex",alignItems:"flex-start",gap:12}}>
            <div style={{width:36,height:36,borderRadius:"50%",background:"#f1f5f9",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><LockIcon size={18} color="#64748b"/></div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:14,fontWeight:700,color:"#0f172a",marginBottom:4}}>Satellite map is a Pro feature.</div>
              <div style={{fontSize:13,color:"#64748b",lineHeight:1.5,marginBottom:12}}>Upgrade to draw property boundaries automatically.</div>
              <Btn onClick={()=>showUpgrade("Satellite Map Measurement")} style={{height:40,minHeight:40,padding:"0 16px",fontSize:13,borderRadius:12}}>Upgrade to Pro</Btn>
            </div>
          </div>
        </Card>
      )}
      {mTab==="map" && canUseMap && <MapMeasure bp={bp} address={flow.address} confirmed={mapConfirmed} setConfirmed={setMapConfirmed} onConfirm={applyMapMeasurements} onSwitchManual={()=>setMTab("manual")} onAdvance={onAdvance}/>}
      {mTab==="manual" && manualBlock}
    </div>
  );
}

function MapMeasure({bp,address,confirmed,setConfirmed,onConfirm,onSwitchManual,onAdvance}){
  const isDesktop = bp==="desktop";
  const isTouchDevice = typeof window !== "undefined" && (("ontouchstart" in window) || (navigator.maxTouchPoints||0) > 0);
  const closeThresholdPx = isTouchDevice ? 40 : 25;
  const mapDivRef = useRef(null);
  const searchInputRef = useRef(null);
  const mapRef = useRef(null);
  const geocoderRef = useRef(null);
  const markersRef = useRef([]);
  const firstRingRef = useRef(null);
  const polylineRef = useRef(null);
  const polygonsRef = useRef([]);
  const pointsRef = useRef([]);
  const confirmedRef = useRef(confirmed);
  confirmedRef.current = confirmed;

  const [mapState,setMapState] = useState("loading"); // loading | ready | geocode-fail | api-fail
  const [pointCount,setPointCount] = useState(0);
  const [polyCount,setPolyCount] = useState(0);
  const [totals,setTotals] = useState({area:0,perim:0});
  const [showTutorial,setShowTutorial] = useState(() => {
    try { return localStorage.getItem("lb_map_tutorial_seen") !== "true"; } catch { return true; }
  });
  const [successOverlay,setSuccessOverlay] = useState(false);

  const recalc = () => {
    const g = window.google; if (!g) return;
    let areaM2=0, perimM=0;
    const addFromArr = arr => {
      if (arr.length < 3) return;
      areaM2 += g.maps.geometry.spherical.computeArea(arr);
      for (let i=0;i<arr.length;i++){
        perimM += g.maps.geometry.spherical.computeDistanceBetween(arr[i], arr[(i+1)%arr.length]);
      }
    };
    polygonsRef.current.forEach(p => addFromArr(p.getPath().getArray()));
    addFromArr(pointsRef.current);
    setTotals({ area: Math.round(areaM2*10.7639), perim: Math.round(perimM*3.28084) });
  };

  const addPoint = (latLng) => {
    const g = window.google;
    pointsRef.current.push(latLng);
    const isFirst = pointsRef.current.length === 1;
    // First point gets a halo ring so the user can see where to tap back to close
    if (isFirst) {
      firstRingRef.current = new g.maps.Marker({
        position: latLng, map: mapRef.current, clickable: false, zIndex: 1,
        icon: { path: g.maps.SymbolPath.CIRCLE, scale:14, fillColor:"#15803d", fillOpacity:0.15, strokeColor:"#15803d", strokeWeight:2 },
      });
    }
    const marker = new g.maps.Marker({
      position: latLng, map: mapRef.current, clickable: false, zIndex: 2,
      icon: { path: g.maps.SymbolPath.CIRCLE, scale:isFirst?8:6, fillColor:"#15803d", fillOpacity:1, strokeColor:"#ffffff", strokeWeight:isFirst?3:2 },
    });
    markersRef.current.push(marker);
    if (!polylineRef.current) {
      polylineRef.current = new g.maps.Polyline({
        path: pointsRef.current, map: mapRef.current, clickable: false,
        strokeColor:"#15803d", strokeWeight:2, strokeOpacity:0.9,
      });
    } else {
      polylineRef.current.setPath(pointsRef.current);
    }
    setPointCount(pointsRef.current.length);
    recalc();
  };

  const closePolygon = () => {
    if (pointsRef.current.length < 3) return;
    const g = window.google;
    if (polylineRef.current){ polylineRef.current.setMap(null); polylineRef.current = null; }
    markersRef.current.forEach(m => m.setMap(null));
    markersRef.current = [];
    if (firstRingRef.current){ firstRingRef.current.setMap(null); firstRingRef.current = null; }
    const poly = new g.maps.Polygon({
      paths: pointsRef.current, map: mapRef.current, clickable: false,
      strokeColor:"#15803d", strokeWeight:2, fillColor:"#16a34a", fillOpacity:0.25,
    });
    polygonsRef.current.push(poly);
    pointsRef.current = [];
    setPointCount(0);
    setPolyCount(polygonsRef.current.length);
    recalc();
  };

  const undoPoint = () => {
    if (pointsRef.current.length > 0) {
      pointsRef.current.pop();
      const m = markersRef.current.pop(); if (m) m.setMap(null);
      if (pointsRef.current.length === 0 && firstRingRef.current){ firstRingRef.current.setMap(null); firstRingRef.current = null; }
      if (polylineRef.current) {
        if (pointsRef.current.length === 0){ polylineRef.current.setMap(null); polylineRef.current = null; }
        else polylineRef.current.setPath(pointsRef.current);
      }
      setPointCount(pointsRef.current.length);
    } else if (polygonsRef.current.length > 0) {
      const last = polygonsRef.current.pop();
      last.setMap(null);
      setPolyCount(polygonsRef.current.length);
    }
    recalc();
  };

  const clearAll = (skipConfirm=false) => {
    if (!skipConfirm && polygonsRef.current.length > 0) {
      if (!window.confirm("Clear all measurements?")) return;
    }
    markersRef.current.forEach(m => m.setMap(null)); markersRef.current = [];
    if (firstRingRef.current){ firstRingRef.current.setMap(null); firstRingRef.current = null; }
    if (polylineRef.current){ polylineRef.current.setMap(null); polylineRef.current = null; }
    polygonsRef.current.forEach(p => p.setMap(null)); polygonsRef.current = [];
    pointsRef.current = [];
    setPointCount(0); setPolyCount(0); setTotals({area:0,perim:0});
    setConfirmed(false);
  };

  const confirmNow = () => {
    if (polygonsRef.current.length === 0) return;
    onConfirm({ areaSqft: totals.area, perimFt: totals.perim });
    setConfirmed(true);
    setSuccessOverlay(true);
    setTimeout(() => { setSuccessOverlay(false); onAdvance?.(); }, 1500);
  };

  const handleClick = (e) => {
    if (confirmedRef.current) return;
    const g = window.google;
    if (pointsRef.current.length >= 3) {
      const first = pointsRef.current[0];
      const zoom = mapRef.current.getZoom();
      const mpp = 156543.03392 * Math.cos(first.lat() * Math.PI / 180) / Math.pow(2, zoom);
      const threshold = closeThresholdPx * mpp;
      const dist = g.maps.geometry.spherical.computeDistanceBetween(e.latLng, first);
      if (dist < threshold) { closePolygon(); return; }
    }
    addPoint(e.latLng);
  };

  const dismissTutorial = () => {
    try { localStorage.setItem("lb_map_tutorial_seen", "true"); } catch {}
    setShowTutorial(false);
  };

  useEffect(() => {
    let cancelled = false;
    mapsReady.then(google => {
      if (cancelled || !mapDivRef.current) return;
      const init = (center) => {
        mapRef.current = new google.maps.Map(mapDivRef.current, {
          center, zoom:20, mapTypeId:"satellite",
          tilt:0, heading:0,
          zoomControl:true, mapTypeControl:false, streetViewControl:false, fullscreenControl:false, rotateControl:false,
          gestureHandling:"greedy", clickableIcons:false,
        });
        mapRef.current.setMapTypeId(google.maps.MapTypeId.SATELLITE);
        mapRef.current.setTilt(0);
        mapRef.current.addListener("tilesloaded", () => mapRef.current.setTilt(0));
        mapRef.current.addListener("zoom_changed", () => mapRef.current.setTilt(0));
        mapRef.current.addListener("click", handleClick);
        if (searchInputRef.current) {
          const ac = new google.maps.places.Autocomplete(searchInputRef.current, { fields:["geometry","formatted_address"] });
          ac.addListener("place_changed", () => {
            const place = ac.getPlace();
            if (!place.geometry?.location) return;
            if (polygonsRef.current.length>0 || pointsRef.current.length>0) {
              if (!window.confirm("Clear all measurements and move to new location?")) return;
            }
            clearAll(true);
            mapRef.current.setCenter(place.geometry.location);
            mapRef.current.setZoom(20);
            mapRef.current.setTilt(0);
          });
        }
        setMapState("ready");
      };
      if (!address?.trim()) { setMapState("geocode-fail"); return; }
      geocoderRef.current = new google.maps.Geocoder();
      geocoderRef.current.geocode({ address }, (results, status) => {
        if (cancelled) return;
        if (status !== "OK" || !results?.[0]) { setMapState("geocode-fail"); return; }
        init(results[0].geometry.location);
      });
    }).catch(()=>{ if(!cancelled) setMapState("api-fail"); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  // ── API-fail → auto-switch to manual ──
  useEffect(() => { if (mapState==="api-fail") onSwitchManual?.(); }, [mapState, onSwitchManual]);

  const mapHeight = isDesktop ? "calc(100vh - 240px)" : "max(300px, calc(100dvh - 300px))";
  const totalPointsPlaced = pointCount + polygonsRef.current.reduce((s,p)=>s+p.getPath().getLength(),0);
  const tbBtnHeight = isDesktop ? 40 : 48;

  if (mapState === "api-fail") {
    return <Card><div style={{fontSize:14,color:"#92400e",fontWeight:500}}>Map unavailable — using manual entry</div></Card>;
  }

  const instructionText = polyCount > 0 && pointCount === 0
    ? "✓ Shape closed — tap + Add Area or Use These Measurements"
    : pointCount >= 3
    ? "Tap near your first point to close the shape — or tap Close Shape"
    : pointCount >= 1
    ? "Keep tapping to trace the lawn edge"
    : "Tap anywhere on your lawn to start dropping points";
  const canClose = pointCount >= 3;
  const drawingSomething = pointCount > 0 || polyCount > 0;

  return (
    <Card style={{padding:0,overflow:"hidden"}}>
      <div style={{position:"relative",width:"100%",height:mapHeight,minHeight:300,background:"#e5e7eb"}}>
        {/* Search input overlay */}
        <input ref={searchInputRef} defaultValue={address||""} placeholder="Search for an address…"
          style={{position:"absolute",top:10,left:10,right:10,zIndex:5,height:40,padding:"0 14px",border:"none",borderRadius:10,boxShadow:"0 2px 8px rgba(0,0,0,.15)",fontSize:16,fontFamily:"inherit",background:"#ffffff",color:"#0f172a",outline:"none"}}/>
        <div ref={mapDivRef} style={{position:"absolute",inset:0,width:"100%",height:"100%"}}/>
        {mapState==="loading" && (
          <div style={{position:"absolute",inset:0,background:"#e5e7eb",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:10,color:"#64748b",fontSize:14,fontWeight:500}}>
            <div style={{width:32,height:32,border:"3px solid #cbd5e1",borderTopColor:"#15803d",borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/>
            Loading satellite view…
          </div>
        )}
        {mapState==="geocode-fail" && (
          <div style={{position:"absolute",inset:0,background:"rgba(248,250,252,.95)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:12,padding:20,textAlign:"center"}}>
            <div style={{fontSize:32}}>📍</div>
            <div style={{fontSize:14,color:"#334155",fontWeight:500,maxWidth:320}}>Could not locate this address on the map. Try the Manual tab or check the address in Step 1.</div>
            <Btn onClick={onSwitchManual}>Switch to Manual</Btn>
          </div>
        )}
        {/* Persistent instruction pill */}
        {mapState==="ready" && !confirmed && (
          <div style={{position:"absolute",top:60,left:10,right:10,zIndex:4,display:"flex",justifyContent:"center",pointerEvents:"none"}}>
            <div style={{background:"#ffffff",color:"#15803d",padding:"8px 14px",borderRadius:999,fontSize:13,fontWeight:600,boxShadow:"0 2px 10px rgba(0,0,0,.15)",maxWidth:"100%",textAlign:"center",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{instructionText}</div>
          </div>
        )}
        {/* Tutorial onboarding overlay */}
        {mapState==="ready" && showTutorial && (
          <div style={{position:"absolute",inset:0,background:"rgba(15,23,42,.8)",zIndex:10,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:24,textAlign:"center"}}>
            <div style={{width:64,height:64,borderRadius:"50%",background:"rgba(220,252,231,.15)",border:"2px solid #4ade80",display:"flex",alignItems:"center",justifyContent:"center",marginBottom:16}}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 11.24V7.5a2.5 2.5 0 0 1 5 0v3.74"/><path d="M16 12a5 5 0 0 0-10 0v6a4 4 0 0 0 4 4h2a4 4 0 0 0 4-4v-1"/><path d="M15 12v-1.5a2.5 2.5 0 1 1 5 0V14"/></svg>
            </div>
            <div style={{fontSize:20,fontWeight:800,color:"#ffffff",marginBottom:16,letterSpacing:-.3}}>Measure your lawn in 3 steps</div>
            <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:24,maxWidth:320,width:"100%"}}>
              {[["1.","Tap to drop points around the lawn edge"],["2.","Close the shape by tapping near your first point"],["3.","Tap \"Use These Measurements\" to continue"]].map(([n,t])=>(
                <div key={n} style={{display:"flex",alignItems:"flex-start",gap:12,background:"rgba(255,255,255,.08)",padding:"10px 14px",borderRadius:10,textAlign:"left"}}>
                  <span style={{fontSize:14,fontWeight:800,color:"#4ade80",flexShrink:0,width:18}}>{n}</span>
                  <span style={{fontSize:13,color:"#e2e8f0",fontWeight:500,lineHeight:1.5}}>{t}</span>
                </div>
              ))}
            </div>
            <Btn onClick={dismissTutorial} style={{width:"100%",maxWidth:320}}>Got it — Start Drawing</Btn>
          </div>
        )}
        {/* Success overlay */}
        {successOverlay && (
          <div style={{position:"absolute",inset:0,background:"rgba(15,23,42,.85)",zIndex:12,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:24,textAlign:"center"}}>
            <div style={{width:80,height:80,borderRadius:"50%",background:"#dcfce7",display:"flex",alignItems:"center",justifyContent:"center",marginBottom:16,animation:"lb-fade-in .25s ease-out"}}>
              <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="#15803d" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
            </div>
            <div style={{fontSize:16,fontWeight:700,color:"#ffffff",maxWidth:280,lineHeight:1.4}}>Measurements locked in — continue to build your quote</div>
          </div>
        )}
      </div>

      {/* Prominent measurement readout card */}
      {mapState==="ready" && (
        <div style={{padding:"14px 16px",borderTop:"1px solid #e2e8f0",background:"#ffffff"}}>
          {totalPointsPlaced < 3 ? (
            <div style={{fontSize:13,color:"#94a3b8",fontWeight:500,textAlign:"center",padding:"6px 0"}}>Drop at least 3 points to see measurements</div>
          ) : (
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              <div>
                <div style={{fontSize:14,fontWeight:700,color:"#0f172a",letterSpacing:-.1}}>📐 Area: <span style={{color:"#15803d"}}>{totals.area.toLocaleString()} sqft</span> <span style={{color:"#64748b",fontSize:13,fontWeight:500}}>({(totals.area/43560).toFixed(2)} acres)</span></div>
                <div style={{fontSize:11,color:"#94a3b8",fontWeight:500,marginTop:2,paddingLeft:22}}>This drives your mowing price</div>
              </div>
              <div>
                <div style={{fontSize:14,fontWeight:700,color:"#0f172a",letterSpacing:-.1}}>📏 Perimeter: <span style={{color:"#15803d"}}>{totals.perim.toLocaleString()} ft</span></div>
                <div style={{fontSize:11,color:"#94a3b8",fontWeight:500,marginTop:2,paddingLeft:22}}>This drives your trimming price</div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Toolbar */}
      <div style={{padding:12,display:"flex",gap:8,flexWrap:"wrap"}}>
        <Btn variant="secondary" onClick={undoPoint} disabled={!drawingSomething || confirmed} style={{flex:1,minWidth:0,height:tbBtnHeight,minHeight:tbBtnHeight,padding:"0 10px",fontSize:13}}>↩ Undo</Btn>
        {!confirmed && canClose && <Btn onClick={closePolygon} style={{flex:"1.3",minWidth:0,height:tbBtnHeight,minHeight:tbBtnHeight,padding:"0 10px",fontSize:13}}>Close Shape</Btn>}
        {!confirmed && polyCount>0 && pointCount===0 && <Btn variant="outline" onClick={()=>mapDivRef.current?.scrollIntoView({behavior:"smooth",block:"nearest"})} style={{flex:"1.3",minWidth:0,height:tbBtnHeight,minHeight:tbBtnHeight,padding:"0 10px",fontSize:13}}>+ Add Area</Btn>}
        <Btn variant="secondary" onClick={()=>clearAll(false)} disabled={!drawingSomething} style={{flex:1,minWidth:0,height:tbBtnHeight,minHeight:tbBtnHeight,padding:"0 10px",fontSize:13}}>✕ Clear</Btn>
        {confirmed
          ? <Btn variant="outline" onClick={()=>clearAll(true)} style={{flex:"1.3",minWidth:0,height:tbBtnHeight,minHeight:tbBtnHeight,padding:"0 10px",fontSize:13}}>↻ Redraw</Btn>
          : <Btn onClick={confirmNow} disabled={polyCount===0} style={{flex:"1.6",minWidth:0,height:tbBtnHeight,minHeight:tbBtnHeight,padding:"0 10px",fontSize:13}}>✓ Use These Measurements</Btn>
        }
      </div>

      <div style={{padding:"8px 14px 12px",fontSize:11,color:"#94a3b8",fontWeight:500,lineHeight:1.4}}>Satellite imagery may not reflect recent construction. Verify new structures on site.</div>
    </Card>
  );
}

function S3({bp,flow,set,area,perim,calc,time,settings}){
  const [editing,setEditing]=useState(false);
  const isDesktop = bp==="desktop";
  const leftCol = (<>
      <Card><Lbl>Crew Size</Lbl><div style={{display:"flex",gap:6,flexWrap:"wrap"}}>{[1,2,3,4,5].map(n=><Chip key={n} label={String(n)} active={flow.crew===n} onClick={()=>set("crew",n)}/>)}</div></Card>
      <Card>
        <Lbl>Job Complexity</Lbl>
        <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:8}}>{COMPLEXITY.map(o=><Chip key={o.value} label={`${o.label} (${o.value}×)`} active={flow.cx===o.value} onClick={()=>set("cx",o.value)}/>)}</div>
        <div style={{fontSize:12,color:"#64748b"}}>{COMPLEXITY.find(o=>o.value===flow.cx)?.desc}</div>
      </Card>
      <Card>
        <Lbl>Site Risk</Lbl>
        <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:8}}>{RISK.map(o=><Chip key={o.value} label={`${o.label} (${o.value}×)`} active={flow.risk===o.value} onClick={()=>set("risk",o.value)}/>)}</div>
        <div style={{fontSize:12,color:"#64748b"}}>{RISK.find(o=>o.value===flow.risk)?.desc}</div>
      </Card>
  </>);
  return(
    <div>
      <div style={{background:"#f0fdf4",borderRadius:12,padding:"10px 14px",marginBottom:12,fontSize:13}}>
        <div style={{fontWeight:700}}>📍 {flow.address}</div>
        <div style={{color:"#475569",marginTop:2}}>{fmtArea(area)} · {Math.round(perim).toLocaleString()} ft perimeter</div>
      </div>
      {(() => {
        const timeCard = time && (
        <Card>
          <Lbl>⏱ Time Estimate</Lbl>
          <div style={{display:"flex",alignItems:"flex-end",gap:10,marginBottom:6}}>
            <div style={{fontSize:42,fontWeight:900,color:"#0f172a",lineHeight:1,letterSpacing:-1}}>{fmtT(time.adj)}</div>
            {flow.cx>1&&<div style={{fontSize:12,color:"#b45309",paddingBottom:6,fontWeight:600}}>+{fmtT(time.adj-time.wall)} complexity</div>}
          </div>
          <div style={{fontSize:13,color:"#64748b",marginBottom:16,fontWeight:500}}>{flow.crew>=2?`${flow.crew}-person crew — mow & trim in parallel`:"Solo — mow then trim sequentially"}</div>
          {[{label:"Mowing",hrs:time.mh,note:`${fmtArea(area)} ÷ 20,000`},{label:"Trimming",hrs:time.th,note:`${Math.round(perim).toLocaleString()} ft ÷ 3,000`}].map(ph=>(
            <div key={ph.label} style={{marginBottom:12}}>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:13,marginBottom:4}}><span style={{color:"#334155",fontWeight:500}}>{ph.label}</span><span style={{fontWeight:700,color:"#0f172a"}}>{fmtT(ph.hrs)}</span></div>
              <div style={{background:"#f1f5f9",borderRadius:4,height:6}}><div style={{background:"#15803d",height:"100%",borderRadius:4,width:`${Math.min(100,(ph.hrs/(time.mh+time.th))*100)}%`}}/></div>
              <div style={{fontSize:10,color:"#94a3b8",marginTop:4,fontWeight:500}}>{ph.note}</div>
            </div>
          ))}
          <div style={{marginTop:4,marginBottom:16}}>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:4}}><span style={{color:"#334155",fontWeight:500}}>% of 8-hr workday</span><span style={{fontWeight:700,color:"#0f172a"}}>{Math.round(time.pct)}%</span></div>
            <div style={{background:"#f1f5f9",borderRadius:4,height:8}}><div style={{background:time.pct>80?"#dc2626":time.pct>50?"#b45309":"#15803d",height:"100%",borderRadius:4,width:`${time.pct}%`,transition:"all .3s"}}/></div>
          </div>
          <div style={{fontSize:11,fontWeight:700,color:"#64748b",textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>Crew Impact</div>
          <div style={{display:"flex",gap:6}}>
            {time.crew_times.map(({n,t})=>(
              <div key={n} style={{flex:1,textAlign:"center",padding:"10px 4px",borderRadius:12,background:n===flow.crew?"#15803d":"#f1f5f9",color:n===flow.crew?"#ffffff":"#475569"}}>
                <div style={{fontSize:10,fontWeight:600,letterSpacing:.2}}>{n} crew</div>
                <div style={{fontSize:13,fontWeight:800,marginTop:2}}>{fmtT(t)}</div>
              </div>
            ))}
          </div>
        </Card>
        );
        const discountCard = (
        <Card>
          <Lbl>Discount</Lbl>
          <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
            {[0,5,10,15,20].map(p=><Chip key={p} label={p===0?"None":`${p}%`} active={flow.disc===p&&!flow.customDisc} onClick={()=>{set("disc",p);set("customDisc","");}}/>)}
            <div style={{display:"flex",alignItems:"center",gap:4}}>
              <Inp type="number" min="0" max="100" placeholder="—" value={flow.customDisc} onChange={e=>{set("customDisc",e.target.value);set("disc",parseFloat(e.target.value)||0);}} style={{width:72,height:40,padding:"0 8px",fontSize:16,textAlign:"center",borderRadius:10}}/>
              <span style={{fontSize:13,color:"#64748b"}}>%</span>
            </div>
          </div>
        </Card>
        );
        const calcCard = calc && (
        <Card style={{background:"#0f172a",color:"#ffffff",padding:24,boxShadow:"0 4px 16px rgba(15,23,42,.12)"}}>
          <Lbl style={{color:"#64748b"}}>Calculated Bid</Lbl>
          {flow.disc>0&&<div style={{fontSize:18,color:"#475569",textDecoration:"line-through",marginBottom:4,fontWeight:600}}>{$$(calc.fl)}</div>}
          {editing?(
            <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
              <span style={{fontSize:36,color:"#4ade80",fontWeight:900}}>$</span>
              <input type="number" defaultValue={calc.disp.toFixed(2)} onChange={e=>set("override",e.target.value)} autoFocus style={{fontSize:42,fontWeight:900,background:"transparent",border:"none",borderBottom:"2px solid #4ade80",color:"#ffffff",outline:"none",width:"100%",fontFamily:"inherit"}}/>
            </div>
          ):(
            <div onClick={()=>setEditing(true)} style={{fontSize:"var(--price-hero)",fontWeight:900,color:"#ffffff",letterSpacing:-2,cursor:"pointer",lineHeight:1,marginBottom:4}}>{$$(calc.disp)}</div>
          )}
          {editing?<button onClick={()=>{setEditing(false);set("override",null);}} style={{fontSize:12,color:"#4ade80",background:"none",border:"none",cursor:"pointer",marginBottom:14,fontFamily:"inherit",fontWeight:600,padding:0,minHeight:32}}>← reset to formula</button>:<div style={{fontSize:12,color:"#64748b",marginBottom:14,fontWeight:500}}>Tap price to override</div>}
          {calc.minA&&<div style={{fontSize:12,color:"#fbbf24",marginBottom:12,fontWeight:500}}>⚠ Minimum bid applied (formula: {$$(calc.ar)})</div>}
          <div style={{borderTop:"1px solid #1e293b",paddingTop:14}}>
            <Lbl style={{color:"#64748b"}}>Breakdown</Lbl>
            {calc.bd.map((r,i)=>(
              <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",padding:"6px 0",borderBottom:r.subtotal?"1px solid #334155":"1px solid #1e293b",color:r.subtotal?"#ffffff":r.modifier?"#94a3b8":"#cbd5e1",fontWeight:r.subtotal?700:500}}>
                <div><div style={{fontSize:13}}>{r.label}</div>{r.note&&<div style={{fontSize:10,color:"#64748b",marginTop:1}}>{r.note}</div>}</div>
                <div style={{fontSize:13,fontWeight:600}}>{r.modifier&&r.value>0?"+":""}{$$(r.value)}</div>
              </div>
            ))}
            <div style={{display:"flex",justifyContent:"space-between",marginTop:12,fontSize:16,fontWeight:900,color:"#4ade80",letterSpacing:.3}}><span>FINAL BID</span><span>{$$(calc.disp)}</span></div>
          </div>
        </Card>
        );
        if (isDesktop) {
          return (
            <div style={{display:"grid",gridTemplateColumns:"minmax(0,1fr) minmax(0,1fr)",gap:20,alignItems:"start"}}>
              <div style={{minWidth:0}}>{leftCol}{discountCard}</div>
              <div style={{minWidth:0,position:"sticky",top:80}}>{timeCard}{calcCard}</div>
            </div>
          );
        }
        return (<>{leftCol}{timeCard}{discountCard}{calcCard}</>);
      })()}
    </div>
  );
}

function S4({bp,flow,set,setFlow,area,perim,calc,time,onSend,saving}){
  const {canAttachPhotos} = usePlan();
  const [uploading,setUploading]=useState(false);
  const attachments = flow.attachments || [];

  const addFiles = async (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const remaining = MAX_ATTACHMENTS - attachments.length;
    if (remaining <= 0) { alert(`Maximum ${MAX_ATTACHMENTS} attachments per quote.`); return; }
    const toAdd = files.slice(0, remaining);
    for (const f of toAdd) {
      const ext = (f.name.split(".").pop() || "").toLowerCase();
      if (!ALLOWED_EXT.includes(ext)) { alert(`File type not allowed: ${f.name}`); return; }
      if (f.size > MAX_FILE_BYTES) { alert(`File too large (10MB max): ${f.name}`); return; }
    }
    let qid = flow.existingId;
    if (!qid) {
      try { qid = await nextQuoteId(); }
      catch(e){ alert(dbErrorMessage(e)); return; }
    }
    setUploading(true);
    const uploaded = [];
    try {
      for (const f of toAdd) {
        const { path, url } = await uploadQuoteFile(qid, f);
        uploaded.push({
          id: uid(), name: f.name, type: f.type, size: f.size,
          url, path, created_at: new Date().toISOString(),
        });
      }
      setFlow(fl => ({ ...fl, existingId: qid, attachments: [...(fl.attachments||[]), ...uploaded] }));
    } catch(e) {
      alert(e?.message?.includes("Photo storage") || e?.message?.includes("Not authenticated") ? e.message : dbErrorMessage(e));
    } finally {
      setUploading(false);
    }
  };

  const removeAttach = (att) => {
    setFlow(fl => ({ ...fl, attachments: (fl.attachments||[]).filter(a => a.id !== att.id) }));
    deleteQuoteFile(att.path);
  };

  return(
    <div>
      <Card>
        <Lbl>Client</Lbl>
        <div style={{fontWeight:700,fontSize:16}}>{flow.clientName}</div>
        <div style={{fontSize:14,color:"#64748b",marginTop:2}}>{flow.clientPhone}</div>
        {flow.clientEmail&&<div style={{fontSize:14,color:"#64748b"}}>{flow.clientEmail}</div>}
      </Card>
      <Card>
        <Lbl>Quote Summary</Lbl>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:16}}>
          {[{l:"Address",v:flow.address,full:true},{l:"Area",v:fmtArea(area)},{l:"Perimeter",v:`${Math.round(perim).toLocaleString()} ft`},{l:"Crew",v:`${flow.crew} worker${flow.crew>1?"s":""}`},{l:"Complexity",v:COMPLEXITY.find(o=>o.value===flow.cx)?.label},{l:"Risk",v:RISK.find(o=>o.value===flow.risk)?.label},{l:"Est. Time",v:time?fmtT(time.adj):"—"},{l:"Discount",v:flow.disc>0?`${flow.disc}%`:"None"}]
            .map(({l,v,full})=>(
              <div key={l} style={{gridColumn:full?"1 / -1":"auto"}}>
                <div style={{fontSize:10,fontWeight:700,color:"#94a3b8",textTransform:"uppercase",letterSpacing:1}}>{l}</div>
                <div style={{fontSize:14,fontWeight:600,color:"#0f172a",marginTop:3}}>{v}</div>
              </div>
            ))}
        </div>
        <div style={{borderTop:"1px solid #e2e8f0",paddingTop:14,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <span style={{fontWeight:700,fontSize:15,color:"#0f172a"}}>Total</span>
          <span style={{fontSize:32,fontWeight:900,color:"#0f172a",letterSpacing:-.8}}>{calc?$$(calc.disp):"—"}</span>
        </div>
      </Card>
      <Card>
        <Lbl>Notes (optional)</Lbl>
        <textarea value={flow.notes} onChange={e=>set("notes",e.target.value)} placeholder="Add notes for this job…" style={{width:"100%",minHeight:80,border:"1.5px solid #e2e8f0",borderRadius:12,padding:"12px 14px",fontSize:14,fontFamily:"inherit",resize:"vertical",boxSizing:"border-box",outline:"none",color:"#0f172a"}}/>
      </Card>
      {!canAttachPhotos && (
        <div style={{fontSize:12,color:"#64748b",fontWeight:500,marginBottom:12,display:"flex",alignItems:"center",gap:6,padding:"0 4px"}}>
          <LockIcon size={12} color="#94a3b8"/> Photo attachments available on Pro
        </div>
      )}
      {canAttachPhotos && <Card>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
          <Lbl style={{marginBottom:0}}>Attachments</Lbl>
          <div style={{fontSize:11,color:"#94a3b8",fontWeight:600}}>{attachments.length} / {MAX_ATTACHMENTS}</div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:attachments.length?12:0}}>
          <label style={{height:40,minHeight:40,padding:"0 12px",borderRadius:12,border:"1.5px solid #15803d",background:"#ffffff",color:"#15803d",fontSize:13,fontWeight:600,cursor:uploading||attachments.length>=MAX_ATTACHMENTS?"not-allowed":"pointer",opacity:uploading||attachments.length>=MAX_ATTACHMENTS?.55:1,display:"inline-flex",alignItems:"center",justifyContent:"center",fontFamily:"inherit"}}>
            📷 Add Photo
            <input type="file" accept="image/*" capture="environment" onChange={e=>{addFiles(e.target.files); e.target.value="";}} style={{display:"none"}} disabled={uploading||attachments.length>=MAX_ATTACHMENTS}/>
          </label>
          <label style={{height:40,minHeight:40,padding:"0 12px",borderRadius:12,border:"1.5px solid #e2e8f0",background:"#ffffff",color:"#334155",fontSize:13,fontWeight:600,cursor:uploading||attachments.length>=MAX_ATTACHMENTS?"not-allowed":"pointer",opacity:uploading||attachments.length>=MAX_ATTACHMENTS?.55:1,display:"inline-flex",alignItems:"center",justifyContent:"center",fontFamily:"inherit"}}>
            📎 Upload File
            <input type="file" accept={ATTACH_ACCEPT} multiple onChange={e=>{addFiles(e.target.files); e.target.value="";}} style={{display:"none"}} disabled={uploading||attachments.length>=MAX_ATTACHMENTS}/>
          </label>
        </div>
        {uploading&&<div style={{fontSize:12,color:"#15803d",fontWeight:600,marginBottom:8}}>Uploading…</div>}
        {attachments.length>0&&(
          <div style={{display:"flex",gap:8,overflowX:"auto",paddingBottom:4,marginLeft:-20,marginRight:-20,paddingLeft:20,paddingRight:20}}>
            {attachments.map(att=>{
              const isImg = att.type?.startsWith("image/");
              const isPdf = att.type==="application/pdf" || att.name?.toLowerCase().endsWith(".pdf");
              return (
                <div key={att.id} style={{flexShrink:0,width:88,position:"relative"}}>
                  <div style={{width:88,height:88,borderRadius:12,border:"1.5px solid #e2e8f0",background:"#f8fafc",overflow:"hidden",display:"flex",alignItems:"center",justifyContent:"center",fontSize:32}}>
                    {isImg ? <img src={att.url} alt={att.name} style={{width:"100%",height:"100%",objectFit:"cover"}}/> : isPdf ? "📄" : "📎"}
                  </div>
                  <button onClick={()=>removeAttach(att)} style={{position:"absolute",top:-6,right:-6,width:22,height:22,borderRadius:"50%",background:"#0f172a",color:"#ffffff",border:"2px solid #ffffff",fontSize:12,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"inherit",padding:0,lineHeight:1}}>×</button>
                  <div style={{fontSize:10,color:"#64748b",marginTop:4,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontWeight:500}}>{att.name}</div>
                </div>
              );
            })}
          </div>
        )}
      </Card>}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",background:"#ffffff",borderRadius:16,padding:"14px 18px",marginBottom:12,boxShadow:CARD_SHADOW}}>
        <div><div style={{fontWeight:600,fontSize:14,color:"#0f172a"}}>Save to client list</div><div style={{fontSize:12,color:"#64748b",marginTop:2}}>Remembers address & measurements</div></div>
        <div onClick={()=>set("saveClient",!flow.saveClient)} style={{width:44,height:26,borderRadius:13,background:flow.saveClient?"#15803d":"#cbd5e1",cursor:"pointer",position:"relative",transition:"background .2s",flexShrink:0}}>
          <div style={{width:22,height:22,background:"#ffffff",borderRadius:"50%",position:"absolute",top:2,left:flow.saveClient?20:2,transition:"left .2s",boxShadow:"0 1px 3px rgba(0,0,0,.2)"}}/>
        </div>
      </div>
      <Btn onClick={()=>onSend("sent")} disabled={saving} style={{width:"100%",marginBottom:10,fontSize:16}}>{saving?"Saving to database…":"📤 Send Quote"}</Btn>
      <Btn variant="outline" onClick={()=>onSend("draft")} disabled={saving} style={{width:"100%"}}>💾 Save as Draft</Btn>
    </div>
  );
}
