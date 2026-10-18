/**
 * 测试用的"对话框代理"桩：实现完整的 ExtensionUIContext 接口。
 *
 * 这正是 Point 之后要把 confirm/select/input 接到 Web 的那个位置。
 * 在这里用它证明两件事：注入 UI 上下文后扩展真的能拿到答复；
 * 以及不注入时同一份代码会静默拿到 false/undefined。
 */
export function createStubUI(options = {}) {
  const { confirmAnswer = true, selectAnswer = "选项B", inputAnswer = "stub-input", onCall } = options;
  const calls = [];
  const log = (name, args) => {
    const entry = { name, args };
    calls.push(entry);
    onCall?.(entry);
  };

  return {
    calls,
    select: async (title, choices) => {
      log("select", [title, choices]);
      return selectAnswer;
    },
    confirm: async (title, message) => {
      log("confirm", [title, message]);
      return confirmAnswer;
    },
    input: async (title, placeholder) => {
      log("input", [title, placeholder]);
      return inputAnswer;
    },
    notify: (message, type) => log("notify", [message, type]),
    onTerminalInput: () => () => {},
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: async () => undefined,
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => "",
    editor: async () => undefined,
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    get theme() {
      return undefined;
    },
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "stub UI" }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  };
}
