"""Real mobile customer UI in both languages; actual background HTTPS uploads."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

base = "http://127.0.0.1:3117"
out = Path(".verification/phase7")
out.mkdir(parents=True, exist_ok=True)
with sync_playwright() as p:
    expect.set_options(timeout=15000)
    browser = p.chromium.launch(headless=True)
    http = p.request.new_context(base_url=base)
    texts = http.get("/__test/translations").json()
    errors = []
    for index, language in enumerate(["ar", "he"]):
        t = lambda key: texts[key][index]
        f = http.post("/__test/setup").json()
        def api(path, token, data):
            r = http.post("/api" + path, data=data, headers={"Authorization": "Bearer " + token})
            assert r.status == 200, f"Request failed: {r.status}"
            return r.json()
        bg = api("/driver/location/background/session", f["driverToken"], {"sessionId": f["sessionId"]})
        seq = 0
        def location(lat=32.755):
            global seq
            seq += 1
            return api("/driver/location/background", bg["credential"], {"sessionId": bg["sessionId"], "sequence": seq,
                "measuredAt": int(__import__('time').time() * 1000), "latitude": lat, "longitude": 35.345,
                "accuracy": 8, "heading": None, "speed": 2})
        def status(value):
            assert http.post("/__test/status", data={"orderId": f["orderId"], "status": value}).ok
        ctx = browser.new_context(viewport={"width": 375, "height": 900})
        ctx.add_init_script(f'localStorage.setItem("waselha.language", {json.dumps(language)});')
        ctx.route("https://tile.openstreetmap.org/**", lambda r: r.abort())
        page = ctx.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(base + "/customer/" + f["token"])
        page.wait_for_load_state("networkidle")
        expect(page.get_by_role("heading", name=t("trackAssigned"))).to_be_visible()
        marker = page.get_by_role("button", name=t("trackingDriverMarker"), exact=True)
        location()
        expect(marker).to_have_count(0)
        status("driver_at_store")
        expect(page.get_by_role("heading", name=t("trackAtStore"))).to_be_visible()
        expect(marker).to_have_count(0)
        status("collected")
        expect(page.get_by_role("heading", name=t("trackOnTheWay"))).to_be_visible()
        expect(marker).to_have_count(1)
        expect(page.get_by_text(t("trackingLive"), exact=True)).to_be_visible()
        first = marker.get_attribute("style")
        location(32.756)
        expect(marker).not_to_have_attribute("style", first)
        expect(marker).to_have_count(1)
        expect(page.get_by_text(t("trackingStale"), exact=True)).to_be_visible()
        expect(page.get_by_text(t("trackingLastUpdate").split("{seconds}")[0], exact=False)).to_be_visible()
        frozen = marker.get_attribute("style")
        page.screenshot(path=str(out / (language + "-stale.png")), full_page=True)
        expect(marker).to_have_attribute("style", frozen)
        location(32.7558)
        expect(page.get_by_text(t("trackingLive"), exact=True)).to_be_visible()
        # Duplicate browser viewers have independent authenticated subscriptions.
        second = ctx.new_page()
        second.goto(base + "/customer/" + f["token"])
        expect(second.get_by_role("button", name=t("trackingDriverMarker"))).to_have_count(1)
        # Server-side transport disconnect then browser online recovery reauthenticates.
        http.post("/__test/disconnect")
        page.evaluate("window.dispatchEvent(new Event('online'))")
        location(32.7556)
        expect(page.get_by_text(t("trackingLive"), exact=True)).to_be_visible()
        status("driver_at_destination")
        expect(page.get_by_role("heading", name=t("trackArrived"))).to_be_visible()
        expect(marker).to_have_count(1)
        page.screenshot(path=str(out / (language + "-live.png")), full_page=True)
        # Hold an older REST answer while delivery commits. Socket termination
        # must immediately close the UI and the late answer must stay ignored.
        old_view = http.get("/api/customer/" + f["token"]).json()
        held = []
        def hold_once(route):
            if not held:
                held.append(route)
                page.evaluate("document.documentElement.setAttribute('data-audit-old-order-held', 'true')")
            else:
                route.continue_()
        page.route("**/api/customer/" + f["token"], hold_once)
        page.get_by_role("button", name=t("refresh"), exact=True).click()
        expect(page.locator('html')).to_have_attribute('data-audit-old-order-held', 'true')
        api("/orders/" + f["orderId"] + "/deliver", f["driverToken"], {
            "code": "123456", "actualCashCollectedAgorot": 0, "observedExpectedAgorot": 0})
        expect(page.get_by_text(t("status.delivered"), exact=True)).to_be_visible()
        expect(marker).to_have_count(0)
        with page.expect_response("**/api/customer/" + f["token"]):
            held[0].fulfill(status=200, content_type="application/json", body=json.dumps(old_view))
        expect(page.get_by_text(t("status.delivered"), exact=True)).to_be_visible()
        expect(marker).to_have_count(0)
        page.unroute("**/api/customer/" + f["token"], hold_once)
        location(32.7560)
        page.reload()
        expect(page.get_by_text(t("status.delivered"), exact=True)).to_be_visible()
        expect(marker).to_have_count(0)
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
        ctx.close()
    assert not errors, errors
    browser.close()
print("PASS: Arabic/Hebrew mobile markers, freshness, HTTPS, reconnect, duplicate viewer, termination and refresh privacy")
