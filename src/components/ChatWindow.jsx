import { useState, useRef, useEffect, useCallback } from "react";
import { fetchAndCachePhoto, readPhotoCache } from "./ChatList";
import PatientCardDetected from "./modules/PatientCardDetected";
import { QuickMessages } from "./modules/QuickMessages";
import { useContactsCtx } from "../App";
import { sendImage, sendFile, sendVideo, sendVoice, uploadToR2, sendReaction, sendLocation } from "../services/waha";
import { ContactLookupModal } from "./ContactLookupModal";

// Emojis frequentes para o picker rápido
const EMOJI_LIST = [
  "😊","😂","🥰","😍","🤩","😎","🙏","👍","❤️","🎉",
  "✅","⚡","🔥","💯","🤔","😅","😭","😢","🙌","💪",
  "👋","✨","🌟","💙","💚","💛","🧡","❤️‍🔥","🫂","😁",
  "😆","🤣","😇","😴","🤒","🦷","💊","📋","📅","⏰",
];

// Detecta URLs em texto
function extractUrls(text) {
  if (!text) return [];
  const re = /https?:\/\/[^\s"'<>]+/g;
  return [...text.matchAll(re)].map(m => m[0]);
}

// Fila global para downloads de mídia — evita sobrecarregar o WAHA com
// muitas requests simultâneas quando o chat tem muitas imagens/áudios.
// Processa 3 por vez com intervalo de 300ms entre cada requisição.
const MEDIA_CONCURRENCY = 3;
const MEDIA_QUEUE_DELAY = 300; // ms entre each media load in queue
let _mediaActive = 0;
let _mediaLastExecTime = 0;
const _mediaQueue = [];
function _runMediaQueue() {
  while (_mediaActive < MEDIA_CONCURRENCY && _mediaQueue.length > 0) {
    _mediaActive++;
    const now = Date.now();
    const timeSinceLastExec = now - _mediaLastExecTime;
    const delayNeeded = Math.max(0, MEDIA_QUEUE_DELAY - timeSinceLastExec);
    const task = _mediaQueue.shift();
    if (typeof task !== "function") { _mediaActive--; continue; }
    if (delayNeeded > 0) {
      setTimeout(() => { _mediaLastExecTime = Date.now(); task(); }, delayNeeded);
    } else {
      _mediaLastExecTime = now;
      task();
    }
  }
}
function mediaQueue(fn) {
  return new Promise((resolve, reject) => {
    _mediaQueue.push(async () => {
      try { resolve(await fn()); }
      catch (e) { reject(e); }
      finally { _mediaActive--; _runMediaQueue(); }
    });
    _runMediaQueue();
  });
}

// Cache de mídias — dois níveis:
// 1. _mediaBlobCache: Map em memória (sobrevive remounts, zero latência)
// 2. localStorage: flag de sucesso/falha permanente (sobrevive F5)
const MEDIA_CACHE_PREFIX = "crm_media_";
const MEDIA_CACHE_TTL    = 7 * 24 * 60 * 60 * 1000; // 7 dias
const MEDIA_FAIL_TTL     = 24 * 60 * 60 * 1000;      // 24h para não re-tentar 404

// Nível 1: blob URLs vivos (process-scoped, não precisam de fetch)
const _mediaBlobCache = new Map(); // msgId → blobUrl

function getMediaBlobInMemory(msgId)       { return _mediaBlobCache.get(msgId) || null; }
function setMediaBlobInMemory(msgId, url)  { _mediaBlobCache.set(msgId, url); }

// Nível 2: base64 no localStorage (imagens ≤ 300KB — sobrevive F5)
const MEDIA_B64_MAX = 300 * 1024; // 300KB em bytes antes de base64
function getMediaFromStorage(msgId) {
  try {
    const raw = localStorage.getItem(MEDIA_CACHE_PREFIX + msgId);
    if (!raw) return null;
    const { data, expires } = JSON.parse(raw);
    if (Date.now() > expires) { localStorage.removeItem(MEDIA_CACHE_PREFIX + msgId); return null; }
    return data || null; // data-uri
  } catch { return null; }
}
function saveMediaToStorage(msgId, dataUri, byteLength) {
  if (byteLength > MEDIA_B64_MAX) return; // não salva arquivos grandes
  try {
    localStorage.setItem(MEDIA_CACHE_PREFIX + msgId, JSON.stringify({
      data: dataUri, expires: Date.now() + MEDIA_CACHE_TTL,
    }));
  } catch {} // quota exceeded — ignora silenciosamente
}
function isMediaCached(msgId) {
  return getMediaFromStorage(msgId) !== null;
}

// Falha permanente: 404 → não re-tenta por 24h
function isMediaFailed(msgId) {
  try {
    const raw = localStorage.getItem(MEDIA_CACHE_PREFIX + msgId + "_fail");
    if (!raw) return false;
    const { expires } = JSON.parse(raw);
    if (Date.now() > expires) { localStorage.removeItem(MEDIA_CACHE_PREFIX + msgId + "_fail"); return false; }
    return true;
  } catch { return false; }
}
function markMediaFailed(msgId) {
  try {
    localStorage.setItem(MEDIA_CACHE_PREFIX + msgId + "_fail", JSON.stringify({
      expires: Date.now() + MEDIA_FAIL_TTL,
    }));
  } catch {}
}

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
  onDeleteMsg, onEditMsg,
  canForwardToAdmin, onLoadOlder, onSyncMedia
}) {
  const [text, setText]               = useState("");
  const [sending, setSending]         = useState(false);
  const [showForward, setShowForward] = useState(false);
  const [syncingMedia, setSyncingMedia] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore]         = useState(true);
  const [oldestDate, setOldestDate]   = useState(null);
  const [showQuick, setShowQuick]     = useState(false);
  const [quickQuery, setQuickQuery]   = useState("");
  const [showContactLookup, setShowContactLookup] = useState(false);
  const [confirmMsg, setConfirmMsg]   = useState(null);
  // Reply / edit
  const [replyTo, setReplyTo]         = useState(null); // { id, text, from }
  const [editingId, setEditingId]     = useState(null);
  // Message context menu
  const [msgCtxMenu, setMsgCtxMenu]   = useState(null); // { msg, x, y }
  // Emoji picker
  const [showEmoji, setShowEmoji]     = useState(false);
  // Voice recording
  const [recording, setRecording]     = useState(false);
  const [recSeconds, setRecSeconds]   = useState(0);
  const mediaRecRef   = useRef(null);
  const recChunksRef  = useRef([]);
  const recTimerRef   = useRef(null);
  const fileInputRef  = useRef(null);
  // Mensagens sintéticas (PatientCards/transcrições) — persistidas no localStorage por chatId
  const EXTRA_KEY = `crm_extra_${chat.id}`;
  const [extraMessages, setExtraMessages] = useState(() => {
    try { return JSON.parse(localStorage.getItem(EXTRA_KEY) || "[]"); } catch { return []; }
  });

  function persistExtra(msgs) {
    const data = JSON.stringify(msgs);
    try {
      localStorage.setItem(EXTRA_KEY, data);
    } catch {
      // Quota exceeded — libera espaço removendo caches menos críticos e tenta de novo
      try {
        const KEEP = new Set([EXTRA_KEY]);
        // Remove fotos e chats antigos (podem ser MB de dados)
        Object.keys(localStorage)
          .filter(k => k.startsWith("waha_photos") || k.startsWith("crm_chats"))
          .forEach(k => { if (!KEEP.has(k)) try { localStorage.removeItem(k); } catch {} });
        localStorage.setItem(EXTRA_KEY, data);
      } catch (e2) {
        console.error("[extra] quota ainda excedida após limpeza:", e2);
      }
    }
  }

  function addExtraMessage(msg) {
    setExtraMessages(prev => {
      const next = [...prev, msg];
      persistExtra(next);
      return next;
    });
  }

  // Recarrega extras quando muda de chat
  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(`crm_extra_${chat.id}`) || "[]");
      setExtraMessages(stored);
    } catch { setExtraMessages([]); }
  }, [chat.id]);

  // Auto-refresh a cada 5s
  const [lastRefresh, setLastRefresh] = useState(Date.now());

  function handleOcrResult(text, afterMsgId) {
    addExtraMessage({
      id:          `ocr-${Date.now()}`,
      hasPatientCard: true,
      text,
      from:        "operator",
      time:        new Date().toLocaleTimeString("pt-BR", { hour:"2-digit", minute:"2-digit" }),
      ts:          new Date().toISOString(),
      afterMsgId:  afterMsgId || null,
    });
  }

  const bottomRef        = useRef(null);
  const scrollRef        = useRef(null);
  const prevScrollH      = useRef(0);
  const scrollToChatId   = useRef(null);
  const initialLoadDone  = useRef(false); // bloqueia loadOlderNow até chat renderizar
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const { displayInfo, addLocalContact, removeContact, lidPhoneMap } = useContactsCtx();
  const info = displayInfo(chat.id, chat.name, chat.pushname);
  const [photoUrl, setPhotoUrl] = useState(() => readPhotoCache()[chat.id] || chat.photoUrl || null);

  useEffect(() => {
    setPhotoUrl(readPhotoCache()[chat.id] || chat.photoUrl || null);
    fetchAndCachePhoto(chat.id, lidPhoneMap, chat.id).then(url => {
      if (url) setPhotoUrl(url);
    });
  }, [chat.id, lidPhoneMap]);

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
    setShowScrollBtn(false);
    scrollToChatId.current = chat.id;
    initialLoadDone.current = false; // reseta guard de scroll infinito
  }, [chat.id]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !messages?.length) return;

    const scrollToBottom = () => {
      // Duplo rAF: garante que o DOM foi pintado antes de medir/scrollar
      requestAnimationFrame(() => requestAnimationFrame(() => {
        bottomRef.current?.scrollIntoView({ behavior: "instant" });
        initialLoadDone.current = true;
      }));
    };

    // Carga inicial do chat (primeira vez que mensagens chegam)
    if (!initialLoadDone.current) {
      scrollToChatId.current = null;
      scrollToBottom();
      return;
    }

    // Nova mensagem em tempo real ou reload do R2: scrolla só se perto do fundo
    requestAnimationFrame(() => {
      if (!el) return;
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 350;
      if (nearBottom) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    });
  }, [messages]);

  const loadOlderNow = useCallback(async () => {
    if (loadingMore || !hasMore || !onLoadOlder) return;
    setLoadingMore(true);
    prevScrollH.current = scrollRef.current?.scrollHeight || 0;
    const result = await onLoadOlder(chat.id, messages);
    if (result?.hasMore === false) setHasMore(false);
    requestAnimationFrame(() => {
      if (scrollRef.current)
        scrollRef.current.scrollTop += scrollRef.current.scrollHeight - prevScrollH.current;
      setLoadingMore(false);
    });
  }, [loadingMore, hasMore, onLoadOlder, chat.id, messages]);

  const handleScroll = useCallback(async () => {
    const el = scrollRef.current;
    if (!el) return;
    const distBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowScrollBtn(distBottom > 400);
    // Não carrega mensagens mais antigas enquanto carga inicial não terminou
    if (initialLoadDone.current && el.scrollTop <= 80) loadOlderNow();
  }, [loadOlderNow]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener("scroll", handleScroll, { passive:true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);

  // Fecha dropdowns ao clicar fora
  useEffect(() => {
    if (!showForward && !showEmoji && !msgCtxMenu) return;
    const close = () => { setShowForward(false); setShowEmoji(false); setMsgCtxMenu(null); };
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [showForward, showEmoji, msgCtxMenu]);

  // Voice recording helpers
  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      recChunksRef.current = [];
      mr.ondataavailable = e => recChunksRef.current.push(e.data);
      mr.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(recChunksRef.current, { type: "audio/webm" });
        const audioFile = new File([blob], "audio.ogg", { type: "audio/ogg; codecs=opus" });
        setSending(true);
        try {
          const ikey = import.meta.env.VITE_INTERNAL_API_KEY || "@Deuse10";
          const url = await uploadToR2(audioFile, ikey);
          await sendVoice(chat.id, url);
        }
        catch (e) { alert("Erro ao enviar áudio: " + e.message); }
        finally { setSending(false); }
      };
      mr.start();
      mediaRecRef.current = mr;
      setRecording(true);
      setRecSeconds(0);
      recTimerRef.current = setInterval(() => setRecSeconds(s => s + 1), 1000);
    } catch (e) { alert("Microfone não disponível: " + e.message); }
  }

  function stopRecording() {
    clearInterval(recTimerRef.current);
    mediaRecRef.current?.stop();
    setRecording(false);
    setRecSeconds(0);
  }

  async function handleFileAttach(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setSending(true);
    const ikey = import.meta.env.VITE_INTERNAL_API_KEY || "@Deuse10";
    try {
      const url = await uploadToR2(file, ikey);
      const caption = text.trim() || "";
      if (file.type.startsWith("image/")) {
        await sendImage(chat.id, url, caption, file.type, file.name);
      } else if (file.type.startsWith("video/")) {
        await sendVideo(chat.id, url, file.name, caption);
      } else {
        await sendFile(chat.id, url, file.name, file.type, caption);
      }
      setText("");
    } catch (err) { alert("Erro ao enviar arquivo: " + err.message); }
    finally { setSending(false); }
  }

  async function handleSend() {
    if (!text.trim() || sending) return;
    setSending(true);
    try {
      if (editingId) {
        await onEditMsg?.(editingId, text.trim());
        setEditingId(null);
        setText("");
        return;
      }

      // Comando /endereço <nome ou endereço>
      // Geocodifica via Nominatim (OpenStreetMap) e envia localização
      const locMatch = text.trim().match(/^\/endere[çc]o\s+(.+)$/i);
      if (locMatch) {
        const query = locMatch[1].trim();
        const geoR  = await fetch(
          `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`,
          { headers: { "Accept-Language": "pt-BR" } }
        );
        const geoData = await geoR.json();
        if (!geoData?.length) { alert("Endereço não encontrado."); return; }
        const { lat, lon, display_name } = geoData[0];
        await sendLocation(chat.id, parseFloat(lat), parseFloat(lon), display_name);
        setText("");
        return;
      }

      await onSend(text.trim(), replyTo?.id || null);
      setReplyTo(null);
      setText("");
    }
    catch (e) { alert("Erro: " + e.message); }
    finally { setSending(false); }
  }

  const forwardTargets = [
    { label:"Recepção",            value:"recepcao" },
    { label:"Dra. Ana (Dentista)", value:"ana"      },
    ...(canForwardToAdmin ? [{ label:"Administrativo 🔒", value:"admin" }] : []),
  ].filter(t => t.value !== chat.assignedTo);

  // Separadores de dia — insere PatientCards de OCR logo após a imagem que os gerou
  const extraByAnchor = {};
  const extraFloating = [];
  for (const e of extraMessages) {
    if (e.afterMsgId) (extraByAnchor[e.afterMsgId] ||= []).push(e);
    else extraFloating.push(e);
  }
  const msgsWithSeps = [];
  let lastDay = null;
  for (const msg of [...messages, ...extraFloating]) {
    const dk = dayKey(msg.ts);
    if (dk && dk !== lastDay) {
      msgsWithSeps.push({ __sep:true, ts:msg.ts, label:dayLabel(msg.ts) });
      lastDay = dk;
    }
    msgsWithSeps.push(msg);
    for (const extra of (extraByAnchor[msg.id] || [])) {
      msgsWithSeps.push(extra);
    }
  }


  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%", overflow:"hidden",
      background:T.bg, fontFamily:"'DM Sans', sans-serif", position:"relative" }}>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes alertPulse {
          0%, 100% { box-shadow: 0 0 8px rgba(201,168,76,.4); border-color: #c9a84c; }
          50%       { box-shadow: 0 0 20px rgba(201,168,76,.9); border-color: #ffe082; }
        }
      `}</style>

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

        {/* Sincronizar mídias do WAHA para R2 */}
        {onSyncMedia && (
          <button
            onClick={async () => {
              setSyncingMedia(true);
              try { await onSyncMedia(chat.id); } finally { setSyncingMedia(false); }
            }}
            disabled={syncingMedia}
            title="Recarrega mídias direto do WAHA e salva no R2"
            style={{
              background:"transparent", border:`1px solid ${T.border}`,
              borderRadius:6, padding:"5px 10px", color:T.sub, fontSize:11,
              cursor: syncingMedia ? "default" : "pointer", transition:"all .15s",
              opacity: syncingMedia ? 0.6 : 1,
            }}
            onMouseEnter={e => { if (!syncingMedia) { e.currentTarget.style.background=T.hover; e.currentTarget.style.color=T.text; }}}
            onMouseLeave={e => { e.currentTarget.style.background="transparent"; e.currentTarget.style.color=T.sub; }}>
            {syncingMedia ? "⏳ Sincronizando..." : "🔄 Sync mídias"}
          </button>
        )}

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
        {!loadingMore && hasMore && onLoadOlder && messages.length > 0 && (
          <div style={{ textAlign:"center", padding:"8px 0", marginBottom:4 }}>
            <button
              onClick={loadOlderNow}
              style={{
                background:"transparent", border:`1px solid ${T.border}`,
                borderRadius:6, padding:"5px 14px", color:T.sub, fontSize:11,
                cursor:"pointer", transition:"all .15s",
              }}
              onMouseEnter={e => { e.currentTarget.style.background=T.hover; e.currentTarget.style.color=T.text; }}
              onMouseLeave={e => { e.currentTarget.style.background="transparent"; e.currentTarget.style.color=T.sub; }}>
              ⬆ Carregar mensagens mais antigas
            </button>
          </div>
        )}
        {!loadingMore && !hasMore && messages.length > 0 && (
          <div style={{ textAlign:"center", padding:"8px 0 4px",
            color:"#444", fontSize:11, fontStyle:"italic",
            borderBottom:`1px solid ${T.border}22`, marginBottom:8 }}>
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
          return (
            <MessageBubble
              key={item.id || i}
              msg={item}
              currentOperator={operator}
              onOcrResult={handleOcrResult}
              onContextMenu={(e, msg) => {
                e.preventDefault();
                setMsgCtxMenu({ msg, x: e.clientX, y: e.clientY });
              }}
            />
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Botão de seta — aparece quando usuário está longe do fundo */}
      {showScrollBtn && (
        <button
          onClick={() => {
            bottomRef.current?.scrollIntoView({ behavior: "smooth" });
            setShowScrollBtn(false);
          }}
          style={{
            position: "absolute", bottom: 80, right: 20,
            width: 36, height: 36, borderRadius: "50%",
            background: "#2d2d2d", border: "1px solid #444",
            color: "#ccc", fontSize: 18, cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: "0 2px 8px #0006", zIndex: 10,
            transition: "opacity .2s",
          }}
          title="Ir para o final"
        >
          ↓
        </button>
      )}

      {/* Mensagem de contexto do menu */}
      {msgCtxMenu && (
        <MsgContextMenu
          msg={msgCtxMenu.msg}
          x={msgCtxMenu.x} y={msgCtxMenu.y}
          isOwn={msgCtxMenu.msg.from === "operator"}
          onClose={() => setMsgCtxMenu(null)}
          onReply={msg => {
            const mediaLabel = msg.media
              ? (msg.media.type?.includes("image") || msg.media.type?.includes("sticker") ? "📷 Imagem"
                : msg.media.type?.includes("video") ? "🎥 Vídeo"
                : msg.media.type?.includes("audio") || msg.media.type?.includes("voice") ? "🎵 Áudio"
                : "📎 Arquivo")
              : null;
            setReplyTo({
              id: msg.id,
              text: msg.text || mediaLabel || "[mídia]",
              from: msg.from,
              thumbUrl: msg.media?.thumbUrl || null,
              mediaLabel,
            });
            setMsgCtxMenu(null);
          }}
          onEdit={msg => { setEditingId(msg.id); setText(msg.text || ""); setMsgCtxMenu(null); }}
          onDelete={msg => { onDeleteMsg?.(msg.id); setMsgCtxMenu(null); }}
          onReact={async (msg, emoji) => { try { await sendReaction(chat.id, msg.id, emoji); } catch {} setMsgCtxMenu(null); }}
          onForward={msg => { onForward?.("recepcao"); setMsgCtxMenu(null); }}
        />
      )}

      {/* Input com menu de mensagens rápidas */}
      <div style={{ padding:"10px 14px", borderTop:`1px solid ${T.border}`,
        background:T.header, display:"flex", flexDirection:"column",
        gap:6, flexShrink:0, position:"relative" }}>

        {/* Barra de reply */}
        {replyTo && (
          <div style={{ display:"flex", alignItems:"center", gap:8,
            background:"#252525", borderRadius:6, padding:"6px 10px",
            borderLeft:`3px solid ${T.accent}` }}>
            {/* Thumbnail da mídia respondida */}
            {replyTo.thumbUrl && (
              <img src={replyTo.thumbUrl} alt=""
                style={{ width:36, height:36, borderRadius:4, objectFit:"cover", flexShrink:0 }} />
            )}
            {!replyTo.thumbUrl && replyTo.mediaLabel && (
              <span style={{ fontSize:22, flexShrink:0 }}>
                {replyTo.mediaLabel.split(" ")[0]}
              </span>
            )}
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ color:T.accent, fontSize:10, fontWeight:700 }}>
                Respondendo {replyTo.from === "patient" ? "paciente" : ""}
              </div>
              <div style={{ color:T.sub, fontSize:11, overflow:"hidden",
                textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                {replyTo.text}
              </div>
            </div>
            <button onClick={() => setReplyTo(null)}
              style={{ background:"none", border:"none", color:T.sub,
                cursor:"pointer", fontSize:14, padding:"0 4px" }}>✕</button>
          </div>
        )}

        {/* Barra de edição */}
        {editingId && (
          <div style={{ display:"flex", alignItems:"center", gap:8,
            background:"#252535", borderRadius:6, padding:"6px 10px",
            borderLeft:`3px solid #7c7ce8` }}>
            <div style={{ flex:1, color:"#9090d8", fontSize:10, fontWeight:700 }}>Editando mensagem</div>
            <button onClick={() => { setEditingId(null); setText(""); }}
              style={{ background:"none", border:"none", color:T.sub,
                cursor:"pointer", fontSize:14, padding:"0 4px" }}>✕</button>
          </div>
        )}

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

        {/* Emoji picker */}
        {showEmoji && (
          <div onClick={e => e.stopPropagation()} style={{
            position:"absolute", bottom:"calc(100% + 8px)", left:14, zIndex:200,
            background:"#252525", border:`1px solid ${T.border}`, borderRadius:10,
            padding:10, display:"flex", flexWrap:"wrap", gap:4, maxWidth:280,
            boxShadow:"0 8px 24px rgba(0,0,0,.6)"
          }}>
            {EMOJI_LIST.map(em => (
              <button key={em} onClick={() => { setText(t => t + em); setShowEmoji(false); }}
                style={{ background:"none", border:"none", cursor:"pointer",
                  fontSize:20, padding:"2px 4px", borderRadius:4,
                  transition:"background .1s" }}
                onMouseEnter={e => e.currentTarget.style.background="#333"}
                onMouseLeave={e => e.currentTarget.style.background="none"}>
                {em}
              </button>
            ))}
          </div>
        )}

        <div style={{ display:"flex", gap:8, alignItems:"flex-end" }}>
          {/* Botões de ação à esquerda */}
          <div style={{ display:"flex", gap:4, alignItems:"center", flexShrink:0 }}>
            <button onClick={e => { e.stopPropagation(); setShowEmoji(v => !v); }}
              title="Emoji"
              style={{ background:"transparent", border:"none", cursor:"pointer",
                color:T.sub, padding:"6px", fontSize:18, borderRadius:6,
                transition:"color .15s" }}
              onMouseEnter={e => e.currentTarget.style.color=T.accent}
              onMouseLeave={e => e.currentTarget.style.color=T.sub}>
              😊
            </button>
            <button onClick={() => fileInputRef.current?.click()}
              title="Anexar arquivo"
              style={{ background:"transparent", border:"none", cursor:"pointer",
                color:T.sub, padding:"6px", fontSize:18, borderRadius:6,
                transition:"color .15s" }}
              onMouseEnter={e => e.currentTarget.style.color=T.accent}
              onMouseLeave={e => e.currentTarget.style.color=T.sub}>
              📎
            </button>
            <input ref={fileInputRef} type="file" accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx" hidden onChange={handleFileAttach} />
          </div>

          <div style={{ flex:1, position:"relative" }}>
            <div style={{ position:"absolute", top:-18, left:2,
              fontSize:10, color: editingId ? "#9090d8" : T.accent, fontWeight:600 }}>
              {editingId ? "✏️ editando" : operator.name + ":"}
            </div>
            <textarea value={text}
              onChange={e => {
                const v = e.target.value;
                setText(v);
                if (v.startsWith("/")) { setShowQuick(true); setQuickQuery(v.slice(1)); }
                else { setShowQuick(false); setQuickQuery(""); }
              }}
              onKeyDown={e => {
                if (showQuick && (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "Enter")) return;
                if (e.key === "Escape") {
                  if (showQuick) { setShowQuick(false); setQuickQuery(""); return; }
                  if (replyTo) { setReplyTo(null); return; }
                  if (editingId) { setEditingId(null); setText(""); return; }
                }
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
              }}
              placeholder="/ msgs rápidas · /endereço <local> · Enter envia · Shift+Enter nova linha"
              rows={2} style={{ width:"100%", background:T.inputBg,
                border:`1px solid ${editingId ? "#7c7ce8" : T.border}`, borderRadius:8,
                padding:"10px 12px", color:T.text, fontSize:13,
                outline:"none", resize:"none", boxSizing:"border-box",
                transition:"border-color .15s" }}
              onFocus={e => e.target.style.borderColor = editingId ? "#9090d8" : T.accent}
              onBlur={e => e.target.style.borderColor = editingId ? "#7c7ce8" : T.border} />
          </div>

          {/* Botão gravar voz ou enviar texto */}
          {recording ? (
            <button onClick={stopRecording}
              style={{ background:"#e57373", border:"none", borderRadius:8,
                width:42, height:42, color:"#fff", fontSize:16, cursor:"pointer",
                flexShrink:0, display:"flex", flexDirection:"column",
                alignItems:"center", justifyContent:"center", lineHeight:1 }}>
              ⏹
              <span style={{ fontSize:8 }}>{recSeconds}s</span>
            </button>
          ) : text.trim() ? (
            <button onClick={handleSend} disabled={sending} style={{
              background: sending ? "#333" : T.accent,
              border:"none", borderRadius:8, width:42, height:42, color:"#fff",
              fontSize:18, cursor:sending?"not-allowed":"pointer", flexShrink:0,
              display:"flex", alignItems:"center", justifyContent:"center",
              transition:"background .15s" }}>
              {sending ? "…" : "↑"}
            </button>
          ) : (
            <button onClick={startRecording} disabled={sending}
              title="Gravar áudio"
              style={{ background:"transparent", border:`1px solid ${T.border}`,
                borderRadius:8, width:42, height:42, color:T.sub,
                fontSize:18, cursor:"pointer", flexShrink:0,
                display:"flex", alignItems:"center", justifyContent:"center",
                transition:"all .15s" }}
              onMouseEnter={e => { e.currentTarget.style.background=T.hover; e.currentTarget.style.color=T.text; }}
              onMouseLeave={e => { e.currentTarget.style.background="transparent"; e.currentTarget.style.color=T.sub; }}>
              🎙
            </button>
          )}
        </div>
      </div>

      {/* Modal de busca de contatos */}
      {showContactLookup && (
        <ContactLookupModal
          phoneNumber={info.phone}
          chatId={chat.id}
          onClose={() => setShowContactLookup(false)}
          onSelectContact={(contact) => {
            // contact can be a string (legacy) or an object { name, phone, variants }
            let name = null;
            let phone = null;
            if (!contact) return;
            if (typeof contact === "string") {
              name = contact;
              phone = info.phone;
            } else {
              name = contact.name || contact.fullName || contact.title || null;
              phone = contact.phone || info.phone || null;
            }
            if (!name) return;
            const digits = String(phone || "").replace(/\D/g, "");
            // Remove mapeamento antigo do número do chat antes de salvar o novo
            removeContact(info.phone);
            addLocalContact({ phone: digits || info.phone, name });
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

function LocationBubble({ location }) {
  const { latitude, longitude, name, address, thumbnail } = location;
  const mapsUrl = `https://www.google.com/maps?q=${latitude},${longitude}`;
  return (
    <a href={mapsUrl} target="_blank" rel="noopener noreferrer"
      style={{ display:"block", textDecoration:"none", borderRadius:8, overflow:"hidden",
        border:"1px solid #3a4a3a", background:"#1a251a" }}>
      {thumbnail
        ? <img src={thumbnail} alt="mapa" style={{ width:"100%", maxHeight:120, objectFit:"cover", display:"block" }} />
        : <div style={{ width:"100%", height:80, background:"#1e2e1e", display:"flex",
            alignItems:"center", justifyContent:"center", fontSize:28 }}>📍</div>
      }
      <div style={{ padding:"6px 10px" }}>
        {name && <div style={{ color:"#ececec", fontSize:12, fontWeight:600, marginBottom:2 }}>{name}</div>}
        {address && <div style={{ color:"#8e8e8e", fontSize:11 }}>{address}</div>}
        <div style={{ color:"#4caf87", fontSize:10, marginTop:4 }}>
          📍 {latitude}, {longitude} · Abrir no Maps
        </div>
      </div>
    </a>
  );
}

function MessageBubble({ msg, currentOperator, onContextMenu, onOcrResult }) {
  if (msg.hasPatientCard) return <PatientCardDetected msg={msg} />;
  const isPatient  = msg.from === "patient";
  const isBot      = msg.operator?.includes("🤖");
  const isMe       = msg.operator === currentOperator?.name;
  const dateStr    = formatMsgDate(msg.ts);
  // Dentist alert: message from operator starting with !
  const isDentistAlert = !isPatient && msg.text?.trimStart().startsWith("!");
  const alertText  = isDentistAlert ? msg.text.replace(/^!+\s*/, "") : msg.text;
  // Link preview
  const urls = msg.text ? extractUrls(msg.text) : [];

  const { resolveName } = useContactsCtx();
  const isGroupMsg = isPatient && msg.chatId?.endsWith("@g.us");
  // Remetente em grupo: só resolve @c.us no contactMap, nunca tenta converter @lid
  const isSenderCus = msg.senderJid?.endsWith("@c.us") || msg.senderJid?.endsWith("@s.whatsapp.net");
  const senderPhone = isSenderCus ? msg.senderJid.replace(/@.*$/, "") : null;
  const senderLabel = (() => {
    if (!isGroupMsg) return null;
    if (isSenderCus) {
      const contactName = resolveName(msg.senderJid, msg.pushname);
      return contactName || msg.pushname || (senderPhone ? `+${senderPhone}` : null);
    }
    // @lid ou sem senderJid: só pushname
    return msg.pushname || null;
  })();
  const senderSub = isGroupMsg && senderPhone && senderLabel !== `+${senderPhone}`
    ? `+${senderPhone}`
    : null;

  return (
    <div
      onContextMenu={e => onContextMenu?.(e, msg)}
      style={{ display:"flex", justifyContent:isPatient?"flex-start":"flex-end", marginBottom:2 }}>
      <div style={{ maxWidth:"75%" }}>
        {!isPatient && (
          <div style={{ fontSize:10, fontWeight:700, marginBottom:2, textAlign:"right",
            color:isBot?"#9c7cd4":T.accent }}>
            {msg.operator || "Operador"}
          </div>
        )}
        {isGroupMsg && senderLabel && (
          <div style={{ marginBottom:2, textAlign:"left" }}>
            <span style={{ fontSize:10, fontWeight:700, color:T.accent }}>
              {senderLabel}
            </span>
            {senderSub && (
              <span style={{ fontSize:9, color:T.sub, marginLeft:4, fontFamily:"'DM Mono', monospace" }}>
                {senderSub}
              </span>
            )}
          </div>
        )}
        <div style={{
          background: isDentistAlert ? "#2a2200" : isBot ? T.bubbleBot : isMe ? T.bubbleMe : T.bubblePat,
          border: isDentistAlert ? "2px solid #c9a84c" : `1px solid ${isBot ? T.borderBot : isMe ? T.borderMe : "#383838"}`,
          borderRadius: isPatient ? "2px 12px 12px 12px" : "12px 2px 12px 12px",
          padding: msg.media ? "4px" : "8px 12px",
          overflow:"hidden",
          boxShadow: isDentistAlert
            ? "0 0 12px rgba(201,168,76,.5)"
            : "0 1px 3px rgba(0,0,0,.3)",
          animation: isDentistAlert ? "alertPulse 1.4s ease-in-out infinite" : undefined,
        }}>

          {isDentistAlert && (
            <div style={{ fontSize:10, fontWeight:800, color:"#c9a84c",
              marginBottom:4, letterSpacing:.5 }}>
              ⚠️ AVISO DO DENTISTA
            </div>
          )}

          {/* Mensagem apagada */}
          {msg.revoked && (
            <div style={{ color: T.sub, fontSize:13, fontStyle:"italic",
              display:"flex", alignItems:"center", gap:5, opacity:.7 }}>
              <span style={{ fontSize:15 }}>🚫</span>
              <span style={{ textDecoration:"line-through" }}>Mensagem apagada</span>
            </div>
          )}

          {/* Conteúdo normal (oculto quando apagada) */}
          {/* Mensagem citada (reply) */}
          {!msg.revoked && msg.replyTo && (
            <div style={{
              borderLeft: `3px solid ${isPatient ? T.accent : "#aaa"}`,
              background: isPatient ? "rgba(255,255,255,.06)" : "rgba(0,0,0,.15)",
              borderRadius: "0 6px 6px 0",
              padding: "4px 8px",
              margin: msg.media ? "4px 4px 0" : "0 0 6px",
              maxWidth: "100%",
              overflow: "hidden",
            }}>
              {msg.replyTo.hasMedia && !msg.replyTo.body && (
                <span style={{ fontSize:11, color:T.sub }}>
                  {msg.replyTo.media?.type === "image" ? "📷 Imagem"
                   : msg.replyTo.media?.type === "video" ? "🎥 Vídeo"
                   : msg.replyTo.media?.type === "audio" ? "🎵 Áudio"
                   : "📎 Arquivo"}
                </span>
              )}
              {msg.replyTo.body ? (
                <div style={{ fontSize:12, color:T.sub, lineHeight:1.4,
                  whiteSpace:"pre-wrap", overflow:"hidden",
                  display:"-webkit-box", WebkitLineClamp:2,
                  WebkitBoxOrient:"vertical" }}>
                  {msg.replyTo.hasMedia && (
                    <span style={{ marginRight:4 }}>
                      {msg.replyTo.media?.type === "image" ? "📷"
                       : msg.replyTo.media?.type === "video" ? "🎥"
                       : msg.replyTo.media?.type === "audio" ? "🎵"
                       : msg.replyTo.hasMedia ? "📎" : ""}
                    </span>
                  )}
                  {msg.replyTo.body}
                </div>
              ) : null}
            </div>
          )}

          {/* Localização */}
          {!msg.revoked && msg.location && <LocationBubble location={msg.location} />}

          {/* Mídia */}
          {!msg.revoked && msg.media && (
            <MediaContent
              media={msg.media}
              msgId={msg.media.msgId || msg.id}
              r2MsgId={msg.id}
              chatId={msg.chatId}
              chatSession={import.meta.env.VITE_WAHA_SESSION || "default"}
              onOcrResult={text => onOcrResult?.(text, msg.id)}
            />
          )}

          {/* Texto */}
          {!msg.revoked && (isDentistAlert ? alertText : msg.text) && (
            <div style={{ color: isDentistAlert ? "#ffe082" : T.text,
              fontSize:13, lineHeight:1.55, whiteSpace:"pre-wrap",
              fontWeight: isDentistAlert ? 600 : 400,
              padding: msg.media ? "6px 8px 2px" : 0 }}>
              {renderText(isDentistAlert ? alertText : msg.text)}
            </div>
          )}

          {/* Link preview (primeira URL) */}
          {!msg.revoked && urls.length > 0 && !msg.media && (
            <LinkPreview url={urls[0]} />
          )}

          <div style={{ color: isDentistAlert ? "#c9a84c99" : T.sub,
            fontSize:10, marginTop:4, textAlign:"right",
            padding: msg.media ? "0 8px 4px" : 0 }}>
            {msg.edited && <span style={{ marginRight:4, opacity:.7 }}>editado</span>}
            {dateStr || msg.time}
          </div>
        </div>

        {/* Reações */}
        {msg.reactions && Object.keys(msg.reactions).length > 0 && (
          <div style={{ display:"flex", gap:4, marginTop:3, flexWrap:"wrap",
            justifyContent: isPatient ? "flex-start" : "flex-end" }}>
            {Object.entries(msg.reactions).map(([emoji, users]) =>
              users?.length > 0 ? (
                <span key={emoji} style={{
                  background:"#2d2d2d", border:"1px solid #444",
                  borderRadius:12, padding:"1px 6px", fontSize:13,
                  display:"flex", alignItems:"center", gap:3,
                }}>
                  {emoji}
                  {users.length > 1 && <span style={{ fontSize:10, color:T.sub }}>{users.length}</span>}
                </span>
              ) : null
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Link Preview ──────────────────────────────────────────────────
function LinkPreview({ url }) {
  const [meta, setMeta] = useState(null);
  const [tried, setTried] = useState(false);
  useEffect(() => {
    if (tried) return;
    setTried(true);
    // Simple: show the domain and URL without fetching to avoid CORS issues
    try {
      const u = new URL(url);
      setMeta({ domain: u.hostname, url });
    } catch {}
  }, [url, tried]);
  if (!meta) return null;
  return (
    <a href={meta.url} target="_blank" rel="noreferrer"
      onClick={e => e.stopPropagation()}
      style={{ display:"block", marginTop:6, padding:"6px 8px",
        background:"#1a1a1a", borderRadius:6, borderLeft:`3px solid ${T.accent}`,
        textDecoration:"none", overflow:"hidden" }}>
      <div style={{ color:T.sub, fontSize:10 }}>{meta.domain}</div>
      <div style={{ color:T.accent, fontSize:11, overflow:"hidden",
        textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{meta.url}</div>
    </a>
  );
}

// ── Message Context Menu ──────────────────────────────────────────
const REACTION_EMOJIS = ["👍","❤️","😂","😮","😢","🙏"];
function MsgContextMenu({ msg, x, y, isOwn, onClose, onReply, onEdit, onDelete, onReact, onForward }) {
  const menuRef = useRef(null);
  useEffect(() => {
    if (!menuRef.current) return;
    const el = menuRef.current;
    const rect = el.getBoundingClientRect();
    if (rect.right  > window.innerWidth)  el.style.left = `${x - rect.width}px`;
    if (rect.bottom > window.innerHeight) el.style.top  = `${y - rect.height}px`;
  }, [x, y]);

  useEffect(() => {
    const onKey = e => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const menuItem = (label, action, color) => (
    <div key={label}
      onClick={e => { e.stopPropagation(); action(); }}
      style={{ padding:"9px 16px", cursor:"pointer", color: color || "#ececec",
        fontSize:13, transition:"background .1s", userSelect:"none" }}
      onMouseEnter={e => e.currentTarget.style.background="#2a2a2a"}
      onMouseLeave={e => e.currentTarget.style.background="transparent"}>
      {label}
    </div>
  );

  return (
    <div ref={menuRef} onClick={e => e.stopPropagation()} style={{
      position:"fixed", left:x, top:y, zIndex:9999,
      background:"#252525", border:`1px solid #333`,
      borderRadius:10, minWidth:200, overflow:"hidden",
      boxShadow:"0 8px 32px rgba(0,0,0,.7)"
    }}>
      {/* Reações rápidas */}
      <div style={{ display:"flex", gap:2, padding:"8px 10px 6px",
        borderBottom:"1px solid #333" }}>
        {REACTION_EMOJIS.map(em => (
          <button key={em} onClick={() => onReact(msg, em)}
            style={{ background:"none", border:"none", cursor:"pointer",
              fontSize:18, padding:"2px 4px", borderRadius:4 }}
            onMouseEnter={e => e.currentTarget.style.background="#333"}
            onMouseLeave={e => e.currentTarget.style.background="none"}>
            {em}
          </button>
        ))}
      </div>
      {menuItem("↩ Responder", () => onReply(msg))}
      {isOwn && menuItem("✏️ Editar", () => onEdit(msg))}
      {menuItem("↗ Encaminhar", () => onForward(msg))}
      <div style={{ height:1, background:"#333", margin:"4px 0" }} />
      {isOwn && menuItem("🗑 Apagar para mim", () => onDelete(msg), "#e57373")}
      {isOwn && menuItem("🗑 Apagar para todos", () => onDelete(msg), "#e57373")}
    </div>
  );
}

// ── Renderizador de mídia ──────────────────────────────────────────
function MediaContent({ media, msgId, r2MsgId, chatId, chatSession, onOcrResult }) {
  const [lightbox,     setLightbox]    = useState(false);
  const [fullUrl,      setFullUrl]     = useState(null);
  const [downloading,  setDownload]    = useState(false);
  const [error,        setError]       = useState(false);
  // Quando imagem R2 falha de carregar e o content-type real indica documento/PDF
  const [r2IsDoc,      setR2IsDoc]     = useState(false);
  const [r2MimeType,   setR2MimeType]  = useState(null);
  // Audio transcription state — persiste em localStorage por msgId para sobreviver troca de chat
  // Usa apenas msgId como chave (globalmente único por mensagem WhatsApp)
  // chatId é redundante e pode ser undefined em alguns caminhos de normalização
  const TRANSCRIPT_KEY = msgId ? `crm_transcript_${msgId}` : null;
  const [transcript,   setTranscript]  = useState(() => {
    try { return TRANSCRIPT_KEY ? (localStorage.getItem(TRANSCRIPT_KEY) || null) : null; } catch { return null; }
  });
  const [transcribing, setTranscribing] = useState(false);
  // PDF lightbox (used only when document is PDF)
  const [pdfLightbox,  setPdfLightbox] = useState(false);
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

  // Detecta documento/PDF antes de isImage — NOWEB às vezes envia type="image" para PDFs
  const isDocument = r2IsDoc ||
    media.type === "document" ||
    (media.mimetype || "").includes("pdf") ||
    ((media.mimetype || "").startsWith("application/") && !(media.mimetype || "").includes("octet-stream")) ||
    /\.(pdf|doc|docx|xls|xlsx|ppt|pptx)$/i.test(media.filename || "");

  const isImage = !isDocument && (media.type === "image" || media.type === "sticker" ||
                  (media.mimetype || "").startsWith("image/"));
  const isVideo = !isDocument && (media.type === "video" || (media.mimetype || "").startsWith("video/"));
  const isAudio = media.type === "audio" || media.type === "voice" ||
                  (media.mimetype || "").startsWith("audio/");

  // Mimetype correto — r2MimeType tem prioridade quando detectado via _doFetch
  const mimeHint = r2MimeType ||
    (r2IsDoc ? "application/pdf" : null) ||
    media.mimetype ||
    (isImage ? "image/jpeg" : isVideo ? "video/mp4" : isAudio ? "audio/ogg" : isDocument ? "application/pdf" : "application/octet-stream");

  const thumbSrc = media.thumbUrl || null;
  // Debug inicial: mostra quais URLs estarão disponíveis para fetch
  const debugInfo = { 
    media, msgId, chatId, isImage, isVideo, isAudio, mimeHint, thumbSrc,
    mediaUrl: media?.url,
    downloadPath,
    fallbackPath: fallbackDownloadPath,
  };
  console.debug(`[media] init msgId=${msgId} proxiedUrl=${proxiedUrl ? 'yes' : 'no'} downloadPath=${!!downloadPath} fallbackPath=${!!fallbackDownloadPath} urlToFetch=${!!urlToFetch}`, debugInfo);

  // NÃO revoga objectURL ao desmontar — o blob permanece vivo no _mediaBlobCache
  // para que voltar à conversa não precise baixar novamente.
  // A revogação acontece automaticamente quando a aba é fechada.
  const blobUrlRef = useRef(null);

  // Helper: resolve binary from a WAHA endpoint (SEM fila — callers já gerenciam a fila).
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


  // Resolve binário + atualiza cache em memória e localStorage
  async function _doFetch(onCancelled) {
    // 1. Memória (blob ainda vivo — zero request)
    const mem = getMediaBlobInMemory(msgId);
    if (mem) { setFullUrl(mem); blobUrlRef.current = mem; return; }
    // 2. localStorage (base64 salvo — sobrevive F5, zero request)
    const stored = getMediaFromStorage(msgId);
    if (stored) {
      const url = stored; // data-uri direto
      blobUrlRef.current = url;
      setMediaBlobInMemory(msgId, url);
      if (!onCancelled?.()) setFullUrl(url);
      return;
    }
    // 3. Falha permanente registrada — não re-tenta
    if (isMediaFailed(msgId)) { return; }

    setDownload(true);
    setError(false);
    const srcLabel = proxiedUrl?.includes("/api/r2-data?type=media") ? "R2" : "WAHA";
    console.log(`[media] baixando de ${srcLabel} msgId=${msgId}`);
    try {
      await mediaQueue(async () => {
        if (onCancelled?.()) return;
        let result = await resolveMediaBinary(urlToFetch);
        if (onCancelled?.()) return;
        if (!result.ok && result.status === 404 && fallbackDownloadPath && !proxiedUrl) {
          result = await resolveMediaBinary(fallbackDownloadPath).catch(() => ({ ok: false, status: 0 }));
          if (onCancelled?.()) return;
        }
        if (!result.ok) {
          console.log(`[media] FALHA msgId=${msgId} status=${result.status} url=${urlToFetch?.slice(0,80)}`);
          if (result.status === 404) { markMediaFailed(msgId); }
          else setError(true);
          setDownload(false); return;
        }
        if (!result.buf || result.buf.byteLength === 0) { setError(true); setDownload(false); return; }
        // Se pensávamos que era imagem mas o content-type real é documento/PDF, corrige renderização
        if (isImage && result.ct && !result.ct.startsWith("image/")) {
          console.log(`[media] tipo real é ${result.ct} mas media.type="image" — renderizando como documento`);
          const docBlob = new Blob([result.buf], { type: result.ct });
          const docUrl = URL.createObjectURL(docBlob);
          blobUrlRef.current = docUrl;
          setMediaBlobInMemory(msgId, docUrl);
          setR2IsDoc(true);
          setR2MimeType(result.ct);
          if (!onCancelled?.()) setFullUrl(docUrl);
          setDownload(false);
          return;
        }
        const blob = new Blob([result.buf], { type: result.ct });
        // Salva base64 no localStorage para imagens pequenas (zero request no próximo F5)
        if (isImage) {
          const reader = new FileReader();
          reader.onload = () => saveMediaToStorage(msgId, reader.result, result.buf.byteLength);
          reader.readAsDataURL(blob);
        }
        const url  = URL.createObjectURL(blob);
        blobUrlRef.current = url;
        setMediaBlobInMemory(msgId, url);
        console.log(`[media] OK msgId=${msgId} bytes=${result.buf.byteLength} type=${result.ct}`);
        if (!onCancelled?.()) setFullUrl(url);

        // Upload permanente ao R2 (fire-and-forget) — sobrevive aos 7 dias do WAHA
        if (msgId && !proxiedUrl?.includes("/api/r2-data?type=media")) {
          const r2MediaUrl = `/api/r2-data?type=media&msgId=${encodeURIComponent(msgId)}`;
          fetch(r2MediaUrl, {
            method: "PUT",
            body: result.buf,
            headers: { "Content-Type": result.ct, "X-Internal-Key": iKey },
          }).then(async ur => {
            if (!ur.ok) { console.warn(`[r2-media] FALHA upload msgId=${msgId} status=${ur.status}`); return; }
            console.log(`[r2-media] ✅ upload OK msgId=${msgId} bytes=${result.buf.byteLength} type=${result.ct}`);
            // Atualiza metadados da mensagem no R2 com a URL permanente
            if (chatId && r2MsgId) {
              fetch(`/api/r2-data?type=msgs&chatId=${encodeURIComponent(chatId)}`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-Internal-Key": iKey },
                body: JSON.stringify([{ id: r2MsgId, chatId, mediaUrl: r2MediaUrl }]),
              }).then(r => r.json()).then(j => console.log(`[r2-media] ✅ metadata salvo msgId=${msgId}`, j)).catch(() => {});
            }
          }).catch(() => {});
        }
      });
    } catch (e) {
      console.error(`[media] fetch error ${msgId}:`, e?.message || e);
      if (!onCancelled?.()) setError(true);
    }
    if (!onCancelled?.()) setDownload(false);
  }

  async function fetchMedia() {
    if (fullUrl || !urlToFetch || downloading) return;
    await _doFetch();
  }

  // Auto-carrega imagem e áudio (com fila e cache)
  useEffect(() => {
    if (!isImage && !isAudio) return;
    if (!urlToFetch) { console.log(`[media] SEM urlToFetch msgId=${msgId} chatId=${chatId} proxiedUrl=${!!proxiedUrl} downloadPath=${!!downloadPath}`); return; }
    if (fullUrl) return;
    let cancelled = false;

    async function autoLoad() {
      // Nível 1: blob em memória — exibe imediatamente sem request
      const mem = getMediaBlobInMemory(msgId);
      if (mem) { setFullUrl(mem); blobUrlRef.current = mem; return; }
      // Nível 2: falha permanente — não re-tenta
      if (isMediaFailed(msgId)) return;
      // Nível 3: já baixou antes (flag localStorage) mas blob foi revogado → re-baixa silenciosamente
      await _doFetch(() => cancelled);
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
                transition:"filter .4s" }}
              onError={() => {
                // Blob foi carregado mas <img> não conseguiu renderizar
                // (ex: PDF salvo com type="image" no R2)
                // r2IsDoc será setado pelo _doFetch se o content-type real não for imagem
                setError(true);
              }} />
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
              <button onClick={e => { e.stopPropagation(); setError(false); try { localStorage.removeItem(MEDIA_CACHE_PREFIX + msgId + "_fail"); } catch {} fetchMedia(); }}
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
            fullUrl={fullUrl}
            downloadUrl={media.url || downloadPath}
            iKey={iKey}
            msgId={msgId}
            onClose={() => setLightbox(false)}
            onOcrResult={text => { setLightbox(false); onOcrResult?.(text); }} />
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
    async function handleTranscribe() {
      if (!fullUrl || transcribing) return;
      setTranscribing(true);
      try {
        const rawBlob = await fetch(fullUrl).then(r => r.blob());
        // Groq aceita: ogg, opus, mp4, webm, wav, mp3, flac, m4a
        // Normaliza o tipo — WAHA às vezes retorna audio/ogg;codecs=opus
        const mimeType = rawBlob.type.split(";")[0] || "audio/ogg";
        const blob = new Blob([rawBlob], { type: mimeType });
        const form = new FormData();
        form.append("file", blob, "audio." + (mimeType.split("/")[1] || "ogg"));
        const r = await fetch("/api/transcribe", {
          method: "POST",
          headers: { "X-Internal-Key": iKey },
          body: form,
        });
        if (r.ok) {
          const data = await r.json();
          const text = data.text || "(sem transcrição)";
          setTranscript(text);
          if (TRANSCRIPT_KEY) {
            try { localStorage.setItem(TRANSCRIPT_KEY, text); } catch {
              try {
                Object.keys(localStorage)
                  .filter(k => k.startsWith("waha_photos") || k.startsWith("crm_chats"))
                  .forEach(k => { try { localStorage.removeItem(k); } catch {} });
                localStorage.setItem(TRANSCRIPT_KEY, text);
              } catch {}
            }
          }
        } else {
          setTranscript("Erro ao transcrever");
        }
      } catch (e) {
        setTranscript("Erro: " + e.message);
      }
      setTranscribing(false);
    }

    return (
      <div style={{ padding:"8px 6px", minWidth:220 }}>
        {fullUrl ? (
          <>
            <audio controls style={{ width:"100%", minWidth:220 }}>
              <source src={fullUrl} type={mimeHint} />
            </audio>
            {!transcript && (
              <button onClick={handleTranscribe} disabled={transcribing}
                style={{ fontSize:10, color:T.sub, background:"none",
                  border:"none", cursor:"pointer", padding:"2px 0", display:"block" }}>
                {transcribing ? "⏳ transcrevendo..." : "📝 transcrever"}
              </button>
            )}
            {transcript && (
              <div style={{ color:T.sub, fontSize:13, marginTop:4, fontStyle:"italic",
                borderLeft:`2px solid ${T.accent}`, paddingLeft:6 }}>
                {transcript}
              </div>
            )}
          </>
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
  const isPdf = isDocument && (mimeHint.includes("pdf") || filename.toLowerCase().endsWith(".pdf") || mimeHint === "application/pdf");

  function handleDocDownload() {
    if (fullUrl) {
      const a = document.createElement("a");
      a.href = fullUrl; a.download = filename; a.click();
    } else { fetchMedia(); }
  }

  return (
    <>
      {isPdf && fullUrl && (
        <PdfThumbnail blobUrl={fullUrl}
          onClick={() => setPdfLightbox(true)} />
      )}
      <div
        draggable
        onDragStart={e => {
          // Permite arrastar para o PatientPanel (prontuário)
          e.dataTransfer.setData("application/crm-file", JSON.stringify({
            name: filename, mimetype: mimeHint,
            url: fullUrl || urlToFetch || "",
          }));
        }}
        style={{ padding:"8px 12px", display:"flex", alignItems:"center", gap:10, cursor:"grab" }}>
        <span style={{ fontSize:24 }}>{isPdf ? "📄" : "📎"}</span>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ color:T.text, fontSize:12, fontWeight:600,
            overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
            {filename}
          </div>
          <div style={{ color:T.sub, fontSize:10 }}>{mimeHint}</div>
        </div>
        <div style={{ display:"flex", gap:4 }}>
          {isPdf && (
            <button onClick={() => { if (!fullUrl) fetchMedia(); setPdfLightbox(true); }}
              style={{ color:"#9090d8", fontSize:11, background:"none",
                border:"1px solid #9090d8", borderRadius:4, padding:"2px 8px", cursor:"pointer" }}
              title="Visualizar PDF">
              👁
            </button>
          )}
          {error ? (
            <button onClick={() => { setError(false); fetchMedia(); }}
              style={{ color:"#e57373", fontSize:11, background:"none",
                border:"1px solid #e57373", borderRadius:4, padding:"2px 8px", cursor:"pointer" }}>
              ⚠️
            </button>
          ) : (
            <button onClick={handleDocDownload} disabled={downloading}
              style={{ color:T.accent, fontSize:18, background:"none", border:"none",
                cursor:"pointer", padding:0 }} title="Baixar">
              {downloading ? "⏳" : "⬇"}
            </button>
          )}
        </div>
      </div>
      {pdfLightbox && fullUrl && (
        <div onClick={() => setPdfLightbox(false)} style={{
          position:"fixed", inset:0, background:"rgba(0,0,0,.95)", zIndex:9999,
          display:"flex", flexDirection:"column"
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            display:"flex", justifyContent:"space-between", alignItems:"center",
            padding:"10px 16px", background:"rgba(0,0,0,.6)", flexShrink:0
          }}>
            <span style={{ color:"#ccc", fontSize:12 }}>{filename}</span>
            <div style={{ display:"flex", gap:6 }}>
              <button onClick={handleDocDownload} style={btnStyle}>⬇ Baixar</button>
              <button onClick={() => setPdfLightbox(false)}
                style={{ ...btnStyle, background:"#c0412c44" }}>✕</button>
            </div>
          </div>
          <iframe src={fullUrl} title={filename}
            style={{ flex:1, border:"none", background:"#fff" }} />
        </div>
      )}
      {pdfLightbox && !fullUrl && downloading && (
        <div style={{ padding:"8px 12px", color:T.sub, fontSize:11 }}>
          Baixando PDF para visualização...
        </div>
      )}
    </>
  );
}

// ── Thumbnail da primeira página do PDF ───────────────────────────
// Só renderiza quando entra no viewport (IntersectionObserver) para não
// sobrecarregar dispositivos com muitos documentos abertos (ex: iPhone).
let _pdfWorkerSet = false;
async function _getPdfLib() {
  const pdfjsLib = await import("pdfjs-dist");
  if (!_pdfWorkerSet) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url
    ).toString();
    _pdfWorkerSet = true;
  }
  return pdfjsLib;
}

function PdfThumbnail({ blobUrl, onClick }) {
  const wrapRef   = useRef(null);
  const canvasRef = useRef(null);
  const [visible, setVisible] = useState(false);
  const [ready,   setReady]   = useState(false);
  const [failed,  setFailed]  = useState(false);

  // Observa visibilidade — só inicia render quando entra na tela
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || !("IntersectionObserver" in window)) { setVisible(true); return; }
    const obs = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setVisible(true); obs.disconnect(); }
    }, { rootMargin: "200px" });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !blobUrl) return;
    let cancelled = false;
    (async () => {
      try {
        const pdfjsLib = await _getPdfLib();
        const pdf  = await pdfjsLib.getDocument(blobUrl).promise;
        const page = await pdf.getPage(1);
        if (cancelled) return;
        const vp     = page.getViewport({ scale: 1 });
        const scale  = 220 / vp.width;
        const scaled = page.getViewport({ scale });
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width  = scaled.width;
        canvas.height = scaled.height;
        await page.render({ canvasContext: canvas.getContext("2d"), viewport: scaled }).promise;
        if (!cancelled) setReady(true);
      } catch { if (!cancelled) setFailed(true); }
    })();
    return () => { cancelled = true; };
  }, [visible, blobUrl]);

  if (failed) return null;
  return (
    <div ref={wrapRef} onClick={onClick}
      style={{ cursor: onClick ? "pointer" : "default",
        borderRadius:"6px 6px 0 0", overflow:"hidden", background:"#1a1a1a",
        display:"flex", alignItems:"center", justifyContent:"center",
        minHeight: ready ? 0 : 60 }}>
      <canvas ref={canvasRef} style={{ display: ready ? "block" : "none", width:"100%", maxWidth:220 }} />
      {!ready && <div style={{ color:"#555", fontSize:11, padding:8 }}>⏳</div>}
    </div>
  );
}

// ── Lightbox de imagem com zoom ───────────────────────────────────
function ImageLightbox({ src, fullUrl, downloadUrl, iKey, msgId, onClose, onOcrResult }) {
  const [zoom, setZoom] = useState(1);
  const [pos, setPos]   = useState({ x:0, y:0 });
  const [drag, setDrag] = useState(null);
  const [ocrLoading, setOcrLoading] = useState(false);

  useEffect(() => {
    const k = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  async function handleDownload() {
    // Se temos o blob já carregado, usa diretamente (sem request ao WAHA)
    if (fullUrl) {
      const a = document.createElement("a");
      a.href = fullUrl; a.download = `imagem_${msgId || Date.now()}.jpg`; a.click();
      return;
    }
    if (!downloadUrl) return;
    try {
      // Descobre a URL binária real (pode retornar JSON com media.url)
      const r = await fetch(downloadUrl, { headers: { "X-Internal-Key": iKey || "" } });
      if (!r.ok) return;
      const ct = r.headers.get("content-type") || "";
      let blob;
      if (ct.includes("application/json")) {
        const json = await r.json().catch(() => null);
        const mediaUrl = json?.media?.url;
        if (!mediaUrl) return;
        const r2 = await fetch(`/api/waha?path=${encodeURIComponent(mediaUrl)}`, { headers: { "X-Internal-Key": iKey || "" } });
        if (!r2.ok) return;
        blob = await r2.blob();
      } else {
        blob = await r.blob();
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `imagem_${msgId || Date.now()}.jpg`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
      console.error("[lightbox] download error:", e?.message || e);
    }
  }

  async function handleOcr() {
    if (!fullUrl && !downloadUrl) return;
    setOcrLoading(true);
    try {
      // Converte para base64 — aceita blob: e URLs normais
      let base64 = null;
      let mime = "image/jpeg";
      const srcUrl = fullUrl || downloadUrl;
      if (srcUrl) {
        const r = await fetch(srcUrl);
        const blob = await r.blob();
        mime = blob.type || "image/jpeg";
        const ab = await blob.arrayBuffer();
        const bytes = new Uint8Array(ab);
        let binary = "";
        const CHUNK = 8192;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
        }
        base64 = btoa(binary);
      }
      if (!base64) { setOcrLoading(false); return; }
      const res = await fetch("/api/ocr", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Key": iKey || "" },
        body: JSON.stringify({ base64, mime }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error("[ocr] erro:", res.status, err);
        alert("Erro ao analisar imagem: " + (err.error || res.status));
        setOcrLoading(false);
        return;
      }
      const data = await res.json();
      onOcrResult?.(data.text || "");
    } catch (e) {
      console.error("[ocr] error:", e?.message || e);
      alert("Erro: " + e.message);
    }
    setOcrLoading(false);
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
      <div onClick={e => e.stopPropagation()} style={{ position:"fixed", top:16, right:16, display:"flex", gap:8 }}>
        <button onClick={() => setZoom(z => Math.min(5, z+0.5))} style={btnStyle}>🔍+</button>
        <button onClick={() => { setZoom(1); setPos({x:0,y:0}); }} style={btnStyle}>↺</button>
        <button onClick={() => setZoom(z => Math.max(1, z-0.5))} style={btnStyle}>🔍−</button>
        <button onClick={handleOcr} disabled={ocrLoading || (!fullUrl)} style={btnStyle} title="Analisar dados do paciente">
          {ocrLoading ? "⏳" : "🔎 Analisar"}
        </button>
        {(fullUrl || downloadUrl) && (
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