import { useEffect, useRef } from 'react';
import { Cli } from '../ios/cli.ts';
import { solveQuestion, PHASES, type AgentOutcome, type PhaseId, type PhaseStatus } from '../agent/agent.ts';
import { toMarkdown } from '../agent/report.ts';
import { formatConfig } from '../agent/plan.ts';
import { EXAMPLES } from '../agent/examples.ts';
import { autoFix, diagnose, flushDynamicState, type Finding } from '../agent/doctor.ts';
import { injectFault, FAULT_KINDS, FAULT_LABELS, availableFaults, type Fault, type FaultKind } from '../agent/faults.ts';
import { runChecks, scoreOf, type CheckResult, type Score } from '../agent/verify.ts';
import { net, ui, uiTouch, useRev, sim, commit, toast, type WinState } from './store.ts';
import { Win } from './Windows.tsx';

type Tab = 'solve' | 'doctor';
type ResultTab = 'summary' | 'addressing' | 'configs' | 'checks' | 'evidence' | 'viva';
type Speed = 'instant' | 'fast' | 'normal' | 'slow';

const SPEED_MS: Record<Speed, number> = {
  instant: 0,
  fast: 70,
  normal: 200,
  slow: 480,
};

interface PhaseView {
  status: PhaseStatus;
  message: string;
}

interface AgentState {
  tab: Tab;
  resultTab: ResultTab;
  speed: Speed;
  question: string;
  running: boolean;
  phases: Record<PhaseId, PhaseView>;
  log: string[];
  outcome: AgentOutcome | null;
  failure: string;
  configKey: string;
  signal: { cancelled: boolean } | null;
  findings: Finding[] | null;
  doctorMessage: string;
  lastFault: Fault | null;
  faultKind: string;
  faultCount: number;
  busy: boolean;
  recheck: { score: Score; results: CheckResult[] } | null;
}

function freshPhases(): Record<PhaseId, PhaseView> {
  const result = {} as Record<PhaseId, PhaseView>;
  for (const item of PHASES) {
    result[item.id] = { status: 'pending', message: '' };
  }
  return result;
}

export const agentState: AgentState = {
  tab: 'solve',
  resultTab: 'summary',
  speed: 'fast',
  question: '',
  running: false,
  phases: freshPhases(),
  log: [],
  outcome: null,
  failure: '',
  configKey: '',
  signal: null,
  findings: null,
  doctorMessage: '',
  lastFault: null,
  faultKind: 'random',
  faultCount: 0,
  busy: false,
  recheck: null,
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

export function openAgent(tab: Tab = 'solve'): void {
  agentState.tab = tab;
  const existing = ui.wins.find(item => item.id === 'agent');
  if (existing) {
    existing.z = ++ui.zTop;
    uiTouch();
    return;
  }
  const width = 560;
  const left = Math.max(10, window.innerWidth - width - 70);
  ui.wins.push({
    id: 'agent',
    kind: 'agent',
    title: 'AI Network Agent',
    x: left,
    y: 62,
    z: ++ui.zTop,
  });
  uiTouch();
}

export function fitToDevices(reserveRight = 0): void {
  if (net.devices.length === 0) {
    return;
  }
  const xs = net.devices.map(item => item.x);
  const ys = net.devices.map(item => item.y);
  const left = Math.min(...xs) - 60;
  const right = Math.max(...xs) + 60;
  const top = Math.min(...ys) - 60;
  const bottom = Math.max(...ys) + 80;
  const element = document.querySelector('.ws-svg') as SVGSVGElement | null;
  const width = Math.max(300, (element ? element.clientWidth : 900) - reserveRight);
  const height = element ? element.clientHeight : 500;
  const zoom = Math.min(1.6, Math.max(0.3, Math.min(width / (right - left), height / (bottom - top))));
  ui.zoom = zoom;
  ui.panX = -left * zoom + (width - (right - left) * zoom) / 2;
  ui.panY = -top * zoom + (height - (bottom - top) * zoom) / 2;
  uiTouch();
}

function clearCanvas(): void {
  Cli.resetAll();
  net.clear();
  ui.pdus = [];
  ui.selected = [];
  ui.pduN = 1;
  sim.events = [];
  sim.cursor = 0;
  sim.last = [];
  ui.panX = 40;
  ui.panY = 20;
  ui.zoom = 1;
  commit();
  uiTouch();
}

function agentReserve(): number {
  const open = ui.wins.some(item => item.id === 'agent');
  return open ? 580 : 0;
}

async function runSolve(): Promise<void> {
  if (agentState.running) {
    return;
  }
  const question = agentState.question.trim();
  if (question.length === 0) {
    agentState.failure = 'Type a networking question first, or pick an example.';
    uiTouch();
    return;
  }
  if (net.devices.length > 0 && !window.confirm('The agent will replace the current topology. Continue?')) {
    return;
  }

  agentState.running = true;
  agentState.phases = freshPhases();
  agentState.log = [];
  agentState.outcome = null;
  agentState.failure = '';
  agentState.recheck = null;
  agentState.findings = null;
  agentState.resultTab = 'summary';
  const signal = { cancelled: false };
  agentState.signal = signal;
  uiTouch();

  const delay = SPEED_MS[agentState.speed];
  let outcome: AgentOutcome;
  try {
    outcome = await solveQuestion(question, net, {
      signal,
      prepare: () => {
        clearCanvas();
      },
      onPhase: (phase, status, message) => {
        agentState.phases[phase] = { status, message };
        uiTouch();
      },
      onLog: line => {
        agentState.log.push(line);
        uiTouch();
      },
      onRun: event => {
        if (event.kind === 'device' && (event.index % 4 === 0 || event.index === event.total)) {
          fitToDevices(agentReserve());
        }
        if (event.kind === 'settle') {
          fitToDevices(agentReserve());
        }
      },
      pause: async kind => {
        if (delay === 0) {
          return;
        }
        let wait = delay;
        if (kind === 'cable') {
          wait = Math.round(delay * 0.6);
        } else if (kind === 'config') {
          wait = Math.round(delay * 1.6);
        } else if (kind === 'dhcp') {
          wait = Math.round(delay * 0.5);
        }
        await sleep(wait);
      },
      finished: () => {
        commit();
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unexpected error';
    outcome = { ok: false, reason: `The agent hit an error: ${message}`, solution: null };
  }

  agentState.running = false;
  agentState.signal = null;
  agentState.outcome = outcome;
  if (!outcome.ok) {
    agentState.failure = outcome.reason;
  } else if (outcome.solution) {
    const first = outcome.solution.plan.configs[0];
    agentState.configKey = first ? first.key : '';
    toast(`Solved: ${outcome.solution.score.passed} of ${outcome.solution.score.total} checks passed.`, 5000);
  }
  fitToDevices(agentReserve());
  uiTouch();
}

function stopSolve(): void {
  if (agentState.signal) {
    agentState.signal.cancelled = true;
  }
}

function download(name: string, text: string, type: string): void {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([text], { type }));
  link.download = name;
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(link.href);
  }, 2000);
}

function downloadReport(): void {
  const outcome = agentState.outcome;
  if (!outcome || !outcome.solution) {
    return;
  }
  const title = outcome.solution.plan.spec.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  download(`${title}-solution.md`, toMarkdown(outcome.solution), 'text/markdown');
}

function downloadTopology(): void {
  download('agent-solution.cnx', net.snapshot(), 'application/json');
}

function knownPlan() {
  const outcome = agentState.outcome;
  if (outcome && outcome.solution) {
    return outcome.solution.plan;
  }
  return undefined;
}

function refreshFindings(): void {
  agentState.findings = diagnose(net, knownPlan());
  if (agentState.findings.length === 0) {
    agentState.doctorMessage = 'No problems found. The network looks healthy.';
  } else {
    agentState.doctorMessage = `${agentState.findings.length} problem${agentState.findings.length === 1 ? '' : 's'} found.`;
  }
  uiTouch();
}

async function fixOne(finding: Finding): Promise<void> {
  if (!finding.fix || agentState.busy) {
    return;
  }
  agentState.busy = true;
  uiTouch();
  await finding.fix.apply(net);
  flushDynamicState(net);
  net.settle();
  commit();
  agentState.busy = false;
  refreshFindings();
}

async function fixAll(): Promise<void> {
  if (agentState.busy) {
    return;
  }
  agentState.busy = true;
  agentState.doctorMessage = 'Repairing...';
  uiTouch();
  const report = await autoFix(net, undefined, knownPlan());
  commit();
  agentState.busy = false;
  const left = report.remaining.length;
  agentState.findings = report.remaining;
  agentState.doctorMessage =
    left === 0
      ? `Fixed ${report.applied.length} problem${report.applied.length === 1 ? '' : 's'}. The network is healthy again.`
      : `Applied ${report.applied.length} fixes, ${left} problem${left === 1 ? '' : 's'} still need attention.`;
  rerunChecks();
  uiTouch();
}

function breakIt(): void {
  if (net.devices.length === 0) {
    agentState.doctorMessage = 'Build or open a network first.';
    uiTouch();
    return;
  }
  agentState.faultCount += 1;
  const seed = (Date.now() + agentState.faultCount * 7919) % 1000000;
  const kind = agentState.faultKind === 'random' ? undefined : (agentState.faultKind as FaultKind);
  const fault = injectFault(net, seed, kind);
  if (!fault) {
    agentState.lastFault = null;
    agentState.doctorMessage = 'This network has nothing of that kind to break.';
    uiTouch();
    return;
  }
  net.settle();
  commit();
  agentState.lastFault = fault;
  agentState.recheck = null;
  refreshFindings();
  rerunChecks();
}

function rerunChecks(): void {
  const outcome = agentState.outcome;
  if (!outcome || !outcome.solution) {
    agentState.recheck = null;
    return;
  }
  const results = runChecks(net, outcome.solution.plan);
  agentState.recheck = { score: scoreOf(results), results };
  uiTouch();
}

const ICONS: Record<PhaseStatus, string> = {
  pending: '○',
  running: '◔',
  done: '✔',
  skipped: '–',
  failed: '✖',
};

function Timeline() {
  return (
    <ol className="ag-phases">
      {PHASES.map(item => {
        const view = agentState.phases[item.id];
        return (
          <li key={item.id} className={`ph-${view.status}`}>
            <span className="ph-ico">{ICONS[view.status]}</span>
            <span className="ph-title">{item.title}</span>
            <span className="ph-msg">{view.message}</span>
          </li>
        );
      })}
    </ol>
  );
}

function LogBox() {
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (box.current) {
      box.current.scrollTop = box.current.scrollHeight;
    }
  });
  return (
    <div className="ag-log" ref={box}>
      {agentState.log.length === 0 ? <span className="muted">The agent's notes appear here.</span> : null}
      {agentState.log.map((line, index) => (
        <div key={index}>{line}</div>
      ))}
    </div>
  );
}

function ScoreBadge({ score }: { score: Score }) {
  const good = score.percent === 100;
  return (
    <span className={`ag-score ${good ? 'good' : 'bad'}`}>
      {score.passed}/{score.total} checks · {score.percent}%
    </span>
  );
}

function ResultView() {
  const outcome = agentState.outcome;
  if (!outcome || !outcome.solution) {
    return null;
  }
  const solution = outcome.solution;
  const plan = solution.plan;
  const tabs: Array<[ResultTab, string]> = [
    ['summary', 'Summary'],
    ['addressing', 'Addressing'],
    ['configs', 'Configs'],
    ['checks', 'Checks'],
    ['evidence', 'Evidence'],
    ['viva', 'Viva'],
  ];
  const config = plan.configs.find(item => item.key === agentState.configKey) ?? plan.configs[0];

  return (
    <div className="ag-result">
      <div className="ag-result-head">
        <b>{plan.spec.title}</b>
        <ScoreBadge score={solution.score} />
        <span className="grow" />
        <button onClick={downloadReport}>Download report</button>
        <button onClick={downloadTopology}>Save .cnx</button>
        <button onClick={() => fitToDevices(agentReserve())}>Fit</button>
      </div>
      <div className="ag-tabs">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            className={agentState.resultTab === id ? 'on' : ''}
            onClick={() => {
              agentState.resultTab = id;
              uiTouch();
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="ag-result-body">
        {agentState.resultTab === 'summary' && (
          <div>
            <ul className="ag-list">
              {solution.understanding.notes.map((line, index) => (
                <li key={`n${index}`}>{line}</li>
              ))}
              {solution.understanding.assumptions.map((line, index) => (
                <li key={`a${index}`}>
                  <i>Assumption:</i> {line}
                </li>
              ))}
              {plan.notes.map((line, index) => (
                <li key={`p${index}`}>
                  <i>Note:</i> {line}
                </li>
              ))}
            </ul>
            <h5>Solution steps</h5>
            <ol className="ag-list">
              {plan.steps.map((step, index) => (
                <li key={index}>
                  <b>{step.title}</b> {step.detail}
                </li>
              ))}
            </ol>
            {solution.repairs && solution.repairs.applied.length > 0 ? (
              <div>
                <h5>
                  Self-healing ({solution.firstScore.passed}/{solution.firstScore.total} before, {solution.score.passed}/{solution.score.total} after)
                </h5>
                <ul className="ag-list">
                  {solution.repairs.applied.map((item, index) => (
                    <li key={index}>
                      {item.title}: {item.fix ? item.fix.text : ''}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {solution.failover ? (
              <div>
                <h5>Link failure test: {solution.failover.passed ? 'passed' : 'failed'}</h5>
                <table className="grid">
                  <tbody>
                    <tr>
                      <td>Failed link</td>
                      <td>{solution.failover.linkLabel}</td>
                    </tr>
                    <tr>
                      <td>Before</td>
                      <td>{solution.failover.before.path.join(' → ')}</td>
                    </tr>
                    <tr>
                      <td>While down</td>
                      <td>{solution.failover.during.ok ? solution.failover.during.path.join(' → ') : 'no connectivity'}</td>
                    </tr>
                    <tr>
                      <td>Restored</td>
                      <td>{solution.failover.after.path.join(' → ')}</td>
                    </tr>
                  </tbody>
                </table>
                <p className="muted">{solution.failover.summary}</p>
              </div>
            ) : null}
          </div>
        )}

        {agentState.resultTab === 'addressing' && (
          <div>
            {plan.subnets.length > 0 ? (
              <table className="grid ag-table">
                <thead>
                  <tr>
                    <th>Subnet</th>
                    <th>Network</th>
                    <th>Mask</th>
                    <th>Usable range</th>
                    <th>Broadcast</th>
                    <th>Purpose</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.subnets.map((row, index) => (
                    <tr key={index}>
                      <td>{row.name}</td>
                      <td>
                        {row.network}/{row.prefix}
                      </td>
                      <td>{row.mask}</td>
                      <td>
                        {row.first} – {row.last} ({row.usable})
                      </td>
                      <td>{row.broadcast}</td>
                      <td>{row.purpose}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            <table className="grid ag-table">
              <thead>
                <tr>
                  <th>Device</th>
                  <th>Interface</th>
                  <th>IP address</th>
                  <th>Mask</th>
                  <th>Gateway</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {plan.addresses.map((row, index) => (
                  <tr key={index}>
                    <td>{row.device}</td>
                    <td>{row.iface}</td>
                    <td>{row.ip}</td>
                    <td>{row.mask}</td>
                    <td>{row.gateway}</td>
                    <td>{row.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <h5>Cabling</h5>
            <table className="grid ag-table">
              <tbody>
                {plan.links.map((link, index) => (
                  <tr key={index}>
                    <td>{link.a}</td>
                    <td>{link.pa}</td>
                    <td>↔</td>
                    <td>{link.b}</td>
                    <td>{link.pb}</td>
                    <td>{link.label}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {agentState.resultTab === 'configs' && (
          <div className="ag-configs">
            <div className="ag-cfg-nav">
              {plan.configs.map(item => (
                <button
                  key={item.key}
                  className={config && config.key === item.key ? 'on' : ''}
                  onClick={() => {
                    agentState.configKey = item.key;
                    uiTouch();
                  }}
                >
                  {item.key}
                </button>
              ))}
            </div>
            <pre className="ag-code">{config ? `! ${config.title}\n${formatConfig(config.lines)}` : 'No configuration needed.'}</pre>
          </div>
        )}

        {agentState.resultTab === 'checks' && (
          <table className="grid ag-table">
            <thead>
              <tr>
                <th>Result</th>
                <th>Check</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {solution.results.map((item, index) => (
                <tr key={index}>
                  <td className={item.passed ? 'ok' : 'bad'}>{item.passed ? 'PASS' : 'FAIL'}</td>
                  <td>{item.check.label}</td>
                  <td>{item.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {agentState.resultTab === 'evidence' && (
          <div>
            {solution.evidence.map((item, index) => (
              <div key={index} className="ag-evidence">
                <b>
                  {item.key}# {item.command}
                </b>
                <div className="muted">{item.why}</div>
                <pre className="ag-code">{item.output}</pre>
              </div>
            ))}
          </div>
        )}

        {agentState.resultTab === 'viva' && (
          <ol className="ag-list">
            {plan.viva.map((item, index) => (
              <li key={index}>
                <b>{item.question}</b>
                <div>{item.answer}</div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function SolveTab() {
  return (
    <div className="ag-pane">
      <textarea
        className="ag-question"
        rows={3}
        placeholder="Describe the lab, e.g. “Three routers in a triangle running OSPF with a LAN behind each router and NAT to an ISP”"
        value={agentState.question}
        disabled={agentState.running}
        onChange={event => {
          agentState.question = event.target.value;
          uiTouch();
        }}
        onKeyDown={event => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            void runSolve();
          }
        }}
      />
      <div className="ag-actions">
        {agentState.running ? (
          <button className="ag-go stop" onClick={stopSolve}>
            Stop
          </button>
        ) : (
          <button className="ag-go" onClick={() => void runSolve()}>
            ✦ Solve it for me
          </button>
        )}
        <label>
          Build speed{' '}
          <select
            value={agentState.speed}
            disabled={agentState.running}
            onChange={event => {
              agentState.speed = event.target.value as Speed;
              uiTouch();
            }}
          >
            <option value="instant">Instant</option>
            <option value="fast">Fast</option>
            <option value="normal">Normal</option>
            <option value="slow">Slow</option>
          </select>
        </label>
        <span className="muted">Ctrl+Enter</span>
      </div>
      <div className="ag-chips">
        {EXAMPLES.map(item => (
          <button
            key={item.label}
            disabled={agentState.running}
            title={item.question}
            onClick={() => {
              agentState.question = item.question;
              uiTouch();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      {agentState.failure ? <div className="ag-error">{agentState.failure}</div> : null}
      <Timeline />
      <LogBox />
      <ResultView />
    </div>
  );
}

function DoctorTab() {
  const kinds = availableFaults(net);
  const findings = agentState.findings;
  const recheck = agentState.recheck;
  return (
    <div className="ag-pane">
      <p className="muted ag-intro">
        The Network Doctor inspects any topology on the canvas, explains what is wrong in plain words and repairs it with the same commands an engineer would type.
      </p>
      <div className="ag-actions">
        <button className="ag-go" disabled={agentState.busy || net.devices.length === 0} onClick={refreshFindings}>
          Diagnose
        </button>
        <button className="ag-go alt" disabled={agentState.busy || net.devices.length === 0} onClick={() => void fixAll()}>
          Fix everything
        </button>
      </div>
      <div className="ag-break">
        <b>Break it</b>
        <select
          value={agentState.faultKind}
          onChange={event => {
            agentState.faultKind = event.target.value;
            uiTouch();
          }}
        >
          <option value="random">Random fault</option>
          {FAULT_KINDS.filter(kind => kinds.includes(kind)).map(kind => (
            <option key={kind} value={kind}>
              {FAULT_LABELS[kind]}
            </option>
          ))}
        </select>
        <button disabled={agentState.busy || net.devices.length === 0} onClick={breakIt}>
          Inject fault
        </button>
      </div>
      {agentState.lastFault ? (
        <div className="ag-fault">
          <b>Sabotage:</b> {agentState.lastFault.title}
          <div className="muted">{agentState.lastFault.detail}</div>
        </div>
      ) : null}
      {agentState.doctorMessage ? <div className="ag-note">{agentState.doctorMessage}</div> : null}
      {recheck ? (
        <div className="ag-note">
          Lab checks after your change: <ScoreBadge score={recheck.score} />
          {recheck.results
            .filter(item => !item.passed)
            .slice(0, 5)
            .map((item, index) => (
              <div key={index} className="bad">
                ✖ {item.check.label}: {item.detail}
              </div>
            ))}
        </div>
      ) : null}
      {findings && findings.length > 0 ? (
        <div className="ag-findings">
          {findings.map(item => (
            <div key={item.id} className={`ag-finding sev-${item.severity}`}>
              <div className="ag-find-head">
                <b>{item.title}</b>
                <span className="ag-tag">{item.phase}</span>
              </div>
              <div className="muted">{item.detail}</div>
              {item.fix ? (
                <div className="ag-find-fix">
                  <span>
                    Fix: {item.fix.text}
                    <code>{item.fix.commands.join('  ·  ')}</code>
                  </span>
                  <button disabled={agentState.busy} onClick={() => void fixOne(item)}>
                    Apply
                  </button>
                </div>
              ) : (
                <div className="muted">No automatic fix available.</div>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function AgentWin({ w }: { w: WinState }) {
  useRev();
  const tabs: Array<[Tab, string]> = [
    ['solve', '✦ Solve a question'],
    ['doctor', '⚕ Network Doctor'],
  ];
  return (
    <Win w={w} width={560}>
      <div className="tabs">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            className={agentState.tab === id ? 'on' : ''}
            onClick={() => {
              agentState.tab = id;
              uiTouch();
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="tab-body ag-body">{agentState.tab === 'solve' ? <SolveTab /> : <DoctorTab />}</div>
    </Win>
  );
}
