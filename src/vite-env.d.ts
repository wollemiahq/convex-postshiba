/**
 * Minimal declaration of the one bundler global this package uses.
 *
 * `tsconfig.json` sets `types: []` as an isomorphism guard, so the ambient
 * `vite/client` types are deliberately not pulled in. `import.meta.glob` is
 * used only by the test helpers, which run under Vitest.
 */
interface ImportMeta {
  glob(pattern: string): Record<string, () => Promise<unknown>>;
}
