import cloudflareIcon from "./assets/cloudflare-icon.svg";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
  type FormEvent,
} from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Input } from "@cloudflare/kumo/components/input";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import {
  ActivityIcon,
  ArrowClockwiseIcon,
  ArrowLeftIcon,
  ArrowUpRightIcon,
  BookOpenIcon,
  CaretRightIcon,
  CheckCircleIcon,
  CloudIcon,
  CopyIcon,
  CubeIcon,
  FolderSimpleIcon,
  GearSixIcon,
  GitBranchIcon,
  GitCommitIcon,
  HouseIcon,
  InfoIcon,
  ListIcon,
  LockKeyIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  RobotIcon,
  ShieldCheckIcon,
  SignOutIcon,
  XIcon,
} from "@phosphor-icons/react";
import type { AccessSnapshot, Repository, Workspace } from "../shared/types";
import { request, RequestError, selectWorkspace } from "./api";
import {
  BranchIllustration,
  EmptyState,
  ErrorNotice,
  MissionTable,
  SetupSteps,
  Status,
} from "./components";
import QuickSearch from "./QuickSearch";
import InvitationScreen from "./InvitationScreen";
import AuthScreen, { AccountScreen, isAccountRoute, type AuthConfig } from "./AuthScreen";
import WorkspaceLoader, { RouteProgress } from "./WorkspaceLoader";
import AiSettingsPanel from "./AiSettingsPanel";
import RepositoryImport, { RepositoryImportOnboarding, quoteGitArgument } from "./RepositoryImport";
import { canonicalizeLegacyHash, currentRoute, navigate as goTo, onRouteChange } from "./router";

const loadMissionDetail = () => import("./MissionDetail");
const MissionDetail = lazy(loadMissionDetail);
const loadRepositoryBrowser = () => import("./RepositoryBrowser");
const RepositoryBrowser = lazy(loadRepositoryBrowser);
const loadDocumentation = () => import("./Documentation");
const Documentation = lazy(loadDocumentation);
const loadRepositorySkills = () => import("./RepositorySkills");
const RepositorySkills = lazy(loadRepositorySkills);
const loadCloudflareConnection = () => import("./CloudflareConnection");
const CloudflareConnection = lazy(loadCloudflareConnection);
const loadMcpConnections = () => import("./McpConnections");
const McpConnections = lazy(loadMcpConnections);
const loadHomepage = () => import("./SelfHostedHome");
const Homepage = lazy(loadHomepage);
const loadAccessSettings = () => import("./AccessSettings");
const AccessSettings = lazy(loadAccessSettings);
const loadRepositoryWork = () => import("./RepositoryWork");
const RepositoryWork = lazy(loadRepositoryWork);
const loadProposalCreate = () => import("./ProposalCreate");
const ProposalCreate = lazy(loadProposalCreate);
const loadModelConnections = () => import("./ModelConnections");
const ModelConnections = lazy(loadModelConnections);
const loadIssues = () => import("./Issues");
const Issues = lazy(loadIssues);
const loadReleases = () => import("./Releases");
const Releases = lazy(loadReleases);
const loadPullRequests = () => import("./PullRequests");
const PullRequests = lazy(loadPullRequests);
const loadPullRequestCreate = () => import("./PullRequestCreate");
const PullRequestCreate = lazy(loadPullRequestCreate);
const loadBranchProtection = () => import("./BranchProtection");
const BranchProtection = lazy(loadBranchProtection);
const loadGitAccess = () => import("./GitAccess");
const GitAccess = lazy(loadGitAccess);
const workspacePages = [loadMissionDetail, loadRepositoryBrowser, loadDocumentation, loadRepositorySkills, loadCloudflareConnection, loadMcpConnections, loadAccessSettings, loadRepositoryWork, loadProposalCreate, loadModelConnections, loadIssues, loadReleases, loadPullRequests, loadPullRequestCreate, loadBranchProtection, loadGitAccess];
// Start the homepage chunk alongside the main bundle instead of after it
if (currentRoute() === "home") void loadHomepage();

type Modal = "repository" | "connect" | "learn" | "session" | null;
const blankWorkspace: Workspace = {
  name: "Your workspace",
  mode: "local",
  repositories: [],
  missions: [],
  integrations: [],
};
const runningStates = ["queued", "running", "checking", "integrating"];

const RETURN_ROUTE_KEY = "gitflare:return-route";

function isPublicRoute(route: string): boolean {
  return ["home", "signin", "signup", "source/gitflare", "deploy"].includes(route) || route.startsWith("docs") || route.startsWith("invite?") || isAccountRoute(route);
}

function takeReturnRoute(): string {
  try {
    const stored = sessionStorage.getItem(RETURN_ROUTE_KEY);
    sessionStorage.removeItem(RETURN_ROUTE_KEY);
    if (stored && !isPublicRoute(stored)) return stored;
  } catch {}
  return "overview";
}

export default function App() {
  return (
    <Suspense fallback={currentRoute() === "home" ? <main className="route-loading" aria-busy="true" /> : <WorkspaceLoader />}>
      <Workspace />
    </Suspense>
  );
}

function Workspace() {
  const [workspace, setWorkspace] = useState<Workspace>(blankWorkspace);
  const [authConfigError, setAuthConfigError] = useState("");
  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null);
  const authFlowActive = useRef(false);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [currentUserId, setCurrentUserId] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [authState, setAuthState] = useState<
    "checking" | "required" | "configuration" | "unavailable" | "authenticated"
  >("checking");
  const [signingOut, setSigningOut] = useState(false);
  const [route, setRoute] = useState(
    () => { canonicalizeLegacyHash(); return currentRoute(); },
  );
  const [routePending, startRouteTransition] = useTransition();
  const [modal, setModal] = useState<Modal>(null);
  const [sidebar, setSidebar] = useState(false);
  const [quickSearchOpen, setQuickSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [toast, setToast] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadGeneration = useRef(0);
  const hasWorkspace = useRef(false);

  const clearSession = useCallback(() => {
    loadGeneration.current += 1;
    hasWorkspace.current = false;
    selectWorkspace("");
    setPermissions([]);
    setCurrentUserId("");
    setWorkspace(blankWorkspace);
    setLoaded(false);
    setAuthState("required");
    setError("");
    setModal(null);
    setQuickSearchOpen(false);
    setSidebar(false);
    setToast("");
  }, []);

  const inFlight = useRef(0);
  const load = useCallback(async (background: unknown = false) => {
    if (background === true && inFlight.current > 0) return;
    const generation = background === true ? loadGeneration.current : ++loadGeneration.current;
    inFlight.current += 1;
    try {
      const [data, access] = await Promise.all([request<Workspace>("/api/workspace"), request<AccessSnapshot>("/api/access")]);
      if (generation !== loadGeneration.current) return;
      hasWorkspace.current = true;
      setWorkspace(data);
      setPermissions(access.permissions);
      setCurrentUserId(access.user.id);
      setLoaded(true);
      setError("");
      setAuthState("authenticated");
      if (["signin", "signup"].includes(currentRoute())) { const next = takeReturnRoute(); goTo(next, true); setRoute(next); }
    } catch (failure) {
      if (generation !== loadGeneration.current) return;
      const message =
        failure instanceof Error
          ? failure.message
          : "The workspace could not be loaded.";
      setError(message);
      if (failure instanceof RequestError && failure.status === 401) {
        clearSession();
      } else if (
        failure instanceof RequestError &&
        failure.code === "AUTH_NOT_CONFIGURED"
      ) {
        clearSession();
        setError(message);
        setAuthState("configuration");
      } else if (!hasWorkspace.current) {
        setAuthState("unavailable");
      }
    } finally {
      inFlight.current -= 1;
    }
  }, [clearSession]);

  useEffect(() => {
    if (authState !== "required" || isPublicRoute(route)) return;
    try { sessionStorage.setItem(RETURN_ROUTE_KEY, route); } catch {}
    goTo("signin", true);
  }, [authState, route]);

  useEffect(() => {
    if (authState !== "authenticated") return;
    const prefetch = () => { for (const load of workspacePages) void load().catch(() => {}); };
    const idle = (window as { requestIdleCallback?: (callback: () => void) => number }).requestIdleCallback;
    if (idle) idle(prefetch); else setTimeout(prefetch, 1500);
  }, [authState]);

  useEffect(() => {
    window.addEventListener("gitflare:session-required", clearSession);
    return () =>
      window.removeEventListener("gitflare:session-required", clearSession);
  }, [clearSession]);

  useEffect(() => {
    void request<AuthConfig>("/api/auth/config").then(setAuthConfig).catch((failure: unknown) => { setAuthConfigError(failure instanceof Error ? failure.message : "Installation configuration is unavailable."); setAuthState("unavailable"); });
    void load(true);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && !authFlowActive.current) void load(true);
    }, 15000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    return onRouteChange(() => {
      const next = currentRoute();
      setSidebar(false);
      startRouteTransition(() => {
        setRoute(next);
        setSearch("");
        setFilter("all");
      });
    });
  }, []);

  useEffect(() => {
    if (authState === "authenticated" && ["signin", "signup"].includes(route)) {
      const next = takeReturnRoute();
      goTo(next, true);
      setRoute(next);
    }
  }, [authState, route]);

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (!sidebar) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSidebar(false);
    };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [sidebar]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "k" &&
        loaded &&
        !modal
      ) {
        event.preventDefault();
        setQuickSearchOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [loaded, modal]);

  function notify(message: string) {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 5000);
  }

  function navigate(target: string) {
    goTo(target);
    startRouteTransition(() => setRoute(target));
    setSidebar(false);
  }

  const aiEnabled = workspace.ai?.enabled !== false;
  useEffect(() => { document.documentElement.classList.toggle("ai-off", !aiEnabled); }, [aiEnabled]);

  function createMission(repositoryId?: string) {
    if (!aiEnabled) { notify("AI features are turned off for this workspace. An Owner can turn them on in Settings."); return; }
    if (!permissions.includes("contribute")) { notify("Your role cannot create missions."); return; }
    navigate(repositoryId ? `repository/${repositoryId}/proposals/new` : "proposals/new");
  }

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await request("/api/session/logout", {});
      clearSession();
      goTo("signin");
      setRoute("signin");
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Sign-out could not be completed. Try again.",
      );
    } finally {
      setSigningOut(false);
    }
  }

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  const publicDocs = route.startsWith("docs") && authState !== "authenticated";
  if (publicDocs) return <main className="public-documentation"><nav className="public-docs-nav" aria-label="Documentation navigation"><a className="public-docs-brand" href="/" aria-label="Gitflare home">gitflare<span>Documentation</span></a><div><a href="/docs/overview">Guides</a><a href="/connect">Connect MCP</a><a href="/signin">Workspace →</a></div></nav><Documentation publicMode id={["overview", "install", "admin", "repositories", "mcp", "agents"].includes(route.slice(5)) ? route.slice(5) : "overview"} /></main>;
  if (route === "home" && (!authConfig || (authConfig.edition === "hosted" && !authConfig.setupRequired))) return <Homepage authenticated={authState === "authenticated"} />;
  if (!authConfig && !authConfigError) return <WorkspaceLoader />;
  if (!authConfig) return <main className="auth-screen"><div className="auth-card"><h1>Gitflare</h1><p role="status">{authConfigError}</p>{authConfigError && <Button onClick={() => window.location.reload()}>Retry</Button>}</div></main>;
  if (isAccountRoute(route) && !authConfig.setupRequired) return <AccountScreen key={route} route={route} config={authConfig} authenticated={authState === "authenticated"} onChanged={load}/>;
  if (route.startsWith("invite?")) return <InvitationScreen route={route} config={authConfig} state={authState} error={error} onRetry={load} onSignedIn={load} onFlowChange={(active) => {authFlowActive.current=active;}}/>;

  if (authState !== "authenticated" || authConfig.setupRequired) {
    return (
      <AuthScreen
        key={route === "signup" ? "signup" : "signin"}
        mode={route === "signup" ? "signup" : "signin"}
        config={authConfig}
        onFlowChange={(active) => { authFlowActive.current = active; }}
        state={authState === "authenticated" ? "required" : authState}
        error={error}
        onRetry={load}
        onSignedIn={async () => { setAuthConfig(await request<AuthConfig>("/api/auth/config")); await load(); }}
      />
    );
  }

  const creatingProposal = route === "proposals/new" || /^repository\/[^/]+\/proposals\/new$/.test(route);
  const importingRepository = /^repository\/[^/]+\/import$/.test(route);
  const importRepository = importingRepository ? workspace.repositories.find(repo => repo.id === route.split("/")[1]) : undefined;
  const proposalRepositoryId = route.startsWith("repository/") && creatingProposal ? route.split("/")[1] : undefined;
  const requestedPage = ["signin", "signup"].includes(route) ? "overview" : route.split("/")[0];
  const page = requestedPage === "access" ? "settings" : requestedPage;
  const pageName = importingRepository ? "Import code" : creatingProposal ? "Ask AI agents" :
    {
      overview: "Overview",
      repositories: "Repositories",
      missions: "Pull requests",
      mission: "Pull request",
      repository: "Repository",
      activity: "Activity",
      settings: "Settings",
      docs: "Documentation",
      connect: "Connect AI clients",
    }[page] ?? "Overview";
  const missionList = workspace.missions.filter(
    (mission) =>
      (filter === "all" ||
        (filter === "active"
          ? runningStates.includes(mission.status)
          : mission.status === filter)) &&
      `${mission.title} ${mission.prompt}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const activeCount = workspace.missions.filter((mission) =>
    runningStates.includes(mission.status),
  ).length;
  const reviewCount = workspace.missions.filter(
    (mission) => mission.status === "needs_review",
  ).length;
  const connectedCount = workspace.integrations.filter(
    (item) => item.ready,
  ).length;
  const navigation = [
    { id: "overview", label: "Overview", icon: HouseIcon },
    { id: "repositories", label: "Repositories", icon: FolderSimpleIcon },
    {
      id: "missions",
      label: "Pull requests",
      icon: GitBranchIcon,
      count: activeCount,
    },
    { id: "activity", label: "Activity", icon: ActivityIcon },
  ];
  const initial = workspace.name
    .split(/\s+/)
    .map((word) => word[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="app-shell">
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
      >
        Skip to content
      </a>
      {sidebar && (
        <button
          className="sidebar-backdrop"
          aria-label="Close navigation"
          onClick={() => setSidebar(false)}
        />
      )}
      <aside
        className={`sidebar ${sidebar ? "open" : ""}`}
        aria-label="Workspace navigation"
        id="workspace-navigation"
      >
        <a
          className="wordmark"
          href="/overview"
          style={{ textDecoration: "none" }}
        >
          <span className="brand-icon">
            <GitBranchIcon size={23} weight="bold" />
          </span>
          gitflare<span className="beta-tag">alpha</span>
        </a>
        <button
          className="quick-search-trigger"
          onClick={() => setQuickSearchOpen(true)}
          disabled={!loaded}
          aria-label="Search workspace"
        >
          <MagnifyingGlassIcon size={16} />
          <span>Quick search…</span>
          <kbd>⌘K</kbd>
        </button>
        <div className="nav-label workspace-section">{workspace.name}</div>
        <nav className="side-nav">
          {navigation.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${page === item.id || ((page === "mission" || (page === "proposals" && creatingProposal)) && item.id === "missions") || (page === "repository" && item.id === "repositories") ? "active" : ""}`}
              onClick={() => navigate(item.id)}
              aria-current={page === item.id ? "page" : undefined}
            >
              <item.icon size={17} />
              {item.label}
              {!!item.count && <span className="count">{item.count}</span>}
            </button>
          ))}
        </nav>
        <div className="nav-divider" />
        <div className="nav-label">Manage</div>
        <nav className="side-nav">
          <button
            className={`nav-item ${page === "settings" ? "active" : ""}`}
            onClick={() => navigate("settings")}
          >
            <GearSixIcon size={17} />
            Settings
          </button>
          <button className={`nav-item ai-only ${route === "settings/models" ? "active" : ""}`} aria-current={route === "settings/models" ? "page" : undefined} onClick={() => navigate("settings/models")}><RobotIcon size={17} />AI models</button>
          <button className={`nav-item ${route === "settings/cloudflare" ? "active" : ""}`} aria-current={route === "settings/cloudflare" ? "page" : undefined} onClick={() => navigate("settings/cloudflare")}><CloudIcon size={17} />Cloudflare</button>
          <button className={`nav-item ${page === "docs" ? "active" : ""}`} onClick={() => navigate("docs/overview")} aria-current={page === "docs" ? "page" : undefined}>
            <BookOpenIcon size={17} />
            Documentation
          </button>
          <button className={`nav-item ai-only ${page === "connect" ? "active" : ""}`} onClick={() => navigate("connect")}><RobotIcon size={17}/>Connect AI clients</button>
          <button className="nav-item" onClick={() => setModal("learn")}>
            <BookOpenIcon size={17} />
            How Gitflare works
            <ArrowUpRightIcon size={12} style={{ marginLeft: "auto" }} />
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-footer">
            <img src={cloudflareIcon} alt="" width="18" height="18" />
            Built on Cloudflare
          </div>
          <div className="sidebar-footer secondary">
            Independent product · Early access
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="utility-header">
          <button
            className="mobile-menu"
            aria-label="Open navigation"
            aria-expanded={sidebar}
            aria-controls="workspace-navigation"
            onClick={() => setSidebar(true)}
          >
            <ListIcon size={20} />
          </button>
          <div className="breadcrumbs">
            <span>{workspace.name}</span>
            <CaretRightIcon size={11} />
            <span>{pageName}</span>
          </div>
          <div className="utility-actions">
            <a
              href="/docs/overview"
            >
              Documentation
              <ArrowUpRightIcon size={12} />
            </a>
            <span className="status-strip">
              <span className={`status-dot ${loaded ? "good" : "warn"}`} />
              {loaded
                ? workspace.mode === "local"
                  ? "Local workspace"
                  : "Connected workspace"
                : "Connecting"}
            </span>
            {workspace.mode === "connected" && (
              <Button
                variant="ghost"
                size="base"
                icon={SignOutIcon}
                loading={signingOut}
                onClick={() => void signOut()}
              >
                Sign out
              </Button>
            )}
            <div className="user-avatar" aria-label="Workspace account">
              {initial || "GF"}
            </div>
          </div>
        </header>
        {routePending && <RouteProgress />}
        <main className="page-content" id="main-content" tabIndex={-1}>
          {error && (
            <ErrorNotice message={error} onRetry={() => void refresh()} />
          )}
          <Suspense fallback={<RouteProgress />}>
            {importingRepository ? importRepository ? <RepositoryImport key={importRepository.id} repository={importRepository} canManage={permissions.includes("manage")} canContribute={permissions.includes("contribute")} onBack={() => navigate(`repository/${importRepository.id}/code`)} onImported={item => setWorkspace(current => ({ ...current, repositories: current.repositories.map(repo => repo.id === item.id ? item : repo) }))} onCreateProposal={() => createMission(importRepository.id)} /> : <ErrorNotice message="This repository could not be found." /> : creatingProposal ? <ProposalCreate key={route} repositories={workspace.repositories} repositoryId={proposalRepositoryId} canContribute={permissions.includes("contribute")} canManage={permissions.includes("manage")} onImportRepository={id => navigate(`repository/${id}/import`)} onBack={() => navigate(proposalRepositoryId ? `repository/${proposalRepositoryId}/pulls/new` : "missions")} onCreateRepository={() => setModal("repository")} onCreated={async proposal => { await load(); navigate(`mission/${proposal.id}`); notify("Mission draft created."); }} /> : route === "settings/models" ? <ModelConnections canManage={permissions.includes("manage")} /> : route === "settings/cloudflare" ? <CloudflareConnection canManage={permissions.includes("manage")} repositories={workspace.repositories} /> : page === "connect" ? <McpConnections /> : page === "docs" ? (
              <Documentation publicMode={["overview", "install", "admin", "repositories", "mcp", "agents"].includes(route.slice(5))} id={route.slice("docs/".length) || "how-it-works"} />
            ) : page === "mission" ? (
              <MissionDetail
                key={route.split("/")[1]}
                id={route.split("/")[1]}
                initialTab={route.split("/")[2] || "overview"}
                selectedRunId={route.split("/")[3]}
                currentUserId={currentUserId}
                onTabChange={(tab) => navigate(`mission/${route.split("/")[1]}/${tab}`)}
                permissions={permissions}
                workspace={workspace}
                onBack={() => { const mission = workspace.missions.find(item => item.id === route.split("/")[1]); navigate(mission ? `repository/${mission.repositoryId}/pulls` : "missions"); }}
                onUpdate={() => void load()}
              />
            ) : page === "repository" ? (
              <RepositoryDetail
                repository={workspace.repositories.find(
                  (repo) => repo.id === route.split("/")[1],
                )}
                workspace={workspace}
                onBack={() => navigate("repositories")}
                onMission={createMission}
                onOpenMission={(id, tab, runId) => navigate(`mission/${id}/${tab || "overview"}${runId ? `/${runId}` : ""}`)}
                tab={route.split("/")[2] || "code"}
                issueNumber={route.split("/")[3]}
                releaseId={route.split("/")[3]}
                canLand={permissions.includes("land")}
                subroute={route.split("/").slice(3).join("/")}
                onRefresh={() => void load()}
                onTabChange={(tab) => navigate(`repository/${route.split("/")[1]}/${tab}`)}
                onImport={() => navigate(`repository/${route.split("/")[1]}/import`)}
                canManage={permissions.includes("manage")}
                onNotify={notify}
                canContribute={permissions.includes("contribute")}
                canExecute={permissions.includes("execute")}
              />
            ) : (
              <>
                <div className="page-heading">
                  <div>
                    <h1>{pageName}</h1>
                    <p>
                      {{
                        overview:
                          "Your code, your agents, and everything they build together.",
                        repositories:
                          "A shared home for code. Independent space for every agent.",
                        missions:
                          "Every proposed change, whether AI agents or people wrote it.",
                        activity: "Follow the work across your repositories.",
                        settings:
                          "Manage access, security, and workspace connections.",
                      }[page] ?? ""}
                    </p>
                  </div>
                  <div className="heading-actions">
                    <Button
                      variant="secondary"
                      size="base"
                      icon={
                        page === "repositories"
                          ? GitBranchIcon
                          : ArrowClockwiseIcon
                      }
                      loading={refreshing}
                      disabled={page === "repositories" && !permissions.includes("contribute")}
                      onClick={() =>
                        page === "repositories"
                          ? setModal("connect")
                          : void refresh()
                      }
                    >
                      {page === "repositories" ? "Connect existing" : "Refresh"}
                    </Button>
                    {page === "repositories" ? (
                      <Button
                        variant="primary"
                        size="base"
                        icon={PlusIcon}
                        disabled={!permissions.includes("contribute")}
                        onClick={() => setModal("repository")}
                      >
                        Create repository
                      </Button>
                    ) : (
                      page !== "settings" && (
                        <Button
                          variant="primary"
                          size="base"
                          icon={PlusIcon}
                          disabled={!permissions.includes("contribute")}
                          className="ai-only"
          onClick={() => createMission()}
                        >
                          Create mission
                        </Button>
                      )
                    )}
                  </div>
                </div>
                {page === "overview" && (
                  <>
                    <div className="workspace-help">
                      <GitBranchIcon size={20} />
                      <p>
                        Agents work independently. Review their combined changes
                        before merging.
                      </p>
                      <button
                        className="text-link"
                        onClick={() => setModal("learn")}
                      >
                        How it works
                        <ArrowUpRightIcon size={14} />
                      </button>
                    </div>
                    <div className="workspace-columns">
                      <div>
                        <div className="section-heading">
                          <h2>
                            Recent missions
                            <span className="number-tag">
                              {workspace.missions.length}
                            </span>
                          </h2>
                          <button
                            className="text-link"
                            onClick={() => navigate("missions")}
                          >
                            View all
                            <ArrowUpRightIcon size={12} />
                          </button>
                        </div>
                        <section className="panel">
                          {workspace.missions.length ? (
                            <MissionTable
                              missions={workspace.missions.slice(0, 5)}
                              workspace={workspace}
                              onOpen={(id) => navigate(`mission/${id}`)}
                            />
                          ) : (
                            <EmptyState
                              icon={<GitBranchIcon size={25} />}
                              title="The next change starts with a mission"
                              description="Describe what you want to build. Track each agent's work and review the result in one place."
                              action={
                                <Button
                                  variant="secondary"
                                  size="base"
                                  icon={PlusIcon}
                                  disabled={!permissions.includes("contribute")}
                          className="ai-only"
          onClick={() => createMission()}
                                >
                                  Create your first mission
                                </Button>
                              }
                            />
                          )}
                        </section>
                        <div
                          className="section-heading"
                          style={{ marginTop: 28 }}
                        >
                          <h2>
                            Repositories
                            <span className="number-tag">
                              {workspace.repositories.length}
                            </span>
                          </h2>
                          <button
                            className="text-link"
                            onClick={() => navigate("repositories")}
                          >
                            View all
                            <ArrowUpRightIcon size={12} />
                          </button>
                        </div>
                        <section className="panel">
                          {workspace.repositories.length ? (
                            <div className="table-scroll">
                              <table className="resource-table">
                                <thead>
                                  <tr>
                                    <th>Repository</th>
                                    <th>Storage</th>
                                    <th>Stream</th>
                                    <th />
                                  </tr>
                                </thead>
                                <tbody>
                                  {workspace.repositories
                                    .slice(0, 3)
                                    .map((repo) => (
                                      <tr key={repo.id}>
                                        <td>
                                          <div className="resource-name">
                                            <FolderSimpleIcon size={18} />
                                            <div>
                                              <button
                                                onClick={() =>
                                                  navigate(
                                                    `repository/${repo.id}`,
                                                  )
                                                }
                                              >
                                                {repo.name}
                                              </button>
                                              <small>
                                                {repo.description.length > 70
                                                  ? `${repo.description.slice(0, 70)}…`
                                                  : repo.description}
                                              </small>
                                            </div>
                                          </div>
                                        </td>
                                        <td>
                                          <Status
                                            status={
                                              repo.provider === "artifacts"
                                                ? "connected"
                                                : "local"
                                            }
                                          />
                                        </td>
                                        <td>
                                          <code style={{ fontSize: 13 }}>
                                            {repo.defaultBranch}
                                          </code>
                                        </td>
                                        <td>
                                          <Button
                                            variant="ghost"
                                            size="base"
                                            shape="square"
                                            aria-label={`Open ${repo.name}`}
                                            icon={ArrowUpRightIcon}
                                            onClick={() =>
                                              navigate(`repository/${repo.id}`)
                                            }
                                          />
                                        </td>
                                      </tr>
                                    ))}
                                </tbody>
                              </table>
                            </div>
                          ) : (
                            <EmptyState
                              icon={<FolderSimpleIcon size={25} />}
                              title="A home for your next idea"
                              description="Create a repository to keep source code and agent contributions together."
                              action={
                                <button
                                  className="text-link"
                                  disabled={!permissions.includes("contribute")}
                        onClick={() => setModal("repository")}
                                >
                                  Create repository
                                  <ArrowUpRightIcon size={12} />
                                </button>
                              }
                            />
                          )}
                        </section>
                      </div>
                      <aside className="overview-aside">
                        <SetupSteps
                          workspace={workspace}
                          onRepository={() => setModal("repository")}
                          onMission={() => createMission()}
                          onSettings={() => navigate("settings")}
                        />
                        <div className="info-card">
                          <h3>
                            <ShieldCheckIcon size={17} />
                            Review the combination
                          </h3>
                          <p>
                            Two passing changes can fail together. Gitflare
                            keeps the combined result and its checks in the same
                            review.
                          </p>
                          <button
                            className="text-link"
                            style={{ marginTop: 13, fontSize: 13 }}
                            onClick={() => setModal("learn")}
                          >
                            See how it works
                            <ArrowUpRightIcon size={12} />
                          </button>
                        </div>
                      </aside>
                    </div>
                  </>
                )}
                {page === "missions" && (
                  <>
                    <div className="page-tabs">
                      <Tabs
                        variant="underline"
                        value={filter}
                        onValueChange={setFilter}
                        tabs={[
                          { value: "all", label: "All" },
                          {
                            value: "active",
                            label: `Active (${activeCount})`,
                          },
                          {
                            value: "needs_review",
                            label: `Needs review (${reviewCount})`,
                          },
                          { value: "draft", label: "Drafts" },
                          { value: "integrated", label: "Integrated" },
                        ]}
                      />
                    </div>
                    <div className="searchbar">
                      <div className="search-input">
                        <MagnifyingGlassIcon size={15} />
                        <Input
                          aria-label="Search pull requests"
                          placeholder="Search pull requests…"
                          value={search}
                          onChange={(event) => setSearch(event.target.value)}
                        />
                      </div>
                      <span className="status-strip">
                        {missionList.length}{" "}
                        {missionList.length === 1 ? "pull request" : "pull requests"}
                      </span>
                    </div>
                    <section className="panel">
                      {missionList.length ? (
                        <MissionTable
                          missions={missionList}
                          workspace={workspace}
                          onOpen={(id) => navigate(`mission/${id}`)}
                        />
                      ) : (
                        <EmptyState
                          icon={<GitBranchIcon size={25} />}
                          title={
                            search || filter !== "all"
                              ? "No missions match this view"
                              : "Create your first mission"
                          }
                          description={
                            search || filter !== "all"
                              ? "Try another search or choose a different status."
                              : "Start with a clear outcome. Give each agent its own assignment, then review their work together."
                          }
                          action={
                            <Button
                              variant="secondary"
                              size="base"
                              onClick={
                                search || filter !== "all"
                                  ? () => {
                                      setSearch("");
                                      setFilter("all");
                                    }
                                  : () => createMission()
                              }
                            >
                              {search || filter !== "all"
                                ? "Clear filters"
                                : "Create mission"}
                            </Button>
                          }
                        />
                      )}
                    </section>
                  </>
                )}
                {page === "repositories" && (
                  <>
                    <div className="searchbar">
                      <div className="search-input">
                        <MagnifyingGlassIcon size={15} />
                        <Input
                          aria-label="Search repositories"
                          placeholder="Search repositories…"
                          value={search}
                          onChange={(event) => setSearch(event.target.value)}
                        />
                      </div>
                    </div>
                    <div className="repo-grid">
                      {workspace.repositories
                        .filter((repo) =>
                          `${repo.name} ${repo.description}`
                            .toLowerCase()
                            .includes(search.toLowerCase()),
                        )
                        .map((repo) => (
                          <article className="repo-card" key={repo.id}>
                            <div className="repo-card-head">
                              <FolderSimpleIcon size={20} />
                              <h2>{repo.name}</h2>
                              <Status
                                status={
                                  repo.provider === "artifacts"
                                    ? "connected"
                                    : "local"
                                }
                              />
                            </div>
                            <p>
                              {repo.description || "No description added yet."}
                            </p>
                            <div className="repo-card-meta">
                              <span>
                                <GitBranchIcon size={13} />
                                {repo.defaultBranch}
                              </span>
                              <span>
                                <GitCommitIcon size={13} />
                                {repo.headSha?.slice(0, 8) ?? "No revision yet"}
                              </span>
                              <span>
                                {
                                  workspace.missions.filter(
                                    (mission) =>
                                      mission.repositoryId === repo.id,
                                  ).length
                                }{" "}
                                missions
                              </span>
                            </div>
                            <button
                              className="text-link"
                              onClick={() => navigate(`repository/${repo.id}`)}
                            >
                              Open repository
                              <ArrowUpRightIcon size={12} />
                            </button>
                          </article>
                        ))}
                    </div>
                    {!workspace.repositories.some((repo) =>
                      `${repo.name} ${repo.description}`
                        .toLowerCase()
                        .includes(search.toLowerCase()),
                    ) && (
                      <section className="panel">
                        <EmptyState
                          icon={<FolderSimpleIcon size={25} />}
                          title={
                            search
                              ? "No repositories found"
                              : "Create your first repository"
                          }
                          description={
                            search
                              ? "Try searching for another name."
                              : "Keep your code and its mission history together."
                          }
                          action={
                            <Button
                              variant="primary"
                              size="base"
                              disabled={!permissions.includes("contribute")}
                        onClick={() => setModal("repository")}
                            >
                              Create repository
                            </Button>
                          }
                        />
                      </section>
                    )}
                  </>
                )}
                {page === "activity" && (
                  <ActivityView
                    workspace={workspace}
                    onOpen={(id) => navigate(`mission/${id}`)}
                  />
                )}
                {page === "settings" && (
                  <>
                    <section className="panel settings-cloudflare"><div className="settings-cloudflare-heading"><img src={cloudflareIcon} alt="" /><div><h2>Cloudflare account and resources</h2><p>Connect your account and manage the services used by your repositories.</p></div></div><Button variant="secondary" size="base" onClick={() => navigate("settings/cloudflare")}>Manage Cloudflare</Button></section>
                    <section className="panel settings-cloudflare ai-only"><div className="settings-cloudflare-heading"><RobotIcon size={27} /><div><h2>AI models</h2><p>Choose available Workers AI models and manage provider connections.</p></div></div><Button variant="secondary" size="base" onClick={() => navigate("settings/models")}>Manage AI models</Button></section>
                    <AiSettingsPanel settings={workspace.ai} canManage={permissions.includes("manage")} onChanged={load} />
                    <AccessSettings selfHosted={authConfig.edition === "self-hosted"} repositories={workspace.repositories} onWorkspaceChanged={load} />

                    <section className="panel">
                      <div className="panel-header">
                        <h2>Workspace connections</h2>
                        <span className="number-tag">
                          {connectedCount} of {workspace.integrations.length}{" "}
                          configured
                        </span>
                      </div>
                      {workspace.integrations.map((item) => (
                        <div className="readiness-row" key={item.id}>
                          <div className="service-icon">
                            {item.id === "artifacts" ? (
                              <GitBranchIcon size={19} />
                            ) : item.id === "sandbox" ? (
                              <CubeIcon size={19} />
                            ) : item.id === "model" ? (
                              <RobotIcon size={19} />
                            ) : (
                              <LockKeyIcon size={19} />
                            )}
                          </div>
                          <div>
                            <h3>{item.name}</h3>
                            <p>{item.detail}</p>
                          </div>
                          <Status status={item.ready ? "ready" : "blocked"} />
                        </div>
                      ))}
                      <div className="notice-inline">
                        Connections are configured in your deployment. Refresh
                        this page after changing them.
                      </div>
                    </section>
                    <div className="info-card" style={{ maxWidth: 650 }}>
                      <h3>
                        <InfoIcon size={16} />
                        About this workspace
                      </h3>
                      <p>
                        {workspace.mode === "local"
                          ? "This is a local development workspace. Repository records and mission drafts are saved locally. Git hosting and agent execution require connected services."
                          : "Your account permissions determine what you can access and change. Agent execution is limited to authorized repositories and the services configured for this deployment."}
                      </p>
                      <a
                        href="https://developers.cloudflare.com/artifacts/get-started/"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Artifacts setup guide
                        <ArrowUpRightIcon size={12} />
                      </a>
                    </div>
                  </>
                )}
              </>
            )}
            <footer className="bottom-note">
              <span>
                <CloudIcon size={13} />
                Gitflare · A workspace for human and agent collaboration
              </span>
              <span>
                {workspace.mode === "local"
                  ? "Local development · No simulated execution"
                  : "Private workspace"}
              </span>
            </footer>
          </Suspense>
        </main>
      </div>
      <QuickSearch
        open={quickSearchOpen}
        workspace={workspace}
        onClose={() => setQuickSearchOpen(false)}
        onNavigate={navigate}
      />
      <CreationDialog
        modal={modal}
        onClose={() => setModal(null)}
        workspace={workspace}
        onCreated={async (item, importCode) => {
          await load();
          setModal(null);
          navigate(importCode ? `repository/${item.id}/import` : creatingProposal ? `repository/${item.id}/proposals/new` : `repository/${item.id}`);
          notify("Repository created.");
        }}
        onSignedIn={async () => {
          setModal(null);
          await load();
        }}
      />
      {toast && (
        <div className="app-toast" role="status">
          <CheckCircleIcon size={18} />
          {toast}
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <XIcon size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

function ActivityView({
  workspace,
  onOpen,
}: {
  workspace: Workspace;
  onOpen: (id: string) => void;
}) {
  const events = workspace.missions
    .flatMap((mission) =>
      mission.events.map((event) => ({ ...event, mission })),
    )
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Recorded activity</h2>
        <span className="number-tag">{events.length} events</span>
      </div>
      {events.length ? (
        <div className="panel-body">
          <ol className="timeline">
            {events.map((event) => (
              <li key={`${event.mission.id}-${event.id}`}>
                <span className="timeline-marker" />
                <p>{event.message}</p>
                <small>
                  <button
                    className="text-link"
                    style={{ fontSize: 13 }}
                    onClick={() => onOpen(event.mission.id)}
                  >
                    {event.mission.title}
                  </button>{" "}
                  · {new Date(event.timestamp).toLocaleString()}
                </small>
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <EmptyState
          icon={<ActivityIcon size={25} />}
          title="Your workspace history starts here"
          description="Mission creation, agent execution, checks, and review decisions will appear as they happen."
        />
      )}
    </section>
  );
}

function RepositoryDetail({
  repository,
  workspace,
  onBack,
  onMission,
  onOpenMission,
  onNotify,
  canContribute,
  canExecute,
  canManage,
  tab,
  issueNumber,
  subroute,
  onRefresh,
  onTabChange,
  onImport,
  releaseId,
  canLand,
}: {
  repository?: Repository;
  workspace: Workspace;
  onBack: () => void;
  onMission: (id: string) => void;
  onOpenMission: (id: string, tab?: string, runId?: string) => void;
  onNotify: (message: string) => void;
  canContribute: boolean;
  canExecute: boolean;
  canManage: boolean;
  tab: string;
  issueNumber?: string;
  subroute: string;
  onRefresh: () => void;
  onTabChange: (tab: string) => void;
  onImport: () => void;
  releaseId?: string;
  canLand: boolean;
}) {
  if (!repository)
    return (
      <>
        <button className="header-back" onClick={onBack}>
          <ArrowLeftIcon size={13} />
          All repositories
        </button>
        <ErrorNotice message="This repository could not be found." />
      </>
    );
  const missions = workspace.missions.filter(
    (mission) => mission.repositoryId === repository.id,
  );
  const openPullCount = missions.filter((mission) => mission.branchChange ? !mission.branchChange.closedAt && mission.status !== "integrated" : !["integrated", "cancelled"].includes(mission.status)).length;
  return (
    <>
      <button className="header-back" onClick={onBack}>
        <ArrowLeftIcon size={13} />
        All repositories
      </button>
      <div className="page-heading">
        <div>
          <h1 style={{ display: "flex", alignItems: "center", gap: 11 }}>
            <FolderSimpleIcon size={25} color="#7d8b9e" />
            {repository.name}
          </h1>
          <p>
            {repository.description ||
              "Your source code and its mission history."}
          </p>
        </div>
        <Button
          variant="primary"
          size="base"
          icon={PlusIcon}
          disabled={!canContribute}
          onClick={() => onTabChange("pulls/new")}
        >
          New pull request
        </Button>
      </div>
      <nav className="repository-navigation" aria-label="Repository navigation">
        {[
            { value: "code", label: "Code" },
            { value: "issues", label: "Issues" },
            { value: "pulls", label: `Pull requests (${openPullCount})` },
            { value: "agents", label: `Agents (${missions.reduce((count, mission) => count + (mission.epoch > 0 ? mission.runs.length : 0), 0)})` },
            { value: "checks", label: `Checks (${missions.reduce((count, mission) => count + mission.checks.length, 0)})` },
            { value: "skills", label: "Skills", ai: true },
            { value: "releases", label: "Releases" },
            { value: "cloudflare", label: "Cloudflare" },
            { value: "settings/branches", label: "Branches" },
            { value: "overview", label: "Overview" },
          ].map((item) => <button key={item.value} className={"ai" in item && item.ai ? "ai-only" : undefined} aria-current={tab === item.value || `${tab}/${subroute}` === item.value || (tab === "proposals" && item.value === "pulls") ? "page" : undefined} onClick={() => onTabChange(item.value)}>{item.label}</button>)}
      </nav>
      {tab === "issues" ? <Issues key={repository.id} repository={repository} issueNumber={issueNumber} missions={missions} /> : tab === "releases" ? <Releases key={repository.id} repository={repository} releaseId={releaseId} canLand={canLand} onNotify={onNotify} /> : tab === "pulls" || tab === "proposals" ? subroute === "new" ? <PullRequestCreate key={repository.id} repository={repository} canContribute={canContribute} canExecute={canExecute} onCreated={onRefresh} onAskAgents={() => onMission(repository.id)} /> : <PullRequests key={repository.id} repositoryId={repository.id} missions={missions} canContribute={canContribute} /> : tab === "settings" && subroute === "branches" ? <BranchProtection key={repository.id} repository={repository} canManage={canManage} onNotify={onNotify} /> : ["agents", "checks"].includes(tab) ? <RepositoryWork key={`${repository.id}-${tab}`} tab={tab} missions={missions} canContribute={canContribute} onCreate={() => onMission(repository.id)} onOpen={onOpenMission} /> : tab === "skills" ? <RepositorySkills key={repository.id} repository={repository} canContribute={canContribute} canExecute={canExecute} onOpenMission={onOpenMission} /> : tab === "cloudflare" ? <CloudflareConnection canManage={canManage} repository={repository} repositoryId={repository.id} /> : tab === "code" ? (
        <><RepositoryImportOnboarding key={repository.id} repository={repository} canManage={canManage} onImport={onImport} /><RepositoryBrowser key={repository.id} repository={repository} />{repository.provider === "artifacts" && <GitAccess key={`git-${repository.id}`} repository={repository} onNotify={onNotify} />}</>
      ) : tab === "overview" ? (
        <>
          <section className="panel">
            <div className="panel-header">
              <h2>Repository details</h2>
              <Status
                status={
                  repository.provider === "artifacts" ? "connected" : "local"
                }
              />
            </div>
            <div className="panel-body">
              <div className="summary-grid" style={{ marginTop: 0 }}>
                <div>
                  <span>Default stream</span>
                  <strong>
                    <code>{repository.defaultBranch}</code>
                  </strong>
                </div>
                <div>
                  <span>Current revision</span>
                  <strong>
                    <code>
                      {repository.headSha?.slice(0, 12) ?? "No revision yet"}
                    </code>
                  </strong>
                </div>
                <div>
                  <span>Git storage</span>
                  <strong>
                    {repository.provider === "artifacts"
                      ? "Cloudflare Artifacts"
                      : "Local workspace record"}
                  </strong>
                </div>
                <div>
                  <span>Created</span>
                  <strong>
                    {new Date(repository.createdAt).toLocaleDateString()}
                  </strong>
                </div>
              </div>
              {repository.remote && (
                <div className="clipboard-row">
                  <code>git clone {quoteGitArgument(repository.remote)}</code>
                  <Button
                    variant="ghost"
                    size="base"
                    shape="square"
                    aria-label="Copy clone command"
                    icon={CopyIcon}
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(`git clone ${quoteGitArgument(repository.remote ?? "")}`)
                        .then(() => onNotify("Clone command copied."))
                        .catch(() =>
                          onNotify("Copy is unavailable in this browser."),
                        );
                    }}
                  />
                </div>
              )}
            </div>
          </section>
          {repository.provider === "local" && (
            <div className="alert info" style={{ marginTop: 20 }}>
              <InfoIcon size={17} />
              <div className="alert-text">
                This is a local workspace record. Connect Artifacts to host Git
                source code and run agent work.
              </div>
            </div>
          )}
          <section className="panel" style={{ marginTop: 24 }}>
            <div className="panel-header">
              <h2>Recent missions</h2>
              <button className="text-link" onClick={() => onTabChange("proposals")}>
                View all
                <ArrowUpRightIcon size={12} />
              </button>
            </div>
            {missions.length ? (
              <MissionTable
                missions={missions.slice(0, 5)}
                workspace={workspace}
                onOpen={onOpenMission}
              />
            ) : (
              <EmptyState
                icon={<GitBranchIcon size={25} />}
                title="What should we build next?"
                description="Start a mission to give your agents a clear outcome and track their contributions."
                action={
                  <Button
                    variant="secondary"
                    size="base"
                    disabled={!canContribute}
          className="ai-only"
          onClick={() => onMission(repository.id)}
                  >
                    Create mission
                  </Button>
                }
              />
            )}
          </section>
        </>
      ) : (
        <section className="panel">
          {missions.length ? (
            <MissionTable
              missions={missions}
              workspace={workspace}
              onOpen={onOpenMission}
            />
          ) : (
            <EmptyState
              icon={<GitBranchIcon size={25} />}
              title="No missions yet"
              description="Create your first mission for this repository."
              action={
                <Button
                  variant="secondary"
                  size="base"
                  disabled={!canContribute}
          className="ai-only"
          onClick={() => onMission(repository.id)}
                >
                  Create mission
                </Button>
              }
            />
          )}
        </section>
      )}
    </>
  );
}

function CreationDialog({
  modal,
  onClose,
  workspace,
  onCreated,
  onSignedIn,
}: {
  modal: Modal;
  onClose: () => void;
  workspace: Workspace;
  onCreated: (item: Repository, importCode?: boolean) => Promise<void>;
  onSignedIn: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [initializeReadme, setInitializeReadme] = useState(true);
  const [importCode, setImportCode] = useState(false);
  const [gitignore, setGitignore] = useState("none");
  const [license, setLicense] = useState("none");
  const [copyrightHolder, setCopyrightHolder] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mutation = useRef<{ signature: string; key: string } | null>(null);

  useEffect(() => {
    setName("");
    setDescription("");
    setImportCode(false); setInitializeReadme(true); setGitignore("none"); setLicense("none"); setCopyrightHolder("");
    setToken("");
    setError("");
    setBusy(false);
    mutation.current = null;
  }, [modal]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    const body = modal === "session" ? { token } : { name: name.trim(), description: description.trim(), ...(modal === "repository" ? { initializeReadme: importCode ? false : initializeReadme, gitignore: importCode ? "none" : gitignore, license: importCode ? "none" : license, copyrightHolder: importCode ? undefined : copyrightHolder.trim() || undefined } : {}) };
    const signature = JSON.stringify({ modal, body });
    if (mutation.current?.signature !== signature)
      mutation.current = { signature, key: crypto.randomUUID() };
    try {
      if (modal === "session") {
        await request("/api/session", body, mutation.current.key);
        setToken("");
        await onSignedIn();
      } else if (modal === "repository" || modal === "connect") {
        const result = await request<Repository>(
          modal === "connect"
            ? "/api/repositories/connect"
            : "/api/repositories",
          body,
          mutation.current.key,
        );
        await onCreated(result, modal === "repository" && importCode);
      }
      mutation.current = null;
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The request could not be completed.",
      );
    } finally {
      setBusy(false);
    }
  }

  const titleText = {
    repository: "Create a repository",
    connect: "Connect an existing repository",
    learn: "From intent to a reviewed change",
    session: "Sign in to Gitflare",
  }[modal ?? "repository"];
  const descriptionText = {
    repository: "A home for your code and every agent contribution.",
    connect:
      "Add a repository that already exists in the Artifacts namespace connected to this workspace.",
    learn:
      "Keep the speed of parallel agents, with a clear record of what changed and why.",
    session:
      "Enter the owner access token for this workspace. It is used to establish a private session.",
  }[modal ?? "repository"];

  return (
    <Dialog.Root
      open={modal !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Dialog size={modal === "learn" ? "xl" : "lg"} className="dialog-content">
        <div className="dialog-title-row">
          <Dialog.Title className="dialog-title">{titleText}</Dialog.Title>
          <Button
            variant="ghost"
            size="base"
            shape="square"
            icon={XIcon}
            aria-label="Close dialog"
            disabled={busy}
            onClick={onClose}
          />
        </div>
        <Dialog.Description className="dialog-description">
          {descriptionText}
        </Dialog.Description>
        {modal === "learn" ? (
          <>
            <BranchIllustration />
            <div className="learn-grid">
              <div>
                <strong>1. Define the work</strong>
                <p>
                  Choose a repository, describe the outcome, and assign
                  independent tasks.
                </p>
              </div>
              <div>
                <strong>2. Follow the evidence</strong>
                <p>
                  Inspect each agent's fork, revisions, actual changes, and
                  recorded checks.
                </p>
              </div>
              <div>
                <strong>3. Review together</strong>
                <p>
                  Test the combined candidate. Approve the exact revision you
                  reviewed.
                </p>
              </div>
            </div>
            <p className="terminology-note">
              A stream is a Git branch. A revision is a Git commit. Landing
              changes merges an approved result into your repository. Your
              existing Git commands still work.
            </p>
            <div className="dialog-actions">
              <Button variant="primary" size="base" onClick={onClose}>
                Got it
              </Button>
            </div>
          </>
        ) : (
          <form onSubmit={(event) => void submit(event)}>
            {modal === "session" ? (
              <div className="form-field">
                <label htmlFor="owner-token">Owner access token</label>
                <Input
                  id="owner-token"
                  aria-label="Owner access token"
                  type="password"
                  required
                  autoComplete="current-password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                />
                <small>Your token is not saved in browser storage.</small>
              </div>
            ) : modal === "repository" || modal === "connect" ? (
              <>
                <div className="form-field">
                  <label htmlFor="repository-name">Repository name</label>
                  <Input
                    id="repository-name"
                    aria-label="Repository name"
                    placeholder="my-edge-app"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    required
                    maxLength={64}
                    pattern="[a-z0-9][a-z0-9-]*"
                  />
                  <small>Lowercase letters, numbers, and hyphens.</small>
                </div>
                <div className="form-field">
                  <label htmlFor="repository-description">
                    Description{" "}
                    <span style={{ color: "#929dab", fontWeight: 400 }}>
                      (optional)
                    </span>
                  </label>
                  <Input
                    id="repository-description"
                    aria-label="Repository description"
                    placeholder="What are you building?"
                    value={description}
                    maxLength={500}
                    onChange={(event) => setDescription(event.target.value)}
                  />
                </div>
                {modal === "repository" && <div className="form-field"><label htmlFor="repository-start">Start this repository</label><select id="repository-start" value={importCode ? "import" : "new"} onChange={event => setImportCode(event.target.value === "import")}><option value="new">Start a new project</option><option value="import">Import existing code</option></select><small>{importCode ? "Create an empty repository, then choose your project ZIP on the import page." : "Choose initial setup files for your repository."}</small></div>}
                {modal === "repository" && !importCode && <div className="form-field"><label className="access-checkbox"><input type="checkbox" checked={initializeReadme} onChange={event => setInitializeReadme(event.target.checked)}/>Initialize with a README</label><label htmlFor="repository-gitignore">.gitignore template</label><select id="repository-gitignore" value={gitignore} onChange={event => setGitignore(event.target.value)}>{["none", "Node", "Python"].map(value => <option key={value} value={value}>{value === "none" ? "None" : value}</option>)}</select><label htmlFor="repository-license">License</label><select id="repository-license" value={license} onChange={event => setLicense(event.target.value)}>{["none", "MIT", "Apache-2.0"].map(value => <option key={value} value={value}>{value === "none" ? "No license" : value}</option>)}</select>{license === "MIT" && <><label htmlFor="repository-copyright">Copyright holder</label><Input id="repository-copyright" value={copyrightHolder} onChange={event => setCopyrightHolder(event.target.value)} required maxLength={200}/></>}</div>}
                {modal === "repository" &&
                  workspace.mode === "local" &&
                  !workspace.integrations.find(
                    (item) => item.id === "artifacts",
                  )?.ready && (
                    <div className="alert info">
                      <InfoIcon size={16} />
                      <div className="alert-text">
                        This creates a local workspace record. Connect Artifacts
                        for Git hosting.
                      </div>
                    </div>
                  )}
              </>
            ) : null}
            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}
            <div className="dialog-actions">
              <Button
                variant="secondary"
                size="base"
                type="button"
                disabled={busy}
                onClick={onClose}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="base"
                type="submit"
                loading={busy}
              >
                {modal === "session"
                  ? "Sign in"
                  : modal === "repository"
                    ? "Create repository"
                    : modal === "connect"
                      ? "Connect repository"
                      : "Create repository"}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </Dialog.Root>
  );
}
