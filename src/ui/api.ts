import type { ApiError } from "../shared/types";

export class RequestError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}

let workspaceId = "";

export function selectWorkspace(id: string) { workspaceId = id; }

export async function request<T>(
  path: string,
  body?: unknown,
  key?: string,
): Promise<T> {
  const response = await fetch(path, {
    signal: body === undefined ? AbortSignal.timeout(30000) : undefined,
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: {
      ...(workspaceId ? { "X-Gitflare-Workspace": workspaceId } : {}),
      ...(body === undefined ? {} : {
            "Content-Type": "application/json",
            "Idempotency-Key": key ?? crypto.randomUUID(),
          }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json().catch(() => null)) as T | ApiError | null;
  if (!response.ok) {
    if (response.status === 401 && !["/api/session", "/api/login"].includes(path))
      window.dispatchEvent(new Event("gitflare:session-required"));
    const error =
      data && typeof data === "object" && "error" in data
        ? (data as ApiError).error
        : null;
    throw new RequestError(
      error?.message ??
        `The request could not be completed (${response.status}). Try again.`,
      response.status,
      error?.code,
    );
  }
  if (!data)
    throw new RequestError(
      "The server returned an empty response. Try again.",
      response.status,
    );
  return data as T;
}
