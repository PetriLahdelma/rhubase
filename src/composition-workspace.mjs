const PROJECT_FIELDS = ['schemaVersion', 'kind', 'title', 'sources', 'scenarios'];
const SOURCE_FIELDS = ['id', 'digest', 'declaredModes'];
const SCENARIO_FIELDS = ['id', 'title', 'includedSources', 'target', 'selections', 'dependencies', 'architecture'];
const TARGET_FIELDS = ['name', 'mode', 'baseSource'];
const SELECTION_FIELDS = ['id', 'source', 'kind', 'name', 'targetName', 'disposition', 'rationale'];
const DEPENDENCY_FIELDS = ['from', 'to', 'rationale'];
const ARCHITECTURE_FIELDS = ['layout', 'topology', 'delivery', 'deliverySource'];
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const PACKAGE_PART = '[a-z](?:[a-z0-9._-]*[a-z0-9])?';
const PACKAGE = new RegExp(`^(?:@${PACKAGE_PART}/${PACKAGE_PART}|${PACKAGE_PART})$`);
const deepClone = (value) => structuredClone(value);
const fail = (message) => { throw Error(message); };
const validId = (value) => typeof value === 'string' && ID.test(value);
const exact = (value, fields, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  const keys = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail(`${label} has unexpected or missing fields.`);
  }
  return value;
};
const array = (value, label, min = 0, max = Infinity) => {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(`${label} has an invalid item count.`);
  return value;
};
const textValue = (value, label) => {
  if (typeof value !== 'string' || value.length < 1 || new TextEncoder().encode(value).length > 1024 || /[\0\u202a-\u202e\u2066-\u2069]/u.test(value)) {
    fail(`${label} is empty, too long, or contains unsafe control text.`);
  }
  return value;
};
const unique = (values, label) => {
  if (new Set(values).size !== values.length) fail(`${label} values must be unique.`);
};

export function validateProjectImport(value, catalogPins) {
  const project = exact(value, PROJECT_FIELDS, 'project');
  if (project.schemaVersion !== 1 || project.kind !== 'rhubase-composition-project') fail('Unsupported project header.');
  textValue(project.title, 'Project title');
  const sources = array(project.sources, 'Project sources', 2, 8);
  const sourceIds = sources.map((source, index) => {
    exact(source, SOURCE_FIELDS, `source ${index + 1}`);
    if (!validId(source.id)) fail('Source ID has an invalid format.');
    if (source.digest !== null && (typeof source.digest !== 'string' || !DIGEST.test(source.digest))) fail(`Source ${source.id} digest is invalid.`);
    const modes = array(source.declaredModes, `Source ${source.id} declared modes`, 0, 16);
    modes.forEach((mode) => textValue(mode, 'Declared mode'));
    unique(modes, `Source ${source.id} declared mode`);
    return source.id;
  });
  unique(sourceIds, 'Source ID');
  if (catalogPins) {
    const expected = Object.keys(catalogPins).sort();
    if (expected.length !== sourceIds.length || expected.some((id, index) => id !== [...sourceIds].sort()[index])) fail('Imported source IDs do not match this catalog.');
    for (const source of sources) {
      const expectedSource = catalogPins[source.id];
      const expectedDigest = typeof expectedSource === 'string' || expectedSource === null ? expectedSource : expectedSource?.digest;
      if (source.digest !== expectedDigest) fail(`Imported digest for ${source.id} does not match this catalog.`);
      if (expectedSource && typeof expectedSource === 'object' && JSON.stringify(source.declaredModes) !== JSON.stringify(expectedSource.declaredModes)) fail(`Imported declared modes for ${source.id} do not match this catalog.`);
    }
  }
  const catalog = new Set(sourceIds);
  const scenarios = array(project.scenarios, 'Project scenarios', 1, 16);
  unique(scenarios.map((scenario) => scenario?.id), 'Scenario ID');
  for (const scenario of scenarios) {
    exact(scenario, SCENARIO_FIELDS, 'scenario');
    if (!validId(scenario.id)) fail('Scenario ID has an invalid format.');
    textValue(scenario.title, 'Scenario title');
    const included = array(scenario.includedSources, 'Included sources', 2, sources.length);
    unique(included, 'Included source');
    if (included.some((id) => !catalog.has(id))) fail('Scenario includes an unknown source.');
    exact(scenario.target, TARGET_FIELDS, 'scenario target');
    if (typeof scenario.target.name !== 'string' || !PACKAGE.test(scenario.target.name) || scenario.target.name.length > 200) fail('Target name must be a lowercase npm-style package identity.');
    if (scenario.target.mode === 'new') {
      if (scenario.target.baseSource !== null) fail('A new target cannot have a base source.');
    } else if (scenario.target.mode === 'evolve') {
      if (typeof scenario.target.baseSource !== 'string' || !included.includes(scenario.target.baseSource)) fail('An evolved target requires an included base source.');
    } else fail('Target mode must be new or evolve.');
    const selections = array(scenario.selections, 'Selections', 0, 256);
    unique(selections.map((selection) => selection?.id), 'Selection ID');
    for (const selection of selections) {
      exact(selection, SELECTION_FIELDS, 'selection');
      if (!validId(selection.id) || !included.includes(selection.source)) fail('Selection identity or source is invalid.');
      if (!['component', 'token', 'mode'].includes(selection.kind)) fail('Selection kind is unsupported.');
      if (!['retain', 'adapt', 'exclude', 'defer'].includes(selection.disposition)) fail('Selection disposition is unsupported.');
      textValue(selection.name, 'Selection name'); textValue(selection.targetName, 'Selection target name'); textValue(selection.rationale, 'Selection rationale');
    }
    const selectionIds = new Set(selections.map(({ id }) => id));
    const dependencies = array(scenario.dependencies, 'Dependencies', 0, 512);
    for (const dependency of dependencies) {
      exact(dependency, DEPENDENCY_FIELDS, 'dependency');
      if (!selectionIds.has(dependency.from) || !validId(dependency.to)) fail('Dependency identity is invalid.');
      textValue(dependency.rationale, 'Dependency rationale');
    }
    exact(scenario.architecture, ARCHITECTURE_FIELDS, 'architecture');
    if (!['colocated', 'by-kind'].includes(scenario.architecture.layout) || !['single-package', 'workspace'].includes(scenario.architecture.topology) || !['minimal', 'preserve'].includes(scenario.architecture.delivery)) fail('Architecture option is unsupported.');
    if (scenario.architecture.delivery === 'minimal') {
      if (scenario.architecture.deliverySource !== null) fail('Minimal delivery cannot set a delivery source.');
    } else if (typeof scenario.architecture.deliverySource !== 'string' || !included.includes(scenario.architecture.deliverySource)) fail('Preserved delivery requires an included source.');
  }
  return deepClone(project);
}

export function catalogEntries(blueprint, query = '') {
  const needle = query.trim().toLocaleLowerCase();
  return (blueprint?.sources ?? []).flatMap((source) => (source.capabilities ?? []).map((capability) => ({
    key: `${source.id}:${capability.kind}:${capability.name}`,
    sourceId: source.id,
    packageName: source.identity?.name ?? source.id,
    packageVersion: source.identity?.version ?? '',
    kind: capability.kind,
    name: capability.name,
    status: capability.status,
    evidenceRefs: deepClone(capability.evidenceRefs ?? []),
  }))).filter((entry) => !needle || `${entry.sourceId} ${entry.packageName} ${entry.kind} ${entry.name} ${entry.status}`.toLocaleLowerCase().includes(needle))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function safeJsonForHtml(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/gu, (character) => ({ '<': '\\u003c', '>': '\\u003e', '&': '\\u0026', '\u2028': '\\u2028', '\u2029': '\\u2029' })[character]);
}

function rejectDuplicateKeys(source) {
  let index = 0;
  const whitespace = () => { while (/\s/u.test(source[index] ?? '')) index += 1; };
  const string = () => {
    const start = index; if (source[index++] !== '"') fail('Expected JSON string.');
    while (index < source.length) { if (source[index] === '\\') index += 2; else if (source[index++] === '"') return JSON.parse(source.slice(start, index)); }
    fail('Unterminated JSON string.');
  };
  const value = () => {
    whitespace();
    if (source[index] === '{') {
      index += 1; whitespace(); const keys = new Set();
      if (source[index] === '}') { index += 1; return; }
      while (true) { whitespace(); const key = string(); if (keys.has(key)) fail(`Duplicate JSON key: ${key}.`); keys.add(key); whitespace(); if (source[index++] !== ':') fail('Expected JSON colon.'); value(); whitespace(); const token = source[index++]; if (token === '}') return; if (token !== ',') fail('Expected JSON comma.'); }
    }
    if (source[index] === '[') {
      index += 1; whitespace(); if (source[index] === ']') { index += 1; return; }
      while (true) { value(); whitespace(); const token = source[index++]; if (token === ']') return; if (token !== ',') fail('Expected JSON comma.'); }
    }
    if (source[index] === '"') { string(); return; }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(source.slice(index));
    if (!match) fail('Invalid JSON value.'); index += match[0].length;
  };
  value(); whitespace(); if (index !== source.length) fail('Unexpected content after JSON document.');
}

export function parseProjectText(source, catalogPins) {
  if (typeof source !== 'string' || new TextEncoder().encode(source).length > 1024 * 1024) fail('Project file must be UTF-8 JSON no larger than 1 MiB.');
  rejectDuplicateKeys(source);
  return validateProjectImport(JSON.parse(source), catalogPins);
}

export function createWorkspaceState(project, blueprint) {
  const catalogPins = Object.fromEntries(project.sources.map(({ id, digest, declaredModes }) => [id, { digest, declaredModes: [...declaredModes] }]));
  const validated = validateProjectImport(project, catalogPins);
  return {
    project: validated,
    originalProject: deepClone(validated),
    blueprint: deepClone(blueprint),
    catalogPins,
    catalog: catalogEntries(blueprint),
    activeScenarioId: validated.scenarios[0].id,
    filter: '',
    status: 'validated-snapshot',
    consequences: [],
    savedRevision: JSON.stringify(validated),
    history: [],
    future: [],
  };
}

const snapshot = (state) => ({ project: deepClone(state.project), activeScenarioId: state.activeScenarioId, consequences: [...state.consequences] });
const activeScenario = (state) => state.project.scenarios.find((scenario) => scenario.id === state.activeScenarioId);
const changed = (state, mutate, consequences = []) => {
  const next = { ...state, project: deepClone(state.project), history: [...state.history, snapshot(state)].slice(-50), future: [], status: 'needs-cli-validation', consequences };
  mutate(next, activeScenario(next));
  return next;
};
const patchKnown = (target, patch, fields) => {
  for (const [key, value] of Object.entries(patch)) {
    if (!fields.includes(key)) fail(`Unknown editable field: ${key}.`);
    target[key] = value;
  }
};

export function applyWorkspaceAction(state, action) {
  if (!action || typeof action.type !== 'string') fail('Workspace action requires a type.');
  if (action.type === 'set-filter') return { ...state, filter: String(action.value ?? '') };
  if (action.type === 'switch-scenario') {
    if (!state.project.scenarios.some(({ id }) => id === action.id)) fail('Unknown scenario.');
    return { ...state, activeScenarioId: action.id, consequences: [] };
  }
  if (action.type === 'undo') {
    if (!state.history.length) return state;
    const previous = state.history.at(-1);
    return { ...state, ...deepClone(previous), history: state.history.slice(0, -1), future: [snapshot(state), ...state.future].slice(0, 50), status: 'needs-cli-validation' };
  }
  if (action.type === 'redo') {
    if (!state.future.length) return state;
    const next = state.future[0];
    return { ...state, ...deepClone(next), history: [...state.history, snapshot(state)].slice(-50), future: state.future.slice(1), status: 'needs-cli-validation' };
  }
  if (action.type === 'import-project') {
    const project = validateProjectImport(action.project, state.catalogPins);
    return { ...state, project, activeScenarioId: project.scenarios[0].id, history: [...state.history, snapshot(state)].slice(-50), future: [], status: 'needs-cli-validation', consequences: ['Imported choices match this pinned catalog. Re-run the CLI to validate them.'] };
  }
  if (action.type === 'branch-scenario') return changed(state, (next, scenario) => {
    if (!validId(action.id) || next.project.scenarios.some(({ id }) => id === action.id) || next.project.scenarios.length >= 16) fail('Branch ID must be unique and use letters, numbers, underscores, or dashes.');
    const branch = deepClone(scenario); branch.id = action.id; branch.title = textValue(action.title, 'Branch title');
    next.project.scenarios.push(branch); next.activeScenarioId = branch.id;
  });
  if (action.type === 'update-target') return changed(state, (_next, scenario) => {
    patchKnown(scenario.target, action.patch, TARGET_FIELDS);
    if (scenario.target.mode === 'new') scenario.target.baseSource = null;
  });
  if (action.type === 'update-architecture') return changed(state, (_next, scenario) => {
    patchKnown(scenario.architecture, action.patch, ARCHITECTURE_FIELDS);
    if (scenario.architecture.delivery === 'minimal') scenario.architecture.deliverySource = null;
  });
  if (action.type === 'add-selection') return changed(state, (_next, scenario) => {
    const entry = state.catalog.find(({ key }) => key === action.catalogKey);
    if (!entry || !scenario.includedSources.includes(entry.sourceId)) fail('Choose a capability from an included source.');
    const reserved = new Set(scenario.selections.map(({ id }) => id));
    for (const dependency of scenario.dependencies) { reserved.add(dependency.from); reserved.add(dependency.to); }
    let sequence = 1; while (reserved.has(`choice-${sequence}`)) sequence += 1;
    const id = action.id || `choice-${sequence}`;
    if (!validId(id) || reserved.has(id)) fail('Selection ID must be unique and cannot rebind a dependency identity.');
    scenario.selections.push({ id, source: entry.sourceId, kind: entry.kind, name: entry.name, targetName: entry.name, disposition: 'defer', rationale: 'Review this source-qualified capability for the shared foundation.' });
  });
  if (action.type === 'update-selection') return changed(state, (_next, scenario) => {
    const selection = scenario.selections.find(({ id }) => id === action.id);
    if (!selection) fail('Unknown selection.');
    patchKnown(selection, action.patch, ['targetName', 'disposition', 'rationale']);
  });
  if (action.type === 'remove-selection') return changed(state, (_next, scenario) => {
    const before = scenario.selections.length;
    scenario.selections = scenario.selections.filter(({ id }) => id !== action.id);
    if (scenario.selections.length === before) fail('Unknown selection.');
    scenario.dependencies = scenario.dependencies.filter(({ from }) => from !== action.id);
  });
  if (action.type === 'exclude-source') {
    const current = activeScenario(state);
    if (!current.includedSources.includes(action.sourceId)) fail('Source is not included.');
    if (current.includedSources.length <= 2) fail('At least two sources must remain included.');
    if (current.target.mode === 'evolve' && current.target.baseSource === action.sourceId) fail('Change the target base source before excluding it.');
    if (current.architecture.delivery === 'preserve' && current.architecture.deliverySource === action.sourceId) fail('Change the preserved delivery source before excluding it.');
    const removedIds = new Set(current.selections.filter(({ source }) => source === action.sourceId).map(({ id }) => id));
    const retainedEdges = current.dependencies.filter(({ from, to }) => !removedIds.has(from) && removedIds.has(to)).length;
    const consequences = [`Removed ${removedIds.size} selection${removedIds.size === 1 ? '' : 's'} from ${action.sourceId}.`];
    if (retainedEdges) consequences.push(`Retained ${retainedEdges} dependenc${retainedEdges === 1 ? 'y' : 'ies'} as ${retainedEdges === 1 ? 'an ' : ''}unresolved prerequisite${retainedEdges === 1 ? '' : 's'}.`);
    return changed(state, (_next, scenario) => {
      scenario.includedSources = scenario.includedSources.filter((id) => id !== action.sourceId);
      scenario.selections = scenario.selections.filter(({ id }) => !removedIds.has(id));
      scenario.dependencies = scenario.dependencies.filter(({ from }) => !removedIds.has(from));
    }, consequences);
  }
  if (action.type === 'include-source') return changed(state, (_next, scenario) => {
    if (!state.project.sources.some(({ id }) => id === action.sourceId) || scenario.includedSources.includes(action.sourceId)) fail('Source cannot be included.');
    scenario.includedSources.push(action.sourceId);
  }, [`Included ${action.sourceId}. Add source-qualified capabilities deliberately.`]);
  if (action.type === 'add-dependency') return changed(state, (_next, scenario) => {
    const dependency = exact(action.dependency, DEPENDENCY_FIELDS, 'dependency');
    textValue(dependency.rationale, 'Dependency rationale');
    if (!scenario.selections.some(({ id }) => id === dependency.from) || !validId(dependency.to)) fail('Dependency identity is invalid.');
    scenario.dependencies.push(deepClone(dependency));
  });
  if (action.type === 'update-dependency') return changed(state, (_next, scenario) => {
    const dependency = scenario.dependencies[action.index];
    if (!dependency) fail('Unknown dependency.');
    patchKnown(dependency, action.patch, DEPENDENCY_FIELDS);
  });
  if (action.type === 'remove-dependency') return changed(state, (_next, scenario) => { scenario.dependencies.splice(action.index, 1); });
  fail(`Unsupported workspace action: ${action.type}.`);
}

export function serializeProject(state) {
  const project = validateProjectImport(state.project, state.catalogPins);
  return `${JSON.stringify(project, null, 2)}\n`;
}

function escapeText(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}
function option(value, current, label = value) { return `<option value="${escapeText(value)}"${value === current ? ' selected' : ''}>${escapeText(label)}</option>`; }
function renderCatalog(state) {
  const scenario = activeScenario(state);
  const entries = catalogEntries(state.blueprint, state.filter).filter(({ sourceId }) => scenario.includedSources.includes(sourceId));
  return entries.length ? entries.map((entry) => `<li class="catalog-item"><span><strong>${escapeText(entry.name)}</strong><small>${escapeText(entry.sourceId)} · ${escapeText(entry.kind)} · ${escapeText(entry.status)}</small></span><button type="button" data-add="${escapeText(entry.key)}">Add</button></li>`).join('') : '<li class="empty">No capabilities match this filter.</li>';
}
function renderSelections(state) {
  const scenario = activeScenario(state);
  return scenario.selections.length ? scenario.selections.map((selection) => `<li class="choice" data-selection="${escapeText(selection.id)}"><header><span><strong>${escapeText(selection.targetName)}</strong><small>${escapeText(selection.source)} / ${escapeText(selection.kind)} / ${escapeText(selection.name)} · ID: ${escapeText(selection.id)}</small></span><button type="button" class="quiet danger" data-remove="${escapeText(selection.id)}">Remove</button></header><div class="choice-grid"><label>Target name<input data-field="targetName" value="${escapeText(selection.targetName)}"></label><label>Disposition<select data-field="disposition">${['retain', 'adapt', 'exclude', 'defer'].map((value) => option(value, selection.disposition)).join('')}</select></label></div><label>Rationale<textarea data-field="rationale">${escapeText(selection.rationale)}</textarea></label></li>`).join('') : '<li class="empty">No contributions yet. Add source-qualified capabilities from the catalog.</li>';
}
function renderDependencies(state) {
  const scenario = activeScenario(state); const ids = new Set(scenario.selections.map(({ id }) => id));
  return scenario.dependencies.length ? scenario.dependencies.map((dependency, index) => `<li class="dependency${ids.has(dependency.to) ? '' : ' unresolved'}" data-dependency="${index}"><div class="dependency-fields"><label>From<input data-dependency-field="from" value="${escapeText(dependency.from)}"></label><label>To<input data-dependency-field="to" value="${escapeText(dependency.to)}"></label><label>Rationale<input data-dependency-field="rationale" value="${escapeText(dependency.rationale)}"></label><small>${ids.has(dependency.to) ? 'Declared prerequisite' : 'Unresolved prerequisite'}</small></div><button type="button" class="quiet danger" data-remove-dependency="${index}">Remove</button></li>`).join('') : '<li class="empty">No dependencies declared.</li>';
}
function renderInspection(state) {
  const target = state.blueprint?.scenarios?.find(({ id }) => id === state.activeScenarioId);
  const inspection = document.querySelector('#snapshot-insights');
  const comparisons = document.querySelector('#comparison-list');
  if (state.status === 'needs-cli-validation') {
    inspection.innerHTML = '<p class="stale-copy"><strong>Edited planning choices.</strong> Original blocker counts, checks, and findings are stale and hidden until the CLI validates a downloaded project.</p>';
    comparisons.innerHTML = '<li class="empty">Scenario comparisons are stale after edits. Validate a new output to refresh them.</li>';
    return;
  }
  const blockers = target?.blockers?.length ?? target?.blockerCount ?? 0;
  const findings = target?.findings?.length ?? 0;
  const checks = target?.checks ?? [];
  const messages = [...(target?.blockers ?? []), ...(target?.findings ?? [])].slice(0, 8).map((item) => `<li>${escapeText(item.message ?? item.kind ?? 'Recorded finding')}</li>`).join('');
  inspection.innerHTML = `<dl class="inspection-facts"><div><dt>Blockers</dt><dd>${blockers}</dd></div><div><dt>Findings</dt><dd>${findings}</dd></div><div><dt>Checks</dt><dd>${checks.length ? checks.map(({ status }) => escapeText(status)).join(', ') : 'not reported'}</dd></div></dl>${messages ? `<ul class="inspection-messages">${messages}</ul>` : ''}`;
  const records = (state.blueprint?.comparisons ?? []).filter(({ baselineScenario, scenario }) => baselineScenario === state.activeScenarioId || scenario === state.activeScenarioId);
  comparisons.innerHTML = records.length ? records.map((record) => `<li class="comparison"><strong>${escapeText(record.baselineScenario)} → ${escapeText(record.scenario)}</strong><span>Sources +${record.sourceChanges?.added?.length ?? 0} / −${record.sourceChanges?.removed?.length ?? 0}; selections ${record.selectionChanges?.length ?? 0}; dependencies +${record.dependencyChanges?.added?.length ?? 0} / −${record.dependencyChanges?.removed?.length ?? 0}.</span><small>Planning difference only. Compatibility and effort remain unverified.</small></li>`).join('') : '<li class="empty">Branch a scenario to compare planning choices after CLI validation.</li>';
}
function renderApp(state) {
  const scenario = activeScenario(state); const sourceNames = Object.fromEntries((state.blueprint.sources ?? []).map((source) => [source.id, source.identity?.name ?? source.id]));
  document.querySelector('#workspace-status').textContent = state.status === 'needs-cli-validation' ? 'Needs CLI validation' : 'CLI-validated snapshot';
  document.querySelector('#workspace-status').dataset.status = state.status;
  document.querySelector('#scenario-tabs').innerHTML = state.project.scenarios.map(({ id, title }) => `<button type="button" class="scenario-tab" data-scenario="${escapeText(id)}" aria-pressed="${id === state.activeScenarioId}">${escapeText(title)}</button>`).join('');
  document.querySelector('#source-list').innerHTML = state.project.sources.map((source) => `<li class="source-row"><span><strong>${escapeText(sourceNames[source.id] ?? source.id)}</strong><small>${escapeText(source.id)} · pinned</small></span>${scenario.includedSources.includes(source.id) ? `<button type="button" class="quiet" data-exclude="${escapeText(source.id)}"${scenario.includedSources.length <= 2 ? ' disabled title="At least two sources must remain"' : ''}>Exclude</button>` : `<button type="button" class="quiet" data-include="${escapeText(source.id)}">Include</button>`}</li>`).join('');
  document.querySelector('#catalog-list').innerHTML = renderCatalog(state);
  document.querySelector('#selection-list').innerHTML = renderSelections(state);
  document.querySelector('#dependency-list').innerHTML = renderDependencies(state);
  document.querySelector('#target-name').value = scenario.target.name;
  document.querySelector('#target-mode').value = scenario.target.mode;
  document.querySelector('#base-source').innerHTML = option('', scenario.target.baseSource ?? '', 'None') + scenario.includedSources.map((id) => option(id, scenario.target.baseSource ?? '')).join('');
  document.querySelector('#base-source').disabled = scenario.target.mode === 'new';
  for (const field of ['layout', 'topology', 'delivery']) document.querySelector(`#architecture-${field}`).value = scenario.architecture[field];
  document.querySelector('#delivery-source').innerHTML = option('', scenario.architecture.deliverySource ?? '', 'None') + scenario.includedSources.map((id) => option(id, scenario.architecture.deliverySource ?? '')).join('');
  document.querySelector('#delivery-source').disabled = scenario.architecture.delivery === 'minimal';
  document.querySelector('#undo').disabled = !state.history.length; document.querySelector('#redo').disabled = !state.future.length;
  const consequences = document.querySelector('#consequences');
  consequences.hidden = !state.consequences.length; consequences.textContent = state.consequences.join(' ');
  document.querySelector('#validation-note').hidden = state.status !== 'needs-cli-validation';
  renderInspection(state);
}

function download(name, body) {
  const link = document.createElement('a'); link.download = name; link.href = URL.createObjectURL(new Blob([body], { type: 'application/json' })); link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 0);
}
function bootstrap() {
  const projectData = document.querySelector('#rhubase-project'); const blueprintData = document.querySelector('#rhubase-blueprint');
  if (!projectData || !blueprintData) return;
  let state = createWorkspaceState(JSON.parse(projectData.textContent), JSON.parse(blueprintData.textContent));
  const act = (action) => { try { state = applyWorkspaceAction(state, action); renderApp(state); document.querySelector('#message').textContent = ''; } catch (error) { document.querySelector('#message').textContent = error.message; } };
  renderApp(state);
  document.addEventListener('click', (event) => {
    const button = event.target.closest('button'); if (!button) return;
    if (button.dataset.scenario) act({ type: 'switch-scenario', id: button.dataset.scenario });
    else if (button.dataset.add) act({ type: 'add-selection', catalogKey: button.dataset.add });
    else if (button.dataset.remove) act({ type: 'remove-selection', id: button.dataset.remove });
    else if (button.dataset.exclude) act({ type: 'exclude-source', sourceId: button.dataset.exclude });
    else if (button.dataset.include) act({ type: 'include-source', sourceId: button.dataset.include });
    else if (button.dataset.removeDependency) act({ type: 'remove-dependency', index: Number(button.dataset.removeDependency) });
  });
  document.querySelector('#catalog-filter').addEventListener('input', (event) => { state = applyWorkspaceAction(state, { type: 'set-filter', value: event.target.value }); renderApp(state); event.target.focus(); });
  document.querySelector('#selection-list').addEventListener('change', (event) => { const choice = event.target.closest('[data-selection]'); if (choice && event.target.dataset.field) act({ type: 'update-selection', id: choice.dataset.selection, patch: { [event.target.dataset.field]: event.target.value } }); });
  document.querySelector('#target-name').addEventListener('change', (event) => act({ type: 'update-target', patch: { name: event.target.value } }));
  document.querySelector('#target-mode').addEventListener('change', (event) => act({ type: 'update-target', patch: { mode: event.target.value, baseSource: event.target.value === 'new' ? null : activeScenario(state).includedSources[0] } }));
  document.querySelector('#base-source').addEventListener('change', (event) => act({ type: 'update-target', patch: { baseSource: event.target.value || null } }));
  for (const field of ['layout', 'topology', 'delivery']) document.querySelector(`#architecture-${field}`).addEventListener('change', (event) => act({ type: 'update-architecture', patch: field === 'delivery' ? { delivery: event.target.value, deliverySource: event.target.value === 'minimal' ? null : activeScenario(state).includedSources[0] } : { [field]: event.target.value } }));
  document.querySelector('#delivery-source').addEventListener('change', (event) => act({ type: 'update-architecture', patch: { deliverySource: event.target.value || null } }));
  document.querySelector('#dependency-list').addEventListener('change', (event) => { const row = event.target.closest('[data-dependency]'); if (row && event.target.dataset.dependencyField) act({ type: 'update-dependency', index: Number(row.dataset.dependency), patch: { [event.target.dataset.dependencyField]: event.target.value } }); });
  document.querySelector('#undo').addEventListener('click', () => act({ type: 'undo' })); document.querySelector('#redo').addEventListener('click', () => act({ type: 'redo' }));
  document.querySelector('#branch').addEventListener('click', () => { const id = document.querySelector('#branch-id').value; const title = document.querySelector('#branch-title').value; act({ type: 'branch-scenario', id, title }); });
  document.querySelector('#add-dependency').addEventListener('click', () => act({ type: 'add-dependency', dependency: { from: document.querySelector('#dependency-from').value, to: document.querySelector('#dependency-to').value, rationale: document.querySelector('#dependency-rationale').value } }));
  document.querySelector('#export').addEventListener('click', () => { try { download('rhubase-project.json', serializeProject(state)); state = { ...state, savedRevision: JSON.stringify(state.project) }; } catch (error) { document.querySelector('#message').textContent = error.message; } });
  document.querySelector('#import').addEventListener('change', async (event) => { try { const file = event.target.files[0]; if (!file || file.size > 1024 * 1024) fail('Project file must be no larger than 1 MiB.'); const value = parseProjectText(await file.text(), state.catalogPins); act({ type: 'import-project', project: value }); } catch (error) { document.querySelector('#message').textContent = `Import rejected: ${error.message}`; } finally { event.target.value = ''; } });
  addEventListener('beforeunload', (event) => { if (JSON.stringify(state.project) !== state.savedRevision) { event.preventDefault(); event.returnValue = ''; } });
}
if (typeof document !== 'undefined') bootstrap();
