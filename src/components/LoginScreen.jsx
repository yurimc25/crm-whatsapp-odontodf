import { useState } from "react";
import { OPERATORS } from "../data/mock";

export default function LoginScreen({ onLogin }) {
  const [login, setLogin]       = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [error, setError]       = useState("");
  const [loading, setLoading]   = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const r = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ login: login.trim(), password }),
      });
      const data = await r.json();
      if (!r.ok) { setError(data.error || "Erro ao autenticar"); return; }
      const op = OPERATORS.find(o => o.login.toLowerCase() === login.trim().toLowerCase());
      if (op) onLogin(op);
      else setError("Operador não encontrado");
    } catch (e) {
      setError("Erro de conexão");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      minHeight:"100vh", background:"#121212",
      display:"flex", alignItems:"center", justifyContent:"center",
      fontFamily:"'DM Sans', sans-serif",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=DM+Mono:wght@400;500&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        .fi{
          width:100%; background:#1e1e1e; border:1px solid #333;
          border-radius:8px; padding:12px 16px; color:#ececec;
          font-family:'DM Sans',sans-serif; font-size:15px; outline:none;
          transition:border-color .2s;
        }
        .fi:focus{border-color:#d4956a}
        .fi::placeholder{color:#555}
        .fb{
          width:100%; background:#d4956a; color:#fff; border:none;
          border-radius:8px; padding:13px; font-family:'DM Sans',sans-serif;
          font-size:15px; font-weight:600; cursor:pointer; transition:background .2s;
        }
        .fb:hover:not(:disabled){background:#c4854a}
        .fb:disabled{background:#2d2d2d;color:#555;cursor:not-allowed}
      `}</style>

      <div style={{
        background:"#1a1a1a", border:"1px solid #2d2d2d",
        borderRadius:14, padding:"36px 32px", width:"100%", maxWidth:400,
        boxShadow:"0 20px 60px rgba(0,0,0,.5)",
      }}>
        {/* Logo */}
        <div style={{ textAlign:"center", marginBottom:32 }}>
          <div style={{ width:52, height:52, background:"#d4956a22",
            border:"2px solid #d4956a44", borderRadius:14,
            display:"flex", alignItems:"center", justifyContent:"center",
            fontSize:26, margin:"0 auto 12px" }}>🦷</div>
          <div style={{ color:"#ececec", fontSize:20, fontWeight:700 }}>Clínica CRM</div>
          <div style={{ color:"#8e8e8e", fontSize:13, marginTop:4 }}>Acesso de operadores</div>
        </div>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom:14 }}>
            <label style={{ display:"block", color:"#8e8e8e", fontSize:11,
              fontWeight:600, textTransform:"uppercase", letterSpacing:.5, marginBottom:6 }}>
              Login
            </label>
            <input className="fi" type="text" placeholder="yuri, ana, patricia..."
              value={login} onChange={e => setLogin(e.target.value)}
              autoComplete="username" autoFocus />
          </div>

          <div style={{ marginBottom:20 }}>
            <label style={{ display:"block", color:"#8e8e8e", fontSize:11,
              fontWeight:600, textTransform:"uppercase", letterSpacing:.5, marginBottom:6 }}>
              Senha
            </label>
            <div style={{ position:"relative" }}>
              <input className="fi" type={showPass?"text":"password"}
                placeholder="••••••••"
                value={password} onChange={e => setPassword(e.target.value)}
                autoComplete="current-password"
                style={{ paddingRight:44 }} />
              <button type="button" onClick={() => setShowPass(v=>!v)} style={{
                position:"absolute", right:12, top:"50%", transform:"translateY(-50%)",
                background:"transparent", border:"none", color:"#8e8e8e",
                cursor:"pointer", fontSize:16, padding:0,
              }}>{showPass ? "🙈" : "👁"}</button>
            </div>
          </div>

          {error && (
            <div style={{ background:"#2a1a1a", border:"1px solid #5a2a2a",
              borderRadius:6, padding:"10px 14px", color:"#e57373",
              fontSize:13, marginBottom:16 }}>
              ⚠️ {error}
            </div>
          )}

          <button className="fb" type="submit" disabled={loading || !login || !password}>
            {loading ? "Entrando..." : "Entrar"}
          </button>
        </form>

        {/* Atalhos de operadores */}
        <div style={{ marginTop:24, borderTop:"1px solid #2d2d2d", paddingTop:20 }}>
          <div style={{ color:"#555", fontSize:11, fontWeight:600,
            textTransform:"uppercase", letterSpacing:.5, marginBottom:10 }}>
            Acesso rápido
          </div>
          <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
            {OPERATORS.filter(o => o.role !== "bot").map(op => (
              <button key={op.login} type="button"
                onClick={() => setLogin(op.login)}
                style={{
                  background:"transparent", border:"1px solid #2d2d2d",
                  borderRadius:8, padding:"8px 12px", color:"#8e8e8e",
                  fontSize:12, cursor:"pointer", textAlign:"left",
                  display:"flex", alignItems:"center", gap:8,
                  transition:"all .15s",
                }}
                onMouseEnter={e => { e.currentTarget.style.background="#252525"; e.currentTarget.style.color="#ececec"; e.currentTarget.style.borderColor="#d4956a44"; }}
                onMouseLeave={e => { e.currentTarget.style.background="transparent"; e.currentTarget.style.color="#8e8e8e"; e.currentTarget.style.borderColor="#2d2d2d"; }}>
                <div style={{ width:8, height:8, borderRadius:"50%", background:op.color, flexShrink:0 }} />
                <span style={{ fontWeight:600 }}>{op.name}</span>
                <span style={{ color:"#555", marginLeft:"auto", fontSize:10, textTransform:"capitalize" }}>{op.role}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}