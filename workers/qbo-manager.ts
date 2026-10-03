import { restUrl, supabaseHeaders } from "./qbwc-auth";
import { publicAppUrl } from "./qbwc-qwc";
import { requireManager, type QbwcManagerEnv } from "./qbwc-manager";
import {
  buildAuthorizeUrl,
  fetchCompanyName,
  intuitNotConfiguredMessage,
  missingIntuitSecrets,
  qboApiBase,
  qboRedirectUri,
  requestIntuitToken,
  revokeIntuitToken,
} from "./qbo-api";
import {
  ensureOnlineAccessToken,
  patchConnection,
  type QboConnectionRow,
  type QboSendEnv,
} from "./qbo-send";
import { syncOnlineAccounts, syncOnlineVendors } from "./qbo-sync";

const STATE_TTL_MS = 10 * 60 * 1000;
const CONNECTION_SELECT =
  "id,org_id,restaurant_id,realm_id,refresh_token,access_token,access_token_expires_at,company_name,is_active,last_synced_at,last_error";

export type QboRoute =
  | { kind: "config" }
  | { kind: "connect" }
  | { kind: "callback" }
  | { kind: "refresh-vendors"; id: string }
  | { kind: "refresh-accounts"; id: string }
  | { kind: "disconnect"; id: string };

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}

export function parseQboPath(pathname: string): QboRoute | null {
  if (pathname === "/api/qbo/config") return { kind: "config" };
  if (pathname === "/api/qbo/connect") return { kind: "connect" };
  if (pathname === "/api/qbo/callback") return { kind: "callback" };
  const vendors = /^\/api\/qbo\/connections\/([^/]+)\/vendors$/.exec(pathname);
  if (vendors?.[1]) return { kind: "refresh-vendors", id: vendors[1] };
  const accounts = /^\/api\/qbo\/connections\/([^/]+)\/accounts$/.exec(pathname);
  if (accounts?.[1]) return { kind: "refresh-accounts", id: accounts[1] };
  const disconnect = /^\/api\/qbo\/connections\/([^/]+)\/disconnect$/.exec(pathname);
  if (disconnect?.[1]) return { kind: "disconnect", id: disconnect[1] };
  return null;
}

function booksUrl(env: QboSendEnv, query: Record<string, string>): string {
  const url = new URL(`${publicAppUrl(env.PUBLIC_APP_URL)}/quickbooks`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
}

function safeNotice(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 180);
}

async function deleteExpiredOauthStates(env: QboSendEnv, fetchImpl: typeof fetch): Promise<void> {
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRole) return;
  await fetchImpl(
    restUrl(
      supabaseUrl,
      `quickbooks_online_oauth_states?expires_at=lt.${encodeURIComponent(new Date().toISOString())}`,
    ),
    { method: "DELETE", headers: supabaseHeaders(serviceRole) },
  );
}

export async function handleQbo(
  request: Request,
  env: QbwcManagerEnv,
  pathname: string,
  fetchImpl: typeof fetch,
): Promise<Response | null> {
  const route = parseQboPath(pathname);
  if (!route) return null;
  switch (route.kind) {
    case "callback":
      if (request.method !== "GET") {
        return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET" } });
      }
      return handleCallback(request, env, fetchImpl);
    case "config":
      if (request.method !== "GET") {
        return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET" } });
      }
      return handleConfig(request, env, fetchImpl);
    case "connect":
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
      }
      return handleConnect(request, env, fetchImpl);
    case "refresh-vendors":
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
      }
      return handleRefresh(request, env, route.id, "vendors", fetchImpl);
    case "refresh-accounts":
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
      }
      return handleRefresh(request, env, route.id, "accounts", fetchImpl);
    case "disconnect":
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
      }
      return handleDisconnect(request, env, route.id, fetchImpl);
    default: {
      const exhaustive: never = route;
      return exhaustive;
    }
  }
}

function handleConfig(request: Request, env: QboSendEnv, fetchImpl: typeof fetch): Promise<Response> {
  return requireManager(request, env, fetchImpl).then((manager) => {
    if (manager instanceof Response) return manager;
    const redirectUri = qboRedirectUri(publicAppUrl(env.PUBLIC_APP_URL));
    const missing = missingIntuitSecrets(env);
    return json({ configured: missing.length === 0, redirect_uri: redirectUri, missing });
  });
}

async function handleConnect(
  request: Request,
  env: QboSendEnv,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const manager = await requireManager(request, env, fetchImpl);
  if (manager instanceof Response) return manager;
  const redirectUri = qboRedirectUri(publicAppUrl(env.PUBLIC_APP_URL));
  const missing = missingIntuitSecrets(env);
  if (missing.length > 0) return json({ error: intuitNotConfiguredMessage(redirectUri) }, 503);

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const restaurantId = (body as { restaurant_id?: unknown } | null)?.restaurant_id;
  if (typeof restaurantId !== "string" || !restaurantId.trim()) {
    return json({ error: "Choose a restaurant to connect QuickBooks Online" }, 400);
  }
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRole) return json({ error: "Not configured" }, 503);
  const restaurantRes = await fetchImpl(
    restUrl(
      supabaseUrl,
      `restaurants?id=eq.${encodeURIComponent(restaurantId.trim())}&org_id=eq.${encodeURIComponent(manager.orgId)}&select=id&limit=1`,
    ),
    { headers: { ...supabaseHeaders(serviceRole), Accept: "application/json" } },
  );
  if (!restaurantRes.ok) return json({ error: "Restaurant not found" }, 404);
  const restaurants = (await restaurantRes.json()) as Array<{ id: string }>;
  if (!restaurants[0]) return json({ error: "Restaurant not found" }, 404);

  const state = crypto.randomUUID();
  const inserted = await fetchImpl(restUrl(supabaseUrl, "quickbooks_online_oauth_states"), {
    method: "POST",
    headers: { ...supabaseHeaders(serviceRole), Prefer: "return=minimal" },
    body: JSON.stringify({
      state,
      org_id: manager.orgId,
      restaurant_id: restaurantId.trim(),
      created_by: manager.userId,
      expires_at: new Date(Date.now() + STATE_TTL_MS).toISOString(),
    }),
  });
  if (!inserted.ok) return json({ error: "Could not start QuickBooks Online" }, 400);
  await deleteExpiredOauthStates(env, fetchImpl);
  const clientId = env.INTUIT_CLIENT_ID?.trim() ?? "";
  return json({
    url: buildAuthorizeUrl({ clientId, redirectUri, state }),
  });
}

async function handleCallback(request: Request, env: QboSendEnv, fetchImpl: typeof fetch): Promise<Response> {
  const url = new URL(request.url);
  const oauthError = url.searchParams.get("error");
  if (oauthError === "access_denied") return redirect(booksUrl(env, { qbo: "denied" }));
  if (oauthError) {
    return redirect(booksUrl(env, { qbo: "error", message: safeNotice(oauthError) }));
  }
  const code = url.searchParams.get("code")?.trim() ?? "";
  const state = url.searchParams.get("state")?.trim() ?? "";
  const realmId = url.searchParams.get("realmId")?.trim() ?? "";
  if (!code || !state || !realmId) {
    return redirect(booksUrl(env, { qbo: "error", message: "QuickBooks Online did not return a company" }));
  }
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRole) {
    return redirect(booksUrl(env, { qbo: "error", message: "QuickBooks Online is not configured" }));
  }
  const redirectUri = qboRedirectUri(publicAppUrl(env.PUBLIC_APP_URL));
  if (missingIntuitSecrets(env).length > 0) {
    return redirect(booksUrl(env, { qbo: "error", message: safeNotice(intuitNotConfiguredMessage(redirectUri)) }));
  }

  const stateRes = await fetchImpl(
    restUrl(
      supabaseUrl,
      `quickbooks_online_oauth_states?state=eq.${encodeURIComponent(state)}&select=state,org_id,restaurant_id,expires_at&limit=1`,
    ),
    { headers: { ...supabaseHeaders(serviceRole), Accept: "application/json" } },
  );
  const stateRows = stateRes.ok ? ((await stateRes.json()) as Array<{ org_id: string; restaurant_id: string; expires_at: string }>) : [];
  await fetchImpl(restUrl(supabaseUrl, `quickbooks_online_oauth_states?state=eq.${encodeURIComponent(state)}`), {
    method: "DELETE",
    headers: supabaseHeaders(serviceRole),
  });
  await deleteExpiredOauthStates(env, fetchImpl);
  const pending = stateRows[0];
  if (!pending || Date.parse(pending.expires_at) < Date.now()) {
    return redirect(booksUrl(env, { qbo: "error", message: "QuickBooks Online connect expired. Try again." }));
  }

  const clientId = env.INTUIT_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.INTUIT_CLIENT_SECRET?.trim() ?? "";
  const tokens = await requestIntuitToken(fetchImpl, {
    clientId,
    clientSecret,
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });
  if ("error" in tokens) {
    return redirect(booksUrl(env, { qbo: "error", message: safeNotice(tokens.error) }));
  }

  const apiBase = qboApiBase(env.INTUIT_ENVIRONMENT);
  const companyName = await fetchCompanyName(fetchImpl, {
    apiBase,
    realmId,
    accessToken: tokens.accessToken,
  });
  const saved = await saveConnection(env, {
    orgId: pending.org_id,
    restaurantId: pending.restaurant_id,
    realmId,
    refreshToken: tokens.refreshToken,
    accessToken: tokens.accessToken,
    expiresIn: tokens.expiresIn,
    companyName,
  }, fetchImpl);
  if ("error" in saved) {
    return redirect(booksUrl(env, { qbo: "error", message: safeNotice(saved.error) }));
  }

  const synced = await syncCompany(env, saved.connection, tokens.accessToken, fetchImpl);
  if ("error" in synced) {
    await patchConnection(env, saved.connection.id, { last_error: synced.error }, fetchImpl);
    return redirect(booksUrl(env, { qbo: "connected", message: safeNotice(synced.error) }));
  }
  await patchConnection(
    env,
    saved.connection.id,
    { last_synced_at: new Date().toISOString(), last_error: null, company_name: companyName },
    fetchImpl,
  );
  return redirect(booksUrl(env, { qbo: "connected" }));
}

async function saveConnection(
  env: QboSendEnv,
  input: {
    orgId: string;
    restaurantId: string;
    realmId: string;
    refreshToken: string;
    accessToken: string;
    expiresIn: number;
    companyName: string | null;
  },
  fetchImpl: typeof fetch,
): Promise<{ connection: QboConnectionRow } | { error: string }> {
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRole) return { error: "Not configured" };
  const headers = { ...supabaseHeaders(serviceRole), Accept: "application/json" };
  const byRestaurant = await fetchImpl(
    restUrl(
      supabaseUrl,
      `quickbooks_online_connections?org_id=eq.${encodeURIComponent(input.orgId)}&restaurant_id=eq.${encodeURIComponent(input.restaurantId)}&select=${CONNECTION_SELECT}&limit=1`,
    ),
    { headers },
  );
  if (!byRestaurant.ok) return { error: "Could not save QuickBooks Online" };
  const restaurantRows = (await byRestaurant.json()) as QboConnectionRow[];
  const byRealm = await fetchImpl(
    restUrl(
      supabaseUrl,
      `quickbooks_online_connections?org_id=eq.${encodeURIComponent(input.orgId)}&realm_id=eq.${encodeURIComponent(input.realmId)}&select=id,restaurant_id&limit=1`,
    ),
    { headers },
  );
  if (!byRealm.ok) return { error: "Could not save QuickBooks Online" };
  const realmRows = (await byRealm.json()) as Array<{ id: string; restaurant_id: string }>;
  const realmOwner = realmRows[0];
  if (realmOwner && realmOwner.restaurant_id !== input.restaurantId) {
    return { error: "That QuickBooks Online company is already connected to another restaurant." };
  }
  const fields = {
    realm_id: input.realmId,
    refresh_token: input.refreshToken,
    access_token: input.accessToken,
    access_token_expires_at: new Date(Date.now() + input.expiresIn * 1000).toISOString(),
    company_name: input.companyName,
    is_active: true,
    last_error: null,
  };
  const existing = restaurantRows[0];
  if (existing) {
    const patched = await fetchImpl(
      restUrl(supabaseUrl, `quickbooks_online_connections?id=eq.${encodeURIComponent(existing.id)}`),
      {
        method: "PATCH",
        headers: { ...supabaseHeaders(serviceRole), Prefer: "return=representation" },
        body: JSON.stringify(fields),
      },
    );
    if (!patched.ok) return { error: "Could not save QuickBooks Online" };
    const rows = (await patched.json()) as QboConnectionRow[];
    const connection = rows[0];
    if (!connection) return { error: "Could not save QuickBooks Online" };
    return { connection };
  }
  const inserted = await fetchImpl(restUrl(supabaseUrl, "quickbooks_online_connections"), {
    method: "POST",
    headers: { ...supabaseHeaders(serviceRole), Prefer: "return=representation" },
    body: JSON.stringify({
      org_id: input.orgId,
      restaurant_id: input.restaurantId,
      ...fields,
    }),
  });
  if (!inserted.ok) return { error: "Could not save QuickBooks Online" };
  const rows = (await inserted.json()) as QboConnectionRow[];
  const connection = rows[0];
  if (!connection) return { error: "Could not save QuickBooks Online" };
  return { connection };
}

async function syncCompany(
  env: QboSendEnv,
  connection: QboConnectionRow,
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<{ vendors: number; accounts: number } | { error: string }> {
  const apiBase = qboApiBase(env.INTUIT_ENVIRONMENT);
  const input = {
    orgId: connection.org_id,
    connectionId: connection.id,
    apiBase,
    realmId: connection.realm_id,
    accessToken,
  };
  const vendors = await syncOnlineVendors(env, input, fetchImpl);
  if ("error" in vendors) return vendors;
  const accounts = await syncOnlineAccounts(env, input, fetchImpl);
  if ("error" in accounts) return accounts;
  return { vendors: vendors.count, accounts: accounts.count };
}

async function loadOwnedConnection(
  env: QboSendEnv,
  orgId: string,
  connectionId: string,
  fetchImpl: typeof fetch,
): Promise<QboConnectionRow | null> {
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRole) return null;
  const response = await fetchImpl(
    restUrl(
      supabaseUrl,
      `quickbooks_online_connections?id=eq.${encodeURIComponent(connectionId)}&org_id=eq.${encodeURIComponent(orgId)}&select=${CONNECTION_SELECT}&limit=1`,
    ),
    { headers: { ...supabaseHeaders(serviceRole), Accept: "application/json" } },
  );
  if (!response.ok) return null;
  const rows = (await response.json()) as QboConnectionRow[];
  return rows[0] ?? null;
}

async function handleRefresh(
  request: Request,
  env: QboSendEnv,
  connectionId: string,
  kind: "vendors" | "accounts",
  fetchImpl: typeof fetch,
): Promise<Response> {
  const manager = await requireManager(request, env, fetchImpl);
  if (manager instanceof Response) return manager;
  const connection = await loadOwnedConnection(env, manager.orgId, connectionId, fetchImpl);
  if (!connection || !connection.is_active) return json({ error: "Not found" }, 404);
  const access = await ensureOnlineAccessToken(env, connection, fetchImpl);
  if ("error" in access) return json({ error: access.error }, access.status);
  const apiBase = qboApiBase(env.INTUIT_ENVIRONMENT);
  const input = {
    orgId: connection.org_id,
    connectionId: connection.id,
    apiBase,
    realmId: connection.realm_id,
    accessToken: access.accessToken,
  };
  const synced =
    kind === "vendors"
      ? await syncOnlineVendors(env, input, fetchImpl)
      : await syncOnlineAccounts(env, input, fetchImpl);
  if ("error" in synced) {
    await patchConnection(env, connection.id, { last_error: synced.error }, fetchImpl);
    return json({ error: synced.error }, 400);
  }
  await patchConnection(
    env,
    connection.id,
    { last_synced_at: new Date().toISOString(), last_error: null },
    fetchImpl,
  );
  return json({ count: synced.count, connection_id: connection.id });
}

async function handleDisconnect(
  request: Request,
  env: QboSendEnv,
  connectionId: string,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const manager = await requireManager(request, env, fetchImpl);
  if (manager instanceof Response) return manager;
  const connection = await loadOwnedConnection(env, manager.orgId, connectionId, fetchImpl);
  if (!connection) return json({ error: "Not found" }, 404);
  if (connection.refresh_token && missingIntuitSecrets(env).length === 0) {
    await revokeIntuitToken(fetchImpl, {
      clientId: env.INTUIT_CLIENT_ID?.trim() ?? "",
      clientSecret: env.INTUIT_CLIENT_SECRET?.trim() ?? "",
      token: connection.refresh_token,
    });
  }
  const cleared = await patchConnection(
    env,
    connection.id,
    {
      is_active: false,
      refresh_token: null,
      access_token: null,
      access_token_expires_at: null,
    },
    fetchImpl,
  );
  if (!cleared) return json({ error: "Could not disconnect QuickBooks Online" }, 400);
  return json({ ok: true });
}
