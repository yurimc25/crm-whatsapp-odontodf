// party/server.ts
// PartyKit Durable Object — hub de tempo real do CRM
//
// Fluxo:
//   1. /api/webhook (Vercel) recebe evento do WAHA → POST /parties/crm/clinic
//   2. Este server recebe, guarda últimos 100 eventos em memória, broadcast para todos os browsers
//   3. Browser conecta via WebSocket e recebe eventos em tempo real
//
// Deploy: npx partykit deploy

import type * as Party from "partykit/server";

const INTERNAL_KEY = process.env.INTERNAL_API_KEY || "@Deuse10";
const RELEVANT_EVENTS = new Set(["message", "message.any", "chat.new", "message.revoked"]);

// Mantém últimos N eventos em memória para novos clientes que se conectam
const MAX_HISTORY = 50;

export default class CRMServer implements Party.Server {
  history: Array<{ event: string; payload: unknown; ts: number }> = [];

  constructor(readonly room: Party.Room) {}

  // Recebe webhook do WAHA (via /api/webhook no Vercel)
  async onRequest(req: Party.Request): Promise<Response> {
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

    // Valida chave interna
    const key = req.headers.get("x-internal-key");
    if (key !== INTERNAL_KEY) return new Response("unauthorized", { status: 401 });

    try {
      const body = await req.json() as { event: string; payload: unknown; session?: string };
      const { event, payload } = body;

      if (!event || !payload || !RELEVANT_EVENTS.has(event)) {
        return Response.json({ ok: true, skipped: event });
      }

      const envelope = { event, payload, ts: Date.now() };

      // Guarda no histórico (ring buffer)
      this.history.push(envelope);
      if (this.history.length > MAX_HISTORY) this.history.shift();

      // Broadcast para todos os browsers conectados
      this.room.broadcast(JSON.stringify(envelope));

      return Response.json({ ok: true, clients: [...this.room.getConnections()].length });
    } catch (e: unknown) {
      return new Response(String(e), { status: 400 });
    }
  }

  // Browser se conecta via WebSocket
  onConnect(conn: Party.Connection) {
    // Envia histórico recente para cliente que acabou de conectar
    // (últimos 30s para não mandar eventos muito velhos)
    const cutoff = Date.now() - 30_000;
    const recent = this.history.filter(e => e.ts > cutoff);
    if (recent.length > 0) {
      conn.send(JSON.stringify({ event: "history", payload: recent }));
    }
    conn.send(JSON.stringify({ event: "connected", payload: { ts: Date.now() } }));
  }

  onError(conn: Party.Connection, err: Error) {
    console.error("[party] conn error", err.message);
  }
}

export { CRMServer as default };
