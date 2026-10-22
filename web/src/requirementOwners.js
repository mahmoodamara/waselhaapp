// Pure UI-side grouping of the server's missingRequirements keys by who can act on them.
// The server keeps returning a flat string array unchanged; this never touches the API contract.
export const requirementOwners = {
  fee_required: "store",
  fee_payer_required: "store",
  financial_terms_required: "store",
  parcel_details_required: "store",
  parcel_not_ready: "store",
  customer_details_required: "store",
  store_confirmation_required: "store",
  customer_confirmation_required: "customer",
  destination_location_required: "customer",
  driver_required: "system",
  driver_confirmation_required: "driver",
  route_price_required: "system",
  pickup_location_required: "store",
  goods_amount_required: "driver",
  store_authorization_required: "store",
};
export const ownerOrder = ["store", "customer", "driver", "system"];
export function groupRequirements(keys, workflowVersion = 1) {
  const groups = { store: [], customer: [], driver: [], system: [] };
  for (const key of keys) groups[workflowVersion === 2 && key === "customer_details_required"
    ? "customer" : requirementOwners[key] || "system"].push(key);
  return groups;
}
