import { authenticateToken } from "../middleware/auth.js";

export async function authenticateDriver(token) {
  const session = await authenticateToken(token);
  if (session.user.role !== "driver") throw Object.assign(new Error("forbidden"), { code: "forbidden" });
  return session;
}
export function socketError(code) {
  const error = new Error(code);
  error.data = { code };
  return error;
}
