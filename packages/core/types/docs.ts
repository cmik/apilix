// ─── API Documentation Export Types ──────────────────────────────────────────

export type DocsFormat = 'html' | 'markdown' | 'openapi';
export type DocsVariableMode = 'keep' | 'resolve';
export type DocsTheme = 'dark' | 'light' | 'auto';

export interface DocsExportOptions {
  /** Output format. Default 'html'. */
  format?: DocsFormat;
  /** Serialization for the openapi format. Default 'json'. */
  openapiFormat?: 'json' | 'yaml';
  /** OpenAPI document version. Default '3.0.3'. */
  openapiVersion?: '3.0.3' | '3.1.0';
  /** Restrict output to a folder (matched by id, or by name / "A/B" name path). */
  folder?: string;
  /** 'keep' leaves {{var}} verbatim (default); 'resolve' substitutes non-secret values from `variables`. */
  variableMode?: DocsVariableMode;
  /** Variables used when variableMode is 'resolve'. Callers must pass non-secret values only. */
  variables?: Record<string, string>;
  /** Variable names that must never be substituted (defence in depth). */
  secretVariableKeys?: string[];
  /** Snippet language ids to include (resolved through deps.snippetLanguages). */
  snippetLanguages?: string[];
  /** Render saved examples (item.response[]). Default true. */
  includeExamples?: boolean;
  /** Opt-in: keep literal credential values instead of redacting them. Default false. */
  includeCredentials?: boolean;
  /** HTML theme. Default 'dark'. */
  theme?: DocsTheme;
  /**
   * HTML only. Render images from descriptions (`<img>` and `![alt](url)`). Default true.
   * Privacy: with true, remote (http/https) images are fetched by the viewer when the
   * file is opened, which discloses the viewer's IP address and the open event to the image host.
   * With false the CSP is `img-src 'none'` and each image becomes a text link (alt text or URL).
   * Markdown and OpenAPI output are unaffected (images stay in the description text).
   */
  renderImages?: boolean;
  /** Override the document title. */
  title?: string;
  /**
   * Descriptions to fill where the collection has none, keyed by request id, folder id,
   * or `__collection__`. A description written by a human is never replaced.
   */
  descriptions?: Record<string, DocAiDescription>;
  /** Mark AI-filled descriptions in the output (badge / note / `x-generated-by`). Default true. */
  markAiContent?: boolean;
}

export interface DocAiDescription {
  description?: string;
  /** Per-parameter descriptions keyed by parameter / header / field name. */
  params?: Record<string, string>;
}

export interface DocKV {
  key: string;
  value: string;
  description?: string;
  /** 'ai' when `description` was filled from `options.descriptions`. */
  descriptionSource?: 'ai';
  /** Present for form-data file fields. */
  type?: string;
}

export interface DocExample {
  name: string;
  status?: string;
  code?: number;
  headers: DocKV[];
  body?: string;
  language?: string;
  originalRequest?: { method?: string; url?: string; body?: string };
}

export interface DocAuth {
  type: string;
  /** Where the effective auth was defined. */
  source: 'request' | 'folder' | 'collection';
  /** apikey: where the key is sent. */
  in?: 'header' | 'query';
  /** apikey: header/query parameter name. */
  name?: string;
  /** Redacted (or literal when includeCredentials) credential fields keyed by canonical name (token, username, password, value, clientId, clientSecret, accessToken). */
  fields?: DocKV[];
  /** oauth2 only (non-secret metadata). */
  oauth2?: { grantType: string; authorizationUrl?: string; tokenUrl?: string; scopes?: string[] };
}

export interface DocBody {
  mode: 'raw' | 'urlencoded' | 'formdata' | 'file' | 'graphql';
  language?: string;
  raw?: string;
  fields?: DocKV[];
  graphql?: { query: string; variables?: string };
}

export interface DocRequestModel {
  id: string;
  name: string;
  method: string;
  /** Full URL without query string (variables kept or resolved). */
  url: string;
  /** url plus the enabled query parameters, for snippet generation. */
  fullUrl: string;
  /** Base (protocol + host + port) of the URL. */
  baseUrl: string;
  /** Path starting with '/', containing ':param' and/or {{var}} segments. */
  path: string;
  folderPath: string[];
  description: string;
  descriptionSource?: 'ai';
  headers: DocKV[];
  query: DocKV[];
  pathVariables: DocKV[];
  body: DocBody | null;
  auth: DocAuth | null;
  examples: DocExample[];
}

export interface DocNode {
  type: 'folder' | 'request';
  id: string;
  name: string;
  description?: string;
  descriptionSource?: 'ai';
  children?: DocNode[];
  request?: DocRequestModel;
}

export interface DocModel {
  title: string;
  description: string;
  descriptionSource?: 'ai';
  auth: DocAuth | null;
  variables: DocKV[];
  tree: DocNode[];
  requests: DocRequestModel[];
  warnings: string[];
}

export interface DocSnippetLanguage {
  id: string;
  label: string;
  generate: (request: DocRequestModel) => string;
}

export interface DocsDeps {
  snippetLanguages?: DocSnippetLanguage[];
}

export interface DocsResult {
  format: DocsFormat;
  content: string;
  mimeType: string;
  extension: string;
  warnings: string[];
  /** OpenAPI only: the spec object (pre-serialization). */
  spec?: Record<string, unknown>;
}
