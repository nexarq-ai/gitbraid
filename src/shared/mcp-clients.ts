export type McpClientStep = { text: string; code?: string; label?: string };
export type McpClientLink = { label: string; href: string };
export type McpClientGuide = {
  id: string;
  name: string;
  summary: string;
  steps: McpClientStep[];
  link?: McpClientLink;
  note?: string;
  source: string;
};

const SERVER_NAME = 'gitflare';
const json = (value: unknown) => JSON.stringify(value, null, 2);

function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function cursorInstallLink(endpoint: string): string {
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${SERVER_NAME}&config=${encodeURIComponent(base64(JSON.stringify({ url: endpoint })))}`;
}

export function vscodeInstallLink(endpoint: string): string {
  return `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: SERVER_NAME, type: 'http', url: endpoint }))}`;
}

export function mcpClientGuides(endpoint: string): McpClientGuide[] {
  return [
    {
      id: 'claude',
      name: 'Claude',
      summary: 'Claude on the web, Desktop and mobile through a custom connector.',
      steps: [
        { text: 'Open Customize → Connectors, choose + Add, then Add custom connector.' },
        { text: 'Name it Gitflare and paste the server URL. Keep OAuth sign-in; Claude can use its published identity or register automatically, and Gitflare accepts both.', code: endpoint, label: 'Server URL' },
        { text: 'Choose Add, then connect. Sign in to Gitflare if asked, pick an access level and allow the connection.' },
        { text: 'Enable the connector in a conversation and ask Claude to list your Gitflare repositories.' },
      ],
      note: 'On Team and Enterprise plans an organization Owner adds the connector under Organization settings → Connectors; members then connect it under Customize → Connectors.',
      source: 'https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp',
    },
    {
      id: 'claude-code',
      name: 'Claude Code',
      summary: 'Add the remote server from the terminal.',
      steps: [
        { text: 'Add the server.', code: `claude mcp add --transport http ${SERVER_NAME} ${endpoint}`, label: 'Terminal' },
        { text: 'Run /mcp in Claude Code, select gitflare and authenticate in the browser. From a shell, claude mcp login gitflare does the same.' },
      ],
      source: 'https://code.claude.com/docs/en/mcp',
    },
    {
      id: 'codex',
      name: 'Codex',
      summary: 'Add the server and sign in from the Codex CLI.',
      steps: [
        { text: 'Add the server and start the browser sign-in.', code: `codex mcp add ${SERVER_NAME} --url ${endpoint}\ncodex mcp login ${SERVER_NAME}`, label: 'Terminal' },
        { text: 'Or add it to ~/.codex/config.toml, then run codex mcp login gitflare.', code: `[mcp_servers.${SERVER_NAME}]\nurl = "${endpoint}"`, label: '~/.codex/config.toml' },
      ],
      source: 'https://learn.chatgpt.com/docs/extend/mcp?surface=cli',
    },
    {
      id: 'chatgpt',
      name: 'ChatGPT',
      summary: 'A custom MCP server added as a ChatGPT plugin.',
      steps: [
        { text: 'Open chatgpt.com/plugins, select the plus button, then Add custom MCP server.' },
        { text: 'Name it Gitflare, paste the server URL under Connection and choose OAuth authentication.', code: endpoint, label: 'Server URL' },
        { text: 'Acknowledge the warning, select Create as a plugin and approve the connection in the Gitflare window that opens.' },
      ],
      note: 'Your ChatGPT plan or workspace policy may not allow custom MCP servers.',
      source: 'https://developers.openai.com/apps-sdk/deploy/connect-chatgpt',
    },
    {
      id: 'cursor',
      name: 'Cursor',
      summary: 'One-click install link, or add the server to mcp.json.',
      link: { label: 'Add to Cursor', href: cursorInstallLink(endpoint) },
      steps: [
        { text: 'Use Add to Cursor, or add the server to ~/.cursor/mcp.json for every project, or .cursor/mcp.json for one project.', code: json({ mcpServers: { [SERVER_NAME]: { url: endpoint } } }), label: 'mcp.json' },
        { text: 'Cursor detects that Gitflare needs OAuth. Start the sign-in from Cursor’s MCP settings and approve the connection in the browser.' },
      ],
      source: 'https://cursor.com/docs/context/mcp',
    },
    {
      id: 'vscode',
      name: 'VS Code',
      summary: 'GitHub Copilot agent mode with a remote HTTP server.',
      link: { label: 'Install in VS Code', href: vscodeInstallLink(endpoint) },
      steps: [
        { text: 'Use Install in VS Code, or add the server to your user profile from the terminal.', code: `code --add-mcp '${JSON.stringify({ name: SERVER_NAME, type: 'http', url: endpoint })}'`, label: 'Terminal' },
        { text: 'Or add it to .vscode/mcp.json in a workspace.', code: json({ servers: { [SERVER_NAME]: { type: 'http', url: endpoint } } }), label: '.vscode/mcp.json' },
        { text: 'Start the server. VS Code registers itself with Gitflare and opens the browser so you can approve the connection. Then use the tools in Copilot agent mode.' },
      ],
      source: 'https://code.visualstudio.com/docs/copilot/customization/mcp-servers',
    },
    {
      id: 'opencode',
      name: 'OpenCode',
      summary: 'A remote server in opencode.json with automatic OAuth.',
      steps: [
        { text: 'Add the server to opencode.json in your project, or to ~/.config/opencode/opencode.json for every project.', code: json({ $schema: 'https://opencode.ai/config.json', mcp: { [SERVER_NAME]: { type: 'remote', url: endpoint, enabled: true } } }), label: 'opencode.json' },
        { text: 'Sign in. OpenCode opens the browser so you can approve the connection; it also starts sign-in by itself the first time Gitflare asks for it.', code: `opencode mcp auth ${SERVER_NAME}`, label: 'Terminal' },
        { text: 'Check the connection.', code: 'opencode mcp list', label: 'Terminal' },
      ],
      source: 'https://opencode.ai/docs/mcp-servers/',
    },
    {
      id: 'windsurf',
      name: 'Windsurf',
      summary: 'Windsurf, now Devin Desktop, reads a remote serverUrl.',
      steps: [
        { text: 'Add the server to ~/.config/devin/mcp_config.json (Windows: %APPDATA%\\devin\\mcp_config.json). Releases still named Windsurf read ~/.codeium/windsurf/mcp_config.json.', code: json({ mcpServers: { [SERVER_NAME]: { serverUrl: endpoint } } }), label: 'mcp_config.json' },
        { text: 'Refresh the MCP servers list in the app and approve the OAuth connection in the browser.' },
      ],
      source: 'https://docs.devin.ai/desktop/cascade/mcp',
    },
    {
      id: 'zed',
      name: 'Zed',
      summary: 'A remote context server in settings.json.',
      steps: [
        { text: 'Add the server to Zed’s settings.json. Leave out an Authorization header so Zed uses OAuth.', code: json({ context_servers: { [SERVER_NAME]: { url: endpoint } } }), label: 'settings.json' },
        { text: 'Zed asks you to authenticate with the standard MCP OAuth flow. Approve the connection in the browser.' },
      ],
      source: 'https://zed.dev/docs/ai/mcp',
    },
    {
      id: 'other',
      name: 'Any MCP client',
      summary: 'Any client that supports remote MCP over Streamable HTTP.',
      steps: [
        { text: 'Add a remote (Streamable HTTP) MCP server with this URL.', code: endpoint, label: 'Server URL' },
        { text: 'Let the client sign in with OAuth. Gitflare supports OAuth 2.1 with PKCE (S256), dynamic client registration and client ID metadata documents. Callbacks must use https or a loopback http address.' },
        { text: 'A client that only starts local (stdio) servers can use the mcp-remote bridge, which handles the OAuth sign-in.', code: `npx -y mcp-remote ${endpoint}`, label: 'Command' },
      ],
      note: 'Clients that cannot use OAuth can send Authorization: Bearer <token> with a personal MCP token from Settings. Those tokens expire after eight hours.',
      source: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization',
    },
  ];
}
