import { createServer } from 'node:http';
import { lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { findBrowser } from './environment.mjs';
import { ReaSession } from './rea-session.mjs';
import { redact } from './projects.mjs';

const MAX_CAPTURE_BYTES = 128 * 1024 * 1024;
export function summarizeCapture(capture) {
  const events = capture.events?.items || [];
  const requests = events.filter(item => item.kind === 'request');
  const responses = new Map(events.filter(item => item.kind === 'response').map(item => [item.transaction_id, item]));
  const content = new Map(events.filter(item => item.kind === 'network-content' && item.phase === 'response').map(item => [item.transaction_id, item]));
  const endpointMap = new Map();
  for (const request of requests) {
    if (!request.url?.url) continue;
    let url; try { url = new URL(request.url.url); } catch { continue; }
    const key = JSON.stringify([request.method, url.origin, url.pathname, [...url.searchParams.keys()].sort()]);
    if (!endpointMap.has(key)) endpointMap.set(key, { method: request.method, origin: url.origin, path: url.pathname, queryParameterNames: [...url.searchParams.keys()], requests: 0, statuses: [], responseJsonKeys: [], credentialHeaderNames: [] });
    const entry = endpointMap.get(key); entry.requests++;
    const response = responses.get(request.transaction_id);
    if (response?.status !== null && response?.status !== undefined && !entry.statuses.includes(response.status)) entry.statuses.push(response.status);
    entry.credentialHeaderNames = [...new Set([...entry.credentialHeaderNames, ...(request.header_names || []).filter(name => /token|authorization|cookie/i.test(name))])];
    const body = content.get(request.transaction_id)?.body;
    if (body?.state === 'captured' && /json/i.test(body.media_type || '') && body.bytes < 1024 * 1024) {
      try {
        const json = JSON.parse(Buffer.from(body.content, body.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8'));
        if (json && typeof json === 'object') entry.responseJsonKeys = [...new Set([...entry.responseJsonKeys, ...Object.keys(json)])].slice(0, 100);
      } catch { /* Keep an undecoded response unknown. */ }
    }
  }
  const websockets = events.filter(item => item.kind.startsWith('websocket')).map(item => {
    let url; try { url = new URL(item.url.url); } catch { return null; }
    let jsonKeys = [], method = null;
    try { const json = JSON.parse(item.payload_text); jsonKeys = Object.keys(json); if (typeof json.method === 'string' && json.method.length < 40) method = json.method; } catch {}
    return { kind: item.kind, origin: url.origin, path: url.pathname, queryParameterNames: [...url.searchParams.keys()], payloadBytes: item.payload_bytes ?? null, jsonKeys, method };
  }).filter(Boolean);
  const last = capture.steps?.at(-1);
  const finalUrl = redact(last?.after_url?.url || '');
  const pageText = last?.artifacts?.accessibility?.value?.text || '';
  const challengeHint = /captcha|challenge|security.?check/i.test(finalUrl) || /安全验证|请输入验证码|verify you are human|checking your browser/i.test(pageText.slice(0, 800));
  return { finalUrl, pageAccess: challengeHint ? 'verification_page_observed' : capture.steps?.some(step => step.status !== 'completed') ? 'load_incomplete' : 'captured',
    steps: capture.steps?.map(step => ({ stepId: step.step_id, status: step.status, elapsedMs: step.elapsed_ms, error: redact(step.error || '') })) || [],
    durationMs: capture.duration_ms, completeness: capture.completeness, droppedEvents: capture.events?.dropped ?? null,
    httpRequestCount: requests.length, endpoints: [...endpointMap.values()], websockets,
    limitations: [...(capture.limitations || []), 'Endpoint receipt does not prove UI causality. WebSocket handshakes/heartbeats do not alone prove quote delivery.',
      'Browser access, direct HTTP replay and token generation are separate findings. Raw capture is retained privately; the summary omits payload values and URL tokens.'] };
}

export async function privateArea(directory) {
  const area = path.join(directory, 'artifacts');
  await mkdir(area, { recursive: true });
  if ((await lstat(area)).isSymbolicLink() || path.dirname(await realpath(area)) !== directory) throw new Error('Artifact directory must stay inside the project');
  return area;
}

export async function captureWebsite(service, { projectId, observeMs = 10000, timeoutSeconds = 90 }, signal) {
  if (observeMs + 6000 >= timeoutSeconds * 1000) throw new Error('Observation window must leave at least six seconds for navigation and cleanup');
  const project = await service.projects.load(projectId);
  if (project.state !== 'open' || project.target.type !== 'website') throw new Error('Select an open website project');
  if (!service.config.rea) throw new Error('REA is missing; run the setup skill');
  const browser = await findBrowser(service.config);
  if (!browser) throw new Error('Chrome/Edge executable not found; configure SOFTWARE_ANALYSIS_BROWSER');
  const area = await privateArea(project.directory), runId = randomUUID().replaceAll('-', '');
  const rawFile = path.join(area, `${runId}.private.json`);
  const bundleFile = path.join(area, `${runId}-bundle.private.json`);
  const scriptsDirectory = path.join(area, `${runId}-scripts`);
  const bootstrap = createServer((request, response) => { response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); response.end('<!doctype html><title>Analysis bootstrap</title>'); });
  const session = new ReaSession(service.config);
  let timer, exportedFallback = false, outcome;
  const deadline = new AbortController();
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  try {
    timer = setTimeout(() => deadline.abort(new Error('Website observation deadline exceeded')), timeoutSeconds * 1000);
    await new Promise((resolve, reject) => { bootstrap.once('error', reject); bootstrap.listen(0, '127.0.0.1', resolve); });
    await session.open(combined);
    let evidence;
    try {
      evidence = await session.call('capture_browser_scenario', {
        browser: { mode: 'launch', executable_path: browser, headless: true },
        start_url: { url: `http://127.0.0.1:${bootstrap.address().port}/` },
        actions: [{ step_id: 'open_target', action: 'goto', destination: { url: project.target.targetUrl }, wait_until: 'domcontentloaded', timeout_ms: Math.min(30000, timeoutSeconds * 1000 - observeMs - 5000) },
          { step_id: 'observe', action: 'wait_for_timeout', duration_ms: observeMs }],
        capture: { at_end: ['url', 'dom', 'accessibility'], events: ['network', 'websockets', 'page-errors'], network: { request_body: true, response_body: true, header_values: false } },
      }, combined, timeoutSeconds * 1000);
    } catch (error) {
      if (error.provider?.code !== 'resource_constraint' || error.provider?.details?.resource !== 'transport') throw error;
      exportedFallback = true;
      await session.call('export_evidence_bundle', { path: bundleFile }, combined, 30000);
      if ((await stat(bundleFile)).size > MAX_CAPTURE_BYTES) throw new Error('Retained browser bundle exceeds 128 MiB; shorten the observation window');
      const bundle = JSON.parse(await readFile(bundleFile, 'utf8'));
      evidence = bundle.records?.filter(item => item.operation === 'capture_browser_scenario').at(-1);
      if (!evidence) throw new Error('REA retained no browser capture; export did not establish capture success');
    }
    if (!evidence.normalized_result?.steps || evidence.operation !== 'capture_browser_scenario') throw new Error('Unexpected REA capture shape');
    await writeFile(rawFile, JSON.stringify(evidence), { flag: 'wx', mode: 0o600 });
    const summary = summarizeCapture(evidence.normalized_result);
    const network = await service.projects.addEvidence(projectId, { payload: summary, kind: 'network_capture', description: 'REA 浏览器请求、WebSocket 和验证状态摘要', sourcePath: rawFile });
    const pageText = evidence.normalized_result.steps.at(-1)?.artifacts?.accessibility?.value?.text;
    const page = pageText ? await service.projects.addEvidence(projectId, { payload: pageText, kind: 'runtime', description: '浏览器最终页面的可访问文本', sourcePath: rawFile }) : null;
    let scripts = null, scriptError = null;
    try { scripts = await session.call('export_web_scripts', { capture_path: rawFile, output_directory: scriptsDirectory }, combined, 30000); }
    catch (error) { scriptError = error.message; }
    const scriptCount = scripts?.normalized_result?.scripts?.filter(item => item.content.state === 'exported').length || 0;
    outcome = { projectId, status: summary.pageAccess === 'captured' ? 'completed' : 'partial', pageAccess: summary.pageAccess,
      networkEvidenceId: network.id, pageEvidenceId: page?.id || null, rawCapturePath: rawFile, rawCapturePrivate: true,
      transportBudgetFallback: exportedFallback, finalUrl: summary.finalUrl,
      scriptCount, scriptsInput: scripts?.normalized_result?.analysis_input || null, scriptError,
      cleanup: 'pending', nextStep: 'Read the registered summary, analyze the exported scripts, and record supported findings. Verification pages are observations; no bypass or replay was performed.' };
    await service.projects.mutate(projectId, value => value.runs.push({ profile: 'web', status: outcome.status, evidenceId: network.id, scriptsInput: outcome.scriptsInput, createdAt: new Date().toISOString() }));
    return outcome;
  } finally {
    clearTimeout(timer);
    await new Promise(resolve => { if (!bootstrap.listening) return resolve(); bootstrap.closeAllConnections(); bootstrap.close(resolve); });
    await session.close();
    if (outcome) outcome.cleanup = 'closed';
  }
}
