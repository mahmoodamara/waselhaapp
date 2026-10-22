"""Stored payloads, real built React pages and local HTTP/Mongo only."""
import json
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

base = "http://127.0.0.1:3168"
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    http = p.request.new_context(base_url=base)
    setup = http.get('/__audit/setup').json()
    payload = setup['payload']
    response = http.post('/api/orders', headers={'Authorization': 'Bearer '+setup['merchantToken']}, data={
        'serviceArea':'kafr-kanna', 'deliveryFeePaidBy':'customer', 'recipientName':payload,
        'customerPhone':'0501234567', 'preliminaryAddress':payload, 'finalAddress':payload,
        'deliveryInstructions':payload, 'parcelDescription':payload, 'goodsAmountAgorot':10000, 'parcelReady':True})
    assert response.status == 201, 'Synthetic order must persist over HTTP'
    order = response.json()
    customer_path = urlparse(order['customerLink']).path
    location = http.post('/api'+customer_path+'/location', data={'lat':32.75,'lng':35.35,'source':'gps','address':payload})
    assert location.status == 200, 'Synthetic customer location must persist locally'
    checks = []
    for role, path, token in [('merchant','/store/orders/'+order['_id'],setup['merchantToken']),
                              ('customer',customer_path,None),
                              ('admin','/admin',setup['adminToken'])]:
        context = browser.new_context(viewport={'width':390,'height':940})
        context.add_init_script('localStorage.setItem("waselha.language","ar");window.__auditXss=0;'+
                                ('localStorage.setItem("waselha.token",'+json.dumps(token)+');' if token else ''))
        context.route('**/*', lambda route: route.continue_() if urlparse(route.request.url).hostname == '127.0.0.1' else route.abort())
        page = context.new_page()
        page.goto(base+path)
        page.wait_for_load_state('networkidle')
        expect(page.locator('main').get_by_text(payload, exact=False).filter(visible=True).first).to_be_visible(timeout=15000)
        assert page.evaluate('window.__auditXss') == 0, role+' executed stored payload'
        assert page.locator('img[onerror], script:not([src])').count() == 0, role+' interpreted payload as markup'
        checks.append({'role':role,'storedPayloadVisibleAsText':True,'executed':False})
        context.close()
    browser.close()
    print(json.dumps({'browserChecks':checks,'total':len(checks),'failed':0}))
