import { supabase } from "./supabase";

export type QboConfig = {
  configured: boolean;
  redirect_uri: string;
  missing: string[];
};

async function defaultAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

async function authHeaders(getAccessToken: () => Promise<string | null>): Promise<Record<string, string>> {
  const token = await getAccessToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function readError(payload: unknown, status: number, fallback: string): string {
  if (payload && typeof payload === "object") {
    const message = (payload as { error?: unknown }).error;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return `${fallback} (${status})`;
}

async function readPayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function fetchQboConfig(
  fetchImpl: typeof fetch = fetch,
  getAccessToken: () => Promise<string | null> = defaultAccessToken,
): Promise<QboConfig> {
  const headers = await authHeaders(getAccessToken);
  const response = await fetchImpl("/api/qbo/config", { headers, credentials: "same-origin" });
  const payload = await readPayload(response);
  if (!response.ok) {
    throw new Error(readError(payload, response.status, "Could not check QuickBooks Online"));
  }
  const row = payload as Partial<QboConfig>;
  return {
    configured: Boolean(row.configured),
    redirect_uri: typeof row.redirect_uri === "string" ? row.redirect_uri : "",
    missing: Array.isArray(row.missing) ? row.missing.filter((item): item is string => typeof item === "string") : [],
  };
}

export async function startQboConnect(
  restaurantId: string,
  fetchImpl: typeof fetch = fetch,
  getAccessToken: () => Promise<string | null> = defaultAccessToken,
): Promise<{ url: string }> {
  const headers = await authHeaders(getAccessToken);
  const response = await fetchImpl("/api/qbo/connect", {
    method: "POST",
    headers,
    credentials: "same-origin",
    body: JSON.stringify({ restaurant_id: restaurantId }),
  });
  const payload = await readPayload(response);
  if (!response.ok) {
    throw new Error(readError(payload, response.status, "Could not connect QuickBooks Online"));
  }
  const url = (payload as { url?: unknown }).url;
  if (typeof url !== "string" || !url) throw new Error("Could not connect QuickBooks Online");
  return { url };
}

async function postQbo(path: string, fallback: string, fetchImpl: typeof fetch, getAccessToken: () => Promise<string | null>) {
  const headers = await authHeaders(getAccessToken);
  const response = await fetchImpl(path, { method: "POST", headers, credentials: "same-origin" });
  const payload = await readPayload(response);
  if (!response.ok) throw new Error(readError(payload, response.status, fallback));
}

export async function refreshQboVendors(
  connectionId: string,
  fetchImpl: typeof fetch = fetch,
  getAccessToken: () => Promise<string | null> = defaultAccessToken,
): Promise<void> {
  await postQbo(
    `/api/qbo/connections/${encodeURIComponent(connectionId)}/vendors`,
    "Could not refresh QuickBooks Online vendors",
    fetchImpl,
    getAccessToken,
  );
}

export async function refreshQboAccounts(
  connectionId: string,
  fetchImpl: typeof fetch = fetch,
  getAccessToken: () => Promise<string | null> = defaultAccessToken,
): Promise<void> {
  await postQbo(
    `/api/qbo/connections/${encodeURIComponent(connectionId)}/accounts`,
    "Could not refresh QuickBooks Online accounts",
    fetchImpl,
    getAccessToken,
  );
}

export async function disconnectQbo(
  connectionId: string,
  fetchImpl: typeof fetch = fetch,
  getAccessToken: () => Promise<string | null> = defaultAccessToken,
): Promise<void> {
  await postQbo(
    `/api/qbo/connections/${encodeURIComponent(connectionId)}/disconnect`,
    "Could not disconnect QuickBooks Online",
    fetchImpl,
    getAccessToken,
  );
}
