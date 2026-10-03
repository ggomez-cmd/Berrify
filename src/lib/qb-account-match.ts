import { ACCOUNTS, type ExpenseLine, type InvoiceCategory } from "./invoice-extract";
import { connectionIdForInvoiceVendors } from "./qb-vendor-match";

export type QbAccountKind = "tax" | "beverage" | "food" | "kitchen" | "cleaning" | "ap";

export type QbAccountRow = {
  connection_id: string;
  list_id: string;
  full_name: string;
  account_number?: string | null;
  account_type?: string | null;
  is_active: boolean;
};

export function connectionIdForInvoiceAccounts(
  restaurantId: string | null,
  connections: Array<{ id: string; restaurant_id: string | null; is_active: boolean }>,
  onlineConnections: Array<{ id: string; restaurant_id: string | null; is_active: boolean }> = [],
): string | null {
  return connectionIdForInvoiceVendors(restaurantId, connections, onlineConnections);
}

export function accountsForConnection(connectionId: string | null, accounts: QbAccountRow[]): QbAccountRow[] {
  if (!connectionId) return [];
  return accounts.filter((row) => row.connection_id === connectionId && row.is_active);
}

export function accountSelectValues(accounts: QbAccountRow[], currentValue?: string): string[] {
  const labels = accounts.map(qbAccountLabel);
  const extra = currentValue?.trim() ?? "";
  return Array.from(new Set([...labels, ...(extra ? [extra] : [])]));
}

export function apAccountsForSelect(accounts: QbAccountRow[]): QbAccountRow[] {
  return accounts.filter((row) => scoreAccount(row, "ap") > 0);
}

export function qbAccountLabel(row: Pick<QbAccountRow, "full_name" | "account_number">): string {
  const fullName = row.full_name.trim();
  const number = row.account_number?.trim() ?? "";
  if (!number) return fullName;
  if (fullName.startsWith(number) || fullName.includes(`${number} ·`) || fullName.includes(`${number}:`)) {
    return fullName;
  }
  return `${number} · ${fullName}`;
}

export type QbAccountRef = {
  listId: string | null;
  fullName: string | null;
};

const DISPLAY_ACCOUNT_RE = /^(\d[\d.]*)\s*[·•]\s*(.+)$/;

export function parseAccountDisplay(value: string): { number: string | null; name: string } {
  const trimmed = value.trim();
  const match = DISPLAY_ACCOUNT_RE.exec(trimmed);
  if (!match) return { number: null, name: trimmed };
  return { number: match[1], name: match[2].trim() };
}

export function resolveQbAccountRef(stored: string, accounts: QbAccountRow[]): QbAccountRef {
  const trimmed = stored.trim();
  if (!trimmed) return { listId: null, fullName: null };
  const parsed = parseAccountDisplay(trimmed);
  const active = accounts.filter((row) => row.is_active);

  const matched =
    active.find((row) => row.list_id === trimmed) ??
    active.find((row) => row.full_name.trim() === trimmed) ??
    active.find((row) => qbAccountLabel(row) === trimmed) ??
    active.find((row) => row.full_name.trim() === parsed.name) ??
    (parsed.number
      ? active.find(
          (row) =>
            (row.account_number?.trim() ?? "") === parsed.number &&
            foldAccount(row.full_name) === foldAccount(parsed.name),
        )
      : undefined) ??
    (parsed.number
      ? active.find((row) => (row.account_number?.trim() ?? "") === parsed.number)
      : undefined) ??
    active.find((row) => foldAccount(row.full_name) === foldAccount(parsed.name));

  if (matched) {
    return { listId: matched.list_id.trim() || null, fullName: matched.full_name.trim() || null };
  }

  return { listId: null, fullName: parsed.name || trimmed };
}

function foldAccount(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function haystack(row: QbAccountRow): string {
  return foldAccount([row.account_number, row.full_name, row.account_type].filter(Boolean).join(" "));
}

function scoreAccount(row: QbAccountRow, kind: QbAccountKind, description?: string): number {
  const hay = haystack(row);
  const extra = foldAccount(description ?? "");
  const type = row.account_type ?? "";
  switch (kind) {
    case "tax": {
      if (type === "AccountsPayable") return 0;
      let score = 0;
      if (/sales\s*tax|salestax|tax expense|68200/.test(hay)) score += 80;
      if (/\btax\b/.test(hay) && type === "Expense") score += 40;
      if (type === "OtherCurrentLiability" && /\btax\b/.test(hay)) score += 50;
      return score;
    }
    case "beverage": {
      let score = 0;
      if (/wine\s*purchase|winepurchase|51500/.test(hay)) score += 90;
      if (/\b(wine|liquor|beer|beverage|alcohol)\b/.test(hay)) score += 60;
      if (type === "CostOfGoodsSold" && /\b(wine|liquor|beer|beverage)\b/.test(hay)) score += 20;
      if (/\b(wine|liquor|beer|ipa|ron|rum)\b/.test(extra)) score += 10;
      return score;
    }
    case "food": {
      if (/(wine|liquor|beer|beverage|alcohol|clean|kitchen)/.test(hay) && !/food/.test(hay)) {
        return 0;
      }
      let score = 0;
      if (/food\s*purchase|50000/.test(hay)) score += 80;
      if (/\bfood\b/.test(hay)) score += 50;
      if (type === "CostOfGoodsSold" && !/(wine|liquor|beer|beverage)/.test(hay)) score += 30;
      if (/\bcogs\b/.test(hay) && !/(wine|liquor|beer)/.test(hay)) score += 20;
      return score;
    }
    case "kitchen": {
      let score = 0;
      if (/kitchen|restaurant|60020/.test(hay)) score += 80;
      if (/cup|napkin|container/.test(hay)) score += 30;
      return score;
    }
    case "cleaning": {
      let score = 0;
      if (/clean|supplies|60021/.test(hay)) score += 80;
      if (/fabuloso|detergent/.test(hay) || /fabuloso|detergent/.test(extra)) score += 20;
      return score;
    }
    case "ap": {
      let score = 0;
      if (type === "AccountsPayable" || type === "Accounts Payable") score += 100;
      if (/accounts\s*payable|20000/.test(hay)) score += 80;
      return score;
    }
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

export function matchQbAccount(input: {
  kind: QbAccountKind;
  description?: string;
  accounts: QbAccountRow[];
  fallback: string;
}): string {
  const active = input.accounts.filter((row) => row.is_active);
  let best: QbAccountRow | null = null;
  let bestScore = 0;
  for (const row of active) {
    const score = scoreAccount(row, input.kind, input.description);
    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }
  if (!best || bestScore <= 0) return input.fallback;
  return qbAccountLabel(best);
}

export function accountKindFromCategory(category: InvoiceCategory): Exclude<QbAccountKind, "ap"> {
  switch (category) {
    case "tax":
      return "tax";
    case "beverage":
      return "beverage";
    case "food":
    case "other":
      return "food";
    case "kitchen":
      return "kitchen";
    case "cleaning":
      return "cleaning";
    default: {
      const exhaustive: never = category;
      return exhaustive;
    }
  }
}

export function inferExpenseAccountKind(expense: Pick<ExpenseLine, "account" | "memo">): Exclude<QbAccountKind, "ap"> {
  const hay = foldAccount(`${expense.account} ${expense.memo}`);
  if (expense.account === ACCOUNTS.tax || /sales\s*tax|salestax|\btax\b/.test(hay)) return "tax";
  if (expense.account === ACCOUNTS.beverage || /\b(wine|liquor|beer|beverage|alcohol)\b/.test(hay)) {
    return "beverage";
  }
  if (expense.account === ACCOUNTS.kitchen || /kitchen|restaurant/.test(hay)) return "kitchen";
  if (expense.account === ACCOUNTS.cleaning || /clean|supplies|fabuloso/.test(hay)) return "cleaning";
  return "food";
}

export function applyQbAccountNames(expenses: ExpenseLine[], accounts: QbAccountRow[]): ExpenseLine[] {
  if (accounts.length === 0) return expenses;
  return expenses.map((expense) => ({
    ...expense,
    account: matchQbAccount({
      kind: inferExpenseAccountKind(expense),
      description: expense.memo,
      accounts,
      fallback: expense.account,
    }),
  }));
}

export function matchQbApAccount(accounts: QbAccountRow[], fallback: string = ACCOUNTS.ap): string {
  return matchQbAccount({ kind: "ap", accounts, fallback });
}
