# واجهة واصلها على Cloudflare Workers

تُنشر واجهة React/Vite باستخدام Workers Static Assets. يبقى Node/Express وMongoDB
وRedis وOSRM على Render. يمرر Worker فقط `/api` و`/socket.io` إلى
`https://waselhaapp.onrender.com`، مع إبقاء المصادقة والتسعير وصلاحيات الوصول
والتأكيد في السيرفر الأصلي. لا تحتاج الواجهة أسرار قواعد البيانات أو JWT.

## الإعداد والنشر

من جذر المستودع:

```sh
npm --prefix web ci --include=dev
npm --prefix web run test:cloudflare
npm --prefix web run deploy:cloudflare
```

يتطلب النشر تسجيل الدخول إلى حساب Cloudflare عبر Wrangler أو وجود API token
في بيئة النشر. لا تحفظ token في ملفات المشروع. ملف الإعداد هو
`infra/cloudflare/wrangler.jsonc`؛ يرفع ملفات `web/dist` فقط، ولا يرفع جذر المشروع.
يمكن استخدام هذه الإعدادات في Workers Builds من GitHub: أمر البناء
`npm --prefix web ci --include=dev && npm --prefix web run build`، وأمر النشر
`npx wrangler@4.152.0 deploy --config infra/cloudflare/wrangler.jsonc`.

## ربط السيرفر والدومين

- اضبط `ROUTING_TIMEOUT_MS=30000` في Environment لخدمة Node على Render، ثم أعد نشرها.
- اختبر رابط Worker المستقل أولًا. لا يتغير الدومين الحالي بمجرد نشر Worker.
- أضف أصل HTTPS الفعلي للواجهة الجديدة إلى `REALTIME_ALLOWED_ORIGINS` في Render،
  مع الاحتفاظ بالأصول الحالية المطلوبة. لا تستخدم wildcard. لا يعيد Worker
  كتابة Origin للتحايل على هذا الحارس.
- عند نقل الدومين الأساسي إلى Worker، أبقِ `BACKEND_ORIGIN` على عنوان Render
  المباشر لمنع حلقة proxy. حدّث `PUBLIC_BASE_URL` فقط إذا تغير عنوان روابط الزبائن.
- تحقق من IP العميل وإعداد `TRUST_PROXY` على سلسلة Cloudflare ثم Render الفعلية؛
  لا ترفع عدد القفزات بالتخمين. يحذف Worker قيم Forwarded الواردة ويستخدم عنوان
  `CF-Connecting-IP` الذي تضعه Cloudflare لتكوين X-Forwarded-For.

## التحقق

افحص HTML والملفات الثابتة وفتح رابط صفحة داخلية مباشرة. يجب أن يعيد
`/api/health` و`/api/ready` JSON من السيرفر، لا HTML للواجهة. تحقق من عدم تخزين
ردود API وصفحات روابط الزبائن في الكاش، ومن Referrer-Policy وCSP.

اختبر Socket.IO polling ثم WebSocket من أصل الواجهة الفعلي. إذا رفض السيرفر
Origin جديدًا، حدّث القائمة الصريحة في Render بدل تجاوز الحماية. نجاح صفحة
الدخول وحده لا يثبت عمل التتبع أو التسعير أو الإشعارات.

الاختبارات المحلية تغطي JSON وAuthorization وOrigin والمسار وquery، وتمرير
WebSocket، وأخطاء المصادقة، ومنع اختيار upstream من مسار المستخدم، وردًا آمنًا
عند تعذر الاتصال. `observability.enabled=false` يتجنب تسجيل مسارات روابط الزبائن
في سجلات Worker؛ يجب مراجعة أي إعدادات logs أو analytics مستقبلية بنفس السياسة.

راجع [توثيق Static Assets](https://developers.cloudflare.com/workers/static-assets/)
و[توجيه SPA](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/).
