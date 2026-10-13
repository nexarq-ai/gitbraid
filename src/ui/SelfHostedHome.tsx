import { useEffect } from "react";
export default function SelfHostedHome({ authenticated }: { authenticated: boolean }) {
  useEffect(() => { window.location.hash = authenticated ? "overview" : "signin"; }, [authenticated]);
  return <main className="auth-screen"><p role="status">Opening your Gitflare installation…</p></main>;
}
