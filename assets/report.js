/* Report runtime: renders the usage / purchase / balance charts and stats.
   Runs entirely offline from window.__REPORT_DATA__. */
(function () {
  'use strict';

  var DATA = window.__REPORT_DATA__;
  var css = function (name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  };

  /* ------------------------------------------------------------- date utils */
  function pad2(n) { return String(n).padStart(2, '0'); }
  function parseD(s) { var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function fmtD(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function addDays(s, n) { var d = parseD(s); d.setDate(d.getDate() + n); return fmtD(d); }
  function eachDay(a, b) { var o = [], s = a; while (s <= b) { o.push(s); s = addDays(s, 1); } return o; }
  function daysBetween(a, b) { return Math.round((parseD(b) - parseD(a)) / 86400000) + 1; }
  function weekKey(s) {
    var d = parseD(s), day = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - day + 3);
    var t = new Date(d.getFullYear(), 0, 4), f = (t.getDay() + 6) % 7;
    t.setDate(t.getDate() - f + 3);
    return d.getFullYear() + '-W' + pad2(1 + Math.round((d - t) / (7 * 86400000)));
  }
  var monthKey = function (s) { return s.slice(0, 7); };
  function fmtNum(n, digits) {
    if (!isFinite(n)) return '—';
    return n.toLocaleString('zh-CN', { minimumFractionDigits: digits || 0, maximumFractionDigits: digits == null ? 2 : digits });
  }

  /* --------------------------------------------------------- derived series */
  var ALL_DATES = Object.keys(DATA.used).sort();
  var DATA_FIRST = ALL_DATES[0] || '2020-01-01';
  var DATA_LAST = ALL_DATES[ALL_DATES.length - 1] || DATA_FIRST;

  function policyValue(entries, policy) {
    var v = entries.map(function (e) { return e.kwh; }).filter(isFinite);
    if (!v.length) return 0;
    if (policy === 'sum') return v.reduce(function (a, b) { return a + b; }, 0);
    if (policy === 'min') return Math.min.apply(null, v);
    if (policy === 'first') return v[0];
    if (policy === 'last') return v[v.length - 1];
    return Math.max.apply(null, v);
  }

  /** Daily usage across the whole cache, with the active duplicate policy. */
  function allDaily(policy) {
    return ALL_DATES.map(function (d) {
      var e = DATA.used[d].entries || [];
      return { date: d, kwh: policyValue(e, policy), price: (e.find(function (x) { return isFinite(x.price); }) || {}).price, n: e.length };
    });
  }

  function inRange(list, key, from, to) {
    return list.filter(function (r) { return r[key] >= from && r[key] <= to; });
  }

  function aggregate(daily, agg) {
    if (agg === 'day') return daily.map(function (d) { return { label: d.date, kwh: d.kwh, n: 1 }; });
    var buckets = new Map();
    daily.forEach(function (d) {
      var k = agg === 'month' ? monthKey(d.date) : weekKey(d.date);
      var cur = buckets.get(k) || { label: k, kwh: 0, n: 0, from: d.date, to: d.date };
      cur.kwh += d.kwh; cur.n += 1;
      if (d.date < cur.from) cur.from = d.date;
      if (d.date > cur.to) cur.to = d.date;
      buckets.set(k, cur);
    });
    return Array.from(buckets.values()).sort(function (a, b) { return a.label < b.label ? -1 : 1; });
  }

  /** Reconstruct the balance curve backwards from the last observed reading.
   *  balance(t) = anchor - purchases after t + usage after t.
   *  Suffixes are built over a DENSE calendar: purchases often land on days with
   *  no usage record, and days missing from the usage table must still inherit
   *  the running totals instead of falling back to the anchor. */
  function balanceCurve(policy, from, to) {
    var anchor = DATA.balance;
    if (anchor == null) return null;
    var useByDate = new Map();
    allDaily(policy).forEach(function (d) { useByDate.set(d.date, d.kwh); });
    var buyByDate = new Map();
    DATA.buy.forEach(function (r) {
      if (!r.date || !isFinite(r.kwh)) return;
      buyByDate.set(r.date, (buyByDate.get(r.date) || 0) + r.kwh);
    });
    var buyDates = Array.from(buyByDate.keys()).sort();
    var calStart = DATA_FIRST;
    var calEnd = DATA_LAST;
    if (buyDates.length) {
      if (buyDates[0] < calStart) calStart = buyDates[0];
      if (buyDates[buyDates.length - 1] > calEnd) calEnd = buyDates[buyDates.length - 1];
    }
    var cal = eachDay(calStart, calEnd);
    var suffixBuy = new Map(), suffixUse = new Map();
    var runBuy = 0, runUse = 0;
    for (var i = cal.length - 1; i >= 0; i--) {
      suffixBuy.set(cal[i], runBuy);
      suffixUse.set(cal[i], runUse);
      runUse += useByDate.get(cal[i]) || 0;
      runBuy += buyByDate.get(cal[i]) || 0;
    }
    return eachDay(from, to).map(function (d) {
      return { date: d, kwh: anchor - (suffixBuy.get(d) || 0) + (suffixUse.get(d) || 0) };
    });
  }

  /* ------------------------------------------------------------------ state */
  var state = {
    from: DATA.options.initialFrom,
    to: DATA.options.initialTo,
    agg: 'day',
    policy: DATA.options.defaultPolicy || 'max',
    theme: DATA.options.theme || 'light',
  };

  var charts = {};

  /* ------------------------------------------------------------------ stats */
  function computeStats() {
    var daily = allDaily(state.policy);
    var view = inRange(daily, 'date', state.from, state.to);
    var total = view.reduce(function (a, d) { return a + d.kwh; }, 0);
    var cost = view.reduce(function (a, d) { return a + d.kwh * (isFinite(d.price) ? d.price : 0); }, 0);
    var withData = view.filter(function (d) { return d.kwh > 0 || d.n > 0; }).length;
    var span = daysBetween(state.from, state.to);
    var maxDay = view.reduce(function (a, d) { return !a || d.kwh > a.kwh ? d : a; }, null);
    var ambiguous = view.filter(function (d) { return d.n > 1; }).length;

    var buys = inRange(DATA.buy, 'date', state.from, state.to);
    var buyKwh = buys.reduce(function (a, r) { return a + (isFinite(r.kwh) ? r.kwh : 0); }, 0);
    var buyMoney = buys.reduce(function (a, r) { return a + (isFinite(r.amount) ? r.amount : 0); }, 0);

    var curve = balanceCurve(state.policy, state.from, state.to);
    var startBal = curve && curve.length ? curve[0].kwh : null;
    var endBal = curve && curve.length ? curve[curve.length - 1].kwh : null;

    return {
      total: total, cost: cost, span: span, withData: withData,
      missing: span - withData, avg: span ? total / span : 0,
      maxDay: maxDay, ambiguous: ambiguous, buys: buys, buyKwh: buyKwh, buyMoney: buyMoney,
      startBal: startBal, endBal: endBal, curve: curve,
      effectivePrice: total > 0 && cost > 0 ? cost / total : null,
    };
  }

  function renderStats(s) {
    var cards = [
      { k: '区间用电', v: fmtNum(s.total, 1) + ' 度', s: s.span + ' 天 · 日均 ' + fmtNum(s.avg, 2) + ' 度' },
      { k: '折合电费', v: '¥' + fmtNum(s.cost, 2), s: s.effectivePrice ? '均价 ' + fmtNum(s.effectivePrice, 4) + ' 元/度' : '—' },
      { k: '区间购电', v: fmtNum(s.buyKwh, 1) + ' 度', s: s.buys.length + ' 笔 · ¥' + fmtNum(s.buyMoney, 2) },
      { k: '单日最高', v: s.maxDay ? fmtNum(s.maxDay.kwh, 2) + ' 度' : '—', s: s.maxDay ? s.maxDay.date : '—' },
      { k: '当前余额', v: DATA.balance == null ? '—' : fmtNum(DATA.balance, 2) + ' 度', s: '读取于 ' + (DATA.balanceAt || '').slice(0, 16).replace('T', ' ') },
      { k: '区间起 / 止余额', v: (s.startBal == null ? '—' : fmtNum(s.startBal, 1)) + ' → ' + (s.endBal == null ? '—' : fmtNum(s.endBal, 1)), s: '由当前余额反推' },
      { k: '有数据天数', v: s.withData + ' / ' + s.span, s: s.missing > 0 ? s.missing + ' 天无记录' : '完整', warn: s.missing > s.span * 0.25 },
    ];
    document.getElementById('stats').innerHTML = cards.map(function (c) {
      return '<div class="card' + (c.warn ? ' warn' : '') + '"><div class="k">' + c.k + '</div><div class="v">' + c.v + '</div><div class="s">' + c.s + '</div></div>';
    }).join('');
  }

  /* ----------------------------------------------------------------- charts */
  function baseGrid() { return { left: 56, right: 22, top: 26, bottom: 54 }; }

  function axisCommon() {
    return {
      axisLine: { lineStyle: { color: css('--border') } },
      axisLabel: { color: css('--muted'), fontSize: 11 },
      splitLine: { lineStyle: { color: css('--border'), type: 'dashed' } },
    };
  }

  function tooltipCommon() {
    return {
      trigger: 'axis',
      backgroundColor: css('--panel'),
      borderColor: css('--border'),
      textStyle: { color: css('--text'), fontSize: 12 },
      axisPointer: { type: 'cross', label: { backgroundColor: css('--muted') } },
    };
  }

  function zoomCommon() {
    return [
      { type: 'inside', throttle: 60 },
      { type: 'slider', height: 18, bottom: 12, borderColor: css('--border'), fillerColor: 'rgba(47,111,235,0.15)', textStyle: { color: css('--muted'), fontSize: 10 } },
    ];
  }

  function initChart(id) {
    var el = document.getElementById(id);
    if (charts[id]) charts[id].dispose();
    charts[id] = echarts.init(el, null, { renderer: 'canvas' });
    return charts[id];
  }

  function renderUsed() {
    var daily = inRange(allDaily(state.policy), 'date', state.from, state.to);
    var series = aggregate(daily, state.agg);
    var chart = initChart('chart-used');
    var isDay = state.agg === 'day';
    var labels = series.map(function (d) { return d.label; });
    var values = series.map(function (d) { return +d.kwh.toFixed(3); });

    var markMax = null;
    if (values.length) {
      var maxIdx = values.indexOf(Math.max.apply(null, values));
      markMax = { coord: [labels[maxIdx], values[maxIdx]], value: values[maxIdx].toFixed(2) + ' 度' };
    }

    chart.setOption({
      grid: baseGrid(),
      tooltip: Object.assign(tooltipCommon(), {
        formatter: function (ps) {
          var p = ps[0];
          var d = series[p.dataIndex];
          var extra = d && d.n > 1 && state.agg !== 'day' ? '<br/>含 ' + d.n + ' 天' : '';
          return '<b>' + p.axisValue + '</b><br/>用电 ' + p.data.toFixed(2) + ' 度' + extra;
        },
      }),
      xAxis: Object.assign({ type: 'category', data: labels, boundaryGap: !isDay }, axisCommon()),
      yAxis: Object.assign({ type: 'value', name: '度', nameTextStyle: { color: css('--muted'), fontSize: 11 } }, axisCommon()),
      dataZoom: zoomCommon(),
      series: [
        isDay
          ? {
              type: 'line', data: values, showSymbol: false, sampling: 'lttb',
              lineStyle: { width: 1.6, color: css('--used') },
              itemStyle: { color: css('--used') },
              areaStyle: {
                color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                  { offset: 0, color: 'rgba(47,111,235,0.35)' },
                  { offset: 1, color: 'rgba(47,111,235,0.02)' },
                ]),
              },
              markPoint: markMax ? { symbolSize: 42, data: [{ ...markMax, name: '最高' }], itemStyle: { color: css('--warn') }, label: { fontSize: 10 } } : undefined,
            }
          : {
              type: 'bar', data: values, itemStyle: { color: css('--used'), borderRadius: [3, 3, 0, 0] },
              markPoint: markMax ? { symbolSize: 42, data: [{ ...markMax, name: '最高' }], itemStyle: { color: css('--warn') }, label: { fontSize: 10 } } : undefined,
            },
      ],
    }, true);
  }

  function renderBuy() {
    var buys = inRange(DATA.buy, 'date', state.from, state.to);
    var chart = initChart('chart-buy');
    var labels = buys.map(function (r) { return (r.ts || r.date).replace('T', ' '); });
    var money = buys.map(function (r) { return isFinite(r.amount) ? +r.amount.toFixed(2) : 0; });
    document.getElementById('buy-count').textContent = buys.length ? buys.length + ' 笔' : '区间内无购电记录';

    chart.setOption({
      grid: { left: 56, right: 22, top: 26, bottom: 76 },
      tooltip: Object.assign(tooltipCommon(), {
        formatter: function (ps) {
          var r = buys[ps[0].dataIndex];
          return '<b>' + (r.ts || r.date).replace('T', ' ') + '</b><br/>充值 ' + fmtNum(r.kwh, 2) + ' 度<br/>金额 ¥' + fmtNum(r.amount, 2) + (r.operator ? '<br/>来源 ' + r.operator : '');
        },
      }),
      xAxis: Object.assign({ type: 'category', data: labels, axisLabel: { color: css('--muted'), fontSize: 10, rotate: 45, hideOverlap: true } }, axisCommon()),
      yAxis: Object.assign({ type: 'value', name: '元', nameTextStyle: { color: css('--muted'), fontSize: 11 } }, axisCommon()),
      dataZoom: [{ type: 'inside' }, { type: 'slider', height: 16, bottom: 10, borderColor: css('--border'), fillerColor: 'rgba(18,161,80,0.15)', textStyle: { color: css('--muted'), fontSize: 10 } }],
      series: [{
        type: 'bar', data: money.map(function (v) { return { value: v, itemStyle: { color: v < 0 ? css('--neg') : css('--buy'), borderRadius: v < 0 ? [0, 0, 3, 3] : [3, 3, 0, 0] } }; }),
      }],
    }, true);
  }

  function renderBalance(stats) {
    var chart = initChart('chart-balance');
    if (!stats.curve) {
      chart.setOption({ title: { text: '缺少余额数据', left: 'center', top: 'middle', textStyle: { color: css('--muted'), fontSize: 13 } } });
      return;
    }
    var labels = stats.curve.map(function (d) { return d.date; });
    var values = stats.curve.map(function (d) { return +d.kwh.toFixed(2); });
    chart.setOption({
      grid: baseGrid(),
      tooltip: Object.assign(tooltipCommon(), {
        formatter: function (ps) { return '<b>' + ps[0].axisValue + '</b><br/>推算余额 ' + ps[0].data.toFixed(2) + ' 度'; },
      }),
      xAxis: Object.assign({ type: 'category', data: labels, boundaryGap: false }, axisCommon()),
      yAxis: Object.assign({ type: 'value', name: '度', nameTextStyle: { color: css('--muted'), fontSize: 11 } }, axisCommon()),
      dataZoom: zoomCommon(),
      series: [{
        type: 'line', data: values, showSymbol: false, step: 'end', sampling: 'lttb',
        lineStyle: { width: 1.6, color: css('--warn') },
        areaStyle: { color: 'rgba(217,119,6,0.12)' },
      }],
    }, true);
  }

  /* ------------------------------------------------------------------ table */
  var tablePage = 0;
  function renderTable() {
    var daily = inRange(allDaily(state.policy), 'date', state.from, state.to).slice().reverse();
    var per = 50, pages = Math.max(1, Math.ceil(daily.length / per));
    if (tablePage >= pages) tablePage = pages - 1;
    var slice = daily.slice(tablePage * per, tablePage * per + per);
    var rows = slice.map(function (d) {
      return '<tr' + (d.n > 1 ? ' class="flag"' : '') + '><td>' + d.date + '</td><td class="num">' + fmtNum(d.kwh, 2) +
        '</td><td class="num">' + (isFinite(d.price) ? fmtNum(d.price, 4) : '—') +
        '</td><td class="num">' + (isFinite(d.price) ? fmtNum(d.kwh * d.price, 2) : '—') +
        '</td><td class="num">' + d.n + '</td></tr>';
    }).join('');
    document.getElementById('table-used').innerHTML =
      '<table><thead><tr><th>日期</th><th class="num">用电(度)</th><th class="num">单价(元/度)</th><th class="num">电费(元)</th><th class="num">原始条数</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="5">区间内无记录</td></tr>') + '</tbody></table>';
    document.getElementById('pager').innerHTML =
      '<button id="prev"' + (tablePage === 0 ? ' disabled' : '') + '>上一页</button>' +
      '<span>第 ' + (tablePage + 1) + ' / ' + pages + ' 页 · 共 ' + daily.length + ' 天</span>' +
      '<button id="next"' + (tablePage >= pages - 1 ? ' disabled' : '') + '>下一页</button>';
    var prev = document.getElementById('prev'), next = document.getElementById('next');
    if (prev) prev.onclick = function () { tablePage--; renderTable(); };
    if (next) next.onclick = function () { tablePage++; renderTable(); };
  }

  function renderBuyTable() {
    var buys = inRange(DATA.buy, 'date', state.from, state.to).slice().reverse();
    var rows = buys.slice(0, 300).map(function (r) {
      return '<tr><td>' + (r.ts || r.date).replace('T', ' ') + '</td><td class="num">' + fmtNum(r.kwh, 2) +
        '</td><td class="num">' + fmtNum(r.amount, 2) + '</td><td>' + (r.operator || '—') + '</td></tr>';
    }).join('');
    document.getElementById('table-buy').innerHTML =
      '<table><thead><tr><th>时间</th><th class="num">充值电量(度)</th><th class="num">金额(元)</th><th>充值人</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="4">区间内无记录</td></tr>') + '</tbody></table>' +
      (buys.length > 300 ? '<div class="pager">仅显示最近 300 条，共 ' + buys.length + ' 条</div>' : '');
  }

  /* ------------------------------------------------------------------- misc */
  function renderNotes(s) {
    var el = document.getElementById('notes');
    var notes = [];
    if (s.ambiguous > 0) {
      notes.push('<b>' + s.ambiguous + ' 天</b>存在两条同日记录（表中已标黄）。当前取值为「' +
        ({ max: '较大值', sum: '相加', min: '较小值', first: '第一条', last: '最后一条' }[state.policy] || state.policy) +
        '」，可在右上角切换。');
    }
    if (s.missing > 0) notes.push('<b>' + s.missing + ' 天</b>在区间内没有用电记录（放假、无人或未抄表）。');
    if (DATA.options.requestedFrom && DATA.options.requestedFrom < DATA_FIRST) {
      notes.push('站上最早的数据是 <b>' + DATA_FIRST + '</b>，更早的日期查不到记录。');
    }
    notes.push('余额曲线由「当前余额 − 之后购电 + 之后用电」反推得到，仅供参考。');
    el.innerHTML = notes.map(function (n) { return '<div class="note">' + n + '</div>'; }).join('');
  }

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', state.theme);
    document.getElementById('theme').textContent = state.theme === 'dark' ? '浅色' : '深色';
  }

  function renderAll() {
    var s = computeStats();
    renderStats(s);
    renderNotes(s);
    renderUsed();
    renderBuy();
    renderBalance(s);
    renderTable();
    renderBuyTable();
  }

  /* ------------------------------------------------------------------ wiring */
  function setRange(from, to) {
    state.from = from < DATA_FIRST ? DATA_FIRST : from;
    state.to = to > DATA_LAST ? DATA_LAST : to;
    document.getElementById('from').value = state.from;
    document.getElementById('to').value = state.to;
    document.querySelectorAll('#presets button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.from === state.from && b.dataset.to === state.to);
    });
    renderAll();
  }

  function buildPresets() {
    var today = DATA_LAST;
    var defs = [
      ['近一周', 7], ['近一月', 31], ['近三月', 92], ['近一年', 366], ['近四年', 1461], ['全部', 0],
    ];
    var html = defs.map(function (d) {
      var from = d[1] === 0 ? DATA_FIRST : addDays(today, -(d[1] - 1));
      if (from < DATA_FIRST) from = DATA_FIRST;
      return '<button data-from="' + from + '" data-to="' + today + '">' + d[0] + '</button>';
    }).join('');
    document.getElementById('presets').innerHTML = html;
    document.querySelectorAll('#presets button').forEach(function (b) {
      b.onclick = function () { setRange(b.dataset.from, b.dataset.to); };
    });
  }

  function boot() {
    buildPresets();
    applyTheme();
    document.getElementById('agg').onchange = function (e) { state.agg = e.target.value; renderAll(); };
    document.getElementById('policy').onchange = function (e) { state.policy = e.target.value; renderAll(); };
    document.getElementById('policy').value = state.policy;
    document.getElementById('theme').onclick = function () { state.theme = state.theme === 'dark' ? 'light' : 'dark'; applyTheme(); renderAll(); };
    document.getElementById('from').onchange = function () { setRange(this.value, state.to); };
    document.getElementById('to').onchange = function () { setRange(state.from, this.value); };
    document.getElementById('from').min = DATA_FIRST;
    document.getElementById('from').max = DATA_LAST;
    document.getElementById('to').min = DATA_FIRST;
    document.getElementById('to').max = DATA_LAST;
    window.addEventListener('resize', function () {
      Object.keys(charts).forEach(function (k) { charts[k].resize(); });
    });
    setRange(state.from, state.to);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
