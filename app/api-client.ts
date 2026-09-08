import type { AppData, SessionUser } from "./types";

const JSON_HEADERS = { "Content-Type": "application/json" };
let activeAccessToken = "";
let accessTokenListener: ((token: string) => void) | null = null;
let sessionExpiredListener: (() => void) | null = null;
let refreshInFlight: Promise<string> | null = null;

const requestId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

export function configureApiSession(token: string, onAccessToken: (token: string) => void, onSessionExpired: () => void) {
  activeAccessToken = token;
  accessTokenListener = onAccessToken;
  sessionExpiredListener = onSessionExpired;
}

export function clearApiSession() {
  activeAccessToken = "";
  accessTokenListener = null;
  sessionExpiredListener = null;
  refreshInFlight = null;
}

const fetchWithRequestId = (path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  if (!headers.has("X-Request-ID")) headers.set("X-Request-ID", requestId());
  return fetch(path, { ...init, headers, credentials: "include" });
};

const refreshAccessToken = async () => {
  if (!refreshInFlight) {
    refreshInFlight = fetchWithRequestId("/api/auth/refresh", { method: "POST" }).then(async (response) => {
      if (!response.ok) throw new Error("Your session expired. Sign in again.");
      const result = await response.json() as { accessToken?: string; token?: string };
      const nextToken = result.accessToken || result.token || "";
      if (!nextToken) throw new Error("The server did not return a new access token.");
      activeAccessToken = nextToken;
      accessTokenListener?.(nextToken);
      return nextToken;
    }).catch((error) => {
      activeAccessToken = "";
      sessionExpiredListener?.();
      throw error;
    }).finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
};

export async function authenticatedFetch(path: string, init: RequestInit = {}, tokenOverride = "") {
  const send = (token: string) => {
    const headers = new Headers(init.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return fetchWithRequestId(path, { ...init, headers });
  };
  let response = await send(activeAccessToken || tokenOverride);
  if (response.status === 401) response = await send(await refreshAccessToken());
  return response;
}

export async function login(username: string, password: string): Promise<{ token: string; accessToken: string; accessTokenExpiresIn: string; user: SessionUser }> {
  const response = await fetchWithRequestId("/api/auth/login", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).message || "Unable to sign in");
  return response.json();
}

export async function logoutSession() {
  await fetchWithRequestId("/api/auth/logout", { method: "POST" }).catch(() => undefined);
}

export async function getBootstrap(token: string): Promise<AppData> {
  const response = await authenticatedFetch("/api/bootstrap", {}, token);
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).message || "Unable to load operations data");
  return response.json();
}

export async function apiRequest<T>(token: string, path: string, method = "POST", body?: unknown): Promise<T> {
  const response = await authenticatedFetch(path, {
    method,
    headers: JSON_HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  }, token);
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).message || "Request failed");
  return response.json();
}
