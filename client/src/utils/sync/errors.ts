export interface SyncErrorPayload {
  error?: string;
  stderr?: string;
  code?: string;
  expectedVersion?: string | null;
  currentVersion?: string | null;
}

export class StaleVersionError extends Error {
  constructor(
    public context: string,
    public expectedVersion: string | null = null,
    public currentVersion: string | null = null,
    message = 'Remote changed since merge started',
  ) {
    super(message);
  }
}

export async function throwSyncRequestError(res: Response, context: string): Promise<never> {
  const payload = await readSyncErrorPayload(res);
  if (res.status === 409 && payload.code === 'STALE_VERSION') {
    throw new StaleVersionError(
      context,
      payload.expectedVersion ?? null,
      payload.currentVersion ?? null,
      payload.error ?? 'Remote changed since merge started',
    );
  }

  const message = payload.error ?? `${res.status} ${res.statusText}`;
  const detail = payload.stderr ? `\n${payload.stderr}` : '';
  throw new Error(`${context} failed (${res.status}): ${message}${detail}`);
}

async function readSyncErrorPayload(res: Response): Promise<SyncErrorPayload> {
  const contentType = res.headers.get('Content-Type') ?? '';
  if (contentType.includes('application/json')) {
    return res.json().catch(() => ({}));
  }

  const text = await res.text().catch(() => '');
  return text ? { error: text } : {};
}