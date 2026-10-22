# waselhaapp

سيرفر واصلها وواجهات المتجر والإدارة والعميل، مهيأة للبناء من المصدر على Render.

## المحتويات

- `backend/`: Node.js، Express، Socket.IO وMongoDB.
- `web/`: React وVite؛ يقدم السيرفر ملفات البناء من `web/dist`.
- `shared/`: العقود والمحتوى المشترك المطلوب للويب والخادم.
- `infra/` و`scripts/setup-osrm.sh`: إعدادات خدمات المسارات وRedis للاستضافة المناسبة لها.

هذه نسخة مستقلة من الملفات الحالية، دون تاريخ المستودع السابق. تطبيق السائق والأدلة المحلية والبيانات التشغيلية وملفات الأسرار ليست ضمنها.

## إعداد Web Service على Render

| الحقل | القيمة |
|---|---|
| Language | Node |
| Region | Frankfurt |
| Root Directory | اتركه فارغًا |
| Start Command | `node backend/src/server.js` |
| Health Check Path | `/api/ready` |
| Node | `24.21.0`، مثبت في `.node-version` |
| Backend instances | نسخة واحدة حسب بنية التطبيق الحالية |

Build Command:

```sh
npm --prefix backend ci && npm --prefix web ci --include=dev && npm --prefix web run build
```

## خدمة OSRM المنفصلة على Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/mahmoodamara/waselhaapp)

ينشئ الزر خدمة المسارات الناقصة فقط، بخطة Free ومنطقة Frankfurt. راجع [دليل النشر والربط بالسيرفر الحالي](docs/render-osrm.md)، ثم اضبط `ROUTING_BASE_URL` بالرابط الفعلي بعد نجاح فحصه. لا تحتاج خدمة OSRM أي أسرار MongoDB أو Redis أو JWT.

## المتغيرات السرية

استخدم إعدادات Environment في Render. الملف `backend/.env.render.example` يوضح أسماء الإعدادات فقط؛ لا يحتوي بيانات اتصال أو JWT حقيقيًا. ملفات `.env` الخاصة تبقى خارج Git.

اضبط `NODE_ENV=production` و`HOST=0.0.0.0` ومنفذ Render. تطبيق production يقرأ متغيرات العملية، ولا يحمّل ملف التطوير المحلي تلقائيًا.

## ما يلزم قبل التشغيل الفعلي

1. قيم MongoDB وصلاحيات المستخدم والوصول من عناوين Render الفعلية.
2. Redis عبر TLS أو اتصال داخلي معتمد؛ اختبر الأوامر المستخدمة وإعادة الاتصال.
3. عنوان OSRM فعلي في `ROUTING_BASE_URL`؛ غيابه يمنع تشغيل production. لا تستخدم localhost الخاص بجهاز آخر أو demo router عامًا.
4. مزود geocoding متوافق مع Nominatim ومصرح للاستخدام؛ القيمة المنتهية بـ`.invalid` علامة تعطيل وليست خدمة حقيقية.
5. ربط `waselhapp.com` وإصدار HTTPS، ومطابقة `PUBLIC_BASE_URL` و`REALTIME_ALLOWED_ORIGINS` مع الأصل الفعلي.
6. تهيئة حسابات التشغيل والمراجعة الفعلية. لا تشغّل seed على production.

SMS وPush وGoogle Routes معطلة في قالب Render حتى التحقق من المزودين. `UNIFIED_DELIVERY_ENABLED=false` يبقي إنشاء طلبات المسار الجديد مغلقًا حتى الفتح المخطط. القوالب ونجاح البناء لا يثبتان جاهزية إطلاق الخدمة أو تطبيقات المتاجر.

## فحوص مستقلة دون خدمات خارجية

مرّر `JWT_SECRET` تجريبيًا إلى عملية اختبارات الخادم فقط، دون استخدام مفتاح الإنتاج. مثال Bash:

```sh
JWT_SECRET=local-verification-only-7a4c90e2b6f83d15 node --test backend/test/release-config.js backend/test/log-redaction.js
node --test web/test/customer-tracking.test.js web/test/home-model.test.js web/test/locationPicker.test.js web/test/quick-delivery.test.js web/test/workflow-v3.test.js
```

هذه مجموعة الفحوص المستقلة الخاصة بنسخة السيرفر. بقية اختبارات التكامل تحتاج قواعد وخدمات اختبار معزولة. اختبارات مطابقة مراحل السائق والترجمة وHTTP بين المنصتين وأدوات UI التاريخية تحتاج مصادر تطبيق السائق واعتمادياته من المشروع الأصلي، وهو غير مضمن في مستودع السيرفر هذا. لذلك أمر `npm --prefix web test` الشامل يحتاج المشروع الكامل.
