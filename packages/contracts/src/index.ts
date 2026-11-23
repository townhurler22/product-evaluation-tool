// Cross-module types (ARC-04). Types only: no runtime code, no dependencies.
// Adding fields is fine; removing or narrowing one needs a version bump in package.json.

export type Gone = { gone: true };
export type Unavailable = { available: false };
