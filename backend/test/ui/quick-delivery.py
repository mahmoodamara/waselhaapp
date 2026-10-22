"""Mobile Arabic/Hebrew: quick dispatch, customer consent and real driver components.
Uses ui-finance-server.mjs with a disposable local *_test database.
"""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

base = "http://127.0.0.1:3108"
out = Path(".verification/quick-delivery")
out.mkdir(parents=True, exist_ok=True)
with sync_playwright() as p:
    expect.set_options(timeout=20000)
    browser = p.chromium.launch(headless=True)
    http = p.request.new_context(base_url=base)
    def api(path, token=None, body=None, method="GET", status=200):
        r = http.fetch("/api" + path, method=method, data=body,
                       headers={"Authorization": "Bearer " + token} if token else {})
        assert r.status == status, f"{method} {path}: {r.status} {r.text()}"
        return r.json()
    store = api("/auth/login", body={"login": "store1", "password": "WaselhaDemo123!"}, method="POST")["token"]
    admin = api("/auth/login", body={"login": "admin", "password": "WaselhaDemo123!"}, method="POST")["token"]
    texts = http.get("/__test/translations").json()
    errors = []
    for index, language in enumerate(["ar", "he"]):
        t = lambda key: texts["web"][key][index]
        d = lambda key: texts["driver"][key][index]
        contexts = []
        def page_for(path, token=None):
            ctx = browser.new_context(viewport={"width": 375, "height": 900})
            contexts.append(ctx)
            ctx.add_init_script(f'localStorage.setItem("waselha.language", {json.dumps(language)});' +
                                (f'localStorage.setItem("waselha.token", {json.dumps(token)});' if token else ""))
            ctx.route("https://tile.openstreetmap.org/**", lambda r: r.abort())
            page = ctx.new_page()
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(base + path)
            page.wait_for_load_state("networkidle")
            return page
        # Clearing a vehicle must persist, including after reopening the account form.
        login = "vehicle-clear-" + language
        account = api("/admin/accounts", admin, {"role": "driver", "login": login,
            "name": "Vehicle clear regression", "password": "VehicleClear123!",
            "serviceAreas": ["kafr-kanna"], "vehicleType": "car"}, "POST", 201)
        admin_page = page_for("/admin", admin)
        admin_page.get_by_role("button", name=t("accounts"), exact=True).click()
        row = admin_page.get_by_role("row").filter(has=admin_page.get_by_role("cell", name=login, exact=True))
        row.get_by_role("button", name=t("edit"), exact=True).click()
        vehicle = admin_page.get_by_role("combobox", name=t("vehicleType"), exact=True)
        expect(vehicle).to_have_value("car")
        vehicle.select_option("")
        with admin_page.expect_response(lambda r: r.url.endswith("/admin/accounts/" + account["_id"]) and r.request.method == "PATCH") as cleared:
            admin_page.get_by_role("button", name=t("save"), exact=True).click()
        assert cleared.value.status == 200
        assert cleared.value.json()["vehicleType"] is None, "The vehicle was not cleared"
        expect(admin_page.get_by_role("combobox", name=t("vehicleType"), exact=True)).to_have_count(0)
        row.get_by_role("button", name=t("edit"), exact=True).click()
        expect(admin_page.get_by_role("combobox", name=t("vehicleType"), exact=True)).to_have_value("")
        shop = page_for("/store/settings", store)
        if index == 0:
            shop.get_by_role("combobox", name=t("pickupServiceArea"), exact=True).select_option("kafr-kanna")
            shop.get_by_role("button", name=t("savePickupServiceArea"), exact=True).click()
            expect(shop.get_by_role("button", name=t("savePickupServiceArea"), exact=True)).to_be_disabled()
        shop.goto(base + "/store/new")
        expect(shop.get_by_role("combobox", name=t("deliveryArea"), exact=True)).to_have_value("kafr-kanna")
        # The store enters four things: area, vehicle, size and goods only (never customer data).
        assert shop.get_by_role("textbox").count() == 1
        request_button = shop.get_by_role("button", name=t("requestDriver"), exact=True)
        expect(request_button).to_be_disabled()  # vehicle and goods are still missing
        shop.get_by_role("radio", name=t("size.large"), exact=True).check()
        expect(shop.get_by_role("radio", name=t("vehicle.car"), exact=True)).to_be_checked()  # no prior vehicle choice
        expect(shop.get_by_role("radio", name=t("vehicle.motorcycle"), exact=True)).to_be_disabled()  # large needs a car
        goods = "100" if index == 0 else "0"
        shop.get_by_label(t("goodsValueOnly"), exact=True).fill(goods)
        expect(shop.locator(".qr-fee")).to_be_visible()  # fee box: estimate, or "calculated after the customer picks a place"
        expect(shop.locator(".qr-fee .money")).to_have_text("15.00 ₪")
        expect(shop.locator(".qr-fee")).to_contain_text(t("estimateNotice"))
        if index == 0:
            # Server creates the order, but its response is lost. Reloading and
            # retrying must recover the same order from the persisted operation.
            lost = {}
            def lose_response(route):
                if route.request.method == "POST" and not lost:
                    lost.update(route.fetch().json())
                    route.abort()
                else:
                    route.continue_()
            shop.route("**/api/orders", lose_response)
            shop.get_by_role("button", name=t("requestDriver"), exact=True).click()
            expect(shop.get_by_text(t("network_error"), exact=True)).to_be_visible()
            shop.unroute("**/api/orders", lose_response)
            shop.reload()
            expect(shop.get_by_text(t("quickRequestRecovery"), exact=True)).to_be_visible()
        with shop.expect_response(lambda r: r.url.endswith("/api/orders") and r.request.method == "POST") as created:
            shop.get_by_role("button", name=t("requestDriver"), exact=True).click()
        o = created.value.json()
        if index == 0:
            assert o["_id"] == lost["_id"]
            assert len(api("/orders", store)) == 1
        expect(shop.locator('a[href*="wa.me"]')).to_have_count(0)
        customer_path = "/customer/" + o["customerLink"].split("/")[-1]
        assert o["vehicleType"] == "car" and o["parcelSize"] == "large"
        assert o["goodsAmountAgorot"] == int(goods) * 100
        customer = page_for(customer_path)
        # Step 1 is a map with the pin in the middle; the phone's own position is one tap away.
        expect(customer.locator(".cu-stage")).to_be_visible()
        gps = customer.get_by_role("button", name=t("useMyLocation"), exact=True)
        expect(gps).to_be_visible()
        confirm_place = customer.get_by_role("button", name=t("confirmPlace"), exact=True)
        expect(confirm_place).to_be_disabled()  # nothing is chosen on the customer's behalf
        assert confirm_place.evaluate("e => getComputedStyle(e).backgroundColor") != "rgba(0, 0, 0, 0)"
        # Location comes first: the details only unlock a single final action later.
        customer.route("**/api/customer/*/maps/search?**", lambda r: r.fulfill(json=[{
            "lat": 32.75, "lng": 35.35, "label": "Customer entrance"
        }]))
        customer.get_by_role("button", name=t("searchAddress"), exact=True).click()
        customer.get_by_label(t("searchAddress"), exact=True).fill("Customer entrance")
        customer.get_by_role("button", name=t("searchButton"), exact=True).click()
        customer.get_by_role("button", name="Customer entrance", exact=True).click()
        confirm_place.click()
        expect(customer.get_by_role("heading", name=t("stepDetailsTitle"), exact=True)).to_be_visible()
        expect(customer.get_by_label(t("recipientName"), exact=True)).to_have_count(0)
        customer.get_by_label(t("customerPhone"), exact=True).fill("٠٥٠١٢٣٤٥٦٧")
        total = api(customer_path)["expectedCustomerCashAgorot"]
        expect(customer.locator(".cu-total dd")).to_have_text(f"{total / 100:.2f} ₪")  # the total as a receipt
        expect(customer.locator(".cu-summary > div")).to_have_count(3)
        assert total == int(goods) * 100 + 3000  # goods + final fee (1500 m by road)
        confirm = customer.get_by_role("button", name=t("confirmOrderTotal").replace("{amount}", f"{total / 100:.2f} ₪"), exact=True)
        expect(confirm).to_be_enabled()  # the one and only financial confirmation
        # "Ready now / later" is part of that one confirmation; "ready now" is the default.
        expect(customer.get_by_role("group", name=t("whenReceive"), exact=True)).to_be_visible()
        expect(customer.get_by_role("radio", name=t("receiveNow"), exact=True)).to_be_checked()
        # No driver is looked for while the customer is still filling in the page.
        assert api("/orders/" + o["_id"], store)["dispatchState"] == "waiting_customer"
        customer.get_by_label(t("deliveryInstructions"), exact=False).fill("Keep this text during polling")
        expect(customer.get_by_role("textbox", name=t("deliveryInstructions"), exact=False)).to_have_value("Keep this text during polling")
        # A failed confirmation reports next to the button that caused it, in view, not at the page top.
        customer.route("**/api/customer/*/confirm", lambda r: r.fulfill(status=500, json={"code": "server_error"}), times=1)
        confirm.click()
        failure = customer.get_by_role("alert").filter(has_text=t("server_error"))
        expect(failure).to_be_visible()
        expect(failure).to_be_in_viewport()
        assert abs(failure.bounding_box()["y"] - confirm.bounding_box()["y"]) < 250, "result must sit beside its button"
        if index == 1:
            # "Later": the total is confirmed, no driver is searched, the store sees why.
            customer.get_by_role("radio", name=t("receiveLater"), exact=True).check()
            expect(customer.get_by_text(t("receiveLaterHint"), exact=True)).to_be_visible()
            confirm.click()
            expect(customer.get_by_role("heading", name=t("trackLater"), exact=True)).to_be_visible()
            assert api("/orders/" + o["_id"], store)["dispatchState"] == "customer_later"
            shop.goto(base + "/store/orders/" + o["_id"])
            # Store copy (merchant/copy.js) is not in the shared table this fixture serves.
            later_title = {"ar": "الطلب جاهز — بانتظار الزبون", "he": "ההזמנה מוכנה — ממתינה ללקוח"}[language]
            expect(shop.get_by_role("heading", name=later_title, exact=True)).to_be_visible()
            customer.screenshot(path=str(out / f"customer-later-{language}.png"), full_page=True)
            # "I am ready now" starts the search without confirming the total again.
            customer.get_by_role("button", name=t("readyNow"), exact=True).click()
            expect(customer.get_by_role("heading", name=t("trackSearching"), exact=True)).to_be_visible()
        else:
            confirm.click()
        expect(customer.get_by_role("list", name=t("tripProgress"), exact=True)).to_be_visible()
        assert api("/orders/" + o["_id"], store)["dispatchState"] == "searching"
        if index == 0:
            # The store changes the invoice after confirmation: the confirmation is voided and the
            # customer sees the new total and confirms once more. The search pauses meanwhile.
            current = api("/orders/" + o["_id"], store)
            api("/orders/" + o["_id"], store, {"goodsAmountAgorot": 12000, "observed": current["confirmationSnapshot"]}, "PATCH")
            assert api("/orders/" + o["_id"], store)["dispatchState"] == "waiting_customer"
            total = 12000 + 3000
            # This fixture has no Socket.IO, so the page would only notice on its 30 s poll.
            customer.get_by_role("button", name=t("refresh"), exact=True).first.click()
            expect(customer.get_by_text(t("totalChanged"), exact=True)).to_be_visible()
            again = customer.get_by_role("button", name=t("confirmOrderTotal").replace("{amount}", f"{total / 100:.2f} ₪"), exact=True)
            again.click()
            expect(customer.get_by_role("list", name=t("tripProgress"), exact=True)).to_be_visible()
        # Only now, with everything final and the customer ready, does a driver get the offer.
        mobile = page_for("/__test/driver")
        if language == "he": mobile.get_by_role("button", name="العربية / עברית", exact=True).click()
        mobile.get_by_label(d("loginName"), exact=True).fill("driver1")
        mobile.get_by_label(d("password"), exact=True).fill("WaselhaDemo123!")
        mobile.get_by_role("button", name=d("signInAction"), exact=True).click()
        expect(mobile.get_by_role("button", name=d("acceptOffer"), exact=True)).to_be_visible()
        mobile.screenshot(path=str(out / f"driver-available-{language}.png"), full_page=True)
        mobile.get_by_role("button", name=d("acceptOffer"), exact=True).click()
        # The trip is shown one stage at a time, with the tab bar below.
        expect(mobile.get_by_text(d("sheet.toStore"), exact=True)).to_be_visible()
        expect(mobile.get_by_role("tab", name=d("summary"), exact=True)).to_be_visible()
        # The arrival step is explicit, and the driver has no invoice entry.
        mobile.get_by_role("button", name=d("trip.slideArrival"), exact=True).focus()
        mobile.keyboard.press("Enter")
        expect(mobile.get_by_role("button", name=d("trip.slidePickup"), exact=True)).to_be_visible()
        expect(mobile.get_by_text(d("trip.checkBeforeLeaving"), exact=True)).to_be_visible()
        ready = api("/orders/" + o["_id"], store)
        expect(shop.locator('a[href*="wa.me"]')).to_have_count(0)
        shop.goto(base + "/store/orders/" + o["_id"])
        expect(shop.get_by_text(ready["pickupCode"], exact=True)).to_be_visible()
        pickup = mobile.get_by_role("button", name=d("trip.slidePickup"), exact=True)
        mobile.get_by_role("button", name=d("enterPickupCode"), exact=True).click()
        mobile.get_by_role("textbox", name=d("enterPickupCode"), exact=True).fill(ready["pickupCode"])
        mobile.get_by_role("button", name=d("trip.continue"), exact=True).click()
        expect(pickup).to_be_enabled()
        for name, page in [("customer", customer), ("store", shop), ("driver", mobile)]:
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), page.url
            page.screenshot(path=str(out / f"{name}-{language}.png"), full_page=True)
        pickup.focus()
        mobile.keyboard.press("Enter")
        expect(mobile.get_by_text(d("trip.toCustomer"), exact=True)).to_be_visible()
        mobile.get_by_role("button", name=d("trip.slideArrival"), exact=True).focus()
        mobile.keyboard.press("Enter")
        expect(mobile.get_by_label(d("trip.requestCode"), exact=True)).to_be_visible()
        expect(mobile.get_by_role("button", name=d("trip.call"), exact=True)).to_be_visible()
        expect(customer.get_by_role("heading", name=t("deliveryCodeTitle"), exact=True)).to_be_visible()
        public = api(customer_path)
        mobile.get_by_label(d("trip.requestCode"), exact=True).fill(public["deliveryCode"])
        expect(mobile.get_by_text(d("trip.verified"), exact=True)).to_be_visible()
        amount = public["expectedCustomerCashAgorot"]
        if index == 1:
            mobile.get_by_role("button", name=d("trip.help"), exact=True).click()
            mobile.get_by_role("button", name=d("differentAmount"), exact=True).click()
            mobile.get_by_role("textbox", name=d("actualCash"), exact=True).last.fill("29")
            mobile.get_by_role("button", name=d("trip.continue"), exact=True).click()
            amount = 2900
        money = f"{amount / 100:.2f} ₪"
        button = mobile.get_by_role("button", name=d("trip.slideDelivery"), exact=True)
        if index == 1:
            button.focus()
            mobile.keyboard.press("Enter")
            button = mobile.get_by_role("button", name=d("confirmDifference"), exact=True)
        with mobile.expect_response(lambda r: r.url.endswith("/deliver") and r.request.method == "POST") as delivered:
            button.focus()
            mobile.keyboard.press("Enter")
        assert delivered.value.status == 200
        expect(mobile.get_by_label(d("trip.requestCode"), exact=True)).to_have_count(0)
        finished = api("/orders/" + o["_id"], store)
        assert finished["status"] == "delivered"
        assert finished["actualCashCollectedAgorot"] == amount
        # The finished trip shows in the activity summary for today (the run before it counts too).
        mobile.get_by_role("tab", name=d("summary"), exact=True).click()
        expect(mobile.get_by_text(d("activityTitle"), exact=True)).to_be_visible()
        expect(mobile.get_by_text(d("fromOneOrder") if index == 0 else d("fromOrders").replace("{n}", "2"), exact=True)).to_be_visible()
        expect(mobile.get_by_text("#" + o["_id"][-6:].upper(), exact=False).first).to_be_visible()
        expect(mobile.get_by_text(d("myUnpaid"), exact=True)).to_be_visible()  # earnings details are on the page itself
        mobile.screenshot(path=str(out / f"driver-summary-{language}.png"), full_page=True)
        mobile.get_by_role("button", name=d("showFinanceDetails"), exact=True).click()
        expect(mobile.get_by_text(d("handedOver"), exact=True)).to_be_visible()
        mobile.screenshot(path=str(out / f"driver-summary-details-{language}.png"), full_page=True)
        # The driver stays signed in across a restart: the token goes to secure storage on login,
        # is checked with the server on restore, and is forgotten when rejected or on logout.
        stored_key = "waselha.driver.token"
        saved_token = mobile.evaluate(f"window.__waselhaSecureStore.get({json.dumps(stored_key)})")
        assert saved_token, "login must store the token"
        def reopened(token):
            ctx = browser.new_context(viewport={"width": 375, "height": 900})
            contexts.append(ctx)
            ctx.add_init_script("window.__waselhaSecureStore = new Map(" + json.dumps(
                [[stored_key, token], ["waselha.driver.language", language]]) + ");")
            page = ctx.new_page()
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(base + "/__test/driver")
            return page
        restored = reopened(saved_token)
        restored.get_by_role("button", name=d("driverAccount"), exact=True).click()
        expect(restored.get_by_role("button", name=d("logout"), exact=True)).to_be_visible()
        expect(restored.get_by_label(d("loginName"), exact=True)).to_have_count(0)
        rejected = reopened("not-a-real-token")
        expect(rejected.get_by_label(d("loginName"), exact=True)).to_be_visible()
        assert rejected.evaluate(f"window.__waselhaSecureStore.has({json.dumps(stored_key)})") is False
        restored.get_by_role("button", name=d("logout"), exact=True).click()
        expect(restored.get_by_label(d("loginName"), exact=True)).to_be_visible()
        assert restored.evaluate(f"window.__waselhaSecureStore.has({json.dumps(stored_key)})") is False
        for ctx in contexts: ctx.close()
        print(f"PASS {language}: four-field request, WhatsApp, location first, one confirmation, store-only invoice, arrival, pickup and delivery at 375px")
    assert not errors, errors
    browser.close()
