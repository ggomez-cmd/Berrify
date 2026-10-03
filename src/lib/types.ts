import type {
  BreakType,
  ClockActorType,
  ClockEventType,
  ClockSessionState,
  ClockSource,
  TimeEntryStatus,
  TimeExceptionStatus,
  TimeExceptionType,
} from "./time-clock";

export type LoginRole = "manager" | "staff";

export type MembershipRole = "admin" | LoginRole;

export type MovementReason = "purchase" | "usage" | "adjustment" | "waste";

export type Organization = {
  id: string;
  name: string;
  created_at: string;
  timezone: string;
  workweek_start_dow: number;
  workweek_start_time: string;
  default_meal_break_paid: boolean;
  default_rest_break_paid: boolean;
};

export type Membership = {
  user_id: string;
  org_id: string;
  role: MembershipRole;
  created_at: string;
};

export type Supplier = {
  id: string;
  org_id: string;
  name: string;
  contact_email: string | null;
  phone: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type InventoryItem = {
  id: string;
  org_id: string;
  name: string;
  sku: string | null;
  category: string | null;
  unit: string;
  quantity: number;
  reorder_level: number;
  unit_cost?: number;
  supplier_id: string | null;
  created_at: string;
  updated_at: string;
};

export type StockMovement = {
  id: string;
  org_id: string;
  item_id: string;
  delta: number;
  reason: MovementReason;
  note: string | null;
  created_by: string | null;
  created_at: string;
};

export type EmptyBottleEventStatus = "pending" | "confirmed" | "cancelled";

export type EmptyBottleSource = "telegram" | "app";

export type EmptyBottleEvent = {
  id: string;
  org_id: string;
  telegram_message_id: string | null;
  chat_id: string | null;
  restaurant_id: string | null;
  proposed_item_id: string | null;
  proposed_label: string;
  status: EmptyBottleEventStatus;
  source: EmptyBottleSource;
  image_data: string | null;
  image_mime: string | null;
  vision_count: number | null;
  gemini_count: number | null;
  created_at: string;
};

export type EmptyBottleLine = {
  id: string;
  event_id: string;
  org_id: string;
  proposed_item_id: string | null;
  proposed_label: string;
  qty: number;
  sort: number;
};

export type EmptyBottleEventWithRelations = EmptyBottleEvent & {
  restaurants: Pick<Restaurant, "id" | "name"> | null;
  empty_bottle_lines: EmptyBottleLine[];
};

export type InventoryItemWithSupplier = InventoryItem & {
  suppliers: Pick<Supplier, "id" | "name"> | null;
};

export type StockMovementWithItem = StockMovement & {
  inventory_items: Pick<InventoryItem, "id" | "name" | "unit" | "sku"> | null;
};

export type Station = "Server" | "Cook" | "Bartender" | "Host" | "Dish" | "Manager" | "Other";

export type ShiftStatus = "draft" | "published";

export type Employee = {
  id: string;
  org_id: string;
  user_id: string | null;
  full_name: string;
  email: string | null;
  phone: string | null;
  position: Station;
  login_role: LoginRole;
  hourly_rate: number;
  home_restaurant_id: string | null;
  invite_code: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
};

export type Shift = {
  id: string;
  org_id: string;
  employee_id: string | null;
  restaurant_id: string | null;
  position: Station;
  starts_at: string;
  ends_at: string;
  status: ShiftStatus;
  note: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type ShiftWithEmployee = Shift & {
  employees: Pick<Employee, "id" | "full_name" | "position" | "user_id"> | null;
};

export type InvoiceStatus = "received" | "extracted" | "reviewed" | "exported";
export type InvoiceSource = "upload" | "whatsapp" | "camera" | "telegram";
export type InvoiceCategory = "food" | "kitchen" | "cleaning" | "tax" | "beverage" | "other";

export type Restaurant = {
  id: string;
  org_id: string;
  name: string;
  qbo_company_name: string;
  slug: string;
  notes: string | null;
  timezone: string | null;
  latitude: number | null;
  longitude: number | null;
  geofence_meters: number | null;
  created_at: string;
  updated_at: string;
};

export type RestaurantAliasRow = {
  id: string;
  org_id: string;
  restaurant_id: string;
  match_kind: "whatsapp_group" | "whatsapp_from" | "caption" | "customer";
  match_text: string;
};

export type Invoice = {
  id: string;
  org_id: string;
  restaurant_id: string | null;
  supplier_id: string | null;
  vendor_name: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  terms: string;
  currency: string;
  subtotal: number;
  tax: number;
  total: number;
  ap_account: string;
  status: InvoiceStatus;
  source: InvoiceSource;
  whatsapp_from: string | null;
  whatsapp_group: string | null;
  whatsapp_message_id: string | null;
  telegram_from: string | null;
  telegram_message_id: string | null;
  telegram_media_group_id: string | null;
  caption: string | null;
  image_data: string | null;
  image_mime: string | null;
  ocr_text: string | null;
  created_by: string | null;
  exported_at: string | null;
  quickbooks_txn_id: string | null;
  quickbooks_edit_sequence: string | null;
  created_at: string;
  updated_at: string;
};

export type InvoiceLine = {
  id: string;
  org_id: string;
  invoice_id: string;
  code: string | null;
  description: string;
  qty_ordered: number;
  qty_shipped: number;
  uom: string | null;
  pounds: number | null;
  unit_price: number;
  amount: number;
  category: InvoiceCategory;
  created_at: string;
};

export type InvoiceExpenseLine = {
  id: string;
  org_id: string;
  invoice_id: string;
  account: string;
  amount: number;
  memo: string | null;
  sort_order: number;
  created_at: string;
};

export type VendorAliasRow = {
  id: string;
  org_id: string;
  match_text: string;
  supplier_id: string;
  qbo_vendor_name: string;
};

export type AccountRuleRow = {
  id: string;
  org_id: string;
  keyword: string;
  account: string;
  memo: string | null;
  category: InvoiceCategory;
};

export type InvoiceSkuAliasRow = {
  id: string;
  org_id: string;
  match_text: string;
  account: string;
  memo: string | null;
  category: InvoiceCategory;
};

export type InvoiceExtractExampleRow = {
  id: string;
  org_id: string;
  invoice_id: string;
  supplier_id: string | null;
  restaurant_id: string | null;
  ocr_snippet: string;
  corrected: {
    vendor_name: string | null;
    invoice_number: string | null;
    invoice_date: string | null;
    total: number;
    lines: Array<{
      code: string | null;
      description: string;
      amount: number;
      category: InvoiceCategory;
    }>;
    expenses: Array<{ account: string; amount: number; memo: string }>;
    qbo_vendor_name?: string | null;
    supplier_id?: string | null;
  };
  created_at: string;
  updated_at: string;
};

export type InvoicePage = {
  id: string;
  org_id: string;
  invoice_id: string;
  sort_order: number;
  image_data: string | null;
  image_mime: string | null;
  created_at: string;
};

export type QuickbooksVendor = {
  id: string;
  org_id: string;
  connection_id: string;
  list_id: string;
  full_name: string;
  company_name: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type QuickbooksAccount = {
  id: string;
  org_id: string;
  connection_id: string;
  list_id: string;
  full_name: string;
  account_number: string | null;
  account_type: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type InvoiceWithSupplier = Invoice & {
  suppliers: Pick<Supplier, "id" | "name"> | null;
  restaurants: Pick<Restaurant, "id" | "name" | "qbo_company_name" | "slug"> | null;
  invoice_lines: InvoiceLine[];
  invoice_expense_lines: InvoiceExpenseLine[];
};

export type ClockEvent = {
  id: string;
  org_id: string;
  employee_id: string;
  restaurant_id: string | null;
  staff_shift_id: string | null;
  event_type: ClockEventType;
  actor_type: ClockActorType;
  source: ClockSource;
  occurred_at: string;
  recorded_at: string;
  client_occurred_at: string | null;
  client_event_id: string;
  note: string | null;
  latitude: number | null;
  longitude: number | null;
  accuracy_m: number | null;
  created_by: string | null;
};

export type ClockSession = {
  org_id: string;
  employee_id: string;
  restaurant_id: string | null;
  staff_shift_id: string | null;
  state: ClockSessionState;
  clocked_in_at: string;
  break_started_at: string | null;
  clock_in_event_id: string;
  last_event_id: string;
  updated_at: string;
};

export type TimeEntry = {
  id: string;
  org_id: string;
  employee_id: string;
  staff_shift_id: string | null;
  restaurant_id: string | null;
  position: string;
  started_at: string;
  ended_at: string;
  gross_seconds: number;
  paid_break_seconds: number;
  unpaid_break_seconds: number;
  worked_seconds: number;
  status: TimeEntryStatus;
  created_at: string;
  updated_at: string;
};

export type TimeBreak = {
  id: string;
  org_id: string;
  time_entry_id: string;
  break_start_event_id: string | null;
  break_end_event_id: string | null;
  started_at: string;
  ended_at: string;
  duration_seconds: number;
  break_type: BreakType;
  paid: boolean;
  created_at: string;
};

export type TimeException = {
  id: string;
  org_id: string;
  employee_id: string;
  time_entry_id: string | null;
  clock_event_id: string | null;
  staff_shift_id: string | null;
  type: TimeExceptionType;
  delta_seconds: number | null;
  status: TimeExceptionStatus;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
};

export type WhosWorkingRow = {
  org_id: string;
  employee_id: string;
  full_name: string;
  state: ClockSessionState;
  clocked_in_at: string | null;
  restaurant_id: string | null;
};

export type PayrollExport = {
  id: string;
  org_id: string;
  restaurant_id: string;
  period_start: string;
  period_end: string;
  exported_at: string;
  created_by: string | null;
  created_at: string;
};

export type PayrollExportLine = {
  id: string;
  org_id: string;
  payroll_export_id: string;
  employee_id: string;
  regular_seconds: number;
  ot_seconds: number;
  hourly_rate: number;
  gross: number;
  created_at: string;
};

export type QuickbooksOnlineConnection = {
  id: string;
  org_id: string;
  restaurant_id: string;
  realm_id: string;
  company_name: string | null;
  is_active: boolean;
  last_synced_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type QuickbooksDesktopConnection = {
  id: string;
  org_id: string;
  restaurant_id: string | null;
  name: string;
  qb_username: string;
  owner_id: string;
  file_id: string;
  company_file: string | null;
  qb_company_name: string | null;
  qb_product_name: string | null;
  qb_major_version: string | null;
  qb_minor_version: string | null;
  is_active: boolean;
  last_connected_at: string | null;
  last_successful_sync_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type QuickbooksSyncJobStatus = "pending" | "sending" | "completed" | "failed";

export type QuickbooksSyncJob = {
  id: string;
  org_id: string;
  connection_id: string;
  status: QuickbooksSyncJobStatus;
  operation: string;
  entity_type: string;
  entity_id: string;
  attempt_count: number;
  error_code: string | null;
  error_message: string | null;
  quickbooks_txn_id: string | null;
  created_at: string;
  updated_at: string;
};

export type QbwcUiStatus = "not_configured" | "waiting" | "connected" | "syncing" | "error";
