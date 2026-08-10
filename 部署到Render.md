# 部署到 Render（固定链接，免维护，24 小时在线）

本目录已配好 Render 一键部署所需文件：
`render.yaml`、`Procfile`、`runtime.txt`、`requirements.txt`。
部署成功后你将得到一个**永久固定的链接**：`https://stock-workbench.onrender.com`
（服务名可自定义，链接不再变化，手机随时、任意网络都能开）。

---

## 一、准备工作（只需注册，免费）

1. 注册 GitHub 账号：https://github.com （免费）
2. 注册 Render 账号：https://render.com （免费，用 GitHub 直接登录最方便）

> 都不需要信用卡。Render 免费层每月 750 小时额度，单个服务常驻足够；
> 连续 15 分钟无访问会“休眠”，下次打开需等约 30 秒冷启动（见文末“保活”）。

---

## 二、把代码传到 GitHub（两种方式任选）

### 方式 A：GitHub Desktop（推荐，图形化，不用记命令）
1. 下载安装 GitHub Desktop：https://desktop.github.com
2. 打开 → `File` → `Add Local Repository` → 选本目录
   `D:\workbuddy\2026-08-10-11-22-24\stock-workbench`
3. 写个说明（如“股票工作台”），点 `Commit`
4. 点 `Publish repository` → 起个仓库名（如 `stock-workbench`）→ `Publish`
   （勾不勾 Private 都行，建议 Private）

### 方式 B：命令行（如已装 Git）
```bash
cd D:\workbuddy\2026-08-10-11-22-24\stock-workbench
git init
git add .
git commit -m "stock workbench"
git branch -M main
git remote add origin https://github.com/你的用户名/stock-workbench.git
git push -u origin main
```
> GitHub 现在用“个人访问令牌(PAT)”代替密码：
> 在 GitHub → Settings → Developer settings → Personal access tokens 生成一个，push 时用它当密码。

---

## 三、在 Render 一键部署

1. 打开 https://dashboard.render.com → 登录
2. 点 `New` → `Blueprint`（或 `New Web Service`）
3. 连接你的 GitHub 账号，选择 `stock-workbench` 仓库
4. 如果用 `New Web Service`：
   - Runtime: `Python 3`
   - Build Command: `pip install -r requirements.txt`
   - Start Command: `python server.py`
   - 实例类型：`Free`
   - 点 `Create Web Service`
5. 如果用 `Blueprint`：直接选本仓库，Render 会读 `render.yaml` 自动配置

部署约 1–2 分钟。完成后 Render 页面会显示你的固定链接，形如：
**https://stock-workbench.onrender.com**

把它收藏/发给手机即可，链接永不变。

---

## 四、部署后建议（可选）

- **盯盘推送指向云端**：工作台「设置 → 云端后端地址」填你的 Render 链接，
  这样自动化每 15 分钟的买卖提醒里带的链接就是云端地址，手机点开即用。
- **持仓台账**：云端文件系统是临时的，重启会清空 `data/positions.json`。
  如需长期保存持仓，请在本机工作台添加（本机数据持久），云端用于随时查看。
- **保活（避免休眠）**：免费层 15 分钟无访问会休眠。可到 https://uptimerobot.com
  免费建一个“HTTP Monitor”，URL 填你的 Render 链接，每 5 分钟 ping 一次即可常驻。
- **全市场扫描**：云端首次启动会自动生成 ~5400 只代码池（约 2–3 分钟），
  之后走缓存很快；因云端文件系统临时，重建部署后会重新生成一次。

---

## 五、与本机的关系

- 本机 `启动公网访问.bat` 仍可用（临时隧道，链接每次变），适合临时在外看一眼。
- 云端是“固定工位”，适合长期、手机随时访问，链接不变。
- 下周一如常盯盘，两个都能用；要固定不变就用云端这个。

> 温馨提示：本工作台为技术面信号辅助工具，所有建议仅供参考，不构成投资建议；
> 真实买卖请结合自身判断并通过您的券商（如中信证券）下单。
