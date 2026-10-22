import bcrypt from "bcryptjs";
import { isIP } from "node:net";
import { User } from "../models/index.js";

export const demoPassword = "WaselhaDemo123!";
export const demoLogins = ["admin", "store1", "driver1", "driver2"];
// Values that ship in .env.example or the test suites; never acceptable in production.
const knownSecrets = /change-this|changeme|replace[_-]?me|your-local|workflow-test|demo|test-secret|example/i;

export function productionConfigProblems(config) {
  const problems = [];
  if (!config.jwtSecret || config.jwtSecret.length < 32 || knownSecrets.test(config.jwtSecret))
    problems.push("JWT_SECRET must be a random value of at least 32 characters (not the example value)");
  let publicUrl;
  try { publicUrl = new URL(config.publicBaseUrl); } catch {}
  const host = publicUrl?.hostname.toLowerCase() ?? '';
  if (!publicUrl || publicUrl.protocol !== "https:" || publicUrl.username || publicUrl.password ||
    publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash || publicUrl.port ||
    isIP(host.replace(/^\[|\]$/g, '')) || !host.includes('.') || host.endsWith('.') ||
    /(?:localhost|\.local|\.internal|\.test|\.invalid|\.example)$/.test(host) ||
    /(?:ngrok|trycloudflare|loca\.lt|localtunnel|expo\.dev|exp\.direct)/.test(host))
    problems.push("PUBLIC_BASE_URL must be a public HTTPS origin without credentials, path, query or fragment");
  if (config.protectedEnvironment) {
    if (!config.redisUrl || !/^rediss?:\/\//.test(config.redisUrl))
      problems.push("REDIS_URL must be explicitly supplied for realtime storage");
    if (!config.mongoUri || !/^mongodb(?:\+srv)?:\/\//.test(config.mongoUri))
      problems.push("MONGODB_URI must be explicitly supplied by the deployment environment");
    if (!config.routingBaseUrl) problems.push("ROUTING_BASE_URL must be explicitly supplied for route pricing");
  }
  return problems;
}
// A pilot database must not contain the documented demo accounts/password.
export async function demoAccountsPresent() {
  const users = await User.find({ login: { $in: demoLogins } }).select("login +passwordHash").lean();
  const found = [];
  for (const user of users) if (await bcrypt.compare(demoPassword, user.passwordHash)) found.push(user.login);
  return found;
}
export async function assertProductionReady(config) {
  const problems = productionConfigProblems(config);
  const demo = await demoAccountsPresent();
  if (demo.length) problems.push(`demo accounts with the published password exist: ${demo.join(", ")}`);
  if (problems.length) throw new Error(`Refusing to start in production:\n- ${problems.join("\n- ")}`);
}
