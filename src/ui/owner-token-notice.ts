export const OWNER_TOKEN_NOTICE_KEY = "gitflare:owner-token-notice";

export const OWNER_TOKEN_NOTICE = {
  title: "Use your Cloudflare login",
  description: "The owner token is a shared break-glass credential. Everything you do with it is recorded as the bootstrap Owner, not as you. Sign in with your own Cloudflare login so your actions carry your name.",
  primary: "Sign in with Cloudflare",
  secondary: "Continue with owner token",
} as const;

type SessionStore = Pick<Storage, "getItem" | "setItem">;

function browserSession(): SessionStore | null {
  try { return typeof sessionStorage === "undefined" ? null : sessionStorage; } catch { return null; }
}

export function ownerTokenNoticeDue(storage: SessionStore | null = browserSession()): boolean {
  try { return storage?.getItem(OWNER_TOKEN_NOTICE_KEY) !== "shown"; } catch { return true; }
}

export function markOwnerTokenNoticeShown(storage: SessionStore | null = browserSession()): void {
  try { storage?.setItem(OWNER_TOKEN_NOTICE_KEY, "shown"); } catch { return; }
}

export function showOwnerTokenNotice(signedInWithOwnerToken: boolean, storage: SessionStore | null = browserSession()): boolean {
  if (!signedInWithOwnerToken || !ownerTokenNoticeDue(storage)) return false;
  markOwnerTokenNoticeShown(storage);
  return true;
}
