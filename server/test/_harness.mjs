/**
 * 验证记录用小工具：断言 + 证据输出。
 * 每个验证脚本都要输出可复跑的实际现象，而不只是 pass/fail。
 */
const results = [];
let failures = 0;

export function section(title) {
  console.log(`\n${"=".repeat(64)}\n${title}\n${"=".repeat(64)}`);
}

export function ok(name, condition, detail) {
  const passed = Boolean(condition);
  if (!passed) failures += 1;
  results.push({ name, passed, detail });
  const mark = passed ? "PASS" : "FAIL";
  const extra = detail === undefined ? "" : `  (${detail})`;
  console.log(`  [${mark}] ${name}${extra}`);
  return passed;
}

export function evidence(label, value) {
  console.log(`  · ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}

/** 条件不满足时跳过（例如没有凭据），不算失败。 */
export function skip(reason) {
  console.log(`\n  [SKIP] ${reason}`);
  console.log("  RESULT: SKIP");
  process.exitCode = 0;
  return true;
}

/** 事件类型直方图，用来记录这一版 SDK 到底发了哪些事件。 */
export function histogram(events, pick = (event) => event.type) {
  const counts = new Map();
  for (const event of events) {
    const key = pick(event);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/** 从事件流里抽出文本增量，用于证明"流式"而不是一次性返回。 */
export function collectDeltas(events) {
  const deltas = [];
  for (const event of events) {
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      deltas.push({ text: event.assistantMessageEvent.delta, at: Date.now() });
    }
  }
  return deltas;
}

export function finish(title) {
  section(`${title} 结论`);
  const passed = results.length - failures;
  console.log(`  断言: ${passed}/${results.length} 通过`);
  if (failures > 0) {
    console.log("  失败项:");
    for (const result of results.filter((item) => !item.passed)) {
      console.log(`   - ${result.name}${result.detail ? ` (${result.detail})` : ""}`);
    }
  }
  console.log(`  RESULT: ${failures === 0 ? "PASS" : "FAIL"}`);
  process.exitCode = failures === 0 ? 0 : 1;
  return failures === 0;
}
