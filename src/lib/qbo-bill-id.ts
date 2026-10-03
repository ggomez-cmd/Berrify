export const QBO_SEND_PENDING_PREFIX = "pending:";

export function isPersistedQboBillId(txnId: string | null | undefined): boolean {
  const trimmed = txnId?.trim() ?? "";
  return trimmed.length > 0 && !trimmed.startsWith(QBO_SEND_PENDING_PREFIX);
}

export function parseQboSendClaim(txnId: string | null | undefined): { createdAt: number } | null {
  const trimmed = txnId?.trim() ?? "";
  if (!trimmed.startsWith(QBO_SEND_PENDING_PREFIX)) return null;
  const createdAt = Number(trimmed.slice(QBO_SEND_PENDING_PREFIX.length).split(":")[0]);
  if (!Number.isFinite(createdAt)) return null;
  return { createdAt };
}

export function newQboSendClaim(now = Date.now()): string {
  return `${QBO_SEND_PENDING_PREFIX}${now}:${crypto.randomUUID()}`;
}
