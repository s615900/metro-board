# 即時捷運到站時間（台北捷運）

## 部署（Vercel）
1. GitHub 建 repo 並推上去，Vercel 匯入（Application Preset 選 Other，不需 build）
2. Environment Variables 新增 `TDX_CLIENT_ID`、`TDX_CLIENT_SECRET`（與航班看板同一組 TDX 金鑰）
3. 右上角紅色 `LIVE` ＝ 即時資料；`DEMO` ＝ 連不到 API 的示範資料

## 結構
- `index.html`：選路線/搜尋站名，顯示往各方向的倒數時間（每 15 秒更新資料、每秒倒數）
- `api/metro.js`：代理 TDX `Rail/Metro/LiveBoard/TRTC`，CDN 快取 15 秒
