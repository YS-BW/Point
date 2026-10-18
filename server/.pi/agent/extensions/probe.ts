/**
 * UI 契约探针扩展。
 *
 * 目的：把"扩展在无终端服务端里到底看到了什么 UI"变成可观测事实，
 * 而不是靠读源码推测。它做三件事：
 *   1. 在 session_start 记录 hasUI / mode / 各 UI 方法的 typeof
 *   2. 注册 probe_ui 工具，真正发起一次 confirm 和 select，记录原始返回值和异常
 *   3. 监听 ui_prompt_start / ui_prompt_end，记录扩展能看到多少次对话请求
 *
 * 观测结果写到 $POINT_PROBE_LOG（JSONL），由验证脚本读取断言。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

function record(entry: Record<string, unknown>): void {
  const path = process.env.POINT_PROBE_LOG;
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
}

function describeUI(ctx: ExtensionContext) {
  return {
    hasUI: ctx.hasUI,
    mode: ctx.mode,
    typeofSelect: typeof ctx.ui.select,
    typeofConfirm: typeof ctx.ui.confirm,
    typeofInput: typeof ctx.ui.input,
    typeofNotify: typeof ctx.ui.notify,
  };
}

export default function probeExtension(pi: ExtensionAPI): void {
  // 记录扩展工厂被调用了多少次。如果 > 1，说明模块级副作用（setInterval、
  // 全局注册、文件监听等）会被执行多次 —— 对调度类插件就是重复触发。
  const globalScope = globalThis as typeof globalThis & { __probeFactoryRuns?: number };
  globalScope.__probeFactoryRuns = (globalScope.__probeFactoryRuns ?? 0) + 1;
  record({ event: "extension_loaded", pid: process.pid, factoryRuns: globalScope.__probeFactoryRuns });

  pi.on("session_start", async (_event, ctx) => {
    record({ event: "session_start", ...describeUI(ctx) });
  });

  pi.on("ui_prompt_start", async (event) => {
    record({ event: "ui_prompt_start", kind: event.kind, title: event.title });
  });

  pi.on("ui_prompt_end", async (event) => {
    record({ event: "ui_prompt_end", kind: event.kind });
  });

  pi.registerTool({
    name: "probe_ui",
    label: "Probe UI",
    description: "报告扩展看到的 UI 上下文，并真实发起一次 confirm 与一次 select，返回原始结果。",
    parameters: Type.Object({}),
    execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
      const before = describeUI(ctx);
      let confirmResult: unknown;
      let selectResult: unknown;
      let error: string | undefined;
      try {
        confirmResult = await ctx.ui.confirm("probe confirm", "无终端时这个确认框会返回什么？");
        selectResult = await ctx.ui.select("probe select", ["选项A", "选项B"]);
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      const observed = { ...before, confirmResult, selectResult, error };
      record({ event: "probe_ui", ...observed });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(observed) }],
        details: {},
      };
    },
  });
}
