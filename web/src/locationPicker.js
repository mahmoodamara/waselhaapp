// Pure state for the location picker. Whatever the customer or store selects is
// only a *candidate*; it becomes a saved location solely through an explicit
// confirm request, and the server alone decides when it was confirmed.
export const initialState = { candidate: null, locating: false, notice: "" };

const place = (lat, lng, address, source) => ({ lat, lng, address, source });

export function pickerReducer(state, action) {
  switch (action.type) {
    case "gps-start":
      return { ...state, locating: true, notice: "" };
    case "gps-success":
      return {
        candidate: {
          ...place(action.lat, action.lng, "", "gps"),
          ...(Number.isFinite(action.accuracy) && action.accuracy > 0 ? { accuracy: action.accuracy } : {}),
        },
        locating: false,
        notice: "",
      };
    case "gps-error":
      // The page stays usable: search and the pin are still available.
      return {
        ...state,
        locating: false,
        notice: action.insecure ? "locationSecureRequired" : action.denied ? "locationPermissionDenied"
          : action.timeout ? "locationTimedOut" : "locationUnavailable",
      };
    case "search-pick":
      return {
        candidate: place(action.lat, action.lng, action.label, "search"),
        locating: false,
        notice: "",
      };
    case "pin-move":
      // The old address described another spot, so it is dropped.
      return {
        ...state,
        candidate: place(action.lat, action.lng, "", "pin"),
        locating: false,
        notice: "",
      };
    case "address-resolved":
      // A slow lookup for an earlier position must not label the current one.
      return state.candidate &&
        state.candidate.lat === action.lat &&
        state.candidate.lng === action.lng
        ? { ...state, candidate: { ...state.candidate, address: action.label } }
        : state;
    case "reset":
      return initialState;
    default:
      return state;
  }
}
export const canConfirm = (candidate, confirmed) =>
  !!candidate &&
  !(
    confirmed &&
    confirmed.lat === candidate.lat &&
    confirmed.lng === candidate.lng &&
    (confirmed.address ?? "") === candidate.address &&
    confirmed.source === candidate.source
  );
export const confirmBody = ({ lat, lng, address, source }) => ({
  lat,
  lng,
  address,
  source,
});
