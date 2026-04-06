// ─── Postman Format v2.1 Types ─────────────────────────────────────────────

export interface PostmanAuth {
  type: 'noauth' | 'inherit' | 'bearer' | 'basic' | 'apikey' | 'oauth1' | 'oauth2' | 'digest' | 'hawk' | 'awsv4' | 'ntlm';
  bearer?: Array<{ key: string; value: string; type?: string }>;
  basic?: Array<{ key: string; value: string; type?: string }>;
  apikey?: Array<{ key: string; value: string; type?: string }>;
}

export interface PostmanHeader {
  key: string;
  value: string;
  description?: string;
  disabled?: boolean;
}

export interface PostmanQueryParam {
  key: string;
  value: string;
  description?: string;
  disabled?: boolean;
}

export interface PostmanUrl {
  raw: string;
  protocol?: string;
  host?: string[];
  port?: string;
  path?: string[];
  query?: PostmanQueryParam[];
  variable?: Array<{ key: string; value: string }>;
}

export interface PostmanBody {
  mode: 'raw' | 'urlencoded' | 'formdata' | 'file' | 'graphql' | 'none';
  raw?: string;
  urlencoded?: Array<{ key: string; value: string; description?: string; disabled?: boolean }>;
  formdata?: Array<{ key: string; value: string; type?: string; description?: string; disabled?: boolean }>;
  graphql?: { query: string; variables?: string };
  options?: {
    raw?: { language?: 'json' | 'javascript' | 'html' | 'xml' | 'text' };
  };
}

export interface PostmanEvent {
  listen: 'prerequest' | 'test';
  script: {
    id?: string;
    type: string;
    exec: string[] | string;
  };
}

export interface PostmanItem {
  id?: string;
  name: string;
  item?: PostmanItem[];
  request?: PostmanRequest;
  event?: PostmanEvent[];
  variable?: PostmanVariable[];
  auth?: PostmanAuth;
  description?: string;
}

export interface PostmanRequest {
  method: string;
  url: PostmanUrl | string;
  header?: PostmanHeader[];
  body?: PostmanBody;
  auth?: PostmanAuth;
  description?: string;
}

export interface PostmanVariable {
  key: string;
  value: string;
  type?: string;
  description?: string;
  disabled?: boolean;
}

export interface PostmanCollection {
  info: {
    _postman_id?: string;
    name: string;
    description?: string;
    schema: string;
  };
  item: PostmanItem[];
  event?: PostmanEvent[];
  variable?: PostmanVariable[];
  auth?: PostmanAuth;
}

export interface PostmanEnvironment {
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

export interface AppCollection extends PostmanCollection {
  _id: string;
}

export interface AppEnvironment extends PostmanEnvironment {
  _id: string;
}

export interface ScriptLog {
  level: 'log' | 'warn' | 'error' | 'info';
  args: string[];
}

export interface TestResult {
  name: string;
  passed: boolean;
  error: string | null;
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

export interface RunnerIteration {
  iteration: number;
  dataRow: Record<string, string>;
  results: RunnerIterationResult[];
  jumps?: Array<{ afterName: string; to: string }>;
}

export interface ActiveRequest {
  collectionId: string;
  item: PostmanItem;
}

export type AppView = 'request' | 'runner' | 'environments' | 'globals' | 'mock';

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
}

export interface MockRoute {
  id: string;
  enabled: boolean;
  collectionId?: string; // belongs to a MockCollection
  method: string; // GET POST PUT DELETE PATCH HEAD OPTIONS * (any)
  path: string;   // e.g. /api/users/:id
  statusCode: number;
  responseHeaders: Array<{ key: string; value: string }>;
  responseBody: string;
  delay: number;  // ms
  description: string;
}

export interface AppState {
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
}

export interface RequestTab {
  id: string;
  collectionId: string;
  item: PostmanItem;
  response: RequestResponse | null;
  isLoading: boolean;
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
  | { type: 'OPEN_TAB'; payload: { collectionId: string; item: PostmanItem } }
  | { type: 'CLOSE_TAB'; payload: string }
  | { type: 'SET_ACTIVE_TAB'; payload: string }
  | { type: 'SET_TAB_RESPONSE'; payload: { tabId: string; response: RequestResponse | null } }
  | { type: 'SET_TAB_LOADING'; payload: { tabId: string; loading: boolean } }
  | { type: 'UPDATE_TAB_ITEM'; payload: { tabId: string; item: PostmanItem } }
  | { type: 'UPDATE_TAB'; payload: { tabId: string; collectionId: string; item: PostmanItem } }
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
  | { type: 'SET_MOCK_PORT'; payload: number };
