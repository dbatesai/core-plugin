// Enroll a disposable synthetic project for tests of current project-state writers.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
export function registerFixtureProject(home, project) {
  mkdirSync(project, {recursive:true});
  const core = join(home, '.core');
  mkdirSync(core, {recursive:true});
  const file = join(core, 'projects.json');
  const rows = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  if (!rows.some(row => resolve(row.path) === resolve(project))) rows.push({path:resolve(project)});
  writeFileSync(file, JSON.stringify(rows));
}
