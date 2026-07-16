# QA

此目录不保存运行产物或历史 QA 记录。

浏览器侧测试：

```bash
node --test games/mota-planning-lab/tests/js/*.test.js
```

Stage 0：

```bash
games/mota-planning-lab/scripts/run-stage0-bench.sh
```

runner 在临时目录生成结果和 Rust target，并在退出时清理。
