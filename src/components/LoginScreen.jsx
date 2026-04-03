import { useState } from "react";
import { OPERATORS } from "../data/mock";

export default function LoginScreen({ onLogin }) {
  const [login,    setLogin]    = useState("");
  const [password, setPassword] = useState("");
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState("");
  const [showPass, setShowPass] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!login.trim() || !password.trim()) { setError("Preencha login e senha."); return; }
    setLoading(true); setError("");
    try {
      const r = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ login: login.trim(), password }),
      });
      const data = await r.json();
      if (!r.ok) { setError(data.error || "Erro de autenticação"); return; }
      const op = OPERATORS.find(o => o.login === data.login);
      if (!op) { setError("Operador autenticado mas não configurado."); return; }
      onLogin(op);
    } catch {
      setError("Não foi possível conectar. Tente novamente.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      minHeight: "100vh", background: "#0a0f0d",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: "'DM Sans', sans-serif", padding: 20,
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap');
        *{box-sizing:border-box}
        .fi{width:100%;background:#111a15;border:1px solid #1e3028;border-radius:8px;padding:12px 16px;color:#e8f5ee;font-family:'DM Mono',monospace;font-size:15px;outline:none;transition:border-color .2s}
        .fi:focus{border-color:#0d7d62}
        .fi::placeholder{color:#3a5244}
        .fb{width:100%;background:#0d7d62;color:#fff;border:none;border-radius:8px;padding:13px;font-family:'DM Sans',sans-serif;font-size:15px;font-weight:600;cursor:pointer;transition:background .2s}
        .fb:hover:not(:disabled){background:#0a6852}
        .fb:disabled{background:#1a3028;color:#3a7055;cursor:not-allowed}
      `}</style>

      <div style={{
        background: "#0d1610", border: "1px solid #1a2e22", borderRadius: 16,
        padding: "44px 40px", width: "100%", maxWidth: 380,
        boxShadow: "0 24px 80px rgba(0,0,0,.5)",
      }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ width:52,height:52,background:"#0d7d62",borderRadius:14,
            display:"inline-flex",alignItems:"center",justifyContent:"center",fontSize:24,marginBottom:16 }}>🦷</div>
          <div style={{ color:"#e8f5ee",fontSize:20,fontWeight:600 }}>Clínica CRM</div>
          <div style={{ color:"#3a7055",fontSize:13,marginTop:4 }}>Acesso de operadores</div>
        </div>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom:12 }}>
            <label style={{ display:"block",color:"#3a7055",fontSize:11,fontWeight:600,
              letterSpacing:1,textTransform:"uppercase",marginBottom:6 }}>Login</label>
            <input className="fi" placeholder="ex: yuri" value={login} autoCapitalize="none"
              onChange={e => { setLogin(e.target.value); setError(""); }} autoFocus />
          </div>

          <div style={{ marginBottom:16 }}>
            <label style={{ display:"block",color:"#3a7055",fontSize:11,fontWeight:600,
              letterSpacing:1,textTransform:"uppercase",marginBottom:6 }}>Senha</label>
            <div style={{ position:"relative" }}>
              <input className="fi" type={showPass?"text":"password"} placeholder="••••••••"
                value={password} onChange={e => { setPassword(e.target.value); setError(""); }}
                style={{ paddingRight:44 }} />
              <button type="button" onClick={() => setShowPass(v=>!v)} style={{
                position:"absolute",right:12,top:"50%",transform:"translateY(-50%)",
                background:"none",border:"none",color:"#3a7055",cursor:"pointer",fontSize:16,padding:0,
              }}>{showPass?"🙈":"👁️"}</button>
            </div>
          </div>

          {error && (
            <div style={{ background:"#2a1010",border:"1px solid #5a2020",borderRadius:6,
              padding:"8px 12px",color:"#e88",fontSize:12,marginBottom:12 }}>{error}</div>
          )}

          <button className="fb" type="submit" disabled={loading}>
            {loading ? "Autenticando..." : "Entrar →"}
          </button>
        </form>

        {/* Seleção rápida */}
        <div style={{ marginTop:24,borderTop:"1px solid #1a2e22",paddingTop:20 }}>
          <div style={{ color:"#3a5244",fontSize:11,fontWeight:600,
            letterSpacing:1,textTransform:"uppercase",marginBottom:10 }}>Operadores</div>
          <div style={{ display:"flex",flexDirection:"column",gap:6 }}>
            {OPERATORS.filter(o => o.role !== "bot").map(op => (
              <button key={op.id} onClick={() => { setLogin(op.login); setPassword(""); setError(""); }}
                style={{
                  background: login===op.login ? "#0d2e22" : "transparent",
                  border: `1px solid ${login===op.login ? "#0d7d62" : "#1a2e22"}`,
                  borderRadius:8,padding:"8px 12px",cursor:"pointer",
                  display:"flex",alignItems:"center",gap:10,color:"#c8e8d8",transition:"all .15s",
                }}>
                <div style={{ width:28,height:28,borderRadius:8,background:op.color+"33",color:op.color,
                  display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:700 }}>
                  {op.avatar}</div>
                <div style={{ textAlign:"left" }}>
                  <div style={{ fontSize:13,fontWeight:500 }}>{op.name}</div>
                  <div style={{ fontSize:11,color:"#3a7055" }}>{op.role}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
