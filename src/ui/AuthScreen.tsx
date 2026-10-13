import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { ArrowClockwiseIcon, GitBranchIcon, LockKeyIcon } from "@phosphor-icons/react";
import { request, selectWorkspace } from "./api";
import "./auth-loading.css";
import "./public-install.css";

export type AuthConfig = { edition: "hosted" | "self-hosted"; setupRequired: boolean; publicSignup: boolean; mfaRequired: boolean; passwordReset?: boolean; emailVerification?: boolean; setupMode?: "admin-credentials" | "setup-token" | "unconfigured" };
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
  const setupTokenRequired = config.setupMode === "setup-token";
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
      const body = challenge ? { challengeId: challenge.challengeId, ...(fields.get("recoveryCode") ? { recoveryCode: fields.get("recoveryCode") } : { code: fields.get("code") }) } : setup ? { ...(setupTokenRequired ? { setupToken: fields.get("setupToken") } : {}), name: fields.get("name"), email: fields.get("email"), password: fields.get("password"), workspaceName: fields.get("workspaceName") } : invited ? { token: invitationToken, name: fields.get("name"), email: fields.get("email"), password: fields.get("password") } : { email: fields.get("email"), password: fields.get("password") };
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
  return <main className="auth-screen"><div className="auth-content"><a className="auth-brand" href="#signin"><span className="brand-icon"><GitBranchIcon size={20} weight="bold"/></span><span>gitflare</span></a>{state === "required" || setup ? <section className="auth-card" aria-labelledby="sign-in-title"><h1 id="sign-in-title">{title}</h1><p className="auth-description">{recoveryCodes.length ? "Keep these single-use codes somewhere private." : challenge ? "Enter a current six-digit authenticator code." : setup ? config.setupMode === "unconfigured" ? "The deployment needs an administrator email and password before setup can continue." : setupTokenRequired ? "Create this installation's administrator and verify an authenticator before opening the workspace." : "Use the administrator email and password supplied during deployment, then enroll your authenticator." : "Sign in to your Gitflare workspace."}</p>{recoveryCodes.length ? <><pre className="auth-recovery-codes">{recoveryCodes.join("\n")}</pre><label className="access-checkbox"><input type="checkbox" required onChange={event => setSavedCodes(event.target.checked)}/>I saved my recovery codes</label><Button variant="primary" disabled={!savedCodes} onClick={() => { setRecoveryCodes([]); void finish(); }}>Open workspace</Button></> : <form key={challenge?.challengeId || "credentials"} onSubmit={event => void submit(event)}>{challenge ? <>{challenge.enrollmentRequired && <div className="auth-enrollment"><p>Add this setup key to your authenticator. Account: your Gitflare email. Type: time based (TOTP).</p><code>{challenge.secret}</code></div>}{useRecovery ? <AuthField label="Recovery code" name="recoveryCode" autoComplete="off"/> : <AuthField label="Authenticator code" name="code" autoComplete="one-time-code" minLength={6}/>} {!challenge.enrollmentRequired && <button className="auth-owner-toggle" type="button" onClick={() => setUseRecovery(!useRecovery)}>{useRecovery ? "Use authenticator code" : "Use a recovery code"}</button>}<button type="button" className="auth-owner-toggle" onClick={() => { setChallenge(null); setUseRecovery(false); setFormError(""); onFlowChange(false); }}>Start sign-in again</button></> : <>{setup && <>{setupTokenRequired && <AuthField label="Installation setup token" name="setupToken" type="password"/>}<AuthField label="Your name" name="name" autoComplete="name"/></>}{invited && !setup && <AuthField label="Your name" name="name" autoComplete="name"/>}<AuthField label="Email" name="email" type="email" autoComplete="email"/><AuthField label="Password" name="password" type="password" minLength={setup || invited ? 12 : undefined} autoComplete={invited || setupTokenRequired ? "new-password" : "current-password"}/>{setup && <><p className="auth-field-hint">Use at least 12 characters.</p><AuthField label="Workspace name" name="workspaceName"/></>}</>}{formError && <div className="form-error" role="alert">{formError}</div>}<Button variant="primary" size="base" type="submit" loading={busy} disabled={setup && config.setupMode === "unconfigured"} className="auth-submit">{challenge ? "Verify" : setup ? "Continue administrator setup" : invited ? "Create invited account" : "Sign in"}</Button></form>}<p className="auth-security"><LockKeyIcon size={13}/>Private workspace</p></section> : <section className="auth-card"><h1>{state === "configuration" ? "Sign-in is not configured" : "Workspace unavailable"}</h1><p className="auth-description" role="alert">{error || "The workspace could not be reached. Try again."}</p><Button variant="secondary" size="base" icon={ArrowClockwiseIcon} loading={busy} onClick={() => void retry()}>Try again</Button></section>}<a className="auth-back" href="#docs/overview">Documentation</a></div></main>;
}

function AuthField({ label, name, type = "text", autoComplete, minLength }: { label: string; name: string; type?: string; autoComplete?: string; minLength?: number }) {
  return <div className="form-field"><label htmlFor={`auth-${name}`}>{label}</label><Input id={`auth-${name}`} name={name} type={type} required maxLength={name === "code" ? 6 : 256} inputMode={name === "code" ? "numeric" : undefined} pattern={name === "code" ? "[0-9]{6}" : undefined} minLength={minLength} autoComplete={autoComplete}/></div>;
}

const ACCOUNT_ROUTES = ["forgot-password", "reset-password", "verify-email"];
export function isAccountRoute(route: string): boolean { return ACCOUNT_ROUTES.includes(route.split("/")[0]); }
function failureMessage(failure: unknown, fallback: string): string { return failure instanceof Error ? failure.message : fallback; }
export function AccountScreen({ route, config, authenticated, onChanged }: { route: string; config: AuthConfig; authenticated: boolean; onChanged: () => Promise<void> }) {
  const [kind, linkToken = ""] = route.split("/");
  const [token] = useState(linkToken);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [done, setDone] = useState(false);
  // Link tokens are bearer secrets and must not stay in the address bar or history
  useEffect(() => { if (linkToken) window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${kind}`); }, [kind, linkToken]);
  const validToken = /^[a-f0-9]{64}$/i.test(token);
  async function run(task: () => Promise<unknown>, fallback: string) {
    if (busy) return;
    setBusy(true); setFailure("");
    try { await task(); setDone(true); } catch (caught) { setFailure(failureMessage(caught, fallback)); } finally { setBusy(false); }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    if (kind === "forgot-password") return void run(() => request("/api/auth/password-reset/request", { email: fields.get("email") }), "The reset email could not be requested. Try again.");
    if (fields.get("password") !== fields.get("confirmation")) return setFailure("The two passwords do not match.");
    void run(() => request("/api/auth/password-reset/confirm", { token, password: fields.get("password") }), "The password could not be changed. Try again.");
  }
  const verify = () => run(async () => { await request("/api/auth/verify-email", { token }); if (authenticated) await onChanged(); }, "The email address could not be verified. Try again.");
  const home = authenticated ? "#overview" : "#signin";
  const homeLabel = authenticated ? "Return to your workspace" : "Back to sign in";
  let title: string; let description: string; let content: ReactNode = null;
  if (kind === "forgot-password") {
    title = done ? "Check your email" : "Reset your password";
    description = done ? "If an account exists for that address, a password reset link is on its way. The link expires after 1 hour." : config.passwordReset === false ? "This installation has no email sender configured. Ask its administrator to reset your access." : "Enter your account email and we will send a link to choose a new password.";
    if (!done && config.passwordReset !== false) content = <form onSubmit={submit}><AuthField label="Email" name="email" type="email" autoComplete="email"/>{failure && <div className="form-error" role="alert">{failure}</div>}<Button variant="primary" size="base" type="submit" loading={busy} className="auth-submit">Send reset link</Button></form>;
  } else if (kind === "reset-password") {
    title = done ? "Password changed" : validToken ? "Choose a new password" : "Reset link is incomplete";
    description = done ? "Every session was signed out. Sign in with your new password." : validToken ? "The new password replaces the old one and signs out every session. Your authenticator stays the same." : "Request a new password reset link and open it from your email.";
    if (!done && validToken) content = <form onSubmit={submit}><AuthField label="New password" name="password" type="password" minLength={12} autoComplete="new-password"/><p className="auth-field-hint">Use at least 12 characters.</p><AuthField label="Confirm new password" name="confirmation" type="password" minLength={12} autoComplete="new-password"/>{failure && <div className="form-error" role="alert">{failure}</div>}<Button variant="primary" size="base" type="submit" loading={busy} className="auth-submit">Change password</Button></form>;
    else if (!done) content = <p className="auth-switch"><a href="#forgot-password">Request a new link</a></p>;
  } else {
    title = done ? "Email verified" : validToken ? "Verify your email address" : "Verification link is incomplete";
    description = done ? "Thanks. Your email address is confirmed." : validToken ? "Confirm that this email address belongs to you." : "Sign in and resend the verification email from your account settings.";
    if (!done && validToken) content = <>{failure && <div className="form-error" role="alert">{failure}</div>}<Button variant="primary" size="base" loading={busy} className="auth-submit" onClick={() => void verify()}>Verify email address</Button></>;
  }
  return <main className="auth-screen"><div className="auth-content"><a className="auth-brand" href={config.edition === "hosted" ? "#home" : "#signin"}><span className="brand-icon"><GitBranchIcon size={20} weight="bold"/></span><span>gitflare</span></a><section className="auth-card" aria-labelledby="account-title"><h1 id="account-title">{title}</h1><p className="auth-description" role={done ? "status" : undefined}>{description}</p>{content}<p className="auth-switch"><a href={home}>{homeLabel}</a></p></section></div></main>;
}
export function VerifyEmailNotice({ user }: { user: { email?: string; emailVerified?: boolean } }) {
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const pending = Boolean(user.email) && user.emailVerified === false;
  useEffect(() => { if (!pending) return; let current = true; request<AuthConfig>("/api/auth/config").then(config => { if (current) setAvailable(config.emailVerification === true); }, () => {}); return () => { current = false; }; }, [pending]);
  if (!pending || !available) return null;
  async function resend() {
    setBusy(true); setMessage("");
    try { await request("/api/auth/resend-verification", {}); setMessage(`Verification email sent to ${user.email}.`); } catch (caught) { setMessage(failureMessage(caught, "The verification email could not be sent. Try again.")); } finally { setBusy(false); }
  }
  return <div className="verify-email-notice" role="status"><span>{message || "Verify your email address so you can recover this account."}</span><Button variant="secondary" size="sm" loading={busy} onClick={() => void resend()}>Resend email</Button></div>;
}
