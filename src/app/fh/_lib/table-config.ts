// Ideas table virtualisation settings (PERF-11, PERF-B06, D-08). A unit test checks the DOM bound.
export const ROW_HEIGHT = 36;
export const OVERSCAN = 12;
/** Rows in the DOM for a viewport of the given height: visible rows plus overscan on both sides. */
export const domRowsFor = (viewportPx: number) => Math.ceil(viewportPx / ROW_HEIGHT) + 1 + 2 * OVERSCAN;
