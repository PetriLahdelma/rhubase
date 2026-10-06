// A deliberately case-specific source oracle. It does not run application code
// or establish browser behavior, accessibility, or complete type correctness.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadCompiler, parseProject, walk, jsxOrigin, attributes } from '../src/source-analysis.mjs';
import { demand, digest, snapshot } from '../src/files.mjs';

export function structural(ts, node, omit = new Set()) {
  if (omit.has(node)) return ['MIGRATION_SUBTREE'];
  if (ts.isJsxText(node)) return node.text.trim() ? [node.kind, node.text.trim()] : null;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return [node.kind, node.text];
  const children = [];
  ts.forEachChild(node, (child) => { const value = structural(ts, child, omit); if (value !== null) children.push(value); });
  return [node.kind, children];
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function all(ts, node, predicate) { const result = []; walk(ts, node, (n) => { if (predicate(n)) result.push(n); }); return result; }
function attr(ts, node, name) { return node.openingElement.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText() === name); }
function expression(ts, attribute) {
  let value = attribute?.initializer;
  if (value && ts.isJsxExpression(value)) value = value.expression;
  while (value && (ts.isParenthesizedExpression(value) || ts.isAsExpression(value))) value = value.expression;
  return value;
}
const prop = (ts, node, name) => attributes(ts, node.openingElement).find((p) => p.name === name);

export function evaluateContents(ts, before, after) {
  const baseline = parseProject(ts, before); const candidate = parseProject(ts, after);
  const checks = [];
  const check = (id, passed, detail) => checks.push({ id, status: passed ? 'passed' : 'needs-review', detail });
  check('syntax', candidate.diagnostics.length === 0, candidate.diagnostics);
  check('file-scope', same([...before.keys()].sort(), [...after.keys()].sort()), 'Only the registered three source files may exist');
  const origins = (project, file, module, exported) => all(ts, file, (n) => {
    if (!ts.isJsxElement(n)) return false;
    const origin = jsxOrigin(ts, project.checker, n.openingElement.tagName);
    return origin?.module === module && origin.exported === exported;
  });
  for (const [name, source] of before) {
    const oldFile = baseline.program.getSourceFile(name); const newFile = candidate.program.getSourceFile(name);
    if (!newFile) { check(name + ':present', false, 'Missing original source file'); continue; }
    const oldDropdowns = origins(baseline, oldFile, 'react-bootstrap', 'DropdownButton');
    check(name + ':license', source.split('*/')[0] === (after.get(name) ?? '').split('*/')[0], 'Preserve Apache license header');
    if (!oldDropdowns.length) {
      check(name + ':unchanged-context', same(structural(ts, oldFile), structural(ts, newFile)), 'Focus/listener wrapper unchanged under the contained-popup strategy');
      continue;
    }
    const newDropdowns = origins(candidate, newFile, 'src/common/components', 'Dropdown');
    check(name + ':target-origin', newDropdowns.length === 1, 'Target resolves to the documented barrel export');
    const bootstrap = all(ts, newFile, (n) => ts.isImportDeclaration(n) && n.moduleSpecifier.text === 'react-bootstrap');
    check(name + ':source-retired-in-file', bootstrap.length === 0, 'No Bootstrap import remains in this selected consumer');
    if (newDropdowns.length !== 1) continue;
    const oldDropdown = oldDropdowns[0]; const next = newDropdowns[0];
    const oldMenu = all(ts, oldDropdown, (n) => ts.isJsxElement(n) && n.openingElement.tagName.getText() === 'Menu')[0];
    const overlay = expression(ts, attr(ts, next, 'overlay'));
    const overlayOrigin = overlay && ts.isJsxElement(overlay) ? jsxOrigin(ts, candidate.checker, overlay.openingElement.tagName) : null;
    check(name + ':menu-preserved', !!overlay && overlayOrigin?.module === 'src/common/components' && overlayOrigin.exported === 'Menu'
      && same(structural(ts, oldMenu), structural(ts, overlay)), 'Menu structure, conditions, keys and callbacks retained inside overlay');
    const oldImports = new Set(oldFile.statements.filter(ts.isImportDeclaration));
    const newImports = new Set(newFile.statements.filter(ts.isImportDeclaration));
    oldImports.add(oldDropdown); newImports.add(next);
    // Import count can legitimately change. Compare statements excluding imports.
    const rest = (file, omit) => file.statements.filter((s) => !ts.isImportDeclaration(s)).map((s) => structural(ts, s, omit));
    check(name + ':unrelated-logic', same(rest(oldFile, oldImports), rest(newFile, newImports)), 'State, callbacks, data fetching and unrelated render behavior unchanged');
    const buttons = next.children.filter((n) => ts.isJsxElement(n) && n.openingElement.tagName.getText() === 'button');
    const button = buttons[0];
    check(name + ':native-trigger', buttons.length === 1 && prop(ts, button, 'type')?.value === 'button', 'Native trigger must not submit a surrounding form');
    if (button) {
      const title = expression(ts, attr(ts, oldDropdown, 'title'));
      let preserved = false;
      if (title && ts.isCallExpression(title)) preserved = all(ts, button, (n) => ts.isCallExpression(n)).some((n) => same(structural(ts, title), structural(ts, n)));
      if (title && ts.isJsxElement(title)) {
        const icons = all(ts, title, (n) => ts.isJsxSelfClosingElement(n) && n.tagName.getText() === 'i');
        const newIcons = all(ts, button, (n) => ts.isJsxSelfClosingElement(n) && n.tagName.getText() === 'i');
        preserved = icons.length > 0 && icons.every((icon) => newIcons.some((n) => same(structural(ts, icon), structural(ts, n)))) && !!prop(ts, button, 'aria-label')?.value;
      }
      check(name + ':trigger-content', preserved, 'Dynamic title retained; icon-only title needs a label');
      for (const key of ['id', 'data-test', 'className']) {
        const oldValue = prop(ts, oldDropdown, key);
        if (oldValue) check(name + ':preserve-' + key, [prop(ts, next, key), prop(ts, button, key)].some((p) => {
          if (key === 'className' && oldValue.kind === 'literal' && p?.kind === 'literal') {
            return String(oldValue.value).split(/\s+/).every((token) => String(p.value).split(/\s+/).includes(token));
          }
          return p?.value === oldValue.value;
        }), 'Existing trigger identity/hook/class must survive; additional class tokens are allowed');
      }
    }
    const trigger = expression(ts, attr(ts, next, 'trigger'));
    check(name + ':click-trigger', !!trigger && ts.isArrayLiteralExpression(trigger) && trigger.elements.length === 1 && trigger.elements[0].text === 'click', 'Pinned target API expects a click trigger array');
    const obsolete = ['bsSize', 'noCaret', 'title', 'pullRight', 'open', 'onToggle'].filter((key) => attr(ts, next, key));
    check(name + ':no-obsolete-props', obsolete.length === 0, obsolete);
    for (const [oldName, newName] of [['open', 'visible'], ['onToggle', 'onVisibleChange']]) {
      const oldValue = prop(ts, oldDropdown, oldName);
      if (oldValue) check(name + ':' + newName, prop(ts, next, newName)?.value === oldValue.value, 'Preserve original controlled binding');
    }
    if (attr(ts, oldDropdown, 'pullRight')) check(name + ':alignment', prop(ts, next, 'placement')?.value === 'bottomRight', 'Preserve requested right alignment');
    const popup = expression(ts, attr(ts, next, 'getPopupContainer'));
    const body = popup && ts.isArrowFunction(popup) ? popup.body : null;
    const returnExpression = body && ts.isBlock(body) ? body.statements.find(ts.isReturnStatement)?.expression : body;
    const parentAccess = returnExpression && ts.isPropertyAccessExpression(returnExpression)
      && ['parentNode', 'parentElement'].includes(returnExpression.name.text)
      && returnExpression.expression.getText() === popup.parameters[0]?.name.getText();
    if (name.includes('/dashboard/')) check(name + ':popup-containment', !!parentAccess, 'Dashboard focus wrapper requires contained popup; actual focus/clipping behavior still needs browser verification');
  }
  return {
    schemaVersion: 1, scope: 'case-specific source assertions', checks,
    passed: checks.filter((c) => c.status === 'passed').length,
    needsReview: checks.filter((c) => c.status !== 'passed').length,
    readiness: 'runtime-unverified',
    limitations: ['Static structural checks only; no full typecheck, browser, accessibility or upstream tests', 'Alternative correct implementations may need manual review rather than fit this structural oracle', 'Evaluator and task authored by same session; no independent maintainer acceptance'],
  };
}

export async function evaluateSourceCase(original, candidateRoot, compilerFile) {
  const { ts, identity } = await loadCompiler(compilerFile);
  const oldSnapshot = await snapshot(original); const newSnapshot = await snapshot(candidateRoot);
  const contents = async (root, record) => {
    const result = new Map();
    for (const file of Object.keys(record.files)) {
      demand(/\.[jt]sx?$/.test(file), 'Unexpected non-source file in source workspace');
      const text = await fs.readFile(path.join(root, file), 'utf8');
      demand(digest(text) === record.files[file].sha256, 'Source changed during evaluation');
      result.set(file, text);
    }
    return result;
  };
  const report = evaluateContents(ts, await contents(original, oldSnapshot), await contents(candidateRoot, newSnapshot));
  return { ...report, inputHash: oldSnapshot.digest, candidateHash: newSnapshot.digest, compiler: identity };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [, , original, candidateRoot] = process.argv;
    demand(original && candidateRoot, 'Usage: SHIFT_TYPESCRIPT_PATH=... node scripts/evaluate-source-case.mjs <original> <candidate>');
    const result = await evaluateSourceCase(original, candidateRoot, process.env.SHIFT_TYPESCRIPT_PATH);
    console.log(JSON.stringify(result, null, 2));
    if (result.needsReview) process.exitCode = 2;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
