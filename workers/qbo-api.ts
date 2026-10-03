import { foldVendorName } from "../src/lib/qb-vendor-match";
import {
  QBO_SEND_PENDING_PREFIX,
  isPersistedQboBillId,
  newQboSendClaim,
  parseQboSendClaim,
} from "../src/lib/qbo-bill-id";

export { QBO_SEND_PENDING_PREFIX, isPersistedQboBillId, newQboSendClaim, parseQboSendClaim };

export const QBO_ACCOUNTING_SCOPE = "com.intuit.quickbooks.accounting";
export const QBO_MINOR_VERSION = "75";
export const INTUIT_AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
export const INTUIT_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
export const INTUIT_REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
export const QBO_PRODUCTION_API = "https://quickbooks.api.intuit.com";
export const QBO_SANDBOX_API = "https://sandbox-quickbooks.api.intuit.com";

const QUERY_PAGE_SIZE = 1000;
const QUERY_PAGE_CAP = 20;

export type QboEnv = {
  INTUIT_CLIENT_ID?: string;
  INTUIT_CLIENT_SECRET?: string;
  INTUIT_ENVIRONMENT?: string;
  PUBLIC_APP_URL?: string;
};

export type QboTokenBundle = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
};

export type QboVendorRecord = {
  listId: string;
  fullName: string;
  companyName: string | null;
  isActive: boolean;
};

export type QboAccountRecord = {
  listId: string;
  fullName: string;
  accountNumber: string | null;
  accountType: string;
  isActive: boolean;
};

export type QboBillLine = {
  amount: number;
  accountId: string;
  description?: string;
};

export function qboApiBase(environment: string | undefined): string {
  return environment?.trim().toLowerCase() === "sandbox" ? QBO_SANDBOX_API : QBO_PRODUCTION_API;
}

export function qboRedirectUri(appUrl: string): string {
  return `${appUrl.replace(/\/$/, "")}/api/qbo/callback`;
}

export function missingIntuitSecrets(env: QboEnv): Array<"INTUIT_CLIENT_ID" | "INTUIT_CLIENT_SECRET"> {
  const missing: Array<"INTUIT_CLIENT_ID" | "INTUIT_CLIENT_SECRET"> = [];
  if (!env.INTUIT_CLIENT_ID?.trim()) missing.push("INTUIT_CLIENT_ID");
  if (!env.INTUIT_CLIENT_SECRET?.trim()) missing.push("INTUIT_CLIENT_SECRET");
  return missing;
}

export function intuitNotConfiguredMessage(redirectUri: string): string {
  return `QuickBooks Online is not configured. Set the Worker secrets INTUIT_CLIENT_ID and INTUIT_CLIENT_SECRET, then connect again. Redirect URL: ${redirectUri}`;
}

export function buildAuthorizeUrl(input: { clientId: string; redirectUri: string; state: string }): string {
  const url = new URL(INTUIT_AUTHORIZE_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", QBO_ACCOUNTING_SCOPE);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  return url.toString();
}

export function intuitQueryLiteral(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export function intuitFaultMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const fault = (payload as { Fault?: { Error?: Array<{ Message?: unknown; Detail?: unknown }> } }).Fault;
  const error = fault?.Error?.[0];
  if (error) {
    const parts = [error.Message, error.Detail].filter(
      (part): part is string => typeof part === "string" && part.trim().length > 0,
    );
    if (parts.length > 0) return parts.join(" — ");
  }
  const oauth = payload as { error_description?: unknown };
  if (typeof oauth.error_description === "string" && oauth.error_description.trim()) {
    return oauth.error_description.trim();
  }
  return null;
}

export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function qboDate(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;
  return trimmed.slice(0, 10);
}

export function buildQboBillBody(input: {
  vendorId: string;
  txnDate: string | null;
  dueDate: string | null;
  docNumber: string | null;
  apAccountId: string | null;
  lines: QboBillLine[];
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    VendorRef: { value: input.vendorId },
    Line: input.lines.map((line) => {
      const detail: Record<string, unknown> = {
        DetailType: "AccountBasedExpenseLineDetail",
        Amount: roundMoney(line.amount),
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: line.accountId },
        },
      };
      const description = line.description?.trim();
      if (description) detail.Description = description;
      return detail;
    }),
  };
  if (input.apAccountId) body.APAccountRef = { value: input.apAccountId };
  const txnDate = qboDate(input.txnDate);
  const dueDate = qboDate(input.dueDate);
  if (txnDate) body.TxnDate = txnDate;
  if (dueDate) body.DueDate = dueDate;
  const docNumber = input.docNumber?.trim();
  if (docNumber) body.DocNumber = docNumber.slice(0, 21);
  return body;
}

export function parseQboBill(payload: unknown): { id: string; syncToken: string | null } | null {
  if (!payload || typeof payload !== "object") return null;
  const bill = (payload as { Bill?: { Id?: unknown; SyncToken?: unknown } }).Bill;
  if (!bill || typeof bill !== "object") return null;
  return billRef(bill as Record<string, unknown>);
}

function billRef(bill: Record<string, unknown>): { id: string; syncToken: string | null } | null {
  const id = entityId(bill.Id);
  if (!id) return null;
  return { id, syncToken: typeof bill.SyncToken === "string" ? bill.SyncToken : null };
}

export function parseQboBillsFromQuery(
  payload: unknown,
): Array<{ id: string; syncToken: string | null; vendorId: string | null; docNumber: string | null }> {
  return queryResponseEntities(payload, "Bill").flatMap((row) => {
    const parsed = billRef(row);
    if (!parsed) return [];
    const vendor = row.VendorRef;
    const vendorId =
      vendor && typeof vendor === "object" ? entityId((vendor as { value?: unknown }).value) : entityId(vendor);
    const docNumber = typeof row.DocNumber === "string" ? row.DocNumber.trim() : null;
    return [{ ...parsed, vendorId, docNumber }];
  });
}

export function mapQueryVendors(payload: unknown): QboVendorRecord[] {
  return entityList(payload, "Vendor").flatMap((row) => {
    const listId = entityId(row.Id);
    const fullName = typeof row.DisplayName === "string" ? row.DisplayName.trim() : "";
    if (!listId || !fullName) return [];
    const companyName = typeof row.CompanyName === "string" ? row.CompanyName.trim() : "";
    return [
      {
        listId,
        fullName,
        companyName: companyName || null,
        isActive: row.Active !== false,
      },
    ];
  });
}

export function mapQueryAccounts(payload: unknown): QboAccountRecord[] {
  return entityList(payload, "Account").flatMap((row) => {
    const listId = entityId(row.Id);
    const qualified = typeof row.FullyQualifiedName === "string" ? row.FullyQualifiedName.trim() : "";
    const name = typeof row.Name === "string" ? row.Name.trim() : "";
    const fullName = qualified || name;
    if (!listId || !fullName) return [];
    const accountNumber = typeof row.AcctNum === "string" ? row.AcctNum.trim() : "";
    const accountType = typeof row.AccountType === "string" ? row.AccountType.trim() : "";
    return [
      {
        listId,
        fullName,
        accountNumber: accountNumber || null,
        accountType: accountType || "Expense",
        isActive: row.Active !== false,
      },
    ];
  });
}

export function findSyncedVendorId(
  name: string,
  vendors: Array<{ list_id: string; full_name: string; is_active: boolean }>,
): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const active = vendors.filter((row) => row.is_active);
  const exact = active.find((row) => row.full_name.trim() === trimmed);
  if (exact) return exact.list_id;
  const folded = foldVendorName(trimmed);
  const hit = active.find((row) => foldVendorName(row.full_name) === folded);
  return hit?.list_id ?? null;
}

export function vendorMissingMessage(name: string): string {
  return `QuickBooks Online returned no vendor named "${name.trim()}". Berrify does not create vendors.`;
}

export function accountMissingMessage(name: string): string {
  return `QuickBooks Online returned no account named "${name.trim()}". Berrify does not create accounts.`;
}

function entityId(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

export function queryResponseEntities(payload: unknown, key: string): Array<Record<string, unknown>> {
  if (!payload || typeof payload !== "object") return [];
  const rows = (payload as { QueryResponse?: Record<string, unknown> }).QueryResponse?.[key];
  if (Array.isArray(rows)) {
    return rows.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object");
  }
  if (rows && typeof rows === "object") return [rows as Record<string, unknown>];
  return [];
}

function entityList(payload: unknown, key: "Vendor" | "Account" | "Bill"): Array<Record<string, unknown>> {
  return queryResponseEntities(payload, key);
}

function basicAuth(clientId: string, clientSecret: string): string {
  return btoa(`${clientId}:${clientSecret}`);
}

async function readPayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function requestIntuitToken(
  fetchImpl: typeof fetch,
  input: { clientId: string; clientSecret: string; body: URLSearchParams },
): Promise<QboTokenBundle | { error: string }> {
  const response = await fetchImpl(INTUIT_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth(input.clientId, input.clientSecret)}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: input.body,
  });
  const payload = await readPayload(response);
  if (!response.ok) {
    return { error: intuitFaultMessage(payload) ?? "QuickBooks Online rejected the token request" };
  }
  if (!payload || typeof payload !== "object") {
    return { error: "QuickBooks Online rejected the token request" };
  }
  const row = payload as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
  if (typeof row.access_token !== "string" || typeof row.refresh_token !== "string") {
    return { error: "QuickBooks Online rejected the token request" };
  }
  const expiresIn = typeof row.expires_in === "number" && row.expires_in > 0 ? row.expires_in : 3600;
  return { accessToken: row.access_token, refreshToken: row.refresh_token, expiresIn };
}

export async function revokeIntuitToken(
  fetchImpl: typeof fetch,
  input: { clientId: string; clientSecret: string; token: string },
): Promise<{ ok: true } | { error: string }> {
  const response = await fetchImpl(INTUIT_REVOKE_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth(input.clientId, input.clientSecret)}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({ token: input.token }),
  });
  if (response.ok || response.status === 400) return { ok: true };
  const payload = await readPayload(response);
  return { error: intuitFaultMessage(payload) ?? "QuickBooks Online could not revoke the connection" };
}

function intuitHeaders(accessToken: string): HeadersInit {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };
}

export async function fetchQboEntities(
  fetchImpl: typeof fetch,
  input: {
    apiBase: string;
    realmId: string;
    accessToken: string;
    entity: "Vendor" | "Account";
  },
): Promise<{ entities: unknown[] } | { error: string }> {
  const entities: unknown[] = [];
  for (let page = 0; page < QUERY_PAGE_CAP; page += 1) {
    const start = page * QUERY_PAGE_SIZE + 1;
    const query = `select * from ${input.entity} startposition ${start} maxresults ${QUERY_PAGE_SIZE}`;
    const url = new URL(`${input.apiBase}/v3/company/${encodeURIComponent(input.realmId)}/query`);
    url.searchParams.set("query", query);
    url.searchParams.set("minorversion", QBO_MINOR_VERSION);
    const response = await fetchImpl(url.toString(), { headers: intuitHeaders(input.accessToken) });
    const payload = await readPayload(response);
    if (!response.ok) {
      return { error: intuitFaultMessage(payload) ?? "QuickBooks Online rejected the list request" };
    }
    const rows = entityList(payload, input.entity);
    entities.push(...rows);
    if (rows.length < QUERY_PAGE_SIZE) break;
  }
  return { entities };
}

export async function queryQboByName(
  fetchImpl: typeof fetch,
  input: {
    apiBase: string;
    realmId: string;
    accessToken: string;
    entity: "Vendor" | "Account";
    field: "DisplayName" | "Name" | "FullyQualifiedName";
    name: string;
  },
): Promise<{ rows: Array<Record<string, unknown>> } | { error: string }> {
  const query = `select * from ${input.entity} where ${input.field} = ${intuitQueryLiteral(input.name)}`;
  const url = new URL(`${input.apiBase}/v3/company/${encodeURIComponent(input.realmId)}/query`);
  url.searchParams.set("query", query);
  url.searchParams.set("minorversion", QBO_MINOR_VERSION);
  const response = await fetchImpl(url.toString(), { headers: intuitHeaders(input.accessToken) });
  const payload = await readPayload(response);
  if (!response.ok) {
    return { error: intuitFaultMessage(payload) ?? "QuickBooks Online rejected the lookup" };
  }
  return { rows: entityList(payload, input.entity) };
}

export async function fetchCompanyName(
  fetchImpl: typeof fetch,
  input: { apiBase: string; realmId: string; accessToken: string },
): Promise<string | null> {
  const url = new URL(
    `${input.apiBase}/v3/company/${encodeURIComponent(input.realmId)}/companyinfo/${encodeURIComponent(input.realmId)}`,
  );
  url.searchParams.set("minorversion", QBO_MINOR_VERSION);
  const response = await fetchImpl(url.toString(), { headers: intuitHeaders(input.accessToken) });
  if (!response.ok) return null;
  const payload = await readPayload(response);
  const name = (payload as { CompanyInfo?: { CompanyName?: unknown } } | null)?.CompanyInfo?.CompanyName;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

export async function postQboBill(
  fetchImpl: typeof fetch,
  input: { apiBase: string; realmId: string; accessToken: string; body: Record<string, unknown> },
): Promise<{ id: string; syncToken: string | null } | { error: string }> {
  const url = new URL(`${input.apiBase}/v3/company/${encodeURIComponent(input.realmId)}/bill`);
  url.searchParams.set("minorversion", QBO_MINOR_VERSION);
  const response = await fetchImpl(url.toString(), {
    method: "POST",
    headers: {
      ...intuitHeaders(input.accessToken),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input.body),
  });
  const payload = await readPayload(response);
  if (!response.ok) {
    return { error: intuitFaultMessage(payload) ?? "QuickBooks Online rejected the bill" };
  }
  const bill = parseQboBill(payload);
  if (!bill) return { error: intuitFaultMessage(payload) ?? "QuickBooks Online rejected the bill" };
  return bill;
}

export async function findQboBillByDocNumber(
  fetchImpl: typeof fetch,
  input: { apiBase: string; realmId: string; accessToken: string; docNumber: string; vendorId?: string },
): Promise<{ id: string; syncToken: string | null } | { error: string } | null> {
  const docNumber = input.docNumber.trim();
  if (!docNumber) return null;
  const query = `select * from Bill where DocNumber = ${intuitQueryLiteral(docNumber.slice(0, 21))}`;
  const url = new URL(`${input.apiBase}/v3/company/${encodeURIComponent(input.realmId)}/query`);
  url.searchParams.set("query", query);
  url.searchParams.set("minorversion", QBO_MINOR_VERSION);
  const response = await fetchImpl(url.toString(), { headers: intuitHeaders(input.accessToken) });
  const payload = await readPayload(response);
  if (!response.ok) {
    return { error: intuitFaultMessage(payload) ?? "QuickBooks Online rejected the bill lookup" };
  }
  const rows = parseQboBillsFromQuery(payload);
  const vendorId = input.vendorId?.trim();
  const match = vendorId ? rows.find((row) => row.vendorId === vendorId) : rows[0];
  return match ? { id: match.id, syncToken: match.syncToken } : null;
}
