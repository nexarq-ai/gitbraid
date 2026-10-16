import { useEffect, useRef, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { request } from "./api";
import { ErrorNotice } from "./components";

type AccessMode = "link" | "cloudflare-access";
type Snapshot = {
  repositoryId: string;
  canChange: boolean;
  settings: { lifetimeMinutes: number; access: AccessMode; accessEmailDomains: string[]; targetWorker?: string; updatedAt?: string };
  lifetime: { minutes: number; choices: number[]; maxMinutes: number };
  target: { workerName: string; configPath?: string; accountId?: string; connection?: "repository" | "workspace"; connectionCanPreview: boolean } | null;
  access: { description: string; containerDescription: string; cloudflareAccess: { available: boolean; reason?: string } };
  accessApp?: { domain: string; accountId: string; workerName: string };
};

const LIFETIME_LABELS: Record<number, string> = { 15: "15 minutes", 60: "1 hour", 240: "4 hours", 1440: "24 hours" };
const domainsText = (domains: string[]) => domains.join("\n");
const parseDomains = (text: string) => text.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);

export default function PreviewSettings({ repositoryId, onNotify }: { repositoryId: string; onNotify: (message: string) => void }) {
  const path = `/api/repositories/${encodeURIComponent(repositoryId)}/preview-settings`;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [lifetime, setLifetime] = useState(15);
  const [access, setAccess] = useState<AccessMode>("link");
  const [domains, setDomains] = useState("");
  const [targetWorker, setTargetWorker] = useState("");
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mutation = useRef<{ signature: string; key: string } | null>(null);

  function show(current: Snapshot) {
    setSnapshot(current);
    setLifetime(current.settings.lifetimeMinutes);
    setAccess(current.settings.access);
    setDomains(domainsText(current.settings.accessEmailDomains));
    setTargetWorker(current.settings.targetWorker ?? "");
  }

  useEffect(() => {
    let active = true;
    setLoadError("");
    request<Snapshot>(path)
      .then((current) => { if (active) show(current); })
      .catch((failure) => { if (active) setLoadError(failure instanceof Error ? failure.message : "Preview settings could not be loaded."); });
    return () => { active = false; };
  }, [path, attempt]);

  async function save() {
    if (busy || !snapshot) return;
    const body = { lifetimeMinutes: lifetime, access, accessEmailDomains: parseDomains(domains), targetWorker: targetWorker.trim() };
    const signature = JSON.stringify(body);
    if (mutation.current?.signature !== signature) mutation.current = { signature, key: crypto.randomUUID() };
    setBusy(true);
    setError("");
    try {
      const saved = await request<Snapshot>(path, body, mutation.current.key);
      mutation.current = null;
      show(saved);
      onNotify(saved.accessApp ? `Preview settings saved. Cloudflare Access now protects ${saved.accessApp.domain}.` : "Preview settings saved. New previews use them.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Preview settings could not be saved.");
    } finally { setBusy(false); }
  }

  if (loadError) return <ErrorNotice message={loadError} onRetry={() => setAttempt((value) => value + 1)} />;
  if (!snapshot) return null;
  const { canChange, target } = snapshot;
  const accessAvailable = snapshot.access.cloudflareAccess.available;
  return (
    <section className="panel check-settings">
      <div className="panel-header"><h2>Previews</h2></div>
      <div className="panel-body">
        <p className="branch-rule-note">
          {target
            ? <>Worker previews run as Cloudflare Worker Previews of <code>{target.workerName}</code>{target.accountId ? <> on account <code>{target.accountId}</code> through the {target.connection} Cloudflare connection</> : null}{target.connectionCanPreview ? "." : ", once a Cloudflare connection with workers-scripts.edit can reach it."} Gitflare never creates a Worker for previews; if the Worker does not exist yet, previews use this installation’s previews Worker or a preview container.</>
            : <>No preview Worker is set. Worker previews use this installation’s previews Worker, or a preview container. Set a deploy target, link a Worker, or name the preview Worker below.</>}
        </p>
        <p className="branch-rule-note">Every preview is retired automatically when its lifetime ends: the Worker Preview is deleted, or the container is destroyed, and the workspace preview slot is released. Owners and Maintainers can extend a ready preview once.</p>
        {!canChange && <p className="branch-rule-note">Only Owners can change preview settings.</p>}
        <fieldset className="check-settings-fields" disabled={!canChange || busy}>
          <div className="form-field">
            <label htmlFor="preview-lifetime">Preview lifetime</label>
            <select id="preview-lifetime" value={lifetime} onChange={(event) => setLifetime(Number(event.target.value))}>
              {snapshot.lifetime.choices.map((minutes) => <option key={minutes} value={minutes}>{LIFETIME_LABELS[minutes] ?? `${minutes} minutes`}</option>)}
            </select>
            <small>This installation allows at most {LIFETIME_LABELS[snapshot.lifetime.maxMinutes] ?? `${snapshot.lifetime.maxMinutes} minutes`}.</small>
          </div>
          <div className="form-field">
            <label htmlFor="preview-target">Preview Worker <span className="proposal-optional">(optional)</span></label>
            <Input id="preview-target" maxLength={63} value={targetWorker} placeholder={target?.workerName ?? "my-worker"} onChange={(event) => setTargetWorker(event.target.value.toLowerCase())} />
            <small>For repositories with several Workers: the Worker whose Previews host this repository. Empty uses the deploy target for the root Wrangler configuration.</small>
          </div>
        </fieldset>
        <fieldset className="check-settings-fields" disabled={!canChange || busy}>
          <label className="check-settings-toggle"><input type="radio" name="preview-access" checked={access === "link"} onChange={() => setAccess("link")} />Unguessable link (public to anyone with the link)</label>
          <label className="check-settings-toggle"><input type="radio" name="preview-access" checked={access === "cloudflare-access"} disabled={!accessAvailable && access !== "cloudflare-access"} onChange={() => setAccess("cloudflare-access")} />Cloudflare Access on the connected account</label>
          {!accessAvailable && <small className="branch-rule-note">{snapshot.access.cloudflareAccess.reason}</small>}
          {access === "cloudflare-access" && (
            <div className="form-field">
              <label htmlFor="preview-domains">Allowed email domains <span className="proposal-optional">(optional, one per line)</span></label>
              <textarea id="preview-domains" rows={2} value={domains} placeholder="example.com" onChange={(event) => setDomains(event.target.value)} />
              <small>Empty allows the email of every workspace member who can read this repository.</small>
            </div>
          )}
        </fieldset>
        <p className="branch-rule-note">{snapshot.access.description} {snapshot.access.containerDescription}</p>
        {error && <div className="error-notice" role="alert">{error}</div>}
        {canChange && <div className="branch-rule-actions"><Button variant="primary" size="base" loading={busy} disabled={busy} onClick={() => void save()}>Save preview settings</Button></div>}
      </div>
    </section>
  );
}
