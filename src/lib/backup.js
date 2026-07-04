// JSON and XLSX backup / restore for all shop data.
// XLSX is multi-sheet and human-readable in Excel. Products are flattened to one row per
// size/colour VARIANT (grouped back by product id on import); sales are flattened to one row
// per line item (grouped by Bill ID) and reconstructed on import.
import * as XLSX from "xlsx";

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// ---- JSON ----
export function exportJson(data, filename) {
  const blob = new Blob(
    [JSON.stringify({ ...data, exportedAt: new Date().toISOString() }, null, 2)],
    {
      type: "application/json",
    }
  );
  triggerDownload(blob, filename);
}

// ---- XLSX ----
export function exportXlsx({ items, sales, expenses, logs, vendorBills, dailyBills }, filename) {
  const wb = XLSX.utils.book_new();

  // Products → one row per variant (so each row carries the full product context + variant stock).
  const productRows = [];
  (items || []).forEach((p) => {
    const variants = (p.variants || []).length ? p.variants : [{}];
    variants.forEach((v) => {
      productRows.push({
        productId: p.id,
        name: p.name,
        brand: p.brand || "",
        category: p.category || "",
        subcategory: p.subcategory || "",
        code: p.code || "",
        purchasePrice: p.purchasePrice ?? "",
        sellingPrice: p.sellingPrice ?? "",
        mrp: p.mrp ?? "",
        discountPct: p.discountPct ?? "",
        supplier: p.supplier || "",
        imageUrl: p.imageUrl || "",
        notes: p.notes || "",
        size: v.size || "",
        color: v.color || "",
        variantSku: v.sku || "",
        stockQty: v.stockQty ?? "",
        lowAt: v.lowAt ?? "",
        createdAt: p.createdAt || "",
        updatedAt: p.updatedAt || "",
      });
    });
  });
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      productRows.length
        ? productRows
        : [
            {
              productId: "",
              name: "",
              brand: "",
              category: "",
              subcategory: "",
              code: "",
              purchasePrice: "",
              sellingPrice: "",
              mrp: "",
              discountPct: "",
              supplier: "",
              imageUrl: "",
              notes: "",
              size: "",
              color: "",
              variantSku: "",
              stockQty: "",
              lowAt: "",
              createdAt: "",
              updatedAt: "",
            },
          ]
    ),
    "Products"
  );

  const saleRows = [];
  (sales || []).forEach((s) =>
    (s.lines || []).forEach((l) =>
      saleRows.push({
        billId: s.id,
        date: s.date,
        time: s.time,
        item: l.name,
        size: l.size || "",
        color: l.color || "",
        qty: l.qty,
        price: l.price,
        amount: l.amount,
        billTotal: s.total,
        billProfit: s.profit,
        payment: s.payment || "",
      })
    )
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      saleRows.length
        ? saleRows
        : [
            {
              billId: "",
              date: "",
              time: "",
              item: "",
              size: "",
              color: "",
              qty: "",
              price: "",
              amount: "",
              billTotal: "",
              billProfit: "",
              payment: "",
            },
          ]
    ),
    "Sales"
  );

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      expenses && expenses.length ? expenses : [{ id: "", date: "", desc: "", amount: "" }]
    ),
    "Expenses"
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      logs && logs.length ? logs : [{ id: "", at: "", date: "", time: "", type: "", message: "" }]
    ),
    "Logs"
  );

  const bills = vendorBills || [];
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      bills.length
        ? bills.map((b) => ({
            id: b.id,
            vendor: b.vendor,
            date: b.date,
            amount: b.amount,
            category: b.category || "",
            status: b.status || "",
            paidAmount: b.paidAmount ?? "",
            dueDate: b.dueDate || "",
            fileName: b.fileName || "",
            fileURL: b.fileURL || "",
            filePath: b.filePath || "",
            source: b.source || "",
          }))
        : [
            {
              id: "",
              vendor: "",
              date: "",
              amount: "",
              category: "",
              status: "",
              paidAmount: "",
              dueDate: "",
              fileName: "",
              fileURL: "",
              filePath: "",
              source: "",
            },
          ]
    ),
    "VendorBills"
  );

  const daily = dailyBills || [];
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      daily.length
        ? daily.map((b) => ({
            id: b.id,
            vendorName: b.vendorName,
            date: b.date,
            billAmount: b.billAmount,
            paymentMethod: b.paymentMethod || "",
            paymentStatus: b.paymentStatus || "",
            paidAmount: b.paidAmount ?? "",
            category: b.category || "",
            itemName: b.itemName || "",
            qty: b.qty ?? "",
            unitPrice: b.unitPrice ?? "",
            billNumber: b.billNumber || "",
            notes: b.notes || "",
            createdAt: b.createdAt ?? "",
            updatedAt: b.updatedAt ?? "",
          }))
        : [
            {
              id: "",
              vendorName: "",
              date: "",
              billAmount: "",
              paymentMethod: "",
              paymentStatus: "",
              paidAmount: "",
              category: "",
              itemName: "",
              qty: "",
              unitPrice: "",
              billNumber: "",
              notes: "",
              createdAt: "",
              updatedAt: "",
            },
          ]
    ),
    "DailyBills"
  );

  XLSX.writeFile(wb, filename);
}

export async function importXlsx(file) {
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const sheet = (name) =>
    wb.Sheets[name] ? XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: "" }) : [];

  // Rebuild products by grouping the flattened variant rows on productId (falling back to name).
  const prodMap = new Map();
  sheet("Products").forEach((r) => {
    if (!String(r.name || "").trim()) return;
    const key = r.productId || rid();
    if (!prodMap.has(key)) {
      prodMap.set(key, {
        id: key,
        name: String(r.name).trim(),
        brand: String(r.brand || ""),
        category: r.category || "Clothing",
        subcategory: r.subcategory || "",
        code: String(r.code || ""),
        purchasePrice: num(r.purchasePrice),
        sellingPrice: num(r.sellingPrice),
        mrp: num(r.mrp),
        discountPct: num(r.discountPct),
        supplier: String(r.supplier || ""),
        imageUrl: String(r.imageUrl || ""),
        notes: String(r.notes || ""),
        createdAt: r.createdAt || "",
        updatedAt: r.updatedAt || "",
        variants: [],
      });
    }
    const p = prodMap.get(key);
    if (String(r.size || "").trim() || String(r.color || "").trim() || r.stockQty !== "") {
      p.variants.push({
        id: rid(),
        size: String(r.size || "").trim(),
        color: String(r.color || "").trim(),
        sku: String(r.variantSku || ""),
        stockQty: num(r.stockQty),
        lowAt: num(r.lowAt) || 2,
      });
    }
  });
  const items = [...prodMap.values()];

  // Rebuild bills by grouping flattened Sales rows on billId.
  const billMap = new Map();
  sheet("Sales").forEach((r) => {
    if (!r.billId) return;
    if (!billMap.has(r.billId))
      billMap.set(r.billId, {
        id: r.billId,
        date: r.date,
        time: r.time,
        lines: [],
        total: num(r.billTotal),
        profit: num(r.billProfit),
        payment: r.payment || "",
      });
    billMap
      .get(r.billId)
      .lines.push({
        name: r.item,
        size: r.size || "",
        color: r.color || "",
        qty: num(r.qty),
        price: num(r.price),
        amount: num(r.amount),
      });
  });
  const sales = [...billMap.values()];

  const expenses = sheet("Expenses")
    .filter((r) => String(r.desc || "").trim())
    .map((r) => ({ id: r.id || rid(), date: r.date, desc: String(r.desc), amount: num(r.amount) }));

  const logs = sheet("Logs")
    .filter((r) => r.type)
    .map((r) => ({
      id: r.id || rid(),
      at: num(r.at),
      date: r.date,
      time: r.time,
      type: r.type,
      message: r.message,
    }));

  const vendorBills = sheet("VendorBills")
    .filter((r) => String(r.vendor || "").trim() || r.fileURL)
    .map((r) => ({
      id: r.id || rid(),
      vendor: String(r.vendor || "").trim(),
      date: r.date,
      amount: num(r.amount),
      category: r.category || "",
      status: r.status || "unpaid",
      paidAmount: num(r.paidAmount),
      dueDate: r.dueDate || "",
      fileName: r.fileName || "",
      fileURL: r.fileURL || "",
      filePath: r.filePath || "",
      ...(r.source === "daily-need" ? { source: "daily-need", sourceId: r.sourceId || r.id } : {}),
    }));

  const dailyBills = sheet("DailyBills")
    .filter((r) => String(r.vendorName || "").trim())
    .map((r) => ({
      id: r.id || rid(),
      vendorName: String(r.vendorName || "").trim(),
      date: r.date,
      billAmount: num(r.billAmount),
      paymentMethod: r.paymentMethod || "Cash",
      paymentStatus: r.paymentStatus || "Paid",
      paidAmount: num(r.paidAmount),
      category: r.category || "Other",
      itemName: r.itemName || "",
      qty: num(r.qty),
      unitPrice: num(r.unitPrice),
      billNumber: r.billNumber || "",
      notes: r.notes || "",
      createdAt: num(r.createdAt) || "",
      updatedAt: num(r.updatedAt) || "",
      source: "daily-need",
    }));

  return { items, sales, expenses, logs, vendorBills, dailyBills };
}

function rid() {
  return Math.random().toString(36).slice(2, 10);
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
