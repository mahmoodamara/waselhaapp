"""Real admin financial UI, isolated local API/MongoDB/fake routing.
Run after web build using test/ui-finance-server.mjs on port 3108.
V3 orders are prepared by actual local HTTP transitions; the admin UI is exercised in Chromium.
"""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

base = "http://127.0.0.1:3108"
out = Path(".verification/step8/ui")
out.mkdir(parents=True, exist_ok=True)
with sync_playwright() as p:
    expect.set_options(timeout=20000)  # allow the app's 15 s request timeout to report an error first
    launch = {"headless": True}
    if os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE"):
        launch["executable_path"] = os.environ["PLAYWRIGHT_CHROMIUM_EXECUTABLE"]
    browser = p.chromium.launch(**launch)
    api = p.request.new_context(base_url=base)
    def request(path, token=None, method="GET", body=None, status=200):
        # Browser journeys can leave the setup client's pooled socket idle until
        # the local server closes it. Give each setup/assertion call its own
        # connection; browser requests and deliberate response loss stay real.
        r = api.fetch("/api" + path, method=method, data=body,
                      headers={"Connection": "close", "x-waselha-workflow": "3", **({"Authorization": "Bearer " + token} if token else {})})
        assert r.status == status, f"{method} {path}: {r.status} != {status}; {r.text()}"
        return r.json()
    sessions = {n: request("/auth/login", method="POST", body={"login": n, "password": "WaselhaDemo123!"})
                for n in ["admin", "store1", "driver1"]}
    texts = api.get("/__test/translations").json()
    store, admin = sessions["store1"]["token"], sessions["admin"]["token"]
    request("/store/pickup-service-area", store, "PUT", {"pickupServiceArea": "kafr-kanna"})
    errors = []
    for idx, lang in enumerate(["ar", "he"]):
        # These are separate accelerated journeys, not one user's >10 creates/minute.
        # Reset only the isolated fixture's budgets; production rate-limit coverage remains enabled.
        assert api.post('/__test/reset-action-limits').ok
        t = lambda k: texts["web"][k][idx]
        d = lambda k: texts["driver"][k][idx]
        contexts = []
        def page_for(role, path):
            ctx = browser.new_context(viewport={"width": 375, "height": 900})
            contexts.append(ctx)
            if role:
                ctx.add_init_script(f'localStorage.setItem("waselha.language", "{lang}"); localStorage.setItem("waselha.token", {json.dumps(sessions[role]["token"])});')
            else:
                ctx.add_init_script(f'localStorage.setItem("waselha.language", "{lang}");')
            ctx.route("https://tile.openstreetmap.org/**", lambda route: route.abort())
            page = ctx.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(base + path)
            page.wait_for_load_state("networkidle")
            return page
        def mobile_check(page):
            assert page.evaluate("document.documentElement.dir === 'rtl'")
            if not page.evaluate("document.documentElement.scrollWidth <= innerWidth"):
                page.screenshot(path=str(out / f'overflow-{lang}.png'), full_page=True)
                details = page.evaluate("""() => [...document.querySelectorAll('body *')].map(el => {
                  const r = el.getBoundingClientRect(); return {tag:el.tagName, cls:el.className, left:r.left, right:r.right, width:r.width, scroll:el.scrollWidth};
                }).filter(r => r.left < -1 || r.right > innerWidth + 1).slice(0, 20)""")
                raise AssertionError(f"overflow {lang}: {page.url}: {json.dumps(details)}")

        # Audit: seed financial states through the real v3 HTTP lifecycle. Merchant,
        # customer and driver browser interactions are covered by workflow-v3.py;
        # this suite independently verifies the actual admin reconciliation UI.
        driver = sessions["driver1"]["token"]
        request("/orders/service-areas", driver)
        for flow, payer, actual in [("A", "customer", 18000), ("B", "store", 15000), ("C", "customer", 17500), ("D", "customer", 18500)]:
            order = request("/orders", store, "POST", {
                "workflowVersion": 3, "storeAuthorization": True, "customerPhone": "0501234567",
                "vehicleType": "car", "parcelSize": "small", "parcelReady": True,
                "goodsAmountAgorot": 15000, "goodsPaymentStatus": "unpaid", "deliveryFeePaidBy": payer,
            }, 201)
            order_id, token = order["_id"], order["customerLink"].split("/")[-1]
            request(f"/customer/{token}/location", method="POST", body={"lat": 32.75, "lng": 35.35, "source": "pin", "address": "Customer street"})
            view = request(f"/customer/{token}")
            expected = 18000 if payer == "customer" else 15000
            assert view["expectedCustomerCashAgorot"] == expected
            request(f"/customer/{token}/confirm", method="POST", body={
                "requestId": f"finance-{lang}-{flow}-confirm", "recipientName": "Customer", "customerPhone": "0501234567",
                "available": True, "observed": view["confirmationSnapshot"],
            })
            request("/driver/orders/available", driver)
            view = request(f"/orders/{order_id}", store)
            request(f"/orders/{order_id}/accept", driver, "POST", {"supportedWorkflowVersion": 3, "dispatchVersion": view["dispatchVersion"]})
            request(f"/orders/{order_id}/pickup", driver, "POST", {"requestId": f"finance-{lang}-{flow}-pickup"})
            snapshot = request(f"/orders/{order_id}", admin)["financialSnapshot"]
            assert snapshot["expectedCustomerCashAgorot"] == expected
            assert snapshot["driverEarningsAgorot"] == 2700 and snapshot["platformCommissionAgorot"] == 300
            code = request(f"/customer/{token}")["deliveryCode"]
            request(f"/orders/{order_id}/deliver", driver, "POST", {
                "requestId": f"finance-{lang}-{flow}-deliver", "code": code,
                "observedExpectedAgorot": expected, "actualCashCollectedAgorot": actual,
                **({"confirmDifference": True, "differenceReason": "Audit collection discrepancy"} if actual != expected else {}),
            })
            saved = request(f"/orders/{order_id}", admin)
            assert saved["status"] == "delivered" and saved["actualCashCollectedAgorot"] == actual
            assert saved["cashDifferenceAgorot"] == actual - expected
            assert saved["financialSnapshot"] == snapshot and saved["financeComplete"] is False
            admin_page = page_for("admin", "/admin")
            admin_page.get_by_role("button", name=t("finance"), exact=True).click()
            panel = admin_page.locator("section.panel").filter(has=admin_page.get_by_role("heading", name=f'{t("order")} · {order_id[-6:].upper()}', exact=True))
            expect(panel.get_by_text(t("financePending"), exact=True)).to_be_visible()
            mobile_check(admin_page)
            admin_page.screenshot(path=str(out / f"admin-pending-{lang}-{flow}.png"), full_page=True)
            if actual != expected:
                # A difference needs an explicit decision, a reference and a note before cash/store records open.
                form = panel.locator("form").filter(has=admin_page.get_by_role("heading", name=t("financeAction.resolve-adjustment"), exact=True))
                expect(form.get_by_role("button", name=t("recordCompletion"), exact=True)).to_be_disabled()
                form.get_by_role("combobox", name=t("resolutionType"), exact=True).select_option("driver_pays" if actual < expected else "platform_revenue")
                form.get_by_label(t("resolutionReference"), exact=True).fill("REF-UI")
                form.get_by_label(t("resolutionNote"), exact=True).fill("Reviewed cash; historical amounts preserved")
                with admin_page.expect_response(lambda r: r.url.endswith("/finance/resolve-adjustment") and r.request.method == "POST") as resolved:
                    form.get_by_role("button", name=t("recordCompletion"), exact=True).click()
                assert resolved.value.status == 200
                expect(form).to_have_count(0)
                admin_page.wait_for_load_state("networkidle")
            # Amounts are derived by the server and shown, never typed.
            for name in ["cash-handover", "driver-payout", "store-settlement"]:
                form = panel.locator("form").filter(has=admin_page.get_by_role("heading", name=t(f"financeAction.{name}"), exact=True))
                print(f"CHECK {lang} flow {flow}: admin {name}", flush=True)
                try:
                    with admin_page.expect_response(lambda r: r.url.endswith(f"/finance/{name}") and r.request.method == "POST") as recorded:
                        form.get_by_role("button", name=t("recordCompletion"), exact=True).click()
                except Exception:
                    admin_page.screenshot(path=str(out / "audit-finance-failure.png"), full_page=True)
                    (out / "audit-finance-failure.html").write_text(panel.inner_html(), encoding="utf-8")
                    print("FINANCE CHECK FAILED", lang, flow, name, "page errors:", errors, flush=True)
                    raise
                assert recorded.value.status == 200
                expect(form).to_have_count(0)
                # Routine case: finish the admin's automatic snapshot refresh
                # before the next payment. A separate controlled race below
                # verifies what happens when that snapshot is delayed.
                admin_page.wait_for_load_state("networkidle")
                if name == "driver-payout":
                    payload = recorded.value.request.post_data_json
                    request(f"/admin/orders/{order_id}/finance/{name}", admin, "POST", payload)
                    request(f"/admin/orders/{order_id}/finance/{name}", admin, "POST", {"requestId": payload["requestId"] + "-different"}, 409)
            expect(panel.get_by_text(t("financeCompleted"), exact=True)).to_be_visible()
            admin_page.screenshot(path=str(out / f"admin-complete-{lang}-{flow}.png"), full_page=True)
            mobile_check(admin_page)
            saved = request(f"/orders/{order_id}", admin)
            assert saved["financeComplete"] is True and saved["financialSnapshot"] == snapshot
            assert saved["expectedCustomerCashAgorot"] == expected and saved["actualCashCollectedAgorot"] == actual
            if flow == "A":
                reverse = panel.locator("form").filter(has=admin_page.get_by_role("button", name=t("reverseRecord"), exact=True)).first
                expect(reverse.get_by_role("button", name=t("reverseRecord"), exact=True)).to_be_disabled()
                reverse.get_by_label(t("reverseReason"), exact=True).fill("Incorrect receipt; original retained")
                with admin_page.expect_response(lambda r: r.url.endswith("/finance/reverse-record")) as reversed_response:
                    reverse.get_by_role("button", name=t("reverseRecord"), exact=True).click()
                assert reversed_response.value.status == 200
                expect(panel.get_by_text(t("financePending"), exact=True)).to_be_visible()
                reopened = panel.locator("form").filter(has=admin_page.get_by_role("heading", name=t("financeAction.cash-handover"), exact=True))
                reopened.get_by_role("button", name=t("recordCompletion"), exact=True).click()
                expect(panel.get_by_text(t("financeCompleted"), exact=True)).to_be_visible()
                history = request(f"/orders/{order_id}", admin)["events"]
                assert len([e for e in history if e["type"] == "finance_record_reversed"]) == 1
                assert len([e for e in history if e["type"] == "cash_handover_completed"]) == 2
            admin_page.close()
            print(f"{lang} flow {flow}: payer={payer}, expected={expected}, actual={actual}, reconciled, duplicate payout blocked: PASS")
        # Prepare custody via the real API; exercise the admin-only recovery UI.
        recovery = request("/orders", store, "POST", {"serviceArea": "kafr-kanna", "deliveryFeePaidBy": "customer",
            "area": "Recovery", "customerPhone": "0501234567", "recipientName": "Customer", "finalAddress": "Street",
            "parcelDescription": "Box", "parcelReady": True, "goodsAmountAgorot": 15000}, 201)
        oid, ct = recovery["_id"], recovery["customerLink"].split("/")[-1]
        request(f"/customer/{ct}/location", method="POST", body={"lat": 32.75, "lng": 35.35, "source": "pin", "address": "Street"})
        cv = request(f"/customer/{ct}")
        request(f"/customer/{ct}/confirm", method="POST", body={"observed": cv["confirmationSnapshot"],
            "recipientName": "Customer", "finalAddress": "Street", "deliveryInstructions": "Door"})
        driver = sessions["driver1"]["token"]
        request(f"/orders/{oid}/accept", driver, "POST", {})
        for actor in [store, driver]:
            fresh = request(f"/orders/{oid}", actor)
            request(f"/orders/{oid}/confirm", actor, "POST", {"observed": fresh["confirmationSnapshot"]})
        request(f"/orders/{oid}/arrive-store", driver, "POST", {})
        request(f"/orders/{oid}/pickup", driver, "POST", {"code": recovery["pickupCode"]})
        assert api.post(f"/__test/age/{oid}").status == 200
        recovery_page = page_for("admin", "/admin")
        expect(recovery_page.get_by_text(t("stuckOrders"), exact=True)).to_be_visible()
        alert = recovery_page.get_by_role("alert").filter(has=recovery_page.get_by_text(t("stuckOrders"), exact=True))
        alert.get_by_role("button").click()
        form = recovery_page.locator("form").filter(has=recovery_page.get_by_role("heading", name=t("recoverOrder"), exact=True))
        expect(form.get_by_role("button", name=t("recoverOrder"), exact=True)).to_be_disabled()
        form.get_by_label(t("reason"), exact=True).fill("Driver phone unavailable; custody verified")
        form.get_by_label(t("cashKeptAgorot"), exact=True).fill("10")
        form.get_by_role("checkbox", name=t("custodyConfirmed"), exact=True).check()
        with recovery_page.expect_response(lambda r: r.url.endswith("/recover")) as recovered:
            form.get_by_role("button", name=t("recoverOrder"), exact=True).click()
        assert recovered.value.status == 200
        expect(recovery_page.get_by_role("button", name=t("authorizeReturn"), exact=True)).to_be_visible()
        saved = request(f"/orders/{oid}", admin)
        assert saved["status"] == "delivery_failed" and saved["activeAssignment"] is True
        assert saved["actualCashCollectedAgorot"] == 1000
        recovery_page.get_by_role("button", name=t("authorizeReturn"), exact=True).click()
        recovery_page.get_by_role("dialog").get_by_role("button", name=t("authorizeReturn"), exact=True).click()
        expect(recovery_page.get_by_text(t("status.returning"), exact=True)).to_be_visible()
        request(f"/orders/{oid}/confirm-return", store, "POST", {})
        request(f"/admin/orders/{oid}/finance/cash-handover", admin, "POST", {"requestId": f"recovery-{lang}", "amountAgorot": 1000})
        assert request(f"/orders/{oid}", admin)["financeComplete"] is True
        mobile_check(recovery_page)
        print(f"{lang}: payment reversal and re-recording; stuck-order recovery with retained custody/cash: PASS")
        for ctx in contexts: ctx.close()
    assert not errors, errors
    print("Arabic/Hebrew 375px RTL: PASS; page errors=0; no horizontal overflow; admin financial UI and actual HTTP lifecycle; driver UI is covered separately.")
    for idx, lang in enumerate(["ar", "he"]):
        t = lambda k: texts["web"][k][idx]
        for stale_result in ["success", "failure"]:
            # Audit S44: delay a real financial snapshot across the next successful
            # payment. A completed payment must not reappear as pending in the admin UI.
            race_order = request("/orders", store, "POST", {
                "workflowVersion": 3, "storeAuthorization": True, "customerPhone": "0501234567",
                "vehicleType": "car", "parcelSize": "small", "parcelReady": True,
                "goodsAmountAgorot": 15000, "goodsPaymentStatus": "unpaid", "deliveryFeePaidBy": "customer",
            }, 201)
            race_id, race_token = race_order["_id"], race_order["customerLink"].split("/")[-1]
            request(f"/customer/{race_token}/location", method="POST", body={"lat": 32.75, "lng": 35.35, "source": "pin", "address": "Audit race street"})
            view = request(f"/customer/{race_token}")
            request(f"/customer/{race_token}/confirm", method="POST", body={"requestId": "finance-refresh-confirm",
                "recipientName": "Customer", "customerPhone": "0501234567", "available": True, "observed": view["confirmationSnapshot"]})
            request("/driver/orders/available", driver)
            view = request(f"/orders/{race_id}", store)
            request(f"/orders/{race_id}/accept", driver, "POST", {"supportedWorkflowVersion": 3, "dispatchVersion": view["dispatchVersion"]})
            request(f"/orders/{race_id}/pickup", driver, "POST", {"requestId": "finance-refresh-pickup"})
            view = request(f"/customer/{race_token}")
            request(f"/orders/{race_id}/deliver", driver, "POST", {"requestId": "finance-refresh-deliver", "code": view["deliveryCode"],
                "observedExpectedAgorot": 18000, "actualCashCollectedAgorot": 18000})
            race_page = page_for("admin", "/admin")
            race_page.get_by_role("button", name=t("finance"), exact=True).click()
            race_panel = race_page.locator("section.panel").filter(has=race_page.get_by_role("heading", name=f'{t("order")} · {race_id[-6:].upper()}', exact=True))
            expect(race_panel.get_by_text(t("financePending"), exact=True)).to_be_visible()
            race_page.wait_for_load_state("networkidle")
            held = {"reads": 0}
            def hold_finance_snapshot(route):
                held["reads"] += 1
                if held["reads"] > 1:
                    route.continue_()
                    return
                response = route.fetch()
                assert response.status == 200
                held["body"] = response.json()
                held["route"] = route
                race_page.evaluate("document.documentElement.setAttribute('data-audit-held-finance', 'true')")
            race_page.route("**/api/orders?status=delivered", hold_finance_snapshot)
            def race_form(action):
                return race_panel.locator("form").filter(has=race_page.get_by_role("heading", name=t(f"financeAction.{action}"), exact=True))
            with race_page.expect_response(lambda r: r.url.endswith("/finance/cash-handover") and r.request.method == "POST") as first_payment:
                race_form("cash-handover").get_by_role("button", name=t("recordCompletion"), exact=True).click()
            assert first_payment.value.status == 200
            expect(race_page.locator('html')).to_have_attribute('data-audit-held-finance', 'true')
            old_order = next(o for o in held["body"] if o["_id"] == race_id)
            assert old_order["driverPayout"]["status"] == "pending"
            with race_page.expect_response(lambda r: r.url.endswith("/finance/driver-payout") and r.request.method == "POST") as second_payment:
                race_form("driver-payout").get_by_role("button", name=t("recordCompletion"), exact=True).click()
            assert second_payment.value.status == 200
            expect(race_form("driver-payout")).to_have_count(0)
            assert request(f"/orders/{race_id}", admin)["driverPayout"]["status"] == "completed"
            if stale_result == "success":
                held["route"].fulfill(json=held["body"])
            else:
                held["route"].fulfill(status=503, json={"code": "server_error"})
            finance_title = race_page.locator(".section-title").filter(has=race_page.get_by_role("heading", name=t("finance"), exact=True))
            expect(finance_title.get_by_role("button", name=t("refresh"), exact=True)).to_be_enabled()
            race_page.wait_for_load_state("networkidle")
            assert held["reads"] == 2, "a payment during a refresh must trigger one trailing authoritative read"
            summary = request("/admin/finance", admin)
            total_paid = race_page.locator(".totals > div").filter(has=race_page.get_by_text(t("paid"), exact=True))
            expect(total_paid.locator("strong")).to_have_text(f'{summary["paymentsAgorot"] / 100:.2f} \u20aa')
            expect(race_page.get_by_role("alert")).to_have_count(0)
            visible_pending = race_form("driver-payout").count()
            print(f"AUDIT S44 {lang} stale-{stale_result} refresh race: database driverPayout=completed, visible pending payout forms={visible_pending}", flush=True)
            mobile_check(race_page)
            race_panel.screenshot(path=str(out / f"audit-finance-refresh-race-{lang}-{stale_result}.png"))
            expect(race_form("driver-payout")).to_have_count(0, timeout=2000)
            race_page.unroute("**/api/orders?status=delivered", hold_finance_snapshot)
            race_page.context.close()
    assert not errors, errors
    browser.close()
