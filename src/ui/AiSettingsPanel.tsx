import { useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { RobotIcon } from "@phosphor-icons/react";
import type { AiSettings } from "../shared/types";
import { request } from "./api";

export default function AiSettingsPanel({ settings, canManage, onChanged }: { settings?: AiSettings; canManage: boolean; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const enabled = settings?.enabled !== false;
  async function toggle() {
    setBusy(true);
    setError("");
    try {
      await request("/api/settings/ai", { enabled: !enabled }, crypto.randomUUID());
      await onChanged();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The AI setting could not be changed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel settings-cloudflare">
      <div className="settings-cloudflare-heading">
        <RobotIcon size={27} />
        <div>
          <h2>AI features {enabled ? "on" : "off"}</h2>
          <p>
            {settings?.locked
              ? "This installation runs without AI (AI_FEATURES=disabled). Repositories, reviews, landing, reverts and releases work as usual."
              : enabled
                ? "Agents, mission drafting, AI model settings and AI client connections are available."
                : "Agents, mission drafting, AI model settings and AI client connections are hidden and refused. Repositories, reviews, landing, reverts and releases keep working."}
          </p>
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
      </div>
      {!settings?.locked && canManage && (
        <Button variant="secondary" size="base" loading={busy} disabled={busy} onClick={() => void toggle()}>
          {enabled ? "Turn AI off" : "Turn AI on"}
        </Button>
      )}
    </section>
  );
}
