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
    typeof arg === "function" ? `(${arg})` : JSON.stringify(arg)
  );
  return `(${fn})(${serialized.join(", ")})`;
}

/**
 * In page: `fn`'s value, or `{ node: true }` when it is a DOM node, which
 * cannot leave the page by value. Chrome returns {} for most nodes and fails
 * on one with cyclic expandos, such as a React-rendered element.
 */
export async function returnByValueInPage<A extends unknown[]>(
  fn: (...args: A) => unknown,
  args: A
): Promise<{ node: true } | { value: unknown }> {
  const value = await fn(...args);
  return value instanceof Node ? { node: true } : { value };
}
