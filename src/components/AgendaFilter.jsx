// src/components/AgendaFilter.jsx
// Painel de filtro por agenda Doctoralia.
// Fluxo: seleciona data → lista dentistas → seleciona dentista → exibe agenda do dia.
// Ao clicar num paciente, abre a conversa correspondente (match por telefone).

import { useState, useEffect, useCallback } from "react";
import { phoneVariants, formatPhone } from "../hooks/useContacts";
import { useContactsCtx } from "../App";

const iKey = () => import.meta.env.VITE_INTERNAL_API_KEY || "@Deuse10";

const T = {
  bg: "#171717", border: "#2d2d2d", text: "#ececec", sub: "#8e8e8e",
  accent: "#d4956a", accentBg: "#3a2a1e", green: "#4caf87",
  yellow: "#c9a84c", red: "#e57373", hover: "#1f1f1f",
  inputBg: "#252525", active: "#2a2a2a",
};

const STATUS_COLOR = {
  0: T.sub,          // Agendado
  1: T.red,          // Canc. clínica
  2: T.red,          // Canc. paciente
  3: T.yellow,       // Não confirmado
  4: T.green,        // Confirmado
  6: "#4da6ff",      // Conf. Doctoralia
};

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

// Dado um número de telefone de agendamento, tenta encontrar o chatId no array de chats
function findChatByPhone(phone, chats) {
  if (!phone || !chats?.length) return null;
  const digits = phone.replace(/\D/g, "");
  const variants = new Set(phoneVariants(digits));
  for (const chat of chats) {
    const chatPhone = chat.id.replace(/@.*$/, "").replace(/\D/g, "");
    if (variants.has(chatPhone)) return chat;
    // Sufixo (últimos 8 dígitos)
    if (digits.length >= 8 && chatPhone.endsWith(digits.slice(-8))) return chat;
  }
  return null;
}

function shiftDate(dateStr, delta) {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

export default function AgendaFilter({ chats, onSelectChat, onStartNewChat }) {
  const { addLocalContact, contactMap } = useContactsCtx();
  const [date, setDate]           = useState(todayStr());
  const [doctors, setDoctors]     = useState([]);
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState(null);  // { scheduleId, name, color, workPeriods }
  const [agenda, setAgenda]       = useState(null);       // { doctor, appointments }
  const [loadingAgenda, setLoadingAgenda] = useState(false);
  const [error, setError]         = useState("");

  // Busca dentistas ao mudar a data
  const fetchDoctors = useCallback(async (d) => {
    setDoctors([]);
    setSelectedDoc(null);
    setAgenda(null);
    setError("");
    if (!d) return;
    setLoadingDoc(true);
    try {
      const r = await fetch(`/api/doctoralia?action=doctors_by_date&date=${d}`, {
        headers: { "X-Internal-Key": iKey() },
      });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || `Erro ${r.status}`);
        return;
      }
      setDoctors(data.doctors || []);
      if ((data.doctors || []).length === 0) setError("Nenhum dentista trabalha nessa data");
    } catch (e) {
      setError("Erro ao buscar dentistas: " + e.message);
    } finally {
      setLoadingDoc(false);
    }
  }, []);

  useEffect(() => { fetchDoctors(date); }, [date, fetchDoctors]);

  // Busca agenda ao selecionar dentista
  async function fetchAgenda(doc) {
    setSelectedDoc(doc);
    setAgenda(null);
    setError("");
    setLoadingAgenda(true);
    try {
      const r = await fetch(
        `/api/doctoralia?action=agenda&date=${date}&scheduleId=${doc.scheduleId}`,
        { headers: { "X-Internal-Key": iKey() } }
      );
      const data = await r.json();
      if (!r.ok) { setError(data.error || `Erro ${r.status}`); return; }
      setAgenda(data);
    } catch (e) {
      setError("Erro ao buscar agenda: " + e.message);
    } finally {
      setLoadingAgenda(false);
    }
  }

  const appointments = agenda?.appointments || [];
  const cancelados   = appointments.filter(a => a.status === 1 || a.status === 2).length;
  const confirmados  = appointments.filter(a => a.status === 4 || a.status === 6).length;
  const naoConf      = appointments.filter(a => a.status === 3).length;

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%", overflow:"hidden" }}>

      {/* Seletor de data com navegação */}
      <div style={{ padding:"10px 12px 8px", flexShrink:0 }}>
        <label style={{ color:T.sub, fontSize:10, fontWeight:600,
          textTransform:"uppercase", letterSpacing:.5, display:"block", marginBottom:4 }}>
          Data
        </label>
        <div style={{ display:"flex", gap:4, alignItems:"center" }}>
          <button
            onClick={() => setDate(d => shiftDate(d, -1))}
            style={{ flexShrink:0, width:30, height:32, background:T.inputBg,
              border:`1px solid ${T.border}`, borderRadius:6, cursor:"pointer",
              color:T.sub, fontSize:16, display:"flex", alignItems:"center",
              justifyContent:"center", transition:"all .15s" }}
            onMouseEnter={e => { e.currentTarget.style.background=T.hover; e.currentTarget.style.color=T.text; }}
            onMouseLeave={e => { e.currentTarget.style.background=T.inputBg; e.currentTarget.style.color=T.sub; }}>
            ‹
          </button>
          <input
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
            style={{ flex:1, background:T.inputBg, border:`1px solid ${T.border}`,
              borderRadius:8, padding:"7px 10px", color:T.text,
              fontSize:13, outline:"none", boxSizing:"border-box",
              colorScheme:"dark" }}
            onFocus={e => e.target.style.borderColor=T.accent}
            onBlur={e => e.target.style.borderColor=T.border}
          />
          <button
            onClick={() => setDate(d => shiftDate(d, 1))}
            style={{ flexShrink:0, width:30, height:32, background:T.inputBg,
              border:`1px solid ${T.border}`, borderRadius:6, cursor:"pointer",
              color:T.sub, fontSize:16, display:"flex", alignItems:"center",
              justifyContent:"center", transition:"all .15s" }}
            onMouseEnter={e => { e.currentTarget.style.background=T.hover; e.currentTarget.style.color=T.text; }}
            onMouseLeave={e => { e.currentTarget.style.background=T.inputBg; e.currentTarget.style.color=T.sub; }}>
            ›
          </button>
        </div>
      </div>

      {/* Lista de dentistas */}
      {!selectedDoc && (
        <div style={{ flex:1, overflowY:"auto" }}>
          {loadingDoc && (
            <div style={{ padding:20, textAlign:"center", color:T.sub, fontSize:12 }}>
              Buscando dentistas...
            </div>
          )}
          {!loadingDoc && error && (
            <div style={{ padding:16, color:T.red, fontSize:12, textAlign:"center" }}>
              {error}
            </div>
          )}
          {!loadingDoc && doctors.length > 0 && (
            <>
              <div style={{ padding:"4px 14px 6px", color:T.sub, fontSize:10, fontWeight:700,
                textTransform:"uppercase", letterSpacing:.5 }}>
                Selecione o dentista
              </div>
              {doctors.map(doc => (
                <div key={doc.scheduleId}
                  onClick={() => fetchAgenda(doc)}
                  style={{ padding:"10px 14px", cursor:"pointer",
                    borderBottom:`1px solid ${T.border}`,
                    display:"flex", alignItems:"center", gap:10,
                    transition:"background .1s" }}
                  onMouseEnter={e => e.currentTarget.style.background=T.hover}
                  onMouseLeave={e => e.currentTarget.style.background="transparent"}>
                  <div style={{ width:10, height:10, borderRadius:"50%", flexShrink:0,
                    background: doc.color || T.accent }} />
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ color:T.text, fontSize:13, fontWeight:500 }}>
                      {doc.name}
                    </div>
                    <div style={{ color:T.sub, fontSize:10, marginTop:1 }}>
                      {doc.workPeriods.map(p => `${p.start}–${p.end}`).join("  ·  ")}
                    </div>
                  </div>
                  <span style={{ color:T.sub, fontSize:12 }}>›</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {/* Agenda do dentista */}
      {selectedDoc && (
        <>
          {/* Header dentista */}
          <div style={{ padding:"6px 12px 8px", flexShrink:0,
            borderBottom:`1px solid ${T.border}` }}>
            <div style={{ display:"flex", alignItems:"center", gap:8 }}>
              <button onClick={() => { setSelectedDoc(null); setAgenda(null); setError(""); }}
                style={{ background:"none", border:"none", color:T.accent,
                  cursor:"pointer", fontSize:13, padding:"0 4px 0 0",
                  fontWeight:700 }}>
                ←
              </button>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ color:T.text, fontSize:12, fontWeight:700,
                  overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                  {selectedDoc.name}
                </div>
                <div style={{ color:T.sub, fontSize:10 }}>
                  {selectedDoc.workPeriods.map(p => `${p.start}–${p.end}`).join(" · ")}
                </div>
              </div>
              {/* Resumo */}
              {agenda && (
                <div style={{ display:"flex", gap:6, flexShrink:0 }}>
                  {confirmados > 0 && <span style={{ fontSize:10, color:T.green,   fontWeight:700 }}>✓{confirmados}</span>}
                  {naoConf     > 0 && <span style={{ fontSize:10, color:T.yellow,  fontWeight:700 }}>?{naoConf}</span>}
                  {cancelados  > 0 && <span style={{ fontSize:10, color:T.red,    fontWeight:700 }}>✗{cancelados}</span>}
                  <span style={{ fontSize:10, color:T.sub }}>{appointments.length}t</span>
                </div>
              )}
            </div>
          </div>

          {/* Lista de pacientes */}
          <div style={{ flex:1, overflowY:"auto" }}>
            {loadingAgenda && (
              <div style={{ padding:20, textAlign:"center", color:T.sub, fontSize:12 }}>
                Carregando agenda...
              </div>
            )}
            {!loadingAgenda && error && (
              <div style={{ padding:16, color:T.red, fontSize:12, textAlign:"center" }}>
                {error}
              </div>
            )}
            {!loadingAgenda && appointments.length === 0 && !error && (
              <div style={{ padding:20, textAlign:"center", color:T.sub, fontSize:12 }}>
                Nenhuma consulta nesta data
              </div>
            )}
            {appointments.map((appt, i) => {
              const chat        = findChatByPhone(appt.patientPhone, chats);
              const isCancelled = appt.status === 1 || appt.status === 2;
              return (
                <AgendaItem
                  key={appt.id || i}
                  appt={appt}
                  chat={chat}
                  isCancelled={isCancelled}
                  onOpen={() => {
                    // Registra no mapa de contatos se tiver nome+telefone e não estiver mapeado
                    if (appt.patientName && appt.patientPhone) {
                      const digits = appt.patientPhone.replace(/\D/g, "");
                      const phone8 = digits.slice(-8);
                      const alreadyMapped = Object.keys(contactMap).some(k => k.replace(/\D/g,"").slice(-8) === phone8);
                      if (!alreadyMapped) {
                        addLocalContact({ phone: digits, name: appt.patientName });
                      }
                    }
                    if (chat) { onSelectChat(chat); return; }
                    if (appt.patientPhone) onStartNewChat?.(appt.patientPhone);
                  }}
                />
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function AgendaItem({ appt, chat, isCancelled, onOpen }) {
  const hasChat = !!chat;
  return (
    <div
      onClick={onOpen}
      style={{
        padding:"9px 14px", cursor:"pointer",
        borderBottom:`1px solid ${T.border}`,
        display:"flex", gap:8, alignItems:"flex-start",
        opacity: isCancelled ? 0.5 : 1,
        transition:"background .1s",
      }}
      onMouseEnter={e => e.currentTarget.style.background=T.hover}
      onMouseLeave={e => e.currentTarget.style.background="transparent"}>

      {/* Horário */}
      <div style={{ flexShrink:0, textAlign:"center", minWidth:38 }}>
        <div style={{ color:T.accent, fontSize:12, fontWeight:700, lineHeight:1.2 }}>
          {appt.start}
        </div>
        {appt.end && (
          <div style={{ color:T.sub, fontSize:9 }}>{appt.end}</div>
        )}
      </div>

      {/* Info */}
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ display:"flex", alignItems:"center", gap:5, marginBottom:1 }}>
          <span style={{ color: isCancelled ? T.sub : T.text,
            fontSize:12, fontWeight:600,
            overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
            textDecoration: isCancelled ? "line-through" : "none" }}>
            {appt.patientName || "Paciente"}
          </span>
          {/* Status badge */}
          <span style={{ fontSize:9, fontWeight:700, flexShrink:0,
            color: STATUS_COLOR[appt.status] || T.sub }}>
            {appt.statusLabel}
          </span>
        </div>
        {appt.patientPhone && (
          <div style={{ color:T.sub, fontSize:10, fontFamily:"'DM Mono',monospace", marginBottom:1 }}>
            {formatPhone(appt.patientPhone)}
          </div>
        )}
        <div style={{ color:T.sub, fontSize:10, overflow:"hidden",
          textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
          {[appt.service, appt.insurance].filter(Boolean).join(" · ") || "Consulta"}
        </div>
      </div>

      {/* Indicador de chat */}
      <div style={{ flexShrink:0, display:"flex", alignItems:"center" }}>
        {hasChat ? (
          <span style={{ fontSize:14 }} title="Abrir conversa">💬</span>
        ) : appt.patientPhone ? (
          <span style={{ fontSize:11, color:T.sub }} title="Iniciar conversa">↗</span>
        ) : null}
      </div>
    </div>
  );
}
