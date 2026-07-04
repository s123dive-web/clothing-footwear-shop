// Vendor-bill proof files live in Firebase Storage under shop/bills/<billId>/<file>.
// Only small metadata (vendor, date, amount, the download URL + storage path) is kept in
// the Realtime Database; the file bytes never touch the DB / localStorage / backups.
import { ref as sRef, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";
import { storage } from "../config/firebase.js";

// Max proof size (10 MB) — keeps uploads quick and storage tidy.
export const MAX_PROOF_BYTES = 10 * 1024 * 1024;

// Accepted proof types (broad: images, pdf, office docs, text).
export const PROOF_ACCEPT =
  ".jpg,.jpeg,.png,.webp,.gif,.bmp,.heic,.pdf,.doc,.docx,.xls,.xlsx,.txt,.csv";

// Strip anything risky from a filename so the storage path stays clean.
const safeName = (name) =>
  String(name || "file")
    .replace(/[^\w.-]+/g, "_")
    .slice(-80);

// Upload a proof file for a bill; returns the metadata to store on the record.
export async function uploadBillProof(billId, file) {
  const path = `shop/bills/${billId}/${Date.now()}_${safeName(file.name)}`;
  const r = sRef(storage, path);
  await uploadBytes(r, file, { contentType: file.type || "application/octet-stream" });
  const url = await getDownloadURL(r);
  return {
    fileURL: url,
    filePath: path,
    fileName: file.name,
    fileType: file.type || "",
    fileSize: file.size || 0,
  };
}

// Best-effort delete of a stored proof (ignore "not found" so deleting a bill never blocks).
export async function deleteBillProof(filePath) {
  if (!filePath) return;
  try {
    await deleteObject(sRef(storage, filePath));
  } catch (e) {
    if (e?.code !== "storage/object-not-found") console.error("proof delete failed", e);
  }
}
