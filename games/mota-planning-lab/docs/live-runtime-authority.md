# 实时运行时权威

当前页面的 live observation 是行动唯一权威：地图实例、角色位置与属性、钥匙、动态 blocks、怪物数据、商店和 busy 状态都必须在本轮重新读取。

静态 floors/maps/material definitions 用于解释规则和构建候选，不能覆盖当前动态现场。controller 和 service 只在当前实例内缓存一次规划所需的不可变投影与一个 in-flight action；下一轮用新 observation 替换。

服务或页面重新实例化后全部运行内存消失。系统不会查看旧运行目录、浏览器 storage 或历史 action 来驱动游戏；用户重新确认基线后按当前实时状态继续。
