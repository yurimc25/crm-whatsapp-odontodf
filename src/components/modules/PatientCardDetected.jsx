import { useState } from "react";
import { MOCK_PRONTUARIO } from "../../data/mock";

// MODULE: PatientCardDetected
// Detecta mensagens com dados de paciente e oferece ações rápidas.
// Integrações pendentes marcadas com comentários MODULE:

function parsePatientData(text) {
  const fields = {};
  const lines = text.split("\n");
  for (const line of lines) {
    const [key, ...rest] = line.split(":");
    const val = rest.join(":").trim();
    const k = key?.toLowerCase().trim();
    if (k?.includes("nome")) fields.nome = val;
    if (k?.includes("cpf")) fields.cpf = val.replace(/\D/g, "");
    if (k?.includes("e-mail") || k?.includes("email")) fields.email = val;
    if (k?.includes("convênio") || k?.includes("convenio") || k?.includes("particular")) fields.convenio = val;
    if (k?.includes("telefone")) fields.telefone = val;
    if (k?.includes("nascimento")) fields.nascimento = val;
  }
  return fields;
}

export default function PatientCardDetected({ msg }) {
  const [status, setStatus] = useState("idle"); // idle | loading | success | error
  const [action, setAction] = useState(null);
  const patient = parsePatientData(msg.text);

  function handleCreateProntuario() {
    setAction("prontuario");
    setStatus("loading");
    setTimeout(() => {
      // MODULE: Codental API → POST /pacientes { ...patient }
      // Substitua o setTimeout por fetch real
      console.log("MODULE: Codental → criar prontuário", patient);
      setStatus("success");
    }, 1200);
  }

  function handleAddDoctoralia() {
    setAction("doctoralia");
    setStatus("loading");
    setTimeout(() => {
      // MODULE: Doctoralia API → POST /patients { ...patient }
      console.log("MODULE: Doctoralia → adicionar paciente", patient);
      setStatus("success");
    }, 1200);
  }

  const existsInBase = MOCK_PRONTUARIO[patient.cpf];

  return (
    <div style={{ display: "flex", justifyContent: "flex-start" }}>
      <div style={{ maxWidth: "80%" }}>
        {/* Bubble original */}
        <div style={{
          background: "#111a15", border: "1px solid #1e3028",
          borderRadius: "4px 12px 12px 12px", padding: "9px 13px", marginBottom: 6,
        }}>
          <div style={{ color: "#e8f5ee", fontSize: 12, lineHeight: 1.65, whiteSpace: "pre-wrap" }}>
            {msg.text}
          </div>
          <div style={{ color: "#3a7055", fontSize: 10, marginTop: 4 }}>{msg.time}</div>
        </div>

        {/* Card de dados detectados */}
        <div style={{
          background: "#0d1a10", border: "1px solid #0d7d62",
          borderRadius: 10, padding: "12px 14px",
          boxShadow: "0 0 0 1px #0d7d6222",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
            <span style={{ fontSize: 14 }}>🎯</span>
            <span style={{ color: "#0d7d62", fontSize: 11, fontWeight: 700,
              textTransform: "uppercase", letterSpacing: .8 }}>
              Dados de paciente detectados
            </span>
            {existsInBase && (
              <span style={{
                marginLeft: "auto", background: "#1a5fa833", color: "#5fa8e8",
                fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
              }}>JÁ CADASTRADO</span>
            )}
          </div>

          {/* Campos extraídos */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 12px", marginBottom: 12 }}>
            {[
              ["Nome", patient.nome],
              ["CPF", patient.cpf ? patient.cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4") : "—"],
              ["Convênio", patient.convenio],
              ["Nascimento", patient.nascimento],
              ["Email", patient.email],
              ["Telefone", patient.telefone],
            ].map(([label, value]) => (
              <div key={label}>
                <div style={{ color: "#3a7055", fontSize: 9, fontWeight: 700,
                  textTransform: "uppercase", letterSpacing: .5 }}>{label}</div>
                <div style={{ color: "#c8e8d8", fontSize: 12, fontWeight: 500,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {value || "—"}
                </div>
              </div>
            ))}
          </div>

          {/* Botões de ação */}
          {status === "success" ? (
            <div style={{
              background: "#0d2e22", border: "1px solid #0d7d62",
              borderRadius: 6, padding: "8px 12px", color: "#0d7d62",
              fontSize: 12, fontWeight: 600, textAlign: "center",
            }}>
              ✓ {action === "prontuario" ? "Prontuário criado no Codental" : "Paciente adicionado ao Doctoralia"}
            </div>
          ) : (
            <div style={{ display: "flex", gap: 6 }}>
              <ActionBtn
                label={status === "loading" && action === "prontuario" ? "Criando..." : "＋ Prontuário Codental"}
                color="#0d7d62"
                disabled={status === "loading" || !!existsInBase}
                onClick={handleCreateProntuario}
                title={existsInBase ? "Paciente já cadastrado" : "Criar prontuário no Codental"}
              />
              <ActionBtn
                label={status === "loading" && action === "doctoralia" ? "Adicionando..." : "📅 Doctoralia"}
                color="#1a5fa8"
                disabled={status === "loading"}
                onClick={handleAddDoctoralia}
                title="Adicionar à agenda do Doctoralia"
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ActionBtn({ label, color, disabled, onClick, title }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        flex: 1, background: disabled ? "#111a15" : color + "22",
        border: `1px solid ${disabled ? "#1e3028" : color}`,
        borderRadius: 6, padding: "7px 8px",
        color: disabled ? "#3a7055" : color,
        fontSize: 11, fontWeight: 600, cursor: disabled ? "not-allowed" : "pointer",
        fontFamily: "'DM Sans', sans-serif", transition: "all .15s",
      }}
    >
      {label}
    </button>
  );
}
