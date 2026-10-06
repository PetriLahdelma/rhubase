import * as fs from 'node:fs/promises';
import path from 'node:path';
import { digest, jsonDigest, demand, relativePath } from './files.mjs';

const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 5_000_000;
const MAX_TOTAL_BYTES = 100_000_000;
const ignoredDirectories = new Set(['.git', 'node_modules', '.shift', '.omx', '.next', 'dist', 'build', 'coverage']);
const sensitiveDirectories = new Set(['.ssh', '.aws', '.claude', '.codex', '.gnupg']);
const lockfiles = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb']);
const sourcePattern = /\.(?:[cm]?[jt]sx?)$/i;
const stylePattern = /\.(?:css|scss|sass|less|styl)$/i;

function sensitive(name) {
  const lower = name.toLowerCase();
  return /^\.env(?:\.|$)/.test(lower)
    || ['.npmrc', '.netrc', 'id_rsa', 'id_ed25519', 'credentials'].includes(lower)
    || /\.(?:pem|key|p12|pfx)$/.test(lower);
}

function compareText(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function fileKind(file) {
  if (sourcePattern.test(file)) return 'source';
  if (stylePattern.test(file)) return 'style';
  if (file.endsWith('/package.json') || file === 'package.json' || lockfiles.has(path.posix.basename(file))
    || codeownersPath(file) || ciPath(file)) return 'metadata';
  return null;
}
function codeownersPath(file) { return ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS'].includes(file); }
function ciPath(file) {
  return /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(file)
    || ['.gitlab-ci.yml', '.circleci/config.yml', 'azure-pipelines.yml'].includes(file);
}
function dependencyType(spec) {
  if (typeof spec !== 'string') return 'unknown';
  if (/^(?:file|link):/.test(spec)) return 'local';
  if (/^workspace:/.test(spec)) return 'workspace';
  if (/^(?:https?|git\+|git:|github:|gitlab:|bitbucket:)/.test(spec) || /^[^/]+\/[^/]+#/.test(spec)) return 'remote';
  if (/^(?:latest|next|beta|alpha|canary|rc)$/.test(spec)) return 'tag';
  if (/^(?:[~^<>=*]|\d|v\d)/.test(spec)) return 'version';
  return 'unknown';
}
function scriptCategory(name) {
  if (/^(?:test|e2e|integration)(?::|$)/i.test(name)) return 'test';
  if (/^(?:build|bundle|compile)(?::|$)/i.test(name)) return 'build';
  if (/^(?:lint|format|check)(?::|$)/i.test(name)) return 'quality';
  if (/^(?:typecheck|types)(?::|$)/i.test(name)) return 'typecheck';
  if (/^storybook(?::|$)/i.test(name)) return 'storybook';
  return 'other';
}
function workspacePatterns(manifest) {
  const value = manifest.workspaces;
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && Array.isArray(value.packages)) return value.packages;
  return [];
}
function validPackageName(value) { return typeof value === 'string' && /^(?:@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*|[a-z0-9][\w.-]*)$/i.test(value); }

async function readManifest(root, file, expectedSha) {
  const absolute = path.join(root, file); const bytes = await fs.readFile(absolute);
  demand(!expectedSha || digest(bytes) === expectedSha, `Manifest changed during discovery: ${file}`);
  let value;
  try { value = JSON.parse(bytes); } catch (error) { throw new Error(`Invalid ${file}: ${error.message}`); }
  demand(value && typeof value === 'object' && !Array.isArray(value), `Invalid manifest object: ${file}`);
  return { value, sha256: digest(bytes) };
}

async function expandWorkspace(root, pattern, unsupported) {
  if (typeof pattern !== 'string' || !pattern || path.isAbsolute(pattern) || pattern.includes('\\') || pattern.startsWith('!')) {
    unsupported.push({ kind: 'workspace-pattern', reason: `Unsupported workspace pattern: ${String(pattern)}` }); return [];
  }
  const parts = pattern.replace(/\/$/, '').split('/'); const stars = parts.filter((part) => part === '*').length;
  if (stars > 1 || parts.some((part) => !part || part === '.' || part === '..' || (part.includes('*') && part !== '*'))) {
    unsupported.push({ kind: 'workspace-pattern', reason: `Only static paths and one whole-segment wildcard are supported: ${pattern}` }); return [];
  }
  if (!stars) return [parts.join('/')];
  const index = parts.indexOf('*'); const parent = path.join(root, ...parts.slice(0, index));
  let entries;
  try { entries = await fs.readdir(parent, { withFileTypes: true }); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => [...parts.slice(0, index), entry.name, ...parts.slice(index + 1)].join('/')).sort(compareText);
}

function dependencyRecords(manifest) {
  const result = [];
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const values = manifest[section]; if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
    for (const name of Object.keys(values).sort(compareText)) result.push({ name, section, specType: dependencyType(values[name]) });
  }
  return result;
}

function parseCodeowners(text) {
  const rules = []; const unsupported = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.split('#', 1)[0].trim(); if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts[0].startsWith('!') || /[\[\]]/.test(parts[0])) { unsupported.push({ line: index + 1, reason: 'Negation and character-range CODEOWNERS patterns are unsupported' }); continue; }
    if (parts.slice(1).some((owner) => !/^@[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?$/.test(owner) && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(owner))) {
      unsupported.push({ line: index + 1, reason: 'CODEOWNERS owner is neither an @user/@org/team nor an email address' }); continue;
    }
    rules.push({ pattern: parts[0], owners: parts.slice(1), line: index + 1 });
  }
  return { rules, unsupported };
}

export async function inventoryConsumerRepository(input) {
  const stat = await fs.lstat(input); demand(stat.isDirectory() && !stat.isSymbolicLink(), 'Consumer root must be a real directory');
  const root = await fs.realpath(input); const files = []; const excluded = []; const unsupported = [];
  let totalBytes = 0; let totalFiles = 0; let visitedEntries = 0;
  async function visit(directory, prefix = '', depth = 0) {
    demand(depth <= 128, 'Consumer directory depth exceeds 128');
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      visitedEntries += 1; demand(visitedEntries <= 50_000, 'Consumer traversal exceeds 50,000 filesystem entries');
      const file = relativePath(prefix + entry.name); const absolute = path.join(directory, entry.name);
      const item = await fs.lstat(absolute); demand(!item.isSymbolicLink(), `Consumer symlink is outside discovery scope: ${file}`);
      if (item.isDirectory()) {
        const lower = entry.name.toLowerCase();
        if (sensitiveDirectories.has(lower)) { excluded.push({ path: file, reason: 'sensitive credential directory' }); continue; }
        if (ignoredDirectories.has(lower)) { excluded.push({ path: file, reason: 'generated, dependency, or tool directory' }); continue; }
        await visit(absolute, file + '/', depth + 1); continue;
      }
      demand(item.isFile(), `Unsupported consumer filesystem entry: ${file}`);
      if (sensitive(entry.name)) { excluded.push({ path: file, reason: 'sensitive configuration or key file' }); continue; }
      if (/^\.pnp\.(?:cjs|js)$/i.test(entry.name)) { excluded.push({ path: file, reason: 'Yarn Plug\'n\'Play loader is outside v1 resolution scope' }); continue; }
      const kind = fileKind(file);
      if (!kind) { excluded.push({ path: file, reason: 'file type is outside consumer discovery scope' }); continue; }
      totalFiles += 1; totalBytes += item.size;
      demand(totalFiles <= MAX_FILES && totalBytes <= MAX_TOTAL_BYTES, 'Consumer scope exceeds 10,000-file/100 MB discovery budget');
      demand(item.size <= MAX_FILE_BYTES, `Consumer file exceeds 5 MB: ${file}`);
      const bytes = await fs.readFile(absolute);
      files.push({ file, sha256: digest(bytes), bytes: bytes.length, kind });
    }
  }
  await visit(root); files.sort((left, right) => compareText(left.file, right.file)); excluded.sort((left, right) => compareText(left.path, right.path));
  const rootFile = files.find((item) => item.file === 'package.json'); demand(rootFile, 'Consumer repository requires root package.json');
  const manifestFiles = files.filter((item) => item.file === 'package.json' || item.file.endsWith('/package.json'));
  const manifests = []; const manifestValues = new Map();
  for (const item of manifestFiles) {
    const { value } = await readManifest(root, item.file, item.sha256); manifestValues.set(item.file, value);
    manifests.push({ file: item.file, ...(typeof value.name === 'string' ? { name: value.name } : {}), ...(typeof value.version === 'string' ? { version: value.version } : {}), dependencies: dependencyRecords(value) });
  }
  const rootManifest = manifestValues.get('package.json');
  const workspaces = [];
  for (const pattern of workspacePatterns(rootManifest)) for (const workspacePath of await expandWorkspace(root, pattern, unsupported)) {
    const manifestFile = `${workspacePath}/package.json`; const manifest = manifestValues.get(manifestFile);
    if (!manifest) { unsupported.push({ kind: 'workspace-metadata', file: manifestFile, reason: 'Workspace package.json is missing or outside selected metadata' }); continue; }
    workspaces.push({ path: workspacePath, ...(typeof manifest.name === 'string' ? { name: manifest.name } : {}) });
  }
  workspaces.sort((left, right) => compareText(left.path, right.path));
  const workspaceNames = new Set();
  for (const workspace of workspaces) if (workspace.name && workspaceNames.has(workspace.name)) unsupported.push({ kind: 'workspace-identity', reason: `Duplicate workspace package name: ${workspace.name}` }); else if (workspace.name) workspaceNames.add(workspace.name);
  if (files.some((item) => item.file === 'pnpm-workspace.yaml') || excluded.some((item) => item.path === 'pnpm-workspace.yaml')) unsupported.push({ kind: 'workspace-format', file: 'pnpm-workspace.yaml', reason: 'pnpm workspace YAML is recorded but not parsed in v1' });
  if (excluded.some((item) => /(?:^|\/)\.pnp\.(?:cjs|js)$/.test(item.path))) unsupported.push({ kind: 'dependency-layout', reason: 'Yarn Plug\'n\'Play resolution is unsupported in v1' });
  const declaredScripts = [];
  for (const [file, manifest] of manifestValues) if (manifest.scripts && typeof manifest.scripts === 'object' && !Array.isArray(manifest.scripts)) {
    for (const name of Object.keys(manifest.scripts).sort(compareText)) declaredScripts.push({ manifest: file, name, category: scriptCategory(name) });
  }
  declaredScripts.sort((left, right) => compareText(left.name, right.name) || compareText(left.manifest, right.manifest));
  const packageLockfiles = files.filter((item) => lockfiles.has(path.posix.basename(item.file))).map(({ file, sha256 }) => ({ file, sha256 }));
  const ciEvidence = files.filter((item) => ciPath(item.file)).map(({ file, sha256 }) => ({ file, sha256 }));
  const codeowners = []; const ownerPriority = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];
  const availableOwners = new Set(files.filter((candidate) => codeownersPath(candidate.file)).map((item) => item.file));
  const activeOwners = ownerPriority.find((file) => availableOwners.has(file));
  for (const item of files.filter((candidate) => codeownersPath(candidate.file))) {
    const body = await fs.readFile(path.join(root, item.file), 'utf8'); demand(digest(body) === item.sha256, `CODEOWNERS changed during discovery: ${item.file}`);
    const parsed = parseCodeowners(body);
    codeowners.push({ file: item.file, sha256: item.sha256, active: item.file === activeOwners, rules: parsed.rules });
    for (const gap of parsed.unsupported) unsupported.push({ kind: 'codeowners-pattern', file: item.file, reason: `${gap.reason} at line ${gap.line}` });
  }
  const digestValue = jsonDigest(files.map(({ file, sha256, bytes, kind }) => ({ file, sha256, bytes, kind })));
  const result = {
    root, digest: digestValue, files, manifests, workspaces,
    packageManager: { ...(typeof rootManifest.packageManager === 'string' ? { declared: rootManifest.packageManager } : {}), lockfiles: packageLockfiles },
    declaredScripts, ciEvidence, codeowners,
    coverage: { scannedSourceFiles: files.filter((item) => item.kind === 'source' && !/\.d\.[cm]?ts$/i.test(item.file)).length, excluded, unsupported },
  };
  Object.defineProperty(result, '_manifestValues', { value: manifestValues, enumerable: false });
  return result;
}

export async function verifyConsumerInventory(inventory) {
  const current = await inventoryConsumerRepository(inventory.root);
  return current.digest === inventory.digest;
}

function packageNameFromRequest(value) {
  if (validPackageName(value)) return value;
  const at = value.lastIndexOf('@');
  if (at > 0 || (value.startsWith('@') && at > value.indexOf('/'))) throw new Error('Registry package versions are unsupported in v1; use an installed/workspace package name or local path');
  throw new Error(`Invalid package reference: ${value}`);
}
function inside(root, candidate) { const relative = path.relative(root, candidate); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); }
function forbiddenRepositoryRoot(repository, candidate) {
  if (!inside(repository, candidate)) return false;
  const forbidden = new Set(['.git', '.ssh', '.aws', '.claude', '.codex', '.gnupg', '.shift', '.omx']);
  return path.relative(repository, candidate).split(path.sep).some((part) => forbidden.has(part.toLowerCase()));
}

async function packageAt(root, expectedName) {
  const stat = await fs.lstat(root); demand(stat.isDirectory() && !stat.isSymbolicLink(), `Package root must be a real directory: ${root}`);
  const canonical = await fs.realpath(root); const manifestPath = path.join(canonical, 'package.json');
  const manifestStat = await fs.lstat(manifestPath); demand(manifestStat.isFile() && !manifestStat.isSymbolicLink() && manifestStat.size <= MAX_FILE_BYTES, `Package manifest is unsafe: ${manifestPath}`);
  const bytes = await fs.readFile(manifestPath); const manifest = JSON.parse(bytes);
  demand(validPackageName(manifest.name) && typeof manifest.version === 'string' && manifest.version, `Package identity is incomplete: ${manifestPath}`);
  if (expectedName) demand(manifest.name === expectedName, `Resolved package name mismatch: expected ${expectedName}, found ${manifest.name}`);
  return { root: canonical, identity: { name: manifest.name, version: manifest.version }, manifestSha256: digest(bytes) };
}

export async function resolvePackageReference(inventory, specifier, role) {
  demand(['source', 'target'].includes(role), 'Package role must be source or target'); demand(typeof specifier === 'string' && specifier, 'Package specifier required');
  let resolved; let resolution; let importName;
  if (path.isAbsolute(specifier) || specifier.startsWith('./') || specifier.startsWith('../')) {
    resolved = await packageAt(path.isAbsolute(specifier) ? specifier : path.resolve(inventory.root, specifier)); resolution = 'local'; importName = resolved.identity.name;
  } else {
    importName = packageNameFromRequest(specifier);
    const matchingWorkspaces = inventory.workspaces.filter((item) => item.name === importName); demand(matchingWorkspaces.length <= 1, `Workspace package name is ambiguous: ${importName}`);
    const workspace = matchingWorkspaces[0];
    if (workspace) {
      resolved = await packageAt(path.join(inventory.root, workspace.path), importName); resolution = 'workspace';
      const installed = path.join(inventory.root, 'node_modules', ...importName.split('/')); const installedRoot = await fs.realpath(installed).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
      demand(!installedRoot || installedRoot === resolved.root, `Workspace and installed package roots conflict for ${importName}`);
    }
    else {
      const installed = path.join(inventory.root, 'node_modules', ...importName.split('/')); const real = await fs.realpath(installed).catch(() => null);
      demand(real, `Package is not installed or a workspace: ${importName}`); demand(inside(inventory.root, real), `Installed package resolves outside the consumer repository: ${importName}`);
      resolved = await packageAt(real, importName); resolution = 'installed';
    }
  }
  demand(!forbiddenRepositoryRoot(inventory.root, resolved.root), `Package resolves inside protected repository metadata: ${specifier}`);
  const value = { kind: role, specifier, importName, root: resolved.root, resolution, identity: resolved.identity, manifestSha256: resolved.manifestSha256 };
  const portableIdentity = { kind: role, importName, resolution, identity: resolved.identity, manifestSha256: resolved.manifestSha256 };
  return { id: `${role}:${digest(JSON.stringify(portableIdentity)).slice(0, 20)}`, ...value };
}

export function validatePackageSelection(sourcePackages, targetPackage) {
  demand(Array.isArray(sourcePackages) && sourcePackages.length >= 1, 'At least one explicit source package is required');
  const roots = new Set(); const imports = new Set();
  for (const source of sourcePackages) {
    demand(source.kind === 'source' && !roots.has(source.root) && !imports.has(source.importName), 'Source package roots and import names must be unique');
    roots.add(source.root); imports.add(source.importName);
  }
  demand(targetPackage?.kind === 'target' && !roots.has(targetPackage.root), 'Target package must be distinct from every source package');
  return { sourcePackages, targetPackage };
}

export function discoverDesignSystemCandidates(inventory, jsxImports, explicitSources = []) {
  const candidates = new Map();
  const add = (name, basis, evidence = []) => {
    if (!validPackageName(name)) return;
    const current = candidates.get(name) ?? { name, bases: [], evidence: [] };
    if (!current.bases.includes(basis)) current.bases.push(basis);
    current.evidence.push(...evidence); candidates.set(name, current);
  };
  for (const source of explicitSources) add(source.importName ?? source, 'explicit');
  for (const manifest of inventory.manifests) {
    const raw = inventory._manifestValues?.get(manifest.file);
    if (raw?.designSystem === true || (raw?.designSystem && typeof raw.designSystem === 'object')) add(raw.name, 'design-system-metadata', [{ file: manifest.file }]);
  }
  const declared = new Set(inventory.manifests.flatMap((manifest) => manifest.dependencies.map((item) => item.name)));
  for (const item of jsxImports ?? []) if (declared.has(item.package)) add(item.package, 'direct-jsx-import', item.evidence ?? []);
  return [...candidates.values()].map((item) => ({ ...item, bases: item.bases.sort(compareText) })).sort((left, right) => compareText(left.name, right.name));
}
