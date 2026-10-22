"""Run against ui-timeouts-server.mjs; uses only its isolated *_test database.

Store/Admin use the production web build. Driver uses real React Native screen
components rendered with React Native Web, not an Android/iOS emulator.
"""
import argparse
import json
import subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument("--chromium", help="Optional installed Chromium executable")
args = parser.parse_args()
base = "http://127.0.0.1:3106"
out = Path(".verification/step6/ui")
out.mkdir(parents=True, exist_ok=True)
driver_texts = json.loads(subprocess.check_output([
    "node", "--input-type=module", "-e",
    "import {translations} from './driver-app/translations.js'; console.log(JSON.stringify(translations));"
], text=True, encoding="utf-8"))

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, **({"executable_path": args.chromium} if args.chromium else {}))
    api = p.request.new_context(base_url=base)
    web_texts = api.get("/__test/translations").json()
    def request(path, token=None, body=None, status=200):
        response = api.fetch("/api" + path, method="POST" if body is not None else "GET", data=body,
                             headers={"Authorization": "Bearer " + token} if token else {})
        assert response.status == status, f"{path}: {response.status} != {status}"
        return response.json()
    sessions = {name: request("/auth/login", body={"login": name, "password": "WaselhaDemo123!"})
                for name in ["store1", "admin", "driver1", "driver2"]}
    store, admin, driver1, driver2 = [sessions[name]["token"] for name in ["store1", "admin", "driver1", "driver2"]]
    errors = []
    def watch(page):
        page.on("pageerror", lambda error: errors.append(str(error)))
        return page
    def check(page, name):
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), name + " overflow"
        assert page.evaluate("getComputedStyle(document.documentElement).direction") == "rtl"
        assert "MISSING:" not in page.locator("body").inner_text()
        page.screenshot(path=str(out / (name + ".png")), full_page=True)
    def order_view(o):
        return request("/orders/" + o["_id"], store)
    def expire(o, kind):
        assert api.post("/__test/expire/" + kind + "/" + o["_id"]).ok
    def create(area):
        return request("/orders", store, {"area": area, "customerPhone": "0501234567", "parcelReady": True,
                                         "parcelDescription": "Sealed test box", "goodsAmountAgorot": 1000}, 201)
    def post(o, action, token=driver1, body=None, status=200):
        return request("/orders/" + o["_id"] + "/" + action, token, {} if body is None else body, status)

    for index, language in enumerate(["ar", "he"]):
        assert api.post("/__test/reset").ok
        t = lambda key: web_texts[key][index]
        dt = lambda key: driver_texts[key][index]
        context = browser.new_context(viewport={"width": 375, "height": 900})
        context.add_init_script(f'localStorage.setItem("waselha.language", "{language}"); localStorage.setItem("waselha.token", {json.dumps(store)}); sessionStorage.setItem("driverToken", {json.dumps(driver1)});')
        page = watch(context.new_page())
        page.goto(base + "/store")
        page.wait_for_load_state("networkidle")
        # A: create in the store UI, expire, retry same order, accept in driver UI.
        page.get_by_role("button", name=t("requestDriver"), exact=True).click()
        page.get_by_label(t("area")).fill("UI no driver " + language)
        with page.expect_response(lambda r: r.url.endswith("/api/orders") and r.request.method == "POST") as placed:
            page.get_by_role("button", name=t("requestDriver"), exact=True).last.click()
        a = placed.value.json()
        expire(a, "search")
        assert all(o["_id"] != a["_id"] for o in request("/driver/orders/available", driver1))
        page.get_by_role("button", name=t("refresh"), exact=True).click()
        expect(page.get_by_text(t("noDriverFound"), exact=True).first).to_be_visible()
        check(page, "store-no-driver-" + language)
        with page.expect_response(lambda r: r.url.endswith("/retry-search")) as retried:
            page.get_by_role("button", name=t("retrySearch"), exact=True).click()
        assert retried.value.json()["_id"] == a["_id"]
        available = watch(context.new_page())
        available.goto(base + "/__test/driver?screen=available&language=" + language)
        expect(available.get_by_role("button", name=dt("accept"), exact=True)).to_be_visible()
        check(available, "available-" + language)
        available.get_by_role("button", name=dt("accept"), exact=True).click()
        expect(available.get_by_text(dt("busyHint"), exact=True)).to_be_visible()
        current = watch(context.new_page())
        current.goto(base + "/__test/driver?screen=current&language=" + language)
        expect(current.get_by_text(dt("storeArrivalDeadlineAt"), exact=True)).to_be_visible()
        # B: no arrival releases assignment, frees the driver, searches again.
        expire(a, "arrival")
        current.reload()
        expect(current.get_by_text(dt("noCurrent"), exact=True)).to_be_visible()
        page.get_by_role("button", name=t("refresh"), exact=True).click()
        expect(page.get_by_text(t("assignmentExpiredSearching"), exact=True)).to_be_visible()
        check(page, "store-released-" + language)
        post(a, "accept", driver1, status=409)
        post(a, "accept", driver2)
        # C: arriving prevents release, even when the stored deadline expires.
        c = create("UI arrived " + language)
        post(c, "accept")
        current.reload()
        current.get_by_role("button", name=dt("trip.slideArrival"), exact=True).focus()
        current.keyboard.press("Enter")
        expect(current.get_by_role("button", name=dt("enterPickupCode"), exact=True)).to_be_visible()
        expire(c, "arrival")
        assert order_view(c)["activeAssignment"]
        # D: real reason controls, optional note, withdrawal, exclusions, new driver.
        current.get_by_role("button", name=dt("trip.help"), exact=True).click()
        current.get_by_role("button", name=dt("withdrawOrder"), exact=True).click()
        expect(current.get_by_role("button", name=dt("confirmWithdrawal"), exact=True)).to_be_disabled()
        current.get_by_role("radio", name=dt("withdrawal.other"), exact=True).click()
        expect(current.get_by_role("radio", name=dt("withdrawal.other"), exact=True)).to_be_checked()
        current.get_by_label(dt("withdrawalNote")).fill("UI withdrawal " + language)
        check(current, "current-reason-" + language)
        current.get_by_role("button", name=dt("confirmWithdrawal"), exact=True).click()
        expect(current.get_by_text(dt("noCurrent"), exact=True)).to_be_visible()
        available.reload()
        expect(available.get_by_text(dt("empty"), exact=True)).to_be_visible()
        post(c, "accept", driver1, status=409)
        # Driver 2 is busy on A; free it through existing admin cancellation.
        request("/admin/orders/" + a["_id"] + "/cancel", admin, {"reason": "isolated test cleanup"})
        post(c, "accept", driver2)
        request("/admin/orders/" + c["_id"] + "/cancel", admin, {"reason": "isolated test cleanup"})
        # Store safe cancellation from no-driver.
        cancel = create("UI cancel " + language)
        expire(cancel, "search")
        page.get_by_role("button", name=t("back"), exact=True).click()
        page.get_by_role("button", name=t("refresh"), exact=True).click()
        page.get_by_role("row").filter(has_text=cancel["_id"][-6:]).get_by_role("button", name=t("open"), exact=True).click()
        page.get_by_role("button", name=t("cancelOrder"), exact=True).click()
        expect(page.get_by_text(t("status.cancelled"), exact=True)).to_be_visible()
        # E: full normal flow through real driver screen actions.
        e = create("UI delivery " + language)
        customer_token = e["customerLink"].split("/")[-1]
        request("/customer/" + customer_token + "/location", body={"lat": 32.75, "lng": 35.35, "address": "Isolated destination", "source": "pin"})
        cv = request("/customer/" + customer_token)
        request("/customer/" + customer_token + "/confirm", body={"observed": cv["confirmationSnapshot"], "recipientName": "UI recipient", "finalAddress": "Isolated destination"})
        post(e, "accept")
        for token in [store, driver1]:
            view = request("/orders/" + e["_id"], token)
            post(e, "confirm", token, {"observed": view["confirmationSnapshot"]})
        current.reload()
        current.get_by_role("button", name=dt("trip.slideArrival"), exact=True).focus()
        current.keyboard.press("Enter")
        current.get_by_role("button", name=dt("enterPickupCode"), exact=True).click()
        current.get_by_role("textbox", name=dt("enterPickupCode"), exact=True).fill(e["pickupCode"])
        current.get_by_role("button", name=dt("trip.continue"), exact=True).click()
        current.get_by_role("button", name=dt("trip.slidePickup"), exact=True).focus()
        current.keyboard.press("Enter")
        expect(current.get_by_role("button", name=dt("withdrawOrder"), exact=True)).to_have_count(0)
        current.get_by_role("button", name=dt("trip.slideArrival"), exact=True).focus()
        current.keyboard.press("Enter")
        expect(current.get_by_label(dt("trip.requestCode"))).to_be_visible()
        view = order_view(e)
        current.get_by_label(dt("actualCash")).fill(str(view["expectedCustomerCashAgorot"] / 100))
        current.get_by_label(dt("trip.requestCode")).fill(request("/customer/" + customer_token)["deliveryCode"])
        expect(current.get_by_text(dt("trip.verified"), exact=True)).to_be_visible()
        check(current, "current-delivery-" + language)
        current.get_by_role("button", name=dt("trip.slideDelivery"), exact=True).focus()
        current.keyboard.press("Enter")
        expect(current.get_by_text(dt("noCurrent"), exact=True)).to_be_visible()
        assert order_view(e)["status"] == "delivered"
        # Admin sees persisted reason and arrival history in existing details.
        admin_context = browser.new_context(viewport={"width": 375, "height": 900})
        admin_context.add_init_script(f'localStorage.setItem("waselha.language", "{language}"); localStorage.setItem("waselha.token", {json.dumps(admin)});')
        admin_page = watch(admin_context.new_page())
        admin_page.goto(base + "/admin")
        admin_page.get_by_role("row").filter(has_text=c["_id"][-6:]).get_by_role("button", name=t("open"), exact=True).click()
        admin_page.get_by_text(t("operationalHistory"), exact=True).click()
        expect(admin_page.get_by_text("UI withdrawal " + language, exact=False)).to_be_visible()
        check(admin_page, "admin-history-" + language)
        print(language + ": flows A/B/C/D/E, store retry/cancel, driver reason/pickup gates, admin history, RTL at 375px PASS")
        admin_context.close()
        context.close()
    assert not errors, errors
    print("0 page errors. Driver browser shim verified; native devices remain a separate pilot check.")
    browser.close()
