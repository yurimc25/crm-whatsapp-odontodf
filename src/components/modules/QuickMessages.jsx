// src/components/modules/QuickMessages.jsx
// Menu de mensagens rápidas acionado por "/" no input
// Armazenado no MongoDB — qualquer operador pode editar; sincronizado em tempo real

import { useState, useEffect, useRef, useCallback } from "react";

const T = {
  bg: "#1e1e1e", panel: "#212121", border: "#2d2d2d",
  text: "#ececec", sub: "#8e8e8e", accent: "#d4956a",
  accentBg: "rgba(212,149,106,.08)",
};

const API_BASE = "/api/db";
const INTERNAL_KEY = import.meta.env.VITE_INTERNAL_API_KEY || "";

const DEFAULT_MESSAGES = [
  {
    id: "agendamento",
    atalho: "/agendamento",
    titulo: "Solicitar dados para agendamento",
    texto: `Para agendamento preciso de algumas informações 📋\n\nNome completo:\nCPF:\nE-mail:\nConvênio/particular:\nNúmero da carteirinha:\nTelefone:\nData de nascimento:`,
  },
  {
    id: "confirmacao",
    atalho: "/confirmacao",
    titulo: "Confirmar consulta",
    texto: `Olá! Passando para confirmar sua consulta amanhã. Por favor, responda *SIM* para confirmar ou *NÃO* para cancelar. 😊`,
  },
  {
    id: "saudacao",
    atalho: "/oi",
    titulo: "Saudação inicial",
    texto: `Olá! Tudo bem? Sou da *Odonto On Face*. Como posso te ajudar? 😊`,
  },
  {
    id: "encerramento",
    atalho: "/tchau",
    titulo: "Encerramento",
    texto: `Fico à disposição! Qualquer dúvida pode chamar. Tenha um ótimo dia! 😊`,
  },
  {
    id: "retorno",
    atalho: "/retorno",
    titulo: "Agendar retorno",
    texto: `Olá! Gostaria de agendar seu retorno. Qual o melhor dia e horário para você? 📅`,
  },
];

async function fetchMessages() {
  const res = await fetch(`${API_BASE}?action=quick-messages`, {
    headers: { "x-internal-key": INTERNAL_KEY },
  });
  if (!res.ok) throw new Error("fetch failed");
  const data = await res.json();
  return data.messages?.length ? data.messages : null;
}

async function persistMessages(msgs) {
  await fetch(`${API_BASE}?action=quick-messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-internal-key": INTERNAL_KEY },
    body: JSON.stringify({ messages: msgs }),
  });
}

// ── Componente principal ──────────────────────────────────────────
export function QuickMessages({ query, onSelect, onClose }) {
  const [messages, setMessages] = useState(DEFAULT_MESSAGES);
  const [loading, setLoading]   = useState(true);
  const [syncing, setSyncing]   = useState(false);
  const [showAdd, setShowAdd]   = useState(false);
  const [editing, setEditing]   = useState(null);
  const [form, setForm]         = useState({ atalho: "", titulo: "", texto: "" });
  const listRef = useRef(null);
  const [selected, setSelected] = useState(0);

  const load = useCallback(async (showLoader = false) => {
    if (showLoader) setSyncing(true);
    try {
      const remote = await fetchMessages();
      if (remote) setMessages(remote);
      else {
        // Primeira vez: persiste os defaults na nuvem
        await persistMessages(DEFAULT_MESSAGES);
      }
    } catch (e) {
      console.warn("[QuickMessages] falha ao carregar:", e.message);
    } finally {
      setLoading(false);
      setSyncing(false);
    }
  }, []);

  // Carrega do MongoDB no mount
  useEffect(() => { load(); }, [load]);

  const q = (query || "").toLowerCase().replace(/^\//, "");

  const filtered = messages.filter(m =>
    !q ||
    m.atalho.toLowerCase().replace(/^\//, "").includes(q) ||
    m.titulo.toLowerCase().includes(q) ||
    m.texto.toLowerCase().includes(q)
  );

  useEffect(() => { setSelected(0); }, [query]);

  useEffect(() => {
    function onKey(e) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSelected(s => Math.min(s+1, filtered.length-1)); }
      if (e.key === "ArrowUp")   { e.preventDefault(); setSelected(s => Math.max(s-1, 0)); }
      if (e.key === "Enter" && filtered[selected]) { e.preventDefault(); onSelect(filtered[selected].texto); }
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filtered, selected, onSelect, onClose]);

  function openAdd() {
    setForm({ atalho: "/", titulo: "", texto: "" });
    setEditing(null);
    setShowAdd(true);
  }

  function openEdit(msg) {
    setForm({ atalho: msg.atalho, titulo: msg.titulo, texto: msg.texto });
    setEditing(msg);
    setShowAdd(true);
  }

  async function saveForm() {
    if (!form.atalho || !form.texto) return;
    const clean = { ...form, atalho: form.atalho.startsWith("/") ? form.atalho : "/" + form.atalho };
    let updated;
    if (editing) {
      updated = messages.map(m => m.id === editing.id ? { ...m, ...clean } : m);
    } else {
      updated = [...messages, { ...clean, id: Date.now().toString() }];
    }
    setMessages(updated);
    setShowAdd(false);
    try { await persistMessages(updated); } catch (e) { console.warn("[QuickMessages] falha ao salvar:", e.message); }
  }

  async function remove(id) {
    const updated = messages.filter(m => m.id !== id);
    setMessages(updated);
    try { await persistMessages(updated); } catch (e) { console.warn("[QuickMessages] falha ao salvar:", e.message); }
  }

  return (
    <div style={{
      position:"absolute", bottom:"100%", left:0, right:0,
      background:T.panel, border:`1px solid ${T.border}`,
      borderRadius:"10px 10px 0 0", maxHeight:380, overflow:"hidden",
      display:"flex", flexDirection:"column", zIndex:100,
      boxShadow:"0 -4px 20px rgba(0,0,0,.4)"
    }}>
      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
        padding:"8px 12px", borderBottom:`1px solid ${T.border}`,
        background:"#1a1a1a" }}>
        <span style={{ color:T.accent, fontSize:12, fontWeight:700 }}>
          ⚡ Mensagens rápidas
          {q && <span style={{ color:T.sub }}> · "{q}"</span>}
          {loading && <span style={{ color:T.sub, fontWeight:400 }}> · carregando...</span>}
        </span>
        <div style={{ display:"flex", gap:8 }}>
          {/* Botão refresh */}
          <button
            onClick={() => load(true)}
            disabled={syncing}
            title="Sincronizar da nuvem"
            style={{ background:"none", border:`1px solid ${T.border}`, color: syncing ? T.sub : T.accent,
              borderRadius:6, padding:"3px 8px", fontSize:13, cursor: syncing ? "default" : "pointer" }}>
            {syncing ? "⏳" : "🔄"}
          </button>
          <button onClick={openAdd}
            style={{ background:T.accentBg, color:T.accent, border:`1px solid ${T.accent}44`,
              borderRadius:6, padding:"3px 10px", fontSize:11, fontWeight:600, cursor:"pointer" }}>
            + Adicionar
          </button>
          <button onClick={onClose}
            style={{ background:"none", border:"none", color:T.sub, cursor:"pointer", fontSize:16 }}>
            ×
          </button>
        </div>
      </div>

      {/* Lista */}
      {!showAdd && (
        <div ref={listRef} style={{ overflowY:"auto", flex:1 }}>
          {filtered.length === 0 && !loading && (
            <div style={{ color:T.sub, fontSize:12, textAlign:"center", padding:20 }}>
              Nenhuma mensagem encontrada{q ? ` para "${q}"` : ""}
            </div>
          )}
          {filtered.map((msg, i) => (
            <div key={msg.id}
              style={{ padding:"10px 12px", cursor:"pointer",
                background: i === selected ? T.accentBg : "transparent",
                borderBottom:`1px solid ${T.border}22`,
                display:"flex", alignItems:"flex-start", gap:10,
                transition:"background .15s" }}
              onMouseEnter={() => setSelected(i)}
              onClick={() => onSelect(msg.texto)}>
              <span style={{ color:T.accent, fontFamily:"monospace", fontSize:12,
                fontWeight:700, minWidth:110, paddingTop:2 }}>
                {msg.atalho}
              </span>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ color:T.text, fontSize:12, fontWeight:600, marginBottom:2 }}>
                  {msg.titulo}
                </div>
                <div style={{ color:T.sub, fontSize:11, whiteSpace:"nowrap",
                  overflow:"hidden", textOverflow:"ellipsis" }}>
                  {msg.texto.split("\n")[0]}
                </div>
              </div>
              <div style={{ display:"flex", gap:4, opacity:0.6 }}
                onClick={e => e.stopPropagation()}>
                <button onClick={() => openEdit(msg)}
                  style={{ background:"none", border:"none", color:T.sub,
                    cursor:"pointer", fontSize:13, padding:"2px 4px" }}
                  title="Editar">✏️</button>
                <button onClick={() => remove(msg.id)}
                  style={{ background:"none", border:"none", color:"#e57373",
                    cursor:"pointer", fontSize:13, padding:"2px 4px" }}
                  title="Excluir">🗑️</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Formulário de adicionar/editar */}
      {showAdd && (
        <div style={{ padding:14, display:"flex", flexDirection:"column", gap:10, overflowY:"auto" }}>
          <div style={{ color:T.text, fontWeight:600, fontSize:13, marginBottom:2 }}>
            {editing ? "Editar mensagem" : "Nova mensagem rápida"}
          </div>
          {[
            ["atalho",  "Atalho (ex: /agendamento)", "text"],
            ["titulo",  "Título / descrição",         "text"],
          ].map(([k, placeholder, type]) => (
            <input key={k} type={type} placeholder={placeholder}
              value={form[k]}
              onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))}
              style={{ background:"#2a2a2a", border:`1px solid ${T.border}`,
                borderRadius:6, padding:"7px 10px", color:T.text,
                fontSize:12, outline:"none", width:"100%", boxSizing:"border-box" }} />
          ))}
          <textarea placeholder="Texto da mensagem..."
            value={form.texto}
            rows={5}
            onChange={e => setForm(f => ({ ...f, texto: e.target.value }))}
            style={{ background:"#2a2a2a", border:`1px solid ${T.border}`,
              borderRadius:6, padding:"7px 10px", color:T.text,
              fontSize:12, outline:"none", resize:"vertical",
              fontFamily:"inherit", width:"100%", boxSizing:"border-box" }} />
          <div style={{ display:"flex", gap:8, justifyContent:"flex-end" }}>
            <button onClick={() => setShowAdd(false)}
              style={{ background:"none", border:`1px solid ${T.border}`, color:T.sub,
                borderRadius:6, padding:"6px 14px", fontSize:12, cursor:"pointer" }}>
              Cancelar
            </button>
            <button onClick={saveForm}
              style={{ background:T.accent, border:"none", color:"#111",
                borderRadius:6, padding:"6px 16px", fontSize:12,
                fontWeight:700, cursor:"pointer" }}>
              Salvar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
