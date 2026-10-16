// Writes dashboards/grafana/roost.json: the starter Grafana dashboard for `roost export` data in Loki
// (Grafana Cloud Logs, or any Loki 3 with OTLP ingestion). Run with `npm run dashboard`.
//
// roost sends OTLP log records; Loki keeps service.name as the stream label and every attribute as
// structured metadata, with dots turned into underscores (roost.tokens.output → roost_tokens_output).
import { writeFileSync, mkdirSync } from 'node:fs';

const out = new URL('../dashboards/grafana/roost.json', import.meta.url);
const ds = { type: 'loki', uid: '${datasource}' };
const sel = (event, extra = '') => `{service_name="roost"} | event_name="${event}" | roost_team=~"$team" | roost_agent=~"$agent"${extra}`;
const sum = (event, field, range = '$__range', by = '', extra = '') =>
  `sum${by ? ` by (${by})` : ''} (sum_over_time(${sel(event, extra)} | unwrap ${field} [${range}]))`;

let id = 0;
let y = 0;
const panels = [];
const row = (title) => { panels.push({ type: 'row', title, id: ++id, collapsed: false, gridPos: { h: 1, w: 24, x: 0, y: y++ }, panels: [] }); };
function panel(type, title, description, targets, { w = 12, h = 8, x = 0, unit, options = {}, fieldConfig = {}, transformations } = {}) {
  panels.push({
    type, title, description, id: ++id, datasource: ds, gridPos: { h, w, x, y },
    targets: targets.map((t, i) => ({ refId: String.fromCharCode(65 + i), datasource: ds, editorMode: 'code', queryType: t.instant ? 'instant' : 'range', expr: t.expr, legendFormat: t.legend ?? '', ...(t.instant ? {} : { step: '1d' }) })),
    fieldConfig: { defaults: { ...(type === 'bargauge' ? amber : {}), ...(unit ? { unit } : {}), ...fieldConfig }, overrides: [] },
    options,
    ...(transformations ? { transformations } : type === 'bargauge' ? { transformations: biggestFirst } : {}),
  });
  if (x + w >= 24) y += h;
}
const stat = { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, colorMode: 'none', graphMode: 'none', textMode: 'value' };
// Instant Loki queries come back as one table (labels as columns, then the value): show every row, not one total.
const bars = { orientation: 'horizontal', displayMode: 'basic', showUnfilled: false, valueMode: 'color', namePlacement: 'left', sizing: 'manual', minVizHeight: 16, maxVizHeight: 22, text: { titleSize: 12, valueSize: 13 }, reduceOptions: { calcs: ['lastNotNull'], fields: '/^Value/', values: true } };
const biggestFirst = [{ id: 'sortBy', options: { sort: [{ field: 'Value #A', desc: true }] } }];
const amber = { color: { mode: 'fixed', fixedColor: '#F2A93B' }, thresholds: { mode: 'absolute', steps: [{ color: '#F2A93B', value: null }] } };
const daily = { drawStyle: 'bars', fillOpacity: 70, stacking: { mode: 'normal', group: 'A' }, barAlignment: 0 };

row('Adoption');
panel('stat', 'Active people', 'Distinct hashed people with at least one session.', [{ instant: true, expr: `count(sum by (roost_person) (count_over_time(${sel('roost.activity')} [$__range])))` }], { w: 6, h: 4, x: 0, options: stat });
panel('stat', 'Sessions', 'Agent sessions, counted once per day they were active.', [{ instant: true, expr: sum('roost.activity', 'roost_sessions') }], { w: 6, h: 4, x: 6, options: stat });
panel('stat', 'Repos', 'Repos with agent sessions.', [{ instant: true, expr: `count(sum by (roost_repo) (count_over_time(${sel('roost.activity')} [$__range])))` }], { w: 6, h: 4, x: 12, options: stat });
panel('stat', 'Skill runs', 'Skills the agents ran.', [{ instant: true, expr: sum('roost.activity', 'roost_skill_runs') }], { w: 6, h: 4, x: 18, options: stat });
panel('timeseries', 'Active people per day, by agent', '', [{ expr: `count by (roost_agent) (sum by (roost_agent, roost_person) (count_over_time(${sel('roost.activity')} [1d])))`, legend: '{{roost_agent}}' }], { x: 0, fieldConfig: { custom: daily } });
panel('bargauge', 'Sessions by team', 'Set ROOST_TEAM on each machine to fill this in.', [{ instant: true, expr: sum('roost.activity', 'roost_sessions', '$__range', 'roost_team'), legend: '{{roost_team}}' }], { x: 12, options: bars });

row('Cost');
panel('timeseries', 'Output tokens per day, by agent', '', [{ expr: sum('roost.activity', 'roost_tokens_output', '1d', 'roost_agent'), legend: '{{roost_agent}}' }], { x: 0, unit: 'short', fieldConfig: { custom: daily } });
panel('timeseries', 'Input tokens per day', 'Uncached input, cache reads and cache writes.', [
  { expr: sum('roost.activity', 'roost_tokens_input', '1d'), legend: 'uncached input' },
  { expr: sum('roost.activity', 'roost_tokens_cache_read', '1d'), legend: 'cache read' },
  { expr: sum('roost.activity', 'roost_tokens_cache_write', '1d'), legend: 'cache write' },
], { x: 12, unit: 'short', fieldConfig: { custom: daily } });
panel('bargauge', 'Output tokens by repo', 'Top 15 repos.', [{ instant: true, expr: `topk(15, ${sum('roost.activity', 'roost_tokens_output', '$__range', 'roost_repo')})`, legend: '{{roost_repo}}' }], { x: 0, w: 12, h: 9, unit: 'short', options: bars });
panel('bargauge', 'Output tokens by team', '', [{ instant: true, expr: sum('roost.activity', 'roost_tokens_output', '$__range', 'roost_team'), legend: '{{roost_team}}' }], { x: 12, w: 12, h: 9, unit: 'short', options: bars });

row('Skills that work');
panel('bargauge', 'Most-run skills', 'Top 15 skills by runs, across agents.', [{ instant: true, expr: `topk(15, ${sum('roost.skill_used', 'roost_runs', '$__range', 'roost_skill')})`, legend: '{{roost_skill}}' }], { x: 0, w: 8, h: 10, options: bars });
panel('bargauge', 'MCP servers by calls', 'A server that loads into every session but is rarely called costs tokens for nothing.', [{ instant: true, expr: `topk(15, ${sum('roost.mcp_used', 'roost_calls', '$__range', 'roost_mcp_server')})`, legend: '{{roost_mcp_server}}' }], { x: 8, w: 8, h: 10, options: bars });
panel('bargauge', 'Your own slash commands', 'The team\'s commands; each agent\'s built-ins are left out.', [{ instant: true, expr: `topk(15, ${sum('roost.command_used', 'roost_uses', '$__range', 'roost_command', ' | roost_builtin="false"')})`, legend: '{{roost_command}}' }], { x: 16, w: 8, h: 10, options: bars });
// Verdicts are per person (each export judges against that person's sessions), so the team view adds them up first:
// a skill nobody used anywhere, though it was available, is a retire candidate; used and with issues, fix it first.
const selV = (extra = '') => `{service_name="roost"} | event_name="roost.verdict" | roost_team=~"$team" | roost_agent=~".*$agent.*"${extra}`;
const usesBy = `sum by (roost_skill, roost_repo) (sum_over_time(${selV()} | unwrap roost_uses [1d]))`;
const scopeBy = `sum by (roost_skill, roost_repo) (sum_over_time(${selV()} | unwrap roost_scope_sessions [1d]))`;
const issuesBy = `max by (roost_skill, roost_repo) (max_over_time(${selV()} | unwrap roost_issues [1d]))`;
const retire = `(${usesBy} == 0) and (${scopeBy} > 0)`;
const fixFirst = `(${usesBy} > 0) and (${issuesBy} > 0)`;
const named = (names) => Object.entries(names).map(([field, name]) => ({ matcher: { id: 'byName', options: field }, properties: [{ id: 'displayName', value: name }] }));
panels.push({
  type: 'stat', title: 'Skills, team-wide', id: ++id, datasource: ds, gridPos: { h: 9, w: 6, x: 0, y },
  description: 'From `roost export --rookery`, latest day: everyone\'s usage added up per skill and repo.',
  targets: [
    { refId: 'A', datasource: ds, editorMode: 'code', queryType: 'instant', expr: `count(${usesBy} > 0)` },
    { refId: 'B', datasource: ds, editorMode: 'code', queryType: 'instant', expr: `count(${fixFirst})` },
    { refId: 'C', datasource: ds, editorMode: 'code', queryType: 'instant', expr: `count(${retire})` },
    { refId: 'D', datasource: ds, editorMode: 'code', queryType: 'instant', expr: `count(sum by (roost_skill, roost_repo) (count_over_time(${selV(' | roost_verdict="merge"')} [1d])))` },
  ],
  fieldConfig: { defaults: { noValue: '0' }, overrides: named({ 'Value #A': 'Used', 'Value #B': 'Fix first', 'Value #C': 'Retire', 'Value #D': 'Duplicates' }) },
  options: { ...stat, textMode: 'value_and_name', orientation: 'horizontal', justifyMode: 'auto' },
});
panel('table', 'Retire: nobody used them', 'Available in sessions, never run by anyone in the window.', [{ instant: true, expr: retire }], {
  x: 6, w: 9, h: 9, options: { showHeader: true },
  transformations: [{ id: 'organize', options: { excludeByName: { Time: true, Value: true, 'Value #A': true }, indexByName: { roost_skill: 0, roost_repo: 1 }, renameByName: { roost_skill: 'Skill', roost_repo: 'Repo' } } }],
});
panel('table', 'Fix first: used, with issues', 'Skills people rely on that rookery found problems in (quality or serious security findings).', [{ instant: true, expr: fixFirst }], {
  x: 15, w: 9, h: 9, options: { showHeader: true, sortBy: [{ displayName: 'Uses', desc: true }] },
  transformations: [{ id: 'organize', options: { excludeByName: { Time: true }, indexByName: { roost_skill: 0, roost_repo: 1, 'Value #A': 2 }, renameByName: { roost_skill: 'Skill', roost_repo: 'Repo', 'Value #A': 'Uses', Value: 'Uses' } } }],
});
y += 9;

row('Factory runs');
const selRun = (extra = '') => sel('roost.run', extra);
const merged = selRun(' | roost_outcome="merged"');
panel('stat', 'Runs', 'Agent jobs in CI: one roost.run row per job, from `roost pipeline`.', [{ instant: true, expr: `count_over_time(${selRun()} [$__range])` }], { w: 8, h: 4, x: 0, options: stat });
panel('stat', 'Success rate', 'Runs whose outcome was merged.', [{ instant: true, expr: `100 * count_over_time(${merged} [$__range]) / count_over_time(${selRun()} [$__range])` }], { w: 8, h: 4, x: 8, unit: 'percent', options: stat });
panel('stat', 'Cost per merged change', 'Tokens spent on runs that merged, divided by how many merged.', [{ instant: true, expr: `sum_over_time(${merged} | unwrap roost_tokens [$__range]) / count_over_time(${merged} [$__range])` }], { w: 8, h: 4, x: 16, unit: 'short', options: stat });
panel('timeseries', 'Runs per day, by outcome', 'The skills behind a run are in "Most-run skills" above, for the same window.', [{ expr: `count by (roost_outcome) (count_over_time(${selRun()} [1d]))`, legend: '{{roost_outcome}}' }], { x: 0, fieldConfig: { custom: daily } });
panel('bargauge', 'Runs by repo', 'Top 15 repos by agent jobs in the window.', [{ instant: true, expr: `topk(15, count by (roost_repo) (count_over_time(${selRun()} [$__range])))`, legend: '{{roost_repo}}' }], { x: 12, options: bars });

row('Safety');
panel('bargauge', 'Blocked, by policy setting', 'Calls rookery\'s hook blocked, by the .rookery.yml setting that blocked them.', [{ instant: true, expr: `${sum('rookery.policy', 'roost_blocked', '$__range', 'roost_setting')} > 0`, legend: '{{roost_setting}}' }], { x: 0, options: bars });
panel('timeseries', 'Blocks and warnings per day', '', [
  { expr: sum('rookery.policy', 'roost_blocked', '1d'), legend: 'blocked' },
  { expr: sum('rookery.policy', 'roost_warned', '1d'), legend: 'warned' },
], { x: 12, fieldConfig: { custom: daily } });

const dashboard = {
  __inputs: [],
  title: 'roost: how your AI agents are used',
  uid: 'roost-agents',
  description: 'Daily, counts-only summaries from `roost export` (Claude Code, Codex, Gemini CLI) and rookery\'s policy hook. https://github.com/thinkingraven/roost',
  tags: ['roost', 'ai-agents'],
  editable: true,
  schemaVersion: 39,
  version: 1,
  time: { from: 'now-30d', to: 'now' },
  refresh: '',
  timezone: 'utc',
  templating: {
    list: [
      { name: 'datasource', label: 'Loki', type: 'datasource', query: 'loki', current: {}, hide: 0 },
      { name: 'team', label: 'Team (regex)', type: 'textbox', query: '.*', current: { text: '.*', value: '.*' }, hide: 0 },
      { name: 'agent', label: 'Agent', type: 'custom', query: 'claude-code,codex,gemini-cli', includeAll: true, allValue: '.*', multi: false, current: { text: 'All', value: '$__all' }, hide: 0 },
    ],
  },
  annotations: { list: [] },
  panels,
};

mkdirSync(new URL('.', out), { recursive: true });
writeFileSync(out, JSON.stringify(dashboard, null, 2) + '\n');
console.log(`dashboards/grafana/roost.json: ${panels.filter((p) => p.type !== 'row').length} panels`);
