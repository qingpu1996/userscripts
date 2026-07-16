# 策略数据与执行安全边界

## 唯一盲玩限制

本项目不得搜索、读取、导入或使用《魔塔24层》的攻略、标准路线、通关录像，或其他人为整理的针对性解法资料。不得把这类资料转写成启发式、fixture、标签、bundled data 或默认决策。

这条限制不适用于游戏自身数据。为了构建策略模型，代理可以读取和分析游戏页面与本地游戏工程已经提供的任何数据，包括完整运行态、`core.floors`、`core.status.maps`、`material`、物品/怪物/事件定义、地图源码和存档结构，也包括尚未由英雄进入的楼层或地图。地图、怪物、钥匙和资源语义应优先从这些游戏权威定义与实时状态通用解析，不得靠逐对象 ID 硬编码维护另一份事实库。

## 读取不等于篡改

游戏自身数据可读，不代表可以直接改写。脚本不得通过赋值、`delete`、`Object.assign`、`Object.defineProperty`、`Reflect.set` 等方式篡改 hero 数值、地图或 block、怪物、事件、存档及其他游戏权威对象。移动、战斗、开门、拾取、换图和经用户授权的存取档都必须调用游戏正常接口，使触发器、录像和存档状态由引擎自己更新。

每次只执行一个可校验的原子状态边界，执行后等待稳定并用 fresh runtime 读取实际结果。当前 Protocol v2 使用 guard/expected delta；目标 V1 使用执行前 `baseStateHash` 陈旧检查和下一轮 observation。读取到未来地图或完整定义不能成为跳过检查、直接改现场或一次跨越多个未校验边界的理由。

## 本地数据流

浏览器运行态入口仍集中在 `src/engine-adapter.js`，便于统一做快照一致性与能力探测；集中入口不是读取白名单。当前 Protocol v2 `/cycle` observation 仍以当前执行现场为结算载体。目标 V1 则在启动时完整 bootstrap，之后用 `/step` 的自包含实时 observation 作为唯一动态输入；目标尚未实现。

当前运行通信只允许到配置中的 `http://127.0.0.1:<port>/cycle`，production 默认端口是 `18724`；隔离 QA 可显式选择其他合法端口，但 client 与 `python -m mota_lab serve --port` 必须使用同一配置。目标 Rust `/bootstrap + /step + /run-events` 同样只能监听 loopback；其中 `/run-events` 只把浏览器执行现场追加到当前诊断日志，不进入 solver。构建物不得包含非 loopback 运行端点、自动更新 URL、Cookie 或登录凭据。读取完整游戏数据不会自动授权把它发送到非 localhost 服务；目标 per-run 日志只用于本地诊断，且运行时只写不读。

## 执行完整性保证

禁止直接 mutation 是执行完整性不变式，不是盲玩数据读取边界。当前保证由四层共同组成：

- 实际 production source、service 和双 dist 每次完整扫描；`engine-adapter.js` 另做权威 alias 清单与 engine API 调用清单审计；
- 改变游戏现场的调用只允许 `moveDirectly`、`setAutomaticRoute`、`stopAutomaticRoute`，读取接口与行动接口在审计结果中分开列出，未分类调用 fail closed；
- collector、client 和 service 没有直接写 page runtime 的职责，浏览器 page core 入口继续只存在于 adapter；
- localhost full-cycle fake core 对 hero、maps、blocks 和 enemy 定义加写入代理；完整观察、通信、规划期间任何写都会抛错，测试确认所有实际权威变化只发生在模拟公开行动 API 的动态作用域内。

`scripts/static-compliance.mjs` 和 `scripts/ast-runtime-compliance.mjs` 仍保留为受控项目源码的工程 lint 与防回归样本。它允许 `core.floors`、完整 maps、`material`、地图/事件/存档定义的只读分析，并对项目中已经出现或明确禁止的常见直接写法给出诊断；它不是 JavaScript sandbox，也不声称证明任意 alias、closure、`this`、constructor、callback、Proxy、`eval` 或动态代码生成的完整语义安全。超出支持子集的 bound `this`、user-defined constructor 和 identity-producing collection callback 会返回 `UNSAFE_RUNTIME_MUTATION_ANALYSIS`，而不是被静默当作安全。新增生产代码若需要新的高阶语义，必须先扩展实际 source 审计与 integration instrumentation，不能仅增加一个理论 snippet 后宣称完整覆盖。

目标 V1 的浏览器 controller 只保留 `IDLE | EXECUTING | PAUSED` 和一个 in-flight action，不引入跨启动恢复或动作重试。不可逆动作的 `PROVEN` 是 solver 内部判断，不是浏览器协议。完整迁移边界见 [求解器架构与实施方案](solver-architecture.md)。

userscript metadata 继续限制页面匹配和 `@connect 127.0.0.1`，生成物只允许既定 localhost endpoint。`setAutomaticRoute`、`moveDirectly` 等正常引擎行动调用不会因为读取范围扩大而被禁止。

外部攻略禁令通过开发来源声明、代码审查和 QA provenance 执行，不能靠扫描 `floors`、`material` 等合法游戏标识符来冒充合规检查。
