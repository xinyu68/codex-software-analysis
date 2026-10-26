export const METHODS = ['static_inspection', 'existing_log', 'user_report', 'process_snapshot', 'network_capture', 'functional_test', 'other'];
export const NETWORK_SCOPES = ['not_assessed', 'connection_snapshot', 'capture_window', 'isolation_test'];

export function validateVerification(value, level) {
  if (!value) {
    if (level === 'live_verified') throw new Error('live_verified requires an explicit verification scope');
    return null;
  }
  if (!METHODS.includes(value.method) || !['tool', 'user', 'external'].includes(value.observedBy) ||
      !['subject', 'coverage'].every(key => typeof value[key] === 'string' && value[key].trim()) ||
      !NETWORK_SCOPES.includes(value.networkScope)) throw new Error('Invalid verification scope');
  if (level === 'live_verified') {
    if (!['process_snapshot', 'network_capture', 'functional_test'].includes(value.method) || value.observedBy === 'user') {
      throw new Error('User reports and existing logs are observations, not independent live verification');
    }
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/;
    if (!iso.test(value.startedAt || '') || !iso.test(value.endedAt || '')) throw new Error('Live verification time window requires ISO timestamps with timezone');
    const start = Date.parse(value.startedAt), end = Date.parse(value.endedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new Error('Live verification requires an ordered observation time window');
  }
  if (value.method === 'user_report' && value.observedBy !== 'user') throw new Error('A user report must identify the user as observer');
  if (value.method === 'functional_test' && !['input', 'expectedOutput', 'actualOutput'].every(key => typeof value[key] === 'string' && value[key].trim())) {
    throw new Error('Functional tests require input, expectedOutput and actualOutput');
  }
  if (value.method === 'process_snapshot' && !['not_assessed', 'connection_snapshot'].includes(value.networkScope)) {
    throw new Error('A process snapshot cannot establish packet capture or network isolation');
  }
  if (value.networkScope === 'capture_window' && value.method !== 'network_capture') throw new Error('A capture window requires network_capture');
  if (value.networkScope === 'isolation_test' && value.method !== 'functional_test') throw new Error('Isolation requires an explicit functional test, not a connection snapshot');
  return structuredClone(value);
}

export function verificationLines(value) {
  if (!value) return ['验证范围：未结构化记录；不能由证据等级推导更广的验证范围'];
  const fields = [['方法', value.method], ['观察者', value.observedBy], ['对象', value.subject],
    ['时间', value.startedAt || value.endedAt ? `${value.startedAt || '?'} — ${value.endedAt || '?'}` : '未记录'],
    ['覆盖范围', value.coverage], ['网络证据范围', value.networkScope], ['输入', value.input],
    ['预期输出', value.expectedOutput], ['实际输出', value.actualOutput]];
  return fields.filter(([, text]) => text).map(([label, text]) => `${label}：${text}`);
}
