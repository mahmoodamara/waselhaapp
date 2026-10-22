"""Mobile Arabic/Hebrew regression: provider recovery, order pickup correction and consent."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

base = "http://127.0.0.1:3109"
output = Path(".verification/route-recovery")
output.mkdir(parents=True, exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    http = p.request.new_context(base_url=base)
    def api(path, token=None, body=None, method="GET"):
        r = http.fetch("/api" + path, method=method, data=body,
                       headers={"Authorization": "Bearer " + token} if token else {})
        assert r.ok, f"{method} {path}: {r.status} {r.text()}"
        return r.json()
    sessions = {role: api("/auth/login", body={"login": role, "password": "WaselhaDemo123!"}, method="POST")
                for role in ["store1", "driver1"]}
    store, driver = sessions["store1"]["token"], sessions["driver1"]["token"]
    texts = http.get("/__test/translations").json()
    errors = []
    for index, language in enumerate(["ar", "he"]):
        t = lambda key: texts[key][index]
        def page_for(path, token=None):
            ctx = browser.new_context(viewport={"width": 375, "height": 900})
            ctx.add_init_script(f'localStorage.setItem("waselha.language", {json.dumps(language)});' +
                                (f'localStorage.setItem("waselha.token", {json.dumps(token)});' if token else ""))
            ctx.route("https://tile.openstreetmap.org/**", lambda r: r.abort())
            page = ctx.new_page()
            page.set_default_timeout(10000)
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(base + path)
            page.wait_for_load_state("networkidle")
            return page
        o = api("/orders", store, {"area": "Test", "serviceArea": "kafr-kanna", "deliveryFeePaidBy": "customer",
            "customerPhone": "0501234567", "recipientName": "Test", "finalAddress": "Test address",
            "parcelDescription": "Box", "parcelReady": True, "goodsAmountAgorot": 12000}, "POST")
        customer_path = "/customer/" + o["customerLink"].split("/")[-1]
        http.post("/__test/fail")
        api(customer_path + "/location", body={"lat": 32.7459, "lng": 35.3398, "address": "Test destination", "source": "pin"}, method="POST")
        customer = page_for(customer_path)
        confirm = customer.get_by_role("button", name=t("confirmDetails"), exact=True)
        expect(confirm).to_be_disabled()
        http.post("/__test/zero")
        customer.get_by_role("button", name=t("retryRoutePrice"), exact=True).click()
        expect(customer.get_by_text(t("routeZeroDistance"), exact=True)).to_be_visible()
        expect(confirm).to_be_enabled()
        confirm.click()
        expect(customer.get_by_text(t("confirmed"), exact=True)).to_be_visible()
        shop = page_for("/store/orders/" + o["_id"], store)
        shop.get_by_role("button", name=t("m.correctPickup"), exact=True).click()
        expect(shop.get_by_role("heading", name=t("pickupLocation"), exact=True)).to_be_visible()
        shop.route("**/api/maps/reverse?**", lambda route: route.fulfill(json={"label": "Correct store entrance"}))
        shop.get_by_label(t("searchAddress"), exact=True).fill("Correct store entrance")
        shop.route("**/api/maps/search?**", lambda route: route.fulfill(json=[{"lat": 32.746, "lng": 35.34, "label": "Correct store entrance"}]))
        shop.get_by_role("button", name=t("searchButton"), exact=True).click()
        shop.get_by_role("button", name="Correct store entrance", exact=True).click()
        http.post("/__test/route")
        shop.get_by_role("button", name=t("confirmLocation"), exact=True).click()
        expect(shop.get_by_text("1500 " + t("meters"), exact=False)).to_be_visible()
        current = api("/orders/" + o["_id"], store)
        assert current["deliveryFeeAgorot"] == 3000 and not current["customerConfirmed"]
        assert current["pickupLocation"]["lng"] == 35.34
        customer.reload()
        customer.get_by_role("button", name=t("confirmDetails"), exact=True).click()
        expect(customer.get_by_text(t("confirmed"), exact=True)).to_be_visible()
        api("/orders/" + o["_id"] + "/accept", driver, {}, "POST")
        api("/orders/" + o["_id"] + "/arrive-store", driver, {}, "POST")
        shop.reload()
        shop.get_by_role("button", name=t("m.confirmAction"), exact=True).click()
        current = api("/orders/" + o["_id"], driver)
        api("/orders/" + o["_id"] + "/confirm", driver, {"observed": current["confirmationSnapshot"]}, "POST")
        current = api("/orders/" + o["_id"], store)
        assert current["missingRequirements"] == []
        api("/orders/" + o["_id"] + "/pickup", driver, {"code": current["pickupCode"]}, "POST")
        api("/orders/" + o["_id"] + "/arrive-customer", driver, {}, "POST")
        public = api(customer_path)
        api("/orders/" + o["_id"] + "/deliver", driver,
            {"code": public["deliveryCode"], "actualCashCollectedAgorot": 15000, "observedExpectedAgorot": 15000}, "POST")
        for name, page in [("customer", customer), ("store", shop)]:
            assert page.evaluate("document.documentElement.dir === 'rtl'")
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), page.url
            page.screenshot(path=str(output / f"{name}-{language}.png"), full_page=True)
            page.context.close()
        print(f"PASS {language}: recovery, zero meters, pickup correction, confirmations, pickup and delivery at 375px")
    assert not errors, errors
    browser.close()
