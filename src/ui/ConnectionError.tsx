import { useEffect, useRef } from "react";
import { ArrowClockwiseIcon, ArrowLeftIcon, BookOpenIcon, GitBranchIcon } from "@phosphor-icons/react";
import ThemeToggle from "./ThemeToggle";
import "./connection-error.css";

type Props = { error: string; onRetry: () => void };

export default function ConnectionError({ error, onRetry }: Props) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, []);
  return <main className="connection-error" aria-labelledby="connection-error-title">
    <header className="connection-error-header"><a className="connection-error-brand" href="/" aria-label="Gitflare home"><GitBranchIcon size={23} weight="bold" /><span>gitflare</span></a><ThemeToggle /></header>
    <section className="connection-error-content">
      <div className="connection-error-illustration" aria-hidden="true"><svg viewBox="0 0 300 140" fill="none"><path className="connection-error-track" d="M30 104H83Q104 104 118 82L136 55M164 55H200Q222 55 240 35H270"/><path className="connection-error-track connection-error-track-muted" d="M30 35H74Q96 35 115 55H136M164 55H200Q222 55 240 104H270"/><circle className="connection-error-endpoint" cx="30" cy="104" r="6"/><circle className="connection-error-endpoint connection-error-endpoint-muted" cx="30" cy="35" r="5"/><circle className="connection-error-endpoint connection-error-endpoint-muted" cx="270" cy="35" r="5"/><circle className="connection-error-endpoint connection-error-endpoint-muted" cx="270" cy="104" r="5"/><rect className="connection-error-interruption-halo" x="119" y="24" width="62" height="62" rx="22"/><rect className="connection-error-interruption" x="128" y="33" width="44" height="44" rx="15"/><path className="connection-error-break" d="m145 50-3 3a5 5 0 0 0 7 7l2-2M155 60l3-3a5 5 0 0 0-7-7l-2 2M141 45l18 20"/><path className="connection-error-spark" d="M147 12v-5M185 29l5-3M114 81l-5 3"/></svg></div>
      <h1 id="connection-error-title" ref={heading} tabIndex={-1} aria-describedby="connection-error-description">Unable to connect</h1>
      <p id="connection-error-description" className="connection-error-description">Gitflare couldn’t load the information needed to open this page. Check your connection and try again.</p>
      <div className="connection-error-actions"><button type="button" className="connection-error-retry" onClick={onRetry}><ArrowClockwiseIcon size={17} />Retry connection</button><a className="connection-error-home" href="/"><ArrowLeftIcon size={15} />Back to home</a></div>
      {error && <details className="connection-error-details"><summary>Technical details</summary><pre>{error}</pre></details>}
    </section>
    <footer className="connection-error-footer"><a href="/docs/overview"><BookOpenIcon size={14} />Read the documentation</a></footer>
  </main>;
}
