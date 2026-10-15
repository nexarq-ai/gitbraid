import { useEffect, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { CopyIcon, InfoIcon, ShieldCheckIcon } from "@phosphor-icons/react";
import type { BranchList, Repository } from "../shared/types";
import { request } from "./api";
import { quoteGitArgument } from "./RepositoryImport";
import "./pull-requests.css";

export default function GitAccess({ repository, onNotify }: { repository: Repository; onNotify: (message: string) => void }) {
  const [gitUrl, setGitUrl] = useState(`${location.origin}/git/${repository.name}.git`);
  useEffect(() => {
    let active = true;
    request<BranchList>(`/api/repositories/${encodeURIComponent(repository.id)}/branches`).then(list => { if (active && list.gitUrl) setGitUrl(list.gitUrl); }).catch(() => {});
    return () => { active = false; };
  }, [repository.id]);
  const commands = [`git clone ${quoteGitArgument(gitUrl)}`, "git push origin my-branch"];
  return (
    <section className="panel git-access">
      <div className="panel-header"><h2>Clone and push</h2><a className="text-link" href={`/repository/${repository.id}/settings/branches`}><ShieldCheckIcon size={13} />Streams &amp; protection</a></div>
      <div className="panel-body">
        {commands.map(command => (
          <div className="clipboard-row" key={command}>
            <code>{command}</code>
            <Button variant="ghost" size="base" shape="square" aria-label={`Copy ${command}`} icon={CopyIcon} onClick={() => void navigator.clipboard.writeText(command).then(() => onNotify("Command copied.")).catch(() => onNotify("Copy is unavailable in this browser."))} />
          </div>
        ))}
        <p className="git-access-note"><InfoIcon size={14} /><span>Git ignores the username. Use a personal session token from <a href="/settings">Settings → Account</a> as the password. Pushes to protected branches are rejected, so push a branch and <a href={`/repository/${repository.id}/pulls/new`}>open a proposal</a>. Tags are managed by Checkpoints.</span></p>
      </div>
    </section>
  );
}
