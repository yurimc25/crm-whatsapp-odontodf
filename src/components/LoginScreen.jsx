import { useState } from "react";
import { OPERATORS } from "../data/mock";

export default function LoginScreen({ onLogin }) {
  const [login, setLogin] = useState("");
  const [error, setError] = useState("");

  function handleSubmit(e) {
    e.preventDefault();
    const op = OPERATORS.find(o => o.login.toLowerCase() === login.trim().toLowerCase());
    if (op) {
      onLogin(op);
    } else {
      setError("Operador não encontrado. Tente: yuri, ana, patricia");
    }
  }

  return (
    <div style={{
      minHeight: "100vh", background: "#0a0f0d",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: "'DM Sans', sans-serif",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap');
        * { box-sizing: border-box; }
        .login-input {
          width: 100%; background: #111a15; border: 1px solid #1e3028;
          border-radius: 8px; padding: 12px 16px; color: #e8f5ee;
          font-family: 'DM Mono', monospace; font-size: 15px;
          outline: none; transition: border-color .2s;
        }
        .login-input:focus { border-color: #0d7d62; }
        .login-input::placeholder { color: #3a5244; }
        .login-btn {
          width: 100%; background: #0d7d62; color: #fff;
          border: none; border-radius: 8px; padding: 13px;
          font-family: 'DM Sans', sans-serif; font-size: 15px; font-weight: 600;
          cursor: pointer; transition: background .2s;
          margin-top: 8px;
        }
        .login-btn:hover { background: #0a6852; }
      `}</style>

      <div style={{
        background: "#0d1610", border: "1px solid #1a2e22",
        borderRadius: 16, padding: "44px 40px", width: 360,
        boxShadow: "0 24px 80px rgba(0,0,0,.5)",
      }}>
        {/* Logo */}
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{
            width: 52, height: 52, background: "#0d7d62",
            borderRadius: 14, display: "inline-flex",
            alignItems: "center", justifyContent: "center",
            fontSize: 24, marginBottom: 16,
          }}>🦷</div>
          <div style={{ color: "#e8f5ee", fontSize: 20, fontWeight: 600 }}>
            Clínica CRM
          </div>
          <div style={{ color: "#3a7055", fontSize: 13, marginTop: 4 }}>
            Identificação do operador
          </div>
        </div>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: "block", color: "#3a7055", fontSize: 11,
              fontWeight: 600, letterSpacing: 1, textTransform: "uppercase", marginBottom: 6 }}>
              Login
            </label>
            <input
              className="login-input"
              placeholder="ex: yuri"
              value={login}
              onChange={e => { setLogin(e.target.value); setError(""); }}
              autoFocus
            />
          </div>

          {error && (
            <div style={{ background: "#2a1010", border: "1px solid #5a2020",
              borderRadius: 6, padding: "8px 12px", color: "#e88", fontSize: 12, marginBottom: 8 }}>
              {error}
            </div>
          )}

          <button className="login-btn" type="submit">Entrar →</button>
        </form>

        {/* Operadores disponíveis */}
        <div style={{ marginTop: 24, borderTop: "1px solid #1a2e22", paddingTop: 20 }}>
          <div style={{ color: "#3a5244", fontSize: 11, fontWeight: 600,
            letterSpacing: 1, textTransform: "uppercase", marginBottom: 10 }}>
            Operadores
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {OPERATORS.filter(o => o.role !== "bot").map(op => (
              <button key={op.id} onClick={() => { setLogin(op.login); setError(""); }}
                style={{
                  background: "transparent", border: "1px solid #1a2e22",
                  borderRadius: 8, padding: "8px 12px", cursor: "pointer",
                  display: "flex", alignItems: "center", gap: 10,
                  transition: "border-color .15s, background .15s",
                  color: "#c8e8d8",
                }}
                onMouseEnter={e => e.currentTarget.style.borderColor = "#0d7d62"}
                onMouseLeave={e => e.currentTarget.style.borderColor = "#1a2e22"}
              >
                <div style={{
                  width: 28, height: 28, borderRadius: 8,
                  background: op.color + "33", color: op.color,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 10, fontWeight: 700,
                }}>{op.avatar}</div>
                <div style={{ textAlign: "left" }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{op.name}</div>
                  <div style={{ fontSize: 11, color: "#3a7055" }}>{op.role}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
