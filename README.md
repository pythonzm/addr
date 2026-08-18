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

网页面板可完成：查看各国地址池状态（条数/生成日期，数量偏少会标黄）、一键重建单国或全部地址池、自动添加新国家，任务日志实时显示。新增/重建流程会依次执行 **OSM 建池 → GeoNames 行政区补全 → 数据校验**，任一步失败都不会发布。**全部通过后才会自动发布到远端**（git add/commit/push，GitHub Pages / Vercel 随之自动重新部署），也保留了手动"发布到远端"按钮。同一时刻只允许一个任务运行，避免对公共 Overpass 造成压力。

**认证与环境变量**：
- `ADMIN_PASSWORD`：未设置时仅绑定 `127.0.0.1` 免密（本机模式）；设置后开启登录认证（会话 Cookie 12 小时滑动过期，同 IP 连错 5 次锁定 15 分钟），默认改绑 `0.0.0.0`，可用 `HOST` / `PORT` 覆盖。
- `FRONTEND_URL`（或 `SITE_URL`）：若后台与前台不在同域名或同端口（如前台在 GitHub Pages / 独立域名），可配置此前台访问地址（如 `https://addr.example.com`），后台顶部的「访问前台」按钮将自动跳转至该地址。

### 部署到 VPS

```bash
# 前置：VPS 安装 node ≥ 18 与 git，克隆仓库并配置好可推送的 SSH 密钥
ADMIN_PASSWORD='你的强密码' FRONTEND_URL='https://addr.example.com' node tools/admin-server.js
```

systemd 常驻示例（`/etc/systemd/system/addr-admin.service`）：

```ini
[Unit]
Description=addr admin panel
After=network.target

[Service]
WorkingDirectory=/opt/addr
Environment=ADMIN_PASSWORD=你的强密码
Environment=FRONTEND_URL=https://addr.example.com
Environment=HOST=127.0.0.1
ExecStart=/usr/bin/node tools/admin-server.js
Restart=on-failure
User=www-data

[Install]
WantedBy=multi-user.target
```

公网访问务必套 HTTPS 反代（明文 HTTP 会暴露口令）。Nginx 示例：

```nginx
server {
  listen 443 ssl;
  server_name admin.example.com;
  # ssl_certificate / ssl_certificate_key ...
  location / {
    proxy_pass http://127.0.0.1:8100;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
  }
}
```

（上例中服务本身只绑 127.0.0.1，由 Nginx 对外；`X-Forwarded-Proto: https` 会让会话 Cookie 自动带 `Secure` 标记。）

## 更新 / 重建地址池（命令行）

```powershell
node tools/build-pool.js          # 全部国家（约 30 分钟，含限速等待）
node tools/build-pool.js DE JP    # 只重建指定国家
```

每国抽取约 2500 条街道、门牌、邮编、城市齐全的地址（约 300 KB/国），按国家写入 `data/pool/<代码>.json`。脚本对公共 Overpass 做了限速与端点故障转移，符合其使用礼仪；地址数据变化很慢，一年重建一次也足够。

重建后可使用 [GeoNames](https://www.geonames.org/) 的 `cities500.txt` 和 `admin1CodesASCII.txt` 补齐 State / Province / Region：

```powershell
node tools/backfill-administrative-areas.js --cities <cities500.txt> --admin1 <admin1CodesASCII.txt>
```

已有的 OSM 行政区值会保留；需要重新校正所有记录时加 `--replace`。脚本会拒绝将明显跨境的地址填入错误行政区。香港和新加坡没有适合该国际表单字段的州/省层级，因此保持为空。
地址池中 `a` 表示行政区，`as` 表示数据来源（`osm` 或 `geonames`）。

## 运行

纯静态站点，无需构建。本地启动一个 HTTP 服务即可（clipboard 等 API 需要 localhost 或 HTTPS 环境）：

```powershell
uv run python -m http.server 8000
# 打开 http://localhost:8000
```

也可直接部署到 GitHub Pages / Cloudflare Pages 等任意静态托管。

## 功能

- 25 个国家/地区（美、加、英、德、法、意、西、荷、瑞士、奥、瑞典、波、捷、葡、日、韩、泰、越南、马来西亚、菲律宾、中国台湾、中国香港、新加坡、澳、巴西）
- 国家下拉框支持按中文名 / 英文名 / 代码即时筛选
- 地图定位（Leaflet + OSM 瓦片），门牌级精度标识
- 点击任意字段复制 / 一键复制全部
- 本地保存（localStorage）、导出 CSV / JSON

## 文件结构

```
index.html            页面结构
css/style.css         样式
js/data.js            国家数据（城市坐标、姓名池、电话格式）
js/app.js             核心逻辑（地址池优先 → Overpass 实时兜底 → 渲染）
tools/build-pool.js   地址池抽取脚本
tools/add-country.js  一键添加新国家（电话/姓名池由开源数据集自动生成）
tools/admin-server.js 后台管理服务（配 admin.html 面板）
data/pool/*.json      各国离线地址池（真实 OSM 门牌地址）
```

## 添加新国家

一条命令自动完成（国家名/区号/语言 ← mledoze/countries 数据集；主要城市及坐标 ← Overpass 按人口选取；手机号段模板 ← Google libphonenumber；姓名池 ← popular-names-by-country 数据集；随后自动抽取地址池并报告 OSM 门牌覆盖度）：

```powershell
node tools/add-country.js VN          # 添加越南（ISO 3166-1 两位代码）
node tools/add-country.js TH 5       # 添加泰国，取人口最多的 5 个城市
node tools/add-country.js RO --no-pool  # 仅用于本地分阶段编辑：只写 data.js，不校验也不自动发布
```

电话模板与姓名池同样自动生成：手机号段取自 **Google libphonenumber**（全球覆盖，保留真实前缀）；姓名池取自 **popular-names-by-country** 数据集（约百国常用名/姓氏，非拉丁文字自动附罗马化拼写供邮箱生成）。个别字段数据集未覆盖时回退通用占位，并在日志中精确提示需完善的字段。所有网络请求经 curl 发出，遵循 `HTTP(S)_PROXY` 代理变量（代理与直连自动切换）。若抽取结果少于 500 条，说明该国/地区 OSM 门牌覆盖差（如中国大陆），会给出警告供你决定是否保留。

## 注意事项

- Overpass / Nominatim 均为社区公共服务，有速率限制（Nominatim ≤ 1 请求/秒），请勿高频批量调用；大流量部署请自建或使用商业镜像。
- 生成的信息禁止用于欺诈、收货、身份验证或任何法律用途。
- 地址数据 © OpenStreetMap 贡献者，ODbL 许可。
