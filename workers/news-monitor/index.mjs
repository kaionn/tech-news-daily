import { DurableObject } from 'cloudflare:workers';
import { runTick, shouldTick } from './monitor.mjs';

export class NewsMonitor extends DurableObject {
  fetch(request) {
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        const { scheduledTime } = await request.json();
        const result = await runTick({ storage: this.ctx.storage, env: this.env, scheduledTime });
        return Response.json(result);
      } catch {
        // Never log fetch errors/credential values or fabricate a successful observation.
        console.error(JSON.stringify({ monitor_error: 'tick_failed_state_requires_inspection' }));
        return Response.json({ status: 'monitor_error' }, { status: 500 });
      }
    });
  }
}
export default {
  fetch() { return new Response('Not found', { status: 404 }); },
  async scheduled(controller, env) {
    if (!shouldTick(controller.scheduledTime)) return;
    const stub = env.MONITOR.get(env.MONITOR.idFromName('ai-trends-single-writer-v1'));
    const response = await stub.fetch('https://monitor.internal/tick', {
      method: 'POST', body: JSON.stringify({ scheduledTime: controller.scheduledTime }),
    });
    if (!response.ok) throw Error('monitor tick failed; inspect structured logs');
  },
};
