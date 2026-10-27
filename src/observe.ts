import type { ElementId } from "articulated";

/** A persistent collection state that can describe visible changes to a later state. */
export interface ObservableState<S, E> {
  changesTo(other: S, targets?: Iterable<Readonly<ElementId>>): E;
}

interface Observer<S, E> {
  state: S;
  listener: (event: E) => void;
}

function idKey(id: Readonly<ElementId>): string {
  return JSON.stringify([id.bunchId, id.counter]);
}

/**
 * Subscriber baselines plus the element IDs touched since the oldest pending baseline.
 * Shared by List and Text so both collections keep identical delivery semantics.
 */
export class CollectionObservers<S extends ObservableState<S, E>, E extends { readonly changes: readonly unknown[] }> {
  private readonly current: () => S;
  private readonly beforeObserve: () => () => void;
  private readonly observers = new Set<Observer<S, E>>();
  private readonly targets = new Map<string, Readonly<ElementId>>();
  private fullComparison = false;

  constructor(current: () => S, beforeObserve: () => () => void) {
    this.current = current;
    this.beforeObserve = beforeObserve;
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

  /** Records IDs whose visibility or value may differ from a pending baseline. */
  track(ids: Iterable<Readonly<ElementId>>): void {
    if (this.observers.size === 0) return;
    if (!this.hasPending) { this.clear(); return; }
    if (this.fullComparison) return;
    for (const id of ids) {
      this.targets.set(idKey(id), Object.freeze({ bunchId: id.bunchId, counter: id.counter }));
    }
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
