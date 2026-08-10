"""券商真实盘对接（集成契约）。

现状与边界
----------
- 当前 WorkBuddy 的券商类连接器（通达信 / 腾讯自选股等）默认处于「断开」状态，
  且公开连接器主要提供行情与自选数据，并不暴露下单（委托）通道。
- 因此本工作台**不会**替你自动下单。它负责把技术面信号算成一份
  结构化的「委托单意图」(OrderTicket)，由你在券商 App /  connector 授权后执行。

如果你希望进一步自动化，需要：
  1. 在 WorkBuddy「连接器中心」连接并授权你的券商 / 通达信账户；
  2. 确认该连接器暴露了持仓查询与委托接口；
  3. 由智能体（agent）侧调用连接器把持仓写回 data/positions.json（已实现 CRUD），
     并把 OrderTicket 通过连接器提交——这属于需要你明确授权的外部动作。

本模块提供：
  - format_order_ticket(analysis, position)：把信号 + 仓位建议落成一目了然的委托单。
  - POSITION_SHAPE / ORDER_SHAPE：数据形态约定，供同步脚本对接。
"""


POSITION_SHAPE = {
    "code": "str 如 sh600519",
    "name": "str",
    "shares": "int 当前持仓股数",
    "cost": "float 持仓成本（可选）",
}

ORDER_SHAPE = {
    "code": "str",
    "name": "str",
    "side": "BUY / SELL",
    "order_type": "LIMIT / MARKET",
    "price": "float 限价（建议用实时价附近）",
    "quantity": "int 股数（A股为 100 的整数倍）",
    "reason": "str 技术面理由",
}


def format_order_ticket(analysis, position):
    """把 analyze() 的结果与 position_advice() 的结果，整理成委托单意图。

    analysis : sig.analyze() 的返回（含 action/score/price/reasons）
    position : sig.position_advice() 的返回（含 delta_shares/suggestion/note）
    返回 dict（ORDER_SHAPE 的超集），human=True 时附带可读文案。
    """
    action = analysis.get("action", "持有")
    pos = position or {}
    delta = pos.get("delta_shares", 0)
    if delta > 0:
        side = "BUY"
    elif delta < 0:
        side = "SELL"
    else:
        side = "NONE"

    reasons = analysis.get("reasons", [])
    reason_str = "；".join(
        (r["text"] if isinstance(r, dict) else str(r)) for r in reasons[:3]
    )
    ticket = {
        "code": analysis.get("code", ""),
        "name": analysis.get("name", ""),
        "action": action,
        "score": analysis.get("score"),
        "price": analysis.get("price"),
        "side": side,
        "order_type": "LIMIT",
        "quantity": abs(delta),
        "lot_ok": abs(delta) % 100 == 0,
        "reason": reason_str,
        "suggestion": pos.get("suggestion", ""),
        "note": pos.get("note", ""),
    }
    return ticket


def humanize(ticket):
    if ticket.get("side") == "NONE":
        return f"【{ticket.get('name') or ticket.get('code')}】信号：{ticket.get('action')}，无需操作。"
    side_cn = "买入" if ticket["side"] == "BUY" else "卖出"
    lot_warn = "" if ticket.get("lot_ok") else "（注意：股数非 100 整数倍，A股需调整）"
    return (f"委托单 · {side_cn} {ticket.get('quantity')} 股 {ticket.get('name') or ticket.get('code')}"
            f"｜限价≈¥{ticket.get('price')}｜评分 {ticket.get('score')}（{ticket.get('action')}）"
            f"\n理由：{ticket.get('reason')}"
            f"\n建议：{ticket.get('suggestion')}"
            f"{('｜' + ticket['note']) if ticket.get('note') else ''}{lot_warn}")
