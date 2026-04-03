// src/hooks/useContacts.js
// Busca contatos do Google via /api/contacts (Vercel Function)
// Mantém um Map { "556199611055": "João Silva" } em memória
// Atualiza a cada 5 minutos

import { useState, useEffect, useCallback } from "react";

const CACHE_KEY  = "crm_contacts_cache";
const CACHE_TTL  = 5 * 60 * 1000; // 5 minutos

// Formato do número do WhatsApp → chave de lookup
// Ex: "556199611055@s.whatsapp.net" → "556199611055"
export function wahaIdToPhone(wahaId) {
  return (wahaId || "").replace(/@.*$/, "").replace(/\D/g, "");
}

// Formata número para exibição amigável: (61)9961-1055
export function formatPhone(digits) {
  const d = (digits || "").replace(/\D/g, "");
  // com DDI 55: 55 + DDD(2) + 9(1) + número(8) = 13 dígitos
  if (d.startsWith("55") && d.length === 13) {
    return `(${d.slice(2,4)})${d.slice(4,9)}-${d.slice(9)}`;
  }
  // com DDI 55: 55 + DDD(2) + número(8) = 12 dígitos (fixo)
  if (d.startsWith("55") && d.length === 12) {
    return `(${d.slice(2,4)})${d.slice(4,8)}-${d.slice(8)}`;
  }
  // sem DDI: DDD(2) + 9(1) + número(8) = 11 dígitos
  if (d.length === 11) {
    return `(${d.slice(0,2)})${d.slice(2,7)}-${d.slice(7)}`;
  }
  // sem DDI: DDD(2) + número(8) = 10 dígitos (fixo)
  if (d.length === 10) {
    return `(${d.slice(0,2)})${d.slice(2,6)}-${d.slice(6)}`;
  }
  return d || "—";
}

export function useContacts() {
  const [contactMap, setContactMap] = useState(() => {
    // Tenta carregar cache do sessionStorage
    try {
      const cached = sessionStorage.getItem(CACHE_KEY);
      if (cached) {
        const { map, ts } = JSON.parse(cached);
        if (Date.now() - ts < CACHE_TTL) return map;
      }
    } catch (_) {}
    return {};
  });
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);

  const fetchContacts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const internalKey = import.meta.env.VITE_INTERNAL_API_KEY || "";
      const r = await fetch("/api/contacts", {
        headers: { "X-Internal-Key": internalKey },
      });

      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${r.status}`);
      }

      const { contacts } = await r.json();
      setContactMap(contacts);

      // Salva no sessionStorage
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ map: contacts, ts: Date.now() }));
    } catch (e) {
      console.warn("[useContacts]", e.message);
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchContacts();
    const interval = setInterval(fetchContacts, CACHE_TTL);
    return () => clearInterval(interval);
  }, [fetchContacts]);

  // Resolve nome a partir do ID do WAHA
  const resolveName = useCallback((wahaId) => {
    const phone = wahaIdToPhone(wahaId);
    return contactMap[phone] || null;
  }, [contactMap]);

  // Retorna nome se existir, ou número formatado
  const displayName = useCallback((wahaId, fallback) => {
    return resolveName(wahaId) || fallback || formatPhone(wahaIdToPhone(wahaId));
  }, [resolveName]);

  // Retorna objeto completo para renderização na lista/header
  // Se tiver no Google Contacts: { hasContact: true, name: "João Silva", phone: "(61)9961-1055" }
  // Se não tiver:                { hasContact: false, line1: "(61)9961-1055", line2: "(61)9961-1055" }
  const displayInfo = useCallback((wahaId, fallbackName) => {
    const phone  = wahaIdToPhone(wahaId);
    const fmtPhone = formatPhone(phone);
    const contactName = resolveName(wahaId);

    if (contactName) {
      return { hasContact: true, name: contactName, phone: fmtPhone };
    }

    // Sem contato: gera duas linhas — número formatado + número formatado (fallback = rawId)
    const rawNumber = fmtPhone !== "—" ? fmtPhone : (fallbackName || wahaId || "Desconhecido");
    return { hasContact: false, line1: rawNumber, line2: rawNumber, phone: fmtPhone };
  }, [resolveName]);

  return { contactMap, resolveName, displayName, displayInfo, loading, error, refresh: fetchContacts };
}
