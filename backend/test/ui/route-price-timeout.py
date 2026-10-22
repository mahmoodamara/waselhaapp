"""Slow OSRM recovery must show the final total and enable customer consent."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

base = "http://127.0.0.1:3109"
output = Path(".verification/route-price-timeout")
output.mkdir(parents=True, exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    http = p.request.new_context(base_url=base)
    def api(path, token=None, body=None, method="GET"):
        response = http.fetch("/api" + path, method=method, data=body,
                              headers={"Authorization": "Bearer " + token} if token else {})
        assert response.ok, f"{method} request failed: {response.status}"
        return response.json()
    store = api("/auth/login", body={"login": "store1", "password": "WaselhaDemo123!"}, method="POST")["token"]
    texts = http.get("/__test/translations").json()
    checks, errors = [], []
    for index, language in enumerate(["ar", "he"]):
        t = lambda key: texts[key][index]
        order = api("/orders", store, {"area": "Test", "serviceArea": "kafr-kanna", "deliveryFeePaidBy": "customer",
            "customerPhone": "0501234567", "recipientName": "Test", "finalAddress": "Test address",
            "parcelDescription": "Box", "parcelReady": True, "goodsAmountAgorot": 12000}, "POST")
        path = "/customer/" + order["customerLink"].split("/")[-1]
        http.post("/__test/fail")
        pending = api(path + "/location", body={"lat": 32.7459, "lng": 35.3398, "address": "Test destination", "source": "pin"}, method="POST")
        assert pending["priceStatus"] == "pending" and pending["routeError"] == "routing_unavailable"
        context = browser.new_context(viewport={"width": 375, "height": 900})
        context.add_init_script(f'localStorage.setItem("waselha.language", {json.dumps(language)});')
        context.route("https://tile.openstreetmap.org/**", lambda route: route.abort())
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(base + path)
        confirm = page.get_by_role("button", name=t("confirmDetails"), exact=True)
        expect(confirm).to_be_disabled()
        http.post("/__test/zero")
        with page.expect_response(lambda response: response.request.method == "POST" and response.url.endswith(path + "/location"), timeout=35000) as response_info:
            page.get_by_role("button", name=t("retryRoutePrice"), exact=True).click()
        priced = response_info.value.json()
        assert priced["priceStatus"] == "final" and priced["expectedCustomerCashAgorot"] == 13500
        expect(confirm).to_be_enabled()
        expect(page.get_by_role("region", name=t("amountSummary"))).to_contain_text("135.00")
        assert not api(path)["customerConfirmed"], "Pricing must not confirm for the customer"
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
        page.screenshot(path=str(output / f"customer-{language}.png"), full_page=True)
        checks.append({"language": language, "finalPrice": True, "confirmEnabled": True, "customerConfirmed": False})
        print(f"PASS {language}: delayed final total appears and confirmation is enabled")
        context.close()
    assert not errors, errors
    (output / "results.json").write_text(json.dumps({"checks": checks, "browserErrors": errors}, indent=2), encoding="utf-8")
    browser.close()
