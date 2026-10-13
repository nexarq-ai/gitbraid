interface PreviewEnv {
  GITFLARE: Fetcher;
}

const cookieName = '__Host-gitflare_preview';
const capabilityPattern = /^[a-f0-9]{64}$/;

function headersForPreview(headers: HeadersInit = {}): Headers {
  const output = new Headers(headers);
  output.delete('set-cookie');
  output.set('cache-control', 'no-store');
  output.set('referrer-policy', 'no-referrer');
  output.set('x-content-type-options', 'nosniff');
  output.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  output.set('content-security-policy', "sandbox allow-scripts allow-forms; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; worker-src 'none'");
  return output;
}

export default {
  async fetch(request: Request, env: PreviewEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/open/')) {
      const capability = url.pathname.slice('/open/'.length);
      if (request.method !== 'GET' || !capabilityPattern.test(capability)) return new Response('Invalid preview link', { status: 400, headers: headersForPreview() });
      let validation: Response;
      try {
        validation = await env.GITFLARE.fetch(new Request(new URL('/', request.url), { method: 'HEAD', headers: { 'X-Gitflare-Preview': capability, 'X-Gitflare-Preview-Validate': '1' } }));
      } catch {
        return new Response('The preview service is unavailable. Try opening it again from Gitflare.', { status: 502, headers: headersForPreview() });
      }
      if (!validation.ok) return new Response('This preview is unavailable or has expired. Open a new preview from Gitflare.', { status: validation.status, headers: headersForPreview() });
      const headers = headersForPreview({ location: '/' });
      headers.set('set-cookie', `${cookieName}=${capability}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=900`);
      return new Response(null, { status: 303, headers });
    }
    const capability = request.headers.get('cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    if (!capability || !capabilityPattern.test(capability)) return new Response('Open this preview from your Gitflare mission.', { status: 401, headers: headersForPreview() });
    const headers = new Headers(request.headers);
    headers.delete('cookie');
    headers.delete('authorization');
    headers.delete('x-gitflare-preview');
    headers.set('X-Gitflare-Preview', capability);
    try {
      const response = await env.GITFLARE.fetch(new Request(request, { headers, redirect: 'manual' }));
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers: headersForPreview(response.headers) });
    } catch {
      return new Response('The preview is not responding. Open a new preview from your mission.', { status: 502, headers: headersForPreview() });
    }
  },
};
