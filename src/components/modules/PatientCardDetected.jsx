import { useState } from "react";

const CAMPOS = ["nome","cpf","convenio","nascimento","email","telefone"];

function isTemplateVazio(text) {
  // Template vazio = tem os labels mas nenhum valor preenchido
  const labels = ["Nome completo:","CPF:","E-mail:","Convênio","Telefone:","Data de nascimento:"];
  const temLabels = labels.filter(l => text.includes(l)).length >= 3;
  if (!temLabels) return false;
  // Verifica se todos os campos estão vazios (só label + quebra de linha)
  const linhas = text.split("\n").map(l => l.trim()).filter(Boolean);
  const camposPreenchidos = linhas.filter(l => {
    const isLabel = l.endsWith(":") || l.match(/^(Nome|CPF|E-mail|Convênio|Telefone|Data|Número)/i);
    return !isLabel && l.length > 1;
  });
  return camposPreenchidos.length === 0;
}

export default function PatientCardDetected({ msg }) {
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({
    nome: msg.patientData?.nome || "",
    cpf:  msg.patientData?.cpf  || "",
    convenio: msg.patientData?.convenio || "",
    nascimento: msg.patientData?.nascimento || "",
    email: msg.patientData?.email || "",
    telefone: msg.patientData?.telefone || "",
  });

  // Não exibe card se template completamente vazio
  if (isTemplateVazio(msg.text)) {
    return (
      <div style={{ display:"flex", justifyContent:"flex-start" }}>
        <div style={{ maxWidth:"70%", background:"#fff", border:"1px solid #e5e4df",
          borderRadius:"2px 12px 12px 12px", padding:"8px 12px",
          boxShadow:"0 1px 2px rgba(0,0,0,.06)" }}>
          <div style={{ color:"#1a1a1a", fontSize:13, lineHeight:1.55, whiteSpace:"pre-wrap" }}>
            {msg.text}
          </div>
          <div style={{ color:"#6b6b6b", fontSize:10, marginTop:4, textAlign:"right" }}>
            {msg.time}
          </div>
        </div>
      </div>
    );
  }

  const data = msg.patientData || {};
  const temAlgumDado = Object.values(data).some(v => v && v !== "—");
  const camposVazios = CAMPOS.filter(c => !data[c] || data[c] === "—");

  return (
    <>
      <div style={{ display:"flex", justifyContent:"flex-start" }}>
        <div style={{ maxWidth:"75%", background:"#fff", border:"1px solid #e5e4df",
          borderRadius:"2px 12px 12px 12px", overflow:"hidden",
          boxShadow:"0 1px 2px rgba(0,0,0,.06)" }}>

          {/* Mensagem original */}
          <div style={{ padding:"8px 12px 6px",
            borderBottom:"1px solid #f0efea" }}>
            <div style={{ color:"#1a1a1a", fontSize:13, lineHeight:1.55, whiteSpace:"pre-wrap" }}>
              {msg.text}
            </div>
            <div style={{ color:"#6b6b6b", fontSize:10, marginTop:2, textAlign:"right" }}>
              {msg.time}
            </div>
          </div>

          {/* Card de dados detectados */}
          <div style={{ padding:"10px 12px", background:"#f9fffe",
            borderTop:"2px solid #0a7c5c" }}>
            <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:8 }}>
              <span style={{ fontSize:14 }}>🦷</span>
              <span style={{ fontSize:11, fontWeight:700, color:"#0a7c5c",
                textTransform:"uppercase", letterSpacing:.5 }}>
                Dados de Paciente Detectados
              </span>
              {camposVazios.length === 0 && (
                <span style={{ marginLeft:"auto", fontSize:10, fontWeight:700,
                  color:"#0a7c5c", background:"#dcf2e8",
                  padding:"1px 6px", borderRadius:4 }}>Completo</span>
              )}
              {camposVazios.length > 0 && (
                <span style={{ marginLeft:"auto", fontSize:10, fontWeight:700,
                  color:"#b7560a", background:"#fff3e0",
                  padding:"1px 6px", borderRadius:4 }}>
                  {camposVazios.length} campo{camposVazios.length>1?"s":""} ausente{camposVazios.length>1?"s":""}
                </span>
              )}
            </div>

            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"6px 16px", marginBottom:10 }}>
              {[["nome","Nome"],["cpf","CPF"],["convenio","Convênio"],
                ["nascimento","Nascimento"],["email","Email"],["telefone","Telefone"]].map(([k,l]) => (
                <div key={k}>
                  <div style={{ fontSize:9, fontWeight:700, color:"#6b6b6b",
                    textTransform:"uppercase", letterSpacing:.5 }}>{l}</div>
                  <div style={{ fontSize:12, color: data[k] ? "#1a1a1a" : "#ccc" }}>
                    {data[k] || "—"}
                  </div>
                </div>
              ))}
            </div>

            <div style={{ display:"flex", gap:8 }}>
              <button onClick={() => setShowModal(true)} style={{
                flex:1, background:"#0a7c5c", border:"none", borderRadius:6,
                padding:"7px 10px", color:"#fff", fontSize:12, fontWeight:600,
                cursor:"pointer", fontFamily:"'DM Sans', sans-serif" }}>
                {camposVazios.length > 0 ? "✏️ Completar e adicionar" : "+ Prontuário Codental"}
              </button>
              <button style={{
                flex:1, background:"#fff", border:"1px solid #e5e4df",
                borderRadius:6, padding:"7px 10px", color:"#1a1a1a",
                fontSize:12, cursor:"pointer", fontFamily:"'DM Sans', sans-serif" }}>
                🗓 Doctoralia
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Modal para completar dados */}
      {showModal && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.4)",
          zIndex:1000, display:"flex", alignItems:"center", justifyContent:"center" }}
          onClick={() => setShowModal(false)}>
          <div style={{ background:"#fff", borderRadius:12, padding:24,
            width:460, maxWidth:"90vw", boxShadow:"0 20px 60px rgba(0,0,0,.2)" }}
            onClick={e => e.stopPropagation()}>
            <div style={{ fontWeight:700, fontSize:16, color:"#1a1a1a", marginBottom:4 }}>
              Dados do Paciente
            </div>
            <div style={{ color:"#6b6b6b", fontSize:12, marginBottom:16 }}>
              Complete os campos ausentes antes de adicionar ao sistema.
            </div>

            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"10px 16px", marginBottom:20 }}>
              {[["nome","Nome completo"],["cpf","CPF"],["convenio","Convênio/Plano"],
                ["nascimento","Data de nascimento"],["email","E-mail"],["telefone","Telefone"]].map(([k,l]) => (
                <div key={k} style={{ gridColumn: k==="nome" || k==="email" ? "span 2" : "span 1" }}>
                  <label style={{ display:"block", fontSize:11, fontWeight:600,
                    color:"#6b6b6b", marginBottom:4, textTransform:"uppercase",
                    letterSpacing:.5 }}>{l}</label>
                  <input value={form[k]} onChange={e => setForm(p=>({...p,[k]:e.target.value}))}
                    placeholder={camposVazios.includes(k) ? "Preencher..." : ""}
                    style={{ width:"100%", background: camposVazios.includes(k) ? "#fffbf0" : "#f9f9f8",
                      border:`1px solid ${camposVazios.includes(k) ? "#f0ad4e" : "#e5e4df"}`,
                      borderRadius:6, padding:"8px 10px", color:"#1a1a1a",
                      fontSize:13, fontFamily:"'DM Sans', sans-serif",
                      outline:"none", boxSizing:"border-box" }} />
                </div>
              ))}
            </div>

            <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
              <button onClick={() => setShowModal(false)} style={{
                background:"transparent", border:"1px solid #e5e4df",
                borderRadius:6, padding:"8px 16px", color:"#6b6b6b",
                fontSize:13, cursor:"pointer", fontFamily:"'DM Sans', sans-serif" }}>
                Cancelar
              </button>
              <button onClick={() => {
                console.log("Dados para enviar ao Codental:", form);
                setShowModal(false);
              }} style={{
                background:"#0a7c5c", border:"none", borderRadius:6,
                padding:"8px 16px", color:"#fff", fontSize:13,
                fontWeight:600, cursor:"pointer", fontFamily:"'DM Sans', sans-serif" }}>
                ✓ Confirmar e adicionar
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}