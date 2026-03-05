const TOKEN_KEY = "remote_llm_access_key";

export function loadStoredToken(): string {
  if (typeof window === "undefined") return "";
  const fromSession = window.sessionStorage.getItem(TOKEN_KEY) ?? "";
  if (fromSession.trim()) return fromSession;
  const fromLegacy = window.localStorage.getItem(TOKEN_KEY) ?? "";
  if (fromLegacy.trim()) {
    window.sessionStorage.setItem(TOKEN_KEY, fromLegacy);
    window.localStorage.removeItem(TOKEN_KEY);
  }
  return fromLegacy;
}

export function storeToken(value: string) {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(TOKEN_KEY, value);
  window.localStorage.removeItem(TOKEN_KEY);
}

export function clearStoredToken() {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(TOKEN_KEY);
}
