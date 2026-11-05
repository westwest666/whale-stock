/* =========================================================================
 * 黑鲸股市研究系统 · 可视化看板 (site/js/app.js)
 * 纯原生 JS，无构建工具，无框架依赖；图表使用本地 ECharts。
 *
 * 数据加载三级 fallback：
 *   1) window.__INLINE_DATA__  —— 离线单文件版（backend/whalestock/site_build.py 注入）
 *   2) fetch('data/latest.json') + fetch('data/history.json')
 *   3) 失败 → 顶部醒目提示「未找到数据文件，请先运行 python run.py」
 *
 * 设计原则：任何字段缺失 / 类型异常都不得抛错白屏，统一降级为「—」。
 * ========================================================================= */
(function () {
  'use strict';

  /* 资源加载成功标记：index.html 底部的自愈脚本据此判断是否需要换前缀重载 */
  window.__WHALE_BOOTED__ = true;

  /** 静态资源/数据根前缀：正常为 ''，被 serve.py 根路径映射时为 'site/' */
  function assetBase() {
    return typeof window.__ASSET_BASE__ === 'string' ? window.__ASSET_BASE__ : '';
  }

  /* =====================================================================
   * 0. 常量
   * ===================================================================== */
  var REFRESH_MS = 60 * 1000;
  var MISSING_MSG = '未找到数据文件，请先运行 <code>python run.py</code>';
  var MODE_MAP = { morning: '盘前', evening: '盘后', snapshot: '盘中', intraday: '盘中' };
  var SESSION_MAP = {
    pre_open: '盘前', auction: '集合竞价', open: '盘中',
    closed: '盘后', lunch: '午间休市', close: '盘后'
  };
  var C = {
    up: '#ff4d5e', down: '#16c784', cyan: '#22d3ee', gold: '#f5c451',
    muted: '#7a93ad', text: '#c8d6e6', strong: '#eaf4ff',
    grid: 'rgba(255,255,255,0.055)', axis: 'rgba(255,255,255,0.14)'
  };
  var FONT = '"Microsoft YaHei","PingFang SC","Hiragino Sans GB",system-ui,sans-serif';

  var state = {
    latest: null,
    history: null,
    backtest: null,
    inline: false,
    lastLoadAt: 0,
    charts: new Map(),
    resizeObserver: null,
    timer: null,
    yaoguSort: { key: 'prob', dir: 'desc' },
    historyDetailed: false
  };

  /* =====================================================================
   * 1. 通用工具
   * ===================================================================== */
  function byId(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** 安全转义后再支持 **加粗** 的简易富文本 */
  function richText(s) {
    return esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  }

  /** 安全取数字：null/undefined/''/NaN/非数字 → null */
  function n(v) {
    if (v === null || v === undefined || v === '' || v === false) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    var x = Number(String(v).replace(/,/g, '').replace(/%/g, '').replace(/\s/g, ''));
    return Number.isFinite(x) ? x : null;
  }

  function arr(v) { return Array.isArray(v) ? v : []; }
  function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }

  /** 安全深层取值 */
  function path(o) {
    var cur = o;
    for (var i = 1; i < arguments.length; i++) {
      if (cur == null) return undefined;
      cur = cur[arguments[i]];
    }
    return cur;
  }

  function numOr(v, def) { var x = n(v); return x == null ? def : x; }

  function fmt(v, d) {
    var x = n(v);
    if (x == null) return '—';
    d = d == null ? 2 : d;
    try {
      return x.toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
    } catch (e) { return x.toFixed(d); }
  }

  function fmtInt(v) {
    var x = n(v);
    if (x == null) return '—';
    try { return Math.round(x).toLocaleString('zh-CN'); } catch (e) { return String(Math.round(x)); }
  }

  function fmtPct(v, d, keepSign) {
    var x = n(v);
    if (x == null) return '—';
    d = d == null ? 2 : d;
    var sign = keepSign === false ? '' : (x > 0 ? '+' : '');
    return sign + x.toFixed(d) + '%';
  }

  function fmtPrice(v) {
    var x = n(v);
    if (x == null) return '—';
    var a = Math.abs(x);
    if (a >= 100) return fmt(x, 2);
    if (a >= 1) return x.toFixed(3);
    return x.toFixed(4).replace(/0$/, '');
  }

  /** 个股价格：A 股按 2 位小数显示 */
  function fmtStockPrice(v) {
    var x = n(v);
    if (x == null) return '—';
    return x.toFixed(2);
  }

  /** 亿元 → 自适应 万亿 / 亿 / 万 */
  function fmtYi(v) {
    var x = n(v);
    if (x == null) return '—';
    var a = Math.abs(x);
    if (a >= 10000) return (x / 10000).toFixed(2) + ' 万亿';
    if (a >= 1) return x.toFixed(1) + ' 亿';
    return (x * 10000).toFixed(0) + ' 万';
  }

  /** 元 → 自适应 万 / 元 */
  function fmtYuan(v) {
    var x = n(v);
    if (x == null) return '—';
    if (Math.abs(x) >= 10000) return (x / 10000).toFixed(2) + ' 万元';
    try {
      return x.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' 元';
    } catch (e) { return x.toFixed(2) + ' 元'; }
  }

  /** 大数股数：自适应 亿股 / 万股（后端不同源单位不一致，统一缩放到易读量级） */
  function fmtBigShares(v) {
    var x = n(v);
    if (x == null) return '—';
    var a = Math.abs(x);
    if (a >= 1e8) return (x / 1e8).toFixed(2) + ' 亿';
    if (a >= 1e4) return (x / 1e4).toFixed(1) + ' 万';
    return fmt(x, 0);
  }

  function fmtShares(v) {
    var x = n(v);
    if (x == null) return '—';
    if (Math.abs(x) >= 1e8) return (x / 1e8).toFixed(2) + ' 亿';
    if (Math.abs(x) >= 1e4) return (x / 1e4).toFixed(1) + ' 万';
    return fmtInt(x);
  }

  function dirClass(v) {
    var x = n(v);
    if (x == null) return 'flat';
    return x > 0 ? 'up' : (x < 0 ? 'down' : 'flat');
  }

  function arrow(v) {
    var x = n(v);
    if (x == null) return '';
    return x > 0 ? '▲' : (x < 0 ? '▼' : '—');
  }

  /** 百分比展示：0.68 → 68% */
  function fmtRatioPct(v, d) {
    var x = n(v);
    if (x == null) return '—';
    if (Math.abs(x) <= 1.0001) x = x * 100;
    return x.toFixed(d == null ? 0 : d) + '%';
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  /** #rrggbb 或 #rgb → rgba(r,g,b,a) */
  function alpha(color, a) {
    if (typeof color !== 'string') return 'rgba(34,211,238,' + a + ')';
    var s = color.replace('#', '');
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    if (s.length !== 6) return color;
    var r = parseInt(s.slice(0, 2), 16), g = parseInt(s.slice(2, 4), 16), b = parseInt(s.slice(4, 6), 16);
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return color;
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  function fmtDateTime(s) {
    if (!s || typeof s !== 'string') return '—';
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
    if (m) return m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5];
    return s;
  }

  function timeHM() {
    var d = new Date();
    var p = function (x) { return (x < 10 ? '0' : '') + x; };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function shortDate(s) {
    if (typeof s !== 'string') return '';
    return s.length >= 10 ? s.slice(5, 10) : s;
  }

  function emptyState(text, cls) {
    return '<div class="empty-state' + (cls ? ' ' + cls : '') + '">' + esc(text) + '</div>';
  }

  /* =====================================================================
   * 2. 图表基础设施
   * ===================================================================== */
  function hasECharts() { return typeof window.echarts !== 'undefined' && window.echarts && window.echarts.init; }

  function disposeCharts() {
    state.charts.forEach(function (inst) {
      try { inst.dispose(); } catch (e) { /* ignore */ }
    });
    state.charts.clear();
  }

  function initChart(id) {
    var el = byId(id);
    if (!el) return null;
    var old = state.charts.get(id);
    if (old) { try { old.dispose(); } catch (e) { } state.charts.delete(id); }
    el.innerHTML = '';
    if (!hasECharts()) {
      el.innerHTML = emptyState('ECharts 未加载（请检查 js/vendor/echarts.min.js）');
      return null;
    }
    try {
      var inst = window.echarts.init(el, null, { renderer: 'canvas' });
      state.charts.set(id, inst);
      observeChart(inst, el);
      return inst;
    } catch (e) {
      console.warn('[chart init]', id, e);
      el.innerHTML = emptyState('图表初始化失败');
      return null;
    }
  }

  function chartEmpty(id, text) {
    var el = byId(id);
    if (!el) return;
    var old = state.charts.get(id);
    if (old) { try { old.dispose(); } catch (e) { } state.charts.delete(id); }
    el.innerHTML = emptyState(text);
  }

  function observeChart(inst, el) {
    if (!window.ResizeObserver) return;
    if (!state.resizeObserver) {
      state.resizeObserver = new ResizeObserver(function (entries) {
        window.requestAnimationFrame(function () {
          entries.forEach(function (entry) {
            var id = entry.target && entry.target.id;
            var c = id ? state.charts.get(id) : null;
            if (c) { try { c.resize(); } catch (e) { } }
          });
        });
      });
    }
    try { state.resizeObserver.observe(el); } catch (e) { }
  }

  function baseTooltip(extra) {
    var t = {
      backgroundColor: 'rgba(9,18,30,0.96)',
      borderColor: 'rgba(34,211,238,0.35)',
      borderWidth: 1,
      padding: [8, 12],
      textStyle: { color: '#dbe7f4', fontSize: 12, fontFamily: FONT },
      extraCssText: 'border-radius:8px;box-shadow:0 10px 28px rgba(0,0,0,.55);'
    };
    if (extra) { Object.keys(extra).forEach(function (k) { t[k] = extra[k]; }); }
    return t;
  }

  function axisBase(opt) {
    var a = {
      axisLine: { show: true, lineStyle: { color: C.axis } },
      axisTick: { show: false },
      axisLabel: { color: C.muted, fontSize: 10, fontFamily: FONT },
      splitLine: { show: true, lineStyle: { color: C.grid, type: 'dashed' } }
    };
    if (opt) { Object.keys(opt).forEach(function (k) { a[k] = opt[k]; }); }
    return a;
  }

  function gridBase() {
    return { left: 8, right: 8, top: 30, bottom: 6, containLabel: true };
  }

  /* =====================================================================
   * 3. 各区块渲染
   * ===================================================================== */

  /* ---------- 3.1 顶部状态条 ---------- */
  function renderStatus(p) {
    p = obj(p);
    var meta = obj(p.meta);
    var td = byId('st-trade-date'), gen = byId('st-generated'), mode = byId('st-mode');
    var health = byId('st-health'), refresh = byId('st-refresh'), datanote = byId('st-datanote');

    if (td) td.textContent = meta.trade_date || '—';

    /* 数据时间：突出 HH:mm:ss（上游数据生成时刻，不是行情实时价） */
    var timeSec = fmtTimeSec(meta.generated_at);
    if (gen) {
      gen.textContent = timeSec;
      gen.title = '数据生成时间：' + (meta.generated_at || '—') +
        '\n这是后端采集/计算完成的时刻，不是逐笔实时行情。';
    }

    /* 档位徽标（tech_conviction.profile_label），无该字段则不显示 */
    var tc = obj(p.tech_conviction);
    var profileItem = byId('st-profile-item');
    var profileBadge = byId('st-profile');
    if (profileItem && profileBadge) {
      if (tc.profile_label) {
        profileBadge.textContent = tc.profile_label;
        profileBadge.className = 'badge badge-profile' +
          (/aggressive|激进/.test(String(tc.profile || '') + String(tc.profile_label || '')) ? ' is-aggressive' : '');
        profileBadge.title = '系统当前档位：' + (tc.profile || '—') +
          (tc.horizon ? '（目标周期 ' + tc.horizon + '）' : '');
        profileItem.hidden = false;
      } else {
        profileItem.hidden = true;
      }
    }

    var sInfo = sessionInfo(meta);
    if (mode) {
      mode.textContent = sInfo.label;
      mode.className = 'badge badge-mode' +
        (sInfo.open ? ' is-open' : '') +
        (!sInfo.open && sInfo.label !== '—' ? ' is-closed' : '');
      mode.title = 'mode=' + (meta.mode || '—') + ' / session=' + (meta.session || '—');
    }

    /* 数据节奏：明确「不是实时行情」 */
    if (datanote) {
      if (sInfo.intraday) {
        datanote.textContent = '盘中每 30 分钟刷新 · 非实时行情';
        datanote.className = 'badge badge-data is-intraday';
        datanote.title = '上游数据在交易时段每 30 分钟采集一次（Windows 计划任务）；本页每 60 秒检查是否有新文件。不是逐笔实时行情。';
      } else {
        datanote.textContent = '收盘数据 · 非实时行情';
        datanote.className = 'badge badge-data';
        datanote.title = '当前为非交易时段：展示最近一个交易日的收盘数据。上游盘中每 30 分钟刷新一次。';
      }
    }

    var dh = obj(meta.data_health);
    var ok = numOr(dh.ok, null), failed = numOr(dh.failed, null);
    var total = (ok || 0) + (failed || 0);
    if (health) {
      if (!total) {
        health.textContent = '—';
        health.className = 'status-v';
        health.title = '未提供数据健康度';
      } else {
        var ratio = (ok || 0) / total;
        health.textContent = (ok || 0) + '/' + total + ' · ' + Math.round(ratio * 100) + '%';
        health.className = 'status-v ' + (ratio >= 0.9 ? 'is-good' : (ratio >= 0.6 ? 'is-warn' : 'is-bad'));
        var errs = arr(dh.errors).map(function (e) {
          if (typeof e === 'string') return e;
          if (e && typeof e === 'object') return String(e.module || '') + ' ' + String(e.error || e.message || '');
          return '';
        }).filter(Boolean);
        health.title = errs.length ? ('失败模块：\n' + errs.join('\n')).slice(0, 1200) : '数据源全部正常';
      }
    }

    if (refresh) {
      refresh.textContent = state.lastLoadAt ? timeHM() : '—';
      refresh.title = state.inline ? '离线单文件快照：数据已内联，不自动刷新' : '本页每 60 秒检查一次 latest.json（页面在后台时暂停）';
    }

    var src = byId('ft-source');
    if (src) src.textContent = state.inline ? '离线内联快照' : 'site/data/latest.json';
    var ver = byId('ft-version');
    if (ver) ver.textContent = meta.version || '1.1.0';
  }

  /** ISO 时间 → HH:mm:ss */
  function fmtTimeSec(s) {
    if (typeof s !== 'string') return '—';
    var m = s.match(/[T ](\d{2}:\d{2}:\d{2})/);
    if (m) return m[1];
    var m2 = s.match(/[T ](\d{2}:\d{2})/);
    return m2 ? m2[1] + ':00' : '—';
  }

  /** 由数据生成时间推导「盘前 / 盘中 / 盘后」（优先用时间，避免 stale session/mode 误导）
   *  交易时段：09:15~09:30 集合竞价、09:30~11:30 / 13:00~15:00 连续竞价、11:30~13:00 午休；
   *  若 trade_date 不是今天（看的是历史数据），退回 mode/session 判断并标记为非盘中。 */
  function sessionInfo(meta) {
    var label = '—', open = false, intraday = false;
    var gen = String(meta.generated_at || '');
    var m = gen.match(/[T ](\d{2}):(\d{2})/);
    var sameDay = false;
    try {
      var d = new Date();
      var pad = function (x) { return (x < 10 ? '0' : '') + x; };
      sameDay = String(meta.trade_date || '') === (d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()));
    } catch (e) { sameDay = false; }

    if (m && sameDay) {
      var mins = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
      if (mins < 9 * 60 + 15) { label = '盘前'; }
      else if (mins < 9 * 60 + 30) { label = '盘前'; open = true; intraday = true; }
      else if (mins <= 11 * 60 + 30) { label = '盘中'; open = true; intraday = true; }
      else if (mins < 13 * 60) { label = '盘中'; open = true; intraday = true; }
      else if (mins <= 15 * 60) { label = '盘中'; open = true; intraday = true; }
      else { label = '盘后'; }
      return { label: label, open: open, intraday: intraday };
    }

    /* 非当日数据（或缺少生成时间）：按 mode 为主、session 兜底 */
    var mode = String(meta.mode || '').toLowerCase();
    var session = String(meta.session || '').toLowerCase();
    if (mode === 'morning') { label = '盘前'; }
    else if (mode === 'evening') { label = '盘后'; }
    else if (mode === 'snapshot' || mode === 'intraday') { label = '盘中'; open = true; intraday = true; }
    else if (session === 'open' || session === 'auction' || session === 'lunch') { label = '盘中'; open = true; intraday = true; }
    else if (session === 'pre_open') { label = '盘前'; }
    else if (session === 'closed' || session === 'close') { label = '盘后'; }
    return { label: label, open: open, intraday: intraday };
  }

  /* ---------- 3.2 今日结论 ---------- */
  function renderVerdict(p) {
    var el = byId('verdict-body');
    var stageEl = byId('verdict-stage');
    var r = obj(obj(p).regime);
    if (!el) return;
    if (!Object.keys(r).length) { el.innerHTML = emptyState('政权分析数据缺失'); if (stageEl) stageEl.textContent = '—'; return; }

    var label = r.label || '—';
    var score = n(r.score);
    var prob = obj(r.prob);
    var conf = n(r.confidence);
    var posPct = n(r.position_advice_pct);
    var drivers = arr(r.drivers);
    var summary = r.summary || '';
    var riskNote = r.risk_note || '';
    var stage = r.stage || '';

    if (stageEl) stageEl.textContent = stage || '—';

    var pills = '';
    if (posPct == null) {
      pills += pill('建议总仓位', '—');
    } else {
      var pv = posPct <= 1.0001 ? posPct * 100 : posPct;
      pills += pill('建议总仓位', pv.toFixed(0) + '<small>%</small>');
    }
    pills += pill('置信度', conf == null ? '—' : Math.round(conf <= 1.0001 ? conf * 100 : conf) + '<small>%</small>');
    if (stage) pills += pill('趋势阶段', esc(stage), true);

    var probRows = '';
    var probDefs = [
      { k: 'bull', name: '牛市', cls: 'bull' },
      { k: 'range', name: '震荡', cls: 'range' },
      { k: 'bear', name: '熊市', cls: 'bear' }
    ];
    var hasProb = false;
    probDefs.forEach(function (d) {
      var v = n(prob[d.k]);
      if (v != null) hasProb = true;
      var pct = v == null ? 0 : clamp(v <= 1.0001 ? v * 100 : v, 0, 100);
      probRows +=
        '<div class="prob-row">' +
          '<span class="prob-name">' + d.name + '</span>' +
          '<span class="prob-track"><i class="prob-fill prob-fill--' + d.cls + '" style="width:' + pct.toFixed(1) + '%"></i></span>' +
          '<span class="prob-val">' + (v == null ? '—' : pct.toFixed(0) + '%') + '</span>' +
        '</div>';
    });

    var driverHtml = '';
    if (drivers.length) {
      drivers.forEach(function (d) {
        d = obj(d);
        var val = n(d.value), raw = n(d.raw), w = n(d.weight);
        var barW = val == null ? 0 : clamp(val, 0, 100);
        var sig = String(d.signal || '');
        var sigCls = sig.indexOf('-') >= 0 ? 'sig-minus' : (sig.indexOf('+') >= 0 ? 'sig-plus' : 'sig-flat');
        driverHtml +=
          '<li class="driver-item">' +
            '<span class="driver-name">' + esc(d.name || '—') + '</span>' +
            '<span class="driver-bar-wrap">' +
              '<span class="driver-bar-track"><i class="driver-bar-fill" style="width:' + barW.toFixed(1) + '%"></i></span>' +
              '<span class="driver-text" title="' + esc(d.text || '') + '">' + esc(d.text || '') + '</span>' +
            '</span>' +
            '<span class="driver-val ' + sigCls + '">' + (val == null ? '—' : val.toFixed(0)) +
              (w == null ? '' : '<span class="muted" style="font-size:10px"> /' + Math.round(w * 100) + '%</span>') +
            '</span>' +
          '</li>';
      });
    } else {
      driverHtml = '<li class="empty-state">驱动因子数据缺失</li>';
    }

    var briefs = obj(p.briefs);
    var briefHtml = '';
    if (briefs.morning || briefs.evening) {
      briefHtml = '<div class="brief-row">';
      if (briefs.morning) {
        briefHtml += '<div class="brief"><span class="brief-k">早报</span><p>' + esc(briefs.morning) + '</p></div>';
      }
      if (briefs.evening) {
        briefHtml += '<div class="brief"><span class="brief-k">晚报</span><p>' + esc(briefs.evening) + '</p></div>';
      }
      briefHtml += '</div>';
    }

    el.innerHTML =
      '<div class="hero-main">' +
        '<div class="hero-tag-row">' +
          '<span class="regime-tag">' +
            '<span class="regime-label">' + esc(label) + '</span>' +
            (r.code ? '<span class="regime-code">' + esc(r.code) + '</span>' : '') +
          '</span>' +
          '<span class="regime-score regime-score--hero"><b>' + (score == null ? '—' : score.toFixed(1)) + '</b>' +
            '<span>/100 政权分数</span></span>' +
        '</div>' +
        '<p class="hero-summary">' + (summary ? esc(summary) : '<span class="muted">暂无结论摘要</span>') + '</p>' +
        '<div class="hero-meta-row">' + pills + '</div>' +
        (riskNote ? '<p class="risk-note">' + esc(riskNote) + '</p>' : '') +
        briefHtml +
      '</div>' +
      '<div class="hero-side">' +
        '<div>' +
          '<div class="sub-head"><h3>三态概率</h3><span class="sub-meta">牛市 / 震荡 / 熊市</span></div>' +
          (hasProb ? '<div class="prob-block">' + probRows + '</div>' : emptyState('概率数据缺失')) +
        '</div>' +
        '<div>' +
          '<div class="sub-head"><h3>驱动因子</h3><span class="sub-meta">权重加权</span></div>' +
          '<ul class="driver-list">' + driverHtml + '</ul>' +
        '</div>' +
      '</div>';
  }

  function pill(k, vHtml, small) {
    return '<div class="meta-pill"><span class="k">' + esc(k) + '</span>' +
      '<span class="v"' + (small ? ' style="font-size:12.5px"' : '') + '>' + vHtml + '</span></div>';
  }

  /* ---------- 3.3 市场全景 ---------- */
  function renderMarket(p) {
    var mk = obj(obj(p).market);
    var indices = arr(mk.indices);
    var breadth = obj(mk.breadth);
    var turnover = obj(mk.turnover);
    var emotion = obj(mk.emotion);
    var chart = obj(mk.chart);

    /* 指数卡片 */
    var gridEl = byId('index-grid');
    if (gridEl) {
      if (!indices.length) {
        gridEl.innerHTML = emptyState('指数行情数据缺失（后端 sources.market 未返回）');
      } else {
        gridEl.innerHTML = indices.map(function (it) {
          it = obj(it);
          var chg = n(it.chg_pct);
          var cls = dirClass(chg);
          return '<div class="index-card ' + cls + '">' +
            '<div class="index-name">' + esc(it.name || it.code || '—') + '</div>' +
            '<div class="index-close">' + fmtPrice(it.close) + '</div>' +
            '<div class="index-foot">' +
              '<span class="index-chg ' + cls + '">' + arrow(chg) + ' ' + fmtPct(chg) + '</span>' +
              '<span class="index-amount">' + fmtYi(it.amount_yi) + '</span>' +
            '</div>' +
          '</div>';
        }).join('');
      }
    }

    /* 涨跌家数 */
    var bEl = byId('breadth-body');
    if (bEl) {
      var up = n(breadth.up), down = n(breadth.down), flat = n(breadth.flat);
      if (up == null && down == null) {
        bEl.innerHTML = emptyState('涨跌家数缺失');
      } else {
        up = up || 0; down = down || 0; flat = flat || 0;
        var tot = up + down + flat;
        var pUp = tot ? up / tot * 100 : 0, pDown = tot ? down / tot * 100 : 0;
        var ratio = (down > 0 && up > 0) ? (up / down) : null;
        var upRatio = n(breadth.up_ratio);
        bEl.innerHTML =
          '<div class="breadth-bar">' +
            '<span class="breadth-seg breadth-seg--up" style="width:' + pUp.toFixed(1) + '%"></span>' +
            '<span class="breadth-seg breadth-seg--flat" style="width:' + (100 - pUp - pDown).toFixed(1) + '%"></span>' +
            '<span class="breadth-seg breadth-seg--down" style="width:' + pDown.toFixed(1) + '%"></span>' +
          '</div>' +
          '<div class="breadth-nums">' +
            '<span class="up">涨 <b>' + fmtInt(up) + '</b></span>' +
            '<span class="muted">平 <b>' + fmtInt(flat) + '</b></span>' +
            '<span class="down">跌 <b>' + fmtInt(down) + '</b></span>' +
          '</div>' +
          '<div class="breadth-extra">' +
            '<span>涨跌比 <b class="up">' + (ratio == null ? '—' : ratio.toFixed(2) + ' : 1') + '</b></span>' +
            '<span>上涨占比 <b>' + (upRatio == null ? '—' : (upRatio <= 1.0001 ? (upRatio * 100).toFixed(1) : upRatio.toFixed(1)) + '%') + '</b></span>' +
            '<span>涨停 <b class="up">' + fmtInt(breadth.limit_up) + '</b></span>' +
            '<span>跌停 <b class="down">' + fmtInt(breadth.limit_down) + '</b></span>' +
          '</div>';
      }
    }

    /* 成交额 */
    var tEl = byId('turnover-body');
    if (tEl) {
      var totalYi = n(turnover.total_yi);
      if (totalYi == null) {
        tEl.innerHTML = emptyState('成交额数据缺失');
      } else {
        var r5 = n(turnover.ratio_ma5), r20 = n(turnover.ratio_ma20);
        var levelTxt = turnover.level ? '<span class="level-badge">' + esc(turnover.level) + '</span>' : '';
        tEl.innerHTML =
          '<div class="turnover-main">' +
            '<span class="turnover-num">' + (totalYi >= 10000 ? (totalYi / 10000).toFixed(2) : totalYi.toFixed(0)) + '</span>' +
            '<span class="turnover-unit">' + (totalYi >= 10000 ? '万亿' : '亿') + '</span>' + levelTxt +
          '</div>' +
          '<div class="turnover-rows">' +
            '<span class="row"><span>5 日均额</span><b>' + fmtYi(turnover.ma5_yi) + '</b></span>' +
            '<span class="row"><span>较 5 日均量</span><b class="' + dirClass(r5 == null ? null : r5 - 1) + '">' +
              (r5 == null ? '—' : (r5 >= 1 ? '+' : '') + ((r5 - 1) * 100).toFixed(1) + '%') + '</b></span>' +
            '<span class="row"><span>较 20 日均量</span><b class="' + dirClass(r20 == null ? null : r20 - 1) + '">' +
              (r20 == null ? '—' : (r20 >= 1 ? '+' : '') + ((r20 - 1) * 100).toFixed(1) + '%') + '</b></span>' +
          '</div>';
      }
    }

    /* 情绪仪表盘 */
    var eScore = n(emotion.score);
    var gaugeMeta = byId('emotion-body');
    if (gaugeMeta) {
      var bits = [];
      if (n(emotion.limit_up) != null) bits.push('涨停 <b>' + fmtInt(emotion.limit_up) + '</b>');
      if (n(emotion.limit_down) != null) bits.push('跌停 <b>' + fmtInt(emotion.limit_down) + '</b>');
      if (n(emotion.max_streak) != null) bits.push('最高 <b>' + fmtInt(emotion.max_streak) + '</b> 连板');
      if (n(emotion.broken_rate) != null) {
        var br = n(emotion.broken_rate);
        bits.push('炸板率 <b>' + (br <= 1.0001 ? (br * 100).toFixed(0) : br.toFixed(0)) + '%</b>');
      }
      gaugeMeta.innerHTML = bits.length
        ? '<span class="emotion-stats">' + bits.map(function (b) { return '<span>' + b + '</span>'; }).join('') + '</span>'
        : (emotion.summary ? esc(emotion.summary) : '—');
      if (emotion.summary) gaugeMeta.title = emotion.summary;
    }
    if (eScore == null) {
      chartEmpty('emotion-chart', '情绪数据缺失');
    } else {
      var inst = initChart('emotion-chart');
      if (inst) {
        var gColor = eScore >= 75 ? C.up : (eScore >= 55 ? C.gold : (eScore >= 40 ? C.cyan : C.down));
        inst.setOption({
          animationDuration: 700,
          series: [{
            type: 'gauge',
            startAngle: 215, endAngle: -35, min: 0, max: 100,
            radius: '105%', center: ['50%', '60%'],
            progress: { show: true, width: 9, roundCap: true, itemStyle: { color: gColor } },
            axisLine: { lineStyle: { width: 9, color: [[1, 'rgba(255,255,255,0.07)']] } },
            pointer: { show: false },
            axisTick: { show: false },
            splitLine: { show: false },
            axisLabel: { show: false },
            anchor: { show: false },
            title: {
              offsetCenter: [0, '34%'], color: C.muted, fontSize: 10.5, fontFamily: FONT
            },
            detail: {
              offsetCenter: [0, '-6%'], fontSize: 27, fontWeight: 700, fontFamily: FONT,
              color: '#eaf4ff', formatter: function (v) { return v.toFixed(0); }
            },
            data: [{ value: eScore, name: emotion.label || '情绪' }]
          }]
        }, true);
      }
    }

    /* 上证近 60 日 */
    renderMarketTrend(chart);

    /* 区块 meta */
    var metaEl = byId('market-meta');
    if (metaEl) {
      var parts = [];
      if (totalYi != null) parts.push('两市成交 ' + fmtYi(totalYi));
      if (up != null || down != null) parts.push('涨 ' + fmtInt(up) + ' / 跌 ' + fmtInt(down));
      if (n(mk.breadth && mk.breadth.limit_up) != null) parts.push('涨停 ' + fmtInt(mk.breadth.limit_up));
      metaEl.textContent = parts.length ? parts.join(' · ') : '—';
    }
  }

  function renderMarketTrend(chart) {
    var dates = arr(chart.dates);
    var close = arr(chart.sh_close);
    if (!dates.length || !close.length) {
      chartEmpty('market-trend-chart', '行情序列缺失');
      return;
    }
    var len = Math.min(dates.length, close.length);
    var xs = dates.slice(0, len).map(shortDate);
    var closeData = close.slice(0, len).map(n);
    var ma20 = arr(chart.sh_ma20).slice(0, len).map(n);
    var tno = arr(chart.turnover_yi).slice(0, len).map(n);
    var hasTurn = tno.some(function (v) { return v != null; });

    var inst = initChart('market-trend-chart');
    if (!inst) return;
    var series = [];
    if (hasTurn) {
      series.push({
        name: '两市成交额', type: 'bar', yAxisIndex: 1, data: tno, barMaxWidth: 9,
        itemStyle: { color: 'rgba(34,211,238,0.20)', borderRadius: [2, 2, 0, 0] },
        emphasis: { itemStyle: { color: 'rgba(34,211,238,0.45)' } }
      });
    }
    series.push({
      name: '上证指数', type: 'line', yAxisIndex: 0, data: closeData, smooth: 0.18,
      symbol: 'none', lineStyle: { width: 2, color: C.cyan },
      areaStyle: {
        color: new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: 'rgba(34,211,238,0.26)' },
          { offset: 1, color: 'rgba(34,211,238,0.01)' }
        ])
      }
    });
    if (ma20.some(function (v) { return v != null; })) {
      series.push({
        name: 'MA20', type: 'line', yAxisIndex: 0, data: ma20, smooth: 0.2,
        symbol: 'none', lineStyle: { width: 1.2, color: C.gold, type: 'dashed', opacity: 0.9 }
      });
    }

    inst.setOption({
      animationDuration: 600,
      grid: { left: 6, right: 6, top: 30, bottom: 4, containLabel: true },
      tooltip: baseTooltip({
        trigger: 'axis',
        axisPointer: { type: 'cross', lineStyle: { color: 'rgba(34,211,238,0.45)' }, crossStyle: { color: 'rgba(34,211,238,0.45)' } },
        formatter: function (ps) {
          if (!ps || !ps.length) return '';
          var head = '<div style="font-weight:700;margin-bottom:4px">' + esc(ps[0].axisValue) + '</div>';
          return head + ps.map(function (it) {
            var v = it.value;
            var txt = v == null ? '—' : (it.seriesName === '两市成交额' ? fmtYi(v) : fmt(v, 2));
            return it.marker + it.seriesName + '：<b>' + txt + '</b>';
          }).join('<br>');
        }
      }),
      legend: {
        top: 2, right: 4, itemWidth: 12, itemHeight: 8, itemGap: 10,
        textStyle: { color: C.muted, fontSize: 10, fontFamily: FONT }
      },
      xAxis: [axisBase({
        type: 'category', data: xs, boundaryGap: hasTurn,
        axisLabel: { color: C.muted, fontSize: 9.5, interval: 'auto', hideOverlap: true, fontFamily: FONT }
      })],
      yAxis: [
        axisBase({
          type: 'value', scale: true, name: '', nameTextStyle: { color: C.muted, fontSize: 9 },
          axisLabel: { color: C.muted, fontSize: 9.5, formatter: function (v) { return v >= 1000 ? (v / 1000).toFixed(2) + 'k' : v.toFixed(0); } }
        }),
        axisBase({
          type: 'value', splitLine: { show: false }, axisLine: { show: false },
          axisLabel: { show: false }
        })
      ],
      series: series
    }, true);
  }

  /* ---------- 3.4 宏观面板 ---------- */
  /** 按 key 分组（后端可能每个指标只给一条，也可能给多条历史期），取最新一期 */
  function groupDomestic(domestic) {
    var groups = [], map = {};
    domestic.forEach(function (item) {
      var key = String(item.key || item.indicator || '');
      if (!map[key]) { map[key] = { key: key, items: [] }; groups.push(map[key]); }
      map[key].items.push(item);
    });
    groups.forEach(function (g) {
      g.items.sort(function (a, b) {
        return String(a.period || '').localeCompare(String(b.period || ''));
      });
      g.latest = g.items[g.items.length - 1];
    });
    return groups;
  }

  /** 卡片条目：优先使用后端给的 series，其次用同一 key 的历史期拼出趋势 */
  function macroCardItem(g) {
    var it = {};
    Object.keys(g.latest).forEach(function (k) { it[k] = g.latest[k]; });
    if (!arr(it.series).length && g.items.length > 1) {
      it.series = g.items.map(function (x) { return { period: x.period, value: x.value }; });
    }
    return it;
  }

  function pickMacroCards(groups) {
    var want = ['cpi', 'ppi', 'pmi'];
    var picked = [];
    want.forEach(function (k) {
      var hit = groups.filter(function (x) { return x.key === k; })[0];
      if (hit) picked.push(hit);
    });
    groups.forEach(function (g) {
      if (picked.length < 3 && picked.indexOf(g) < 0) picked.push(g);
    });
    return picked.slice(0, 3);
  }

  function renderMacro(p) {
    var mc = obj(obj(p).macro);
    var domestic = arr(mc.domestic).filter(function (x) { return x && typeof x === 'object'; });
    var groups = groupDomestic(domestic);
    var picked = groups.length ? pickMacroCards(groups) : [];
    var cardsEl = byId('macro-trend-cards');

    if (cardsEl) {
      if (!groups.length) {
        cardsEl.innerHTML = emptyState('宏观指标数据缺失');
      } else {
        var cards = picked.map(function (g) {
          var item = macroCardItem(g);
          var key = String(item.key || g.key || 'k').replace(/[^a-zA-Z0-9_-]/g, '');
          return { item: item, sid: 'macro-spark-' + key };
        });
        cardsEl.innerHTML = cards.map(function (c) {
          return macroCardHtml(c.item, c.sid);
        }).join('');
        cards.forEach(function (c) { renderSparkline(c.sid, c.item); });
      }
    }

    /* 其余指标 chips（每个 key 只显示最新一期） */
    var chipsEl = byId('macro-chips');
    if (chipsEl) {
      var restGroups = groups.filter(function (g) { return picked.indexOf(g) < 0; });
      var chips = restGroups.map(function (g) {
        var x = g.latest;
        var v = n(x.value);
        var unit = x.unit == null ? '' : String(x.unit);
        return '<span class="chip">' + esc(x.indicator || x.key || '—') +
          ' <b>' + (v == null ? '—' : v.toFixed(1) + esc(unit)) + '</b>' +
          (x.period ? ' <small>' + esc(x.period) + '</small>' : '') + '</span>';
      });
      /* 附加项（如 PMI 的 non_manufacturing） */
      picked.concat(restGroups).forEach(function (g) {
        var extra = obj(g.latest.extra);
        Object.keys(extra).forEach(function (k) {
          var ev = n(extra[k]);
          if (ev == null) return;
          var nameMap = { non_manufacturing: '非制造业PMI', new_order: '新订单', production: '生产指数' };
          chips.push('<span class="chip">' + esc(nameMap[k] || k) + ' <b>' + ev.toFixed(1) + '</b>' +
            (g.latest.period ? ' <small>' + esc(g.latest.period) + '</small>' : '') + '</span>');
        });
      });
      chipsEl.innerHTML = chips.join('');
    }

    /* 海外市场 */
    var overseas = arr(mc.overseas);
    var oEl = byId('overseas-strip');
    if (oEl) {
      if (!overseas.length) {
        oEl.innerHTML = emptyState('海外市场数据缺失');
      } else {
        oEl.innerHTML = overseas.map(function (it) {
          it = obj(it);
          var cls = dirClass(it.chg_pct);
          return '<div class="overseas-item">' +
            '<span class="overseas-name" title="' + esc(it.code || '') + '">' + esc(it.name || it.code || '—') + '</span>' +
            '<span class="overseas-close">' + fmtPrice(it.close) + '</span>' +
            '<span class="overseas-chg ' + cls + '">' + arrow(it.chg_pct) + ' ' + fmtPct(it.chg_pct) + '</span>' +
          '</div>';
        }).join('');
      }
    }
    var oSig = byId('overseas-signal');
    if (oSig) {
      var sig = obj(mc.overseas_signal);
      var score = n(sig.score);
      oSig.textContent = sig.label ? (sig.label + (score == null ? '' : ' · ' + score.toFixed(0) + ' 分')) : '—';
      oSig.title = sig.text || '';
    }

    /* 宏观日历 */
    var cal = arr(mc.calendar);
    var calEl = byId('macro-calendar');
    if (calEl) {
      if (!cal.length) {
        calEl.innerHTML = '<li class="empty-state">日历数据缺失</li>';
      } else {
        calEl.innerHTML = cal.slice(0, 6).map(function (e) {
          e = obj(e);
          var imp = clamp(numOr(e.importance, 1), 1, 3);
          var dots = '';
          for (var i = 0; i < 3; i++) dots += '<i class="imp-dot' + (i < imp ? ' on' : '') + '"></i>';
          return '<li class="calendar-item">' +
            '<span class="cal-date">' + esc(e.date || '—') + '</span>' +
            '<span class="cal-title">' + esc(e.title || '—') + '</span>' +
            (e.note ? '<span class="cal-note">' + esc(e.note) + '</span>' : '') +
            '<span class="imp-dots" title="重要度 ' + imp + '/3">' + dots + '</span>' +
          '</li>';
        }).join('');
      }
    }

    var sumEl = byId('macro-summary');
    if (sumEl) sumEl.textContent = mc.summary || '';

    var metaEl = byId('macro-meta');
    if (metaEl) {
      var periods = domestic.map(function (x) { return x.period; }).filter(Boolean);
      metaEl.textContent = periods.length ? ('最新数据期 ' + Array.from(new Set(periods)).sort().slice(-2).join(' / ')) : '—';
    }
  }

  function macroCardHtml(item, sparkId) {
    var v = n(item.value);
    var prev = n(item.prev);
    var chg = n(item.chg);
    var unit = item.unit == null ? '' : String(item.unit);
    var sig = String(item.signal || 'neutral');
    var sigCls = /bull|positive|up|good/i.test(sig) ? 'up' : (/bear|negative|down|bad/i.test(sig) ? 'down' : 'muted');
    var sigLabel = /bull|positive|up|good/i.test(sig) ? '偏多' : (/bear|negative|down|bad/i.test(sig) ? '偏空' : '中性');
    return '<div class="macro-card">' +
      '<div class="macro-card-head">' +
        '<span class="macro-name">' + esc(item.indicator || item.key || '—') + '</span>' +
        '<span class="macro-period">' + esc(item.period || '') + '</span>' +
      '</div>' +
      '<div class="macro-value-row">' +
        '<span class="macro-value">' + (v == null ? '—' : (Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(1))) + '</span>' +
        '<span class="macro-unit">' + esc(unit) + '</span>' +
        '<span class="macro-chg ' + dirClass(chg) + '">' + (chg == null ? '' : arrow(chg) + ' ' + (chg > 0 ? '+' : '') + chg.toFixed(1)) + '</span>' +
        '<span class="signal-tag ' + (sigLabel === '偏多' ? 'bull' : (sigLabel === '偏空' ? 'bear' : 'flat')) + '">' + sigLabel + '</span>' +
      '</div>' +
      '<div class="macro-spark" id="' + sparkId + '"></div>' +
      '<div class="macro-foot">' +
        '<span class="macro-prev">前值 ' + (prev == null ? '—' : prev.toFixed(1)) + esc(unit) + '</span>' +
        '<span class="macro-prev">' + esc(item.period || '') + '</span>' +
      '</div>' +
      (item.text ? '<p class="macro-text">' + esc(item.text) + '</p>' : '') +
    '</div>';
  }

  function renderSparkline(id, item) {
    var series = arr(item.series).filter(function (x) { return x && n(x.value) != null; });
    var values, labels;
    if (series.length >= 2) {
      values = series.map(function (x) { return n(x.value); });
      labels = series.map(function (x) { return String(x.period || ''); });
    } else {
      var prev = n(item.prev), cur = n(item.value);
      if (prev == null || cur == null) {
        var el0 = byId(id);
        if (el0) el0.innerHTML = '';
        return;
      }
      values = [prev, cur];
      labels = ['前值', item.period || '最新'];
    }
    var inst = initChart(id);
    if (!inst) return;
    var chg = n(item.chg);
    var color = chg == null ? C.cyan : (chg > 0 ? C.up : (chg < 0 ? C.down : C.cyan));
    inst.setOption({
      animationDuration: 500,
      grid: { left: 2, right: 2, top: 4, bottom: 2 },
      tooltip: baseTooltip({
        trigger: 'axis',
        formatter: function (ps) {
          if (!ps || !ps.length) return '';
          var i = ps[0].dataIndex;
          return esc(labels[i] || '') + '：<b>' + fmt(values[i], 1) + '</b>';
        }
      }),
      xAxis: { type: 'category', data: labels, show: false, boundaryGap: false },
      yAxis: { type: 'value', show: false, scale: true },
      series: [{
        type: 'line', data: values, smooth: 0.35, symbol: 'none',
        lineStyle: { width: 1.6, color: color },
        areaStyle: {
          color: new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: alpha(color, 0.3) },
            { offset: 1, color: alpha(color, 0) }
          ])
        },
        markPoint: {
          symbol: 'circle', symbolSize: 5, data: [{ coord: [values.length - 1, values[values.length - 1]] }],
          itemStyle: { color: color }, label: { show: false }
        }
      }]
    }, true);
  }

  /* ---------- 3.5 国家队 ---------- */
  function renderNational(p) {
    var nt = obj(obj(p).national_team);
    var score = n(nt.score);
    var ring = byId('national-score-ring');
    var scoreEl = byId('national-score');
    var labelEl = byId('national-label');
    var activeEl = byId('national-active');

    if (scoreEl) scoreEl.textContent = score == null ? '—' : score.toFixed(0);
    if (labelEl) labelEl.textContent = nt.label || '—';
    if (ring) ring.style.setProperty('--pct', String(score == null ? 0 : clamp(score, 0, 100)));
    if (activeEl) {
      activeEl.textContent = nt.active ? '护盘信号：已激活' : '护盘信号：未激活';
      activeEl.className = 'score-ring-foot ' + (nt.active ? 'up' : 'muted');
    }

    var signals = arr(nt.signals);
    var sigEl = byId('national-signals');
    if (sigEl) {
      if (!signals.length) {
        sigEl.innerHTML = '<li class="empty-state">国家队信号缺失</li>';
      } else {
        sigEl.innerHTML = signals.map(function (s) {
          s = obj(s);
          var det = !!s.detected;
          var strength = n(s.strength);
          var w = n(s.weight);
          var pct = strength == null ? 0 : clamp(strength, 0, 1) * 100;
          return '<li class="signal-li">' +
            '<span class="signal-light ' + (det ? 'on' : 'off') + '"></span>' +
            '<span class="signal-main">' +
              '<span class="signal-top">' +
                '<span class="signal-name">' + esc(s.name || '—') + '</span>' +
                '<span class="signal-strength">' + (det ? '命中' : '未命中') +
                  (w == null ? '' : ' · 权重 ' + Math.round(w * 100) + '%') + '</span>' +
              '</span>' +
              '<span class="signal-text">' + esc(s.text || '') + '</span>' +
              '<span class="signal-track"><i class="fill" style="width:' + pct.toFixed(0) + '%"></i></span>' +
            '</span>' +
          '</li>';
        }).join('');
      }
    }

    /* ETF 资金流条形图 */
    renderEtfFlow(arr(nt.etf_flow));

    /* 汇金持仓 */
    var hold = arr(nt.holdings);
    var hEl = byId('national-holdings');
    if (hEl) {
      if (!hold.length) {
        hEl.innerHTML = '<tbody><tr><td class="empty-state">持仓数据缺失</td></tr></tbody>';
      } else {
        hEl.innerHTML =
          '<thead><tr><th>持有人</th><th>代码</th><th>名称</th><th class="num">持股数</th>' +
          '<th class="num">变动</th><th class="num">占比</th><th>报告期</th></tr></thead><tbody>' +
          hold.slice().sort(function (a, b) {
            return numOr(obj(b).hold_num, 0) - numOr(obj(a).hold_num, 0);
          }).slice(0, 10).map(function (x) {
            x = obj(x);
            var chg = n(x.change);
            var ratioVal = n(x.ratio);
            var ratioTxt = ratioVal == null ? '—'
              : (ratioVal <= 1.0001 ? (ratioVal * 100).toFixed(2) : ratioVal.toFixed(2)) + '%';
            return '<tr>' +
              '<td>' + esc(x.holder || '—') + '</td>' +
              '<td class="code-cell">' + esc(x.code || '—') + '</td>' +
              '<td class="name-cell">' + esc(x.name || '—') + '</td>' +
              '<td class="num">' + fmtBigShares(x.hold_num) + '</td>' +
              '<td class="num ' + dirClass(chg) + '">' + (chg == null ? '—' : (chg > 0 ? '+' : '') + chg.toFixed(2)) + '</td>' +
              '<td class="num">' + ratioTxt + '</td>' +
              '<td class="muted">' + esc(x.end_date || '—') + '</td>' +
            '</tr>';
          }).join('') +
            (hold.length > 10 ? '<tr><td colspan="7" class="muted" style="text-align:center">' +
              '共 ' + hold.length + ' 条持仓记录，按持股数降序仅显示前 10 条</td></tr>' : '') +
          '</tbody>';
      }
    }

    var sumEl = byId('national-summary');
    if (sumEl) sumEl.textContent = nt.summary || '';

    var metaEl = byId('national-meta');
    if (metaEl) {
      var detected = signals.filter(function (s) { return s && s.detected; }).length;
      metaEl.textContent = signals.length ? ('命中 ' + detected + ' / ' + signals.length + ' 项信号') : '—';
    }
  }

  function renderEtfFlow(flow) {
    if (!flow.length) { chartEmpty('etf-flow-chart', '宽基 ETF 资金流数据缺失'); return; }
    var items = flow.map(function (x) {
      x = obj(x);
      return {
        name: x.name || x.code || '—',
        amount: n(x.amount_yi),
        ratio: n(x.ratio),
        chg: n(x.chg_pct)
      };
    }).filter(function (x) { return x.amount != null; })
      .sort(function (a, b) { return a.amount - b.amount; });

    if (!items.length) { chartEmpty('etf-flow-chart', '宽基 ETF 资金流数据缺失'); return; }
    var inst = initChart('etf-flow-chart');
    if (!inst) return;
    inst.setOption({
      animationDuration: 700,
      grid: { left: 6, right: 58, top: 8, bottom: 4, containLabel: true },
      tooltip: baseTooltip({
        trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(34,211,238,0.08)' } },
        formatter: function (ps) {
          if (!ps || !ps.length) return '';
          var i = ps[0].dataIndex;
          var it = items[i] || {};
          return esc(it.name) +
            '<br>成交额：<b>' + fmtYi(it.amount) + '</b>' +
            '<br>量能倍数：<b>' + (it.ratio == null ? '—' : it.ratio.toFixed(2) + ' 倍') + '</b>' +
            '<br>涨跌幅：<b class="' + dirClass(it.chg) + '">' + fmtPct(it.chg) + '</b>';
        }
      }),
      xAxis: axisBase({ type: 'value', axisLabel: { show: false }, splitLine: { show: false }, axisLine: { show: false } }),
      yAxis: axisBase({
        type: 'category', data: items.map(function (x) { return x.name; }),
        axisLabel: { color: '#a9c0d6', fontSize: 10.5, width: 118, overflow: 'truncate', fontFamily: FONT },
        splitLine: { show: false }, axisLine: { show: false }
      }),
      series: [{
        type: 'bar', data: items.map(function (x) {
          var hot = x.ratio != null && x.ratio >= 1.2;
          var cold = x.ratio != null && x.ratio < 1.0;
          return {
            value: x.amount,
            itemStyle: {
              borderRadius: [0, 4, 4, 0],
              color: hot
                ? new window.echarts.graphic.LinearGradient(0, 0, 1, 0, [
                    { offset: 0, color: 'rgba(255,77,94,0.25)' }, { offset: 1, color: C.up }])
                : (cold
                  ? new window.echarts.graphic.LinearGradient(0, 0, 1, 0, [
                      { offset: 0, color: 'rgba(147,168,189,0.18)' }, { offset: 1, color: 'rgba(147,168,189,0.65)' }])
                  : new window.echarts.graphic.LinearGradient(0, 0, 1, 0, [
                      { offset: 0, color: 'rgba(34,211,238,0.2)' }, { offset: 1, color: C.cyan }]))
            }
          };
        }),
        barMaxWidth: 14,
        label: {
          show: true, position: 'right', color: '#a9c0d6', fontSize: 10, fontFamily: FONT,
          formatter: function (ps) { return fmtYi(ps.value); }
        }
      }]
    }, true);
  }

  /* ---------- 3.6 焦点 ETF ---------- */
  function renderFocus(p) {
    var fe = obj(obj(p).focus_etf);
    var quote = obj(fe.quote);
    var tech = obj(fe.tech);
    var chart = obj(fe.chart);
    var codeEl = byId('focus-code');
    if (codeEl) codeEl.textContent = fe.code || quote.code || '588170';

    /* 头部报价 */
    var head = byId('focus-head');
    if (head) {
      var price = n(quote.price);
      var chg = n(quote.chg_pct);
      if (price == null && !fe.name) {
        head.innerHTML = emptyState('焦点 ETF 行情数据缺失');
      } else {
        var chgCls = dirClass(chg);
        var qItems = [
          { k: '今开', v: fmtPrice(quote.open) },
          { k: '最高', v: '<span class="up">' + fmtPrice(quote.high) + '</span>' },
          { k: '最低', v: '<span class="down">' + fmtPrice(quote.low) + '</span>' },
          { k: '昨收', v: fmtPrice(quote.pre_close) },
          { k: '成交额', v: fmtYi(quote.amount_yi) },
          { k: '换手率', v: (n(quote.turnover) == null ? '—' : fmtPct(quote.turnover, 2, false)) },
          { k: '量比', v: fmt(quote.vol_ratio, 2) },
          { k: '振幅', v: (n(quote.amplitude) == null ? '—' : fmtPct(quote.amplitude, 2, false)) }
        ];
        if (n(quote.premium_pct) != null) qItems.push({ k: '溢价率', v: fmtPct(quote.premium_pct) });
        head.innerHTML =
          '<div class="focus-price-block">' +
            '<div style="min-width:0">' +
              '<div class="focus-name-row">' +
                '<span class="focus-name">' + esc(fe.name || quote.name || '焦点 ETF') + '</span>' +
                '<span class="focus-code-badge">' + esc(fe.code || quote.code || '—') + '</span>' +
              '</div>' +
              '<div class="focus-price-block" style="margin-top:2px">' +
                '<span class="focus-price ' + chgCls + '">' + fmtPrice(price) + '</span>' +
                '<span class="focus-chg ' + chgCls + '">' + arrow(chg) + ' ' + fmtPct(chg) + '</span>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="focus-quote-grid">' +
            qItems.map(function (x) {
              return '<div class="quote-item"><span class="quote-k">' + esc(x.k) + '</span>' +
                '<span class="quote-v">' + x.v + '</span></div>';
            }).join('') +
          '</div>';
      }
    }

    /* K 线 */
    renderKline(chart, quote);
    /* 分时 */
    renderIntraday(chart, quote);

    /* 技术指标网格 */
    var techEl = byId('focus-tech');
    var techMeta = byId('tech-meta');
    if (techEl) {
      var rows = [];
      var add = function (k, v, cls, small) {
        rows.push({ k: k, v: v, cls: cls || '', small: small || '' });
      };
      if (n(tech.ma5) != null) add('MA5', fmtPrice(tech.ma5));
      if (n(tech.ma10) != null) add('MA10', fmtPrice(tech.ma10));
      if (n(tech.ma20) != null) add('MA20', fmtPrice(tech.ma20));
      if (n(tech.ma60) != null) add('MA60', fmtPrice(tech.ma60));
      if (n(tech.rsi14) != null) add('RSI14', fmt(tech.rsi14, 1), tech.rsi14 >= 70 ? 'up' : (tech.rsi14 <= 30 ? 'down' : ''));
      if (n(tech.macd) != null) add('DIF', fmt(tech.macd, 4), dirClass(tech.macd));
      if (n(tech.macd_signal) != null) add('DEA', fmt(tech.macd_signal, 4), dirClass(tech.macd_signal));
      if (n(tech.macd_hist) != null) add('MACD 柱', fmt(tech.macd_hist, 4), dirClass(tech.macd_hist));
      if (n(tech.atr14) != null) add('ATR14', fmtPrice(tech.atr14));
      if (n(tech.bias20) != null) add('BIAS20', fmtPct(tech.bias20), dirClass(tech.bias20));
      if (n(tech.boll_up) != null) add('布林上轨', fmtPrice(tech.boll_up));
      if (n(tech.boll_mid) != null) add('布林中轨', fmtPrice(tech.boll_mid));
      if (n(tech.boll_low) != null) add('布林下轨', fmtPrice(tech.boll_low));
      var sup = arr(tech.support), res = arr(tech.resistance);
      if (sup.length) add('支撑位', sup.map(function (x) { return fmtPrice(x); }).join(' / '));
      if (res.length) add('压力位', res.map(function (x) { return fmtPrice(x); }).join(' / '));
      if (tech.trend) add('趋势', esc(tech.trend), '', '', true);
      if (tech.vol_state) add('量能', esc(tech.vol_state), '', '', true);

      if (!rows.length) {
        techEl.innerHTML = emptyState('技术指标数据缺失（analysis.etf_view 未就绪）');
        if (techMeta) techMeta.textContent = '—';
      } else {
        techEl.innerHTML = rows.map(function (r) {
          return '<div class="tech-item">' +
            '<div class="tech-k">' + esc(r.k) + '</div>' +
            '<div class="tech-v ' + r.cls + '">' + r.v + '</div>' +
          '</div>';
        }).join('');
        if (techMeta) techMeta.textContent = '基于近 90 个交易日收盘序列计算';
      }
    }

    /* 评级与仓位 */
    var vEl = byId('focus-verdict');
    var verdict = obj(fe.verdict);
    if (vEl) {
      if (!Object.keys(verdict).length) {
        vEl.innerHTML = emptyState('评级数据缺失');
      } else {
        var rating = String(verdict.rating || '—');
        var ratingCls = /买入|加仓|推荐/.test(rating) ? '' : (/观望|持有|中性/.test(rating) ? ' is-watch' : (/卖出|减仓|回避/.test(rating) ? ' is-sell' : ''));
        vEl.innerHTML =
          '<span class="verdict-rating' + ratingCls + '">' + esc(rating) + '</span>' +
          '<span class="verdict-risk"><span>风险等级</span><b class="' + (/高/.test(String(verdict.risk || '')) ? 'up' : '') + '">' +
            esc(verdict.risk || '—') + '</b></span>' +
          '<span class="verdict-one-line">' + esc(verdict.one_line || '') + '</span>';
      }
    }
    renderPosition(byId('focus-position'), obj(fe.position), n(path(p, 'action_plan', 'capital')));

    /* 技术信号 */
    var signals = arr(fe.signals);
    var sEl = byId('focus-signals');
    if (sEl) {
      if (!signals.length) {
        sEl.innerHTML = '<li class="empty-state">技术信号缺失</li>';
      } else {
        sEl.innerHTML = signals.map(function (s) {
          s = obj(s);
          var bull = s.bull === true;
          var cls = bull ? 'bull' : 'bear';
          return '<li class="signal-note ' + cls + '">' +
            '<span class="n">' + esc(s.name || '—') + '</span>' +
            '<span class="v">' + esc(s.value == null ? '' : s.value) + '</span>' +
            '<span class="signal-tag ' + cls + '">' + (bull ? '看多' : '风险') + '</span>' +
            (s.text ? '<span class="t">' + esc(s.text) + '</span>' : '') +
          '</li>';
        }).join('');
      }
    }

    /* 情景推演 */
    var scen = arr(fe.scenarios);
    var scEl = byId('focus-scenarios');
    if (scEl) {
      if (!scen.length) {
        scEl.innerHTML = emptyState('情景推演缺失');
      } else {
        scEl.innerHTML = scen.map(function (s) {
          s = obj(s);
          var p = n(s.prob);
          var pct = p == null ? 0 : clamp(p <= 1.0001 ? p * 100 : p, 0, 100);
          return '<div class="scenario-card">' +
            '<div class="scenario-head">' +
              '<span class="scenario-title">' + esc(s.title || '—') + '</span>' +
              '<span class="scenario-prob">' + (p == null ? '—' : pct.toFixed(0) + '%') + '</span>' +
            '</div>' +
            '<div class="scenario-bar"><i style="width:' + pct.toFixed(1) + '%"></i></div>' +
            '<div class="scenario-desc">' + esc(s.desc || '') + '</div>' +
            (s.action ? '<div class="scenario-action">操作：' + esc(s.action) + '</div>' : '') +
          '</div>';
        }).join('');
      }
    }

    /* 同类 ETF（列按实际字段自适应：后端给多少字段就显示多少列） */
    var peers = arr(fe.peers).filter(function (x) { return x && typeof x === 'object'; });
    var pEl = byId('peers-table');
    if (pEl) {
      if (!peers.length) {
        pEl.innerHTML = '<tbody><tr><td class="empty-state">同类 ETF 数据缺失</td></tr></tbody>';
      } else {
        var hasPrice = peers.some(function (x) { return n(x.price) != null; });
        var hasTurn = peers.some(function (x) { return n(x.turnover) != null; });
        var hasVolR = peers.some(function (x) { return n(x.vol_ratio) != null; });
        var head = '<thead><tr><th>代码</th><th>名称</th>' +
          (hasPrice ? '<th class="num">现价</th>' : '') +
          '<th class="num">涨跌幅</th><th class="num">成交额</th>' +
          (hasTurn ? '<th class="num">换手率</th>' : '') +
          (hasVolR ? '<th class="num">量比</th>' : '') +
          '</tr></thead>';
        pEl.innerHTML = head + '<tbody>' + peers.map(function (x) {
          x = obj(x);
          var cls = dirClass(x.chg_pct);
          return '<tr>' +
            '<td class="code-cell">' + esc(x.code || '—') + '</td>' +
            '<td class="name-cell">' + esc(x.name || '—') + '</td>' +
            (hasPrice ? '<td class="num">' + fmtPrice(x.price) + '</td>' : '') +
            '<td class="num ' + cls + '">' + fmtPct(x.chg_pct) + '</td>' +
            '<td class="num">' + fmtYi(x.amount_yi) + '</td>' +
            (hasTurn ? '<td class="num">' + (n(x.turnover) == null ? '—' : fmtPct(x.turnover, 2, false)) + '</td>' : '') +
            (hasVolR ? '<td class="num">' + fmt(x.vol_ratio, 2) + '</td>' : '') +
          '</tr>';
        }).join('') + '</tbody>';
      }
    }

    /* 基金概况 */
    var fund = obj(fe.fund);
    var fundBlock = byId('fund-block');
    if (fundBlock) {
      /* 只保留有效持仓：有名称或权重 > 0（后端可能只给代码+0 权重，属于缺失数据） */
      var holdings = arr(fund.holdings).filter(function (x) {
        x = obj(x);
        var hasName = x.name && String(x.name).trim();
        var w = n(x.weight);
        return hasName || (w != null && w > 0);
      });
      var hasFundInfo = n(fund.scale_yi) != null || n(fund.shares) != null || holdings.length > 0;
      if (!hasFundInfo) {
        fundBlock.hidden = true;
      } else {
        fundBlock.hidden = false;
        var fMeta = byId('fund-meta');
        if (fMeta) {
          var bits = [];
          if (n(fund.scale_yi) != null) bits.push('规模 ' + fmtYi(fund.scale_yi));
          if (n(fund.shares) != null) bits.push('份额 ' + fmtShares(fund.shares) + '份');
          fMeta.textContent = bits.join(' · ') || '—';
        }
        var hb = byId('fund-holdings');
        if (hb) {
          if (!holdings.length) {
            hb.innerHTML = emptyState('重仓股明细缺失');
          } else {
            var maxW = holdings.reduce(function (m, x) { return Math.max(m, numOr(x && x.weight, 0)); }, 0) || 1;
            hb.innerHTML = holdings.map(function (x) {
              x = obj(x);
              var w = numOr(x.weight, 0);
              return '<div class="holding-row">' +
                '<span class="holding-name" title="' + esc(x.name || '') + '">' + esc(x.name || x.code || '—') +
                  '<small>' + esc(x.code || '') + '</small></span>' +
                '<span class="holding-track"><i style="width:' + (w / maxW * 100).toFixed(1) + '%"></i></span>' +
                '<span class="holding-weight">' + w.toFixed(2) + '%</span>' +
              '</div>';
            }).join('');
          }
        }
      }
    }

    var metaEl = byId('focus-meta');
    if (metaEl) {
      var dates = arr(chart.dates);
      var bits2 = [];
      if (dates.length) bits2.push('K 线 ' + dates.length + ' 根');
      if (n(quote.vol) != null) bits2.push('成交量 ' + fmtShares(quote.vol) + '份');
      metaEl.textContent = bits2.length ? bits2.join(' · ') : '—';
    }
  }

  function renderPosition(el, pos, capital) {
    if (!el) return;
    var pct = n(pos.suggest_pct);
    var shares = n(pos.shares), amount = n(pos.amount);
    if (pct == null && shares == null && amount == null) {
      el.innerHTML = emptyState('仓位建议缺失（analysis.risk 未就绪）');
      return;
    }
    var reasons = arr(pos.reasons).filter(Boolean);
    var noPlan = (shares == null || shares === 0) && (amount == null || amount === 0) &&
      !arr(pos.entry_zone).length && n(pos.stop_loss) == null;
    if (noPlan) {
      el.innerHTML =
        '<div class="position-head">' +
          '<span class="position-pct">空仓</span>' +
          '<span class="position-desc">当前不建议建仓，等待信号确认' +
            (n(capital) == null ? '' : '（本金 ' + fmtYuan(capital) + '）') + '</span>' +
        '</div>' +
        (reasons.length ? '<ul class="pos-reasons">' + reasons.map(function (r) {
          return '<li>' + esc(r) + '</li>';
        }).join('') + '</ul>' : '');
      return;
    }
    var pctTxt = pct == null ? '—' : (pct <= 1.0001 ? (pct * 100).toFixed(0) : pct.toFixed(0)) + '%';
    var entry = arr(pos.entry_zone).map(function (x) { return fmtPrice(x); });
    var tp = arr(pos.take_profit).map(function (x) { return fmtPrice(x); });
    var lots = n(pos.lots);
    var metrics = [
      { k: '可买份额', v: shares == null ? '—' : (fmtInt(shares) + (lots == null ? '' : '（' + fmtInt(lots) + ' 手）')) },
      { k: '拟投入', v: amount == null ? '—' : fmtYuan(amount) },
      { k: '剩余现金', v: pos.cash_pct == null ? '—' : (n(pos.cash_pct) <= 1.0001 ? (n(pos.cash_pct) * 100).toFixed(0) : n(pos.cash_pct).toFixed(0)) + '%' },
      { k: '进场区间', v: entry.length ? entry.join(' - ') : '—' },
      { k: '止损位', v: n(pos.stop_loss) == null ? '—' : '<span class="down">' + fmtPrice(pos.stop_loss) + '</span>' },
      { k: '目标位', v: tp.length ? '<span class="up">' + tp.join(' / ') + '</span>' : '—' }
    ];
    el.innerHTML =
      '<div class="position-head">' +
        '<span class="position-pct">' + pctTxt + '</span>' +
        '<span class="position-desc">建议投入占总资金比例' +
          (n(capital) == null ? '' : '（本金 ' + fmtYuan(capital) + '）') + '</span>' +
      '</div>' +
      '<div class="position-metrics">' +
        metrics.map(function (m) {
          return '<div class="pm"><span class="pm-k">' + esc(m.k) + '</span>' +
            '<span class="pm-v">' + m.v + '</span></div>';
        }).join('') +
      '</div>' +
      (reasons.length ? '<ul class="pos-reasons">' + reasons.map(function (r) {
        return '<li>' + esc(r) + '</li>';
      }).join('') + '</ul>' : '');
  }

  /* ---- K 线 ---- */
  function buildKlineSeries(chart) {
    var dates = arr(chart.dates);
    var close = arr(chart.close);
    if (!dates.length || !close.length) return null;
    var len = Math.min(dates.length, close.length);
    var O = arr(chart.open), H = arr(chart.high), L = arr(chart.low);
    var hasOHLC = O.length >= len && H.length >= len && L.length >= len;
    var candles = [];
    var closes = [];
    var valid = 0;
    for (var i = 0; i < len; i++) {
      var c = n(close[i]);
      var o = n(O[i]), h = n(H[i]), l = n(L[i]);
      var pc = i > 0 ? n(close[i - 1]) : c;
      if (c == null) { candles.push(null); closes.push(null); continue; }
      if (o == null) o = pc == null ? c : pc;
      var isBad = (h == null || l == null || !(h >= Math.max(o, c)) || !(l <= Math.min(o, c)));
      if (isBad) { /* 缺少 OHLC：用相邻收盘合成近似影线，保证仍能画出 K 线 */
        var hi0 = Math.max(o, c), lo0 = Math.min(o, c);
        var pad = Math.max(Math.abs(c - (pc == null ? c : pc)), Math.abs(c) * 0.004); 
        h = Math.max(hi0, c) + pad * 0.55;
        l = Math.max(0.0001, lo0 - pad * 0.55);
      }
      candles.push([+o.toFixed(4), +h.toFixed(4), +l.toFixed(4), +c.toFixed(4)]);
      closes.push(c);
      valid++;
    }
    if (!valid) return null;
    var ma5In = arr(chart.ma5), ma20In = arr(chart.ma20);
    var ma5 = [], ma20 = [];
    if (ma5In.length >= len) { ma5 = ma5In.slice(0, len).map(n); }
    if (ma20In.length >= len) { ma20 = ma20In.slice(0, len).map(n); }
    if (!ma5.some(function (v) { return v != null; })) ma5 = movingAvg(closes, 5);
    if (!ma20.some(function (v) { return v != null; })) ma20 = movingAvg(closes, 20);
    var vol = arr(chart.vol).slice(0, len).map(n);
    return {
      dates: dates.slice(0, len), candles: candles, close: closes,
      ma5: ma5, ma20: ma20, vol: vol, synthetic: !hasOHLC
    };
  }

  function movingAvg(values, period) {
    var out = [];
    for (var i = 0; i < values.length; i++) {
      if (i < period - 1) { out.push(null); continue; }
      var s = 0, cnt = 0;
      for (var j = i - period + 1; j <= i; j++) { if (values[j] != null) { s += values[j]; cnt++; } }
      out.push(cnt ? +(s / cnt).toFixed(4) : null);
    }
    return out;
  }

  function emaSeries(values, period) {
    var k = 2 / (period + 1), out = [], prev = null;
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      if (v == null) { out.push(null); continue; }
      prev = prev == null ? v : v * k + prev * (1 - k);
      out.push(prev);
    }
    return out;
  }

  function macdSeries(closes) {
    var ema12 = emaSeries(closes, 12), ema26 = emaSeries(closes, 26);
    var dif = [], i;
    for (i = 0; i < closes.length; i++) {
      dif.push((ema12[i] == null || ema26[i] == null) ? null : ema12[i] - ema26[i]);
    }
    var dea = emaSeries(dif, 9);
    var hist = [];
    for (i = 0; i < dif.length; i++) {
      hist.push((dif[i] == null || dea[i] == null) ? null : (dif[i] - dea[i]) * 2);
    }
    return { dif: dif, dea: dea, hist: hist };
  }

  function renderKline(chart, quote) {
    var data = buildKlineSeries(chart);
    var metaEl = byId('kline-meta');
    if (!data) {
      chartEmpty('kline-chart', 'K 线数据缺失（sources.etf 未返回日线）');
      if (metaEl) metaEl.textContent = '—';
      return;
    }
    if (metaEl) {
      metaEl.textContent = data.dates.length + ' 根 · 至 ' + (data.dates[data.dates.length - 1] || '—');
    }
    var inst = initChart('kline-chart');
    if (!inst) return;
    var xs = data.dates.map(shortDate);
    var hasVol = data.vol.some(function (v) { return v != null; });
    var maxVol = data.vol.reduce(function (m, v) { return v != null ? Math.max(m, v) : m; }, 0);
    var volUnit = maxVol > 1e5 ? '' : '（亿份）';
    var macd = macdSeries(data.close);

    var grids = [
      { left: 8, right: 52, top: 26, height: '44%', containLabel: true },
      { left: 8, right: 52, top: '60%', height: '13%', containLabel: true },
      { left: 8, right: 52, top: '78%', height: '14%', containLabel: true }
    ];
    var xAxes = [0, 1, 2].map(function (gi) {
      return axisBase({
        type: 'category', data: xs, gridIndex: gi, boundaryGap: true,
        axisLabel: gi === 2 ? { color: C.muted, fontSize: 9, fontFamily: FONT } : { show: false },
        axisLine: { show: gi === 2, lineStyle: { color: C.axis } },
        splitLine: { show: false },
        axisTick: { show: false },
        axisPointer: { label: { show: gi === 0 } }
      });
    });
    var yAxes = [
      axisBase({ scale: true, gridIndex: 0, position: 'right', splitLine: { show: true, lineStyle: { color: C.grid, type: 'dashed' } } }),
      axisBase({ scale: true, gridIndex: 1, position: 'right', splitNumber: 2, axisLabel: { color: C.muted, fontSize: 9, fontFamily: FONT, formatter: function (v) { return v >= 10000 ? (v / 10000).toFixed(0) + '万' : v; } }, splitLine: { show: true, lineStyle: { color: C.grid, type: 'dashed' } } }),
      axisBase({ scale: true, gridIndex: 2, position: 'right', splitNumber: 2, axisLabel: { color: C.muted, fontSize: 9, fontFamily: FONT, formatter: function (v) { return (v * 1000).toFixed(0); } }, splitLine: { show: true, lineStyle: { color: C.grid, type: 'dashed' } } })
    ];

    inst.setOption({
      animationDuration: 600,
      axisPointer: { link: [{ xAxisIndex: 'all' }], label: { backgroundColor: 'rgba(9,18,30,.95)' } },
      tooltip: baseTooltip({
        trigger: 'axis',
        axisPointer: { type: 'cross', lineStyle: { color: 'rgba(34,211,238,0.4)' }, crossStyle: { color: 'rgba(34,211,238,0.4)' } },
        formatter: function (ps) {
          if (!ps || !ps.length) return '';
          var idx = -1;
          ps.forEach(function (p) { if (p.seriesName === 'K线' && idx < 0) idx = p.dataIndex; });
          if (idx < 0) idx = ps[0].dataIndex;
          var cd = data.candles[idx] || [];
          var d = data.dates[idx] || '';
          var prev = idx > 0 ? data.close[idx - 1] : null;
          var chg = (prev && data.close[idx] != null) ? (data.close[idx] / prev - 1) * 100 : null;
          var cls = dirClass(chg);
          var html = '<div style="font-weight:700;margin-bottom:4px">' + esc(d) + '</div>';
          html += '<div style="line-height:1.75">开 <b>' + fmtPrice(cd[0]) + '</b>　高 <b class="up">' + fmtPrice(cd[1]) + '</b><br>' +
            '低 <b class="down">' + fmtPrice(cd[2]) + '</b>　收 <b>' + fmtPrice(cd[3]) + '</b></div>';
          if (chg != null) html += '<div style="margin-top:3px">涨跌 <b class="' + cls + '">' + fmtPct(chg) + '</b></div>';
          if (data.ma5[idx] != null) html += '<div style="margin-top:3px">MA5 <b>' + fmtPrice(data.ma5[idx]) + '</b>　MA20 <b>' + fmtPrice(data.ma20[idx]) + '</b></div>';
          if (data.vol[idx] != null) html += '<div style="margin-top:3px">成交量 <b>' + fmtShares(data.vol[idx]) + '</b></div>';
          if (macd.hist[idx] != null) html += '<div style="margin-top:3px">MACD 柱 <b class="' + dirClass(macd.hist[idx]) + '">' + fmt(macd.hist[idx], 4) + '</b></div>';
          return html;
        }
      }),
      grid: grids,
      xAxis: xAxes,
      yAxis: yAxes,
      dataZoom: [
        { type: 'inside', xAxisIndex: [0, 1, 2], start: Math.max(0, 100 - 100 * 60 / Math.max(1, xs.length)), end: 100 }
      ],
      series: [
        {
          name: 'K线', type: 'candlestick', xAxisIndex: 0, yAxisIndex: 0, data: data.candles,
          itemStyle: {
            color: C.up, color0: C.down, borderColor: C.up, borderColor0: C.down, borderWidth: 1
          }
        },
        {
          name: 'MA5', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: data.ma5,
          smooth: true, symbol: 'none', lineStyle: { width: 1.3, color: C.cyan, opacity: 0.95 }
        },
        {
          name: 'MA20', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: data.ma20,
          smooth: true, symbol: 'none', lineStyle: { width: 1.3, color: C.gold, opacity: 0.85 }
        },
        {
          name: '成交量', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: data.vol, barMaxWidth: 8,
          itemStyle: {
            color: function (ps) {
              var i = ps.dataIndex;
              var prev = i > 0 ? data.close[i - 1] : null;
              var c = data.close[i];
              return (prev != null && c != null && c >= prev) ? 'rgba(255,77,94,0.55)' : 'rgba(22,199,132,0.55)';
            }
          }
        },
        {
          name: 'MACD 柱', type: 'bar', xAxisIndex: 2, yAxisIndex: 2, data: macd.hist, barMaxWidth: 6,
          itemStyle: {
            color: function (ps) {
              return (ps.value != null && ps.value >= 0) ? 'rgba(255,77,94,0.6)' : 'rgba(22,199,132,0.6)';
            }
          }
        },
        {
          name: 'DIF', type: 'line', xAxisIndex: 2, yAxisIndex: 2, data: macd.dif,
          symbol: 'none', lineStyle: { width: 1.1, color: C.cyan, opacity: 0.9 }
        },
        {
          name: 'DEA', type: 'line', xAxisIndex: 2, yAxisIndex: 2, data: macd.dea,
          symbol: 'none', lineStyle: { width: 1.1, color: C.gold, opacity: 0.8 }
        }
      ]
    }, true);
  }

  function renderIntraday(chart, quote) {
    var it = obj(chart.intraday);
    var times = arr(it.times);
    var prices = arr(it.prices).map(n);
    var len = Math.min(times.length, prices.length);
    if (!len) {
      chartEmpty('intraday-chart', '分时数据缺失');
      var m = byId('intraday-meta');
      if (m) m.textContent = '—';
      return;
    }
    var xs = [], ys = [];
    for (var i = 0; i < len; i++) {
      var p = prices[i];
      if (p == null) continue;
      xs.push(String(times[i] || '').replace(/^\d{4}-\d{2}-\d{2}\s*/, '').slice(0, 5));
      ys.push(p);
    }
    if (!ys.length) { chartEmpty('intraday-chart', '分时数据缺失'); return; }

    var preClose = n(quote.pre_close);
    if (preClose == null) preClose = ys[0];
    var avg = [];
    var sum = 0;
    for (var j = 0; j < ys.length; j++) { sum += ys[j]; avg.push(+(sum / (j + 1)).toFixed(4)); }
    var last = ys[ys.length - 1];
    var yMin = Math.min.apply(null, ys.concat([preClose]));
    var yMax = Math.max.apply(null, ys.concat([preClose]));
    var pad = Math.max((yMax - yMin) * 0.18, preClose * 0.004);
    var lineColor = last >= preClose ? C.up : C.down;

    var metaEl = byId('intraday-meta');
    if (metaEl) {
      var dev = preClose ? (last / preClose - 1) * 100 : null;
      metaEl.textContent = xs[0] + ' - ' + xs[xs.length - 1] + ' · 收 ' + fmtPrice(last) + '（' + fmtPct(dev) + '）';
    }

    var inst = initChart('intraday-chart');
    if (!inst) return;
    inst.setOption({
      animationDuration: 600,
      grid: { left: 6, right: 52, top: 16, bottom: 22, containLabel: true },
      tooltip: baseTooltip({
        trigger: 'axis',
        axisPointer: { type: 'cross', lineStyle: { color: 'rgba(34,211,238,0.4)' }, crossStyle: { color: 'rgba(34,211,238,0.4)' } },
        formatter: function (ps) {
          if (!ps || !ps.length) return '';
          var i = ps[0].dataIndex;
          var dev = preClose ? (ys[i] / preClose - 1) * 100 : null;
          return '<div style="font-weight:700;margin-bottom:3px">' + esc(xs[i]) + '</div>' +
            '价格：<b class="' + dirClass(dev) + '">' + fmtPrice(ys[i]) + '</b>（' + fmtPct(dev) + '）<br>' +
            '均价：<b>' + fmtPrice(avg[i]) + '</b>';
        }
      }),
      xAxis: axisBase({
        type: 'category', data: xs, boundaryGap: false,
        axisLabel: {
          color: C.muted, fontSize: 9, fontFamily: FONT, hideOverlap: true,
          interval: function (idx) {
            var t = xs[idx] || '';
            return t === '09:30' || t === '10:30' || t === '11:30' || t === '14:00' || t === '15:00';
          }
        },
        splitLine: { show: false }
      }),
      yAxis: axisBase({
        scale: true, position: 'right', splitNumber: 5,
        axisLabel: { color: C.muted, fontSize: 9, fontFamily: FONT, formatter: function (v) { return v.toFixed(3); } }
      }),
      series: [
        {
          name: '价格', type: 'line', data: ys, symbol: 'none', smooth: false,
          lineStyle: { width: 1.6, color: lineColor },
          areaStyle: {
            color: new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: last >= preClose ? 'rgba(255,77,94,0.26)' : 'rgba(22,199,132,0.26)' },
              { offset: 1, color: 'rgba(0,0,0,0)' }
            ])
          },
          markLine: {
            silent: true, symbol: 'none',
            lineStyle: { color: 'rgba(147,168,189,0.55)', type: 'dashed', width: 1 },
            label: { show: true, position: 'insideEndTop', color: C.muted, fontSize: 9, formatter: '昨收 ' + fmtPrice(preClose) },
            data: [{ yAxis: preClose }]
          }
        },
        {
          name: '均价', type: 'line', data: avg, symbol: 'none',
          lineStyle: { width: 1, color: C.gold, opacity: 0.75, type: 'dashed' }
        }
      ]
    }, true);
  }

  /* ---------- 3.7 妖股监控 ---------- */
  function renderYaogu(p) {
    var yg = obj(obj(p).yaogu);
    var list = arr(yg.list).filter(function (x) { return x && typeof x === 'object'; });
    var stats = obj(yg.stats);

    var statsEl = byId('yaogu-stats');
    if (statsEl) {
      statsEl.innerHTML =
        '<span class="stat-pill">扫描个股 <b>' + fmtInt(stats.scanned) + '</b></span>' +
        '<span class="stat-pill">异常识别 <b>' + fmtInt(stats.flagged) + '</b></span>' +
        '<span class="stat-pill">入选榜单 <b>' + fmtInt(stats.reported != null ? stats.reported : list.length) + '</b></span>';
    }

    var sumEl = byId('yaogu-summary');
    if (sumEl) sumEl.textContent = yg.summary || '';

    var metaEl = byId('yaogu-meta');
    if (metaEl) metaEl.textContent = yg.model_version ? ('模型 v' + yg.model_version) : '—';

    var tbody = byId('yaogu-tbody');
    if (!tbody) return;
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="13" class="empty-state">今日无入选标的（或妖股模型数据缺失）</td></tr>';
      return;
    }

    var sorted = list.slice().sort(function (a, b) {
      var key = state.yaoguSort.key, dir = state.yaoguSort.dir === 'asc' ? 1 : -1;
      var av = n(a[key]), bv = n(b[key]);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av - bv) * dir;
    });

    tbody.innerHTML = sorted.map(function (x, i) {
      x = obj(x);
      var prob = n(x.prob);
      var pct = prob == null ? 0 : clamp(prob <= 1.0001 ? prob * 100 : prob, 0, 100);
      var level = String(x.level || '');
      var lvCls = /高/.test(level) ? 'lv-high' : (/低/.test(level) ? 'lv-low' : 'lv-mid');
      var reasons = arr(x.reasons);
      var concepts = arr(x.concepts);
      var tags = reasons.map(function (r) { return '<span class="tag">' + esc(r) + '</span>'; })
        .concat(concepts.map(function (r) { return '<span class="tag" style="color:#22d3ee">' + esc(r) + '</span>'; }));
      return '<tr>' +
        '<td class="col-rank">' + (i + 1) + '</td>' +
        '<td class="code-cell">' + esc(x.code || '—') + '</td>' +
        '<td class="name-cell">' + esc(x.name || '—') + '</td>' +
        '<td class="muted">' + esc(x.industry || '—') + '</td>' +
        '<td class="num">' + fmtStockPrice(x.price) + '</td>' +
        '<td class="num ' + dirClass(x.chg_pct) + '">' + fmtPct(x.chg_pct) + '</td>' +
        '<td class="num">' + fmtYi(x.amount_yi) + '</td>' +
        '<td class="num">' + fmt(x.vol_ratio, 2) + '</td>' +
        '<td class="num">' + (n(x.turnover) == null ? '—' : fmtPct(x.turnover, 2, false)) + '</td>' +
        '<td class="num">' + (n(x.limit_streak) == null ? '—' : fmtInt(x.limit_streak) + ' 板') + '</td>' +
        '<td class="num"><span class="prob-cell"><span class="prob-mini-track">' +
          '<i class="prob-mini-fill ' + lvCls + '" style="width:' + pct.toFixed(1) + '%"></i></span>' +
          '<span class="prob-mini-num">' + (prob == null ? '—' : pct.toFixed(0) + '%') + '</span></span></td>' +
        '<td>' + (level ? '<span class="level-tag ' + lvCls + '">' + esc(level) + '</span>' : '—') + '</td>' +
        '<td><span class="tag-row">' + (tags.length ? tags.join('') : '<span class="muted">—</span>') + '</span></td>' +
      '</tr>';
    }).join('');

    updateSortHeaders();
  }

  function updateSortHeaders() {
    var ths = document.querySelectorAll('.sortable-table th.sortable');
    Array.prototype.forEach.call(ths, function (th) {
      var key = th.getAttribute('data-sort');
      var ind = th.querySelector('.sort-ind');
      var active = key === state.yaoguSort.key;
      th.classList.toggle('active', active);
      if (ind) ind.textContent = active ? (state.yaoguSort.dir === 'asc' ? '▲' : '▼') : '';
    });
  }

  function bindYaoguSort() {
    var table = byId('yaogu-table');
    if (!table) return;
    table.addEventListener('click', function (e) {
      var th = e.target.closest ? e.target.closest('th.sortable') : null;
      if (!th) return;
      var key = th.getAttribute('data-sort');
      if (!key) return;
      if (state.yaoguSort.key === key) {
        state.yaoguSort.dir = state.yaoguSort.dir === 'desc' ? 'asc' : 'desc';
      } else {
        state.yaoguSort.key = key;
        state.yaoguSort.dir = 'desc';
      }
      if (state.latest) renderYaogu(state.latest);
    });
  }

  /* ---------- 3.8 规则回测（data/backtest.json 缺失时整块隐藏） ---------- */
  var BACKTEST_VARIANTS = [
    { key: 'strategy', name: '规则策略（最低佣金 5 元）', cls: 'bt-row--rule', dot: 'bt-dot--rule' },
    { key: 'strategy_free5', name: '规则策略（免 5 账户）', cls: 'bt-row--rule', dot: 'bt-dot--free' },
    { key: 'hold', name: '买入持有（满仓不动）', cls: 'bt-row--hold', dot: 'bt-dot--hold' },
    { key: 'half', name: '半仓策略', cls: 'bt-row--half', dot: 'bt-dot--half' },
    { key: 'hs300etf', name: '沪深300ETF 基准', cls: 'bt-row--bench', dot: 'bt-dot--bench' }
  ];

  function renderBacktest() {
    var sec = byId('sec-backtest');
    if (!sec) return;
    var bt = obj(state.backtest);
    var metrics = obj(bt.metrics);
    var curves = obj(bt.curves);
    var params = obj(bt.params);
    var verdict = obj(bt.verdict);

    /* 文件不存在 / ok=false / 无指标 → 整块隐藏，不显示任何报错 */
    if (bt.ok === false || !Object.keys(metrics).length) {
      sec.hidden = true;
      var ce = byId('equity-chart');
      if (ce) { var oldInst = state.charts.get('equity-chart'); if (oldInst) { try { oldInst.dispose(); } catch (e) { } state.charts.delete('equity-chart'); } ce.innerHTML = ''; }
      return;
    }
    sec.hidden = false;

    /* 区块 meta：区间 / 本金 / K 线数 / 标的 */
    var metaEl = byId('backtest-meta');
    if (metaEl) {
      var bits = [];
      if (params.start && params.end) bits.push('区间 ' + params.start + ' ~ ' + params.end);
      if (n(params.initial) != null) bits.push('本金 ' + fmtYuan(params.initial));
      if (n(params.bars) != null) bits.push(fmtInt(params.bars) + ' 根 K 线');
      if (params.asset) bits.push(String(params.asset));
      metaEl.textContent = bits.length ? bits.join(' · ') : '—';
    }

    /* 顶部摘要 + 免5 关键对比 */
    var heroEl = byId('backtest-hero');
    if (heroEl) {
      var score = n(verdict.score);
      var scoreHtml = score == null ? '' :
        '<div class="bt-score"><b>' + score.toFixed(0) + '</b><span>回测评分</span></div>';
      var verdictHtml = verdict.text
        ? '<div class="bt-verdict">' + scoreHtml + '<p>' + richText(verdict.text) + '</p></div>'
        : '';

      heroEl.innerHTML = verdictHtml + backtestCalloutHtml(metrics, params);
    }

    /* 净值曲线 */
    renderEquityChart(curves, params);

    /* 对比表 */
    var tbody = byId('backtest-tbody');
    if (tbody) {
      var maxRet = -Infinity;
      BACKTEST_VARIANTS.forEach(function (v) {
        var r = n(obj(metrics[v.key]).total_return_pct);
        if (r != null) maxRet = Math.max(maxRet, r);
      });
      var rows = BACKTEST_VARIANTS.filter(function (v) {
        return Object.keys(obj(metrics[v.key])).length > 0;
      }).map(function (v) {
        var m = obj(metrics[v.key]);
        var ret = n(m.total_return_pct);
        var isBest = ret != null && ret === maxRet;
        return '<tr class="' + v.cls + '">' +
          '<td><span class="bt-name"><i class="bt-dot ' + v.dot + '"></i>' + esc(v.name) + '</span></td>' +
          '<td class="num">' + fmtYuan(m.final) + '</td>' +
          '<td class="num ' + dirClass(ret) + '">' +
            (ret == null ? '—' : (ret > 0 ? '+' : '') + ret.toFixed(2) + '%') +
            (isBest ? ' <span class="bt-best" title="区间收益最高">★</span>' : '') + '</td>' +
          '<td class="num"><span class="bt-dd">' + fmtPct(m.max_drawdown_pct) + '</span></td>' +
          '<td class="num">' + fmt(m.sharpe, 2) + '</td>' +
          '<td class="num">' + (n(m.trades) == null ? '—' : fmtInt(m.trades) + ' 次') + '</td>' +
          '<td class="num">' + (n(m.win_rate_pct) == null ? '—' : fmtPct(m.win_rate_pct, 1, false)) + '</td>' +
          '<td class="num">' + (n(m.total_cost) == null ? '—' : fmtYuan(m.total_cost)) +
            (n(m.cost_pct_of_capital) == null ? '' :
              ' <small class="muted">(' + n(m.cost_pct_of_capital).toFixed(1) + '%)</small>') + '</td>' +
        '</tr>';
      }).join('');
      tbody.innerHTML = rows || '<tr><td colspan="8" class="empty-state">回测指标缺失</td></tr>';
    }

    /* 口径说明 */
    var noteEl = byId('backtest-note');
    if (noteEl) {
      var cm = n(params.commission_min);
      var rate = n(params.commission_rate);
      var feeText = (cm == null && rate == null) ? ''
        : '手续费口径：最低 ' + (cm == null ? '—' : cm.toFixed(0) + ' 元') +
          (rate == null ? '' : ' / 万 ' + (rate * 10000).toFixed(1));
      noteEl.innerHTML = '<b>口径说明：</b>' + esc(feeText || '按回测脚本默认口径') +
        '；不含滑点与冲击成本。回测基于历史数据、存在过拟合可能，<b>回测不代表未来</b>，' +
        '也不构成投资建议。';
    }
  }

  /** 免 5 账户 vs 最低佣金 5 元 的收益差（关键发现） */
  function backtestCalloutHtml(metrics, params) {
    var a = obj(metrics.strategy);          /* 最低佣金 5 元 */
    var b = obj(metrics.strategy_free5);    /* 免 5 账户 */
    var retA = n(a.total_return_pct), retB = n(b.total_return_pct);
    var finA = n(a.final), finB = n(b.final);
    var costA = n(a.total_cost), costB = n(b.total_cost);
    if (retA == null || retB == null) return '';
    var diffPct = retB - retA;
    var diffMoney = (finA != null && finB != null) ? (finB - finA) : null;
    var minFee = n(params && params.commission_min);

    return '<div class="bt-callout">' +
      '<span class="bt-callout-title">关键发现</span>' +
      '<span class="bt-callout-badge">免 5 账户 vs 最低佣金 5 元</span>' +
      '<span class="bt-compare">' +
        '<span class="bt-compare-item">' +
          '<span class="k">最低佣金 5 元' + (costA == null ? '' : '（手续费 ' + fmtYuan(costA) + '）') + '</span>' +
          '<span class="v bad">' + (retA > 0 ? '+' : '') + retA.toFixed(2) + '%</span>' +
        '</span>' +
        '<span class="bt-arrow">→</span>' +
        '<span class="bt-compare-item">' +
          '<span class="k">免 5 账户' + (costB == null ? '' : '（手续费 ' + fmtYuan(costB) + '）') + '</span>' +
          '<span class="v good">' + (retB > 0 ? '+' : '') + retB.toFixed(2) + '%</span>' +
        '</span>' +
        '<span class="bt-delta">' +
          '<span class="k">收益差 ' + (minFee == null ? '' : '（同一套规则）') + '</span>' +
          '<span class="v">+' + diffPct.toFixed(2) + ' pct' +
            (diffMoney == null ? '' : ' / ' + (diffMoney > 0 ? '+' : '') + fmtYuan(diffMoney).replace(' 元', ' 元')) +
          '</span>' +
        '</span>' +
      '</span>' +
      '<span class="bt-hint">同一套买卖规则、同一标的与区间，仅佣金规则不同：3000 元小资金高频交易时，' +
        '最低 5 元佣金会显著吃掉收益——开户佣金规则比策略细节更值得先优化。</span>' +
    '</div>';
  }

  function renderEquityChart(curves, params) {
    var defs = [
      { key: 'strategy', name: '规则策略（最低佣金5元）', color: C.cyan, width: 2.2 },
      { key: 'strategy_free5', name: '规则策略（免5账户）', color: '#2dd4bf', width: 2.2 },
      { key: 'hold', name: '买入持有', color: C.gold, width: 1.8 },
      { key: 'half', name: '半仓策略', color: '#a78bfa', width: 1.6 }
    ];
    var dateSet = {}, dateList = [];
    defs.forEach(function (d) {
      arr(curves[d.key]).forEach(function (pt) {
        pt = obj(pt);
        if (pt.date && !dateSet[pt.date]) { dateSet[pt.date] = 1; dateList.push(pt.date); }
      });
    });
    dateList.sort();
    if (!dateList.length) {
      chartEmpty('equity-chart', '净值曲线数据缺失');
      return;
    }
    var xs = dateList.map(shortDate);
    var series = defs.map(function (d) {
      var map = {};
      arr(curves[d.key]).forEach(function (pt) {
        pt = obj(pt);
        if (pt.date) map[pt.date] = n(pt.equity);
      });
      return {
        name: d.name, type: 'line', data: dateList.map(function (dt) {
          return map[dt] == null ? null : map[dt];
        }),
        smooth: 0.25, symbol: 'none', connectNulls: false,
        lineStyle: { width: d.width, color: d.color },
        itemStyle: { color: d.color },
        emphasis: { focus: 'series' }
      };
    });

    var initial = n(params && params.initial);
    if (initial != null) {
      series[0].markLine = {
        silent: true, symbol: 'none',
        lineStyle: { color: 'rgba(147,168,189,0.45)', type: 'dashed', width: 1 },
        label: {
          show: true, position: 'insideStartTop', color: C.muted, fontSize: 9.5,
          formatter: '本金 ' + initial.toFixed(0) + ' 元'
        },
        data: [{ yAxis: initial }]
      };
    }

    var inst = initChart('equity-chart');
    if (!inst) return;
    inst.setOption({
      animationDuration: 700,
      grid: { left: 8, right: 14, top: 34, bottom: 8, containLabel: true },
      tooltip: baseTooltip({
        trigger: 'axis',
        axisPointer: { type: 'cross', lineStyle: { color: 'rgba(34,211,238,0.35)' }, crossStyle: { color: 'rgba(34,211,238,0.35)' } },
        formatter: function (ps) {
          if (!ps || !ps.length) return '';
          var rows = ps.filter(function (p) { return p.value != null; })
            .sort(function (m, n2) { return n2.value - m.value; });
          if (!rows.length) return '';
          var idx = rows[0].dataIndex;
          var html = '<div style="font-weight:700;margin-bottom:4px">' + esc(dateList[idx] || '') + '</div>';
          html += rows.map(function (r) {
            return r.marker + esc(r.seriesName) + '：<b>' + fmtYuan(r.value) + '</b>';
          }).join('<br>');
          return html;
        }
      }),
      legend: {
        top: 2, left: 4, itemWidth: 14, itemHeight: 8, itemGap: 12,
        textStyle: { color: C.muted, fontSize: 10.5, fontFamily: FONT }
      },
      xAxis: axisBase({
        type: 'category', data: xs, boundaryGap: false,
        axisLabel: { color: C.muted, fontSize: 9.5, fontFamily: FONT, interval: 'auto', hideOverlap: true },
        splitLine: { show: false }
      }),
      yAxis: axisBase({
        type: 'value', scale: true, splitNumber: 5,
        axisLabel: {
          color: C.muted, fontSize: 9.5, fontFamily: FONT,
          formatter: function (v) { return v >= 10000 ? (v / 10000).toFixed(1) + '万' : v; }
        }
      }),
      series: series
    }, true);
  }

  /* =====================================================================
   * 3.10 今日方向（outlook）—— 第一屏最重要
   * ===================================================================== */
  /** 方向文本 → 配色/箭头：偏多=红、震荡=金、偏空=绿（A股习惯） */
  function directionMeta(dir) {
    var d = String(dir == null ? '' : dir).trim();
    if (!d) return { cls: 'dir-flat', arrow: '—', text: '—' };
    if (/偏空|看空|下跌|利空/.test(d)) return { cls: 'dir-down', arrow: '▼', text: d };
    if (/偏多|看多|上涨|利多/.test(d)) return { cls: 'dir-up', arrow: '▲', text: d };
    if (/震荡|中性|平衡/.test(d)) return { cls: 'dir-range', arrow: '◆', text: d };
    return { cls: 'dir-flat', arrow: '—', text: d };
  }

  function pct01(v) {
    var x = n(v);
    if (x == null) return null;
    return x <= 1.0001 ? x * 100 : x;
  }

  function outlookDirBlock(label, horizon, d) {
    d = obj(d);
    if (!Object.keys(d).length) {
      return '<div class="dir-block dir-flat"><div class="dir-top"><span class="dir-horizon">' +
        esc(label) + '</span></div><div class="dir-empty">方向数据缺失</div></div>';
    }
    var dm = directionMeta(d.direction);
    var score = n(d.score);
    var conf = pct01(d.confidence);
    var scoreTxt = score == null ? '—' : (score > 0 ? '+' : '') + score.toFixed(1);
    var markPos = score == null ? 50 : clamp((score + 100) / 200 * 100, 0, 100);
    var confTxt = conf == null ? '—' : conf.toFixed(0) + '%';
    var confW = conf == null ? 0 : clamp(conf, 0, 100);
    return '<div class="dir-block ' + dm.cls + '">' +
      '<div class="dir-top">' +
        '<span class="dir-horizon">' + esc(label) + '<b>' + esc(d.horizon || horizon) + '</b></span>' +
        (!d.themes ? '' : '<span class="tag-soft">中期主题 ' + arr(d.themes).length + ' 个</span>') +
      '</div>' +
      '<div class="dir-main">' +
        '<span class="dir-value">' + esc(dm.text) + '</span>' +
        '<span class="dir-arrow">' + dm.arrow + '</span>' +
        '<span class="dir-score"><b>' + scoreTxt + '</b><span>/100</span></span>' +
      '</div>' +
      '<div class="dir-meter"><i class="dir-meter-mark" style="left:' + markPos.toFixed(1) + '%"></i></div>' +
      '<div class="dir-scale-labels"><span>-100 偏空</span><span>0 中性</span><span>+100 偏多</span></div>' +
      '<div class="dir-conf">' +
        '<span class="dir-conf-label">置信度</span>' +
        '<span class="dir-conf-track"><i class="dir-conf-fill" style="width:' + confW.toFixed(1) + '%"></i></span>' +
        '<span class="dir-conf-num">' + confTxt + '</span>' +
      '</div>' +
    '</div>';
  }

  function renderOutlook(p) {
    var sec = byId('sec-outlook');
    if (!sec) return;
    var out = obj(obj(p).outlook);
    var st = obj(out.short_term);
    var mt = obj(out.medium_term);
    var present = Object.keys(st).length || Object.keys(mt).length || arr(out.calendar_risks).length;
    if (!present) { sec.hidden = true; return; }
    sec.hidden = false;

    var metaEl = byId('outlook-meta');
    if (metaEl) {
      var bits = [];
      if (st.horizon || mt.horizon) {
        bits.push('短期 ' + (st.horizon || '3~10 个交易日') + ' · 中期 ' + (mt.horizon || '1~3 个月'));
      }
      bits.push(out.updated_note || '方向每交易日收盘后更新');
      metaEl.textContent = bits.join(' · ');
    }
    var updEl = byId('outlook-updated');
    if (updEl) {
      var t = fmtTimeSec((obj(p.meta)).generated_at);
      updEl.textContent = '数据时间 ' + t + ' · 非实时';
      updEl.title = out.updated_note || '';
    }

    /* 两块方向 + 驱动因子 */
    var mainEl = byId('outlook-main');
    if (mainEl) {
      var drivers = arr(st.drivers);
      var driverHtml = '';
      if (drivers.length) {
        driverHtml = '<div class="drivers-strip">' +
          '<div class="mini-head" style="margin-bottom:6px">短期方向驱动因子</div>' +
          '<div class="drivers-grid">' + drivers.map(function (d) {
            d = obj(d);
            var eff = String(d.effect || '0').trim();
            var effCls = eff.indexOf('-') >= 0 ? 'eff-minus' : (eff.indexOf('+') >= 0 ? 'eff-plus' : 'eff-flat');
            var effSym = eff.indexOf('-') >= 0 ? '−' : (eff.indexOf('+') >= 0 ? '+' : '0');
            var w = pct01(d.weight);
            return '<div class="driver-chip ' + effCls + '">' +
              '<div class="driver-chip-top">' +
                '<span class="driver-chip-name">' + esc(d.name || '—') + '</span>' +
                '<span class="driver-chip-eff ' + dirClass(effSym === '−' ? -1 : (effSym === '+' ? 1 : 0)) + '">' +
                  effSym + (w == null ? '' : ' · ' + w.toFixed(0) + '%') + '</span>' +
              '</div>' +
              '<span class="driver-chip-text" title="' + esc(d.text || '') + '">' + esc(d.text || '') + '</span>' +
            '</div>';
          }).join('') + '</div>' +
        '</div>';
      }
      mainEl.innerHTML = outlookDirBlock('短期', '3~10 个交易日', st) +
        outlookDirBlock('中期', '1~3 个月', mt) + driverHtml;
    }

    /* 成立 / 失效 */
    var trigEl = byId('outlook-triggers');
    var invEl = byId('outlook-invalidators');
    var triggers = arr(st.triggers);
    var invalidators = arr(st.invalidators);
    if (trigEl) {
      trigEl.innerHTML = '<div class="panel-title">✅ 什么算成立 <span>触发条件 · 确认方向</span></div>' +
        (triggers.length ? '<ul class="check-list">' + triggers.slice(0, 5).map(function (t) {
          return '<li class="check-li ok">' + esc(t) + '</li>';
        }).join('') + '</ul>' : emptyState('触发条件缺失'));
    }
    if (invEl) {
      invEl.innerHTML = '<div class="panel-title">⛔ 什么算失效 <span>错了怎么办 · 先破哪条假设</span></div>' +
        (invalidators.length ? '<ul class="check-list">' + invalidators.slice(0, 5).map(function (t) {
          return '<li class="check-li bad">' + esc(t) + '</li>';
        }).join('') + '</ul>' : emptyState('失效条件缺失'));
    }

    /* 上证区间 + playbook */
    var zoneEl = byId('outlook-zone');
    var zone = obj(st.index_zone);
    if (zoneEl) {
      var zSup = n(zone.support), zCen = n(zone.center), zRes = n(zone.resistance);
      if (zSup == null && zCen == null && zRes == null) {
        zoneEl.hidden = true;
      } else {
        zoneEl.hidden = false;
        zoneEl.innerHTML =
          '<div class="zone-item zone-item--support"><span class="zone-k">支撑位（跌破则方向失效）</span>' +
            '<span class="zone-v">' + fmtPrice(zSup) + '</span></div>' +
          '<div class="zone-item zone-item--center"><span class="zone-k">中枢 / 现价</span>' +
            '<span class="zone-v">' + fmtPrice(zCen) + '</span></div>' +
          '<div class="zone-item zone-item--resistance"><span class="zone-k">压力位（站上则确认）</span>' +
            '<span class="zone-v">' + fmtPrice(zRes) + '</span></div>' +
          (st.playbook ? '<div class="zone-playbook"><b>怎么做：</b>' + esc(st.playbook) + '</div>' : '') +
          (st.index_zone_note ? '<div class="zone-note" style="flex:1 1 100%" title="' +
            esc(st.index_zone_note) + '">' + esc(st.index_zone_note) + '</div>' : '');
      }
    }

    var sumEl = byId('outlook-summary');
    if (sumEl) sumEl.textContent = st.summary || mt.summary || '';

    /* 中期主题 */
    var themes = arr(mt.themes);
    var themesEl = byId('outlook-themes');
    var themesMeta = byId('outlook-themes-meta');
    if (themesMeta) {
      themesMeta.textContent = themes.length
        ? ('中期方向 ' + (mt.direction || '—') + ' · 置信 ' + (pct01(mt.confidence) == null ? '—' : pct01(mt.confidence).toFixed(0) + '%'))
        : '—';
    }
    if (themesEl) {
      if (!themes.length) {
        themesEl.innerHTML = emptyState('中期主题数据缺失');
      } else {
        var maxScore = themes.reduce(function (m, t) { return Math.max(m, numOr(obj(t).score, 0)); }, 1) || 1;
        themesEl.innerHTML = themes.slice(0, 8).map(function (t) {
          t = obj(t);
          var sc = n(t.score);
          var w = sc == null ? 0 : clamp(sc / Math.max(100, maxScore) * 100, 4, 100);
          var vehicles = arr(t.vehicle).map(function (v) { return '<span class="tag">' + esc(v) + '</span>'; });
          return '<div class="theme-card">' +
            '<div class="theme-head">' +
              '<span class="theme-rank">' + esc(t.rank == null ? '·' : t.rank) + '</span>' +
              '<span class="theme-name">' + esc(t.name || '—') + '</span>' +
              '<span class="theme-score">' + (sc == null ? '—' : sc.toFixed(0)) + '</span>' +
            '</div>' +
            '<div class="theme-bar"><i style="width:' + w.toFixed(1) + '%"></i></div>' +
            '<div class="theme-tags">' +
              (t.horizon ? '<span class="tag">' + esc(t.horizon) + '</span>' : '') +
              vehicles.join('') +
            '</div>' +
            (t.logic ? '<div class="theme-logic"><b>逻辑：</b>' + esc(t.logic) + '</div>' : '') +
            (t.risk ? '<div class="theme-risk"><b>风险：</b>' + esc(t.risk) + '</div>' : '') +
          '</div>';
        }).join('');
      }
    }

    /* 焦点 ETF 的中期含义 */
    var focusEl = byId('outlook-focus-note');
    if (focusEl) {
      if (mt.focus_implication) {
        focusEl.hidden = false;
        focusEl.innerHTML = '<b>对焦点 ETF 588170 的中期含义：</b>' + esc(mt.focus_implication);
      } else {
        focusEl.hidden = true;
        focusEl.innerHTML = '';
      }
    }

    /* 风险窗口 */
    var risks = arr(out.calendar_risks);
    var calEl = byId('outlook-calendar');
    if (calEl) {
      if (!risks.length) {
        calEl.innerHTML = '<li class="empty-state">日历风险数据缺失</li>';
      } else {
        calEl.innerHTML = risks.slice(0, 6).map(function (e) {
          e = obj(e);
          var imp = clamp(numOr(e.importance, 1), 1, 3);
          var dots = '';
          for (var i = 0; i < 3; i++) dots += '<i class="imp-dot' + (i < imp ? ' on' : '') + '"></i>';
          return '<li class="calendar-item calendar-item--risk">' +
            '<span class="cal-date">' + esc(e.date || '—') + '</span>' +
            '<span class="cal-title">' + esc(e.event || e.title || '—') + '</span>' +
            '<span class="imp-dots" title="重要度 ' + imp + '/3">' + dots + '</span>' +
            (e.impact ? '<span class="cal-impact">' + esc(e.impact) + '</span>' : '') +
          '</li>';
        }).join('');
      }
    }
  }

  /* =====================================================================
   * 3.11 全球局势 · 产业前景（global_outlook）
   * ===================================================================== */
  var sectorState = { list: [], selected: 0 };

  function renderGlobal(p) {
    var sec = byId('sec-global');
    if (!sec) return;
    var g = obj(obj(p).global_outlook);
    var present = Object.keys(g).length &&
      (arr(g.sector_ranking).length || Object.keys(obj(g.risk_regime)).length || arr(g.overseas).length);
    if (!present) { sec.hidden = true; return; }
    sec.hidden = false;

    var metaEl = byId('global-meta');
    if (metaEl) {
      var rr = obj(g.risk_regime);
      metaEl.textContent = (rr.label ? '全球风险偏好 ' + rr.label : '—') +
        (n(rr.score) == null ? '' : ' · ' + n(rr.score).toFixed(0) + ' 分');
    }

    /* 风险偏好仪表 */
    var rr = obj(g.risk_regime);
    var score = n(rr.score);
    if (score == null) {
      chartEmpty('global-risk-chart', '风险偏好数据缺失');
    } else {
      var inst = initChart('global-risk-chart');
      if (inst) {
        var color = score >= 65 ? C.up : (score >= 45 ? C.gold : C.down);
        inst.setOption({
          animationDuration: 600,
          series: [{
            type: 'gauge', startAngle: 210, endAngle: -30, min: 0, max: 100,
            radius: '100%', center: ['50%', '56%'],
            progress: { show: true, width: 8, roundCap: true, itemStyle: { color: color } },
            axisLine: { lineStyle: { width: 8, color: [[1, 'rgba(255,255,255,0.07)']] } },
            pointer: { show: false }, axisTick: { show: false }, splitLine: { show: false },
            axisLabel: { show: false }, anchor: { show: false },
            title: { offsetCenter: [0, '30%'], color: C.muted, fontSize: 10, fontFamily: FONT },
            detail: {
              offsetCenter: [0, '-8%'], fontSize: 22, fontWeight: 700, fontFamily: FONT,
              color: '#eaf4ff', formatter: function (v) { return v.toFixed(0); }
            },
            data: [{ value: score, name: rr.label || '风险偏好' }]
          }]
        }, true);
      }
    }
    var rtext = byId('global-risk-text');
    if (rtext) rtext.textContent = rr.text || '';

    /* 海外市场小卡 */
    var oEl = byId('global-overseas');
    var overseas = arr(g.overseas);
    if (oEl) {
      if (!overseas.length) {
        oEl.innerHTML = emptyState('海外市场数据缺失');
      } else {
        oEl.innerHTML = overseas.map(function (it) {
          it = obj(it);
          var cls = dirClass(it.chg_pct);
          return '<div class="oversea-mini ' + cls + '">' +
            '<div class="oversea-mini-name" title="' + esc((it.trend || '') + ' ' + (it.note || '')) + '">' +
              esc(it.name || it.code || '—') + '</div>' +
            '<div class="oversea-mini-row">' +
              '<span class="oversea-mini-close">' + fmtPrice(it.close) + '</span>' +
              '<span class="oversea-mini-chg ' + cls + '">' + fmtPct(it.chg_pct) + '</span>' +
            '</div>' +
            (it.trend ? '<div class="oversea-mini-note">' + esc(it.trend) + '</div>' : '') +
          '</div>';
        }).join('');
      }
    }

    /* 新闻热度标签云 */
    var nEl = byId('global-news');
    var news = arr(g.news_heat);
    if (nEl) {
      if (!news.length) {
        nEl.innerHTML = emptyState('新闻热度缺失');
      } else {
        nEl.innerHTML = news.slice(0, 12).map(function (it) {
          it = obj(it);
          var senti = n(it.sentiment);
          var cnt = n(it.count);
          var cls = '';
          if (cnt != null && cnt >= 8) cls += ' hot';
          if (senti != null && senti >= 0.3) cls += ' pos';
          else if (senti != null && senti <= -0.3) cls += ' neg';
          var titles = arr(it.titles).slice(0, 3).join('\n');
          return '<span class="news-chip' + cls + '" title="' + esc(titles) + '">' +
            esc(it.category || '—') + '<b>' + (cnt == null ? '' : cnt) + '</b></span>';
        }).join('');
      }
    }

    /* 产业前景排序 */
    sectorState.list = arr(g.sector_ranking).filter(function (x) { return x && typeof x === 'object'; });
    sectorState.selected = 0;
    renderSectorChart();
    renderSectorDetail(sectorState.selected);

    /* 地缘与政策 */
    var geoEl = byId('global-geo');
    var geo = arr(g.geopolitics);
    if (geoEl) {
      if (!geo.length) {
        geoEl.innerHTML = emptyState('地缘与政策数据缺失');
      } else {
        geoEl.innerHTML = geo.slice(0, 4).map(function (x) {
          x = obj(x);
          var affected = (arr(x.affected).length ? arr(x.affected) : arr(x.industries)).map(function (a) {
            return '<span class="tag">' + esc(a) + '</span>';
          });
          return '<div class="geo-card">' +
            '<div class="geo-head">' +
              '<span class="geo-topic">' + esc(x.topic || '—') + '</span>' +
              (x.stance ? '<span class="geo-stance">' + esc(x.stance) + '</span>' : '') +
              (n(x.count) == null ? '' : '<span class="tag">' + fmtInt(x.count) + ' 条新闻</span>') +
            '</div>' +
            (x.impact ? '<div class="geo-impact">' + esc(x.impact) + '</div>' : '') +
            (affected.length ? '<div class="geo-affected">' + affected.join('') + '</div>' : '') +
            (x.sample ? '<div class="geo-sample" title="' + esc(x.sample) + '">' + esc(x.sample) + '</div>' : '') +
          '</div>';
        }).join('');
      }
    }

    var sumEl = byId('global-summary');
    if (sumEl) sumEl.textContent = g.summary || '';

    var notesBox = byId('global-notes-box');
    var notesEl = byId('global-notes');
    var notes = arr(g.data_notes);
    if (notesBox && notesEl) {
      if (notes.length) {
        notesBox.hidden = false;
        notesEl.innerHTML = notes.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('');
      } else {
        notesBox.hidden = true;
      }
    }
  }

  function renderSectorChart() {
    var list = sectorState.list;
    if (!list.length) { chartEmpty('sector-chart', '产业排序数据缺失'); return; }
    var inst = initChart('sector-chart');
    if (!inst) return;
    var names = list.map(function (x) { return String(obj(x).sector || '—'); });
    var values = list.map(function (x) { return numOr(obj(x).score, 0); });
    var maxV = values.reduce(function (m, v) { return Math.max(m, v); }, 1) || 1;
    var data = list.map(function (x) {
      x = obj(x);
      var v = numOr(x.score, 0);
      var sel = x === sectorState.list[sectorState.selected];
      return {
        value: v,
        itemStyle: {
          borderRadius: [0, 4, 4, 0],
          color: new window.echarts.graphic.LinearGradient(0, 0, 1, 0, [
            { offset: 0, color: 'rgba(34,211,238,' + (0.16 + 0.2 * (v / maxV)).toFixed(2) + ')' },
            { offset: 1, color: sel ? C.gold : (v / maxV > 0.9 ? C.cyan : '#2b8fbd') }
          ])
        }
      };
    });
    inst.setOption({
      animationDuration: 700,
      grid: { left: 6, right: 46, top: 8, bottom: 6, containLabel: true },
      tooltip: baseTooltip({
        trigger: 'axis',
        axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(34,211,238,0.08)' } },
        formatter: function (ps) {
          if (!ps || !ps.length) return '';
          var x = obj(list[ps[0].dataIndex]);
          return '<div style="font-weight:700;margin-bottom:4px">#' + esc(x.rank == null ? '' : x.rank) + ' ' +
            esc(x.sector || '') + '　<b style="color:#22d3ee">' + fmt(x.score, 1) + '</b></div>' +
            '动量 ' + fmt(x.momentum, 2) + '（20日 ' + fmtPct(x.momentum_pct) + '）<br>' +
            '资金 ' + fmt(x.fund_flow, 2) + (n(x.fund_flow_yi) == null ? '' : '（' + fmtYi(x.fund_flow_yi) + '）') + '<br>' +
            '新闻 ' + fmt(x.news_heat, 2) + (n(x.news_count) == null ? '' : '（' + fmtInt(x.news_count) + ' 条）');
        }
      }),
      xAxis: axisBase({ type: 'value', max: Math.ceil(maxV * 1.05), axisLabel: { show: false }, splitLine: { show: false }, axisLine: { show: false } }),
      yAxis: axisBase({
        type: 'category', data: names, inverse: true,
        axisLabel: { color: '#cfdced', fontSize: 11, fontFamily: FONT, width: 108, overflow: 'truncate' },
        splitLine: { show: false }, axisLine: { show: false }
      }),
      series: [{
        type: 'bar', data: data, barMaxWidth: 15,
        label: {
          show: true, position: 'right', color: '#a9c0d6', fontSize: 10.5, fontFamily: FONT,
          formatter: function (ps) { return ps.value.toFixed(1); }
        }
      }]
    }, true);
    inst.off('click');
    inst.on('click', function (params) {
      if (params && params.dataIndex != null) {
        sectorState.selected = params.dataIndex;
        renderSectorDetail(params.dataIndex);
        renderSectorChart();
      }
    });
  }

  function renderSectorDetail(idx) {
    var el = byId('sector-detail');
    if (!el) return;
    var list = sectorState.list;
    if (!list.length) { el.innerHTML = emptyState('产业详情数据缺失'); return; }
    var s = obj(list[idx] || list[0]);
    var pctW = function (v) {
      var x = n(v);
      return x == null ? 0 : clamp(x <= 1.0001 ? x * 100 : x, 0, 100);
    };
    var vehicles = arr(s.vehicles).map(function (v) {
      v = obj(v);
      return '<span class="tag" style="color:#22d3ee">' + esc(v.name || v.code || '—') +
        (v.code ? '<span class="muted"> ' + esc(v.code) + '</span>' : '') + '</span>';
    });
    el.innerHTML =
      '<div class="sd-head">' +
        '<span class="sd-rank">#' + esc(s.rank == null ? (idx + 1) : s.rank) + '</span>' +
        '<span class="sd-name">' + esc(s.sector || '—') + '</span>' +
        '<span class="sd-score">' + (n(s.score) == null ? '—' : n(s.score).toFixed(1)) + '</span>' +
      '</div>' +
      '<div class="sd-metrics">' +
        sdMetric('动量', s.momentum, n(s.momentum_pct) == null ? null : fmtPct(s.momentum_pct)) +
        sdMetric('资金流', s.fund_flow, n(s.fund_flow_yi) == null ? null : fmtYi(s.fund_flow_yi)) +
        sdMetric('新闻热度', s.news_heat, n(s.news_count) == null ? null : fmtInt(s.news_count) + ' 条') +
      '</div>' +
      (s.stage ? '<div class="sd-row"><span class="k">阶段</span>' + esc(s.stage) + '</div>' : '') +
      (s.logic ? '<div class="sd-row"><span class="k">逻辑</span>' + esc(s.logic) + '</div>' : '') +
      (s.risk ? '<div class="sd-row risk"><span class="k">风险</span>' + esc(s.risk) + '</div>' : '') +
      (vehicles.length ? '<div class="sd-vehicles">' + vehicles.join('') + '</div>' : '') +
      (s.invalidation ? '<div class="sd-row"><span class="k">失效条件</span>' + esc(s.invalidation) + '</div>' : '') +
      (s.momentum_source ? '<div class="sd-row meta">动量口径：' + esc(s.momentum_source) + '</div>' : '');

    function sdMetric(k, v, extra) {
      var w = pctW(v);
      return '<div class="sd-metric">' +
        '<span class="k">' + esc(k) + '</span>' +
        '<span class="bar"><i style="width:' + w.toFixed(1) + '%"></i></span>' +
        '<span class="v">' + (n(v) == null ? '—' : n(v).toFixed(2)) +
          (extra ? ' <span class="muted">' + esc(extra) + '</span>' : '') + '</span>' +
      '</div>';
    }
  }

  /* =====================================================================
   * 3.11b 产业空间研判（industry_space）
   * 「便宜（估值分位）+ 景气（净利同比）+ 空间（距高点/价格分位）+ 资金 + 新闻」
   * ===================================================================== */
  function renderIndustrySpace(p) {
    var sec = byId('sec-industry');
    if (!sec) return;
    var ind = obj(obj(p).industry_space);
    if (!Object.keys(ind).length) { sec.hidden = true; return; }
    sec.hidden = false;

    var updated = ind.updated !== false;
    var top = arr(ind.top).filter(function (x) { return x && typeof x === 'object'; });
    var concepts = arr(ind.concepts).filter(function (x) { return x && typeof x === 'object'; });
    var tiers = obj(ind.tiers);
    var hasBoard = updated && top.length > 0;
    var method = ind.method || '';

    /* meta */
    var metaEl = byId('industry-meta');
    if (metaEl) {
      var bits = [];
      if (ind.as_of) bits.push('数据日 ' + ind.as_of);
      if (hasBoard) bits.push(fmtInt(top.length) + ' 个申万二级行业');
      if (n(ind.news_total) != null) bits.push('新闻样本 ' + fmtInt(ind.news_total) + ' 条');
      metaEl.textContent = bits.join(' · ') || '—';
      if (ind.generated_at) metaEl.title = '生成时间：' + ind.generated_at;
    }

    /* 结论 */
    var cEl = byId('industry-conclusion');
    var tiersEl = byId('industry-tiers');
    var boardHead = byId('industry-board-head');
    var boardWrap = byId('industry-board-wrap');
    var conceptsHead = byId('industry-concepts-head');
    var conceptsEl = byId('industry-concepts');
    var footEl = byId('industry-foot');

    if (!hasBoard) {
      /* 数据待生成：整块保留但显示提示，不渲染表格 */
      if (cEl) {
        cEl.hidden = false;
        cEl.innerHTML = '<div class="ind-not-ready"><b>产业空间数据待生成</b><br>' +
          '每日 17:00 自动更新（Windows 计划任务 → data/industry_space.json → pipeline）。<br>' +
          '数据恢复后本面板会自动填充，无需操作。</div>';
      }
      if (tiersEl) tiersEl.hidden = true;
      if (boardHead) boardHead.hidden = true;
      if (boardWrap) boardWrap.hidden = true;
      if (conceptsHead) conceptsHead.hidden = true;
      if (conceptsEl) conceptsEl.hidden = true;
      if (footEl) {
        footEl.textContent = method
          ? '口径：' + method + '。净利同比由市值 ÷ PE 反推，非官方净利润；不构成投资建议。'
          : '';
      }
      return;
    }

    if (cEl) {
      cEl.hidden = !ind.conclusion;
      cEl.innerHTML = ind.conclusion
        ? '<span class="ind-tag">结论</span>' + richText(ind.conclusion) +
          (n(ind.news_total) == null ? '' : ' <span class="muted" style="font-size:11px">（新闻样本 ' + fmtInt(ind.news_total) + ' 条）</span>')
        : '';
    }
    if (tiersEl) tiersEl.hidden = false;
    if (boardHead) boardHead.hidden = false;
    if (boardWrap) boardWrap.hidden = false;
    if (conceptsHead) conceptsHead.hidden = !concepts.length;
    if (conceptsEl) conceptsEl.hidden = !concepts.length;

    var coreSet = {}, avoidSet = {};
    arr(tiers.core).forEach(function (x) { coreSet[String(x)] = true; });
    arr(tiers.avoid).forEach(function (x) { avoidSet[String(x)] = true; });

    /* 三个分层标签 */
    if (tiersEl) {
      var defs = [
        { key: 'core', cls: 'ind-tier--core', title: '空间 + 景气双优', sub: '核心关注（便宜且利润在改善）' },
        { key: 'watch', cls: 'ind-tier--watch', title: '跟踪观察', sub: '等触发条件再动' },
        { key: 'trade', cls: 'ind-tier--trade', title: '交易型（只宜短线）', sub: '资金在打，但中期偏弱' },
        { key: 'avoid', cls: 'ind-tier--avoid', title: '贵且没业绩 · 回避', sub: '估值高且盈利未改善' }
      ];
      var tierHtml = defs.map(function (d) {
        var list = arr(tiers[d.key]);
        if (!list.length) return '';
        return '<div class="ind-tier ' + d.cls + '">' +
          '<div class="ind-tier-head"><span class="ind-tier-title">' + esc(d.title) + '</span>' +
            '<span class="ind-tier-sub">' + esc(d.sub) + '</span></div>' +
          '<div class="ind-tier-chips">' + list.map(function (x) {
            return '<span class="ind-chip">' + esc(x) + '</span>';
          }).join('') + '</div>' +
        '</div>';
      }).join('');
      tiersEl.innerHTML = tierHtml;
      tiersEl.hidden = !tierHtml;
    }

    /* 行业空间榜 */
    var tbody = byId('industry-tbody');
    if (tbody) {
      var rows = top.slice().sort(function (a, b) {
        return numOr(obj(b).score, 0) - numOr(obj(a).score, 0);
      }).slice(0, 15);
      var boardMeta = byId('industry-board-meta');
      if (boardMeta) {
        boardMeta.textContent = '按空间分降序 · 共 ' + fmtInt(top.length) + ' 个行业，展示前 ' + rows.length +
          ' · 「便宜程度」与「景气」对比看：利润涨而股价没涨 = 空间大';
      }
      tbody.innerHTML = rows.map(function (x, i) {
        x = obj(x);
        var name = String(x.name || '—');
        var score = n(x.score);
        var pe = n(x.pe);
        var pePct = n(x.pe_pct);
        var earn = n(x.earn_yoy);
        var nowYi = n(x.earn_now_yi);
        var dd500 = n(x.dd500);
        var pricePct = n(x.price_pct);
        var net5 = n(x.net5_yi);
        var ratio = n(x.net5_ratio);
        var news = n(x.news_heat);
        var trap = x.trap_warning ? String(x.trap_warning) : '';

        var scoreCls = score == null ? 'low' : (score >= 80 ? 'hot' : (score >= 70 ? 'mid' : 'low'));
        var rankCls = i === 0 ? ' top1' : (i === 1 ? ' top2' : (i === 2 ? ' top3' : ''));

        var cheapCls = pePct == null ? 'mid' : (pePct <= 20 ? 'cheap' : (pePct > 60 ? 'rich' : 'mid'));
        var cheapTag = (pePct != null && pePct <= 10) ? '<span class="ind-cheap-tag">便宜</span>' : '';
        var cheapW = pePct == null ? 0 : clamp(pePct, 0, 100);

        var priceCls = pricePct == null ? 'mid' : (pricePct <= 20 ? 'low' : (pricePct > 70 ? 'high' : 'mid'));

        var rowCls = '';
        if (coreSet[name]) rowCls = ' class="ind-tr--core"';
        else if (avoidSet[name]) rowCls = ' class="ind-tr--avoid"';

        /* 定位：配置型 / 交易型 / 配置回避 / 中性 */
        var tag = String(x.trade_tag || '');
        var posShort = '—', posCls = 'neutral';
        if (tag) {
          if (/配置回避/.test(tag)) { posShort = '配置回避'; posCls = 'avoid'; }
          else if (/交易型/.test(tag)) { posShort = '交易型'; posCls = 'trade'; }
          else if (/配置型/.test(tag)) { posShort = '配置型'; posCls = 'alloc'; }
          else if (/中性/.test(tag)) { posShort = '中性'; posCls = 'neutral'; }
          else { posShort = tag; posCls = 'neutral'; }
        }
        var posCell = tag
          ? '<td><span class="tag-pos ' + posCls + '" title="' + esc(tag) + '">' + esc(posShort) + '</span></td>'
          : '<td class="muted">—</td>';

        return '<tr' + rowCls + '>' +
          '<td class="col-rank"><span class="ind-rank' + rankCls + '">' + (i + 1) + '</span></td>' +
          '<td class="name-cell"><span class="ind-name">' +
            (trap ? '<span class="trap-flag" title="' + esc(trap) + '">⚠</span>' : '') +
            esc(name) + '</span></td>' +
          '<td class="num"><span class="ind-score">' +
            '<span class="ind-score-track"><i class="ind-score-fill ' + scoreCls + '" style="width:' +
              (score == null ? 0 : clamp(score, 0, 100)).toFixed(1) + '%"></i></span>' +
            '<span class="ind-score-num">' + (score == null ? '—' : score.toFixed(1)) + '</span>' +
          '</span></td>' +
          posCell +
          '<td class="num">' + (pe == null ? '—' : (pe > 0 ? fmt(pe, 1) : '亏损')) + '</td>' +
          '<td class="num"><span class="ind-cheap">' +
            '<span class="ind-cheap-num ' + cheapCls + '">' + (pePct == null ? '—' : pePct.toFixed(1) + '%') + cheapTag + '</span>' +
            '<span class="ind-cheap-track"><i style="width:' + cheapW.toFixed(1) + '%"></i></span>' +
          '</span></td>' +
          '<td class="num"><span class="ind-earn">' +
            '<span class="ind-earn-num ' + dirClass(earn) + '">' + (earn == null ? '—' : (earn > 0 ? '+' : '') + earn.toFixed(1) + '%') + '</span>' +
            (nowYi == null ? '' : '<span class="ind-earn-sub">净利 ' + fmtYi(nowYi) + '</span>') +
          '</span></td>' +
          '<td class="num"><span class="ind-dd">' + fmtPct(dd500) + '</span></td>' +
          '<td class="num"><span class="ind-price">' +
            '<span class="ind-price-num">' + (pricePct == null ? '—' : pricePct.toFixed(0) + '%') + '</span>' +
            '<span class="ind-price-track"><i class="' + priceCls + '" style="width:' +
              (pricePct == null ? 0 : clamp(pricePct, 0, 100)).toFixed(1) + '%"></i></span>' +
          '</span></td>' +
          '<td class="num"><span class="ind-flow ' + dirClass(net5) + '">' +
            (net5 == null ? '—' : (net5 > 0 ? '+' : '') + net5.toFixed(1) + '亿') +
            (ratio == null ? '' : '<small>×' + ratio.toFixed(2) + '</small>') +
          '</span></td>' +
          '<td class="num"><span class="ind-news' + (news != null && news >= 5 ? ' hot' : '') + '">' +
            (news == null ? '—' : fmtInt(news)) + '</span></td>' +
        '</tr>';
      }).join('');
      if (!rows.length) tbody.innerHTML = '<tr><td colspan="11" class="empty-state">行业空间数据缺失</td></tr>';
    }

    /* 概念方向小卡 */
    if (conceptsEl) {
      var maxConc = concepts.reduce(function (m, c) { return Math.max(m, numOr(obj(c).score, 0)); }, 1) || 1;
      conceptsEl.innerHTML = concepts.map(function (c) {
        c = obj(c);
        var sc = n(c.score);
        var pp = n(c.price_pct);
        var net5 = n(c.net5_yi);
        var dd = n(c.dd500);
        var r20 = n(c.r20);
        var news = n(c.news_heat);
        var w = sc == null ? 0 : clamp(sc / Math.max(100, maxConc) * 100, 4, 100);
        return '<div class="concept-card">' +
          '<div class="concept-head">' +
            '<span class="concept-name">' + esc(c.name || '—') + '</span>' +
            '<span class="concept-score">' + (sc == null ? '—' : sc.toFixed(1)) + '</span>' +
          '</div>' +
          '<div class="concept-bar"><i style="width:' + w.toFixed(1) + '%"></i></div>' +
          '<div class="concept-meta">' +
            '<span>价格分位 <b>' + (pp == null ? '—' : pp.toFixed(0) + '%') + '</b></span>' +
            '<span>5日资金 <b class="' + dirClass(net5) + '">' +
              (net5 == null ? '—' : (net5 > 0 ? '+' : '') + net5.toFixed(1) + '亿') + '</b></span>' +
            '<span>距高点 <b class="bt-dd">' + fmtPct(dd) + '</b></span>' +
            (r20 == null ? '' : '<span>20日 <b class="' + dirClass(r20) + '">' + fmtPct(r20) + '</b></span>') +
            (news == null ? '' : '<span>新闻 <b>' + fmtInt(news) + '</b></span>') +
          '</div>' +
        '</div>';
      }).join('');
    }

    /* 口径与免责 */
    if (footEl) {
      footEl.textContent = '口径：' + (method || '—') +
        '。净利 TTM 同比由「市值 ÷ PE」反推，非官方净利润，仅用于行业间横向比较；' +
        '「便宜程度」= 申万二级 PE 的 2021 年以来分位（越低越便宜），价格分位同理。' +
        '数据每日 17:00 更新，不构成投资建议。';
    }
  }

  /* =====================================================================
   * 3.12 妖股种子（yaogu_seed）
   * ===================================================================== */
  var seedState = { expanded: {} };

  function seedStageBadge(stage) {
    var s = String(stage || '');
    if (/加速/.test(s)) return '<span class="stage-badge stage-accel">加速</span>';
    if (/启动/.test(s)) return '<span class="stage-badge stage-start">启动</span>';
    if (/潜伏/.test(s)) return '<span class="stage-badge stage-latent">潜伏</span>';
    return '<span class="stage-badge stage-latent">' + esc(s || '—') + '</span>';
  }

  function renderSeed(p) {
    var sec = byId('sec-seed');
    if (!sec) return;
    var ys = obj(obj(p).yaogu_seed);
    if (!Object.keys(ys).length) { sec.hidden = true; return; }
    sec.hidden = false;

    var stats = obj(ys.stats);
    var metaEl = byId('seed-meta');
    if (metaEl) {
      var bits = [];
      if (ys.model_version) bits.push('模型 v' + ys.model_version);
      var list = arr(ys.list);
      var latent = list.filter(function (x) { return /潜伏/.test(String(obj(x).stage)); }).length;
      var started = list.filter(function (x) { return /启动/.test(String(obj(x).stage)); }).length;
      if (list.length) bits.push('今日 ' + list.length + ' 只种子（潜伏 ' + latent + ' / 启动 ' + started + '）');
      metaEl.textContent = bits.join(' · ') || '—';
    }

    /* 案例反推 */
    var casesEl = byId('seed-cases');
    var cases = arr(ys.case_studies);
    if (casesEl) {
      if (!cases.length) {
        casesEl.innerHTML = emptyState('案例数据缺失');
      } else {
        casesEl.innerHTML = cases.slice(0, 2).map(function (c) {
          c = obj(c);
          var pre = arr(c.preconditions).map(function (x) {
            x = obj(x);
            var met = x.met === true;
            return '<li class="' + (met ? 'met-true' : 'met-false') + '">' +
              '<span class="mark">' + (met ? '✓' : '✗') + '</span>' +
              '<span><b>' + esc(x.name || '—') + '</b>' +
                (x.value ? '<span class="val">：' + esc(x.value) + '</span>' : '') +
                (x.note ? '<span class="note">' + esc(x.note) + '</span>' : '') +
              '</span></li>';
          }).join('');
          return '<div class="case-card">' +
            '<div class="case-head">' +
              '<span class="case-name">' + esc(c.name || '—') + '</span>' +
              '<span class="case-code">' + esc(c.code || '') + '</span>' +
              (c.run ? '<span class="case-run">' + esc(c.run) + '</span>' : '') +
            '</div>' +
            (c.run_start ? '<div class="case-sub">启动日 ' + esc(c.run_start) + '</div>' : '') +
            '<ul class="case-pre">' + pre + '</ul>' +
            (c.note ? '<div class="case-foot">' + esc(c.note) + '</div>' : '') +
          '</div>';
        }).join('');
      }
    }

    /* 统计 */
    var statsEl = byId('seed-stats');
    if (statsEl) {
      statsEl.innerHTML =
        '<span class="stat-pill">扫描个股 <b>' + fmtInt(stats.scanned) + '</b></span>' +
        '<span class="stat-pill">通过先决条件 <b>' + fmtInt(stats.passed) + '</b></span>' +
        '<span class="stat-pill">输出种子 <b>' + fmtInt(stats.reported != null ? stats.reported : arr(ys.list).length) + '</b></span>';
    }

    renderSeedRows();

    /* 跟踪规则 */
    var ruleEl = byId('seed-tracking');
    var rules = arr(ys.tracking_rules);
    if (ruleEl) {
      ruleEl.innerHTML = rules.length ? rules.map(function (r) {
        r = obj(r);
        return '<li><span class="n">' + esc(r.name || '规则') + '</span>' +
          '<span class="r">' + esc(r.rule || r.text || '') + '</span></li>';
      }).join('') : '<li class="empty-state">跟踪规则缺失</li>';
    }

    var calEl = byId('seed-calibration');
    if (calEl) {
      calEl.textContent = ys.calibration || '';
      calEl.hidden = !ys.calibration;
    }

    var sumEl = byId('seed-summary');
    if (sumEl) sumEl.textContent = ys.summary || '';
  }

  function renderSeedRows() {
    var tbody = byId('seed-tbody');
    if (!tbody) return;
    var ys = obj(obj(state.latest).yaogu_seed);
    var list = arr(ys.list).filter(function (x) { return x && typeof x === 'object'; });
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="empty-state">今日无种子（或模型数据缺失）</td></tr>';
      return;
    }
    var rows = [];
    list.forEach(function (x, i) {
      x = obj(x);
      var code = String(x.code || ('row' + i));
      var open = !!seedState.expanded[code];
      var prob = n(x.prob);
      var probPct = prob == null ? 0 : clamp(prob <= 1.0001 ? prob * 100 : prob, 0, 100);
      var seedScore = n(x.seed_score);
      var lv = seedScore == null ? 'lv-mid' : (seedScore >= 72 ? 'lv-high' : (seedScore >= 62 ? 'lv-mid' : 'lv-low'));
      var concepts = arr(x.concepts);
      rows.push('<tr class="seed-row' + (open ? ' is-open' : '') + '" data-code="' + esc(code) + '">' +
        '<td class="col-rank">' + (i + 1) + '</td>' +
        '<td class="code-cell">' + esc(x.code || '—') + '</td>' +
        '<td class="name-cell">' + esc(x.name || '—') + (open ? ' <span class="muted">▾</span>' : '') + '</td>' +
        '<td class="num">' + (n(x.float_cap_yi) == null ? '—' : fmtYi(x.float_cap_yi)) + '</td>' +
        '<td class="num"><span class="seed-score-cell">' +
          '<span class="prob-mini-track" style="width:52px"><i class="prob-mini-fill ' + lv + '" style="width:' +
            (seedScore == null ? 0 : clamp(seedScore, 0, 100)).toFixed(1) + '%"></i></span>' +
          '<span class="seed-score-num">' + (seedScore == null ? '—' : seedScore.toFixed(1)) + '</span></span></td>' +
        '<td class="num"><span class="prob-cell"><span class="prob-mini-track">' +
          '<i class="prob-mini-fill ' + lv + '" style="width:' + probPct.toFixed(1) + '%"></i></span>' +
          '<span class="prob-mini-num">' + (prob == null ? '—' : probPct.toFixed(0) + '%') + '</span></span></td>' +
        '<td>' + seedStageBadge(x.stage) + '</td>' +
        '<td><span class="tag-row">' + (concepts.length ? concepts.slice(0, 3).map(function (c) {
          return '<span class="tag">' + esc(c) + '</span>';
        }).join('') : '<span class="muted">—</span>') + '</span></td>' +
        '<td class="muted" style="white-space:normal;min-width:190px;max-width:260px" title="' +
          esc(x.trigger || '') + '">' + esc(x.trigger || '—') + '</td>' +
      '</tr>');
      if (open) rows.push(seedDetailRow(x));
    });
    tbody.innerHTML = rows.join('');
  }

  function seedDetailRow(x) {
    var conds = arr(x.conditions).map(function (c) {
      c = obj(c);
      var met = c.met === true;
      return '<span class="cond-item ' + (met ? 'ok' : 'no') + '" title="' + esc(c.value || '') + '">' +
        '<span class="mark">' + (met ? '✓' : '✗') + '</span>' +
        '<span class="n">' + esc(c.name || '') + '</span>' +
        '<span class="v">' + esc(c.value || '') + '</span></span>';
    }).join('');
    var cd = arr(x.concept_details).slice(0, 4).map(function (c) {
      c = obj(c);
      return '<span class="tag" title="' + esc(c.reason || '') + '">' + esc(c.board || '') +
        (c.is_precise ? ' ✓' : '') + '</span>';
    }).join('');
    var genes = obj(x.limit_genes);
    var geneTxt = '';
    if (Object.keys(genes).length) {
      var g = [];
      if (n(genes.limit_up_count_60d) != null) g.push('60日涨停 ' + fmtInt(genes.limit_up_count_60d) + ' 次');
      if (n(genes.max_streak_250d) != null) g.push('250日最大 ' + fmtInt(genes.max_streak_250d) + ' 连板');
      if (n(genes.days_since_last_limit) != null) g.push('距上次涨停 ' + fmtInt(genes.days_since_last_limit) + ' 日');
      geneTxt = g.join(' · ');
    }
    return '<tr class="seed-detail-row"><td colspan="9"><div class="seed-detail">' +
      '<div class="cond-grid">' + (conds || '<span class="muted">条件明细缺失</span>') + '</div>' +
      (geneTxt ? '<div class="seed-detail-block"><span class="k">涨停基因</span>' + esc(geneTxt) + '</div>' : '') +
      (x.trigger ? '<div class="seed-detail-block"><span class="k">触发条件</span>' + esc(x.trigger) + '</div>' : '') +
      (x.invalidation ? '<div class="seed-detail-block risk"><span class="k">失效条件</span>' + esc(x.invalidation) + '</div>' : '') +
      (x.risk ? '<div class="seed-detail-block risk"><span class="k">风险</span>' + esc(x.risk) + '</div>' : '') +
      (cd ? '<div class="seed-detail-block"><span class="k">题材</span>' + cd + '</div>' : '') +
    '</div></td></tr>';
  }

  function bindSeedTable() {
    var tbody = byId('seed-tbody');
    if (!tbody) return;
    tbody.addEventListener('click', function (e) {
      var tr = e.target.closest ? e.target.closest('tr.seed-row') : null;
      if (!tr) return;
      var code = tr.getAttribute('data-code');
      if (!code) return;
      seedState.expanded[code] = !seedState.expanded[code];
      renderSeedRows();
    });
  }

  /* =====================================================================
   * 3.13 短线作战（short_term）
   * ===================================================================== */
  function shortTermNotReady(st) {
    var temp = obj(st.market_temp);
    var label = String(temp.label || '');
    var hasTemp = n(temp.score) != null && label && label !== '未知';
    var hasBody = arr(st.directions).length || arr(st.setups).length || arr(st.checks).length;
    return !hasTemp && !hasBody;
  }

  function renderShortTerm(p) {
    var sec = byId('sec-shortterm');
    if (!sec) return;
    var st = obj(obj(p).short_term);
    if (!Object.keys(st).length) { sec.hidden = true; return; }
    sec.hidden = false;

    var notReady = shortTermNotReady(st);
    var temp = obj(st.market_temp);
    var canTrade = st.can_trade === true;
    var posPct = pct01(st.suggest_position_pct);
    var metaEl = byId('short-meta');
    if (metaEl) {
      metaEl.textContent = notReady
        ? '模块未就绪（数据缺失）'
        : ('市场温度 ' + (temp.label || '—') + (n(temp.score) == null ? '' : ' · ' + n(temp.score).toFixed(0)));
    }

    var ctEl = byId('short-cantrade');
    if (ctEl) {
      var cls = notReady ? 'unknown' : (canTrade ? 'ok' : 'no');
      var big = notReady ? '数据未就绪' : (canTrade ? '可试水' : '不建议');
      ctEl.innerHTML =
        '<span class="cantrade-big ' + cls + '">' + big + '</span>' +
        '<span class="cantrade-sub">' + (notReady ? '短线模块未就绪，以下为占位' :
          (canTrade ? '情绪与量能满足短线试水条件' : '情绪/量能不满足，管住手、不开新仓')) + '</span>' +
        '<span class="cantrade-pos">短线仓位建议 ' +
          (posPct == null ? '—' : posPct.toFixed(0) + '%') + '</span>';
    }

    /* 温度计 */
    var score = n(temp.score);
    if (score == null || notReady) {
      chartEmpty('temp-chart', '温度数据缺失');
    } else {
      var inst = initChart('temp-chart');
      if (inst) {
        inst.setOption({
          animationDuration: 600,
          series: [{
            type: 'gauge', startAngle: 200, endAngle: -20, min: 0, max: 100,
            radius: '100%', center: ['50%', '58%'],
            axisLine: {
              lineStyle: {
                width: 10,
                color: [
                  [0.20, 'rgba(34,120,238,0.75)'],
                  [0.40, 'rgba(34,211,238,0.75)'],
                  [0.60, 'rgba(245,196,81,0.8)'],
                  [0.80, 'rgba(255,77,94,0.85)'],
                  [1, 'rgba(147,168,189,0.55)']
                ]
              }
            },
            progress: { show: false },
            pointer: { show: true, length: '62%', width: 4, itemStyle: { color: '#eaf4ff' } },
            axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false },
            anchor: { show: true, size: 8, itemStyle: { color: '#eaf4ff', borderColor: C.cyan, borderWidth: 2 } },
            title: { offsetCenter: [0, '40%'], color: C.muted, fontSize: 10, fontFamily: FONT },
            detail: {
              offsetCenter: [0, '4%'], fontSize: 23, fontWeight: 700, fontFamily: FONT,
              color: '#eaf4ff', formatter: function (v) { return v.toFixed(0); }
            },
            data: [{ value: clamp(score, 0, 100), name: temp.label || '情绪温度' }]
          }]
        }, true);
      }
    }
    var stagesEl = byId('temp-stages');
    if (stagesEl) {
      var stages = ['冰点', '修复', '发酵', '高潮', '退潮'];
      var cur = String(temp.label || '');
      stagesEl.innerHTML = stages.map(function (s) {
        return '<span class="temp-stage' + (cur.indexOf(s) >= 0 ? ' active' : '') + '">' + s + '</span>';
      }).join('');
    }

    /* 判定说明 */
    var checksEl = byId('short-checks');
    var checks = arr(st.checks);
    if (checksEl) {
      if (notReady) {
        checksEl.innerHTML = '<div class="not-ready"><b>短线模块未就绪</b><br>' +
          '后端 analysis.shortterm 加载失败，暂时只有占位数据。<br>数据结构已就绪，模块恢复后本区块自动填充。</div>';
      } else if (checks.length) {
        checksEl.innerHTML = checks.slice(0, 5).map(function (c) {
          if (typeof c === 'string') {
            return '<div class="short-check"><span class="mark">·</span><span class="t">' + esc(c) + '</span></div>';
          }
          c = obj(c);
          var pass = c.pass === true || c.met === true || c.ok === true;
          return '<div class="short-check ' + (pass ? 'pass' : 'fail') + '">' +
            '<span class="mark">' + (pass ? '✓' : '✗') + '</span>' +
            '<span><span class="k">' + esc(c.name || c.title || '判定') + '</span>' +
              '<span class="t"> ' + esc(c.text || c.reason || c.desc || '') + '</span></span></div>';
        }).join('');
      } else {
        checksEl.innerHTML = emptyState('判定说明缺失');
      }
    }

    /* 短线方向 */
    var dirsEl = byId('short-dirs');
    var dirs = arr(st.directions);
    if (dirsEl) {
      dirsEl.innerHTML = dirs.length ? dirs.map(function (d) {
        d = obj(d);
        var vs = arr(d.vehicles).map(function (v) {
          v = obj(v);
          return '<span class="tag" style="color:#22d3ee">' + esc(v.name || v.code || '—') +
            '<span class="muted"> ' + esc(v.code || '') + '</span></span>';
        });
        return '<div class="dir-card">' +
          '<div class="dir-card-name">' + esc(d.name || '—') + '</div>' +
          (d.reason ? '<div class="dir-card-reason">' + esc(d.reason) + '</div>' : '') +
          (vs.length ? '<div class="dir-card-vehicles">' + vs.join('') + '</div>' : '') +
        '</div>';
      }).join('') : emptyState('短线方向缺失');
    }

    /* 可执行形态 */
    var setupsEl = byId('short-setups');
    var setups = arr(st.setups);
    if (setupsEl) {
      setupsEl.innerHTML = setups.length ? setups.map(function (s) {
        s = obj(s);
        return '<div class="setup-item">' +
          '<div class="setup-name">' + esc(s.name || '—') + '</div>' +
          (s.desc ? '<div class="setup-desc">' + esc(s.desc) + '</div>' : '') +
          '<div class="setup-levels">' +
            (s.entry ? '<span class="entry">进场 <b>' + esc(s.entry) + '</b></span>' : '') +
            (s.stop ? '<span class="stop">止损 <b>' + esc(s.stop) + '</b></span>' : '') +
            (s.target ? '<span class="target">目标 <b>' + esc(s.target) + '</b></span>' : '') +
          '</div>' +
        '</div>';
      }).join('') : emptyState('可执行形态缺失');
    }

    /* 纪律 */
    var rulesEl = byId('short-rules');
    var rules = arr(st.rules);
    if (rulesEl) {
      rulesEl.innerHTML = rules.length ? rules.map(function (r) {
        return '<li class="rule-item">' + esc(r) + '</li>';
      }).join('') : '<li class="empty-state">纪律缺失</li>';
    }

    /* 今日计划 */
    var planEl = byId('short-plan');
    var plan = arr(st.today_plan);
    if (planEl) {
      planEl.innerHTML = plan.length ? plan.map(function (t) {
        t = obj(t);
        var action = String(t.action || '');
        var aCls = /买|加|参与/.test(action) ? 'up' : (/卖|减|清/.test(action) ? 'down' : 'muted');
        return '<li class="plan-item">' +
          '<span class="plan-window">' + esc(t.window || '—') + '</span>' +
          '<span class="plan-action ' + aCls + '">' + esc(action || '—') + '</span>' +
          '<span class="plan-reason">' + esc(t.reason || '') + '</span>' +
        '</li>';
      }).join('') : '<li class="empty-state">今日无短线计划</li>';
    }

    var sumEl = byId('short-summary');
    if (sumEl) sumEl.textContent = st.summary || '';
  }

  /* =====================================================================
   * 3.14 3000 元配置（portfolio，不含红利）
   * ===================================================================== */
  var PF_COLORS = { core: '#22d3ee', satellite: '#f5c451', tactical: '#a78bfa', cash: '#7a93ad' };

  function renderPortfolio(p) {
    var sec = byId('sec-portfolio');
    if (!sec) return;
    var pf = obj(obj(p).portfolio);
    if (!Object.keys(pf).length) { sec.hidden = true; return; }
    sec.hidden = false;

    var capital = n(pf.capital);
    var validHolding = function (x) {
      x = obj(x);
      return numOr(x.weight, 0) > 0.0001 || numOr(x.amount, 0) > 0.0001 || numOr(x.shares, 0) > 0;
    };
    var core = arr(pf.core).filter(function (x) { return x && typeof x === 'object' && validHolding(x); });
    var satellite = arr(pf.satellite).filter(function (x) { return x && typeof x === 'object' && validHolding(x); });
    var tactical = obj(pf.tactical);
    var cash = obj(pf.cash);
    var notReady = !core.length && !satellite.length;

    var sumW = function (list) {
      return list.reduce(function (s, x) { return s + numOr(obj(x).weight, 0); }, 0);
    };
    var wCore = sumW(core), wSat = sumW(satellite);
    var wTac = numOr(tactical.weight, 0), wCash = numOr(cash.weight, 0);
    var totalW = wCore + wSat + wTac + wCash;

    var metaEl = byId('portfolio-meta');
    if (metaEl) {
      metaEl.textContent = (pf.style || '核心-卫星-战术') + (capital == null ? '' : ' · 本金 ' + fmtYuan(capital)) +
        ' · 不含红利' + (notReady ? ' · 模块未就绪（当前仅现金）' : '');
    }

    /* 环形图 */
    var segs = [
      { key: 'core', name: '核心仓', w: wCore, amount: core.reduce(function (s, x) { return s + numOr(obj(x).amount, 0); }, 0) },
      { key: 'satellite', name: '卫星仓', w: wSat, amount: satellite.reduce(function (s, x) { return s + numOr(obj(x).amount, 0); }, 0) },
      { key: 'tactical', name: '战术仓', w: wTac, amount: numOr(tactical.amount, 0) },
      { key: 'cash', name: '现金', w: wCash, amount: numOr(cash.amount, 0) }
    ].filter(function (s) { return s.w > 0.0001; });

    if (!segs.length) {
      chartEmpty('portfolio-chart', '配置数据缺失');
    } else {
      var inst = initChart('portfolio-chart');
      if (inst) {
        inst.setOption({
          animationDuration: 700,
          tooltip: baseTooltip({
            trigger: 'item',
            formatter: function (ps) {
              return '<b>' + esc(ps.name) + '</b><br>权重 <b>' + (ps.value).toFixed(1) + '%</b>' +
                (ps.data && ps.data.amount != null ? '<br>金额 <b>' + fmtYuan(ps.data.amount) + '</b>' : '');
            }
          }),
          legend: {
            bottom: 0, left: 'center', itemWidth: 10, itemHeight: 8, itemGap: 12,
            textStyle: { color: C.muted, fontSize: 10.5, fontFamily: FONT }
          },
          series: [{
            type: 'pie', radius: ['52%', '76%'], center: ['50%', '44%'],
            avoidLabelOverlap: true,
            itemStyle: { borderColor: '#0a1220', borderWidth: 2 },
            label: {
              show: true, position: 'inside', color: '#08131f', fontSize: 10.5, fontWeight: 700,
              formatter: function (ps) { return ps.value >= 8 ? ps.value.toFixed(0) + '%' : ''; }
            },
            labelLine: { show: false },
            data: segs.map(function (s) {
              return {
                name: s.name + ' ' + (s.w * 100).toFixed(0) + '%',
                value: +(s.w * 100).toFixed(2),
                amount: s.amount,
                itemStyle: { color: PF_COLORS[s.key] }
              };
            })
          }]
        }, true);
      }
    }

    /* 明细表 */
    var tbody = byId('portfolio-tbody');
    if (tbody) {
      var rows = [];
      core.forEach(function (x) {
        x = obj(x);
        rows.push(pfRow('core', '核心', x));
      });
      satellite.forEach(function (x) {
        x = obj(x);
        rows.push(pfRow('satellite', '卫星', x));
      });
      if (wTac > 0.0001 || n(tactical.amount) != null) {
        rows.push('<tr><td><span class="pf-cat tactical">战术</span></td>' +
          '<td class="name-cell">短线试水仓</td>' +
          '<td class="num">' + (wTac * 100).toFixed(0) + '%</td>' +
          '<td class="num">' + fmtYuan(tactical.amount) + '</td>' +
          '<td class="num">—</td>' +
          '<td class="muted" style="white-space:normal;min-width:160px">' + esc(tactical.note || '') + '</td></tr>');
      }
      if (wCash > 0.0001) {
        rows.push('<tr><td><span class="pf-cat cash">现金</span></td>' +
          '<td class="name-cell">现金 / 货币ETF</td>' +
          '<td class="num">' + (wCash * 100).toFixed(0) + '%</td>' +
          '<td class="num">' + fmtYuan(cash.amount) + '</td>' +
          '<td class="num">—</td>' +
          '<td class="muted" style="white-space:normal;min-width:160px">' + esc(cash.note || '') + '</td></tr>');
      }
      tbody.innerHTML = rows.length ? rows.join('') :
        '<tr><td colspan="6" class="empty-state">配置明细缺失（模块未就绪）</td></tr>';
    }

    var totalEl = byId('portfolio-total');
    if (totalEl) {
      var totalAmount = core.concat(satellite).reduce(function (s, x) { return s + numOr(obj(x).amount, 0); }, 0) +
        numOr(tactical.amount, 0) + numOr(cash.amount, 0);
      totalEl.innerHTML =
        '<span>权重合计 <b>' + (totalW * 100).toFixed(0) + '%</b></span>' +
        '<span>金额合计 <b>' + fmtYuan(totalAmount) + '</b></span>' +
        '<span>本金 <b>' + (capital == null ? '—' : fmtYuan(capital)) + '</b></span>' +
        '<span>风格 <b>' + esc(pf.style || '核心-卫星-战术') + '</b></span>';
    }

    var rbEl = byId('portfolio-rebalance');
    if (rbEl) {
      var rb = pf.rebalance_rule || '';
      rbEl.innerHTML = rb ? '<b>再平衡规则：</b>' + esc(rb) : '<b>再平衡规则：</b>—';
    }
    if (notReady) {
      var sumEl0 = byId('portfolio-summary');
      if (sumEl0) {
        sumEl0.textContent = pf.summary || '';
      }
    }
    var sumEl = byId('portfolio-summary');
    if (sumEl) sumEl.textContent = pf.summary || '';
  }

  function pfRow(cat, catName, x) {
    var w = numOr(x.weight, 0);
    return '<tr>' +
      '<td><span class="pf-cat ' + cat + '">' + esc(catName) + '</span></td>' +
      '<td class="name-cell">' + esc(x.name || '—') + ' <span class="code-cell">' + esc(x.code || '') + '</span></td>' +
      '<td class="num">' + (w * 100).toFixed(0) + '%</td>' +
      '<td class="num">' + fmtYuan(x.amount) + '</td>' +
      '<td class="num">' + (n(x.shares) == null ? '—' : fmtInt(x.shares)) + '</td>' +
      '<td class="muted" style="white-space:normal;min-width:160px">' + esc(x.why || '') + '</td>' +
    '</tr>';
  }

  /* =====================================================================
   * 3.14b 中国科技长线（tech_conviction，激进档执行方案）
   * ===================================================================== */
  function techLabelClass(label) {
    var s = String(label || '');
    if (/强烈看好|强烈/.test(s)) return 'lv-strong';
    if (/看好/.test(s)) return 'lv-good';
    if (/中性/.test(s)) return 'lv-neutral';
    return 'lv-cautious';
  }

  function renderTechConviction(p) {
    var sec = byId('sec-tech');
    if (!sec) return;
    var tc = obj(obj(p).tech_conviction);
    if (!Object.keys(tc).length) { sec.hidden = true; return; }
    sec.hidden = false;

    var score = n(tc.thesis_score);
    var label = String(tc.label || '');
    var lvCls = techLabelClass(label);
    var satellite = n(tc.satellite_amount);

    /* meta */
    var metaEl = byId('tech-meta');
    if (metaEl) {
      var bits = [];
      if (tc.profile_label) bits.push('档位：' + tc.profile_label);
      if (tc.horizon) bits.push('持有周期 ' + tc.horizon);
      if (satellite != null) bits.push('卫星仓总额 ' + fmtYuan(satellite));
      metaEl.textContent = bits.join(' · ') || '—';
    }

    /* 证据分仪表盘 */
    var scoreEl = byId('tech-score');
    if (scoreEl) scoreEl.textContent = score == null ? '—' : score.toFixed(0);
    var labelEl = byId('tech-label');
    if (labelEl) {
      labelEl.textContent = label || '—';
      labelEl.className = 'tech-label ' + lvCls;
    }
    var horizonEl = byId('tech-horizon');
    if (horizonEl) horizonEl.textContent = tc.horizon ? ('持有周期 ' + tc.horizon) : '';

    if (score == null) {
      chartEmpty('thesis-chart', '证据分缺失');
    } else {
      var inst = initChart('thesis-chart');
      if (inst) {
        var gColor = score >= 75 ? C.gold : (score >= 60 ? C.cyan : (score >= 45 ? '#93a8bd' : C.down));
        inst.setOption({
          animationDuration: 700,
          series: [{
            type: 'gauge', startAngle: 220, endAngle: -40, min: 0, max: 100,
            radius: '100%', center: ['50%', '58%'],
            progress: { show: true, width: 9, roundCap: true, itemStyle: { color: gColor } },
            axisLine: { lineStyle: { width: 9, color: [[1, 'rgba(255,255,255,0.07)']] } },
            pointer: { show: false }, axisTick: { show: false }, splitLine: { show: false },
            axisLabel: { show: false }, anchor: { show: false },
            title: { offsetCenter: [0, '6%'], color: C.muted, fontSize: 11, fontFamily: FONT },
            detail: { show: false },
            data: [{ value: clamp(score, 0, 100), name: '证据分' }]
          }]
        }, true);
      }
    }

    var oneEl = byId('tech-one-line');
    if (oneEl) oneEl.textContent = tc.one_line || '—';

    /* 5 个证据维度 */
    var reasonsEl = byId('tech-reasons');
    var reasons = arr(tc.reasons).filter(function (x) { return x && typeof x === 'object'; });
    if (reasonsEl) {
      reasonsEl.innerHTML = reasons.length ? reasons.map(function (r) {
        r = obj(r);
        var sc = n(r.score);
        var w = sc == null ? 0 : clamp(sc, 0, 100);
        var fillCls = sc == null ? 'low' : (sc >= 75 ? 'high' : (sc >= 55 ? 'mid' : 'low'));
        return '<div class="reason-row">' +
          '<span class="reason-name">' + esc(r.name || '—') + '</span>' +
          '<span class="reason-bar-wrap">' +
            '<span class="reason-track"><i class="reason-fill ' + fillCls + '" style="width:' + w.toFixed(1) + '%"></i></span>' +
            '<span class="reason-text" title="' + esc(r.text || '') + '">' + esc(r.text || '') + '</span>' +
          '</span>' +
          '<span class="reason-score">' + (sc == null ? '—' : sc.toFixed(0)) + '</span>' +
        '</div>';
      }).join('') : emptyState('证据维度缺失');
    }

    /* 关键指标 */
    var metrics = obj(tc.metrics);
    var mEl = byId('tech-metrics');
    if (mEl) {
      var items = [];
      function pushMetric(k, v, cls, unit) {
        if (v == null) return;
        items.push({ k: k, v: v, cls: cls || '', unit: unit || '' });
      }
      pushMetric('ETF 现价', n(metrics.etf_price) == null ? null : fmtPrice(metrics.etf_price));
      pushMetric('MA20', n(metrics.etf_ma20) == null ? null : fmtPrice(metrics.etf_ma20));
      pushMetric('RSI', n(metrics.etf_rsi) == null ? null : n(metrics.etf_rsi).toFixed(1));
      pushMetric('场内溢价', n(metrics.etf_premium) == null ? null : fmtPct(metrics.etf_premium),
        n(metrics.etf_premium) != null && n(metrics.etf_premium) > 1.5 ? 'is-warn' : '');
      pushMetric('20 日波动', n(metrics.etf_vol20) == null ? null : fmtPct(metrics.etf_vol20, 1, false));
      pushMetric('行业净利同比', n(metrics.sector_earn_yoy) == null ? null : fmtPct(metrics.sector_earn_yoy), dirClass(metrics.sector_earn_yoy));
      pushMetric('行业 PE 分位', n(metrics.sector_pe_pct) == null ? null : fmtPct(metrics.sector_pe_pct, 1, false));
      pushMetric('距 500 日高点', n(metrics.sector_dd500) == null ? null : fmtPct(metrics.sector_dd500), 'bt-dd');
      pushMetric('价格分位', n(metrics.sector_price_pct) == null ? null : fmtPct(metrics.sector_price_pct, 0, false));
      mEl.innerHTML = items.length ? items.map(function (it) {
        return '<div class="tech-metric"><span class="k">' + esc(it.k) + '</span>' +
          '<span class="v ' + it.cls + '">' + it.v + '</span></div>';
      }).join('') : emptyState('关键指标缺失');
    }

    /* 分批建仓计划 */
    var plan = arr(tc.plan).filter(function (x) { return x && typeof x === 'object'; });
    var planMeta = byId('tech-plan-meta');
    if (planMeta) {
      planMeta.textContent = (satellite == null ? '卫星仓' : '卫星仓总额 ' + fmtYuan(satellite)) +
        ' · ' + plan.length + ' 批执行' + (plan.length ? ' · 第 1 批「现在」' : '');
    }
    var tbody = byId('tech-plan-tbody');
    if (tbody) {
      if (!plan.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty-state">建仓计划缺失</td></tr>';
      } else {
        var sorted = plan.slice().sort(function (a, b) {
          return numOr(obj(a).tranche, 0) - numOr(obj(b).tranche, 0);
        });
        tbody.innerHTML = sorted.map(function (t) {
          t = obj(t);
          var idx = numOr(t.tranche, 0);
          var isNow = idx === 1 || /现在/.test(String(t.when || ''));
          var share = pct01(t.share);
          var price = n(t.price_ref);
          var amountPlanned = n(t.amount);
          var amountActual = n(t.actual_amount);
          var shares = n(t.shares);
          return '<tr' + (isNow ? ' class="is-now"' : '') + '>' +
            '<td><span class="tech-plan-when"><span class="tranche-badge' + (idx === 1 ? ' t1' : '') + '">' + (idx || '·') + '</span> ' +
              esc(t.when || '—') + (isNow ? '<span class="now-badge">现在</span>' : '') + '</span></td>' +
            '<td class="num">' + (share == null ? '—' : share.toFixed(0) + '%') + '</td>' +
            '<td class="muted" style="white-space:normal;min-width:220px;max-width:340px">' + esc(t.trigger || '—') + '</td>' +
            '<td class="num">' + (price == null ? '—' : fmtPrice(price)) + '</td>' +
            '<td class="num"><span class="tech-plan-amount">' +
              '<span class="main">' + (amountActual == null ? fmtYuan(amountPlanned) : fmtYuan(amountActual)) + '</span>' +
              (amountPlanned == null || amountActual == null ? '' :
                '<span class="sub">计划 ' + fmtYuan(amountPlanned) + '</span>') +
            '</span></td>' +
            '<td class="num">' + (shares == null ? '—' : fmtInt(shares) + ' 份') + '</td>' +
            '<td class="muted" style="white-space:normal;min-width:200px;max-width:300px">' + esc(t.note || '') + '</td>' +
          '</tr>';
        }).join('');
      }
    }

    /* 失效条件 */
    var invEl = byId('tech-invalidators');
    var inv = arr(tc.invalidators);
    if (invEl) {
      invEl.innerHTML = inv.length ? inv.map(function (x) {
        return '<li>' + esc(typeof x === 'string' ? x : (obj(x).text || JSON.stringify(x))) + '</li>';
      }).join('') : '<li class="empty-state">失效条件缺失</li>';
    }

    /* 风险预算 */
    var risk = obj(tc.risk_controls);
    var riskEl = byId('tech-risk');
    if (riskEl) {
      var dd = n(risk.worst_drawdown_pct);
      var loss = n(risk.worst_loss_yuan);
      var single = n(risk.max_single_etf_pct);
      var rules = [];
      if (risk.stop_rule) rules.push({ k: '止损', v: risk.stop_rule });
      if (risk.premium_rule) rules.push({ k: '溢价', v: risk.premium_rule });
      if (risk.review_rule) rules.push({ k: '复盘', v: risk.review_rule });
      if (single != null) rules.push({ k: '上限', v: '单只 ETF 最高占卫星仓 ' + single.toFixed(0) + '%' });
      riskEl.innerHTML =
        '<div class="tech-risk-nums">' +
          '<div class="tech-risk-num"><div class="k">最坏情况 · 卫星仓最大回撤</div>' +
            '<div class="v">-' + (dd == null ? '—' : dd.toFixed(0)) + '<small>%</small></div></div>' +
          '<div class="tech-risk-num"><div class="k">最坏情况 · 亏损金额</div>' +
            '<div class="v">' + (loss == null ? '—' : fmtYuan(loss).replace(' 元', '')) + '<small> 元</small></div></div>' +
        '</div>' +
        (rules.length ? '<ul class="tech-risk-rules">' + rules.map(function (r) {
          return '<li><span class="k">' + esc(r.k) + '：</span>' + esc(r.v) + '</li>';
        }).join('') + '</ul>' : '');
    }

    var sumEl = byId('tech-summary');
    if (sumEl) sumEl.textContent = tc.summary || '';
    var discEl = byId('tech-disclaimer');
    if (discEl) {
      discEl.textContent = '这是仓位执行方案，不是收益承诺；激进档意味着更大回撤容忍度' +
        (n(risk.worst_drawdown_pct) == null ? '' : '（最坏情况：卫星仓约 -' + n(risk.worst_drawdown_pct).toFixed(0) + '% / ≈' +
          (n(risk.worst_loss_yuan) == null ? '—' : fmtYuan(risk.worst_loss_yuan)) + '）') + '。';
    }
  }

  /* =====================================================================
   * 3.15 复盘与自优化（review）
   * ===================================================================== */
  function renderReview(p) {
    var sec = byId('sec-review');
    if (!sec) return;
    var rv = obj(obj(p).review);
    if (!Object.keys(rv).length) { sec.hidden = true; return; }
    sec.hidden = false;

    var metaEl = byId('review-meta');
    if (metaEl) {
      var bits = [];
      if (rv.as_of) bits.push('截至 ' + rv.as_of);
      var hr = obj(rv.hit_rate);
      if (n(hr.samples) != null) bits.push('已结算样本 ' + fmtInt(hr.samples));
      metaEl.textContent = bits.join(' · ') || '—';
    }

    /* KPI */
    var hr = obj(rv.hit_rate);
    var kEl = byId('review-kpis');
    if (kEl) {
      var cards = [];
      var st5 = n(hr.short_term_5d) != null ? hr.short_term_5d : (n(hr.short_term_20d) != null ? hr.short_term_20d : null);
      var st5pct = pct01(st5);
      cards.push(kpi('短期方向命中率', st5pct == null ? '—' : st5pct.toFixed(0) + '%',
        st5pct == null ? '样本不足，尚未结算' : ('样本 ' + fmtInt(hr.samples) + ' 条')));
      var mt60 = pct01(hr.medium_term_60d);
      cards.push(kpi('中期方向命中率', mt60 == null ? '—' : mt60.toFixed(0) + '%',
        mt60 == null ? '需 60 个交易日样本' : ''));
      var yg = pct01(hr.yaogu_20d);
      cards.push(kpi('妖股命中率', yg == null ? '—' : yg.toFixed(0) + '%',
        yg == null ? '需 20 日样本' : ''));
      cards.push(kpi('已存档判断', fmtInt(n(rv.saved_prediction ? 1 : 0) + (n(hr.samples) || 0)) + ' 条',
        '今日判断已写入，T+5 后自动结算'));
      kEl.innerHTML = cards.join('');
    }

    /* 方向拆解 chips */
    var breakdown = obj(hr.direction_breakdown);
    var kEl2 = byId('review-kpis');
    if (kEl2 && Object.keys(breakdown).length) {
      var chips = Object.keys(breakdown).map(function (k) {
        var v = breakdown[k];
        var txt = (n(v) == null) ? String(v) : (pct01(v) == null ? String(v) : pct01(v).toFixed(0) + '%');
        return '<span class="chip">' + esc(k) + ' <b>' + esc(txt) + '</b></span>';
      }).join('');
      kEl2.innerHTML += '<div class="kpi-card" style="grid-column:1/-1">' +
        '<div class="kpi-k">按方向拆解命中率</div><div class="macro-chips" style="margin-top:6px">' + chips + '</div></div>';
    }

    /* 记录表（取近 8 条；兼容 v1.1 与 lead 描述的两种字段） */
    var tbody = byId('review-tbody');
    var records = arr(rv.records);
    if (tbody) {
      if (!records.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-state">暂无已结算记录（T+5 后自动生成）</td></tr>';
      } else {
        tbody.innerHTML = records.slice(-8).reverse().map(function (r) {
          r = obj(r);
          var pred = r.direction || r.prediction || '—';
          var actual = r.actual != null ? String(r.actual) :
            (n(r.ret_pct) != null ? fmtPct(r.ret_pct) : '—');
          var hit = r.hit;
          var hitCls = hit === true ? 'hit' : (hit === false ? 'miss' : 'pending');
          var hitTxt = hit === true ? '命中' : (hit === false ? '未中' : '待结算');
          return '<tr>' +
            '<td class="mono">' + esc(r.date || '—') + '</td>' +
            '<td>' + esc(r.type || r.category || '方向') + '</td>' +
            '<td>' + esc(pred) + '</td>' +
            '<td class="' + (n(r.ret_pct) != null ? dirClass(r.ret_pct) : '') + '">' + esc(actual) + '</td>' +
            '<td><span class="hit-badge ' + hitCls + '">' + hitTxt + '</span></td>' +
            '<td class="muted">' + esc(r.status || '—') + '</td>' +
          '</tr>';
        }).join('');
      }
    }

    /* ETF 规则核对 */
    var etfEl = byId('review-etf-checks');
    var checks = arr(rv.etf_checks);
    if (etfEl) {
      if (!checks.length) {
        etfEl.innerHTML = '<li class="empty-state">暂无 ETF 规则核对记录</li>';
      } else {
        etfEl.innerHTML = checks.slice(0, 8).map(function (c) {
          if (typeof c === 'string') return '<li>' + esc(c) + '</li>';
          c = obj(c);
          var passed = c.pass === true || c.ok === true || c.met === true;
          var name = c.name || c.rule || c.title || c.code || '核对项';
          var note = c.note || c.text || c.desc || c.result || '';
          return '<li>' +
            '<span class="' + (passed ? 'up' : 'muted') + '" style="margin-right:6px">' + (passed ? '✓' : '✗') + '</span>' +
            '<b>' + esc(name) + '</b>' + (note ? ' · ' + esc(note) : '') + '</li>';
        }).join('');
      }
    }

    /* 自优化调整 */
    var adjEl = byId('review-adjustments');
    var adj = arr(rv.adjustments);
    if (adjEl) {
      adjEl.innerHTML = adj.length ? adj.map(function (a) {
        return '<li>' + esc(typeof a === 'string' ? a : (obj(a).text || JSON.stringify(a))) + '</li>';
      }).join('') : '<li class="empty-state">暂无调整建议</li>';
    }

    /* 今日存档判断 */
    var spEl = byId('review-saved');
    var sp = obj(rv.saved_prediction);
    if (spEl) {
      if (!Object.keys(sp).length) {
        spEl.innerHTML = emptyState('今日尚未存档判断');
      } else {
        var items = [
          ['存档日期', sp.date],
          ['指数收盘', (n(sp.index_close) == null ? '—' : fmt(sp.index_close, 2)) +
            (n(sp.index_chg_pct) == null ? '' : '（' + fmtPct(sp.index_chg_pct) + '）')],
          ['政权', (sp.regime || '—') + (n(sp.regime_score) == null ? '' : ' ' + n(sp.regime_score).toFixed(1))],
          ['短期方向', (sp.short_direction || '—') + (n(sp.short_confidence) == null ? '' : ' · 置信 ' + (pct01(sp.short_confidence) == null ? '' : pct01(sp.short_confidence).toFixed(0) + '%'))],
          ['中期方向', sp.medium_direction || '—'],
          ['ETF 评级', (sp.etf_rating || '—') + (n(sp.etf_position_pct) == null ? '' : ' · 仓位 ' + pct01(sp.etf_position_pct).toFixed(1) + '%')],
          ['ETF 价格', n(sp.etf_price) == null ? '—' : fmtPrice(sp.etf_price)],
          ['短线可交易', sp.short_term_can_trade === true ? '是' : (sp.short_term_can_trade === false ? '否' : '—')],
          ['种子首位', arr(sp.seed_top).length ? arr(sp.seed_top).slice(0, 3).join(' / ') : '—'],
          ['妖股首位', arr(sp.yaogu_top).length ? arr(sp.yaogu_top).slice(0, 3).join(' / ') : '—']
        ];
        spEl.innerHTML = '<div class="sp-grid">' + items.map(function (kv) {
          return '<div class="sp-item"><span class="sp-k">' + esc(kv[0]) + '</span>' +
            '<span class="sp-v">' + esc(kv[1] == null ? '—' : kv[1]) + '</span></div>';
        }).join('') + '</div>';
      }
    }

    var sumEl = byId('review-summary');
    if (sumEl) sumEl.textContent = rv.summary || '';
  }

  function kpi(k, v, sub) {
    return '<div class="kpi-card"><div class="kpi-k">' + esc(k) + '</div>' +
      '<div class="kpi-v">' + esc(v) + '</div>' +
      (sub ? '<div class="kpi-sub">' + esc(sub) + '</div>' : '') + '</div>';
  }


  /* ---------- 3.9 行动清单 ---------- */
  function renderAction(p) {
    var ap = obj(obj(p).action_plan);
    var vEl = byId('action-verdict');
    if (vEl) {
      var capital = n(ap.capital);
      vEl.innerHTML =
        '<span>' + esc(ap.verdict || '暂无行动建议') + '</span>' +
        '<span class="action-capital">本金 <b>' + (capital == null ? '—' : fmtYuan(capital)) + '</b>' +
          (ap.date ? ' · 执行日 ' + esc(ap.date) : '') + '</span>';
    }

    var orders = arr(ap.orders).filter(function (x) { return x && typeof x === 'object'; });
    var oEl = byId('action-orders');
    if (oEl) {
      if (!orders.length) {
        oEl.innerHTML = '<tbody><tr><td class="empty-state">今日无下单计划</td></tr></tbody>';
      } else {
        oEl.innerHTML =
          '<thead><tr><th>时间窗口</th><th>动作</th><th>标的</th><th class="num">价格区间</th>' +
          '<th class="num">份额</th><th class="num">金额</th><th>说明</th></tr></thead><tbody>' +
          orders.map(function (o) {
            o = obj(o);
            var actionName = String(o.action || '');
            var aCls = /买|加/.test(actionName) ? 'up' : (/卖|减/.test(actionName) ? 'down' : 'muted');
            var zone = arr(o.price_zone).map(function (x) { return fmtPrice(x); });
            return '<tr>' +
              '<td class="mono">' + esc(o.window || '—') + '</td>' +
              '<td class="' + aCls + '"><b>' + esc(actionName || '—') + '</b></td>' +
              '<td>' + esc(o.name || '') + ' <span class="code-cell">' + esc(o.code || '') + '</span></td>' +
              '<td class="num">' + (zone.length ? zone.join(' - ') : '—') + '</td>' +
              '<td class="num">' + fmtInt(o.shares) + '</td>' +
              '<td class="num">' + (n(o.amount) == null ? '—' : fmtYuan(o.amount)) + '</td>' +
              '<td class="muted" style="white-space:normal;min-width:180px">' + esc(o.reason || '') + '</td>' +
            '</tr>';
          }).join('') + '</tbody>';
      }
    }

    var exp = obj(ap.expected);
    var eEl = byId('action-expected');
    if (eEl) {
      var items = [
        { k: '最大亏损', v: exp.max_loss, pct: exp.max_loss_pct, cls: 'down' },
        { k: '目标收益', v: exp.target, pct: exp.target_pct, cls: 'up' }
      ];
      eEl.innerHTML = items.map(function (it) {
        var val = n(it.v);
        var p = n(it.pct);
        var pTxt = p == null ? '' : '<small>（' + (p <= 1.0001 ? (p * 100).toFixed(2) : p.toFixed(2)) + '%）</small>';
        return '<div class="expected-item"><div class="expected-k">' + it.k + '</div>' +
          '<div class="expected-v ' + (val == null ? 'muted' : it.cls) + '">' +
          (val == null ? '—' : fmtYuan(val).replace(' 元', '')) + pTxt + '</div></div>';
      }).join('') +
        '<div class="expected-item"><div class="expected-k">盈亏比</div><div class="expected-v">' +
          (function () {
            var ml = n(exp.max_loss), tg = n(exp.target);
            if (ml == null || tg == null || ml === 0) return '—';
            return (tg / Math.abs(ml)).toFixed(2) + ' : 1';
          })() + '</div></div>' +
        '<div class="expected-item"><div class="expected-k">下单笔数</div><div class="expected-v">' + orders.length + ' 笔</div></div>';
    }

    var rules = arr(ap.rules).filter(Boolean);
    var rEl = byId('action-rules');
    if (rEl) {
      rEl.innerHTML = rules.length
        ? rules.map(function (r) { return '<li class="rule-item">' + esc(r) + '</li>'; }).join('')
        : '<li class="empty-state">风控规则缺失</li>';
    }

    var wl = arr(ap.watchlist).filter(function (x) { return x && typeof x === 'object'; });
    var wEl = byId('action-watchlist');
    if (wEl) {
      wEl.innerHTML = wl.length ? wl.map(function (x) {
        x = obj(x);
        return '<li class="watch-item">' +
          '<span class="watch-name">' + esc(x.name || '—') + '<small>' + esc(x.code || '') + '</small></span>' +
          '<span class="watch-type">' + esc(x.type || '观察') + '</span>' +
          '<span class="watch-why">' + esc(x.why || '') + '</span>' +
        '</li>';
      }).join('') : '<li class="empty-state">观察池为空</li>';
    }

    var metaEl = byId('action-meta');
    if (metaEl) {
      metaEl.textContent = ap.date ? ('计划执行日 ' + ap.date) : '—';
    }
  }

  /* ---------- 3.9 历史时间线 ---------- */
  function getHistoryRecords(p) {
    var h = state.history && arr(state.history.records);
    if (h && h.length) return h;
    var h2 = arr(obj(state.history).records);
    if (h2.length) return h2;
    return arr(obj(p).history);
  }

  function renderHistory(p) {
    var recs = getHistoryRecords(p).filter(function (r) { return r && typeof r === 'object'; });
    var metaEl = byId('history-meta');
    if (!recs.length) {
      chartEmpty('history-chart', '历史记录缺失（site/data/history.json）');
      if (metaEl) metaEl.textContent = '—';
      var stEl = byId('history-stats');
      if (stEl) stEl.innerHTML = emptyState('暂无历史统计');
      return;
    }
    var xs = recs.map(function (r) { return shortDate(r.date); });
    var scores = recs.map(function (r) { return n(r.score); });
    var prices = recs.map(function (r) { return n(r.etf_close); });
    var turns = recs.map(function (r) { return n(r.turnover_yi); });
    var lu = recs.map(function (r) { return n(r.limit_up); });
    var regimes = recs.map(function (r) { return String(r.regime || '—'); });
    if (metaEl) metaEl.textContent = recs.length + ' 个交易日 · ' + (recs[0].date || '') + ' ~ ' + (recs[recs.length - 1].date || '');

    var inst = initChart('history-chart');
    if (!inst) return;
    var detailed = state.historyDetailed;
    var series = [
      {
        name: '政权分数', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: scores,
        smooth: 0.25, symbol: 'circle', symbolSize: 3.5, showSymbol: false,
        lineStyle: { width: 2, color: C.cyan },
        itemStyle: { color: C.cyan },
        areaStyle: {
          color: new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: 'rgba(34,211,238,0.22)' },
            { offset: 1, color: 'rgba(34,211,238,0)' }
          ])
        },
        markLine: {
          silent: true, symbol: 'none',
          lineStyle: { color: 'rgba(245,196,81,0.35)', type: 'dashed' },
          label: { show: false },
          data: [{ yAxis: 50 }]
        }
      },
      {
        name: 'ETF 收盘价', type: 'line', xAxisIndex: 0, yAxisIndex: 1, data: prices,
        smooth: 0.2, symbol: 'circle', symbolSize: 3, showSymbol: false,
        lineStyle: { width: 1.8, color: C.gold },
        itemStyle: { color: C.gold }
      }
    ];
    var xAxes = [axisBase({
      type: 'category', data: xs, gridIndex: 0, boundaryGap: false,
      axisLabel: { color: C.muted, fontSize: 9.5, fontFamily: FONT, interval: 'auto', hideOverlap: true },
      splitLine: { show: false }
    })];
    var yAxes = [
      axisBase({ type: 'value', gridIndex: 0, min: 0, max: 100, interval: 25, axisLabel: { color: C.muted, fontSize: 9.5, fontFamily: FONT } }),
      axisBase({ type: 'value', gridIndex: 0, scale: true, position: 'right', splitLine: { show: false }, axisLabel: { color: C.gold, fontSize: 9.5, fontFamily: FONT, formatter: function (v) { return v.toFixed(3); } } })
    ];
    var grids = [{ left: 8, right: 52, top: 34, bottom: detailed ? '30%' : 26, containLabel: true }];

    if (detailed) {
      grids.push({ left: 8, right: 52, top: '78%', height: '15%', containLabel: true });
      xAxes.push(axisBase({
        type: 'category', data: xs, gridIndex: 1, boundaryGap: true,
        axisLabel: { show: false }, splitLine: { show: false }
      }));
      yAxes.push(axisBase({
        type: 'value', gridIndex: 1, splitNumber: 2, position: 'left',
        axisLabel: { color: C.muted, fontSize: 9, fontFamily: FONT, formatter: function (v) { return v >= 10000 ? (v / 10000).toFixed(1) + '万' : v; } },
        splitLine: { show: false }, axisLine: { show: false }
      }));
      yAxes.push(axisBase({
        type: 'value', gridIndex: 1, splitNumber: 2, position: 'right',
        axisLabel: { color: C.muted, fontSize: 9, fontFamily: FONT },
        splitLine: { show: false }, axisLine: { show: false }
      }));
      series.push({
        name: '两市成交额', type: 'bar', xAxisIndex: 1, yAxisIndex: 2, data: turns, barMaxWidth: 10,
        itemStyle: { color: 'rgba(34,211,238,0.28)', borderRadius: [2, 2, 0, 0] }
      });
      series.push({
        name: '涨停家数', type: 'line', xAxisIndex: 1, yAxisIndex: 3, data: lu,
        symbol: 'none', smooth: 0.3, lineStyle: { width: 1.3, color: C.up, opacity: 0.85 }
      });
    }

    inst.setOption({
      animationDuration: 700,
      grid: grids,
      xAxis: xAxes,
      yAxis: yAxes,
      tooltip: baseTooltip({
        trigger: 'axis',
        axisPointer: { type: 'cross', lineStyle: { color: 'rgba(34,211,238,0.35)' }, crossStyle: { color: 'rgba(34,211,238,0.35)' } },
        formatter: function (ps) {
          if (!ps || !ps.length) return '';
          var i = ps[0].dataIndex;
          var r = recs[i] || {};
          var html = '<div style="font-weight:700;margin-bottom:4px">' + esc(r.date || '') +
            ' <span style="color:#22d3ee;font-size:11px">' + esc(regimes[i] || '') + '</span></div>';
          html += '政权分数：<b>' + (scores[i] == null ? '—' : scores[i].toFixed(1)) + '</b>';
          html += '<br>ETF 收盘：<b>' + fmtPrice(prices[i]) + '</b>';
          if (n(r.etf_chg_pct) != null) html += '（<b class="' + dirClass(r.etf_chg_pct) + '">' + fmtPct(r.etf_chg_pct) + '</b>）';
          if (detailed) {
            html += '<br>两市成交：<b>' + fmtYi(turns[i]) + '</b>';
            html += '<br>涨停家数：<b class="up">' + fmtInt(lu[i]) + '</b>';
            if (n(r.yaogu_count) != null) html += '<br>妖股入选：<b>' + fmtInt(r.yaogu_count) + '</b>';
            if (n(r.national_score) != null) html += '<br>国家队评分：<b>' + n(r.national_score).toFixed(1) + '</b>';
          }
          return html;
        }
      }),
      legend: {
        top: 2, left: 4, itemWidth: 12, itemHeight: 8, itemGap: 12,
        textStyle: { color: C.muted, fontSize: 10.5, fontFamily: FONT }
      },
      series: series
    }, true);

    /* 统计 */
    var stEl = byId('history-stats');
    if (stEl) {
      var validScores = scores.filter(function (v) { return v != null; });
      var validPrices = prices.filter(function (v) { return v != null; });
      var firstS = validScores.length ? validScores[0] : null;
      var lastS = validScores.length ? validScores[validScores.length - 1] : null;
      var maxS = validScores.length ? Math.max.apply(null, validScores) : null;
      var minS = validScores.length ? Math.min.apply(null, validScores) : null;
      var firstP = validPrices.length ? validPrices[0] : null;
      var lastP = validPrices.length ? validPrices[validPrices.length - 1] : null;
      var rangeChg = (firstP && lastP) ? (lastP / firstP - 1) * 100 : null;
      stEl.innerHTML =
        histStat('政权分数变化', (firstS == null || lastS == null) ? '—' : (lastS - firstS >= 0 ? '+' : '') + (lastS - firstS).toFixed(1),
          (lastS != null && firstS != null) ? dirClass(lastS - firstS) : '') +
        histStat('当前分数', lastS == null ? '—' : lastS.toFixed(1)) +
        histStat('区间最高 / 最低', (maxS == null ? '—' : maxS.toFixed(1)) + ' / ' + (minS == null ? '—' : minS.toFixed(1))) +
        histStat('ETF 区间涨幅', fmtPct(rangeChg), dirClass(rangeChg)) +
        histStat('最新收盘', fmtPrice(lastP));
    }
  }

  function histStat(k, v, cls) {
    return '<div class="history-stat">' + esc(k) + '<b class="' + (cls || '') + '">' + v + '</b></div>';
  }

  /* =====================================================================
   * 4. 总渲染
   * ===================================================================== */
  var RENDER_SECTIONS = [
    { name: 'status', fn: 'renderStatus', fallback: 'status-bar' },
    { name: 'outlook', fn: 'renderOutlook', fallback: 'outlook-main' },
    { name: 'global', fn: 'renderGlobal', fallback: 'global-summary' },
    { name: 'industry', fn: 'renderIndustrySpace', fallback: 'industry-conclusion' },
    { name: 'seed', fn: 'renderSeed', fallback: 'seed-tbody' },
    { name: 'shortterm', fn: 'renderShortTerm', fallback: 'short-cantrade' },
    { name: 'portfolio', fn: 'renderPortfolio', fallback: 'portfolio-tbody' },
    { name: 'tech', fn: 'renderTechConviction', fallback: 'tech-one-line' },
    { name: 'market', fn: 'renderMarket', fallback: 'index-grid' },
    { name: 'verdict', fn: 'renderVerdict', fallback: 'verdict-body' },
    { name: 'national', fn: 'renderNational', fallback: 'national-signals' },
    { name: 'focus', fn: 'renderFocus', fallback: 'focus-head' },
    { name: 'action', fn: 'renderAction', fallback: 'action-verdict' },
    { name: 'macro', fn: 'renderMacro', fallback: 'macro-trend-cards' },
    { name: 'yaogu', fn: 'renderYaogu', fallback: 'yaogu-tbody' },
    { name: 'backtest', fn: 'renderBacktest', fallback: 'backtest-hero' },
    { name: 'history', fn: 'renderHistory', fallback: 'history-stats' },
    { name: 'review', fn: 'renderReview', fallback: 'review-kpis' }
  ];

  var RENDERERS = {
    renderStatus: renderStatus, renderVerdict: renderVerdict, renderMarket: renderMarket,
    renderMacro: renderMacro, renderNational: renderNational, renderFocus: renderFocus,
    renderYaogu: renderYaogu, renderBacktest: renderBacktest, renderAction: renderAction,
    renderHistory: renderHistory, renderOutlook: renderOutlook, renderGlobal: renderGlobal,
    renderSeed: renderSeed, renderShortTerm: renderShortTerm, renderPortfolio: renderPortfolio,
    renderReview: renderReview, renderIndustrySpace: renderIndustrySpace,
    renderTechConviction: renderTechConviction
  };

  function renderAll() {
    var p = state.latest || {};
    disposeCharts();
    RENDER_SECTIONS.forEach(function (sec) {
      try {
        RENDERERS[sec.fn](p);
      } catch (err) {
        console.error('[render:' + sec.name + ']', err);
        var el = byId(sec.fallback);
        if (el) {
          el.innerHTML = '<div class="empty-state">该区块渲染异常：' + esc(err && err.message ? err.message : String(err)) + '</div>';
        }
      }
    });
    updateDocumentTitle(p);
    scheduleResizeCharts();
  }

  function updateDocumentTitle(p) {
    try {
      var r = obj(obj(p).regime);
      var meta = obj(obj(p).meta);
      var parts = [];
      if (r.label) parts.push(r.label + (n(r.score) == null ? '' : ' ' + n(r.score).toFixed(1)));
      if (meta.trade_date) parts.push(meta.trade_date);
      document.title = (parts.length ? parts.join(' · ') + ' · ' : '') + '黑鲸股市研究系统';
    } catch (e) { /* ignore */ }
  }

  var resizeRaf = null;
  function scheduleResizeCharts() {
    if (resizeRaf) window.cancelAnimationFrame(resizeRaf);
    resizeRaf = window.requestAnimationFrame(function () {
      resizeRaf = null;
      state.charts.forEach(function (inst) {
        try { inst.resize(); } catch (e) { }
      });
    });
  }

  /* =====================================================================
   * 5. 数据加载（三级 fallback）
   * ===================================================================== */
  function getInlineData() {
    var d = window.__INLINE_DATA__;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = null; } }
    return (d && typeof d === 'object') ? d : null;
  }

  function getInlineHistory() {
    var h = window.__INLINE_HISTORY__;
    if (typeof h === 'string') { try { h = JSON.parse(h); } catch (e) { h = null; } }
    if (Array.isArray(h)) return { records: h };
    return (h && typeof h === 'object') ? h : null;
  }

  /** 离线单文件版若额外内联了回测数据则直接用（site_build.py 目前未注入，缺失时回测区块隐藏） */
  function getInlineBacktest() {
    var bt = window.__INLINE_BACKTEST__;
    if (typeof bt === 'string') { try { bt = JSON.parse(bt); } catch (e) { bt = null; } }
    return (bt && typeof bt === 'object') ? bt : null;
  }

  function isInlineMode() {
    return !!getInlineData() || window.__INLINE_MINUTES__ === true;
  }

  function fetchJSON(url) {
    return fetch(url, { cache: 'no-store' }).then(function (res) {
      if (!res.ok) {
        var e = new Error('HTTP ' + res.status + ' ' + url);
        e.kind = res.status === 404 ? 'notfound' : 'http';
        throw e;
      }
      return res.text().then(function (text) {
        try {
          return JSON.parse(text);
        } catch (err) {
          var e2 = new Error('JSON 解析失败：' + err.message);
          e2.kind = 'parse';
          throw e2;
        }
      });
    });
  }

  function loadFromServer() {
    var bust = '?_=' + Date.now();
    var base = assetBase();
    return fetchJSON(base + 'data/latest.json' + bust).then(function (json) {
      if (!json || typeof json !== 'object' || Array.isArray(json)) {
        var e = new Error('latest.json 顶层结构异常'); e.kind = 'parse'; throw e;
      }
      state.latest = json;
      state.lastLoadAt = Date.now();
      /* history.json / backtest.json 均为可选：失败不影响主数据 */
      return Promise.all([
        fetchJSON(base + 'data/history.json' + '?_=' + Date.now()).then(function (h) {
          if (h && typeof h === 'object') state.history = h;
        }).catch(function () { /* 忽略 history 失败，沿用旧数据 */ }),
        fetchJSON(base + 'data/backtest.json' + '?_=' + Date.now()).then(function (bt) {
          state.backtest = (bt && typeof bt === 'object') ? bt : null;
        }).catch(function () { state.backtest = null; /* 文件不存在 → 回测区块隐藏 */ })
      ]);
    });
  }

  /* =====================================================================
   * 6. 提示条
   * ===================================================================== */
  var bannerDismissed = false;

  function showBanner(html, kind) {
    var el = byId('banner');
    if (!el) return;
    el.className = 'banner' + (kind === 'error' ? ' banner--error' : '');
    el.innerHTML = html;
    el.hidden = false;
  }

  function hideBanner() {
    var el = byId('banner');
    if (el) { el.hidden = true; el.innerHTML = ''; }
  }

  function showFileProtocolBanner(extraHtml) {
    showBanner(
      '当前以 <b>file://</b> 方式直接打开，浏览器会拦截本地 JSON 读取。请任选一种方式：' +
      '① 双击项目根目录的 <code>启动看板.bat</code>（或执行 <code>python serve.py</code>），' +
      '打开 <code>http://127.0.0.1:8099/</code>；' +
      '② 在 <code>site</code> 目录执行 <code>python -m http.server 8099</code> ' +
      '再访问 <code>http://127.0.0.1:8099/</code>；' +
      '③ 直接双击 <code>site/看板-离线版.html</code>（数据已内联，无需服务）。' +
      (extraHtml ? '<br>' + extraHtml : ''),
      'error'
    );
  }

  function showMissingDataBanner(detail) {
    showBanner(
      MISSING_MSG + ' 生成数据后再刷新本页。' +
      (detail ? '<br><span style="opacity:.75;font-size:12px">详情：' + esc(detail) + '</span>' : '') +
      '<br><span style="opacity:.75;font-size:12px">若已启动服务仍失败，请确认站点从 <code>site/</code> 目录根路径访问（data/latest.json 需同目录可见）。</span>',
      'error'
    );
  }

  /* =====================================================================
   * 7. 启动 / 自动刷新
   * ===================================================================== */
  function startAutoRefresh() {
    stopAutoRefresh();
    if (state.inline) return;    /* 离线单文件：数据已内联，不重复 fetch */
    state.timer = window.setInterval(function () {
      if (document.hidden) return;      /* 页面切到后台时暂停 */
      doRefresh();
    }, REFRESH_MS);
  }

  function stopAutoRefresh() {
    if (state.timer) { window.clearInterval(state.timer); state.timer = null; }
  }

  function doRefresh() {
    var refreshEl = byId('st-refresh');
    loadFromServer().then(function () {
      hideBanner();
      renderAll();
      if (refreshEl) refreshEl.classList.remove('is-bad');
    }).catch(function (err) {
      console.warn('[refresh]', err);
      if (refreshEl) {
        refreshEl.textContent = '更新失败';
        refreshEl.classList.add('is-bad');
        refreshEl.title = err && err.message ? err.message : String(err);
      }
      /* 保留旧数据，仅在从未成功加载时告警 */
      if (!state.latest) showMissingDataBanner(err && err.message);
    });
  }

  function renderLoadingSkeleton() {
    /* 首次加载失败时也保持骨架可见，所有区块给出占位 */
    var p = {};
    try { renderStatus(p); } catch (e) { }
  }

  function boot() {
    bindEvents();

    var inline = getInlineData();
    if (inline) {
      state.inline = true;
      state.latest = inline;
      state.history = getInlineHistory();
      state.backtest = getInlineBacktest();
      state.lastLoadAt = Date.now();
      hideBanner();
      renderAll();
      getInlineHistoryNotice();
      return;
    }

    if (location.protocol === 'file:') {
      showFileProtocolBanner();
    }

    renderLoadingSkeleton();

    loadFromServer().then(function () {
      hideBanner();
      renderAll();
      startAutoRefresh();
    }).catch(function (err) {
      console.warn('[boot]', err);
      var detail = err && err.message ? err.message : String(err);
      if (err && err.kind === 'parse') {
        showBanner('数据文件存在但格式无法解析，请检查后端输出。<br><span style="opacity:.75;font-size:12px">' +
          esc(detail) + '</span>', 'error');
      } else if (location.protocol === 'file:') {
        /* file:// 下必然取不到数据：同时给出「怎么正确打开」和「数据文件在哪」两条指引 */
        showFileProtocolBanner('另外：' + MISSING_MSG + ' 生成数据后再刷新本页。');
      } else {
        showMissingDataBanner(detail);
      }
      /* 仍然渲染空骨架，保证不白屏 */
      renderAll();
      startAutoRefresh();
    });
  }

  function getInlineHistoryNotice() {
    var refreshEl = byId('st-refresh');
    if (refreshEl) {
      refreshEl.title = '离线单文件快照（window.__INLINE_DATA__）：数据已内联，不自动刷新';
    }
  }

  function bindEvents() {
    window.addEventListener('resize', scheduleResizeCharts);
    window.addEventListener('orientationchange', scheduleResizeCharts);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      if (state.inline) return;
      /* 回到前台：超过一个刷新周期则立即刷新 */
      if (Date.now() - (state.lastLoadAt || 0) > REFRESH_MS) doRefresh();
    });

    bindYaoguSort();
    bindSeedTable();

    var toggle = byId('history-toggle');
    if (toggle) {
      toggle.addEventListener('click', function () {
        state.historyDetailed = !state.historyDetailed;
        toggle.setAttribute('aria-pressed', state.historyDetailed ? 'true' : 'false');
        toggle.textContent = state.historyDetailed ? '隐藏成交额 / 涨停家数' : '显示成交额 / 涨停家数';
        if (state.latest) renderHistory(state.latest);
      });
    }

    /* 图表容器尺寸变化（字体加载、折叠等）后重绘 */
    if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
      document.fonts.ready.then(scheduleResizeCharts);
    }
    window.addEventListener('load', scheduleResizeCharts);
  }

  /* ---------- 启动 ---------- */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
