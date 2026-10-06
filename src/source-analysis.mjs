import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { demand, digest, jsonDigest, snapshot } from './files.mjs';

// Compiler is an explicit trusted operator tool, never resolved from consumer code.
// No packages are installed, tsconfig plugins loaded, or consumer modules executed.
export async function loadCompiler(file) {
  demand(file, 'Pass --compiler or SHIFT_TYPESCRIPT_PATH pointing to an existing trusted TypeScript compiler');
  const absolute = await fs.realpath(file);
  const bytes = await fs.readFile(absolute);
  const ts = createRequire(import.meta.url)(absolute);
  demand(/^5\.9\./.test(ts.version) && typeof ts.createProgram === 'function', 'This experimental adapter supports TypeScript 5.9.x only');
  return { ts, identity: { version: ts.version, sha256: digest(bytes) } };
}

export function validateSourceRules(rules) {
  demand(rules.schemaVersion === 1 && Array.isArray(rules.sources) && rules.sources.length, 'Invalid source rules');
  const seen = new Set();
  for (const source of rules.sources) {
    demand(typeof source.module === 'string' && source.module && Array.isArray(source.exports) && source.exports.length, 'Source module/exports required');
    demand(source.exports.every((name) => typeof name === 'string' && /^[A-Za-z_$][\w$]*$/.test(name)), 'Invalid source export');
    for (const name of source.exports) {
      const key = source.module + '#' + name;
      demand(!seen.has(key), 'Duplicate source export rule'); seen.add(key);
    }
  }
  return rules;
}

export function parseProject(ts, contents) {
  const names = [...contents.keys()];
  const options = {
    allowJs: true, checkJs: false, jsx: ts.JsxEmit.Preserve,
    target: ts.ScriptTarget.Latest, noEmit: true, noResolve: true, noLib: true, types: [],
  };
  const host = {
    getSourceFile: (file, languageVersion) => contents.has(file)
      ? ts.createSourceFile(file, contents.get(file), languageVersion, true,
        file.endsWith('.tsx') ? ts.ScriptKind.TSX : file.endsWith('.jsx') ? ts.ScriptKind.JSX : /\.[cm]?ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS)
      : undefined,
    getDefaultLibFileName: () => '', writeFile: () => {},
    getCurrentDirectory: () => '/', getDirectories: () => [], directoryExists: () => false,
    fileExists: (file) => contents.has(file), readFile: (file) => contents.get(file),
    getCanonicalFileName: (file) => file, useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  };
  const program = ts.createProgram(names, options, host);
  const diagnostics = program.getSyntacticDiagnostics().map((d) => ({
    file: d.file?.fileName, start: d.start, message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
  }));
  return { program, checker: program.getTypeChecker(), diagnostics };
}

export function walk(ts, node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => { walk(ts, child, visit); });
}

function importIdentity(ts, declaration) {
  if (ts.isImportSpecifier(declaration)) {
    const clause = declaration.parent.parent;
    if (declaration.isTypeOnly || clause.isTypeOnly) return null;
    return { module: clause.parent.moduleSpecifier.text, exported: declaration.propertyName?.text ?? declaration.name.text, binding: declaration.name };
  }
  if (ts.isImportClause(declaration) && declaration.name && !declaration.isTypeOnly) {
    return { module: declaration.parent.moduleSpecifier.text, exported: 'default', binding: declaration.name };
  }
  if (ts.isNamespaceImport(declaration) && !declaration.parent.isTypeOnly) {
    return { module: declaration.parent.parent.moduleSpecifier.text, exported: '*', binding: declaration.name };
  }
  return null;
}

export function jsxOrigin(ts, checker, tag) {
  let identifier = tag;
  let member = null;
  if (ts.isPropertyAccessExpression(tag) && ts.isIdentifier(tag.expression)) {
    identifier = tag.expression; member = tag.name.text;
  }
  if (!ts.isIdentifier(identifier)) return null;
  const symbol = checker.getSymbolAtLocation(identifier);
  const imports = (symbol?.declarations ?? []).map((d) => importIdentity(ts, d)).filter(Boolean);
  if (imports.length !== 1 || symbol.declarations.length !== 1) return null;
  const origin = imports[0];
  if (member && origin.exported !== '*') return null;
  if (!member && origin.exported === '*') return null;
  return { module: origin.module, exported: member ?? origin.exported, localName: tag.getText() };
}

export function attributes(ts, opening) {
  return opening.attributes.properties.map((attribute) => {
    if (ts.isJsxSpreadAttribute(attribute)) return { name: '...', kind: 'spread', value: attribute.expression.getText() };
    const name = attribute.name.getText();
    const value = attribute.initializer;
    if (!value) return { name, kind: 'literal', value: true };
    if (ts.isStringLiteral(value)) return { name, kind: 'literal', value: value.text };
    const expression = ts.isJsxExpression(value) ? value.expression : null;
    if (expression && (ts.isStringLiteral(expression) || ts.isNumericLiteral(expression))) return { name, kind: 'literal', value: expression.text };
    if (expression?.kind === ts.SyntaxKind.TrueKeyword || expression?.kind === ts.SyntaxKind.FalseKeyword) return { name, kind: 'literal', value: expression.kind === ts.SyntaxKind.TrueKeyword };
    return { name, kind: 'expression', value: expression?.getText() ?? value.getText() };
  });
}

export function inspectContents(ts, contents, rules) {
  validateSourceRules(rules);
  const { program, checker, diagnostics } = parseProject(ts, contents);
  const usages = []; const unsupported = [];
  const matches = (origin) => rules.sources.some((s) => s.module === origin?.module && s.exports.includes(origin?.exported));
  for (const file of program.getSourceFiles()) {
    if (!contents.has(file.fileName)) continue;
    const location = (node) => {
      const start = node.getStart(file); const position = file.getLineAndCharacterOfPosition(start);
      return { file: file.fileName, line: position.line + 1, column: position.character + 1, start };
    };
    const matchedTagNames = new Set();
    walk(ts, file, (node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const origin = jsxOrigin(ts, checker, node.tagName);
        const position = file.getLineAndCharacterOfPosition(node.getStart(file));
        if (matches(origin)) {
          matchedTagNames.add(node.tagName);
          if (ts.isJsxOpeningElement(node)) matchedTagNames.add(node.parent.closingElement.tagName);
          const props = attributes(ts, node);
          const hasSpread = props.some((p) => p.kind === 'spread');
          usages.push({
            id: digest(file.fileName + ':' + node.getStart(file) + ':' + origin.module + ':' + origin.exported).slice(0, 20),
            file: file.fileName, line: position.line + 1, column: position.character + 1,
            start: node.getStart(file), end: node.end, origin, props,
            disposition: hasSpread ? 'unsupported-spread' : 'requires-mapping',
            flags: [
              ...(hasSpread ? ['Opaque spread may override explicit props'] : []),
              ...(props.some((p) => ['open', 'onToggle'].includes(p.name)) ? ['Controlled visibility requires explicit target behavior'] : []),
              ...(ts.isJsxOpeningElement(node) && node.parent.children.some((child) => !ts.isJsxText(child) || child.text.trim()) ? ['Nested children may need structural migration'] : []),
            ],
          });
        } else if (origin?.module.startsWith('.')) {
          unsupported.push({ ...location(node), kind: 'local-import', detail: `${node.tagName.getText()}: local wrappers/re-exports are not followed` });
        }
      }
    });
    // Report non-JSX references to selected source imports: wrappers, aliases,
    // factory calls and exports are outside the adapter's proven scope.
    walk(ts, file, (node) => {
      if (ts.isPropertyAccessExpression(node) && matches(jsxOrigin(ts, checker, node)) && !matchedTagNames.has(node)) {
        unsupported.push({ ...location(node), kind: 'non-jsx-reference', detail: node.getText() });
      }
      if (!ts.isIdentifier(node)) return;
      const namespace = checker.getSymbolAtLocation(node)?.declarations?.find(ts.isNamespaceImport);
      if (namespace && rules.sources.some((s) => s.module === namespace.parent.parent.moduleSpecifier.text)
        && !ts.isNamespaceImport(node.parent) && !matchedTagNames.has(node.parent)
        && !(ts.isPropertyAccessExpression(node.parent) && matches(jsxOrigin(ts, checker, node.parent)))) {
        unsupported.push({ ...location(node), kind: 'namespace-reference', detail: node.getText() });
      }
      const origin = jsxOrigin(ts, checker, node);
      if (!matches(origin)) return;
      if (ts.isImportSpecifier(node.parent) || ts.isImportClause(node.parent)) return;
      if (matchedTagNames.has(node)) return;
      if (ts.isJsxOpeningElement(node.parent) || ts.isJsxClosingElement(node.parent) || ts.isJsxSelfClosingElement(node.parent)) return;
      unsupported.push({ ...location(node), kind: 'non-jsx-reference', detail: node.getText() });
    });
    walk(ts, file, (node) => {
      if ((ts.isExportDeclaration(node) || ts.isImportEqualsDeclaration(node)) && rules.sources.some((s) => node.getText().includes(s.module))) {
        unsupported.push({ ...location(node), kind: 'unsupported-module-binding', detail: node.getText() });
      }
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText() === 'require')
        && node.arguments.length && ts.isStringLiteral(node.arguments[0]) && rules.sources.some((s) => s.module === node.arguments[0].text)) {
        unsupported.push({ ...location(node), kind: 'unsupported-module-binding', detail: node.getText() });
      }
    });
  }
  return { usages, unsupported, syntaxDiagnostics: diagnostics };
}

export async function inspectSource(root, rules, compilerFile) {
  const { ts, identity } = await loadCompiler(compilerFile);
  root = await fs.realpath(root);
  const input = await snapshot(root);
  const contents = new Map();
  for (const file of Object.keys(input.files)) {
    if (/\.[cm]?[jt]sx?$/.test(file) && !file.endsWith('.d.ts')) {
      const content = await fs.readFile(path.join(root, file), 'utf8');
      demand(digest(content) === input.files[file].sha256, 'Source changed during inventory');
      contents.set(file, content);
    }
  }
  demand(contents.size > 0, 'No supported source files');
  const result = inspectContents(ts, contents, rules);
  demand((await snapshot(root)).digest === input.digest, 'Source changed during inventory');
  return {
    schemaVersion: 1, mode: 'source-inventory', inputHash: input.digest, rulesHash: jsonDigest(rules), compiler: identity,
    scannedFiles: contents.size, registeredSourceRules: rules.sources, ...result,
    status: result.syntaxDiagnostics.length ? 'syntax-errors' : 'scoped-inventory-complete',
    readiness: 'not-verified',
    limitations: [
      'Direct named/default/namespace ES imports only; lexical symbol identity, not a full dependency graph.',
      'No complete application typecheck, wrapper propagation, CommonJS/dynamic import resolution or runtime verification.',
      'Counts cover only supplied files and configured sources; no repository-wide recall claim.',
      'No migration rule was inferred or executed; every matched usage still needs a reviewed mapping.',
    ],
  };
}
