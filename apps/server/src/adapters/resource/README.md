# Resource boundary

WP2 在此实现外部能力端口；当前无可执行 adapter。租约与动作三态是 domain 规则，Durable task 负责持久阶段，adapter 只执行/观察一次外部调用。

接口必须携带 resourceId、owner、controlEpoch、operationId；unknown 只允许 observe/reconcile。不要在这里另建排队器。浏览器控制面保持冻结。
