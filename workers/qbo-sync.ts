import { restUrl, supabaseHeaders, type QbwcRestEnv } from "./qbwc-auth";
import {
  fetchQboEntities,
  mapQueryAccounts,
  mapQueryVendors,
  type QboAccountRecord,
  type QboVendorRecord,
} from "./qbo-api";

type SyncEnv = QbwcRestEnv;

export async function syncOnlineVendors(
  env: SyncEnv,
  input: { orgId: string; connectionId: string; apiBase: string; realmId: string; accessToken: string },
  fetchImpl: typeof fetch,
): Promise<{ count: number } | { error: string }> {
  const listed = await fetchQboEntities(fetchImpl, {
    apiBase: input.apiBase,
    realmId: input.realmId,
    accessToken: input.accessToken,
    entity: "Vendor",
  });
  if ("error" in listed) return listed;
  const vendors = mapQueryVendors({ QueryResponse: { Vendor: listed.entities } });
  const saved = await replaceVendors(env, input.orgId, input.connectionId, vendors, fetchImpl);
  if (!saved) return { error: "Could not save QuickBooks Online vendors" };
  return { count: vendors.length };
}

export async function syncOnlineAccounts(
  env: SyncEnv,
  input: { orgId: string; connectionId: string; apiBase: string; realmId: string; accessToken: string },
  fetchImpl: typeof fetch,
): Promise<{ count: number } | { error: string }> {
  const listed = await fetchQboEntities(fetchImpl, {
    apiBase: input.apiBase,
    realmId: input.realmId,
    accessToken: input.accessToken,
    entity: "Account",
  });
  if ("error" in listed) return listed;
  const accounts = mapQueryAccounts({ QueryResponse: { Account: listed.entities } });
  const saved = await replaceAccounts(env, input.orgId, input.connectionId, accounts, fetchImpl);
  if (!saved) return { error: "Could not save QuickBooks Online accounts" };
  return { count: accounts.length };
}

async function replaceVendors(
  env: SyncEnv,
  orgId: string,
  connectionId: string,
  vendors: QboVendorRecord[],
  fetchImpl: typeof fetch,
): Promise<boolean> {
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRole) return false;
  const existingRes = await fetchImpl(
    restUrl(supabaseUrl, `quickbooks_online_vendors?connection_id=eq.${encodeURIComponent(connectionId)}&select=list_id`),
    { headers: { ...supabaseHeaders(serviceRole), Accept: "application/json" } },
  );
  if (!existingRes.ok) return false;
  const existing = (await existingRes.json()) as Array<{ list_id: string }>;
  if (vendors.length > 0) {
    const upsert = await fetchImpl(
      restUrl(supabaseUrl, "quickbooks_online_vendors?on_conflict=connection_id,list_id"),
      {
        method: "POST",
        headers: {
          ...supabaseHeaders(serviceRole),
          Prefer: "return=minimal,resolution=merge-duplicates",
        },
        body: JSON.stringify(
          vendors.map((row) => ({
            org_id: orgId,
            connection_id: connectionId,
            list_id: row.listId,
            full_name: row.fullName,
            company_name: row.companyName,
            is_active: row.isActive,
          })),
        ),
      },
    );
    if (!upsert.ok) return false;
  }
  const incoming = new Set(vendors.map((row) => row.listId));
  for (const row of existing) {
    if (incoming.has(row.list_id)) continue;
    const patch = await fetchImpl(
      restUrl(
        supabaseUrl,
        `quickbooks_online_vendors?connection_id=eq.${encodeURIComponent(connectionId)}&list_id=eq.${encodeURIComponent(row.list_id)}`,
      ),
      {
        method: "PATCH",
        headers: { ...supabaseHeaders(serviceRole), Prefer: "return=minimal" },
        body: JSON.stringify({ is_active: false }),
      },
    );
    if (!patch.ok) return false;
  }
  return true;
}

async function replaceAccounts(
  env: SyncEnv,
  orgId: string,
  connectionId: string,
  accounts: QboAccountRecord[],
  fetchImpl: typeof fetch,
): Promise<boolean> {
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRole) return false;
  const existingRes = await fetchImpl(
    restUrl(
      supabaseUrl,
      `quickbooks_online_accounts?connection_id=eq.${encodeURIComponent(connectionId)}&select=list_id`,
    ),
    { headers: { ...supabaseHeaders(serviceRole), Accept: "application/json" } },
  );
  if (!existingRes.ok) return false;
  const existing = (await existingRes.json()) as Array<{ list_id: string }>;
  if (accounts.length > 0) {
    const upsert = await fetchImpl(
      restUrl(supabaseUrl, "quickbooks_online_accounts?on_conflict=connection_id,list_id"),
      {
        method: "POST",
        headers: {
          ...supabaseHeaders(serviceRole),
          Prefer: "return=minimal,resolution=merge-duplicates",
        },
        body: JSON.stringify(
          accounts.map((row) => ({
            org_id: orgId,
            connection_id: connectionId,
            list_id: row.listId,
            full_name: row.fullName,
            account_number: row.accountNumber,
            account_type: row.accountType,
            is_active: row.isActive,
          })),
        ),
      },
    );
    if (!upsert.ok) return false;
  }
  const incoming = new Set(accounts.map((row) => row.listId));
  for (const row of existing) {
    if (incoming.has(row.list_id)) continue;
    const patch = await fetchImpl(
      restUrl(
        supabaseUrl,
        `quickbooks_online_accounts?connection_id=eq.${encodeURIComponent(connectionId)}&list_id=eq.${encodeURIComponent(row.list_id)}`,
      ),
      {
        method: "PATCH",
        headers: { ...supabaseHeaders(serviceRole), Prefer: "return=minimal" },
        body: JSON.stringify({ is_active: false }),
      },
    );
    if (!patch.ok) return false;
  }
  return true;
}
