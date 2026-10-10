import { probeCloud } from '../../cloud-probe';
import type { ExecutionTelemetry } from '../../cloud-telemetry';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const cloud = process.env.SYNAPSE_CLOUD_API_URL;
  // The laptop controller owns intent routing and dispatches cloud inference.
  const api = (process.env.SYNAPSE_API_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
  try {
    const body = await request.text();
    const sample = cloud ? await probeCloud() : null;
    const upstream = await fetch(`${api}/compare`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
      cache: 'no-store', signal: AbortSignal.any([request.signal, AbortSignal.timeout(300000)]), redirect: 'error',
    });
    if (!upstream.ok || !upstream.body) return Response.json({ detail: `Comparison backend returned HTTP ${upstream.status}` }, { status: upstream.ok ? 502 : upstream.status });
    const execution: ExecutionTelemetry = { location: 'edge' };
    const reader = upstream.body.getReader();
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(JSON.stringify({ event: 'cloud_probe', health_rtt_ms: sample?.health_rtt_ms ?? null }) + '\n'));
        // Subsequent controller events identify where inference actually runs.
        controller.enqueue(encoder.encode(JSON.stringify({ event: 'execution', execution }) + '\n'));
      },
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) { reader.releaseLock(); controller.close(); }
          else controller.enqueue(value);
        } catch (error) { controller.error(error); }
      },
      async cancel(reason) { await reader.cancel(reason); },
    });
    return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } });
  } catch {
    return Response.json({ detail: 'Comparison backend unavailable or request interrupted' }, { status: 502 });
  }
}
