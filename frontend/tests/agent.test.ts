import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Net } from '../src/model/net.ts';
import { Cli } from '../src/ios/cli.ts';
import { parseQuestion } from '../src/agent/nlu.ts';
import { solveQuestion } from '../src/agent/agent.ts';
import { EXAMPLES } from '../src/agent/examples.ts';
import { toMarkdown } from '../src/agent/report.ts';
import { diagnose, autoFix } from '../src/agent/doctor.ts';
import { injectFault, FAULT_KINDS, availableFaults } from '../src/agent/faults.ts';
import { runChecks, scoreOf } from '../src/agent/verify.ts';
import { vlsmAllocate, parseCidr, overlaps } from '../src/agent/ipam.ts';

async function solve(question: string) {
  Cli.resetAll();
  const net = new Net();
  const outcome = await solveQuestion(question, net);
  assert.ok(outcome.ok, outcome.reason);
  assert.ok(outcome.solution);
  return { net, solution: outcome.solution };
}

test('every example question is solved with a perfect score', async () => {
  for (const example of EXAMPLES) {
    const { solution } = await solve(example.question);
    assert.equal(solution.score.percent, 100, example.label);
    assert.ok(solution.score.total > 0, example.label);
    if (solution.failover) {
      assert.equal(solution.failover.passed, true, example.label);
    }
  }
});

test('the question is understood', () => {
  const ospf = parseQuestion('Configure OSPF on 4 routers in a ring with 2 PCs per LAN');
  assert.equal(ospf.ok, true);
  assert.equal(ospf.spec.routing, 'ospf');
  assert.equal(ospf.spec.routers, 4);
  assert.equal(ospf.spec.shape, 'ring');

  const vlans = parseQuestion('VLAN 10 Sales and VLAN 20 Engineering with router-on-a-stick');
  assert.equal(vlans.spec.family, 'vlan');
  assert.equal(vlans.spec.interVlan, 'roas');
  assert.equal(vlans.spec.vlans.length, 2);

  const nonsense = parseQuestion('what is the weather like');
  assert.equal(nonsense.ok, false);
});

test('VLSM allocation fits the largest block first and does not overlap', () => {
  const base = parseCidr('192.168.10.0/24');
  assert.ok(base);
  const outcome = vlsmAllocate(base, [
    { index: 0, hosts: 10 },
    { index: 1, hosts: 100 },
    { index: 2, hosts: 25 },
    { index: 3, hosts: 50 },
  ]);
  assert.equal(outcome.error, null);
  assert.deepEqual(
    outcome.allocations.map(item => item.cidr.prefix),
    [28, 25, 27, 26],
  );
  for (let first = 0; first < outcome.allocations.length; first++) {
    for (let second = first + 1; second < outcome.allocations.length; second++) {
      assert.equal(overlaps(outcome.allocations[first].cidr, outcome.allocations[second].cidr), false);
    }
  }
  const tooBig = vlsmAllocate(base, [{ index: 0, hosts: 200 }, { index: 1, hosts: 200 }]);
  assert.ok(tooBig.error);
});

test('a clean solution has no findings and exports a report', async () => {
  const { net, solution } = await solve(EXAMPLES[0].question);
  assert.equal(diagnose(net, solution.plan).length, 0);
  const markdown = toMarkdown(solution);
  assert.ok(markdown.includes('## Configurations'));
  assert.ok(markdown.includes('## Verification'));
});

test('the doctor repairs every kind of injected fault', async () => {
  const questions = [EXAMPLES[0].question, EXAMPLES[1].question, EXAMPLES[2].question, EXAMPLES[7].question];
  let injected = 0;
  for (const question of questions) {
    const { net: probe } = await solve(question);
    const kinds = availableFaults(probe);
    for (const kind of FAULT_KINDS) {
      if (!kinds.includes(kind)) {
        continue;
      }
      const { net, solution } = await solve(question);
      const fault = injectFault(net, 11, kind);
      assert.ok(fault, `${kind} could not be injected`);
      injected += 1;
      assert.ok(diagnose(net, solution.plan).length > 0, `${kind} was not detected`);
      await autoFix(net, undefined, solution.plan);
      const score = scoreOf(runChecks(net, solution.plan));
      assert.equal(score.percent, 100, `${kind}: ${fault.title}`);
      assert.equal(diagnose(net, solution.plan).length, 0, `${kind} left findings`);
    }
  }
  assert.ok(injected >= 20);
});
