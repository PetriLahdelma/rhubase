import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createPlan } from '../src/contract.mjs';
import { writeJson } from '../src/files.mjs';
import { migrate, verify } from '../src/run.mjs';
import { writeReport } from '../src/report.mjs';

await fs.mkdir('.shift', { recursive: true });
const study = await fs.mkdtemp(path.resolve('.shift/demo-'));
for (const app of ['checkout', 'account']) {
  const plan = await createPlan(`fixtures/consolidation/${app}/case.json`);
  const file = path.join(study, app + '-plan.json');
  await writeJson(file, plan);
  const run = await migrate(file, path.join(study, app));
  await verify(run.dir, process.env.SHIFT_TEST_IMAGE ?? 'node:22-alpine');
  const report = await writeReport(run.dir);
  console.log(`${app}: ${report.counts.changed}/${report.counts.registered} registered sites changed; ${report.fixtureResult}`);
  console.log(path.join(run.dir, 'report.md'));
  if (report.fixtureResult !== 'partial-with-blockers') process.exitCode = 1;
}
console.log('Controlled fixtures only. No AI comparison, real React migration, or time-savings claim.');
