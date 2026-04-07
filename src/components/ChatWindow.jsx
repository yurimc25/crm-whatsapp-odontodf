import { useState, useRef, useEffect, useCallback } from "react";
import PatientCardDetected from "./modules/PatientCardDetected";
import { QuickMessages } from "./modules/QuickMessages";
import { useContactsCtx } from "../App";
import { normalizeMessage } from "../services/waha";
import { ContactLookupModal } from "./ContactLookupModal";

// Renderiza formatação WhatsApp: *negrito* _itálico_ ~riscado~
function renderText(text) {
  if (!text) return null;
  // Divide em segmentos preservando os marcadores
  const parts = [];
  const re = /(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~)/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ t: "plain", v: text.slice(last, m.index) });
    const raw = m[0];
    if (raw.startsWith("*"))      parts.push({ t: "bold",   v: raw.slice(1, -1) });
    else if (raw.startsWith("_")) parts.push({ t: "italic", v: raw.slice(1, -1) });
    else if (raw.startsWith("~")) parts.push({ t: "strike", v: raw.slice(1, -1) });
    last = m.index + raw.length;
  }
  if (last < text.length) parts.push({ t: "plain", v: text.slice(last) });
  return parts.map((p, i) => {
    if (p.t === "bold")   return <strong key={i} style={{ fontWeight:700 }}>{p.v}</strong>;
    if (p.t === "italic") return <em key={i} style={{ fontStyle:"italic" }}>{p.v}</em>;
    if (p.t === "strike") return <s key={i}>{p.v}</s>;
    return <span key={i}>{p.v}</span>;
  });
}
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
  const [showQuick, setShowQuick]     = useState(false);
  const [quickQuery, setQuickQuery]   = useState("");
  const [showContactLookup, setShowContactLookup] = useState(false);
  const [confirmMsg, setConfirmMsg]   = useState(null);
  // Auto-refresh a cada 5s
  const [lastRefresh, setLastRefresh] = useState(Date.now());

  const bottomRef   = useRef(null);
  const scrollRef   = useRef(null);
  const prevScrollH = useRef(0);
  const { displayInfo, addLocalContact } = useContactsCtx();
  const info = displayInfo(chat.id, chat.name, chat.pushname);

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
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 300;
    if (nearBottom) bottomRef.current?.scrollIntoView({ behavior:"instant" });
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
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

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
          <div style={{ display:"flex", alignItems:"center", gap:6 }}>
            <div style={{ color:T.sub, fontSize:11, fontFamily:"'DM Mono', monospace" }}>
              {info.hasContact ? info.phone : "Número desconhecido"}
            </div>
            <button onClick={() => setShowContactLookup(true)} title="Buscar/atualizar contato no Google"
              style={{
                background:"transparent", border:"none", cursor:"pointer",
                color:T.sub, padding:"0 4px", fontSize:10,
                transition:"color .15s", display:"flex", alignItems:"center"
              }}
              onMouseEnter={e => e.currentTarget.style.color = T.accent}
              onMouseLeave={e => e.currentTarget.style.color = T.sub}>
              🔍
            </button>
          </div>
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
          <div style={{ textAlign:"center", padding:"12px 0", display:"flex",
            alignItems:"center", justifyContent:"center", gap:8, color:T.sub, fontSize:12 }}>
            <div style={{
              width:14, height:14, borderRadius:"50%",
              border:`2px solid ${T.border}`,
              borderTopColor: T.accent,
              animation:"spin 0.8s linear infinite",
            }} />
            Carregando mensagens anteriores...
          </div>
        )}
        {!loadingMore && !hasMore && messages.length > 0 && (
          <div style={{ textAlign:"center", padding:"8px 0 4px",
            color:"#444", fontSize:11, fontStyle:"italic",
            borderBottom:`1px solid ${T.border}22`, marginBottom:8 }}>
            Não foi possível localizar mensagens mais antigas
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

      {/* Input com menu de mensagens rápidas */}
      <div style={{ padding:"10px 14px", borderTop:`1px solid ${T.border}`,
        background:T.header, display:"flex", gap:8, alignItems:"flex-end",
        flexShrink:0, position:"relative" }}>

        {/* Menu de mensagens rápidas */}
        {showQuick && (
          <QuickMessages
            query={quickQuery}
            onSelect={msg => {
              setText(msg);
              setShowQuick(false);
              setQuickQuery("");
            }}
            onClose={() => { setShowQuick(false); setQuickQuery(""); }} />
        )}

        <div style={{ flex:1, position:"relative" }}>
          <div style={{ position:"absolute", top:-18, left:2,
            fontSize:10, color:T.accent, fontWeight:600 }}>
            {operator.name}:
          </div>
          <textarea value={text}
            onChange={e => {
              const v = e.target.value;
              setText(v);
              // Abre menu se começa com /
              if (v.startsWith("/")) {
                setShowQuick(true);
                setQuickQuery(v.slice(1));
              } else {
                setShowQuick(false);
                setQuickQuery("");
              }
            }}
            onKeyDown={e => {
              if (showQuick && (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "Enter")) return;
              if (e.key === "Escape" && showQuick) { setShowQuick(false); setQuickQuery(""); return; }
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
            }}
            placeholder="/ para mensagens rápidas · Enter para enviar · Shift+Enter nova linha"
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

      {/* Modal de busca de contatos */}
      {showContactLookup && (
        <ContactLookupModal
          phoneNumber={info.phone}
          chatId={chat.id}
          onClose={() => setShowContactLookup(false)}
          onSelectContact={(name) => {
            addLocalContact({ phone: info.phone, name });
            setShowContactLookup(false);
            setConfirmMsg(`✓ Contato atualizado: ${name}`);
            setTimeout(() => setConfirmMsg(null), 3000);
          }}
        />
      )}

      {/* Mensagem de confirmação */}
      {confirmMsg && (
        <div style={{
          position: "fixed", bottom: 20, right: 20, zIndex: 999,
          background: T.green,
          color: "#fff",
          padding: "12px 16px",
          borderRadius: 8,
          fontSize: 13,
          fontWeight: 600,
          boxShadow: "0 4px 12px rgba(76, 175, 135, 0.4)",
          animation: "slideIn 0.3s ease",
        }}>
          {confirmMsg}
        </div>
      )}

      <style>{`
        @keyframes slideIn {
          from { transform: translateX(400px); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
      `}</style>
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
      <div style={{ maxWidth:"75%" }}>
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
          padding: msg.media ? "4px" : "8px 12px",
          overflow:"hidden",
          boxShadow:"0 1px 3px rgba(0,0,0,.3)" }}>

          {/* Mídia */}
          {msg.media && (
            <MediaContent
              media={msg.media}
              msgId={msg.media.msgId || msg.id}
              chatId={msg.chatId}
              chatSession={import.meta.env.VITE_WAHA_SESSION || "default"}
            />
          )}

          {/* Texto da legenda ou mensagem normal */}
          {msg.text && (
            <div style={{ color:T.text, fontSize:13, lineHeight:1.55, whiteSpace:"pre-wrap",
              padding: msg.media ? "6px 8px 2px" : 0 }}>
              {renderText(msg.text)}
            </div>
          )}
          <div style={{ color:T.sub, fontSize:10, marginTop:4, textAlign:"right",
            padding: msg.media ? "0 8px 4px" : 0 }}>
            {dateStr || msg.time}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Renderizador de mídia ──────────────────────────────────────────
function MediaContent({ media, msgId, chatId, chatSession }) {
  const [lightbox,    setLightbox]  = useState(false);
  const [fullUrl,     setFullUrl]   = useState(null);
  const [downloading, setDownload]  = useState(false);
  const [error,       setError]     = useState(false);
  const iKey    = import.meta.env.VITE_INTERNAL_API_KEY || "@Deuse10";
  const SESSION = chatSession || import.meta.env.VITE_WAHA_SESSION || "default";

  // msgId vem como ID curto: "3A1C485A49F42B436809"
  // chatId: "556198141141@c.us" (o sender)
  const cleanMsgId   = msgId ? encodeURIComponent(String(msgId)) : null;
  const cleanChatId  = chatId ? encodeURIComponent(String(chatId)) : null;
  
  // Endpoint principal: /chats/{chatId}/messages/{msgId}?downloadMedia=true (recomendado pelo WAHA)
  const downloadPath = (cleanMsgId && cleanChatId)
    ? `/api/waha?path=/api/${SESSION}/chats/${cleanChatId}/messages/${cleanMsgId}&downloadMedia=true`
    : null;
  
  // Endpoint fallback: /messages/{msgId}/download-media (ID curto pode não funcionar aqui)
  const fallbackDownloadPath = cleanMsgId
    ? `/api/waha?path=/api/${SESSION}/messages/${cleanMsgId}/download-media`
    : null;

  // Se o WAHA já serviu a mídia via media.url, prefira essa URL
  // (WAHA retorna "media.url": "http://localhost:3000/api/files/...")
  const proxiedUrl = media.url || null;
  const urlToFetch = proxiedUrl || downloadPath;  // downloadPath é o principal

  const isImage = media.type === "image" || media.type === "sticker" ||
                  (media.mimetype || "").startsWith("image/");
  const isVideo = media.type === "video" || (media.mimetype || "").startsWith("video/");
  const isAudio = media.type === "audio" || media.type === "voice" ||
                  (media.mimetype || "").startsWith("audio/");

  // Mimetype correto — NOWEB às vezes não traz
  const mimeHint = media.mimetype ||
    (isImage ? "image/jpeg" : isVideo ? "video/mp4" : isAudio ? "audio/ogg" : "application/octet-stream");

  const thumbSrc = media.thumbUrl || null;
  // Debug inicial: mostra quais URLs estarão disponíveis para fetch
  const debugInfo = { 
    media, msgId, chatId, isImage, isVideo, isAudio, mimeHint, thumbSrc,
    mediaUrl: media?.url,
    downloadPath,
    fallbackPath: fallbackDownloadPath,
  };
  console.debug(`[media] init msgId=${msgId} proxiedUrl=${proxiedUrl ? 'yes' : 'no'} downloadPath=${!!downloadPath} fallbackPath=${!!fallbackDownloadPath} urlToFetch=${!!urlToFetch}`, debugInfo);

  // Revoga objectURL ao desmontar
  const blobUrlRef = useRef(null);
  useEffect(() => {
    return () => {
      if (blobUrlRef.current) {
        console.debug(`[media] revoke objectURL for msgId=${msgId}`, blobUrlRef.current);
        URL.revokeObjectURL(blobUrlRef.current);
      }
    };
  }, []);

  // Helper: resolve binary from a WAHA endpoint.
  // O endpoint ?downloadMedia=true retorna JSON com media.url — precisa re-buscar o binário.
  async function resolveMediaBinary(url) {
    const r = await fetch(url, { headers: { "X-Internal-Key": iKey }, cache: "no-store" });
    if (!r.ok) return { ok: false, status: r.status };
    const ct = r.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      const json = await r.json().catch(() => null);
      const mediaUrl = json?.media?.url;
      if (!mediaUrl) return { ok: false, status: 404 };
      console.debug(`[media] JSON response — fetching media.url=${mediaUrl}`);
      const proxied = `/api/waha?path=${encodeURIComponent(mediaUrl)}`;
      const r2 = await fetch(proxied, { headers: { "X-Internal-Key": iKey }, cache: "no-store" });
      if (!r2.ok) return { ok: false, status: r2.status };
      const buf = await r2.arrayBuffer();
      return { ok: true, buf, ct: r2.headers.get("content-type") || mimeHint };
    }
    const buf = await r.arrayBuffer();
    return { ok: true, buf, ct: ct || mimeHint };
  }

  async function fetchMedia() {
    if (fullUrl || !urlToFetch || downloading) return;
    console.debug(`[media] fetch start msgId=${msgId} url=${urlToFetch}`);
    setDownload(true);
    setError(false);
    try {
      let result = await resolveMediaBinary(urlToFetch);
      if (!result.ok && result.status === 404 && fallbackDownloadPath && !proxiedUrl) {
        console.debug(`[media] trying fallback endpoint ${fallbackDownloadPath}`);
        result = await resolveMediaBinary(fallbackDownloadPath).catch(() => ({ ok: false, status: 0 }));
      }
      if (!result.ok) {
        if (result.status === 404) { setDownload(false); return; }
        setError(true); setDownload(false); return;
      }
      if (!result.buf || result.buf.byteLength === 0) { setError(true); setDownload(false); return; }
      const blob = new Blob([result.buf], { type: result.ct });
      const url  = URL.createObjectURL(blob);
      blobUrlRef.current = url;
      console.debug(`[media] objectURL created for msgId=${msgId}`);
      setFullUrl(url);
    } catch (e) {
      console.error("[media] fetch error:", e?.message || e);
      setError(true);
    }
    setDownload(false);
  }

  // Auto-carrega imagem e áudio
  useEffect(() => {
    if (!isImage && !isAudio) return;
    if (!urlToFetch || fullUrl) return;
    let cancelled = false;
    async function autoLoad() {
      console.debug(`[media] autoLoad start msgId=${msgId} url=${urlToFetch}`);
      setDownload(true);
      setError(false);
      try {
        let result = await resolveMediaBinary(urlToFetch);
        if (cancelled) return;
        if (!result.ok && result.status === 404 && fallbackDownloadPath && !proxiedUrl) {
          console.debug(`[media] autoLoad trying fallback endpoint`);
          result = await resolveMediaBinary(fallbackDownloadPath).catch(() => ({ ok: false, status: 0 }));
          if (cancelled) return;
        }
        if (!result.ok) {
          if (result.status === 404) { setDownload(false); return; }
          setError(true); setDownload(false); return;
        }
        if (!result.buf || result.buf.byteLength === 0) { setError(true); setDownload(false); return; }
        const blob = new Blob([result.buf], { type: result.ct });
        const url  = URL.createObjectURL(blob);
        blobUrlRef.current = url;
        console.debug(`[media] autoLoad objectURL created for msgId=${msgId}`);
        if (!cancelled) setFullUrl(url);
      } catch (e) {
        console.error(`[media] autoLoad error for ${msgId}:`, e?.message || e);
        if (!cancelled) setError(true);
      }
      if (!cancelled) setDownload(false);
    }
    autoLoad();
    return () => { cancelled = true; };
  }, [urlToFetch, isImage, isAudio]);

  const displaySrc = fullUrl || thumbSrc;
  useEffect(() => {
    console.debug(`[media] status msgId=${msgId} fullUrl=${!!fullUrl} thumb=${!!thumbSrc} displaySrc=${!!displaySrc} downloading=${downloading} error=${error}`);
  }, [fullUrl, thumbSrc, displaySrc, downloading, error, msgId]);

  // ── Imagem ──────────────────────────────────────────────────
  if (isImage) {
    return (
      <>
        <div style={{ position:"relative", cursor: displaySrc ? "pointer" : "default" }}
          onClick={() => displaySrc && !downloading && setLightbox(true)}>
          {displaySrc ? (
            <img src={displaySrc} alt="imagem"
              style={{ width:"100%", maxWidth:260, maxHeight:200,
                objectFit:"cover", borderRadius:8, display:"block",
                filter: (!fullUrl && thumbSrc) ? "blur(4px)" : "none",
                transition:"filter .4s" }} />
          ) : (
            <div style={{ width:200, height:100, background:"#2a2a2a", borderRadius:8,
              display:"flex", alignItems:"center", justifyContent:"center",
              color:"#555", fontSize:13 }}>
              {thumbSrc ? (
                <img src={thumbSrc} alt="thumb" style={{ width:"100%", height:"100%", objectFit:"cover", filter:"blur(3px)", opacity:.9 }} />
              ) : (downloading ? "⏳ carregando..." : "🖼️")}
            </div>
          )}

          {/* Spinner overlay enquanto baixa */}
          {downloading && (
            <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center" }}>
              <div style={{ width:28, height:28, borderRadius:"50%", border:`4px solid rgba(255,255,255,.12)`, borderTopColor:T.accent, animation:"spin 0.8s linear infinite" }} />
            </div>
          )}

          {/* Overlay de erro (mantém miniatura por baixo) */}
          {error && (
            <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center", flexDirection:"column", gap:8 }}>
              <div style={{ background:"rgba(0,0,0,.6)", padding:"6px 10px", borderRadius:6, color:"#e57373" }}>⚠️ Erro ao carregar</div>
              <button onClick={e => { e.stopPropagation(); setError(false); fetchMedia(); }}
                style={{ fontSize:12, color:T.accent, background:"transparent", border:`1px solid ${T.accent}`, borderRadius:6, padding:"6px 10px", cursor:"pointer" }}>
                Tentar novamente
              </button>
            </div>
          )}

          {fullUrl && (
            <div style={{ position:"absolute", top:6, right:6, background:"rgba(0,0,0,.5)",
              borderRadius:6, padding:"3px 7px", fontSize:11, color:"#fff" }}>🔍</div>
          )}
        </div>
        {lightbox && (
          <ImageLightbox
            src={fullUrl || thumbSrc}
            downloadUrl={media.url || downloadPath}
            iKey={iKey}
            onClose={() => setLightbox(false)} />
        )}
      </>
    );
  }

  // ── Vídeo ───────────────────────────────────────────────────
  if (isVideo) {
    return (
      <div style={{ padding:"4px" }}>
        {fullUrl ? (
          <video controls style={{ width:"100%", maxWidth:280, borderRadius:8 }}>
            <source src={fullUrl} type={mimeHint} />
          </video>
        ) : (
          <div style={{ width:240, height:140, background:"#2a2a2a", borderRadius:8,
            display:"flex", flexDirection:"column", alignItems:"center",
            justifyContent:"center", gap:8, cursor:"pointer", position:"relative",
            overflow:"hidden" }}
            onClick={!error ? fetchMedia : () => { setError(false); fetchMedia(); }}>
            {thumbSrc && <img src={thumbSrc} alt="" style={{ position:"absolute",
              inset:0, width:"100%", height:"100%", objectFit:"cover",
              filter:"blur(3px)", opacity:.4 }} />}

            {/* Spinner overlay enquanto baixa */}
            {downloading && (
              <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center" }}>
                <div style={{ width:36, height:36, borderRadius:"50%", border:`4px solid rgba(255,255,255,.12)`, borderTopColor:T.accent, animation:"spin 0.8s linear infinite" }} />
              </div>
            )}

            <span style={{ fontSize:32, position:"relative" }}>
              {error ? "⚠️" : "▶️"}
            </span>
            <span style={{ color:"#aaa", fontSize:11, position:"relative" }}>
              {downloading ? "baixando..." : error ? "Erro — tente novamente" : "Toque para ver vídeo"}
            </span>

            {/* Overlay de erro (mantém miniatura por baixo) */}
            {error && (
              <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center", flexDirection:"column", gap:8 }}>
                <div style={{ background:"rgba(0,0,0,.6)", padding:"6px 10px", borderRadius:6, color:"#e57373" }}>⚠️ Erro ao carregar</div>
                <button onClick={e => { e.stopPropagation(); setError(false); fetchMedia(); }}
                  style={{ fontSize:12, color:T.accent, background:"transparent", border:`1px solid ${T.accent}`, borderRadius:6, padding:"6px 10px", cursor:"pointer" }}>
                  Tentar novamente
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // ── Áudio ───────────────────────────────────────────────────
  if (isAudio) {
    return (
      <div style={{ padding:"8px 6px", minWidth:220 }}>
        {fullUrl ? (
          <audio controls style={{ width:"100%", minWidth:220 }}>
            <source src={fullUrl} type={mimeHint} />
          </audio>
        ) : error ? (
          <div style={{ display:"flex", alignItems:"center", gap:8, padding:"4px 8px" }}>
            <span style={{ color:"#e57373", fontSize:12 }}>⚠️ Erro ao carregar áudio</span>
            <button onClick={() => { setError(false); fetchMedia(); }}
              style={{ fontSize:10, color:"#d4956a", background:"none",
                border:"1px solid #d4956a", borderRadius:4, padding:"2px 8px", cursor:"pointer" }}>
              Retry
            </button>
          </div>
        ) : (
          <div style={{ color:"#666", fontSize:12, padding:"4px 8px", display:"flex", gap:6 }}>
            🎵 {downloading ? "carregando áudio..." : "áudio"}
          </div>
        )}
      </div>
    );
  }

  // ── Documento ───────────────────────────────────────────────
  const filename = media.filename || "arquivo";
  return (
    <div style={{ padding:"8px 12px", display:"flex", alignItems:"center", gap:10 }}>
      <span style={{ fontSize:24 }}>📎</span>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ color:T.text, fontSize:12, fontWeight:600,
          overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
          {filename}
        </div>
        <div style={{ color:T.sub, fontSize:10 }}>{mimeHint}</div>
      </div>
      {error ? (
        <button onClick={() => { setError(false); fetchMedia(); }}
          style={{ color:"#e57373", fontSize:11, background:"none",
            border:"1px solid #e57373", borderRadius:4, padding:"2px 8px", cursor:"pointer" }}>
          ⚠️ Retry
        </button>
      ) : (
        <button onClick={fetchMedia} disabled={downloading}
          style={{ color:T.accent, fontSize:20, background:"none", border:"none",
            cursor:"pointer", padding:0 }} title="Baixar">
          {downloading ? "⏳" : "⬇"}
        </button>
      )}
    </div>
  );
}

// ── Lightbox de imagem com zoom ───────────────────────────────────
function ImageLightbox({ src, downloadUrl, iKey, onClose }) {
  const [zoom, setZoom] = useState(1);
  const [pos, setPos]   = useState({ x:0, y:0 });
  const [drag, setDrag] = useState(null);

  useEffect(() => {
    const k = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  async function handleDownload() {
    if (!downloadUrl) return;
    console.debug(`[lightbox] download start -> ${downloadUrl}`);
    try {
      const r = await fetch(downloadUrl, { headers: { "X-Internal-Key": iKey || "" } });
      console.debug(`[lightbox] download response status=${r.status}`);
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        console.error(`[lightbox] download failed ${r.status}:`, txt.slice(0, 300));
        return;
      }
      const blob = await r.blob();
      console.debug(`[lightbox] downloaded blob size=${blob.size} type=${blob.type}`);
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href = url; a.download = "imagem"; a.click();
      setTimeout(() => {
        console.debug(`[lightbox] revoke downloaded objectURL`);
        URL.revokeObjectURL(url);
      }, 5000);
    } catch (e) {
      console.error(`[lightbox] download error:`, e?.message || e);
    }
  }

  function onWheel(e) {
    e.preventDefault();
    setZoom(z => Math.min(5, Math.max(1, z - e.deltaY * 0.002)));
  }
  function onMouseDown(e) {
    if (zoom <= 1) return;
    setDrag({ sx: e.clientX - pos.x, sy: e.clientY - pos.y });
  }
  function onMouseMove(e) {
    if (!drag) return;
    setPos({ x: e.clientX - drag.sx, y: e.clientY - drag.sy });
  }
  function onMouseUp() { setDrag(null); }

  return (
    <div onClick={onClose} style={{
      position:"fixed", inset:0, background:"rgba(0,0,0,.92)", zIndex:9999,
      display:"flex", alignItems:"center", justifyContent:"center" }}>
      <div onClick={e => e.stopPropagation()} onWheel={onWheel}
        onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp}
        style={{ position:"relative", cursor: zoom>1 ? (drag?"grabbing":"grab") : "default" }}>
        <img src={src} alt="visualização"
          style={{ maxWidth:"90vw", maxHeight:"85vh", objectFit:"contain",
            transform:`scale(${zoom}) translate(${pos.x/zoom}px, ${pos.y/zoom}px)`,
            transition: drag ? "none" : "transform .15s",
            userSelect:"none", pointerEvents:"none" }} />
      </div>
      {/* Controles */}
      <div style={{ position:"fixed", top:16, right:16, display:"flex", gap:8 }}>
        <button onClick={() => setZoom(z => Math.min(5, z+0.5))} style={btnStyle}>🔍+</button>
        <button onClick={() => { setZoom(1); setPos({x:0,y:0}); }} style={btnStyle}>↺</button>
        <button onClick={() => setZoom(z => Math.max(1, z-0.5))} style={btnStyle}>🔍−</button>
        {downloadUrl && (
          <button onClick={handleDownload} style={btnStyle} title="Baixar">⬇</button>
        )}
        <button onClick={onClose} style={{ ...btnStyle, background:"#c0412c44" }}>✕</button>
      </div>
      <div style={{ position:"fixed", bottom:16, left:"50%", transform:"translateX(-50%)",
        color:"rgba(255,255,255,.4)", fontSize:11 }}>
        Scroll para zoom · Arraste para mover · Esc para fechar
      </div>
    </div>
  );
}

const btnStyle = {
  background:"rgba(255,255,255,.12)", border:"1px solid rgba(255,255,255,.2)",
  borderRadius:8, padding:"6px 10px", color:"#fff", fontSize:14,
  cursor:"pointer", textDecoration:"none", display:"flex", alignItems:"center",
};

// ── Lightbox para arquivos do Codental (imagem ou PDF) ─────────────
export function FileLightbox({ file, onClose }) {
  const [zoom, setZoom] = useState(1);
  const [pos, setPos]   = useState({ x:0, y:0 });
  const [drag, setDrag] = useState(null);
  const isPdf = /\.pdf/i.test(file.name || "") || (file.content_type || "").includes("pdf");
  const src   = file.url || file.preview_url || file.download_url;

  useEffect(() => {
    const k = e => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", k); document.body.style.overflow = ""; };
  }, [onClose]);

  function onWheel(e) {
    if (isPdf) return;
    e.preventDefault();
    setZoom(z => Math.min(5, Math.max(0.5, z - e.deltaY * 0.002)));
  }

  return (
    <div onClick={onClose} style={{
      position:"fixed", inset:0, background:"rgba(0,0,0,.95)", zIndex:9999,
      display:"flex", flexDirection:"column" }}>

      {/* Barra superior */}
      <div onClick={e => e.stopPropagation()} style={{
        display:"flex", alignItems:"center", justifyContent:"space-between",
        padding:"10px 16px", background:"rgba(0,0,0,.6)", flexShrink:0, gap:8 }}>
        <span style={{ color:"#ccc", fontSize:12, overflow:"hidden",
          textOverflow:"ellipsis", whiteSpace:"nowrap", flex:1 }}>
          {file.name || "Arquivo"}
        </span>
        <div style={{ display:"flex", gap:6, flexShrink:0 }}>
          {!isPdf && <>
            <button onClick={() => setZoom(z => Math.min(5, z+0.5))} style={btnStyle}>🔍+</button>
            <button onClick={() => { setZoom(1); setPos({x:0,y:0}); }} style={btnStyle}>1:1</button>
            <button onClick={() => setZoom(z => Math.max(0.5, z-0.5))} style={btnStyle}>🔍−</button>
          </>}
          {(file.url || file.download_url) && (
            <a href={file.download_url || file.url} download={file.name} target="_blank"
              rel="noreferrer" style={btnStyle}>⬇ Baixar</a>
          )}
          <button onClick={onClose} style={{ ...btnStyle, background:"#c0412c44" }}>✕</button>
        </div>
      </div>

      {/* Conteúdo */}
      <div onClick={e => e.stopPropagation()} style={{ flex:1, overflow:"hidden",
        display:"flex", alignItems:"center", justifyContent:"center" }}>
        {isPdf ? (
          <iframe src={src} title={file.name}
            style={{ width:"100%", height:"100%", border:"none", background:"#fff" }} />
        ) : (
          <div onWheel={onWheel}
            onMouseDown={e => { if (zoom>1) setDrag({sx:e.clientX-pos.x,sy:e.clientY-pos.y}); }}
            onMouseMove={e => { if (drag) setPos({x:e.clientX-drag.sx, y:e.clientY-drag.sy}); }}
            onMouseUp={() => setDrag(null)}
            style={{ overflow:"hidden", width:"100%", height:"100%",
              display:"flex", alignItems:"center", justifyContent:"center",
              cursor: zoom>1?(drag?"grabbing":"grab"):"default" }}>
            <img src={src} alt={file.name}
              style={{ maxWidth:"92vw", maxHeight:"88vh", objectFit:"contain",
                transform:`scale(${zoom}) translate(${pos.x/zoom}px,${pos.y/zoom}px)`,
                transition: drag?"none":"transform .15s",
                userSelect:"none", pointerEvents:"none" }} />
          </div>
        )}
      </div>
    </div>
  );
}