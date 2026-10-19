/** Process state only. Product state belongs in persisted documents. */
export type Phase = 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed';
export type FoundationStatus = Readonly<{
  phase: Phase;
  capabilities: readonly ['foundation'];
}>;
