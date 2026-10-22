import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

base = "http://127.0.0.1:3159"
out = Path(".verification/customer-simple")
out.mkdir(parents=True, exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    # Setup/assertion requests own their sockets; keep browser traffic real.
    http = p.request.new_context(extra_http_headers={"Connection": "close"})
    for language, width, height in [("ar", 360, 740), ("he", 390, 844)]:
        context = browser.new_context(viewport={"width": width, "height": height}, permissions=["geolocation"],
                                      geolocation={"latitude": 32.75, "longitude": 35.35})
        setup = http.post(base + "/__test/setup", data={"mode": "accepted"}).json()
        texts = http.get(base + "/__test/translations").json()
        t = lambda key: texts[key][0 if language == "ar" else 1]
        created = http.post(base + "/api/orders", headers={"Authorization": "Bearer " + setup["token"]}, data={
            "workflowVersion": 3, "storeAuthorization": True, "customerPhone": "0501234567", "vehicleType": "motorcycle",
            "parcelSize": "medium", "parcelReady": True, "goodsAmountAgorot": 8000, "goodsPaymentStatus": "unpaid", "deliveryFeePaidBy": "customer"})
        assert created.status == 201, created.text()
        order = created.json()
        path = "/customer/" + order["customerLink"].split("/")[-1]
        context.add_init_script("localStorage.setItem('waselha.language', %s)" % json.dumps(language))
        context.route("https://tile.openstreetmap.org/**", lambda r: r.abort())
        context.route("**/maps/reverse?**", lambda r: r.fulfill(json={"label": "Entrance 5"}))
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(base + path)
        page.wait_for_load_state("networkidle")
        expect(page.get_by_role("heading", name=t("customerConfirmHeading"), exact=True)).to_be_visible()
        expect(page.get_by_label(t("recipientName"), exact=True)).to_have_count(0)
        expect(page.get_by_text("0501234567", exact=True)).to_be_visible()
        confirm = page.get_by_role("button", name=t("confirmReadyNow"), exact=True)
        expect(confirm).to_be_disabled()
        assert page.evaluate("document.documentElement.scrollHeight <= innerHeight + 2"), "initial checkout requires scrolling"
        page.screenshot(path=str(out / f"{language}-initial.png"), full_page=True)
        if language == "ar":
            page.evaluate("() => { navigator.geolocation.getCurrentPosition = (_ok, error) => error({ code: 1 }); }")
            page.get_by_role("button", name=t("customerUseLocation"), exact=True).click()
            expect(page.get_by_text(t("locationPermissionDenied"), exact=True)).to_be_visible()
            assert http.get(base + path.replace("/customer/", "/api/customer/")).json().get("destinationLocation") is None
            page.route("**/maps/search?**", lambda r: r.fulfill(json=[{"lat": 32.75, "lng": 35.35, "label": "Entrance 5"}]))
            page.get_by_role("button", name=t("searchAddress"), exact=True).click()
            page.get_by_role("searchbox", name=t("searchAddress"), exact=True).fill("Entrance")
            page.get_by_role("button", name=t("searchButton"), exact=True).click()
            page.get_by_role("button", name="Entrance 5", exact=True).click()
        else:
            page.get_by_role("button", name=t("customerUseLocation"), exact=True).click()
        expect(confirm).to_be_enabled(timeout=10000)
        page.evaluate("window.scrollTo(0, 0)")
        box = confirm.bounding_box()
        assert box["y"] >= 0 and box["y"] + box["height"] <= height, ("confirm below viewport", box, height)
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
        page.screenshot(path=str(out / f"{language}-ready.png"), full_page=True)
        # Optional fields can be reached with native disclosure/keyboard navigation.
        page.get_by_text(t("customerOptionalDetails"), exact=True).click()
        expect(page.get_by_label(t("customerPhone"), exact=True)).to_be_visible()
        page.get_by_label(t("deliveryInstructions"), exact=False).fill("Door 5")
        page.get_by_text(t("customerOptionalDetails"), exact=True).click()
        if language == "he":
            page.get_by_role("radio", name=t("receiveLater"), exact=True).check()
            page.get_by_role("button", name=t("confirmForLater"), exact=True).click()
            expect(page.get_by_role("heading", name=t("trackLater"), exact=True)).to_be_visible()
            page.get_by_role("button", name=t("readyNow"), exact=True).click()
        else:
            confirm.click()
        expect(page.get_by_role("heading", name=t("trackSearching"), exact=True)).to_be_visible()
        result = http.get(base + path.replace("/customer/", "/api/customer/")).json()
        assert result["customerConfirmed"] is True and result["customerAvailable"] is True
        assert not result.get("recipientName")
        assert result["deliveryInstructions"] == "Door 5"
        assert not errors, errors
        page.screenshot(path=str(out / f"{language}-tracking.png"), full_page=True)
        print(f"PASS customer {language} {width}x{height}: no name, compact confirmation, optional notes, {'search fallback' if language == 'ar' else 'GPS/later'}, no page errors")
        context.close()
    http.dispose()
    browser.close()
