/**
 * Thread stream over derived commit frames (WP6).
 *
 * Four properties matter more than throughput:
 *
 * 1. **One subscription, one fan-out.** The commit projection is subscribed once per runtime; each
 *    connection is only a sink. Subscribing per connection would make every connection's drain loop
 *    re-broadcast the same frame, delivering N copies to N clients.
 * 2. **Reconnect is honest.** Cursors are frame-level (`<commitSeq>:<frameIndex>`), the retention ring
 *    is bounded, and an unknown or expired cursor yields an explicit resync — never a replayed fragment
 *    pretending to be continuous.
 * 3. **No frame sits outside a run.** AG-UI defines event semantics relative to run boundaries, so each
 *    connection opens a sync run (snapshot) and then keeps its own live run open. Replayed content
 *    frames are re-emitted inside that new live run, so a client can never see a dangling frame.
 * 4. **Runs are per connection.** Run boundaries belong to one connection and are never replayed.
 *
 * The ring is a discardable in-memory cache of what this process already emitted; authoritative state
 * is re-derived from Durable documents for every sync run.
 */

import { randomUUID } from 'node:crypto';
import { streamBudget, type StreamBudget } from './stream-budget.js';
import type { ConversationCommands } from '../application/conversation.js';
import type {
  BaselineMeta, CommitFrame, CommitSubscription, CommitStreamPort, ReadModelPort,
} from '../application/read-model.js';
import type {
  CursoredFrame, MessageRow, ResyncReason, ThreadFrameBody, ThreadStreamHandle, ThreadStreamPort,
} from '../application/thread-stream.js';

/** Retention: whichever bound is reached first. */
export const RETENTION_FRAMES = 4096;
export const RETENTION_MS = 5 * 60 * 1_000;
/** Per-process concurrent thread streams. */
export const MAX_CONCURRENT_STREAMS = 64;
/** Per-connection send buffer; exceeding it drops only that connection. */
const MAX_CONNECTION_BUFFER = 1024;
/** Bounded messages snapshot (same bound as the WP5 completion snapshot). */
const MAX_MESSAGES = 10_000;
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGE_PAGES = 1_000;

type RingEntry = Readonly<{
  /** Monotonic emission serial; stable across `trim()` shifting the array. Never an array index. */
  serial: number;
  cursor: string;
  seq: number;
  /** Set for per-connection frames (run boundaries); absent for frames every connection sees. */
  connection?: string;
  /** Set when the frame is scoped to one thread (messages snapshots). */
  threadId?: string;
  body: ThreadFrameBody;
  at: number;
}>;

type Connection = {
  id: string;
  threadId: string;
  queue: CursoredFrame[];
  wake: (() => void) | undefined;
  ended: boolean;
  overflow: boolean;
  deliver(frame: CursoredFrame): void;
  close(): void;
};

export type ThreadStreamDeps = Readonly<{
  readModel: ReadModelPort;
  commitStream: CommitStreamPort;
  conversation: ConversationCommands;
  now?: () => number;
  budget?: StreamBudget;
  /**
   * Retention overrides. Defaults are the frozen production bounds (4096 frames / 5 minutes); tests
   * inject a smaller window so the overflow path is exercised without thousands of real commits.
   */
  retentionFrames?: number;
  retentionMs?: number;
}>;

export class ThreadStreamError extends Error {
  constructor(readonly code: 'TOO_MANY_STREAMS' | 'CHAT_NOT_FOUND') {
    super(code);
    this.name = 'ThreadStreamError';
  }
}

/** Per-connection run boundaries are never replayed; content frames are. */
function isContent(body: ThreadFrameBody): boolean {
  return body.type !== 'run_started' && body.type !== 'run_finished';
}

export function threadStreamRuntime(deps: ThreadStreamDeps): ThreadStreamPort {
  const now = deps.now ?? Date.now;
  const ring: RingEntry[] = [];
  /** Highest frame index emitted per commit sequence, so cursors never repeat within a sequence. */
  const frameIndex = new Map<number, number>();
  const connections = new Map<string, Connection>();
  let serial = 0;
  const budget = deps.budget ?? streamBudget(MAX_CONCURRENT_STREAMS);
  const retentionFrames = deps.retentionFrames ?? RETENTION_FRAMES;
  const retentionMs = deps.retentionMs ?? RETENTION_MS;
  let subscription: CommitSubscription | undefined;
  let baselineReady = false;

  function trim(): void {
    const cutoff = now() - retentionMs;
    while (ring.length > 0 && (ring.length > retentionFrames || ring[0]!.at < cutoff)) ring.shift();
    // Keep per-sequence counters bounded without resetting a sequence that may still emit. Projection
    // for one commit is serialized, so only counters well behind the retained window are safe to drop.
    if (frameIndex.size > retentionFrames) {
      const oldestRetained = ring[0]?.seq ?? Number.POSITIVE_INFINITY;
      for (const seq of [...frameIndex.keys()]) {
        if (frameIndex.size <= retentionFrames) break;
        if (seq < oldestRetained) frameIndex.delete(seq);
      }
    }
  }

  function cursorFor(seq: number): string {
    const index = (frameIndex.get(seq) ?? -1) + 1;
    frameIndex.set(seq, index);
    return `${seq}:${index}`;
  }

  function record(seq: number, body: ThreadFrameBody, threadId: string | undefined,
    connection: string | undefined): CursoredFrame {
    const frame: CursoredFrame = {cursor: cursorFor(seq), seq, body};
    ring.push({
      serial: serial++, cursor: frame.cursor, seq, body, at: now(),
      ...(threadId === undefined ? {} : {threadId}),
      ...(connection === undefined ? {} : {connection}),
    });
    trim();
    return frame;
  }

  /** A frame every connection sees (state deltas, activity, job lifecycle). */
  function broadcast(seq: number, body: ThreadFrameBody): void {
    const frame = record(seq, body, undefined, undefined);
    for (const connection of connections.values()) connection.deliver(frame);
  }

  /** A frame only the connections of one thread see (messages snapshots). */
  function sendThread(threadId: string, seq: number, body: ThreadFrameBody): void {
    const frame = record(seq, body, threadId, undefined);
    for (const connection of connections.values()) {
      if (connection.threadId === threadId) connection.deliver(frame);
    }
  }

  /** A frame only one connection sees (run boundaries, its own resync marker). */
  function sendLocal(connection: Connection, seq: number, body: ThreadFrameBody): void {
    connection.deliver(record(seq, body, undefined, connection.id));
  }

  /** Bounded visible-text history; an incomplete page set is an error, never a partial snapshot. */
  async function messages(threadId: string): Promise<MessageRow[]> {
    const rows: MessageRow[] = [];
    let cursor: string | undefined;
    let pages = 0;
    let bytes = 0;
    do {
      const page = await deps.conversation.history(threadId, 100, cursor);
      for (const item of page.items) rows.push({id: item.id, role: item.role, content: item.text});
      bytes += Buffer.byteLength(JSON.stringify(page.items), 'utf8');
      if (++pages > MAX_MESSAGE_PAGES || bytes > MAX_MESSAGE_BYTES || rows.length > MAX_MESSAGES) {
        throw new Error('OBSERVATION_RESYNC_REQUIRED');
      }
      cursor = page.next;
    } while (cursor !== undefined);
    return rows;
  }

  /** Subscribe to commits once per runtime and fan out; a projection failure ends every connection. */
  function ensureConsumer(): CommitSubscription {
    if (subscription !== undefined) return subscription;
    const created = deps.commitStream.subscribe();
    subscription = created;
    void (async () => {
      try {
        for await (const frame of created.events) await handleCommitFrame(frame);
      } catch {
        // Derived view is unusable (overflow or projection failure). Close every connection so clients
        // resync explicitly rather than waiting for frames that will never arrive, and reset so the
        // next connection re-subscribes. Without the reset the consumer would stay dead and every
        // future stream would open a snapshot and then silently receive nothing.
        await created.cancel();
        subscription = undefined;
        ring.length = 0;
        baselineReady = false;
        for (const connection of [...connections.values()]) {
          connection.overflow = true;
          connection.close();
        }
      }
    })();
    return created;
  }

  async function handleCommitFrame(frame: CommitFrame): Promise<void> {
    if (frame.type === 'messages_changed') {
      try {
        sendThread(frame.threadId, frame.seq, {
          type: 'messages_snapshot', messages: await messages(frame.threadId),
        });
      } catch {
        // Only this thread's history overflowed: end its connections so they resync, and keep the
        // shared consumer alive for every other thread.
        for (const connection of [...connections.values()]) {
          if (connection.threadId !== frame.threadId) continue;
          connection.overflow = true;
          connection.close();
        }
      }
      return;
    }
    if (frame.type === 'state_snapshot') {
      const families = Object.keys(frame.view.truncated ?? {});
      broadcast(frame.seq, {
        type: 'state_snapshot', view: frame.view, reason: frame.reason,
        ...(families.length === 0 ? {} : {truncatedFamilies: families}),
      });
      return;
    }
    broadcast(frame.seq, frame as unknown as ThreadFrameBody);
  }

  return {
    async open(threadId: string, lastEventId?: string): Promise<ThreadStreamHandle> {
      if (!/^[1-9][0-9]*$/.test(threadId)) throw new ThreadStreamError('CHAT_NOT_FOUND');
      const release = budget.acquire();
      try {
      trim();

      // Resolve the replay position first, so a bad cursor cannot race live frames.
      let replayFrom: number | undefined;
      let resync: ResyncReason | undefined;
      if (lastEventId !== undefined && !/^[0-9]+:[0-9]+$/.test(lastEventId)) {
        // Non-numeric cursor: the client sent something we cannot interpret. Say so explicitly.
        resync = 'unknown_seq';
      } else if (lastEventId !== undefined) {
        const found = ring.find(entry => entry.cursor === lastEventId);
        if (found !== undefined) {
          replayFrom = found.serial + 1;
        } else if (ring.length === 0) {
          // This process has emitted nothing yet: it restarted, or nothing ever happened.
          resync = 'process_restarted';
        } else {
          const requestedSeq = Number(lastEventId.split(':')[0]);
          resync = Number.isFinite(requestedSeq) && requestedSeq < ring[0]!.seq
            ? 'window_exceeded' : 'unknown_seq';
        }
      }

      // Subscribe BEFORE reading the snapshot: the projection buffers frames from this instant, so a
      // commit landing while the snapshot is scanned is either already in the snapshot (keyed rows make
      // overlap idempotent) or still buffered (and then delivered). It cannot vanish in the gap.
      const stream = ensureConsumer();
      // Everything arriving from here on is buffered in the ring. Frames that land while the snapshot
      // is read are captured by replaying from this mark after the preface, so a fresh (or resyncing)
      // connection cannot lose a commit that happened in the gap.
      const ringMark = serial;
      const view = await deps.readModel.state();
      const history = await messages(threadId);
      if (!baselineReady) {
        const baseline: BaselineMeta = {
          ...(Object.keys(view.truncated ?? {}).length === 0
            ? {} : {truncatedFamilies: Object.keys(view.truncated ?? {})}),
          counts: Object.fromEntries((['chats', 'jobs', 'resources', 'memory'] as const)
            .map(family => [family, Object.keys(view[family] as Record<string, unknown>).length])),
        };
        stream.setBaseline(baseline);
        baselineReady = true;
      }

      trim();
      const requiredSerial = replayFrom ?? ringMark;
      if (subscription !== stream || (serial > requiredSerial && (ring[0]?.serial ?? serial) > requiredSerial)) {
        throw new Error('OBSERVATION_RESYNC_REQUIRED');
      }
      // Only a snapshot we actually sent can be rolled back by older frames. An in-window replay sends
      // no snapshot, so its floor is -1 and every replayed frame (including the rest of a commit the
      // client was cut in the middle of) is delivered.
      let revertFloor = -1;
      const connection: Connection = {
        id: randomUUID(),
        threadId,
        queue: [],
        wake: undefined,
        ended: false,
        overflow: false,
        deliver(frame) {
          if (connection.ended) return;
          // A snapshot may include commits whose projection is still draining; frames strictly older
          // than that snapshot would roll the view back. Frames of the same seq are idempotent.
          if (frame.body.type === 'state_delta' && frame.seq < revertFloor) return;
          if (frame.body.type === 'state_snapshot') {
            if (frame.body.view.seq < revertFloor) return;
            revertFloor = frame.body.view.seq;
          }
          if (frame.body.type === 'activity_snapshot' && frame.seq < revertFloor) return;
          if (connection.queue.length >= MAX_CONNECTION_BUFFER) {
            connection.overflow = true;
            connection.ended = true;
            connection.queue.length = 0;
            const resume = connection.wake;
            connection.wake = undefined;
            resume?.();
            return;
          }
          connection.queue.push(frame);
          const resume = connection.wake;
          connection.wake = undefined;
          resume?.();
        },
        close() {
          connection.ended = true;
          connection.queue.length = 0;
          const resume = connection.wake;
          connection.wake = undefined;
          resume?.();
        },
      };
      connections.set(connection.id, connection);


      // The frozen binding contract distinguishes two reconnect cases:
      // - fresh connection or resync: open a sync run carrying the authoritative snapshot;
      // - in-window replay: send NO new snapshot, only the live run plus the frames after the cursor.
      // Emitting a snapshot here would contradict the contract and would also advance the rollback
      // floor past the remaining frames of the commit the client was cut in the middle of.
      const replayOnly = resync === undefined && replayFrom !== undefined;
      if (!replayOnly) {
        const syncRunId = `sync-${view.seq}`;
        sendLocal(connection, view.seq, {type: 'run_started', runId: syncRunId, sync: true, threadId});
        const truncated = Object.keys(view.truncated ?? {}) as Array<
          'chats' | 'jobs' | 'resources' | 'memory' | 'events'>;
        sendLocal(connection, view.seq, {
          type: 'state_snapshot', view,
          ...(truncated.length === 0 ? {} : {truncatedFamilies: truncated}),
        });
        sendLocal(connection, view.seq, {type: 'messages_snapshot', messages: history});
        sendLocal(connection, view.seq, {type: 'run_finished', runId: syncRunId, outcome: 'success', threadId});
      }
      const liveRunId = `live-${randomUUID()}`;
      sendLocal(connection, view.seq, {type: 'run_started', runId: liveRunId, sync: false, threadId});

      if (resync !== undefined) {
        sendLocal(connection, view.seq, {
          type: 'custom', name: 'point.stream.resync',
          value: {reason: resync, requestedId: lastEventId ?? '', currentSeq: view.seq},
        });
        replay(connection, ringMark);
      } else if (replayFrom !== undefined) {
        // Replay content frames only. They are re-emitted inside the new live run, so the client always
        // holds a run boundary for them; per-connection boundaries are never replayed.
        replay(connection, replayFrom);
      } else {
        // Fresh or resyncing connection: replay what landed while the snapshot was being read. Those
        // frames are not in the snapshot, so they would otherwise be lost forever.
        replay(connection, ringMark, ringMark);
      }

      const finish = (): void => {
        if (!connections.delete(connection.id)) return;
        release();
      };

      /**
       * `skipMessagesBeforeSerial` is set only for connections that already received a fresh
       * MESSAGES_SNAPSHOT in their preface: replaying an older history snapshot would regress their
       * view. An in-window replay connection gets no preface snapshot, so it must receive every
       * messages snapshot after its cursor.
       */
      function replay(target: Connection, fromSerial: number, skipMessagesBeforeSerial?: number): void {
        for (const entry of ring) {
          if (entry.serial < fromSerial) continue;
          if (!isContent(entry.body)) continue;
          if (skipMessagesBeforeSerial !== undefined
            && entry.body.type === 'messages_snapshot' && entry.serial < skipMessagesBeforeSerial) continue;
          if (entry.connection !== undefined) continue;
          if (entry.threadId !== undefined && entry.threadId !== threadId) continue;
          target.deliver({cursor: entry.cursor, seq: entry.seq, body: entry.body});
        }
      }

      return {
        frames: {
          async *[Symbol.asyncIterator](): AsyncGenerator<CursoredFrame> {
            try {
              while (true) {
                while (connection.queue.length > 0) yield connection.queue.shift()!;
                if (connection.overflow) throw new Error('OBSERVATION_RESYNC_REQUIRED');
                if (connection.ended) return;
                await new Promise<void>(resolve => { connection.wake = resolve; });
              }
            } finally {
              connection.close();
              finish();
            }
          },
        },
        async close(): Promise<void> {
          connection.close();
          finish();
        },
      };
      } catch (error) { release(); throw error; }
    },
  };
}

/** Exported for the edge and tests. */
export type ThreadStreamFrame = CursoredFrame;
export type { CommitFrame };
