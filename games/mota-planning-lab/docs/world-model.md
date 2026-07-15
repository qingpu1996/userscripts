# 世界模型

每轮规划从当前游戏 observation 和当前进程内存里的已观察地图关系派生世界图。节点使用 `map_instance_id`、floorId、dimensions 和 topology identity；当前英雄资源始终只来自本轮 live observation。

跨层搜索可以在本轮模型里评估其他已知楼层的资源、怪物和出口，但不会把旧 hero、keys、busy 或派生可达性当成当前事实。怪物战斗性由当前 hero 与当前引擎敌人数据重新计算。

出口实际执行后，当前进程可暂存精确起点、目标 map instance 和落点，避免无收益往返。该关系只服务当前实例；服务重启后从游戏实时 maps/当前 observation 重新建立，不恢复历史扫描状态。

目标选择与路线执行分离：空走廊可快速移动，最后一个边界格仍由正常游戏交互触发。每轮最多一个状态变化，完成后完整重采、稳定两轮并校验 expected delta。
