import { useState, useRef, useEffect, useCallback } from "react";
import PatientCardDetected from "./modules/PatientCardDetected";
import { QuickMessages } from "./modules/QuickMessages";
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
  const [showQuick, setShowQuick]     = useState(false);
  const [quickQuery, setQuickQuery]   = useState("");
  // Auto-refresh a cada 5s
  const [lastRefresh, setLastRefresh] = useState(Date.now());

  const bottomRef   = useRef(null);
  const scrollRef   = useRef(null);
  const prevScrollH = useRef(0);
  const { displayInfo } = useContactsCtx();
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
              chatSession={import.meta.env.VITE_WAHA_SESSION || "default"}
            />
          )}

          {/* Texto da legenda ou mensagem normal */}
          {msg.text && (
            <div style={{ color:T.text, fontSize:13, lineHeight:1.55, whiteSpace:"pre-wrap",
              padding: msg.media ? "6px 8px 2px" : 0 }}>
              {msg.text}
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
function MediaContent({ media, msgId, chatSession }) {
  const [lightbox, setLightbox]    = useState(false);
  const [fullUrl, setFullUrl]      = useState(null);
  const [downloading, setDownload] = useState(false);
  const iKey    = import.meta.env.VITE_INTERNAL_API_KEY || "";
  const SESSION = chatSession || import.meta.env.VITE_WAHA_SESSION || "default";

  const downloadPath = msgId
    ? `/api/waha?path=/api/${SESSION}/messages/${encodeURIComponent(msgId)}/download-media`
    : null;

  const isImage = media.type === "image" || media.type === "sticker" ||
                  (media.mimetype || "").startsWith("image/");
  const isVideo = media.type === "video" || (media.mimetype || "").startsWith("video/");
  const isAudio = media.type === "audio" || media.type === "voice" ||
                  (media.mimetype || "").startsWith("audio/");

  // thumb base64 que o WAHA já retorna no normalizeMessage
  const thumbSrc = media.thumbUrl || null;

  // Auto-carrega a mídia real ao montar (sem precisar clicar)
  useEffect(() => {
    if (!downloadPath || fullUrl) return;
    let cancelled = false;
    async function load() {
      setDownload(true);
      try {
        const r = await fetch(downloadPath, { headers: { "X-Internal-Key": iKey } });
        if (!cancelled && r.ok) {
          const blob = await r.blob();
          if (!cancelled) setFullUrl(URL.createObjectURL(blob));
        }
      } catch {}
      if (!cancelled) setDownload(false);
    }
    load();
    return () => { cancelled = true; };
  }, [downloadPath]);

  const displaySrc = fullUrl || thumbSrc;

  if (isImage) {
    return (
      <>
        <div style={{ position:"relative", cursor:"pointer" }}
          onClick={() => displaySrc && setLightbox(true)}>
          {displaySrc ? (
            <img src={displaySrc} alt="imagem"
              style={{ width:"100%", maxWidth:260, maxHeight:200,
                objectFit:"cover", borderRadius:8, display:"block",
                filter: (!fullUrl && thumbSrc) ? "blur(3px)" : "none",
                transition:"filter .4s" }} />
          ) : (
            <div style={{ width:200, height:130, background:"#2a2a2a", borderRadius:8,
              display:"flex", alignItems:"center", justifyContent:"center",
              color:T.sub, fontSize:13, gap:6 }}>
              {downloading ? "⏳ carregando..." : "🖼️ imagem"}
            </div>
          )}
          {displaySrc && (
            <div style={{ position:"absolute", top:6, right:6, background:"rgba(0,0,0,.5)",
              borderRadius:6, padding:"3px 7px", fontSize:11, color:"#fff" }}>
              {!fullUrl && downloading ? "⏳" : "🔍"}
            </div>
          )}
        </div>
        {lightbox && (
          <ImageLightbox
            src={fullUrl || thumbSrc}
            downloadUrl={downloadPath}
            iKey={iKey}
            onClose={() => setLightbox(false)} />
        )}
      </>
    );
  }

  if (isVideo) {
    return (
      <div style={{ padding:"4px" }}>
        {fullUrl ? (
          <video controls style={{ width:"100%", maxWidth:280, borderRadius:8 }}>
            <source src={fullUrl} type={media.mimetype || "video/mp4"} />
          </video>
        ) : (
          <div style={{ width:240, height:140, background:"#2a2a2a", borderRadius:8,
            display:"flex", flexDirection:"column", alignItems:"center",
            justifyContent:"center", gap:8, cursor:"pointer" }}
            onClick={fetchMedia}>
            {thumbSrc && <img src={thumbSrc} alt="" style={{ position:"absolute",
              width:"100%", height:"100%", objectFit:"cover", borderRadius:8,
              filter:"blur(3px)", opacity:.5 }} />}
            <span style={{ fontSize:28, position:"relative" }}>▶️</span>
            <span style={{ color:T.sub, fontSize:11, position:"relative" }}>
              {downloading ? "baixando..." : "Toque para ver vídeo"}
            </span>
          </div>
        )}
      </div>
    );
  }

  if (isAudio) {
    if (!fullUrl && !downloading) fetchMedia();
    return (
      <div style={{ padding:"8px 6px", minWidth:220 }}>
        {fullUrl ? (
          <audio controls style={{ width:"100%", minWidth:220 }}>
            <source src={fullUrl} type={media.mimetype || "audio/ogg"} />
          </audio>
        ) : (
          <div style={{ color:T.sub, fontSize:12, padding:"4px 8px" }}>
            {downloading ? "🎵 carregando áudio..." : "🎵 áudio"}
          </div>
        )}
      </div>
    );
  }

  // Documento / arquivo genérico
  const filename = media.filename || "arquivo";
  return (
    <div style={{ padding:"8px 12px", display:"flex", alignItems:"center", gap:10 }}>
      <span style={{ fontSize:24 }}>📎</span>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ color:T.text, fontSize:12, fontWeight:600,
          overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
          {filename}
        </div>
        <div style={{ color:T.sub, fontSize:10 }}>{media.mimetype || "documento"}</div>
      </div>
      <button onClick={fetchMedia} disabled={downloading}
        style={{ color:T.accent, fontSize:20, background:"none", border:"none",
          cursor:"pointer", padding:0 }} title="Baixar">
        {downloading ? "⏳" : "⬇"}
      </button>
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
    try {
      const r = await fetch(downloadUrl, { headers: { "X-Internal-Key": iKey || "" } });
      if (!r.ok) return;
      const blob = await r.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href = url; a.download = "imagem"; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch {}
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