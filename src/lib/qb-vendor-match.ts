import type { InvoiceCategory, VendorAlias } from "./invoice-extract";

export type QbVendorRow = {
  connection_id: string;
  list_id: string;
  full_name: string;
  company_name?: string | null;
  is_active: boolean;
};

export type QbVendorMatchSide = "food" | "liquor" | "none";

export type QbVendorMatch = {
  fullName: string | null;
  options: string[];
  reason: "food" | "liquor" | "single" | "only_suffix" | "mixed" | "unclear" | "alias" | "empty";
};

const FOOD_SUFFIX = /\(\s*food\s*\)$/i;
const LIQUOR_SUFFIX = /\(\s*liquor\s*\)$/i;
const SUFFIX = /\(\s*(food|liquor)\s*\)$/i;

const LIQUOR_KEYWORDS =
  /\b(rum|ron|beer|cerveza|ipa|wine|vodka|whiskey|whisky|tequila|gin|liquor|licor|spirit)\b/i;

export function foldVendorName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function vendorBaseName(fullName: string): string {
  return fullName.replace(SUFFIX, "").trim();
}

export function vendorSuffix(fullName: string): "food" | "liquor" | null {
  if (FOOD_SUFFIX.test(fullName)) return "food";
  if (LIQUOR_SUFFIX.test(fullName)) return "liquor";
  return null;
}

export function skuLineSide(category: InvoiceCategory, description?: string): QbVendorMatchSide {
  switch (category) {
    case "tax":
      return "none";
    case "beverage":
      return "liquor";
    case "food":
    case "kitchen":
    case "cleaning":
      return "food";
    case "other":
      return description && LIQUOR_KEYWORDS.test(description) ? "liquor" : "food";
    default: {
      const exhaustive: never = category;
      return exhaustive;
    }
  }
}

export function classifyInvoiceSide(
  lines: Array<{ category: InvoiceCategory; description?: string }>,
): "food" | "liquor" | "mixed" | "none" {
  let food = false;
  let liquor = false;
  for (const line of lines) {
    const side = skuLineSide(line.category, line.description);
    if (side === "food") food = true;
    if (side === "liquor") liquor = true;
  }
  if (food && liquor) return "mixed";
  if (food) return "food";
  if (liquor) return "liquor";
  return "none";
}

export function connectionIdForInvoiceVendors(
  restaurantId: string | null,
  connections: Array<{ id: string; restaurant_id: string | null; is_active: boolean }>,
  onlineConnections: Array<{ id: string; restaurant_id: string | null; is_active: boolean }> = [],
): string | null {
  if (restaurantId) {
    const online = onlineConnections.find((row) => row.restaurant_id === restaurantId && row.is_active);
    if (online) return online.id;
    const scoped = connections.find((row) => row.restaurant_id === restaurantId && row.is_active);
    if (scoped) return scoped.id;
  }
  const shared = connections.find((row) => row.restaurant_id == null && row.is_active);
  return shared?.id ?? null;
}

export function vendorsForConnection(connectionId: string | null, vendors: QbVendorRow[]): QbVendorRow[] {
  if (!connectionId) return [];
  return vendors.filter((row) => row.connection_id === connectionId && row.is_active);
}

function letterheadCandidates(printName: string | null, ocrText?: string | null): string[] {
  const values = [printName];
  if (ocrText) {
    for (const line of ocrText.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length >= 3 && trimmed.length < 80) values.push(trimmed);
    }
  }
  return values.filter((value): value is string => Boolean(value && value.trim()));
}

function scoreName(hay: string, needle: string): number {
  const a = foldVendorName(hay);
  const b = foldVendorName(needle);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length);
  return 0;
}

function groupByBase(vendors: QbVendorRow[]): Map<string, QbVendorRow[]> {
  const groups = new Map<string, QbVendorRow[]>();
  for (const vendor of vendors) {
    const key = foldVendorName(vendorBaseName(vendor.full_name));
    const rows = groups.get(key) ?? [];
    rows.push(vendor);
    groups.set(key, rows);
  }
  return groups;
}

function pickGroup(
  printName: string | null,
  ocrText: string | null | undefined,
  vendors: QbVendorRow[],
): QbVendorRow[] {
  const groups = groupByBase(vendors);
  let best: QbVendorRow[] = [];
  let bestScore = 0;
  for (const candidate of letterheadCandidates(printName, ocrText)) {
    for (const [base, rows] of groups) {
      const score = Math.max(
        scoreName(candidate, base),
        ...rows.map((row) => scoreName(candidate, row.full_name)),
      );
      if (score > bestScore) {
        bestScore = score;
        best = rows;
      }
    }
  }
  return bestScore >= 4 ? best : [];
}

function aliasFallback(
  printName: string | null,
  ocrText: string | null | undefined,
  aliases: VendorAlias[],
): QbVendorMatch {
  const hay = foldVendorName([printName, ocrText].filter(Boolean).join(" "));
  const hit = [...aliases]
    .sort((a, b) => b.match_text.length - a.match_text.length)
    .find((alias) => hay.includes(foldVendorName(alias.match_text)));
  if (!hit) {
    return { fullName: null, options: [], reason: "empty" };
  }
  return { fullName: hit.qbo_vendor_name, options: [hit.qbo_vendor_name], reason: "alias" };
}

export function matchQbVendor(input: {
  printName: string | null;
  ocrText?: string | null;
  lines: Array<{ category: InvoiceCategory; description?: string }>;
  vendors: QbVendorRow[];
  aliases?: VendorAlias[];
}): QbVendorMatch {
  const active = input.vendors.filter((row) => row.is_active);
  if (active.length === 0) {
    return aliasFallback(input.printName, input.ocrText, input.aliases ?? []);
  }

  const group = pickGroup(input.printName, input.ocrText, active);
  if (group.length === 0) {
    return { fullName: null, options: [], reason: "unclear" };
  }

  const food = group.find((row) => vendorSuffix(row.full_name) === "food");
  const liquor = group.find((row) => vendorSuffix(row.full_name) === "liquor");
  const unsuffixed = group.filter((row) => vendorSuffix(row.full_name) == null);
  const side = classifyInvoiceSide(input.lines);

  if (food && liquor) {
    if (side === "mixed" || side === "none") {
      return {
        fullName: null,
        options: [food.full_name, liquor.full_name],
        reason: side === "mixed" ? "mixed" : "unclear",
      };
    }
    if (side === "food") return { fullName: food.full_name, options: [food.full_name, liquor.full_name], reason: "food" };
    return { fullName: liquor.full_name, options: [food.full_name, liquor.full_name], reason: "liquor" };
  }

  if (food && !liquor) {
    if (side === "mixed") {
      return { fullName: null, options: [food.full_name, ...unsuffixed.map((row) => row.full_name)], reason: "mixed" };
    }
    return { fullName: food.full_name, options: [food.full_name], reason: "only_suffix" };
  }
  if (liquor && !food) {
    if (side === "mixed") {
      return { fullName: null, options: [liquor.full_name, ...unsuffixed.map((row) => row.full_name)], reason: "mixed" };
    }
    return { fullName: liquor.full_name, options: [liquor.full_name], reason: "only_suffix" };
  }

  if (unsuffixed.length === 1) {
    return { fullName: unsuffixed[0]!.full_name, options: [unsuffixed[0]!.full_name], reason: "single" };
  }
  return {
    fullName: null,
    options: group.map((row) => row.full_name),
    reason: "unclear",
  };
}

export function guessVendorFullNameFromText(
  text: string | null | undefined,
  vendors: QbVendorRow[],
): string | null {
  if (!text?.trim() || vendors.length === 0) return null;
  const group = pickGroup(text, text, vendors.filter((row) => row.is_active));
  if (group.length === 1) return group[0]!.full_name;
  if (group.length > 1) {
    const bases = new Set(group.map((row) => foldVendorName(vendorBaseName(row.full_name))));
    if (bases.size === 1) return vendorBaseName(group[0]!.full_name);
  }
  return null;
}

export function differentVendorFullName(
  incoming: string | null | undefined,
  existing: string | null | undefined,
): boolean {
  if (!incoming?.trim() || !existing?.trim()) return false;
  const a = foldVendorName(vendorBaseName(incoming));
  const b = foldVendorName(vendorBaseName(existing));
  return a.length > 0 && b.length > 0 && a !== b;
}
