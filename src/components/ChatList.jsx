import { useMemo, useState, useRef, useEffect } from "react";
import { useContactsCtx } from "../App";
import { formatPhone, wahaIdToPhone } from "../hooks/useContacts";

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

export default function ChatList({ chats, activeId, search, onSearch, onSelect, onForward, onMarkRead, onMarkUnread, loading }) {
  const [ctxMenu, setCtxMenu] = useState(null); // { chat, x, y }

  const sorted = useMemo(() => {
    return [...chats].sort((a, b) => {
      // Quem tem lastPatientTs vem primeiro (ordenado do mais antigo para o mais recente)
      const tsA = a.lastPatientTs ? new Date(a.lastPatientTs).getTime() : 0;
      const tsB = b.lastPatientTs ? new Date(b.lastPatientTs).getTime() : 0;
      if (tsA && tsB) return tsA - tsB;
      if (tsA) return -1;
      if (tsB) return 1;
      return 0;
    });
  }, [chats]);

  const filtered = useMemo(() => {
    if (!search) return sorted;
    const s = search.toLowerCase();
    return sorted.filter(c =>
      c.name?.toLowerCase().includes(s) || c.id?.includes(s) || c.phone?.includes(s)
    );
  }, [sorted, search]);

  // Fecha menu ao clicar fora
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("keydown", e => e.key === "Escape" && close());
    return () => window.removeEventListener("click", close);
  }, [ctxMenu]);

  function handleContextMenu(e, chat) {
    e.preventDefault();
    setCtxMenu({ chat, x: e.clientX, y: e.clientY });
  }

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%", overflow:"hidden",
      background:T.bg, fontFamily:"'DM Sans', sans-serif" }}>

      {/* Busca */}
      <div style={{ padding:"10px 12px", borderBottom:`1px solid ${T.border}` }}>
        <div style={{ position:"relative" }}>
          <span style={{ position:"absolute", left:10, top:"50%", transform:"translateY(-50%)",
            color:T.sub, fontSize:13, pointerEvents:"none" }}>🔍</span>
          <input value={search} onChange={e => onSearch(e.target.value)}
            placeholder="Buscar paciente ou número..."
            style={{ width:"100%", background:T.inputBg, border:`1px solid ${T.border}`,
              borderRadius:8, padding:"8px 12px 8px 32px", color:T.text,
              fontSize:13, outline:"none", boxSizing:"border-box" }} />
        </div>
      </div>

      {/* Lista */}
      <div style={{ flex:1, overflowY:"auto" }}>
        {loading && (
          <div style={{ padding:24, textAlign:"center", color:T.sub, fontSize:13 }}>
            Carregando conversas...
          </div>
        )}
        {!loading && filtered.length === 0 && (
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
            onContextMenu={(e) => handleContextMenu(e, chat)}
          />
        ))}
      </div>

      {/* Menu de contexto (botão direito) */}
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

function ChatItem({ chat, active, onClick, onContextMenu }) {
  const { displayInfo } = useContactsCtx();
  const info = displayInfo(chat.id, chat.name);
  const hasUnread  = !active && (chat.unread > 0);

  const timeSince = chat.lastPatientTs ? formatTimeSince(chat.lastPatientTs) : null;
  const waitMs    = chat.lastPatientTs
    ? Date.now() - new Date(chat.lastPatientTs).getTime() : 0;
  const urgColor  = waitMs > 4*3600000 ? T.red : waitMs > 3600000 ? T.yellow : T.green;

  const initials = info.hasContact
    ? info.name.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase()
    : formatPhone(wahaIdToPhone(chat.id)).replace(/\D/g,"").slice(-4,-2) || "?";

  const photoUrl = info.photoUrl || chat.photoUrl || null;

  return (
    <div onClick={onClick} onContextMenu={onContextMenu}
      style={{
        padding:"10px 14px", cursor:"pointer",
        borderBottom:`1px solid ${T.border}`,
        background: active ? T.active : hasUnread ? T.unreadBg : "transparent",
        borderLeft: active ? `3px solid ${T.accent}` : "3px solid transparent",
        transition:"background .1s", display:"flex", gap:10, alignItems:"center",
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = T.hover; }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = hasUnread ? T.unreadBg : "transparent"; }}>

      {/* Avatar com foto */}
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
        {/* Ponto de presença online */}
        <div style={{ position:"absolute", bottom:1, right:1,
          width:11, height:11, borderRadius:"50%",
          background: T.green, border:`2px solid ${T.bg}` }} />
      </div>

      {/* Conteúdo */}
      <div style={{ flex:1, minWidth:0 }}>
        {/* Nome + tempo sem resposta */}
        <div style={{ display:"flex", justifyContent:"space-between",
          alignItems:"baseline", marginBottom:1 }}>
          <span style={{ color:T.text, fontSize:13,
            fontWeight: hasUnread ? 700 : 500,
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

        {/* Telefone (só se tem nome) */}
        {info.hasContact && (
          <div style={{ color:T.sub, fontSize:10,
            fontFamily:"'DM Mono', monospace", marginBottom:2 }}>
            {info.phone}
          </div>
        )}

        {/* Última mensagem */}
        <div style={{ color: hasUnread ? "#ccc" : T.sub,
          fontSize:12, fontWeight: hasUnread ? 500 : 400,
          overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
          {chat.lastMsg
            ? (chat.lastMsg.length > 44 ? chat.lastMsg.slice(0,44)+"…" : chat.lastMsg)
            : <span style={{ fontStyle:"italic", color:"#555", fontWeight:400 }}>Sem mensagens</span>}
        </div>
      </div>

      {/* Badge não lido — estilo WhatsApp */}
      {hasUnread && (
        <div style={{
          background: T.green, color:"#fff",
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

  // Ajusta posição para não sair da tela
  useEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const el = menuRef.current;
    if (rect.right > window.innerWidth)  el.style.left = `${x - rect.width}px`;
    if (rect.bottom > window.innerHeight) el.style.top = `${y - rect.height}px`;
  }, [x, y]);

  const ENCAMINHAR = [
    { label:"↗ Encaminhar para Recepção",   value:"recepcao" },
    { label:"↗ Encaminhar para Dra. Ana",    value:"ana"      },
    { label:"↗ Encaminhar para Admin",       value:"admin"    },
  ];

  function item(label, action, color) {
    return (
      <div key={label} onClick={(e) => { e.stopPropagation(); action(); onClose(); }}
        style={{ padding:"9px 16px", cursor:"pointer", color: color || T.text,
          fontSize:13, transition:"background .1s", userSelect:"none" }}
        onMouseEnter={e => e.currentTarget.style.background=T.hover}
        onMouseLeave={e => e.currentTarget.style.background="transparent"}>
        {label}
      </div>
    );
  }

  return (
    <div ref={menuRef} onClick={e => e.stopPropagation()}
      style={{
        position:"fixed", left:x, top:y, zIndex:9999,
        background:T.menu, border:`1px solid ${T.border}`,
        borderRadius:8, minWidth:220, overflow:"hidden",
        boxShadow:"0 8px 32px rgba(0,0,0,.6)",
      }}>
      {/* Encaminhar (submenu inline) */}
      {ENCAMINHAR.map(t => item(t.label, () => onForward?.(chat.id, t.value)))}

      <div style={{ height:1, background:T.border, margin:"4px 0" }} />

      {chat.unread > 0
        ? item("✓ Marcar como lido", () => onMarkRead?.(chat.id))
        : item("● Marcar como não lido", () => onMarkUnread?.(chat.id))
      }
    </div>
  );
}