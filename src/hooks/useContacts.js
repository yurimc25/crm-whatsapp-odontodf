// src/hooks/useContacts.js
// Camadas de cache: localStorage (instantâneo) → MongoDB (1h) → Google API
// O usuário vê os dados imediatamente do localStorage,
// enquanto o MongoDB e o Google atualizam em background.

import { useState, useEffect, useCallback } from "react";
import { cache } from "../utils/cache";

const LS_KEY   = "contacts_map";
const LS_TTL   = 60 * 60 * 1000; // 1 hora no localStorage
const API_TTL  = 60 * 60 * 1000; // 1 hora no MongoDB

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
  // 1. Carrega do localStorage imediatamente (zero latência)
  const [contactMap, setContactMap] = useState(() => cache.get(LS_KEY) || {});
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState(null);
  const [source, setSource]         = useState("cache"); // cache | mongo | google

  const internalKey = import.meta.env.VITE_INTERNAL_API_KEY || "";

  // 2. Tenta MongoDB (rápido, ~100ms), depois Google API se necessário
  const fetchContacts = useCallback(async (force = false) => {
    if (!force && cache.get(LS_KEY)) return; // localStorage válido, não precisa buscar

    setLoading(true);
    setError(null);

    try {
      // Tenta cache do MongoDB primeiro
      const mongoRes = await fetch(`/api/db?action=contacts_cache`, {
        headers: { "X-Internal-Key": internalKey },
      });

      if (mongoRes.ok) {
        const { contacts, expired } = await mongoRes.json();
        if (contacts && !expired) {
          setContactMap(contacts);
          cache.set(LS_KEY, contacts, LS_TTL);
          setSource("mongo");
          setLoading(false);
          return;
        }
      }
    } catch (e) {
      console.warn("[useContacts] MongoDB cache falhou, indo para Google API:", e.message);
    }

    // Busca na Google Contacts API via Vercel Function
    try {
      const r = await fetch("/api/contacts", {
        headers: { "X-Internal-Key": internalKey },
      });

      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${r.status}`);
      }

      const { contacts } = await r.json();
      setContactMap(contacts);
      cache.set(LS_KEY, contacts, LS_TTL);
      setSource("google");

      // Salva no MongoDB para próximas requisições
      fetch(`/api/db?action=contacts_cache`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Key": internalKey },
        body: JSON.stringify({ contacts }),
      }).catch(() => {});

    } catch (e) {
      console.warn("[useContacts] Google API falhou:", e.message);
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [internalKey]);

  useEffect(() => {
    fetchContacts();
    // Atualiza em background a cada hora
    const interval = setInterval(() => fetchContacts(true), API_TTL);
    return () => clearInterval(interval);
  }, [fetchContacts]);

  // Adiciona nomes do Codental ao mapa local sem sobrescrever Google Contacts
  // Recebe um array de { phone, name } ou um único { phone, name }
  const addLocalContact = useCallback((entries) => {
    const list = Array.isArray(entries) ? entries : [entries];
    setContactMap(prev => {
      let changed = false;
      const updated = { ...prev };
      for (const { phone, name } of list) {
        if (!phone || !name) continue;
        const digits = phone.replace(/\D/g, "");
        // Gera variantes do número para cobrir todos os formatos do WAHA
        const variants = new Set([digits]);
        // Com DDI 55
        if (!digits.startsWith("55")) variants.add("55" + digits);
        // Sem DDI 55
        const local = digits.startsWith("55") ? digits.slice(2) : digits;
        variants.add(local);
        // Com/sem o 9
        if (local.length === 11 && local[2] === "9") variants.add(local.slice(0,2) + local.slice(3));
        if (local.length === 10) variants.add(local.slice(0,2) + "9" + local.slice(2));

        for (const v of variants) {
          // Só adiciona se não tiver nome do Google Contacts (não sobrescreve)
          if (!prev[v]) {
            updated[v] = name;
            changed = true;
          }
        }
      }
      if (!changed) return prev;
      // Salva no localStorage sem alterar TTL (é temporário, session-only)
      try {
        const raw = localStorage.getItem("crm_" + LS_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          parsed.value = { ...parsed.value, ...updated };
          localStorage.setItem("crm_" + LS_KEY, JSON.stringify(parsed));
        }
      } catch {}
      return updated;
    });
  }, []);

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

    if (contactName) {
      return { hasContact: true, name: contactName, phone: fmtPhone };
    }
    const rawNumber = fmtPhone !== "—" ? fmtPhone : (fallbackName || wahaId || "Desconhecido");
    return { hasContact: false, line1: rawNumber, line2: rawNumber, phone: fmtPhone };
  }, [resolveName]);

  return {
    contactMap, resolveName, displayName, displayInfo,
    addLocalContact,
    loading, error, source,
    refresh: () => fetchContacts(true),
  };
}