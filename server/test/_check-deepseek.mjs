/**
 * 连通性检查：确认凭据被 SDK 认到、DeepSeek provider 可用。
 * 不做对话，不花钱。
 */
import { createModelRuntime } from "../src/session-service.mjs";

const runtime = await createModelRuntime();

console.log("=== deepseek provider 是否在目录里 ===");
const provider = runtime.getProvider("deepseek");
console.log("provider:", provider ? `${provider.id} / ${provider.name}` : "(没有)");

console.log("\n=== deepseek 目录中的模型 ===");
for (const model of runtime.getModels("deepseek")) {
  console.log(`  ${model.provider}/${model.id}  ctx=${model.contextWindow} max=${model.maxTokens} reasoning=${model.reasoning}`);
}

console.log("\n=== 凭据状态 ===");
const status = runtime.getProviderAuthStatus("deepseek");
console.log("authStatus:", JSON.stringify(status));
const check = await runtime.checkAuth("deepseek");
console.log("checkAuth:", JSON.stringify(check));

console.log("\n=== 实际可用模型（有有效凭据的）===");
const available = await runtime.getAvailable();
console.log("可用模型数:", available.length);
for (const model of available.slice(0, 10)) {
  console.log(`  ${model.provider}/${model.id}`);
}
console.log("\nruntime 错误（若有）:", runtime.getError() ?? "(无)");
