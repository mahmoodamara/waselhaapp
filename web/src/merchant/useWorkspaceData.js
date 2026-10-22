import { useCallback, useEffect, useRef, useState } from "react";
import { api, newRequestId } from "../api.js";

export default function useWorkspaceData() {
  const [orders, setOrders] = useState(null),
    [error, setError] = useState(null),
    [updatedAt, setUpdatedAt] = useState(null);
  const [refreshing, setRefreshing] = useState(false),
    [online, setOnline] = useState(navigator.onLine);
  const [permissions, setPermissions] = useState(null),
    [permissionError, setPermissionError] = useState(null);
  const [mutation, setMutation] = useState(null);
  const loading = useRef(false),
    mounted = useRef(true),
    generation = useRef(0),
    lock = useRef(false),
    operations = useRef(new Map());
  const refresh = useCallback(async () => {
    if (loading.current) return null;
    loading.current = true;
    const version = generation.current;
    setRefreshing(true);
    try {
      const data = await api("/orders");
      if (mounted.current && version === generation.current) {
        setOrders(data);
        setError(null);
        setUpdatedAt(new Date());
      }
      return data;
    } catch (e) {
      if (mounted.current) setError(e);
      return null;
    } finally {
      loading.current = false;
      if (mounted.current) setRefreshing(false);
    }
  }, []);
  const loadPermissions = useCallback(() => {
    setPermissionError(null);
    api("/store/permissions").then(
      (p) => {
        if (mounted.current) setPermissions(p);
      },
      (e) => {
        if (mounted.current) setPermissionError(e);
      },
    );
  }, []);
  useEffect(() => {
    mounted.current = true;
    refresh();
    loadPermissions();
    const connected = () => {
        setOnline(true);
        refresh();
        loadPermissions();
      },
      disconnected = () => setOnline(false);
    const visible = () => {
      if (!document.hidden && !lock.current) refresh();
    };
    window.addEventListener("online", connected);
    window.addEventListener("offline", disconnected);
    document.addEventListener("visibilitychange", visible);
    const timer = setInterval(() => {
      if (!document.hidden && navigator.onLine && !lock.current) refresh();
    }, 10000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      window.removeEventListener("online", connected);
      window.removeEventListener("offline", disconnected);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh, loadPermissions]);
  const update = useCallback((order) => {
    generation.current++;
    setOrders((current) => {
      const previous = current?.find((o) => o._id === order._id);
      if (previous?.updatedAt && order.updatedAt && previous.updatedAt > order.updatedAt)
        return current;
      return current
        ? [order, ...current.filter((o) => o._id !== order._id)].sort((a, b) =>
            b.createdAt.localeCompare(a.createdAt),
          )
        : [order];
    });
  }, []);
  const mutate = useCallback(
    async (order, path, body = {}, propagateError = false) => {
      if (lock.current) return null;
      lock.current = true;
      generation.current++;
      setMutation({ busy: true, orderId: order._id, path });
      const key = `${order._id}:${path}:${order.updatedAt}`;
      if (!operations.current.has(key)) operations.current.set(key, newRequestId());
      try {
        const result = await api(`/orders/${order._id}/${path}`, {
          method: "POST",
          body: {
            ...body,
            ...(["retry-search", "customer-link/reissue"].includes(path)
              ? { requestId: operations.current.get(key) }
              : {}),
          },
        });
        // Reissue returns a partial representation; merge it with this order.
        const saved = path === "customer-link/reissue" ? { ...order, ...result } : result;
        update(saved);
        setMutation({ busy: false, orderId: order._id, success: true });
        operations.current.delete(key);
        return saved;
      } catch (e) {
        const unknown = ["network_error", "request_timeout"].includes(e.code) || e.status >= 500;
        if (unknown || e.status === 409) {
          try {
            update(await api(`/orders/${order._id}`));
          } catch {}
        }
        setMutation({ busy: false, orderId: order._id, error: e, unknown });
        if (e.status === 401 || e.status === 403) {
          setPermissions(null);
          setPermissionError(e);
        }
        if (propagateError) throw e;
        return null;
      } finally {
        lock.current = false;
      }
    },
    [update],
  );
  const act = useCallback(
    (task) => {
      const routes = { retry: "retry-search", fare: "recalculate-price", confirm: "confirm", ready: "readiness" };
      return mutate(
        task.order,
        routes[task.kind],
        task.kind === "ready" ? { ready: true, observed: task.order.confirmationSnapshot }
          : task.kind === "confirm" ? { observed: task.order.confirmationSnapshot } : {},
      );
    },
    [mutate],
  );
  return {
    orders,
    error,
    refreshing,
    updatedAt,
    online,
    refresh,
    update,
    permissions,
    permissionError,
    loadPermissions,
    mutation,
    mutate,
    act,
    setMutation,
  };
}
