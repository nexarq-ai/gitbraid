import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { ArrowClockwiseIcon, GitBranchIcon, LockKeyIcon } from "@phosphor-icons/react";
import { request, selectWorkspace } from "./api";
import "./auth-loading.css";
import "./public-install.css";

export type AuthConfig = { edition: "hosted" | "self-hosted"; setupRequired: boolean; publicSignup: boolean; mfaRequired: boolean };
type Challenge = { challengeId: string; enrollmentRequired: boolean; secret?: string; otpauthUri?: string; expiresAt: number };
type AuthResult = { mfaRequired?: boolean; recoveryCodes?: string[] } & Partial<Challenge>;
type Props = { state: "checking" | "required" | "configuration" | "unavailable"; error: string; onRetry: () => Promise<void>; onSignedIn: () => Promise<void>; mode?: string; invitationToken?: string; config: AuthConfig; onFlowChange: (active: boolean) => void };

export default function AuthScreen({ state, error, onRetry, onSignedIn, config, onFlowChange, invitationToken }: Props) {
  useEffect(() => () => onFlowChange(false), []);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [useRecovery, setUseRecovery] = useState(false);
  const [savedCodes, setSavedCodes] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const setup = config.setupRequired;
  const invited = !!invitationToken;

  async function finish() {
    onFlowChange(false);
    window.location.hash = "overview";
    await onSignedIn();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const fields = new FormData(event.currentTarget);
    setBusy(true);
    setFormError("");
    onFlowChange(true);
    try {
      selectWorkspace("");
      const path = challenge ? setup ? "/api/setup/verify" : "/api/mfa/verify" : setup ? "/api/setup/start" : invited ? "/api/invitations/register" : "/api/login";
      const body = challenge ? { challengeId: challenge.challengeId, ...(fields.get("recoveryCode") ? { recoveryCode: fields.get("recoveryCode") } : { code: fields.get("code") }) } : setup ? { setupToken: fields.get("setupToken"), name: fields.get("name"), email: fields.get("email"), password: fields.get("password"), workspaceName: fields.get("workspaceName") } : invited ? { token: invitationToken, name: fields.get("name"), email: fields.get("email"), password: fields.get("password") } : { email: fields.get("email"), password: fields.get("password") };
      const result = await request<AuthResult>(path, body);
      if (result.mfaRequired && result.challengeId) {
        setChallenge(result as Challenge);
        return;
      }
      setChallenge(null);
      if (result.recoveryCodes?.length) {
        setRecoveryCodes(result.recoveryCodes);
        return;
      }
      await finish();
    } catch (failure) {
      setFormError(failure instanceof Error ? failure.message : "Sign-in could not be completed. Try again.");
      if (!challenge) onFlowChange(false);
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    setBusy(true);
    try { await onRetry(); } finally { setBusy(false); }
  }

  if (state === "checking") return <main className="workspace-loading-screen"><div className="workspace-loading-content"><div className="workspace-loading-status" role="status"><div className="workspace-loading-brand" aria-hidden="true"><GitBranchIcon size={30} weight="bold"/><span>gitflare</span></div><p>Loading workspace</p></div></div></main>;
  const title = recoveryCodes.length ? "Save your recovery codes" : challenge ? challenge.enrollmentRequired ? "Set up your authenticator" : "Verify your sign-in" : setup ? "Set up your Gitflare" : invited ? "Create your invited account" : "Welcome back";
  return <main className="auth-screen"><div className="auth-content"><a className="auth-brand" href="#signin"><span className="brand-icon"><GitBranchIcon size={20} weight="bold"/></span><span>gitflare</span></a>{state === "required" || setup ? <section className="auth-card" aria-labelledby="sign-in-title"><h1 id="sign-in-title">{title}</h1><p className="auth-description">{recoveryCodes.length ? "Keep these single-use codes somewhere private." : challenge ? "Enter a current six-digit authenticator code." : setup ? "Create this installation's administrator and verify an authenticator before opening the workspace." : "Sign in to your Gitflare workspace."}</p>{recoveryCodes.length ? <><pre className="auth-recovery-codes">{recoveryCodes.join("\n")}</pre><label className="access-checkbox"><input type="checkbox" required onChange={event => setSavedCodes(event.target.checked)}/>I saved my recovery codes</label><Button variant="primary" disabled={!savedCodes} onClick={() => { setRecoveryCodes([]); void finish(); }}>Open workspace</Button></> : <form key={challenge?.challengeId || "credentials"} onSubmit={event => void submit(event)}>{challenge ? <>{challenge.enrollmentRequired && <div className="auth-enrollment"><p>Add this setup key to your authenticator. Account: your Gitflare email. Type: time based (TOTP).</p><code>{challenge.secret}</code></div>}{useRecovery ? <AuthField label="Recovery code" name="recoveryCode" autoComplete="off"/> : <AuthField label="Authenticator code" name="code" autoComplete="one-time-code" minLength={6}/>} {!challenge.enrollmentRequired && <button className="auth-owner-toggle" type="button" onClick={() => setUseRecovery(!useRecovery)}>{useRecovery ? "Use authenticator code" : "Use a recovery code"}</button>}<button type="button" className="auth-owner-toggle" onClick={() => { setChallenge(null); setUseRecovery(false); setFormError(""); onFlowChange(false); }}>Start sign-in again</button></> : <>{setup && <><AuthField label="Installation setup token" name="setupToken" type="password"/><AuthField label="Your name" name="name" autoComplete="name"/></>}{invited && !setup && <AuthField label="Your name" name="name" autoComplete="name"/>}<AuthField label="Email" name="email" type="email" autoComplete="email"/><AuthField label="Password" name="password" type="password" minLength={setup || invited ? 12 : undefined} autoComplete={setup || invited ? "new-password" : "current-password"}/>{setup && <><p className="auth-field-hint">Use at least 12 characters.</p><AuthField label="Workspace name" name="workspaceName"/></>}</>}{formError && <div className="form-error" role="alert">{formError}</div>}<Button variant="primary" size="base" type="submit" loading={busy} className="auth-submit">{challenge ? "Verify" : setup ? "Create administrator" : invited ? "Create invited account" : "Sign in"}</Button></form>}<p className="auth-security"><LockKeyIcon size={13}/>Private workspace</p></section> : <section className="auth-card"><h1>{state === "configuration" ? "Sign-in is not configured" : "Workspace unavailable"}</h1><p className="auth-description" role="alert">{error || "The workspace could not be reached. Try again."}</p><Button variant="secondary" size="base" icon={ArrowClockwiseIcon} loading={busy} onClick={() => void retry()}>Try again</Button></section>}<a className="auth-back" href="#docs/overview">Documentation</a></div></main>;
}

function AuthField({ label, name, type = "text", autoComplete, minLength }: { label: string; name: string; type?: string; autoComplete?: string; minLength?: number }) {
  return <div className="form-field"><label htmlFor={`auth-${name}`}>{label}</label><Input id={`auth-${name}`} name={name} type={type} required maxLength={name === "code" ? 6 : 256} inputMode={name === "code" ? "numeric" : undefined} pattern={name === "code" ? "[0-9]{6}" : undefined} minLength={minLength} autoComplete={autoComplete}/></div>;
}
