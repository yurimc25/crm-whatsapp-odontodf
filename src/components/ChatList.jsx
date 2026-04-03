import { TAG_COLORS, STATUS_LABELS } from "../data/mock";
import { useContactsCtx } from "../App";
import { wahaIdToPhone, formatPhone } from "../hooks/useContacts";

export default function ChatList({ chats, activeId, search, onSearch, onSelect, loading }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{ padding: "10px 12px", borderBottom: "1px solid #1a2e22" }}>
        <input
          value={search}
          onChange={e => onSearch(e.target.value)}
          placeholder="Buscar paciente ou número..."
          style={{
            width: "100%", background: "#111a15", border: "1px solid #1e3028",
            borderRadius: 8, padding: "8px 12px", color: "#e8f5ee",
            fontFamily: "'DM Sans', sans-serif", fontSize: 13, outline: "none",
          }}
        />
      </div>

      <div style={{ flex: 1, overflowY: "auto" }}>
        {loading && (
          <div style={{ padding: 24, textAlign: "center", color: "#2a4a36", fontSize: 13 }}>
            Carregando chats...
          </div>
        )}
        {!loading && chats.length === 0 && (
          <div style={{ padding: 24, textAlign: "center", color: "#2a4a36", fontSize: 13 }}>
            Nenhum chat encontrado
          </div>
        )}
        {chats.map(chat => (
          <ChatItem key={chat.id} chat={chat} active={chat.id === activeId} onClick={() => onSelect(chat)} />
        ))}
      </div>
    </div>
  );
}

function ChatItem({ chat, active, onClick }) {
  const { displayInfo } = useContactsCtx();
  const info = displayInfo(chat.id, chat.name);

  // Gera iniciais do avatar
  const initials = info.hasContact
    ? info.name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase()
    : formatPhone(wahaIdToPhone(chat.id)).replace(/\D/g, "").slice(2, 4) || "??";

  return (
    <div
      onClick={onClick}
      draggable
      style={{
        padding: "10px 14px", cursor: "pointer", borderBottom: "1px solid #111a15",
        background: active ? "#111a15" : "transparent",
        borderLeft: active ? "3px solid #0d7d62" : "3px solid transparent",
        transition: "background .1s", display: "flex", gap: 10, alignItems: "flex-start",
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = "#0d1610"; }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = "transparent"; }}
    >
      {/* Avatar */}
      <div style={{
        width: 42, height: 42, borderRadius: 12, flexShrink: 0,
        background: chat.avatarColor + "22", color: chat.avatarColor,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 12, fontWeight: 700, position: "relative",
      }}>
        {initials}
        <div style={{
          position: "absolute", bottom: 0, right: 0,
          width: 10, height: 10, borderRadius: "50%",
          background: STATUS_LABELS[chat.status]?.color || "#888",
          border: "2px solid #0a0f0d",
        }} />
      </div>

      {/* Conteúdo */}
      <div style={{ flex: 1, minWidth: 0 }}>

        {/* Linha 1: nome (ou número) + horário */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 1 }}>
          <span style={{
            color: "#e8f5ee", fontSize: 13, fontWeight: 600,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            maxWidth: 165,
          }}>
            {info.hasContact ? info.name : info.line1}
          </span>
          <span style={{ color: "#3a7055", fontSize: 10, flexShrink: 0, marginLeft: 6 }}>
            {chat.lastTime}
          </span>
        </div>

        {/* Linha 2: se sem contato → número formatado; se tem contato → número menor */}
        <div style={{
          color: info.hasContact ? "#3a7055" : "#2a5040",
          fontSize: info.hasContact ? 11 : 12,
          fontFamily: info.hasContact ? "inherit" : "'DM Mono', monospace",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          marginBottom: 3,
        }}>
          {info.hasContact ? info.phone : info.phone}
        </div>

        {/* Linha 3: preview da última mensagem */}
        <div style={{
          color: "#3a5244", fontSize: 11,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          marginBottom: 4,
        }}>
          {chat.lastMsg
            ? (chat.lastMsg.length > 45 ? chat.lastMsg.slice(0, 45) + "…" : chat.lastMsg)
            : <span style={{ color: "#1e3028", fontStyle: "italic" }}>Sem mensagens</span>
          }
        </div>

        {/* Tags + badge de não lido */}
        <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
          {(chat.tags || []).map(tag => {
            const tc = TAG_COLORS[tag] || { bg: "#1e3028", text: "#3a7055" };
            return (
              <span key={tag} style={{
                background: tc.bg, color: tc.text,
                fontSize: 9, fontWeight: 700, padding: "1px 6px",
                borderRadius: 4, textTransform: "uppercase", letterSpacing: .5,
              }}>{tag}</span>
            );
          })}
          {chat.unread > 0 && (
            <span style={{
              marginLeft: "auto", background: "#0d7d62", color: "#fff",
              fontSize: 10, fontWeight: 700, padding: "1px 7px", borderRadius: 10,
            }}>{chat.unread}</span>
          )}
        </div>
      </div>
    </div>
  );
}
