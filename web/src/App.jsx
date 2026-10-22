import { useEffect, useState } from "react";
import { Link, Navigate, Route, Routes } from "react-router-dom";
import { api } from "./api.js";
import {
  Field,
  Header,
  Notice,
  useAction,
  useLanguage,
} from "./components/UI.jsx";
import Store from "./pages/Store.jsx";
import Admin from "./pages/Admin.jsx";
import Customer from "./pages/Customer.jsx";
import PublicInfo from './pages/PublicInfo.jsx';
function Login({ role, onLogin }) {
  const { t } = useLanguage(),
    action = useAction();
  const [login, setLogin] = useState(""),
    [password, setPassword] = useState("");
  function submit(e) {
    e.preventDefault();
    action.run(async () => {
      const result = await api("/auth/login", {
        method: "POST",
        body: { login, password },
      });
      if (result.user.role !== role)
        throw Object.assign(new Error("forbidden"), { code: "forbidden" });
      localStorage.setItem("waselha.token", result.token);
      onLogin(result.user);
    });
  }
  return (
    <div className="login-layout">
      <div className="login-intro">
        <span className="eyebrow">
          {t(role === "admin" ? "adminPortal" : "storePortal")}
        </span>
        <h1>{t("welcome")}</h1>
        <p>{t("loginHint")}</p>
        <span className="large-mark">↗</span>
      </div>
      <section className="panel login-panel">
        <h2>{t("login")}</h2>
        <Notice action={action} />
        <form noValidate onSubmit={submit}>
          <Field
            label="loginName"
            autoComplete="username"
            required
            value={login}
            dir="ltr"
            onChange={(e) => setLogin(e.target.value)}
          />
          <Field
            label="password"
            autoComplete="current-password"
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button disabled={action.busy}>{t("login")}</button>
        </form>
        <p><Link to="/privacy">سياسة الخصوصية / מדיניות פרטיות</Link> · <Link to="/support">الدعم / תמיכה</Link> · <Link to="/data-request">طلب بيانات / בקשת מידע</Link></p>
        {/* Development aids only: a live login does not advertise demo accounts or the other portal. */}
        {import.meta.env.DEV && (
          <>
            <p className="muted">{t("demoHint")}</p>
            <Link to={role === "admin" ? "/store" : "/admin"}>
              {t(role === "admin" ? "storePortal" : "adminPortal")}
            </Link>
          </>
        )}
      </section>
    </div>
  );
}
function Portal({ role, user, onLogin, logout }) {
  const { t } = useLanguage();
  if (role === "store" && user?.role === "store") return <Store user={user} logout={logout} />;
  return (
    <>
      <Header user={user} logout={logout} />
      <main>
        {!user ? (
          <Login role={role} onLogin={onLogin} />
        ) : user.role === "driver" ? (
          <p className="callout error">{t("forbidden")}</p>
        ) : user.role !== role ? (
          <Navigate to={user.role === "admin" ? "/admin" : "/store"} replace />
        ) : (
          <Admin />
        )}
      </main>
    </>
  );
}
export default function App() {
  const [user, setUser] = useState(null),
    [loading, setLoading] = useState(!!localStorage.getItem("waselha.token"));
  const { t } = useLanguage();
  useEffect(() => {
    if (!localStorage.getItem("waselha.token")) return;
    api("/auth/me")
      .then(setUser)
      .catch(() => {
        localStorage.removeItem("waselha.token");
      })
      .finally(() => setLoading(false));
  }, []);
  function logout() {
    // Forget the session and the drafts that hold customer names, phones and addresses right away
    // (language is kept), and revoke the token on the server with the token captured here, so a
    // quick sign-in as another account cannot be affected by the pending request.
    let token = null;
    try {
      token = localStorage.getItem("waselha.token");
      localStorage.removeItem("waselha.token");
      for (const store of [localStorage, sessionStorage])
        for (const key of Object.keys(store))
          if (/^waselha\.(drafts|quick-request|list|notifications)\./.test(key)) store.removeItem(key);
    } catch { /* storage unavailable */ }
    if (token) api("/auth/logout", { method: "POST", body: {}, headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    setUser(null);
  }
  if (loading && !['/privacy','/support','/data-request'].includes(window.location.pathname))
    return (
      <>
        <Header />
        <main>{t("loading")}</main>
      </>
    );
  return (
    <Routes>
      {['privacy','support','data-request'].map(page => <Route key={page} path={`/${page}`} element={<PublicInfo page={page} />} />)}
      <Route
        path="/store/*"
        element={
          <Portal role="store" user={user} onLogin={setUser} logout={logout} />
        }
      />
      <Route
        path="/admin/*"
        element={
          <Portal role="admin" user={user} onLogin={setUser} logout={logout} />
        }
      />
      <Route
        path="/customer/:token"
        element={
          <main className="cu-shell">
            <Customer />
          </main>
        }
      />
      <Route path="*" element={<Navigate to="/store" replace />} />
    </Routes>
  );
}
