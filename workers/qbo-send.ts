import { resolveQbAccountRef, type QbAccountRow } from "../src/lib/qb-account-match";
import { restUrl, supabaseHeaders, type QbwcRestEnv } from "./qbwc-auth";
import { publicAppUrl } from "./qbwc-qwc";
import {
  accountMissingMessage,
  buildQboBillBody,
  findQboBillByDocNumber,
  findSyncedVendorId,
  intuitNotConfiguredMessage,
  isPersistedQboBillId,
  missingIntuitSecrets,
  newQboSendClaim,
  parseQboSendClaim,
  postQboBill,
  qboApiBase,
  qboRedirectUri,
  queryQboByName,
  requestIntuitToken,
  vendorMissingMessage,
  type QboEnv,
} from "./qbo-api";

const SEND_CLAIM_TTL_MS = 120_000;

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
  if (isPersistedQboBillId(invoice.quickbooksTxnId)) {
    return json(completedJob(invoice, loaded.id, invoice.quickbooksTxnId as string));
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
  let apAccountId: string | null = null;
  if (invoice.apAccount.trim()) {
    const ap = await resolveAccountId(fetchImpl, {
      apiBase,
      realmId: loaded.realm_id,
      accessToken: access.accessToken,
      stored: invoice.apAccount,
      accounts,
    });
    if ("error" in ap) return json({ error: ap.error }, ap.status);
    apAccountId = ap.id;
  }

  const existing = await findExistingBill(fetchImpl, {
    apiBase,
    realmId: loaded.realm_id,
    accessToken: access.accessToken,
    docNumber: invoice.invoiceNumber,
    vendorId: vendorId.id,
  });
  if (existing && "error" in existing) return json({ error: existing.error }, 400);
  if (existing) {
    const saved = await saveBillId(env, orgId, invoice.id, existing.id, existing.syncToken, fetchImpl);
    if (!saved) {
      return json({ error: "QuickBooks Online already has this bill, but Berrify could not store the Bill id" }, 502);
    }
    return json(completedJob(invoice, loaded.id, existing.id));
  }

  const claim = await claimInvoiceSend(env, orgId, invoice.id, invoice.quickbooksTxnId, fetchImpl);
  if (claim === "unavailable") return json({ error: "Could not lock this invoice for QuickBooks Online" }, 503);
  if (claim.kind === "posted") return json(completedJob(invoice, loaded.id, claim.billId));
  if (claim.kind === "busy") {
    return json({ error: "This invoice is already being sent to QuickBooks Online" }, 409);
  }

  const body = buildQboBillBody({
    vendorId: vendorId.id,
    txnDate: invoice.invoiceDate,
    dueDate: invoice.dueDate ?? invoice.invoiceDate,
    docNumber: invoice.invoiceNumber,
    apAccountId,
    lines,
  });
  const posted = await postQboBill(fetchImpl, {
    apiBase,
    realmId: loaded.realm_id,
    accessToken: access.accessToken,
    body,
  });
  if ("error" in posted) {
    await releaseInvoiceSend(env, orgId, invoice.id, claim.token, fetchImpl);
    return json({ error: posted.error }, 400);
  }
  const saved = await saveBillId(env, orgId, invoice.id, posted.id, posted.syncToken, fetchImpl);
  if (!saved) {
    const recovered = await findExistingBill(fetchImpl, {
      apiBase,
      realmId: loaded.realm_id,
      accessToken: access.accessToken,
      docNumber: invoice.invoiceNumber,
      vendorId: vendorId.id,
    });
    if (recovered && !("error" in recovered)) {
      const retried = await saveBillId(env, orgId, invoice.id, recovered.id, recovered.syncToken, fetchImpl);
      if (retried) return json(completedJob(invoice, loaded.id, recovered.id));
    }
    return json(
      {
        error: `QuickBooks Online created the bill (${posted.id}), but Berrify could not store the Bill id. Do not Send again until that id is saved.`,
      },
      502,
    );
  }
  return json(completedJob(invoice, loaded.id, posted.id));
}

async function findExistingBill(
  fetchImpl: typeof fetch,
  input: { apiBase: string; realmId: string; accessToken: string; docNumber: string | null; vendorId: string },
) {
  return findQboBillByDocNumber(fetchImpl, {
    apiBase: input.apiBase,
    realmId: input.realmId,
    accessToken: input.accessToken,
    docNumber: input.docNumber ?? "",
    vendorId: input.vendorId,
  });
}

async function claimInvoiceSend(
  env: QboSendEnv,
  orgId: string,
  invoiceId: string,
  currentTxnId: string | null,
  fetchImpl: typeof fetch,
): Promise<{ kind: "claimed"; token: string } | { kind: "posted"; billId: string } | { kind: "busy" } | "unavailable"> {
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRole) return "unavailable";
  const headers = { ...supabaseHeaders(serviceRole), Prefer: "return=representation", Accept: "application/json" };
  const stale = parseQboSendClaim(currentTxnId);
  const canTakeOver = Boolean(stale && Date.now() - stale.createdAt > SEND_CLAIM_TTL_MS);
  const filter = canTakeOver
    ? `invoices?id=eq.${encodeURIComponent(invoiceId)}&org_id=eq.${encodeURIComponent(orgId)}&quickbooks_txn_id=eq.${encodeURIComponent(currentTxnId ?? "")}`
    : `invoices?id=eq.${encodeURIComponent(invoiceId)}&org_id=eq.${encodeURIComponent(orgId)}&quickbooks_txn_id=is.null`;
  const token = newQboSendClaim();
  const claimed = await fetchImpl(restUrl(supabaseUrl, filter), {
    method: "PATCH",
    headers,
    body: JSON.stringify({ quickbooks_txn_id: token }),
  });
  if (claimed.ok) {
    const rows = (await claimed.json()) as Array<{ quickbooks_txn_id?: string | null }>;
    if (rows[0]?.quickbooks_txn_id === token) return { kind: "claimed", token };
  }
  const latest = await loadInvoiceTxnId(env, orgId, invoiceId, fetchImpl);
  if (latest === "unavailable") return "unavailable";
  if (isPersistedQboBillId(latest)) return { kind: "posted", billId: latest as string };
  return { kind: "busy" };
}

async function releaseInvoiceSend(
  env: QboSendEnv,
  orgId: string,
  invoiceId: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRole) return;
  await fetchImpl(
    restUrl(
      supabaseUrl,
      `invoices?id=eq.${encodeURIComponent(invoiceId)}&org_id=eq.${encodeURIComponent(orgId)}&quickbooks_txn_id=eq.${encodeURIComponent(token)}`,
    ),
    {
      method: "PATCH",
      headers: { ...supabaseHeaders(serviceRole), Prefer: "return=minimal" },
      body: JSON.stringify({ quickbooks_txn_id: null }),
    },
  );
}

async function loadInvoiceTxnId(
  env: QboSendEnv,
  orgId: string,
  invoiceId: string,
  fetchImpl: typeof fetch,
): Promise<string | null | "unavailable"> {
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRole) return "unavailable";
  const response = await fetchImpl(
    restUrl(
      supabaseUrl,
      `invoices?id=eq.${encodeURIComponent(invoiceId)}&org_id=eq.${encodeURIComponent(orgId)}&select=quickbooks_txn_id&limit=1`,
    ),
    { headers: { ...supabaseHeaders(serviceRole), Accept: "application/json" } },
  );
  if (!response.ok) return "unavailable";
  const rows = (await response.json()) as Array<{ quickbooks_txn_id?: string | null }>;
  return rows[0]?.quickbooks_txn_id ?? null;
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
