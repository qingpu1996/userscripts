# 验证命令

```bash
node --test games/mota-planning-lab/tests/js/engine-model-collector.test.js
PYTHONPATH=games/mota-planning-lab/service:games/mota-planning-lab/tests/python:... python3.12 -m unittest discover -s games/mota-planning-lab/tests/python -p test_functional_engine_model.py -v
MOTA_LAB_STATE_DIR=/tmp/mota-functional-engine-model-state MOTA_LAB_KNOWLEDGE_DIR=/tmp/mota-functional-engine-model-knowledge python3.12 -m mota_lab serve --host 127.0.0.1 --port 18725
# 向 18725 POST MT2-like engine_model cycle request
MOTA_LAB_PYTHON=python3.12 MOTA_LAB_PYTHONPATH=... games/mota-planning-lab/scripts/run-offline-qa.sh
```

localhost 验证使用独立端口 18725 和 `/tmp` state/knowledge；完成后已停止。未访问或停止真实 18724 服务。
