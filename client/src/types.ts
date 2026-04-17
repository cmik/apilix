// ─── Postman Format v2.1 Types ─────────────────────────────────────────────
import type {
  OAuth2Config,
  OAuth2GrantType,
  OAuth2PresetProvider,
  OAuth2CustomHeader,
  OAuth2TokenResponse,
  OAuth2TokenRefreshResult,
  OAuth2PresetConfig,
} from './types/oauth';

// Re-export OAuth types
export type { OAuth2Config, OAuth2GrantType, OAuth2PresetProvider, OAuth2CustomHeader, OAuth2TokenResponse, OAuth2TokenRefreshResult, OAuth2PresetConfig };

export interface CollectionAuth {
  type: 'noauth' | 'inherit' | 'bearer' | 'basic' | 'apikey' | 'oauth1' | 'oauth2' | 'digest' | 'hawk' | 'awsv4' | 'ntlm';
  bearer?: Array<{ key: string; value: string; type?: string }>;
  basic?: Array<{ key: string; value: string; type?: string }>;
  apikey?: Array<{ key: string; value: string; type?: string }>;
  oauth2?: OAuth2Config;
}

export interface CollectionHeader {
  key: string;
  value: string;
  description?: string;
  disabled?: boolean;
}

export interface CollectionQueryParam {
  key: string;
  value: string;
  description?: string;
  disabled?: boolean;
}

export interface CollectionUrl {
  raw: string;
  protocol?: string;
  host?: string[];
  port?: string;
  path?: string[];
  query?: CollectionQueryParam[];
  variable?: Array<{ key: string; value: string }>;
}

export interface CollectionBody {
  mode: 'raw' | 'urlencoded' | 'formdata' | 'file' | 'graphql' | 'none';
  raw?: string;
  urlencoded?: Array<{ key: string; value: string; description?: string; disabled?: boolean }>;
  formdata?: Array<{ key: string; value: string; type?: string; description?: string; disabled?: boolean }>;
  graphql?: { query: string; variables?: string };
  soap?: { action: string; version: '1.1' | '1.2'; wsdlUrl?: string };
  options?: {
    raw?: { language?: 'json' | 'javascript' | 'html' | 'xml' | 'text' };
  };
}

export interface CollectionEvent {
  listen: 'prerequest' | 'test';
  script: {
    id?: string;
    type: string;
    exec: string[] | string;
  };
}

export interface CollectionItem {
  id?: string;
  name: string;
  item?: CollectionItem[];
  request?: CollectionRequest;
  event?: CollectionEvent[];
  variable?: CollectionVariable[];
  auth?: CollectionAuth;
  description?: string;
}

export interface CollectionRequest {
  method: string;
  url: CollectionUrl | string;
  header?: CollectionHeader[];
  body?: CollectionBody;
  auth?: CollectionAuth;
  description?: string;
}

export interface CollectionVariable {
  key: string;
  value: string;
  type?: string;
  description?: string;
  disabled?: boolean;
}

export interface BaseCollection {
  info: {
    _postman_id?: string;
    name: string;
    description?: string;
    schema: string;
  };
  item: CollectionItem[];
  event?: CollectionEvent[];
  variable?: CollectionVariable[];
  auth?: CollectionAuth;
}

export interface BaseEnvironment {
  id?: string;
  name: string;
  values: Array<{
    key: string;
    value: string;
    type?: string;
    enabled: boolean;
  }>;
}

// ─── App-level Types ──────────────────────────────────────────────────────────

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: string | null;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string;
  enabled: boolean;
}

export type CookieJar = Record<string, Cookie[]>;

export interface AppCollection extends BaseCollection {
  _id: string;
}

export interface AppEnvironment extends BaseEnvironment {
  _id: string;
}

export interface ScriptLog {
  level: 'log' | 'warn' | 'error' | 'info';
  args: string[];
}

export interface TestResult {
  name: string;
  passed: boolean | null;
  error: string | null;
  skipped?: boolean;
}

export interface RedirectHop {
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  responseTime: number;
}

export interface TlsCertInfo {
  subject: Record<string, string> | null;
  issuer: Record<string, string> | null;
  validFrom: string | null;
  validTo: string | null;
  fingerprint: string | null;
  fingerprint256: string | null;
  serialNumber: string | null;
  subjectAltNames: string | null;
  bits: number | null;
}

export interface NetworkTimings {
  dns: number;
  tcp: number;
  tls: number;
  server: number;
  total: number;
}

export interface RequestResponse {
  status: number;
  statusText: string;
  responseTime: number;
  resolvedUrl?: string;
  headers: Record<string, string>;
  body: string;
  size: number;
  testResults: TestResult[];
  scriptLogs?: ScriptLog[];
  networkTimings?: NetworkTimings | null;
  tlsCertChain?: TlsCertInfo[] | null;
  redirectChain?: RedirectHop[];
  error: string | null;
}

export interface RunnerIterationResult {
  name: string;
  method: string;
  url: string;
  resolvedUrl?: string;
  requestHeaders?: Record<string, string>;
  requestBody?: string;
  status: number;
  statusText: string;
  responseTime: number;
  headers?: Record<string, string>;
  body?: string;
  size?: number;
  testResults: TestResult[];
  scriptLogs?: ScriptLog[];
  preChildRequests?: Array<{ name: string; method: string; result: RequestResponse & { resolvedUrl?: string; requestHeaders?: Record<string, string>; requestBody?: string } }>;
  testChildRequests?: Array<{ name: string; method: string; result: RequestResponse & { resolvedUrl?: string; requestHeaders?: Record<string, string>; requestBody?: string } }>;
  error: string | null;
}

export interface ConditionalFlowRecord {
  afterName: string;
  via: 'name' | 'id';
  reason: 'stopped-by-script' | 'target-not-found';
  attemptedTarget?: string;
}

export interface RunnerIteration {
  iteration: number;
  dataRow: Record<string, string>;
  results: RunnerIterationResult[];
  jumps?: Array<{ afterName: string; to: string; via: 'name' | 'id'; targetId?: string }>;
  conditionalFlowRecords?: ConditionalFlowRecord[];
}

export interface ActiveRequest {
  collectionId: string;
  item: CollectionItem;
}

export interface HistoryRequest {
  id: string;
  timestamp: number;
  method: string;
  url: string;
  collectionId: string;
  itemId: string;
  requestSnapshot: CollectionItem;
  statusCode: number | null;
  statusText: string;
  responseTime: number;
  error: string | null;
}

export type AppView = 'request' | 'runner' | 'environments' | 'globals' | 'variables' | 'mock' | 'capture' | 'history';

// ─── Application Settings ─────────────────────────────────────────────────────────────

export interface AppSettings {
  // Appearance
  theme?: 'dark' | 'light' | 'system';
  // Requests
  requestTimeout?: number;
  followRedirects?: boolean;
  sslVerification?: boolean;
  // Proxy
  proxyEnabled?: boolean;
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
  // CORS
  corsAllowedOrigins?: string;
  // Layout
  requestLayout?: 'stacked' | 'split';
  [key: string]: unknown;
}

export interface CaptureCookieAttribute {
  key: string;
  value: string | null;
}

export interface CaptureCookie {
  name: string;
  value: string;
  raw: string;
  attributes?: CaptureCookieAttribute[];
  domain?: string;
  path?: string;
  expires?: string;
  maxAge?: string;
  sameSite?: string;
  secure?: boolean;
  httpOnly?: boolean;
  partitioned?: boolean;
}

export interface CaptureEntry {
  id: string;
  timestamp: number;
  method: string;
  url: string;
  domain?: string;
  resourceType?: string;
  requestHeaders: Record<string, string>;
  requestCookies?: CaptureCookie[];
  requestBody?: string | null;
  status?: number;
  statusText?: string;
  mimeType?: string;
  responseHeaders?: Record<string, string>;
  responseCookies?: CaptureCookie[];
  responseBody?: string | null;
  duration?: number;
  size?: number;
  state: 'pending' | 'complete' | 'failed';
  errorText?: string;
  selected: boolean;
}

export type CaptureSortKey = 'timestamp' | 'method' | 'domain' | 'url' | 'type' | 'status' | 'duration' | 'size';
export type CaptureSortDirection = 'asc' | 'desc';

export interface CaptureViewState {
  search: string;
  filterDomain: string;
  filterMethod: string;
  filterStatus: string;
  filterResourceType: string;
  sortKey: CaptureSortKey;
  sortDirection: CaptureSortDirection;
}

export interface MockCollection {
  id: string;
  name: string;
  enabled: boolean;
  description: string;
}

export interface MockLogEntry {
  id: string;
  timestamp: string;
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string;
  matchedRouteId: string | null;
  matchedRouteName: string | null;
  matchedRoutePath: string | null;
  responseStatus: number;
  responseBody: string;
  responseDropped?: boolean;
  wsEventType?: 'ws_connect' | 'ws_disconnect' | 'ws_message_in' | 'ws_message_out';
  wsClientId?: string;
  wsMessageType?: 'string' | 'json' | 'xml';
}

export interface WsOnConnectEvent {
  id: string;
  payload: string;
  delay?: number;
}

export interface WsMessageHandler {
  id: string;
  matchPattern: string;
  response: string;
}

export interface MockRouteRule {
  id: string;
  source: 'header' | 'query' | 'body' | 'param';
  field: string;
  operator: 'exists' | 'not-exists' | 'equals' | 'not-equals' | 'contains' | 'starts-with';
  value: string;
  statusCode: number;
  responseBody: string;
}

export interface MockRouteChaos {
  enabled: boolean;
  errorRate: number;    // 0–100 — % chance to inject a 500 error response
  dropRate: number;     // 0–100 — % chance to destroy the socket (no response)
  throttleKbps: number; // 0 = unlimited; >0 = max KB/s for the response body
}

export interface MockRoute {
  id: string;
  enabled: boolean;
  collectionId?: string; // belongs to a MockCollection
  type?: 'http' | 'websocket';
  method: string; // GET POST PUT DELETE PATCH HEAD OPTIONS * (any)
  path: string;   // e.g. /api/users/:id
  statusCode: number;
  responseHeaders: Array<{ key: string; value: string }>;
  responseBody: string;
  delay: number;  // ms
  description: string;
  rules?: MockRouteRule[];
  script?: string;
  chaos?: MockRouteChaos;
  wsOnConnect?: WsOnConnectEvent[];
  wsMessageHandlers?: WsMessageHandler[];
}

// ─── Workspace & Collaboration Types ─────────────────────────────────────────

export type WorkspaceRole = 'owner' | 'editor' | 'viewer';
export type WorkspaceType = 'local' | 'team';

export interface Workspace {
  id: string;
  name: string;
  description?: string;
  color?: string;
  createdAt: string;
  type: WorkspaceType;
  role?: WorkspaceRole;
}

export interface WorkspaceData {
  collections: AppCollection[];
  environments: AppEnvironment[];
  activeEnvironmentId: string | null;
  collectionVariables: Record<string, Record<string, string>>;
  globalVariables: Record<string, string>;
  cookieJar: CookieJar;
  mockCollections: MockCollection[];
  mockRoutes: MockRoute[];
  mockPort: number;
}

export type SyncProvider = 's3' | 'git' | 'http' | 'team' | 'minio';

export interface SyncMetadata {
  lastSyncedAt?: string;
  lastSyncedVersion?: string;
  lastMergeBaseSnapshotId?: string;
}

export interface SyncRemoteState {
  timestamp: string | null;
  version: string | null;
}

export interface SyncPullResult {
  data: WorkspaceData | null;
  remoteState: SyncRemoteState;
}

export interface SyncConfig {
  workspaceId: string;
  provider: SyncProvider;
  /** Provider-specific fields (encrypted when stored to disk) */
  config: Record<string, string>;
  metadata?: SyncMetadata;
  lastSynced?: string;
  /** When true, push operations are blocked — workspace syncs in pull-only mode */
  readOnly?: boolean;
}

export type SyncActivityLevel = 'info' | 'success' | 'warning' | 'error';

export interface SyncActivityEntry {
  id: string;
  timestamp: string;
  provider: SyncProvider;
  action:
    | 'push'
    | 'pull'
    | 'import'
    | 'conflict-detected'
    | 'merge-opened'
    | 'merge-applied'
    | 'merge-stale-rebase'
    | 'save-config';
  level: SyncActivityLevel;
  message: string;
  detail?: string;
}

// ─── Three-way merge types ────────────────────────────────────────────────────

export type ConflictDomain =
  | 'request'
  | 'collection'
  | 'environment'
  | 'globalVariables'
  | 'collectionVariables'
  | 'mockRoute';

export type ConflictKind =
  | 'field-overlap'
  | 'move-vs-edit'
  | 'delete-vs-edit'
  | 'rename-vs-rename'
  | 'json-conflict'
  | 'json-parse-fallback';

export interface MergeConflictNode {
  id: string;
  domain: ConflictDomain;
  kind: ConflictKind;
  label: string;
  /** Breadcrumb path within the collection tree (requests only) */
  path?: string[];
  /** JSON-serialised base value or null if the entity was absent */
  base: string | null;
  local: string;
  remote: string;
  /** User-chosen resolution; undefined = unresolved */
  resolved?: string;
}

export interface MergeResult {
  merged: WorkspaceData;
  conflicts: MergeConflictNode[];
  autoMergedCount: number;
}

/** Carries all three versions plus the computed merge result for the UI */
export interface ConflictPackage {
  baseData: WorkspaceData;
  localData: WorkspaceData;
  remoteData: WorkspaceData;
  mergeResult: MergeResult;
  /** Version tag to use for the optimistic push after resolution */
  remoteVersion: string | null;
  syncConfig: SyncConfig;
}

export interface HistoryEntry {
  snapshotId: string;
  timestamp: string;
  summary: string;
  collectionsCount: number;
}

export interface WorkspaceSnapshot {
  snapshotId: string;
  timestamp: string;
  summary: string;
  data: WorkspaceData;
}

export interface AppState {
  // ── Workspace ──────────────────────────────────────────────────────────────
  workspaces: Workspace[];
  activeWorkspaceId: string;
  storageReady: boolean;
  syncStatus: Record<string, 'idle' | 'syncing' | 'error'>;
  /** Incremented whenever sync config is saved — used to re-check sync icons */
  syncConfigVersion: number;
  // ── Data ──────────────────────────────────────────────────────────────────
  collections: AppCollection[];
  environments: AppEnvironment[];
  activeEnvironmentId: string | null;
  consoleLogs: ConsoleEntry[];
  tabs: RequestTab[];
  activeTabId: string | null;
  activeRequest: ActiveRequest | null;
  response: RequestResponse | null;
  isLoading: boolean;
  view: AppView;
  runnerResults: RunnerIteration[] | null;
  isRunning: boolean;
  collectionVariables: Record<string, Record<string, string>>;
  globalVariables: Record<string, string>;
  cookieJar: CookieJar;
  mockCollections: MockCollection[];
  mockRoutes: MockRoute[];
  mockServerRunning: boolean;
  mockPort: number;
  runnerPreselection: { collectionId: string; requestIds: string[] } | null;
  captureEntries: CaptureEntry[];
  captureRunning: boolean;
  captureViewState: CaptureViewState;
  captureGeneration: number;
  settings: AppSettings;
  requestHistory: HistoryRequest[];
}

export interface RequestTab {
  id: string;
  collectionId: string;
  item: CollectionItem;
  response: RequestResponse | null;
  isLoading: boolean;
  /** True when the tab was opened via OPEN_HISTORY_SNAPSHOT; cleared after a save. */
  fromHistory?: boolean;
}

export interface ConsoleEntry {
  id: string;
  timestamp: number;
  method: string;
  url: string;
  requestHeaders: Array<{ key: string; value: string }>;
  requestBody?: string;
  scriptLogs?: ScriptLog[];
  response: RequestResponse | null;
}

export type AppAction =
  | { type: 'ADD_COLLECTION'; payload: AppCollection }
  | { type: 'REMOVE_COLLECTION'; payload: string }
  | { type: 'CLEAR_WORKSPACE_COLLECTIONS' }
  | { type: 'ADD_ENVIRONMENT'; payload: AppEnvironment }
  | { type: 'REMOVE_ENVIRONMENT'; payload: string }
  | { type: 'UPDATE_ENVIRONMENT'; payload: AppEnvironment }
  | { type: 'SET_ACTIVE_ENV'; payload: string | null }
  | { type: 'SET_ACTIVE_REQUEST'; payload: ActiveRequest | null }
  | { type: 'SET_RESPONSE'; payload: RequestResponse | null }
  | { type: 'SET_LOADING'; payload: boolean }
  | { type: 'SET_VIEW'; payload: AppView }
  | { type: 'SET_RUNNER_RESULTS'; payload: RunnerIteration[] | null }
  | { type: 'SET_RUNNING'; payload: boolean }
  | { type: 'UPDATE_COLLECTION_VARS'; payload: { collectionId: string; vars: Record<string, string> } }
  | { type: 'UPDATE_GLOBAL_VARS'; payload: Record<string, string> }
  | { type: 'SET_GLOBAL_VARS'; payload: Record<string, string> }
  | { type: 'UPDATE_ACTIVE_ENV_VARS'; payload: Record<string, string> }
  | { type: 'UPDATE_COLLECTION'; payload: AppCollection }
  | { type: 'ADD_CONSOLE_LOG'; payload: ConsoleEntry }
  | { type: 'CLEAR_CONSOLE_LOGS' }
  | { type: 'OPEN_TAB'; payload: { collectionId: string; item: CollectionItem } }
  | { type: 'OPEN_HISTORY_SNAPSHOT'; payload: { collectionId: string; item: CollectionItem } }
  | { type: 'CLOSE_TAB'; payload: string }
  | { type: 'SET_ACTIVE_TAB'; payload: string }
  | { type: 'SET_TAB_RESPONSE'; payload: { tabId: string; response: RequestResponse | null } }
  | { type: 'SET_TAB_LOADING'; payload: { tabId: string; loading: boolean } }
  | { type: 'UPDATE_TAB_ITEM'; payload: { tabId: string; item: CollectionItem } }
  | { type: 'UPDATE_TAB'; payload: { tabId: string; collectionId: string; item: CollectionItem } }
  | { type: 'OPEN_BLANK_TAB' }
  | { type: 'REORDER_TABS'; payload: string[] }
  | { type: 'REORDER_COLLECTIONS'; payload: string[] }
  | { type: 'UPSERT_DOMAIN_COOKIES'; payload: { domain: string; cookies: Cookie[] } }
  | { type: 'DELETE_COOKIE'; payload: { domain: string; name: string } }
  | { type: 'CLEAR_DOMAIN_COOKIES'; payload: string }
  | { type: 'SET_COOKIE_JAR'; payload: CookieJar }
  | { type: 'ADD_MOCK_COLLECTION'; payload: MockCollection }
  | { type: 'UPDATE_MOCK_COLLECTION'; payload: MockCollection }
  | { type: 'DELETE_MOCK_COLLECTION'; payload: string }
  | { type: 'ADD_MOCK_ROUTE'; payload: MockRoute }
  | { type: 'UPDATE_MOCK_ROUTE'; payload: MockRoute }
  | { type: 'DELETE_MOCK_ROUTE'; payload: string }
  | { type: 'REORDER_MOCK_ROUTES'; payload: string[] }
  | { type: 'SET_MOCK_ROUTES'; payload: MockRoute[] }
  | { type: 'SET_MOCK_SERVER_RUNNING'; payload: boolean }
  | { type: 'SET_MOCK_PORT'; payload: number }
  | { type: 'SET_RUNNER_PRESELECTION'; payload: { collectionId: string; requestIds: string[] } | null }
  // ── Workspace actions ────────────────────────────────────────────────────
  | { type: 'HYDRATE_WORKSPACE'; payload: WorkspaceData & { workspaces: Workspace[]; activeWorkspaceId: string } }
  | { type: 'SET_STORAGE_READY'; payload: boolean }
  | { type: 'CREATE_WORKSPACE'; payload: Workspace }
  | { type: 'SWITCH_WORKSPACE'; payload: { workspace: Workspace; data: WorkspaceData } }
  | { type: 'RENAME_WORKSPACE'; payload: { id: string; name: string } }
  | { type: 'SET_WORKSPACE_COLOR'; payload: { id: string; color: string } }
  | { type: 'DELETE_WORKSPACE'; payload: { id: string; fallbackId: string } }
  | { type: 'DUPLICATE_WORKSPACE'; payload: { workspace: Workspace; data: WorkspaceData } }
  | { type: 'SET_SYNC_STATUS'; payload: { workspaceId: string; status: 'idle' | 'syncing' | 'error' } }
  | { type: 'BUMP_SYNC_CONFIG_VERSION' }
  | { type: 'RESTORE_SNAPSHOT'; payload: WorkspaceData }
  // ── CDP Capture actions ──────────────────────────────────────────────────
  | { type: 'CAPTURE_ADD_ENTRY'; payload: { entry: CaptureEntry; generation: number } }
  | { type: 'CAPTURE_UPDATE_ENTRY'; payload: { entry: Partial<CaptureEntry> & { id: string }; generation?: number } }
  | { type: 'CAPTURE_CLEAR' }
  | { type: 'SET_CAPTURE_RUNNING'; payload: boolean }
  | { type: 'SET_CAPTURE_VIEW_STATE'; payload: Partial<CaptureViewState> }
  // ── Settings actions ──────────────────────────────────────────────────────────────────
  | { type: 'SET_SETTINGS'; payload: AppSettings }
  | { type: 'UPDATE_SETTINGS'; payload: Partial<AppSettings> }
  // ── Request history actions ───────────────────────────────────────────────────────────
  | { type: 'ADD_REQUEST_HISTORY'; payload: HistoryRequest }
  | { type: 'CLEAR_REQUEST_HISTORY' }
  | { type: 'SET_REQUEST_HISTORY'; payload: HistoryRequest[] }
  | { type: 'CLEAR_TAB_HISTORY_FLAG'; payload: string };
