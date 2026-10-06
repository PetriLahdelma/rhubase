// Full-file unified patches intentionally reflect reviewed exact replacements.
// This is not a codemod or an inferred semantic transformation.
function lines(content, prefix) {
  const chunks = content.split('\n');
  const terminated = chunks.at(-1) === '';
  if (terminated) chunks.pop();
  const output = chunks.map((line) => prefix + line);
  if (!terminated) output.push('\\ No newline at end of file');
  return { count: chunks.length, output };
}

export function unifiedPatch(edits) {
  return edits.map((edit) => {
    const before = lines(edit.before, '-');
    const after = lines(edit.after, '+');
    return [
      `--- a/${edit.file}`, `+++ b/${edit.file}`,
      `@@ -1,${before.count} +1,${after.count} @@`,
      ...before.output, ...after.output, '',
    ].join('\n');
  }).join('');
}
