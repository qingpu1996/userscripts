# verified stair 循环红灯

基线：`d077a4d110a27b29d509bfe9e41d47373fba36c0`。先只加入新断言，再运行定向测试；此时尚未修改 planner。

命令：

```bash
PYTHONPATH=games/mota-planning-lab/service:games/mota-planning-lab/tests/python:/opt/homebrew/lib/python3.12/site-packages:/Users/nihplod/Library/Python/3.9/lib/python/site-packages \
  /opt/homebrew/bin/python3.12 -m unittest -v \
  test_runtime_v2.SessionWorldAndCorsTests.test_verified_stairs_without_remote_progress_are_idle_not_a_round_trip \
  test_runtime_v2.SessionWorldAndCorsTests.test_direct_red_door_beats_verified_return_stair \
  test_runtime_v2.SessionWorldAndCorsTests.test_verified_stair_is_only_first_step_toward_named_remote_frontier \
  test_runtime_v2.SessionWorldAndCorsTests.test_verified_exit_is_not_rediscovered_after_opaque_scan_completion
```

结果：`4 tests / 3 failures`。

```text
FAIL test_verified_stairs_without_remote_progress_are_idle_not_a_round_trip
WorldSearchResult(... progress_bonus=100.0), score=224.0, path_length=2 is not None

FAIL test_direct_red_door_beats_verified_return_stair
'MOVE_TO_STAIR' != 'OPEN_DOOR'

FAIL test_verified_stair_is_only_first_step_toward_named_remote_frontier
'remotePotion' not found in reason:
'世界图 frontier 搜索选择距离 1 的已知楼梯 ... 该出口是已验证的跨图返回边。'

PASS test_verified_exit_is_not_rediscovered_after_opaque_scan_completion
```

红灯证明旧实现同时把 stair 本身记为终端候选、赋予 `100 + 25` 的跨图奖励，并在 reason 中失去远端实际目标。完整原始输出保存在开发机临时文件 `/tmp/mota-verified-stair-red.txt`，不包含真实游戏现场数据。
