import { runProcess } from './process.mjs';
import { demand } from './files.mjs';

const fixed = ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'user.name=Shift', '-c', 'user.email=shift@localhost'];
async function git(directory, args) {
  const env = { PATH: process.env.PATH ?? '', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  for (const name of ['SYSTEMROOT', 'TMPDIR', 'TEMP', 'TMP']) if (process.env[name]) env[name] = process.env[name];
  return runProcess('git', [...fixed, '-C', directory, ...args], { env, inheritEnv: false });
}

export async function sourceGitState(directory) {
  const probe = await git(directory, ['rev-parse', '--show-toplevel']);
  if (probe.code !== 0) {
    if (probe.stopped === 'ENOENT') return { repository: false, gitUnavailable: true };
    demand(!probe.stopped && /not a git repository/i.test(probe.stderr), `Git inspection failed: ${probe.stopped ?? probe.stderr}`);
    return { repository: false };
  }
  const head = await git(directory, ['rev-parse', '--verify', 'HEAD']);
  const refs = await git(directory, ['show-ref']);
  const branch = await git(directory, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  demand(!head.stopped && !refs.stopped && !branch.stopped && [0, 1, 128].includes(head.code) && [0, 1].includes(refs.code) && [0, 1].includes(branch.code), 'Unable to record source Git identity');
  return { repository: true, root: probe.stdout.trim(), head: head.code === 0 ? head.stdout.trim() : null, refs: refs.stdout.trim(), branch: branch.code === 0 ? branch.stdout.trim() : null };
}

export async function initializeReviewRepository(directory) {
  for (const args of [['init', '-b', 'baseline'], ['add', '-f', '--', '.'], ['commit', '--allow-empty', '-m', 'Preserve the original application for migration review\n\nScope-risk: narrow\nTested: Input snapshot integrity\nNot-tested: Application behavior at this snapshot']]) {
    const result = await git(directory, args);
    demand(result.code === 0 && !result.stopped, `Cannot create candidate review repository: ${result.stderr}`);
  }
}

export async function commitReviewCandidate(directory, name) {
  const branch = `shift/${name}`;
  for (const args of [['checkout', '-b', branch], ['add', '-f', '--', '.'], ['commit', '--allow-empty', '-m', 'Apply reviewed design-system decisions for application review\n\nScope-risk: narrow\nTested: See the adjacent Shift evidence report\nDirective: Review recorded check scope and unresolved usages before applying']]) {
    const result = await git(directory, args);
    demand(result.code === 0 && !result.stopped, `Cannot record candidate review branch: ${result.stderr}`);
  }
  const state = await sourceGitState(directory);
  return { branch, head: state.head, refs: state.refs, base: 'baseline', path: directory };
}
