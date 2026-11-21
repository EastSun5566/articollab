import type { ElementId } from "articulated";

/** A persistent collection state that can describe visible changes to a later state. */
export interface ObservableState<S, E, K> {
  changesTo(other: S, targets?: Iterable<K>): E;
}

/** How a collection names the targets an operation may change: element IDs or Map keys. */
export interface ObserverTargets<K> {
  /** A string that is equal for equal targets. */
  key(target: K): string;
  /** A copy the caller cannot mutate later. */
  own(target: K): K;
}

/** List and Text track the element IDs their operations touch. */
export const elementTargets: ObserverTargets<Readonly<ElementId>> = {
  key: (id) => JSON.stringify([id.bunchId, id.counter]),
  own: (id) => Object.freeze({ bunchId: id.bunchId, counter: id.counter }),
};

interface Observer<S, E> {
  state: S;
  listener: (event: E) => void;
}

/**
 * Subscriber baselines plus the targets touched since the oldest pending baseline.
 * Shared by List, Text and Map so every collection keeps identical delivery semantics.
 */
export class CollectionObservers<
  S extends ObservableState<S, E, K>,
  E extends { readonly changes: readonly unknown[] },
  K,
> {
  private readonly current: () => S;
  private readonly beforeObserve: () => () => void;
  private readonly kind: ObserverTargets<K>;
  private readonly observers = new Set<Observer<S, E>>();
  private readonly targets = new Map<string, K>();
  private fullComparison = false;

  constructor(current: () => S, beforeObserve: () => () => void, kind: ObserverTargets<K>) {
    this.current = current;
    this.beforeObserve = beforeObserve;
    this.kind = kind;
  }

  observe(listener: (event: E) => void): () => void {
    const release = this.beforeObserve();
    let observer: Observer<S, E> | undefined = { state: this.current(), listener };
    this.observers.add(observer);
    return () => {
      if (observer === undefined) return;
      this.observers.delete(observer);
      observer = undefined;
      this.clear();
      release();
    };
  }

  /** Records targets whose visibility or value may differ from a pending baseline. */
  track(targets: Iterable<K>): void {
    if (this.observers.size === 0) return;
    if (!this.hasPending) { this.clear(); return; }
    if (this.fullComparison) return;
    for (const target of targets) this.targets.set(this.kind.key(target), this.kind.own(target));
  }

  requireFullComparison(): void {
    if (this.observers.size === 0) return;
    if (!this.hasPending) { this.clear(); return; }
    this.fullComparison = true;
    this.targets.clear();
  }

  get hasPending(): boolean {
    const current = this.current();
    for (const observer of this.observers) if (observer.state !== current) return true;
    return false;
  }

  flush(): void {
    try {
      for (const observer of [...this.observers]) {
        if (!this.observers.has(observer)) continue;
        const state = this.current();
        const event = observer.state.changesTo(state, this.fullComparison ? undefined : this.targets.values());
        observer.state = state;
        if (event.changes.length > 0) observer.listener(event);
      }
    } finally {
      this.clear();
    }
  }

  private clear(): void {
    if (this.hasPending) return;
    this.targets.clear();
    this.fullComparison = false;
  }
}
