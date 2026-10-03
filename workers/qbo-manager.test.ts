import { describe, expect, it } from "vitest";
import { handleSendInvoice } from "./qbwc-manager";
import { handleQbo, parseQboPath } from "./qbo-manager";

const supabaseEnv = {
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role",
  PUBLIC_APP_URL: "https://berrify.app",
};

const intuitEnv = {
  ...supabaseEnv,
  INTUIT_CLIENT_ID: "test-client-id",
  INTUIT_CLIENT_SECRET: "test-client-secret",
};

function managerRequest(path: string, body?: unknown): Request {
  return new Request(`https://berrify.example${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Origin: "https://berrify.example",
      Authorization: "Bearer user-token",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function withManager(extra: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) return Response.json({ id: "user-1" });
    if (url.includes("/rest/v1/memberships")) return Response.json([{ org_id: "org-1", role: "manager" }]);
    return extra(input, init);
  };
}

const kaneDesktop = {
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

const semillaOnline = {
  id: "qbo-semilla",
  org_id: "org-1",
  restaurant_id: "rest-semilla",
  realm_id: "12345",
  refresh_token: "refresh-semilla",
  access_token: "access-semilla",
  access_token_expires_at: "2099-01-01T00:00:00.000Z",
  company_name: "Semilla",
  is_active: true,
  last_synced_at: null,
  last_error: null,
};

function invoiceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "inv-1",
    org_id: "org-1",
    restaurant_id: "rest-kane",
    supplier_id: "sup-1",
    vendor_name: "Local Farm",
    invoice_number: "6512495",
    invoice_date: "2026-08-12",
    due_date: "2026-08-27",
    terms: "Net 15",
    ap_account: "20000 · Accounts payable",
    status: "reviewed",
    total: 10,
    quickbooks_txn_id: null,
    suppliers: { name: "Local Farm" },
    invoice_expense_lines: [{ account: "50000 · Food Purchases", amount: 10, memo: "Food" }],
    ...overrides,
  };
}

function isIntuitVendorCreate(url: string, method: string): boolean {
  return method === "POST" && /\/v3\/company\/[^/]+\/vendor(\?|$)/.test(url);
}

describe("QuickBooks Online routes", () => {
  it("parses connect, callback, and sync paths", () => {
    expect(parseQboPath("/api/qbo/config")).toEqual({ kind: "config" });
    expect(parseQboPath("/api/qbo/connect")).toEqual({ kind: "connect" });
    expect(parseQboPath("/api/qbo/callback")).toEqual({ kind: "callback" });
    expect(parseQboPath("/api/qbo/connections/abc/vendors")).toEqual({ kind: "refresh-vendors", id: "abc" });
    expect(parseQboPath("/api/qbo/connections/abc/accounts")).toEqual({ kind: "refresh-accounts", id: "abc" });
    expect(parseQboPath("/api/qbo/connections/abc/disconnect")).toEqual({ kind: "disconnect", id: "abc" });
    expect(parseQboPath("/api/qbwc")).toBeNull();
  });

  it("explains missing Intuit secrets on connect", async () => {
    const response = await handleQbo(
      managerRequest("/api/qbo/connect", { restaurant_id: "rest-semilla" }),
      supabaseEnv,
      "/api/qbo/connect",
      withManager(async () => {
        throw new Error("should not call Intuit");
      }),
    );
    expect(response?.status).toBe(503);
    const body = (await response?.json()) as { error: string };
    expect(body.error).toContain("INTUIT_CLIENT_ID");
    expect(body.error).toContain("INTUIT_CLIENT_SECRET");
    expect(body.error).toContain("https://berrify.app/api/qbo/callback");
    expect(JSON.stringify(body)).not.toContain("test-client-secret");
  });

  it("starts OAuth for one restaurant without putting the secret in the URL", async () => {
    let storedRestaurant = "";
    const response = await handleQbo(
      managerRequest("/api/qbo/connect", { restaurant_id: "rest-semilla" }),
      intuitEnv,
      "/api/qbo/connect",
      withManager(async (input, init) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url.includes("/rest/v1/restaurants")) return Response.json([{ id: "rest-semilla" }]);
        if (url.includes("quickbooks_online_oauth_states") && method === "POST") {
          storedRestaurant = JSON.parse(String(init?.body)).restaurant_id as string;
          return new Response(null, { status: 201 });
        }
        throw new Error(`${method} ${url}`);
      }),
    );
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as { url: string };
    expect(storedRestaurant).toBe("rest-semilla");
    expect(body.url).toContain("client_id=test-client-id");
    expect(body.url).toContain("redirect_uri=https%3A%2F%2Fberrify.app%2Fapi%2Fqbo%2Fcallback");
    expect(body.url).not.toContain("test-client-secret");
  });
});

describe("QuickBooks Online callback", () => {
  it("stores the realm and refresh token and syncs that company only", async () => {
    const writes: string[] = [];
    const response = await handleQbo(
      new Request(
        "https://berrify.app/api/qbo/callback?code=auth-code&state=state-1&realmId=12345",
      ),
      intuitEnv,
      "/api/qbo/callback",
      async (input, init) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        writes.push(`${method} ${url}`);
        if (url.includes("quickbooks_online_oauth_states") && method === "GET") {
          return Response.json([
            {
              state: "state-1",
              org_id: "org-1",
              restaurant_id: "rest-semilla",
              expires_at: "2099-01-01T00:00:00.000Z",
            },
          ]);
        }
        if (url.includes("quickbooks_online_oauth_states") && method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        if (url.includes("oauth.platform.intuit.com")) {
          return Response.json({
            access_token: "access-new",
            refresh_token: "refresh-new",
            expires_in: 3600,
          });
        }
        if (url.includes("/companyinfo/")) return Response.json({ CompanyInfo: { CompanyName: "Semilla QBO" } });
        if (url.includes("quickbooks_online_connections") && method === "GET") return Response.json([]);
        if (url.includes("quickbooks_online_connections") && method === "POST") {
          const body = JSON.parse(String(init?.body)) as { realm_id: string; refresh_token: string; restaurant_id: string };
          expect(body.restaurant_id).toBe("rest-semilla");
          expect(body.realm_id).toBe("12345");
          expect(body.refresh_token).toBe("refresh-new");
          return Response.json([{ ...semillaOnline, refresh_token: body.refresh_token, access_token: "access-new" }]);
        }
        if (url.includes("quickbooks_online_connections") && method === "PATCH") {
          return new Response(null, { status: 204 });
        }
        if (url.includes("/query") && url.includes("Vendor")) {
          expect(url).toContain("/v3/company/12345/query");
          return Response.json({
            QueryResponse: { Vendor: [{ Id: "56", DisplayName: "Local Farm", Active: true }] },
          });
        }
        if (url.includes("/query") && url.includes("Account")) {
          expect(url).toContain("/v3/company/12345/query");
          return Response.json({
            QueryResponse: {
              Account: [{ Id: "7", FullyQualifiedName: "Food Purchases", AcctNum: "50000", AccountType: "Expense", Active: true }],
            },
          });
        }
        if (url.includes("quickbooks_online_vendors") && method === "GET") return Response.json([]);
        if (url.includes("quickbooks_online_accounts") && method === "GET") return Response.json([]);
        if (url.includes("quickbooks_online_vendors") && method === "POST") return new Response(null, { status: 201 });
        if (url.includes("quickbooks_online_accounts") && method === "POST") return new Response(null, { status: 201 });
        throw new Error(`${method} ${url}`);
      },
    );
    expect(response?.status).toBe(302);
    const location = response?.headers.get("Location") ?? "";
    expect(location).toContain("https://berrify.app/quickbooks?qbo=connected");
    expect(location).not.toContain("refresh-new");
    expect(location).not.toContain("test-client-secret");
    expect(await response?.text()).toBe("");
    expect(writes.some((line) => isIntuitVendorCreate(line.slice(line.indexOf(" ") + 1), line.slice(0, line.indexOf(" "))))).toBe(
      false,
    );
  });
});

describe("Send routes Desktop and Online apart", () => {
  const manager = { userId: "user-1", orgId: "org-1", role: "manager" };

  function sendFetch(input: {
    invoice: Record<string, unknown>;
    online: Array<Record<string, unknown>>;
    desktop: Array<Record<string, unknown>>;
    vendors?: unknown[];
    accounts?: unknown[];
    intuit?: (url: string, method: string, body: string) => Response | Promise<Response>;
  }): { fetchImpl: typeof fetch; jobs: Array<Record<string, unknown>>; intuitUrls: string[]; invoicePatches: unknown[] } {
    const jobs: Array<Record<string, unknown>> = [];
    const intuitUrls: string[] = [];
    const invoicePatches: unknown[] = [];
    const fetchImpl: typeof fetch = async (request, init) => {
      const url = String(request);
      const method = (init?.method ?? "GET").toUpperCase();
      const body = typeof init?.body === "string" ? init.body : "";
      if (url.includes("intuit.com")) {
        intuitUrls.push(`${method} ${url}`);
        if (isIntuitVendorCreate(url, method)) throw new Error("VendorAdd");
        if (input.intuit) return input.intuit(url, method, body);
        throw new Error(`${method} ${url}`);
      }
      if (url.includes("/rest/v1/invoices") && method === "GET") return Response.json([input.invoice]);
      if (url.includes("/rest/v1/invoices") && method === "PATCH") {
        invoicePatches.push(JSON.parse(body));
        return new Response(null, { status: 204 });
      }
      if (url.includes("quickbooks_online_connections") && method === "GET") {
        const match = /restaurant_id=eq\.([^&]+)/.exec(url);
        const restaurantId = decodeURIComponent(match?.[1] ?? "");
        return Response.json(input.online.filter((row) => row.restaurant_id === restaurantId));
      }
      if (url.includes("quickbooks_online_connections") && method === "PATCH") {
        return new Response(null, { status: 204 });
      }
      if (url.includes("quickbooks_online_vendors") && method === "GET") return Response.json(input.vendors ?? []);
      if (url.includes("quickbooks_online_accounts") && method === "GET") return Response.json(input.accounts ?? []);
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
      if (url.includes("quickbooks_desktop_connections") && method === "GET") {
        if (url.includes("restaurant_id=is.null")) {
          return Response.json(input.desktop.filter((row) => row.restaurant_id == null));
        }
        const match = /restaurant_id=eq\.([^&]+)/.exec(url);
        const restaurantId = decodeURIComponent(match?.[1] ?? "");
        return Response.json(input.desktop.filter((row) => row.restaurant_id === restaurantId));
      }
      if (url.includes("quickbooks_sync_jobs") && method === "POST") {
        const created = JSON.parse(body) as Record<string, unknown>;
        jobs.push(created);
        return Response.json([{ id: "job-bill", status: "pending", ...created }], { status: 201 });
      }
      if (url.includes("quickbooks_sync_jobs") && method === "GET") return Response.json(jobs.slice(0, 1));
      throw new Error(`${method} ${url}`);
    };
    return { fetchImpl, jobs, intuitUrls, invoicePatches };
  }

  it("queues Kane on Desktop and does not call QuickBooks Online", async () => {
    const harness = sendFetch({
      invoice: invoiceRow(),
      online: [semillaOnline],
      desktop: [kaneDesktop],
    });
    const response = await handleSendInvoice(supabaseEnv, manager, "inv-1", harness.fetchImpl);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { job: { connection_id: string; operation: string } };
    expect(body.job.connection_id).toBe("conn-kane");
    expect(body.job.operation).toBe("bill_add");
    expect(harness.intuitUrls).toEqual([]);
    expect(String(harness.jobs[0]?.qbxml_request)).toContain("BillAdd");
  });

  it("posts a QuickBooks Online bill and does not queue BillAdd", async () => {
    const harness = sendFetch({
      invoice: invoiceRow({ id: "inv-semilla", restaurant_id: "rest-semilla" }),
      online: [semillaOnline],
      desktop: [{ ...kaneDesktop, id: "conn-shared", restaurant_id: null }],
      vendors: [{ connection_id: "qbo-semilla", list_id: "56", full_name: "Local Farm", is_active: true }],
      accounts: [
        {
          connection_id: "qbo-semilla",
          list_id: "7",
          full_name: "Food Purchases",
          account_number: "50000",
          account_type: "Expense",
          is_active: true,
        },
      ],
      intuit: async (url, method, body) => {
        expect(method).toBe("POST");
        expect(url).toContain("/v3/company/12345/bill");
        const bill = JSON.parse(body) as {
          VendorRef: { value: string };
          Line: Array<{ AccountBasedExpenseLineDetail: { AccountRef: { value: string } } }>;
        };
        expect(bill.VendorRef.value).toBe("56");
        expect(bill.Line[0]?.AccountBasedExpenseLineDetail.AccountRef.value).toBe("7");
        return Response.json({ Bill: { Id: "991", SyncToken: "0" } });
      },
    });
    const response = await handleSendInvoice(intuitEnv, manager, "inv-semilla", harness.fetchImpl);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { job: { quickbooks_txn_id: string; operation: string } };
    expect(body.job.operation).toBe("qbo_bill");
    expect(body.job.quickbooks_txn_id).toBe("991");
    expect(JSON.stringify(body)).not.toContain("refresh-semilla");
    expect(JSON.stringify(body)).not.toContain("access-semilla");
    expect(harness.jobs).toEqual([]);
    expect(harness.invoicePatches).toEqual([
      { quickbooks_txn_id: "991", quickbooks_edit_sequence: "0" },
    ]);
  });

  it("returns the Intuit message when the vendor is missing and does not create one", async () => {
    const harness = sendFetch({
      invoice: invoiceRow({ id: "inv-semilla", restaurant_id: "rest-semilla", vendor_name: "Missing Vendor" }),
      online: [semillaOnline],
      desktop: [kaneDesktop],
      vendors: [],
      intuit: async (url) => {
        expect(url).toContain("/query");
        expect(url).not.toContain("/vendor");
        return Response.json(
          {
            Fault: {
              Error: [{ Message: "Invalid Reference Id", Detail: "Vendor assigned to this transaction has been deleted." }],
            },
          },
          { status: 400 },
        );
      },
    });
    const response = await handleSendInvoice(intuitEnv, manager, "inv-semilla", harness.fetchImpl);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe(
      "Invalid Reference Id — Vendor assigned to this transaction has been deleted.",
    );
    expect(harness.jobs).toEqual([]);
    expect(harness.invoicePatches).toEqual([]);
    expect(harness.intuitUrls.some((line) => line.includes("/bill"))).toBe(false);
  });

  it("does not queue Desktop when Online token refresh is not configured", async () => {
    const harness = sendFetch({
      invoice: invoiceRow({ id: "inv-semilla", restaurant_id: "rest-semilla" }),
      online: [{ ...semillaOnline, access_token: null, access_token_expires_at: null }],
      desktop: [{ ...kaneDesktop, id: "conn-shared", restaurant_id: null }],
    });
    const response = await handleSendInvoice(supabaseEnv, manager, "inv-semilla", harness.fetchImpl);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("INTUIT_CLIENT_ID");
    expect(harness.jobs).toEqual([]);
    expect(harness.intuitUrls).toEqual([]);
  });
});
