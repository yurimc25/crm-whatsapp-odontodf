import { useState, useCallback } from "react";

const ikey = () => import.meta.env.VITE_INTERNAL_API_KEY || "";

export function useCodental() {
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);

  async function call(params) {
    setLoading(true);
    setError(null);
    try {
      // _t=timestamp evita 304 do browser/CDN
      const qs = new URLSearchParams(
        Object.fromEntries(Object.entries({ ...params, _t: Date.now() }).filter(([,v]) => v != null))
      ).toString();
      const r = await fetch(`/api/codental?${qs}`, {
        headers: {
          "X-Internal-Key": ikey(),
          "Cache-Control":  "no-cache",
          "Pragma":         "no-cache",
        },
        cache: "no-store",
      });
      // 304 não tem body — retorna null silenciosamente
      if (r.status === 304) return null;
      if (!r.ok) {
        let data = {};
        try { data = await r.json(); } catch {}
        setError(data?.error || `HTTP ${r.status}`);
        return data;
      }
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