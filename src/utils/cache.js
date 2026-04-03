const PREFIX = "crm_";

export const cache = {
  set(key, value, ttlMs = 5 * 60 * 1000) {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify({
        value,
        expires: Date.now() + ttlMs,
      }));
    } catch (e) {
      console.warn("[cache] set failed:", e.message);
    }
  },

  get(key) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      // suporte a formato antigo (sem wrapper)
      if (!parsed || typeof parsed !== "object" || !("value" in parsed)) return null;
      if (Date.now() > parsed.expires) {
        localStorage.removeItem(PREFIX + key);
        return null;
      }
      return parsed.value;
    } catch {
      return null;
    }
  },

  remove(key) {
    try { localStorage.removeItem(PREFIX + key); } catch {}
  },

  clear() {
    try {
      Object.keys(localStorage)
        .filter(k => k.startsWith(PREFIX))
        .forEach(k => localStorage.removeItem(k));
    } catch {}
  },
};