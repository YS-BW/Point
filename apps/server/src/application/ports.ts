import type { FoundationStatus } from '../domain/lifecycle.js';

/** Minimal lifecycle contract, deliberately independent of transport and runtime SDK. */
export interface RuntimeHandle {
  readonly instanceId: string;
  /** Resolves (never rejects) when the runtime has ended, including failure. */
  readonly closed: Promise<void>;
  close(): Promise<void>;
}
export interface HealthReader {
  status(): FoundationStatus;
}
