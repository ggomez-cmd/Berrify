import dotenv from "dotenv";
import { createPgClient } from "./pg.ts";

dotenv.config();

if (!process.env.DIRECT_URL && !process.env.DATABASE_URL) {
  throw new Error("DIRECT_URL or DATABASE_URL is required to verify the schema.");
}

const requiredTables = [
  "organizations",
  "memberships",
  "suppliers",
  "inventory_items",
  "stock_movements",
  "employees",
  "staff_shifts",
  "invoices",
  "invoice_lines",
  "invoice_expense_lines",
  "vendor_aliases",
  "invoice_sku_aliases",
  "invoice_extract_examples",
  "account_rules",
  "restaurants",
  "restaurant_aliases",
  "clock_events",
  "clock_sessions",
  "time_entries",
  "time_breaks",
  "time_exceptions",
  "payroll_exports",
  "payroll_export_lines",
  "empty_bottle_events",
  "empty_bottle_lines",
  "empty_bottle_pending",
  "quickbooks_desktop_connections",
  "quickbooks_desktop_sessions",
  "quickbooks_sync_jobs",
  "quickbooks_vendors",
  "quickbooks_accounts",
  "quickbooks_online_connections",
  "quickbooks_online_oauth_states",
  "quickbooks_online_vendors",
  "quickbooks_online_accounts",
  "invoice_pages",
] as const;

const requiredPolicies: Record<(typeof requiredTables)[number], string[]> = {
  organizations: ["orgs_select_member", "orgs_update_manager"],
  memberships: ["memberships_select_own"],
  suppliers: ["suppliers_select_manager", "suppliers_write_manager"],
  inventory_items: ["inventory_items_select_manager", "inventory_items_write_manager"],
  stock_movements: ["stock_movements_select_manager", "stock_movements_insert_manager"],
  employees: ["employees_select_member", "employees_write_admin"],
  staff_shifts: ["staff_shifts_select_member", "staff_shifts_write_manager"],
  invoices: ["invoices_manager"],
  invoice_lines: ["invoice_lines_manager"],
  invoice_expense_lines: ["invoice_expenses_manager"],
  vendor_aliases: ["vendor_aliases_manager"],
  invoice_sku_aliases: ["invoice_sku_aliases_manager"],
  invoice_extract_examples: ["invoice_extract_examples_manager"],
  account_rules: ["account_rules_manager"],
  restaurants: ["restaurants_select_member", "restaurants_write_manager"],
  restaurant_aliases: ["restaurant_aliases_manager"],
  clock_events: ["clock_events_select_own", "clock_events_select_manager"],
  clock_sessions: ["clock_sessions_select_own", "clock_sessions_select_manager"],
  time_entries: ["time_entries_select_own", "time_entries_select_manager"],
  time_breaks: ["time_breaks_select_own", "time_breaks_select_manager"],
  time_exceptions: ["time_exceptions_select_own", "time_exceptions_select_manager"],
  payroll_exports: ["payroll_exports_manager"],
  payroll_export_lines: ["payroll_export_lines_manager"],
  empty_bottle_events: ["empty_bottle_events_select_manager", "empty_bottle_events_update_manager"],
  empty_bottle_lines: [
    "empty_bottle_lines_select_manager",
    "empty_bottle_lines_insert_pending",
    "empty_bottle_lines_update_pending",
    "empty_bottle_lines_delete_pending",
  ],
  empty_bottle_pending: [],
  quickbooks_desktop_connections: ["quickbooks_desktop_connections_select_manager"],
  quickbooks_desktop_sessions: [],
  quickbooks_sync_jobs: ["quickbooks_sync_jobs_select_manager"],
  quickbooks_vendors: ["quickbooks_vendors_manager"],
  quickbooks_accounts: ["quickbooks_accounts_manager"],
  quickbooks_online_connections: ["quickbooks_online_connections_select_manager"],
  quickbooks_online_oauth_states: [],
  quickbooks_online_vendors: ["quickbooks_online_vendors_manager"],
  quickbooks_online_accounts: ["quickbooks_online_accounts_manager"],
  invoice_pages: ["invoice_pages_manager"],
};

const client = createPgClient();

await client.connect();

try {
  const tables = await client.query<{ table_name: string }>(
    `select table_name
     from information_schema.tables
     where table_schema = 'public'
       and table_name = any($1::text[])`,
    [requiredTables],
  );

  const foundTables = new Set(tables.rows.map((row) => row.table_name));
  const missingTables = requiredTables.filter((name) => !foundTables.has(name));
  if (missingTables.length > 0) {
    throw new Error(`Missing tables: ${missingTables.join(", ")}`);
  }

  const rls = await client.query<{ relname: string; relrowsecurity: boolean }>(
    `select c.relname, c.relrowsecurity
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname = any($1::text[])`,
    [requiredTables],
  );

  const missingRls = rls.rows.filter((row) => !row.relrowsecurity).map((row) => row.relname);
  if (missingRls.length > 0) {
    throw new Error(`RLS disabled on: ${missingRls.join(", ")}`);
  }

  const policies = await client.query<{ tablename: string; policyname: string }>(
    `select tablename, policyname
     from pg_policies
     where schemaname = 'public'
       and tablename = any($1::text[])`,
    [requiredTables],
  );

  const foundPolicies = new Set(policies.rows.map((row) => `${row.tablename}:${row.policyname}`));
  const missingPolicies: string[] = [];
  for (const [table, names] of Object.entries(requiredPolicies)) {
    for (const name of names) {
      if (!foundPolicies.has(`${table}:${name}`)) {
        missingPolicies.push(`${table}.${name}`);
      }
    }
  }
  if (missingPolicies.length > 0) {
    throw new Error(`Missing policies: ${missingPolicies.join(", ")}`);
  }

  const fns = await client.query<{ proname: string }>(
    `select p.proname
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = any($1::text[])`,
    [[
      "is_org_member",
      "has_org_role",
      "handle_new_user",
      "apply_stock_movement",
      "set_updated_at",
      "record_clock_event",
      "manager_force_clock_out",
      "manager_record_punch",
      "list_whos_working",
      "list_employees_full",
      "list_inventory_full",
      "list_suppliers_full",
      "rotate_employee_invite",
      "set_employee_clock_pin",
      "sync_employee_login_role",
      "set_owner_kiosk_pin",
      "kiosk_unlock",
      "kiosk_record_clock_event",
      "kiosk_exit_required",
      "kiosk_confirm_exit",
      "reconcile_attendance",
      "resolve_time_exception",
      "update_org_clock_settings",
      "confirm_empty_bottle",
      "cancel_empty_bottle",
    ]],
  );
  const foundFns = new Set(fns.rows.map((row) => row.proname));
  for (const name of [
    "is_org_member",
    "has_org_role",
    "handle_new_user",
    "apply_stock_movement",
    "set_updated_at",
    "record_clock_event",
    "manager_force_clock_out",
    "manager_record_punch",
    "list_whos_working",
    "list_employees_full",
    "list_inventory_full",
    "list_suppliers_full",
    "rotate_employee_invite",
    "set_employee_clock_pin",
    "sync_employee_login_role",
    "set_owner_kiosk_pin",
    "kiosk_unlock",
    "kiosk_record_clock_event",
    "kiosk_exit_required",
    "kiosk_confirm_exit",
    "reconcile_attendance",
    "resolve_time_exception",
    "update_org_clock_settings",
    "confirm_empty_bottle",
    "cancel_empty_bottle",
  ]) {
    if (!foundFns.has(name)) {
      throw new Error(`Missing function: ${name}`);
    }
  }

  console.log("Schema verification passed.");
  console.log(`  tables: ${requiredTables.join(", ")}`);
  console.log(`  rls: enabled`);
  console.log(`  policies: ${foundPolicies.size}`);
} finally {
  await client.end();
}
