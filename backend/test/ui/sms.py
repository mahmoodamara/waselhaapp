import re
from datetime import datetime, timezone
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

base = "http://127.0.0.1:3159"
screens = Path(".verification/sms")
screens.mkdir(parents=True, exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    for width, language, mode in [(390, "ar", "accepted"), (1440, "he", "rejected"), (390, "ar", "timeout")]:
        context = browser.new_context(viewport={"width": width, "height": 900})
        setup = context.request.post(base + "/__test/setup", data={"mode": mode}).json()
        texts = context.request.get(base + "/__test/translations").json()
        t = lambda key: texts[key][0 if language == "ar" else 1]
        context.add_init_script("localStorage.setItem('waselha.token', %r); localStorage.setItem('waselha.language', %r);" % (setup["token"], language))
        context.add_init_script("window.open = () => { throw new Error('Unexpected sharing popup'); };")
        page = context.new_page()
        page.clock.install(time=datetime(2026, 10, 18, 12, 0, 0, tzinfo=timezone.utc))
        page.clock.pause_at(datetime(2026, 10, 18, 12, 0, 1, tzinfo=timezone.utc))
        errors, posted_sms = [], []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("request", lambda r: posted_sms.append(r.url) if r.method == "POST" and r.url.endswith("/customer-link/sms") else None)
        page.goto(base + "/store/new")
        page.wait_for_load_state("networkidle")
        page.get_by_label(t("customerPhone"), exact=True).fill("0501234567")
        page.get_by_label(t("goodsValueOnly"), exact=True).fill("100")
        page.get_by_role("radio", name=t("readyForPickup"), exact=True).check()
        with page.expect_response(lambda r: r.url.endswith("/api/orders") and r.request.method == "POST") as creation:
            page.get_by_role("button", name=t("createAndShare"), exact=True).click()
        assert creation.value.status == 201
        order = creation.value.json()
        expect(page).to_have_url(re.compile(r"/store/orders/[a-f0-9]{24}/created$"))
        text = "تم قبول الرسالة للإرسال" if mode == "accepted" else "ספק ה-SMS דחה את הבקשה" if mode == "rejected" else "نتيجة الإرسال غير مؤكدة"
        expect(page.get_by_role("status").filter(has_text=text)).to_be_visible()
        expect(page.locator('a[href*="wa.me"]')).to_have_count(0)
        expect(page.get_by_role("button", name="إرسال الرابط عبر SMS", exact=True)).to_have_count(0)
        expect(page.get_by_role("button", name="שליחת הקישור ב-SMS", exact=True)).to_have_count(0)
        assert context.request.get(base + "/__test/calls").json()["calls"] == 1
        # Success remains for the full five seconds, then opens this same order.
        page.clock.run_for(4999)
        expect(page).to_have_url(re.compile(r"/store/orders/[a-f0-9]{24}/created$"))
        page.clock.run_for(1)
        expect(page).to_have_url(base + "/store/orders/" + order["_id"], timeout=2000)
        page.clock.resume()
        page.reload()
        expect(page.get_by_role("status").filter(has_text=text)).to_be_visible()
        page.goto(base + "/store/orders/" + order["_id"])
        expect(page.get_by_role("status").filter(has_text=text)).to_be_visible()
        expect(page.locator('a[href*="wa.me"]')).to_have_count(0)
        assert not posted_sms, "browser must never initiate an SMS send"
        assert context.request.get(base + "/__test/calls").json()["calls"] == 1
        assert len(context.pages) == 1, "creation opened a popup"
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "horizontal overflow"
        if width > 1000:
            assert page.locator(".od-customer-banner > div").bounding_box()["width"] > 200
        assert not errors, errors
        page.screenshot(path=str(screens / f"{width}-{language}-{mode}.png"), full_page=True)
        print(f"PASS automatic SMS {width}px {language}: {mode}, one provider call after creation, no send button or popup, persistent status")
        context.close()
    browser.close()
