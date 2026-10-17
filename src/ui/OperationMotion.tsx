import { useEffect, useRef, type RefObject } from "react";
import "./operation-motion.css";

const SMOOTH_FREQUENCY = 1.8;
const MOTOR_RADIANS_PER_SECOND = 3.2;

function useOperationMotion(active: boolean, target: number) {
  const ref = useRef<HTMLDivElement>(null);
  const body = useRef({ position: target, velocity: 0, angle: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let visible = true;
    let disposed = false;
    let frame = 0;
    let previous = 0;
    const paint = () => {
      element.style.setProperty("--operation-position", String(body.current.position));
      element.style.setProperty("--operation-flow", String(body.current.angle / (Math.PI * 2)));
      element.style.setProperty("--operation-orbit", `${body.current.angle}rad`);
    };
    const settled = () => Math.abs(body.current.position - target) < .0005 && Math.abs(body.current.velocity) < .001;
    const stop = () => { cancelAnimationFrame(frame); frame = 0; previous = 0; };
    const tick = (now: number) => {
      if (disposed) return;
      const seconds = previous ? Math.min((now - previous) / 1000, 1 / 30) : 0;
      previous = now;
      const omega = 2 * Math.PI * SMOOTH_FREQUENCY;
      const offset = body.current.position - target;
      const impulse = body.current.velocity + omega * offset;
      const decay = Math.exp(-omega * seconds);
      body.current.position = target + (offset + impulse * seconds) * decay;
      body.current.velocity = (body.current.velocity - omega * impulse * seconds) * decay;
      if (active) body.current.angle = (body.current.angle + MOTOR_RADIANS_PER_SECOND * seconds) % (Math.PI * 2);
      paint();
      if (active || !settled()) frame = requestAnimationFrame(tick);
      else stop();
    };
    const synchronize = () => {
      if (disposed) return;
      stop();
      if (reduced.matches) {
        body.current.position = target;
        body.current.velocity = 0;
        body.current.angle = 0;
        paint();
      } else if (visible && !document.hidden && (active || !settled())) frame = requestAnimationFrame(tick);
    };
    const observer = typeof IntersectionObserver === "undefined" ? undefined : new IntersectionObserver(entries => {
      visible = entries[0]?.isIntersecting ?? false;
      synchronize();
    });
    observer?.observe(element);
    document.addEventListener("visibilitychange", synchronize);
    reduced.addEventListener("change", synchronize);
    paint();
    synchronize();
    return () => {
      disposed = true;
      stop();
      observer?.disconnect();
      document.removeEventListener("visibilitychange", synchronize);
      reduced.removeEventListener("change", synchronize);
    };
  }, [active, target]);
  return ref;
}

export function OperationTrack({ active = true, step = 0, steps = 1, kind = "load", compact = false, failed = false }: { active?: boolean; step?: number; steps?: number; kind?: "load" | "agents" | "deploy" | "pull"; compact?: boolean; failed?: boolean }) {
  const target = Math.max(0, Math.min(1, step / Math.max(1, steps - 1)));
  const ref = useOperationMotion(active, target);
  return <div ref={ref} className={`operation-track operation-${kind}${compact ? " operation-compact" : ""}`} data-active={active} data-failed={failed} aria-hidden="true">
    {kind === "pull" ? <svg viewBox="0 0 240 64" fill="none"><path className="operation-wire" d="M18 32H222M18 12H62Q82 12 94 32M18 52H62Q82 52 94 32"/><circle className="operation-node" cx="18" cy="12" r="3"/><circle className="operation-node" cx="18" cy="52" r="3"/><rect className="operation-node" x="210" y="21" width="22" height="22" rx="6"/><path className="operation-signal" pathLength="100" d="M18 12H62Q82 12 94 32H214"/><path className="operation-signal operation-signal-secondary" pathLength="100" d="M18 52H62Q82 52 94 32H214"/><g className="operation-pull-packet"><rect x="11" y="25" width="14" height="14" rx="4"/><path d="M15 30h6M15 34h4"/></g></svg>
      : kind === "agents" ? <svg viewBox="0 0 240 64" fill="none"><path className="operation-wire" d="M16 16H69L86 32M16 48H69L86 32M154 32H178L195 16H224M178 32L195 48H224"/><path className="operation-signal" pathLength="100" d="M16 16H69L86 32H154H178L195 16H224"/><path className="operation-signal operation-signal-secondary" pathLength="100" d="M16 48H69L86 32H154H178L195 48H224"/><rect className="operation-processor" x="92" y="11" width="56" height="42" rx="12"/><path className="operation-wire" d="M106 5V11M120 5V11M134 5V11M106 53V59M120 53V59M134 53V59M86 23H92M86 41H92M148 23H154M148 41H154"/><rect className="operation-agent-face" x="103" y="23" width="34" height="20" rx="6"/><path className="operation-agent-eyes" d="M112 31v4M128 31v4M120 17v6"/><circle className="operation-agent-satellite" cx="120" cy="6" r="2.5"/></svg>
      : kind === "deploy" ? <svg viewBox="0 0 240 76" fill="none"><path className="operation-wire" d="M24 58H63Q78 58 90 42L104 26M164 26H183Q191 26 197 14H225M183 26H225M183 26Q191 26 197 48H225"/><path className="operation-signal" pathLength="100" d="M24 58H63Q78 58 90 42L104 26H183Q191 26 197 14H225"/><path className="operation-signal operation-signal-secondary" pathLength="100" d="M164 26H183Q191 26 197 48H225"/><circle className="operation-node" cx="226" cy="14" r="3"/><circle className="operation-node" cx="226" cy="26" r="3"/><circle className="operation-node" cx="226" cy="48" r="3"/><circle className="operation-cloud-halo" cx="134" cy="27" r="26"/><path className="operation-cloud" d="M116 38a11 11 0 0 1-1-22 17 17 0 0 1 32-2 12 12 0 0 1 4 24Z"/><g className="operation-deploy-artifact"><rect x="15" y="48" width="22" height="22" rx="6"/><path d="m21 55 5-3 5 3v7l-5 3-5-3zM21 55l5 3 5-3M26 58v7"/></g></svg>
      : <svg viewBox="0 0 240 76" fill="none"><rect className="operation-browser" x="25" y="5" width="190" height="66" rx="8"/><path className="operation-wire" d="M25 20H215M64 20V71"/><circle className="operation-node" cx="36" cy="13" r="1.5"/><circle className="operation-node" cx="43" cy="13" r="1.5"/><circle className="operation-node" cx="50" cy="13" r="1.5"/><path className="operation-skeleton" d="M36 32H52M36 42H48M36 52H51M78 32H144M78 40H175"/><rect className="operation-skeleton-card" x="78" y="49" width="51" height="12" rx="3"/><rect className="operation-skeleton-card" x="136" y="49" width="65" height="12" rx="3"/><path className="operation-load-scan" d="M73 25V65"/></svg>}
  </div>;
}

export function useRouteMotion(): RefObject<HTMLDivElement | null> {
  return useOperationMotion(true, 0);
}
