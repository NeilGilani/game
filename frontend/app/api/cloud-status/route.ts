import { probeCloud } from '../../cloud-probe';

export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json(await probeCloud(), { headers: { 'Cache-Control': 'no-store' } });
}
