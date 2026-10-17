import { useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { request } from "./api";
import cloudflareIcon from "./assets/cloudflare-icon.svg";
import { OWNER_TOKEN_NOTICE } from "./owner-token-notice";

export default function OwnerTokenNotice({ open, cloudflareAvailable, onContinue }: { open: boolean; cloudflareAvailable: boolean; onContinue: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function signInWithCloudflare() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      await request("/api/session/logout", {}).catch(() => undefined);
      const result = await request<{ authorizationUrl: string }>("/api/auth/cloudflare/start", {});
      window.location.assign(result.authorizationUrl);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Cloudflare sign-in could not start. Try again."); setBusy(false); }
  }
  return <Dialog.Root open={open} onOpenChange={(next) => { if (!next && !busy) onContinue(); }}>
    <Dialog size="sm" className="dialog-content confirm-dialog">
      <Dialog.Title className="dialog-title">{OWNER_TOKEN_NOTICE.title}</Dialog.Title>
      <Dialog.Description className="dialog-description">{OWNER_TOKEN_NOTICE.description}</Dialog.Description>
      {!cloudflareAvailable && <p className="dialog-description">Sign in with Cloudflare is not configured for this installation yet.</p>}
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="dialog-actions">
        <Button variant="secondary" size="base" type="button" disabled={busy} onClick={onContinue}>{OWNER_TOKEN_NOTICE.secondary}</Button>
        <Button variant="primary" size="base" type="button" loading={busy} disabled={!cloudflareAvailable} onClick={() => void signInWithCloudflare()}><img src={cloudflareIcon} alt="" width="16" height="16"/>{OWNER_TOKEN_NOTICE.primary}</Button>
      </div>
    </Dialog>
  </Dialog.Root>;
}
