import type { AppData, SessionUser } from "./types";

const JSON_HEADERS = { "Content-Type": "application/json" };

export async function login(username: string, password: string): Promise<{ token: string; user: SessionUser }> {
  const response = await fetch("/api/auth/login", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).message || "Unable to sign in");
  return response.json();
}

export async function getBootstrap(token: string): Promise<AppData> {
  const response = await fetch("/api/bootstrap", { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error("Unable to load operations data");
  return response.json();
}

export async function apiRequest<T>(token: string, path: string, method = "POST", body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).message || "Request failed");
  return response.json();
}
