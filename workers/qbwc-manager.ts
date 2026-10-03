import { isSpaSameOrigin, sessionAccessToken } from "./ocr-post";
import {
  hashQbPassword,
  patchConnection,
  randomQbPassword,
  randomQbUsername,
  restUrl,
  revokeSessionsForConnection,
  supabaseHeaders,
  type QbwcConnectionRow,
  type QbwcRestEnv,
} from "./qbwc-auth";
import { enqueueAccountQueryJob, enqueueBillAddJob, enqueueVendorQueryJob } from "./qbwc-jobs";
import { buildQwcXml, publicAppUrl, qbwcAppSupportUrl, qbwcAppUrl } from "./qbwc-qwc";
import { buildBillAddRq } from "./qbxml";
import { resolveQbAccountRef, type QbAccountRow } from "../src/lib/qb-account-match";
import { trySendQboInvoice } from "./qbo-send";

export type QbwcManagerEnv = QbwcRestEnv & {
  PUBLIC_APP_URL?: string;
  INTUIT_CLIENT_ID?: string;
  INTUIT_CLIENT_SECRET?: string;
  INTUIT_ENVIRONMENT?: string;
};

type ManagerUser = {
  userId: string;
  orgId: string;
  role: string;
};

const MANAGER_ROLES = new Set(["admin", "owner", "manager"]);

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export async function requireManager(
  request: Request,
  env: QbwcManagerEnv,
  fetchImpl: typeof fetch,
): Promise<ManagerUser | Response> {
  if (!isSpaSameOrigin(request)) return json({ error: "Unauthorized" }, 401);
  const token = sessionAccessToken(request);
  if (!token) return json({ error: "Unauthorized" }, 401);
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
  const serviceRole = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRole) return json({ error: "Unauthorized" }, 401);

  const userRes = await fetchImpl(`${supabaseUrl}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: serviceRole },
  });
  if (!userRes.ok) return json({ error: "Unauthorized" }, 401);
  const user = (await userRes.json()) as { id?: string };
  if (!user.id) return json({ error: "Unauthorized" }, 401);

  const membershipsRes = await fetchImpl(
    restUrl(supabaseUrl, `memberships?user_id=eq.${encodeURIComponent(user.id)}&limit=1`),
    { headers: { ...supabaseHeaders(serviceRole), Accept: "application/json" } },
  );
  if (!membershipsRes.ok) return json({ error: "Forbidden" }, 403);
  const memberships = (await membershipsRes.json()) as Array<{ org_id: string; role: string }>;
  const membership = memberships[0];
  if (!membership || !MANAGER_ROLES.has(membership.role)) return json({ error: "Forbidden" }, 403);
  return { userId: user.id, orgId: membership.org_id, role: membership.role };
}

function publicConnection(row: QbwcConnectionRow): Omit<QbwcConnectionRow, "password_hash"> {
  return {
    id: row.id,
    org_id: row.org_id,
    restaurant_id: row.restaurant_id,
    name: row.name,
    qb_username: row.qb_username,
    owner_id: row.owner_id,
    file_id: row.file_id,
    company_file: row.company_file,
    qb_company_name: row.qb_company_name,
    qb_product_name: row.qb_product_name,
    qb_major_version: row.qb_major_version,
    qb_minor_version: row.qb_minor_version,
    is_active: row.is_active,
    last_connected_at: row.last_connected_at,
    last_successful_sync_at: row.last_successful_sync_at,
    last_error: row.last_error,
  };
}

async function loadOwnedConnection(
  env: QbwcManagerEnv,
  orgId: string,
  connectionId: string,
  fetchImpl: typeof fetch,
): Promise<QbwcConnectionRow | null> {
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRole) return null;
  const response = await fetchImpl(
    restUrl(
      supabaseUrl,
      `quickbooks_desktop_connections?id=eq.${encodeURIComponent(connectionId)}&org_id=eq.${encodeURIComponent(orgId)}&limit=1`,
    ),
    { headers: { ...supabaseHeaders(serviceRole), Accept: "application/json" } },
  );
  if (!response.ok) return null;
  const rows = (await response.json()) as QbwcConnectionRow[];
  return rows[0] ?? null;
}

async function restaurantInOrg(
  env: QbwcManagerEnv,
  orgId: string,
  restaurantId: string,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRole) return false;
  const response = await fetchImpl(
    restUrl(
      supabaseUrl,
      `restaurants?id=eq.${encodeURIComponent(restaurantId)}&org_id=eq.${encodeURIComponent(orgId)}&select=id&limit=1`,
    ),
    { headers: { ...supabaseHeaders(serviceRole), Accept: "application/json" } },
  );
  if (!response.ok) return false;
  const rows = (await response.json()) as Array<{ id: string }>;
  return Boolean(rows[0]);
}

function qwcForConnection(env: QbwcManagerEnv, connection: QbwcConnectionRow): string {
  const base = publicAppUrl(env.PUBLIC_APP_URL);
  return buildQwcXml({
    appUrl: qbwcAppUrl(base),
    appSupport: qbwcAppSupportUrl(base),
    userName: connection.qb_username,
    ownerId: connection.owner_id,
    fileId: connection.file_id,
    includeScheduler: Boolean(connection.last_successful_sync_at),
  });
}

export async function handleCreateConnection(
  request: Request,
  env: QbwcManagerEnv,
  manager: ManagerUser,
  fetchImpl: typeof fetch,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (!body || typeof body !== "object") return json({ error: "Invalid JSON" }, 400);
  const row = body as { restaurant_id?: unknown; name?: unknown; company_file?: unknown };
  const restaurantId =
    typeof row.restaurant_id === "string" && row.restaurant_id.trim() ? row.restaurant_id.trim() : null;
  if (restaurantId && !(await restaurantInOrg(env, manager.orgId, restaurantId, fetchImpl))) {
    return json({ error: "Restaurant not found" }, 400);
  }
  const name =
    typeof row.name === "string" && row.name.trim()
      ? row.name.trim()
      : restaurantId
        ? "Restaurant company file"
        : "Shared company file";
  const companyFile =
    typeof row.company_file === "string" && row.company_file.trim() ? row.company_file.trim() : null;
  const password = randomQbPassword();
  const passwordHash = await hashQbPassword(password);
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRole) return json({ error: "Not configured" }, 503);
  const insert = await fetchImpl(restUrl(supabaseUrl, "quickbooks_desktop_connections"), {
    method: "POST",
    headers: { ...supabaseHeaders(serviceRole), Prefer: "return=representation" },
    body: JSON.stringify({
      org_id: manager.orgId,
      restaurant_id: restaurantId,
      name,
      qb_username: randomQbUsername(),
      password_hash: passwordHash,
      company_file: companyFile,
      is_active: true,
    }),
  });
  if (!insert.ok) {
    return json({ error: "Could not create connection" }, insert.status === 409 ? 409 : 400);
  }
  const created = (await insert.json()) as QbwcConnectionRow[];
  const connection = created[0];
  if (!connection) return json({ error: "Could not create connection" }, 400);
  return json({ connection: publicConnection(connection), password }, 201);
}

export async function handleRotatePassword(
  env: QbwcManagerEnv,
  manager: ManagerUser,
  connectionId: string,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const connection = await loadOwnedConnection(env, manager.orgId, connectionId, fetchImpl);
  if (!connection) return json({ error: "Not found" }, 404);
  const password = randomQbPassword();
  const passwordHash = await hashQbPassword(password);
  const ok = await patchConnection(
    env,
    connection.id,
    { password_hash: passwordHash, is_active: true, last_error: null },
    fetchImpl,
  );
  if (!ok) return json({ error: "Could not rotate password" }, 400);
  await revokeSessionsForConnection(env, connection.id, fetchImpl);
  return json({ connection_id: connection.id, password });
}

export async function handleRevokeConnection(
  env: QbwcManagerEnv,
  manager: ManagerUser,
  connectionId: string,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const connection = await loadOwnedConnection(env, manager.orgId, connectionId, fetchImpl);
  if (!connection) return json({ error: "Not found" }, 404);
  const ok = await patchConnection(env, connection.id, { is_active: false }, fetchImpl);
  if (!ok) return json({ error: "Could not revoke connection" }, 400);
  await revokeSessionsForConnection(env, connection.id, fetchImpl);
  return json({ ok: true, connection_id: connection.id });
}

export async function handleDownloadQwc(
  env: QbwcManagerEnv,
  manager: ManagerUser,
  connectionId: string,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const connection = await loadOwnedConnection(env, manager.orgId, connectionId, fetchImpl);
  if (!connection || !connection.is_active) return json({ error: "Not found" }, 404);
  const xml = qwcForConnection(env, connection);
  return new Response(xml, {
    status: 200,
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Content-Disposition": 'attachment; filename="Berrify.qwc"',
      "Cache-Control": "no-store",
    },
  });
}

export function parseManagerPath(pathname: string):
  | { kind: "create" }
  | { kind: "rotate"; id: string }
  | { kind: "revoke"; id: string }
  | { kind: "qwc"; id: string }
  | { kind: "refresh-vendors"; id: string }
  | { kind: "refresh-accounts"; id: string }
  | { kind: "send-invoice"; id: string }
  | null {
  if (pathname === "/api/qbwc/connections") return { kind: "create" };
  const rotate = /^\/api\/qbwc\/connections\/([^/]+)\/rotate$/.exec(pathname);
  if (rotate) return { kind: "rotate", id: rotate[1] };
  const revoke = /^\/api\/qbwc\/connections\/([^/]+)\/revoke$/.exec(pathname);
  if (revoke) return { kind: "revoke", id: revoke[1] };
  const qwc = /^\/api\/qbwc\/connections\/([^/]+)\/qwc$/.exec(pathname);
  if (qwc) return { kind: "qwc", id: qwc[1] };
  const vendors = /^\/api\/qbwc\/connections\/([^/]+)\/vendors$/.exec(pathname);
  if (vendors) return { kind: "refresh-vendors", id: vendors[1] };
  const accounts = /^\/api\/qbwc\/connections\/([^/]+)\/accounts$/.exec(pathname);
  if (accounts) return { kind: "refresh-accounts", id: accounts[1] };
  const send = /^\/api\/qbwc\/invoices\/([^/]+)\/send$/.exec(pathname);
  if (send) return { kind: "send-invoice", id: send[1] };
  return null;
}

export function isQbwcConnected(
  connection: Pick<QbwcConnectionRow, "is_active" | "last_connected_at"> | null | undefined,
): boolean {
  return Boolean(connection?.is_active && connection.last_connected_at);
}

export async function resolveInvoiceConnection(
  env: QbwcManagerEnv,
  orgId: string,
  restaurantId: string,
  fetchImpl: typeof fetch,
): Promise<QbwcConnectionRow | null> {
  const scoped = await loadConnectionForRestaurant(env, orgId, restaurantId, fetchImpl);
  if (isQbwcConnected(scoped)) return scoped;
  const shared = await loadSharedConnection(env, orgId, fetchImpl);
  if (isQbwcConnected(shared)) return shared;
  return null;
}

async function loadConnectionForRestaurant(
  env: QbwcManagerEnv,
  orgId: string,
  restaurantId: string,
  fetchImpl: typeof fetch,
): Promise<QbwcConnectionRow | null> {
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRole) return null;
  const response = await fetchImpl(
    restUrl(
      supabaseUrl,
      `quickbooks_desktop_connections?org_id=eq.${encodeURIComponent(orgId)}&restaurant_id=eq.${encodeURIComponent(restaurantId)}&limit=1`,
    ),
    { headers: { ...supabaseHeaders(serviceRole), Accept: "application/json" } },
  );
  if (!response.ok) return null;
  const rows = (await response.json()) as QbwcConnectionRow[];
  return rows[0] ?? null;
}

async function loadSharedConnection(
  env: QbwcManagerEnv,
  orgId: string,
  fetchImpl: typeof fetch,
): Promise<QbwcConnectionRow | null> {
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRole) return null;
  const response = await fetchImpl(
    restUrl(
      supabaseUrl,
      `quickbooks_desktop_connections?org_id=eq.${encodeURIComponent(orgId)}&restaurant_id=is.null&limit=1`,
    ),
    { headers: { ...supabaseHeaders(serviceRole), Accept: "application/json" } },
  );
  if (!response.ok) return null;
  const rows = (await response.json()) as QbwcConnectionRow[];
  return rows[0] ?? null;
}

type InvoiceSendRow = {
  id: string;
  org_id: string;
  restaurant_id: string | null;
  supplier_id: string | null;
  vendor_name: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  terms: string;
  ap_account: string;
  status: string;
  total: number;
  quickbooks_txn_id?: string | null;
  suppliers: { name: string } | { name: string }[] | null;
  invoice_expense_lines: Array<{ account: string; amount: number; memo: string | null }>;
};

async function loadConnectionAccounts(
  env: QbwcManagerEnv,
  connectionId: string,
  fetchImpl: typeof fetch,
): Promise<QbAccountRow[]> {
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRole) return [];
  const response = await fetchImpl(
    restUrl(
      supabaseUrl,
      `quickbooks_accounts?connection_id=eq.${encodeURIComponent(connectionId)}&is_active=eq.true&select=connection_id,list_id,full_name,account_number,account_type,is_active`,
    ),
    { headers: { ...supabaseHeaders(serviceRole), Accept: "application/json" } },
  );
  if (!response.ok) return [];
  return (await response.json()) as QbAccountRow[];
}

function supplierName(row: InvoiceSendRow): string | null {
  const suppliers = row.suppliers;
  if (Array.isArray(suppliers)) return suppliers[0]?.name?.trim() || null;
  return suppliers?.name?.trim() || null;
}

export async function handleRefreshVendors(
  env: QbwcManagerEnv,
  manager: ManagerUser,
  connectionId: string,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const connection = await loadOwnedConnection(env, manager.orgId, connectionId, fetchImpl);
  if (!connection || !connection.is_active) return json({ error: "Not found" }, 404);
  if (!isQbwcConnected(connection)) {
    return json({ error: "Connect this company file first, then Refresh vendors and Update Selected." }, 409);
  }
  const queued = await enqueueVendorQueryJob(env, connection, fetchImpl, { refresh: true });
  if (queued === "error") return json({ error: "Could not queue vendor query" }, 400);
  return json({
    result: queued,
    operation: "vendor_query",
    connection_id: connection.id,
  });
}

export async function handleRefreshAccounts(
  env: QbwcManagerEnv,
  manager: ManagerUser,
  connectionId: string,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const connection = await loadOwnedConnection(env, manager.orgId, connectionId, fetchImpl);
  if (!connection || !connection.is_active) return json({ error: "Not found" }, 404);
  if (!isQbwcConnected(connection)) {
    return json({ error: "Connect this company file first, then Refresh accounts and Update Selected." }, 409);
  }
  const queued = await enqueueAccountQueryJob(env, connection, fetchImpl, { refresh: true });
  if (queued === "error") return json({ error: "Could not queue account query" }, 400);
  return json({
    result: queued,
    operation: "account_query",
    connection_id: connection.id,
  });
}

export async function handleSendInvoice(
  env: QbwcManagerEnv,
  manager: ManagerUser,
  invoiceId: string,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRole) return json({ error: "Not configured" }, 503);
  const invoiceRes = await fetchImpl(
    restUrl(
      supabaseUrl,
      `invoices?id=eq.${encodeURIComponent(invoiceId)}&org_id=eq.${encodeURIComponent(manager.orgId)}&select=id,org_id,restaurant_id,supplier_id,vendor_name,invoice_number,invoice_date,due_date,terms,ap_account,status,total,quickbooks_txn_id,suppliers(name),invoice_expense_lines(account,amount,memo)&limit=1`,
    ),
    { headers: { ...supabaseHeaders(serviceRole), Accept: "application/json" } },
  );
  if (!invoiceRes.ok) return json({ error: "Invoice not found" }, 404);
  const invoices = (await invoiceRes.json()) as InvoiceSendRow[];
  const invoice = invoices[0];
  if (!invoice) return json({ error: "Invoice not found" }, 404);
  if (invoice.status !== "reviewed" && invoice.status !== "exported") {
    return json({ error: "Invoice must be reviewed before sending to QuickBooks" }, 400);
  }
  if (!invoice.restaurant_id) {
    return json({ error: "Select a restaurant before sending to QuickBooks" }, 400);
  }
  const vendor = invoice.vendor_name?.trim() || supplierName(invoice) || "";
  if (!vendor) {
    return json({ error: "Enter a vendor name before sending to QuickBooks" }, 400);
  }
  const expenses = (invoice.invoice_expense_lines ?? []).filter(
    (line) => line.account?.trim() && Number.isFinite(Number(line.amount)) && Number(line.amount) !== 0,
  );
  if (expenses.length === 0) {
    return json({ error: "Add at least one expense line with an amount" }, 400);
  }
  const online = await trySendQboInvoice(
    env,
    manager.orgId,
    {
      id: invoice.id,
      restaurantId: invoice.restaurant_id,
      vendorName: vendor,
      invoiceNumber: invoice.invoice_number,
      invoiceDate: invoice.invoice_date,
      dueDate: invoice.due_date,
      apAccount: invoice.ap_account,
      quickbooksTxnId: invoice.quickbooks_txn_id ?? null,
      expenses: expenses.map((line) => ({
        account: line.account,
        amount: Number(line.amount),
        memo: line.memo ?? null,
      })),
    },
    fetchImpl,
  );
  if (online) return online;
  const connection = await resolveInvoiceConnection(env, manager.orgId, invoice.restaurant_id, fetchImpl);
  if (!connection) {
    return json(
      {
        error:
          "QuickBooks is not Connected for this restaurant. Connect this restaurant’s company file (or the org shared file). Semilla invoices are not sent to Kane.",
      },
      409,
    );
  }
  const accounts = await loadConnectionAccounts(env, connection.id, fetchImpl);
  const qbxmlRequest = buildBillAddRq({
    vendorName: vendor,
    refNumber: invoice.invoice_number,
    txnDate: invoice.invoice_date,
    dueDate: invoice.due_date ?? invoice.invoice_date,
    terms: invoice.terms,
    apAccount: resolveQbAccountRef(invoice.ap_account, accounts),
    expenses: expenses.map((line) => ({
      account: resolveQbAccountRef(line.account, accounts),
      amount: Number(line.amount),
      memo: line.memo ?? "",
    })),
    total: Number(invoice.total) || expenses.reduce((sum, line) => sum + Number(line.amount), 0),
  });
  const queued = await enqueueBillAddJob(
    env,
    {
      orgId: manager.orgId,
      connectionId: connection.id,
      invoiceId: invoice.id,
      qbxmlRequest,
    },
    fetchImpl,
  );
  if (queued.result === "error" || !queued.job) {
    return json({ error: "Could not queue QuickBooks bill" }, 400);
  }
  return json({
    job: {
      id: queued.job.id,
      status: queued.job.status,
      operation: queued.job.operation,
      entity_type: queued.job.entity_type,
      entity_id: queued.job.entity_id,
      connection_id: queued.job.connection_id,
      error_message: queued.job.error_message,
      quickbooks_txn_id: queued.job.quickbooks_txn_id,
    },
    result: queued.result,
  });
}

export async function handleQbwcManager(
  request: Request,
  env: QbwcManagerEnv,
  pathname: string,
  fetchImpl: typeof fetch,
): Promise<Response | null> {
  const route = parseManagerPath(pathname);
  if (!route) return null;
  const manager = await requireManager(request, env, fetchImpl);
  if (manager instanceof Response) return manager;
  switch (route.kind) {
    case "create":
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
      }
      return handleCreateConnection(request, env, manager, fetchImpl);
    case "rotate":
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
      }
      return handleRotatePassword(env, manager, route.id, fetchImpl);
    case "revoke":
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
      }
      return handleRevokeConnection(env, manager, route.id, fetchImpl);
    case "qwc":
      if (request.method !== "GET") {
        return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET" } });
      }
      return handleDownloadQwc(env, manager, route.id, fetchImpl);
    case "refresh-vendors":
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
      }
      return handleRefreshVendors(env, manager, route.id, fetchImpl);
    case "refresh-accounts":
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
      }
      return handleRefreshAccounts(env, manager, route.id, fetchImpl);
    case "send-invoice":
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
      }
      return handleSendInvoice(env, manager, route.id, fetchImpl);
    default: {
      const exhaustive: never = route;
      return exhaustive;
    }
  }
}
