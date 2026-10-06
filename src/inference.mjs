import * as fs from 'node:fs/promises';
import { digest, demand } from './files.mjs';
import { loadCompiler } from './source-analysis.mjs';
import { extractSnapshot } from './snapshot-api.mjs';

const CHANGE_ORDER = [
  'export-removed', 'export-added', 'prop-removed', 'prop-added', 'prop-type-changed',
  'prop-requiredness-changed', 'prop-default-changed', 'prop-literals-changed',
  'token-removed', 'token-added', 'token-value-changed', 'token-type-changed',
];
const PROPOSAL_ORDER = ['component-rename', 'component-split', 'prop-rename', 'prop-value-rename', 'token-rename'];
const COLLECTIONS = ['entrypoints', 'exports', 'propSurfaces', 'tokenFiles', 'tokens', 'documentationFiles'];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
const canonicalJson = (value) => JSON.stringify(canonical(value));
const equal = (left, right) => canonicalJson(left) === canonicalJson(right);
const unique = (items) => [...new Map(items.map((item) => [canonicalJson(item), item])).values()];
const exportKey = (item) => `${item.entrypoint}#${item.name}`;
const publicExportName = (item) => item.entrypoint === '.' ? item.name : `${item.entrypoint}#${item.name}`;
const refKey = (value) => canonicalJson(value);
const idFor = (prefix, value) => `${prefix}:${digest(canonicalJson(value)).slice(0, 20)}`;

function decorateEvidence(evidence, snapshot) {
  return (evidence ?? []).map((item) => ({ snapshot, ...item }));
}

function decoratedCoverage(snapshot, side) {
  const result = structuredClone(snapshot.coverage);
  for (const name of COLLECTIONS) {
    result[name].unsupported = result[name].unsupported.map((item) => ({ ...item, evidence: decorateEvidence(item.evidence, side) }));
  }
  return result;
}

function change(kind, values) {
  const core = { kind, ...values };
  return { id: idFor('change', core), ...core };
}

function proposal(kind, values) {
  const core = { kind, ...values, status: 'needs-review', executable: false };
  return { id: idFor('proposal', core), ...core };
}

function sortChanges(changes) {
  return changes.sort((a, b) => CHANGE_ORDER.indexOf(a.kind) - CHANGE_ORDER.indexOf(b.kind)
    || (a.export ?? '').localeCompare(b.export ?? '') || (a.prop ?? '').localeCompare(b.prop ?? '')
    || (a.token ?? '').localeCompare(b.token ?? '') || a.id.localeCompare(b.id));
}

function sortProposals(proposals) {
  return proposals.sort((a, b) => PROPOSAL_ORDER.indexOf(a.kind) - PROPOSAL_ORDER.indexOf(b.kind)
    || refKey(a.source).localeCompare(refKey(b.source)) || a.id.localeCompare(b.id));
}

function safeExportAbsence(snapshot, item) {
  if (snapshot.coverage.entrypoints.unsupported.length) return false;
  const entryExists = snapshot.identity.entrypoints.some((entry) => entry.name === item.entrypoint);
  if (!entryExists) return true;
  return !snapshot.coverage.exports.unsupported.some((entry) => entry.id === `${item.entrypoint}#*` || entry.id === `${item.entrypoint}#${item.name}`);
}

function propValue(item) {
  return {
    type: item.type, required: item.required,
    ...(item.literals ? { literals: item.literals } : {}),
    ...(item.default?.known ? { default: item.default.value } : {}),
  };
}

function splitTopLevelUnion(type) {
  const parts = []; let start = 0; let depth = 0; let quote = null; let escaped = false;
  for (let index = 0; index < type.length; index += 1) {
    const char = type[index];
    if (quote) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === quote) quote = null; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if ('({[<'.includes(char)) depth += 1; else if (')}]>'.includes(char)) depth -= 1;
    else if (char === '|' && depth === 0) { parts.push(type.slice(start, index).trim()); start = index + 1; }
  }
  parts.push(type.slice(start).trim()); return parts.filter(Boolean);
}

function comparableType(item, other) {
  const literalTypes = new Set((item.literals ?? []).map((value) => canonicalJson(value)));
  let parts = splitTopLevelUnion(item.type).filter((part) => !literalTypes.has(part));
  if (item.required && !other.required) parts = parts.filter((part) => part !== 'undefined');
  return parts.sort().join(' | ');
}

function compareExports(from, to) {
  const changes = []; const unresolved = [];
  const syntaxUnsafe = from.issues.some((item) => item.id.startsWith('syntax:')) || to.issues.some((item) => item.id.startsWith('syntax:'));
  const unsupportedOldProps = new Set(from.coverage.propSurfaces.unsupported.map((item) => item.id));
  const unsupportedNewProps = new Set(to.coverage.propSurfaces.unsupported.map((item) => item.id));
  const oldExports = new Map(from.exports.map((item) => [exportKey(item), item]));
  const newExports = new Map(to.exports.map((item) => [exportKey(item), item]));
  for (const [key, item] of oldExports) if (!newExports.has(key) && safeExportAbsence(to, item)) {
    changes.push(change('export-removed', { export: publicExportName(item), before: { entrypoint: item.entrypoint, kind: item.kind }, evidence: decorateEvidence(item.evidence, 'from') }));
  }
  for (const [key, item] of newExports) if (!oldExports.has(key) && safeExportAbsence(from, item)) {
    changes.push(change('export-added', { export: publicExportName(item), after: { entrypoint: item.entrypoint, kind: item.kind }, evidence: decorateEvidence(item.evidence, 'to') }));
  }
  for (const [key, oldItem] of oldExports) {
    const newItem = newExports.get(key);
    if (!newItem) continue;
    if (syntaxUnsafe) continue;
    if (oldItem.kind !== newItem.kind) {
      unresolved.push({ kind: 'export-kind-changed', source: { export: publicExportName(oldItem) }, reason: `Export kind changed from ${oldItem.kind} to ${newItem.kind}; no supported change fact represents this safely.`, evidence: [...decorateEvidence(oldItem.evidence, 'from'), ...decorateEvidence(newItem.evidence, 'to')] });
      continue;
    }
    if (oldItem.kind !== 'component') continue;
    const oldProps = new Map(oldItem.props.map((item) => [item.name, item]));
    const newProps = new Map(newItem.props.map((item) => [item.name, item]));
    const unsupported = (item, name, collection) => collection.has(`${item.entrypoint}#${item.name}.${name}`);
    for (const [name, item] of oldProps) if (!newProps.has(name) && !newItem.incomplete && !unsupported(oldItem, name, unsupportedOldProps) && !unsupported(newItem, name, unsupportedNewProps)) {
      changes.push(change('prop-removed', { export: publicExportName(oldItem), prop: name, before: propValue(item), evidence: decorateEvidence(item.evidence, 'from') }));
    }
    for (const [name, item] of newProps) if (!oldProps.has(name) && !oldItem.incomplete && !unsupported(newItem, name, unsupportedNewProps) && !unsupported(oldItem, name, unsupportedOldProps)) {
      changes.push(change('prop-added', { export: publicExportName(newItem), prop: name, after: propValue(item), evidence: decorateEvidence(item.evidence, 'to') }));
    }
    for (const [name, oldProp] of oldProps) {
      const newProp = newProps.get(name); if (!newProp) continue;
      if (unsupported(oldItem, name, unsupportedOldProps) || unsupported(newItem, name, unsupportedNewProps)) continue;
      const evidence = [...decorateEvidence(oldProp.evidence, 'from'), ...decorateEvidence(newProp.evidence, 'to')];
      if (!equal(oldProp.literals ?? [], newProp.literals ?? [])) {
        changes.push(change('prop-literals-changed', { export: publicExportName(oldItem), prop: name, before: oldProp.literals ?? [], after: newProp.literals ?? [], evidence }));
      }
      if (comparableType(oldProp, newProp) !== comparableType(newProp, oldProp)) {
        changes.push(change('prop-type-changed', { export: publicExportName(oldItem), prop: name, before: oldProp.type, after: newProp.type, evidence }));
      }
      if (oldProp.required !== newProp.required) {
        changes.push(change('prop-requiredness-changed', { export: publicExportName(oldItem), prop: name, before: oldProp.required, after: newProp.required, evidence }));
      }
      if (oldProp.default?.known && newProp.default?.known && !equal(oldProp.default.value, newProp.default.value)) {
        changes.push(change('prop-default-changed', {
          export: publicExportName(oldItem), prop: name,
          before: oldProp.default.value,
          after: newProp.default.value,
          evidence,
        }));
      } else if (Boolean(oldProp.default?.known) !== Boolean(newProp.default?.known)) {
        unresolved.push({ kind: 'default-knowledge-incomplete', source: { export: publicExportName(oldItem), prop: name }, reason: 'A static default is known on only one snapshot, so a default change cannot be asserted safely.', evidence });
      }
    }
  }
  return { changes, unresolved };
}

function compareTokens(from, to) {
  const changes = [];
  const oldTokens = new Map(from.tokens.map((item) => [item.name, item]));
  const newTokens = new Map(to.tokens.map((item) => [item.name, item]));
  const oldDuplicates = new Set(from.issues.filter((item) => item.id.startsWith('token-duplicate:')).map((item) => item.id.slice('token-duplicate:'.length)));
  const newDuplicates = new Set(to.issues.filter((item) => item.id.startsWith('token-duplicate:')).map((item) => item.id.slice('token-duplicate:'.length)));
  const excluded = (name) => oldDuplicates.has(name) || newDuplicates.has(name);
  const oldComplete = from.coverage.tokenFiles.unsupported.length === 0;
  const newComplete = to.coverage.tokenFiles.unsupported.length === 0;
  for (const [name, item] of oldTokens) if (!excluded(name) && !newTokens.has(name) && newComplete) {
    changes.push(change('token-removed', { token: name, before: { value: item.value, type: item.type ?? null }, evidence: decorateEvidence(item.evidence, 'from') }));
  }
  for (const [name, item] of newTokens) if (!excluded(name) && !oldTokens.has(name) && oldComplete) {
    changes.push(change('token-added', { token: name, after: { value: item.value, type: item.type ?? null }, evidence: decorateEvidence(item.evidence, 'to') }));
  }
  for (const [name, oldToken] of oldTokens) {
    if (excluded(name)) continue;
    const newToken = newTokens.get(name); if (!newToken) continue;
    const evidence = [...decorateEvidence(oldToken.evidence, 'from'), ...decorateEvidence(newToken.evidence, 'to')];
    if (!equal(oldToken.value, newToken.value)) changes.push(change('token-value-changed', { token: name, before: oldToken.value, after: newToken.value, evidence }));
    if ((oldToken.type ?? null) !== (newToken.type ?? null)) changes.push(change('token-type-changed', { token: name, before: oldToken.type ?? null, after: newToken.type ?? null, evidence }));
  }
  return changes;
}

function evidenceFromQuote(snapshot, side, file, quote) {
  const record = snapshot.files.find((item) => item.file === file);
  if (!record || !quote) return [];
  const start = record.text.indexOf(quote); if (start < 0) return [];
  const end = start + quote.length;
  return [{ snapshot: side, file, sha256: record.sha256, startLine: record.text.slice(0, start).split('\n').length, endLine: record.text.slice(0, end).split('\n').length, quote }];
}

function evidenceFromKnownFiles(snapshot, side, candidates, quote) {
  for (const file of unique((candidates ?? []).map((item) => item.file).filter(Boolean))) {
    const evidence = evidenceFromQuote(snapshot, side, file, quote);
    if (evidence.length) return evidence;
  }
  return [];
}

function docSegments(snapshot, side) {
  const segments = [];
  for (const document of snapshot.documents) {
    let fence = null;
    for (const line of document.text.split(/\r?\n/)) {
      const text = line.trim(); const marker = text.match(/^(```|~~~)/)?.[1];
      if (marker) { fence = fence === marker ? null : fence ?? marker; continue; }
      if (!fence && text) segments.push({ text, evidence: evidenceFromQuote(snapshot, side, document.file, line) });
    }
  }
  const semanticTags = (docs) => (docs?.tags ?? []).filter((tag) => !['example', 'code'].includes(tag.name.toLowerCase()));
  for (const item of snapshot.exports) {
    const exported = publicExportName(item);
    if (item.docs?.description) segments.push({ text: item.docs.description, sourceHint: { export: exported }, evidence: evidenceFromKnownFiles(snapshot, side, item.evidence, item.docs.description) });
    for (const tag of semanticTags(item.docs)) segments.push({ text: `${tag.name} ${tag.text}`, sourceHint: { export: exported }, evidence: decorateEvidence(tag.evidence, side) });
    for (const prop of item.props) {
      if (prop.docs?.description) segments.push({ text: prop.docs.description, sourceHint: { export: exported, prop: prop.name }, evidence: evidenceFromKnownFiles(snapshot, side, prop.evidence, prop.docs.description) });
      for (const tag of semanticTags(prop.docs)) segments.push({ text: `${tag.name} ${tag.text}`, sourceHint: { export: exported, prop: prop.name }, evidence: decorateEvidence(tag.evidence, side) });
    }
  }
  return segments;
}

function mentions(text, value) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_$])${escaped}(?=$|[^A-Za-z0-9_$])`, 'i').test(text);
}

function mentionSpans(text, value) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expression = new RegExp(`(^|[^A-Za-z0-9_$])(${escaped})(?=$|[^A-Za-z0-9_$])`, 'gi');
  const spans = []; let match;
  while ((match = expression.exec(text))) {
    const start = match.index + match[1].length; spans.push({ start, end: start + match[2].length });
    if (expression.lastIndex === match.index) expression.lastIndex += 1;
  }
  return spans;
}

function formattedLabel(value) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return "[`\\\"'*]*" + escaped + "[`\\\"'*]*";
}

function grammaticalRename(text, oldLabels, newLabels, { allowPropNoun = false } = {}) {
  if (!mappingAssertion(text)) return false;
  for (const oldLabel of oldLabels) for (const newLabel of newLabels) {
    const old = formattedLabel(oldLabel); const next = formattedLabel(newLabel);
    const suffix = allowPropNoun ? '(?:\\s+prop)?' : '(?!\\s+prop\\b)';
    const oldTerm = `(?:the\\s+)?${old}${suffix}`;
    const nextTerm = `(?:the\\s+)?${next}${suffix}`;
    const patterns = [
      `${oldTerm}\\s+(?:(?:was|is)\\s+)?(?:renamed|moved|migrated|changed|mapped)\\s+to\\s+${nextTerm}`,
      `${oldTerm}\\s+(?:(?:was|is)\\s+)?replaced\\s+(?:by|with)\\s+${nextTerm}`,
      `replace\\s+${oldTerm}\\s+with\\s+${nextTerm}`,
      `${nextTerm}\\s+(?:replaces|supersedes)\\s+${oldTerm}`,
      `use\\s+${nextTerm}\\s+(?:instead\\s+of|rather\\s+than|over)\\s+${oldTerm}`,
    ];
    if (patterns.some((pattern) => new RegExp(pattern, 'i').test(text))) return true;
  }
  return false;
}

function mappingAssertion(text) {
  return !/[?]/.test(text) && !/\b(?:not|never|avoid|avoids|avoided|don't|do\s+not|should|could|would|may|might|whether|if)\b/i.test(text);
}

function literalLabels(exportName, prop, value) {
  const raw = String(value); return [`${exportName}.${prop}=${raw}`, `${prop}=${raw}`, raw];
}

function referenceCatalog(from, to, changes) {
  const oldExports = new Map(from.exports.map((item) => [publicExportName(item), item]));
  const newExports = new Map(to.exports.map((item) => [publicExportName(item), item]));
  const oldTokens = new Map(from.tokens.map((item) => [item.name, item]));
  const newTokens = new Map(to.tokens.map((item) => [item.name, item]));
  const newDuplicateTokens = new Set(to.issues.filter((item) => item.id.startsWith('token-duplicate:')).map((item) => item.id.slice('token-duplicate:'.length)));
  const removedExports = new Set(changes.filter((item) => item.kind === 'export-removed').map((item) => item.export));
  const exports = {
    old: changes.filter((item) => item.kind === 'export-removed' && oldExports.get(item.export) && !oldExports.get(item.export).incomplete)
      .map((item) => ({ labels: unique([item.export, oldExports.get(item.export)?.name].filter(Boolean)), ref: { export: item.export }, evidence: decorateEvidence(oldExports.get(item.export)?.evidence, 'from') })),
    new: to.exports.filter((item) => item.kind === 'component' && !item.incomplete).map((item) => ({ labels: unique([publicExportName(item), item.name]), ref: { export: publicExportName(item) }, evidence: decorateEvidence(item.evidence, 'to') })),
  };
  const removedComponentProps = from.exports.filter((item) => removedExports.has(publicExportName(item)) && item.kind === 'component' && !item.incomplete)
    .flatMap((item) => item.props.filter((prop) => from.coverage.propSurfaces.extracted.includes(`${item.entrypoint}#${item.name}.${prop.name}`))
      .map((prop) => ({ labels: [`${publicExportName(item)}.${prop.name}`, `${item.name}.${prop.name}`, prop.name], ref: { export: publicExportName(item), prop: prop.name }, evidence: decorateEvidence(prop.evidence, 'from') })));
  const props = {
    old: unique([...changes.filter((item) => item.kind === 'prop-removed').map((item) => ({ labels: [`${item.export}.${item.prop}`, item.prop], ref: { export: item.export, prop: item.prop }, evidence: decorateEvidence(oldExports.get(item.export)?.props.find((prop) => prop.name === item.prop)?.evidence, 'from') })), ...removedComponentProps]),
    new: to.exports.filter((item) => item.kind === 'component' && !item.incomplete).flatMap((item) => item.props
      .filter((prop) => to.coverage.propSurfaces.extracted.includes(`${item.entrypoint}#${item.name}.${prop.name}`))
      .map((prop) => ({ labels: [`${publicExportName(item)}.${prop.name}`, `${item.name}.${prop.name}`, prop.name], ref: { export: publicExportName(item), prop: prop.name }, evidence: decorateEvidence(prop.evidence, 'to') }))),
  };
  const tokens = {
    old: changes.filter((item) => item.kind === 'token-removed').map((item) => ({ label: item.token, ref: { token: item.token }, evidence: decorateEvidence(oldTokens.get(item.token)?.evidence, 'from') })),
    new: to.tokens.filter((item) => !newDuplicateTokens.has(item.name)).map((item) => ({ label: item.name, ref: { token: item.name }, evidence: decorateEvidence(item.evidence, 'to') })),
  };
  const values = { old: [], new: [] };
  for (const item of changes.filter((candidate) => candidate.kind === 'prop-literals-changed')) {
    for (const value of item.before.filter((previous) => !item.after.some((next) => equal(next, previous)))) values.old.push({ labels: literalLabels(item.export, item.prop, value), ref: { export: item.export, prop: item.prop, value }, evidence: item.evidence.filter((entry) => entry.snapshot === 'from') });
  }
  for (const item of from.exports.filter((entry) => removedExports.has(publicExportName(entry)) && entry.kind === 'component' && !entry.incomplete)) for (const prop of item.props) for (const value of prop.literals ?? []) {
    values.old.push({ labels: literalLabels(publicExportName(item), prop.name, value), ref: { export: publicExportName(item), prop: prop.name, value }, evidence: decorateEvidence(prop.evidence, 'from') });
  }
  for (const item of to.exports.filter((entry) => entry.kind === 'component' && !entry.incomplete)) for (const prop of item.props) for (const value of prop.literals ?? []) {
    values.new.push({ labels: literalLabels(publicExportName(item), prop.name, value), ref: { export: publicExportName(item), prop: prop.name, value }, evidence: decorateEvidence(prop.evidence, 'to') });
  }
  return { exports, props, tokens, values };
}

function mentionedItems(text, items, hint) {
  const matches = items.map((item) => {
    if (hint && Object.entries(hint).some(([key, value]) => item.ref[key] !== value)) return false;
    const spans = (item.labels ?? [item.label]).flatMap((label) => mentionSpans(text, label));
    return spans.length ? { item, spans } : null;
  }).filter(Boolean);
  return matches.filter((match) => match.spans.some((span) => !matches.some((other) => other !== match
    && other.spans.some((candidate) => candidate.start <= span.start && candidate.end >= span.end
      && candidate.end - candidate.start > span.end - span.start)))).map((match) => match.item);
}

function grammaticalSplit(text, source, targets) {
  if (!mappingAssertion(text) || targets.length < 2) return false;
  const sourceSpans = source.labels.flatMap((label) => mentionSpans(text, label));
  const split = text.search(/\b(?:was\s+)?(?:split|divided|extracted)\b.*?\b(?:into|to)\b/i);
  return split >= 0 && sourceSpans.some((span) => span.end <= split)
    && targets.every((target) => target.labels.flatMap((label) => mentionSpans(text, label)).some((span) => span.start > split));
}

function grammaticalConsolidation(text, sources, target) {
  if (!mappingAssertion(text) || sources.length < 2) return false;
  const relation = text.search(/\b(?:was|were)?\s*consolidated\s+(?:into|to)\b/i);
  return relation >= 0
    && sources.every((source) => source.labels.flatMap((label) => mentionSpans(text, label)).some((span) => span.end <= relation))
    && target.labels.flatMap((label) => mentionSpans(text, label)).some((span) => span.start > relation);
}

function documentedComponentRelations(segments, catalog) {
  const relations = [];
  for (const segment of segments) {
    if (!segment.evidence.length) continue;
    const sources = mentionedItems(segment.text, catalog.exports.old, segment.sourceHint);
    const targets = mentionedItems(segment.text, catalog.exports.new);
    if (sources.length > 1 && targets.length === 1 && grammaticalConsolidation(segment.text, sources, targets[0])) {
      for (const source of sources) relations.push({ kind: 'component-rename', source: source.ref.export, target: targets[0].ref.export, evidence: segment.evidence });
    } else if (sources.length === 1 && targets.length === 1 && grammaticalRename(segment.text, sources[0].labels, targets[0].labels)) {
      relations.push({ kind: 'component-rename', source: sources[0].ref.export, target: targets[0].ref.export, evidence: segment.evidence });
    } else if (sources.length === 1 && targets.length > 1 && grammaticalSplit(segment.text, sources[0], targets)) relations.push({ kind: 'component-split', source: sources[0].ref.export, targets: targets.map((item) => item.ref.export), evidence: segment.evidence });
  }
  return relations;
}

function componentRelationState(relations, source) {
  const candidates = relations.filter((item) => item.source === source);
  const identities = new Set(candidates.map((item) => `${item.kind}:${refKey(item.target ?? item.targets)}`));
  if (identities.size !== 1 || candidates[0]?.kind !== 'component-rename') return { status: candidates.length ? 'conflicting' : 'absent', candidates };
  return { status: 'accepted', target: candidates[0].target, candidates };
}

function inferDocumentationProposals(from, to, changes) {
  const catalog = referenceCatalog(from, to, changes); const raw = [];
  const segments = [...docSegments(from, 'from'), ...docSegments(to, 'to')].filter((segment) => mappingAssertion(segment.text));
  const componentRelations = documentedComponentRelations(segments, catalog);
  for (const segment of segments) {
    if (!segment.evidence.length) continue;
    const componentSources = mentionedItems(segment.text, catalog.exports.old, segment.sourceHint);
    const componentTargets = mentionedItems(segment.text, catalog.exports.new);
    const componentRelation = componentSources.length === 1 && componentTargets.length === 1
      && grammaticalRename(segment.text, componentSources[0].labels, componentTargets[0].labels)
      ? { source: componentSources[0].ref.export, target: componentTargets[0].ref.export } : null;
    if (/\buse\b/i.test(segment.text) && segment.sourceHint) {
      for (const [group, kind] of [['exports', 'component-rename'], ['props', 'prop-rename']]) {
        const oldItems = catalog[group].old.filter((item) => Object.entries(segment.sourceHint).every(([key, value]) => item.ref[key] === value));
        const relation = group === 'props' && oldItems.length === 1 ? componentRelationState(componentRelations, oldItems[0].ref.export) : null;
        const targetExport = relation?.status === 'accepted' ? relation.target : oldItems[0]?.ref.export;
        const targetPool = group === 'props' && oldItems.length === 1 ? catalog[group].new.filter((item) => item.ref.export === targetExport) : catalog[group].new;
        const newItems = mentionedItems(segment.text, targetPool);
        if (oldItems.length === 1 && newItems.length === 1 && new RegExp(`\\buse\\s+${formattedLabel((newItems[0].labels ?? [newItems[0].label]).find((label) => mentions(segment.text, label)))}`, 'i').test(segment.text)) {
          const dependency = group === 'props' && oldItems[0].ref.export !== newItems[0].ref.export ? { source: oldItems[0].ref.export, target: newItems[0].ref.export } : null;
          raw.push({ kind, source: oldItems[0].ref, target: newItems[0].ref, basis: 'documentation-explicit', reason: 'Attached deprecation documentation directs callers to an existing new reference.', evidence: unique([...oldItems[0].evidence, ...newItems[0].evidence, ...segment.evidence]), ...(dependency ? { _componentDependency: dependency } : {}) });
        }
      }
    }
    for (const [group, kind] of [['exports', 'component-rename'], ['props', 'prop-rename'], ['values', 'prop-value-rename'], ['tokens', 'token-rename']]) {
      const oldItems = mentionedItems(segment.text, catalog[group].old, segment.sourceHint);
      const globalRelation = ['props', 'values'].includes(group) && oldItems.length === 1 ? componentRelationState(componentRelations, oldItems[0].ref.export) : null;
      const targetExport = ['props', 'values'].includes(group) && oldItems.length === 1
        ? (componentRelation?.source === oldItems[0].ref.export ? componentRelation.target : globalRelation?.status === 'accepted' ? globalRelation.target : null)
        : oldItems[0]?.ref.export;
      const targetPool = ['props', 'values'].includes(group) && oldItems.length === 1
        ? (targetExport ? catalog[group].new.filter((item) => item.ref.export === targetExport) : catalog[group].new) : catalog[group].new;
      const newItems = mentionedItems(segment.text, targetPool);
      if (group === 'exports' && oldItems.length > 1 && newItems.length === 1 && grammaticalConsolidation(segment.text, oldItems, newItems[0])) {
        for (const oldItem of oldItems) raw.push({ kind: 'component-rename', source: oldItem.ref, target: newItems[0].ref, basis: 'documentation-explicit', reason: 'Directional documentation explicitly consolidates enumerated components into one existing target.', evidence: unique([...oldItem.evidence, ...newItems[0].evidence, ...segment.evidence]) });
      }
      if (group === 'exports' && oldItems.length === 1 && newItems.length > 1) {
        if (grammaticalSplit(segment.text, oldItems[0], newItems)) {
          raw.push({ kind: 'component-split', source: oldItems[0].ref, targets: newItems.map((item) => item.ref), basis: 'documentation-explicit', reason: 'Directional documentation describes a component split; each target exists in the new snapshot.', evidence: unique([...oldItems[0].evidence, ...newItems.flatMap((item) => item.evidence), ...segment.evidence]) });
        }
      }
      if (oldItems.length === 1 && newItems.length === 1 && grammaticalRename(segment.text, oldItems[0].labels ?? [oldItems[0].label], newItems[0].labels ?? [newItems[0].label], { allowPropNoun: group === 'props' })) {
        const dependency = ['props', 'values'].includes(group) && oldItems[0].ref.export !== newItems[0].ref.export
          ? { source: oldItems[0].ref.export, target: newItems[0].ref.export } : null;
        raw.push({ kind, source: oldItems[0].ref, target: newItems[0].ref, basis: 'documentation-explicit', reason: 'Directional migration documentation names an existing old reference and existing new reference.', evidence: unique([...oldItems[0].evidence, ...newItems[0].evidence, ...segment.evidence]), ...(dependency ? { _componentDependency: dependency } : {}) });
      }
    }
  }
  const proposals = []; const unresolved = [];
  const dependencyChecked = raw.filter((item) => {
    if (!item._componentDependency) return true;
    const state = componentRelationState(componentRelations, item._componentDependency.source);
    if (state.status === 'accepted' && state.target === item._componentDependency.target) return true;
    unresolved.push({ kind: 'contradictory-mapping', source: item.source, reason: 'Cross-component prop/value documentation lacks one uniquely accepted component relation.', evidence: unique([...item.evidence, ...state.candidates.flatMap((candidate) => candidate.evidence)]) });
    return false;
  });
  for (const items of Map.groupBy(dependencyChecked, (item) => refKey(item.source)).values()) {
    const destinations = new Set(items.map((item) => `${item.kind}:${refKey(item.target ?? item.targets)}`));
    if (destinations.size > 1) {
      unresolved.push({ kind: 'contradictory-mapping', source: items[0].source, reason: 'Directional documentation names conflicting targets; no mapping proposal was selected.', evidence: unique(items.flatMap((item) => item.evidence)) });
      continue;
    }
    const { _componentDependency, ...first } = items[0];
    const merged = { ...first, evidence: unique(items.flatMap((item) => item.evidence)) };
    proposals.push(proposal(merged.kind, merged));
  }
  return { proposals, unresolved };
}

function unresolvedRecords(from, to, changes, proposals, extra) {
  const resolved = new Set(proposals.map((item) => refKey(item.source))); const records = [...extra];
  for (const item of changes) {
    if (['export-removed', 'prop-removed', 'token-removed'].includes(item.kind)) {
      const source = item.kind === 'export-removed' ? { export: item.export } : item.kind === 'prop-removed' ? { export: item.export, prop: item.prop } : { token: item.token };
      if (!resolved.has(refKey(source))) records.push({ kind: 'missing-target', source, reason: 'The old capability is absent and no unambiguous directional documentation maps it to an existing target.', evidence: item.evidence });
    }
    if (item.kind === 'prop-default-changed') records.push({ kind: 'behavior-change', source: { export: item.export, prop: item.prop }, reason: 'The documented or literal default changed and requires behavioral review.', evidence: item.evidence });
  }
  for (const [side, snapshot] of [['from', from], ['to', to]]) for (const issue of snapshot.issues) {
    records.push({ kind: 'unsupported-extraction', reason: `${side} snapshot: ${issue.reason}`, evidence: decorateEvidence(issue.evidence, side) });
  }
  return unique(records).sort((a, b) => a.kind.localeCompare(b.kind) || refKey(a.source ?? {}).localeCompare(refKey(b.source ?? {})) || a.reason.localeCompare(b.reason));
}

export function compareSnapshots(from, to, compiler) {
  const comparedExports = compareExports(from, to);
  const changes = sortChanges([...comparedExports.changes, ...compareTokens(from, to)]);
  const documented = inferDocumentationProposals(from, to, changes);
  const proposals = sortProposals(documented.proposals);
  const contract = {
    schemaVersion: 1, kind: 'migration-contract', status: 'draft', executable: false,
    from: from.identity, to: to.identity, compiler,
    coverage: { from: decoratedCoverage(from, 'from'), to: decoratedCoverage(to, 'to') },
    changes, proposals,
    unresolved: unresolvedRecords(from, to, changes, proposals, [...documented.unresolved, ...comparedExports.unresolved]),
    limitations: [
      'Read-only static TypeScript and token comparison; no application code, package lifecycle script, or model is executed.',
      'Documentation proposals are draft review candidates, never executable migration recipes or proof of semantic equivalence.',
      'Unsupported and incomplete extraction is reported and suppresses absence facts for the affected surface.',
      'Runtime behavior, styling, accessibility, consumer usage, and migration correctness are outside this contract.',
    ],
  };
  validateContract(contract, { from, to });
  return contract;
}

export async function inferContract({ from, to, compiler }) {
  demand(from && to && compiler, 'inferContract requires from, to and compiler paths');
  const fromStat = await fs.lstat(from); const toStat = await fs.lstat(to);
  demand(fromStat.isDirectory() && !fromStat.isSymbolicLink(), 'Old snapshot must be a real directory');
  demand(toStat.isDirectory() && !toStat.isSymbolicLink(), 'New snapshot must be a real directory');
  const fromRoot = await fs.realpath(from); const toRoot = await fs.realpath(to);
  demand(fromRoot !== toRoot, 'Old and new snapshots must be different directories');
  const loaded = await loadCompiler(compiler);
  const oldSnapshot = await extractSnapshot(fromRoot, loaded.ts); const newSnapshot = await extractSnapshot(toRoot, loaded.ts);
  const contract = compareSnapshots(oldSnapshot, newSnapshot, loaded.identity);
  const finalOld = await extractSnapshot(fromRoot, loaded.ts); const finalNew = await extractSnapshot(toRoot, loaded.ts);
  demand(finalOld.identity.digest === oldSnapshot.identity.digest && finalNew.identity.digest === newSnapshot.identity.digest, 'Snapshot changed during inference');
  return contract;
}

function evidenceValid(evidence, snapshot, side) {
  if (!evidence || evidence.snapshot !== side || !Number.isInteger(evidence.startLine) || !Number.isInteger(evidence.endLine)
    || evidence.startLine < 1 || evidence.endLine < evidence.startLine || !evidence.quote) return false;
  const record = snapshot.files.find((item) => item.file === evidence.file);
  if (!record || record.sha256 !== evidence.sha256 || digest(record.text) !== evidence.sha256) return false;
  let start = -1;
  while ((start = record.text.indexOf(evidence.quote, start + 1)) >= 0) {
    const end = start + evidence.quote.length;
    if (record.text.slice(0, start).split('\n').length === evidence.startLine && record.text.slice(0, end).split('\n').length === evidence.endLine) return true;
  }
  return false;
}

function referenceExists(reference, snapshot, { requireComplete = false } = {}) {
  if (reference.export) {
    const item = snapshot.exports.find((candidate) => publicExportName(candidate) === reference.export); if (!item) return false;
    if (!snapshot.coverage.exports.extracted.includes(`${item.entrypoint}#${item.name}`)) return false;
    if (reference.prop) {
      const prop = item.props.find((candidate) => candidate.name === reference.prop); if (!prop) return false;
      if (!snapshot.coverage.propSurfaces.extracted.includes(`${item.entrypoint}#${item.name}.${prop.name}`)) return false;
      if (Object.hasOwn(reference, 'value') && !(prop.literals ?? []).some((value) => equal(value, reference.value))) return false;
      return true;
    }
    return !requireComplete || !item.incomplete;
  }
  return reference.token ? snapshot.tokens.some((item) => item.name === reference.token)
    && snapshot.coverage.tokens.extracted.includes(reference.token)
    && !snapshot.issues.some((item) => item.id === `token-duplicate:${reference.token}`) : false;
}

function allEvidence(contract) {
  const coverage = ['from', 'to'].flatMap((side) => COLLECTIONS.flatMap((name) => contract.coverage[side][name].unsupported.flatMap((item) => item.evidence ?? [])));
  return [...contract.changes, ...contract.proposals, ...contract.unresolved].flatMap((item) => item.evidence ?? []).concat(coverage);
}

export function validateContract(contract, snapshots) {
  demand(contract?.schemaVersion === 1 && contract.kind === 'migration-contract' && contract.status === 'draft' && contract.executable === false, 'Invalid migration contract header');
  demand(contract.from?.name && contract.from?.version && contract.from?.digest && contract.to?.name && contract.to?.version && contract.to?.digest, 'Contract package identities are incomplete');
  demand(contract.compiler?.version && contract.compiler?.sha256, 'Contract compiler identity is incomplete');
  demand(Array.isArray(contract.changes) && Array.isArray(contract.proposals) && Array.isArray(contract.unresolved) && Array.isArray(contract.limitations), 'Contract collections are invalid');
  const ids = [...contract.changes, ...contract.proposals].map((item) => item.id);
  demand(ids.length === new Set(ids).size && ids.every(Boolean), 'Contract IDs must be unique and nonempty');
  for (const item of contract.proposals) demand(item.status === 'needs-review' && item.executable === false, 'All inferred proposals must be non-executable and need review');
  if (snapshots) {
    demand(contract.from.digest === snapshots.from.identity.digest && contract.to.digest === snapshots.to.identity.digest, 'Contract snapshot identity mismatch');
    for (const item of contract.proposals) {
      demand(referenceExists(item.source, snapshots.from, { requireComplete: true }), `Proposal source does not exist: ${refKey(item.source)}`);
      for (const target of item.targets ?? [item.target]) demand(target && referenceExists(target, snapshots.to, { requireComplete: true }), `Proposal target does not exist: ${refKey(target)}`);
    }
    for (const evidence of allEvidence(contract)) {
      const snapshot = evidence.snapshot === 'from' ? snapshots.from : evidence.snapshot === 'to' ? snapshots.to : null;
      demand(snapshot && evidenceValid(evidence, snapshot, evidence.snapshot), `Invalid evidence: ${evidence?.snapshot ?? 'unknown'}:${evidence?.file ?? 'unknown'}`);
    }
  }
  return contract;
}
