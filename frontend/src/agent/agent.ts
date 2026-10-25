import type { Net } from '../model/net.ts';
import { parseQuestion, type Understanding } from './nlu.ts';
import { compile } from './planner.ts';
import { buildPlan, type ExecResult, type RunEvent } from './executor.ts';
import {
  gatherEvidence,
  runChecks,
  runFailover,
  scoreOf,
  type CheckResult,
  type Evidence,
  type FailoverResult,
  type Score,
} from './verify.ts';
import { autoFix, diagnose, type RepairReport } from './doctor.ts';
import type { Plan } from './plan.ts';
import type { LabSpec } from './spec.ts';

export type PhaseId = 'understand' | 'plan' | 'build' | 'configure' | 'verify' | 'heal' | 'failover' | 'report';
export type PhaseStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed';

export interface PhaseInfo {
  id: PhaseId;
  title: string;
}

export const PHASES: PhaseInfo[] = [
  { id: 'understand', title: 'Understand the question' },
  { id: 'plan', title: 'Design topology and addressing' },
  { id: 'build', title: 'Place devices and connect cables' },
  { id: 'configure', title: 'Type the IOS configuration' },
  { id: 'verify', title: 'Verify with pings, HTTP and route checks' },
  { id: 'heal', title: 'Self-heal anything that failed' },
  { id: 'failover', title: 'Run the link-failure test' },
  { id: 'report', title: 'Write the solution sheet' },
];

export interface Solution {
  question: string;
  understanding: Understanding;
  spec: LabSpec;
  plan: Plan;
  exec: ExecResult;
  results: CheckResult[];
  score: Score;
  evidence: Evidence[];
  failover: FailoverResult | null;
  repairs: RepairReport | null;
  firstScore: Score;
}

export interface AgentHooks {
  onPhase?: (phase: PhaseId, status: PhaseStatus, message: string) => void;
  onLog?: (line: string) => void;
  onRun?: (event: RunEvent) => void;
  onPlan?: (plan: Plan, understanding: Understanding) => void;
  pause?: (kind: RunEvent['kind']) => Promise<void>;
  prepare?: () => void;
  finished?: () => void;
  signal?: { cancelled: boolean };
}

export interface AgentOutcome {
  ok: boolean;
  reason: string;
  solution: Solution | null;
}

function unchanged(): void {}

export async function solveQuestion(question: string, net: Net, hooks: AgentHooks = {}): Promise<AgentOutcome> {
  const phase = hooks.onPhase ?? unchanged;
  const log = hooks.onLog ?? unchanged;
  const cancelled = (): boolean => Boolean(hooks.signal && hooks.signal.cancelled);

  const trimmed = question.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'Type a networking question first.', solution: null };
  }

  phase('understand', 'running', 'Reading the question');
  const understanding = parseQuestion(trimmed);
  if (!understanding.ok) {
    phase('understand', 'failed', understanding.reason);
    return { ok: false, reason: understanding.reason, solution: null };
  }
  for (const line of understanding.notes) {
    log(line);
  }
  for (const line of understanding.assumptions) {
    log(`Assumption: ${line}`);
  }
  for (const line of understanding.warnings) {
    log(`Note: ${line}`);
  }
  phase('understand', 'done', understanding.spec.title);

  phase('plan', 'running', 'Choosing devices, subnets and routing');
  let plan: Plan;
  try {
    plan = compile(understanding.spec);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'planning failed';
    phase('plan', 'failed', message);
    return { ok: false, reason: `Could not design this lab: ${message}`, solution: null };
  }
  log(`${plan.devices.length} devices, ${plan.links.length} cables, ${plan.configs.length} configurations`);
  phase('plan', 'done', `${plan.devices.length} devices, ${plan.links.length} cables`);
  if (hooks.onPlan) {
    hooks.onPlan(plan, understanding);
  }

  if (hooks.prepare) {
    hooks.prepare();
  }

  phase('build', 'running', 'Placing devices');
  let configStarted = false;
  const exec = await buildPlan(net, plan, {
    signal: hooks.signal,
    pause: hooks.pause,
    onEvent: event => {
      if (hooks.onRun) {
        hooks.onRun(event);
      }
      if (event.kind === 'device') {
        phase('build', 'running', `Device ${event.index} of ${event.total}`);
      }
      if (event.kind === 'cable') {
        phase('build', 'running', `Cable ${event.index} of ${event.total}`);
      }
      if (event.kind === 'settle' && !configStarted) {
        phase('build', 'done', 'Topology cabled');
        phase('configure', 'running', 'Typing configurations');
        configStarted = true;
      }
      if (event.kind === 'config') {
        phase('configure', 'running', `${event.key}: ${event.lines} lines`);
        log(`Configured ${event.key} (${event.lines} lines)`);
      }
    },
  });

  if (cancelled() || exec.cancelled) {
    phase('configure', 'failed', 'Stopped');
    return { ok: false, reason: 'Stopped before the lab was finished.', solution: null };
  }
  if (!configStarted) {
    phase('build', 'done', 'Topology cabled');
  }
  const configProblems = exec.errors.length + exec.commandIssues.length + exec.dhcpFailures.length;
  phase('configure', configProblems > 0 ? 'failed' : 'done', configProblems > 0 ? `${configProblems} problems while typing` : 'All configurations accepted');
  for (const item of exec.errors) {
    log(`Build problem: ${item}`);
  }
  for (const item of exec.commandIssues) {
    log(`IOS rejected on ${item.key}: ${item.command} => ${item.output}`);
  }

  phase('verify', 'running', 'Running checks');
  let results = runChecks(net, plan);
  let score = scoreOf(results);
  const firstScore = score;
  log(`Verification: ${score.passed} of ${score.total} checks passed`);
  phase('verify', score.percent === 100 ? 'done' : 'failed', `${score.passed} of ${score.total} passed`);

  let repairs: RepairReport | null = null;
  if (score.percent < 100 || diagnose(net, plan).length > 0) {
    phase('heal', 'running', 'Diagnosing');
    repairs = await autoFix(
      net,
      finding => {
        log(`Fixed: ${finding.title} (${finding.fix ? finding.fix.text : ''})`);
      },
      plan,
    );
    results = runChecks(net, plan);
    score = scoreOf(results);
    phase('heal', score.percent === 100 ? 'done' : 'failed', `${repairs.applied.length} repairs, now ${score.passed} of ${score.total}`);
  } else {
    phase('heal', 'skipped', 'Nothing to repair');
  }

  let failover: FailoverResult | null = null;
  if (plan.failover) {
    phase('failover', 'running', 'Taking a link down');
    failover = runFailover(net, plan);
    if (failover) {
      log(failover.summary);
    }
    phase('failover', failover && failover.passed ? 'done' : 'failed', failover ? failover.summary : 'Not available');
  } else {
    phase('failover', 'skipped', 'Not requested');
  }

  phase('report', 'running', 'Collecting show command output');
  const evidence = await gatherEvidence(net, plan);
  net.touch();
  phase('report', 'done', 'Solution ready');

  if (hooks.finished) {
    hooks.finished();
  }

  const solution: Solution = {
    question: trimmed,
    understanding,
    spec: plan.spec,
    plan,
    exec,
    results,
    score,
    evidence,
    failover,
    repairs,
    firstScore,
  };
  return { ok: true, reason: '', solution };
}
