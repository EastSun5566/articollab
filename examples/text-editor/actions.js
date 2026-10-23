// @ts-check

/** One page-wide lock; no network loop is implemented here.
 * @param {readonly {sync: () => Promise<boolean>, rejectPending: () => Promise<boolean>,
 *   isComposing: () => boolean, setReadOnly: (value: boolean) => void,
 *   isBlocked: () => boolean}[]} panes
 */
export function createEditorActions(panes) {
  let busy = false, failed = false;
  /** @type {unknown} */
  let failure;
  /** @param {unknown} error */
  function stop(error) {
    if (!failed) { failed = true; failure = error; }
    for (const pane of panes) {
      try { pane.setReadOnly(true); }
      catch { /* Keep the original failure if updating a broken view fails too. */ }
    }
    return failure;
  }
  return {
    get busy() { return busy; },
    get failed() { return failed; },
    stop,
    /** @param {number} index @param {"sync" | "rejectPending"} method */
    async run(index, method) {
      if (failed) throw failure;
      if (busy) throw new Error("Another editor action is running");
      if (panes.some((pane) => pane.isComposing())) throw new Error("Finish text composition before synchronizing");
      const selected = panes[index];
      if (selected === undefined) throw new Error("Unknown editor");
      busy = true;
      let complete;
      try {
        for (const pane of panes) pane.setReadOnly(true);
        complete = await selected[method]();
      } catch (error) { throw stop(error); }
      finally { busy = false; }
      if (failed) throw failure;
      try { for (const pane of panes) pane.setReadOnly(pane.isBlocked()); }
      catch (error) { throw stop(error); }
      return complete;
    },
  };
}
