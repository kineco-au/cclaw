/**
 * Outstanding permission requests.
 *
 * ACP can have more than one `session/request_permission` in flight at once,
 * and each is a promise the agent is blocked on. A single-slot holder dropped
 * the earlier request's `resolve`, so that call was never answered, its turn
 * never ended, and anything driving turns in sequence — a goal loop most
 * visibly — stopped there. Every request has to be answered, so they queue.
 */

export interface QueuedPermission<C, A> {
  ctx: C;
  resolve: (answer: A | null) => void;
}

export class PermissionQueue<C, A> {
  private readonly items: QueuedPermission<C, A>[] = [];

  /** Add a request. Returns its 1-based position in the queue. */
  push(ctx: C, resolve: (answer: A | null) => void): number {
    this.items.push({ ctx, resolve });
    return this.items.length;
  }

  /** The request the user is being asked about. */
  get head(): C | undefined {
    return this.items[0]?.ctx;
  }

  get size(): number {
    return this.items.length;
  }

  get waiting(): boolean {
    return this.items.length > 0;
  }

  /**
   * Answer the head. Returns the next request to ask about, or undefined when
   * the queue is empty.
   */
  answerHead(answer: A | null): C | undefined {
    const item = this.items.shift();
    item?.resolve(answer);
    return this.head;
  }

  /**
   * Deny everything outstanding, for a cancelled turn. Returns how many were
   * denied: leaving any unresolved would hang the agent.
   */
  denyAll(): number {
    const count = this.items.length;
    for (const item of this.items.splice(0)) item.resolve(null);
    return count;
  }
}
