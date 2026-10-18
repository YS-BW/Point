/**
 * Point Server 验证工程 —— 无终端会话服务
 *
 * 这一层是模块 1（Pi SDK 服务端运行）的骨架：
 *   - 用 SDK 的 SessionManager 管理会话持久化（新建 / 继续最近 / 打开指定）
 *   - 把 session 事件原样暴露出来（后续接 SSE 只需在这层做映射）
 *   - 提供 prompt / steer / followUp / abort 四个控制口
 * 全程不依赖 TTY，不启动任何终端 UI。
 */
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

import { AGENT_DIR, SESSION_DIR, WORKSPACE } from "./paths.mjs";

/**
 * 建 ModelRuntime。注意 SDK 默认读的是全局 ~/.pi/agent 下的 models.json，
 * 这里必须显式指定，否则会去读用户真实配置。
 */
export function createModelRuntime({ agentDir = AGENT_DIR } = {}) {
  return ModelRuntime.create({
    modelsPath: join(agentDir, "models.json"),
    authPath: join(agentDir, "auth.json"),
  });
}

/**
 * 打开一个服务端会话。
 *
 * @param {object} [options]
 * @param {"new"|"continue"} [options.resume]  新建会话，或继续最近一次
 * @param {string} [options.openPath]          直接打开指定会话文件（优先于 resume）
 * @param {string} [options.modelRef]          "provider/modelId"，省略则由 settings/可用模型决定
 * @param {string} [options.cwd]               Agent 工作目录
 */
export async function openServerSession(options = {}) {
  const {
    resume = "new",
    openPath,
    modelRef,
    cwd = WORKSPACE,
    agentDir = AGENT_DIR,
    sessionDir = SESSION_DIR,
    disposeOnExit = true,
    uiContext,
    mode = "print",
  } = options;

  const modelRuntime = await createModelRuntime({ agentDir });

  const sessionManager =
    openPath !== undefined
      ? SessionManager.open(openPath, sessionDir, cwd)
      : resume === "continue"
        ? SessionManager.continueRecent(cwd, sessionDir)
        : SessionManager.create(cwd, sessionDir);

  const createOptions = { cwd, agentDir, sessionManager, modelRuntime };

  if (modelRef !== undefined) {
    const separator = modelRef.indexOf("/");
    if (separator < 0) throw new Error(`modelRef 需要 "provider/modelId" 形式，收到: ${modelRef}`);
    const provider = modelRef.slice(0, separator);
    const modelId = modelRef.slice(separator + 1);
    const model = await modelRuntime.getModel(provider, modelId);
    if (model === undefined) throw new Error(`找不到模型: ${modelRef}`);
    createOptions.model = model;
  }

  const created = await createAgentSession(createOptions);
  const service = new ServerSession(created, { cwd, agentDir, sessionDir });

  // 关键：bindExtensions 才是"激活扩展"的那一步 —— session_start 也在这里才发出去
  // （SDK 的 agent-session.js 里 `await this._extensionRunner.emit(this._sessionStartEvent)`
  //  只出现在 bindExtensions 内）。不调用它，扩展虽然被加载、工具也注册了，
  // 但所有 session_start 里的初始化（例如 Goal 插件恢复目标）永远不会执行。
  await service.activateExtensions({ uiContext, mode });

  if (disposeOnExit) {
    const onExit = () => service.dispose();
    process.once("exit", onExit);
    service.onDispose(() => process.removeListener("exit", onExit));
  }

  return service;
}

/** 一个无终端会话的薄封装：控制口 + 事件口 + 元信息 */
export class ServerSession {
  #session;
  #disposeHooks = [];
  #disposed = false;

  constructor(created, meta) {
    this.#session = created.session;
    this.extensionsResult = created.extensionsResult;
    this.modelFallbackMessage = created.modelFallbackMessage;
    this.meta = meta;
  }

  get sessionId() {
    return this.#session.sessionId;
  }

  get sessionFile() {
    return this.#session.sessionFile;
  }

  get messages() {
    return this.#session.state.messages;
  }

  /** 订阅原始 SDK 事件；返回取消订阅函数 */
  subscribe(handler) {
    return this.#session.subscribe(handler);
  }

  async prompt(text) {
    return await this.#session.prompt(text);
  }

  async steer(text) {
    return await this.#session.steer(text);
  }

  async followUp(text) {
    return await this.#session.followUp(text);
  }

  async abort() {
    return await this.#session.abort();
  }

  /**
   * 激活扩展，并可选注入 UI 上下文。
   *
   * 这是 SDK 服务端集成里最关键的一步，两件事同时发生：
   *   1. 发出 session_start —— 扩展的会话初始化只在这里跑
   *   2. 决定 hasUI —— runner.hasUI() 就是 `uiContext !== noOpUIContext`
   *
   * 因为 session_start 由这次调用发出，所以"第一次激活时就带上 uiContext"
   * 才能让扩展在 session_start 阶段看到 hasUI=true。分两次调用做不到。
   *
   * 撤销必须传 null：bindExtensions 的实现是 `if (bindings.uiContext !== undefined)`
   * 才赋值，传 undefined 等于什么都不做（与类型声明的直觉相反）。
   */
  async activateExtensions({ uiContext, mode = "print" } = {}) {
    await this.#session.bindExtensions({ uiContext, mode });
    this.uiBound = uiContext !== undefined;
  }

  /** 注入 Point 自己的对话框代理（Web 接入点）。 */
  async bindUI(uiContext, mode = "print") {
    await this.activateExtensions({ uiContext, mode });
  }

  /** 撤销 UI 上下文，回到 noOpUIContext。 */
  async unbindUI(mode = "print") {
    await this.activateExtensions({ uiContext: null, mode });
  }

  onDispose(hook) {
    this.#disposeHooks.push(hook);
  }

  get disposed() {
    return this.#disposed;
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const hook of this.#disposeHooks) hook();
    this.#session.dispose();
  }
}
