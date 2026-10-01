import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { Input, Select } from "../../components/ui/input";
import { Field } from "../../components/ui/label";
import {
  ACCOUNTS,
  DEFAULT_ACCOUNT_RULES,
  expensesFromLinesOrExtract,
  invoiceTotals,
  toQuickBooksBillCsv,
  toQuickBooksBillIif,
  type AccountRule,
  type ExpenseLine,
  type ExtractedInvoice,
  type ExtractedSku,
  type VendorAlias,
} from "../../lib/invoice-extract";
import { extractEngineNote, extractInvoicesAfterOcr } from "../../lib/invoice-extract-api";
import { formatMoney } from "../../lib/format";
import { assertInvoiceImage, toRasterDataUrl } from "../../lib/invoice-image";
import { composeInvoicePageImages, invoicesToPersistFromPhoto, nextInvoicePageSortOrder } from "../../lib/invoice-pages";
import { EXTRACT_EXAMPLE_LIMIT, pickClosestExamples } from "../../lib/invoice-review-memory";
import {
  accountsForConnection,
  apAccountsForSelect,
  applyQbAccountNames,
  connectionIdForInvoiceAccounts,
} from "../../lib/qb-account-match";
import { connectionIdForInvoiceVendors, matchQbVendor, vendorsForConnection } from "../../lib/qb-vendor-match";
import { toThrownError } from "../../lib/thrown-error";
import { getOcrEngine, ocrEngineNote, ocrImage } from "../../lib/ocr";
import { matchRestaurant, restaurantFileSlug } from "../../lib/restaurant-route";
import type {
  AccountRuleRow,
  InvoiceCategory,
  InvoiceExtractExampleRow,
  InvoiceSkuAliasRow,
  InvoiceWithSupplier,
  Restaurant,
  RestaurantAliasRow,
  Supplier,
  VendorAliasRow,
} from "../../lib/types";
import { sendInvoiceToQuickBooks } from "../../lib/qbwc-manager-api";
import { invoiceQbJobLabel } from "../../lib/qbwc-status";
import type { QuickbooksSyncJob } from "../../lib/types";
import { useQuickbooksAccounts, useQuickbooksConnections, useQuickbooksVendors } from "../quickbooks/hooks";
import { InvoicePhotoLightbox } from "./InvoicePhotoLightbox";
import { InvoiceReviewAccountField } from "./InvoiceReviewAccountField";
import { InvoiceReviewPhotoColumn } from "./InvoiceReviewPhotoColumn";
import { fileToDataUrl, useAddInvoicePage, useDeleteInvoice, useInvoiceMedia, useInvoicePages, useUpdateInvoice } from "./hooks";

const CATEGORIES: InvoiceCategory[] = ["food", "kitchen", "cleaning", "beverage", "tax", "other"];

function downloadText(filename: string, contents: string, mime: string) {
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function toVendorAliases(rows: VendorAliasRow[]): VendorAlias[] {
  return rows.map((alias) => ({
    match_text: alias.match_text,
    supplier_id: alias.supplier_id,
    qbo_vendor_name: alias.qbo_vendor_name,
  }));
}

function toAccountRules(rows: AccountRuleRow[]): AccountRule[] {
  if (rows.length === 0) return DEFAULT_ACCOUNT_RULES;
  return rows.map((rule) => ({
    keyword: rule.keyword,
    account: rule.account,
    memo: rule.memo,
    category: rule.category,
  }));
}

async function billsFromOcr(
  text: string,
  current: InvoiceWithSupplier,
  restaurants: Restaurant[],
  restaurantAliases: RestaurantAliasRow[],
  vendorAliases: VendorAliasRow[],
  accountRules: AccountRuleRow[],
  skuAliases: InvoiceSkuAliasRow[],
  extractExamples: InvoiceExtractExampleRow[],
  image?: string | null,
  confidence?: number,
): Promise<{
  first: ExtractedInvoice | null;
  extras: ExtractedInvoice[];
  restaurantId: string | null;
  extractNote: string;
}> {
  const aliases = toVendorAliases(vendorAliases);
  const rules = toAccountRules(accountRules);
  const { invoices: extracted, engine, error } = await extractInvoicesAfterOcr({
    ocrText: text,
    image,
    confidence,
    restaurants: restaurants.map((restaurant) => ({
      name: restaurant.name,
      qbo_company_name: restaurant.qbo_company_name,
      slug: restaurant.slug,
    })),
    vendorAliases: aliases,
    accountRules: rules,
    skuAliases: skuAliases.map((alias) => ({
      match_text: alias.match_text,
      account: alias.account,
      memo: alias.memo,
      category: alias.category,
    })),
    examples: pickClosestExamples(text, extractExamples, EXTRACT_EXAMPLE_LIMIT, {
      aliases,
      restaurantId: current.restaurant_id,
      excludeInvoiceId: current.id,
    }),
  });
  const [first] = invoicesToPersistFromPhoto(extracted);
  if (!first) {
    return {
      first: null,
      extras: [],
      restaurantId: current.restaurant_id,
      extractNote: extractEngineNote(engine, error),
    };
  }

  let restaurantId = current.restaurant_id;
  if (!restaurantId) {
    const route = matchRestaurant(
      {
        ocrText: text,
        caption: current.caption,
        from: current.whatsapp_from,
        group: current.whatsapp_group,
      },
      restaurants.map((restaurant) => ({
        id: restaurant.id,
        name: restaurant.name,
        qbo_company_name: restaurant.qbo_company_name,
        slug: restaurant.slug,
      })),
      restaurantAliases.map((alias) => ({
        restaurant_id: alias.restaurant_id,
        match_kind: alias.match_kind,
        match_text: alias.match_text,
      })),
    );
    restaurantId = route?.restaurant.id ?? null;
  }
  return { first, extras: [], restaurantId, extractNote: extractEngineNote(engine, error) };
}

export function InvoiceReviewDialog({
  open,
  onOpenChange,
  invoice,
  suppliers,
  restaurants,
  restaurantAliases,
  vendorAliases,
  skuAliases,
  accountRules,
  extractExamples,
  qbJob,
  onQbJobChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoice: InvoiceWithSupplier | null;
  suppliers: Supplier[];
  restaurants: Restaurant[];
  restaurantAliases: RestaurantAliasRow[];
  vendorAliases: VendorAliasRow[];
  skuAliases: InvoiceSkuAliasRow[];
  accountRules: AccountRuleRow[];
  extractExamples: InvoiceExtractExampleRow[];
  qbJob?: QuickbooksSyncJob | null;
  onQbJobChange?: () => void;
}) {
  const save = useUpdateInvoice();
  const remove = useDeleteInvoice();
  const addPage = useAddInvoicePage();
  const media = useInvoiceMedia(open && invoice ? invoice.id : null);
  const pagesQuery = useInvoicePages(open && invoice ? invoice.id : null);
  const { data: qbConnections = [] } = useQuickbooksConnections();
  const { data: qbVendors = [] } = useQuickbooksVendors();
  const { data: qbAccounts = [] } = useQuickbooksAccounts();
  const ocrStartedFor = useRef<string | null>(null);
  const [restaurantId, setRestaurantId] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [vendorName, setVendorName] = useState("");
  const [number, setNumber] = useState("");
  const [date, setDate] = useState("");
  const [due, setDue] = useState("");
  const [terms, setTerms] = useState("Net 15");
  const [tax, setTax] = useState(0);
  const [lines, setLines] = useState<ExtractedSku[]>([]);
  const [expenses, setExpenses] = useState<ExpenseLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrNote, setOcrNote] = useState<string | null>(null);
  const [ocrText, setOcrText] = useState<string | null>(null);
  const [extractTotal, setExtractTotal] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [photoSrc, setPhotoSrc] = useState<string | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [qbVendorName, setQbVendorName] = useState("");
  const [vendorOptions, setVendorOptions] = useState<string[]>([]);
  const [apAccount, setApAccount] = useState<string>(ACCOUNTS.ap);
  const [qbBusy, setQbBusy] = useState(false);
  const addPageInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open || !invoice) return;
    setRestaurantId(invoice.restaurant_id ?? "");
    setSupplierId(invoice.supplier_id ?? "");
    setVendorName(invoice.vendor_name ?? "");
    setNumber(invoice.invoice_number ?? "");
    setDate(invoice.invoice_date ?? "");
    setDue(invoice.due_date ?? "");
    setTerms(invoice.terms || "Net 15");
    setTax(Number(invoice.tax));
    const nextLines = invoice.invoice_lines.map((l) => ({
      code: l.code,
      description: l.description,
      qty_ordered: Number(l.qty_ordered),
      qty_shipped: Number(l.qty_shipped),
      uom: l.uom,
      pounds: l.pounds == null ? null : Number(l.pounds),
      unit_price: Number(l.unit_price),
      amount: Number(l.amount),
      category: l.category,
    }));
    setLines(nextLines);
    const savedTotal = Number(invoice.total);
    setExtractTotal(savedTotal);
    setExpenses(
      invoice.invoice_expense_lines.length > 0
        ? invoice.invoice_expense_lines.map((e) => ({
            account: e.account,
            amount: Number(e.amount),
            memo: e.memo ?? "",
          }))
        : expensesFromLinesOrExtract(nextLines, Number(invoice.tax), {
            total: savedTotal,
            expenses: [],
          }),
    );
    setError(null);
    setOcrBusy(false);
    setOcrNote(null);
    setOcrText(null);
    setLightboxOpen(false);
    setPhotoSrc(null);
    setPageIndex(0);
    setQbVendorName(invoice.vendor_name ?? "");
    setVendorOptions([]);
    setApAccount(invoice.ap_account || ACCOUNTS.ap);
    setQbBusy(false);
    ocrStartedFor.current = null;
  }, [open, invoice]);

  useEffect(() => {
    if (!open || !media.data?.image_data) {
      setPhotoSrc(null);
      return;
    }
    const raw = media.data.image_data;
    let cancelled = false;
    void toRasterDataUrl(raw)
      .then((src) => {
        if (!cancelled) setPhotoSrc(src);
      })
      .catch(() => {
        if (!cancelled) setPhotoSrc(raw);
      });
    return () => {
      cancelled = true;
    };
  }, [open, media.data?.image_data]);

  useEffect(() => {
    if (!open || !invoice || media.isLoading || !media.data) return;
    if (ocrStartedFor.current === invoice.id) return;
    if (media.data.image_data && !photoSrc) return;

    const applyPreview = async (
      text: string,
      allowExtras: boolean,
      image?: string | null,
      confidence?: number,
    ) => {
      const preview = await billsFromOcr(
        text,
        invoice,
        restaurants,
        restaurantAliases,
        vendorAliases,
        accountRules,
        skuAliases,
        extractExamples,
        image,
        confidence,
      );
      if (preview.restaurantId) setRestaurantId(preview.restaurantId);
      setOcrNote((note) =>
        note ? `${note} · ${preview.extractNote}` : preview.extractNote,
      );
      if (!preview.first) return;
      const connectionId = connectionIdForInvoiceVendors(preview.restaurantId, qbConnections);
      const scopedAccounts = accountsForConnection(
        connectionIdForInvoiceAccounts(preview.restaurantId, qbConnections),
        qbAccounts,
      );
      const match = matchQbVendor({
        printName: preview.first.vendor_name,
        ocrText: text,
        lines: preview.first.lines,
        vendors: vendorsForConnection(connectionId, qbVendors),
        aliases: toVendorAliases(vendorAliases),
      });
      const mixed = match.reason === "mixed" || match.reason === "unclear";
      setVendorName(mixed ? "" : (preview.first.vendor_name ?? ""));
      setSupplierId(mixed ? "" : (preview.first.supplier_id ?? ""));
      setQbVendorName(match.fullName ?? "");
      setVendorOptions(match.options);
      setNumber(preview.first.invoice_number ?? "");
      setDate(preview.first.invoice_date ?? "");
      setDue(preview.first.due_date ?? "");
      setTerms(preview.first.terms || "Net 15");
      setTax(preview.first.tax);
      setLines(preview.first.lines);
      setExtractTotal(preview.first.total);
      setExpenses(
        applyQbAccountNames(
          expensesFromLinesOrExtract(preview.first.lines, preview.first.tax, preview.first),
          scopedAccounts,
        ),
      );
      void allowExtras;
    };

    const existingOcr = media.data.ocr_text;
    const image = photoSrc ?? media.data.image_data;
    if (existingOcr) {
      ocrStartedFor.current = invoice.id;
      setOcrText(existingOcr);
      if (invoice.invoice_lines.length === 0) {
        setOcrBusy(true);
        void applyPreview(existingOcr, false, image)
          .catch((err) => {
            ocrStartedFor.current = null;
            setError(err instanceof Error ? err.message : "Could not extract invoice");
          })
          .finally(() => setOcrBusy(false));
      }
      return;
    }
    if (!image) {
      ocrStartedFor.current = invoice.id;
      return;
    }

    ocrStartedFor.current = invoice.id;
    setOcrBusy(true);
    void ocrImage(image, { engine: getOcrEngine() })
      .then(async (ocr) => {
        setOcrText(ocr.text);
        setOcrNote(ocrEngineNote(ocr));
        if (ocr.warning) setError(ocr.warning);
        await applyPreview(ocr.text, true, image, ocr.confidence);
      })
      .catch((err) => {
        ocrStartedFor.current = null;
        setError(err instanceof Error ? err.message : "Could not read invoice photo");
      })
      .finally(() => setOcrBusy(false));
  }, [
    open,
    invoice,
    media.isLoading,
    media.data,
    restaurants,
    restaurantAliases,
    vendorAliases,
    skuAliases,
    accountRules,
    extractExamples,
    photoSrc,
    qbConnections,
    qbVendors,
    qbAccounts,
  ]);

  const totals = useMemo(
    () => invoiceTotals(lines, tax, extractTotal),
    [lines, tax, extractTotal],
  );

  if (!invoice) return null;

  const scopedAccounts = accountsForConnection(
    connectionIdForInvoiceAccounts(restaurantId || null, qbConnections),
    qbAccounts,
  );
  const scopedApAccounts = apAccountsForSelect(scopedAccounts);
  const pageImages = composeInvoicePageImages(media.data, pagesQuery.data ?? []);
  const currentPage = pageImages[pageIndex] ?? pageImages[0];
  const displaySrc = currentPage?.image_data ?? photoSrc ?? media.data?.image_data;

  const persist = async (status: "reviewed" | "exported", exportedAt?: string) => {
    setError(null);
    try {
      await save.mutateAsync({
        invoice,
        lines,
        expenses,
        restaurant_id: restaurantId || null,
        supplier_id: supplierId || null,
        vendor_name: qbVendorName || vendorName || null,
        invoice_number: number,
        invoice_date: date,
        due_date: due,
        terms,
        tax,
        subtotal: totals.subtotal,
        total: totals.total,
        ap_account: apAccount,
        status,
        exported_at: exportedAt ?? null,
        ...(ocrText !== null ? { ocr_text: ocrText } : {}),
      });
    } catch (err) {
      setError(toThrownError(err, "Could not save invoice").message);
      throw err;
    }
  };

  const vendor =
    qbVendorName.trim() ||
    suppliers.find((s) => s.id === supplierId)?.name ||
    invoice.suppliers?.name ||
    invoice.vendor_name ||
    "Unknown vendor";

  const exportPayload = {
    vendor,
    invoiceNumber: number || invoice.id.slice(0, 8),
    invoiceDate: date || new Date().toISOString().slice(0, 10),
    dueDate: due || date || new Date().toISOString().slice(0, 10),
    terms,
    apAccount,
    expenses,
    total: totals.total,
  };

  const books = restaurants.find((r) => r.id === restaurantId);
  const filePrefix = books ? `${restaurantFileSlug(books)}-` : "";

  const exportIif = async () => {
    downloadText(
      `${filePrefix}qbd-bill-${exportPayload.invoiceNumber}.iif`,
      toQuickBooksBillIif(exportPayload),
      "text/plain",
    );
    await persist("exported", new Date().toISOString());
    onOpenChange(false);
  };

  const canSendToQb =
    Boolean(restaurantId) &&
    Boolean(vendor.trim()) &&
    expenses.some((line) => Number.isFinite(line.amount) && line.amount !== 0 && line.account.trim());
  const qbLocked = qbJob?.status === "pending" || qbJob?.status === "sending" || qbJob?.status === "completed";

  const sendToQuickBooks = async () => {
    if (!canSendToQb) {
      setError("Select a restaurant, vendor, and at least one expense line with an amount.");
      return;
    }
    setQbBusy(true);
    try {
      await persist("reviewed");
      await sendInvoiceToQuickBooks(invoice.id);
      onQbJobChange?.();
    } catch (err) {
      setError(toThrownError(err, "Could not send invoice to QuickBooks").message);
    } finally {
      setQbBusy(false);
    }
  };

  const exportCsv = async () => {
    downloadText(
      `${filePrefix}qbd-bill-${exportPayload.invoiceNumber}.csv`,
      toQuickBooksBillCsv(exportPayload),
      "text/csv",
    );
    await persist("exported", new Date().toISOString());
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && lightboxOpen) {
          setLightboxOpen(false);
          return;
        }
        onOpenChange(next);
      }}
      title={invoice.invoice_number ? `Bill ${invoice.invoice_number}` : "Review invoice"}
      description="Confirm SKUs and the QuickBooks Desktop Expenses tab, then Send to QuickBooks or export IIF."
      className="max-h-[92vh] w-[min(1100px,calc(100vw-1.5rem))] overflow-y-auto"
    >
      <div className="grid gap-4 lg:grid-cols-2">
        {media.isLoading ? (
          <div className="grid min-h-40 place-items-center rounded-xl border border-line text-sm text-muted">
            Loading photo…
          </div>
        ) : displaySrc ? (
          <InvoiceReviewPhotoColumn>
            <button
              type="button"
              className="relative w-full cursor-pointer rounded-xl text-left"
              aria-label="Click to zoom"
              onClick={() => setLightboxOpen(true)}
            >
              <img
                src={displaySrc}
                alt="Invoice photo"
                className="pointer-events-none max-h-80 w-full rounded-xl border border-line bg-paper object-contain"
              />
              <span className="absolute bottom-2 left-2 rounded-lg bg-navy/70 px-2 py-1 text-xs text-white">
                Click to zoom
              </span>
            </button>
            <InvoicePhotoLightbox
              open={lightboxOpen}
              src={displaySrc}
              onClose={() => setLightboxOpen(false)}
              pageLabel={pageImages.length > 1 ? `Page ${pageIndex + 1} / ${pageImages.length}` : null}
              onPrevPage={
                pageImages.length > 1
                  ? () => setPageIndex((index) => (index - 1 + pageImages.length) % pageImages.length)
                  : undefined
              }
              onNextPage={
                pageImages.length > 1
                  ? () => setPageIndex((index) => (index + 1) % pageImages.length)
                  : undefined
              }
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                ref={addPageInput}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (!file || !invoice) return;
                  void (async () => {
                    try {
                      assertInvoiceImage(file);
                      const { data, mime } = await fileToDataUrl(file);
                      await addPage.mutateAsync({
                        orgId: invoice.org_id,
                        invoiceId: invoice.id,
                        sortOrder: nextInvoicePageSortOrder(pagesQuery.data ?? []),
                        image_data: data,
                        image_mime: mime,
                      });
                      setPageIndex(pageImages.length);
                    } catch (err) {
                      setError(toThrownError(err, "Could not add page").message);
                    }
                  })();
                }}
              />
              <Button
                variant="outline"
                type="button"
                disabled={addPage.isPending || save.isPending}
                onClick={() => addPageInput.current?.click()}
              >
                Add page
              </Button>
              {pageImages.length > 1 ? (
                <p className="text-xs text-muted">
                  Page {pageIndex + 1} of {pageImages.length}
                </p>
              ) : null}
            </div>
          </InvoiceReviewPhotoColumn>
        ) : (
          <div className="grid min-h-40 place-items-center rounded-xl border border-line text-sm text-muted">
            No photo attached
          </div>
        )}
        <div className="grid gap-2">
          <Field label="Restaurant / QBO books" htmlFor="inv-rest">
            <Select id="inv-rest" value={restaurantId} onChange={(e) => setRestaurantId(e.target.value)}>
              <option value="">Select restaurant</option>
              {restaurants.map((restaurant) => (
                <option key={restaurant.id} value={restaurant.id}>
                  {restaurant.name} · {restaurant.qbo_company_name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="QuickBooks vendor" htmlFor="inv-qb-vendor">
            <Select
              id="inv-qb-vendor"
              value={qbVendorName}
              onChange={(e) => {
                const name = e.target.value;
                setQbVendorName(name);
                const supplier = suppliers.find((row) => row.name === name);
                if (supplier) setSupplierId(supplier.id);
              }}
            >
              <option value="">Select vendor</option>
              {Array.from(
                new Set([
                  ...vendorOptions,
                  ...vendorsForConnection(
                    connectionIdForInvoiceVendors(restaurantId || null, qbConnections),
                    qbVendors,
                  ).map((row) => row.full_name),
                  ...suppliers.map((row) => row.name),
                  ...(qbVendorName ? [qbVendorName] : []),
                ]),
              ).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Print name" htmlFor="inv-print">
            <Input id="inv-print" value={vendorName} onChange={(e) => setVendorName(e.target.value)} />
          </Field>
          <Field label="Ref No." htmlFor="inv-no">
            <Input id="inv-no" value={number} onChange={(e) => setNumber(e.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Date" htmlFor="inv-date">
              <Input id="inv-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="Due" htmlFor="inv-due">
              <Input id="inv-due" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            </Field>
          </div>
          <Field label="Terms" htmlFor="inv-terms">
            <Input id="inv-terms" value={terms} onChange={(e) => setTerms(e.target.value)} />
          </Field>
        </div>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <div>
          <h3 className="mb-2 text-sm font-semibold">SKU lines</h3>
          <div className="space-y-2">
            {lines.map((line, i) => (
              <div key={`${line.code ?? "sku"}-${i}`} className="grid grid-cols-1 gap-1.5 sm:grid-cols-12">
                <Input
                  className="min-w-0 sm:col-span-5"
                  value={line.description}
                  onChange={(e) =>
                    setLines((rows) =>
                      rows.map((r, idx) => (idx === i ? { ...r, description: e.target.value } : r)),
                    )
                  }
                />
                <Input
                  className="min-w-0 sm:col-span-2"
                  type="number"
                  title="Qty shipped (Desp)"
                  value={line.qty_shipped}
                  onChange={(e) =>
                    setLines((rows) =>
                      rows.map((r, idx) => {
                        if (idx !== i) return r;
                        const qty_shipped = Number(e.target.value);
                        return { ...r, qty_shipped, amount: qty_shipped * r.unit_price };
                      }),
                    )
                  }
                />
                <Input
                  className="min-w-0 sm:col-span-2"
                  type="number"
                  value={line.amount}
                  onChange={(e) =>
                    setLines((rows) =>
                      rows.map((r, idx) => (idx === i ? { ...r, amount: Number(e.target.value) } : r)),
                    )
                  }
                />
                <Select
                  className="min-w-0 sm:col-span-2"
                  value={line.category}
                  onChange={(e) =>
                    setLines((rows) =>
                      rows.map((r, idx) =>
                        idx === i ? { ...r, category: e.target.value as InvoiceCategory } : r,
                      ),
                    )
                  }
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
                <Button
                  variant="subtle"
                  className="sm:col-span-1 px-2"
                  onClick={() => setLines((rows) => rows.filter((_, idx) => idx !== i))}
                >
                  ×
                </Button>
              </div>
            ))}
            <Button
              variant="ghost"
              onClick={() =>
                setLines((rows) => [
                  ...rows,
                  {
                    code: null,
                    description: "",
                    qty_ordered: 0,
                    qty_shipped: 1,
                    uom: "CS",
                    pounds: null,
                    unit_price: 0,
                    amount: 0,
                    category: "food",
                  },
                ])
              }
            >
              Add SKU
            </Button>
          </div>
        </div>

        <div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">QuickBooks expenses</h3>
            <Button
              variant="subtle"
              onClick={() =>
                setExpenses(
                  applyQbAccountNames(
                    expensesFromLinesOrExtract(lines, tax, { total: extractTotal, expenses: [] }),
                    scopedAccounts,
                  ),
                )
              }
            >
              Recalc rollup
            </Button>
          </div>
          <div className="space-y-2">
            {expenses.map((line, i) => (
              <div key={`${line.account}-${i}`} className="grid grid-cols-1 gap-1.5 sm:grid-cols-12">
                <InvoiceReviewAccountField
                  className="min-w-0 sm:col-span-6"
                  accounts={scopedAccounts}
                  value={line.account}
                  onChange={(account) =>
                    setExpenses((rows) =>
                      rows.map((r, idx) => (idx === i ? { ...r, account } : r)),
                    )
                  }
                />
                <Input
                  className="min-w-0 sm:col-span-3"
                  type="number"
                  value={line.amount}
                  onChange={(e) =>
                    setExpenses((rows) =>
                      rows.map((r, idx) => (idx === i ? { ...r, amount: Number(e.target.value) } : r)),
                    )
                  }
                />
                <Input
                  className="min-w-0 sm:col-span-3"
                  value={line.memo}
                  onChange={(e) =>
                    setExpenses((rows) =>
                      rows.map((r, idx) => (idx === i ? { ...r, memo: e.target.value } : r)),
                    )
                  }
                />
              </div>
            ))}
          </div>
          {scopedApAccounts.length > 0 ? (
            <div className="mt-2">
              <Field label="A/P account" htmlFor="inv-ap">
                <InvoiceReviewAccountField
                  id="inv-ap"
                  className="min-w-0"
                  accounts={scopedApAccounts}
                  value={apAccount}
                  onChange={setApAccount}
                />
              </Field>
              <p className="mt-2 text-xs text-muted">Desktop Bill · Expenses tab only</p>
            </div>
          ) : (
            <p className="mt-2 text-xs text-muted">
              Desktop Bill · A/P {apAccount} · Expenses tab only
            </p>
          )}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
        <Field label="Tax (Municipal + PR Territory)" htmlFor="inv-tax">
          <Input
            id="inv-tax"
            type="number"
            value={tax}
            onChange={(e) => setTax(Number(e.target.value))}
          />
        </Field>
        <div>
          <p className="mb-1.5 text-xs text-muted">Subtotal</p>
          <p className="py-2">{formatMoney(totals.subtotal)}</p>
        </div>
        <div>
          <p className="mb-1.5 text-xs text-muted">Total</p>
          <p className="py-2 font-semibold">{formatMoney(totals.total)}</p>
        </div>
      </div>

      {ocrBusy ? (
        <p className="mt-3 text-sm text-muted">
          {getOcrEngine() === "tesseract" ? "Reading with Tesseract…" : "Reading with Vision…"}
        </p>
      ) : (
        <>
          {ocrNote ? <p className="mt-3 text-sm text-muted">{ocrNote}</p> : null}
          {vendorOptions.length > 1 && !qbVendorName ? (
            <p className="mt-3 text-sm text-muted">
              Mixed food and liquor — pick the QuickBooks vendor ({vendorOptions.join(" or ")}).
            </p>
          ) : null}
        </>
      )}

      {ocrText || media.data?.ocr_text ? (
        <details className="mt-3 text-xs text-muted">
          <summary>OCR text</summary>
          <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap">
            {ocrText || media.data?.ocr_text}
          </pre>
        </details>
      ) : null}

      {qbJob ? (
        <p className="mt-3 text-sm text-muted">
          QuickBooks: {invoiceQbJobLabel(qbJob, invoice.quickbooks_txn_id ?? qbJob.quickbooks_txn_id)}
        </p>
      ) : null}
      {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button
          variant="danger"
          className="mr-auto"
          disabled={save.isPending || addPage.isPending || remove.isPending || ocrBusy || qbBusy}
          onClick={() => {
            const vendor = vendorName || invoice.suppliers?.name || invoice.vendor_name;
            const detail = [vendor, number || invoice.invoice_number].filter(Boolean).join(" · ");
            if (!window.confirm(detail ? `Delete this invoice? ${detail}` : "Delete this invoice?")) {
              return;
            }
            void remove.mutateAsync(invoice.id).then(
              () => onOpenChange(false),
              (err: unknown) => {
                setError(err instanceof Error ? err.message : "Could not delete invoice");
              },
            );
          }}
        >
          Delete
        </Button>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Close
        </Button>
        <Button
          variant="ghost"
          disabled={save.isPending || addPage.isPending || ocrBusy || qbBusy}
          onClick={() => void persist("reviewed")}
        >
          Save review
        </Button>
        <Button
          variant="ghost"
          disabled={save.isPending || addPage.isPending || ocrBusy || qbBusy}
          onClick={() => void exportCsv()}
        >
          Export CSV
        </Button>
        <Button
          variant="ghost"
          disabled={save.isPending || addPage.isPending || ocrBusy || qbBusy}
          onClick={() => void exportIif()}
        >
          Export Desktop IIF
        </Button>
        <Button
          disabled={
            save.isPending || addPage.isPending || ocrBusy || qbBusy || !canSendToQb || qbLocked
          }
          onClick={() => void sendToQuickBooks()}
        >
          Send to QuickBooks
        </Button>
      </div>
    </Dialog>
  );
}
