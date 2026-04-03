import { useState, useRef, useEffect, useCallback } from "react";
import PatientCardDetected from "./modules/PatientCardDetected";
import { useContactsCtx } from "../App";

const C = {
  bg:       "#f9f9f8",
  sidebar:  "#f0efea",
  border:   "#e5e4df",
  text:     "#1a1a1a",
  sub:      "#6b6b6b",
  green:    "#0a7c5c",
  greenBg:  "#dcf2e8",
  meBg:     "#e8f4ff",
  meBorder: "#c5dff8",
  patBg:    "#ffffff",
  patBorder:"#e5e4df",
};

function formatMsgDate(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const dd = String(d.getDate()).padStart(2,"0");
  const mm = String(d.getMonth()+1).padStart(2,"0");
  const yy = String(d.getFullYear()).slice(2);
  const hh = String(d.getHours()).padStart(2,"0");
  const mi = String(d.getMinutes()).padStart(2,"0");
  return `${dd}/${mm}/${yy} - ${hh}:${mi}`;
}

function dayKey(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const weekday = d.toLocaleDateString("pt-BR", { weekday:"long" });
  const date    = d.toLocaleDateString("pt-BR", { day:"2-digit", month:"2-digit", year:"numeric" });
  return `${weekday.charAt(0).toUpperCase()+weekday.slice(1)} - ${date}`;
}

export default function ChatWindow({ chat, messages, operator, onSend, onForward, onResolve, canForwardToAdmin, onLoadMore }) {
  const [text, setText]               = useState("");
  const [sending, setSending]         = useState(false);
  const [showForward, setShowForward] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore]         = useState(true);
  const [oldestDate, setOldestDate]   = useState(null);
  const bottomRef      = useRef(null);
  const scrollRef      = useRef(null);
  const prevScrollH    = useRef(0);
  const { displayInfo } = useContactsCtx();
  const info = displayInfo(chat.id, chat.name);

  useEffect(() => {
    setHasMore(true); setOldestDate(null); setLoadingMore(false);
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior:"instant" }), 60);
  }, [chat.id]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
    if (nearBottom) bottomRef.current?.scrollIntoView({ behavior:"smooth" });
  }, [messages]);

  const handleScroll = useCallback(async () => {
    const el = scrollRef.current;
    if (!el || loadingMore || !hasMore || !onLoadMore) return;
    if (el.scrollTop > 80) return;
    setLoadingMore(true);
    prevScrollH.current = el.scrollHeight;
    const result = await onLoadMore(chat.id, oldestDate);
    setHasMore(result?.hasMore ?? false);
    setOldestDate(result?.oldest ?? null);
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop += scrollRef.current.scrollHeight - prevScrollH.current;
      }
      setLoadingMore(false);
    });
  }, [loadingMore, hasMore, onLoadMore, chat.id, oldestDate]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener("scroll", handleScroll, { passive:true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);

  async function handleSend() {
    if (!text.trim() || sending) return;
    setSending(true);
    try { await onSend(text.trim()); setText(""); }
    catch (e) { alert("Erro: " + e.message); }
    finally { setSending(false); }
  }

  const forwardTargets = [
    { label:"Recepção",            value:"recepcao" },
    { label:"Dra. Ana (Dentista)", value:"ana"      },
    ...(canForwardToAdmin ? [{ label:"Administrativo 🔒", value:"admin" }] : []),
  ].filter(t => t.value !== chat.assignedTo);

  // Agrupa mensagens por dia para inserir separadores
  const msgsWithSeparators = [];
  let lastDay = null;
  for (const msg of messages) {
    const dk = dayKey(msg.ts);
    if (dk && dk !== lastDay) {
      msgsWithSeparators.push({ __separator: true, ts: msg.ts, label: dayLabel(msg.ts) });
      lastDay = dk;
    }
    msgsWithSeparators.push(msg);
  }

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%", overflow:"hidden",
      background: C.bg, fontFamily:"'DM Sans', sans-serif" }}>

      {/* Header */}
      <div style={{ padding:"10px 16px", borderBottom:`1px solid ${C.border}`,
        background:"#fff", display:"flex", alignItems:"center", gap:10, flexShrink:0,
        boxShadow:"0 1px 3px rgba(0,0,0,.06)" }}>
        <Avatar info={info} chat={chat} size={38} />
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ color:C.text, fontSize:14, fontWeight:600,
            overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
            {info.hasContact ? info.name : info.phone}
          </div>
          {info.hasContact && (
            <div style={{ color:C.sub, fontSize:11, fontFamily:"'DM Mono', monospace" }}>
              {info.phone}
            </div>
          )}
        </div>

        <div style={{ position:"relative" }}>
          <button onClick={() => setShowForward(v=>!v)} style={{
            background:"transparent", border:`1px solid ${C.border}`, borderRadius:6,
            padding:"5px 10px", color:C.sub, fontSize:11, cursor:"pointer",
            fontFamily:"'DM Sans', sans-serif" }}>↗ Encaminhar</button>
          {showForward && (
            <div style={{ position:"absolute", top:36, right:0, zIndex:100,
              background:"#fff", border:`1px solid ${C.border}`, borderRadius:8,
              overflow:"hidden", minWidth:180, boxShadow:"0 8px 24px rgba(0,0,0,.12)" }}>
              {forwardTargets.map(t => (
                <button key={t.value} onClick={() => { onForward(t.value); setShowForward(false); }}
                  style={{ display:"block", width:"100%", textAlign:"left",
                    padding:"10px 14px", background:"transparent", border:"none",
                    color:C.text, fontSize:13, cursor:"pointer", fontFamily:"'DM Sans', sans-serif" }}
                  onMouseEnter={e => e.currentTarget.style.background=C.sidebar}
                  onMouseLeave={e => e.currentTarget.style.background="transparent"}>
                  {t.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {chat.status !== "resolved" && (
          <button onClick={onResolve} style={{
            background:C.green, border:"none", borderRadius:6,
            padding:"5px 12px", color:"#fff", fontSize:11,
            fontWeight:600, cursor:"pointer", fontFamily:"'DM Sans', sans-serif" }}>
            ✓ Resolver
          </button>
        )}
      </div>

      {/* Messages */}
      <div ref={scrollRef} style={{ flex:1, overflowY:"auto", padding:"12px 16px",
        display:"flex", flexDirection:"column", gap:2,
        background:`url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23e5e4df' fill-opacity='0.3'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")` }}>

        {loadingMore && (
          <div style={{ textAlign:"center", padding:8, color:C.sub, fontSize:12 }}>
            Carregando histórico...
          </div>
        )}
        {!hasMore && messages.length > 10 && (
          <div style={{ textAlign:"center", padding:"6px 0",
            color:C.sub, fontSize:11, fontStyle:"italic" }}>
            Início da conversa
          </div>
        )}
        {messages.length === 0 && !loadingMore && (
          <div style={{ textAlign:"center", color:C.sub, fontSize:13, marginTop:40 }}>
            Nenhuma mensagem ainda
          </div>
        )}

        {msgsWithSeparators.map((item, i) => {
          if (item.__separator) {
            return (
              <div key={`sep-${item.ts}`} style={{ display:"flex", alignItems:"center", gap:10,
                margin:"12px 0 8px" }}>
                <div style={{ flex:1, height:1, background:C.border }} />
                <span style={{ fontSize:11, color:C.sub, fontWeight:600,
                  background:C.bg, padding:"2px 10px", borderRadius:20,
                  border:`1px solid ${C.border}` }}>{item.label}</span>
                <div style={{ flex:1, height:1, background:C.border }} />
              </div>
            );
          }
          return <MessageBubble key={item.id || i} msg={item} currentOperator={operator} />;
        })}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      {chat.status !== "resolved" ? (
        <div style={{ padding:"10px 14px", borderTop:`1px solid ${C.border}`,
          background:"#fff", display:"flex", gap:8, alignItems:"flex-end", flexShrink:0 }}>
          <div style={{ flex:1, position:"relative" }}>
            <div style={{ position:"absolute", top:-18, left:2,
              fontSize:10, color:C.green, fontWeight:600 }}>{operator.name}:</div>
            <textarea value={text} onChange={e => setText(e.target.value)}
              onKeyDown={e => { if (e.key==="Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
              placeholder="Enter para enviar · Shift+Enter para nova linha"
              rows={2} style={{ width:"100%", background:C.sidebar,
                border:`1px solid ${C.border}`, borderRadius:8,
                padding:"10px 12px", color:C.text,
                fontFamily:"'DM Sans', sans-serif", fontSize:13,
                outline:"none", resize:"none", boxSizing:"border-box" }} />
          </div>
          <button onClick={handleSend} disabled={sending || !text.trim()} style={{
            background:(sending||!text.trim()) ? C.border : C.green,
            border:"none", borderRadius:8, width:40, height:40, color:"#fff",
            fontSize:18, cursor:sending?"not-allowed":"pointer", flexShrink:0,
            display:"flex", alignItems:"center", justifyContent:"center",
            transition:"background .15s" }}>{sending ? "…" : "→"}</button>
        </div>
      ) : (
        <div style={{ padding:12, textAlign:"center", borderTop:`1px solid ${C.border}`,
          background:"#fff", color:C.sub, fontSize:12 }}>
          Chat resolvido · <span style={{ color:C.green, cursor:"pointer" }}
            onClick={onResolve}>Reabrir</span>
        </div>
      )}
    </div>
  );
}

function Avatar({ info, chat, size = 40 }) {
  const initials = info.hasContact
    ? info.name.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase()
    : (chat.avatar || "?");
  const photoUrl = info.photoUrl || chat.photoUrl || null;

  if (photoUrl) {
    return (
      <img src={photoUrl} alt={initials}
        style={{ width:size, height:size, borderRadius:"50%",
          objectFit:"cover", flexShrink:0, border:`2px solid ${C.border}` }}
        onError={e => { e.target.style.display="none"; }} />
    );
  }
  return (
    <div style={{ width:size, height:size, borderRadius:"50%", flexShrink:0,
      background: chat.avatarColor+"33", color: chat.avatarColor,
      display:"flex", alignItems:"center", justifyContent:"center",
      fontSize: size*0.3, fontWeight:700, border:`2px solid ${chat.avatarColor}44` }}>
      {initials}
    </div>
  );
}

function MessageBubble({ msg, currentOperator }) {
  if (msg.hasPatientCard) return <PatientCardDetected msg={msg} />;
  const isPatient = msg.from === "patient";
  const isBot     = msg.operator?.includes("🤖");
  const isMe      = msg.operator === currentOperator?.name;
  const dateStr   = formatMsgDate(msg.ts);

  return (
    <div style={{ display:"flex", justifyContent:isPatient?"flex-start":"flex-end",
      marginBottom:2 }}>
      <div style={{ maxWidth:"70%" }}>
        {!isPatient && (
          <div style={{ fontSize:10, fontWeight:700, marginBottom:2, textAlign:"right",
            color:isBot?"#7c4dff":C.green }}>
            {msg.operator || "Operador"}
          </div>
        )}
        <div style={{
          background: isBot?"#ede7ff" : isMe ? C.meBg : C.patBg,
          border:`1px solid ${isBot?"#d1c4e9":isMe?C.meBorder:C.patBorder}`,
          borderRadius: isPatient ? "2px 12px 12px 12px" : "12px 2px 12px 12px",
          padding:"8px 12px",
          boxShadow:"0 1px 2px rgba(0,0,0,.06)" }}>
          <div style={{ color:C.text, fontSize:13, lineHeight:1.55, whiteSpace:"pre-wrap" }}>
            {msg.text}
          </div>
          <div style={{ color:C.sub, fontSize:10, marginTop:4, textAlign:"right" }}>
            {dateStr || msg.time}
          </div>
        </div>
      </div>
    </div>
  );
}