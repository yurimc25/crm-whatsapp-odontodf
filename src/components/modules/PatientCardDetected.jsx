import { useState } from "react";

const T = {
  bg:       "#212121",
  bubble:   "#2d2d2d",
  border:   "#383838",
  card:     "#252525",
  cardBord: "#d4956a44",
  text:     "#ececec",
  sub:      "#8e8e8e",
  accent:   "#d4956a",
  accentBg: "#3a2a1e",
  green:    "#4caf87",
  greenBg:  "#1a2e22",
  warn:     "#c9a84c",
  warnBg:   "#2a2010",
  inputBg:  "#1e1e1e",
  fieldBg:  "#1a1a1a",
};

const CAMPOS = ["nome","cpf","convenio","nascimento","email","telefone"];

function parsePatientData(text) {
  const fields = {};
  for (const line of text.split("\n")) {
    const [key, ...rest] = line.split(":");
    const val = rest.join(":").trim();
    const k = key?.toLowerCase().trim() || "";
    if (k.includes("nome"))                                     fields.nome = val;
    if (k.includes("cpf"))                                      fields.cpf = val.replace(/\D/g,"");
    if (k.includes("e-mail") || k.includes("email"))           fields.email = val;
    if (k.includes("convênio") || k.includes("convenio") ||
        k.includes("particular") || k.includes("plano"))        fields.convenio = val;
    if (k.includes("telefone") || k.includes("celular") ||
        k.includes("carteirinha") || k.includes("número do"))   fields.telefone = val;
    if (k.includes("nascimento") || k.includes("data de"))      fields.nascimento = val;
  }
  return fields;
}

function isTemplateVazio(text) {
  const labels = ["Nome completo:","CPF:","E-mail:","Convênio","Telefone:","Data de nascimento:","Número do cartão"];
  const temLabels = labels.filter(l => text.includes(l)).length >= 3;
  if (!temLabels) return false;
  // Checa se todas as linhas com ":" têm valor vazio depois
  const linhas = text.split("\n").map(l => l.trim()).filter(Boolean);
  const comValor = linhas.filter(l => {
    const idx = l.indexOf(":");
    if (idx === -1) return false;
    const val = l.slice(idx+1).trim();
    return val.length > 0;
  });
  return comValor.length === 0;
}

export default function PatientCardDetected({ msg }) {
  const [showModal, setShowModal] = useState(false);
  const [modalAction, setModalAction] = useState(null); // "codental" | "doctoralia"
  const [status, setStatus]  = useState("idle");
  const data = parsePatientData(msg.text);

  // Não exibe card se template vazio
  if (isTemplateVazio(msg.text)) {
    return (
      <div style={{ display:"flex", justifyContent:"flex-start", marginBottom:2 }}>
        <div style={{ maxWidth:"70%", background:T.bubble, border:`1px solid ${T.border}`,
          borderRadius:"2px 12px 12px 12px", padding:"8px 12px",
          boxShadow:"0 1px 3px rgba(0,0,0,.3)" }}>
          <div style={{ color:T.text, fontSize:13, lineHeight:1.55, whiteSpace:"pre-wrap" }}>
            {msg.text}
          </div>
          <div style={{ color:T.sub, fontSize:10, marginTop:4, textAlign:"right" }}>
            {msg.time}
          </div>
        </div>
      </div>
    );
  }

  const camposVazios = CAMPOS.filter(c => !data[c] || data[c].trim() === "");
  const algumDado    = CAMPOS.some(c => data[c] && data[c].trim() !== "");

  function handleAction(action) {
    if (camposVazios.length > 0) {
      setModalAction(action);
      setShowModal(true);
    } else {
      executar(action, data);
    }
  }

  function executar(action, formData) {
    setStatus("loading");
    setTimeout(() => {
      console.log(`[${action}] dados:`, formData);
      setStatus("success_" + action);
    }, 1000);
  }

  const isSuccess = status.startsWith("success");

  return (
    <>
      <div style={{ display:"flex", justifyContent:"flex-start", marginBottom:2 }}>
        <div style={{ maxWidth:"78%" }}>
          {/* Bolha original */}
          <div style={{ background:T.bubble, border:`1px solid ${T.border}`,
            borderRadius:"2px 12px 0 0", padding:"8px 12px",
            boxShadow:"0 1px 3px rgba(0,0,0,.3)" }}>
            <div style={{ color:T.text, fontSize:13, lineHeight:1.55, whiteSpace:"pre-wrap" }}>
              {msg.text}
            </div>
            <div style={{ color:T.sub, fontSize:10, marginTop:4, textAlign:"right" }}>
              {msg.time}
            </div>
          </div>

          {/* Card detectado */}
          <div style={{ background:T.card, border:`1px solid ${T.cardBord}`,
            borderRadius:"0 0 12px 12px", padding:"10px 12px",
            borderTop:`2px solid ${T.accent}` }}>

            {/* Título */}
            <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:8 }}>
              <span style={{ fontSize:13 }}>🦷</span>
              <span style={{ fontSize:10, fontWeight:700, color:T.accent,
                textTransform:"uppercase", letterSpacing:.5 }}>
                Dados de Paciente Detectados
              </span>
              {camposVazios.length > 0 ? (
                <span style={{ marginLeft:"auto", fontSize:9, fontWeight:700,
                  color:T.warn, background:T.warnBg,
                  padding:"2px 6px", borderRadius:4 }}>
                  {camposVazios.length} ausente{camposVazios.length>1?"s":""}
                </span>
              ) : (
                <span style={{ marginLeft:"auto", fontSize:9, fontWeight:700,
                  color:T.green, background:T.greenBg,
                  padding:"2px 6px", borderRadius:4 }}>
                  Completo
                </span>
              )}
            </div>

            {/* Grid de dados */}
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr",
              gap:"5px 12px", marginBottom:10 }}>
              {[["nome","Nome"],["cpf","CPF"],["convenio","Convênio"],
                ["nascimento","Nascimento"],["email","Email"],["telefone","Telefone"]
              ].map(([k,l]) => (
                <div key={k}>
                  <div style={{ fontSize:9, fontWeight:700, color:T.sub,
                    textTransform:"uppercase", letterSpacing:.5, marginBottom:1 }}>{l}</div>
                  <div style={{ fontSize:12,
                    color: data[k] ? T.text : "#555",
                    fontFamily: k==="cpf"||k==="telefone" ? "'DM Mono',monospace" : "inherit" }}>
                    {k==="cpf" && data[k]
                      ? data[k].replace(/(\d{3})(\d{3})(\d{3})(\d{2})/,"$1.$2.$3-$4")
                      : data[k] || "—"}
                  </div>
                </div>
              ))}
            </div>

            {/* Botões */}
            {isSuccess ? (
              <div style={{ background:T.greenBg, border:`1px solid ${T.green}44`,
                borderRadius:6, padding:"8px 12px", color:T.green,
                fontSize:12, fontWeight:600, textAlign:"center" }}>
                ✓ {status.includes("codental") ? "Adicionado ao Codental" : "Adicionado ao Doctoralia"}
              </div>
            ) : (
              <div style={{ display:"flex", gap:6 }}>
                <button onClick={() => handleAction("codental")} disabled={status==="loading"}
                  style={{ flex:1, background:T.accentBg, border:`1px solid ${T.accent}44`,
                    borderRadius:6, padding:"7px 8px", color:T.accent,
                    fontSize:11, fontWeight:600, cursor:"pointer",
                    opacity: status==="loading" ? .6 : 1 }}>
                  {camposVazios.length > 0 ? "✏️ Completar + Codental" : "+ Prontuário Codental"}
                </button>
                <button onClick={() => handleAction("doctoralia")} disabled={status==="loading"}
                  style={{ flex:1, background:"#1a1e3a", border:"1px solid #3a4a8a44",
                    borderRadius:6, padding:"7px 8px", color:"#7a9af8",
                    fontSize:11, fontWeight:600, cursor:"pointer",
                    opacity: status==="loading" ? .6 : 1 }}>
                  🗓 Doctoralia
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Modal para preencher dados ausentes */}
      {showModal && (
        <Modal
          data={data}
          camposVazios={camposVazios}
          action={modalAction}
          onConfirm={(formData) => {
            setShowModal(false);
            executar(modalAction, formData);
          }}
          onClose={() => setShowModal(false)}
        />
      )}
    </>
  );
}

function Modal({ data, camposVazios, action, onConfirm, onClose }) {
  const [form, setForm] = useState({
    nome:       data.nome       || "",
    cpf:        data.cpf        || "",
    convenio:   data.convenio   || "",
    nascimento: data.nascimento || "",
    email:      data.email      || "",
    telefone:   data.telefone   || "",
  });

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.7)",
      zIndex:1000, display:"flex", alignItems:"center", justifyContent:"center" }}
      onClick={onClose}>
      <div style={{ background:"#252525", borderRadius:12, padding:24,
        width:460, maxWidth:"90vw", boxShadow:"0 20px 60px rgba(0,0,0,.6)",
        border:"1px solid #383838" }}
        onClick={e => e.stopPropagation()}>

        <div style={{ fontWeight:700, fontSize:15, color:"#ececec", marginBottom:4 }}>
          Completar dados do paciente
        </div>
        <div style={{ color:"#8e8e8e", fontSize:12, marginBottom:16 }}>
          Preencha os campos ausentes antes de adicionar ao {action === "codental" ? "Codental" : "Doctoralia"}.
        </div>

        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"10px 16px", marginBottom:20 }}>
          {[["nome","Nome completo","span 2"],["cpf","CPF","span 1"],
            ["convenio","Convênio / Plano","span 1"],["nascimento","Data de nascimento","span 1"],
            ["telefone","Telefone","span 1"],["email","E-mail","span 2"]
          ].map(([k,l,col]) => (
            <div key={k} style={{ gridColumn:col }}>
              <label style={{ display:"block", fontSize:10, fontWeight:700,
                color: camposVazios.includes(k) ? "#c9a84c" : "#8e8e8e",
                marginBottom:4, textTransform:"uppercase", letterSpacing:.5 }}>
                {l}{camposVazios.includes(k) ? " *" : ""}
              </label>
              <input value={form[k]} onChange={e => setForm(p=>({...p,[k]:e.target.value}))}
                placeholder={camposVazios.includes(k) ? "Obrigatório..." : ""}
                style={{ width:"100%", background: camposVazios.includes(k) ? "#2a2010" : "#1e1e1e",
                  border:`1px solid ${camposVazios.includes(k) ? "#c9a84c66" : "#383838"}`,
                  borderRadius:6, padding:"8px 10px", color:"#ececec",
                  fontSize:13, outline:"none", boxSizing:"border-box",
                  fontFamily:"'DM Sans', sans-serif" }}
                onFocus={e => e.target.style.borderColor="#d4956a"}
                onBlur={e => e.target.style.borderColor=camposVazios.includes(k)?"#c9a84c66":"#383838"} />
            </div>
          ))}
        </div>

        <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
          <button onClick={onClose} style={{ background:"transparent",
            border:"1px solid #383838", borderRadius:6, padding:"8px 16px",
            color:"#8e8e8e", fontSize:13, cursor:"pointer" }}>
            Cancelar
          </button>
          <button onClick={() => onConfirm(form)} style={{ background:"#3a2a1e",
            border:"1px solid #d4956a44", borderRadius:6, padding:"8px 16px",
            color:"#d4956a", fontSize:13, fontWeight:600, cursor:"pointer" }}>
            ✓ Confirmar e adicionar
          </button>
        </div>
      </div>
    </div>
  );
}