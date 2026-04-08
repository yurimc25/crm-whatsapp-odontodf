import { useMemo, useState, useRef, useEffect } from "react";
import { useContactsCtx } from "../App";
import { formatPhone, wahaIdToPhone, phoneVariants } from "../hooks/useContacts";
import AgendaFilter from "./AgendaFilter";

const T = {
  bg:       "#171717",
  hover:    "#1f1f1f",
  active:   "#2a2a2a",
  border:   "#2d2d2d",
  text:     "#ececec",
  sub:      "#8e8e8e",
  accent:   "#d4956a",
  green:    "#4caf87",
  red:      "#e57373",
  yellow:   "#c9a84c",
  inputBg:  "#252525",
  unreadBg: "#1e2420",
  menu:     "#252525",
};

function formatTimeSince(ts) {
  if (!ts) return null;
  const diff = Date.now() - new Date(ts).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(mins / 60);
  const days  = Math.floor(hours / 24);
  if (days > 0)  return `${days}d`;
  if (hours > 0) return `${hours}h ${mins % 60}m`;
  if (mins > 0)  return `${mins}m`;
  return "agora";
}

export default function ChatList({
  chats, activeId, search, onSearch, onSelect,
  onForward, onMarkRead, onMarkUnread, loading, onStartNewChat, searchMessages
}) {
  const [ctxMenu, setCtxMenu]       = useState(null);
  const [agendaOpen, setAgendaOpen] = useState(false);
  const { contactMap } = useContactsCtx();

  // Resultados de busca em conteúdo de mensagens
  const msgSearchResults = useMemo(() => {
    if (!search || search.length < 3 || !searchMessages) return [];
    return searchMessages(search);
  }, [search, searchMessages]);

  const sorted = useMemo(() => {
    return [...chats].sort((a, b) => {
      // Resolvidos sempre no final
      const aResolved = a.status === "resolved";
      const bResolved = b.status === "resolved";
      if (aResolved !== bResolved) return aResolved ? 1 : -1;

      // Entre resolvidos: mais recente primeiro (por lastTs)
      if (aResolved && bResolved) {
        const ta = a.lastTs ? new Date(a.lastTs).getTime() : 0;
        const tb = b.lastTs ? new Date(b.lastTs).getTime() : 0;
        return tb - ta;
      }

      // Abertos/aguardando: quem tem lastPatientTs mais ANTIGO fica no topo (esperando há mais tempo)
      const tsA = a.lastPatientTs ? new Date(a.lastPatientTs).getTime() : 0;
      const tsB = b.lastPatientTs ? new Date(b.lastPatientTs).getTime() : 0;
      if (tsA && tsB) return tsA - tsB;   // mais antigo no topo
      if (tsA) return -1;                  // tem pendência → sobe
      if (tsB) return 1;                   // tem pendência → sobe
      // Sem pendência: mais recente no topo
      const ta = a.lastTs ? new Date(a.lastTs).getTime() : 0;
      const tb = b.lastTs ? new Date(b.lastTs).getTime() : 0;
      return tb - ta;
    });
  }, [chats]);

  const filtered = useMemo(() => {
    if (!search) return sorted;
    const s = search.toLowerCase();
    return sorted.filter(c =>
      c.name?.toLowerCase().includes(s) || c.id?.includes(s) || c.phone?.includes(s)
    );
  }, [sorted, search]);

  // Contatos do mapa que não têm conversa aberta (resultado de busca extra)
  const contactOnlyResults = useMemo(() => {
    if (!search || search.length < 2) return [];
    const s = search.toLowerCase();
    const digits = search.replace(/\D/g, "");
    const chatPhones = new Set(chats.map(c => wahaIdToPhone(c.id)));
    const seen = new Set();
    const out = [];
    for (const [phone, name] of Object.entries(contactMap)) {
      if (seen.has(name + phone)) continue;
      if (chatPhones.has(phone)) continue;
      if (name.toLowerCase().includes(s) || (digits && phone.includes(digits))) {
        seen.add(name + phone);
        out.push({ phone, name });
        if (out.length >= 5) break;
      }
    }
    return out;
  }, [search, contactMap, chats]);

  // Se é número puro digitado e não tem resultado, mostra botão de iniciar
  const inputDigits = search.replace(/\D/g, "");
  const showStartButton = inputDigits.length >= 8 && filtered.length === 0 && contactOnlyResults.length === 0;

  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onKey  = e => e.key === "Escape" && close();
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu]);

  function openMenu(e, chat) {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ chat, x: e.clientX, y: e.clientY });
  }

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%", overflow:"hidden",
      background:T.bg, fontFamily:"'DM Sans', sans-serif" }}>

      {/* Busca */}
      <div style={{ padding:"10px 12px", borderBottom:`1px solid ${T.border}`, flexShrink:0 }}>
        <div style={{ display:"flex", gap:6, alignItems:"center" }}>
          <div style={{ flex:1, position:"relative" }}>
            <span style={{ position:"absolute", left:10, top:"50%", transform:"translateY(-50%)",
              color:T.sub, fontSize:13, pointerEvents:"none" }}>🔍</span>
            <input value={search} onChange={e => onSearch(e.target.value)}
              placeholder="Buscar paciente ou número..."
              style={{ width:"100%", background:T.inputBg, border:`1px solid ${T.border}`,
                borderRadius:8, padding:"8px 12px 8px 32px", color:T.text,
                fontSize:13, outline:"none", boxSizing:"border-box" }} />
          </div>
          {/* Botão filtro por agenda */}
          <button
            onClick={() => setAgendaOpen(v => !v)}
            title={agendaOpen ? "Fechar agenda" : "Filtrar por agenda Doctoralia"}
            style={{
              flexShrink:0, width:34, height:34,
              background: agendaOpen ? T.accent : T.inputBg,
              border:`1px solid ${agendaOpen ? T.accent : T.border}`,
              borderRadius:8, cursor:"pointer", color: agendaOpen ? "#fff" : T.sub,
              fontSize:15, display:"flex", alignItems:"center", justifyContent:"center",
              transition:"all .15s",
            }}
            onMouseEnter={e => { if (!agendaOpen) { e.currentTarget.style.background=T.hover; e.currentTarget.style.color=T.text; }}}
            onMouseLeave={e => { if (!agendaOpen) { e.currentTarget.style.background=T.inputBg; e.currentTarget.style.color=T.sub; }}}>
            📅
          </button>
        </div>
      </div>

      {/* Painel de agenda (Doctoralia) */}
      {agendaOpen && (
        <div style={{ flex:1, overflow:"hidden", display:"flex", flexDirection:"column" }}>
          <AgendaFilter
            chats={chats}
            onSelectChat={onSelect}
            onStartNewChat={onStartNewChat}
          />
        </div>
      )}

      {/* Lista */}
      {!agendaOpen && <div style={{ flex:1, overflowY:"auto" }}>
        {loading && (
          <div style={{ padding:24, textAlign:"center", color:T.sub, fontSize:13 }}>
            Carregando conversas...
          </div>
        )}
        {!loading && filtered.length === 0 && contactOnlyResults.length === 0 && !showStartButton && (
          <div style={{ padding:24, textAlign:"center", color:T.sub, fontSize:13 }}>
            Nenhuma conversa encontrada
          </div>
        )}
        {filtered.map(chat => (
          <ChatItem
            key={chat.id}
            chat={chat}
            active={chat.id === activeId}
            onClick={() => onSelect(chat)}
            onOpenMenu={(e) => openMenu(e, chat)}
          />
        ))}

        {/* Contatos sem conversa */}
        {contactOnlyResults.length > 0 && (
          <>
            <div style={{ padding:"6px 14px 2px", color:T.sub, fontSize:10, fontWeight:600 }}>
              CONTATOS (sem conversa)
            </div>
            {contactOnlyResults.map((c, i) => (
              <div key={i}
                onClick={() => onStartNewChat?.(c.phone)}
                style={{ padding:"10px 14px", cursor:"pointer", borderBottom:`1px solid ${T.border}`,
                  display:"flex", gap:10, alignItems:"center",
                  transition:"background .1s" }}
                onMouseEnter={e => e.currentTarget.style.background=T.hover}
                onMouseLeave={e => e.currentTarget.style.background="transparent"}>
                <div style={{ width:38, height:38, borderRadius:"50%", flexShrink:0,
                  background:"#33331a", color:"#c9a84c",
                  display:"flex", alignItems:"center", justifyContent:"center",
                  fontSize:13, fontWeight:700, border:"2px solid #444422" }}>
                  {c.name.slice(0,2).toUpperCase()}
                </div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ color:T.text, fontSize:13, fontWeight:500 }}>{c.name}</div>
                  <div style={{ color:T.sub, fontSize:10, fontFamily:"'DM Mono',monospace" }}>
                    {formatPhone(c.phone)}
                  </div>
                </div>
                <span style={{ color:T.accent, fontSize:11 }}>iniciar →</span>
              </div>
            ))}
          </>
        )}

        {/* Resultados de busca em conteúdo de mensagens */}
        {msgSearchResults.length > 0 && (
          <>
            <div style={{ padding:"6px 14px 2px", color:T.sub, fontSize:10, fontWeight:600 }}>
              MENSAGENS COM "{search}"
            </div>
            {msgSearchResults.map((r, i) => (
              <div key={i}
                onClick={() => {
                  const chat = chats.find(c => c.id === r.chatId);
                  if (chat) onSelect(chat);
                }}
                style={{ padding:"10px 14px", cursor:"pointer", borderBottom:`1px solid ${T.border}`,
                  transition:"background .1s" }}
                onMouseEnter={e => e.currentTarget.style.background=T.hover}
                onMouseLeave={e => e.currentTarget.style.background="transparent"}>
                <div style={{ color:T.text, fontSize:12, fontWeight:500, marginBottom:2 }}>
                  {r.chatName}
                </div>
                {r.hits.slice(-1).map((h, j) => (
                  <div key={j} style={{ color:T.sub, fontSize:11, overflow:"hidden",
                    textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                    {h.text?.slice(0, 70)}
                  </div>
                ))}
              </div>
            ))}
          </>
        )}

        {/* Botão iniciar conversa com número digitado */}
        {showStartButton && (
          <div style={{ padding:"16px 14px", textAlign:"center" }}>
            <div style={{ color:T.sub, fontSize:12, marginBottom:10 }}>
              Nenhum resultado para "{search}"
            </div>
            <button onClick={() => onStartNewChat?.(inputDigits)}
              style={{ background:"transparent", border:`1px solid ${T.accent}`,
                borderRadius:8, padding:"8px 16px", color:T.accent,
                fontSize:12, fontWeight:600, cursor:"pointer", transition:"all .15s" }}
              onMouseEnter={e => { e.currentTarget.style.background=T.accent; e.currentTarget.style.color="#fff"; }}
              onMouseLeave={e => { e.currentTarget.style.background="transparent"; e.currentTarget.style.color=T.accent; }}>
              Iniciar conversa com {formatPhone(inputDigits)}
            </button>
          </div>
        )}
      </div>}

      {/* Menu de contexto */}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          chat={ctxMenu.chat}
          onClose={() => setCtxMenu(null)}
          onForward={onForward}
          onMarkRead={onMarkRead}
          onMarkUnread={onMarkUnread}
        />
      )}
    </div>
  );
}

function ChatItem({ chat, active, onClick, onOpenMenu }) {
  const { displayInfo } = useContactsCtx();
  const info = displayInfo(chat.id, chat.name, chat.pushname);
  const hasUnread = !active && (chat.unread > 0);

  const timeSince = chat.lastPatientTs ? formatTimeSince(chat.lastPatientTs) : null;
  const waitMs    = chat.lastPatientTs ? Date.now() - new Date(chat.lastPatientTs).getTime() : 0;
  const urgColor  = waitMs > 4*3600000 ? T.red : waitMs > 3600000 ? T.yellow : T.green;

  const initials = info.hasContact
    ? info.name.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase()
    : formatPhone(wahaIdToPhone(chat.id)).replace(/\D/g,"").slice(-4,-2) || "?";

  const photoUrl = info.photoUrl || chat.photoUrl || null;

  // Formata última mensagem para preview
  const lastMsgPreview = (() => {
    const msg = chat.lastMsg;
    if (!msg) return null;
    // Remove prefixo de operador "Nome: mensagem" → mostra só "mensagem"
    const colonIdx = msg.indexOf(": ");
    const preview  = colonIdx > 0 && colonIdx < 25 ? msg.slice(colonIdx + 2) : msg;
    return preview.length > 44 ? preview.slice(0, 44) + "…" : preview;
  })();

  // Long press para mobile (500ms)
  const longPressTimer = useRef(null);
  const longPressTriggered = useRef(false);

  function onTouchStart(e) {
    longPressTriggered.current = false;
    longPressTimer.current = setTimeout(() => {
      longPressTriggered.current = true;
      const touch = e.touches[0];
      onOpenMenu({ preventDefault:()=>{}, stopPropagation:()=>{},
        clientX: touch.clientX, clientY: touch.clientY });
    }, 500);
  }

  function onTouchEnd()  { clearTimeout(longPressTimer.current); }
  function onTouchMove() { clearTimeout(longPressTimer.current); }

  function handleClick() {
    if (longPressTriggered.current) return;
    onClick();
  }

  return (
    <div
      onClick={handleClick}
      onContextMenu={onOpenMenu}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      onTouchMove={onTouchMove}
      style={{
        padding:"10px 14px", cursor:"pointer",
        borderBottom:`1px solid ${T.border}`,
        background: active ? T.active : hasUnread ? T.unreadBg : "transparent",
        borderLeft: active ? `3px solid ${T.accent}` : "3px solid transparent",
        transition:"background .1s", display:"flex", gap:10, alignItems:"center",
        userSelect:"none", WebkitUserSelect:"none",
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = T.hover; }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = hasUnread ? T.unreadBg : "transparent"; }}>

      {/* Avatar */}
      <div style={{ position:"relative", flexShrink:0 }}>
        {photoUrl ? (
          <img src={photoUrl} alt={initials}
            style={{ width:46, height:46, borderRadius:"50%", objectFit:"cover",
              border:`2px solid ${T.border}`, display:"block" }}
            onError={e => { e.target.style.display="none"; }} />
        ) : (
          <div style={{ width:46, height:46, borderRadius:"50%",
            background:chat.avatarColor+"33", color:chat.avatarColor,
            display:"flex", alignItems:"center", justifyContent:"center",
            fontSize:14, fontWeight:700, border:`2px solid ${chat.avatarColor}44` }}>
            {initials}
          </div>
        )}
        <div style={{ position:"absolute", bottom:1, right:1,
          width:11, height:11, borderRadius:"50%",
          background:T.green, border:`2px solid ${T.bg}` }} />
      </div>

      {/* Conteúdo */}
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ display:"flex", justifyContent:"space-between",
          alignItems:"baseline", marginBottom:1 }}>
          <span style={{ color: info.hasContact ? T.text : T.sub,
            fontSize:13,
            fontWeight: hasUnread ? 700 : info.hasContact ? 500 : 400,
            overflow:"hidden", textOverflow:"ellipsis",
            whiteSpace:"nowrap", maxWidth:160 }}>
            {info.hasContact ? info.name : info.phone}
          </span>
          {timeSince && (
            <span style={{ fontSize:10, fontWeight:700,
              color:urgColor, flexShrink:0, marginLeft:4 }}>
              {timeSince}
            </span>
          )}
        </div>

        {info.hasContact && (
          <div style={{ color:T.sub, fontSize:10,
            fontFamily:"'DM Mono', monospace", marginBottom:2 }}>
            {info.phone}
          </div>
        )}

        <div style={{ color: hasUnread ? "#ccc" : T.sub,
          fontSize:12, fontWeight: hasUnread ? 500 : 400,
          overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
          {lastMsgPreview
            ? lastMsgPreview
            : <span style={{ fontStyle:"italic", color:"#444", fontWeight:400, fontSize:11 }}>
                {"Sem mensagens recentes"}
              </span>
          }
        </div>
      </div>

      {/* Badge não lido */}
      {hasUnread && (
        <div style={{
          background:T.green, color:"#fff",
          fontSize:11, fontWeight:700,
          minWidth:20, height:20, padding:"0 6px",
          borderRadius:10, flexShrink:0,
          display:"flex", alignItems:"center", justifyContent:"center",
        }}>
          {chat.unread > 99 ? "99+" : chat.unread}
        </div>
      )}
    </div>
  );
}

function ContextMenu({ x, y, chat, onClose, onForward, onMarkRead, onMarkUnread }) {
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const el   = menuRef.current;
    if (rect.right  > window.innerWidth)  el.style.left = `${x - rect.width}px`;
    if (rect.bottom > window.innerHeight) el.style.top  = `${y - rect.height}px`;
  }, [x, y]);

  const ENCAMINHAR = [
    { label:"↗ Encaminhar → Recepção", value:"recepcao" },
    { label:"↗ Encaminhar → Dra. Ana",  value:"ana"      },
    { label:"↗ Encaminhar → Admin",     value:"admin"    },
  ];

  function menuItem(label, action, color) {
    return (
      <div key={label}
        onClick={e => { e.stopPropagation(); action(); onClose(); }}
        style={{ padding:"10px 16px", cursor:"pointer",
          color: color || T.text, fontSize:13,
          transition:"background .1s", userSelect:"none" }}
        onMouseEnter={e => e.currentTarget.style.background=T.hover}
        onMouseLeave={e => e.currentTarget.style.background="transparent"}>
        {label}
      </div>
    );
  }

  return (
    <div
      ref={menuRef}
      onClick={e => e.stopPropagation()}
      style={{
        position:"fixed", left:x, top:y, zIndex:9999,
        background:T.menu, border:`1px solid ${T.border}`,
        borderRadius:10, minWidth:230, overflow:"hidden",
        boxShadow:"0 8px 32px rgba(0,0,0,.7)",
      }}>
      {/* Label do chat */}
      <div style={{ padding:"8px 16px 6px", borderBottom:`1px solid ${T.border}`,
        color:T.sub, fontSize:11, fontWeight:600 }}>
        {chat.name || chat.phone || chat.id}
      </div>

      {ENCAMINHAR.map(t => menuItem(t.label, () => onForward?.(chat.id, t.value)))}

      <div style={{ height:1, background:T.border, margin:"4px 0" }} />

      {chat.unread > 0
        ? menuItem("✓  Marcar como lido",      () => onMarkRead?.(chat.id))
        : menuItem("●  Marcar como não lido",   () => onMarkUnread?.(chat.id))
      }
    </div>
  );
}