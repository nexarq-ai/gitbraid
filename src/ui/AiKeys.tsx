import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@cloudflare/kumo/components/button';
import { Input } from '@cloudflare/kumo/components/input';
import { KeyIcon, PlusIcon, TrashIcon } from '@phosphor-icons/react';
import type { AiKeyProvider, AiKeysSnapshot } from '../shared/types';
import { request } from './api';

export default function AiKeys({ canManage }: { canManage: boolean }) {
  const [snapshot, setSnapshot] = useState<AiKeysSnapshot | null>(null);
  const [busy, setBusy] = useState('load');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [provider, setProvider] = useState<AiKeyProvider>('openai');
  const [key, setKey] = useState('');
  const [accountId, setAccountId] = useState('');
  const [gatewayId, setGatewayId] = useState('');
  const [gatewayToken, setGatewayToken] = useState('');

  useEffect(() => {
    let active = true;
    void request<AiKeysSnapshot>('/api/ai-keys').then(value => { if (active) setSnapshot(value); }).catch(failure => { if (active) setError(failure instanceof Error ? failure.message : 'AI keys could not be loaded.'); }).finally(() => { if (active) setBusy(''); });
    return () => { active = false; };
  }, []);

  async function send(path: string, body: unknown, label: string): Promise<boolean> {
    if (!canManage || busy) return false;
    setBusy(label); setError(''); setNotice('');
    try {
      const result = await request<AiKeysSnapshot>(path, body, crypto.randomUUID());
      setSnapshot(result);
      setNotice(result.verification ? `Key checked with ${result.verification.model}. ${result.verification.detail}` : 'AI settings saved.');
      return true;
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'The AI key action could not be completed.'); }
    finally { setBusy(''); }
    return false;
  }

  async function addKey(event: FormEvent) {
    event.preventDefault();
    if (await send('/api/ai-keys/action', { action: 'add', provider, key: key.trim() }, 'add')) setKey('');
  }

  async function saveGateway(event: FormEvent) {
    event.preventDefault();
    if (await send('/api/ai-gateway', { action: 'set', accountId: accountId.trim(), gatewayId: gatewayId.trim(), ...(gatewayToken.trim() ? { token: gatewayToken.trim() } : {}) }, 'gateway')) setGatewayToken('');
  }

  const label = (id: AiKeyProvider) => snapshot?.providers.find(entry => entry.id === id)?.label ?? id;

  return <>
    {error && <div className="error-notice" role="alert">{error}</div>}
    {notice && <p className="models-notice" role="status">{notice}</p>}
    {snapshot && !snapshot.ready && <section className="panel models-empty"><KeyIcon size={26} /><div><h2>Add your AI key to start missions</h2><p>This workspace brings its own AI. Add a provider key below{canManage ? '' : ' (workspace owners only)'}, or connect your own AI Gateway. Inference always goes through Cloudflare AI Gateway.</p></div></section>}
    {snapshot && <section className="panel">
      <div className="panel-header"><h2>Your AI keys</h2><span>{snapshot.operatorAccess ? 'Platform AI included' : `${snapshot.keys.length} stored`}</span></div>
      <div className="models-list">{snapshot.keys.length ? snapshot.keys.map(entry => <div className="models-item" key={entry.provider}><div className="models-identity"><strong>{label(entry.provider)}</strong><code>••••{entry.last4}</code><span>Added {new Date(entry.addedAt).toLocaleString()} · checked with {entry.verifiedModel}</span></div>{canManage && <div className="models-actions"><Button variant="secondary" size="base" disabled={!!busy} loading={busy === `test:${entry.provider}`} onClick={() => void send('/api/ai-keys/action', { action: 'test', provider: entry.provider }, `test:${entry.provider}`)}>Test</Button><Button variant="ghost" size="base" icon={TrashIcon} disabled={!!busy} aria-label={`Remove ${label(entry.provider)} key`} onClick={() => void send('/api/ai-keys/action', { action: 'remove', provider: entry.provider }, `remove:${entry.provider}`)}>Remove</Button></div>}</div>) : <p className="panel-body">{snapshot.operatorAccess ? 'This workspace can use the platform’s AI Gateway credentials. A key you add here is used instead for its provider.' : 'No keys yet.'}</p>}</div>
      {canManage && <form className="panel-body models-form" onSubmit={event => void addKey(event)}>
        <p>Keys are checked with one small billed request, stored encrypted, and never shown again. Models use the key whose provider matches their identifier prefix.</p>
        <div className="form-field"><label htmlFor="ai-key-provider">Provider</label><select id="ai-key-provider" value={provider} disabled={!!busy} onChange={event => setProvider(event.target.value as AiKeyProvider)}>{snapshot.providers.map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select></div>
        <div className="form-field"><label htmlFor="ai-key-value">API key</label><Input id="ai-key-value" type="password" autoComplete="off" value={key} required minLength={8} maxLength={512} disabled={!!busy} onChange={event => setKey(event.target.value)} /></div>
        <div><Button type="submit" variant="primary" size="base" icon={PlusIcon} disabled={!!busy || !key.trim()} loading={busy === 'add'}>Check and save key</Button></div>
      </form>}
    </section>}
    {snapshot && <section className="panel">
      <div className="panel-header"><h2>Use your own AI Gateway</h2><span>{snapshot.gateway ? 'Connected' : 'Optional'}</span></div>
      <div className="panel-body models-form">
        {snapshot.gateway ? <div className="models-item models-gateway"><div className="models-identity"><strong>{snapshot.gateway.gatewayId}</strong><code>{snapshot.gateway.accountId}</code><span>{snapshot.gateway.authenticated ? `Authenticated gateway · token ••••${snapshot.gateway.tokenLast4 ?? ''}` : 'Unauthenticated gateway'} · updated {new Date(snapshot.gateway.updatedAt).toLocaleString()}</span></div>{canManage && <div className="models-actions"><Button variant="ghost" size="base" icon={TrashIcon} disabled={!!busy} loading={busy === 'clear'} onClick={() => void send('/api/ai-gateway', { action: 'clear' }, 'clear')}>Disconnect</Button></div>}</div> : <p>Route this workspace’s model calls through an AI Gateway in your Cloudflare account, for your own logs, caching, rate limits and stored provider keys. Workspace keys above are sent through it.</p>}
        {canManage && <form className="models-form" onSubmit={event => void saveGateway(event)}>
          <div className="form-field"><label htmlFor="ai-gateway-account">Cloudflare account ID</label><Input id="ai-gateway-account" value={accountId} required pattern="[a-f0-9]{32}" maxLength={32} disabled={!!busy} onChange={event => setAccountId(event.target.value)} /></div>
          <div className="form-field"><label htmlFor="ai-gateway-id">AI Gateway ID</label><Input id="ai-gateway-id" value={gatewayId} required maxLength={64} disabled={!!busy} onChange={event => setGatewayId(event.target.value)} /></div>
          <div className="form-field"><label htmlFor="ai-gateway-token">Gateway authentication token</label><Input id="ai-gateway-token" type="password" autoComplete="off" value={gatewayToken} maxLength={256} disabled={!!busy} onChange={event => setGatewayToken(event.target.value)} /><small>Only needed for an authenticated gateway. Stored encrypted.</small></div>
          <div><Button type="submit" variant="secondary" size="base" disabled={!!busy || !accountId.trim() || !gatewayId.trim()} loading={busy === 'gateway'}>{snapshot.gateway ? 'Replace gateway' : 'Save gateway'}</Button></div>
        </form>}
      </div>
    </section>}
  </>;
}
