# Customer pricing and confirmation recovery — 22 October 2026

The previous live recovery report recorded an OSRM response taking 13,730 ms.
The backend default was 5,000 ms, so a valid route could be rejected with
`routing_unavailable`, leaving the final total unavailable and consent disabled.
The browser also aborted after 20,000 ms, shorter than the proposed server wait.

The backend now defaults to 30,000 ms, retaining explicit overrides and the
30,000 ms upper bound. The web client waits up to 40,000 ms, including response
body reads. Location persistence, pending-price retries and customer consent
requirements are unchanged. Pricing recovery does not confirm an order.

Deployment examples and Render instructions use `ROUTING_TIMEOUT_MS=30000`.
The ignored `backend/.env.render` already contains this value. An explicit
5,000 ms value on a running instance still overrides the new default: update it
and redeploy both backend and web assets. This session did not deploy the fix.

## Verification

- Regression tests failed before the fix for the five-second server deadline
  and the twenty-second browser deadline, then passed after the fix.
- Routing/pricing: 48 tests passed using an isolated local MongoDB database and
  a simulated OSRM HTTP service, including pending-price retry and confirmation.
- Web: 54 tests passed, including delayed pricing and stalled response bodies.
- Web production build passed.
- Chromium at 375 px, Arabic and Hebrew: simulate a provider failure, then a
  21-second recovery response; the final total appears and the confirmation
  button becomes enabled. Customer consent remains false. No uncaught browser
  errors or horizontal overflow. Evidence: ignored
  `.verification/route-price-timeout/results.json` and screenshots.

The earlier live order recovery remains recorded in
`.verification/osrm-render-2026-10-22/customer-price-recovery.json`.
A fresh read of the live database failed with `MongoServerSelectionError`, so
the current state of that order was not independently reverified here.

## Repeat the slow browser check

Build the web app. Start this fixture in one PowerShell terminal from the root:

```powershell
npm.cmd --prefix web run build
$env:UI_ROUTE_TEST_URI = 'mongodb://127.0.0.1:27017/waselha_route_timeout_browser_test'
$env:UI_ROUTE_DELAY_MS = '21000'
node backend/test/ui-route-recovery.mjs
```

The named `*_test` database is reset. Local MongoDB and Redis must be running.
SMS, push and Google Routes are disabled in the fixture. With Python Playwright
and Chromium installed, run from another terminal:

```powershell
python -u backend/test/ui/route-price-timeout.py
```

Stop the fixture after testing. The browser does not press the consent button.
