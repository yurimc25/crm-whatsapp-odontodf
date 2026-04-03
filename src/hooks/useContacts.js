import { useState, useEffect, useCallback } from "react";
import { cache } from "../utils/cache";

const LS_KEY = "contacts_map";
const LS_TTL = 60 * 60 * 1000;

export function wahaIdToPhone(wahaId) {
  return (wahaId || "").replace(/@.*$/, "").replace(/\D/g, "");
}

export function formatPhone(digits) {
  const d = (digits || "").replace(/\D/g, "");
  if (d.startsWith("55") && d.length === 13) return `(${d.slice(2,4)})${d.slice(4,9)}-${d.slice(9)}`;
  if (d.startsWith("55") && d.length === 12) return `(${d.slice(2,4)})${d.slice(4,8)}-${d.slice(8)}`;
  if (d.length === 11) return `(${d.slice(0,2)})${d.slice(2,7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0,2)})${d.slice(2,6)}-${d.slice(6)}`;
  return d || "—";
}

export function useContacts() {
  const [contactMap, setContactMap] = useState(() => cache.get(LS_KEY) || {});
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState(null);
  const [source, setSource]         = useState("cache");

  const internalKey = import.meta.env.VITE_INTERNAL_API_KEY || "";

  const fetchContacts = useCallback(async (force = false) => {
    const cached = cache.get(LS_KEY);
    if (!force && cached && Object.keys(cached).length > 0) {
      setContactMap(cached);
      return;
    }

    setLoading(true);
    setError(null);

    // Tenta MongoDB primeiro
    try {
      const mongoRes = await fetch(`/api/db?action=contacts_cache`, {
        headers: { "X-Internal-Key": internalKey },
      });
      if (mongoRes.ok) {
        const { contacts, expired } = await mongoRes.json();
        if (contacts && !expired && Object.keys(contacts).length > 0) {
          setContactMap(contacts);
          cache.set(LS_KEY, contacts, LS_TTL);
          setSource("mongo");
          setLoading(false);
          return;
        }
      }
    } catch (e) {
      console.warn("[contacts] MongoDB falhou:", e.message);
    }

    // Google API
    try {
      const r = await fetch("/api/contacts", {
        headers: { "X-Internal-Key": internalKey },
      });

      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${r.status}`);
      }

      const data = await r.json();
      const contacts = data.contacts || {};
      console.log("[contacts] carregados:", Object.keys(contacts).length);

      if (Object.keys(contacts).length > 0) {
        setContactMap(contacts);
        cache.set(LS_KEY, contacts, LS_TTL);
        setSource("google");

        fetch(`/api/db?action=contacts_cache`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Internal-Key": internalKey },
          body: JSON.stringify({ contacts }),
        }).catch(() => {});
      }
    } catch (e) {
      console.warn("[contacts] Google API falhou:", e.message);
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [internalKey]);

  useEffect(() => {
    fetchContacts();
    const interval = setInterval(() => fetchContacts(true), LS_TTL);
    return () => clearInterval(interval);
  }, [fetchContacts]);

  const resolveName = useCallback((wahaId) => {
    const phone = wahaIdToPhone(wahaId);
    return contactMap[phone] || null;
  }, [contactMap]);

  const displayName = useCallback((wahaId, fallback) => {
    return resolveName(wahaId) || fallback || formatPhone(wahaIdToPhone(wahaId));
  }, [resolveName]);

  const displayInfo = useCallback((wahaId, fallbackName) => {
    const phone       = wahaIdToPhone(wahaId);
    const fmtPhone    = formatPhone(phone);
    const contactName = resolveName(wahaId);
    if (contactName) return { hasContact: true, name: contactName, phone: fmtPhone };
    const rawNumber = fmtPhone !== "—" ? fmtPhone : (fallbackName || wahaId || "Desconhecido");
    return { hasContact: false, line1: rawNumber, line2: rawNumber, phone: fmtPhone };
  }, [resolveName]);

  return {
    contactMap, resolveName, displayName, displayInfo,
    loading, error, source,
    refresh: () => fetchContacts(true),
  };
}