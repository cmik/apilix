/** Placeholder written in place of a redacted credential. */
export const REDACTED: '<redacted>';
export function isSensitiveName(name: string): boolean;
export function isSensitiveKey(name: string): boolean;
export function safeDecode(s: string): string;
export function isSensitiveHeader(name: string): boolean;
export function isVarRefOnly(value: string): boolean;
export function redactValue(value: unknown, includeCredentials?: boolean): string;
export function redactByName(name: string, value: unknown, includeCredentials?: boolean): string;
export function redactHeaderValue(name: string, value: unknown, includeCredentials?: boolean): string;
export function redactUrlUserinfo(url: string, includeCredentials?: boolean): string;
export function redactUrlQuery(url: string, includeCredentials?: boolean): string;
export function redactUrl(url: string, includeCredentials?: boolean): string;
export function redactUrlsInText(text: string, includeCredentials?: boolean): string;
export function redactBodyText(text: string, includeCredentials?: boolean): string;
