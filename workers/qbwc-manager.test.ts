import { describe, expect, it } from "vitest";
import {
  handleDownloadQwc,
  handleRefreshAccounts,
  handleRefreshVendors,
  handleSendInvoice,
  parseManagerPath,
  requireManager,
  resolveInvoiceConnection,
} from "./qbwc-manager";

const env = {
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role",
};

function managerRequest(origin = "https://berrify.example"): Request {
  return new Request("https://berrify.example/api/qbwc/connections", {
    method: "POST",
    headers: {
      Origin: origin,
      Authorization: "Bearer user-token",
      "Content-Type": "application/json",
    },
  });
}

describe("QBWC manager routes", () => {
  it("parses create, rotate, revoke, and qwc paths", () => {
    expect(parseManagerPath("/api/qbwc/connections")).toEqual({ kind: "create" });
    expect(parseManagerPath("/api/qbwc/connections/abc/rotate")).toEqual({ kind: "rotate", id: "abc" });
    expect(parseManagerPath("/api/qbwc/connections/abc/revoke")).toEqual({ kind: "revoke", id: "abc" });
    expect(parseManagerPath("/api/qbwc/connections/abc/qwc")).toEqual({ kind: "qwc", id: "abc" });
    expect(parseManagerPath("/api/qbwc/connections/abc/vendors")).toEqual({ kind: "refresh-vendors", id: "abc" });
    expect(parseManagerPath("/api/qbwc/connections/abc/accounts")).toEqual({ kind: "refresh-accounts", id: "abc" });
    expect(parseManagerPath("/api/qbwc/invoices/inv-1/send")).toEqual({ kind: "send-invoice", id: "inv-1" });
    expect(parseManagerPath("/api/qbwc")).toBeNull();
  });

  it("rejects staff and other-origin callers", async () => {
    const staffFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/v1/user")) return Response.json({ id: "user-1" });
      if (url.includes("/rest/v1/memberships")) return Response.json([{ org_id: "org-1", role: "staff" }]);
      throw new Error(url);
    };
    const denied = await requireManager(managerRequest(), env, staffFetch);
    expect(denied).toBeInstanceOf(Response);
    expect((denied as Response).status).toBe(403);

    const crossOrigin = await requireManager(
      managerRequest("https://evil.example"),
      env,
      async () => Response.json({ id: "user-1" }),
    );
    expect(crossOrigin).toBeInstanceOf(Response);
    expect((crossOrigin as Response).status).toBe(401);
  });

  it("accepts a manager in their org", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/v1/user")) return Response.json({ id: "user-1" });
      if (url.includes("/rest/v1/memberships")) return Response.json([{ org_id: "org-1", role: "manager" }]);
      throw new Error(url);
    };
    const allowed = await requireManager(managerRequest(), env, fetchImpl);
    expect(allowed).toEqual({ userId: "user-1", orgId: "org-1", role: "manager" });
  });

  it("does not download another org's qwc", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("quickbooks_desktop_connections")) {
        expect(url).toContain("org_id=eq.org-1");
        return Response.json([]);
      }
      throw new Error(url);
    };
    const response = await handleDownloadQwc(
      env,
      { userId: "user-1", orgId: "org-1", role: "manager" },
      "conn-other-org",
      fetchImpl,
    );
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("OwnerID");
  });
});

const kaneConn = {
  id: "conn-kane",
  org_id: "org-1",
  restaurant_id: "rest-kane",
  name: "Kane",
  qb_username: "bfy_kane",
  password_hash: "hash",
  owner_id: "o",
  file_id: "f",
  company_file: null,
  qb_company_name: "Kane",
  qb_product_name: null,
  qb_major_version: null,
  qb_minor_version: null,
  is_active: true,
  last_connected_at: "2026-09-19T00:00:00.000Z",
  last_successful_sync_at: "2026-09-19T00:00:00.000Z",
  last_error: null,
};

function invoiceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "inv-1",
    org_id: "org-1",
    restaurant_id: "rest-kane",
    supplier_id: "sup-1",
    vendor_name: "Jose Santiago Inc",
    invoice_number: "6512495",
    invoice_date: "2026-08-12",
    due_date: "2026-08-27",
    terms: "Net 15",
    ap_account: "20000 · Accounts payable",
    status: "reviewed",
    total: 10,
    suppliers: { name: "Jose Santiago Inc" },
    invoice_expense_lines: [{ account: "50000 · Food Purchases", amount: 10, memo: "Food" }],
    ...overrides,
  };
}

function sendFetch(options: {
  invoice?: unknown[] | "missing";
  connections?: unknown[];
  jobs?: Array<Record<string, unknown>>;
  online?: unknown[];
}): typeof fetch {
  const jobs = options.jobs ?? [];
  return async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("/rest/v1/invoices") && method === "GET") {
      if (!url.includes("org_id=eq.org-1")) return Response.json([]);
      if (options.invoice === "missing") return Response.json([]);
      return Response.json(options.invoice ?? [invoiceRow()]);
    }
    if (url.includes("quickbooks_accounts") && method === "GET") {
      return Response.json([
        {
          connection_id: "conn-kane",
          list_id: "80000012-3",
          full_name: "Accounts Payable",
          account_number: "20000",
          account_type: "AccountsPayable",
          is_active: true,
        },
        {
          connection_id: "conn-kane",
          list_id: "80000010-1",
          full_name: "Food Purchases",
          account_number: "50000",
          account_type: "Expense",
          is_active: true,
        },
      ]);
    }
    if (url.includes("quickbooks_online_connections") && method === "GET") {
      const rows = (options.online ?? []) as Array<{ restaurant_id: string }>;
      if (url.includes("restaurant_id=eq.")) {
        const match = /restaurant_id=eq\.([^&]+)/.exec(url);
        const restaurantId = decodeURIComponent(match?.[1] ?? "");
        return Response.json(rows.filter((row) => row.restaurant_id === restaurantId));
      }
      return Response.json(rows);
    }
    if (url.includes("quickbooks_desktop_connections") && method === "GET") {
      const rows = (options.connections ?? [kaneConn]) as Array<{ restaurant_id: string | null }>;
      if (url.includes("restaurant_id=is.null")) {
        return Response.json(rows.filter((row) => row.restaurant_id == null));
      }
      if (url.includes("restaurant_id=eq.")) {
        const match = /restaurant_id=eq\.([^&]+)/.exec(url);
        return Response.json(rows.filter((row) => row.restaurant_id === match?.[1]));
      }
      return Response.json(rows);
    }
    if (url.includes("quickbooks_sync_jobs")) {
      if (method === "GET") return Response.json(jobs.slice(0, 1));
      if (method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const created = {
          id: "job-bill",
          status: "pending",
          operation: body.operation ?? "bill_add",
          entity_type: body.entity_type ?? "invoice",
          entity_id: body.entity_id,
          connection_id: body.connection_id,
          error_message: null,
          quickbooks_txn_id: null,
          qbxml_request: body.qbxml_request,
        };
        jobs.push(created);
        return Response.json([created], { status: 201 });
      }
      if (method === "PATCH") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        Object.assign(jobs[0] ?? {}, body);
        return Response.json(jobs.slice(0, 1));
      }
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
}

describe("invoice Send to QuickBooks", () => {
  const manager = { userId: "user-1", orgId: "org-1", role: "manager" };

  it("rejects non-reviewed invoices", async () => {
    const response = await handleSendInvoice(
      env,
      manager,
      "inv-1",
      sendFetch({ invoice: [invoiceRow({ status: "extracted" })] }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "Invoice must be reviewed before sending to QuickBooks",
    });
  });

  it("rejects another org's invoice", async () => {
    const response = await handleSendInvoice(env, manager, "inv-other", sendFetch({ invoice: "missing" }));
    expect(response.status).toBe(404);
  });

  it("does not send Semilla to Kane when Semilla has no Connected connector", async () => {
    const response = await handleSendInvoice(
      env,
      manager,
      "inv-semilla",
      sendFetch({
        invoice: [invoiceRow({ id: "inv-semilla", restaurant_id: "rest-semilla" })],
        connections: [kaneConn],
      }),
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("Semilla invoices are not sent to Kane");
  });

  it("queues bill_add on the restaurant Connected connector", async () => {
    const response = await handleSendInvoice(env, manager, "inv-1", sendFetch({}));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { job: { operation: string; connection_id: string } };
    expect(body.job.operation).toBe("bill_add");
    expect(body.job.connection_id).toBe("conn-kane");
  });

  it("uses the org shared connector when the restaurant has none", async () => {
    const shared = { ...kaneConn, id: "conn-shared", restaurant_id: null, name: "Shared" };
    const response = await handleSendInvoice(
      env,
      manager,
      "inv-1",
      sendFetch({
        invoice: [invoiceRow({ restaurant_id: "rest-semilla" })],
        connections: [shared],
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { job: { connection_id: string } };
    expect(body.job.connection_id).toBe("conn-shared");
  });

  it("prefills BillAdd with the invoice vendor_name FullName", async () => {
    const jobs: Array<Record<string, unknown>> = [];
    const response = await handleSendInvoice(
      env,
      manager,
      "inv-1",
      sendFetch({
        invoice: [invoiceRow({ vendor_name: "Jose Santiago Inc (food)", suppliers: { name: "Jose Santiago" } })],
        jobs,
      }),
    );
    expect(response.status).toBe(200);
    expect(String(jobs[0]?.qbxml_request)).toContain("Jose Santiago Inc (food)");
    expect(String(jobs[0]?.qbxml_request)).not.toContain("<FullName>Jose Santiago</FullName>");
  });

  it("writes ListID account refs and omits invalid terms from BillAdd XML", async () => {
    const jobs: Array<Record<string, unknown>> = [];
    const response = await handleSendInvoice(
      env,
      manager,
      "inv-1",
      sendFetch({
        invoice: [
          invoiceRow({
            vendor_name: "B. Fernández",
            invoice_number: "01016543",
            terms: "Net30",
            ap_account: "20000 · Accounts payable",
            invoice_expense_lines: [{ account: "50000 · Food Purchases", amount: 10, memo: "Food" }],
          }),
        ],
        jobs,
      }),
    );
    expect(response.status).toBe(200);
    const xml = String(jobs[0]?.qbxml_request);
    expect(xml).toContain('<?xml version="1.0" encoding="utf-8"?>');
    expect(xml).toContain("<FullName>B. Fernández</FullName>");
    expect(xml).toContain("<ListID>80000012-3</ListID>");
    expect(xml).toContain("<ListID>80000010-1</ListID>");
    expect(xml).not.toContain("20000 ·");
    expect(xml).not.toContain("50000 ·");
    expect(xml).not.toContain("TermsRef");
    expect(xml).toContain("<DueDate>2026-08-27</DueDate>");
  });

  it("queues vendor_query on Refresh vendors for a Connected file", async () => {
    const jobs: Array<Record<string, unknown>> = [];
    const response = await handleRefreshVendors(
      env,
      manager,
      "conn-kane",
      sendFetch({ connections: [kaneConn], jobs }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ operation: "vendor_query", result: "inserted" });
    expect(jobs.some((job) => job.operation === "bill_add")).toBe(false);
  });

  it("queues account_query on Refresh accounts without creating Bills", async () => {
    const jobs: Array<Record<string, unknown>> = [];
    const response = await handleRefreshAccounts(
      env,
      manager,
      "conn-kane",
      sendFetch({ connections: [kaneConn], jobs }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ operation: "account_query", result: "inserted" });
    expect(jobs[0]?.qbxml_request).toEqual(expect.stringContaining("AccountQueryRq"));
    expect(jobs[0]?.qbxml_request).toEqual(expect.not.stringContaining("BillAddRq"));
    expect(jobs.some((job) => job.operation === "bill_add")).toBe(false);
  });

  it("does not treat a waiting restaurant connector as Connected", async () => {
    const picked = await resolveInvoiceConnection(
      env,
      "org-1",
      "rest-kane",
      sendFetch({
        connections: [{ ...kaneConn, last_connected_at: null }],
      }),
    );
    expect(picked).toBeNull();
  });
});
