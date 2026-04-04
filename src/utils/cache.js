// src/utils/cache.js
// Utilitário de cache com localStorage + TTL
// Usado por useContacts e useWAHA para acelerar carregamento

const PREFIX = "crm_";

export const cache = {
  // Salva com TTL em milissegundos
  set(key, value, ttlMs = 5 * 60 * 1000) {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify({
        value,
        expires: Date.now() + ttlMs,
      }));
    } catch (e) {
      // localStorage cheio — ignora silenciosamente
      console.warn("[cache] set failed:", e.message);
    }
  },

  // Retorna valor se válido, null se expirado ou inexistente
  get(key) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      if (!raw) return null;
      const { value, expires } = JSON.parse(raw);
      if (Date.now() > expires) {
        localStorage.removeItem(PREFIX + key);
        return null;
      }
      return value;
    } catch {
      return null;
    }
  },

  // Remove uma chave
  remove(key) {
    try { localStorage.removeItem(PREFIX + key); } catch {}
  },

  // Remove todas as chaves do CRM
  clear() {
    try {
      Object.keys(localStorage)
        .filter(k => k.startsWith(PREFIX))
        .forEach(k => localStorage.removeItem(k));
    } catch {}
  },

  // Tamanho aproximado em KB
  sizeKB() {
    try {
      return Math.round(
        Object.keys(localStorage)
          .filter(k => k.startsWith(PREFIX))
          .reduce((acc, k) => acc + (localStorage.getItem(k) || "").length, 0) / 1024
      );
    } catch { return 0; }
  },
};
