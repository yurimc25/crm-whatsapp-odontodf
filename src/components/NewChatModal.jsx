// src/components/NewChatModal.jsx
// Modal para iniciar nova conversa: busca contato por nome/telefone,
// verifica se o número existe no WhatsApp antes de abrir o chat.
import { useState, useEffect, useRef, useCallback } from "react";
import { checkPhoneExists } from "../services/waha";
import { useContactsCtx } from "../App";
import { phoneVariants, formatPhone } from "../hooks/useContacts";

const T = {
  bg: "#252525", border: "#333", text: "#ececec", sub: "#8e8e8e",
  accent: "#d4956a", green: "#4caf87", red: "#e57373",
  hover: "#2d2d2d", inputBg: "#1e1e1e",
};

export default function NewChatModal({ operator, onClose, onStartChat, initialPhone }) {
  const [query, setQuery]       = useState(initialPhone ? formatPhone(initialPhone.replace(/\D/g,"")) : "");
  const [results, setResults]   = useState([]);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState(null); // { exists, chatId, phone }
  const [error, setError]       = useState("");
  const inputRef = useRef(null);
  const { contactMap, searchByName } = useContactsCtx();

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const close = e => e.key === "Escape" && onClose();
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);

  // Auto-verifica quando abre com número pré-preenchido (ex: clique na agenda)
  // Se achar, abre direto sem mostrar o modal
  useEffect(() => {
    if (!initialPhone) return;
    (async () => {
      const digits = initialPhone.replace(/\D/g, "");
      if (!digits || digits.length < 8) return;
      setChecking(true);
      try {
        const data = await checkPhoneExists(digits);
        if (data?.numberExists) {
          const chatId = data.chatId || `${digits}@c.us`;
          onStartChat(chatId); // abre direto, sem exibir o modal
        } else {
          setCheckResult({ exists: false, phone: digits });
          setChecking(false);
        }
      } catch {
        setChecking(false);
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Busca local no mapa de contatos
  const searchLocal = useCallback((q) => {
    if (!q || q.length < 2) return [];
    const s = q.toLowerCase();
    const digits = q.replace(/\D/g, "");
    const seen = new Set();
    const out = [];
    for (const [phone, name] of Object.entries(contactMap)) {
      const key = name + "|" + phone;
      if (seen.has(key)) continue;
      if (name.toLowerCase().includes(s) || (digits && phone.includes(digits))) {
        seen.add(key);
        out.push({ name, phone });
        if (out.length >= 8) break;
      }
    }
    return out;
  }, [contactMap]);

  async function handleSearch(q) {
    setQuery(q);
    setCheckResult(null);
    setError("");
    if (!q) { setResults([]); return; }
    const local = searchLocal(q);
    setResults(local);
    // Se parece número, tenta verificar se existe no WhatsApp
    const digits = q.replace(/\D/g, "");
    if (digits.length >= 8) {
      // Busca no Google Contacts também
      try {
        await searchByName?.(q);
        const fresh = searchLocal(q);
        if (fresh.length > local.length) setResults(fresh);
      } catch {}
    }
  }

  async function handleCheckAndStart(phone) {
    const digits = phone.replace(/\D/g, "");
    if (!digits || digits.length < 8) {
      setError("Número inválido");
      return;
    }
    setChecking(true);
    setCheckResult(null);
    setError("");
    try {
      const data = await checkPhoneExists(digits);
      if (data?.numberExists) {
        const chatId = data.chatId || `${digits}@c.us`;
        setCheckResult({ exists: true, chatId, phone: digits });
      } else {
        setCheckResult({ exists: false, phone: digits });
      }
    } catch (e) {
      setError("Erro ao verificar número: " + e.message);
    }
    setChecking(false);
  }

  function startChat() {
    if (checkResult?.chatId) onStartChat(checkResult.chatId);
  }

  const inputDigits = query.replace(/\D/g, "");
  const looksLikePhone = inputDigits.length >= 8;

  return (
    <div onClick={onClose} style={{
      position:"fixed", inset:0, background:"rgba(0,0,0,.7)",
      zIndex:9000, display:"flex", alignItems:"center", justifyContent:"center"
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background:T.bg, borderRadius:12, padding:24,
        width:380, maxHeight:"80vh", display:"flex", flexDirection:"column",
        border:`1px solid ${T.border}`, boxShadow:"0 16px 48px rgba(0,0,0,.6)"
      }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
          <div style={{ color:T.text, fontWeight:700, fontSize:15 }}>Nova conversa</div>
          <button onClick={onClose} style={{ background:"none", border:"none",
            color:T.sub, cursor:"pointer", fontSize:16 }}>✕</button>
        </div>

        <input
          ref={inputRef}
          value={query}
          onChange={e => handleSearch(e.target.value)}
          placeholder="Nome ou número (ex: 61999887766)"
          style={{ background:T.inputBg, border:`1px solid ${T.border}`, borderRadius:8,
            padding:"10px 14px", color:T.text, fontSize:13, outline:"none",
            marginBottom:12 }}
          onFocus={e => e.target.style.borderColor=T.accent}
          onBlur={e => e.target.style.borderColor=T.border}
        />

        {/* Resultados do mapa de contatos */}
        <div style={{ flex:1, overflowY:"auto", marginBottom:8 }}>
          {results.map((c, i) => (
            <div key={i} onClick={() => handleCheckAndStart(c.phone)}
              style={{ padding:"10px 12px", borderRadius:8, cursor:"pointer",
                display:"flex", justifyContent:"space-between", alignItems:"center",
                transition:"background .1s" }}
              onMouseEnter={e => e.currentTarget.style.background=T.hover}
              onMouseLeave={e => e.currentTarget.style.background="transparent"}>
              <div>
                <div style={{ color:T.text, fontSize:13, fontWeight:500 }}>{c.name}</div>
                <div style={{ color:T.sub, fontSize:11, fontFamily:"'DM Mono',monospace" }}>
                  {formatPhone(c.phone)}
                </div>
              </div>
              <span style={{ color:T.sub, fontSize:11 }}>→</span>
            </div>
          ))}

          {results.length === 0 && query.length >= 2 && (
            <div style={{ color:T.sub, fontSize:12, textAlign:"center", padding:"12px 0" }}>
              Nenhum contato encontrado
            </div>
          )}
        </div>

        {/* Verificar número direto */}
        {looksLikePhone && (
          <div style={{ borderTop:`1px solid ${T.border}`, paddingTop:12 }}>
            {checkResult === null && !checking && (
              <button onClick={() => handleCheckAndStart(inputDigits)}
                style={{ width:"100%", padding:"10px", background:"transparent",
                  border:`1px solid ${T.accent}`, borderRadius:8, color:T.accent,
                  fontSize:13, fontWeight:600, cursor:"pointer", transition:"all .15s" }}
                onMouseEnter={e => { e.currentTarget.style.background=T.accent; e.currentTarget.style.color="#fff"; }}
                onMouseLeave={e => { e.currentTarget.style.background="transparent"; e.currentTarget.style.color=T.accent; }}>
                🔍 Verificar {formatPhone(inputDigits)} no WhatsApp
              </button>
            )}
            {checking && (
              <div style={{ color:T.sub, fontSize:12, textAlign:"center", padding:"10px 0" }}>
                Verificando número...
              </div>
            )}
            {checkResult?.exists && (
              <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                <div style={{ color:T.green, fontSize:12, textAlign:"center" }}>
                  ✓ Número existe no WhatsApp
                </div>
                <button onClick={startChat}
                  style={{ width:"100%", padding:"10px", background:T.green,
                    border:"none", borderRadius:8, color:"#fff",
                    fontSize:13, fontWeight:600, cursor:"pointer" }}>
                  Iniciar conversa →
                </button>
              </div>
            )}
            {checkResult && !checkResult.exists && (
              <div style={{ color:T.red, fontSize:12, textAlign:"center", padding:"8px 0" }}>
                ✗ Número não encontrado no WhatsApp
              </div>
            )}
          </div>
        )}

        {error && (
          <div style={{ color:T.red, fontSize:11, marginTop:8, textAlign:"center" }}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
