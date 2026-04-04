import { useState, useEffect } from "react";
import { useContactsCtx } from "../App";
import { useCodental } from "../hooks/useCodental";
import { FileLightbox } from "./ChatWindow";

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
  const { displayInfo, addLocalContact } = useContactsCtx();
  const info = displayInfo(chat.id, chat.name, chat.pushname);

  const { searchByPhone, searchByName, getUploads, getEvolutions } = useCodental();
  const [pacientes, setPacientes]   = useState([]); // todos os pacientes encontrados
  const [paciente, setPaciente]     = useState(null); // paciente selecionado
  const [uploads, setUploads]       = useState([]);
  const [evols, setEvols]           = useState(null);
  const [buscando, setBuscando]     = useState(false);
  const [buscandoDados, setBuscandoDados] = useState(false);

  // Busca todos os pacientes com aquele número
  useEffect(() => {
    setPacientes([]); setPaciente(null); setUploads([]); setEvols(null); setBuscando(true);
    async function buscar() {
      try {
        const phone = info.phone.replace(/\D/g, "");
        let result = phone ? await searchByPhone(phone) : null;
        if (!result?.patients?.length && info.hasContact) {
          result = await searchByName(info.name.split(" ").slice(0,3).join(" "));
        }
        if (result?.patients?.length > 0) {
          setPacientes(result.patients);
          // Seleciona o primeiro automaticamente
          carregarPaciente(result.patients[0]);
          // Registra o primeiro no mapa de contatos
          const patientName = result.patients[0].name || result.patients[0].fullName;
          const chatPhone   = info.phone.replace(/\D/g, "");
          if (patientName && chatPhone) addLocalContact({ phone: chatPhone, name: patientName });
        } else {
          setEvols([]);
        }
      } catch { setEvols([]); }
      finally { setBuscando(false); }
    }
    buscar();
  }, [chat.id]);

  // Carrega uploads e evoluções do paciente selecionado
  async function carregarPaciente(p) {
    setPaciente(p);
    setUploads([]); setEvols(null); setBuscandoDados(true);
    try {
      if (p.id) {
        const [u, e] = await Promise.all([getUploads(p.id), getEvolutions(p.id)]);
        setUploads(u?.uploads || []);
        if (e?.error) { console.warn("[evoluções]", e.error); setEvols([]); }
        else setEvols(e?.evolutions || []);
      }
    } catch { setEvols([]); }
    finally { setBuscandoDados(false); }
  }

  const TABS = [
    { id:"perfil",       label:"Perfil"     },
    { id:"agendamentos", label:"Agenda"     },
    { id:"evolucoes",    label:"Evoluções"  },
    { id:"notas",        label:"Notas"      },
  ];

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%", overflow:"hidden",
      fontFamily:"'DM Sans', sans-serif", background:T.bg }}>

      {/* Cabeçalho */}
      <div style={{ padding:"12px 14px 0", background:T.header,
        borderBottom:`1px solid ${T.border}` }}>
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:12 }}>
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
            {info.hasContact
              ? <div style={{ color:T.sub, fontSize:11, fontFamily:"'DM Mono', monospace" }}>{info.phone}</div>
              : <div style={{ color:"#444", fontSize:10 }}>Sem contato cadastrado</div>}
          </div>
        </div>
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

      {/* Seletor de pacientes — aparece quando há mais de um no mesmo número */}
      {pacientes.length > 1 && (
        <div style={{ padding:"8px 14px", borderBottom:`1px solid ${T.border}`,
          background:"#141414" }}>
          <div style={{ color:T.sub, fontSize:10, fontWeight:700,
            textTransform:"uppercase", letterSpacing:.5, marginBottom:6 }}>
            {pacientes.length} pacientes neste número — selecione:
          </div>
          <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
            {pacientes.map(p => (
              <button key={p.id} onClick={() => carregarPaciente(p)}
                style={{
                  display:"flex", alignItems:"center", gap:8,
                  background: paciente?.id === p.id ? T.accentBg : "transparent",
                  border: `1px solid ${paciente?.id === p.id ? T.accent+"66" : T.border}`,
                  borderRadius:6, padding:"6px 10px", cursor:"pointer",
                  textAlign:"left", transition:"all .15s",
                }}>
                <div style={{ width:6, height:6, borderRadius:"50%", flexShrink:0,
                  background: paciente?.id === p.id ? T.accent : T.sub }} />
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ color: paciente?.id === p.id ? T.accent : T.text,
                    fontSize:12, fontWeight:600,
                    overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                    {p.name || p.fullName || "—"}
                  </div>
                  {(p.birthdate || p.birthday) && (
                    <div style={{ color:T.sub, fontSize:10 }}>
                      Nasc. {p.birthdate || p.birthday}
                    </div>
                  )}
                </div>
                {paciente?.id === p.id && (
                  <span style={{ color:T.accent, fontSize:11 }}>✓</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Conteúdo */}
      <div style={{ flex:1, overflowY:"auto", padding:"12px 14px",
        display:"flex", flexDirection:"column", gap:10 }}>
        {tab === "perfil"       && <PerfilTab paciente={paciente} uploads={uploads} evols={evols} buscando={buscando || buscandoDados} />}
        {tab === "agendamentos" && <AgendamentosTab />}
        {tab === "evolucoes"    && <EvolucoeTab paciente={paciente} evols={evols} uploads={uploads} buscando={buscando || buscandoDados} />}
        {tab === "notas"        && <NotasTab chat={chat} operator={operator} />}
      </div>
    </div>
  );
}

// ── Aba Perfil ────────────────────────────────────────────────────
function PerfilTab({ paciente, uploads, evols, buscando }) {
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
      <Section label="Codental">
        {buscando && <div style={{ color:T.sub, fontSize:12 }}>Buscando...</div>}
        {!buscando && !paciente && <div style={{ color:T.sub, fontSize:12 }}>Paciente não encontrado no Codental.</div>}
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
                  background:T.accentBg, color:T.accent, border:`1px solid ${T.accent}44`,
                  borderRadius:6, padding:"6px 0", fontSize:11, fontWeight:600,
                  textDecoration:"none" }}>
                Abrir prontuário no Codental →
              </a>
            )}
          </>
        )}
      </Section>

      {/* Últimas 3 evoluções */}
      {evols !== null && evols.length > 0 && (
        <Section label={`Evoluções (${evols.length})`}>
          {evols.slice(0,3).map((e,i) => (
            <div key={e.id || i} style={{ marginBottom:8, paddingBottom:8,
              borderBottom: i < Math.min(evols.length,3)-1 ? `1px solid ${T.border}` : "none" }}>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:2 }}>
                <span style={{ color:T.accent, fontSize:10, fontWeight:700 }}>
                  {e.dentista || e.dentist || ""}
                </span>
                <span style={{ color:T.sub, fontSize:10 }}>
                  {e.data || (e.date ? e.date.split(" ")[0] : "")}
                </span>
              </div>
              <div style={{ color:T.text, fontSize:11, lineHeight:1.5 }}>
                {(e.texto || e.description || "").slice(0,100)}
                {(e.texto || e.description || "").length > 100 ? "..." : ""}
              </div>
            </div>
          ))}
          {evols.length > 3 && (
            <div style={{ color:T.sub, fontSize:10, textAlign:"center" }}>
              + {evols.length - 3} na aba Evoluções
            </div>
          )}
        </Section>
      )}

      {/* Miniaturas de arquivos */}
      {uploads.length > 0 && (
        <Section label={`Arquivos (${uploads.length})`}>
          <UploadsGrid uploads={uploads} paciente={paciente} maxItems={6} />
        </Section>
      )}
    </div>
  );
}

// ── Aba Agenda ────────────────────────────────────────────────────
function AgendamentosTab() {
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
      <Section label="Próximas consultas">
        <div style={{ color:T.sub, fontSize:12, textAlign:"center", padding:8 }}>
          Em breve — integração Doctoralia
        </div>
      </Section>
    </div>
  );
}

// ── Aba Evoluções ─────────────────────────────────────────────────
function EvolucoeTab({ paciente, evols, uploads, buscando }) {
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:10 }}>

      {/* Evoluções */}
      <Section label={evols !== null ? `Evoluções (${evols?.length ?? 0})` : "Evoluções"}>
        {buscando && <div style={{ color:T.sub, fontSize:12, textAlign:"center", padding:"16px 0" }}>Buscando...</div>}
        {!buscando && !paciente && <div style={{ color:T.sub, fontSize:12 }}>Paciente não encontrado no Codental.</div>}
        {!buscando && paciente && evols !== null && evols.length === 0 && (
          <div style={{ color:T.sub, fontSize:12 }}>Nenhuma evolução registrada.</div>
        )}
        {!buscando && paciente && evols !== null && evols.length > 0 && (
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
                <div style={{ color:T.text, fontSize:13, fontWeight:500, lineHeight:1.5, marginBottom:4 }}>
                  {e.texto || e.description || "—"}
                </div>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:4 }}>
                  <span style={{ color:T.sub, fontSize:10 }}>
                    {[e.data, e.hora].filter(Boolean).join(" ")}
                  </span>
                  <span style={{ color:T.accent, fontSize:10, fontWeight:600,
                    overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:160 }}>
                    {e.dentista || e.dentist || ""}
                  </span>
                </div>
                {(e.assinado || e.signed) && (
                  <span style={{ fontSize:9, color:T.green, fontWeight:700, marginTop:4,
                    display:"inline-block", background:T.greenBg, padding:"1px 6px", borderRadius:4 }}>
                    ✓ Assinado
                  </span>
                )}
              </div>
            ))}
          </>
        )}
      </Section>

      {/* Arquivos do Paciente */}
      <Section label={uploads?.length ? `Arquivos do Paciente (${uploads.length})` : "Arquivos do Paciente"}>
        {buscando && <div style={{ color:T.sub, fontSize:12, textAlign:"center", padding:"8px 0" }}>Buscando arquivos...</div>}
        {!buscando && !paciente && <div style={{ color:T.sub, fontSize:12 }}>Paciente não encontrado.</div>}
        {!buscando && paciente && (!uploads || uploads.length === 0) && (
          <div style={{ color:T.sub, fontSize:12 }}>Nenhum arquivo enviado.</div>
        )}
        {!buscando && uploads?.length > 0 && (
          <>
            {paciente?.id && (
              <a href={`https://app.codental.com.br/patients/${paciente.id}/uploads`}
                target="_blank" rel="noreferrer"
                style={{ display:"block", marginBottom:10, textAlign:"center",
                  background:T.accentBg, color:T.accent, border:`1px solid ${T.accent}44`,
                  borderRadius:6, padding:"5px 0", fontSize:11, fontWeight:600,
                  textDecoration:"none" }}>
                Ver todos no Codental →
              </a>
            )}
            <UploadsGrid uploads={uploads} paciente={paciente} maxItems={12} />
            {uploads.length > 12 && (
              <div style={{ color:T.sub, fontSize:10, textAlign:"center", marginTop:4 }}>
                +{uploads.length - 12} arquivos no Codental
              </div>
            )}
          </>
        )}
      </Section>
    </div>
  );
}

// ── Grid de uploads reutilizável ──────────────────────────────────
function UploadsGrid({ uploads, paciente, maxItems = 9 }) {
  const [lightbox, setLightbox] = useState(null); // arquivo selecionado

  return (
    <>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:6 }}>
        {uploads.slice(0, maxItems).map((u, i) => {
          const downloadUrl = u.url || u.download_url || u.service_url;
          const previewUrl  = u.preview_url || u.url || u.service_url;
          const name  = u.name || u.filename || u.title || `Arquivo ${i+1}`;
          const ct    = u.content_type || u.mime_type || "";
          const isImg = /\.(jpg|jpeg|png|gif|webp|bmp)/i.test(name) || ct.startsWith("image/");
          const isPdf = /\.pdf/i.test(name) || ct === "application/pdf";

          return (
            <div key={u.id || i} onClick={() => setLightbox(u)}
              title={name}
              style={{ borderRadius:8, overflow:"hidden",
                background:T.inputBg, border:`1px solid ${T.border}`,
                cursor:"pointer", aspectRatio:"1",
                transition:"border-color .15s, transform .1s" }}
              onMouseEnter={e => { e.currentTarget.style.borderColor=T.accent; e.currentTarget.style.transform="scale(1.03)"; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor=T.border; e.currentTarget.style.transform="scale(1)"; }}>

              {isImg && previewUrl ? (
                <img src={previewUrl} alt={name}
                  style={{ width:"100%", height:"100%", objectFit:"cover", display:"block" }}
                  onError={e => { e.target.style.display="none"; }} />
              ) : (
                <div style={{ width:"100%", height:"100%", display:"flex",
                  flexDirection:"column", alignItems:"center",
                  justifyContent:"center", gap:4, padding:6 }}>
                  <span style={{ fontSize:22 }}>
                    {isPdf ? "📄" : isImg ? "🖼️" : "📎"}
                  </span>
                  <span style={{ color:T.sub, fontSize:8, textAlign:"center",
                    overflow:"hidden", textOverflow:"ellipsis",
                    width:"100%", whiteSpace:"nowrap", padding:"0 2px" }}>
                    {name.length > 18 ? name.slice(0,15)+"..." : name}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {lightbox && (
        <FileLightbox file={lightbox} onClose={() => setLightbox(null)} />
      )}
    </>
  );
}

// ── Aba Notas ─────────────────────────────────────────────────────
function NotasTab({ chat, operator }) {
  const [nota, setNota]   = useState("");
  const [notas, setNotas] = useState([]);

  function addNota() {
    if (!nota.trim()) return;
    setNotas(prev => [...prev, {
      id:Date.now(), text:nota.trim(), author:operator.name, time:"Agora",
    }]);
    setNota("");
  }

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
      {notas.length === 0 && (
        <div style={{ color:T.sub, fontSize:12, textAlign:"center", padding:8 }}>
          Nenhuma nota ainda. Adicione observações internas sobre este paciente.
        </div>
      )}
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