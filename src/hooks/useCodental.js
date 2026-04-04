import { useState, useCallback } from "react";

const ikey = () => import.meta.env.VITE_INTERNAL_API_KEY || "";

export function useCodental() {
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);

  async function call(params) {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams(
        Object.fromEntries(Object.entries(params).filter(([,v]) => v != null))
      ).toString();
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

  const searchByName  = useCallback((q)    => call({ action:"search", q }), []);
  const searchByPhone = useCallback((phone) => call({ action:"search", phone }), []);
  const getPatient    = useCallback((id)   => call({ action:"patient", id }), []);
  const getUploads    = useCallback((id)   => call({ action:"uploads", id }), []);
  const getEvolutions = useCallback((id)   => call({ action:"evolutions", id }), []);

  return { searchByName, searchByPhone, getPatient, getUploads, getEvolutions, loading, error };
}
