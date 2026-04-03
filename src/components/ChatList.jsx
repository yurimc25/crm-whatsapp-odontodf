import { TAG_COLORS, STATUS_LABELS } from "../data/mock";

export default function ChatList({ chats, activeId, search, onSearch, onSelect, operator }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Search */}
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

      {/* List */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {chats.length === 0 && (
          <div style={{ padding: 24, textAlign: "center", color: "#2a4a36", fontSize: 13 }}>
            Nenhum chat encontrado
          </div>
        )}
        {chats.map(chat => (
          <ChatItem
            key={chat.id}
            chat={chat}
            active={chat.id === activeId}
            onClick={() => onSelect(chat)}
          />
        ))}
      </div>
    </div>
  );
}

function ChatItem({ chat, active, onClick }) {
  const statusDot = STATUS_LABELS[chat.status];

  return (
    <div
      onClick={onClick}
      draggable  // MODULE: drag-to-forward → implementar onDragStart/onDrop
      style={{
        padding: "12px 14px", cursor: "pointer", borderBottom: "1px solid #111a15",
        background: active ? "#111a15" : "transparent",
        borderLeft: active ? "3px solid #0d7d62" : "3px solid transparent",
        transition: "background .1s",
        display: "flex", gap: 10, alignItems: "flex-start",
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = "#0d1610"; }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = "transparent"; }}
    >
      {/* Avatar */}
      <div style={{
        width: 40, height: 40, borderRadius: 12, flexShrink: 0,
        background: chat.avatarColor + "22", color: chat.avatarColor,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 13, fontWeight: 700, position: "relative",
      }}>
        {chat.avatar}
        {/* Status dot */}
        <div style={{
          position: "absolute", bottom: 0, right: 0,
          width: 10, height: 10, borderRadius: "50%",
          background: statusDot.color, border: "2px solid #0a0f0d",
        }} />
      </div>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
          <span style={{ color: "#e8f5ee", fontSize: 13, fontWeight: 600,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 160 }}>
            {chat.name}
          </span>
          <span style={{ color: "#3a7055", fontSize: 11, flexShrink: 0 }}>{chat.lastTime}</span>
        </div>

        <div style={{ color: "#3a7055", fontSize: 12,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 5 }}>
          {chat.lastMsg}
        </div>

        <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
          {chat.tags.map(tag => {
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
