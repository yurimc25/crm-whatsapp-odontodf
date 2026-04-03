import { useMemo } from "react";
import { TAG_COLORS, STATUS_LABELS } from "../data/mock";
import { useContactsCtx } from "../App";
import { formatPhone, wahaIdToPhone } from "../hooks/useContacts";

const C = {
  bg:      "#f0efea",
  active:  "#ffffff",
  border:  "#e5e4df",
  text:    "#1a1a1a",
  sub:     "#6b6b6b",
  green:   "#0a7c5c",
  unread:  "#edfaf5",
  urgRed:  "#c0392b",
  urgYel:  "#b7560a",
  urgGrn:  "#0a7c5c",
};

function formatTimeSince(ts) {
  if (!ts) return null;
  const diff = Date.now() - new Date(ts).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(mins / 60);
  const days  = Math.floor(hours / 24);
  if (days > 0)  return `${days}d`;
  if (hours > 0) return `${hours}h ${mins%60}m`;
  if (mins > 0)  return `${mins}m`;
  return "agora";
}

export default function ChatList({ chats, activeId, search, onSearch, onSelect, loading }) {
  const sorted = useMemo(() => {
    return [...chats].sort((a, b) => {
      // Resolvidos vão para o final
      const aRes = a.status === "resolved";
      const bRes = b.status === "resolved";
      if (aRes && !bRes) return 1;
      if (!aRes && bRes) return -1;
      // Sem resposta há mais tempo vem primeiro
      const tsA = (!aRes && a.lastPatientTs) ? new Date(a.lastPatientTs).getTime() : 0;
      const tsB = (!bRes && b.lastPatientTs) ? new Date(b.lastPatientTs).getTime() : 0;
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
      c.name?.toLowerCase().includes(s) ||
      c.id?.includes(s)
    );
  }, [sorted, search]);

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%", overflow:"hidden",
      background: C.bg, fontFamily:"'DM Sans', sans-serif" }}>
      <div style={{ padding:"10px 12px", borderBottom:`1px solid ${C.border}`,
        background:"#fff" }}>
        <input value={search} onChange={e => onSearch(e.target.value)}
          placeholder="Buscar paciente ou número..."
          style={{ width:"100%", background:C.bg, border:`1px solid ${C.border}`,
            borderRadius:8, padding:"8px 12px", color:C.text,
            fontFamily:"'DM Sans', sans-serif", fontSize:13,
            outline:"none", boxSizing:"border-box" }} />
      </div>

      <div style={{ flex:1, overflowY:"auto" }}>
        {loading && (
          <div style={{ padding:24, textAlign:"center", color:C.sub, fontSize:13 }}>
            Carregando...
          </div>
        )}
        {filtered.map(chat => (
          <ChatItem key={chat.id} chat={chat} active={chat.id===activeId} onClick={()=>onSelect(chat)} />
        ))}
      </div>
    </div>
  );
}

function ChatItem({ chat, active, onClick }) {
  const { displayInfo } = useContactsCtx();
  const info = displayInfo(chat.id, chat.name);
  const isResolved = chat.status === "resolved";

  // Não mostra tempo se resolvido
  const timeSince = (!isResolved && chat.lastPatientTs) ? formatTimeSince(chat.lastPatientTs) : null;
  const waitMs = (!isResolved && chat.lastPatientTs)
    ? Date.now() - new Date(chat.lastPatientTs).getTime() : 0;
  const urgColor = waitMs > 4*3600000 ? C.urgRed : waitMs > 3600000 ? C.urgYel : C.urgGrn;

  const hasUnread = !active && (chat.unread > 0);

  const initials = info.hasContact
    ? info.name.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase()
    : formatPhone(wahaIdToPhone(chat.id)).replace(/\D/g,"").slice(-4,-2) || "?";

  const photoUrl = info.photoUrl || chat.photoUrl || null;

  return (
    <div onClick={onClick}
      style={{
        padding:"10px 14px", cursor:"pointer",
        borderBottom:`1px solid ${C.border}`,
        background: active ? C.active : hasUnread ? C.unread : "transparent",
        borderLeft: active ? `3px solid ${C.green}` : "3px solid transparent",
        transition:"background .1s", display:"flex", gap:10, alignItems:"flex-start",
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background="#fff"; }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = hasUnread ? C.unread : "transparent"; }}>

      {/* Avatar */}
      <div style={{ position:"relative", flexShrink:0 }}>
        {photoUrl ? (
          <img src={photoUrl} alt={initials}
            style={{ width:44, height:44, borderRadius:"50%", objectFit:"cover",
              border:`2px solid ${C.border}` }}
            onError={e => e.target.style.display="none"} />
        ) : (
          <div style={{ width:44, height:44, borderRadius:"50%",
            background: chat.avatarColor+"22", color: chat.avatarColor,
            display:"flex", alignItems:"center", justifyContent:"center",
            fontSize:13, fontWeight:700, border:`2px solid ${chat.avatarColor}44` }}>
            {initials}
          </div>
        )}
        <div style={{ position:"absolute", bottom:1, right:1,
          width:10, height:10, borderRadius:"50%",
          background: isResolved ? "#aaa" : C.urgGrn,
          border:"2px solid #fff" }} />
      </div>

      {/* Conteúdo */}
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:1 }}>
          <span style={{ color:C.text, fontSize:13,
            fontWeight: hasUnread ? 700 : 500,
            overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:150 }}>
            {info.hasContact ? info.name : info.phone}
          </span>
          {timeSince && (
            <span style={{ fontSize:10, fontWeight:700, color:urgColor, flexShrink:0, marginLeft:4 }}>
              {timeSince}
            </span>
          )}
          {isResolved && (
            <span style={{ fontSize:10, color:C.sub, flexShrink:0, marginLeft:4 }}>
              ✓ resolvido
            </span>
          )}
        </div>

        {info.hasContact && (
          <div style={{ color:C.sub, fontSize:10,
            fontFamily:"'DM Mono', monospace", marginBottom:2 }}>
            {info.phone}
          </div>
        )}

        <div style={{ color: hasUnread ? C.text : C.sub, fontSize:12,
          fontWeight: hasUnread ? 600 : 400,
          overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
          {chat.lastMsg
            ? (chat.lastMsg.length > 42 ? chat.lastMsg.slice(0,42)+"…" : chat.lastMsg)
            : <span style={{ fontStyle:"italic", color:C.sub, fontWeight:400 }}>Sem mensagens</span>}
        </div>
      </div>

      {hasUnread && (
        <div style={{ background:C.green, color:"#fff",
          fontSize:10, fontWeight:700, padding:"1px 7px",
          borderRadius:10, alignSelf:"center", flexShrink:0 }}>
          {chat.unread}
        </div>
      )}
    </div>
  );
}