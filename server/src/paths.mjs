/**
 * 路径约定：所有运行时文件都落在工程内，不碰用户的 ~/.pi。
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** 工程根目录 */
export const ROOT = join(here, "..");
/** 项目级 Pi 配置目录（等价于全局的 ~/.pi/agent，但隔离在工程内） */
export const AGENT_DIR = join(ROOT, ".pi", "agent");
/** 项目级扩展目录：SDK 会从 <cwd>/.pi/extensions 自动发现 */
export const EXTENSIONS_DIR = join(ROOT, ".pi", "extensions");
/** Agent 的工作目录：文件读写和命令都在这里发生 */
export const WORKSPACE = join(ROOT, "workspace");
/** 会话文件目录（显式指定，避免按 cwd 编码散落） */
export const SESSION_DIR = join(ROOT, "sessions");
/** 每个验证脚本用自己的会话目录，避免互相"继续最近一次" */
export const sessionDirFor = (name) => join(SESSION_DIR, name);
/** 运行时产物（探针日志、验证证据等） */
export const RUNTIME_DIR = join(ROOT, "runtime");
/** 扩展探针写下的观测日志 */
export const PROBE_LOG = join(RUNTIME_DIR, "probe.jsonl");

/** 确定性测试用的假模型引用 */
export const FAUX_MODEL_REF = "faux/faux-1";
