import { useState, useMemo } from "react";
import ChatList from "./ChatList";
import ChatWindow from "./ChatWindow";
import PatientPanel from "./PatientPanel";
import { useWAHA } from "../hooks/useWAHA";
import { ROLE_PERMISSIONS } from "../data/mock";
import { useContactsCtx } from "../App";
import { wahaIdToPhone, formatPhone } from "../hooks/useContacts";
import { NotificationBell } from "./NotificationBell";
import NewChatModal from "./NewChatModal";

// Tema escuro estilo Claude
const T = {
  bg:        "#1e1e1e",   // fundo geral
  sidebar:   "#171717",   // sidebar esquerda
  panel:     "#212121",   // painel direito
  header:    "#1a1a1a",   // top bar
  border:    "#333333",   // bordas
  text:      "#ececec",   // texto principal
  sub:       "#8e8e8e",   // texto secundário
  accent:    "#d4956a",   // laranja Claude (destaques, ativo)
  accentBg:  "#3a2a1e",   // fundo do acento
  green:     "#4caf87",   // verde para status/badges
  greenBg:   "#1a2e24",   // fundo verde
  red:       "#e57373",   // erros
  inputBg:   "#2d2d2d",   // fundo de inputs
  hover:     "#2a2a2a",   // hover
  active:    "#2d2d2d",   // item ativo na lista
  bubble:    "#2d2d2d",   // bolha mensagem paciente
  bubbleMe:  "#1e3a2a",   // bolha minha mensagem
};

const ikey = () => import.meta.env.VITE_INTERNAL_API_KEY || "@Deuse10";

function MigrateHistoryButton() {
  const [state, setState] = useState("idle"); // idle | running | done | error
  const [progress, setProgress] = useState({ done: 0, total: 0, saved: 0 });

  async function run() {
    setState("running");
    setProgress({ done: 0, total: 0, saved: 0 });
    try {
      // 1. Busca lista de chatIds no WAHA (via servidor)
      const listRes = await fetch("/api/r2-data?type=migrate-list", {
        headers: { "X-Internal-Key": ikey() },
      });
      if (!listRes.ok) throw new Error(`Erro ${listRes.status}`);
      const { chatIds, total } = await listRes.json();
      if (!chatIds?.length) { setState("done"); return; }
      setProgress(p => ({ ...p, total }));

      // 2. Processa em batches de 10
      let done = 0;
      let saved = 0;
      const BATCH = 10;
      for (let i = 0; i < chatIds.length; i += BATCH) {
        const batch = chatIds.slice(i, i + BATCH);
        const r = await fetch("/api/r2-data?type=migrate-batch", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Internal-Key": ikey() },
          body: JSON.stringify({ chatIds: batch }),
        });
        if (!r.ok) continue;
        const result = await r.json();
        done  += result.processed || 0;
        saved += result.saved     || 0;
        setProgress({ done, total, saved });
      }
      setState("done");
    } catch (e) {
      console.error("[migrate]", e.message);
      setState("error");
    }
  }

  const label = state === "idle"    ? "⬆ Migrar histórico"
              : state === "running" ? `⏳ ${progress.done}/${progress.total} chats…`
              : state === "done"    ? `✓ ${progress.saved} msgs migradas`
              : "✗ Erro — tentar de novo";

  return (
    <button
      title="Importa mensagens do WAHA para a nuvem (R2). Use uma vez para migrar o histórico."
      disabled={state === "running"}
      onClick={state !== "running" ? run : undefined}
      style={{
        background: "transparent",
        border: `1px solid ${state === "done" ? "#4caf87" : state === "error" ? "#c0412c" : "#333"}`,
        borderRadius: 6, padding: "4px 8px",
        color:  state === "done" ? "#4caf87" : state === "error" ? "#c0412c" : "#888",
        fontSize: 11, cursor: state === "running" ? "wait" : "pointer",
        transition: "all .15s", whiteSpace: "nowrap",
      }}>
      {label}
    </button>
  );
}

function SyncDBButton({ onSync }) {
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState(null);
  return (
    <button
      title="Salvar lista de conversas na base de dados (multi-usuário)"
      disabled={syncing}
      onClick={async () => {
        setSyncing(true);
        try {
          await onSync();
          setLastSync(new Date().toLocaleTimeString("pt-BR", { hour:"2-digit", minute:"2-digit" }));
        } finally {
          setSyncing(false);
        }
      }}
      style={{ background:"transparent", border:`1px solid #333`,
        borderRadius:6, padding:"4px 8px",
        color: syncing ? "#888" : lastSync ? "#4caf87" : "#888",
        fontSize:11, cursor: syncing ? "wait" : "pointer",
        transition:"all .15s", whiteSpace:"nowrap" }}>
      {syncing ? "⏳" : lastSync ? `✓ ${lastSync}` : "⬆ Sync DB"}
    </button>
  );
}

function DuplicatesButton({ chats, dedupedChats }) {
  const [open, setOpen] = useState(false);

  const duplicates = useMemo(() => {
    const removed = chats.filter(c => !dedupedChats.find(d => d.id === c.id));
    // Agrupa: para cada removido, encontra o sobrevivente com mesmo phone tail-8
    return removed.map(r => {
      const rPhone = r.id.replace(/\D/g, "").slice(-8);
      const survivor = dedupedChats.find(d => d.id.replace(/\D/g, "").slice(-8) === rPhone)
        || dedupedChats.find(d => d.aliasIds?.includes(r.id));
      return { removed: r, survivor };
    });
  }, [chats, dedupedChats]);

  if (!open) {
    return (
      <button
        title="Ver chats duplicados ocultos pelo dedup"
        onClick={() => setOpen(true)}
        style={{ background:"transparent", border:`1px solid #333`, borderRadius:6,
          padding:"4px 8px", color: duplicates.length ? "#c9a84c" : "#555",
          fontSize:11, cursor:"pointer" }}>
        🔀 {duplicates.length} dup
      </button>
    );
  }

  return (
    <div style={{
      position:"fixed", inset:0, background:"#000a", zIndex:9999,
      display:"flex", alignItems:"center", justifyContent:"center",
    }} onClick={() => setOpen(false)}>
      <div onClick={e => e.stopPropagation()} style={{
        background:"#1e1e1e", border:"1px solid #333", borderRadius:10,
        padding:20, width:680, maxHeight:"80vh", overflow:"auto",
        fontFamily:"monospace", fontSize:12, color:"#ccc",
      }}>
        <div style={{ display:"flex", justifyContent:"space-between", marginBottom:12 }}>
          <strong style={{ color:"#c9a84c" }}>Chats ocultos pelo dedup ({duplicates.length})</strong>
          <button onClick={() => setOpen(false)} style={{ background:"none", border:"none", color:"#888", cursor:"pointer", fontSize:16 }}>✕</button>
        </div>
        {duplicates.length === 0 && <div style={{ color:"#666" }}>Nenhum duplicado detectado.</div>}
        {duplicates.map(({ removed: r, survivor: s }, i) => (
          <div key={i} style={{ borderBottom:"1px solid #2a2a2a", padding:"8px 0", display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
            <div>
              <div style={{ color:"#e57373", marginBottom:4 }}>❌ Oculto</div>
              <div><span style={{ color:"#888" }}>ID:</span> {r.id}</div>
              <div><span style={{ color:"#888" }}>Nome:</span> {r.pushname || r.name || "—"}</div>
              <div><span style={{ color:"#888" }}>Última msg:</span> {r.lastMsg?.slice(0,40) || "—"}</div>
              <div><span style={{ color:"#888" }}>lastTs:</span> {r.lastTs ? new Date(r.lastTs).toLocaleString("pt-BR") : "—"}</div>
              <div><span style={{ color:"#888" }}>aliases:</span> {r.aliasIds?.join(", ") || "—"}</div>
            </div>
            <div>
              <div style={{ color:"#4caf87", marginBottom:4 }}>✓ Exibido</div>
              {s ? <>
                <div><span style={{ color:"#888" }}>ID:</span> {s.id}</div>
                <div><span style={{ color:"#888" }}>Nome:</span> {s.pushname || s.name || "—"}</div>
                <div><span style={{ color:"#888" }}>Última msg:</span> {s.lastMsg?.slice(0,40) || "—"}</div>
                <div><span style={{ color:"#888" }}>lastTs:</span> {s.lastTs ? new Date(s.lastTs).toLocaleString("pt-BR") : "—"}</div>
                <div><span style={{ color:"#888" }}>aliases:</span> {s.aliasIds?.join(", ") || "—"}</div>
              </> : <div style={{ color:"#888" }}>— não encontrado —</div>}
            </div>
          </div>
        ))}
        <div style={{ marginTop:12, color:"#666", fontSize:11 }}>
          Total: {chats.length} no estado → {dedupedChats.length} exibidos → {duplicates.length} ocultos
        </div>
      </div>
    </div>
  );
}

export default function CRMLayout({ operator, onLogout, notificationBell }) {
  const [activeChat, setActiveChat]     = useState(null);
  const [filter, setFilter]             = useState("all");
  const [search, setSearch]             = useState("");
  const [showNewChat, setShowNewChat]   = useState(false);
  const [newChatPhone, setNewChatPhone] = useState(null);
  const [resyncKey, setResyncKey]       = useState(0);
  const [agendaOpen, setAgendaOpen]     = useState(false);

  const { displayName, lidPhoneMap } = useContactsCtx();

  const {
    chats, setChats, messages, loadMessages, loadOlderMessages, send, deleteMsg, editMsg,
    deleteChat, forwardChat, resolveChat, markRead, markUnread, searchMessages,
    resyncChats, syncChatsToR2, mutedChats, muteChat, unmuteChat, loading, error, wsStatus, myJid,
  } = useWAHA(operator);

  const ikey = () => import.meta.env.VITE_INTERNAL_API_KEY || "@Deuse10";

  async function handleMigrated(chatId) {
    // Recarrega mensagens do R2 e atualiza chatlist com lastMsg correto
    try {
      loadMessages(chatId); // recarrega ChatWindow com dados atualizados do R2
      const r = await fetch(`/api/r2-data?type=msgs&chatId=${encodeURIComponent(chatId)}`, {
        headers: { "X-Internal-Key": ikey() },
      });
      if (!r.ok) return;
      const msgs = await r.json();
      if (!Array.isArray(msgs) || !msgs.length) return;
      const last = msgs[msgs.length - 1];
      const body = last.body || "";
      const type = (last.type || "").toLowerCase();
      const lastMsg = body || (type === "ptt" || type === "voice" || type.includes("audio") ? "🎵 Áudio"
        : type.includes("image") || type === "sticker" ? "📷 Imagem"
        : type.includes("video") ? "🎥 Vídeo"
        : type.includes("document") ? "📎 Arquivo"
        : type !== "chat" ? "📎 Mídia" : "");
      setChats(prev => prev.map(c => c.id !== chatId ? c : {
        ...c, lastMsg, lastTs: last.ts, fromMe: last.fromMe ?? false,
      }));
    } catch {}
  }

  const perms = ROLE_PERMISSIONS[operator.role] || {};

  function canSeeChat(chat) {
    if (perms.verTodos) return true;
    if (operator.role === "recepcao") return !chat.assignedTo || chat.assignedTo === "recepcao";
    if (operator.role === "dentista") return chat.assignedTo === operator.login;
    return false;
  }

  // Dedup por telefone resolvido: remove @c.us quando existe @lid com mesmo número.
  // O @lid é alimentado pelo webhook em tempo real e é a fonte de verdade.
  // Transfere a foto do @c.us para o @lid antes de descartar.
  const dedupedChats = useMemo(() => {
    const PHOTO_KEY = "waha_photos_v4";

    // Monta mapa phone → chat@lid (usando lidPhoneMap já resolvido)
    const lidByPhone = new Map(); // phone (digits) → chat
    for (const c of chats) {
      if (!c.id?.endsWith("@lid")) continue;
      const lidOnly = c.id.replace(/@lid$/, "");
      const resolved = lidPhoneMap[lidOnly];
      const phone = resolved?.phone || null;
      if (phone) lidByPhone.set(phone, c);
    }

    // Identifica @c.us que são duplicatas de @lid resolvidos
    const idsToRemove = new Set();
    let photoCacheRaw = null;
    for (const c of chats) {
      if (!c.id?.endsWith("@c.us")) continue;
      const phone = c.id.replace(/@.*$/, "").replace(/\D/g, "");
      const lidChat = lidByPhone.get(phone);
      if (!lidChat) continue;
      idsToRemove.add(c.id);
      // Transfere foto do @c.us para o @lid (somente se @lid não tem foto ainda)
      try {
        if (!photoCacheRaw) {
          const raw = localStorage.getItem(PHOTO_KEY);
          photoCacheRaw = raw ? JSON.parse(raw) : { value: {}, expires: Date.now() + 86400000 };
        }
        const cusPhoto = photoCacheRaw.value?.[c.id] || c.photoUrl || null;
        const lidPhoto = photoCacheRaw.value?.[lidChat.id];
        if (cusPhoto && !lidPhoto) {
          photoCacheRaw.value[lidChat.id] = cusPhoto;
          localStorage.setItem(PHOTO_KEY, JSON.stringify(photoCacheRaw));
        }
      } catch {}
    }

    return idsToRemove.size > 0
      ? chats.filter(c => !idsToRemove.has(c.id))
      : chats;
  }, [chats, lidPhoneMap]);

  const enrichedChats = dedupedChats
    .filter(c => !myJid || c.id !== myJid)
    .filter(canSeeChat)
    .filter(c => filter === "all" || c.status === filter)
    .map(c => ({
      ...c,
      name:  displayName(c.id, c.name || c.pushname, c.pushname),
      phone: formatPhone(wahaIdToPhone(c.id)),
    }));

  function handleSelectChat(rawChat) {
    setActiveChat({
      ...rawChat,
      name:  displayName(rawChat.id, rawChat.name || rawChat.pushname, rawChat.pushname),
      phone: formatPhone(wahaIdToPhone(rawChat.id)),
    });
    loadMessages(rawChat.id);
  }

  const WS_COLOR = { connected: T.green, reconnecting: "#c9a84c", disconnected: "#666" };
  const WS_LABEL = { connected: "ao vivo", reconnecting: "reconectando...", disconnected: "offline" };

  const FILTERS = [
    { id:"all",      label:"Todos"     },
    { id:"open",     label:"Aberto"    },
    { id:"waiting",  label:"Aguard."   },
    { id:"resolved", label:"Resolvido" },
  ];

  return (
    <div style={{
      height:"100vh", display:"flex", flexDirection:"column",
      background: T.bg, fontFamily:"'DM Sans', sans-serif", overflow:"hidden",
      color: T.text,
    }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,wght@0,300;0,400;0,500;0,600;1,400&family=DM+Mono:wght@400;500&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:5px;height:5px}
        ::-webkit-scrollbar-track{background:transparent}
        ::-webkit-scrollbar-thumb{background:#404040;border-radius:3px}
        ::-webkit-scrollbar-thumb:hover{background:#555}
        input,textarea,button{font-family:'DM Sans',sans-serif}
        input::placeholder,textarea::placeholder{color:#666}
      `}</style>

      {/* ── Top bar ─────────────────────────────────────────────── */}
      <div style={{
        height:52, background: T.header, borderBottom:`1px solid ${T.border}`,
        display:"flex", alignItems:"center", padding:"0 16px", gap:12, flexShrink:0,
        boxShadow:"0 1px 4px rgba(0,0,0,.3)",
      }}>
        {/* Logo */}
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <span style={{ fontSize:20 }}>🦷</span>
          <span style={{ color:T.text, fontWeight:700, fontSize:15, letterSpacing:-.3 }}>
            Clínica CRM
          </span>
        </div>

        {/* Status WS */}
        <div style={{ display:"flex", alignItems:"center", gap:5,
          background:"#252525", borderRadius:20, padding:"3px 10px",
          border:`1px solid ${T.border}` }}>
          <div style={{
            width:7, height:7, borderRadius:"50%",
            background: WS_COLOR[wsStatus] || "#666",
            boxShadow: wsStatus==="connected" ? `0 0 0 2px ${T.greenBg}` : "none",
          }} />
          <span style={{ color:T.sub, fontSize:11 }}>{WS_LABEL[wsStatus] || wsStatus}</span>
        </div>

        {/* Botão ressincronizar — sincronização completa (100 dias, paginado) */}
        <button
          onClick={() => resyncChats().then(() => setResyncKey(k => k + 1))}
          disabled={loading}
          title="Sincronização completa: busca todos os chats dos últimos 100 dias"
          style={{
            background:"#252525", border:`1px solid ${T.border}`,
            borderRadius:20, padding:"3px 10px", cursor: loading ? "wait" : "pointer",
            color: T.sub, fontSize:11, display:"flex", alignItems:"center", gap:4,
            opacity: loading ? 0.5 : 1,
          }}
        >
          <span style={{ fontSize:13, lineHeight:1, display:"inline-block",
            animation: loading ? "spin 1s linear infinite" : "none" }}>⟳</span>
          {loading ? "Sincronizando..." : "Resync"}
        </button>

        <div style={{ flex:1 }} />

        {/* Filtros */}
        <div style={{ display:"flex", gap:3, background:"#252525",
          borderRadius:8, padding:3, border:`1px solid ${T.border}` }}>
          {FILTERS.map(f => (
            <button key={f.id} onClick={() => setFilter(f.id)} style={{
              background: filter===f.id ? T.active : "transparent",
              border:"none", borderRadius:6, padding:"4px 12px",
              color: filter===f.id ? T.text : T.sub,
              fontSize:12, fontWeight: filter===f.id ? 600 : 400,
              cursor:"pointer", transition:"all .15s",
              boxShadow: filter===f.id ? "0 1px 3px rgba(0,0,0,.4)" : "none",
            }}>
              {f.label}
            </button>
          ))}
        </div>

        <div style={{ width:1, height:28, background:T.border, margin:"0 4px" }} />

        {/* Operador */}
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <div style={{
            width:32, height:32, borderRadius:"50%",
            background: operator.color+"33", color: operator.color,
            display:"flex", alignItems:"center", justifyContent:"center",
            fontSize:12, fontWeight:700, border:`2px solid ${operator.color}55`,
          }}>
            {(operator.name||"?").slice(0,2).toUpperCase()}
          </div>
          <div>
            <div style={{ color:T.text, fontSize:13, fontWeight:600, lineHeight:1.2 }}>
              {operator.name}
            </div>
            <div style={{ color:T.sub, fontSize:10, textTransform:"capitalize" }}>
              {operator.role}
            </div>
          </div>
          <button onClick={onLogout} style={{
            background:"transparent", border:`1px solid ${T.border}`,
            borderRadius:6, padding:"4px 10px", color:T.sub,
            fontSize:11, cursor:"pointer", transition:"all .15s",
          }}
          onMouseEnter={e => { e.currentTarget.style.background=T.hover; e.currentTarget.style.color=T.text; }}
          onMouseLeave={e => { e.currentTarget.style.background="transparent"; e.currentTarget.style.color=T.sub; }}>
            Sair
          </button>
          <NotificationBell operator={operator} />
          {/* Backup Drive — só para gerente/admin */}
          {(operator.role === "gerente" || operator.role === "admin") && (
            <button
              title="Backup para Google Drive"
              onClick={async () => {
                try {
                  const r = await fetch("/api/backup?action=drive", {
                    method: "POST",
                    headers: { "X-Internal-Key": import.meta.env.VITE_INTERNAL_API_KEY || "@Deuse10" },
                  });
                  const d = await r.json();
                  if (d.ok) alert(`✓ Backup enviado: ${d.filename}\n${d.url || ""}`);
                  else alert("Erro no backup: " + (d.error || "desconhecido"));
                } catch (e) { alert("Erro: " + e.message); }
              }}
              style={{ background:"transparent", border:`1px solid ${T.border}`,
                borderRadius:6, padding:"4px 8px", color:T.sub,
                fontSize:13, cursor:"pointer", transition:"all .15s" }}
              onMouseEnter={e => { e.currentTarget.style.background=T.hover; e.currentTarget.style.color=T.text; }}
              onMouseLeave={e => { e.currentTarget.style.background="transparent"; e.currentTarget.style.color=T.sub; }}>
              ☁️
            </button>
          )}
          {/* Sync forçado do chatlist para a base — gerente/admin */}
          {(operator.role === "gerente" || operator.role === "admin") && (
            <SyncDBButton onSync={syncChatsToR2} />
          )}
          {/* Debug: exibir chats duplicados — gerente/admin */}
          {(operator.role === "gerente" || operator.role === "admin") && (
            <DuplicatesButton chats={chats} dedupedChats={dedupedChats} />
          )}
        </div>
      </div>

      {/* ── Erro ────────────────────────────────────────────────── */}
      {error && (
        <div style={{
          background:"#2a1a1a", borderBottom:`1px solid #5a2a2a`,
          padding:"8px 16px", color:T.red, fontSize:12,
          display:"flex", alignItems:"center", gap:8,
        }}>
          ⚠️ {error}
          <a href={`${import.meta.env.VITE_WAHA_URL||""}/dashboard`}
            target="_blank" rel="noreferrer"
            style={{ color:T.red, marginLeft:8, fontWeight:600 }}>
            Abrir dashboard WAHA →
          </a>
        </div>
      )}

      {/* ── Corpo ────────────────────────────────────────────────── */}
      <div style={{ flex:1, display:"flex", overflow:"hidden" }}>

        {/* Lista de chats */}
        <div style={{
          width:300, flexShrink:0, borderRight:`1px solid ${T.border}`,
          display:"flex", flexDirection:"column", overflow:"hidden",
          background: T.sidebar,
        }}>
          {/* Botão Nova Conversa */}
          <div style={{ padding:"8px 12px 0", flexShrink:0 }}>
            <button onClick={() => setShowNewChat(true)} style={{
              width:"100%", background: T.accentBg, border:`1px solid ${T.accent}44`,
              borderRadius:8, padding:"7px 12px", color:T.accent,
              fontSize:12, fontWeight:600, cursor:"pointer",
              display:"flex", alignItems:"center", justifyContent:"center", gap:6,
              transition:"all .15s"
            }}
            onMouseEnter={e => { e.currentTarget.style.background=T.accent; e.currentTarget.style.color="#fff"; }}
            onMouseLeave={e => { e.currentTarget.style.background=T.accentBg; e.currentTarget.style.color=T.accent; }}>
              ✏️ Nova conversa
            </button>
          </div>
          <ChatList
            chats={enrichedChats}
            activeId={activeChat?.id}
            search={search}
            onSearch={setSearch}
            onSelect={c => handleSelectChat(chats.find(x => x.id === c.id) || c)}
            onForward={(chatId, toRole) => forwardChat(chatId, toRole)}
            onMarkRead={markRead}
            onMarkUnread={markUnread}
            onDelete={deleteChat}
            loading={loading}
            operator={operator}
            searchMessages={searchMessages}
            resyncKey={resyncKey}
            mutedChats={mutedChats}
            onMute={muteChat}
            onUnmute={unmuteChat}
            agendaOpen={agendaOpen}
            onAgendaToggle={() => setAgendaOpen(v => !v)}
            onStartNewChat={phone => {
              const digits = phone.replace(/\D/g, "");
              const chatId = digits.startsWith("55") ? `${digits}@c.us` : `55${digits}@c.us`;
              const existing = chats.find(c => c.id === chatId || c.id.replace(/\D/g,"").slice(-8) === digits.slice(-8));
              if (existing) { handleSelectChat(existing); }
              else { setNewChatPhone(digits); setShowNewChat(true); }
            }}
          />
        </div>

        {showNewChat && (
          <NewChatModal
            operator={operator}
            initialPhone={newChatPhone}
            onClose={() => { setShowNewChat(false); setNewChatPhone(null); }}
            onStartChat={chatId => {
              setShowNewChat(false);
              const existing = chats.find(c => c.id === chatId);
              if (existing) {
                handleSelectChat(existing);
              } else {
                // Chat novo não carregado ainda — cria temporário e seleciona
                const tmp = {
                  id: chatId, name: chatId, pushname: null,
                  phone: chatId.replace(/@.*$/, ""),
                  isValidPhone: true, lastMsg: "", lastTime: "", lastTs: null,
                  unread: 0, status: "open", assignedTo: null, tags: [],
                  avatar: "??", avatarColor: "#555", photoUrl: null,
                };
                handleSelectChat(tmp);
              }
            }}
          />
        )}

        {/* Janela de chat */}
        <div style={{
          flex:1, minWidth:0, display:"flex", flexDirection:"column",
          overflow:"hidden", background: T.bg,
        }}>
          {activeChat ? (
            <ChatWindow
              chat={activeChat}
              messages={messages[activeChat.id] || []}
              operator={operator}
              onSend={text => send(activeChat.id, text, operator.name)}
              onForward={toRole => forwardChat(activeChat.id, toRole)}
              onResolve={() => resolveChat(activeChat.id)}
              onDeleteMsg={(msgId) => deleteMsg(activeChat.id, msgId)}
              onEditMsg={(msgId, text) => editMsg(activeChat.id, msgId, text)}
              canForwardToAdmin={perms.verAdmin}
              onLoadOlder={loadOlderMessages}
              onMigrated={() => handleMigrated(activeChat.id)}
            />
          ) : (
            <div style={{
              flex:1, display:"flex", alignItems:"center", justifyContent:"center",
              flexDirection:"column", gap:16, height:"100%", userSelect:"none",
            }}>
              <div style={{ fontSize:56, opacity:.15 }}>💬</div>
              <div style={{ fontSize:14, color:T.sub, fontWeight:500 }}>
                Selecione uma conversa para começar
              </div>
              <div style={{ fontSize:12, color:T.sub, opacity:.5 }}>
                {enrichedChats.length} conversa{enrichedChats.length!==1?"s":""} disponível{enrichedChats.length!==1?"s":""}
              </div>
            </div>
          )}
        </div>

        {/* Painel do paciente */}
        {activeChat && (
          <div style={{
            width:320, flexShrink:0, borderLeft:`1px solid ${T.border}`,
            display:"flex", flexDirection:"column", overflow:"hidden",
            background: T.panel,
          }}>
            <PatientPanel chat={activeChat} operator={operator} />
          </div>
        )}
      </div>
    </div>
  );
}