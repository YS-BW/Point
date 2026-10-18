/**
 * 确定性测试用的假模型通道。
 *
 * 用 pi-ai 官方提供的 faux provider，让整个验证不依赖任何真实模型凭据，
 * 因此可以随时复跑、可进 CI。真实模型路径保留在 src/session-service.mjs，
 * 只要 modelRef 换成真实 provider/model 即可，不需要改这层的任何代码。
 */
import {
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
  registerFauxProvider,
} from "@earendil-works/pi-ai/compat";

export { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall };

/**
 * 注册假 provider；同一进程内只需注册一次。
 *
 * 注意：registerFauxProvider 默认会把 api 取成 `faux:<时间戳>:<随机>`（见 pi-ai
 * providers/faux.ts 的 `options.api ?? randomId(DEFAULT_API)`）。那样它就匹配不上
 * .pi/agent/models.json 里声明的 "api": "faux"，运行时会报
 * "No API provider registered for api: faux" —— 是个不报错在加载期、只在对话期暴露的坑。
 * 所以这里必须显式固定 api 名，和 models.json 保持一致。
 */
export function startFauxProvider(options = {}) {
  return registerFauxProvider({ api: "faux", provider: "faux", tokensPerSecond: 40, ...options });
}

/** 脚本化一轮"先调工具、再给最终答复"的完整响应。 */
export function scriptToolThenAnswer(provider, { tool, args, answer, thinking }) {
  provider.setResponses([
    fauxAssistantMessage([
      ...(thinking === undefined ? [] : [fauxThinking(thinking)]),
      fauxToolCall(tool, args),
    ]),
    fauxAssistantMessage(answer),
  ]);
}
