# 真实地址生成器（Real Address Generator）

参考 [realaddress.remit.ee](https://realaddress.remit.ee/) 实现的静态站点：随机获取世界各国**真实存在**的门牌级地址，配合随机生成的姓名、电话、邮箱，仅供软件测试、演示与开发使用。

## 地址为什么是真实的

- 地址不是拼凑的：由 `tools/build-pool.js` 离线从 **Overpass API**（OpenStreetMap 数据库）抽取带 `addr:housenumber`（门牌号）的真实建筑，存入 `data/pool/` 本地地址池，站点运行时直接随机取用——**零外部请求、无限流、毫秒级出结果**；
- 地址池缺失的国家自动回退实时查询：前端调用 Overpass 随机抽取，缺失的邮编/城市用 **Nominatim** 反向地理编码补全（同样基于 OSM 实测数据）；
- 每条结果附带"真实性凭证"链接，可直接跳转到该建筑在 OpenStreetMap 上的原始条目核对；
- 姓名、电话、邮箱为随机生成（这部分本就不应对应真人）。

## 后台管理

```powershell
node tools/admin-server.js
# 打开 http://127.0.0.1:8100
```

网页面板可完成：查看各国地址池状态（条数/生成日期，数量偏少会标黄）、一键重建单国或全部地址池、自动添加新国家、以及"发布到远端"（git add/commit/push，GitHub Pages 随之自动重新部署），任务日志实时显示。服务只绑定 127.0.0.1，仅本机可访问；同一时刻只允许一个任务运行，避免对公共 Overpass 造成压力。

## 更新 / 重建地址池（命令行）

```powershell
node tools/build-pool.js          # 全部国家（约 30 分钟，含限速等待）
node tools/build-pool.js DE JP    # 只重建指定国家
```

每国抽取约 2500 条街道、门牌、邮编、城市齐全的地址（约 300 KB/国），按国家写入 `data/pool/<代码>.json`。脚本对公共 Overpass 做了限速与端点故障转移，符合其使用礼仪；地址数据变化很慢，一年重建一次也足够。

## 运行

纯静态站点，无需构建。本地启动一个 HTTP 服务即可（clipboard 等 API 需要 localhost 或 HTTPS 环境）：

```powershell
uv run python -m http.server 8000
# 打开 http://localhost:8000
```

也可直接部署到 GitHub Pages / Cloudflare Pages 等任意静态托管。

## 功能

- 20 个国家/地区（美、加、英、德、法、意、西、荷、瑞士、奥、瑞典、波、捷、葡、日、韩、中国台湾、新加坡、澳、巴西）
- 地图定位（Leaflet + OSM 瓦片），门牌级精度标识
- 点击任意字段复制 / 一键复制全部
- 本地保存（localStorage）、导出 CSV / JSON

## 文件结构

```
index.html          页面结构
css/style.css       样式
js/data.js          国家数据（城市坐标、姓名池、电话格式）
js/app.js           核心逻辑（地址池优先 → Overpass 实时兜底 → 渲染）
tools/build-pool.js 地址池抽取脚本
data/pool/*.json    各国离线地址池（真实 OSM 门牌地址）
```

## 添加新国家

一条命令自动完成（国家名/区号/语言 ← mledoze/countries 数据集；主要城市及坐标 ← Overpass 按人口选取；随后自动抽取地址池并报告 OSM 门牌覆盖度）：

```powershell
node tools/add-country.js VN          # 添加越南（ISO 3166-1 两位代码）
node tools/add-country.js TH 5       # 添加泰国，取人口最多的 5 个城市
node tools/add-country.js RO --no-pool  # 只写入 data.js，不抽地址池
```

唯一无法自动化的是姓名池与手机号段：脚本会先填入通用占位（带注释标记），建议在 `js/data.js` 中按当地习惯完善。若抽取结果少于 500 条，说明该国/地区 OSM 门牌覆盖差（如中国大陆），会给出警告供你决定是否保留。

## 注意事项

- Overpass / Nominatim 均为社区公共服务，有速率限制（Nominatim ≤ 1 请求/秒），请勿高频批量调用；大流量部署请自建或使用商业镜像。
- 生成的信息禁止用于欺诈、收货、身份验证或任何法律用途。
- 地址数据 © OpenStreetMap 贡献者，ODbL 许可。
