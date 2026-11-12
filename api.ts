import { createClient } from "@supabase/supabase-js";
const url = import.meta.env.VITE_SUPABASE_URL,
  key = import.meta.env.VITE_SUPABASE_ANON_KEY;
export const configured = !!url && !!key && !url.includes("SEU_PROJETO");
export const auth = configured ? createClient(url, key) : null;
export async function api(route: string, options: RequestInit = {}) {
  const { data } = await auth!.auth.getSession();
  const headers = new Headers(options.headers);
  headers.set("Authorization", "Bearer " + data.session?.access_token);
  if (options.body && !(options.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  const res = await fetch("/api" + route, { ...options, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw Error(body.error || "Falha na comunicação. Tente novamente.");
  }
  return [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ].some((type) => res.headers.get("content-type")?.includes(type))
    ? res.blob()
    : res.json();
}
