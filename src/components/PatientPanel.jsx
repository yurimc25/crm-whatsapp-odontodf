import { useState, useEffect } from "react";
import { useContactsCtx } from "../App";
import { useCodental } from "../hooks/useCodental";

const T = {
  bg:       "#212121",
  header:   "#1a1a1a",
  section:  "#252525",
  border:   "#2d2d2d",
  text:     "#ececec",
  sub:      "#8e8e8e",
  accent:   "#d4956a",
  accentBg: "#3a2a1e",
  green:    "#4caf87",
  greenBg:  "#1a2e22",
  inputBg:  "#2d2d2d",
  stub:     "#1e1e1e",
};

function ModuleStub({ name, icon }) {
  return (
    <div style={{ background:T.stub, border:`1px dashed ${T.border}`,
      borderRadius:8, padding:14, textAlign:"center" }}>
      <div style={{ fontSize:20, marginBottom:6 }}>{icon}</div>
      <div style={{ color:"#444", fontSize:11, fontWeight:600,
        textTransform:"uppercase", letterSpacing:.5 }}>
        {name}
      </div>
    </div>
  );
}

function Section({ label, children }) {
  return (
    <div style={{ background:T.section, border:`1px solid ${T.border}`,
      borderRadius:8, overflow:"hidden" }}>
      <div style={{ padding:"7px 12px", borderBottom:`1px solid ${T.border}`,
        color:T.sub, fontSize:10, fontWeight:700,
        textTransform:"uppercase", letterSpacing:.8 }}>
        {label}
      </div>
      <div style={{ padding:"10px 12px" }}>{children}</div>
    </div>
  );
}

function Field({ label, value }) {
  return (
    <div style={{ marginBottom:7 }}>
      <div style={{ color:T.sub, fontSize:9, fontWeight:700,
        textTransform:"uppercase", letterSpacing:.5, marginBottom:1 }}>
        {label}
      </div>
      <div style={{ color: value ? T.text : "#444", fontSize:12 }}>{value || "—"}</div>
    </div>
  );
}

export default function PatientPanel({ chat, operator }) {
  const [tab, setTab] = useState("perfil");
  const { displayInfo } = useContactsCtx();
  const info = displayInfo(chat.id, chat.name);

  const TABS = [
    { id:"perfil",       label:"Perfil"     },
    { id:"agendamentos", label:"Agenda"     },
    { id:"evolucoes",    label:"Evoluções"  },
    { id:"notas",        label:"Notas"      },
  ];

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%", overflow:"hidden",
      fontFamily:"'DM Sans', sans-serif", background:T.bg }}>

      {/* Cabeçalho do paciente */}
      <div style={{ padding:"12px 14px 0", background:T.header,
        borderBottom:`1px solid ${T.border}` }}>
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:12 }}>

          {/* Avatar */}
          {(info.photoUrl || chat.photoUrl) ? (
            <img src={info.photoUrl || chat.photoUrl} alt=""
              style={{ width:40, height:40, borderRadius:"50%", objectFit:"cover",
                flexShrink:0, border:`2px solid ${T.border}` }} />
          ) : (
            <div style={{ width:40, height:40, borderRadius:"50%", flexShrink:0,
              background:chat.avatarColor+"33", color:chat.avatarColor,
              display:"flex", alignItems:"center", justifyContent:"center",
              fontSize:13, fontWeight:700, border:`2px solid ${chat.avatarColor}44` }}>
              {info.hasContact
                ? info.name.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase()
                : chat.avatar}
            </div>
          )}

          <div style={{ minWidth:0, flex:1 }}>
            <div style={{ color:T.text, fontSize:14, fontWeight:600,
              overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
              {info.hasContact ? info.name : info.phone}
            </div>
            {info.hasContact ? (
              <div style={{ color:T.sub, fontSize:11, fontFamily:"'DM Mono', monospace" }}>
                {info.phone}
              </div>
            ) : (
              <div style={{ color:"#444", fontSize:10 }}>Sem contato cadastrado</div>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display:"flex" }}>
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              flex:1, background:"transparent", border:"none",
              borderBottom: tab===t.id ? `2px solid ${T.accent}` : "2px solid transparent",
              padding:"6px 4px", color: tab===t.id ? T.accent : T.sub,
              fontSize:11, fontWeight:600, cursor:"pointer", transition:"all .15s" }}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Conteúdo */}
      <div style={{ flex:1, overflowY:"auto", padding:"12px 14px",
        display:"flex", flexDirection:"column", gap:10 }}>
        {tab === "perfil"       && <PerfilTab chat={chat} />}
        {tab === "agendamentos" && <AgendamentosTab />}
        {tab === "evolucoes"    && <EvolucoeTab chat={chat} />}
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
        result = await searchByName(info.name.split(" ").slice(0,3).join(" "));
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
    <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
      <Section label="Codental">
        {loading && <div style={{ color:T.sub, fontSize:12 }}>Buscando...</div>}
        {!loading && !paciente && <ModuleStub name="Paciente não encontrado" icon="📋" />}
        {paciente && (
          <>
            <Field label="Nome"       value={paciente.name || paciente.fullName} />
            <Field label="CPF"        value={paciente.cpf} />
            <Field label="Email"      value={paciente.email} />
            <Field label="Convênio"   value={paciente.health_insurance || paciente.convenio} />
            <Field label="Nascimento" value={paciente.birthdate || paciente.birthday} />
            <Field label="Dentista"   value={paciente.professional?.name} />
            {paciente.id && (
              <a href={`https://app.codental.com.br/patients/${paciente.id}`}
                target="_blank" rel="noreferrer"
                style={{ display:"block", marginTop:8, textAlign:"center",
                  background:T.accentBg, color:T.accent,
                  border:`1px solid ${T.accent}44`, borderRadius:6,
                  padding:"6px 0", fontSize:11, fontWeight:600,
                  textDecoration:"none" }}>
                Abrir no Codental →
              </a>
            )}
          </>
        )}
      </Section>

      {evols.length > 0 && (
        <Section label={`Evoluções (${evols.length})`}>
          {evols.slice(0,5).map((e,i) => (
            <div key={i} style={{ marginBottom:8, paddingBottom:8,
              borderBottom: i < Math.min(evols.length,5)-1 ? `1px solid ${T.border}` : "none" }}>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:2 }}>
                <span style={{ color:T.accent, fontSize:10, fontWeight:700 }}>
                  {e.dentist || e.professional?.name || "Dentista"}
                </span>
                <span style={{ color:T.sub, fontSize:10 }}>
                  {e.date ? e.date.split(" ")[0] : ""}
                </span>
              </div>
              <div style={{ color:T.text, fontSize:11, lineHeight:1.5 }}>
                {(e.description || e.notes || "").slice(0,120)}
                {(e.description || e.notes || "").length > 120 ? "..." : ""}
              </div>
              {e.signed && (
                <span style={{ fontSize:9, color:T.green, fontWeight:700,
                  marginTop:3, display:"inline-block" }}>✓ Assinado</span>
              )}
            </div>
          ))}
        </Section>
      )}

      {uploads.length > 0 && (
        <Section label={`Exames (${uploads.length})`}>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:6 }}>
            {uploads.slice(0,9).map((u,i) => {
              const url  = u.url || u.service_url || u.file_url;
              const name = u.name || u.filename || `Arquivo ${i+1}`;
              const isImg = /\.(jpg|jpeg|png|gif|webp)/i.test(name);
              const isPdf = /\.pdf/i.test(name);
              return (
                <a key={i} href={url} target="_blank" rel="noreferrer" title={name}
                  style={{ display:"block", borderRadius:6, overflow:"hidden",
                    border:`1px solid ${T.border}`, background:T.stub,
                    textDecoration:"none", cursor:url?"pointer":"default" }}>
                  {isImg && url ? (
                    <img src={url} alt={name}
                      style={{ width:"100%", aspectRatio:"1", objectFit:"cover", display:"block" }}
                      onError={e => { e.target.style.display="none"; }} />
                  ) : (
                    <div style={{ aspectRatio:"1", display:"flex", alignItems:"center",
                      justifyContent:"center" }}>
                      <span style={{ fontSize:22 }}>{isPdf ? "📄" : "📎"}</span>
                    </div>
                  )}
                  <div style={{ padding:"3px 5px", color:T.sub, fontSize:9,
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
    <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
      <Section label="Próximas consultas">
        <ModuleStub name="Doctoralia Agendamentos" icon="📅" />
      </Section>
      <Section label="Histórico">
        <ModuleStub name="Doctoralia Histórico" icon="🗂️" />
      </Section>
    </div>
  );
}

function EvolucoeTab({ chat }) {
  const { searchByPhone, searchByName, getEvolutions } = useCodental();
  const { displayInfo } = useContactsCtx();
  const [evols, setEvols]         = useState(null); // null = ainda carregando
  const [paciente, setPaciente]   = useState(null);
  const [erro, setErro]           = useState(null);
  const info = displayInfo(chat.id, chat.name);

  useEffect(() => {
    setEvols(null); setPaciente(null); setErro(null);
    async function buscar() {
      try {
        const phone = info.phone.replace(/\D/g, "");
        let result = phone ? await searchByPhone(phone) : null;
        if (!result?.patients?.length && info.hasContact) {
          result = await searchByName(info.name.split(" ").slice(0,3).join(" "));
        }
        if (!result?.patients?.length) {
          setEvols([]);
          setErro("Paciente não encontrado no Codental");
          return;
        }
        const p = result.patients[0];
        setPaciente(p);
        const e = await getEvolutions(p.id);
        setEvols(e?.evolutions || []);
      } catch (err) {
        setErro(err.message);
        setEvols([]);
      }
    }
    buscar();
  }, [chat.id]);

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
      <Section label={evols !== null ? `Evoluções (${evols.length})` : "Evoluções"}>

        {/* Carregando */}
        {evols === null && (
          <div style={{ color:T.sub, fontSize:12, textAlign:"center", padding:"16px 0" }}>
            Buscando evoluções...
          </div>
        )}

        {/* Erro / não encontrado */}
        {evols !== null && erro && (
          <div style={{ color:T.sub, fontSize:12 }}>{erro}</div>
        )}

        {/* Vazio */}
        {evols !== null && !erro && evols.length === 0 && (
          <div style={{ color:T.sub, fontSize:12 }}>Nenhuma evolução registrada.</div>
        )}

        {/* Lista de evoluções */}
        {evols !== null && evols.length > 0 && (
          <>
            {paciente?.id && (
              <a href={`https://app.codental.com.br/patients/${paciente.id}/evolutions`}
                target="_blank" rel="noreferrer"
                style={{ display:"block", marginBottom:10, textAlign:"center",
                  background:T.accentBg, color:T.accent, border:`1px solid ${T.accent}44`,
                  borderRadius:6, padding:"5px 0", fontSize:11, fontWeight:600,
                  textDecoration:"none" }}>
                Abrir no Codental →
              </a>
            )}
            {evols.map((e, i) => (
              <div key={e.id || i} style={{
                marginBottom: i < evols.length-1 ? 10 : 0,
                paddingBottom: i < evols.length-1 ? 10 : 0,
                borderBottom: i < evols.length-1 ? `1px solid ${T.border}` : "none",
              }}>
                {/* Texto da evolução */}
                <div style={{ color:T.text, fontSize:13, fontWeight:500,
                  lineHeight:1.5, marginBottom:4 }}>
                  {e.texto || e.description || e.notes || "—"}
                </div>

                {/* Data + Dentista */}
                <div style={{ display:"flex", justifyContent:"space-between",
                  alignItems:"center", flexWrap:"wrap", gap:4 }}>
                  <span style={{ color:T.sub, fontSize:10 }}>
                    {[e.data, e.hora].filter(Boolean).join(" ")}
                  </span>
                  <span style={{ color:T.accent, fontSize:10, fontWeight:600,
                    overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
                    maxWidth:160 }}>
                    {e.dentista || e.dentist || e.professional?.name || ""}
                  </span>
                </div>

                {/* Badge assinado */}
                {(e.assinado || e.signed) && (
                  <span style={{ fontSize:9, color:T.green, fontWeight:700,
                    marginTop:4, display:"inline-block",
                    background:T.greenBg, padding:"1px 6px", borderRadius:4 }}>
                    ✓ Assinado
                  </span>
                )}
              </div>
            ))}
          </>
        )}
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
    { id:1, text:"Paciente prefere horários matutinos às terças.",
      author:"Patrícia", time:"Ontem 14:32" },
  ]);

  function addNota() {
    if (!nota.trim()) return;
    setNotas(prev => [...prev, {
      id:Date.now(), text:nota.trim(), author:operator.name, time:"Agora",
    }]);
    setNota("");
  }

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
      {notas.map(n => (
        <div key={n.id} style={{ background:T.section, border:`1px solid ${T.border}`,
          borderRadius:8, padding:"10px 12px" }}>
          <div style={{ color:T.text, fontSize:12, lineHeight:1.5 }}>{n.text}</div>
          <div style={{ color:T.sub, fontSize:10, marginTop:5 }}>
            {n.author} · {n.time}
          </div>
        </div>
      ))}
      <div style={{ display:"flex", gap:6 }}>
        <textarea value={nota} onChange={e => setNota(e.target.value)}
          placeholder="Nota interna (visível só para a equipe)..."
          rows={2} style={{ flex:1, background:T.inputBg, border:`1px solid ${T.border}`,
            borderRadius:8, padding:"8px 10px", color:T.text,
            fontSize:12, outline:"none", resize:"none",
            fontFamily:"'DM Sans', sans-serif" }}
          onFocus={e => e.target.style.borderColor=T.accent}
          onBlur={e => e.target.style.borderColor=T.border} />
        <button onClick={addNota} style={{ background:T.accentBg,
          border:`1px solid ${T.accent}44`, borderRadius:8,
          padding:"8px 12px", color:T.accent, fontSize:16,
          cursor:"pointer", alignSelf:"stretch" }}>+</button>
      </div>
    </div>
  );
}