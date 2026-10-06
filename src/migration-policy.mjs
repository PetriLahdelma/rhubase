// Tests, stories and build/check configuration are evidence inputs, never
// migration targets. extraFiles cannot override this boundary.
export function isProtectedSourceFile(file) {
  if (!/\.[cm]?[jt]sx?$/.test(file)) return true;
  const parts = file.split('/');
  if (parts.some((part) => part.startsWith('.') || /^(?:tests?|specs?|__tests__|__mocks__|e2e|cypress|playwright|storybook|assertions?|checks?|configs?|configuration)$/i.test(part))) return true;
  const name = parts.at(-1);
  return /\.(?:test|tests|spec|e2e|cy|integration|stories|story|bench|benchmark|config)\.[cm]?[jt]sx?$/i.test(name)
    || /^(?:vite|webpack|next|eslint|babel|jest|vitest|playwright|cypress|rollup|shift|tsconfig)(?:[.-].*)?\.[cm]?[jt]sx?$/i.test(name);
}
