import { useState, createContext, useContext } from "react";
import LoginScreen from "./components/LoginScreen";
import CRMLayout from "./components/CRMLayout";
import CRMLayoutMobile from "./components/CRMLayoutMobile";
import { useContacts } from "./hooks/useContacts";

// Contexto global de contatos — disponível em qualquer componente
export const ContactsContext = createContext({ displayName: (id) => id, contactMap: {} });
export const useContactsCtx = () => useContext(ContactsContext);

function useIsMobile() {
  const [mobile, setMobile] = useState(() => window.innerWidth < 768);
  useState(() => {
    const handler = () => setMobile(window.innerWidth < 768);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  });
  return mobile;
}

export default function App() {
  const [operator, setOperator] = useState(null);
  const contacts = useContacts();
  const isMobile = useIsMobile();

  const Layout = isMobile ? CRMLayoutMobile : CRMLayout;

  return (
    <ContactsContext.Provider value={contacts}>
      {!operator
        ? <LoginScreen onLogin={setOperator} />
        : <Layout operator={operator} onLogout={() => setOperator(null)} />
      }
    </ContactsContext.Provider>
  );
}
