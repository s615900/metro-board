// Vercel Serverless Function：/api/metro
// 代理 TDX 台北捷運 LiveBoard（各站即時到站時間）
// 環境變數：TDX_CLIENT_ID、TDX_CLIENT_SECRET

let tokenCache = { token: null, exp: 0 };

async function getToken() {
  const id = process.env.TDX_CLIENT_ID;
  const secret = process.env.TDX_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (tokenCache.token && Date.now() < tokenCache.exp) return tokenCache.token;
  const r = await fetch(
    'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
    }
  );
  if (!r.ok) throw new Error('TDX token error ' + r.status);
  const j = await r.json();
  tokenCache = { token: j.access_token, exp: Date.now() + (j.expires_in - 300) * 1000 };
  return tokenCache.token;
}

// 大台北（臺北捷運＋新北捷運＋新北輕軌）：營運單位 → [分頁名稱, 路線代號 → [路線名, 顏色]]
const OPS = {
  TRTC: ['北捷', { BL: ['板南線', '#0070bd'], R: ['淡水信義線', '#e3002c'], G: ['松山新店線', '#008659'], O: ['中和新蘆線', '#f8b61c'], BR: ['文湖線', '#c48c31'] }],
  NTMC: ['新北', { Y: ['環狀線', '#d4b600'], LB: ['三鶯線', '#4aa3c8'] }],
  NTDLRT: ['新北', { V: ['淡海輕軌', '#2aa7a0'] }],
};
const opCache = {}; // op → { list, exp }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getStations(headers) {
  let fetched = 0;
  for (const [op, [group, lines]] of Object.entries(OPS)) {
    const c = opCache[op];
    if (c && Date.now() < c.exp) continue;
    if (fetched++) await sleep(1200);
    let d = null;
    for (let t = 0; t < 3 && !Array.isArray(d); t++) {
      if (t) await sleep(2000);
      const r = await fetch(`https://tdx.transportdata.tw/api/basic/v2/Rail/Metro/Station/${op}?$format=JSON`, { headers });
      d = r.ok ? await r.json() : null;
    }
    if (!Array.isArray(d)) continue; // 這次失敗，下次請求再補
    const list = [];
    for (const s of d) {
      const code = (s.StationID.match(/^[A-Z]+/) || [''])[0];
      const meta = lines[code];
      if (!meta) continue; // 不在已知路線的延伸/特殊站不列入
      list.push({ op, group, key: op + ':' + code, line: code, lineName: meta[0], color: meta[1], id: s.StationID, name: s.StationName.Zh_tw, en: s.StationName.En });
    }
    opCache[op] = { list, exp: Date.now() + 6 * 3600 * 1000 };
  }
  return Object.keys(OPS).flatMap((op) => (opCache[op] ? opCache[op].list : []));
}

const stationCache = new Map();
const ttCache = {};

function mapTrains(data) {
  return (Array.isArray(data) ? data : []).map((d) => ({
    line: d.LineID,
    lineName: d.LineName && d.LineName.Zh_tw,
    id: d.StationID,
    station: d.StationName && d.StationName.Zh_tw,
    stationEn: d.StationName && d.StationName.En,
    head: d.TripHeadSign,
    dest: d.DestinationStationName && d.DestinationStationName.Zh_tw,
    status: d.ServiceStatus,
    sec: d.EstimateTime,
  }));
}

// /api/metro?stations=1  → 全部車站清單（快取 6 小時）
// /api/metro?line=BL      → 該路線目前的即時到站（伺服器快取 10 秒）
module.exports = async function handler(req, res) {
  try {
    const token = await getToken();
    const headers = { 'Accept-Encoding': 'gzip' };
    if (token) headers.Authorization = 'Bearer ' + token;
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.query.timetable) {
      const op = String(req.query.timetable);
      if (!OPS[op]) return res.status(400).json({ error: 'bad op' });
      let c = ttCache[op];
      if (!c || Date.now() >= c.exp) {
        const r = await fetch(`https://tdx.transportdata.tw/api/basic/v2/Rail/Metro/StationTimeTable/${op}?$format=JSON`, { headers });
        if (!r.ok) return res.status(r.status).json({ error: 'TDX ' + r.status });
        const d = await r.json();
        const list = (Array.isArray(d) ? d : []).map((x) => {
          const sd = x.ServiceDay || {};
          const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((k) => (sd[k] ? 1 : 0)).join('');
          const t = (x.Timetables || []).map((y) => {
            const [h, m] = String(y.DepartureTime).split(':').map(Number);
            return (h < 4 ? h + 24 : h) * 60 + m; // 過午夜的末班（00:xx）算在當天尾端
          });
          return { s: x.StationID, d: x.DestinationStationID || x.DestinationStaionID, dn: x.DestinationStationName && x.DestinationStationName.Zh_tw, days, t };
        });
        c = ttCache[op] = { list, exp: Date.now() + 12 * 3600 * 1000 };
      }
      res.setHeader('Cache-Control', 's-maxage=3600');
      return res.status(200).json({ op, list: c.list });
    }

    if (req.query.line) {
      const line = String(req.query.line);
      const op = String(req.query.op || 'TRTC');
      if (!/^[A-Z]{1,2}$/.test(line) || !OPS[op]) return res.status(400).json({ error: 'bad line' });
      const hit = stationCache.get(op + line);
      let data;
      if (hit && Date.now() < hit.exp) data = hit.data;
      else {
        const u = new URL('https://tdx.transportdata.tw/api/basic/v2/Rail/Metro/LiveBoard/' + op);
        u.searchParams.set('$filter', `LineID eq '${line}'`);
        u.searchParams.set('$format', 'JSON');
        const r = await fetch(u, { headers });
        if (!r.ok) return res.status(r.status).json({ error: 'TDX ' + r.status });
        data = await r.json();
        stationCache.set(op + line, { data, exp: Date.now() + 10000 });
      }
      res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=20');
      return res.status(200).json({ updated: new Date().toISOString(), trains: mapTrains(data) });
    }

    const stations = await getStations(headers);
    res.setHeader('Cache-Control', stations.length ? 's-maxage=300' : 'no-store');
    res.status(200).json({ stations });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
