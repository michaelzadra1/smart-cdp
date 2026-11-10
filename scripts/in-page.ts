// In-page programs are typed functions that ship to Chrome's renderer as
// Function.prototype.toString() output, so each takes every dependency as a
// parameter. source-rules.test.ts proves each one is self-contained.

/**
 * The CDP wire form of calling `fn` in the page: each function serialized with
 * toString(), every other argument as JSON. The arguments are type-checked
 * against `fn`'s parameters.
 */
export function inPageCall<A extends unknown[]>(
  fn: (...args: A) => unknown,
  ...args: A
): string {
  const serialized = args.map((arg) =>
    typeof arg === "function"
      ? `(${arg})`
      : (JSON.stringify(arg) ?? "undefined")
  );
  return `(${fn})(${serialized.join(", ")})`;
}

/**
 * In page: `fn`'s value, or `mark` when it is a DOM node, which cannot leave
 * the page by value. Chrome returns {} for most nodes and fails on one with
 * cyclic expandos, such as a React-rendered element.
 */
export async function returnByValueInPage(
  fn: (...args: unknown[]) => unknown,
  args: unknown[],
  mark: string
) {
  const value = await fn(...args);
  return value instanceof Node ? mark : value;
}
