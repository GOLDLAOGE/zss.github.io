CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,          -- 毫秒時間戳（伺服器時間）
  e       TEXT    NOT NULL,          -- 事件：view / copy / copy_fail / open_ok / open_fail / return
  vid     TEXT    NOT NULL,          -- 匿名訪客 ID（瀏覽器本地隨機生成）
  w       TEXT,                      -- 頁面展示的 WeChat ID（?w=）
  src     TEXT,                      -- 來源（?utm_source= 或 ?s=）
  cmp     TEXT,                      -- 廣告系列（?utm_campaign= 或 ?c=）
  env     TEXT,                      -- 打開環境：Facebook / Instagram / WeChat / Safari / Chrome …
  os      TEXT,                      -- iOS / Android / Windows / macOS / 其他
  country TEXT                       -- 國家/地區代碼（Cloudflare 提供，不保存 IP）
);
CREATE INDEX IF NOT EXISTS idx_events_ts  ON events (ts);
CREATE INDEX IF NOT EXISTS idx_events_vid ON events (vid);
