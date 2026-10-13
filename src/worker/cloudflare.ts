import { ApiError, assertMutationOrigin, readJson, requireString } from './domain';
import type { AppEnv } from './env';
import type { Action, Principal } from './security';
import { decryptAuth, encryptAuth, randomCapability } from './mfa';

export interface CloudflareConnection { version: string; encrypted: string; issuer: Principal }
export interface CloudflareOAuthState { id: string; browserHash: string; principal: Principal; expiresAt: number; encrypted: string }
export type CloudflareStoreOperation = 'get' | 'put' | 'delete' | 'state-put' | 'state-consume';
export interface CloudflareAuthorization { action: Action; resourceType: string; resourceId: string; expectedAccountId?: string }
export interface CloudflareApiOptions { method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'; body?: unknown; authorization?: CloudflareAuthorization; expectedAccountId?: string }
interface Store { connectionStore(p: Principal | null, operation: CloudflareStoreOperation, body: Record<string, unknown>): Promise<unknown>; check(p: Principal, action: Action, resourceType?: string, resourceId?: string): Promise<void>; rateLimit(key: string, max?: number, windowMs?: number): Promise<void> }
interface Account { id: string; name: string }
interface Vault { accessToken: string; refreshToken?: string; expiresAt: number; account?: Account; scopes: string[]; clientId: string }
interface TokenResponse { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown; token_type?: unknown }
interface Pending { verifier: string; redirectUri: string; expectedVersion: string | null }
const authorizeEndpoint = 'https://dash.cloudflare.com/oauth2/auth';
const tokenEndpoint = 'https://dash.cloudflare.com/oauth2/token';
const revokeEndpoint = 'https://dash.cloudflare.com/oauth2/revoke';
const apiOrigin = 'https://api.cloudflare.com/client/v4';
const cookieName = '__Host-gitflare-cloudflare-state';
const defaultScopes = 'account-settings.read workers-scripts.metadata_read d1.read d1.write account-analytics.read containers.read';
export const WORKER_USAGE_QUERY = 'query GitflareWorkerUsage($accountTag: string!, $scriptName: string!, $start: Time!, $end: Time!) { viewer { accounts(filter: {accountTag: $accountTag}) { workersInvocationsAdaptive(limit: 100, filter: {scriptName: $scriptName, datetime_geq: $start, datetime_leq: $end}) { dimensions {scriptName} sum {requests errors} quantiles {cpuTimeP50 cpuTimeP99} } } } }';
export const D1_USAGE_QUERY = 'query GitflareD1Usage($accountTag: string!, $databaseId: string!, $start: Date!, $end: Date!) { viewer { accounts(filter: {accountTag: $accountTag}) { d1AnalyticsAdaptiveGroups(limit: 100, filter: {databaseId: $databaseId, date_geq: $start, date_leq: $end}, orderBy: [date_DESC]) { dimensions {date databaseId} sum {readQueries writeQueries rowsRead rowsWritten} } } } }';
function service(env: AppEnv): Store { return env.GITFLARE_SECURITY.getByName('security') as unknown as Store; }
function configured(env: AppEnv): boolean { return Boolean(env.CLOUDFLARE_CLIENT_ID && env.CLOUDFLARE_CLIENT_SECRET && env.AUTH_ENCRYPTION_KEY); }
function requestedScopes(env: AppEnv): string[] { return [...new Set(['offline_access',...(env.CLOUDFLARE_OAUTH_SCOPES??defaultScopes).split(/\s+/).filter(scope=>scope&&scope!=='openid')])]; }
function requireConfiguration(env: AppEnv) { if (!configured(env)) throw new ApiError(503, 'CLOUDFLARE_NOT_CONFIGURED', 'Configure this installation’s Cloudflare OAuth client before connecting an account.'); }
function connectionContext(p: Principal): string { return `cloudflare-connection:${p.workspaceId}`; }
function currentIssuer(p: Principal): Principal { return { userId: p.userId, workspaceId: p.workspaceId, role: p.role, ...(p.bootstrap ? {bootstrap:true} : {}) }; }
async function owner(env: AppEnv, p: Principal): Promise<void> { if (p.role !== 'Owner' || p.credentialId) throw new ApiError(403, 'OWNER_REQUIRED', 'Only a workspace owner can manage its Cloudflare connection.'); await service(env).check(p, 'manage'); }
async function sha(value: string): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))), b=>b.toString(16).padStart(2,'0')).join(''); }
function clientAuthorization(env: AppEnv): string { return `Basic ${btoa(`${encodeURIComponent(env.CLOUDFLARE_CLIENT_ID!)}:${encodeURIComponent(env.CLOUDFLARE_CLIENT_SECRET!)}`)}`; }
async function jsonRequest(url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try { response = await fetch(url,{...init,redirect:'manual',signal:AbortSignal.timeout(15000)}); }
  catch { throw new ApiError(502,'CLOUDFLARE_UNAVAILABLE','Cloudflare could not be reached. Try again.'); }
  if (!response.ok) throw new ApiError(response.status === 401 ? 409 : response.status === 403 ? 403 : 502,'CLOUDFLARE_API_REJECTED','Cloudflare rejected this operation. Check the connected account and granted permissions.');
  const text = await response.text(); if (text.length > 2000000) throw new ApiError(502,'CLOUDFLARE_RESPONSE_TOO_LARGE','Cloudflare returned a response too large to display.');
  try { return JSON.parse(text); } catch { throw new ApiError(502,'CLOUDFLARE_INVALID_RESPONSE','Cloudflare returned an invalid response.'); }
}
function authenticatedForm(env: AppEnv, form: URLSearchParams): {headers:Record<string,string>;body:URLSearchParams} {
  const headers:Record<string,string>={'Content-Type':'application/x-www-form-urlencoded'};
  if(env.CLOUDFLARE_CLIENT_AUTH_METHOD==='client_secret_basic') headers.Authorization=clientAuthorization(env);
  else {form.set('client_id',env.CLOUDFLARE_CLIENT_ID!);form.set('client_secret',env.CLOUDFLARE_CLIENT_SECRET!);}
  return {headers,body:form};
}
async function tokenRequest(env: AppEnv, form: URLSearchParams): Promise<TokenResponse> { return await jsonRequest(tokenEndpoint,{method:'POST',...authenticatedForm(env,form)}) as TokenResponse; }
function tokenValues(response: TokenResponse) {
  const expiry = Number(response.expires_in);
  if (typeof response.access_token !== 'string' || !response.access_token || response.access_token.length > 16000 || !Number.isFinite(expiry) || expiry <= 0 || expiry > 31536000 || typeof response.token_type === 'string' && response.token_type.toLowerCase() !== 'bearer') throw new ApiError(502,'CLOUDFLARE_INVALID_TOKEN','Cloudflare returned incomplete authorization credentials.');
  return {accessToken:response.access_token,refreshToken:typeof response.refresh_token==='string'?response.refresh_token:undefined,expiresAt:Date.now()+expiry*1000};
}
async function save(env: AppEnv, p: Principal, vault: Vault, expectedVersion: string | null, issuer = currentIssuer(p)): Promise<CloudflareConnection> {
  const value = {version:crypto.randomUUID(),issuer,encrypted:await encryptAuth(JSON.stringify(vault),env.AUTH_ENCRYPTION_KEY,connectionContext(p))};
  await service(env).connectionStore(p,'put',{value,expectedVersion}); return value;
}
async function load(env: AppEnv, p: Principal, authorization?: CloudflareAuthorization): Promise<{record:CloudflareConnection;vault:Vault}> {
  requireConfiguration(env);
  const record = await service(env).connectionStore(p,'get',authorization?{authorization}: {}) as CloudflareConnection | null;
  if (!record) throw new ApiError(409,'CLOUDFLARE_NOT_CONNECTED','Connect a Cloudflare account first.');
  let vault = JSON.parse(await decryptAuth(record.encrypted,env.AUTH_ENCRYPTION_KEY,connectionContext(p))) as Vault;
  if (vault.clientId !== env.CLOUDFLARE_CLIENT_ID) throw new ApiError(409,'CONNECTION_REAUTH_REQUIRED','Reconnect after changing this installation’s Cloudflare client.');
  if (vault.expiresAt <= Date.now()+30000) {
    if (!vault.refreshToken) throw new ApiError(409,'CONNECTION_REAUTH_REQUIRED','The Cloudflare authorization expired. Reconnect your account.');
    const values=tokenValues(await tokenRequest(env,new URLSearchParams({grant_type:'refresh_token',refresh_token:vault.refreshToken})));
    vault = {...vault,...values,refreshToken:values.refreshToken??vault.refreshToken};
    const refreshed = await save(env,currentIssuer(record.issuer),vault,record.version,record.issuer);
    return {record:refreshed,vault};
  }
  return {record,vault};
}
interface CloudflareEnvelope { success?: boolean; result?: unknown; result_info?: { total_pages?: number; total_count?: number; next_page_token?: string } }
async function apiEnvelope(env: AppEnv, vault: Vault, path: string, options: CloudflareApiOptions = {}): Promise<CloudflareEnvelope> {
  const result = await jsonRequest(`${apiOrigin}${path}`,{method:options.method??'GET',headers:{Authorization:`Bearer ${vault.accessToken}`,...(options.body===undefined?{}:{'Content-Type':'application/json'})},body:options.body===undefined?undefined:JSON.stringify(options.body)}) as {success?:boolean;result?:unknown};
  if (result.success===false) throw new ApiError(502,'CLOUDFLARE_API_REJECTED','Cloudflare could not complete this operation. Check account permissions.');
  return result;
}
async function api(env: AppEnv, vault: Vault, path: string, options: CloudflareApiOptions = {}): Promise<unknown> { return (await apiEnvelope(env, vault, path, options)).result; }
const resourceLists: Record<string, 'all' | 'page' | 'cursor'> = { '/workers/scripts': 'all', '/workers/durable_objects/namespaces': 'page', '/d1/database': 'page', '/workflows': 'page', '/containers/applications': 'cursor' };
async function listResources(env: AppEnv, vault: Vault, path: string): Promise<unknown[]> {
  const mode = resourceLists[path];
  const items: unknown[] = [];
  let cursor = '';
  const seen = new Set<string>();
  for (let page = 1; page <= 50; page++) {
    const query = mode === 'all' ? '' : `?${new URLSearchParams({ per_page: '100', ...(mode === 'page' ? { page: String(page) } : cursor ? { page_token: cursor } : {}) })}`;
    const response = await apiEnvelope(env, vault, `/accounts/${vault.account!.id}${path}${query}`);
    if (!Array.isArray(response.result)) throw new ApiError(502, 'CLOUDFLARE_INVALID_RESPONSE', 'Cloudflare did not return a resource list.');
    items.push(...response.result);
    if (mode === 'all') return items;
    if (mode === 'cursor') {
      cursor = response.result_info?.next_page_token ?? '';
      if (!cursor) return items;
      if (seen.has(cursor)) break;
      seen.add(cursor);
    } else {
      const totalPages = response.result_info?.total_pages;
      const totalCount = response.result_info?.total_count;
      if (totalPages !== undefined ? page >= totalPages : totalCount !== undefined ? items.length >= totalCount : response.result.length < 100) return items;
      if (!response.result.length) break;
    }
  }
  throw new ApiError(502, 'CLOUDFLARE_CATALOG_LIMIT', 'Cloudflare returned an incomplete resource catalog. Narrow the account scope before retrying.');
}
function status(env: AppEnv, vault?: Vault) { return {configured:configured(env),connected:!!vault,...(vault?{expiresAt:vault.expiresAt,scopes:vault.scopes,account:vault.account}: {})}; }
function accountsValue(result: unknown): Account[] {
  if (!Array.isArray(result)) throw new ApiError(502,'CLOUDFLARE_INVALID_RESPONSE','Cloudflare did not return an account list.');
  return result.filter(a=>a && typeof a.id==='string' && /^[a-f0-9]{32}$/i.test(a.id) && typeof a.name==='string').map(a=>({id:a.id,name:a.name.slice(0,200)}));
}
function checkAccount(vault: Vault, expectedAccountId?: string) { if(expectedAccountId && vault.account?.id!==expectedAccountId) throw new ApiError(409,'CLOUDFLARE_ACCOUNT_CHANGED','The selected Cloudflare account changed. Update the project resource mapping before continuing.'); }
export async function cloudflareAccount(env: AppEnv,p:Principal,authorization?:CloudflareAuthorization):Promise<Account> { const {vault}=await load(env,p,authorization); if(!vault.account) throw new ApiError(409,'ACCOUNT_SELECTION_REQUIRED','Select the Cloudflare account for this workspace first.'); checkAccount(vault,authorization?.expectedAccountId); return vault.account; }
export async function cloudflareApiRequest(env:AppEnv,p:Principal,path:string,options:CloudflareApiOptions={}):Promise<unknown> {
  if(!/^\/(?:workers\/|d1\/|workflows(?:\/|$)|containers\/applications(?:\/|$))/.test(path) || /(?:\.\.|%|[?#\\])/.test(path) || !/^\/[A-Za-z0-9_./-]+$/.test(path)) throw new ApiError(400,'INVALID_CLOUDFLARE_PATH','Use a resource path inside the selected Cloudflare account.');
  const {vault}=await load(env,p,options.authorization); if(!vault.account) throw new ApiError(409,'ACCOUNT_SELECTION_REQUIRED','Select the Cloudflare account for this workspace first.');
  checkAccount(vault,options.expectedAccountId??options.authorization?.expectedAccountId);
  if (resourceLists[path] && (!options.method || options.method === 'GET')) return listResources(env, vault, path);
  return api(env,vault,`/accounts/${vault.account.id}${path}`,options);
}
export async function cloudflareAnalyticsRequest(env:AppEnv,p:Principal,body:{query:string;variables:Record<string,unknown>},authorization?:CloudflareAuthorization):Promise<unknown> {
  if (![WORKER_USAGE_QUERY,D1_USAGE_QUERY].includes(body.query)) throw new ApiError(400,'INVALID_ANALYTICS_QUERY','Use the supported project usage queries.');
  const {vault}=await load(env,p,authorization); if(!vault.account) throw new ApiError(409,'ACCOUNT_SELECTION_REQUIRED','Select the Cloudflare account for this workspace first.');
  checkAccount(vault,authorization?.expectedAccountId);
  const response=await jsonRequest(`${apiOrigin}/graphql`,{method:'POST',headers:{Authorization:`Bearer ${vault.accessToken}`,'Content-Type':'application/json'},body:JSON.stringify({query:body.query,variables:{...body.variables,accountTag:vault.account.id}})}) as {data?:unknown;errors?:unknown[]};
  if(response.errors?.length) throw new ApiError(502,'CLOUDFLARE_ANALYTICS_REJECTED','Cloudflare could not return usage for this project. Check analytics permissions.'); return response.data;
}
async function start(env:AppEnv,p:Principal,origin:string) {
  await owner(env,p); requireConfiguration(env); if(!p.sessionId) throw new ApiError(403,'ACCOUNT_SESSION_REQUIRED','Sign in through the browser before connecting Cloudflare.');
  const uri=new URL(origin); if(uri.protocol!=='https:') throw new ApiError(400,'HTTPS_REQUIRED','Cloudflare account connection requires HTTPS.');
  const state=randomCapability(); const binder=randomCapability(); const verifier=randomCapability(); const id=await sha(state); const expiresAt=Date.now()+600000;
  const previous=await service(env).connectionStore(p,'get',{}) as CloudflareConnection|null;
  const pending:Pending={verifier,redirectUri:`${uri.origin}/api/cloudflare/callback`,expectedVersion:previous?.version??null};
  const record:CloudflareOAuthState={id,browserHash:await sha(binder),principal:p,expiresAt,encrypted:await encryptAuth(JSON.stringify(pending),env.AUTH_ENCRYPTION_KEY,`cloudflare-state:${id}`)};
  await service(env).connectionStore(p,'state-put',{value:record});
  const challenge=btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const url=new URL(authorizeEndpoint);url.search=new URLSearchParams({response_type:'code',client_id:env.CLOUDFLARE_CLIENT_ID!,redirect_uri:pending.redirectUri,state,code_challenge:challenge,code_challenge_method:'S256',scope:requestedScopes(env).join(' ')}).toString();
  return {authorizationUrl:url.toString(),expiresAt,cookie:`${cookieName}=${binder}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`};
}
async function callback(request:Request,env:AppEnv):Promise<Response> {
  requireConfiguration(env);const url=new URL(request.url);const state=requireString(url.searchParams.get('state'),'OAuth state',128,64);
  const binder=request.headers.get('Cookie')?.split(';').map(v=>v.trim()).find(v=>v.startsWith(`${cookieName}=`))?.slice(cookieName.length+1);
  if(!binder||!/^[a-f0-9]{64}$/.test(binder)) throw new ApiError(403,'OAUTH_BROWSER_REQUIRED','Restart the Cloudflare connection in the browser where you began.');
  const record=await service(env).connectionStore(null,'state-consume',{id:await sha(state),browserHash:await sha(binder)}) as CloudflareOAuthState;
  const pending=JSON.parse(await decryptAuth(record.encrypted,env.AUTH_ENCRYPTION_KEY,`cloudflare-state:${record.id}`)) as Pending;
  if(pending.redirectUri!==`${url.origin}${url.pathname}`) throw new ApiError(403,'OAUTH_REDIRECT_MISMATCH','The callback does not match the original installation.');
  if(url.searchParams.has('error')) throw new ApiError(400,'CLOUDFLARE_AUTHORIZATION_DENIED','Cloudflare authorization was cancelled or denied.');
  const code=requireString(url.searchParams.get('code'),'Authorization code',4096);
  const response=await tokenRequest(env,new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:pending.redirectUri,code_verifier:pending.verifier})); const values=tokenValues(response);
  const vault:Vault={...values,scopes:typeof response.scope==='string'?response.scope.split(' '):requestedScopes(env),clientId:env.CLOUDFLARE_CLIENT_ID!};
  await save(env,record.principal,vault,pending.expectedVersion);
  return new Response(null,{status:303,headers:{Location:`${url.origin}/#settings/cloudflare`,'Set-Cookie':`${cookieName}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
}
export async function dispatchCloudflare(env:AppEnv,p:Principal,action:string,body:Record<string,unknown>={},origin=''):Promise<unknown> {
  await owner(env,p);
  if(action==='status') {const record=await service(env).connectionStore(p,'get',{}) as CloudflareConnection|null;return status(env,record?JSON.parse(await decryptAuth(record.encrypted,env.AUTH_ENCRYPTION_KEY,connectionContext(p))) as Vault:undefined);}
  if(action==='connect') return {browserStartUrl:`${new URL(origin).origin}/#settings/cloudflare`,browserAuthorizationRequired:true};
  if(action==='disconnect') {
    const removed=await service(env).connectionStore(p,'delete',{}) as CloudflareConnection|null;
    if(!removed)return {connected:false,revoked:true};
    let revoked=true;
    try {
      const stored=JSON.parse(await decryptAuth(removed.encrypted,env.AUTH_ENCRYPTION_KEY,connectionContext(p))) as Vault;
      if(!env.CLOUDFLARE_CLIENT_ID||!env.CLOUDFLARE_CLIENT_SECRET)revoked=false;
      else for(const token of [stored.refreshToken,stored.accessToken].filter(Boolean) as string[]) {
        try {const response=await fetch(revokeEndpoint,{method:'POST',...authenticatedForm(env,new URLSearchParams({token})),redirect:'manual',signal:AbortSignal.timeout(15000)});if(!response.ok)revoked=false;}catch{revoked=false;}
      }
    }catch{revoked=false;}
    return {connected:false,revoked};
  }
  const {record,vault}=await load(env,p);
  if(action==='accounts') return {accounts:accountsValue(await api(env,vault,'/accounts'))};
  if(action==='select-account') {const accountId=requireString(body.accountId,'Cloudflare account',32,32);const account=accountsValue(await api(env,vault,'/accounts')).find(a=>a.id===accountId);if(!account) throw new ApiError(403,'ACCOUNT_NOT_GRANTED','Select an account granted by this Cloudflare authorization.');await save(env,p,{...vault,account},record.version,record.issuer);return status(env,{...vault,account});}
  if(action==='resources') {
    if (!vault.account) throw new ApiError(409, 'ACCOUNT_SELECTION_REQUIRED', 'Select the Cloudflare account for this workspace first.');
    const kinds = [ ['workers', '/workers/scripts'], ['durableObjects', '/workers/durable_objects/namespaces'], ['databases', '/d1/database'], ['containers', '/containers/applications'], ['workflows', '/workflows'] ] as const;
    const results = await Promise.allSettled(kinds.map(([, path]) => listResources(env, vault, path)));
    const catalogs: Record<string, { id: string; name: string; script?: string }[]> = {};
    const availability: Record<string, { available: boolean; reason?: string }> = {};
    results.forEach((result, index) => {
      const [kind] = kinds[index];
      catalogs[kind] = [];
      availability[kind] = { available: result.status === 'fulfilled', ...(result.status === 'rejected' ? { reason: result.reason instanceof ApiError ? result.reason.detail : 'This resource catalog is unavailable. Check the connection permissions and try again.' } : {}) };
      if (result.status === 'fulfilled') catalogs[kind] = result.value.flatMap(value => {
        if (!value || typeof value !== 'object') return [];
        const item = value as Record<string, unknown>;
        const id = kind === 'workflows' ? item.name : item.id ?? item.uuid ?? item.name;
        const name = item.name ?? item.id ?? item.uuid;
        return typeof id === 'string' && typeof name === 'string' ? [{ id, name: name.slice(0, 200), ...(typeof item.script === 'string' ? { script: item.script } : typeof item.script_name === 'string' ? { script: item.script_name } : {}) }] : [];
      });
    });
    return { account: vault.account, ...catalogs, availability };
  }
  throw new ApiError(404,'NOT_FOUND','This Cloudflare connection operation is unavailable.');
}
export async function handleCloudflare(request:Request,env:AppEnv,authenticate:(request:Request,env:AppEnv)=>Promise<Principal>):Promise<Response|null> {
  const url=new URL(request.url);const path=url.pathname;if(!path.startsWith('/api/cloudflare'))return null;
  if(path==='/api/cloudflare/callback'&&request.method==='GET')return callback(request,env);
  const p=await authenticate(request,env);await owner(env,p);await service(env).rateLimit(`cloudflare:${p.userId}`,30,60000);
  let action=path==='/api/cloudflare'?'status':path.slice('/api/cloudflare/'.length);
  if(request.method==='POST') {assertMutationOrigin(request);const body=await readJson(request);if(action==='connect'){const {cookie,...result}=await start(env,p,url.origin);return Response.json(result,{headers:{'Set-Cookie':cookie,'Cache-Control':'no-store'}});}if(!['disconnect','select-account'].includes(action))throw new ApiError(405,'METHOD_NOT_ALLOWED','Use a supported Cloudflare connection action.');return Response.json(await dispatchCloudflare(env,p,action,body,url.origin),{headers:{'Cache-Control':'no-store'}});}
  if(request.method!=='GET'||!['status','accounts','resources'].includes(action))throw new ApiError(405,'METHOD_NOT_ALLOWED','Use a supported Cloudflare connection action.');
  return Response.json(await dispatchCloudflare(env,p,action,{},url.origin),{headers:{'Cache-Control':'no-store'}});
}
