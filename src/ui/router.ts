const ROUTE_EVENT = "gitflare:route";
// Bearer tokens travel in the fragment so they never reach server logs or Referer headers
const TOKEN_ROUTES: Record<string, (fragment: string) => string> = {
  invite: (fragment) => `invite?${fragment}`,
  "verify-email": (fragment) => `verify-email/${fragment}`,
  "reset-password": (fragment) => `reset-password/${fragment}`,
};
const ROUTE_ALIASES: [RegExp, string][] = [
  [/^login$/, "signin"],
  [/^(repository\/[^/]+)\/streams$/, "$1/settings/branches"],
  [/^(repository\/[^/]+)\/checkpoints(\/|$)/, "$1/releases$2"],
];
const SERVER_PATH = /^\/(api|mcp|oauth|\.well-known|llms\.txt|assets|social|git|source\/gitflare\.git)(\/|$)|\.[a-z0-9]+$/i;

function trimSlashes(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

export function routeFromLocation(pathname: string, hash: string): string {
  let path: string;
  try { path = trimSlashes(decodeURIComponent(pathname)); } catch { return "not-found"; }
  const fragment = hash.slice(1);
  if (!path) return fragment || "home";
  const tokenRoute = TOKEN_ROUTES[path];
  if (tokenRoute) return fragment ? tokenRoute(fragment) : path;
  return ROUTE_ALIASES.reduce((route, [pattern, target]) => route.replace(pattern, target), path);
}

export function routeUrl(route: string): string {
  if (!route || route === "home") return "/";
  const query = route.indexOf("?");
  if (query > 0 && !route.startsWith("invite?")) return `${routeUrl(route.slice(0, query))}${route.slice(query)}`;
  if (route.startsWith("invite?")) return `/invite#${route.slice("invite?".length)}`;
  const [head, ...rest] = route.split("/");
  if (head in TOKEN_ROUTES && rest.length) return `/${head}#${rest.join("/")}`;
  return `/${route}`;
}

export function currentRoute(): string {
  return routeFromLocation(window.location.pathname, window.location.hash);
}

export function navigate(route: string, replace = false): void {
  const url = routeUrl(route);
  if (url !== `${window.location.pathname}${window.location.search}${window.location.hash}`) window.history[replace ? "replaceState" : "pushState"](null, "", url);
  window.dispatchEvent(new Event(ROUTE_EVENT));
}

export function canonicalizeLegacyHash(): void {
  const { pathname, hash } = window.location;
  if (trimSlashes(pathname) || hash.length < 2) return;
  window.history.replaceState(null, "", routeUrl(hash.slice(1)));
}

export function isAppPath(pathname: string): boolean {
  return !SERVER_PATH.test(pathname);
}

export function onRouteChange(listener: () => void): () => void {
  const legacy = () => {
    canonicalizeLegacyHash();
    listener();
  };
  const click = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!anchor || (anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return;
    const url = new URL(anchor.href, window.location.href);
    if (url.origin !== window.location.origin || !isAppPath(url.pathname)) return;
    const samePage = url.pathname === window.location.pathname && url.search === window.location.search;
    if (samePage && url.hash && !(trimSlashes(url.pathname) in TOKEN_ROUTES)) return;
    event.preventDefault();
    const target = `${url.pathname}${url.search}${url.hash}`;
    if (target !== `${window.location.pathname}${window.location.search}${window.location.hash}`) window.history.pushState(null, "", target);
    window.scrollTo(0, 0);
    listener();
  };
  window.addEventListener("popstate", listener);
  window.addEventListener(ROUTE_EVENT, listener);
  window.addEventListener("hashchange", legacy);
  document.addEventListener("click", click);
  return () => {
    window.removeEventListener("popstate", listener);
    window.removeEventListener(ROUTE_EVENT, listener);
    window.removeEventListener("hashchange", legacy);
    document.removeEventListener("click", click);
  };
}

export const PUBLIC_DOC_IDS = ["overview", "install", "admin", "repositories", "mcp", "agents"];
export const POLICY_ROUTES = ["terms", "privacy", "acceptable-use", "cookies", "security", "support"];
export const PUBLIC_PRODUCT_ROUTES = ["product", "ai-clients", "open-source", "repositories", "connectors", "connect"];

export function isPublicDocumentationRoute(route: string): boolean {
  return route === "docs" || PUBLIC_DOC_IDS.some(id => route === `docs/${id}`);
}

export function isKnownAppRoute(route: string): boolean {
  return ["home", "signin", "signup", "source/gitflare", "deploy", "overview", "missions", "activity", "access", "proposals/new", ...POLICY_ROUTES, ...PUBLIC_PRODUCT_ROUTES].includes(route)
    || /^settings(?:\/(?:models|cloudflare))?$/.test(route)
    || /^docs(?:\/[^/]+)?$/.test(route)
    || /^mission\/[^/]+(?:\/(?:overview|changes|checks|discussion|activity|attempts)|\/agents(?:\/[^/]+)?)?$/.test(route)
    || /^repository\/[^/]+(?:\/(?:code|overview|agents|checks|skills|cloudflare|import)|\/settings\/branches|\/(?:pulls|proposals)(?:\/new)?|\/(?:issues|releases)(?:\/[^/]+)?)?$/.test(route)
    || /^(?:forgot-password|reset-password|verify-email)(?:\/[^/]+)?$/.test(route)
    || route === "invite" || route.startsWith("invite?");
}
