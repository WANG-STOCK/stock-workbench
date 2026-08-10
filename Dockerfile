# 技术面股票工作台 - 云端镜像（零依赖，纯 Python 标准库）
FROM python:3.11-slim

WORKDIR /app
COPY . /app

# 暴露端口（与 server.py 默认一致）
ENV PORT=8723
EXPOSE 8723

# 持久化数据目录（持仓/预警/配置），挂载卷以保留
VOLUME ["/app/data"]

CMD ["python", "server.py"]
