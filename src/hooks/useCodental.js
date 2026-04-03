// src/hooks/useCodental.js
import { useState, useCallback } from "react";

const ikey = () => import.meta.env.VITE_INTERNAL_API_KEY || "";

export function useCodental() {
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);

  async function call(params) {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams(params).toString();
      const r = await fetch(`/api/codental?${qs}`, {
        headers: { "X-Internal-Key": ikey() },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setLoading(false);
    }
  }

  const searchPatient = useCallback((q) => call({ action: "search", q }), []);
  const getPatient    = useCallback((id) => call({ action: "patient", id }), []);
  const getUploads    = useCallback((id) => call({ action: "uploads", id }), []);

  return { searchPatient, getPatient, getUploads, loading, error };
}