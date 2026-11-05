/**
 * Type-only stand-in for the `Bun` global, so Deno can still type-check the files that are not
 * ported yet when they import ported code. Deno never runs that ported code. Removed in slice 5.
 */
declare namespace Bun {
  // deno-lint-ignore no-explicit-any
  type CompressionFormat = any;
  const dns: {
    lookup(hostname: string, options?: object): Promise<{ address: string }[]>;
  };
}
