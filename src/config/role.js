// Who is using the app (feature "staffAccounts"): "owner" | "staff" | "none".
//
// With the feature off there are no roles — everyone who can sign in is the owner, as before.
// The role comes from shop/users/<uid>/role; the security rules (database.rules.json) are what
// actually enforce it. This module only decides what the app SHOWS.
import { createContext, useContext } from "react";

export const RoleContext = createContext("owner");
export const useRole = () => useContext(RoleContext);
export const useIsStaff = () => useContext(RoleContext) === "staff";

// The tabs a staff member gets: bill, look up stock, see bills, take credit repayments.
// No Dashboard / Reports (profit), no expenses or vendor bills, no Settings / Admin.
export const STAFF_TABS = ["billing", "inventory", "sales", "udhari", "alerts"];

// What a staff account may subscribe to (the rules deny the rest).
export const STAFF_SLICES = ["items", "sales"];

// From the result of sync.readOwnUser(uid):
//   { value: { role: "staff" } }   → staff
//   { value: null, owner: true }   → owner (no entry, but can read the shop)
//   { value: { role: "owner" } }   → owner
//   { denied: true } / anything else → none (signed in, but not part of this shop)
export function roleFrom(result) {
  if (!result || result.denied) return "none";
  const role = result.value && result.value.role;
  if (role === "staff") return "staff";
  if (role === "owner" || result.owner) return "owner";
  return "none";
}
