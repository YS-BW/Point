import { defineDoc } from '@earendil-works/pi-durable';

export const Meta = defineDoc({
  kind: 'point.server.meta', version: 1, scope: 'session',
  initial: () => ({ format: 1, engine: 'pi-durable@1.3.0', instanceId: '' }),
});
export function assertCompatible(meta: Readonly<{format: number; engine: string; instanceId: string}>): void {
  if (meta.format !== 1 || meta.engine !== 'pi-durable@1.3.0' || typeof meta.instanceId !== 'string' || !meta.instanceId.trim()) {
    throw new Error('UNSUPPORTED_DATA_FORMAT');
  }
}
