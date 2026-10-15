import { ApiError, assertMutationOrigin, readJson, requireString } from './domain';
import type { AppEnv } from './env';
import { securityClient, type Action, type Principal } from './security';
import { decryptAuth, encryptAuth, randomCapability } from './mfa';
import type { WorkerDeployer } from './deployments';
import { cloudflareDeployClient, workerDeployer, type CloudflareDeployAccess } from './cloudflare-deploy';

export interface CloudflareConnection { version: string; encrypted: string; issuer: Principal }
export interface CloudflareOAuthState { id: string; browserHash: string; principal: Principal; expiresAt: number; encrypted: string; repositoryId?: string }
export type CloudflareStoreOperation = 'get' | 'put' | 'delete' | 'state-put' | 'state-consume';
export interface CloudflareAuthorization { action: Action; resourceType: string; resourceId: string; expectedAccountId?: string }
export interface CloudflareApiOptions { method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'; body?: unknown; authorization?: CloudflareAuthorization; expectedAccountId?: string }
interface Store { connectionStore(p: Principal | null, operation: CloudflareStoreOperation, body: Record<string, unknown>): Promise<unknown>; check(p: Principal, action: Action, resourceType?: string, resourceId?: string): Promise<void>; rateLimit(key: string, max?: number, windowMs?: number): Promise<void> }
interface Account { id: string; name: string }
export type CloudflareVault = Vault;
export interface CloudflareIdentity { id: string; email: string; name: string }
interface Vault { accessToken: string; refreshToken?: string; expiresAt: number; account?: Account; scopes: string[]; clientId: string }
interface TokenResponse { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown; token_type?: unknown }
interface Pending { verifier: string; redirectUri: string; expectedVersion: string | null; repositoryId?: string }
export type CloudflareConnectionSource = 'repository' | 'workspace';
const authorizeEndpoint = 'https://dash.cloudflare.com/oauth2/auth';
const tokenEndpoint = 'https://dash.cloudflare.com/oauth2/token';
const revokeEndpoint = 'https://dash.cloudflare.com/oauth2/revoke';
const apiOrigin = 'https://api.cloudflare.com/client/v4';
const cookieName = '__Host-gitflare-cloudflare-state';
export const CLOUDFLARE_LINK_COOKIE = '__Host-gitflare-cloudflare-link';
const defaultScopes = 'account-settings.read workers-scripts.metadata_read d1.read d1.write account-analytics.read containers.read';
const defaultIdentityScopes = 'user-details.read';
export const WORKER_USAGE_QUERY = 'query GitflareWorkerUsage($accountTag: string!, $scriptName: string!, $start: Time!, $end: Time!) { viewer { accounts(filter: {accountTag: $accountTag}) { workersInvocationsAdaptive(limit: 100, filter: {scriptName: $scriptName, datetime_geq: $start, datetime_leq: $end}) { dimensions {scriptName} sum {requests errors} quantiles {cpuTimeP50 cpuTimeP99} } } } }';
export const D1_USAGE_QUERY = 'query GitflareD1Usage($accountTag: string!, $databaseId: string!, $start: Date!, $end: Date!) { viewer { accounts(filter: {accountTag: $accountTag}) { d1AnalyticsAdaptiveGroups(limit: 100, filter: {databaseId: $databaseId, date_geq: $start, date_leq: $end}, orderBy: [date_DESC]) { dimensions {date databaseId} sum {readQueries writeQueries rowsRead rowsWritten} } } } }';
function service(env: AppEnv): Store { return securityClient(env) as unknown as Store; }
function configured(env: AppEnv): boolean { return Boolean(env.CLOUDFLARE_CLIENT_ID && env.CLOUDFLARE_CLIENT_SECRET && env.AUTH_ENCRYPTION_KEY); }
// The OAuth client rejects any unregistered scope (openid included), so deploy scopes stay opt-in; its id_token carries only `sub`
export function requestedScopes(env: AppEnv, identity = false): string[] { return [...new Set(['offline_access',...`${env.CLOUDFLARE_OAUTH_SCOPES??defaultScopes} ${env.CLOUDFLARE_DEPLOY_SCOPES??''} ${identity?env.CLOUDFLARE_IDENTITY_SCOPES??defaultIdentityScopes:''}`.split(/\s+/).filter(scope=>scope&&scope!=='openid')])]; }
export const CLOUDFLARE_DEPLOY_SCOPE = 'workers-scripts.write';
export function cloudflareSigninConfigured(env: AppEnv): boolean { return configured(env); }
export function requestCookie(request: Request, name: string): string | undefined { return request.headers.get('Cookie')?.split(';').map(v=>v.trim()).find(v=>v.startsWith(`${name}=`))?.slice(name.length+1); }
function requireConfiguration(env: AppEnv) { if (!configured(env)) throw new ApiError(503, 'CLOUDFLARE_NOT_CONFIGURED', 'Configure this installation’s Cloudflare OAuth client before connecting an account.'); }
function connectionContext(p: Principal, repositoryId?: string): string { return repositoryId ? `cloudflare-connection:${p.workspaceId}:repository:${repositoryId}` : `cloudflare-connection:${p.workspaceId}`; }
function repositoryScope(repositoryId?: string): Record<string, string> { return repositoryId ? { repositoryId } : {}; }
function requireRepositoryId(value: string): string { if (!/^[a-zA-Z0-9-]{1,100}$/.test(value)) throw new ApiError(404, 'REPOSITORY_NOT_FOUND', 'This repository could not be found.'); return value; }
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
export async function sealCloudflareConnection(env: AppEnv, issuer: Principal, vault: Vault): Promise<CloudflareConnection> {
  return {version:crypto.randomUUID(),issuer,encrypted:await encryptAuth(JSON.stringify(vault),env.AUTH_ENCRYPTION_KEY,connectionContext(issuer))};
}
async function save(env: AppEnv, p: Principal, vault: Vault, expectedVersion: string | null, issuer = currentIssuer(p), repositoryId?: string): Promise<CloudflareConnection> {
  const value = {version:crypto.randomUUID(),issuer,encrypted:await encryptAuth(JSON.stringify(vault),env.AUTH_ENCRYPTION_KEY,connectionContext(p,repositoryId))};
  await service(env).connectionStore(p,'put',{value,expectedVersion,...repositoryScope(repositoryId)}); return value;
}
async function stored(env: AppEnv, p: Principal, authorization?: CloudflareAuthorization, repositoryId?: string): Promise<CloudflareConnection | null> {
  return await service(env).connectionStore(p,'get',{...(authorization?{authorization}:{}),...repositoryScope(repositoryId)}) as CloudflareConnection | null;
}
async function unseal(env: AppEnv, p: Principal, record: CloudflareConnection, repositoryId?: string): Promise<Vault> { return JSON.parse(await decryptAuth(record.encrypted,env.AUTH_ENCRYPTION_KEY,connectionContext(p,repositoryId))) as Vault; }
async function openConnection(env: AppEnv, p: Principal, record: CloudflareConnection, repositoryId?: string): Promise<{record:CloudflareConnection;vault:Vault}> {
  let vault = await unseal(env,p,record,repositoryId);
  if (vault.clientId !== env.CLOUDFLARE_CLIENT_ID) throw new ApiError(409,'CONNECTION_REAUTH_REQUIRED','Reconnect after changing this installation’s Cloudflare client.');
  if (vault.expiresAt <= Date.now()+30000) {
    if (!vault.refreshToken) throw new ApiError(409,'CONNECTION_REAUTH_REQUIRED','The Cloudflare authorization expired. Reconnect your account.');
    const values=tokenValues(await tokenRequest(env,new URLSearchParams({grant_type:'refresh_token',refresh_token:vault.refreshToken})));
    vault = {...vault,...values,refreshToken:values.refreshToken??vault.refreshToken};
    const refreshed = await save(env,currentIssuer(record.issuer),vault,record.version,record.issuer,repositoryId);
    return {record:refreshed,vault};
  }
  return {record,vault};
}
async function load(env: AppEnv, p: Principal, authorization?: CloudflareAuthorization, repositoryId?: string): Promise<{record:CloudflareConnection;vault:Vault}> {
  requireConfiguration(env);
  const record = await stored(env,p,authorization,repositoryId);
  if (!record) throw new ApiError(409,'CLOUDFLARE_NOT_CONNECTED','Connect a Cloudflare account first.');
  return openConnection(env,p,record,repositoryId);
}
async function loadPreferred(env: AppEnv, p: Principal, authorization?: CloudflareAuthorization, repositoryId?: string): Promise<{record:CloudflareConnection;vault:Vault;source:CloudflareConnectionSource}> {
  requireConfiguration(env);
  if (repositoryId) {
    const record = await stored(env,p,authorization,requireRepositoryId(repositoryId));
    if (record) return {...await openConnection(env,p,record,repositoryId),source:'repository'};
  }
  return {...await load(env,p,authorization),source:'workspace'};
}
function selectedAccount(vault: Vault, source: CloudflareConnectionSource): Account {
  if (!vault.account) throw new ApiError(409,'ACCOUNT_SELECTION_REQUIRED',`Select the Cloudflare account for this ${source} first.`);
  return vault.account;
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
export async function cloudflareAccount(env: AppEnv,p:Principal,authorization?:CloudflareAuthorization,repositoryId?:string):Promise<Account> { const {vault,source}=await loadPreferred(env,p,authorization,repositoryId); const account=selectedAccount(vault,source); checkAccount(vault,authorization?.expectedAccountId); return account; }
export async function cloudflareApiRequest(env:AppEnv,p:Principal,path:string,options:CloudflareApiOptions={},repositoryId?:string):Promise<unknown> {
  if(!/^\/(?:workers\/|d1\/|workflows(?:\/|$)|containers\/applications(?:\/|$))/.test(path) || /(?:\.\.|%|[?#\\])/.test(path) || !/^\/[A-Za-z0-9_./-]+$/.test(path)) throw new ApiError(400,'INVALID_CLOUDFLARE_PATH','Use a resource path inside the selected Cloudflare account.');
  const {vault,source}=await loadPreferred(env,p,options.authorization,repositoryId); const account=selectedAccount(vault,source);
  checkAccount(vault,options.expectedAccountId??options.authorization?.expectedAccountId);
  if (resourceLists[path] && (!options.method || options.method === 'GET')) return listResources(env, vault, path);
  return api(env,vault,`/accounts/${account.id}${path}`,options);
}
export async function cloudflareAnalyticsRequest(env:AppEnv,p:Principal,body:{query:string;variables:Record<string,unknown>},authorization?:CloudflareAuthorization,repositoryId?:string):Promise<unknown> {
  if (![WORKER_USAGE_QUERY,D1_USAGE_QUERY].includes(body.query)) throw new ApiError(400,'INVALID_ANALYTICS_QUERY','Use the supported project usage queries.');
  const {vault,source}=await loadPreferred(env,p,authorization,repositoryId); const account=selectedAccount(vault,source);
  checkAccount(vault,authorization?.expectedAccountId);
  const response=await jsonRequest(`${apiOrigin}/graphql`,{method:'POST',headers:{Authorization:`Bearer ${vault.accessToken}`,'Content-Type':'application/json'},body:JSON.stringify({query:body.query,variables:{...body.variables,accountTag:account.id}})}) as {data?:unknown;errors?:unknown[]};
  if(response.errors?.length) throw new ApiError(502,'CLOUDFLARE_ANALYTICS_REJECTED','Cloudflare could not return usage for this project. Check analytics permissions.'); return response.data;
}
export async function cloudflareDeployAccess(env: AppEnv, p: Principal, authorization: CloudflareAuthorization, repositoryId?: string): Promise<CloudflareDeployAccess> {
  const {vault,source}=await loadPreferred(env,p,authorization,repositoryId); const account=selectedAccount(vault,source);
  checkAccount(vault,authorization.expectedAccountId);
  return {accessToken:vault.accessToken,accountId:account.id,scopes:vault.scopes,source};
}
export function assertDeployScope(scopes: string[]): void {
  if (!scopes.includes(CLOUDFLARE_DEPLOY_SCOPE)) throw new ApiError(403,'CLOUDFLARE_SCOPE_MISSING',`The Cloudflare connection was not granted ${CLOUDFLARE_DEPLOY_SCOPE} (Workers Scripts Write). An Owner must reconnect Cloudflare after the installation requests that scope.`);
}
export async function cloudflareWorkerDeployer(env:AppEnv,p:Principal,workerName:string,expectedAccountId:string,fetcher:(request:Request)=>Promise<Response>=request=>fetch(request),repositoryId?:string):Promise<WorkerDeployer> {
  if(!/^[a-zA-Z0-9_-]{1,63}$/.test(workerName)) throw new ApiError(400,'INVALID_WORKER_NAME','Invalid Worker name.');
  const access=await cloudflareDeployAccess(env,p,{action:'deploy',resourceType:'environment',resourceId:workerName,expectedAccountId},repositoryId);
  assertDeployScope(access.scopes);
  return workerDeployer(cloudflareDeployClient(access,fetcher),workerName);
}
export async function cloudflareAuthorizationUrl(env:AppEnv,redirectUri:string,state:string,verifier:string,identity=false):Promise<string> {
  const challenge=btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const url=new URL(authorizeEndpoint);url.search=new URLSearchParams({response_type:'code',client_id:env.CLOUDFLARE_CLIENT_ID!,redirect_uri:redirectUri,state,code_challenge:challenge,code_challenge_method:'S256',scope:requestedScopes(env,identity).join(' ')}).toString();
  return url.toString();
}
export async function exchangeCloudflareCode(env:AppEnv,code:string,redirectUri:string,verifier:string,identity=false):Promise<Vault> {
  const response=await tokenRequest(env,new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:redirectUri,code_verifier:verifier}));const values=tokenValues(response);
  return {...values,scopes:typeof response.scope==='string'?response.scope.split(' '):requestedScopes(env,identity),clientId:env.CLOUDFLARE_CLIENT_ID!};
}
export async function cloudflareIdentity(env:AppEnv,vault:Vault):Promise<CloudflareIdentity> {
  let user:unknown;
  try { user=await api(env,vault,'/user'); } catch { throw new ApiError(403,'CLOUDFLARE_IDENTITY_UNAVAILABLE','Cloudflare did not share your user details. Allow User Details Read and try again.'); }
  const value=(user??{}) as {id?:unknown;email?:unknown;first_name?:unknown;last_name?:unknown;suspended?:unknown};
  const email=typeof value.email==='string'?value.email.trim().toLowerCase():'';
  if(typeof value.id!=='string'||!/^[A-Za-z0-9-]{8,64}$/.test(value.id)||email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(502,'CLOUDFLARE_IDENTITY_UNAVAILABLE','Cloudflare did not return a usable user identity.');
  if(value.suspended===true) throw new ApiError(403,'CLOUDFLARE_USER_SUSPENDED','This Cloudflare user is suspended.');
  const name=[value.first_name,value.last_name].filter(part=>typeof part==='string'&&part.trim()).join(' ').trim().slice(0,100)||email.split('@')[0].slice(0,100);
  return {id:value.id,email,name};
}
export async function cloudflareAccounts(env:AppEnv,vault:Vault):Promise<Account[]> { return accountsValue(await api(env,vault,'/accounts')); }
export async function revokeCloudflareTokens(env:AppEnv,vault:Pick<Vault,'accessToken'|'refreshToken'>):Promise<boolean> {
  if(!env.CLOUDFLARE_CLIENT_ID||!env.CLOUDFLARE_CLIENT_SECRET)return false;
  let revoked=true;
  for(const token of [vault.refreshToken,vault.accessToken].filter(Boolean) as string[]) {
    try {const response=await fetch(revokeEndpoint,{method:'POST',...authenticatedForm(env,new URLSearchParams({token})),redirect:'manual',signal:AbortSignal.timeout(15000)});if(!response.ok)revoked=false;}catch{revoked=false;}
  }
  return revoked;
}
async function start(env:AppEnv,p:Principal,origin:string,repositoryId?:string) {
  await owner(env,p); requireConfiguration(env); if(!p.sessionId) throw new ApiError(403,'ACCOUNT_SESSION_REQUIRED','Sign in through the browser before connecting Cloudflare.');
  const uri=new URL(origin); if(uri.protocol!=='https:') throw new ApiError(400,'HTTPS_REQUIRED','Cloudflare account connection requires HTTPS.');
  const state=randomCapability(); const binder=randomCapability(); const verifier=randomCapability(); const id=await sha(state); const expiresAt=Date.now()+600000;
  const previous=await stored(env,p,undefined,repositoryId);
  const pending:Pending={verifier,redirectUri:`${uri.origin}/api/cloudflare/callback`,expectedVersion:previous?.version??null,...repositoryScope(repositoryId)};
  const record:CloudflareOAuthState={id,browserHash:await sha(binder),principal:p,expiresAt,encrypted:await encryptAuth(JSON.stringify(pending),env.AUTH_ENCRYPTION_KEY,`cloudflare-state:${id}`),...repositoryScope(repositoryId)};
  await service(env).connectionStore(p,'state-put',{value:record,...repositoryScope(repositoryId)});
  return {authorizationUrl:await cloudflareAuthorizationUrl(env,pending.redirectUri,state,verifier),expiresAt,cookie:`${cookieName}=${binder}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`};
}
async function callback(request:Request,env:AppEnv):Promise<Response> {
  requireConfiguration(env);const url=new URL(request.url);const state=requireString(url.searchParams.get('state'),'OAuth state',128,64);
  const binder=requestCookie(request,cookieName);
  if(!binder||!/^[a-f0-9]{64}$/.test(binder)) throw new ApiError(403,'OAUTH_BROWSER_REQUIRED','Restart the Cloudflare connection in the browser where you began.');
  const record=await service(env).connectionStore(null,'state-consume',{id:await sha(state),browserHash:await sha(binder)}) as CloudflareOAuthState;
  const pending=JSON.parse(await decryptAuth(record.encrypted,env.AUTH_ENCRYPTION_KEY,`cloudflare-state:${record.id}`)) as Pending;
  if(pending.redirectUri!==`${url.origin}${url.pathname}`) throw new ApiError(403,'OAUTH_REDIRECT_MISMATCH','The callback does not match the original installation.');
  if(pending.repositoryId!==record.repositoryId) throw new ApiError(403,'CLOUDFLARE_STATE_INVALID','The connection request has expired. Start again.');
  if(url.searchParams.has('error')) throw new ApiError(400,'CLOUDFLARE_AUTHORIZATION_DENIED','Cloudflare authorization was cancelled or denied.');
  const code=requireString(url.searchParams.get('code'),'Authorization code',4096);
  const vault=await exchangeCloudflareCode(env,code,pending.redirectUri,pending.verifier);
  await save(env,record.principal,vault,pending.expectedVersion,undefined,record.repositoryId);
  const destination=record.repositoryId?`/repository/${encodeURIComponent(record.repositoryId)}/cloudflare`:'/settings/cloudflare';
  return new Response(null,{status:303,headers:{Location:`${url.origin}${destination}`,'Set-Cookie':`${cookieName}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
}
async function resourceCatalog(env:AppEnv,vault:Vault,source:CloudflareConnectionSource) {
  const account=selectedAccount(vault,source);
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
  return { account, ...catalogs, availability };
}
async function disconnect(env:AppEnv,p:Principal,repositoryId?:string) {
  const removed=await service(env).connectionStore(p,'delete',repositoryScope(repositoryId)) as CloudflareConnection|null;
  if(!removed)return {connected:false,revoked:true};
  let revoked:boolean;
  try { revoked=await revokeCloudflareTokens(env,await unseal(env,p,removed,repositoryId)); }catch{revoked=false;}
  return {connected:false,revoked};
}
async function selectAccount(env:AppEnv,p:Principal,body:Record<string,unknown>,repositoryId?:string) {
  const {record,vault}=await load(env,p,undefined,repositoryId);
  const accountId=requireString(body.accountId,'Cloudflare account',32,32);
  const account=accountsValue(await api(env,vault,'/accounts')).find(a=>a.id===accountId);
  if(!account) throw new ApiError(403,'ACCOUNT_NOT_GRANTED','Select an account granted by this Cloudflare authorization.');
  await save(env,p,{...vault,account},record.version,record.issuer,repositoryId);
  return status(env,{...vault,account});
}
async function repositoryStatus(env:AppEnv,p:Principal,repositoryId:string) {
  const own=await stored(env,p,undefined,repositoryId);
  if(own) return {source:'repository' as const,...status(env,await unseal(env,p,own,repositoryId))};
  const workspace=await stored(env,p);
  return {source:workspace?'workspace' as const:'none' as const,...status(env,workspace?await unseal(env,p,workspace):undefined)};
}
async function dispatchRepository(env:AppEnv,p:Principal,action:string,body:Record<string,unknown>,origin:string,repositoryId:string):Promise<unknown> {
  if(action==='status') return repositoryStatus(env,p,repositoryId);
  if(action==='connect') return {browserStartUrl:`${new URL(origin).origin}/repository/${encodeURIComponent(repositoryId)}/cloudflare`,browserAuthorizationRequired:true};
  if(action==='disconnect') return disconnect(env,p,repositoryId);
  if(action==='accounts') {const {vault}=await load(env,p,undefined,repositoryId);return {accounts:accountsValue(await api(env,vault,'/accounts'))};}
  if(action==='select-account') return {source:'repository',...await selectAccount(env,p,body,repositoryId)};
  if(action==='resources') {const {vault,source}=await loadPreferred(env,p,undefined,repositoryId);return {source,...await resourceCatalog(env,vault,source)};}
  throw new ApiError(404,'NOT_FOUND','This Cloudflare connection operation is unavailable.');
}
export async function dispatchCloudflare(env:AppEnv,p:Principal,action:string,body:Record<string,unknown>={},origin='',repositoryId?:string):Promise<unknown> {
  await owner(env,p);
  if(repositoryId!==undefined) return dispatchRepository(env,p,action,body,origin,requireRepositoryId(repositoryId));
  if(action==='status') {const record=await stored(env,p);return status(env,record?await unseal(env,p,record):undefined);}
  if(action==='connect') return {browserStartUrl:`${new URL(origin).origin}/settings/cloudflare`,browserAuthorizationRequired:true};
  if(action==='disconnect') return disconnect(env,p);
  if(action==='select-account') return selectAccount(env,p,body);
  const {vault}=await load(env,p);
  if(action==='accounts') return {accounts:accountsValue(await api(env,vault,'/accounts'))};
  if(action==='resources') return resourceCatalog(env,vault,'workspace');
  throw new ApiError(404,'NOT_FOUND','This Cloudflare connection operation is unavailable.');
}
async function connectionResponse(request:Request,env:AppEnv,p:Principal,action:string,repositoryId?:string):Promise<Response> {
  const origin=new URL(request.url).origin;
  if(request.method==='POST') {
    assertMutationOrigin(request);const body=await readJson(request);
    if(action==='connect'){const {cookie,...result}=await start(env,p,origin,repositoryId);return Response.json(result,{headers:{'Set-Cookie':cookie,'Cache-Control':'no-store'}});}
    if(!['disconnect','select-account'].includes(action))throw new ApiError(405,'METHOD_NOT_ALLOWED','Use a supported Cloudflare connection action.');
    return Response.json(await dispatchCloudflare(env,p,action,body,origin,repositoryId),{headers:{'Cache-Control':'no-store'}});
  }
  if(request.method!=='GET'||!['status','accounts','resources'].includes(action))throw new ApiError(405,'METHOD_NOT_ALLOWED','Use a supported Cloudflare connection action.');
  return Response.json(await dispatchCloudflare(env,p,action,{},origin,repositoryId),{headers:{'Cache-Control':'no-store'}});
}
export async function handleCloudflare(request:Request,env:AppEnv,authenticate:(request:Request,env:AppEnv)=>Promise<Principal>):Promise<Response|null> {
  const url=new URL(request.url);const path=url.pathname;if(!path.startsWith('/api/cloudflare'))return null;
  if(path==='/api/cloudflare/callback'&&request.method==='GET')return callback(request,env);
  const p=await authenticate(request,env);await owner(env,p);await service(env).rateLimit(`cloudflare:${p.userId}`,30,60000);
  return connectionResponse(request,env,p,path==='/api/cloudflare'?'status':path.slice('/api/cloudflare/'.length));
}
export async function handleRepositoryCloudflare(request:Request,env:AppEnv,p:Principal,repositoryId:string,action='status'):Promise<Response> {
  await owner(env,p);await service(env).rateLimit(`cloudflare:${p.userId}`,30,60000);
  return connectionResponse(request,env,p,action,requireRepositoryId(repositoryId));
}
