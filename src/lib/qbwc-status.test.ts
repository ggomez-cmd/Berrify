import { describe, expect, it } from "vitest";
import {
  accountSyncSummary,
  invoiceBillJob,
  invoiceBooksStatus,
  invoiceQbJobLabel,
  qbwcStatusLabel,
  qbwcUiStatus,
  vendorSyncSummary,
} from "./qbwc-status";
import type { QuickbooksDesktopConnection, QuickbooksSyncJob } from "./types";

function connection(overrides: Partial<QuickbooksDesktopConnection> = {}): QuickbooksDesktopConnection {
  return {
    id: "c1",
    org_id: "org-1",
    restaurant_id: null,
    name: "Shared",
    qb_username: "bfy_test",
    owner_id: "11111111-1111-4111-8111-111111111111",
    file_id: "22222222-2222-4222-8222-222222222222",
    company_file: null,
    qb_company_name: null,
    qb_product_name: null,
    qb_major_version: null,
    qb_minor_version: null,
    is_active: true,
    last_connected_at: null,
    last_successful_sync_at: null,
    last_error: null,
    created_at: "2026-09-19T00:00:00.000Z",
    updated_at: "2026-09-19T00:00:00.000Z",
    ...overrides,
  };
}

function job(overrides: Partial<QuickbooksSyncJob> = {}): QuickbooksSyncJob {
  return {
    id: "j1",
    org_id: "org-1",
    connection_id: "c1",
    status: "pending",
    operation: "company_query",
    entity_type: "connection",
    entity_id: "c1",
    attempt_count: 0,
    error_code: null,
    error_message: null,
    quickbooks_txn_id: null,
    created_at: "2026-09-19T00:00:00.000Z",
    updated_at: "2026-09-19T00:00:00.000Z",
    ...overrides,
  };
}

describe("qbwcUiStatus", () => {
  it("is not configured when missing or revoked", () => {
    expect(qbwcUiStatus(null)).toBe("not_configured");
    expect(qbwcUiStatus(connection({ is_active: false }))).toBe("not_configured");
    expect(qbwcStatusLabel("not_configured")).toBe("Not configured");
  });

  it("is waiting until the first company query", () => {
    expect(qbwcUiStatus(connection())).toBe("waiting");
  });

  it("is syncing while a job is pending or sending", () => {
    expect(qbwcUiStatus(connection(), [job({ status: "pending" })])).toBe("syncing");
    expect(qbwcUiStatus(connection(), [job({ status: "sending" })])).toBe("syncing");
  });

  it("is connected after a successful company name or sync", () => {
    expect(qbwcUiStatus(connection({ qb_company_name: "Semilla" }))).toBe("connected");
    expect(qbwcUiStatus(connection({ last_successful_sync_at: "2026-09-19T01:00:00.000Z" }))).toBe(
      "connected",
    );
  });

  it("is error when last_error is set", () => {
    expect(qbwcUiStatus(connection({ last_error: "status 3120" }))).toBe("error");
  });
});

describe("vendor sync summary", () => {
  it("does not claim vendors synced until vendor_query completed", () => {
    const vendors = [
      {
        id: "v1",
        org_id: "org-1",
        connection_id: "c1",
        list_id: "1",
        full_name: "Local Farm",
        company_name: null,
        is_active: true,
        created_at: "2026-09-20T00:00:00.000Z",
        updated_at: "2026-09-20T00:00:00.000Z",
      },
    ];
    expect(vendorSyncSummary("c1", [], vendors).synced).toBe(false);
    expect(vendorSyncSummary("c1", [job({ operation: "vendor_query", status: "pending" })], vendors).synced).toBe(
      false,
    );
    expect(
      vendorSyncSummary("c1", [job({ operation: "vendor_query", status: "completed" })], vendors),
    ).toMatchObject({ synced: true, count: 1 });
  });
});

describe("account sync summary", () => {
  it("does not claim accounts synced until account_query completed", () => {
    const accounts = [
      {
        id: "a1",
        org_id: "org-1",
        connection_id: "c1",
        list_id: "1",
        full_name: "SalesTaxExpense",
        account_number: "68200",
        account_type: "Expense",
        is_active: true,
        created_at: "2026-09-20T00:00:00.000Z",
        updated_at: "2026-09-20T00:00:00.000Z",
      },
    ];
    expect(accountSyncSummary("c1", [], accounts).synced).toBe(false);
    expect(
      accountSyncSummary("c1", [job({ operation: "account_query", status: "pending" })], accounts).synced,
    ).toBe(false);
    expect(
      accountSyncSummary("c1", [job({ operation: "account_query", status: "completed" })], accounts),
    ).toMatchObject({ synced: true, count: 1 });
  });
});

describe("invoice QuickBooks job labels", () => {
  it("maps queue states and Synced TxnID", () => {
    const queued = job({ operation: "bill_add", entity_type: "invoice", entity_id: "inv-1" });
    expect(invoiceBillJob([queued], "inv-1")?.id).toBe("j1");
    expect(invoiceQbJobLabel(queued)).toBe("Queued");
    expect(invoiceQbJobLabel(job({ status: "sending" }))).toBe("Sending");
    expect(invoiceQbJobLabel(job({ status: "completed", quickbooks_txn_id: "77" }))).toBe("Synced (77)");
    expect(invoiceQbJobLabel(job({ status: "failed", error_message: "Vendor not found" }))).toBe(
      "Failed · Vendor not found",
    );
    expect(invoiceBooksStatus(null, "991")).toEqual({ label: "Synced (991)", tone: "ok" });
    expect(invoiceBooksStatus(null, null)).toBeNull();
  });
});
