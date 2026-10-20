/**
 * The connectors Orbis supports: what each one is, what it lets Orbis do,
 * which permissions it asks for, and what the site owner must set up before
 * it can be used. Client-safe (no secrets, no API code); the server side of
 * each connector is in ./providers and ./registry.ts.
 *
 * Every connector listed here has a working implementation against the
 * service's official API. Nothing is listed that Orbis can't do.
 */

export const CATEGORIES = [
  { id: "productivity", label: "Productivity" },
  { id: "communication", label: "Communication" },
  { id: "storage", label: "Storage" },
  { id: "development", label: "Development" },
  { id: "design", label: "Design" },
  { id: "sales", label: "Sales" },
  { id: "knowledge", label: "Knowledge" },
] as const;
export type CategoryId = (typeof CATEGORIES)[number]["id"];

/** How a connector signs in: OAuth 2.0, Orbis's GitHub App, or no account at all (public data). */
export type AuthKind = "oauth2" | "github_app" | "none";
export type Access = "read" | "write";

export interface Permission {
  /** The provider's scope string (or capability name where the provider has no scope strings). */
  scope: string;
  label: string;
  access: Access;
}

export interface ConnectorMeta {
  id: string;
  name: string;
  vendor: string;
  category: CategoryId;
  /** One line for the card. */
  tagline: string;
  description: string;
  featured?: boolean;
  auth: AuthKind;
  /** What Orbis can do with it, each marked read or write. */
  capabilities: { label: string; access: Access }[];
  /** Asked for when connecting. */
  readScopes: Permission[];
  /** Asked for only when the user also allows Orbis to create or send things. */
  writeScopes: Permission[];
  /** How connected data is used, in plain words. */
  dataUse: string;
  /** Words that suggest a request is about this service (for the AI's routing). */
  keywords: string[];
  /** What the site owner sets up before anyone can connect. */
  setup: {
    /** Environment variables the server needs (besides ORBIS_CONNECTOR_KEY for OAuth connectors). */
    env: string[];
    /** Where to create the OAuth app or API access. */
    console: { label: string; url: string };
    notes: string[];
  };
  /** Shares its OAuth app with other connectors of the same group (Google, Microsoft). */
  group?: "google" | "microsoft";
}

const LIVE = "Orbis reads from this service only when you ask something it's needed for, or when you search it here. Results are shown to you and passed to the AI model answering your request; nothing is copied into Orbis or kept after the answer. Orbis stores only the connection (encrypted) and the account name.";

const GOOGLE_SETUP = {
  env: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
  console: { label: "Google Cloud Console → APIs & Services → Credentials", url: "https://console.cloud.google.com/apis/credentials" },
};

const MICROSOFT_SETUP = {
  env: ["MICROSOFT_OAUTH_CLIENT_ID", "MICROSOFT_OAUTH_CLIENT_SECRET"],
  console: { label: "Microsoft Entra admin center → App registrations", url: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" },
};

export const CONNECTORS: ConnectorMeta[] = [
  {
    id: "google_drive",
    name: "Google Drive",
    vendor: "Google",
    category: "storage",
    tagline: "Search and read your Drive files and Google Docs.",
    description: "Find files in your Google Drive by name or content, and read Google Docs, Sheets (as CSV), Slides (as text) and text files so Orbis can summarize them or answer questions about them.",
    featured: true,
    auth: "oauth2",
    group: "google",
    capabilities: [
      { label: "Search files by name and content", access: "read" },
      { label: "Read Docs, Sheets, Slides and text files", access: "read" },
    ],
    readScopes: [{ scope: "https://www.googleapis.com/auth/drive.readonly", label: "See and download your Google Drive files", access: "read" }],
    writeScopes: [],
    dataUse: LIVE,
    keywords: ["drive", "google drive", "doc", "docs", "document", "file", "files", "sheet", "spreadsheet", "slides", "deck", "presentation", "folder", "pdf", "business plan", "proposal"],
    setup: {
      ...GOOGLE_SETUP,
      notes: [
        "Enable the Google Drive API for the project.",
        "Drive read access is a restricted scope: until Google verifies the app, only test users you add on the OAuth consent screen (up to 100) can connect.",
      ],
    },
  },
  {
    id: "gmail",
    name: "Gmail",
    vendor: "Google",
    category: "communication",
    tagline: "Search email, summarize threads and prepare drafts.",
    description: "Search your Gmail with the same search syntax as Gmail itself, read messages and threads so Orbis can summarize them, and, if you allow it, save reply drafts in Gmail for you to review and send yourself. Orbis never sends email.",
    featured: true,
    auth: "oauth2",
    group: "google",
    capabilities: [
      { label: "Search messages", access: "read" },
      { label: "Read and summarize threads", access: "read" },
      { label: "Save drafts (you send them from Gmail)", access: "write" },
    ],
    readScopes: [{ scope: "https://www.googleapis.com/auth/gmail.readonly", label: "Read your email messages and settings", access: "read" }],
    writeScopes: [{ scope: "https://www.googleapis.com/auth/gmail.compose", label: "Create drafts (Orbis never sends them)", access: "write" }],
    dataUse: LIVE,
    keywords: ["email", "emails", "e-mail", "mail", "gmail", "inbox", "thread", "message from", "reply", "replied", "sent me", "wrote to"],
    setup: {
      ...GOOGLE_SETUP,
      notes: [
        "Enable the Gmail API for the project.",
        "Gmail scopes are restricted: until Google verifies the app (including a security assessment), only test users you add can connect.",
      ],
    },
  },
  {
    id: "google_calendar",
    name: "Google Calendar",
    vendor: "Google",
    category: "productivity",
    tagline: "See events, check availability and add events.",
    description: "List and search events on your Google calendars, check when you're free, and, if you allow it, add events after you review them.",
    featured: true,
    auth: "oauth2",
    group: "google",
    capabilities: [
      { label: "List and search events", access: "read" },
      { label: "Check free and busy times", access: "read" },
      { label: "Add events after you confirm", access: "write" },
    ],
    readScopes: [{ scope: "https://www.googleapis.com/auth/calendar.readonly", label: "See your calendars and events", access: "read" }],
    writeScopes: [{ scope: "https://www.googleapis.com/auth/calendar.events", label: "Create and edit events on your calendars", access: "write" }],
    dataUse: LIVE,
    keywords: ["calendar", "meeting", "meetings", "event", "events", "schedule", "agenda", "free", "busy", "availability", "appointment", "tomorrow", "next week", "this week"],
    setup: { ...GOOGLE_SETUP, notes: ["Enable the Google Calendar API for the project.", "Calendar scopes are sensitive: Google shows an \"unverified app\" warning until the app is verified."] },
  },
  {
    id: "slack",
    name: "Slack",
    vendor: "Slack",
    category: "communication",
    tagline: "Search messages and catch up on discussions.",
    description: "Search messages in the Slack workspace you connect, so Orbis can summarize discussions and find decisions. If you allow it, Orbis can post a message as you after you review it.",
    featured: true,
    auth: "oauth2",
    capabilities: [
      { label: "Search messages you can see", access: "read" },
      { label: "Summarize discussions and decisions", access: "read" },
      { label: "Post a message as you, after you confirm", access: "write" },
    ],
    readScopes: [{ scope: "search:read", label: "Search messages and files you have access to", access: "read" }],
    writeScopes: [{ scope: "chat:write", label: "Send messages as you", access: "write" }],
    dataUse: LIVE,
    keywords: ["slack", "channel", "channels", "dm", "thread", "discussion", "discussed", "team said", "standup", "decided", "decision"],
    setup: {
      env: ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET"],
      console: { label: "Slack API → Your Apps", url: "https://api.slack.com/apps" },
      notes: ["Under OAuth & Permissions, add the user token scopes search:read and chat:write.", "Distribute the app (Manage Distribution) so people outside your own workspace can connect."],
    },
  },
  {
    id: "notion",
    name: "Notion",
    vendor: "Notion",
    category: "productivity",
    tagline: "Search and read your pages and notes.",
    description: "Search the Notion pages you share with Orbis and read them, so Orbis can answer questions from your notes and knowledge base. You choose which pages Orbis can see when you connect.",
    featured: true,
    auth: "oauth2",
    capabilities: [
      { label: "Search pages you share with Orbis", access: "read" },
      { label: "Read page content", access: "read" },
    ],
    readScopes: [{ scope: "read_content", label: "Read the pages you select when connecting", access: "read" }],
    writeScopes: [],
    dataUse: LIVE,
    keywords: ["notion", "notes", "note", "wiki", "knowledge base", "page", "pages", "meeting notes", "docs"],
    setup: {
      env: ["NOTION_OAUTH_CLIENT_ID", "NOTION_OAUTH_CLIENT_SECRET"],
      console: { label: "Notion Developer portal → Public connections", url: "https://www.notion.so/profile/integrations" },
      notes: ["Create a public connection with the capability \"Read content\" only.", "Notion asks each person which pages to share with Orbis when they connect."],
    },
  },
  {
    id: "github",
    name: "GitHub",
    vendor: "GitHub",
    category: "development",
    tagline: "Repositories, files, issues and pull requests.",
    description: "Read files from the repositories you choose and search their issues and pull requests, through Orbis's GitHub App. If you allow it, Orbis can open an issue after you review it.",
    featured: true,
    auth: "github_app",
    capabilities: [
      { label: "List the repositories you shared", access: "read" },
      { label: "Read files", access: "read" },
      { label: "Search issues and pull requests", access: "read" },
      { label: "Open an issue after you confirm", access: "write" },
    ],
    readScopes: [
      { scope: "contents:read", label: "Read files in the repositories you choose", access: "read" },
      { scope: "issues:read", label: "Read issues", access: "read" },
      { scope: "pull_requests:read", label: "Read pull requests", access: "read" },
    ],
    writeScopes: [{ scope: "issues:write", label: "Open issues", access: "write" }],
    dataUse: LIVE,
    keywords: ["github", "repo", "repository", "repositories", "issue", "issues", "pull request", "pr", "prs", "commit", "code", "branch", "bug"],
    setup: {
      env: ["GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_PRIVATE_KEY"],
      console: { label: "GitHub → Settings → Developer settings → GitHub Apps", url: "https://github.com/settings/apps" },
      notes: ["See docs/GITHUB.md. For issues and pull requests, give the app Issues: Read and Pull requests: Read (Issues: Read and write to open issues)."],
    },
  },
  {
    id: "onedrive",
    name: "Microsoft OneDrive",
    vendor: "Microsoft",
    category: "storage",
    tagline: "Search and read your OneDrive files.",
    description: "Search the files in your OneDrive and read text files (such as .txt, .md, .csv and .json), so Orbis can summarize them or answer questions about them. Word, Excel and PowerPoint files show up in searches but can't be read as text yet.",
    auth: "oauth2",
    group: "microsoft",
    capabilities: [
      { label: "Search files by name and content", access: "read" },
      { label: "Read text files (.txt, .md, .csv, .json…)", access: "read" },
    ],
    readScopes: [{ scope: "Files.Read", label: "Read your files", access: "read" }],
    writeScopes: [],
    dataUse: LIVE,
    keywords: ["onedrive", "one drive", "sharepoint", "word document", "excel", "powerpoint", "file", "files"],
    setup: { ...MICROSOFT_SETUP, notes: ["Supported account types: any organizational directory and personal Microsoft accounts.", "Add the delegated Microsoft Graph permissions Files.Read, User.Read and offline_access."] },
  },
  {
    id: "outlook",
    name: "Microsoft Outlook",
    vendor: "Microsoft",
    category: "communication",
    tagline: "Search mail and prepare drafts.",
    description: "Search your Outlook mail and read messages so Orbis can summarize correspondence. If you allow it, Orbis saves drafts in Outlook for you to review and send yourself. Orbis never sends email.",
    auth: "oauth2",
    group: "microsoft",
    capabilities: [
      { label: "Search messages", access: "read" },
      { label: "Read and summarize messages", access: "read" },
      { label: "Save drafts (you send them from Outlook)", access: "write" },
    ],
    readScopes: [{ scope: "Mail.Read", label: "Read your mail", access: "read" }],
    writeScopes: [{ scope: "Mail.ReadWrite", label: "Create drafts in your mailbox (Orbis never sends them)", access: "write" }],
    dataUse: LIVE,
    keywords: ["outlook", "email", "emails", "mail", "inbox", "office 365", "microsoft mail", "exchange"],
    setup: { ...MICROSOFT_SETUP, notes: ["Uses the same app registration as OneDrive.", "Add the delegated Microsoft Graph permissions Mail.Read and Mail.ReadWrite."] },
  },
  {
    id: "hubspot",
    name: "HubSpot",
    vendor: "HubSpot",
    category: "sales",
    tagline: "Look up contacts, companies and deals.",
    description: "Search your HubSpot CRM's contacts, companies and deals, so Orbis can answer questions about customers and your pipeline. Read-only.",
    auth: "oauth2",
    capabilities: [
      { label: "Search contacts", access: "read" },
      { label: "Search companies", access: "read" },
      { label: "Search deals", access: "read" },
    ],
    readScopes: [
      { scope: "crm.objects.contacts.read", label: "Read contacts", access: "read" },
      { scope: "crm.objects.companies.read", label: "Read companies", access: "read" },
      { scope: "crm.objects.deals.read", label: "Read deals", access: "read" },
    ],
    writeScopes: [],
    dataUse: LIVE,
    keywords: ["hubspot", "crm", "contact", "contacts", "customer", "customers", "lead", "leads", "company", "companies", "deal", "deals", "pipeline", "account owner"],
    setup: {
      env: ["HUBSPOT_CLIENT_ID", "HUBSPOT_CLIENT_SECRET"],
      console: { label: "HubSpot developer account → Apps", url: "https://developers.hubspot.com/" },
      notes: ["Add the scopes oauth, crm.objects.contacts.read, crm.objects.companies.read and crm.objects.deals.read."],
    },
  },
  {
    id: "figma",
    name: "Figma",
    vendor: "Figma",
    category: "design",
    tagline: "Read design files and their comments.",
    description: "Read the structure of a Figma file you link (pages, frames and text) and its comments, so Orbis can describe designs, list screens or summarize feedback. Read-only; Figma has no file search, so share a file link.",
    auth: "oauth2",
    capabilities: [
      { label: "Read a file's pages, frames and text", access: "read" },
      { label: "Read a file's comments", access: "read" },
    ],
    readScopes: [
      { scope: "current_user:read", label: "Read your name and email", access: "read" },
      { scope: "file_content:read", label: "Read the contents of files", access: "read" },
      { scope: "file_comments:read", label: "Read comments on files", access: "read" },
    ],
    writeScopes: [],
    dataUse: LIVE,
    keywords: ["figma", "design", "designs", "mockup", "mockups", "frame", "frames", "prototype", "figma.com"],
    setup: {
      env: ["FIGMA_CLIENT_ID", "FIGMA_CLIENT_SECRET"],
      console: { label: "Figma → Developers → My apps", url: "https://www.figma.com/developers/apps" },
      notes: ["Choose the scopes current_user:read, file_content:read and file_comments:read."],
    },
  },
  {
    id: "wikipedia",
    name: "Wikipedia",
    vendor: "Wikimedia Foundation",
    category: "knowledge",
    tagline: "Search and read Wikipedia articles. No account needed.",
    description: "Search English Wikipedia and read article text through the official Wikimedia API, so Orbis can ground answers in encyclopedia articles and link to them. Public data only: there's no account to connect.",
    auth: "none",
    capabilities: [
      { label: "Search articles", access: "read" },
      { label: "Read article text", access: "read" },
    ],
    readScopes: [],
    writeScopes: [],
    dataUse: "Orbis sends your search terms to Wikipedia's public API when a request needs it. No account is involved and nothing about you is shared.",
    keywords: ["wikipedia", "wiki", "encyclopedia", "who was", "who is", "what is", "history of", "biography", "definition of"],
    setup: { env: [], console: { label: "Wikimedia API", url: "https://www.mediawiki.org/wiki/API:Main_page" }, notes: ["Works without any setup."] },
  },
];

export const CONNECTOR_IDS = CONNECTORS.map((c) => c.id);
export function connectorMeta(id: string): ConnectorMeta | null {
  return CONNECTORS.find((c) => c.id === id) ?? null;
}

/** Connection states shown to users. "not_connected" and "connecting" are never stored. */
export type ConnectionStatus = "not_connected" | "connecting" | "connected" | "reauth_required" | "error" | "disconnected";

export const STATUS_LABEL: Record<ConnectionStatus, string> = {
  not_connected: "Not connected",
  connecting: "Connecting",
  connected: "Connected",
  reauth_required: "Reconnect needed",
  error: "Connection error",
  disconnected: "Disconnected",
};

/** How the AI may use a connection: whenever it helps, only when you name the service, or never. */
export const AI_MODES = [
  { id: "auto", label: "Automatically when it helps" },
  { id: "mention", label: "Only when I name it" },
  { id: "off", label: "Never (search it here only)" },
] as const;
export type AiMode = (typeof AI_MODES)[number]["id"];

/** A connection as the page sees it: no tokens, ever. */
export interface ConnectionView {
  connectorId: string;
  status: Exclude<ConnectionStatus, "not_connected" | "connecting">;
  accountLabel: string | null;
  scopes: string[];
  writeEnabled: boolean;
  aiMode: AiMode;
  lastError: string | null;
  connectedAt: string | null;
  lastCheckedAt: string | null;
  lastUsedAt: string | null;
}

/** A connector as the page sees it. */
export interface CatalogEntry extends ConnectorMeta {
  /** Whether the site owner has set it up (OAuth app credentials and the encryption key). */
  available: boolean;
  /** For administrators: what's missing. */
  missing?: string[];
  connection: ConnectionView | null;
}

/** A search result from a connected service. */
export interface ConnectorItem {
  connectorId: string;
  title: string;
  url: string | null;
  snippet: string;
  /** Extra detail: sender and date, file type, status… */
  meta?: string;
  /** How to read the whole item (for the AI's follow-up reads). */
  read?: { tool: string; args: Record<string, unknown> };
}

/** A write action the AI proposed in a reply, waiting for the user to review and confirm. */
export interface ProposedAction {
  id: string;
  action: string;
  connectorId: string;
  connectorName: string;
  args: Record<string, unknown>;
  description: string;
  fields: { key: string; label: string; multiline?: boolean }[];
  status: "proposed" | "done" | "failed" | "dismissed";
  result?: { summary: string; url?: string | null };
}
