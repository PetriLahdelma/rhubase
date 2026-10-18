import path from 'node:path';
import { digest } from './files.mjs';
import { walk } from './source-analysis.mjs';

const MAX_PACKETS = 256;
const MAX_LINKS = 4096;
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;

function evidence(record, node) {
  const start = node.getStart(record.source); const end = node.end;
  return {
    scope: 'consumer', file: record.file, sha256: record.sha256,
    startLine: record.source.getLineAndCharacterOfPosition(start).line + 1,
    endLine: record.source.getLineAndCharacterOfPosition(end).line + 1,
    quote: record.text.slice(start, end),
  };
}

function ancestor(node, predicate) {
  for (let current = node; current; current = current.parent) if (predicate(current)) return current;
  return null;
}

function unwrap(ts, node) {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function jsxOpening(ts, node) {
  const body = unwrap(ts, node);
  if (ts.isJsxSelfClosingElement(body)) return body;
  if (ts.isJsxElement(body)) return body.openingElement;
  return null;
}

function strictRelativeModule(records, containing, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(containing), specifier));
  if (base === '..' || base.startsWith('../')) return null;
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mts`, `${base}.cts`, `${base}.mjs`, `${base}.cjs`,
    `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`, `${base}/index.jsx`, `${base}/index.mts`, `${base}/index.cts`]
    .filter((candidate, index, values) => values.indexOf(candidate) === index && records.has(candidate));
  return candidates.length === 1 ? candidates[0] : null;
}

function namedImport(ts, declaration) {
  if (!ts.isImportSpecifier(declaration) || declaration.isTypeOnly) return null;
  const importDeclaration = ancestor(declaration, ts.isImportDeclaration);
  if (!importDeclaration || !ts.isStringLiteral(importDeclaration.moduleSpecifier)) return null;
  return {
    local: declaration.name.text,
    imported: declaration.propertyName?.text ?? declaration.name.text,
    module: importDeclaration.moduleSpecifier.text,
    node: importDeclaration,
  };
}

function sourceBinding(ts, checker, opening, record, usage, sourcePackages) {
  if (!ts.isIdentifier(opening.tagName)) return null;
  const declarations = checker.getSymbolAtLocation(opening.tagName)?.declarations ?? [];
  const imports = declarations.map((item) => namedImport(ts, item)).filter(Boolean).filter((item) => !item.module.startsWith('.'));
  if (imports.length !== 1) return null;
  const binding = imports[0];
  const source = sourcePackages.find((item) => item.id === usage.sourceId);
  if (!source || binding.module !== source.importName || binding.module !== usage.module || binding.imported !== usage.export) return null;
  return { source, bindingEvidence: evidence(record, binding.node) };
}

function topLevelCandidate(ts, checker, record, statement, usagesByLocation, usagesByFile, sourcePackages) {
  if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)
    || statement.declarationList.declarations.length !== 1
    || !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return null;
  const declaration = statement.declarationList.declarations[0];
  if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !ts.isArrowFunction(declaration.initializer)) return null;
  const opening = jsxOpening(ts, declaration.initializer.body); if (!opening) return null;
  const bodyStart = declaration.initializer.body.getStart(record.source); const bodyEnd = declaration.initializer.body.end;
  const enclosed = (usagesByFile.get(record.file) ?? []).filter((usage) => usage.start >= bodyStart && usage.end <= bodyEnd);
  if (enclosed.length !== 1) return null;
  const start = opening.getStart(record.source); const inner = usagesByLocation.get(`${record.file}:${start}`) ?? [];
  if (inner.length !== 1 || inner[0].id !== enclosed[0].id) return null;
  const selected = sourceBinding(ts, checker, opening, record, inner[0], sourcePackages); if (!selected) return null;
  return {
    file: record.file, name: declaration.name.text, declaration, statement, innerUsage: inner[0], source: selected.source,
    definitionEvidence: evidence(record, statement), sourceBindingEvidence: selected.bindingEvidence,
  };
}

function directCandidate(candidates, file, name) {
  const matches = candidates.filter((item) => item.file === file && item.name === name);
  return matches.length === 1 ? { candidate: matches[0], binding: [] } : null;
}

function exportClaims(ts, record, name) {
  let count = 0; let hasStar = false;
  for (const statement of record.source.statements) {
    const exported = statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    if (exported && ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) count += 1;
    }
    if (exported && (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name) count += 1;
    if (!ts.isExportDeclaration(statement)) continue;
    if (!statement.exportClause) { hasStar = true; continue; }
    if (ts.isNamedExports(statement.exportClause)) count += statement.exportClause.elements.filter((specifier) => !specifier.isTypeOnly && specifier.name.text === name).length;
  }
  return { count, hasStar };
}

function resolveImportedCandidate(ts, records, candidates, containing, imported) {
  const target = strictRelativeModule(records, containing, imported.module); if (!target) return null;
  const targetRecord = records.get(target); const claims = exportClaims(ts, targetRecord, imported.imported);
  if (claims.hasStar || claims.count !== 1) return null;
  const direct = directCandidate(candidates, target, imported.imported);
  if (direct) return { ...direct, binding: [imported.node] };
  const matches = [];
  for (const statement of targetRecord.source.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause || !ts.isNamedExports(statement.exportClause)
      || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    for (const specifier of statement.exportClause.elements) {
      if (specifier.isTypeOnly || specifier.name.text !== imported.imported) continue;
      const sourceFile = strictRelativeModule(records, target, statement.moduleSpecifier.text); if (!sourceFile) continue;
      const candidate = directCandidate(candidates, sourceFile, specifier.propertyName?.text ?? specifier.name.text);
      if (candidate) matches.push({ candidate: candidate.candidate, binding: [imported.node, statement] });
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

function resolveCall(ts, checker, records, candidates, record, opening) {
  if (!ts.isIdentifier(opening.tagName)) return null;
  const declarations = checker.getSymbolAtLocation(opening.tagName)?.declarations ?? [];
  const local = declarations.filter((item) => ts.isVariableDeclaration(item) && item.getSourceFile() === record.source);
  if (local.length === 1) {
    const candidate = candidates.find((item) => item.declaration === local[0]);
    return candidate ? { candidate, bindingEvidence: [] } : null;
  }
  const imports = declarations.map((item) => namedImport(ts, item)).filter(Boolean).filter((item) => item.module.startsWith('.'));
  if (imports.length !== 1) return null;
  const resolved = resolveImportedCandidate(ts, records, candidates, record.file, imports[0]);
  return resolved ? { candidate: resolved.candidate, bindingEvidence: resolved.binding.map((node) => evidence(records.get(node.getSourceFile().fileName), node)) } : null;
}

function tuple(item) { return [item.file, item.sha256, item.startLine, item.endLine, item.quote]; }
function sortedUniqueEvidence(items) {
  const byTuple = new Map(items.map((item) => [JSON.stringify(tuple(item)), item]));
  return [...byTuple.entries()].sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right))).map(([, item]) => item);
}

export function buildWrapperInvestigations({ ts, records, checker, usages, unsupported, sourcePackages, sourceDigests }) {
  if (!sourceDigests) return [];
  const usagesByLocation = new Map(); const usagesByFile = new Map(); const openingsByLocation = new Map();
  for (const usage of usages) {
    const key = `${usage.file}:${usage.start}`; const values = usagesByLocation.get(key) ?? []; values.push(usage); usagesByLocation.set(key, values);
    const fileValues = usagesByFile.get(usage.file) ?? []; fileValues.push(usage); usagesByFile.set(usage.file, fileValues);
  }
  for (const record of records.values()) walk(ts, record.source, (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) openingsByLocation.set(`${record.file}:${node.getStart(record.source)}`, node);
  });
  const candidates = [];
  for (const record of records.values()) for (const statement of record.source.statements) {
    const candidate = topLevelCandidate(ts, checker, record, statement, usagesByLocation, usagesByFile, sourcePackages);
    if (candidate) candidates.push(candidate);
  }
  candidates.sort((left, right) => compareText(left.source.id, right.source.id) || compareText(left.file, right.file) || compareText(left.name, right.name));
  const candidateSet = candidates.slice(0, MAX_PACKETS);
  const packetData = new Map(candidateSet.map((candidate) => [candidate, { candidate, links: [] }]));
  const allowed = unsupported.filter((item) => ['wrapper-usage', 'local-reexport-resolution', 'factory-or-alias'].includes(item.kind) && item.file && Number.isInteger(item.start));
  let links = 0;
  for (const unknown of allowed) {
    if (links >= MAX_LINKS) break;
    const record = records.get(unknown.file); if (!record) continue;
    const opening = openingsByLocation.get(`${unknown.file}:${unknown.start}`);
    if (!opening) continue;
    const resolved = resolveCall(ts, checker, records, candidateSet, record, opening); if (!resolved) continue;
    packetData.get(resolved.candidate).links.push({ unknown, bindingEvidence: resolved.bindingEvidence }); links += 1;
  }
  const packets = [];
  for (const { candidate, links: candidateLinks } of packetData.values()) {
    if (!candidateLinks.length) continue;
    const sourceDigest = sourceDigests instanceof Map ? sourceDigests.get(candidate.source.id) : sourceDigests[candidate.source.id];
    if (!/^[0-9a-f]{64}$/.test(sourceDigest ?? '')) continue;
    const unknownIds = [...new Set(candidateLinks.map((item) => item.unknown.id))].sort(compareText);
    const bindingEvidence = sortedUniqueEvidence([candidate.sourceBindingEvidence, ...candidateLinks.flatMap((item) => item.bindingEvidence)]);
    const callSiteEvidence = sortedUniqueEvidence(candidateLinks.flatMap((item) => item.unknown.evidence ?? []));
    const definitionTuple = tuple(candidate.definitionEvidence);
    const id = `wrapper:${digest(JSON.stringify([candidate.source.id, candidate.innerUsage.export, candidate.file, candidate.name])).slice(0, 20)}`;
    const revision = digest(JSON.stringify([sourceDigest, definitionTuple, bindingEvidence.map(tuple), unknownIds, callSiteEvidence.map(tuple)]));
    packets.push({
      id, revision, sourceId: candidate.source.id, sourceExport: candidate.innerUsage.export,
      definition: { file: candidate.file, name: candidate.name, evidence: [candidate.definitionEvidence] },
      innerUsageIds: [candidate.innerUsage.id], unknownIds, bindingEvidence,
      status: 'needs-review', executable: false,
    });
  }
  return packets.sort((left, right) => compareText(left.sourceId, right.sourceId) || compareText(left.sourceExport, right.sourceExport) || compareText(left.definition.file, right.definition.file) || compareText(left.definition.name, right.definition.name));
}
