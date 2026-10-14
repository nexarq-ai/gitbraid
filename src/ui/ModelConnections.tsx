import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@cloudflare/kumo/components/button';
import { Input } from '@cloudflare/kumo/components/input';
import { ArrowClockwiseIcon, ArrowLeftIcon, PlusIcon, TrashIcon } from '@phosphor-icons/react';
import type { ModelConnection, ModelConnectionsSnapshot } from '../shared/types';
import { request } from './api';
import './model-connections.css';
import { RouteProgress } from "./WorkspaceLoader";

const transportLabels = { responses: 'OpenAI Responses', chat: 'Compatible chat', anthropic: 'Anthropic Messages', 'workers-ai': 'Workers AI function calling' };

export default function ModelConnections({ canManage }: { canManage: boolean }) {
  const [snapshot, setSnapshot] = useState<ModelConnectionsSnapshot | null>(null);
  const [busy, setBusy] = useState('load');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [id, setId] = useState('');
  const [label, setLabel] = useState('');
  const [protocol, setProtocol] = useState<'responses' | 'chat' | 'anthropic'>('chat');
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let active = true;
    setBusy('load'); setError(''); setSnapshot(null);
    void request<ModelConnectionsSnapshot>('/api/models').then(value => { if (active) setSnapshot(value); }).catch(failure => { if (active) setError(failure instanceof Error ? failure.message : 'Model connections could not be loaded.'); }).finally(() => { if (active) setBusy(''); });
    return () => { active = false; };
  }, [refresh]);

  async function action(body: unknown, key: string) {
    if (!canManage || busy) return;
    setBusy(key); setError(''); setNotice('');
    try {
      const result = await request<ModelConnectionsSnapshot>('/api/models/action', body);
      setSnapshot(result);
      if (key.startsWith('verify:')) {
        const model = result.models.find(value => value.id === key.slice(7));
        setNotice(model?.verification?.detail ?? 'Connection check completed.');
      } else setNotice('Model connections saved.');
      return true;
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'The model action could not be completed.'); }
    finally { setBusy(''); }
    return false;
  }

  async function addGateway(event: FormEvent) {
    event.preventDefault();
    if (await action({ action: 'add', model: { id: id.trim(), label: label.trim(), source: 'gateway', protocol } }, 'add')) { setId(''); setLabel(''); }
  }

  return <section className="model-connections">
    <a className="header-back" href="/settings"><ArrowLeftIcon size={13} />Settings</a>
    <div className="page-heading"><div><h1>AI models</h1><p>Choose the models your workspace can assign to coding agents.</p></div><Button variant="secondary" size="base" icon={ArrowClockwiseIcon} disabled={!!busy} onClick={() => setRefresh(value => value + 1)}>Refresh</Button></div>
    {error && <div className="error-notice" role="alert">{error}</div>}
    {notice && <p className="models-notice" role="status">{notice}</p>}
    {busy === 'load' && <RouteProgress />}
    {snapshot && <>
      <section className="panel"><div className="panel-header"><h2>Connection</h2><span>{snapshot.gateway.configured ? 'Configured' : 'Setup required'}</span></div><div className="panel-body models-connection"><dl><div><dt>AI Gateway</dt><dd>{snapshot.gateway.id ?? 'Not configured'}</dd></div><div><dt>Workers AI binding</dt><dd>{snapshot.workersAI.enabled ? 'Enabled' : 'Not enabled'}</dd></div></dl><p>All inference runs through this deployment’s AI Gateway. Provider credentials stay in the Gateway. Gateway models require a stored default BYOK key; Unified Billing fallback is blocked. Workers AI uses its separately configured account billing.</p><p>Model discovery is manual. Adding an identifier records your configuration; verification sends one small inference request. A successful check confirms text inference, while coding and tool use need a real Mission run.</p></div></section>
      <section className="panel"><div className="panel-header"><h2>Available models</h2><span>{snapshot.models.length} configured</span></div><div className="models-list">{snapshot.models.length ? snapshot.models.map(model => <div className="models-item" key={model.id}><div className="models-identity"><strong>{model.label}</strong><code>{model.id}</code><span>{model.source === 'workers-ai' ? 'Cloudflare hosted' : 'AI Gateway'} · {transportLabels[model.protocol]}</span>{model.verification ? <p className={model.verification.status === 'failed' ? 'models-failed' : ''}>{model.verification.status === 'verified' ? 'Inference verified' : 'Verification failed'} · {new Date(model.verification.checkedAt).toLocaleString()}</p> : <p>Configured · Inference not yet verified</p>}</div>{canManage && <div className="models-actions"><Button variant="secondary" size="base" disabled={!!busy || !snapshot.gateway.configured} loading={busy === `verify:${model.id}`} onClick={() => void action({ action: 'verify', modelId: model.id }, `verify:${model.id}`)}>Verify</Button><Button variant="ghost" size="base" icon={TrashIcon} disabled={!!busy} aria-label={`Remove ${model.label}`} onClick={() => void action({ action: 'remove', modelId: model.id }, `remove:${model.id}`)}>Remove</Button></div>}</div>) : <p className="panel-body">No models are enabled. A workspace owner can add a model below.</p>}</div></section>
      {!canManage ? <p>Workspace owners manage model connections. You can select enabled models when creating a proposal.</p> : <>
        <section className="panel"><div className="panel-header"><h2>Add an AI Gateway model</h2></div><form className="panel-body models-form" onSubmit={event => void addGateway(event)}><p>Add a model configured in your Gateway. Compatible chat requires the provider to accept the chat and tool schema. OpenAI Responses supports OpenAI model identifiers. Claude models use Anthropic Messages. Native Gemini transport is not implemented.</p><div className="form-field"><label htmlFor="model-label">Display name</label><Input id="model-label" value={label} required maxLength={80} disabled={!!busy} placeholder="My coding model" onChange={event => setLabel(event.target.value)} /></div><div className="form-field"><label htmlFor="model-id">Model identifier</label><Input id="model-id" value={id} required maxLength={200} disabled={!!busy} placeholder="provider/model" onChange={event => setId(event.target.value)} /><small>Use the exact provider/model identifier. URLs and API keys are not accepted.</small></div><div className="form-field"><label htmlFor="model-transport">Transport</label><select id="model-transport" value={protocol} disabled={!!busy} onChange={event => setProtocol(event.target.value as 'responses' | 'chat' | 'anthropic')}><option value="chat">Compatible chat</option><option value="responses">OpenAI Responses</option><option value="anthropic">Anthropic Messages</option></select></div><div><Button type="submit" variant="primary" size="base" icon={PlusIcon} disabled={!!busy || !snapshot.gateway.configured} loading={busy === 'add'}>Add model</Button></div></form></section>
        <section className="panel"><div className="panel-header"><h2>Connect Workers AI</h2></div><div className="panel-body"><p>Enable a Cloudflare-hosted model with documented function calling. Workers AI inference and billing must be available for this deployment’s account.</p>{snapshot.workersAICatalog.map((model: ModelConnection) => <div className="models-workers-option" key={model.id}><div><strong>{model.label}</strong><code>{model.id}</code><a href="https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/" target="_blank" rel="noreferrer">Model documentation</a></div><Button variant="secondary" size="base" disabled={!!busy || !snapshot.gateway.configured || !snapshot.workersAI.enabled || snapshot.models.some(entry => entry.id === model.id)} onClick={() => void action({ action: 'add', model }, `add:${model.id}`)}>{snapshot.models.some(entry => entry.id === model.id) ? 'Enabled' : 'Enable model'}</Button></div>)}</div></section>
      </>}
    </>}
  </section>;
}
