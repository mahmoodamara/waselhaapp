# نشر خدمة OSRM على Render

هذه الخدمة تكمل `ROUTING_BASE_URL` المفقود في سيرفر واصلها. تستخدم OSRM car.lua وMLD وبيانات Geofabrik لإسرائيل وفلسطين. لا تحتاج مفتاح Google أو بيانات MongoDB أو Redis أو JWT.

## إنشاء الخدمة

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/mahmoodamara/waselhaapp)

الرابط يقرأ `render.yaml` من المستودع ويجهّز **خدمة OSRM واحدة فقط** باسم `waselha-osrm`، بخطة Free ومنطقة Frankfurt. راجع أن الخطة المعروضة Free قبل التأكيد. لا ينشئ نسخة ثانية من سيرفر Node ولا يغيّر متغيراته أو بياناته.

إذا أنشأت الخدمة يدويًا، استخدم **New → Web Service** من مستودع `mahmoodamara/waselhaapp`:

| الحقل | القيمة |
|---|---|
| Name | `waselha-osrm`، أو اسم متاح تختاره |
| Language | Docker |
| Branch | main |
| Region | Frankfurt |
| Compute | Free |
| Root Directory | فارغ |
| Dockerfile Path | `infra/osrm/render/Dockerfile` |
| Docker Build Context | `infra/osrm/render` |
| Docker Command | فارغ، لا يوجد Start Command إضافي |
| Environment | `PORT=10000` و`OSRM_THREADS=1` فقط |
| Health Check Path | المسار الموضح أدناه |

```text
/route/v1/driving/35.3357268,32.7486911;35.3437821,32.7356136?overview=false&steps=false&alternatives=false
```

لا تنسخ ملف `.env` الخاص بالتطبيق إلى خدمة المسارات. يحتوي Docker context على قائمة سماح ضيقة للملفات المطلوبة فقط.

## ماذا يحدث في البناء والتشغيل

أثناء **البناء** تُنزّل الخريطة العامة المؤرخة من HTTPS وتُتحقق قيمة SHA-256 وعدد البايتات، ثم تُشغّل مراحل extract → partition → customize. صورة OSRM مثبتة ببصمة، وكذلك صورة Python المستخدمة للتنزيل. تدخل ملفات الرسم البياني المعالجة في طبقة صورة التشغيل، فيبقى الرسم متاحًا بعد cold start دون persistent disk.

أثناء **التشغيل** لا يوجد تنزيل أو معالجة للخريطة. يبدأ `osrm-routed` مباشرة على `0.0.0.0:$PORT` بمستخدم غير root وخيط واحد. طلبات Route محدودة بثلاث نقاط، وهو أصغر حد يقبله إصدار OSRM المثبت؛ ويستخدم backend الحالي نقطتين، وسجلات الطلبات المتضمنة الإحداثيات معطلة عبر مستوى WARNING.

خريطة المصدر: لقطة OSM حتى 21 أكتوبر 2026، وفق `infra/osrm/render/map-source.json`. هذه لقطة اختبار مثبتة، لا وعد بتحديث تلقائي أو دقة دائمة للطرق. تُراجع الطرق والتغطية قبل التشغيل الفعلي. يحفظ الملف `ATTRIBUTION.md` إسناد OpenStreetMap وODbL ورابط المصدر.

## ربطها بالسيرفر الموجود

بعد أن تصبح خدمة OSRM **Live**:

1. انسخ أصل HTTPS الفعلي الذي يعرضه Render للخدمة. اسم الخدمة لا يضمن شكل الرابط؛ انسخ الرابط المعروض ولا تخمّنه.
2. افتح أصل الرابط متبوعًا بمسار Health Check أعلاه. النتيجة المطلوبة HTTP 200 و`code: "Ok"` ومسافة ومدة موجبتان. ظهور صفحة loading ليس نتيجة ناجحة.
3. في خدمة `waselhaapp` الموجودة، افتح **Environment** وحدّث **`ROUTING_BASE_URL`** إلى أصل HTTPS الذي نجح فحصه فقط، دون مسار `/route/...` أو query أو slash نهائي، واضبط **`ROUTING_TIMEOUT_MS=30000`**. اترك باقي إعدادات الاتصال كما هي.
4. احفظ وأعد نشر سيرفر Node.
5. افحص `/api/health` و`/api/ready`. يجب أن يكون `routing` بقيمة `ok`، مع نجاح MongoDB وRedis وبقية checks. الجاهزية العامة لا تعتمد على routing وحده، وتقرير routing في المصدر الحالي معلوماتي؛ افحصه صراحةً.

لا تُستبدل قيمة المتغير بعنوان localhost من جهازك أو public demo router. لا يتغير حارس production، وسيبقى التشغيل مرفوضًا ما دام المتغير فارغًا.

## الخطة المجانية وحدود الإثبات

خدمة OSRM وخدمة Node هما خدمتان منفصلتان. Render Free يتوقف بعد الخمول، وتُشارك خدمات الويب المجانية حصة ساعات الـworkspace؛ وجود خدمات أخرى قد يستهلك الحصة. مهلة backend الافتراضية أصبحت 30 ثانية، ومهلة واجهة الويب 40 ثانية. إن بقيت قيمة قديمة صريحة مثل `ROUTING_TIMEOUT_MS=5000` في Render فستتجاوز القيمة الافتراضية ويجب تعديلها. إذا تجاوز الاستيقاظ 30 ثانية، يبقى الموقع محفوظًا والسعر قيد الحساب مع إعادة المحاولة التلقائية أو زر إعادة حساب السعر؛ لا يتاح تأكيد مبلغ غير نهائي. لا تستخدم ping دوريًا للتحايل على حدود الخطة.

الاختبار المحلي يقيّد الحاوية إلى 512MiB و0.1 CPU دون swap، ويجرب 3 مسارات عامة وطلبات متزامنة وعميل backend الحقيقي، ويسجل الذاكرة وcold start. نجاحه لا يثبت الأداء على Render أو صلاحية الخدمة لحمل إنتاجي. لا تُعدَّل الخطة إلى مدفوعة تلقائيًا.

نتيجة التحقق المحلي في 22 أكتوبر 2026: نجحت اختبارات التنزيل الستة والتحقق من Blueprint بالمخطط الرسمي، ثم نجح اختبار الحاوية الحقيقي تحت الحدود المذكورة. أعلى استهلاك مسجل 267.4MiB، والاستعداد بعد بدء الحاوية نحو 3.2 ثانية. نجحت ثلاثة مسارات والطلبات المتزامنة وفحص الصحة وعميل backend، دون OOM أو تسجيل إحداثيات الطلبات. هذه قياسات الجهاز المحلي، ولم تُنشأ خدمة Render بعد.

## التحقق وإعادة البناء محليًا

```sh
python infra/osrm/test-render-download.py
docker build -t waselha-osrm-render:test infra/osrm/render
node scripts/test-osrm-render.mjs
```

على Windows، إذا لم يكن Docker ضمن PATH، عيّن `DOCKER_BIN` لمسار docker.exe الفعلي قبل اختبار Node. في شبكة بناء تستخدم CA معتمدة خاصة، يمكن تمرير bundle الشهادات الموثوقة عبر BuildKit secret اسمه `build_ca`. يُضاف إلى مخزن الثقة أثناء التنزيل فقط، ولا يدخل طبقات الصورة؛ لا يُعطّل تحقق TLS، ولا يلزم ذلك في البناء العادي على Render.

التحديث: غيّر عنوان المصدر المؤرخ وحجمه وSHA-256 في `map-source.json` بعد تحقق مستقل، ثم أعد البناء والفحوص والنشر. الرسم البياني لا يُعاد بناؤه عند تشغيل الحاوية. إعادة النشر التلقائي معطلة لهذه الخدمة حتى لا تُعاد معالجة الخريطة عند تغييرات unrelated في التطبيق.

المراجع: [Render Docker](https://render.com/docs/docker)، [Render Free](https://render.com/docs/free)، [OSRM](https://github.com/Project-OSRM/osrm-backend#quick-start)، [Geofabrik](https://download.geofabrik.de/asia/israel-and-palestine.html).
