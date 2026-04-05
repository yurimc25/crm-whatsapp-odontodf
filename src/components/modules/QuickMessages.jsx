// src/components/modules/QuickMessages.jsx
// Menu de mensagens rápidas acionado por "/" no input
// Salvo no localStorage — permite adicionar/editar atalhos

import { useState, useEffect, useRef } from "react";

const T = {
  bg: "#1e1e1e", panel: "#212121", border: "#2d2d2d",
  text: "#ececec", sub: "#8e8e8e", accent: "#d4956a",
  accentBg: "rgba(212,149,106,.08)",
};

const LS_KEY = "crm_quick_messages";

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

function loadMessages() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : DEFAULT_MESSAGES;
  } catch { return DEFAULT_MESSAGES; }
}

function saveMessages(msgs) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(msgs)); } catch {}
}

// ── Componente principal ──────────────────────────────────────────
export function QuickMessages({ query, onSelect, onClose }) {
  const [messages, setMessages] = useState(loadMessages);
  const [showAdd, setShowAdd]   = useState(false);
  const [editing, setEditing]   = useState(null); // null | message object
  const [form, setForm]         = useState({ atalho: "", titulo: "", texto: "" });
  const listRef = useRef(null);
  const [selected, setSelected] = useState(0);

  const q = (query || "").toLowerCase().replace(/^\//, "");

  const filtered = messages.filter(m =>
    !q ||
    m.atalho.toLowerCase().replace(/^\//, "").includes(q) ||
    m.titulo.toLowerCase().includes(q) ||
    m.texto.toLowerCase().includes(q)
  );

  // Navegação por teclado
  useEffect(() => {
    setSelected(0);
  }, [query]);

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

  function saveForm() {
    if (!form.atalho || !form.texto) return;
    const clean = { ...form, atalho: form.atalho.startsWith("/") ? form.atalho : "/" + form.atalho };
    let updated;
    if (editing) {
      updated = messages.map(m => m.id === editing.id ? { ...m, ...clean } : m);
    } else {
      updated = [...messages, { ...clean, id: Date.now().toString() }];
    }
    setMessages(updated);
    saveMessages(updated);
    setShowAdd(false);
  }

  function remove(id) {
    const updated = messages.filter(m => m.id !== id);
    setMessages(updated);
    saveMessages(updated);
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
        </span>
        <div style={{ display:"flex", gap:8 }}>
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
          {filtered.length === 0 && (
            <div style={{ color:T.sub, fontSize:12, textAlign:"center", padding:20 }}>
              Nenhuma mensagem encontrada para "{q}"
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
              {/* Atalho */}
              <span style={{ color:T.accent, fontFamily:"monospace", fontSize:12,
                fontWeight:700, minWidth:110, paddingTop:2 }}>
                {msg.atalho}
              </span>
              {/* Conteúdo */}
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ color:T.text, fontSize:12, fontWeight:600, marginBottom:2 }}>
                  {msg.titulo}
                </div>
                <div style={{ color:T.sub, fontSize:11, whiteSpace:"nowrap",
                  overflow:"hidden", textOverflow:"ellipsis" }}>
                  {msg.texto.split("\n")[0]}
                </div>
              </div>
              {/* Ações */}
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
