"""core/backtest.py  ——  两套短线策略的历史回测引擎（r32）

纯标准库实现，不依赖 numpy/pandas/vectorbt，便于离线运行与小白部署。

模式一 · 隔夜抢仓回测（backtest_overnight）
    拉 2-3 年日线历史，事件驱动模拟：
      - 第 i 日收盘产生「买入/分批建仓」信号（仅用第 i 日及之前数据，无未来函数）
      - 实际成交用第 i+1 日开盘价（隔夜委托次日开盘，符合策略本意）
      - 出场：盘中触及止损(-2.5%) / 三档止盈(+3/+5/+8%) / 持股满 3 日到期，首次触发即离场
    统计：交易笔数、胜率、盈亏比、总收益、最大回撤、夏普、平均持仓天数、样本区间。

模式二 · 日内做 T 回测（backtest_intraday）
    拉近期多日 5 分钟历史（含真实交易时点），逐日独立模拟 T+0：
      - 复用 intraday_t_signal（注入 sim_time 真实时分，14:50 强制平仓）
      - 当日≤2 次，先买后卖为一次完整 T，结算价差收益
    统计：T 次数、胜率、单笔均值/波动、日平均收益、最大单日亏损、达标(0.5-1.5%)占比。

所有回测均为「信号日不含未来数据」的事件驱动，结果是策略在历史样本上的真实表现，
仅作方法学演示，不构成投资建议。
"""

import datetime
import math
import statistics

from core import data_source as ds
from core.strategies import overnight_score, intraday_t_signal


# ---------------- 工具 ----------------
def _parse_hm(date_str):
    """从 'YYYY-MM-DD HH:MM[:SS]' 解析分钟数（用于日内回测注入交易时点）。

    兼容新浪 3 段格式 '2026-08-06 10:45:00' 与东财 2 段格式 '2026-08-14 13:10'。
    """
    try:
        t = str(date_str).split(" ")[1]
        parts = t.split(":")
        h, m = int(parts[0]), int(parts[1])
        return h * 60 + m
    except Exception:
        return None


def _equity_stats(trades):
    """根据每笔交易(dict含 pnl_pct/hold_days)列表，构造权益曲线，算总收益/最大回撤/夏普。"""
    equity = [1.0]
    for t in trades:
        p = t["pnl_pct"]
        equity.append(equity[-1] * (1.0 + p / 100.0))
    total_ret = (equity[-1] - 1.0) * 100.0

    # 最大回撤
    peak = equity[0]
    max_dd = 0.0
    for eq in equity:
        if eq > peak:
            peak = eq
        dd = (peak - eq) / peak if peak > 0 else 0.0
        if dd > max_dd:
            max_dd = dd
    max_dd *= 100.0

    # 夏普（简化年化）：把每笔收益按持仓天数摊薄到每日，构成日收益序列
    daily_rets = []
    for t in trades:
        hd = max(1, t.get("hold_days", 1))
        per = (t["pnl_pct"] / 100.0) / hd
        daily_rets.extend([per] * hd)
    sharpe = 0.0
    if len(daily_rets) > 1:
        mean = statistics.mean(daily_rets)
        sd = statistics.pstdev(daily_rets)
        if sd > 1e-9:
            sharpe = (mean / sd) * math.sqrt(242.0)
    return equity, total_ret, max_dd, sharpe


# ---------------- 模式一 · 隔夜抢仓回测 ----------------
def backtest_overnight(code, limit=600, name=""):
    """隔夜抢仓历史回测（事件驱动，无未来函数）。"""
    bars = ds.get_kline(code, "daily", limit)
    if not bars or len(bars) < 120:
        return {"ok": False, "mode": "overnight",
                "msg": f"日线历史不足（{len(bars) if bars else 0}根，需≥120）"}

    trades = []
    holding = None  # 持仓状态
    n = len(bars)
    # 信号日从 index=60 起（前 60 根用于计算指标）
    for i in range(60, n):
        b = bars[i]
        price = b["close"]
        prev = bars[i - 1]["close"]
        sig = overnight_score(code, bars[:i + 1], price=price, prev_close=prev, name=name)
        if not sig.get("ok"):
            continue

        if holding is None:
            # 生成买入信号：次日开盘价实际成交（避免未来函数）
            if sig.get("action") in ("买入", "分批建仓") and i + 1 < n:
                buy = bars[i + 1]["open"]
                holding = {
                    "entry": buy,
                    "stop": round(buy * 0.975, 4),
                    "tp": [buy * 1.03, buy * 1.05, buy * 1.08],
                    "buy_idx": i + 1,
                    "score": sig.get("score"),
                    "signal_idx": i,
                }
        else:
            # A 股 T+1：隔夜买入次日（buy_idx 当日）尚不能卖，跳过买入当天再检查出场
            if i <= holding["buy_idx"]:
                continue
            hd = i - holding["buy_idx"]
            low = b["low"]
            high = b["high"]
            close = b["close"]
            exit_now = None
            reason = None
            # 止损（盘中触及）
            if low <= holding["stop"]:
                exit_now = holding["stop"]
                reason = "止损 -2.5%"
            else:
                # 分档止盈（盘中触及，先触及先走）
                for k, thr in enumerate((3, 5, 8)):
                    if high >= holding["tp"][k]:
                        exit_now = holding["tp"][k]
                        reason = f"止盈 +{thr}%"
                        break
                # 持股满 3 日到期平仓
                if exit_now is None and hd >= 3:
                    exit_now = close
                    reason = "持有 3 日到期平仓"
            if exit_now is not None:
                pnl = (exit_now - holding["entry"]) / holding["entry"] * 100.0
                trades.append({
                    "buy_date": bars[holding["buy_idx"]]["date"][:10],
                    "sell_date": b["date"][:10],
                    "entry": round(holding["entry"], 2),
                    "exit": round(exit_now, 2),
                    "pnl_pct": round(pnl, 2),
                    "hold_days": hd,
                    "reason": reason,
                    "score": holding["score"],
                })
                holding = None

    if not trades:
        return {"ok": True, "mode": "overnight", "code": code, "name": name,
                "msg": "样本期内未触发任何买入信号（策略偏保守，属正常）",
                "sample": {"from": bars[0]["date"][:10], "to": bars[-1]["date"][:10],
                           "bars": n},
                "stats": _empty_stats()}

    pcts = [t["pnl_pct"] for t in trades]
    wins = [p for p in pcts if p > 0]
    losses = [p for p in pcts if p <= 0]
    win_rate = len(wins) / len(pcts) * 100.0
    avg_win = statistics.mean(wins) if wins else 0.0
    avg_loss = abs(statistics.mean(losses)) if losses else 0.0
    pl_ratio = (avg_win / avg_loss) if avg_loss > 1e-9 else (float("inf") if avg_win > 0 else 0.0)

    equity, total_ret, max_dd, sharpe = _equity_stats(trades)
    avg_hold = statistics.mean([t["hold_days"] for t in trades])

    return {
        "ok": True, "mode": "overnight", "code": code, "name": name,
        "sample": {"from": bars[0]["date"][:10], "to": bars[-1]["date"][:10], "bars": n},
        "stats": {
            "trades": len(trades),
            "win_rate": round(win_rate, 1),
            "avg_win": round(avg_win, 2),
            "avg_loss": round(-avg_loss, 2),
            "profit_factor": (round(pl_ratio, 2) if pl_ratio != float("inf") else 99.0),
            "total_return": round(total_ret, 1),
            "max_drawdown": round(max_dd, 1),
            "sharpe": round(sharpe, 2),
            "avg_hold_days": round(avg_hold, 1),
            "equity_curve": [round(e, 4) for e in equity],
        },
        "recent": trades[-12:][::-1],
    }


# ---------------- 模式二 · 日内做 T 回测 ----------------
def backtest_intraday(code, max_5m=1200, name=""):
    """日内做 T 历史回测（5 分钟数据，逐日 T+0，限价单撮合）。

    数据源：新浪 5m（稳定返回最近约 26 个交易日，按自然日分组）。
    每根 5m 调用 intraday_t_signal 取「做T买」意图价（t_buy 略低于现价、t_sell 略高于现价），
    sim_time 注入真实时分（14:50 强制平仓窗口）。撮合规则贴合真实打法：
      - 买信号出现 → 挂限价单 t_buy，后续根最低价触达才成交（不假设即时以收盘价成交）
      - 持仓后 → 先触及先走：止盈 +1%（t_sell）/ 止损 -1%（t_buy*0.99）/ 14:50 强平（按收盘价）
    先买后卖为一次完整 T，单日≤2 次；统计做 T 胜率 / 单笔均值 / 日均 / 最大单日亏损 / 达标占比。
    """
    bars = ds.get_kline(code, "5m", max_5m)
    if not bars or len(bars) < 60:
        return {"ok": False, "mode": "intraday",
                "msg": f"5分钟历史不足（{len(bars) if bars else 0}根，需≥60）"}

    # 按自然日分组
    days = {}
    order = []
    for b in bars:
        d = b["date"][:10]
        if d not in days:
            days[d] = []
            order.append(d)
        days[d].append(b)

    FORCE_HM = 14 * 60 + 50  # 14:50 强制平仓窗口
    total_t = 0
    wins = 0
    pnl_list = []
    per_day = []
    hit_target = 0
    day_samples = []

    for d in order:
        daybars = days[d]
        if len(daybars) < 20:
            continue
        cost = daybars[0]["close"]  # 底仓成本以开盘价为基准
        holding = False          # 是否已买入（限价成交）
        pending_buy = None       # 待成交买入：{"tb","ts"}
        buy_idx = -1
        tb = ts = None
        times = 0
        day_pnl = 0.0
        day_trades = []

        for j in range(len(daybars)):
            b = daybars[j]
            hm = _parse_hm(b["date"])
            if hm is None:
                continue
            lo, hi, cl = b["low"], b["high"], b["close"]
            just_bought = False

            # (1) 待成交买入：本根及后续根最低价触达限价即成交
            if pending_buy is not None and not holding:
                if lo <= pending_buy["tb"]:
                    holding = True
                    tb, ts = pending_buy["tb"], pending_buy["ts"]
                    buy_idx = j
                    pending_buy = None
                    just_bought = True  # 买入当根不立即卖出
                elif hm >= FORCE_HM:
                    pending_buy = None  # 逼近收盘仍未成交，撤单

            # (2) 持仓卖出判定（不在买入同一根）
            if holding and not just_bought:
                hit_tp = hi >= ts
                hit_sl = lo <= tb * 0.99
                force_x = hm >= FORCE_HM
                if hit_tp or hit_sl or force_x:
                    if force_x and not (hit_tp or hit_sl):
                        px, reason = cl, "14:50强平"
                    elif hit_tp:
                        px, reason = ts, "止盈+1%"
                    else:
                        px, reason = round(tb * 0.99, 2), "止损-1%"
                    pnl = (px - tb) / tb * 100.0
                    day_pnl += pnl
                    times += 1
                    total_t += 1
                    if pnl > 0:
                        wins += 1
                    if 0.5 <= pnl <= 1.5:
                        hit_target += 1
                    pnl_list.append(pnl)
                    day_trades.append({"t": b["date"][11:16], "pnl": round(pnl, 2),
                                       "action": reason})
                    holding = False
                    continue

            # (3) 开新仓信号（未持仓且无挂单时，单日≤2 次）
            if times < 2 and not holding and pending_buy is None:
                sub = daybars[:j + 1]
                price = sub[-1]["close"]
                sig = intraday_t_signal(code, bars_1m=sub, bars_5m=sub,
                                        cost=cost, price=price, name=name, sim_time=hm)
                if not sig.get("ok"):
                    continue
                if sig.get("action") == "做T买":
                    tb0, ts0 = sig.get("t_buy"), sig.get("t_sell")
                    if tb0 and ts0:
                        pending_buy = {"tb": tb0, "ts": ts0}

        # 收盘仍有未成交挂单则作废
        per_day.append(day_pnl)
        if day_trades:
            day_samples.append({"date": d, "pnl": round(day_pnl, 2), "times": len(day_trades),
                                "trades": day_trades})

    if total_t == 0:
        return {"ok": True, "mode": "intraday", "code": code, "name": name,
                "msg": "样本期内未触发有效 T+0 买卖（行情不配合或窗口限制，属正常）",
                "sample": {"from": order[0], "to": order[-1], "days": len(order)},
                "stats": _empty_stats()}

    win_rate = wins / total_t * 100.0
    avg_pnl = statistics.mean(pnl_list)
    std_pnl = statistics.pstdev(pnl_list) if len(pnl_list) > 1 else 0.0
    avg_day = statistics.mean(per_day)
    max_day_loss = min(per_day)
    target_rate = hit_target / total_t * 100.0

    return {
        "ok": True, "mode": "intraday", "code": code, "name": name,
        "sample": {"from": order[0], "to": order[-1], "days": len(order),
                   "granularity": "5分钟"},
        "stats": {
            "trades": total_t,
            "win_rate": round(win_rate, 1),
            "avg_pnl": round(avg_pnl, 3),
            "std_pnl": round(std_pnl, 3),
            "avg_day_pnl": round(avg_day, 3),
            "max_day_loss": round(max_day_loss, 3),
            "target_rate": round(target_rate, 1),
            "capital_per_t": "<=底仓30%",
            "exit_rules": "止盈+1% / 止损-1% / 14:50强平",
        },
        "recent_days": day_samples[-12:][::-1],
    }


def _empty_stats():
    return {
        "trades": 0, "win_rate": 0, "avg_win": 0, "avg_loss": 0,
        "profit_factor": 0, "total_return": 0, "max_drawdown": 0,
        "sharpe": 0, "avg_hold_days": 0, "equity_curve": [1.0],
    }


# ---------------- 便捷：单标的双策略回测 ----------------
def backtest_all(code, name=""):
    return {
        "overnight": backtest_overnight(code, name=name),
        "intraday": backtest_intraday(code, name=name),
        "generated_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
    }
