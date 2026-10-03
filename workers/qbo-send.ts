import { resolveQbAccountRef, type QbAccountRow } from "../src/lib/qb-account-match";
import { restUrl, supabaseHeaders, type QbwcRestEnv } from "./qbwc-auth";
import { publicAppUrl } from "./qbwc-qwc";
import {
  accountMissingMessage,
  buildQboBillBody,
  findSyncedVendorId,
  intuitNotConfiguredMessage,
  missingIntuitSecrets,
  postQboBill,
  qboApiBase,
  qboRedirectUri,
  queryQboByName,
  requestIntuitToken,
  vendorMissingMessage,
  type QboEnv,
} from "./qbo-api";

export type QboSendEnv = QbwcRestEnv & QboEnv & { PUBLIC_APP_URL?: string };

export type QboInvoiceForSend = {
  id: string;
  restaurantId: string;
  vendorName: string;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  apAccount: string;
  quickbooksTxnId: string | null;
  expenses: Array<{ account: string; amount: number; memo: string | null }>;
};

export type QboConnectionRow = {
  id: string;
  org_id: string;
  restaurant_id: string;
  realm_id: string;
  refresh_token: string | null;
  access_token: string | null;
  access_token_expires_at: string | null;
  company_name: string | null;
  is_active: boolean;
  last_synced_at: string | null;
  last_error: string | null;
};

type StoredVendor = { list_id: string; full_name: string; is_active: boolean };

const CONNECTION_SELECT =
  "id,org_id,restaurant_id,realm_id,refresh_token,access_token,access_token_expires_at,company_name,is_active,last_synced_at,last_error";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function missingTable(response: Response, payload: unknown): boolean {
  if (response.status === 404) return true;
  if (!payload || typeof payload !== "object") return false;
  const code = (payload as { code?: unknown }).code;
  return code === "PGRST205" || code === "42P01";
}

export async function trySendQboInvoice(
  env: QboSendEnv,
  orgId: string,
  invoice: QboInvoiceForSend,
  fetchImpl: typeof fetch,
): Promise<Response | null> {
  const loaded = await loadActiveConnection(env, orgId, invoice.restaurantId, fetchImpl);
  if (loaded === "missing") return null;
  if (loaded === "unavailable") {
    return json({ error: "Could not check QuickBooks Online for this restaurant" }, 503);
  }
  if (invoice.quickbooksTxnId) {
    return json(completedJob(invoice, loaded.id, invoice.quickbooksTxnId));
  }
  const access = await ensureOnlineAccessToken(env, loaded, fetchImpl);
  if ("error" in access) return json({ error: access.error }, access.status);
  const apiBase = qboApiBase(env.INTUIT_ENVIRONMENT);
  const vendors = await loadVendors(env, loaded.id, fetchImpl);
  const accounts = await loadAccounts(env, loaded.id, fetchImpl);
  const vendorId = await resolveVendorId(fetchImpl, {
    apiBase,
    realmId: loaded.realm_id,
    accessToken: access.accessToken,
    name: invoice.vendorName,
    vendors,
  });
  if ("error" in vendorId) return json({ error: vendorId.error }, vendorId.status);

  const lines: Array<{ amount: number; accountId: string; description?: string }> = [];
  for (const expense of invoice.expenses) {
    const accountId = await resolveAccountId(fetchImpl, {
      apiBase,
      realmId: loaded.realm_id,
      accessToken: access.accessToken,
      stored: expense.account,
      accounts,
    });
    if ("error" in accountId) return json({ error: accountId.error }, accountId.status);
    lines.push({
      amount: Number(expense.amount),
      accountId: accountId.id,
      description: expense.memo ?? "",
    });
  }
  const ap = resolveQbAccountRef(invoice.apAccount, accounts);
  const body = buildQboBillBody({
    vendorId: vendorId.id,
    txnDate: invoice.invoiceDate,
    dueDate: invoice.dueDate ?? invoice.invoiceDate,
    docNumber: invoice.invoiceNumber,
    apAccountId: ap.listId,
    lines,
  });
  const posted = await postQboBill(fetchImpl, {
    apiBase,
    realmId: loaded.realm_id,
    accessToken: access.accessToken,
    body,
  });
  if ("error" in posted) return json({ error: posted.error }, 400);
  const saved = await saveBillId(env, orgId, invoice.id, posted.id, posted.syncToken, fetchImpl);
  if (!saved) return json({ error: "QuickBooks Online created the bill, but Berrify could not store the Bill id" }, 502);
  return json(completedJob(invoice, loaded.id, posted.id));
}

function completedJob(invoice: QboInvoiceForSend, connectionId: string, billId: string) {
  return {
    job: {
      id: `qbo-${billId}`,
      status: "completed",
      operation: "qbo_bill",
      entity_type: "invoice",
      entity_id: invoice.id,
      connection_id: connectionId,
      error_message: null,
      quickbooks_txn_id: billId,
    },
    result: "posted",
  };
}

async function loadActiveConnection(
  env: QboSendEnv,
  orgId: string,
  restaurantId: string,
  fetchImpl: typeof fetch,
): Promise<QboConnectionRow | "missing" | "unavailable"> {
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRole) return "unavailable";
  const response = await fetchImpl(
    restUrl(
      supabaseUrl,
      `quickbooks_online_connections?org_id=eq.${encodeURIComponent(orgId)}&restaurant_id=eq.${encodeURIComponent(restaurantId)}&is_active=eq.true&select=${CONNECTION_SELECT}&limit=1`,
    ),
    { headers: { ...supabaseHeaders(serviceRole), Accept: "application/json" } },
  );
  const payload = await readJson(response);
  if (!response.ok) return missingTable(response, payload) ? "missing" : "unavailable";
  const rows = Array.isArray(payload) ? (payload as QboConnectionRow[]) : [];
  return rows[0] ?? "missing";
}

export function accessTokenStillValid(expiresAt: string | null | undefined, now = Date.now()): boolean {
  if (!expiresAt) return false;
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(expires)) return false;
  return expires - now > 60_000;
}

export async function ensureOnlineAccessToken(
  env: QboSendEnv,
  connection: QboConnectionRow,
  fetchImpl: typeof fetch,
): Promise<{ accessToken: string } | { error: string; status: number }> {
  if (connection.access_token && accessTokenStillValid(connection.access_token_expires_at)) {
    return { accessToken: connection.access_token };
  }
  const redirectUri = qboRedirectUri(publicAppUrl(env.PUBLIC_APP_URL));
  if (missingIntuitSecrets(env).length > 0) {
    return { error: intuitNotConfiguredMessage(redirectUri), status: 503 };
  }
  if (!connection.refresh_token) {
    return { error: "Reconnect QuickBooks Online for this restaurant.", status: 409 };
  }
  const clientId = env.INTUIT_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.INTUIT_CLIENT_SECRET?.trim() ?? "";
  const refreshed = await requestIntuitToken(fetchImpl, {
    clientId,
    clientSecret,
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: connection.refresh_token,
    }),
  });
  if ("error" in refreshed) return { error: refreshed.error, status: 502 };
  const expiresAt = new Date(Date.now() + refreshed.expiresIn * 1000).toISOString();
  const patched = await patchConnection(
    env,
    connection.id,
    {
      access_token: refreshed.accessToken,
      refresh_token: refreshed.refreshToken,
      access_token_expires_at: expiresAt,
      last_error: null,
    },
    fetchImpl,
  );
  if (!patched) return { error: "Could not store the QuickBooks Online access token", status: 502 };
  return { accessToken: refreshed.accessToken };
}

export async function patchConnection(
  env: QboSendEnv,
  connectionId: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRole) return false;
  const response = await fetchImpl(
    restUrl(supabaseUrl, `quickbooks_online_connections?id=eq.${encodeURIComponent(connectionId)}`),
    {
      method: "PATCH",
      headers: { ...supabaseHeaders(serviceRole), Prefer: "return=minimal" },
      body: JSON.stringify(body),
    },
  );
  return response.ok;
}

async function loadVendors(env: QboSendEnv, connectionId: string, fetchImpl: typeof fetch): Promise<StoredVendor[]> {
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRole) return [];
  const response = await fetchImpl(
    restUrl(
      supabaseUrl,
      `quickbooks_online_vendors?connection_id=eq.${encodeURIComponent(connectionId)}&is_active=eq.true&select=list_id,full_name,is_active`,
    ),
    { headers: { ...supabaseHeaders(serviceRole), Accept: "application/json" } },
  );
  if (!response.ok) return [];
  const rows = (await response.json()) as StoredVendor[];
  return Array.isArray(rows) ? rows : [];
}

async function loadAccounts(env: QboSendEnv, connectionId: string, fetchImpl: typeof fetch): Promise<QbAccountRow[]> {
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRole) return [];
  const response = await fetchImpl(
    restUrl(
      supabaseUrl,
      `quickbooks_online_accounts?connection_id=eq.${encodeURIComponent(connectionId)}&is_active=eq.true&select=connection_id,list_id,full_name,account_number,account_type,is_active`,
    ),
    { headers: { ...supabaseHeaders(serviceRole), Accept: "application/json" } },
  );
  if (!response.ok) return [];
  const rows = (await response.json()) as QbAccountRow[];
  return Array.isArray(rows) ? rows : [];
}

async function resolveVendorId(
  fetchImpl: typeof fetch,
  input: {
    apiBase: string;
    realmId: string;
    accessToken: string;
    name: string;
    vendors: StoredVendor[];
  },
): Promise<{ id: string } | { error: string; status: number }> {
  const synced = findSyncedVendorId(input.name, input.vendors);
  if (synced) return { id: synced };
  const queried = await queryQboByName(fetchImpl, {
    apiBase: input.apiBase,
    realmId: input.realmId,
    accessToken: input.accessToken,
    entity: "Vendor",
    field: "DisplayName",
    name: input.name.trim(),
  });
  if ("error" in queried) return { error: queried.error, status: 400 };
  const row = queried.rows[0];
  const id = row ? entityId(row.Id) : null;
  if (!id) return { error: vendorMissingMessage(input.name), status: 400 };
  return { id };
}

async function resolveAccountId(
  fetchImpl: typeof fetch,
  input: {
    apiBase: string;
    realmId: string;
    accessToken: string;
    stored: string;
    accounts: QbAccountRow[];
  },
): Promise<{ id: string } | { error: string; status: number }> {
  const resolved = resolveQbAccountRef(input.stored, input.accounts);
  if (resolved.listId) return { id: resolved.listId };
  const name = resolved.fullName ?? input.stored.trim();
  const queried = await queryQboByName(fetchImpl, {
    apiBase: input.apiBase,
    realmId: input.realmId,
    accessToken: input.accessToken,
    entity: "Account",
    field: "FullyQualifiedName",
    name,
  });
  if ("error" in queried) return { error: queried.error, status: 400 };
  const row = queried.rows[0];
  const id = row ? entityId(row.Id) : null;
  if (!id) return { error: accountMissingMessage(name), status: 400 };
  return { id };
}

function entityId(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

async function saveBillId(
  env: QboSendEnv,
  orgId: string,
  invoiceId: string,
  billId: string,
  syncToken: string | null,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRole) return false;
  const response = await fetchImpl(
    restUrl(
      supabaseUrl,
      `invoices?id=eq.${encodeURIComponent(invoiceId)}&org_id=eq.${encodeURIComponent(orgId)}`,
    ),
    {
      method: "PATCH",
      headers: { ...supabaseHeaders(serviceRole), Prefer: "return=minimal" },
      body: JSON.stringify({
        quickbooks_txn_id: billId,
        quickbooks_edit_sequence: syncToken,
      }),
    },
  );
  return response.ok;
}
