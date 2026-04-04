import { useState, useEffect, createContext, useContext } from "react";
import LoginScreen from "./components/LoginScreen";
import CRMLayout from "./components/CRMLayout";
import CRMLayoutMobile from "./components/CRMLayoutMobile";
import { useContacts } from "./hooks/useContacts";
import { OPERATORS } from "./data/mock";

export const ContactsContext = createContext({ displayName: (id) => id, displayInfo: () => ({ hasContact: false, line1: id, line2: id, phone: id }), contactMap: {} });
export const useContactsCtx = () => useContext(ContactsContext);

function useIsMobile() {
  const [mobile, setMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const handler = () => setMobile(window.innerWidth < 768);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);
  return mobile;
}

export default function App() {
  const [operator, setOperator] = useState(null);
  const [checking, setChecking] = useState(true); // verifica cookie ao iniciar
  const contacts = useContacts();
  const isMobile = useIsMobile();

  // Verifica cookie de sessão ao abrir o app
  useEffect(() => {
    fetch("/api/session", { credentials: "include" })
      .then(r => r.json())
      .then(data => {
        if (data.ok && data.login) {
          const op = OPERATORS.find(o => o.login.toLowerCase() === data.login.toLowerCase());
          if (op) setOperator(op);
        }
      })
      .catch(() => {})
      .finally(() => setChecking(false));
  }, []);

  async function handleLogout() {
    await fetch("/api/session", { method: "DELETE", credentials: "include" }).catch(() => {});
    setOperator(null);
  }

  if (checking) {
    return (
      <div style={{
        minHeight: "100vh", background: "#1e1e1e",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontFamily: "'DM Sans', sans-serif",
      }}>
        <div style={{ color: "#8e8e8e", fontSize: 14 }}>Verificando sessão...</div>
      </div>
    );
  }

  const Layout = isMobile ? CRMLayoutMobile : CRMLayout;

  return (
    <ContactsContext.Provider value={contacts}>
      {!operator
        ? <LoginScreen onLogin={setOperator} />
        : <Layout operator={operator} onLogout={handleLogout} />
      }
    </ContactsContext.Provider>
  );
}
