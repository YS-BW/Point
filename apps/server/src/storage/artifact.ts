import { defineDocFamily } from '@earendil-works/pi-durable';
import type { Artifact, ArtifactState } from '../domain/artifact.js';

/**
 * Durable artifact document (latest-only session family, keyed by artifactId).
 * JSON documents cannot carry `undefined`, so `sealedAt` is `null` until sealed;
 * the runtime layer converts to the domain type's optional field.
 */
export type ArtifactDocument = Readonly<{
  id: string;
  jobId: string;
  attemptId: string;
  revision: number;
  name: string;
  path: string;
  sha256: string;
  bytes: number;
  state: ArtifactState;
  createdAt: number;
  sealedAt: number | null;
}>;

export const Artifacts = defineDocFamily({
  kind: 'point.artifact', version: 1, scope: 'session', family: true,
  initial: (artifact: ArtifactDocument) => ({...artifact}),
});

/** Domain -> stored document. */
export function artifactDocument(artifact: Artifact): ArtifactDocument {
  return {...artifact, sealedAt: artifact.sealedAt ?? null};
}

/** Stored document -> domain value. */
export function artifactFromDocument(document: Readonly<ArtifactDocument>): Artifact {
  const {sealedAt, ...rest} = document;
  return sealedAt === null ? {...rest} : {...rest, sealedAt};
}
