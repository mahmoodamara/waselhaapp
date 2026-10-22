import { randomUUID } from "node:crypto";
import { createTextMeClient } from "../services/textMe.js";

// This command only validates at /api/test. There is deliberately no live switch.
try {
  const result = await createTextMeClient().send({ recipient: process.argv[2],
    message: "وصّلها: اختبار صلاحية إعدادات الرسائل", externalId: randomUUID(), dryRun: true });
  console.log(JSON.stringify(result));
  if (result.state !== "validated") process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ code: error.code || "sms_validation_failed" }));
  process.exitCode = 1;
}
