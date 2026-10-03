import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../auth/auth-context";
import { isManager } from "../../lib/schedule";
import { supabase } from "../../lib/supabase";
import { fetchQboConfig } from "../../lib/qbo-manager-api";
import type {
  QuickbooksAccount,
  QuickbooksDesktopConnection,
  QuickbooksOnlineConnection,
  QuickbooksSyncJob,
  QuickbooksVendor,
} from "../../lib/types";

const CONNECTION_SELECT =
  "id, org_id, restaurant_id, name, qb_username, owner_id, file_id, company_file, qb_company_name, qb_product_name, qb_major_version, qb_minor_version, is_active, last_connected_at, last_successful_sync_at, last_error, created_at, updated_at";

const ONLINE_CONNECTION_SELECT =
  "id, org_id, restaurant_id, realm_id, company_name, is_active, last_synced_at, last_error, created_at, updated_at";

function missingOnlineTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "PGRST205" || error.code === "42P01") return true;
  const message = error.message ?? "";
  return /quickbooks_online_/.test(message) && /schema cache|does not exist/i.test(message);
}

export function useQuickbooksConnections() {
  const { org, role } = useAuth();
  return useQuery({
    queryKey: ["quickbooks_desktop_connections", org?.id],
    enabled: Boolean(org?.id) && isManager(role),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("quickbooks_desktop_connections")
        .select(CONNECTION_SELECT)
        .eq("org_id", org!.id)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as QuickbooksDesktopConnection[];
    },
  });
}

export function useQuickbooksOnlineConnections() {
  const { org, role } = useAuth();
  return useQuery({
    queryKey: ["quickbooks_online_connections", org?.id],
    enabled: Boolean(org?.id) && isManager(role),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("quickbooks_online_connections")
        .select(ONLINE_CONNECTION_SELECT)
        .eq("org_id", org!.id)
        .order("created_at", { ascending: true });
      if (error) {
        if (missingOnlineTable(error)) return [];
        throw error;
      }
      return (data ?? []) as QuickbooksOnlineConnection[];
    },
  });
}

export function useQuickbooksOnlineConfig() {
  const { org, role } = useAuth();
  return useQuery({
    queryKey: ["qbo_config", org?.id],
    enabled: Boolean(org?.id) && isManager(role),
    queryFn: () => fetchQboConfig(),
  });
}

export function useQuickbooksVendors() {
  const { org, role } = useAuth();
  return useQuery({
    queryKey: ["quickbooks_vendors", org?.id],
    enabled: Boolean(org?.id) && isManager(role),
    queryFn: async () => {
      const desktop = await supabase
        .from("quickbooks_vendors")
        .select("id, org_id, connection_id, list_id, full_name, company_name, is_active, created_at, updated_at")
        .eq("org_id", org!.id)
        .order("full_name");
      if (desktop.error) throw desktop.error;
      const online = await supabase
        .from("quickbooks_online_vendors")
        .select("id, org_id, connection_id, list_id, full_name, company_name, is_active, created_at, updated_at")
        .eq("org_id", org!.id)
        .order("full_name");
      if (online.error && !missingOnlineTable(online.error)) throw online.error;
      const onlineRows = online.error ? [] : ((online.data ?? []) as QuickbooksVendor[]);
      return [...((desktop.data ?? []) as QuickbooksVendor[]), ...onlineRows];
    },
  });
}

export function useQuickbooksAccounts() {
  const { org, role } = useAuth();
  return useQuery({
    queryKey: ["quickbooks_accounts", org?.id],
    enabled: Boolean(org?.id) && isManager(role),
    queryFn: async () => {
      const desktop = await supabase
        .from("quickbooks_accounts")
        .select(
          "id, org_id, connection_id, list_id, full_name, account_number, account_type, is_active, created_at, updated_at",
        )
        .eq("org_id", org!.id)
        .order("full_name");
      if (desktop.error) throw desktop.error;
      const online = await supabase
        .from("quickbooks_online_accounts")
        .select(
          "id, org_id, connection_id, list_id, full_name, account_number, account_type, is_active, created_at, updated_at",
        )
        .eq("org_id", org!.id)
        .order("full_name");
      if (online.error && !missingOnlineTable(online.error)) throw online.error;
      const onlineRows = online.error ? [] : ((online.data ?? []) as QuickbooksAccount[]);
      return [...((desktop.data ?? []) as QuickbooksAccount[]), ...onlineRows];
    },
  });
}

export function useQuickbooksJobs() {
  const { org, role } = useAuth();
  return useQuery({
    queryKey: ["quickbooks_sync_jobs", org?.id],
    enabled: Boolean(org?.id) && isManager(role),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("quickbooks_sync_jobs")
        .select(
          "id, org_id, connection_id, status, operation, entity_type, entity_id, attempt_count, error_code, error_message, quickbooks_txn_id, created_at, updated_at",
        )
        .eq("org_id", org!.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as QuickbooksSyncJob[];
    },
  });
}
