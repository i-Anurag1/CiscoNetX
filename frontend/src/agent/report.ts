import { formatConfig } from './plan.ts';
import type { Solution } from './agent.ts';

function row(cells: string[]): string {
  return `| ${cells.map(cell => cell.replace(/\|/g, '/')).join(' | ')} |`;
}

function table(header: string[], rows: string[][]): string[] {
  const lines: string[] = [];
  lines.push(row(header));
  lines.push(row(header.map(() => '---')));
  for (const item of rows) {
    lines.push(row(item));
  }
  return lines;
}

export function toMarkdown(solution: Solution): string {
  const plan = solution.plan;
  const lines: string[] = [];

  lines.push(`# ${plan.spec.title}`);
  lines.push('');
  lines.push(`**Question:** ${solution.question}`);
  lines.push('');
  lines.push(`**Verification score:** ${solution.score.passed} of ${solution.score.total} checks passed (${solution.score.percent}%)`);
  lines.push('');

  lines.push('## What the agent understood');
  lines.push('');
  for (const item of solution.understanding.notes) {
    lines.push(`- ${item}`);
  }
  for (const item of solution.understanding.assumptions) {
    lines.push(`- Assumption: ${item}`);
  }
  for (const item of plan.notes) {
    lines.push(`- Note: ${item}`);
  }
  lines.push('');

  lines.push('## Steps');
  lines.push('');
  plan.steps.forEach((step, index) => {
    lines.push(`${index + 1}. **${step.title}** ${step.detail}`);
  });
  lines.push('');

  lines.push('## Devices');
  lines.push('');
  lines.push(...table(['Name', 'Model', 'Role'], plan.devices.map(item => [item.name, item.model, item.role])));
  lines.push('');

  lines.push('## Cables');
  lines.push('');
  lines.push(...table(['From', 'Port', 'To', 'Port', 'Type'], plan.links.map(item => [item.a, item.pa, item.b, item.pb, item.label])));
  lines.push('');

  if (plan.subnets.length > 0) {
    lines.push('## Subnets');
    lines.push('');
    lines.push(
      ...table(
        ['Name', 'Network', 'Mask', 'First', 'Last', 'Broadcast', 'Usable', 'Purpose'],
        plan.subnets.map(item => [item.name, `${item.network}/${item.prefix}`, item.mask, item.first, item.last, item.broadcast, String(item.usable), item.purpose]),
      ),
    );
    lines.push('');
  }

  if (plan.addresses.length > 0) {
    lines.push('## Addressing');
    lines.push('');
    lines.push(
      ...table(
        ['Device', 'Interface', 'IP address', 'Mask', 'Gateway', 'Note'],
        plan.addresses.map(item => [item.device, item.iface, item.ip, item.mask, item.gateway, item.note]),
      ),
    );
    lines.push('');
  }

  lines.push('## Configurations');
  lines.push('');
  for (const config of plan.configs) {
    lines.push(`### ${config.key} - ${config.title}`);
    lines.push('');
    lines.push('```');
    lines.push(formatConfig(config.lines));
    lines.push('```');
    lines.push('');
  }

  lines.push('## Verification');
  lines.push('');
  lines.push(
    ...table(
      ['Result', 'Check', 'Detail'],
      solution.results.map(item => [item.passed ? 'PASS' : 'FAIL', item.check.label, item.detail]),
    ),
  );
  lines.push('');

  if (solution.failover) {
    lines.push('## Link failure test');
    lines.push('');
    lines.push(`- Failed link: ${solution.failover.linkLabel}`);
    lines.push(`- Before: ${solution.failover.before.path.join(' > ')}`);
    lines.push(`- During: ${solution.failover.during.ok ? solution.failover.during.path.join(' > ') : 'no connectivity'}`);
    lines.push(`- After: ${solution.failover.after.path.join(' > ')}`);
    lines.push(`- Result: ${solution.failover.summary}`);
    lines.push('');
  }

  if (solution.repairs && solution.repairs.applied.length > 0) {
    lines.push('## Self-healing log');
    lines.push('');
    for (const item of solution.repairs.applied) {
      lines.push(`- ${item.title}: ${item.fix ? item.fix.text : ''}`);
    }
    lines.push('');
  }

  lines.push('## Evidence');
  lines.push('');
  for (const item of solution.evidence) {
    lines.push(`### ${item.key}: ${item.command}`);
    lines.push('');
    lines.push(item.why);
    lines.push('');
    lines.push('```');
    lines.push(item.output);
    lines.push('```');
    lines.push('');
  }

  lines.push('## Viva questions');
  lines.push('');
  plan.viva.forEach((item, index) => {
    lines.push(`${index + 1}. **${item.question}**`);
    lines.push(`   ${item.answer}`);
  });
  lines.push('');

  return lines.join('\n');
}
