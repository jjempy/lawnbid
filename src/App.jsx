import { useState, useEffect, useCallback } from "react";
import supabase, {
  loadQuotes, upsertQuote, deleteQuote, updateQuoteStatus,
  loadClients, upsertClient,
  loadSettings, saveSettings as dbSaveSettings,
  nextQuoteId,
} from "./supabase.js";

// ─── Constants ──────────────────────────────────────────────────────────────────
const APP_VERSION = "1.0.0";
const DEFAULT_SETTINGS = {
  mow_rate: 110, trim_rate: 18, equipment_cost: 12.35, hourly_rate: 22.80,
  minimum_bid: 55, complexity_default: 1.0, risk_default: 1.0,
  company_name: "", company_phone: "", company_email: "",
};
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
const STATUS_COLOR = { draft:"#f59e0b", sent:"#3b82f6", accepted:"#16a34a" };
const STATUS_BG    = { draft:"#fffbeb", sent:"#eff6ff", accepted:"#f0fdf4" };

const uid = () => Math.random().toString(36).slice(2,8).toUpperCase();

// ─── Formula ────────────────────────────────────────────────────────────────────
const $$ = v => `$${(+(v||0)).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const fmtT = h => { if(!h||h<=0) return "—"; const hr=Math.floor(h),m=Math.round((h-hr)*60); return hr===0?`${m}m`:m===0?`${hr}h`:`${hr}h ${m}m`; };
const fmtD = iso => new Date(iso).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"});
const fmtTS= iso => new Date(iso).toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit"});

function calcQ(area, perim, cx, risk, disc, s, ov=null) {
  if(!area||!perim||area<=0||perim<=0) return null;
  const mh=area/20000, th=perim/3000;
  const mc=area*(s.mow_rate/20000), tc=perim*(s.trim_rate/3000), ec=s.equipment_cost*(mh+th);
  const sub=mc+tc+ec, acx=sub*cx, ar=acx*risk;
  const minA=ar<s.minimum_bid, fl=Math.max(ar,s.minimum_bid), fin=fl*(1-disc/100);
  const disp=ov!==null?(parseFloat(ov)||0):fin;
  const bd=[
    {label:"Mow (area)",       note:`${Math.round(area).toLocaleString()} sqft × ($${s.mow_rate}÷20,000)`, value:mc},
    {label:"Trim (perimeter)", note:`${Math.round(perim).toLocaleString()} ft × ($${s.trim_rate}÷3,000)`,  value:tc},
    {label:"Equipment",        note:`${(mh+th).toFixed(2)} hrs × $${s.equipment_cost}/hr`,                 value:ec},
    {subtotal:true, label:"Subtotal", value:sub},
    {modifier:true, label:`Complexity (${cx}×)`,  value:acx-sub},
    {modifier:true, label:`Risk (${risk}×)`,       value:ar-acx},
    ...(disc>0?[{modifier:true,label:`Discount (${disc}%)`,value:-(fl*disc/100)}]:[]),
  ];
  return {mh,th,mc,tc,ec,sub,acx,ar,minA,fl,fin,disp,bd};
}

function calcTime(area, perim, crew, cx) {
  if(!area||!perim||area<=0||perim<=0) return null;
  const mh=area/20000, th=perim/3000;
  const wall=crew>=2?Math.max(mh,th):mh+th, adj=wall*cx, pct=Math.min(100,(adj/8)*100);
  return { mh, th, wall, adj, pct,
    crew_times:[1,2,3,4].map(n=>({n, t:(n>=2?Math.max(mh,th):mh+th)*cx})) };
}

function quoteText(q, s) {
  return [
    "LAWN CARE QUOTE",
    s.company_name?`${s.company_name}${s.company_phone?" | "+s.company_phone:""}`:"",
    "",`Quote ID: ${q.quote_id}`,`Date: ${fmtTS(q.created_at)}`,
    q.parent_id?`Revision of: ${q.parent_id}`:"",
    "",`Client: ${q.client_name||"—"}`,`Property: ${q.address}`,
    "","Service: Lawn Mowing, Trimming & Edging",
    `Area: ${Math.round(q.area_sqft).toLocaleString()} sqft (${(q.area_sqft/43560).toFixed(3)} acres)`,
    `Perimeter: ${Math.round(q.linear_ft).toLocaleString()} linear ft`,
    "",`TOTAL: ${$$(q.final_price)}`,
    "",s.company_phone?`To accept, call ${s.company_phone}.`:"To accept, please reply.",
  ].filter(Boolean).join("\n");
}

// ─── Shared UI ──────────────────────────────────────────────────────────────────
const Card  = ({children,style={},onClick,...p}) => <div onClick={onClick} style={{background:"#fff",borderRadius:12,padding:16,marginBottom:12,boxShadow:"0 1px 4px rgba(0,0,0,.08)",...style}} {...p}>{children}</div>;
const Lbl   = ({children,style={}}) => <div style={{fontSize:11,fontWeight:700,color:"#888",letterSpacing:1,textTransform:"uppercase",marginBottom:8,...style}}>{children}</div>;
const Inp   = ({style={},...p}) => <input style={{width:"100%",padding:"10px 12px",border:"1.5px solid #e0e0e0",borderRadius:8,fontSize:16,outline:"none",boxSizing:"border-box",fontFamily:"inherit",...style}} {...p}/>;
const Sel   = ({style={},...p}) => <select style={{padding:"10px 8px",border:"1.5px solid #e0e0e0",borderRadius:8,fontSize:14,background:"#fff",outline:"none",fontFamily:"inherit",...style}} {...p}/>;
const Btn   = ({children,variant="primary",style={},...p}) => {
  const vs={primary:{background:"#16a34a",color:"#fff"},secondary:{background:"#f3f4f6",color:"#374151"},outline:{background:"#fff",color:"#16a34a",border:"2px solid #16a34a"},danger:{background:"#fee2e2",color:"#dc2626",border:"none"},warning:{background:"#fffbeb",color:"#92400e",border:"2px solid #fcd34d"}};
  return <button style={{padding:"12px 18px",borderRadius:10,border:"none",fontSize:15,fontWeight:700,cursor:p.disabled?"not-allowed":"pointer",opacity:p.disabled?.6:1,fontFamily:"inherit",...vs[variant],...style}} {...p}>{children}</button>;
};
const Chip  = ({label,active,onClick,style={}}) => <button onClick={onClick} style={{padding:"8px 12px",borderRadius:20,border:"2px solid",borderColor:active?"#16a34a":"#e0e0e0",background:active?"#16a34a":"#fff",color:active?"#fff":"#555",fontSize:13,fontWeight:600,cursor:"pointer",whiteSpace:"nowrap",fontFamily:"inherit",flexShrink:0,...style}}>{label}</button>;
const Badge = ({status}) => <span style={{padding:"3px 9px",borderRadius:12,fontSize:11,fontWeight:700,background:STATUS_BG[status]||"#f5f5f5",color:STATUS_COLOR[status]||"#888",textTransform:"uppercase",letterSpacing:.5,border:`1px solid ${STATUS_COLOR[status]||"#ddd"}`}}>{status}</span>;
const ErrMsg= ({msg}) => msg?<div style={{color:"#dc2626",fontSize:12,marginTop:4,fontWeight:500}}>⚠ {msg}</div>:null;
const QID   = ({id}) => <span style={{fontFamily:"monospace",fontSize:11,background:"#f3f4f6",color:"#555",padding:"2px 7px",borderRadius:6,letterSpacing:.5}}>{id}</span>;
const Back  = ({onClick}) => <button onClick={onClick} style={{background:"none",border:"none",fontSize:24,cursor:"pointer",color:"#16a34a",fontFamily:"inherit",lineHeight:1,padding:0}}>‹</button>;

// ─── App ─────────────────────────────────────────────────────────────────────────
export default function LawnBid() {
  const [authReady,setAuthReady]= useState(false);
  const [session,  setSession]  = useState(null);
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

  // ── Auth: check existing session and listen for changes ──
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session || null);
      setAuthReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s || null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // ── Load all data from Supabase once authenticated ──
  useEffect(() => {
    if (!session) { setReady(false); setQuotes([]); setClients([]); setSettings(DEFAULT_SETTINGS); return; }
    (async () => {
      try {
        const [q, c, s] = await Promise.all([loadQuotes(), loadClients(), loadSettings()]);
        setQuotes(q);
        setClients(c);
        if (s) setSettings(prev => ({ ...prev, ...s }));
        setReady(true);
      } catch (e) {
        setDbErr(e.message || "Could not connect to database.");
        setReady(true);
      }
    })();
  }, [session]);

  const goHome = useCallback(() => { setScreen("home"); setFlow(null); setErrors({}); }, []);

  const startNew = useCallback(() => {
    setFlow({
      isNew:true, parentId:null, existingId:null,
      clientId:null, clientName:"", clientPhone:"", clientEmail:"",
      address:"", areaVal:"", areaUnit:"sqft", perimVal:"", perimUnit:"ft",
      crew:1, cx:settings.complexity_default, risk:settings.risk_default,
      disc:0, customDisc:"", override:null, notes:"", saveClient:true,
    });
    setStep(1); setErrors({}); setScreen("flow");
  }, [settings]);

  const editQuote = useCallback((q, forceNew=false) => {
    setFlow({
      isNew:forceNew, parentId:forceNew?q.quote_id:(q.parent_id||null), existingId:forceNew?null:q.quote_id,
      clientId:q.client_id, clientName:q.client_name||"", clientPhone:q.client_phone||"", clientEmail:q.client_email||"",
      address:q.address, areaVal:String(q.area_sqft), areaUnit:"sqft", perimVal:String(q.linear_ft), perimUnit:"ft",
      crew:q.crew_size, cx:q.complexity, risk:q.risk, disc:q.discount_pct||0, customDisc:"",
      override:null, notes:q.notes||"", saveClient:true, sentAt:q.sent_at,
    });
    setStep(2); setErrors({}); setScreen("flow");
  }, []);

  const handleSave = useCallback(async (rec, cliData, status) => {
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
        sent_at:     status === "sent" ? now : (rec.sentAt || null),
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

      setSelQ(quoteId);
      setScreen("quote-detail");
      setFlow(null);
    } catch (e) {
      alert("Save failed: " + (e.message || "Unknown error. Check your connection."));
    } finally {
      setSaving(false);
    }
  }, []);

  const handleSaveSettings = useCallback(async ns => {
    setSettings(ns);
    try { await dbSaveSettings(ns); } catch(e) { console.error("Settings save failed:", e); }
  }, []);

  const handleDeleteQuote = useCallback(async (quoteId) => {
    try {
      await deleteQuote(quoteId);
      setQuotes(prev => prev.filter(q => q.quote_id !== quoteId));
      goHome();
    } catch(e) { alert("Delete failed: " + e.message); }
  }, [goHome]);

  const handleAccepted = useCallback(async (quoteId) => {
    const now = new Date().toISOString();
    try {
      await updateQuoteStatus(quoteId, "accepted", { accepted_at: now });
      setQuotes(prev => prev.map(q => q.quote_id === quoteId ? { ...q, status: "accepted", accepted_at: now } : q));
    } catch(e) { alert("Update failed: " + e.message); }
  }, []);

  if (!authReady) return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100vh",fontFamily:"system-ui",gap:12}}>
      <div style={{fontSize:48}}>🌿</div>
      <div style={{fontSize:20,fontWeight:900,color:"#16a34a"}}>LawnBid</div>
    </div>
  );

  if (!session) return <AuthScreen/>;

  if (!ready) return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100vh",fontFamily:"system-ui",gap:12}}>
      <div style={{fontSize:48}}>🌿</div>
      <div style={{fontSize:20,fontWeight:900,color:"#16a34a"}}>LawnBid</div>
      <div style={{fontSize:13,color:"#888"}}>Connecting to database…</div>
    </div>
  );

  const activeQ = quotes.find(q => q.quote_id === selQ);
  const activeC = clients.find(c => c.id === selC);

  return (
    <div style={{maxWidth:480,margin:"0 auto",minHeight:"100vh",display:"flex",flexDirection:"column",fontFamily:"system-ui,-apple-system,sans-serif",background:"#f4f4f5"}}>
      {/* DB error banner */}
      {dbErr && (
        <div style={{background:"#fef2f2",borderBottom:"2px solid #fca5a5",padding:"10px 16px",fontSize:13,color:"#dc2626",fontWeight:600,textAlign:"center"}}>
          ⚠ Database error: {dbErr} — Check your .env.local credentials.
        </div>
      )}
      {saving && (
        <div style={{position:"fixed",top:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:480,background:"#f0fdf4",borderBottom:"2px solid #bbf7d0",padding:"8px 16px",fontSize:13,color:"#166534",fontWeight:600,zIndex:999,textAlign:"center",boxSizing:"border-box"}}>
          💾 Saving…
        </div>
      )}

      <div style={{flex:1,overflowY:"auto",paddingBottom:screen==="flow"?0:64}}>
        {screen==="flow" ? (
          <QuoteFlow step={step} setStep={setStep} flow={flow} setFlow={setFlow}
            errors={errors} setErrors={setErrors} settings={settings}
            clients={clients} quotes={quotes} onSave={handleSave} onCancel={goHome} saving={saving}/>
        ):screen==="quote-detail"&&activeQ ? (
          <QuoteDetail quote={activeQ} allQuotes={quotes} settings={settings}
            onBack={()=>setScreen(selC&&tab==="clients"?"client-detail":"home")}
            onEdit={()=>editQuote(activeQ, activeQ.status==="sent"||activeQ.status==="accepted")}
            onDuplicate={()=>editQuote(activeQ,true)}
            onDelete={()=>handleDeleteQuote(activeQ.quote_id)}
            onAccepted={()=>handleAccepted(activeQ.quote_id)}/>
        ):screen==="client-detail"&&activeC ? (
          <ClientDetail client={activeC} quotes={quotes.filter(q=>q.client_id===activeC.id)}
            onBack={()=>{setTab("clients");setScreen("home");}}
            onViewQuote={qid=>{setSelQ(qid);setScreen("quote-detail");}}/>
        ):tab==="quotes" ? (
          <HomeScreen quotes={quotes} onNew={startNew} onView={qid=>{setSelQ(qid);setScreen("quote-detail");}}/>
        ):tab==="clients" ? (
          <ClientsScreen clients={clients} quotes={quotes} onView={cid=>{setSelC(cid);setScreen("client-detail");}}/>
        ):(
          <SettingsScreen settings={settings} onSave={handleSaveSettings} onLogout={()=>supabase.auth.signOut()}/>
        )}
      </div>

      {screen!=="flow" && (
        <div style={{position:"fixed",bottom:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:480,background:"#fff",borderTop:"1px solid #e5e7eb",display:"flex",zIndex:100}}>
          {[["quotes","📋","Quotes"],["clients","👥","Clients"],["settings","⚙️","Settings"]].map(([t,icon,lbl])=>(
            <button key={t} onClick={()=>{setTab(t);setScreen("home");}} style={{flex:1,padding:"10px 0 8px",border:"none",background:"none",cursor:"pointer",fontSize:10,fontWeight:700,color:tab===t&&screen==="home"?"#16a34a":"#9ca3af",textTransform:"uppercase",letterSpacing:.5,fontFamily:"inherit"}}>
              <div style={{fontSize:20,marginBottom:2}}>{icon}</div>{lbl}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Home ──────────────────────────────────────────────────────────────────────
function HomeScreen({quotes,onNew,onView}){
  const [filter,setFilter]=useState("all");
  const shown=(filter==="all"?quotes:quotes.filter(q=>q.status===filter)).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
  return(
    <div style={{padding:16}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <img src="/logo.png" alt="LawnBid" style={{width:40,height:40,borderRadius:"50%",objectFit:"cover"}}/>
          <div>
            <div style={{fontSize:26,fontWeight:900,color:"#111"}}>LawnBid</div>
            <div style={{fontSize:12,color:"#888"}}>{quotes.length} quote{quotes.length!==1?"s":""} in database</div>
          </div>
        </div>
        <Btn onClick={onNew} style={{padding:"10px 16px",fontSize:14}}>+ New Quote</Btn>
      </div>
      <div style={{display:"flex",gap:6,margin:"14px 0",overflowX:"auto",paddingBottom:4}}>
        {["all","draft","sent","accepted"].map(f=>(
          <Chip key={f} label={f==="all"?`All (${quotes.length})`:`${f[0].toUpperCase()+f.slice(1)} (${quotes.filter(q=>q.status===f).length})`} active={filter===f} onClick={()=>setFilter(f)}/>
        ))}
      </div>
      {shown.length===0?(
        <div style={{textAlign:"center",padding:"60px 20px",color:"#888"}}>
          <div style={{fontSize:48,marginBottom:12}}>📋</div>
          <div style={{fontWeight:700,fontSize:16}}>{quotes.length===0?"No quotes yet":"No quotes match this filter"}</div>
          {quotes.length===0&&<div style={{fontSize:13,marginTop:6}}>Tap + New Quote to get started</div>}
        </div>
      ):shown.map(q=>(
        <Card key={q.quote_id} style={{cursor:"pointer"}} onClick={()=>onView(q.quote_id)}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:12}}>
            <div style={{flex:1,minWidth:0}}>
              <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:2}}>
                <div style={{fontWeight:700,fontSize:15,color:"#111",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{q.client_name||"No client"}</div>
                {q.parent_id&&<span style={{fontSize:10,background:"#e0f2fe",color:"#0369a1",padding:"1px 5px",borderRadius:4,fontWeight:700,flexShrink:0}}>V2</span>}
              </div>
              <div style={{fontSize:12,color:"#666",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{q.address}</div>
              <div style={{display:"flex",alignItems:"center",gap:6,marginTop:5}}>
                <QID id={q.quote_id}/><span style={{fontSize:11,color:"#999"}}>{fmtD(q.created_at)}</span>
              </div>
            </div>
            <div style={{textAlign:"right",flexShrink:0}}>
              <div style={{fontSize:22,fontWeight:900,color:"#16a34a"}}>{$$(q.final_price)}</div>
              <div style={{marginTop:4}}><Badge status={q.status}/></div>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

// ─── Clients ──────────────────────────────────────────────────────────────────
function ClientsScreen({clients,quotes,onView}){
  const [search,setSearch]=useState("");
  const shown=clients.filter(c=>c.name?.toLowerCase().includes(search.toLowerCase())||c.phone?.includes(search)).sort((a,b)=>a.name?.localeCompare(b.name));
  return(
    <div style={{padding:16}}>
      <div style={{fontSize:26,fontWeight:900,color:"#111",marginBottom:14}}>Clients</div>
      <Inp placeholder="Search name or phone…" value={search} onChange={e=>setSearch(e.target.value)} style={{marginBottom:14}}/>
      {shown.length===0?(
        <div style={{textAlign:"center",padding:"60px 20px",color:"#888"}}>
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
                <div style={{fontSize:13,color:"#666"}}>{c.phone}</div>
                {c.default_address&&<div style={{fontSize:12,color:"#999",marginTop:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.default_address}</div>}
                <div style={{fontSize:11,color:"#aaa",marginTop:4}}>{cqs.length} quote{cqs.length!==1?"s":""}</div>
              </div>
              <div style={{textAlign:"right",flexShrink:0}}>
                {last&&<div style={{fontSize:18,fontWeight:900,color:"#16a34a"}}>{$$(last.final_price)}</div>}
                {last&&<div style={{fontSize:11,color:"#999",marginTop:2}}>{fmtD(last.created_at)}</div>}
                {cqs.length>1&&<div style={{fontSize:11,color:"#888",marginTop:2}}>Total: {$$(total)}</div>}
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

// ─── Client Detail ────────────────────────────────────────────────────────────
function ClientDetail({client,quotes,onBack,onViewQuote}){
  const sorted=[...quotes].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
  const total=quotes.reduce((s,q)=>s+(q.final_price||0),0);
  return(
    <div>
      <div style={{background:"#fff",padding:"12px 16px",borderBottom:"1px solid #e5e7eb",display:"flex",alignItems:"center",gap:12,position:"sticky",top:0,zIndex:10}}>
        <Back onClick={onBack}/><div style={{fontWeight:700,fontSize:16}}>{client.name}</div>
      </div>
      <div style={{padding:16}}>
        <Card>
          <Lbl>Contact</Lbl>
          <div style={{fontWeight:700,fontSize:18,marginBottom:4}}>{client.name}</div>
          {client.phone&&<a href={`tel:${client.phone}`} style={{display:"block",fontSize:15,color:"#16a34a",textDecoration:"none",marginBottom:4}}>📞 {client.phone}</a>}
          {client.email&&<div style={{fontSize:14,color:"#666",marginBottom:4}}>✉ {client.email}</div>}
          {client.default_address&&<div style={{fontSize:13,color:"#888"}}>📍 {client.default_address}</div>}
        </Card>
        {client.last_area_sqft&&(
          <Card style={{background:"#f0fdf4",border:"1px solid #bbf7d0"}}>
            <Lbl>Last Job Measurements</Lbl>
            <div style={{display:"flex",gap:24}}>
              <div><div style={{fontSize:10,color:"#166534",textTransform:"uppercase",fontWeight:700}}>Area</div><div style={{fontSize:20,fontWeight:800,color:"#16a34a"}}>{Math.round(client.last_area_sqft).toLocaleString()} sqft</div><div style={{fontSize:11,color:"#4ade80"}}>{(client.last_area_sqft/43560).toFixed(3)} acres</div></div>
              <div><div style={{fontSize:10,color:"#166534",textTransform:"uppercase",fontWeight:700}}>Perimeter</div><div style={{fontSize:20,fontWeight:800,color:"#16a34a"}}>{Math.round(client.last_linear_ft||0).toLocaleString()} ft</div></div>
            </div>
          </Card>
        )}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
          <div style={{fontWeight:700,fontSize:16}}>Quote History</div>
          <div style={{fontSize:13,color:"#888"}}>{quotes.length} quote{quotes.length!==1?"s":""} · {$$(total)} total</div>
        </div>
        {sorted.length===0?(
          <div style={{textAlign:"center",padding:40,color:"#888",fontSize:14}}>No quotes for this client yet</div>
        ):sorted.map(q=>(
          <Card key={q.quote_id} style={{cursor:"pointer"}} onClick={()=>onViewQuote(q.quote_id)}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:12}}>
              <div style={{flex:1,minWidth:0}}>
                <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4,flexWrap:"wrap"}}>
                  <QID id={q.quote_id}/>
                  {q.parent_id&&<span style={{fontSize:10,background:"#e0f2fe",color:"#0369a1",padding:"1px 5px",borderRadius:4,fontWeight:700}}>V2</span>}
                  <Badge status={q.status}/>
                </div>
                <div style={{fontSize:12,color:"#666"}}>{fmtTS(q.created_at)}</div>
                <div style={{fontSize:12,color:"#999",marginTop:2}}>
                  {Math.round(q.area_sqft).toLocaleString()} sqft · {q.crew_size} crew · {COMPLEXITY.find(o=>o.value===q.complexity)?.label} · {RISK.find(o=>o.value===q.risk)?.label}
                </div>
                {q.parent_id&&<div style={{fontSize:11,color:"#94a3b8",marginTop:2}}>Revision of {q.parent_id}</div>}
              </div>
              <div style={{textAlign:"right",flexShrink:0}}><div style={{fontSize:20,fontWeight:900,color:"#16a34a"}}>{$$(q.final_price)}</div></div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ─── Quote Detail ─────────────────────────────────────────────────────────────
function QuoteDetail({quote,allQuotes,settings,onBack,onEdit,onDuplicate,onDelete,onAccepted}){
  const [confirmDel,setConfirmDel]=useState(false);
  const [copied,setCopied]=useState(false);
  const snap={...settings,mow_rate:quote.mow_rate_used||settings.mow_rate,trim_rate:quote.trim_rate_used||settings.trim_rate,equipment_cost:quote.equipment_cost_used||settings.equipment_cost};
  const calc=calcQ(quote.area_sqft,quote.linear_ft,quote.complexity,quote.risk,quote.discount_pct||0,snap);
  const time=calcTime(quote.area_sqft,quote.linear_ft,quote.crew_size,quote.complexity);
  const ratesChanged=quote.mow_rate_used&&(quote.mow_rate_used!==settings.mow_rate||quote.trim_rate_used!==settings.trim_rate);
  const versions=allQuotes.filter(q=>q.parent_id===quote.quote_id||q.quote_id===quote.parent_id);
  const isSent=quote.status==="sent"||quote.status==="accepted";

  const share=()=>{
    const txt=quoteText(quote,settings);
    if(navigator.share){navigator.share({text:txt}).catch(()=>{});}
    else{navigator.clipboard?.writeText(txt);setCopied(true);setTimeout(()=>setCopied(false),2000);}
  };

  return(
    <div>
      <div style={{background:"#fff",padding:"12px 16px",borderBottom:"1px solid #e5e7eb",display:"flex",alignItems:"center",gap:12,position:"sticky",top:0,zIndex:10}}>
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
        {ratesChanged&&<div style={{background:"#fffbeb",border:"1px solid #fde68a",borderRadius:10,padding:"10px 14px",marginBottom:12,fontSize:12,color:"#92400e"}}>ℹ Rates changed since sent. Showing rates used at time of quoting.</div>}
        {isSent&&<div style={{background:"#eff6ff",border:"1px solid #bfdbfe",borderRadius:10,padding:"10px 14px",marginBottom:12,fontSize:13,color:"#1d4ed8"}}>✏️ <strong>Editing a sent quote creates a new V2</strong> — original preserved.</div>}
        {versions.length>0&&(
          <Card style={{background:"#f8fafc",border:"1px solid #e2e8f0"}}>
            <Lbl>Quote Thread</Lbl>
            {versions.sort((a,b)=>new Date(a.created_at)-new Date(b.created_at)).map(v=>(
              <div key={v.quote_id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0",borderBottom:"1px solid #e2e8f0"}}>
                <div style={{display:"flex",alignItems:"center",gap:6}}><QID id={v.quote_id}/><Badge status={v.status}/></div>
                <div style={{fontSize:13,fontWeight:700,color:"#16a34a"}}>{$$(v.final_price)}</div>
              </div>
            ))}
          </Card>
        )}
        <Card style={{background:"#111",textAlign:"center",padding:24}}>
          <div style={{fontSize:56,fontWeight:900,color:"#4ade80",letterSpacing:-2,lineHeight:1}}>{$$(quote.final_price)}</div>
          <div style={{fontSize:13,color:"#6b7280",marginTop:6}}>Mowing · Trimming · Edging</div>
          {time&&<div style={{fontSize:14,color:"#4ade80",marginTop:4,fontWeight:700}}>Est. {fmtT(time.adj)}</div>}
          <div style={{marginTop:8,fontSize:11,color:"#555"}}>Sent: {quote.sent_at?fmtTS(quote.sent_at):"Not yet sent"}</div>
        </Card>
        {quote.client_name&&(
          <Card>
            <Lbl>Client</Lbl>
            <div style={{fontWeight:700,fontSize:16,marginBottom:4}}>{quote.client_name}</div>
            {quote.client_phone&&<a href={`tel:${quote.client_phone}`} style={{display:"block",fontSize:14,color:"#16a34a",textDecoration:"none",marginBottom:2}}>📞 {quote.client_phone}</a>}
            {quote.client_email&&<div style={{fontSize:14,color:"#666"}}>✉ {quote.client_email}</div>}
          </Card>
        )}
        <Card>
          <Lbl>Job Details</Lbl>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
            {[{l:"Address",v:quote.address,full:true},{l:"Area",v:`${Math.round(quote.area_sqft).toLocaleString()} sqft (${(quote.area_sqft/43560).toFixed(3)} ac)`},{l:"Perimeter",v:`${Math.round(quote.linear_ft).toLocaleString()} ft`},{l:"Crew",v:`${quote.crew_size} worker${quote.crew_size>1?"s":""}`},{l:"Complexity",v:COMPLEXITY.find(o=>o.value===quote.complexity)?.label},{l:"Risk",v:RISK.find(o=>o.value===quote.risk)?.label},{l:"Discount",v:(quote.discount_pct||0)>0?`${quote.discount_pct}%`:"None"},{l:"Created",v:fmtTS(quote.created_at),full:true},{l:"Sent",v:quote.sent_at?fmtTS(quote.sent_at):"Not sent",full:true}]
              .map(({l,v,full})=>(
                <div key={l} style={{gridColumn:full?"1 / -1":"auto"}}>
                  <div style={{fontSize:10,fontWeight:700,color:"#9ca3af",textTransform:"uppercase"}}>{l}</div>
                  <div style={{fontSize:13,fontWeight:600,color:"#111",marginTop:2}}>{v}</div>
                </div>
              ))}
          </div>
        </Card>
        {calc&&(
          <Card>
            <Lbl>Formula Breakdown</Lbl>
            {calc.bd.map((r,i)=>(
              <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",padding:"5px 0",borderBottom:r.subtotal?"1.5px solid #e0e0e0":"1px solid #f5f5f5",fontWeight:r.subtotal?700:400,color:r.subtotal?"#111":r.modifier?"#888":"#444"}}>
                <div><div style={{fontSize:13}}>{r.label}</div>{r.note&&<div style={{fontSize:10,color:"#bbb"}}>{r.note}</div>}</div>
                <div style={{fontSize:13,fontWeight:600}}>{r.modifier&&r.value>0?"+":""}{$$(r.value)}</div>
              </div>
            ))}
            <div style={{display:"flex",justifyContent:"space-between",marginTop:10,fontSize:18,fontWeight:900,color:"#16a34a"}}><span>FINAL BID</span><span>{$$(quote.final_price)}</span></div>
            {quote.mow_rate_used&&<div style={{marginTop:10,padding:"8px 10px",background:"#f8fafc",borderRadius:8,fontSize:11,color:"#888"}}>Rates at quoting time: mow ${quote.mow_rate_used}/20k · trim ${quote.trim_rate_used}/3k · equip ${quote.equipment_cost_used}/hr</div>}
          </Card>
        )}
        {quote.notes&&<Card><Lbl>Notes</Lbl><div style={{fontSize:14,color:"#444",lineHeight:1.5}}>{quote.notes}</div></Card>}
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          <Btn onClick={share} style={{width:"100%"}}>{copied?"✓ Copied!":"📤 Resend Quote"}</Btn>
          {quote.status==="sent"&&<Btn variant="outline" onClick={onAccepted} style={{width:"100%"}}>✅ Mark as Accepted</Btn>}
          <Btn variant="warning" onClick={onEdit} style={{width:"100%"}}>✏️ {isSent?"Edit (creates V2 quote)":"Edit Quote"}</Btn>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
            <Btn variant="secondary" onClick={onDuplicate}>📋 Duplicate</Btn>
            {!confirmDel?<Btn variant="danger" onClick={()=>setConfirmDel(true)}>🗑 Delete</Btn>:<Btn variant="danger" onClick={onDelete}>Confirm ✓</Btn>}
          </div>
          {confirmDel&&<Btn variant="secondary" onClick={()=>setConfirmDel(false)} style={{width:"100%"}}>Cancel</Btn>}
        </div>
      </div>
    </div>
  );
}

// ─── Settings ─────────────────────────────────────────────────────────────────
function SettingsScreen({settings,onSave,onLogout}){
  const [loc,setLoc]=useState(settings);
  const [tip,setTip]=useState(null);
  const [saved,setSaved]=useState(false);
  const set=(k,v)=>setLoc(s=>({...s,[k]:v}));
  const save=()=>{onSave(loc);setSaved(true);setTimeout(()=>setSaved(false),2000);};
  const reset=()=>{if(confirm("Reset formula settings to defaults?")){const ns={...loc,...DEFAULT_SETTINGS};setLoc(ns);onSave(ns);}};
  const TIPS={mow_rate:"Dollar value of mowing 20,000 sqft (≈½ acre) in 1 hr.",trim_rate:"Cost to trim 3,000 linear feet in 1 hr. Most crews do 2,500–4,000 ft/hr.",equipment_cost:"Hourly cost to run your equipment — fuel, maintenance, depreciation.",hourly_rate:"True cost per worker per hour: wages + payroll taxes + benefits.",minimum_bid:"No quote goes below this. Covers drive time, mobilization, admin."};
  const FIELDS=[{key:"mow_rate",label:"Mow Rate ($/20k sqft)"},{key:"trim_rate",label:"Trim Rate ($/3k linear ft)"},{key:"equipment_cost",label:"Equipment Cost ($/hr)"},{key:"hourly_rate",label:"Hourly Rate ($/worker/hr)"},{key:"minimum_bid",label:"Minimum Bid ($)"}];
  return(
    <div style={{padding:16}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
        <div style={{fontSize:26,fontWeight:900,color:"#111"}}>Settings</div>
        <button onClick={reset} style={{background:"none",border:"none",color:"#dc2626",fontSize:13,fontWeight:700,cursor:"pointer"}}>↺ Reset Defaults</button>
      </div>
      <Card>
        <Lbl>Formula Defaults</Lbl>
        {FIELDS.map(({key,label})=>(
          <div key={key} style={{marginBottom:14}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
              <span style={{fontSize:13,fontWeight:600,color:"#444"}}>{label}</span>
              <button onClick={()=>setTip(tip===key?null:key)} style={{width:20,height:20,borderRadius:"50%",border:"1.5px solid #d1d5db",background:"none",fontSize:10,cursor:"pointer",color:"#666",fontFamily:"inherit"}}>?</button>
            </div>
            {tip===key&&<div style={{background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:8,padding:"8px 12px",fontSize:12,color:"#166534",marginBottom:6}}>{TIPS[key]}</div>}
            <Inp type="number" value={loc[key]} onChange={e=>set(key,parseFloat(e.target.value)||0)}/>
          </div>
        ))}
        <div style={{marginBottom:12}}>
          <Lbl>Complexity Default</Lbl>
          <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>{COMPLEXITY.map(o=><Chip key={o.value} label={`${o.label} (${o.value}×)`} active={loc.complexity_default===o.value} onClick={()=>set("complexity_default",o.value)}/>)}</div>
        </div>
        <div>
          <Lbl>Risk Default</Lbl>
          <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>{RISK.map(o=><Chip key={o.value} label={`${o.label} (${o.value}×)`} active={loc.risk_default===o.value} onClick={()=>set("risk_default",o.value)}/>)}</div>
        </div>
      </Card>
      <Card>
        <Lbl>Business Info</Lbl>
        {[["company_name","Company Name","text","Your Company"],["company_phone","Phone","tel","(555) 000-0000"],["company_email","Email","email","you@example.com"]].map(([k,lbl,t,ph])=>(
          <div key={k} style={{marginBottom:12}}>
            <div style={{fontSize:13,fontWeight:600,color:"#444",marginBottom:4}}>{lbl}</div>
            <Inp type={t} value={loc[k]||""} onChange={e=>set(k,e.target.value)} placeholder={ph}/>
          </div>
        ))}
      </Card>
      <Btn onClick={save} style={{width:"100%"}}>{saved?"✓ Saved to database!":"Save Settings"}</Btn>
      <Btn variant="danger" onClick={onLogout} style={{width:"100%",marginTop:10}}>Log Out</Btn>
      <div style={{textAlign:"center",fontSize:11,color:"#9ca3af",marginTop:20}}>LawnBid v{APP_VERSION} · Built for lawn care professionals</div>
    </div>
  );
}

// ─── Auth Screen ──────────────────────────────────────────────────────────────
function AuthScreen(){
  const [email,setEmail]=useState("");
  const [password,setPassword]=useState("");
  const [err,setErr]=useState("");
  const [info,setInfo]=useState("");
  const [busy,setBusy]=useState(false);

  const login=async()=>{
    setErr("");setInfo("");setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if(error) setErr(error.message);
  };
  const signup=async()=>{
    setErr("");setInfo("");setBusy(true);
    const { data, error } = await supabase.auth.signUp({ email, password });
    setBusy(false);
    if(error) setErr(error.message);
    else if(!data.session) setInfo("Check your email to confirm your account.");
  };

  return(
    <div style={{maxWidth:480,margin:"0 auto",minHeight:"100vh",display:"flex",flexDirection:"column",justifyContent:"center",padding:"24px",fontFamily:"system-ui,-apple-system,sans-serif",background:"#f4f4f5",boxSizing:"border-box"}}>
      <div style={{textAlign:"center",marginBottom:28}}>
        <img src="/logo.png" alt="LawnBid" style={{width:72,height:72,borderRadius:"50%",objectFit:"cover",marginBottom:10}}/>
        <div style={{fontSize:30,fontWeight:900,color:"#16a34a",letterSpacing:-.5}}>LawnBid</div>
        <div style={{fontSize:13,color:"#888",marginTop:4}}>Sign in to your account</div>
      </div>
      <Card>
        <div style={{marginBottom:12}}>
          <div style={{fontSize:13,fontWeight:600,color:"#444",marginBottom:4}}>Email</div>
          <Inp type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email"/>
        </div>
        <div style={{marginBottom:12}}>
          <div style={{fontSize:13,fontWeight:600,color:"#444",marginBottom:4}}>Password</div>
          <Inp type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="••••••••" autoComplete="current-password"/>
        </div>
        <div style={{display:"flex",gap:8,marginTop:8}}>
          <Btn onClick={login} disabled={busy||!email||!password} style={{flex:1}}>Log In</Btn>
          <Btn variant="outline" onClick={signup} disabled={busy||!email||!password} style={{flex:1}}>Create Account</Btn>
        </div>
        {err&&<div style={{marginTop:12,padding:"10px 12px",background:"#fef2f2",border:"1px solid #fca5a5",borderRadius:8,color:"#dc2626",fontSize:13,fontWeight:500}}>⚠ {err}</div>}
        {info&&<div style={{marginTop:12,padding:"10px 12px",background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:8,color:"#166534",fontSize:13,fontWeight:500}}>✓ {info}</div>}
      </Card>
    </div>
  );
}

// ─── Quote Flow ────────────────────────────────────────────────────────────────
function QuoteFlow({step,setStep,flow,setFlow,errors,setErrors,settings,clients,quotes,onSave,onCancel,saving}){
  const [sharePay,setSharePay]=useState(null);
  const [copied,setCopied]=useState(false);
  const set=(k,v)=>setFlow(f=>({...f,[k]:v}));

  const aU=AREA_UNITS.find(u=>u.value===flow.areaUnit)||AREA_UNITS[0];
  const pU=PERIM_UNITS.find(u=>u.value===flow.perimUnit)||PERIM_UNITS[0];
  const area=aU.conv(parseFloat(flow.areaVal)||0);
  const perim=pU.conv(parseFloat(flow.perimVal)||0);
  const calc=calcQ(area,perim,flow.cx,flow.risk,flow.disc,settings,flow.override);
  const time=calcTime(area,perim,flow.crew,flow.cx);

  const v1=()=>{const e={};if(!flow.clientName?.trim())e.clientName="Required";if(!flow.clientPhone?.trim())e.clientPhone="Required";if(!flow.address?.trim())e.address="Required";setErrors(e);return!Object.keys(e).length;};
  const v2=()=>{const e={};if(!flow.areaVal||area<=0)e.area="Enter a valid area greater than 0";if(!flow.perimVal||perim<=0)e.perim="Enter a valid perimeter greater than 0";setErrors(e);return!Object.keys(e).length;};
  const next=()=>{if(step===1&&!v1())return;if(step===2&&!v2())return;setStep(s=>s+1);};

  const buildRec=(status)=>({
    isNew:flow.isNew!==false, existingId:flow.existingId||null, parentId:flow.parentId||null,
    address:flow.address, area_sqft:area, linear_ft:perim, crew_size:flow.crew,
    complexity:flow.cx, risk:flow.risk, discount_pct:flow.disc,
    mow_rate_used:settings.mow_rate, trim_rate_used:settings.trim_rate, equipment_cost_used:settings.equipment_cost,
    formula_price:calc?.fl||0, final_price:calc?.disp||0, status,
    clientId:flow.clientId, client_name:flow.clientName, client_phone:flow.clientPhone, client_email:flow.clientEmail,
    notes:flow.notes, saveClient:flow.saveClient, sentAt:flow.sentAt||null,
  });
  const buildCli=()=>flow.saveClient?{name:flow.clientName,phone:flow.clientPhone,email:flow.clientEmail,default_address:flow.address,last_area_sqft:area,last_linear_ft:perim}:null;

  const handleSend=async(status)=>{
    const rec=buildRec(status),cli=buildCli();
    if(status==="sent"){
      // Reserve the real quote_id now so the shared text shows it (not "PENDING")
      if(!rec.existingId){
        try{ rec.existingId=await nextQuoteId(); }
        catch(e){ alert("Could not reserve quote ID: "+(e.message||"network error")); return; }
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
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.6)",zIndex:200,display:"flex",alignItems:"flex-end"}}>
          <div style={{background:"#fff",borderRadius:"16px 16px 0 0",padding:20,width:"100%",maxWidth:480,margin:"0 auto",boxSizing:"border-box"}}>
            <div style={{fontWeight:700,fontSize:17,marginBottom:12}}>📤 Ready to Send</div>
            <textarea readOnly value={sharePay.txt} style={{width:"100%",height:200,border:"1.5px solid #e0e0e0",borderRadius:8,padding:10,fontSize:12,fontFamily:"monospace",boxSizing:"border-box",resize:"none"}}/>
            <div style={{display:"flex",gap:8,marginTop:12}}>
              <Btn style={{flex:1}} onClick={()=>{navigator.clipboard?.writeText(sharePay.txt);setCopied(true);setTimeout(()=>setCopied(false),2000);}}>{copied?"✓ Copied!":"Copy"}</Btn>
              <Btn variant="secondary" style={{flex:1}} onClick={()=>{const{rec,cli}=sharePay;setSharePay(null);onSave(rec,cli,"sent");}}>Done ›</Btn>
            </div>
          </div>
        </div>
      )}
      <div style={{background:"#fff",padding:"12px 16px",borderBottom:"1px solid #e5e7eb",display:"flex",alignItems:"center",gap:12,position:"sticky",top:0,zIndex:10}}>
        <button onClick={step===1?onCancel:()=>setStep(s=>s-1)} style={{background:"none",border:"none",fontSize:24,cursor:"pointer",color:"#16a34a",fontFamily:"inherit",lineHeight:1}}>‹</button>
        <div style={{flex:1}}>
          <div style={{fontWeight:700,fontSize:15}}>{flow.parentId?"New V2 Quote":"New Quote"} — Step {step} of 4</div>
          <div style={{fontSize:12,color:"#888"}}>{STEPS[step-1]}{flow.parentId?` · Revision of ${flow.parentId}`:""}</div>
        </div>
        <button onClick={onCancel} style={{background:"none",border:"none",fontSize:12,color:"#aaa",cursor:"pointer",fontFamily:"inherit"}}>✕</button>
      </div>
      <div style={{height:4,background:"#f0f0f0"}}><div style={{height:"100%",background:"#16a34a",width:`${step*25}%`,transition:"width .3s"}}/></div>
      <div style={{padding:16}}>
        {step===1&&<S1 flow={flow} set={set} errors={errors} clients={clients}/>}
        {step===2&&<S2 flow={flow} set={set} errors={errors} area={area} perim={perim}/>}
        {step===3&&<S3 flow={flow} set={set} area={area} perim={perim} calc={calc} time={time} settings={settings}/>}
        {step===4&&<S4 flow={flow} set={set} area={area} perim={perim} calc={calc} time={time} onSend={handleSend} saving={saving}/>}
        {step<4&&<Btn onClick={next} style={{width:"100%",marginTop:8}}>Next →</Btn>}
      </div>
    </div>
  );
}

function S1({flow,set,errors,clients}){
  const [sugg,setSugg]=useState([]);
  const onName=v=>{set("clientName",v);set("clientId",null);setSugg(v.length>1?clients.filter(c=>c.name?.toLowerCase().includes(v.toLowerCase())||c.phone?.includes(v)).slice(0,5):[]);};
  const pick=c=>{set("clientId",c.id);set("clientName",c.name);set("clientPhone",c.phone||"");set("clientEmail",c.email||"");set("address",c.default_address||"");if(c.last_area_sqft){set("areaVal",String(c.last_area_sqft));set("areaUnit","sqft");}if(c.last_linear_ft){set("perimVal",String(c.last_linear_ft));set("perimUnit","ft");}setSugg([]);};
  return(
    <div>
      <Card>
        <Lbl>Client Information</Lbl>
        <div style={{marginBottom:12,position:"relative"}}>
          <div style={{fontSize:13,fontWeight:600,color:"#444",marginBottom:4}}>Client Name *</div>
          <Inp value={flow.clientName} onChange={e=>onName(e.target.value)} onBlur={()=>setTimeout(()=>setSugg([]),150)} placeholder="Name or search existing client"/>
          <ErrMsg msg={errors.clientName}/>
          {sugg.length>0&&(
            <div style={{position:"absolute",top:"100%",left:0,right:0,background:"#fff",border:"1.5px solid #e0e0e0",borderRadius:8,boxShadow:"0 4px 12px rgba(0,0,0,.12)",zIndex:50,marginTop:2}}>
              {sugg.map(c=>(
                <div key={c.id} onMouseDown={()=>pick(c)} style={{padding:"10px 14px",cursor:"pointer",borderBottom:"1px solid #f5f5f5"}}>
                  <div style={{fontWeight:600}}>{c.name}</div>
                  <div style={{fontSize:12,color:"#888"}}>{c.phone}{c.default_address?" · "+c.default_address:""}</div>
                </div>
              ))}
            </div>
          )}
        </div>
        {flow.clientId&&<div style={{background:"#f0fdf4",borderRadius:8,padding:"6px 10px",fontSize:12,color:"#166534",marginBottom:10}}>✓ Existing client — measurements pre-filled from last quote</div>}
        <div style={{marginBottom:12}}>
          <div style={{fontSize:13,fontWeight:600,color:"#444",marginBottom:4}}>Phone *</div>
          <Inp type="tel" value={flow.clientPhone} onChange={e=>set("clientPhone",e.target.value)} placeholder="(555) 000-0000"/>
          <ErrMsg msg={errors.clientPhone}/>
        </div>
        <div>
          <div style={{fontSize:13,fontWeight:600,color:"#444",marginBottom:4}}>Email (optional)</div>
          <Inp type="email" value={flow.clientEmail} onChange={e=>set("clientEmail",e.target.value)} placeholder="client@email.com"/>
        </div>
      </Card>
      <Card>
        <Lbl>Job Address</Lbl>
        <Inp value={flow.address} onChange={e=>set("address",e.target.value)} placeholder="123 Main St, City, State"/>
        <ErrMsg msg={errors.address}/>
      </Card>
    </div>
  );
}

function S2({flow,set,errors,area,perim}){
  return(
    <div>
      {flow.clientId&&flow.areaVal&&<div style={{background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:10,padding:"10px 14px",marginBottom:12,fontSize:13,color:"#166534"}}>📐 Measurements pre-filled from last quote. Adjust if area has changed.</div>}
      <div style={{background:"#fffbeb",border:"1px solid #fde68a",borderRadius:10,padding:"10px 14px",marginBottom:12,fontSize:13,color:"#92400e"}}>🗺 Satellite map measurement coming in V2. Enter dimensions manually below.</div>
      <Card>
        <Lbl>Lawn Area</Lbl>
        <div style={{display:"flex",gap:8,marginBottom:4}}>
          <Inp type="number" value={flow.areaVal} onChange={e=>set("areaVal",e.target.value)} placeholder="Enter area" style={{flex:1}}/>
          <Sel value={flow.areaUnit} onChange={e=>set("areaUnit",e.target.value)}>{AREA_UNITS.map(u=><option key={u.value} value={u.value}>{u.label}</option>)}</Sel>
        </div>
        {area>0&&flow.areaUnit!=="sqft"&&<div style={{fontSize:12,color:"#16a34a",marginBottom:2}}>= {area.toLocaleString(undefined,{maximumFractionDigits:0})} sq ft</div>}
        {area>0&&<div style={{fontSize:12,color:"#888"}}>{(area/43560).toFixed(4)} acres</div>}
        <ErrMsg msg={errors.area}/>
      </Card>
      <Card>
        <Lbl>Perimeter</Lbl>
        <div style={{display:"flex",gap:8,marginBottom:4}}>
          <Inp type="number" value={flow.perimVal} onChange={e=>set("perimVal",e.target.value)} placeholder="Enter perimeter" style={{flex:1}}/>
          <Sel value={flow.perimUnit} onChange={e=>set("perimUnit",e.target.value)}>{PERIM_UNITS.map(u=><option key={u.value} value={u.value}>{u.label}</option>)}</Sel>
        </div>
        {perim>0&&flow.perimUnit!=="ft"&&<div style={{fontSize:12,color:"#16a34a",marginBottom:2}}>= {perim.toLocaleString(undefined,{maximumFractionDigits:0})} linear ft</div>}
        <ErrMsg msg={errors.perim}/>
        <div style={{fontSize:11,color:"#999",marginTop:6}}>💡 Perimeter drives your trimming price. Rough guide: perimeter ≈ 4 × √area</div>
      </Card>
    </div>
  );
}

function S3({flow,set,area,perim,calc,time,settings}){
  const [editing,setEditing]=useState(false);
  return(
    <div>
      <div style={{background:"#f0fdf4",borderRadius:10,padding:"10px 14px",marginBottom:12,fontSize:13}}>
        <div style={{fontWeight:700}}>📍 {flow.address}</div>
        <div style={{color:"#555",marginTop:2}}>{Math.round(area).toLocaleString()} sqft · {Math.round(perim).toLocaleString()} ft perimeter</div>
      </div>
      <Card><Lbl>Crew Size</Lbl><div style={{display:"flex",gap:6}}>{[1,2,3,4,5].map(n=><Chip key={n} label={String(n)} active={flow.crew===n} onClick={()=>set("crew",n)}/>)}</div></Card>
      <Card>
        <Lbl>Job Complexity</Lbl>
        <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:8}}>{COMPLEXITY.map(o=><Chip key={o.value} label={`${o.label} (${o.value}×)`} active={flow.cx===o.value} onClick={()=>set("cx",o.value)}/>)}</div>
        <div style={{fontSize:12,color:"#666"}}>{COMPLEXITY.find(o=>o.value===flow.cx)?.desc}</div>
      </Card>
      <Card>
        <Lbl>Site Risk</Lbl>
        <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:8}}>{RISK.map(o=><Chip key={o.value} label={`${o.label} (${o.value}×)`} active={flow.risk===o.value} onClick={()=>set("risk",o.value)}/>)}</div>
        <div style={{fontSize:12,color:"#666"}}>{RISK.find(o=>o.value===flow.risk)?.desc}</div>
      </Card>
      {time&&(
        <Card style={{background:"#f0fdf4",border:"1px solid #bbf7d0"}}>
          <Lbl>⏱ Time Estimate</Lbl>
          <div style={{display:"flex",alignItems:"flex-end",gap:10,marginBottom:6}}>
            <div style={{fontSize:48,fontWeight:900,color:"#16a34a",lineHeight:1}}>{fmtT(time.adj)}</div>
            {flow.cx>1&&<div style={{fontSize:12,color:"#f59e0b",paddingBottom:6}}>+{fmtT(time.adj-time.wall)} complexity</div>}
          </div>
          <div style={{fontSize:12,color:"#166534",marginBottom:12}}>{flow.crew>=2?`${flow.crew}-person crew — mow & trim in parallel`:"Solo — mow then trim sequentially"}</div>
          {[{label:"Mowing",hrs:time.mh,note:`${Math.round(area).toLocaleString()} sqft ÷ 20,000`},{label:"Trimming",hrs:time.th,note:`${Math.round(perim).toLocaleString()} ft ÷ 3,000`}].map(ph=>(
            <div key={ph.label} style={{marginBottom:10}}>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:13,marginBottom:3}}><span style={{color:"#374151"}}>{ph.label}</span><span style={{fontWeight:700}}>{fmtT(ph.hrs)}</span></div>
              <div style={{background:"#d1fae5",borderRadius:4,height:5}}><div style={{background:"#16a34a",height:"100%",borderRadius:4,width:`${Math.min(100,(ph.hrs/(time.mh+time.th))*100)}%`}}/></div>
              <div style={{fontSize:10,color:"#6b7280",marginTop:2}}>{ph.note}</div>
            </div>
          ))}
          <div style={{marginBottom:14}}>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:4}}><span style={{color:"#374151"}}>% of 8-hr workday</span><span style={{fontWeight:700}}>{Math.round(time.pct)}%</span></div>
            <div style={{background:"#d1fae5",borderRadius:4,height:8}}><div style={{background:time.pct>80?"#dc2626":time.pct>50?"#f59e0b":"#16a34a",height:"100%",borderRadius:4,width:`${time.pct}%`,transition:"all .3s"}}/></div>
          </div>
          <div style={{fontSize:11,fontWeight:700,color:"#166534",textTransform:"uppercase",letterSpacing:.5,marginBottom:6}}>Crew Impact</div>
          <div style={{display:"flex",gap:6}}>
            {time.crew_times.map(({n,t})=>(
              <div key={n} style={{flex:1,textAlign:"center",padding:"8px 4px",borderRadius:8,background:n===flow.crew?"#16a34a":"#d1fae5",color:n===flow.crew?"#fff":"#166534"}}>
                <div style={{fontSize:10,fontWeight:600}}>{n} crew</div>
                <div style={{fontSize:13,fontWeight:800}}>{fmtT(t)}</div>
              </div>
            ))}
          </div>
        </Card>
      )}
      <Card>
        <Lbl>Discount</Lbl>
        <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
          {[0,5,10,15,20].map(p=><Chip key={p} label={p===0?"None":`${p}%`} active={flow.disc===p&&!flow.customDisc} onClick={()=>{set("disc",p);set("customDisc","");}}/>)}
          <div style={{display:"flex",alignItems:"center",gap:4}}>
            <Inp type="number" min="0" max="100" placeholder="—" value={flow.customDisc} onChange={e=>{set("customDisc",e.target.value);set("disc",parseFloat(e.target.value)||0);}} style={{width:52,padding:8,fontSize:13,textAlign:"center"}}/>
            <span style={{fontSize:13,color:"#666"}}>%</span>
          </div>
        </div>
      </Card>
      {calc&&(
        <Card style={{background:"#111",color:"#fff"}}>
          <Lbl style={{color:"#555"}}>Calculated Bid</Lbl>
          {flow.disc>0&&<div style={{fontSize:18,color:"#4b5563",textDecoration:"line-through",marginBottom:4}}>{$$(calc.fl)}</div>}
          {editing?(
            <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
              <span style={{fontSize:36,color:"#4ade80",fontWeight:900}}>$</span>
              <input type="number" defaultValue={calc.disp.toFixed(2)} onChange={e=>set("override",e.target.value)} autoFocus style={{fontSize:42,fontWeight:900,background:"transparent",border:"none",borderBottom:"2px solid #4ade80",color:"#4ade80",outline:"none",width:"100%",fontFamily:"inherit"}}/>
            </div>
          ):(
            <div onClick={()=>setEditing(true)} style={{fontSize:52,fontWeight:900,color:"#4ade80",letterSpacing:-2,cursor:"pointer",lineHeight:1,marginBottom:4}}>{$$(calc.disp)}</div>
          )}
          {editing?<button onClick={()=>{setEditing(false);set("override",null);}} style={{fontSize:12,color:"#4ade80",background:"none",border:"none",cursor:"pointer",marginBottom:12,fontFamily:"inherit"}}>← reset to formula</button>:<div style={{fontSize:12,color:"#555",marginBottom:12}}>Tap price to override</div>}
          {calc.minA&&<div style={{fontSize:12,color:"#f59e0b",marginBottom:12}}>⚠ Minimum bid applied (formula: {$$(calc.ar)})</div>}
          <div style={{borderTop:"1px solid #333",paddingTop:12}}>
            <Lbl style={{color:"#555"}}>Breakdown</Lbl>
            {calc.bd.map((r,i)=>(
              <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",padding:"5px 0",borderBottom:r.subtotal?"1px solid #444":"1px solid #1c1c1c",color:r.subtotal?"#fff":r.modifier?"#9ca3af":"#d1d5db",fontWeight:r.subtotal?700:400}}>
                <div><div style={{fontSize:13}}>{r.label}</div>{r.note&&<div style={{fontSize:10,color:"#555"}}>{r.note}</div>}</div>
                <div style={{fontSize:13,fontWeight:600}}>{r.modifier&&r.value>0?"+":""}{$$(r.value)}</div>
              </div>
            ))}
            <div style={{display:"flex",justifyContent:"space-between",marginTop:10,fontSize:18,fontWeight:900,color:"#4ade80"}}><span>FINAL BID</span><span>{$$(calc.disp)}</span></div>
          </div>
        </Card>
      )}
    </div>
  );
}

function S4({flow,set,area,perim,calc,time,onSend,saving}){
  return(
    <div>
      <Card>
        <Lbl>Client</Lbl>
        <div style={{fontWeight:700,fontSize:16}}>{flow.clientName}</div>
        <div style={{fontSize:14,color:"#666",marginTop:2}}>{flow.clientPhone}</div>
        {flow.clientEmail&&<div style={{fontSize:14,color:"#666"}}>{flow.clientEmail}</div>}
      </Card>
      <Card style={{background:"#f9fafb"}}>
        <Lbl>Quote Summary</Lbl>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
          {[{l:"Address",v:flow.address,full:true},{l:"Area",v:`${Math.round(area).toLocaleString()} sqft`},{l:"Perimeter",v:`${Math.round(perim).toLocaleString()} ft`},{l:"Crew",v:`${flow.crew} worker${flow.crew>1?"s":""}`},{l:"Complexity",v:COMPLEXITY.find(o=>o.value===flow.cx)?.label},{l:"Risk",v:RISK.find(o=>o.value===flow.risk)?.label},{l:"Est. Time",v:time?fmtT(time.adj):"—"},{l:"Discount",v:flow.disc>0?`${flow.disc}%`:"None"}]
            .map(({l,v,full})=>(
              <div key={l} style={{gridColumn:full?"1 / -1":"auto"}}>
                <div style={{fontSize:10,fontWeight:700,color:"#9ca3af",textTransform:"uppercase"}}>{l}</div>
                <div style={{fontSize:13,fontWeight:600,color:"#111",marginTop:2}}>{v}</div>
              </div>
            ))}
        </div>
        <div style={{borderTop:"2px solid #e5e7eb",paddingTop:12,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <span style={{fontWeight:700,fontSize:16}}>Total</span>
          <span style={{fontSize:32,fontWeight:900,color:"#16a34a"}}>{calc?$$(calc.disp):"—"}</span>
        </div>
      </Card>
      <Card>
        <Lbl>Notes (optional)</Lbl>
        <textarea value={flow.notes} onChange={e=>set("notes",e.target.value)} placeholder="Add notes for this job…" style={{width:"100%",minHeight:80,border:"1.5px solid #e0e0e0",borderRadius:8,padding:"10px 12px",fontSize:14,fontFamily:"inherit",resize:"vertical",boxSizing:"border-box",outline:"none"}}/>
      </Card>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",background:"#fff",borderRadius:12,padding:"12px 16px",marginBottom:12,boxShadow:"0 1px 4px rgba(0,0,0,.08)"}}>
        <div><div style={{fontWeight:600}}>Save to client list</div><div style={{fontSize:12,color:"#666"}}>Remembers address & measurements</div></div>
        <div onClick={()=>set("saveClient",!flow.saveClient)} style={{width:44,height:26,borderRadius:13,background:flow.saveClient?"#16a34a":"#d1d5db",cursor:"pointer",position:"relative",transition:"background .2s",flexShrink:0}}>
          <div style={{width:22,height:22,background:"#fff",borderRadius:"50%",position:"absolute",top:2,left:flow.saveClient?20:2,transition:"left .2s",boxShadow:"0 1px 3px rgba(0,0,0,.2)"}}/>
        </div>
      </div>
      <Btn onClick={()=>onSend("sent")} disabled={saving} style={{width:"100%",marginBottom:10,fontSize:16}}>{saving?"Saving to database…":"📤 Send Quote"}</Btn>
      <Btn variant="outline" onClick={()=>onSend("draft")} disabled={saving} style={{width:"100%"}}>💾 Save as Draft</Btn>
    </div>
  );
}
