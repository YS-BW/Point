/**
 * Scripted in-memory notification adapter. Test/sample only: it never reaches a real
 * channel and records every call so tests can assert exactly-once behavior.
 *
 * Scripts express the three-state outcome plus a hard throw:
 * - a single step applies to every call;
 * - an array is consumed in call order and throws `NOTIFICATION_SCRIPT_EXHAUSTED`
 *   once it runs out (an extra call is a bug, not a retry);
 * - a function receives the request and returns the step.
 */

import type {
  NotificationOutcome, NotificationPort, NotificationRequest,
} from '../../application/delivery.js';

export type NotificationScriptStep = NotificationOutcome | 'throw';

export type NotificationScript =
  | NotificationScriptStep
  | readonly NotificationScriptStep[]
  | ((request: NotificationRequest) => NotificationScriptStep | Promise<NotificationScriptStep>);

export type MemoryNotificationAdapter = Readonly<{
  port: NotificationPort;
  /** Every request in call order, including the ones that threw. */
  calls: NotificationRequest[];
}>;

export function memoryNotificationAdapter(script: NotificationScript = 'delivered'): MemoryNotificationAdapter {
  const calls: NotificationRequest[] = [];
  const steps = typeof script === 'object' ? [...script] : undefined;
  let cursor = 0;

  const port: NotificationPort = {
    async send(request) {
      const step = typeof script === 'function'
        ? await script(request)
        : steps === undefined
          ? script as NotificationScriptStep
          : steps[cursor++];
      // An exhausted script is a test bug, not a call: nothing is recorded for it.
      if (step === undefined) throw new Error('NOTIFICATION_SCRIPT_EXHAUSTED');
      calls.push({...request});
      if (step === 'throw') throw new Error('NOTIFICATION_SCRIPTED_THROW');
      return step;
    },
  };

  return {port, calls};
}
