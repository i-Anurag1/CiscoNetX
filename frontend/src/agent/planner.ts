import { buildLan } from './lanlab.ts';
import type { Plan } from './plan.ts';
import { buildRouted } from './routed.ts';
import { normalizeSpec, type LabSpec } from './spec.ts';
import { buildVlan } from './vlanlab.ts';

export function compile(input: LabSpec): Plan {
  const checked = normalizeSpec(input);
  const spec = checked.spec;
  let plan: Plan;
  if (spec.family === 'vlan') {
    plan = buildVlan(spec);
  } else if (spec.family === 'routed') {
    plan = buildRouted(spec);
  } else {
    plan = buildLan(spec);
  }
  for (const warning of checked.warnings) {
    if (!plan.notes.includes(warning)) {
      plan.notes.push(warning);
    }
  }
  return plan;
}
