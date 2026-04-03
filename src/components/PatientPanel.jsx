import { useState } from "react";
import { MOCK_PRONTUARIO } from "../data/mock";
import { useContactsCtx } from "../App";
import { wahaIdToPhone, formatPhone } from "../hooks/useContacts";
import { useCodental } from "../hooks/useCodental";
import { useState, useEffect } from "react";

// Dentro do PerfilTab, adiciona estado e busca:
function PerfilTab({ chat }) {
  const { searchByPhone, searchByName, getUploads, loading } = useCodental();
  const { displayInfo } = useContactsCtx();
  const [paciente, setPaciente] = useState(null);
  const [uploads, setUploads]   = useState([]);
  const info = displayInfo(chat.id, chat.name);

  useEffect(() => {
    setPaciente(null);
    setUploads([]);

    async function buscar() {
      // 1. Tenta pelo telefone primeiro (mais preciso)
      const phone = info.phone.replace(/\D/g, "");
      let result = phone ? await searchByPhone(phone) : null;

      // 2. Se não achou, tenta pelo nome do contato
      if ((!result?.patients?.length) && info.hasContact) {
        const nome = info.name.split(" ").slice(0, 3).join(" ");
        result = await searchByName(nome);
      }

      if (result?.patients?.length > 0) {
        const p = result.patients[0];
        setPaciente(p);
        // Busca uploads se tiver ID
        if (p.id) {
          const u = await getUploads(p.id);
          setUploads(u?.uploads || []);
        }
      }
    }

    buscar();
  }, [chat.id]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <Section label="Codental">
        {loading && <div style={{ color: "#3a7055", fontSize: 12 }}>Buscando...</div>}
        {!loading && !paciente && <ModuleStub name="Paciente não encontrado no Codental" icon="📋" />}
        {paciente && (
          <>
            <Field label="Nome"      value={paciente.name || paciente.fullName} />
            <Field label="CPF"       value={paciente.cpf} />
            <Field label="Email"     value={paciente.email} />
            <Field label="Convênio"  value={paciente.health_insurance || paciente.convenio} />
            <Field label="Nascimento" value={paciente.birthdate || paciente.birthday} />
            <Field label="Dentista"  value={paciente.professional?.name} />
          </>
        )}
      </Section>

      {uploads.length > 0 && (
        <Section label={`Exames / Uploads (${uploads.length})`}>
          {uploads.slice(0, 5).map((u, i) => (
            <div key={i} style={{ marginBottom: 5 }}>
              <div style={{ color: "#c8e8d8", fontSize: 12 }}>{u.name || u.filename}</div>
              <div style={{ color: "#3a7055", fontSize: 10 }}>
                {u.created_at ? new Date(u.created_at).toLocaleDateString("pt-BR") : ""}
              </div>
            </div>
          ))}
        </Section>
      )}

      <Section label="Notas internas">
        {/* existente */}
      </Section>
    </div>
  );
}

// MODULE stubs — cada seção tem comentário indicando a API real
function ModuleStub({ name, icon }) {
  return (
    <div style={{
      background: "#0d1610", border: "1px dashed #1e3028",
      borderRadius: 8, padding: "14px", textAlign: "center",
    }}>
      <div style={{ fontSize: 20, marginBottom: 6 }}>{icon}</div>
      <div style={{ color: "#2a4a36", fontSize: 11, fontWeight: 600,
        textTransform: "uppercase", letterSpacing: .5 }}>
        MODULE: {name}
      </div>
      <div style={{ color: "#1a3028", fontSize: 10, marginTop: 3 }}>
        Integração pendente
      </div>
    </div>
  );
}

export default function PatientPanel({ chat, operator }) {
  const [tab, setTab] = useState("perfil");
  const { displayInfo } = useContactsCtx();
  const info = displayInfo(chat.id, chat.name);

  const prontuario = Object.values(MOCK_PRONTUARIO)[0];

  const TABS = [
    { id: "perfil",       label: "Perfil" },
    { id: "agendamentos", label: "Agenda" },
    { id: "evolucoes",    label: "Evoluções" },
    { id: "notas",        label: "Notas" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden",
      fontFamily: "'DM Sans', sans-serif", background: "#0a0f0d" }}>

      <div style={{ padding: "12px 14px 0", background: "#0d1610", borderBottom: "1px solid #1a2e22" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 12,
            background: chat.avatarColor + "22", color: chat.avatarColor,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 13, fontWeight: 700,
          }}>
            {info.hasContact
              ? info.name.split(" ").map(w => w[0]).join("").slice(0,2).toUpperCase()
              : chat.avatar}
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            {info.hasContact ? (
              <>
                <div style={{ color: "#e8f5ee", fontSize: 14, fontWeight: 600,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {info.name}
                </div>
                <div style={{ color: "#3a7055", fontSize: 11, fontFamily: "'DM Mono', monospace" }}>
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
                <div style={{ color: "#2a5040", fontSize: 10 }}>Sem contato cadastrado</div>
              </>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 0 }}>
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              flex: 1, background: "transparent", border: "none",
              borderBottom: tab === t.id ? "2px solid #0d7d62" : "2px solid transparent",
              padding: "6px 4px", color: tab === t.id ? "#0d7d62" : "#3a7055",
              fontSize: 11, fontWeight: 600, cursor: "pointer",
              fontFamily: "'DM Sans', sans-serif", transition: "all .15s",
            }}>{t.label}</button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>

        {tab === "perfil" && <PerfilTab prontuario={prontuario} chat={chat} />}
        {tab === "agendamentos" && <AgendamentosTab />}
        {tab === "evolucoes" && <EvolucoeTab />}
        {tab === "notas" && <NotasTab chat={chat} operator={operator} />}

      </div>
    </div>
  );
}

// ── Perfil ──────────────────────────────────────────────────────
function PerfilTab({ prontuario, chat }) {
  if (!prontuario) {
    return (
      <div>
        <ModuleStub name="Codental Prontuário" icon="📋" />
        <div style={{ marginTop: 10 }}>
          <ModuleStub name="Google Contacts" icon="👤" />
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {/* Dados básicos */}
      <Section label="Dados cadastrais">
        <Field label="Nome"      value={prontuario.nome} />
        <Field label="CPF"       value={prontuario.cpf} />
        <Field label="Nascimento" value={prontuario.nascimento} />
        <Field label="Convênio"  value={prontuario.convenio} />
        <Field label="Email"     value={prontuario.email} />
        <Field label="Dentista"  value={prontuario.dentista} />
      </Section>

      {/* Tags de status */}
      <Section label="Status">
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {["Em tratamento", "MetLife"].map(tag => (
            <span key={tag} style={{
              background: "#0d7d6222", color: "#0d7d62", border: "1px solid #0d7d6244",
              fontSize: 10, fontWeight: 600, padding: "3px 8px", borderRadius: 5,
            }}>{tag}</span>
          ))}
          <button style={{
            background: "transparent", border: "1px dashed #1e3028",
            borderRadius: 5, padding: "3px 8px", color: "#2a4a36",
            fontSize: 10, cursor: "pointer", fontFamily: "'DM Sans', sans-serif",
          }}>+ tag</button>
        </div>
      </Section>

      {/* Google Contacts stub */}
      {/* MODULE: Google Contacts API → contacts.get */}
      <ModuleStub name="Google Contacts" icon="👤" />
    </div>
  );
}
// Adiciona no topo do PatientPanel.jsx
import { useCodental } from "../hooks/useCodental";

// Dentro do PerfilTab, adiciona estado e busca:
function PerfilTab({ prontuario, chat }) {
  const { searchPatient, loading: cLoading } = useCodental();
  const [codental, setCodental] = useState(null);
  const { displayInfo } = useContactsCtx();
  const info = displayInfo(chat.id, chat.name);

  useEffect(() => {
    // Busca pelo nome do contato no Codental
    const nome = info.hasContact ? info.name.split(" ").slice(0, 2).join(" ") : null;
    const telefone = info.phone.replace(/\D/g, "");
    const query = telefone || nome;
    if (!query) return;

    searchPatient(query).then(data => {
      if (data?.patients?.length > 0) setCodental(data.patients[0]);
    });
  }, [chat.id]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <Section label="Dados cadastrais">
        {codental ? (
          <>
            <Field label="Nome"     value={codental.name || codental.fullName} />
            <Field label="CPF"      value={codental.cpf} />
            <Field label="Email"    value={codental.email} />
            <Field label="Convênio" value={codental.health_insurance || codental.convenio} />
            <Field label="Dentista" value={codental.professional?.name} />
            <Field label="ID Codental" value={codental.id} />
          </>
        ) : cLoading ? (
          <div style={{ color: "#3a7055", fontSize: 12 }}>Buscando no Codental...</div>
        ) : (
          <ModuleStub name="Codental — sem resultado" icon="📋" />
        )}
      </Section>
      {/* resto igual */}
    </div>
  );
}
// ── Agendamentos ────────────────────────────────────────────────
function AgendamentosTab() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <Section label="Próximas consultas">
        {/* MODULE: Doctoralia API → GET /appointments?patient={cpf} */}
        <ModuleStub name="Doctoralia Agendamentos" icon="📅" />
      </Section>
      <Section label="Histórico">
        {/* MODULE: Doctoralia API → GET /appointments/history?patient={cpf} */}
        <ModuleStub name="Doctoralia Histórico" icon="🗂️" />
      </Section>
    </div>
  );
}

// ── Evoluções ───────────────────────────────────────────────────
function EvolucoeTab() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <Section label="Últimas evoluções">
        {/* MODULE: Codental API → GET /evolucoes?cpf={cpf}&limit=5 */}
        <ModuleStub name="Codental Evoluções" icon="📝" />
      </Section>
      <Section label="Exames">
        {/* MODULE: Gmail API → buscar anexos de exames por nome/email */}
        <ModuleStub name="Gmail Exames" icon="🦷" />
      </Section>
    </div>
  );
}

// ── Notas internas ──────────────────────────────────────────────
function NotasTab({ chat, operator }) {
  const [nota, setNota] = useState("");
  const [notas, setNotas] = useState([
    { id: 1, text: "Paciente prefere horários matutinos às terças.", author: "Patrícia", time: "Ontem 14:32" },
  ]);

  function addNota() {
    if (!nota.trim()) return;
    setNotas(prev => [...prev, {
      id: Date.now(),
      text: nota.trim(),
      author: operator.name,
      time: "Agora",
    }]);
    setNota("");
    // MODULE: MongoDB → db.notas.insertOne({ chatId, text, author, ts })
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {notas.map(n => (
        <div key={n.id} style={{
          background: "#111a15", border: "1px solid #1e3028",
          borderRadius: 8, padding: "10px 12px",
        }}>
          <div style={{ color: "#c8e8d8", fontSize: 12, lineHeight: 1.5 }}>{n.text}</div>
          <div style={{ color: "#3a7055", fontSize: 10, marginTop: 5 }}>
            {n.author} · {n.time}
          </div>
        </div>
      ))}

      <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
        <textarea
          value={nota}
          onChange={e => setNota(e.target.value)}
          placeholder="Nota interna (visível só para a equipe)..."
          rows={2}
          style={{
            flex: 1, background: "#111a15", border: "1px solid #1e3028",
            borderRadius: 8, padding: "8px 10px", color: "#e8f5ee",
            fontFamily: "'DM Sans', sans-serif", fontSize: 12,
            outline: "none", resize: "none",
          }}
        />
        <button onClick={addNota} style={{
          background: "#1a2e22", border: "1px solid #1e3028",
          borderRadius: 8, padding: "8px 10px", color: "#0d7d62",
          fontSize: 16, cursor: "pointer", alignSelf: "stretch",
        }}>+</button>
      </div>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────
function Section({ label, children }) {
  return (
    <div style={{
      background: "#0d1610", border: "1px solid #1a2e22",
      borderRadius: 8, overflow: "hidden",
    }}>
      <div style={{
        padding: "7px 12px", borderBottom: "1px solid #1a2e22",
        color: "#3a7055", fontSize: 10, fontWeight: 700,
        textTransform: "uppercase", letterSpacing: .8,
      }}>{label}</div>
      <div style={{ padding: "10px 12px" }}>{children}</div>
    </div>
  );
}

function Field({ label, value }) {
  return (
    <div style={{ marginBottom: 7 }}>
      <div style={{ color: "#3a7055", fontSize: 9, fontWeight: 700,
        textTransform: "uppercase", letterSpacing: .5, marginBottom: 1 }}>{label}</div>
      <div style={{ color: "#c8e8d8", fontSize: 12 }}>{value || "—"}</div>
    </div>
  );
}
