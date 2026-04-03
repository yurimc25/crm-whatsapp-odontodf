import { useState, useEffect } from "react";
import { MOCK_PRONTUARIO } from "../data/mock";
import { useContactsCtx } from "../App";
import { wahaIdToPhone, formatPhone } from "../hooks/useContacts";
import { useCodental } from "../hooks/useCodental";

function ModuleStub({ name, icon }) {
  return (
    <div style={{ background:"#0d1610", border:"1px dashed #1e3028",
      borderRadius:8, padding:14, textAlign:"center" }}>
      <div style={{ fontSize:20, marginBottom:6 }}>{icon}</div>
      <div style={{ color:"#2a4a36", fontSize:11, fontWeight:600,
        textTransform:"uppercase", letterSpacing:.5 }}>MODULE: {name}</div>
    </div>
  );
}

export default function PatientPanel({ chat, operator }) {
  const [tab, setTab] = useState("perfil");
  const { displayInfo } = useContactsCtx();
  const info = displayInfo(chat.id, chat.name);

  const TABS = [
    { id:"perfil",       label:"Perfil" },
    { id:"agendamentos", label:"Agenda" },
    { id:"evolucoes",    label:"Evoluções" },
    { id:"notas",        label:"Notas" },
  ];

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%", overflow:"hidden",
      fontFamily:"'DM Sans', sans-serif", background:"#0a0f0d" }}>

      <div style={{ padding:"12px 14px 0", background:"#0d1610", borderBottom:"1px solid #1a2e22" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:12 }}>
          <div style={{ width:40, height:40, borderRadius:12,
            background:chat.avatarColor+"22", color:chat.avatarColor,
            display:"flex", alignItems:"center", justifyContent:"center",
            fontSize:13, fontWeight:700 }}>
            {info.hasContact ? info.name.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase() : chat.avatar}
          </div>
          <div style={{ minWidth:0, flex:1 }}>
            {info.hasContact ? (
              <>
                <div style={{ color:"#e8f5ee", fontSize:14, fontWeight:600,
                  overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{info.name}</div>
                <div style={{ color:"#3a7055", fontSize:11, fontFamily:"'DM Mono', monospace" }}>{info.phone}</div>
              </>
            ) : (
              <>
                <div style={{ color:"#e8f5ee", fontSize:13, fontWeight:600,
                  fontFamily:"'DM Mono', monospace",
                  overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{info.phone}</div>
                <div style={{ color:"#2a5040", fontSize:10 }}>Sem contato cadastrado</div>
              </>
            )}
          </div>
        </div>

        <div style={{ display:"flex", gap:0 }}>
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              flex:1, background:"transparent", border:"none",
              borderBottom: tab===t.id ? "2px solid #0d7d62" : "2px solid transparent",
              padding:"6px 4px", color: tab===t.id ? "#0d7d62" : "#3a7055",
              fontSize:11, fontWeight:600, cursor:"pointer",
              fontFamily:"'DM Sans', sans-serif", transition:"all .15s",
            }}>{t.label}</button>
          ))}
        </div>
      </div>

      <div style={{ flex:1, overflowY:"auto", padding:"12px 14px",
        display:"flex", flexDirection:"column", gap:10 }}>
        {tab === "perfil"       && <PerfilTab chat={chat} />}
        {tab === "agendamentos" && <AgendamentosTab />}
        {tab === "evolucoes"    && <EvolucoeTab />}
        {tab === "notas"        && <NotasTab chat={chat} operator={operator} />}
      </div>
    </div>
  );
}

function PerfilTab({ chat }) {
  const { searchByPhone, searchByName, getUploads, getEvolutions, loading } = useCodental();
  const { displayInfo } = useContactsCtx();
  const [paciente, setPaciente] = useState(null);
  const [uploads, setUploads]   = useState([]);
  const [evols, setEvols]       = useState([]);
  const info = displayInfo(chat.id, chat.name);

  useEffect(() => {
    setPaciente(null); setUploads([]); setEvols([]);

    async function buscar() {
      const phone = info.phone.replace(/\D/g, "");
      let result = phone ? await searchByPhone(phone) : null;
      if (!result?.patients?.length && info.hasContact) {
        result = await searchByName(info.name.split(" ").slice(0, 3).join(" "));
      }
      if (result?.patients?.length > 0) {
        const p = result.patients[0];
        setPaciente(p);
        if (p.id) {
          const [u, e] = await Promise.all([getUploads(p.id), getEvolutions(p.id)]);
          setUploads(u?.uploads || []);
          setEvols(e?.evolutions || []);
        }
      }
    }
    buscar();
  }, [chat.id]);

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
      <Section label="Codental">
        {loading && <div style={{ color:"#3a7055", fontSize:12 }}>Buscando...</div>}
        {!loading && !paciente && <ModuleStub name="Paciente não encontrado" icon="📋" />}
        {paciente && (
          <>
            <Field label="Nome"       value={paciente.name || paciente.fullName} />
            <Field label="CPF"        value={paciente.cpf} />
            <Field label="Email"      value={paciente.email} />
            <Field label="Convênio"   value={paciente.health_insurance || paciente.convenio} />
            <Field label="Nascimento" value={paciente.birthdate || paciente.birthday} />
            <Field label="Dentista"   value={paciente.professional?.name} />
          </>
        )}
      </Section>

      {evols.length > 0 && (
        <Section label={`Evoluções (${evols.length})`}>
          {evols.slice(0, 5).map((e, i) => (
            <div key={i} style={{ marginBottom:8, paddingBottom:8,
              borderBottom: i < evols.length - 1 ? "1px solid #1a2e22" : "none" }}>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:3 }}>
                <span style={{ color:"#0d7d62", fontSize:10, fontWeight:700 }}>
                  {e.professional?.name || e.dentist_name || "Dentista"}
                </span>
                <span style={{ color:"#3a7055", fontSize:10 }}>
                  {e.date || e.created_at
                    ? new Date(e.date || e.created_at).toLocaleDateString("pt-BR")
                    : ""}
                </span>
              </div>
              <div style={{ color:"#c8e8d8", fontSize:11, lineHeight:1.5 }}>
                {(e.description || e.notes || e.content || "").slice(0, 150)}
                {(e.description || e.notes || e.content || "").length > 150 ? "..." : ""}
              </div>
              {e.procedures && e.procedures.length > 0 && (
                <div style={{ color:"#3a7055", fontSize:10, marginTop:4 }}>
                  {e.procedures.map(p => p.name || p).join(", ")}
                </div>
              )}
            </div>
          ))}
        </Section>
      )}

      {uploads.length > 0 && (
        <Section label={`Exames / Uploads (${uploads.length})`}>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(3, 1fr)", gap:6 }}>
            {uploads.slice(0, 9).map((u, i) => {
              const url = u.url || u.service_url || u.file_url;
              const name = u.name || u.filename || u.file_name || `Arquivo ${i+1}`;
              const isImg = /\.(jpg|jpeg|png|gif|webp)/i.test(name);
              const isPdf = /\.pdf/i.test(name);

              return (
                <a key={i} href={url} target="_blank" rel="noreferrer"
                  title={name}
                  style={{
                    display:"block", borderRadius:6, overflow:"hidden",
                    border:"1px solid #1a2e22", textDecoration:"none",
                    background:"#0d1610", cursor: url ? "pointer" : "default",
                  }}>
                  {isImg && url ? (
                    <img src={url} alt={name}
                      style={{ width:"100%", aspectRatio:"1", objectFit:"cover",
                        display:"block" }}
                      onError={e => { e.target.style.display="none"; }}
                    />
                  ) : (
                    <div style={{ aspectRatio:"1", display:"flex", flexDirection:"column",
                      alignItems:"center", justifyContent:"center", padding:4 }}>
                      <div style={{ fontSize:20 }}>{isPdf ? "📄" : "📎"}</div>
                    </div>
                  )}
                  <div style={{ padding:"3px 5px", color:"#3a7055", fontSize:9,
                    overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                    {name}
                  </div>
                </a>
              );
            })}
          </div>
        </Section>
      )}
    </div>
  );
}

function AgendamentosTab() {
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
      <Section label="Próximas consultas">
        <ModuleStub name="Doctoralia Agendamentos" icon="📅" />
      </Section>
      <Section label="Histórico">
        <ModuleStub name="Doctoralia Histórico" icon="🗂️" />
      </Section>
    </div>
  );
}

function EvolucoeTab() {
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
      <Section label="Evoluções e exames">
        <div style={{ color:"#3a7055", fontSize:12 }}>
          Evoluções e exames aparecem automaticamente na aba Perfil após identificar o paciente no Codental.
        </div>
      </Section>
      <Section label="Gmail — exames por email">
        <ModuleStub name="Gmail Exames" icon="📧" />
      </Section>
    </div>
  );
}

function NotasTab({ chat, operator }) {
  const [nota, setNota]   = useState("");
  const [notas, setNotas] = useState([
    { id:1, text:"Paciente prefere horários matutinos às terças.", author:"Patrícia", time:"Ontem 14:32" },
  ]);

  function addNota() {
    if (!nota.trim()) return;
    setNotas(prev => [...prev, {
      id: Date.now(), text: nota.trim(),
      author: operator.name, time: "Agora",
    }]);
    setNota("");
  }

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
      {notas.map(n => (
        <div key={n.id} style={{ background:"#111a15", border:"1px solid #1e3028",
          borderRadius:8, padding:"10px 12px" }}>
          <div style={{ color:"#c8e8d8", fontSize:12, lineHeight:1.5 }}>{n.text}</div>
          <div style={{ color:"#3a7055", fontSize:10, marginTop:5 }}>{n.author} · {n.time}</div>
        </div>
      ))}
      <div style={{ display:"flex", gap:6 }}>
        <textarea value={nota} onChange={e => setNota(e.target.value)}
          placeholder="Nota interna..." rows={2}
          style={{ flex:1, background:"#111a15", border:"1px solid #1e3028",
            borderRadius:8, padding:"8px 10px", color:"#e8f5ee",
            fontFamily:"'DM Sans', sans-serif", fontSize:12, outline:"none", resize:"none" }} />
        <button onClick={addNota} style={{ background:"#1a2e22", border:"1px solid #1e3028",
          borderRadius:8, padding:"8px 10px", color:"#0d7d62",
          fontSize:16, cursor:"pointer", alignSelf:"stretch" }}>+</button>
      </div>
    </div>
  );
}

function Section({ label, children }) {
  return (
    <div style={{ background:"#0d1610", border:"1px solid #1a2e22", borderRadius:8, overflow:"hidden" }}>
      <div style={{ padding:"7px 12px", borderBottom:"1px solid #1a2e22",
        color:"#3a7055", fontSize:10, fontWeight:700,
        textTransform:"uppercase", letterSpacing:.8 }}>{label}</div>
      <div style={{ padding:"10px 12px" }}>{children}</div>
    </div>
  );
}

function Field({ label, value }) {
  return (
    <div style={{ marginBottom:7 }}>
      <div style={{ color:"#3a7055", fontSize:9, fontWeight:700,
        textTransform:"uppercase", letterSpacing:.5, marginBottom:1 }}>{label}</div>
      <div style={{ color:"#c8e8d8", fontSize:12 }}>{value || "—"}</div>
    </div>
  );
}