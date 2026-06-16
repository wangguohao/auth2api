import { Request } from "express";

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function extractSessionKey(req: Request, body: any): string | undefined {
  const bodySession = firstString(
    body?.previous_response_id,
    body?.conversation_id,
    body?.session_id,
    body?.metadata?.session_id,
  );
  return bodySession || undefined;
}

export function buildSessionBindingKey(
  clientKeyHash: string | undefined,
  sessionKey: string | undefined,
): string | undefined {
  if (!sessionKey) return undefined;
  return clientKeyHash ? `${clientKeyHash}:${sessionKey}` : sessionKey;
}
