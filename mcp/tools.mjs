import Ajv from 'ajv';
import { LEVELS } from '../lib/projects.mjs';
import { PROFILES } from '../lib/service.mjs';
import { ENV_PROFILES } from '../lib/environment.mjs';

const text = description => ({ type: 'string', minLength: 1, maxLength: 8000, description });
const projectId = { type: 'string', pattern: '^p_[a-f0-9]{16}$', description: 'analysis_create_project 返回的项目 ID' };
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const definition = (name, description, inputSchema, readOnly = false, openWorld = false) => ({ name, description, inputSchema,
  annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: openWorld } });
export const tools = [
  definition('analysis_status', '只读检查本地 REA、Android 工具路径及本服务拥有的分析任务；不启动目标或模拟器。', schema({}), true),
  definition('analysis_create_project', '为本地软件或 HTTP(S) 网站建立独立项目；创建网站项目不会访问 URL。targetPath 与 targetUrl 二选一。',
    { ...schema({ targetPath: text('目标文件或目录的绝对路径'), targetUrl: text('公开 HTTP(S) URL；不含凭据'), goal: text('本次需要回答的问题'), label: text('可选项目名称') }, ['goal']),
      oneOf: [{ properties: { targetPath: { type: 'string' } }, required: ['targetPath'] }, { properties: { targetUrl: { type: 'string' } }, required: ['targetUrl'] }] }),
  definition('analysis_get_project', '读取项目范围、证据、结论和静态任务记录。', schema({ projectId }, ['projectId']), true),
  definition('analysis_run_static', '调用固定 REA 静态分析命令；不执行目标代码或回放接口。保存结果为证据，返回状态和证据 ID。',
    schema({ projectId, profile: { type: 'string', enum: PROFILES }, timeoutSeconds: { type: 'integer', minimum: 5, maximum: 300 } }, ['projectId', 'profile'])),
  definition('analysis_import_evidence', '导入明确选择的 UTF-8 文本运行记录或其他证据，最多 64 MiB；过滤常见凭据字段。导入不会执行内容或访问记录中的 URL。',
    schema({ projectId, sourcePath: text('证据文件绝对路径'), kind: { type: 'string', enum: ['static', 'runtime', 'network_capture', 'reference'] }, description: text('证据来源和用途') }, ['projectId', 'sourcePath', 'kind', 'description'])),
  definition('analysis_read_evidence', '按字符分页读取已登记且 SHA-256 未改变的证据；返回 nextOffset 供续读。',
    schema({ projectId, evidenceId: { type: 'string', pattern: '^e_[a-f0-9]{16}$' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 24000 } }, ['projectId', 'evidenceId']), true),
  definition('analysis_record_finding', '记录带证据引用的结论，区分观察事实、静态推断、运行验证、未知。运行验证必须引用运行材料。',
    schema({ projectId, statement: text('具体结论'), level: { type: 'string', enum: LEVELS }, evidenceIds: { type: 'array', maxItems: 50, uniqueItems: true, items: { type: 'string', pattern: '^e_[a-f0-9]{16}$' } }, limitations: text('可选限制和未确认事项') }, ['projectId', 'statement', 'level', 'evidenceIds'])),
  definition('analysis_report', '生成包含目标身份、结论、证据和限制的本地 Markdown 报告；不上传、不发布。', schema({ projectId }, ['projectId'])),
  definition('analysis_close_project', '关闭项目并停止本 MCP 服务为该项目启动的分析任务；保留文件，不关闭其他程序。REA 会话及目标程序需由其原工具关闭。', schema({ projectId }, ['projectId'])),
  definition('analysis_check_environment', '按所需分析路线检查依赖；执行版本或 MCP 初始化检查，不打开目标、不启动 adb 服务。', schema({ profile: { type: 'string', enum: ENV_PROFILES } }), true),
  definition('analysis_prepare_environment', '准备选定的缺失 REA、JADX headless 或独立 JDK；默认只返回计划。install=true 才联网安装到受管目录，不修改全局 Java/Android 配置。',
    schema({ components: { type: 'array', uniqueItems: true, maxItems: 3, items: { type: 'string', enum: ['rea', 'jadx', 'jdk'] } }, install: { type: 'boolean', default: false } }, ['components']), false, true),
  definition('analysis_capture_website', '用 REA 在临时浏览器中访问网站项目，记录有时间上限的 HTTP/WebSocket 观察，导出脚本、摘要和私有完整证据；超出 MCP 返回预算时自动导出。结束或取消时回收本次连接。',
    schema({ projectId, observeMs: { type: 'integer', minimum: 100, maximum: 60000 }, timeoutSeconds: { type: 'integer', minimum: 20, maximum: 300 } }, ['projectId']), false, true),
  definition('analysis_record_auth', '登记有证据支持的 token/签名/安全验证机制，区分本地计算与服务器签发，记录有效期、续期和验证范围；不保存 token 值。',
    schema({ projectId, statement: text('具体认证机制结论'), level: { type: 'string', enum: LEVELS },
      evidenceIds: { type: 'array', uniqueItems: true, maxItems: 50, items: { type: 'string', pattern: '^e_[a-f0-9]{16}$' } },
      mechanism: { type: 'string', enum: ['client_computed_token', 'server_issued_session', 'request_signature', 'anti_bot_check', 'unknown'] },
      tokenSource: { type: 'string', enum: ['local', 'server', 'unknown'] }, expiresSeconds: { type: 'integer', minimum: 1 },
      renewal: text('已确认的续期流程或未知'), verifiedScope: text('实际验证到哪一步，例如仅握手或取得业务数据'), limitations: text('未确认事项') },
    ['projectId', 'statement', 'level', 'evidenceIds', 'mechanism', 'tokenSource', 'verifiedScope'])),
];

const ajv = new Ajv({ allErrors: true, strict: true });
const validators = new Map(tools.map(tool => [tool.name, ajv.compile(tool.inputSchema)]));

export async function callTool(service, name, args = {}, signal) {
  const validate = validators.get(name);
  if (!validate) throw new Error(`Unknown tool: ${name}`);
  if (!validate(args)) throw new Error('Invalid arguments: ' + ajv.errorsText(validate.errors));
  switch (name) {
    case 'analysis_status': return service.status();
    case 'analysis_create_project': return service.projects.create(args.targetPath, args.goal, args.label, args.targetUrl);
    case 'analysis_get_project': return service.projects.load(args.projectId);
    case 'analysis_run_static': return service.runStatic(args, signal);
    case 'analysis_import_evidence': return service.importEvidence(args);
    case 'analysis_read_evidence': return service.projects.readEvidence(args.projectId, args.evidenceId, args.offset, args.limit);
    case 'analysis_record_finding': return service.projects.recordFinding(args.projectId, args);
    case 'analysis_report': return service.projects.report(args.projectId);
    case 'analysis_close_project': return service.close(args.projectId);
    case 'analysis_check_environment': return service.checkEnvironment(args, signal);
    case 'analysis_prepare_environment': return service.prepareEnvironment(args, signal);
    case 'analysis_capture_website': return service.captureWebsite(args, signal);
    case 'analysis_record_auth': {
      const { projectId: id, statement, level, evidenceIds, limitations, ...auth } = args;
      return service.projects.recordFinding(id, { statement, level, evidenceIds, limitations, auth });
    }
  }
}
