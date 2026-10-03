import { isPersistedQboBillId } from "./qbo-bill-id";
import type {
  QbwcUiStatus,
  QuickbooksAccount,
  QuickbooksDesktopConnection,
  QuickbooksOnlineConnection,
  QuickbooksSyncJob,
  QuickbooksVendor,
} from "./types";

export function qbwcUiStatus(
  connection: QuickbooksDesktopConnection | null | undefined,
  jobs: QuickbooksSyncJob[] = [],
): QbwcUiStatus {
  if (!connection || !connection.is_active) return "not_configured";
  const open = jobs.some((job) => job.status === "pending" || job.status === "sending");
  if (open) return "syncing";
  if (connection.last_error) return "error";
  if (connection.last_successful_sync_at || connection.qb_company_name) return "connected";
  return "waiting";
}

export type InvoiceQbJobUi = "queued" | "sending" | "synced" | "failed";

export function invoiceBillJob(jobs: QuickbooksSyncJob[], invoiceId: string): QuickbooksSyncJob | null {
  return (
    jobs.find((job) => job.entity_type === "invoice" && job.entity_id === invoiceId && job.operation === "bill_add") ??
    null
  );
}

export function invoiceQbJobUi(job: QuickbooksSyncJob): InvoiceQbJobUi {
  switch (job.status) {
    case "pending":
      return "queued";
    case "sending":
      return "sending";
    case "completed":
      return "synced";
    case "failed":
      return "failed";
    default: {
      const exhaustive: never = job.status;
      return exhaustive;
    }
  }
}

export function invoiceBooksStatus(
  job: QuickbooksSyncJob | null,
  txnId?: string | null,
): { label: string; tone: "ok" | "danger" | "info" | "warn" } | null {
  if (job) {
    const ui = invoiceQbJobUi(job);
    switch (ui) {
      case "synced":
        return { label: invoiceQbJobLabel(job, txnId), tone: "ok" };
      case "failed":
        return { label: invoiceQbJobLabel(job, txnId), tone: "danger" };
      case "sending":
        return { label: invoiceQbJobLabel(job, txnId), tone: "info" };
      case "queued":
        return { label: invoiceQbJobLabel(job, txnId), tone: "warn" };
      default: {
        const exhaustive: never = ui;
        return exhaustive;
      }
    }
  }
  if (txnId && !isPersistedQboBillId(txnId)) return { label: "Sending", tone: "info" };
  if (isPersistedQboBillId(txnId)) return { label: `Synced (${txnId})`, tone: "ok" };
  return null;
}

export function qboOnlineStatusLabel(
  connection: QuickbooksOnlineConnection | null | undefined,
): { label: string; tone: "ok" | "danger" | "neutral" } {
  if (!connection || !connection.is_active) {
    return { label: "Online not connected", tone: "neutral" };
  }
  if (connection.last_error) return { label: "Online error", tone: "danger" };
  return { label: "Online connected", tone: "ok" };
}

export function invoiceQbJobLabel(job: QuickbooksSyncJob, txnId?: string | null): string {
  const ui = invoiceQbJobUi(job);
  switch (ui) {
    case "queued":
      return "Queued";
    case "sending":
      return "Sending";
    case "synced": {
      const id = txnId ?? job.quickbooks_txn_id;
      return id ? `Synced (${id})` : "Synced";
    }
    case "failed":
      return job.error_message ? `Failed · ${job.error_message}` : "Failed";
    default: {
      const exhaustive: never = ui;
      return exhaustive;
    }
  }
}

export function vendorQueryJob(jobs: QuickbooksSyncJob[], connectionId: string): QuickbooksSyncJob | null {
  return (
    jobs.find(
      (job) =>
        job.connection_id === connectionId &&
        job.operation === "vendor_query" &&
        job.entity_type === "connection",
    ) ?? null
  );
}

export function vendorSyncSummary(
  connectionId: string,
  jobs: QuickbooksSyncJob[],
  vendors: QuickbooksVendor[],
): { synced: boolean; count: number; at: string | null } {
  const job = vendorQueryJob(jobs, connectionId);
  const completed = job?.status === "completed";
  const count = vendors.filter((row) => row.connection_id === connectionId && row.is_active).length;
  return {
    synced: Boolean(completed),
    count: completed ? count : 0,
    at: completed ? job?.updated_at ?? null : null,
  };
}

export function accountQueryJob(jobs: QuickbooksSyncJob[], connectionId: string): QuickbooksSyncJob | null {
  return (
    jobs.find(
      (job) =>
        job.connection_id === connectionId &&
        job.operation === "account_query" &&
        job.entity_type === "connection",
    ) ?? null
  );
}

export function accountSyncSummary(
  connectionId: string,
  jobs: QuickbooksSyncJob[],
  accounts: QuickbooksAccount[],
): { synced: boolean; count: number; at: string | null } {
  const job = accountQueryJob(jobs, connectionId);
  const completed = job?.status === "completed";
  const count = accounts.filter((row) => row.connection_id === connectionId && row.is_active).length;
  return {
    synced: Boolean(completed),
    count: completed ? count : 0,
    at: completed ? job?.updated_at ?? null : null,
  };
}

export function qbwcStatusLabel(status: QbwcUiStatus): string {
  switch (status) {
    case "not_configured":
      return "Not configured";
    case "waiting":
      return "Waiting for QuickBooks";
    case "connected":
      return "Connected";
    case "syncing":
      return "Syncing";
    case "error":
      return "Error";
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}
