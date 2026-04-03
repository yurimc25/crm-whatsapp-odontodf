import { useState, useRef, useEffect } from "react";
import { MOCK_MESSAGES, OPERATORS } from "../data/mock";
import PatientCardDetected from "./modules/PatientCardDetected";

export default function ChatWindow({ chat, operator, onForward, onResolve, canForwardToAdmin }) {
  const [messages, setMessages] = useState(MOCK_MESSAGES[chat.id] || []);
  const [text, setText] = useState("");
  const [showForward, setShowForward] = useState(false);
  const bottomRef = useRef(null);

  useEffect(() => {
    setMessages(MOCK_MESSAGES[chat.id] || []);
  }, [chat.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function sendMessage() {
    if (!text.trim()) return;
    const newMsg = {
      id: Date.now(),
      from: "operator",
      text: text.trim(),
      time: new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
      type: "text",
      operator: operator.name,
    };
    setMessages(prev => [...prev, newMsg]);
    setText("");
    // MODULE: WAHA API → POST /api/sendText { chatId, text: `${operator.name}: ${text}` }
  }

  const forwardTargets = [
    { label: "Recepção", value: "recepcao" },
    { label: "Dra. Ana (Dentista)", value: "ana" },
    ...(canForwardToAdmin ? [{ label: "Administrativo 🔒", value: "admin" }] : []),
  ].filter(t => t.value !== chat.assignedTo);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>

      {/* Chat header */}
      <div style={{
        padding: "10px 16px", borderBottom: "1px solid #1a2e22",
        background: "#0d1610", display: "flex", alignItems: "center", gap: 10,
      }}>
        <div style={{
          width: 36, height: 36, borderRadius: 10,
          background: chat.avatarColor + "22", color: chat.avatarColor,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 12, fontWeight: 700,
        }}>{chat.avatar}</div>
        <div style={{ flex: 1 }}>
          <div style={{ color: "#e8f5ee", fontSize: 14, fontWeight: 600 }}>{chat.name}</div>
          <div style={{ color: "#3a7055", fontSize: 11 }}>{chat.phone}</div>
        </div>

        {/* Encaminhar */}
        <div style={{ position: "relative" }}>
          <button onClick={() => setShowForward(v => !v)} style={{
            background: "transparent", border: "1px solid #1a2e22",
            borderRadius: 6, padding: "5px 10px", color: "#3a7055",
            fontSize: 11, cursor: "pointer", fontFamily: "'DM Sans', sans-serif",
            display: "flex", alignItems: "center", gap: 4,
          }}>
            ↗ Encaminhar
          </button>
          {showForward && (
            <div style={{
              position: "absolute", top: 36, right: 0, zIndex: 100,
              background: "#0d1610", border: "1px solid #1a2e22",
              borderRadius: 8, overflow: "hidden", minWidth: 180,
              boxShadow: "0 8px 32px rgba(0,0,0,.5)",
            }}>
              {forwardTargets.map(t => (
                <button key={t.value} onClick={() => { onForward(chat.id, t.value); setShowForward(false); }}
                  style={{
                    display: "block", width: "100%", textAlign: "left",
                    padding: "10px 14px", background: "transparent", border: "none",
                    color: "#c8e8d8", fontSize: 13, cursor: "pointer", fontFamily: "'DM Sans', sans-serif",
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = "#111a15"}
                  onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Resolver */}
        {chat.status !== "resolved" && (
          <button onClick={() => onResolve(chat.id)} style={{
            background: "#0d7d62", border: "none", borderRadius: 6,
            padding: "5px 12px", color: "#fff", fontSize: 11,
            fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans', sans-serif",
          }}>
            ✓ Resolver
          </button>
        )}
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: "auto", padding: "16px", display: "flex", flexDirection: "column", gap: 8 }}>
        {messages.map(msg => (
          <MessageBubble key={msg.id} msg={msg} operator={operator} />
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      {chat.status !== "resolved" ? (
        <div style={{
          padding: "10px 14px", borderTop: "1px solid #1a2e22",
          background: "#0d1610", display: "flex", gap: 8, alignItems: "flex-end",
        }}>
          <div style={{ flex: 1, position: "relative" }}>
            <div style={{
              position: "absolute", top: -20, left: 0,
              fontSize: 10, color: "#3a7055", fontWeight: 600,
            }}>
              {operator.name}:
            </div>
            <textarea
              value={text}
              onChange={e => setText(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
              placeholder="Digite a mensagem... (Enter para enviar)"
              rows={2}
              style={{
                width: "100%", background: "#111a15", border: "1px solid #1e3028",
                borderRadius: 8, padding: "10px 12px", color: "#e8f5ee",
                fontFamily: "'DM Sans', sans-serif", fontSize: 13, outline: "none",
                resize: "none", lineHeight: 1.5,
              }}
            />
          </div>
          <button onClick={sendMessage} style={{
            background: "#0d7d62", border: "none", borderRadius: 8,
            width: 40, height: 40, color: "#fff", fontSize: 18,
            cursor: "pointer", flexShrink: 0, display: "flex",
            alignItems: "center", justifyContent: "center",
          }}>→</button>
        </div>
      ) : (
        <div style={{
          padding: "12px", textAlign: "center", borderTop: "1px solid #1a2e22",
          color: "#3a7055", fontSize: 12,
        }}>
          Chat resolvido · <button onClick={() => {}} style={{
            background: "none", border: "none", color: "#0d7d62",
            cursor: "pointer", fontSize: 12, fontFamily: "'DM Sans', sans-serif",
          }}>Reabrir</button>
        </div>
      )}
    </div>
  );
}

function MessageBubble({ msg, operator }) {
  const isOwn = msg.from === "operator" && msg.operator === operator.name;
  const isBot = msg.from === "bot";
  const isPatient = msg.from === "patient";

  // MODULE: PatientCardDetected → detecta mensagem com dados do paciente
  if (msg.hasPatientCard) {
    return <PatientCardDetected msg={msg} />;
  }

  const align = isPatient ? "flex-start" : "flex-end";
  const bubbleBg = isBot ? "#1a1040" : isOwn ? "#0d2e22" : "#111a15";
  const bubbleBorder = isBot ? "#2a1a60" : isOwn ? "#0d7d62" : "#1e3028";

  return (
    <div style={{ display: "flex", justifyContent: align, maxWidth: "100%" }}>
      <div style={{ maxWidth: "72%" }}>
        {/* Remetente */}
        {!isPatient && (
          <div style={{
            fontSize: 10, fontWeight: 700, marginBottom: 3,
            color: isBot ? "#7b6ad4" : "#0d7d62",
            textAlign: isPatient ? "left" : "right",
          }}>
            {msg.operator || "Bot"}
          </div>
        )}
        <div style={{
          background: bubbleBg, border: `1px solid ${bubbleBorder}`,
          borderRadius: isPatient ? "4px 12px 12px 12px" : "12px 4px 12px 12px",
          padding: "9px 13px",
        }}>
          <div style={{ color: "#e8f5ee", fontSize: 13, lineHeight: 1.55, whiteSpace: "pre-wrap" }}>
            {msg.text}
          </div>
          <div style={{ color: "#3a7055", fontSize: 10, marginTop: 4, textAlign: "right" }}>
            {msg.time}
          </div>
        </div>
      </div>
    </div>
  );
}
