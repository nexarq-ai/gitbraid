import { useEffect } from "react";
import { navigate as goTo } from "./router";
export default function SelfHostedHome({ authenticated }: { authenticated: boolean }) {
  useEffect(() => { goTo(authenticated ? "overview" : "signin", true); }, [authenticated]);
  return <main className="auth-screen"><p role="status">Opening your Gitflare installation…</p></main>;
}
