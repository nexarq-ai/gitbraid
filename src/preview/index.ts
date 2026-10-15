interface PreviewEnv {
  GITFLARE: Fetcher;
}

const cookieName = '__Host-gitflare_preview';
const capabilityPattern = /^(?:[a-z0-9-]{1,64}\.)?[a-f0-9]{64}$/;
const isolationHeader = 'x-gitflare-preview-isolation';
const sharedOriginPolicy = "sandbox allow-scripts allow-forms; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; worker-src 'none'";
const isolatedOriginPolicy = "sandbox allow-scripts allow-forms allow-same-origin allow-modals allow-popups allow-downloads; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; worker-src 'self' blob:";

function headersForPreview(headers: HeadersInit = {}): Headers {
  const output = new Headers(headers);
  const isolated = output.get(isolationHeader) === 'origin';
  output.delete(isolationHeader);
  output.delete('set-cookie');
  output.set('cache-control', 'no-store');
  output.set('referrer-policy', 'no-referrer');
  output.set('x-content-type-options', 'nosniff');
  output.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  output.set('content-security-policy', isolated ? isolatedOriginPolicy : sharedOriginPolicy);
  return output;
}

function previewNotice(status: number, title: string, detail: string): Response {
  const headers = headersForPreview({ 'content-type': 'text/html; charset=utf-8' });
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · Gitflare</title><style>body{margin:0;background:#f8f9fb;color:#202329;font-family:system-ui,sans-serif;line-height:1.6}main{max-width:520px;margin:12vh auto;padding:32px;border:1px solid #e2e5e9;border-radius:12px;background:white}p{color:#59616e}h1{font-size:24px;line-height:1.3}small{color:#727b89}@media(max-width:600px){main{margin:48px 20px;padding:24px}}</style></head><body><main><small>GITFLARE · ISOLATED PREVIEW</small><h1>${title}</h1><p>${detail}</p><p>Return to your proposal in Gitflare and choose <strong>Prepare preview</strong> or <strong>Refresh preview</strong>, then open the new link.</p><small>You can close this tab.</small></main></body></html>`, { status, headers });
}

export default {
  async fetch(request: Request, env: PreviewEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/open/')) {
      const capability = url.pathname.slice('/open/'.length);
      if (request.method !== 'GET' || !capabilityPattern.test(capability)) return previewNotice(400, 'Preview link invalid', 'This link cannot open a candidate preview.');
      let validation: Response;
      try {
        validation = await env.GITFLARE.fetch(new Request(new URL('/', request.url), { method: 'HEAD', headers: { 'X-Gitflare-Preview': capability, 'X-Gitflare-Preview-Validate': '1' } }));
      } catch {
        return previewNotice(502, 'Preview temporarily unavailable', 'The preview service could not be reached. Try again from Gitflare.');
      }
      if (validation.status >= 500) return previewNotice(validation.status, 'Preview temporarily unavailable', 'The preview service could not validate this link. Try again from Gitflare.');
      if (!validation.ok) return previewNotice(validation.status, 'Preview link no longer available', 'Preview links expire after 15 minutes. A changed revision or revoked access also closes the preview.');
      const headers = headersForPreview({ location: '/' });
      headers.set('set-cookie', `${cookieName}=${capability}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=900`);
      return new Response(null, { status: 303, headers });
    }
    const capability = request.headers.get('cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    if (!capability || !capabilityPattern.test(capability)) return previewNotice(401, 'Open a fresh preview', 'This tab does not have an active preview session.');
    const upgrade = request.headers.get('upgrade')?.toLowerCase() === 'websocket';
    if (upgrade && request.headers.get('origin') !== url.origin) return new Response('Cross-origin preview sockets are not allowed.', { status: 403, headers: headersForPreview() });
    const headers = new Headers(request.headers);
    headers.delete('cookie');
    headers.delete('authorization');
    headers.delete('x-gitflare-preview');
    headers.delete(isolationHeader);
    headers.set('X-Gitflare-Preview', capability);
    try {
      const response = await env.GITFLARE.fetch(new Request(request, { headers, redirect: 'manual' }));
      if (response.webSocket) return new Response(null, { status: 101, webSocket: response.webSocket, headers: headersForPreview(response.headers) });
      if (response.status === 410) return previewNotice(410, 'Preview link no longer available', 'This preview has expired, its revision changed, or its access was revoked.');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers: headersForPreview(response.headers) });
    } catch {
      return previewNotice(502, 'Preview temporarily unavailable', 'The preview did not respond. Try preparing it again from Gitflare.');
    }
  },
};
