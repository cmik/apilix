/** Shapes exchanged with POST /api/ai/suggest-assertions and POST /api/ai/generate-request. */

export type AiSuggestionKind = 'status' | 'header' | 'body' | 'schema' | 'timing' | 'capture';

/** An assertion suggestion that already passed the server-side dry-run on the captured response. */
export interface AiAssertionSuggestion {
  id: string;
  title: string;
  kind: AiSuggestionKind;
  script: string;
  confidence: 'high' | 'medium' | 'low';
  volatile?: boolean;
}

export interface AiSuggestAssertionsResult {
  suggestions: AiAssertionSuggestion[];
  /** Why some suggestions were dropped (titles + reasons, capped). */
  discarded: Array<{ title: string; reason: string }>;
  discardedCount: number;
  truncated: boolean;
  /** Only the structure of the body was sent (`sendResponseBodies` is off). */
  shapeOnly: boolean;
}

export type RequestDraftBodyMode = 'none' | 'raw' | 'formdata' | 'urlencoded';

export interface RequestDraftPair { key: string; value?: string }

export interface RequestDraftBody {
  mode: RequestDraftBodyMode;
  raw?: string;
  language?: 'json' | 'text' | 'xml' | 'html' | 'javascript';
  formdata?: RequestDraftPair[];
  urlencoded?: RequestDraftPair[];
}

export interface RequestDraftAuth {
  type: 'noauth' | 'inherit' | 'bearer' | 'basic' | 'apikey';
  token?: string;
  username?: string;
  password?: string;
  key?: string;
  value?: string;
  in?: 'header' | 'query';
}

/** What the model proposes for one HTTP request. Never applied without an explicit user action. */
export interface RequestDraft {
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
  url: string;
  headers?: RequestDraftPair[];
  query?: RequestDraftPair[];
  body?: RequestDraftBody;
  auth?: RequestDraftAuth;
  tests?: string;
  preRequest?: string;
  variablesToCapture?: Array<{ name: string; path: string }>;
}

export interface AiGenerateRequestResult {
  draft: RequestDraft;
  /** `validated: false` = the scripts could not be validated in the sandbox (after one retry). */
  validation: { validated: boolean; errors: Array<{ field: 'tests' | 'preRequest'; reason: string }> };
  warnings: string[];
  retried: boolean;
}
