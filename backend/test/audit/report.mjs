// Generates the audit artifact from fresh logs, never from older audit reports.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const evidence = path.join(root, '.verification/audit-2026-10-18');
const read = p => readFile(path.join(root, p), 'utf8');
const manifests = ['', 'focused/'];
const runs = [];
for (const folder of manifests) {
  const entries = JSON.parse(await readFile(path.join(evidence, folder, 'runs.json'), 'utf8'));
  for (const entry of entries) runs.push({ ...entry, log: `.verification/audit-2026-10-18/${folder}${entry.logfile}` });
}
runs.sort((a,b) => a.started.localeCompare(b.started));
const latest = new Map(runs.map(r => [r.id, r]));
const primary = [...latest.values()].filter(r => r.counts.tests !== undefined && !['backend-test-proxy-privacy','backend-documented-driver-current'].includes(r.id));
const totals = primary.reduce((a,r) => { for (const k of ['tests','pass','fail','skipped']) a[k] += r.counts[k]; return a; }, { tests:0, pass:0, fail:0, skipped:0 });
const baseline = JSON.parse(await readFile(path.join(evidence, 'baseline-hashes.json'), 'utf8'));
const changes = [];
for (const [file, old] of Object.entries(baseline)) {
  const current = await readFile(path.join(root, file)).catch(() => null);
  if (!current || createHash('sha256').update(current).digest('hex') !== old) changes.push(file);
}
const nonTestChanges = changes.filter(p => !p.startsWith('backend/test/'));
if (nonTestChanges.length) throw new Error(`Unexpected non-test modifications: ${nonTestChanges.join(', ')}`);
const currentFiles = execFileSync('git', ['ls-files','--cached','--others','--exclude-standard','-z'], { cwd:root, encoding:'utf8' }).split('\0').filter(Boolean);
const addedFiles = [];
for (const file of currentFiles) if (!(file in baseline) && await readFile(path.join(root,file)).then(() => true, () => false)) addedFiles.push(file);
const unexpectedAdditions = addedFiles.filter(p => !p.startsWith('backend/test/') && p !== 'docs/audit-2026-10-18.md');
if (unexpectedAdditions.length) throw new Error(`Unexpected non-test additions: ${unexpectedAdditions.join(', ')}`);
await writeFile(path.join(evidence, 'source-integrity.json'), JSON.stringify({ baseline: 'baseline-hashes.json', changedExistingFiles: changes, addedSinceSnapshot:addedFiles, nonTestChanges, unexpectedAdditions, checkedAt: new Date().toISOString() }, null, 2));
const source = async (file, needle) => {
  const lines = (await read(file)).split(/\r?\n/);
  const line = lines.findIndex(l => l.includes(needle)) + 1;
  if (!line) throw new Error(`Missing evidence anchor ${file}: ${needle}`);
  return `[${file}:${line}](../${file}#L${line})`;
};
const files = {
  V:'backend/test/workflow-v3.js', O:'backend/test/nearby-offers.js', G:'backend/test/dispatch-gate.js',
  L:'backend/test/location.js', R:'backend/test/route-pricing.js', F:'backend/test/finance.js',
  T:'backend/test/order-timeouts.js', C:'backend/test/customer-links.js', A:'backend/test/audit-fixes.js',
  P:'backend/test/push.js', K:'backend/test/customer-tracking.js', E:'backend/test/driver-eligibility.js',
  B:'backend/test/realtime-integration.js', U:'backend/test/ui/workflow-v3.py', D:'driver-app/test/ui-current.py',
  H:'backend/test/ui/finance.py',
};
const cmds = {
  V:'npm.cmd --prefix backend run test:workflow-v3', O:'npm.cmd --prefix backend run test:offers',
  G:'npm.cmd --prefix backend run test:dispatch-gate', L:'npm.cmd --prefix backend run test:location',
  R:'npm.cmd --prefix backend run test:route-pricing', F:'npm.cmd --prefix backend run test:finance',
  T:'npm.cmd --prefix backend run test:timeouts', C:'npm.cmd --prefix backend run test:security',
  A:'npm.cmd --prefix backend run test:audit', P:'npm.cmd --prefix backend run test:push',
  K:'npm.cmd --prefix backend run test:tracking', E:'npm.cmd --prefix backend run test:eligibility',
  B:'npm.cmd --prefix backend run test:realtime', U:'npm.cmd --prefix backend run test:ui-v3',
  D:'npm.cmd --prefix driver-app run test:ui',
  H:'npm.cmd --prefix backend run test:ui-finance',
};
// Each matrix entry names an executed test or an explicitly bounded unverified check.
const rows = [
 [1,'Create a valid order and share the link','Not verified','U','order created','Local creation and result navigation passed in Arabic/Hebrew; the WhatsApp URL helper also passed in web/test/quick-delivery.test.js. Actual handoff to an installed WhatsApp app was replaced by a local response, so real device sharing is not verified. Needs a controlled test phone; no real recipient was contacted.','No; existing creation/share coverage'],
 [2,'WhatsApp unavailable or sharing cancelled after save','PASS','U','sharing_unavailable','A throwing share-window navigation did not roll back the saved order: the merchant reached /created and the customer link remained usable. Sending/cancelling inside WhatsApp itself was not exercised.','No; existing simulated handoff failure'],
 [3,'Creation response lost, retried, and page reloaded','PASS','U','def lose_response','Chromium let the local POST commit, discarded its response, reloaded the merchant page, and retried. The returned order ID was identical and the store list contained exactly one order. This guarantee uses the merchant operationId; legacy clients omitting it have no such guarantee.','No; existing response-loss test'],
 [4,'Two customer devices confirm or edit','FAIL','V','audit S10:','Different-detail stale screens correctly conflict in the new S4 test, but two concurrent unchanged confirmations lose one replay ID. Replaying it after Ready restores Later. See D1 for reproduction, expected behavior and impact.','Yes; S4 and S10 HTTP tests'],
 [5,'Expired, cancelled or invalid customer link','PASS','C','CL-2:','Expired links reject reads/writes with 404; rotated/invalid links are rejected. New v3 cancellation tests obtain only the terminal view and confirmation returns 409 editing_blocked. Cancellation keeps the token usable for minimal terminal status, rather than pretending the order is open.','Yes; v3 cancelled-link mutation check; expiry/invalid checks already existed'],
 [6,'Submit/dispatch before confirmation or store readiness','PASS','V','v3 waits for both parties','A confirmed order with parcelReady=false remained waiting_store/waiting. Marking it ready preserved consent and started search; dispatch-gate tests also rejected incomplete/unconfirmed paths and exposed no offer.','No; existing v3 and gate coverage'],
 [7,'Later, then I am ready now','PASS','G',"'later' then",'Later preserved confirmation without search. Ready started search without another financial confirmation. The real v3 browser additionally remained waiting until the merchant marked the parcel ready. See S10 for a later replay defect.','No; existing flow; extended browser runs it'],
 [8,'Readiness and availability arrive concurrently','PASS','V','v3 readiness and availability races','Concurrent readiness/availability plus two recovery sweep calls produced one driver_search_started event, current consent revision and a searching order.','No; existing v3 race'],
 [9,'Price-affecting changes after consent, before assignment','PASS','V','v3 changes invalidate','A payment-status edit cleared customerAgreement and confirmed revision, advanced detailsRevision, and paused search in one persisted state. Existing route/gate tests exercised destination/goods changes and stale price replies. Readiness alone preserved consent. Assigned v3 financial edits returned 409.','No; equivalent tests already existed'],
 [10,'Repeated/retried confirmation cannot restore an old answer','FAIL','V','audit S10:','Both concurrent no-op confirmations returned 200, but the diagnostic showed just one remembered ID. After Ready, replaying both restored customerAvailable=false and driverSearchStatus=waiting. Sequential same-ID replay still passes. See D1.','Yes; failing S10 regression left enabled'],
 [11,'Location inside service coverage','PASS','V','v3 coverage follows','The known town point was accepted; the actual HTTP customer flow saved an inside location and obtained a final route price. Coverage is the repository town polygon, not an assumed radius.','No; existing polygon and browser coverage'],
 [12,'Outside coverage, boundary, bounding rectangle trap','PASS','V','audit S12:','The westernmost polygon vertex was accepted over HTTP. A point 0.00001 longitude west was rejected with 422 outside_delivery_area and did not replace the saved point. Existing test also rejected the point inside the bounding rectangle but outside the polygon.','Yes; S12 edge/near-outside HTTP test'],
 [13,'Missing address/details, invalid coordinates, denied permission','PASS','U','Audit S13:','Injected browser permission denial showed the translated notice, saved no destination and left search waiting; manual address search then completed the flow. Existing location suite rejected malformed/out-of-range coordinates and missing required pickup data. Free-text geocoder address is optional in parseLocation; it is not invented as a mandatory field. Native permission prompts remain a field check.','Yes; S13 rendered browser check in both languages'],
 [14,'Routing fails, times out or returns invalid data','PASS','R','RP-5/13/16:','Local fake OSRM failures left the confirmed location persisted, price pending, money unavailable and pickup blocked. Malformed distances were rejected; timeout was bounded; recovery sweeps repriced once the fake provider recovered. No live provider was called.','No; existing routing-adapter and route-pricing coverage'],
 [15,'Recalculate route/ETA after confirmation','PASS','V','v3 prepaid settlement, zero cash','Changing the fake route from 1500m to 4000m and calling recalculate-price left the confirmed v3 fee unchanged. Pickup and zero-cash settlement used the agreed values. Driver-route/offer-ETA suites separately passed with fake Google transports; ETA is operational decoration and not the pricing authority.','No; existing freeze and route tests'],
 [16,'Prepaid goods, zero due, cash collection','PASS','V','v3 prepaid settlement, zero cash','All prepaid/unpaid and customer/store payer combinations gave the expected cash. Prepaid/store-paid goods completed with zero collection and a store liability for delivery; finance completed without paying the goods to the merchant twice.','No; existing v3 financial tests'],
 [17,'Every dispatch eligibility gate','PASS','G','an incomplete or not-yet-available','Incomplete customer/location/price/availability paths exposed no driver offer. Existing v3 tests additionally exercised merchant readiness and consent revision; the browser showed waiting_customer/waiting_store before searching. This is a local functional result, not proof of real push delivery.','No; existing gate coverage'],
 [18,'Two drivers simultaneously accept one order','PASS','V','v3 two drivers race','Parallel HTTP accepts yielded exactly one 200 and one driver_assigned event. Socket integration separately observed one database winner and offer removal for losers.','No; existing v3 and socket races'],
 [19,'One driver accepts two active orders','PASS','V','v3 two drivers race','Parallel accepts for two ready orders produced exactly one 200 and one active assignment for that driver. The actual MongoDB unique index was present, not mocked.','No; existing real-database race'],
 [20,'Old-round or expired offer accepted','PASS','V','audit S20/22/23:','Expired v3 acceptance was refused before the timeout sweep. Retry advanced dispatchVersion and the old version returned 409 offer_expired. Existing pause/resume test also rejected the old round.','Yes; v3 deadline/retry test'],
 [21,'Accepted driver disappears before pickup','PASS','T','T6-11 arrival protects','An unarrived expired assignment was released, driver excluded, search restarted only if still ready, and v3 dispatch generation advanced. Once arrival was explicitly recorded, deadline expiry did not auto-release custody; stuck-order/admin support is required. Socket loss itself preserved availability/assignment. Real phone loss was not simulated physically.','No; existing timeout/socket/v3 coverage'],
 [22,'No suitable driver or no response','PASS','V','audit S20/22/23:','Selector tests returned no candidates for unavailable/missing/stale/far drivers. Expiring search produced no_driver while retaining searching_driver order status and money; customer DTO exposed dispatchState=no_driver and retry remained available.','Yes; v3 no-driver state/retry coverage'],
 [23,'Reject/skip or expiry and another search wave','PASS','O','audit S23:','Real Redis candidate selection expanded from one to two to three drivers across the three v3 waves. UI skip hid the card locally; Home.js implements no server rejection endpoint. Expiry produced no_driver, then merchant/admin retry began a new dispatch version. Skipping alone does not create a new server round.','Yes; S23 three-wave real-candidate test'],
 [24,'Driver location/availability changes during offers','PASS','O','audit S24:','A test moved the actual Redis location outside the radius between geographic lookup and latest-sample evaluation: the selector returned no candidate. Existing socket tests withdrew offers when availability became false; acceptance rechecked eligibility. This does not promise zero transient visual latency in a physical device.','Yes; S24 controlled movement during lookup'],
 [25,'Socket or push delivery fails','PASS','B','Redis unavailable fails closed','Real socket/Redis loss paths failed closed, reconnect fetched current snapshots, and a socket disconnect during Redis outage did not crash HTTP. Fake push transport failures did not throw; unsuccessful offers retried with a bounded budget then stopped. Actual FCM/APNs/Expo delivery is not verified.','No; existing realtime, push and client refresh tests'],
 [26,'Older clients must not receive v3 offers/data','PASS','O','v3 offers reach only a capable socket','Old sockets on upgraded accounts received no v3 offer while capable sockets did. Old REST/current/route clients were rejected with app_update_required; fake push devices with old capability were excluded. Legacy data remained supported in separate suites.','No; existing REST/socket/push compatibility tests'],
 [27,'Merchant cancels before assignment','PASS','V','audit S27/28/46/47:','Cancellation succeeded in waiting, searching and no_driver. Orders became cancelled without an assignment, cash or financial snapshot, one cancellation event was recorded, and customer confirmation was blocked.','Yes; three v3 search substates'],
 [28,'Merchant cancels after assignment','PASS','V','audit S27/28/46/47:','Owning merchant received 409 after driver assignment; state remained driver_assigned. Admin cancellation before pickup is a separate permitted route.','Yes; v3 role/stage check'],
 [29,'Arrive and collect without mandatory store code','PASS','V','v3 direct pickup and delivery','V3 pickup succeeded directly from driver_assigned without a store code or fabricated arrival timestamp. A separate explicit arrive-store then pickup path also passed. The real browser exposed no pickup-code control. Legacy orders still require their code.','No; existing v3 and browser coverage'],
 [30,'Repeated/concurrent pickup','PASS','V','v3 concurrent pickup/delivery','Five concurrent identical pickup requests all returned 200 and retained the explicit arrival timestamp. Command replay produced one fulfillment snapshot/event, with matching-payload replay rather than duplicated pickup.','No; existing v3 replay; browser adds event-count check'],
 [31,'Internet loss before/after pickup confirmation','PASS','U','Audit S31:','Arabic browser aborted before send: database stayed driver_assigned, then retry used the same requestId. Hebrew browser committed pickup then dropped its response: the actual App refreshed to collected. Exactly one financial_terms_captured event remained. Native SecureStore durability was not tested.','Yes; before-send/after-commit browser cases'],
 [32,'Missing, stale or inaccurate driver location','PASS','O','fresh nearby included','Missing/stale/invalid/far samples were excluded using real Redis and stale geographic members were removed. Client and background tests also rejected inaccurate/out-of-order samples. Selector fixture isolation was corrected without weakening assertions; actual device accuracy is a field check.','No new equivalent test; repaired existing fixture isolation'],
 [33,'Customer cannot track before pickup','PASS','K','v3 customer coordinates appear','Actual tracking credentials/sockets/Redis returned no driver coordinates before collection. Pickup enabled the subscription and latest point. The test did not infer privacy from hidden UI alone.','No; existing tracking integration'],
 [34,'Tracking ends on delivery/cancellation','PASS','K','all ten order states','Tracking used an exact two-state allowlist across all ten states. Delivery, failure/return and cancellation revoked coordinates/subscriptions; races with delayed Redis snapshots/publishers did not disclose post-delivery locations. The real customer browser also passed reconnect and terminal cleanup.','No; existing tracking and browser suites'],
 [35,'Proximity must not automatically record arrival','PASS','D','being near never sends','Driver UI test fed near-store and near-customer GPS samples: hints appeared and the recorded command list stayed empty until the manual action. Far/inaccurate fixes also sent nothing. Production CurrentTrip imports arrivalHint, not the old automatic sender.','No; existing rendered driver test'],
 [36,'Customer does not answer after arrival','PASS','A','P1-04 return authorization','After explicit customer arrival, a driver fail command with Customer absent retained parcel custody and produced an attributed failure event; admin authorization/store receipt completed return. New v3 fail/return setup and existing rendered failure/no-code controls also ran. No actual call or real customer contact occurred.','Yes; additional v3 fail/return setup; existing after-arrival test reused'],
 [37,'Internet loss before/after delivery confirmation','PASS','U','Audit S37:','Arabic aborted before send, retained collected, transferred the secure-store test double into a new JS runtime and completed with the same requestId. Hebrew committed delivery then lost its response; App refreshed out of the active trip. Exactly one cash_collected event persisted. This is browser network fault injection, not native radio testing.','Yes; before-send/after-commit browser cases'],
 [38,'Wrong code three times; actual limit and recovery','PASS','V','audit S38/39/40:','First four wrong delivery codes returned 422 incorrect_delivery_code. Fifth returned 429 too_many_attempts with retry delay; even a correct code was blocked until admin unlock. Existing workflow suite exercised short/long/manual locks at failures 5/10/15 and concurrent guessing. Three attempts is not the implemented limit.','Yes; v3 four-digit stage/lock/unlock path'],
 [39,'Valid, wrong, expired or used code','PASS','V','audit S38/39/40:','Wrong/correct/locked code paths ran. After successful delivery, a different request ID using the old code was forbidden and no second cash event appeared; same-ID replay was idempotent. The code has no independent TTL in the schema/guard, so an expired-code variant is not implemented (not a tested expiry guarantee). Customer-link expiry is separate.','Yes; v3 used-code rejection; legacy length check also run'],
 [40,'Premature delivery completion','PASS','V','audit S38/39/40:','Deliver before collection returned 409 and created no CodeAttempt. Existing amount/confirmation gates rejected stale expected cash and unacknowledged discrepancies without collecting money.','Yes; v3 premature-state check'],
 [41,'Delivery without recorded arrival','PASS','V','v3 direct pickup and delivery','Direct delivery from collected succeeded with valid code/cash and left arrivedCustomerAt undefined. V3 arrival is optional; this is permitted behavior rather than an inferred defect.','No; existing direct-flow test'],
 [42,'Repeated/concurrent Complete delivery','PASS','V','v3 concurrent pickup/delivery','Five concurrent same-ID delivery requests all returned 200 with one cash_collected event and one open adjustment. Legacy finance suite also ran twenty concurrent finalizations; conflicting payload replay was rejected.','No; existing real-database races'],
 [43,'Collected amount equals amount due','PASS','F','T8-9 customer-pays','Server-derived customer cash, driver earnings and platform fee stayed separate; exact collection produced zero difference. For 1500m/8000 goods/customer payer, v3 due was 11000, fee 3000, driver 2700 and platform 300 agorot; prepaid zero-cash also passed.','No; existing pricing/finance/v3 checks'],
 [44,'Collection discrepancy and financial settlement','FAIL','H','Audit S44:','Discrepancy amounts, reasons and server settlement passed API tests and eight normal admin browser flows. A controlled delayed refresh nevertheless restored a pending payout form after a 200 payout response and a database record of completed. The admin view can therefore misrepresent settlement. See D2 for reproduction, evidence and impact.','Yes; controlled stale-finance-snapshot browser regression; existing discrepancy APIs reused'],
 [45,'No duplicate cash/settlement; code/tracking ends','PASS','F','T8-64 twenty concurrent','Concurrent finalizations/payment requests produced one logical cash/adjustment/payment event per action. Customer code disappeared, tracking ended, and financial records required explicit manual completion. Delivery does not itself pay anyone.','No; existing finance/tracking/v3 coverage'],
 [46,'Cancel at every permitted stage: actor/effects','PASS','V','audit S46/47:','Merchant cancelled all unassigned search substates; admin cancelled before pickup at driver_assigned and driver_at_store. Assignment was released and existing money/snapshot stayed unchanged. Collected/destination/failed/returning/returned/delivered refused cancellation. Existing socket tests observed cancellation offer removal; no real push receipt is claimed.','Yes; v3 stage/actor cancellation matrix'],
 [47,'Unauthorized or too-late cancellation','PASS','V','audit S46/47:','Driver could not use merchant cancel (403), store could not use admin cancel (403), merchant after assignment received 409, and admin post-pickup/terminal cancellation returned 409 while status/custody/money remained unchanged.','Yes; v3 stage/role checks'],
 [48,'Admin recovery/return to merchant','PASS','V','v3 admin recovery and return','Admin recover after pickup preserved driver custody; authorize-return then store confirm-return yielded returned and released assignment. Legacy audit suite also verified cash handover for failed delivery and blocked invalid recovery stages; admin browser recovery was exercised separately.','No; equivalent v3/API coverage existed'],
 [49,'Legacy orders and older data/client compatibility','PASS','T','legacy searches use original','Legacy deadline recovery, manual-price preservation, absent historical finance data and old code lengths ran against actual MongoDB. Existing v1/v2 lifecycle completed; modern-only data/commands stayed blocked for old clients. No migration/backfill or invented historical consent/payment was applied.','No; existing legacy and documented delivery-verification tests'],
 [50,'Unexpected error/timeout during a transition','PASS','V','audit S50:','Injected an exception immediately before delivery update: order stayed collected, cash/snapshot settlement/event were unchanged, then retry committed once. Injected a crash after customer consent but before dispatch: consent persisted with search waiting, then readiness sweep repaired it once. A successful code-verification audit may already exist before delivery commit; the system is not claimed to be one multi-document transaction. Real failover/storage outages were not run.','Yes; two narrowly scoped fault-injection tests'],
 [51,'Audit records for money/state changes','PASS','A','P1-04 admin assignment','Executed tests verified attributed assignment, cancellation, edits, link rotation, financial completion/reversal/adjustment and return events plus account/code unlock history. Fulfillment snapshot/cash events were written with their order transition. This does not claim every operation ledger is race-safe: D1 demonstrates lost customer-confirmation replay IDs.','No; existing audit tests plus new cancellation/fault assertions'],
];
if (rows.length !== 51 || rows.some((r,i) => r[0] !== i+1)) throw new Error('Scenario matrix must contain exactly 51 ordered rows');
const statusCounts = Object.fromEntries(['PASS','FAIL','Not verified','Not applicable'].map(s => [s, rows.filter(r => r[2] === s).length]));
const matrix = [];
for (const [number,name,status,key,needle,observed,added] of rows) {
  matrix.push(`| ${number}. ${name} | **${status}** | Automated test${status === 'Not verified' ? '; external handoff not verified' : ''} | ${await source(files[key],needle)} | \`${cmds[key]}\` | ${observed} | ${added} |`);
}
const time = value => new Intl.DateTimeFormat('en-GB', { timeZone:'Asia/Jerusalem', dateStyle:'short', timeStyle:'medium', hour12:false }).format(new Date(value));
const first = runs[0].started, last = runs.at(-1).finished;
const commandTable = [...latest.values()].map(r => `| \`${r.command}\` | ${r.code} | ${r.counts.tests === undefined ? 'No Node test count emitted' : `${r.counts.tests} tests; ${r.counts.pass} passed; ${r.counts.fail} failed; ${r.counts.skipped} skipped`} | ${time(r.started)} → ${time(r.finished)} | [${r.log.split('/').at(-1)}](../${r.log}) |`).join('\n');
const allAttempts = runs.map(r => `| \`${r.command}\` | ${r.code} | ${r.counts.tests === undefined ? '—' : `${r.counts.pass}/${r.counts.tests} passed; ${r.counts.fail} failed; ${r.counts.skipped} skipped`} | ${time(r.started)} → ${time(r.finished)} | [log](../${r.log}) |`).join('\n');
const d1Test = await source(files.V,'audit S10:');
const d1Current = await source('backend/src/services/orders.js','function currentFilter');
const d1Update = await source('backend/src/services/orders.js','async function update');
const d1Prior = await source('backend/src/services/orders.js','const prior = order.operations');
const d1Write = await source('backend/src/services/orders.js','operations: [...(order.operations');
const financeLog = latest.get('backend-test-ui-finance');
const cleanup = JSON.parse(await readFile(path.join(evidence, 'service-cleanup.json'), 'utf8').catch(() => 'null'));
const d2Test = await source('backend/test/ui/finance.py', 'Audit S44:');
const d2Load = await source('web/src/pages/Admin.jsx', 'const load = () => action.run');
const d2Saved = await source('web/src/pages/Admin.jsx', 'OrderFinance order={o} admin');
const d2Guard = await source('web/src/components/UI.jsx', 'if (lock.current) return');
const body = `# Waselha delivery lifecycle audit — 18 October 2026

## 1. Scope and environment

Inspected the current, already-dirty working tree of Waselha at \`C:\\Users\\admin\\Downloads\\waselha-simple-prototype\\waselha\`; HEAD \`${execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim()}\`. The audited implementation includes pre-existing uncommitted v3, realtime, push and background-location changes. This report does not describe a clean release commit. Existing user changes were preserved. No AGENTS.md was found in the repository or checked ancestor directories. Read README, workflow v3, operational/security/location/pricing/finance/realtime/tracking documentation and test harnesses. Older documents conflict with current code in places (for example the old device checklist says no background GPS); their previous results were not reused.

Fresh execution window: **${time(first)}–${time(last)}, Asia/Jerusalem (UTC+03:00)**. Inspection began at 06:05 local. Individual logs also record ISO UTC timestamps. Host: Windows/PowerShell; Node **v24.21.0**, npm **11.9.0**, Python **3.13**, installed Python Playwright/Chromium. Dependencies were already installed; no dependency or lock file was changed.

Started a separate MongoDB 7.0 process on **127.0.0.1:27118**, using a new ignored audit data directory, and a separate Redis-compatible Memurai process on **127.0.0.1:6398**, with persistence disabled. All databases were explicitly named \`waselha_audit_*_test\`; backup tests used their own test-only source/restore databases on that same audit instance. Existing MongoDB:27017, Redis:6379 and application:3000 were not reset, used for tests or stopped. The server/index/reset/seed routines ran only against these isolated test databases. Test HTTP servers bound loopback on ephemeral ports; browser fixtures used 3108/3117 and the existing driver UI harness. Mongo/Redis and the actual application models/routes/services/sockets were real, rather than mocked.

OSRM/geocoding were local fake HTTP providers; Google Routes transports, push transports/receipts, browser GPS callbacks and native phone modules were doubles. Push and Google production clients were explicitly disabled. WhatsApp was intercepted or made unavailable. No real order, message, push, courier/user contact, production/staging operation, deployment or cloud build was performed. Android/iOS exports used placeholder map keys and a loopback API URL; they prove JavaScript/Hermes bundling only. No physical phone was tested. Real nginx HTTPS/log-redaction integration could not start because NGINX_BIN/OPENSSL_BIN were unavailable; its tool failure is recorded separately from application regressions.

### Actual flow traced

The merchant React flow persists an operation ID/payload, saves via POST /api/orders, then opens a device/browser-level \`wa.me\` URL; the result page provides a fallback. This is **not server-side WhatsApp messaging or SMS**. The customer token routes store location before calling the routing adapter, and consent/availability are recorded by the orders service. The dispatch gate checks merchant readiness, authorization, known goods, valid location, final OSRM price, customer name/phone, current consent revision and availability. The Mongo order CAS and unique active-driver index arbitrate assignment; Socket.IO/push are notifications rather than assignment authority. V3 pickup needs no merchant code. Delivery requires the recipient code plus recorded actual cash; arrival is optional. Fulfillment captures immutable terms; admin reconciliation separately records cash handover, driver payout and merchant settlement. Customer tracking is a separate credential/socket path allowed only after collection and before terminal/failure states.

Verified pricing source: ${await source('backend/src/services/money.js','export function calculateRoutePrice')} and executed pricing/finance tests. Fee is **max(integer road meters × 2, 1500) agorot**. Platform commission uses integer rounding \`floor((fee+5)/10)\`; driver earning is fee minus commission. Customer due excludes prepaid goods and includes delivery only when customer-paid. These are current code rules, not assumed market tariffs. Coverage is the committed local **Kafr Kanna polygon**, with accepted edges, from ${await source('backend/src/services/coverage.js','export function deliveryAreaFor')}; no live boundary authority was consulted or updated.

## 2. Executive summary with actual counts

- Scenario matrix: **${statusCounts.PASS} PASS, ${statusCounts.FAIL} FAIL, ${statusCounts['Not verified']} Not verified, ${statusCounts['Not applicable']} Not applicable**, exactly 51 rows. The three failed rows concern **two confirmed application defects**, D1 and D2.
- **11 new Node tests**: nine v3 HTTP/service tests and two real-Redis offer-selection tests. Latest affected runs: **v3 24 passed / 1 failed / 0 skipped (25 tests)**; **offers 23 passed / 0 failed / 0 skipped (23 tests)**. Of the 11 newly added tests, **10 passed and 1 failed**.
- Four added browser checks: denied geolocation, pickup network loss and delivery network loss each executed in Arabic and Hebrew, plus one controlled admin financial-refresh race. Browser scripts do not emit a Node test total; their checkpoints are not added to Node totals. The three multilingual additions passed; the final financial-refresh regression failed as described in D2.
- Latest results for **${primary.length} disjoint project-script Node test sets**: **${totals.tests} tests; ${totals.pass} passed; ${totals.fail} failed; ${totals.skipped} skipped**. Each file belongs to one set in this total. The separate documented combined driver-current command reports **25 passed / 25 tests**, overlaps quick-delivery/privacy, and is **not added** to that total. The setup-blocked proxy command reports **0 passed / 1 failed**, excluded from the application-test total and explicitly not a PASS.
- Legacy workflow command reported **15 workflow groups passed**, not 15 individual Node tests. Web build, driver background configuration, Android/iOS exports and driver/tracking/v3 browser checks passed. The admin-finance browser first passed all eight normal collection/payer/discrepancy flows and recovery/reversal in both languages; its latest expanded command **${financeLog.code === 0 ? 'passed' : 'failed on the new D2 stale-snapshot assertion'}**. No inferred browser test count.
- **Overall verdict: one P1 and one P2 application regression remain, with enabled failing tests.** Production application code was deliberately not fixed during this audit. Real phone handoff/tracking/push, deployment configuration and proxy logs remain outside verified acceptance.

## 3. Scenario matrix

PASS means the cited behavior was actually exercised in this local test environment. All cited executable checks are automated; no physical/manual field check is claimed. Code-review explanations (for example optional address text, code TTL absence and local skip semantics) are distinguished from executed assertions within each observation. PASS is limited to the described assertions and doubles, not a claim that every device/network/provider behaves identically. The exact command is repeated for reproducibility; final logs and every earlier attempt appear in section 7. An unchanged existing test is identified as such to avoid counting duplicate coverage as newly added work.

| Scenario | Result | Evidence type | Test file and line | Exact command | Actual observation, limitation or blocker | New test? |
|---|---|---|---|---|---|---|
${matrix.join('\n')}

## 4. Confirmed defects

### D1 — [P1 High] Concurrent customer-confirmation acknowledgements can lose replay identity and restore an obsolete Later answer

**Cause: application code**, not a missing service or a fake provider. Reproduced in two complete executions of the expanded v3 suite using actual HTTP, the real server subprocess and isolated MongoDB. Evidence: ${d1Test}; [first reproduction log](../.verification/audit-2026-10-18/focused/backend-test-workflow-v3-1.log), [reproduction with diagnostics](../.verification/audit-2026-10-18/focused/backend-test-workflow-v3-2.log). The diagnostic showed two 200 acknowledgements, only \`noop-device-a\` remembered after the race, and after Ready plus replays: \`customerAvailable:false\`, \`driverSearchStatus:waiting\`. The assertion failed \`false !== true\`.

Reproduction (all steps implemented by the enabled test):

1. Create/price v3 and confirm with Later.
2. Read that confirmed customer snapshot, then concurrently submit two otherwise identical no-op confirmations, using two distinct request IDs.
3. Observe both HTTP responses are 200; inspect the order's operation ledger.
4. Send availability=true (Ready now).
5. Retry the two acknowledged confirmation bodies, as two devices or delayed network retries may do.
6. Read the persisted order: availability has reverted to false and search is waiting.

**Expected:** an acknowledged request ID remains durably remembered; retries return the current order without reapplying the previous answer. Ready remains true, with no second availability side effect. **Actual:** one operation ID is lost during the concurrent writes and its replay runs as a fresh command, restoring Later and pausing dispatch. **Impact:** customers and merchants can wait indefinitely after a ready signal; dispatch state contradicts the latest intentional action. No duplicated cash or double assignment was observed from this defect.

Mechanism: ${d1Prior} checks replay IDs from a previously loaded document. ${d1Write} constructs a replacement operations array from that same stale document. ${d1Current} does not include an operation-ledger revision/ID condition; ${d1Update} can therefore allow both unchanged-detail writes, and one full-array replacement loses the other ID. After availability changes, the missing request passes the still-current confirmation snapshot and is applied again.

Recommended future fix (not implemented): make command identity insertion and payload/actor conflict checks atomic with the consent write, without replacing a stale operations array. A ledger revision/CAS with retry or another appropriately unique durable command boundary must retain both acknowledgements. Preserve existing same-ID payload conflicts and current-state replay semantics. Keep the new S10 test as regression coverage. S4 separately proves that different-detail stale screens are rejected, so it does not conceal this unchanged-detail race.

### D2 — [P2 Medium] An older financial refresh can restore a pending payout after payment completed

**Cause: application frontend state management.** Test: ${d2Test}. [Controlled reproduction log](../.verification/audit-2026-10-18/focused/backend-test-ui-finance-6.log), [affected rerun](../.verification/audit-2026-10-18/focused/backend-test-ui-finance-7.log), [current-run screenshot](../.verification/step8/ui/audit-finance-refresh-race.png). The browser uses actual React and HTTP APIs; the intercepted GET response is a real response captured before the payment, delivered later. It does not invent a fake settlement state.

Reproduction:

1. Complete a v3 order through the real local API and open its admin finance panel.
2. Record cash handover. Capture the automatically requested GET /api/orders?status=delivered response, but withhold it from the browser; it still shows driverPayout=pending.
3. While that refresh is pending, record driver payout. The POST returns 200, the browser initially removes the payout form, and an independent GET verifies database driverPayout=completed.
4. Release the older order-list response. The UI replaces its newer state and exposes one pending payout form again.

**Expected:** completed payment stays completed in the admin UI even when an older refresh arrives late. **Actual:** the assertion expects zero payout forms but finds one, with diagnostic \`database driverPayout=completed, visible pending payout forms=1\`. **Impact:** the administrator can see misleading unpaid/pending information and be invited to retry a payment already recorded. The API still enforces reconciliation idempotency and no duplicate money record was demonstrated. Refreshing/reopening the page retrieves correct database state.

Mechanism: ${d2Load} unconditionally replaces order state with an asynchronous snapshot. ${d2Saved} first applies the mutation result and calls load again; ${d2Guard} discards that refresh while the earlier one is still running. The older snapshot can then overwrite the mutation result, with no trailing refresh/version check to restore the authoritative state. Recommended future fix (not implemented): invalidate or version older financial reads on mutation and guarantee a trailing authoritative refresh, or otherwise prevent stale snapshots from replacing newer mutation results. Retain the controlled browser regression. Routine finance cases now wait for each automatic refresh to finish; the explicit race remains enabled and failing, rather than being hidden by that synchronization.

### Test/setup failures, distinguished from D1

- Original offers test expected three stale samples counted but observed one: the asynchronous live dispatcher pruned two samples before the explicit selector call. The behavioral candidate list was already correct. The fixture now uses a separate real-Redis namespace for the selector case, preserving all candidate/count/cleanup assertions; subsequent complete offers runs passed. This was **test interference**, not confirmed unsafe application dispatch.
- The first routes command failed two file setups because this audit runner initially omitted ROUTES_TEST_URI. Added the missing isolated variable, then the complete existing routes command passed 37/37. This was an **audit harness configuration error**.
- The initial v3 browser augmentation returned a function from Page.evaluate; Playwright invoked it without the expected callbacks. Corrected the test callback wrapper. A later retry was covered by the real timed navigation chooser; the test now explicitly closes that chooser as a user would. The complete extended journey then passed both languages. These were **test synchronization/setup errors**, not product fixes.
- The old finance browser script targeted removed merchant/driver layouts and a password label matched both input and visibility button. It was updated to prepare v3 orders through the real HTTP lifecycle and to focus on the actual admin financial/recovery UI; the separate v3 and driver suites retain actual merchant/customer/driver browser coverage. Follow-up fixture service-area/uppercase-order-ID mismatches are retained in earlier logs. Later payment timeouts/stale views prompted the controlled D2 reproduction; they are not presented as successful checks or dismissed as setup failures. Routine synchronized finance flows passed before the dedicated race was added. This is an explicit **test-scope migration**, not evidence that the historical screen still exists.
- Proxy-privacy: unavailable NGINX_BIN/OPENSSL_BIN prevented the test body from exercising HTTPS. **Environment blocker; Not verified**, despite the runner's failed-test count. No proxy or deployment privacy guarantee is made.

## 5. Tests added

| File | Change and scenario coverage | Latest verification |
|---|---|---|
| backend/test/workflow-v3.js | Nine additions: conflicting customer devices (S4); concurrent no-op replay (S4/S10); polygon edge (S12); v3 expired/no-driver/retry (S20/22/23); merchant cancellation (S5/27/28/46/47); admin stage matrix (S36/46/47); v3 code/state/used-code recovery (S38/39/40); precommit delivery exception and consent/dispatch interruption (S50). | 25 tests, 24 passed, 1 failed; all 16 original v3 tests remained passing. The new failing test is D1 and was not disabled. |
| backend/test/nearby-offers.js | Two added real-Redis behavior tests: geographic waves (S23), moving during lookup (S24). Isolated an existing stale-sample test from live dispatcher cleanup (S32). | 23/23 passed, no skips. |
| backend/test/ui/workflow-v3.py | Three added browser checks run in each language: denied GPS/manual fallback, pickup loss before/after commit, delivery loss before/after commit. Explicitly transfers the in-memory SecureStore double for runtime recovery and compares command IDs; asserts one snapshot/cash event. | Entire v3 browser journey passed Arabic/Hebrew, including existing creation/share retry and optional arrival assertions. |
| backend/test/ui/finance.py | Replaced obsolete creation/driver screen setup with real v3 API transitions; retained actual admin manual resolution/payment/reversal/recovery UI checks in both languages. Added the controlled stale-snapshot regression for S44. Existing customer/driver browser behavior is covered in other suites, not claimed by this script. | Eight normal flows plus reversal/recovery passed; the expanded command exits ${financeLog.code} on the enabled D2 race assertion. |
| backend/test/audit/run.mjs | Test orchestration only: existing npm scripts/documented combined command, explicit audit database/Redis URLs, disabled external production transports, timestamped raw output/counts and preserved attempts. | Used for every recorded suite run. |
| backend/test/audit/report.mjs | Reproducible report/matrix generator; checks 51 ordered rows and verifies baseline hashes have no non-test modifications. | Generated this report and source-integrity.json. |

Tests use HTTP/integration level where atomic database/index/socket behavior matters, browser level for rendering/navigation/network recovery, and a narrowly scoped method double only to inject the two S50 failure points. No application decision logic, financial calculation, database or internal transition result was stubbed to claim success. Equivalent existing race/finance/privacy tests were reused rather than duplicated.

## 6. Manual or field checks still required

- A controlled Android/iOS device must verify WhatsApp URL handoff, app unavailable/cancel UX and link copying/sharing. No message delivery/recipient receipt or SMS capability was verified here.
- Physical GPS accuracy, motion, OS permission denial/regrant, background/killed-app updates, battery restrictions, screen lock, native SecureStore persistence and navigation app handoff/return. Browser/native-module doubles and successful exports cannot prove these.
- Actual push registration/delivery/receipts through Expo/FCM/APNs with approved test devices. The tested fake transport proves server retry/privacy/capability behavior only.
- Native connectivity loss and process termination around accept/pickup/delivery. Local browser tests prove response-loss handling, and database tests prove the specified CAS/replay behavior; they do not prove mobile-radio/OS durability.
- Authorized service configuration/live route quality and service-boundary suitability require field validation. This audit verified the repository polygon and local providers only; it did not spend API credit or alter geographic configuration.
- Run the existing proxy-privacy command with installed local nginx/OpenSSL, then verify the actual authorized reverse proxy separately. Storage/server failover and multi-instance operation were not certified. No deployed environment or phone was tested.

## 7. Commands and logs

### Reproduction environment

All commands below ran from the repository root. ${await source('backend/test/audit/run.mjs','const env =')} is the exact test environment configuration. It sets SECURITY/WORKFLOW/PRIVACY/OFFERS/REALTIME/ROUTES/TRACKING/BACKGROUND/UI_FINANCE/TRACKING_UI test database URLs to their audit-only *_test databases on port 27118; both Redis variables point to port 6398. It also sets NODE_ENV=test, TZ=Asia/Jerusalem, disables real Google/push clients, uses local fake routing supplied by test fixtures, and sets synthetic map keys for exports. No environment file contents or real credentials are included in this report.

Mongo startup used the installed executable with \`--dbpath <repo>/.verification/audit-2026-10-18/mongo --port 27118 --bind_ip 127.0.0.1 --logpath <repo>/.verification/audit-2026-10-18/mongo.log\`. Memurai startup used \`--port 6398 --bind 127.0.0.1 --save "" --appendonly no --dir <repo>/.verification/audit-2026-10-18/redis --logfile <repo>/.verification/audit-2026-10-18/redis.log\`. Both were launched using PowerShell Start-Process with WindowStyle Hidden. PIDs were recorded in services.json. ${cleanup ? `Both audit-owned services were stopped at **${time(cleanup.stoppedAt)} Asia/Jerusalem**, after checking their executable paths. Listener inspection confirmed existing MongoDB:27017, Redis:6379 and app:3000 remained running, with the same original PIDs; audit ports 27118/6398 and browser fixture ports 3108/3117 were no longer listening. [Cleanup record](../.verification/audit-2026-10-18/service-cleanup.json).` : 'Only audit-owned services are eligible for cleanup; existing services must be left running.'}

Run \`node backend/test/audit/run.mjs\` after starting those two isolated services to repeat the full configured audit. For a focused repeat, set \`$env:AUDIT_LOG_SUBDIR='focused'\` and supply run IDs, e.g. \`node backend/test/audit/run.mjs backend-test-workflow-v3 backend-test-offers backend-test-ui-v3\`. The wrapper executes the exact project commands below using npm's installed CLI without shell quoting. The documented combined command comes from docs/driver-current-verification.md. No live operational/seed/deployment script was run outside isolated test fixtures. Run \`node backend/test/audit/report.mjs\` after test completion to regenerate the report from current-run manifests.

### Latest result of each distinct command

Counts below are exactly as produced by the runner, not inferred from screen presence. All times use Asia/Jerusalem on 18 October 2026. Commands without a test total have exit/checkpoint evidence only. The proxy command's failure is a setup blocker. **Do not add the overlapping documented combined command or repeated attempts to the summary total.**

| Exact command | Exit | Actual tool counts | Local start → finish | Log |
|---|---:|---|---|---|
${commandTable}

### Every attempt, including failures and reruns

Initial failures are retained rather than overwritten by successful reruns. These are execution records, not additional unique test coverage. Log redaction removes synthetic fixture login credentials and service-license identifiers, preserving results, counts, timings and failure diagnostics. Machine-readable manifests: [initial runs](../.verification/audit-2026-10-18/runs.json), [focused runs](../.verification/audit-2026-10-18/focused/runs.json).

| Exact command | Exit | Tool counts | Local start → finish | Log |
|---|---:|---|---|---|
${allAttempts}

Fresh browser screenshots were produced under .verification/workflow-v3/, .verification/phase7/, .verification/step8/ui/ and the driver harness evidence directories. They are supporting artifacts from this execution; older files in those directories were not used as evidence. The authoritative current records are the timestamped logs linked above. Inspection commands included rg --files/rg -n, Get-Content, git status --short, git rev-parse HEAD, node --version, npm.cmd --version, Get-Date -Format o, executable/listener discovery and Python syntax compilation of changed test scripts. Two generated Python cache files were removed by exact path; no user data was deleted.

### Change boundary and evidence integrity

Compared SHA-256 hashes of every existing nonignored repository file captured before the runs: **${nonTestChanges.length} pre-existing non-test files changed by audit work**, and no new production-code file was added. Files differing from that pre-run snapshot: ${changes.map(p => `\`${p}\``).join(', ')} (the runner bootstrap already existed when this snapshot was captured). The two new source files are the test runner/report generator under backend/test/audit/. This report is the sole new documentation deliverable; runtime logs, snapshots, exports and audit-only service data are ignored verification artifacts. [Source integrity record](../.verification/audit-2026-10-18/source-integrity.json), [baseline hashes](../.verification/audit-2026-10-18/baseline-hashes.json).

**Application production behavior was not modified.** All code/configuration changes were limited to tests/test orchestration; report/log artifacts are the necessary audit outputs. No dependencies, production settings, schemas/index definitions, migrations or user changes were edited. The failing D1/D2 regressions remain reproducible for a subsequent fix task.
`;
await writeFile(path.join(root, 'docs/audit-2026-10-18.md'), body);
await writeFile(path.join(evidence, 'scenario-matrix.json'), JSON.stringify({ statusCounts, totals, newNodeTests:11, newBrowserChecks:4, rows }, null, 2));
process.stdout.write(JSON.stringify({ statusCounts, totals, changedExistingFiles:changes, distinctCommands:latest.size, attempts:runs.length, report:'docs/audit-2026-10-18.md' }) + '\n');
