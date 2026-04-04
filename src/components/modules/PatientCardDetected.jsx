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

const RE_CPF      = /\b\d{3}[\s.]?\d{3}[\s.]?\d{3}[-\s.]?\d{2}\b/;
const RE_CNPJ     = /\b\d{2}[\s.]?\d{3}[\s.]?\d{3}[/\s]?\d{4}[-\s.]?\d{2}\b/;
const RE_EMAIL    = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;
const RE_DATE     = /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/;
const RE_PHONE    = /(?:\+?55\s?)?(?:\(?\d{2}\)?\s?)(?:9\s?\d{4}|\d{4})[\s\-]?\d{4}/g;
const RE_CONVENIO_KNOWN = /bradesco|amil|unimed|sulam[eé]rica|metlife|porto\s?seguro|itaú\s?seguro|hapvida|notredame|gndi|sami|prevent\s?senior|alian[çc]a|quallity|qualit[yi]|odontoprev|interodonto|uniodonto|fenelon|funo|omint|b[- ]?dental/i;

const CAMPOS = ["nome","cpf","convenio","carteirinha","nascimento","email","telefone"];

function parsePatientData(text) {
  const fields = {};

  // Normaliza: se tudo numa linha só, tenta quebrar por delimitadores comuns
  let normalized = text;
  const lineCount = text.split("\n").filter(l => l.trim()).length;
  if (lineCount <= 2) {
    // Texto corrido — tenta quebrar por "  " (dois espaços) ou "\t"
    normalized = text
      .replace(/\s{2,}/g, "\n")  // múltiplos espaços → nova linha
      .replace(/\t/g, "\n");
  }

  const lines = normalized.split("\n").map(l => l.trim()).filter(Boolean);

  // ── Modo estruturado: tem labels com ":" ─────────────────────────
  const labelLines = lines.filter(l => /:/.test(l) && l.split(":")[0].length < 30);
  // Só usa modo estruturado se tiver pelo menos 2 labels reais de formulário
  const temLabelsFormulario = labelLines.some(l => {
    const k = l.split(":")[0].toLowerCase();
    return k.includes("nome") || k.includes("cpf") || k.includes("email") ||
           k.includes("convênio") || k.includes("telefone") || k.includes("nascimento");
  });

  if (temLabelsFormulario && labelLines.length >= 2) {
    for (const line of lines) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const k   = line.slice(0, idx).toLowerCase().trim();
      const val = line.slice(idx + 1).trim();
      if (!val) continue;
      if (k.includes("nome"))                                          fields.nome      = val;
      if (k.includes("cpf"))                                           fields.cpf       = val.replace(/\D/g,"");
      if (k.includes("e-mail") || k.includes("email"))                fields.email     = val;
      if (k.includes("convênio") || k.includes("convenio") ||
          k.includes("particular") || k.includes("plano"))            fields.convenio  = val;
      if (k.includes("carteirinha") || k.includes("número da cart") ||
          k.includes("num. cart") || k.includes("número do cart"))    fields.carteirinha = val;
      if ((k.includes("telefone") || k.includes("celular")) &&
          !k.includes("carteirinha"))                                  fields.telefone  = val;
      if (k.includes("nascimento") || k.includes("data de") ||
          k.includes("nasc"))                                          fields.nascimento = val;
    }
    return fields;
  }

  // ── Modo livre: extrai por padrão do texto (inclui texto corrido) ──
  const fullText = text; // usa texto original para regex

  // Email
  const emailM = fullText.match(RE_EMAIL);
  if (emailM) fields.email = emailM[0];

  // CPF (11 dígitos) — extrai e formata
  const textSemEmail = emailM ? fullText.replace(emailM[0], "") : fullText;
  const cpfM = textSemEmail.match(RE_CPF);
  if (cpfM) fields.cpf = cpfM[0].replace(/\D/g, "");

  // Data de nascimento
  const dateMatches = [...fullText.matchAll(new RegExp(RE_DATE.source, "g"))];
  if (dateMatches.length > 0) {
    fields.nascimento = dateMatches[dateMatches.length - 1][0];
  }

  // Telefones — pega todos, remove o que pode ser CPF/data
  const textSemCpf = fields.cpf ? textSemEmail.replace(
    new RegExp(fields.cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.?$2.?$3-?$4")), ""
  ) : textSemEmail;
  const phones = [...textSemCpf.matchAll(RE_PHONE)].map(m => m[0].replace(/\D/g, ""));
  const validPhones = phones.filter(p => p.length >= 10 && p.length <= 13);
  if (validPhones.length > 0) fields.telefone = validPhones[0];
  // Segundo telefone diferente do primeiro
  if (validPhones.length > 1 && validPhones[1] !== validPhones[0]) {
    if (!fields.telefone2) fields.telefone2 = validPhones[1];
  }

  // Convênio — detecta convênios conhecidos OU palavra após "Convênio:"
  const convenioLabelM = fullText.match(/(?:convênio|convênio\/particular|plano)\s*[:\-]?\s*([^\n,]{2,30})/i);
  if (convenioLabelM) {
    fields.convenio = convenioLabelM[1].trim();
  } else {
    const convenioM = fullText.match(RE_CONVENIO_KNOWN);
    if (convenioM) {
      // Pega a linha/trecho que contém o convênio
      for (const line of lines) {
        if (RE_CONVENIO_KNOWN.test(line)) { fields.convenio = line.trim(); break; }
      }
    }
  }

  // Nome — primeira linha que parece nome próprio (Maiúscula Maiúscula, sem números)
  const RE_NAME = /^[A-ZÀ-Ú][a-zà-ú]+(\s+[A-ZÀ-Úa-zà-ú]+){1,6}$/;
  for (const line of lines) {
    const clean = line.trim();
    if (clean.length > 5 && clean.length < 60 && RE_NAME.test(clean) &&
        !RE_EMAIL.test(clean) && !/\d{5,}/.test(clean)) {
      fields.nome = clean;
      break;
    }
  }
  // Fallback: primeira linha sem muitos números
  if (!fields.nome) {
    for (const line of lines) {
      const digits = line.replace(/\D/g, "");
      if (digits.length < 4 && line.length > 5 && line.length < 70 &&
          !RE_EMAIL.test(line)) {
        fields.nome = line.trim();
        break;
      }
    }
  }

  return fields;
}

function isTemplateVazio(text) {
  const labels = ["Nome completo:","CPF:","E-mail:","Convênio","Número da carteirinha:","Telefone:","Data de nascimento:"];
  const temLabels = labels.filter(l => text.includes(l)).length >= 3;
  if (!temLabels) return false;
  // Checa se todas as linhas com ":" de formulário têm valor vazio depois
  const linhas = text.split("\n").map(l => l.trim()).filter(Boolean);
  const labelsFormulario = linhas.filter(l => {
    const k = (l.split(":")[0] || "").toLowerCase();
    return k.includes("nome") || k.includes("cpf") || k.includes("e-mail") ||
           k.includes("email") || k.includes("telefone") || k.includes("convênio") ||
           k.includes("nascimento") || k.includes("cartão");
  });
  if (labelsFormulario.length < 3) return false;
  const comValor = labelsFormulario.filter(l => {
    const idx = l.indexOf(":");
    if (idx === -1) return false;
    return l.slice(idx+1).trim().length > 0;
  });
  // Template vazio = menos de 1 campo preenchido
  return comValor.length === 0;
}

export default function PatientCardDetected({ msg }) {
  const [showModal, setShowModal] = useState(false);
  const [modalAction, setModalAction] = useState(null);
  const [status, setStatus]  = useState("idle");
  const [result, setResult]  = useState(null); // { patient_id, url }
  const [error, setError]    = useState(null);
  const data = parsePatientData(msg.text);
  const iKey = import.meta.env.VITE_INTERNAL_API_KEY || "";

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
    setError(null);
    if (action === "doctoralia") {
      // Doctoralia: abre o site com os dados pré-preenchidos (futuro)
      window.open("https://www.doctoralia.com.br", "_blank");
      return;
    }
    if (camposVazios.length > 0) {
      setModalAction(action);
      setShowModal(true);
    } else {
      executar(action, data);
    }
  }

  async function executar(action, formData) {
    if (action !== "codental") return;
    setStatus("loading");
    setError(null);
    try {
      const r = await fetch("/api/codental?action=create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Key": iKey,
        },
        body: JSON.stringify(formData),
      });
      const json = await r.json();
      if (!r.ok) {
        throw new Error(json.error || `Erro ${r.status}`);
      }
      setResult(json);
      setStatus("success_codental");
    } catch (e) {
      setError(e.message);
      setStatus("error");
    }
  }

  const isSuccess = status === "success_codental";
  const isLoading = status === "loading";
  const isError   = status === "error";

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
              {[["nome","Nome"],["cpf","CPF"],["convenio","Convênio"],["carteirinha","Carteirinha"],
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
                ✓ Paciente adicionado ao Codental!
                {result?.url && (
                  <a href={result.url} target="_blank" rel="noreferrer"
                    style={{ display:"block", marginTop:4, color:T.accent,
                      fontSize:11, textDecoration:"underline" }}>
                    Ver prontuário →
                  </a>
                )}
              </div>
            ) : (
              <>
                {isError && (
                  <div style={{ background:"#2a1010", border:"1px solid #c0412c44",
                    borderRadius:6, padding:"6px 10px", color:"#e57373",
                    fontSize:11, marginBottom:6 }}>
                    ⚠ {error}
                  </div>
                )}
                <div style={{ display:"flex", gap:6 }}>
                  <button onClick={() => handleAction("codental")} disabled={isLoading}
                    style={{ flex:1, background:T.accentBg, border:`1px solid ${T.accent}44`,
                      borderRadius:6, padding:"7px 8px", color:T.accent,
                      fontSize:11, fontWeight:600, cursor: isLoading ? "not-allowed" : "pointer",
                      opacity: isLoading ? .6 : 1 }}>
                    {isLoading ? "⏳ Adicionando..." : camposVazios.length > 0 ? "✏️ Completar + Codental" : "+ Prontuário Codental"}
                  </button>
                  <button onClick={() => handleAction("doctoralia")} disabled={isLoading}
                    style={{ flex:1, background:"#1a1e3a", border:"1px solid #3a4a8a44",
                      borderRadius:6, padding:"7px 8px", color:"#7a9af8",
                      fontSize:11, fontWeight:600, cursor:"pointer",
                      opacity: isLoading ? .6 : 1 }}>
                    🗓 Doctoralia
                  </button>
                </div>
              </>
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
            ["convenio","Convênio / Plano","span 1"],["carteirinha","Nº da carteirinha","span 1"],
            ["nascimento","Data de nascimento","span 1"],["telefone","Telefone","span 1"],
            ["email","E-mail","span 2"]
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