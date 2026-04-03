import { useState, useRef, useEffect } from "react";
import PatientCardDetected from "./modules/PatientCardDetected";
import { useContactsCtx } from "../App";
import { wahaIdToPhone, formatPhone } from "../hooks/useContacts";

export default function ChatWindow({ chat, messages, operator, onSend, onForward, onResolve, canForwardToAdmin }) {
  const [text, setText]               = useState("");
  const [sending, setSending]         = useState(false);
  const [showForward, setShowForward] = useState(false);
  const bottomRef = useRef(null);
  const { displayInfo } = useContactsCtx();
  const info = displayInfo(chat.id, chat.name);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSend() {
    if (!text.trim() || sending) return;
    setSending(true);
    try { await onSend(text.trim()); setText(""); }
    catch (e) { alert("Erro ao enviar: " + e.message); }
    finally { setSending(false); }
  }

  const forwardTargets = [
    { label: "Recepção",            value: "recepcao" },
    { label: "Dra. Ana (Dentista)", value: "ana"      },
    ...(canForwardToAdmin ? [{ label: "Administrativo 🔒", value: "admin" }] : []),
  ].filter(t => t.value !== chat.assignedTo);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header */}
      <div style={{
        padding: "10px 16px", borderBottom: "1px solid #1a2e22",
        background: "#0d1610", display: "flex", alignItems: "center", gap: 10, flexShrink: 0,
      }}>
        <div style={{
          width: 38, height: 38, borderRadius: 10,
          background: chat.avatarColor + "22", color: chat.avatarColor,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 12, fontWeight: 700,
        }}>
          {info.hasContact
            ? info.name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase()
            : chat.avatar}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          {info.hasContact ? (
            <>
              <div style={{ color: "#e8f5ee", fontSize: 14, fontWeight: 600,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {info.name}
              </div>
              <div style={{ color: "#3a7055", fontSize: 11,
                fontFamily: "'DM Mono', monospace" }}>
                {info.phone}
              </div>
            </>
          ) : (
            <>
              <div style={{ color: "#e8f5ee", fontSize: 13, fontWeight: 600,
                fontFamily: "'DM Mono', monospace",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {info.phone}
              </div>
              <div style={{ color: "#2a5040", fontSize: 10, fontFamily: "'DM Mono', monospace" }}>
                {info.phone} · sem contato
              </div>
            </>
          )}
        </div>

        <div style={{ position: "relative" }}>
          <button onClick={() => setShowForward(v => !v)} style={{
            background: "transparent", border: "1px solid #1a2e22", borderRadius: 6,
            padding: "5px 10px", color: "#3a7055", fontSize: 11,
            cursor: "pointer", fontFamily: "'DM Sans', sans-serif",
          }}>↗ Encaminhar</button>
          {showForward && (
            <div style={{
              position: "absolute", top: 36, right: 0, zIndex: 100,
              background: "#0d1610", border: "1px solid #1a2e22", borderRadius: 8,
              overflow: "hidden", minWidth: 200, boxShadow: "0 8px 32px rgba(0,0,0,.5)",
            }}>
              {forwardTargets.map(t => (
                <button key={t.value} onClick={() => { onForward(t.value); setShowForward(false); }}
                  style={{
                    display: "block", width: "100%", textAlign: "left",
                    padding: "10px 14px", background: "transparent", border: "none",
                    color: "#c8e8d8", fontSize: 13, cursor: "pointer", fontFamily: "'DM Sans', sans-serif",
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = "#111a15"}
                  onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                >{t.label}</button>
              ))}
            </div>
          )}
        </div>

        {chat.status !== "resolved" && (
          <button onClick={onResolve} style={{
            background: "#0d7d62", border: "none", borderRadius: 6,
            padding: "5px 12px", color: "#fff", fontSize: 11,
            fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans', sans-serif",
          }}>✓ Resolver</button>
        )}
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
        {messages.length === 0 && (
          <div style={{ textAlign: "center", color: "#2a4a36", fontSize: 13, marginTop: 40 }}>
            Nenhuma mensagem ainda
          </div>
        )}
        {messages.map(msg => (
          <MessageBubble key={msg.id} msg={msg} currentOperator={operator} />
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      {chat.status !== "resolved" ? (
        <div style={{
          padding: "10px 14px", borderTop: "1px solid #1a2e22",
          background: "#0d1610", display: "flex", gap: 8, alignItems: "flex-end", flexShrink: 0,
        }}>
          <div style={{ flex: 1, position: "relative" }}>
            <div style={{ position: "absolute", top: -18, left: 2, fontSize: 10, color: "#3a7055", fontWeight: 600 }}>
              {operator.name}:
            </div>
            <textarea
              value={text}
              onChange={e => setText(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
              placeholder="Enter para enviar · Shift+Enter para nova linha"
              rows={2}
              style={{
                width: "100%", background: "#111a15", border: "1px solid #1e3028",
                borderRadius: 8, padding: "10px 12px", color: "#e8f5ee",
                fontFamily: "'DM Sans', sans-serif", fontSize: 13, outline: "none", resize: "none",
              }}
            />
          </div>
          <button onClick={handleSend} disabled={sending || !text.trim()} style={{
            background: (sending || !text.trim()) ? "#1a2e22" : "#0d7d62",
            border: "none", borderRadius: 8, width: 40, height: 40, color: "#fff",
            fontSize: 18, cursor: sending ? "not-allowed" : "pointer", flexShrink: 0,
            display: "flex", alignItems: "center", justifyContent: "center", transition: "background .15s",
          }}>{sending ? "…" : "→"}</button>
        </div>
      ) : (
        <div style={{ padding: 12, textAlign: "center", borderTop: "1px solid #1a2e22", color: "#3a7055", fontSize: 12 }}>
          Chat resolvido
        </div>
      )}
    </div>
  );
}

function MessageBubble({ msg, currentOperator }) {
  if (msg.hasPatientCard) return <PatientCardDetected msg={msg} />;
  const isPatient = msg.from === "patient";
  const isBot     = msg.operator?.includes("🤖");
  const isMe      = msg.operator === currentOperator.name;
  return (
    <div style={{ display: "flex", justifyContent: isPatient ? "flex-start" : "flex-end" }}>
      <div style={{ maxWidth: "72%" }}>
        {!isPatient && (
          <div style={{ fontSize: 10, fontWeight: 700, marginBottom: 3, textAlign: "right",
            color: isBot ? "#7b6ad4" : "#0d7d62" }}>
            {msg.operator || "Operador"}
          </div>
        )}
        <div style={{
          background: isBot ? "#1a1040" : isMe ? "#0d2e22" : "#111a15",
          border: `1px solid ${isBot ? "#2a1a60" : isMe ? "#0d7d62" : "#1e3028"}`,
          borderRadius: isPatient ? "4px 12px 12px 12px" : "12px 4px 12px 12px",
          padding: "9px 13px",
        }}>
          <div style={{ color: "#e8f5ee", fontSize: 13, lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{msg.text}</div>
          <div style={{ color: "#3a7055", fontSize: 10, marginTop: 4, textAlign: "right" }}>{msg.time}</div>
        </div>
      </div>
    </div>
  );
}
