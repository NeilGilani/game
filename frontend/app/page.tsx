import Dashboard, { type Health, type Intent } from './dashboard';
import { defaultPrompt } from './demo-prompt';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const api = (process.env.SYNAPSE_API_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
  const [healthResult, intentResult] = await Promise.allSettled([
    kernelRequest<Health>(`${api}/health`),
    kernelRequest<Intent>(`${api}/intent`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: defaultPrompt }) }),
  ]);
  return <Dashboard
    kernelLocation="edge"
    initialHealth={healthResult.status === 'fulfilled' ? healthResult.value : null}
    initialIntent={intentResult.status === 'fulfilled' ? intentResult.value : null}
    initialHealthError={healthResult.status === 'rejected' ? 'Cannot reach the Python kernel. Retrying automatically in the browser.' : ''}
    initialIntentError={intentResult.status === 'rejected' ? 'Initial intent weights unavailable. Retrying in the browser.' : ''}
  />;
}

async function kernelRequest<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...options, cache: 'no-store', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Kernel HTTP ${response.status}`);
  return response.json() as Promise<T>;
}
