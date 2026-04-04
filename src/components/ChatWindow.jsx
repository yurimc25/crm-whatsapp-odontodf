import { useState, useRef, useEffect, useCallback } from "react";
import PatientCardDetected from "./modules/PatientCardDetected";
import { useContactsCtx } from "../App";
import { normalizeMessage } from "../services/waha";
import { cache } from "../utils/cache";

const MSGS_PREFIX = "waha_msgs_";
const MSGS_TTL    = 30 * 24 * 60 * 60 * 1000;

const T = {
  bg:        "#1e1e1e",
  header:    "#1a1a1a",
  border:    "#2d2d2d",
  text:      "#ececec",
  sub:       "#8e8e8e",
  accent:    "#d4956a",
  green:     "#4caf87",
  inputBg:   "#252525",
  bubblePat: "#2d2d2d",
  bubbleMe:  "#1e3a2a",
  bubbleBot: "#1e1a3a",
  borderMe:  "#2d5a3a",
  borderBot: "#2d2a5a",
  hover:     "#2a2a2a",
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

export default function ChatWindow({
  chat, messages, operator, onSend, onForward, onResolve,
  canForwardToAdmin, onLoadOlder
}) {
  const [text, setText]               = useState("");
  const [sending, setSending]         = useState(false);
  const [showForward, setShowForward] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore]         = useState(true);
  const [oldestDate, setOldestDate]   = useState(null);
  // Auto-refresh a cada 5s
  const [lastRefresh, setLastRefresh] = useState(Date.now());

  const bottomRef   = useRef(null);
  const scrollRef   = useRef(null);
  const prevScrollH = useRef(0);
  const { displayInfo } = useContactsCtx();
  const info = displayInfo(chat.id, chat.name);

  // Auto-refresh a cada 5 segundos
  useEffect(() => {
    const iv = setInterval(() => {
      setLastRefresh(Date.now());
      // O onLoadMore busca do MongoDB; para refresh da WAHA usamos o onRefresh se existir
      // O WebSocket já cuida do tempo real; esse é fallback
    }, 5000);
    return () => clearInterval(iv);
  }, []);

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
    if (!el || loadingMore || !hasMore || !onLoadOlder) return;
    if (el.scrollTop > 80) return;
    setLoadingMore(true);
    prevScrollH.current = el.scrollHeight;
    const result = await onLoadOlder(chat.id, messages);
    if (result?.hasMore === false) setHasMore(false);
    requestAnimationFrame(() => {
      if (scrollRef.current)
        scrollRef.current.scrollTop += scrollRef.current.scrollHeight - prevScrollH.current;
      setLoadingMore(false);
    });
  }, [loadingMore, hasMore, onLoadOlder, chat.id, messages]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener("scroll", handleScroll, { passive:true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);

  // Fecha dropdown ao clicar fora
  useEffect(() => {
    if (!showForward) return;
    const close = () => setShowForward(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [showForward]);

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

  // Separadores de dia
  const msgsWithSeps = [];
  let lastDay = null;
  for (const msg of messages) {
    const dk = dayKey(msg.ts);
    if (dk && dk !== lastDay) {
      msgsWithSeps.push({ __sep:true, ts:msg.ts, label:dayLabel(msg.ts) });
      lastDay = dk;
    }
    msgsWithSeps.push(msg);
  }

  const photoUrl = info.photoUrl || chat.photoUrl || null;

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%", overflow:"hidden",
      background:T.bg, fontFamily:"'DM Sans', sans-serif" }}>

      {/* Header */}
      <div style={{ padding:"10px 16px", borderBottom:`1px solid ${T.border}`,
        background:T.header, display:"flex", alignItems:"center",
        gap:10, flexShrink:0, boxShadow:"0 1px 4px rgba(0,0,0,.3)" }}>

        {photoUrl ? (
          <img src={photoUrl} alt=""
            style={{ width:38, height:38, borderRadius:"50%", objectFit:"cover",
              flexShrink:0, border:`2px solid ${T.border}` }}
            onError={e => { e.target.style.display="none"; }} />
        ) : (
          <div style={{ width:38, height:38, borderRadius:"50%", flexShrink:0,
            background:chat.avatarColor+"33", color:chat.avatarColor,
            display:"flex", alignItems:"center", justifyContent:"center",
            fontSize:12, fontWeight:700, border:`2px solid ${chat.avatarColor}44` }}>
            {info.hasContact
              ? info.name.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase()
              : chat.avatar || "?"}
          </div>
        )}

        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ color:T.text, fontSize:14, fontWeight:600,
            overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
            {info.hasContact ? info.name : info.phone}
          </div>
          {info.hasContact && (
            <div style={{ color:T.sub, fontSize:11, fontFamily:"'DM Mono', monospace" }}>
              {info.phone}
            </div>
          )}
        </div>

        {/* Encaminhar */}
        <div style={{ position:"relative" }}>
          <button onClick={e => { e.stopPropagation(); setShowForward(v=>!v); }} style={{
            background:"transparent", border:`1px solid ${T.border}`,
            borderRadius:6, padding:"5px 10px", color:T.sub, fontSize:11,
            cursor:"pointer", transition:"all .15s" }}
            onMouseEnter={e => { e.currentTarget.style.background=T.hover; e.currentTarget.style.color=T.text; }}
            onMouseLeave={e => { e.currentTarget.style.background="transparent"; e.currentTarget.style.color=T.sub; }}>
            ↗ Encaminhar
          </button>
          {showForward && (
            <div onClick={e => e.stopPropagation()}
              style={{ position:"absolute", top:36, right:0, zIndex:100,
                background:"#252525", border:`1px solid ${T.border}`, borderRadius:8,
                overflow:"hidden", minWidth:180, boxShadow:"0 8px 24px rgba(0,0,0,.5)" }}>
              {forwardTargets.map(t => (
                <button key={t.value}
                  onClick={() => { onForward(t.value); setShowForward(false); }}
                  style={{ display:"block", width:"100%", textAlign:"left",
                    padding:"10px 14px", background:"transparent", border:"none",
                    color:T.text, fontSize:13, cursor:"pointer" }}
                  onMouseEnter={e => e.currentTarget.style.background=T.hover}
                  onMouseLeave={e => e.currentTarget.style.background="transparent"}>
                  {t.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Marcar respondido — NÃO bloqueia input, NÃO fecha chat */}
        <button onClick={onResolve} style={{
          background:T.green+"22", border:`1px solid ${T.green}44`,
          borderRadius:6, padding:"5px 12px", color:T.green, fontSize:11,
          fontWeight:600, cursor:"pointer", transition:"all .15s" }}
          title="Zera o contador de espera e marca como lido"
          onMouseEnter={e => { e.currentTarget.style.background=T.green; e.currentTarget.style.color="#fff"; }}
          onMouseLeave={e => { e.currentTarget.style.background=T.green+"22"; e.currentTarget.style.color=T.green; }}>
          ✓ Respondido
        </button>
      </div>

      {/* Mensagens */}
      <div ref={scrollRef} style={{ flex:1, overflowY:"auto", padding:"12px 16px",
        display:"flex", flexDirection:"column", gap:2, background:T.bg }}>

        {loadingMore && (
          <div style={{ textAlign:"center", padding:8, color:T.sub, fontSize:12 }}>
            Carregando histórico...
          </div>
        )}
        {!hasMore && messages.length > 10 && (
          <div style={{ textAlign:"center", padding:"6px 0",
            color:"#444", fontSize:11, fontStyle:"italic" }}>
            Início da conversa
          </div>
        )}
        {messages.length === 0 && !loadingMore && (
          <div style={{ textAlign:"center", color:T.sub, fontSize:13, marginTop:40 }}>
            Nenhuma mensagem ainda
          </div>
        )}

        {msgsWithSeps.map((item, i) => {
          if (item.__sep) {
            return (
              <div key={`sep-${item.ts}-${i}`} style={{ display:"flex", alignItems:"center",
                gap:10, margin:"12px 0 8px" }}>
                <div style={{ flex:1, height:1, background:T.border }} />
                <span style={{ fontSize:11, color:T.sub, fontWeight:500,
                  background:"#252525", padding:"2px 10px", borderRadius:20,
                  border:`1px solid ${T.border}` }}>
                  {item.label}
                </span>
                <div style={{ flex:1, height:1, background:T.border }} />
              </div>
            );
          }
          return <MessageBubble key={item.id || i} msg={item} currentOperator={operator} />;
        })}
        <div ref={bottomRef} />
      </div>

      {/* Input — SEMPRE disponível, nunca bloqueado */}
      <div style={{ padding:"10px 14px", borderTop:`1px solid ${T.border}`,
        background:T.header, display:"flex", gap:8, alignItems:"flex-end", flexShrink:0 }}>
        <div style={{ flex:1, position:"relative" }}>
          <div style={{ position:"absolute", top:-18, left:2,
            fontSize:10, color:T.accent, fontWeight:600 }}>
            {operator.name}:
          </div>
          <textarea value={text} onChange={e => setText(e.target.value)}
            onKeyDown={e => {
              if (e.key==="Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
            }}
            placeholder="Enter para enviar · Shift+Enter para nova linha"
            rows={2} style={{ width:"100%", background:T.inputBg,
              border:`1px solid ${T.border}`, borderRadius:8,
              padding:"10px 12px", color:T.text, fontSize:13,
              outline:"none", resize:"none", boxSizing:"border-box",
              transition:"border-color .15s" }}
            onFocus={e => e.target.style.borderColor=T.accent}
            onBlur={e => e.target.style.borderColor=T.border} />
        </div>
        <button onClick={handleSend} disabled={sending || !text.trim()} style={{
          background:(sending||!text.trim()) ? "#333" : T.accent,
          border:"none", borderRadius:8, width:42, height:42, color:"#fff",
          fontSize:18, cursor:sending?"not-allowed":"pointer", flexShrink:0,
          display:"flex", alignItems:"center", justifyContent:"center",
          transition:"background .15s" }}>
          {sending ? "…" : "↑"}
        </button>
      </div>
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
    <div style={{ display:"flex", justifyContent:isPatient?"flex-start":"flex-end", marginBottom:2 }}>
      <div style={{ maxWidth:"70%" }}>
        {!isPatient && (
          <div style={{ fontSize:10, fontWeight:700, marginBottom:2, textAlign:"right",
            color:isBot?"#9c7cd4":T.accent }}>
            {msg.operator || "Operador"}
          </div>
        )}
        <div style={{
          background: isBot ? T.bubbleBot : isMe ? T.bubbleMe : T.bubblePat,
          border:`1px solid ${isBot ? T.borderBot : isMe ? T.borderMe : "#383838"}`,
          borderRadius: isPatient ? "2px 12px 12px 12px" : "12px 2px 12px 12px",
          padding:"8px 12px",
          boxShadow:"0 1px 3px rgba(0,0,0,.3)" }}>
          <div style={{ color:T.text, fontSize:13, lineHeight:1.55, whiteSpace:"pre-wrap" }}>
            {msg.text}
          </div>
          <div style={{ color:T.sub, fontSize:10, marginTop:4, textAlign:"right" }}>
            {dateStr || msg.time}
          </div>
        </div>
      </div>
    </div>
  );
}