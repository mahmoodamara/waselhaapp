import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { createCustomerTracker, trackingDisplay } from "./customerTracking.js";

export function useCustomerTracking(token, status, onOrderChanged) {
  const [value, setValue] = useState(null), [connected, setConnected] = useState(false), [error, setError] = useState(null);
  const [clock, setClock] = useState(0);
  const changed = useRef(onOrderChanged), tracker = useRef(null);
  changed.current = onOrderChanged;
  useEffect(() => {
    let disposed = false;
    setValue(null); setConnected(false); setError(null);
    import("socket.io-client").then(({ io }) => {
      if (disposed) return;
      tracker.current = createCustomerTracker({ token, api, createSocket: io,
        onSnapshot: snapshot => { setValue({ snapshot, at: performance.now() }); setError(null); },
        onOrderChanged: event => changed.current(event), onConnection: setConnected, onError: setError });
    }).catch(() => { if (!disposed) setError("trackingReconnect"); });
    return () => { disposed = true; tracker.current?.stop(); tracker.current = null; };
  }, [token]);
  useEffect(() => {
    if (!value?.snapshot.location) return;
    const timer = setInterval(() => setClock(performance.now()), 1000);
    return () => clearInterval(timer);
  }, [value]);
  // An authoritative REST terminal state clears a marker even if its Socket
  // termination was lost. A stale REST response cannot enable GPS by itself.
  const snapshot = value && (!status || status === value.snapshot.status ? value.snapshot :
    { ...value.snapshot, status, location: null });
  return { ...trackingDisplay(snapshot, connected, value ? Math.max(clock, performance.now()) - value.at : 0),
    error, refresh: () => tracker.current?.refresh() };
}
