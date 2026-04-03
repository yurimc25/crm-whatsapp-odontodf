import { useState } from "react";
import LoginScreen from "./components/LoginScreen";
import CRMLayout from "./components/CRMLayout";

export default function App() {
  const [operator, setOperator] = useState(null);

  if (!operator) return <LoginScreen onLogin={setOperator} />;
  return <CRMLayout operator={operator} onLogout={() => setOperator(null)} />;
}
