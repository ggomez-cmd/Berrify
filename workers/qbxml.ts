export const QBXML_VERSION = "13.0";

export type QbxmlOpcode =
  | "CompanyQuery"
  | "VendorQuery"
  | "AccountQuery"
  | "ItemQuery"
  | "BillAdd";

export type CompanyQueryResult = {
  companyName: string | null;
  legalCompanyName: string | null;
  productName: string | null;
  majorVersion: string | null;
  minorVersion: string | null;
  statusCode: string | null;
  statusSeverity: string | null;
  statusMessage: string | null;
};

export type ParsedQbStatus = {
  statusCode: string | null;
  statusSeverity: string | null;
  statusMessage: string | null;
  ok: boolean;
};

const TAG_RE = (name: string) =>
  new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i");

export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function xmlCodePoint(code: number): string | null {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return null;
  if (code >= 0xd800 && code <= 0xdfff) return null;
  return String.fromCodePoint(code);
}

export function xmlUnescape(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([0-9a-fA-F]+)|(lt|gt|quot|apos|amp));/g,
    (entity, dec: string | undefined, hex: string | undefined) => {
      if (dec) {
        const decoded = xmlCodePoint(Number(dec));
        return decoded ?? entity;
      }
      if (hex) {
        const decoded = xmlCodePoint(Number.parseInt(hex, 16));
        return decoded ?? entity;
      }
      switch (entity) {
        case "&lt;":
          return "<";
        case "&gt;":
          return ">";
        case "&quot;":
          return '"';
        case "&apos;":
          return "'";
        case "&amp;":
          return "&";
        default:
          return entity;
      }
    },
  );
}

export function xmlText(xml: string, tag: string): string | null {
  const match = TAG_RE(tag).exec(xml);
  if (!match) return null;
  const text = xmlUnescape(match[1].trim());
  return text.length > 0 ? text : null;
}

const XML_TAG_RE = /<\/?([A-Za-z_][\w:.-]*)\b[^>]*?>/g;

/** Text of a leaf element that is a direct child of the outermost element. */
function xmlDirectText(xml: string, tag: string): string | null {
  const wanted = tag.toLowerCase();
  const tagRe = new RegExp(XML_TAG_RE.source, "g");
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(xml))) {
    const full = match[0];
    const name = match[1] ?? "";
    const closing = full.startsWith("</");
    const selfClosing = !closing && full.endsWith("/>");
    if (closing) {
      depth -= 1;
      continue;
    }
    if (depth === 1 && name.toLowerCase() === wanted && !selfClosing) {
      const rest = xml.slice(tagRe.lastIndex);
      const end = new RegExp(`</${name}\\s*>`, "i").exec(rest);
      if (end && !/<[A-Za-z_]/.test(rest.slice(0, end.index))) {
        const text = xmlUnescape(rest.slice(0, end.index).trim());
        return text.length > 0 ? text : null;
      }
    }
    if (!selfClosing) depth += 1;
  }
  return null;
}

export function xmlBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "gi");
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml))) {
    blocks.push(match[0]);
  }
  return blocks;
}

export function xmlAttr(xml: string, tag: string, attr: string): string | null {
  const open = new RegExp(`<${tag}\\b([^>]*)>`, "i").exec(xml);
  if (!open) return null;
  const quoted = new RegExp(`${attr}\\s*=\\s*"([^"]*)"`, "i").exec(open[1]);
  if (quoted) return xmlUnescape(quoted[1]);
  const single = new RegExp(`${attr}\\s*=\\s*'([^']*)'`, "i").exec(open[1]);
  return single ? xmlUnescape(single[1]) : null;
}

export function parseQbStatus(xml: string, responseTag: string): ParsedQbStatus {
  const statusCode = xmlAttr(xml, responseTag, "statusCode");
  const statusSeverity = xmlAttr(xml, responseTag, "statusSeverity");
  const statusMessage = xmlAttr(xml, responseTag, "statusMessage");
  const ok = statusCode === "0" || statusCode === null;
  return { statusCode, statusSeverity, statusMessage, ok };
}

export const QBXML_XML_DECLARATION = `<?xml version="1.0" encoding="utf-8"?>`;

function qbxmlDocument(innerLines: string[]): string {
  return [
    QBXML_XML_DECLARATION,
    `<?qbxml version="${QBXML_VERSION}"?>`,
    `<QBXML>`,
    `  <QBXMLMsgsRq onError="stopOnError">`,
    ...innerLines,
    `  </QBXMLMsgsRq>`,
    `</QBXML>`,
  ].join("\n");
}

export function buildCompanyQueryRq(): string {
  return qbxmlDocument([`    <CompanyQueryRq></CompanyQueryRq>`]);
}

export function parseCompanyQueryRs(xml: string): CompanyQueryResult {
  const status = parseQbStatus(xml, "CompanyQueryRs");
  const host = parseQbStatus(xml, "HostQueryRs");
  return {
    companyName: xmlText(xml, "CompanyName"),
    legalCompanyName: xmlText(xml, "LegalCompanyName"),
    productName: xmlText(xml, "ProductName"),
    majorVersion: xmlText(xml, "MajorVersion"),
    minorVersion: xmlText(xml, "MinorVersion"),
    statusCode: status.statusCode ?? host.statusCode,
    statusSeverity: status.statusSeverity ?? host.statusSeverity,
    statusMessage: status.statusMessage ?? host.statusMessage,
  };
}

export function parseHcpHostInfo(xml: string): Pick<
  CompanyQueryResult,
  "companyName" | "productName" | "majorVersion" | "minorVersion"
> {
  return {
    companyName: xmlText(xml, "CompanyName"),
    productName: xmlText(xml, "ProductName"),
    majorVersion: xmlText(xml, "MajorVersion"),
    minorVersion: xmlText(xml, "MinorVersion"),
  };
}

export type QbListRef = {
  listId?: string | null;
  fullName?: string | null;
};

export type BillAddFields = {
  vendorName: string;
  refNumber: string | null;
  txnDate: string | null;
  dueDate: string | null;
  terms: string | null;
  apAccount: QbListRef;
  expenses: Array<{ account: QbListRef; amount: number; memo: string }>;
  total: number;
};

export const EXACT_QB_TERMS_NAMES = [
  "Due on receipt",
  "Net 10",
  "Net 15",
  "Net 30",
  "Net 60",
  "COD",
] as const;

export function exactQbTermsName(terms: string | null | undefined): string | null {
  const value = terms?.trim() ?? "";
  if (!value) return null;
  return (EXACT_QB_TERMS_NAMES as readonly string[]).includes(value) ? value : null;
}

export function qbListRefXml(ref: QbListRef, indent: string): string | null {
  const listId = ref.listId?.trim() ?? "";
  if (listId) return `${indent}<ListID>${xmlEscape(listId)}</ListID>`;
  const fullName = ref.fullName?.trim() ?? "";
  if (!fullName) return null;
  return `${indent}<FullName>${xmlEscape(fullName)}</FullName>`;
}

export type BillAddResult = ParsedQbStatus & {
  txnId: string | null;
  editSequence: string | null;
};

function qbxmlDate(iso: string | null): string | null {
  if (!iso) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!match) return iso.trim() || null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function qbxmlAmount(amount: number): string {
  return (Math.round(amount * 100) / 100).toFixed(2);
}

export function buildBillAddRq(input: BillAddFields): string {
  const txnDate = qbxmlDate(input.txnDate);
  const dueDate = qbxmlDate(input.dueDate);
  const terms = exactQbTermsName(input.terms);
  const refNumber = input.refNumber?.trim() ?? "";
  const expenses = input.expenses
    .filter((line) => {
      const hasAccount = Boolean(line.account.listId?.trim() || line.account.fullName?.trim());
      return Number.isFinite(line.amount) && line.amount !== 0 && hasAccount;
    })
    .map((line) => {
      const memo = line.memo.trim();
      const accountRef = qbListRefXml(line.account, "            ");
      return [
        `        <ExpenseLineAdd>`,
        `          <AccountRef>`,
        accountRef,
        `          </AccountRef>`,
        `          <Amount>${qbxmlAmount(line.amount)}</Amount>`,
        memo ? `          <Memo>${xmlEscape(memo)}</Memo>` : null,
        `        </ExpenseLineAdd>`,
      ]
        .filter((row): row is string => row !== null)
        .join("\n");
    });
  const apRef = qbListRefXml(input.apAccount, "          ");
  // Intuit BillAdd XSD sequence: VendorRef, APAccountRef, TxnDate, DueDate,
  // RefNumber, TermsRef, then ExpenseLineAdd. Wrong order is 0x80040400.
  const optional = [
    apRef ? [`        <APAccountRef>`, apRef, `        </APAccountRef>`].join("\n") : null,
    txnDate ? `        <TxnDate>${xmlEscape(txnDate)}</TxnDate>` : null,
    dueDate ? `        <DueDate>${xmlEscape(dueDate)}</DueDate>` : null,
    refNumber ? `        <RefNumber>${xmlEscape(refNumber)}</RefNumber>` : null,
    terms
      ? [`        <TermsRef>`, `          <FullName>${xmlEscape(terms)}</FullName>`, `        </TermsRef>`].join("\n")
      : null,
  ].filter((row): row is string => row !== null);

  return qbxmlDocument([
    `    <BillAddRq>`,
    `      <BillAdd>`,
    `        <VendorRef>`,
    `          <FullName>${xmlEscape(input.vendorName.trim())}</FullName>`,
    `        </VendorRef>`,
    ...optional,
    ...expenses,
    `      </BillAdd>`,
    `    </BillAddRq>`,
  ]);
}

export type VendorQueryRow = {
  listId: string;
  fullName: string;
  companyName: string | null;
  isActive: boolean;
};

export type VendorQueryResult = ParsedQbStatus & {
  vendors: VendorQueryRow[];
};

export function buildVendorQueryRq(): string {
  return qbxmlDocument([
    `    <VendorQueryRq>`,
    `      <ActiveStatus>All</ActiveStatus>`,
    `    </VendorQueryRq>`,
  ]);
}

function parseIsActive(value: string | null): boolean {
  if (!value) return true;
  return !/^(false|0|n)$/i.test(value.trim());
}

export function parseVendorQueryRs(xml: string): VendorQueryResult {
  const status = parseQbStatus(xml, "VendorQueryRs");
  const vendors: VendorQueryRow[] = [];
  for (const block of xmlBlocks(xml, "VendorRet")) {
    const listId = xmlDirectText(block, "ListID");
    // VendorRet has no list FullName. The first FullName in the block is a nested
    // ref (TermsRef "Net 30", ClassRef, VendorTypeRef). BillAdd matches Name.
    const fullName = xmlDirectText(block, "FullName") ?? xmlDirectText(block, "Name");
    if (!listId || !fullName) continue;
    vendors.push({
      listId,
      fullName,
      companyName: xmlDirectText(block, "CompanyName"),
      isActive: parseIsActive(xmlDirectText(block, "IsActive")),
    });
  }
  return { ...status, vendors };
}

export const KEPT_QB_ACCOUNT_TYPES = [
  "Expense",
  "CostOfGoodsSold",
  "OtherCurrentLiability",
  "AccountsPayable",
] as const;

export type KeptQbAccountType = (typeof KEPT_QB_ACCOUNT_TYPES)[number];

export type AccountQueryRow = {
  listId: string;
  fullName: string;
  accountNumber: string | null;
  accountType: string;
  isActive: boolean;
};

export type AccountQueryResult = ParsedQbStatus & {
  accounts: AccountQueryRow[];
};

export function isKeptQbAccountType(value: string | null): value is KeptQbAccountType {
  return KEPT_QB_ACCOUNT_TYPES.includes(value as KeptQbAccountType);
}

export function buildAccountQueryRq(): string {
  return qbxmlDocument([
    `    <AccountQueryRq>`,
    `      <ActiveStatus>All</ActiveStatus>`,
    `    </AccountQueryRq>`,
  ]);
}

export function parseAccountQueryRs(xml: string): AccountQueryResult {
  const status = parseQbStatus(xml, "AccountQueryRs");
  const accounts: AccountQueryRow[] = [];
  for (const block of xmlBlocks(xml, "AccountRet")) {
    const listId = xmlText(block, "ListID");
    const fullName = xmlText(block, "FullName") ?? xmlText(block, "Name");
    const accountType = xmlText(block, "AccountType");
    if (!listId || !fullName || !isKeptQbAccountType(accountType)) continue;
    accounts.push({
      listId,
      fullName,
      accountNumber: xmlText(block, "AccountNumber"),
      accountType,
      isActive: parseIsActive(xmlText(block, "IsActive")),
    });
  }
  return { ...status, accounts };
}

export function parseBillAddRs(xml: string): BillAddResult {
  const hasRs = /<BillAddRs\b/i.test(xml);
  const status = parseQbStatus(xml, "BillAddRs");
  return {
    ...status,
    ok: hasRs && status.ok,
    txnId: xmlText(xml, "TxnID"),
    editSequence: xmlText(xml, "EditSequence"),
  };
}

export function futureVendorQueryOpcode(): Extract<QbxmlOpcode, "VendorQuery"> {
  return "VendorQuery";
}

export function futureAccountQueryOpcode(): Extract<QbxmlOpcode, "AccountQuery"> {
  return "AccountQuery";
}

export function futureItemQueryOpcode(): Extract<QbxmlOpcode, "ItemQuery"> {
  return "ItemQuery";
}

export function futureBillAddOpcode(): Extract<QbxmlOpcode, "BillAdd"> {
  return "BillAdd";
}
