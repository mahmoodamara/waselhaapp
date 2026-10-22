import { Link } from "react-router-dom";
import { useLanguage } from "../components/UI.jsx";
import { Icon, PageTitle, useCopy, useWorkspace } from "./components.jsx";

// The phone's account tab: everything the sidebar and its account menu hold on a computer.
export default function Account() {
  const { c, t, language } = useCopy(),
    { setLanguage } = useLanguage(),
    { me, logout, permissions, taskCount } = useWorkspace();
  const area = me.pickupServiceArea ? t(`serviceArea.${me.pickupServiceArea}`) : "";
  return (
    <>
      <PageTitle title={c("myAccount")} />
      <section className="mw-card mw-account-card">
        <span className="mw-store-icon">
          <Icon name="store" />
        </span>
        <div>
          <strong>
            <bdi>{me.storeName || me.name}</bdi>
          </strong>
          <small>{area || <bdi>{me.name}</bdi>}</small>
        </div>
      </section>
      <section className="mw-card mw-menu-list">
        <Link to="/store/settings">
          <Icon name="sliders" />
          <span>{c("settings")}</span>
          <Icon name="chevron" size={18} />
        </Link>
        {permissions?.viewSettlements && (
          <Link to="/store/settlements">
            <Icon name="money" />
            <span>{c("settlements")}</span>
            <Icon name="chevron" size={18} />
          </Link>
        )}
        <Link to="/store/notifications">
          <Icon name="bell" />
          <span>{c("notifications")}</span>
          {taskCount > 0 && <span className="mw-count">{taskCount}</span>}
          <Icon name="chevron" size={18} />
        </Link>
        <Link to="/store/help">
          <Icon name="help" />
          <span>{c("help")}</span>
          <Icon name="chevron" size={18} />
        </Link>
        <button
          className="mw-menu-button"
          onClick={() => setLanguage(language === "ar" ? "he" : "ar")}
        >
          <Icon name="globe" />
          <span>{c("changeLanguage")}</span>
          <span className="mw-menu-value" lang={language === "ar" ? "he" : "ar"}>
            {language === "ar" ? "עברית" : "العربية"}
          </span>
        </button>
      </section>
      <button className="quiet mw-logout" onClick={logout}>
        <Icon name="logout" />
        {t("logout")}
      </button>
    </>
  );
}
