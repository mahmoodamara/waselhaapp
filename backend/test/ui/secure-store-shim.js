// Browser stand-in for expo-secure-store in the isolated UI fixture. It keeps the
// values in memory only (a page reload starts signed out, like before), and a test
// can pre-seed it with: window.__waselhaSecureStore = new Map([[key, value]]).
const memory = () => (globalThis.__waselhaSecureStore ??= new Map());
export const getItemAsync = async (key) => memory().get(key) ?? null;
export const setItemAsync = async (key, value) => void memory().set(key, value);
export const deleteItemAsync = async (key) => void memory().delete(key);
