"""Real built web + React Native browser harness + HTTP/Mongo/Redis, Arabic/Hebrew."""
import json
import re
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

base = "http://127.0.0.1:3108"
out = Path(".verification/workflow-v3")
out.mkdir(parents=True, exist_ok=True)
with sync_playwright() as p:
    expect.set_options(timeout=20000)
    browser = p.chromium.launch(headless=True)
    http = p.request.new_context(base_url=base)
    def api(path, token=None, body=None, method="GET", status=200):
        headers = {"x-waselha-workflow": "3"}
        if token: headers["Authorization"] = "Bearer " + token
        response = http.fetch("/api" + path, method=method, data=body, headers=headers)
        assert response.status == status, f"{method} {path}: {response.status} {response.text()}"
        return response.json()
    store = api("/auth/login", body={"login": "store1", "password": "WaselhaDemo123!"}, method="POST")["token"]
    api("/store/pickup-service-area", store, {"pickupServiceArea": "kafr-kanna"}, "PUT")
    texts = http.get("/__test/translations").json()
    errors = []
    for index, language in enumerate(["ar", "he"]):
        t = lambda key: texts["web"][key][index]
        d = lambda key: texts["driver"][key][index]
        contexts = []
        def page_for(path, token=None):
            ctx = browser.new_context(viewport={"width": 390, "height": 940},
                                      permissions=["geolocation"], geolocation={"latitude": 32.75, "longitude": 35.34})
            contexts.append(ctx)
            ctx.add_init_script(f'localStorage.setItem("waselha.language", {json.dumps(language)});' +
                                (f'localStorage.setItem("waselha.token", {json.dumps(token)});' if token else ""))
            ctx.route("https://tile.openstreetmap.org/**", lambda r: r.abort())
            page = ctx.new_page()
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(base + path)
            page.wait_for_load_state("networkidle")
            return page
        shop = page_for("/store/new", store)
        shop.evaluate('() => { window.open = () => { throw new Error("Unexpected sharing popup"); }; }')
        shop.get_by_label(t("customerPhone"), exact=True).fill("0501234567")
        shop.get_by_label(t("goodsValueOnly"), exact=True).fill("80")
        shop.get_by_label(t("goodsPaymentStatus"), exact=True).select_option("prepaid" if index else "unpaid")
        shop.get_by_role("radio", name=t("beingPrepared"), exact=True).check()
        for width in [360, 768, 1280]:
            shop.set_viewport_size({"width": width, "height": 940})
            assert shop.evaluate("document.documentElement.scrollWidth <= innerWidth"), f"Store overflow at {width}"
        shop.set_viewport_size({"width": 390, "height": 940})
        lost = {}
        if index == 0:
            def lose_response(route):
                if route.request.method == "POST" and not lost:
                    lost.update(route.fetch().json())
                    route.abort()
                else:
                    route.continue_()
            shop.route("**/api/orders", lose_response)
            shop.get_by_role("button", name=t("createAndShare"), exact=True).click()
            expect(shop.get_by_text(t("network_error"), exact=True)).to_be_visible()
            shop.unroute("**/api/orders", lose_response)
            shop.reload()
            shop.evaluate('() => { window.open = () => { throw new Error("Unexpected sharing popup"); }; }')
            expect(shop.get_by_role("button", name=t("createAndShare"), exact=True)).to_be_enabled()
        with shop.expect_response(lambda r: r.url.endswith("/api/orders") and r.request.method == "POST") as created:
            shop.get_by_role("button", name=t("createAndShare"), exact=True).click()
        order = created.value.json()
        expect(shop).to_have_url(re.compile(r"/store/orders/[a-f0-9]{24}/created$"))
        expect(shop.locator('a[href*="wa.me"]')).to_have_count(0)
        print(f"STEP {language}: order created", flush=True)
        if lost:
            assert order["_id"] == lost["_id"]
            assert len(api("/orders", store)) == 1
        assert order["workflowVersion"] == 3 and order["driverSearchStatus"] == "waiting"
        assert "pickupCode" not in order
        assert order["customerPhone"] == "0501234567"
        path = "/customer/" + order["customerLink"].split("/")[-1]
        customer = page_for(path)
        expect(customer.get_by_label(t("recipientName"), exact=True)).to_have_count(0)
        expect(customer.get_by_text("0501234567", exact=True)).to_be_visible()
        expect(customer.get_by_role("button", name=t("confirmPlace"), exact=True)).to_have_count(0)
        # Audit S13: denied device location must offer a manual search fallback
        # and must not save or dispatch an unconfirmed default map position.
        customer.evaluate("() => { navigator.geolocation.getCurrentPosition = (_ok, error) => error({code: 1}); }")
        customer.get_by_role("button", name=t("customerUseLocation"), exact=True).click()
        expect(customer.get_by_text(t("locationPermissionDenied"), exact=True)).to_be_visible()
        assert api(path).get("destinationLocation") is None
        assert api("/orders/" + order["_id"], store)["driverSearchStatus"] == "waiting"
        print(f"PASS audit S13 {language}: denied geolocation saves no destination; manual address search follows", flush=True)
        customer.route("**/api/customer/*/maps/search?**", lambda r: r.fulfill(json=[{
            "lat": 32.75, "lng": 35.35, "label": "Customer entrance"}]))
        customer.route("**/api/customer/*/maps/reverse?**", lambda r: r.fulfill(json={"label": "Customer entrance"}))
        customer.get_by_role("button", name=t("searchAddress"), exact=True).click()
        customer.get_by_role("searchbox", name=t("searchAddress"), exact=True).fill("Customer entrance")
        customer.get_by_role("button", name=t("searchButton"), exact=True).click()
        customer.get_by_role("button", name="Customer entrance", exact=True).click()
        confirm = customer.get_by_role("button", name=t("confirmReadyNow"), exact=True)
        expect(confirm).to_be_enabled()
        for width in [360, 768, 1280]:
            customer.set_viewport_size({"width": width, "height": 940})
            assert customer.evaluate("document.documentElement.scrollWidth <= innerWidth"), f"Customer overflow at {width}"
        customer.set_viewport_size({"width": 390, "height": 940})
        print(f"STEP {language}: location priced in the same page", flush=True)
        # No separate location confirmation, availability screen or required draft save.
        customer.bring_to_front()
        customer.screenshot(path=str(out / f"customer-confirm-{language}.png"), full_page=True, animations="disabled")
        customer.get_by_role("radio", name=t("receiveLater"), exact=True).check()
        customer.get_by_role("button", name=t("confirmForLater"), exact=True).click()
        expect(customer.get_by_role("heading", name=t("trackLater"), exact=True)).to_be_visible()
        customer.get_by_role("button", name=t("readyNow"), exact=True).click()
        expect(customer.get_by_text(t("waitingStore"), exact=True)).to_be_visible()
        state = api("/orders/" + order["_id"], store)
        assert state["customerConfirmed"] and state["driverSearchStatus"] == "waiting"
        shop.goto(base + "/store/orders/" + order["_id"])
        try:
            with shop.expect_response(lambda r: r.url.endswith("/readiness") and r.request.method == "POST") as ready_response:
                shop.get_by_role("button", name=t("markParcelReady"), exact=True).click()
        except Exception:
            print("STORE FAILURE", shop.url, shop.locator("body").inner_text(), errors, flush=True)
            shop.screenshot(path=str(out / "store-failure.png"), full_page=True, animations="disabled")
            raise
        assert ready_response.value.status == 200, ready_response.value.text()
        expect(shop.get_by_role("button", name=t("markParcelReady"), exact=True)).to_have_count(0)
        state = api("/orders/" + order["_id"], store)
        assert state["driverSearchStatus"] == "searching"
        print(f"STEP {language}: both parties ready", flush=True)
        mobile = page_for("/__test/driver")
        print(f"STEP {language}: driver loaded", flush=True)
        if language == "he": mobile.get_by_role("button", name="العربية / עברית", exact=True).click()
        mobile.get_by_label(d("loginName"), exact=True).fill("driver1")
        mobile.get_by_label(d("password"), exact=True).fill("WaselhaDemo123!")
        mobile.get_by_role("button", name=d("signInAction"), exact=True).click()
        mobile.get_by_role("button", name=d("acceptOffer"), exact=True).click()
        pickup = mobile.get_by_role("button", name=d("act.pickedUp"), exact=True)
        expect(pickup).to_be_enabled()
        print(f"STEP {language}: driver accepted", flush=True)
        expect(mobile.get_by_role("button", name=d("enterPickupCode"), exact=True)).to_have_count(0)
        # The real app opens its navigation chooser after the accept undo window.
        # Close it as a user would, so it cannot cover later recovery controls.
        expect(mobile.get_by_role("heading", name=d("nav.ask"), exact=True)).to_be_visible()
        mobile.get_by_role("button", name=d("close"), exact=True).click()
        mobile.bring_to_front()
        mobile.screenshot(path=str(out / f"driver-pickup-{language}.png"), full_page=True, animations="disabled")
        # Audit S31: loss before send keeps the parcel uncollected; loss after
        # commit is recovered by the actual driver's REST refresh, without a second pickup.
        pickup_lost = {}
        def lose_pickup(route):
            if index:
                result = route.fetch()
                assert result.status == 200
                pickup_lost.update(result.json())
            route.abort()
        mobile.route("**/api/orders/*/pickup", lose_pickup)
        with mobile.expect_event("requestfailed", predicate=lambda r: r.url.endswith("/pickup")) as failed_pickup:
            pickup.click()
        mobile.unroute("**/api/orders/*/pickup", lose_pickup)
        if not index:
            assert api("/orders/" + order["_id"], store)["status"] == "driver_assigned"
            expect(mobile.get_by_text(d("network_error"), exact=True)).to_be_visible()
            expect(pickup).to_be_enabled()
            with mobile.expect_request(lambda r: r.url.endswith("/pickup")) as pickup_retry:
                pickup.click()
            assert pickup_retry.value.post_data_json["requestId"] == failed_pickup.value.post_data_json["requestId"]
        else:
            assert pickup_lost["status"] == "collected"
        expect(mobile.get_by_role("button", name=d("finishDelivery"), exact=True)).to_be_visible()
        print(f"PASS audit S31 {language}: pickup response loss {'after commit' if index else 'before send'} recovered", flush=True)
        mobile.get_by_role("button", name=d("finishDelivery"), exact=True).click()
        expect(mobile.get_by_label(d("trip.requestCode"), exact=True)).to_be_visible()
        print(f"STEP {language}: picked up without a store code", flush=True)
        customer.reload()
        public = api(path)
        assert public["deliveryCode"]
        mobile.get_by_label(d("trip.requestCode"), exact=True).fill(public["deliveryCode"])
        amount = public["expectedCustomerCashAgorot"]
        if index:
            mobile.get_by_role("button", name=d("differentAmount"), exact=True).click()
            mobile.get_by_label(d("actualCash"), exact=True).fill("29")
            mobile.get_by_label(d("differenceReason"), exact=True).fill("Customer paid one shekel less")
            amount = 2900
        label = d("confirmDeliveryCash").replace("{amount}", f"{amount / 100:g} ₪") if amount else d("confirmDelivery")
        finish = mobile.get_by_role("button", name=label, exact=True)
        expect(finish).to_be_enabled()
        expect(mobile.get_by_text(d("trip.verified"), exact=True)).to_have_count(0)
        for name, page in [("store", shop), ("customer", customer), ("driver", mobile)]:
            print(f"STEP {language}: inspect {name}", flush=True)
            page.bring_to_front()
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), f"Overflow: {name} {language}"
            page.screenshot(path=str(out / f"{name}-trip-{language}.png"), full_page=True, animations="disabled")
        # Audit S37: exercise the actual driver's network-error recovery on both
        # sides of the delivery commit, using only the local fixture.
        delivery_lost = {}
        def lose_delivery(route):
            if index:
                result = route.fetch()
                assert result.status == 200
                delivery_lost.update(result.json())
            route.abort()
        mobile.route("**/api/orders/*/deliver", lose_delivery)
        with mobile.expect_event("requestfailed", predicate=lambda r: r.url.endswith("/deliver")) as failed_delivery:
            finish.click()
        mobile.unroute("**/api/orders/*/deliver", lose_delivery)
        if not index:
            assert api("/orders/" + order["_id"], store)["status"] == "collected"
            # Explicitly carry the in-memory secure-store test double into a new
            # JS runtime; this does not test native SecureStore durability.
            saved_store = mobile.evaluate("Array.from(globalThis.__waselhaSecureStore.entries())")
            mobile.add_init_script("globalThis.__waselhaSecureStore = new Map(" + json.dumps(saved_store) + ");")
            mobile.reload()
            mobile.get_by_role("button", name=d("finishDelivery"), exact=True).click()
            mobile.get_by_label(d("trip.requestCode"), exact=True).fill(public["deliveryCode"])
            finish = mobile.get_by_role("button", name=label, exact=True)
            with mobile.expect_response(lambda r: r.url.endswith("/deliver") and r.request.method == "POST") as delivered:
                finish.click()
            assert delivered.value.status == 200, delivered.value.text()
            assert delivered.value.request.post_data_json["requestId"] == failed_delivery.value.post_data_json["requestId"]
        else:
            assert delivery_lost["status"] == "delivered"
        print(f"PASS audit S37 {language}: delivery response loss {'after commit' if index else 'before send'} recovered", flush=True)
        state = api("/orders/" + order["_id"], store)
        assert state["status"] == "delivered" and state["actualCashCollectedAgorot"] == amount
        assert not state.get("arrivedStoreAt") and not state.get("arrivedCustomerAt")
        assert len([e for e in state["events"] if e["type"] == "financial_terms_captured"]) == 1
        assert len([e for e in state["events"] if e["type"] == "cash_collected"]) == 1
        assert bool(state.get("collectionAdjustment")) == bool(index)
        customer.reload()
        expect(customer.get_by_text(t("status.delivered"), exact=True)).to_be_visible()
        assert "deliveryCode" not in api(path)
        print(f"PASS {language}: create/share, one-page consent/later, readiness, accept, code-free pickup, delivery/cash")
        for ctx in contexts: ctx.close()
    assert not errors, errors
    browser.close()
