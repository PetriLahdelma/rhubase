import { digest, demand } from './files.mjs';
import { inspectContents, parseProject, walk, jsxOrigin, attributes } from './source-analysis.mjs';

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const PROP_NAME = /^[A-Za-z_$][\w$-]*$/;
const LITERAL = (value) => value === null || typeof value === 'string' || typeof value === 'boolean'
  || (typeof value === 'number' && Number.isFinite(value));

function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function exactKeys(value, allowed, label) {
  demand(object(value), `${label} must be an object`);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  demand(!unknown.length, `${label} contains unknown field${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
}
function componentRef(value, label) {
  exactKeys(value, ['module', 'export'], label);
  demand(object(value) && typeof value.module === 'string' && value.module && typeof value.export === 'string' && value.export, `${label} module/export required`);
  demand(value.export === 'default' || IDENTIFIER.test(value.export), `${label} export is invalid`);
}

export function validateRecipe(recipe) {
  exactKeys(recipe, ['schemaVersion', 'id', 'description', 'rules'], 'Recipe');
  demand(object(recipe) && recipe.schemaVersion === 1 && typeof recipe.id === 'string' && recipe.id && Array.isArray(recipe.rules) && recipe.rules.length, 'Invalid recipe');
  demand(recipe.description === undefined || typeof recipe.description === 'string', 'Recipe description must be a string');
  const ids = new Set();
  for (const rule of recipe.rules) {
    exactKeys(rule, ['id', 'kind', 'from', 'to', 'when', 'props'], 'Recipe rule');
    demand(object(rule) && typeof rule.id === 'string' && rule.id && !ids.has(rule.id), 'Recipe rule ids must be unique');
    ids.add(rule.id);
    demand(rule.kind === 'component' || rule.kind === 'superset-dropdown', `Unsupported recipe rule kind: ${rule.kind}`);
    componentRef(rule.from, 'Rule source');
    componentRef(rule.to, 'Rule target');
    if (rule.kind === 'superset-dropdown') {
      demand(rule.from.module === 'react-bootstrap' && rule.from.export === 'DropdownButton', 'Invalid Superset dropdown source');
      demand(rule.to.module === 'src/common/components' && rule.to.export === 'Dropdown', 'Invalid Superset dropdown target');
      demand(rule.when === undefined && rule.props === undefined, 'Superset dropdown rules do not accept when/props');
      continue;
    }
    if (rule.when !== undefined) {
      exactKeys(rule.when, ['prop', 'literal'], 'Component predicate');
      demand(object(rule.when) && PROP_NAME.test(rule.when.prop) && LITERAL(rule.when.literal), 'Invalid component predicate');
    }
    const props = rule.props === undefined ? {} : rule.props;
    exactKeys(props, ['rename', 'values', 'remove', 'set'], 'Component props');
    demand(object(props), 'Invalid component props');
    const rename = props.rename === undefined ? {} : props.rename;
    const values = props.values === undefined ? {} : props.values;
    const remove = props.remove === undefined ? {} : props.remove;
    const set = props.set === undefined ? {} : props.set;
    demand(object(rename) && object(values) && object(remove) && object(set), 'Prop operations must be objects');
    for (const [from, to] of Object.entries(rename)) demand(PROP_NAME.test(from) && typeof to === 'string' && PROP_NAME.test(to), 'Invalid prop rename');
    for (const [name, mapping] of Object.entries(values)) {
      demand(PROP_NAME.test(name) && object(mapping) && Object.values(mapping).every(LITERAL), 'Invalid prop value map');
    }
    for (const [name, expected] of Object.entries(remove)) demand(PROP_NAME.test(name) && LITERAL(expected), 'Invalid removed prop precondition');
    for (const [name, value] of Object.entries(set)) demand(PROP_NAME.test(name) && LITERAL(value), 'Invalid default prop');
    const actionKeys = [Object.keys(rename), Object.keys(values), Object.keys(remove)];
    demand(new Set(actionKeys.flat()).size === actionKeys.flat().length, 'A prop may have only one rename/value/remove action');
    const renameTargets = Object.values(rename);
    demand(new Set(renameTargets).size === renameTargets.length, 'Prop rename targets must be unique');
    demand(renameTargets.every((name) => !Object.hasOwn(set, name)), 'Renamed and defaulted props conflict');
  }
  return recipe;
}

export function recipeSourceRules(recipe) {
  validateRecipe(recipe);
  const sources = new Map();
  for (const { from } of recipe.rules) {
    const exports = sources.get(from.module) ?? new Set();
    exports.add(from.export); sources.set(from.module, exports);
  }
  return { schemaVersion: 1, sources: [...sources].map(([module, exports]) => ({ module, exports: [...exports] })) };
}

function literalKey(value) { return `${value === null ? 'null' : typeof value}:${String(value)}`; }
function attributeMap(ts, opening) {
  const result = new Map();
  for (const property of opening.attributes.properties) {
    if (ts.isJsxSpreadAttribute(property)) continue;
    const name = property.name.getText();
    const list = result.get(name) ?? []; list.push(property); result.set(name, list);
  }
  return result;
}
function attributeLiteral(ts, attribute) {
  if (!attribute.initializer) return { known: true, value: true };
  if (ts.isStringLiteral(attribute.initializer)) return { known: true, value: attribute.initializer.text };
  if (!ts.isJsxExpression(attribute.initializer) || !attribute.initializer.expression) return { known: false };
  const value = attribute.initializer.expression;
  if (ts.isStringLiteral(value) || ts.isNumericLiteral(value)) return { known: true, value: ts.isNumericLiteral(value) ? Number(value.text) : value.text };
  if (value.kind === ts.SyntaxKind.TrueKeyword) return { known: true, value: true };
  if (value.kind === ts.SyntaxKind.FalseKeyword) return { known: true, value: false };
  if (value.kind === ts.SyntaxKind.NullKeyword) return { known: true, value: null };
  return { known: false };
}
function printLiteral(value) {
  if (value === true) return '';
  if (typeof value === 'string') return /^[^"\\\r\n<&]*$/.test(value) ? `=${JSON.stringify(value)}` : `={${JSON.stringify(value)}}`;
  return `={${value === null ? 'null' : String(value)}}`;
}
function lineOf(file, node) { return file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1; }
function sourceText(file, node) { return file.text.slice(node.getStart(file), node.end); }

function importBindings(ts, file) {
  const imports = [];
  for (const node of file.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    const bindings = [];
    const clause = node.importClause;
    if (clause?.name) bindings.push({ exported: 'default', local: clause.name.text, node: clause.name, typeOnly: clause.isTypeOnly });
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const specifier of clause.namedBindings.elements) bindings.push({ exported: specifier.propertyName?.text ?? specifier.name.text, local: specifier.name.text, node: specifier, typeOnly: clause.isTypeOnly || specifier.isTypeOnly });
    }
    if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) bindings.push({ exported: '*', local: clause.namedBindings.name.text, node: clause.namedBindings, typeOnly: clause.isTypeOnly });
    imports.push({ node, module: node.moduleSpecifier.text, bindings });
  }
  return imports;
}
function occupiedNames(ts, file) {
  const names = new Set();
  walk(ts, file, (node) => { if (ts.isIdentifier(node)) names.add(node.text); });
  return names;
}
function targetBinding(ts, checker, file, atNode, target, planned) {
  const imports = importBindings(ts, file);
  const exact = imports.flatMap((entry) => entry.bindings.map((binding) => ({ ...binding, module: entry.module })))
    .find((binding) => !binding.typeOnly && binding.module === target.module && binding.exported === target.export);
  const resolvesToImport = (binding) => checker.resolveName(binding.local, atNode, ts.SymbolFlags.Value, false)
    === checker.getSymbolAtLocation(binding.node.name ?? binding.node);
  if (exact && resolvesToImport(exact)) return { tag: exact.local, add: null };
  const namespace = imports.find((entry) => entry.module === target.module)?.bindings.find((binding) => !binding.typeOnly && binding.exported === '*');
  if (namespace && target.export !== 'default' && resolvesToImport(namespace)) return { tag: `${namespace.local}.${target.export}`, add: null };
  const key = `${target.module}#${target.export}`;
  if (planned.has(key)) return planned.get(key);
  const occupied = occupiedNames(ts, file);
  for (const value of planned.values()) occupied.add(value.tag);
  const base = target.export === 'default' ? 'MigratedComponent' : target.export;
  let local = base; let index = 2;
  while (occupied.has(local)) local = `${base}${index++}`;
  const result = { tag: local, add: { ...target, local } }; planned.set(key, result); return result;
}
function renderImport(ts, factory, printer, original, bindings) {
  if (!bindings.length) return '';
  const defaults = bindings.filter((b) => b.exported === 'default');
  const namespace = bindings.find((b) => b.exported === '*');
  const named = bindings.filter((b) => !['default', '*'].includes(b.exported));
  const clause = factory.createImportClause(false, defaults[0] ? factory.createIdentifier(defaults[0].local) : undefined,
    namespace ? factory.createNamespaceImport(factory.createIdentifier(namespace.local))
      : named.length ? factory.createNamedImports(named.map((b) => factory.createImportSpecifier(Boolean(b.typeOnly),
        b.exported === b.local ? undefined : factory.createIdentifier(b.exported), factory.createIdentifier(b.local)))) : undefined);
  const declaration = factory.updateImportDeclaration(original, original.modifiers, clause, original.moduleSpecifier, original.attributes);
  return printer.printNode(ts.EmitHint.Unspecified, declaration, original.getSourceFile());
}
function applyEdits(text, edits) {
  const ordered = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  for (let index = 1; index < ordered.length; index++) demand(ordered[index - 1].start >= ordered[index].end, 'Overlapping generated edits');
  let result = text;
  for (const edit of ordered) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
}

function genericChanges(ts, file, element, rule, tag) {
  const opening = ts.isJsxElement(element) ? element.openingElement : element;
  const attrs = attributeMap(ts, opening);
  const edits = [];
  const requireSingle = (name) => {
    const values = attrs.get(name) ?? [];
    if (values.length > 1) throw new Error(`Duplicate ${name} prop`);
    return values[0];
  };
  if (opening.attributes.properties.some(ts.isJsxSpreadAttribute)) throw new Error('Opaque spread may override transformed props');
  const props = rule.props ?? {};
  for (const [from, to] of Object.entries(props.rename ?? {})) {
    const source = requireSingle(from); const target = requireSingle(to);
    if (source && target && from !== to) throw new Error(`Cannot rename ${from}; ${to} already exists`);
    if (source && from !== to) edits.push({ start: source.name.getStart(file), end: source.name.end, text: to });
  }
  for (const [name, mapping] of Object.entries(props.values ?? {})) {
    const attribute = requireSingle(name); if (!attribute) continue;
    const literal = attributeLiteral(ts, attribute);
    if (!literal.known) throw new Error(`Prop ${name} is not a literal`);
    if (Object.hasOwn(mapping, String(literal.value))) {
      const value = mapping[String(literal.value)];
      edits.push({ start: attribute.getStart(file), end: attribute.end, text: `${name}${printLiteral(value)}` });
    }
  }
  for (const [name, expected] of Object.entries(props.remove ?? {})) {
    const attribute = requireSingle(name);
    if (!attribute) {
      if (rule.from.module === rule.to.module && rule.from.export === rule.to.export) continue;
      throw new Error(`Required removable prop ${name} is missing`);
    }
    const literal = attributeLiteral(ts, attribute);
    if (!literal.known || literalKey(literal.value) !== literalKey(expected)) throw new Error(`Prop ${name} does not match removal precondition`);
    edits.push({ start: attribute.getStart(file), end: attribute.end, text: '' });
  }
  const additions = [];
  for (const [name, value] of Object.entries(props.set ?? {})) {
    const existing = requireSingle(name);
    if (existing) {
      const literal = attributeLiteral(ts, existing);
      if (!literal.known || literalKey(literal.value) !== literalKey(value)) throw new Error(`Prop ${name} conflicts with required default`);
    } else additions.push(`${name}${printLiteral(value)}`);
  }
  edits.push({ start: opening.tagName.getStart(file), end: opening.tagName.end, text: tag });
  if (ts.isJsxElement(element)) edits.push({ start: element.closingElement.tagName.getStart(file), end: element.closingElement.tagName.end, text: tag });
  if (additions.length) {
    const insertion = opening.attributes.end;
    edits.push({ start: insertion, end: insertion, text: ` ${additions.join(' ')}` });
  }
  return edits;
}

function expressionFromInitializer(file, attribute) {
  const text = sourceText(file, attribute.initializer);
  return text.startsWith('{') ? text : `{${text}}`;
}
function supersetReplacement(ts, file, element, tag) {
  if (!ts.isJsxElement(element)) throw new Error('Superset dropdown must have menu children');
  const opening = element.openingElement; const props = attributeMap(ts, opening);
  if (opening.attributes.properties.some(ts.isJsxSpreadAttribute)) throw new Error('Opaque spread may override dropdown semantics');
  const one = (name) => { const values = props.get(name) ?? []; if (values.length > 1) throw new Error(`Duplicate ${name} prop`); return values[0]; };
  const title = one('title'); if (!title?.initializer) throw new Error('Dropdown title is required');
  const meaningful = element.children.filter((child) => !ts.isJsxText(child) || child.text.trim());
  if (meaningful.length !== 1 || !ts.isJsxElement(meaningful[0]) || meaningful[0].openingElement.tagName.getText() !== 'Menu') throw new Error('Expected exactly one Menu child');
  const targetProps = [`overlay={${sourceText(file, meaningful[0])}}`, `trigger={['click']}`];
  const move = ['open', 'onToggle'];
  for (const name of move) {
    const value = one(name); if (value) targetProps.push(`${name === 'open' ? 'visible' : 'onVisibleChange'}${sourceText(file, value).slice(name.length)}`);
  }
  if (one('pullRight')) targetProps.push('placement="bottomRight"');
  if (file.fileName.includes('/dashboard/')) targetProps.push('getPopupContainer={triggerNode => triggerNode.parentNode}');
  const buttonProps = ['type="button"'];
  for (const name of ['id', 'data-test', 'className']) {
    const value = one(name); if (value) buttonProps.push(sourceText(file, value));
  }
  const titleText = expressionFromInitializer(file, title);
  if (/className\s*=\s*["']fa\s+fa-/.test(titleText)) buttonProps.push('aria-label="Query actions"');
  const consumed = new Set(['title', 'open', 'onToggle', 'pullRight', 'bsSize', 'noCaret', 'id', 'data-test', 'className']);
  for (const property of opening.attributes.properties) {
    if (ts.isJsxAttribute(property) && !consumed.has(property.name.getText())) targetProps.push(sourceText(file, property));
  }
  return `<${tag}\n        ${targetProps.join('\n        ')}\n      >\n        <button ${buttonProps.join(' ')}>${titleText}</button>\n      </${tag}>`;
}

function predicateState(ts, opening, when) {
  if (!when) return 'match';
  const list = attributeMap(ts, opening).get(when.prop) ?? [];
  if (!list.length) return opening.attributes.properties.some(ts.isJsxSpreadAttribute) ? 'unknown' : 'different';
  if (list.length !== 1) return 'unknown';
  const literal = attributeLiteral(ts, list[0]);
  if (!literal.known) return 'unknown';
  return literalKey(literal.value) === literalKey(when.literal) ? 'match' : 'different';
}

function sameIdentityTargetState(ts, opening, rule) {
  if (!rule.when || rule.from.module !== rule.to.module || rule.from.export !== rule.to.export) return 'not-satisfied';
  if (opening.attributes.properties.some(ts.isJsxSpreadAttribute)) return 'ambiguous';
  const attrs = attributeMap(ts, opening);
  const one = (name) => {
    const list = attrs.get(name) ?? [];
    if (list.length > 1) return { state: 'ambiguous' };
    if (!list.length) return { state: 'absent' };
    const literal = attributeLiteral(ts, list[0]);
    return literal.known ? { state: 'literal', value: literal.value } : { state: 'ambiguous' };
  };
  const props = rule.props ?? {};
  const discriminator = rule.when.prop;
  let discriminantProven = false;
  if (Object.hasOwn(props.remove ?? {}, discriminator)
    && literalKey(props.remove[discriminator]) === literalKey(rule.when.literal)) {
    const current = one(discriminator);
    if (current.state === 'ambiguous') return 'ambiguous';
    discriminantProven = current.state === 'absent';
  }
  if (Object.hasOwn(props.rename ?? {}, discriminator)) {
    const source = one(discriminator); const target = one(props.rename[discriminator]);
    if (source.state === 'ambiguous' || target.state === 'ambiguous') return 'ambiguous';
    discriminantProven = source.state === 'absent' && target.state === 'literal'
      && literalKey(target.value) === literalKey(rule.when.literal);
  }
  const discriminantMap = props.values?.[discriminator];
  if (discriminantMap && Object.hasOwn(discriminantMap, String(rule.when.literal))) {
    const current = one(discriminator);
    if (current.state === 'ambiguous') return 'ambiguous';
    discriminantProven = current.state === 'literal'
      && literalKey(current.value) === literalKey(discriminantMap[String(rule.when.literal)]);
  }
  if (!discriminantProven) return 'not-satisfied';

  for (const source of Object.keys(props.rename ?? {})) {
    const current = one(source);
    if (current.state === 'ambiguous') return 'ambiguous';
    if (current.state !== 'absent') return 'not-satisfied';
  }
  for (const name of Object.keys(props.remove ?? {})) {
    const current = one(name);
    if (current.state === 'ambiguous') return 'ambiguous';
    if (current.state !== 'absent') return 'not-satisfied';
  }
  for (const [name, required] of Object.entries(props.set ?? {})) {
    const current = one(name);
    if (current.state === 'ambiguous') return 'ambiguous';
    if (current.state !== 'literal' || literalKey(current.value) !== literalKey(required)) return 'not-satisfied';
  }
  for (const [name, mapping] of Object.entries(props.values ?? {})) {
    const current = one(name);
    if (current.state === 'ambiguous') return 'ambiguous';
    if (current.state !== 'literal') continue;
    if (Object.hasOwn(mapping, String(current.value))
      && literalKey(mapping[String(current.value)]) !== literalKey(current.value)) return 'not-satisfied';
  }
  return 'satisfied';
}

export function transformSources(ts, contentsMap, recipe) {
  validateRecipe(recipe);
  demand(contentsMap instanceof Map && [...contentsMap].every(([file, value]) => typeof file === 'string' && typeof value === 'string'), 'Expected source contents Map');
  const sourceRules = recipeSourceRules(recipe);
  const inventory = inspectContents(ts, contentsMap, sourceRules);
  const { program, checker, diagnostics } = parseProject(ts, contentsMap);
  demand(diagnostics.length === 0, 'Cannot transform syntactically invalid source');
  const sourceExports = new Set(recipe.rules.map((rule) => rule.from.export));
  const relevantUnsupported = inventory.unsupported.filter((item) => item.kind !== 'local-import'
    || sourceExports.has(item.detail.split(':', 1)[0]));
  const outcomes = []; const blockers = relevantUnsupported.map((item) => ({ ...item, reason: item.detail }));
  const output = new Map(contentsMap);
  for (const file of program.getSourceFiles()) {
    if (!contentsMap.has(file.fileName)) continue;
    const planned = new Map(); const textEdits = []; const transformed = new Set(); const retainedIdentityKeys = new Set();
    const usagesByStart = new Map(inventory.usages.filter((u) => u.file === file.fileName).map((u) => [u.start, u]));
    const elements = [];
    walk(ts, file, (node) => {
      if (!ts.isJsxElement(node) && !ts.isJsxSelfClosingElement(node)) return;
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const origin = jsxOrigin(ts, checker, opening.tagName);
      if (origin && sourceRules.sources.some((source) => source.module === origin.module && source.exports.includes(origin.exported))) elements.push({ node, opening, origin });
    });
    const nested = new Set();
    for (const outer of elements) for (const inner of elements) {
      if (outer === inner || inner.node.getStart(file) <= outer.node.getStart(file) || inner.node.end >= outer.node.end) continue;
      const hasStructuralRule = (entry) => recipe.rules.some((rule) => rule.kind !== 'component'
        && rule.from.module === entry.origin.module && rule.from.export === entry.origin.exported);
      if (hasStructuralRule(outer) || hasStructuralRule(inner)) { nested.add(outer); nested.add(inner); }
    }
    for (const entry of elements) {
      const usage = usagesByStart.get(entry.opening.getStart(file));
      const base = { id: usage?.id ?? digest(`${file.fileName}:${entry.opening.getStart(file)}`).slice(0, 20), file: file.fileName, line: lineOf(file, entry.opening) };
      const applicable = recipe.rules.filter((rule) => rule.from.module === entry.origin.module && rule.from.export === entry.origin.exported);
      const states = applicable.map((rule) => ({ rule, state: predicateState(ts, entry.opening, rule.when) }));
      const candidates = states.filter(({ state }) => state === 'match').map(({ rule }) => rule);
      const targetStates = candidates.length ? [] : states.map(({ rule }) => ({ rule, state: sameIdentityTargetState(ts, entry.opening, rule) }));
      const satisfied = targetStates.filter(({ state }) => state === 'satisfied');
      if (!candidates.length && satisfied.length === 1 && !targetStates.some(({ state }) => state === 'ambiguous')) {
        outcomes.push({ ...base, status: 'unchanged', ruleId: satisfied[0].rule.id, reasonCode: 'already-satisfied', reason: 'Usage already satisfies the reviewed recipe rule' });
        continue;
      }
      if (!candidates.length && (satisfied.length > 1 || targetStates.some(({ state }) => state === 'ambiguous'))) {
        const reason = satisfied.length > 1 ? 'Multiple conditional target states match this usage' : 'Conditional target state is ambiguous for this usage';
        outcomes.push({ ...base, status: 'blocked', ruleId: targetStates.filter(({ state }) => state !== 'not-satisfied').map(({ rule }) => rule.id).join(','), reasonCode: 'ambiguous-condition', reason });
        blockers.push({ ...base, reason }); continue;
      }
      if (!candidates.length && states.some(({ state }) => state === 'unknown')) {
        const reason = 'Conditional recipe match is ambiguous for this usage';
        outcomes.push({ ...base, status: 'blocked', ruleId: states.filter(({ state }) => state === 'unknown').map(({ rule }) => rule.id).join(','), reasonCode: 'ambiguous-condition', reason });
        blockers.push({ ...base, reason }); continue;
      }
      if (!candidates.length) { outcomes.push({ ...base, status: 'unchanged', ruleId: applicable.map((rule) => rule.id).join(','), reasonCode: 'no-rule-match', reason: 'No recipe rule matched this usage' }); continue; }
      if (candidates.length > 1 || nested.has(entry)) {
        const reason = candidates.length > 1 ? 'Multiple recipe rules matched this usage' : 'Nested matched usages require review';
        outcomes.push({ ...base, status: 'blocked', ruleId: candidates.map((r) => r.id).join(','), reasonCode: candidates.length > 1 ? 'conflicting-rules' : 'nested-structural-edit', reason }); blockers.push({ ...base, reason }); continue;
      }
      const rule = candidates[0];
      const plannedBefore = new Set(planned.keys());
      try {
        const binding = targetBinding(ts, checker, file, entry.opening, rule.to, planned);
        const generated = rule.kind === 'component'
          ? genericChanges(ts, file, entry.node, rule, binding.tag)
          : [{ start: entry.node.getStart(file), end: entry.node.end, text: supersetReplacement(ts, file, entry.node, binding.tag) }];
        const effective = generated.filter((edit) => file.text.slice(edit.start, edit.end) !== edit.text);
        if (!effective.length) {
          for (const key of planned.keys()) if (!plannedBefore.has(key)) planned.delete(key);
          outcomes.push({ ...base, status: 'unchanged', ruleId: rule.id, reasonCode: 'already-satisfied', reason: 'Usage already satisfies the reviewed recipe rule' });
          continue;
        }
        textEdits.push(...effective); transformed.add(entry);
        retainedIdentityKeys.add(`${rule.to.module}#${rule.to.export}`);
        outcomes.push({ ...base, status: 'transformed', ruleId: rule.id, reasonCode: 'rule-applied', reason: 'Applied reviewed recipe rule' });
      } catch (error) {
        for (const key of planned.keys()) if (!plannedBefore.has(key)) planned.delete(key);
        outcomes.push({ ...base, status: 'blocked', ruleId: rule.id, reasonCode: 'unsafe-transformation', reason: error.message }); blockers.push({ ...base, ruleId: rule.id, reason: error.message });
      }
    }
    if (!transformed.size) continue;
    const imports = importBindings(ts, file); const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
    const finalSourceKeys = new Set(elements.filter((entry) => !transformed.has(entry)).map((entry) => `${entry.origin.module}#${entry.origin.exported}`));
    for (const key of retainedIdentityKeys) finalSourceKeys.add(key);
    const protectSourceImports = relevantUnsupported.some((item) => item.file === file.fileName && item.kind !== 'local-import');
    const desired = new Map(imports.map((entry) => [entry, [...entry.bindings]]));
    for (const entry of imports) {
      if (protectSourceImports) continue;
      desired.set(entry, desired.get(entry).filter((binding) => finalSourceKeys.has(`${entry.module}#${binding.exported}`)
        || !sourceRules.sources.some((source) => source.module === entry.module && source.exports.includes(binding.exported))));
    }
    const pending = [];
    for (const addition of [...planned.values()].map((value) => value.add).filter(Boolean)) {
      const existing = imports.find((entry) => entry.module === addition.module && !entry.bindings.some((binding) => binding.exported === '*' || binding.typeOnly));
      if (existing) desired.get(existing).push({ exported: addition.export, local: addition.local });
      else pending.push(addition);
    }
    for (const entry of imports) {
      const next = desired.get(entry);
      if (JSON.stringify(next.map(({ exported, local }) => ({ exported, local }))) !== JSON.stringify(entry.bindings.map(({ exported, local }) => ({ exported, local })))) {
        textEdits.push({ start: entry.node.getStart(file), end: entry.node.end, text: renderImport(ts, ts.factory, printer, entry.node, next) });
      }
    }
    const pendingByModule = Map.groupBy(pending, (addition) => addition.module);
    const offset = file.statements.filter(ts.isImportDeclaration).at(-1)?.end ?? 0;
    for (const [module, additions] of pendingByModule) {
      const defaultImport = additions.find((addition) => addition.export === 'default');
      const named = additions.filter((addition) => addition.export !== 'default').map((addition) => addition.export === addition.local ? addition.export : `${addition.export} as ${addition.local}`);
      const specifiers = [defaultImport?.local, named.length ? `{ ${named.join(', ')} }` : null].filter(Boolean).join(', ');
      textEdits.push({ start: offset, end: offset, text: `${offset ? '\n' : ''}import ${specifiers} from ${JSON.stringify(module)};\n` });
    }
    output.set(file.fileName, applyEdits(file.text, textEdits));
  }
  const edits = [];
  for (const [file, before] of contentsMap) {
    const after = output.get(file);
    if (after !== before) edits.push({ file, before, after, beforeSha256: digest(before), afterSha256: digest(after) });
  }
  return { contents: output, edits, inventory, outcomes, blockers };
}
