import { useState, useRef } from "react";

const T = {
  bg:       "#212121",
  overlay:  "rgba(0,0,0,.7)",
  modal:    "#252525",
  border:   "#2d2d2d",
  text:     "#ececec",
  sub:      "#8e8e8e",
  accent:   "#d4956a",
  accentBg: "#3a2a1e",
  green:    "#4caf87",
  greenBg:  "#1a2e22",
  inputBg:  "#1a1a1a",
};

export function ContactLookupModal({ phoneNumber, chatId, onClose, onSelectContact }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef(null);

  const ikey = import.meta.env.VITE_INTERNAL_API_KEY || "@Deuse10";

  async function searchContacts() {
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    setResults([]);
    setSelectedIdx(0);

    try {
      const digits    = query.replace(/\D/g, "");
      const isDigits  = digits.length === query.trim().length && digits.length > 0;
      const isFullPhone = digits.length >= 8;

      if (!isFullPhone && !isDigits && query.trim().length < 2) {
        setError("Digite um número (mínimo 4 dígitos) ou um nome (mínimo 2 caracteres)");
        setLoading(false);
        return;
      }

      // ── Google Contacts ──────────────────────────────────────────
      let googleResults = [];
      try {
        const url = isFullPhone
          ? `/api/contacts?action=search&phone=${encodeURIComponent(digits)}&_t=${Date.now()}`
          : `/api/contacts?action=search&q=${encodeURIComponent(query.trim())}&_t=${Date.now()}`;

        const r = await fetch(url, { headers: { "X-Internal-Key": ikey }, cache: "no-store" });
        if (r.ok) {
          const data = await r.json();
          if (data.found && data.name) {
            googleResults = [{ phone: digits || "", name: data.name, source: "google" }];
          } else if (data.found && Array.isArray(data.contacts)) {
            googleResults = data.contacts.slice(0, 10).map(c => ({ ...c, source: "google" }));
          }
        }
      } catch {}

      // ── Codental (só para queries numéricas) ────────────────────
      // Busca pelo sufixo digitado — retorna pacientes cujo celular termina com esses dígitos
      let codentalResults = [];
      if (isDigits && digits.length >= 4) {
        try {
          const r = await fetch(
            `/api/codental?action=search&phone=${digits}`,
            { headers: { "X-Internal-Key": ikey } }
          );
          if (r.ok) {
            const data = await r.json();
            codentalResults = (data.patients || []).slice(0, 10).map(p => ({
              name:   p.fullName || p.full_name || p.name || "",
              phone:  (p.cellphone_formated || p.cellphone || "").replace(/\D/g, ""),
              source: "codental",
            })).filter(c => c.name);
          }
        } catch {}
      }

      // ── Mescla resultados removendo duplicatas por número ────────
      const seen = new Set();
      const merged = [...googleResults, ...codentalResults].filter(c => {
        const key = (c.phone || "").replace(/\D/g, "").slice(-8) + "|" + (c.name || "").toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      if (merged.length > 0) {
        setResults(merged);
      } else {
        setError("Nenhum contato encontrado");
      }
    } catch (e) {
      setError(e.message);
      console.error("[contact-lookup]", e);
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === "Enter") {
      if (loading) return;
      if (results.length === 0) searchContacts();
      else selectContact(selectedIdx);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx(i => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx(Math.max(0, selectedIdx - 1));
    } else if (e.key === "Escape") {
      onClose();
    }
  }

  function selectContact(idx) {
    if (idx < 0 || idx >= results.length) return;
    const contact = results[idx];
    // Passa o objeto completo para o handler pai (nome + telefone/variants quando disponíveis)
    onSelectContact(contact);
  }

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 1000,
      background: T.overlay,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: "'DM Sans', sans-serif",
    }} onClick={onClose}>
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: T.modal,
          border: `1px solid ${T.border}`,
          borderRadius: 12,
          padding: "20px",
          minWidth: 420,
          maxWidth: "90vw",
          maxHeight: "80vh",
          overflowY: "auto",
          boxShadow: "0 20px 60px rgba(0,0,0,.5)",
        }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <h3 style={{ margin: 0, color: T.accent, fontSize: 16, fontWeight: 700 }}>
            🔍 Localizar Contato
          </h3>
          <button
            onClick={onClose}
            style={{
              background: "transparent", border: "none", cursor: "pointer",
              color: T.sub, fontSize: 20, padding: 0, lineHeight: 1,
            }}>
            ✕
          </button>
        </div>

        {/* Info */}
        <div style={{ marginBottom: 12, color: T.sub, fontSize: 12 }}>
          Número atual: <strong style={{ color: T.text, fontFamily: "'DM Mono', monospace" }}>{phoneNumber}</strong>
        </div>

        {/* Search Input */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={e => {
                setQuery(e.target.value);
                setResults([]);
              }}
              onKeyDown={handleKeyDown}
              placeholder="Nome ou número do contato..."
              autoFocus
              style={{
                flex: 1,
                background: T.inputBg,
                border: `1px solid ${T.border}`,
                borderRadius: 6,
                padding: "8px 12px",
                color: T.text,
                fontSize: 13,
                outline: "none",
                transition: "border-color .15s",
              }}
              onFocus={e => e.target.style.borderColor = T.accent}
              onBlur={e => e.target.style.borderColor = T.border}
            />
            <button
              onClick={searchContacts}
              disabled={loading || !query.trim()}
              style={{
                background: loading || !query.trim() ? "#333" : T.accent,
                border: "none",
                borderRadius: 6,
                padding: "8px 16px",
                color: "#fff",
                fontSize: 13,
                fontWeight: 600,
                cursor: loading ? "not-allowed" : "pointer",
                transition: "background .15s",
              }}>
              {loading ? "⏳" : "Buscar"}
            </button>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div style={{
            background: "#2a1010",
            border: `1px solid #c0412c44`,
            borderRadius: 6,
            padding: "10px 12px",
            color: "#e57373",
            fontSize: 12,
            marginBottom: 12,
          }}>
            ⚠ {error}
          </div>
        )}

        {/* Results */}
        {results.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div style={{
              fontSize: 11,
              fontWeight: 700,
              color: T.sub,
              textTransform: "uppercase",
              letterSpacing: 0.5,
              marginBottom: 8,
            }}>
              {results.length} contato{results.length > 1 ? "s" : ""} encontrado{results.length > 1 ? "s" : ""}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {results.map((contact, idx) => (
                <button
                  key={idx}
                  onClick={() => selectContact(idx)}
                  onMouseEnter={() => setSelectedIdx(idx)}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 3,
                    background: idx === selectedIdx ? T.accentBg : "transparent",
                    border: `1px solid ${idx === selectedIdx ? T.accent + "66" : T.border}`,
                    borderRadius: 6,
                    padding: "10px 12px",
                    cursor: "pointer",
                    textAlign: "left",
                    transition: "all .15s",
                  }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{
                      color: idx === selectedIdx ? T.accent : T.text,
                      fontSize: 13,
                      fontWeight: 600,
                      flex: 1,
                    }}>
                      {contact.name || contact.fullName || contact.title || "Sem nome"}
                    </span>
                    {contact.source && (
                      <span style={{
                        fontSize: 9, fontWeight: 700, padding: "1px 5px",
                        borderRadius: 4, flexShrink: 0,
                        background: contact.source === "codental" ? "#1a2e40" : "#1a2e22",
                        color:      contact.source === "codental" ? "#4a9fd4" : T.green,
                        border:     `1px solid ${contact.source === "codental" ? "#4a9fd444" : T.green + "44"}`,
                      }}>
                        {contact.source === "codental" ? "Codental" : "Google"}
                      </span>
                    )}
                  </div>
                  {contact.phone && (
                    <div style={{
                      color: T.sub,
                      fontSize: 11,
                      fontFamily: "'DM Mono', monospace",
                    }}>
                      {contact.phone}
                    </div>
                  )}
                </button>
              ))}
            </div>

            <div style={{
              marginTop: 12,
              padding: "8px 12px",
              background: T.greenBg,
              border: `1px solid ${T.green}44`,
              borderRadius: 6,
              fontSize: 12,
              color: T.green,
              textAlign: "center",
            }}>
              ↑/↓ para navegar · Enter para selecionar · Esc para fechar
            </div>
          </div>
        )}

        {results.length === 0 && !loading && !error && (
          <div style={{
            textAlign: "center",
            padding: "20px 0",
            color: T.sub,
            fontSize: 13,
          }}>
            Digite um <strong>nome</strong> (mínimo 2 caracteres) ou <strong>número</strong> (mínimo 8 dígitos) para buscar no Google Contatos.
          </div>
        )}

        {loading && (
          <div style={{
            textAlign: "center",
            padding: "20px 0",
            color: T.sub,
            fontSize: 13,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
          }}>
            <div style={{
              width: 14,
              height: 14,
              borderRadius: "50%",
              border: `2px solid ${T.border}`,
              borderTopColor: T.accent,
              animation: "spin 0.8s linear infinite",
            }} />
            Buscando contatos...
          </div>
        )}
      </div>

      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
