import * as fs from 'node:fs/promises';
import path from 'node:path';
import { digest, jsonDigest, demand, relativePath } from './files.mjs';

const MAX_FILE_BYTES = 5_000_000;
const MAX_TOTAL_BYTES = 100_000_000;
const MAX_FILES = 10_000;
const ignoredDirectories = new Set(['.git', 'node_modules', '.shift', '.omx', 'coverage']);
const sensitiveDirectories = new Set(['.ssh', '.aws', '.claude', '.codex', '.gnupg']);
const sensitive = (name) => {
  const lower = name.toLowerCase();
  return /^\.env(?:\.|$)/.test(lower)
    || ['.npmrc', '.netrc', 'id_rsa', 'id_ed25519', 'credentials'].includes(lower)
    || /\.(?:pem|key|p12|pfx)$/.test(lower);
};
const markdownSelected = (file) => /^(?:README|CHANGELOG)(?:\.[^.]+)?\.md$/i.test(file)
  || /^MIGRATION[^/]*\.md$/i.test(file)
  || /^docs\/.*\.md$/i.test(file);
const tokenSelected = (file) => file === 'tokens.json' || /^tokens\/.*\.json$/i.test(file) || /\.tokens\.json$/i.test(file);
const sourceSelected = (file) => /\.(?:d\.)?[cm]?[jt]sx?$/.test(file);

function coverageCollection() { return { eligible: [], extracted: [], unsupported: [] }; }
function uniqueSorted(values) { return [...new Set(values)].sort(); }
function compareText(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function lineRange(text, start, end) {
  const startLine = text.slice(0, start).split('\n').length;
  const endLine = text.slice(0, end).split('\n').length;
  return { startLine, endLine };
}
function evidenceFor(record, node) {
  const start = node.getStart(node.getSourceFile()); const end = node.end;
  return { file: record.file, sha256: record.sha256, ...lineRange(record.text, start, end), quote: record.text.slice(start, end) };
}
function evidenceAt(record, needle) {
  const start = Math.max(0, record.text.indexOf(needle));
  const lineStart = record.text.lastIndexOf('\n', start - 1) + 1;
  const next = record.text.indexOf('\n', start);
  const end = next < 0 ? record.text.length : next;
  return { file: record.file, sha256: record.sha256, ...lineRange(record.text, lineStart, end), quote: record.text.slice(lineStart, end) };
}
function jsonLocations(text) {
  let cursor = 0; const locations = new Map();
  const whitespace = () => { while (/\s/.test(text[cursor] ?? '')) cursor += 1; };
  const stringEnd = () => {
    demand(text[cursor] === '"', 'Invalid JSON string position'); cursor += 1; let escaped = false;
    while (cursor < text.length) {
      const char = text[cursor++];
      if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') return cursor;
    }
    throw new Error('Unterminated JSON string');
  };
  function parse(parts, propertyStart = null) {
    whitespace(); const valueStart = cursor;
    if (text[cursor] === '{') {
      cursor += 1; whitespace();
      while (text[cursor] !== '}') {
        const keyStart = cursor; const keyEnd = stringEnd(); const key = JSON.parse(text.slice(keyStart, keyEnd));
        whitespace(); demand(text[cursor++] === ':', 'Invalid JSON object separator');
        parse([...parts, key], keyStart); whitespace();
        if (text[cursor] === ',') { cursor += 1; whitespace(); continue; }
        break;
      }
      demand(text[cursor++] === '}', 'Invalid JSON object ending');
    } else if (text[cursor] === '[') {
      cursor += 1; whitespace(); let index = 0;
      while (text[cursor] !== ']') {
        parse([...parts, index++]); whitespace();
        if (text[cursor] === ',') { cursor += 1; whitespace(); continue; }
        break;
      }
      demand(text[cursor++] === ']', 'Invalid JSON array ending');
    } else if (text[cursor] === '"') stringEnd();
    else {
      while (cursor < text.length && !/[\s,}\]]/.test(text[cursor])) cursor += 1;
    }
    const end = cursor; locations.set(JSON.stringify(parts), { start: propertyStart ?? valueStart, end });
  }
  whitespace(); parse([]); whitespace(); demand(cursor === text.length, 'Unexpected JSON content after root value');
  return locations;
}
function jsonPathEvidence(record, locations, parts) {
  const location = locations.get(JSON.stringify(parts));
  demand(location, `Missing JSON evidence location: ${parts.join('.')}`);
  return { file: record.file, sha256: record.sha256, ...lineRange(record.text, location.start, location.end), quote: record.text.slice(location.start, location.end) };
}

async function admitFiles(root) {
  root = path.resolve(root);
  const rootStat = await fs.lstat(root);
  demand(rootStat.isDirectory() && !rootStat.isSymbolicLink(), `Expected real snapshot directory: ${root}`);
  const admitted = new Map(); const excludedFiles = []; let total = 0;
  async function visit(directory, prefix = '') {
    for (const name of (await fs.readdir(directory)).sort()) {
      const file = relativePath(prefix + name); const absolute = path.join(directory, name);
      const stat = await fs.lstat(absolute);
      demand(!stat.isSymbolicLink(), `Snapshot symlink is unsupported: ${file}`);
      if (stat.isDirectory()) {
        const lower = name.toLowerCase();
        if (sensitiveDirectories.has(lower)) { excludedFiles.push({ file, reason: 'sensitive credential directory is not admitted for extraction' }); continue; }
        if (ignoredDirectories.has(lower)) { excludedFiles.push({ file, reason: 'generated or dependency directory is outside snapshot extraction scope' }); continue; }
        await visit(absolute, file + '/'); continue;
      }
      if (sensitive(name)) { excludedFiles.push({ file, reason: 'sensitive configuration or key file is not admitted for extraction' }); continue; }
      demand(stat.isFile(), `Unsupported special snapshot file: ${file}`);
      demand(stat.size <= MAX_FILE_BYTES, `Snapshot file exceeds ${MAX_FILE_BYTES} bytes: ${file}`);
      total += stat.size;
      demand(total <= MAX_TOTAL_BYTES && admitted.size < MAX_FILES, 'Snapshot exceeds extraction file or byte budget');
      const bytes = await fs.readFile(absolute); const sha256 = digest(bytes);
      let text = null;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { excludedFiles.push({ file, reason: 'binary or invalid UTF-8 content is hashed but not parsed' }); }
      admitted.set(file, { file, absolute, sha256, bytes: bytes.length, text });
    }
  }
  await visit(root);
  return { root, admitted, excludedFiles, digest: jsonDigest([...admitted.values()].map(({ file, sha256, bytes }) => ({ file, sha256, bytes }))) };
}

function collectTypeEntrypoints(manifest) {
  const entries = new Map(); let declared = false; const unsupported = [];
  const add = (name, value, origin) => {
    declared = true;
    if (typeof value === 'string') {
      const file = value.replace(/^\.\//, '');
      if (entries.has(name) && entries.get(name) !== file) unsupported.push({ name, reason: `contradictory declared type entrypoints for ${name}: ${entries.get(name)} and ${file}` });
      else entries.set(name, file);
    }
    else unsupported.push({ name, reason: `${origin} type condition is not a static string` });
  };
  if (Object.hasOwn(manifest, 'types')) add('.', manifest.types, 'types');
  if (Object.hasOwn(manifest, 'typings')) add('.', manifest.typings, 'typings');
  function typeCondition(value, name) {
    if (typeof value === 'string') return;
    if (Array.isArray(value)) { unsupported.push({ name, reason: 'array export conditions are unsupported' }); return; }
    if (!value || typeof value !== 'object') return;
    if (Object.hasOwn(value, 'types')) add(name, value.types, `exports ${name}`);
    else for (const nested of Object.values(value)) if (nested && typeof nested === 'object') typeCondition(nested, name);
  }
  if (Object.hasOwn(manifest, 'exports')) {
    const exports = manifest.exports;
    if (exports && typeof exports === 'object' && !Array.isArray(exports)) {
      const subpaths = Object.keys(exports).filter((key) => key.startsWith('.'));
      if (subpaths.length) for (const name of subpaths) typeCondition(exports[name], name);
      else typeCondition(exports, '.');
    } else unsupported.push({ name: '.', reason: 'package exports is not a static object' });
  }
  return { entries, declared, unsupported };
}

function createProgram(ts, records, rootNames) {
  const names = new Map([...records].filter(([, record]) => record.text !== null && sourceSelected(record.file))
    .map(([file, record]) => [path.resolve('/', file), record]));
  const canonical = (file) => path.resolve('/', file);
  const resolveLocal = (specifier, containing) => {
    if (!specifier.startsWith('.')) return undefined;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(containing), specifier));
    const explicitJs = base.match(/^(.*)\.(?:mjs|cjs|js|jsx)$/)?.[1];
    const stems = uniqueSorted([base, ...(explicitJs ? [explicitJs] : [])]);
    const candidates = stems.flatMap((stem) => [stem, `${stem}.d.ts`, `${stem}.d.mts`, `${stem}.d.cts`, `${stem}.ts`, `${stem}.mts`, `${stem}.cts`, `${stem}.tsx`, `${stem}.js`, `${stem}.mjs`, `${stem}.cjs`, `${stem}.jsx`, `${stem}/index.d.ts`, `${stem}/index.d.mts`, `${stem}/index.d.cts`, `${stem}/index.ts`, `${stem}/index.mts`, `${stem}/index.cts`, `${stem}/index.tsx`]);
    const found = candidates.find((candidate) => names.has(canonical(candidate)));
    if (!found) return undefined;
    const extension = found.endsWith('.tsx') ? ts.Extension.Tsx
      : found.endsWith('.mts') ? (ts.Extension.Mts ?? ts.Extension.Ts)
        : found.endsWith('.cts') ? (ts.Extension.Cts ?? ts.Extension.Ts)
          : found.endsWith('.ts') ? ts.Extension.Ts
            : found.endsWith('.jsx') ? ts.Extension.Jsx
              : found.endsWith('.mjs') ? (ts.Extension.Mjs ?? ts.Extension.Js)
                : found.endsWith('.cjs') ? (ts.Extension.Cjs ?? ts.Extension.Js) : ts.Extension.Js;
    return { resolvedFileName: canonical(found), extension, isExternalLibraryImport: false };
  };
  const options = { noEmit: true, noLib: true, skipLibCheck: true, allowJs: true, checkJs: false, jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext };
  const host = {
    getSourceFile(file, languageVersion) {
      const record = names.get(canonical(file)); if (!record) return undefined;
      const kind = record.file.endsWith('.tsx') ? ts.ScriptKind.TSX : record.file.endsWith('.jsx') ? ts.ScriptKind.JSX : record.file.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS;
      return ts.createSourceFile(canonical(file), record.text, languageVersion, true, kind);
    },
    getDefaultLibFileName: () => '/lib.d.ts', writeFile: () => {}, getCurrentDirectory: () => '/', getDirectories: () => [],
    directoryExists: (directory) => [...names.keys()].some((name) => name.startsWith(canonical(directory) + path.sep)),
    fileExists: (file) => names.has(canonical(file)), readFile: (file) => names.get(canonical(file))?.text,
    getCanonicalFileName: canonical, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
    resolveModuleNames: (modules, containing) => modules.map((module) => resolveLocal(module, containing)),
  };
  return ts.createProgram(rootNames.map(canonical), options, host);
}

function docsFor(ts, record, node) {
  const comments = node.jsDoc ?? [];
  if (!comments.length) {
    const start = node.getFullStart(); const end = node.getStart(node.getSourceFile()); const leading = record.text.slice(start, end);
    const matches = [...leading.matchAll(/\/\*\*([\s\S]*?)\*\//g)];
    if (!matches.length) return undefined;
    const tags = []; const descriptions = []; const texts = [];
    for (const match of matches) {
      const text = match[0]; const absolute = start + match.index; texts.push(text);
      const content = match[1].replace(/^\s*\* ?/gm, ' ').trim();
      const firstTag = content.search(/@\w+/); const description = (firstTag < 0 ? content : content.slice(0, firstTag)).trim();
      if (description) descriptions.push(description);
      const pattern = /@(\w+)\s*([^@]*?)(?=@\w+|$)/g; let tagMatch;
      while ((tagMatch = pattern.exec(content))) {
        const quote = tagMatch[0].trim(); const quoteStart = record.text.indexOf(quote, absolute);
        tags.push({ name: tagMatch[1], text: tagMatch[2].trim(), evidence: [{ file: record.file, sha256: record.sha256, ...lineRange(record.text, quoteStart, quoteStart + quote.length), quote }] });
      }
    }
    return { description: descriptions.join('\n'), tags, text: texts.join('\n') };
  }
  const tags = [];
  for (const comment of comments) for (const tag of comment.tags ?? []) {
    const text = typeof tag.comment === 'string' ? tag.comment : (tag.comment ?? []).map((part) => part.text).join('');
    tags.push({ name: tag.tagName.text, text, evidence: [evidenceFor(record, tag)] });
  }
  const description = comments.map((comment) => typeof comment.comment === 'string' ? comment.comment : (comment.comment ?? []).map((part) => part.text).join('')).filter(Boolean).join('\n');
  return { description, tags, text: comments.map((comment) => record.text.slice(comment.pos, comment.end)).join('\n') };
}

function literalFromNode(ts, node) {
  if (!node) return { known: false };
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) node = node.expression;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { known: true, value: node.text };
  if (ts.isNumericLiteral(node)) return { known: true, value: Number(node.text) };
  if (node.kind === ts.SyntaxKind.TrueKeyword) return { known: true, value: true };
  if (node.kind === ts.SyntaxKind.FalseKeyword) return { known: true, value: false };
  if (node.kind === ts.SyntaxKind.NullKeyword) return { known: true, value: null };
  if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand) && [ts.SyntaxKind.MinusToken, ts.SyntaxKind.PlusToken].includes(node.operator)) {
    return { known: true, value: Number(`${node.operator === ts.SyntaxKind.MinusToken ? '-' : ''}${node.operand.text}`) };
  }
  if (ts.isArrayLiteralExpression(node)) {
    const values = node.elements.map((element) => literalFromNode(ts, element));
    return values.every((value) => value.known) ? { known: true, value: values.map((value) => value.value) } : { known: false };
  }
  if (ts.isObjectLiteralExpression(node)) {
    const value = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property) || (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name) && !ts.isNumericLiteral(property.name))) return { known: false };
      const item = literalFromNode(ts, property.initializer); if (!item.known) return { known: false };
      value[property.name.text] = item.value;
    }
    return { known: true, value };
  }
  return { known: false };
}

function documentedDefault(ts, docs) {
  const tag = docs?.tags.find((item) => ['default', 'defaultValue'].includes(item.name));
  if (!tag) return { known: false };
  const value = tag.text.trim();
  try { return { known: true, value: JSON.parse(value) }; } catch {}
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    try { return { known: true, value: value.startsWith('"') ? JSON.parse(value) : value.slice(1, -1) }; } catch { return { known: false }; }
  }
  return { known: false };
}

function declarationRecord(records, node) { return records.get(path.relative('/', node.getSourceFile().fileName).split(path.sep).join('/')); }
function staticPropertyName(ts, name) {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : null;
}
function resolveAlias(ts, checker, symbol) {
  if (!symbol) return null;
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function normalizer(ts, checker, records, issues, issueEvidence) {
  const resolving = new Set(); const interfaceStack = new Set();
  const unsupported = (node, reason) => {
    const record = declarationRecord(records, node);
    const evidence = record ? [evidenceFor(record, node)] : issueEvidence;
    issues.push({ id: `type:${digest(`${record?.file ?? ''}:${node.getStart(node.getSourceFile())}:${reason}:${node.getText()}`).slice(0, 16)}`, reason, evidence });
    return { type: `unsupported:${node.getText().replace(/\s+/g, ' ').trim()}`, unsupported: { reason, evidence } };
  };
  const normalize = (node, optional = false) => {
    while (ts.isParenthesizedTypeNode(node)) node = node.type;
    const keywords = new Map([[ts.SyntaxKind.StringKeyword, 'string'], [ts.SyntaxKind.NumberKeyword, 'number'], [ts.SyntaxKind.BooleanKeyword, 'boolean'], [ts.SyntaxKind.UnknownKeyword, 'unknown'], [ts.SyntaxKind.AnyKeyword, 'any'], [ts.SyntaxKind.NeverKeyword, 'never'], [ts.SyntaxKind.VoidKeyword, 'void'], [ts.SyntaxKind.UndefinedKeyword, 'undefined'], [ts.SyntaxKind.NullKeyword, 'null'], [ts.SyntaxKind.ObjectKeyword, 'object']]);
    if (keywords.has(node.kind)) return { type: keywords.get(node.kind) };
    if (ts.isLiteralTypeNode(node)) {
      const value = literalFromNode(ts, node.literal);
      return value.known ? { type: JSON.stringify(value.value), literals: [value.value] } : unsupported(node, 'unsupported type literal');
    }
    if (ts.isUnionTypeNode(node)) {
      const parts = node.types.flatMap((part) => ts.isUnionTypeNode(part) ? part.types : [part]).map((part) => normalize(part, optional));
      if (parts.some((part) => part.unsupported)) return parts.find((part) => part.unsupported);
      const kept = optional ? parts.filter((part) => part.type !== 'undefined') : parts;
      const types = uniqueSorted(kept.flatMap((part) => part.members ?? [part.type]));
      const literals = kept.flatMap((part) => part.literals ?? []);
      const allLiteral = kept.length > 0 && kept.every((part) => part.literals?.length);
      return { type: types.join(' | ') || 'undefined', members: types, ...(allLiteral ? { literals: [...new Map(literals.map((value) => [JSON.stringify(value), value])).values()].sort((a, b) => compareText(JSON.stringify(a), JSON.stringify(b))) } : {}) };
    }
    if (ts.isIntersectionTypeNode(node)) {
      const parts = node.types.map((part) => normalize(part, optional));
      if (parts.some((part) => part.unsupported)) return parts.find((part) => part.unsupported);
      if (parts.every((part) => part.objectMembers)) {
        const objectMembers = uniqueSorted(parts.flatMap((part) => part.objectMembers));
        return { type: `{ ${objectMembers.join('; ')} }`, objectMembers };
      }
      return { type: uniqueSorted(parts.map((part) => part.type)).join(' & ') };
    }
    if (ts.isArrayTypeNode(node)) { const part = normalize(node.elementType); return part.unsupported ? part : { type: `Array<${part.type}>` }; }
    if (ts.isTupleTypeNode(node)) {
      const parts = node.elements.map((part) => normalize(part)); if (parts.some((part) => part.unsupported)) return parts.find((part) => part.unsupported);
      return { type: `[${parts.map((part) => part.type).join(', ')}]` };
    }
    if (ts.isFunctionTypeNode(node)) {
      let parameterUnsupported = null;
      const parameters = node.parameters.map((parameter, index) => {
        if (!parameter.type) return `arg${index}: unsupported`;
        const value = normalize(parameter.type, Boolean(parameter.questionToken));
        if (value.unsupported) parameterUnsupported = value.unsupported;
        return `${parameter.dotDotDotToken ? '...' : ''}arg${index}${parameter.questionToken ? '?' : ''}: ${value.type}`;
      });
      const returns = normalize(node.type); return { type: `(${parameters.join(', ')}) => ${returns.type}`, ...((parameterUnsupported ?? returns.unsupported) ? { unsupported: parameterUnsupported ?? returns.unsupported } : {}) };
    }
    if (ts.isTypeLiteralNode(node)) {
      const members = [];
      for (const member of node.members) {
        if (!ts.isPropertySignature(member) || !member.type) return unsupported(member, 'unsupported object type member');
        const name = staticPropertyName(ts, member.name); if (name === null) return unsupported(member, 'computed object property names are unsupported');
        const value = normalize(member.type, Boolean(member.questionToken)); if (value.unsupported) return value;
        members.push(`${name}${member.questionToken ? '?' : ''}: ${value.type}`);
      }
      const objectMembers = uniqueSorted(members);
      return { type: `{ ${objectMembers.join('; ')} }`, objectMembers };
    }
    if (ts.isTypeReferenceNode(node)) {
      const name = node.typeName.getText();
      if (['Array', 'ReadonlyArray'].includes(name) && node.typeArguments?.length === 1) {
        const part = normalize(node.typeArguments[0]); return part.unsupported ? part : { type: `${name}<${part.type}>` };
      }
      const symbol = resolveAlias(ts, checker, checker.getSymbolAtLocation(node.typeName));
      const declaration = symbol?.declarations?.find((item) => ts.isTypeAliasDeclaration(item) || ts.isInterfaceDeclaration(item));
      if (!declaration) return unsupported(node, `external or unresolved type reference: ${name}`);
      const key = declaration.getSourceFile().fileName + ':' + declaration.pos;
      if (resolving.has(key)) return unsupported(node, `recursive type reference: ${name}`);
      if (declaration.typeParameters?.length || node.typeArguments?.length) return unsupported(node, `generic local type reference is unsupported: ${name}`);
      resolving.add(key);
      const value = ts.isTypeAliasDeclaration(declaration) ? normalize(declaration.type, optional) : normalizeInterface(declaration);
      resolving.delete(key); return value;
    }
    return unsupported(node, `unsupported type syntax: ${ts.SyntaxKind[node.kind]}`);
  };
  const normalizeInterface = (declaration) => {
    const key = declaration.getSourceFile().fileName + ':' + declaration.pos;
    if (interfaceStack.has(key)) return unsupported(declaration, `recursive interface inheritance: ${declaration.name?.text ?? 'anonymous'}`);
    interfaceStack.add(key);
    const members = [];
    for (const clause of declaration.heritageClauses ?? []) for (const type of clause.types) {
      const symbol = resolveAlias(ts, checker, checker.getSymbolAtLocation(type.expression));
      const base = symbol?.declarations?.find(ts.isInterfaceDeclaration);
      if (!base) { interfaceStack.delete(key); return unsupported(type, `external or unresolved interface base: ${type.expression.getText()}`); }
      const normalized = normalizeInterface(base); if (normalized.unsupported) { interfaceStack.delete(key); return normalized; }
      members.push(...(normalized.objectMembers ?? []));
    }
    for (const member of declaration.members) {
      if (!ts.isPropertySignature(member) || !member.type) { interfaceStack.delete(key); return unsupported(member, 'unsupported interface member'); }
      const name = staticPropertyName(ts, member.name); if (name === null) { interfaceStack.delete(key); return unsupported(member, 'computed interface property names are unsupported'); }
      const value = normalize(member.type, Boolean(member.questionToken)); if (value.unsupported) { interfaceStack.delete(key); return value; }
      members.push(`${name}${member.questionToken ? '?' : ''}: ${value.type}`);
    }
    const objectMembers = uniqueSorted(members);
    interfaceStack.delete(key); return { type: `{ ${objectMembers.join('; ')} }`, objectMembers };
  };
  return { normalize, normalizeInterface, unsupported };
}

function propsDeclaration(ts, checker, declaration) {
  const reactType = (typeName, accepted) => {
    const text = typeName.getText();
    if (text.startsWith('React.')) return accepted.includes(text.slice('React.'.length));
    if (!accepted.includes(text)) return false;
    const symbol = checker.getSymbolAtLocation(typeName);
    const imported = symbol?.declarations?.find(ts.isImportSpecifier);
    return imported?.parent?.parent?.parent?.moduleSpecifier?.text === 'react';
  };
  const callable = (type, seen = new Set()) => {
    while (type && ts.isParenthesizedTypeNode(type)) type = type.type;
    if (!type) return null;
    if (ts.isFunctionTypeNode(type)) return type.parameters[0]?.type ? { type: type.parameters[0].type, parameter: type.parameters[0] } : null;
    if (ts.isTypeLiteralNode(type)) {
      const signature = type.members.find(ts.isCallSignatureDeclaration);
      return signature?.parameters[0]?.type ? { type: signature.parameters[0].type, parameter: signature.parameters[0] } : null;
    }
    if (!ts.isTypeReferenceNode(type)) return null;
    const symbol = resolveAlias(ts, checker, checker.getSymbolAtLocation(type.typeName));
    const target = symbol?.declarations?.find((item) => ts.isTypeAliasDeclaration(item) || ts.isInterfaceDeclaration(item));
    if (!target) return null;
    const key = target.getSourceFile().fileName + ':' + target.pos; if (seen.has(key)) return null; seen.add(key);
    if (ts.isTypeAliasDeclaration(target)) return callable(target.type, seen);
    const signature = target.members.find(ts.isCallSignatureDeclaration);
    return signature?.parameters[0]?.type ? { type: signature.parameters[0].type, parameter: signature.parameters[0] } : null;
  };
  if (ts.isFunctionDeclaration(declaration) && declaration.parameters[0]?.type) return { type: declaration.parameters[0].type, parameter: declaration.parameters[0] };
  if (ts.isVariableDeclaration(declaration)) {
    if (declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) && declaration.initializer.parameters[0]?.type) return { type: declaration.initializer.parameters[0].type, parameter: declaration.initializer.parameters[0] };
    const type = declaration.type;
    if (type && ts.isTypeReferenceNode(type) && reactType(type.typeName, ['FC', 'FunctionComponent']) && type.typeArguments?.[0]) {
      const parameter = declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) ? declaration.initializer.parameters[0] ?? null : null;
      return { type: type.typeArguments[0], parameter };
    }
    const signature = callable(type); if (signature) return signature;
  }
  if (ts.isClassDeclaration(declaration)) {
    for (const clause of declaration.heritageClauses ?? []) for (const type of clause.types) {
      if (reactType(type.expression, ['Component', 'PureComponent']) && type.typeArguments?.[0]) return { type: type.typeArguments[0], parameter: null };
    }
  }
  return null;
}

function propMembers(ts, checker, typeNode, parameter, normalize, records) {
  const nodes = new Map(); const visiting = new Set();
  function add(current) {
    while (ts.isParenthesizedTypeNode(current)) current = current.type;
    if (ts.isTypeReferenceNode(current)) {
      if (current.typeArguments?.length) return `generic props type is unsupported: ${current.getText()}`;
      const symbol = resolveAlias(ts, checker, checker.getSymbolAtLocation(current.typeName));
      const declaration = symbol?.declarations?.find((item) => ts.isInterfaceDeclaration(item) || ts.isTypeAliasDeclaration(item));
      if (!declaration) return `props type is external or unresolved: ${current.getText()}`;
      return add(declaration);
    }
    if (ts.isTypeAliasDeclaration(current)) return add(current.type);
    if (ts.isIntersectionTypeNode(current)) {
      for (const type of current.types) { const reason = add(type); if (reason) return reason; }
      return null;
    }
    if (!ts.isInterfaceDeclaration(current) && !ts.isTypeLiteralNode(current)) return 'props type is not a supported local interface, intersection, or type literal';
    const key = current.getSourceFile().fileName + ':' + current.pos;
    if (visiting.has(key)) return `recursive props surface: ${current.name?.text ?? 'anonymous'}`;
    visiting.add(key);
    if (ts.isInterfaceDeclaration(current)) for (const clause of current.heritageClauses ?? []) for (const type of clause.types) {
      const symbol = resolveAlias(ts, checker, checker.getSymbolAtLocation(type.expression));
      const base = symbol?.declarations?.find(ts.isInterfaceDeclaration);
      if (!base) { visiting.delete(key); return `external or unresolved props base: ${type.expression.getText()}`; }
      const reason = add(base); if (reason) { visiting.delete(key); return reason; }
    }
    for (const member of current.members) {
      if (!ts.isPropertySignature(member) || !member.type) { visiting.delete(key); return 'props contain unsupported non-property members'; }
      const name = staticPropertyName(ts, member.name);
      if (name === null) { visiting.delete(key); return 'computed props property names are unsupported'; }
      const existing = nodes.get(name);
      if (existing && (existing.type.getText().replace(/\s+/g, '') !== member.type.getText().replace(/\s+/g, '')
        || Boolean(existing.questionToken) !== Boolean(member.questionToken))) {
        visiting.delete(key); return `contradictory inherited prop declarations: ${name}`;
      }
      nodes.set(name, member);
    }
    visiting.delete(key); return null;
  }
  const unsupported = add(typeNode); if (unsupported) return { props: [], unsupported };
  const defaults = new Map();
  if (parameter && ts.isObjectBindingPattern(parameter.name)) for (const element of parameter.name.elements) {
    if (element.dotDotDotToken || !element.initializer) continue;
    const name = element.propertyName?.getText() ?? element.name.getText(); const value = literalFromNode(ts, element.initializer);
    const record = declarationRecord(records, element);
    if (value.known) defaults.set(name, { value, evidence: record ? evidenceFor(record, element) : null });
  }
  const props = [];
  for (const member of nodes.values()) {
    const record = declarationRecord(records, member); const docs = record ? docsFor(ts, record, member) : undefined;
    const normalized = normalize(member.type, Boolean(member.questionToken));
    const name = staticPropertyName(ts, member.name);
    const bindingDefault = defaults.get(name); const defaultValue = bindingDefault?.value ?? documentedDefault(ts, docs);
    const defaultTagEvidence = defaultValue.known ? docs?.tags.find((tag) => ['default', 'defaultValue'].includes(tag.name))?.evidence ?? [] : [];
    const evidence = [...(record ? [evidenceFor(record, member)] : []), ...(bindingDefault?.evidence ? [bindingDefault.evidence] : []), ...defaultTagEvidence];
    props.push({ name, type: normalized.type, ...(normalized.literals ? { literals: normalized.literals } : {}), required: !member.questionToken, default: defaultValue,
      ...(docs ? { docs } : {}), evidence, ...(normalized.unsupported ? { unsupported: normalized.unsupported } : {}) });
  }
  return { props: props.sort((a, b) => compareText(a.name, b.name)) };
}

function extractTokens(records, coverage, issues) {
  const tokens = [];
  for (const record of [...records.values()].filter((item) => item.text !== null && tokenSelected(item.file)).sort((a, b) => compareText(a.file, b.file))) {
    coverage.tokenFiles.eligible.push(record.file);
    let json;
    let locations;
    try { json = JSON.parse(record.text); locations = jsonLocations(record.text); }
    catch (error) { coverage.tokenFiles.unsupported.push({ id: record.file, reason: `invalid token JSON: ${error.message}`, evidence: [evidenceAt(record, record.text.slice(0, 1))] }); continue; }
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      coverage.tokenFiles.unsupported.push({ id: record.file, reason: 'token document root must be an object', evidence: [evidenceAt(record, record.text.slice(0, 1))] }); continue;
    }
    coverage.tokenFiles.extracted.push(record.file);
    function visit(value, parts, inheritedType) {
      const name = parts.join('.');
      if (value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, '$value')) {
        coverage.tokens.eligible.push(name); coverage.tokens.extracted.push(name);
        tokens.push({ name, ...(value.$type ?? inheritedType ? { type: value.$type ?? inheritedType } : {}), value: value.$value, evidence: [jsonPathEvidence(record, locations, parts)] }); return;
      }
      if (value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'value') && (Object.hasOwn(value, 'type') || Object.keys(value).every((key) => ['value', 'type', 'description'].includes(key)))) {
        coverage.tokens.eligible.push(name); coverage.tokens.extracted.push(name);
        tokens.push({ name, ...(value.type ?? inheritedType ? { type: value.type ?? inheritedType } : {}), value: value.value, evidence: [jsonPathEvidence(record, locations, parts)] }); return;
      }
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const nextType = value.$type ?? inheritedType;
        for (const key of Object.keys(value).filter((key) => !key.startsWith('$')).sort()) visit(value[key], [...parts, key], nextType);
        return;
      }
      if (parts.length) {
        coverage.tokens.eligible.push(name); coverage.tokens.extracted.push(name);
        tokens.push({ name, ...(inheritedType ? { type: inheritedType } : {}), value, evidence: [jsonPathEvidence(record, locations, parts)] });
      }
    }
    visit(json, [], undefined);
  }
  const seen = new Map();
  for (const token of tokens) {
    if (seen.has(token.name)) issues.push({ id: `token-duplicate:${token.name}`, reason: `duplicate token name: ${token.name}`, evidence: [...seen.get(token.name).evidence, ...token.evidence] });
    else seen.set(token.name, token);
  }
  return tokens.sort((a, b) => compareText(a.name, b.name));
}

export async function extractSnapshot(root, ts) {
  demand(ts?.version === '5.9.3' && typeof ts.createProgram === 'function', 'extractSnapshot requires the trusted TypeScript 5.9.3 API object');
  const scope = await admitFiles(root); const packageRecord = scope.admitted.get('package.json');
  demand(packageRecord && packageRecord.text !== null, 'Snapshot requires a UTF-8 package.json');
  let manifest;
  try { manifest = JSON.parse(packageRecord.text); } catch (error) { throw new Error(`Invalid package.json: ${error.message}`); }
  demand(typeof manifest.name === 'string' && manifest.name && typeof manifest.version === 'string' && manifest.version, 'package.json requires name and version');
  const declared = collectTypeEntrypoints(manifest); const entrypoints = [];
  const contradiction = declared.unsupported.find((item) => item.reason.startsWith('contradictory declared type entrypoints'));
  demand(!contradiction, contradiction?.reason);
  if (!declared.declared) {
    const fallback = scope.admitted.get('index.d.ts');
    demand(fallback && fallback.text !== null, 'No declared type entrypoint and root index.d.ts fallback is missing');
    declared.entries.set('.', 'index.d.ts');
  }
  for (const [name, file] of declared.entries) {
    relativePath(file); const record = scope.admitted.get(file);
    demand(record && record.text !== null, `Declared type entrypoint is missing or not UTF-8: ${file}`);
    entrypoints.push({ name, file });
  }
  entrypoints.sort((a, b) => compareText(a.name, b.name) || compareText(a.file, b.file));
  const program = createProgram(ts, scope.admitted, entrypoints.map((entry) => entry.file)); const checker = program.getTypeChecker();
  const syntaxDiagnostics = program.getSyntacticDiagnostics();
  const coverage = { entrypoints: coverageCollection(), exports: coverageCollection(), propSurfaces: coverageCollection(), tokenFiles: coverageCollection(), tokens: coverageCollection(), documentationFiles: coverageCollection(), excludedFiles: [...scope.excludedFiles] };
  const issues = []; const exports = [];
  for (const item of declared.unsupported) {
    const evidence = [evidenceAt(packageRecord, '"exports"')];
    coverage.entrypoints.eligible.push(item.name);
    coverage.entrypoints.unsupported.push({ id: item.name, reason: item.reason, evidence });
    issues.push({ id: `entrypoint:${digest(item.name + ':' + item.reason).slice(0, 16)}`, reason: item.reason, evidence });
  }
  for (const diagnostic of syntaxDiagnostics) {
    const record = diagnostic.file ? scope.admitted.get(path.relative('/', diagnostic.file.fileName).split(path.sep).join('/')) : packageRecord;
    const reportedStart = diagnostic.start ?? 0; const length = Math.max(1, diagnostic.length ?? 1);
    let evidence = [];
    if (record?.text.length) {
      const start = Math.min(Math.max(0, reportedStart), record.text.length - 1);
      const end = Math.min(record.text.length, Math.max(start + 1, reportedStart + length));
      evidence = [{ file: record.file, sha256: record.sha256, ...lineRange(record.text, start, end), quote: record.text.slice(start, end) }];
    } else evidence = [evidenceAt(packageRecord, '"types"')];
    issues.push({ id: `syntax:${record?.file ?? 'snapshot'}:${reportedStart}`, reason: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'), evidence });
  }
  if (syntaxDiagnostics.length) for (const entry of entrypoints) {
    const id = `${entry.name}#*`; const record = scope.admitted.get(entry.file); const evidence = [evidenceAt(record, record.text.slice(0, 1))];
    coverage.exports.eligible.push(id);
    coverage.exports.unsupported.push({ id, reason: 'snapshot syntax diagnostics make export absence and recovered declarations non-authoritative', evidence });
  }
  for (const source of program.getSourceFiles()) {
    const record = scope.admitted.get(path.relative('/', source.fileName).split(path.sep).join('/')); if (!record) continue;
    for (const statement of source.statements) {
      if (ts.isExportAssignment(statement)) {
        const id = `unsupported-export:${record.file}:${statement.getStart(source)}`; const evidence = [evidenceFor(record, statement)];
        coverage.exports.eligible.push(id); coverage.exports.unsupported.push({ id, reason: 'export assignment is outside supported static named exports', evidence });
        issues.push({ id, reason: 'export assignment is outside supported static named exports', evidence });
      }
      if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      const resolved = checker.getSymbolAtLocation(statement.moduleSpecifier);
      if (specifier.startsWith('.') && resolved) continue;
      const names = statement.exportClause && ts.isNamedExports(statement.exportClause)
        ? statement.exportClause.elements.map((element) => element.name.text) : ['*'];
      for (const name of names) {
        const id = `unsupported-export:${record.file}:${name}`; const evidence = [evidenceFor(record, statement)];
        const reason = specifier.startsWith('.') ? `unresolved local re-export: ${specifier}` : `external re-export is unsupported: ${specifier}`;
        coverage.exports.eligible.push(id); coverage.exports.unsupported.push({ id, reason, evidence }); issues.push({ id, reason, evidence });
      }
    }
  }
  for (const entry of entrypoints) {
    const entryId = `${entry.name}:${entry.file}`; coverage.entrypoints.eligible.push(entryId); coverage.entrypoints.extracted.push(entryId);
    const source = program.getSourceFile('/' + entry.file); const record = scope.admitted.get(entry.file);
    if (!source?.symbol) { const evidence = [evidenceAt(record, record.text.slice(0, 1))]; coverage.exports.eligible.push(`${entry.name}#*`); coverage.exports.unsupported.push({ id: `${entry.name}#*`, reason: 'entrypoint has no module exports', evidence }); issues.push({ id: `empty-entrypoint:${entryId}`, reason: 'entrypoint has no module exports', evidence }); continue; }
    const symbols = checker.getExportsOfModule(source.symbol).sort((a, b) => compareText(a.name, b.name));
    if (!symbols.length) {
      const explicitEmpty = source.statements.some((statement) => ts.isExportDeclaration(statement)
        && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause) && statement.exportClause.elements.length === 0);
      if (!explicitEmpty) {
        const evidence = [evidenceAt(record, record.text.slice(0, 1))]; coverage.exports.eligible.push(`${entry.name}#*`);
        coverage.exports.unsupported.push({ id: `${entry.name}#*`, reason: 'entrypoint exports no symbols', evidence });
        issues.push({ id: `empty-entrypoint:${entryId}`, reason: 'entrypoint exports no symbols', evidence });
      }
    }
    for (const exposed of symbols) {
      if (exposed.name === 'default' && exposed.flags & ts.SymbolFlags.Namespace) continue;
      const symbol = resolveAlias(ts, checker, exposed); const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
      const exportId = `${entry.name}#${exposed.name}`; coverage.exports.eligible.push(exportId);
      if (!declaration) { const evidence = [evidenceAt(record, exposed.name)]; coverage.exports.unsupported.push({ id: exportId, reason: 'export declaration could not be resolved locally', evidence }); issues.push({ id: `export-unresolved:${exportId}`, reason: 'export declaration could not be resolved locally', evidence }); continue; }
      const declarationFile = declarationRecord(scope.admitted, declaration);
      if (!declarationFile) { const evidence = [evidenceAt(record, exposed.name)]; coverage.exports.unsupported.push({ id: exportId, reason: 'export resolves outside snapshot boundary', evidence }); issues.push({ id: `export-external:${exportId}`, reason: 'export resolves outside snapshot boundary', evidence }); continue; }
      const publicEvidence = [];
      for (const node of exposed.declarations ?? []) {
        const exposedRecord = declarationRecord(scope.admitted, node);
        if (exposedRecord) publicEvidence.push(evidenceFor(exposedRecord, node));
      }
      for (const statement of source.statements) {
        if (!ts.isExportDeclaration(statement) || statement.exportClause || !statement.moduleSpecifier) continue;
        const moduleSymbol = checker.getSymbolAtLocation(statement.moduleSpecifier);
        if (moduleSymbol && checker.getExportsOfModule(moduleSymbol).some((candidate) => candidate.name === exposed.name)) {
          publicEvidence.push(evidenceFor(record, statement));
        }
      }
      const declarationEvidence = evidenceFor(declarationFile, declaration);
      const evidence = [...new Map([...publicEvidence, declarationEvidence].map((item) => [`${item.file}:${item.startLine}:${item.endLine}:${item.quote}`, item])).values()];
      const docs = docsFor(ts, declarationFile, declaration);
      if (docs) { coverage.documentationFiles.eligible.push(declarationFile.file); coverage.documentationFiles.extracted.push(declarationFile.file); }
      const propSource = propsDeclaration(ts, checker, declaration);
      let kind = 'type';
      if (symbol.flags & ts.SymbolFlags.Value) kind = propSource ? 'component' : ts.isFunctionDeclaration(declaration) ? 'function' : ts.isClassDeclaration(declaration) ? 'class' : 'value';
      const item = { name: exposed.name, entrypoint: entry.name, kind, props: [], ...(docs ? { docs } : {}), evidence, ...(syntaxDiagnostics.length ? { incomplete: true } : {}) };
      if (syntaxDiagnostics.length) coverage.exports.unsupported.push({ id: exportId, reason: 'export was recovered from a snapshot with syntax diagnostics', evidence });
      if (propSource) {
        const localIssues = []; const types = normalizer(ts, checker, scope.admitted, localIssues, evidence);
        const extracted = propMembers(ts, checker, propSource.type, propSource.parameter, types.normalize, scope.admitted);
        if (extracted.unsupported) {
          item.incomplete = true; coverage.propSurfaces.eligible.push(`${exportId}#*`); coverage.propSurfaces.unsupported.push({ id: `${exportId}#*`, reason: extracted.unsupported, evidence }); issues.push({ id: `props:${exportId}`, reason: extracted.unsupported, evidence });
        } else for (const prop of extracted.props) {
          const propId = `${exportId}.${prop.name}`; coverage.propSurfaces.eligible.push(propId);
          if (prop.unsupported) { item.incomplete = true; coverage.propSurfaces.unsupported.push({ id: propId, reason: prop.unsupported.reason, evidence: prop.unsupported.evidence }); delete prop.unsupported; }
          else coverage.propSurfaces.extracted.push(propId);
          if (prop.docs) for (const propEvidence of prop.evidence) {
            coverage.documentationFiles.eligible.push(propEvidence.file); coverage.documentationFiles.extracted.push(propEvidence.file);
          }
          item.props.push(prop);
        }
        issues.push(...localIssues);
      }
      coverage.exports.extracted.push(exportId); exports.push(item);
    }
  }
  const documents = [];
  for (const record of [...scope.admitted.values()].filter((item) => item.text !== null && markdownSelected(item.file)).sort((a, b) => compareText(a.file, b.file))) {
    coverage.documentationFiles.eligible.push(record.file); coverage.documentationFiles.extracted.push(record.file);
    documents.push({ file: record.file, sha256: record.sha256, text: record.text });
  }
  const tokens = extractTokens(scope.admitted, coverage, issues);
  const selected = new Set(['package.json', ...program.getSourceFiles().map((source) => path.relative('/', source.fileName).split(path.sep).join('/')), ...documents.map((document) => document.file), ...[...scope.admitted.keys()].filter(tokenSelected)]);
  for (const file of scope.admitted.keys()) if (!selected.has(file) && !scope.excludedFiles.some((item) => item.file === file)) coverage.excludedFiles.push({ file, reason: 'not selected as package metadata, type entrypoint, token data, or documentation' });
  for (const collection of ['entrypoints', 'exports', 'propSurfaces', 'tokenFiles', 'tokens', 'documentationFiles']) {
    coverage[collection].eligible = uniqueSorted(coverage[collection].eligible); coverage[collection].extracted = uniqueSorted(coverage[collection].extracted);
    coverage[collection].unsupported.sort((a, b) => compareText(a.id, b.id));
  }
  coverage.excludedFiles.sort((a, b) => compareText(a.file, b.file));
  const files = [...scope.admitted.values()].filter((record) => record.text !== null && selected.has(record.file))
    .map(({ file, sha256, text }) => ({ file, sha256, text })).sort((a, b) => compareText(a.file, b.file));
  const finalScope = await admitFiles(scope.root);
  demand(finalScope.digest === scope.digest && jsonDigest(finalScope.excludedFiles) === jsonDigest(scope.excludedFiles), 'Snapshot files changed during extraction');
  return { identity: { name: manifest.name, version: manifest.version, digest: scope.digest, entrypoints }, exports: exports.sort((a, b) => compareText(a.entrypoint, b.entrypoint) || compareText(a.name, b.name)), tokens, documents,
    issues: [...new Map(issues.map((issue) => [issue.id, issue])).values()].sort((a, b) => compareText(a.id, b.id)), coverage, files };
}
