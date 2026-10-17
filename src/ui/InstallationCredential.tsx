import { useEffect, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Input } from "@cloudflare/kumo/components/input";
import { request } from "./api";
import { ErrorNotice } from "./components";

type Account = { id: string; name: string };
export type InstallationCredentialStatus = {
  manageable: boolean;
  edition: "hosted" | "self-hosted";
  source: "installation" | "environment" | "none";
  state: "configured" | "missing_permission" | "missing";
  accountId?: string;
  workerName?: string;
  permissions?: string[];
  missing?: { key: string; label: string }[];
  verifiedAt?: string;
  tokenPageUrl?: string;
};
type SetResult = { stored: true; createdWorker: boolean; status: InstallationCredentialStatus } | { stored: false; accountSelectionRequired: true; accounts: Account[] };

const BASE = "/api/cloudflare/installation-credential";

export function loadInstallationCredential() { return request<InstallationCredentialStatus>(BASE); }

function stateLabel(status: InstallationCredentialStatus): string {
  if (status.state === "missing") return "Not set up";
  if (status.state === "missing_permission") return `Missing ${status.missing?.map((item) => item.label).join(", ")}`;
  return status.source === "environment" ? "Configured (deployment secret)" : "Configured";
}

export function InstallationCredentialPrompt({ onOpen }: { onOpen: () => void }) {
  const [status, setStatus] = useState<InstallationCredentialStatus | null>(null);
  useEffect(() => { let active = true; loadInstallationCredential().then((value) => { if (active) setStatus(value); }, () => {}); return () => { active = false; }; }, []);
  if (!status?.manageable || status.state === "configured") return null;
  return <section className="panel settings-cloudflare" aria-labelledby="installation-previews-prompt">
    <div className="settings-cloudflare-heading"><div><h2 id="installation-previews-prompt">{status.state === "missing" ? "Finish setup: turn on Worker previews" : "Worker previews need another permission"}</h2><p>{status.state === "missing" ? "Paste one Cloudflare API token so proposals of Worker apps get live previews and isolated D1 databases. No terminal needed." : `The installation token is missing ${status.missing?.map((item) => item.label).join(", ")}.`}</p></div></div>
    <Button variant="primary" size="base" onClick={onOpen}>Set up previews</Button>
  </section>;
}

export default function InstallationCredential() {
  const [status, setStatus] = useState<InstallationCredentialStatus | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [editing, setEditing] = useState(false);
  const [token, setToken] = useState("");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    let active = true;
    loadInstallationCredential().then((value) => { if (active) { setStatus(value); setEditing(value.manageable && value.state === "missing" && value.edition === "self-hosted"); } }, (failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : "Preview credential status could not be loaded."); });
    return () => { active = false; };
  }, []);

  async function perform(name: string, operation: () => Promise<void>) {
    setBusy(name); setError(""); setMessage("");
    try { await operation(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "The request failed."); }
    finally { setBusy(""); }
  }

  const save = () => perform("save", async () => {
    const result = await request<SetResult>(BASE, { token, ...(accountId ? { accountId } : {}) });
    if (!result.stored) { setAccounts(result.accounts); setMessage("This token can reach several accounts. Choose the one that should host previews, then save again."); return; }
    setStatus(result.status); setEditing(false); setToken(""); setAccounts([]); setAccountId("");
    setMessage(result.status.state === "missing_permission" ? "Saved. Worker previews are on, but apps that bind D1 need the missing permission." : `Saved. Worker previews are on${result.createdWorker ? ` and ${result.status.workerName} was created` : ""}.`);
  });

  const remove = () => perform("remove", async () => {
    const next = await request<InstallationCredentialStatus>(`${BASE}/remove`, {});
    setStatus(next);
    setMessage(next.source === "environment" ? "Removed. Previews now use the deployment secret." : "Removed. Worker previews are off; proposals use container previews.");
  });

  if (!status) return error ? <ErrorNotice message={error} /> : null;
  const hosted = status.edition === "hosted";
  const heading = hosted ? "Previews and deploys on this installation (operator credential)" : "Previews and deploys on this installation";
  if (!status.manageable) return <section className="panel">
    <div className="panel-header"><h2>{heading}</h2><span className={`cf-state${status.state === "configured" ? " cf-state-on" : ""}`}>{stateLabel(status)}</span></div>
    <div className="panel-body"><p className="cf-description">{hosted ? "Worker previews on this hosted installation use the operator’s Cloudflare credential. Only the operator workspace can change it." : "Only an owner of the installation workspace can change this credential."}</p></div>
  </section>;
  const configured = status.state !== "missing";
  return <section className="panel">
    <div className="panel-header"><h2>{heading}</h2><span className={`cf-state${status.state === "configured" ? " cf-state-on" : ""}`}>{status.state === "configured" && <span className="cf-connected-dot" />}{stateLabel(status)}</span></div>
    <div className="panel-body">
      <p className="cf-description">{hosted ? "The operator token that publishes Worker Previews and creates isolated preview D1 databases for every workspace on this hosted installation." : "One Cloudflare API token lets Gitflare publish Worker Previews and create isolated D1 databases for previews. It is stored encrypted and never shown again."}</p>
      {error && <ErrorNotice message={error} />}
      {message && <p className="cf-notice" role="status">{message}</p>}
      <dl className="cf-account-facts">
        <div><dt>Account ID</dt><dd>{status.accountId ? <code>{status.accountId}</code> : "Chosen from the token"}</dd></div>
        <div><dt>Previews Worker</dt><dd><code>{status.workerName}</code></dd></div>
        {status.source !== "none" && <div><dt>Source</dt><dd>{status.source === "installation" ? `Saved in Gitflare${status.verifiedAt ? `, verified ${new Date(status.verifiedAt).toLocaleString()}` : ""}` : "Deployment secret PREVIEWS_API_TOKEN"}</dd></div>}
      </dl>
      {!!status.missing?.length && <p className="cf-field-hint" role="status">Missing permission: {status.missing.map((item) => item.label).join(", ")}. Previews of apps that bind D1 fail until you replace the token with one that includes it.</p>}
      {editing ? <div className="installation-credential-form">
        <ol className="cf-description">
          <li><a href={status.tokenPageUrl} target="_blank" rel="noopener noreferrer">Open Cloudflare’s token page</a> with Workers Scripts: Edit and D1: Edit prefilled.</li>
          <li>Choose “Continue to summary”, then “Create Token”, and copy it.</li>
          <li>Paste it here. Gitflare checks it before saving.</li>
        </ol>
        <div className="cf-form-row">
          <label htmlFor="installation-token">Cloudflare API token<Input id="installation-token" type="password" autoComplete="off" spellCheck={false} value={token} onChange={(event) => setToken(event.target.value)} disabled={!!busy} /></label>
          {accounts.length > 1 && <label htmlFor="installation-account">Cloudflare account<select id="installation-account" value={accountId} onChange={(event) => setAccountId(event.target.value)} disabled={!!busy}><option value="">Choose an account</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>}
        </div>
        <div className="cf-actions"><Button variant="primary" size="base" disabled={!!busy || token.trim().length < 20 || (accounts.length > 1 && !accountId)} onClick={() => void save()}>{busy === "save" ? "Checking…" : "Verify and save"}</Button><Button variant="secondary" size="base" disabled={!!busy} onClick={() => { setEditing(false); setToken(""); setAccounts([]); setAccountId(""); }}>Cancel</Button></div>
      </div> : <div className="cf-actions">
        <Button variant={configured ? "secondary" : "primary"} size="base" disabled={!!busy} onClick={() => { setEditing(true); setMessage(""); }}>{status.source === "installation" ? "Replace" : "Set up"}</Button>
        {status.source === "installation" && <Button variant="secondary" size="base" disabled={!!busy} onClick={() => setConfirmRemove(true)}>Remove</Button>}
      </div>}
    </div>
    <Dialog.Root open={confirmRemove} onOpenChange={setConfirmRemove}>
      <Dialog size="sm" className="dialog-content confirm-dialog">
        <Dialog.Title className="dialog-title">Remove the previews credential?</Dialog.Title>
        <Dialog.Description className="dialog-description">Gitflare deletes the saved token. Previews then use the deployment secret if one exists, otherwise proposals fall back to container previews. Nothing in your Cloudflare account changes; revoke the token in Cloudflare if you no longer need it.</Dialog.Description>
        <div className="dialog-actions"><Button variant="secondary" size="base" type="button" onClick={() => setConfirmRemove(false)}>Cancel</Button><Button variant="primary" size="base" type="button" onClick={() => { setConfirmRemove(false); void remove(); }}>Remove</Button></div>
      </Dialog>
    </Dialog.Root>
  </section>;
}
