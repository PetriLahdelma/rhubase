import * as fs from 'node:fs/promises';
import path from 'node:path';
import { attributes, parseProject, walk } from './source-analysis.mjs';
import { digest, demand } from './files.mjs';
import { verifyConsumerInventory } from './consumer-discovery.mjs';

const MAX_REEXPORT_DEPTH = 16;
const MAX_RESOLUTION_EDGES = 50_000;
const sourceFile = (file) => /\.[cm]?[jt]sx?$/i.test(file) && !/\.d\.[cm]?ts$/i.test(file);
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const stableId = (kind, value) => `${kind}:${digest(JSON.stringify(value)).slice(0, 20)}`;
const packageModule = (module, packageName) => {
  if (module === packageName) return true;
  if (!module.startsWith(packageName + '/')) return false;
  return module.slice(packageName.length + 1).split('/').every((part) => part && part !== '.' && part !== '..' && !part.includes('\\') && !/[\x00-\x1f]/.test(part));
};

function publicExportCoordinate(origin, source) {
  const suffix = origin.module.slice(source.importName.length);
  return suffix ? `.${suffix}#${origin.export}` : origin.export;
}

function consumerAttributes(ts, opening) {
  const props = attributes(ts, opening);
  return props.map((prop, index) => {
    const attribute = opening.attributes.properties[index];
    if (!ts.isJsxAttribute(attribute) || !attribute.initializer || !ts.isJsxExpression(attribute.initializer)) return prop;
    const expression = attribute.initializer.expression;
    if (!expression || !ts.isNumericLiteral(expression)) return prop;
    const value = Number(expression.text); return Number.isFinite(value) ? { ...prop, value } : prop;
  });
}

function evidence(record, node, ts) {
  const start = node.getStart(record.source); const end = node.end;
  return [{
    scope: 'consumer', file: record.file, sha256: record.sha256,
    startLine: record.source.getLineAndCharacterOfPosition(start).line + 1,
    endLine: record.source.getLineAndCharacterOfPosition(end).line + 1,
    quote: record.text.slice(start, end),
  }];
}

function location(record, node) {
  const start = node.getStart(record.source); const position = record.source.getLineAndCharacterOfPosition(start);
  return { file: record.file, line: position.line + 1, column: position.character + 1, start, end: node.end };
}

function packageForModule(module, sources) {
  const matches = sources.filter((source) => packageModule(module, source.importName));
  return matches.sort((left, right) => right.importName.length - left.importName.length)[0] ?? null;
}

function relativeModule(files, containing, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(containing), specifier));
  if (base === '..' || base.startsWith('../')) return null;
  return [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mts`, `${base}.cts`, `${base}.mjs`, `${base}.cjs`,
    `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`, `${base}/index.jsx`, `${base}/index.mts`, `${base}/index.cts`]
    .find((candidate) => files.has(candidate)) ?? null;
}

function importedName(ts, specifier) {
  if (ts.isImportSpecifier(specifier)) return specifier.propertyName?.text ?? specifier.name.text;
  if (ts.isImportClause(specifier)) return 'default';
  return '*';
}

function parseBindings(ts, records, sourcePackages) {
  const bindings = new Map(); const exports = new Map(); const aliases = new Map();
  for (const record of records.values()) {
    const fileBindings = new Map(); const fileExports = []; const fileAliases = new Map();
    for (const statement of record.source.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const module = statement.moduleSpecifier.text; const clause = statement.importClause;
        if (!clause || clause.isTypeOnly) continue;
        const add = (name, imported, namespace = false) => fileBindings.set(name, { module, imported, namespace, node: statement, local: module.startsWith('.') });
        if (clause.name) add(clause.name.text, 'default');
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const item of clause.namedBindings.elements) if (!item.isTypeOnly) add(item.name.text, importedName(ts, item));
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) add(clause.namedBindings.name.text, '*', true);
      }
      if (ts.isExportDeclaration(statement)) fileExports.push({ kind: 'declaration', node: statement });
      if (ts.isExportAssignment(statement) && !statement.isExportEquals) fileExports.push({ kind: 'default', node: statement });
      if (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const)) for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) fileAliases.set(declaration.name.text, {
          expression: declaration.initializer, node: declaration,
          exported: statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false,
        });
      }
    }
    bindings.set(record.file, fileBindings); exports.set(record.file, fileExports); aliases.set(record.file, fileAliases);
  }
  return { bindings, exports, aliases };
}

function createResolver(ts, records, sourcePackages, graph) {
  const exportCache = new Map(); let edges = 0;
  const external = (module, exported) => {
    const source = packageForModule(module, sourcePackages); return source ? { sourceId: source.id, sourcePackage: source.identity.name, module, export: exported } : null;
  };
  const same = (origins) => {
    const unique = [...new Map(origins.filter(Boolean).map((item) => [JSON.stringify(item), item])).values()];
    return unique.length === 1 ? { origin: unique[0] } : unique.length > 1 ? { unknown: 'ambiguous local re-export resolution' } : { unknown: 'local binding does not resolve to an explicit source package' };
  };
  function expression(file, value, depth, trail) {
    if (ts.isParenthesizedExpression(value)) return expression(file, value.expression, depth, trail);
    if (ts.isIdentifier(value)) return binding(file, value.text, depth, trail);
    if (ts.isPropertyAccessExpression(value) && ts.isIdentifier(value.expression)) {
      const base = graph.bindings.get(file)?.get(value.expression.text);
      if (base?.namespace) {
        if (!base.local) return external(base.module, value.name.text) ? { origin: external(base.module, value.name.text) } : { unknown: 'namespace is not a selected source package' };
        const target = relativeModule(records, file, base.module); return target ? exported(target, value.name.text, depth + 1, trail) : { unknown: 'local namespace module is unresolved' };
      }
    }
    return { unknown: 'alias initializer is not a static identifier or namespace member' };
  }
  function binding(file, name, depth = 0, trail = new Set()) {
    if (depth > MAX_REEXPORT_DEPTH || edges++ > MAX_RESOLUTION_EDGES) return { unknown: 'local resolution budget exceeded' };
    const key = `${file}#binding:${name}`; if (trail.has(key)) return { unknown: 'local alias/re-export cycle' };
    const next = new Set(trail); next.add(key);
    const item = graph.bindings.get(file)?.get(name);
    if (item) {
      if (!item.local) {
        if (item.namespace) return { namespace: { module: item.module, source: packageForModule(item.module, sourcePackages) } };
        const origin = external(item.module, item.imported); return origin ? { origin } : { unknown: 'import is not from a selected source package' };
      }
      const target = relativeModule(records, file, item.module);
      if (!target) return { unknown: 'relative import target is outside scanned source files' };
      if (item.namespace) return { namespace: { local: target } };
      return exported(target, item.imported, depth + 1, next);
    }
    const alias = graph.aliases.get(file)?.get(name); return alias ? expression(file, alias.expression, depth + 1, next) : { unknown: 'binding has no supported static origin' };
  }
  function exported(file, name, depth = 0, trail = new Set()) {
    const cacheKey = `${file}#export:${name}`; if (exportCache.has(cacheKey)) return exportCache.get(cacheKey);
    if (depth > MAX_REEXPORT_DEPTH || edges++ > MAX_RESOLUTION_EDGES || trail.has(cacheKey)) return { unknown: 'local alias/re-export cycle or budget exceeded' };
    const next = new Set(trail); next.add(cacheKey); const origins = []; const unknown = [];
    for (const item of graph.exports.get(file) ?? []) {
      if (item.kind === 'default' && name === 'default') {
        const result = expression(file, item.node.expression, depth + 1, next); if (result.origin) origins.push(result.origin); else unknown.push(result.unknown);
        continue;
      }
      if (item.kind !== 'declaration') continue;
      const node = item.node; const module = node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : null;
      if (node.exportClause && ts.isNamedExports(node.exportClause)) for (const specifier of node.exportClause.elements) {
        if (specifier.name.text !== name || specifier.isTypeOnly) continue;
        const imported = specifier.propertyName?.text ?? specifier.name.text;
        if (!module) { const result = binding(file, imported, depth + 1, next); if (result.origin) origins.push(result.origin); else unknown.push(result.unknown); }
        else if (!module.startsWith('.')) { const origin = external(module, imported); if (origin) origins.push(origin); else unknown.push('re-export is not from a selected source package'); }
        else { const target = relativeModule(records, file, module); const result = target ? exported(target, imported, depth + 1, next) : { unknown: 'relative re-export target is unresolved' }; if (result.origin) origins.push(result.origin); else unknown.push(result.unknown); }
      }
      if (!node.exportClause && module && name !== 'default') {
        if (!module.startsWith('.')) { const origin = external(module, name); if (origin) origins.push(origin); }
        else { const target = relativeModule(records, file, module); const result = target ? exported(target, name, depth + 1, next) : { unknown: 'relative star re-export target is unresolved' }; if (result.origin) origins.push(result.origin); else unknown.push(result.unknown); }
      }
    }
    const alias = graph.aliases.get(file)?.get(name);
    if (alias?.exported) {
      const result = expression(file, alias.expression, depth + 1, next); if (result.origin) origins.push(result.origin); else unknown.push(result.unknown);
    }
    const result = origins.length ? same(origins) : { unknown: unknown.filter(Boolean)[0] ?? 'export is not statically resolved' };
    exportCache.set(cacheKey, result); return result;
  }
  return { binding, expression, exported };
}

function createReachability(ts, records, sourcePackages, graph) {
  const cache = new Map();
  function touches(file, trail = new Set(), depth = 0) {
    if (cache.has(file)) return cache.get(file);
    if (trail.has(file) || depth > MAX_REEXPORT_DEPTH) return false;
    const next = new Set(trail); next.add(file); let result = false;
    for (const item of graph.bindings.get(file)?.values() ?? []) {
      if (!item.local && packageForModule(item.module, sourcePackages)) { result = true; break; }
      if (item.local) { const target = relativeModule(records, file, item.module); if (target && touches(target, next, depth + 1)) { result = true; break; } }
    }
    if (!result) for (const item of graph.exports.get(file) ?? []) if (item.kind === 'declaration' && item.node.moduleSpecifier && ts.isStringLiteral(item.node.moduleSpecifier)) {
      const module = item.node.moduleSpecifier.text;
      if (!module.startsWith('.') && packageForModule(module, sourcePackages)) { result = true; break; }
      const target = module.startsWith('.') && relativeModule(records, file, module); if (target && touches(target, next, depth + 1)) { result = true; break; }
    }
    cache.set(file, result); return result;
  }
  return touches;
}

function packageRootForFile(file, manifests) {
  let selected = null;
  for (const manifest of manifests) {
    const directory = path.posix.dirname(manifest.file); const prefix = directory === '.' ? '' : directory + '/';
    if ((file === manifest.file || file.startsWith(prefix)) && (!selected || prefix.length > selected.prefix.length)) selected = { manifest, prefix };
  }
  return selected?.manifest ?? manifests.find((item) => item.file === 'package.json') ?? null;
}

async function scopeCompatibility(inventory, manifest, source) {
  if (!manifest) return { compatible: false, reason: 'Consumer package ownership is unknown' };
  let raw = inventory._manifestValues?.get(manifest.file);
  if (!raw) {
    const identity = inventory.files.find((item) => item.file === manifest.file); const bytes = await fs.readFile(path.join(inventory.root, manifest.file));
    demand(identity && digest(bytes) === identity.sha256, `Consumer manifest changed while resolving version scope: ${manifest.file}`); raw = JSON.parse(bytes);
  }
  const sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
  const declared = sections.find((section) => raw?.[section] && Object.hasOwn(raw[section], source.importName));
  if (!declared) return { compatible: false, reason: `Consumer package does not declare ${source.importName}` };
  const declaredSpec = raw[declared][source.importName];
  const exact = typeof declaredSpec === 'string' ? declaredSpec.replace(/^workspace:/, '').replace(/^v/, '') : '';
  if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(exact) && exact !== source.identity.version) {
    return { compatible: false, reason: `${source.importName} declares ${exact} but the selected source is ${source.identity.version}` };
  }
  let directory = path.dirname(path.join(inventory.root, manifest.file));
  for (;;) {
    const candidate = path.join(directory, 'node_modules', ...source.importName.split('/'));
    try {
      const canonical = await fs.realpath(candidate);
      if (canonical !== source.root) return { compatible: false, reason: `${source.importName} resolves to a different installed/workspace root for this consumer package` };
      return { compatible: true };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (directory === inventory.root) break;
    const parent = path.dirname(directory); if (!parent.startsWith(inventory.root) || parent === directory) break; directory = parent;
  }
  if (source.resolution === 'workspace') return { compatible: true };
  return { compatible: false, reason: `${source.importName} has no bounded installed resolution for this consumer package` };
}

function wrapperName(ts, node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && ts.isVariableDeclaration(current.parent) && ts.isIdentifier(current.parent.name)) return current.parent.name.text;
  }
  return null;
}

function bindingIsTracked(ts, checker, graph, file, identifier) {
  const declarations = checker.getSymbolAtLocation(identifier)?.declarations ?? [];
  return declarations.some((declaration) => ts.isImportSpecifier(declaration) || ts.isImportClause(declaration)
    || ts.isNamespaceImport(declaration) || graph.aliases.get(file)?.get(identifier.text)?.node === declaration);
}

export async function discoverConsumerUsages({ root, inventory, sourcePackages, targetPackage, ts }) {
  demand(root && inventory && Array.isArray(sourcePackages) && sourcePackages.length && ts?.version === '5.9.3', 'Consumer usage discovery requires inventory, explicit sources, and TypeScript 5.9.3');
  demand(await verifyConsumerInventory(inventory), 'Consumer repository changed before usage discovery');
  const canonicalRoot = await fs.realpath(root); demand(canonicalRoot === inventory.root, 'Consumer root does not match inventory');
  const sourcePrefixes = [...sourcePackages, ...(targetPackage ? [targetPackage] : [])].map((source) => path.relative(canonicalRoot, source.root)).filter((relative) => relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))).map((relative) => relative.split(path.sep).join('/').replace(/\/$/, ''));
  const selected = inventory.files.filter((item) => item.kind === 'source' && sourceFile(item.file)); const records = new Map(); const contents = new Map(); const excludedFiles = [];
  for (const item of selected) {
    if (sourcePrefixes.some((prefix) => prefix === '' || item.file === prefix || item.file.startsWith(prefix + '/'))) { excludedFiles.push(item.file); continue; }
    const text = await fs.readFile(path.join(canonicalRoot, item.file), 'utf8'); demand(digest(text) === item.sha256, `Consumer source changed while reading: ${item.file}`);
    contents.set(item.file, text); records.set(item.file, { ...item, text });
  }
  const parsed = parseProject(ts, contents);
  for (const record of records.values()) record.source = parsed.program.getSourceFile(record.file);
  const checker = parsed.checker;
  const graph = parseBindings(ts, records, sourcePackages); const resolver = createResolver(ts, records, sourcePackages, graph); const touchesSource = createReachability(ts, records, sourcePackages, graph);
  const usages = []; const unsupported = []; const jsxImports = []; let jsxSites = 0;
  const unsupportedKeys = new Set(); const addUnsupported = (kind, record, node, reason) => {
    const loc = record && node ? location(record, node) : {}; const key = `${kind}:${loc.file ?? ''}:${loc.start ?? ''}:${reason}`; if (unsupportedKeys.has(key)) return;
    unsupportedKeys.add(key); unsupported.push({ id: stableId('unknown', key), kind, ...loc, reason, evidence: record && node ? evidence(record, node, ts) : [] });
  };
  const compatibility = new Map();
  const declaredSubpaths = new Map();
  for (const source of sourcePackages) {
    const manifestBytes = await fs.readFile(path.join(source.root, 'package.json')); demand(digest(manifestBytes) === source.manifestSha256, `Selected source manifest changed: ${source.importName}`);
    const manifest = JSON.parse(manifestBytes); const declared = new Set(['.']);
    if (manifest.exports && typeof manifest.exports === 'object' && !Array.isArray(manifest.exports)) for (const key of Object.keys(manifest.exports)) if (key.startsWith('./') && !key.includes('*')) declared.add(key);
    declaredSubpaths.set(source.id, declared);
  }
  for (const record of records.values()) {
    const manifest = packageRootForFile(record.file, inventory.manifests); const consumerPackage = manifest?.name ?? null;
    for (const source of sourcePackages) compatibility.set(`${manifest?.file ?? '?'}#${source.id}`, await scopeCompatibility(inventory, manifest, source));
    const wrappers = new Set();
    for (const diagnostic of record.source.parseDiagnostics ?? []) addUnsupported('syntax-diagnostic', record, diagnostic.start === undefined ? record.source : { getStart: () => diagnostic.start, end: diagnostic.start + (diagnostic.length ?? 1) }, ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    walk(ts, record.source, (node) => {
      if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return;
      jsxSites += 1; let resolved;
      if (ts.isIdentifier(node.tagName)) resolved = bindingIsTracked(ts, checker, graph, record.file, node.tagName) ? resolver.binding(record.file, node.tagName.text) : { unknown: 'JSX binding is shadowed or locally declared' };
      else if (ts.isPropertyAccessExpression(node.tagName) && ts.isIdentifier(node.tagName.expression)) {
        const base = bindingIsTracked(ts, checker, graph, record.file, node.tagName.expression) ? resolver.binding(record.file, node.tagName.expression.text) : { unknown: 'JSX namespace binding is shadowed or locally declared' };
        if (base.namespace?.source) resolved = { origin: { sourceId: base.namespace.source.id, sourcePackage: base.namespace.source.identity.name, module: base.namespace.module, export: node.tagName.name.text } };
        else if (base.namespace?.local) resolved = resolver.exported(base.namespace.local, node.tagName.name.text);
        else if (base.namespace) resolved = { unknown: 'namespace is not a selected source package' };
        else resolved = resolver.expression(record.file, node.tagName);
      } else resolved = { unknown: 'computed or non-identifier JSX tag' };
      if (!resolved?.origin) {
        if (ts.isIdentifier(node.tagName) && wrappers.has(node.tagName.text)) addUnsupported('wrapper-usage', record, node, 'Local wrapper propagation is not inferred');
        else if (ts.isIdentifier(node.tagName) && graph.aliases.get(record.file)?.has(node.tagName.text)) {
          const alias = graph.aliases.get(record.file).get(node.tagName.text); let related = false;
          walk(ts, alias.expression, (candidate) => { if (ts.isIdentifier(candidate) && resolver.binding(record.file, candidate.text).origin) related = true; });
          if (related) addUnsupported('factory-or-alias', record, node, resolved?.unknown ?? 'Local alias is not statically resolvable');
        }
        else if (ts.isIdentifier(node.tagName)) {
          const binding = graph.bindings.get(record.file)?.get(node.tagName.text); const target = binding?.local && relativeModule(records, record.file, binding.module);
          if (target && touchesSource(target)) addUnsupported('local-reexport-resolution', record, node, resolved?.unknown ?? 'Local source re-export is unresolved');
        }
        return;
      }
      const source = sourcePackages.find((item) => item.id === resolved.origin.sourceId); const scope = compatibility.get(`${manifest?.file ?? '?'}#${source.id}`);
      if (!scope?.compatible) { addUnsupported('unsupported-version-scope', record, node, scope?.reason ?? 'Source resolution scope is unknown'); return; }
      const props = consumerAttributes(ts, node); const hasSpread = props.some((item) => item.kind === 'spread'); const loc = location(record, node);
      const itemEvidence = evidence(record, node, ts); const publicExport = publicExportCoordinate(resolved.origin, source);
      const identity = { file: record.file, start: loc.start, sourceId: source.id, module: resolved.origin.module, export: publicExport, quote: itemEvidence[0].quote };
      usages.push({ id: stableId('usage', identity), ...loc, consumerPackage, sourceId: source.id, sourcePackage: source.identity.name, module: resolved.origin.module, export: publicExport, props, hasSpread, evidence: itemEvidence });
      jsxImports.push({ package: source.importName, evidence: itemEvidence });
      const wrapper = wrapperName(ts, node); if (wrapper) wrappers.add(wrapper);
      if (hasSpread) addUnsupported('spread-props', record, node, 'Opaque JSX spread may alter or override explicit props');
      const suffix = resolved.origin.module.slice(source.importName.length);
      if (suffix && !declaredSubpaths.get(source.id).has(`.${suffix}`)) addUnsupported('undeclared-package-subpath', record, node, `Source import subpath is not explicitly declared by package exports: ${resolved.origin.module}`);
    });
    walk(ts, record.source, (node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const source = packageForModule(node.moduleSpecifier.text, sourcePackages);
        if (source && /\.(?:css|scss|sass|less|styl)$/i.test(node.moduleSpecifier.text)) addUnsupported('style-import', record, node, 'Styling and CSS token usage is not interpreted');
        else if (source && !node.importClause) addUnsupported('non-jsx-reference', record, node, 'Side-effect import from a selected source package may initialize styles or runtime behavior');
      }
      if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        const isDynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require');
        if (isDynamic && packageForModule(node.arguments[0].text, sourcePackages)) addUnsupported('dynamic-module-binding', record, node, 'Dynamic/CommonJS source binding is not resolved');
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && packageForModule(node.moduleSpecifier.text, sourcePackages)) {
        // Supported through local barrels when imported by a JSX consumer; the declaration itself is not a usage.
      }
      if (!ts.isIdentifier(node)) return;
      if (node.parent && (ts.isImportDeclaration(node.parent) || ts.isImportSpecifier(node.parent) || ts.isImportClause(node.parent)
        || ts.isNamespaceImport(node.parent) || ts.isExportSpecifier(node.parent))) return;
      if (node.parent && ((ts.isJsxOpeningElement(node.parent) || ts.isJsxSelfClosingElement(node.parent) || ts.isJsxClosingElement(node.parent))
        || (ts.isPropertyAccessExpression(node.parent) && (ts.isJsxOpeningElement(node.parent.parent) || ts.isJsxSelfClosingElement(node.parent.parent) || ts.isJsxClosingElement(node.parent.parent))))) return;
      if (node.parent && ts.isVariableDeclaration(node.parent) && node.parent.initializer === node) return;
      if (node.parent && ts.isPropertyAccessExpression(node.parent) && ts.isVariableDeclaration(node.parent.parent) && node.parent.parent.initializer === node.parent) return;
      if (!bindingIsTracked(ts, checker, graph, record.file, node)) return;
      const resolved = resolver.binding(record.file, node.text);
      if (resolved.origin) addUnsupported('non-jsx-reference', record, node, 'Selected source binding is used outside a supported JSX element');
    });
  }
  for (const prefix of sourcePrefixes.filter(Boolean)) addUnsupported('excluded-source-library', null, null, `Selected source/target package directory excluded from consumer counts: ${prefix}`);
  usages.sort((left, right) => compareText(left.file, right.file) || left.start - right.start || compareText(left.id, right.id));
  unsupported.sort((left, right) => compareText(left.file ?? '', right.file ?? '') || (left.start ?? 0) - (right.start ?? 0) || compareText(left.kind, right.kind));
  demand(await verifyConsumerInventory(inventory), 'Consumer repository changed during usage discovery');
  return {
    filesScanned: records.size, usages, unsupported, jsxImports,
    coverage: {
      status: 'partial',
      sourceFiles: { eligible: selected.length, scanned: records.size, excludedSourceLibraries: excludedFiles.length },
      jsxSites, recognizedUsages: usages.length, unsupportedCount: unsupported.length, observedUnsupportedCount: unsupported.length,
      limitations: [
        'Counts cover only selected, scanned JavaScript/TypeScript source files.',
        'Direct imports, namespaces, immutable aliases, and bounded local re-exports are supported.',
        'Wrappers, factories, dynamic/CommonJS imports, computed access, spreads, CSS and token references remain explicit unknowns.',
        'No package, application, script, configuration plugin, or source module was executed.',
      ],
    },
  };
}

export async function discoverJsxImportCandidates({ root, inventory, ts }) {
  demand(ts?.version === '5.9.3' && await verifyConsumerInventory(inventory), 'Candidate discovery requires unchanged inventory and TypeScript 5.9.3');
  const canonicalRoot = await fs.realpath(root); demand(canonicalRoot === inventory.root, 'Consumer root does not match inventory');
  const candidates = [];
  for (const item of inventory.files.filter((entry) => entry.kind === 'source' && sourceFile(entry.file))) {
    const text = await fs.readFile(path.join(canonicalRoot, item.file), 'utf8'); demand(digest(text) === item.sha256, `Consumer source changed while reading: ${item.file}`);
    const parsed = parseProject(ts, new Map([[item.file, text]])); const source = parsed.program.getSourceFile(item.file); const checker = parsed.checker; const bindings = new Map();
    const owner = packageRootForFile(item.file, inventory.manifests); const declared = new Set(owner?.dependencies.map((dependency) => dependency.name) ?? []);
    for (const statement of source.statements) if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && !statement.moduleSpecifier.text.startsWith('.')) {
      const module = statement.moduleSpecifier.text; const packageName = module.startsWith('@') ? module.split('/').slice(0, 2).join('/') : module.split('/')[0];
      if (!packageModule(module, packageName)) continue;
      if (!declared.has(packageName) || !statement.importClause?.namedBindings && !statement.importClause?.name) continue;
      if (statement.importClause.name) bindings.set(statement.importClause.name.text, { packageName, module, node: statement });
      const named = statement.importClause.namedBindings;
      if (named && ts.isNamedImports(named)) for (const specifier of named.elements) if (!specifier.isTypeOnly) bindings.set(specifier.name.text, { packageName, module, node: statement });
      if (named && ts.isNamespaceImport(named)) bindings.set(named.name.text, { packageName, module, node: statement });
    }
    walk(ts, source, (node) => {
      if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return;
      const name = ts.isIdentifier(node.tagName) ? node.tagName.text : ts.isPropertyAccessExpression(node.tagName) && ts.isIdentifier(node.tagName.expression) ? node.tagName.expression.text : null;
      const binding = name && bindings.get(name); if (!binding) return;
      const identifier = ts.isIdentifier(node.tagName) ? node.tagName : node.tagName.expression;
      const declarations = checker.getSymbolAtLocation(identifier)?.declarations ?? [];
      if (!declarations.some((declaration) => ts.isImportSpecifier(declaration) || ts.isImportClause(declaration) || ts.isNamespaceImport(declaration))) return;
      const record = { ...item, text, source };
      candidates.push({ package: binding.packageName, module: binding.module, evidence: evidence(record, node, ts) });
    });
  }
  demand(await verifyConsumerInventory(inventory), 'Consumer repository changed during candidate discovery');
  return candidates.sort((left, right) => compareText(left.package, right.package) || compareText(left.module, right.module) || compareText(left.evidence[0].file, right.evidence[0].file));
}
